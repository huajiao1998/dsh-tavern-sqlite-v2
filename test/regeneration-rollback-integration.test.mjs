// R3真实链：作者完整round-history、row/business timeline、chat-persistence与真实Session/SQL。
// 外部模型响应使用确定性adapter；不测模板/LLM。Session只装产品相同的replace纯施缝，
// 不安装当前Harness补丁，不扩大rc.2 JSONL worker兼容范围，也不访问任何真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {createRequire,registerHooks} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {SqliteSessionDb} from '../store.js'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {cleanRollback} from '../lib/clean-rollback.js'
import {configureRollbackCleanup} from '../lib/rollback-cleanup.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
import {applyRollbackTransform} from '../deploy/core-rollback-transform.mjs'
import {applyRowTimelineTransform,applyRowHistoryTransform} from '../deploy/row-rollback-transform.mjs'
import {applyRollbackBusinessTimelineTransform} from '../deploy/rollback-business-transform.mjs'
import {applyRegenerationRollbackTransform} from '../deploy/regeneration-rollback-transform.mjs'
import {applyRegenerationAdoptionTransform} from '../deploy/regeneration-adoption-transform.mjs'
import {transformSessionReplacementSource} from '../lib/domain/host-session-patch.js'
import {installRollbackSync} from '../lib/rollback-sync.js'

const AUTHOR=new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/domain/',import.meta.url)
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT||'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
const CHAT_ID='chat-regen-rollback-fixture',SESSION_ID='session-regen-rollback-fixture',WORKER_ID='worker-regen-rollback-fixture'
const modelSource={kind:'model',provider:'fixture-provider',model:'fixture-model'}
const writeModule=(root,name,source)=>{const file=path.join(root,name+'.mjs');writeFileSync(file,source,'utf8');return pathToFileURL(file).href}
// 未调用的显示依赖响亮拒绝；核心回退/SQL/折叠不设桩。
registerHooks({resolve(spec,context,next){
 if(['jsdom','marked'].includes(spec))return {url:'r3-unused:display',shortCircuit:true}
 if(spec==='./tavern-macro-engine.js')return {url:'r3-unused:macro',shortCircuit:true}
 return next(spec,context)
},load(url,context,next){
 if(url==='r3-unused:display')return {format:'module',source:"const no=()=>{throw Error('本断言不调用显示DOM')};export const JSDOM=no,marked=no,VirtualConsole=no",shortCircuit:true}
 if(url==='r3-unused:macro')return {format:'module',source:"export const renderTavernMacros=()=>{throw Error('本断言不调用宏渲染')}",shortCircuit:true}
 return next(url,context)
}})
const helperSources=[['copyJsonTree','copy-json-tree.js'],['diffJson','json-mutation.js'],['applyJsonChangesShared','json-mutation.js'],['projectSceneImageState','chat-session-state.js'],['projectChatSessionState','chat-session-state.js'],['projectDisplayRuntimeState','chat-session-state.js'],['projectChatBackgroundConfig','chat-session-state.js'],['projectSettlementCheckpoint','chat-session-state.js']]
const helpers={}
for(const [name,file] of helperSources)helpers[name]=(await import(new URL(file,AUTHOR).href))[name]
const {rollbackAvailability}=await import(new URL('rollback-surface.js',AUTHOR).href)
const {sessionEvents}=await import(new URL('session-events.js',AUTHOR).href)
configureRollbackCleanup({sessionEvents})

async function loadRealModules(root,physical=false){
 const AUTHOR=physical?new URL('../../../tmp/regeneration-physical-fixture-20261011/',import.meta.url):new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/domain/',import.meta.url)
 const rewrite=source=>source.replace(/from '(.+?)'/g,(all,spec)=>spec.startsWith('./')?'from '+JSON.stringify(new URL(spec,AUTHOR).href):all)
 const business=new URL('../lib/rollback-business-state.js',import.meta.url).href
 const clean=new URL('../lib/clean-rollback.js',import.meta.url).href
 const adoption=new URL('../lib/regeneration-adoption.js',import.meta.url).href
  const shim=writeModule(root,'storage-rollback',`export * from ${JSON.stringify(clean)}\nexport * from ${JSON.stringify(adoption)}\n`)
 const timelineSource=applyRollbackBusinessTimelineTransform(applyRowTimelineTransform(readFileSync(new URL('story-timeline.js',AUTHOR),'utf8')))
 assert.equal(applyRollbackBusinessTimelineTransform(timelineSource),timelineSource)
 const timeline=await import(writeModule(root,'timeline',rewrite(timelineSource).replace(new URL('storage-rollback-business.js',AUTHOR).href,business)))
 const historySource=applyRowHistoryTransform(applyRollbackTransform(readFileSync(new URL('round-history.js',AUTHOR),'utf8')).text)
 assert.equal(applyRegenerationRollbackTransform(historySource),historySource,'R3消费者须幂等')
 const {applyCleanRollbackTransform}=await import('../deploy/clean-rollback-transform.mjs')
  const adoptedSource=physical?applyRegenerationAdoptionTransform(applyCleanRollbackTransform(historySource)):historySource
 if(physical)assert.equal(applyRegenerationAdoptionTransform(adoptedSource),adoptedSource)
 const history=await import(writeModule(root,'history',rewrite(adoptedSource).replaceAll(new URL('storage-rollback.js',AUTHOR).href,shim)))
 const persistence=await import(new URL('chat-persistence.js',AUTHOR).href)
 // rc.2真实Session源使用产品本身的纯施缝，不复刻校验实现、不放宽append/引用护栏。
 const raw=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js',import.meta.url),'utf8')
 const sessionSource=transformSessionReplacementSource(raw).replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 const sessionModule=await import(writeModule(root,'session',sessionSource))
 return {timeline,history,persistence,Session:sessionModule.Session}
}
const book=turn=>({version:1,document:{entries:[{uid:0,content:'原创世界书'+turn}]}})
export async function fixture({withContext=false,physical=false}={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-regen-rollback-'))
 const {timeline,history,persistence,Session}=await loadRealModules(root,physical)
 const store=createChatSqliteStore({dataRoot:root,helpers})
 const chatPersistence=persistence.createChatPersistence({store})
 const storyTimeline=timeline.createStoryTimeline({readRollbackWorldbook:store.readRollbackWorldbook,readRollbackWorldbookRef:store.readCurrentRollbackWorldbookRef,readRollbackOperationSnapshot:store.readRollbackOperationSnapshot})
 const session=Session.create(SESSION_ID),background=Session.create(WORKER_ID)
 background.append('session/end-seed',{})
 const {createForegroundFrameSessionAdapter}=await import(new URL('foreground-frame-session-adapter.js',AUTHOR).href)
 const {retireForegroundFrames}=await import(new URL('foreground-frame-retirement.js',AUTHOR).href)
 const frameAdapter=createForegroundFrameSessionAdapter()
 const appendTurn=(subject,turn,text,source={kind:'user'})=>{
  subject.append('turn/start',{turn})
  if (withContext && subject===session && source.plugin==='dsh-tavern-regen') {
   const frame={kind:'foreground',frameId:'frame-'+turn,chatId:CHAT_ID,turn,operationId:'body-fixture-'+turn,branchId:'branch-regen',basedOnRevision:turn-1,source:{},contributions:[{slot:'playerInput',text:'自有请求上下文'+turn,source:{kind:'fixture'}}]}
   const adapted=frameAdapter.append({session:subject,messages:[],historyMessages:[],step:1,frame})
   assert.equal(adapted.receipt.appended,true)
   for (const message of adapted.messages)subject.append('user/message',message,{surfaceOp:'append'})
   // 按真作者pre-step退役上一请求frame；当前新frame由本次请求消费后也沿同函数退役。
   retireForegroundFrames(subject,{keepTurn:turn})
   retireForegroundFrames(subject)
  }
  subject.append('user/message',{id:subject.id+'-u'+turn,role:'user',content:[{type:'text',text}],source},{surfaceOp:'append'})
  subject.append('assistant/message',{turn,step:1,message:{id:subject.id+'-a'+turn,role:'assistant',content:[{type:'text',text}],source:modelSource},stream:[]},{surfaceOp:'append'})
  subject.append('turn/end',{turn,reason:{kind:'completed'}})
 }
 appendTurn(session,52,'原52')
 const prefix=structuredClone(session.snapshotEvents()),workerPrefix=structuredClone(background.snapshotEvents())
 const mainDb=new SqliteSessionDb(path.join(root,'session.db')),workerDb=new SqliteSessionDb(path.join(root,'worker.db'))
 mainDb.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
 workerDb.materialize(background.header,background.inheritedEventCount,background.snapshotEvents())
 const dbs=new Map([[SESSION_ID,mainDb],[WORKER_ID,workerDb]])
 const flush=async subject=>{
  const db=dbs.get(subject.id),cursor=db.cursor()
  if(subject.seq>cursor)db.appendBatch(subject.snapshotEvents(cursor),cursor)
 }
 const read=()=>chatPersistence.read(CHAT_ID),update=(id,fn,meta)=>chatPersistence.update(id,fn,meta)
 const base={id:CHAT_ID,sessionId:SESSION_ID,_storageRevision:1,mode:'story',cardPath:'cards/fixture.json',
  messages:[{role:'user',turn:52,text:'原52输入'},{role:'assistant',turn:52,text:'原52',swipeId:0,swipes:['原52'],variables:[{hp:52}]}],variables:{hp:52},openingWorldbookSnapshot:book(52),guides:[{text:'基准时配置'}],macroState:{userName:'初始称呼'},
  timeline:{schemaVersion:1,branchId:'branch-regen',revision:52,checkpoints:[],operations:{},participants:{settlement:{role:'settlement',sessionId:WORKER_ID,lifetime:'chat',boundary:background.seq-1}}}}
 await store.update(CHAT_ID,()=>base)
 const agents=new Map([session,background].map(subject=>[subject.id,{session:subject,phase:{kind:'idle',lastTurn:subject===session?52:0},inbox:{nextTurn:[],nextStep:[]},runtimeContext:{}}]))
 const handles=new Set([session,background].map(subject=>({id:subject.id,access:'write',state:{cursor:subject.seq,primed:null},observedLength:subject.seq})))
 const backgroundTask=async owner=>{
  const boundary=background.seq-1,nextTurn=agents.get(WORKER_ID).phase.lastTurn+1
  appendTurn(background,nextTurn,'后台剧情'+owner);await flush(background)
  agents.get(WORKER_ID).phase.lastTurn=nextTurn
  return boundary
 }
 // 真实生产者写body.begin/complete与原生响应；不代实现时间线或正文替换。
 const commitTurn=async(turn,text,source={kind:'user'})=>{
  appendTurn(session,turn,text,source);await flush(session)
  await update(CHAT_ID,current=>{
   const begun=storyTimeline.apply({chat:current,intent:{kind:'body.begin',turn,userText:text,businessBefore:storyTimeline.captureBusiness(current)}})
   const next=begun.chat
   next.messages.push({role:'user',turn,text},{role:'assistant',turn,text,swipeId:0,swipes:[text],variables:[{hp:turn}],
    // physical：原 assistant 带明确 mvuBaseline（含旧 receipt/delivery），用于证明采用后不继承旧回执。
    ...(physical&&source?.plugin!=='dsh-tavern-regen'?{mvu:{receipt:{version:1,status:'done',delivery:'legacy-delivery-'+(turn-52)}},mvuBaseline:{swipeId:0,variables:{hp:turn}}}:{})})
   next.variables={hp:turn};next.openingWorldbookSnapshot=book(turn)
   const completed=storyTimeline.complete({chat:next,operationId:begun.value.operationId,basedOn:begun.value.basedOn,outcome:{status:'success'}})
   assert.equal(completed.value.status,'committed','真实正文生产者必须完成')
   return completed.chat
  },{source:'foreground.response-adapter'})
  const boundary=await backgroundTask(turn)
  await update(CHAT_ID,current=>{
   current.rollbackSessionCuts={...current.rollbackSessionCuts,[turn]:{[WORKER_ID]:boundary}}
   current.timeline.participants.settlement={...current.timeline.participants.settlement,boundary:background.seq-1}
   return current
  },{source:'background.response-adapter'})
  agents.get(SESSION_ID).phase.lastTurn=turn
 }
 await commitTurn(53,'原53')
 await update(CHAT_ID,current=>{current.guides=[{text:'用户新配置保留'}];current.macroState.userName='用户新称呼保留';return current},{source:'configuration.edit'})
 const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
 const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href),{z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
 const ctx=new Context(),projections=new SessionProjectionRegistry(ctx)
 projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(state,event)=>event.type==='turn/end'?{lastTurn:event.data.turn}:state})
 const syncFrames=[];const faults={broadcast:null};let rollbackSync
 installRollbackSync({get:()=>({controlState:{ctx:{sessionProjections:projections},jobsFor:()=>[],broadcast:frame=>{if(faults.broadcast)throw faults.broadcast;syncFrames.push(frame)}},history:{assistantStreams:new Map()}}),provide:(_key,value)=>{rollbackSync=value}})
 const persistencePort={replaceRegeneratedTail:async(header,keep,expected,output)=>{const meta=dbs.get(header.id).replaceRegeneratedTail(keep,expected,output);rewindRollbackHandles(handles,header.id,meta.eventCount);return meta},bindRollbackArchive:async(id,file)=>dbs.get(id).bindRollbackArchive(file),setRollbackPending:async(id,value)=>dbs.get(id).setRollbackPending(value),drainOpenHandles:async()=>{},truncateEvents:async(header,boundary)=>{const meta=dbs.get(header.id).truncateFrom(boundary);rewindRollbackHandles(handles,header.id,meta.eventCount);return meta}}
 let followupTask
 const agent=agents.get(SESSION_ID)
 agent.followup=message=>{agent.phase.kind='running';followupTask=commitTurn(agent.phase.lastTurn+1,'重生成'+(agent.phase.lastTurn+1),message.source).finally(()=>{agent.phase.kind='idle'})}
 agent.whenIdle=async()=>{await followupTask}
 const sessions={get:id=>agents.get(id),getSession:id=>agents.get(id)?.session,flush}
 const chats={read,readState:read,forSession:read,readCard:async()=>({name:'原创卡'}),readRevision:store.readRevision,write:chatPersistence.write,update,readSlice:store.readSlice,rollbackArchivePath:store.rollbackArchivePath,readRollbackWorldbook:store.readRollbackWorldbook,readRollbackOperationSnapshot:store.readRollbackOperationSnapshot}
 const roundHistory=history.createRoundHistory({chats,sessions,scripts:{read:async()=>undefined,continuity:{}},timeline:storyTimeline,queueSettlement:async()=>{},cancelSettlement:async()=>{},present:async value=>value,
  ...(physical?{persistenceProvider:()=>persistencePort,projectionsProvider:()=>projections,projectionCacheProvider:()=>({write:async()=>{}}),tokenMeterProvider:()=>({states:new WeakMap()}),rollbackSyncProvider:()=>rollbackSync,quiesceRollback:async()=>{},cleanupRollbackSides:async()=>{}}:{}),
  sessionPatch:{status:'ready',serverReady:true,replacementAllowed:()=>true,blockReason:()=>'',restoreStoredSession:stored=>Session.fromRestore(stored.header.id,structuredClone(stored.events),structuredClone(stored.header),stored.inheritedEventCount,'detached')}})
 const args=()=>({chat:undefined,readChat:read,updateChat:update,chats,sessions,persistence:persistencePort,availability:rollbackAvailability,services:{projections,projectionCache:{write:async()=>{}},tokenMeterProvider:()=>({states:new WeakMap()}),rollbackSyncProvider:()=>rollbackSync},quiesce:async()=>{},sideCleanup:async()=>{},view:async value=>({turn:value.messages.at(-1)?.turn??0}),readCard:async()=>({})})
 const assertRolled=async()=>{
  const after=await read()
  assert.deepEqual(after.messages,base.messages);assert.deepEqual(after.variables,base.variables);assert.deepEqual(after.openingWorldbookSnapshot,base.openingWorldbookSnapshot)
  assert.deepEqual(after.guides,[{text:'用户新配置保留'}]);assert.equal(after.macroState.userName,'用户新称呼保留')
  assert.deepEqual(session.snapshotEvents(),prefix);assert.deepEqual(background.snapshotEvents(),workerPrefix)
  assert.equal(mainDb.cursor(),prefix.length);assert.equal(workerDb.cursor(),workerPrefix.length)
  assert.equal(after.timeline.checkpoints.some(cp=>cp.turn>=53),false);assert.equal(Object.values(after.timeline.operations).some(op=>op.turn>=53),false)
  assert.equal(Object.keys(after.regeneratedDshTurns||{}).length,0);assert.equal(after.regenRecovery,undefined);assert.equal(after.regenInProgress,undefined)
  const db=new DatabaseSync(store.rollbackArchivePath(CHAT_ID))
  try{assert.equal(db.prepare("SELECT count(*) n FROM archive_messages WHERE json_extract(message_json,'$.turn')>=53").get().n,0)}finally{db.close()}
  assert.equal(rollbackBarrier.has(SESSION_ID),false);assert.equal(rollbackSchedulingBarrier.has(SESSION_ID),false)
  assert.equal(syncFrames.length,physical?4:1);assert.equal(syncFrames.at(-1).value.sessions.length,2)
 }
 return {root,read,update,session,background,mainDb,workerDb,roundHistory,args,commitTurn,assertRolled,agent,handles,syncFrames,prefix,workerPrefix,faults,
  persistencePort,chats,sessions,projections,storyTimeline,Session,createHistory:history.createRoundHistory,persistence,rollbackSync:()=>rollbackSync,
  cleanup:async()=>{for(const id of agents.keys()){rollbackBarrier.delete(id);rollbackSchedulingBarrier.delete(id)}store.dispose();mainDb.close();workerDb.close();await ctx.fiber.dispose();assert.ok(path.basename(root).startsWith('tavern-regen-rollback-'));rmSync(root,{recursive:true,force:true})}}
}

for(const pause of ['readCard','native-adoption','generation','prepare'])test('审查修复R2真实作者：回退取消等待 '+pause+' 不复活正文或晚结算',async()=>{
 const f=await fixture({physical:true})
 let resume,entered
 const gate=new Promise(r=>resume=r),ready=new Promise(r=>entered=r)
 let followups=0,settlements=0,reads=0
 const followup=f.agent.followup;f.agent.followup=message=>{followups++;return followup(message)}
 if(pause==='generation'){const idle=f.agent.whenIdle;f.agent.whenIdle=async()=>{await idle();entered();await gate}}
 const persistencePort={...f.persistencePort,replaceRegeneratedTail:async(...args)=>{if(pause==='native-adoption'){entered();await gate}return f.persistencePort.replaceRegeneratedTail(...args)}}
 const chats={...f.chats,readCard:async(...args)=>{if(pause==='readCard' && ++reads===1){entered();await gate}return f.chats.readCard(...args)}}
 const history=f.createHistory({chats,sessions:f.sessions,scripts:{read:async()=>undefined,continuity:{}},timeline:f.storyTimeline,queueSettlement:async()=>{settlements++},cancelSettlement:async()=>{},present:async value=>value,
  persistenceProvider:()=>persistencePort,projectionsProvider:()=>f.projections,projectionCacheProvider:()=>({write:async()=>{}}),tokenMeterProvider:()=>({states:new WeakMap()}),rollbackSyncProvider:f.rollbackSync,quiesceRollback:async()=>{if(pause==='prepare' && ++reads===1){entered();await gate}},cleanupRollbackSides:async()=>{},
  sessionPatch:{replacementAllowed:()=>true,blockReason:()=>'',restoreStoredSession:stored=>f.Session.fromRestore(stored.header.id,structuredClone(stored.events),structuredClone(stored.header),stored.inheritedEventCount,'detached')}})
 try{
  const generation=history.regenerate(CHAT_ID,'本轮取消验证'),observed=generation.then(()=>({ok:true}),error=>({error}))
  await ready
  let finished=false
  const {latestSendTarget}=await import('../lib/latest-send.js')
  const signed=latestSendTarget(await f.read(),{events:f.session.snapshotEvents()});assert.equal(signed.turn,53,'临时生成不可签成新的用户轮')
  const rollback=history.rollback(SESSION_ID,CHAT_ID,signed).then(result=>{finished=true;return result})
  await new Promise(r=>setImmediate(r));assert.equal(finished,false,'旧Promise没结束不能先报告回退完成')
  resume();const generated=await observed,done=await rollback
  assert.match(generated.error?.message || '',/取消/);assert.equal(done.rolledBack.hiddenTurn,53)
  assert.equal(followups,['readCard','prepare'].includes(pause)?0:1);assert.equal(settlements,0,'取消后不得继续排新结算')
  assert.deepEqual(f.session.snapshotEvents(),f.prefix);assert.deepEqual(f.background.snapshotEvents(),f.workerPrefix)
  assert.equal(f.mainDb.cursor(),f.prefix.length);assert.equal(f.workerDb.cursor(),f.workerPrefix.length)
  const after=await f.read();assert.equal(after.messages.at(-1).turn,52);assert.equal(after.regenRecovery,undefined);assert.equal(after.regenInProgress,undefined)
  assert.equal(rollbackBarrier.has(SESSION_ID),false);assert.equal(rollbackSchedulingBarrier.has(SESSION_ID),false)
 }finally{resume();await f.cleanup()}
})

test('审查修复R2真实重放：取消等读卡续体结束，不重发已经撤回的输入',async()=>{
 const f=await fixture({physical:true})
 let resume,entered,followups=0
 const gate=new Promise(r=>resume=r),ready=new Promise(r=>entered=r)
 try{
  const kept=structuredClone(f.session.snapshotEvents()),worker=structuredClone(f.background.snapshotEvents())
  f.session.append('turn/start',{turn:54});f.session.append('user/message',{id:'failed-input-54',role:'user',content:[{type:'text',text:'本轮失败输入'}],source:{kind:'user'}},{surfaceOp:'append'});f.session.append('turn/end',{turn:54,reason:{kind:'error',error:{message:'确定性失败'}}});await f.sessions.flush(f.session);f.agent.phase.lastTurn=54
  const history=f.createHistory({chats:{...f.chats,readCard:async()=>{entered();await gate;return {name:'原创卡'}}},sessions:f.sessions,scripts:{read:async()=>undefined,continuity:{}},timeline:f.storyTimeline,queueSettlement:async()=>{},cancelSettlement:async()=>{},present:async value=>value,
   persistenceProvider:()=>f.persistencePort,projectionsProvider:()=>f.projections,projectionCacheProvider:()=>({write:async()=>{}}),tokenMeterProvider:()=>({states:new WeakMap()}),rollbackSyncProvider:f.rollbackSync,quiesceRollback:async()=>{},cleanupRollbackSides:async()=>{},sessionPatch:{replacementAllowed:()=>true,blockReason:()=>'',restoreStoredSession:stored=>f.Session.fromRestore(stored.header.id,structuredClone(stored.events),structuredClone(stored.header),stored.inheritedEventCount,'detached')}})
  f.agent.followup=()=>{followups++}
  const replay=history.replayFailed(CHAT_ID),observed=replay.then(()=>null,error=>error);await ready
  let finished=false;const rollback=history.rollback(SESSION_ID,CHAT_ID,54).then(result=>{finished=true;return result})
  await new Promise(r=>setImmediate(r));assert.equal(finished,false)
  resume();assert.match((await observed)?.message || '',/取消/);const result=await rollback
  assert.equal(result.rolledBack.hiddenTurn,54);assert.equal(followups,0)
  assert.deepEqual(f.session.snapshotEvents(),kept);assert.deepEqual(f.background.snapshotEvents(),worker);assert.equal((await f.read()).messages.at(-1).turn,53)
 }finally{resume();await f.cleanup()}
})

test('R3 重生成×物理回退：单次 regen 保留原轮基准，cleanRollback 按原轮删净替换',async()=>{
 const f=await fixture()
 try{
  const original=(await f.read()).timeline.checkpoints.find(cp=>cp.turn===53)
  assert.ok(original.businessBefore.worldbookRef,'真实SQL必须去重并保留原书引用')
  const result=await f.roundHistory.regenerate(CHAT_ID,'补充要求')
  assert.equal(result.adopted.hiddenTurn,53);assert.equal(result.adopted.syntheticTurn,54)
  const regenerated=await f.read()
  assert.deepEqual(regenerated.timeline.checkpoints.map(cp=>cp.turn),[53]);assert.deepEqual(regenerated.timeline.checkpoints[0],original)
  assert.equal(regenerated.regeneratedDshTurns['53'],54)
  assert.equal(regenerated.rollbackSessionCuts['53'][WORKER_ID],0,'原轮后台最早切点不能被重生成覆盖')
  const done=await cleanRollback({...f.args(),chat:regenerated,requestedTurn:53})
  assert.equal(done.rolledBack.hiddenTurn,53);await f.assertRolled()
 }finally{await f.cleanup()}
})

test('R3 自有请求上下文及前轮frame退役仍可回退；异档上下文拒绝且两库零删',async()=>{
 const f=await fixture({withContext:true})
 try{
  for(const n of [1,2])await f.roundHistory.regenerate(CHAT_ID,'自有上下文'+n)
  const events=f.session.snapshotEvents()
  assert.ok(events.some(event=>event.type==='user/message'&&event.data?.source?.form==='foreground-frame'&&event.data?.source?.trace?.chatId===CHAT_ID))
  assert.ok(events.some(event=>event.type==='user/message'&&event.data?.source?.form==='foreground-frame'&&event.surfaceOp?.op==='replace'),'真实作者frame退役必须经过引用替换')
  await cleanRollback({...f.args(),chat:await f.read(),requestedTurn:53});await f.assertRolled()
 }finally{await f.cleanup()}
 const other=await fixture({withContext:true})
 try{
  await other.roundHistory.regenerate(CHAT_ID,'拒绝准备')
  const start=other.session.seq
  other.session.append('user/message',{id:'foreign-context',role:'user',content:[{type:'text',text:'异档上下文'}],source:{kind:'plugin',plugin:'dsh-tavern',form:'foreground-frame',trace:{chatId:'foreign-chat'}}},{surfaceOp:'append'})
  other.mainDb.appendBatch(other.session.snapshotEvents(start),start)
  const chat=await other.read(),events=structuredClone(other.session.snapshotEvents()),main=other.mainDb.cursor(),worker=other.workerDb.cursor()
  await assert.rejects(cleanRollback({...other.args(),chat,requestedTurn:53}),/独立(?:玩家)?输入/)
  assert.deepEqual(await other.read(),chat);assert.deepEqual(other.session.snapshotEvents(),events)
  assert.equal(other.mainDb.cursor(),main);assert.equal(other.workerDb.cursor(),worker)
 }finally{await other.cleanup()}
})

test('R3 连续两次 regen 后回退仍删净全部合成替换；后继普通输入必须拒且 SQL/eventCount 不变',async()=>{
 const f=await fixture()
 try{
  const original=(await f.read()).timeline.checkpoints.find(cp=>cp.turn===53)
  for(const n of [1,2])assert.equal((await f.roundHistory.regenerate(CHAT_ID,'第'+n+'次')).adopted.hiddenTurn,53)
  const regenerated=await f.read()
  assert.deepEqual(regenerated.timeline.checkpoints,[original]);assert.deepEqual(regenerated.regeneratedDshTurns,{'53':55})
  assert.deepEqual(f.session.snapshotEvents().filter(e=>e.type==='turn/start'&&e.data.turn>=54).map(e=>e.data.turn),[54,55])
  const done=await cleanRollback({...f.args(),chat:regenerated,requestedTurn:53})
  assert.equal(done.rolledBack.hiddenTurn,53);await f.assertRolled()
 }finally{await f.cleanup()}
 // 独立同形局先真正提交后继普通轮，再拒绝旧重生成目标。不能用写入失败冒充回退负例。
 const successor=await fixture()
 try{
  await successor.roundHistory.regenerate(CHAT_ID,'前置重生成')
  await successor.commitTurn(55,'后继普通输入')
  const before=await successor.read(),events=structuredClone(successor.session.snapshotEvents()),mainCount=successor.mainDb.cursor(),workerCount=successor.workerDb.cursor()
  await assert.rejects(cleanRollback({...successor.args(),chat:before,requestedTurn:53}),/目标已经变化|会话已推进|独立输入/)
  assert.deepEqual(await successor.read(),before);assert.deepEqual(successor.session.snapshotEvents(),events)
  assert.equal(successor.mainDb.cursor(),mainCount);assert.equal(successor.workerDb.cursor(),workerCount)
 }finally{await successor.cleanup()}
})
