// [dsh-tavern-standard-owned:v1]
// 失败状态的唯一投影（缺陷 A）。作者树两侧各取所需：
//   · turn-orchestration.js 的守卫 fence → ledgerFailureState（只有 chat，无需 Session lease）
//   · clean-rollback 编排 → readFailureState（需 availability 注入 + 原生事件证据）
// 真实现在本包里，上游更新碰不到。
import { storagePackage } from './storage-package.js'
export const {
  ledgerFailureState, surfaceFailureState, mergeFailureState, sessionTailState, readFailureState,
} = await storagePackage('failure-state')
