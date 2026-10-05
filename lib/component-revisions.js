// 分部件版本号（2026-10-05 修 A：治"写一次清空全部读缓存"）。
//
// 现状：archive_head.revision 是全局计数器，每次写都 bump → 投影缓存整体作废。
// 改法：在连接级维护两个独立部件版本（header/messages），写口按实际改动范围
// 只 bump 受影响的部件 → 投影缓存只失效受影响的组件。
//
// 安全性：DB revision 仍每次写都递增（跨进程安全）；部件版本只用于本进程内
// 的精确失效。若 DB revision 变化但部件版本未变（外部写入），退化为全量失效。
const revs = new WeakMap()

/**
 * 取（或初始化）连接的部件版本对。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{header: number, messages: number}} 可变对象（直接 ++ 即 bump）
 */
export function revisions(db) {
  let r = revs.get(db)
  if (!r) { r = { header: 0, messages: 0 }; revs.set(db, r) }
  return r
}
