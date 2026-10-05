// 回退清理的 L1 本体与编排（原 tavern 包 lib/domain/rollback-cleanup.js 的剩余部分）—— 实现由本包拥有
//
// 承接：rollbackBoundarySeq（轮次边界计算）/ preflightRollback + cleanupAfterRollback（**前台**：
//       轮次轴 turn）/ preflightRollbackAtSeq + cleanupAfterRollbackAtSeq（**后台参与者**：seq 轴，
//       边界来自时间线账本的 participant.rewindTo）/ rewindSessionMemory（内存就地重建）/
//       rebuildSessionProjections（投影全量重折）
// 已拆出的兄弟模块：../rollback-layers.js（L1.5/L1.6）；./rollback-sync.js（同连接状态刷新）、./rollback-head-prune.js（L4）
//
// 依赖注入（DI）：`sessionEvents` 是**作者的**模块（./session-events.js），由作者树的薄垫片经
// configureRollbackCleanup() 注入 —— 保持"事件工具与作者其它代码同一份实现"，不在本包 fork。
// 未注入就使用 ⇒ fail-loud（绝不静默按空语义跑边界计算）。
//
// ⚠️ 调用方必须传"活的"服务引用（provider 在回退当场解析）：插件会被 loader 构造两次，
//    wiring 时抓到的 ctx.get 可能是 undefined（现场实测过一次静默跳过）。
// ⚠️ 后台会话的轮次**独立于前台**：它的回退边界只能按 **seq** 给（participant.rewindTo），
//    绝不由 turn 反推（见 preflightRollbackAtSeq）。
//
// 代码逐字来自 tools/deployed-baseline/.../rollback-cleanup.js（脚本提取，非手抄）。
import { rewindRuntimeTurnCounter, rewindRuntimeAgentState, cleanupTokenMeterState } from '../rollback-layers.js'
import { isDeepStrictEqual } from 'node:util'
import { cleanupRollbackHeadIndex as pruneHeadIndex } from './rollback-head-prune.js'

// 初始值是一个"清晰报错"的桩：抽取自基线的代码是**裸调用** sessionEvents(...) 的，
// 这样"未注入就使用"会立刻给出可读原因，而不是裸 TypeError（抽取文本保持逐字不变）。
let sessionEvents = () => {
  throw new Error('rollback-cleanup：sessionEvents 未注入 —— 作者树的薄垫片必须调用 configureRollbackCleanup({ sessionEvents })')
}
/** 由作者树垫片注入作者的 session-events 模块（DI；见文件头）。 */
export function configureRollbackCleanup(injected = {}) {
  if (typeof injected.sessionEvents !== 'function') {
    throw new Error('rollback-cleanup：configureRollbackCleanup 需要 { sessionEvents } 函数')
  }
  sessionEvents = injected.sessionEvents
}
export { rewindRuntimeTurnCounter, cleanupTokenMeterState }
export const cleanupRollbackHeadIndex = pruneHeadIndex
/**
 * 回退边界 = **最后一个 turn < hiddenTurn 的 turn/end** 的 seq（没有则 -1）。
 * ⚠️ hiddenTurn 的语义是"**要删掉的那一轮**"（= `round-history` 的 `rollbackSurface.turn`）：
 *   - 变量库 `variableStore.deleteFrom(chatId, hiddenTurn)` → `DELETE ... WHERE turn >= hiddenTurn`
 *   - 剧情时间线 `turn.rollback` 也是整轮移除 hiddenTurn
 * 所以 L1 保留 `turn < hiddenTurn`、L4 删除 `turn >= hiddenTurn`。
 *
 * `session/end-seed` 延伸规则（宿主语义：resume 构造时"末尾不是标记就在尾部补写一个"）：
 * 只保留**落在被删轮次块之前**的标记 —— 区间 `(边界, turn/start(hiddenTurn))` 内的最后一个。
 * 那是"上一轮结束后 resume 的切点"，属于被删轮次之前的状态（保留它 → 重启不再补写、游标不漂移）；
 * 块内/块后的标记属于被删状态，**随块一起删**，否则会把被删轮次留在库里 = 回退不干净。
 * 现场反例（2026-09-28 22:1x 复查发现）：服务重启后标记紧跟上一轮尾（#1884 紧跟 turn/end(232) #1883），
 * 此时回退 232 —— 旧规则"延伸到边界后第一个标记"会取到 #1884 → 整轮 232 一条不删。
 */
export function rollbackBoundarySeq(session, hiddenTurn) {
  const events = sessionEvents(session)
  let boundarySeq = -1
  for (const event of events) {
    if (event.type === 'turn/end' && (event.data?.turn ?? 0) < hiddenTurn) boundarySeq = event.seq
  }
  if (boundarySeq < 0) return boundarySeq
  let turnStartSeq = -1
  for (const event of events) {
    if (event.seq > boundarySeq && event.type === 'turn/start' && event.data?.turn === hiddenTurn) { turnStartSeq = event.seq; break }
  }
  if (turnStartSeq < 0) return boundarySeq
  for (const event of events) {
    if (event.seq > boundarySeq && event.seq < turnStartSeq && event.type === 'session/end-seed') boundarySeq = event.seq
  }
  return boundarySeq
}

/**
 * 会话内存就地重建：把宿主 Session 的物化视图回卷到 keep 条事件。
 * **必须就地**（不换 log 数组、不换 surfaceManager 对象）：SurfaceManager 持有 log
 * 引用，其他组件持有 surface 引用，换对象会留下幽灵引用。
 * @returns 重折后的 surface 节点数
 */
export function rewindSessionMemory(session, keep) {
  const log = session?.log
  if (!Array.isArray(log)) throw new Error('回退清理：会话缺少 log 事件数组')
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > log.length) {
    throw new Error(`回退清理：保留长度 ${String(keep)} 越界（当前日志 ${String(log.length)} 条）`)
  }
  const manager = session.surfaceManager
  if (manager === undefined || manager === null) throw new Error('回退清理：会话缺少 surfaceManager')
  log.length = keep
  session.eventsSnapshot = undefined
  session.firstLiveSeq = keep
  const SurfaceManagerCtor = Object.getPrototypeOf(manager).constructor
  const fresh = new SurfaceManagerCtor(log, manager.baseSeq ?? 0, manager.projections)
  manager._state = fresh._state
  manager._lastProcessedSeq = fresh._lastProcessedSeq
  manager._pendingPlan = undefined
  // 宿主Session还有独立增量缓存；只截log/重折surface会继续返回被删轮的正文与请求路由。
  if ('derived' in session) session.derived = []
  if ('derivedNodes' in session) session.derivedNodes = 0
  if ('derivedGeneration' in session) session.derivedGeneration = -1
  if ('headerFoldSeq' in session) { session.headerFold = undefined; session.headerFoldSeq = 0 }
  if ('contextFoldSeq' in session) { session.contextFold = undefined; session.contextFoldSeq = 0 }
  if ('toolHistoryProjection' in session) {
    const ToolHistoryCtor = Object.getPrototypeOf(session.toolHistoryProjection).constructor
    session.toolHistoryProjection = new ToolHistoryCtor()
    session.toolHistorySeq = 0
  }
  const nodes = manager.nodes // getter：从保留前缀当场重折
  if (!Array.isArray(nodes)) throw new Error('回退清理：surface 重折失败（nodes 非数组）')
  const expectedTail = (manager.baseSeq ?? 0) + log.length - 1
  if (log.length > 0 && manager._lastProcessedSeq !== expectedTail) {
    throw new Error(`回退清理：surface 折叠游标 ${String(manager._lastProcessedSeq)} ≠ 日志末尾 ${String(expectedTail)}`)
  }
  const tail = log.at(-1)
  if (tail !== undefined && tail.seq !== keep - 1) {
    throw new Error(`回退清理：日志尾 seq ${String(tail.seq)} ≠ ${String(keep - 1)}（log 与 seq 不再对位）`)
  }
  if (session.seq !== keep) throw new Error(`回退清理：会话 seq ${String(session.seq)} ≠ 保留长度 ${String(keep)}`)
  return nodes.length
}

/**
 * 投影注册表重折：删掉该会话的全部 cell，再用宿主 hydrate 从保留前缀全量重折，
 * 并断言每个已注册单元的水位都等于日志末尾（cell 水位只增不减，不删就永远滞留旧轮）。
 * @returns 重折到的末尾 seq（空日志为 -1）
 */
export function rebuildSessionProjections(projections, session) {
  const registrations = projections?.registrations
  if (registrations === undefined || typeof registrations.values !== 'function') {
    throw new Error('回退清理：缺少 sessionProjections 注册表（接线需传入 ctx.get("sessionProjections")）')
  }
  const events = sessionEvents(session)
  const endSeq = events.at(-1)?.seq ?? -1
  for (const registration of registrations.values()) registration.cells.delete(session)
  projections.hydrate(session, {}, events, 0)
  for (const registration of registrations.values()) {
    const cell = registration.cells.get(session)
    if (cell === undefined || cell.observedSeq !== endSeq) {
      throw new Error(`回退清理：投影单元 ${JSON.stringify(registration.def?.key)} 重折后水位 ${String(cell?.observedSeq)} ≠ 日志末尾 ${String(endSeq)}`)
    }
  }
  return endSeq
}

// ---------------------------------------------------------------------------
// 合法截断点（只读；不写任何东西）
// ---------------------------------------------------------------------------

/** 事件自带轮次（turn/* 与消息事件的 data.turn）；非轮次事件（seed / 系统头）返回 null。 */
function eventTurn(event) {
  const turn = Number(event?.data?.turn)
  return Number.isSafeInteger(turn) ? turn : null
}

/**
 * **轮次轴**（前台回退）：返回 `{ mode, boundarySeq, keep, dropped, noop:false }`，无安全边界返回 null。
 *   · mode='previous-turn'：与 rollbackBoundarySeq 同语义 —— 最后一个 `turn < hiddenTurn` 的 turn/end，
 *     再按宿主 `session/end-seed` 规则延伸到目标轮 turn/start 之前；
 *   · mode='first-turn'：事件流里**没有**更早的 turn/end（回退第一轮）⇒ 边界 = 目标轮 turn/start 的
 *     **前一条**，即保留 turn/start 之前的全部初始事件（会话头/种子）；turn/start 就是第一条 ⇒ null
 *     （**禁止凭 turn/start 删 metadata**：绝不把会话头/种子一起删掉）。
 */
function resolveTurnCut(session, hiddenTurn) {
  const log = session?.log
  if (!Array.isArray(log) || log.length === 0) return null
  let boundarySeq = rollbackBoundarySeq(session, hiddenTurn)
  let mode = 'previous-turn'
  if (boundarySeq < 0) {
    mode = 'first-turn'
    const events = sessionEvents(session)
    const startIndex = events.findIndex(event => event?.type === 'turn/start' && eventTurn(event) === hiddenTurn)
    if (startIndex < 1) return null
    boundarySeq = Number(events[startIndex - 1]?.seq)
  }
  if (!Number.isSafeInteger(boundarySeq) || boundarySeq < 0) return null
  const keep = boundarySeq + 1
  if (keep < 1 || keep > log.length) return null
  return { mode, boundarySeq, keep, dropped: log.length - keep, noop: false }
}

/**
 * **seq 轴**（后台参与者回退）：边界 = 时间线账本的 `participant.rewindTo`（**该会话自己的 seq**）。
 *   · boundarySeq >= 0：保留 `seq <= boundarySeq` 的前缀，且前缀末条必须正好是 boundarySeq；
 *   · boundarySeq === -1：新建 participant（没有"上一轮"）⇒ 保留**首任务入队/turn/start之前**的全部
 *     初始事件（会话头/种子）。第一个 turn/start 就是第一条 ⇒ **null（禁止盲删 metadata）**。
 *   · 已经整个落在边界内（无可删段）⇒ `mode='nothing-to-truncate'`、`noop:true`：
 *     这是**核对过的无事可做**（不是"猜不出来当成功"），调用方据此报 noop 而不是"已物理回退"。
 * ⚠️ 后台会话的轮次独立于前台 ⇒ 这里**绝不**由 turn 反推边界。
 */
function resolveSeqCut(session, boundarySeq) {
  const log = session?.log
  if (!Array.isArray(log) || log.length === 0) return null
  const firstTurn = log.findIndex(event => event?.type === 'turn/start')
  const beforeTurn = firstTurn < 0 ? log.length : firstTurn
  // followup先写入inbox，再写turn/start；入队是任务起点，不是初始化。
  // 只向前收窄连续前缀，连同后续消费/正文/工具结果一起删，绝不单独中删队列事件。
  const queued = log.slice(0, beforeTurn).findIndex(event => event?.type === 'agent/inbox/spliced' && event.data?.inserted?.length > 0)
  const taskStart = queued < 0 ? firstTurn : queued
  if (boundarySeq === -1) {
    if (taskStart === 0) return null
    if (taskStart < 0) return { mode: 'nothing-to-truncate', boundarySeq: Number(log.at(-1)?.seq ?? -1), keep: log.length, dropped: 0, noop: true }
    const cutSeq = Number(log[taskStart - 1]?.seq)
    if (!Number.isSafeInteger(cutSeq) || cutSeq < 0) return null
    return { mode: 'prefix-before-first-turn', boundarySeq: cutSeq, keep: taskStart, dropped: log.length - taskStart, noop: false }
  }
  if (!Number.isSafeInteger(boundarySeq) || boundarySeq < 0) return null
  // 旧创建切点登记在descriptor之前；身份属于该child初始化，不属于要删的剧情轮。
  // 仅修正首个turn/start之前的身份切点，仍保留连续前缀；轮内descriptor不延伸、不规避半轮护栏。
  if (session.header?.origin === 'subagent') {
    const initialization = log.slice(0, taskStart < 0 ? log.length : taskStart)
    const descriptor = initialization.find(event => event?.type === 'subagent/descriptor')
    if (Number.isSafeInteger(descriptor?.seq) && descriptor.seq > boundarySeq) boundarySeq = descriptor.seq
  }
  // 兼容旧版已记录的『首轮之前』切点包含入队的情况；真正轮内切点仍交半轮护栏拒绝。
  if (queued >= 0 && (firstTurn < 0 || boundarySeq < Number(log[firstTurn].seq)) && boundarySeq >= Number(log[queued].seq)) {
    if (queued === 0) return null
    boundarySeq = Number(log[queued - 1].seq)
  }
  let keep = 0
  while (keep < log.length && Number(log[keep]?.seq) <= boundarySeq) keep += 1
  if (keep === 0) return null
  if (keep === log.length) return { mode: 'nothing-to-truncate', boundarySeq: Number(log.at(-1)?.seq ?? -1), keep, dropped: 0, noop: true }
  if (Number(log[keep - 1]?.seq) !== boundarySeq) return null
  return { mode: 'seq-boundary', boundarySeq, keep, dropped: log.length - keep, noop: false }
}

// ---------------------------------------------------------------------------
// 严格预检（只读；必须在任何破坏性写入之前）
// ---------------------------------------------------------------------------

/**
 * 回退**不可逆点之前**的严格预检（只读，不写任何东西）：纯尾边界 + 引用链 + 四层接线。
 *
 * 为什么必须在正文 update 之前：库一旦被截断，就没有"再 try 恢复 oldchat"这条路 ——
 * 那只会留下"正文已回退、transcript 未截断"或反过来"库已删、正文还在"的**幽灵状态**。
 * 所以边界不合法、接线缺失时在这里当场拒绝。
 *
 * 严格判据（任一不满足即拒绝，绝不当成"已清"）：
 *   ① 请求参数合法（轮次是 ≥1 安全整数 / seq 是安全整数或 -1）；会话有 header.id、log 数组、surfaceManager；
 *   ② 有合法截断点；轮次轴下 `keep >= log.length` 是**拒绝**（"无事可做"不是回退成功），
 *      seq 轴下"整个落在边界内"是**核对过的 noop**（`noop:true`，调用方不得报成已物理回退）；
 *   ③ **纯尾**：seq 轴与数组轴在切点一致（保留段 seq ≤ 边界 < 待删段 seq），边界 = 保留段最后一条；
 *   ④ 不切断任何一轮：轮次轴下待删段不得含 `turn < hiddenTurn` 的事件；seq 轴下保留段与待删段的
 *      轮次集合必须不相交（背景轮次独立于前台，只能按集合判，不能按 turn 反推）；
 *   ⑤ 引用链：保留段事件的 `sourceEventSeqs` / `surfaceOp.start|end` **不得指向被删 seq**
 *      （宿主 replace 校验 `bySeq.has(seq)`，断了会抛"消息替换缺少有效的来源引用"）；
 *   ⑥ 四层接线（strict 下缺一即拒，**不允许事后 skip**）：`persistence.truncateEvents`、
 *      `projections.registrations/hydrate/stateOf`、`projectionCache.write`、`head.readSlice/update`（L4）；
 *      且 `stateOf(session,'turnBoundary').lastTurn` 必须是**有效数** —— L1.5 的轮次计数器
 *      （用户 required counter）拿不到有效值就**硬拒**，不得静默跳过（NaN 同样视为不可完成）。
 *      统一编排要求L1.6 token-meter与同连接同步接线；不再通过销毁WS刷新状态。
 *
 * @returns 冻结的 `{ ok, violations, sessionId, hiddenTurn, requestedSeq, noop, mode, boundarySeq, keep, dropped }`
 */

/** 预检主体（两种轴共用）：`variant.resolve()` 给出截断点，`variant.middleDelete()` 判定"切断轮次"。 */
function runRollbackPreflight(session, options, variant) {
  const strict = options.strict !== false
  const violations = []
  const finish = cut => Object.freeze({
    ok: violations.length === 0, violations: [...violations], sessionId: String(session?.header?.id ?? ''),
    hiddenTurn: variant.hiddenTurn ?? null, requestedSeq: variant.requestedSeq ?? null,
    noop: cut?.noop === true, mode: cut?.mode ?? null,
    boundarySeq: cut?.boundarySeq ?? -1, keep: cut?.keep ?? -1, dropped: cut?.dropped ?? 0,
    observedLength: Array.isArray(session?.log) ? session.log.length : -1,
  })
  const reject = (code, message) => {
    violations.push({ code, message })
    if (strict) { const error = new Error(message); error.code = 'ROLLBACK_PREFLIGHT_' + code; throw error }
  }
  variant.checkRequest(reject)
  const log = session?.log
  if (!Array.isArray(log)) reject('NO_LOG', '回退预检：会话缺少 log 事件数组（无法就地重建内存镜像）')
  else if (log.length === 0) reject('EMPTY_LOG', '回退预检：会话事件日志为空，没有可截断的尾段')
  if (String(session?.header?.id ?? '') === '') reject('NO_SESSION_ID', '回退预检：会话缺少 header.id')
  const manager = session?.surfaceManager
  if (manager === undefined || manager === null) reject('NO_SURFACE_MANAGER', '回退预检：会话缺少 surfaceManager（无法就地重折 surface）')
  if (!strict && violations.length > 0) return finish(null)

  // ---------- ② 合法截断点 + ③ 纯尾 + ④ 不切断轮次 ----------
  const cut = variant.resolve()
  if (cut === null) reject('NO_SAFE_BOUNDARY', variant.noBoundaryMessage)
  else if (cut.noop === true) {
    // seq 轴上"整个落在边界内"= 核对过的无事可做；轮次轴不允许走到这里（由 checkCut 拒绝）。
    if (variant.allowNoop !== true) reject('NOTHING_TO_TRUNCATE', variant.nothingMessage)
  } else if (cut.dropped === 0) {
    // 轮次轴：边界之外没有可截断的事件 = "无事可做"，不是回退成功。
    // （seq 轴的同义情形已在 resolve 阶段成为核对过的 noop，不会走到这里。）
    reject('NOTHING_TO_TRUNCATE', variant.nothingMessage)
  } else {
    if (Number(log[cut.keep - 1]?.seq) !== cut.boundarySeq) reject('BOUNDARY_NOT_LAST_KEPT', `回退预检：边界 ${cut.boundarySeq} 不是保留段最后一条（实际 ${String(log[cut.keep - 1]?.seq)}）`)
    for (let index = 0; index < log.length; index += 1) {
      const seq = Number(log[index]?.seq)
      if (!Number.isSafeInteger(seq)) { reject('BAD_SEQ', `回退预检：第 ${index} 条事件缺少安全整数 seq（无法保证游标对位）`); break }
      if (index < cut.keep && seq > cut.boundarySeq) { reject('NOT_PURE_TAIL', `回退预检：保留段第 ${index} 条 seq ${seq} > 边界 ${cut.boundarySeq} —— seq 轴与数组轴在切点不一致，截断会留下空洞`); break }
      if (index >= cut.keep && seq <= cut.boundarySeq) { reject('NOT_PURE_TAIL', `回退预检：待删段第 ${index} 条 seq ${seq} ≤ 边界 ${cut.boundarySeq} —— 同上`); break }
    }
    variant.middleDelete(cut, reject)
  }
  if (!strict && violations.length > 0) return finish(cut)

  // ---------- ⑤ 引用链：保留段不得指向被删 seq ----------
  if (cut !== null && cut.noop !== true) {
    const kept = new Set(log.slice(0, cut.keep).map(event => Number(event?.seq)))
    for (const event of log.slice(0, cut.keep)) {
      const referenced = []
      if (Array.isArray(event?.sourceEventSeqs)) referenced.push(...event.sourceEventSeqs)
      const op = event?.surfaceOp
      if (op !== null && op !== undefined && typeof op === 'object') {
        for (const key of ['startSeq', 'endSeq', 'start', 'end']) if (op[key] !== undefined) referenced.push(op[key])
      }
      let dangling = null
      for (const seq of referenced) {
        if (!Number.isSafeInteger(Number(seq))) { dangling = { seq, bad: true }; break }
        if (!kept.has(Number(seq))) { dangling = { seq, bad: false }; break }
      }
      if (dangling !== null) {
        reject('DANGLING_REFERENCE', dangling.bad
          ? `回退预检：保留段事件 seq ${String(event?.seq)} 的引用不是安全整数（${String(dangling.seq)}）`
          : `回退预检：保留段事件 seq ${String(event?.seq)} 仍引用被删的 seq ${String(dangling.seq)} —— 引用链会断`)
        break
      }
    }
  }
  if (!strict && violations.length > 0) return finish(cut)

  // ---------- ⑥ 四层接线（strict 缺一即拒；不允许事后 skip） ----------
  // 只在"要接线"时核：strict 调用，或调用方显式传了 persistence/services/head；
  // 纯诊断（strict=false 且不传接线）只报告边界/引用链结论。
  const checkWiring = strict || options.persistence !== undefined || options.services !== undefined || options.head !== undefined
  if (checkWiring) {
    const persistence = options.persistence
    if (persistence === undefined || persistence === null || typeof persistence.truncateEvents !== 'function') {
      reject('NO_PERSISTENCE', '回退预检：缺少 sessionPersistence.truncateEvents（strict 下不允许事后 skip L1 截断）')
    }
    const projections = options.services?.projections
    if (projections === undefined || projections === null) reject('NO_PROJECTIONS', '回退预检：未接入 sessionProjections（strict 下不允许事后 skip 投影重折）')
    else {
      if (projections.registrations === undefined || typeof projections.registrations.values !== 'function') reject('NO_PROJECTIONS', '回退预检：sessionProjections 缺少 registrations 注册表')
      if (typeof projections.hydrate !== 'function') reject('NO_PROJECTIONS', '回退预检：sessionProjections 缺少 hydrate')
      if (typeof projections.stateOf !== 'function') reject('NO_TURN_BOUNDARY', '回退预检：sessionProjections 缺少 stateOf（L1.5 轮次回拨会被静默跳过）')
      else if (options.requireTurnCounter !== false) {
        // L1.5 是用户 required counter：拿不到有效值（NaN/undefined）就是**不可完成**，硬拒。
        let boundary
        let readFailed = false
        try { boundary = projections.stateOf(session, 'turnBoundary') }
        catch (error) { readFailed = true; reject('NO_TURN_BOUNDARY_VALUE', `回退预检：读取 turnBoundary 投影失败（L1.5 无法完成）：${String(error?.message || error)}`) }
        if (!readFailed && !Number.isFinite(Number(boundary?.lastTurn ?? NaN))) {
          reject('NO_TURN_BOUNDARY_VALUE', `回退预检：sessionProjections.stateOf(session,"turnBoundary").lastTurn 不是有效数（${String(boundary?.lastTurn)}）—— L1.5 轮次计数器无法回拨（required counter，硬拒）`)
        }
      }
    }
    const agent = typeof options.services?.agentProvider === 'function' ? options.services.agentProvider() : undefined
    if (agent?.session !== undefined && agent.session !== session) reject('AGENT_SESSION_MISMATCH', '回退预检：agent与Session对象不一致，拒绝清理其它会话')
    if (agent?.phase?.kind === 'running') reject('AGENT_RUNNING', '回退预检：agent仍在运行，拒绝截断')
    if (options.services?.requireAuxiliary === true) {
      if (options.services.coldRollback !== true && (!agent?.phase || agent.session !== session)) reject('NO_LIVE_AGENT', '回退预检：必须取得同一Session的活Agent')
      if (agent && (!Array.isArray(agent.inbox?.nextTurn) || !Array.isArray(agent.inbox?.nextStep))) reject('NO_INBOX', '回退预检：同连接完整队列基线缺少Agent inbox')
      const meter = options.services.tokenMeterProvider?.()
      if (!meter?.states || typeof meter.states.delete !== 'function' || typeof meter.states.has !== 'function') reject('NO_TOKEN_METER', '回退预检：token缓存结构缺失')
      const sync = options.services.rollbackSyncProvider?.()
      if (typeof sync?.assertReady !== 'function' || typeof sync?.publish !== 'function') reject('NO_ROLLBACK_SYNC', '回退预检：同连接状态同步服务缺失')
    }
    const projectionCache = options.services?.projectionCache
    if (projectionCache === undefined || projectionCache === null || typeof projectionCache.write !== 'function') {
      reject('NO_PROJECTION_CACHE', '回退预检：未接入 sessionProjectionCache.write（strict 下不允许事后 skip 检查点重算）')
    }
    const head = options.head
    if (head === undefined || head === null || typeof head.readSlice !== 'function' || typeof head.update !== 'function') {
      reject('NO_HEAD_STORE', '回退预检：L4 需要 chats.readSlice + chats.update（作者 index 的 chats 需补 readSlice: chatPersistence.readSlice）')
    }
  }
  return finish(cut)
}

/**
 * 前台（轮次轴）严格预检。`hiddenTurn` = **要删掉的那一轮**。
 * @param options - { strict=true, persistence, services, head, requireTurnCounter? }
 * @returns 冻结的预检结论（见 runRollbackPreflight）；strict 下违规即抛（error.code = ROLLBACK_PREFLIGHT_<CODE>）。
 */
export function preflightRollback(session, hiddenTurn, options = {}) {
  const turn = Number(hiddenTurn)
  return runRollbackPreflight(session, options, {
    hiddenTurn: Number.isSafeInteger(turn) ? turn : null, requestedSeq: null,
    allowNoop: false,
    noBoundaryMessage: `回退预检：事件流里既没有 turn<${String(hiddenTurn)} 的 turn/end，也没有可保留前缀的 turn/${String(hiddenTurn)} 的 turn/start —— 没有安全边界，拒绝猜删（不把 -1 当成功）`,
    nothingMessage: '回退预检：边界之外没有可截断的事件 —— "无事可做"不是回退成功',
    checkRequest: reject => {
      if (!Number.isSafeInteger(turn) || turn < 1) reject('BAD_HIDDEN_TURN', `回退预检：hiddenTurn 必须是 ≥1 的安全整数（收到 ${String(hiddenTurn)}）—— 拒绝在没有明确轮次时截断`)
    },
    resolve: () => resolveTurnCut(session, turn),
    middleDelete: (cut, reject) => {
      for (const event of session.log.slice(cut.keep)) {
        const value = eventTurn(event)
        if (value !== null && value < turn) { reject('MIDDLE_DELETE', `回退预检：待删段含 turn ${value} < ${turn} 的事件（seq ${String(event?.seq)}）—— 只允许纯尾截断，禁止中间删除`); break }
      }
    },
  })
}

// 旧后台任务在完整turn/end之后追加空surface替换，继承旧turn编号。
// 只识别引用全部落在保留前缀的纯清理事件；不调整边界、不删除中间行、不放过真实半轮。
function isLegacyPostTurnCleanup(event, session, cut) {
  const boundary = session.log[cut.keep - 1]
  const turn = eventTurn(event)
  const op = event?.surfaceOp
  const refs = event?.sourceEventSeqs
  if (boundary?.type !== 'turn/end' || turn === null || eventTurn(boundary) !== turn
    || event?.type !== 'assistant/message' || !Array.isArray(event.data?.message?.content)
    || event.data.message.content.length !== 0 || op?.op !== 'replace'
    || !Number.isSafeInteger(op.startSeq) || !Number.isSafeInteger(op.endSeq)
    || op.startSeq < 0 || op.startSeq > op.endSeq || op.endSeq > cut.boundarySeq
    || !Array.isArray(refs) || refs.length === 0) return false
  const bySeq = new Map(session.log.slice(0, cut.keep).map(item => [item.seq, item]))
  if (!bySeq.has(op.startSeq) || !bySeq.has(op.endSeq)
    || refs.some(seq => !Number.isSafeInteger(seq) || seq < op.startSeq || seq > op.endSeq || !bySeq.has(seq))) return false
  // 下一轮开始后的任何消息都不能冒充上一轮清理。
  return !session.log.slice(cut.keep).some(item => item.seq < event.seq && item.type === 'turn/start')
}

/**
 * **后台参与者（seq 轴）**严格预检：边界 = 时间线账本的 `participant.rewindTo`
 * （该后台会话**自己的 seq**；`-1` = 新建 participant）。
 *   · `-1` 时保留第一个 turn/start 之前的全部初始事件；turn/start 就是第一条 ⇒ **拒绝**（禁删 metadata）；
 *   · 走到 `noop:true`（整个落在边界内）时**不算失败**，但调用方不得报成"已物理回退"；
 *   · 其余判据与前台完全一致（纯尾 / 不切断轮次 / 引用链 / 四层接线 / L1.5 有效数）。
 * @param options - { strict=true, persistence, services, head, requireTurnCounter? }
 */
export function preflightRollbackAtSeq(session, boundarySeq, options = {}) {
  const requested = Number(boundarySeq)
  return runRollbackPreflight(session, options, {
    hiddenTurn: null, requestedSeq: Number.isSafeInteger(requested) ? requested : null,
    allowNoop: true,
    noBoundaryMessage: `回退预检：seq 边界 ${String(boundarySeq)} 不是纯尾切点（前缀末条 seq 对不上 / -1 时第一个 turn/start 就是第一条 ⇒ 会删掉会话头）—— 拒绝猜删`,
    nothingMessage: '回退预检：后台会话整个落在边界内（无可删段）',
    checkRequest: reject => {
      if (!Number.isSafeInteger(requested)) reject('BAD_BOUNDARY_SEQ', `回退预检：seq 边界必须是安全整数（-1 表示新建 participant），收到 ${String(boundarySeq)}`)
    },
    resolve: () => resolveSeqCut(session, requested),
    middleDelete: (cut, reject) => {
      // 背景会话轮次独立于前台 ⇒ 只能按"轮次集合不相交"判：绝不把某一轮切一半。
      const droppedTurns = new Set()
      for (const event of session.log.slice(cut.keep)) {
        const value = eventTurn(event)
        if (value !== null && !isLegacyPostTurnCleanup(event, session, cut)) droppedTurns.add(value)
      }
      if (droppedTurns.size === 0) return
      // 固定系统头可在首个turn/start前带turn:1，它是初始化前缀，不是已开始轮次的一部分。
      // 只按真实turn块判断相交；切进任意已开始轮内部仍按原护栏拒绝。
      const keptPrefix = session.log.slice(0, cut.keep)
      const firstTurnStart = keptPrefix.findIndex(event => event?.type === 'turn/start')
      for (const event of keptPrefix.slice(firstTurnStart < 0 ? keptPrefix.length : firstTurnStart)) {
        const value = eventTurn(event)
        if (value !== null && droppedTurns.has(value)) {
          reject('MIDDLE_DELETE', `回退预检：seq 边界 ${cut.boundarySeq} 把 turn ${value} 切了一半（该轮在保留段与待删段都有事件）—— 只允许整轮边界`)
          break
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 清理（不可逆点之后）：drain → 单事务截断 → 内存就地重建 → 派生视图重折
// ---------------------------------------------------------------------------

/** strict 清理主体（两种轴共用；调用前必须已有通过的预检计划）。 */
async function performStrictCut(persistence, session, plan, services, options, label) {
  const sessionId = String(session?.header?.id ?? '')
  if (plan.ok !== true) {
    throw new Error(`${label}：预检未通过（${(plan.violations || []).map(item => item.code).join('、') || 'no-plan'}）—— 拒绝截断`)
  }
  // noop只表示内存log无可删尾部；数据库、句柄和派生缓存仍必须核对并重建。
  // 同边界truncate为幂等SQL操作，也能修复『SQL已删、内存尚未重建』的重试。
  // ⑥ 记录 drain：截断前把活动写句柄"已接受未落地"的路由缓冲排空（截断内部也会做一次，这里提前做，
  //    保证 DELETE 之后不会再有迟到批次写进新尾部）。
  let drained = false
  if (typeof persistence.drainOpenHandles === 'function') {
    await persistence.drainOpenHandles(sessionId)
    drained = true
  }
  // ---------- L1：库截断 + 句柄回卷 + 内存就地重建 + 派生视图重折 ----------
  // 仅恢复该child自己唯一的真实身份元数据；不保留被删业务事件、不填充游标。
  // 已受损档经显式修复把descriptor追加在尾部时，后续回退仍须保有同一身份。
  const descriptors = session.header?.origin === 'subagent'
    ? session.log.filter(event => event?.type === 'subagent/descriptor' && event.seq >= (session.inheritedEventCount ?? 0)) : []
  const identity = descriptors.length === 1 && descriptors[0].seq >= plan.keep ? descriptors[0] : undefined
  // 专用truncate原子保存既有身份；不Session.append、不走普通路由，也不临时关闭写入屏障。
  const meta = await persistence.truncateEvents(session.header, plan.boundarySeq, identity)
  const keep = plan.keep + (identity === undefined ? 0 : 1)
  if (meta?.eventCount !== keep || (identity !== undefined && (!meta.rollbackIdentity || meta.rollbackIdentity.seq !== plan.keep || meta.rollbackIdentity.type !== 'subagent/descriptor' || !isDeepStrictEqual(meta.rollbackIdentity.data, identity.data)))) {
    throw new Error(`回退清理：库事件数/身份回执 ${String(meta?.eventCount)} ≠ 预期保留 ${keep}（库未按预期回拨）`)
  }
  rewindSessionMemory(session, plan.keep)
  if (identity !== undefined) {
    // 此事件已在同一SQL事务持久化；只移植到原log，不再发布session/event造成重复追加。
    const event = structuredClone(meta.rollbackIdentity)
    const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
    session.log.push(freeze(event))
    rewindSessionMemory(session, keep)
  }
  const nodes = session.surfaceManager.nodes.length
  rebuildSessionProjections(services?.projections, session)
  await services.projectionCache.write(session)
  const turnRewound = rewindRuntimeTurnCounter(session, services)
  const expectedTurn = Number(services.projections.stateOf(session, 'turnBoundary')?.lastTurn)
  const agent = services.agentProvider?.()
  if (!Number.isSafeInteger(expectedTurn) || expectedTurn < 0) throw new Error('回退清理：重折轮次不是非负安全整数')
  if (agent && (!agent.phase || agent.phase.kind === 'running' || agent.phase.lastTurn !== expectedTurn)) {
    throw new Error('回退清理：Agent轮次未恢复到保留日志，拒绝报告成功')
  }
  rewindRuntimeAgentState(session, services)
  const tokenMeterCleared = cleanupTokenMeterState(session, services)
  return Object.freeze({ ok: true, strict: true, noop: plan.noop === true, truncated: plan.noop !== true, mode: plan.mode,
    boundarySeq: plan.boundarySeq, keep: plan.keep, dropped: plan.dropped, drained, nodes,
    turnRewound, tokenMeterCleared, skipped: Object.freeze([]) })
}

/**
 * 回退后的统一清理（由 round-history 在正文提交后、**不可逆点**调用）。
 *
 * 单一路径：预检 → 排空句柄 → SQL纯尾截断 → 就地重建。
 * 缺边界或缺接线均抛错；不保留无strict时warn跳过的旧执行分支。
 * options.strict=false只在preflight诊断接口有效，不能降级此执行接口。
 *
 * ⚠ Session transcript 与 Chat 是两个库：本函数只负责 transcript 的物理截断与内存重建，
 *   **不构成跨库原子事务**（调用方 round-history 先在 Chat 提交、再调本函数）。失败边界见其注释。
 *
 * @param persistence - sessionPersistence 服务（要求实现 truncateEvents；有 drainOpenHandles 则截断前排空）
 * @param session - DSH 会话对象（读事件流定位边界；内存就地重建）
 * @param chats - 聊天存储接口（readSlice 取索引字段 / update 写回；仅用于 strict 预检接线）
 * @param chatId - 聊天 id
 * @param hiddenTurn - **要删掉的那一轮**（保留 turn < hiddenTurn；与变量库 deleteFrom / 剧情 turn.rollback 同语义）
 * @param services - { projections, projectionCache, agentProvider, tokenMeterProvider, rollbackSyncProvider }
 * @param options - { strict?, preflight?, head? }
 */
export async function cleanupAfterRollback(persistence, session, chats, chatId, hiddenTurn, services, options = {}) {
  if (persistence === undefined || typeof persistence.truncateEvents !== 'function') {
    throw new Error('回退清理：缺少 sessionPersistence 服务（truncateEvents 不可用）')
  }
  const sessionId = String(session?.header?.id ?? '')
  if (sessionId === '') throw new Error('回退清理：会话缺少 header.id')
  // ---------- strict 路径：先预检（可复用正文 update 之前的结果），再 drain、截断、重建 ----------
  const plan = options.preflight ?? preflightRollback(session, hiddenTurn, {
    strict: true, persistence, services, head: options.head ?? chats,
  })
  // 预检发生在正文 update 之前；这里在真正动库之前**再核一次边界没有漂移**（事件流被并发改动即拒绝）。
  const fresh = preflightRollback(session, hiddenTurn, { strict: true, persistence, services, head: options.head ?? chats })
  if (fresh.boundarySeq !== plan.boundarySeq || fresh.keep !== plan.keep
    || (plan.observedLength !== undefined && session.log.length !== plan.observedLength)) {
    throw new Error('回退清理（strict）：预检后事件流或边界发生变化，拒绝使用旧计划截断')
  }
  return await performStrictCut(persistence, session, plan, services, options, '回退清理（strict）')
}

/**
 * **后台参与者（seq 轴）**清理：边界 = `participant.rewindTo`（该后台会话自己的 seq；`-1` = 新建）。
 * 新 API，**只有 strict 一条路径**（没有 legacy 调用方，不做 warn-and-skip）。
 * `noop:true`（整个落在边界内）⇒ 明确返回 `truncated:false/noop:true`，调用方不得报成已物理回退。
 *
 * ⚠ 与前台一样：本函数只动该后台会话的 transcript（drain → 单事务截断 → 内存/投影重建），
 *   与 Chat/剧情时间线**不构成跨库原子事务**；完整编排预检必要辅助层并在最终SQL收尾后发同连接通知。
 *
 * @param persistence - sessionPersistence 服务
 * @param session - **后台会话**对象（活句柄；未加载时由调用方先 resume）
 * @param boundarySeq - 该会话自己的 seq 边界；`-1` = 保留第一个 turn/start 之前的初始事件
 * @param services - { projections, projectionCache, agentProvider（必须解析**该后台会话**的 agent）, ... }
 * @param options - { preflight?, head? }
 */
export async function cleanupAfterRollbackAtSeq(persistence, session, boundarySeq, services, options = {}) {
  if (persistence === undefined || typeof persistence.truncateEvents !== 'function') {
    throw new Error('回退清理（seq）：缺少 sessionPersistence 服务（truncateEvents 不可用）')
  }
  const sessionId = String(session?.header?.id ?? '')
  if (sessionId === '') throw new Error('回退清理（seq）：会话缺少 header.id')
  const plan = options.preflight ?? preflightRollbackAtSeq(session, boundarySeq, {
    strict: true, persistence, services, head: options.head,
  })
  const fresh = preflightRollbackAtSeq(session, boundarySeq, { strict: true, persistence, services, head: options.head })
  if (fresh.boundarySeq !== plan.boundarySeq || fresh.keep !== plan.keep
    || fresh.noop !== plan.noop || (plan.observedLength !== undefined && session.log.length !== plan.observedLength)) {
    throw new Error('回退清理（seq）：预检后事件流或边界发生变化，拒绝使用旧计划截断')
  }
  return await performStrictCut(persistence, session, plan, services, options, '回退清理（seq）')
}
