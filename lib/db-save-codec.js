// 单局DB交换边界：读事务捕获允许表，目标只执行本包固定DDL与参数化INSERT。
// 不VACUUM原库、不复制WAL主文件、不执行包内schema/SQL/扩展。
import { DatabaseSync } from 'node:sqlite'
import { openSync, closeSync, existsSync, rmSync, readSync, fstatSync, statSync } from 'node:fs'
import { readTimelineTree } from './timeline-nodes.js'
export { encodeDbSave, decodeDbSave } from './db-save-zip.js'
export const DB_SAVE_FORMAT = 'dsh-tavern-sqlite-save'
export const DB_SAVE_VERSION = 1
const MAX_ROWS = 200000, MAX_JSON = 16 * 1024 * 1024
const spec = (columns, sql) => Object.freeze({ columns: columns.split(' '), sql })
export const ARCHIVE_TABLES = Object.freeze({
  archive_head: spec('id revision updated_at', 'CREATE TABLE archive_head(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,updated_at INTEGER NOT NULL)'),
  archive_head_fields: spec('key ord kind value_json', 'CREATE TABLE archive_head_fields(key TEXT PRIMARY KEY,ord INTEGER NOT NULL,kind INTEGER NOT NULL,value_json TEXT)'),
  archive_messages: spec('message_index message_json', 'CREATE TABLE archive_messages(message_index INTEGER PRIMARY KEY,message_json TEXT NOT NULL)'),
  archive_timeline_nodes: spec('node_key ord value_json', 'CREATE TABLE archive_timeline_nodes(node_key TEXT PRIMARY KEY,ord INTEGER NOT NULL,value_json TEXT NOT NULL)'),
  variable_snapshots: spec('message_index swipe_id turn slot_count selected source mvu_ready tree_json operations_json uid created_at', 'CREATE TABLE variable_snapshots(message_index INTEGER NOT NULL,swipe_id INTEGER NOT NULL,turn INTEGER NOT NULL,slot_count INTEGER NOT NULL,selected INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL,mvu_ready INTEGER NOT NULL DEFAULT 0,tree_json TEXT,operations_json TEXT,uid TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(message_index,swipe_id))'),
  variable_state: spec('id tree_json turn message_index swipe_id updated_at', 'CREATE TABLE variable_state(id INTEGER PRIMARY KEY CHECK(id=1),tree_json TEXT NOT NULL,turn INTEGER NOT NULL,message_index INTEGER NOT NULL,swipe_id INTEGER NOT NULL,updated_at INTEGER NOT NULL)'),
  archive_worldbook_history: spec('book_id snapshot_json', 'CREATE TABLE archive_worldbook_history(book_id INTEGER PRIMARY KEY AUTOINCREMENT,snapshot_json TEXT NOT NULL)')
})
export const NATIVE_TABLES = Object.freeze({
  meta: spec('key value', 'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)'),
  sessions: spec('id header_json format_version created_at inherited_event_count event_count', 'CREATE TABLE sessions(id TEXT PRIMARY KEY,header_json TEXT NOT NULL,format_version INTEGER NOT NULL,created_at INTEGER NOT NULL,inherited_event_count INTEGER NOT NULL DEFAULT 0,event_count INTEGER NOT NULL DEFAULT 0)'),
  events: spec('seq type time data_json extra_json', 'CREATE TABLE events(seq INTEGER PRIMARY KEY,type TEXT NOT NULL,time INTEGER NOT NULL,data_json TEXT NOT NULL,extra_json TEXT)')
})
const schemas = kind => {
  if (kind === 'archive') return ARCHIVE_TABLES
  if (kind === 'native') return NATIVE_TABLES
  throw Error('DB存档数据库类型不支持')
}
function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw Error('DB存档数值无效：' + label)
}
function parse(value, label, optional = false) {
  if (optional && value === null) return null
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_JSON) throw Error('DB存档JSON字段超限或无效：' + label)
  try { return JSON.parse(value) } catch { throw Error('DB存档JSON损坏：' + label) }
}
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('DB存档对象字段无效：' + label)
  return value
}
function contiguous(rows, key, label) {
  const ordered = [...rows].sort((a, b) => a[key] - b[key])
  ordered.forEach((row, index) => { if (row[key] !== index) throw Error('DB存档坐标不连续：' + label) })
  return ordered
}
function validate(tables, kind) {
  const expected = schemas(kind)
  if (Object.keys(tables).length !== Object.keys(expected).length || Object.keys(tables).some(name => !Object.hasOwn(expected, name))) throw Error('DB存档表集合无效')
  let count = 0
  for (const [name, shape] of Object.entries(expected)) {
    const rows = tables[name]
    if (!Array.isArray(rows) || (count += rows.length) > MAX_ROWS) throw Error('DB存档表行数超限')
    for (const row of rows) {
      if (Object.keys(row).length !== shape.columns.length || shape.columns.some(column => !Object.hasOwn(row, column))) throw Error('DB存档列集合无效：' + name)
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && typeof value !== 'string' && !Number.isSafeInteger(value)) throw Error('DB存档列类型无效：' + name + '.' + key)
        if (key.endsWith('_json') && value !== null) parse(value, name + '.' + key)
      }
    }
  }
  if (kind === 'native') {
    if (tables.sessions.length !== 1) throw Error('DB包原生库必须恰好一个Session')
    const row = tables.sessions[0], header = object(parse(row.header_json, 'header'), 'header')
    if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(row.id) || header.id !== row.id) throw Error('DB包Session身份不一致')
    integer(row.format_version, 'format_version', 1); integer(row.created_at, 'created_at')
    // 头部版本与行版本必须自洽：只要求 integer>=1 且相等（支持的版本集合由同代宿主严格校验负责，不在此锁具体值）。
    integer(header.version, 'header.version', 1)
    if (header.version !== row.format_version) throw Error('DB原生协议版本不一致')
    integer(row.event_count, 'event_count'); integer(row.inherited_event_count, 'inherited_event_count')
    if (row.event_count !== tables.events.length || row.inherited_event_count > row.event_count) throw Error('DB包原生事件计数不一致')
    tables.events = contiguous(tables.events, 'seq', 'events')
    for (const event of tables.events) {
      if (typeof event.type !== 'string' || !event.type || event.type.length > 160) throw Error('DB包事件类型无效')
      integer(event.time, 'event.time')
      const extra = parse(event.extra_json, 'event.extra', true)
      if (extra !== null) {
        object(extra, 'extra')
        if (['seq', 'type', 'time', 'data', '__proto__', 'constructor', 'prototype'].some(key => Object.hasOwn(extra, key))) throw Error('DB包事件扩展字段覆盖核心字段')
      }
    }
    const seen = new Set()
    for (const meta of tables.meta) {
      if (seen.has(meta.key) || !['schema_version', 'rollback_archive'].includes(meta.key)) throw Error('DB包原生meta含未知或未完成状态')
      seen.add(meta.key)
    }
    if (tables.meta.find(row => row.key === 'schema_version')?.value !== '1') throw Error('DB包原生schema版本不支持')
    return header
  }
  if (tables.archive_head.length !== 1 || tables.archive_head[0].id !== 1) throw Error('DB包Chat头部行无效')
  integer(tables.archive_head[0].revision, 'revision', 1); integer(tables.archive_head[0].updated_at, 'updated_at')
  const fields = contiguous(tables.archive_head_fields, 'ord', 'head字段')
  if (fields.length > 512) throw Error('DB包Chat头部字段超限')
  const head = Object.create(null), keys = new Set()
  for (const row of fields) {
    if (typeof row.key !== 'string' || keys.has(row.key) || ['__proto__', 'constructor', 'prototype'].includes(row.key) || ![0, 1].includes(row.kind)) throw Error('DB包Chat头部字段无效')
    keys.add(row.key)
    if (row.kind === 1 && row.key !== 'messages') throw Error('DB包messages占位无效')
    // messages 占位结构必须与生产装配一致：kind=1 且 value_json=null；缺该键时按占位回退组装（不要求存在）。
    if (row.key === 'messages' && (row.kind !== 1 || row.value_json !== null)) throw Error('DB包消息占位结构冲突')
    if (row.key !== 'messages' && row.value_json !== null) head[row.key] = parse(row.value_json, row.key)
  }
  tables.archive_messages = contiguous(tables.archive_messages, 'message_index', 'Chat楼层')
  head.messages = tables.archive_messages.map(row => object(parse(row.message_json, 'message'), 'message'))
  head._storageRevision = tables.archive_head[0].revision
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(head.id || '') || !/^[a-zA-Z0-9_-]{1,160}$/.test(head.sessionId || '')) throw Error('DB包Chat双身份缺失')
  if (tables.variable_state.length > 1 || tables.variable_state.some(row => row.id !== 1)) throw Error('DB包变量当前态无效')
  const slots = new Set(), selected = new Set()
  for (const row of [...tables.variable_snapshots, ...tables.variable_state]) {
    integer(row.message_index, '变量message_index'); integer(row.swipe_id, '变量swipe_id'); integer(row.turn, '变量turn')
    if (row.message_index >= head.messages.length) throw Error('DB包变量快照超出楼层')
    if (Object.hasOwn(row, 'slot_count')) {
      integer(row.slot_count, 'slot_count', 1)
      if (row.swipe_id >= row.slot_count || ![0, 1].includes(row.selected) || ![0, 1].includes(row.mvu_ready)) throw Error('DB包变量swipe无效')
      const key = row.message_index + ':' + row.swipe_id
      if (slots.has(key) || row.selected && selected.has(row.message_index)) throw Error('DB包变量swipe重复')
      slots.add(key); if (row.selected) selected.add(row.message_index)
    }
  }
  const nodeKeys = new Set(), checkpoints = []
  for (const row of tables.archive_timeline_nodes) {
    if (typeof row.node_key !== 'string' || nodeKeys.has(row.node_key)) throw Error('DB包timeline节点重复')
    nodeKeys.add(row.node_key); object(parse(row.value_json, 'timeline'), 'timeline')
    if (row.node_key.startsWith('checkpoints#')) {
      if (row.node_key !== 'checkpoints#' + row.ord) throw Error('DB包timeline checkpoint坐标不一致')
      checkpoints.push(row)
    } else if (row.node_key !== '@meta' && !row.node_key.startsWith('operations:')) throw Error('DB包timeline节点类型不支持')
  }
  contiguous(checkpoints, 'ord', 'timeline checkpoints')
  const books = new Set()
  for (const row of tables.archive_worldbook_history) {
    integer(row.book_id, 'worldbook book_id', 1)
    if (books.has(row.book_id)) throw Error('DB包世界书历史重复')
    books.add(row.book_id)
  }
  return head
}
// trusted 列元数据：只从本包 spec DDL 在内存建一次 schema（不执行包SQL），用于比较 declared type 与 PK 位置。
const schemaMeta = new Map()
function expectedColumnMeta(kind) {
  if (schemaMeta.has(kind)) return schemaMeta.get(kind)
  const db = new DatabaseSync(':memory:')
  const meta = {}
  try {
    for (const [name, shape] of Object.entries(schemas(kind))) {
      db.exec(shape.sql)
      meta[name] = db.prepare('PRAGMA table_info(' + name + ')').all().map(row => ({ name: row.name, type: String(row.type || '').trim().toUpperCase(), pk: row.pk }))
    }
  } finally { db.close() }
  schemaMeta.set(kind, meta)
  return meta
}
function inspectConnection(db, kind) {
  const expected = schemas(kind)
  const objects = db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
  for (const entry of objects) {
    if (entry.type === 'table') {
      if (!Object.hasOwn(expected, entry.name) || /\bVIRTUAL\b/i.test(entry.sql || '')) throw Error('DB包含未知或虚拟表')
    } else if (entry.type !== 'index') throw Error('DB包含不允许的视图/触发器')
  }
  const tables = {}
  let totalBytes = 0
  for (const [name, shape] of Object.entries(expected)) {
    const info = db.prepare('PRAGMA table_info(' + name + ')').all()
    if (info.length !== shape.columns.length || info.some((row, index) => row.name !== shape.columns[index])) throw Error('DB包schema列不兼容：' + name)
    // 同名列也必须类型与主键位置一致：actual type 先 TRIM+大写再严格比（INTEGER ≠ INT 即拒）；
    // 不比较 NOTNULL/DEFAULT（源 archive 的 autoincrement/nonnull 差异无本机证据）。此检查在读取行之前。
    const meta = expectedColumnMeta(kind)[name]
    if (info.some((row, index) => String(row.type || '').trim().toUpperCase() !== meta[index].type || row.pk !== meta[index].pk)) throw Error('DB包schema列类型或主键不兼容：' + name)
    const lengths = shape.columns.map(column => 'COALESCE(length(CAST(' + column + ' AS BLOB)),0)').join('+')
    const size = db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(' + lengths + '),0) AS bytes FROM ' + name).get()
    totalBytes += size.bytes
    if (size.n > MAX_ROWS || totalBytes > 64 * 1024 * 1024) throw Error('DB包行数或内容容量超限')
    tables[name] = db.prepare('SELECT ' + shape.columns.join(',') + ' FROM ' + name).all().map(row => ({ ...row }))
  }
  const head = validate(tables, kind)
  if (kind === 'archive' && tables.archive_timeline_nodes.length) head.timeline = readTimelineTree(db).value
  return { tables, head }
}
function verifyFile(file) {
  const fd = openSync(file, 'r')
  try {
    if (fstatSync(fd).size > 64 * 1024 * 1024) throw Error('DB存档单库容量超限')
    const magic = Buffer.alloc(16)
    if (readSync(fd, magic, 0, 16, 0) !== 16 || !magic.equals(Buffer.from('SQLite format 3\0'))) throw Error('DB包不是SQLite数据库')
  } finally { closeSync(fd) }
}
export function inspectDatabase(file, kind) {
  verifyFile(file)
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN')
    const result = inspectConnection(db, kind)
    db.exec('COMMIT'); return result
  } finally { db.close() }
}
export function restoreDatabase(output, kind, input) {
  const tables = structuredClone(input), expected = schemas(kind)
  validate(tables, kind)
  if (existsSync(output)) throw Error('DB导入拒绝覆盖已存在目标')
  closeSync(openSync(output, 'wx'))
  let db
  try {
    db = new DatabaseSync(output, { allowExtension: false })
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    for (const shape of Object.values(expected)) db.exec(shape.sql)
    for (const [name, shape] of Object.entries(expected)) {
      const insert = db.prepare('INSERT INTO ' + name + '(' + shape.columns.join(',') + ') VALUES(' + shape.columns.map(() => '?').join(',') + ')')
      for (const row of tables[name]) {
        // 源机器绝对archive绑定不是可移植数据，目标绑定由后端单独重建。
        if (name === 'meta' && row.key === 'rollback_archive') continue
        insert.run(...shape.columns.map(column => row[column]))
      }
    }
    if (kind === 'native') db.exec('CREATE INDEX events_type ON events(type)')
    else db.exec('CREATE INDEX archive_head_fields_ord ON archive_head_fields(ord); CREATE INDEX variable_snapshots_turn ON variable_snapshots(turn)')
    db.exec('COMMIT'); db.close(); db = undefined
  } catch (error) {
    db?.close()
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(output + suffix, { force: true })
    throw error
  }
}
// 观察连接不持读事务，data_version可看见其他连接的COMMIT；每个库都在捕获前打开。
// 若整个观察窗口无提交，则多个独立读事务共享同一稳定业务边界；有提交就丢弃输出。
export function watchDbSaveSources(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 65 || new Set(files).size !== files.length) throw Error('DB快照源集合无效')
  const observed = []
  let closed = false
  try {
    for (const file of files) {
      verifyFile(file)
      const db = new DatabaseSync(file, { readOnly: true, allowExtension: false })
      const item = { file, db }
      observed.push(item)
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
      item.version = db.prepare('PRAGMA data_version').get().data_version
      const stat = statSync(file, { bigint: true })
      item.dev = stat.dev; item.ino = stat.ino
    }
  } catch (error) {
    for (const item of observed) item.db.close()
    throw error
  }
  return Object.freeze({
    assertStable() {
      if (closed) throw Error('DB快照观察已关闭')
      for (const item of observed) {
        const stat = statSync(item.file, { bigint: true })
        if (stat.dev !== item.dev || stat.ino !== item.ino || item.db.prepare('PRAGMA data_version').get().data_version !== item.version) throw Error('DB快照捕获期间源库发生提交或替换，请重试导出')
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const item of observed) item.db.close()
    }
  })
}
export function snapshotDatabase(source, output, kind) {
  verifyFile(source)
  const db = new DatabaseSync(source, { readOnly: true, allowExtension: false })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN')
    const result = inspectConnection(db, kind)
    restoreDatabase(output, kind, result.tables)
    db.exec('COMMIT'); return result
  } finally { db.close() }
}
