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
import {latestSendTarget} from '../lib/latest-send.js'
import {applyLatestSendViewTransform} from '../deploy/latest-send-view-transform.mjs'
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
/** 宿主请求扩展准备失败的真实文案（inspectNativeFailureTail 的扩展判据按逐字比对）。 */
const REQUEST_EXTENSION_MESSAGE='DeepSeek request extension preparation failed'
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
 * @param options.withoutBaseline42 去掉42的businessBefore（应走部分恢复）
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
 const extension=options.requestExtension===true
 /** 旧 foreground-frame 的 messageId/trace：42 替换它、43 只有 append。 */
 const frame={chatId:CHAT_ID,operationId:'op-foreground-41',turn:41}
 const frameSource=()=>({kind:'plugin',plugin:'dsh-tavern',form:'foreground-frame',trace:{chatId:frame.chatId,operationId:frame.operationId,turn:frame.turn}})
 let oldFrameSeq=null
 const code=options.requestErrorCode??'REQUEST_EXTENSION'
 const message=options.requestErrorMessage??REQUEST_EXTENSION_MESSAGE
 const failure=()=>({code,message})
 /** 纯未发请求终止：唯一 chunk/finish/error 帧；streamText 只在负例里出现。 */
 const finishFrame=()=>{
  const frames=[{type:'chunk',chunk:{type:'finish',reason:{kind:'error',failure:failure()}}}]
  if(options.streamText)return [...frames,{type:'chunk',chunk:{type:'text',text:'不该有的文本'}}]
  return frames
 }
 /** 42 现场形状（扩展失败）：user 输入 + 旧 foreground-frame 替换（新 append 在本轮、引用前轮 append），无正文/无输出。 */
 function extensionReplacementTurn(n,text){
  session.append('turn/start',{turn:n})
  userRow(n,text)
  session.append('user/message',{id:'u-frame-42',role:'user',content:[],source:{...frameSource(),trace:{...frameSource().trace,frameId:'frame-41'}}},{surfaceOp:{op:'replace',startSeq:oldFrameSeq,endSeq:oldFrameSeq},sourceEventSeqs:[oldFrameSeq]})
  session.append('step/start',{turn:n,step:1})
  session.append('assistant/attempt',{turn:n,step:1,stream:finishFrame()})
  session.append('step/end',{turn:n,step:1})
  session.append('turn/end',{turn:n,reason:{kind:'error',error:failure()}})
 }
 /** 43 现场形状（扩展失败）：只有 user append（无替换、无正文、无输出）。 */
 function extensionAppendTurn(n,text){
  session.append('turn/start',{turn:n})
  userRow(n,text)
  if(options.extraStep43===true){session.append('step/start',{turn:n,step:1});session.append('step/start',{turn:n,step:2})}
  else session.append('step/start',{turn:n,step:1})
  session.append('assistant/attempt',{turn:n,step:1,stream:finishFrame()})
  session.append('step/end',{turn:n,step:1})
  session.append('turn/end',{turn:n,reason:{kind:'error',error:failure()}})
 }
 function completedTurn(n,text){session.append('turn/start',{turn:n});userRow(n,text);assistantRow(n,text);if(extension){const previous=session.append('user/message',{id:'u-frame-41',role:'user',content:[{type:'text',text:'旧临时上下文'}],source:{...frameSource(),trace:{...frameSource().trace,frameId:'frame-41'}}},{surfaceOp:'append'});oldFrameSeq=previous.seq}session.append('turn/end',{turn:n,reason:{kind:'completed'}})}
 // 42 现场形状：真实 aborted + 两条 user/message（失败正文轮）
 function failedBodyTurn(n,text){session.append('turn/start',{turn:n});userRow(n,text);userRow(n,text+'（重发）');if(options.body42Ending==='active')return;if(options.body42Ending==='completed')session.append('turn/end',{turn:n,reason:{kind:'completed'}});else session.append('turn/end',{turn:n,reason:{kind:'aborted',reason:{kind:'user'}}})}
 // 43 现场形状：**没有 user/message**；两处 agent/inbox/spliced（一在 43 段之前、一在 turn/start 之后），无 start/end 事件
 function nativeGuardTurn(n){
  if(options.withToolCall43)session.append('tool/call',{turn:n,name:'fixture-tool',input:{}})
  if(options.withRuntimeInputs43)session.append('runtime/inputs',{turn:n,inputs:[]})
  session.append('turn/start',{turn:n})
  session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[]})
  if(options.withAssistant43)assistantRow(n,'不该有的正文')
  // 作者 failed-error-visibility.js:47 读的是 reason.error.message；成功轮则给 completed（无 message）
  const reason=options.endingCompleted43?{kind:'completed'}:{kind:'error',error:{message:options.guardMessage??GUARD}}
  session.append('turn/end',{turn:n,reason})
 }
 completedTurn(41,'输入41')
 if(options.seedAfter41){session.append('session/end-seed',{});session.append('session/end-seed',{})}
 const mainDb=new SqliteSessionDb(path.join(root,'session.db'))
 const with43=options.with43!==false                     // 默认 true：既有叶（含 43 guard 段）完全不变
 if(with43)session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[]})   // 独立空队列事件不是42发送的输入，不应随42删除
 const keep41=session.seq                    // 真实42发送前完整前缀（含独立空队列事件）
 let keep42,before43
 // 扩展失败形状：42 带严格旧 frame 替换、43 只有 user append（options.requestExtension 默认关闭，既有叶完全不变）
 if(extension){
  extensionReplacementTurn(42,'输入42')
  if(!options.seedAfter41){session.append('session/end-seed',{});session.append('session/end-seed',{})}
  keep42=session.seq
  before43=session.seq
  if(with43)extensionAppendTurn(43,'输入43')
 }else{
  failedBodyTurn(42,'输入42')
  if(!options.seedAfter41){session.append('session/end-seed',{});session.append('session/end-seed',{})}
  keep42=session.seq                    // 43 段之前（含 42 全段、seed 与 before-43 spliced）
  before43=session.seq                  // 43 段起点下标（供 prefix 切片，不用常数）；with43=false 时即 42 尾
  if(with43)nativeGuardTurn(43)
 }
 // 一次 materialize 全量（内存与库同为完整 seq 轴；helper 的 seq===index 因此成立）
 mainDb.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
 const storedEvents=()=>mainDb.readAll().events
 const messages=rows57()
 const store=createChatSqliteStore({dataRoot:root,helpers})
 const chatBase={id:CHAT_ID,sessionId:session.id,_storageRevision:1,mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,cardPath:'cards/seq-fixture.json',messages,variables:{hp:41},lastWorldBookRecall:{turn:41},contextCompaction:{warning:'轮41'},hiddenDshErrorTurns:[],unknownBusiness:'用户独立编辑保留',timeline:{schemaVersion:1,branchId:'branch-seq-fixture',revision:41,checkpoints:[],operations:{},participants:{}}}
 const capture=captureRollbackBusinessState(chatBase)
 assert.equal(capture.version,1,'真 captureRollbackBusinessState 必须给 version 1 基准')
 assert.equal(capture.messageCount,57,'基准正文前缀必须是 57（两形状的 42/43 都不产生正文行）')
 const op42={id:'op42',kind:'body',turn:42,status:'failed',basedOn:{branchId:'branch-seq-fixture',revision:41},beforeParticipants:{},...(options.withoutBaseline42?{}:{businessBefore:capture})}
 const operations=extension?{}:(options.withOperation43?{op43:{id:'op43',kind:'body',turn:43,status:'failed'},op42}:{op42})
 const checkpoints=extension?[{id:'cp41',turn:41,businessBefore:capture}]:(options.withCheckpoint43?[{id:'cp43',turn:43,...(options.withoutCheckpointBaseline43?{}:{businessBefore:capture})}]:[])
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
 const finalView=applyLatestSendViewTransform(viewSeamed)
 let latestFailureTarget
  if(options.unifiedView || finalView.includes('// [dsh-tavern-native-repair-rollback-view:v1]')){
  const wrapper=extractFunction(finalView,'function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {')
  const project=new Function('latestSendTarget','evidenceOf','rollbackViewFieldsBase',wrapper+'\nreturn rollbackViewFields')(latestSendTarget,()=>({}),()=>({}))
  latestFailureTarget=(chat,_replay,evidence)=>project(chat,evidence).failureTarget
 }else{
  const {latestFailureTarget:legacyTarget}=failureHelpers(finalView,{inspectNativeFailureTail:inspect})
  latestFailureTarget=(chat,_replay,evidence)=>latestSendTarget(chat,evidence,chat.windowRevision??chat._storageRevision) || legacyTarget(chat,null,evidence)
 }
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
   failureTarget:latestFailureTarget(snapshot,null,{events:session.snapshotEvents(),session,cleanupIdle:true,activity:window.activity})}
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
  assert.equal(found.target.kind,'rollback','目标统一形态，不分类')
  assert.equal(found.target.turn,43)
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
  assert.notEqual(afterNative.timeline.branchId,beforeChat.timeline.branchId,'物理撤销推进分支，使旧写失效')
  assert.equal(afterNative.rollbackPending,undefined,'完成意图必须当场删除')
  assert.equal(f.syncFrames.length,1,'43 清理必须 publish 一次')
  assert.equal(f.syncFrames.at(-1).value.hiddenTurn,43)
  // ② 43 清完后 helper 必须报告 42（真实 events，不凭函数固定重做）
  const next=await f.nativeTarget()
  assert.equal(next.cleanable,true,'42沿统一路径可回退')
   assert.equal(next.target.turn,42)
  assert.equal(next.turn,42,'清理 43 后尾轮必须是 42')
  // ③ 再清 42：目标由真实 view 助手给出（不手抄），走既有基准 restore，正文不 append ⇒ 57 条逐字不变，最后停在 41
  const target42=(await f.view()).failureTarget
  assert.equal(target42?.operationId,'op42','43 清完后真实 view 必须给出 42 的正文目标')
  assert.equal(target42.turn,42)
  const result42=await cleanRollback({...await f.fresh(),requestedTurn:target42})
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

test('退役迁移：原生尾不按产物前像或版本设资格，异档请求仍零写',async()=>{
 const cases=[
  ['assistant',{withAssistant43:true}],['operation',{withOperation43:true}],
  ['非guard错误',{guardMessage:'其它错误'}],['completed',{endingCompleted43:true}],
  ['checkpoint',{withCheckpoint43:true,withoutCheckpointBaseline43:true}],['旧版本',{}, {revision:-1}],
 ]
 for(const [label,options,extra] of cases){
  const f=await fixture(readAuthorSource,{...options,unifiedView:true})
  try{
   const before=await f.read(),events=f.session.snapshotEvents()
   const first=events.find(e=>Number(e.data?.turn)===43).seq
   const prefix=structuredClone(events.slice(0,first))
   const found=await f.nativeTarget()
   assert.equal(found.cleanable,true,label+'：不按形态或前像拒绝')
   assert.equal(found.target.kind,'rollback');assert.equal(found.target.turn,43)
   const result=await cleanRollback({...await f.fresh(),failureTarget:{...found.target,...extra}})
   assert.equal(result.rolledBack.hiddenTurn,43)
   assert.equal(f.eventCount(),first,label+'：连同start前的目标轮片段一起删尾')
   assert.deepEqual(f.session.snapshotEvents(),prefix,label+'：保留实际42前缀')
   const after=await f.read()
   assert.deepEqual(after.messages,before.messages)
   assert.ok(after.timeline.operations.op42,'不可顺带清42')
   assert.equal(f.syncFrames.length,1)
   if(options.withOperation43 || options.withCheckpoint43)assert.equal(result.rolledBack.recovery.status,'partial')
  }finally{await f.cleanup()}
 }
 const f=await fixture(readAuthorSource,{unifiedView:true})
 try{
  const before=await f.read(),events=f.eventCount(),found=await f.nativeTarget()
  for(const extra of [{chatId:'other'},{sessionId:'other'}])
   await assert.rejects(cleanRollback({...await f.fresh(),failureTarget:{...found.target,...extra}}),/回退请求不属于当前存档/)
  assert.deepEqual(await f.read(),before);assert.equal(f.eventCount(),events);assert.equal(f.syncFrames.length,0)
 }finally{await f.cleanup()}
})

// 有效回归要求，不随旧资格门退役：目标轮在start前的片段也必须实际删净。
// 切点沿本轮最早实际事件，且沿既有独立历史/输入范围约束收口。
for(const [label,options] of [['tool',{withToolCall43:true}],['runtime',{withRuntimeInputs43:true}]])
test('起始片段删尾：'+label+'目标片段位于start之前也必须物理删除',async()=>{
 const f=await fixture(readAuthorSource,{...options,unifiedView:true})
 try{
  const events=f.session.snapshotEvents(),first=events.find(e=>Number(e.data?.turn)===43).seq
  const prefix=structuredClone(events.slice(0,first)),found=await f.nativeTarget()
  await cleanRollback({...await f.fresh(),failureTarget:found.target})
  assert.equal(f.eventCount(),first,'不得把start前的目标轮事件留在库中')
  assert.deepEqual(f.session.snapshotEvents(),prefix)
  assert.ok((await f.read()).timeline.operations.op42,'前一轮42必须保留')
 }finally{await f.cleanup()}
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
   // 旧坐标字段已退役；同一旧目标重传只补回执，不连删42。
   for(const fields of [{endSeq:-99},{eventCount:9999},{endSeq:9998,eventCount:9999}])await cleanRollback({...await f.fresh(),failureTarget:{...found.target,...fields}})
  assert.equal(f.eventCount(),counts,'联动坐标不得删任何事件')
  assert.ok((await f.read()).timeline.operations.op42,'联动坐标不得动 42')
  const afterStale=await f.read()
  assert.ok(afterStale.timeline.operations.op42,'stale 坐标拒绝后 42 必须仍在')
  assert.equal(f.eventCount(),counts,'stale 坐标拒绝后事件数不变')
  // ③ 之后 42 必须仍可正常清（证明上一步没把 42 弄成不可清）；目标由真实 view 助手给出
  const target42=(await f.view()).failureTarget
  assert.equal(target42?.operationId,'op42','真实视图必须重新给出42目标')
  const result=await cleanRollback({...await f.fresh(),requestedTurn:target42})
  assert.equal(result.turn,41,'42 仍须可清并停在 41')
  assert.equal(f.lastTurn(),41)
 }finally{await f.cleanup()}
})

// 真实桌面 7/8 连续形状：REQUEST_EXTENSION「DeepSeek request extension preparation failed」纯失败轮（无 body/无正文/无输出）。
// 42 带严格旧 foreground-frame 替换（新 append 在 42 内、引用 41 的 append），43 只有 user append；两轮 user 均 source.kind='user'。
// 新判据：只有无文本/思考/工具/未知/其他 finish 的唯一 attempt、唯一 step 1，且无本轮 op/正文行/检查点/运行数据时才可清。
test('扩展准备失败清理：扩展纯失败42/43可清且停在41、前缀与旧frame替换不改、负例按新判据拒',async()=>{
 const f=await fixture(readAuthorSource,{requestExtension:true,seedAfter41:true})
 try{
  const inspect=await loadInspectNativeFailureTail(),before=await f.read(),events=f.session.snapshotEvents()
  const head=events.slice(0,f.before43),prefix=events.slice(0,f.keep41)
  const replacement=head.find(event=>event.surfaceOp?.op==='replace')
  assert.ok(replacement)
  assert.deepEqual(replacement.data.content,[])
  assert.notEqual(replacement.data.id,head[replacement.sourceEventSeqs[0]].data.id,'作者退役生成新消息ID')
  assert.deepEqual(replacement.data.source.trace,head[replacement.sourceEventSeqs[0]].data.source.trace,'作者退役保留旧trace')
  assert.equal(inspect(before,{events:head}).cleanable,true,'42旧上下文退役是可重折的纯尾')
  assert.equal(inspect(before,{events}).cleanable,true,'43无输出扩展失败可清')
  const mutate=(input,type,turn,change)=>{
   const copy=structuredClone(input),event=copy.find(item=>item.type===type&&Number(item.data?.turn)===turn)
   assert.ok(event);change(event);return copy
  }
  const rejected=(chat,input,label)=>assert.equal(inspect(chat,{events:input}).cleanable,false,label)
  const eligible=(chat,input,label)=>assert.equal(inspect(chat,{events:input}).cleanable,true,label)
  for(const [label,change]of [
   ['acceptance失败不能冒认请求前失败',event=>{event.data.reason.error.message='DeepSeek request extension acceptance failed'}],
   ['错误码必须匹配',event=>{event.data.reason.error.code='SERVER'}],
  ])eligible(before,mutate(events,'turn/end',43,change),label)
  for(const [label,change]of [
   ['输出文本',event=>{event.data.stream.push({type:'chunk',chunk:{type:'text',text:'输出'}})}],
   ['第二步',event=>{event.data.step=2}],
   ['成功终止帧',event=>{event.data.stream[0].chunk.reason={kind:'completed'}}],
  ])eligible(before,mutate(events,'assistant/attempt',43,change),label)
  eligible(before,mutate(events,'step/end',43,event=>{event.type='tool/call'}),'工具事件本身不改变撤销资格')
  for(const [label,change]of [
   ['替换非空正文',event=>{event.data.content=[{type:'text',text:'正文'}]}],
   ['替换跨档',event=>{event.data.source.trace.chatId='foreign-fixture'}],
   ['替换新frame',event=>{event.data.source.trace.frameId='new-frame'}],
   ['替换引用越界',event=>{event.surfaceOp.startSeq=head.length;event.surfaceOp.endSeq=head.length;event.sourceEventSeqs=[head.length]}],
  ]){const copy=structuredClone(head);change(copy.find(event=>event.surfaceOp?.op==='replace'));eligible(before,copy,label+'：整个待删尾中的替换不改变签名，保留前缀引用由预检另核')}
  for(const [label,change]of [
   ['已有正文操作仍走基准',chat=>{chat.timeline.operations.op43={kind:'body',turn:43,status:'failed'}}],
   ['已有检查点',chat=>{chat.timeline.checkpoints.push({turn:43})}],
   ['已有正文行',chat=>{chat.messages.push({role:'assistant',turn:43,text:'正文'})}],
   ['已有业务数据',chat=>{chat.runtimeInputs={'43':{turn:43}}}],
  ]){const chat=structuredClone(before);change(chat);eligible(chat,events,label)}
   // 已有运行数据且无前像仍实际回退；具体缺失恢复由专用缺前像叶覆盖。
  for(const [turn,keep]of [[43,f.keep42],[42,f.keep41]]){
   const found=await f.nativeTarget()
   assert.equal(found.cleanable,true,String(found.reason));assert.equal(found.target.turn,turn)
   assert.equal((await f.view()).failureTarget.turn,found.target.turn,'统一入口与原生清理同轮')
   const result=await cleanRollback({...await f.fresh(),failureTarget:found.target})
   assert.equal(result.rolledBack.cleanedFailureTarget.turn,turn)
   assert.equal(f.eventCount(),keep);assert.equal(f.lastTurn(),turn-1)
   const now=await f.read()
   assert.deepEqual(now.messages,before.messages);assert.deepEqual(now.variables,before.variables)
   assert.deepEqual(now.timeline.operations,before.timeline.operations,'保留成功账本');assert.deepEqual(now.timeline.checkpoints,before.timeline.checkpoints,'保留原检查点');assert.notEqual(now.timeline.branchId,before.timeline.branchId,'回退换分支隔离旧写')
   assert.equal(now.rollbackPending,undefined)
  }
  assert.deepEqual(f.session.snapshotEvents(),prefix,'保留前缀逐字不变，替换与失败尾物理清除')
  assert.deepEqual(f.syncFrames.map(frame=>frame.value.hiddenTurn),[43,42])
  assert.equal(f.agents.get(f.session.id).phase.lastTurn,41)
  for(const handle of f.handles){assert.equal(handle.state.cursor,f.keep41);assert.equal(handle.observedLength,f.keep41);assert.equal(handle.state.primed,undefined)}
  assert.equal(f.args.services.projections.stateOf(f.session,'turnBoundary').lastTurn,41)
  const cold=f.store.readOpeningWindow(f.chatId,{limit:48,requirePartial:true,sessionId:f.session.id})
  assert.deepEqual((await f.read()).messages,before.messages);assert.ok(cold,'清后SQL窗口可读')
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
  assert.equal(mid.rollbackPending.ordinaryTarget.turn,43)
  assert.equal(mid.rollbackPending.ordinaryTarget.endSeq,found.target.endSeq,'pending 里保留原坐标（endSeq）')
  assert.equal(mid.rollbackPending.ordinaryTarget.eventCount,found.target.eventCount,'pending 里保留原坐标（eventCount）')
  assert.equal(Object.hasOwn(mid.rollbackPending.ordinaryTarget,'rollbackId'),false,'pending 不存 rollbackId（由发起方补）')
  assert.equal(mid._storageRevision,before._storageRevision+1,'中途失败必须推进存储版本')
  assert.deepEqual(mid.messages,before.messages,'中途失败不得改正文')
  assert.ok(mid.timeline.operations.op42,'中途失败后 42 的 operation 必须仍在')
  assert.ok(mid.timeline.operations.op42.businessBefore,'中途失败后 42 的基准必须仍在')
  assert.notEqual(mid.timeline.branchId,before.timeline.branchId,'准备已提交新分支，pending沿新分支收敛')
  assert.equal(f.syncFrames.length,0,'未完成不得 publish')
   // pending保持原turn；客户端传回同一持久操作id，不按退役分类凭据再认证。
  // ③ 同 rollbackId 重试：按 pending 原坐标完成，且不得误清 42
  const retry={...mid.rollbackPending.ordinaryTarget,rollbackId:mid.rollbackPending.id}
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
  const result=await cleanRollback({...await f.fresh(),requestedTurn:target42})
  assert.equal(result.turn,41,'42 仍须可清并停在 41')
  assert.equal(f.lastTurn(),41)
 }finally{await f.cleanup()}
})

// 中断窗口：原生终态已落盘而body仍running，真实窗口签目标后仍可物理清理。
function running42Target(chat){return {turn:42,branchId:chat.timeline.branchId,revision:chat._storageRevision,operationId:'op42',chatId:chat.id,sessionId:chat.sessionId}}
test('失败终态先落盘而正文仍running：真实窗口签目标并物理清理',async()=>{
 const f=await fixture(readAuthorSource,{seedAfter41:true,with43:false})
 try{
  await f.args.updateChat(f.chatId,now=>{now.timeline.operations.op42.status='running';return now},{source:'fixture.body-interrupted'})
  assert.equal(f.lastTurn(),42,'前置：事件尾必须是 42')
  const interrupted=await f.read()
  assert.equal(interrupted.timeline.operations.op42.status,'running','前置：op42 必须仍 running')
  assert.ok(interrupted.timeline.operations.op42.businessBefore,'前置：running 候选必须带完整基准')
  const window0=await f.openingWindow()
  assert.ok(window0&&window0.nativeData===true,'视图必须走真 opening 窗口')
  assert.equal(window0.failureCleanup.cleanable,true,'窄 SQL 摘要必须把 running 候选判为可清：'+String(window0.failureCleanup.reason))
  assert.equal(window0.failureCleanup.operationId,'op42','窄摘要必须指向 op42')
  assert.equal(Number(window0.failureCleanup.turn),42)
  const target=(await f.view()).failureTarget
  assert.ok(target,'running 候选必须能签目标')
  assert.equal(target.operationId,'op42','签发的必须是窄窗 42 目标')
  assert.equal(target.turn,42)
  assert.equal(target.kind,'rollback','running 目标必须来自统一窄窗（非 native-only）')
  assert.equal(target.eventCount,undefined,'窄窗目标不得带 native 坐标')
  const beforeClean=await f.read()
  const cleaned=await cleanRollback({...await f.fresh(),requestedTurn:target})
  assert.equal(cleaned.turn,41,'running 候选清理后必须停在正文 41')
  assert.equal(f.eventsFrom(f.keep41),0,'42 的事件尾必须物理删除')
  assert.equal(f.eventCount(),f.keep41,'事件数必须回到 41 边界')
  assert.equal(f.lastTurn(),41,'事件尾轮必须停在 41')
  const final=await f.read()
  assert.equal(final.timeline.operations.op42,undefined,'42 的 operation 必须被清')
  assert.deepEqual(final.messages,beforeClean.messages,'正文必须等于清理前（不变量）')
  assert.equal(final.messages.length,57)
  assert.deepEqual(final.variables,beforeClean.variables,'变量必须按基准恢复/不变')
  assert.equal(f.agents.get(f.session.id).phase.lastTurn,41,'内存 phase.lastTurn 必须回拨到 41')
  assert.equal([...f.handles][0].state.cursor,f.keep41,'句柄游标必须回卷到 41 边界')
  assert.equal(f.args.services.projections.stateOf(f.session,'turnBoundary').lastTurn,41,'投影必须重算为 41')
  assert.equal(f.syncFrames.length,1,'清理必须 publish 一次')
  assert.equal(f.syncFrames.at(-1).value.hiddenTurn,42)
 }finally{await f.cleanup()}

})
