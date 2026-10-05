// 回退依赖当前行前缀和逐轮业务状态，不制造历史Chat/revision。
const MARKER = '// [dsh-tavern-row-rollback:v1]'
function once(source, old, next) {
  if (source.split(old).length !== 2) throw new Error('行级回退接缝锚点未命中/不唯一：' + old.slice(0, 70))
  return source.replace(old, next)
}
export function applyRowHistoryTransform(source) {
  if (source.includes(MARKER)) return source
  const old = `    const beforeChat = await readChatRevision(chat.id, target.beforeRevision)
    if (beforeChat === undefined) throw new Error('找不到剧情 checkpoint 对应的历史 Chat revision: ' + target.beforeRevision)
    return Object.assign({}, intent, { beforeChat })`
  return once(source, old, `${MARKER}
    return Object.assign({}, intent, { rowCheckpointId: target.checkpointId })`)
}
export function applyRowTimelineTransform(source) {
  if (source.includes(MARKER)) return source
  let next = once(source, '  function commitBody(chat, operation) {', `${MARKER}
  // 仅逐轮业务头字段；正文由现有行前缀复用，楼变量仍由既有变量快照承载。
  function rollbackHead(chat) {
    const state = snapshot({ ...chat, messages: [] })
    delete state.messages
    delete state.participants
    return state
  }

  function commitBody(chat, operation) {`)
  next = once(next, '      beforeRevision: Math.max(0, Number(operation.beforeRevision) || 0),', '      beforeRevision: Math.max(0, Number(operation.beforeRevision) || 0), rowBefore: operation.rowBefore,')
  next = once(next, '      basedOn: basedOn(chat), beforeRevision: storageRevision(chat), beforeParticipants: clone(chat.timeline.participants), createdAt: now()', '      basedOn: basedOn(chat), beforeRevision: storageRevision(chat), rowBefore: rollbackHead(chat), beforeParticipants: clone(chat.timeline.participants), createdAt: now()')
  next = once(next, `    if (checkpoint.before !== undefined) {
      restoredState = checkpoint.before
    } else {`, `    if (intent.rowCheckpointId !== undefined) {
      if (str(intent.rowCheckpointId) !== str(checkpoint.id)) throw new Error('回退checkpoint已变化，请刷新后重试')
      const messages = chat.messages || []
      let index = messages.findLastIndex(message => message?.role === 'assistant' && Number(message.turn) === Number(checkpoint.turn))
      if (index < 0) throw new Error('回退checkpoint缺少对应正文行')
      if (index > 0 && messages[index - 1]?.role === 'user') index--
      const prefix = messages.slice(0, index)
      if (checkpoint.rowBefore !== undefined) {
        restoredState = { ...clone(checkpoint.rowBefore), messages: prefix, participants: checkpoint.participants }
      } else {
        // 旧checkpoint仅含revision号，nativeCommits.before也不含全部变量/宏/剧本状态。
        // 不把当前状态冒充旧状态、不允许缺失历史后静默成功。
        throw new Error('本轮由旧版生成，缺少行级回退基准；未修改正文或原生日志。更新后生成的回合才具备完整回退基准')
      }
    } else if (checkpoint.before !== undefined) {
      restoredState = checkpoint.before
    } else {`)
  return next
}
