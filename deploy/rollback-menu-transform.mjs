// 统一「更多 → 回退」的展示与点击互斥；不改目标/RPC/CAS/同步执行链。
const MARK = '// [dsh-tavern-rollback-menu:v1]'
const REF = 'const rollbackInFlight = React.useRef(new Set());'
function once(source, old, next) {
  if (source.split(old).length !== 2) throw Error('回退菜单锚点缺失或重复：' + old.slice(0, 90))
  return source.replace(old, next)
}
export function applyRollbackMenuTransform(source) {
  const begin = source.indexOf('function TavernRollbackAction(props)'), end = source.indexOf('function TavernUndoRollbackAction(props)', begin)
  if (begin < 0 || end < begin) throw Error('回退菜单组件边界缺失')
  let part = source.slice(begin, end)
  if (part.includes(MARK)) {
    if (part.split(MARK).length !== 2 || !part.includes(REF) || !part.includes('rollbackInFlight.current.delete(props.sessionId)') || !part.includes('（未完成发送）')) throw Error('回退菜单接线不完整')
    return source
  }
  part = once(part, 'const [rollbackRunningSession, setRollbackRunningSession] = React.useState(null);', `${MARK}\n${REF}\nconst [rollbackRunningSession, setRollbackRunningSession] = React.useState(null);`)
  part = once(part, 'if (!canRollback || blocked) return;', 'if (!canRollback || blocked || rollbackInFlight.current.has(props.sessionId)) return;\n                rollbackInFlight.current.add(props.sessionId);')
  part = once(part, 'finally { setRolling(false);', 'finally { rollbackInFlight.current.delete(props.sessionId); setRolling(false);')
  part = once(part, 'clearIncomplete ? "清除未完成回复" : rollbackRetryTarget ? "重试完成回退" : targetLabel);', 'rollbackRetryTarget ? "重试完成回退" : clearIncomplete ? targetLabel + "（未完成发送）" : targetLabel);')
  part = once(part, '"清除未完成回复，保留已完成剧情"', '"撤销最新未完成发送，回退到发送前；保留此前已完成剧情"')
  return source.slice(0, begin) + part + source.slice(end)
}
