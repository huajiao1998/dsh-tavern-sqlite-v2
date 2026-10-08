// S5 具名断言：楼层级数据库原生命令（追加 / 单楼 set）。
// 主负责的兼容对照：真 store 的 update()/patch() 走的是同一写路径，故本闸以「同种子、同 now()、
//   两库快照逐表逐行 deepEqual」为主判据（archive_head / head_fields / messages / variable_snapshots /
//   variable_state / timeline 子行），而不是只看返回值。
// 夹具：真 store（作者 2.5 copy-json-tree/json-mutation + 显示投影脱离替身）；命令的变量归档入口用
//   `createVariableArchive` 的同配置实例（`prepareLocalWrite`，与 store 同规则；store 未公开该面，
//   故测试自行构造同参数实例并显式注入——这正是主接线时要注入的同一函数）。
// 不读真实档/远端/禁令对象；合成数据；只清本文件自建的 mkdtemp。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { createVariableArchive } from '../lib/variable-archive.js'
import { appendMessages, setMessageFloor } from '../lib/chat-command-service.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
for (const [n, f] of Object.entries({ copyJsonTree, diffJson, applyJsonChangesShared })) {
  assert.equal(typeof f, 'function', '作者 helper ' + n + ' 缺失：夹具无法对账')
}
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused

const FIXED_NOW = 1_800_000_000_000   // 固定时钟：对照路径的 updated_at/created_at 必须逐字相同

// ---------- 夹具 ----------
const tree = turn => ({ stat_data: { 轮次: turn }, schema: { type: 'object' } })
const greeting = () => ({ role: 'assistant', greeting: true, turn: 0, swipeId: 0, swipes: ['开场'], variables: [tree(0)], text: '开场' })
const assistant = (index, extra = {}) => ({
  role: 'assistant', turn: index, swipeId: 0, swipes: ['text-' + index + '-0'], variables: [tree(index)], text: 'text-' + index + '-0', ...extra,
})
const EMPTY_TIMELINE = () => ({ schemaVersion: 1, branchId: 'main', revision: 0, operations: {}, checkpoints: [], participants: {} })
const chatOf = (id, extra = {}) => ({
  id, sessionId: 'session-' + id, _storageRevision: 1, updatedAt: 1, mode: 'story', title: '楼层命令闸',
  timeline: EMPTY_TIMELINE(),
  messages: [greeting(), ...Array.from({ length: 9 }, (_x, i) => assistant(i + 1))],
  ...extra,
})

const opened = []
test.after(() => {
  const roots = new Set()
  for (const entry of opened) {
    try { entry.store.dispose?.() } catch { /* 已释放 */ }
    // 同一 root 上的每个实例都要关（含同 root 二开的 store 与命令侧只读/可写句柄），否则 Windows 删目录 EPERM
    if (entry.side) { try { entry.side.close() } catch { /* 已关 */ } }
    roots.add(entry.root)
  }
  for (const root of roots) {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(root).startsWith('native-message-cmd-')) continue
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); break } catch { /* 句柄未释放时重试 */ }
    }
  }
})

/** 建真 store（固定时钟）。`id` 由调用方给：对照用例可让两个 store 用**同一个 chatId**（各自 root）。 */
function fixture(t, id) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-message-cmd-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS, now: () => FIXED_NOW })
  const entry = { root, id, store, side: null }
  opened.push(entry)
  t.after(() => { /* 统一在 test.after 清理（先 dispose/close 再删目录） */ })
  return entry
}

/** 在**同一个 root** 上另开一个 store 实例（等价于"重开档"）：直写命令绕过 store 后，旧实例的读缓存
 *  仍按旧 generation stamp 出借；换实例即从库重建基线，用来覆盖真出口（serialize/onCommitted/失效链）。 */
function openStoreOn(entry) {
  const store = createChatSqliteStore({ dataRoot: entry.root, legacyData: undefined, helpers: HELPERS, now: () => FIXED_NOW })
  const extra = { root: entry.root, id: entry.id, store, side: null }
  opened.push(extra)
  return store
}

async function seed(entry, extra = {}) {
  await entry.store.update(entry.id, () => chatOf(entry.id, extra))
  const chat = await entry.store.read(entry.id)
  return { rev: chat._storageRevision }
}

/** 命令用的可写句柄：与 store 同库文件（命令自带 BEGIN IMMEDIATE，故句柄可由调用方给）。 */
function openSide(entry) {
  if (entry.side === null) entry.side = new DatabaseSync(entry.store.rollbackArchivePath(entry.id))
  return entry.side
}

/** 变量归档局部入口（同配置实例；主接线时由 store 注入同一函数）。 */
function archiveLocalWriteFor(entry) {
  const archive = createVariableArchive({
    logger: { log() {}, warn() {} },
    now: () => FIXED_NOW,
    handle: (chatId, options) => (String(chatId) === String(entry.id) ? openSide(entry) : entry.store.variables.handle?.(chatId, options)),
    isEligibleRow: () => false,
  })
  return (db, chatId, touchedRows, messageCount, options) => archive.prepareLocalWrite(db, chatId, touchedRows, messageCount, options)
}

function commandGuards(entry, extra = {}) {
  return {
    now: () => FIXED_NOW,
    archiveLocalWrite: archiveLocalWriteFor(entry),
    headerSets: extra.headerSets,
    ...extra,
  }
}

/** 库快照（逐表逐行；timeline 从子行组装，与既有已知写集闸同式）。 */
function dbSnapshot(db) {
  const q = (sql, ...args) => db.prepare(sql).all(...args)
  const one = (sql, ...args) => db.prepare(sql).get(...args)
  const timeline = { meta: null, checkpoints: [], operations: {} }
  const nodes = q('SELECT node_key, ord, value_json FROM archive_timeline_nodes ORDER BY ord, node_key')
  for (const row of nodes) {
    const value = JSON.parse(row.value_json)
    if (row.node_key === '@meta') timeline.meta = value
    else if (row.node_key.startsWith('checkpoints#')) timeline.checkpoints[Number(row.ord)] = value
    else timeline.operations[row.node_key.slice(11)] = value
  }
  return {
    head: { revision: Number(one('SELECT revision FROM archive_head WHERE id=1').revision), updated_at: Number(one('SELECT updated_at FROM archive_head WHERE id=1').updated_at) },
    headFields: q('SELECT key, ord, kind, value_json FROM archive_head_fields ORDER BY ord'),
    messages: q('SELECT message_index, message_json FROM archive_messages ORDER BY message_index'),
    snapshots: q('SELECT message_index, swipe_id, turn, slot_count, selected, source, mvu_ready, tree_json FROM variable_snapshots ORDER BY message_index, swipe_id'),
    state: one('SELECT turn, message_index, swipe_id, tree_json FROM variable_state WHERE id=1') ?? null,
    timeline,
  }
}
const rowJson = (db, index) => {
  const row = db.prepare('SELECT message_json FROM archive_messages WHERE message_index=?').get(index)
  return row === undefined ? undefined : JSON.parse(row.message_json)
}
const headRev = db => Number(db.prepare('SELECT revision FROM archive_head WHERE id=1').get().revision)
const rowCount = db => Number(db.prepare('SELECT COUNT(*) AS n FROM archive_messages').get().n)
const snapCount = (db, from = 0) => Number(db.prepare('SELECT COUNT(*) AS n FROM variable_snapshots WHERE message_index >= ?').get(from).n)

/** 分区对照：逐区 deepEqual（失败时报出是哪一区、哪一行，便于定位而不是只有 false !== true）。 */
function assertSnapshotsEqual(a, b, label) {
  for (const key of ['head', 'headFields', 'messages', 'snapshots', 'state', 'timeline']) {
    if (isDeepStrictEqual(a[key], b[key])) continue
    assert.deepEqual(a[key], b[key], label + '：分区 ' + key + ' 必须 deepEqual')
  }
}


test('追加命令与patch追加双跑等价且增量证据一致', async t => {
  // 两 store 用**同一个 chatId**（各在自有 root 里）：快照才能逐字对照，不受 id/sessionId 噪声干扰
  const A = fixture(t, 'cmd-append')
  const B = fixture(t, 'cmd-append')
  const idA = A.id, idB = B.id
  assert.equal(idA, idB, '对照夹具必须同 chatId')
  const seedExtra = { runtimeInputs: { 2: { source: '原输入' } } }
  const seedA = await seed(A, seedExtra)
  const seedB = await seed(B, seedExtra)
  assert.equal(seedA.rev, 1)
  assert.equal(seedB.rev, 1)
  const items = [assistant(10), assistant(11)]
  // A：新命令
  const headSets = { title: '追加后的标题', runtimeInputs: { 2: { source: '新输入' } } }
  const result = appendMessages(openSide(A), { chatId: idA, sessionId: 'session-' + idA, revision: seedA.rev, items, headerSets: headSets }, commandGuards(A))
  assert.notEqual(result, undefined, '同 revision ⇒ 必须命中')
  assert.equal(result.changed, true)
  assert.equal(result.revision, seedA.rev + 1)
  assert.equal(result.messageCount, 12)
  assert.equal(result.updatedAt, FIXED_NOW)
  assert.equal(result.head._storageRevision, seedA.rev + 1, '返回头必须带新 _storageRevision')
  assert.equal(Object.keys(result.head.messages ?? {}).length, 0, '返回头不得外借整档 messages（与 patch 同：空选择）')
  assert.equal(result.head.title, '追加后的标题', '头 sets 必须反映在返回头里')
  // B：既有 patch 等价路径（同种子、同 now）
  await B.store.patch(idB, seedB.rev, [
    { op: 'set', path: ['_storageRevision'], value: seedB.rev + 1 },
    { op: 'set', path: ['title'], value: '追加后的标题' },
    { op: 'set', path: ['runtimeInputs', '2', 'source'], value: '新输入' },
    { op: 'splice', path: ['messages'], index: 10, deleteCount: 0, items },
  ])
  const snapA = dbSnapshot(openSide(A))
  const snapB = dbSnapshot(openSide(B))
  assertSnapshotsEqual(snapA, snapB, '追加命令 vs patch')
  assert.equal(snapA.messages.length, 12)
  assert.equal(rowJson(openSide(A), 10).text, 'text-10-0')
  assert.equal(snapA.head.revision, 2)
  // 增量证据：patch 侧 readChangedIndices 应只含新楼
  const changed = await B.store.readChangedIndices(idB, seedB.rev)
  assert.deepEqual(changed.indices.filter(i => i >= 10), [10, 11], '追加楼必须进 dirty 证据')
})

test('追加命令内部K4修剪楼进written与dirty证据不扩成旧已修剪集', async t => {
  const A = fixture(t, 'cmd-append-k4')
  const B = fixture(t, 'cmd-append-k4')
  await seed(A)
  await seed(B)
  const dbA = openSide(A)
  const dbB = openSide(B)
  const hasVars = db => Array.from({ length: rowCount(db) }, (_x, i) => i).filter(i => Object.hasOwn(rowJson(db, i) ?? {}, 'variables'))
  const before = hasVars(dbA)
  assert.deepEqual(before, [0, 6, 7, 8, 9], '播种后（hotWindow=4）只有 greeting + 最新 4 棵带 variables')
  const items = [assistant(10), assistant(11)]
  const seen = []
  appendMessages(dbA, { chatId: A.id, sessionId: 'session-' + A.id, revision: 1, items }, commandGuards(A, { applyMessageWrite: payload => seen.push(payload) }))
  assert.equal(seen.length, 1, '命令必须给出提交载荷')
  await B.store.patch(B.id, 1, [
    { op: 'set', path: ['_storageRevision'], value: 2 },
    { op: 'splice', path: ['messages'], index: 10, deleteCount: 0, items },
  ])
  const after = hasVars(dbA)
  assert.deepEqual(after, [0, 8, 9, 10, 11], '窗口推进：保留 greeting + 最新 4 棵')
  const newlyPruned = before.filter(i => !after.includes(i))
  assert.deepEqual(newlyPruned, [6, 7], '精确新修剪集必须是 {6,7}')
  // 命令的 written 证据（钩子载荷）必须含修剪楼——命令不经过 store 写缓存，故用载荷而非 store 的 dirty 读口
  assert.equal(newlyPruned.every(i => seen[0].written.includes(i)), true, '修剪楼必须在命令 written 里（调用方未声明它们）')
  assert.equal(seen[0].written.includes(12), false, 'written 不得扩成不存在的楼')
  assert.deepEqual(seen[0].written.filter(i => i >= 10), [10, 11], 'written 必须含本次追加楼')
  assertSnapshotsEqual(dbSnapshot(dbA), dbSnapshot(dbB), 'K4 修剪形态 vs patch')
})

test('单楼set命令与patch叶子双跑等价且只返回头部投影', async t => {
  const A = fixture(t, 'cmd-floor')
  const B = fixture(t, 'cmd-floor')
  await seed(A)
  await seed(B)
  const singleSeen = []
  const result = setMessageFloor(openSide(A), { chatId: A.id, sessionId: 'session-' + A.id, revision: 1, index: 3, patch: { text: '改写第3楼', mvu: { receipt: { id: 'r1' } } } }, commandGuards(A, { applyMessageWrite: payload => singleSeen.push(payload) }))
  assert.equal(singleSeen.length, 1, '单楼命令必须给出提交载荷')
  assert.notEqual(result, undefined)
  assert.equal(result.revision, 2)
  assert.equal(result.messageCount, 10)
  assert.equal(Object.keys(result.head.messages ?? {}).length, 0, '返回头只带头字段（messages 空选择）')
  await B.store.patch(B.id, 1, [
    { op: 'set', path: ['_storageRevision'], value: 2 },
    { op: 'set', path: ['messages', 3, 'text'], value: '改写第3楼' },
    { op: 'set', path: ['messages', 3, 'mvu'], value: { receipt: { id: 'r1' } } },
  ])
  const dbA = openSide(A), dbB = openSide(B)
  assert.equal(rowJson(dbA, 3).text, '改写第3楼')
  assert.deepEqual(rowJson(dbA, 3).mvu, { receipt: { id: 'r1' } })
  assert.equal(rowJson(dbA, 4).text, 'text-4-0', '未声明楼不得被重写')
  assert.deepEqual(singleSeen[0].changes, [
    { op: 'set', path: ['_storageRevision'], value: 2 },
    { op: 'set', path: ['messages', 3, 'text'], value: '改写第3楼' },
    { op: 'set', path: ['messages', 3, 'mvu'], value: { receipt: { id: 'r1' } } },
  ], '命令增量证据必须精确到 3 楼且只有声明的叶子 + revision 头（命令不写 store 缓存，故用载荷而不是读口）')
  assertSnapshotsEqual(dbSnapshot(dbA), dbSnapshot(dbB), '单楼 set vs patch 叶子')
  // 外借隔离：改返回头不得回写库
  result.head.title = '外借改标题'
  assert.notEqual(rowJson(dbA, 3).text, '外借改标题')
  const snapshot = dbSnapshot(dbA)
  assert.equal(snapshot.headFields.find(f => f.key === 'title').value_json, JSON.stringify('楼层命令闸'), '外借头改动不得回写')
})

test('单楼set命令保留missing parent与undefined规范与splice语义', async t => {
  const A = fixture(t, 'cmd-floor-leaf')
  await seed(A, { optionalKey: { seeded: true }, runtimeInputs: { 5: { source: '原输入5' } } })
  const db = openSide(A)
  // missing parent 的真实触发条件：**行内父容器不是对象**（标量）。新键/新中间键按作者 apply 语义整值新建。
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 1, index: 3, patch: { turn: { deep: 1 } } }, commandGuards(A)),
    /缺失父路径|Missing mutation parent/, '行内父容器是标量时必须响亮失败')
  assert.equal(headRev(db), 1, '失败不得推进 revision')
  // 新中间键 → 整值新建（不报缺失父路径）
  const created = setMessageFloor(db, { chatId: A.id, revision: 1, index: 3, patch: { mvu: { missingMid: { child: 1 } } } }, commandGuards(A))
  assert.notEqual(created, undefined, '新中间键必须整值新建，不报缺失父路径')
  assert.deepEqual(rowJson(db, 3).mvu, { missingMid: { child: 1 } }, '新键整值落库')
  // 对照：作者叶子 apply 对"缺失中间键"并不报错（走整值/无变化），故这里不断言对照侧抛错；
  // 命令侧的"缺失父路径"只在行内父容器不是对象时出现（上一处已断言）。
  // 头 sets：不存在的键 + undefined 不新建；存在键 delete；数组元素 undefined → null
  const payloads = []
  const result = setMessageFloor(db, { chatId: A.id, revision: 2, index: 5, patch: { swipes: [undefined, '第二槽'] } },
    commandGuards(A, { headerSets: { newKey: undefined, optionalKey: undefined, runtimeInputs: { 5: { source: '新输入5' } } }, applyMessageWrite: payload => payloads.push(payload) }))
  assert.equal(payloads.length, 1, '单楼命令必须给出提交载荷')
  assert.notEqual(result, undefined)
  const row = rowJson(db, 5)
  assert.equal(row.swipes[0], null, '数组元素 undefined 必须规范成 null（同 patch:735）')
  assert.equal(row.swipes[1], '第二槽')
  const fields = db.prepare('SELECT key FROM archive_head_fields ORDER BY ord').all().map(r => r.key)
  assert.equal(fields.includes('newKey'), false, '不存在的键 + undefined 不得新建')
  assert.equal(fields.includes('optionalKey'), false, '存在键 + undefined 必须落 delete')
  assert.equal(headRev(db), 3, '成功路径推进 1 次')
  // 根与保留键：拒绝
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 3, index: 5, patch: { text: 'x' } }, commandGuards(A, { headerSets: { _storageRevision: 99 } })),
    /不得由调用方给 _storageRevision/, '保留头键必须拒绝')
})

test('追加与单楼set的CAS竞争失败返回undefined且零写', async t => {
  const A = fixture(t, 'cmd-cas')
  await seed(A)
  const db = openSide(A)
  const before = dbSnapshot(db)
  assert.equal(appendMessages(db, { chatId: A.id, revision: 0, items: [assistant(10)] }, commandGuards(A)), undefined, '追加 CAS 不符 ⇒ undefined（不抛）')
  assert.equal(setMessageFloor(db, { chatId: A.id, revision: 5, index: 3, patch: { text: '不该落库' } }, commandGuards(A)), undefined, '单楼 set CAS 不符 ⇒ undefined')
  assert.equal(isDeepStrictEqual(dbSnapshot(db), before), true, 'CAS 不符必须零写（逐表逐行不变）')
  assert.equal(rowJson(db, 3).text, 'text-3-0')
})

test('追加与单楼set在变量归档失败时整笔回滚', async t => {
  const A = fixture(t, 'cmd-rollback')
  await seed(A)
  const db = openSide(A)
  const before = dbSnapshot(db)
  db.exec(`CREATE TRIGGER fail_var BEFORE INSERT ON variable_snapshots
    WHEN NEW.turn = 4242 BEGIN SELECT RAISE(ABORT, 'synthetic-var-fault'); END`)
  assert.throws(() => appendMessages(db, {
    chatId: A.id, revision: 1, headerSets: { title: '不该落库' },
    items: [assistant(10, { turn: 4242 })],
  }, commandGuards(A)), /synthetic-var-fault/, '变量归档失败必须整笔抛')
  db.exec('DROP TRIGGER fail_var')
  assert.equal(isDeepStrictEqual(dbSnapshot(db), before), true, '失败后库必须逐表逐行回到原状（head/楼/头/快照/state）')
})

test('追加命令在批内重复index与负索引与空洞楼时响亮失败不落半行', async t => {
  const A = fixture(t, 'cmd-bad-items')
  await seed(A)
  const db = openSide(A)
  const before = dbSnapshot(db)
  assert.throws(() => appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10), undefined] }, commandGuards(A)),
    /不是普通对象/, '空洞楼必须响亮失败')
  assert.throws(() => appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10, { turn: 1.5 })] }, commandGuards(A)),
    /turn 不是安全整数/, 'turn 非安全整数必须失败')
  assert.throws(() => appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10, { swipeId: 3 })] }, commandGuards(A)),
    /swipeId 越界/, 'swipeId 越界必须失败')
  assert.throws(() => appendMessages(db, { chatId: A.id, revision: 1, items: [] }, commandGuards(A)),
    /items 必须是非空数组/, '空批次必须失败')
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 1, index: 10, patch: { text: '越界楼' } }, commandGuards(A)),
    /楼层越界/, '单楼 set 越界必须失败（整楼替换走追加命令）')
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 1, index: 3, patch: { turn: { deep: 1 } } }, commandGuards(A)),
    /缺失父路径/, '行内父容器是标量（真缺父）时必须失败')
  assert.equal(isDeepStrictEqual(dbSnapshot(db), before), true, '全部失败路径必须零写')
})

test('单楼set命令对swipe数组越界与变量槽非JSON树时fail-closed保留真值', async t => {
  const A = fixture(t, 'cmd-fail-closed')
  await seed(A)
  const db = openSide(A)
  const before = dbSnapshot(db)
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 1, index: 3, patch: { variables: ['不是树'] } }, commandGuards(A)),
    /variables\[0\] 不是 JSON 树/, '变量槽非 JSON 树必须响亮失败')
  // 注：函数值不是"不可序列化"（JSON.stringify 丢键得 {}），故用真正不可序列化的 BigInt
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 1, index: 3, patch: { variables: [{ bad: 10n }] } }, commandGuards(A)),
    /不是可序列化 JSON 树/, 'BigInt（不可序列化）必须响亮失败')
  assert.equal(isDeepStrictEqual(dbSnapshot(db), before), true, 'fail-closed 路径必须零写（保留原真值）')
  assert.equal(snapCount(db), snapCount(db, 0), '快照行数不得变化')
})

test('两条命令对legacy原件档与未知形状显式拒绝', async t => {
  const A = fixture(t, 'cmd-legacy')
  await seed(A)
  const db = openSide(A)
  // 造 legacy：写一条前台完成的 body 操作（timeline 子行）
  db.exec("INSERT INTO archive_timeline_nodes (node_key, ord, value_json) VALUES ('operations:legacy-op', -1, '{\"id\":\"legacy-op\",\"kind\":\"body\",\"status\":\"foreground-completed\"}')")
  const before = dbSnapshot(db)
  assert.throws(() => appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10)] }, commandGuards(A)),
    /legacy 形状|前台完成的 body/, 'legacy 档追加必须拒绝')
  assert.throws(() => setMessageFloor(db, { chatId: A.id, revision: 1, index: 3, patch: { text: 'x' } }, commandGuards(A)),
    /legacy 形状|前台完成的 body/, 'legacy 档单楼 set 必须拒绝')
  assert.equal(isDeepStrictEqual(dbSnapshot(db), before), true, '拒绝路径零写')
  // 未知 mode / 身份不符 / 缺注入
  assert.throws(() => appendMessages(db, { chatId: A.id, sessionId: 'other-session', revision: 1, items: [assistant(10)] }, commandGuards(A)),
    /sessionId 不匹配/, '身份不符必须拒绝')
  assert.throws(() => appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10)] }, { now: () => FIXED_NOW }),
    /缺少注入的 archiveLocalWrite/, '缺变量归档注入必须响亮失败')
})

test('两条命令失败与成功路径都不外借整档且返回头是副本', async t => {
  const A = fixture(t, 'cmd-borrow')
  await seed(A)
  const db = openSide(A)
  const appended = appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10)] }, commandGuards(A))
  assert.notEqual(appended, undefined)
  const floorBefore = dbSnapshot(db)
  appended.head.title = '外借改标题-追加'
  assert.equal(db.prepare("SELECT value_json FROM archive_head_fields WHERE key='title'").get().value_json, JSON.stringify('楼层命令闸'), '追加返回头是副本，改动不得回写')
  const single = setMessageFloor(db, { chatId: A.id, revision: 2, index: 4, patch: { text: '单楼改写' } }, commandGuards(A))
  assert.notEqual(single, undefined)
  single.head.mode = '外借改mode'
  assert.equal(db.prepare("SELECT value_json FROM archive_head_fields WHERE key='mode'").get().value_json, JSON.stringify('story'), '单楼返回头是副本，改动不得回写')
  assert.equal(Object.keys(single.head.messages ?? {}).length, 0, '返回头 messages 必须是空选择（不整档外借）')
  assert.equal(rowJson(db, 4).text, '单楼改写')
  assert.equal(headRev(db), 3)
  assert.notEqual(isDeepStrictEqual(dbSnapshot(db), floorBefore), true, '成功路径必须真的改了库（并非常量返回）')
})

test('两条命令提交后窄缓存按实际键与楼失效而全文缓存保守退场', async t => {
  const A = fixture(t, 'cmd-cache')
  await seed(A)
  const seen = []
  const guards = commandGuards(A, { applyMessageWrite: payload => seen.push(payload) })
  const db = openSide(A)
  appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10)], headerSets: { title: '缓存钩子标题' } }, guards)
  assert.equal(seen.length, 1, '成功提交必须调用一次提交完成钩子')
  assert.deepEqual(seen[0].keys, ['title', '_storageRevision'], 'keys 必须含实际改动的头键（含命令自己推进的 revision 头）')
  assert.equal(seen[0].messages, true, 'messages 必须标为变化（有新楼）')
  assert.equal(seen[0].timeline, false, '命令不碰 timeline，必须报 false（不得伪造变化）')
  assert.deepEqual(seen[0].changes.at(-1), { op: 'splice', path: ['messages'], index: 10, deleteCount: 0, items: 1 },
    '增量证据必须是纯尾 splice')
  const singleSeen = []
  setMessageFloor(db, { chatId: A.id, revision: 2, index: 3, patch: { text: '缓存钩子单楼' } }, commandGuards(A, { applyMessageWrite: payload => singleSeen.push(payload) }))
  assert.equal(singleSeen.length, 1)
  assert.deepEqual(singleSeen[0].keys, ['_storageRevision'], '单楼只改楼 ⇒ 头键只有命令推进的 revision 头')
  assert.deepEqual(singleSeen[0].changes, [
    { op: 'set', path: ['_storageRevision'], value: 3 },
    { op: 'set', path: ['messages', 3, 'text'], value: '缓存钩子单楼' },
  ], '叶子证据必须带绝对楼号 + revision 头')
  // 库事实已由 dbSnapshot 侧证覆盖（命令自带事务、不依赖 store）。
  // 真提交完成链路（serialize/onCommitted/bumpGeneration/invalidate/forgetState）走 **store 真出口**。
  // 直写命令绕过 store ⇒ 旧实例的读缓存仍按旧 generation stamp 出借（这是缓存语义，不是缺陷），
  // 故另开一个 store 实例（等价于"重开档"）来覆盖出口与读口：它会从库重建基线。
  const store = openStoreOn(A)
  const baseline = await store.read(A.id)
  assert.equal(baseline.messages.length, 11, '换实例后读口必须看到直写命令产生的 11 楼')
  assert.equal(baseline.title, '缓存钩子标题')
  assert.equal(baseline._storageRevision, headRev(db), '重建基线的 revision 必须等于库内 head')
  const baseRev = baseline._storageRevision
  const countBefore = rowCount(db)
  assert.equal(baseline.messages.length, countBefore, '重建基线的楼数必须等于库内行数')
  const storeAppended = await store.appendMessages(A.id, baseRev, { items: [assistant(11)], headerSets: { title: '真出口标题' } }, { sessionId: 'session-' + A.id })
  assert.notEqual(storeAppended, undefined, 'store 出口必须命中（同 revision）')
  assert.equal(storeAppended.revision, baseRev + 1)
  assert.equal(storeAppended.messageCount, countBefore + 1)
  const viaStore = await store.read(A.id)
  assert.equal(viaStore.title, '真出口标题', 'store 出口提交后读口必须看到新头（真链路的 invalidate/forgetState 生效）')
  assert.equal(viaStore.messages.length, countBefore + 1, 'store 出口提交后读口必须看到新楼')
  assert.equal(viaStore.messages.at(-1).text, 'text-11-0')
  assert.equal(rowCount(db), countBefore + 1, 'store 出口必须真的落一行')
  const storeFloored = await store.setMessageFloor(A.id, baseRev + 1, 2, { changes: [{ op: 'set', path: ['messages', 2, 'text'], value: '真出口单楼' }] }, { sessionId: 'session-' + A.id })
  assert.notEqual(storeFloored, undefined, 'store 单楼出口必须命中')
  assert.equal(storeFloored.revision, baseRev + 2)
  const viaStore2 = await store.read(A.id)
  assert.equal(viaStore2.messages[2].text, '真出口单楼', 'store 单楼出口提交后读口必须看到新叶子')
  assert.equal(headRev(db), baseRev + 2, 'store 出口同样推进库内 revision')
  const arrayLeaf = await store.setMessageFloor(A.id, baseRev + 2, 2, {
    changes: [{ op: 'set', path: ['messages', 2, 'swipes', 0], value: '数组下标叶子' }],
  }, { sessionId: 'session-' + A.id })
  assert.notEqual(arrayLeaf, undefined, '数组下标叶子必须能进单楼命令')
  assert.equal((await store.read(A.id)).messages[2].swipes[0], '数组下标叶子')
  await assert.rejects(() => store.setMessageFloor(A.id, baseRev + 3, 2, {
    changes: [{ op: 'splice', path: ['messages', 2, 'swipes'], index: 1, deleteCount: 0, items: ['新增槽'] }],
  }, { sessionId: 'session-' + A.id }), /不接受数组 splice/, '数组长度变化必须响亮拒绝，不能静默丢掉')
  assert.equal((await store.read(A.id)).messages[2].swipes.length, 1, '被拒绝的 splice 不得改库')
})

test('单楼set纯尾截断与追加纯尾写入的物理行与变量快照同步', async t => {
  const A = fixture(t, 'cmd-tail')
  await seed(A)
  const db = openSide(A)
  // 追加（纯尾）：行数 +1，快照随 touched 楼新增，越界无残留
  appendMessages(db, { chatId: A.id, revision: 1, items: [assistant(10)] }, commandGuards(A))
  assert.equal(rowCount(db), 11)
  assert.equal(snapCount(db, 11), 0, '超出尾部不得有快照行')
  // 单楼 set 到尾部楼：行内容改写但行数不变
  const before = rowCount(db)
  setMessageFloor(db, { chatId: A.id, revision: 2, index: 10, patch: { text: '尾部楼改写' } }, commandGuards(A))
  assert.equal(rowCount(db), before, '单楼 set 不得改变行数')
  assert.equal(rowJson(db, 10).text, '尾部楼改写')
  assert.equal(headRev(db), 3)
  // 对照：patch 的纯尾截断仍是唯一截断入口（命令不提供截断）
  const cut = 8
  // 命令自带事务、绕过 store，故 store 缓存此时是旧的（这正是"窄命令必须由 onCommitted 失效"的证据）；
  // 这里不断言 store 读口，而是直接用库事实做截断对照（store 侧读口由本文件末尾的真出口段覆盖）。
  const rowsBeforeCut = rowCount(db)
  assert.equal(rowsBeforeCut, 11, '命令追加后库内物理行＝11')
  // 直写命令绕过 store ⇒ 另开实例（等价重开档）覆盖真出口与读口
  const store = openStoreOn(A)
  const baseline = await store.read(A.id)
  assert.equal(baseline.messages.length, 11, '换实例后读口必须看到直写命令产生的 11 楼')
  await store.patch(A.id, baseline._storageRevision, [{ op: 'set', path: ['_storageRevision'], value: baseline._storageRevision + 1 }, { op: 'splice', path: ['messages'], index: cut, deleteCount: 3, items: [] }])
  assert.equal(rowCount(db), cut, '截断后物理行 = cut')
  assert.equal(snapCount(db, cut), 0, '截断点之后的快照必须清零')
  // 真出口：store 的 appendMessages 再追加一楼，并在同一条链上验证读口/行数/快照
  const tailAppend = await store.appendMessages(A.id, baseline._storageRevision + 1, { items: [assistant(8)] }, { sessionId: 'session-' + A.id })
  assert.notEqual(tailAppend, undefined, 'store 追加出口必须命中')
  assert.equal(tailAppend.revision, baseline._storageRevision + 2)
  assert.equal(rowCount(db), cut + 1, '真出口追加后物理行 +1')
  const tailRead = await store.read(A.id)
  assert.equal(tailRead.messages.length, cut + 1, 'store 读口必须看到真出口写入的尾楼')
  assert.equal(tailRead.messages.at(-1).text, 'text-8-0')
  assert.equal(snapCount(db, cut + 1), 0, '尾部之外仍不得有快照行')
})

test('D-3旧写口仅追加检查点，S5维持原策略且原地写截断和CAS失败不触发', async t => {
  const A = fixture(t, 'cmd-checkpoint')
  await seed(A)
  const store = A.store, db = openSide(A)
  const prepare = DatabaseSync.prototype.prepare, checkpoints = []
  // 仅观察真实 SQL，所有语句仍由真实 SQLite 执行；不靠会主动checkpoint的PRAGMA探针推断。
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (/^PRAGMA wal_checkpoint/.test(sql)) checkpoints.push(sql)
    return prepare.call(this, sql, ...args)
  }
  try {
    let revision = headRev(db)
    const patch = changes => store.patch(A.id, revision, [{ op: 'set', path: ['_storageRevision'], value: ++revision }, ...changes])
    await patch([{ op: 'set', path: ['messages', 2, 'text'], value: 'patch单楼' }])
    await store.update(A.id, chat => { chat.messages[3].text = 'update单楼'; chat._storageRevision = ++revision; return chat })
    await patch([{ op: 'set', path: ['title'], value: '只改头' }])
    assert.equal(checkpoints.length, 0, 'patch/update原地写和头写不额外检查点')
    await patch([{ op: 'splice', path: ['messages'], index: 10, deleteCount: 0, items: [assistant(10)] }])
    assert.deepEqual(checkpoints, ['PRAGMA wal_checkpoint(TRUNCATE)'], 'patch追加一次真实检查点')
    await store.update(A.id, chat => { chat.messages.push(assistant(11)); chat._storageRevision = ++revision; return chat })
    assert.equal(checkpoints.length, 2, 'update追加同样检查点')
    const appended = await store.appendMessages(A.id, revision, { items: [assistant(12)] }, { sessionId: 'session-' + A.id })
    revision = appended.revision
    assert.equal(checkpoints.length, 2, 'S5追加保持原策略，不新增TRUNCATE')
    const floored = await store.setMessageFloor(A.id, revision, 2, { changes: [{ op: 'set', path: ['messages', 2, 'text'], value: 'S5单楼' }] }, { sessionId: 'session-' + A.id })
    revision = floored.revision
    assert.equal(checkpoints.length, 2, 'S5单楼仍不检查点')
    assert.equal(await store.appendMessages(A.id, revision - 1, { items: [assistant(13)] }), undefined)
    assert.equal(checkpoints.length, 2, 'CAS失败不得检查点')
    await patch([{ op: 'splice', path: ['messages'], index: 10, deleteCount: 3, items: [] }])
    assert.equal(checkpoints.length, 2, '纯尾截断不额外检查点')
    assert.equal(rowCount(db), 10)
    assert.equal(snapCount(db, 10), 0, '截断仍物理清除越界变量快照')
    // 未检查点的提交仍可由另一真实SQLite连接读到，主库+WAL是同一个权威数据库。
    const cold = openStoreOn(A)
    assert.equal((await cold.read(A.id)).messages[2].text, 'S5单楼')
    assert.equal(headRev(db), revision)
  } finally { DatabaseSync.prototype.prepare = prepare }
})

test('D-3追加检查点busy退PASSIVE且检查点异常不掩盖已提交楼', async t => {
  const A = fixture(t, 'cmd-checkpoint-busy')
  await seed(A)
  const db = openSide(A), prepare = DatabaseSync.prototype.prepare, checkpoints = []
  // 真实读事务钉住旧快照，使写连接TRUNCATE返回busy；不是伪造业务库。
  db.exec('BEGIN')
  db.prepare('SELECT revision FROM archive_head').get()
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (/^PRAGMA wal_checkpoint/.test(sql)) checkpoints.push(sql)
    return prepare.call(this, sql, ...args)
  }
  try {
    const outcome = await A.store.patch(A.id, 1, [
      { op: 'set', path: ['_storageRevision'], value: 2 },
      { op: 'splice', path: ['messages'], index: 10, deleteCount: 0, items: [assistant(10)] },
    ])
    assert.equal(outcome._storageRevision, 2)
    assert.deepEqual(checkpoints, ['PRAGMA wal_checkpoint(TRUNCATE)', 'PRAGMA wal_checkpoint(PASSIVE)'])
    db.exec('ROLLBACK')
    assert.equal(rowCount(db), 11)
    // 只注入检查点I/O错误，不替换业务SQL；追加事务/持久化/失效链继续真实执行。
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      if (/^PRAGMA wal_checkpoint/.test(sql)) throw Error('合成检查点I/O失败')
      return prepare.call(this, sql, ...args)
    }
    const next = await A.store.patch(A.id, 2, [
      { op: 'set', path: ['_storageRevision'], value: 3 },
      { op: 'splice', path: ['messages'], index: 11, deleteCount: 0, items: [assistant(11)] },
    ])
    assert.equal(next._storageRevision, 3)
    assert.equal(rowCount(db), 12)
    assert.equal((await A.store.read(A.id)).messages.at(-1).text, 'text-11-0')
  } finally {
    DatabaseSync.prototype.prepare = prepare
    try { db.exec('ROLLBACK') } catch { /* 已结束 */ }
  }
})
