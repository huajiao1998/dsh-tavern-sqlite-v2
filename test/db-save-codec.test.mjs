// 只验新增白名单SQL快照边界，全部为独占合成数据库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { restoreDatabase, inspectDatabase, snapshotDatabase, encodeDbSave, decodeDbSave, watchDbSaveSources } from '../lib/db-save-codec.js'
function tables() {
  return { meta: [{ key: 'schema_version', value: '1' }], sessions: [{ id: 'session-dummy-codec', header_json: '{"id":"session-dummy-codec","version":1,"createdAt":1}', format_version: 1, created_at: 1, inherited_event_count: 0, event_count: 1 }], events: [{ seq: 0, type: 'turn/end', time: 1, data_json: '{"turn":1}', extra_json: null }] }
}
function files(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-db-codec-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { source: path.join(root, 'source.db'), output: path.join(root, 'output.db') }
}
test('DB快照读WAL已提交事件源字节不改', t => {
  const f = files(t); restoreDatabase(f.source, 'native', tables())
  const db = new DatabaseSync(f.source); db.exec('PRAGMA journal_mode=WAL')
  try {
    db.exec("INSERT INTO events VALUES(1,'session/title',2,'{\"title\":\"WAL合成\"}',NULL); UPDATE sessions SET event_count=2")
    const main = readFileSync(f.source)
    snapshotDatabase(f.source, f.output, 'native')
    assert.equal(inspectDatabase(f.output, 'native').tables.events.length, 2)
    assert.deepEqual(readFileSync(f.source), main)
  } finally { db.close() }
})
test('DB导入拒外来trigger且不执行schema', t => {
  const f = files(t); restoreDatabase(f.source, 'native', tables())
  const db = new DatabaseSync(f.source)
  db.exec('CREATE TRIGGER bad AFTER INSERT ON events BEGIN DELETE FROM sessions; END'); db.close()
  assert.throws(() => snapshotDatabase(f.source, f.output, 'native'), /视图\/触发器/)
  assert.equal(existsSync(f.output), false)
})
test('DB原生事件断序计数与核心覆盖前置拒绝', t => {
  const f = files(t), value = tables()
  value.events[0].seq = 3
  assert.throws(() => restoreDatabase(f.output, 'native', value), /坐标不连续/)
  value.events[0].seq = 0; value.sessions[0].event_count = 2
  assert.throws(() => restoreDatabase(f.output, 'native', value), /事件计数不一致/)
  value.sessions[0].event_count = 1; value.events[0].extra_json = '{"seq":2}'
  assert.throws(() => restoreDatabase(f.output, 'native', value), /覆盖核心字段/)
  assert.equal(existsSync(f.output), false)
})
test('DB ZIP存储格式往返及CRC缺损拒绝', t => {
  const f = files(t); restoreDatabase(f.source, 'native', tables())
  const manifest = { format: 'dsh-tavern-sqlite-save', formatVersion: 1, storage: 'sqlite', source: { chatId: 'chat-dummy-codec', sessionId: 'session-dummy-codec' }, sessions: ['session-dummy-codec'], resources: [] }
  const data = readFileSync(f.source), packed = encodeDbSave({ manifest, archive: data, sessions: [{ id: 'session-dummy-codec', data }], resources: [] })
  const unpacked = decodeDbSave(packed)
  assert.deepEqual(unpacked.archive, data); assert.deepEqual(unpacked.manifest, manifest)
  const corrupted = Buffer.from(packed); corrupted[100] ^= 1
  assert.throws(() => decodeDbSave(corrupted), /CRC|不一致|清单/)
  const unsafe = { ...manifest, resources: ['../escape'] }
  assert.throws(() => encodeDbSave({ manifest: unsafe, archive: data, sessions: [{ id: 'session-dummy-codec', data }], resources: [{ path: '../escape', data }] }), /路径危险/)
})
test('DB多库稳定观察捕获共同静止边界', t => {
  const f = files(t)
  restoreDatabase(f.source, 'native', tables())
  restoreDatabase(f.output, 'native', tables())
  const watch = watchDbSaveSources([f.source, f.output])
  try {
    watch.assertStable()
    const first = snapshotDatabase(f.source, path.join(path.dirname(f.source), 'capture-a.db'), 'native')
    const second = snapshotDatabase(f.output, path.join(path.dirname(f.source), 'capture-b.db'), 'native')
    watch.assertStable()
    assert.equal(first.tables.events.length, 1)
    assert.equal(second.tables.events.length, 1)
    assert.equal(first.tables.sessions[0].event_count, second.tables.sessions[0].event_count)
  } finally { watch.close() }
  assert.throws(() => watch.assertStable(), /观察已关闭/)
})
test('DB多库稳定观察拒外部连接提交', t => {
  const f = files(t)
  restoreDatabase(f.source, 'native', tables())
  restoreDatabase(f.output, 'native', tables())
  const setup = new DatabaseSync(f.source); setup.exec('PRAGMA journal_mode=WAL'); setup.close()
  const watch = watchDbSaveSources([f.source, f.output])
  try {
    watch.assertStable()
    const outside = new DatabaseSync(f.source)
    try { outside.exec("INSERT INTO events VALUES(1,'session/title',2,'{\"title\":\"外部提交\"}',NULL); UPDATE sessions SET event_count=2") } finally { outside.close() }
    assert.throws(() => watch.assertStable(), /提交或替换/)
  } finally { watch.close() }
})
test('DB交换拒绝同列名异类型及主键schema且源字节不变', t => {
  const f = files(t), root = path.dirname(f.source)
  restoreDatabase(f.source, 'native', tables())
  const before = readFileSync(f.source)
  // 合法 trusted schema 仍须通过（一次）
  assert.equal(inspectDatabase(f.source, 'native').tables.events.length, 1)
  // ① 同列名异类型：events.seq 声明为 TEXT（ALTER 不能改列型 ⇒ 按 trusted DDL 重建包DB，仅 test 自有 temp）
  const wrongType = path.join(root, 'mutated-type.db'), dbA = new DatabaseSync(wrongType)
  dbA.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
  dbA.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,header_json TEXT NOT NULL,format_version INTEGER NOT NULL,created_at INTEGER NOT NULL,inherited_event_count INTEGER NOT NULL DEFAULT 0,event_count INTEGER NOT NULL DEFAULT 0)')
  dbA.exec('CREATE TABLE events(seq TEXT PRIMARY KEY,type TEXT NOT NULL,time INTEGER NOT NULL,data_json TEXT NOT NULL,extra_json TEXT)')
  dbA.close()
  assert.throws(() => inspectDatabase(wrongType, 'native'), /schema列类型或主键不兼容/)
  // ② 同列名但 sessions.id 非主键
  const wrongPk = path.join(root, 'mutated-pk.db'), dbB = new DatabaseSync(wrongPk)
  dbB.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
  dbB.exec('CREATE TABLE sessions(id TEXT,header_json TEXT NOT NULL,format_version INTEGER NOT NULL,created_at INTEGER NOT NULL,inherited_event_count INTEGER NOT NULL DEFAULT 0,event_count INTEGER NOT NULL DEFAULT 0)')
  dbB.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY,type TEXT NOT NULL,time INTEGER NOT NULL,data_json TEXT NOT NULL,extra_json TEXT)')
  dbB.close()
  assert.throws(() => inspectDatabase(wrongPk, 'native'), /schema列类型或主键不兼容/)
  // 只读检查：源文件字节未被改写
  assert.deepEqual(readFileSync(f.source), before)
})
test('DB原生头部版本与行版本不一致在恢复前拒绝', t => {
  const f = files(t)
  // 头部 version 2 与行 format_version 1 不一致：恢复前拒，不落任何输出
  const mismatched = tables()
  mismatched.sessions[0].header_json = JSON.stringify({ ...JSON.parse(mismatched.sessions[0].header_json), version: 2 })
  assert.throws(() => restoreDatabase(f.source, 'native', mismatched), /协议版本不一致/)
  assert.equal(existsSync(f.source), false)
  // 头部 version 非正整数同样拒（只要求 integer>=1；支持版本集合由同代宿主严格校验负责，不在此锁值）
  const zero = tables()
  zero.sessions[0].header_json = JSON.stringify({ ...JSON.parse(zero.sessions[0].header_json), version: 0 })
  assert.throws(() => restoreDatabase(f.source, 'native', zero), /数值无效：header\.version/)
  assert.equal(existsSync(f.source), false)
  // 合法：header.version === format_version（仅证明本层 SQL 关系自洽，不代表同代 SDK 支持该版本）
  const ok = tables()
  restoreDatabase(f.output, 'native', ok)
  assert.equal(inspectDatabase(f.output, 'native').tables.sessions[0].format_version, 1)
})
function archiveTables() {
  return {
    archive_head: [{ id: 1, revision: 1, updated_at: 1 }],
    archive_head_fields: [
      { key: 'id', ord: 0, kind: 0, value_json: '"chat-codec-x"' },
      { key: 'sessionId', ord: 1, kind: 0, value_json: '"session-codec-x"' },
      { key: 'messages', ord: 2, kind: 1, value_json: null }
    ],
    archive_messages: [{ message_index: 0, message_json: '{"role":"assistant","turn":1,"text":"正文"}' }],
    archive_timeline_nodes: [], variable_snapshots: [], variable_state: [], archive_worldbook_history: []
  }
}
test('DB消息占位结构冲突在恢复目标前拒绝', t => {
  const f = files(t)
  // 合法：messages 占位 kind=1/value_json=null（缺该键时按占位回退组装，不要求存在）
  restoreDatabase(f.output, 'archive', archiveTables())
  assert.equal(inspectDatabase(f.output, 'archive').head.messages.length, 1)
  // 冲突：key=messages 但 kind=0 且 value_json 非空 → 恢复目标前拒
  const broken = archiveTables()
  broken.archive_head_fields = broken.archive_head_fields.map(row => row.key === 'messages' ? { ...row, kind: 0, value_json: '"a"' } : row)
  assert.throws(() => restoreDatabase(f.source, 'archive', broken), /消息占位结构冲突/)
  assert.equal(existsSync(f.source), false)
})
