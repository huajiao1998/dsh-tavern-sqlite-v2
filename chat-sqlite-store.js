import { DatabaseSync } from 'node:sqlite'
import { assertRollbackChatWritable } from './lib/rollback-barrier.js'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { createVariableArchive } from './lib/variable-archive.js'
import { createChatProjectionReads, readProjectionHeader, readSqlSnapshot } from './lib/chat-projection-reads.js'
import { revisions as componentRevisions } from './lib/component-revisions.js'
import { createRollbackWorldbookHistory } from './lib/rollback-worldbook-history.js'

// 本模块**不再直接 import 作者的三个模块**（copy-json-tree / chat-session-state / json-mutation）：
// 它们是作者的代码，必须由作者树的「薄垫片」注入（见 deploy/chat-sqlite-store.shim.js）。
// 这样真代码在我们包里（上游更新碰不到），而投影/JSON 工具仍与作者其它代码是**同一份实现**
// （不会出现两套投影分叉）。缺少注入时 fail-loud，不静默。

/**
 * SQLite 后端的 Tavern Chat 存储（3.6 schema v3：只写变化的部分）：
 *   archive_head        单行：仅 revision / updated_at
 *   archive_head_fields 头部逐键一行（key 主键, ord 键序, kind=1 表 messages 占位, value_json 可空）
 *                       —— 未变化的键既不序列化也不写库；键序由 ord 承载（LLM 前缀缓存依赖，保持 JSON 属性序）
 *   archive_messages    每楼一行（message_index 主键）—— 写哪楼改哪楼，无变更行零序列化零写入
 * 没有变更帧、没有历史快照表：回退 = 尾部 DELETE 行（零残留）+ 写后自检（行数 / MAX(index)）；写入 = 条件落库（原子）。
 * 上层接口与 chat-journal-store 完全一致；v1/v2 schema 打开时自动迁移（先读→DROP 旧表→再写，避免留下 freelist 化石）。
 */
const STORAGE_REVISION = '_storageRevision'

function revisionOf(value) {
  return Math.max(0, Number(value && value[STORAGE_REVISION]) || 0)
}

function jsonClone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** JSON 文本化；非 JSON 值（function/symbol）stringify 得 undefined 时退回 fallback。
 *  L1 起 `next` 由 copyJsonTree 脱离（不再经 JSON 往返），故此处要自己兜住这些退化值：
 *  头部键 → NULL（assemble 本就跳过 NULL，与 v2 jsonClone 丢掉该键等效）；楼层 → 'null'（必须是合法 JSON）。 */
function jsonText(value, fallback = null) {
  if (value === undefined) return fallback
  const json = JSON.stringify(value)
  return json === undefined ? fallback : json
}

function safeChatId(value) {
  const id = String(value || '')
  if (id === '' || id.includes('/') || id.includes('\\') || id === '.' || id === '..') throw new Error('Tavern Chat ID 不合法')
  return id
}

async function readJsonFile(target) {
  try { return JSON.parse(await readFile(target, 'utf8')) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
}

export function createChatSqliteStore(options = {}) {
  // ---- 注入的 helper（由作者树的薄垫片提供，见 deploy/chat-sqlite-store.shim.js）----
  // 缺任何一个都 fail-loud：绝不静默半可用（否则会以"投影不对/差异算错"的形式悄悄坏掉）。
  const helpers = options.helpers ?? {}
  const REQUIRED_HELPERS = [
    'copyJsonTree', 'diffJson', 'applyJsonChangesShared',
    'projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState',
    'projectChatBackgroundConfig', 'projectSettlementCheckpoint',
  ]
  const missingHelpers = REQUIRED_HELPERS.filter(name => typeof helpers[name] !== 'function')
  if (missingHelpers.length > 0) {
    throw new Error('chat-sqlite-store：缺少注入的 helper（' + missingHelpers.join(', ') +
      '）—— 请确认作者树的薄垫片已安装，且 dsh-tavern-sqlite-v2 可用')
  }
  // 作者 2.4 新读协议（窗口 / Helper 上下文 / 结算基座）用的**协议投影**注入。
  // 故意**不进 REQUIRED_HELPERS**：历史 fixture 只注 8 项，构造期不能因此失败；
  // 但这几件是作者那一份投影，缺了就会分叉出第二套实现 ⇒ 只在**调用期**响亮失败，不静默降级。
  function requireProtocolHelper(api, name) {
    const fn = helpers[name]
    if (typeof fn !== 'function') {
      throw new Error('chat-sqlite-store：' + api + ' 需要注入 helper ' + name +
        '（协议投影必须用作者那一份，不另造第二份实现）——请重新施缝 deploy/chat-sqlite-store.shim.js')
    }
    return fn
  }
  const {
    copyJsonTree, diffJson, applyJsonChangesShared,
    projectSceneImageState, projectChatSessionState, projectDisplayRuntimeState,
    projectChatBackgroundConfig, projectSettlementCheckpoint,
  } = helpers

  const dataRoot = path.resolve(String(options.dataRoot || ''))
  if (dataRoot === '') throw new Error('Chat SQLite Store 缺少 dataRoot')
  const chatsRoot = path.join(dataRoot, 'chats')
  const legacyData = options.legacyData
  const logger = options.logger || console
  const now = typeof options.now === 'function' ? options.now : Date.now
  const mutationTails = new Map()
  const limit = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback
  const cacheMaxBytes = limit(options.cacheMaxBytes, 256 * 1024 * 1024)
  const maxCachedChats = limit(options.maxCachedChats, 8)
  const readCache = new Map()
  // SQL摘要/投影结果与完整Chat缓存分离，按连接+提交revision失效；仅出借脱离副本。
  const projectionReads = createChatProjectionReads({helpers, maxEntries: maxCachedChats, maxBytes: Math.min(cacheMaxBytes, 16 * 1024 * 1024)})
  const pendingReads = new Map()
  const rollbackWorldbooks = createRollbackWorldbookHistory()
  const sizes = new WeakMap()
  const density = new WeakMap()
  const validMessage = row => row && typeof row === 'object' && !Array.isArray(row)
  function dense(messages) {
    if (!Array.isArray(messages)) return false
    if (!density.has(messages)) density.set(messages, messages.every(validMessage))
    return density.get(messages)
  }
  let cachedBytes = 0
  const open = new Map()
  const generations = new Map()
  let disposed = false

  // 变量归档（PLG-012 C）：变量快照链/当前态建在**本档同一个 archive.db、同一个连接**里 ——
  // 不另建 variables.db、不双写、不扫原件；写路径与 writeChat 同事务（变量写失败整笔 chat write 回滚）。
  // 句柄复用本 store 的 handle（读用 {create:false}），所以本模块不持有/不关闭连接。
  const variables = createVariableArchive({
    logger, now,
    handle: (chatId, handleOptions) => handle(chatId, handleOptions),
    isEligibleRow: mvuEligible,
  })
  // 对作者树暴露的 store.variables（chatId 优先，与 LAB 的变量 store 同名同形）：主装配把它接到
  // 作者 index 的 variableSqliteStore 位置；deleteFrom 由作者回退轮调用（只删变量自己的表）。
  const variablesApi = Object.freeze({
    has: variables.has,
    snapshot: variables.snapshot,
    snapshotAll: variables.snapshotAll,
    snapshotAt: variables.snapshotAt,
    deleteFrom: variables.deleteFrom,
    stats: variables.stats,
    dispose: variables.dispose,
  })

  function generationStamp(chatId) {
    const id = safeChatId(chatId)
    return 'sqlite:gen:' + (generations.get(id) || 0) + (existsSync(dbFile(id)) ? '' : ':empty')
  }

  function bumpGeneration(chatId) {
    const id = safeChatId(chatId)
    generations.set(id, (generations.get(id) || 0) + 1)
    projectionReads.forget(id)
  }

  function dbFile(chatId) {
    return path.join(chatsRoot, safeChatId(chatId), 'archive.db')
  }

  function hasLegacyArtifact(chatId) {
    const id = safeChatId(chatId)
    return existsSync(path.join(chatsRoot, id + '.json')) || existsSync(path.join(chatsRoot, id, 'head.json'))
  }

  // 原档身份不因同 ID 的空库/旧迁移残留而变成可写；只能显式分叉到全新的 ID。
  // 在读取缓存/调用 updater 前检查实物，读不出来的原档也不能被当成新档覆盖。
  function assertWritableChat(chatId, state) {
    const id = safeChatId(chatId)
    if (state?.legacy !== true && !hasLegacyArtifact(id)) return
    const error = new Error('原档只读，可打开查看但不可修改或原地迁移；请手动分叉为新的数据库存档后再游玩：' + id)
    error.code = 'DSH_TAVERN_LEGACY_READ_ONLY'
    error.chatId = id
    throw error
  }

  /** 观察点（架构文档 §13.4）：非尾部 splice 说明有路径在做「中间删改」。
   *  diffValue 的 splice 恒在尾部；patch() 的可能是中间。每个档只记一次，供事后审计。 */
  const nonTailSpliceSeen = new Set()
  function noteNonTailSplice(chat, count) {
    const id = chat && typeof chat.id === 'string' ? chat.id : '<unknown>'
    if (nonTailSpliceSeen.has(id)) return
    nonTailSpliceSeen.add(id)
    try { logger.log('[chat-sqlite-store] 非尾部 splice（中间删改）首次出现：档 ' + id + '，本次 ' + count + ' 处；已按「从 splice 起点起重写剩余楼」处理') } catch { /* logger 不可用则静默 */ }
  }

  /** v3 统一写路径（只写变化的部分）：未变化的键/楼既不序列化也不写库。
   *  changes === null → 全量（首写 / 迁移）；否则为 path 级 op 列表（diffJson 产出，或 patch() 归一化后的列表）。
   *  inTransaction → 由调用方（迁移）自己开事务。
   *  变量快照/state 在**同一事务**里更新（见 lib/variable-archive.js）：变量写失败 ⇒ 整笔回滚。
   *  返回实际落库的 {chat, changes}：内部整理写集与调用方写集一起交给增量证据，不再全档重diff。 */
  function writeChat(db, chatId, chat, revision, at, changes, options = {}) {
    const keys = Object.keys(chat)
    const messages = Array.isArray(chat.messages) ? chat.messages : []
    const useTransaction = options.inTransaction !== true
    if (useTransaction) db.exec('BEGIN')
    try {
      // 当前书保持作者接口；逐轮历史仅在同一事务存一次完整版本，账本留精确引用。
      const compacted = rollbackWorldbooks.compact(db, chat)
      if (compacted !== chat && changes !== null) changes = [...changes, { op: 'set', path: ['timeline'], value: compacted.timeline }]
      chat = compacted
      // ---- 头部键序/增删：只动 ord 与增删，绝不为了改序而重新序列化未变化的键 ----
      const stored = db.prepare('SELECT key, ord FROM archive_head_fields ORDER BY ord').all()
      const ordOf = new Map()
      keys.forEach((key, index) => ordOf.set(key, index))
      const want = new Set(keys)
      const storedSet = new Set(stored.map(row => row.key))
      const deleteField = db.prepare('DELETE FROM archive_head_fields WHERE key = ?')
      const updateOrd = db.prepare('UPDATE archive_head_fields SET ord = ? WHERE key = ?')
      for (const row of stored) {
        if (!want.has(row.key)) deleteField.run(row.key)
        else if (Number(row.ord) !== ordOf.get(row.key)) updateOrd.run(ordOf.get(row.key), row.key)
      }
      // ---- 头部值：只写变化的键 ----
      let changed
      if (changes === null) changed = new Set(keys)
      else {
        changed = new Set()
        for (const change of changes) {
          if (!change.path.length) { changed = new Set(keys); break }
          if (change.path[0] !== 'messages') changed.add(change.path[0])
        }
        for (const key of keys) if (!storedSet.has(key)) changed.add(key)   // 新增键（防御：changes 本应已覆盖）
      }
      const upsertField = db.prepare(`INSERT INTO archive_head_fields (key, ord, kind, value_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET ord = excluded.ord, kind = excluded.kind, value_json = excluded.value_json`)
      keys.forEach((key, index) => {
        if (key === 'messages') { upsertField.run(key, index, 1, null); return }   // 占位：参与键序
        if (!changed.has(key)) return
        const value = chat[key]
        upsertField.run(key, index, 0, jsonText(value))
      })
      // ---- 楼层：先定"本次真的写了哪些楼"，再由变量归档在**同一事务**里决定实际落库的形态 ----
      const prevCount = Number(db.prepare('SELECT COUNT(*) AS n FROM archive_messages').get().n)
      let rewriteAll = changes === null
      let nonTailSplices = 0
      let touchedIndices
      if (changes === null) {
        touchedIndices = messages.map((_row, index) => index)
      } else {
        const touched = new Set()
        for (const change of changes) {
          if (!change.path.length) { rewriteAll = true; break }
          if (change.path[0] !== 'messages') continue
          // ⚠ 顺序要紧：splice 的 path 恒为 ['messages']（长度 1），
          //   必须【先】判 splice，否则会被下面的"长度 1 = 整个数组被替换"抢先吃掉，
          //   变成每次追加都全量重写全部楼层（曾经踩过）。
          if (change.op === 'splice') {
            // diffValue 的 splice 恒在尾部；patch() 传来的可能是中间 splice。
            // 两种都"从 splice 起点起重写剩余楼"：正确、且对尾部情形就是最小改动。
            const from = Number(change.index)
            const items = Array.isArray(change.items) ? change.items.length : 0
            const dropped = Number(change.deleteCount) || 0
            const pureAppend = Number.isSafeInteger(from) && from === prevCount && dropped === 0
            const pureTruncate = Number.isSafeInteger(from) && items === 0 && from + dropped === prevCount
            if (!pureAppend && !pureTruncate) nonTailSplices++
            for (let index = Number.isSafeInteger(from) ? from : 0; index < messages.length; index++) touched.add(index)
            continue
          }
          if (change.path.length === 1) { rewriteAll = true; break }        // 整个 messages 被 set/delete 替换
          const index = change.path[1]
          if (Number.isSafeInteger(index)) touched.add(index)
        }
        touchedIndices = rewriteAll
          ? messages.map((_row, index) => index)
          : [...touched].filter(index => index < messages.length).sort((left, right) => left - right)
      }
      const truncated = prevCount > messages.length
      // ---- 变量（同一事务）：变化楼落快照 + 当前态 + 尾部清残 + K4 修剪（窗口外老楼先存快照再删）----
      //   header-only 写（touchedIndices 空且无截断）在这里不做任何扫描，直接原样返回。
      //   written = 本次 touched ∪ 被修剪的楼：修剪改了行内容，必须一起落库。
      const prepared = variables.prepareWrite(db, chatId, chat, { touched: touchedIndices, truncated })
      const storedChat = prepared.chat
      const storedMessages = Array.isArray(storedChat.messages) ? storedChat.messages : messages
      // prepareWrite只在修剪时替换自有楼对象；仅在实际written楼内补内部变化，不比较整档。
      // 修剪楼可能不在业务touched里，仍须进入changedSlice/indices等增量证据。
      if (changes !== null && storedChat !== chat) {
        const internal = []
        for (const index of prepared.written) {
          if (storedMessages[index] === messages[index]) continue
          for (const change of diffJson(messages[index], storedMessages[index])) {
            internal.push({ ...change, path: ['messages', index, ...change.path] })
          }
        }
        if (internal.length) changes = [...changes, ...internal]
      }
      const upsertMessage = db.prepare(`INSERT INTO archive_messages (message_index, message_json) VALUES (?, ?)
        ON CONFLICT(message_index) DO UPDATE SET message_json = excluded.message_json`)
      const putMessage = index => upsertMessage.run(index, jsonText(storedMessages[index], 'null'))
      if (rewriteAll) for (let index = 0; index < messages.length; index++) putMessage(index)
      else for (const index of prepared.written) putMessage(index)
      if (nonTailSplices > 0) noteNonTailSplice(chat, nonTailSplices)
      // 尾部残留（回退截断的落点；也自愈历史残留）—— 变量侧的越界快照已由变量归档清掉
      if (truncated) db.prepare('DELETE FROM archive_messages WHERE message_index >= ?').run(messages.length)
      // ---- 自检（fail-loud）：干净回退的安全网，别等用户发现 ----
      const check = db.prepare('SELECT COUNT(*) AS n, MAX(message_index) AS m FROM archive_messages').get()
      if (Number(check.n) !== messages.length || (messages.length === 0 ? check.m !== null : Number(check.m) !== messages.length - 1)) {
        throw new Error('Chat 存储自检失败：楼层行数与 chat 不一致（rows=' + check.n + ' max=' + check.m + ' chat=' + messages.length + '）')
      }
      // ---- 头部元数据 ----
      db.prepare(`INSERT INTO archive_head (id, revision, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`).run(revision, at)
      if (useTransaction) db.exec('COMMIT')
      // ---- D-3（2026-10-05）：K-1 轮边界检查点扩展到 archive.db ----
      // 写入含新楼（追加轮次）的批次之后，把 WAL 帧并入主库 → 主库最多落后一轮，
      // 拷 .db 只丢一轮（与 sessions 线 K-1 同式；有读者占用退 PASSIVE，异常不上抛）。
      if (touchedIndices.length > 0 && !truncated) {
        try {
          const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
          if (Number(result?.busy ?? 0) !== 0) {
            db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
          }
        } catch { /* 检查点失败不挡写入 */ }
      }
      // ---- 修A：按实际改动范围 bump 部件版本（投影缓存据此做选择性失效）----
      // header 变了 = changed 集合非空（头字段有增删改）；messages 变了 = 有楼被写/截断/全量重写。
      const compRev = componentRevisions(db)
      const headerChanged = changed.size > 0
      const messagesChanged = rewriteAll || touchedIndices.length > 0 || truncated
      if (headerChanged) compRev.header++
      if (messagesChanged) compRev.messages++
      const beforeMessages = readCache.get(chatId)?.state.chat.messages
      // 只在首读/失去证据时核全量；已知dense的不可变旧数组只校验本次写楼。
      density.set(storedMessages, !rewriteAll && density.get(beforeMessages) === true
        ? touchedIndices.every(index => validMessage(storedMessages[index]))
        : storedMessages.every(validMessage))
      return { chat: storedChat, changes }
    } catch (error) {
      if (useTransaction) { try { db.exec('ROLLBACK') } catch { /* Connection-level failure; nothing to roll back. */ } }
      throw error
    }
  }

  function handle(chatId, { create = false } = {}) {
    const id = safeChatId(chatId)
    if (disposed) {
      // dispose 之后：不再打开/创建任何句柄（读回"没有"而不是偷偷重开），写入由各写口响亮拒绝。
      if (create) throw new Error('Chat SQLite Store 已 dispose：不能再创建/打开句柄')
      return null
    }
    const file = dbFile(id)
    if (!create && !existsSync(file)) return null
    const existing = open.get(id)
    if (existing) {
      open.delete(id)
      open.set(id, existing)
      return existing
    }
    if (create) mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode = WAL')
    ensureSchema(db)
    open.set(id, db)
    while (open.size > 8) {
      const oldest = open.keys().next().value
      try { open.get(oldest).close() } catch { /* Already closed by remove(). */ }
      open.delete(oldest)
      projectionReads.forget(oldest)
    }
    return db
  }

  function ensureSchema(db) {
    rollbackWorldbooks.ensureTables(db)
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    if (tables.has('archive_head_fields')) {
      // 已是 v3：变量表可能是这次接入才有的（旧 v3 档没有）——**早返回也必须建**，否则读写变量全部落空。
      variables.ensureTables(db)
      return
    }
    const hasState = tables.has('archive_state')
    const hasHead = tables.has('archive_head')
    if (hasState && !hasHead) {
      // v1（archive_state/journal/snapshots）→ v3：先读出整档，再 DROP 旧表（先释放），最后建 v3 并写
      db.exec('BEGIN')
      try {
        const stateRow = db.prepare('SELECT chat_json, revision FROM archive_state WHERE id = 1').get()
        const chat = stateRow === undefined ? null : JSON.parse(stateRow.chat_json)
        for (const name of ['archive_journal', 'archive_snapshots', 'archive_state']) {
          if (tables.has(name)) db.exec('DROP TABLE ' + name)
        }
        createV3Tables(db)
        if (chat !== null) {
          const migratedId = typeof chat === 'object' && chat !== null && typeof chat.id === 'string' ? chat.id : ''
          writeChat(db, migratedId, chat, Number(stateRow.revision), now(), null, { inTransaction: true })
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* Connection-level failure; nothing to roll back. */ }
        throw error
      }
      return
    }
    if (hasHead) {
      // v2（单行 head_json + keys_json）→ v3：先读出（内存）→ DROP 旧表 → 再建 v3 并写字段
      // 顺序铁律：先释放、后写入。v1→v2 当年反过来做，留下了单档最高 111 MB 的永久 freelist。
      db.exec('BEGIN')
      try {
        const headRow = db.prepare('SELECT head_json, keys_json, revision, updated_at FROM archive_head WHERE id = 1').get()
        const oldHead = headRow === undefined ? null : JSON.parse(headRow.head_json)
        const oldKeys = headRow === undefined ? null : JSON.parse(headRow.keys_json)
        db.exec('DROP TABLE archive_head')
        db.exec(`CREATE TABLE archive_head (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )`)
        db.exec(`CREATE TABLE archive_head_fields (
          key TEXT PRIMARY KEY,
          ord INTEGER NOT NULL,
          kind INTEGER NOT NULL,
          value_json TEXT
        )`)
        db.exec('CREATE INDEX archive_head_fields_ord ON archive_head_fields (ord)')
        if (headRow !== undefined) {
          const insertField = db.prepare('INSERT INTO archive_head_fields (key, ord, kind, value_json) VALUES (?, ?, ?, ?)')
          oldKeys.forEach((key, index) => {
            if (key === 'messages') insertField.run(key, index, 1, null)
            else if (Object.hasOwn(oldHead, key)) insertField.run(key, index, 0, JSON.stringify(oldHead[key]))
            else insertField.run(key, index, 0, null)
          })
          db.prepare('INSERT INTO archive_head (id, revision, updated_at) VALUES (1, ?, ?)')
            .run(Number(headRow.revision), Number(headRow.updated_at))
        }
        variables.ensureTables(db)     // v2→v3 同样要补变量表（archive_messages 里的旧行保持原样，不隐式迁入）
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* Connection-level failure; nothing to roll back. */ }
        throw error
      }
      return
    }
    createV3Tables(db)
  }

  function createV3Tables(db) {
    db.exec(`CREATE TABLE archive_head (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
    db.exec(`CREATE TABLE archive_head_fields (
      key TEXT PRIMARY KEY,
      ord INTEGER NOT NULL,
      kind INTEGER NOT NULL,
      value_json TEXT
    )`)
    db.exec('CREATE INDEX archive_head_fields_ord ON archive_head_fields (ord)')
    db.exec(`CREATE TABLE archive_messages (
      message_index INTEGER PRIMARY KEY,
      message_json TEXT NOT NULL
    )`)
    variables.ensureTables(db)     // 变量快照/state 与本档同库同连接（不另建 variables.db）
  }

  function assemble(db) {
    const headRow = db.prepare('SELECT revision FROM archive_head WHERE id = 1').get()
    if (headRow === undefined) return null
    const fields = db.prepare('SELECT key, kind, value_json FROM archive_head_fields ORDER BY ord').all()
    const rows = db.prepare('SELECT message_index, message_json FROM archive_messages ORDER BY message_index').all()
    const messages = new Array(rows.length)
    for (const row of rows) messages[Number(row.message_index)] = JSON.parse(row.message_json)
    const chat = {}
    let placed = false
    for (const field of fields) {
      if (field.kind === 1 || field.key === 'messages') { chat.messages = messages; placed = true; continue }
      if (field.value_json === null) continue        // 与 v2 一致：值 undefined 的键在重建时被略过
      chat[field.key] = JSON.parse(field.value_json)
    }
    if (!placed) chat.messages = messages
    chat[STORAGE_REVISION] = Number(headRow.revision)
    return { chat, revision: Number(headRow.revision) }
  }

  function serialize(chatId, operation) {
    const id = safeChatId(chatId)
    const previous = mutationTails.get(id) || Promise.resolve()
    const current = previous.catch(function () {}).then(operation)
    mutationTails.set(id, current)
    return current.finally(function () { if (mutationTails.get(id) === current) mutationTails.delete(id) })
  }

  // 未迁移档的读取：**两种承载都要能读**
  //   ① journal 单文件 `chats/<id>.json`（legacyData.readJson / 直接读文件）
  //   ② 上游 v2.4 起的**内容寻址块布局** `chats/<id>/head.json` + `blocks/**`
  //      —— 它只有"作者那套 store"认得，所以必须由调用方把作者 store 作为
  //      `legacyStore` 注进来（**不能要求用户先改存档形态**：真实用户装完插件就
  //      是这种块布局，迁移必须原样读得出来）。
  // 2026-09-30：先前只实现了 ①，测试时我把块布局手工转成单文件才让流程跑通 ——
  //   那是**改了被测物**、掩盖了缺口（用户当场指出）。现在补 ②。
  async function legacyRead(chatId) {
    const id = safeChatId(chatId)
    const legacyRelative = 'chats/' + id + '.json'
    const fromJson = legacyData && typeof legacyData.readJson === 'function'
      ? await legacyData.readJson(legacyRelative)
      : await readJsonFile(path.join(chatsRoot, id + '.json'))
    if (fromJson !== undefined && fromJson !== null) return fromJson
    const legacyStore = options.legacyStore
    if (legacyStore && typeof legacyStore.read === 'function') {
      try {
        const chat = await legacyStore.read(id)
        if (chat !== undefined && chat !== null) return chat
      } catch (error) {
        // 作者 store 也读不出来（真没有这个档 / 格式不认识）⇒ 当作没有 legacy
        logger.warn?.('[session-sqlite] 块布局 legacy 读取失败 ' + id + '：' + String(error?.message || error))
      }
    }
    return undefined
  }

  // ---------- 读缓存（与后端无关） ----------
  function estimateBytes(value) {
    if (typeof value === 'string') return 24 + value.length * 2
    if (!value || typeof value !== 'object') return 8
    if (sizes.has(value)) return sizes.get(value)
    let size = 64
    for (const key of Object.keys(value)) size += 24 + key.length * 2 + estimateBytes(value[key])
    sizes.set(value, size)
    return size
  }
  function forgetState(chatId) {
    const entry = readCache.get(chatId)
    if (entry) cachedBytes -= entry.bytes
    readCache.delete(chatId)
  }
  function rememberState(chatId, stamp, state, recentChanges = []) {
    forgetState(chatId)
    if (!stamp || !state || !maxCachedChats || !cacheMaxBytes) return
    let bytes
    try { bytes = estimateBytes(state) + estimateBytes(recentChanges) + estimateBytes(stamp) } catch { return }
    if (bytes > cacheMaxBytes) return
    readCache.set(chatId, { stamp, state, recentChanges, bytes })
    cachedBytes += bytes
    while (readCache.size > maxCachedChats || cachedBytes > cacheMaxBytes) forgetState(readCache.keys().next().value)
  }
  function knownChanges(chatId, state) {
    const entry = readCache.get(chatId)
    return entry?.state === state ? entry.recentChanges : []
  }

  // ---------- 惰性迁移：文件版 → SQLite（行级） ----------
  function hasFileStoreData(chatId) {
    const id = safeChatId(chatId)
    return existsSync(path.join(chatsRoot, id, 'snapshots')) || existsSync(path.join(chatsRoot, id, 'journals'))
  }

  async function cachedState(chatId) {
    const stamp = await version(chatId)
    const entry = readCache.get(chatId)
    if (stamp && entry?.stamp === stamp) {
      readCache.delete(chatId)
      readCache.set(chatId, entry)
      return entry.state
    }
    forgetState(chatId)
    const pending = pendingReads.get(chatId)
    if (pending?.stamp === stamp) return pending.promise
    const load = { stamp }
    load.promise = (async () => {
      try {
        const state = await materialize(chatId)
        if (stamp && stamp === await version(chatId) && pendingReads.get(chatId) === load) {
          rememberState(chatId, stamp, state)
        }
        return state
      } finally {
        if (pendingReads.get(chatId) === load) pendingReads.delete(chatId)
      }
    })()
    pendingReads.set(chatId, load)
    return load.promise
  }

  async function materialize(chatId, targetRevision = Number.POSITIVE_INFINITY) {
    const id = safeChatId(chatId)
    const file = dbFile(id)
    // 原件优先，不能为了查看旧 ID 打开 shadow 数据库并触发 WAL/schema 升级。
    const original = hasLegacyArtifact(id)
    if (original || !existsSync(file)) {
      if (!original && hasFileStoreData(id)) {
        // [a1-file-store-retired] 2026-09-29 砍单刀6：文件存档后端已退役，journals/snapshots 不再是迁移源
        throw new Error('文件版存档已退役：' + id + ' 存在 journals/snapshots 残留但无 archive.db，请人工处理')
      }
      const legacy = await legacyRead(id)
      if (legacy === undefined) return null
      const revision = revisionOf(legacy)
      if (targetRevision !== Number.POSITIVE_INFINITY && targetRevision !== revision) {
        const error = new Error('Legacy Chat 只有 revision ' + revision + '，无法读取 revision ' + targetRevision)
        error.code = 'DSH_TAVERN_REVISION_NOT_FOUND'
        throw error
      }
      if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy) || legacy.id !== id) throw new Error('Legacy Chat 不合法: ' + id)
      // 作者读源可能缓存/冻结原对象；归一化只写我们脱离后的副本。
      const chat = jsonClone(legacy)
      chat[STORAGE_REVISION] = revision
      return { chat, revision, legacy: true, frameCount: 0, frameBytes: 0 }
    }
    // 行级存储（彻底清理语义）：仅保留当前态，不保留历史版本——被回退/被修改的旧版本不可重建
    if (targetRevision !== Number.POSITIVE_INFINITY) {
      const db = handle(chatId)
      const state = assemble(db)
      if (state !== null && state.revision === targetRevision) {
        return { chat: state.chat, revision: state.revision, legacy: false, frameCount: 0, frameBytes: 0 }
      }
      const error = new Error('行级存储不保留历史版本，找不到 revision ' + targetRevision + ': ' + id)
      error.code = 'DSH_TAVERN_REVISION_NOT_FOUND'
      throw error
    }
    const db = handle(chatId)
    const state = assemble(db)
    if (state === null) return null
    const { chat, revision } = state
    if (!chat || typeof chat !== 'object' || Array.isArray(chat) || chat.id !== id) throw new Error('Archive state 不合法: ' + id)
    return { chat, revision, legacy: false, frameCount: 0, frameBytes: 0 }
  }

  // ---------- 写路径（行级，无帧） ----------
  async function patch(chatId, expectedRevision, changes, metadata = {}) {
    return serialize(chatId, async () => {
      assertActive()
      assertWritableChat(chatId)
      const state = await cachedState(chatId)
      assertWritableChat(chatId, state)
      assertRollbackChatWritable(state?.chat, metadata)
      if (!state || state.revision !== expectedRevision) return undefined
      if (changes.length === 0) { metadata.assertCurrent?.(); return slice(state.chat, []).chat }
      const normalized = []
      for (const change of changes) {
        if (change.op === 'set' && change.value === undefined) {
          if (!change.path.length) throw new Error('Journal root cannot be undefined')
          const current = applyJsonChangesShared(state.chat, normalized)
          let parent = current
          for (const key of change.path.slice(0, -1)) parent = parent?.[key]
          if (!parent || typeof parent !== 'object') throw new Error('Missing mutation parent')
          const key = change.path.at(-1)
          if (Array.isArray(parent)) normalized.push({ ...change, value: null })
          else if (Object.hasOwn(parent, key)) normalized.push({ op: 'delete', path: change.path })
        } else normalized.push(jsonClone(change))
      }
      changes = normalized
      const next = applyJsonChangesShared(state.chat, changes)
      if (next.id !== chatId || revisionOf(next) !== expectedRevision + 1) throw new Error('Invalid journal patch revision')
      assertWritableChat(chatId, state)
      const db = handle(chatId)
      metadata.assertCurrent?.()
      // storedChat = 实际落库的形态（老楼 variables 可能已被 K4 修剪进同库快照表）：
      // 写缓存/返回都用它，避免"库是瘦的、内存缓存是全的"这种 hydrate-full-then-remember-huge。
      const written = writeChat(db, chatId, next, expectedRevision + 1, now(), changes)
      const storedChat = written.chat
      // 复用调用方及内部整理的最终写集；不再全档比较，也不漏掉额外修剪楼。
      changes = written.changes
      bumpGeneration(chatId)
      const recentChanges = knownChanges(chatId, state)
      forgetState(chatId)
      rememberState(chatId, generationStamp(chatId), {
        chat: storedChat, revision: expectedRevision + 1, legacy: false, frameCount: 0, frameBytes: 0
      }, rememberChanges(recentChanges, expectedRevision + 1, changes))
      return slice(storedChat, []).chat
    })
  }

  async function update(chatId, updater, metadata = {}) {
    if (typeof updater !== 'function') throw new Error('Chat SQLite Store 缺少 updater')
    return await serialize(chatId, async function () {
      assertActive()
      assertWritableChat(chatId)
      const currentState = await cachedState(chatId)
      assertWritableChat(chatId, currentState)
      const current = currentState == null ? undefined : currentState.chat
      assertRollbackChatWritable(current, metadata)
      const produced = await updater(copyJsonTree(current))
      if (produced === undefined) return copyJsonTree(current)
      // L1（2026-09-30）：脱离草稿用【结构化拷贝】而非 JSON 文本往返。
      //   copy-json-tree.js 的契约就是 "detach an already parsed JSON tree, sharing only immutable
      //   primitive values" —— 与 jsonClone 同一目的，但不序列化（大字符串按引用共享）。
      //   实测：整档 1.2MB 静态 head + 160 楼时，写路径 13.15 → 3.07 ms/写（快 4.29×）。
      const next = copyJsonTree(produced)
      if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) throw new Error('Chat 存储只能保存 JSON object')
      // ⚠ 一切校验都放在**建库之前**：先 `new DatabaseSync` + ensureSchema、再校验失败，会留下一个
      //   **空 archive.db**；而 version() 只要见到库文件就回 `sqlite:gen:N` ⇒ 上层会显示
      //   「已使用数据库存档」（档其实是空的）= 半迁移假象。2026-09-30 实测踩中（一次失败的 update
      //   留下 24KB 空库）。同理，首写若在写库中途失败，这里会把刚建的库删掉，退回 legacy 状态。
      const firstWrite = currentState == null
      // metadata.migrate 不授予原档写权；新 ID 的分叉与普通新档共用唯一 SQLite 写路径。
      assertWritableChat(chatId, currentState)
      let revision
      let changes = null
      if (firstWrite) {
        revision = revisionOf(next)
      } else {
        const baseRevision = currentState.revision
        revision = revisionOf(next)
        if (revision !== baseRevision + 1) throw new Error('Chat 存储写入 revision 非连续，期望 ' + (baseRevision + 1) + '，实际 ' + revision)
        changes = diffJson(current, next)
        if (changes.length === 0) return copyJsonTree(current)
      }
      const existed = existsSync(dbFile(chatId))
      const db = handle(chatId, { create: true })
      let storedChat = next
      try {
        const written = writeChat(db, chatId, next, revision, now(), changes)
        storedChat = written.chat
        changes = written.changes
      } catch (error) {
        // 半迁移防线：本次调用**新建**了库却写失败 ⇒ 删掉这个库，退回 legacy（旧档原样保留）。
        // 已存在的库不动（里面是当前态，删了才是真丢数据）。
        if (!existed) {
          try { db.close() } catch { /* 可能已关 */ }
          open.delete(safeChatId(chatId))
          forgetState(chatId)
          for (const suffix of ['', '-wal', '-shm']) {
            try { rmSync(dbFile(chatId) + suffix, { force: true }) } catch { /* 尽力而为 */ }
          }
        }
        throw error
      }
      bumpGeneration(chatId)
      const remembered = { chat: storedChat, revision, legacy: false, frameCount: 0, frameBytes: 0 }
      if (firstWrite) {
        rememberState(chatId, generationStamp(chatId), remembered)
      } else {
        const recentChanges = knownChanges(chatId, currentState)
        forgetState(chatId)
        rememberState(chatId, generationStamp(chatId), remembered, rememberChanges(recentChanges, revision, changes))
      }
      return copyJsonTree(storedChat)
    })
  }

  // R1当前态同步SQL读：由调用方明确提供存档revision，不允许把新状态混入旧草稿。
  // 窗口chat的messages是局部坐标，因此身份只校验数据库原楼，不猜局部数组偏移。
  function readCurrentVariableSnapshot(chat) {
    if (!chat?.id || !Number.isSafeInteger(chat._storageRevision)) return undefined
    const id = safeChatId(chat.id)
    if (hasLegacyArtifact(id) || !existsSync(dbFile(id))) return undefined
    const db = handle(id)
    const head = db.prepare('SELECT revision FROM archive_head WHERE id=1').get()
    if (Number(head?.revision) !== chat._storageRevision) return undefined
    const state = db.prepare('SELECT tree_json, turn, message_index, swipe_id FROM variable_state WHERE id=1').get()
    if (!state) return undefined
    const stored = db.prepare('SELECT message_json FROM archive_messages WHERE message_index=?').get(state.message_index)
    if (!stored) return undefined
    const row = parseRow(stored.message_json)
    if (!row || row.role === 'tavern-helper') return undefined
    const count = Math.max(Array.isArray(row.variables) ? row.variables.length : 0, Array.isArray(row.swipes) ? row.swipes.length : 0, 1)
    if (Math.max(0, Math.min(count - 1, Number(row.swipeId) || 0)) !== Number(state.swipe_id)) return undefined
    const value = Array.isArray(row.variables) ? row.variables[Number(state.swipe_id)] : undefined
    // 热行里显式的null/{}也是作者真值，不能借旧state覆盖它。
    if (value !== undefined && !mvuEligible(row)) return undefined
    if (Number(db.prepare('SELECT revision FROM archive_head WHERE id=1').get()?.revision) !== chat._storageRevision) return undefined
    return { tree: parseRow(state.tree_json), turn: Number(state.turn), messageIndex: Number(state.message_index), swipeId: Number(state.swipe_id) }
  }

  function readCurrentRollbackWorldbookRef(chat) {
    assertActive()
    if (!chat?.id || !Number.isSafeInteger(chat._storageRevision)) return undefined
    const id = safeChatId(chat.id)
    if (hasLegacyArtifact(id)) return undefined
    const db = handle(id)
    if (!db) return undefined
    return readSqlSnapshot(db, () => {
      const head = db.prepare('SELECT revision FROM archive_head WHERE id=1').get()
      if (Number(head?.revision) !== chat._storageRevision) return undefined
      return rollbackWorldbooks.currentRef(db, chat)
    })
  }

  // 回退只解析所选版本；不得在普通Chat读取时展开整条历史账本。
  function readRollbackWorldbook(chat, ref) {
    assertActive()
    const id = safeChatId(chat?.id)
    if (hasLegacyArtifact(id)) throw new Error('原件世界书不使用数据库历史引用')
    const db = handle(id)
    if (!db) throw new Error('世界书历史引用缺少本档数据库')
    return readSqlSnapshot(db, () => rollbackWorldbooks.read(db, chat, ref))
  }

  // ---------- 读取面 ----------
  /** 数据库原生读源的补数器：老楼 variables 被 K4 修剪后，按同库快照表逐楼补回（legacy 原件不补）。 */
  function hydratorFor(chatId, state) {
    if (!state || state.legacy === true) return null
    const db = handle(chatId)
    if (db === null) return null
    return (index, row) => readSqlSnapshot(db, () => {
      if (Number(db.prepare('SELECT revision FROM archive_head WHERE id=1').get()?.revision) !== state.revision) {
        throw revisionNotFound(chatId, state.revision, '变量补数输入已经过期')
      }
      return variables.hydrateRow(db, chatId, index, row)
    })
  }

  async function read(chatId) {
    const state = await cachedState(chatId)
    if (!state) return undefined
    const chat = copyJsonTree(state.chat)
    // 全量读路径：与瘦身前等价（老楼变量从同库快照表补回），但**补的是脱离副本**，不进 rememberState 热缓存。
    if (state.legacy !== true) variables.hydrateChat(handle(chatId), chatId, chat)
    return chat
  }
  function projectionDb(chatId) {
    const id = safeChatId(chatId)
    return !hasLegacyArtifact(id) && existsSync(dbFile(id)) ? handle(id) : null
  }
  async function readSessionState(chatId, options = {}) {
    const db = projectionDb(chatId)
    if (db && typeof helpers.projectSessionMessage === 'function') {
      const result = projectionReads.session(db, chatId, options)
      if (!result?.full) return result?.value
    }
    const state = await cachedState(chatId)
    if (!state) return undefined
    if (options.scoped === true && !Object.values(state.chat.timeline?.operations || {}).some(op => op?.kind === 'body' && op.status === 'foreground-completed')) {
      const scoped = requireProtocolHelper('readSessionState', 'createScopedMessages')
      const project = requireProtocolHelper('readSessionState', 'projectSessionMessage')
      const source = state.chat.messages || [], owned = new Map()
      const messages = scoped(source.length, [], index => {
        if (!owned.has(index)) owned.set(index, copyJsonTree(project(source[index])))
        return owned.get(index)
      })
      return projectChatSessionState(state.chat, {messages})
    }
    return projectChatSessionState(state.chat)
  }
  async function readSettlementCheckpoint(chatId, messageId, operationId) {
    const db = projectionDb(chatId)
    if (db) return projectionReads.checkpoint(db, chatId, messageId, operationId)
    const state = await cachedState(chatId)
    return state ? projectSettlementCheckpoint(state.chat, messageId, operationId) : undefined
  }
  async function readSceneImageState(chatId) {
    const db = projectionDb(chatId)
    if (db) return projectionReads.scene(db, chatId)
    const state = await cachedState(chatId)
    return state ? projectSceneImageState(state.chat) : undefined
  }
  async function readBackgroundConfig(chatId) {
    const db = projectionDb(chatId)
    if (db) return projectionReads.background(db, chatId)
    const state = await cachedState(chatId)
    return state ? projectChatBackgroundConfig(state.chat) : undefined
  }
  async function readDisplayRuntimeState(chatId, turn) {
    const db = projectionDb(chatId)
    if (db) return projectionReads.display(db, chatId, turn)
    const state = await cachedState(chatId)
    return state ? projectDisplayRuntimeState(state.chat, turn) : undefined
  }
  function slice(chat, indices, fields, hydrate) {
    const { messages: rawMessages, ...allHead } = chat
    const messages = Array.isArray(rawMessages) ? rawMessages : []
    if (indices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= messages.length)) throw new Error('消息楼层不存在')
    let head = allHead
    // 与作者 slice 对齐（b/lib/domain/chat-journal-store.js:563-564）：结算读不复制历史回退检查点。
    if (fields === 'settlement' && head.timeline && typeof head.timeline === 'object' && !Array.isArray(head.timeline)) {
      head = { ...head, timeline: { ...head.timeline, checkpoints: [] } }
    }
    if (Array.isArray(fields)) {
      head = {}
      for (const field of fields) {
        const parts = String(field).split('.').filter(Boolean)
        if (!parts.length || parts[0] === 'messages' || parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) continue
        let source = chat
        for (const part of parts) source = source && Object.hasOwn(source, part) ? source[part] : undefined
        if (source === undefined) continue
        let target = head
        for (const part of parts.slice(0, -1)) {
          if (!Object.hasOwn(target, part) || !target[part] || typeof target[part] !== 'object') target[part] = {}
          target = target[part]
        }
        target[parts.at(-1)] = source
      }
    }
    const selected = typeof hydrate === 'function' ? indices.map(i => hydrate(i, messages[i])) : indices.map(i => messages[i])
    return { chat: structuredClone({ ...head, messages: selected }), messageCount: messages.length, denseMessages: dense(rawMessages) }
  }
  async function readSlice(chatId, indices = [], fields) {
    const state = await cachedState(chatId)
    return state && !indices.some(i => i >= (state.chat.messages?.length || 0))
      ? slice(state.chat, indices, fields, hydratorFor(chatId, state))
      : undefined
  }
  function rememberChanges(previous, revision, changes) {
    const indices = new Set()
    let tail = Infinity, layoutChanged = false, layoutFrom = Infinity
    let headerFields = new Set(), runtimeInputKeys = new Set()
    for (const change of changes) {
      if (!change.path.length) { tail = 0; layoutChanged = true; layoutFrom = 0; headerFields = null; runtimeInputKeys = null; break }
      if (change.path[0] !== 'messages') {
        headerFields.add(String(change.path[0]))
        if (change.path[0] === 'runtimeInputs' && runtimeInputKeys) {
          if (change.path.length < 2) runtimeInputKeys = null
          else runtimeInputKeys.add(String(change.path[1]))
        }
        continue
      }
      if (change.path.length <= 2 || ['turn','role','greeting','tavernRole','importSource'].includes(change.path[2])) {
        layoutChanged = true
        const start = Number.isSafeInteger(change.path[1]) ? change.path[1] : change.op === 'splice' ? change.index : 0
        layoutFrom = Math.min(layoutFrom, Number.isSafeInteger(start) && start >= 0 ? start : 0)
      }
      if (change.path.length > 1 && Number.isSafeInteger(change.path[1])) indices.add(change.path[1])
      else tail = Math.min(tail, change.op === 'splice' ? change.index : 0)
    }
    const bounded = set => set && set.size <= 4096 ? [...set] : null
    const frames = previous.concat({ baseRevision: revision - 1, revision, indices: [...indices], tail, layoutChanged, layoutFrom,
      headerFields: bounded(headerFields), runtimeInputKeys: bounded(runtimeInputKeys) })
    if (frames.length <= 32) return frames
    const [first, second, ...rest] = frames
    const mergedTail = Math.min(first.tail, second.tail)
    const mergedIndices = [...new Set([...first.indices, ...second.indices])].filter(index => index < mergedTail)
    const mergeKeys = key => Array.isArray(first[key]) && Array.isArray(second[key]) ? bounded(new Set([...first[key], ...second[key]])) : null
    if (mergedIndices.length > 4096) return frames.slice(-32)
    return [{ baseRevision: first.baseRevision, revision: second.revision, indices: mergedIndices, tail: mergedTail,
      layoutChanged: first.layoutChanged !== false || second.layoutChanged !== false,
      layoutFrom: Math.min(first.layoutFrom ?? 0, second.layoutFrom ?? 0),
      headerFields: mergeKeys('headerFields'), runtimeInputKeys: mergeKeys('runtimeInputKeys') }, ...rest]
  }
  function changeEvidence(chatId, state, revision) {
    const frames = knownChanges(chatId, state).filter(frame => frame.revision > revision)
    const keys = field => frames.every(frame => Array.isArray(frame[field])) ? [...new Set(frames.flatMap(frame => frame[field]))] : null
    const runtime = state.chat.runtimeInputs
    return { layoutChanged: frames.some(frame => frame.layoutChanged !== false), layoutFrom: Math.min(...frames.map(frame => frame.layoutFrom ?? 0)), changedHeaderFields: keys('headerFields'),
      runtimeInputChanges: keys('runtimeInputKeys')?.map(key => ({key, present: runtime != null && Object.hasOwn(runtime, key),
        value: runtime != null && Object.hasOwn(runtime, key) ? copyJsonTree(runtime[key]) : undefined})) ?? null }
  }
  function changedIndices(chatId, state, revision) {
    if (!state || !Number.isSafeInteger(revision) || revision < 0 || revision > state.revision) return undefined
    if (revision === state.revision) return { indices: [], baseRevision: revision, revision: state.revision }
    const frames = knownChanges(chatId, state).filter(frame => frame.revision > revision)
    if (!frames.length || frames[0].baseRevision > revision || frames.at(-1).revision !== state.revision
      || frames.some((frame, index) => index > 0 && frame.baseRevision !== frames[index - 1].revision)) return undefined
    const length = state.chat.messages?.length || 0
    const indices = new Set(frames.flatMap(frame => frame.indices).filter(index => index < length))
    const tail = Math.min(...frames.map(frame => frame.tail))
    for (let index = tail; index < length; index++) indices.add(index)
    const sorted = [...indices].sort((a, b) => a - b)
    return { indices: sorted, baseRevision: revision, revision: state.revision }
  }
  async function readChangedIndices(chatId, revision) {
    return changedIndices(chatId, await cachedState(chatId), revision)
  }
  async function readChangedSlice(chatId, revision, fields) {
    const state = await cachedState(chatId)
    if (revision === state?.revision) return undefined
    const changed = changedIndices(chatId, state, revision)
    return changed ? { ...slice(state.chat, changed.indices, fields, hydratorFor(chatId, state)), ...changed,
      ...changeEvidence(chatId, state, revision) } : undefined
  }
  async function readViewDelta(chatId, revision) {
    const state = await cachedState(chatId)
    const changed = changedIndices(chatId, state, revision)
    if (!changed || revision === state.revision
      || Object.values(state.chat.timeline?.operations || {}).some(op => op?.kind === 'body' && op.status === 'foreground-completed')
      || !dense(state.chat.messages)) return undefined
    const dirty = new Set(changed.indices), detached = new Map()
    const scoped = helpers.createScopedMessages, lazyHeader = helpers.copyLazyHistoryHeader
    const hydrate = hydratorFor(chatId, state)
    // dirty老楼在返回前按当前SQL快照补回，保证后续提交/回退不能把新变量混进旧delta。
    // 非dirty楼只抓不可变state的引用，访问时才脱离；不把Proxy送入structuredClone。
    for (const index of dirty) detached.set(index, copyJsonTree(hydrate ? hydrate(index, state.chat.messages[index]) : state.chat.messages[index]))
    const rowAt = index => {
      if (!detached.has(index)) {
        const {variables: _swipeVariables, ...display} = state.chat.messages[index]
        detached.set(index, copyJsonTree(display))
      }
      return detached.get(index)
    }
    const messages = typeof scoped === 'function' ? scoped(state.chat.messages.length, [], rowAt)
      : state.chat.messages.map((_row, index) => rowAt(index)) // 历史只注8项helper的调用者保持旧普通数组契约。
    const head = {...state.chat, messages: []}
    const chat = typeof lazyHeader === 'function' ? lazyHeader(head) : copyJsonTree(head)
    chat.messages = messages
    return { ...changed, ...changeEvidence(chatId, state, revision), chat }
  }

  // ---------- 作者 2.4 新读协议：readWindow / readHelperContext / readSettlementBase ----------
  // 契约出处（核准下载的真身，2026-10-01）：b/lib/domain/native-conversation-storage.js:144/206/254（native 实现）、
  // b/lib/domain/chat-journal-store.js:493-503/595-609（records 层：native 为 null 时的 legacy 分支）、
  // b/lib/domain/chat-persistence.js:325-337（门面：readWindow 无兜底；另两个可选转调）、
  // b/lib/index.js:1367/1374/1378/1811-1836/3128/3735（消费点）。
  // 逐条对齐的语义：
  //   · 只读分页/投影，**不是可写 Chat**：窗口的 chat.messages 只含这一页；三条读口都不进 readCache、不 remember 成写基线。
  //   · revision：真身 headAtRevision 对非法或找不到的 revision 抛 DSH_TAVERN_REVISION_NOT_FOUND（native:92-101）；
  //     行级库只保留当前态，所以同样抛该 code，绝不用当前态冒充旧 revision。
  //   · 结算基座只暴露 createScopedMessages 的懒读 facade（逐楼脱离），不逃逸可写缓存对象。
  const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

  function defineField(target, key, value) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
  }

  /** 与作者 selectedHeader/slice 同语义的头部投影：数组=点路径白名单；'settlement'=全键但清 timeline.checkpoints。 */
  function projectHeader(head, fields) {
    const result = {}
    if (Array.isArray(fields)) {
      for (const field of fields) {
        const parts = String(field).split('.').filter(Boolean)
        if (!parts.length || parts[0] === 'messages' || parts.some(part => POISON_KEYS.has(part))) continue
        let source = head
        for (const part of parts) source = source && Object.hasOwn(source, part) ? source[part] : undefined
        if (source === undefined) continue
        let target = result
        for (const part of parts.slice(0, -1)) {
          if (!Object.hasOwn(target, part) || !target[part] || typeof target[part] !== 'object') defineField(target, part, {})
          target = target[part]
        }
        defineField(target, parts.at(-1), source)
      }
      return result
    }
    for (const key of Object.keys(head)) {
      if (key === 'messages' || POISON_KEYS.has(key)) continue
      let value = head[key]
      if (value === undefined) continue
      if (fields === 'settlement' && key === 'timeline' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const timeline = {}
        for (const timelineKey of Object.keys(value)) if (timelineKey !== 'checkpoints') defineField(timeline, timelineKey, value[timelineKey])
        defineField(timeline, 'checkpoints', [])
        value = timeline
      }
      defineField(result, key, value)
    }
    return result
  }

  /** 作者 indexedMessages 的 eligible 判据（chat-journal-store.js:150-155）：选中 swipe 的 variables 同时有 stat_data 与 schema。 */
  function mvuEligible(row) {
    if (!row || typeof row !== 'object') return false
    const swipeVariables = row.variables          // 不与外层变量归档重名
    const count = Math.max(Array.isArray(swipeVariables) ? swipeVariables.length : 0, Array.isArray(row.swipes) ? row.swipes.length : 0, 1)
    const swipe = Math.max(0, Math.min(count - 1, Number(row.swipeId) || 0))
    const value = swipeVariables ? swipeVariables[swipe] : undefined
    return value !== null && value !== undefined && value.stat_data !== undefined && value.schema !== undefined
  }

  function parseRow(text) {
    if (text === null || text === undefined) return undefined
    return JSON.parse(text)
  }

  function revisionNotFound(chatId, revision, reason) {
    const error = new Error('行级 Chat 找不到 revision ' + String(revision) + '：' + reason + '（' + safeChatId(chatId) + '）')
    error.code = 'DSH_TAVERN_REVISION_NOT_FOUND'
    error.chatId = safeChatId(chatId)
    return error
  }

  /** 与真身 headAtRevision(native:92-101) 对齐：未给/Infinity=当前态；非法或不是当前态=响亮失败。 */
  function assertPinnedRevision(chatId, revision, current) {
    if (revision === undefined || revision === null || revision === Infinity) return
    const target = Number(revision)
    if (!Number.isSafeInteger(target) || target < 1) throw revisionNotFound(chatId, revision, 'revision 不是合法正整数')
    if (target !== current) throw revisionNotFound(chatId, revision, '行级存储只保留当前态 revision ' + current)
  }

  /** 数据库原生读源：头部按 ord 逐键、楼层按 message_index 区间/单点取，绝不整档物化。 */
  function dbReadSource(chatId) {
    const db = handle(chatId)
    if (db === null) return null
    const headRow = db.prepare('SELECT revision FROM archive_head WHERE id = 1').get()
    if (headRow === undefined) return null
    const revision = Number(headRow.revision)
    const messageCount = Number(db.prepare('SELECT COUNT(*) AS n FROM archive_messages').get().n)
    return {
      revision,
      messageCount,
      // 写路径自检保证楼层 0..n-1 连续、行内容是对象（写入口 jsonText 兜底 'null' 的退化值不可能来自正常写路径）。
      complete: () => true,
      header(fields) {
        return readProjectionHeader(db, fields, revision)
      },
      rows(from, to) {
        if (!(to > from)) return []
        const out = new Array(to - from)
        const rows = db.prepare('SELECT message_index, message_json FROM archive_messages WHERE message_index >= ? AND message_index < ? ORDER BY message_index').all(from, to)
        for (const row of rows) out[Number(row.message_index) - from] = parseRow(row.message_json)
        // K4 之外的楼：variables 从同库快照表补回（swipe 精确），窗口只含这一页、不物化整档
        return variables.hydrateRange(db, chatId, from, to, out)
      },
      entries(from, to) {
        if (!(to > from)) return []
        const out = []
        const rows = db.prepare('SELECT message_index, message_json FROM archive_messages WHERE message_index >= ? AND message_index < ? ORDER BY message_index').all(from, to)
        const parsed = new Array(to - from)
        for (const row of rows) parsed[Number(row.message_index) - from] = parseRow(row.message_json)
        variables.hydrateRange(db, chatId, from, to, parsed)
        for (let index = from; index < to; index++) out.push([index, parsed[index - from]])
        return out
      },
      row(index) {
        const row = db.prepare('SELECT message_json FROM archive_messages WHERE message_index = ?').get(index)
        return row === undefined ? undefined : variables.hydrateRow(db, chatId, index, parseRow(row.message_json))
      },
      // 被 K4 修剪的老楼：行里没有 variables，合格判据走快照表（selected + mvu_ready），仍然 swipe 精确
      previousMvu(before) {
        return variables.previousMvu(db, before)
      },
    }
  }

  /** 原件（未迁移）档的读源：真身 native 为 null 时作者走的就是这条 legacy 分支（chat-journal-store.js:497-502/598-608）。 */
  function memoryReadSource(state) {
    const chat = state.chat
    const messages = Array.isArray(chat.messages) ? chat.messages : []
    const revision = state.revision
    const detach = value => copyJsonTree(value)
    function headObject() {
      const { messages: _ignored, ...head } = chat
      return head
    }
    return {
      revision,
      messageCount: messages.length,
      complete: () => messages.every(row => Boolean(row) && typeof row === 'object' && !Array.isArray(row)),
      header(fields) {
        const head = headObject()
        defineField(head, STORAGE_REVISION, revision)
        return detach(projectHeader(head, fields))
      },
      rows(from, to) {
        const out = []
        for (let index = from; index < to; index++) out.push(detach(messages[index]))
        return out
      },
      entries(from, to) {
        const out = []
        for (let index = from; index < to; index++) out.push([index, detach(messages[index])])
        return out
      },
      row(index) { return detach(messages[index]) },
      previousMvu(before) {
        const exclusive = Number(before)
        if (!Number.isSafeInteger(exclusive) || exclusive <= 0) return -1
        for (let index = exclusive - 1; index >= 0; index--) if (mvuEligible(messages[index])) return index
        return -1
      },
    }
  }

  /** 原件优先（与 materialize 同序）：原件存在时不打开同 ID shadow 库；无档回 null。 */
  async function openReadSource(chatId) {
    const id = safeChatId(chatId)
    if (!hasLegacyArtifact(id) && existsSync(dbFile(id))) {
      const source = dbReadSource(id)
      if (source !== null) return source
    }
    const state = await cachedState(id)
    return state === null ? null : memoryReadSource(state)
  }

  /** 真身 native-conversation-storage.js:144-159 的数据库原生版（窗口是分页，不是可写 Chat）。 */
  async function readWindow(chatId, options) {
    const { limit = 48, before, revision, includeCheckpoints = false, requirePartial = false, fields } = options ?? {}
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid history window limit')
    const source = await openReadSource(chatId)
    if (source === null) return null
    assertPinnedRevision(chatId, revision, source.revision)
    const end = before ?? source.messageCount
    if (!Number.isSafeInteger(end) || end < 0 || end > source.messageCount) throw new Error('Invalid history window cursor')
    const from = Math.max(0, end - limit)
    // 开场调用方在"没有省略任何历史"时回退完整视图（真身 :151-153）。
    if (requirePartial && from === 0) return null
    const chat = source.header(fields ?? (includeCheckpoints ? undefined : 'settlement'))
    chat.messages = source.rows(from, end)
    return { chat, messageCount: source.messageCount, from, to: end - 1, revision: source.revision }
  }

  /** 真身 native-conversation-storage.js:254-279：Helper 只读投影（无 range=全量；带 range=闭区间切片）。 */
  async function readHelperContext(chatId, range) {
    const projectTavernHelperMessage = requireProtocolHelper('readHelperContext', 'projectTavernHelperMessage')
    const projectTavernHelperContext = requireProtocolHelper('readHelperContext', 'projectTavernHelperContext')
    const source = await openReadSource(chatId)
    if (source === null) return undefined
    assertPinnedRevision(chatId, range?.revision, source.revision)
    const ranged = Boolean(range)
    const chat = source.header(ranged
      ? ['id', 'sessionId', STORAGE_REVISION, 'backgroundConfigVersion', 'conversationFeaturesVersion']
      : 'settlement')
    const from = ranged ? Math.max(0, Number(range.from) || 0) : 0
    const to = ranged
      ? Math.min(source.messageCount - 1, Number.isSafeInteger(Number(range.to)) ? Number(range.to) : source.messageCount - 1)
      : source.messageCount - 1
    if (!Number.isSafeInteger(from)) throw new Error('消息楼层不存在: ' + from)
    const messages = [], turnMessageIds = {}
    for (let start = from; start <= to; start += 500) {
      const end = Math.min(to + 1, start + 500)
      for (const [position, message] of source.entries(start, end)) {
        const projected = projectTavernHelperMessage(message, position)
        messages.push(projected)
        const turn = Math.max(0, Number(message.turn) || (message.greeting === true ? 1 : 0))
        if (projected.role === 'assistant' && turn > 0) turnMessageIds[String(turn)] = position
      }
    }
    const context = { ...projectTavernHelperContext({ ...chat, messages: [] }), messages, turnMessageIds }
    return { chat, context, from, to }
  }

  /** 真身 native-conversation-storage.js:206-251：结算基座（懒读 facade + ensure/previousMvu）。 */
  async function readSettlementBase(chatId) {
    const createScopedMessages = requireProtocolHelper('readSettlementBase', 'createScopedMessages')
    const source = await openReadSource(chatId)
    if (source === null) return undefined
    if (!source.complete()) return undefined
    const count = source.messageCount
    const chat = source.header('settlement')
    const detached = new Map()
    function rowAt(index) {
      if (!detached.has(index)) detached.set(index, source.row(index))
      return detached.get(index)
    }
    const messages = createScopedMessages(count, [], rowAt)
    // 行级库的楼层恒可按位取（同步），ensure 只需与真身同款的越界校验；读楼不再抛 MVU_HISTORY_NOT_LOADED。
    async function ensure(indices) {
      if (indices === undefined) return
      for (const index of [...new Set(indices)]) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error('消息楼层不存在: ' + index)
      }
    }
    const previousMvu = before => source.previousMvu(before)
    return { chat: { ...chat, messages }, messageCount: count, denseMessages: true, ensure, previousMvu }
  }

  async function readRevision(chatId, revision) {
    const target = Number(revision)
    if (!Number.isSafeInteger(target) || target < 0) throw new Error('Chat storage revision 不合法: ' + String(revision))
    // 行级存储（彻底清理语义）：仅保留当前态，不保留历史版本——被回退/被修改的旧版本不可重建。
    // 当前态请求（revision == 现行 revision）照常返回。
    const state = await materialize(chatId, target)
    if (state === null) return undefined
    const chat = copyJsonTree(state.chat)
    if (state.legacy !== true) variables.hydrateChat(handle(chatId), chatId, chat)
    return chat
  }

  async function version(chatId) {
    const id = safeChatId(chatId)
    // 原件身份优先于同 ID 数据库；stamp 与读/写门禁一致，shadow 不能冒充可玩分叉。
    // 未迁移的档有**两种**承载，都要认：
    //   ① journal 单文件 `chats/<id>.json`（旧版作者存储）
    //   ② 上游 v2.4 起的**内容寻址块布局** `chats/<id>/head.json` + `blocks/**`
    //      —— 上游新开的档全是这一种。只认 ① 会把"档存在但未迁移"误判成"没有存档"
    //      （2026-09-30 从 145 导入一份块布局档时实测踩中）。
    // 一律回我们自己的 stamp 形状（`legacy:<size>:<mtimeNs>`），不转发 legacyData 的任意字符串 ——
    // 上层的"是否已迁移"判据只认我们的值域（见 lib/migration-ops.js）。
    for (const target of [path.join(chatsRoot, id + '.json'), path.join(chatsRoot, id, 'head.json')]) {
      try {
        const info = await stat(target, { bigint: true })
        return ['legacy', info.size, info.mtimeNs].join(':')
      } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    return existsSync(dbFile(id)) ? generationStamp(id) : ''
  }

  async function remove(chatId) {
    await serialize(chatId, async function () {
      assertActive()
      assertWritableChat(chatId)
      const state = await cachedState(chatId)
      assertWritableChat(chatId, state)
      const id = safeChatId(chatId)
      forgetState(chatId)
      generations.delete(id)
      projectionReads.forget(id)
      variables.forget(id)          // 变量表随 archive.db 一起删；缓存/代数一并清掉
      const entry = open.get(id)
      if (entry) {
        try { entry.close() } catch { /* Already closed. */ }
        open.delete(id)
      }
      rmSync(dbFile(id), { force: true })
      for (const suffix of ['-wal', '-shm']) rmSync(dbFile(id) + suffix, { force: true })
      // 此后端只删除自己的 SQLite 文件，不调用原档作者 store 的删除接口。
    })
  }

  /** dispose 之后一切写入响亮失败（读口不会再偷开句柄：handle 返回 null）。 */
  function assertActive() {
    if (disposed) throw new Error('Chat SQLite Store 已 dispose：不能再写入')
  }

  /** 释放：关掉本 store 打开的所有 archive.db 句柄、清所有缓存与队列；变量归档只清缓存（连接归本 store）。 */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const db of open.values()) {
      try { db.close() } catch { /* 可能已关 */ }
    }
    open.clear()
    projectionReads.dispose()
    readCache.clear()
    pendingReads.clear()
    generations.clear()
    mutationTails.clear()
    cachedBytes = 0
    variables.dispose()
  }

  return Object.freeze({ rollbackArchivePath: dbFile, detachedUpdate: true, readCurrentRollbackWorldbookRef, readRollbackWorldbook, readCurrentVariableSnapshot, read, readWindow, readHelperContext, readSessionState, readSceneImageState, readSettlementCheckpoint, readBackgroundConfig, readDisplayRuntimeState, readSlice, readSettlementBase, readChangedSlice, readChangedIndices, readViewDelta, patch, readRevision, update, version, remove, variables: variablesApi, dispose })
}
