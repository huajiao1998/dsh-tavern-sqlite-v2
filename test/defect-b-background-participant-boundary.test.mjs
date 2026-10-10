// 缺陷 B 修复验收：beforeParticipants 的 boundary 被清成 null
//
// 现场（2026-10-10 chat-muzd2bvc-go5gnx，两份独立复现：turn 83 / turn 113）：
//   回退报「上一轮后台缺少权威seq边界，拒绝用-1猜删」。
// 取证（用户提供的 Temp\opencode 备份链）：
//   rescue-BACKUP (sha 70F1F715，手工填充前)
//     · 失败操作 operation-mv29obfa-8i5nys turn=113 status=failed
//         beforeParticipants.bg = {sid=background-211bab3f…, boundary=null, syncedRev=null, status=current}
//     · @meta（**现行**）participants.background = {boundary=48, syncedRev=34, status=current}
//     · rollbackSessionCuts['113'][background-211bab3f…] = 34
//   bg2\background-211bab3f-*.db（真实事件流）
//     seq 33  05:39:34 turn/end turn=2  reason=error(429)   ← 上一失败后台轮
//     seq 34  10:45:03 session/end-seed
//     seq 35  10:46:09 agent/inbox/spliced + turn/start turn=3   ← turn 113 的后台产物起点
//     …
//     seq 48  10:47:01 turn/end turn=3  reason=completed
//     @meta.updatedAt(1791629222646) 比失败操作 beforeParticipants.updatedAt(1791610776440) 晚 ~2.35h
//     ⇒ null 是失败**当时**作者写入的合法值，之后作者自己才补上 48。不是被清空、不是插件产物。
//
// 归因：
//   写入方 = 作者 commitParticipant（story-timeline.js:302-312），未被接缝改过（clean-image diff
//            已证该函数无改动）；它在 identityOnly / 未同步时**故意**写
//            {status:'current', boundary:null, syncedRevision:null}（注释 "Never transfer a
//            boundary between sessions"）。= 作者 bug（合法中间态）。
//   判据方 = 本插件 clean-rollback.js 旧 L310 只认 old.boundary，把合法中间态当腐败。
//            = 插件 bug，且与同函数旧 L313 的 `old?.boundary ?? -1` 自相矛盾。
//   两者交互才卡死。
//
// 修复：边界权威取三处来源（recordedCuts / 现行 participant / 基准快照）的安全整数，
//       合并取**较早** ⇒ recordedCuts=34 击败失败后被作者推到 48 的水位，正好删掉该轮后台产物尾。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRollback } from '../lib/clean-rollback.js'
import { captureRollbackBusinessState } from '../lib/rollback-business-state.js'
import { configureRollbackCleanup } from '../lib/rollback-cleanup.js'

configureRollbackCleanup({ sessionEvents: session => session.snapshotEvents() })

const SESSION_ID = 'synth-session'
const BACKGROUND_ID = 'background-synth-211b'

class SyntheticSurfaceManager {
  constructor(log, baseSeq) {
    this.baseSeq = baseSeq
    this.projections = undefined
    this._state = { folded: true }
    this._nodes = log.map(event => event.seq)
    this._lastProcessedSeq = baseSeq + log.length - 1
  }
  get nodes() { return this._nodes }
}

function makeSession(events) {
  return {
    header: { id: events.headerId ?? SESSION_ID },
    log: events,
    surface: { nodes: events.map(event => event.seq) },
    surfaceManager: new SyntheticSurfaceManager(events, 0),
    firstLiveSeq: 0,
    snapshotEvents() { return this.log },
    get seq() { return this.log.length },
  }
}

/** 一轮正常结束。 */
function turnEvents(turn, startSeq, reason = { kind: 'completed' }) {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn } },
    { seq: startSeq + 1, type: 'user/message', data: { turn, message: { role: 'user', content: [{ type: 'text', text: 'u' + turn }] } } },
    { seq: startSeq + 2, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' + turn }] } } },
    { seq: startSeq + 3, type: 'turn/end', data: { turn, reason } },
  ]
}

/**
 * 复刻真实后台事件流（bg2/background-211bab3f-*.db 的形状，turn 号/序号同构）：
 *   0..33  ：旧轮，seq 33 = turn/end turn=2 reason=error
 *   34     ：session/end-seed
 *   35..48 ：turn 3 的完整生命周期（worldbook-filter，turn 113 的后台产物）
 */
function backgroundSession() {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { turn: 1, message: { role: 'user', content: [] } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 3, type: 'turn/start', data: { turn: 2 } },
    { seq: 4, type: 'user/message', data: { turn: 2, message: { role: 'user', content: [] } } },
    { seq: 5, type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '429' } } } },
    ...Array.from({ length: 27 }, (_v, i) => ({ seq: 6 + i, type: 'user/message', data: { turn: 2, message: { role: 'user', content: [] } } })),
    { seq: 33, type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: '429' } } } },
    { seq: 34, type: 'session/end-seed', data: {} },
    { seq: 35, type: 'agent/inbox/spliced', data: { inserted: [{ id: 'edc69244', role: 'user' }] } },
    { seq: 36, type: 'turn/start', data: { turn: 3 } },
    { seq: 37, type: 'agent/inbox/spliced', data: { inserted: [] } },
    { seq: 38, type: 'step/start', data: { turn: 3 } },
    { seq: 39, type: 'system/message', data: { turn: 3, message: { role: 'system', content: [] } } },
    { seq: 40, type: 'user/message', data: { turn: 3, message: { role: 'user', content: [] } } },
    { seq: 41, type: 'user/message', data: { turn: 3, message: { role: 'user', content: [] } } },
    { seq: 42, type: 'request/header', data: { reason: 'resume' } },
    { seq: 43, type: 'request/context', data: {} },
    { seq: 44, type: 'assistant/message', data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a3' }] } } },
    { seq: 45, type: 'tool/call', data: { turn: 3 } },
    { seq: 46, type: 'tool/result', data: { turn: 3 } },
    { seq: 47, type: 'step/end', data: { turn: 3 } },
    { seq: 48, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ]
}

async function harness({ currentBoundary, currentSyncedRevision, sessionCut, baselineBoundary = null }) {
  const foregroundEvents = turnEvents(112, 0)
  const foreground = makeSession(foregroundEvents)
  const background = makeSession(backgroundSession())
  background.header.id = BACKGROUND_ID

  const messages = [
    { role: 'user', text: '输入112' },
    { role: 'assistant', turn: 112, text: 'a112', swipeId: 0, swipes: ['a112'] },
  ]
  const base = {
    id: 'chat-id', sessionId: SESSION_ID, _storageRevision: 1, mode: 'story', messages,
    variables: { hp: 112 },
    timeline: { schemaVersion: 1, branchId: 'branch-old', revision: 33, checkpoints: [], operations: {}, participants: {} },
  }
  const businessBefore = captureRollbackBusinessState(base)
  // 现场快照：作者 commitParticipant 写的"已绑定未同步"中间态。
  businessBefore.participants = { background: { role: 'background', lifetime: 'chat', sessionId: BACKGROUND_ID, branchId: 'branch-old', syncedRevision: null, boundary: baselineBoundary, status: 'current', rewindTo: null, requiresNewSessionOnRewind: true, compactedAt: 1791465192840 } }

  const operations = {
    body113: {
      id: 'body113', kind: 'body', role: 'body', status: 'failed', turn: 113, userText: '输入113',
      basedOn: { branchId: 'branch-old', revision: 34 }, beforeRevision: 520,
      businessBefore, rowBefore: { presentation: {} }, beforeParticipants: businessBefore.participants,
    },
  }
  const current = {
    ...base, _storageRevision: 2,
    // 现场：失败之后作者把现行 participant 推到 boundary=48 / syncedRevision=34
    timeline: {
      ...base.timeline, revision: 34, operations,
      participants: { background: { role: 'background', lifetime: 'chat', sessionId: BACKGROUND_ID, branchId: 'branch-old', syncedRevision: currentSyncedRevision, boundary: currentBoundary, status: 'current', rewindTo: null, requiresNewSessionOnRewind: true, compactedAt: 1791465192840 } },
    },
    // 现场：rollbackSessionCuts['113'][sid]=34（作者 recordRollbackBoundary 的初始 seq）
    rollbackSessionCuts: sessionCut === undefined ? undefined : { '113': { [BACKGROUND_ID]: sessionCut } },
  }

  const chats = new Map([['chat-id', current]])
  const read = async () => structuredClone(chats.get('chat-id'))
  const update = async (id, mutate) => {
    const prev = chats.get(id)
    const next = await mutate(structuredClone(prev))
    next._storageRevision = prev._storageRevision + 1
    chats.set(id, next)
    return next
  }

  const agents = new Map()
  for (const [id, session, lastTurn] of [[SESSION_ID, foreground, 112], [BACKGROUND_ID, background, 3]]) {
    agents.set(id, { session, phase: { kind: 'idle', lastTurn }, inbox: { nextTurn: [], nextStep: [] } })
  }
  const truncated = []
  const persistence = {
    bindRollbackArchive: async () => {},
    setRollbackPending: async () => {},
    drainOpenHandles: async () => {},
    truncateEvents: async (header, boundarySeq) => {
      const session = agents.get(header.id).session
      truncated.push([header.id, boundarySeq])
      if (boundarySeq >= session.log.length) return { eventCount: session.log.length }
      session.log.length = boundarySeq + 1
      session.surfaceManager._nodes = session.log.map(event => event.seq)
      session.surfaceManager._lastProcessedSeq = boundarySeq
      return { eventCount: boundarySeq + 1 }
    },
  }
  const registrations = new Map([['turnBoundary', { def: { key: 'turnBoundary' }, cells: new Map() }]])
  const services = {
    projections: {
      registrations,
      hydrate(sessionRef, _input, events) {
        for (const registration of registrations.values()) registration.cells.set(sessionRef, { observedSeq: events.at(-1)?.seq ?? -1 })
      },
      stateOf: (sessionRef) => (sessionRef.header.id === BACKGROUND_ID ? { lastTurn: 2 } : { lastTurn: 112 }),
    },
    projectionCache: { async write() {} },
    agentProvider: () => agents.get(BACKGROUND_ID),
    tokenMeterProvider: () => ({ states: new Map([['x', {}]]) }),
    rollbackSyncProvider: () => ({ assertReady() {}, publish: () => ({ protocol: 'x', id: 'sync-1', chatId: 'chat-id', revision: 3 }) }),
  }
  const args = {
    chat: await read(),
    requestedTurn: null,
    availability: () => ({ failedTurns: [], canRollback: false, reason: '当前没有可回退的已提交轮次' }),
    readChat: read, updateChat: update,
    chats: { rollbackArchivePath: id => '/tmp/' + id + '.db', readRollbackWorldbook: () => undefined, readSlice: async () => ({ chat: await read() }), update },
    sessions: { get: id => agents.get(id), getSession: id => agents.get(id)?.session, flush: async () => {} },
    persistence, services,
    quiesce: async () => {}, sideCleanup: async () => {},
    view: async chat => ({ turn: chat.messages.at(-1).turn, variables: chat.variables }),
    readCard: async () => ({}),
  }
  return { foreground, background, chats, args, read, truncated, agents, businessBefore }
}

// ---------- ① 现场复现：null 中间态 + 权威值在别处 ----------

test('缺陷B：baseline 停在合法 null 中间态 ⇒ 不再误抛，边界取三来源的较早值 34', async () => {
  const f = await harness({ currentBoundary: 48, currentSyncedRevision: 34, sessionCut: 34 })
  const result = await cleanRollback(f.args)
  assert.equal(result.rolledBack.hiddenTurn, 113)
  // 后台必须截断到 seq 34：删掉 35..48（turn 113 的后台产物），保留 34 及之前的 seed 与旧轮。
  const bgCut = f.truncated.find(([id]) => id === BACKGROUND_ID)
  assert.deepEqual(bgCut, [BACKGROUND_ID, 34], '后台 cut 必须是 34，不是 48')
  assert.equal(f.background.log.length, 35, '保留 seq 0..34，删掉 35..48')
  assert.equal(f.background.log.at(-1).type, 'session/end-seed')
  assert.equal(f.background.log.some(event => Number(event.data?.turn) === 3), false, 'turn 113 的后台产物必须物理删除')
  const after = await f.read()
  assert.equal(after.timeline.operations.body113, undefined, '失败正文操作被清掉')
  assert.equal(after.timeline.participants.background.boundary, 34, '重建后的 participant 记录实际切点')
})

test('缺陷B：只用现行 participant 也能收敛（rollbackSessionCuts 缺该轮时）', async () => {
  const f = await harness({ currentBoundary: 48, currentSyncedRevision: 34, sessionCut: undefined })
  await cleanRollback(f.args)
  assert.deepEqual(f.truncated.find(([id]) => id === BACKGROUND_ID), [BACKGROUND_ID, 48])
  assert.equal(f.background.log.length, 49, '没有会话切点时保留已同步水位（原作者 durable 状态）')
})

test('缺陷B：只用 rollbackSessionCuts 也能收敛（现行 participant 也停在中间态时）', async () => {
  const f = await harness({ currentBoundary: null, currentSyncedRevision: null, sessionCut: 34 })
  await cleanRollback(f.args)
  assert.deepEqual(f.truncated.find(([id]) => id === BACKGROUND_ID), [BACKGROUND_ID, 34])
})

// ---------- ② 回归：原有拒绝一字不减 ----------

test('回归：三者都无权威 seq ⇒ 仍响亮拒绝（不为跨会话搬运 boundary）', async () => {
  const f = await harness({ currentBoundary: null, currentSyncedRevision: null, sessionCut: undefined })
  await assert.rejects(cleanRollback(f.args), /上一轮后台缺少权威seq边界/)
  assert.equal(f.truncated.filter(([id]) => id === BACKGROUND_ID).length, 0, '拒绝时不得碰后台库')
  assert.equal(f.background.log.length, 49, '拒绝时后台事件一条不动')
})

test('回归：新建 participant（基准里没有该会话）⇒ -1 哨兵语义保留', async () => {
  const f = await harness({ currentBoundary: null, currentSyncedRevision: null, sessionCut: undefined, baselineBoundary: undefined })
  // 把基准快照里的 participant 也清掉 ⇒ old 没有 sessionId，走"新建 participant"的 -1 路径。
  f.businessBefore.participants = {}
  await assert.rejects(cleanRollback(f.args), /回退预检|没有安全回退目标/)
  assert.equal(f.truncated.filter(([id]) => id === BACKGROUND_ID).length, 0)
})
