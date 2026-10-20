// 失败/结束信号携带发轮时捕获的不可变身份；轮号复用不是任务身份。
function once(source,old,next){if(source.split(old).length!==2)throw Error('正文信号归属锚点缺失/不唯一：'+old.slice(0,90));return source.replace(old,next)}
function persistBodyBeforePreparation(source){
 const marker='// [dsh-tavern-body-before-prepare:v1]'
 const legacyForeground="      await savePreparation({source:'foreground.body-before-prepare'})\n      publishRollbackBodySignal(options,chat,foregroundOperation.operationId)"
 // 发送接受已落running body时不再重存（captureSend已有同一前像）；未落库路径仍先提交失败基准。
 const foreground="      if (!rollbackBodyAlreadyDurable) await savePreparation({source:'foreground.body-before-prepare'})\n      publishRollbackBodySignal(options,chat,foregroundOperation.operationId)"
 const compatibility="    await store.writeChat(chat,{source:'foreground.body-before-prepare'})\n    publishRollbackBodySignal(options,chat,begun.value.operationId)"
 if(source.includes(legacyForeground))source=source.replace(legacyForeground,foreground)
 if(source.includes(marker)){
  if(!source.includes(foreground)||!source.includes(compatibility))throw Error('正文准备前基准提交接线不完整')
  return source
 }
 let next=once(source,'      publishRollbackBodySignal(options,chat,foregroundOperation.operationId)',foreground)
 // 判定必须取body.begin之前的存档态，不能看刚加入草稿的operation。
 const began='      const begun = timeline.apply({ chat: { ...chat, messages: [] }, intent: { kind: \'body.begin\', turn, userText'
 const durable='      const rollbackBodyAlreadyDurable = Object.values(chat.timeline?.operations || {}).some(operation => operation?.kind === \'body\' && operation.status === \'running\' && Number(operation.turn) === turn)\n'
 next=once(next,began,durable+began)
 next=once(next,'    publishRollbackBodySignal(options,chat,begun.value.operationId)',compatibility)
 return marker+'\n'+next
}
function retainFailedScriptForPhysicalRollback(source){
 const marker='// [dsh-tavern-failed-script-retain:v1]'
 if(source.includes(marker))return source
 const legacy=`      if ((chat.mode || 'story') === 'script' && chat.scriptState && chat.scriptState.prepared && Number(chat.scriptState.prepared.nativeTurn) === turn) {
        const script = await store.readScript(cardPathOf(chat))
        if (script !== undefined && Array.isArray(script.chunks)) {
          chat.scriptState = scripts.transition({ script, state: chat.scriptState, event: { kind: 'restore', revision: null, reference: chat.scriptState.prepared } }).state
          changed = true
        }
      }`
 return once(source,legacy,`      ${marker}
      // 失败只登记终态；脚本运行状态随用户物理回退恢复，不能因再次读坏脚本而丢失 failed。`)
}
export function applyRollbackBodySignalTurnTransform(source){
 const marker='// [dsh-tavern-body-signal-owner:v1]'
 if(source.includes(marker))return retainFailedScriptForPhysicalRollback(persistBodyBeforePreparation(source))
 let next=marker+`\nfunction rollbackBodySignalMatches(chat,input) {
 const owner=input.rollbackBodyOwner,op=chat.timeline?.operations?.[owner?.operationId]
 return !!owner && !chat.rollbackPending && owner.chatId===chat.id && owner.sessionId===chat.sessionId && owner.turn===Number(input.turn) && owner.branchId===chat.timeline?.branchId && op?.kind==='body' && op.status==='running' && Number(op.turn)===owner.turn && op.basedOn?.branchId===owner.branchId
}
function publishRollbackBodySignal(options,chat,operationId) {
 const op=chat.timeline?.operations?.[operationId]
 if(op?.kind==='body' && typeof options.recordRollbackBodySignal==='function')options.recordRollbackBodySignal(Object.freeze({chatId:chat.id,sessionId:chat.sessionId,turn:Number(op.turn),branchId:chat.timeline.branchId,operationId}))
}
`+source
 next=once(next,'      foregroundOperation = begun.value','      foregroundOperation = begun.value\n      publishRollbackBodySignal(options,chat,foregroundOperation.operationId)')
 next=once(next,'    const operation = chat.timeline.operations[begun.value.operationId]','    const operation = chat.timeline.operations[begun.value.operationId]\n    publishRollbackBodySignal(options,chat,begun.value.operationId)')
 const start=next.indexOf('  async function recordFailure(input) {'),end=next.indexOf('  async function discard(input) {',start)
 if(start<0||end<start)throw Error('失败信号函数边界缺失')
 next=next.slice(0,start)+`  async function recordFailure(input) {
    const target=await store.chatForSession(input.sessionId)
    if(target===undefined)return false
    let changed=false
    await store.updateChat(target.id,current=>{
      if(!rollbackBodySignalMatches(current,input))return undefined
      current.foregroundError={turn:Number(input.turn),requestId:str(input.requestId).trim(),code:str(input.code).trim()||'foreground-failed',message:str(input.message).trim()||'前台正文生成失败，请重新生成本轮正文。',at:now()}
      changed=true;return current
    },{source:'foreground.failure'})
    return changed
  }

`+next.slice(end)
 return retainFailedScriptForPhysicalRollback(persistBodyBeforePreparation(once(next,'    await store.updateChat(target.id, async function (chat) {',`    await store.updateChat(target.id, async function (chat) {
      if(['story','script'].includes(chat.mode || 'story') && !rollbackBodySignalMatches(chat,input))return undefined`)))
}
export function applyRollbackBodySignalHandoffTransform(source){
 const marker='// [dsh-tavern-body-signal-handoff:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+once(source,'    const reason = str(input.reason)','    const reason = str(input.reason)\n    const rollbackBodyOwner=input.rollbackBodyOwner')
 return once(next,'      const target = { sessionId: input.sessionId, turn: input.turn }','      const target = { sessionId: input.sessionId, turn: input.turn, rollbackBodyOwner }')
}
// 最新作者把消费者拆入hooks；旧内联布局只在确切锚点存在时复用同一转换。
export function applyRollbackBodySignalHooksTransform(source){
 const marker='// [dsh-tavern-body-signal-hooks:v1]'
 if(source.includes(marker)){
  for(const required of ['const rollbackBodyOwner=rollbackBodySignals.get(payload.agent?.session?.id)','        rollbackBodyOwner,','reason, rollbackBodyOwner:rollbackBodySignals.get(session.id)'])if(!source.includes(required))throw Error('正文hooks归属标记不完整')
  return source
 }
 let next=marker+'\n'+source
 if(next.includes('export function registerTurnLifecycleHooks({'))next=once(next,'export function registerTurnLifecycleHooks({','export function registerTurnLifecycleHooks({\n  rollbackBodySignals,')
 next=once(next,"  ctx.on('agent/turn-stopping', async function (payload) {",`  ctx.on('agent/turn-stopping', async function (payload) {
    // 首次await前捕获；回退/复用轮号不得改变本次信号身份。
    const rollbackBodyOwner=rollbackBodySignals.get(payload.agent?.session?.id)`)
 next=once(next,'      await turnOrchestrator.recordFailure({\n        sessionId,','      await turnOrchestrator.recordFailure({\n        rollbackBodyOwner,\n        sessionId,')
 return once(next,'foregroundHandoff.end({ sessionId: session.id, turn: event.data && event.data.turn, reason })','foregroundHandoff.end({ sessionId: session.id, turn: event.data && event.data.turn, reason, rollbackBodyOwner:rollbackBodySignals.get(session.id) })')
}
export function applyRollbackBodySignalHostTransform(source){
 const marker='// [dsh-tavern-body-signal-host:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+source
 next=once(next,'  const turnOrchestrator = createTurnOrchestrator({',`  const rollbackBodySignals=new Map()
  const turnOrchestrator = createTurnOrchestrator({
    recordRollbackBodySignal:owner=>rollbackBodySignals.set(owner.sessionId,owner),`)
 if(next.includes('  registerTurnLifecycleHooks({')) {
  next=once(next,'  registerTurnLifecycleHooks({','  registerTurnLifecycleHooks({\n    rollbackBodySignals,')
 } else next=applyRollbackBodySignalHooksTransform(next)

 return once(next,'        requestCoordinates.delete(cut.sessionId)','        requestCoordinates.delete(cut.sessionId)\n        rollbackBodySignals.delete(cut.sessionId)')
}
