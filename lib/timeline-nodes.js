// timeline 子键拆行（P2-a / D-5，2026-10-06 方案 issues/plan-p2-timeline-rows-and-memory-budget.md §1）。
//
// 表 archive_timeline_nodes(node_key TEXT PRIMARY KEY, ord INTEGER NOT NULL, value_json TEXT NOT NULL)：
//   '@meta'             = timeline 除 checkpoints/operations 外的全部键（标量＋participants，未来键自动落位）
//   'checkpoints#<seq>' = 每条 checkpoint 一行；ord＝数组序（连续 0..n-1）
//   'operations:<opId>' = 每条 operation 一行（opId 是稳定主键）
// archive_head_fields 保留 ('timeline', ord, 0, NULL) 占位行（键序参与，数据在子行表；同 messages 占位先例）。
//
// 写侧证据：diffJson（作者 json-mutation.js:22-53）数组只产生追加/截断 splice＋叶级 set、对象按键
// set/delete/递归到叶——path 级细粒度在写口入口就有，本模块把它映射到子行写集。
// 读侧契约：行级缓存必须同刀（实测拆行冷组装 9.78ms > 整键 parse 7.23ms，不缓存则读倒退）。
import { stmt } from './statement-cache.js'

const nodeForm = new WeakMap()

/** 本连接是否已是子行形态（v4）。ensureSchema 后恒为真；独立连接/手建库可能为旧形态。 */
export function usesTimelineNodes(db) {
  let flag = nodeForm.get(db)
  if (flag === undefined) {
    flag = Boolean(stmt(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_timeline_nodes'").get())
    nodeForm.set(db, flag)
  }
  return flag
}

export function ensureTimelineNodesTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS archive_timeline_nodes (
    node_key TEXT PRIMARY KEY,
    ord INTEGER NOT NULL,
    value_json TEXT NOT NULL
  )`)
  nodeForm.set(db, true)
}

const metaOf = timeline => {
  const meta = {}
  for (const key of Object.keys(timeline || {})) if (key !== 'checkpoints' && key !== 'operations') meta[key] = timeline[key]
  return meta
}
const checkpointsOf = timeline => Array.isArray(timeline?.checkpoints) ? timeline.checkpoints : []
const operationsOf = timeline => timeline?.operations && typeof timeline.operations === 'object' && !Array.isArray(timeline.operations) ? timeline.operations : {}

/**
 * changes（path 级）→ 子行写集。plan 字段：
 *   full            整条重写（['timeline'] 整键 set/delete、compact 强加、回退构造、防御）
 *   deleted         timeline 键被删除 → 清全部子行
 *   meta            @meta 行有变（标量/participants/未来键）
 *   checkpointWrites 叶级 set 的 checkpoint 下标集合
 *   spliceFrom      从该下标起重写尾部（splice/整组替换/数组元素 delete）
 *   operationWrites 要 UPSERT 的 operation id 集合
 *   rowDeletes      要 DELETE 的 node_key 集合（operations 删除键）
 */
export function computeTimelinePlan(changes, timeline) {
  const plan = { full: false, deleted: false, meta: false, checkpointWrites: new Set(), spliceFrom: Infinity, operationWrites: new Set(), rowDeletes: new Set() }
  if (timeline === undefined || timeline === null) { plan.full = true; plan.deleted = true; return plan }
  if (changes === null) { plan.full = true; return plan }
  for (const change of changes) {
    const path = change && change.path
    if (!Array.isArray(path)) continue
    // 审查修复①（2026-10-06）：根变更（path=[]）＝整档替换（applyJsonChangesShared 的 setValue 对
    // 空 path 直接返回整个 value）——changed 已标记全键，子行必须全量重写，否则 timeline 留旧值。
    if (path.length === 0) { plan.full = true; return plan }
    if (path[0] !== 'timeline') continue
    if (path.length === 1) { plan.full = true; return plan }
    const second = path[1]
    if (second === 'checkpoints') {
      if (change.op === 'splice' || change.op === 'delete' || path.length === 2) {
        // splice 恒尾部（diffValue）；patch 的中间 splice/元素 delete 同式"从 index 起重写尾部"覆盖。
        const index = Number(change.index ?? (Number.isSafeInteger(path[2]) ? path[2] : 0))
        plan.spliceFrom = Math.min(plan.spliceFrom, Number.isSafeInteger(index) && index >= 0 ? index : 0)
      } else {
        const index = Number(path[2])
        if (Number.isSafeInteger(index) && index >= 0) plan.checkpointWrites.add(index)
        else plan.spliceFrom = 0
      }
    } else if (second === 'operations') {
      if (path.length === 2) { plan.full = true; return plan }   // 整个 operations 对象被替换
      const id = path[2]
      if (change.op === 'delete' && path.length === 3) plan.rowDeletes.add('operations:' + id)
      else plan.operationWrites.add(String(id))
    } else {
      plan.meta = true
    }
  }
  return plan
}

/**
 * 按 plan 写子行（值取自权威 timeline 对象）。返回 {rows, full}：
 *   rows = 本次实际写入/删除的 node_key 列表（供投影行缓存精确失效）；
 *   full = 是否整条重写（行缓存全清）。
 * 调用方须处于事务内（writeChat / 迁移）。
 */
export function writeTimelineNodes(db, timeline, plan) {
  const upsert = stmt(db, 'INSERT INTO archive_timeline_nodes (node_key, ord, value_json) VALUES (?, ?, ?) ON CONFLICT(node_key) DO UPDATE SET ord=excluded.ord, value_json=excluded.value_json')
  const remove = stmt(db, 'DELETE FROM archive_timeline_nodes WHERE node_key=?')
  const touched = []
  if (plan.full) {
    stmt(db, 'DELETE FROM archive_timeline_nodes').run()
    if (plan.deleted) return { rows: [], full: true, deleted: true }
    const checkpoints = checkpointsOf(timeline), operations = operationsOf(timeline)
    upsert.run('@meta', -1, JSON.stringify(metaOf(timeline)))
    checkpoints.forEach((checkpoint, index) => upsert.run('checkpoints#' + index, index, JSON.stringify(checkpoint)))
    for (const [id, operation] of Object.entries(operations)) upsert.run('operations:' + id, -1, JSON.stringify(operation))
    return { rows: ['@meta', ...checkpoints.map((_c, index) => 'checkpoints#' + index), ...Object.keys(operations).map(id => 'operations:' + id)], full: true }
  }
  const checkpoints = checkpointsOf(timeline), operations = operationsOf(timeline)
  if (plan.meta) { upsert.run('@meta', -1, JSON.stringify(metaOf(timeline))); touched.push('@meta') }
  if (plan.spliceFrom !== Infinity) {
    const from = Math.max(0, Math.min(plan.spliceFrom, checkpoints.length))
    for (let index = from; index < checkpoints.length; index++) { upsert.run('checkpoints#' + index, index, JSON.stringify(checkpoints[index])); touched.push('checkpoints#' + index) }
    for (const row of stmt(db, "SELECT node_key, ord FROM archive_timeline_nodes WHERE node_key LIKE 'checkpoints#%'").all()) {
      if (Number(row.ord) >= checkpoints.length) { remove.run(row.node_key); touched.push(row.node_key) }
    }
  }
  for (const index of plan.checkpointWrites) {
    const nodeKey = 'checkpoints#' + index
    if (index < checkpoints.length) { upsert.run(nodeKey, index, JSON.stringify(checkpoints[index])); touched.push(nodeKey) }
    else { remove.run(nodeKey); touched.push(nodeKey) }
  }
  for (const id of plan.operationWrites) {
    const nodeKey = 'operations:' + id
    if (Object.hasOwn(operations, id)) { upsert.run(nodeKey, -1, JSON.stringify(operations[id])); touched.push(nodeKey) }
    else { remove.run(nodeKey); touched.push(nodeKey) }
  }
  for (const nodeKey of plan.rowDeletes) { remove.run(nodeKey); touched.push(nodeKey) }
  return { rows: touched, full: false }
}

/** 写后自检（fail-loud，同楼层行数自检哲学）：checkpoints 行 ord 连续且与权威数组等长。 */
export function verifyTimelineNodes(db, timeline) {
  const row = stmt(db, "SELECT COUNT(*) AS n, MIN(ord) AS lo, MAX(ord) AS hi FROM archive_timeline_nodes WHERE node_key LIKE 'checkpoints#%'").get()
  const expected = checkpointsOf(timeline).length
  const count = Number(row?.n || 0)
  if (count !== expected) throw new Error('timeline 子行自检失败：checkpoints 行数与 timeline 不一致（rows=' + count + ' timeline=' + expected + '）')
  if (count > 0 && (Number(row.lo) !== 0 || Number(row.hi) !== count - 1)) {
    throw new Error('timeline 子行自检失败：checkpoints ord 不连续（lo=' + row.lo + ' hi=' + row.hi + ' n=' + count + '）')
  }
}

/**
 * 组装 timeline 树。cache＝可选 Map<node_key, parsed>（行级缓存）：
 *   冷（cache 空/缺）→ 一条全行查询＋parse 全部；热 → 零 SQL（键列表小查询＋缓存命中）；
 *   增量（写后）→ 只重读缺失行。
 * options.detach===true ⇒ 出仓前把行对象复制一份再交出（@meta 整行复制、其余行浅复制）：
 *   行缓存是跨调用长期持有的，而作者侧确有就地改 `chat.timeline.operations[x].status` /
 *   `chat.timeline.participants.background.status` 的写法（story-timeline.js），把缓存里的对象
 *   直接交给可能改它的调用方会把缓存污染成"下一次读到旧值"。复制一行只是几十个键的展开，
 *   相对整表 >= 30MB 重解析可以忽略。
 * 返回 {value, added}：added＝本次新 parse 并入缓存的 [nodeKey, value] 列表（供调用方记账）。
 * checkpoints/operations 恒为 array/object（作者 schema 常态；空容器也保留键，避免往返丢键产生伪 diff）。
 */
export function readTimelineTree(db, cache, options = {}) {
  const timeline = {}
  const checkpoints = []
  let operations
  const added = []
  let seen = 0
  // @meta 是标量＋participants 的小行：整行复制（participants 里的对象也可能被就地改）。
  const copyMeta = value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const copy = {}
    for (const key of Object.keys(value)) {
      const child = value[key]
      copy[key] = child !== null && typeof child === 'object' && !Array.isArray(child) ? { ...child } : child
    }
    return copy
  }
  const copyRow = value => (options?.detach === true && value !== null && typeof value === 'object' && !Array.isArray(value)) ? { ...value } : value
  const consume = (nodeKey, ord, text) => {
    seen++
    let value = cache ? cache.get(nodeKey) : undefined
    if (value === undefined) {
      value = JSON.parse(text)
      if (cache) { cache.set(nodeKey, value); added.push([nodeKey, value]) }
    }
    if (nodeKey === '@meta') Object.assign(timeline, copyMeta(value))
    else if (nodeKey.startsWith('checkpoints#')) checkpoints[ord] = copyRow(value)
    else if (nodeKey.startsWith('operations:')) (operations ||= {})[nodeKey.slice(11)] = copyRow(value)
  }
  if (!cache || cache.size === 0) {
    for (const row of stmt(db, 'SELECT node_key, ord, value_json FROM archive_timeline_nodes').all()) consume(row.node_key, Number(row.ord), row.value_json)
  } else {
    for (const row of stmt(db, 'SELECT node_key, ord FROM archive_timeline_nodes').all()) {
      if (cache.has(row.node_key)) { consume(row.node_key, Number(row.ord), null); continue }
      const text = stmt(db, 'SELECT value_json FROM archive_timeline_nodes WHERE node_key=?').get(row.node_key)?.value_json
      if (text != null) consume(row.node_key, Number(row.ord), text)
    }
  }
  if (seen === 0) return { value: undefined, added }        // 无子行＝timeline 缺席（不造空容器伪键）
  timeline.checkpoints = checkpoints
  timeline.operations = operations || {}
  return { value: timeline, added }
}
