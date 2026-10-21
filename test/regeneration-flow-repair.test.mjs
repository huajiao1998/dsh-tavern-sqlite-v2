// 合成SQLite/真实作者编排和页面组装器；不连接服务器、不发模型、不读真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {fixture} from './regeneration-rollback-integration.test.mjs'
import {planRegenerationEvents} from '../lib/regeneration-events.js'
import {applyRegenerationSyncClientTransform} from '../deploy/regeneration-sync-client-transform.mjs'
import {clientCoreWrites} from '../deploy/client-seams.mjs'
import {applyRegenerationAdoptionTransform,applyRegenerationSyncHostTransform} from '../deploy/regeneration-adoption-transform.mjs'
import {applyRollbackTransform} from '../deploy/core-rollback-transform.mjs'
import {applyRowHistoryTransform} from '../deploy/row-rollback-transform.mjs'
import {applyCleanRollbackTransform} from '../deploy/clean-rollback-transform.mjs'
import {fileURLToPath} from 'node:url'

const AUTHOR=new URL('../../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b/',import.meta.url)
const ev=(seq,type,data,extra={})=>({seq,type,time:1,data,...extra})
const message=(turn,step,text)=>({turn,step,message:{id:text,role:'assistant',content:[{type:'text',text}],source:{kind:'model'}},stream:[]})
function uiConsumers(withInputs=false){
 // 装入既有200程序副本的真实assembler和assistantDefinition，不复刻去重/组装逻辑。
 const load=(name,extra='')=>{
  let result
  const source=readFileSync(new URL('../../../tmp/regen-200-20261021-1803/installed-'+name+'.js',import.meta.url),'utf8')
  const deps={'react':{memo:fn=>fn},'react-dom':{},'react/jsx-runtime':{jsx:()=>null,jsxs:()=>null},'@deepseek-ai/cordis':{Service:class{}},'@deepseek-ai/dsh-client-store':{},'@deepseek-ai/dsh-client-ui-slots':{},'@deepseek-ai/dsh-client-ui-primitives':{}}
  const window={__ModuleLoader__:{load:({factory})=>{result=factory(name=>deps[name])}}}
  vm.runInNewContext(source.replace('return module.exports;',extra+'\nreturn module.exports;'),{window,console,setTimeout,clearTimeout,AbortController,Symbol,TextEncoder,TextDecoder,URL},{timeout:1500})
  return result
 }
 const conversation=load('ui-conversation'),chat=load('ui-chat','exports.assistantDefinition=assistantDefinition;exports.messageDefinition=messageDefinition;')
 return ()=>new conversation.ConversationNodeAssembler({entries:()=>withInputs?[chat.assistantDefinition,chat.messageDefinition]:[chat.assistantDefinition],fallbackEntry:()=>undefined},{entries:()=>[]})
}

test('重生成修复：复用打开步骤、多步编号与引用映射，实际页面热冷组装均成功',()=>{
 const events=[ev(0,'turn/start',{turn:7}),ev(1,'step/start',{turn:7,step:3}),ev(2,'user/message',{source:{kind:'user'}}),ev(3,'assistant/message',message(7,3,'旧正文')),
  ev(4,'turn/start',{turn:8}),ev(5,'step/start',{turn:8,step:1}),ev(6,'request/header',{turn:8,step:1},{sourceEventSeqs:[5]}),ev(7,'assistant/message',message(8,1,'新正文一'),{surfaceOp:'append'}),ev(8,'step/end',{turn:8,step:1}),
  ev(9,'step/start',{turn:8,step:2}),ev(10,'assistant/message',message(8,2,'新正文二'),{surfaceOp:'append',sourceEventSeqs:[9]}),ev(11,'step/end',{turn:8,step:2}),ev(12,'turn/end',{turn:8,reason:{kind:'completed'}})]
 const plan=planRegenerationEvents({events,oldTurn:7,syntheticTurn:8,eventStart:4,oldAssistantSeq:3,chatId:'synthetic-plan'})
 assert.deepEqual(plan.events.map(e=>e.type),['request/header','assistant/message','step/end','step/start','assistant/message','step/end','turn/end'])
 assert.deepEqual(plan.events.filter(e=>e.data.step!==undefined).map(e=>e.data.step),[3,3,3,4,4,4])
 assert.deepEqual(plan.events[0].sourceEventSeqs,[1]);assert.deepEqual(plan.events[4].sourceEventSeqs,[6]);assert.deepEqual(plan.anchor,{turn:7,input:2,reply:7})
 const final=events.slice(0,plan.keep).concat(plan.events.map((e,i)=>({...e,seq:plan.keep+i,time:1}))),create=uiConsumers(),entries=final.map(event=>({type:'event',event}))
 const cold=create();cold.replaceWindow(entries,false);cold.flush()
 const hot=create();hot.replaceWindow(entries.slice(0,3),false);for(const entry of entries.slice(3))hot.append(entry);hot.flush()
 for(const assembler of [cold,hot]){
  assert.equal(assembler.contexts.size,2)
  assert.deepEqual([...assembler.contexts.values()].map(c=>c.matches.filter(m=>m.role==='start').length),[1,1])
 }
})

test('重生成修复：变量从原基准重算并等待后续任务，最终同步后可连续重生成',async()=>{
 let settlements=0
 const f=await fixture({physical:true,settle:async({read,update})=>{
  const current=await read(),target=current.messages.at(-1)
  assert.equal(current.regenInProgress,undefined);assert.equal(target.turn,53);assert.equal(target.mvu.pending,true)
  assert.deepEqual(target.mvuBaseline.variables,{hp:53});assert.equal(JSON.stringify(target.mvu).includes('legacy-delivery'),false)
  await Promise.resolve();settlements++
  await update(current.id,draft=>{draft.messages.at(-1).variables=[{hp:target.mvuBaseline.variables.hp+2}];draft.messages.at(-1).mvu={pending:false,receipt:{status:'updated'}};draft.settleStatus='done';return draft},{source:'settlement.fixture'})
 }})
 try{
  for(let i=0;i<2;i++){
   const result=await f.roundHistory.regenerate((await f.read()).id,'新正文'),current=await f.read()
   assert.equal(settlements,i+1);assert.equal(f.syncFrames.length,i+1)
   assert.equal(result.settleStatus,'done');assert.deepEqual(current.messages.at(-1).variables,[{hp:55}])
   assert.equal(result.adopted.sync.revision,current._storageRevision)
   assert.ok(current.regenerationCompletion.revision<current._storageRevision,'结算推进版本，不应让完成凭据误拦')
   const events=f.session.snapshotEvents();assert.equal(events.filter(e=>e.type==='step/start'&&e.data.turn===53&&e.data.step===1).length,1)
   assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i))
  }
 }finally{await f.cleanup()}
})

test('重生成去分类：实际作者与SQLite保留模型切换通知，连续替换后重算并可回退',async()=>{
  const contextMessages=[
    {role:'user',content:[{type:'text',text:'[model changed: assistant turns above this point were generated by fixture-old; the session continues with fixture-new]'}],source:{kind:'plugin',plugin:'model-selection',form:'notice'}},
    {role:'user',content:[{type:'text',text:'未知插件正常上下文'}],source:{kind:'extension-context',plugin:'not-listed'}}]
  let settlements=0
  const f=await fixture({physical:true,withContext:true,contextMessages,settle:async({read,update})=>{
    const chat=await read(),body=chat.messages.at(-1)
    assert.deepEqual(body.mvuBaseline.variables,{hp:53})
    assert.equal(body.mvu.pending,true)
    await update(chat.id,draft=>{draft.messages.at(-1).variables=[{hp:55}];draft.messages.at(-1).mvu={pending:false};draft.settleStatus='done';return draft},{source:'settlement.fixture'})
    settlements++
  }})
  try{
    const before=await f.read(),original=f.session.snapshotEvents(),keep=original.find(event=>event.type==='assistant/message'&&event.data.turn===53).seq
    const prefix=structuredClone(original.slice(0,keep))
    for(let n=0;n<2;n++){
      const result=await f.roundHistory.regenerate(before.id,'补充'+n),chat=await f.read(),events=f.session.snapshotEvents()
      assert.deepEqual(events.slice(0,keep),prefix,'正文之前原输入与所有上下文原位保留')
      assert.deepEqual(f.mainDb.readAll().events,events)
      assert.deepEqual(chat.messages.at(-2),before.messages.at(-2))
      assert.equal(events.some(event=>event.data?.turn>=54),false)
      assert.equal(events.some(event=>event.type==='user/message'&&event.data?.source?.plugin==='dsh-tavern-regen'),false)
      assert.equal(events.filter(event=>event.type==='step/start'&&event.data.turn===53).length,1)
      assert.equal(result.adopted.sync.revision,chat._storageRevision)
      assert.deepEqual(chat.messages.at(-1).variables,[{hp:55}])
      assert.equal(settlements,n+1)
      const {resolveRoundAnchor}=await import(new URL('tavern-plugin/lib/domain/round-anchor.js',AUTHOR))
      const anchor=resolveRoundAnchor({events,nodes:f.session.surface.nodes},chat.messages.at(-1).nativeAnchor)
      assert.ok(Number.isSafeInteger(anchor?.input)&&Number.isSafeInteger(anchor?.reply))
      const cold=f.Session.fromRestore(f.session.id,structuredClone(events),structuredClone(f.session.header),f.session.inheritedEventCount,'detached')
      assert.deepEqual(cold.surface.nodes,f.session.surface.nodes)
    }
    const {cleanRollback}=await import('../lib/clean-rollback.js')
    await cleanRollback({...f.args(),chat:await f.read(),requestedTurn:53})
    assert.deepEqual(f.session.snapshotEvents(),f.prefix)
    assert.deepEqual(f.mainDb.readAll().events,f.prefix)
  }finally{await f.cleanup()}
})

test('重生成注入：连续三次仅保留当前尝试，独立通知和热冷页面不累积',async()=>{
 const f=await fixture({physical:true,withContext:true,retireCurrentFrame:false,currentAuthor:true,originalFrame:true}),create=uiConsumers(true)
 const isFrame=event=>event.type==='user/message'&&event.data.source?.form==='foreground-frame'
 try{
  const before=await f.read(),original=f.session.snapshotEvents(),old=original.findLast(event=>event.type==='assistant/message'&&event.data.turn===53)
  // 保留首次修复前的已有尾形状：旧正文后正常注入先于本次生成，并非全都应删。
  f.session.append('user/message',{id:'independent-between-attempts',role:'user',content:[{type:'text',text:'独立上下文保留'}],source:{kind:'extension-context',plugin:'not-listed'}},{surfaceOp:'append'})
  for(let n=0;n<3;n++){
   if(n===1)f.session.append('user/message',{id:'model-switch-once',role:'user',content:[{type:'text',text:'模型切换仅一次'}],source:{kind:'plugin',plugin:'model-selection',form:'notice'}},{surfaceOp:'append'})
   await f.sessions.flush(f.session)
   await f.roundHistory.regenerate(before.id,'本次'+n)
   const events=f.session.snapshotEvents(),frames=events.filter(isFrame),stored=f.mainDb.readAll().events
   assert.equal(frames.length,1,'SQL只存当前尝试frame，不保留原append和旧退役墓碑')
   assert.ok(frames[0].data.content.some(block=>block.type==='text'&&block.text.includes('自有请求上下文')),'当前frame不提前清空')
   assert.equal(events.filter(event=>event.data?.id==='independent-between-attempts').length,1)
   assert.equal(events.filter(event=>event.data?.id==='model-switch-once').length,n?1:0,'独立模型通知不累计且不误删')
   assert.deepEqual(stored,events)
   const cold=f.Session.fromRestore(f.session.id,structuredClone(stored),structuredClone(f.session.header),0,'detached')
   for(const subject of [f.session,cold])assert.equal(subject.deriveMessages().filter(message=>message.source?.form==='foreground-frame'&&message.content.length).length,1,'热冷有效上下文仅本次')
   const entries=stored.map(event=>({type:'event',event})),hot=create(),restored=create()
   hot.replaceWindow(entries.slice(0,old.seq),false);for(const entry of entries.slice(old.seq))hot.append(entry);hot.flush()
   restored.replaceWindow(entries,false);restored.flush()
   for(const ui of [hot,restored])assert.equal([...ui.contexts.values()].filter(context=>context.kind==='input-message'&&context.state?.source?.form==='foreground-frame').length,1,'真实页面组装只产生当前注入行')
   const inputEnd=original.findLast(event=>event.type==='user/message'&&event.data.source?.kind==='user').seq+1
   assert.deepEqual(events.slice(0,inputEnd),original.slice(0,inputEnd),'原玩家输入及之前历史原位保留')
  }
 }finally{await f.cleanup()}
})

test('重生成修复：旧完成凭据不能抢占新committed意图，恢复仍先采用再结算',async()=>{
 let settlements=0
 const f=await fixture({physical:true,settle:async({read,update})=>{settlements++;const chat=await read();await update(chat.id,c=>{c.settleStatus='done';return c},{source:'settlement.fixture'})}})
 try{
  const id=(await f.read()).id;await f.roundHistory.regenerate(id,'第一版')
  const oldCompletion=(await f.read()).regenerationCompletion
  const replace=f.persistencePort.replaceRegeneratedTail;f.persistencePort.replaceRegeneratedTail=async()=>{throw Error('fixture adoption failure')}
  await assert.rejects(f.roundHistory.regenerate(id,'第二版'),/fixture adoption failure/)
  // 正常回退会清旧回执；显式构造旧档里二者共存的恢复输入。
  await f.update(id,c=>{c.regenerationCompletion=oldCompletion;return c},{source:'rollback.fixture-legacy-completion'})
  const pending=await f.read();assert.equal(pending.regenRecovery.phase,'committed');assert.notEqual(pending.regenRecovery.id,pending.regenerationCompletion.id)
  f.persistencePort.replaceRegeneratedTail=replace
  await f.roundHistory.recover(id)
  const after=await f.read();assert.equal(after.regenRecovery,undefined);assert.equal(after.regenerationCompletion.id,pending.regenRecovery.id);assert.equal(settlements,2)
 }finally{await f.cleanup()}
})

test('重生成修复：当前作者实际施缝保留结算链，最终同步在其后且幂等',()=>{
 const raw=readFileSync(new URL('tavern-plugin/lib/domain/round-history.js',AUTHOR),'utf8')
 const output=applyRegenerationAdoptionTransform(applyCleanRollbackTransform(applyRowHistoryTransform(applyRollbackTransform(raw).text)))
 assert.equal(applyRegenerationAdoptionTransform(output),output)
 assert.ok(output.includes('await regenerationRecovery.recover(chat.id, { pendingOnly: true })'))
 assert.ok(output.includes('await regenerationRecovery.complete({ chatId: chat.id, session, operationId, quiet: true })'))
 assert.ok(output.indexOf('await queueSettlement(committedChat.id)')<output.indexOf('sync: regenerationRecovery.publishCompletion(await readChat(chat.id), session)'))
 assert.ok(output.includes('async function regenerate(chatId, guidance, sessionId, syncOnly = false, requestedOperationId)'))
 assert.ok(output.includes('chatId: chat.id, replacement, previousRange: regenerationRestore.record.previousRange })'),'传递作者范围和上一批SQL坐标')
 const oldOutput=output.replace(', replacement, previousRange: regenerationRestore.record.previousRange })',' })')
 assert.equal(applyRegenerationAdoptionTransform(oldOutput),output,'既有物理接缝原位升级，不新增标记层')
 const host=applyRegenerationSyncHostTransform(readFileSync(new URL('tavern-plugin/lib/index.js',AUTHOR),'utf8'))
 assert.equal(applyRegenerationSyncHostTransform(host),host)
 assert.ok(host.includes('args && args.sessionId, args && args.syncOnly, args && args.operationId)'))
})

function submitConsumer(source,rpc,clear=()=>{}){
 const start=source.indexOf('async function submitBodyRegeneration('),end=source.indexOf('// A failed turn',start)
 return new Function('rpc','setCandidatePanel',source.slice(start,end)+';return submitBodyRegeneration;')(rpc,clear)
}
test('重生成修复：source及built按钮等待同步，失败重试只读页面不重复请求生成',async()=>{
 const writes=clientCoreWrites(fileURLToPath(AUTHOR))
 for(const rel of ['tavern-plugin/src/client/features/play-controls.js','tavern-plugin/lib/client.js']){
  const source=writes.get(rel);assert.equal(applyRegenerationSyncClientTransform(source),source)
  assert.ok(source.includes('React.createElement(RegenPanel, Object.assign({}, props, { sessions: ctx.sessions }))'))
  const order=[],panel={},calls=[];let fail=true,revision=8
  const sessions={manager:{applyTavernRollbackSync:()=>{throw Error('按钮不得重放缓存基线')}},waitForTavernRollbackSync:async r=>{order.push('wait:'+r.revision);if(fail)throw Error('history failed')}}
  const submit=submitConsumer(source,async(_method,args)=>{calls.push(args.syncOnly);return {view:{adopted:{sync:{revision:++revision}}}}},()=>order.push('clear'))
  await assert.rejects(submit('session-fixture',panel,'指导',sessions),/正文已替换，页面同步失败/)
  fail=false;await submit('session-fixture',panel,'指导',sessions)
  assert.deepEqual(calls,[false,true]);assert.equal(panel.sync,undefined);assert.deepEqual(order,['wait:9','wait:10','clear'])
 }
})

test('重生成重试：广播故障及响应丢失后真实按钮不再生成结算，取当前队列运行状态',async()=>{
 const source=clientCoreWrites(fileURLToPath(AUTHOR)).get('tavern-plugin/src/client/features/play-controls.js')
 for(const failure of ['broadcast','response']){
  let settlements=0,followups=0
  const f=await fixture({physical:true,settle:async({read,update})=>{settlements++;const c=await read();await update(c.id,d=>{d.settleStatus='done';return d},{source:'settlement.fixture'})}})
  try{
   const id=(await f.read()).id,followup=f.agent.followup;f.agent.followup=message=>{followups++;return followup(message)}
   const panel={},flags=[]
   if(failure==='broadcast')f.faults.broadcast=Error('fixture broadcast failure')
   const submit=submitConsumer(source,async(_method,args)=>{
    flags.push(args.syncOnly)
    const view=await f.roundHistory.regenerate(id,args.guidance,f.session.id,args.syncOnly,args.operationId)
    if(failure==='response'&&flags.length===1)throw Error('fixture response lost')
    return {view}
   })
   const sessions={waitForTavernRollbackSync:async r=>assert.equal(r.revision,f.syncFrames.at(-1).value.revision)}
   await assert.rejects(submit(f.session.id,panel,'指导',sessions),/fixture/)
   assert.equal(followups,1);assert.equal(settlements,1)
   assert.equal((await f.read()).regenerationCompletion.id,panel.operationId)
   const seq=f.session.seq
   f.faults.broadcast=null
   await f.commitTurn(54,'之后的新轮')
   const queue={id:'new-queue',content:[{type:'text',text:'后来输入'}],source:{kind:'user',rpcId:'new-rpc'}}
   f.agent.inbox.nextTurn.push(queue);f.agent.phase.kind='running'
   await submit(f.session.id,panel,'指导',sessions)
   assert.deepEqual(flags,[false,true]);assert.equal(followups,1);assert.equal(settlements,1)
   const sync=f.syncFrames.at(-1).value.sessions[0]
   assert.equal(sync.running,true);assert.equal(sync.queues[0].id,'new-queue');assert.equal(sync.asOfSeq,f.session.seq-1)
   assert.ok(f.session.seq>seq);assert.equal((await f.read()).messages.at(-1).text,'之后的新轮')
  }finally{await f.cleanup()}
 }
})

test('重生成重试：未完物理采用由补同步完成并结算一次，不再发起生成',async()=>{
 let settlements=0
 const f=await fixture({physical:true,settle:async({read,update})=>{settlements++;const c=await read();await update(c.id,d=>{d.settleStatus='done';return d},{source:'settlement.fixture'})}})
 try{
  const id=(await f.read()).id,replace=f.persistencePort.replaceRegeneratedTail
  f.persistencePort.replaceRegeneratedTail=async()=>{throw Error('fixture adoption failed')}
  await assert.rejects(f.roundHistory.regenerate(id,'指导'),/fixture adoption failed/)
  assert.equal((await f.read()).regenRecovery.phase,'committed');assert.equal(settlements,0)
  f.persistencePort.replaceRegeneratedTail=replace;f.agent.followup=()=>{throw Error('不得再次生成')}
  const result=await f.roundHistory.regenerate(id,'',f.session.id,true)
  assert.equal(settlements,1);assert.equal(f.syncFrames.length,1);assert.equal(result.settleStatus,'done')
  assert.equal((await f.read()).regenRecovery,undefined)
 }finally{await f.cleanup()}
})

test('重生成重试：新请求未送达不能拿旧完成结果冒充本次成功',async()=>{
 const source=clientCoreWrites(fileURLToPath(AUTHOR)).get('tavern-plugin/src/client/features/play-controls.js')
 const f=await fixture({physical:true})
 try{
  const id=(await f.read()).id;await f.roundHistory.regenerate(id,'旧成功')
  const completion=(await f.read()).regenerationCompletion,panel={};let calls=0
  f.agent.followup=()=>{throw Error('不得生成')}
  const submit=submitConsumer(source,async(_method,args)=>{
   if(++calls===1)throw Error('request not sent')
   return {view:await f.roundHistory.regenerate(id,args.guidance,f.session.id,args.syncOnly,args.operationId)}
  })
  await assert.rejects(submit(f.session.id,panel,'新请求',{}),/request not sent/)
  await assert.rejects(submit(f.session.id,panel,'新请求',{}),/本次重生成未采用/)
  assert.notEqual(panel.operationId,completion.id);assert.equal(f.syncFrames.length,1)
 }finally{await f.cleanup()}
})

test('重生成重试：未采用时补同步不误报成功也不生成',async()=>{
 const f=await fixture({physical:true})
 try{
  const id=(await f.read()).id;let followups=0;f.agent.followup=()=>{followups++}
  await assert.rejects(f.roundHistory.regenerate(id,'',f.session.id,true),/本次重生成未采用/)
  assert.equal(followups,0);assert.equal(f.syncFrames.length,0)
 }finally{await f.cleanup()}
})
