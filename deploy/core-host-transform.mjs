// 核心消费者的作者2.4薄接线；仅纯文本转换，不访问存档/启动服务。
import { applyClientHistoryAuthorityTransform } from './client-history-authority-transform.mjs'
import { applyAuthorRollbackSyncTransform } from './rollback-sync-author-transform.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { applyUpstreamComputeHost } from './upstream-compute-transform.mjs'
export const CORE_HOST_MARKER = '// [dsh-tavern-core-host:v1]'
function once(text, before, after, label) {
  const count = text.split(before).length - 1
  if (count !== 1) throw new Error('核心接入锚点不唯一：' + label + '（' + count + '）')
  return text.replace(before, after)
}
export function applyHostTransform(source) {
  if (source.includes(CORE_HOST_MARKER)) {
    for (const required of ['variableSqliteStore = chatJournalStore.variables', 'persistenceProvider: () =>']) {
      if (!source.includes(required)) throw new Error('核心Host标记存在但消费者缺失：' + required)
    }
    // 上游计算接管带能力门控（见下方 applyUpstreamComputeHost 调用处）：只有作者代具备服务端
    // 计算分发（createServerScriptExecutor，2.7.0 引入）时才会注入 authorizeUpstreamCall。
    // 旧代二次安装/幂等时不该被这条误拒，故同样按能力判。
    if (source.includes('createServerScriptExecutor') && !source.includes('authorizeUpstreamCall(method, args,')) {
      throw new Error('核心Host标记存在但消费者缺失：authorizeUpstreamCall(method, args,')
    }
    return applyVariableConsumerTransform(source)
  }
  let next = CORE_HOST_MARKER + '\n' + source
  next = once(next, '  const chatPersistence = createChatPersistence(',
    "  const variableSqliteStore = chatJournalStore.variables\n  if (!variableSqliteStore) throw new Error('核心接入缺少变量SQLite消费者')\n  ctx.effect(() => () => chatJournalStore.dispose(), 'dsh-tavern: SQLite资源释放')\n  const chatPersistence = createChatPersistence(", '变量消费者')
  const readSlotVariants = [
    ['readRevision: readChatRevision, write: writeChat, update: updateChat },\n    sessions:', 'readRevision: readChatRevision, write: writeChat, update: updateChat, readSlice: chatPersistence.readSlice },\n    sessions:'],
    ['return selected && { ...selected, chat: normalizeChat(selected.chat) }\n      } },\n    sessions:', 'return selected && { ...selected, chat: normalizeChat(selected.chat) }\n      }, readSlice: chatPersistence.readSlice },\n    sessions:'],
  ]
  if (readSlotVariants.reduce((count, [anchor]) => count + next.split(anchor).length - 1, 0) !== 1) throw new Error('核心接入锚点不唯一：回退head行键读接口（有限新旧布局）')
  const readSlot = readSlotVariants.find(([anchor]) => next.includes(anchor))
  next = once(next, readSlot[0], readSlot[1], '回退head行键读接口')
  next = once(next, '    sessionPatch,\n  })\n\n  const bodyEditor',
    "    sessionPatch,\n    variableStore: variableSqliteStore,\n    persistenceProvider: () => ctx.get('sessionPersistence'),\n    projectionsProvider: () => ctx.get('sessionProjections'),\n    projectionCacheProvider: () => ctx.get('sessionProjectionCache'),\n    tokenMeterProvider: () => ctx.get('tokenMeter'),\n    webServerProvider: () => ctx.get('webServer'),\n  })\n\n  const bodyEditor", '完整回退实时服务')
  // 上游计算接管只对具备服务端计算分发机制的作者代生效：createServerScriptExecutor 自 2.7.0
  // 引入（连同 priority/pageInFront/serverScripts 这套分发）。旧代没有这套机制，硬造接缝只会
  // 得到跑不起来的代码，故按能力跳过——这是"向下适配"，不是放宽准入。
  // 反向护栏不放松：有 executor 而锚点缺失/重复，说明新版上游改坏了接缝点，由
  // applyUpstreamComputeHost 内部的 once() 响亮失败，不静默跳过（否则计算权会悄悄落回页面，
  // 违反"唯一上游服务端计算"与"服务端不可用须失败/等待，不允许假成功或页面回落"）。
  //
  // 但"作者入口的开局分类锚点"与上游计算注入是两件事：它是 opening 链路的必需锚点，旧代虽不接
  // 上游计算，这个锚点仍必须存在且唯一。故跳过注入时用 replaceOnce 做一次自校验（原文换原文），
  // 缺失/重复照样响亮失败——否则破坏它就等于绕过准入（曾因漏此校验让"未知作者契约"负例失效）。
  if (next.includes('createServerScriptExecutor')) {
    next = applyUpstreamComputeHost(next)
  } else {
    // 旧代不施上游计算接缝，但作者入口的开局分类锚点仍是 opening 链路的必需锚点：
    // 存在且唯一。这里显式校验并抛出**语义自描述**的错误（不复用 replaceOnce 的
    // "上游计算接入锚点"前缀——旧代本就与上游计算无关，错误信息不能误导排障）。
    const openingAnchor = 'createOpeningPreparation({ readCard, worldBooks, extensionSettings:'
    if (next.split(openingAnchor).length !== 2) throw new Error('开局动态分类宿主锚点缺失/重复')
  }
  next = applyBodyEditEventTransform(next)
  return applyVariableConsumerTransform(next)
}

// 正文编辑真实生命周期事件：新版上游（42852b0/2.5.0）save 之后自带 notifyPluginTimeline('edit')，旧版是单行 return。
// 双形态各自严格唯一（exclusive once，不用松 regex）；注入体保留 MESSAGE_EDITED 同步派发，旧版**不**假造 notify 调用。
const BODY_EDIT_EVENT_MARKER = '// [dsh-tavern-body-edit-event:v1]'
const BODY_EDIT_EVENT_LEGACY = "      case 'saveBodyEdit': return { view: await bodyEditor.save(args && args.sessionId, args) }"
const BODY_EDIT_EVENT_NEW = `      case 'saveBodyEdit': {
        const view = await bodyEditor.save(args && args.sessionId, args)
        notifyPluginTimeline(args && args.sessionId, 'edit', { settled: true })
        return { view }
      }`
const BODY_EDIT_EVENT_NEW_WITH_ADOPTION = `      case 'saveBodyEdit': {
        await adoptUncommittedRounds(args && args.sessionId)
        const view = await bodyEditor.save(args && args.sessionId, args)
        notifyPluginTimeline(args && args.sessionId, 'edit', { settled: true })
        return { view }
      }`
// 上游 537e878（#196）把编辑前的"补记在途轮"升级为完整对账器：reconcileStory 只在 idle 时
// 核对存档与原生会话，可证明的漏记才补写。它与本插件是**协作**关系而非替代：
// 补记是否合法仍由 storage-failure-state/rollback-body-commit 的护栏判定，这里只换锚点形态。
const BODY_EDIT_EVENT_NEW_WITH_RECONCILE = `      case 'saveBodyEdit': {
        await reconcileStory(args && args.sessionId)
        const view = await bodyEditor.save(args && args.sessionId, args)
        notifyPluginTimeline(args && args.sessionId, 'edit', { settled: true })
        return { view }
      }`
function bodyEditEventBody(keepAuthorNotify, adoptUncommitted = false, reconcile = false) {
  return `      case 'saveBodyEdit': {
        ${BODY_EDIT_EVENT_MARKER}
        // 正文编辑的服务端事件在作者已同步原生Surface之后派发；只观察最后一楼，不扫描历史。
        const sessionId = args && args.sessionId
        const chatId = (await readSessionMap())[sessionId]
        const before = chatId && await chatPersistence.readWindow(chatId, { limit: 1 })
        ${adoptUncommitted ? "await adoptUncommittedRounds(sessionId)\n        " : ''}${reconcile ? "await reconcileStory(sessionId)\n        " : ''}const bodyView = await bodyEditor.save(sessionId, args)${keepAuthorNotify ? "\n        notifyPluginTimeline(sessionId, 'edit', { settled: true })" : ''}
        const after = chatId && await chatPersistence.readWindow(chatId, { limit: 1 })
        const oldText = before?.chat?.messages?.[0]?.sourceText ?? before?.chat?.messages?.[0]?.text
        const newText = after?.chat?.messages?.[0]?.sourceText ?? after?.chat?.messages?.[0]?.text
        if (before && after && oldText !== newText) {
          const current = await chatForSession(sessionId)
          await tavernScriptHostAdapter.dispatchEvent({ sessionId, chat: current, name: 'MESSAGE_EDITED', args: [after.to] })
          const latest = await chatForSession(sessionId)
          return { view: await view(latest, await readChatCard(latest)) }
        }
        return { view: bodyView }
      }`
}
// 新版上游（a2008bf）插件 editTurn → deps.editText → bodyEditor.replaceText：作者只 notify 时间线，
// **不派发服务端 MESSAGE_EDITED**；此处补同一事件（严格唯一锚点，旧版无此入口则原样通过）。
const BODY_EDIT_TEXT_ANCHOR = `    editText: async (material, text) => {
      await bodyEditor.replaceText(material.sessionId, text)
      notifyPluginTimeline(material.sessionId, 'edit', { settled: true })
    },`
const BODY_EDIT_TEXT_MARKER = '// [dsh-tavern-body-edit-text-event:v1]'
function bodyEditTextBody() {
  return `    editText: async (material, text) => {
      ${BODY_EDIT_TEXT_MARKER}
      // 与 saveBodyEdit 同语义：只观察最后一楼窗口、正文真变化才派发、失败不派发。
      const sessionId = material && material.sessionId
      const chatId = sessionId && (await readSessionMap())[sessionId]
      const before = chatId && await chatPersistence.readWindow(chatId, { limit: 1 })
      await bodyEditor.replaceText(sessionId, text)
      notifyPluginTimeline(sessionId, 'edit', { settled: true })
      const after = chatId && await chatPersistence.readWindow(chatId, { limit: 1 })
      const oldText = before?.chat?.messages?.[0]?.sourceText ?? before?.chat?.messages?.[0]?.text
      const newText = after?.chat?.messages?.[0]?.sourceText ?? after?.chat?.messages?.[0]?.text
      if (before && after && oldText !== newText) {
        const current = await chatForSession(sessionId)
        await tavernScriptHostAdapter.dispatchEvent({ sessionId, chat: current, name: 'MESSAGE_EDITED', args: [after.to] })
      }
    },`
}

export function applyBodyEditEventTransform(source) {
  if (source.includes(BODY_EDIT_EVENT_MARKER)) {
    const injectedBodies = [bodyEditEventBody(true, true), bodyEditEventBody(true, false), bodyEditEventBody(false, true), bodyEditEventBody(false, false), bodyEditEventBody(true, false, true)]
    if (!injectedBodies.some(body => source.includes(body))) throw new Error('正文编辑接缝已注入但内容不符')
    // 旧 marker 不得充当新入口的安全证：声明了 editText 属性就必须是**完整已注入体**（半缺/被还原/未知一律拒）
    const textDeclaredAny = /\beditText\s*:/.test(source)
    const textInjected = source.split(bodyEditTextBody()).length - 1
    if (textInjected > 1) throw new Error('正文编辑(editText)接缝注入体重复')
    if (textDeclaredAny && textInjected !== 1) throw new Error('正文编辑(editText)接缝已声明但未注入或内容不符')
    if (source.split(BODY_EDIT_TEXT_MARKER).length - 1 > 1) throw new Error('正文编辑(editText)接缝标记重复')
    return source
  }
  const hasNewWithAdoption = source.split(BODY_EDIT_EVENT_NEW_WITH_ADOPTION).length === 2
  const hasNew = source.split(BODY_EDIT_EVENT_NEW).length === 2
  const hasReconcile = source.split(BODY_EDIT_EVENT_NEW_WITH_RECONCILE).length === 2
  const hasLegacy = source.split(BODY_EDIT_EVENT_LEGACY).length === 2
  // 四种作者形态互不为子串；恰一命中才施缝。多形态/零形态都是未知布局，一律拒（不猜、不兼容降级）。
  const forms = [['legacy', hasLegacy], ['new', hasNew], ['adoption', hasNewWithAdoption], ['reconcile', hasReconcile]]
  const hits = forms.filter(entry => entry[1])
  if (hits.length !== 1) throw new Error('正文编辑接缝锚点缺失或重复')
  const kind = hits[0][0]
  const anchor = kind === 'legacy' ? BODY_EDIT_EVENT_LEGACY
    : kind === 'new' ? BODY_EDIT_EVENT_NEW
    : kind === 'adoption' ? BODY_EDIT_EVENT_NEW_WITH_ADOPTION
    : BODY_EDIT_EVENT_NEW_WITH_RECONCILE
  const keepAuthorNotify = kind !== 'legacy'
  // 两种作者前置调用都必须原样保留：旧"补记"adoptUncommittedRounds、新对账reconcileStory。
  // 施缝只接管事件派发窗口，不吞作者的对账/补记语义。
  const adoptUncommitted = kind === 'adoption'
  const reconcile = kind === 'reconcile'
  let next = source.replace(anchor, bodyEditEventBody(keepAuthorNotify, adoptUncommitted, reconcile))
  // 新版独有的插件 editText 入口：出现即必须严格命中一次（未知/重复形态一律拒），旧版无此入口则原样通过。
  const textHits = next.split(BODY_EDIT_TEXT_ANCHOR).length - 1
  const textDeclared = /\beditText\s*:/.test(next)
  if (textHits > 1) throw new Error('正文编辑(editText)接缝锚点重复')
  if (textHits === 0 && textDeclared) throw new Error('正文编辑(editText)接缝锚点不匹配')
  if (textHits === 1) next = next.replace(BODY_EDIT_TEXT_ANCHOR, bodyEditTextBody())
  return next
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
  // 定位真实声明而非旧默认数值；词法伪文本不算，唯一性和数值声明形态仍强制。
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  const candidates = []
  const numeric = node => node?.type === 'Literal' && typeof node.value === 'number' && Number.isFinite(node.value)
  if (target === 'dispatch') {
    for (const node of ast.body) {
      const declaration = node.type === 'ExportNamedDeclaration' && node.declaration
      if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
      for (const item of declaration.declarations) if (item.id.type === 'Identifier' && item.id.name === 'TAVERN_SCRIPT_CLAIM_TIMEOUT_MS' && numeric(item.init)) candidates.push(item.init)
    }
  } else if (target === 'template') {
    const visit = node => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'ObjectPattern') {
        const timeout = node.properties.filter(p => p.type === 'Property' && !p.computed && p.key.name === 'timeoutMs' && p.value.type === 'AssignmentPattern' && p.value.left.name === 'timeoutMs' && numeric(p.value.right))
        const idle = node.properties.some(p => p.type === 'Property' && !p.computed && p.key.name === 'idleMs' && p.value.type === 'AssignmentPattern' && p.value.left.name === 'idleMs' && numeric(p.value.right))
        if (idle) for (const item of timeout) candidates.push(item.value.right)
      }
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value)
    }
    visit(ast)
  } else throw new Error('未知预算消费者：' + target)
  const label = target === 'dispatch' ? '浏览器UI脚本认领预算' : '服务端模板预算'
  if (candidates.length !== 1) throw new Error('核心接入锚点不唯一：' + label + '（' + candidates.length + '）')
  const node = candidates[0], value = target === 'dispatch' ? 'scriptClaimMs' : 'serverTemplateMs'
  return "import { BUDGETS } from './storage-budgets.js'\n" + marker + '\n' + source.slice(0, node.start) + 'BUDGETS.' + value + source.slice(node.end)
}
export function applyClientRollbackTransform(source) {
  return applyClientHistoryAuthorityTransform(applyAuthorRollbackSyncTransform(source))
}
