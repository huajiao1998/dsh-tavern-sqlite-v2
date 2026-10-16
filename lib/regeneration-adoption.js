// 重生成沿作者生成器；本模块只负责同轮物理采用与本次失败恢复，不留整档旧revision。
import {isDeepStrictEqual} from 'node:util'
import {planRegenerationEvents} from './regeneration-events.js'
import {captureRollbackBusinessState,restoreRollbackBusinessState} from './rollback-business-state.js'
import {rewindSessionMemory,rebuildSessionProjections} from './rollback-cleanup.js'
import {rewindRuntimeTurnCounter,rewindRuntimeAgentState,cleanupTokenMeterState} from '../rollback-layers.js'
import {rollbackSchedulingBarrier,rollbackBarrier,rollbackCancellationBarrier} from './rollback-barrier.js'

const copy=structuredClone
const fail=message=>{throw new Error('正文物理采用：'+message)}
export function createRegenerationAdoption({chats,sessions,timeline,sessionPatch,persistenceProvider,projectionsProvider,projectionCacheProvider,tokenMeterProvider,rollbackSyncProvider,quiesceRollback,cleanupRollbackSides}){
 const read=chats.read,update=chats.update
  const readOperation=chats.readRollbackOperationSnapshot
 function wiring(session){
  const persistence=persistenceProvider?.(),projections=projectionsProvider?.(),projectionCache=projectionCacheProvider?.(),agent=sessions.get(session.id)
  if(typeof persistence?.replaceRegeneratedTail!=='function'||typeof persistence.drainOpenHandles!=='function'||typeof persistence.bindRollbackArchive!=='function'||typeof chats.rollbackArchivePath!=='function')fail('缺少原生SQL尾替换接口')
  if(typeof sessionPatch?.restoreStoredSession!=='function'||!projections?.registrations||typeof projections.hydrate!=='function'||typeof projections.stateOf!=='function'||typeof projectionCache?.write!=='function')fail('缺少真实Session预检/投影接线')
  if(agent?.session!==session||agent.phase?.kind==='running'||!Array.isArray(agent.inbox?.nextTurn)||!Array.isArray(agent.inbox?.nextStep))fail('前台未静止或身份/队列不完整')
  if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length)fail('已有后续输入，拒绝替换')
  const services={projections,projectionCache,agentProvider:()=>agent,tokenMeterProvider,requireAuxiliary:true}
  if(!tokenMeterProvider?.()?.states||typeof rollbackSyncProvider?.()?.publish!=='function')fail('缺少token与同连接同步接线')
  rollbackSyncProvider().assertReady()
  return {persistence,services,agent}
 }
 async function prepare(chat,selection){
  const session=sessions.get(chat.sessionId)?.session
  if(!session)fail('会话未加载')

  if(rollbackSchedulingBarrier.has(chat.sessionId))fail('已有回退或替换操作')
  rollbackSchedulingBarrier.add(chat.sessionId)
  try{
   if(typeof quiesceRollback!=='function')fail('缺少旧任务静止接口')
   await quiesceRollback(chat)
   await sessions.flush(session)
   wiring(session)
   await persistenceProvider().bindRollbackArchive(session.id,chats.rollbackArchivePath(chat.id))
   const latest=await read(chat.id)
   if(latest?.sessionId!==chat.sessionId||latest.timeline?.branchId!==chat.timeline?.branchId||latest.regenInProgress||!isDeepStrictEqual(latest.messages,chat.messages))fail('旧任务收尾期间正文目标已变化，请重试')
   // 保存点击前完成态与原轮输出，只用于未采用失败恢复；前轮消息不复制。
   const index=selection.oldAssistantIndex,events=session.snapshotEvents(),start=events.findIndex(e=>e.type==='turn/start'&&e.data?.turn===selection.oldTurn)
   const users=events.slice(start+1,selection.oldSeq).filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user')
   if(start<0||users.length!==1||index!==latest.messages.length-1)fail('原轮不是唯一最新用户/正文尾')
   const keep=users[0].seq+1
   for(const e of events.slice(keep))if((e.type==='user/message'&&e.data?.source?.kind==='user')||e.type==='turn/start')fail('原正文之后已有独立轮次')
   return {chat:latest,record:{version:1,turn:selection.oldTurn,oldSeq:selection.oldSeq,keep,eventStart:events.length,sessionId:chat.sessionId,
    business:captureRollbackBusinessState(latest),pair:copy(latest.messages.slice(index-1)),
    timeline:{...copy(Object.fromEntries(Object.entries(latest.timeline).filter(([k])=>!['operations','checkpoints'].includes(k)))),
     operations:copy(Object.fromEntries(Object.entries(latest.timeline.operations||{}).filter(([,op])=>Number(op.turn)>=selection.oldTurn))),
     checkpoints:copy((latest.timeline.checkpoints||[]).filter(cp=>Number(cp.turn)>=selection.oldTurn))}}}
  }finally{if(!rollbackCancellationBarrier.has(chat.sessionId))rollbackSchedulingBarrier.delete(chat.sessionId)}
 }
 function original(current,record){
  if(record?.version!==1||record.sessionId!==current.sessionId||record.pair?.length!==2||record.pair[0].role!=='user'||record.pair[1].role!=='assistant')fail('恢复身份/原正文基准无效')
  const prefix=record.business.messageCount-2
  if(current.messages.length<prefix)fail('前轮消息前缀缺失')
  const next=copy(current)
  next.messages=copy(current.messages.slice(0,prefix)).concat(copy(record.pair))
  next.timeline={...copy(record.timeline),operations:{...Object.fromEntries(Object.entries(current.timeline?.operations||{}).filter(([,op])=>Number(op.turn)<record.turn)),...copy(record.timeline.operations)},checkpoints:[...(current.timeline?.checkpoints||[]).filter(cp=>Number(cp.turn)<record.turn),...copy(record.timeline.checkpoints)]}
  restoreRollbackBusinessState(next,record.business,copy,chats.readRollbackWorldbook,readOperation)
  delete next.regenInProgress;delete next.regenRecovery
  return next
 }
 function adopted(next,{oldTurn,syntheticTurn,generatedAssistant,originalAssistant,adoption}){
  const merged=next.messages.at(-1)
  if(!generatedAssistant||generatedAssistant.role!=='assistant')fail('缺少确切的新正文')
  // 不继承旧正文特有字段/旧回执；保新产物，逻辑身份归原turn。
  const message={...copy(generatedAssistant),turn:oldTurn,swipeId:0,swipes:copy(merged.swipes),variables:copy(merged.variables)}
   // nativeAnchor（上游 537e878 round-anchor.js）：新正文来自临时轮，generatedAssistant 携带的锚点指向
   // 临时轮的输入/回复序号；而本轮的物理采用会重映射输出序号、且不重放临时输入事件。
   // 必须用**同一份采用计划**算出的真实坐标覆盖；证不明就删，不留指向别一代的假锚点。
   // 时序：commit 先写本行、complete() 才替换 SQL 尾，两者坐标同源；recover() 重试后即一致。
   if(adoption?.anchor&&adoption.anchor.turn===oldTurn&&Number.isSafeInteger(Number(adoption.anchor.input))&&Number.isSafeInteger(Number(adoption.anchor.reply)))message.nativeAnchor=copy(adoption.anchor)
   else delete message.nativeAnchor
  next.messages[next.messages.length-1]=message
  if(message?.role!=='assistant'||message.turn!==oldTurn)fail('采用正文不在原轮')
  if(originalAssistant?.mvuBaseline && typeof originalAssistant.mvuBaseline==='object') message.mvuBaseline=copy(originalAssistant.mvuBaseline)
   else delete message.mvuBaseline
  // 临时 followup 可能只产生纯正文；原轮若启用了官方MVU，仍须为新正文建立全新的待结算目标。
   if(originalAssistant?.mvu || message.mvu) {
    const guidance=message.mvu?.guidance ?? originalAssistant?.mvu?.guidance
    message.mvu={pending:true,modified:false,diagnostics:[],events:[],...(guidance===undefined?{}:{guidance:copy(guidance)})}
   } else delete message.mvu
  // 删除临时轮别名；账本及本轮运行条目归回原turn，不生成隐藏映射。
  for(const [id,op] of Object.entries(next.timeline.operations||{}))if(Number(op.turn)===syntheticTurn) {
    // 临时轮前像是重生成前的完成态，不能改号冒充原剧情轮发送前的基准。
    // 原轮body/checkpoint已由retain保留；临时body删净，运行条目仍归原turn。
    if(op.kind==='body')delete next.timeline.operations[id]
    else op.turn=oldTurn
   }
  next.timeline.checkpoints=(next.timeline.checkpoints||[]).filter(cp=>Number(cp.turn)!==syntheticTurn)
  for(const key of ['nativeCommits','runtimeInputs','foregroundFrames','rollbackSessionCuts']){
   const value=next[key]
   if(!value||typeof value!=='object')continue
   if(Object.hasOwn(value,String(syntheticTurn))){value[String(oldTurn)]=value[String(syntheticTurn)];delete value[String(syntheticTurn)]}
   for(const item of Object.values(value))if(item&&typeof item==='object'&&Number(item.turn)===syntheticTurn)item.turn=oldTurn
  }
  next.suppressedDshTurns=(next.suppressedDshTurns||[]).filter(turn=>turn!==syntheticTurn&&turn!==oldTurn)
  if(next.regeneratedDshTurns){delete next.regeneratedDshTurns[String(oldTurn)];delete next.regeneratedDshTurns[String(syntheticTurn)]}
  return next
 }
 function preview(session,keep,events){
  const full=session.snapshotEvents().slice(0,keep).concat(events)
  return sessionPatch.restoreStoredSession({header:session.header,events:full,inheritedEventCount:session.inheritedEventCount})
 }
 async function replaceNative(session,keep,expected,output){
  const {persistence,services,agent}=wiring(session)
  preview(session,keep,output)
  await persistence.drainOpenHandles(session.id)
  const meta=await persistence.replaceRegeneratedTail(session.header,keep,expected,output)
  if(meta?.eventCount!==keep+output.length)fail('SQL替换回执不匹配')
  rewindSessionMemory(session,keep)
  // 已在同SQL事务持久化；不触发普通session append监听造成重复写。
  for(const event of output)session.log.push(copy(event))
  rewindSessionMemory(session,keep+output.length)
  rebuildSessionProjections(services.projections,session)
  await services.projectionCache.write(session)
  rewindRuntimeTurnCounter(session,services);rewindRuntimeAgentState(session,services);cleanupTokenMeterState(session,services)
  return {session,agent}
 }
 function publishCompletion(chat,session){
  const done=chat.regenerationCompletion
  if(done?.version!==1||done.sessionId!==session.id||done.revision!==chat._storageRevision||done.branchId!==chat.timeline?.branchId||done.eventCount!==session.seq)fail('完成凭据已过期，拒绝补发旧基线')
  const {agent}=wiring(session)
  rollbackSyncProvider().publish({chat,rollbackId:done.id,hiddenTurn:done.turn,subjects:[{session,agent}]})
  return chat
 }
 async function completeInner({chatId,session,operationId,quiet=false}){
  const chat=await read(chatId),saved=chat?.regenRecovery
  if(!saved||saved.id!==operationId||saved.phase!=='committed')return
  if(saved.sessionId!==session.id||saved.adoption?.version!==1)fail('物理采用意图缺失或异会话')
  try{
   const {keep,expected,output}=saved.adoption
   await replaceNative(session,keep,expected,output)
   if(typeof cleanupRollbackSides!=='function')fail('缺少本档运行副状态清理接线')
   await cleanupRollbackSides(chat,saved.turn,[{sessionId:session.id,boundarySeq:keep-1}])
   const done=await update(chatId,current=>{
    if(current.regenRecovery?.id!==operationId||current.regenRecovery.phase!=='committed'||current.timeline?.branchId!==chat.timeline?.branchId)fail('物理采用完成身份已变化')
    current.regenerationCompletion={version:1,id:operationId,turn:saved.turn,sessionId:session.id,revision:Number(current._storageRevision)+1,branchId:current.timeline?.branchId,eventCount:session.seq}
    delete current.regenRecovery;delete current.regenInProgress
    return current
   },{source:'foreground.regen-projected'})
   if(!quiet)publishCompletion(done,session)
   return done
  }finally{ /* exclusive拥有屏障，内层不得释放 */ }
 } async function abortInner({chatId,session,operationId,quiet=false}){
  const chat=await read(chatId),saved=chat?.regenRecovery
  if(!saved||saved.id!==operationId||saved.phase==='committed')return
  if(saved.sessionId!==session.id)fail('恢复会话不匹配')
  original(chat,saved.restore);const events=session.snapshotEvents()
  for(const e of events.slice(saved.eventStart))if((e.type==='user/message'&&e.data?.source?.kind==='user')||(e.type==='turn/start'&&e.data.turn>Number(sessions.get(session.id)?.phase?.lastTurn)))fail('尝试之后已有玩家输入')
  // 原输出尚未删，只删除本次尝试尾；不追加空消息或隐藏标记。
  const subject=await replaceNative(session,saved.eventStart,events.slice(saved.eventStart),[])
  const done=await update(chatId,current=>{
   if(current.regenRecovery?.id!==operationId||current.regenRecovery.phase==='committed')fail('失败恢复目标已变化')
   const next=original(current,saved.restore)
   next.tavernHelperLifecycleRevision=Number(current.tavernHelperLifecycleRevision||0)+1
   return next
  },{source:'foreground.regen-abort'})
  if(!quiet)rollbackSyncProvider().publish({chat:done,rollbackId:operationId,hiddenTurn:saved.restore.turn,subjects:[subject]})
  return done
 }
 async function recover(chatId){
  const chat=await read(chatId),saved=chat?.regenRecovery,completion=chat?.regenerationCompletion
  if(!saved&&!completion)return
  const sessionId=saved?.sessionId||completion?.sessionId
  const agent=sessions.get(sessionId)
  if(agent?.phase?.kind==='running')return
  if(!agent?.session)fail('恢复需加载同一原生会话，意图已保留')
  if(completion) return publishCompletion(chat,agent.session)
  if(saved.restore?.version!==1)fail('旧重生成记录缺少SQL恢复基准，未修改数据')
  return saved.phase==='committed'?complete({chatId,session:agent.session,operationId:saved.id}):abort({chatId,session:agent.session,operationId:saved.id})
 }function plan(session,{oldTurn,syntheticTurn,eventStart,oldSeq,chatId}){
  const events=session.snapshotEvents(),planned=planRegenerationEvents({events,oldTurn,syntheticTurn,eventStart,oldAssistantSeq:oldSeq,chatId})
  const output=planned.events.map((e,i)=>({...e,seq:planned.keep+i,time:events[eventStart]?.time||Date.now()}))
  preview(session,planned.keep,output)
  return {version:1,keep:planned.keep,anchor:planned.anchor??null,expected:copy(events.slice(planned.keep)),output}
 }
  // 只合流同会话的物理采用，回退等待它结束，不检查租约或所有者。
  const activeAdoptions=new Map()
  function exclusive(input,work){
   const id=input.session.id
   if(activeAdoptions.has(id))return activeAdoptions.get(id)
   rollbackSchedulingBarrier.add(id);rollbackBarrier.add(id)
   const done=Promise.resolve().then(()=>work(input)).finally(()=>{
    activeAdoptions.delete(id);rollbackBarrier.delete(id)
    if(!rollbackCancellationBarrier.has(id))rollbackSchedulingBarrier.delete(id)
   })
   activeAdoptions.set(id,done)
   return done
  }
  const complete=input=>exclusive(input,completeInner)
  const abort=input=>exclusive(input,abortInner)
 async function cancelForRollback(chatId,sessionId){
   const current=await read(chatId),saved=current?.regenRecovery
   if(!saved)return
   // 旧档没有恢复记录不伪造；外层仍可按真实原生尾和已有前像进行部分回退。
   if(saved.restore?.version!==1)return
   const session=sessions.get(sessionId)?.session
   await activeAdoptions.get(sessionId)
   rollbackBarrier.add(sessionId)
   try{
    const restored=await (saved.phase==='committed'?completeInner:abortInner)({chatId,session,operationId:saved.id,quiet:true})
    return {chatId,sessionId,turn:saved.turn,fromBranch:current.timeline?.branchId,toBranch:restored?.timeline?.branchId}
   }
   finally{rollbackBarrier.delete(sessionId)}
  }
  return Object.freeze({prepare,adopted,plan,complete,abort,recover,cancelForRollback})
}
