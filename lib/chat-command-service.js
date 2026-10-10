// S3：数据库原生标量命令（状态栏位置）。
// 合同（设计名，非官方 API）：writeStatusBarPlacement(db, { chatId, sessionId, placement }, guards)
//   -> { changed: boolean, statusBarPlacement: string, revision: number }
// 事务（设计 §7.2）：BEGIN IMMEDIATE → 窄读（head revision/updated_at；head_fields 的 id/sessionId/mode/
// 当前 placement 及其 ord；timeline 身份只点读 @meta，不读消息/不读 timeline 全文）→ 同步 guard →
// 同值 no-op 直接返回（**逐字复现作者 update() 语义**）→ UPDATE head_fields 该行 value_json（保 ord/kind/键序占位）
// → `UPDATE archive_head SET revision=revision+1, updated_at=? WHERE id=1 AND revision=<进入时读到的>` 要求 changes=1
// → COMMIT → 交由注入的 onCommitted 做 bumpGeneration / projectionReads.invalidate / recentChanges / 全文缓存失效
//   （这些是 store 内部能力，本服务不改 store，故以钩子接线；绝不把局部对象 remember 成完整态）。
//
// 等价依据（已读源码）：
//  - chat-sqlite-store.js:794-795：非首写时 `changes = diffJson(current,next)`；**changes 为空即 `return copyJsonTree(current)`**
//    ⇒ 同值不写、不推 revision、不改 updated_at ⇒ 本命令同值必须 no-op（不得发明写入）。
//  - :792-793：revision 必须恰为 baseRevision + 1（作者路径按 `_storageRevision` 递增）。
//  - :264-276：head_fields 写入格式＝`INSERT … ON CONFLICT(key) DO UPDATE SET ord=excluded.ord, kind=excluded.kind,
//    value_json=excluded.value_json`，`ord` 取该键在 chat 键序中的下标、kind=0、值 `jsonText(value)`；只写变化键。
//    ⇒ 本命令只 UPDATE 既有行的 value_json（ord/kind 不动，保持键序占位）。
import { isDeepStrictEqual } from 'node:util'
import { stmt } from './statement-cache.js'
import { computeTimelinePlan, writeTimelineNodes, verifyTimelineNodes } from './timeline-nodes.js'

export const STATUS_BAR_PLACEMENTS = Object.freeze(['sidebar', 'body'])
export const SUPPORTED_MODES = Object.freeze(['story', 'script'])
export const PLACEMENT_KEY = 'statusBarPlacement'

function parseValue(text) {
  if (text === null || text === undefined) return undefined
  return JSON.parse(text)     // 损坏 JSON 必须上抛，不 catch 成缺字段
}

function readHeadField(db, key) {
  const row = stmt(db, 'SELECT value_json FROM archive_head_fields WHERE key=? AND kind=0').get(key)
  return parseValue(row?.value_json)
}

function readPlacementRow(db) {
  const row = stmt(db, `SELECT ord, kind FROM archive_head_fields WHERE key=?`).get(PLACEMENT_KEY)
  return row ?? null
}

/**
 * @param {object} db 与产品 store 同一 SQLite 句柄（调用方注入）
 * @param {{chatId:string, sessionId?:string, placement:string}} input
 * @param {{assertWritableChat?:Function, now?:Function, onCommitted?:Function}} guards
 * @returns {{changed:boolean, statusBarPlacement:string, revision:number}}
 */
export function writeStatusBarPlacement(db, { chatId, sessionId, placement } = {}, guards = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('状态栏命令需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('状态栏命令缺少 chatId')
  if (!STATUS_BAR_PLACEMENTS.includes(placement)) throw new Error('非法 placement：' + String(placement))
  const now = typeof guards.now === 'function' ? guards.now : Date.now
  const assertWritableChat = guards.assertWritableChat
  let started = false
  try {
    db.exec('BEGIN IMMEDIATE')
    started = true
    if (typeof assertWritableChat === 'function') assertWritableChat(chatId)
    const head = stmt(db, 'SELECT revision, updated_at FROM archive_head WHERE id=1').get()
    if (!head) throw new Error('状态栏命令：目标档不存在（无 archive_head）')
    const revision = Number(head.revision)
    if (!Number.isInteger(revision)) throw new Error('状态栏命令：head revision 非法')
    // 身份（窄读：只 id/sessionId/mode）
    const identity = { chatId: readHeadField(db, 'id'), sessionId: readHeadField(db, 'sessionId') }
    if (identity.chatId === undefined) throw new Error('状态栏命令：head 未记录 id')
    if (identity.chatId !== chatId) throw new Error(`状态栏命令 chatId 不匹配：期望 ${chatId}，实际 ${identity.chatId}`)
    if (typeof sessionId === 'string' && sessionId !== '' && identity.sessionId !== sessionId) {
      throw new Error(`状态栏命令 sessionId 不匹配：期望 ${sessionId}，实际 ${identity.sessionId}`)
    }
    const mode = readHeadField(db, 'mode')
    const effectiveMode = typeof mode === 'string' && mode !== '' ? mode : 'story'
    if (!SUPPORTED_MODES.includes(effectiveMode)) throw new Error('状态栏命令不支持 mode：' + String(mode))
    // timeline 身份只点读 @meta（不读消息、不读 timeline 全文）
    const hasNodes = Boolean(stmt(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_timeline_nodes'").get())
    if (hasNodes) {
      const metaRow = stmt(db, "SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get()
      if (metaRow) {
        const meta = parseValue(metaRow.value_json)
        if (meta && typeof meta === 'object' && Number(meta.schemaVersion) !== 1) throw new Error('状态栏命令：timeline schema 非 1')
      }
    }
    const row = readPlacementRow(db)
    if (row === null) throw new Error('状态栏命令：head_fields 缺 ' + PLACEMENT_KEY + ' 行（旧代/未知形状）')   // legacy 拒绝，不发明键
    const current = readHeadField(db, PLACEMENT_KEY)
    if (current === placement) {
      // 同值 no-op：与作者 update() 的 `changes.length===0 ⇒ return current` 逐字等价（不写、不推 revision）
      db.exec('COMMIT'); started = false        // 必须先结束写事务（BEGIN IMMEDIATE 不得悬挂：否则持写锁/钉快照）
      return { changed: false, statusBarPlacement: placement, revision }
    }
    stmt(db, 'UPDATE archive_head_fields SET value_json=? WHERE key=? AND kind=0').run(JSON.stringify(placement), PLACEMENT_KEY)
    const bumped = stmt(db, 'UPDATE archive_head SET revision=revision+1, updated_at=? WHERE id=1 AND revision=?').run(now(), revision)
    const changes = Number(bumped?.changes ?? 0)
    if (changes !== 1) throw new Error(`状态栏命令 CAS 失败：revision 已变化（期望 ${revision}，changes=${changes}）`)
    db.exec('COMMIT')
    started = false
    if (typeof guards.onCommitted === 'function') {
      guards.onCommitted({ chatId, revision: revision + 1, keys: [PLACEMENT_KEY], timeline: false, source: 'ui.status-bar-placement' })
    }
    return { changed: true, statusBarPlacement: placement, revision: revision + 1 }
  } catch (error) {
    if (started) { try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错 */ } }
    throw error
  }
}

// _internals 统一在文件尾导出（避免在函数定义之前引用造成 TDZ）

// ══════════════════════════════════════════════════════════════════════════════════
// S5：楼层级数据库原生命令（追加 / 单楼 set）
//
// 合同（内部设计名，非官方 API）：
//   appendMessages(db, { chatId, sessionId?, revision, items, headerSets? }, guards)
//   setMessageFloor(db, { chatId, sessionId?, revision, index, patch }, guards)
//     -> { changed:true, revision, updatedAt, messageCount, head } | undefined（CAS 不符，与 patch:722 同）
//   guards = { assertWritableChat?, now?, onCommitted?, applyMessageWrite?, projectHead?, headerSets?,
//              archiveLocalWrite }
//     · applyMessageWrite / onCommitted 二者同义（store 侧提交完成钩子；优先 applyMessageWrite）。载荷：
//       { chatId, revision:新, keys:头键, messages:true, timeline:false, changes:[头sets…, splice/叶子…], written }。
//       命令**不把局部对象 remember 成完整态**（设计 §7.3）：generation/invalidate/recentChanges/全文缓存
//       失效一律交该钩子。
//     · projectHead?(db, chatId, revision) → 头投影（store 用 `slice(state.chat, []).chat` 同形供，含新
//       `_storageRevision`）。缺省用本地窄投影（键序按 ord、跳过 messages 占位、timeline 占位不物化）。
//     · archiveLocalWrite(db, chatId, touchedRows:Map, messageCount, { truncated }) → { stripped:Map, written:number[] }
//       必须由 store 注入 lib/variable-archive.js 的 `prepareLocalWrite`（同实例＝同 pruneEnabled/hotWindow）。
//       命令**不 import 变量归档**：否则会拿到第二份实例，配置不同源。
//     · setMessageFloor 也接受 guards.headerSets（与单楼 patch 同一事务的头 sets）。
//
// 等价依据（已读源码）：
//  · 事务/CAS/提交完成：同本文件 :53/:88-90/:97-99（S3）；chat-sqlite-store.js:364-365（head UPSERT）、
//    :741（patch `revisionOf(next)!==expectedRevision+1` 拒写）、:720/:722（CAS 不符返回 undefined、空 changes 零写返头）。
//  · 变量归档：lib/variable-archive.js:847-873 `prepareLocalWrite`（captureRow 先归档 → refreshStateLocal →
//    K4 pruneRowsLocal fail-closed(:807-810) → bumpRevision(written) → refreshHotLocal）。命令绝不自己动 variables。
//  · 楼行：store:350-352（`message_index/message_json` UPSERT + `jsonText(row,'null')`）、:357（截断只 DELETE>=length）、
//    :354（按 written 写行）；纯尾判定 :311-321（pureAppend＝from===prevCount && dropped===0）。
//  · 叶子语义（设计 §7.4）：缺失父路径**不在命令里发明**——命令只做"有则 delete / 缺则不新建"（store:736 同），
//    更深嵌套的缺失父路径由 store 侧 apply 报错；数组元素 undefined→null（store:735）；根与保留键拒绝。
//  · legacy 门槛：@meta schemaVersion≠1 或存在 body/foreground-completed ⇒ 拒（同 readActivitySummary/readStoryInput 口径）。
// ══════════════════════════════════════════════════════════════════════════════════

export const MESSAGE_COMMAND_RESERVED_HEAD_KEYS = Object.freeze(['_storageRevision', 'updatedAt'])
export const FLOOR_LEAF_POISON = Object.freeze(['__proto__', 'prototype', 'constructor'])
const POISON = new Set(FLOOR_LEAF_POISON)

function readHeadFieldRow(db, key) {
  return stmt(db, 'SELECT ord, kind FROM archive_head_fields WHERE key=?').get(key) ?? null
}

/** 行落库文本：与 store 的 jsonText(row,'null') 同（退化值一律 'null'，保证行是合法 JSON）。 */
function jsonTextForRow(row) {
  const text = JSON.stringify(row)
  return text === undefined ? 'null' : text
}

/** 本地头投影（缺 projectHead 注入时兜底）：键序按 ord；messages 占位跳过；timeline 占位不物化。 */
function projectHeadLocal(db, revision) {
  const head = {}
  for (const row of stmt(db, 'SELECT key, kind, value_json FROM archive_head_fields ORDER BY ord').all()) {
    if (row.key === 'messages') continue
    const value = parseValue(row.value_json)
    if (value === undefined) continue
    Object.defineProperty(head, row.key, { value, enumerable: true, writable: true, configurable: true })
  }
  if (head.timeline === undefined) delete head.timeline    // 占位 NULL ⇒ 不发明空对象（读口另由子行组装）
  head._storageRevision = revision
  return head
}

function projectHead(guards, db, chatId, revision) {
  if (typeof guards.projectHead === 'function') return guards.projectHead(db, chatId, revision)
  return projectHeadLocal(db, revision)
}

/** 新增头键：ord 取当前最大 ord + 1（键序语义与 store 一致；既有键只改值、保 ord）。 */
function applyHeaderChanges(db, changes) {
  const upsert = stmt(db, `INSERT INTO archive_head_fields (key, ord, kind, value_json) VALUES (?, ?, 0, ?)
    ON CONFLICT(key) DO UPDATE SET ord = excluded.ord, kind = excluded.kind, value_json = excluded.value_json`)
  const maxRow = stmt(db, 'SELECT MAX(ord) AS m FROM archive_head_fields').get()
  let nextOrd = (Number(maxRow?.m) >= 0 ? Number(maxRow.m) : -1) + 1
  for (const change of changes) {
    const key = String(change.path[0])
    if (change.op === 'delete') {
      stmt(db, 'DELETE FROM archive_head_fields WHERE key=?').run(key)
      continue
    }
    const existing = readHeadFieldRow(db, key)
    if (change.path.length > 1) {
      // 点路径 set：读整键 → 就地写深路径（既有键才走这里；缺键的嵌套定义见 normalizeHeaderSets）
      if (existing === null) throw new Error('楼层命令：headFields 缺 ' + key + ' 行，无法点路径写')
      const current = parseValue(stmt(db, "SELECT value_json FROM archive_head_fields WHERE key=?").get(key)?.value_json)
      if (!current || typeof current !== 'object') throw new Error('楼层命令：headFields ' + key + ' 不是对象，无法点路径写')
      const next = applyFloorChanges(current, [{ op: 'set', path: change.path.slice(1), value: change.value }])
      upsert.run(key, Number(existing.ord), JSON.stringify(next))
      continue
    }
    upsert.run(key, existing === null ? nextOrd++ : Number(existing.ord), JSON.stringify(change.value))
  }
}

/** leaf 路径守卫：拒绝 messages 根与毒键（path 必须是普通键序列）。 */
function assertLeafPath(path, label) {
  if (!Array.isArray(path) || path.length === 0) throw new Error(label + '：叶子路径不能为空')
  if (path[0] === 'messages') throw new Error(label + '：楼内路径不得以 messages 开头（用 index/patch 表达）')
  for (const part of path) {
    if (typeof part !== 'string' || part === '') throw new Error(label + '：叶子路径含非字符串键')
    if (POISON.has(part)) throw new Error(label + '：叶子路径含非法键 ' + part)
  }
}

function jsonSerializable(value) {
  try { return JSON.stringify(value) !== undefined } catch { return false }
}

/** 头 sets 归一：undefined→(存在则 delete／缺则不新建)；其它值 set；保留键与 messages 拒绝。 */
function normalizeHeaderSets(db, headerSets, nextRevision) {
  const changes = []
  if (headerSets !== undefined) {
    if (!headerSets || typeof headerSets !== 'object' || Array.isArray(headerSets)) throw new Error('楼层命令：headerSets 必须是普通对象')
    for (const key of Object.keys(headerSets)) {
      if (key === 'messages') throw new Error('楼层命令：headerSets 不得包含 messages')
      if (key === 'timeline') throw new Error('楼层命令：headerSets 不得直接写 timeline（子行表另管）')
      if (MESSAGE_COMMAND_RESERVED_HEAD_KEYS.includes(key)) throw new Error('楼层命令：headerSets 不得由调用方给 ' + key)
      if (POISON.has(key)) throw new Error('楼层命令：headerSets 含非法键 ' + key)
      const exists = readHeadFieldRow(db, key) !== null
      const next = headerSets[key]
      if (next === undefined) {
        if (exists) changes.push({ op: 'delete', path: [key] })
        continue
      }
      if (!jsonSerializable(next)) throw new Error('楼层命令：headerSets 的 ' + key + ' 不是可序列化 JSON 值')
      changes.push({ op: 'set', path: [key], value: next })
    }
  }
  // 命令**自己**推进 revision 头（调用方不得给，见上）：作者侧每次写都把 `_storageRevision` 设为新值，
  // 该头字段是"存档 revision"的可见副本（store 的 patch 也把它当普通头键写；head.revision 另由 SQL 递增）。
  if (nextRevision !== undefined) changes.push({ op: 'set', path: ['_storageRevision'], value: nextRevision })
  return changes
}

/** patch 归一（叶子子集）：深 set/delete；undefined→缺键不新建；数组元素→null；不发明缺失父路径。 */
function normalizeFloorPatch(row, patch) {
  if (patch === undefined) return []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('单楼命令：patch 必须是普通对象')
  const changes = []
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) changes.push({ op: 'set', path: [...path, index], value: value[index] === undefined ? null : value[index] })
      return
    }
    for (const key of Object.keys(value)) {
      if (POISON.has(key)) throw new Error('单楼命令：patch 含非法键 ' + key)
      const raw = value[key]
      const nextPath = [...path, key]
      const parent = path.reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), row)
      const parentHasKey = Boolean(parent && typeof parent === 'object' && Object.hasOwn(parent, key))
      if (raw === undefined) {
        // undefined：存在键→delete；缺键→不新建（同 store:736）
        if (parentHasKey) changes.push({ op: 'delete', path: nextPath })
        continue
      }
      // 存在则下推叶子；**不存在→整值 set**（新键不构成"缺失父路径"，与作者 apply 语义一致）
      if (raw !== null && typeof raw === 'object' && parentHasKey) { walk(raw, nextPath); continue }
      changes.push({ op: 'set', path: nextPath, value: raw })
    }
  }
  walk(patch, [])
  return changes
}

/** 把叶子 changes 应用到行副本（命令侧只做 set/delete；缺失父路径不发明，直接抛）。 */
function applyFloorChanges(row, changes) {
  const next = structuredClone(row)
  for (const change of changes) {
    const path = change.path
    let node = next
    for (let depth = 0; depth < path.length - 1; depth++) {
      const part = path[depth]
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) {
        throw new Error('单楼命令：缺失父路径 ' + JSON.stringify(path.slice(0, depth + 1)) + '（Missing mutation parent）')
      }
      node = node[part]
    }
    const leaf = path[path.length - 1]
    if (!node || typeof node !== 'object') throw new Error('单楼命令：缺失父路径 ' + JSON.stringify(path))
    if (change.op === 'delete') { delete node[leaf]; continue }
    if (Array.isArray(node) && !Number.isSafeInteger(Number(leaf))) throw new Error('单楼命令：数组下标非法 ' + String(leaf))
    node[leaf] = change.value
  }
  return next
}

/** 新楼形态校验（追加专用 + 单楼写后自检）：完整楼对象、turn 安全整数、swipeId 在界、variables 槽全 JSON 树。 */
function assertMessageRowShape(row, index, label = '楼层命令') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(label + '：第 ' + index + ' 楼不是普通对象')
  if (row.turn !== undefined && !Number.isSafeInteger(row.turn)) throw new Error(label + '：第 ' + index + ' 楼 turn 不是安全整数')
  if (row.swipes !== undefined && !Array.isArray(row.swipes)) throw new Error(label + '：第 ' + index + ' 楼 swipes 不是数组')
  if (row.variables !== undefined) {
    if (!Array.isArray(row.variables)) throw new Error(label + '：第 ' + index + ' 楼 variables 不是按 swipe 的数组')
    for (let swipe = 0; swipe < row.variables.length; swipe++) {
      const tree = row.variables[swipe]
      if (tree === null || tree === undefined) continue
      if (typeof tree !== 'object' || Array.isArray(tree)) throw new Error(label + '：第 ' + index + ' 楼 variables[' + swipe + '] 不是 JSON 树')
      if (!jsonSerializable(tree)) throw new Error(label + '：第 ' + index + ' 楼 variables[' + swipe + '] 不是可序列化 JSON 树')
    }
  }
  if (row.swipeId !== undefined) {
    if (!Number.isSafeInteger(row.swipeId) || row.swipeId < 0) throw new Error(label + '：第 ' + index + ' 楼 swipeId 非法')
    const slots = Math.max(Array.isArray(row.swipes) ? row.swipes.length : 0, Array.isArray(row.variables) ? row.variables.length : 0, 1)
    if (row.swipeId >= slots) throw new Error(label + '：第 ' + index + ' 楼 swipeId 越界（' + row.swipeId + ' >= ' + slots + '）')
  }
  if (!jsonSerializable(row)) throw new Error(label + '：第 ' + index + ' 楼不是可序列化 JSON')
}

/** 事务内公共窄读：head/身份/mode/messageCount/legacy 门槛。 */
function readCommandContext(db, { chatId, sessionId }, assertWritableChat) {
  if (typeof assertWritableChat === 'function') assertWritableChat(chatId)
  const head = stmt(db, 'SELECT revision, updated_at FROM archive_head WHERE id=1').get()
  if (!head) throw new Error('楼层命令：目标档不存在（无 archive_head）')
  const revision = Number(head.revision)
  if (!Number.isInteger(revision)) throw new Error('楼层命令：head revision 非法')
  const identity = { chatId: readHeadField(db, 'id'), sessionId: readHeadField(db, 'sessionId') }
  if (identity.chatId === undefined) throw new Error('楼层命令：head 未记录 id')
  if (identity.chatId !== chatId) throw new Error(`楼层命令 chatId 不匹配：期望 ${chatId}，实际 ${identity.chatId}`)
  if (typeof sessionId === 'string' && sessionId !== '' && identity.sessionId !== sessionId) {
    throw new Error(`楼层命令 sessionId 不匹配：期望 ${sessionId}，实际 ${identity.sessionId}`)
  }
  const mode = readHeadField(db, 'mode')
  const effectiveMode = typeof mode === 'string' && mode !== '' ? mode : 'story'
  if (!SUPPORTED_MODES.includes(effectiveMode)) throw new Error('楼层命令不支持 mode：' + String(mode))
  const messageCount = Number(stmt(db, 'SELECT COUNT(*) AS n FROM archive_messages').get().n)
  const hasNodes = Boolean(stmt(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='archive_timeline_nodes'").get())
  if (!hasNodes) throw new Error('楼层命令：本档无 timeline 子行表（旧代形状），不接窄命令')
  const metaRow = stmt(db, "SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get()
  if (metaRow === undefined) throw new Error('楼层命令：head 有 timeline 占位但缺 @meta（损坏）')
  const meta = parseValue(metaRow.value_json)
  if (!meta || typeof meta !== 'object' || Number(meta.schemaVersion) !== 1) throw new Error('楼层命令：timeline schema 非 1')
  const legacy = stmt(db, `SELECT 1 FROM archive_timeline_nodes WHERE node_key LIKE 'operations:%'
    AND json_extract(value_json,'$.kind')='body' AND json_extract(value_json,'$.status')='foreground-completed' LIMIT 1`).get()
  if (legacy) throw new Error('楼层命令：本档存在前台完成的 body 操作（legacy 形状），不接窄命令')
  const checkpointCount = Number(stmt(db, "SELECT COUNT(*) AS n FROM archive_timeline_nodes WHERE node_key LIKE 'checkpoints#%'").get()?.n) || 0
  return { revision, updatedAt: Number(head.updated_at) || 0, messageCount, identity, meta, checkpointCount }
}

function requireArchiveLocalWrite(guards) {
  if (typeof guards.archiveLocalWrite !== 'function') {
    throw new Error('楼层命令缺少注入的 archiveLocalWrite（变量归档局部入口必须由 store 注入，命令不持第二份实例）')
  }
  return guards.archiveLocalWrite
}

function bumpHeadRevision(db, revision, at) {
  const bumped = stmt(db, 'UPDATE archive_head SET revision=revision+1, updated_at=? WHERE id=1 AND revision=?').run(at, revision)
  const changes = Number(bumped?.changes ?? 0)
  if (changes !== 1) throw new Error(`楼层命令 CAS 失败：revision 已变化（期望 ${revision}，changes=${changes}）`)
}

function commitHooks(guards, payload) {
  if (typeof guards.applyMessageWrite === 'function') guards.applyMessageWrite(payload)
  else if (typeof guards.onCommitted === 'function') guards.onCommitted(payload)
}

/**
 * 追加楼层（纯尾）。
 * @param {object} db 与产品 store 同一 SQLite 句柄
 * @param {{chatId:string, sessionId?:string, revision:number, items:object[], headerSets?:object}} input
 * @param {object} guards 见文件头合同
 * @returns {undefined | {changed:true, revision:number, updatedAt:number, messageCount:number, head:object}}
 */
/** 追加命令新增的**可选** timeline 子行写载荷：只在确有 `timeline.**` 差量时传入；头 sets 仍禁 timeline。 */
const TIMELINE_POISON = new Set(['__proto__', 'prototype', 'constructor'])
const pathText = path => 'timeline.' + (Array.isArray(path) ? path.slice(1).join('.') : String(path))
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 深层 JSON 可序列化检查：循环引用 / 函数 / symbol / BigInt / 未决 Promise 一律拒（写前 fail-loud）。 */
function assertSerializable (value, label) {
  const seen = new Set()
  const walk = (node, trail) => {
    if (node === null) return
    const type = typeof node
    if (type === 'string' || type === 'boolean' || type === 'undefined') return
    if (type === 'number') { if (!Number.isFinite(node)) throw new Error(label + ' 含非有限数字：' + trail); return }
    if (type === 'bigint' || type === 'function' || type === 'symbol') throw new Error(label + ' 含不可序列化值（' + type + '）：' + trail)
    if (type !== 'object') throw new Error(label + ' 含不可序列化值：' + trail)
    if (typeof node.then === 'function') throw new Error(label + ' 含未决 Promise：' + trail)
    if (seen.has(node)) throw new Error(label + ' 含循环引用：' + trail)
    seen.add(node)
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, trail + '[' + index + ']')); seen.delete(node); return }
    for (const key of Object.keys(node)) {
      if (TIMELINE_POISON.has(key)) throw new Error(label + ' 含非法键：' + trail + '.' + key)
      walk(node[key], trail + '.' + key)
    }
    seen.delete(node)
  }
  walk(value, label)
}

function validateTimelineUpdate (update) {
  if (update === undefined) return false
  if (!isPlainObject(update)) throw new Error('追加命令：timelineUpdate 必须是对象')
  const { value, changes, expected } = update
  if (!isPlainObject(value)) throw new Error('追加命令：timelineUpdate.value 必须是普通对象')
  if (Number(value.schemaVersion) !== 1) throw new Error('追加命令：timelineUpdate.value schema 非 1')
  if (!Array.isArray(value.checkpoints)) throw new Error('追加命令：timelineUpdate.value.checkpoints 必须是数组')
  if (!isPlainObject(value.operations)) throw new Error('追加命令：timelineUpdate.value.operations 必须是对象')
  if (value.participants !== undefined && !isPlainObject(value.participants)) throw new Error('追加命令：timelineUpdate.value.participants 必须是对象')
  if (!expected || !isPlainObject(expected)) throw new Error('追加命令：timelineUpdate.expected 缺失')
  if (typeof expected.branchId !== 'string' || expected.branchId === '') throw new Error('追加命令：timelineUpdate.expected.branchId 非法')
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 0) throw new Error('追加命令：timelineUpdate.expected.revision 非法')
  if (typeof value.branchId !== 'string' || value.branchId === '' || value.branchId !== expected.branchId) throw new Error('追加命令：timelineUpdate.value 分支与 expected 不符')
  if (!Number.isSafeInteger(value.revision) || value.revision < expected.revision) throw new Error('追加命令：timelineUpdate.value.revision 必须是安全整数且不小于 expected')
  assertSerializable(value, '追加载荷 timeline value')
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('追加命令：timelineUpdate.changes 必须是非空数组')
  for (const change of changes) {
    if (!isPlainObject(change)) throw new Error('追加命令：timelineUpdate.changes 元素必须是对象')
    const path = change.path
    if (!Array.isArray(path) || path.length < 2 || path[0] !== 'timeline') throw new Error('追加命令：timelineUpdate 只接 timeline 下的深路径：' + String(path && path.join('.')))
    for (const part of path) {
      if (part === undefined || part === null || part === '') throw new Error('追加命令：timelineUpdate 空改动脉节：' + pathText(path))
      if (typeof part !== 'string' && !(typeof part === 'number' && Number.isInteger(part) && part >= 0)) throw new Error('追加命令：timelineUpdate 改动脉节类型非法：' + pathText(path))
      if (TIMELINE_POISON.has(part)) throw new Error('追加命令：timelineUpdate 非法改动脉节：' + pathText(path))
    }
    if (change.op !== 'set' && change.op !== 'delete' && change.op !== 'splice') throw new Error('追加命令：timelineUpdate 不接受该改动操作：' + String(change.op))
    if (change.op !== 'splice') continue
    // 目前生产实际出现的 nested 数组 splice 只有「checkpoints 尾部追加」一种：只放行这一形状，其余不猜、直接拒。
    if (path.length !== 2 || path[1] !== 'checkpoints') throw new Error('追加命令：timelineUpdate 只接 checkpoints 尾部 splice：' + pathText(path))
    if (!Array.isArray(change.items)) throw new Error('追加命令：timelineUpdate splice 必须带数组 items：' + pathText(path))
    if (!Number.isSafeInteger(change.index) || change.index < 0) throw new Error('追加命令：timelineUpdate splice index 必须是安全整数：' + pathText(path))
    if (!Number.isSafeInteger(change.deleteCount) || change.deleteCount < 0) throw new Error('追加命令：timelineUpdate splice deleteCount 必须是安全整数：' + pathText(path))
    if (change.deleteCount !== 0) throw new Error('追加命令：timelineUpdate 只接纯追加 splice（deleteCount 必须 0）：' + pathText(path))
    assertSerializable(change.items, '追加载荷 splice items')
  }
  return true
}

/** 事务内：按 @meta 校验 expected，再复用既有 plan/write/verify 落 timeline 子行（与正文/头同事务）。 */
function applyTimelineUpdate (db, ctx, update) {
  const meta = ctx.meta
  const expected = update.expected
  if (!meta || typeof meta !== 'object') throw new Error('追加命令：timeline @meta 不可用')
  if (meta.branchId !== expected.branchId) throw new Error('追加命令：timelineUpdate 分支不符（expected ' + String(expected.branchId) + '，当前 ' + String(meta.branchId) + '）')
  if (Number(meta.revision) !== expected.revision) throw new Error('追加命令：timelineUpdate 版本不符（expected ' + String(expected.revision) + '，当前 ' + String(meta.revision) + '）')
  const preCount = ctx.checkpointCount
  if (!Number.isSafeInteger(preCount) || preCount < 0) throw new Error('追加命令：timelineUpdate 缺少入事务时的 checkpoint 计数')
  for (const change of update.changes) {
    if (change.op !== 'splice') continue
    if (change.index !== preCount) throw new Error('追加命令：checkpoints splice index 必须等于入事务时的 checkpoint 数（' + preCount + '）：' + String(change.index))
    if (update.value.checkpoints.length !== preCount + change.items.length) throw new Error('追加命令：checkpoints 必须纯尾追加（' + preCount + ' + ' + change.items.length + ' ≠ ' + update.value.checkpoints.length + '）')
    const tail = update.value.checkpoints.slice(preCount)
    if (tail.length !== change.items.length) throw new Error('追加命令：checkpoints splice 尾部长度不符')
    for (let index = 0; index < tail.length; index++) {
      if (!isDeepStrictEqual(tail[index], change.items[index])) throw new Error('追加命令：checkpoints splice items 必须与 value 尾部逐字相等（下标 ' + index + '）')
    }
  }
  const plan = computeTimelinePlan(update.changes, update.value)
  const touched = writeTimelineNodes(db, update.value, plan)
  verifyTimelineNodes(db, update.value)                       // fail-loud：ord 连续＋行数一致（坏节点必抛 ⇒ ROLLBACK）
  return touched                                              // 原样返回写集 {rows, full}：projectionReads.invalidate 要的是它，布尔会让行缓存永不失效
}

export function appendMessages(db, { chatId, sessionId, revision, items, headerSets, timelineUpdate } = {}, guards = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('追加命令需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('追加命令缺少 chatId')
  if (!Array.isArray(items) || items.length === 0) throw new Error('追加命令：items 必须是非空数组')
  if (!Number.isSafeInteger(revision)) throw new Error('追加命令：revision 必须是安全整数')
  const archiveLocalWrite = requireArchiveLocalWrite(guards)
  const now = typeof guards.now === 'function' ? guards.now : Date.now
  let started = false
  try {
    db.exec('BEGIN IMMEDIATE')
    started = true
    const ctx = readCommandContext(db, { chatId, sessionId }, guards.assertWritableChat)
    if (ctx.revision !== revision) { db.exec('ROLLBACK'); started = false; return undefined }   // CAS 不符＝undefined（同 patch:722）
    if (headerSets && typeof headerSets === 'object' && Object.prototype.hasOwnProperty.call(headerSets, 'timeline')) throw new Error('楼层命令：headerSets 不得直接写 timeline（子行表另管）')
    const hasTimelineUpdate = validateTimelineUpdate(timelineUpdate)
    const count = ctx.messageCount
    const headerChanges = normalizeHeaderSets(db, headerSets, ctx.revision + 1)
    const touchedRows = new Map()
    for (let offset = 0; offset < items.length; offset++) {
      const index = count + offset
      if (touchedRows.has(index)) throw new Error('追加命令：批内楼层号重复 ' + index)
      assertMessageRowShape(items[offset], index, '追加命令')
      touchedRows.set(index, items[offset])
    }
    // 当前态由 prepareLocalWrite 内部正向解决（refreshStateLocal 现会保留仍合格的 DB 原 state 行，
    // 见 lib/variable-archive.js:741-753）；命令侧不再做任何 state 修补。
    const { stripped, written } = archiveLocalWrite(db, chatId, touchedRows, count + items.length, { truncated: false })
    const upsertMessage = stmt(db, `INSERT INTO archive_messages (message_index, message_json) VALUES (?, ?)
      ON CONFLICT(message_index) DO UPDATE SET message_json = excluded.message_json`)
    for (let index = count; index < count + items.length; index++) {
      upsertMessage.run(index, jsonTextForRow(stripped.get(index) || touchedRows.get(index)))
    }
    for (const index of written) {
      if (index >= count && index < count + items.length) continue
      const row = stripped.get(index)
      if (row) upsertMessage.run(index, jsonTextForRow(row))
    }
    if (headerChanges.length) applyHeaderChanges(db, headerChanges)
    const timelineTouched = hasTimelineUpdate ? applyTimelineUpdate(db, ctx, timelineUpdate) : false
    bumpHeadRevision(db, ctx.revision, now())
    db.exec('COMMIT')
    started = false
    const nextRevision = ctx.revision + 1
    const updatedAt = Number(stmt(db, 'SELECT updated_at FROM archive_head WHERE id=1').get()?.updated_at) || 0
    commitHooks(guards, {
      chatId, revision: nextRevision,
      keys: [...new Set([...headerChanges.map(change => change.path[0]), ...(hasTimelineUpdate ? ['timeline'] : [])])],
      messages: true, timeline: timelineTouched, written,     // timeline＝写集 {rows,full}（无改动＝undefined），供投影行缓存精确失效
      changes: [
        ...headerChanges,
        { op: 'splice', path: ['messages'], index: count, deleteCount: 0, items: items.length },
        ...(hasTimelineUpdate ? timelineUpdate.changes : []),
      ],
    })
    return {
      changed: true, revision: nextRevision, updatedAt, messageCount: count + items.length,
      head: projectHead(guards, db, chatId, nextRevision),
    }
  } catch (error) {
    if (started) { try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错 */ } }
    throw error
  }
}

/**
 * 单楼 set（叶子子集；整楼替换/追加走 appendMessages）。
 * @param {object} db 与产品 store 同一 SQLite 句柄
 * @param {{chatId:string, sessionId?:string, revision:number, index:number, patch:object}} input
 * @param {object} guards 见文件头合同（可含 headerSets）
 * @returns {undefined | {changed:true, revision:number, updatedAt:number, messageCount:number, head:object}}
 */
export function setMessageFloor(db, { chatId, sessionId, revision, index, patch } = {}, guards = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('单楼命令需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('单楼命令缺少 chatId')
  if (!Number.isSafeInteger(revision)) throw new Error('单楼命令：revision 必须是安全整数')
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('单楼命令：index 必须是非负安全整数')
  const archiveLocalWrite = requireArchiveLocalWrite(guards)
  const now = typeof guards.now === 'function' ? guards.now : Date.now
  let started = false
  try {
    db.exec('BEGIN IMMEDIATE')
    started = true
    const ctx = readCommandContext(db, { chatId, sessionId }, guards.assertWritableChat)
    if (ctx.revision !== revision) { db.exec('ROLLBACK'); started = false; return undefined }
    const count = ctx.messageCount
    if (index >= count) throw new Error('单楼命令：楼层越界（' + index + ' >= ' + count + '）；整楼替换/追加请用追加命令')
    const rowRow = stmt(db, 'SELECT message_json FROM archive_messages WHERE message_index=?').get(index)
    if (rowRow === undefined) throw new Error('单楼命令：楼层行不存在 ' + index)
    const currentRow = parseValue(rowRow.message_json)
    if (!currentRow || typeof currentRow !== 'object' || Array.isArray(currentRow)) throw new Error('单楼命令：第 ' + index + ' 楼不是普通对象')
    const floorChanges = normalizeFloorPatch(currentRow, patch)
    const headerChanges = normalizeHeaderSets(db, guards.headerSets, ctx.revision + 1)
    if (floorChanges.length === 0 && headerChanges.length === 0) throw new Error('单楼命令：没有任何叶子/头改动')
    const nextRow = floorChanges.length ? applyFloorChanges(currentRow, floorChanges) : currentRow
    assertMessageRowShape(nextRow, index, '单楼命令')
    const touchedRows = new Map([[index, nextRow]])
    // 当前态由 prepareLocalWrite 内部正向解决（见 lib/variable-archive.js:741-753）；命令侧不修补 state。
    const { stripped, written } = archiveLocalWrite(db, chatId, touchedRows, count, { truncated: false })
    const upsertMessage = stmt(db, `INSERT INTO archive_messages (message_index, message_json) VALUES (?, ?)
      ON CONFLICT(message_index) DO UPDATE SET message_json = excluded.message_json`)
    for (const writtenIndex of written) {
      if (writtenIndex === index) continue
      const pruned = stripped.get(writtenIndex)
      if (pruned) upsertMessage.run(writtenIndex, jsonTextForRow(pruned))
    }
    upsertMessage.run(index, jsonTextForRow(stripped.get(index) || nextRow))
    if (headerChanges.length) applyHeaderChanges(db, headerChanges)
    bumpHeadRevision(db, ctx.revision, now())
    db.exec('COMMIT')
    started = false
    const nextRevision = ctx.revision + 1
    const updatedAt = Number(stmt(db, 'SELECT updated_at FROM archive_head WHERE id=1').get()?.updated_at) || 0
    commitHooks(guards, {
      chatId, revision: nextRevision, keys: [...new Set(headerChanges.map(change => change.path[0]))],
      messages: true, timeline: false, written,
      changes: [...headerChanges, ...floorChanges.map(change => ({ ...change, path: ['messages', index, ...change.path] }))],
    })
    return {
      changed: true, revision: nextRevision, updatedAt, messageCount: count,
      head: projectHead(guards, db, chatId, nextRevision),
    }
  } catch (error) {
    if (started) { try { db.exec('ROLLBACK') } catch { /* 回滚失败不掩盖原错 */ } }
    throw error
  }
}

export const _internals = Object.freeze({
  STATUS_BAR_PLACEMENTS, SUPPORTED_MODES, PLACEMENT_KEY, readHeadField, readPlacementRow,
  jsonTextForRow, applyFloorChanges,
})
export const _internalsV2 = Object.freeze({
  MESSAGE_COMMAND_RESERVED_HEAD_KEYS, FLOOR_LEAF_POISON, projectHeadLocal,
  normalizeHeaderSets, normalizeFloorPatch, applyFloorChanges, assertMessageRowShape, readCommandContext,
})