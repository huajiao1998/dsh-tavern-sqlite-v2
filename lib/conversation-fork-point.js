// 分叉点计算（对话分叉）—— 实现由本包拥有；**fork 自上游**（来源与基准见 fork-manifest.json）
//
// 与上游的**全部差异**（就这一处）：
//   A4a：删掉历史快照链回溯（沿 `beforeRevision` 链接追踪旧 journal 状态）—— 行级存档**只保留当前态、
//        不保留历史版本**，回溯永远拿不到旧状态；改为明确报错「行级存档不保留历史版本，只能从最新回合分叉」。
//        最新回合分叉（requestedTurn 空/0）不进该分支 ⇒ 零影响。
//
// 依赖注入（DI）：4 个作者工具由作者树的薄垫片注入（见 deploy/conversation-fork-point.shim.js）——
//   它们必须与作者其它代码是同一份实现，因此不在本包 fork。
let deps = null

/** 由作者树垫片注入作者的 4 个工具（DI）。 */
export function configureConversationForkPoint(injected = {}) {
  const required = ['isRescuedHistoryMessage', 'assistantResultForTurn', 'sessionEvents', 'assertConversationForkable']
  const missing = required.filter(name => typeof injected[name] !== 'function')
  if (missing.length > 0) throw new Error('conversation-fork-point：configure 缺少 ' + missing.join(', '))
  deps = injected
}

function need() {
  if (deps === null) {
    throw new Error('conversation-fork-point：依赖未注入 —— 作者树的薄垫片必须调用 configureConversationForkPoint({...})')
  }
  return deps
}

const turnOf = message => Number(message?.turn || (message?.greeting ? 1 : 0))
const lastAssistant = chat => (chat.messages || []).findLast(message => message?.role === 'assistant')

// Checkpoints are bounded in each Chat, but their beforeRevision links retain
// access to older journal states. Follow those links, including parent branches.
export async function conversationStateAtTurn(source, requestedTurn, readRevision) {
  const turn = requestedTurn === undefined || requestedTurn === 0 ? turnOf(lastAssistant(source)) : Number(requestedTurn)
  const targetIndex = (source.messages || []).findIndex(message => message?.role === 'assistant' && turnOf(message) === turn)
  if (!Number.isSafeInteger(turn) || turn < 1 || targetIndex < 0) throw new Error('找不到指定分叉回合')
  if (need().isRescuedHistoryMessage(source, source.messages[targetIndex])) throw new Error('存档救援导入的历史没有状态快照，不能从该回合分叉')
  // [a4-history-read-retired] 2026-09-29 砍单刀5：历史快照链回溯已退役（行级存档无历史版本，只保留最新分叉）
  let state = source
  if (turnOf(lastAssistant(state)) !== turn) throw new Error('行级存档不保留历史版本，只能从最新回合分叉')
  const prefix = source.messages.slice(0, targetIndex + 1)
  if (state.messages.length !== prefix.length || prefix.some((message, index) => {
    const old = state.messages[index]
    return message.role !== old.role || turnOf(message) !== turnOf(old) || (message.sourceText ?? message.text) !== (old.sourceText ?? old.text)
  })) throw new Error('历史快照与当前分支正文不一致，无法安全分叉')
  need().assertConversationForkable(state)
  return { turn, state }
}

export function conversationForkBoundary(session, state, turn) {
  const events = need().sessionEvents(session)
  const nativeTurn = Number(state.regeneratedDshTurns?.[turn]) || turn
  const end = events.findLast(event => event.type === 'turn/end' && Number(event.data?.turn) === nativeTurn)
  if (!end || end.data?.reason?.kind !== 'completed') throw new Error('该回合缺少已完成的原生上下文边界')
  const result = need().assistantResultForTurn(session, turn)
  const following = events.find(event => event.type === 'turn/start' && event.seq > end.seq)
  if (!result || (following && result.event.seq >= following.seq)) throw new Error('该回合正文曾在后续上下文中被修改，无法按旧边界安全分叉')
  return end.seq
}