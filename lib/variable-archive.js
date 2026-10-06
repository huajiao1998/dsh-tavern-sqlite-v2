// 变量归档（PLG-012 C 阶段）：变量快照链 + 当前态。
//
// 与 LAB 第一阶段（tools/lab-src-new/variable-sqlite-store.js）的差别（2026-10-01 定）：
//   · **不另建 chats/<id>/variables.db、不双写** —— 变量表建在**聊天存档同一个 archive.db、同一个连接**里，
//     变量行与 chat 行由同一个 BEGIN…COMMIT 提交。变量写失败 ⇒ 整笔 chat write 回滚，
//     不存在"chat 落盘了、变量没落"或反过来的双权威，也不需要两库一致性告警（数据库原生适配）。
//   · 因此本模块**不持有连接**：句柄由 chat-sqlite-store 通过 options.handle 注入（读用 {create:false}），
//     dispose 只清缓存，不 close（连接归 store 所有）。
//
// 表语义（沿用 LAB 的 commit / snapshot / delete 语义，身份换成"楼 + swipe"）：
//   variable_snapshots  每楼每 swipe 一行，PRIMARY KEY(message_index, swipe_id)
//                       —— 只有 turn 会漏掉同楼多 swipe 的树，K4 修剪后必须按 swipe 精确还原
//   variable_state      当前态单行（最新一次写入得到的 MVU 权威树）
//
// K4（热内存窗口）：内存里只留最新 `hotWindow`（默认 4）棵 MVU 树，键 message_index+swipe_id；
//   更老的变量读一律走 DB 原生历史（快照表）—— 不扫原件、不给原件建表/建库。
//   修剪（prune）窗口外老楼的 variables 之前**必须先存下该楼快照**；存不下来就不删（fail-closed）。
//
// R0（快照批读缓存）：snapshotAll 的 Map<turn, tree> 按每档 generation（revision）失效 ——
//   任何写/删/回退都 bump；出借的树与用户 mutation 的脱离副本不是同一对象（hydrate 一律新 parse）。
//
// P0（快照树缓存＋克隆出仓，2026-10-05）：hydrate 补数不再每次 parse 快照行文本。
//   · 缓存的是**快照行**（键 chatId|index|swipe）：快照行落到 `variable_snapshots` 就不可变，
//     写路径只会覆盖/删除整行 ⇒ 键对应的树内容不会原地变。
//   · 出仓一律 `structuredClone(cached)` ⇒ 调用方拿到的仍是**私有副本**，与 hotCache/refreshHot 同式；
//     "用户改不到缓存"的隔离语义不变，只是把 parse 换成了更廉价的 clone。
//   · 与所有其它读缓存**同生命周期**：写（prepareWrite，含 K4 修剪落快照）bumpRevision、删档 forget、
//     释放 dispose 都清空；看不到写路径的库外改动靠有界预算兜底，不另造第二套失效协议。
//   · `text === null` 槽不进缓存路径（那是"原本就是 null"的还原语义，没有树可缓存）。

// 2026-10-05 修B：热读路径 db.prepare 换连接级语句缓存（lib/statement-cache.js）。
import { stmt } from './statement-cache.js'

const clampInt = (value, fallback, min, max) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback
}

const isObjectLike = value => value !== null && typeof value === 'object'

const parseRow = text => (text === null || text === undefined ? undefined : JSON.parse(text))

/** 选中的 swipe（与作者 tavern-helper-context.js:16-23 selectedSwipe 同式）。 */
function selectedSwipeId(row, variableCount) {
  const count = Math.max(
    variableCount || 0,
    Array.isArray(row && row.swipes) ? row.swipes.length : 0,
    1,
  )
  return Math.max(0, Math.min(count - 1, Number(row && row.swipeId) || 0))
}

const turnOf = row => Math.max(0, Math.floor(Number(row && row.turn) || 0))

/** 该楼是否带变量树（LAB 瘦身判据 hasTree：至少一个 swipe 槽是对象）。 */
function carriesTree(row) {
  if (!row || typeof row !== 'object') return false
  const variables = row.variables
  return Array.isArray(variables) && variables.some(value => isObjectLike(value))
}

/** LAB commitSettlement 的合格判据：stat_data 与 schema 都在（当前态的权威树）。 */
function mvuReady(tree) {
  return isObjectLike(tree) && tree.stat_data !== undefined && tree.schema !== undefined
}

/** 未注入 isEligibleRow 时的同式兜底（作者 indexedMessages eligible）。 */
function fallbackEligible(row) {
  const variables = row && row.variables
  if (!Array.isArray(variables)) return false
  return mvuReady(variables[selectedSwipeId(row, variables.length)])
}

export function createVariableArchive(options = {}) {
  const logger = options.logger || console
  const now = typeof options.now === 'function' ? options.now : Date.now
  const openHandle = typeof options.handle === 'function' ? options.handle : () => null
  // 行内（未被修剪）楼的合格判据由 store 注入 —— 与作者 indexedMessages 的 eligible 是同一条规则，
  // 不在这里另造第二份（被修剪的楼走快照表的 selected + mvu_ready 列）。
  const isEligibleRow = typeof options.isEligibleRow === 'function' ? options.isEligibleRow : fallbackEligible
  const hotWindow = clampInt(options.hotWindow, 4, 1, 64)          // K4
  const maxCachedChats = clampInt(options.maxCachedChats, 2, 1, 32) // R0 批读缓存档数
  const maxHotChats = clampInt(options.maxHotChats, 8, 1, 256)
  const pruneEnabled = options.prune !== false
  // P0 快照树缓存的有界预算：同一棵树的文本装进缓存，给 2 倍余量（对象开销），
  // 与 store readCache 同式的"条数 + 字节"双条件淘汰（见 chat-sqlite-store.js:94-95,498-504）。
  const maxSnapshotCacheBytes = clampInt(options.maxSnapshotCacheBytes, 8 * 1024 * 1024, 1024 * 1024, 512 * 1024 * 1024)   // P2-b：32→8MB（实测单档快照 ~0.3MB，仍 25× 余量）
  const maxSnapshotCacheEntries = clampInt(options.maxSnapshotCacheEntries, 4096, 64, 1 << 20)

  const revisions = new Map()   // chatId -> generation（R0/热窗口按代数失效）
  const allCache = new Map()    // chatId -> { revision, map }
  const hotCache = new Map()    // chatId -> { entries: [{ messageIndex, swipeId, turn, tree }] }
  // P0：键 `index|swipe` -> { tree, bytes }；插入序 = 淘汰序（Map 保序，命中不重排）
  // 生命周期恒 ≤ bumpRevision 之间，而 bumpRevision 是全局清空 ⇒ 键无需带 chatId。
  const snapshotCache = new Map()
  let snapshotCacheBytes = 0

  function clearSnapshotCache() {
    snapshotCache.clear()
    snapshotCacheBytes = 0
  }

  function dropSnapshotCacheEntry(key, entry) {
    snapshotCache.delete(key)
    snapshotCacheBytes -= entry.bytes
    if (snapshotCacheBytes < 0) snapshotCacheBytes = 0
  }

  /**
   * 出仓一律**脱离副本**：命中也克隆，未命中 parse 后的第一份同样克隆。
   * 缓存里那棵树永不外借 —— 否则首次 hydrate 的调用方一改就污染缓存（实测踩中）。
   */
  function snapshotCacheDetach(key, tree, text) {
    let detached
    try {
      detached = structuredClone(tree)
    } catch {
      snapshotCache.delete(key)
      return tree   // 克隆不了的值不敢当缓存树：这一份原样出仓，且不缓存（与改造前同语义）
    }
    const bytes = (typeof text === 'string' ? text.length : 0) * 2 + 256
    if (bytes <= maxSnapshotCacheBytes) {
      const previous = snapshotCache.get(key)
      if (previous !== undefined) {
        snapshotCache.delete(key)
        snapshotCacheBytes -= previous.bytes
        if (snapshotCacheBytes < 0) snapshotCacheBytes = 0
      }
      snapshotCache.set(key, { tree, bytes })
      snapshotCacheBytes += bytes
      while (snapshotCache.size > maxSnapshotCacheEntries || snapshotCacheBytes > maxSnapshotCacheBytes) {
        const oldest = snapshotCache.keys().next().value
        if (oldest === undefined) break
        dropSnapshotCacheEntry(oldest, snapshotCache.get(oldest))
      }
    }
    return detached
  }

  /** 命中：克隆出仓。`undefined` 表示未命中（调用方去 parse）。 */
  function snapshotCacheGet(key) {
    const cached = snapshotCache.get(key)
    if (cached === undefined) return undefined
    try {
      return structuredClone(cached.tree)
    } catch {
      dropSnapshotCacheEntry(key, cached)   // 克隆不了的值不敢当缓存树，退回 parse
      return undefined
    }
  }

  const keyOf = chatId => String(chatId)
  const revisionOf = chatId => revisions.get(keyOf(chatId)) || 0
  // D-1（2026-10-05）：追踪每档上次写入 variable_state 的树引用——
  // 同引用＝树没变＝跳过 stringify＋UPSERT（治"每写口都全量重写"的写放大）。
  const lastStateWritten = new Map()  // chatId → { tree, turn, index, swipe }

  function bumpRevision(chatId, writtenFloors) {
    const id = keyOf(chatId)
    revisions.set(id, (revisions.get(id) || 0) + 1)
    allCache.delete(id)   // allCache 是整档 Map<turn,tree>，任何写都整体失效
    // snapshotCache 键为 index|swipe（不含 chatId，预存限制）⇒ 只能全清，不能按楼定向。
    clearSnapshotCache()
    if (writtenFloors !== undefined && writtenFloors !== null && typeof writtenFloors[Symbol.iterator] === 'function') {
      // 修A：hotCache 按楼定向失效（键含 chatId）——只删被写楼的 MVU 树条目
      const floorSet = new Set()
      for (const index of writtenFloors) floorSet.add(Number(index))
      const hot = hotCache.get(id)
      if (hot) {
        const kept = hot.entries.filter(e => !floorSet.has(e.messageIndex))
        if (kept.length < hot.entries.length) {
          hot.entries = kept
          if (kept.length === 0) hotCache.delete(id)
        }
      }
    } else {
      hotCache.delete(id)
    }
    return revisions.get(id)
  }

  /** 删档/释放：清掉该档所有缓存与代数（表随 archive.db 一起没，不单独删）。 */
  function forget(chatId) {
    const id = keyOf(chatId)
    revisions.delete(id)
    allCache.delete(id)
    hotCache.delete(id)
    lastStateWritten.delete(id)
    clearSnapshotCache()
  }

  function dispose() {
    revisions.clear()
    allCache.clear()
    hotCache.clear()
    lastStateWritten.clear()
    clearSnapshotCache()
  }

  // ---------- schema（与 chat 表同库；由 store 在每次开库时 ensure，旧 v3 早返回也必须走到） ----------
  function ensureTables(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS variable_snapshots (
      message_index INTEGER NOT NULL,
      swipe_id INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      slot_count INTEGER NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      mvu_ready INTEGER NOT NULL DEFAULT 0,
      tree_json TEXT,
      operations_json TEXT,
      uid TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_index, swipe_id)
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS variable_snapshots_turn ON variable_snapshots (turn)')
    db.exec(`CREATE TABLE IF NOT EXISTS variable_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tree_json TEXT NOT NULL,
      turn INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      swipe_id INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`)
  }

  // ---------- 写路径（必须在调用方的 chat 事务内） ----------
  /**
   * 记一楼的"真值"：逐 swipe 落快照（null 槽也记一行，好让 hydrate 精确还原数组长度与洞）。
   * 返回 false = 这楼的真值记不下来（行不是对象 / 变量槽不是 JSON 树）—— 调用方**不得**因此删变量。
   */
  function captureRow(db, chatId, index, row, source = 'chat-write', stamp = now()) {
    if (!row || typeof row !== 'object') return false
    const variables = row.variables
    if (!Array.isArray(variables)) {
      // patch可只修改K4冷楼swipeId；树仍在快照表，选中身份也必须同事务更新。
      const old = db.prepare('SELECT MAX(slot_count) AS n FROM variable_snapshots WHERE message_index=?').get(index)
      if (Number(old?.n) > 0) {
        const selected = selectedSwipeId(row, Number(old.n))
        db.prepare('UPDATE variable_snapshots SET selected=CASE WHEN swipe_id=? THEN 1 ELSE 0 END WHERE message_index=?').run(selected, index)
      }
      return false
    }
    const slotCount = variables.length
    const selected = selectedSwipeId(row, slotCount)
    const turn = turnOf(row)
    const slots = []
    for (let swipe = 0; swipe < slotCount; swipe++) {
      const tree = variables[swipe]
      if (tree === null || tree === undefined) { slots.push({ swipe, json: null, ready: 0 }); continue }
      if (typeof tree !== 'object') return false          // 变量槽只能是 JSON 树
      let json
      try { json = JSON.stringify(tree) } catch { return false }
      if (json === undefined) return false                // function/symbol 等退化值：不敢当"真值"
      slots.push({ swipe, json, ready: mvuReady(tree) ? 1 : 0 })
    }
    const upsert = db.prepare(`INSERT INTO variable_snapshots
      (message_index, swipe_id, turn, slot_count, selected, source, mvu_ready, tree_json, operations_json, uid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(message_index, swipe_id) DO UPDATE SET
        turn = excluded.turn, slot_count = excluded.slot_count, selected = excluded.selected,
        source = excluded.source, mvu_ready = excluded.mvu_ready, tree_json = excluded.tree_json,
        created_at = excluded.created_at`)
    for (const slot of slots) {
      upsert.run(index, slot.swipe, turn, slotCount, slot.swipe === selected ? 1 : 0, source, slot.ready, slot.json, stamp)
    }
    // 楼内数组变短：越界的 swipe 槽不存在了（我们手里有真值才敢删）
    db.prepare('DELETE FROM variable_snapshots WHERE message_index = ? AND swipe_id >= ?').run(index, slotCount)
    return true
  }

  /** 最新一棵合格 MVU 树（state 的来源）：从截断后、修剪前的 chat 里倒着找。 */
  function latestEligible(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const row = messages[index]
      if (!row || typeof row !== 'object' || row.role === 'tavern-helper' || !Array.isArray(row.variables)) continue
      const swipe = selectedSwipeId(row, row.variables.length)
      const tree = row.variables[swipe]
      if (mvuReady(tree)) return { index, swipe, tree, turn: turnOf(row) }
    }
    return null
  }

  function refreshState(db, chatId, messages, stamp, touchedSet) {
    let latest = latestEligible(messages)
    {
      // 回退可能只剩初始化热树和更晚的K4冷树；不能让第0楼抢占冷楼当前态。
      // 本轮行写入尚未发生，候选以draft校验：排helper、显式无效热槽、不同swipe。
      let index = previousMvu(db, messages.length)
      while (index >= 0) {
        const candidate = messages[index]
        if (candidate?.role !== 'tavern-helper' && !Array.isArray(candidate?.variables)) break
        if (candidate && candidate.role !== 'tavern-helper' && mvuReady(candidate.variables?.[selectedSwipeId(candidate, candidate.variables?.length)])) break
        index = previousMvu(db, index)
      }
      if (index >= 0 && (latest === null || index > latest.index)) {
        const candidate = messages[index]
        const slots = db.prepare('SELECT MAX(slot_count) AS n FROM variable_snapshots WHERE message_index=?').get(index)
        const swipe = selectedSwipeId(candidate, Number(slots?.n) || 0)
        const row = db.prepare(`SELECT tree_json, turn, swipe_id FROM variable_snapshots
          WHERE message_index = ? AND swipe_id = ? AND mvu_ready = 1 AND tree_json IS NOT NULL`).get(index, swipe)
        if (row !== undefined) {
          latest = { index, swipe: Number(row.swipe_id), tree: parseRow(row.tree_json), turn: Number(row.turn) }
        }
      }
    }
    if (latest === null || latest.tree === undefined) {
      lastStateWritten.delete(chatId)
      db.prepare('DELETE FROM variable_state WHERE id = 1').run()
      return
    }
    // D-1（审查修正版）：用 touched 集合判断而不是引用比较——
    // 作者代码会就地改对象（Object.assign 同引用不同内容），引用比较挡不住；
    // touched 集合是写口声明的"本次真的改了哪些楼"，不在里面＝肯定没变。
    if (touchedSet !== undefined && !touchedSet.has(latest.index)) {
      const last = lastStateWritten.get(chatId)
      if (last !== undefined) return  // 已追踪且本次没改这楼 → 跳过
      // 未追踪（重启/forget 后首次）→ 落一次写以建立追踪
    }
    db.prepare(`INSERT INTO variable_state (id, tree_json, turn, message_index, swipe_id, updated_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET tree_json = excluded.tree_json, turn = excluded.turn,
        message_index = excluded.message_index, swipe_id = excluded.swipe_id, updated_at = excluded.updated_at`)
      .run(JSON.stringify(latest.tree), latest.turn, latest.index, latest.swipe, stamp)
    lastStateWritten.set(chatId, { tree: latest.tree, turn: latest.turn, index: latest.index, swipe: latest.swipe })
  }

  /** K4 窗口起点：从尾部数第 hotWindow 个"带树"的楼；greeting 楼与 0 楼是引擎初始化基线，保留且不占窗口。 */
  function hotWindowFrom(messages) {
    let kept = 0
    for (let index = messages.length - 1; index >= 0; index--) {
      const row = messages[index]
      if (!row || typeof row !== 'object') continue
      if (row.greeting === true || index === 0) continue
      if (!carriesTree(row)) continue
      kept++
      if (kept >= hotWindow) return index
    }
    return 0
  }

  /** K4 修剪：窗口外老楼的 variables 先逐楼存快照，存不下来（或楼里本来没树）就不动它。 */
  function pruneRows(db, chatId, messages, stamp) {
    const from = hotWindowFrom(messages)
    const pruned = new Map()
    for (let index = 0; index < from; index++) {
      const row = messages[index]
      // greeting 楼与 0 楼是引擎的初始化基线（活数据）——永不修剪（与 LAB 瘦身同一条）
      if (index === 0 || (row && row.greeting === true)) continue
      if (!carriesTree(row)) continue
      if (!captureRow(db, chatId, index, row, 'k4', stamp)) {   // fail-closed：不准删
        logger?.warn?.('dsh-tavern: 变量归档记不下楼 ' + index + ' 的真值，保留该楼 variables（本轮不修剪）')
        continue
      }
      const stripped = { ...row }
      delete stripped.variables
      pruned.set(index, stripped)
    }
    return pruned
  }

  /** K4 热内存：留最新 ≤hotWindow 棵 MVU 树（脱离副本，不与调用方对象共享）。 */
  function refreshHot(chatId, messages) {
    const entries = []
    for (let index = messages.length - 1; index >= 0 && entries.length < hotWindow; index--) {
      const row = messages[index]
      if (!row || typeof row !== 'object') continue
      if (row.greeting === true || index === 0) continue
      if (!carriesTree(row)) continue
      const swipe = selectedSwipeId(row, row.variables.length)
      const tree = row.variables[swipe]
      if (!isObjectLike(tree)) continue
      let detached
      try { detached = structuredClone(tree) } catch { continue }
      entries.push({ messageIndex: index, swipeId: swipe, turn: turnOf(row), tree: detached })
    }
    entries.reverse()
    hotCache.delete(chatId)
    if (entries.length === 0) return
    hotCache.set(chatId, { entries })
    while (hotCache.size > maxHotChats) hotCache.delete(hotCache.keys().next().value)
  }

  /**
   * writeChat 的变量钩子（**同一事务**）：只处理本次真的变了的楼（touched）与尾部截断；
   * header-only 写不扫 messages。
   * 返回 `{ chat, written }`：chat = **实际应落库的形态**（老楼的 variables 可能已被 K4 修剪），
   * written = 需要重写行的楼（本次 touched ∪ 本次被修剪的楼 —— 修剪改了行内容，必须落库）。
   */
  function prepareWrite(db, chatId, chat, { touched = [], truncated = false } = {}) {
    const id = keyOf(chatId)
    const messages = Array.isArray(chat && chat.messages) ? chat.messages : []
    if (touched.length === 0 && !truncated) return { chat, written: [] }
    const stamp = now()
    for (const index of touched) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length) continue
      captureRow(db, id, index, messages[index], 'chat-write', stamp)
    }
    if (truncated) db.prepare('DELETE FROM variable_snapshots WHERE message_index >= ?').run(messages.length)
    const touchedSet = truncated ? undefined : new Set(touched.filter(index => Number.isSafeInteger(index) && index >= 0 && index < messages.length))
    refreshState(db, id, messages, stamp, touchedSet)
    let effective = chat
    const written = new Set(touched.filter(index => Number.isSafeInteger(index) && index >= 0 && index < messages.length))
    if (pruneEnabled) {
      const pruned = pruneRows(db, id, messages, stamp)
      if (pruned.size > 0) {
        effective = { ...chat, messages: messages.map((row, index) => pruned.get(index) || row) }
        for (const index of pruned.keys()) written.add(index)
      }
    }
    bumpRevision(id, written)   // 修A：只失效被写楼（touched ∪ K4修剪）的缓存
    refreshHot(id, messages)
    return { chat: effective, written: [...written].sort((left, right) => left - right) }
  }

  // ---------- 读路径：按楼补数（DB 原生历史；老变量不进长期热缓存） ----------
  function snapshotGroup(db, from, to) {
    const group = new Map()
    if (db === null || !(to > from)) return group
    const rows = stmt(db, `SELECT message_index, swipe_id, slot_count, tree_json FROM variable_snapshots
      WHERE message_index >= ? AND message_index < ? ORDER BY message_index, swipe_id`).all(from, to)
    for (const row of rows) {
      const index = Number(row.message_index)
      let entry = group.get(index)
      if (entry === undefined) { entry = { messageIndex: index, slotCount: 0, trees: new Map() }; group.set(index, entry) }
      entry.slotCount = Math.max(entry.slotCount, Number(row.slot_count) || 0)
      entry.trees.set(Number(row.swipe_id), row.tree_json)
    }
    return group
  }

  /**
   * 单楼补数：行内已有的热值优先，缺的洞/整键缺的按快照还原。
   * 快照树经 P0 缓存出仓：未命中 parse 一次后写回，命中改 `structuredClone` ⇒
   * 调用方拿到的仍是脱离副本（用户改不到缓存），重复 hydrate 不再重复 parse。
   */
  function hydrateOne(chatId, entry, row) {
    if (!row || typeof row !== 'object' || entry === undefined) return row
    const variables = row.variables
    if (Array.isArray(variables) && variables.every(value => isObjectLike(value))) return row   // 全热：一个查询都不发
    const index = entry.messageIndex
    const length = entry.slotCount > 0
      ? entry.slotCount
      : Math.max(Array.isArray(variables) ? variables.length : 0, 1)
    const next = new Array(length)
    let filled = 0
    for (let swipe = 0; swipe < length; swipe++) {
      const current = Array.isArray(variables) ? variables[swipe] : undefined
      if (current !== undefined && current !== null) { next[swipe] = current; continue }
      const text = entry.trees.get(swipe)
      if (text === undefined) { next[swipe] = current; continue }   // 快照里没有这一槽：保持行内真值
      // 快照行在、值就是 NULL ⇒ 原本这一槽就是 null，必须原样还原 null（不得退化成 undefined/洞）：
      // 读口要 observable exact —— JSON 往返虽等价，但内存表示不等（deepStrictEqual / 作者侧比对会看出差别）。
      // 这一路不经过缓存：null 槽没有树可缓存（且它的还原语义必须逐次精确）。
      if (text === null) { next[swipe] = null; filled++; continue }
      const cacheKey = index + '|' + swipe
      let tree = snapshotCacheGet(cacheKey)
      if (tree === undefined) {
        const parsed = parseRow(text)
        if (parsed === undefined) { next[swipe] = current; continue }
        // 未命中：parse 一次写回缓存，出仓的仍是**另一份**克隆（缓存树不外借）
        tree = index >= 0 ? snapshotCacheDetach(cacheKey, parsed, text) : parsed
      }
      next[swipe] = tree
      filled++
    }
    if (filled === 0) return row
    return { ...row, variables: next }
  }

  function hydrateRange(db, chatId, from, to, rows) {
    if (db === null || !Array.isArray(rows) || rows.length === 0) return rows
    const group = snapshotGroup(db, from, to)
    if (group.size === 0) return rows
    for (let index = from; index < to; index++) {
      const entry = group.get(index)
      if (entry === undefined) continue
      const position = index - from
      const row = rows[position]
      if (row === undefined) continue
      const next = hydrateOne(chatId, entry, row)
      if (next !== row) rows[position] = next
    }
    return rows
  }

  function hydrateRow(db, chatId, index, row) {
    if (db === null || !row) return row
    const group = snapshotGroup(db, index, index + 1)
    return hydrateOne(chatId, group.get(index), row)
  }

  /**
   * 批量补数（2026-10-06 P1）：读口一次补齐所选楼，不再逐楼开事务/查 revision。
   * 实测：readSlice 833 次、均值 24.25ms 里约 20ms 是"每楼一次 BEGIN/COMMIT + revision 查询"。
   * indices 与 rows 同序（rows[k] 对应 indices[k]）；快照按连续区间合并查询，通常只一次。
   * 返回值与行对象语义同 hydrateRow：需要的楼换成新对象，不需要的原样返回。
   */
  function hydrateIndices(db, chatId, indices, rows) {
    if (db === null || !Array.isArray(indices) || indices.length === 0 || !Array.isArray(rows)) return rows
    const runs = []
    let start = -1, previous = -2
    const sorted = [...new Set(indices)].filter(value => Number.isSafeInteger(value) && value >= 0).sort((left, right) => left - right)
    for (const index of sorted) {
      if (index !== previous + 1) { if (start >= 0) runs.push([start, previous]); start = index }
      previous = index
    }
    if (start >= 0) runs.push([start, previous])
    if (runs.length === 0) return rows
    const trees = new Map()
    for (const [from, to] of runs) for (const [index, entry] of snapshotGroup(db, from, to + 1)) trees.set(index, entry)
    if (trees.size === 0) return rows
    for (let position = 0; position < indices.length; position++) {
      const entry = trees.get(indices[position])
      if (entry === undefined) continue
      const next = hydrateOne(chatId, entry, rows[position])
      if (next !== rows[position]) rows[position] = next
    }
    return rows
  }

  /** 整档补数（全量读路径；legacy 原件不调用）。 */
  function hydrateChat(db, chatId, chat) {
    const messages = Array.isArray(chat && chat.messages) ? chat.messages : []
    if (db === null || messages.length === 0) return chat
    const group = snapshotGroup(db, 0, messages.length)
    if (group.size === 0) return chat
    for (const [index, entry] of group) {
      if (index < 0 || index >= messages.length) continue
      const row = messages[index]
      const next = hydrateOne(chatId, entry, row)
      if (next !== row) messages[index] = next
    }
    return chat
  }

  /** 被修剪（行里没有 variables）的楼，按快照判它选中的 swipe 是否还带合格 MVU 树。 */
  function eligibleIndices(db, indices) {
    const list = Array.isArray(indices) ? indices : []
    if (db === null || list.length === 0) return new Set()
    const placeholders = list.map(() => '?').join(', ')
    const rows = stmt(db, `SELECT message_index FROM variable_snapshots
      WHERE selected = 1 AND mvu_ready = 1 AND message_index IN (` + placeholders + `)`).all(...list)
    return new Set(rows.map(row => Number(row.message_index)))
  }

  // ---------- 当前态 / 时间旅行 ----------
  function stateTree(db, chatId) {
    if (db === null) return undefined
    const row = stmt(db, 'SELECT tree_json FROM variable_state WHERE id = 1').get()
    if (row !== undefined) return parseRow(row.tree_json)
    // 冷档（变量表刚接入、还没有 state 行）：按需从**本档自己的行**推导一次，不写库、不扫原件。
    const hot = hotCache.get(keyOf(chatId))
    const newest = hot === undefined ? undefined : hot.entries.at(-1)
    if (newest !== undefined && mvuReady(newest.tree)) {
      try { return structuredClone(newest.tree) } catch { return newest.tree }
    }
    const index = previousMvu(db, Number.MAX_SAFE_INTEGER)
    if (index < 0) return undefined
    const message = stmt(db, 'SELECT message_json FROM archive_messages WHERE message_index = ?').get(index)
    if (message === undefined) return undefined
    const parsed = parseRow(message.message_json)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.variables)) return undefined
    const swipe = selectedSwipeId(parsed, parsed.variables.length)
    const tree = parsed.variables[swipe]
    return mvuReady(tree) ? tree : undefined
  }

  /**
   * 往前找上一条带合格 MVU 快照的楼。
   * 行里有 variables ⇒ 以行为真值（热楼/未被修剪）；行里没有 ⇒ 查快照表（被修剪的老楼），
   * 因此 K4 修剪之后 previousMvu 仍然准确，且不必把整档 messages 都解析一遍。
   */
  function previousMvu(db, before) {
    const exclusive = Number(before)
    if (db === null || !Number.isSafeInteger(exclusive) || exclusive <= 0) return -1
    const batch = 64
    const rowsStmt = stmt(db, `SELECT message_index, message_json FROM archive_messages
      WHERE message_index < ? ORDER BY message_index DESC LIMIT ? OFFSET ?`)
    for (let offset = 0; offset < exclusive; offset += batch) {
      const rows = rowsStmt.all(exclusive, batch, offset)
      if (rows.length === 0) break
      const byIndex = new Map()
      const pruned = []
      for (const row of rows) {
        const index = Number(row.message_index)
        const message = parseRow(row.message_json)
        byIndex.set(index, message)
        if (!Array.isArray(message && message.variables)) pruned.push(index)
      }
      const eligibleSnapshot = pruned.length > 0 ? eligibleIndices(db, pruned) : new Set()
      // rows 已是 message_index DESC：同一批里也必须按倒序判，别让批次末尾的老楼抢在修剪楼前面
      for (const row of rows) {
        const index = Number(row.message_index)
        const message = byIndex.get(index)
        if (message?.role === 'tavern-helper') continue
        if (Array.isArray(message && message.variables)) {
          if (isEligibleRow(message)) return index
          continue
        }
        if (eligibleSnapshot.has(index)) return index
      }
    }
    return -1
  }

  // ---------- 对外可消费 API（chatId 优先，与 LAB 同名同形） ----------
  function has(chatId) {
    const db = openHandle(chatId)
    if (db === null) return false
    return stmt(db, 'SELECT 1 AS ok FROM variable_state WHERE id = 1').get() !== undefined
  }

  function snapshot(chatId) {
    return stateTree(openHandle(chatId), keyOf(chatId))
  }

  /** 时间旅行：该 turn 结算到的树（同 turn 多楼时取 selected、再取更靠后的楼）。 */
  function snapshotAt(chatId, turn) {
    const id = keyOf(chatId)
    const db = openHandle(chatId)
    if (db === null) return undefined
    const target = Math.max(0, Math.floor(Number(turn) || 0))
    const hot = hotCache.get(id)
    const hotHit = hot === undefined ? undefined : hot.entries.filter(entry => entry.turn === target).at(-1)
    if (hotHit !== undefined) {
      try { return structuredClone(hotHit.tree) } catch { return hotHit.tree }
    }
    const row = stmt(db, `SELECT tree_json FROM variable_snapshots WHERE turn = ? AND tree_json IS NOT NULL
      ORDER BY selected DESC, message_index DESC LIMIT 1`).get(target)
    return row === undefined ? undefined : parseRow(row.tree_json)
  }

  /**
   * 快照链批读（R0 的**对外 API**）：Map<turn, tree>，按 generation 失效；无库回 undefined（与 LAB 同）。
   * ⚠ 本函数只服务"要整条历史的消费者"（作者 helper 的历史补数 reader）；当前 store 内部读口
   *   一律走 per-message+swipe 的 snapshotGroup/hydrate（**不**经过这里），所以别把它当"R0 已在生产使用"。
   * 坏行**响亮失败**：静默跳过坏行 = 假装"快照链完整"，会把丢数据伪装成读成功。
   */
  function snapshotAll(chatId) {
    const id = keyOf(chatId)
    const db = openHandle(chatId)
    if (db === null) return undefined
    const revision = revisionOf(id)
    const cached = allCache.get(id)
    if (cached !== undefined && cached.revision === revision) {
      allCache.delete(id)
      allCache.set(id, cached)
      return cached.map
    }
    const map = new Map()
    for (const row of stmt(db, `SELECT turn, message_index, selected, tree_json FROM variable_snapshots
      ORDER BY turn, selected, message_index`).all()) {
      if (row.tree_json === null) continue
      let tree
      try { tree = JSON.parse(row.tree_json) } catch (error) {
        const failure = new Error('变量快照行 JSON 损坏（turn=' + row.turn + ' message_index=' + row.message_index +
          '）：' + String(error?.message || error))
        failure.code = 'DSH_TAVERN_VARIABLE_SNAPSHOT_CORRUPT'
        throw failure
      }
      map.set(Number(row.turn), tree)
    }
    allCache.set(id, { revision, map })
    while (allCache.size > maxCachedChats) allCache.delete(allCache.keys().next().value)
    return map
  }

  /** 回退物理删除：turn >= from 的快照不复存在，state 回拨到幸存的最新一棵（没有就清空）。 */
  function deleteFrom(chatId, turn) {
    const id = keyOf(chatId)
    const db = openHandle(chatId)
    const from = Math.max(1, Math.floor(Number(turn) || 0))
    if (db === null) return { deleted: 0, state: false }
    db.exec('BEGIN')
    try {
      const removed = db.prepare('DELETE FROM variable_snapshots WHERE turn >= ?').run(from)
      const latest = db.prepare(`SELECT s.tree_json, s.turn, s.message_index, s.swipe_id FROM variable_snapshots s
        JOIN archive_messages m ON m.message_index = s.message_index
        WHERE s.tree_json IS NOT NULL AND s.selected = 1 AND s.mvu_ready = 1
          AND COALESCE(json_extract(m.message_json, '$.role'), '') != 'tavern-helper'
        ORDER BY s.message_index DESC LIMIT 1`).get()
      if (latest !== undefined) {
        db.prepare(`UPDATE variable_state SET tree_json = ?, turn = ?, message_index = ?, swipe_id = ?, updated_at = ?
          WHERE id = 1`).run(latest.tree_json, latest.turn, latest.message_index, latest.swipe_id, now())
        // state 行可能不存在（冷档）：补一行，保证 has()/snapshot() 与快照链一致
        db.prepare(`INSERT INTO variable_state (id, tree_json, turn, message_index, swipe_id, updated_at)
          SELECT 1, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM variable_state WHERE id = 1)`)
          .run(latest.tree_json, latest.turn, latest.message_index, latest.swipe_id, now())
      } else {
        db.prepare('DELETE FROM variable_state WHERE id = 1').run()
      }
      db.exec('COMMIT')
      // D-1 补丁（2026-10-05 审查）：deleteFrom 直接改了 variable_state（绕过 refreshState），
      // 必须同步作废追踪器——否则陈旧条目会让后续 refreshState 的 touched 跳过误判。
      lastStateWritten.delete(id)
      bumpRevision(id)
      return { deleted: Number(removed.changes), state: latest !== undefined }
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 连接级失败：没有可回滚的事务 */ }
      throw error
    }
  }

  function stats(chatId) {
    const db = openHandle(chatId)
    if (db === null) return null
    const snapshots = stmt(db, `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(tree_json)), 0) AS bytes
      FROM variable_snapshots`).get()
    const state = stmt(db, `SELECT turn, message_index, swipe_id, LENGTH(tree_json) AS bytes, updated_at
      FROM variable_state WHERE id = 1`).get()
    const hot = hotCache.get(keyOf(chatId))
    return {
      snapshots: { count: Number(snapshots.n), bytes: Number(snapshots.bytes) },
      state: state === undefined ? null : {
        turn: Number(state.turn), messageIndex: Number(state.message_index), swipeId: Number(state.swipe_id),
        bytes: Number(state.bytes), updatedAt: Number(state.updated_at),
      },
      hot: { count: hot === undefined ? 0 : hot.entries.length, limit: hotWindow },
    }
  }

  return Object.freeze({
    // store 内部钩子
    ensureTables, prepareWrite, hydrateChat, hydrateRange, hydrateRow, hydrateIndices, eligibleIndices,
    previousMvu, stateTree, forget, dispose, hotWindow,
    // 对作者树可消费的 store.variables API（chatId 优先）
    has, snapshot, snapshotAll, snapshotAt, deleteFrom, stats,
  })
}
