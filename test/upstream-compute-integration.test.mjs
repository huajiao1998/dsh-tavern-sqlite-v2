// 本轮上游接入的定向断言；读取指定作者源码，只写隔离夹具。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildCore } from '../deploy/standard-seam-transforms.mjs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { applyUpstreamExecutor, applyUpstreamWorker, applyUpstreamClient, applyUpstreamGenerationTasks } from '../deploy/upstream-compute-transform.mjs'
import { applyOpeningRuntimeTransform } from '../deploy/opening-runtime-transform.mjs'
import { maintenanceTargets, maintenanceReadSources } from '../deploy/standard-seams.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { authorizeUpstreamCall, runUpstreamRequest, upstreamRequest, pageView } from '../lib/upstream-compute.js'
const author = process.env.DSH_TAVERN_COMPUTE_AUTHOR || 'D:/Program Files (x86)/DSH-Tavern/data/harness/apps/dsh-tavern'
const domain = path.join(author,'tavern-plugin/lib/domain')
const authorText = name => fs.readFileSync(path.join(domain,name),'utf8')
const policyUrl = new URL('../lib/upstream-compute.js',import.meta.url).href
async function isolatedOpening(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tavern-upstream-private-'))
  t.after(()=>{assert.ok(path.basename(root).startsWith('tavern-upstream-private-'));fs.rmSync(root,{recursive:true,force:true})})
  const tasks=path.join(root,'helper-generation-tasks.mjs')
  fs.writeFileSync(tasks,applyUpstreamGenerationTasks(authorText('helper-generation-tasks.js')),'utf8')
  const source=applyOpeningRuntimeTransform(authorText('opening-preparation.js')).replace("'./helper-generation-tasks.js'","'"+pathToFileURL(tasks).href+"'").replaceAll(/from '(\.\/[^']+)'/g,(_,specifier)=>"from '"+(specifier==='./storage-upstream-compute.js'?policyUrl:pathToFileURL(path.join(domain,specifier)).href)+"'")
  const file=path.join(root,'opening.mjs');fs.writeFileSync(file,source,'utf8')
  return { root, module:await import(pathToFileURL(file).href) }
}

test('上游计算接入：当前真实作者标准writer命中且计算旧桥不再生成', () => {
  const sources = new Map([...maintenanceTargets,...maintenanceReadSources].filter(rel => fs.existsSync(path.join(author,rel))).map(rel => [rel,fs.readFileSync(path.join(author,rel),'utf8')]))
  const writes = buildCore(author,sources)
  for (const [rel,source] of writes) parse(source,{ecmaVersion:'latest',sourceType: rel.includes('/src/client/') || rel.endsWith('/client.js') ? 'script' : 'module'})
  const host = writes.get('tavern-plugin/lib/index.js')
  assert.ok(host.includes('authorizeUpstreamCall(method, args,'))
  assert.ok(host.includes("owner: 'official'"))
  assert.ok(!host.includes('createServerExecution'))
  assert.ok(!host.includes('storageBrowserScripts'))
  for (const name of ['storage-server-execution.js','storage-helper-readonly.js','storage-opening-runtime.js']) assert.ok(!writes.has('tavern-plugin/lib/domain/'+name),name)
  assert.ok(writes.get('tavern-plugin/lib/domain/server-script-worker.js').includes("if (sessionId.startsWith('opening:'))"))
  assert.ok(writes.get('tavern-plugin/lib/domain/opening-preparation.js').includes('await compute().opening(draft.id)'))
  assert.ok(writes.get('tavern-plugin/lib/domain/tavern-script-host-adapter.js').includes("options.scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED'"))
  assert.ok(!writes.get('tavern-plugin/lib/domain/tavern-script-host-adapter.js').includes('serverExecution'))
  assert.ok(host.includes('serverScripts?.stop(chat.sessionId)'))
  assert.ok(host.includes('await serverScripts?.whenIdle(chat.sessionId)'))
  assert.ok(!host.includes("ctx.get('serverScripts')"))
  assert.ok(!host.includes('pagesInFront'))
  assert.ok(!host.includes('pageInFront'))
  assert.ok(host.includes('priority: () => 0'))
  assert.ok(host.includes('compute: () => serverScripts'))
  assert.ok(!host.includes('DSH_TAVERN_SERVER_SCRIPTS'))
  assert.ok(writes.get('tavern-plugin/lib/domain/storage-upstream-compute.js').includes('upstreamRequest'))
  assert.ok(writes.get('tavern-plugin/lib/client.js').includes('hostWindow.__dshUpstreamServerCompute !== true'))
  assert.ok(writes.get('tavern-plugin/src/client/runtime/helper-script-runtime.js').includes('hostWindow.__dshUpstreamServerCompute !== true'))
})

test('上游计算身份：伪server前缀不能claim或写；当前父进程记录可调用且失效后拒绝', async () => {
  const id = 'compute-test-session'
  let demand = ''
  assert.deepEqual(authorizeUpstreamCall('claimTavernScriptWork',{sessionId:id,runtimeId:'server-forged',ready:true},value=>{demand=value}),{active:false,ready:false,event:null,serverOwned:true})
  assert.equal(demand,id)
  assert.throws(()=>authorizeUpstreamCall('updateTavernHelperVariables',{sessionId:id},()=>{}),/只允许/)
  let current = true
  const record={sessionId:id,isCurrent:()=>current}
  await runUpstreamRequest(record,async()=>{
    assert.equal(upstreamRequest(id),record)
    assert.equal(authorizeUpstreamCall('updateTavernHelperVariables',{sessionId:id},()=>{}),null)
    assert.equal(upstreamRequest('other'),null)
    current=false
    assert.throws(()=>authorizeUpstreamCall('completeTavernHelperEvent',{sessionId:id},()=>{}),/只允许/)
  })
  assert.equal(upstreamRequest(id),null)
  const view=pageView({view:{tavernHelperScripts:[{id:'card'}],tavernMvuRuntime:{owner:'official'}}},id).view
  assert.deepEqual(view.tavernHelperScripts,[])
  assert.equal(view.tavernMvuRuntime,null)
})

test('私有开局接入：作者真实草稿API受worker身份限制且失败不发布', async t => {
  const {module}=await isolatedOpening(t)
  let preparation, received, failed=false, stopped=''
  const compute={
    async opening(id) {
      const record={sessionId:'opening:'+id,isCurrent:()=>true}
      await runUpstreamRequest(record,async()=>{
        received=await preparation.workerRequest(id,'getSession',{})
        assert.equal(received.view.chatId,id)
        assert.equal(received.view.tavernHelper.messages.length,1)
        assert.equal(received.view.tavernRuntimePolicy.trustedCardMode,false)
        await preparation.workerRequest(id,'updateTavernHelperVariables',{option:{type:'message',message_id:0},variables:{stat_data:{gold:17}}})
        if(failed)throw Error('夹具上游失败')
      })
    },
    stop(id){stopped=id}, whenIdle:async()=>{}
  }
  preparation=module.createOpeningPreparation({compute:()=>compute,readCard:async()=>({name:'夹具卡',first_mes:'私有开场',alternate_greetings:['第二开场']}),worldBooks:{bound:async()=>null},readRuntimeExtensions:async()=>({helperScripts:[{id:'fixture',type:'script',content:'void 0'}]})})
  t.after(()=>preparation.dispose())
  const result=await preparation.create('fixture-card')
  assert.deepEqual(result.runtime.scripts,[])
  assert.equal(result.runtime.serverOwned,true)
  assert.equal((await preparation.resolve(result.id,'fixture-card')).messageVariables.stat_data.gold,17)
  await assert.rejects(()=>preparation.workerRequest(result.id,'updateTavernHelperVariables',{variables:{}}),/只允许/)
  await assert.rejects(()=>preparation.callRuntime(result.id,'updateTavernHelperVariables',{}),/只允许/)
  failed=true
  await assert.rejects(()=>preparation.create('fixture-card'),/夹具上游失败/)
  assert.ok(stopped.startsWith('opening:'))
  assert.throws(()=>preparation.get(stopped.slice(8)),/过期/)
})

test('上游真实worker：私有开局运行上游bundle并通过父进程写草稿，释放进程后身份失效', async t => {
  const {root,module}=await isolatedOpening(t)
  const plugin=path.join(root,'tavern-plugin'),runtimeDomain=path.join(plugin,'lib/domain')
  fs.mkdirSync(runtimeDomain,{recursive:true})
  fs.writeFileSync(path.join(plugin,'package.json'),'{"type":"module"}\n','utf8')
  const require=createRequire(path.join(author,'tavern-plugin/package.json'))
  const jsdomPackage=require.resolve('jsdom/package.json')
  const jsdomEntry=pathToFileURL(require.resolve('jsdom')).href
  const jquerySource=fs.readFileSync(path.join(author,'tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js'),'utf8')
  const jqueryUiSource=fs.readFileSync(path.join(author,'tavern-plugin/lib/vendor/runtime-assets/jquery-ui/jquery-ui.min.js'),'utf8')
  fs.writeFileSync(path.join(plugin,'lib/client.js'),applyUpstreamClient(fs.readFileSync(path.join(author,'tavern-plugin/lib/client.js'),'utf8')),'utf8')
  fs.writeFileSync(path.join(runtimeDomain,'server-script-worker.js'),applyUpstreamWorker(authorText('server-script-worker.js')).replace("from 'jsdom'","from '"+jsdomEntry+"'"),'utf8')
  const executorSource=applyUpstreamExecutor(authorText('server-script-executor.js')).replace("from './storage-upstream-compute.js'","from '"+policyUrl+"'").replace("require.resolve('jsdom/package.json')",JSON.stringify(jsdomPackage))
  // 控制回收调度与时钟，在真实worker首个IPC时确定性模拟初始化超过lingerMs。
  // 不延长超时或依赖机器负载；保留真实上游bundle、父进程API和子进程执行。
  const scheduler="let reaperCallback; const setInterval = callback => { reaperCallback=callback; return {unref(){}} }; const clearInterval = () => {}; export const reapNow = () => reaperCallback();\n"
  fs.writeFileSync(path.join(runtimeDomain,'server-script-executor.js'),scheduler+executorSource,'utf8')
  const {createServerScriptExecutor,reapNow}=await import(pathToFileURL(path.join(runtimeDomain,'server-script-executor.js')).href)
  const logs=[]
  let preparation, clock=0, reapedDuringOpening=false
  const requests=[]
  const executor=createServerScriptExecutor({
    lingerMs: 1000, now:()=>clock,
    logger:{log(){},warn(...args){logs.push(args.join(' '))},error(...args){logs.push(args.join(' '))}},
    subscribeSignals:()=>()=>{},
    handle:async(req,res)=>{
      const pathname=new URL(req.url,'http://fixture').pathname
      const prefix='/api/dsh-tavern/vendor/'
      if(!pathname.startsWith(prefix))throw Error('夹具不允许其它资源：'+pathname)
      const rel=pathname.slice(prefix.length)
      if(rel==='runtime-assets/jquery/jquery.min.js') { res.writeHead(200,{'content-type':'application/javascript'});res.end(jquerySource);return }
      if(rel==='runtime-assets/jquery-ui/jquery-ui.min.js') { res.writeHead(200,{'content-type':'application/javascript'});res.end(jqueryUiSource);return }
      if(rel.includes('..'))throw Error('资源路径非法')
      res.writeHead(200,{'content-type':rel.endsWith('.mjs')?'text/javascript':'application/javascript'})
      res.end(fs.readFileSync(path.join(domain,'../vendor',rel)))
    },
    openingRequest:async(id,method,args)=>{
      if(!reapedDuringOpening) {
        reapedDuringOpening=true;clock+=2000
        await reapNow()
        assert.equal(executor.has('opening:'+id),true,'初始化尚未完成时不得被空闲回收')
      }
      requests.push({method,args}); return preparation.workerRequest(id,method,args)
    }
  })
  t.after(()=>executor.dispose())
  preparation=module.createOpeningPreparation({compute:()=>executor,readRuntimePolicy:async()=>({trustedCardMode:true}),readCard:async()=>({name:'调用夹具',first_mes:'私有开场'}),worldBooks:{bound:async()=>null},readRuntimeExtensions:async()=>({helperScripts:[{id:'smoke',type:'script',name:'调用烟测',content:"await replaceVariables({marker:23}, {type:'message',message_id:0});"}]})})
  t.after(()=>preparation.dispose())
  try {
    const result=await preparation.create('fixture-card')
    const resolved=(await preparation.resolve(result.id,'fixture-card'))
    assert.equal(requests.some(request=>request.method==='updateTavernHelperVariables'),true,JSON.stringify({requests,resolved}))
    assert.equal(resolved.messageVariables.marker,23,JSON.stringify(resolved))
    assert.equal(resolved.openingVariables.primary.marker,23)
    assert.deepEqual(result.runtime.scripts,[])
    assert.equal(reapedDuringOpening,true)
    executor.stop('opening:'+result.id)
    await executor.whenIdle('opening:'+result.id)
    assert.equal(executor.has('opening:'+result.id),false)
    // 开局完成已解除保护，普通会话仍按相同空闲回收策略释放。
    executor.demand('idle-fixture')
    assert.equal(executor.has('idle-fixture'),true)
    clock+=2000;await reapNow();await executor.whenIdle('idle-fixture')
    assert.equal(executor.has('idle-fixture'),false)
    // 待完成开局显式取消仍立即失效并join进程，不因回收保护悬挂。
    const cancelled=executor.opening('cancel-fixture')
    const refusal=assert.rejects(cancelled,/开局任务已失效/)
    executor.stop('opening:cancel-fixture');await refusal
    await executor.whenIdle('opening:cancel-fixture')
    assert.equal(executor.has('opening:cancel-fixture'),false)
  } catch(error) { error.message+='\n上游worker日志：'+logs.join('\n'); throw error }
})

test('撤销上游任务：真子进程失效后等待已受理IPC且拒绝迟到写，不重启旧代', async t => {
  const {root}=await isolatedOpening(t)
  const runtimeDomain=path.join(root,'tavern-plugin/lib/domain')
  fs.mkdirSync(runtimeDomain,{recursive:true})
  const require=createRequire(path.join(author,'tavern-plugin/package.json'))
  fs.writeFileSync(path.join(runtimeDomain,'probe.mjs'),`process.on('message', message => {
    if (message.type === 'start') process.send({type:'fetch',id:1,path:'/api/dsh-tavern/updateTavernHelperVariables',method:'POST',body:JSON.stringify({sessionId:'forged'})})
  }); process.on('disconnect',()=>process.exit(0));\n`,'utf8')
  const source=applyUpstreamExecutor(authorText('server-script-executor.js'))
    .replace("from './storage-upstream-compute.js'","from '"+policyUrl+"'")
    .replace("new URL('./server-script-worker.js', import.meta.url)","new URL('./probe.mjs', import.meta.url)")
    .replace("require.resolve('jsdom/package.json')",JSON.stringify(require.resolve('jsdom/package.json')))
  const file=path.join(runtimeDomain,'executor.mjs');fs.writeFileSync(file,source,'utf8')
  const {createServerScriptExecutor}=await import(pathToFileURL(file).href)
  let release, entered, seen, invalidated=0, lateRefused=false
  const gate=new Promise(resolve=>{release=resolve})
  const started=new Promise(resolve=>{entered=resolve})
  const executor=createServerScriptExecutor({subscribeSignals:()=>()=>{},logger:{log(){},warn(){},error(){}},invalidate(){invalidated++},
    handle:async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk.toString('utf8')
      assert.equal(JSON.parse(body).sessionId,'rollback-fixture')
      seen=upstreamRequest('rollback-fixture');assert.ok(seen)
      entered();await gate
      assert.throws(()=>authorizeUpstreamCall('updateTavernHelperVariables',{sessionId:'rollback-fixture'},()=>{}),/只允许/)
      lateRefused=true;res.end('{}')
    }
  })
  t.after(()=>{release();executor.dispose()})
  executor.demand('rollback-fixture')
  await started
  executor.stop('rollback-fixture')
  assert.equal(seen.isCurrent(),false)
  assert.equal(invalidated,1)
  let joined=false
  const idle=executor.whenIdle('rollback-fixture').then(()=>{joined=true})
  await Promise.resolve();assert.equal(joined,false)
  executor.demand('rollback-fixture');assert.equal(executor.has('rollback-fixture'),false)
  release();await idle
  assert.equal(lateRefused,true)
  assert.equal(joined,true)
})

test('撤销Helper模型任务：取消回执后仍join底层operation，不以race完成冒充静止',async t=>{
  const {root}=await isolatedOpening(t)
  const {createHelperGenerationTasks}=await import(pathToFileURL(path.join(root,'helper-generation-tasks.mjs')).href)
  const tasks=createHelperGenerationTasks()
  let release,entered,aborted=false
  const gate=new Promise(resolve=>{release=resolve})
  const started=new Promise(resolve=>{entered=resolve})
  t.after(()=>{release();tasks.dispose()})
  const result=tasks.run('model-fixture','generation-fixture',async signal=>{signal.addEventListener('abort',()=>{aborted=true});entered();await gate;return 'late'})
  const cancelled=assert.rejects(result,{name:'AbortError'})
  await started;tasks.stopAll('model-fixture');await cancelled
  assert.equal(aborted,true)
  let joined=false
  const idle=tasks.whenIdle('model-fixture').then(()=>{joined=true})
  await Promise.resolve();assert.equal(joined,false)
  release();await idle;assert.equal(joined,true)
})
