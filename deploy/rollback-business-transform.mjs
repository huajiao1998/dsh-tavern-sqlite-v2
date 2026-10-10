// 接入完整逐轮业务基准，升级已施row-v1源码；未知或半施布局失败关闭。
const MARKER = '// [dsh-tavern-rollback-business:v1]'
function once(source, old, next) {
  if (source.split(old).length !== 2) throw new Error('业务回退接缝锚点未命中/不唯一：'+old.slice(0,80))
  return source.replace(old,next)
}
export function applyRollbackBusinessTimelineTransform(source) {
  const importLine = "import { captureRollbackBusinessState, restoreRollbackBusinessState } from './storage-rollback-business.js'"
  const historyCall='restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone, options.readRollbackWorldbook)'
  // 新接线调用包含旧调用的前缀但不是同一字符串，标记核验须识别两代完整消费者。
  if(source.includes('// [dsh-tavern-worldbook-history-timeline:v1]') && !source.includes(historyCall))throw Error('世界书历史时间线接线不完整')
  if (source.includes(MARKER)) {
    for (const key of [importLine,'businessBefore: operation.businessBefore',source.includes('captureRollbackBusinessState(chat, clone, options.readRollbackWorldbookRef?.(chat))')?'businessBefore: intent.businessBefore || captureRollbackBusinessState(chat, clone, options.readRollbackWorldbookRef?.(chat))':'businessBefore: intent.businessBefore || captureRollbackBusinessState(chat, clone)',source.includes(historyCall)?historyCall:'restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone)']) if (!source.includes(key)) throw new Error('业务回退标记存在但消费者不完整')
    return worldbookHistoryReader(preserveMacroConfiguration(source))
  }
  let next = importLine+'\n'+MARKER+'\n'+source
  next = once(next,'rowBefore: operation.rowBefore,','rowBefore: operation.rowBefore, businessBefore: operation.businessBefore,')
  next = once(next,'rowBefore: rollbackHead(chat), beforeParticipants:', 'rowBefore: rollbackHead(chat), businessBefore: intent.businessBefore || captureRollbackBusinessState(chat, clone), beforeParticipants:')
  next = once(next,'    restore(chat, restoredState)', '    if (!checkpoint.businessBefore) throw new Error(\'本轮缺少完整业务回退基准，未修改数据库；不能用当前状态冒充上一轮\')\n    restore(chat, restoredState)\n    restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone)')
  return worldbookHistoryReader(preserveMacroConfiguration(next))
}
// 作者restore先整替macroState；业务恢复随后执行，必须在此处先保留当前用户子字段。
function preserveMacroConfiguration(source){
  if(source.includes('// [dsh-tavern-rollback-macro-config:v1]'))return source
  return once(source,'    restore(chat, restoredState)\n    restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone)',`    // [dsh-tavern-rollback-macro-config:v1]
     const currentMacroState = chat.macroState
     restore(chat, restoredState)
     chat.macroState = currentMacroState
     restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone)`)
}
function worldbookHistoryReader(source){
 const marker='// [dsh-tavern-worldbook-history-timeline:v1]'
 let next=source.includes(marker)?source:marker+'\n'+once(source,'restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone)','restoreRollbackBusinessState(chat, checkpoint.businessBefore, clone, options.readRollbackWorldbook)')
 const captureMarker='// [dsh-tavern-worldbook-history-capture:v1]'
 if(next.includes(captureMarker)){
  if(!next.includes('captureRollbackBusinessState(chat, clone, options.readRollbackWorldbookRef?.(chat))') || !next.includes('captureBusiness: chat => captureRollbackBusinessState(chat, structuredClone, options.readRollbackWorldbookRef?.(chat))'))throw Error('世界书历史捕获接线不完整')
  return next
 }
 next=once(next,'captureRollbackBusinessState(chat, clone)','captureRollbackBusinessState(chat, clone, options.readRollbackWorldbookRef?.(chat))')
 return captureMarker+'\n'+once(next,'return Object.freeze({ apply, complete, inspect, rollbackTarget })','return Object.freeze({ apply, complete, inspect, rollbackTarget, captureBusiness: chat => captureRollbackBusinessState(chat, structuredClone, options.readRollbackWorldbookRef?.(chat)) })')
}
function captureWorldbookReference(source){
 const marker='// [dsh-tavern-worldbook-history-turn:v1]'
 if(source.includes(marker)){
  if(!source.includes('const rollbackBusinessBefore = timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)'))throw Error('世界书回合捕获标记不完整')
  return source
 }
 return marker+'\n'+once(source,'const rollbackBusinessBefore = captureRollbackBusinessState(chat)','const rollbackBusinessBefore = timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)')
}
export function applyRollbackBusinessTurnTransform(source) {
  // 守卫 fence：从本 transform 内联判据（旧版）改为读**同一份失败状态投影**（缺陷 A 的根治）。
  // 必须能**升级**而非跳过：已装旧版的作者树上 marker 已在，一见 marker 就 return 会把新判据漏掉。
  const guard='// [dsh-tavern-failed-body-prepare-fence:v1]'
  const fenceImport="import { ledgerFailureState } from './storage-failure-state.js'\n"
  const legacyFence=`function assertRollbackBodyPreparation(chat) {
  if(Object.values(chat.timeline?.operations || {}).some(op=>op.kind==='body' && op.status==='failed' && (!op.basedOn?.branchId || op.basedOn.branchId===chat.timeline?.branchId)))throw new Error('失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准')
}`
  const sharedFence=`function assertRollbackBodyPreparation(chat) {
  // 与回退编排同读一份失败状态投影（lib/failure-state.js）——两侧判据必须同源，
  // 否则"守卫要求先清理、回退不认这个失败"会互相等待（缺陷 A）。
  if(ledgerFailureState(chat).pendingCleanupTurns.length)throw new Error('失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准')
}`
  function failedBodyFence(value) {
    if(value.includes(sharedFence)) {
      if(!value.includes(fenceImport))throw Error('失败正文守卫缺少 ledgerFailureState 导入')
      return value
    }
    if(value.includes(legacyFence)) {
      value=value.replace(legacyFence,sharedFence)
    } else {
      let next=guard+'\n'+sharedFence+'\n'+value
      next=once(next,'    const rollbackBusinessBefore = captureRollbackBusinessState(chat)','    assertRollbackBodyPreparation(chat)\n    const rollbackBusinessBefore = captureRollbackBusinessState(chat)')
      next=once(next,"    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText } })","    assertRollbackBodyPreparation(chat)\n    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText } })")
      value=next
    }
    if(!value.includes(fenceImport))value=fenceImport+value
    if(value.split(guard).length!==2)throw Error('失败正文守卫标记不唯一：'+guard)
    return value
  }
  const marker = '// [dsh-tavern-rollback-business-prepare:v1]'
  if (source.includes(marker)) {
    if (!source.includes('businessBefore: rollbackBusinessBefore') || !(source.includes('captureRollbackBusinessState(chat)') || source.includes('timeline.captureBusiness(chat)'))) throw new Error('前台完整业务基准消费者不完整')
    return captureWorldbookReference(failedBodyFence(source))
  }
  let next = "import { captureRollbackBusinessState } from './storage-rollback-business.js'\n"+marker+'\n'+source
  next = once(next,'    let chatChanged = clearStaleStages(chat, turn)',"    if (chat.rollbackPending) throw new Error('物理回退未完成，请先重试回退，禁止继续生成')\n    const rollbackBusinessBefore = captureRollbackBusinessState(chat)\n    let chatChanged = clearStaleStages(chat, turn)")
  next = once(next,"const begun = timeline.apply({ chat: { ...chat, messages: [] }, intent: { kind: 'body.begin', turn, userText } })", "const begun = timeline.apply({ chat: { ...chat, messages: [] }, intent: { kind: 'body.begin', turn, userText, businessBefore: rollbackBusinessBefore } })")
  next = once(next,"    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText } })", "    if (chat.rollbackPending) throw new Error('物理回退未完成，请先重试回退')\n    const begun = timeline.apply({ chat, intent: { kind: 'body.begin', turn, userText } })")
  return captureWorldbookReference(failedBodyFence(next))
}
