// 半提交时按钮必须允许『完成同一回退』，不能按已删正文去选择更早一轮。
const MARKER='// [dsh-tavern-rollback-pending-view:v1]'
export function applyRollbackPendingViewTransform(source){
 const anchor='  function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {'
 const blockOriginal=`${anchor}
    ${MARKER}
    if (chat.rollbackPending) return {
      hiddenDshErrorTurns: [], suppressedDshTurns: [], regeneratedDshTurns: {}, suppressedDshErrorTurns: [],
      canRegenerate: false, canEditBody: false, canReplayFailedTurn: false, replayFailedTurn: null,
      rollbackTargetTurn: chat.rollbackPending.turn, canRollback: true, canClearIncompleteReply: false,
      undoRollbackTurn: null, rollbackUnavailableReason: '', rollbackPending: true,
    }`
 const blockLatestVariant=`${anchor}
    ${MARKER}
    if (chat.rollbackPending) return {
      hiddenDshErrorTurns: [], suppressedDshTurns: [], regeneratedDshTurns: {}, suppressedDshErrorTurns: [],
      canRegenerate: false, canEditBody: false, canReplayFailedTurn: false, replayFailedTurn: null,
      rollbackTargetTurn: chat.rollbackPending.turn, canRollback: true, canClearIncompleteReply: !!chat.rollbackPending.failureTarget,
      undoRollbackTurn: null, rollbackUnavailableReason: '', rollbackPending: true,
    }`
 if(source.includes(MARKER)){
   // 幂等：检查核心block结构存在即可，接受latest修改的变体
   const hasOriginal = source.includes('canRollback: true, canClearIncompleteReply: false,')
   const hasLatestVariant = source.includes('canRollback: true, canClearIncompleteReply: !!chat.rollbackPending.failureTarget,')
   const hasPendingCheck = source.includes('if (chat.rollbackPending) return {')
   if(!hasPendingCheck || (!hasOriginal && !hasLatestVariant)) throw Error('回退重试视图标记不完整')
   return source
 }
 if(source.split(anchor).length!==2)throw Error('回退重试视图锚点不唯一')
 let next=source.replace(anchor,blockOriginal)
 const fields="'backgroundConfigVersion', 'conversationFeaturesVersion', 'disabledWritingSkills', 'contextCompaction', 'updatedAt', 'timeline', 'candidateAgent',"
 if(next.split(fields).length!==2)throw Error('回退重试头字段锚点不唯一')
 return next.replace(fields,fields+" 'rollbackPending',")
}
