// S1 具名断言：SQL 活动摘要（真实 store 夹具 + 同库真 SQL + 作者 coordinator 对照）。
// 夹具机制沿用既有 test/known-write-set.test.mjs：作者 2.5 真身 helper（copy-json-tree/json-mutation）
// ＋未使用的显示投影以结构化脱离替身满足 DI；本闸不冒称页面验收。夹具缺失即响亮失败，不 skip。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { readActivitySummary, activityFromSmallRows } from '../lib/chat-query-service.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused
for (const [n, f] of Object.entries(HELPERS)) assert.equal(typeof f, 'function', '作者 helper ' + n + ' 缺失：夹具无法对账')

const CHAT = chatId => ({
  id: chatId, sessionId: 'session-activity-fixture', _storageRevision: 1, updatedAt: 1,
  mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  timeline: {
    schemaVersion: 1, branchId: 'branch-main', revision: 3, updatedAt: 40, participants: {},
    operations: {
      'op-agent-running': {
        id: 'op-agent-running', kind: 'agent', role: 'background', status: 'running', turn: 7,
        createdAt: 30, background: { phase: 'running', role: 'background', updatedAt: 31 }
      },
      'op-body-done': {
        id: 'op-body-done', kind: 'body', role: 'body', status: 'completed', turn: 6,
        createdAt: 20, completedAt: 25, committedBranchId: 'branch-main', committedRevision: 3,
        basedOn: { branchId: 'branch-main', revision: 2 },
        background: { phase: 'failed', role: 'settlement', updatedAt: 26, reason: 'settle-error' }
      }
    }
  },
  messages: []
})

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-activity-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const chatId = 'chat-activity-fixture'
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })   // 先释放 store 再删，避免 Windows 句柄占用
  return { root, chatId, store }
}

test('SQL活动摘要返回最终activity与作者coordinator一致且带小timeline', async t => {
  const f = fixture(t)
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  const summary = await f.store.readActivitySummary({ chatId: f.chatId, sessionId: 'session-activity-fixture' })
  assert.equal(summary.kind, 'value')
  assert.equal(summary.identity.chatId, f.chatId)
  assert.equal(summary.identity.sessionId, 'session-activity-fixture')
  assert.equal(Number.isSafeInteger(summary.revision), true)
  // 最终 activity（不是 operations 数组）：running agent 优先
  assert.equal(summary.activity.phase, 'running')
  assert.equal(summary.activity.busy, true)
  assert.equal(summary.activity.operationId, 'op-agent-running')
  assert.equal(Object.hasOwn(summary.activity, 'reason'), false, 'running 分支不得带 reason')
  // 小 timeline 展示数据
  assert.equal(summary.timeline.schemaVersion, 1)
  assert.equal(summary.timeline.branchId, 'branch-main')
  assert.equal(summary.timeline.revision, 3)
  assert.equal(summary.timeline.updatedAt, 40, 'meta.updatedAt 仅供展示')
  assert.deepEqual(summary.timeline.checkpoints, [])
  assert.equal(summary.timeline.operations['op-body-done'].startedSessionId, undefined, '缺失键不发明')
  assert.equal(Object.hasOwn(summary.timeline.operations['op-body-done'], 'businessBefore'), false)
  // 作者对照：真身 coordinator.activity（background-task-coordinator.js:369 导出 activity）
  const { createStoryTimeline } = await import(new URL('story-timeline.js', AUTHOR68215))
  const { createBackgroundTaskCoordinator } = await import(new URL('background-task-coordinator.js', AUTHOR68215))
  const coordinatorStore = { readChat: async () => undefined, writeChat: async () => {}, updateChat: async () => {} }
  const coordinator = createBackgroundTaskCoordinator({ store: coordinatorStore, timeline: createStoryTimeline({}) })
  assert.equal(typeof coordinator.activity, 'function', '作者 coordinator 必须导出 activity')
  assert.deepEqual(summary.activity, coordinator.activity(CHAT(f.chatId)), '摘要必须与作者 activity 逐字一致')
})

test('SQL活动摘要在无running时取当前分支最近failed body且带reason', async t => {
  const f = fixture(t)
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  await f.store.update(f.chatId, stored => {
    const next = { ...stored, _storageRevision: 2, timeline: { ...stored.timeline, operations: { ...stored.timeline.operations } } }
    delete next.timeline.operations['op-agent-running']
    return next
  })
  const summary = await f.store.readActivitySummary({ chatId: f.chatId })
  assert.equal(summary.activity.phase, 'failed')
  assert.equal(summary.activity.busy, false)
  assert.equal(summary.activity.operationId, 'op-body-done')
  assert.equal(summary.activity.basedOn, null, 'failed 分支 basedOn 必须为 null')
  assert.equal(summary.activity.reason, 'settle-error', 'background.reason 有值必须带出')
  assert.equal(summary.activity.updatedAt, 26)
  // 与作者 coordinator 同输入对账
  const { createStoryTimeline } = await import(new URL('story-timeline.js', AUTHOR68215))
  const { createBackgroundTaskCoordinator } = await import(new URL('background-task-coordinator.js', AUTHOR68215))
  const coordinatorStore = { readChat: async () => undefined, writeChat: async () => {}, updateChat: async () => {} }
  const coordinator = createBackgroundTaskCoordinator({ store: coordinatorStore, timeline: createStoryTimeline({}) })
  const chat = CHAT(f.chatId)
  delete chat.timeline.operations['op-agent-running']
  assert.deepEqual(summary.activity, coordinator.activity(chat))
})

test('SQL活动摘要revision与身份不符时明确报错不伪idle', async t => {
  const f = fixture(t)
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  assert.throws(() => f.store.readActivitySummary({ chatId: f.chatId, revision: 999 }), /revision 不匹配/, '同步 API：错误必须 throws')
  assert.throws(() => f.store.readActivitySummary({ chatId: f.chatId, sessionId: 'other-session' }), /sessionId 不匹配/, '同步 API：错 session 必须 throws')
  // 不存在的档：store 出口按既有无档语义返回 null（不是身份冲突）；身份冲突只在直读路径可判
  assert.equal(f.store.readActivitySummary({ chatId: 'other-chat' }), null, '不存在的档应返回 null，不改期待')
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId), { readOnly: true })
  try {
    assert.throws(() => readActivitySummary(db, { chatId: 'other-chat' }), /chatId 不匹配/, '直读已有库时错 chatId 才是真身份冲突')
  } finally { db.close() }
})

test('SQL活动摘要同库只读连接可复算且旧代整键timeline显式not-applicable', async t => {
  const f = fixture(t)
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId), { readOnly: true })
  try {
    const direct = readActivitySummary(db, { chatId: f.chatId })
    assert.equal(direct.kind, 'value')
    assert.equal(direct.activity.phase, 'running')
    assert.equal(direct.timeline.operations['op-agent-running'].status, 'running')
  } finally { db.close() }
  // 人造旧格式：独立可写夹具库（只用于人造 test，不是业务路径），用写连接 DROP 子行表
  const legacyChatId = 'chat-legacy-fixture'
  await f.store.update(legacyChatId, () => CHAT(legacyChatId))
  const legacyDb = new DatabaseSync(f.store.rollbackArchivePath(legacyChatId))
  try {
    legacyDb.exec('DROP TABLE archive_timeline_nodes')
    assert.deepEqual(readActivitySummary(legacyDb, { chatId: legacyChatId }), { kind: 'not-applicable', reason: 'legacy-body' })
  } finally { legacyDb.close() }
})

test('S2 SQL窗口同快照且不读取checkpoint和operations前像', async t => {
  const f = fixture(t)
  const chatId = f.chatId
  const messages = Array.from({ length: 90 }, (_v, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1, index }))
  const base = CHAT(chatId)
  await f.store.update(chatId, () => ({
    ...base,
    messages,
    timeline: {
      ...base.timeline,
      checkpoints: [{ id: 'cp-1', before: { huge: 'x'.repeat(20000) } }],
      operations: {
        ...base.timeline.operations,
        'op-body-done': { ...base.timeline.operations['op-body-done'], businessBefore: { huge: 'y'.repeat(20000) } }
      }
    }
  }))
  const window = await f.store.readOpeningWindow(chatId, { limit: 24, requirePartial: true, from: 30 })
  assert.equal(window.from, 30)
  assert.equal(window.to, 89)
  assert.equal(window.messageCount, 90)
  assert.equal(Number.isSafeInteger(window.identity?.revision ?? window.revision), true, '必须带 revision/identity')
  const serialized = JSON.stringify(window)
  assert.equal(serialized.includes('y'.repeat(200)), false, '不得带出 operations 前像（businessBefore）')
  assert.equal(serialized.includes('x'.repeat(200)), false, '不得带出 checkpoint 前像')
  // 同库只读连接核 SQL 投影面（node:sqlite 无 trace，故按实际投影列字段面核对）
  const db = new DatabaseSync(f.store.rollbackArchivePath(chatId), { readOnly: true })
  try {
    const rows = db.prepare('SELECT message_index, message_json FROM archive_messages WHERE message_index >= ? AND message_index < ? ORDER BY message_index').all(30, 90)
    assert.equal(rows.length, 60, '同快照窗口行数应与 30..89 一致')
  } finally { db.close() }
  // 调用对象乱改后下一读隔离
  window.from = -1
  if (Array.isArray(window.chat?.messages)) window.chat.messages.length = 0
  const again = await f.store.readOpeningWindow(chatId, { limit: 24, requirePartial: true, from: 30 })
  assert.equal(again.from, 30, '返回对象被改后下一次读必须隔离')
  assert.equal(again.messageCount, 90)
  const full = await f.store.readOpeningWindow(chatId, { limit: 100, requirePartial: true, from: 30 })
  assert.equal(full, null, 'limit100 + requirePartial true 应返回 null（不是完整窗口）')
  const complete = await f.store.readOpeningWindow(chatId, { limit: 100, requirePartial: false, from: 30 })
  assert.equal(complete.to, 89, 'requirePartial false 才是完整 window')
  assert.throws(() => f.store.readOpeningWindow(chatId, { limit: 24, requirePartial: true, from: 30, sessionId: 'other-session' }), /sessionId 不匹配/, '同步 API：错 session 必须 throws')
  const db2 = new DatabaseSync(f.store.rollbackArchivePath(chatId), { readOnly: false })   // DROP 需写连接（store 无需关闭）
  try {
    db2.exec('DROP TABLE archive_timeline_nodes')
    const legacy = await f.store.readOpeningWindow(chatId, { limit: 24, requirePartial: true, from: 30 })
    assert.equal(legacy.kind ?? legacy.reason, 'not-applicable', 'legacy 必须显式 not-applicable')
  } finally { db2.close() }
})

test('SQL活动摘要等时排序与数字键严格复现作者', async t => {
  const f = fixture(t)
  const { createStoryTimeline } = await import(new URL('story-timeline.js', AUTHOR68215))
  const { createBackgroundTaskCoordinator } = await import(new URL('background-task-coordinator.js', AUTHOR68215))
  const cluster = {
    // 数字键 10/2 交错 ＋ 等 createdAt（z 先 a 后）：必须与作者 Object.values 顺序一致（依赖 rowid 行序）
    '10': { id: '10', kind: 'agent', role: 'settlement', status: 'interrupted', createdAt: 50 },
    '2': { id: '2', kind: 'agent', role: 'background', status: 'done', createdAt: 50 },
    z: { id: 'z', kind: 'agent', role: 'background', status: 'done', createdAt: 50 },
    a: { id: 'a', kind: 'agent', role: 'background', status: 'done', createdAt: 50 },
    'body-1': { id: 'body-1', kind: 'body', role: 'body', status: 'completed', completedAt: 60, committedBranchId: 'branch-sort', background: { phase: 'pending', role: 'settlement', updatedAt: 61 } },
    'body-2': { id: 'body-2', kind: 'body', role: 'body', status: 'completed', completedAt: 60, committedBranchId: 'branch-sort', background: { phase: 'pending', role: 'settlement', updatedAt: 62 } }
  }
  const chatId = 'chat-sort-fixture'
  const base = CHAT(chatId)
  await f.store.update(chatId, () => ({ ...base, _storageRevision: 1, timeline: { ...base.timeline, branchId: 'branch-sort', revision: 4, operations: cluster } }))
  const summary = await f.store.readActivitySummary({ chatId })
  const coordinator = createBackgroundTaskCoordinator({ store: { readChat: async () => undefined, writeChat: async () => {}, updateChat: async () => {} }, timeline: createStoryTimeline({}) })
  const stored = await f.store.read(chatId)   // 产品 store 真 API 是 read()（导出清单 chat-sqlite-store.js:1497），不是 readChat
  assert.deepEqual(summary.activity, coordinator.activity(stored), '等时/数字键平局必须与作者 activity 一致')
  await f.store.update(chatId, chat => ({ ...chat, _storageRevision: Number(chat._storageRevision || 1) + 1, updatedAt: 9 }))
  const again = await f.store.readActivitySummary({ chatId })
  assert.deepEqual(again.activity, summary.activity, 'UPDATE 后结果必须稳定（不重排）')
  const after = await f.store.read(chatId)
  assert.deepEqual(Object.keys(after.timeline.operations), Object.keys(stored.timeline.operations), 'operations 键顺序不得因 UPDATE 变化')
  // 形态 A：z/a 等 createdAt running ＋ 数字键 2/10 running ⇒ Object.values 数字键在前 ⇒ 选中 '2'
  await f.store.update(chatId, chat => ({
    ...chat, _storageRevision: Number(chat._storageRevision || 1) + 1,
    timeline: {
      ...chat.timeline,
      operations: {
        z: { id: 'z', kind: 'agent', role: 'background', status: 'running', createdAt: 70 },
        a: { id: 'a', kind: 'agent', role: 'background', status: 'running', createdAt: 70 },
        '2': { id: '2', kind: 'agent', role: 'background', status: 'running', createdAt: 70 },
        '10': { id: '10', kind: 'agent', role: 'background', status: 'running', createdAt: 70 }
      }
    }
  }))
  const shapeA = await f.store.readActivitySummary({ chatId })
  assert.equal(shapeA.activity.operationId, '2', '等时 running 平局必须复现 Object.values 数字键优先')
  assert.equal(shapeA.activity.phase, 'running')
  // 形态 B：删掉数字键 agents ⇒ 插入序 z 先于 a ⇒ 选中 'z'
  await f.store.update(chatId, chat => ({
    ...chat, _storageRevision: Number(chat._storageRevision || 1) + 1,
    timeline: { ...chat.timeline, operations: { z: chat.timeline.operations.z, a: chat.timeline.operations.a } }
  }))
  const shapeB = await f.store.readActivitySummary({ chatId })
  assert.equal(shapeB.activity.operationId, 'z', '等时 running 平局必须复现行序（z 先插入）')
})

test('SQL活动摘要损坏快照与nested事务守卫', async t => {
  const f = fixture(t)
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId))
  try {
    const metaBytes = db.prepare("SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get()?.value_json
    db.prepare("UPDATE archive_timeline_nodes SET value_json='{ not json' WHERE node_key='@meta'").run()
    assert.throws(() => readActivitySummary(db, { chatId: f.chatId }), SyntaxError, '损坏 JSON 必须 SyntaxError 上抛（parse 阶段）')
    db.prepare("UPDATE archive_timeline_nodes SET value_json=? WHERE node_key='@meta'").run(metaBytes)
    assert.equal(readActivitySummary(db, { chatId: f.chatId }).kind, 'value', '恢复旧字节后同连接必须可读（事务无残）')
    db.prepare("DELETE FROM archive_timeline_nodes WHERE node_key='@meta'").run()
    assert.throws(() => readActivitySummary(db, { chatId: f.chatId }), /@meta/, '有 timeline 占位而 meta 缺失＝损坏')
    db.prepare("INSERT INTO archive_timeline_nodes (node_key, ord, value_json) VALUES ('@meta', -1, ?)").run(metaBytes)
    assert.equal(readActivitySummary(db, { chatId: f.chatId }).kind, 'value')
    const idBytes = db.prepare("SELECT value_json FROM archive_head_fields WHERE key='id'").get()?.value_json
    db.prepare("UPDATE archive_head_fields SET value_json=NULL WHERE key='id'").run()
    assert.throws(() => readActivitySummary(db, { chatId: f.chatId }), /identity\.chatId|缺 identity/, '缺 session/id 必须显式报错，不 not-applicable')
    db.prepare("UPDATE archive_head_fields SET value_json=? WHERE key='id'").run(idBytes)
    assert.equal(readActivitySummary(db, { chatId: f.chatId }).kind, 'value', '恢复后同连接可读')
    db.exec('BEGIN')
    try {
      assert.equal(db.isTransaction, true)
      assert.equal(readActivitySummary(db, { chatId: f.chatId }).kind, 'value')
      assert.equal(db.isTransaction, true, 'nested 读取不得结束外层事务')
    } finally { db.exec('ROLLBACK') }
    assert.equal(db.isTransaction, false, '外层 ROLLBACK 后状态复位')
    assert.equal(readActivitySummary(db, { chatId: f.chatId }).kind, 'value', 'ROLLBACK 后仍可读')
  } finally { db.close() }
})

test('activityFromSmallRows在数字键与interrupted结算下与作者一致', async t => {
  const { createStoryTimeline } = await import(new URL('story-timeline.js', AUTHOR68215))
  const { createBackgroundTaskCoordinator } = await import(new URL('background-task-coordinator.js', AUTHOR68215))
  const coordinatorStore = { readChat: async () => undefined, writeChat: async () => {}, updateChat: async () => {} }
  const coordinator = createBackgroundTaskCoordinator({ store: coordinatorStore, timeline: createStoryTimeline({}) })
  const chat = {
    mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    timeline: {
      schemaVersion: 1, branchId: 'b', revision: 5, participants: {}, checkpoints: [],
      operations: {
        '10': { id: '10', kind: 'agent', role: 'settlement', status: 'interrupted', createdAt: 10 },
        '9': { id: '9', kind: 'agent', role: 'background', status: 'done', createdAt: 9 }
      }
    }
  }
  const mine = activityFromSmallRows({ operations: chat.timeline.operations, branchId: 'b', revision: 5 })
  assert.deepEqual(mine, coordinator.activity(chat), '数字键顺序与 interrupted+settlement ⇒ reason 必须一致')
  assert.equal(mine.reason, 'interrupted')
})
