// 合成本局夹具；只验DB交换引擎与真实资源租约，不加载SDK/真实profile/业务Agent。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { restoreDatabase, inspectDatabase, decodeDbSave, encodeDbSave } from '../lib/db-save-codec.js'
import { createDbSaveExchange, createDbSaveRegistration } from '../lib/db-save-exchange.js'
import { createDbSaveResourceTransfer } from '../lib/db-save-resource-transfer.js'
const CHAT = 'chat-dummy-source', SESSION = 'session-dummy-source', SIDE = 'session-dummy-background', OTHER = 'chat-dummy-other'
const CARD = { name: '合成人物卡' }
// 与作者 scene-illustration.js L22 同形的纯 hash（sha256 hex）；不 import 作者模块、不执行源码。
const hashHex = value => createHash('sha256').update(value).digest('hex')
const sha256Of = value => hashHex(JSON.stringify(value))
const TEXT_SOURCE = '正文保留 ' + CHAT
// 与作者 computeSceneTarget（pin scene-illustration L48-60）同形的 key：
// hash(JSON.stringify([chat.id, prefix, index, turn, swipeId, sourceDigest]))，此处源档 index=0/prefix=[]。
const SCENE_KEY = hashHex(JSON.stringify([CHAT, [], 0, 1, 0, hashHex(TEXT_SOURCE)]))
const IMAGE_REF = { attachmentId: 'img-source', mediaType: 'image/png', width: 8, height: 8, bytes: 16, name: 'portrait.png' }
const NATIVE_REF = { attachmentId: 'img-native', mediaType: 'image/png', width: 4, height: 4, bytes: 8, name: 'native.png' }
const SCENE_RECORD = { key: SCENE_KEY, turn: 1, swipeId: 0, sourceDigest: hashHex(TEXT_SOURCE), status: 'done', attachment: { ...IMAGE_REF } }
const BOOK_RECORD = { version: 1, entries: [], portrait: { ...IMAGE_REF } }
const BOOK_DIGEST = sha256Of(BOOK_RECORD)
export function archiveFixture({ brokenCard = false, resourceScenario = false } = {}) {
  const snapshot = brokenCard ? { ...CARD, raw: { ...CARD, broken: true } } : { ...CARD, raw: { ...CARD } }
  const fields = { id: CHAT, sessionId: SESSION, mode: resourceScenario ? 'script' : 'story', title: '合成DB档', cardName: CARD.name, cardDefinitionSnapshot: snapshot, rollbackSessionCuts: { 1: { [SIDE]: 1 } } }
  if (resourceScenario) {
    fields.cardPath = 'source/card.png'
    fields.sceneTargets = { 1: { key: SCENE_KEY, turn: 1, swipeId: 0, sourceDigest: hashHex(TEXT_SOURCE) } }
    // 真实合同：mounts 在 workspace 对象内（不是 head 顶层）。
    fields.workspace = { mountedResources: [{ kind: 'card', path: 'source/card.png' }, { kind: 'source', path: 'source/script.txt' }] }
  }
  const tree = resourceScenario
    ? { hp: 3, portrait: { ...IMAGE_REF }, notes: { sessionId: 'session-unrelated', key: 'plain-key', digest: 'deadbeef' } }
    : { hp: 3 }
  return {
    archive_head: [{ id: 1, revision: 7, updated_at: 1 }],
    archive_head_fields: [...Object.entries(fields).map(([key, value], ord) => ({ key, ord, kind: 0, value_json: JSON.stringify(value) })), { key: 'messages', ord: Object.keys(fields).length, kind: 1, value_json: null }, { key: 'timeline', ord: Object.keys(fields).length + 1, kind: 0, value_json: null }],
    archive_messages: [{ message_index: 0, message_json: JSON.stringify({ role: 'assistant', turn: 1, text: TEXT_SOURCE, anchor: SESSION, ...(resourceScenario ? { sceneWorldbook: { version: 1, digest: BOOK_DIGEST } } : {}) }) }],
    archive_timeline_nodes: [{ node_key: '@meta', ord: -1, value_json: JSON.stringify({ branchId: 'branch-dummy', participants: { background: { sessionId: SIDE, boundary: 1 } } }) }],
    variable_snapshots: [{ message_index: 0, swipe_id: 0, turn: 1, slot_count: 1, selected: 1, source: 'chat', mvu_ready: 1, tree_json: JSON.stringify(tree), operations_json: null, uid: 'dummy', created_at: 1 }],
    variable_state: [{ id: 1, tree_json: JSON.stringify(tree), turn: 1, message_index: 0, swipe_id: 0, updated_at: 1 }],
    archive_worldbook_history: [{ book_id: 1, snapshot_json: '{"version":1,"entries":[]}' }]
  }
}
export function nativeFixture(id = SESSION, { attachment = false } = {}) {
  const end = attachment
    ? { turn: 1, text: '保留源标识 ' + SESSION, content: [{ type: 'image', imageAttachmentRef: { ...NATIVE_REF } }] }
    : { turn: 1, text: '保留源标识 ' + SESSION }
  return { meta: [{ key: 'schema_version', value: '1' }], sessions: [{ id, header_json: JSON.stringify({ id, version: 1, createdAt: 1, cwd: '/source', ...(id === SIDE ? { parentSession: SESSION } : {}) }), format_version: 1, created_at: 1, inherited_event_count: 0, event_count: 2 }], events: [{ seq: 0, type: 'turn/start', time: 1, data_json: '{"turn":1}', extra_json: null }, { seq: 1, type: 'turn/end', time: 2, data_json: JSON.stringify(end), extra_json: null }] }
}
export function fixture(t, { failPublish = false, brokenCard = false, onFirstValidate, resourceScenario = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-db-save-fixture-'))
  const archivePath = id => path.join(root, 'chats', id, 'archive.db'), nativePath = id => path.join(root, 'sessions', id + '.db')
  mkdirSync(path.dirname(archivePath(CHAT)), { recursive: true }); mkdirSync(path.join(root, 'sessions'))
  restoreDatabase(archivePath(CHAT), 'archive', archiveFixture({ brokenCard, resourceScenario }))
  restoreDatabase(nativePath(SESSION), 'native', nativeFixture(SESSION, { attachment: resourceScenario })); restoreDatabase(nativePath(SIDE), 'native', nativeFixture(SIDE))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const installs = [], finished = [], removed = [], attached = [], detached = [], published = [], unpublished = [], attempted = [], materials = []
  // 合成资源IO：纯Map/数组，不接真实fileResources/attachments/gameFootprint/作者模块。
  const bytes = new Map(), images = new Map(), worldbooks = new Map(), cardPayloads = []
  let savedImages = 0
  if (resourceScenario) {
    bytes.set('source/card.png', Buffer.from('source-card-bytes'))
    bytes.set('source/script.txt', Buffer.from('剧本正文原文'))
    worldbooks.set(BOOK_DIGEST, Buffer.from(JSON.stringify(BOOK_RECORD)))
    images.set(IMAGE_REF.attachmentId, { data: Buffer.from('source-image-bytes'), mediaType: IMAGE_REF.mediaType })
    images.set(NATIVE_REF.attachmentId, { data: Buffer.from('native-image-bytes'), mediaType: NATIVE_REF.mediaType })
  }
  const profileData = {
    version: async file => (bytes.has(file) ? 1 : null),
    writeBytes: async (file, body) => { bytes.set(file, Buffer.from(body)) },
    remove: async file => { bytes.delete(file) }
  }
  const fileResources = {
    originalCardPayload: async () => null,
    scriptForCard: async () => (resourceScenario ? 'source/script.txt' : null),
    readText: async file => bytes.get(file)?.toString('utf8') ?? '',
    // 真实API：importText 产物在 materials/ 下（不是 cards/）。
    importText: async (kind, { name, text }) => { const file = 'materials/' + name; bytes.set(file, Buffer.from(text)); return file },
    bindMaterial: async (cardPath, scriptPath) => { materials.push({ cardPath, scriptPath }) },
    unbindMaterial: async () => {}, remove: async file => { bytes.delete(file) }
  }
  const attachments = {
    // 与真实API同形：严格返回 {ref, data}；无refs时不会被调用。
    readImage: async ref => { const entry = images.get(ref.attachmentId); return entry ? { ref: { ...ref }, data: Buffer.from(entry.data) } : null },
    saveImage: async ({ data, mediaType }) => {
      savedImages += 1
      const saved = { attachmentId: 'att-new-' + savedImages, mediaType, width: 8, height: 8, bytes: Buffer.from(data).length, name: 'saved-' + savedImages + '.png' }
      images.set(saved.attachmentId, { data: Buffer.from(data), mediaType })
      return saved
    }
  }
  const gameFootprint = {
    readSceneWorldbook: async digest => worldbooks.get(digest) ?? null,
    readSceneFiles: async () => (resourceScenario ? [{ path: SCENE_KEY + '.json', content: Buffer.from(JSON.stringify(SCENE_RECORD)) }] : [])
  }
  // 与作者 computeSceneTarget（pin scene-illustration L48-60）同形的纯 hash 实现：
  // **忽略预存 sceneTargets**，只按 prefix(role+turn+sourceText/text)/index/turn/swipeId/sourceDigest 计算。
  const computeSceneTarget = (chat, turn) => {
    const target = Number(turn)
    const index = (chat.messages || []).findIndex(message => message?.role === 'assistant' && Number(message.turn || (message.greeting ? 1 : 0)) === target)
    if (index < 0) throw Object.assign(new Error('这段正文已不存在'), { code: 'SCENE_TARGET_UNAVAILABLE' })
    const message = chat.messages[index]
    const swipeId = Math.max(0, Number(message.swipeId) || 0)
    const source = String(message.swipes?.[swipeId] ?? message.sourceText ?? message.text ?? '')
    const sourceDigest = hashHex(source)
    const prefix = chat.messages.slice(0, index).map(item => [item.role, item.turn, item.sourceText ?? item.text])
    return { key: hashHex(JSON.stringify([chat.id, prefix, index, target, swipeId, sourceDigest])), turn: target, swipeId, sourceDigest, source }
  }
  const resourceTransfer = createDbSaveResourceTransfer({
    fileResources, profileData, gameFootprint, attachments,
    readChatCard: async cardPath => ({ ...CARD, raw: { ...CARD }, cardPath }),
    importCard: async payload => { cardPayloads.push(payload); const file = 'cards/' + payload.name; bytes.set(file, Buffer.from(payload.text)); return { path: file } },
    computeSceneTarget,
    validateCard: async payload => { const parsed = JSON.parse(payload.text); if (parsed.broken === true) throw Error('合成卡解析失败：payload损坏'); return { raw: parsed, definition: parsed } }
  })
  const registrationState = {
    'index.json': { chats: [{ id: CHAT, title: '合成DB档' }, { id: OTHER, title: '另一局' }] },
    'sessions.json': { [SESSION]: CHAT, 'session-dummy-other': OTHER }
  }
  const registration = createDbSaveRegistration({
    store: { async updateJson(file, updater) { const next = await updater(registrationState[file]); if (next !== undefined) registrationState[file] = next; return next } }
  })
  let pendingValidate = onFirstValidate
  const backend = {
    dbSaveSessionPath: nativePath, dbSaveDrain: async () => {},
    dbSaveValidate: stored => {
      assert.equal(stored.events.length, stored.eventCount)
      if (pendingValidate) { const hook = pendingValidate; pendingValidate = undefined; hook({ archivePath, nativePath, root }) }
      return true
    },
    dbSaveInstall(id, tables, archive) { assert.notEqual(archive, archivePath(CHAT)); restoreDatabase(nativePath(id), 'native', tables); installs.push(id) },
    dbSaveRemove(id) { assert.ok(installs.includes(id)); rmSync(nativePath(id)); removed.push(id) },
    dbSaveFinish(ids) { finished.push([...ids]) }
  }
  const engine = createDbSaveExchange({
    resources: resourceTransfer,
    chatStore: {
      rollbackArchivePath: archivePath, dbSaveArchivePath: archivePath,
      // 与 chat-sqlite-store.dbSaveNewArchivePath 同语义：新ID已有任何实物即拒，否则给出目标路径（不创建）。
      dbSaveNewArchivePath: id => {
        const target = archivePath(id)
        if (existsSync(target) || existsSync(path.dirname(target))) throw Error('DB导入Chat新身份已存在，拒绝覆盖')
        return target
      },
      remove: async id => { assert.notEqual(id, CHAT); rmSync(archivePath(id)) }
    },
    chatForSession: async id => id === SESSION ? { id: CHAT, sessionId: SESSION } : null,
    readChat: async id => inspectDatabase(archivePath(id), 'archive').head,
    persistence: () => backend, sessions: { get: () => undefined, flush: async () => {} }, agents: { get: () => undefined },
    assertForkable: () => {}, ownsSession: async () => true, whenIdle: async () => {},
    publish: async chat => {
      registrationState['index.json'].chats.push({ id: chat.id, title: chat.title })
      registrationState['sessions.json'][chat.sessionId] = chat.id
      attempted.push({ chatId: chat.id, sessionId: chat.sessionId })
      if (failPublish) throw Error('合成发布失败')
      published.push(chat)
    },
    unpublish: async identity => { unpublished.push(identity); await registration.discard(identity) },
    attach: async id => attached.push(id), detach: async id => detached.push(id), dataRoot: root
  })
  return { engine, root, archivePath, nativePath, installs, finished, removed, attached, detached, published, unpublished, attempted, registrationState, bytes, images, worldbooks, materials, cardPayloads }
}
test('DB自含正文包新双ID导入源不变', async t => {
  const f = fixture(t), before = readFileSync(f.archivePath(CHAT)), nativeBefore = readFileSync(f.nativePath(SESSION))
  const exported = await f.engine.exportGameSave(SESSION)
  assert.ok(exported.bytes > 0)
  const result = await f.engine.importGameSave({ fileB64: exported.base64 })
  assert.notEqual(result.chatId, CHAT); assert.notEqual(result.sessionId, SESSION)
  const imported = inspectDatabase(f.archivePath(result.chatId), 'archive')
  assert.equal(imported.head.sessionId, result.sessionId); assert.equal(imported.head.messages[0].text, TEXT_SOURCE)
  assert.equal(imported.tables.variable_state[0].tree_json, '{"hp":3}'); assert.equal(imported.tables.archive_worldbook_history.length, 1)
  assert.equal(f.installs.length, 2); assert.equal(f.published.length, 1)
  // 真实资源租约：新卡按新身份落盘、卡路径重绑、finish 一次传全集合（数组相等，不逐项）
  assert.deepEqual(f.finished, [f.installs])
  assert.equal(f.cardPayloads.length, 1)
  const cardPath = imported.head.cardPath
  assert.ok(cardPath && cardPath.includes(result.chatId), '卡路径未按新身份重绑：' + cardPath)
  assert.ok(f.bytes.has(cardPath), '新卡未写入自有资源')
  assert.deepEqual(JSON.parse(f.bytes.get(cardPath).toString('utf8')), { ...CARD })
  assert.deepEqual(readFileSync(f.archivePath(CHAT)), before); assert.deepEqual(readFileSync(f.nativePath(SESSION)), nativeBefore)
  const side = f.installs.find(id => id !== result.sessionId)
  assert.deepEqual(imported.head.rollbackSessionCuts, { 1: { [side]: 1 } })
  assert.equal(Object.hasOwn(imported.head.rollbackSessionCuts[1], SIDE), false)
  assert.equal(imported.head.timeline.participants.background.sessionId, side)
  assert.equal(inspectDatabase(f.nativePath(side), 'native').head.parentSession, result.sessionId)
})
test('DB剧本配图附件组合SQL往返闭包与新身份', async t => {
  const f = fixture(t, { resourceScenario: true })
  const before = readFileSync(f.archivePath(CHAT)), nativeBefore = readFileSync(f.nativePath(SESSION))
  const bookBefore = Buffer.from(f.worldbooks.get(BOOK_DIGEST))
  const exported = await f.engine.exportGameSave(SESSION)
  const decoded = decodeDbSave(Buffer.from(exported.base64, 'base64'))
  // 清单只带本局引用：无 deletedVersions / 诊断 / agent 配置，sessions 只本局闭包
  assert.deepEqual(decoded.manifest.sessions, [SESSION, SIDE])
  const manifestText = JSON.stringify(decoded.manifest)
  for (const forbidden of ['deletedVersions', 'diagnostic', 'agent.json', 'providerTask']) assert.equal(manifestText.includes(forbidden), false, 'manifest 含禁止字段：' + forbidden)
  // 只携结构 attachment 与内置 scene，不含 plugin-media 第三方业务 registration 资源
  assert.equal(decoded.manifest.portable.pluginMedia, false, 'pluginMedia 不能承诺第三方闭包')
  assert.deepEqual(decoded.resources.map(item => item.path).sort(), ['books/0000.json', 'card.json', 'images/0000.bin', 'images/0001.bin', 'index.json', 'scene/0000.json', 'script.json'])
  // 导出后删掉源世界书：目标只能从包内资源重建
  f.worldbooks.delete(BOOK_DIGEST)
  const result = await f.engine.importGameSave({ fileB64: exported.base64 })
  assert.notEqual(result.chatId, CHAT); assert.notEqual(result.sessionId, SESSION)
  assert.equal(f.installs.length, 2)
  assert.equal(new Set(f.installs).size, 2)
  for (const id of f.installs) assert.notEqual(id, SESSION)
  const imported = inspectDatabase(f.archivePath(result.chatId), 'archive')
  // ① 卡与剧本：目标卡=新路径、剧本按新身份挂载
  assert.ok(imported.head.cardPath.includes(result.chatId))
  assert.equal(f.cardPayloads.length, 1)
  assert.equal(f.materials.length, 1)
  assert.equal(f.materials[0].cardPath, imported.head.cardPath)
  assert.ok(f.materials[0].scriptPath.includes(result.chatId))
  assert.equal(f.bytes.get(f.materials[0].scriptPath).toString('utf8'), '剧本正文原文')
  // ② workspace.mountedResources（真实合同结构）：card 与 source 挂载都按新身份重绑
  assert.ok(f.materials[0].scriptPath.startsWith('materials/'), '剧本产物应在 materials/：' + f.materials[0].scriptPath)
  assert.deepEqual(imported.head.workspace.mountedResources, [{ kind: 'card', path: imported.head.cardPath }, { kind: 'source', path: f.materials[0].scriptPath }])
  // ③ typed image refs 全部换新：Chat 内不得含 native-only 引用；目标闭包=archive+native
  const targetNative = f.installs.map(id => inspectDatabase(f.nativePath(id), 'native'))
  const targetText = JSON.stringify(imported) + JSON.stringify(targetNative.map(item => item.tables))
  assert.equal(JSON.stringify(imported).includes(NATIVE_REF.attachmentId), false, 'native-only 引用不得出现在 Chat')
  assert.equal(targetText.includes(IMAGE_REF.attachmentId), false, '目标仍含源图片引用')
  assert.equal(targetText.includes(NATIVE_REF.attachmentId), false, '目标仍含源原生引用')
  const savedIds = [...f.images.keys()].filter(id => id.startsWith('att-new-'))
  assert.equal(savedIds.length, 2)
  for (const id of savedIds) assert.ok(targetText.includes(id), '新ref未落到目标：' + id)
  // ④ 正文/anchor 与原生事件文本原字符串不改；timeline/cuts 用新SID
  assert.equal(imported.head.messages[0].text, TEXT_SOURCE)
  assert.equal(imported.head.messages[0].anchor, SESSION)
  const side = f.installs.find(id => id !== result.sessionId)
  assert.deepEqual(imported.head.rollbackSessionCuts, { 1: { [side]: 1 } })
  assert.equal(imported.head.timeline.participants.background.sessionId, side)
  const nativeTarget = inspectDatabase(f.nativePath(result.sessionId), 'native')
  const endEvent = JSON.parse(nativeTarget.tables.events[1].data_json)
  assert.equal(endEvent.text, '保留源标识 ' + SESSION)
  assert.notEqual(endEvent.content[0].imageAttachmentRef.attachmentId, NATIVE_REF.attachmentId)
  assert.ok(savedIds.includes(endEvent.content[0].imageAttachmentRef.attachmentId))
  assert.equal(nativeTarget.head.parentSession ?? null, null)
  // ⑤ scene 目标按新 key 写入、变量树 image ref 换新；普通 sessionId/key/digest 变量保源值
  const scenePath = [...f.bytes.keys()].find(file => file.startsWith('scene-images/' + createHash('sha256').update(result.chatId).digest('hex') + '/'))
  assert.ok(scenePath, 'scene 目标未写入')
  const sceneRecord = JSON.parse(f.bytes.get(scenePath).toString('utf8'))
  assert.notEqual(sceneRecord.key, SCENE_KEY)
  assert.equal(scenePath.endsWith(sceneRecord.key + '.json'), true)
  assert.ok(savedIds.includes(sceneRecord.attachment.attachmentId))
  const tree = JSON.parse(imported.tables.variable_state[0].tree_json)
  assert.ok(savedIds.includes(tree.portrait.attachmentId))
  assert.deepEqual(tree.notes, { sessionId: 'session-unrelated', key: 'plain-key', digest: 'deadbeef' })
  // ⑥ 世界书按（可能重绑后的）digest 写入目标，源世界书字节未变
  const bookPath = [...f.bytes.keys()].find(file => file.startsWith('scene-images/worldbooks/'))
  assert.ok(bookPath, '目标世界书未写入')
  const bookDigest = path.basename(bookPath, '.json')
  assert.equal(sha256Of(JSON.parse(f.bytes.get(bookPath).toString('utf8'))), bookDigest)
  assert.deepEqual(f.worldbooks.has(BOOK_DIGEST), false)
  assert.deepEqual(bookBefore, Buffer.from(JSON.stringify(BOOK_RECORD)))
  // ⑦ 源DB/原生字节原样
  assert.deepEqual(readFileSync(f.archivePath(CHAT)), before)
  assert.deepEqual(readFileSync(f.nativePath(SESSION)), nativeBefore)
})
test('DB包清单身份错误在创建目标前拒绝', async t => {
  const f = fixture(t), exported = await f.engine.exportGameSave(SESSION), decoded = decodeDbSave(Buffer.from(exported.base64, 'base64'))
  decoded.manifest.source.chatId = 'chat-dummy-wrong'
  await assert.rejects(f.engine.importGameSave({ fileB64: encodeDbSave(decoded).toString('base64') }), /清单与Chat身份/)
  assert.equal(f.installs.length, 0); assert.equal(f.published.length, 0)
})
test('DB发布失败仅回收本次新SQL目标', async t => {
  const f = fixture(t, { failPublish: true }), original = readFileSync(f.archivePath(CHAT))
  const exported = await f.engine.exportGameSave(SESSION)
  await assert.rejects(f.engine.importGameSave({ fileB64: exported.base64 }), /合成发布失败/)
  assert.deepEqual(f.removed, f.installs); assert.equal(f.detached.length, 1)
  assert.deepEqual(f.finished, [], '发布失败不得解除原生目标归属')
  for (const id of f.installs) assert.equal(existsSync(f.nativePath(id)), false)
  assert.deepEqual(readFileSync(f.archivePath(CHAT)), original)
  // 资源租约回滚：本次新卡撤除；共享缓存（图片/世界书）不删
  assert.equal(f.cardPayloads.length, 1)
  assert.deepEqual([...f.bytes.keys()].filter(file => file.includes('db-')), [], '本次新卡未回滚')
  assert.equal(f.images.size, 0)
  // 登记补偿：本次新身份不残留，源局与另一局 index/link 保留
  assert.equal(f.attempted.length, 1); assert.equal(f.unpublished.length, 1)
  assert.deepEqual(f.registrationState['index.json'].chats.map(row => row.id), [CHAT, OTHER])
  assert.deepEqual(f.registrationState['sessions.json'], { [SESSION]: CHAT, 'session-dummy-other': OTHER })
  assert.equal(f.registrationState['index.json'].chats.some(row => row.id === f.attempted[0].chatId), false)
  assert.equal(Object.values(f.registrationState['sessions.json']).includes(f.attempted[0].chatId), false)
})
test('DB资源损坏在新身份前拒绝', async t => {
  const f = fixture(t), exported = await f.engine.exportGameSave(SESSION), before = readFileSync(f.archivePath(CHAT))
  // 源档始终valid：导出正常后把损坏注入**包内** card.json payload（snapshot 与 SQL 保持一致），重打包同 manifest 字段。
  const decoded = decodeDbSave(Buffer.from(exported.base64, 'base64'))
  const card = decoded.resources.find(item => item.path === 'card.json')
  assert.ok(card, '包内缺少 card.json')
  const value = JSON.parse(card.data.toString('utf8'))
  assert.ok(value.snapshot && value.payload, '包内卡资源结构不符')
  card.data = Buffer.from(JSON.stringify({ ...value, payload: { ...value.payload, text: '{"broken":true}' } }), 'utf8')
  const broken = encodeDbSave({ manifest: decoded.manifest, archive: decoded.archive, sessions: decoded.sessions, resources: decoded.resources })
  await assert.rejects(f.engine.importGameSave({ fileB64: broken.toString('base64') }), /合成卡解析失败/)
  assert.equal(f.installs.length, 0); assert.equal(f.published.length, 0)
  assert.deepEqual([...f.bytes.keys()], [], '资源校验失败不得写任何自有资源')
  assert.equal(f.images.size, 0)
  assert.deepEqual(readFileSync(f.archivePath(CHAT)), before)
})
test('DB导出发现捕获期间写入拒绝发布', async t => {
  const f = fixture(t, { onFirstValidate: ({ nativePath }) => {
    // 首个原生快照已拍下之后，另一连接提交；观察连接须发现并拒绝发布。
    const writer = new DatabaseSync(nativePath(SESSION))
    try {
      writer.prepare('INSERT INTO events VALUES(2,?,?,?,NULL)').run('session/title', 3, '{"title":"捕获期间并发提交"}')
      writer.exec('UPDATE sessions SET event_count=3')
    } finally { writer.close() }
  } })
  const setup = new DatabaseSync(f.nativePath(SESSION)); setup.exec('PRAGMA journal_mode=WAL'); setup.close()
  await assert.rejects(f.engine.exportGameSave(SESSION), /捕获期间源库/)
  const source = inspectDatabase(f.nativePath(SESSION), 'native')
  assert.equal(source.tables.events.length, 3)
  assert.equal(source.tables.events[2].data_json, '{"title":"捕获期间并发提交"}')
  assert.equal(source.tables.sessions[0].event_count, 3)
  assert.equal(f.published.length, 0); assert.equal(f.installs.length, 0)
  const again = await f.engine.exportGameSave(SESSION)
  assert.ok(again.bytes > 0)
})
test('DB导出WAL与本局会话闭包', async t => {
  const f = fixture(t), db = new DatabaseSync(f.nativePath(SESSION)); db.exec('PRAGMA journal_mode=WAL')
  try {
    db.prepare('INSERT INTO events VALUES(2,?,?,?,NULL)').run('session/title', 3, '{"title":"WAL中新标题"}')
    db.exec('UPDATE sessions SET event_count=3')
    const exported = decodeDbSave(Buffer.from((await f.engine.exportGameSave(SESSION)).base64, 'base64'))
    assert.deepEqual(exported.manifest.sessions, [SESSION, SIDE])
    const target = path.join(f.root, 'captured.db'); const { writeFileSync } = await import('node:fs'); writeFileSync(target, exported.sessions[0].data)
    const native = inspectDatabase(target, 'native')
    assert.equal(native.tables.events.length, 3); assert.equal(native.tables.events[2].data_json, '{"title":"WAL中新标题"}')
  } finally { db.close() }
})
