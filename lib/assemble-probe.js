// 第0刀：只统计实际整档组装，不保存正文/SQL/堆栈，不改store业务接口。
// 模块实例内按store绑定；关闭时不读时钟、不创建单次样本。到期在下一次观察时惰性停止，无定时器。
import { performance } from 'node:perf_hooks'

const targets = new WeakMap()
const REASONS = new Set([
  'read', 'readSlice', 'patch', 'update', 'readRevision', 'remove',
  'readSessionState', 'readSettlementCheckpoint', 'readSceneImageState',
  'readBackgroundConfig', 'readDisplayRuntimeState', 'readChangedIndices',
  'readChangedSlice', 'readViewDelta', 'openReadSource',
  'captureSend', 'captureSend.compensate',
])
const counts = () => ({ calls: 0, completed: 0, empty: 0, failed: 0, headFields: 0, messageRows: 0 })

/** 内部接线：一个store一个目标；业务侧只能begin/dispose，不能接受用户回调。 */
export function createAssembleProbeTarget() {
  let current = null, disposed = false
  function expire(window) {
    if (window?.active && performance.now() >= window.deadline) {
      window.active = false
      window.stopReason = 'expired'
    }
  }
  return {
    start({ chatId, durationMs, maxCalls }) {
      if (disposed) throw new Error('assemble探针：store已dispose')
      expire(current)
      if (current?.active) throw new Error('assemble探针：当前窗口尚未停止')
      const window = { active: true, stopReason: null, chatId, durationMs, maxCalls,
        deadline: performance.now() + durationMs, totals: counts(), byReason: new Map() }
      current = window
      const snapshot = () => {
        expire(window)
        // 每次返回脱离对象；不暴露chatId、库路径、正文或内部Map。
        return { active: window.active, stopReason: window.stopReason, durationMs, maxCalls,
          ...window.totals, byReason: Object.fromEntries([...window.byReason].map(([key, value]) => [key, { ...value }])) }
      }
      return Object.freeze({ snapshot, stop() {
        expire(window)
        if (window.active) { window.active = false; window.stopReason = 'manual' }
        return snapshot()
      } })
    },
    begin(chatId, reason) {
      const window = current
      if (!window?.active || window.chatId !== chatId) return undefined
      expire(window)
      if (!window.active) return undefined
      const key = REASONS.has(reason) ? reason : 'other'
      let group = window.byReason.get(key)
      if (!group) { group = counts(); window.byReason.set(key, group) }
      const add = (field, value) => { window.totals[field] += value; group[field] += value }
      add('calls', 1)
      if (window.totals.calls >= window.maxCalls) { window.active = false; window.stopReason = 'maxCalls' }
      // 达到上限的最后一次仍完成记账；下一次begin不再收集。
      return {
        loaded(headFields, messageRows) { add('headFields', headFields); add('messageRows', messageRows) },
        finish(outcome) { add(outcome, 1) },
      }
    },
    dispose() {
      disposed = true
      if (current?.active) { current.active = false; current.stopReason = 'disposed' }
      current = null
    },
  }
}

export function bindAssembleProbe(store, target) { targets.set(store, target) }

/** 独立诊断入口：调用方须另有对应档/有界窗口授权；不注册服务、不自行启用现场采集。 */
export function startAssembleProbe(store, { chatId, durationMs = 30_000, maxCalls = 1_000 } = {}) {
  const target = targets.get(store)
  if (!target) throw new Error('assemble探针：不是本模块实例绑定的store')
  if (typeof chatId !== 'string' || !chatId || chatId === '.' || chatId === '..' || /[\\/]/.test(chatId)) {
    throw new Error('assemble探针：必须指定合法chatId')
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 300_000) throw new Error('assemble探针：durationMs须为1至300000毫秒')
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100_000) throw new Error('assemble探针：maxCalls须为1至100000')
  return target.start({ chatId, durationMs, maxCalls })
}
