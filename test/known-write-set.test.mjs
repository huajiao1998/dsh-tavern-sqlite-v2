// 定向闸（本文件独占）：chat-sqlite-store 写路径的**已知写集证据**。
// 授权/边界：docs/workstreams/plugin/MVU-KNOWN-WRITESET-V2-PLAN-2026-10-05.md。
// 只验证patch/update最终证据、同库事务和失败隔离；不触真实档、不调用模型、不跑全量。
// diff/apply/copy直接用固定作者2.5模块；未使用的显示投影以脱离替身满足DI，不冒称页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
const A = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const { copyJsonTree } = await import(new URL(A + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(A + 'json-mutation.js', import.meta.url))
const probe = { calls: [], reset() { this.calls.length = 0 } }
/** 夹具 = 作者真身 helper（投影位本闸不测，明确用结构化脱离替身）。 */
const HELPERS = { copyJsonTree, applyJsonChangesShared,
  diffJson(previous, next) {                                  // 唯一口径：数「输入含 messages 的整档 diff」
    if (Array.isArray(previous?.messages)) probe.calls.push(Array.isArray(next?.messages) ? next.messages.length : 0)
    return diffJson(previous, next)
  } }
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused
for (const [n, f] of Object.entries(HELPERS)) assert.equal(typeof f, 'function', '作者 helper ' + n + ' 缺失：夹具无法对账')
// ---------- 真实 SQLite 侧证 ----------
const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-known-write-set-'))
const chatsRoot = path.join(root, 'chats')
mkdirSync(chatsRoot, { recursive: true })
const stores = [], sides = []
const openStore = () => { const s = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS }); stores.push(s); return s }
const sideDb = id => { const db = new DatabaseSync(path.join(chatsRoot, id, 'archive.db')); sides.push(db); return db }
const one = (db, q, ...a) => db.prepare(q).get(...a)
const json = v => (v === undefined ? undefined : JSON.parse(v))
const headOf = (db, k) => json(one(db, 'SELECT value_json FROM archive_head_fields WHERE key=?', k)?.value_json)
const rowAt = (db, i) => json(one(db, 'SELECT message_json FROM archive_messages WHERE message_index=?', i)?.message_json)
const rowCount = db => Number(one(db, 'SELECT COUNT(*) AS n FROM archive_messages').n)
const headRev = db => Number(one(db, 'SELECT revision FROM archive_head WHERE id=1').revision)
const snapCount = (db, from = 0) => Number(one(db, 'SELECT COUNT(*) AS n FROM variable_snapshots WHERE message_index >= ?', from).n)
const hasVars = (db, i) => Object.hasOwn(rowAt(db, i) ?? {}, 'variables')
const timelineJson = db => JSON.stringify(headOf(db, 'timeline'))
/** 夹具：0 greeting + 1..9 带树楼；assistant 的 o: { turn, trees, mvu }。 */
const tree = t => ({ stat_data: { 轮次: t }, schema: { type: 'object' } })
const greeting = () => ({ role: 'assistant', greeting: true, turn: 0, swipeId: 0, swipes: ['开场'], variables: [tree(0)], text: '开场' })
const assistant = (i, o = {}) => {
  const trees = o.trees ?? [tree(o.turn ?? i)], swipes = trees.map((_v, s) => 'text-' + i + '-' + s)
  const row = { role: 'assistant', turn: o.turn ?? i, swipeId: 0, swipes, variables: trees, text: swipes[0] }
  if (o.mvu !== undefined) row.mvu = o.mvu
  return row
}
const book = c => ({ version: 1, libraryDigest: 'fixture', source: { kind: 'card', cardPath: 'cards/synthetic.json' }, document: { entries: [{ uid: 0, content: c }] } })
const inlineBaseline = (id, c) => ({ version: 1, chatId: id, fields: { openingWorldbookSnapshot: book(c) }, messages: [], variables: {}, mvu: {}, tavernScriptPrompts: [] })
const EMPTY_TIMELINE = () => ({ schemaVersion: 1, branchId: 'main', revision: 0, operations: {}, checkpoints: [], participants: {} })
const bookTimeline = (id, c, t) => ({ ...EMPTY_TIMELINE(), revision: t, checkpoints: [{ id: 'cp' + t, turn: t, businessBefore: inlineBaseline(id, c) }],
  operations: { ['t' + t]: { kind: 'body', turn: t, status: 'completed', businessBefore: inlineBaseline(id, c) } } })
/** 每例统一播种：真实 store.update() 建库 + 直读 archive.db 侧证。 */
async function seed(store, id, extra = {}) {
  await store.update(id, () => ({ id, sessionId: 'session-' + id, _storageRevision: 1, mode: 'story', title: '已知写集闸',
    timeline: EMPTY_TIMELINE(), messages: [greeting(), ...Array.from({ length: 9 }, (_x, i) => assistant(i + 1))], ...extra }))
  const db = sideDb(id), chat = await store.read(id)
  return { db, rev: chat._storageRevision, chat }
}
test.after(() => {
  for (const db of sides) { try { db.close() } catch { /* 已关 */ } }
  for (const s of stores) { try { s.dispose() } catch { /* 已释放 */ } }
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('tavern-known-write-set-')) return
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
test('1 patch 新内联世界书 compact 后 root diff = 0；引用落库、1 楼 selected 正确', async () => {
  const store = openStore(), id = 'chat-k1'
  const { db, rev: r0 } = await seed(store, id)
  // 先建稳态引用档，使后续 compact 只做「新内联 → 引用」
  await store.update(id, c => { c.timeline = bookTimeline(id, '内联书-1', 1); c._storageRevision += 1; return c })
  assert.equal(headOf(db, 'timeline').operations.t1.businessBefore.worldbookRef.version, 1, 'bootstrap 后历史基准须为引用')
  probe.reset()
  const patched = await store.patch(id, r0 + 1, [
    { op: 'set', path: ['_storageRevision'], value: r0 + 2 },
    { op: 'set', path: ['messages', 8, 'text'], value: '第8楼改写' },
    { op: 'set', path: ['timeline'], value: bookTimeline(id, '新内联书-1', 2) }])
  assert.deepEqual(probe.calls, [], 'compact 后不得再对全档做 diff（root diff 必须为 0）')
  const t2 = headOf(db, 'timeline').operations.t2.businessBefore
  assert.equal(t2.worldbookRef.bookId > 0, true, 'compact 后 timeline 必须落成引用')
  assert.equal(Object.hasOwn(t2.fields, 'openingWorldbookSnapshot'), false, '正文不得进库')
  assert.equal(patched.timeline.operations.t2.businessBefore.worldbookRef.chatId, id, '引用须指向本档')
  assert.equal(rowAt(db, 8).text, '第8楼改写')
  assert.equal(rowAt(db, 4).text, 'text-4-0', '未声明楼不得被重写')
  assert.deepEqual((await store.readChangedIndices(id, r0 + 1)).indices, [8], 'dirty 只含被改的 8 楼')
  const slice = await store.readChangedSlice(id, r0 + 1, ['id', 'timeline.branchId'])
  assert.ok(slice.changedHeaderFields.includes('_storageRevision'), '证据须含 _storageRevision')
  assert.ok(slice.changedHeaderFields.includes('timeline'), '内部 timeline 转换必须进 changedHeaderFields')
  assert.equal(slice.chat.messages.length, 1, 'changedSlice 只带 dirty 楼')
  assert.equal((await store.read(id)).messages.filter(m => m.text === '第8楼改写').length, 1, '1 楼 selected 正确')
})
test('2 K4 非 businessTouched 精确新修剪 {6,7} + append {10,11} → [6,7,10,11]，不是旧 [1..7]', async () => {
  const store = openStore(), id = 'chat-k2'
  const { db, rev: r0 } = await seed(store, id)
  assert.equal(store.variables.stats(id).hot.limit, 4, '产品默认 hotWindow = 4（floor 0/greeting + 1..9）')
  const idx = (from, to) => Array.from({ length: to - from }, (_x, k) => from + k)
  const before = idx(0, 10).filter(i => hasVars(db, i))
  assert.deepEqual(before, [0, 6, 7, 8, 9], 'append 前：只有 greeting + 最新 4 棵带 variables')
  const appended = await store.patch(id, r0, [
    { op: 'set', path: ['_storageRevision'], value: r0 + 1 },
    { op: 'splice', path: ['messages'], index: 10, deleteCount: 0, items: [assistant(10), assistant(11)] }])
  assert.equal(appended.messages.length, 0, 'patch仅返回头部投影')
  assert.equal((await store.read(id)).messages.length, 12)
  const after = idx(0, 12).filter(i => hasVars(db, i))
  assert.deepEqual(after, [0, 8, 9, 10, 11], 'append 后：窗口推进，保留 greeting + 最新 4 棵')
  const newlyPruned = before.filter(i => !after.includes(i))
  assert.deepEqual(newlyPruned, [6, 7], '精确新修剪 = {6,7}（1..5 早已修剪，不算本次）')
  const changed = await store.readChangedIndices(id, r0)
  assert.deepEqual(changed.indices, [6, 7, 10, 11], '证据须为 [6,7,10,11]，不得扩成 [1..7] 旧已修剪集')
  assert.equal(changed.indices.includes(12), false, '不得扩成不存在的楼')
  assert.equal(newlyPruned.every(i => changed.indices.includes(i)), true, '修剪楼必须进入证据（调用方 changes 未声明它们）')
})
test('3 update 同一引用 callback：首次 root diff = 1 保存变化；optionalKey 先 seed 存在再 delete', async () => {
  const store = openStore(), id = 'chat-k3'
  const { db, rev: r0 } = await seed(store, id, { optionalKey: { seeded: true } })
  assert.equal(Object.hasOwn(await store.read(id), 'optionalKey'), true, 'optionalKey 必须先在种子里真实存在')
  probe.reset()
  // 同一引用就地改与删除：不得因引用相等而漏记变化
  const same = await store.update(id, c => {
    c.messages[3].text = '就地改写第3楼'; delete c.optionalKey
    c.timeline = bookTimeline(id, 'update内联书', 1)
    c._storageRevision = r0 + 1; return c
  })
  assert.deepEqual(probe.calls, [10], 'update 首次完整 diff 保留（输入全档 10 楼）')
  assert.equal(same.messages[3].text, '就地改写第3楼')
  const after = await store.read(id)
  assert.equal(after.messages[3].text, '就地改写第3楼', '就地修改必须落盘')
  assert.equal(Object.hasOwn(after, 'optionalKey'), false, '键消失必须落成 delete（先存在后删，不是空测试）')
  assert.equal(rowAt(db, 3).text, '就地改写第3楼')
  assert.equal(rowCount(db), 10, '普通就地改不改变楼数')
  assert.equal(rowAt(db, 5).text, 'text-5-0', '未变楼保持原值')
  assert.deepEqual((await store.readChangedIndices(id, r0)).indices, [3], 'dirty 精确到 3 楼')
  // undefined 规范：根拒绝 / 不存在键不新建 / 数组元素 → null
  await assert.rejects(() => store.patch(id, r0 + 1, [{ op: 'set', path: [], value: undefined }]), /root cannot be undefined/i, '根 set undefined 必须拒绝')
  const r1 = (await store.read(id))._storageRevision
  await store.patch(id, r1, [{ op: 'set', path: ['_storageRevision'], value: r1 + 1 },
    { op: 'set', path: ['newKey'], value: undefined }, { op: 'set', path: ['messages', 5, 'swipes', 0], value: undefined }])
  const after2 = await store.read(id)
  assert.equal(Object.hasOwn(after2, 'newKey'), false, '不存在的键 + undefined 不得新建')
  assert.equal(after2.messages[5].swipes[0], null, '数组元素 undefined 必须规范成 null')
  assert.equal(rowAt(db, 5).swipes[0], null, '规范结果须落库')
})
test('4 header-only 不写楼；messages receipt / runtimeInputs 叶子有据；layoutChanged = false', async () => {
  const store = openStore(), id = 'chat-k4'
  const { db, rev: r0 } = await seed(store, id, { runtimeInputs: { 2: { source: '原输入' }, 5: { source: '原输入5' } } })
  db.exec(`CREATE TABLE writes(kind TEXT);
    CREATE TRIGGER watch_msg AFTER UPDATE ON archive_messages BEGIN INSERT INTO writes VALUES('msg'); END;
    CREATE TRIGGER watch_head AFTER UPDATE ON archive_head_fields BEGIN INSERT INTO writes VALUES('head:'||NEW.key); END;`)
  db.prepare('INSERT INTO writes(kind) VALUES (?)').run('无关')
  await store.patch(id, r0, [{ op: 'set', path: ['_storageRevision'], value: r0 + 1 }, { op: 'set', path: ['title'], value: '只改标题' }])
  const kinds = db.prepare('SELECT kind FROM writes').all().map(r => r.kind)
  assert.deepEqual(kinds.filter(k => k === 'msg'), [], 'header-only patch 不得写任何楼层行')
  assert.ok(kinds.includes('head:title'), '标题行必须写')
  assert.ok(kinds.includes('head:_storageRevision'), 'revision 头必须写')
  assert.equal(kinds.filter(k => k === 'head:timeline').length, 0, '不得重写 timeline 头')
  assert.equal(rowCount(db), 10)
  const r1 = (await store.read(id))._storageRevision
  await store.patch(id, r1, [{ op: 'set', path: ['_storageRevision'], value: r1 + 1 },
    { op: 'set', path: ['messages', 6, 'mvu'], value: { receipt: { id: 'r1' } } },
    { op: 'set', path: ['runtimeInputs', '2', 'source'], value: '新输入' }, { op: 'delete', path: ['runtimeInputs', '5'] }])
  const slice = await store.readChangedSlice(id, r1, ['id', 'runtimeInputs'])
  assert.equal(slice.layoutChanged, false, '只改楼内字段不得被误判为布局变化')
  assert.equal(slice.chat.messages.length, 1, 'changedSlice 只带 dirty 楼')
  assert.deepEqual((await store.readChangedIndices(id, r1)).indices, [6], 'dirty 精确到 6 楼')
  const byKey = Object.fromEntries(slice.runtimeInputChanges.map(e => [e.key, e]))
  assert.deepEqual(Object.keys(byKey).sort(), ['2', '5'], '只报真正变化的 runtime 键')
  assert.equal(byKey['2'].present, true)
  assert.deepEqual(byKey['2'].value, { source: '新输入' })
  assert.equal(byKey['5'].present, false, '被删键以 present:false 表示，不静默消失')
  assert.deepEqual(rowAt(db, 6).mvu, { receipt: { id: 'r1' } }, 'receipt 须落库')
  assert.equal(rowAt(db, 7).text, 'text-7-0', '未变楼不动')
})
test('5 CAS / 空 changes / assertCurrent / missing parent 失败 = 零写；外借副本隔离', async () => {
  const store = openStore(), id = 'chat-k5'
  const { db, rev: r0 } = await seed(store, id)
  const snap = { rows: rowCount(db), rev: headRev(db), title: headOf(db, 'title') }
  const write2 = value => [{ op: 'set', path: ['_storageRevision'], value: r0 + 1 }, { op: 'set', path: ['messages', 2, 'text'], value }]
  await store.patch(id, r0, [])
  assert.equal(rowCount(db), snap.rows, '空 changes 不得写行')
  assert.equal(headRev(db), snap.rev, '空 changes 不得推进 revision')
  const cas = await store.patch(id, r0 + 5, [{ op: 'set', path: ['_storageRevision'], value: r0 + 6 }, { op: 'set', path: ['messages', 2, 'text'], value: '不该落库' }])
  assert.equal(cas, undefined, 'CAS 冲突必须回 undefined')
  assert.equal(rowAt(db, 2).text, 'text-2-0', 'CAS 冲突后楼层不得改变')
  await assert.rejects(() => store.patch(id, r0, write2('不该落库2'), { assertCurrent: () => { throw new Error('identity-changed') } }), /identity-changed/)
  assert.equal(rowAt(db, 2).text, 'text-2-0', 'assertCurrent 失败后楼层不得改变')
  assert.equal(headRev(db), snap.rev, '失败不得推进 revision')
  // 父路径缺失：走真身 applyJsonChangesShared 的 'Missing mutation parent'（宽正则，不锁措辞）
  await assert.rejects(() => store.patch(id, r0, [{ op: 'set', path: ['_storageRevision'], value: r0 + 1 },
    { op: 'set', path: ['noSuchParent', 'child'], value: 1 }]), /(Missing mutation parent|找不到路径|JSON mutation)/i, '父路径缺失必须响亮失败')
  assert.equal(headRev(db), snap.rev, '父路径失败不得推进 revision')
  const borrowed = await store.patch(id, r0, write2('本轮改写'))
  assert.equal(borrowed.messages.length, 0, 'patch 返回 messages 是空选择（不整档外借）')
  borrowed.title = '外借改标题'
  assert.equal(headOf(db, 'title'), snap.title, '外借头改动不得回写库')
  const readBorrowed = await store.read(id)
  readBorrowed.messages[5].text = '外借改动5'
  assert.equal(rowAt(db, 5).text, 'text-5-0', '读口副本改动不得回写库')
  assert.equal((await store.read(id)).messages[5].text, 'text-5-0', '读口也不得看到外借改动')
})
test('6 variableSnapshot trigger 失败：同事务回滚 head+message+book；去源后 retry 可成', async () => {
  const store = openStore(), id = 'chat-k6'
  const { db, rev: r0 } = await seed(store, id)
  const before = { rows: rowCount(db), rev: headRev(db), title: headOf(db, 'title'), timeline: timelineJson(db), snaps: snapCount(db) }
  db.exec(`CREATE TRIGGER fail_var BEFORE INSERT ON variable_snapshots
    WHEN NEW.turn = 4242 BEGIN SELECT RAISE(ABORT, 'synthetic-var-fault'); END`)
  const failing = [{ op: 'set', path: ['_storageRevision'], value: r0 + 1 },
    { op: 'set', path: ['title'], value: '不该落库的标题' },
    { op: 'set', path: ['timeline'], value: bookTimeline(id, '失败应回滚的新书', 1) },
    { op: 'set', path: ['messages', 9], value: assistant(9, { turn: 4242 }) }]
  await assert.rejects(() => store.patch(id, r0, failing), /synthetic-var-fault/)
  assert.equal(headOf(db, 'title'), before.title, '变量失败必须回滚已写的 chat 头')
  assert.equal(headRev(db), before.rev, '失败不得推进 revision')
  assert.equal(rowCount(db), before.rows, '失败不得落楼')
  assert.equal(rowAt(db, 9).text, 'text-9-0', '失败不得改写被声明楼')
  assert.equal(timelineJson(db), before.timeline, '失败必须回滚 timeline（book 头）')
  assert.equal(snapCount(db), before.snaps, '变量侧不得留半行')
  assert.equal(Number(one(db, 'SELECT COUNT(*) AS n FROM archive_worldbook_history').n), 0, '新历史书插入也须回滚')
  db.exec('DROP TRIGGER fail_var')
  const retried = await store.patch(id, r0, failing)
  assert.equal(retried._storageRevision, r0 + 1)
  assert.equal(headOf(db, 'title'), '不该落库的标题', 'retry 必须成功落库')
  assert.equal(headRev(db), before.rev + 1)
  assert.equal(rowAt(db, 9).turn, 4242)
})
test('7 纯尾部截断：snapshots >= cut 清零、状态回拨、changed indices 不越界', async () => {
  const store = openStore(), id = 'chat-k7'
  const { db, rev: r0 } = await seed(store, id)
  const cut = 6
  assert.ok(snapCount(db, cut) > 0, '夹具须先有 cut 之后的快照')
  await store.patch(id, r0, [
    { op: 'set', path: ['_storageRevision'], value: r0 + 1 },
    { op: 'splice', path: ['messages'], index: cut, deleteCount: 4, items: [] }])
  const chat = await store.read(id)
  assert.equal(chat.messages.length, cut, '纯尾截断后楼数 = cut')
  assert.equal(rowCount(db), cut, '尾部行必须物理删除（不留残留）')
  assert.equal(snapCount(db, cut), 0, 'cut 之后的快照必须清零')
  const changed = await store.readChangedIndices(id, r0)
  assert.ok(changed.indices.every(i => i >= 0 && i < chat.messages.length), 'changed indices 不得越界：' + JSON.stringify(changed.indices))
  assert.equal(changed.indices.includes(cut), false, '已截断的 index 不得出现在证据里')
  assert.equal(chat.messages.at(-1).text, 'text-5-0')
  assert.deepEqual(store.variables.snapshot(id), tree(5), '权威变量当前态必须回拨到幸存尾楼')
  assert.equal(await store.readSlice(id, [9]), undefined, '越界楼切片必须返回 undefined')
})
