// DB存档资源传输层：只做资源包预检与结构映射；不调业务service、不写SQL、不建第二权威。
// 包内：index.json 唯一声明（kind/version=1/files[]，逐条声明 kind/path 与来源 oldid/digest/oldsceneFilename）；card.json；script.json（原文）；
// scene/NNNN.json（来源名=64hex key.json）；books/NNNN.json；images/NNNN.bin；resources 只是传输载荷，scene 原JSON仍以上游 profileData 为唯一权威，本层不读源文件。
import { createHash } from 'node:crypto'
export const DB_SAVE_RESOURCE_INDEX = 'index.json'
export const DB_SAVE_RESOURCE_KIND = 'db-save-resources'
export const DB_SAVE_RESOURCE_VERSION = 1
// 纯文本字段：不做任何字符串替换（正文/anchor/变量/脚本源/快照）；其对象子树禁身份映射，但结构image refs仍换新ref。
export const DB_SAVE_RESOURCE_TEXT_KEYS = Object.freeze(['text', 'sourceText', 'rawText', 'message', 'anchor', 'tree', 'variables', 'tavernHelperScriptVariables', 'tavernScriptPrompts', 'cardDefinitionSnapshot', 'runtimePresetSnapshot', 'openingWorldbookSnapshot', 'snapshot'])
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024, MAX_SCENE_RECORD_BYTES = 8 * 1024 * 1024, MAX_RESOURCE_ENTRIES = 256
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PATH = /^(?:card\.json|script\.json|scene\/\d{4}\.json|books\/\d{4}\.json|images\/\d{4}\.bin)$/
const SCENE_KEY = /^[0-9a-f]{64}$/, BAD_NAME = /[<>:"/\\|?*\u0000-\u001F]/, DIGEST = /^[0-9a-f]{64}$/, SEGMENT = /^[A-Za-z0-9._-]+$/
const TEXT_KEYS = new Set(DB_SAVE_RESOURCE_TEXT_KEYS), SKIP_KEYS = new Set(['deletedVersions'])  // index.files 每条只允许 path/kind+来源字段，未知字段一律拒
const ENTRY_FIELDS = Object.freeze({ card: ['path', 'kind', 'native'], script: ['path', 'kind', 'native'], scene: ['path', 'kind', 'native'], worldbook: ['path', 'kind', 'digest'], image: ['path', 'kind', 'attachmentId', 'mediaType'] })
// 附件引用只保留 ImageAttachmentRef 的7个字段；readImage 严格校验 mediaType/width/height/bytes，故同id这些字段冲突必须拒。
const REF_FIELDS = ['attachmentId', 'mediaType', 'width', 'height', 'bytes', 'name', 'originalDimensions'], REF_CONFLICT_KEYS = ['mediaType', 'width', 'height', 'bytes']
// scene记录只带明确结果字段；ownerPid/ownerId/diagnostics/diagnosticContext/providerRequests/providerTask/requests/
// traceSessionId/planDraft/deletedVersions/configuration等运行/审计/渠道参数一律不带（encode剔除，decode strict拒）。
const SCENE_FIELDS = new Set(['key', 'turn', 'swipeId', 'sourceDigest', 'status', 'attachment', 'prompt', 'model', 'createdAt', 'completedAt', 'versions', 'plan', 'error'])
const VERSION_FIELDS = new Set(['id', 'requestId', 'attachment', 'prompt', 'model', 'createdAt', 'completedAt', 'plan', 'error'])
const SESSION_KEYS = new Set(['sessionId', 'foregroundSessionId', 'parentSessionId', 'parentSession', 'traceSessionId', 'traceSessionIds', 'startedSessionId', 'backgroundSessionId', 'backgroundHistoryIds']), SCENE_KEY_FIELDS = new Set(['key', 'sourceKey', 'targetKey'])
const str = value => typeof value === 'string' ? value : '', pad = index => String(index).padStart(4, '0')
const sha256Of = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function pick(value, fields) { const out = {}; for (const field of fields) if (value[field] !== undefined) out[field] = value[field]; return out }
function resourcePath(value) {
  if (typeof value !== 'string' || !value) throw Error('DB存档资源路径无效'); if (value.includes('\\') || value.includes('\0')) throw Error('DB存档资源路径危险：' + value)
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw Error('DB存档资源路径危险（不接受绝对路径）：' + value)
  for (const segment of value.split('/')) if (!segment || segment === '.' || segment === '..' || !SEGMENT.test(segment)) throw Error('DB存档资源路径危险（不接受越级或异常段）：' + value); return value
}
// 来源只取basename；生图agent运行记录不是可移植scene内容，不导入用户agents配置。
function safeBasename(value) {
  const parts = str(value).replace(/\\/g, '/').split('/'), name = parts[parts.length - 1]
  if (!name || name === '.' || name === '..' || name.length > 128 || BAD_NAME.test(name) || /[. ]$/.test(name) || name === 'agent.json') throw Error('DB存档资源来源名不合法：' + str(value)); return name
}
// scene来源名必须就是 64hex key.json（上游 scene-images/<sha(chatId)>/<key>.json）。
function sceneSourceName(value) {
  const name = safeBasename(value)
  if (!name.endsWith('.json') || !SCENE_KEY.test(name.slice(0, -5))) throw Error('DB存档scene来源名必须是64位十六进制key.json：' + name); return name
}
function bufferOf(value, path) { if (!Buffer.isBuffer(value) || value.length === 0) throw Error('DB存档资源缺少payload：' + path); return Buffer.from(value) }
// 只认结构化引用；纯字符串URL/路径一律不算引用。
function refOf(value) { return value && typeof value === 'object' && !Array.isArray(value) && typeof value.attachmentId === 'string' && value.attachmentId !== '' && typeof value.mediaType === 'string' && value.mediaType !== '' ? value : null }
function jsonOf(payload, label) { try { return JSON.parse(payload.toString('utf8')) } catch (error) { throw Error('DB存档' + label + '不是有效JSON：' + error.message) } }
function sceneRawOf(payload, path) { if (payload.length > MAX_SCENE_RECORD_BYTES) throw Error('DB存档scene记录超出上限：' + path); return jsonOf(payload, 'scene记录') }
function sanitizeSceneRecord(record) {
  const out = pick(record, SCENE_FIELDS)
  if (Array.isArray(out.versions)) out.versions = out.versions.map(version => version && typeof version === 'object' ? pick(version, VERSION_FIELDS) : version); return out
}
// 卡载荷只接受 text(text非空) 或 png(b64 与 fileB64 均非空且 distinct：b64=PNG 内嵌卡JSON base64，fileB64=整张PNG base64)；载荷仅作自含回退。
function assertCardPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('DB存档卡载荷不是对象')
  if ((value.kind === 'text' && typeof value.text === 'string' && value.text.trim() !== '') || (value.kind === 'png' && typeof value.b64 === 'string' && value.b64 !== '' && typeof value.fileB64 === 'string' && value.fileB64 !== '')) return value
  throw Error('DB存档卡载荷kind/内容无效：只接受非空 text 或 png(b64+fileB64)')
}
function assertEntryFields(entry, path) {
  const allowed = ENTRY_FIELDS[entry.kind]; if (!allowed) throw Error('DB存档资源索引kind未知：' + str(entry.kind))
  for (const field of Object.keys(entry)) if (!allowed.includes(field)) throw Error('DB存档资源索引条目含未知字段（' + field + '）：' + path) }
function assertSceneRaw(record, path) {  // 未静止（running / recovery save）先拒；encode与decode共用
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('DB存档scene记录无效：' + path)
  if (record.status === 'running') throw Error('DB存档scene记录仍在生图，未静止：' + path)
  if (record.recovery === 'save') throw Error('DB存档scene记录有待重试保存的图片，未静止：' + path); return record
}
// decode侧严格：白名单外字段（运行/审计/渠道参数）一律拒，不静默丢弃外来包。
function assertSceneRecord(record, path) {
  assertSceneRaw(record, path)
  if (!SCENE_KEY.test(str(record.key))) throw Error('DB存档scene记录key不是64位十六进制：' + path)
  for (const field of Object.keys(record)) if (!SCENE_FIELDS.has(field)) throw Error('DB存档scene记录含运行/审计字段（' + field + '）：' + path)
  for (const version of Array.isArray(record.versions) ? record.versions : []) { if (!version || typeof version !== 'object' || Array.isArray(version)) throw Error('DB存档scene版本条目无效：' + path); for (const field of Object.keys(version)) if (!VERSION_FIELDS.has(field)) throw Error('DB存档scene版本含运行/审计字段（' + field + '）：' + path) }
  return record
}
// 结构化收集附件引用：只递归真实结构对象，永不解析字符串（正文可能恰是含attachmentId/sessionId的JSON故事文本）。
// 跳过deletedVersions（已删图不随档）；非图片/文件引用必须响亮拒绝（无readFile支持），不默默忽略。
export function collectDbSaveAttachmentRefs(value, found = new Map()) {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) { for (const child of value) collectDbSaveAttachmentRefs(child, found); return found }
  if (typeof value.fileId === 'string' && value.fileId !== '') throw Error('DB存档不支持文件附件引用（无readFile）：' + value.fileId)
  if (value.attachmentId === undefined && typeof value.name === 'string' && typeof value.bytes === 'number') throw Error('DB存档不支持文件附件引用（无readFile）：' + value.name)
  if (typeof value.attachmentId === 'string' && value.attachmentId !== '') {
    if (typeof value.mediaType !== 'string' || value.mediaType === '') throw Error('DB存档附件引用缺少mediaType：' + value.attachmentId)
    if (!value.mediaType.startsWith('image/')) throw Error('DB存档不支持非图片附件引用：' + value.attachmentId + '/' + value.mediaType)
    const ref = pick(value, REF_FIELDS), current = found.get(ref.attachmentId)
    if (!current) found.set(ref.attachmentId, ref)
    else {
      for (const field of REF_CONFLICT_KEYS) if (current[field] !== undefined && ref[field] !== undefined && current[field] !== ref[field]) throw Error('DB存档附件引用冲突（' + field + '）：' + ref.attachmentId)
      for (const field of REF_FIELDS) if (current[field] === undefined && ref[field] !== undefined) current[field] = ref[field]
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (SKIP_KEYS.has(key)) continue
    if (child && typeof child === 'object') collectDbSaveAttachmentRefs(child, found)
  }
  return found
}
// 世界书sidecar引用：只认 {version:1, digest:<64hex>} 结构（chat消息绑定/开局绑定/scene plan内明确ref），不猜字段名。
export function collectDbSaveWorldbookRefs(value, found = new Set()) {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) { for (const child of value) collectDbSaveWorldbookRefs(child, found); return found }
  if (value.version === 1 && DIGEST.test(str(value.digest))) found.add(value.digest)
  for (const [key, child] of Object.entries(value)) { if (SKIP_KEYS.has(key)) continue; if (child && typeof child === 'object') collectDbSaveWorldbookRefs(child, found) }
  return found
}
// 供租约层复用同一白名单：raw scene 文件 → 归一化 {path, content, record}（不另造第二套白名单）。
export function normalizeDbSaveSceneRecord(file) {
  const path = sceneSourceName(file?.path), payload = bufferOf(file?.content, path)
  const record = assertSceneRecord(sanitizeSceneRecord(assertSceneRaw(sceneRawOf(payload, path), path)), path)
  if (path !== record.key + '.json') throw Error('DB存档scene来源名与本局key不符：' + path)
  return { path, content: Buffer.from(JSON.stringify(record), 'utf8'), record }
}
// 打包为 zip 层 resources 数组（[{path,data}]，index.json 在首位，顺序即清单顺序）。
export function encodeDbSaveResources(input = {}) {
  const cardSnapshot = input.cardSnapshot ?? null, cardPayload = input.cardPayload ?? null
  if (!cardSnapshot && !cardPayload) throw Error('DB存档卡资源缺少快照与卡载荷')
  if (cardSnapshot !== null && (typeof cardSnapshot !== 'object' || Array.isArray(cardSnapshot))) throw Error('DB存档卡快照必须是对象或null')
  if (cardPayload !== null) assertCardPayload(cardPayload)
  const files = [{ path: 'card.json', kind: 'card', native: null, data: Buffer.from(JSON.stringify({ version: 1, snapshot: cardSnapshot, payload: cardPayload }), 'utf8') }]
  if (input.script) {
    const text = str(input.script.text)
    if (text.trim() === '') throw Error('DB存档剧本资源为空')
    files.push({ path: 'script.json', kind: 'script', native: safeBasename(input.script.path), data: Buffer.from(text, 'utf8') })
  }
  const sceneKeys = new Set(), digests = new Set(), attachmentIds = new Set()
  ;(input.sceneFiles || []).forEach((file, index) => {
    // 顺序：raw解析+容量 → 未静止 → sanitize剔除运行/审计字段 → 按decode同口径strict自检。
    const path = 'scene/' + pad(index) + '.json', normalized = normalizeDbSaveSceneRecord(file)
    if (sceneKeys.has(normalized.record.key)) throw Error('DB存档scene记录重复：' + normalized.record.key); sceneKeys.add(normalized.record.key)
    files.push({ path, kind: 'scene', native: normalized.path, data: normalized.content })
  })
  ;(input.worldbooks || []).forEach((book, index) => {
    const path = 'books/' + pad(index) + '.json', digest = str(book?.digest), data = bufferOf(book?.content, path)
    if (!DIGEST.test(digest)) throw Error('DB存档世界书digest无效：' + digest); if (digests.has(digest)) throw Error('DB存档世界书digest重复：' + digest); digests.add(digest)
    const decoded = jsonOf(data, '世界书快照')
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw Error('DB存档世界书快照不是JSON对象：' + path)
    if (sha256Of(decoded) !== digest) throw Error('DB存档世界书digest与内容不符：' + digest)
    files.push({ path, kind: 'worldbook', digest, data })
  })
  ;(input.attachments || []).forEach((attachment, index) => {
    const path = 'images/' + pad(index) + '.bin', attachmentId = str(attachment?.attachmentId), mediaType = str(attachment?.mediaType)
    if (!attachmentId) throw Error('DB存档附件缺少attachmentId')
    if (!MEDIA_TYPES.has(mediaType)) throw Error('DB存档附件媒体类型不支持：' + mediaType)
    if (attachmentIds.has(attachmentId)) throw Error('DB存档附件oldid重复：' + attachmentId); attachmentIds.add(attachmentId)
    files.push({ path, kind: 'image', attachmentId, mediaType, data: bufferOf(attachment?.data, path) })
  })
  const index = { kind: DB_SAVE_RESOURCE_KIND, version: DB_SAVE_RESOURCE_VERSION, files: files.map(({ data, ...entry }) => entry) }
  return [{ path: DB_SAVE_RESOURCE_INDEX, data: Buffer.from(JSON.stringify(index), 'utf8') }, ...files.map(({ path, data }) => ({ path, data }))]
}
// 预检：白名单/重复/越级/容量/媒体类型/索引一致性/附件闭包/世界书闭包/剧本与卡自含；不合格一律响亮拒绝。
// index.json 唯一且只允许出现一次、不得自声明；index根只允许 kind/version/files；card.json 条目必需；worldbook 须为JSON对象且 canonical digest 相符。
export function validateDbSaveResources(resources, chat, nativeEvents) {
  if (!Array.isArray(resources) || resources.length === 0) throw Error('DB存档资源包为空')
  if (resources.length > MAX_RESOURCE_ENTRIES) throw Error('DB存档资源条目超出上限（' + MAX_RESOURCE_ENTRIES + '）')
  const data = new Map(); let total = 0
  for (const item of resources) {
    const path = resourcePath(item?.path)
    if (path !== DB_SAVE_RESOURCE_INDEX && !PATH.test(path)) throw Error('DB存档资源路径不在白名单：' + path)
    if (!Buffer.isBuffer(item?.data)) throw Error('DB存档资源缺少payload：' + path)
    if (item.data.length > MAX_RESOURCE_BYTES) throw Error('DB存档资源单条超出上限：' + path)
    if (data.has(path)) throw Error('DB存档资源路径重复：' + path)
    total += item.data.length
    data.set(path, item.data)
  }
  if (total > MAX_RESOURCE_BYTES) throw Error('DB存档资源总量超出上限')
  const indexBuffer = data.get(DB_SAVE_RESOURCE_INDEX)
  if (!indexBuffer) throw Error('DB存档资源缺少 ' + DB_SAVE_RESOURCE_INDEX)
  let index
  try { index = JSON.parse(indexBuffer.toString('utf8')) } catch (error) { throw Error('DB存档资源索引不是有效JSON：' + error.message) }
  if (!index || typeof index !== 'object' || Array.isArray(index) || index.kind !== DB_SAVE_RESOURCE_KIND || index.version !== DB_SAVE_RESOURCE_VERSION) throw Error('DB存档资源索引kind/version无效')
  for (const field of Object.keys(index)) if (!['kind', 'version', 'files'].includes(field)) throw Error('DB存档资源索引根含未知字段（' + field + '）')
  if (!Array.isArray(index.files)) throw Error('DB存档资源索引缺少files声明')
  const bundle = { index, card: null, script: null, sceneFiles: [], worldbooks: [], attachments: [], refs: collectDbSaveAttachmentRefs([chat, ...(Array.isArray(nativeEvents) ? nativeEvents : (nativeEvents ? [nativeEvents] : []))]) }
  const declared = new Set(), sceneKeys = new Set(), digests = new Set(), attachmentIds = new Set()
  for (const entry of index.files) {
    if (!entry || typeof entry !== 'object') throw Error('DB存档资源索引条目无效')
    const path = resourcePath(entry.path), payload = data.get(path)
    if (!PATH.test(path) || path === DB_SAVE_RESOURCE_INDEX) throw Error('DB存档资源索引声明了白名单外路径：' + path)
    if (declared.has(path)) throw Error('DB存档资源索引路径重复：' + path)
    declared.add(path)
    if (!payload) throw Error('DB存档资源索引声明了包内不存在的条目：' + path)
    assertEntryFields(entry, path)
    if (entry.kind === 'card') {
      if (path !== 'card.json') throw Error('DB存档资源kind与路径不符：' + path)
      const card = jsonOf(payload, '卡资源')
      if (!card || typeof card !== 'object' || Array.isArray(card)) throw Error('DB存档卡资源不是对象'); if (card.version !== 1) throw Error('DB存档卡资源version无效：只接受1')
      const snapshot = card.snapshot ?? null, cardPayload = card.payload == null ? null : assertCardPayload(card.payload)
      if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) throw Error('DB存档卡快照必须是对象或null'); if (snapshot === null && cardPayload === null) throw Error('DB存档卡资源既无快照也无卡载荷')
      bundle.card = { path, snapshot, payload: cardPayload }
    } else if (entry.kind === 'script') {
      if (path !== 'script.json') throw Error('DB存档资源kind与路径不符：' + path)
      const text = payload.toString('utf8'); if (text.trim() === '') throw Error('DB存档剧本资源为空')
      bundle.script = { path, text, source: safeBasename(entry.native) }
    } else if (entry.kind === 'scene') {
      if (!/^scene\/\d{4}\.json$/.test(path)) throw Error('DB存档资源kind与路径不符：' + path)
      const source = sceneSourceName(entry.native), record = assertSceneRecord(sceneRawOf(payload, path), path)
      if (source !== record.key + '.json') throw Error('DB存档scene来源名与本局key不符：' + source)
      if (sceneKeys.has(record.key)) throw Error('DB存档scene记录重复：' + record.key); sceneKeys.add(record.key)
      collectDbSaveAttachmentRefs(record, bundle.refs)
      bundle.sceneFiles.push({ path, data: payload, source, record })
    } else if (entry.kind === 'worldbook') {
      if (!/^books\/\d{4}\.json$/.test(path)) throw Error('DB存档资源kind与路径不符：' + path)
      const digest = str(entry.digest)
      if (!DIGEST.test(digest)) throw Error('DB存档世界书digest无效：' + digest); if (digests.has(digest)) throw Error('DB存档世界书digest重复：' + digest); digests.add(digest)
      const book = jsonOf(payload, '世界书快照')
      if (!book || typeof book !== 'object' || Array.isArray(book)) throw Error('DB存档世界书快照不是JSON对象：' + path)
      if (sha256Of(book) !== digest) throw Error('DB存档世界书digest与内容不符：' + digest)
      collectDbSaveAttachmentRefs(book, bundle.refs)
      bundle.worldbooks.push({ path, data: payload, digest, record: book })
    } else {
      if (!/^images\/\d{4}\.bin$/.test(path)) throw Error('DB存档资源kind与路径不符：' + path)
      const attachmentId = str(entry.attachmentId), mediaType = str(entry.mediaType)
      if (!attachmentId) throw Error('DB存档附件缺少attachmentId：' + path)
      if (!MEDIA_TYPES.has(mediaType)) throw Error('DB存档附件媒体类型不支持：' + mediaType)
      if (payload.length === 0) throw Error('DB存档附件为空：' + path)
      if (attachmentIds.has(attachmentId)) throw Error('DB存档附件oldid重复：' + attachmentId); attachmentIds.add(attachmentId)
      bundle.attachments.push({ path, data: payload, attachmentId, mediaType })
    }
  }
  for (const path of data.keys()) if (path !== DB_SAVE_RESOURCE_INDEX && !declared.has(path)) throw Error('DB存档资源含未声明条目：' + path)
  if (!bundle.card) throw Error('DB存档资源缺少card.json条目：卡资源必须随档自含'); collectDbSaveAttachmentRefs([bundle.card.snapshot, bundle.card.payload], bundle.refs)
  const requiredBooks = collectDbSaveWorldbookRefs([chat, ...bundle.sceneFiles.map(file => file.record)])
  for (const digest of requiredBooks) if (!digests.has(digest)) throw Error('DB存档缺少本局世界书快照：' + digest)
  for (const digest of digests) if (!requiredBooks.has(digest)) throw Error('DB存档含非本局世界书快照：' + digest)
  const scriptMode = (chat?.mode || 'story') === 'script'
  if (scriptMode ? !bundle.script : bundle.script) throw Error(scriptMode ? 'DB存档剧本资源缺失：script模式必须携带剧本' : 'DB存档剧本资源多余：非script模式不接受剧本')
  if (!chat?.cardDefinitionSnapshot && !bundle.card.payload) throw Error('DB存档卡资源不自含：缺少本局卡快照时必须携带卡载荷')
  const packaged = new Map(bundle.attachments.map(item => [item.attachmentId, item]))
  for (const ref of bundle.refs.values()) {
    const image = packaged.get(ref.attachmentId)
    if (!image) throw Error('DB存档资源缺少附件：' + ref.attachmentId)
    if (image.mediaType !== ref.mediaType) throw Error('DB存档附件媒体类型与引用不一致：' + ref.attachmentId)
    packaged.delete(ref.attachmentId)
  }
  for (const image of packaged.values()) throw Error('DB存档资源含未被引用的图片：' + image.path)
  return bundle
}
// 结构映射：只改身份字段与结构化ref；所有字符串字节原样，无全局replace、不解析JSON文本。
// identity 需带 chatId/sessionId/sessions(Map) 与 sourceChatId（源档身份，saveIdentityMap 未返回，须由调用方补）。
// 保护字段（TEXT_KEYS）子树 allowIdentity=false：禁sessionId/chatId/sceneKey等按名字映射，仅结构image refs换新ref。
// ref节点：先移除旧ref白名单字段再整份合并新ref（不留旧 originalDimensions/name），anchor/caption等非ref叙事保留。
export function rewriteDbSaveResourceRefs(value, attachmentMap, identity, sceneKeyMap) {
  const images = attachmentMap instanceof Map ? attachmentMap : new Map(Object.entries(attachmentMap || {}))
  const sceneKeys = sceneKeyMap instanceof Map ? sceneKeyMap : new Map(Object.entries(sceneKeyMap || {}))
  const sessions = identity?.sessions, sourceChatId = str(identity?.sourceChatId)
  if (!str(identity?.chatId) || !str(identity?.sessionId) || !sourceChatId || !(sessions instanceof Map)) throw Error('DB资源身份映射缺少 chatId/sessionId/sourceChatId/sessions')
  const sessionOf = id => { if (!sessions.has(id)) throw Error('DB存档含闭包外会话引用：' + id); return sessions.get(id) }
  const walkFields = (node, allowIdentity) => Object.fromEntries(Object.entries(node).map(([field, child]) => [field, walk(child, field, allowIdentity)]))
  const walk = (node, key, allowIdentity = true) => {
    if (SKIP_KEYS.has(key)) return structuredClone(node)
    if (Array.isArray(node)) return allowIdentity && SESSION_KEYS.has(key) ? node.map(sessionOf) : node.map(child => walk(child, key, allowIdentity))
    if (node && typeof node === 'object') {
      const ref = refOf(node), next = ref ? images.get(ref.attachmentId) : null
      if (ref) {
        if (!next) throw Error('DB存档附件引用缺少包内映射：' + ref.attachmentId)
        const out = walkFields(node, allowIdentity); for (const field of REF_FIELDS) delete out[field]
        return { ...out, ...next }
      }
      return walkFields(node, TEXT_KEYS.has(key) ? false : allowIdentity)
    }
    if (typeof node === 'string') {
      if (!allowIdentity || TEXT_KEYS.has(key)) return node
      if (SCENE_KEY_FIELDS.has(key) && sceneKeys.has(node)) return sceneKeys.get(node)
      if (SESSION_KEYS.has(key) && node) return sessionOf(node)
      if (key === 'chatId' && node === sourceChatId) return identity.chatId
      if (key === 'branchId' && identity.sourceBranchId && node === identity.sourceBranchId) return identity.branchId
      return node
    }
    return node
  }
  return walk(value, '')
}
