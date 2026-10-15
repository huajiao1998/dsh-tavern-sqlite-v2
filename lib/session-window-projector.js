// [dsh-tavern-session-window-projector:v1]
// S2 窗口投影：受支持的 DB opening 由插件**逐字段等价**组装作者最终 view（作者 index.js:1765–1911 的 `view`），
// 不调用作者通用 `view`、不恢复全 Chat、不读完整 timeline（仅小 meta + 小 operations 字段）。
// 规则：所有作者业务语义经 deps **注入**（对象方法保持绑定，不解构）；缺任何必需依赖即抛，不产出半 view；
//       缓存仅限 debugTurns/静态标量块且键含 window revision 与显式 resourceKey；其余每次重算。
// 作者对照：`view` 字段顺序与表达式逐条对应；opening 尾部（index.js:2107–2124）由 finishOpeningWindow 实现。

export const MARKER = '// [dsh-tavern-session-window-projector:v1]'

import { isLiveFailureEvidence } from './failure-view-evidence.js'

/**
 * 失败证据读口（投影与宿主共用同一判定）：优先注入的 readFailureEvidence(sessionId)（宿主 DI＝
 * sessionDebugEvidence + sessionQuery.observeSession）；旧夹具没有该依赖时**只在作者证据未明确 loaded:false** 时放行旧形状，
 * 冷档（loaded:false）缺 DI 必须响亮失败——不许用空事件冒充失败尾、也不许静默退回收窄摘要。
 */
export async function resolveFailureEvidence(get, sessionId, chatId = undefined) {
  const readEvidence = typeof get('readFailureEvidence') === 'function' ? get('readFailureEvidence') : null
  if (readEvidence) return await readEvidence(sessionId, chatId)
  const legacy = get('sessionDebugEvidence')(sessionId, true)
  if (legacy && legacy.loaded === false && !isLiveFailureEvidence(legacy)) throw new Error('冷视图失败证据缺少 readFailureEvidence 接线：会话未装载时拒绝用空事件冒充失败尾')
  return legacy
}

/** 逐条对应作者 view 表达式所需的真实依赖；键名＝宿主闭包中的标识符（对象方法用 `obj.method` 形式并保持绑定）。 */
export const REQUIRED_FUNCTIONS = Object.freeze([
  'str',
  'assembleTavernView',
  'projectCompactionState',
  'readTavernSettings',
  'readScript',
  'scriptContinuity.inspect',
  'groupOfMode',
  'replyProjectionsOf',
  'incrementalReplyView.project',
  'composeTavernRegexScripts',
  'liveCardUpdate.project',
  'withLegacyPresentationProjection',
  'readCardExtensions',
  'tavernRemoteAssets.pinExtensions',
  'activityOf',
  'liveSessionFor',
  'assistantResultForTurn',
  'forkTurnsForChat',
  'inputFieldsProjection.project',
  'cardUpdateStatus',
  'hasTavernScriptRuntime',
  'projectTavernHelperScripts',
  'worldBooks.bound',
  'projectTavernHelperWorldbook',
  'worldBookDisplayName',
  'scheduleTemplateSync',
  'candidateWorldbookPreparation.warm',
  'activityBridge.set',
  'sessionResources.issue',
  'projectTavernHelperContext',
  'sessionDebugEvidence',
  'rollbackViewFields',
  'cardViewOf',
  'readChatCard',
  'readLedger',
  'manualLedger.project',
  'projectCharacterDesignDocument',
  'manualCharacterDesign.project',
  'phoneChat.project',
  'mvuReceiptsOf',
  'sessionOpeningDescriptor',
  'readPromptTemplateGlobalVariables',
  'tavernExtensionSettings.read',
  'helperHistoryAccess.issue'
])

/** 对象常量/标量依赖：只校验存在，不按 function 判（作者里它们是常量对象与宿主常量）。 */
export const REQUIRED_VALUES = Object.freeze([
  'OFFICIAL_MVU_VERSION',
  'TAVERN_COMPATIBILITY_CAPABILITIES',
  'TAVERN_RELEASE_CAPABILITIES',
  'helperMessageColdWindow'
])

/** 供宿主/转换核对用的完整清单（函数 + 常量）。 */
export const REQUIRED_DEPENDENCIES = Object.freeze([...REQUIRED_FUNCTIONS, ...REQUIRED_VALUES])

/**
 * 活动摘要桥：作者 `sessionStateView.status`/`mvuReceipts` 内部会 `activityOf(chat)`→`inspect`；
 * 该桥用同步 WeakMap chat→摘要让既有小 helper 取到已算好的摘要，其它 Chat 仍走原 activity。
 * 只读、不缓存 Chat；`clear()` 用重建 WeakMap 实现（WeakMap 无 clear 方法）。
 */
export function createActivitySummaryBridge() {
  let summaries = new WeakMap()
  return Object.freeze({
    set(chat, summary) { if (chat && typeof chat === 'object') summaries.set(chat, summary) },
    get(chat) { return chat && typeof chat === 'object' ? summaries.get(chat) : undefined },
    has(chat) { return !!(chat && typeof chat === 'object') && summaries.has(chat) },
    /** 包装作者 activityOf：命中桥（含显式 null 摘要）即返回，未命中才调用原函数。 */
    wrap(activityOf) {
      if (typeof activityOf !== 'function') throw new Error('活动摘要桥需要作者 activityOf 函数')
      return function bridgedActivityOf(chat) {
        if (chat && typeof chat === 'object' && summaries.has(chat)) return summaries.get(chat)
        return activityOf(chat)
      }
    },
    clear() { summaries = new WeakMap() }
  })
}

const CACHE_CAPACITY = 8

export function createSessionWindowProjector(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('窗口投影缺少依赖对象')
  const get = path => {
    const parts = path.split('.')
    let owner = deps
    for (let index = 0; index < parts.length - 1; index += 1) {
      owner = owner === undefined || owner === null ? undefined : owner[parts[index]]
    }
    const value = owner === undefined || owner === null ? undefined : owner[parts[parts.length - 1]]
    // 对象方法保持绑定：deps 传原对象（incrementalReplyView/liveCardUpdate/…），此处按接收者 bind。
    return typeof value === 'function' && owner !== undefined && owner !== null && parts.length > 1 ? value.bind(owner) : value
  }
  // 构造期不读 deps：宿主在 projectOpeningWindow 前注入，manualLedger 等 const 尚未初始化。
  // 首次 project/finishOpeningWindow 再校验，缺依赖仍拒绝半 view。
  let validated = false
  let coldWindow
  const assertDeps = () => {
    if (validated) return
    const missingFns = REQUIRED_FUNCTIONS.filter(name => typeof get(name) !== 'function')
    const missingVals = REQUIRED_VALUES.filter(name => get(name) === undefined || get(name) === null)
    if (missingFns.length > 0 || missingVals.length > 0) {
      throw new Error('窗口投影缺少必需依赖（拒绝半 view）: ' + [...missingFns, ...missingVals].join(', '))
    }
    coldWindow = Number(get('helperMessageColdWindow'))
    if (!Number.isSafeInteger(coldWindow) || coldWindow < 0) throw new Error('窗口投影缺少 HELPER_MESSAGE_COLD_WINDOW（须由宿主注入，不硬编码）')
    validated = true
  }
  const cache = new Map()

  /** 作者 `mvuReceiptsOf(chat, changes)`：**两参**；活动证据由 sessionStateView 闭包（桥）负责，投影不插参。 */
  const mvuReceiptsOf = (chat, changes) => get('mvuReceiptsOf')(chat, changes)

  /** 作者 `replyProjectionsOf`（本地函数，注入保真）。 */
  const replyProjectionsOf = chat => get('replyProjectionsOf')(chat)

  /**
   * @param {{chat:object, window:{from:number,to:number,messageCount:number,revision:number}, activity:object,
   *          card?:object, options?:object, resourceKey?:string, inputChanges?:any, sessionId?:string}} input
   */
  async function project(input) {
    assertDeps()
    const source = input?.chat
    const window = input?.window
    if (!source || !window) throw new Error('窗口投影缺少 chat/window')
    // 与作者 projectOpeningWindow(2111) 一致：窗口副本（去 _storageRevision、带 windowRevision），
    // 让 readChatCard/regex/inputFieldsProjection 拿到与作者相同的输入形状。
    const chat = { ...source, _storageRevision: undefined, windowRevision: window.revision }
    if (chat.mode === 'card') return { kind: 'not-applicable', reason: 'unsupported-mode' }
    if (Object.values(chat.timeline?.operations || {}).some(op => op?.kind === 'body' && op.status === 'foreground-completed')) {
      return { kind: 'not-applicable', reason: 'legacy-body' }
    }
    if (chat.backgroundConfigVersion !== 1 || chat.conversationFeaturesVersion !== 1) return { kind: 'not-applicable', reason: 'unsupported-version' }

    const options = input.options || {}
    const str = get('str')
    const activity = input.activity ?? get('activityOf')(chat)
    const card = input.card ?? await get('readChatCard')(chat)
    const resourceRevision = window.revision
    // 桥登记该副本，避免 sessionStateView.mvuReceipts 内部再 inspect。
    get('activityBridge').set(chat, activity)
    const deferResources = options.deferResources === true && chat.mode !== 'card'
      && Number.isSafeInteger(resourceRevision) && !!chat.cardDefinitionSnapshot
      && chat.openingWorldbookSnapshot?.version === 1

    // 作者副作用顺序（原 view 1771–1773）：**先** warm/scheduleTemplateSync，**再** await readTavernSettings()；
    // 顺序属合约（settings 失败时原实现已触发 warm）。
    if (options.openingWindow) void get('candidateWorldbookPreparation')?.warm?.(chat.sessionId)
    else get('scheduleTemplateSync')(chat)
    const runtimeSettings = await get('readTavernSettings')()
    let scriptProgress = null
    if ((chat.mode || 'story') === 'script') {
      const script = await get('readScript')(chat.cardPath)
      if (script !== undefined && Array.isArray(script.chunks)) {
        scriptProgress = get('scriptContinuity.inspect')({ script, state: chat.scriptState, request: { kind: 'progress' } })
      }
    }
    const activePresetSnapshot = get('groupOfMode')(chat.mode) === 'play' && chat.runtimePresetSnapshot && typeof chat.runtimePresetSnapshot === 'object'
      ? chat.runtimePresetSnapshot : null
    let replyDisplay = { projections: replyProjectionsOf(chat), statusViews: [], presentation: null, latestSourceBacked: false }
    let cardExtensions = { regexScripts: [], helperScripts: [] }
    if ((chat.mode || 'story') === 'story' || (chat.mode || 'story') === 'script') {
      cardExtensions = await get('readCardExtensions')(chat.cardPath, chat) || cardExtensions
      const pinnedExtensions = await get('tavernRemoteAssets.pinExtensions')(cardExtensions)
      cardExtensions = Object.assign({}, cardExtensions, {
        helperScripts: pinnedExtensions.helperScripts,
        regexScripts: pinnedExtensions.regexScripts,
        remoteAssetDiagnostics: pinnedExtensions.diagnostics,
        remoteAssetPins: pinnedExtensions.pins
      })
      const presetRegexScripts = Array.isArray(activePresetSnapshot && activePresetSnapshot.regexScripts) ? activePresetSnapshot.regexScripts : []
      replyDisplay = await get('incrementalReplyView.project')(options.persistedProjection ? chat : { ...chat, _storageRevision: undefined }, {
        charName: chat.cardName, macroState: chat.macroState,
        regexScripts: get('composeTavernRegexScripts')(cardExtensions, presetRegexScripts),
        placement: 2, isMarkdown: true, isEdit: false, depth: 0
      }, { charName: chat.cardName, macroState: chat.macroState, regexScripts: cardExtensions.regexScripts }, { shared: true })
      replyDisplay = await get('liveCardUpdate.project')(chat, card, replyDisplay, { charName: chat.cardName, macroState: chat.macroState, regexScripts: cardExtensions.regexScripts })
      replyDisplay.projections = get('withLegacyPresentationProjection')(chat, replyDisplay.projections)
    }

    // debugTurns：可缓存（键含 window revision 与 resourceKey）；其余字段一律重算。
    // 缓存键必须含身份维度：同 chat 复用但 session/branch/lifecycle 变化时不得命中。
    const cacheKey = (typeof input.resourceKey === 'string' && Number.isSafeInteger(window.revision))
      ? JSON.stringify([chat.id, chat.sessionId, window.revision, window.from, window.to,
        chat.timeline?.branchId ?? '', chat.tavernHelperLifecycleRevision ?? '', input.resourceKey]) : null
    let debugTurns = cacheKey === null ? undefined : cache.get(cacheKey)
    if (debugTurns === undefined) {
      debugTurns = []
      const messages = Array.isArray(chat.messages) ? chat.messages : []
      for (let index = messages.length - 1; index >= 0 && debugTurns.length < 12; index--) {
        const message = messages[index]
        if (!message || message.role !== 'assistant') continue
        const turn = Math.max(0, Number(message.turn) || (message.greeting === true ? 1 : 0))
        if (turn === 0) continue
        const source = (str(message.sourceText) || str(message.text)).replace(/\s+/g, ' ').trim()
        debugTurns.push({ turn, preview: source.slice(0, 90), chars: source.length })
      }
      // 作者新合同：最新优先、最多12条；revision/身份键保缓存与物理回退失效。
      if (cacheKey !== null) { cache.set(cacheKey, debugTurns); while (cache.size > CACHE_CAPACITY) cache.delete(cache.keys().next().value) }
    }
    const latestStoryTurn = Number(debugTurns[0]?.turn) || 0
    const liveSession = get('liveSessionFor')(str(chat.sessionId))
    const latestAssistant = latestStoryTurn > 0 ? get('assistantResultForTurn')(liveSession, latestStoryTurn) : null
    const latestAssistantMessageId = str(latestAssistant?.event?.data?.message?.id)
    const forkTurnsByMessageId = get('forkTurnsForChat')(chat)
    const { inputSources, inputTemplateDisplays } = get('inputFieldsProjection.project')(options.persistedProjection ? chat : { ...chat, _storageRevision: undefined }, input.inputChanges)
    const cardUpdate = ['story', 'script'].includes(chat.mode || 'story') && chat.requestMode !== 'sillytavern'
      ? await get('cardUpdateStatus')(chat) : { available: false }
    const helperEnabled = get('hasTavernScriptRuntime')(chat, cardExtensions.helperScripts)
    const helperRuntime = helperEnabled ? get('projectTavernHelperScripts')(cardExtensions.helperScripts, chat.tavernHelperScriptVariables) : { scripts: [], diagnostics: [] }
    helperRuntime.diagnostics.push(...(Array.isArray(cardExtensions.remoteAssetDiagnostics) ? cardExtensions.remoteAssetDiagnostics : []))
    let helperWorldbook = null
    if (helperEnabled && str(chat.cardPath) !== '') {
      try {
        if (deferResources) {
          const document = chat.openingWorldbookSnapshot.document
          helperWorldbook = document === null ? null : { name: get('worldBookDisplayName')(document), resourceAccess: get('sessionResources.issue')(chat.id, resourceRevision, 'worldbook') }
        } else {
          const record = await get('worldBooks.bound')(chat.cardPath, card, chat)
          if (record !== null) helperWorldbook = get('projectTavernHelperWorldbook')(record.view)
        }
      } catch (error) {
        helperRuntime.diagnostics.push({ scriptId: '', name: '世界书', status: 'unavailable', message: str(error && error.message || error) })
      }
    }
    const messageCount = Array.isArray(chat.messages) ? chat.messages.length : 0
    const skeletonUntil = options.skeletonUntil === true
      ? Math.max(0, messageCount - coldWindow)
      : (Number.isSafeInteger(options.skeletonUntil) ? Math.max(0, options.skeletonUntil) : 0)
    const helperContext = helperEnabled ? await get('projectTavernHelperContext')(chat, { skeletonUntil, indexed: true }) : null
    // 窄窗口失败清理摘要：store 在同快照算好、经 window 带入；非枚举挂载，不进作者 chat 形状与序列化。
    // rollbackViewFields（含 latestFailureTarget 接缝）在同一次调用内读取；完整档回落路径无此键，自动走原分支。
    if (window && window.failureCleanup && typeof window.failureCleanup === 'object') {
      Object.defineProperty(chat, 'failureCleanup', { value: window.failureCleanup, enumerable: false, configurable: true, writable: true })
    }
    // 证据带 chatId 进读口（后台结算按 chatId 归属），并把同快照活动带进证据供 view 的静止门使用。
    const sourceEvidence = await resolveFailureEvidence(get, chat.sessionId, chat.id)
    const activityEvidence = { ...sourceEvidence, activity }
    const rollbackEvidence = window.nativeFailureCheckpointTurn === undefined ? activityEvidence
      : { ...activityEvidence, nativeFailureCheckpointTurn: window.nativeFailureCheckpointTurn }
    const rollbackFields = get('rollbackViewFields')(chat, rollbackEvidence, input.inputChanges)

    // 最终字段表来自本次作者view；这里只保窄窗口准备与身份/冷证据合同。
    const view = await get('assembleTavernView')({
      chat, card, str, deferResources, resourceRevision, activePresetSnapshot, cardUpdate,
      contextCompaction: get('projectCompactionState')(chat),
      debugTurns, latestAssistantMessageId, forkTurnsByMessageId, latestStoryTurn,
      inputSources, inputTemplateDisplays, rollbackFields, replyDisplay, helperContext,
      helperWorldbook, cardExtensions, helperRuntime, runtimeSettings, activity, scriptProgress,
      cardViewOf: get('cardViewOf'), sessionResources: {issue:get('sessionResources.issue')},
      readLedger: get('readLedger'), manualLedger:{project:get('manualLedger.project')},
      projectCharacterDesignDocument:get('projectCharacterDesignDocument'), manualCharacterDesign:{project:get('manualCharacterDesign.project')},
      phoneChat:{project:get('phoneChat.project')}, mvuReceiptsOf,
      sessionOpeningDescriptor:get('sessionOpeningDescriptor'), readPromptTemplateGlobalVariables:get('readPromptTemplateGlobalVariables'),
      TAVERN_COMPATIBILITY_CAPABILITIES:get('TAVERN_COMPATIBILITY_CAPABILITIES'), tavernExtensionSettings:{read:get('tavernExtensionSettings.read')},
      OFFICIAL_MVU_VERSION:get('OFFICIAL_MVU_VERSION'), TAVERN_RELEASE_CAPABILITIES:get('TAVERN_RELEASE_CAPABILITIES'),
      rescueHistoryNotice:get('rescueHistoryNotice'), settlementTurn:get('settlementTurn')
    })
    // 缓存debugTurns不能让调用方改其内部条目（原逐字段实现的隔离合同）。
    view.debugTurns = view.debugTurns.map(row => ({...row}))
    return { kind: 'value', view }
  }

  /** 作者 projectOpeningWindow 尾部（index.js:2107–2124）：historyWindow + Helper 绝对 id 转换。 */
  function finishOpeningWindow(result, window, chat) {
    assertDeps()
    const view = result.view
    view.historyWindow = { onDemand: true, from: window.from, to: window.to, messageCount: window.messageCount, revision: window.revision }
    if (view.tavernHelper) {
      const helper = view.tavernHelper
      const messages = helper.messages.map((row, index) => ({ ...row, message_id: window.from + index }))
      view.tavernHelper = {
        ...helper, stateRevision: window.revision, messages,
        turnMessageIds: Object.fromEntries(Object.entries(helper.turnMessageIds).map(([turn, index]) => [turn, window.from + index])),
        historyAccess: get('helperHistoryAccess.issue')({ chatId: chat.id, revision: window.revision, messageCount: window.messageCount })
      }
    }
    return result
  }

  function clear(chatId) { for (const key of [...cache.keys()]) if (chatId === undefined || key.startsWith('["' + chatId + '"')) cache.delete(key) }

  return Object.freeze({ project, finishOpeningWindow, clear, marker: MARKER, requiredDependencies: REQUIRED_DEPENDENCIES })
}

export default createSessionWindowProjector
