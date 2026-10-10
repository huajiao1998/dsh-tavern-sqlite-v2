// 失败状态的**唯一投影**（缺陷 A 的根治，2026-10-11）。
//
// 为什么不是事件广播：账本与表面的写入时间本来就错开——
//   · 账本：`timeline.apply({kind:'body.begin'})` 当场记下失败操作（**早于**任何原生事件）；
//   · 表面：要等 agent 真正跑起来才有 turn/start、才有作者 rollbackAvailability 认识的痕迹。
// 一个"准备期失败"的回合在两侧的结论相反：账本说有失败要清，表面说什么都没发生。**不存在
// 一个时刻两者一致**，所以写时广播无值可播，只能在读时从已落盘 archive 派生。
// 与 chat-session-state.js 的 rollbackViewFields/rollbackCache（读时投影＋廉价 key）同思路。
//
// 三个消费方原先各自重算同一批事实（这正是死锁成因：不是谁算错，而是没有单一出处让它们必然一致）：
//   · 守卫 assertRollbackBodyPreparation（作者 turn-orchestration.js 的 fence 缝）——只看账本；
//   · rollbackAvailability（作者 rollback-surface.js）——只看表面；
//   · lib/failure-cleanup-target.js 的 inspectNativeFailureTail / lib/clean-rollback.js 的判据——各写各的。
// 现在统一到本模块：**一次算清、冻结快照、各消费方按需取字段**。
//
// 订阅方收到的必须是**冻结副本**：回退本身会改写被投影的状态，而 assertFailureTargetNow 靠
// 入口处取的 state.failedTurns 防止目标中途移动（clean-rollback.js 的 sameFailureIntent 同此意）。
// 返回可变活对象会把重入风险带回来。

/** 分支归属：没有 basedOn.branchId 的旧账本视为当代分支。 */
function ownedByBranch(operation, branchId) {
  return !operation?.basedOn?.branchId || operation.basedOn.branchId === branchId
}

/**
 * 账本层的失败状态 —— **纯函数，无任何依赖、不需要 Session lease**。
 * 守卫（回合准备期）只有 chat，正好取这一层。
 * @returns {{branchId:string|null,revision:number|null,ledgerFailed:number[],pendingCleanupTurns:number[]}}
 */
export function ledgerFailureState(chat) {
  const branchId = typeof chat?.timeline?.branchId === 'string' ? chat.timeline.branchId : null
  const revision = Number(chat?._storageRevision)
  const turns = []
  for (const operation of Object.values(chat?.timeline?.operations || {})) {
    if (!operation || operation.kind !== 'body' || operation.status !== 'failed') continue
    if (!ownedByBranch(operation, branchId)) continue
    const turn = Number(operation.turn)
    if (Number.isSafeInteger(turn) && turn >= 1) turns.push(turn)
  }
  const failed = [...new Set(turns)].sort((left, right) => left - right)
  // 守卫要的就是这一位：有失败正文轮尚未被物理清理。
  return Object.freeze({ branchId, revision: Number.isSafeInteger(revision) ? revision : null, ledgerFailed: Object.freeze(failed), pendingCleanupTurns: Object.freeze(failed) })
}

/**
 * 表面层的失败状态 —— 来自作者的 rollbackAvailability，语义完全不变（墓碑 / uncleared tail /
 * regeneratedDshTurns 抑制仍是作者的表面层职责），这里只做规整与归一。
 */
export function surfaceFailureState(surface) {
  const turns = []
  for (const turn of surface?.failedTurns || []) {
    const value = Number(turn)
    if (Number.isSafeInteger(value) && value >= 1) turns.push(value)
  }
  return Object.freeze({
    surfaceFailed: Object.freeze([...new Set(turns)].sort((left, right) => left - right)),
    canRollback: surface?.canRollback === true,
    canClearIncompleteReply: surface?.canClearIncompleteReply === true,
    reason: typeof surface?.reason === 'string' ? surface.reason : '',
    unclearedTurns: Object.freeze((surface?.unclearedTurns || []).map(Number).filter(Number.isSafeInteger)),
  })
}

/**
 * 合并策略 —— **全书唯一一处**"谁权威"的政策。
 *
 * 失败正文轮以**账本**为准。守卫与回退编排必须看到同一批轮次，否则"守卫要求先清理、回退不认
 * 这个失败"就互相等待（缺陷 A 的现场）。表面层作为**独立一路**并入而不是覆盖：它不认识当前
 * 上下文轮（仅酒馆上下文的 aborted 轮会被它整个忽略），不能据它的缺席否定账本里的事实。
 */
export function mergeFailureState(ledger, surface) {
  const merged = [...new Set([...(ledger?.ledgerFailed || []), ...(surface?.surfaceFailed || [])])].sort((left, right) => left - right)
  return Object.freeze({
    failedTurns: Object.freeze(merged),
    ledgerFailed: Object.freeze([...(ledger?.ledgerFailed || [])]),
    surfaceFailed: Object.freeze([...(surface?.surfaceFailed || [])]),
    // canRollback / reason 是"给出回退目标"的派生判据，**不是资格判据**；
    // 账本失败正文轮本身就是资格（原缺陷 A 里它俩一致才能解除互相等待）。
    canRollback: surface?.canRollback === true || merged.length > 0,
    reason: merged.length > 0 ? '' : (typeof surface?.reason === 'string' ? surface.reason : ''),
    canClearIncompleteReply: surface?.canClearIncompleteReply === true,
  })
}

/** 事件流尾：最后一个带 turn 的事件（不是 failed 最大值）。目标必须是尾，且流里确有该轮事件。 */
export function sessionTailState(events) {
  const turns = new Set()
  let tail = 0
  for (const event of Array.isArray(events) ? events : []) {
    const turn = Number(event?.data?.turn)
    if (!Number.isSafeInteger(turn) || turn < 1) continue
    turns.add(turn)
    tail = turn
  }
  return Object.freeze({ turns: Object.freeze([...turns].sort((left, right) => left - right)), tail })
}

/**
 * 合成失败状态投影（回退编排用）。**读时计算**，需在 Session lease 到手、chat 已重读之后调用
 * —— 所以消费方拿到的是这个函数（工厂），不是预算好的值。
 *
 * @param chat 已重读的档
 * @param {object} options
 * @param {(chat:object,evidence:object)=>object} options.availability 作者的可用性判据（DI 注入）
 * @param {object[]} [options.events] 原生事件；缺省时从 options.session.snapshotEvents() 取
 * @param {object} [options.session]
 * @param {object[]} [options.nodes] 表面节点
 * @param {object} [options.liveTarget] 调用方已算好的 inspectNativeFailureTail 结论（保持本模块无反向依赖）
 * @returns {object} 冻结快照
 */
export function readFailureState(chat, options = {}) {
  if (typeof options.availability !== 'function') {
    throw new Error('失败状态投影缺少可用性判据接线（availability）——拒绝用半份状态做回退决策')
  }
  const events = Array.isArray(options.events) ? options.events
    : (typeof options.session?.snapshotEvents === 'function' ? options.session.snapshotEvents() : [])
  const ledger = ledgerFailureState(chat)
  const surface = surfaceFailureState(options.availability(chat, { events, nodes: options.nodes }))
  const merged = mergeFailureState(ledger, surface)
  const tail = sessionTailState(events)
  return Object.freeze({
    ...ledger, ...surface, ...merged, ...tail,
    ...(options.liveTarget === undefined ? {} : { liveTarget: options.liveTarget }),
  })
}
