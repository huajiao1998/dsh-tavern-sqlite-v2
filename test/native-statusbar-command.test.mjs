// S3 具名断言：状态栏位置原生命令 与 作者 update() 路径 双跑等价（只写不跑）。
// 真 store 夹具（8 helpers，同既有 A 闸机制）；两条路径各用**独立** fixture 库，比较 revision/updated_at/
// head_fields 行/recentChanges 形状；含同值 no-op、CAS 冲突、非法 placement/mode/身份、legacy 拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { writeStatusBarPlacement, PLACEMENT_KEY } from '../lib/chat-command-service.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused

const CHAT = chatId => ({
  id: chatId, sessionId: 'session-statusbar-fixture', mode: 'story', statusBarPlacement: 'sidebar',
  backgroundConfigVersion: 1, conversationFeaturesVersion: 1, _storageRevision: 1, updatedAt: 1,
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 3, participants: {}, operations: {} },
  messages: []
})

const FIXED_NOW = 1_760_000_000_000   // 固定时钟：两路径 updated_at 可做相等断言
function fixture(t, chatId) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-statusbar-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS, now: () => FIXED_NOW })   // store :96 支持固定时钟
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, store }
}

const headRow = (db, key) => db.prepare('SELECT ord, kind, value_json FROM archive_head_fields WHERE key=?').get(key)
const headOf = db => db.prepare('SELECT revision, updated_at FROM archive_head WHERE id=1').get()

test('状态栏命令与作者update路径逐字段等价且同值no-op', async t => {
  const cmd = fixture(t, 'chat-statusbar-cmd')
  const thr = fixture(t, 'chat-statusbar-thr')
  await cmd.store.update(cmd.chatId, () => CHAT(cmd.chatId))
  await thr.store.update(thr.chatId, () => CHAT(thr.chatId))
  const dbCmd = new DatabaseSync(cmd.store.rollbackArchivePath(cmd.chatId))
  const dbThr = new DatabaseSync(thr.store.rollbackArchivePath(thr.chatId))
  try {
    const beforeCmd = headOf(dbCmd), beforeThr = headOf(dbThr)
    const ordBefore = headRow(dbCmd, PLACEMENT_KEY).ord
    // ① 变更写入：命令路径
    const result = writeStatusBarPlacement(dbCmd, { chatId: cmd.chatId, sessionId: 'session-statusbar-fixture', placement: 'body' }, { now: () => FIXED_NOW })
    assert.equal(result.changed, true)
    assert.equal(result.revision, Number(beforeCmd.revision) + 1, 'revision 必须恰 +1（同作者 update）')
    // ② 变更写入：作者 update() 路径（同一语义写入）
    await thr.store.update(thr.chatId, current => ({ ...current, _storageRevision: Number(current._storageRevision || 1) + 1, statusBarPlacement: 'body' }))
    const afterCmd = headOf(dbCmd), afterThr = headOf(dbThr)
    assert.equal(Number(afterThr.revision), Number(beforeThr.revision) + 1, '作者路径 revision +1')
    assert.equal(Number(afterCmd.revision), Number(afterThr.revision), '两条路径最终 revision 一致')
    // head_fields 行：命令保 ord/kind，value_json 编码与作者路径一致
    const rowCmd = headRow(dbCmd, PLACEMENT_KEY), rowThr = headRow(dbThr, PLACEMENT_KEY)
    assert.equal(rowCmd.ord, ordBefore, '命令不得改 ord（保键序占位）')
    assert.equal(rowCmd.kind, rowThr.kind, 'kind 必须与作者路径一致')
    assert.deepEqual(JSON.parse(rowCmd.value_json), JSON.parse(rowThr.value_json), 'value_json 编码等价')
    assert.equal(JSON.parse(rowCmd.value_json), 'body')
    assert.equal(Number(afterCmd.updated_at), Number(afterThr.updated_at), '两路径 updated_at 必须相等（固定时钟下）')
  } finally { dbCmd.close(); dbThr.close() }
  // ③ 同值 no-op：与作者 `changes.length===0 ⇒ return current` 逐字等价（不推 revision）
  const db2 = new DatabaseSync(cmd.store.rollbackArchivePath(cmd.chatId))
  try {
    const before = headOf(db2)
    const again = writeStatusBarPlacement(db2, { chatId: cmd.chatId, placement: 'body' }, {})
    assert.equal(again.changed, false, '同值必须 no-op')
    assert.equal(Number(headOf(db2).revision), Number(before.revision), 'no-op 不得推 revision')
    assert.equal(again.statusBarPlacement, 'body')
    const thrAgain = await thr.store.read(thr.chatId)
    assert.equal(thrAgain.statusBarPlacement, 'body')
  } finally { db2.close() }
})

test('状态栏命令CAS冲突与非法输入拒绝', async t => {
  const f = fixture(t, 'chat-statusbar-cas')
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId))
  try {
    assert.throws(() => writeStatusBarPlacement(db, { chatId: f.chatId, placement: 'floating' }), /非法 placement/, '非法 placement 必须拒绝')
    assert.throws(() => writeStatusBarPlacement(db, { chatId: 'other-chat', placement: 'body' }), /chatId 不匹配/, '身份冲突必须拒绝')
    assert.throws(() => writeStatusBarPlacement(db, { chatId: f.chatId, sessionId: 'other-session', placement: 'body' }), /sessionId 不匹配/, 'session 冲突必须拒绝')
    const before = headOf(db)
    // 顺序语义（真语义，不发明更强拒绝）：另一连接先 bump ⇒ 命令在 BEGIN IMMEDIATE 内**重读**该值，
    // CAS 基于事务内读到的 revision（不是外层 pinned）⇒ 结果＝事务内读到的当前值 + 1
    const other = new DatabaseSync(f.store.rollbackArchivePath(f.chatId))
    other.exec('UPDATE archive_head SET revision=revision+1 WHERE id=1')
    const bumped = Number(headOf(other).revision)
    other.close()
    const result = writeStatusBarPlacement(db, { chatId: f.chatId, placement: 'body' }, {})
    assert.equal(result.changed, true, 'placement 仍不同 ⇒ 应写入推进')
    assert.equal(result.revision, bumped + 1, '结果必须＝事务内读到的当前值 + 1')
    assert.equal(Number(headOf(db).revision), bumped + 1, 'head revision 必须已推进')
    assert.equal(JSON.parse(headRow(db, PLACEMENT_KEY).value_json), 'body')
  } finally { db.close() }
})

test('状态栏命令在缺placement行或非story模式时拒绝', async t => {
  const f = fixture(t, 'chat-statusbar-legacy')
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId))
  try {
    // 缺 placement 行＝旧代/未知形状 ⇒ 拒绝（不发明键）
    db.exec(`DELETE FROM archive_head_fields WHERE key='${PLACEMENT_KEY}'`)
    assert.throws(() => writeStatusBarPlacement(db, { chatId: f.chatId, placement: 'body' }), /缺 statusBarPlacement/, '旧代形状必须拒绝')
  } finally { db.close() }
  const f2 = fixture(t, 'chat-statusbar-mode')
  await f2.store.update(f2.chatId, () => CHAT(f2.chatId))
  const db2 = new DatabaseSync(f2.store.rollbackArchivePath(f2.chatId))
  try {
    db2.prepare("UPDATE archive_head_fields SET value_json=? WHERE key='mode'").run(JSON.stringify('floating'))
    assert.throws(() => writeStatusBarPlacement(db2, { chatId: f2.chatId, placement: 'body' }), /不支持 mode/, '非 story/script 必须拒绝')
  } finally { db2.close() }
})

test('状态栏命令后变更索引与作者丢缓存后语义一致', async t => {
  // 真语义（chat-sqlite-store.js:1050-1057）：readChangedIndices = cachedState → changedIndices(chatId, state, revision)；
  // 缓存被丢弃后内存证据不足 ⇒ changedIndices 明确返回 undefined（:1054 注释），不得伪造日志连续性。
  const cmd = fixture(t, 'chat-statusbar-chg-cmd')
  const thr = fixture(t, 'chat-statusbar-chg-thr')
  await cmd.store.update(cmd.chatId, () => CHAT(cmd.chatId))
  await thr.store.update(thr.chatId, () => CHAT(thr.chatId))
  const revCmd = Number((await cmd.store.read(cmd.chatId))._storageRevision ?? 1)
  const revThr = Number((await thr.store.read(thr.chatId))._storageRevision ?? 1)
  const dbCmd = new DatabaseSync(cmd.store.rollbackArchivePath(cmd.chatId))
  try { writeStatusBarPlacement(dbCmd, { chatId: cmd.chatId, placement: 'body' }, { now: () => FIXED_NOW }) } finally { dbCmd.close() }
  await thr.store.update(thr.chatId, current => ({ ...current, _storageRevision: Number(current._storageRevision || 1) + 1, statusBarPlacement: 'body' }))
  // 公平对比：两侧都强制丢缓存（各开同 root 的新 store 实例＝空缓存），再比同一旧 revision 的变更索引
  const cmdFresh = createChatSqliteStore({ dataRoot: cmd.root, legacyData: undefined, helpers: HELPERS, now: () => FIXED_NOW })
  const thrFresh = createChatSqliteStore({ dataRoot: thr.root, legacyData: undefined, helpers: HELPERS, now: () => FIXED_NOW })
  let cmdChanged, thrChanged
  try {
    cmdChanged = await cmdFresh.readChangedIndices(cmd.chatId, revCmd)
    thrChanged = await thrFresh.readChangedIndices(thr.chatId, revThr)
  } finally { try { cmdFresh.dispose?.() } catch { /* 已释放 */ } ; try { thrFresh.dispose?.() } catch { /* 已释放 */ } }
  assert.equal(cmdChanged === undefined, thrChanged === undefined, '命令后与作者丢缓存后必须同为 undefined 或同为可证明增量')
  if (cmdChanged !== undefined && thrChanged !== undefined) {
    assert.deepEqual(new Set(cmdChanged.indices ?? []), new Set(thrChanged.indices ?? []), '若两侧都给证据，indices 集合必须相同')
  }
})

test('状态栏store级包装返回四字段且guards链路生效', async t => {
  const f = fixture(t, 'chat-statusbar-store')
  await f.store.update(f.chatId, () => CHAT(f.chatId))
  assert.equal(typeof f.store.setStatusBarPlacement, 'function', 'store 必须已接 setStatusBarPlacement（主接线）')
  // 诊断：先摊开现场（包装层 :1314-1335 判据＝existsSync(dbFile)）
  const dbPath = path.join(f.root, 'chats', f.chatId, 'archive.db')
  assert.equal(existsSync(dbPath), true, '诊断：权威 archive.db 必须存在于 dbFile 真路径 ' + dbPath)
  assert.equal(existsSync(f.store.rollbackArchivePath(f.chatId)), true, '诊断：rollbackArchivePath 指向的文件也必须存在')
  const first = await f.store.setStatusBarPlacement(f.chatId, { sessionId: 'session-statusbar-fixture', placement: 'body' })
  assert.deepEqual(Object.keys(first).sort(), ['changed', 'revision', 'statusBarPlacement', 'updatedAt'], '必须返回四字段形状')
  assert.equal(first.changed, true)
  assert.equal(first.statusBarPlacement, 'body')
  assert.equal(Number.isInteger(Number(first.revision)), true)
  assert.equal(Number(first.updatedAt), FIXED_NOW, 'updatedAt 必须取 store 固定时钟')
  const second = await f.store.setStatusBarPlacement(f.chatId, { placement: 'body' })
  assert.equal(second.changed, false, '同值必须 changed:false')
  assert.equal(Number(second.revision), Number(first.revision), '同值不得推 revision')
  await assert.rejects(() => f.store.setStatusBarPlacement(f.chatId, { placement: 'floating' }), /非法 placement/)
  await assert.rejects(() => f.store.setStatusBarPlacement(f.chatId, { sessionId: 'other-session', placement: 'body' }), /sessionId 不匹配/)
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId))
  try {
    db.exec(`DELETE FROM archive_head_fields WHERE key='${PLACEMENT_KEY}'`)
    await assert.rejects(() => f.store.setStatusBarPlacement(f.chatId, { placement: 'sidebar' }), /缺 statusBarPlacement|legacy|不支持/, '缺行（legacy 形状）必须拒绝')
  } finally { db.close() }
})
