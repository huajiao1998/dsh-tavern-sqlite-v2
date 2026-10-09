// S4 模板链宿主接线具名断言（reader 级，2026-10-08 主复核返工后重写）：
//   施缝后作者 index.js:1647 整行换成 `resolveTemplateWindow: (() => { …查出口…; return
//   chatJournalStore.readTemplateWindowReader({ links, access, historyFrom }) })()`——**reader 级**委托：
//   插件出口返回与作者 reader 同形的 `async sessionId => {chat,historyWindow}|undefined`，宿主只交出三件闭包输入
//   （links 解析 / access 票据签发 / historyFrom 游标）。返工理由：窗口级出口与 A 的 reader 级实现组装不上，
//   且作者 readWindow 传输层本就是原生（换实参省不掉任何东西）。
// 范围（deploy/native-data-transform.mjs ⑩ S4-5）——
//   ① 委托恰一次、装配期求值、构造块不再引用作者 createTemplateWindowReader、reader 返回值原样透传（含 undefined）；
//   ② 出口缺失/非函数 ⇒ **装配期**响亮抛错（不留静默整档的 reader）；
//   ③ links 解析与 access 票据签发由出口经宿主闭包原样使用（helperHistoryAccess.issue 被真调用）；
//   ④ historyFrom 闭包 + 真库窗口透传：出口用作者真 reader（真 store.readWindow）时给出作者形状窗口。
// 不跑：候选/结算/story/opening/活动摘要链。不读真实档/远端/禁令对象；合成数据；只清自建 mkdtemp。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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

// 作者 template-window-reader.js → bounded-history.js → tavern-helper-context.js 传递性 import 未安装的
// jsdom/marked/yaml：按既有 native-story-input.test.mjs 机制只重定向该 fixture 树内解析不到的裸说明符。
const testRequire = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/release-034-20261008/author-fixture/')
      || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:')) throw error
    return next(pathToFileURL(testRequire.resolve(specifier)).href, context)
  }
} })

const { createTemplateWindowReader } = await import(new URL('template-window-reader.js', AUTHOR68215))
const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
assert.equal(typeof createTemplateWindowReader, 'function', '作者 createTemplateWindowReader 缺失：无法作为"同形出口"对照')
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused
for (const [name, fn] of Object.entries(HELPERS)) assert.equal(typeof fn, 'function', '作者 helper ' + name + ' 缺失：夹具无法对账')

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

/** 取带标记的生成整块（标记行 + 到终止行为止），去掉注释行。 */
function markedBlock(source, marker, terminator) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.includes(marker))
  assert.ok(start >= 0, '生成物缺三链标记：' + marker)
  const end = lines.findIndex((line, index) => index > start && line.trimEnd().endsWith(terminator))
  assert.ok(end > start, '生成物缺该块终止行：' + terminator)
  return lines.slice(start, end + 1).filter(line => !line.trimStart().startsWith('//')).join('\n')
}

function storeFixture(t, { chatId, sessionId, label }) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-template-store-' + label + '-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, sessionId, store }
}

const CHAT_ID = 'chat-template-host'
const SESSION_ID = 'session-template-host'
const CHAT = {
  id: CHAT_ID, sessionId: SESSION_ID, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  _storageRevision: 9, updatedAt: 1, cardPath: 'cards/host-card.json',
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 3, participants: {}, operations: {} },
  messages: Array.from({ length: 90 }, (_v, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1 }))
}

/** 执行施缝后的真实消费点（reader 级）：注入 chatJournalStore / readSessionMap / helperHistoryAccess / templateHistoryFrom。
 *  readerFactory !== null 时作为出口实现（mock 或"同形作者 reader"）；null ⇒ 空 store（出口缺失）；
 *  storeOverride 给出时直接充当 chatJournalStore（用于表达"出口缺失/非函数/旧窗口级出口"等装配期分支）。 */
function templateApi({ source, readerFactory, storeOverride, templateHistoryFrom = new Map(), sessionMap = { [SESSION_ID]: CHAT_ID } }) {
  const spy = { factoryCalls: [], linkCalls: [], issues: [] }
  const chatJournalStore = storeOverride !== undefined ? storeOverride : (readerFactory === null ? {} : {
    readTemplateWindowReader(args) { spy.factoryCalls.push(args); return readerFactory(args) }
  })
  const block = markedBlock(source, CHAIN_MARKER.template, '})(),')
  const api = new Function(
    'chatJournalStore', 'readSessionMap', 'helperHistoryAccess', 'templateHistoryFrom',
    'return {' + block + '}'
  )(
    chatJournalStore,
    async () => { spy.linkCalls.push('links'); return sessionMap },
    { issue: input => { spy.issues.push(input); return { ticket: 'ticket-' + input.chatId } } },
    templateHistoryFrom
  ).resolveTemplateWindow
  return { api, spy }
}

test('S4模板reader级委托恰一次且返回值原样透传', async t => {
  const source = seamSource()
  const sentinel = { chat: CHAT, historyWindow: { ticket: 'ticket-x', from: 0, messageCount: 90 } }
  const { api, spy } = templateApi({
    source,
    readerFactory: args => {
      assert.deepEqual(Object.keys(args).sort(), ['access', 'historyFrom', 'links'], '出口只应收 {links,access,historyFrom} 三件闭包输入（不再有窗口级参数）')
      return async sessionId => (sessionId === SESSION_ID ? sentinel : undefined)
    }
  })
  assert.equal(spy.factoryCalls.length, 1, '装配期必须恰调用一次出口工厂（reader 级委托）')
  assert.equal(typeof api, 'function', 'resolveTemplateWindow 必须是出口返回的 reader 函数')
  assert.equal(await api(SESSION_ID), sentinel, 'reader 返回值必须原样透传（宿主不二次组装）')
  assert.equal(await api('other-session'), undefined, 'undefined 必须原样透传（宿主不兜底整档、不抛错）')
  const block = markedBlock(source, CHAIN_MARKER.template, '})(),')
  assert.equal(block.includes('createTemplateWindowReader('), false, '模板块不得再引用作者 createTemplateWindowReader')
  assert.equal(block.includes('readWindow'), false, '模板块不得再出现窗口级 readWindow（层级错位已修正）')
  assert.equal(source.split(CHAIN_MARKER.template).length - 1, 1, '模板块标记恰一处')
  void t
})

test('S4模板reader出口缺失时装配期响亮失败', async t => {
  const source = seamSource()
  assert.throws(() => templateApi({ source, storeOverride: {} }), /宿主接线缺失：chatJournalStore\.readTemplateWindowReader 未装配/, '出口缺失必须在装配期抛错（不留静默整档的 reader）')
  assert.throws(() => templateApi({ source, storeOverride: { readTemplateWindowReader: undefined } }), /宿主接线缺失：chatJournalStore\.readTemplateWindowReader 未装配/, '出口为 undefined 同样装配期抛错')
  assert.throws(() => templateApi({ source, storeOverride: { readTemplateWindowReader: 42 } }), /宿主接线缺失：chatJournalStore\.readTemplateWindowReader 未装配/, '出口非函数必须装配期抛错（typeof 守卫，不靠 TypeError）')
  // 只有**旧窗口级**出口假装在位（readTemplateWindow 而非 readTemplateWindowReader）⇒ 同样装配期抛错（层级错位不得静默通过）
  assert.throws(() => templateApi({ source, storeOverride: { readTemplateWindow: async () => null } }), /宿主接线缺失：chatJournalStore\.readTemplateWindowReader 未装配/, '旧窗口级出口在位也必须装配期抛错（层级错位显式暴露）')
  void t
})

test('S4模板reader的links与access票据由宿主闭包透传', async t => {
  const source = seamSource()
  const { api, spy } = templateApi({
    source,
    readerFactory: args => async sessionId => {
      const chatId = (await args.links())[String(sessionId)]      // 出口用宿主交出的 links 解析（同作者语义）
      if (!chatId) return undefined
      const ticket = args.access.issue({ chatId, revision: 9, messageCount: 90 })   // 票据签发仍是宿主那一份
      return { chat: { id: chatId, sessionId }, historyWindow: { ...ticket, from: 0, messageCount: 90 } }
    }
  })
  const result = await api(SESSION_ID)
  assert.deepEqual(spy.linkCalls, ['links'], '出口必须经宿主交出的 links 解析 session（恰一次）')
  assert.deepEqual(spy.issues, [{ chatId: CHAT_ID, revision: 9, messageCount: 90 }], 'access.issue 必须真走宿主 helperHistoryAccess.issue（input 原样）')
  assert.equal(result.historyWindow.ticket, 'ticket-' + CHAT_ID, '票据由宿主签发并进入出口返回形状')
  assert.equal(result.chat.id, CHAT_ID)
  assert.equal(await api('other-session'), undefined, 'links 无该 session ⇒ 出口返回 undefined 并原样透传')
  void t
})

test('S4模板reader的historyFrom闭包与真库窗口透传', async t => {
  const source = seamSource()
  const real = storeFixture(t, { chatId: CHAT_ID, sessionId: SESSION_ID, label: 'db' })
  await real.store.update(real.chatId, () => CHAT)
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 90, '前置：真库写入 90 楼')
  // 出口＝作者真 reader（readWindow 用真 store ⇒ 真库窗口），只吃宿主交出的 links/access/historyFrom
  const historyFromCalls = []
  const templateHistoryFrom = new Map([[SESSION_ID, 0]])
  const { api, spy } = templateApi({
    source,
    templateHistoryFrom,
    readerFactory: args => createTemplateWindowReader({
      links: args.links,
      readWindow: (id, options) => real.store.readWindow(id, options),
      access: args.access,
      historyFrom: sessionId => { historyFromCalls.push(sessionId); return args.historyFrom(sessionId) }
    })
  })
  const result = await api(SESSION_ID)
  assert.deepEqual(historyFromCalls, [SESSION_ID], '出口必须经宿主交出的 historyFrom 取游标（恰一次，sessionId 原样）')
  assert.equal(templateHistoryFrom.get(SESSION_ID), 0, '游标 Map 由宿主持有并原样可读（未被复制/改写）')
  assert.equal(typeof result, 'object', '出口必须给出作者形状窗口')
  assert.equal(result.chat.sessionId, SESSION_ID, '真库窗口身份一致')
  assert.equal(result.chat.messages[89].text, 'msg-89', '真库末楼到达模板消费点')
  assert.equal(result.historyWindow.from, 0)
  assert.equal(result.historyWindow.messageCount, 90, '无 promptTemplateInput.message ⇒ 不加虚拟用户消息（作者语义在出口内）')
  assert.equal(result.historyWindow.ticket, 'ticket-' + CHAT_ID, '票据仍由宿主 access 签发')
  assert.equal(spy.factoryCalls.length, 1)
  const realExitWired = typeof real.store.readTemplateWindowReader === 'function'
  if (!realExitWired) console.log('native-template-host: chatJournalStore.readTemplateWindowReader 尚未装配（主接线缺口），本闸按冻结接口注入同形出口')
  void realExitWired
  void t
})

test('S4模板真出口直连全链贯通', async t => {
  // 全链：施缝后 resolveTemplateWindow → **真 store 出口 readTemplateWindowReader**（只加记录包装）→
  // 真 chat-query-service → 真 SQLite 库；links／票据签发／historyFrom 三件闭包仍由宿主注入（真 links map＋计数桩）。
  const source = seamSource()
  const real = storeFixture(t, { chatId: CHAT_ID, sessionId: SESSION_ID, label: 'exit' })
  await real.store.update(real.chatId, () => CHAT)
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 90, '前置：真库写入 90 楼')
  assert.equal(typeof real.store.readTemplateWindowReader, 'function', '真 store 必须已装配 S4 出口 readTemplateWindowReader')
  const factoryCalls = []
  const realFactory = real.store.readTemplateWindowReader.bind(real.store)
  const chatJournalStore = { readTemplateWindowReader(args) { factoryCalls.push(args); return realFactory(args) } }
  const linkCalls = [], issueCalls = [], historyFromCalls = []
  const sessionMap = { [SESSION_ID]: CHAT_ID }
  const templateHistoryFrom = new Map([[SESSION_ID, 0]])
  const block = markedBlock(source, CHAIN_MARKER.template, '})(),')
  const api = new Function('chatJournalStore', 'readSessionMap', 'helperHistoryAccess', 'templateHistoryFrom',
    'return {' + block + '}')(
    chatJournalStore,
    async () => { linkCalls.push('links'); return sessionMap },
    { issue: input => { issueCalls.push(input); return { ticket: 'ticket-' + input.chatId } } },
    { get: key => { historyFromCalls.push(key); return templateHistoryFrom.get(key) } }
  ).resolveTemplateWindow
  assert.equal(factoryCalls.length, 1, '装配期必须恰调用一次真出口工厂')
  assert.deepEqual(Object.keys(factoryCalls[0]).sort(), ['access', 'historyFrom', 'links'], '真出口只收三件闭包输入')
  const result = await api(SESSION_ID)
  assert.deepEqual(linkCalls, ['links'], '真出口必须经宿主 links 解析 session（恰一次）')
  assert.deepEqual(historyFromCalls, [SESSION_ID], '真出口必须经宿主 historyFrom 取游标（恰一次，sessionId 原样）')
  assert.equal(templateHistoryFrom.get(SESSION_ID), 0, '游标由宿主持有（值未被改写）')
  assert.equal(typeof result, 'object', '真出口命中必须给出作者形状窗口')
  assert.equal(result.chat.sessionId, SESSION_ID, '真出口返回的 chat 身份来自真库')
  assert.equal(result.chat.messages[89].text, 'msg-89', '真库末楼文本一致')
  assert.equal(Number.isSafeInteger(result.chat._storageRevision), true, '真库 _storageRevision 可核')
  assert.deepEqual(issueCalls, [{ chatId: CHAT_ID, revision: result.chat._storageRevision, messageCount: 90 }], '票据仍由宿主 access 签发（input 取真库 revision/messageCount）')
  assert.equal(result.historyWindow.ticket, 'ticket-' + CHAT_ID, '票据进入窗口形状')
  assert.equal(result.historyWindow.from, 0, 'historyFrom=0（extended）⇒ 真出口给到档首')
  assert.equal(result.historyWindow.messageCount, 90, '无 promptTemplateInput.message ⇒ 不加虚拟用户消息')
  // 真出口的 session 门槛：links 无该 session ⇒ undefined（不整档、不抛错）
  const noLink = new Function('chatJournalStore', 'readSessionMap', 'helperHistoryAccess', 'templateHistoryFrom',
    'return {' + block + '}')(
    chatJournalStore, async () => ({}), { issue: () => ({ ticket: 't' }) }, new Map()
  ).resolveTemplateWindow
  assert.equal(await noLink(SESSION_ID), undefined, '真出口在 links 无该 session 时必须 undefined')
  // 真出口对无档：undefined
  const missing = await real.store.readTemplateWindowReader({
    links: async () => ({ [SESSION_ID]: 'no-such-chat' }), access: { issue: () => ({ ticket: 't' }) }, historyFrom: () => undefined
  })(SESSION_ID)
  assert.equal(missing, undefined, '真出口对无档必须 undefined')
  void t
})
