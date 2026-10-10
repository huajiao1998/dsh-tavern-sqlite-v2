// 缺陷 A 的**结构性**验收：失败判据单一出处。
//
// 缺陷 A 的成因不是任何一处算错，而是同一批事实被三处各自重算，没有单一出处让它们必然一致：
//   ① 守卫 assertRollbackBodyPreparation（作者 turn-orchestration.js 的 fence 缝）——只看账本；
//   ② 作者的 rollbackAvailability（rollback-surface.js）——只看表面；
//   ③ inspectNativeFailureTail / 回退编排——各写各的。
// 本测试把这三处的共同输入固定成一份账本，断言它们从同一模块取到同一结论。
//
// 准备期失败的回合是分水岭：body.begin 已入账（账本知道），agent 尚未启动（表面完全不知道）。
// 那一轮上①说"有要清的失败"、②说"什么都没发生"，回退编排若只听②就会把目标落到上一轮成功轮。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ledgerFailureState, surfaceFailureState, mergeFailureState, sessionTailState, readFailureState,
} from '../lib/failure-state.js'
import { inspectNativeFailureTail, FAILED_BODY_PREPARATION_ERROR } from '../lib/failure-cleanup-target.js'

/** 账本：turn 112 完成，turn 113 body 已入账但失败（准备期失败 ⇒ 原生事件流里没有 113）。 */
function chatWithFailedPreparation({ withBranchId = true, branchId = 'branch-old' } = {}) {
  return {
    id: 'chat-id', sessionId: 'session-1', _storageRevision: 2,
    messages: [{ role: 'user', text: 'u112' }, { role: 'assistant', turn: 112, text: 'a112' }],
    timeline: {
      schemaVersion: 1, branchId, revision: 34, checkpoints: [], participants: {},
      operations: {
        body112: { id: 'body112', kind: 'body', role: 'body', status: 'completed', turn: 112, basedOn: { branchId, revision: 33 } },
        body113: {
          id: 'body113', kind: 'body', role: 'body', status: 'failed', turn: 113, userText: 'u113',
          basedOn: { branchId, revision: 34 }, beforeRevision: 520,
          businessBefore: { version: 1, messageCount: 2, participants: {} }, rowBefore: { presentation: {} },
        },
      },
    },
  }
}

/** 原生事件流：只到 turn 112 结束，没有任何带 turn 113 的事件（准备期失败）。 */
const eventsUpTo112 = [
  { seq: 0, type: 'turn/start', data: { turn: 111 } },
  { seq: 1, type: 'turn/end', data: { turn: 111, reason: { kind: 'completed' } } },
  { seq: 2, type: 'turn/start', data: { turn: 112 } },
  { seq: 3, type: 'user/message', data: { turn: 112, message: { role: 'user', content: [] } } },
  { seq: 4, type: 'assistant/message', data: { turn: 112, step: 1, message: { role: 'assistant', content: [] } } },
  { seq: 5, type: 'turn/end', data: { turn: 112, reason: { kind: 'completed' } } },
]

// ---------- ① 单一出处：同一份账本 → 三处同一结论 ----------

test('单一出处：守卫判据与编排判据对同一份账本给出同一批失败轮', () => {
  const chat = chatWithFailedPreparation()
  const ledger = ledgerFailureState(chat)
  // 守卫 fence 读的就是这一位
  assert.deepEqual([...ledger.pendingCleanupTurns], [113], '守卫看到 turn 113 有未清理的失败正文')
  // 回退编排读的 failedTurns 必须 superset（合并策略的唯一出处在 mergeFailureState）
  const merged = mergeFailureState(ledger, surfaceFailureState({ failedTurns: [], canRollback: false, reason: '当前没有可回退的已提交轮次' }))
  assert.deepEqual([...merged.failedTurns], [113], '编排必须看到同一轮；不能只听表面而落到 112')
  assert.ok(merged.failedTurns.includes(113))
})

test('单一出处：表面判据缺席不能否定账本事实（缺陷 A 的核心）', () => {
  const chat = chatWithFailedPreparation()
  const surface = surfaceFailureState({ failedTurns: [], canRollback: false, reason: '当前没有可回退的已提交轮次' })
  assert.deepEqual([...surface.surfaceFailed], [], '作者的表面判据确实什么都不知道')
  const merged = mergeFailureState(ledgerFailureState(chat), surface)
  assert.equal(merged.canRollback, true, 'canRollback 是派生判据，不是资格判据')
  assert.equal(merged.reason, '', '资格判据满足时必须清空表面的拒绝理由，否则回退被 reason 挡掉')
})

test('单一出处：两种判据都在时并集去重，不互相覆盖', () => {
  const chat = chatWithFailedPreparation()
  const merged = mergeFailureState(
    ledgerFailureState(chat),
    surfaceFailureState({ failedTurns: [113, 111], canRollback: true, reason: '' }),
  )
  assert.deepEqual([...merged.failedTurns], [111, 113], '并集')
  assert.deepEqual([...merged.ledgerFailed], [113], '账本一路单独可查')
  assert.deepEqual([...merged.surfaceFailed], [111, 113], '表面一路单独可查')
})

test('单一出处：跨分支的失败 body 不计入当前分支（与守卫同判据）', () => {
  const chat = chatWithFailedPreparation()
  chat.timeline.branchId = 'branch-new'
  const ledger = ledgerFailureState(chat)
  assert.deepEqual([...ledger.pendingCleanupTurns], [], 'body113.basedOn.branchId=old 不属于新分支')
  const merged = mergeFailureState(ledger, surfaceFailureState({ failedTurns: [], canRollback: false, reason: 'x' }))
  assert.deepEqual([...merged.failedTurns], [], '新分支上不冒认旧分支的失败')
})

test('单一出处：缺 basedOn.branchId 的旧账本视为当代分支（不引入新的拒绝）', () => {
  const chat = chatWithFailedPreparation()
  delete chat.timeline.operations.body113.basedOn
  const ledger = ledgerFailureState(chat)
  assert.deepEqual([...ledger.pendingCleanupTurns], [113])
})

test('单一出处：无 basedOn.branchId 且 branchId 也缺失时不误判', () => {
  const chat = chatWithFailedPreparation()
  delete chat.timeline.operations.body113.basedOn
  delete chat.timeline.branchId
  assert.deepEqual([...ledgerFailureState(chat).pendingCleanupTurns], [113], '两边都缺 => 不归属 => 视为当代')
})

// ---------- ② 只读投影：无 Session lease 也要能算（守卫场景） ----------

test('只读投影：ledgerFailureState 不需要任何 evidence / lease', () => {
  const chat = chatWithFailedPreparation()
  // 守卫在回合准备期运行，手上只有 chat，没有 Session、没有 events、没有 nodes。
  assert.deepEqual([...ledgerFailureState(chat).pendingCleanupTurns], [113])
})

test('只读投影：readFailureState 缺少 availability 接线时响亮失败（不用半份状态决策）', () => {
  const chat = chatWithFailedPreparation()
  assert.throws(() => readFailureState(chat, { events: eventsUpTo112 }), /缺少可用性判据接线/)
})

test('只读投影：合并事件尾与三路结果到一份冻结快照', () => {
  const chat = chatWithFailedPreparation()
  const state = readFailureState(chat, {
    availability: () => ({ failedTurns: [], canRollback: false, reason: '当前没有可回退的已提交轮次' }),
    events: eventsUpTo112,
  })
  assert.equal(Object.isFrozen(state), true, '订阅方收到冻结副本，防回退中途目标移动')
  assert.deepEqual([...state.ledgerFailed], [113])
  assert.deepEqual([...state.failedTurns], [113])
  assert.equal(state.tail, 112, '事件流尾是 112，不是 failed 最大值')
  assert.deepEqual([...state.turns].slice(-2), [111, 112])
})

test('只读投影：缺 events 时从 session.snapshotEvents() 取（不重复造证据接口）', () => {
  const chat = chatWithFailedPreparation()
  const state = readFailureState(chat, {
    availability: () => ({ failedTurns: [], canRollback: true, reason: '' }),
    session: { header: { id: 'session-1' }, snapshotEvents: () => eventsUpTo112 },
  })
  assert.equal(state.tail, 112)
  assert.equal(state.branchId, 'branch-old')
  assert.equal(state.revision, 2)
})

// ---------- ③ inspectNativeFailureTail 也读同一处 ----------

/**
 * 构造能走到 L47 判据的最小现场：
 *   · 账本里**没有** turn 113 的 body 操作（否则先被 L28 "当前失败正文须按该轮业务回退基准清理" 挡住）；
 *   · 只留一个可配置 status 的 turn 112 body 操作 —— 它正是 L47 要判的"前轮失败操作"；
 *   · 原生尾是"纯守卫原生错误"：上一轮 turn/end 之后只有 seed + 目标轮的 start/end。
 */
function chatForNativeTail({ body112Status }) {
  return {
    id: 'chat-id', sessionId: 'session-1', _storageRevision: 2,
    messages: [{ role: 'user', text: 'u112' }, { role: 'assistant', turn: 112, text: 'a112' }],
    timeline: {
      schemaVersion: 1, branchId: 'branch-old', revision: 34, checkpoints: [], participants: {},
      operations: {
        body112: { id: 'body112', kind: 'body', role: 'body', status: body112Status, turn: 112, basedOn: { branchId: 'branch-old', revision: 33 } },
      },
    },
  }
}

const guardNativeTail = [
  { seq: 0, type: 'turn/start', data: { turn: 112 } },
  { seq: 1, type: 'user/message', data: { turn: 112, message: { role: 'user', content: [] } } },
  { seq: 2, type: 'assistant/message', data: { turn: 112, step: 1, message: { role: 'assistant', content: [] } } },
  { seq: 3, type: 'turn/end', data: { turn: 112, reason: { kind: 'error' } } },
  { seq: 4, type: 'session/end-seed', data: {} },
  { seq: 5, type: 'turn/start', data: { turn: 113 } },
  { seq: 6, type: 'turn/end', data: { turn: 113, reason: { kind: 'error', error: { message: FAILED_BODY_PREPARATION_ERROR } } } },
]

test('inspectNativeFailureTail：有前轮失败 body ⇒ 越过触发条件判据，给出 target', () => {
  const chat = chatForNativeTail({ body112Status: 'failed' })
  const ledger = ledgerFailureState(chat)
  assert.deepEqual([...ledger.ledgerFailed], [112], '前提：账本里确有前轮失败操作')
  const result = inspectNativeFailureTail(chat, { session: { header: { id: 'session-1' } }, events: guardNativeTail })
  assert.equal(result?.target ? true : false, true, '必须给出 native-only target；reason=' + String(result?.reason))
  assert.equal(result.target.kind, 'native-only')
  assert.equal(result.target.turn, 113)
})

test('inspectNativeFailureTail：没有前轮失败 body ⇒ 仍被"缺少触发条件"挡住', () => {
  const chat = chatForNativeTail({ body112Status: 'completed' })
  assert.deepEqual([...ledgerFailureState(chat).ledgerFailed], [], '前提：账本里没有任何失败 body')
  const result = inspectNativeFailureTail(chat, { session: { header: { id: 'session-1' } }, events: guardNativeTail })
  assert.equal(result?.target ?? null, null, '不得给出 target')
  assert.match(String(result?.reason || ''), /缺少触发正文准备守卫的前轮失败操作/)
})

test('inspectNativeFailureTail：前轮失败 body 属其它分支 ⇒ 同样挡住（与守卫同分支归属判据）', () => {
  const chat = chatForNativeTail({ body112Status: 'failed' })
  chat.timeline.branchId = 'branch-new'
  assert.deepEqual([...ledgerFailureState(chat).ledgerFailed], [], '旧分支的失败不属于新分支')
  const result = inspectNativeFailureTail(chat, { session: { header: { id: 'session-1' } }, events: guardNativeTail })
  assert.equal(result?.target ?? null, null)
  assert.match(String(result?.reason || ''), /缺少触发正文准备守卫的前轮失败操作/)
})

// ---------- ④ sessionTailState：与 sessionTurnTail 语义一致 ----------

test('sessionTailState：空流/无轮事件时不造伪尾', () => {
  assert.equal(sessionTailState([]).tail, 0)
  assert.equal(sessionTailState(undefined).tail, 0)
  assert.deepEqual([...sessionTailState([{ seq: 0, type: 'session/end-seed', data: {} }]).turns], [])
})
