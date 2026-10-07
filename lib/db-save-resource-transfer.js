// DB存档资源租约：capture/validate/install。只搬本局资源，不建第二权威、不改engine、不删共享内容寻址缓存。
// deps 显式注入：fileResources/profileData/gameFootprint/attachments 对象 + readChatCard/importCard/importScript/computeSceneTarget/validateCard 函数。
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { encodeDbSaveResources, validateDbSaveResources, collectDbSaveAttachmentRefs, collectDbSaveWorldbookRefs, normalizeDbSaveSceneRecord, DB_SAVE_RESOURCE_INDEX, DB_SAVE_RESOURCE_TEXT_KEYS } from './db-save-resources.js'

const sha256 = value => createHash('sha256').update(String(value)).digest('hex')
const sha256Of = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const str = value => typeof value === 'string' ? value : ''
const DIGEST = /^[0-9a-f]{64}$/
const REF_FIELDS = ['attachmentId', 'mediaType', 'width', 'height', 'bytes', 'name', 'originalDimensions']
const KEY_FIELDS = new Set(['key', 'sourceKey', 'targetKey'])
const TEXT_KEYS = new Set(DB_SAVE_RESOURCE_TEXT_KEYS)
const SCENE_CONTEXT = new Set(['sceneTargets', 'sceneTarget'])
const CONTEXT_ALIAS = { tree_json: 'tree', snapshot_json: 'snapshot', data_json: 'data', header_json: 'header' }
const bytesOf = value => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value || [])
const isRef = value => !!value && typeof value === 'object' && !Array.isArray(value) && typeof value.attachmentId === 'string' && value.attachmentId !== '' && typeof value.mediaType === 'string' && value.mediaType !== ''

// 只逐 row 的 *_json 列 parse；不 parse 任意字符串（正文JSON字符串永不当资源）。
export function allDbSaveResourceValues(tables) {
  const out = []
  for (const rows of Object.values(tables || {})) {
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      for (const [key, value] of Object.entries(row)) {
        if (!key.endsWith('_json') || typeof value !== 'string') continue
        try { out.push(JSON.parse(value)) } catch { /* 非JSON列值不进入资源闭包 */ }
      }
    }
  }
  return out
}

export function createDbSaveResourceTransfer(deps = {}) {
  const { fileResources, profileData, gameFootprint, attachments } = deps
  for (const name of ['fileResources', 'profileData', 'gameFootprint', 'attachments']) if (!deps[name] || typeof deps[name] !== 'object') throw Error('资源租约缺少依赖对象：' + name)
  if (typeof profileData.version !== 'function') throw Error('资源租约缺少依赖函数：profileData.version')
  for (const name of ['readChatCard', 'importCard', 'computeSceneTarget', 'validateCard']) if (typeof deps[name] !== 'function') throw Error('资源租约缺少依赖函数：' + name)

  // 逐轮当前key；computeSceneTarget 抛错即响亮拒（不猜key、不回退旧key/已删版本）。target 原样保留供 import 闭包核对。
  function currentSceneKeys(chat) {
    const keys = []
    for (const message of chat.messages || []) {
      if (message?.role !== 'assistant') continue
      const turn = Number(message.turn || (message.greeting ? 1 : 0))
      let target
      try { target = deps.computeSceneTarget(chat, turn) } catch (error) { throw Error('本局场景目标不可用（turn ' + turn + '）：' + str(error?.message || error)) }
      if (!target || typeof target.key !== 'string' || target.key === '') throw Error('本局正文轮次缺少场景key（turn ' + turn + '）')
      keys.push({ turn, key: target.key, target })
    }
    return keys
  }

  // 卡载荷/快照一致性：deps.validateCard 契约={raw,definition}（作者 create→present({as:'raw'})/project 纯函数；PNG 由 importedObject 真解析 b64 字节）。
  // 无 raw 快照不造 canonical 白名单：用官方 create/project 对快照本身规范化后比 definition（冷路径二次静态解析=必要证据）。
  function assertCardPayloadConsistent(bundle, projected, snapshotDefinition) {
    const snapshot = bundle.card?.snapshot, payload = bundle.card?.payload
    if (!payload) return
    const raw = projected?.raw, definition = projected?.definition
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('DB资源校验：卡载荷未解析出raw对象（缺少预校验协议），拒绝导入')
    if (!definition || typeof definition !== 'object') throw Error('DB资源校验：卡载荷未返回规范definition（缺少预校验协议），拒绝导入')
    const snapshotRaw = snapshot?.raw
    if (snapshotRaw && typeof snapshotRaw === 'object' && !Array.isArray(snapshotRaw)) {
      if (!isDeepStrictEqual(raw, snapshotRaw)) throw Error('DB资源校验：卡载荷与本局快照冲突，拒绝（载荷不是本局人物卡）')
      return
    }
    if (!snapshotDefinition || typeof snapshotDefinition !== 'object') throw Error('DB资源校验：无raw快照未取得规范definition，拒绝导入')
    if (!isDeepStrictEqual(definition, snapshotDefinition)) throw Error('DB资源校验：卡载荷与无raw快照规范不一致，拒绝')
  }

  // import 独立所有权预检：codec 只核 64hex/来源名，不证 scene 属本局；必须用本局 computeSceneTarget 闭包核对。
  function assertSceneClosure(bundle, chat) {
    const current = new Map(currentSceneKeys(chat).map(item => [item.key, item.target]))
    for (const file of bundle.sceneFiles || []) {
      const record = file?.record, key = str(record?.key)
      if (!current.has(key)) throw Error('DB资源校验：闭包外场景记录（key 不属于本局当前轮次）：' + key)
      const turn = Number(record?.turn), expected = deps.computeSceneTarget(chat, turn)
      if (!expected || expected.key !== key) throw Error('DB资源校验：场景记录 turn 与本局目标不符（turn ' + turn + '）：' + key)
      if (record.sourceDigest !== undefined && str(record.sourceDigest) !== str(expected.sourceDigest)) throw Error('DB资源校验：场景记录 sourceDigest 与本局目标不符：' + key)
      if (record.swipeId !== undefined && String(record.swipeId) !== String(expected.swipeId)) throw Error('DB资源校验：场景记录 swipeId 与本局目标不符：' + key)
    }
  }

  async function readBook(digest) {
    if (!DIGEST.test(str(digest))) throw Error('资源捕获：世界书digest无效：' + str(digest))
    const content = await gameFootprint.readSceneWorldbook(digest)
    if (!content) throw Error('资源捕获：本局世界书快照缺失：' + digest)
    const bytes = bytesOf(content)
    let parsed
    try { parsed = JSON.parse(bytes.toString('utf8')) } catch (error) { throw Error('资源捕获：世界书快照不是JSON：' + digest + '：' + str(error?.message || error)) }
    if (sha256Of(parsed) !== digest) throw Error('资源捕获：世界书digest与内容不符：' + digest)
    return { digest, bytes, record: parsed }
  }

  // capture：本局资源窗口快照；images=false 不取scene配图派生，但所有DB结构image refs 仍无条件携。
  async function capture({ chat, tables, nativeEvents, images = true } = {}) {
    if (!chat || typeof chat !== 'object') throw Error('资源捕获缺少本局chat')
    if (typeof chat.id !== 'string' || typeof chat.sessionId !== 'string') throw Error('资源捕获缺少本局身份')
    const snapshot = chat.cardDefinitionSnapshot || structuredClone(await deps.readChatCard(chat))   // fallback 初即脱离 provider 对象；SQL 快照已脱离不克隆
    if (!snapshot || typeof snapshot !== 'object') throw Error('资源捕获：本局人物卡快照缺失')
    let cardPayload = null, cardExternal = false
    if (snapshot.raw && typeof snapshot.raw === 'object') cardPayload = { kind: 'text', name: str(chat.cardName || 'card') + '.json', text: JSON.stringify(snapshot.raw) }
    else {
      const first = await fileResources.originalCardPayload(chat.cardPath)
      if (!first) throw Error('资源捕获：卡快照无raw且原版卡载荷缺失')
      if (!isDeepStrictEqual(first, await fileResources.originalCardPayload(chat.cardPath))) throw Error('资源捕获：原版卡载荷两次读取不一致')
      cardPayload = structuredClone(first); cardExternal = true   // 外部载荷初即深拷贝：防 provider 复用同对象
    }
    let script = null
    if ((chat.mode || 'story') === 'script') {
      const scriptPath = await fileResources.scriptForCard(chat.cardPath)
      if (!scriptPath) throw Error('资源捕获：script模式缺少剧本绑定')
      const text = await fileResources.readText(scriptPath)
      if (typeof text !== 'string' || text.trim() === '') throw Error('资源捕获：剧本内容为空：' + scriptPath)
      script = { path: scriptPath, text }
    }
    const keyed = currentSceneKeys(chat), sceneFiles = [], sceneRecords = [], rawSceneFiles = []
    if (images) {
      const available = new Map((await gameFootprint.readSceneFiles(chat.id) || []).map(file => [str(file?.path), file?.content]))   // 借原始 content：仅 selected 才 own copy
      for (const { key } of keyed) {
        const name = key + '.json', content = available.get(name)
        if (content === undefined) continue  // 该轮没有配图记录：不是缺资源
        rawSceneFiles.push({ path: name, content: bytesOf(content) })           // 仅 selected 场景一次 own copy（bytesOf 即拷贝）
        const normalized = normalizeDbSaveSceneRecord({ path: name, content })  // 同一 codec 白名单：审计字段内的 image ref 不进闭包
        sceneRecords.push(normalized.record)
        sceneFiles.push({ path: name, content: normalized.content })
      }
    }
    const chatBookDigests = [...collectDbSaveWorldbookRefs(chat)]   // 窗口比对用：本局 chat 侧书集合（不重建 encode 包）
    const books = []
    for (const digest of collectDbSaveWorldbookRefs([chat, ...sceneRecords])) books.push(await readBook(digest))   // readBook 内 bytesOf 已是 own copy
    const native = Array.isArray(nativeEvents) ? nativeEvents : (nativeEvents ? [nativeEvents] : [])
    const refs = collectDbSaveAttachmentRefs([chat, ...allDbSaveResourceValues(tables), ...native, snapshot, cardPayload, ...sceneRecords, ...books.map(book => book.record)])
    const imgs = []
    for (const ref of refs.values()) {
      let stored
      try { stored = await attachments.readImage(ref) } catch (error) { throw Error('资源捕获：附件读取失败：' + ref.attachmentId + '：' + str(error?.message || error)) }
      const returned = stored?.ref
      if (!returned || typeof returned !== 'object') throw Error('资源捕获：附件读取未返回ref（违反readImage返回协议）：' + ref.attachmentId)
      if (returned.attachmentId !== ref.attachmentId) throw Error('资源捕获：附件读取返回了别的ref：' + ref.attachmentId + ' → ' + str(returned.attachmentId))
      collectDbSaveAttachmentRefs([ref, returned])  // mediaType/width/height/bytes 冲突即抛，不静默用错字节
      const data = bytesOf(stored?.data)   // bytesOf 已是 own copy：不再二次克隆
      if (data.length === 0) throw Error('资源捕获：附件字节为空：' + ref.attachmentId)
      imgs.push({ attachmentId: ref.attachmentId, mediaType: ref.mediaType, data, ref, observedRef: structuredClone(returned) })   // observedRef=首次返回ref 脱离副本
    }
    const files = encodeDbSaveResources({ cardSnapshot: snapshot, cardPayload, script, sceneFiles, worldbooks: books.map(book => ({ digest: book.digest, content: book.bytes })), attachments: imgs })
    // 窗口稳定：只重读源直比字节/协议，不重建 encode 包、不克隆全图片；覆盖 script/scene/书/图/卡。
    async function assertStable() {
      if (cardExternal) {
        // 外部原版载荷深等：避免对 PNG base64 再序列化
        if (!isDeepStrictEqual(await fileResources.originalCardPayload(chat.cardPath), cardPayload)) throw Error('资源捕获窗口内卡载荷已变化，拒绝打包')
      } else if (!chat.cardDefinitionSnapshot) {
        // 源快照深等：name/state 等字段变化不能被 raw 相同吞掉
        if (!isDeepStrictEqual(await deps.readChatCard(chat), snapshot)) throw Error('资源捕获窗口内人物卡快照已变化，拒绝打包')
      }
      if (script) {
        if (str(await fileResources.scriptForCard(chat.cardPath)) !== script.path) throw Error('资源捕获窗口内剧本绑定已变化，拒绝打包')
        if (await fileResources.readText(script.path) !== script.text) throw Error('资源捕获窗口内剧本内容已变化，拒绝打包')
      }
      const againKeys = currentSceneKeys(chat)
      if (JSON.stringify(againKeys.map(item => item.turn + ':' + item.key)) !== JSON.stringify(keyed.map(item => item.turn + ':' + item.key))) throw Error('资源捕获窗口内scene轮次集合已变化，拒绝打包')
      if (images) {
        const available = new Map((await gameFootprint.readSceneFiles(chat.id) || []).map(file => [str(file?.path), file?.content]))
        const present = new Map(rawSceneFiles.map(file => [file.path, file.content]))
        for (const { key } of keyed) {
          const name = key + '.json', before = present.get(name), now = available.get(name)
          if (!!before !== !!now) throw Error('资源捕获窗口内scene记录出现或缺失，拒绝打包：' + name)
          if (before && !before.equals(Buffer.isBuffer(now) ? now : bytesOf(now))) throw Error('资源捕获窗口内scene原始字节已变化，拒绝打包：' + name)
        }
      }
      if (JSON.stringify([...collectDbSaveWorldbookRefs(chat)]) !== JSON.stringify(chatBookDigests)) throw Error('资源捕获窗口内本局世界书集合已变化，拒绝打包')
      for (const book of books) {
        const bytes = await gameFootprint.readSceneWorldbook(book.digest)
        if (!bytes || !(Buffer.isBuffer(bytes) ? bytes : bytesOf(bytes)).equals(book.bytes)) throw Error('资源捕获窗口内世界书原始字节已变化，拒绝打包：' + book.digest)
      }
      const againRefs = collectDbSaveAttachmentRefs([chat, ...allDbSaveResourceValues(tables), ...native, snapshot, cardPayload, ...sceneRecords, ...books.map(book => book.record)])
      if (JSON.stringify([...againRefs.keys()]) !== JSON.stringify([...refs.keys()])) throw Error('资源捕获窗口内附件引用集合已变化，拒绝打包')
      for (const img of imgs) {
        let stored
        try { stored = await attachments.readImage(img.ref) } catch (error) { throw Error('资源捕获窗口内附件读取失败：' + img.attachmentId + '：' + str(error?.message || error)) }
        const returned = stored?.ref
        if (!returned || typeof returned !== 'object') throw Error('资源捕获窗口内附件读取未返回ref（违反readImage返回协议）：' + img.attachmentId)
        if (returned.attachmentId !== img.attachmentId) throw Error('资源捕获窗口内附件引用已变化：' + img.attachmentId + ' → ' + str(returned.attachmentId))
        collectDbSaveAttachmentRefs([img.ref, returned])
        if (!isDeepStrictEqual(returned, img.observedRef)) throw Error('资源捕获窗口内附件元数据已变化，拒绝打包：' + img.attachmentId)
        if (!(Buffer.isBuffer(stored?.data) ? stored.data : bytesOf(stored?.data)).equals(img.data)) throw Error('资源捕获窗口内附件字节已变化，拒绝打包：' + img.attachmentId)
      }
      return true
    }
    return { files, assertStable, cardSnapshot: snapshot, cardPayload, script, sceneFiles, rawSceneFiles, sceneRecords, books, attachments: imgs, cardExternal }
  }

  // validate：codec 一遍 + 作者 cardPreparation 静态解析（payload 优先，无则 snapshot.raw 文本；两者皆无响亮拒）。
  async function validate({ files, chat, tables, nativeEvents } = {}) {
    const native = Array.isArray(nativeEvents) ? nativeEvents : (nativeEvents ? [nativeEvents] : [])
    const bundle = validateDbSaveResources(files, chat, [...allDbSaveResourceValues(tables), ...native])
    if (chat?.cardDefinitionSnapshot && !isDeepStrictEqual(chat.cardDefinitionSnapshot, bundle.card?.snapshot)) throw Error('DB资源校验：资源版卡快照与SQL卡快照不一致，拒绝')
    assertSceneClosure(bundle, chat)   // 闭包外场景必须在 validateCard/租约/资源写入之前拒
    let payload = bundle.card?.payload ?? null
    if (!payload && bundle.card?.snapshot?.raw) payload = { kind: 'text', name: str(chat?.cardName || 'card') + '.json', text: JSON.stringify(bundle.card.snapshot.raw) }
    if (!payload) throw Error('DB资源校验：既无卡载荷也无卡快照raw，不能假称可玩')
    const projected = await deps.validateCard(payload)   // 作者 supported 纯函数：{ raw: present(as:'raw'), definition: project(create({kind:'import',payload})) }
    const snapshotProjected = bundle.card?.snapshot && !bundle.card.snapshot.raw ? await deps.validateCard({ kind: 'text', text: JSON.stringify(bundle.card.snapshot) }) : null
    assertCardPayloadConsistent(bundle, projected, snapshotProjected?.definition ?? null)   // 冲突必须在创建新身份前拒
    return bundle
  }

  // 资源层结构重绑：坐标（scene key / book digest / mountedResources）只在明确根上下文与未保护子树内生效；
  // image ref 任何情况都换新（含 tree/snapshot 内），正文与变量字符串永不改字节、永不 parse。
  const sceneLike = (parent, sceneContext) => sceneContext || (!!parent && typeof parent === 'object' && !Array.isArray(parent) && Number.isFinite(Number(parent.turn)) && typeof parent.sourceDigest === 'string' && typeof parent.key === 'string')
  function rewriteResourceValue(value, ctx, state = {}) {
    const key = str(state.key), allowCoordinates = state.allowCoordinates !== false, sceneContext = state.sceneContext === true, parent = state.parent ?? null
    if (key === 'mountedResources' && allowCoordinates && Array.isArray(value)) return value.map(entry => {
      if (!entry || typeof entry !== 'object' || (entry.kind !== 'card' && entry.kind !== 'source')) return entry
      const path = ctx.pathMap.get(str(entry.path))
      return path ? { ...entry, path, ...(entry.label === undefined ? {} : { label: path.split('/').pop() }) } : entry
    })
    if (Array.isArray(value)) return value.map(child => rewriteResourceValue(child, ctx, { key, allowCoordinates, sceneContext, parent: value }))
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && allowCoordinates) {
        if (KEY_FIELDS.has(key) && sceneLike(parent, sceneContext) && ctx.sceneKeyMap.has(value)) return ctx.sceneKeyMap.get(value)
        if (key === 'digest' && parent && parent.version === 1 && ctx.worldbookDigestMap.has(value)) return ctx.worldbookDigestMap.get(value)
      }
      return value
    }
    if (isRef(value)) {
      const next = ctx.attachmentMap.get(value.attachmentId)
      if (!next) throw Error('资源重绑：附件引用缺少新ref：' + value.attachmentId)
      const out = { ...value }; for (const field of REF_FIELDS) delete out[field]
      return { ...out, ...next }
    }
    const coordinates = allowCoordinates && !TEXT_KEYS.has(key)
    const inner = { allowCoordinates: coordinates, sceneContext: coordinates && sceneContext, parent: value }
    // 用 Object.fromEntries 定义自有属性：'__proto__' 等键不会被 setter 丢掉/污染。
    return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, rewriteResourceValue(child, ctx, { ...inner, key: field })]))
  }

  // 原row json 结构deepEqual不变则保原byte；真的typed ref变化才 JSON.stringify。根上下文决定坐标可用。
  function rewriteResourceTables(tables, ctx) {
    const out = {}
    for (const [table, rows] of Object.entries(tables || {})) {
      out[table] = (Array.isArray(rows) ? rows : []).map(row => {
        if (!row || typeof row !== 'object') return row
        let changed = false
        const next = { ...row }
        for (const [column, value] of Object.entries(row)) {
          if (!column.endsWith('_json') || typeof value !== 'string') continue
          const context = table === 'archive_head_fields' ? str(row.key) : table === 'archive_messages' ? 'messages' : (str(row.key) || CONTEXT_ALIAS[column] || column)
          let parsed
          try { parsed = JSON.parse(value) } catch { continue }
          const text = JSON.stringify(rewriteResourceValue(parsed, ctx, { key: context, allowCoordinates: column !== 'header_json', sceneContext: SCENE_CONTEXT.has(context), parent: null }))
          if (text !== JSON.stringify(parsed)) { next[column] = text; changed = true }
        }
        return changed ? next : row
      })
    }
    if (Array.isArray(out.archive_head_fields)) out.archive_head_fields = injectCardSnapshot(out.archive_head_fields, ctx)
    return out
  }

  // 缺 SQL 卡快照时把资源版快照补回 archive_head_fields：原行替换，或插入到 messages 占位之前并保持 ord 连续（不建第二权威）。
  function injectCardSnapshot(rows, ctx) {
    if (!ctx.cardSnapshot) return rows
    const value = JSON.stringify(rewriteResourceValue(ctx.cardSnapshot, ctx, { key: 'cardDefinitionSnapshot', allowCoordinates: false, sceneContext: false, parent: null }))
    const existing = rows.find(row => row?.key === 'cardDefinitionSnapshot')
    if (existing) return rows.map(row => row === existing ? { ...row, value_json: value } : row)
    const template = rows.find(row => row?.value_json !== null && row?.value_json !== undefined && row?.key !== 'messages' && row?.key !== 'timeline')
    const at = rows.findIndex(row => row?.key === 'messages')
    const next = [...rows]
    next.splice(at < 0 ? next.length : at, 0, { key: 'cardDefinitionSnapshot', kind: Number(template?.kind) || 0, value_json: value })
    return next.map((row, ord) => ({ ...row, ord }))
  }

  // install：新建本局自有资源（卡/剧本/scene文件）+ 共享缓存写入（图/书，永不删除）；任何失败先回滚自己创建的assets再抛 AggregateError。
  async function install(bundle, sourceChat, identity = {}) {
    const chatId = str(identity.chatId), sessionId = str(identity.sessionId)
    if (!chatId || !sessionId) throw Error('DB资源安装缺少新身份')
    if (!sourceChat || typeof sourceChat !== 'object') throw Error('DB资源安装缺少源chat')
    const created = { scene: [], cardPath: null, scriptPath: null, bound: false }
    // 可重试补偿：每项只有成功才清；任一步失败继续做后续，残项保留给第二次 rollback 只重试。
    async function rollback() {
      const failures = []
      const attempt = async work => { try { await work(); return true } catch (error) { failures.push(error); return false } }
      if (created.bound && created.cardPath) { const path = created.cardPath; if (await attempt(() => fileResources.unbindMaterial(path))) created.bound = false }
      if (created.scriptPath) { const path = created.scriptPath; if (await attempt(() => fileResources.remove(path))) created.scriptPath = null }
      if (created.cardPath) { const path = created.cardPath; if (await attempt(() => fileResources.remove(path))) created.cardPath = null }
      for (let index = created.scene.length - 1; index >= 0; index--) { const path = created.scene[index]; if (await attempt(() => profileData.remove(path))) created.scene.splice(index, 1) }
      if (failures.length) throw new AggregateError(failures, 'DB资源回滚不完整（残项保留可重试）')
      return true
    }
    try {
      const attachmentMap = new Map()
      for (const item of bundle.attachments) attachmentMap.set(item.attachmentId, await attachments.saveImage({ data: new Uint8Array(item.data), mediaType: item.mediaType }))
      const proxy = { ...sourceChat, id: chatId, sessionId, sceneTargets: undefined }
      const sourceKeys = new Map(currentSceneKeys(sourceChat).map(item => [item.turn, item.key])), sceneKeyMap = new Map()
      for (const item of currentSceneKeys(proxy)) {
        const oldKey = sourceKeys.get(item.turn)
        if (!oldKey) throw Error('DB资源安装：新chat轮次在源档没有对应target（turn ' + item.turn + '）')
        if (oldKey !== item.key) sceneKeyMap.set(oldKey, item.key)
      }
      const payload = bundle.card?.payload ?? (bundle.card?.snapshot?.raw ? { kind: 'text', name: 'card.json', text: JSON.stringify(bundle.card.snapshot.raw) } : null)
      if (!payload) throw Error('DB资源安装：卡载荷缺失')
      const cardPath = (await deps.importCard({ ...payload, name: 'db-' + chatId + (payload.kind === 'png' ? '.png' : '.json') })).path
      created.cardPath = cardPath
      if (bundle.script) {
        // 不用 importScript 的 title 复用（会把他人共享 material 绑进来且回滚误删）；用 importText + bindMaterial 精确绑定本次新文件。
        created.scriptPath = await fileResources.importText('source', { name: 'db-' + chatId + '.txt', text: bundle.script.text })
        await fileResources.bindMaterial(cardPath, created.scriptPath)
        created.bound = true
      }
      const worldbookDigestMap = new Map(), pathMap = new Map([[str(sourceChat.cardPath), cardPath]])
      if (created.scriptPath && bundle.script?.source) {
        // 传输里的 script.path 只是包内 'script.json'；按 workspace.mountedResources 中 kind=source 且 basename 匹配的唯一源路径精确重绑。
        const mounted = Array.isArray(sourceChat.workspace?.mountedResources) ? sourceChat.workspace.mountedResources : []
        const candidates = [...new Set(mounted.filter(entry => entry?.kind === 'source' && str(entry.path).split('/').pop() === str(bundle.script.source)).map(entry => str(entry.path)))]
        if (candidates.length > 1) throw Error('DB资源安装：源剧本挂载路径不唯一，无法精确重绑：' + candidates.join('、'))
        if (candidates.length === 1) pathMap.set(candidates[0], created.scriptPath)
      }
      const ctx = { attachmentMap, sceneKeyMap, worldbookDigestMap, pathMap, cardSnapshot: sourceChat.cardDefinitionSnapshot ? null : (bundle.card?.snapshot ?? null) }
      for (const book of bundle.worldbooks) {
        // 跨机器：源有目标没有也必须写；未变书写原始字节（不重格式），变了的写重绑后字节；digestMap 只记 changed。
        const rewritten = rewriteResourceValue(book.record, ctx), digest = sha256Of(rewritten)
        const existing = await gameFootprint.readSceneWorldbook(digest)
        if (existing) {
          let parsedExisting
          try { parsedExisting = JSON.parse(bytesOf(existing).toString('utf8')) } catch (error) { throw Error('DB资源安装：目标世界书不是JSON：' + digest) }
          if (sha256Of(parsedExisting) !== digest) throw Error('DB资源安装：目标世界书digest冲突：' + digest)
        } else await profileData.writeBytes('scene-images/worldbooks/' + digest + '.json', digest === book.digest ? bytesOf(book.data) : Buffer.from(JSON.stringify(rewritten)))
        if (digest !== book.digest) worldbookDigestMap.set(book.digest, digest)
      }
      for (const file of bundle.sceneFiles) {
        const oldKey = file.source.slice(0, -'.json'.length), newKey = sceneKeyMap.get(oldKey)
        if (!newKey) throw Error('DB资源安装：scene记录缺少新key映射：' + oldKey)
        const path = 'scene-images/' + sha256(chatId) + '/' + newKey + '.json'
        if (await profileData.version(path)) throw Error('DB资源安装：目标scene路径已存在，拒绝覆盖：' + path)
        await profileData.writeBytes(path, Buffer.from(JSON.stringify(rewriteResourceValue(file.record, ctx, { key: 'sceneRecord', allowCoordinates: true, sceneContext: true, parent: null }))))
        created.scene.push(path)
      }
      return {
        cardPath, cardSnapshot: bundle.card?.snapshot ?? null, scriptPath: created.scriptPath,
        attachmentMap, sceneKeyMap, worldbookDigestMap,
        rewriteTables: tables => rewriteResourceTables(tables, ctx),
        rollback,
      }
    } catch (error) {
      const failures = []
      try { await rollback() } catch (rollbackError) { failures.push(rollbackError) }
      const aggregate = new AggregateError([error, ...failures], 'DB资源安装失败：已回滚本局自有资源，共享缓存不清理')
      // engine 在 resourceLease 未赋值时用 error.resourceRollback 二次补偿（只重试残项）。
      aggregate.resourceRollback = rollback
      throw aggregate
    }
  }

  return Object.freeze({ capture, validate, install })
}
