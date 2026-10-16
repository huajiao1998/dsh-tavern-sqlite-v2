// 新作者真实任务API＋Host接缝：仅合成任务与确定性DI，不模型/真实档；取消后实际run与已发写入须静止。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {AsyncLocalStorage} from 'node:async_hooks'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
import {applyPluginTaskHostTransform,applyPluginTaskApiTransform} from '../deploy/plugin-task-quiescence-transform.mjs'
const raw=()=>fs.readFileSync(new URL('../../../tmp/upstream-7e349-review/plugin-api.js',import.meta.url),'utf8')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const tick=()=>new Promise(r=>setImmediate(r))
function factory(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),cuts=ast.body.filter(n=>n.type==='ImportDeclaration').map(n=>({start:n.start,end:n.end,text:''})).concat(ast.body.filter(n=>n.type==='ExportNamedDeclaration').map(n=>({start:n.start,end:n.declaration.start,text:''})))
 for(const cut of cuts.sort((a,b)=>b.start-a.start))source=source.slice(0,cut.start)+cut.text+source.slice(cut.end)
 return vm.runInNewContext(source+'\ncreateTavernPluginApi',{AsyncLocalStorage,AbortController,AbortSignal,structuredClone,setTimeout,clearTimeout,console})
}
test('上游7e349手动任务：实际run及在途写收尾才静止，取消后迟到写拒，Host准入屏障与忙通知完整',async()=>{
 const source=applyPluginTaskApiTransform(raw());assert.equal(applyPluginTaskApiTransform(source),source)
 const create=factory(source),runEntered=deferred(),runRelease=deferred(),writeEntered=deferred(),writeRelease=deferred();let writes=0,lateRejected=false
 const deps={ctx:{fiber:{name:'synthetic-plugin'},effect:fn=>fn()},resolveGame:async()=>({chatId:'chat',sessionId:'session'}),data:{readSettings:async()=>({disabled:[],replacements:{},disabledTasks:[],taskOrder:[]}),saveGame:async()=>{writeEntered.resolve();await writeRelease.promise;writes++}},readLatestSettledTurn:async()=>null}
 const api=create(deps)
 api.service.manualTask({name:'waiter',run:async()=>{
  const writing=api.service.saveGameData({gameId:'session',data:{synthetic:true}})
  runEntered.resolve();await runRelease.promise
  try{await api.service.saveGameData({gameId:'session',data:{late:true}})}catch{lateRejected=true}
  await writing
 }})
 let done=false;const job=api.runManualTask({gameId:'session',key:'synthetic-plugin:waiter',signal:new AbortController().signal}).then(()=>done=true)
 await runEntered.promise;await writeEntered.promise;assert.ok(api.runningTask('session'))
 api.stopTasks('session');await tick();assert.equal(done,false,'abort race不得先完成实际run');assert.ok(api.runningTask('session'))
 runRelease.resolve();await tick();assert.equal(lateRejected,true);assert.equal(done,false,'在途写不得先释放');writeRelease.resolve();await job
 assert.equal(writes,1);assert.equal(api.runningTask('session'),null)
 await api.service.saveGameData({gameId:'session',data:{normal:true}});assert.equal(writes,2,'任务外正常API保留')
 const host=fs.readFileSync(new URL('../../../tmp/upstream-7e349-review/index.js',import.meta.url),'utf8')
 // 实际Host函数加主链的回退消费者片段；完整链另叶调用真实buildCore。
 const idle="!settlementJobs.isBusy(chat.id) && !Object.values(chat.timeline?.participants"
 const ready=host+'\nconst idle = () => '+idle+' || {}).some(Boolean);\nasync function quiesceRollback(chat) {\n      await cancelSettlement(chat.id, { wait: true })\n}\n'
 const patched=applyPluginTaskHostTransform(ready)
 assert.equal(applyPluginTaskHostTransform(patched),patched);assert.ok(patched.includes('await quiescePluginTasks(chat)'))
 assert.ok(patched.includes("pluginTaskJobs.get(chat.id)?.controller.abort(new Error('玩家停止了插件任务'))"))
 const from=patched.indexOf('  async function quiescePluginTasks('),to=patched.indexOf('  async function onSettlementSettled(',from),taskChunk=patched.slice(from,to)
 const taskDone=deferred(),registration=deferred(),calls=[],barrier=new Set();const map=new Map()
 const ctx={pluginTaskJobs:map,rollbackSchedulingBarrier:barrier,AbortController,taskStateReader:{forSession:async()=>({id:'chat',sessionId:'session',mode:'story'})},str:x=>x,agentRegistry:{get:()=>null},pluginApi:{manualTaskFor:async()=>registration.promise,runManualTask:async()=>{calls.push('run');await taskDone.promise},stopTasks:()=>calls.push('abort')},backgroundTasks:{begin:async()=>({commit:async()=>calls.push('commit')})},pluginSettlementProgress:{begin:()=>{}},sessionSignals:{publish:()=>calls.push('idle')},console,Date}
 const hostFns=vm.runInNewContext(taskChunk+'\n({startPluginTask,quiescePluginTasks})',ctx)
 const starting=hostFns.startPluginTask('session','key');await tick();assert.equal(map.has('chat'),true,'资格await前占位')
 const duplicate=hostFns.startPluginTask('session','key');await assert.rejects(duplicate,/已有插件任务/)
 registration.resolve();await starting
 let quiet=false;const quiescing=hostFns.quiescePluginTasks({id:'chat',sessionId:'session'}).then(()=>quiet=true);await tick();assert.equal(quiet,false);assert.equal(map.has('chat'),true)
 taskDone.resolve();await quiescing;assert.equal(map.size,0);assert.deepEqual(calls,['run','abort','commit','idle'])
 barrier.add('session');await assert.rejects(hostFns.startPluginTask('session','key'),/物理回退/)
 barrier.clear()
 // 准入前停止仍等待qualification实际收尾，且不会创建后台任务。
 const validation=deferred();ctx.pluginApi.manualTaskFor=()=>validation.promise
 const early=hostFns.startPluginTask('session','key');const rejected=assert.rejects(early,/物理回退/);await tick()
 const beforeCalls=calls.length,earlyQuiet=hostFns.quiescePluginTasks({id:'chat',sessionId:'session'});await tick();assert.equal(map.has('chat'),true)
 validation.resolve();await rejected;await earlyQuiet;assert.deepEqual(calls.slice(beforeCalls),['abort','idle']);assert.equal(map.size,0)
 const canceled=new AbortController();canceled.abort(new Error('已取消'))
 await api.runManualTask({gameId:'session',key:'synthetic-plugin:waiter',signal:canceled.signal});assert.equal(api.runningTask('session'),null);assert.equal(writes,2,'预取消任务不得执行callback或写')
})

test('上游7e349在途写：callback已返回但未await写API仍阻止静止直到实际写收尾',async()=>{
 const create=factory(applyPluginTaskApiTransform(raw())),entered=deferred(),release=deferred();let written=0
 const api=create({ctx:{fiber:{name:'synthetic-plugin'},effect:fn=>fn()},resolveGame:async()=>({chatId:'chat',sessionId:'session'}),data:{readSettings:async()=>({disabled:[],replacements:{},disabledTasks:[],taskOrder:[]}),saveGame:async()=>{entered.resolve();await release.promise;written++}},readLatestSettledTurn:async()=>null})
 api.service.manualTask({name:'detached',run:async()=>{api.service.saveGameData({gameId:'session',data:{synthetic:true}}).catch(()=>{});await entered.promise}})
 let quiet=false;const job=api.runManualTask({gameId:'session',key:'synthetic-plugin:detached',signal:new AbortController().signal}).then(()=>quiet=true)
 await entered.promise;await tick();assert.equal(quiet,false);assert.ok(api.runningTask('session'));assert.equal(written,0)
 release.resolve();await job;assert.equal(quiet,true);assert.equal(written,1);assert.equal(api.runningTask('session'),null)
})
