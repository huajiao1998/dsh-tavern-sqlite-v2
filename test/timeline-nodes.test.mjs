// P2-a（D-5）定向闸（本文件独占）：timeline 子键拆行的写/读/迁移/失效/兜底/自检证据。
// 授权：issues/plan-p2-timeline-rows-and-memory-budget.md §1.9。只测本刀；不触真实档、不调模型、不跑全量。
// diff/apply/copy 直接用固定作者 2.5 模块；投影位以脱离替身满足 DI（同 known-write-set 先例）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { createRollbackGlobalVariables } from '../lib/rollback-global-variables.js'
const A = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const { copyJsonTree } = await import(new URL(A + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(A + 'json-mutation.js', import.meta.url))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint', 'projectSessionMessage']) HELPERS[n] = projUnused

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-timeline-nodes-'))
const chatsRoot = path.join(root, 'chats')
const stores = [], sides = []
const openStore = () => { const s = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS }); stores.push(s); return s }
const sideDb = id => { const db = new DatabaseSync(path.join(chatsRoot, id, 'archive.db')); sides.push(db); return db }
const one = (db, q, ...a) => db.prepare(q).get(...a)
const nodeRows = db => db.prepare('SELECT node_key, ord, value_json FROM archive_timeline_nodes').all()

const TIMELINE = () => ({ schemaVersion: 1, branchId: 'branch-p2', revision: 7, lifecycleRevision: 2, participants: { background: { status: 'idle' } },
  operations: { op1: { kind: 'body', turn: 1, status: 'pending', fields: { story: 'A'.repeat(2000) } }, op2: { kind: 'agent', turn: 1, status: 'prepared' } },
  checkpoints: [{ turn: 1, snapshot: 'C'.repeat(1000) }, { turn: 2, snapshot: 'C'.repeat(1000) }] })
const CHAT = id => ({ id, sessionId: 'session-' + id, _storageRevision: 1, mode: 'story',
  timeline: TIMELINE(), messages: [{ role: 'assistant', greeting: true, turn: 0, swipeId: 0, swipes: ['开场'], text: '开场' }] })
const seed = async (store, id) => { await store.update(id, () => CHAT(id)); return store.read(id) }
const bump = (store, id, fn) => store.update(id, chat => { const next = fn(chat) || chat; next._storageRevision = chat._storageRevision + 1; return next })

// SQL 探针：只数子行逐行取回（行缓存 miss 的证据），不打印内容。
const probe = { calls: [], reset() { this.calls.length = 0 } }
const prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql)
  return new Proxy(statement, { get(target, key) { const member = Reflect.get(target, key); if (typeof member !== 'function') return member; return (...args) => { const result = member.apply(target, args); if (/FROM archive_timeline_nodes WHERE node_key=\?/.test(sql)) probe.calls.push(1); return result } } })
}

try {
  test('1 拆行往返等价：node 行落位、head 占位 NULL、读回 deepEqual', async () => {
    const store = openStore(), id = 'chat-p2-1'
    const original = await seed(store, id)
    const db = sideDb(id)
    assert.equal(one(db, "SELECT value_json FROM archive_head_fields WHERE key='timeline'")?.value_json, null, 'head 行必须是 NULL 占位')
    const rows = nodeRows(db)
    assert.equal(rows.length, 5, '@meta + 2 checkpoints + 2 operations')
    assert.deepEqual(rows.map(r => r.node_key).sort(), ['@meta', 'checkpoints#0', 'checkpoints#1', 'operations:op1', 'operations:op2'])
    assert.deepEqual(JSON.parse(rows.find(r => r.node_key === '@meta').value_json), { schemaVersion: 1, branchId: 'branch-p2', revision: 7, lifecycleRevision: 2, participants: { background: { status: 'idle' } } })
    assert.deepEqual(original.timeline, TIMELINE(), '读回与写入的 timeline 等价（含空容器键）')
    db.close()
  })

  test('2 增量写只动变更行：op1.status 改写仅 operations:op1 行变化', async () => {
    const store = openStore(), id = 'chat-p2-2'
    await seed(store, id)
    const db = sideDb(id)
    const before = new Map(nodeRows(db).map(r => [r.node_key, r.value_json]))
    await bump(store, id, chat => { chat.timeline.operations.op1.status = 'completed'; return chat })
    const after = new Map(nodeRows(db).map(r => [r.node_key, r.value_json]))
    const changed = [...after.keys()].filter(key => after.get(key) !== before.get(key))
    assert.deepEqual(changed, ['operations:op1'], '只有 op1 行变化；@meta/op2/checkpoints 行字节不变')
    assert.equal(JSON.parse(after.get('operations:op1')).status, 'completed')
    db.close()
  })

  test('3 checkpoint 追加与截断：append 只加新行、截断删越界行且 ord 连续', async () => {
    const store = openStore(), id = 'chat-p2-3'
    await seed(store, id)
    const db = sideDb(id)
    const before = new Map(nodeRows(db).map(r => [r.node_key, r.value_json]))
    await bump(store, id, chat => { chat.timeline.checkpoints.push({ turn: 3, snapshot: 'D'.repeat(500) }); return chat })
    let rows = nodeRows(db)
    assert.equal(rows.filter(r => r.node_key.startsWith('checkpoints#')).length, 3)
    assert.deepEqual(rows.filter(r => r.node_key.startsWith('checkpoints#')).map(r => r.ord), [0, 1, 2])
    assert.equal(before.get('checkpoints#0'), rows.find(r => r.node_key === 'checkpoints#0').value_json, '旧行不动')
    await bump(store, id, chat => { chat.timeline.checkpoints = chat.timeline.checkpoints.slice(0, 1); return chat })
    rows = nodeRows(db)
    const cps = rows.filter(r => r.node_key.startsWith('checkpoints#'))
    assert.equal(cps.length, 1, '截断后只剩 1 行')
    assert.equal(Number(cps[0].ord), 0)
    assert.equal(before.get('checkpoints#0'), cps[0].value_json, '保留行内容不变')
    db.close()
  })

  test('4 v3→v4 迁移：手建旧形态（timeline 在 head 行）→ 首读触发迁移 → 子行落位＋读回等价', async () => {
    const id = 'chat-p2-4'
    mkdirLegacyV3(id, CHAT(id))
    const store = openStore()
    const chat = await store.read(id)
    assert.deepEqual(chat.timeline, TIMELINE(), '迁移后读回等价')
    const db = sideDb(id)
    assert.equal(one(db, "SELECT value_json FROM archive_head_fields WHERE key='timeline'")?.value_json, null, 'head 行置 NULL 占位')
    assert.equal(nodeRows(db).length, 5, '子行落位')
    db.close()
  })

  test('5 行级失效精确性：热读后写 1 行再读 → 恰好 1 次子行逐行取回', async () => {
    const store = openStore(), id = 'chat-p2-5'
    await seed(store, id)
    await store.readSessionState(id)          // 冷读：行缓存填满
    probe.reset()
    await bump(store, id, chat => { chat.timeline.operations.op1.status = 'completed'; return chat })
    await store.readSessionState(id)          // 写后首读：只重读被失效的 op1 行
    assert.equal(probe.calls.length, 1, '只重读 1 个变更行（行级失效，非全清）')
    const state = await store.readSessionState(id)
    assert.equal(state.timeline.operations.op1.status, 'completed', '读到新值')
    probe.reset()
    await store.readSessionState(id)          // 再读：全命中
    assert.equal(probe.calls.length, 0, '行缓存全命中零逐行取回')
  })

  test('6 full fallback：patch 整条 timeline set → 全量重写且读回等价', async () => {
    const store = openStore(), id = 'chat-p2-6'
    const seeded = await seed(store, id)
    const revision = seeded._storageRevision
    const next = TIMELINE()
    next.operations = { op3: { kind: 'body', turn: 9, status: 'pending', fields: { story: 'B'.repeat(300) } } }
    next.checkpoints = [{ turn: 9, snapshot: 'E'.repeat(300) }]
    const patched = await store.patch(id, revision, [
      { op: 'set', path: ['_storageRevision'], value: revision + 1 },
      { op: 'set', path: ['timeline'], value: next }])
    assert.deepEqual(patched.timeline, next)
    const db = sideDb(id)
    assert.equal(nodeRows(db).length, 3, '@meta + 1 checkpoint + 1 operation（全量重写，旧行清掉）')
    assert.deepEqual((await store.read(id)).timeline, next)
    db.close()
  })

  test('7 自检 fail-loud：ord 被破坏后写 timeline → 抛错不落库', async () => {
    const store = openStore(), id = 'chat-p2-7'
    const seeded = await seed(store, id)
    const db = sideDb(id)
    db.prepare("UPDATE archive_timeline_nodes SET ord=3 WHERE node_key='checkpoints#' || (SELECT COUNT(*)-1 FROM archive_timeline_nodes WHERE node_key LIKE 'checkpoints#%')").run()
    await assert.rejects(bump(store, id, chat => { chat.timeline.revision += 1; return chat }), /timeline 子行自检失败/, 'ord 不连续必须响亮失败')
    db.close()
  })

  test('8 rollback-global-variables 旧形态兜底：v3 档（无子行表）分支校验走 head 行', async () => {
    const id = 'chat-p2-8'
    const chat = CHAT(id)
    mkdirLegacyV3(id, chat)
    const archivePath = path.join(chatsRoot, id, 'archive.db')
    const globalsRoot = mkdtempSync(path.join(os.tmpdir(), 'tavern-p2-globals-'))
    const globals = createRollbackGlobalVariables({ profileData: {}, dataRoot: globalsRoot, databaseName: 'prompt-template-variables.db', legacyName: null, archiveForChat: () => archivePath })
    // 匹配分支：兜底读 head 行的 branchId → 放行
    await globals.save({ marker: 1 }, undefined, { chatId: id, turn: 1, branchId: chat.timeline.branchId })
    assert.deepEqual(await globals.read(), { marker: 1 })
    // 不匹配分支：拒绝旧任务回写
    await assert.rejects(globals.save({ marker: 2 }, undefined, { chatId: id, turn: 1, branchId: 'other-branch' }), /已退役分支/)
    await globals.dispose()
    rmSync(globalsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  test('9 根变更（path=[] 整档替换）→ timeline 子行全量重写（审查修复①回归）', async () => {
    const store = openStore(), id = 'chat-p2-9'
    const seeded = await seed(store, id)
    const revision = seeded._storageRevision
    const next = CHAT(id)
    next.title = '根替换后的标题'
    next._storageRevision = revision + 1
    next.timeline = { ...TIMELINE(), branchId: 'branch-replaced',
      operations: { opNew: { kind: 'body', turn: 5, status: 'pending', fields: { story: 'X'.repeat(120) } } },
      checkpoints: [{ turn: 5, snapshot: 'Y'.repeat(120) }] }
    // applyJsonChangesShared 的 setValue 对空 path＝整档替换（合法 patch 形态）
    const patched = await store.patch(id, revision, [{ op: 'set', path: [], value: next }])
    assert.deepEqual(patched.timeline, next.timeline)
    const db = sideDb(id)
    assert.equal(nodeRows(db).length, 3, '根替换后子行全量重写（@meta＋1 checkpoint＋1 operation）')
    assert.equal(JSON.parse(db.prepare("SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get().value_json).branchId, 'branch-replaced')
    assert.deepEqual((await store.read(id)).timeline, next.timeline, '读回新 timeline（修复前端出旧行＝数据损坏）')
    db.close()
  })
} finally {
  // node:test 顶层 test 异步返回 Promise；探针还原与清理由 after 管理（finally 在注册后立即执行，
  // 不能在这里还原 prototype——否则测试运行前探针就死了）。
  test.after(() => {
    DatabaseSync.prototype.prepare = prepare
    for (const db of sides) { try { db.close() } catch { /* 已关 */ } }
    for (const s of stores) { try { s.dispose() } catch { /* 已释放 */ } }
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('tavern-timeline-nodes-')) return
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
}

/** 手建 v3 形态档（timeline 整键在 head 行，无子行表）——迁移输入。 */
function mkdirLegacyV3(id, chat) {
  const dir = path.join(chatsRoot, id)
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'archive.db'))
  db.exec(`CREATE TABLE archive_head (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE archive_head_fields (key TEXT PRIMARY KEY, ord INTEGER NOT NULL, kind INTEGER NOT NULL, value_json TEXT);
CREATE INDEX archive_head_fields_ord ON archive_head_fields (ord);
CREATE TABLE archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT NOT NULL);`)
  const put = db.prepare('INSERT INTO archive_head_fields VALUES (?,?,?,?)')
  const { messages, ...head } = chat
  let ord = 0
  for (const [key, value] of Object.entries(head)) put.run(key, ord++, 0, JSON.stringify(value))
  put.run('messages', ord++, 1, null)
  db.prepare('INSERT INTO archive_head VALUES (1,?,0)').run(chat._storageRevision)
  const putMsg = db.prepare('INSERT INTO archive_messages VALUES (?,?)')
  messages.forEach((message, index) => putMsg.run(index, JSON.stringify(message)))
  db.close()
}
