// S4 结算链宿主接线具名断言（只写后逐条 gate）：施缝后的**真实消费点**（作者 index.js:2930 的
//   runSettlement 取数行）已由插件原生出口 chatJournalStore.readSettlementInput 提供，宿主只在
//   出口 fallback 时显式回作者 readChat（完整档兼容），不再直连作者 readWindow（timeline 窄化在插件侧）。
// 范围：结算取数替换（deploy/native-data-transform.mjs ⑩ S4-4）——
//   ① kind:'value' ⇒ 返回出口给的 chat（同一对象），出口恰收到 {scanDepth: worldBookScanDepth}；
//   ② kind:'fallback' ⇒ **显式**返回作者 readChat(chatId)（同 chatId），不 catch-all；
//   ③ 出口缺失/形状非法/kind 未知 ⇒ 响亮抛错（不静默整档、不猜）；
//   ④ 生成块里不再出现作者 readWindow 实参（结算刀＝timeline 窄化的落点）；
//   ⑤ 真 store 夹具下 value 就是真库读回的 chat（含真库 revision/楼层）。
// 不跑：未受影响链（story/候选/模板/opening/活动摘要）。不读真实档/远端/禁令对象；合成数据；只清自建 mkdtemp。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAuthorCleanImages } from '../deploy/maintenance/residual-uninstall.mjs'
import { applyStandardSeams } from '../deploy/standard-seams.mjs'
import { isNativeDataApplied, CHAIN_MARKER } from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { AUTHOR_VERSION } from '../lib/standard-host.js'

const TARGET = '68215e47516637e00c75d2b4bba3192679559425'
const INDEX = 'tavern-plugin/lib/index.js'
const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

// 真 store 出口 readSettlementInput 调用期要求的协议 helper（scoped 楼层形状，与作者同一份实现）
const { createScopedMessages } = await import(new URL('scoped-messages.js', AUTHOR68215))
assert.equal(typeof createScopedMessages, 'function', '作者 createScopedMessages 缺失：真出口协议形状无法注入')

const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused
for (const [name, fn] of Object.entries(HELPERS)) assert.equal(typeof fn, 'function', '作者 helper ' + name + ' 缺失：夹具无法对账')

let SEAM = null
function seamSource() {
  if (SEAM !== null) return SEAM
  const tree = loadAuthorCleanImages().trees.find(item => item.commit === TARGET)
  assert.ok(tree, '缺官方作者树：' + TARGET)
  const appDir = mkdtempSync(path.join(tmpdir(), 'native-settlement-host-'))
  test.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  const indexFile = path.join(appDir, ...INDEX.split('/'))
  assert.equal(isNativeDataApplied(readFileSync(indexFile, 'utf8')), false, '前置：作者原字节不应已应用 native-data 转换')
  assert.equal(applyStandardSeams({ appDir, authorVersion: AUTHOR_VERSION }).changed, true)
  SEAM = readFileSync(indexFile, 'utf8')
  assert.equal(isNativeDataApplied(SEAM), true, '装配后实际 index 必须已应用 native-data 转换')
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

function storeFixture(t, { chatId, sessionId, label, protocol = false }) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-settlement-store-' + label + '-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const helpers = protocol ? { ...HELPERS, createScopedMessages } : HELPERS
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, sessionId, store }
}

const CHAT_ID = 'chat-settlement-host'
const SESSION_ID = 'session-settlement-host'
const CHAT = {
  id: CHAT_ID, sessionId: SESSION_ID, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  _storageRevision: 7, updatedAt: 1, cardPath: 'cards/host-card.json',
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 4, participants: {}, operations: {}, checkpoints: [] },
  messages: Array.from({ length: 200 }, (_v, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1,
    ...(index === 199 ? { mvu: { pending: true } } : {})
  }))
}
const FALLBACK_SENTINEL = { id: CHAT_ID, source: '作者 readChat 整档' }

/** 执行施缝后的真实取数行：注入 chatId / chatJournalStore / readChat / worldBookScanDepth，返回 snapshot。
 *  生成块含顶层 await ⇒ 必须包在 async IIFE 里（`new Function` 体本身不是 async）。 */
function settlementApi({ source, exit, scanDepth, readChat }) {
  const spy = { exitCalls: [], readChat: [] }
  const block = markedBlock(source, CHAIN_MARKER.settlement, '})()')
  const chatJournalStore = exit === null ? {} : {
    readSettlementInput(chatId, need) { spy.exitCalls.push({ chatId, need }); return exit(chatId, need) }
  }
  const api = new Function('chatId', 'chatJournalStore', 'readChat', 'worldBookScanDepth',
    'return async () => {\n' + block + '\nreturn snapshot\n}')(
    CHAT_ID,
    chatJournalStore,
    async id => { spy.readChat.push(id); return readChat ? readChat(id) : FALLBACK_SENTINEL },
    scanDepth
  )
  return { api, spy }
}

test('S4结算取数命中原生出口且传入宿主世界书深度', async t => {
  const source = seamSource()
  const scanDepth = async () => 4
  const { api, spy } = settlementApi({ source, exit: async () => ({ kind: 'value', chat: CHAT }), scanDepth })
  const snapshot = await api()
  assert.equal(snapshot, CHAT, 'kind:value ⇒ 必须直接返回出口给的 chat（同一对象，不再由宿主组装）')
  assert.equal(spy.exitCalls.length, 1, '取数必须恰一次走原生出口')
  assert.equal(spy.exitCalls[0].chatId, CHAT_ID)
  assert.deepEqual(Object.keys(spy.exitCalls[0].need), ['scanDepth'], '出口只收 {scanDepth}：窗口/整档策略归插件侧')
  assert.equal(spy.exitCalls[0].need.scanDepth, scanDepth, 'scanDepth 必须是宿主的 worldBookScanDepth 本体（世界书深度仍在事务外求）')
  assert.deepEqual(spy.readChat, [], '命中不得走作者 readChat')
  assert.equal(snapshot.messages[199].mvu.pending, true, '取数结果保留待结算楼（作者判据所依赖的输入）')
  void t
})

test('S4结算取数fallback显式回作者readChat', async t => {
  const source = seamSource()
  const { api, spy } = settlementApi({ source, exit: async () => ({ kind: 'fallback' }), scanDepth: async () => 4 })
  const snapshot = await api()
  assert.equal(snapshot, FALLBACK_SENTINEL, 'kind:fallback ⇒ 必须显式返回作者 readChat 结果')
  assert.deepEqual(spy.readChat, [CHAT_ID], 'fallback 必须用同一 chatId 调作者 readChat（完整档兼容路径）')
  assert.equal(spy.exitCalls.length, 1, 'fallback 前必须真调用过出口（不跳过判定）')
  // 作者原语义：整档读到不存在档时 readChat 返回 undefined ⇒ 调用方 `if (snapshot === undefined) return` 照旧
  const missing = settlementApi({ source, exit: async () => ({ kind: 'fallback' }), scanDepth: async () => 4, readChat: async () => undefined })
  assert.equal(await missing.api(), undefined, 'fallback 且无该档 ⇒ undefined（与作者 readChat 缺失档语义一致）')
  assert.deepEqual(missing.spy.readChat, [CHAT_ID], '无档兜底也必须真调 readChat（不伪造 undefined）')
  void t
})

test('S4结算取数出口缺失或形状非法时响亮失败', async t => {
  const source = seamSource()
  const missing = settlementApi({ source, exit: null, scanDepth: async () => 4 })
  await assert.rejects(() => missing.api(), /宿主接线缺失：chatJournalStore\.readSettlementInput 未装配/, '出口缺失必须响亮抛错')
  const notObject = settlementApi({ source, exit: async () => undefined, scanDepth: async () => 4 })
  await assert.rejects(() => notObject.api(), /未知形状/, 'undefined/非对象必须是错误（结算没有"undefined 兜底"契约）')
  const unknownKind = settlementApi({ source, exit: async () => ({ kind: 'partial', chat: CHAT }), scanDepth: async () => 4 })
  await assert.rejects(() => unknownKind.api(), /kind 未知/, '未知 kind 必须抛错，不猜、不静默整档')
  assert.deepEqual(unknownKind.spy.readChat, [], '抛错路径不得回落 readChat（错误不被吞）')
  void t
})

test('S4结算取数不再直连作者宽读参数', async t => {
  const source = seamSource()
  const block = markedBlock(source, CHAIN_MARKER.settlement, '})()')
  assert.equal(block.includes('readWindow:chatPersistence.readWindow'), false, '结算取数行不得再传作者 readWindow（timeline 窄化在插件侧）')
  assert.equal(/(?<![.\w$])readSettlementInput\(/.test(block), false, '结算取数不得再调作者 readSettlementInput（同一语义不得两份实现并存；出口方法 chatJournalStore.readSettlementInput 不算）')
  assert.equal(block.includes('chatJournalStore.readSettlementInput(chatId, { scanDepth: worldBookScanDepth })'), true, '必须改调插件原生出口')
  const full = source.split(CHAIN_MARKER.settlement).length - 1
  assert.equal(full, 1, '结算块标记恰一处（锚点唯一性由 transform 侧 assertUnique 兜底）')
  // 作者 readSettlementInput 的 import 仍在（其余消费者/回退口径不变，本刀不删作者模块）
  assert.equal(source.includes("import { readSettlementInput } from './domain/settlement-input.js'"), true, '作者模块 import 保留（不删作者字节语义）')
  void t
})

test('S4结算取数value来自真库chat', async t => {
  const source = seamSource()
  const real = storeFixture(t, { chatId: CHAT_ID, sessionId: SESSION_ID, label: 'db' })
  await real.store.update(real.chatId, () => CHAT)
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 200, '前置：真库写入 200 楼')
  assert.equal(Number.isSafeInteger(stored._storageRevision), true, '真库必须给出可核的 _storageRevision（作者判据之一）')
  assert.equal(stored.timeline.schemaVersion, 1, '真库 timeline 小字段可读')
  const { api, spy } = settlementApi({ source, exit: async () => ({ kind: 'value', chat: stored }), scanDepth: async () => 4 })
  const snapshot = await api()
  assert.equal(snapshot, stored, 'value 必须是真库读回的同一 chat 对象')
  assert.equal(snapshot.messages[199].text, 'msg-199', '真库末楼到达结算取数消费点')
  assert.equal(spy.exitCalls[0].chatId, CHAT_ID)
  assert.deepEqual(spy.readChat, [])
  void t
})

test('S4结算真出口直连全链贯通', async t => {
  // 全链：施缝后结算取数行 → **真 store 出口 readSettlementInput**（只加记录包装）→ 真 chat-query-service → 真 SQLite 库。
  // scanDepth 桩等价依据：作者 index.js:2845-2848 `worldBookScanDepth(chat)` = `historyScanDepth(await worldBooks.bound(...))`，
  //   世界书可读时给**安全整数**深度、不可读时给 Infinity（宿主随之整档）；本闸用与作者同形的纯函数桩固定给数值，
  //   并以"Infinity ⇒ 非安全整数 ⇒ 必然 fallback"的对偶断言证明该深度确实被原生门槛消费（不是传了没人看）。
  const source = seamSource()
  const real = storeFixture(t, { chatId: CHAT_ID, sessionId: SESSION_ID, label: 'exit', protocol: true })
  const messages = Array.from({ length: 260 }, (_v, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1,
    ...(index === 259 ? { mvu: { pending: true } } : {})
  }))
  await real.store.update(real.chatId, () => ({
    ...CHAT, _storageRevision: 7, messages,
    mvu: { enabled: true, owner: 'official' },
    timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 4, participants: {}, operations: {}, checkpoints: [] }
  }))
  const stored = await real.store.read(real.chatId)
  assert.equal(stored.messages.length, 260, '前置：真库写入 260 楼（>首窗 200 ⇒ from>0，深度门槛会被走到）')
  assert.equal(stored.mvu?.owner, 'official', '前置：真库保留 mvu 头字段（作者门槛之一）')
  assert.equal(typeof real.store.readSettlementInput, 'function', '真 store 必须已装配 S4 出口 readSettlementInput')
  const calls = []
  const realExit = real.store.readSettlementInput.bind(real.store)
  const chatJournalStore = { readSettlementInput(chatId, need) { calls.push({ chatId, need }); return realExit(chatId, need) } }
  const runtime = new Function('chatId', 'chatJournalStore', 'readChat', 'worldBookScanDepth',
    'return async () => {\n' + markedBlock(source, CHAIN_MARKER.settlement, '})()') + '\nreturn snapshot\n}')
  const scanDepth = async chat => { assert.equal(chat?.sessionId, SESSION_ID, '深度桩必须收到真库 chat（作者同形调用）'); return 3 }
  const snapshot = await runtime(CHAT_ID, chatJournalStore, async () => { throw new Error('真出口直连链不得回落作者 readChat') }, scanDepth)()
  assert.equal(calls.length, 1, '取数必须恰一次走真出口')
  assert.equal(calls[0].chatId, CHAT_ID)
  assert.equal(calls[0].need.scanDepth, scanDepth, '出口必须收到宿主那份深度函数（同一来源，非复制）')
  assert.equal(snapshot.id, CHAT_ID, '命中给出真库 chat')
  assert.equal(snapshot.messages.length, 260, '真出口返回 scoped 楼层：length＝完整 messageCount')
  assert.equal(Object.keys(snapshot.messages).length, 200, 'owned 楼层恰首窗 200（>200 档证明真的窄化，不是整档）')
  assert.equal(snapshot.messages[1999], undefined, '窗口外楼层是 hole（读作 undefined）')
  assert.equal(snapshot.messages[259].text, 'msg-259', '真库末楼（待结算楼）到达结算消费点')
  assert.equal(snapshot.messages[259].mvu.pending, true, '待结算标记仍在（作者判据输入）')
  assert.equal(snapshot.timeline.schemaVersion, 1, '窄 timeline 给出 schemaVersion（作者门槛消费面）')
  assert.deepEqual(snapshot.timeline.checkpoints, [], '窄读给出数组形状（消费方只判数组性）')
  assert.equal(Number(snapshot._storageRevision), stored._storageRevision, '头窄读 _storageRevision 与真库一致')
  // 对偶：深度不可读（作者世界书不可读＝Infinity）⇒ 原生门槛必假 ⇒ fallback ⇒ 宿主显式回作者 readChat
  const infinite = await runtime(CHAT_ID, chatJournalStore, async id => ({ id, source: '作者 readChat 整档' }), async () => Infinity)()
  assert.equal(infinite.source, '作者 readChat 整档', 'Infinity 深度 ⇒ 真出口 fallback ⇒ 宿主显式走作者 readChat')
  void t
})
