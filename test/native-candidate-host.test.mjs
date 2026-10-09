// S4 候选链宿主接线具名断言（只写后逐条 gate）：施缝后的**真实消费点**（作者 index.js:2677 的
//   createCandidateContextReader 构造）里，窗口读已换为插件原生出口 chatJournalStore.readCandidateInput。
// 范围：候选链的 readWindow 实参替换（deploy/native-data-transform.mjs ⑩ S4-3）——
//   ① 命中：走原生出口，不直连作者 chatPersistence.readWindow；窗口适配 from=0 使作者分页不进；
//   ② 出口 undefined ⇒ **作者 reader 自己** `if (!window) return readChat(id)` 原样兜底（语义未改）；
//   ③ 出口缺失/形状非法 ⇒ 响亮抛错（不静默整档）；
//   ④ 作者适用性门槛（cardDefinitionSnapshot / openingWorldbookSnapshot.version / legacy body）仍在；
//   ⑤ 真 store 夹具下消费点拿到的是真库 chat。
// 不跑：未受影响链（story/结算/模板/opening/活动摘要）。不读真实档/远端/禁令对象；合成数据；只清自建 mkdtemp。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { applyStandardSeams } from '../deploy/standard-seams.mjs'
import { isNativeDataApplied, CHAIN_MARKER } from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { AUTHOR_VERSION } from '../lib/standard-host.js'

const INDEX = 'tavern-plugin/lib/index.js'
const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

// 作者 domain 传递性 import 未安装的 jsdom/marked/yaml：按既有 native-story-input.test.mjs 机制，只把该
// fixture 树内解析不到的裸说明符重定向到 tools/sql-test-kit（固定 jsdom 26.1.0），不改作者字节。
const testRequire = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/release-034-20261008/author-fixture/')
      || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:')) throw error
    return next(pathToFileURL(testRequire.resolve(specifier)).href, context)
  }
} })

const { createCandidateContextReader } = await import(new URL('candidate-context-reader.js', AUTHOR68215))
const { projectAgentMessageText } = await import(new URL('runtime-content-projection.js', AUTHOR68215))
const { lastTavernHelperVariables } = await import(new URL('tavern-helper-context.js', AUTHOR68215))
const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
assert.equal(typeof createCandidateContextReader, 'function', '作者 createCandidateContextReader 缺失：消费点无法真实执行')
assert.equal(typeof projectAgentMessageText, 'function', '作者 projectAgentMessageText 缺失：真出口协议投影无法注入')
assert.equal(typeof lastTavernHelperVariables, 'function', '作者 lastTavernHelperVariables 缺失：真出口协议判据无法注入')
/** 真 store 出口 readCandidateInput 调用期要求的协议 helper（与 deploy/chat-sqlite-store.shim.js 同源）。 */
const PROTOCOL_HELPERS = { projectAgentMessageText, lastTavernHelperVariables }
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused
for (const [name, fn] of Object.entries(HELPERS)) assert.equal(typeof fn, 'function', '作者 helper ' + name + ' 缺失：夹具无法对账')

/** 真实作者 source fixture → 自有 tmp → 真实施缝；返回**ACTIVE 投影**源码（本文件共用一份）。 */
let SEAM = null
function seamSource() {
  if (SEAM !== null) return SEAM
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  test.after(tree.cleanup)                                            // 只删 helper 自己的 mkdtemp 目录
  const indexFile = path.join(tree.appDir, ...INDEX.split('/'))
  assert.equal(isNativeDataApplied(readFileSync(indexFile, 'utf8')), false, '前置：作者原字节不应已应用 native-data 转换')
  assert.equal(applyStandardSeams({ appDir: tree.appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true }).changed, true)
  const seamed = readFileSync(indexFile, 'utf8')
  assert.equal(isNativeDataApplied(seamed), true, '装配后实际 index 必须已应用 native-data 转换')
  // 切缝副本只取 ACTIVE 投影：ORIGINAL 区是注释掉的作者原文，直接切片会撞锚点/重复声明。
  SEAM = activeSource(seamed, INDEX)
  assert.equal(isNativeDataApplied(SEAM), true, 'ACTIVE 投影必须保留 native-data 生成标记')
  return SEAM
}

/** 取带标记的生成整块（标记行 + 到终止行为止），去掉注释行；标记缺失/终止缺失即响亮失败。 */
function markedBlock(source, marker, terminator) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.includes(marker))
  assert.ok(start >= 0, '生成物缺三链标记：' + marker)
  const end = lines.findIndex((line, index) => index > start && line.trimEnd().endsWith(terminator))
  assert.ok(end > start, '生成物缺该块终止行：' + terminator)
  return lines.slice(start, end + 1).filter(line => !line.trimStart().startsWith('//')).join('\n')
}

/** 真 store 夹具（8 作者 helper；protocol=true 时再加真出口调用期要求的协议 helper）。 */
function storeFixture(t, { chatId, sessionId, label, protocol = false }) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-candidate-store-' + label + '-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const helpers = protocol ? { ...HELPERS, ...PROTOCOL_HELPERS } : HELPERS
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, sessionId, store }
}

const CHAT_ID = 'chat-candidate-host'
const SESSION_ID = 'session-candidate-host'
const CANDIDATE_CHAT = {
  id: CHAT_ID, sessionId: SESSION_ID, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  _storageRevision: 5, updatedAt: 1, cardPath: 'cards/host-card.json',
  cardDefinitionSnapshot: { name: 'card-fixture' }, openingWorldbookSnapshot: { version: 1 },
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 3, participants: {}, operations: {} },
  messages: [
    { role: 'user', text: 'u0', turn: 1 },
    { role: 'assistant', text: 'a1', turn: 1 },
    { role: 'assistant', text: 'a2', turn: 2 }
  ]
}
const FALLBACK_CHAT = { id: CHAT_ID, source: '作者 readChat 整档' }

/** 执行施缝后的真实消费点构造块：只注入它真正引用的名字。 */
function candidateApi({ source, exit, header = async () => ({ id: CHAT_ID }), fallbackReadWindow }) {
  const spy = { exitCalls: [], headerCalls: [], readChat: [], readWindow: [] }
  const block = markedBlock(source, CHAIN_MARKER.candidate, '},readChat})')
  const chatJournalStore = exit === null ? {} : {
    readCandidateInput(id, need) { spy.exitCalls.push({ id, need }); return exit(id, need) }
  }
  const api = new Function(
    'chatHeaderForSession', 'chatPersistence', 'readChat', 'createCandidateContextReader', 'chatJournalStore',
    block + '\n return candidateContextReader'
  )(
    async (sessionId, fields) => { spy.headerCalls.push({ sessionId, fields }); return header(sessionId, fields) },
    { readWindow: async (id, options) => { spy.readWindow.push({ id, options }); return fallbackReadWindow ? fallbackReadWindow(id, options) : undefined } },
    async id => { spy.readChat.push(id); return FALLBACK_CHAT },
    createCandidateContextReader,
    chatJournalStore
  )
  return { api, spy }
}

test('S4候选上下文命中原生出口且不直连作者宽读', async t => {
  const source = seamSource()
  const { api, spy } = candidateApi({ source, exit: async () => CANDIDATE_CHAT })
  const chat = await api.forSession(SESSION_ID)
  assert.equal(chat, CANDIDATE_CHAT, '命中必须返回原生出口给的同一 chat 对象')
  assert.deepEqual(spy.headerCalls, [{ sessionId: SESSION_ID, fields: ['id'] }], 'forSession 仍用 headerForSession(sessionId,[\'id\']) 解析（解析原样保留）')
  assert.equal(spy.exitCalls.length, 1, '窗口读必须恰一次走原生出口')
  assert.equal(spy.exitCalls[0].id, CHAT_ID, '出口必须收到 header 解析出的 chatId')
  assert.deepEqual(spy.readChat, [], '命中不得走作者 readChat 整档兜底')
  assert.deepEqual(spy.readWindow, [], '命中不得直连作者 chatPersistence.readWindow（窗口适配 from=0 ⇒ 作者分页不进）')
  // read(id) 直调（消费点 :2706 readChat: candidateContextReader.read）同样走出口
  spy.exitCalls.length = 0
  const direct = await api.read(CHAT_ID)
  assert.equal(direct, CANDIDATE_CHAT)
  assert.equal(spy.exitCalls.length, 1)
  assert.equal(spy.exitCalls[0].id, CHAT_ID)
  void t
})

test('S4候选上下文出口未命中时作者readChat兜底', async t => {
  const source = seamSource()
  const { api, spy } = candidateApi({ source, exit: async () => undefined })
  const chat = await api.forSession(SESSION_ID)
  assert.equal(spy.exitCalls.length, 1, 'undefined 前必须真调用过出口（不跳过判定）')
  assert.deepEqual(spy.readChat, [CHAT_ID], 'undefined ⇒ 作者 reader 原样走 readChat(id)')
  assert.equal(chat, FALLBACK_CHAT, '兜底必须返回作者 readChat 结果')
  assert.deepEqual(spy.readWindow, [], '兜底路径不得再调作者 readWindow')
  // 无该 session 的 header ⇒ forSession 直接 undefined（作者语义，不调出口）
  const noHeader = candidateApi({ source, exit: async () => CANDIDATE_CHAT, header: async () => undefined })
  assert.equal(await noHeader.api.forSession('other-session'), undefined, 'header 缺失 ⇒ forSession undefined')
  assert.deepEqual(noHeader.spy.exitCalls, [], 'header 缺失不得调用出口')
  void t
})

test('S4候选上下文出口缺失或形状非法时响亮失败', async t => {
  const source = seamSource()
  const missing = candidateApi({ source, exit: null })
  await assert.rejects(() => missing.api.forSession(SESSION_ID), /宿主接线缺失：chatJournalStore\.readCandidateInput 未装配/, '出口缺失必须响亮抛错，不得静默整档')
  const bad = candidateApi({ source, exit: async () => ({ id: CHAT_ID }) })
  await assert.rejects(() => bad.api.forSession(SESSION_ID), /未知形状/, '缺 messages 的非 chat 形状必须抛错（不猜窗口）')
  const nullish = candidateApi({ source, exit: async () => null })
  await assert.rejects(() => nullish.api.forSession(SESSION_ID), /未知形状/, 'null 不是"原生不适用"信号（只有 undefined 才是）')
  void t
})

test('S4候选上下文作者适用性门槛仍在reader内', async t => {
  const source = seamSource()
  // 出口给的是**缺 cardDefinitionSnapshot** 的 chat ⇒ 作者门槛必须把它打回 readChat 整档
  const noSnapshot = { ...CANDIDATE_CHAT, cardDefinitionSnapshot: undefined }
  const { api, spy } = candidateApi({ source, exit: async () => noSnapshot })
  const chat = await api.forSession(SESSION_ID)
  assert.equal(chat, FALLBACK_CHAT, '作者适用性门槛（缺 cardDefinitionSnapshot）必须仍走整档兜底')
  assert.deepEqual(spy.readChat, [CHAT_ID], '门槛不满足 ⇒ readChat 恰一次')
  // 旧代剧情（body 已前台完成）同样打回整档
  const legacy = {
    ...CANDIDATE_CHAT,
    timeline: { ...CANDIDATE_CHAT.timeline, operations: { 'op-body': { kind: 'body', status: 'foreground-completed' } } }
  }
  const second = candidateApi({ source, exit: async () => legacy })
  await second.api.forSession(SESSION_ID)
  assert.deepEqual(second.spy.readChat, [CHAT_ID], 'legacy body ⇒ readChat 整档（作者门槛原文）')
  void t
})

test('S4候选上下文消费点拿到真库chat', async t => {
  const source = seamSource()
  const real = storeFixture(t, { chatId: CHAT_ID, sessionId: SESSION_ID, label: 'db' })
  await real.store.update(real.chatId, () => CANDIDATE_CHAT)
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 3, '前置：真库写入 3 楼')
  assert.equal(stored.cardDefinitionSnapshot?.name, 'card-fixture', '真库必须保留候选门槛所需字段（否则作者门槛会打回整档）')
  assert.equal(stored.openingWorldbookSnapshot?.version, 1, '真库必须保留 openingWorldbookSnapshot.version=1')
  const { api, spy } = candidateApi({ source, exit: async () => stored })
  const chat = await api.forSession(SESSION_ID)
  assert.equal(chat, stored, '消费点必须拿到真库读回的 chat（同一对象）')
  assert.equal(chat.messages[2].text, 'a2', '真库楼层按序到达消费点')
  assert.equal(spy.exitCalls[0].id, CHAT_ID)
  void t
})

test('S4候选真出口直连全链贯通', async t => {
  // 全链：施缝后 candidateContextReader.read/forSession → **真 store 出口 readCandidateInput**
  // （只加一层记录包装，不改行为）→ 真 chat-query-service → 真 SQLite 库。作者 readChat/readWindow 一律抛错 ⇒
  // 只要链路没走到真出口就必然响亮失败，不给"静默整档"留下假绿空间。
  const source = seamSource()
  const real = storeFixture(t, { chatId: CHAT_ID, sessionId: SESSION_ID, label: 'exit', protocol: true })
  await real.store.update(real.chatId, () => CANDIDATE_CHAT)
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 3, '前置：真库写入 3 楼')
  assert.equal(typeof real.store.readCandidateInput, 'function', '真 store 必须已装配 S4 出口 readCandidateInput')
  const calls = []
  const realExit = real.store.readCandidateInput.bind(real.store)
  const chatJournalStore = { readCandidateInput(id, need) { calls.push({ id, need }); return realExit(id, need) } }
  const block = markedBlock(source, CHAIN_MARKER.candidate, '},readChat})')
  const api = new Function(
    'chatHeaderForSession', 'chatPersistence', 'readChat', 'createCandidateContextReader', 'chatJournalStore',
    block + '\n return candidateContextReader'
  )(
    async (sessionId, fields) => (fields && fields.length === 1 && fields[0] === 'id' ? { id: CHAT_ID } : undefined),
    { readWindow: async () => { throw new Error('真出口直连链不得回落作者 readWindow') } },
    async () => { throw new Error('真出口直连链不得回落作者 readChat') },
    createCandidateContextReader,
    chatJournalStore
  )
  const chat = await api.forSession(SESSION_ID)
  assert.equal(calls.length, 1, '窗口读必须恰一次走真出口')
  assert.equal(calls[0].id, CHAT_ID)
  assert.equal(Boolean(chat), true, '真出口命中必须给出 chat（不是 undefined）')
  assert.equal(chat.id, CHAT_ID, '返回 chat 身份来自真库')
  assert.equal(chat.sessionId, SESSION_ID)
  assert.equal(chat.messages.length, 3, '真库楼层数到达消费点（查询层返回同一 chat 形状）')
  assert.equal(chat.messages[2].text, 'a2', '真库末楼文本一致')
  assert.equal(Number.isSafeInteger(chat._storageRevision), true, '真库 _storageRevision 可核')
  assert.equal(chat.cardDefinitionSnapshot?.name, 'card-fixture', '卡快照经真出口窄读保留')
  assert.equal(chat.openingWorldbookSnapshot?.version, 1, 'openingWorldbookSnapshot.version=1 保留（作者门槛）')
  // read(id) 直调（消费点 :2706）同样贯通真出口
  calls.length = 0
  const direct = await api.read(CHAT_ID)
  assert.equal(calls.length, 1)
  assert.equal(direct.messages[2].text, 'a2')
  // 真出口对不存在档：undefined（作者 reader 语义入口之一）
  assert.equal(await real.store.readCandidateInput('no-such-chat', {}), undefined, '真出口对无档必须 undefined')
  void t
})
