// S1/S2：SQL 活动摘要＋小 timeline（内部只读查询服务，等价于作者 activity(chat)）。
// 合同：readActivitySummary(db, { chatId, sessionId, revision? })
//   -> { kind:'value', revision, chatUpdatedAt, identity:{chatId,sessionId},
//        activity:{phase,busy,role,operationId,basedOn,updatedAt,reason?},
//        timeline:{ schemaVersion:1, branchId, revision, updatedAt?, participants?, operations:{小字段字典}, checkpoints:[] } }
//    | { kind:'not-applicable', reason:'legacy-body' | 'unsupported-mode' | 'unsupported-timeline' }
//    | null（无档，沿用既有无档语义）
// 纪律：单快照（复用 readSqlSnapshot，不自行 BEGIN/吞错）、无 await、不调用 timeline.inspect/readTimelineTree/cachedState；
//       只取小字段（**不含** businessBefore／rollback baseline／checkpoint 内容）；operations 只读一遍；不新增表/索引。
// 门槛：mode∈{story,script}（缺省 story）且 backgroundConfigVersion/conversationFeaturesVersion===1；
//       无 timeline 占位 ⇒ unsupported-timeline；有占位但 @meta 缺失 ⇒ 抛错（损坏）；
//       任一 body.foreground-completed ⇒ legacy-body（inspect 的 legacyBody 分支，不等价）；
//       branchId 非空字符串（空则 ensure 会随机生成 id ⇒ 不等价 ⇒ not-applicable）；身份/revision 非法或不符 ⇒ 抛错。
//
// 等价依据（作者固定提交 68215e47…，只读）：
//  - background-task-coordinator.js:46-89 activity(chat)（文件末 `return Object.freeze({ activity, operation, begin, recover, exclusive })`）。
//  - story-timeline.js:657-677 inspect（legacyBody 检测、不输出 updatedAt）；:38-60 ensure（schemaVersion!==1 走迁移；branchId 生成）。
//  - lib/timeline-nodes.js:148-177 readTimelineTree 无 ORDER BY（＝SQLite 行序），以 nodeKey.slice(11) 建 operations ⇒
//    Object.values 顺序＝行序＋JS 数字键重排；本实现显式 ORDER BY rowid 固定同一行序，避免筛选计划改走键索引。
import { stmt } from './statement-cache.js'
import { readSqlSnapshot } from './chat-projection-reads.js'

/** S2/view 小字段（**不含** businessBefore 等大载荷）；同时覆盖 activity 所需字段。
 *  2026-10-08 审计补救：追加 `roundOperationId` 与 `requestId`（都是小标量）。依据：
 *   · story-timeline.js:341-352 用 `operation.requestId` 做 agent.begin 幂等复用，:354-356 未命中时
 *     会把同 role 的 running agent 操作置 cancelled ⇒ 缺该键会让窄快照"取消旧操作/不复用"。
 *   · story-timeline.js:630-637 用 `operation.roundOperationId` 做结算轮次 stale 校验，:217-222 用它
 *     决定 background 落点（round 操作 vs participants.background）⇒ 缺该键会跳过校验并换读路径。
 *  仍是小字段：不含 userText/businessBefore 等大载荷（userText 只在 commitBody 的 body 分支读，结算
 *  路径操作是 agent/settlement，故不取）。 */
export const VIEW_OPERATION_FIELDS = Object.freeze([
  'id', 'kind', 'role', 'status', 'createdAt', 'completedAt',
  'basedOn', 'committedBranchId', 'committedRevision', 'background', 'startedSessionId',
  'roundOperationId', 'requestId', 'turn',
])

/** 窄窗口失败清理摘要（与 queryActivitySummary 同快照调用）：在不恢复整棵 timeline/整档的前提下，
 *  为“最新失败轮可否干净清理”提供服务端事实，判定与 latestFailureTarget（latest-failure-transform
 *  的 replayTarget 分支）一致：最新失败 body 操作、回退基准存在性、checkpoint/正文/操作尾部阻塞。
 *  基准只探 json_type（不装载 businessBefore/rowBefore 载荷）；供 readOpeningWindow 随窗口带回，
 *  经 session-window-projector 非枚举挂到 chat 上，由视图接缝的 narrow 分支消费。
 *  RPC 侧 cleanRollback 仍用完整档做权威复核；本摘要只负责 UI 可清判定与原因文案。 */
export function queryFailureCleanup(db, { revision, timeline } = {}) {
  const operations = (timeline && timeline.operations) || {}
  let latest = null, latestId = null
  for (const [id, op] of Object.entries(operations)) {
    if (!op || op.kind !== 'body') continue
    const turn = Number(op.turn)
    if (!Number.isSafeInteger(turn) || turn < 1) continue
    if (op.status !== 'failed') continue // 只认显式 failed：running / foreground-completed / completed 等一律不得 cleanable
    if (latest === null || turn > latest) { latest = turn; latestId = id }
  }
  if (latest === null || latestId === null) return { cleanable: false, reason: '' }
  const base = { turn: latest, operationId: latestId }
  const baseline = stmt(db, `SELECT (json_type(value_json,'$.businessBefore') IN ('object','array')) AS hasBusiness,
    (json_type(value_json,'$.rowBefore') IN ('object','array')) AS hasRow,
    (json_type(value_json,'$.beforeParticipants') IN ('object','array')) AS hasParticipants
    FROM archive_timeline_nodes WHERE node_key=?`).get('operations:' + latestId)
  if (!baseline || !(baseline.hasBusiness === 1 || (baseline.hasRow === 1 && baseline.hasParticipants === 1))) {
    return { cleanable: false, reason: '该失败轮缺少发轮前回退基准，不能安全清理', ...base }
  }
  if (stmt(db, `SELECT 1 AS hit FROM archive_timeline_nodes WHERE node_key LIKE 'checkpoints#%'
    AND CAST(json_extract(value_json,'$.turn') AS INTEGER) >= ? LIMIT 1`).get(latest)) {
    return { cleanable: false, reason: '该失败轮已有完成检查点，不是失败态', ...base }
  }
  if (stmt(db, `SELECT 1 AS hit FROM archive_messages WHERE CAST(json_extract(message_json,'$.turn') AS INTEGER) > ? LIMIT 1`).get(latest)) {
    return { cleanable: false, reason: '该失败轮之后已有正文行，不是最新尾部', ...base }
  }
  if (Object.values(operations).some(op => op && Number(op.turn) > latest)) {
    return { cleanable: false, reason: '该失败轮之后已有任务推进，不是最新尾部', ...base }
  }
  return { cleanable: true, reason: '', ...base, branchId: timeline.branchId, revision: Number(revision) }
}

export const SUPPORTED_TIMELINE_SCHEMA = Object.freeze([1])
/** 合法 mode：story／script；缺 mode 视为 story（作者默认），'chat' 不是合法值。 */
export const SUPPORTED_MODES = Object.freeze(['story', 'script'])

function str(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function parseValue(text) {
  if (text === null || text === undefined) return undefined
  // 存在的 SQL JSON 损坏必须上抛，不能被当作缺失字段或空闲状态。
  return JSON.parse(text)
}

function tableExists(db, name) {
  return Boolean(stmt(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
}

function readHeadField(db, key) {
  const row = stmt(db, 'SELECT value_json FROM archive_head_fields WHERE key=? AND kind=0').get(key)
  return parseValue(row?.value_json)
}

function headFieldExists(db, key) {
  return Boolean(stmt(db, 'SELECT 1 FROM archive_head_fields WHERE key=?').get(key))   // 占位判定：不 parse value_json
}

/** 合法 revision：undefined/null 或非负安全整数；非法数值一律拒绝。 */
function assertLegalRevision(label, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`活动摘要 ${label} 非法：${String(value)}`)
  }
  return value
}

function readIdentity(db) {
  const identity = { chatId: undefined, sessionId: undefined }
  const chatId = readHeadField(db, 'id')
  const sessionId = readHeadField(db, 'sessionId')
  if (typeof chatId === 'string' && chatId !== '') identity.chatId = chatId
  if (typeof sessionId === 'string' && sessionId !== '') identity.sessionId = sessionId
  return identity
}

/** 唯一一次 operations 读：view 小字段字典（键＝nodeKey.slice(11) ⇒ Object.values 顺序同作者）。 */
function readViewOperations(db) {
  const projection = VIEW_OPERATION_FIELDS.map((field, i) => `value_json -> '$.${field}' AS f${i}`).join(', ')
  const rows = stmt(db, `SELECT node_key, ${projection} FROM archive_timeline_nodes WHERE node_key LIKE 'operations:%' ORDER BY rowid`).all()
  const operations = {}
  for (const row of rows) {
    const value = {}
    VIEW_OPERATION_FIELDS.forEach((field, i) => {
      const parsed = parseValue(row['f' + i])
      if (parsed !== undefined) Object.defineProperty(value, field, { value: parsed, enumerable: true, writable: true, configurable: true })
    })
    Object.defineProperty(operations, row.node_key.slice(11), { value, enumerable: true, writable: true, configurable: true })
  }
  return operations
}

function readTimelineMeta(db) {
  const row = stmt(db, "SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get()
  if (!row) return null
  const meta = parseValue(row.value_json)
  return meta && typeof meta === 'object' ? meta : null
}

/** 作者 activity(chat)（background-task-coordinator.js:46-89）等价实现，只吃小行字典。 */
export function activityFromSmallRows({ operations: operationsObject, branchId, revision }) {
  const allOperations = Object.values(operationsObject || {})
  const agents = allOperations.filter(operation => operation && operation.kind === 'agent')
    .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
  const running = agents.find(operation => operation.status === 'running')
  const body = allOperations.filter(operation => operation && operation.kind === 'body' &&
    (operation.status === 'foreground-completed' || operation.status === 'completed') && operation.background &&
    str(operation.committedBranchId || (operation.basedOn && operation.basedOn.branchId)) === branchId)
    .sort((left, right) => (Number(right.completedAt) || 0) - (Number(left.completedAt) || 0))[0]
  const background = body && body.background
  if (running === undefined && background && background.phase === 'failed') {
    return {
      phase: 'failed', busy: false, role: str(background.role), operationId: str(body.id), basedOn: null,
      updatedAt: Number(background.updatedAt) || 0,
      ...(background.reason ? { reason: str(background.reason) } : {})
    }
  }
  if (running === undefined && background && (background.phase === 'pending' || background.phase === 'running')) {
    return {
      phase: background.phase,
      busy: background.phase === 'running',
      role: str(background.role),
      operationId: str(body.id),
      basedOn: { branchId, revision: Number(body.committedRevision) || revision },
      updatedAt: Number(background.updatedAt) || Number(body.completedAt) || 0
    }
  }
  const current = running || agents[0]
  if (current === undefined) {
    return { phase: 'idle', busy: false, role: '', operationId: '', basedOn: null, updatedAt: 0 }   // inspect 不输出 updatedAt ⇒ 0
  }
  return {
    phase: running !== undefined ? 'running' : (current.status === 'failed' || (current.status === 'interrupted' && current.role === 'settlement') ? 'failed' : 'idle'),
    busy: running !== undefined,
    role: str(current.role),
    operationId: str(current.id),
    basedOn: current.basedOn || null,
    updatedAt: Number(current.completedAt) || Number(current.createdAt) || 0,
    ...(current.status === 'interrupted' && current.role === 'settlement' ? { reason: 'interrupted' } : {})
  }
}

/**
 * @param {object} db 与产品 store 同一 SQLite 句柄（调用方注入）
 * @returns {null | {kind:'value',revision:number,chatUpdatedAt:number,identity:object,activity:object,timeline:object}
 *          | {kind:'not-applicable',reason:string}}
 */
export function readActivitySummary(db, { chatId, sessionId, revision } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('活动摘要需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('活动摘要缺少 chatId')
  const pinnedRevision = assertLegalRevision('revision', revision)
  return readSqlSnapshot(db, () => {
    if (!tableExists(db, 'archive_head')) return null
    const head = stmt(db, 'SELECT revision, updated_at FROM archive_head WHERE id=1').get()
    if (!head) return null
    const headRevision = assertLegalRevision('head revision', Number(head.revision))
    if (headRevision === undefined) throw new Error('活动摘要 head revision 缺失或非法')
    const chatUpdatedAt = readHeadField(db, 'updatedAt') || 0
    if (pinnedRevision !== undefined && pinnedRevision !== headRevision) {
      throw new Error(`活动摘要 revision 不匹配：期望 ${pinnedRevision}，实际 ${headRevision}`)
    }
    const identity = readIdentity(db)
    if (identity.chatId === undefined) throw new Error('活动摘要缺 identity.chatId（head 未记录 id）')
    if (identity.sessionId === undefined) throw new Error('活动摘要缺 identity.sessionId（head 未记录 sessionId）')
    if (identity.chatId !== chatId) throw new Error(`活动摘要 chatId 不匹配：期望 ${chatId}，实际 ${identity.chatId}`)
    if (typeof sessionId === 'string' && sessionId !== '' && identity.sessionId !== sessionId) {
      throw new Error(`活动摘要 sessionId 不匹配：期望 ${sessionId}，实际 ${identity.sessionId}`)
    }
    // 适用性：mode∈{story,script}（缺省 story）；两个 feature 版本必须为 1。
    const mode = readHeadField(db, 'mode')
    const effectiveMode = typeof mode === 'string' && mode !== '' ? mode : 'story'
    if (!SUPPORTED_MODES.includes(effectiveMode)) return { kind: 'not-applicable', reason: 'unsupported-mode' }
    for (const key of ['backgroundConfigVersion', 'conversationFeaturesVersion']) {
      const version = readHeadField(db, key)
      if (version !== undefined && Number(version) !== 1) return { kind: 'not-applicable', reason: 'unsupported-mode' }
    }
    if (!tableExists(db, 'archive_timeline_nodes')) return { kind: 'not-applicable', reason: 'legacy-body' }
    const meta = readTimelineMeta(db)
    if (!meta) {
      if (!headFieldExists(db, 'timeline')) return { kind: 'not-applicable', reason: 'unsupported-timeline' }
      throw new Error('活动摘要缺少 timeline @meta（head 已声明 timeline 占位但子行元数据缺失＝损坏，不得当作 idle）')
    }
    if (Number(meta.schemaVersion) !== 1) return { kind: 'not-applicable', reason: 'unsupported-mode' }
    const branchId = str(meta.branchId)
    if (branchId === '') return { kind: 'not-applicable', reason: 'unsupported-mode' }   // ensure 会随机生成 id ⇒ 不等价
    const timelineRevision = Math.max(0, Number(meta.revision) || 0)                    // ensure 语义
    const operations = readViewOperations(db)
    // 任一 body.foreground-completed ⇒ inspect 的 legacyBody 分支（会走迁移）⇒ 不等价
    const legacyBody = Object.values(operations).some(operation =>
      operation && operation.kind === 'body' && operation.status === 'foreground-completed')
    if (legacyBody) return { kind: 'not-applicable', reason: 'legacy-body' }
    return {
      kind: 'value',
      revision: headRevision,
      chatUpdatedAt,                                                                   // 供 sessionActivity 包装；不进 activity
      identity,
      activity: activityFromSmallRows({ operations, branchId, revision: timelineRevision }),
      timeline: {
        schemaVersion: 1,
        branchId,
        revision: timelineRevision,
        ...(meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }),          // 仅供展示；activity 不读取
        ...(meta.participants === undefined ? {} : { participants: meta.participants }),
        operations,
        checkpoints: []
      }
    }
  })
}

// ══════════════════════════════════════════════════════════════════════════════════
// S4：前台 story 输入的范围选择＋读取（设计 §6.2）
//
// 合同：readStoryInput(db, { chatId, sessionId, need }, helpers)
//   need = { storyRows（宿主事务外算好的深度 number/安全整数）, lastAssistant, lastVariables,
//            enough(fn), include(indices), revision(pin) }
//   helpers = { readWindow(chatId, options), hasLastVariables(rows), createScopedMessages(count, entries) }
//   -> 与作者 bounded-history.js `read()` 相同形状：
//      { chat:{…head 去 messages, messages:createScopedMessages(messageCount, entries)},
//        messageCount, from, revision } | undefined
//
// 等价依据（作者固定提交 68215e47…，只读）：domain/bounded-history.js:25-67（read：首窗、适用性
//   门槛、分页回退、lastVariables 世界楼、include 具名楼、最终形状）与 :4-12（legacyStory /
//   scannedStoryRows）。**逐字保留**的部分：satisfied 三谓词、分页 limit 公式
//   Math.min(500, Math.max(pageSize, rows.length))、rows.length>=maxRows 返回 undefined、
//   worldMessage 为 null 的跳过 vs undefined 的 undefined、include 的去重/越界/已覆盖跳过、
//   最终 `{…header}` 去 messages。宿主自己的去重语义（Set）用等价循环表达，不改判定。
//
// 纪律：分页与逐楼读**各自成次**（不跨 await 持有事务）；每页读后核 currentRevision，不符即
//   undefined（不把旧 header 与新页拼起来）；每页窄读（fields 只留 _storageRevision ⇒ 不组装
//   timeline／不物化完整 Chat）；只做范围选择＋读取＋分页循环，谓词（enough/hasLastVariables）
//   一律由宿主注入，不在本模块重写语义。
// 分流（显式 undefined，不静默降级）：无窗口／sessionId 不符／revision 不符／
//   backgroundConfigVersion≠1／conversationFeaturesVersion≠1／legacyStory（body 已前台完成）／
//   深度非安全整数或为负／翻页越界或 revision 变动／超过 maxRows／世界楼与具名楼取不到。
// 本次已知边界（记在此处以便核对，不冒称覆盖）：**原件（未迁移）档**由 store 出口在更上层
//   以 'legacy-source' 分流（chat-sqlite-store.js readActivitySummary/readOpeningWindow 同序），
//   本函数不自行探原件路径。
// ══════════════════════════════════════════════════════════════════════════════════

/** 作者 bounded-history.js:25 的默认分页/上限常量（逐字同值）。 */
export const STORY_INPUT_PAGE_SIZE = 48
export const STORY_INPUT_MAX_ROWS = 2000

/** 作者 bounded-history.js:4-5：任一 body 已前台完成 ⇒ 旧代剧情（不等价，走完整读）。 */
export function legacyStoryBody(chat) {
  return Object.values(chat?.timeline?.operations || {}).some(operation =>
    operation?.kind === 'body' && operation.status === 'foreground-completed')
}

/**
 * 作者 bounded-history.js:7-12 `scannedStoryRows` 的逐字等价形式：user/assistant 且 greeting!==true
 * 的楼层数是否已达 depth（greeting 不计）。保持“JS 判据”而非 SQL 等价（设计 §6.2：任意
 * enough(rows) 不能自动编译为 SQL，此处同理由宿主注入谓词）。
 */
export function scannedStoryRows(rows, depth) {
  let count = 0
  for (const row of rows) if ((row?.role === 'user' || row?.role === 'assistant') && row.greeting !== true) count++
  return count >= depth
}

/** 楼层号白名单（作者 readWindow 的 order 检查口径）：undefined/null/Infinity＝当前态；其余须非负安全整数。 */
function assertStoryInputRevision(value) {
  if (value === undefined || value === null || value === Infinity) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('story 输入 revision 非法：' + String(value))
  }
  return value
}

/** 与 readWindow 的窗口 limit 口径一致（chat-sqlite-store.js:1383）。 */
function assertStoryInputLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid history window limit')
}

function requireHelper(helpers, name) {
  const fn = helpers?.[name]
  if (typeof fn !== 'function') {
    throw new Error('story 输入缺少注入 helper ' + name + '（协议投影/窗口读必须由宿主注入，不另造第二份实现）')
  }
  return fn
}

/** 同一 revision 的 pinned 续页/具名楼读：读不到该 revision 即返回 undefined（作者 readWindow 同样返回 undefined）。 */
async function readPinnedWindow(readWindow, chatId, options) {
  try {
    return await readWindow(chatId, options)
  } catch (error) {
    if (error?.code === 'DSH_TAVERN_REVISION_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * @param {object} db 与产品 store 同一 SQLite 句柄
 * @param {{chatId:string, sessionId?:string, need?:object, pageSize?:number, maxRows?:number}} input
 *   pageSize/maxRows 与作者 createBoundedHistory 的工厂选项同位（真调用方给在**顶层**，不在 need 里；
 *   need 内同名字段仅作显式覆盖，便于定向调参）。
 * @param {{readWindow:Function, hasLastVariables:Function, createScopedMessages:Function}} helpers
 * @returns {undefined | {chat:object, messageCount:number, from:number, revision:number}}
 */
export async function readStoryInput(db, { chatId, sessionId, need, pageSize, maxRows } = {}, helpers = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('story 输入需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('story 输入缺少 chatId')
  const readWindow = requireHelper(helpers, 'readWindow')
  const createScopedMessages = requireHelper(helpers, 'createScopedMessages')
  const {
    storyRows = 0, lastAssistant = false, lastVariables = false,
    enough = () => true, include = [], revision,
    pageSize: needPageSize, maxRows: needMaxRows,
  } = need ?? {}
  if (typeof enough !== 'function') throw new Error('story 输入 enough 必须是函数')
  if (!Array.isArray(include)) throw new Error('story 输入 include 必须是楼层号数组')
  const effectivePageSize = needPageSize ?? pageSize ?? STORY_INPUT_PAGE_SIZE
  const effectiveMaxRows = needMaxRows ?? maxRows ?? STORY_INPUT_MAX_ROWS
  assertStoryInputLimit(effectivePageSize)
  if (!Number.isSafeInteger(effectiveMaxRows) || effectiveMaxRows < 1) throw new Error('story 输入 maxRows 非法')
  const pinnedRevision = assertStoryInputRevision(revision)

  // 1) 首窗（作者是 limit/checkpoints 语义的窄头读；revision 给定时由 readWindow 自行 pin）
  const first = await readPinnedWindow(readWindow, chatId, {
    limit: effectivePageSize,
    includeCheckpoints: true,
    ...(pinnedRevision === undefined ? {} : { revision: pinnedRevision }),
  })
  const head = first?.chat
  if (!head || (pinnedRevision !== undefined && first.revision !== pinnedRevision)
    || (sessionId !== undefined && head.sessionId !== sessionId)
    || head.backgroundConfigVersion !== 1 || head.conversationFeaturesVersion !== 1
    || legacyStoryBody(head)) return undefined
  const expectedRevision = first.revision

  // 2) 深度：宿主在事务外算好（作者 storyContext 用 worldBookScanDepth(header)+1）
  const depth = typeof storyRows === 'function' ? await storyRows(head) : storyRows
  if (!Number.isSafeInteger(depth) || depth < 0) return undefined

  // 3) 同 revision 向前翻页（每页一次窄读，跨 await 不持事务；每页核 currentRevision）
  let rows = head.messages
  let from = first.from
  const satisfied = () => scannedStoryRows(rows, depth)
    && (!lastAssistant || rows.some(row => row?.role === 'assistant'))
    && enough(rows)
  while (from > 0 && !satisfied()) {
    if (rows.length >= effectiveMaxRows) return undefined
    const limit = Math.min(500, Math.max(effectivePageSize, rows.length))
    assertStoryInputLimit(limit)
    const page = await readPinnedWindow(readWindow, chatId, {
      limit, before: from, revision: expectedRevision, fields: ['_storageRevision'],
    })
    // 与作者 bounded-history.js:38 逐字同一三条件（**不**要求页起点＝from-limit：limit 是
    // Math.max(pageSize, rows.length)，翻页到档案起点时可大于剩余 from，此时页起点为 0）。
    if (!page || page.revision !== expectedRevision || page.to !== from - 1) return undefined
    rows = page.chat.messages.concat(rows)
    from = page.from
  }

  const entries = rows.map((row, index) => [from + index, row])

  // 4) 最新变量楼：窗口外经存储世界索引定位（worldMessage 同 dbReadSource），只读那一楼
  if (lastVariables && from > 0) {
    const hasLastVariables = requireHelper(helpers, 'hasLastVariables')
    if (!hasLastVariables(rows)) {
      const position = first.worldMessage
      if (position === undefined) return undefined
      if (position !== null) {
        if (position >= from) return undefined
        const page = await readPinnedWindow(readWindow, chatId, {
          limit: 1, before: position + 1, revision: expectedRevision, fields: ['_storageRevision'],
        })
        const row = page?.revision === expectedRevision ? page.chat.messages[0] : undefined
        if (!row || row.role === 'tavern-helper' || !hasLastVariables([row])) return undefined
        entries.unshift([position, row])
      }
    }
  }

  // 5) 具名楼（changed.indices）：窗口外者按同一 revision 逐楼读，越界即 undefined
  for (const position of new Set(include)) {
    if (!Number.isSafeInteger(position) || position < 0 || position >= first.messageCount) return undefined
    if (position >= from || entries.some(([at]) => at === position)) continue
    const page = await readPinnedWindow(readWindow, chatId, {
      limit: 1, before: position + 1, revision: expectedRevision, fields: ['_storageRevision'],
    })
    if (page?.revision !== expectedRevision || !page.chat.messages[0]) return undefined
    entries.unshift([position, page.chat.messages[0]])
  }

  const { messages: _rows, ...header } = head
  return {
    chat: { ...header, messages: createScopedMessages(first.messageCount, entries) },
    messageCount: first.messageCount,
    from,
    revision: expectedRevision,
  }
}

// ══════════════════════════════════════════════════════════════════════════════════
// S4：候选链前台取数（设计 §6.2）
//
// 合同：readCandidateInput(db, { chatId }, helpers = { readWindow, projectAgentMessageText })
//   -> 与作者 candidate-context-reader.js:15-41 `read()` 的 **chat 形状**相同（首窗字段头＋拼接 messages）
//      | undefined（不支持条件显式返回，不静默降级；宿主据此走 readChat 完整分支）
//
// 等价依据（作者固定提交 68215e47…，只读）：domain/candidate-context-reader.js:15-41。
//   逐字保留：首窗 limit 32 且 fields=candidateContextFields；门槛（无窗→完整分支；
//   `!cardDefinitionSnapshot || openingWorldbookSnapshot?.version!==1 || 任一 body 前台完成`→完整分支）；
//   hasText＝`role==='assistant' && projectAgentMessageText(message,{charName:cardDefinitionSnapshot.name,
//   macroState}).trim()!==''`（谓词由宿主注入，本模块不重写）；翻页条件
//   `from>0 && (count<6 || (!promptTemplateInput?.message && lastTavernHelperVariables(messages)===undefined))`；
//   翻页参数 `limit 32, before=from, revision=首窗 revision`；新页 messages **unshift** 前插。
// 窄化（本刀核心，设计 §6.2）：candidateContextFields 里的 `timeline.*` 点路径在 store 侧会全组装
//   timeline（含 2.5MB operations 整条）；本实现把 `chat.timeline` 换成**窄形状**
//   （@meta 标量＋小字段 operations 字典＋checkpoints=[]），消费方只判 legacy body（kind/status）。
//   窄读失败（无 @meta／非 v4 子行形态）→ 返回 undefined，交宿主完整分支，不猜不降级。
// ══════════════════════════════════════════════════════════════════════════════════

/** 作者 task-state-reader.js:4-9 `taskStateFields`（逐字同列表，用于首窗字段头）。 */
export const TASK_STATE_FIELDS = Object.freeze([
  'title', 'createdAt', 'lastOpenedAt', 'backgroundHistoryIds',
  'id', 'sessionId', '_storageRevision', 'mode', 'backgroundConfigVersion', 'conversationFeaturesVersion',
  'regenInProgress', 'contextCompaction', 'cardPath', 'cardName', 'requestMode', 'candidates', 'taskMailbox', 'candidateAgent', 'updatedAt',
  ...['schemaVersion', 'branchId', 'revision', 'operations', 'participants', 'updatedAt'].map(key => 'timeline.' + key),
])

/** 作者 candidate-context-reader.js:7-13 `candidateContextFields`（逐字同列表与同顺序）。 */
export const CANDIDATE_CONTEXT_FIELDS = Object.freeze([...TASK_STATE_FIELDS,
  'macroState', 'guides', 'posture', 'backgroundTasks', 'backgroundModelSelection', 'backgroundModelRevision',
  'webSearchEnabled', 'scriptState', 'settleStatus', 'settleError', 'cardContextRevision',
  'variables', 'promptTemplateInput', 'promptTemplateInitialVariables', 'worldBookRandomState', 'openingWorldbookSnapshot',
  ...['name', 'description', 'personality', 'scenario', 'mes_example', 'system_prompt', 'post_history_instructions']
    .map(key => 'cardDefinitionSnapshot.' + key),
])

export const CANDIDATE_PAGE_SIZE = 32
/** 作者 candidate-context-reader.js:30 的助手正文下限（满足即停翻页）。 */
export const CANDIDATE_MIN_TEXT_REPLIES = 6

/**
 * timeline 窄读：v4 子行形态下用 @meta（除 checkpoints/operations 的全部键）＋操作小字段字典＋
 * checkpoints=[] 重建**同形状** timeline，避免 store 侧整条组装（含大载荷 operations）。
 * 依据：timeline-nodes.js:4-7（@meta 定义、head 留 NULL 占位）与 :148-177（组装恒补
 * checkpoints/operations 两键，且子行形态下未写过的键不出现 ⇒ 窄读不得发明键）。
 * @returns {{ok:true,timeline:object} | {ok:false,reason:'unsupported-timeline'} | undefined}（undefined＝@meta 缺失⇒损坏）
 */
export function readNarrowTimeline(db) {
  if (!tableExists(db, 'archive_timeline_nodes')) return { ok: false, reason: 'unsupported-timeline' }
  const meta = readTimelineMeta(db)
  if (meta === null) return undefined
  return { ok: true, timeline: { ...meta, operations: readViewOperations(db), checkpoints: [] } }
}

/** 窄 timeline 与 store 全组装值的**消费面**等价判据（测试与自检共用）。
 *  只比消费方真正读的字段：@meta 标量逐字段 JSON 相等、checkpoints 是否非空一致、
 *  operations 的 kind/status/roundOperationId/requestId（及 legacy body 分支会看的
 *  basedOn/committedBranchId/committedRevision）。
 *  明确**不比** operations 整条（窄读只取 VIEW_OPERATION_FIELDS＝本刀要省的那部分）。 */
export function narrowTimelineConsumedFieldsMatch(narrow, full) {
  if (!narrow || !full) return narrow === full
  for (const key of new Set([...Object.keys(full), ...Object.keys(narrow)])) {
    if (key === 'operations' || key === 'checkpoints') continue
    if (JSON.stringify(narrow[key]) !== JSON.stringify(full[key])) return false
  }
  if (Boolean(narrow.checkpoints?.length) !== Boolean(full.checkpoints?.length)) return false
  const ops = { ...(narrow.operations || {}) }, fullOps = { ...(full.operations || {}) }
  for (const id of new Set([...Object.keys(ops), ...Object.keys(fullOps)])) {
    const left = ops[id], right = fullOps[id]
    if (Boolean(left) !== Boolean(right)) return false
    if (!left) continue
    if (left.kind !== right.kind || left.status !== right.status) return false
    // 审计补救（2026-10-08）：这两个键决定 agent.begin 幂等复用与结算轮次 stale 校验/background 落点，
    // 必须在窄形状里逐字透传（有则比、无则同无）。
    if (String(left.roundOperationId ?? '') !== String(right.roundOperationId ?? '')) return false
    if (String(left.requestId ?? '') !== String(right.requestId ?? '')) return false
    // 注意：窄读只取 VIEW_OPERATION_FIELDS，**其余整条字段本就不在窄形状里**，
    // 故这里只能比消费方真正判读的字段；比 right 上任意其它键会让判据永远为假（实测踩过）。
  }
  return true
}

/**
 * @param {object} db 与产品 store 同一 SQLite 句柄
 * @param {{chatId:string}} input
 * @param {{readWindow:Function, projectAgentMessageText:Function}} helpers
 * @returns {undefined | object} 命中时＝作者 read() 的同一 chat 形状
 */
export async function readCandidateInput(db, { chatId } = {}, helpers = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('候选输入需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('候选输入缺少 chatId')
  const readWindow = requireHelper(helpers, 'readWindow')
  const projectAgentMessageText = requireHelper(helpers, 'projectAgentMessageText')
  const lastTavernHelperVariables = requireHelper(helpers, 'lastTavernHelperVariables')

  const first = await readWindow(chatId, { limit: CANDIDATE_PAGE_SIZE, fields: CANDIDATE_CONTEXT_FIELDS })
  if (!first) return undefined
  const chat = first.chat
  // 与作者同序：①先判卡快照（缺即完整分支，作者短路在 timeline 判定之前，不产生额外读取）
  // ②再判 legacy body（作者读全组装 timeline；本实现换窄读，非 v4 子行形态即交完整分支）
  if (!chat.cardDefinitionSnapshot) return undefined
  const narrow = readNarrowTimeline(db)
  if (narrow === undefined) return undefined                                              // @meta 缺失＝损坏，不静默
  if (narrow.ok === false) return undefined                                              // 非子行形态（旧代）⇒ 交完整分支
  chat.timeline = narrow.timeline
  if (chat.openingWorldbookSnapshot?.version !== 1 || legacyStoryBody(chat)) return undefined
  const snapshotName = chat.cardDefinitionSnapshot.name
  const hasText = message => message?.role === 'assistant'
    && projectAgentMessageText(message, { charName: snapshotName, macroState: chat.macroState }).trim() !== ''
  let count = 0
  for (const message of chat.messages) if (hasText(message)) count++
  while (first.from > 0
    && (count < CANDIDATE_MIN_TEXT_REPLIES
      || (!chat.promptTemplateInput?.message && lastTavernHelperVariables(chat.messages) === undefined))) {
    const page = await readPinnedWindow(readWindow, chatId, {
      limit: CANDIDATE_PAGE_SIZE, before: first.from, revision: first.revision, fields: [],
    })
    if (!page || page.revision !== first.revision) return undefined
    for (const message of page.chat.messages) if (hasText(message)) count++
    chat.messages.unshift(...page.chat.messages)
    first.from = page.from
  }
  return chat
}

// ══════════════════════════════════════════════════════════════════════════════════
// S4：结算链前台取数（设计 §6.2）
//
// 合同：readSettlementInputNative(db, { chatId }, helpers = { readWindow, scanDepth, createScopedMessages })
//   -> { ...头窄读字段, messages:createScopedMessages(messageCount, rows 绝对坐标) }
//      | { kind:'fallback', reason }（作者在门槛处 return readChat(chatId)；本实现**不调 readChat**，
//        显式分流交宿主，理由写进 reason，便于宿主与排障定位是哪一条门槛）
//
// 等价依据（作者固定提交 68215e47…，只读）：domain/settlement-input.js:9-29。
//   逐字保留：首窗 limit 200 默认形状；target＝最后一条 `role==='assistant' && mvu.pending===true`
//   的**窗口内相对**下标（找不到 −1）；previous＝target>0 时在 rows[0..target-1] 里找最后一条
//   role==='assistant'（否则 −1）；门槛顺序与判据；prepared＝`preparedWorldBook.revision===timeline.revision`
//   （Number 比较）；`!prepared && from>0` ⇒ depth＝注入的 scanDepth（函数式）且必须安全整数、
//   `scannedStoryRows(rows, depth+1)` 为真，否则 fallback；返回 scoped messages。
// 窄化：timeline 换 @meta 小字段＋operations 小字段字典＋checkpoints=[]（消费方只判
//   schemaVersion/legacy body/checkpoints 数组性），mvu/preparedWorldBook/_storageRevision 走头窄读
//   （fields 列表）——不再为一句话门槛恢复全组装 timeline 与整份头。
// checkpoints 数组性判定依据：v4 子行形态下写侧恒把 checkpoints 作为数组写回（timeline-nodes.js:175
//   组装恒补 `timeline.checkpoints = checkpoints`），故"存在 timeline 占位＋@meta 可读"即可判为数组；
//   本实现仍显式给 []，不造假 key。
// ══════════════════════════════════════════════════════════════════════════════════

/** 结算门槛真正消费的头字段（其余头字段不读、不恢复）。 */
export const SETTLEMENT_HEADER_FIELDS = Object.freeze([
  '_storageRevision', 'backgroundConfigVersion', 'conversationFeaturesVersion',
  'mvu', 'preparedWorldBook',
])

export const SETTLEMENT_PAGE_SIZE = 200

/** 结算链真正的 reason 取值（枚举化，测试按名断言，避免散布魔法串）。 */
export const SETTLEMENT_FALLBACK_REASONS = Object.freeze({
  noWindow: '无窗口',
  noMessages: '窗口缺 messages',
  badRevision: 'revision 非法',
  storageRevision: 'storageRevision 不符',
  backgroundConfigVersion: 'backgroundConfigVersion 非 1',
  conversationFeaturesVersion: 'conversationFeaturesVersion 非 1',
  timelineForm: 'timeline 非子行形态',
  schemaVersion: 'timeline.schemaVersion 非 1',
  legacyBody: 'timeline 存在前台完成的 body',
  mvuDisabled: 'mvu.enabled 非 true',
  mvuOwner: 'mvu.owner 非 official',
  noPending: '无 pending 助手楼',
  noPrevious: '窗口内没有上一条助手楼',
  scanDepth: '扫描深度不足',
})

const isPendingMvuRow = row => row?.role === 'assistant' && row.mvu?.pending === true

/**
 * @param {object} db 与产品 store 同一 SQLite 句柄
 * @param {{chatId:string}} input
 * @param {{readWindow:Function, scanDepth:Function|number, createScopedMessages:Function}} helpers
 * @returns {{kind:'fallback',reason:string} | object}
 */
export async function readSettlementInputNative(db, { chatId } = {}, helpers = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('结算输入需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('结算输入缺少 chatId')
  const readWindow = requireHelper(helpers, 'readWindow')
  const createScopedMessages = requireHelper(helpers, 'createScopedMessages')
  const R = SETTLEMENT_FALLBACK_REASONS
  const fallback = reason => ({ kind: 'fallback', reason })

  const window = await readWindow(chatId, { limit: SETTLEMENT_PAGE_SIZE })
  if (!window) return fallback(R.noWindow)
  const chat = window.chat
  const rows = chat.messages
  // 行内判定按作者同序（在门槛之前算 target/previous）
  if (!Array.isArray(rows)) return fallback(R.noMessages)
  const target = rows.findLastIndex(isPendingMvuRow)
  const previous = target > 0 ? rows.slice(0, target).findLastIndex(row => row?.role === 'assistant') : -1
  if (!Number.isSafeInteger(window.revision)) return fallback(R.badRevision)
  if (chat._storageRevision !== window.revision) return fallback(R.storageRevision)
  if (chat.backgroundConfigVersion !== 1) return fallback(R.backgroundConfigVersion)
  if (chat.conversationFeaturesVersion !== 1) return fallback(R.conversationFeaturesVersion)
  const narrow = readNarrowTimeline(db)
  if (narrow === undefined) throw new Error('结算输入缺少 timeline @meta（head 已声明 timeline 占位但子行元数据缺失＝损坏）')
  if (narrow.ok === false) return fallback(R.timelineForm)
  const timeline = narrow.timeline
  if (timeline.schemaVersion !== 1) return fallback(R.schemaVersion)
  // checkpoints 数组性：子行形态由写侧保证恒数组（timeline-nodes.js:175 组装恒补 `timeline.checkpoints`），
  // 故"@meta 可读 + 占位存在"即已判定为数组；下面仍是显式给 []，不造假 key。
  if (!Array.isArray(timeline.checkpoints)) return fallback(R.schemaVersion)
  if (legacyStoryBody({ timeline })) return fallback(R.legacyBody)
  if (chat.mvu?.enabled !== true) return fallback(R.mvuDisabled)
  if (chat.mvu.owner !== 'official') return fallback(R.mvuOwner)
  if (target < 0) return fallback(R.noPending)
  if (window.from > 0 && previous < 0) return fallback(R.noPrevious)
  const prepared = chat.preparedWorldBook && Number(chat.preparedWorldBook.revision) === Number(timeline.revision)
  if (!prepared && window.from > 0) {
    const depth = typeof helpers.scanDepth === 'function' ? await helpers.scanDepth(chat) : Infinity
    if (!Number.isSafeInteger(depth) || !scannedStoryRows(rows, depth + 1)) return fallback(R.scanDepth)
  }
  return {
    ...chat,
    mvu: chat.mvu,
    preparedWorldBook: chat.preparedWorldBook,
    timeline,
    // scoped 形状是作者返回契约的一部分（作者 :28 用 createScopedMessages），缺它会让消费方拿到
    // 无楼梯度的 Proxy（length 对、下标全 undefined）——本轮实测踩中，故必须显式包装。
    messages: createScopedMessages(window.messageCount, rows.map((row, index) => [window.from + index, row])),
  }
}

// ══════════════════════════════════════════════════════════════════════════════════
// S4：模板链前台取数（设计 §6.2）
//
// 合同：readTemplateWindowNative(db, { chatId, sessionId, from, limit = 200 }, helpers = { readWindow, issue })
//   -> { chat, historyWindow: { ...issue({chatId, revision, messageCount}), from, messageCount＋虚拟楼 } }
//      | undefined（作者门槛：无窗／sessionId 不符／两版本≠1 ⇒ undefined）
//
// 等价依据（作者固定提交 68215e47…，只读）：domain/template-window-reader.js:15-27（配合
//   bounded-history.js:105-114 `readRecentWindow`）。
//   逐字保留：`limit 200`；`readRecentWindow` 的**扩窗**语义（`extended = 安全整数且 ≥0`，
//   `window.from > from` 时按 `limit=min(500, window.from-from)`、`before=window.from`、
//   同 revision 续页并把新页 unshift 前插，`page.to !== window.from-1` 即 null）；
//   `requirePartial:true` ⇒ 当窗口已覆盖整档（from===0）时作者拿 null ⇒ undefined；
//   门槛 sessionId／backgroundConfigVersion／conversationFeaturesVersion；historyWindow 里
//   `messageCount + (promptTemplateInput?.message ? 1 : 0)`（虚拟用户楼的对外计数）。
// 已知边界（如实记，不冒称已窄化）：**本链头读仍是全键形状**（timeline 全组装）。理由：
//   作者返回的就是 `window.chat` 整块头，模板消费方（tavern-script-host-adapter.js:526-539 →
//   projectFullPromptTemplateState，其字段表 templateStateFields 不含 timeline）实际只读
//   id/sessionId/_storageRevision/macroState.userName/cardPath/variables+快照 与 messages。
//   改传 store 的 `fields:'opening'`（跳 timeline 组装）会**删掉** chat.timeline 键：那是改变返回
//   形状、超出"范围选择＋读取"的本刀范围（属于 §9.2 兼容路径问题），故不在本刀做；如需，
//   由主在 store 出口决定并单独审查消费方。
// ══════════════════════════════════════════════════════════════════════════════════

export const TEMPLATE_PAGE_SIZE = 200
export const TEMPLATE_EXTEND_LIMIT_CAP = 500

/** 自建 readRecentWindow 等价件：extended 时同 revision 向 from 扩窗；`to !== from-1` 即中断（作者返回 null）。 */
async function extendWindowTo(sessionReadWindow, chatId, window, from) {
  let current = window
  while (current && current.from > from) {
    const limit = Math.min(TEMPLATE_EXTEND_LIMIT_CAP, current.from - from)
    const page = await readPinnedWindow(sessionReadWindow, chatId, {
      limit, before: current.from, revision: current.revision, fields: ['_storageRevision'],
    })
    if (!page || page.revision !== current.revision || page.to !== current.from - 1) return null
    current = { ...current, from: page.from, chat: { ...current.chat, messages: page.chat.messages.concat(current.chat.messages) } }
  }
  return current
}

/**
 * @param {object} db 与产品 store 同一 SQLite 句柄
 * @param {{chatId:string, sessionId:string, from?:number, limit?:number}} input
 * @param {{readWindow:Function, issue:Function}} helpers
 * @returns {undefined | {chat:object, historyWindow:object}}
 */
export async function readTemplateWindowNative(db, { chatId, sessionId, from, limit = TEMPLATE_PAGE_SIZE } = {}, helpers = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('模板窗口需要真实 SQLite 句柄')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('模板窗口缺少 chatId')
  const readWindow = requireHelper(helpers, 'readWindow')
  const issue = requireHelper(helpers, 'issue')
  assertStoryInputLimit(limit)
  const extended = Number.isSafeInteger(from) && from >= 0
  // 逐字对齐 bounded-history.js:107：`requirePartial: requirePartial && !extended`
  // ⇒ extended 时不要求"部分窗口"；未 extended 且窗口已覆盖整档 ⇒ store 返回 null ⇒ undefined
  const first = await readPinnedWindow(readWindow, chatId, { limit, requirePartial: !extended })
  if (!first) return undefined
  let window = first
  if (extended && first.from > from) {
    window = await extendWindowTo(readWindow, chatId, first, from)
    if (!window) return undefined
  }
  if (window.chat.sessionId !== sessionId) return undefined
  if (window.chat.backgroundConfigVersion !== 1 || window.chat.conversationFeaturesVersion !== 1) return undefined
  return {
    chat: window.chat,
    historyWindow: {
      ...issue({ chatId, revision: window.revision, messageCount: window.messageCount }),
      from: window.from,
      messageCount: window.messageCount + (window.chat.promptTemplateInput?.message ? 1 : 0),
    },
  }
}

export const _internals = Object.freeze({
  VIEW_OPERATION_FIELDS, SUPPORTED_MODES, SUPPORTED_TIMELINE_SCHEMA, readViewOperations, readTimelineMeta, readIdentity, tableExists, str,
  STORY_INPUT_PAGE_SIZE, STORY_INPUT_MAX_ROWS, legacyStoryBody, scannedStoryRows, assertStoryInputLimit, assertStoryInputRevision,
  TASK_STATE_FIELDS, CANDIDATE_CONTEXT_FIELDS, CANDIDATE_PAGE_SIZE, CANDIDATE_MIN_TEXT_REPLIES, readNarrowTimeline, narrowTimelineConsumedFieldsMatch,
  SETTLEMENT_HEADER_FIELDS, SETTLEMENT_PAGE_SIZE, SETTLEMENT_FALLBACK_REASONS,
  TEMPLATE_PAGE_SIZE, TEMPLATE_EXTEND_LIMIT_CAP,
})
