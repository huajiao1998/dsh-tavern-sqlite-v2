// R1：保留作者任意变量（包括null/{}）的优先语义；只有完全缺失才读同revision的SQLite当前态。
// 不把全局当前态当作历史楼/另一个swipe的结算基线。
export function createCurrentVariableReader({ lastVariables, readSnapshot }) {
  if (typeof lastVariables !== 'function' || typeof readSnapshot !== 'function') throw new Error('当前变量消费者依赖未接线')
  return function currentVariablesOf(chat) {
    const hot = lastVariables(chat?.messages)
    if (hot !== undefined) return hot
    return readSnapshot(chat)?.tree
  }
}
