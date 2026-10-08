// S4 具名断言（宿主接线侧，**只写不跑**）：前台取数改造后 storyContext / hookChatForSession 的分流、
// 落库出口与作者语义保持。
// 范围（本次实际修改所影响的调用/依赖路径）：
//   ① storyContext：命中时把范围选择交给 chatJournalStore.readStoryInput，且窗口行确来自真 SQLite 库；
//   ② 未命中（undefined）⇒ **显式**回落 chatForSession/readChat（兼容分支原文不动，不 catch-all）；
//   ③ hookChatForSession：首钩 synced===undefined 的整档基线、attempt<2 两次重试、
//      surfaceSyncedRevisions 仅在命中且有 _storageRevision 时记忆（与作者 :2858-2873 等义）；
//   ④ 逐字保留物：mvuReplies 谓词、readChangedIndices 增量调用、normalizeChat 就地 mutate。
// 不跑：未受影响的链（opening 快路径、活动摘要、状态栏命令、readOpeningWindow）不在本闸范围。
// 夹具：真随包作者树（68215e47…）复制到自有 tmp → 真实 applyStandardSeams 施缝 → 从装配后的 index 切出
// 两个函数执行（不自行调 transform）；真 store 夹具沿用 test/native-data-seams.test.mjs 的 8 个作者 helper。
// 不读真实档/远端/禁令对象；不提交；合成数据；只清本文件自建的 mkdtemp 目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadAuthorCleanImages } from '../deploy/maintenance/residual-uninstall.mjs'
import { applyStandardSeams } from '../deploy/standard-seams.mjs'
import { applyNativeDataTransform, isNativeDataApplied, STORY_INPUT_MARKER } from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { AUTHOR_VERSION } from '../lib/standard-host.js'

const TARGET = '68215e47516637e00c75d2b4bba3192679559425'   // 与 native-data-seams 同一个固定目标作者树
const INDEX = 'tavern-plugin/lib/index.js'
const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = '../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/'

// 真 store 夹具的 8 个作者 helper（缺一即响亮失败，不 skip）
const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused
for (const [name, fn] of Object.entries(HELPERS)) assert.equal(typeof fn, 'function', '作者 helper ' + name + ' 缺失：夹具无法对账')
// 作者 scoped 楼层（hole 表示）：用真身构造，避免自造数组语义。
const { createScopedMessages } = await import(new URL(AUTHOR68215 + 'domain/scoped-messages.js', import.meta.url))
const { readStoryInput } = await import('../lib/chat-query-service.js')

/** 作者真实 lastTavernHelperVariables（含其两个模块内小依赖 clone/selectedSwipe）：
 *  **按文本切出**——不 import tavern-helper-context.js（它会经 runtime-content-projection → legacy-template-display-repair 拉入未安装的 jsdom）。
 *  真 store 出口 readStoryInput 的 hasLastVariables 用的就是这一份（shim 同源），本闸不另造第二份实现。 */
const lastTavernHelperVariables = (() => {
  const source = readFileSync(new URL(AUTHOR68215 + 'domain/tavern-helper-context.js', import.meta.url), 'utf8')
  const strip = text => text.replace(/^export\s+/, '')
  const clone = new Function('return ' + strip(sliceFunction(source, 'clone')))()
  const selectedSwipe = new Function('return ' + strip(sliceFunction(source, 'selectedSwipe')))()
  return new Function('clone', 'selectedSwipe', 'return ' + strip(sliceFunction(source, 'lastTavernHelperVariables')))(clone, selectedSwipe)
})()
/** 真 store 出口（readStoryInput）在调用期要求的协议 helper；缺则出口响亮失败（本闸按 shim 同源注入）。 */
const PROTOCOL_HELPERS = { createScopedMessages, lastTavernHelperVariables }

/** 按真实整行函数声明截取（含 export/async）：结束行 = **与声明行同缩进的 `}`**
 *  （不能只看"行首两空格 }"——顶层函数体内的 for/if 块也会以 `  }` 收口，会被截断）。 */
function sliceFunction(text, name) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^\s*(?:export\s+)?(?:async\s+)?function\s+/.test(line) && line.includes(' ' + name + '('))
  assert.ok(start >= 0, '源码中缺函数：' + name)
  const closer = (lines[start].match(/^\s*/) ?? [''])[0] + '}'
  for (let i = start + 1; i < lines.length; i++) if (lines[i] === closer) return lines.slice(start, i + 1).join('\n')
  throw new Error('函数体未闭合：' + name)
}

/** 作者真实随包树 → 自有 tmp → 真实施缝；返回装配后 index 源码（整轮测试共用一份只读副本）。 */
let SEAM = null
function seamSource() {
  if (SEAM !== null) return SEAM
  const tree = loadAuthorCleanImages().trees.find(item => item.commit === TARGET)
  assert.ok(tree, '缺官方作者树：' + TARGET)
  const appDir = mkdtempSync(path.join(tmpdir(), 'native-story-host-'))
  test.after(() => rmSync(appDir, { recursive: true, force: true }))     // 只删本夹具自有唯一前缀目录
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  const indexFile = path.join(appDir, ...INDEX.split('/'))
  assert.equal(isNativeDataApplied(readFileSync(indexFile, 'utf8')), false, '前置：作者原字节不应已应用 native-data 转换')
  assert.equal(applyStandardSeams({ appDir, authorVersion: AUTHOR_VERSION }).changed, true)
  const source = readFileSync(indexFile, 'utf8')
  assert.equal(isNativeDataApplied(source), true, '装配后实际 index 必须已应用 native-data 转换')
  SEAM = source
  return SEAM
}

/** 真 store 夹具（同 native-data-seams 机制）：真 SQLite 库，写读都用产品 store。
 *  protocol=true 时额外注入 shim 同源的协议 helper ⇒ store 出口 readStoryInput 可直接跑真身。 */
function storeFixture(t, { chatId, sessionId, label, protocol = false }) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-story-store-' + label + '-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const helpers = protocol ? { ...HELPERS, ...PROTOCOL_HELPERS } : HELPERS
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, sessionId, store }
}

const CHAT = ({ chatId, sessionId, messages, timeline = { schemaVersion: 1, branchId: 'branch-main', revision: 3, participants: {}, operations: {} } }) => ({
  id: chatId, sessionId, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  _storageRevision: 1, updatedAt: 1, cardPath: 'cards/host-card.json', timeline, messages
})
const storyMessages = count => Array.from({ length: count }, (_v, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1
}))

/** 真作者 normalizeChat（从作者原树切出；本闸不复制、不重写作者算法）。 */
const authorNormalizeChat = (() => {
  const source = readFileSync(new URL(AUTHOR68215 + 'index.js', import.meta.url), 'utf8')
  return new Function('emptyCardWorkspace', 'str', 'return ' + sliceFunction(source, 'normalizeChat'))(() => ({}), String)
})()

/** 真作者 bounded-history.js 的楼层谓词参照：**按文本切出**（不 import 该模块——它会经
 *  tavern-helper-context → runtime-content-projection → legacy-template-display-repair 拉入未安装的 jsdom）。 */
const { scannedStoryRows } = (() => {
  const source = readFileSync(new URL(AUTHOR68215 + 'domain/bounded-history.js', import.meta.url), 'utf8')
  return { scannedStoryRows: new Function('return ' + sliceFunction(source, 'scannedStoryRows').replace(/^export\s+/, ''))() }
})()

const FALLBACK_WHOLE = { id: 'chat-story-host', sessionId: 'session-story-host', mode: 'story', cardPath: '' }
const FALLBACK_READ = { id: 'chat-story-host', mode: 'card' }

/** 可切换出口模式/深度/模式的 store 桩：只替 readStoryInput 出口，其余调用面保持真语义。 */
function stubStore(overrides = {}) {
  return {
    chatId: 'chat-story-host', sessionId: 'session-story-host',
    _storyChat: { id: 'chat-story-host', sessionId: 'session-story-host', cardPath: '', _storageRevision: 11 },
    _storyMessages: [], _storyMessageCount: 90, _storyFrom: 0, _storyRevision: 11, _storyExitMode: 'value', _storyExitSeq: [],
    _storyMode: 'story', _storyRequestMode: undefined,
    scanDepth: async () => 5,
    card: async () => ({ id: 'card-fixture' }),
    boundBook: async () => ({ entries: [] }),
    changedFor: () => ({ indices: [3, 5], revision: 11 }),
    ...overrides
  }
}

/** 出口返回形状必须与作者 bounded-history 相同：messages 是 createScopedMessages（hole 楼层）。 */
const scopedRows = (rows, count, from = 0) => createScopedMessages(count, rows.map((row, index) => [from + index, row]))

/** storyContext 真实宿主上下文：真 str/normalizeChat；出口可切三类：
 *  · realStore 给出时＝**真 store 出口直连**（只加一层记录包装，不改行为、不替换实现）；
 *  · 否则用注入桩（storeMode: value/undefined/throw），用于分流与错误路径。
 *  两条路径都保留回落桩（chatForSession/readChat）。 */
function storyContextApi(store, { storeMode = 'value', realStore = null } = {}) {
  const spy = { calls: [], fallback: [], headerReads: [], boundArgs: [] }
  const realExit = realStore === null ? null : realStore.readStoryInput.bind(realStore)
  const wrappedStore = {
    readStoryInput(chatId, need) {
      spy.calls.push({ chatId, need })
      if (realExit !== null) return realExit(chatId, need)          // 真出口：只记录不改语义
      if (storeMode === 'throw') throw new Error('夹具：store 出口显式失败')
      if (storeMode === 'undefined') return undefined
      return {
        chat: { ...store._storyChat, mode: store._storyMode ?? 'story', requestMode: store._storyRequestMode, messages: scopedRows(store._storyMessages, store._storyMessageCount, store._storyFrom) },
        messageCount: store._storyMessageCount, from: store._storyFrom, revision: store._storyRevision
      }
    }
  }
  const sessionMap = realStore === null
    ? async () => ({ [store.sessionId]: store.chatId })
    : async () => ({ [store.entry.sessionId]: store.entry.chatId })
  const headerCardPath = realStore === null ? 'cards/host-card.json' : store.entry.cardPath
  const api = new Function(
    'readSessionMap', 'str', 'chatJournalStore', 'chatPersistence', 'worldBookScanDepth',
    'chatForSession', 'readChat', 'normalizeChat',
    'return { storyContext: ' + sliceFunction(seamSource(), 'storyContext') + ' }'
  )(
    sessionMap,
    String,
    wrappedStore,
    { read: async chatId => { spy.headerReads.push(chatId); return { cardPath: headerCardPath } } },
    async () => { spy.boundArgs.push('scan'); return store.scanDepth() },
    () => { spy.fallback.push('chatForSession'); return FALLBACK_WHOLE },
    () => { spy.fallback.push('readChat'); return FALLBACK_READ },
    authorNormalizeChat
  )
  return { api, spy }
}

/** hookChatForSession 真实宿主上下文：真 str/normalizeChat + 真 surfaceSyncedRevisions Map。 */
function hookApi(store) {
  const spy = { changeReads: [], calls: [], fallback: [] }
  const surfaceSyncedRevisions = new Map()
  const wrappedStore = {
    readStoryInput(chatId, need) {
      spy.calls.push({ chatId, need })
      const mode = Array.isArray(store._storyExitSeq) && store._storyExitSeq.length > 0 ? store._storyExitSeq.shift() : store._storyExitMode ?? 'value'
      if (mode === 'throw') throw new Error('夹具：store 出口显式失败')
      if (mode === 'undefined') return undefined
      return {
        chat: { ...store._storyChat, mode: store._storyMode ?? 'story', requestMode: store._storyRequestMode, messages: scopedRows(store._storyMessages, store._storyMessageCount, store._storyFrom) },
        messageCount: store._storyMessageCount, from: store._storyFrom, revision: store._storyRevision
      }
    }
  }
  const api = new Function(
    'readSessionMap', 'str', 'chatJournalStore', 'chatPersistence', 'surfaceSyncedRevisions',
    'worldBookScanDepth', 'chatForSession', 'normalizeChat',
    'return { hookChatForSession: ' + sliceFunction(seamSource(), 'hookChatForSession') + ' }'
  )(
    async () => ({ [store.sessionId]: store.chatId }),
    String,
    wrappedStore,
    {
      readChangedIndices: async (chatId, revision) => { spy.changeReads.push({ chatId, revision }); return store.changedFor(revision) },
      read: async () => ({ cardPath: 'cards/host-card.json' })
    },
    surfaceSyncedRevisions,
    async () => store.scanDepth(),
    () => { spy.fallback.push('chatForSession'); return FALLBACK_WHOLE },
    authorNormalizeChat
  )
  return { api, spy, surfaceSyncedRevisions }
}

test('S4 storyContext命中真store窗口且不回落完整档', async t => {
  // 全链贯通：宿主 storyContext 接缝 → **真 store 出口 readStoryInput**（只加记录包装）→ 真 chat-query-service → 真 SQLite 库。
  const real = storeFixture(t, { chatId: 'chat-story-host', sessionId: 'session-story-host', label: 'hit', protocol: true })
  const messages = storyMessages(60)      // 60>pageSize48 ⇒ 真出口给出有界首窗（from=12），可区分"有界窗口"与"整档"
  await real.store.update(real.chatId, () => CHAT({ chatId: real.chatId, sessionId: real.sessionId, messages }))
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 60, '前置：真 store 写入 60 条合成消息')
  assert.equal(stored.sessionId, 'session-story-host', '前置：身份由真库头字段给出')
  assert.equal(stored.cardPath, 'cards/host-card.json', '真库必须保留 cardPath（世界书绑定的输入）')
  assert.equal(stored.backgroundConfigVersion, 1, '真库必须保留 backgroundConfigVersion=1（作者适用性门槛）')
  assert.equal(stored.mode, 'story', '真库必须保留 mode=story')
  assert.equal(typeof real.store.readStoryInput, 'function', '真 store 必须已装配 S4 出口 readStoryInput')

  const store = stubStore({ entry: { chatId: real.chatId, sessionId: real.sessionId, cardPath: stored.cardPath } })
  const { api, spy } = storyContextApi(store, { realStore: real.store })
  const chat = await api.storyContext({ sessionId: 'session-story-host' })
  assert.equal(Boolean(chat), true, '命中必须返回 chat（不是 undefined）')
  assert.equal(chat.id, 'chat-story-host')
  // 宿主拿到的就是真出口的**有界**窗口：length=完整 messageCount，owned 仅首窗 48 楼，窗口外是 hole
  assert.equal(chat.messages.length, 60, 'length 必须是完整 messageCount（作者 scoped 语义）')
  assert.equal(chat.messages[12].text, 'msg-12', '首窗首楼按绝对坐标可读（真库消息）')
  assert.equal(chat.messages[59].text, 'msg-59', '首窗末楼按绝对坐标可读（真库消息）')
  assert.equal(chat.messages[11], undefined, '窗口外楼层是 hole：读作 undefined（真出口未物化完整档）')
  assert.equal(Object.keys(chat.messages).length, 48, 'owned 楼层恰 48（真 export 首窗），证明走的是有界窗口而非整档')
  assert.equal(Object.keys(chat.messages).includes('length'), false, 'ownKeys 不含 length（作者 scoped 语义）')
  assert.equal(chat.sessionId, 'session-story-host', '头字段必须来自真库')
  assert.equal(chat.mode, 'story')
  assert.equal(spy.calls.length, 1, '命中路径必须恰调用一次 store 出口')
  assert.equal(spy.calls[0].chatId, 'chat-story-host', 'sessionId 分支必须先把 session 映射成本档 chatId 再取数')
  assert.equal(spy.calls[0].need.sessionId, 'session-story-host')
  assert.equal(spy.calls[0].need.storyRows, 6, 'storyRows 必须是宿主事务外算好的 scanDepth+1（scanDepth=5）')
  assert.equal(spy.calls[0].need.lastAssistant, true)
  assert.equal(spy.calls[0].need.lastVariables, true)
  assert.deepEqual(Object.keys(spy.calls[0].need).sort(), ['lastAssistant', 'lastVariables', 'sessionId', 'storyRows'], '不额外发明 need 字段（enough/include/revision 属 hook 支路）')
  assert.deepEqual(spy.fallback, [], '命中时不得回落 chatForSession/readChat')
  // 显式 chatId 分支：直传同一 chatId，仍走真出口（不发明 sessionId ⇒ 身份门槛交给真库头字段）
  spy.calls.length = 0
  const byChatId = await api.storyContext({ chatId: 'chat-story-host' })
  assert.equal(spy.calls.length, 1)
  assert.equal(spy.calls[0].chatId, 'chat-story-host')
  assert.equal(spy.calls[0].need.sessionId, undefined, 'chatId 分支不发明 sessionId')
  assert.equal(byChatId.messages[59].text, 'msg-59', 'chatId 分支窗口同样来自真库消息')
  assert.equal(Object.keys(byChatId.messages).length, 48)
  // 真库真读：readWindow 契约（readStoryInput 的注入面）与真库一致
  const storeWindow = await real.store.readWindow(real.chatId, { limit: 48, includeCheckpoints: true, fields: ['_storageRevision'] })
  assert.equal(storeWindow.messageCount, 60, 'readWindow 必须给出真实完整 messageCount')
  assert.equal(typeof real.store.readWindow, 'function', '产品 store 必须暴露 readWindow（query 服务的注入面）')
  assert.equal(Number.isSafeInteger(storeWindow.revision), true, 'readWindow 必须带可 pin 的 revision')
  assert.equal(storeWindow.chat.messages.length, 48, 'readWindow limit48 ⇒ 48 楼（与出口首窗同源）')
  // 真出口的身份门槛由真库头字段把关：sessionId 不符 ⇒ undefined ⇒ 宿主显式回落（不静默给窗口）
  const wrongSession = await real.store.readStoryInput(real.chatId, { sessionId: 'other-session', storyRows: 6, lastAssistant: true })
  assert.equal(wrongSession, undefined, '真出口 sessionId 不符必须 undefined')
  // 作者谓词仍然生效：命中形状但 requestMode='sillytavern' ⇒ 回落（谓词未削弱）——这一支用注入桩给形状
  const sill = stubStore({ _storyChat: stored, _storyMessages: stored.messages, _storyMessageCount: 60, _storyRequestMode: 'sillytavern' })
  const third = storyContextApi(sill)
  await third.api.storyContext({ sessionId: 'session-story-host' })
  assert.deepEqual(third.spy.fallback, ['chatForSession'], 'requestMode=sillytavern ⇒ 回落完整档（作者谓词原文）')
})

test('S4 真store出口readStoryInput契约与作者scoped楼层对齐', async t => {
  // 直测主接线将要暴露的出口本体：真 SQLite 句柄（store 的权威库文件）＋产品 store 的 readWindow 注入面。
  const real = storeFixture(t, { chatId: 'chat-story-exit', sessionId: 'session-story-exit', label: 'exit' })
  const messages = storyMessages(60)
  await real.store.update(real.chatId, () => CHAT({ chatId: real.chatId, sessionId: real.sessionId, messages }))
  const readWindow = real.store.readWindow
  assert.equal(typeof readWindow, 'function', '产品 store 必须暴露 readWindow（出口注入面）')
  const handle = new DatabaseSync(real.store.rollbackArchivePath(real.chatId), { readOnly: true })
  try {
    // 作者世界楼定位 helper：本夹具最后一条是助手楼 ⇒ 视为已含最新变量楼（不降级成 undefined）
    const hasLastVariables = rows => rows.some(row => row?.role === 'assistant')
    const storedExit = await real.store.read(real.chatId)
    assert.equal(storedExit.sessionId, 'session-story-exit', '真库必须保留 sessionId（出口身份门槛）')
    assert.equal(storedExit.messages.length, 60, '真库消息数')
    const selected = await readStoryInput(handle, { chatId: real.chatId, sessionId: real.sessionId, need: { storyRows: 6, lastAssistant: true, lastVariables: true } },
      { readWindow, createScopedMessages, hasLastVariables })
    assert.equal(Boolean(selected), true, '真库满足条件时出口必须给出窗口（不是 undefined）')
    assert.equal(selected.messageCount, 60, 'messageCount 必须是完整楼层数')
    // 作者首窗语义（bounded-history.js:26-41）：首窗 = 最后 pageSize(48) 楼、from = count-48；
    // storyRows 6 在 48 楼内即 satisfied ⇒ 不向前翻页（不是"整档"）
    assert.equal(selected.from, 12, '首窗起点必须是 messageCount-48（作者 pageSize 语义，满足即停）')
    const snapshot = await real.store.readWindow(real.chatId, { limit: 1, includeCheckpoints: true })
    assert.equal(selected.revision, snapshot.revision, 'revision 必须与同一快照一致')
    assert.equal(selected.chat.messages.length, 60, '窗口 length 是完整 messageCount（作者 scoped 语义）')
    assert.equal(selected.chat.messages[12].text, 'msg-12', '窗口首楼按绝对坐标可读（真库消息）')
    assert.equal(selected.chat.messages[59].text, 'msg-59', '窗口末楼按绝对坐标可读（真库消息）')
    assert.equal(selected.chat.messages[11], undefined, '窗口外楼层是 hole：读作 undefined（不物化完整档）')
    assert.equal(Object.keys(selected.chat.messages).length, 48, 'owned 楼层恰 48（窗口大小，不是 60）')
    assert.equal(selected.chat.sessionId, 'session-story-exit', '头字段必须来自真库')
    // 深度非法（NaN）⇒ 显式 undefined（宿主随之整档）
    const bad = await readStoryInput(handle, { chatId: real.chatId, need: { storyRows: Number.NaN, lastAssistant: true } }, { readWindow, createScopedMessages, hasLastVariables })
    assert.equal(bad, undefined, '非法深度必须 undefined，不得猜窗口')
    // 身份不符 ⇒ 显式 undefined
    const wrongSession = await readStoryInput(handle, { chatId: real.chatId, sessionId: 'other-session', need: { storyRows: 6 } }, { readWindow, createScopedMessages, hasLastVariables })
    assert.equal(wrongSession, undefined, 'sessionId 不符必须 undefined（走宿主显式兼容分支）')
  } finally { handle.close() }
})

test('S4 storyContext未命中时显式回落完整档', async t => {
  // ① 出口返回 undefined（store 判定不适用）⇒ 先真调用过出口，再显式回落 chatForSession
  const undefinedCase = storyContextApi(stubStore(), { storeMode: 'undefined' })
  const chatA = await undefinedCase.api.storyContext({ sessionId: 'session-story-host' })
  assert.equal(undefinedCase.spy.calls.length, 1, 'undefined 也必须真调用过 store 出口（不跳过判定）')
  assert.deepEqual(undefinedCase.spy.fallback, ['chatForSession'], 'undefined ⇒ 显式走 chatForSession 回落支路')
  assert.equal(chatA, FALLBACK_WHOLE, 'undefined ⇒ 返回 chatForSession 原文结果（同一对象）')
  // ② chatId 分支回落 readChat
  const byChatId = storyContextApi(stubStore(), { storeMode: 'undefined' })
  const chatB = await byChatId.api.storyContext({ chatId: 'chat-story-host' })
  assert.deepEqual(byChatId.spy.fallback, ['readChat'], 'chatId 分支 undefined ⇒ 显式走 readChat 回落支路')
  assert.equal(chatB, FALLBACK_READ, 'chatId 分支 undefined ⇒ 返回 readChat 原文结果')
  // ③ 世界书不可读（深度 Infinity）⇒ **不**调用 store 出口，直接回落
  const deep = storyContextApi(stubStore({ scanDepth: async () => Infinity }))
  await deep.api.storyContext({ sessionId: 'session-story-host' })
  assert.deepEqual(deep.spy.calls, [], 'Infinity 深度不得调用 store 出口（调用方随之整档）')
  assert.deepEqual(deep.spy.fallback, ['chatForSession'], 'Infinity ⇒ 走 chatForSession 回落支路')
  // ④ 出口抛错必须上抛（不 catch-all 转回落，不吞错）
  const broken = storyContextApi(stubStore(), { storeMode: 'throw' })
  await assert.rejects(() => broken.api.storyContext({ sessionId: 'session-story-host' }), /夹具：store 出口显式失败/, 'store 出口错误必须上抛')
  assert.deepEqual(broken.spy.fallback, [], '抛错路径不得回落（错误不得被吞）')
  // ⑤ 无 session 链接（readSessionMap 无该 session）⇒ 不调用出口，回落
  const noLink = storyContextApi(stubStore({ sessionId: 'other-session' }))
  await noLink.api.storyContext({ sessionId: 'session-story-host' })
  assert.deepEqual(noLink.spy.calls, [], '无 session 链接不得调用 store 出口')
  assert.deepEqual(noLink.spy.fallback, ['chatForSession'], '无 session 链接 ⇒ 走 chatForSession 回落支路')
  void t
})

test('S4 hookChatForSession首钩整档与两次重试语义保持', async t => {
  const source = seamSource()
  // 逐字保留物①：mvuReplies 谓词——与**作者原文**（固定树 index.js:2861）逐字相同
  const predicate = "const mvuReplies = rows => rows.filter(row => row?.role === 'assistant' && row.variables?.[Math.max(0, Number(row.swipeId) || 0)]?.stat_data !== undefined).length >= 2"
  const authorSource = readFileSync(new URL(AUTHOR68215 + 'index.js', import.meta.url), 'utf8')
  const transform = readFileSync(new URL('../deploy/native-data-transform.mjs', import.meta.url), 'utf8')
  assert.equal(authorSource.split(predicate).length - 1, 1, '作者原文里 mvuReplies 谓词恰一处（比对基线）')
  assert.equal(transform.split(predicate).length - 1, 2, '转换器里该谓词恰两处（锚点原文＋替换文本，两处都逐字）')
  assert.equal(source.split(predicate).length - 1, 1, '生成物里恰一处，且逐字等于作者原文（判据未被改写）')
  // 逐字保留物②：readChangedIndices 增量调用与 attempt<2 上限（生成物里各一处）
  assert.equal(authorSource.includes('const changed = await chatPersistence.readChangedIndices(chatId, synced)'), true, '作者原文含该增量调用（比对基线）')
  assert.equal(source.split('const changed = await chatPersistence.readChangedIndices(chatId, synced)').length - 1, 1, 'readChangedIndices 增量调用必须逐字保留')
  assert.equal(source.includes('attempt < 2'), true, 'attempt<2 重试上限必须保留')

  // ① 首钩 synced===undefined：不碰 store、不求深度，整档基线 + 记忆 _storageRevision
  const first = stubStore({ scanDepth: async () => { throw new Error('首钩不得求深度') } })
  const hookA = hookApi(first)
  const chatA = await hookA.api.hookChatForSession('session-story-host')
  assert.equal(chatA, FALLBACK_WHOLE, '首钩必须原样走 chatForSession（作者整档基线）')
  assert.deepEqual(hookA.spy.calls, [], '首钩不得调用 store 出口')
  assert.deepEqual(hookA.spy.changeReads, [], '首钩不得读变更索引')
  assert.equal(hookA.surfaceSyncedRevisions.get('session-story-host'), undefined, '回落档无 _storageRevision ⇒ 不记忆')

  // ② 已同步 + 出口第一次 undefined（＝变更记录与窗口读之间发生写入）⇒ attempt<2 重试，第二次命中
  const retry = stubStore({ _storyExitSeq: ['undefined', 'value'] })
  const hookB = hookApi(retry)
  hookB.surfaceSyncedRevisions.set('session-story-host', 9)
  const chatB = await hookB.api.hookChatForSession('session-story-host')
  assert.deepEqual(hookB.spy.changeReads, [{ chatId: 'chat-story-host', revision: 9 }, { chatId: 'chat-story-host', revision: 9 }], '增量必须以记忆值 9 为基线读两次（attempt<2）')
  assert.equal(hookB.spy.calls.length, 2, '出口第一次 undefined 后必须重试第二次')
  assert.equal(hookB.spy.calls[0].need.revision, 11, '两次都以本次 changed.revision pin')
  assert.equal(hookB.spy.calls[1].need.revision, 11, 'revision 必须取本次 changed.revision（pin 同一快照）')
  assert.deepEqual(hookB.spy.calls[1].need.include, [3, 5], 'include 必须是变更索引原文')
  assert.equal(hookB.spy.calls[1].need.storyRows, 6, 'storyRows 必须是外部算好的 scanDepth+1')
  assert.equal(typeof hookB.spy.calls[1].need.enough, 'function', 'enough 谓词必须由宿主注入（mvuReplies）')
  assert.deepEqual(hookB.spy.fallback, [], '命中路径不得回落 chatForSession')
  assert.equal(hookB.surfaceSyncedRevisions.get('session-story-host'), 11, '命中后必须记忆命中 chat 的 _storageRevision')
  assert.equal(chatB._storageRevision, 11)

  // ③ enough 就是作者 mvuReplies 语义（≥2 条带 stat_data 的助手楼）——用真 scoped 楼层（hole 语义）对账
  const enough = hookB.spy.calls[1].need.enough
  const twoMvu = createScopedMessages(4, [[0, { role: 'assistant', variables: [{ stat_data: { hp: 1 } }] }], [2, { role: 'assistant', variables: [{ stat_data: { hp: 2 } }] }]])
  const oneMvu = createScopedMessages(4, [[0, { role: 'assistant', variables: [{ stat_data: { hp: 1 } }] }], [2, { role: 'user', variables: [{ stat_data: { hp: 2 } }] }]])
  assert.equal(enough(twoMvu), true, '两条带 stat_data 的助手楼 ⇒ 满足（作者谓词等价）')
  assert.equal(enough(oneMvu), false, '仅一条 ⇒ 不足（hole 楼层读作 undefined，不误判）')
  // 作者他自己的楼层谓词同输入同结果（判据未削弱）
  const rows = [{ role: 'user', greeting: true }, { role: 'assistant' }, undefined]
  assert.equal(scannedStoryRows(rows, 1), true, '作者 scannedStoryRows 对 hole/undefined 楼层的容错与改造前一致')

  // ④ 命中形状但作者谓词不满足（mode card）⇒ 回落 chatForSession 且不覆盖记忆
  const hookC = hookApi(stubStore({ _storyMode: 'card' }))
  hookC.surfaceSyncedRevisions.set('session-story-host', 9)
  await hookC.api.hookChatForSession('session-story-host')
  assert.deepEqual(hookC.spy.fallback, ['chatForSession'], 'mode 不满足 ⇒ 回落完整档')
  assert.equal(hookC.surfaceSyncedRevisions.get('session-story-host'), 9, '回落档无 _storageRevision ⇒ 记忆保持不变')
  // ⑤ 深度 Infinity ⇒ 不调用出口，直接回落
  const hookD = hookApi(stubStore({ scanDepth: async () => Infinity }))
  hookD.surfaceSyncedRevisions.set('session-story-host', 9)
  await hookD.api.hookChatForSession('session-story-host')
  assert.deepEqual(hookD.spy.calls, [], 'Infinity 深度不得调用 store 出口')
  assert.deepEqual(hookD.spy.fallback, ['chatForSession'])
  // ⑥ changed 无 indices ⇒ 一次都不调出口，仍回落
  const hookE = hookApi(stubStore({ changedFor: () => undefined }))
  hookE.surfaceSyncedRevisions.set('session-story-host', 9)
  await hookE.api.hookChatForSession('session-story-host')
  assert.deepEqual(hookE.spy.calls, [], 'changed 无 indices ⇒ 不得调用 store 出口')
  assert.deepEqual(hookE.spy.fallback, ['chatForSession'])
})

test('S4 两链不再直连boundedHistory且normalizeChat就地等价', async t => {
  const source = seamSource()
  // ① normalizeChat 逐字复用作者原文：就地 mutate、返回同一对象（作者 :783-799）
  const mutable = { mode: 'revision', requestMode: 'sillytavern', macroState: null }
  const same = authorNormalizeChat(mutable)
  assert.equal(same, mutable, 'normalizeChat 必须就地 mutate 返回同一对象')
  assert.equal(mutable.mode, 'card', 'revision ⇒ card（作者 785）')
  assert.equal(mutable.requestMode, 'sillytavern', 'sillytavern 语义必须保留（作者 786 条件式，不改请求模式）')
  assert.equal(mutable.cardPath, '', '缺 cardPath ⇒ 补空串')
  assert.deepEqual(mutable.macroState, { userName: '你', local: {}, global: {} })
  assert.equal(Object.hasOwn(mutable, 'workspace'), true, 'card 档必须补 workspace（作者 792-797）')
  const plain = authorNormalizeChat({ mode: 'story', macroState: { userName: 'User', local: null, global: null } })
  assert.equal(plain.mode, 'story', 'story 档 mode 不动')
  assert.equal(plain.macroState.userName, '你', 'User ⇒ 你（作者 789）')
  assert.deepEqual(plain.macroState.local, {})
  // ② 生成物两条链不再直接调 boundedHistory（范围选择已移交 store 出口）
  const storyBody = sliceFunction(source, 'storyContext')
  const hookBody = sliceFunction(source, 'hookChatForSession')
  assert.equal(storyBody.includes('boundedHistory'), false, 'storyContext 不得再直接调 boundedHistory')
  assert.equal(hookBody.includes('boundedHistory'), false, 'hookChatForSession 不得再直接调 boundedHistory')
  // S4 锚点标记恰一处，且紧邻 storyContext 声明之前（同一接缝；标记在函数体外，故不在切出体里）
  const lines = source.split('\n')
  const markerAt = lines.findIndex(line => line.trim() === STORY_INPUT_MARKER)
  const storyAt = lines.findIndex(line => line.includes('async function storyContext({ sessionId, chatId })'))
  assert.equal(source.split(STORY_INPUT_MARKER).length - 1, 1, 'S4 锚点标记恰一处')
  assert.equal(storyAt, markerAt + 1, '标记必须紧邻 storyContext 声明之前（S4 接缝位置）')
  assert.equal(lines[markerAt], '  ' + STORY_INPUT_MARKER, '标记行缩进必须与声明行一致（替换落在原声明行位置）')
  // ③ 切出的函数体确实是完整改造版（不是空体/被截断），且依赖面就是本闸注入的名字
  for (const [body, required] of [
    [storyBody, ['readStoryInput', 'worldBookScanDepth', 'chatForSession', 'readChat', 'normalizeChat']],
    [hookBody, ['readStoryInput', 'worldBookScanDepth', 'chatForSession', 'readChangedIndices', 'normalizeChat', 'surfaceSyncedRevisions']]
  ]) {
    assert.equal(body.split('\n').at(-1), '  }', '切出的函数体必须以行首两空格 "  }" 收口（未被截断）')
    for (const token of required) assert.equal(body.includes(token), true, '切出的函数体必须含 ' + token)
  }
  // ④ 幂等：已应用源码再施缝仍是同一字节（半应用/重复施缝不得改变产物）
  assert.equal(applyNativeDataTransform(source, { projectorImportPath: './domain/storage-native-data.js' }), source)
  void t
})
