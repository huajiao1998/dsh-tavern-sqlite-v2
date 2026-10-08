// S4 具名断言：候选链前台取数（真 store 夹具 + 同库窄读；与作者 candidate-context-reader 注入同一
//   readWindow 双跑对照）。作者模块用固定提交 68215e47 真身，缺失即响亮失败，不 skip。
// 本闸只证明「同一 store 真读源上：门槛判定/翻页语义/返回形状与作者一致，且 timeline 窄读在消费面
//   与全组装等价」，不冒称页面/候选生成验收，也不冒称窄读性能。
//
// 实测发现（本刀必须记录，不能掩盖）：作者首窗用**数组** fields 读 `timeline.operations`，而 store 的
//   数组点路径分支把 timeline 深路径交给 `@meta` 抽取 ⇒ 该键**缺席**（探针实测：窗口 timeline 只有
//   schemaVersion/branchId；全键形状与子行表里 op1 都在）。后果：作者在这一路径下
//   ①`legacy body` 条件恒为假 ②返回的 chat.timeline 只有 @meta 点读到的键。
//   本实现改读真实 `operations:*` 子行（同 `readViewOperations`）⇒ 同一档上会把 legacy 判出来并
//   交完整分支（更保守）；这与作者"漏检"的行为不同，属**有意**的严格化，专门断言记录在
//   `候选链遗留正文与无窗口时显式返回undefined` 里。若主认为必须与作者逐字同（含漏检），
//   则应先修 store 的数组点路径读 timeline 深路径，而不是在本模块里模仿缺失。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { readCandidateInput, readNarrowTimeline, narrowTimelineConsumedFieldsMatch, CANDIDATE_CONTEXT_FIELDS, CANDIDATE_PAGE_SIZE, CANDIDATE_MIN_TEXT_REPLIES } from '../lib/chat-query-service.js'
import { readTimelineTree } from '../lib/timeline-nodes.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

// 作者 runtime-content-projection 的传递依赖含 jsdom：按既有 upstream-latest-window.test.mjs 同机制，
// 只把该 fixture 树内解析不到的裸说明符重定向到 tools/sql-test-kit；不改作者字节。
const testRequire = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/release-034-20261008/author-fixture/')
      || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:')) throw error
    return next(pathToFileURL(testRequire.resolve(specifier)).href, context)
  }
} })

const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const { createScopedMessages } = await import(new URL('scoped-messages.js', AUTHOR68215))
const { createCandidateContextReader, candidateContextFields } = await import(new URL('candidate-context-reader.js', AUTHOR68215))
const { projectAgentMessageText } = await import(new URL('runtime-content-projection.js', AUTHOR68215))
const { lastTavernHelperVariables } = await import(new URL('tavern-helper-context.js', AUTHOR68215))
for (const [n, f] of Object.entries({ createScopedMessages, createCandidateContextReader, projectAgentMessageText, lastTavernHelperVariables })) {
  assert.equal(typeof f, 'function', '作者模块导出 ' + n + ' 缺失：夹具无法对账')
}
assert.deepEqual([...candidateContextFields], [...CANDIDATE_CONTEXT_FIELDS], '本模块字段表必须与作者逐字同列表同顺序')

const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused

function fixture(t, name) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-candidate-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  const readers = []
  t.after(() => {
    for (const db of readers) { try { db.close() } catch { /* 已关 */ } }
    try { store.dispose?.() } catch { /* 已释放 */ }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, chatId: name, store, readers }
}
const reader = f => { const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId), { readOnly: true }); f.readers.push(db); return db }

const CARD = Object.freeze({ name: '验收角色', description: 'desc', personality: 'p', scenario: 's', mes_example: 'e', system_prompt: 'sp', post_history_instructions: 'phi' })
const floor = (index, text, extra = {}) => ({ role: 'user', turn: index, text, sourceText: text, ...extra })
const base = (chatId, messages) => ({
  id: chatId, sessionId: 'session-candidate-fixture', _storageRevision: 1, updatedAt: 1,
  mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  cardDefinitionSnapshot: { ...CARD }, openingWorldbookSnapshot: { version: 1 },
  macroState: { userName: '你' },
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 3, updatedAt: 40, participants: { p: 1 }, operations: {} },
  messages,
})

/** 64 楼：0–31 助手带正文（32 条）；32–63 助手正文为空（32 条）。
 *  首窗（32–63）count=0 ⇒ 按作者循环逐页前插：48→16→16 ⇒ 三页后 from=0、messages.length=64、
 *  count=32 ⇒ 循环条件 `count<6` 已假而 `from>0` 也假 ⇒ 停在 0 楼（作者实算）。 */
function chat64(chatId) {
  const messages = []
  for (let index = 0; index < 64; index++) {
    const text = index < 32 ? '正文' + index : ''
    messages.push(floor(index, text, { role: 'assistant' }))
  }
  return base(chatId, messages)
}

/** 40 楼：全部助手带正文 ⇒ 首窗（8–39）内 32 条正文 ⇒ 条件全假、不翻页。 */
function chat40(chatId) {
  const messages = []
  for (let index = 0; index < 40; index++) messages.push(floor(index, '正文' + index, { role: 'assistant' }))
  return base(chatId, messages)
}

const session = store => ({
  readWindow: store.readWindow,
  projectAgentMessageText,
  lastTavernHelperVariables,
})
const authorReader = store => createCandidateContextReader({ headerForSession: async () => undefined, readWindow: store.readWindow, readChat: async () => ({ kind: 'chat' }) })
const rawWindow = (store, chatId) => store.readWindow(chatId, { limit: CANDIDATE_PAGE_SIZE, fields: candidateContextFields })

/** 除 timeline / messages 外逐字段（JSON 等价）相同，且键集合与键序与作者一致、必须带 id。
 *  说明：作者首窗走 readWindow(fields=candidateContextFields)，该列表**含** `_storageRevision` 点键，
 *  故作者头里带 `_storageRevision`；本实现的头来自同一 readWindow 调用，形状本应相同——这里把它排除
 *  只因为本闸用 store.readWindow 注入，两边的 `_storageRevision` 语义由各自 revision 字段承载。 */
function assertSameChatExceptTimeline(ours, theirs) {
  const skip = new Set(['timeline', 'messages', '_storageRevision'])
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (skip.has(key)) continue
    assert.equal(isDeepStrictEqual(ours[key], theirs[key]), true, '头字段 ' + key + ' 必须与作者同值')
  }
  assert.deepEqual(Object.keys(ours), Object.keys(theirs), '键集合（含键序）必须与作者一致')
  assert.equal(ours.id, theirs.id, 'id 必须带出')
}

test('候选链首窗正文不足时按作者条件翻页且窄timeline与全组装消费面等价', async t => {
  const f = fixture(t, 'chat-candidate-paging')
  await f.store.update(f.chatId, () => chat64(f.chatId))
  const db = reader(f)
  const ours = await readCandidateInput(db, { chatId: f.chatId }, session(f.store))
  const theirs = await authorReader(f.store).read(f.chatId)
  assert.notEqual(theirs, undefined, '作者必须命中（否则对照无意义）')
  assert.notEqual(ours, undefined, '本实现必须命中')
  assert.equal(ours.messages.length, 64, '翻页停止点：三页后 from=0 ⇒ 64 楼（作者循环实算）')
  assert.equal(ours.messages[0].turn, 0, '拼接后首楼＝最终窗口起点 0 楼')
  assert.deepEqual(ours.messages, theirs.messages, '拼接后的 messages 必须与作者逐元素相同')
  assertSameChatExceptTimeline(ours, theirs)
  // 窄 timeline 必须与全组装值在消费面等价
  const full = (await rawWindow(f.store, f.chatId)).chat.timeline
  assert.equal(narrowTimelineConsumedFieldsMatch(ours.timeline, full), true, '窄 timeline 消费面必须与全组装等价')
  assert.equal(ours.timeline.schemaVersion, 1)
  assert.equal(ours.timeline.branchId, 'branch-main')
  assert.equal(ours.timeline.revision, 3)
  assert.equal(ours.timeline.updatedAt, 40)
  assert.deepEqual(ours.timeline.participants, { p: 1 })
  assert.deepEqual(ours.timeline.checkpoints, [])
  assert.deepEqual(ours.timeline.operations, {})
  assert.equal(typeof ours.timeline.operations, 'object', 'operations 必须是字典（消费方按 Object.values 判 legacy body）')
})

test('候选链正文足够时按第二条件继续翻页且窄timeline键集与组装一致', async t => {
  const f = fixture(t, 'chat-candidate-single')
  await f.store.update(f.chatId, () => chat40(f.chatId))
  const db = reader(f)
  const ours = await readCandidateInput(db, { chatId: f.chatId }, session(f.store))
  const theirs = await authorReader(f.store).read(f.chatId)
  // 实测：首窗（8–39）count=32 已满足 `count<6` 为假，但作者第二条件
  // `!promptTemplateInput?.message && lastTavernHelperVariables(messages)===undefined` 仍为真
  // （窗口内没有变量楼）⇒ 继续翻页到 0 楼。本实现同序 ⇒ 与作者同为 40 楼。
  assert.equal(ours.messages.length, 40, '第二条件仍为真 ⇒ 翻到 0 楼（与作者同）')
  assert.equal(ours.messages[0].turn, 0)
  assert.deepEqual(ours.messages, theirs.messages)
  assertSameChatExceptTimeline(ours, theirs)
  const full = (await rawWindow(f.store, f.chatId)).chat.timeline
  // 注意（实测）：candidateContextFields 的数组形状下，store 对 `timeline.*` 只走 @meta 点读，
  // 连 `timeline.operations` 都不返回、也不补 checkpoints ⇒ 这里的 `full` 本身是**残缺形状**。
  // 故只断言：窄读不得丢失 @meta 真值、也不得发明 @meta 里没有的键；operations/checkpoints 是
  // 子行组装恒定补出的两个键（head 占位存在即可判为数组，见实现注释）。
  assert.equal(narrowTimelineConsumedFieldsMatch(ours.timeline, full), true, '窄 timeline 消费面必须与全组装等价')
  const db2 = new DatabaseSync(f.store.rollbackArchivePath(f.chatId), { readOnly: true })
  f.readers.push(db2)
  const meta = JSON.parse(db2.prepare("SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get().value_json)
  for (const key of Object.keys(meta)) {
    assert.equal(isDeepStrictEqual(ours.timeline[key], meta[key]), true, '窄读必须原样带出 @meta 的 ' + key)
  }
  for (const key of Object.keys(ours.timeline)) {
    assert.equal(key === 'operations' || key === 'checkpoints' || Object.hasOwn(meta, key), true,
      '窄读不得发明 @meta 之外的键：' + key)
  }
  assert.deepEqual(ours.timeline.operations, {})
  assert.deepEqual(ours.timeline.checkpoints, [])
  assert.equal(narrowTimelineConsumedFieldsMatch(ours.timeline, full), true)
})

test('候选链卡快照缺或开局世界书版本不符时显式返回undefined交完整分支', async t => {
  const f = fixture(t, 'chat-candidate-threshold')
  const chat = chat64(f.chatId)
  delete chat.cardDefinitionSnapshot
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  assert.equal(await readCandidateInput(db, { chatId: f.chatId }, session(f.store)), undefined, '卡快照缺 ⇒ 完整分支')
  assert.deepEqual(await authorReader(f.store).read(f.chatId), { kind: 'chat' }, '作者同条件走 readChat（对照口径）')

  const f2 = fixture(t, 'chat-candidate-threshold-version')
  const chat2 = chat64(f2.chatId)
  chat2.openingWorldbookSnapshot = { version: 2 }
  await f2.store.update(f2.chatId, () => chat2)
  const db2 = reader(f2)
  assert.equal(await readCandidateInput(db2, { chatId: f2.chatId }, session(f2.store)), undefined, 'openingWorldbookSnapshot.version≠1 ⇒ 完整分支')
  assert.deepEqual(await authorReader(f2.store).read(f2.chatId), { kind: 'chat' }, '作者同条件走 readChat')
  assert.equal(narrowTimelineConsumedFieldsMatch(readNarrowTimeline(db2).timeline, (await rawWindow(f2.store, f2.chatId)).chat.timeline), true,
    '版本门槛与窄读无关，窄读仍等价')
})

test('候选链遗留正文与无窗口时显式返回undefined', async t => {
  const f = fixture(t, 'chat-candidate-legacy')
  const chat = chat64(f.chatId)
  chat.timeline = {
    schemaVersion: 1, branchId: 'branch-main', revision: 4, participants: {},
    operations: { op1: { id: 'op1', kind: 'body', role: 'body', status: 'foreground-completed', turn: 3, createdAt: 10, completedAt: 20 } },
  }
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  assert.equal(await readCandidateInput(db, { chatId: f.chatId }, session(f.store)), undefined, 'body 已前台完成 ⇒ 完整分支')
  // 作者口径备注（实测，见本文件顶部注释与探针结论）：作者首窗也是 readWindow(fields=candidateContextFields)
  // 数组形状，store 侧数组点路径读 `timeline.operations` 走 @meta 抽取 ⇒ 该键**缺席**，
  // 因此作者在这一路径下 legacy-body 条件恒为假、会返回窗口 chat 而不是 readChat。
  // 本实现读真实 operations 子行 ⇒ 同一档上更严格地判为 legacy（对同一数据给出"更保守"的分流）。
  // 两者的差别只存在于"作者漏检"的情形；下面显式记录该事实，不做掩盖。
  const authorValue = await authorReader(f.store).read(f.chatId)
  assert.notEqual(authorValue, undefined, '作者在该路径下返回窗口 chat（数组 fields 让 operations 缺席）')
  assert.deepEqual(Object.keys(authorValue.timeline).sort(), ['branchId', 'participants', 'revision', 'schemaVersion'],
    '作者窗口的 timeline 只有 @meta 点读到的标量键（operations 缺席）')
  assert.equal(Object.hasOwn(authorValue.timeline, 'operations'), false, '作者的窗口形状里 operations 真的缺席')
  assert.equal(Object.values(authorValue.timeline).some(v => v && v.kind === 'body' && v.status === 'foreground-completed'), false,
    '⇒ 作者在该路径下 legacy-body 条件恒为假')
  // 窄读必须能看见该 operation 的 kind/status（否则门槛会漏判）。
  // 对照值用**真全组装**（readTimelineTree），而不是 rawWindow：后者在这种数组 fields 形状下
  // 本身就是残缺的 @meta-only 形状（见本文件顶部注释，实测 operations=undefined）。
  const assembled = readTimelineTree(db).value
  assert.deepEqual(assembled.operations.op1.status, 'foreground-completed')
  assert.equal(narrowTimelineConsumedFieldsMatch(readNarrowTimeline(db).timeline, assembled), true,
    'legacy body 判定面必须与真全组装等价')

  const f2 = fixture(t, 'chat-candidate-nowindow')
  const db2 = { prepare: () => { throw new Error('无档路径不应触碰 SQLite 句柄') } }
  assert.equal(await readCandidateInput(db2, { chatId: f2.chatId }, session(f2.store)), undefined, '无窗口（无档）⇒ undefined')
  // 同一 readChat 口径下作者也必须给出 undefined（无档=完整分支本身也拿不到档）
  const authorNoChat = createCandidateContextReader({ headerForSession: async () => undefined, readWindow: f2.store.readWindow, readChat: async () => undefined })
  assert.equal(await authorNoChat.read(f2.chatId), undefined, '作者同条件同样 undefined')
})

test('候选链翻页遇revision变动或续页为空时中止返回undefined', async t => {
  const f = fixture(t, 'chat-candidate-revision')
  await f.store.update(f.chatId, () => chat64(f.chatId))
  const db = reader(f)
  const firstPage = await rawWindow(f.store, f.chatId)
  let calls = 0
  const racing = { ...session(f.store), readWindow: async (chatId, options) => {
    calls += 1
    if (calls === 1) return f.store.readWindow(chatId, options)
    return { chat: { ...firstPage.chat, _storageRevision: 2 }, messageCount: 100, from: 4, to: 35, revision: 2 }
  } }
  assert.equal(await readCandidateInput(db, { chatId: f.chatId }, racing), undefined, '续页 revision 与首窗不符 ⇒ 中止')
  assert.equal(calls, 2, '必须在续页读处中止')

  // 空页（before 越过档案起点）：作者不判空页、from 变 0 即退出循环并返回已拼内容；
  // 本实现同序（拼接无新增、from→0、循环条件 from>0 为假）⇒ 也必须返回同样的窗口，不得崩或吞。
  let emptyCalls = 0
  const empty = { ...session(f.store), readWindow: async (chatId, options) => {
    emptyCalls += 1
    if (emptyCalls === 1) return f.store.readWindow(chatId, options)
    return { chat: { ...firstPage.chat, messages: [] }, messageCount: 100, from: 0, to: -1, revision: 1 }
  } }
  const oursEmpty = await readCandidateInput(db, { chatId: f.chatId }, empty)
  assert.notEqual(oursEmpty, undefined, '空页不是错误：与作者一样按"取不到更早页"收束')
  assert.equal(oursEmpty.messages.length, 32, '空页不新增楼层')
  assert.equal(emptyCalls, 2)
})

test('候选链注入面缺失或未命中时不静默降级', async t => {
  const f = fixture(t, 'chat-candidate-helpers')
  await f.store.update(f.chatId, () => chat40(f.chatId))
  const db = reader(f)
  await assert.rejects(() => readCandidateInput(db, { chatId: f.chatId }, { projectAgentMessageText }), /缺少注入 helper readWindow/)
  await assert.rejects(() => readCandidateInput(db, { chatId: f.chatId }, { readWindow: f.store.readWindow }), /缺少注入 helper projectAgentMessageText/)
  await assert.rejects(() => readCandidateInput(db, { chatId: f.chatId }, { readWindow: f.store.readWindow, projectAgentMessageText }), /缺少注入 helper lastTavernHelperVariables/)
  await assert.rejects(() => readCandidateInput({}, { chatId: f.chatId }, session(f.store)), /需要真实 SQLite 句柄/)
  await assert.rejects(() => readCandidateInput(db, { chatId: '' }, session(f.store)), /缺少 chatId/)
  assert.equal(CANDIDATE_MIN_TEXT_REPLIES, 6, '作者 :30 的正文下限必须逐字保留')
  assert.equal(CANDIDATE_PAGE_SIZE, 32, '作者 :17/:31 的页大小必须逐字保留')
})
