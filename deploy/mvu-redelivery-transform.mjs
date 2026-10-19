// 已保存的MVU操作沿作者队列重投；deferred汇总为idle，不再用活动phase拒绝它。
export function applyMvuRedeliveryTransform(source) {
  const start = source.indexOf('  async function retrySettlement(')
  if (start < 0) return source // 旧作者代没有此入口，不另造重投协议。
  const end = source.indexOf('\n  async function ', start + 1)
  const stop = end < 0 ? source.length : end
  const body = source.slice(start, stop).replace(
    "          if (activity.phase !== 'pending') throw new Error('等待中的结算状态已经变化，请刷新后重试')\n",
    '')
  return source.slice(0, start) + body + source.slice(stop)
}
