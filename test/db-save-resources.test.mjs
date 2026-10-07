// 只验资源包预检与结构映射层：合成fixture，不加载真实作者Host/SDK、不写库、不跑真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { encodeDbSaveResources, validateDbSaveResources, rewriteDbSaveResourceRefs, collectDbSaveAttachmentRefs, collectDbSaveWorldbookRefs, DB_SAVE_RESOURCE_KIND, DB_SAVE_RESOURCE_VERSION } from '../lib/db-save-resources.js'

const KEY = 'c'.repeat(64)
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bookDoc = { entries: [] }
const BOOK = sha(bookDoc)
const bookBytes = Buffer.from(JSON.stringify(bookDoc, null, 2))  // 原始byte带缩进≠canonical → 证明按解析后canonical校验
const imgRef = (attachmentId, extra = {}) => ({ attachmentId, mediaType: 'image/png', width: 8, height: 8, bytes: 3, name: 'a.png', ...extra })
const sceneEntry = (record, native = KEY + '.json') => ({ path: 'scene/0000.json', kind: 'scene', native, data: Buffer.from(JSON.stringify(record)) })
const sceneRecord = (extra = {}) => ({ key: KEY, turn: 1, status: 'succeeded', ...extra })
const cardFile = body => ({ path: 'card.json', kind: 'card', native: null, data: Buffer.from(JSON.stringify(body)) })
const files = [
  cardFile({ version: 1, snapshot: { name: '卡' }, payload: null }),
  { path: 'books/0000.json', kind: 'worldbook', digest: BOOK, data: bookBytes },
  { path: 'images/0000.bin', kind: 'image', attachmentId: 'att-1', mediaType: 'image/png', data: Buffer.from([1, 2, 3]) },
]
function pack(entries = files, { drop = [], extra = [], mutate = [], root = {} } = {}) {
  const kept = entries.filter(item => !drop.includes(item.path))
  const declared = kept.map(item => mutate.find(change => change.path === item.path)?.entry || (({ data, ...entry }) => entry)(item))
  const index = { kind: DB_SAVE_RESOURCE_KIND, version: DB_SAVE_RESOURCE_VERSION, files: declared, ...root }
  return [{ path: 'index.json', data: Buffer.from(JSON.stringify(index)) }, ...kept, ...extra]
}
const chatFor = digest => ({ id: 'chat-a', sessionId: 'session-a', mode: 'story', cardDefinitionSnapshot: { name: '卡' }, sceneOpeningWorldbook: { version: 1, digest } })
const storyChat = () => chatFor(BOOK)
const events = () => [{ type: 'turn/end', data: { content: [imgRef('att-1')] } }]

test('DB资源闭包缺附件与未知条目拒绝', () => {
  const bundle = validateDbSaveResources(pack(), storyChat(), events())
  assert.equal(bundle.attachments.length, 1)
  assert.equal(bundle.worldbooks[0].digest, BOOK)
  assert.throws(() => validateDbSaveResources(pack(files, { drop: ['images/0000.bin'] }), storyChat(), events()), /缺少附件/)
  assert.throws(() => validateDbSaveResources(pack(), storyChat(), [{ type: 'turn/end', data: {} }]), /未被引用的图片/)
  assert.throws(() => validateDbSaveResources(pack(files, { extra: [{ path: 'evil.txt', data: Buffer.from('x') }] }), storyChat(), events()), /不在白名单/)
  assert.throws(() => validateDbSaveResources(pack(files, { extra: [{ path: 'scene/0000.json', data: Buffer.from('{}') }] }), storyChat(), events()), /未声明条目/)
  assert.throws(() => validateDbSaveResources([{ path: '../x.json', data: Buffer.from('x') }], storyChat(), events()), /路径危险/)
  assert.throws(() => validateDbSaveResources([...pack(), ...pack()], storyChat(), events()), /重复/)
  assert.throws(() => validateDbSaveResources(pack(files).map(item => item.path === 'images/0000.bin' ? { ...item, data: Buffer.alloc(0) } : item), storyChat(), events()), /附件为空/)
  // 附件引用：只pick 7个ref字段（叙事字段丢弃），同id的mediaType/width/height/bytes冲突拒
  assert.deepEqual(collectDbSaveAttachmentRefs({ ...imgRef('att-1'), caption: '叙事' }).get('att-1'), imgRef('att-1'))
  assert.throws(() => collectDbSaveAttachmentRefs([imgRef('att-1'), imgRef('att-1', { bytes: 9 })]), /附件引用冲突（bytes）/)
  assert.throws(() => validateDbSaveResources(pack(), storyChat(), [{ type: 'turn/end', data: { content: [imgRef('att-1'), imgRef('att-1', { width: 4 })] } }]), /附件引用冲突（width）/)
  // 世界书：canonical digest（非raw byte）、消息绑定闭包、不得塞其它局book
  assert.equal(validateDbSaveResources(pack([files[0], { ...files[1], data: Buffer.from(JSON.stringify(bookDoc)) }, files[2]]), storyChat(), events()).worldbooks[0].digest, BOOK)
  assert.throws(() => validateDbSaveResources(pack([files[0], { ...files[1], digest: 'b'.repeat(64) }, files[2]]), storyChat(), events()), /digest与内容不符/)
  const bound = { ...storyChat(), messages: [{ role: 'assistant', turn: 1, sceneWorldbook: { version: 1, digest: 'd'.repeat(64), bodyDigests: ['e'.repeat(64)] } }] }
  assert.equal(collectDbSaveWorldbookRefs(bound).has('d'.repeat(64)), true)
  assert.throws(() => validateDbSaveResources(pack(), bound, events()), /缺少本局世界书快照/)
  const foreignDoc = { entries: [{ text: 'x' }] }
  assert.throws(() => validateDbSaveResources(pack([files[0], files[1], { path: 'books/0001.json', kind: 'worldbook', digest: sha(foreignDoc), data: Buffer.from(JSON.stringify(foreignDoc)) }, files[2]]), storyChat(), events()), /非本局世界书快照/)
  // worldbook 必须是JSON对象；digest重复与附件oldid重复显式拒；index条目/根未知字段拒
  assert.throws(() => validateDbSaveResources(pack([files[0], { ...files[1], data: Buffer.from('not json') }, files[2]]), storyChat(), events()), /世界书快照/)
  assert.throws(() => validateDbSaveResources(pack([files[0], files[1], { path: 'books/0001.json', kind: 'worldbook', digest: BOOK, data: bookBytes }, files[2]]), storyChat(), events()), /digest重复/)
  assert.throws(() => validateDbSaveResources(pack([files[0], files[1], files[2], { path: 'images/0001.bin', kind: 'image', attachmentId: 'att-1', mediaType: 'image/png', data: Buffer.from([9, 9]) }]), storyChat(), events()), /oldid重复/)
  assert.throws(() => validateDbSaveResources(pack(files, { mutate: [{ path: 'card.json', entry: { path: 'card.json', kind: 'card', native: null, digest: BOOK } }] }), storyChat(), events()), /未知字段/)
  assert.throws(() => validateDbSaveResources(pack(files, { root: { extra: 1 } }), storyChat(), events()), /索引根含未知字段/)
  // 附件闭包覆盖 card.snapshot/payload 与 worldbook解码对象；worldbook内的JSON字符串不解析
  const cardRef = cardFile({ version: 1, snapshot: { pic: imgRef('att-9') }, payload: null })
  assert.throws(() => validateDbSaveResources(pack([cardRef, files[1], files[2]]), storyChat(), []), /缺少附件/)
  assert.equal(validateDbSaveResources(pack([cardRef, files[1], { ...files[2], attachmentId: 'att-9' }]), storyChat(), []).attachments.length, 1)
  const wbDoc = { entries: [imgRef('att-wb')] }, WB = sha(wbDoc)
  const bookRef = { path: 'books/0000.json', kind: 'worldbook', digest: WB, data: Buffer.from(JSON.stringify(wbDoc)) }
  assert.throws(() => validateDbSaveResources(pack([files[0], bookRef, files[2]]), chatFor(WB), events()), /缺少附件/)
  const wbStrDoc = { entries: [{ note: JSON.stringify(imgRef('att-str')) }] }, WB2 = sha(wbStrDoc)
  assert.equal(validateDbSaveResources(pack([files[0], { path: 'books/0000.json', kind: 'worldbook', digest: WB2, data: Buffer.from(JSON.stringify(wbStrDoc)) }, files[2]]), chatFor(WB2), events()).attachments.length, 1)
  // scene来源名：只接受 64hex key.json，拒 agent.json，且必须等于记录key
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord(), 'agent.json')]), storyChat(), events()), /来源名不合法/)
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord(), 'oldkey.json')]), storyChat(), events()), /必须是64位十六进制key\.json/)
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord(), 'd'.repeat(64) + '.json')]), storyChat(), events()), /来源名与本局key不符/)
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord(), KEY + '.json'), sceneEntry(sceneRecord(), KEY + '.json')])), /重复/)
  // scene记录：未静止与运行/审计字段拒绝
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord({ status: 'running' }))]), storyChat(), events()), /未静止/)
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord({ recovery: 'save' }))]), storyChat(), events()), /未静止/)
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord({ ownerPid: 1 }))]), storyChat(), events()), /运行\/审计字段/)
  assert.throws(() => validateDbSaveResources(pack([...files, sceneEntry(sceneRecord({ versions: [{ id: 'v1', configuration: {} }] }))]), storyChat(), events()), /版本含运行\/审计字段/)
  // worldbook digest格式 / 媒体类型 / kind
  assert.throws(() => validateDbSaveResources(pack([{ ...files[1], digest: 'zz' }]), storyChat(), events()), /digest无效/)
  assert.throws(() => validateDbSaveResources(pack(files, { mutate: [{ path: 'images/0000.bin', entry: { path: 'images/0000.bin', kind: 'image', attachmentId: 'att-1', mediaType: 'image/tiff' } }] }), storyChat(), events()), /媒体类型不支持/)
  assert.throws(() => validateDbSaveResources(pack(files, { mutate: [{ path: 'card.json', entry: { path: 'card.json', kind: 'unknown', native: null } }] }), storyChat(), events()), /kind未知/)
  // script：非script模式不接受；script模式必须有非空剧本
  const scriptFile = { path: 'script.json', kind: 'script', native: '剧本.txt', data: Buffer.from('第一幕') }
  assert.throws(() => validateDbSaveResources(pack([files[0], files[1], scriptFile]), storyChat(), []), /剧本资源多余/)
  assert.throws(() => validateDbSaveResources(pack([files[0], files[1]]), { ...storyChat(), mode: 'script' }, []), /剧本资源缺失/)
  assert.throws(() => validateDbSaveResources(pack([files[0], files[1], { ...scriptFile, data: Buffer.from('  ') }]), { ...storyChat(), mode: 'script' }, []), /剧本资源为空/)
  // 卡条目必需、version/快照/载荷形状严格：即使chat带卡快照也不能缺 card.json
  assert.throws(() => validateDbSaveResources(pack([files[1], files[2]]), storyChat(), events()), /card\.json条目/)
  assert.throws(() => validateDbSaveResources(pack([cardFile({ version: 2, snapshot: { name: '卡' }, payload: null }), files[1], files[2]]), storyChat(), events()), /version无效/)
  assert.throws(() => validateDbSaveResources(pack([cardFile({ version: 1, snapshot: [1], payload: null }), files[1], files[2]]), storyChat(), events()), /卡快照必须是对象/)
  assert.throws(() => validateDbSaveResources(pack([cardFile({ version: 1, snapshot: null, payload: { kind: 'bad' } }), files[1], files[2]]), storyChat(), events()), /卡载荷/)
  assert.throws(() => validateDbSaveResources(pack([cardFile({ version: 1, snapshot: null, payload: { kind: 'text', text: '  ' } }), files[1], files[2]]), storyChat(), events()), /卡载荷/)
  assert.throws(() => validateDbSaveResources(pack([cardFile({ version: 1, snapshot: { name: '卡' }, payload: null }), files[1], files[2]]), { ...storyChat(), cardDefinitionSnapshot: null }, []), /卡资源不自含/)
  assert.throws(() => encodeDbSaveResources({ cardSnapshot: { name: '卡' }, sceneFiles: [{ path: 'agent.json', content: Buffer.from('{}') }] }), /来源名不合法/)
  // 引用只认结构图片对象：字符串（含JSON故事文本）不算、文件引用与缺mediaType响亮拒绝
  assert.equal(collectDbSaveAttachmentRefs({ content: 'http://x/att-1.png', url: 'att-1' }).size, 0)
  assert.equal(collectDbSaveAttachmentRefs({ content: JSON.stringify([imgRef('att-2')]) }).size, 0)
  assert.equal(collectDbSaveAttachmentRefs({ content: [imgRef('att-2')] }).size, 1)
  assert.throws(() => collectDbSaveAttachmentRefs({ fileId: 'f-1' }), /不支持文件附件引用/)
  assert.throws(() => collectDbSaveAttachmentRefs({ name: 'a.pdf', bytes: 3 }), /不支持文件附件引用/)
  assert.throws(() => collectDbSaveAttachmentRefs({ attachmentId: 'att-3' }), /缺少mediaType/)
  assert.throws(() => collectDbSaveAttachmentRefs({ attachmentId: 'att-3', mediaType: 'application/pdf' }), /不支持非图片附件引用/)
})

test('DB资源身份映射保正文和anchor', () => {
  const identity = { chatId: 'chat-new', sessionId: 'session-new', sourceChatId: 'chat-a', sessions: new Map([['session-a', 'session-new'], ['session-b', 'session-b2']]) }
  const sceneKeys = new Map([['oldkey', 'newkey']])
  const oldRef = imgRef('att-1'), newRef = { attachmentId: 'att-new', mediaType: 'image/png', width: 8, height: 8, bytes: 3 }
  const images = new Map([['att-1', newRef]])
  const source = {
    chatId: 'chat-a',
    sessionId: 'session-a',
    text: '正文里出现 chat-a 与 session-a，必须原样',
    sourceText: 'anchor: chat-a',
    anchor: 'chat-a',
    tree: { chatId: 'chat-a' },
    variables: { sessionId: 'session-a', chatId: 'chat-a', key: 'oldkey', pic: imgRef('att-1') },
    content: [{ type: 'image', attachment: imgRef('att-1') }, { type: 'text', text: 'chat-a 也在这里' }],
    scene: { key: 'oldkey', versions: [{ id: 'v1', attachment: { ...oldRef, originalDimensions: { width: 4, height: 4 }, anchor: '锚', caption: '说明' }, source: { key: 'oldkey' }, plan: { anchor: 'chat-a 的锚点', sources: [{ key: 'oldkey' }, { key: 'unknown-key' }] } }] },
  }
  const next = rewriteDbSaveResourceRefs(source, images, identity, sceneKeys)
  assert.equal(next.chatId, 'chat-new')
  assert.equal(next.sessionId, 'session-new')
  assert.equal(next.text, source.text)
  assert.equal(next.sourceText, source.sourceText)
  assert.equal(next.anchor, 'chat-a')
  assert.deepEqual(next.tree, source.tree)
  assert.equal(next.variables.sessionId, 'session-a')
  assert.equal(next.variables.chatId, 'chat-a')
  assert.equal(next.variables.key, 'oldkey')
  assert.equal(next.variables.pic.attachmentId, 'att-new')
  assert.equal(next.content[0].attachment.attachmentId, 'att-new')
  assert.equal(next.content[1].text, 'chat-a 也在这里')
  assert.equal(next.scene.key, 'newkey')
  assert.equal(next.scene.versions[0].id, 'v1')
  // ref整份换新：旧ref字段（originalDimensions/name）不得残留，非ref叙事（anchor/caption）保留
  assert.deepEqual(next.scene.versions[0].attachment, { anchor: '锚', caption: '说明', ...newRef })
  assert.equal('originalDimensions' in next.scene.versions[0].attachment, false)
  assert.equal('name' in next.scene.versions[0].attachment, false)
  assert.equal(next.scene.versions[0].source.key, 'newkey')
  assert.equal(next.scene.versions[0].plan.anchor, 'chat-a 的锚点')
  assert.equal(next.scene.versions[0].plan.sources[0].key, 'newkey')
  assert.equal(next.scene.versions[0].plan.sources[1].key, 'unknown-key')
  // JSON故事文本（含attachmentId/sessionId/chatId）字节完全不变：不解析、不stringify、不replace
  const storyJson = JSON.stringify([imgRef('att-1'), { sessionId: 'session-a' }, { chatId: 'chat-a' }])
  assert.equal(rewriteDbSaveResourceRefs({ content: storyJson }, images, identity, sceneKeys).content, storyJson)
  assert.equal(rewriteDbSaveResourceRefs({ text: storyJson }, images, identity, sceneKeys).text, storyJson)
  assert.equal(rewriteDbSaveResourceRefs({ content: 'chat-a 的正文' }, images, identity, sceneKeys).content, 'chat-a 的正文')
  assert.throws(() => rewriteDbSaveResourceRefs({ attachmentId: 'att-x', mediaType: 'image/png' }, images, identity, sceneKeys), /缺少包内映射/)
  assert.throws(() => rewriteDbSaveResourceRefs({ sessionId: 'session-x' }, images, identity, sceneKeys), /闭包外会话引用/)
  const kept = rewriteDbSaveResourceRefs({ deletedVersions: [{ attachment: imgRef('att-gone') }] }, images, identity, sceneKeys)
  assert.equal(kept.deletedVersions[0].attachment.attachmentId, 'att-gone')
  assert.throws(() => rewriteDbSaveResourceRefs({ chatId: 'chat-a' }, images, { chatId: 'chat-new', sessionId: 'session-new', sessions: new Map() }, sceneKeys), /身份映射缺少/)
})

test('DB剧本卡配图资源包往返保本局字段', () => {
  const chat = { id: 'chat-a', sessionId: 'session-a', mode: 'script', cardDefinitionSnapshot: null, sceneOpeningWorldbook: { version: 1, digest: BOOK }, messages: [{ role: 'assistant', turn: 1, sceneWorldbook: { version: 1, digest: BOOK, bodyDigests: [sha('第一幕')] } }] }
  const record = sceneRecord({
    ownerPid: 4242,
    ownerId: 'owner-1',
    requests: { r1: { status: 'succeeded' } },
    deletedVersions: [{ attachment: imgRef('att-gone') }],
    versions: [{ id: 'v1', requestId: 'r1', attachment: { attachmentId: 'att-9', mediaType: 'image/webp', width: 8, height: 8, bytes: 2, name: 'b.webp' }, prompt: '海边', plan: { anchor: '海', description: '海边' }, configuration: { model: 'x' }, diagnostics: { q: 1 } }],
  })
  const resources = encodeDbSaveResources({
    cardPayload: { kind: 'text', name: '卡.json', text: '{"name":"卡"}' },
    script: { path: 'scripts/卡/剧本.txt', text: '第一幕' },
    sceneFiles: [{ path: KEY + '.json', content: Buffer.from(JSON.stringify(record)) }],
    worldbooks: [{ digest: BOOK, content: bookBytes }],
    attachments: [{ attachmentId: 'att-9', mediaType: 'image/webp', data: Buffer.from([9, 9]) }],
  })
  assert.deepEqual(resources.map(item => item.path), ['index.json', 'card.json', 'script.json', 'scene/0000.json', 'books/0000.json', 'images/0000.bin'])
  assert.deepEqual(JSON.parse(resources[0].data.toString('utf8')).files, [
    { path: 'card.json', kind: 'card', native: null },
    { path: 'script.json', kind: 'script', native: '剧本.txt' },
    { path: 'scene/0000.json', kind: 'scene', native: KEY + '.json' },
    { path: 'books/0000.json', kind: 'worldbook', digest: BOOK },
    { path: 'images/0000.bin', kind: 'image', attachmentId: 'att-9', mediaType: 'image/webp' },
  ])
  const stored = JSON.parse(resources.find(item => item.path === 'scene/0000.json').data.toString('utf8'))
  assert.equal(stored.ownerPid, undefined)
  assert.equal(stored.deletedVersions, undefined)
  assert.equal(stored.requests, undefined)
  assert.equal(stored.versions[0].configuration, undefined)
  assert.equal(stored.versions[0].diagnostics, undefined)
  assert.equal(stored.versions[0].plan.anchor, '海')
  const bundle = validateDbSaveResources(resources, chat, [{ type: 'turn/end', data: { content: [{ attachmentId: 'att-9', mediaType: 'image/webp' }] } }])
  assert.equal(bundle.script.text, '第一幕')
  assert.equal(bundle.script.source, '剧本.txt')
  assert.equal(bundle.card.payload.name, '卡.json')
  assert.equal(bundle.sceneFiles[0].source, KEY + '.json')
  assert.equal(bundle.worldbooks[0].digest, BOOK)
  assert.equal(bundle.refs.get('att-9').bytes, 2)
  const next = rewriteDbSaveResourceRefs(bundle.sceneFiles[0].record,
    new Map([['att-9', { attachmentId: 'att-new9', mediaType: 'image/webp', width: 8, height: 8, bytes: 2 }]]),
    { chatId: 'chat-new', sessionId: 'session-new', sourceChatId: 'chat-a', sessions: new Map([['session-a', 'session-new']]) },
    new Map([[KEY, 'e'.repeat(64)]]))
  assert.equal(next.key, 'e'.repeat(64))
  assert.equal(next.turn, 1)
  assert.equal(next.status, 'succeeded')
  assert.equal(next.versions[0].prompt, '海边')
  assert.equal(next.versions[0].attachment.attachmentId, 'att-new9')
  assert.equal('name' in next.versions[0].attachment, false)
  assert.equal(next.versions[0].plan.anchor, '海')
})
