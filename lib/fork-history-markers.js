// 只规范新分叉的历史显示索引；正文/变量/原生事件不修改，不重编号，不执行脚本。
export function normalizeForkHistoryMarkers(chat, events, atSeq) {
  if (!chat || !Array.isArray(chat.messages) || !Array.isArray(events) || !Number.isSafeInteger(atSeq) || atSeq < 0) {
    throw new Error('分叉显示索引缺少确切原生前缀，拒绝猜测清理')
  }
  if (events.some(event => !Number.isSafeInteger(event?.seq) || event.seq < 0)) throw new Error('分叉前缀事件身份无效')
  const prefix = events.filter(event => event.seq <= atSeq)
  if (prefix.length !== atSeq + 1 || prefix.some((event, index) => event.seq !== index)) throw new Error('分叉原生前缀不连续，拒绝把未知历史当成不存在')
  const boundary = prefix[atSeq]
  if (boundary?.type !== 'turn/end' || boundary.data?.reason?.kind !== 'completed') {
    throw new Error('分叉显示索引缺少已完成的原生边界')
  }
  const turns = new Set(), assistantTurns = new Set(), completed = new Set()
  for (const event of prefix) {
    if (!['turn/start', 'turn/end', 'assistant/message'].includes(event.type)) continue
    const turn = event.data?.turn
    const seed = event.data?.message?.source
    // 作者固定种子轨迹不是剧情轮：允许其明确的turn0身份，但不纳入任何显示轮集合。
    if (event.type === 'assistant/message' && turn === 0 && event.data?.step === 1 && seed?.kind === 'model' && seed.provider === 'dsh-tavern' && seed.model === 'synthetic-trajectory' && seed.version === 1) continue
    if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('分叉前缀轮身份不完整，拒绝删除历史标记')
    turns.add(turn)
    if (event.type === 'assistant/message' && event.data?.message?.source?.kind === 'model') assistantTurns.add(turn)
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') completed.add(turn)
  }
  const validTurn = value => (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  const list = key => {
    if (chat[key] === undefined) return undefined
    if (!Array.isArray(chat[key]) || chat[key].some(value => !validTurn(value))) throw new Error('分叉历史隐藏索引无效：' + key)
    return [...new Set(chat[key].map(Number).filter(turn => turns.has(turn)))].sort((a,b) => a-b)
  }
  const suppressed = list('suppressedDshTurns'), hiddenErrors = list('hiddenDshErrorTurns')
  const mappings = chat.regeneratedDshTurns
  let keptMappings
  if (mappings !== undefined) {
    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error('分叉重生成映射无效')
    keptMappings = {}
    const storyTurns = new Set(chat.messages.filter(row => row?.role === 'assistant').map(row => Number(row.turn || (row.greeting ? 1 : 0))))
    for (const [source, targetValue] of Object.entries(mappings)) {
      const sourceTurn = Number(source), targetTurn = Number(targetValue)
      if (!validTurn(source) || !validTurn(targetValue)) throw new Error('分叉重生成轮身份无效')
      // 已不属于当前剧情的旧映射不带入；仍被剧情使用的映射不可默默丢失。
      if (!storyTurns.has(sourceTurn)) continue
      if (!turns.has(sourceTurn) || !assistantTurns.has(targetTurn) || !completed.has(targetTurn)) {
        throw new Error('当前剧情的重生成映射缺少继承原生对象，拒绝不完整分叉')
      }
      keptMappings[String(sourceTurn)] = targetTurn
    }
  }
  // 无副作用输入；只替换三类索引，调用方将目标副本一次publish到SQLite。
  return { ...chat, ...(suppressed === undefined ? {} : { suppressedDshTurns: suppressed }),
    ...(hiddenErrors === undefined ? {} : { hiddenDshErrorTurns: hiddenErrors }),
    ...(keptMappings === undefined ? {} : { regeneratedDshTurns: keptMappings }) }
}
