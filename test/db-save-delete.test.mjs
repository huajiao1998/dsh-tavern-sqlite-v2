// 只验删局扁平足迹预检（backend 源码截取 + 合成 SQLite 目标）：不加载SDK/业务、不执行真实删除、不改源字节。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
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
