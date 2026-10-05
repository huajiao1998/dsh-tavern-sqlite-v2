// 核心消费者的作者2.4薄接线；仅纯文本转换，不访问存档/启动服务。
import { applyClientHistoryAuthorityTransform } from './client-history-authority-transform.mjs'
import { applyAuthorRollbackSyncTransform } from './rollback-sync-author-transform.mjs'
export const CORE_HOST_MARKER = '// [dsh-tavern-core-host:v1]'
function once(text, before, after, label) {
  const count = text.split(before).length - 1
  if (count !== 1) throw new Error('核心接入锚点不唯一：' + label + '（' + count + '）')
  return text.replace(before, after)
}
export function applyHostTransform(source) {
  if (source.includes(CORE_HOST_MARKER)) {
    for (const required of ['variableSqliteStore = chatJournalStore.variables', 'persistenceProvider: () =>', 'readCardExtensions,', 'storageBrowserScripts(helperRuntime.scripts, { store: storageDispatchMarks, cardPath: chat.cardPath })']) {
      if (!source.includes(required)) throw new Error('核心Host标记存在但消费者缺失：' + required)
    }
    if (!source.includes('signal: descriptor.signal') || !source.includes('generate: async (config, descriptor)')) throw new Error('核心Host生成消费者不完整；须按所属代卸缝后适配')
    return applyVariableConsumerTransform(source)
  }
  let next = "import { storageBrowserScripts, createServerDispatchStore } from './domain/storage-server-execution.js'\n" + CORE_HOST_MARKER + '\n' + source
  next = once(next, '  const chatPersistence = createChatPersistence(',
    "  const variableSqliteStore = chatJournalStore.variables\n  if (!variableSqliteStore) throw new Error('核心接入缺少变量SQLite消费者')\n  ctx.effect(() => () => chatJournalStore.dispose(), 'dsh-tavern: SQLite资源释放')\n  const chatPersistence = createChatPersistence(", '变量消费者')
  next = once(next, '  const tavernScriptHostAdapter = createTavernScriptHostAdapter({',
    "  const storageDispatchMarks = createServerDispatchStore({ dataRoot })\n  ctx.effect(() => () => storageDispatchMarks.dispose(), 'dsh-tavern: 服务端脚本标记资源释放')\n  const tavernScriptHostAdapter = createTavernScriptHostAdapter({", '服务端脚本标记实例')
  next = once(next, '    scriptDispatch: tavernScriptDispatch,',
    `    scriptDispatch: tavernScriptDispatch,
    cardScriptDispatchStore: storageDispatchMarks,
    ownExecution: dispose => ctx.effect(() => dispose, 'dsh-tavern: 服务端执行释放'),
    readCardExtensions,
    // 作者2.5 Helper生成消费面：**复用作者任务工厂与编译器**，本包只提供宿主侧
    // callModel / 当前草稿上下文 / 预设与世界书资源。raw 也必须拿到 signal（作者语义：
    // background:true + 同一次请求的取消信号），**不能丢 signal**。
    createGenerationTasks: () => createHelperGenerationTasks(),
    generateRaw: async (config, descriptor) => {
      const helperContext = descriptor.context?.helperContext
      if (!helperContext) throw new Error('generateRaw缺少当前上下文')
      return generateHelperRaw(config, { callModel: opts => callModel({ ...opts, background: true, signal: descriptor.signal }),
        sessionId: descriptor.sessionId,
        history: helperContext.messages.map(row => ({ role: row.role, text: row.message })) })
    },
    generate: async (config, descriptor) => {
      validateHelperGenerateConfig(config)
      const chat = descriptor.context?.chat
      if (!chat) throw new Error('generate缺少绑定的当前草稿')
      // 预设/世界书/扩展/正则全部取**当前草稿**（不是持久化最新），与作者 RPC 路径同序。
      const presetSnapshot = await helperGenerationPreset(config.preset_name, chat.runtimePresetSnapshot || null)
      const activeSnapshot = config.preset_name && config.preset_name !== 'in_use'
        ? await helperGenerationPreset('in_use', chat.runtimePresetSnapshot || null) : presetSnapshot
      const card = await readChatCard(chat)
      const worldBook = await worldBooks.bound(chat.cardPath, card, chat)
      const extensions = await readCardExtensions(chat.cardPath, chat)
      descriptor.signal?.throwIfAborted()
      return generateHelper(config, { callModel: opts => callModel({ ...opts, background: true, signal: descriptor.signal }),
        sessionId: descriptor.sessionId, history: helperGenerationHistory(chat), chat, card, worldBook, presetSnapshot,
        presetRegexScripts: activeSnapshot?.regexScripts || [], extensions,
        characterVariables: extensions?.variables || {} })
    },`, '服务端卡脚本与模型生成')
  next = once(next, 'readRevision: readChatRevision, write: writeChat, update: updateChat },\n    sessions:',
    'readRevision: readChatRevision, write: writeChat, update: updateChat, readSlice: chatPersistence.readSlice },\n    sessions:', '回退head行键读接口')
  next = once(next, '    sessionPatch,\n  })\n\n  const bodyEditor',
    "    sessionPatch,\n    variableStore: variableSqliteStore,\n    persistenceProvider: () => ctx.get('sessionPersistence'),\n    projectionsProvider: () => ctx.get('sessionProjections'),\n    projectionCacheProvider: () => ctx.get('sessionProjectionCache'),\n    tokenMeterProvider: () => ctx.get('tokenMeter'),\n    webServerProvider: () => ctx.get('webServer'),\n  })\n\n  const bodyEditor", '完整回退实时服务')
  next = once(next, '    helperRuntime.diagnostics.push(...(Array.isArray(cardExtensions.remoteAssetDiagnostics)',
    '    helperRuntime.scripts = storageBrowserScripts(helperRuntime.scripts, { store: storageDispatchMarks, cardPath: chat.cardPath })\n    helperRuntime.diagnostics.push(...(Array.isArray(cardExtensions.remoteAssetDiagnostics)', '浏览器计算退役')
  next = once(next, "owner: chat.mvu.owner === 'official' ? 'official' : 'legacy',",
    "owner: 'server', serverOwned: true,", '浏览器MVU核心退役')
  next = once(next, "    requiresBrowser: async chat => hasTavernScriptRuntime(chat, (await readCardExtensions(chat.cardPath, chat))?.helperScripts)",
    "    requiresBrowser: async chat => storageBrowserScripts(projectTavernHelperScripts((await readCardExtensions(chat.cardPath, chat))?.helperScripts).scripts, { store: storageDispatchMarks, cardPath: chat.cardPath }).length > 0", '无计算脚本浏览器依赖')
  next = once(next, "      case 'saveBodyEdit': return { view: await bodyEditor.save(args && args.sessionId, args) }",
    `      case 'saveBodyEdit': {
        // 正文编辑的服务端事件在作者已同步原生Surface之后派发；只观察最后一楼，不扫描历史。
        const sessionId = args && args.sessionId
        const chatId = (await readSessionMap())[sessionId]
        const before = chatId && await chatPersistence.readWindow(chatId, { limit: 1 })
        const bodyView = await bodyEditor.save(sessionId, args)
        const after = chatId && await chatPersistence.readWindow(chatId, { limit: 1 })
        const oldText = before?.chat?.messages?.[0]?.sourceText ?? before?.chat?.messages?.[0]?.text
        const newText = after?.chat?.messages?.[0]?.sourceText ?? after?.chat?.messages?.[0]?.text
        if (before && after && oldText !== newText) {
          const current = await chatForSession(sessionId)
          await tavernScriptHostAdapter.dispatchServerEvent({ sessionId, chat: current, event: 'MESSAGE_EDITED', args: [after.to] })
          const latest = await chatForSession(sessionId)
          return { view: await view(latest, await readChatCard(latest)) }
        }
        return { view: bodyView }
      }`, '正文编辑真实生命周期事件')
  return applyVariableConsumerTransform(next)
}

// R1额外代标记：已装核心Host也必须升级消费者；不依赖重新fork整份作者模块。
export function applyVariableConsumerTransform(source) {
  const marker = '// [dsh-tavern-current-variables:v1]'
  if (source.includes(marker)) {
    for (const required of ['const currentVariablesOf = createCurrentVariableReader(', 'readSnapshot: readCurrentVariableSnapshot', '    currentVariablesOf,']) {
      if (!source.includes(required)) throw new Error('当前变量标记存在但消费者缺失：' + required)
    }
    return source
  }
  let next = "import { createCurrentVariableReader } from './domain/storage-current-variables.js'\n" + marker + '\n' + source
  next = once(next, '  const variableSqliteStore = chatJournalStore.variables',
    '  const readCurrentVariableSnapshot = chat => chatJournalStore.readCurrentVariableSnapshot(chat)\n  const currentVariablesOf = createCurrentVariableReader({ lastVariables: lastTavernHelperVariables, readSnapshot: readCurrentVariableSnapshot })\n  const variableSqliteStore = chatJournalStore.variables', 'R1当前变量同revision兜底')
  for (const old of ['lastTavernHelperVariables(recent.chat.messages)', 'lastTavernHelperVariables(chat.messages)']) {
    if (!next.includes(old)) throw new Error('当前变量作者调用锚点缺失：' + old)
    next = next.split(old).join(old.includes('recent.chat') ? 'currentVariablesOf(recent.chat)' : 'currentVariablesOf(chat)')
  }
  next = once(next, '    resolveChat: chatForSession,', '    currentVariablesOf,\n    resolveChat: chatForSession,', 'R1 Helper临时上下文DI')
  next = once(next, 'registerVariableReadTool({tools,defineTool,chatForSession})',
    'registerVariableReadTool({tools,defineTool,chatForSession,readSnapshot: readCurrentVariableSnapshot})', 'R1前台查询兜底')
  return next
}
export function applyHelperCurrentTransform(source) {
  const marker = '// [dsh-tavern-helper-current-variables:v1]'
  const anchor = '      const previousVariables = lastTavernHelperVariables(draft.messages)'
  const next = '      const previousVariables = typeof options.currentVariablesOf === "function"\n        ? options.currentVariablesOf(draft) : lastTavernHelperVariables(draft.messages)'
  if (source.includes(marker)) {
    if (!source.includes(next)) throw new Error('Helper当前变量标记存在但消费者缺失')
    return source
  }
  return marker + '\n' + once(source, anchor, next, 'R1临时用户楼继承当前变量')
}
export function applyBudgetTransform(source, target) {
  const marker = '// [dsh-tavern-core-budget:v1:' + target + ']'
  if (source.includes(marker)) return source
  if (target === 'dispatch') {
    return "import { BUDGETS } from './storage-budgets.js'\n" + marker + '\n' + once(source,
      'export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000',
      'export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = BUDGETS.scriptClaimMs', '浏览器UI脚本认领预算')
  }
  if (target === 'template') {
    return "import { BUDGETS } from './storage-budgets.js'\n" + marker + '\n' + once(source,
      'timeoutMs = 120000, idleMs = 600000', 'timeoutMs = BUDGETS.serverTemplateMs, idleMs = 600000', '服务端模板预算')
  }
  throw new Error('未知预算消费者：' + target)
}
export function applyClientRollbackTransform(source) {
  return applyClientHistoryAuthorityTransform(applyAuthorRollbackSyncTransform(source))
}
