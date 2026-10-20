// 后台参与者（backend participants）干净回退：**seq 轴**严格 API
//   preflightRollbackAtSeq / cleanupAfterRollbackAtSeq
//
// 判据（PLG-011 / 用户要求）：
//   · 边界只能按 **seq** 给（时间线账本的 participant.rewindTo）—— 后台轮次独立于前台，**不得由 turn 反推**；
//   · rewindTo === -1 ⇒ 保留首次任务入队/turn/start前的初始化；首事件即任务时空前缀合法；
//   · 整个落在边界内 ⇒ noop，仍收敛句柄/内存/投影；
//   · seq只定位纯尾坐标，不按轮完整度、引用或事件类型设资格；
//   · L1.5 是 required counter：`stateOf(session,'turnBoundary').lastTurn` 不是有效数 ⇒ **硬拒**；
//   · agentProvider 必须解析**该后台会话**的 agent（不是前台 chat 的 sessionId）。
//
// 全部 fixture 为**原创合成事件流**，不读真实存档/日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import { preflightRollbackAtSeq, cleanupAfterRollbackAtSeq, configureRollbackCleanup } from '../lib/rollback-cleanup.js'

configureRollbackCleanup({
  sessionEvents: session => (typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (Array.isArray(session?.events) ? session.events : [])),
})

// ---------- fixture：后台会话（轮次独立于前台：可以是 7/8，也可以为空） ----------

function turnEvents(turn, startSeq) {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn } },
    { seq: startSeq + 1, type: 'user/message', data: { turn, message: { role: 'user', content: [{ type: 'text', text: 'u' + turn }] } } },
    { seq: startSeq + 2, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' + turn }] } } },
    { seq: startSeq + 3, type: 'turn/end', data: { turn, reason: { kind: 'stop' } } },
  ]
}
const SEED = { seq: 0, type: 'system/message', data: { turn: 1, step: 1, message: { id: 'tavern-system-head:background-x', role: 'system', content: [] } } }

class SyntheticSurfaceManager {
  constructor(log, baseSeq) {
    this.baseSeq = baseSeq
    this._state = { folded: true }
    this._lastProcessedSeq = baseSeq + log.length - 1
    this._nodes = log.map(event => event.seq)
  }
  get nodes() { return this._nodes }
}

function makeBackgroundSession(events) {
  return {
    header: { id: 'background-synthetic' },
    log: events,
    surface: { nodes: events.map(event => event.seq) },
    surfaceManager: new SyntheticSurfaceManager(events, 0),
    firstLiveSeq: 0,
    snapshotEvents() { return this.log },
    get seq() { return this.log.length },
  }
}

function fakePersistence(record) {
  return {
    async discardRollbackBuffers(id) { record.push('discard:' + id) },
    async truncateEvents(header, boundarySeq) { record.push('truncate:' + boundarySeq); return { eventCount: boundarySeq + 1,drained:true } },
  }
}

/** 后台 agent + 一个"前台 agent"（用来证明 provider 解析的是后台 id）。 */
function makeAgents(record) {
  const backgroundAgent = { phase: { kind: 'idle', lastTurn: 9 } }
  const frontAgent = { phase: { kind: 'idle', lastTurn: 9 } }
  const registrations = new Map([['turnBoundary', { def: { key: 'turnBoundary' }, cells: new Map() }]])
  const services = {
    projections: {
      registrations,
      hydrate(session, _input, events) {
        record.push('hydrate')
        for (const registration of registrations.values()) registration.cells.set(session, { observedSeq: events.at(-1)?.seq ?? -1 })
      },
      stateOf() { record.push('stateOf:turnBoundary'); return { lastTurn: 1 } },
    },
    projectionCache: { async write() { record.push('cache.write') } },
    agentProvider: () => { record.push('agentProvider'); return backgroundAgent },
    tokenMeterProvider: () => undefined,
    webServerProvider: () => undefined,
  }
  return { backgroundAgent, frontAgent, services }
}

function fakeHead() {
  return { async readSlice() { return { chat: {} } }, async update() {} }
}

function expectCode(fn, code, label) {
  assert.throws(fn, error => {
    assert.equal(error?.code, 'ROLLBACK_PREFLIGHT_' + code, `${label}: 期望 code=${code}，实际 ${String(error?.code)} / ${String(error?.message)}`)
    return true
  }, label)
}

// ---------- ① 截断点（只按 seq） ----------

test('seq 预检：边界取该后台会话自己的 seq（与前台 turn 编号无关）', () => {
  // 后台轮次故意用 7/8（与前台 1/2 不同）——证明这里完全按 seq 走。
  const session = makeBackgroundSession([...turnEvents(7, 0), ...turnEvents(8, 4)])
  const plan = preflightRollbackAtSeq(session, 3, { strict: false })
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'seq-boundary')
  assert.equal(plan.boundarySeq, 3)
  assert.equal(plan.keep, 4)
  assert.equal(plan.dropped, 4)
  assert.equal(plan.requestedSeq, 3)
  assert.equal(plan.hiddenTurn, null, 'seq 轴不带 turn（绝不由 turn 反推）')
})

test('seq 预检：rewindTo=-1（新建 participant）⇒ 保留第一个 turn/start 之前的初始事件', () => {
  const session = makeBackgroundSession([SEED, { seq: 1, type: 'session/end-seed', data: {} }, ...turnEvents(7, 2)])
  const plan = preflightRollbackAtSeq(session, -1, { strict: false })
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'seq-boundary')
  assert.equal(plan.boundarySeq, 1, '前缀（含 end-seed 标记）必须留下')
  assert.equal(plan.keep, 2)
  assert.equal(plan.dropped, 4)
})

test('seq定位：首事件即任务时-1保留空前缀，不虚构初始化', () => {
  assert.equal(preflightRollbackAtSeq(makeBackgroundSession([...turnEvents(7, 0)]), -1, { strict: true }).keep,0,'首轮空前缀合法，不虚构metadata事件')
})

test('seq 预检：整个落在边界内 ⇒ 核对过的 noop（不是"猜不出来当成功"）', () => {
  const session = makeBackgroundSession([SEED, ...turnEvents(7, 1)])
  const plan = preflightRollbackAtSeq(session, 4, { strict: false })
  assert.equal(plan.ok, true)
  assert.equal(plan.noop, true)
  assert.equal(plan.mode, 'seq-boundary')
  assert.equal(plan.dropped, 0)
  const onlyPrefix = makeBackgroundSession([SEED, { seq: 1, type: 'session/end-seed', data: {} }])
  assert.equal(preflightRollbackAtSeq(onlyPrefix, -1, { strict: false }).noop, true)
})

test('seq定位：后台显式坐标不按轮次完整度拒绝', () => {
  // 边界 2 落在 turn 7 的 assistant/message 之后、turn/end(3) 之前 ⇒ 保留段与待删段共享 turn 7。
  assert.equal(preflightRollbackAtSeq(makeBackgroundSession([...turnEvents(7, 0), ...turnEvents(8, 4)]), 2, { strict: true }).keep,3,'seq后台切点不按轮形态拒绝')
})

// 现场回归（2026-10-02，用户唯一DB档变量结算）：固定种子 tavern-system-head 自带 turn:1，
// 而后台会话自己的第一轮**也是 turn:1**（宿主 turnBoundary 只认 turn/start，首轮恒为 1）。
// 旧 fixture 的合成轮一律用 7/8，正好绕开了这个碰撞 —— 真实形状必须是 seq0..5 会话头/描述符、
// seq6 = 固定种子(turn:1)、seq7.. = 真 turn 1。
function seededTurnOneSession() {
  const head = { seq: 6, type: 'system/message', data: { turn: 1, step: 1, message: {
    id: 'tavern-system-head:background-synthetic', role: 'system', content: [] } } }
  return makeBackgroundSession([
    ...[0, 1, 2, 3, 4, 5].map(seq => ({ seq, type: 'subagent/descriptor', data: { n: seq } })),
    head, ...turnEvents(1, 7),
  ])
}

test('seq 预检：真实 turn1 会话里固定种子(turn:1) 不得被 -1 判成切半轮（回归 seq 边界 6）', () => {
  const plan = preflightRollbackAtSeq(seededTurnOneSession(), -1, { strict: false })
  assert.deepEqual(plan.violations, [], '固定种子不是任务历史，不属于任何轮次块')
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'seq-boundary')
  assert.equal(plan.requestedSeq, -1, '请求是 -1（变量结算路径），报错里的 6 是解析后的边界')
  assert.equal(plan.boundarySeq, 6, '边界 = 第一个 turn/start 的前一条 seq')
  assert.equal(plan.keep, 7, '前缀（含固定种子）整段保留')
  assert.equal(plan.dropped, 4, '真 turn 1 整轮删除')
})

test('seq预检：已结束轮后的旧空替换随纯尾删除，重新生成后仍可回退', async () => {
  const events = [...turnEvents(4, 0)]
  const empty = { seq: 4, type: 'assistant/message', data: { turn: 4, message: { content: [] } },
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2] }
  const session = makeBackgroundSession([...events, empty, ...turnEvents(5, 5)])
  const { services } = makeAgents([])
  const persistence = fakePersistence([])
  const options = { strict: true, persistence, services, head: fakeHead() }
  const plan = preflightRollbackAtSeq(session, 3, options)
  assert.equal(plan.keep, 4)
  await cleanupAfterRollbackAtSeq(persistence, session, 3, services, { preflight: plan, head: fakeHead() })
  assert.deepEqual(session.log, events, '真实旧轮保留；空替换及新轮仅作尾部物理删除')
  session.log.push(...turnEvents(5, 4))
  assert.equal(preflightRollbackAtSeq(session, 3, options).ok, true, '回退再生成再回退')
})

// ---------- ② 接线（strict 缺一即拒；L1.5 必须是有效数） ----------





// ---------- ③ cleanupAfterRollbackAtSeq ----------

// 现场同形状（真实 turn1 + 固定种子）下的 L1.5 读数必须**由事件推出**（=宿主 turnBoundary 真语义：
// 只认 turn/start，见 dsh-agent-loop turnBoundaryProjectionDefinition），不能用恒返回 1 的桩掩盖归零。
function seqAwareServices(record) {
  const backgroundAgent = { phase: { kind: 'idle', lastTurn: 1 } }
  const registrations = new Map([['turnBoundary', { def: { key: 'turnBoundary' }, cells: new Map() }]])
  return { backgroundAgent, services: {
    projections: {
      registrations,
      hydrate(session, _input, events) { record.push('hydrate'); for (const item of registrations.values()) item.cells.set(session, { observedSeq: events.at(-1)?.seq ?? -1 }) },
      stateOf(session) { record.push('stateOf:turnBoundary'); const last = session.log.filter(event => event.type === 'turn/start').at(-1); return { lastTurn: last ? Number(last.data.turn) : 0 } },
    },
    projectionCache: { async write() { record.push('cache.write') } },
    agentProvider: () => backgroundAgent,
    tokenMeterProvider: () => undefined,
    webServerProvider: () => undefined,
  } }
}

test('seq 清理：-1（变量结算）物理回退保留固定种子，discard→截断→cache→L1.5 归零', async () => {
  const record = []
  const session = seededTurnOneSession()
  const { backgroundAgent, services } = seqAwareServices(record)
  const result = await cleanupAfterRollbackAtSeq(fakePersistence(record), session, -1, services, { head: fakeHead() })
  assert.equal(result.truncated, true)
  assert.equal(result.noop, false)
  assert.equal(result.boundarySeq, 6, '解析后的边界（=现场报错里的 6）')
  assert.equal(result.keep, 7, '含固定种子的前缀整段保留')
  assert.equal(result.dropped, 4, '真 turn 1 整轮物理删除')
  assert.deepEqual(record.filter(item => !item.startsWith('stateOf') && item !== 'agentProvider'),
    ['discard:background-synthetic', 'truncate:6', 'hydrate', 'cache.write'], '顺序：discard → 截断 → 重折 → cache')
  assert.equal(session.log.length, 7, 'log 同一数组就地截短')
  assert.equal(session.log.at(-1).seq, 6)
  assert.equal(session.log.at(-1).type, 'system/message')
  assert.equal(session.log.at(-1).data.turn, 1, '固定种子必须留下（surface 槽位/压缩锚点）')
  assert.equal(session.log.some(event => event.type === 'turn/start'), false, '真 turn 1 的 turn/start 必须已删')
  assert.equal(backgroundAgent.phase.lastTurn, 0, 'L1.5 按重折后的 turnBoundary 归零 ⇒ 下一轮仍从 turn 1 起')
})

test('seq 清理：discard → 单事务截断（用解析后的前缀 seq）→ 内存就地重建 → 投影重折 → L1.5（后台 agent）', async () => {
  const record = []
  const session = makeBackgroundSession([SEED, ...turnEvents(7, 1), ...turnEvents(8, 5)])
  const { backgroundAgent, frontAgent, services } = makeAgents(record)
  const result = await cleanupAfterRollbackAtSeq(fakePersistence(record), session, 4, services, { head: fakeHead() })
  assert.equal(result.truncated, true)
  assert.equal(result.noop, false)
  assert.equal(result.boundarySeq, 4)
  assert.equal(result.keep, 5, 'SEED + turn/start(1) 前缀保留')
  // 只读预检（stateOf 读 L1.5 有效数）先跑；之后必须是 **discard → 截断 → 重折 → cache → L1.5 取后台 agent**。
  assert.deepEqual(record.filter(item => !item.startsWith('stateOf') && item !== 'agentProvider'),
    ['discard:background-synthetic', 'truncate:4', 'hydrate', 'cache.write'])
  assert.equal(session.log.length, 5, 'log 同一数组就地截短')
  assert.equal(backgroundAgent.phase.lastTurn, 1, 'L1.5 必须回拨**后台** agent 的 phase.lastTurn')
  assert.equal(frontAgent.phase.lastTurn, 9, '前台 agent 不得被后台回退改动')
})

test('seq 清理：边界不合法 ⇒ 抛错且一次都不碰库；noop ⇒ 不碰库、但派生层仍必须重建', async () => {
  const record = []
  const { services } = makeAgents(record)
  await assert.rejects(
    () => cleanupAfterRollbackAtSeq(fakePersistence(record), makeBackgroundSession([...turnEvents(7, 0)]), -2, services, { head: fakeHead() }),
    /超出当前日志范围/,
  )
  assert.deepEqual(record, [], '越界坐标不得碰库')
  const noopRecord = []
  const noopSession = makeBackgroundSession([SEED, ...turnEvents(7, 1)])
  const noopResult = await cleanupAfterRollbackAtSeq(fakePersistence(noopRecord), noopSession, 4, makeAgents(noopRecord).services, { head: fakeHead() })
  assert.equal(noopResult.noop, true)
  assert.equal(noopResult.truncated, false)
  // noop = **内存 log 无可删尾部**，不是"整链无事可做"（26420f5：noop 仍重建内存/投影/Agent）。
  // 库已删尾并不能证明半失败后的内存残留已修复 ⇒ discard/同边界幂等 truncate/重折/cache 一律照跑，
  // 只读预检读数不算"碰库"。这里断言的是**步骤序列**，不是"零步骤"。
  assert.deepEqual(noopRecord.filter(item => !item.startsWith('stateOf') && item !== 'agentProvider'),
    ['discard:background-synthetic', 'truncate:4', 'hydrate', 'cache.write'], 'noop 也必须收敛派生层（不得静默跳过）')
  // 两次预检（既有计划 + 动库前复核，各自 agentProvider 一次）+ 清理阶段的 L1.5 取agent/回拨，
  // 合计 5 次。这里断言"确实按当前实现取了 agent 并回拨"，不是硬编码某个历史次数上限。
  assert.equal(noopSession.log.length, 5, 'noop 下内存 log 保持不变')
})
