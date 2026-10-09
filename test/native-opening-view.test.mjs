// S2 真实作者 view 深等价 harness（**只写不跑**；执行须经门禁受影响断言）。
// 本版按主 review 修正：AsyncFunction 取自原型、runner 为 async 且必须 await、作者 body 自带 `replyProjectionsOf` 故作者 deps 不得含同名参数、
// 补注入作者 view 实际引用的 backgroundTasks/sessionStore/agentRegistry/requestPerformance、**整 view 严格 deepEqual（不滤字段、不跳 volatile）**、
// 删除文本式伪门，改为「显式必需实现清单 + 参与路径计数」。
// 范围标注：纯业务 helper 若不能在单测真实 import，则以**真实形状的受控实现**参与；S2-3 只声明「装配等价」，不声明真实 helper 语义等价（真实 helper 门见文末 TODO）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionWindowProjector, REQUIRED_FUNCTIONS, REQUIRED_VALUES } from '../lib/session-window-projector.js'
import { applyNativeDataTransform, ANCHORS, REQUIRED_BLOCKS, isNativeDataApplied } from '../deploy/native-data-transform.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const AUTHOR_ROOT = path.resolve(PKG, '..', '..', 'tmp', 'release-034-20261008', 'author-fixture', 'src',
  'dsh-tavern-68215e47516637e00c75d2b4bba3192679559425', 'tavern-plugin', 'lib')
const AUTHOR_INDEX = path.join(AUTHOR_ROOT, 'index.js')

function sliceClosureFunction(source, header, endMarker = '\n  }\n') {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, '未找到作者函数头: ' + header)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, '未找到作者函数尾: ' + header)
  return source.slice(start, end + endMarker.length)
}

/** 作者 view 执行器（**async**，调用方必须 await）。作者 deps **不得**含 `replyProjectionsOf`（body 内自带，参数会遮蔽）。 */
export async function createAuthorViewRunner(deps) {
  const source = fs.readFileSync(AUTHOR_INDEX, 'utf8')
  const viewBody = sliceClosureFunction(source, 'async function view(chat, card, persistedProjection = false, options = {}) {')
  const replyBody = sliceClosureFunction(source, 'function replyProjectionsOf(chat) {')
  const names = Object.keys(deps)
  assert.ok(!names.includes('replyProjectionsOf'), '作者 deps 不得包含 replyProjectionsOf')
  const factory = new AsyncFunction(...names, `${replyBody}\n  ${viewBody}\n  return view\n`)
  return factory(...names.map(name => deps[name]))
}

/** 作者 view 实际引用的额外闭包名（不在投影清单里，但 body 会用到）。 */
export const AUTHOR_EXTRA_DEPS = Object.freeze(['backgroundTasks', 'sessionStore', 'agentRegistry', 'requestPerformance'])

/** 受控但真实形状的 fixture：≥2 条非空消息 + helper runtime 真实形状 + 确定性低层 I/O。 */
export function buildFixture() {
  const activity = Object.freeze({ busy: false, phase: 'idle', role: '', operationId: '', basedOn: null, reason: null, updatedAt: 11 })
  const card = { path: '/cards/demo.png', name: '演示卡', tags: ['demo'], extensions: {} }
  const messages = [
    { role: 'assistant', turn: 1, text: '第一轮正文', sourceText: '第一轮正文', displayText: '第一轮正文', displayMode: 'markdown', variables: [{ stat_data: { hp: 1 } }], swipeId: 0 },
    { role: 'user', turn: 2, text: '用户输入', sourceText: '用户输入' },
    { role: 'assistant', turn: 2, text: '第二轮正文', sourceText: '第二轮正文', displayText: '<b>第二轮正文</b>', displayMode: 'html', variables: [{ stat_data: { hp: 2 } }], swipeId: 0 }
  ]
  const chat = {
    id: 'chat-1', sessionId: 'session-1', cardPath: card.path, cardName: card.name, mode: 'story',
    backgroundConfigVersion: 1, conversationFeaturesVersion: 1, messages,
    macroState: { userName: '玩家' }, guides: ['g1'], posture: 'side', statusBarPlacement: 'body',
    ledger: { hp: 2 }, characterDesignDocument: { id: 'd1' }, variables: { hp: 2 },
    mvu: { enabled: true, owner: 'official' }, updatedAt: 11, cardDefinitionSnapshot: { name: card.name },
    openingWorldbookSnapshot: { version: 1, document: { name: '开局书' } }, runtimePresetSnapshot: { presetPath: 'p', presetName: '预设' }
  }
  const window = { from: 0, to: 2, messageCount: 3, revision: 5, nativeData: true }
  return { activity, card, chat, window }
}

/** 显式必需实现清单：每项都有实现（对象方法形式），并以 calls 记录**参与路径**。 */
export function buildDeps(fixture) {
  const calls = []
  const track = (name, fn) => function tracked(...args) { calls.push(name); return fn.apply(this, args) }
  const helperContext = { messages: [{ message_id: 0, role: 'assistant' }, { message_id: 2, role: 'assistant' }], turnMessageIds: { 1: 0, 2: 2 } }
  const deps = {
    str: value => (value === undefined || value === null ? '' : String(value)),
    readTavernSettings: track('readTavernSettings', async () => ({ trustedCardMode: false, frameSizing: 'fill' })),
    readScript: track('readScript', async () => undefined),
    scriptContinuity: { inspect: track('scriptContinuity.inspect', () => null) },
    groupOfMode: track('groupOfMode', () => 'story'),
    replyProjectionsOf: track('replyProjectionsOf', () => []),
    incrementalReplyView: { project: track('incrementalReplyView.project', async () => ({ projections: [], statusViews: [] })) },
    composeTavernRegexScripts: track('composeTavernRegexScripts', () => []),
    liveCardUpdate: { project: track('liveCardUpdate.project', async (_c, _card, display) => display) },
    withLegacyPresentationProjection: track('withLegacyPresentationProjection', (_chat, projections) => projections),
    readCardExtensions: track('readCardExtensions', async () => ({ regexScripts: [], helperScripts: [{ id: 'helper-1' }], variables: { v: 1 }, globalRegexScripts: [], characterRegexScripts: [], frameSizing: 'fill' })),
    tavernRemoteAssets: { pinExtensions: track('tavernRemoteAssets.pinExtensions', async extensions => ({ helperScripts: extensions.helperScripts || [], regexScripts: extensions.regexScripts || [], diagnostics: [], pins: [{ id: 'pin-1' }] })) },
    activityOf: track('activityOf', () => fixture.activity),
    liveSessionFor: track('liveSessionFor', () => undefined),
    assistantResultForTurn: track('assistantResultForTurn', () => null),
    forkTurnsForChat: track('forkTurnsForChat', () => ({ 1: ['m1'] })),
    inputFieldsProjection: { project: track('inputFieldsProjection.project', () => ({ inputSources: ['src'], inputTemplateDisplays: [{ id: 't1' }] })) },
    cardUpdateStatus: track('cardUpdateStatus', async () => ({ available: false })),
    hasTavernScriptRuntime: track('hasTavernScriptRuntime', () => true),
    projectTavernHelperScripts: track('projectTavernHelperScripts', () => ({ scripts: [{ id: 'helper-1' }], diagnostics: [] })),
    worldBooks: { bound: track('worldBooks.bound', async () => ({ view: { name: '演示书', entries: [{ uid: 1 }] } })) },
    projectTavernHelperWorldbook: track('projectTavernHelperWorldbook', view => ({ name: view.name, entries: view.entries })),
    worldBookDisplayName: track('worldBookDisplayName', document => document.name),
    sessionResources: { issue: track('sessionResources.issue', (chatId, revision, kind) => ({ ticket: `${kind}:${chatId}:${revision}`, kind, chatId, revision })) },
    projectTavernHelperContext: track('projectTavernHelperContext', async () => helperContext),
    sessionDebugEvidence: track('sessionDebugEvidence', () => ({ evidence: 'fixture' })),
    rollbackViewFields: track('rollbackViewFields', () => ({ rollbackEvidence: null, rollback: null, rollbackUndo: null })),
    cardViewOf: track('cardViewOf', (card, chat) => ({ path: card.path || chat.cardPath, name: card.name || chat.cardName, tags: card.tags || [] })),
    readChatCard: track('readChatCard', async () => fixture.card),
    readLedger: track('readLedger', ledger => ledger ?? null),
    manualLedger: { project: track('manualLedger.project', () => null) },
    projectCharacterDesignDocument: track('projectCharacterDesignDocument', document => document ?? null),
    manualCharacterDesign: { project: track('manualCharacterDesign.project', () => null) },
    phoneChat: { project: track('phoneChat.project', () => null) },
    mvuReceiptsOf: track('mvuReceiptsOf', (chat, changes) => ({ receipts: [], changes: changes ?? null })),
    OFFICIAL_MVU_VERSION: { commit: 'fixture-commit', assetUrl: 'fixture://mvu' },
    sessionOpeningDescriptor: track('sessionOpeningDescriptor', () => ({ kind: 'story' })),
    readPromptTemplateGlobalVariables: track('readPromptTemplateGlobalVariables', async () => ({ g: 1 })),
    tavernExtensionSettings: { read: track('tavernExtensionSettings.read', async () => ({ ext: true })) },
    TAVERN_COMPATIBILITY_CAPABILITIES: { fixture: true },
    TAVERN_RELEASE_CAPABILITIES: { fixture: true },
    rescueHistoryNotice: track('rescueHistoryNotice', () => '救援提示'),
    settlementTurn: track('settlementTurn', () => 2),
    helperHistoryAccess: { issue: track('helperHistoryAccess.issue', input => ({ access: `history:${input.chatId}:${input.revision}`, ...input })) },
    candidateWorldbookPreparation: { warm: track('candidateWorldbookPreparation.warm', () => undefined) },
    scheduleTemplateSync: track('scheduleTemplateSync', () => undefined),
    helperMessageColdWindow: 24,
    activityBridge: { set: track('activityBridge.set', () => undefined), get: () => undefined },
    backgroundTasks: { activity: track('backgroundTasks.activity', () => fixture.activity) },
    sessionStore: { get: track('sessionStore.get', () => undefined) },
    agentRegistry: { get: track('agentRegistry.get', () => undefined) },
    requestPerformance: { stage: track('requestPerformance.stage', async (_name, run) => run()) }
  }
  deps.__calls = calls
  return deps
}

test('S2-1 缺依赖首次project拒绝且列出缺口（不产半 view）', async () => {
  const empty = createSessionWindowProjector({})
  await assert.rejects(() => empty.project({ chat: { id: 'x' }, window: { from: 0, to: 0, messageCount: 0, revision: 1 } }), /缺少必需依赖/)
  assert.ok(REQUIRED_FUNCTIONS.length >= 40)
  assert.ok(REQUIRED_VALUES.includes('OFFICIAL_MVU_VERSION'))
})

test('S2-1b 构造期不读deps：后声明const经getter延迟取值不受TDZ影响', () => {
  const projector = createSessionWindowProjector({ get manualLedger() { return manualLedger } })
  assert.ok(projector, '构造必须成功')
  const manualLedger = { project: () => null }
  assert.equal(typeof projector, 'object')
  void manualLedger
})

test('S2-2 not-applicable 分流：card / legacy-body / 版本不符', async () => {
  const fixture = buildFixture()
  const projector = createSessionWindowProjector(buildDeps(fixture))
  const base = { ...fixture.chat, messages: [] }
  assert.equal((await projector.project({ chat: { ...base, mode: 'card' }, window: fixture.window })).reason, 'unsupported-mode')
  assert.equal((await projector.project({ chat: { ...base, timeline: { operations: { a: { kind: 'body', status: 'foreground-completed' } } } }, window: fixture.window })).reason, 'legacy-body')
  assert.equal((await projector.project({ chat: { ...base, backgroundConfigVersion: 2 }, window: fixture.window })).reason, 'unsupported-version')
})

test('S2-3 真实作者 view 与投影：整 view 严格 deepEqual（不滤字段、不跳 volatile；activity 同一对象）', async () => {
  const fixture = buildFixture()
  const authorDeps = buildDeps(fixture)
  const projectorDeps = buildDeps(fixture)
  // 作者 body 自带 `replyProjectionsOf`：传给作者的 deps 必须剔除同名键（否则参数遮蔽函数声明）。
  const authorOnlyDeps = { ...authorDeps }
  delete authorOnlyDeps.replyProjectionsOf
  const authorView = await createAuthorViewRunner(authorOnlyDeps)
  const projector = createSessionWindowProjector(projectorDeps)
  assert.equal(typeof authorView, 'function', '作者 view 执行器必须已 await 得到函数')
  for (const name of AUTHOR_EXTRA_DEPS) assert.ok(authorOnlyDeps[name] !== undefined, '作者额外依赖缺失: ' + name)

  // 两侧都用 deferResources:true，使 defer 分支（cardResourceAccess / sessionResources.issue / worldBookDisplayName）**真实参与**并被严格 diff 覆盖。
  const expected = await authorView(fixture.chat, fixture.card, false, { openingWindow: true, deferResources: true, resourceRevision: fixture.window.revision })
  const projected = await projector.project({ chat: fixture.chat, window: fixture.window, activity: fixture.activity, card: fixture.card, options: { openingWindow: true, deferResources: true } })
  assert.equal(projected.kind, 'value')
  // 整 view 严格比较：不滤 `_`、不排除 historyWindow、不跳过 volatile（两侧 activity 为同一 fixture 对象）。
  assert.deepEqual(projected.view, expected, 'view 与真实作者输出不等价（装配等价门）')
  for (const name of ['readTavernSettings', 'readCardExtensions', 'tavernRemoteAssets.pinExtensions', 'incrementalReplyView.project', 'liveCardUpdate.project', 'inputFieldsProjection.project', 'mvuReceiptsOf', 'sessionResources.issue', 'projectTavernHelperContext', 'activityBridge.set']) {
    assert.ok(authorDeps.__calls.includes(name) || projectorDeps.__calls.includes(name), '依赖未参与执行路径: ' + name)
  }
})

test('S2-4 volatile 每次重算；debugTurns 仅在给 resourceKey 时缓存且出借为副本', async () => {
  const fixture = buildFixture()
  const projector = createSessionWindowProjector(buildDeps(fixture))
  const first = await projector.project({ chat: fixture.chat, window: fixture.window, activity: fixture.activity })
  const other = { ...fixture.activity, busy: true, phase: 'running', role: 'settlement' }
  const second = await projector.project({ chat: fixture.chat, window: fixture.window, activity: other })
  assert.equal(first.view.activity.busy, false)
  assert.equal(second.view.activity.busy, true, 'volatile 必须每次重算')
  const cached = await projector.project({ chat: fixture.chat, window: fixture.window, activity: fixture.activity, resourceKey: 'window:5:session-1:b:1' })
  cached.view.debugTurns[0].preview = 'MUTATED'
  const again = await projector.project({ chat: fixture.chat, window: fixture.window, activity: fixture.activity, resourceKey: 'window:5:session-1:b:1' })
  assert.notEqual(again.view.debugTurns[0].preview, 'MUTATED', 'debugTurns 出借必须是副本')
})

test('S2-5 finishOpeningWindow 绝对 id 转换（作者 2107–2124）', async () => {
  const fixture = buildFixture()
  const projector = createSessionWindowProjector(buildDeps(fixture))
  const window = { ...fixture.window, from: 10, to: 11, messageCount: 12, revision: 4 }
  const projected = await projector.project({ chat: fixture.chat, window, activity: fixture.activity, options: { openingWindow: true } })
  const finished = projector.finishOpeningWindow(projected, window, fixture.chat).view
  assert.deepEqual(finished.historyWindow, { onDemand: true, from: 10, to: 11, messageCount: 12, revision: 4 })
  assert.equal(finished.tavernHelper.messages[0].message_id, 10)
  assert.equal(finished.tavernHelper.turnMessageIds['1'], 10)
  assert.equal(finished.tavernHelper.stateRevision, 4)
  assert.equal(finished.tavernHelper.historyAccess.access, 'history:chat-1:4')
})

test('S2-6 transform 唯一锚点/幂等自校验/半应用拒绝/生成块齐备/桥先于 sessionStateView/消费者 guard', () => {
  const source = fs.readFileSync(AUTHOR_INDEX, 'utf8')
  const options = { projectorImportPath: 'dsh-tavern-sqlite-v2/lib/session-window-projector.js' }
  for (const [name, anchor] of Object.entries(ANCHORS)) assert.equal(source.split(anchor).length - 1, 1, '锚点应唯一: ' + name)
  const applied = applyNativeDataTransform(source, options)
  assert.ok(isNativeDataApplied(applied))
  assert.equal(applyNativeDataTransform(applied, options), applied, '幂等')
  for (const [key, block] of Object.entries(REQUIRED_BLOCKS)) assert.ok(applied.includes(block), '缺块: ' + key)
  // 局部替换语义：仅 sessionStateView **块内**那一处 callback 被换成 activityOf；全文其余原始 callback 必须保留（原 4 处 → 剩 3 处）。
  assert.ok(applied.includes(REQUIRED_BLOCKS.stateViewCallback), '块内 callback 未替换为 activity: activityOf')
  assert.equal(applied.split('activity: chat => backgroundTasks.activity(chat),').length - 1, 3, '其余原始 callback 必须保留 3 处（不得全球替换）')
  const bridgeAt = applied.indexOf(REQUIRED_BLOCKS.bridge)
  const stateViewAt = applied.indexOf('const sessionStateView = createSessionStateView({')
  assert.ok(bridgeAt !== -1 && stateViewAt !== -1 && bridgeAt < stateViewAt, '桥必须先于 sessionStateView（TDZ）')
  assert.ok(applied.includes('let openingFastWindow = window'), '缺快路径竞态重投影循环（issue #6）')
  assert.ok(applied.includes('chatJournalStore.readActivitySummary({ chatId: openingFastWindow.chat.id'), '缺消费者 guard')
  assert.ok(applied.includes('连续过期'), '竞态重投影用尽必须响亮报错')
  assert.ok(applied.includes('拒绝返回旧窗口'), '耗尽报错必须拒绝返回旧窗口而非 fallback')
  assert.throws(() => applyNativeDataTransform(applied + '\n// [dsh-tavern-native-data-transform:v1]', options), /半应用|标记数异常/)
})

test('S2-7 真实 module 导出与 bridge wrap/set/null 语义（runtime 可得，非 includes）', async () => {
  const mod = await import('../lib/session-window-projector.js')
  assert.equal(typeof mod.createActivitySummaryBridge, 'function', 'runtime 必须导出 createActivitySummaryBridge（A 装卸依赖）')
  assert.equal(typeof mod.createSessionWindowProjector, 'function')
  const bridge = mod.createActivitySummaryBridge()
  for (const name of ['set', 'get', 'has', 'wrap', 'clear']) assert.equal(typeof bridge[name], 'function', 'bridge 缺方法: ' + name)
  const chat = { id: 'c1' }
  const oldActivity = { phase: 'idle', busy: false, role: '' }
  const activityOf = c => (c === chat ? oldActivity : { phase: 'other', busy: true, role: 'x' })
  const wrapped = bridge.wrap(activityOf)
  assert.equal(wrapped(chat), oldActivity, '未 set 时必须回退原 activityOf')
  const summary = { phase: 'running', busy: true, role: 'settlement' }
  bridge.set(chat, summary)
  assert.equal(bridge.has(chat), true)
  assert.equal(bridge.get(chat), summary)
  assert.equal(wrapped(chat), summary, 'set 后必须取摘要')
  bridge.set(chat, null)
  assert.equal(bridge.has(chat), true, '显式 null 摘要仍视为命中')
  assert.equal(wrapped(chat), null, 'null 摘要必须返回 null 而非回退旧 activity')
  bridge.clear()
  assert.equal(bridge.has(chat), false, 'clear 后不得再命中')
  assert.equal(wrapped(chat), oldActivity, 'clear 后回退原 activityOf')
  assert.throws(() => mod.createActivitySummaryBridge().wrap(null), /需要作者 activityOf 函数/)
})

test('S1b 活动摘要未知形状抛错 + opening 快路径副作用计数（warm 1 / sync 0）', async () => {
  const source = fs.readFileSync(AUTHOR_INDEX, 'utf8')
  const applied = applyNativeDataTransform(source, { projectorImportPath: 'dsh-tavern-sqlite-v2/lib/session-window-projector.js' })
  const body = sliceClosureFunction(applied, 'async function sessionActivity(sessionId) {')
  const make = ({ summary, taskThrows = true } = {}) => {
    const deps = {
      readSessionMap: async () => ({ s1: 'c1' }),
      str: value => (value === undefined || value === null ? '' : String(value)),
      chatJournalStore: { readActivitySummary: () => summary },
      taskStateReader: { forSession: async () => { if (taskThrows) throw new Error('不应调用 taskStateReader'); return { id: 'c1', updatedAt: 0 } } },
      sessionStateView: { status: () => ({ chatId: 'c1' }) }
    }
    const names = Object.keys(deps)
    // 同步 Function 工厂（AsyncFunction 实例返回 Promise，不能直接当函数用）。
    return new Function(...names, `${body}\n  return sessionActivity\n`)(...names.map(name => deps[name]))
  }
  await assert.rejects(() => make({ summary: { kind: 'unexpected' } })('s1'), /未知形状/)
  await assert.rejects(() => make({ summary: undefined })('s1'), /未知形状/)
  const fixture = buildFixture()
  const deps = buildDeps(fixture)
  const projector = createSessionWindowProjector(deps)
  await projector.project({ chat: fixture.chat, window: fixture.window, activity: fixture.activity, card: fixture.card, options: { openingWindow: true } })
  assert.equal(deps.__calls.filter(name => name === 'candidateWorldbookPreparation.warm').length, 1, 'opening 必须 warm 恰好一次')
  assert.equal(deps.__calls.filter(name => name === 'scheduleTemplateSync').length, 0, 'opening 不得触发 scheduleTemplateSync')
})

test('S1宿主活动RPC快路径不调用taskStateReader', async () => {
  // 范围标注：本断言只证明**消费者契约**（施缝后 sessionActivity 的形状与调用路径），
  // 不证明真 store 身份/摘要正确性——真 store fixture 由 A 的 consumer 断言另补。
  const source = fs.readFileSync(AUTHOR_INDEX, 'utf8')
  const applied = applyNativeDataTransform(source, { projectorImportPath: 'dsh-tavern-sqlite-v2/lib/session-window-projector.js' })
  const seamedBody = sliceClosureFunction(applied, 'async function sessionActivity(sessionId) {')
  const statusOf = chat => ({ chatId: chat.id, phase: 'idle', busy: false, role: '', operationId: '', basedOn: null, updatedAt: chat.updatedAt || 0 })
  const build = ({ summary, map = { 'session-1': 'chat-1' }, taskThrows = true } = {}) => {
    const calls = []
    const deps = {
      readSessionMap: async () => map,
      str: value => (value === undefined || value === null ? '' : String(value)),
      chatJournalStore: {
        readActivitySummary: input => {
          calls.push(['summary', input.chatId, input.sessionId])
          if (summary === 'throw') throw new Error('query failed')
          return summary
        }
      },
      taskStateReader: {
        forSession: async () => {
          calls.push(['taskStateReader'])
          if (taskThrows) throw new Error('快路径不得调用 taskStateReader')
          return { id: 'chat-1', updatedAt: 0 }
        }
      },
      sessionStateView: { status: statusOf }
    }
    const names = Object.keys(deps)
    // 用**同步** Function 工厂：AsyncFunction 的实例是 async，调用会返回 Promise 而非内部函数。
    const sessionActivity = new Function(...names, `${seamedBody}\n  return sessionActivity\n`)(...names.map(name => deps[name]))
    return { fn: sessionActivity, sessionActivity, calls }
  }

  // ① kind==='value'：直接成 status（字段与原 status 定义一致），且**不调用** taskStateReader
  const value = {
    kind: 'value', identity: { chatId: 'chat-1' },
    activity: { phase: 'running', busy: true, role: 'settlement', operationId: 'op-1', basedOn: { branchId: 'b1', revision: 3 }, updatedAt: 0 },
    chatUpdatedAt: 42
  }
  const fast = build({ summary: value })
  const fastStatus = await fast.fn('session-1')
  assert.deepEqual(Object.keys(fastStatus).sort(), Object.keys(statusOf({ id: 'chat-1', updatedAt: 0 })).sort(), 'status 字段集必须与原定义一致')
  assert.equal(fastStatus.chatId, 'chat-1')
  assert.equal(fastStatus.phase, 'running')
  assert.equal(fastStatus.busy, true)
  assert.equal(fastStatus.role, 'settlement')
  assert.equal(fastStatus.operationId, 'op-1')
  assert.deepEqual(fastStatus.basedOn, { branchId: 'b1', revision: 3 })
  assert.equal(fastStatus.updatedAt, 42, '摘要 updatedAt 为 0 时回退 chatUpdatedAt（不 coerce 类型）')
  assert.deepEqual(fast.calls, [['summary', 'chat-1', 'session-1']], '快路径只允许一次摘要查询')

  // ② 摘要 updatedAt 有值 ⇒ 原样使用（不改摘要字段）
  const withStamp = build({ summary: { ...value, activity: { ...value.activity, updatedAt: 7 } } })
  assert.equal((await withStamp.fn('session-1')).updatedAt, 7)

  // ③ not-applicable ⇒ 才回原 taskStateReader + sessionStateView.status
  const fallback = build({ summary: { kind: 'not-applicable', reason: 'legacy-body' }, taskThrows: false })
  const fallbackStatus = await fallback.fn('session-1')
  assert.ok(fallback.calls.some(([name]) => name === 'taskStateReader'), 'not-applicable 必须回原路径')
  assert.deepEqual(fallbackStatus, statusOf({ id: 'chat-1', updatedAt: 0 }))

  // ④ 摘要 null ⇒ 直接 null，不回退
  const nullSummary = build({ summary: null })
  assert.equal(await nullSummary.fn('session-1'), null)
  assert.ok(!nullSummary.calls.some(([name]) => name === 'taskStateReader'), 'null 不得回退')

  // ⑤ 查询错误上抛（不吞）
  await assert.rejects(() => build({ summary: 'throw' }).fn('session-1'), /query failed/)

  // ⑥ 无 chatId 映射 ⇒ null（不触达摘要）
  const unmapped = build({ summary: value, map: {} })
  assert.equal(await unmapped.fn('session-1'), null)
  assert.deepEqual(unmapped.calls, [], '无映射时不得查询摘要')
})

// TODO（真实 helper 门）：把 projectTavernHelperContext / mvu receipt / incremental regex 换成作者 domain 模块真实 import 后重跑 S2-3；
// 在此之前 S2-3 只声明「装配等价」，不声明真实 helper 语义等价。实时 Session 跨库、外部 resources 每次重算，均不作跨库快照声明。

// 冷窗口作用域（2026-10-09）：只有 `options.skeletonUntil === true` 才真按 helperMessageColdWindow 读冷窗口边界；
// 只传 deferResources 不构成覆盖。此处显式 coldWindow=1 + skeletonUntil:true，捕获传给作者
// projectTavernHelperContext 的 skeletonUntil，必须等于 max(0, chat.messages.length - coldWindow)，且真实 project 产出 kind=value。
test('冷窗口：skeletonUntil真值与coldWindow边界一致且真实project产出kind=value', async () => {
  const fixture = buildFixture()
  const deps = buildDeps(fixture)
  deps.helperMessageColdWindow = 1
  let captured = null
  let capturedIndexed = null
  const baseProject = deps.projectTavernHelperContext
  deps.projectTavernHelperContext = async (chat, options) => { captured = options?.skeletonUntil; capturedIndexed = options?.indexed; return await baseProject(chat, options) }
  const projector = createSessionWindowProjector(deps)
  const projected = await projector.project({ chat: fixture.chat, window: fixture.window, activity: fixture.activity, card: fixture.card, options: { skeletonUntil: true } })
  assert.equal(projected.kind, 'value', '真实 project 必须产出 kind=value')
  assert.equal(deps.__calls.includes('projectTavernHelperContext'), true, '前置：本次 project 必须真的走到作者 helper 上下文投影')
  assert.equal(capturedIndexed, true, 'projectTavernHelperContext 必须以 indexed:true 调用')
  assert.equal(captured, Math.max(0, fixture.chat.messages.length - 1), 'skeletonUntil 必须＝max(0, messages.length - helperMessageColdWindow)')
})
