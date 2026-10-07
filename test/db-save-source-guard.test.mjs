// 只验两个新路径守卫：dbSaveArchivePath原件优先、dbSaveNewArchivePath新身份实物即拒；合成magic，不打开影子库/不读写业务/SQL/不加载SDK。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
const REQUIRED = ['copyJsonTree', 'diffJson', 'applyJsonChangesShared', 'projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']
const ID = 'chat-guard-source', ABSENT = 'chat-guard-missing', NEW = 'chat-guard-new'
const MAGIC = 'SQLite format 3\0'
function removeOwn(root, target) {
  const resolved = path.resolve(target), base = path.resolve(root)
  assert.ok(resolved.startsWith(base + path.sep), '拒绝删除root外文件：' + resolved)
  rmSync(resolved, { recursive: true, force: true })
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-db-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const chats = path.join(root, 'chats'), dir = path.join(chats, ID)
  mkdirSync(dir, { recursive: true })
  const shadow = path.join(dir, 'archive.db'), legacyJson = path.join(chats, ID + '.json'), headJson = path.join(dir, 'head.json')
  writeFileSync(shadow, MAGIC)
  const store = createChatSqliteStore({ dataRoot: root, helpers: Object.fromEntries(REQUIRED.map(name => [name, () => undefined])) })
  return { root, chats, shadow, legacyJson, headJson, store }
}
function deniedBy(call) {
  try { call(); assert.fail('原件存在时dbSaveArchivePath必须拒绝') } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error
    return error
  }
}
test('DB导出源路径原件优先不打开SQL影子', t => {
  const f = fixture(t), before = readFileSync(f.shadow)
  // ① 同ID .json 原件在场：拒，code/chatId 精确，影子字节不动
  writeFileSync(f.legacyJson, JSON.stringify({ id: ID, messages: [] }))
  const flat = deniedBy(() => f.store.dbSaveArchivePath(ID))
  assert.equal(flat.code, 'DSH_TAVERN_LEGACY_READ_ONLY'); assert.equal(flat.chatId, ID)
  assert.match(flat.message, /原档只读/)
  // ② 目录内 head.json 原件同样优先
  removeOwn(f.root, f.legacyJson)
  writeFileSync(f.headJson, JSON.stringify({ id: ID }))
  const headed = deniedBy(() => f.store.dbSaveArchivePath(ID))
  assert.equal(headed.code, 'DSH_TAVERN_LEGACY_READ_ONLY'); assert.equal(headed.chatId, ID)
  assert.deepEqual(readFileSync(f.shadow), before)
  // ③ 删掉自己的原件后，路径才返回；返回过程不打开影子（字节仍不变）
  removeOwn(f.root, f.headJson)
  assert.equal(f.store.dbSaveArchivePath(ID), f.shadow)
  assert.deepEqual(readFileSync(f.shadow), before)
  // ④ 缺权威SQL档：拒
  assert.throws(() => f.store.dbSaveArchivePath(ABSENT), /没有权威SQL存档/)
  // ⑤ 新身份路径：任何同ID实物（.json／head.json／空目录／archive.db）都在资源创建前拒，且不改任何字节
  const newDir = path.join(f.chats, NEW), newJson = path.join(f.chats, NEW + '.json'), newHead = path.join(newDir, 'head.json'), newDb = path.join(newDir, 'archive.db')
  const newJsonBytes = Buffer.from(JSON.stringify({ id: NEW })), newHeadBytes = Buffer.from(JSON.stringify({ id: NEW }))
  writeFileSync(newJson, newJsonBytes)
  assert.throws(() => f.store.dbSaveNewArchivePath(NEW), /新身份已存在/)
  assert.deepEqual(readFileSync(newJson), newJsonBytes)
  removeOwn(f.root, newJson)
  mkdirSync(newDir, { recursive: true })
  writeFileSync(newHead, newHeadBytes)
  assert.throws(() => f.store.dbSaveNewArchivePath(NEW), /新身份已存在/)
  assert.deepEqual(readFileSync(newHead), newHeadBytes)
  removeOwn(f.root, newHead)
  assert.throws(() => f.store.dbSaveNewArchivePath(NEW), /新身份已存在/)   // 仅空目录也拒
  assert.equal(existsSync(newDir), true)
  writeFileSync(newDb, MAGIC)
  assert.throws(() => f.store.dbSaveNewArchivePath(NEW), /新身份已存在/)
  assert.deepEqual(readFileSync(newDb), Buffer.from(MAGIC))
  removeOwn(f.root, newDb); removeOwn(f.root, newDir)
  // ⑥ 全无实物才返回路径，且不创建目录
  assert.equal(f.store.dbSaveNewArchivePath(NEW), newDb)
  assert.equal(existsSync(newDir), false)
  // ⑦ dispose 后两个入口都拒
  f.store.dispose()
  assert.throws(() => f.store.dbSaveArchivePath(ID), /已 dispose/)
  assert.throws(() => f.store.dbSaveNewArchivePath(NEW), /已 dispose/)
  assert.deepEqual(readFileSync(f.shadow), before)
  assert.equal(existsSync(newDir), false)
})
