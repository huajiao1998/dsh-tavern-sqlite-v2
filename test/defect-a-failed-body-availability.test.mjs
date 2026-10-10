// 缺陷 A 修复验收：无基准的 failed body 造成守卫与回退互相等待
//
// 现场（2026-10-10 两轮实测，chat-muzd2bvc-go5gnx）：
//   · 回合在**准备期**失败 ⇒ timeline 里有 kind='body'/status='failed' 的操作，零消息、无 checkpoint；
//   · 守卫 assertRollbackBodyPreparation（turn-orchestration.js 的 failed-body-prepare-fence）拒绝准备新回合；
//   · 而可用性判据 rollbackAvailability 只看**会话事件流/表面节点**，event 流里没有该轮痕迹 ⇒
//     failedTurns 空 ⇒ 回退目标落到上一轮成功轮（53 → 52），或抛"缺少可识别的业务回退基准"。
//     守卫等回退、回退不认失败 ⇒ 永久卡死。
//
// 本测试全部 fixture 为**原创合成**（不读用户存档），缝接收紧在 lib/clean-rollback.js 的三个函数：
//   timelineFailedBodyTurns / sessionHasTurn / resolveForegroundCut。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanRollback } from '../lib/clean-rollback.js'
import { captureRollbackBusinessState } from '../lib/rollback-business-state.js'
import { configureRollbackCleanup } from '../lib/rollback-cleanup.js'

configureRollbackCleanup({ sessionEvents: session => session.snapshotEvents() })

// ---------- 合成会话（与 core-rollback-preflight.test.mjs 同形） ----------

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
    header: { id: 'synth-session' },
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

// ---------- harness ----------

const SESSION_ID = 'synth-session'
const FOREGROUND = 'chat-id'

async function harness({ ledgerFailedTurn, eventStreamHasTurn53 }) {
  // 事件流：52 正常结束。ledgerFailedTurn=53 且 eventStreamHasTurn53=false ⇒ 准备期失败
  // （body.begin 已入账、agent 未启动 ⇒ 没有任何带 turn 53 的事件）。
  const events = eventStreamHasTurn53
    ? [...turnEvents(52, 0), ...turnEvents(53, 4, { kind: 'error', error: { message: '准备期失败' } })]
    : turnEvents(52, 0)
  const session = makeSession(events)

  const messages = [
    { role: 'user', text: '输入52' },
    { role: 'assistant', turn: 52, text: 'a52', swipeId: 0, swipes: ['a52'] },
  ]

  const base = {
    id: FOREGROUND, sessionId: SESSION_ID, _storageRevision: 1, mode: 'story', messages,
    variables: { hp: 52 },
    timeline: { schemaVersion: 1, branchId: 'branch-old', revision: 52, checkpoints: [], operations: {}, participants: {} },
  }
  const businessBefore = captureRollbackBusinessState(base)

  const operations = {}
  if (ledgerFailedTurn) {
    operations.body53 = {
      id: 'body53', kind: 'body', role: 'body', status: 'failed', turn: ledgerFailedTurn, userText: '输入53',
      basedOn: { branchId: 'branch-old', revision: 52 }, beforeRevision: 1,
      businessBefore, rowBefore: { presentation: {} }, beforeParticipants: {},
    }
  }
  const current = {
    ...base, _storageRevision: 2,
    timeline: { ...base.timeline, revision: 53, operations },
  }

  const chats = new Map([[FOREGROUND, current]])
  const read = async () => structuredClone(chats.get(FOREGROUND))
  const update = async (id, mutate, meta) => {
    const prev = chats.get(id)
    const next = await mutate(structuredClone(prev))
    next._storageRevision = prev._storageRevision + 1
    chats.set(id, next)
    return next
  }

  const agent = { session, phase: { kind: 'idle', lastTurn: 52 }, inbox: { nextTurn: [], nextStep: [] } }
  const agents = new Map([[SESSION_ID, agent]])
  const truncated = []
  const persistence = {
    bindRollbackArchive: async () => {},
    setRollbackPending: async () => {},
    drainOpenHandles: async () => {},
    truncateEvents: async (header, boundarySeq) => {
      truncated.push(boundarySeq)
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
        for (const registration of registrations.values()) {
          registration.cells.set(sessionRef, { observedSeq: events.at(-1)?.seq ?? -1 })
        }
      },
      stateOf: () => ({ lastTurn: 52 }),
    },
    projectionCache: { async write() {} },
    agentProvider: () => agent,
    tokenMeterProvider: () => ({ states: new Map([['synth-session', {}]]) }),
    rollbackSyncProvider: () => ({ assertReady() {}, publish: () => ({ protocol: 'x', id: 'sync-1', chatId: FOREGROUND, revision: 3 }) }),
  }
  const args = {
    chat: await read(),
    requestedTurn: null,
    // 作者的可用性判据：事件流里 53 没有任何痕迹 ⇒ failedTurns 为空（缺陷 A 的成因）
    availability: () => ({ failedTurns: [], canRollback: false, reason: '当前没有可回退的已提交轮次' }),
    readChat: read, updateChat: update,
    chats: {
      rollbackArchivePath: id => '/tmp/' + id + '.db',
      readRollbackWorldbook: () => undefined,
      readSlice: async () => ({ chat: await read() }),
      update,
    },
    sessions: { get: id => (id === SESSION_ID ? agent : undefined), getSession: id => agents.get(id)?.session, flush: async () => {} },
    persistence, services,
    quiesce: async () => {}, sideCleanup: async () => {},
    view: async chat => ({ turn: chat.messages.at(-1).turn, variables: chat.variables }),
    readCard: async () => ({}),
  }
  return { session, chats, args, read, patch: mutate => mutate(chats.get(FOREGROUND)), truncated, base }
}

// ---------- ① 复现缺陷 A：修复前守卫与回退互相等待 ----------

test('缺陷A：账本 failed body + 事件流无该轮痕迹 ⇒ 回退目标取失败轮而非上一轮成功轮', async () => {
  const f = await harness({ ledgerFailedTurn: 53, eventStreamHasTurn53: false })
  const result = await cleanRollback(f.args)
  assert.equal(result.rolledBack.hiddenTurn, 53, '必须回退到 failed body 所在轮，不能落到 52')
  const after = await f.read()
  assert.equal(after.rollbackPending, undefined, '回退必须完成（不残留完成意图）')
  assert.equal(after.timeline.operations.body53, undefined, '失败正文操作必须被清掉，守卫才能放行新回合')
  assert.equal(after.messages.length, 2, '按 businessBefore.messageCount 保留发轮前的正文前缀')
  assert.equal(after.timeline.revision, 54, '回退按新分支推进 revision')
  assert.deepEqual(after.variables, { hp: 52 }, '变量回到上一轮业务基准')
  assert.deepEqual(f.truncated, [3], '原生流没有该轮痕迹 ⇒ seq 轴核对过的 noop（截断到上一轮 turn/end）')
})

test('缺陷A：回退成功后同一条守卫判据不再命中（新回合可以准备）', async () => {
  const f = await harness({ ledgerFailedTurn: 53, eventStreamHasTurn53: false })
  await cleanRollback(f.args)
  const after = await f.read()
  const failedBody = Object.values(after.timeline.operations || {})
    .some(op => op?.kind === 'body' && op?.status === 'failed'
      && (!op.basedOn?.branchId || op.basedOn.branchId === after.timeline.branchId))
  assert.equal(failedBody, false, '守卫判据（kind=body && failed && 同分支）必须不再命中')
})

test('缺陷A：失败轮在事件流里有痕迹（普通失败轮）⇒ 仍走轮次轴，真截断而不放行', async () => {
  const f = await harness({ ledgerFailedTurn: 53, eventStreamHasTurn53: true })
  const result = await cleanRollback(f.args)
  assert.equal(result.rolledBack.hiddenTurn, 53)
  assert.deepEqual(f.truncated, [3], '有 turn/start 就走轮次轴，边界仍是上一轮 turn/end')
  assert.equal(f.session.log.length, 4, '53 的 4 条事件被物理截断')
})

// ---------- ② 回归：不放宽任何原有拒绝 ----------

const REFUSALS = /当前没有可回退|没有安全回退目标|回退预检/

test('回归：没有账本失败证据时可用性路径仍响亮拒绝（不把"无事可做"当成功）', async () => {
  const f = await harness({ ledgerFailedTurn: null, eventStreamHasTurn53: false })
  f.args.availability = () => ({ failedTurns: [], canRollback: false, reason: '当前没有可回退的已提交轮次' })
  f.args.requestedTurn = 53
  await assert.rejects(cleanRollback(f.args), REFUSALS)
  assert.deepEqual(f.truncated, [], '拒绝时不得碰库')
})

test('回归：账本失败轮连上一轮 turn/end 都没有 ⇒ 仍走轮次轴拒绝（不凭 turn/start 删会话头）', async () => {
  const f = await harness({ ledgerFailedTurn: 53, eventStreamHasTurn53: false })
  // 只留一条会话头/种子，抹掉 52 的 turn/end ⇒ rollbackBoundarySeq 返回 -1。
  f.session.log.length = 0
  f.session.log.push({ seq: 0, type: 'session/end-seed', data: {} })
  f.session.surfaceManager._nodes = [0]
  f.session.surfaceManager._lastProcessedSeq = 0
  f.args.availability = () => ({ failedTurns: [], canRollback: false, reason: 'x' })
  await assert.rejects(cleanRollback(f.args), REFUSALS)
  assert.deepEqual(f.truncated, [], '拒绝时不得碰库')
})

test('回归：basedOn.branchId 指向其它分支的失败 body 不并进 failedTurns（与守卫同判据）', async () => {
  const f = await harness({ ledgerFailedTurn: 53, eventStreamHasTurn53: false })
  // cleanRollback 会重新 readChat ⇒ 必须改**库里的**那份，不是 args.chat 的副本。
  f.patch(chat => { chat.timeline.operations.body53.basedOn = { branchId: 'branch-other', revision: 52 } })
  await assert.rejects(cleanRollback(f.args), REFUSALS)
  assert.deepEqual(f.truncated, [], '拒绝时不得碰库')
})
