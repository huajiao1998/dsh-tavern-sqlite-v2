// DB存档ZIP容器（自定义纯DB包，只接受method 0存储；不兼容普通zip，任何deflate一律拒绝且不解压）；布局：
// manifest.json / archive/chat.db / native/NNNN.db（按清单顺序四位编号）/ resources/<安全子路径>。
// 本地头、中央目录与EOCD逐项校验：未知/重复/缺payload/尾部不一致/加密/ZIP64/CRC不符/声明长度不符全部拒绝。
// 本层只做容器与字节校验，不打开SQLite库、不猜schema；manifest仅校验必需字段，额外导出字段原样保留。
// 包上限：总64MiB、单条64MiB、展开256MiB、条目512、清单64KiB、SQLite条目至少100字节。
import { crc32 } from 'node:zlib'

export const DB_SAVE_FORMAT = 'dsh-tavern-sqlite-save'
export const DB_SAVE_VERSION = 1

const ID = /^[a-zA-Z0-9_-]{1,160}$/
const SEGMENT = /^[A-Za-z0-9._-]+$/
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
const MANIFEST_NAME = 'manifest.json'
const ARCHIVE_NAME = 'archive/chat.db'
const MAX_PACKAGE = 64 * 1024 * 1024
const MAX_ENTRY = MAX_PACKAGE
const MAX_EXPANDED = 256 * 1024 * 1024
const MAX_ENTRIES = 512
const MAX_MANIFEST = 64 * 1024
const MIN_SQLITE_BYTES = 100
const LOCAL_SIG = 0x04034b50, CENTRAL_SIG = 0x02014b50, EOCD_SIG = 0x06054b50, EOCD_BYTES = 22, ZIP64 = 0xFFFFFFFF
// 固定时间戳（1980-01-01）让同一输入产出同一字节，不写入当前时间。
const DOS_TIME = 0, DOS_DATE = 0x21

function resourcePath(value) {
  if (typeof value !== 'string' || !value) throw Error('DB包资源路径无效')
  if (value.includes('\\') || value.includes('\0')) throw Error('DB包资源路径危险：' + value)
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw Error('DB包资源路径危险（不接受绝对路径）：' + value)
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..' || !SEGMENT.test(segment)) throw Error('DB包资源路径危险（不接受越级或异常段）：' + value)
  }
  return value
}

function assertSqlite(name, data) {
  if (!Buffer.isBuffer(data)) throw Error('DB包条目缺少payload：' + name)
  if (data.length < MIN_SQLITE_BYTES) throw Error('DB包条目不是完整SQLite库（至少100字节）：' + name)
  if (!data.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw Error('DB包条目缺少SQLite magic header：' + name)
  return data
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw Error('DB包清单无效')
  if (manifest.format !== DB_SAVE_FORMAT) throw Error('DB包清单format无效：只接受本插件DB存档')
  if (manifest.formatVersion !== DB_SAVE_VERSION) throw Error('DB包清单formatVersion无效：只接受1')
  if (manifest.storage !== 'sqlite') throw Error('DB包清单storage无效：只接受sqlite')
  if (!manifest.source || typeof manifest.source !== 'object') throw Error('DB包清单缺少source')
  if (!ID.test(manifest.source.chatId || '')) throw Error('DB包清单source.chatId无效')
  if (!ID.test(manifest.source.sessionId || '')) throw Error('DB包清单source.sessionId无效')
  if (!Array.isArray(manifest.sessions) || manifest.sessions.length < 1 || manifest.sessions.length > 64) throw Error('DB包清单sessions数量无效（须1..64）')
  for (const id of manifest.sessions) if (!ID.test(id || '')) throw Error('DB包清单sessions含无效会话身份')
  if (new Set(manifest.sessions).size !== manifest.sessions.length) throw Error('DB包清单sessions重复')
  if (!Array.isArray(manifest.resources)) throw Error('DB包清单缺少resources列表')
  for (const path of manifest.resources) resourcePath(path)
  if (new Set(manifest.resources).size !== manifest.resources.length) throw Error('DB包清单resources重复')
  return manifest
}

function nativeName(index) {
  return 'native/' + String(index).padStart(4, '0') + '.db'
}

function classify(name) {
  if (name === MANIFEST_NAME) return { kind: 'manifest' }
  if (name === ARCHIVE_NAME) return { kind: 'archive' }
  const native = /^native\/(\d{4})\.db$/.exec(name)
  if (native) return { kind: 'native', index: Number(native[1]) }
  if (name.startsWith('resources/')) return { kind: 'resource', path: resourcePath(name.slice('resources/'.length)) }
  throw Error('DB包含未知条目：' + name)
}

// 清单顺序即条目顺序：manifest → archive → native（按index）→ resources（按清单顺序）。
function planEntries(manifest, archive, sessions, resources) {
  assertManifest(manifest)
  assertSqlite(ARCHIVE_NAME, archive)
  if (!Array.isArray(sessions) || sessions.length !== manifest.sessions.length) throw Error('DB包原生记录与清单sessions不一致')
  if (!Array.isArray(resources) || resources.length !== manifest.resources.length) throw Error('DB包资源记录与清单resources不一致')
  const entries = [{ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest), 'utf8') }, { name: ARCHIVE_NAME, data: archive }]
  sessions.forEach((item, index) => {
    if (!item || item.id !== manifest.sessions[index]) throw Error('DB包原生记录顺序/身份与清单不一致')
    entries.push({ name: nativeName(index), data: assertSqlite(nativeName(index), item.data) })
  })
  resources.forEach((item, index) => {
    if (!item || item.path !== manifest.resources[index]) throw Error('DB包资源顺序/路径与清单不一致')
    if (!Buffer.isBuffer(item.data)) throw Error('DB包条目缺少payload：resources/' + item.path)
    entries.push({ name: 'resources/' + item.path, data: item.data })
  })
  return entries
}

function pack(size, fields) {
  const buffer = Buffer.alloc(size)
  for (const [at, value, bytes] of fields) (bytes === 2 ? buffer.writeUInt16LE(value, at) : buffer.writeUInt32LE(value, at))
  return buffer
}

export function encodeDbSave({ manifest, archive, sessions, resources } = {}) {
  const entries = planEntries(manifest, archive, sessions, resources)
  if (entries.length > MAX_ENTRIES) throw Error('DB包条目数超出上限')
  let expanded = 0
  for (const entry of entries) {
    if (entry.data.length > MAX_ENTRY) throw Error('DB包单个条目超出上限：' + entry.name)
    if (entry.name === MANIFEST_NAME && entry.data.length > MAX_MANIFEST) throw Error('DB包清单超出上限（64KiB）')
    expanded += entry.data.length
  }
  if (expanded > MAX_EXPANDED) throw Error('DB包展开容量超出上限')
  const chunks = [], central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const sum = crc32(entry.data)
    const size = entry.data.length
    const local = [[0, LOCAL_SIG, 4], [4, 20, 2], [6, 0, 2], [8, 0, 2], [10, DOS_TIME, 2], [12, DOS_DATE, 2], [14, sum, 4], [18, size, 4], [22, size, 4], [26, name.length, 2], [28, 0, 2]]
    const dir = [[0, CENTRAL_SIG, 4], [4, 20, 2], [6, 20, 2], [8, 0, 2], [10, 0, 2], [12, DOS_TIME, 2], [14, DOS_DATE, 2], [16, sum, 4], [20, size, 4], [24, size, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
    chunks.push(pack(30, local), name, entry.data)
    central.push(pack(46, dir), name)
    offset += 30 + name.length + size
  }
  const directory = Buffer.concat(central)
  const eocd = pack(EOCD_BYTES, [[0, EOCD_SIG, 4], [4, 0, 2], [6, 0, 2], [8, entries.length, 2], [10, entries.length, 2], [12, directory.length, 4], [16, offset, 4], [20, 0, 2]])
  const buffer = Buffer.concat([...chunks, directory, eocd])
  if (buffer.length > MAX_PACKAGE) throw Error('DB包容量超出上限')
  return buffer
}

function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - (EOCD_BYTES + 0xFFFF))
  for (let at = buffer.length - EOCD_BYTES; at >= floor; at--) {
    if (buffer.readUInt32LE(at) !== EOCD_SIG) continue
    if (buffer.readUInt16LE(at + 20) !== 0) throw Error('DB包含ZIP注释，尾部不一致')
    if (at + EOCD_BYTES !== buffer.length) throw Error('DB包尾部与中央目录结尾不一致')
    return at
  }
  throw Error('DB包不完整：找不到中央目录结尾')
}

// 只读中央目录声明：先校声明长度/标志/名称，再碰任何payload（不解压，不按声明分配）。
function readDirectory(buffer, eocd) {
  const count = buffer.readUInt16LE(eocd + 10)
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0 || buffer.readUInt16LE(eocd + 8) !== count) throw Error('DB包不是单一磁盘ZIP，分卷包拒绝')
  const dirSize = buffer.readUInt32LE(eocd + 12)
  const dirOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xFFFF || dirSize === ZIP64 || dirOffset === ZIP64) throw Error('DB包含ZIP64，拒绝')
  if (count > MAX_ENTRIES) throw Error('DB包条目数超出上限')
  if (count < 2) throw Error('DB包缺少必需条目（至少清单与archive）')
  if (dirOffset + dirSize !== eocd) throw Error('DB包中央目录与结尾不一致')
  const entries = [], seen = new Set()
  let cursor = dirOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd) throw Error('DB包中央目录不完整')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG) throw Error('DB包中央目录签名无效')
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10)
    const sum = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), size = buffer.readUInt32LE(cursor + 24)
    const nameLen = buffer.readUInt16LE(cursor + 28), extraLen = buffer.readUInt16LE(cursor + 30), commentLen = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if (flags & 0x1) throw Error('DB包含加密条目，拒绝')
    if (flags & ~0x800) throw Error('DB包含不支持的ZIP标志（数据描述符/掩码头等），拒绝')
    if (method !== 0) throw Error('DB-only包只接受method 0存储条目，拒绝deflate或其他压缩')
    if (extraLen || commentLen) throw Error('DB包含未知扩展字段或注释，拒绝ZIP64/附加数据')
    if (compressed === ZIP64 || size === ZIP64 || localOffset === ZIP64) throw Error('DB包含ZIP64，拒绝')
    if (compressed !== size) throw Error('DB包条目压缩长度与原始长度不一致')
    if (size > MAX_ENTRY) throw Error('DB包单个条目超出上限')
    if (cursor + 46 + nameLen + extraLen + commentLen > eocd) throw Error('DB包中央目录越界')
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    if (!name || /[^\x20-\x7E]/.test(name)) throw Error('DB包条目名含非ASCII字符，拒绝')
    if (seen.has(name)) throw Error('DB包含重复条目：' + name)
    seen.add(name)
    const entry = { name, sum, size, localOffset, nameLen, flags, method, ...classify(name) }
    if (entry.kind === 'manifest' && size > MAX_MANIFEST) throw Error('DB包清单超出上限（64KiB）')
    entries.push(entry)
    cursor += 46 + nameLen + extraLen + commentLen
  }
  if (cursor !== eocd) throw Error('DB包中央目录项数与声明不一致')
  return entries
}

// 按本地头偏移顺序读取：要求布局连续、本地头与中央目录逐字段一致、CRC 与payload相符。
function readPayloads(buffer, entries, dirOffset) {
  const ordered = [...entries].sort((left, right) => left.localOffset - right.localOffset)
  const payloads = new Map()
  let expected = 0
  for (const entry of ordered) {
    if (entry.localOffset !== expected) throw Error('DB包本地条目布局不连续或存在填充：' + entry.name)
    if (entry.localOffset + 30 > dirOffset) throw Error('DB包本地头越界：' + entry.name)
    if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIG) throw Error('DB包本地头签名无效：' + entry.name)
    const flags = buffer.readUInt16LE(entry.localOffset + 6), method = buffer.readUInt16LE(entry.localOffset + 8)
    const sum = buffer.readUInt32LE(entry.localOffset + 14), compressed = buffer.readUInt32LE(entry.localOffset + 18), size = buffer.readUInt32LE(entry.localOffset + 22)
    const nameLen = buffer.readUInt16LE(entry.localOffset + 26), extraLen = buffer.readUInt16LE(entry.localOffset + 28)
    if (method !== entry.method || flags !== entry.flags) throw Error('DB包本地头与中央目录标志/方式不一致：' + entry.name)
    if (sum !== entry.sum || compressed !== entry.size || size !== entry.size) throw Error('DB包本地头与中央目录声明长度/CRC不一致：' + entry.name)
    if (nameLen !== entry.nameLen || extraLen !== 0) throw Error('DB包本地头名称/扩展字段与中央目录不一致：' + entry.name)
    if (buffer.toString('utf8', entry.localOffset + 30, entry.localOffset + 30 + nameLen) !== entry.name) throw Error('DB包本地头条目名与中央目录不一致：' + entry.name)
    const start = entry.localOffset + 30 + nameLen
    if (start + entry.size > dirOffset) throw Error('DB包条目payload不完整：' + entry.name)
    const data = buffer.subarray(start, start + entry.size)
    if (crc32(data) !== entry.sum) throw Error('DB包条目CRC校验失败：' + entry.name)
    payloads.set(entry.name, data)
    expected = start + entry.size
  }
  if (expected !== dirOffset) throw Error('DB包条目与中央目录之间存在未声明尾部数据')
  return payloads
}

export function decodeDbSave(buffer) {
  if (!Buffer.isBuffer(buffer)) throw Error('DB包不是Buffer')
  if (buffer.length < EOCD_BYTES) throw Error('DB包不完整：长度不足中央目录结尾')
  if (buffer.length > MAX_PACKAGE) throw Error('DB包容量超出上限')
  const eocd = findEocd(buffer)
  const entries = readDirectory(buffer, eocd)
  const dirOffset = buffer.readUInt32LE(eocd + 16)
  const manifestEntry = entries.find(entry => entry.kind === 'manifest')
  const archiveEntry = entries.find(entry => entry.kind === 'archive')
  if (!manifestEntry || !archiveEntry) throw Error('DB包缺少清单或archive条目')
  const natives = entries.filter(entry => entry.kind === 'native'), resources = entries.filter(entry => entry.kind === 'resource')
  const payloads = readPayloads(buffer, entries, dirOffset)
  let manifest
  try {
    manifest = JSON.parse(payloads.get(MANIFEST_NAME).toString('utf8'))
  } catch (error) {
    throw Error('DB包清单不是有效JSON：' + error.message)
  }
  assertManifest(manifest)
  if (natives.length !== manifest.sessions.length) throw Error('DB包原生条目数量与清单sessions不一致')
  const sessions = manifest.sessions.map((id, index) => {
    const entry = natives.find(candidate => candidate.index === index)
    if (!entry) throw Error('DB包缺少清单声明的原生条目：' + nativeName(index))
    return { id, data: assertSqlite(entry.name, payloads.get(entry.name)) }
  })
  if (resources.length !== manifest.resources.length) throw Error('DB包资源条目数量与清单resources不一致')
  const files = manifest.resources.map(path => {
    const entry = resources.find(candidate => candidate.path === path)
    if (!entry) throw Error('DB包缺少清单声明的资源条目：' + path)
    return { path, data: payloads.get(entry.name) }
  })
  const expanded = entries.reduce((total, entry) => total + entry.size, 0)
  if (expanded > MAX_EXPANDED) throw Error('DB包展开容量超出上限')
  const archive = assertSqlite(archiveEntry.name, payloads.get(ARCHIVE_NAME))
  return { manifest, archive, sessions, resources: files }
}
