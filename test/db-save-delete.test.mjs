// 只验删局扁平足迹预检（backend 源码截取 + 合成 SQLite 目标）：不加载SDK/业务、不执行真实删除、不改源字节。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { restoreDatabase } from '../lib/db-save-codec.js'
import { applyDbSaveDeleteTransform } from '../deploy/db-save-transform.mjs'
const HEAD = '\tdbSaveDeleteFootprint(chatId, ids, archive) {'
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf(HEAD)
assert.ok(start > 0, '未找到 dbSaveDeleteFootprint 源码（协议变更需人工复核）')
const end = source.indexOf('\n\t}', start)
assert.ok(end > start, '未找到方法结束边界')
const body = source.slice(start + HEAD.length, end)
assert.ok(body.includes('DB删局目标归属不符') && body.includes('deferred'), '提取体不是真实方法（应含归属守卫与 deferred 标记）')
const makeDelete = new Function('DatabaseSync', 'path', 'return function dbSaveDeleteFootprint(chatId, ids, archive) {' + body + '}')
const tables = id => ({ meta: [{ key: 'schema_version', value: '1' }], sessions: [{ id, header_json: JSON.stringify({ id, version: 1, createdAt: 1 }), format_version: 1, created_at: 1, inherited_event_count: 0, event_count: 1 }], events: [{ seq: 0, type: 'turn/end', time: 1, data_json: '{"turn":1}', extra_json: null }] })
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-db-delete-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const chatId = 'chat-del', chats = path.join(root, 'chats', chatId), archive = path.join(chats, 'archive.db')
  mkdirSync(chats, { recursive: true }); mkdirSync(path.join(root, 'sessions'), { recursive: true })
  const pathOf = id => path.join(root, 'sessions', id + '.db')
  const bind = (id, binding, identity = id) => { for (const suffix of ['', '-wal', '-shm']) rmSync(pathOf(id) + suffix, { force: true }); restoreDatabase(pathOf(id), 'native', tables(identity)); const db = new DatabaseSync(pathOf(id)); db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('rollback_archive',?)").run(binding); db.close() }
  const dbs = new Map(), closed = [], handles = []
  const store = { exists: id => existsSync(pathOf(id)), pathOf, dbs }
  const host = { store, tracker: { openHandles: handles }, assertWritable(id) { if (!store.exists(id)) throw Error('原件只读') } }
  return {
    root, chatId, archive, pathOf, bind, dbs, closed, handles, host, validate: makeDelete(DatabaseSync, path),
    cache(id) { const db = new DatabaseSync(pathOf(id)); dbs.set(id, { db, close() { closed.push(id); db.close() } }) }
  }
}
test('DB删局扁平足迹校验归属且活动句柄延后', async t => {
  const f = fixture(t), FG = 'session-del-fg', BG = 'session-del-bg'
  // ① 归属不符（meta.rollback_archive 指向别的档）→ 拒，且不动缓存
  f.bind(FG, path.join(f.root, 'chats', 'chat-other', 'archive.db'))
  assert.throws(() => f.validate.call(f.host, f.chatId, [FG], f.archive), /DB删局目标归属不符/)
  assert.equal(f.closed.length, 0); assert.equal(f.dbs.size, 0)
  // ② 身份不符（sessions.id !== 目标 id）→ 拒
  f.bind('session-del-x', f.archive, 'session-del-y')
  assert.throws(() => f.validate.call(f.host, f.chatId, ['session-del-x'], f.archive), /DB删局目标身份不符/)
  // ③ 原件（无 SQL 目标）→ 跳过、不抛、不产出项（作者原 jsonl 目录清理不受影响）
  assert.deepEqual(f.validate.call(f.host, f.chatId, ['session-original'], f.archive), [])
  // ④ 活动句柄 → 走作者既有延后队列（deferred 标记，不关缓存、不物理删）
  f.bind(FG, f.archive); f.cache(FG); f.handles.push({ id: FG })
  const deferredItems = f.validate.call(f.host, f.chatId, [FG], f.archive)
  assert.deepEqual(deferredItems.map(item => item.deferred), [true, true, true], '活动句柄应标记 deferred 而非拒绝')
  assert.deepEqual(deferredItems.map(item => item.path), [f.pathOf(FG), f.pathOf(FG) + '-wal', f.pathOf(FG) + '-shm'])
  assert.equal(f.closed.length, 0, 'deferred 路径不得关闭缓存')
  assert.equal(f.dbs.has(FG), true, 'deferred 路径不得丢缓存')
  f.handles.length = 0
  // ⑤ 全部校验通过才关缓存并返回 db/-wal/-shm 扁平项（不执行真实删除）
  f.handles.length = 0; f.bind(BG, f.archive); f.cache(BG)
  const items = f.validate.call(f.host, f.chatId, [FG, BG], f.archive)
  assert.equal(items.length, 6)
  assert.deepEqual(items.map(item => item.path), [f.pathOf(FG), f.pathOf(FG) + '-wal', f.pathOf(FG) + '-shm', f.pathOf(BG), f.pathOf(BG) + '-wal', f.pathOf(BG) + '-shm'])
  assert.deepEqual(items.map(item => item.category), Array(6).fill('subsession'))
  assert.deepEqual(items.map(item => item.kind), Array(6).fill('file'))
  assert.deepEqual(items.map(item => item.sessionId), [FG, FG, FG, BG, BG, BG])
  assert.deepEqual(items.map(item => item.foreground), [true, true, true, false, false, false])
  assert.deepEqual(f.closed, [FG, BG]); assert.equal(f.dbs.size, 0)
  assert.equal(existsSync(f.pathOf(FG)), true, '预检不得执行真实删除')
  assert.equal(existsSync(f.pathOf(BG)), true)
  // ⑥ 不放宽既有临时归属回收：dbSaveRemove 守卫仍在
  assert.ok(source.includes("if (dbSaveTargets.get(file) !== id) throw Error('仅可回收本次未发布的DB新目标')"), 'dbSaveRemove 归属守卫被放宽')
  // ⑦ 非法集合立即拒（在读取与关闭之前）：undefined/空/坏 id/非字符串
  const closedAfterSuccess = f.closed.length
  for (const bad of [undefined, [], ['session-del-fg', 'bad id!'], ['session-del-fg', 7]]) assert.throws(() => f.validate.call(f.host, f.chatId, bad, f.archive), /DB删局Session身份集合无效/)
  assert.equal(f.closed.length, closedAfterSuccess, '非法集合不得关闭任何缓存')
  // ⑧ 同形合成消费者执行（**非 b741 byte-exact**：手工重建的删局片段；真实 pinned 源注入由 latest 实际施缝 case 核）
  //    顺序：prepare → registry.remove → live defer / removeLeftovers（非仅字面排序）
  const PINNED = `  async function deleteChat(chatId) {
    await stopChatForDeletion(chatId)
    const chat = await readChat(str(chatId))
    const footprint = chat ? await gameFootprint.describe(chat, { ownsSession: id => ownsBackgroundSession(chat, id) }) : null
    const result = await conversationRegistry.remove(chatId)
    deletedChatIds.add(chatId)
    if (footprint) {
      const live = footprint.items.filter(item => item.category === 'subsession' && agentRegistry.get(item.sessionId))
      footprint.items = footprint.items.filter(item => !live.includes(item))
      await gameFootprint.deferSessionDeletion(live)
      const cleanup = await gameFootprint.removeLeftovers(footprint)
      if (cleanup.failures.length) console.warn('dsh-tavern: 删除游戏后有残留未清理', chatId)
    }
    return result
  }
`
  const patched = applyDbSaveDeleteTransform(PINNED)
  const trace = []
  const flat = [{ category: 'subsession', kind: 'file', path: 'sessions/x.db', sessionId: 'session-del-bg', foreground: false }]
  const runDelete = async ({ liveAgent = false } = {}) => {
    trace.length = 0
    const footprint = { chatId: 'chat-del', foregroundSessionId: 'session-del-fg', backgroundSessionIds: ['session-del-bg'], items: [{ category: 'subsession', kind: 'dir', path: 'sessions/fg', sessionId: 'session-del-fg', foreground: true }] }
    const seen = { defer: null, leftovers: null }
    const fn = new Function('chatId', 'stopChatForDeletion', 'readChat', 'str', 'gameFootprint', 'conversationRegistry', 'deletedChatIds', 'agentRegistry', 'ctx', 'chatJournalStore', 'ownsBackgroundSession', patched.slice(patched.indexOf('  async function deleteChat(chatId) {')) + '\nreturn (async () => await deleteChat(chatId))()')
    await fn(
      'chat-del',
      async () => {}, async id => ({ id: 'chat-del', sessionId: 'session-del-fg' }), String,
      { describe: async () => footprint, deferSessionDeletion: async items => { trace.push('defer'); seen.defer = items }, removeLeftovers: async value => { trace.push('removeLeftovers'); seen.leftovers = value; return { failures: [] } } },
      { remove: async () => { trace.push('registryRemove'); return { removed: true } } }, new Set(),
      { get: id => (liveAgent && id === 'session-del-bg' ? { cancel() {} } : undefined) },
      { get: () => ({ dbSaveDeleteFootprint: () => { trace.push('prepare'); return flat } }) },
      { rollbackArchivePath: () => path.join(f.root, 'chats', 'chat-del', 'archive.db') },
      async () => true
    )
    return seen
  }
  const dead = await runDelete()
  // 作者无 live 时也照常调用 defer（传空数组），随后 removeLeftovers 承接全部项
  assert.deepEqual(trace, ['prepare', 'registryRemove', 'defer', 'removeLeftovers'])
  assert.deepEqual(dead.defer, [])
  assert.ok(dead.leftovers.items.some(item => item.path === 'sessions/x.db'), '扁平项未进入作者 removeLeftovers 消费')
  const alive = await runDelete({ liveAgent: true })
  assert.deepEqual(trace, ['prepare', 'registryRemove', 'defer', 'removeLeftovers'])
  assert.deepEqual(alive.defer.map(item => item.path), ['sessions/x.db'], 'live agent 的扁平项应走 defer')
  assert.equal(alive.leftovers.items.some(item => item.path === 'sessions/x.db'), false)
})

// ===== 普通新建、未绑定（meta.rollback_archive=NULL）的删局必须只读核 Chat 档 header 归属 =====
// 契约：missing binding 仅当目标 id === 前台 id、native `sessions.id` 吻合、且 Chat 档 `archive_head_fields` 的
// `id`/`sessionId`（scalar JSON string；`archive_head.id` 恒为 singleton=1）等于 chatId/前台时才放行；非前台仍 fail-closed。
// 构造走真实写路径：Chat 档 `restoreDatabase(...,'archive',...)`，native `SqliteSessionStore.materializeSession`（不手工写绑定）。
import { SqliteSessionStore } from '../store.js'

const ARCHIVE_TABLES = (chatId, sessionId) => ({
  archive_head: [{ id: 1, revision: 1, updated_at: 1 }],
  archive_head_fields: [
    { key: 'id', ord: 0, kind: 0, value_json: JSON.stringify(chatId) },
    { key: 'sessionId', ord: 1, kind: 0, value_json: JSON.stringify(sessionId) },
    { key: 'messages', ord: 2, kind: 1, value_json: null },
  ],
  archive_messages: [{ message_index: 0, message_json: JSON.stringify({ role: 'assistant', mes: '正文' }) }],
  archive_timeline_nodes: [],
  variable_snapshots: [],
  variable_state: [],
  archive_worldbook_history: [],
})

function nativeFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-db-delete-native-'))
  const dbs = new Map(), closed = [], handles = []
  t.after(() => {
    for (const entry of dbs.values()) { try { entry.close() } catch { /* 已关闭 */ } }
    dbs.clear()
    rmSync(root, { recursive: true, force: true })
  })
  const chatId = 'chat-native-fg', FG = 'session-native-fg', BG = 'session-native-bg', X = 'session-native-x', BAD = 'session-native-bad'
  const chatsRoot = path.join(root, 'chats'), sessionsRoot = path.join(root, 'sessions')
  mkdirSync(chatsRoot, { recursive: true }); mkdirSync(sessionsRoot, { recursive: true })
  const archiveFor = chat => path.join(chatsRoot, chat, 'archive.db')
  const pathOf = id => path.join(sessionsRoot, id + '.db')
  const store = new SqliteSessionStore(sessionsRoot)
  const host = { store: { exists: id => existsSync(pathOf(id)), pathOf, dbs }, tracker: { openHandles: handles }, assertWritable(id) { if (!existsSync(pathOf(id))) throw Error('原件只读') } }
  return {
    root, chatId, FG, BG, X, BAD, archiveFor, pathOf, store, dbs, closed, handles, host,
    validate: makeDelete(DatabaseSync, path),
    /** 普通创建写路径（无 rollback_archive ⇒ 该 meta 为 NULL）；closeAll 避免缓存句柄占住后续文件操作 */
    materialize(id, events = []) { store.materializeSession({ id, version: 1, createdAt: 1 }, 0, events); store.closeAll() },
    /** dirChat＝落盘目录名（= 目标 chatId），headerChat/headerSession＝档内自述身份；重建前只清本 fixture 的该档文件 */
    makeArchive(dirChat, headerChat = dirChat, headerSession) {
      const target = archiveFor(dirChat)
      for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true })
      mkdirSync(path.dirname(target), { recursive: true })
      restoreDatabase(target, 'archive', ARCHIVE_TABLES(headerChat, headerSession))
    },
    archiveMeta(id) { const db = new DatabaseSync(pathOf(id), { readOnly: true }); try { return db.prepare("SELECT value FROM meta WHERE key='rollback_archive'").get()?.value ?? null } finally { db.close() } },
    /** 复用已缓存条目：覆盖 Map 而不关旧句柄会在 Windows 清理时 EPERM */
    cache(id) { if (dbs.has(id)) return; const db = new DatabaseSync(pathOf(id), { readOnly: true }); dbs.set(id, { db, close() { closed.push(id); db.close() } }) },
    /** 显式关闭本 fixture 的全部缓存句柄（Windows 下保证 t.after 的 rm 不被句柄占用） */
    closeAll() { for (const entry of dbs.values()) { try { entry.close() } catch { /* 已关闭 */ } } dbs.clear() },
  }
}

test('普通新建未绑定DB删局核Chat归属且拒外档', async t => {
  const f = nativeFixture(t)
  // ① 真实普通创建：FG 未绑定 ⇒ meta.rollback_archive 为 NULL（复现上报状态）
  f.materialize(f.FG)
  assert.equal(f.archiveMeta(f.FG), null, '普通创建不得自带 rollback_archive 绑定')
  f.makeArchive(f.chatId, f.chatId, f.FG)
  const archiveSha = readFileSync(f.archiveFor(f.chatId))
  // ② 同档、未绑定的普通前台 ⇒ 允许（只读核 Chat 档 header 归属；无需回填 DB 绑定）；全部校验后才关缓存
  f.cache(f.FG)
  const items = f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId))
  assert.deepEqual(items.map(item => item.path), [f.pathOf(f.FG), f.pathOf(f.FG) + '-wal', f.pathOf(f.FG) + '-shm'])
  assert.deepEqual(f.closed, [f.FG], '全部校验通过后才关闭缓存')
  assert.equal(f.archiveMeta(f.FG), null, '不得为通过校验而回填 rollback_archive')
  assert.deepEqual(readFileSync(f.archiveFor(f.chatId)), archiveSha, 'Chat 档字节不得被改写')
  // ③ 档内 header 属别档（写在当前正确路径）⇒ 拒归属
  f.materialize(f.BG)
  f.makeArchive(f.chatId, 'chat-other', f.BG)
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId)), /DB删局目标归属不符/)
  // ④ 未绑定但档内 header.sessionId 非本前台 ⇒ 仍拒
  f.makeArchive(f.chatId, f.chatId, f.BG)
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId)), /DB删局目标归属不符/)
  // ⑤ 集合内先 FG 合法、随后未绑定后台（id !== 前台）⇒ fail-closed，且不得关掉 FG 缓存
  f.materialize(f.FG); f.materialize(f.BG); f.makeArchive(f.chatId, f.chatId, f.FG)
  const closedBeforeBg = f.closed.length
  f.cache(f.FG)
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG, f.BG], f.archiveFor(f.chatId)), /DB删局/, 'missing binding 的非前台必须拒绝')
  assert.equal(f.closed.length, closedBeforeBg, '拒绝时不得关闭已缓存 FG')
  assert.equal(f.dbs.has(f.FG), true, 'FG 缓存必须保留')
  // ⑥ native 身份不符（库内 sessions.id ≠ 目标 id）⇒ 拒（先释放本 fixture 的 FG 缓存句柄，再只清 FG 库文件重建）
  f.dbs.get(f.FG)?.close(); f.dbs.delete(f.FG)
  f.materialize(f.X)
  for (const suffix of ['', '-wal', '-shm']) rmSync(f.pathOf(f.FG) + suffix, { force: true })
  writeFileSync(f.pathOf(f.FG), readFileSync(f.pathOf(f.X)))
  f.makeArchive(f.chatId, f.chatId, f.FG)
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId)), /DB删局目标身份不符/)
  // ⑦ 活动句柄 ⇒ 走延后队列（deferred 标记），不关缓存、不物理删
  for (const suffix of ['', '-wal', '-shm']) rmSync(f.pathOf(f.FG) + suffix, { force: true })
  f.materialize(f.FG); f.makeArchive(f.chatId, f.chatId, f.FG)
  assert.equal(f.archiveMeta(f.FG), null, '重建后的 FG 仍应为未绑定普通新建')
  const closedBeforeHandle = f.closed.length
  f.cache(f.FG); f.handles.push({ id: f.FG })
  const deferredNative = f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId))
  assert.deepEqual(deferredNative.map(item => item.deferred), [true, true, true], '活动句柄应标记 deferred 而非拒绝')
  assert.equal(f.closed.length, closedBeforeHandle, 'deferred 路径不得关闭缓存')
  assert.equal(f.dbs.has(f.FG), true, 'deferred 路径不得丢缓存')
  f.handles.length = 0
  // ⑧ Chat 档缺失（**正确路径**但文件不存在）⇒ 精准拒绝，且不得为校验造库
  const archivePath = f.archiveFor(f.chatId)
  for (const suffix of ['', '-wal', '-shm']) rmSync(archivePath + suffix, { force: true })
  assert.equal(existsSync(archivePath), false, '夹具应先精确移除本 chat 档')
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG], archivePath), /DB删局/, '缺 Chat 档不得放行')
  assert.equal(existsSync(archivePath), false, '缺档校验不得创建 Chat 档')
  // ⑨ Chat 档 header 元数据损坏（native FG 仍为 missing row）⇒ 归属判定精准拒绝且不关缓存
  f.materialize(f.FG)
  assert.equal(f.archiveMeta(f.FG), null, '⑨ 前置：FG 仍为未绑定')
  f.makeArchive(f.chatId, f.chatId, f.FG)
  const fix = new DatabaseSync(f.archiveFor(f.chatId))
  fix.prepare("UPDATE archive_head_fields SET value_json='{not json' WHERE key='sessionId'").run()
  fix.close()
  const closedBeforeBad = f.closed.length
  f.cache(f.FG)
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId)), /DB删局目标归属不符/, '档内身份元数据损坏必须按归属拒绝')
  assert.equal(f.closed.length, closedBeforeBad, '损坏元数据拒绝时不得关闭缓存')
  f.closeAll()
})

// ===== 新增：活动句柄走作者既有延后队列（真实官方 game-footprint 68215 ＋ B 的 applyDbSaveFootprintTransform 施缝，非 synthetic remove）=====
// 官方夹具逐字节取自 pinned 68215e47516637e00c75d2b4bba3192679559425：
//   test/fixtures/game-footprint-68215.js（7500B sha256 01e3c4e8…）＋同 scope 的 background-identity.js（1279B sha256 060c575b…）。
// 产品 SQL 是扁平布局 store.root/<id>.db（root = <dataRoot>/sessions），与作者默认 sessionsRoot = dirname(dataRoot)/sessions（原生目录树）不同。
import { applyDbSaveDeleteTransform as applyDbSaveDelete, applyDbSaveFootprintHostTransform, applyDbSaveFootprintTransform } from '../deploy/db-save-transform.mjs'
import { copyFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 从产品 index.js 提取真实 dbSaveCanDeleteDeferredPath（不手写 validator）。
const CAN_HEAD = '\tdbSaveCanDeleteDeferredPath(file) {'
const canStart = source.indexOf(CAN_HEAD)
assert.ok(canStart > 0, '未找到 dbSaveCanDeleteDeferredPath 源码（协议变更需人工复核）')
const canEnd = source.indexOf('\n\t}', canStart)
const canBody = source.slice(canStart + CAN_HEAD.length, canEnd)
const makeCanDelete = new Function('DatabaseSync', 'path', 'return function dbSaveCanDeleteDeferredPath(file) {' + canBody + '}')

// 真实 caller/factory 作用域：读**入库的官方切片夹具** `test/fixtures/db-save-delete-host-68215.js.txt`
// （pinned 68215 官方 index.js 的真实切片：工厂原行 + deleteChat 完整原方法 + exportConversation 真实头行作末哨兵，仅裁剪未改字节），
// 组合施缝 `applyDbSaveFootprintHostTransform(applyDbSaveDelete(text))` 后提取真实 deleteChat（真实 deferred live 过滤在此组合里）。
const HOST_SLICE = fileURLToPath(new URL('./fixtures/db-save-delete-host-68215.js.txt', import.meta.url))
const deleteChatBody = (() => {
  const text = applyDbSaveFootprintHostTransform(applyDbSaveDelete(readFileSync(HOST_SLICE, 'utf8')))
  const a = text.indexOf('  async function deleteChat(chatId) {')
  const b = text.indexOf('\n  async function exportConversation(', a)
  assert.ok(a > 0 && b > a, '官方 deleteChat 切片未定位到')
  return text.slice(a, b).trim()
})()

/** 官方 game-footprint 源码过 B 施缝后写成临时模块（同 scope 放 background-identity 副本）再 import 真实工厂。 */
async function seamedFootprint(base) {
  const dir = path.join(base, 'seamed-author')
  mkdirSync(dir, { recursive: true })
  const src = readFileSync(fileURLToPath(new URL('./fixtures/game-footprint-68215.js', import.meta.url)), 'utf8')
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n')            // 同 scope 明确 ESM，避免扩展名自动探测告警
  writeFileSync(path.join(dir, 'game-footprint.mjs'), applyDbSaveFootprintTransform(src))
  copyFileSync(fileURLToPath(new URL('./fixtures/background-identity.js', import.meta.url)), path.join(dir, 'background-identity.js'))
  return (await import(pathToFileURL(path.join(dir, 'game-footprint.mjs')).href)).createGameFootprint
}

function deferredFixture(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-db-delete-deferred-'))
  t.after(() => { for (const entry of dbs.values()) { try { entry.close() } catch { /* 已关闭 */ } } dbs.clear(); handles.length = 0; rmSync(base, { recursive: true, force: true }) })   // 先释放自有句柄再删本 fixture 唯一前缀目录
  const dataRoot = path.join(base, 'profile-data', 'tavern')
  const nativeRoot = path.join(path.dirname(dataRoot), 'sessions')              // 作者默认（原生会话目录树）
  const sqlRoot = path.join(dataRoot, 'sessions')                               // 产品扁平 SQL root（≠ 作者默认）
  const chatId = 'chat-defer', FG = 'session-defer-fg', BG = 'session-defer-bg', READER = 'session-defer-reader', OTHER = 'session-defer-other'
  const archive = path.join(dataRoot, 'chats', chatId, 'archive.db')
  mkdirSync(path.dirname(archive), { recursive: true })
  restoreDatabase(archive, 'archive', ARCHIVE_TABLES(chatId, FG))              // 真实 Chat 档：archive_head_fields 的 id/sessionId 供归属互证
  const sessionStore = new SqliteSessionStore(sqlRoot)                          // 真实产品 store：root/pathOf/exists
  const dbs = new Map(), closed = [], handles = []
  const store = { root: sessionStore.root, exists: id => sessionStore.exists(id), pathOf: id => sessionStore.pathOf(id), dbs }
  const host = { store, tracker: { openHandles: handles }, assertWritable() {} }
  t.after(() => { for (const entry of dbs.values()) { try { entry.close() } catch { /* 已关闭 */ } } dbs.clear() })
  return {
    base, dataRoot, nativeRoot, sqlRoot, chatId, FG, BG, READER, OTHER, archive, sessionStore, dbs, closed, handles, host,
    validate: makeDelete(DatabaseSync, path),
    canDelete: makeCanDelete(DatabaseSync, path),
    /** 真实 SQLite 普通创建（真实 meta/表）＋显式 rollback_archive 绑定（默认绑本档；FG 传 null＝未绑定前台） */
    makeSql(id, bindArchive = archive) {
      sessionStore.materializeSession({ id, version: 1, createdAt: 1 }, 0, [])
      sessionStore.closeAll()
      if (bindArchive) {
        const db = new DatabaseSync(sessionStore.pathOf(id))
        try { db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('rollback_archive',?)").run(bindArchive) } finally { db.close() }
      }
    },
    /** 作者原生目录（供官方 describe 产出 subsession 目录项） */
    makeNative(id) { mkdirSync(path.join(nativeRoot, 'project-x', id), { recursive: true }) },
    sqlFileOf: id => sessionStore.pathOf(id),
    nativeDirOf: id => path.join(nativeRoot, 'project-x', id),
    pendingPath: path.join(dataRoot, 'pending-session-deletions.json'),
    pending() { try { return JSON.parse(readFileSync(this.pendingPath, 'utf8')) } catch { return null } },
    cache(id) { if (dbs.has(id)) return; const db = new DatabaseSync(sessionStore.pathOf(id), { readOnly: true }); dbs.set(id, { db, close() { closed.push(id); db.close() } }) },
    closeAll() { for (const entry of dbs.values()) { try { entry.close() } catch { /* 已关闭 */ } } dbs.clear(); handles.length = 0 },
  }
}

test('DB删局活动句柄走既有延后队列且启动只清归属SQL', async t => {
  const f = deferredFixture(t)
  const createGameFootprint = await seamedFootprint(f.base)
  f.makeSql(f.FG, null); f.makeSql(f.BG); f.makeSql(f.READER); f.makeSql(f.OTHER, null)
  f.makeNative(f.FG); f.makeNative(f.BG)
  const footprint = createGameFootprint({ dataRoot: f.dataRoot, canDeleteDeferredPath: file => f.canDelete.call(f.host, file) })
  // ① 官方 describe：作者原生 sessionsRoot/<project>/<id> 目录即 subsession 项，前台带 foreground 标记
  const chat = { id: f.chatId, sessionId: f.FG, backgroundHistoryIds: [f.BG] }
  const fp = await footprint.describe(chat, { ownsSession: async () => true })
  assert.equal(fp.foregroundSessionId, f.FG)
  assert.deepEqual(fp.backgroundSessionIds, [f.BG])
  assert.ok(fp.items.some(item => item.category === 'subsession' && item.sessionId === f.FG && item.foreground === true), '官方 describe 应产出前台 subsession 项')
  // ② 活动句柄（真实 SQLite 缓存 + 打开句柄）⇒ 三项 deferred 落在**产品扁平 SQL 路径**，缓存不关、文件不删
  f.cache(f.FG); f.handles.push({ id: f.FG })
  const active = f.validate.call(f.host, f.chatId, [f.FG], f.archive)
  assert.deepEqual(active.map(item => item.deferred), [true, true, true], '活动句柄必须标记 deferred')
  assert.deepEqual(active.map(item => item.path), [f.sqlFileOf(f.FG), f.sqlFileOf(f.FG) + '-wal', f.sqlFileOf(f.FG) + '-shm'])
  assert.equal(f.closed.length, 0, 'deferred 不得关缓存')
  assert.equal(existsSync(f.sqlFileOf(f.FG)), true, 'deferred 不得物理删活跃 SQL')
  // ③ 真实 dbSaveCanDeleteDeferredPath：活动时拒绝（含后缀判定），关句柄后才允许
  assert.throws(() => f.canDelete.call(f.host, f.sqlFileOf(f.FG)), /仍有活动句柄.*保留登记/, '活动目标不得被延后清理')
  assert.throws(() => f.canDelete.call(f.host, f.sqlFileOf(f.FG) + '-wal'), /仍有活动句柄.*保留登记/, '活动目标后缀同样拒绝')
  // ④ 延后队列复用作者既有字符串数组格式
  await footprint.deferSessionDeletion(active)
  assert.deepEqual(f.pending().sort(), active.map(item => item.path).sort(), '延后队列应是路径字符串数组')
  // ⑤ 活动未释放时启动清理必须拒绝，且队列字节原样保留、SQL 三件与缓存全留
  const pendingBytes = readFileSync(f.pendingPath, 'utf8')
  await assert.rejects(async () => footprint.processDeferredDeletions(), /保留登记|延后删除缺少/, '活动目标启动清理必须拒绝')
  assert.equal(readFileSync(f.pendingPath, 'utf8'), pendingBytes, '拒绝时队列字节不得变化')
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(f.sqlFileOf(f.FG) + suffix), true, '活动目标 SQL 三件必须保留')
  assert.equal(f.dbs.has(f.FG), true, '活动目标缓存必须保留')
  // ⑥ 关自己的句柄、handle 列表归零（模拟下次 store 启动）⇒ 启动清理真实删三项
  f.closeAll()
  assert.equal(f.canDelete.call(f.host, f.sqlFileOf(f.FG)), true, '释放后归属 SQL 才可被延后清理')
  assert.equal(await footprint.processDeferredDeletions(), 3, '启动清理应处理三项归属 SQL')
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(f.sqlFileOf(f.FG) + suffix), false, '启动后归属 SQL 三件应被清')
  // ⑦ 队列只清归属：域外路径 / 伪后缀（另一 root 文件名）/ 未登记它档 SQL 全保留；原作者原生目录行为保留
  const foreign = path.join(f.base, 'outside', f.FG + '.db')
  const fakeSuffix = path.join(f.sqlRoot, f.FG + '.db-evil')
  mkdirSync(path.dirname(foreign), { recursive: true }); writeFileSync(foreign, 'x'); writeFileSync(fakeSuffix, 'x')
  const nativeDir = f.nativeDirOf(f.BG)
  writeFileSync(f.pendingPath, JSON.stringify([foreign, fakeSuffix, nativeDir]))
  assert.equal(await footprint.processDeferredDeletions(), 1, '只有归属 SQL 或原允许原生目录可被启动清理')
  assert.equal(existsSync(foreign), true, '域外路径不得被清')
  assert.equal(existsSync(fakeSuffix), true, '伪后缀文件名不得被清')
  assert.equal(existsSync(nativeDir), false, '作者原生目录仍按原行为清理')
  assert.equal(existsSync(f.sqlFileOf(f.OTHER)), true, '未登记它档 SQL 不得被清（未进队列）')
  // ⑧ reader-only（显式 read 租约、无 agent）同样 deferred；冷路径先建缓存再立即关、无 deferred、removeLeftovers 真实清理
  f.makeSql(f.READER); f.cache(f.READER); f.handles.push({ id: f.READER, access: 'read' })
  const readerOnly = f.validate.call(f.host, f.chatId, [f.READER], f.archive)
  assert.deepEqual(readerOnly.map(item => item.deferred), [true, true, true], 'reader-only 活跃也应 deferred')
  assert.equal(existsSync(f.sqlFileOf(f.READER)), true)
  f.handles.length = 0; f.closeAll(); f.makeSql(f.BG); f.cache(f.BG)
  const cold = f.validate.call(f.host, f.chatId, [f.BG], f.archive)
  assert.deepEqual(cold.map(item => item.deferred ?? false), [false, false, false], '冷路径不得带 deferred')
  assert.equal(f.closed.filter(id => id === f.BG).length, 1, '冷路径应立即关缓存')
  const cleanup = await footprint.removeLeftovers({ items: cold })
  assert.deepEqual(cleanup.failures, [])
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(f.sqlFileOf(f.BG) + suffix), false, '冷路径三件应被真实清理')
  // ⑨ 真实 caller（官方 deleteChat 过删局＋Host 组合施缝）：无 agent 的活跃前台仍走 defer、其余走 removeLeftovers
  const trace = [], seen = { defer: null, leftovers: null }
  const freshFp = () => ({ chatId: f.chatId, foregroundSessionId: f.FG, backgroundSessionIds: [], items: [
    { category: 'subsession', kind: 'dir', path: f.nativeDirOf(f.FG), sessionId: f.FG, foreground: true },
  ] })
  const ctx = { get: name => (name === 'sessionPersistence' ? { dbSaveDeleteFootprint: () => active.map(item => ({ ...item })) } : undefined) }
  const chatJournalStore = { rollbackArchivePath: () => f.archive }
  const runDelete = async () => new Function('chatId', 'stopChatForDeletion', 'readChat', 'str', 'gameFootprint', 'conversationRegistry', 'deletedChatIds', 'pluginMedia', 'pluginApi', 'apiDiagnostics', 'backgroundAgentRunner', 'agentRegistry', 'deletedSessionIds', 'ownsBackgroundSession', 'ctx', 'chatJournalStore',
    deleteChatBody + '\nreturn (async () => await deleteChat(chatId))()')(
    f.chatId, async () => {}, async () => chat, String,
    { describe: async () => freshFp(), deferSessionDeletion: async items => { trace.push('defer'); seen.defer = items }, removeLeftovers: async value => { trace.push('removeLeftovers'); seen.leftovers = value; return { failures: [] } } },
    { remove: async () => { trace.push('registryRemove'); return {} } }, new Set(),
    { removeChat: async () => {} }, { gameRemoved() {} }, { forget: async () => {} }, { releaseFor: async () => {} },
    { get: () => undefined }, new Set(), () => true, ctx, chatJournalStore)
  await runDelete()
  assert.deepEqual(trace, ['registryRemove', 'defer', 'removeLeftovers'], '真实 caller 顺序：registry.remove → defer(live) → removeLeftovers')
  assert.equal(seen.defer.length, 3, 'deferred 应为 SQL 三件（native 项无 deferred 标记，按原语义留 leftovers）')
  assert.ok(seen.defer.every(item => item.kind === 'file' && item.sessionId === f.FG), 'deferred 三项应为 FG 的 SQL 文件')
  assert.equal(seen.leftovers.items.some(item => item.sessionId === f.FG && item.kind === 'dir'), true, '无 agent 的 native 目录项按原语义进 leftovers')
  assert.equal(seen.leftovers.items.some(item => item.kind === 'file'), false, 'active SQL 文件不得进 leftovers')
  // ⑩ 同根重叠（sessionsRoot = sqlRoot）：active 目标仍先走 guard，不因原 root 含该路径而放行
  const sameRoot = createGameFootprint({ dataRoot: f.dataRoot, sessionsRoot: f.sqlRoot, canDeleteDeferredPath: file => f.canDelete.call(f.host, file) })
  f.makeSql(f.READER); f.cache(f.READER); f.handles.push({ id: f.READER, access: 'read' })
  const sameActive = f.validate.call(f.host, f.chatId, [f.READER], f.archive)
  assert.deepEqual(sameActive.map(item => item.deferred), [true, true, true], '同根重叠下 active 仍应 deferred')
  await sameRoot.deferSessionDeletion(sameActive)
  const sameBytes = readFileSync(f.pendingPath, 'utf8')
  await assert.rejects(async () => sameRoot.processDeferredDeletions(), /仍有活动句柄.*保留登记/, '同根重叠且 active 时启动清理仍须拒绝')
  assert.equal(readFileSync(f.pendingPath, 'utf8'), sameBytes, '拒绝时队列字节不得变化')
  assert.equal(existsSync(f.sqlFileOf(f.READER)), true, '同根重叠 active 目标不得被 unlink')
  f.handles.length = 0; f.closeAll()
  // ⑪ 归属校验先于关闭/延后：外档绑定 ⇒ 拒且不改写队列（先重建自有合法 pending 再 snapshot，避免沿用已被作者清理的文件）
  writeFileSync(f.pendingPath, JSON.stringify([f.nativeDirOf(f.BG)]))
  const pendingSnapshot = readFileSync(f.pendingPath, 'utf8')
  f.makeSql(f.READER); f.cache(f.READER)
  const closedBeforeReject = f.closed.length
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.READER], path.join(f.base, 'other-chat', 'archive.db')), /DB删局/)
  assert.equal(f.closed.length, closedBeforeReject, '归属拒绝不得关闭缓存')
  assert.equal(readFileSync(f.pendingPath, 'utf8'), pendingSnapshot, 'preflight 失败不得改写延后队列')
})
