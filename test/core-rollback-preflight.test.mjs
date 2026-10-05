// 回退 strict 预检（lib/rollback-cleanup.js · preflightRollback / cleanupAfterRollback strict）
//
// 判据（PLG-011）：
//   · 边界不合法 ⇒ **明确拒绝**，不得 warn-and-skip、不得盲把 -1 当成功；
//   · 只允许**纯尾**截断（seq 轴与数组轴在切点一致、待删段不含更早轮次）；
//   · 保留段的引用链不得指向被删 seq；禁止凭 turn/start 删 metadata（会话头/种子必须留）；
//   · strict 下四层接线缺一即拒（不允许事后 skip），且**在任何破坏性写入之前**抛错；
//   · 不带strict也走硬拒路径，不保留旧warn-and-skip执行兜底。
//
// 全部 fixture 为**原创合成事件流**（seq 连续、与真实库同形），不读真实存档/日志。
import test from 'node:test'
import assert from 'node:assert/strict'
import { preflightRollback, cleanupAfterRollback, configureRollbackCleanup } from '../lib/rollback-cleanup.js'

// DI：生产里由作者树薄垫片注入**作者的** session-events 模块（保持事件工具同一份实现）；
// 测试注入同形替身（与 authors 的 session-events.js 相同：优先 snapshotEvents()）。
configureRollbackCleanup({
  sessionEvents: session => (typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (Array.isArray(session?.events) ? session.events : [])),
})

// ---------- fixture ----------

/** 一轮 = turn/start, user/message, assistant/message, turn/end；seq 连续。 */
function turnEvents(turn, startSeq) {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn } },
    { seq: startSeq + 1, type: 'user/message', data: { turn, message: { role: 'user', content: [{ type: 'text', text: 'u' + turn }] } } },
    { seq: startSeq + 2, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' + turn }] } } },
    { seq: startSeq + 3, type: 'turn/end', data: { turn, reason: { kind: 'stop' } } },
  ]
}

/** 宿主 SurfaceManager 的最小同形替身：就地重折后 `_lastProcessedSeq` 必须落在末尾。 */
class SyntheticSurfaceManager {
  constructor(log, baseSeq) {
    this.baseSeq = baseSeq
    this._state = { folded: true }
    this._lastProcessedSeq = baseSeq + log.length - 1
    this._nodes = log.map(event => event.seq)
  }
  get nodes() { return this._nodes }
}

function makeSession(events, extra = {}) {
  return {
    header: { id: 'synthetic-session' },
    log: events,
    surface: { nodes: events.map(event => event.seq) },
    surfaceManager: new SyntheticSurfaceManager(events, 0),
    firstLiveSeq: 0,
    snapshotEvents() { return this.log },
    get seq() { return this.log.length },
    ...extra,
  }
}

function fakePersistence(record) {
  return {
    async drainOpenHandles(id) { record.push('drain:' + id) },
    async truncateEvents(header, boundarySeq) {
      record.push('truncate:' + boundarySeq)
      return { eventCount: boundarySeq + 1 }
    },
  }
}

function fakeServices(record) {
  const registrations = new Map([['turnBoundary', { def: { key: 'turnBoundary' }, cells: new Map() }]])
  const agent = { phase: { kind: 'idle', lastTurn: 9 } }
  return {
    projections: {
      registrations,
      hydrate(session, _input, events) {
        record.push('hydrate')
        for (const registration of registrations.values()) registration.cells.set(session, { observedSeq: events.at(-1)?.seq ?? -1 })
      },
      stateOf() { record.push('stateOf:turnBoundary'); return { lastTurn: 1 } },
    },
    projectionCache: { async write() { record.push('cache.write') } },
    agentProvider: () => agent,
    tokenMeterProvider: () => undefined,
    webServerProvider: () => undefined,
  }
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

// ---------- ① 纯尾边界 ----------

test('preflight：两轮会话回退第 2 轮 ⇒ 边界 = 第 1 轮 turn/end，保留 4 条、待删 4 条', () => {
  const session = makeSession([...turnEvents(1, 0), ...turnEvents(2, 4)])
  const plan = preflightRollback(session, 2, { strict: false })
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'previous-turn')
  assert.equal(plan.boundarySeq, 3)
  assert.equal(plan.keep, 4)
  assert.equal(plan.dropped, 4)
})

test('preflight：没有更早的 turn/end 且目标轮 turn/start 就是第一条 ⇒ 明确拒绝（不盲返回 -1 当成功）', () => {
  expectCode(() => preflightRollback(makeSession([...turnEvents(1, 0)]), 1, { strict: true }), 'NO_SAFE_BOUNDARY', '第一轮无前缀')
})

test('preflight：第一轮 + 会话头前缀 ⇒ 保留 turn/start 之前的全部初始事件（禁止删 metadata）', () => {
  const session = makeSession([
    { seq: 0, type: 'system/message', data: { turn: 1, step: 1, message: { id: 'tavern-system-head:x', role: 'system', content: [] } } },
    ...turnEvents(1, 1),
  ])
  const plan = preflightRollback(session, 1, { strict: false })
  assert.equal(plan.ok, true)
  assert.equal(plan.mode, 'first-turn')
  assert.equal(plan.boundarySeq, 0, '会话头必须留在库里')
  assert.equal(plan.keep, 1)
  assert.equal(plan.dropped, 4)
})

test('preflight：边界之外没有可截断的事件 ⇒ 拒绝（"无事可做"不是回退成功）', () => {
  const session = makeSession([...turnEvents(1, 0), ...turnEvents(2, 4)])
  expectCode(() => preflightRollback(session, 99, { strict: true }), 'NOTHING_TO_TRUNCATE', 'keep>=log')
})

test('preflight：待删段里混入低 seq 事件 ⇒ 拒绝（seq 轴与数组轴不一致 = 非纯尾）', () => {
  const events = [...turnEvents(1, 0), ...turnEvents(2, 4)]
  events.push({ seq: 0, type: 'session/end-seed', data: {} })
  expectCode(() => preflightRollback(makeSession(events), 2, { strict: true }), 'NOT_PURE_TAIL', '非纯尾')
})

test('preflight：待删段含 turn < hiddenTurn 的事件 ⇒ 拒绝（禁止中间删除）', () => {
  const events = [...turnEvents(1, 0), ...turnEvents(2, 4)]
  events.push({ seq: 8, type: 'user/message', data: { turn: 1, message: { role: 'user', content: [] } } })
  expectCode(() => preflightRollback(makeSession(events), 2, { strict: true }), 'MIDDLE_DELETE', '中间删除')
})

// ---------- ② 引用链 ----------

test('preflight：保留段仍引用被删 seq ⇒ 拒绝（引用链会断）', () => {
  const events = [...turnEvents(1, 0), ...turnEvents(2, 4)]
  events[2] = { ...events[2], surfaceOp: { op: 'replace', startSeq: 4, endSeq: 5 }, sourceEventSeqs: [4] }
  expectCode(() => preflightRollback(makeSession(events), 2, { strict: true }), 'DANGLING_REFERENCE', '悬空引用')
})

test('preflight：保留段内部自洽的引用不报错', () => {
  const events = [...turnEvents(1, 0), ...turnEvents(2, 4)]
  events[2] = { ...events[2], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1] }
  assert.equal(preflightRollback(makeSession(events), 2, { strict: false }).ok, true)
})

// ---------- ③ 四层接线（strict 缺一即拒） ----------

test('preflight：四层接线齐全 ⇒ ok；任一缺失 ⇒ 各自明确拒绝', () => {
  const session = makeSession([...turnEvents(1, 0), ...turnEvents(2, 4)])
  const base = { strict: true, persistence: fakePersistence([]), services: fakeServices([]), head: fakeHead() }
  assert.equal(preflightRollback(session, 2, base).ok, true)
  expectCode(() => preflightRollback(session, 2, { ...base, persistence: {} }), 'NO_PERSISTENCE', '缺 persistence')
  expectCode(() => preflightRollback(session, 2, { ...base, services: { ...base.services, projections: undefined } }), 'NO_PROJECTIONS', '缺 projections')
  expectCode(() => preflightRollback(session, 2, { ...base, services: { ...base.services, projectionCache: undefined } }), 'NO_PROJECTION_CACHE', '缺 projectionCache')
  expectCode(() => preflightRollback(session, 2, { ...base, head: { update: async () => {} } }), 'NO_HEAD_STORE', '缺 readSlice（L4）')
})

test('preflight：strict=false 只收集 violations（诊断用），不抛也不放行', () => {
  const plan = preflightRollback(makeSession([...turnEvents(1, 0)]), 1, { strict: false })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.violations.map(item => item.code), ['NO_SAFE_BOUNDARY'])
})

// ---------- ④ cleanupAfterRollback ----------

test('cleanup strict：先预检、再 drain、再单事务截断、再内存/投影重建（顺序可核）', async () => {
  const record = []
  const session = makeSession([...turnEvents(1, 0), ...turnEvents(2, 4)])
  const result = await cleanupAfterRollback(fakePersistence(record), session, fakeHead(), 'chat-1', 2, fakeServices(record), {
    strict: true, head: fakeHead(),
  })
  assert.equal(result.strict, true)
  assert.equal(result.truncated, true)
  assert.equal(result.drained, true)
  assert.equal(result.keep, 4)
  // 只读预检（stateOf 读 L1.5 有效数）先跑；之后必须是 **drain → 截断 → 重折 → cache → L1.5 取 agent**。
  assert.deepEqual(record.filter(item => !item.startsWith('stateOf')),
    ['drain:synthetic-session', 'truncate:3', 'hydrate', 'cache.write'])
  assert.equal(record.includes('stateOf:turnBoundary'), true, 'strict 预检必须核过 L1.5 的有效数')
  assert.equal(session.log.length, 4, 'log 同一数组就地截短')
})

test('cleanup strict：边界不合法 ⇒ 抛错，且 truncateEvents 一次都没被调用（破坏性写入之前拒绝）', async () => {
  const record = []
  await assert.rejects(
    () => cleanupAfterRollback(fakePersistence(record), makeSession([...turnEvents(1, 0)]), fakeHead(), 'chat-1', 1, fakeServices(record), { strict: true, head: fakeHead() }),
    error => error?.code === 'ROLLBACK_PREFLIGHT_NO_SAFE_BOUNDARY',
  )
  assert.deepEqual(record, [], 'strict 拒绝时不得碰库')
})

test('cleanup 无strict或显式false也硬拒缺边界，旧warn跳过执行路径已退役', async () => {
  const record = []
  await assert.rejects(cleanupAfterRollback(fakePersistence(record), makeSession([...turnEvents(1, 0)]), fakeHead(), 'chat-1', 1, fakeServices(record)), /回退预检/)
  await assert.rejects(cleanupAfterRollback(fakePersistence(record), makeSession([...turnEvents(1, 0), ...turnEvents(2, 4)]), fakeHead(), 'chat-1', 99, fakeServices(record), {strict:false}), /回退预检/)
  assert.deepEqual(record, [], '硬拒时不得碰库')
})
