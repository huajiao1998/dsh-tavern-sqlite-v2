// 唯一物理回退：只定位最新发送和删尾范围，不审成功/失败/完整性资格。
// Chat与Session分库；rollbackPending只收敛真实清理失败，完成后交作者纯自愈修复上下文。
import {randomUUID} from 'node:crypto'
import {restoreRollbackBusinessState,resolveRollbackBusinessState} from './rollback-business-state.js'
import {latestSendRecord} from './latest-send.js'
import {foregroundInboxBoundary} from './foreground-inbox-boundary.js'
import {preflightRollbackAtSeq,cleanupAfterRollbackAtSeq,rebuildSessionProjections} from './rollback-cleanup.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from './rollback-barrier.js'
export {withNativeOpening} from './send-acceptance.js'
export {latestSendTarget} from './latest-send.js'
export {createRollbackOperationScope} from './rollback-operation-scope.js'
// 旧公开导出保留，但不再参与物理清理对象的判断。
export {inspectNativeFailureTail} from './failure-cleanup-target.js'
export {readFailureEvidence} from './failure-view-evidence.js'

function resolveForegroundCut(session,record,chat,options) {
 const events=session.snapshotEvents(),turn=record.turn
 const start=events.find(event=>event.type==='turn/start' && Number(event.data?.turn)===turn)
 const first=events.find(event=>Number(event?.data?.turn)===turn)
 if(start) {
  const input=foregroundInboxBoundary(events,turn,start.seq,chat)
  return preflightRollbackAtSeq(session,input.boundarySeq,{...options,foregroundExact:true})
 }
 // 无标准start时优先沿实际轮片段；旧坐标落进保留历史时不拿它当删尾位置。
 if(first) {
  const prior=events.findLast(event=>event.seq<first.seq && Number(event.data?.turn)>0 && Number(event.data.turn)<turn)
  const inputs=[record.nativeAnchor?.input,record.source?.nativeStartSeq,record.nativeStartSeq].filter(seq=>Number.isSafeInteger(seq) && seq>(prior?.seq ?? -1) && seq<first.seq && events[seq]?.type==='user/message')
  return preflightRollbackAtSeq(session,Math.min(first.seq,...inputs)-1,{...options,foregroundExact:true})
 }
 const startSeq=record.source?.nativeStartSeq ?? record.nativeStartSeq
 const prior=events.findLast(event=>Number(event?.data?.turn)>0 && Number(event.data.turn)<turn)
 if(Number.isSafeInteger(startSeq) && startSeq>(prior?.seq ?? -1) && startSeq<=session.seq)return preflightRollbackAtSeq(session,startSeq-1,{...options,foregroundExact:true})
 return preflightRollbackAtSeq(session,events.at(-1)?.seq ?? -1,{...options,foregroundExact:true})
}
async function acquire(sessions,id,persistence) {
 const agent=sessions.get(id),session=agent?.session || sessions.getSession?.(id)
 if(session)return {agent,session,cold:!agent}
 return {agent:undefined,session:await persistence.loadRollbackSession(id),cold:true}
}
async function stop(agent) {
 if(!agent)return
 if(agent.phase?.kind!=='idle') { agent.cancel?.({kind:'parent'});await agent.whenIdle?.() }
 if(agent.phase?.kind==='running')throw Error('实际运行任务尚未停止，回退尚未完成')
}

export async function cleanRollback({chat,requestedTurn,readChat,updateChat,chats,sessions,persistence,services={},quiesce,sideCleanup,view,readCard,repairNative,failureTarget=null}) {
 // 请求只用于同一次清理的重试，不决定对象形态/资格；清理轮次来自停止后的权威当前态。
 const request=failureTarget ?? requestedTurn
 const requested=Number(request && typeof request==='object'?request.turn:request)
 const completedRequest=record=>{
  if(!record)return false
  if(request?.rollbackId)return request.rollbackId===record.id
  if(requested!==record.turn)return false
  const saved=record.ordinaryTarget || record.failureTarget
  // 这里只认同一次RPC重传，不认证当前对象；缺这些字段仍能正常清理最新轮。
  return request?.branchId!==undefined && request?.revision!==undefined && request.branchId===saved?.branchId && request.revision===saved?.revision
 }
 // RPC路由已解析当前档；只核明确提供的档/会话，缺字段不构成对象资格。
 if((request?.chatId && request.chatId!==chat.id) || (request?.sessionId && request.sessionId!==chat.sessionId))throw Error('回退请求不属于当前存档/会话')
 const leases=new Map(),stopped=new WeakSet()
 let cancelRelease,ownsScheduling=false
 const load=async id=>{if(!leases.has(id))leases.set(id,await acquire(sessions,id,persistence));return leases.get(id)}
 const stopOnce=async agent=>{if(agent && stopped.has(agent))return;await stop(agent);if(agent)stopped.add(agent)}
 const recoveryReceipt=record=>{
  const recovery=record.recovery || {status:'complete',unavailableFields:[],uncutParticipants:[]}
  const parts=[]
  if(recovery.unavailableFields?.length)parts.push('缺少历史值，未恢复：'+recovery.unavailableFields.join('、'))
  if(recovery.uncutParticipants?.length)parts.push('缺少后台历史切点：'+recovery.uncutParticipants.map(item=>item.role || item.sessionId).join('、'))
  return {recovery,...(parts.length?{rollbackWarning:'前台已物理回退；'+parts.join('；')}:{})}
 }
 const syncResult=async record=>{
  const latest=await readChat(chat.id)
  const subjects=[]
  for(const cut of record.cuts)subjects.push(await load(cut.sessionId))
  const result=Object.assign(await view(latest,await readCard(latest)),recoveryReceipt(record))
  if(latest.nativeSync?.status==='stale')result.rollbackWarning=[result.rollbackWarning,'本轮已清理；模型上下文待酒馆自愈'].filter(Boolean).join('；')
  const sync=services.rollbackSyncProvider().publish({chat:latest,rollbackId:record.id,hiddenTurn:record.turn,subjects})
  result.rolledBack={hiddenTurn:record.turn,cleanedFailureTarget:record.failureTarget ?? record.ordinaryTarget ?? null,recovery:record.recovery || {status:'complete',unavailableFields:[],uncutParticipants:[]},sync:{protocol:sync.protocol,id:sync.id,chatId:sync.chatId,revision:sync.revision}}
  return result
 }
 const repairAfterCleanup=async record=>{
  if(typeof repairNative!=='function')return syncResult(record)
  for(const cut of record.cuts)await load(cut.sessionId)
  // 物理阶段的写屏障已解除；沿用调度暂停，不让新发送插进修复与最终同步之间。
   const main=await load(chat.sessionId)
   try {
    let repairError
    try {await repairNative(chat.sessionId,main.session)} catch(error) {repairError=error}
    if(repairError)await updateChat(chat.id,current=>{current.nativeSync={status:'stale',reason:String(repairError?.message || repairError),at:Date.now()};return current},{source:'native-repair.stale'})
    // 修复上次在flush失败后留下的内存事件；作者本次无需追加也仍要落库。
    await sessions.flush(main.session)
   }
   catch(error) {
    await updateChat(chat.id,current=>{current.nativeSync={status:'stale',reason:String(error?.message || error),at:Date.now()};return current},{source:'native-repair.stale'})
    throw error
   }
  // 冷装载Session也没有宿主事件订阅；显式刷新修复后投影/缓存再发同连接基线。
  for(const cut of record.cuts) {
   const item=await load(cut.sessionId)
   rebuildSessionProjections(services.projections,item.session)
   await services.projectionCache.write(item.session)
  }
  // 自愈可追加修复事件、更新锚点和Chat版本；完成回执必须采用修复后的实际状态。
  await updateChat(chat.id,current=>{
   const cuts=record.cuts.map(cut=>({...cut,boundarySeq:leases.get(cut.sessionId).session.snapshotEvents().at(-1)?.seq ?? -1}))
   current.rollbackCompletion={...record,cuts,revision:current._storageRevision+1,branchId:current.timeline?.branchId}
   return current
  },{source:'rollback.complete'})
  return syncResult(record)
 }
 try {
  const main=await load(chat.sessionId)
  chat=await readChat(chat.id)
  const prior=chat.rollbackCompletion
  const sameAction=completedRequest(prior)
  if(!chat.rollbackPending && sameAction) {
   const latest=latestSendRecord(chat,{events:main.session.snapshotEvents()})
   if(latest && latest.turn>=prior.turn) {
    // 已完成请求的重传不取消复用同轮号的新发送，也不再次删尾。
    return {...await view(chat,await readCard(chat)),changed:false,rolledBack:{alreadyClean:true,hiddenTurn:prior.turn}}
   }
  }
  if(typeof services.cancelPendingOperations==='function')cancelRelease=await services.cancelPendingOperations(chat.sessionId)
  else {
   if(rollbackSchedulingBarrier.has(chat.sessionId))throw Error('回退正在执行，请等待本次清理完成')
   rollbackSchedulingBarrier.add(chat.sessionId);ownsScheduling=true
  }
  await stopOnce(main.agent);await quiesce(chat)
  if(typeof services.finishCancelledOperations==='function')await services.finishCancelledOperations(await readChat(chat.id))
  chat=await readChat(chat.id)
  let pending=chat.rollbackPending
  const completed=chat.rollbackCompletion
  const currentRecord=latestSendRecord(chat,{events:main.session.snapshotEvents()})
  const sameCompleted=completedRequest(completed) || (completed && requested===completed.turn && (!currentRecord || currentRecord.turn<completed.turn))
  if(!pending && sameCompleted) {
   // 新发送已开始时只补发旧清理回执，不取消新轮、更不按旧目标再截一次。
   if(currentRecord && currentRecord.turn>=completed.turn)return await syncResult(completed)
   return await repairAfterCleanup(completed)
  }
  if(!pending) {
   if(!main.cold)await sessions.flush(main.session)
   const record=latestSendRecord(chat,{events:main.session.snapshotEvents()})
   // 同一旧请求在目标已删时不允许再删上一轮。新按钮会拿当前最新轮的坐标。
   if(!record || (requested>0 && requested!==record.turn)) {
    const result=await view(chat,await readCard(chat))
    return {...result,changed:false,alreadyClean:true,rolledBack:{alreadyClean:true,hiddenTurn:requested || null,cleanedFailureTarget:request && typeof request==='object'?request:null}}
   }
   const turn=record.turn
   const baseline=resolveRollbackBusinessState(chat,turn,record.source || undefined)
   if(Object.hasOwn(baseline,'worldbookRef')) {
    try {
     const book=chats.readRollbackWorldbook(chat,baseline.worldbookRef)
     if(book===undefined || book?.then)throw Error('没有同步历史值')
     baseline.fields.openingWorldbookSnapshot=book
    } catch {
     baseline.preserveFields=[...(baseline.preserveFields || []),'openingWorldbookSnapshot']
     baseline.unavailable=[...new Set([...(baseline.unavailable || []),'openingWorldbookSnapshot'])]
    }
    delete baseline.worldbookRef
   }
   const foreground=resolveForegroundCut(main.session,record,chat,{persistence,services:{...services,coldRollback:main.cold,agentProvider:()=>main.agent},head:chats})
   const cuts=[{sessionId:chat.sessionId,boundarySeq:foreground.boundarySeq,role:null}]
   const beforeParticipants=structuredClone(baseline.participants || {}),currentParticipants=chat.timeline?.participants || {}
   const resetParticipants=[]
   const recordedCuts={}
   for(const [ownerTurn,entries] of Object.entries(chat.rollbackSessionCuts || {})) {
    if(Number(ownerTurn)<turn)continue
    for(const [id,boundary] of Object.entries(entries || {}))if(Number.isSafeInteger(boundary))recordedCuts[id]=Object.hasOwn(recordedCuts,id)?Math.min(recordedCuts[id],boundary):boundary
   }
   const participants=new Map()
   for(const [role,current] of Object.entries(currentParticipants))if(current?.sessionId)participants.set(current.sessionId,{role,old:beforeParticipants[role]})
   for(const [role,old] of Object.entries(beforeParticipants))if(old?.sessionId)participants.set(old.sessionId,{role,old})
   for(const [id,boundary] of Object.entries(recordedCuts))participants.set(id,{...participants.get(id),boundary})
   for(const [id,op] of Object.entries(chat.timeline?.operations || {}))if(!baseline.operationIds.includes(id) && op.startedSessionId && op.startedSessionId!==chat.sessionId && !participants.has(op.startedSessionId))participants.set(op.startedSessionId,{})
   for(const [id,item] of participants) {
    if(id===chat.sessionId)continue
    const lease=await load(id);await stopOnce(lease.agent)
    if(!lease.cold)await sessions.flush(lease.session)
    const known=[item.boundary,item.old?.sessionId===id?item.old.boundary:undefined].filter(value=>Number.isSafeInteger(value) && value>=-1 && value<lease.session.seq)
    // 没有真实切点不能猜删后台历史；记录未清理对象，前台清理继续完成。
    if(!known.length) {
     resetParticipants.push({sessionId:id,role:item.role ?? null,uncut:true})
     continue
    }
    const plan=preflightRollbackAtSeq(lease.session,Math.min(...known),{persistence,services:{...services,coldRollback:lease.cold,agentProvider:()=>lease.agent},head:chats})
    cuts.push({sessionId:id,boundarySeq:plan.boundarySeq,role:item.role ?? null})
   }
   const archive=chats.rollbackArchivePath(chat.id)
   for(const cut of cuts)await persistence.bindRollbackArchive(cut.sessionId,archive)
   const next=structuredClone(chat)
   restoreRollbackBusinessState(next,baseline,structuredClone,chats.readRollbackWorldbook,chats.readRollbackOperationSnapshot,{allowUnavailable:true})
   next.messages=(next.messages || []).slice(0,baseline.messageCount)
   const branchId=randomUUID()
   next.timeline={...next.timeline,branchId,revision:Number(chat.timeline?.revision || 0)+1,checkpoints:(next.timeline?.checkpoints || []).filter(cp=>Number(cp.turn)<turn),participants:{...beforeParticipants}}
   for(const cut of cuts)if(cut.role!==null && beforeParticipants[cut.role]?.sessionId===cut.sessionId) {
    const retained=beforeParticipants[cut.role]
    next.timeline.participants[cut.role]={...retained,role:cut.role,sessionId:cut.sessionId,branchId,boundary:cut.boundarySeq,rewindTo:null,status:'current',syncedRevision:next.timeline.revision}
   }
   for(const item of resetParticipants) {
    // 无真实切点保留后台Session历史；无论是否能按role展示，都删除新分支对该Session的operation引用，避免复用旧上下文。
    if(item.uncut && item.role && (next.timeline.participants[item.role]?.sessionId===item.sessionId || (!next.timeline.participants[item.role]?.sessionId && currentParticipants[item.role]?.sessionId===item.sessionId))) {
     next.timeline.participants[item.role]={...(next.timeline.participants[item.role] || currentParticipants[item.role]),role:item.role,sessionId:'',branchId,boundary:null,rewindTo:null,status:'needs-session',syncedRevision:null}
    }
    for(const [id,op] of Object.entries(next.timeline.operations || {}))if(op.startedSessionId===item.sessionId)delete next.timeline.operations[id]
   }
   next.tavernHelperLifecycleRevision=Number(chat.tavernHelperLifecycleRevision || 0)+1
   if(typeof repairNative==='function')next.nativeSync={status:'stale',reason:'物理回退后按存档修复',at:Date.now()}
   const failure=request && typeof request==='object' && request.kind!=='rollback'?request:null
   pending={version:1,id:randomUUID(),turn,cuts,recovery:{status:baseline.unavailable?.length || resetParticipants.some(item=>item.uncut)?'partial':'complete',unavailableFields:baseline.unavailable || [],uncutParticipants:resetParticipants.filter(item=>item.uncut),resetParticipants},...(failure?{failureTarget:{...failure,turn}}:{ordinaryTarget:request && typeof request==='object'?request:{kind:'rollback',turn,chatId:chat.id,sessionId:chat.sessionId}})}
   delete next.rollbackCompletion;delete next.rollbackUndo
   next.rollbackPending=pending
   // 同连接SQL事务自带版本交换；不再对对象做另一份深比较/完整度认证。
   await updateChat(chat.id,current=>{
    if(current._storageRevision!==chat._storageRevision)throw Error('回退写入期间存档已变化，请重试当前清理')
    return next
   },{source:'rollback.prepare'})
  }
  for(const cut of pending.cuts) {rollbackBarrier.add(cut.sessionId);await persistence.setRollbackPending(cut.sessionId,true)}
  for(const cut of pending.cuts) {
   const item=await load(cut.sessionId);await stopOnce(item.agent)
   await cleanupAfterRollbackAtSeq(persistence,item.session,cut.boundarySeq,{...services,coldRollback:item.cold,agentProvider:()=>item.agent},{head:chats,foregroundExact:true,...(cut.sessionId===chat.sessionId?{retainedBodyEdits:{chat:await readChat(chat.id),turn:pending.turn}}:{})})
   if(!item.cold)await sessions.flush(item.session)
  }
  const prepared=await readChat(chat.id)
  if(prepared.messages?.some(row=>Number(row.turn)>=pending.turn))throw Error('本次清理正文尾部仍在，不能报告完成')
  await sideCleanup(prepared,pending.turn,pending.cuts)
  for(const cut of pending.cuts)await persistence.setRollbackPending(cut.sessionId,false)
  await updateChat(chat.id,current=>{
   current.rollbackCompletion={...pending,cuts:pending.cuts.map(cut=>({...cut,boundarySeq:leases.get(cut.sessionId).session.snapshotEvents().at(-1)?.seq ?? -1})),revision:current._storageRevision+1,branchId:current.timeline?.branchId}
   delete current.rollbackPending;delete current.rollbackUndo
   return current
  },{source:'rollback.complete'})
  for(const cut of pending.cuts)rollbackBarrier.delete(cut.sessionId)
  return await repairAfterCleanup(pending)
 } finally {
  // 实际物理失败仍保留持久pending，重试接着同一边界，不把对象形态当资格。
  if(cancelRelease)cancelRelease();else if(ownsScheduling)rollbackSchedulingBarrier.delete(chat.sessionId)
 }
}
