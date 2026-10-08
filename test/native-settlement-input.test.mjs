// S4 具名断言：结算链前台取数（真 store 夹具 + 同库窄读；与作者 settlement-input.js 同一 readWindow
//   双跑对照）。作者模块用固定提交 68215e47 真身，缺失即响亮失败，不 skip。
// 本闸只证明「同一 store 真读源上：门槛顺序与判据/fallback 分流/scoped 形状与作者一致，且 timeline
//   窄读在消费面与全组装等价」，不冒称结算业务验收，也不冒称窄读性能。
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
import { readSettlementInputNative, readNarrowTimeline, narrowTimelineConsumedFieldsMatch, scannedStoryRows, SETTLEMENT_PAGE_SIZE, SETTLEMENT_FALLBACK_REASONS } from '../lib/chat-query-service.js'
import { readTimelineTree } from '../lib/timeline-nodes.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

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
const { createScopedMessages, isScopedMessages } = await import(new URL('scoped-messages.js', AUTHOR68215))
const { readSettlementInput } = await import(new URL('settlement-input.js', AUTHOR68215))
for (const [n, f] of Object.entries({ createScopedMessages, readSettlementInput })) assert.equal(typeof f, 'function', '作者模块导出 ' + n + ' 缺失：夹具无法对账')

const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused

function fixture(t, name) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-settlement-'))
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

/**
 * 201 楼夹具：窗口（limit 200）＝1..200，故 from=1、previous 判定真的会跑到。
 *   0..196 user；197 assistant（供 depth+1 计数）；198 assistant(mvu.pending=false)；
 *   199 assistant（上一条助手）；200 assistant(mvu.pending=true)＝target ⇒ 窗口内 assistant 共 3 条
 *   ⇒ `scannedStoryRows(rows, depth+1)` 在 depth≤2 时为真、depth≥3 时为假（作者实算，用于扫描深度分支）。
 */
function chat201(chatId, overrides = {}) {
  const messages = []
  for (let index = 0; index <= 196; index++) messages.push({ role: 'user', turn: index, text: 'rev' + (index + 1), sourceText: 'rev' + (index + 1) })
  messages.push({ role: 'assistant', turn: 197, text: 'rev198' })
  messages.push({ role: 'assistant', turn: 198, text: 'rev199', mvu: { pending: false } })
  messages.push({ role: 'assistant', turn: 199, text: 'rev200' })
  messages.push({ role: 'assistant', turn: 200, text: 'rev201', mvu: { pending: true } })
  return {
    id: chatId, sessionId: 'session-settlement-fixture', _storageRevision: 1, updatedAt: 1,
    mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    mvu: { enabled: true, owner: 'official' },
    preparedWorldBook: { revision: 5 },
    timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 5, updatedAt: 40, participants: { p: 1 }, operations: {} },
    messages,
    ...overrides,
  }
}

const session = store => ({ readWindow: store.readWindow, createScopedMessages })
/**
 * 作者门槛的逐字复刻（用**全键形状** readWindow 与同一 createScopedMessages；readChat 用哨兵表示 fallback）。
 * ⚠ 实测口径说明：生产里作者上层把 `chatPersistence.readWindow` 注进来，其 `timeline.operations` 在
 * 某些 fields 形状下会缺席（见 candidate 测试顶部注释）；本参考实现用**全键形状**读，故它的
 * timeline 判定是"作者逻辑 + 真实 operations"，用来验证本实现在门槛判据上的等价性。
 */
const CHAT_FALLBACK = Symbol('readChat')
async function authorReference(store, chatId, scanDepth) {
  const window = await store.readWindow(chatId, { limit: 200 })
  const chat = window?.chat
  const timeline = chat?.timeline
  const rows = chat?.messages
  const target = rows?.findLastIndex(row => row?.role === 'assistant' && row.mvu?.pending === true) ?? -1
  const previous = target > 0 ? rows.slice(0, target).findLastIndex(row => row?.role === 'assistant') : -1
  if (!window || !Number.isSafeInteger(window.revision) || chat._storageRevision !== window.revision
    || chat.backgroundConfigVersion !== 1 || chat.conversationFeaturesVersion !== 1
    || timeline?.schemaVersion !== 1 || !Array.isArray(timeline.checkpoints)
    || Object.values(timeline.operations || {}).some(op => op?.kind === 'body' && op.status === 'foreground-completed')
    || chat.mvu?.enabled !== true || chat.mvu.owner !== 'official'
    || target < 0 || (window.from > 0 && previous < 0)) return CHAT_FALLBACK
  const prepared = chat.preparedWorldBook && Number(chat.preparedWorldBook.revision) === Number(timeline.revision)
  if (!prepared && window.from > 0) {
    // 与作者 :25 同一形状：scanDepth 必须是**函数**（宿主传函数），否则按 Infinity 处理
    const depth = typeof scanDepth === 'function' ? await scanDepth(chat) : Infinity
    if (!Number.isSafeInteger(depth) || !scannedStoryRows(rows, depth + 1)) return CHAT_FALLBACK
  }
  return { ...chat, messages: createScopedMessages(window.messageCount, rows.map((row, index) => [window.from + index, row])) }
}

const rawWindow = (store, chatId) => store.readWindow(chatId, { limit: SETTLEMENT_PAGE_SIZE })

/** 头字段（除 timeline/messages）逐字段与作者同值，且键集合相同。 */
function assertSameHeaderExceptTimeline(ours, theirs) {
  const skip = new Set(['timeline', 'messages'])
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    if (skip.has(key)) continue
    assert.equal(isDeepStrictEqual(ours[key], theirs[key]), true, '头字段 ' + key + ' 必须与作者同值')
  }
  assert.deepEqual(Object.keys(ours), Object.keys(theirs), '键集合（含键序）必须与作者一致')
}

test('结算链命中时与作者同形且窄timeline消费面等价', async t => {
  const f = fixture(t, 'chat-settlement-hit')
  await f.store.update(f.chatId, () => chat201(f.chatId))
  const db = reader(f)
  const ours = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: 0 })
  const theirs = await authorReference(f.store, f.chatId, 0)
  assert.notEqual(theirs, CHAT_FALLBACK, '作者必须命中（否则对照无意义）')
  assert.equal(ours.kind, undefined, '命中时不得返回 fallback 形状')
  assert.equal(isScopedMessages(ours.messages), true, 'messages 必须是作者 createScopedMessages 的 scoped 形状')
  assert.equal(ours.messages.length, 201, 'scoped 长度＝完整 messageCount')
  assert.equal(ours.messages[200].mvu.pending, true, 'scoped 用绝对坐标：200 楼就是 pending 楼')
  // scoped 用**绝对楼号**做下标：窗口是 1..200，故 0 楼在窗口外＝空洞（实测确认，勿写成相对下标）
  assert.equal(ours.messages[0], undefined, '窗口外（0 楼）读作空洞')
  assert.equal(ours.messages[1].turn, 1, 'scoped 绝对坐标：1 楼')
  assertSameHeaderExceptTimeline(ours, theirs)
  assert.deepEqual([...ours.messages], [...theirs.messages], '逐楼值必须与作者一致')
  // 窄 timeline 消费面等价
  const full = readTimelineTree(db).value
  assert.equal(narrowTimelineConsumedFieldsMatch(ours.timeline, full), true, '窄 timeline 消费面必须与真全组装等价')
  assert.deepEqual([...Object.keys(ours.timeline)].sort(), [...Object.keys(full)].sort(), '窄 timeline 键集必须与全组装相同')
  // 门槛真正消费到的字段必须原样带出
  assert.equal(ours._storageRevision, 1)
  assert.deepEqual(ours.mvu, { enabled: true, owner: 'official' })
  assert.deepEqual(ours.preparedWorldBook, { revision: 5 })
  assert.equal(SETTLEMENT_PAGE_SIZE, 200, '作者 :10 的窗口上限必须逐字保留')
})

test('结算链preparedWorldBook失效时按注入scanDepth与作者同判', async t => {
  const f = fixture(t, 'chat-settlement-scan')
  const chat = chat201(f.chatId, { preparedWorldBook: { revision: 4 } })   // 与 timeline.revision=5 不符 ⇒ 未 prepare
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  const window = await rawWindow(f.store, f.chatId)
  assert.equal(window.from, 1, '窗口必须真的不全（否则该分支不生效）')
  const rows = window.chat.messages
  const assistants = rows.filter(row => row?.role === 'assistant').length
  assert.deepEqual(window.chat.preparedWorldBook, { revision: 4 }, 'preparedWorldBook 必须与 timeline.revision 不符（否则该分支不生效）')
  assert.equal(window.chat.timeline.revision, 5)
  assert.equal(assistants, 4, '窗口内 assistant 数＝夹具事实（用于按作者公式选深度）')
  // 深度足够：作者公式 scannedStoryRows(rows, depth+1) 要求窗口内 story 楼 ≥ depth+1 ⇒ depth ≤ assistants-1
  // 生产形状：scanDepth 是**函数**（宿主传函数；数字不会被识别 ⇒ 会退化成 Infinity 走 fallback）
  const enough = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: () => assistants - 2 })
  const enoughRef = await authorReference(f.store, f.chatId, () => assistants - 2)

  assert.notEqual(enoughRef, CHAT_FALLBACK, '作者在深度 ' + (assistants - 2) + ' 时必须命中')
  assert.equal(enough.kind, undefined)
  assertSameHeaderExceptTimeline(enough, enoughRef)
  assert.deepEqual([...enough.messages], [...enoughRef.messages])
  // 深度刚刚不足：depth+1 > 窗口内 assistant 数
  const short = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: () => rows.length + 1 })
  assert.equal(short.kind, 'fallback', '深度不足 ⇒ 显式 fallback')
  assert.equal(short.reason, SETTLEMENT_FALLBACK_REASONS.scanDepth)
  assert.equal(await authorReference(f.store, f.chatId, () => rows.length + 1), CHAT_FALLBACK, '作者同条件同样走 readChat')
  // 深度恰好等于窗口 story 行数时仍命中（作者公式是 depth+1 ≤ story 行数）
  const exact = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: () => rows.length - 1 })
  assert.equal(exact.kind, undefined, 'depth+1 == story 行数 ⇒ 仍命中（作者同）')
  // scanDepth 非函数（宿主没给）：作者 Infinity ⇒ 非安全整数 ⇒ readChat；本实现同
  const noDepth = await readSettlementInputNative(db, { chatId: f.chatId }, session(f.store))
  assert.equal(noDepth.kind, 'fallback')
  assert.equal(await authorReference(f.store, f.chatId, undefined), CHAT_FALLBACK, '作者同条件同样走 readChat')
})

test('结算链各门槛逐一fallback且与作者同判', async t => {
  const cases = [
    ['mvu.enabled 非 true', { mvu: { enabled: false, owner: 'official' } }, SETTLEMENT_FALLBACK_REASONS.mvuDisabled, 'chat-settlement-gate-mvu-enabled'],
    ['mvu.owner 非 official', { mvu: { enabled: true, owner: 'plugin' } }, SETTLEMENT_FALLBACK_REASONS.mvuOwner, 'chat-settlement-gate-mvu-owner'],
    ['conversationFeaturesVersion 非 1', { conversationFeaturesVersion: 2 }, SETTLEMENT_FALLBACK_REASONS.conversationFeaturesVersion, 'chat-settlement-gate-cfv'],
    ['timeline.schemaVersion 非 1', { timeline: { schemaVersion: 2, branchId: 'b', revision: 5, checkpoints: [], operations: {} } }, SETTLEMENT_FALLBACK_REASONS.schemaVersion, 'chat-settlement-gate-schema'],
  ]
  for (const [label, overrides, reason, id] of cases) {
    const f = fixture(t, id)
    await f.store.update(f.chatId, () => chat201(f.chatId, overrides))
    const db = reader(f)
    const ours = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: 0 })
    assert.equal(ours.kind, 'fallback', label + ' ⇒ fallback')
    assert.equal(ours.reason, reason, label + ' 的 reason 必须指名门槛')
    assert.equal(await authorReference(f.store, f.chatId, 0), CHAT_FALLBACK, label + ' ⇒ 作者同走 readChat')
  }
  // 无 pending 助手楼 ⇒ fallback（作者 target<0）
  const f = fixture(t, 'chat-settlement-nopending')
  const chat = chat201(f.chatId)
  chat.messages[200] = { role: 'assistant', turn: 200, text: 'rev201' }   // 去掉 mvu.pending
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  const ours = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: 0 })
  assert.equal(ours.kind, 'fallback')
  assert.equal(ours.reason, SETTLEMENT_FALLBACK_REASONS.noPending)
  assert.equal(await authorReference(f.store, f.chatId, 0), CHAT_FALLBACK, '作者同条件同样 readChat')
  // 无档 ⇒ 作者的 window 为 null ⇒ readChat；本实现 fallback 无窗口（不需要为不存在的档开只读句柄）
  const f2 = fixture(t, 'chat-settlement-nowindow')
  const fakeHandle = { prepare: () => { throw new Error('无档路径不应触碰 SQLite 句柄') } }
  const none = await readSettlementInputNative(fakeHandle, { chatId: f2.chatId }, { ...session(f2.store), scanDepth: 0 })
  assert.equal(none.kind, 'fallback')
  assert.equal(none.reason, SETTLEMENT_FALLBACK_REASONS.noWindow)
})

test('结算链遗留正文与上一条助手缺失时fallback', async t => {
  const f = fixture(t, 'chat-settlement-legacy')
  await f.store.update(f.chatId, () => chat201(f.chatId, {
    timeline: {
      schemaVersion: 1, branchId: 'branch-main', revision: 5, participants: {},
      operations: { op1: { id: 'op1', kind: 'body', role: 'body', status: 'foreground-completed', turn: 3, createdAt: 1, completedAt: 2 } },
    },
  }))
  const db = reader(f)
  const ours = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: 0 })
  assert.equal(ours.kind, 'fallback', 'body 已前台完成 ⇒ fallback（窄读必须看得见该 operation）')
  assert.equal(ours.reason, SETTLEMENT_FALLBACK_REASONS.legacyBody, 'legacy body 必须按作者同序在 schemaVersion 之后、mvu 之前判出')
  const full = readTimelineTree(db).value
  assert.equal(narrowTimelineConsumedFieldsMatch(readNarrowTimeline(db).timeline, full), true, 'legacy body 判定面必须与真全组装等价')
  // 作者口径：同一档上作者的 gate 走的是它自己那份 timeline；用**全键形状**的作者逻辑复刻应同样 fallback
  assert.equal(await authorReference(f.store, f.chatId, 0), CHAT_FALLBACK, '作者逻辑（全键形状 timeline）同样 readChat')

  // previous<0：target 之前没有任何助手楼，且窗口不全（from>0）
  const f2 = fixture(t, 'chat-settlement-noprev')
  const messages = []
  for (let index = 0; index <= 199; index++) messages.push({ role: 'user', turn: index, text: 'rev' + (index + 1) })
  messages.push({ role: 'assistant', turn: 200, text: 'rev201', mvu: { pending: true } })
  await f2.store.update(f2.chatId, () => chat201(f2.chatId, { messages }))
  const db2 = reader(f2)
  const ours2 = await readSettlementInputNative(db2, { chatId: f2.chatId }, { ...session(f2.store), scanDepth: 0 })
  assert.equal(ours2.kind, 'fallback')
  assert.equal(ours2.reason, SETTLEMENT_FALLBACK_REASONS.noPrevious)
  assert.equal(await authorReference(f2.store, f2.chatId, 0), CHAT_FALLBACK, '作者同条件同样 readChat（from>0 且 previous<0）')
})

test('结算窄快照逐字透传requestId与roundOperationId两个决定幂等与轮次判定的键', async t => {
  const f = fixture(t, 'chat-settlement-op-keys')
  // 真库写两条"作者会写出的形状"操作：一条带 requestId 的 running agent、一条带 roundOperationId 的 settlement agent
  await f.store.update(f.chatId, () => chat201(f.chatId, {
    timeline: {
      schemaVersion: 1, branchId: 'branch-main', revision: 5, updatedAt: 41, participants: {},
      operations: {
        'round-body-1': {
          id: 'round-body-1', kind: 'body', role: 'body', status: 'completed', turn: 3,
          basedOn: { branchId: 'branch-main', revision: 4 }, createdAt: 10, completedAt: 20,
          committedBranchId: 'branch-main', committedRevision: 4, background: { phase: 'pending', role: 'settlement', updatedAt: 21 },
        },
        'agent-with-request': {
          id: 'agent-with-request', kind: 'agent', role: 'settlement', status: 'running',
          requestId: 'req-settlement-1', roundOperationId: 'round-body-1',
          basedOn: { branchId: 'branch-main', revision: 4 }, createdAt: 30,
        },
      },
    },
  }))
  const db = reader(f)
  const ours = await readSettlementInputNative(db, { chatId: f.chatId }, { ...session(f.store), scanDepth: 0 })
  assert.equal(ours.kind, undefined, '该档必须命中（否则取数路径不是窄快照）')
  const full = readTimelineTree(db).value
  // 窄读必须逐字带出这两个键（缺了就会让 agent.begin 幂等复用失效、结算轮次 stale 校验被跳过）
  assert.equal(ours.timeline.operations['agent-with-request'].requestId, 'req-settlement-1', 'requestId 必须出现在窄 operations 里')
  assert.equal(ours.timeline.operations['agent-with-request'].roundOperationId, 'round-body-1', 'roundOperationId 必须出现在窄 operations 里')
  assert.equal(ours.timeline.operations['agent-with-request'].requestId, full.operations['agent-with-request'].requestId, '与全组装同值')
  assert.equal(ours.timeline.operations['agent-with-request'].roundOperationId, full.operations['agent-with-request'].roundOperationId, '与全组装同值')
  assert.equal(narrowTimelineConsumedFieldsMatch(ours.timeline, full), true, '补齐两键后消费面仍与真全组装等价')
  // 反向守卫：把窄快照里这两个键抹掉，等价判据必须立刻为假（证明该断言真的在守这两键）
  const damaged = { ...ours.timeline, operations: { 'agent-with-request': { ...ours.timeline.operations['agent-with-request'], requestId: undefined, roundOperationId: undefined } } }
  assert.equal(narrowTimelineConsumedFieldsMatch(damaged, full), false, '抹掉 requestId/roundOperationId 必须被判不等价')
  // 仍不含大载荷：userText/businessBefore 不得被带进窄形状
  assert.equal(Object.hasOwn(ours.timeline.operations['agent-with-request'], 'userText'), false, 'userText 不进窄形状（body 分支才读）')
  assert.equal(Object.hasOwn(ours.timeline.operations['agent-with-request'], 'businessBefore'), false, '大载荷不进窄形状')
})

test('结算链注入面缺失或未命中时不静默降级', async t => {
  const f = fixture(t, 'chat-settlement-helpers')
  await f.store.update(f.chatId, () => chat201(f.chatId))
  const db = reader(f)
  await assert.rejects(() => readSettlementInputNative(db, { chatId: f.chatId }, { createScopedMessages }), /缺少注入 helper readWindow/)
  await assert.rejects(() => readSettlementInputNative(db, { chatId: f.chatId }, { readWindow: f.store.readWindow }), /缺少注入 helper createScopedMessages/)
  await assert.rejects(() => readSettlementInputNative({}, { chatId: f.chatId }, session(f.store)), /需要真实 SQLite 句柄/)
  await assert.rejects(() => readSettlementInputNative(db, { chatId: '' }, session(f.store)), /缺少 chatId/)
})
