// 任意形态最新轮：真实宿主Session、Chat/Session SQLite、作者纯修复；无真实用户资料。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {SqliteSessionDb} from '../store.js'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {cleanRollback} from '../lib/clean-rollback.js'
import {captureRollbackBusinessState} from '../lib/rollback-business-state.js'
import {configureRollbackCleanup} from '../lib/rollback-cleanup.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {installSendAcceptance,captureAcceptedSend} from '../lib/send-acceptance.js'
import {installRollbackSync} from '../lib/rollback-sync.js'
import {latestSendTarget} from '../lib/latest-send.js'
const AUTHOR=new URL('../../../tmp/upstream-79d3414-adapt-20261017/tavern-plugin/lib/domain/',import.meta.url)
const {repairNativeSurface,recordNativeSurfaceRepair}=await import(new URL('native-surface-repair.js',AUTHOR).href)
const {diffJson,applyJsonChangesShared}=await import(new URL('json-mutation.js',AUTHOR).href)
const {copyJsonTree}=await import(new URL('copy-json-tree.js',AUTHOR).href)
const helpers={copyJsonTree,diffJson,applyJsonChangesShared,projectSceneImageState:v=>v,projectChatSessionState:v=>v,projectDisplayRuntimeState:v=>v,projectChatBackgroundConfig:v=>v,projectSettlementCheckpoint:v=>v}
configureRollbackCleanup({sessionEvents:s=>s.snapshotEvents()})
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
async function scenario(shape,{drift=false,failRepair=false,failCut=false,failRepairFlush=false,fragmentAnchor=false,fragmentInput=false,regenerated=false,afterCheck}={}) {
 const root=mkdtempSync(path.join(os.tmpdir(),'native-repair-clean-'))
 let db,store,ctx,disposeCapture
 try {
  const raw=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
  const file=path.join(root,'session.mjs');writeFileSync(file,raw,'utf8')
  const {Session}=await import(pathToFileURL(file).href)
  const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
  const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href)
  const {z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
  ctx=new Context();const projections=new SessionProjectionRegistry(ctx)
  projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(s,e)=>e.type==='turn/end'?{lastTurn:e.data.turn}:s})
  const session=Session.create('test-native-repair'),sessionId=session.header.id
  const user=(turn,text)=>session.append('user/message',{id:'u'+turn,role:'user',content:[{type:'text',text}],source:{kind:'user'}},{surfaceOp:'append'})
  const reply=(turn,text)=>session.append('assistant/message',{turn,step:1,message:{id:'a'+turn,role:'assistant',content:[{type:'text',text}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
  session.append('turn/start',{turn:11});user(11,'上一轮输入');reply(11,drift?'投影旧文':'保留正文');session.append('turn/end',{turn:11,reason:{kind:'completed'}})
  const prefix=structuredClone(session.snapshotEvents()),boundary=session.seq-1
  db=new SqliteSessionDb(path.join(root,'session.db'));db.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
  store=createChatSqliteStore({dataRoot:root,helpers})
  const before={id:'test-native-chat',_storageRevision:1,sessionId,mode:'story',messages:[{role:'user',turn:11,text:'上一轮输入'},{role:'assistant',turn:11,text:'保留正文'}],variables:{hp:90},timeline:{schemaVersion:1,branchId:'branch',revision:1,operations:{},checkpoints:[],participants:{}}}
  await store.update(before.id,()=>before)
  const baseline=captureRollbackBusinessState(await store.read(before.id))
  session.append('turn/start',{turn:12});user(12,'只删本轮')
  if(!['error','unfinished','truncated','unknown','no-start','native-fragment'].includes(shape))reply(12,'待删正文')
  if(!['unfinished','truncated','unknown','no-start','native-fragment'].includes(shape))session.append('turn/end',{turn:12,reason:{kind:shape==='error'?'error':shape==='aborted'?'aborted':'completed'}})
  if(shape==='no-start') {const at=session.log.findIndex(e=>e.type==='turn/start' && e.data.turn===12);session.log.splice(at);session.eventsSnapshot=undefined;user(12,'缺起点仍须清理')}
  if(shape==='native-fragment') {session.log.splice(prefix.length);session.eventsSnapshot=undefined;if(fragmentInput)user(12,'碎片前的本轮输入');session.append('turn/end',{turn:12,reason:{kind:'aborted'}})}
  if(regenerated) {session.append('turn/start',{turn:13});session.append('user/message',{id:'regen13',role:'user',content:[{type:'text',text:'替换本轮'}],source:{kind:'plugin',plugin:'dsh-tavern-regen'}},{surfaceOp:'append'});reply(13,'重新生成正文');session.append('turn/end',{turn:13,reason:{kind:'completed'}})}
  db.appendBatch(session.snapshotEvents().slice(prefix.length),prefix.length)
  const hasBaseline=!['unknown','no-start','native-fragment'].includes(shape)
  const targetRows=[{role:'user',turn:12,text:'只删本轮'},...(shape==='completed'?[{role:'assistant',turn:12,text:'待删正文'}]:[])]
  await store.update(before.id,now=>({...now,_storageRevision:now._storageRevision+1,messages:shape==='native-fragment'?before.messages:[...before.messages,...targetRows],variables:{hp:3},timeline:{...now.timeline,operations:shape==='native-fragment'?{}:{body:{kind:'body',turn:12,status:shape==='unknown'?'unrecognized-status':shape,nativeStartSeq:prefix.length,...(hasBaseline?{businessBefore:baseline}:{})}}}}))
  if(fragmentAnchor)await store.update(before.id,now=>({...now,_storageRevision:now._storageRevision+1,timeline:{...now.timeline,operations:{body:{kind:'body',turn:12,nativeAnchor:{input:1},nativeStartSeq:prefix.length}}}}))
  if(regenerated)await store.update(before.id,now=>({...now,_storageRevision:now._storageRevision+1,regeneratedDshTurns:{12:13}}))
  const read=()=>store.read(before.id)
  const update=(_id,fn,meta)=>store.update(before.id,async current=>{const next=await fn(current);if(next)next._storageRevision=current._storageRevision+1;return next},meta)
  const agent={session,phase:{kind:'idle',lastTurn:12},runtimeContext:{},inbox:{nextTurn:[],nextStep:[]}}
  const handle={id:sessionId,access:'write',state:{cursor:session.seq,primed:{}},observedLength:session.seq},handles=new Set([handle])
  let repairCalls=0,cutCalls=0,sideCalls=0,flushOffset=session.seq,repairFailed=failRepair,cutFailed=failCut
  let flushFaults=failRepairFlush?2:0
  const frames=[],cacheWatermarks=[]
  let rollbackSync
  installRollbackSync({get:()=>({controlState:{ctx:{sessionProjections:projections},jobsFor:()=>[],broadcast:frame=>frames.push(frame)},history:{assistantStreams:new Map()}}),provide:(_key,value)=>{rollbackSync=value}})
  const persistence={bindRollbackArchive:async(_id,p)=>db.bindRollbackArchive(p),setRollbackPending:async(_id,v)=>db.setRollbackPending(v),truncateEvents:async(header,seq)=>{cutCalls++;if(cutFailed){cutFailed=false;throw Error('单次真实清理故障')}const result=db.truncateFrom(seq);rewindRollbackHandles(handles,header.id,result.eventCount);flushOffset=result.eventCount;return result}}
  const flush=async()=>{const events=session.snapshotEvents();if(events.length>flushOffset){if(repairCalls && flushFaults>0){flushFaults--;throw Error('修复事件落库故障')}db.appendBatch(events.slice(flushOffset),flushOffset);flushOffset=events.length}}
  const repairNative=async()=>{
   repairCalls++
   assert.equal((await read()).rollbackPending,undefined,'作者修复必须在物理pending完成后')
   assert.equal(rollbackBarrier.has(sessionId),false,'物理写屏障必须先解除')
   assert.equal(rollbackSchedulingBarrier.has(sessionId),true,'修复期间仍暂停新发送')
   if(repairFailed){repairFailed=false;throw Error('单次自愈故障')}
   const current=await read(),result=repairNativeSurface(session,current,{repairId:'test-repair-'+repairCalls})
   if(result.applied)await flush()
   await update(before.id,now=>{recordNativeSurfaceRepair(now,current,result.anchors);return now},{source:'native-repair'})
   return result
  }
  // 作者写出的source.repair不能经过新发送捕获。
  let captured=0;disposeCapture=installSendAcceptance(Session,(self,type,data)=>{if(type==='user/message' && data.source?.repair)captured++;return captureAcceptedSend(self,type,data)})
  // 生产捕获先过滤repair，不会查询真实环境映射；下方另以真实本地映射检查SQL操作不新增。
  const args={chat:await read(),requestedTurn:{kind:'rollback',turn:12,revision:-100,branchId:'旧页面',operationId:'未知操作',nativeAnchor:{input:-1}},readChat:read,updateChat:update,chats:{rollbackArchivePath:store.rollbackArchivePath,readRollbackWorldbook:store.readRollbackWorldbook,readRollbackOperationSnapshot:store.readRollbackOperationSnapshot},sessions:{get:()=>agent,getSession:()=>session,flush},persistence,services:{projections,projectionCache:{write:async subject=>{cacheWatermarks.push(projections.snapshot(subject).asOfSeq)}},tokenMeterProvider:()=>({states:new WeakMap()}),rollbackSyncProvider:()=>rollbackSync},quiesce:async()=>{},sideCleanup:async()=>{sideCalls++},view:async current=>({messages:current.messages}),readCard:async()=>({}),repairNative}
  if(failCut) {await assert.rejects(cleanRollback(args),/真实清理故障/);assert.ok((await read()).rollbackPending,'实际失败保留同一物理边界');await cleanRollback({...args,chat:await read()})}
  else if(failRepairFlush) {
   await assert.rejects(cleanRollback(args),/修复事件落库故障/)
   const failed=await read()
   assert.equal(failed.rollbackPending,undefined,'物理阶段已经完成')
   assert.ok(failed.rollbackCompletion,'保留完成记录以便只重试自愈')
   assert.equal(failed.nativeSync.status,'stale')
   assert.equal(frames.length,0,'修复事件没有落库时不能发送成功同步')
   assert.equal(cutCalls,1)
  }
  else await cleanRollback(args)
  let after=await read()
  assert.deepEqual(after.messages.map(({nativeAnchor,...row})=>row),before.messages,'任何形态都只清最新轮，上一轮正文不变')
  assert.equal(after.rollbackPending,undefined)
  assert.equal(after.timeline.operations.body,undefined)
  assert.deepEqual(db.readAll().events.slice(0,prefix.length),prefix,'物理保留前缀逐事件不变')
  assert.ok(!db.readAll().events.some(e=>Number(e.data?.turn)===12),'待删轮原生事件必须实际消失')
  if(regenerated)assert.ok(!db.readAll().events.some(e=>Number(e.data?.turn)===13),'重新生成派生原生轮须随同一业务发送删除')
  if(hasBaseline)assert.deepEqual(after.variables,before.variables,'已有真实前像须恢复')
  if(failRepair){assert.equal(after.nativeSync.status,'stale');assert.equal(cutCalls,1)}
  const beforeRetry=structuredClone(db.readAll().events)
  const cutsBeforeRetry=cutCalls
  await cleanRollback({...args,chat:after})
  after=await read()
  assert.equal(cutCalls,cutsBeforeRetry,'同一已完成清理重试不能再删上一轮')
  assert.deepEqual(after.messages.map(({nativeAnchor,...row})=>row),before.messages)
  assert.equal(after.nativeSync,undefined,'作者修复完成应清除stale')
  assert.equal(after.rollbackCompletion.cuts[0].boundarySeq,session.seq-1,'完成记录采用修复后的实际尾')
  assert.equal(after.rollbackCompletion.revision,after._storageRevision,'完成版本采用作者修复后的真实版本')
  assert.equal(frames.at(-1).value.revision,after._storageRevision)
  assert.equal(frames.at(-1).seq,session.seq-1,'真实同步采用修复后的原生尾')
  assert.equal(cacheWatermarks.at(-1),session.seq-1,'持久投影缓存刷新到修复后水位')
  if(drift){assert.ok(captured>0,'必须真正调用作者修复写入');const text=session.surface.nodes.map(seq=>session.snapshotEvents()[seq]).flatMap(e=>e?.data?.message?.content || e?.data?.content || []).map(b=>b.text || '').join('');assert.match(text,/保留正文/);assert.doesNotMatch(text,/只删本轮|投影旧文/)}
  else if(!failRepair)assert.deepEqual(db.readAll().events,beforeRetry,'完整保留前缀不需修复时不追加')
  if(afterCheck)await afterCheck({args,session,db,store,read,update,agent,prefix,before,flush,reply,user,boundary,counts:()=>({repairCalls,cutCalls,sideCalls})})
  return {repairCalls,cutCalls,sideCalls,boundary}
 }finally{disposeCapture?.();rollbackBarrier.clear();rollbackSchedulingBarrier.clear();store?.dispose();db?.close();await ctx?.fiber.dispose();rmSync(root,{recursive:true,force:true})}
}
for(const shape of ['completed','error','aborted','unfinished','truncated','unknown','no-start','native-fragment'])test('最新轮物理清理与作者自愈：'+shape,()=>scenario(shape))
test('碎片范围：失效旧输入锚点不误删前轮且最新碎片仍清除',()=>scenario('native-fragment',{fragmentAnchor:true}))
test('碎片范围：旧锚点失效时仍删掉本轮实际输入及碎片',()=>scenario('native-fragment',{fragmentAnchor:true,fragmentInput:true}))
test('重新生成范围：派生原生轮随同一次最新业务发送物理清除',()=>scenario('completed',{regenerated:true}))
test('重新生成范围：独立用户输入仍在尾部时不扩大删除',()=>scenario('completed',{afterCheck:async f=>{
 const at=f.session.seq
 f.session.append('turn/start',{turn:12});f.user(12,'原业务发送');f.session.append('turn/end',{turn:12,reason:{kind:'completed'}})
 f.session.append('turn/start',{turn:13});f.session.append('user/message',{id:'regen13',source:{kind:'plugin',plugin:'dsh-tavern-regen'},role:'user',content:[{type:'text',text:'重新生成'}]},{surfaceOp:'append'});f.session.append('turn/end',{turn:13,reason:{kind:'completed'}})
 f.user(14,'另一条独立输入');await f.flush()
 await f.update(f.args.chat.id,current=>{current.regeneratedDshTurns={12:13};return current})
 const chat=await f.read(),events=structuredClone(f.db.readAll().events),cuts=f.counts().cutCalls
 await assert.rejects(cleanRollback({...f.args,chat,requestedTurn:latestSendTarget(chat,{events:f.session.snapshotEvents()})}),/独立输入/)
 assert.deepEqual(f.db.readAll().events,events);assert.deepEqual(await f.read(),chat)
 assert.equal(f.counts().cutCalls,cuts);assert.ok(f.session.seq>at)
}}))
test('作者自愈：保留正文漂移由作者重建且完成回执采用修复后状态',()=>scenario('completed',{drift:true}))
test('作者自愈：修复异常记录stale，清理调用不伪造同步成功',()=>scenario('unknown',{drift:true,failRepair:true}))
test('作者自愈：修复落库失败不发成功帧，重试补落库而不再次删尾',()=>scenario('completed',{drift:true,failRepairFlush:true}))
test('最新轮清理：真实删库失败重试沿同一边界完成',()=>scenario('unfinished',{failCut:true}))

// 不改对象资格，只验证最新轮范围和同次操作重试。
test('自愈后连续回退：上一轮成为最新轮才由用户再次清理',()=>scenario('completed',{drift:true,afterCheck:async f=>{
 const target=latestSendTarget(await f.read(),{events:f.session.snapshotEvents()})
 assert.equal(target.turn,11)
 const result=await cleanRollback({...f.args,chat:await f.read(),requestedTurn:target})
 assert.equal(result.rolledBack.hiddenTurn,11)
 assert.equal((await f.read()).messages.length,0)
 assert.equal(f.db.readAll().events.length,0,'连续回退不得留下前次自愈复制的旧轮输入或正文')
}}))
test('重试范围：复用同名operation的新发送仍按当前请求清理',()=>scenario('completed',{afterCheck:async f=>{
 const prior=await f.read(),baseline=captureRollbackBusinessState(prior),cuts=f.counts().cutCalls
 f.session.append('turn/start',{turn:12});f.user(12,'复用同名操作的新发送');f.reply(12,'新正文');f.session.append('turn/end',{turn:12,reason:{kind:'completed'}});await f.flush()
 await f.update(prior.id,current=>{current.messages.push({role:'user',turn:12,text:'复用同名操作的新发送'},{role:'assistant',turn:12,text:'新正文'});current.timeline.operations[f.args.requestedTurn.operationId]={kind:'body',turn:12,status:'completed',businessBefore:baseline};return current})
 const current=await f.read(),target=latestSendTarget(current,{events:f.session.snapshotEvents()})
 assert.equal(target.operationId,f.args.requestedTurn.operationId,'操作键确实复用')
 const result=await cleanRollback({...f.args,chat:current,requestedTurn:target})
 assert.equal(result.rolledBack.hiddenTurn,12);assert.notEqual(result.rolledBack.alreadyClean,true)
 assert.equal(f.counts().cutCalls,cuts+1,'新发送必须实际截断一次')
 assert.deepEqual(f.db.readAll().events,f.prefix,'仍只保留前轮原生前缀')
}}))
test('已完成旧请求重传：同轮号已开始新发送时零取消零截断',()=>scenario('completed',{afterCheck:async f=>{
 const done=await f.read(),old={...f.args.requestedTurn,rollbackId:done.rollbackCompletion.id}
 f.session.append('turn/start',{turn:12});f.user(12,'同轮号新发送');await f.flush()
 const current=await f.read(),baseline=captureRollbackBusinessState(current)
 await f.update(current.id,value=>{value.messages.push({role:'user',turn:12,text:'同轮号新发送'});value.timeline.operations.newBody={kind:'body',turn:12,status:'running',businessBefore:baseline};return value})
 let cancels=0
 f.agent.phase={kind:'running',lastTurn:11};f.agent.cancel=()=>{cancels++};f.agent.whenIdle=async()=>{}
 const events=structuredClone(f.db.readAll().events),calls=f.counts()
 let pauses=0,discards=0
 const retry=await cleanRollback({...f.args,chat:await f.read(),requestedTurn:old,persistence:{...f.args.persistence,pauseRollbackBuffers:()=>{pauses++;return ()=>{}},discardRollbackBuffers:async()=>{discards++}}})
 assert.equal(pauses,0);assert.equal(discards,0,'旧RPC重传不触碰新发送缓冲')
 assert.equal(retry.rolledBack.alreadyClean,true);assert.equal(cancels,0);assert.equal(f.counts().cutCalls,calls.cutCalls)
 assert.deepEqual(f.db.readAll().events,events);assert.equal((await f.read()).messages.at(-1).text,'同轮号新发送')
}}))
