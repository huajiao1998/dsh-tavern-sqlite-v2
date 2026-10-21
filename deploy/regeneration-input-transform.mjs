// 变量变化由原生产者退役本轮旧输入；SQL沿既有消息面替换删尾，不增分类准入。
const MARKER = '// [dsh-tavern-regeneration-variable-input:v1]'
export function applyRegenerationInputTransform(source) {
  if (source.includes(MARKER) || !source.includes('export function appendVariableChanges(')) return source
  const anchor = "  if (decision.messages.some(message => message.source?.form === 'variable-changes')) return decision"
  if (source.split(anchor).length !== 2) throw Error('变量变化生产入口接缝缺失/不唯一')
  source = "import { sessionEvents } from '../domain/session-events.js'\nimport { replaceSessionSurface } from '../domain/session-surface-mutations.js'\n" + source
  return source.replace(anchor, `  ${MARKER}
  if (chat.regenInProgress) {
    const session = payload.agent.session, events = sessionEvents(session), saved = chat.regenRecovery
    const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === saved.turn)
    const surface = new Set(session.surface.nodes)
    // 只退役被重采样的这一轮，不动以前轮次、独立通知或快照；当前无变化也撤掉旧变化。
    if (start >= 0) for (const event of events.slice(start + 1, saved.eventStart)) {
      if (!surface.has(event.seq) || event.type !== 'user/message' || event.data.source?.plugin !== 'dsh-tavern' || event.data.source.form !== 'variable-changes') continue
      replaceSessionSurface(session, 'user/message', { ...event.data, id: randomUUID(), content: [] }, { start: event.seq, end: event.seq, sourceEventSeqs: [event.seq] })
    }
  }
${anchor}`)
}
