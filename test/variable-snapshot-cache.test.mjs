// P0 定向断言（2026-10-05）：快照树缓存＋克隆出仓。
//
// 方案：[GEN-WINDOW-OPTIMIZATION-PLAN-2026-10-05](<../../../../docs/workstreams/plugin/GEN-WINDOW-OPTIMIZATION-PLAN-2026-10-05.md>)
// 边界：只测 variable-archive.js 的 hydrate 缓存行为，不跑全量、不碰真实存档、不网络。
//
// 断言（按方案"正确性约束"逐条）：
//   ① 二次 hydrate 变量 parse ≈ 0（命中缓存，不再重复 parse）
//   ② 返回的是**私有副本**：改返回值后再读不受污染（隔离语义不变）
//   ③ text===null 槽语义保留：仍是 null 且键存在（不因缓存退化成 undefined/洞）
//   ④ 写路径失效：prepareWrite 后缓存不再命中（与消息行 readCache/version bump 同生命周期）
//   ⑤ forget/dispose 失效
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createVariableArchive } = await import(pathToFileURL(path.join(here, '../lib/variable-archive.js')).href)

// JSON.parse 计数（只在窗口内计，包装不改值）
const realParse = JSON.parse
let parseCount = 0
JSON.parse = function (text, ...rest) { parseCount++; return realParse.call(JSON, text, ...rest) }
const countParse = fn => { parseCount = 0; const value = fn(); return { value, parse: parseCount } }

function fixture(count, { slotNull = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'va-snapcache-'))
  const db = new DatabaseSync(path.join(root, 'archive.db'))
  // archive_messages 是 previousMvu 的输入表；本测试只关心补数，建空表即可
  db.exec('CREATE TABLE IF NOT EXISTS archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT)')
  const archive = createVariableArchive({ handle: () => db })
  archive.ensureTables(db)
  const messages = []
  for (let i = 0; i < count; i++) {
    const slots = [{ stat_data: { hp: i }, schema: { type: 'object' } }]
    if (slotNull) slots.push(null)
    messages.push({ role: 'assistant', turn: i + 1, swipeId: 0, swipes: ['t'], text: 'body ' + i, variables: slots })
  }
  for (const index of messages.keys()) messages[index] = { ...messages[index] }
  // 一次批量写入：逐楼循环会产生 200 个独立 SQLite 事务，Windows tmpdir 每次提交 ~1.4s（实测 298s 全耗在这）。
  archive.prepareWrite(db, 'c1', { messages }, { touched: [...messages.keys()] })
  // K4 修剪后的行形态：variables 被剥离，读口按快照表补回
  const stripped = () => messages.map(row => ({ role: row.role, turn: row.turn, swipeId: row.swipeId, swipes: row.swipes, text: row.text }))
  const cleanup = () => { db.close(); assert.ok(path.basename(root).startsWith('va-snapcache-')); readdirSync(root, { recursive: true }); rmSync(root, { recursive: true, force: true }) }
  return { db, archive, stripped, messages, cleanup }
}

// ---------- ① 二次 hydrate parse ≈ 0 ----------
{
  const { db, archive, stripped, cleanup } = fixture(8)
  const first = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  const second = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  assert.equal(first.parse, 8, '首次 hydrate 每槽 parse 一次')
  assert.equal(second.parse, 0, '二次 hydrate 必须命中缓存、变量 parse=0')
  assert.deepEqual(second.value.messages[0].variables, first.value.messages[0].variables)
  assert.equal(second.value.messages[7].variables[0].stat_data.hp, 7, '补回的值仍是真值')
  cleanup()
}

// ---------- ② 返回私有副本：改返回值不污染缓存 ----------
{
  const { db, archive, stripped, cleanup } = fixture(4)
  const first = archive.hydrateChat(db, 'c1', { messages: stripped() })
  first.messages[1].variables[0].stat_data.hp = 999
  const second = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  assert.equal(second.value.messages[1].variables[0].stat_data.hp, 1, '改动返回树后再读不受污染（出仓是私有副本）')
  assert.equal(second.parse, 0, '污染后仍是缓存命中：parse=0 且值正确')
  // 快照行本身也不该被改动
  assert.equal(JSON.parse(db.prepare('SELECT tree_json FROM variable_snapshots WHERE message_index = 1').get().tree_json).stat_data.hp, 1,
    '库里的快照行字节不变')
  cleanup()
}

// ---------- ③ null 槽语义保留 ----------
{
  const { db, archive, stripped, cleanup } = fixture(3, { slotNull: true })
  const first = archive.hydrateChat(db, 'c1', { messages: stripped() })
  const second = archive.hydrateChat(db, 'c1', { messages: stripped() })
  for (const hydrated of [first, second]) {
    const slots = hydrated.messages[0].variables
    assert.equal(slots.length, 2, 'null 槽不得丢长度')
    assert.equal(slots[1], null, 'null 槽必须原样还原 null（不得退化成 undefined）')
    assert.ok(1 in slots, 'null 槽的键必须存在（不是洞）')
  }
  assert.equal(second.messages[0].variables[0].stat_data.hp, 0, '同楼的树槽照常缓存命中')
  cleanup()
}

// ---------- ④ 写路径失效 + ⑤ forget 失效 ----------
{
  const { db, archive, stripped, messages, cleanup } = fixture(5)
  countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  const warm = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  assert.equal(warm.parse, 0, '预热后命中')

  // 写一楼新真值（与消息行 readCache/version bump 同一次 prepareWrite）
  const edited = messages.map(row => ({ ...row }))
  edited[2] = { ...edited[2], variables: [{ stat_data: { hp: 222 }, schema: { type: 'object' } }] }
  archive.prepareWrite(db, 'c1', { messages: edited }, { touched: [2] })
  const afterWrite = countParse(() => archive.hydrateChat(db, 'c1', { messages: edited.map(row => { const copy = { ...row }; delete copy.variables; return copy }) }))
  assert.equal(afterWrite.value.messages[2].variables[0].stat_data.hp, 222, '写后读到新真值（不是缓存里的旧树）')
  assert.equal(afterWrite.parse, 5, '写后在库未变的前提下重新 parse 建缓存')

  archive.forget('c1')
  const afterForget = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  assert.equal(afterForget.parse, 5, 'forget 之后缓存不再命中')

  countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  archive.dispose()
  const afterDispose = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  assert.equal(afterDispose.parse, 5, 'dispose 之后缓存不再命中')
  cleanup()
}

// ---------- ⑥ 单楼/区间读口同样受益，且不改变可观察结果 ----------
{
  const { db, archive, stripped, cleanup } = fixture(6)
  const row = stripped()[3]
  const first = countParse(() => archive.hydrateRow(db, 'c1', 3, { ...row }))
  const second = countParse(() => archive.hydrateRow(db, 'c1', 3, { ...row }))
  assert.equal(first.parse, 1, 'hydrateRow 首次 parse 一次')
  assert.equal(second.parse, 0, 'hydrateRow 二次 parse=0')
  assert.equal(second.value.variables[0].stat_data.hp, 3)

  const rows = stripped().slice(1, 4)
  // 上面只预热了 3 楼 ⇒ 1、2 楼仍是冷槽（各 parse 一次），3 楼命中
  const rangeFirst = countParse(() => archive.hydrateRange(db, 'c1', 1, 4, rows.map(r => ({ ...r }))))
  assert.equal(rangeFirst.parse, 2, 'hydrateRange 复用已预热槽，只补冷槽')
  assert.deepEqual(rangeFirst.value.map(r => r.variables[0].stat_data.hp), [1, 2, 3])
  const rangeSecond = countParse(() => archive.hydrateRange(db, 'c1', 1, 4, rows.map(r => ({ ...r }))))
  assert.equal(rangeSecond.parse, 0, 'hydrateRange 二次 parse=0（全部命中）')
  assert.deepEqual(rangeSecond.value.map(r => r.variables[0].stat_data.hp), [1, 2, 3])
  cleanup()
}

// ---------- ⑦ 有界淘汰：超预算后仍正确（不假装无限缓存） ----------
{
  const root = mkdtempSync(path.join(os.tmpdir(), 'va-snapcache-'))
  const db = new DatabaseSync(path.join(root, 'archive.db'))
  db.exec('CREATE TABLE IF NOT EXISTS archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT)')
  const archive = createVariableArchive({ handle: () => db, maxSnapshotCacheEntries: 64 })
  archive.ensureTables(db)
  const messages = []
  for (let i = 0; i < 200; i++) messages.push({ role: 'assistant', turn: i + 1, swipeId: 0, swipes: ['t'], text: 'b' + i, variables: [{ stat_data: { hp: i }, schema: {} }] })
  for (const index of messages.keys()) messages[index] = { ...messages[index] }
  archive.prepareWrite(db, 'c1', { messages }, { touched: [...messages.keys()] })   // 同上：单次批量事务
  const stripped = () => messages.map(r => ({ role: r.role, turn: r.turn, swipeId: r.swipeId, swipes: r.swipes, text: r.text }))
  const hydrated = archive.hydrateChat(db, 'c1', { messages: stripped() })
  // 淘汰后重新补数仍必须给出全部正确真值（淘汰只影响速度，不影响语义）
  const again = countParse(() => archive.hydrateChat(db, 'c1', { messages: stripped() }))
  assert.deepEqual(again.value.messages.map(r => r.variables[0].stat_data.hp), hydrated.messages.map(r => r.variables[0].stat_data.hp),
    '有界淘汰后补数结果与首次一致')
  assert.equal(again.value.messages[199].variables[0].stat_data.hp, 199)
  db.close()
  assert.ok(path.basename(root).startsWith('va-snapcache-'))
  readdirSync(root, { recursive: true }); rmSync(root, { recursive: true, force: true })
}

console.log('variable-snapshot-cache: ①②③④⑤⑥⑦ 全部断言通过')
