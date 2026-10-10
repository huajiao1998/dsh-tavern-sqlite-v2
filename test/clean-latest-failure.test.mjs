// 失败清理协议（failureTarget）：只清当前**最新**失败尾（Math.max），历史失败一律不动；
// 普通回退（不传参）保持原语义；不降级、不冒认、漂移拒绝、无基准拒清、已清理无写。
// 夹具＝真实 Session（projection-baseline-1001 的 rc.2 Session）+ SqliteSessionDb + chat sqlite store；不读用户档、不请求模型。
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
import {installRollbackSync} from '../lib/rollback-sync.js'
import {configureRollbackCleanup} from '../lib/rollback-cleanup.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'

configureRollbackCleanup({sessionEvents:s=>s.snapshotEvents()})
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
const helpers={copyJsonTree:value=>value===undefined?undefined:structuredClone(value),applyJsonChangesShared:value=>value}
for(const key of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[key]=value=>value
helpers.diffJson=(old,next)=>{
 const changes=[]
 for(const key of new Set([...Object.keys(old),...Object.keys(next)]))if(key!=='messages'&&JSON.stringify(old[key])!==JSON.stringify(next[key]))changes.push({op:'set',path:[key],value:next[key]})
 if(next.messages.length<old.messages.length)changes.push({op:'splice',path:['messages'],index:next.messages.length,deleteCount:old.messages.length-next.messages.length,items:[]})
 else for(let i=0;i<next.messages.length;i++)if(JSON.stringify(old.messages[i])!==JSON.stringify(next.messages[i]))changes.push({op:'set',path:['messages',i],value:next.messages[i]})
 return changes
}
const TARGET_TURN=24
const OLD_FAILED_TURNS=[...Array(21)].map((_,index)=>index+2)   // 历史失败：2..22（21 轮）
const FAILED_TURNS=[...OLD_FAILED_TURNS,TARGET_TURN]            // 当前失败集合：21 历史 + 最新 24
const COMPLETED_TURNS=[1,23]
function stateOf(operations){return Object.fromEntries(Object.entries(operations).map(([id,op])=>{const {businessBefore,rowBefore,beforeParticipants,...state}=op;return [id,state]}))}
function rowsUpTo(turn){
 const rows=[]
 for(const n of [...COMPLETED_TURNS,...OLD_FAILED_TURNS].sort((left,right)=>left-right)){
  if(n>turn)continue
  rows.push({role:'user',turn:n,text:'输入'+n})
  if(COMPLETED_TURNS.includes(n))rows.push({role:'assistant',turn:n,text:'轮'+n,swipeId:0,swipes:['轮'+n],variables:[{hp:n}]})
 }
 return rows
}
async function fixture(options={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-clean-latest-'))
 const raw=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 const file=path.join(root,'session.mjs');writeFileSync(file,raw,'utf8');const {Session}=await import(pathToFileURL(file).href)
 const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
 const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href),{z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
 const ctx=new Context(),projections=new SessionProjectionRegistry(ctx)
 projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(state,e)=>e.type==='turn/end'?{lastTurn:e.data.turn}:state})
 const session=Session.create('fixture-session')
 function turn(n,text,failed){
  session.append('turn/start',{turn:n})
  session.append('user/message',{id:'u'+n,role:'user',content:[{type:'text',text:'输入'+text}],source:{kind:'user'}},{surfaceOp:'append'})
  if(!failed)session.append('assistant/message',{turn:n,step:1,message:{id:'a'+n,role:'assistant',content:[{type:'text',text}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
  session.append('turn/end',{turn:n,reason:{kind:failed?'error':'completed'}})
 }
 for(const n of [...COMPLETED_TURNS,...OLD_FAILED_TURNS].sort((left,right)=>left-right))turn(n,'轮'+n,OLD_FAILED_TURNS.includes(n))
 const boundary24=session.seq
 const mainDb=new SqliteSessionDb(path.join(root,'session.db'))
 mainDb.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
 turn(TARGET_TURN,'轮'+TARGET_TURN,options.nativeFailedTarget!==false)
 mainDb.appendBatch(session.snapshotEvents(boundary24),boundary24)
 const oldOps=Object.fromEntries(OLD_FAILED_TURNS.map(n=>['op'+n,{kind:'body',turn:n,status:'failed',businessBefore:{version:1,fields:{variables:{hp:1}},messageCount:1,participants:{},operationIds:[],operationStates:{}}}]))
 const messagesBefore24=rowsUpTo(TARGET_TURN-1)
 const baseline24={version:1,turn:TARGET_TURN,fields:{variables:{hp:23},lastWorldBookRecall:{turn:23},contextCompaction:{warning:'轮23'},presentationWarnings:[],hiddenDshErrorTurns:OLD_FAILED_TURNS,rollbackSessionCuts:{},taskMailbox:{}},messageCount:messagesBefore24.length,participants:{},operationIds:Object.keys(oldOps),operationStates:stateOf(oldOps)}
 const store=createChatSqliteStore({dataRoot:root,helpers})
 const base={id:'fixture-chat',sessionId:session.id,_storageRevision:7,mode:'story',messages:messagesBefore24,variables:{hp:23},lastWorldBookRecall:{turn:23},contextCompaction:{warning:'轮23'},hiddenDshErrorTurns:OLD_FAILED_TURNS,unknownBusiness:'用户独立编辑保留',timeline:{schemaVersion:1,branchId:'branch-24',revision:24,checkpoints:[{id:'cp23',turn:23,businessBefore:{version:1,fields:{variables:{hp:22}},messageCount:messagesBefore24.length-2,participants:{},operationIds:[],operationStates:{}}}],operations:oldOps,participants:{}}}
 await store.update(base.id,()=>base)
 const current={...base,_storageRevision:8,messages:[...messagesBefore24,{role:'user',turn:TARGET_TURN,text:'输入轮24半截'},{role:'assistant',turn:TARGET_TURN,text:'轮24半截',swipeId:0,swipes:['轮24半截']}],variables:{hp:24},foregroundError:{message:'轮24失败'},timeline:{...base.timeline,revision:25,operations:{...oldOps,body:{kind:'body',turn:TARGET_TURN,status:'failed',businessBefore:baseline24}}}}
 await store.update(base.id,()=>current)
 const agents=new Map([[session.id,{session,phase:{kind:'idle',lastTurn:TARGET_TURN},runtimeContext:{retained:{text:'轮24'}}}]])
 const handles=new Set([...agents].map(([id,a])=>({id,access:'write',state:{cursor:a.session.seq,primed:{text:'轮24'}},observedLength:a.session.seq})))
 const dbs=new Map([[session.id,mainDb]])
 let fault=false
 const persistence={bindRollbackArchive:async(id,file)=>dbs.get(id).bindRollbackArchive(file),setRollbackPending:async(id,value)=>dbs.get(id).setRollbackPending(value),drainOpenHandles:async()=>{},truncateEvents:async(header,boundary)=>{if(fault)throw Error('夹具故障点：截断失败');const db=dbs.get(header.id),meta=db.truncateFrom(boundary);rewindRollbackHandles(handles,header.id,meta.eventCount);return meta}}
 for(const agent of agents.values())agent.inbox={nextTurn:[],nextStep:[]}
 const syncFrames=[];let rollbackSync
 installRollbackSync({get:()=>({controlState:{ctx:{sessionProjections:projections},jobsFor:()=>[],broadcast:frame=>syncFrames.push(frame)},history:{assistantStreams:new Map()}}),provide:(_key,value)=>{rollbackSync=value}})
 const meter={states:new WeakMap()},services={projections,projectionCache:{write:async()=>{}},tokenMeterProvider:()=>meter,rollbackSyncProvider:()=>rollbackSync}
 const recalls=createRollbackWorldbookRecallLog({dataRoot:root,store:{readJson:async()=>undefined,remove:async()=>{}}})
 await recalls.record({chat:base,frame:{operationId:'recall23',turn:23,branchId:'branch-24'},log:{outputs:[{text:'轮23'}]}})
 await recalls.record({chat:current,frame:{operationId:'recall24',turn:TARGET_TURN,branchId:'branch-24'},log:{outputs:[{text:'轮24'}]}})
 const read=()=>store.read(base.id),update=(_id,fn,metadata)=>store.update(base.id,async now=>{const next=await fn(now);next._storageRevision=now._storageRevision+1;return next},metadata)
 const target=()=>({turn:TARGET_TURN,branchId:current.timeline.branchId,revision:current._storageRevision,operationId:'body',chatId:current.id,sessionId:current.sessionId})
 // 现场漂移/后继推进用例要在**改过 chat 之后**重新取目标快照（否则先被 revision 漂移拒绝，测不到目标分支）。
 const liveTarget=async()=>{const live=await read(),body=Object.entries(live.timeline.operations).find(([,op])=>op.kind==='body'&&Number(op.turn)===TARGET_TURN);return {turn:TARGET_TURN,branchId:live.timeline.branchId,revision:live._storageRevision,operationId:body?body[0]:'body',chatId:live.id,sessionId:live.sessionId}}
 const args={chat:undefined,requestedTurn:TARGET_TURN,availability:()=>({failedTurns:FAILED_TURNS,canRollback:true}),readChat:read,updateChat:update,chats:{rollbackArchivePath:store.rollbackArchivePath,readRollbackWorldbook:store.readRollbackWorldbook,readSlice:store.readSlice,update},sessions:{get:id=>agents.get(id),getSession:id=>agents.get(id)?.session,flush:async()=>{}},persistence,services,quiesce:async()=>{},sideCleanup:async(chat,turn)=>{await recalls.pruneRollback(chat,turn,chat.timeline.branchId)},view:async chat=>({turn:chat.messages.at(-1).turn,variables:chat.variables}),readCard:async()=>({})}
 const item={root,base,current,boundary24,session,store,agents,args,read,update,mainDb,recalls,target,liveTarget,syncFrames,setFault:value=>{fault=value},appendTurn:(n,text,failed=false)=>{const seq=session.seq;turn(n,text,failed);mainDb.appendBatch(session.snapshotEvents(seq),seq);agents.get(session.id).phase.lastTurn=n},cleanup:async()=>{for(const id of agents.keys())rollbackBarrier.delete(id);recalls.dispose();store.dispose();mainDb.close();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}}
 item.args.chat=await read()
 return item
}
const snapshot=chat=>JSON.stringify({messages:chat.messages,variables:chat.variables,hiddenDshErrorTurns:chat.hiddenDshErrorTurns,operations:chat.timeline.operations,timelineRevision:chat.timeline.revision})

test('失败清理只清最新失败轮24：历史失败2..22与完成轮23的事件/状态保持在baseline',async()=>{
 const f=await fixture()
 try{
  const before=await f.read(),target=f.target()
  // 走宿主真实协议形状：RPC 第三参（args.failureTarget || args.expectedTurn）经 rollbackTurn 进 requestedTurn 的对象。
  const result=await cleanRollback({...f.args,requestedTurn:target})
  assert.equal(result.turn,23)
  assert.equal(result.rolledBack.cleanedFailureTarget.turn,TARGET_TURN,'成功回执必须带 cleanedFailureTarget')
  assert.equal(result.rolledBack.cleanedFailureTarget.operationId,'body')
  assert.equal(result.rolledBack.cleanedFailureTarget.branchId,target.branchId)
  assert.equal(result.rolledBack.cleanedFailureTarget.revision,target.revision)
  assert.equal(result.rolledBack.sync.id,f.syncFrames.at(-1).value.id)
  const after=await f.read()
  assert.deepEqual(after.messages,f.base.messages,'轮1..23正文（含历史失败轮行）必须原样保留')
  assert.ok(!JSON.stringify(after.messages).includes('轮24半截'),'同轮半截 user/assistant 行随尾删除（半截不等于已完成）')
  assert.deepEqual(after.hiddenDshErrorTurns,OLD_FAILED_TURNS,'21 个历史失败轮的运行状态保持 baseline')
  assert.deepEqual(Object.keys(after.timeline.operations).sort(),OLD_FAILED_TURNS.map(n=>'op'+n).sort(),'只移除目标轮 operation，历史失败 operation 保持')
  assert.equal(after.timeline.operations.body,undefined)
  assert.deepEqual(after.variables,{hp:23})
  assert.equal(after.rollbackPending,undefined)
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events WHERE seq >= ?').get(f.boundary24).n,0,'目标轮事件尾已物理删除')
  const text=JSON.stringify(f.mainDb.readAll())
  assert.ok(text.includes('轮23') && text.includes('轮2'),'历史轮事件保持')
  assert.ok(!text.includes('轮24'),'目标轮事件不得残留')
  assert.ok(before.timeline.operations.body)
 }finally{await f.cleanup()}
})

test('失败清理拒绝降级：表面无失败且原生已完成 ⇒ 拒绝且目标零改',async()=>{
 const f=await fixture({nativeFailedTarget:false})
 try{
  const before=snapshot(await f.read()),events=f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n
  await assert.rejects(cleanRollback({...f.args,availability:()=>({failedTurns:[],canRollback:true}),failureTarget:f.target()}),/原生目标轮不是失败结束；拒绝降级为正常轮回退/)
  assert.equal(snapshot(await f.read()),before,'拒绝路径不得写任何业务字段')
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,events)
 }finally{await f.cleanup()}
})

test('失败清理拒绝历史失败：目标指向旧失败轮（非 Math.max）⇒ 明确拒绝且零改',async()=>{
 const f=await fixture()
 try{
  const before=snapshot(await f.read())
  await assert.rejects(cleanRollback({...f.args,requestedTurn:2,failureTarget:{...f.target(),turn:2,operationId:'op2'}}),/不是当前最新失败轮，历史失败不清理/)
  assert.equal(snapshot(await f.read()),before)
 }finally{await f.cleanup()}
})

test('失败清理拒绝漂移与后继推进：revision/branch 变更或目标轮之后已有完成轮 ⇒ 零改',async()=>{
 const f=await fixture()
 try{
  const before=snapshot(await f.read())
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),revision:f.current._storageRevision+1}}),/存储版本已变/)
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),branchId:'branch-other'}}),/分支已变/)
  assert.equal(snapshot(await f.read()),before,'两种漂移拒绝后业务零改')
  await f.update(f.base.id,async chat=>{chat.messages=[...chat.messages,{role:'assistant',turn:TARGET_TURN+1,text:'轮25',swipeId:0,swipes:['轮25']}];return chat},{source:'fixture.turn25'})
  const pushed=snapshot(await f.read())
  await assert.rejects(cleanRollback({...f.args,failureTarget:await f.liveTarget()}),/之后仍有正文行|之后仍有成功正文检查点|之后仍有任务推进/)
  assert.equal(snapshot(await f.read()),pushed,'后继推进拒绝后业务零改')
 }finally{await f.cleanup()}
})

test('失败清理拒绝无基准：缺 businessBefore/rowBefore ⇒ 明确 reason 不猜历史',async()=>{
 const f=await fixture()
 try{
  const before=snapshot(await f.read())
  await f.update(f.base.id,async chat=>{delete chat.timeline.operations.body.businessBefore;return chat},{source:'fixture.drop-baseline'})
  const drifted=snapshot(await f.read())
  await assert.rejects(cleanRollback({...f.args,failureTarget:await f.liveTarget()}),/缺少该轮业务回退基准/)
  assert.equal(snapshot(await f.read()),drifted)
  assert.notEqual(drifted,before,'夹具确实去掉了基准')
 }finally{await f.cleanup()}
})

test('失败清理重试：pending 记录 failureTarget，同目标带 rollbackId 可续跑，异目标冒认被拒',async()=>{
 const f=await fixture()
 try{
  f.setFault(true)
  await assert.rejects(cleanRollback({...f.args,failureTarget:f.target()}),/夹具故障点/)
  f.setFault(false)
  const pending=(await f.read()).rollbackPending
  assert.ok(pending, '失败层保留完成意图')
  assert.equal(pending.failureTarget.operationId,'body')
  assert.equal(pending.failureTarget.turn,TARGET_TURN)
  assert.equal(pending.turn,TARGET_TURN)
  // 四项同值但缺 retry id ⇒ 不得凭旧 op/turn 冒认
  await assert.rejects(cleanRollback({...f.args,failureTarget:f.target()}),/拒绝冒认/)
  // 异目标（含带 rollbackId）冒认 ⇒ 拒
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),operationId:'op2',turn:2,rollbackId:pending.id}}),/拒绝冒认/)
  // 四项 exact + rollbackId===pending.id 方可续跑（原 branch/revision 取 pending 里的发起时快照）
  const result=await cleanRollback({...f.args,requestedTurn:TARGET_TURN,failureTarget:{...f.target(),rollbackId:pending.id}})
  assert.equal(result.turn,23,'revision 已推进仍须可按身份重试')
  const after=await f.read()
  assert.equal(after.rollbackPending,undefined)
  assert.deepEqual(after.hiddenDshErrorTurns,OLD_FAILED_TURNS)
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events WHERE seq >= ?').get(f.boundary24).n,0)
 }finally{await f.cleanup()}
})

test('失败清理已清且历史失败仍在：重复同目标 changed 无写，目标已变明确拒绝',async()=>{
 const f=await fixture()
 try{
  await cleanRollback({...f.args,requestedTurn:f.target()})
  const cleaned=await f.read(),revision=cleaned._storageRevision,events=f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,cleanTarget=f.target()
  // 关键：重复时 availability 仍带 21 个历史 failed（不是 failed=[]），且入口走 requestedTurn 对象（宿主真实 wiring）。
  const historicalFailed=()=>({failedTurns:OLD_FAILED_TURNS,canRollback:true})
  const again=await cleanRollback({...f.args,requestedTurn:cleanTarget,availability:historicalFailed})
  assert.equal(again.changed,false,'历史 failed 仍在也必须 changed 无写，不得 reject')
  assert.equal(again.alreadyClean,true)
  assert.equal(again.turn,23,'alreadyClean 返回同形完整 view（最新视图）')
  assert.deepEqual(again.variables,{hp:23},'完整 view 载荷在场')
  assert.deepEqual((await f.read()).hiddenDshErrorTurns,OLD_FAILED_TURNS,'21 个历史失败保持，正是它证明不是靠 failed=[] 判已清')
  assert.equal(again.rolledBack.alreadyClean,true)
  assert.equal(again.rolledBack.sync,undefined,'alreadyClean 不带 sync')
  assert.equal(again.rolledBack.cleanedFailureTarget.turn,TARGET_TURN)
  assert.equal(again.rolledBack.cleanedFailureTarget.operationId,'body')
  assert.equal(again.rolledBack.cleanedFailureTarget.branchId,cleanTarget.branchId)
  assert.equal(again.rolledBack.cleanedFailureTarget.revision,cleanTarget.revision)
  assert.equal(f.syncFrames.length,1,'已清理重入不得再发同步帧（仅首清一次）')
  const after=await f.read()
  assert.equal(after._storageRevision,revision,'已清理重入不得写业务（revision 不变）')
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,events)
  assert.equal(after.rollbackPending,undefined)
  // 目标 op 缺 且 事件尾已推进（玩家继续玩）：目标已变 ⇒ 明确拒绝且一条不删，不得误报 alreadyClean。
  f.appendTurn(TARGET_TURN+1,'轮25')
  const pushed=snapshot(await f.read()),eventsPushed=f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n
  await assert.rejects(cleanRollback({...f.args,requestedTurn:await f.liveTarget(),availability:historicalFailed}),/目标已变化|状态不明确/)
  assert.equal(snapshot(await f.read()),pushed,'目标已变拒绝路径不得删任何正文')
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,eventsPushed)
 }finally{await f.cleanup()}
})

test('失败清理foreign身份拒绝：foreign目标在alreadyClean与pending两路都拒且零写',async()=>{
 const f=await fixture()
 try{
  const before=snapshot(await f.read()),events=f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n
  // 1) 目标 op 仍在（正常清理路）：foreign chatId/sessionId 先拒，不得进入任何清理分支。
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),chatId:'other-chat'}}),/与本档身份不一致：chatId/)
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),sessionId:'other-session'}}),/与会话身份不一致：sessionId/)
  assert.equal(snapshot(await f.read()),before,'foreign 目标不得写业务')
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,events)
  // 2) pending 现场：先造 pending（夹具故障点），再以 foreign 目标重试 ⇒ 身份先拒（不给冒认判定放行机会）。
  f.setFault(true)
  await assert.rejects(cleanRollback({...f.args,failureTarget:f.target()}),/夹具故障点/)
  f.setFault(false)
  const withPending=await f.read(),pendingId=withPending.rollbackPending.id,revisionPending=withPending._storageRevision
  assert.ok(pendingId,'必须有 pending 现场')
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),chatId:'other-chat',rollbackId:pendingId}}),/与本档身份不一致：chatId/)
  await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),sessionId:'other-session',rollbackId:pendingId}}),/与会话身份不一致：sessionId/)
  const stillPending=await f.read()
  assert.equal(stillPending.rollbackPending.id,pendingId,'pending 必须原样保留')
  assert.equal(stillPending._storageRevision,revisionPending,'pending 路上的 foreign 目标不得写业务')
  // 3) 同目标带 rollbackId 仍可续跑（foreign 拒绝不影响合法重试），随后进入 alreadyClean 现场。
  const resumed=await cleanRollback({...f.args,requestedTurn:TARGET_TURN,failureTarget:{...f.target(),rollbackId:pendingId}})
  assert.equal(resumed.turn,23)
  const cleaned=await f.read(),revisionCleaned=cleaned._storageRevision,eventsCleaned=f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n
  assert.equal(cleaned.rollbackPending,undefined)
  // 4) alreadyClean 路：foreign 目标必须先拒，不得误报 changed/alreadyClean。
  await assert.rejects(cleanRollback({...f.args,requestedTurn:{...f.target(),chatId:'other-chat'},availability:()=>({failedTurns:OLD_FAILED_TURNS,canRollback:true})}),/与本档身份不一致：chatId/)
  const afterClean=await f.read()
  assert.equal(afterClean._storageRevision,revisionCleaned,'alreadyClean 路上的 foreign 目标不得写业务')
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,eventsCleaned)
 }finally{await f.cleanup()}
})

test('失败清理无目标重试拒绝：pending带failureTarget时不得以普通回退自动完成',async()=>{
 const f=await fixture()
 try{
  f.setFault(true)
  await assert.rejects(cleanRollback({...f.args,failureTarget:f.target()}),/夹具故障点/)
  f.setFault(false)
  const pending=(await f.read()).rollbackPending
  assert.ok(pending?.failureTarget,'pending 必须记录 failureTarget')
  const before=snapshot(await f.read()),revision=(await f.read())._storageRevision,events=f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n
  // 不带失败目标的普通回退入口：必须拒，不得替失败清理意图自动收尾（也不能静默降级）。
  await assert.rejects(cleanRollback({...f.args,requestedTurn:TARGET_TURN,failureTarget:null}),/请用同一失败目标重试/)
  const after=await f.read()
  assert.equal(after.rollbackPending.id,pending.id,'pending 必须保留，不得被普通回退自动完成')
  assert.equal(after._storageRevision,revision,'拒绝路径不得写业务')
  assert.equal(snapshot(after),before)
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events').get().n,events)
 }finally{await f.cleanup()}
})

test('普通回退不传 failureTarget 保持原语义：仍按最早失败（Math.min）执行',async()=>{
 const f=await fixture()
 try{
  const result=await cleanRollback({...f.args,requestedTurn:null})
  assert.equal(result.turn,1,'无失败清理目标时按原语义回到最早失败轮之前')
  const after=await f.read()
  assert.deepEqual(after.hiddenDshErrorTurns,undefined)
  assert.equal(after.rollbackPending,undefined)
  assert.equal(rollbackSchedulingBarrier.has(f.session.id),false)
 }finally{await f.cleanup()}
})
