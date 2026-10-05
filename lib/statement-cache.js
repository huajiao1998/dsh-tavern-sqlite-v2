// prepared 语句连接级缓存（2026-10-05 修 B：治"每次调用 db.prepare"热点）。
//
// node:sqlite 的 db.prepare() 每次都解析 SQL 并创建语句对象——readProjectionHeader 5.4%
// 非空闲、parse 1.9% 部分来自这里。WeakMap 按连接缓存，连接回收时缓存自动释放；
// 同一 SQL 只 prepare 一次，后续调用直接复用语句对象。
//
// 线程安全：node:sqlite 的 DatabaseSync 在单线程事件循环中使用，语句对象
// 在 get/all/run 完成后自动重置，无交叉迭代冲突。
const caches = new WeakMap()

/**
 * 取（或创建并缓存）连接级 prepared 语句。
 * @param {import('node:sqlite').DatabaseSync} db - 数据库连接
 * @param {string} sql - SQL 文本（作为缓存键，同 SQL 同语句）
 * @returns {import('node:sqlite').StatementSync} 已 prepared 的语句对象
 */
export function stmt(db, sql) {
  let bySql = caches.get(db)
  if (!bySql) {
    bySql = new Map()
    caches.set(db, bySql)
  }
  let s = bySql.get(sql)
  if (!s) {
    s = db.prepare(sql)
    bySql.set(sql, s)
  }
  return s
}
