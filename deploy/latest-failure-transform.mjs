// 最新失败清理只接当前尾部的确切目标，不从旧失败挑选删除范围。
const HOST_MARKER = '// [dsh-tavern-latest-failure-host:v1]'
const VIEW_MARKER = '// [dsh-tavern-latest-failure-view:v1]'
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('最新失败接缝锚点缺失/不唯一：' + before.slice(0, 90))
  return source.replace(before, after)
}
export function applyLatestFailureHostTransform(source) {
  const before = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn) }"
  const after = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && (args.failureTarget || args.expectedTurn)) }"
  if (source.includes(HOST_MARKER)) {
    if (source.split(HOST_MARKER).length !== 2 || !source.includes(after)) throw new Error('最新失败宿主接线不完整')
    return source
  }
  return HOST_MARKER + '\n' + once(source, before, after)
}
export function applyLatestFailureViewTransform(source) {
  const fields = `      failureTarget: latestFailureTarget(chat, replayTarget),
      failureCleanupReason: replayTarget && !latestFailureTarget(chat, replayTarget) ? '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理' : '',`
  const helper = `function latestFailureTarget(chat, replayTarget) {
  const pending = chat.rollbackPending
  if (pending?.failureTarget) return { ...pending.failureTarget, chatId: chat.id, sessionId: chat.sessionId, rollbackId: pending.id }
  const turn = Number(replayTarget?.turn)
  if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(chat._storageRevision) || !chat.timeline?.branchId) return null
  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)
  if (!entry || entry[1].status === 'completed' || !(entry[1].businessBefore || entry[1].rowBefore)) return null
  if ((chat.timeline.checkpoints || []).some(cp => Number(cp.turn) >= turn)) return null
  if ((chat.messages || []).some(row => Number(row.turn) > turn)) return null
  if (Object.values(chat.timeline.operations || {}).some(op => Number(op?.turn) > turn)) return null
  return { chatId: chat.id, sessionId: chat.sessionId, turn, branchId: chat.timeline.branchId, revision: chat._storageRevision, operationId: entry[0] }
}
`
  if (source.includes(VIEW_MARKER)) {
    const required = [helper, fields,
      'canClearIncompleteReply: latestFailureTarget(chat, replayTarget) !== null,',
      'failureTarget: latestFailureTarget(chat, replayTarget),',
      'return {...copyRollback(previous.value),failureTarget: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}),undoRollbackTurn:']
    const hasNewPendingForm = source.includes('canRollback: true, canClearIncompleteReply: !!chat.rollbackPending.failureTarget,')
    if (source.split(VIEW_MARKER).length !== 2 || required.some(block => !source.includes(block)) || !hasNewPendingForm) throw new Error('最新失败视图接线不完整')
    return source
  }
  let next = VIEW_MARKER + '\n' + helper + source
  next = once(next, '      canReplayFailedTurn: replayTarget !== null,', fields + '\n      canReplayFailedTurn: replayTarget !== null,')
  next = once(next, '      canClearIncompleteReply: rollbackState.canClearIncompleteReply,', '      canClearIncompleteReply: latestFailureTarget(chat, replayTarget) !== null,')
  // 半提交只允许完成同一清理；不能从已经截断的正文重新选择目标。
  next = once(next, '      undoRollbackTurn: canUndoRollback(chat, evidence.session) ? chat.rollbackUndo.turn : null,\n      rollbackUnavailableReason: rollbackState.reason', '      failureTarget: latestFailureTarget(chat, replayTarget),\n      failureCleanupReason: replayTarget && !latestFailureTarget(chat, replayTarget) ? \'当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理\' : \'\',\n      undoRollbackTurn: canUndoRollback(chat, evidence.session) ? chat.rollbackUndo.turn : null,\n      rollbackUnavailableReason: rollbackState.reason')
  next = once(next, 'canRollback: true, canClearIncompleteReply: false,', 'canRollback: true, canClearIncompleteReply: !!chat.rollbackPending.failureTarget,')
  // 命中旧rollback缓存也必须重新签发当前revision，旧凭据不能被缓存续用。
  next = once(next, 'return {...copyRollback(previous.value),undoRollbackTurn:', 'return {...copyRollback(previous.value),failureTarget: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}),undoRollbackTurn:')
  return next
}
