// 只验资源租约 capture/validate/install：全 fake deps 纯合成 array/Map，不加载SDK、不做真实IO、不跑真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDbSaveResourceTransfer, allDbSaveResourceValues } from '../lib/db-save-resource-transfer.js'

// 官方完整纯模块（b741 lib/domain/card-preparation.js）字节级 fixture；唯一 import 是纯工具 inspectCardExtensions，
// 测试内经 data URL 导入并把该 import 重写为本地 stub（不改 fixture 原字节 → SHA 可验；create/project/present 不依赖它）。
const AUTHOR_SOURCE_SHA256 = 'b2e57daf72b6dc3450e2560ad560fa470e915040c5bac6043501d24ac1235117'
const authorSource = readFileSync(new URL('./fixtures/author-card-preparation-b741.js', import.meta.url), 'utf8')
assert.equal(createHash('sha256').update(authorSource, 'utf8').digest('hex'), AUTHOR_SOURCE_SHA256)
const authorModuleUrl = 'data:text/javascript;base64,' + Buffer.from(
  authorSource.replace("import { inspectCardExtensions } from './card-extension-reading.js'", 'const inspectCardExtensions = () => ({})'),
  'utf8').toString('base64')
const { createCardPreparation } = await import(authorModuleUrl)
const authorCardPreparation = createCardPreparation({ id: () => 'fixture-card', now: () => 0 })   // 纯静态，无 SDK/真实文件

const sha256 = value => createHash('sha256').update(String(value)).digest('hex')
const sha256Of = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const keyFor = (chatId, turn, text) => sha256(chatId + ':' + turn + ':' + text)
const ref = (attachmentId, mediaType = 'image/png', extra = {}) => ({ attachmentId, mediaType, width: 8, height: 8, bytes: 3, name: 'a.png', ...extra })

function fixture(overrides = {}) {
  const bookDoc = { entries: [] }
  const bookDigest = sha256Of(bookDoc)
  const book2Doc = { entries: [{ text: '第二本' }] }
  const book2Digest = sha256Of(book2Doc)
  const k1 = keyFor('chat-a', 1, '第一段正文')
  const calls = { writeBytes: [], remove: [], saveImage: [], removeResource: [], unbind: [], importText: [], bind: [], readChatCard: [], importCard: [] }
  const state = { bookBytes: Buffer.from(JSON.stringify(bookDoc, null, 2)), book2Bytes: Buffer.from(JSON.stringify(book2Doc, null, 2)), versions: {}, sceneWrites: 0, failSceneAt: 0 }
  const chat = {
    id: 'chat-a', sessionId: 'session-a', mode: 'script', cardPath: 'cards/卡.json', cardName: '卡',
    cardDefinitionSnapshot: { name: '卡' },
    workspace: { mountedResources: [{ kind: 'card', path: 'cards/卡.json' }, { kind: 'source', path: 'materials/剧本.txt' }] },
    messages: [
      { role: 'assistant', turn: 1, text: '第一段正文', sceneWorldbook: { version: 1, digest: bookDigest, bodyDigests: [sha256('第一段正文')] } },
      { role: 'assistant', turn: 2, text: '第二段正文' },
    ],
  }
  // raw scene 记录：带审计/已删字段（必须不进闭包、但 raw 字节参与窗口比对）
  const sceneRecord = {
    key: k1, turn: 1, status: 'succeeded',
    diagnostics: { refs: [ref('att-audit')] },
    deletedVersions: [{ attachment: ref('att-gone') }],
    versions: [{ id: 'v1', attachment: ref('att-1'), prompt: '海边', plan: { anchor: '海', worldbook: { version: 1, digest: book2Digest } } }],
  }
  const deps = {
    fileResources: {
      scriptForCard: async () => 'materials/剧本.txt',
      readText: async () => '第一幕',
      originalCardPayload: async () => ({ kind: 'text', name: '卡.json', text: '{"name":"卡"}' }),
      importText: async (kind, payload) => { calls.importText.push([kind, payload.name]); return 'materials/' + payload.name },
      bindMaterial: async (cardPath, materialPath) => { calls.bind.push([cardPath, materialPath]); return materialPath },
      remove: async path => { calls.removeResource.push(path) },
      unbindMaterial: async path => { calls.unbind.push(path) },
    },
    profileData: {
      writeBytes: async (path, data) => {
        if (path.startsWith('scene-images/') && !path.includes('/worldbooks/')) { state.sceneWrites += 1; if (state.failSceneAt === state.sceneWrites) throw Error('scene写入失败') }
        calls.writeBytes.push([path, Buffer.from(data).toString('utf8')])
      },
      remove: async path => { calls.remove.push(path) },
      version: async path => state.versions[path] || '',
    },
    gameFootprint: {
      readSceneFiles: async () => [{ path: k1 + '.json', content: Buffer.from(JSON.stringify(sceneRecord)) }],
      readSceneWorldbook: async digest => (digest === book2Digest ? state.book2Bytes : state.bookBytes),
    },
    attachments: {
      saveImage: async input => { calls.saveImage.push(input); return { attachmentId: 'sha256:' + sha256(Buffer.from(input.data).toString('base64')), mediaType: input.mediaType, width: 8, height: 8, bytes: input.data.length } },
      readImage: async () => ({ ref: ref('att-1'), data: new Uint8Array([1, 2, 3]) }),
    },
    readChatCard: async chatArg => { calls.readChatCard.push(chatArg); return { name: '卡', pic: { attachment: ref('att-1') } } },
    importCard: async payload => { calls.importCard.push(payload); return { path: 'cards/' + payload.name } },
    computeSceneTarget: (target, turn) => ({ key: keyFor(target.id, turn, String((target.messages || []).find(message => message.turn === turn)?.text || '')) }),
    validateCard: async payload => {   // 真实作者纯 API：create→present({as:'raw'})/project；payload 原样（作者 png 契约={kind,name,b64=卡JSON base64,fileB64=整PNG base64}，无 fallback）
      const card = authorCardPreparation.create({ kind: 'import', payload })
      return { raw: authorCardPreparation.present({ card, as: 'raw' }), definition: authorCardPreparation.project(card) }
    },
  }
  Object.assign(deps, overrides)
  return { deps, chat, calls, state, bookDigest, book2Digest, sceneRecord, k1, tables: { archive_messages: [{ message_json: JSON.stringify({ role: 'assistant', text: '第一段正文', anchor: '海', key: k1 }) }] } }
}

test('DB资源传输窗口拒绝纯sidecar变化', async () => {
  const { deps, chat, calls, state, tables, bookDigest, book2Digest, sceneRecord, k1 } = fixture()
  const transfer = createDbSaveResourceTransfer(deps)
  const window = await transfer.capture({ chat, tables, nativeEvents: [{ type: 'turn/end', data: { content: [ref('att-1')] } }] })
  assert.equal(window.files.length > 0, true)
  assert.deepEqual(window.books.map(book => book.digest).sort(), [bookDigest, book2Digest].sort())   // chat绑定 + sceneRecord内第二本
  assert.deepEqual(window.attachments.map(item => item.attachmentId), ['att-1'])                    // 审计/已删字段内的 image ref 不打包
  assert.equal(await window.assertStable(), true)
  const originalBook = state.bookBytes
  // 纯sidecar字节变化但内容/digest仍合法（仅空白不同）→ 必须被窗口比对拒
  state.bookBytes = Buffer.from(JSON.stringify(JSON.parse(originalBook.toString('utf8')), null, 4))
  await assert.rejects(() => window.assertStable(), /已变化/)
  state.bookBytes = originalBook
  const originalBook2 = state.book2Bytes
  state.book2Bytes = Buffer.from(JSON.stringify(JSON.parse(originalBook2.toString('utf8')), null, 4))
  await assert.rejects(() => window.assertStable(), /已变化/)
  state.book2Bytes = originalBook2   // 复原，后面的 raw-scene 用例才只命中 scene 原始字节变化
  // raw scene 审计字段字节变化（sanitize 会掩盖）→ 仍按 raw 字节拒
  const originalScene = deps.gameFootprint.readSceneFiles
  deps.gameFootprint.readSceneFiles = async () => {
    const files = await originalScene()
    const record = JSON.parse(files[0].content.toString('utf8'))
    record.diagnostics = { refs: [ref('att-audit', 'image/png', { width: 4 })] }
    return [{ path: files[0].path, content: Buffer.from(JSON.stringify(record)) }]
  }
  await assert.rejects(() => window.assertStable(), /scene原始字节已变化/)
  deps.gameFootprint.readSceneFiles = originalScene
  // 源直读稳定：剧本绑定/内容、scene 集合/新出现/缺失、图 bytes/ref 协议、fallback 卡快照深等
  const scriptFor = deps.fileResources.scriptForCard, readText = deps.fileResources.readText, readScene = deps.gameFootprint.readSceneFiles, readImage = deps.attachments.readImage, readCard = deps.readChatCard, readBook0 = deps.gameFootprint.readSceneWorldbook
  deps.fileResources.scriptForCard = async () => 'materials/别的剧本.txt'
  await assert.rejects(() => window.assertStable(), /剧本绑定已变化/)
  deps.fileResources.scriptForCard = scriptFor
  deps.fileResources.readText = async () => '第二幕'
  await assert.rejects(() => window.assertStable(), /剧本内容已变化/)
  deps.fileResources.readText = readText
  deps.gameFootprint.readSceneFiles = async () => []
  await assert.rejects(() => window.assertStable(), /出现或缺失/)
  deps.gameFootprint.readSceneFiles = async () => {
    const k2 = keyFor('chat-a', 2, '第二段正文')
    return [...await readScene(), { path: k2 + '.json', content: Buffer.from(JSON.stringify({ key: k2, turn: 2, status: 'succeeded', versions: [] })) }]
  }
  await assert.rejects(() => window.assertStable(), /出现或缺失/)
  deps.gameFootprint.readSceneFiles = readScene
  deps.attachments.readImage = async () => ({ ref: ref('att-1'), data: new Uint8Array([9, 9, 9]) })
  await assert.rejects(() => window.assertStable(), /附件字节已变化/)
  deps.attachments.readImage = async () => ({ ref: ref('att-1', 'image/png', { width: 4 }), data: new Uint8Array([1, 2, 3]) })
  await assert.rejects(() => window.assertStable(), /附件引用/)
  deps.attachments.readImage = async () => ({ ref: ref('att-1', 'image/png', { name: 'b.png' }), data: new Uint8Array([1, 2, 3]) })
  await assert.rejects(() => window.assertStable(), /附件元数据已变化/)   // 仅 name 变化也拒（full returned metadata 稳定窗口）
  deps.attachments.readImage = readImage
  // provider 借出共享 Buffer 原地 mutate：捕获 own copy 后必须仍拒（same-alias 不能漏）；fixture 用自己初拷贝精确复原
  const imgBytes = Buffer.from([1, 2, 3])
  deps.attachments.readImage = async () => ({ ref: ref('att-1'), data: imgBytes })
  const imgWindow = await createDbSaveResourceTransfer(deps).capture({ chat, tables, nativeEvents: [] })
  imgBytes[0] = 9
  await assert.rejects(() => imgWindow.assertStable(), /附件字节已变化/)
  deps.attachments.readImage = readImage
  const sceneBytes = Buffer.from(JSON.stringify(sceneRecord))
  deps.gameFootprint.readSceneFiles = async () => [{ path: k1 + '.json', content: sceneBytes }]
  const sceneWindow = await createDbSaveResourceTransfer(deps).capture({ chat, tables, nativeEvents: [] })
  sceneBytes[0] = 0x20
  await assert.rejects(() => sceneWindow.assertStable(), /scene原始字节已变化/)
  deps.gameFootprint.readSceneFiles = readScene
  const bookBytes = Buffer.from(state.bookBytes)
  deps.gameFootprint.readSceneWorldbook = async digest => (digest === book2Digest ? state.book2Bytes : bookBytes)
  const bookWindow = await createDbSaveResourceTransfer(deps).capture({ chat, tables, nativeEvents: [] })
  bookBytes[1] = 0x20
  await assert.rejects(() => bookWindow.assertStable(), /世界书原始字节已变化/)
  deps.gameFootprint.readSceneWorldbook = readBook0
  const bareRaw = { ...chat, cardDefinitionSnapshot: undefined }
  deps.readChatCard = async () => ({ name: '卡', raw: { name: '卡' } })
  const rawWindow = await createDbSaveResourceTransfer(deps).capture({ chat: bareRaw, tables, nativeEvents: [] })
  deps.readChatCard = async () => ({ name: '变了的卡', raw: { name: '卡' } })
  await assert.rejects(() => rawWindow.assertStable(), /人物卡快照已变化/)
  deps.readChatCard = readCard
  // readChatCard 真实签名是 chat 对象（不是 cardPath）
  const bare = { ...chat, cardDefinitionSnapshot: undefined }
  await createDbSaveResourceTransfer(deps).capture({ chat: bare, tables, nativeEvents: [] })
  assert.equal(calls.readChatCard[0].id, 'chat-a')
  assert.equal(calls.readChatCard[0].cardPath, 'cards/卡.json')
  // readImage 返回与请求 ref 冲突的 blob ref（width 不同）必须识别，不静默用错字节
  deps.attachments.readImage = async () => ({ ref: ref('att-1', 'image/png', { width: 4 }), data: new Uint8Array([1, 2, 3]) })
  await assert.rejects(() => createDbSaveResourceTransfer(deps).capture({ chat, tables, nativeEvents: [] }), /附件引用冲突/)
})

test('DB资源导入租约失败只撤新资源不删共享缓存', async () => {
  const { deps, chat, calls, state, tables, k1 } = fixture()
  const k2 = keyFor('chat-a', 2, '第二段正文')
  deps.gameFootprint.readSceneFiles = async () => [
    { path: k1 + '.json', content: Buffer.from(JSON.stringify({ key: k1, turn: 1, status: 'succeeded', versions: [{ id: 'v1', attachment: ref('att-1'), prompt: '海边', plan: { anchor: '海' } }] })) },
    { path: k2 + '.json', content: Buffer.from(JSON.stringify({ key: k2, turn: 2, status: 'succeeded', versions: [] })) },
  ]
  let sceneRemoveFails = 1
  deps.profileData.remove = async path => { calls.remove.push(path); if (sceneRemoveFails > 0) { sceneRemoveFails -= 1; throw Error('scene回收失败') } }
  state.failSceneAt = 2   // 只让第2个 scene 写入失败，不波及共享书写入
  const transfer = createDbSaveResourceTransfer(deps)
  const window = await transfer.capture({ chat, tables, nativeEvents: [] })
  const bundle = await transfer.validate({ files: window.files, chat, tables, nativeEvents: [] })
  let caught
  try { await transfer.install(bundle, chat, { chatId: 'chat-new', sessionId: 'session-new' }) } catch (error) { caught = error }
  assert.equal(caught instanceof AggregateError, true)
  assert.equal(typeof caught.resourceRollback, 'function')
  assert.equal(calls.saveImage.length, 1)                     // 共享图缓存：只写不删
  const scenePaths = calls.writeBytes.filter(([path]) => path.startsWith('scene-images/') && !path.includes('/worldbooks/')).map(([path]) => path)
  assert.deepEqual(scenePaths, ['scene-images/' + sha256('chat-new') + '/' + keyFor('chat-new', 1, '第一段正文') + '.json'])
  assert.deepEqual(calls.unbind, ['cards/db-chat-new.json'])
  assert.deepEqual(calls.removeResource, ['materials/db-chat-new.txt', 'cards/db-chat-new.json'])
  assert.deepEqual(calls.remove, scenePaths)                  // 第一次反向回收 scene 失败 → 残项保留
  assert.equal(calls.remove.some(path => path.includes('/worldbooks/')), false)   // 共享书/图永不进回滚
  assert.deepEqual(await caught.resourceRollback(), true)     // 第二次只重试残项
  assert.deepEqual(calls.remove, [...scenePaths, ...scenePaths])
  assert.deepEqual(calls.removeResource, ['materials/db-chat-new.txt', 'cards/db-chat-new.json'])   // card/script 成功项不重复
})

test('DB资源租约重绑本局图书卡剧本保正文', async () => {
  const { deps, chat, calls, state, bookDigest, book2Digest, tables, k1 } = fixture()
  deps.attachments.saveImage = async input => ({ attachmentId: 'sha256:new', mediaType: input.mediaType, width: 8, height: 8, bytes: input.data.length })
  const sourceBook = deps.gameFootprint.readSceneWorldbook                                             // 源侧：两本都在
  const targetBook = async digest => (digest === book2Digest ? null : state.bookBytes)                  // 目标侧：源有 book2，目标没有
  const transfer = createDbSaveResourceTransfer(deps)
  const window = await transfer.capture({ chat, tables, nativeEvents: [] })
  assert.equal(window.script.text, '第一幕')
  assert.equal(window.cardPayload.kind, 'text')
  assert.equal(allDbSaveResourceValues(tables).length, 1)
  const bundle = await transfer.validate({ files: window.files, chat, tables, nativeEvents: [] })
  await assert.rejects(() => transfer.validate({ files: window.files, chat: { ...chat, cardDefinitionSnapshot: { name: '别的卡' } }, tables, nativeEvents: [] }), /不一致/)
  deps.gameFootprint.readSceneWorldbook = targetBook        // 仅安装期模拟跨机器（capture/validate 已用源侧）
  // 目标scene路径已存在（version truthy）→ 拒绝覆盖；解除预置后正常
  const newScenePath = 'scene-images/' + sha256('chat-new') + '/' + keyFor('chat-new', 1, '第一段正文') + '.json'
  state.versions[newScenePath] = '"1-1"'
  await assert.rejects(() => createDbSaveResourceTransfer(deps).install(bundle, chat, { chatId: 'chat-new', sessionId: 'session-new' }), AggregateError)
  assert.equal(calls.writeBytes.some(([path]) => path === newScenePath), false)
  delete state.versions[newScenePath]
  const lease = await transfer.install(bundle, chat, { chatId: 'chat-new', sessionId: 'session-new' })
  assert.equal(lease.cardPath, 'cards/db-chat-new.json')
  assert.equal(lease.scriptPath, 'materials/db-chat-new.txt')
  assert.deepEqual(calls.bind.at(-1), ['cards/db-chat-new.json', 'materials/db-chat-new.txt'])
  assert.equal(lease.attachmentMap.get('att-1').attachmentId, 'sha256:new')
  assert.equal(lease.sceneKeyMap.get(k1), keyFor('chat-new', 1, '第一段正文'))
  const sceneWrite = calls.writeBytes.find(([path]) => path.startsWith('scene-images/') && !path.includes('/worldbooks/'))
  assert.equal(sceneWrite[0], newScenePath)
  const stored = JSON.parse(sceneWrite[1])
  assert.equal(stored.key, keyFor('chat-new', 1, '第一段正文'))
  assert.equal(stored.versions[0].attachment.attachmentId, 'sha256:new')
  assert.equal('name' in stored.versions[0].attachment, false)
  assert.equal(stored.versions[0].plan.anchor, '海')
  assert.equal(stored.versions[0].prompt, '海边')
  assert.equal(stored.diagnostics, undefined)                 // 审计字段不入包
  // 跨机器未变书：目标缺失也必须写，且写原始字节（不重格式）；未变 → digestMap 不映射
  const bookWrite = calls.writeBytes.find(([path]) => path.includes('/worldbooks/'))
  assert.equal(bookWrite[0], 'scene-images/worldbooks/' + book2Digest + '.json')
  assert.equal(bookWrite[1], state.book2Bytes.toString('utf8'))
  assert.deepEqual([...lease.worldbookDigestMap.keys()], [])
  // 资源层重绑：坐标只在明确上下文生效；tree/正文/变量 与未变row 保原byte，只有 image ref 换新
  const treeRow = { key: 'tree', tree_json: JSON.stringify({ key: k1, digest: bookDigest, sessionId: '源', attachment: ref('att-1') }) }
  const messageRow = { message_json: JSON.stringify({ role: 'assistant', text: '第一段正文', anchor: '海', key: k1 }) }
  const contentRow = { message_json: JSON.stringify({ role: 'assistant', content: JSON.stringify({ attachmentId: 'att-1', mediaType: 'image/png', sessionId: '源' }) }) }
  const sceneTargetsRow = { key: 'sceneTargets', value_json: JSON.stringify({ 1: { key: k1, turn: 1 } }) }
  const workspaceRow = { key: 'workspace', value_json: JSON.stringify({ mountedResources: [{ kind: 'card', path: 'cards/卡.json' }, { kind: 'source', path: 'materials/剧本.txt' }, { kind: 'worldbook', path: 'worldbooks/别的.json' }] }) }
  const unchangedRow = { message_json: JSON.stringify({ text: '无变化' }) }
  const rewritten = lease.rewriteTables({ archive_messages: [messageRow, contentRow, unchangedRow], archive_head_fields: [sceneTargetsRow, workspaceRow], variables: [treeRow], sessions: [{ id: 'session-a' }] })
  const tree = JSON.parse(rewritten.variables[0].tree_json)
  assert.equal(tree.key, k1)                                   // tree 内 key 不做坐标映射
  assert.equal(tree.digest, bookDigest)                        // 非 version===1 对象的 digest 不映射
  assert.equal(tree.sessionId, '源')
  assert.equal(tree.attachment.attachmentId, 'sha256:new')     // 保护子树内 image ref 仍换新
  assert.equal(rewritten.archive_messages[0].message_json, messageRow.message_json)
  assert.equal(rewritten.archive_messages[1].message_json, contentRow.message_json)   // 正文JSON字符串永不 parse
  assert.equal(rewritten.archive_messages[2].message_json, unchangedRow.message_json)
  assert.equal(rewritten.archive_head_fields[0].value_json, JSON.stringify({ 1: { key: keyFor('chat-new', 1, '第一段正文'), turn: 1 } }))
  assert.deepEqual(JSON.parse(rewritten.archive_head_fields[1].value_json).mountedResources, [
    { kind: 'card', path: 'cards/db-chat-new.json' },
    { kind: 'source', path: 'materials/db-chat-new.txt' },
    { kind: 'worldbook', path: 'worldbooks/别的.json' },      // 非 card/source 不动
  ])
  assert.equal(rewritten.sessions[0].id, 'session-a')
  // 缺 SQL 卡快照 → 资源版快照补回 head（插到 messages 占位之前，ord 连续，只重绑 image ref）
  const bare = { ...chat, cardDefinitionSnapshot: undefined }
  deps.gameFootprint.readSceneWorldbook = sourceBook          // bare capture/validate 用源侧
  const bareWindow = await transfer.capture({ chat: bare, tables, nativeEvents: [] })
  const bareBundle = await transfer.validate({ files: bareWindow.files, chat: bare, tables, nativeEvents: [] })
  deps.gameFootprint.readSceneWorldbook = targetBook          // bare install 目标缺 book2
  const bareLease = await createDbSaveResourceTransfer(deps).install(bareBundle, bare, { chatId: 'chat-bare', sessionId: 'session-bare' })
  const head = bareLease.rewriteTables({ archive_head_fields: [{ key: 'id', ord: 0, kind: 0, value_json: '"chat-a"' }, { key: 'messages', ord: 1, kind: 0, value_json: null }] }).archive_head_fields
  assert.deepEqual(head.map(row => row.key), ['id', 'cardDefinitionSnapshot', 'messages'])
  assert.deepEqual(head.map(row => row.ord), [0, 1, 2])
  const injected = JSON.parse(head[1].value_json)
  assert.equal(injected.name, '卡')
  assert.equal(injected.pic.attachment.attachmentId, 'sha256:new')
})

test('DB资源导入拒绝闭包外场景且不创建租约', async () => {
  const { deps, chat, calls, tables } = fixture()
  const transfer = createDbSaveResourceTransfer(deps)
  const window = await transfer.capture({ chat, tables, nativeEvents: [] })
  const foreign = sha256('foreign-scene-key')   // 合法64hex，但不是本局任何轮次的 computeSceneTarget.key
  const files = window.files.map(file => {
    if (file.path !== 'index.json') return file
    const index = JSON.parse(file.data.toString('utf8'))
    for (const entry of index.files || []) if (entry.kind === 'scene') entry.native = foreign + '.json'
    return { ...file, data: Buffer.from(JSON.stringify(index)) }
  }).map(file => {
    if (!file.path.startsWith('scene/')) return file   // encode 返回项只有 {path,data}，按路径识别
    const record = JSON.parse(file.data.toString('utf8'))
    record.key = foreign                      // 其它字段（turn/版本/图片/书ref）全保持，确保不是早层坏包
    return { ...file, data: Buffer.from(JSON.stringify(record)) }
  })
  await assert.rejects(() => transfer.validate({ files, chat, tables, nativeEvents: [] }), /闭包外场景/)
  assert.deepEqual(calls.importCard, [])
  assert.deepEqual(calls.writeBytes, [])
  assert.deepEqual(calls.saveImage, [])
})

test('DB卡载荷与本局快照冲突在创建新身份前拒绝', async () => {
  const { deps, chat, calls, tables } = fixture()
  const withRaw = { ...chat, cardDefinitionSnapshot: { name: '卡A', raw: { name: '卡A', description: 'A' } } }
  const transfer = createDbSaveResourceTransfer(deps)
  const window = await transfer.capture({ chat: withRaw, tables, nativeEvents: [] })
  const files = window.files.map(file => {
    if (file.path !== 'card.json') return file
    const card = JSON.parse(file.data.toString('utf8'))
    card.payload = { kind: 'text', name: '卡.json', text: JSON.stringify({ name: '卡B', description: 'B' }) }   // 合法JSON的另一张卡（非坏JSON/非缺资源）
    return { ...file, data: Buffer.from(JSON.stringify(card)) }
  })
  await assert.rejects(() => transfer.validate({ files, chat: withRaw, tables, nativeEvents: [] }), /卡载荷与本局快照冲突/)
  assert.deepEqual(calls.importCard, [])
  assert.deepEqual(calls.saveImage, [])
  assert.deepEqual(calls.writeBytes, [])
})

test('DB图卡与无raw快照规范一致性预检', async () => {
  const { deps, chat, calls, tables } = fixture()
  // 作者 pngCardPayload 契约（file-resources.js L112-117）：b64=PNG 内嵌卡 JSON base64；fileB64=整张 PNG 文件 base64（distinct，不用 fallback）
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])   // PNG magic + 合成 transport bytes（非真解析）
  const png = raw => ({ kind: 'png', name: '卡.png', b64: Buffer.from(JSON.stringify(raw)).toString('base64'), fileB64: pngBytes.toString('base64') })
  const noRaw = { ...chat, cardDefinitionSnapshot: { name: '卡A' } }   // SQL 快照无 raw（PNG 图卡 fallback）
  deps.fileResources.originalCardPayload = async () => png({ name: '卡A' })
  const window = await createDbSaveResourceTransfer(deps).capture({ chat: noRaw, tables, nativeEvents: [] })
  assert.equal(window.cardPayload.kind, 'png')
  // 双字段缺一（缺 b64）→ codec 拒且不创建资源
  const missing = window.files.map(file => {
    if (file.path !== 'card.json') return file
    const card = JSON.parse(file.data.toString('utf8'))
    card.payload = { kind: 'png', name: '卡.png', fileB64: pngBytes.toString('base64') }
    return { ...file, data: Buffer.from(JSON.stringify(card)) }
  })
  await assert.rejects(() => createDbSaveResourceTransfer(deps).validate({ files: missing, chat: noRaw, tables, nativeEvents: [] }), /b64\+fileB64/)
  assert.deepEqual(calls.importCard, [])
  assert.deepEqual(calls.saveImage, [])
  assert.deepEqual(calls.writeBytes, [])
  // 合法同图卡：真实作者纯模块 create(读 b64) 通过；install 原样传 importCard（双字段与封面 bytes 不丢）
  const bundle = await createDbSaveResourceTransfer(deps).validate({ files: window.files, chat: noRaw, tables, nativeEvents: [] })
  const lease = await createDbSaveResourceTransfer(deps).install(bundle, noRaw, { chatId: 'chat-png', sessionId: 'session-png' })
  const sent = calls.importCard.at(-1)
  assert.equal(sent.b64, window.cardPayload.b64)                      // b64 原样（非 fileB64 fallback）
  assert.equal(sent.fileB64, pngBytes.toString('base64'))             // 整张封面 bytes 原样
  assert.equal(sent.name.endsWith('.png'), true)
  assert.equal(lease.cardPath.endsWith('.png'), true)
  // 异卡（合法 JSON 另一人）→ 无 raw 快照规范不一致拒
  deps.fileResources.originalCardPayload = async () => png({ name: '卡B' })
  const badWindow = await createDbSaveResourceTransfer(deps).capture({ chat: noRaw, tables, nativeEvents: [] })
  await assert.rejects(() => createDbSaveResourceTransfer(deps).validate({ files: badWindow.files, chat: noRaw, tables, nativeEvents: [] }), /规范不一致/)
})
