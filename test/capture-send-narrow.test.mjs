// 第三刀定向叶：captureSend 去整档物化（发送接受关键路径 + 回退前像）。
// 只造合成档、不连接现场、不调用模型；作者 helper 与真实 SQLite 均与第0刀同一套夹具。
// 核心完成判据（方案 §3.4）：captureSend 两处 assemble 归零；回退前像逐字段与整档路径一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { startAssembleProbe } from '../lib/assemble-probe.js'
import { activeSendCapture } from '../lib/send-acceptance.js'
import { captureRollbackBusinessState } from '../lib/rollback-business-state.js'

const author = new URL('../../../tmp/adapt-65401-pr17/dsh-tavern-65401c0f67465acd3988f65e6c33881c40189dd0/tavern-plugin/lib/domain/', import.meta.url)
const helpers = {
  ...await import(new URL('copy-json-tree.js', author)),
  ...await import(new URL('json-mutation.js', author)),
  ...await import(new URL('chat-session-state.js', author)),
}
const ID = 'chat-capture-send-narrow'
const SESSION = 'session-capture-send'
const messages3 = () => [
  { role: 'user', text: '第一条输入' },
  { role: 'assistant', turn: 1, text: '第一轮正文', swipeId: 0, swipes: ['第一轮正文'], variables: [{ hp: 4 }] },
  { role: 'user', text: '第二条输入' },
]
async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-capture-send-narrow-'))
  const stores = []
  const open = () => {
    const store = createChatSqliteStore({ dataRoot: root, helpers, ...options })
    stores.push(store)
    return store
  }
  t.after(() => {
    stores.forEach(store => store.dispose())
    const target = path.resolve(root)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('tavern-capture-send-narrow-'))
    rmSync(target, { recursive: true, force: true })
  })
  const initial = open()
  await initial.update(ID, () => ({ id: ID, sessionId: SESSION, _storageRevision: 1,
    mode: 'story', title: '合成档', variables: { hp: 3 },
    messages: messages3(),
    timeline: { schemaVersion: 1, branchId: 'main', revision: 1, operations: {}, checkpoints: [], participants: { a: { role: 'user' } } },
  }))
  initial.dispose()
  const store = open()
  return { root, store, open, capture: activeSendCapture(root) }
}
const start = (store, extra = {}) => startAssembleProbe(store, { chatId: ID, durationMs: 30_000, maxCalls: 100, ...extra })
const turnStart = (turn = 2) => ({ sessionId: SESSION, type: 'turn/start', turn, seq: 10, events: [] })
const userInput = (turn, seq, text) => ({ sessionId: SESSION, type: 'user/message', turn, seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
// 一次性外部连接必须自己关：句柄不释放会让 after hook 的 rmSync 撞 EPERM。
const withDb = (dbPath, read) => { const db = new DatabaseSync(dbPath); try { return read(db) } finally { db.close() } }
const messageRows = dbPath => withDb(dbPath, db => db.prepare('SELECT message_index, message_json FROM archive_messages ORDER BY message_index').all())
const bodyOp = async (store, turn) => {
  const chat = await store.read(ID)
  return Object.values(chat.timeline.operations).find(op => op?.kind === 'body' && Number(op.turn) === turn)
}

test('第三刀：发送前像与补偿两处均不整档 assemble', async t => {
  const f = await fixture(t)
  const probe = start(f.store)
  const capture = f.capture
  assert.ok(capture, 'store 必须已注册发送前像写口')
  // ① 主路径：turn/start 同步前像
  const compensate = capture(ID, turnStart())
  const started = await f.store.read(ID)
  const op = await bodyOp(f.store, 2)
  assert.equal(op.status, 'running')
  assert.equal(op.businessBefore?.version, 1)
  assert.equal(started._storageRevision, 2)
  // ② 补偿：撤销同一同步前像
  compensate()
  const restored = await f.store.read(ID)
  assert.deepEqual(restored.timeline.operations, {})
  assert.equal(restored._storageRevision, 3)
  // ③ 再一次前像 + 后续提交 ⇒ 补偿必须被 revision CAS 拒绝
  const stale = capture(ID, turnStart())
  await f.store.update(ID, chat => ({ ...chat, title: '后续提交', _storageRevision: chat._storageRevision + 1 }))
  assert.throws(stale, /版本已变化/)
  assert.equal((await f.store.read(ID)).title, '后续提交')
  const snap = probe.stop()
  assert.equal(snap.byReason.captureSend, undefined, '第三刀：captureSend 主路径不得再 assemble')
  assert.equal(snap.byReason['captureSend.compensate'], undefined, '第三刀：补偿闭包不得再 assemble')
  assert.equal(snap.byReason.read?.calls, 2, '窄化后读缓存被 forgetState 清掉：前像后与补偿后各冷读一次')
  assert.equal(snap.byReason.update?.calls, 1, '后续提交仍走既有 update 路径')
  assert.equal(snap.calls, 3)
})

test('第三刀：回退前像逐字段与整档 capture 一致，messageCount 不塌成 0', async t => {
  const f = await fixture(t)
  const capture = f.capture
  // 对照基准必须取自**写入前**的完整档：captureSend 内部的 capture 就在写入前的 chat 上做。
  // 若在写入后取，库里已含新 operation（含 businessBefore 自身），整档 capture 会把它计进
  // operationStates/operationPreimages 形成自引用，那不是同一时刻的基准。
  const before = await f.store.read(ID)
  const expected = captureRollbackBusinessState(before)
  capture(ID, turnStart())
  const op = await bodyOp(f.store, 2)
  assert.deepEqual(op.businessBefore, expected, 'businessBefore 必须与整档 capture 逐字段一致')
  assert.equal(op.businessBefore.messageCount, 3, 'messageCount 必须是真实楼数（3 楼），不是占位长度 0')
  assert.equal(op.businessBefore.messageCount, before.messages.length)
  assert.deepEqual(op.businessBefore.fields.variables, { hp: 3 })
  assert.deepEqual(op.businessBefore.participants, { a: { role: 'user' } })
  assert.deepEqual(op.beforeParticipants, { a: { role: 'user' } }, 'beforeParticipants 必须来自完整 timeline（陷阱 3-A）')
  assert.equal(op.basedOn.branchId, 'main')
  assert.equal(op.beforeRevision, 1)
  // 楼数变化后再次 capture：前像必须跟随新楼数（证明不是恒定值）。
  // 先把上一轮标成 completed：assertSendAfterCleanup 拒绝"上轮未清理就又开新轮"。
  await f.store.update(ID, chat => ({ ...chat,
    messages: [...chat.messages, { role: 'assistant', turn: 2, text: '第二轮正文', swipeId: 0, swipes: ['第二轮正文'] }],
    timeline: { ...chat.timeline, operations: Object.fromEntries(Object.entries(chat.timeline.operations)
      .map(([id, op]) => [id, { ...op, status: 'completed' }])) },
    _storageRevision: chat._storageRevision + 1 }))
  capture(ID, turnStart(3))
  const op3 = await bodyOp(f.store, 3)
  assert.equal(op3.businessBefore.messageCount, 4, '追加一楼后前像 messageCount 必须变成 4')
})

test('第三刀：护栏一字不减且楼表行数一字不动', async t => {
  const f = await fixture(t)
  const capture = f.capture
  const dbPath = path.join(f.root, 'chats', ID, 'archive.db')
  const before = messageRows(dbPath)
  // ① 会话身份不一致必须拒绝，且零写
  assert.throws(() => capture(ID, { ...turnStart(), sessionId: 'session-other' }), /身份不一致/)
  let chat = await f.store.read(ID)
  assert.equal(chat._storageRevision, 1, '身份拒绝后 revision 不得推进')
  assert.deepEqual(Object.values(chat.timeline.operations || {}), [], '身份拒绝后不得留下 operation')
  // ② 缺有效剧情时间线必须拒绝，且零写
  await f.store.update(ID, current => ({ ...current, timeline: { schemaVersion: 2 }, _storageRevision: current._storageRevision + 1 }))
  assert.throws(() => capture(ID, turnStart()), /缺少有效剧情时间线/)
  chat = await f.store.read(ID)
  assert.equal(chat._storageRevision, 2, 'timeline 拒绝后 revision 不得推进')
  assert.deepEqual(Object.values(chat.timeline.operations || {}), [], 'timeline 拒绝后不得留下 operation')
  // ②b 恢复有效时间线（此时 rollbackPending 未设，update 自身可过屏障）
  await f.store.update(ID, current => ({ ...current,
    timeline: { schemaVersion: 1, branchId: 'main', revision: 1, operations: {}, checkpoints: [], participants: {} },
    _storageRevision: current._storageRevision + 1 }))
  // ③ 成功前像不得改动任何楼层行（headOnly 模式不写楼）
  capture(ID, turnStart())
  const after = messageRows(dbPath)
  assert.deepEqual(after, before, '发送前像写入后楼表必须逐行一字不动')
  // ④ 物理回退静止屏障必须拒绝（放最后：rollbackPending 是自锁态，普通 update 自己也会被它挡住）
  await f.store.update(ID, current => ({ ...current, rollbackPending: true, _storageRevision: current._storageRevision + 1 }))
  assert.throws(() => capture(ID, turnStart()), /回退/)
})

test('第三刀：补偿楼层数护栏拦住外部改库，读缓存不被占位毒化', async t => {
  const f = await fixture(t)
  const capture = f.capture
  const dbPath = path.join(f.root, 'chats', ID, 'archive.db')
  const compensate = capture(ID, turnStart())
  // 占位不得泄漏到对外读口：readSlice([]) 的 messages 恒为 []。
  assert.deepEqual((await f.store.readSlice(ID, [])).chat.messages, [], '窄占位不得泄漏为带洞数组')
  // 读缓存不得被毒化：read 必须拿到真实楼层正文，而不是 undefined 空洞。
  const chat = await f.store.read(ID)
  assert.equal(chat.messages.length, 3)
  assert.equal(chat.messages[2].text, '第二条输入')
  assert.equal(chat.messages.every(row => row && typeof row === 'object'), true)
  // 外部直改库文件删一行楼层（不推 revision）：补偿必须显式拒绝，不得按错误楼数覆盖。
  withDb(dbPath, db => db.exec('DELETE FROM archive_messages WHERE message_index = 2'))
  assert.equal(messageRows(dbPath).length, 2)
  assert.throws(compensate, /楼层数已变化/)
  // 拒绝后库内仍是前像写入后的状态（未被半恢复），楼数保持外部改后的 2。
  assert.equal(messageRows(dbPath).length, 2, '补偿被拒后不得改写楼表')
  const chatAfter = await f.store.read(ID)
  assert.equal(Object.values(chatAfter.timeline.operations).length, 1, '补偿被拒后前像 operation 必须仍在')
})

test('第三刀：user 输入分支窄化后锚点语义不变', async t => {
  const f = await fixture(t)
  const capture = f.capture
  capture(ID, turnStart())
  // 原生 player 输入到达：补真实 seq 锚点与 userText。
  capture(ID, userInput(2, 21, '第二条输入正文'))
  const withInput = await bodyOp(f.store, 2)
  assert.deepEqual(withInput.nativeAnchor, { turn: 2, input: 21, reply: null })
  assert.equal(withInput.userText, '第二条输入正文')
  assert.equal(withInput.inputPending, undefined)
  const baseline = structuredClone(withInput.businessBefore)
  // 已有 anchor ⇒ 晚到重复输入不得覆盖。
  capture(ID, userInput(2, 22, '第二条输入正文（重复）'))
  const afterDuplicate = await bodyOp(f.store, 2)
  assert.deepEqual(afterDuplicate.nativeAnchor, { turn: 2, input: 21, reply: null }, '已有 anchor 不得被覆盖')
  assert.equal(afterDuplicate.userText, '第二条输入正文', '晚到输入不得覆盖已投影 userText')
  assert.deepEqual(afterDuplicate.businessBefore, baseline, '晚到输入不得改 businessBefore')
  // 非 player 来源（插件上下文）不得改 anchor。
  capture(ID, { sessionId: SESSION, type: 'user/message', turn: 2, seq: 23, data: { source: { kind: 'plugin', plugin: 'dsh-tavern' }, content: [{ type: 'text', text: '插件上下文' }] } })
  const afterPlugin = await bodyOp(f.store, 2)
  assert.deepEqual(afterPlugin.nativeAnchor, { turn: 2, input: 21, reply: null }, '非 player 输入不得改写 anchor')
  assert.equal(afterPlugin.userText, '第二条输入正文')
})
