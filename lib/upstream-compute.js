// 上游调用身份/任务屏障；不包含任何卡计算算法或运行时模拟。
import { AsyncLocalStorage } from 'node:async_hooks'
import { rollbackBarrier, rollbackSchedulingBarrier } from './rollback-barrier.js'
const workerRequests = new AsyncLocalStorage()
export const COMPUTE_CONTROL = new Set(['claimTavernScriptWork','startTavernScriptWork','getTavernScriptWorkState','heartbeatTavernScriptRuntime','completeTavernHelperEvent','releaseTavernHelperRuntime'])
const writes = new Set(['updateTavernHelperPrompts','updateTavernHelperVariables','updateTavernHelperMessages','createTavernHelperMessages','replaceTavernHelperWorldbook','saveTavernExtensionSettings','saveTavernWorldInfo','saveTavernChatData','generateTavernHelper','generateTavernHelperRaw','stopTavernHelperGeneration','stopAllTavernHelperGeneration','recordMvuRuntimeDiagnostic','recordTavernCompatibilityCalls'])
export function computationBlocked(id) { return rollbackBarrier.has(id) || rollbackSchedulingBarrier.has(id) }
export function upstreamRequest(id) {
  const record = workerRequests.getStore()
  return record?.sessionId === String(id || '') && record.isCurrent() && !computationBlocked(record.sessionId) ? record : null
}
export function runUpstreamRequest(record, work) {
  if (!record?.isCurrent() || computationBlocked(record.sessionId)) throw new Error('上游计算请求已失效')
  return workerRequests.run(record, work)
}
export function assertUpstreamRequest(id) {
  if (!upstreamRequest(id)) {
    const error = new Error('卡计算只允许当前上游服务端执行器调用')
    error.code = 'UPSTREAM_COMPUTE_ONLY'
    throw error
  }
}
export function authorizeUpstreamCall(method, args, demand) {
  const id = String(args?.sessionId || '')
  if (method === 'claimTavernScriptWork' && !upstreamRequest(id)) {
    if (!computationBlocked(id)) demand(id)
    return { active:false, ready:false, event:null, serverOwned:true }
  }
  if (COMPUTE_CONTROL.has(method) || writes.has(method)) assertUpstreamRequest(id)
  if (method === 'callOpeningRuntime' && args?.method !== 'prepareOpeningCommand') assertUpstreamRequest('opening:' + String(args?.id || ''))
  return null
}
export function pageView(result, id) {
  if (!result?.view || upstreamRequest(id)) return result
  return { ...result, view:{ ...result.view, tavernHelperScripts:[], tavernMvuRuntime:null, tavernScriptRuntimeMode:'viewer', tavernServerCompute:true } }
}
