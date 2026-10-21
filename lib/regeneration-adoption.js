// 沿作者目标/生成/替换/结算流程，只适配SQL物理采用及本次失败恢复。
import {isDeepStrictEqual} from 'node:util'
import {planRegenerationEvents} from './regeneration-events.js'
import {captureRollbackBusinessState,restoreRollbackBusinessState} from './rollback-business-state.js'
import {rewindSessionMemory,rebuildSessionProjections} from './rollback-cleanup.js'
import {rewindRuntimeTurnCounter,rewindRuntimeAgentState,cleanupTokenMeterState} from '../rollback-layers.js'
import {rollbackSchedulingBarrier,rollbackBarrier,rollbackCancellationBarrier} from './rollback-barrier.js'

const copy=structuredClone
const fail=message=>{throw new Error('正文物理采用：'+message)}
export function createRegenerationAdoption({chats,sessions,persistenceProvider,projectionsProvider,projectionCacheProvider,tokenMeterProvider,rollbackSyncProvider,quiesceRollback,cleanupRollbackSides,queueSettlement}){
 const read=chats.read,update=chats.update,readOperation=chats.readRollbackOperationSnapshot
 function wiring(session){
  const persistence=persistenceProvider(),projections=projectionsProvider(),projectionCache=projectionCacheProvider(),agent=sessions.get(session.id)
  if(agent?.session!==session||agent.phase?.kind==='running')fail('前台未静止或会话已变化')
  if(agent.inbox.nextTurn.length||agent.inbox.nextStep.length)fail('已有后续输入，拒绝替换')
  return {persistence,services:{projections,projectionCache,agentProvider:()=>agent,tokenMeterProvider,requireAuxiliary:true},agent}
 }
 async function prepare(chat,selection){
  const session=sessions.get(chat.sessionId).session
  rollbackSchedulingBarrier.add(chat.sessionId)
  try{
   await quiesceRollback(chat)
   await sessions.flush(session)
   await persistenceProvider().bindRollbackArchive(session.id,chats.rollbackArchivePath(chat.id))
   const latest=await read(chat.id)
   if(latest?.sessionId!==chat.sessionId||latest.timeline?.branchId!==chat.timeline?.branchId||!isDeepStrictEqual(latest.messages,chat.messages))fail('旧任务收尾期间正文目标已变化，请重试')
   // 作者已选定玩家/正文对；只保存失败恢复所需字段，不再逐项审查事件资格。
   return {chat:latest,record:{version:1,turn:selection.oldTurn,eventStart:session.seq,sessionId:chat.sessionId,
    business:captureRollbackBusinessState(latest),pair:copy(latest.messages.slice(selection.oldAssistantIndex-1)),
     previousRange:latest.regenerationCompletion?.turn===selection.oldTurn?copy(latest.regenerationCompletion.attemptRange):undefined,
    timeline:{...copy(Object.fromEntries(Object.entries(latest.timeline).filter(([k])=>!['operations','checkpoints'].includes(k)))),
     operations:copy(Object.fromEntries(Object.entries(latest.timeline.operations||{}).filter(([,op])=>Number(op.turn)>=selection.oldTurn))),
     checkpoints:copy((latest.timeline.checkpoints||[]).filter(cp=>Number(cp.turn)>=selection.oldTurn))}}}
  }finally{if(!rollbackCancellationBarrier.has(chat.sessionId))rollbackSchedulingBarrier.delete(chat.sessionId)}
 }
 function original(current,record){
  const next=copy(current),prefix=record.business.messageCount-2
  next.messages=copy(current.messages.slice(0,prefix)).concat(copy(record.pair))
  next.timeline={...copy(record.timeline),operations:{...Object.fromEntries(Object.entries(current.timeline?.operations||{}).filter(([,op])=>Number(op.turn)<record.turn)),...copy(record.timeline.operations)},checkpoints:[...(current.timeline?.checkpoints||[]).filter(cp=>Number(cp.turn)<record.turn),...copy(record.timeline.checkpoints)]}
  restoreRollbackBusinessState(next,record.business,copy,chats.readRollbackWorldbook,readOperation)
  delete next.regenInProgress;delete next.regenRecovery
  return next
 }
 function adopted(next,{oldTurn,syntheticTurn,generatedAssistant,originalAssistant,adoption}){
  const merged=next.messages.at(-1)
  // 原版replaceLastRound已经合成玩家/正文对；清除旧正文回执并重接实际SQL锚点。
  const message={...copy(generatedAssistant),turn:oldTurn,swipeId:0,swipes:copy(merged.swipes),variables:copy(merged.variables)}
  if(adoption.anchor)message.nativeAnchor=copy(adoption.anchor)
  else delete message.nativeAnchor
  next.messages[next.messages.length-1]=message
  if(originalAssistant?.mvuBaseline)message.mvuBaseline=copy(originalAssistant.mvuBaseline)
  else delete message.mvuBaseline
  // 变量沿原作者结算链重算，不沿用旧正文的结算回执。
  if(originalAssistant?.mvu||message.mvu){
   const guidance=message.mvu?.guidance??originalAssistant?.mvu?.guidance
   message.mvu={pending:true,modified:false,diagnostics:[],events:[],...(guidance===undefined?{}:{guidance:copy(guidance)})}
  }else delete message.mvu
  for(const [id,op] of Object.entries(next.timeline.operations||{}))if(Number(op.turn)===syntheticTurn){
   // 原轮before基准由作者retain保留，临时body不能改号冒充原轮基准。
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
 async function replaceNative(session,keep,expected,output){
  const {persistence,services,agent}=wiring(session)
  await persistence.drainOpenHandles(session.id)
  await persistence.replaceRegeneratedTail(session.header,keep,expected,output)
  rewindSessionMemory(session,keep)
  // 同SQL事务已经持久化，不再触发普通append监听造成重复写。
  for(const event of output)session.log.push(copy(event))
  rewindSessionMemory(session,keep+output.length)
  rebuildSessionProjections(services.projections,session)
  await services.projectionCache.write(session)
  rewindRuntimeTurnCounter(session,services);rewindRuntimeAgentState(session,services);cleanupTokenMeterState(session,services)
  return {session,agent}
 }
 function publishCompletion(chat,session){
  const done=chat.regenerationCompletion
  if(!done)fail('没有已采用的重生成结果；请关闭面板后重新生成')
  const agent=sessions.get(session.id)
  return rollbackSyncProvider().publish({chat,rollbackId:done.id,hiddenTurn:done.turn,subjects:[{session,agent}],current:true})
 }
 async function completeInner({chatId,session,operationId,quiet=false}){
  const chat=await read(chatId),saved=chat?.regenRecovery
  if(!saved||saved.id!==operationId||saved.phase!=='committed')return
  if(saved.sessionId!==session.id)fail('采用会话不匹配')
  const {keep,expected,output}=saved.adoption
  await replaceNative(session,keep,expected,output)
  await cleanupRollbackSides(chat,saved.turn,[{sessionId:session.id,boundarySeq:keep-1}])
  const done=await update(chatId,current=>{
   if(current.regenRecovery?.id!==operationId||current.regenRecovery.phase!=='committed'||current.timeline?.branchId!==chat.timeline?.branchId)fail('物理采用完成身份已变化')
   current.regenerationCompletion={version:1,id:operationId,turn:saved.turn,sessionId:session.id,revision:Number(current._storageRevision)+1,branchId:current.timeline?.branchId,eventCount:session.seq,attemptRange:copy(saved.adoption.attemptRange)}
   delete current.regenRecovery;delete current.regenInProgress
   return current
  },{source:'foreground.regen-projected'})
  if(!quiet)publishCompletion(done,session)
  return done
 }
 async function abortInner({chatId,session,operationId,quiet=false}){
  const chat=await read(chatId),saved=chat?.regenRecovery
  if(!saved||saved.id!==operationId||saved.phase==='committed')return
  if(saved.sessionId!==session.id)fail('恢复会话不匹配')
  const events=session.snapshotEvents()
  for(const e of events.slice(saved.eventStart))if(e.type==='user/message'&&e.data?.source?.kind==='user'&&!(e.surfaceOp&&typeof e.surfaceOp==='object')||e.type==='turn/start'&&e.data.turn>Number(sessions.get(session.id)?.phase?.lastTurn))fail('尝试之后已有玩家输入')
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
 async function recover(chatId,{pendingOnly=false,quiet=false}={}){
  const chat=await read(chatId),saved=chat?.regenRecovery,completion=chat?.regenerationCompletion
  if(!saved&&(pendingOnly||!completion))return
  const agent=sessions.get(saved?.sessionId||completion?.sessionId)
  if(agent?.phase?.kind==='running')return
  if(!agent?.session)fail('恢复需加载同一原生会话，意图已保留')
  if(!saved){
   if(['pending','running'].includes(chat.settleStatus))await queueSettlement(chatId)
   const current=await read(chatId)
   if(!quiet)publishCompletion(current,agent.session)
   return current
  }
  if(saved.restore?.version!==1)fail('旧重生成记录缺少SQL恢复基准，未修改数据')
  if(saved.phase!=='committed')return abort({chatId,session:agent.session,operationId:saved.id})
  await complete({chatId,session:agent.session,operationId:saved.id,quiet:true})
  await queueSettlement(chatId)
  const settled=await read(chatId)
  if(!quiet)publishCompletion(settled,agent.session)
  return settled
 }
 function plan(session,{oldTurn,syntheticTurn,eventStart,oldSeq,chatId,replacement,previousRange}){
  const events=session.snapshotEvents(),planned=planRegenerationEvents({events,oldTurn,syntheticTurn,eventStart,oldAssistantSeq:oldSeq,chatId,replacement,nodes:session.surface.nodes,previousRange})
  const output=planned.events.map((event,index)=>({...event,seq:planned.keep+index,time:event.time??events[eventStart]?.time??Date.now()}))
  return {version:1,keep:planned.keep,anchor:planned.anchor,attemptRange:planned.attemptRange,expected:copy(events.slice(planned.keep)),output}
 }
 // 同会话采用与回退等待同一实际任务，不添加租约或额外资格框架。
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
 const complete=input=>exclusive(input,completeInner),abort=input=>exclusive(input,abortInner)
 async function cancelForRollback(chatId,sessionId){
  const current=await read(chatId),saved=current?.regenRecovery
  if(!saved||saved.restore?.version!==1)return
  const session=sessions.get(sessionId)?.session
  await activeAdoptions.get(sessionId)
  rollbackBarrier.add(sessionId)
  try{
   const restored=await(saved.phase==='committed'?completeInner:abortInner)({chatId,session,operationId:saved.id,quiet:true})
   return {chatId,sessionId,turn:saved.turn,fromBranch:current.timeline?.branchId,toBranch:restored?.timeline?.branchId}
  }finally{rollbackBarrier.delete(sessionId)}
 }
 return Object.freeze({prepare,adopted,plan,complete,abort,recover,publishCompletion,cancelForRollback})
}
