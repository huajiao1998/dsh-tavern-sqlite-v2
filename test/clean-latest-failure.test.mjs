// 新旧RPC均只撤最新发送；旧请求不连删上一轮，在途物理失败复用原边界。
// 不以失败分类、旧坐标或缺基准设资格；明确异档仍零写。
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

test('最新发送成功且原生已完成：同真实 baseline 可撤 latest，历史失败保留',async()=>{
 const f=await fixture({nativeFailedTarget:false})
 try{
  const before=snapshot(await f.read())
  const result=await cleanRollback({...f.args,availability:()=>({failedTurns:[],canRollback:true}),failureTarget:f.target()})
  assert.equal(result.turn,23,'撤的是最新一次发送，回到其前一轮')
  const after=await f.read()
  assert.equal(after.rollbackPending,undefined)
  assert.deepEqual(after.hiddenDshErrorTurns,OLD_FAILED_TURNS,'21 个历史失败保持（只撤 latest，不误清历史）')
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events WHERE seq >= ?').get(f.boundary24).n,0,'目标轮事件尾已物理删除')
  const text=JSON.stringify(f.mainDb.readAll())
  assert.ok(text.includes('轮23') && text.includes('轮2'),'历史轮事件保持')
  assert.ok(!text.includes('轮24'),'目标轮事件不得残留')
  assert.notEqual(snapshot(await f.read()),before,'成功路径确实改写了目标轮')
 }finally{await f.cleanup()}
})

test('退役迁移：旧历史轮请求不删当前尾且返回无变化',async()=>{
 const f=await fixture()
 try{
  const before=await f.read(),events=f.mainDb.cursor()
  const result=await cleanRollback({...f.args,failureTarget:{...f.target(),turn:2,operationId:'op2'}})
  assert.equal(result.changed,false);assert.equal(result.rolledBack.alreadyClean,true)
  assert.deepEqual(await f.read(),before);assert.equal(f.mainDb.cursor(),events)
 }finally{await f.cleanup()}
})

test('退役迁移：同范围旧分支版本不阻止真实删24，后继25不被旧请求连删',async()=>{
 const f=await fixture()
 try{
  const request={...f.target(),revision:-1,branchId:'旧坐标',operationId:'旧操作'}
  await cleanRollback({...f.args,failureTarget:request})
  assert.equal(f.mainDb.cursor(),f.boundary24)
  assert.deepEqual((await f.read()).messages,f.base.messages)
  f.appendTurn(25,'轮25')
  const before=await f.read(),events=f.mainDb.cursor()
  const result=await cleanRollback({...f.args,chat:before,failureTarget:request})
  assert.equal(result.changed,false);assert.equal(result.rolledBack.alreadyClean,true)
  assert.deepEqual(await f.read(),before);assert.equal(f.mainDb.cursor(),events)
 }finally{await f.cleanup()}
})

test('退役迁移：物理失败后旧凭据或普通入口都续同一pending边界，不连删',async()=>{
 for(const entry of ['legacy','ordinary','rollbackId']){
  const f=await fixture()
  try{
   f.setFault(true)
   await assert.rejects(cleanRollback({...f.args,failureTarget:f.target()}),/夹具故障点/)
   f.setFault(false)
   const pending=(await f.read()).rollbackPending
   assert.equal(pending.turn,TARGET_TURN)
   const options=entry==='ordinary'?{requestedTurn:TARGET_TURN,failureTarget:null}
     :{failureTarget:{...f.target(),...(entry==='rollbackId'?{rollbackId:pending.id}:{})}}
   const result=await cleanRollback({...f.args,...options})
   assert.equal(result.turn,23);assert.equal(result.rolledBack.sync.id,pending.id)
   assert.equal((await f.read()).rollbackPending,undefined)
   assert.deepEqual((await f.read()).messages,f.base.messages)
   assert.equal(f.mainDb.cursor(),f.boundary24)
   const revision=(await f.read())._storageRevision
   await cleanRollback({...f.args,failureTarget:{...f.target(),rollbackId:pending.id}})
   assert.equal(f.mainDb.cursor(),f.boundary24,'重传不得再删23')
   assert.equal((await f.read())._storageRevision,revision,'补发同步不改业务版本')
  }finally{await f.cleanup()}
 }
})

test('退役迁移：同一清理重传只补同步，继续游玩后也不连删新轮',async()=>{
 const f=await fixture()
 try{
  const request=f.target()
  const first=await cleanRollback({...f.args,requestedTurn:request})
  const before=await f.read(),events=f.mainDb.cursor()
  const again=await cleanRollback({...f.args,requestedTurn:request})
  assert.equal(again.rolledBack.sync.id,first.rolledBack.sync.id,'补发同一清理同步')
  assert.deepEqual(await f.read(),before);assert.equal(f.mainDb.cursor(),events)
  f.appendTurn(25,'轮25')
  const pushed=await f.read(),cursor=f.mainDb.cursor()
  const replay=await cleanRollback({...f.args,requestedTurn:request})
  assert.equal(replay.changed,false);assert.equal(replay.rolledBack.alreadyClean,true)
  assert.deepEqual(await f.read(),pushed);assert.equal(f.mainDb.cursor(),cursor)
 }finally{await f.cleanup()}
})

test('退役迁移：foreign身份在正常pending完成重传三路均拒且两库零写',async()=>{
 const f=await fixture()
 try{
  const rejectForeign=async()=>{
   const before=await f.read(),cursor=f.mainDb.cursor()
   for(const changed of [{chatId:'other'},{sessionId:'other'}])
    await assert.rejects(cleanRollback({...f.args,failureTarget:{...f.target(),...changed}}),/回退请求不属于当前存档/)
   assert.deepEqual(await f.read(),before);assert.equal(f.mainDb.cursor(),cursor)
  }
  await rejectForeign()
  f.setFault(true);await assert.rejects(cleanRollback({...f.args,failureTarget:f.target()}),/夹具故障点/);f.setFault(false)
  await rejectForeign()
  await cleanRollback({...f.args,failureTarget:f.target()})
  await rejectForeign()
 }finally{await f.cleanup()}
})

test('普通回退不传 failureTarget：只撤最新24并保留历史失败2..22及完成23',async()=>{
 const f=await fixture()
 try{
  const result=await cleanRollback({...f.args,requestedTurn:null})
  assert.equal(result.turn,23,'只撤最新24：落点为23')
  assert.equal(result.rolledBack.hiddenTurn,TARGET_TURN,'hiddenTurn 必须是 24')
  const after=await f.read()
  assert.deepEqual(after.messages,f.base.messages,'轮24半截消息必须清掉，历史消息逐字保留')
  assert.equal(after.variables.hp,23,'变量回到轮23基准')
  assert.deepEqual(after.hiddenDshErrorTurns,OLD_FAILED_TURNS,'历史失败2..22 的隐藏清单保留')
  const keys=Object.keys(after.timeline.operations)
  for(const n of OLD_FAILED_TURNS)assert.ok(keys.includes('op'+n),'历史失败 op'+n+' 必须保留')
  assert.equal(keys.some(key=>{const op=after.timeline.operations[key];return op.kind==='body'&&Number(op.turn)===TARGET_TURN}),false,'轮24 body op 必须删除')
  assert.equal(f.session.seq,f.boundary24,'Session 游标回到 boundary24（无轮24事件）')
  assert.equal(after.rollbackPending,undefined)
  assert.equal(rollbackSchedulingBarrier.has(f.session.id),false)
 }finally{await f.cleanup()}
})
