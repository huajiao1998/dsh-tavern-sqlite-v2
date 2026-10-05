// 修B：prepared 语句连接级缓存专项验证（2026-10-05）。
// 覆盖：同 SQL 同连接返回同一语句对象（===）、不同连接各自缓存、
// 不同 SQL 各自语句、语句功能等价（get/all 结果与直接 prepare 一致）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { stmt } from '../lib/statement-cache.js'

test('stmt：同连接同SQL返回同一语句对象（零重解析）', () => {
  // 用一个假 db 对象：prepare 只在首次调用，后续命中缓存
  let prepareCount = 0
  const fakeDb = {
    prepare(sql) {
      prepareCount++
      return { sql, marker: `stmt-${prepareCount}` }
    }
  }
  const a = stmt(fakeDb, 'SELECT 1')
  const b = stmt(fakeDb, 'SELECT 1')
  assert.strictEqual(a, b, '同连接同SQL应返回同一语句对象')
  assert.strictEqual(prepareCount, 1, 'prepare 只调用一次')
  const c = stmt(fakeDb, 'SELECT 2')
  assert.notStrictEqual(a, c, '不同SQL各自语句')
  assert.strictEqual(prepareCount, 2, '新SQL触发一次prepare')
})

test('stmt：不同连接各自缓存', () => {
  const db1 = { prepare: sql => ({ sql, conn: 'db1' }) }
  const db2 = { prepare: sql => ({ sql, conn: 'db2' }) }
  const s1 = stmt(db1, 'SELECT 1')
  const s2 = stmt(db2, 'SELECT 1')
  assert.notStrictEqual(s1, s2, '不同连接各自语句')
  assert.strictEqual(s1.conn, 'db1')
  assert.strictEqual(s2.conn, 'db2')
  assert.strictEqual(stmt(db1, 'SELECT 1'), s1, 'db1 缓存命中')
})

test('stmt：功能等价（真 node:sqlite）', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t VALUES(1,?), (2,?)').run('a', 'b')
  const s1 = stmt(db, 'SELECT v FROM t WHERE k=?')
  const s2 = stmt(db, 'SELECT v FROM t WHERE k=?')
  assert.strictEqual(s1, s2, '缓存命中')
  assert.strictEqual(s1.get(1).v, 'a')
  assert.strictEqual(s2.get(2).v, 'b', '复用语句换参执行正确')
  const all = stmt(db, 'SELECT v FROM t ORDER BY k').all()
  assert.deepStrictEqual(all.map(r => r.v), ['a', 'b'])
  db.close()
})
