// S2 真实业务 Helper/MVU/regex 差分（**只写不跑**）：把固定 68215 作者的 `view` + `replyProjectionsOf` 原样摘出，
// 用**同步 Function 工厂**配同一批真实依赖执行，与插件 `projector.project()` 的整 view 做 `deepEqual`。
// 范围：纯业务 helper / MVU receipt / regex 用**真实 domain import**；低层 host I/O（库读、资源票据、readChanges）为受控实现，
// 完整宿主席位仍由 A 的真 store consumer 另证。不得以 TODO 代替差分：本文件即整 view 差分本体。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
// 作者部分 domain 模块传递性 import 'jsdom'：用桩加载器在**不安装任何包**的前提下真实 import 作者模块。
register('./support/author-jsdom-stub-loader.mjs', import.meta.url)
import { createSessionWindowProjector, createActivitySummaryBridge } from '../lib/session-window-projector.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUTHOR_LIB = path.resolve(HERE, '..', '..', '..', 'tmp', 'release-034-20261008', 'author-fixture', 'src',
  'dsh-tavern-68215e47516637e00c75d2b4bba3192679559425', 'tavern-plugin', 'lib')
const AUTHOR_INDEX = path.join(AUTHOR_LIB, 'index.js')
const domain = name => import(pathToFileURL(path.join(AUTHOR_LIB, 'domain', name)).href)

function sliceClosureFunction(source, header, endMarker = '\n  }\n') {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, '未找到作者函数头: ' + header)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, '未找到作者函数尾: ' + header)
  return source.slice(start, end + endMarker.length)
}

/** 作者 view 执行器：**同步** Function 工厂（返回的 async view 直接可调）；deps 名与调用方完全一致。 */
export function makeAuthorView(deps) {
  const source = fs.readFileSync(AUTHOR_INDEX, 'utf8')
  const replyBody = sliceClosureFunction(source, 'function replyProjectionsOf(chat) {')
  const viewBody = sliceClosureFunction(source, 'async function view(chat, card, persistedProjection = false, options = {}) {')
  assert.ok(!Object.hasOwn(deps, 'replyProjectionsOf'), '作者 deps 不得含 replyProjectionsOf（body 内自带）')
  const names = Object.keys(deps)
  return new Function(...names, `${replyBody}\n  ${viewBody}\n  return view\n`)(...names.map(name => deps[name]))
}

test('S2真实业务Helper/MVU/regex差分', async () => {
  const { projectTavernHelperContext } = await domain('tavern-helper-context.js')
  const { createSessionStateView } = await domain('chat-session-state.js')
  const { createMvuReceiptIndex } = await domain('mvu-receipt-index.js')
  const { createIncrementalReplyView } = await domain('incremental-reply-view.js')
  const { projectTavernHelperScripts } = await domain('tavern-helper-scripts.js')
  const { projectTavernHelperWorldbook } = await domain('tavern-helper-worldbook.js')
  const { projectCharacterDesignDocument } = await domain('character-design-document.js')
  const { projectPhoneChat } = await domain('phone-chat.js')
  for (const [name, fn] of Object.entries({ projectTavernHelperContext, createSessionStateView, createMvuReceiptIndex, createIncrementalReplyView, projectTavernHelperScripts, projectTavernHelperWorldbook, projectCharacterDesignDocument, projectPhoneChat })) {
    assert.equal(typeof fn, 'function', '真实 export 缺失: ' + name)
  }

  const activity = Object.freeze({ busy: false, phase: 'idle', role: '', operationId: '', basedOn: null, reason: null, updatedAt: 21 })
  const messages = [
    { role: 'assistant', turn: 1, text: '第一轮', sourceText: '第一轮', displayText: '第一轮', displayMode: 'markdown', swipeId: 0, swipes: ['第一轮', '第一轮·改'], variables: [{ stat_data: { hp: 1 } }] },
    { role: 'user', turn: 2, text: '输入', sourceText: '输入' },
    { role: 'assistant', turn: 2, text: '第二轮', sourceText: '第二轮', displayText: '<b>第二轮</b>', displayMode: 'html', swipeId: 0, swipes: ['第二轮'], variables: [{ stat_data: { hp: 2 } }] }
  ]
  // 两侧同一 chat：**revision 清除一致**（不带 _storageRevision），窗口副本语义由各自内部构造。
  const chat = {
    id: 'chat-r1', sessionId: 'session-r1', mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    messages, macroState: { userName: '玩家' }, mvu: { enabled: true, owner: 'official' }, updatedAt: 21,
    cardPath: '/cards/demo.png', cardName: '演示卡', variables: { hp: 2 }, guides: ['g'],
    characterDesignDocument: { id: 'd1', name: '人物' }, cardDefinitionSnapshot: { name: '演示卡' }
  }
  const window = { from: 0, to: 2, messageCount: 3, revision: 5, nativeData: true }
  const card = { path: chat.cardPath, name: chat.cardName, tags: [] }

  /** 两侧各自独立的 deps（真实 helper 同一实现、内部状态独立）；活动用同一固定对象。 */
  const buildDeps = () => {
    const bridge = createActivitySummaryBridge()
    bridge.set(chat, activity)
    const incrementalReplyView = createIncrementalReplyView({
      readChanges: async () => ({ indices: [], revision: window.revision, layoutFrom: null, tail: null })
    })
    const receiptIndex = createMvuReceiptIndex({ shared: true })
    const sessionStateView = createSessionStateView({
      sharedReceipts: true, sharedMappings: true,
      activity: bridge.wrap(() => activity),
      evidence: () => ({ evidence: 'fixture' })
    })
    const deps = {
      str: value => (value === undefined || value === null ? '' : String(value)),
      readTavernSettings: async () => ({ trustedCardMode: false, frameSizing: 'fill' }),
      readScript: async () => undefined,
      scriptContinuity: { inspect: () => null },
      groupOfMode: () => 'story',
      incrementalReplyView,
      composeTavernRegexScripts: (cardExtensions, presetRegexScripts) => [...(presetRegexScripts || []), ...((cardExtensions && cardExtensions.regexScripts) || [])],
      liveCardUpdate: { project: async (_c, _card, display) => display },
      withLegacyPresentationProjection: (_chat, projections) => projections,
      readCardExtensions: async () => ({ regexScripts: [{ id: 'rx1' }], helperScripts: [{ id: 'helper-1', content: '' }], variables: { v: 1 }, globalRegexScripts: [], characterRegexScripts: [], frameSizing: 'fill' }),
      tavernRemoteAssets: { pinExtensions: async extensions => ({ helperScripts: extensions.helperScripts || [], regexScripts: extensions.regexScripts || [], diagnostics: [], pins: [{ id: 'pin-1' }] }) },
      activityOf: bridge.wrap(() => activity),
      activityBridge: bridge,
      liveSessionFor: () => undefined,
      assistantResultForTurn: () => null,
      forkTurnsForChat: () => ({}),
      inputFieldsProjection: { project: () => ({ inputSources: ['src'], inputTemplateDisplays: [{ id: 't1' }] }) },
      cardUpdateStatus: async () => ({ available: false }),
      hasTavernScriptRuntime: () => true,
      projectTavernHelperScripts,
      worldBooks: { bound: async () => null },
      projectTavernHelperWorldbook,
      worldBookDisplayName: document => (document && document.name) || '',
      sessionResources: { issue: (chatId, revision, kind) => ({ ticket: `${kind}:${chatId}:${revision}`, kind, chatId, revision }) },
      projectTavernHelperContext,
      sessionDebugEvidence: () => ({ evidence: 'fixture' }),
      rollbackViewFields: () => ({ rollbackEvidence: null, rollback: null, rollbackUndo: null }),
      cardViewOf: (value, source) => ({ path: value.path || source.cardPath, name: value.name || source.cardName, tags: value.tags || [] }),
      readChatCard: async () => card,
      readLedger: ledger => ledger ?? null,
      manualLedger: { project: () => null },
      projectCharacterDesignDocument,
      manualCharacterDesign: { project: () => null },
      phoneChat: { project: projectPhoneChat },
      mvuReceiptsOf: (target, changes) => (typeof receiptIndex.project === 'function' ? receiptIndex.project(target, activity, changes) : receiptIndex(target, activity, changes)),
      sessionStateView,
      OFFICIAL_MVU_VERSION: { commit: 'fixture-commit', assetUrl: 'fixture://mvu' },
      sessionOpeningDescriptor: () => ({ kind: 'story' }),
      readPromptTemplateGlobalVariables: async () => ({ g: 1 }),
      tavernExtensionSettings: { read: async () => ({ ext: true }) },
      TAVERN_COMPATIBILITY_CAPABILITIES: { fixture: true },
      TAVERN_RELEASE_CAPABILITIES: { fixture: true },
      rescueHistoryNotice: () => '',
      settlementTurn: () => 2,
      helperHistoryAccess: { issue: input => ({ access: `history:${input.chatId}:${input.revision}`, ...input }) },
      candidateWorldbookPreparation: { warm: () => undefined },
      scheduleTemplateSync: () => undefined,
      helperMessageColdWindow: 24,
      HELPER_MESSAGE_COLD_WINDOW: 24,
      requestPerformance: { stage: async (_name, run) => run() },
      sessionStore: { get: () => undefined },
      agentRegistry: { get: () => undefined },
      backgroundTasks: { activity: () => activity }
    }
    return { bridge, deps }
  }

  const pluginSide = buildDeps()
  const authorSide = buildDeps()
  // 插件侧需要 `replyProjectionsOf` 依赖；作者 body 自带同名函数，故把**作者那份真实实现**同时交给插件侧，
  // 保证两侧用同一实现（不是各写一份）。
  const authorReplySource = sliceClosureFunction(fs.readFileSync(AUTHOR_INDEX, 'utf8'), 'function replyProjectionsOf(chat) {')
  const realReplyProjectionsOf = new Function('str', `${authorReplySource}\n  return replyProjectionsOf\n`)(pluginSide.deps.str)
  const projector = createSessionWindowProjector({ ...pluginSide.deps, replyProjectionsOf: realReplyProjectionsOf })
  const authorView = makeAuthorView(authorSide.deps) // deps 已不含 replyProjectionsOf
  assert.equal(typeof authorView, 'function', '作者 view 必须由同步工厂返回可调函数')

  const expected = await authorView(chat, card, false, { openingWindow: true, deferResources: true, resourceRevision: window.revision })
  const projected = await projector.project({ chat, window, activity, card, options: { openingWindow: true, deferResources: true } })
  assert.equal(projected.kind, 'value', '受支持输入必须产出 value（不得 not-applicable）')
  assert.deepEqual(projected.view, expected, '整 view 必须与真实作者 view 深度等价（含 volatile 与资源票据）')

  // opening 绝对坐标（作者 finish 对应实现）
  const window10 = { ...window, from: 10, to: 12, messageCount: 13, revision: 6 }
  const expected10 = await authorView(chat, card, false, { openingWindow: true, deferResources: true, resourceRevision: window10.revision })
  const projected10 = await projector.project({ chat, window: window10, activity, card, options: { openingWindow: true, deferResources: true } })
  const finished = projector.finishOpeningWindow(projected10, window10, chat).view
  assert.deepEqual(finished.historyWindow, { onDemand: true, from: 10, to: 12, messageCount: 13, revision: 6 })
  assert.equal(finished.tavernHelper.turnMessageIds['1'], 10, 'turnMessageIds 必须映射到绝对楼号')
  assert.ok(expected10 && expected10.tavernHelper, '作者侧同输入必须产出 Helper 段（对照基准存在）')
})

// 说明：低层 host I/O（库读、资源票据、readChanges 的真实 native 索引）仍是受控实现；
// 完整宿主席位与真 store 摘要另由 A 的 consumer 断言覆盖。cache 跨身份隔离 case 为另一小动作。
