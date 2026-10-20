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
// 物理删尾与内存/投影重建由本包拥有；切点定位不再承担对象资格判断。
import { rewindRuntimeTurnCounter, rewindRuntimeAgentState, cleanupTokenMeterState } from '../rollback-layers.js'
import { isDeepStrictEqual } from 'node:util'
import { isRetainedBodyEdit } from './failure-cleanup-target.js'

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
  session.inheritedEventCount = Math.min(session.inheritedEventCount ?? 0, keep)
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

// 切点只决定删尾范围；不检查对象形态、引用完整性或已完成状态。
function cutPlan(session,boundarySeq,mode) {
 const log=session.log
 // 唯一范围检查：不能把未知切点当成空库或越过实际日志。
 if(!Number.isSafeInteger(boundarySeq) || boundarySeq< -1 || boundarySeq>=log.length)throw Error('清理切点超出当前日志范围')
 const keep=boundarySeq+1
 return {ok:true,violations:[],sessionId:session.header.id,boundarySeq,keep,dropped:log.length-keep,noop:keep===log.length,mode,observedLength:log.length}
}
export function preflightRollback(session,hiddenTurn,options={}) {
 const events=sessionEvents(session)
 const start=events.find(event=>event.type==='turn/start' && Number(event.data?.turn)===Number(hiddenTurn))
 const first=events.find(event=>Number(event?.data?.turn)===Number(hiddenTurn))
 const boundary=start?start.seq-1:first?first.seq-1:(events.at(-1)?.seq ?? -1)
 return {...cutPlan(session,boundary,'latest-turn'),hiddenTurn:Number(hiddenTurn),requestedSeq:null}
}
export function preflightRollbackAtSeq(session,boundarySeq,options={}) {
 let boundary=Number(boundarySeq)
 if(boundary===-1 && !options.foregroundExact) {
  // 后台没有历史切点时，沿用作者同Session原地清空任务历史的语义，保留初始化前缀。
  const log=session.log
  const start=log.findIndex(event=>event.type==='turn/start' || (event.type==='agent/inbox/spliced' && event.data?.inserted?.length))
  boundary=start<0?log.length-1:start-1
 }
 return {...cutPlan(session,boundary,'seq-boundary'),hiddenTurn:null,requestedSeq:boundarySeq}
}

// ---------------------------------------------------------------------------
// 清理（不可逆点之后）：drain → 单事务截断 → 内存就地重建 → 派生视图重折
// ---------------------------------------------------------------------------

/** 实际删尾、重建及回执核对；旧preflight导出仅负责计算切点。 */
async function performStrictCut(persistence, session, plan, services, options, label) {
  const sessionId = String(session?.header?.id ?? '')
  // noop只表示内存log无可删尾部；数据库、句柄和派生缓存仍必须核对并重建。
  // 同边界truncate为幂等SQL操作，也能修复『SQL已删、内存尚未重建』的重试。
  // 已受理写缓冲由truncateEvents在真正SQL截断前统一排空。
  // 是否实际排空由截断消费者回执证明，不能以方法存在推断执行。
  // ---------- L1：库截断 + 句柄回卷 + 内存就地重建 + 派生视图重折 ----------
  // 仅恢复该child自己唯一的真实身份元数据；不保留被删业务事件、不填充游标。
  // 已受损档经显式修复把descriptor追加在尾部时，后续回退仍须保有同一身份。
  const descriptors = session.header?.origin === 'subagent'
    ? session.log.filter(event => event?.type === 'subagent/descriptor' && event.seq >= (session.inheritedEventCount ?? 0)) : []
  const identity = descriptors.length === 1 && descriptors[0].seq >= plan.keep ? descriptors[0] : undefined
  // 专用truncate原子保存既有身份；不Session.append、不走普通路由，也不临时关闭写入屏障。
  const retained=options.retainedBodyEdits
    ? session.log.slice(plan.keep).filter(e=>isRetainedBodyEdit(e,session.log,plan.boundarySeq,options.retainedBodyEdits.chat,options.retainedBodyEdits.turn)) : []
  const retainedEvents=retained.length?session.log.slice(plan.keep).filter(e=>retained.includes(e)
    || (e.type==='dsh-tavern/required-session-patch-v1' && e.data?.version===1 && retained.some(edit=>edit.seq===e.seq+1))):[]
  const meta = await persistence.truncateEvents(session.header, plan.boundarySeq, identity,retainedEvents.length?retainedEvents:undefined)
  const keep = plan.keep + (identity === undefined ? 0 : 1) + retainedEvents.length
  if(retainedEvents.length && (!Array.isArray(meta?.retainedEvents) || !isDeepStrictEqual(meta.retainedEvents,retainedEvents.map((e,i)=>({...e,seq:plan.keep+i})))))throw new Error('旧轮编辑保留回执不一致，拒绝报告清理完成')
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
  if(retainedEvents.length) {
    for(const event of meta.retainedEvents)session.log.push(structuredClone(event))
    rewindSessionMemory(session,keep)
  }
  const nodes = session.surfaceManager.nodes.length
  rebuildSessionProjections(services?.projections, session)
  await services.projectionCache.write(session)
  const turnRewound = rewindRuntimeTurnCounter(session, services)
  const expectedTurn = Number(services.projections.stateOf(session, 'turnBoundary')?.lastTurn)
  const agent = services.agentProvider?.()
  if (!Number.isSafeInteger(expectedTurn) || expectedTurn < 0) throw new Error('回退清理：重折轮次不是非负安全整数')
  if (agent?.phase && (agent.phase.kind === 'running' || agent.phase.lastTurn !== expectedTurn)) {
    throw new Error('回退清理：Agent轮次未恢复到保留日志，拒绝报告成功')
  }
  rewindRuntimeAgentState(session, services)
  const tokenMeterCleared = cleanupTokenMeterState(session, services)
  return Object.freeze({ ok: true, strict: true, noop: plan.noop === true, truncated: plan.noop !== true, mode: plan.mode,
    boundarySeq: plan.boundarySeq, keep: plan.keep, dropped: plan.dropped, drained:meta?.drained===true, nodes,
    turnRewound, tokenMeterCleared, skipped: Object.freeze([]) })
}

/**
 * 回退后的统一清理（由 round-history 在正文提交后、**不可逆点**调用）。
 *
 * 单一路径：定位切点 → 排空句柄 → SQL纯尾截断 → 就地重建。
 * 不认证原生对象形态或完整度，实际SQL/重建失败直接报错。
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
export async function cleanupAfterRollback(persistence,session,chats,chatId,hiddenTurn,services,options={}) {
 const plan=preflightRollback(session,hiddenTurn,options)
 return performStrictCut(persistence,session,plan,services,options,'回退清理')
}

/** 直接按本次真实切点物理删尾；不重复认证原生对象完整度。 */
export async function cleanupAfterRollbackAtSeq(persistence,session,boundarySeq,services,options={}) {
 const plan=preflightRollbackAtSeq(session,boundarySeq,options)
 return performStrictCut(persistence,session,plan,services,options,'回退清理')
}
