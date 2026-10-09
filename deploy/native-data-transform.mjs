// [dsh-tavern-native-data-transform:v1]
// S2 宿主接线转换（单文件）。**唯一锚点、按锚点计数验证、幂等自校验**；不改作者算法、不复制作者函数、不 catch-all。
// 已接线块：import / 活动桥（sessionStateView 之前）/ 回调整行替换 / 投影工厂 / opening 快路径 / readOpeningWindow 存储优先 /
// S3 setStatusBarPlacement 窄写 / **S4 storyContext＋hookChatForSession 前台取数**。
// 未接线（待主给真实函数体）：getSessionActivity → 见 PENDING_HOST_WIRING。

export const NATIVE_DATA_MARKER = '// [dsh-tavern-native-data-transform:v1]'

/** S4 前台取数锚点标记：恰出现 1 次（audit 用；不参与 markerCount 幂等键）。 */
export const STORY_INPUT_MARKER = '// [dsh-tavern-native-data-transform:s4-story-input]'

/** sessionActivity 真实函数体锚点（1981–1984，唯一）。 */
export const SESSION_ACTIVITY_ANCHOR = 'const chat = await taskStateReader.forSession(sessionId)\n    if (chat === undefined) return null\n    return sessionStateView.status(chat)'

/** sessionStateView 真实构造块（1996–2000，唯一）：`activity:` 行在全文有 4 处，**只能**在该块内替换。 */
export const SESSION_STATE_BLOCK = 'const sessionStateView = createSessionStateView({\n' +
  '    sharedReceipts: true, sharedMappings: true,\n' +
  '    activity: chat => backgroundTasks.activity(chat),\n' +
  '    evidence: sessionId => sessionDebugEvidence(sessionId, true)\n' +
  '  })'

/** `setStatusBarPlacement` 真实 case 整块（4158–4164，唯一）：换成窄写 + 同一 hook 链。 */
export const STATUS_BAR_CASE = "      case 'setStatusBarPlacement': {\n" +
  "        if (!['sidebar', 'body'].includes(args?.placement)) throw new Error('无效的状态栏位置')\n" +
  "        const chat = await chatForSession(args.sessionId)\n" +
  "        if (!chat || !['story', 'script'].includes(chat.mode || 'story')) throw new Error('请先打开游玩会话')\n" +
  "        await updateChat(chat.id, current => ({ ...current, statusBarPlacement: args.placement }), { source: 'ui.status-bar-placement' })\n" +
  "        return { statusBarPlacement: args.placement }\n" +
  "      }"

/**
 * S4-1 storyContext 真实整块（作者 index.js:2874–2879，唯一）。
 * 逐字取自固定作者树 68215e47…；`boundedHistory` 两分支各自保留原文（未命中时**原样**回落）。
 */
export const STORY_CONTEXT_BLOCK = "async function storyContext({ sessionId, chatId }) {\n" +
  "    const need = { storyRows: async header => (await worldBookScanDepth(header)) + 1, lastAssistant: true, lastVariables: true }\n" +
  "    const selected = chatId === undefined ? await boundedHistory.forSession(sessionId, need) : await boundedHistory.read(chatId, undefined, need)\n" +
  "    if (selected && ['story', 'script'].includes(selected.chat.mode || 'story') && selected.chat.requestMode !== 'sillytavern') return normalizeChat(selected.chat)\n" +
  "    return chatId === undefined ? chatForSession(sessionId) : readChat(chatId)\n" +
  "  }"

/**
 * S4-2 hookChatForSession 真实整块（作者 index.js:2858–2873，唯一）。
 * mvuReplies 谓词 / attempt<2 两次重试 / 首钩 synced===undefined 整档基线 / surfaceSyncedRevisions 记忆点**逐字保留**。
 */
export const HOOK_CHAT_BLOCK = "async function hookChatForSession(sessionId) {\n" +
  "    const chatId = (await readSessionMap())[str(sessionId)]\n" +
  "    const synced = chatId ? surfaceSyncedRevisions.get(str(sessionId)) : undefined\n" +
  "    const mvuReplies = rows => rows.filter(row => row?.role === 'assistant' && row.variables?.[Math.max(0, Number(row.swipeId) || 0)]?.stat_data !== undefined).length >= 2\n" +
  "    let selected\n" +
  "    // A write between the change record and the window read retries once.\n" +
  "    for (let attempt = 0; synced !== undefined && !selected && attempt < 2; attempt++) {\n" +
  "      const changed = await chatPersistence.readChangedIndices(chatId, synced)\n" +
  "      if (!changed?.indices) break\n" +
  "      selected = await boundedHistory.read(chatId, str(sessionId), { lastAssistant: true, lastVariables: true, enough: mvuReplies, include: changed.indices, revision: changed.revision })\n" +
  "    }\n" +
  "    const chat = selected && ['story', 'script'].includes(selected.chat.mode || 'story') && selected.chat.requestMode !== 'sillytavern'\n" +
  "      ? normalizeChat(selected.chat) : await chatForSession(sessionId)\n" +
  "    if (chat?._storageRevision !== undefined) surfaceSyncedRevisions.set(str(sessionId), chat._storageRevision)\n" +
  "    return chat\n" +
  "  }"

/** S4-3 宿主调用**唯一**标记（恰 1 次）：readStoryInput 必须走同一 store 实例。 */
export const STORE_STORY_INPUT_MARKER = 'chatJournalStore.readStoryInput('

/** S4 三链（候选/结算/模板）生成块定位标记；不进 markerCount 幂等键，仅审计与测试切片用。 */
export const CHAIN_MARKER = Object.freeze({
  candidate: '// [dsh-tavern-native-data-transform:s4-candidate]',
  settlement: '// [dsh-tavern-native-data-transform:s4-settlement]',
  template: '// [dsh-tavern-native-data-transform:s4-template]'
})

/**
 * S4-candidate 唯一整块（作者 index.js:2677）：`createCandidateContextReader(` 全文仅此一处构造（另一处是 import）。
 * 只换 `readWindow` 实参 ⇒ 作者 reader 的 headerForSession(['id']) 解析、readChat 兜底、适用性门槛与
 * "≥6 条有效助手正文/变量范围"的分页条件全部原样保留；注入的 `readChat` 不动。
 */
export const CANDIDATE_READER_LINE = '  const candidateContextReader = createCandidateContextReader({headerForSession:chatHeaderForSession,readWindow:chatPersistence.readWindow,readChat})'

/**
 * S4-settlement 唯一整块（作者 index.js:2930）：`readSettlementInput(` 全文仅此一处调用。
 * 结算刀的核心是 timeline 窄化（作者 readSettlementInput 的 readWindow 默认形状仍全组装 timeline）⇒
 * 整个调用交插件原生出口；出口 fallback 时宿主**显式**回作者 readChat（原文语义，不 catch-all）。
 */
export const SETTLEMENT_INPUT_LINE = '      let snapshot = await readSettlementInput(chatId, {readWindow:chatPersistence.readWindow,readChat,scanDepth:worldBookScanDepth})'

/**
 * S4-template 唯一整块（作者 index.js:1647）：`createTemplateWindowReader(` 全文仅此一处构造。
 * **层级＝reader 级**（2026-10-08 主复核返工）：作者 `readWindow` 传输层本就是原生，换实参省不掉任何东西；
 * 插件出口 `chatJournalStore.readTemplateWindowReader({links,access,historyFrom})` **返回与作者 reader 同形的
 * `async sessionId => {chat,historyWindow}|undefined`**，宿主只把三件闭包输入（links 解析、access 票据签发、
 * historyFrom 游标）原样交出去，不再自行组装窗口。缺出口在**装配期**（该对象字面量求值时）响亮抛错。
 */
export const TEMPLATE_READER_LINE = '    resolveTemplateWindow: createTemplateWindowReader({ links: readSessionMap, readWindow: chatPersistence.readWindow, access: { issue: input => helperHistoryAccess.issue(input) }, historyFrom: sessionId => templateHistoryFrom.get(sessionId) }),'

export const ANCHORS = Object.freeze({
  import: "import { createCandidateContextReader } from './domain/candidate-context-reader.js'",
  sessionStateView: SESSION_STATE_BLOCK,
  sessionActivity: SESSION_ACTIVITY_ANCHOR,
  statusBarCase: STATUS_BAR_CASE,
  factoryBefore: 'async function projectOpeningWindow(window, options = {}) {',
  readWindowLine: 'const window = await readRecentWindow(chatPersistence.readWindow,chatId,{limit:HELPER_MESSAGE_COLD_WINDOW,from:historyFrom,requirePartial:true})',
  storyContext: STORY_CONTEXT_BLOCK,
  hookChat: HOOK_CHAT_BLOCK,
  candidateReader: CANDIDATE_READER_LINE,
  settlementInput: SETTLEMENT_INPUT_LINE,
  templateReader: TEMPLATE_READER_LINE
})

export const REQUIRED_BLOCKS = Object.freeze({
  import: 'import { createSessionWindowProjector, createActivitySummaryBridge } from',
  bridge: 'const activityBridge = createActivitySummaryBridge()',
  activityOf: 'const activityOf = activityBridge.wrap(chat => backgroundTasks.activity(chat))',
  factory: 'const sessionWindowProjector = createSessionWindowProjector({\n    get str() { return str },',
  stateViewCallback: 'activity: activityOf,\n    evidence: sessionId => sessionDebugEvidence(sessionId, true)',
  fastPath: 'if (window && window.nativeData === true) {',
  fastPathRetry: 'let openingFastWindow = window',
  storeFirst: 'chatJournalStore.readOpeningWindow(chatId,',
  consumerGuard: 'chatJournalStore.readActivitySummary({ chatId: openingFastWindow.chat.id',
  sessionActivity: 'const nativeSummary = chatJournalStore.readActivitySummary({ chatId, sessionId: str(sessionId) })',
  statusBarCase: 'chatJournalStore.setStatusBarPlacement(chat.id, { sessionId: chat.sessionId, placement: args.placement })',
  storyContext: '      const scanDepth = await worldBookScanDepth({ cardPath: header?.cardPath, sessionId })',
  storyInputCall: 'const selected = await readStoryInput(resolvedChatId, { sessionId, storyRows: scanDepth + 1, lastAssistant: true, lastVariables: true })',
  storyGuard: "      if (!readStoryInput) throw new Error('宿主接线缺失：chatJournalStore.readStoryInput 未装配，拒绝静默走完整档')",
  storyFallback: '    return chatId === undefined ? chatForSession(sessionId) : readChat(chatId)',
  hookChat: '    for (let attempt = 0; synced !== undefined && Number.isSafeInteger(scanDepth) && !selected && attempt < 2; attempt++) {',
  hookDepth: "const scanDepth = synced !== undefined ? await worldBookScanDepth({ cardPath: headerForDepth?.cardPath, sessionId }) : undefined",
  hookInputCall: STORE_STORY_INPUT_MARKER,
  hookLegacyFallback: "      ? normalizeChat(selected.chat) : await chatForSession(sessionId)",
  candidateWiring: 'chatJournalStore.readCandidateInput(id, { sessionId: options.sessionId })',
  candidateFallback: 'if (nativeCandidate === undefined) return undefined',
  candidateGuard: "if (typeof chatJournalStore.readCandidateInput !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readCandidateInput 未装配，拒绝静默走完整档')",
  settlementWiring: 'chatJournalStore.readSettlementInput(chatId, { scanDepth: worldBookScanDepth })',
  settlementValue: "if (nativeSettlement.kind === 'value') return nativeSettlement.chat",
  settlementFallback: "if (nativeSettlement.kind === 'fallback') return readChat(chatId)",
  settlementGuard: "if (typeof chatJournalStore.readSettlementInput !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readSettlementInput 未装配，拒绝静默走完整档')",
  templateReaderWiring: 'chatJournalStore.readTemplateWindowReader({ links: readSessionMap, access: { issue: input => helperHistoryAccess.issue(input) }, historyFrom: sessionId => templateHistoryFrom.get(sessionId) })',
  templateReaderGuard: "      if (typeof chatJournalStore.readTemplateWindowReader !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readTemplateWindowReader 未装配，拒绝静默走完整档')",
  ctxEffect: '.clear()'
})

export const CORE_INJECTION_POINTS = Object.freeze({
  importAnchor: ANCHORS.import,
  bridgeBefore: 'const sessionStateView = createSessionStateView({（1996 行前；sessionStateView 引用 activityOf，必须先初始化）',
  stateViewCallback: 'activity: chat => backgroundTasks.activity(chat),（1998 行整行替换，不新增重复键）',
  factoryBefore: ANCHORS.factoryBefore,
  openingFastPath: 'projectOpeningWindow 首部：window.nativeData → project → value 时 finishOpeningWindow().view',
  readOpeningWindow: 'readOpeningWindow：优先 chatJournalStore.readOpeningWindow(chatId,{limit,from,requirePartial,sessionId})；not-applicable 回旧 readRecentWindow',
  storeMethods: Object.freeze(['readOpeningWindow(chatId,{limit,from,requirePartial,sessionId})', 'readActivitySummary({chatId,sessionId,revision?})', 'readStoryInput(chatId,{sessionId,storyRows,lastAssistant,lastVariables,enough?,include?,revision?})'])
})

export const PENDING_HOST_WIRING = Object.freeze([
  'getSessionActivity：readSessionMap→store.readActivitySummary→wrapSessionActivity(status, summary, chat)，legacy 回原 taskStateReader（需 4145–4160 真实函数体）'
])

/** 启动时只建空对象；const/let 依赖在首次 project 时取值，避开 projectOpeningWindow 之前的 TDZ。 */
export const DEFAULT_DEPS_EXPRESSION = `{
    get str() { return str },
    get readTavernSettings() { return readTavernSettings },
    get readScript() { return readScript },
    get scriptContinuity() { return scriptContinuity },
    get groupOfMode() { return groupOfMode },
    get replyProjectionsOf() { return replyProjectionsOf },
    get incrementalReplyView() { return incrementalReplyView },
    get composeTavernRegexScripts() { return composeTavernRegexScripts },
    get liveCardUpdate() { return liveCardUpdate },
    get withLegacyPresentationProjection() { return withLegacyPresentationProjection },
    get readCardExtensions() { return readCardExtensions },
    get tavernRemoteAssets() { return tavernRemoteAssets },
    get activityOf() { return activityOf },
    get activityBridge() { return activityBridge },
    liveSessionFor: id => sessionStore.get(str(id)) || agentRegistry.get(str(id))?.session,
    get assistantResultForTurn() { return assistantResultForTurn },
    get forkTurnsForChat() { return forkTurnsForChat },
    get inputFieldsProjection() { return inputFieldsProjection },
    get cardUpdateStatus() { return cardUpdateStatus },
    get hasTavernScriptRuntime() { return hasTavernScriptRuntime },
    get projectTavernHelperScripts() { return projectTavernHelperScripts },
    get worldBooks() { return worldBooks },
    get projectTavernHelperWorldbook() { return projectTavernHelperWorldbook },
    get worldBookDisplayName() { return worldBookDisplayName },
    get sessionResources() { return sessionResources },
    get projectTavernHelperContext() { return projectTavernHelperContext },
    get sessionDebugEvidence() { return sessionDebugEvidence },
    get rollbackViewFields() { return rollbackViewFields },
    get cardViewOf() { return cardViewOf },
    get readChatCard() { return readChatCard },
    get readLedger() { return readLedger },
    get manualLedger() { return manualLedger },
    get projectCharacterDesignDocument() { return projectCharacterDesignDocument },
    get manualCharacterDesign() { return manualCharacterDesign },
    get phoneChat() { return phoneChat },
    get mvuReceiptsOf() { return mvuReceiptsOf },
    get OFFICIAL_MVU_VERSION() { return OFFICIAL_MVU_VERSION },
    get sessionOpeningDescriptor() { return sessionOpeningDescriptor },
    get readPromptTemplateGlobalVariables() { return readPromptTemplateGlobalVariables },
    get tavernExtensionSettings() { return tavernExtensionSettings },
    get TAVERN_COMPATIBILITY_CAPABILITIES() { return TAVERN_COMPATIBILITY_CAPABILITIES },
    get TAVERN_RELEASE_CAPABILITIES() { return TAVERN_RELEASE_CAPABILITIES },
    get rescueHistoryNotice() { return rescueHistoryNotice },
    get settlementTurn() { return settlementTurn },
    get helperHistoryAccess() { return helperHistoryAccess },
    get candidateWorldbookPreparation() { return candidateWorldbookPreparation },
    get scheduleTemplateSync() { return scheduleTemplateSync },
    get helperMessageColdWindow() { return HELPER_MESSAGE_COLD_WINDOW }
  }`

const countOf = (source, needle) => source.split(needle).length - 1
const markerCount = source => countOf(source, NATIVE_DATA_MARKER)

function assertUnique(source, name) {
  const count = countOf(source, ANCHORS[name])
  if (count !== 1) throw new Error(`native-data 锚点不唯一（${name}=${count}）: ` + ANCHORS[name].slice(0, 60))
}

function assertBlocks(source) {
  const missing = Object.entries(REQUIRED_BLOCKS).filter(([, text]) => !source.includes(text)).map(([key]) => key)
  if (missing.length > 0) throw new Error('native-data 生成物缺块: ' + missing.join(', '))
}

/**
 * @param {string} source 作者 index.js 原文
 * @param {{projectorImportPath:string, depsExpression?:string, factoryName?:string}} options
 */
export function applyNativeDataTransform(source, options = {}) {
  if (typeof source !== 'string' || source === '') throw new Error('native-data 转换缺少源码')
  const markers = markerCount(source)
  if (markers === 1) { assertBlocks(source); return source } // 已应用：逐块验证通过才算幂等
  if (markers !== 0) throw new Error('native-data 转换标记数异常（半应用）: ' + markers)
  const importPath = options.projectorImportPath
  if (typeof importPath !== 'string' || importPath === '') throw new Error('native-data 转换缺少 projectorImportPath')
  const depsExpression = options.depsExpression ?? DEFAULT_DEPS_EXPRESSION
  if (typeof depsExpression !== 'string' || depsExpression.trim() === '') throw new Error('native-data 转换缺少 depsExpression')
  const factoryName = options.factoryName ?? 'sessionWindowProjector'
  for (const [name, value] of Object.entries(ANCHORS)) {
    if (typeof value !== 'string' || value === '') throw new Error('native-data 锚点未定义（' + name + '）')
    assertUnique(source, name)
  }

  // ① import
  let next = source.replace(ANCHORS.import,
    `${NATIVE_DATA_MARKER}\nimport { createSessionWindowProjector, createActivitySummaryBridge } from '${importPath}'\n${ANCHORS.import}`)

  // ② 桥必须在 sessionStateView 之前；③ **在 sessionStateView 唯一块内**替换 activity 行（全文该行有 4 处，不能全球替换）
  next = next.replace(SESSION_STATE_BLOCK,
    `const activityBridge = createActivitySummaryBridge()\n  const activityOf = activityBridge.wrap(chat => backgroundTasks.activity(chat))\n  ` +
    SESSION_STATE_BLOCK.replace('activity: chat => backgroundTasks.activity(chat),', 'activity: activityOf,'))

  // ④ 投影工厂
  next = next.replace(ANCHORS.factoryBefore, `  const ${factoryName} = createSessionWindowProjector(${depsExpression})\n\n  ${ANCHORS.factoryBefore}`)

  // ⑤ opening 快路径（仅 nativeData；not-applicable 落回原体，不 catch）。
  //    竞态策略（issue #6）：guard 失败＝异步组装期间被写入追上（head 已前进），按竞态处理而非错误——
  //    立即重投影一次（单次写入竞态零等待即成），再以 100–200ms 抖动退避重投影两次；用尽仍被追上才响亮报错。
  //    guard 改为读**最新**摘要＋比较 revision（身份校验仍在 store 内；异常只留给身份/形状异常）。
  next = next.replace(ANCHORS.factoryBefore, `${ANCHORS.factoryBefore}\n` +
    `    if (window && window.nativeData === true) {\n` +
    `      let openingFastWindow = window\n` +
    `      for (let openingFastAttempt = 0; ; openingFastAttempt++) {\n` +
    `        if (openingFastAttempt > 0) {\n` +
    `          if (openingFastAttempt > 1) await new Promise(resolve => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)))\n` +
    `          const openingFastFresh = chatJournalStore.readOpeningWindow(openingFastWindow.chat.id, { limit: HELPER_MESSAGE_COLD_WINDOW, from: Number.isSafeInteger(openingFastWindow.from) && openingFastWindow.from > 0 ? openingFastWindow.from : undefined, requirePartial: true, sessionId: openingFastWindow.chat.sessionId })\n` +
    `          if (openingFastFresh === null) return null\n` +
    `          if (!openingFastFresh || openingFastFresh.nativeData !== true) throw new Error('opening 快路径重读后窗口非原生，拒绝猜测: ' + String(openingFastFresh && openingFastFresh.kind))\n` +
    `          openingFastWindow = openingFastFresh\n` +
    `        }\n` +
    `        const openingFastProjected = await ${factoryName}.project({ chat: openingFastWindow.chat, window: openingFastWindow, activity: openingFastWindow.activity, card: openingFastWindow.card, options: { openingWindow: true, deferResources: options.deferResources }, resourceKey: openingFastWindow.resourceKey ?? ('window:' + openingFastWindow.revision + ':' + openingFastWindow.chat.sessionId + ':' + (openingFastWindow.chat.timeline && openingFastWindow.chat.timeline.branchId || '') + ':' + (openingFastWindow.chat.tavernHelperLifecycleRevision ?? '')) })\n` +
    `        if (openingFastProjected.kind !== 'value') break\n` +
    `        const openingFastGuard = chatJournalStore.readActivitySummary({ chatId: openingFastWindow.chat.id, sessionId: openingFastWindow.chat.sessionId })\n` +
    `        if (openingFastGuard && openingFastGuard.kind === 'value' && openingFastGuard.revision === openingFastWindow.revision) {\n` +
    `          return ${factoryName}.finishOpeningWindow(openingFastProjected, openingFastWindow, openingFastWindow.chat).view\n` +
    `        }\n` +
    `        if (openingFastAttempt >= 3) throw new Error('opening 快路径连续过期：' + (openingFastAttempt + 1) + ' 次投影均被写入追上，拒绝返回旧窗口: ' + openingFastWindow.chat.id + '@' + openingFastWindow.revision + '→' + String(openingFastGuard && openingFastGuard.revision))\n` +
    `      }\n` +
    `    }`)

  // ⑥ readOpeningWindow 存储优先：**from 语义保真**——undefined 保持「最新窗」，不得归一成 0（否则全覆盖/永远 fallback）；
  //    null ⇒ 直接 return null（不反查）；仅 not-applicable 才回旧 readRecentWindow(from: historyFrom) 保持原扩页语义；
  //    undefined/其它非法 ⇒ 显式错误。作者原有 window.from===0 guard 照留。
  const storeFirst = `const normalizedFrom = Number.isSafeInteger(historyFrom) && historyFrom >= 0 ? historyFrom : undefined\n` +
    `    const nativeOpeningWindow = chatJournalStore.readOpeningWindow(chatId, { limit: HELPER_MESSAGE_COLD_WINDOW, from: normalizedFrom, requirePartial: true, sessionId })\n` +
    `    if (nativeOpeningWindow === null) return null\n` +
    `    if (!nativeOpeningWindow || (nativeOpeningWindow.nativeData !== true && nativeOpeningWindow.kind !== 'not-applicable')) throw new Error('opening 原生窗口形状非法，拒绝猜测: ' + String(nativeOpeningWindow && nativeOpeningWindow.kind))\n` +
    `    const window = nativeOpeningWindow.nativeData === true\n` +
    `      ? nativeOpeningWindow\n` +
    `      : await readRecentWindow(chatPersistence.readWindow,chatId,{limit:HELPER_MESSAGE_COLD_WINDOW,from:historyFrom,requirePartial:true})`
  next = next.replace(ANCHORS.readWindowLine, storeFirst)

  // ⑦ sessionActivity：**纯 S1 status 链**——先按 readSessionMap 定位，再取同 store 摘要（kind==='value' 直接成 status，不读完整 operations）；
  //    null ⇒ null；仅 not-applicable 才回原 taskStateReader + sessionStateView.status。类型不 coerce，包装按原 status 定义。
  next = next.replace(SESSION_ACTIVITY_ANCHOR,
    `const chatId = (await readSessionMap())[str(sessionId)]\n` +
    `    if (!chatId) return null\n` +
    `    const nativeSummary = chatJournalStore.readActivitySummary({ chatId, sessionId: str(sessionId) })\n` +
    `    if (nativeSummary && nativeSummary.kind === 'value') {\n` +
    `      const summaryActivity = nativeSummary.activity || {}\n` +
    `      return { chatId: nativeSummary.identity.chatId, phase: summaryActivity.phase, busy: summaryActivity.busy, role: summaryActivity.role,\n` +
    `        operationId: summaryActivity.operationId, basedOn: summaryActivity.basedOn, updatedAt: summaryActivity.updatedAt || nativeSummary.chatUpdatedAt || 0 }\n` +
    `    }\n` +
    `    if (nativeSummary === null) return null\n` +
    `    if (!nativeSummary || nativeSummary.kind !== 'not-applicable') throw new Error('活动摘要返回未知形状，拒绝猜测: ' + String(nativeSummary && nativeSummary.kind))\n` +
    `    const chat = await taskStateReader.forSession(sessionId)\n` +
    `    if (chat === undefined) return null\n` +
    `    return sessionStateView.status(chat)`)

  // ⑧ 无句柄关闭副作用：工厂清理绑定 ctx 生命周期（typeof 守卫，ctx 不在作用域也不抛）
  next = next.replace(ANCHORS.factoryBefore, `  if (typeof ctx !== 'undefined' && ctx && typeof ctx.effect === 'function') ctx.effect(() => () => ${factoryName}.clear())\n\n  ${ANCHORS.factoryBefore}`)

  // ⑧ setStatusBarPlacement：窄写 + 同一 hook 链（**无** patchChat 的 candidate.mailbox 条件；hooks 恒触发）
  next = next.replace(STATUS_BAR_CASE,
    "      case 'setStatusBarPlacement': {\n" +
    "        if (!['sidebar', 'body'].includes(args?.placement)) throw new Error('无效的状态栏位置')\n" +
    "        const chat = await chatForSession(args.sessionId)\n" +
    "        if (!chat || !['story', 'script'].includes(chat.mode || 'story')) throw new Error('请先打开游玩会话')\n" +
    "        const result = await chatJournalStore.setStatusBarPlacement(chat.id, { sessionId: chat.sessionId, placement: args.placement })\n" +
    "        const saved = { ...chat, statusBarPlacement: result.statusBarPlacement, _storageRevision: result.revision, updatedAt: result.updatedAt }\n" +
    "        candidateWorldbookPreparation?.changed(saved, { source: 'ui.status-bar-placement' })\n" +
    "        await syncChatSummary(saved)\n" +
    "        void coordinationEvents?.publish(saved.sessionId)\n" +
    "        scheduleTemplateSync(saved, { source: 'ui.status-bar-placement' })\n" +
    "        queueAutoCompaction(saved.sessionId)\n" +
    "        return { statusBarPlacement: args.placement }\n" +
    "      }")

  // ⑨ S4-1 storyContext：范围选择移入 store（readStoryInput），**世界书深度仍在事务外先算好数值**；
  //    命中形状与作者 bounded-history 相同（{chat,messageCount,from,revision}），未命中（undefined）⇒
  //    原样回落 chatForSession/readChat。作者适用性谓词（mode/requestMode）逐字保留。
  next = next.replace(STORY_CONTEXT_BLOCK,
    `${STORY_INPUT_MARKER}\n` +
    `  async function storyContext({ sessionId, chatId }) {\n` +
    `    // Needs the scan depth of the floor whose world book this request reads, plus the\n` +
    `    // current input or latest body, the latest reply and the latest variable floor.\n` +
    `    const resolvedChatId = chatId === undefined ? (await readSessionMap())[str(sessionId)] : chatId\n` +
    `    if (resolvedChatId !== undefined) {\n` +
    `      // The store exit is only called when it exists: a missing method must fail loudly,\n` +
    `      // never silently degrade a bounded request into the complete read.\n` +
    `      const readStoryInput = typeof chatJournalStore.readStoryInput === 'function' ? chatJournalStore.readStoryInput.bind(chatJournalStore) : null\n` +
    `      if (!readStoryInput) throw new Error('宿主接线缺失：chatJournalStore.readStoryInput 未装配，拒绝静默走完整档')\n` +
    `      const header = await chatPersistence.read(resolvedChatId)\n` +
    `      const scanDepth = await worldBookScanDepth({ cardPath: header?.cardPath, sessionId })\n` +
    `      if (Number.isSafeInteger(scanDepth)) {\n` +
    `        const selected = await readStoryInput(resolvedChatId, { sessionId, storyRows: scanDepth + 1, lastAssistant: true, lastVariables: true })\n` +
    `        if (selected) {\n` +
    `          if (typeof selected !== 'object' || typeof selected.chat !== 'object') throw new Error('story 输入返回未知形状，拒绝猜测')\n` +
    `          if (['story', 'script'].includes(selected.chat.mode || 'story') && selected.chat.requestMode !== 'sillytavern') return normalizeChat(selected.chat)\n` +
    `        }\n` +
    `      }\n` +
    `    }\n` +
    `    // Explicit compatibility fallback (author line below, verbatim): no native session\n` +
    `    // link, unreadable world book (depth Infinity), store not applicable (undefined),\n` +
    `    // or a non-story/non-script request. A hit returns above; everything else lands here.\n` +
    `    return chatId === undefined ? chatForSession(sessionId) : readChat(chatId)\n` +
    `  }`)

  // ⑨ S4-2 hookChatForSession：首钩 synced===undefined 的**整档基线保持原样**（不接 store）；
  //    已同步会话的两次重试改走 readStoryInput；mvuReplies 谓词与 readChangedIndices 增量逐字保留。
  next = next.replace(HOOK_CHAT_BLOCK,
    `async function hookChatForSession(sessionId) {\n` +
    `    const chatId = (await readSessionMap())[str(sessionId)]\n` +
    `    const synced = chatId ? surfaceSyncedRevisions.get(str(sessionId)) : undefined\n` +
    `    const mvuReplies = rows => rows.filter(row => row?.role === 'assistant' && row.variables?.[Math.max(0, Number(row.swipeId) || 0)]?.stat_data !== undefined).length >= 2\n` +
    `    let selected\n` +
    `    // The scan depth of this attempt's revision is resolved outside the store read (once,\n` +
    `    // before the retry loop) and passed in as a number; Infinity keeps the complete read.\n` +
    `    const headerForDepth = synced !== undefined ? await chatPersistence.read(chatId) : undefined\n` +
    `    const scanDepth = synced !== undefined ? await worldBookScanDepth({ cardPath: headerForDepth?.cardPath, sessionId }) : undefined\n` +
    `    // A write between the change record and the window read retries once.\n` +
    `    for (let attempt = 0; synced !== undefined && Number.isSafeInteger(scanDepth) && !selected && attempt < 2; attempt++) {\n` +
    `      const changed = await chatPersistence.readChangedIndices(chatId, synced)\n` +
    `      if (!changed?.indices) break\n` +
    `      if (typeof chatJournalStore.readStoryInput !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readStoryInput 未装配，拒绝静默走完整档')\n` +
    `      selected = await chatJournalStore.readStoryInput(chatId, {\n` +
    `        sessionId: str(sessionId), storyRows: scanDepth + 1, lastAssistant: true, lastVariables: true,\n` +
    `        enough: mvuReplies, include: changed.indices, revision: changed.revision\n` +
    `      })\n` +
    `    }\n` +
    `    const chat = selected && ['story', 'script'].includes(selected.chat.mode || 'story') && selected.chat.requestMode !== 'sillytavern'\n` +
    `      ? normalizeChat(selected.chat) : await chatForSession(sessionId)\n` +
    `    if (chat?._storageRevision !== undefined) surfaceSyncedRevisions.set(str(sessionId), chat._storageRevision)\n` +
    `    return chat\n` +
    `  }`)

  // ⑩ S4-3 候选上下文（作者 :2677）：只换 createCandidateContextReader 的 readWindow 实参 ⇒ 窗口读走插件原生出口；
  //    出口 undefined（原生不适用）时**返回 undefined**，作者 reader 自己 `if (!window) return readChat(id)` 原样兜底；
  //    注入的 readChat / headerForSession(['id']) 解析 / 适用性门槛 / 分页条件都不动。出口缺失或形状非法 ⇒ 响亮抛错。
  next = next.replace(CANDIDATE_READER_LINE,
    `  ${CHAIN_MARKER.candidate}\n` +
    `  const candidateContextReader = createCandidateContextReader({headerForSession:chatHeaderForSession,readWindow: async (id, options = {}) => {\n` +
    `    if (typeof chatJournalStore.readCandidateInput !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readCandidateInput 未装配，拒绝静默走完整档')\n` +
    `    const nativeCandidate = await chatJournalStore.readCandidateInput(id, { sessionId: options.sessionId })\n` +
    `    // Native not applicable keeps the author's own compatibility path: read() calls readChat(id).\n` +
    `    if (nativeCandidate === undefined) return undefined\n` +
    `    if (!nativeCandidate || typeof nativeCandidate !== 'object' || !Array.isArray(nativeCandidate.messages)) throw new Error('候选输入返回未知形状，拒绝猜测: ' + String(nativeCandidate))\n` +
    `    return { chat: nativeCandidate, from: 0, revision: Number.isSafeInteger(nativeCandidate._storageRevision) ? nativeCandidate._storageRevision : 0, messageCount: nativeCandidate.messages.length }\n` +
    `  },readChat})`)

  // ⑩ S4-4 结算输入（作者 :2930）：整调用交插件原生出口（结算刀＝timeline 窄化，作者 readWindow 默认形状仍全组装 timeline）；
  //    kind==='fallback' 时宿主**显式**回作者 readChat(chatId)（完整档兼容路径原文语义）；未知 kind／非对象／出口缺失 ⇒ 抛错。
  next = next.replace(SETTLEMENT_INPUT_LINE,
    `      ${CHAIN_MARKER.settlement}\n` +
    `      let snapshot = await (async () => {\n` +
    `        if (typeof chatJournalStore.readSettlementInput !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readSettlementInput 未装配，拒绝静默走完整档')\n` +
    `        const nativeSettlement = await chatJournalStore.readSettlementInput(chatId, { scanDepth: worldBookScanDepth })\n` +
    `        if (!nativeSettlement || typeof nativeSettlement !== 'object') throw new Error('结算输入返回未知形状，拒绝猜测: ' + String(nativeSettlement))\n` +
    `        if (nativeSettlement.kind === 'value') return nativeSettlement.chat\n` +
    `        // The author's complete read stays the explicit compatibility path.\n` +
    `        if (nativeSettlement.kind === 'fallback') return readChat(chatId)\n` +
    `        throw new Error('结算输入 kind 未知，拒绝猜测: ' + String(nativeSettlement.kind))\n` +
    `      })()`)

  // ⑩ S4-5 模板窗口（作者 :1647）：**reader 级**委托——整行换成插件出口的 reader 工厂，宿主只交出三件闭包输入
  //    （links 解析 / access 票据签发 / historyFrom 游标）；出口在**装配期**缺失即响亮抛错（不留静默整档的 reader）。
  next = next.replace(TEMPLATE_READER_LINE,
    `    ${CHAIN_MARKER.template}\n` +
    `    resolveTemplateWindow: (() => {\n` +
    `      if (typeof chatJournalStore.readTemplateWindowReader !== 'function') throw new Error('宿主接线缺失：chatJournalStore.readTemplateWindowReader 未装配，拒绝静默走完整档')\n` +
    `      return chatJournalStore.readTemplateWindowReader({ links: readSessionMap, access: { issue: input => helperHistoryAccess.issue(input) }, historyFrom: sessionId => templateHistoryFrom.get(sessionId) })\n` +
    `    })(),`)

  // S4 唯一性：hook 支路对同一 store 出口的调用**恰 1 处**（storyContext 走绑定后的局部 readStoryInput，
  // 见 REQUIRED_BLOCKS.storyInputCall；两处调用都不经第二份实现、不复制作者算法）。
  const hookStoryInputCalls = countOf(next, STORE_STORY_INPUT_MARKER)
  if (hookStoryInputCalls !== 1) throw new Error('native-data S4 hook store 出口调用数异常（应为 1，实为 ' + hookStoryInputCalls + '）')
  // 三链标记各恰 1 处（切片/审计用；第 7 行注释里的 STORE_STORY_INPUT_MARKER 不计入）
  for (const [name, marker] of Object.entries(CHAIN_MARKER)) {
    const count = countOf(next, marker)
    if (count !== 1) throw new Error('native-data S4 三链标记数异常（' + name + '=' + count + '）')
  }

  if (markerCount(next) !== 1) throw new Error('native-data 转换结果标记数异常: ' + markerCount(next))
  assertBlocks(next)
  return next
}

export function isNativeDataApplied(source) {
  if (typeof source !== 'string' || markerCount(source) !== 1) return false
  assertBlocks(source)
  return true
}

// ══════════════════════════════════════════════════════════════════════════════════
// S5 单楼写入接缝（**按文件**，与 index.js 的 native-data 转换相互独立）
//
// 已核事实（作者固定树 68215e47，只读）：
//  · 追加一楼窄写口＝turn-orchestration.js:597 `if (await store.patchChat(before.id, revision, changes, metadata)) return result`
//    （changes＝头字段 sets ＋ 一条完整尾 splice；`op:'splice', path:['messages'], index:count, deleteCount:0, items:messages` 全文唯一）
//  · 单楼回写窄写口＝background-task-coordinator.js:256-257 `const saved = await store.patchChat(chatId, before._storageRevision, changes.map(…)…)`
//  · **作用域**：两个 domain 模块都经工厂拿注入的 store（turn-orchestration.js:219/221 `createTurnOrchestrator(options)`→`const store = options.store`；
//    background-task-coordinator.js:24/25 同形），文件内**没有** `chatJournalStore` 绑定 ⇒ 接缝只能调注入的 `store.<method>`
//    （宿主需在 index.js:3400-3414 / :2478-2479 的两个 adapter 字面量里补方法，插件出口本体另接）。
//  · falsy 语义（必须保留）：A 处 falsy ⇒ 原样续跑 `for (let attempt = 0; attempt < 3; attempt++)`（:566），
//    耗尽返回 null ⇒ finalize 落 updateChat 整档；B 处 falsy ⇒ 不 return ⇒ 原体 `store.updateChat(chatId, chat => mutate(chat, messageId), metadata)` 兜底。
//  · 出口缺失＝宿主接线缺口，**响亮抛错**（不静默走整档 patch）。
// ══════════════════════════════════════════════════════════════════════════════════

/** 两个单楼写入文件的幂等标记（同前缀，后缀按目标区分；同文件恰一处）。 */
export const MESSAGE_MARKER = Object.freeze({
  appendMessages: '// [dsh-tavern-native-message-transform:append]',
  setMessageFloor: '// [dsh-tavern-native-message-transform:set-floor]'
})

/** A：追加一楼调用行（唯一）。 */
export const APPEND_MESSAGES_CALL = '      if (await store.patchChat(before.id, revision, changes, metadata)) return result'

/** B：单楼回写调用行整块（唯一，两行）。 */
export const SET_MESSAGE_FLOOR_CALL = '                const saved = await store.patchChat(chatId, before._storageRevision,\n' +
  "                  changes.map(c => ({ ...c, path: ['messages', messageId, ...c.path.slice(2)] })), metadata)"

export const MESSAGE_ANCHORS = Object.freeze({
  appendMessages: APPEND_MESSAGES_CALL,
  setMessageFloor: SET_MESSAGE_FLOOR_CALL
})

/** 目标文件 → 目标名（宿主装配侧按此表对每个文件各调一次 applyNativeMessageTransform）。 */
export const MESSAGE_FILES = Object.freeze({
  'tavern-plugin/lib/domain/turn-orchestration.js': 'appendMessages',
  'tavern-plugin/lib/domain/background-task-coordinator.js': 'setMessageFloor'
})

export const MESSAGE_REQUIRED_BLOCKS = Object.freeze({
  appendMessages: Object.freeze({
    guard: "if (typeof store.appendMessages !== 'function') throw new Error('宿主接线缺失：store.appendMessages 未装配，拒绝静默走整档 patch')",
    items: "const appended = changes.filter(change => change.op === 'splice' && change.path.length === 1 && change.path[0] === 'messages').flatMap(change => Array.isArray(change.items) ? change.items : [])",
    // 头写集＝**普通对象**（store normalizeHeaderSets 只收顶层普通对象，:137-232）；不可表示项一律响亮拒（不 patchChat 兜底）。
    headerSets: [
      'const headerSets = {}',
      "for (const change of changes) {",
      "  if (change.op === 'splice' && Array.isArray(change.path) && change.path.length === 1 && change.path[0] === 'messages') continue",
      "  if (!Array.isArray(change.path) || change.path.length !== 1) throw new Error('追加命令不接受非顶层头改动：' + String(change.path && change.path.join('.')))",
      "  const key = change.path[0]",
      "  if (key === 'messages' || key === 'timeline') throw new Error('追加命令不接受保留头键：' + key)",
      "  if (key === '_storageRevision' || key === 'updatedAt') throw new Error('追加命令不接受命令自管头键：' + key)",
      "  if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('追加命令不接受非法头键：' + key)",
      "  if (Object.prototype.hasOwnProperty.call(headerSets, key)) throw new Error('追加命令不接受重复头键：' + key)",
      "  if (change.op !== 'set' && change.op !== 'delete') throw new Error('追加命令不接受该头改动操作：' + String(change.op))",
      "  headerSets[key] = change.op === 'delete' ? undefined : change.value",
      '}',
    ].join('\n        '),
    wire: 'return await store.appendMessages(before.id, before._storageRevision, { items: appended, headerSets }, metadata)',
    falsyShape: '})()) return result'
  }),
  setMessageFloor: Object.freeze({
    guard: "if (typeof store.setMessageFloor !== 'function') throw new Error('宿主接线缺失：store.setMessageFloor 未装配，拒绝静默走整档回写')",
    wire: "const saved = await store.setMessageFloor(chatId, before._storageRevision, messageId, { changes: changes.map(c => ({ ...c, path: ['messages', messageId, ...c.path.slice(2)] })) }, metadata)"
  })
})

const countIn = (source, needle) => source.split(needle).length - 1

function assertMessageBlocks(source, name) {
  const missing = Object.entries(MESSAGE_REQUIRED_BLOCKS[name]).filter(([, text]) => !source.includes(text)).map(([key]) => key)
  if (missing.length > 0) throw new Error('native-message 生成物缺块（' + name + '）: ' + missing.join(', '))
}

function appendMessagesReplacement() {
  return `      ${MESSAGE_MARKER.appendMessages}\n` +
    `      if (await (async () => {\n` +
    `        ${MESSAGE_REQUIRED_BLOCKS.appendMessages.guard}\n` +
    `        // changes 形态＝头字段 sets ＋ 一条完整尾 splice：两者分开交出，items 保序原样、headerSets 保序原样。\n` +
    `        ${MESSAGE_REQUIRED_BLOCKS.appendMessages.items}\n` +
    `        ${MESSAGE_REQUIRED_BLOCKS.appendMessages.headerSets}\n` +
    `        ${MESSAGE_REQUIRED_BLOCKS.appendMessages.wire}\n` +
    `      ${MESSAGE_REQUIRED_BLOCKS.appendMessages.falsyShape}`
}

function setMessageFloorReplacement() {
  return `                ${MESSAGE_MARKER.setMessageFloor}\n` +
    `                ${MESSAGE_REQUIRED_BLOCKS.setMessageFloor.guard}\n` +
    `                ${MESSAGE_REQUIRED_BLOCKS.setMessageFloor.wire}`
}

/**
 * 单楼写入接缝（按文件）：marker 恰 1 ⇒ 已应用（逐块校验后幂等返回）；0 ⇒ 施缝；其它 ⇒ 半应用拒。
 * @param {string} source 作者该文件原文
 * @param {'appendMessages'|'setMessageFloor'} name 目标（见 MESSAGE_FILES）
 */
export function applyNativeMessageTransform(source, name) {
  if (typeof source !== 'string' || source === '') throw new Error('native-message 转换缺少源码')
  if (!Object.hasOwn(MESSAGE_ANCHORS, name)) throw new Error('native-message 转换未知目标: ' + String(name))
  const marker = MESSAGE_MARKER[name], anchor = MESSAGE_ANCHORS[name]
  const markers = countIn(source, marker)
  if (markers === 1) { assertMessageBlocks(source, name); return source }
  if (markers !== 0) throw new Error('native-message 转换标记数异常（半应用，' + name + '=' + markers + '）')
  const hits = countIn(source, anchor)
  if (hits !== 1) throw new Error('native-message 锚点不唯一（' + name + '=' + hits + '）: ' + anchor.slice(0, 60))
  const next = source.replace(anchor, name === 'appendMessages' ? appendMessagesReplacement() : setMessageFloorReplacement())
  if (countIn(next, marker) !== 1) throw new Error('native-message 转换结果标记数异常（' + name + '=' + countIn(next, marker) + '）')
  if (countIn(next, anchor) !== 0) throw new Error('native-message 锚点在替换后仍存在（' + name + '）')
  assertMessageBlocks(next, name)
  return next
}

export function isNativeMessageApplied(source, name) {
  if (typeof source !== 'string' || !Object.hasOwn(MESSAGE_ANCHORS, name) || countIn(source, MESSAGE_MARKER[name]) !== 1) return false
  assertMessageBlocks(source, name)
  return true
}

// ══════════════════════════════════════════════════════════════════════════════════
// S5 宿主 DI（index.js）：两个 factory 的**窄 store 字面量**补上我方窄出口，使
// `store.appendMessages` / `store.setMessageFloor` 真指向同一个 `chatJournalStore`，并复刻作者
// `patchChat`(:859-870) 的写后契约：candidate.changed → syncChatSummary（candidate.mailbox. 源跳过）
// → coordinationEvents.publish(sessionId) → scheduleTemplateSync → queueAutoCompaction。
//   · **不读整档、不 patch fallback**：通知对象＝窄命令返回的 `result.head`
//     （`chat-command-service.js:152-167`：archive_head_fields 全键 + `_storageRevision`，无 messages）。
//     实测各消费者所需键：candidate.changed＝sessionId/_storageRevision（candidate-worldbook-preparation.js:50-57）；
//     scheduleTemplateSync＝sessionId/_storageRevision/mode/settleStatus（index.js:306-315）；
//     publish/queueAutoCompaction＝sessionId；syncChatSummary→registry.sync 的 chatSummary 取
//     id/cardPath/cardName/title/mode/requestMode/updatedAt/lastOpenedAt/backgroundSessionId 等头字段
//     （tavern-conversation-registry.js:148-159 + chatSummary）⇒ head 足够；head 缺失即响亮拒，不用整档补。
// ══════════════════════════════════════════════════════════════════════════════════
export const MESSAGE_HOST_MARKER = '// [dsh-tavern-native-message-host-di:v1]'
export const MESSAGE_HOST_ANCHORS = Object.freeze({
  patchChat: '  async function patchChat(chatId, revision, changes, metadata) {',
  background: '  const backgroundTasks = createBackgroundTaskCoordinator({\n    store: { ',
  // orchestrator 不能在工厂行后紧接 `store: {` 打锚：body-signal 隐藏转换会在工厂参数区插入
  // `rollbackBodySignals,`，三行锚点被打断（实测 orchestrator=0）。改用 store 内**唯一键行**
  // （`createCard: createWorkspaceCard` 在全部 7 代夹具各恰一处），插入点仍在同一个 store 对象内。
  orchestrator: '      createCard: createWorkspaceCard\n',
})
/** 注入的三个闭包**完整文本**（单一真源：helpers 与 required blocks 均由此派生，避免只验函数头的半应用）。 */
export const MESSAGE_HOST_FUNCTIONS = Object.freeze([
  `  async function notifyNarrowWrite(saved, metadata) {
    if (!saved || typeof saved !== 'object') throw new Error('窄写后通知缺少 head 对象，拒绝用整档读补通知')
    candidateWorldbookPreparation?.changed(saved, metadata)
    if (!str(metadata?.source).startsWith('candidate.mailbox.')) await syncChatSummary(saved)
    void coordinationEvents?.publish(saved.sessionId)
    scheduleTemplateSync(saved, metadata)
    queueAutoCompaction(saved.sessionId)
  }`,
  `  async function appendMessagesNarrow(chatId, revision, payload, metadata) {
    if (deletedChatIds.has(chatId)) throw new Error('对话已删除')
    const result = await chatJournalStore.appendMessages(chatId, revision, payload, metadata)
    if (result === undefined) return undefined                    // CAS 不符：作者 attempt 循环/兜底语义原样
    await notifyNarrowWrite(result.head, metadata)
    return result
  }`,
  `  async function setMessageFloorNarrow(chatId, revision, index, payload, metadata) {
    if (deletedChatIds.has(chatId)) throw new Error('对话已删除')
    const result = await chatJournalStore.setMessageFloor(chatId, revision, index, payload, metadata)
    if (result === undefined) return undefined                    // CAS 不符：作者 updateChat 兜底语义原样
    await notifyNarrowWrite(result.head, metadata)
    return result
  }`,
])
export const MESSAGE_HOST_BLOCKS = Object.freeze({
  notify: MESSAGE_HOST_FUNCTIONS[0],
  append: MESSAGE_HOST_FUNCTIONS[1],
  floor: MESSAGE_HOST_FUNCTIONS[2],
  backgroundLiteral: MESSAGE_HOST_ANCHORS.background + 'setMessageFloor: setMessageFloorNarrow, ',
  orchestratorLiteral: '      appendMessages: appendMessagesNarrow,\n' + MESSAGE_HOST_ANCHORS.orchestrator,
})

/** 注入的 closure 文本（插在作者 `patchChat` 声明之前；`deletedChatIds`/`str`/各通知函数均已在作者作用域更早声明）。 */
function messageHostHelpers() {
  return `  ${MESSAGE_HOST_MARKER}\n${MESSAGE_HOST_FUNCTIONS.join('\n')}\n`
}

function assertMessageHostBlocks(source) {
  const missing = Object.entries(MESSAGE_HOST_BLOCKS).filter(([, text]) => !source.includes(text)).map(([key]) => key)
  if (missing.length > 0) throw new Error('宿主 DI 生成物缺块: ' + missing.join(', '))
}

/**
 * 宿主 DI 转换（幂等）：marker 恰 1 ⇒ 逐块校验后原样返回；0 ⇒ 施缝；其它 ⇒ 半应用拒。
 * 三个锚点各自必须**全文唯一**，缺失或重复即拒。
 * @param {string} source 作者 index.js 原文
 */
export function applyNativeMessageHostTransform(source) {
  if (typeof source !== 'string' || source === '') throw new Error('宿主 DI 转换缺少源码')
  const markers = countIn(source, MESSAGE_HOST_MARKER)
  if (markers === 1) { assertMessageHostBlocks(source); return source }
  if (markers !== 0) throw new Error('宿主 DI 标记数异常（半应用=' + markers + '）')
  for (const [name, anchor] of Object.entries(MESSAGE_HOST_ANCHORS)) {
    const hits = countIn(source, anchor)
    if (hits !== 1) throw new Error('宿主 DI 锚点缺失/不唯一（' + name + '=' + hits + '）: ' + anchor.split('\n')[0].slice(0, 60))
  }
  let next = source.replace(MESSAGE_HOST_ANCHORS.patchChat, messageHostHelpers() + MESSAGE_HOST_ANCHORS.patchChat)
  next = next.replace(MESSAGE_HOST_ANCHORS.background, MESSAGE_HOST_ANCHORS.background + 'setMessageFloor: setMessageFloorNarrow, ')
  next = next.replace(MESSAGE_HOST_ANCHORS.orchestrator, '      appendMessages: appendMessagesNarrow,\n' + MESSAGE_HOST_ANCHORS.orchestrator)
  if (countIn(next, MESSAGE_HOST_MARKER) !== 1) throw new Error('宿主 DI 转换结果标记数异常=' + countIn(next, MESSAGE_HOST_MARKER))
  assertMessageHostBlocks(next)
  return next
}

export function isNativeMessageHostApplied(source) {
  if (typeof source !== 'string' || countIn(source, MESSAGE_HOST_MARKER) !== 1) return false
  assertMessageHostBlocks(source)
  return true
}

export default applyNativeDataTransform
