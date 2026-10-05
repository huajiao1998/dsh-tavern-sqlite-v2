// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/rollback-cleanup.js
//
// 真实现全在 dsh-tavern-sqlite-v2：
//   lib/rollback-cleanup.js      ← L1 编排/边界计算/内存就地重建/投影重折（本文件转出的主体）
//   rollback-layers.js           ← L1.5 轮次回拨 / L1.6 token-meter 作废 / L1.7 连接重置
//   lib/rollback-head-prune.js   ← L4 head 索引修剪
//
// 依赖注入（DI）：把**作者的** ./session-events.js 注入我们包的实现 —— 事件工具仍是作者那一份
//（与作者其它代码同实现，不在我们包里 fork）。
//
// 顺序语义不变：round-history 仍在**作者最后一次写 head（rollback.undo-point）之后**调
// cleanupRollbackHeadIndex；L1.5/L1.6 仍在"库截断 + 内存重建 + 投影重折"之后由 cleanupAfterRollback 调。
//
// 卸载语义：cleanupAfterRollback 是回退的**本体**（不是辅助层）⇒ 缺本包时**响亮抛错**，不静默半回退；
// 其余辅助导出降级为空实现（回退主操作仍成立）。
import { sessionEvents } from './session-events.js'

let impl = null
try {
  impl = await import('dsh-tavern-sqlite-v2/rollback-cleanup')
  impl.configureRollbackCleanup({ sessionEvents })
} catch (error) {
  console.warn('[rollback-cleanup] 未能加载 dsh-tavern-sqlite-v2/rollback-cleanup：' + String(error?.message || error))
}

export const cleanupAfterRollback = impl?.cleanupAfterRollback ?? (async () => {
  throw new Error('未安装 dsh-tavern-sqlite-v2：回退清理不可用（不静默半回退）')
})
export const preflightRollback = impl?.preflightRollback ?? (() => {
  throw new Error('未安装 dsh-tavern-sqlite-v2：前台回退预检不可用（不静默半回退）')
})
export const preflightRollbackAtSeq = impl?.preflightRollbackAtSeq ?? (() => {
  throw new Error('未安装 dsh-tavern-sqlite-v2：后台回退预检不可用（不静默半回退）')
})
export const cleanupAfterRollbackAtSeq = impl?.cleanupAfterRollbackAtSeq ?? (async () => {
  throw new Error('未安装 dsh-tavern-sqlite-v2：后台回退清理不可用（不静默半回退）')
})
export const cleanupRollbackHeadIndex = impl?.cleanupRollbackHeadIndex ?? (async () => 0)
export const rollbackBoundarySeq = impl?.rollbackBoundarySeq ?? (() => -1)
export const rewindSessionMemory = impl?.rewindSessionMemory ?? (() => {})
export const rebuildSessionProjections = impl?.rebuildSessionProjections ?? (() => {})
export const rewindRuntimeTurnCounter = impl?.rewindRuntimeTurnCounter ?? (() => false)
export const cleanupTokenMeterState = impl?.cleanupTokenMeterState ?? (() => false)