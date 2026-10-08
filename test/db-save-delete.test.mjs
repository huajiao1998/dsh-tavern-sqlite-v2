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
assert.ok(body.includes('DB删局目标归属不符') && body.includes('DB删局目标仍有活动句柄'), '提取体不是真实方法')
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
test('DB删局扁平足迹预检只读且活动句柄归属不符拒绝', async t => {
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
  // ④ 活动句柄 → 拒且不关任何缓存（避免半 prepare）
  f.bind(FG, f.archive); f.cache(FG); f.handles.push({ id: FG })
  assert.throws(() => f.validate.call(f.host, f.chatId, [FG], f.archive), /DB删局目标仍有活动句柄/)
  assert.equal(f.closed.length, 0); assert.equal(f.dbs.has(FG), true)
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
  // ⑦ 活动句柄 ⇒ 拒且不关任何缓存（先精确重建 FG 库，避免沿用 ⑥ 里被替换成的 X 身份）
  for (const suffix of ['', '-wal', '-shm']) rmSync(f.pathOf(f.FG) + suffix, { force: true })
  f.materialize(f.FG); f.makeArchive(f.chatId, f.chatId, f.FG)
  assert.equal(f.archiveMeta(f.FG), null, '重建后的 FG 仍应为未绑定普通新建')
  const closedBeforeHandle = f.closed.length
  f.cache(f.FG); f.handles.push({ id: f.FG })
  assert.throws(() => f.validate.call(f.host, f.chatId, [f.FG], f.archiveFor(f.chatId)), /DB删局目标仍有活动句柄/)
  assert.equal(f.closed.length, closedBeforeHandle, '活动句柄拒绝时不得关闭缓存')
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
