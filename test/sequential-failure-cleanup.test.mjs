// 连续一轮一轮清理失败尾：先清 native-only 的 43（guard 失败轮，无 body op/基准/正文行），
// 再清常规基准的 42（真实 businessBefore），最后停在正文 41。
// 协议要点（主 2026-10-10 定）：helper 签名 = inspectNativeFailureTail(chat, evidence, revision)，
//   evidence = {events}；无 events ⇒ null。native-only 只识别「末轮 turn/end reason.kind==='error'
//   且 reason.**error**.message 逐字等于 guard 文案」（作者 failed-error-visibility.js:47 读 reason.error.message），
//   该轮不得有 timeline op / messages / cp / rollbackSessionCuts / 本轮 runtime 副 state、无 assistant/tool；
//   尾区只允许 turn/start、turn/end、user/message、agent/inbox/spliced、session/end-seed 等元事件。
//   native 分支与常规共享 pending/quiescence/cuts/SQL 事务/句柄/投影/sync，但 native 跳过
//   resolveRollbackBusinessState，不 capture 当前 business 当恢复基准；正文轮仍走既有 restore + 原 baseline。
// 物理边界：Session.seq 是"下一条"，append 到某轮后 prefix 长度 = 该轮结束后的 seq；
//   清 43 后事件尾回到 42（lastTurn 42 / count = boundary42），清 42 后回到 41（lastTurn 41 / count = boundary41）；
//   正文轮没有 append ⇒ 清 42 后 messages 与清理前**逐字相同**（不变量，不是"必须变化"）。
// 夹具：真宿主 Session（projection-baseline-1001 的 rc.2 真身，仅把 @deepseek-ai/* 指到本机宿主）
//   + SqliteSessionDb + 真 chat sqlite store + 真 SessionProjectionRegistry + 真 rollbackSync；
//   42 的 businessBefore 用真函数 captureRollbackBusinessState(capture) 生成。
// 身份全部合成（本文件不得出现现场 chat/session/branch/operation 值）。
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
import {installRollbackSync} from '../lib/rollback-sync.js'
import {configureRollbackCleanup} from '../lib/rollback-cleanup.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
/** 真实作者 surface 判定（原路径 import，不 stub）：args.availability 必须用它。 */
const {rollbackAvailability}=await import(new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/rollback-surface.js',import.meta.url).href)
assert.equal(typeof rollbackAvailability,'function','作者 rollbackAvailability 必须可 import（原路径）')
/** 真实变换产物（真前端输出）→ 真 target 助手：view 的 failureTarget 必须来自它，不从消息猜。 */
const {applyLatestFailureViewTransform}=await import('../deploy/latest-failure-transform.mjs')
const {applyRollbackPendingViewTransform}=await import('../deploy/rollback-pending-view-transform.mjs')
// T3：不再复制有限作者树（不再建 mkdtemp 源副本）；直接只读作者源文本（support 内按路径缓存、无副作用）。
// 真 Session/SqliteSessionDb/投影/handles 与 URL 隔离照旧每场景新建，不改业务装配。
const {readAuthorSource,VIEW_REL}=await import('./support/latest-failure-source.mjs')
/** 从变换产物里按花括号配对取真实函数文本（与既有 save-ui-seam/extractFunction 同法）。 */
function extractFunction(text,header){
 const start=text.indexOf(header);assert.ok(start>=0,'应能定位 '+header)
 let depth=0
 for(let i=text.indexOf('{',start);i<text.length;i+=1){
  if(text[i]==='{')depth+=1
  else if(text[i]==='}'){depth-=1;if(depth===0)return text.slice(start,i+1)}
 }
 throw new Error('函数花括号不平衡：'+header)
}
/** 真助手 + 真实闭包依赖（native-only 协议：inspectNativeFailureTail 由后端导出）。 */
function failureHelpers(source,deps={}){
 const names=Object.keys(deps)
 const text=extractFunction(source,'function latestFailureTarget(chat, replayTarget, evidence) {')
  +'\nreturn { latestFailureTarget }'
 return new Function(...names,text)(...names.map(name=>deps[name]))
}

/** 后端新 helper 真身（主实现，clean-rollback.js 导出）。**不在模块顶层 import**：
 *  named import 缺导出会让整个模块加载失败（不是变 undefined），会连带打挂同文件其它用例；
 *  故按需取真身并在这里响亮失败。 */
async function loadInspectNativeFailureTail() {
  const module = await import('../lib/clean-rollback.js')
  assert.equal(typeof module.inspectNativeFailureTail, 'function', '后端 clean-rollback.js 必须导出 inspectNativeFailureTail（等待主整合）')
  return module.inspectNativeFailureTail
}

configureRollbackCleanup({sessionEvents:s=>s.snapshotEvents()})
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT||'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
const helpers={copyJsonTree:value=>value===undefined?undefined:structuredClone(value),applyJsonChangesShared:value=>value}
for(const key of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[key]=value=>value
helpers.diffJson=(old,next)=>{
 const changes=[]
 for(const key of new Set([...Object.keys(old),...Object.keys(next)]))if(key!=='messages'&&JSON.stringify(old[key])!==JSON.stringify(next[key]))changes.push({op:'set',path:[key],value:next[key]})
 if(next.messages.length<old.messages.length)changes.push({op:'splice',path:['messages'],index:next.messages.length,deleteCount:old.messages.length-next.messages.length,items:[]})
 else for(let i=0;i<next.messages.length;i++)if(JSON.stringify(old.messages[i])!==JSON.stringify(next.messages[i]))changes.push({op:'set',path:['messages',i],value:next.messages[i]})
 return changes
}

// 全合成身份（不复制现场）
const CHAT_ID='chat-seq-fixture'
const GUARD='失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准'
/** 57 条正文：56 条交替（assistant turn1..28）+ 尾 assistant turn41（与失败清理现场同形）。 */
function rows57(){
 const rows=Array.from({length:56},(_v,index)=>index%2===0
  ?{role:'user',turn:1+Math.floor(index/2),text:'输入'+(Math.floor(index/2)+1)}
  :{role:'assistant',turn:1+Math.floor(index/2),text:'正文'+(1+Math.floor(index/2)),swipeId:0,swipes:['正文'+(1+Math.floor(index/2))]})
 rows.push({role:'assistant',turn:41,text:'尾轮正文',swipeId:0,swipes:['尾轮正文']})
 return rows
}

/**
 * 真夹具：turns 41(completed) → 42(failed body，带真基准) → 43(native guard 失败，仅元事件)。
 * @param options.withOperation43 43 轮往 timeline 挂 op43（负例：有 operation43 不能 native 清）
 * @param options.withAssistant43 43 轮尾区加 assistant/message（负例：非纯 guard 轮）
 * @param options.withoutBaseline42 去掉 42 的 businessBefore（负例：缺基准必须拒）
 * @param options.guardMessage 替换 guard 文案（负例：非 guard 轮）
 */
async function fixture(readSource,options={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-seq-failure-'))
 const raw=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 const file=path.join(root,'session.mjs');writeFileSync(file,raw,'utf8');const {Session}=await import(pathToFileURL(file).href)
 const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
 const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href),{z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
 const ctx=new Context(),projections=new SessionProjectionRegistry(ctx)
 projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(state,e)=>e.type==='turn/end'?{lastTurn:e.data.turn}:state})
 const session=Session.create('session-seq-fixture')
 const userRow=(n,text)=>session.append('user/message',{id:'u'+n,role:'user',content:[{type:'text',text}],source:{kind:'user'}},{surfaceOp:'append'})
 const assistantRow=(n,text)=>session.append('assistant/message',{turn:n,step:1,message:{id:'a'+n,role:'assistant',content:[{type:'text',text}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
 function completedTurn(n,text){session.append('turn/start',{turn:n});userRow(n,text);assistantRow(n,text);session.append('turn/end',{turn:n,reason:{kind:'completed'}})}
 // 42 现场形状：真实 aborted + 两条 user/message（失败正文轮）
 function failedBodyTurn(n,text){session.append('turn/start',{turn:n});userRow(n,text);userRow(n,text+'（重发）');session.append('turn/end',{turn:n,reason:{kind:'aborted',reason:{kind:'user'}}})}
 // 43 现场形状：**没有 user/message**；两处 agent/inbox/spliced（一在 43 段之前、一在 turn/start 之后），无 start/end 事件
 function nativeGuardTurn(n){
  if(options.withToolCall43)session.append('tool/call',{turn:n,name:'fixture-tool',input:{}})
  if(options.withRuntimeInputs43)session.append('runtime/inputs',{turn:n,inputs:[]})
  session.append('turn/start',{turn:n})
  session.append('agent/inbox/spliced',{turn:n,inserted:[]})
  if(options.withAssistant43)assistantRow(n,'不该有的正文')
  // 作者 failed-error-visibility.js:47 读的是 reason.error.message；成功轮则给 completed（无 message）
  const reason=options.endingCompleted43?{kind:'completed'}:{kind:'error',error:{message:options.guardMessage??GUARD}}
  session.append('turn/end',{turn:n,reason})
 }
 completedTurn(41,'输入41')
 if(options.seedAfter41){session.append('session/end-seed',{});session.append('session/end-seed',{})}
 const mainDb=new SqliteSessionDb(path.join(root,'session.db'))
 const keep41=session.seq                    // 42 段之前（= 41 完成 + 其后 seed）
 session.append('agent/inbox/spliced',{inserted:[]})   // 43 段之前的 spliced（现场 491 形状；无 turn 归属）
 failedBodyTurn(42,'输入42')
 if(!options.seedAfter41){session.append('session/end-seed',{});session.append('session/end-seed',{})}
 const keep42=session.seq                    // 43 段之前（含 42 全段、seed 与 before-43 spliced）
 const before43=session.seq                  // 43 段起点下标（供 prefix 切片，不用常数）
 nativeGuardTurn(43)
 // 一次 materialize 全量（内存与库同为完整 seq 轴；helper 的 seq===index 因此成立）
 mainDb.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
 const storedEvents=()=>mainDb.readAll().events
 const messages=rows57()
 const store=createChatSqliteStore({dataRoot:root,helpers})
 const chatBase={id:CHAT_ID,sessionId:session.id,_storageRevision:1,mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,cardPath:'cards/seq-fixture.json',messages,variables:{hp:41},lastWorldBookRecall:{turn:41},contextCompaction:{warning:'轮41'},hiddenDshErrorTurns:[],unknownBusiness:'用户独立编辑保留',timeline:{schemaVersion:1,branchId:'branch-seq-fixture',revision:41,checkpoints:[],operations:{},participants:{}}}
 const capture=captureRollbackBusinessState(chatBase)
 assert.equal(capture.version,1,'真 captureRollbackBusinessState 必须给 version 1 基准')
 assert.equal(capture.messageCount,57,'基准正文前缀必须是 57（42 没 append）')
 const op42={id:'op42',kind:'body',turn:42,status:'failed',basedOn:{branchId:'branch-seq-fixture',revision:41},beforeParticipants:{},...(options.withoutBaseline42?{}:{businessBefore:capture})}
 const operations=options.withOperation43?{op43:{id:'op43',kind:'body',turn:43,status:'failed'},op42}:{op42}
 const checkpoints=options.withCheckpoint43?[{id:'cp43',turn:43,businessBefore:capture}]:[]
 const chatId=CHAT_ID                        // store 永远用本档 id；foreign 身份只在"送出的目标"上构造
 // 真 store 两段写：先落基准档（供 readOpeningWindow），再挂 failed body42（revision 连续 +1）
 await store.update(chatId,()=>chatBase)
 await store.update(chatId,current=>{current.timeline={...current.timeline,revision:42,operations,checkpoints};current._storageRevision=2;return current})
 const agents=new Map([[session.id,{session,phase:{kind:'idle',lastTurn:43},runtimeContext:{retained:{text:'输入43'}}}]])
 for(const agent of agents.values())agent.inbox={nextTurn:[],nextStep:[]}
 const handles=new Set([...agents].map(([id,a])=>({id,access:'write',state:{cursor:a.session.seq,primed:{text:'输入43'}},observedLength:a.session.seq})))
 const dbs=new Map([[session.id,mainDb]])
 const persistence={bindRollbackArchive:async(id,file)=>dbs.get(id).bindRollbackArchive(file),setRollbackPending:async(id,value)=>dbs.get(id).setRollbackPending(value),drainOpenHandles:async()=>{},truncateEvents:async(header,boundary)=>{const db=dbs.get(header.id),meta=db.truncateFrom(boundary);rewindRollbackHandles(handles,header.id,meta.eventCount);return meta}}
 const syncFrames=[];let rollbackSync
 installRollbackSync({get:()=>({controlState:{ctx:{sessionProjections:projections},jobsFor:()=>[],broadcast:frame=>syncFrames.push(frame)},history:{assistantStreams:new Map()}}),provide:(_key,value)=>{rollbackSync=value}})
 const meter={states:new WeakMap()},services={projections,projectionCache:{write:async()=>{}},tokenMeterProvider:()=>meter,rollbackSyncProvider:()=>rollbackSync}
 const read=()=>store.read(chatId)
 const update=(_id,fn,metadata)=>store.update(chatId,async now=>{const next=await fn(now);next._storageRevision=now._storageRevision+1;return next},metadata)
 // 真实作者 rollbackAvailability 作 args.availability（不 stub）；真实变换产物 target 助手作 view 的 failureTarget
 const viewSeamed=applyLatestFailureViewTransform(applyRollbackPendingViewTransform(readSource(VIEW_REL)))
 const inspect=await loadInspectNativeFailureTail()
 const {latestFailureTarget}=failureHelpers(viewSeamed,{inspectNativeFailureTail:inspect})
 const availability=(chat,evidence)=>rollbackAvailability(chat,evidence)
 const view=async()=>realView()
 // 目标只从"真正 native 判断"取（喂内存真 Session 的完整事件，session 只作身份校验）
 const nativeTarget=async()=>{const chat=await read();return inspect(chat,{events:session.snapshotEvents(),session},chat._storageRevision)}
 // 真 view 元 inputs：readOpeningWindow 只产 source（_storageRevision 仍在），窗口副本边界由
 // 真 projector（session-window-projector:148 copy + :252 非枚举 failureCleanup）负责 ⇒ 这里精确复制该两句
 const openingWindow=()=>store.readOpeningWindow(chatId,{limit:48,requirePartial:true,sessionId:session.id})
 const realView=async()=>{
  const window=await openingWindow()
  assert.ok(window&&window.nativeData===true,'真 store 必须给出原生 opening 窗口：'+String(window&&window.kind))
  assert.ok(window.failureCleanup,'窗口必须带回同快照 failureCleanup 摘要')
  const snapshot={...window.chat,_storageRevision:undefined,windowRevision:window.revision}
  Object.defineProperty(snapshot,'failureCleanup',{value:window.failureCleanup,enumerable:false})
  assert.equal(snapshot._storageRevision,undefined,'窗口副本必须无 _storageRevision（作者形状）')
  assert.equal(snapshot.windowRevision,window.revision,'窗口副本必须带同快照 windowRevision')
  return {turn:snapshot.messages.at(-1).turn,variables:snapshot.variables,failureCleanup:window.failureCleanup,
   failureTarget:latestFailureTarget(snapshot,null,{events:session.snapshotEvents(),session})}
 }
 // 故障点按既有唯一路径：SQL 截断 + 句柄/内存/投影回卷**已完成到 42** 之后，由 sideCleanup 抛一次；pending 仍在
 let sideFault=options.failInSideCleanup===true
 const args={chat:await read(),requestedTurn:null,availability,readChat:read,updateChat:update,chats:{rollbackArchivePath:store.rollbackArchivePath,readRollbackWorldbook:store.readRollbackWorldbook,readSlice:store.readSlice,update},sessions:{get:id=>agents.get(id),getSession:id=>agents.get(id)?.session,flush:async()=>{}},persistence,services,quiesce:async()=>{},sideCleanup:async()=>{if(sideFault){sideFault=false;throw Error('夹具故障点：native 截断后 sideCleanup 失败（pending 已留）')}},view,readCard:async()=>({})}
 const fresh=async()=>({...args,chat:await read(),requestedTurn:null})
 const hasSideFault=()=>sideFault
 const eventCount=()=>mainDb.db.prepare('SELECT count(*) n FROM events').get().n
 const eventsFrom=seq=>mainDb.db.prepare('SELECT count(*) n FROM events WHERE seq >= ?').get(seq).n
 const lastTurn=()=>{const rows=mainDb.readAll().events.filter(event=>event.type==='turn/end');return rows.length?Number(rows.at(-1).data.turn):null}
 const cleanup=async()=>{for(const id of agents.keys())rollbackSchedulingBarrier.delete(id);store.dispose();mainDb.close();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
 return {root,session,mainDb,store,agents,handles,syncFrames,args,fresh,read,eventCount,eventsFrom,lastTurn,nativeTarget,view,realView,openingWindow,availability,hasSideFault,keep41,keep42,before43,chatId,messages,operations,chatBase,capture,cleanup}
}

test('连续失败清理：先清native-only43再清基准42并停在正文41',async()=>{
 const f=await fixture(readAuthorSource,{seedAfter41:true})
 try{
  const beforeChat=await f.read()
  // availability 必须来自真实作者判定（不得 stub）：failedTurns 由现场 events 决定
  const state=f.availability(beforeChat,{events:f.session.snapshotEvents(),nodes:f.session.surface.nodes})
  assert.equal(Array.isArray(state.failedTurns),true,'真 rollbackAvailability 必须给出 failedTurns 数组')
  assert.equal(state.failedTurns.map(Number).includes(42),true,'42 必须被判为失败轮（aborted + user/message）')
  // 目标只从真正 native 判断取
  const found=await f.nativeTarget()
  // 前置：helper 必须给 native 形态目标（含真坐标，且不伪造 operationId）
  assert.equal(found.target.kind,'native-only','target 必须 native 形态')
  assert.equal(found.target.turn,43)
  assert.equal(found.target.endSeq,f.session.snapshotEvents().at(-1).seq,'endSeq 必须是 terminal 事件 seq')
  assert.equal(found.target.eventCount,f.session.snapshotEvents().length,'eventCount 必须是 events.length')
  assert.equal(Object.hasOwn(found.target,'operationId'),false,'native-only 不得伪造 operationId')
  assert.equal(found.target.chatId,f.chatId)
  assert.equal(found.cleanable,true,'前置：43 必须可清；实际 reason='+String(found&&found.reason)+' turn='+String(found&&found.turn)+' endSeq='+String(found&&found.endSeq)+' eventCount='+String(found&&found.eventCount))
  // ① 清 43：只删 native 尾；事件尾回到 42，42 全部业务原样
  const result=await cleanRollback({...await f.fresh(),failureTarget:found.target})
  assert.equal(result.rolledBack.cleanedFailureTarget.turn,43,'回执必须指向被清的 43')
  assert.equal(f.eventsFrom(f.keep42),0,'43 的 native 事件尾必须物理删除')
  assert.equal(f.eventCount(),f.keep42,'事件数必须回到 42 边界（不是 41）')
  assert.equal(f.lastTurn(),42,'事件尾轮必须回到 42')
  const afterNative=await f.read()
  assert.deepEqual(afterNative.messages,beforeChat.messages,'43 清理不得改正文（仍 57）')
  assert.equal(afterNative.messages.length,57)
  assert.ok(afterNative.timeline.operations.op42,'42 的 operation 必须保留')
  assert.ok(afterNative.timeline.operations.op42.businessBefore,'42 的基准必须保留')
  assert.equal(afterNative.timeline.branchId,beforeChat.timeline.branchId,'43 清理不得换 branch')
  assert.equal(afterNative.rollbackPending,undefined,'完成意图必须当场删除')
  assert.equal(f.syncFrames.length,1,'43 清理必须 publish 一次')
  assert.equal(f.syncFrames.at(-1).value.hiddenTurn,43)
  // ② 43 清完后 helper 必须报告 42（真实 events，不凭函数固定重做）
  const next=await f.nativeTarget()
  assert.equal(next.cleanable,false,'42 不是 native-only')
  assert.equal(next.target,null)
  assert.equal(next.turn,42,'清理 43 后尾轮必须是 42')
  // ③ 再清 42：目标由真实 view 助手给出（不手抄），走既有基准 restore，正文不 append ⇒ 57 条逐字不变，最后停在 41
  const target42=(await f.view()).failureTarget
  assert.equal(target42?.operationId,'op42','43 清完后真实 view 必须给出 42 的正文目标')
  assert.equal(target42.turn,42)
  const result42=await cleanRollback({...await f.fresh(),failureTarget:target42})
  assert.equal(result42.turn,41,'清理 42 后的回退目标轮必须是 41')
  assert.equal(f.eventsFrom(f.keep41),0,'42 的事件尾必须物理删除')
  assert.equal(f.eventCount(),f.keep41,'事件数必须回到 41 边界')
  assert.equal(f.lastTurn(),41,'事件尾轮必须停在 41（不得删掉 41）')
  const final=await f.read()
  assert.equal(final.timeline.operations.op42,undefined,'42 的 operation 必须被移除')
  assert.equal(final.messages.length,57,'正文轮没有 append ⇒ 清 42 后仍 57 条')
  assert.deepEqual(final.messages,beforeChat.messages,'清 42 后正文必须与清理前逐字相同（不变量）')
  assert.deepEqual(final.messages,f.messages.slice(0,f.capture.messageCount),'正文必须等于 42 的基准前缀')
  assert.equal(f.syncFrames.length,2,'两轮清理必须 publish 两次')
  assert.deepEqual(f.syncFrames.map(frame=>frame.value.hiddenTurn),[43,42])
 }finally{await f.cleanup()}
})

test('拒绝native-only清理：assistant/operation43/非guard文案一律不可清且零写',async()=>{
 const inspectNativeFailureTail=await loadInspectNativeFailureTail()
 const eqTarget=(f,found,live,extra={})=>{
  const base=found.target||{kind:'native-only',turn:43,branchId:live.timeline.branchId,revision:live._storageRevision,endSeq:f.eventCount()-1,eventCount:f.eventCount(),chatId:CHAT_ID,sessionId:f.session.id}
  if(!extra||Object.keys(extra).length===0)return base
  const {revision,...rest}=extra
  return {...base,...rest,...(revision==='bump'?{revision:Number(base.revision)+1}:{})}
 }
 const scenarios=[
  ['43 轮有 assistant 正文',{withAssistant43:true},/assistant|正文|内容/,/./,null],
  ['43 轮挂 timeline operation',{withOperation43:true},/正文须按该轮业务回退基准|任务操作|正文/,/./,null],
  ['43 轮 turn/end 不是 guard 文案',{guardMessage:'其它错误'},/守卫错误|文案|失败正文必须先统一物理清理/,/./,null],
  ['43 轮尾含 tool/call',{withToolCall43:true},/工具执行|其他轮事件/,/./,null],
  ['43 轮尾含 runtime 输入',{withRuntimeInputs43:true},/业务运行数据|其他轮事件/,/./,null],
  ['43 轮是成功 completed',{endingCompleted43:true},null,/./,'completed'],
  ['43 轮已有成功检查点',{withCheckpoint43:true},/检查点/,/./,null],
  ['目标 chatId 为他人档',{},null,/与本档身份不一致/,{chatId:'chat-foreign-fixture'}],
  ['目标 sessionId 为他人会话',{},null,/与会话身份不一致/,{sessionId:'session-foreign-fixture'}],
  ['目标 revision 漂移',{},null,/分支或存储版本已变化/,{revision:'bump'}],
 ]
 for(const [label,options,helperPattern,backendPattern,extra] of scenarios){
  const f=await fixture(readAuthorSource,options)
  try{
   const before=await f.read(),eventsCount=f.eventCount()
   const found=await f.nativeTarget()
   if(extra==='completed'){
    // 成功轮：helper 不得给目标，且 reason 本来为空（不得显示 guard 文案）
    assert.equal(found.cleanable,false,label+' ⇒ 必须不可 native 清理')
    assert.equal(found.target,null,label+' ⇒ 不得给 target')
    assert.equal(found.reason,'',label+' ⇒ 未改文案的分支 reason 必须为空')
   }else if(helperPattern){
    assert.equal(found.cleanable,false,label+' ⇒ 必须不可 native 清理')
    assert.equal(found.target,null,label+' ⇒ 不得给 target')
    assert.match(String(found.reason),helperPattern,label+' ⇒ 必须给明确 reason')
   }else{
    assert.equal(found.cleanable,true,label+' ⇒ helper 仍应给出目标（拒在后端）：'+String(found&&found.reason))
   }
   const override=extra&&extra!=='completed'?extra:null
   const target=eqTarget(f,found,before,override||{})
   await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:target}),backendPattern,label+' ⇒ 必须拒')
   assert.equal(f.eventCount(),eventsCount,label+' ⇒ 拒绝路径必须零事件写')
   const after=await f.read()
   assert.deepEqual(after.messages,before.messages,label+' ⇒ 拒绝路径必须零业务写')
   assert.equal(after.timeline.branchId,before.timeline.branchId)
   assert.equal(f.syncFrames.length,0,label+' ⇒ 拒绝路径不得 publish')
  }finally{await f.cleanup()}
 }
})

test('native-only清理后旧43目标重试不得误清42：stale坐标/过期目标只认已清不动42',async()=>{
 const f=await fixture(readAuthorSource)
 try{
  const found=await f.nativeTarget()
  assert.equal(found.cleanable,true,'前置：43 必须可清；实际 reason='+String(found&&found.reason)+' turn='+String(found&&found.turn)+' endSeq='+String(found&&found.endSeq)+' eventCount='+String(found&&found.eventCount))
  await cleanRollback({...await f.fresh(),failureTarget:found.target})
  const afterNative=await f.read(),counts=f.eventCount()
  // ① 旧 43 目标（tail 已是 42）重试：只准返回已清/明确拒绝，不得动 42
  let retryError=null
  try{ await cleanRollback({...await f.fresh(),failureTarget:found.target}) }catch(error){ retryError=error }
  const afterRetry=await f.read()
  assert.ok(afterRetry.timeline.operations.op42,'旧 43 重试后 42 的 operation 必须仍在')
  assert.ok(afterRetry.timeline.operations.op42.businessBefore,'旧 43 重试后 42 的基准必须仍在')
  assert.deepEqual(afterRetry.messages,afterNative.messages,'旧 43 重试不得删任何正文')
  assert.equal(f.eventCount(),counts,'旧 43 重试不得删任何事件')
  assert.equal(f.lastTurn(),42,'旧 43 重试后事件尾仍必须是 42')
  assert.equal(afterRetry.timeline.branchId,afterNative.timeline.branchId,'旧 43 重试不得换 branch')
  assert.equal(retryError===null||retryError instanceof Error,true,'重试结果必须是"已清"或明确错误')
  // ② stale 坐标必须拒；**联动 +1 的坐标**（形状合法、tail 已无该轮、revision 仍旧）走 alreadyClean 分支：
  //    只准 changed:false/已清回执，绝不动 42（后端 :171 判据：tail<turn、无该轮事件、当前事件更少）
  await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:{...found.target,endSeq:Number(found.target.endSeq)-1}}),/./,'stale endSeq 必须拒')
  await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:{...found.target,eventCount:Number(found.target.eventCount)+1}}),/./,'stale eventCount 必须拒')
  const linked={...found.target,endSeq:Number(found.target.endSeq)+1,eventCount:Number(found.target.eventCount)+1}
  assert.equal(linked.eventCount,linked.endSeq+1,'联动坐标必须保持形状合法（endSeq+1===eventCount）')
  const linkedResult=await cleanRollback({...await f.fresh(),failureTarget:linked})
  assert.equal(linkedResult.changed,false,'联动坐标不得产生业务写')
  assert.equal(linkedResult.alreadyClean,true,'联动坐标（tail 无该轮且现场事件更少）必须判已清')
  assert.equal(f.eventCount(),counts,'联动坐标不得删任何事件')
  assert.ok((await f.read()).timeline.operations.op42,'联动坐标不得动 42')
  const afterStale=await f.read()
  assert.ok(afterStale.timeline.operations.op42,'stale 坐标拒绝后 42 必须仍在')
  assert.equal(f.eventCount(),counts,'stale 坐标拒绝后事件数不变')
  // ③ 之后 42 必须仍可正常清（证明上一步没把 42 弄成不可清）；目标由真实 view 助手给出
  const target42=(await f.view(afterStale)).failureTarget
  assert.equal(target42?.operationId,'op42','旧 43 重试后真实 view 必须仍给出 42 的正文目标')
  const result=await cleanRollback({...await f.fresh(),failureTarget:target42})
  assert.equal(result.turn,41,'42 仍须可清并停在 41')
  assert.equal(f.lastTurn(),41)
 }finally{await f.cleanup()}
})

test('常规正文42缺基准仍拒：native-only不改变既有缺基准拒绝语义',async()=>{
 const f=await fixture(readAuthorSource,{withoutBaseline42:true})
 try{
  const before=await f.read()
  // ① 末轮是 native-only 43（op42 缺 base 不影响 native 判定）⇒ 必须可清
  const found43=await f.nativeTarget()
  assert.equal(found43.cleanable,true,'43 必须可 native 清（缺 base 只影响 42）')
  const moved=await cleanRollback({...await f.fresh(),failureTarget:found43.target})
  assert.equal(moved.rolledBack.cleanedFailureTarget.turn,43,'43 必须真的被清')
  assert.equal(f.lastTurn(),42,'清 43 后事件尾必须是 42')
  const afterNative=await f.read()
  assert.equal(afterNative.timeline.operations.op42.businessBefore,undefined,'42 仍必须保持缺 base（本负例前提）')
  assert.deepEqual(afterNative.messages,before.messages,'清 43 不得改正文')
  // ② 尾轮 42 是正文轮（缺 base）⇒ 不可 native 清、真 view 不得给目标、后端按缺基准拒 ⇒ 不得降级
  const inspect42=await f.nativeTarget()
  assert.equal(inspect42.cleanable,false,'42 是正文轮不得被判 native-only 可清')
  assert.equal(inspect42.target,null,'42 不得给 native target')
  assert.equal((await f.view(afterNative)).failureTarget,null,'缺基准时真实 view 不得给出目标')
  await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:{turn:42,branchId:afterNative.timeline.branchId,revision:afterNative._storageRevision,operationId:'op42',chatId:f.chatId,sessionId:f.session.id}}),/回退基准/,'42 缺 businessBefore 必须明确拒绝（不降级为 native）')
  const after=await f.read()
  assert.ok(after.timeline.operations.op42,'拒绝后 42 的 operation 必须仍在')
  assert.deepEqual(after.messages,before.messages,'缺基准拒绝路径必须零正文写')
  assert.equal(f.lastTurn(),42,'缺基准拒绝路径不得动事件尾')
  assert.equal(f.syncFrames.length,1,'只有 43 那一次 publish（缺基准拒绝不得 publish）')
 }finally{await f.cleanup()}
})

test('native清理中途失败留pending：状态一致后按rollbackId重试完成且不误清42，冒认拒',async()=>{
 const inspectNativeFailureTail=await loadInspectNativeFailureTail()
 void inspectNativeFailureTail
 const f=await fixture(readAuthorSource,{failInSideCleanup:true})
 try{
  const before=await f.read()
  const found=await f.nativeTarget()
  assert.equal(found.cleanable,true,'前置：43 必须可清；实际 reason='+String(found&&found.reason)+' turn='+String(found&&found.turn)+' endSeq='+String(found&&found.endSeq)+' eventCount='+String(found&&found.eventCount))
  // ① 物理截断 + 句柄/内存/投影已到 42 之后，sideCleanup 抛一次：pending 仍留，new revision++
  await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:found.target}),/夹具故障点/,'中途失败必须响亮')
  assert.equal(f.hasSideFault(),false,'故障点必须只抛一次（已清除）')
  const mid=await f.read()
  assert.equal(f.eventCount(),f.keep42,'截断后事件数必须已是 42 边界')
  assert.equal(f.lastTurn(),42)
  assert.equal(mid.rollbackPending?.id!==undefined,true,'中途失败必须留下完成意图')
  assert.equal(mid.rollbackPending.failureTarget.turn,43)
  assert.equal(mid.rollbackPending.failureTarget.endSeq,found.target.endSeq,'pending 里保留原坐标（endSeq）')
  assert.equal(mid.rollbackPending.failureTarget.eventCount,found.target.eventCount,'pending 里保留原坐标（eventCount）')
  assert.equal(Object.hasOwn(mid.rollbackPending.failureTarget,'rollbackId'),false,'pending 不存 rollbackId（由发起方补）')
  assert.equal(mid._storageRevision,before._storageRevision+1,'中途失败必须推进存储版本')
  assert.deepEqual(mid.messages,before.messages,'中途失败不得改正文')
  assert.ok(mid.timeline.operations.op42,'中途失败后 42 的 operation 必须仍在')
  assert.ok(mid.timeline.operations.op42.businessBefore,'中途失败后 42 的基准必须仍在')
  assert.equal(mid.timeline.branchId,before.timeline.branchId,'中途失败不得换 branch')
  assert.equal(f.syncFrames.length,0,'未完成不得 publish')
  // ② 异 rollbackId 冒认必须拒且零写
  const counts=f.eventCount(),revision=mid._storageRevision
  await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:{...found.target,rollbackId:'rollback-foreign-fixture'}}),/拒绝冒认/,'异 rollbackId 必须拒')
  assert.equal(f.eventCount(),counts,'冒认拒绝后事件数不变')
  assert.equal((await f.read())._storageRevision,revision,'冒认拒绝后版本不变')
  assert.ok((await f.read()).timeline.operations.op42,'冒认拒绝后 42 必须仍在')
  // ③ 同 rollbackId 重试：按 pending 原坐标完成，且不得误清 42
  const retry={turn:mid.rollbackPending.failureTarget.turn,branchId:mid.rollbackPending.failureTarget.branchId,revision:mid.rollbackPending.failureTarget.revision,kind:'native-only',endSeq:mid.rollbackPending.failureTarget.endSeq,eventCount:mid.rollbackPending.failureTarget.eventCount,chatId:CHAT_ID,sessionId:f.session.id,rollbackId:mid.rollbackPending.id}
  const done=await cleanRollback({...await f.fresh(),failureTarget:retry})
  assert.equal(done.rolledBack.cleanedFailureTarget.turn,43,'重试完成回执必须指向 43')
  const after=await f.read()
  assert.equal(after.rollbackPending,undefined,'重试后完成意图必须删除')
  assert.equal(f.eventCount(),f.keep42,'重试后事件数仍是 42 边界')
  assert.equal(f.lastTurn(),42,'重试后事件尾仍是 42')
  assert.deepEqual(after.messages,before.messages,'重试完成不得改正文（仍 57）')
  assert.ok(after.timeline.operations.op42,'重试完成不得顺手清掉 42 的 operation')
  assert.ok(after.timeline.operations.op42.businessBefore,'重试完成不得清掉 42 的基准')
  assert.equal(f.syncFrames.length,1,'重试完成必须 publish 一次')
  assert.equal(f.syncFrames.at(-1).value.hiddenTurn,43)
  // ④ 完成后 42 必须仍可正常清（证明重试没把 42 弄坏）
  const target42={turn:42,branchId:after.timeline.branchId,revision:after._storageRevision,operationId:'op42',chatId:CHAT_ID,sessionId:f.session.id}
  const result=await cleanRollback({...await f.fresh(),failureTarget:target42})
  assert.equal(result.turn,41,'42 仍须可清并停在 41')
  assert.equal(f.lastTurn(),41)
 }finally{await f.cleanup()}
})
