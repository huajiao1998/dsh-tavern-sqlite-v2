// 只投影已经失效的「无适配器」诊断；不触正文/原生日志，不把压缩失败当成功。
export function projectCompactionWarning(state, providers) {
  if (!state || typeof state !== 'object') return state || null
  const warning = typeof state.warning === 'string' ? state.warning : ''
  const match = /^no adapter registered for provider "([^"\r\n]+)"$/.exec(warning.trim())
  if (!match || !Array.isArray(providers)) return state
  // 真正的进行中/失败/部分成功压缩仍需用户处理，不能借路由恢复清掉它。
  if (state.operation && state.operation.status !== 'completed') return state
  if (!providers.some(provider => provider?.id === match[1])) return state
  return { ...state, warning: '' }
}
