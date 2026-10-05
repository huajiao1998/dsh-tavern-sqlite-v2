// 定向回归：原档只读；旧同 ID 迁移入口零写入并响亮拒绝；非本插件 stamp 不冒充数据库档。
// 只用 Node 内置：node test/save-format.test.mjs
import assert from 'node:assert/strict'
import { describeSaveFormat, migrateSave, runSaveAction, formatSaveResult } from '../lib/migration-ops.js'

// 1) 原档可看不可玩，必须用户手动显式分叉；status只查询格式。
const legacy = await describeSaveFormat({ chats: { version: async () => 'legacy:1234:5678' }, chatId: 'c1' })
assert.deepEqual(legacy, { migrated: false, legacy: true, readonly: true, playable: false, stamp: 'legacy:1234:5678' })
assert.match(formatSaveResult(legacy), /旧格式/)
assert.match(formatSaveResult(legacy), /只读，可看不可玩/)
assert.match(formatSaveResult(legacy), /必须手动显式分叉迁移/)
const legacyStatus = await runSaveAction({ chats: { version: async () => legacy.stamp }, chatId: 'c1', action: 'status' })
assert.deepEqual(legacyStatus, { ...legacy, changed: false })

// 2) 独立数据库档保持正常可写可玩；changed文案明确是新分叉、原档未改动。
const migrated = await describeSaveFormat({ chats: { version: async () => 'sqlite:gen:3' }, chatId: 'c1' })
assert.deepEqual(migrated, { migrated: true, legacy: false, readonly: false, playable: true, stamp: 'sqlite:gen:3' })
assert.equal(formatSaveResult(migrated), '已使用数据库存档')
const dbStatus = await runSaveAction({ chats: { version: async () => migrated.stamp }, chatId: 'c1' })
assert.deepEqual(dbStatus, { ...migrated, changed: false })
const forkText = formatSaveResult({ ...migrated, changed: true })
assert.match(forkText, /已创建独立的 SQLite 分叉存档/)
assert.match(forkText, /原档未改动/)
assert.match(forkText, /在新档继续游玩/)

// 2b) 合法的 :empty stamp 仍属于本插件SQLite语义，保留既有格式兼容。
const emptyDb = await describeSaveFormat({ chats: { version: async () => 'sqlite:gen:0:empty' }, chatId: 'c1' })
assert.equal(emptyDb.migrated, true)
assert.equal(emptyDb.legacy, false)
assert.equal(emptyDb.readonly, false)
assert.equal(emptyDb.playable, true)

// 3) 作者/未知/形似但不合法的 stamp 一律拒绝，不靠前缀假称数据库档。
for (const stamp of ['journal:abc123', 'legacy:', 'legacy:not-a-size:1', 'legacy:1:2:extra', 'sqlite:gen:', 'sqlite:gen:unknown', 'sqlite:gen:1:unexpected']) {
  await assert.rejects(
    () => describeSaveFormat({ chats: { version: async () => stamp }, chatId: 'c1' }),
    /不是本插件的 SQLite 实现/,
  )
}

// 3b) 空串表示不存在，不能把错误Session身份当新档状态。
await assert.rejects(
  () => describeSaveFormat({ chats: { version: async () => '' }, chatId: 'session-xxx' }),
  /找不到本局存档/,
)

// 4) 缺接口、缺chatId和未知动作仍明确报错。
await assert.rejects(() => describeSaveFormat({ chats: {}, chatId: 'c1' }), /缺少 chats\.version/)
await assert.rejects(() => runSaveAction({ chats: {}, chatId: '', action: 'status' }), /缺少 chatId/)
await assert.rejects(() => runSaveAction({ chats: {}, chatId: 'c1', action: 'unknown' }), /未知的存档动作/)

// 5) migrate仍先验证stamp；非本插件实现的错误优先，绝不调用update。
let foreignWrites = 0
const foreign = { version: async () => 'journal:abc123', update: async () => { foreignWrites++ } }
await assert.rejects(
  () => runSaveAction({ chats: foreign, chatId: 'c1', action: 'migrate' }),
  /不是本插件的 SQLite 实现/,
)
await assert.rejects(() => migrateSave({ chats: foreign, chatId: 'c1' }), /不是本插件的 SQLite 实现/)
assert.equal(foreignWrites, 0)

// 6) 原档即使提供能改stamp的update，同ID迁移仍拒绝、0writes、原stamp不变。
let stamp = 'legacy:10:20'
const writes = []
const chats = {
  version: async () => stamp,
  update: async (...args) => { writes.push(args); stamp = 'sqlite:gen:1' },
}
const forkRequired = error => error?.code === 'DSH_TAVERN_EXPLICIT_FORK_REQUIRED' && error.chatId === 'c1'
  && error.stamp === 'legacy:10:20' && /请使用显式分叉迁移流程/.test(error.message)
await assert.rejects(() => runSaveAction({ chats, chatId: 'c1', action: 'migrate' }), forkRequired)
await assert.rejects(() => migrateSave({ chats, chatId: 'c1' }), forkRequired)
assert.equal(writes.length, 0)
assert.equal(stamp, 'legacy:10:20')
assert.deepEqual(await runSaveAction({ chats, chatId: 'c1', action: 'status' }), {
  migrated: false, legacy: true, readonly: true, playable: false, stamp: 'legacy:10:20', changed: false,
})
// 不依赖update接口才能拒绝，更不会让调用者以缺接口误判失败原因。
await assert.rejects(() => migrateSave({ chats: { version: chats.version }, chatId: 'c1' }), forkRequired)

// 7) 已是SQLite也不能使用废除的migrate动作，避免旧UI/工具静默冒充手动分叉。
let dbWrites = 0
const db = { version: async () => 'sqlite:gen:3', update: async () => { dbWrites++ } }
await assert.rejects(() => runSaveAction({ chats: db, chatId: 'c1', action: 'migrate' }), /请使用显式分叉迁移流程/)
assert.equal(dbWrites, 0)
assert.equal((await runSaveAction({ chats: db, chatId: 'c1', action: 'status' })).playable, true)

console.log('save-format：原档只读状态、SQLite可玩状态、stamp严格判定、同ID迁移拒绝/零写入、独立分叉文案通过')
