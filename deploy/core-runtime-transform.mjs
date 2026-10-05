// dsh-tavern 核心运行时接缝：**纯源码变换**（不改作者文件，只返回新字符串）
//
// 目标文件：作者树 `tavern-plugin/lib/domain/tavern-script-host-adapter.js`（B 2.4 权威源）。
// 作用：把 settleMvuUpdate 里的「浏览器执行器派发 MESSAGE_RECEIVED」整体换成服务端执行消费者
// （`dsh-tavern-sqlite-v2/lib/server-execution.js`），并删掉执行前的浏览器 availability 判断：
//
//   ① 顶部插一行薄垫片 import：`./storage-server-execution.js`（作者树里的垫片由**主 seams 创建**，
//      最终生产内容由standard-seams.mjs写入；本文件SERVER_EXECUTION_SHIM只保留旧模板，
//      垫片负责profile锚点解析本包与作者project/ownership及资源DI，
//      **不是裸包 import**，作者应用树与 profile 包不在同一解析祖先链）。
//   ② `dispatchEvent` 里对 `MESSAGE_RECEIVED` 直接结构化拒绝（serverOwned）——服务端不允许浏览器
//      重新执行变量核心；其它事件（MESSAGE_SENT / MESSAGE_DELETED …）照旧走浏览器执行器。
//   ③ 删 `settleMvuUpdate` 执行前的浏览器判断：`scriptDispatch.status()` 的 busy 分支、
//      `availability.initializationError` / `ready !== true` 分支与 `initializationRejected`。
//   ④ 浏览器 `scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED', …)` 及其全部错误分支
//      （unavailable / claimTimedOut / timedOut / disposed / retryAfter 回执）替换为
//      `serverExecution.executeMvuUpdate(...)`；失败**抛错**（作者侧 catch 后不提交，
//      与 mvu-background-settlement 的 "结果无法确认，停止自动重试" 语义一致）。
//   ⑤ 适配器内构造一次 `serverExecution`：DI 作者读卡扩展/hasScripts/DOM 标记存储/generateRaw，
//      Host 变更 API（updateVariables / updateMessages / createMessages / getWorldbook /
//      replaceWorldbook）由 server-execution 按**当前事务 eventId** 绑定。
//
// 事务内部**保持不变**：work / ensureRows / 事务草稿 / validation / effect / CAS（lifecycle +
// 提交前 resolveChatSlice 复核）全部走作者原逻辑，本变换不碰。
//
// ⚠ 本轮**只覆盖 settlement 路径**（缺口语义，主 seams 补）：MESSAGE_SENT / MESSAGE_DELETED /
// MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_EDITED 等服务端生命周期事件的派发**未实现** ——
// 变换后 `dispatchEvent` 除 MESSAGE_RECEIVED（结构化拒绝 `serverOwned`）外仍走浏览器执行器。
// 接余/预路由的落点就是 `dispatchEvent` 函数体（在拒绝分支之后、`options.scriptDispatch.dispatch`
// 之前插入服务端派发 + 队列）；本轮不造，避免与主 seams 的队列设计互相覆盖。
//
// 约束：幂等（版本标记唯一，已施则只校验完整性）、未知布局一律抛错（拒绝猜测修补）、
// 只返回字符串（作者文件由调用方按自己的备份流程写回）。
export const RUNTIME_TRANSFORM_VERSION = 1
export const RUNTIME_MARKER = '// [dsh-tavern:core-runtime v1]'
const SNIPPET = '// [dsh-tavern:core-runtime]'
export const SERVER_EXECUTION_SHIM_REL = 'lib/domain/storage-server-execution.js'
const SHIM_SPECIFIER = "import { createServerExecution } from './storage-server-execution.js'"

/** 历史薄垫片模板（非当前写盘消费者）；最终生产shim由standard-seams.mjs独占组装。 */
export const SERVER_EXECUTION_SHIM = `// ⚠ 部署件：dsh-tavern 服务端 MVU 执行消费者（作者树薄垫片）
// 真实现归 dsh-tavern-sqlite-v2（lib/server-execution.js）；作者应用树与 profile 包不在同一
// 解析祖先链，必须按 profile 锚点解析（与 chat-sqlite-store.js 垫片同一模式），不能写裸包说明符。
//
// DI：作者这一份 projectTavernHelperScripts / isHostOwnedMvu 注入实现（脚本筛选只有一套，
// 不 fork 作者代码）。**脚本分类不需要作者导出** —— B 2.4 的 tavern-helper-scripts.js 只有
// isHostOwnedMvu / projectTavernHelperScripts / hasTavernScriptRuntime，没有 classifyCardScript，
// 分类由包内 server-execution.classifyCardScript 提供（默认「不认识即 server-compute，排除 esm/DOM及浏览器独有facade引用」）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import * as helperScripts from './tavern-helper-scripts.js'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
async function loadOwned(name) {
  for (const anchor of [path.join(home, 'profiles', 'tavern', 'package.json'), path.join(home, 'apps', 'dsh-tavern', 'package.json')]) {
    try { return await import(pathToFileURL(createRequire(anchor).resolve('dsh-tavern-sqlite-v2/' + name)).href) } catch { /* 换下一个锚点 */ }
  }
  return null
}

const impl = await loadOwned('server-execution')
if (impl === null) console.error('[storage-server-execution] 解析不到 dsh-tavern-sqlite-v2/server-execution（已按 profile 锚点找过）')
const project = helperScripts.projectTavernHelperScripts
const isHostOwnedMvu = helperScripts.isHostOwnedMvu
if (typeof project !== 'function') console.error('[storage-server-execution] 作者树 tavern-helper-scripts.js 缺少 projectTavernHelperScripts')

export function createServerExecution(options = {}) {
  if (impl === null) throw new Error('未安装 dsh-tavern-sqlite-v2：服务端 MVU 执行不可用')
  return impl.createServerExecution({
    ...options,
    project: options.project ?? project,
    isHostOwnedMvu: options.isHostOwnedMvu ?? isHostOwnedMvu,
  })
}

// view / helperRuntime 过滤用：只保 classify !== 'server-compute' 且非宿主 MVU 核心的脚本。
export function storageBrowserScripts(scripts, deps = {}) {
  if (impl === null) throw new Error('未安装 dsh-tavern-sqlite-v2：脚本分派过滤不可用')
  return impl.storageBrowserScripts(scripts, { isHostOwnedMvu, ...deps })
}

// view 的 mvu.serverOwned 来源：变量核心归服务端，前端据此不初始化浏览器 MVU core。
export function mvuRuntimeOwnership(input = {}) {
  if (impl === null) throw new Error('未安装 dsh-tavern-sqlite-v2：运行时归属投影不可用')
  return impl.mvuRuntimeOwnership({ project, isHostOwnedMvu, ...input })
}
`

// ---------- 作者源码锚点（B 2.4 权威源逐字；缩进已用 repr 核对，勿凭印象改） ----------
const IMPORT_ANCHOR = "import { createMvuSettlementEffect } from './mvu-settlement-effect.js'\n"

const DISPATCH_EVENT_ANCHOR = [
  '  async function dispatchEvent(input = {}) {\n',
  '    const eventContext = input.context || await context(input.sessionId, input.chat, input.transientUserText)\n',
  '    // Context preparation can await I/O before MVU has queued its dispatch.\n',
  '    // Respect that reservation just as dispatch respects an executing event.\n',
  "    if (settlementTransactions.has(str(input.sessionId))) return { handled: false, busy: true, args: structuredClone(input.args || []) }\n",
  '    return await options.scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)\n',
  '  }\n'
].join('')

const DISPATCH_EVENT_NEXT = [
  '  async function dispatchEvent(input = {}) {\n',
  '    ' + SNIPPET + ' 事件路由：变量核心（MESSAGE_RECEIVED）由服务端结算通道执行，\n',
  '    // 不允许浏览器重新执行变量核心；其它生命周期事件**先在服务端跑 server-compute 卡脚本钩子**，\n',
  '    // 再（若该卡还有 browser-ui 脚本）照旧下发浏览器执行器。\n',
  "    if (str(input.name) === 'MESSAGE_RECEIVED') return { handled: false, serverOwned: true, args: structuredClone(input.args || []) }\n",
  '    const sessionId = str(input.sessionId)\n',
  '    // 结算在飞 ⇒ 抛错 reject（不静默跳过：静默会让调用方以为事件已派发；同步 mutation 不与 MVU 事务并发）\n',
  "    if (settlementTransactions.has(sessionId)) { const busy = new Error('当前对话正在执行 MVU 结算，事件 ' + str(input.name) + ' 未派发，请稍后重试'); busy.code = 'SERVER_EXECUTION_BINDING_BUSY'; throw busy }\n",
  '    const serverChat = input.chat || (typeof options.resolveChat === \'function\' ? await options.resolveChat(sessionId) : undefined)\n',
  '    let serverEvent = null\n',
  '    if (serverChat) {\n',
  '      serverEvent = await serverExecution.dispatchLifecycleEvent({\n',
  '        sessionId, chat: serverChat, event: str(input.name),\n',
  '        args: Array.isArray(input.args) ? input.args : []\n',
  '      })\n',
  '    }\n',
  '    const eventContext = input.context || await context(input.sessionId, input.chat, input.transientUserText)\n',
  '    const dispatched = await options.scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)\n',
  '    return { ...dispatched, serverOwned: true, serverHandled: serverEvent ? serverEvent.handled === true : false, serverHooks: serverEvent ? serverEvent.hooks : null }\n',
  '  }\n'
].join('')

// 生命周期路由的第二段：只有该卡**确实有浏览器脚本**（真投影计数，browserScripts===0 不算）才下发
// 浏览器执行器；纯计算卡服务端跑完立即回执，不被浏览器链路阻塞。null=未知（未接线）时保守照旧下发。
const LIFECYCLE_TAIL_ANCHOR = [
  '    const eventContext = input.context || await context(input.sessionId, input.chat, input.transientUserText)\n',
  '    const dispatched = await options.scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)\n',
  '    return { ...dispatched, serverOwned: true, serverHandled: serverEvent ? serverEvent.handled === true : false, serverHooks: serverEvent ? serverEvent.hooks : null }\n',
  '  }\n'
].join('')

const LIFECYCLE_TAIL_NEXT = [
  '    // 服务端已跑完：浏览器侧脚本数 0 ⇒ **立即回执**（纯计算卡不再被浏览器执行器链路阻塞）。\n',
  '    const browserScripts = serverEvent ? serverEvent.browserScripts : null\n',
  "    if (browserScripts === 0) return { handled: serverEvent ? serverEvent.handled === true : false, serverOwned: true, browserDispatched: false, serverHandled: serverEvent ? serverEvent.handled === true : false, serverHooks: serverEvent ? serverEvent.hooks : null, args: structuredClone(input.args || []) }\n",
  '    // 服务端钩子可能已改变量 ⇒ 浏览器上下文**重新取**（绝不复用调用方传进来的旧 context）。\n',
  '    const eventContext = await context(input.sessionId, input.chat, input.transientUserText)\n',
  '    const dispatched = await options.scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)\n',
  '    return { ...dispatched, serverOwned: true, browserDispatched: true, serverHandled: serverEvent ? serverEvent.handled === true : false, serverHooks: serverEvent ? serverEvent.hooks : null }\n',
  '  }\n'
].join('')
const BUSY_ANCHOR = [
  '    // An earlier lifecycle event still owns the executor. Installing an MVU\n',
  '    // transaction now would reject its legitimate writes during context loading,\n',
  '    // even though dispatch would eventually return busy and defer this attempt.\n',
  '    const beforeDispatch = options.scriptDispatch.status?.(sessionId)\n',
  '    if (beforeDispatch?.busy) {\n',
  "      await record('runtime-deferred', { availability: beforeDispatch })\n",
  "      return { updated: false, deferred: true, deferredReason: 'runtime-busy', context: await fullContext(current) }\n",
  '    }\n'
].join('')

const DISPATCH_ANCHOR = [
  '      const lazy = options.scriptDispatch.supportsContextProjection === true\n',
  '      const eventContext = lazy ? null : await executionContext()\n',
  '      const availability = options.scriptDispatch.status?.(sessionId)\n',
  '      const currentSnapshot=hasMvuSnapshot(transaction.draft.messages[messageId].variables?.[swipeId])\n',
  "      await record('runtime-dispatch', { availability, baseline: { currentSnapshot, priorSnapshot:priorId>=0, usesCurrentFallback:currentSnapshot && priorId<0 } })\n",
  '      async function initializationRejected(error) {\n',
  '        const validation = { changes: [], sideEffects: [], failures: [{ message: error }] }\n',
  "        await record('runtime-initialization-failed', { error })\n",
  '        return { updated: false, rejected: true, retryable: false, validation,\n',
  "          diagnostics: [{ kind: 'initialization', level: 'error', initializationFailed: true, message: error }],\n",
  '          context: await fullContext(current) }\n',
  '      }\n',
  '      if (availability?.initializationError) return await initializationRejected(availability.initializationError)\n',
  '      // MVU is a local capability of the chat. A temporarily absent browser\n',
  '      // executor is scheduling state, not a failed settlement. Return the\n',
  '      // prepared transaction immediately so the caller can persist and resume\n',
  '      // it when the executor registers again.\n',
  '      if (availability && availability.ready !== true) {\n',
  "        await record('runtime-deferred', { availability })\n",
  "        return { updated: false, deferred: true, deferredReason: 'runtime-not-ready', context: await fullContext(current) }\n",
  '      }\n',
  "      const dispatched = await options.scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED', [messageId], eventContext, { eventId: transaction.eventId, signal: input.signal, ...(lazy ? { contextForBaseline: executionContext } : {}) })\n",
  "      await record('runtime-completed', { handled: dispatched.handled === true, timedOut: dispatched.timedOut === true, executionLost: dispatched.executionLost === true, claimTimedOut: dispatched.claimTimedOut === true, phase: dispatched.phase, disposed: dispatched.disposed === true, error: dispatched.error, diagnostics: dispatched.diagnostics || [] })\n",
  '      if (dispatched.handled !== true) {\n',
  '        if (dispatched.initializationFailed === true) return await initializationRejected(str(dispatched.error))\n',
  '        if (dispatched.unavailable === true || (input.durable === true && (dispatched.disposed === true || dispatched.timedOut === true || /超时|timed?\\s*out|timeout/i.test(str(dispatched.error))))) {\n',
  "          await record('runtime-deferred', { availability: options.scriptDispatch.status?.(sessionId) })\n",
  "          return { updated: false, deferred: true, deferredReason: dispatched.claimTimedOut === true ? 'claim-timeout' : 'delivery-interrupted', context: await fullContext(current) }\n",
  '        }\n',
  "        if (str(dispatched.error).trim() !== '' && !dispatched.timedOut && !dispatched.disposed\n",
  '          && !/超时|timed?\\s*out|timeout/i.test(str(dispatched.error))) {\n',
  '          const validation = { changes: [], sideEffects: [], failures: [{ message: str(dispatched.error) }] }\n',
  "          await record('validation-rejected', { failures: validation.failures, externalEffects: transaction.externalEffects === true })\n",
  '          return { updated: false, rejected: true, retryable: transaction.externalEffects !== true, retryAfterMs: MVU_RETRY_AFTER_MS,\n',
  '            validation, diagnostics: dispatched.diagnostics || [], context: await fullContext(current) }\n',
  '        }\n',
  "        if (dispatched.timedOut === true) throw new Error('MVU 脚本执行回执超时，本轮结算未确认完成，请重试结算')\n",
  "        if (dispatched.disposed === true) throw new Error('MVU 浏览器执行器已断开，本轮结算中断，请重试结算')\n",
  "        throw new Error(str(dispatched.error).trim() || '官方 MVU 浏览器运行时尚未就绪，本轮未执行变量结算')\n",
  '      }\n'
].join('')

const DISPATCH_NEXT = [
  '      const currentSnapshot=hasMvuSnapshot(transaction.draft.messages[messageId].variables?.[swipeId])\n',
  "      await record('runtime-dispatch', { mode: 'server-compute', baseline: { currentSnapshot, priorSnapshot:priorId>=0, usesCurrentFallback:currentSnapshot && priorId<0 } })\n",
  '      ' + SNIPPET + ' 变量核心 + 卡脚本钩子由服务端执行；失败一律抛出（不吞、不提交）。\n',
  '      const executed = await serverExecution.executeMvuUpdate({\n',
  '        sessionId, draft: transaction.draft, transaction, messageId, swipeId,\n',
  '        signal: input.signal,\n',
  '        baselineVariables: input.baselineVariables,\n',
  '        // 与浏览器执行器收到的 internalText 同形（正文 + 变量命令），核心按同一输入解析。\n',
  '        commandText: internalText,\n',
  '        // 前台原文：BEFORE_MESSAGE_UPDATE 的 message_content 只能用这个（绝不能用含命令的 internalText）。\n',
  '        originalText,\n',
  '        preserveForeground: input.preserveForeground === true,\n',
  '        record\n',
  '      })\n',
  '      ' + SNIPPET + ' 卡脚本改写过正文（BEFORE_MESSAGE_UPDATE）⇒ 落到本楼的正文槽（preserveForeground 时已在包内拒绝）\n',
  '      const rewrittenText = executed.beforeMessageUpdate && executed.beforeMessageUpdate.changed === true\n',
  '        ? str(executed.beforeMessageUpdate.messageContent) : null\n',
  "      const dispatched = { handled: true, mode: 'server-compute', diagnostics: executed.diagnostics || [] }\n",
  "      await record('runtime-completed', { handled: true, mode: 'server-compute', hooks: executed.hooks || null, beforeMessageUpdate: rewrittenText !== null })\n"
].join('')

// 作者在结算成功后会把这些正文槽**统一回填原文**；有脚本改写时改用 rewrittenText（否则改写等于丢弃）。
const RESTORE_ANCHOR = [
  '      if (!Array.isArray(settled.swipes)) settled.swipes = [originalText]\n',
  '      settled.swipes[swipeId] = originalText\n',
  '      settled.sourceText = originalText\n',
  '      settled.projectionText = originalText\n',
  '      settled.text = originalText\n',
  '      settled.sessionText = originalText\n',
  '      settled.displayText = originalText\n'
].join('')

const RESTORE_NEXT = [
  '      ' + SNIPPET + ' 有 BEFORE_MESSAGE_UPDATE 改写则用改写文本，否则照旧回填原文（preserveForeground 已在包内拒绝改写）\n',
  '      const settledText = rewrittenText === null ? originalText : rewrittenText\n',
  '      if (!Array.isArray(settled.swipes)) settled.swipes = [settledText]\n',
  '      settled.swipes[swipeId] = settledText\n',
  '      settled.sourceText = settledText\n',
  '      settled.projectionText = settledText\n',
  '      settled.text = settledText\n',
  '      settled.sessionText = settledText\n',
  '      settled.displayText = settledText\n'
].join('')

const SETTLE_COMMENT = '  /** Run one internal MVU command against an isolated draft and commit once. */\n'
const SETTLE_ANCHOR = SETTLE_COMMENT + '  async function settleMvuUpdate(input = {}) {\n'

// 作者 `updateMessages`：写成功后按 before/after 派 MESSAGE_SWIPED / MESSAGE_EDITED
// —— **只 server、不下发浏览器**（浏览器 UI 有自己的 eventsBetween，别重复）；事务路径在上面的
// `transactional !== null` 已 return ⇒ 绝不在 MVU 结算里递归派。第 5 参是**内部**令牌（RPC 只传
// 4 参 ⇒ undefined，不受影响），只认本包签发对象（WeakSet 身份识别，伪造无效）。
const MESSAGES_SIGNATURE_ANCHOR = '  async function updateMessages(sessionId, messages, expectedLifecycleRevision, eventId) {\n'
const MESSAGES_SIGNATURE_NEXT = '  async function updateMessages(sessionId, messages, expectedLifecycleRevision, eventId, serverOperationMeta) {\n'

// 写**之前**的并发闸 + 同 operation 判定（原子：不会"已 commit 却丢事件"）。
const MESSAGES_CHAT_ANCHOR = '    const chat = transaction === undefined ? await resolveChat(sessionId) : transaction.draft\n'
const MESSAGES_CHAT_NEXT = [
  MESSAGES_CHAT_ANCHOR.slice(0, -1),
  '    ' + SNIPPET + ' 只认本模块签发的 operation 令牌（伪造对象不认）\n',
  '    const ownOperation = serverExecution.isOwnOperation(serverOperationMeta)\n',
  '    // 外部并发写：**写之前**就 busy 拒绝（原子性：绝不出现"已写入却没派 MESSAGE_SWIPED/EDITED"）；\n',
  '    // 同 operation 的 hook 内写放行，但下面不再递归派同名事件（由 hook 自己知晓）。\n',
  '    if (!ownOperation && serverExecution.isSessionBusy(str(sessionId))) {\n',
  "      const busy = new Error('该会话正在执行服务端 MVU 结算/事件，消息写入未执行，请稍后重试')\n",
  "      busy.code = 'SERVER_EXECUTION_BINDING_BUSY'\n",
  '      throw busy\n',
  '    }\n'
].join('')

const MESSAGES_LINE = '    const updated = replaceTavernHelperMessages(chat, patches)\n'
const MESSAGES_ANCHOR = MESSAGES_LINE
const MESSAGES_NEXT = [
  '    ' + SNIPPET + ' 只记**被 patch 的目标楼**（楼层号 + swipe + 当前 swipe 正文）前像，不扫整档\n',
  '    const lifecycleBefore = (Array.isArray(patches) ? patches : []).map(patch => {\n',
  '      const targetId = Number(patch && patch.message_id)\n',
  '      const row = Number.isInteger(targetId) ? chat.messages[targetId] : null\n',
  '      if (!row) return null\n',
  '      const targetSwipe = Math.max(0, Number(row.swipeId) || 0)\n',
  '      return { messageId: targetId, swipeId: targetSwipe, text: str(row.swipes?.[targetSwipe] ?? row.sourceText ?? row.text) }\n',
  '    }).filter(Boolean)\n',
  MESSAGES_LINE
].join('')

const MESSAGES_RETURN_ANCHOR = '    return { updated: true, targets: updated, context: await fullContext(chat) }\n'
const MESSAGES_RETURN_NEXT = [
  '    ' + SNIPPET + ' 写成功后派发（仅 server；浏览器 UI 自己 eventsBetween，不重复下发）\n',
  '    // 同 operation 的 hook 内写（ownOperation）不递归派；外部并发已在写入**之前**被 busy 拒绝，\n',
  '    // 因此这里不存在"静默跳过外部事件"的情况。\n',
  '    if (lifecycleBefore.length > 0 && !ownOperation) {\n',
  '      for (const before of lifecycleBefore) {\n',
  '        const row = chat.messages[before.messageId]\n',
  '        if (!row) continue\n',
  '        const targetSwipe = Math.max(0, Number(row.swipeId) || 0)\n',
  '        const textAfter = str(row.swipes?.[targetSwipe] ?? row.sourceText ?? row.text)\n',
  "        const lifecycleEvent = targetSwipe !== before.swipeId ? 'MESSAGE_SWIPED' : (textAfter !== before.text ? 'MESSAGE_EDITED' : null)\n",
  '        // MESSAGE_UPDATED 不在作者的 eventsBetween 里，不自造。\n',
  '        if (lifecycleEvent) await serverExecution.dispatchLifecycleEvent({ sessionId: str(sessionId), chat, event: lifecycleEvent, args: [before.messageId] })\n',
  '      }\n',
  '    }\n',
  MESSAGES_RETURN_ANCHOR
].join('')

const RETURN_ANCHOR = [
  '  return Object.freeze({\n',
  '    context,\n',
  '    dispatchEvent,\n',
  '    settleMvuUpdate,\n'
].join('')

const RETURN_NEXT = [
  '  return Object.freeze({\n',
  '    context,\n',
  '    dispatchEvent,\n',
  '    settleMvuUpdate,\n',
  '    ' + SNIPPET + ' 服务端生命周期事件直调入口（主 seams 用；等价于经 dispatchEvent 路由的服务端侧）\n',
  '    dispatchServerEvent: input => serverExecution.dispatchLifecycleEvent(input),\n',
  '    ' + SNIPPET + ' 释放全部在飞绑定/runtime/定时器（options.ownExecution 也会注册同一回调）\n',
  '    dispose: () => serverExecution.disposeAll(),\n'
].join('')

const SERVER_EXECUTION_CONST = [
  '  ' + SNIPPET + ' 服务端执行消费者（变量核心 + 卡脚本钩子 + 生命周期事件路由）。\n',
  '  // project/isHostOwnedMvu 由作者树垫片 storage-server-execution.js 按 profile 锚点 DI；\n',
  '  // host 变更 API 在这里绑定，由 server-execution 按当前事务 eventId 调用（结算写只落事务草稿；\n',
  '  // 生命周期写走非事务 eventId=\'\'，与浏览器 RPC 同形）。\n',
  '  const serverExecution = createServerExecution({\n',
  '    readCardExtensions: options.readCardExtensions,\n',
  '    hasScripts: options.hasScripts,\n',
  '    cardScriptDispatchStore: options.cardScriptDispatchStore,\n',
  '    generateRaw: options.generateRaw,\n',
  '    // 生成时的可信上下文（不把 binding 暴露给脚本）：按需投影当前 operation 的上下文，\n',
  '    // fullContext 会 ensure 目标楼并做 scoped 投影 —— generateRaw 里读到的是 read-your-writes。\n',
  '    readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),\n',
  '    // 生成任务工厂与两个模型出口都由宿主注入（作者任务层 + 作者编译器）；runtime 只透传。\n',
  '    createGenerationTasks: options.createGenerationTasks,\n',
  '    generate: options.generate,\n',
  '    readResourceSnapshot: async (sessionId, chat) => ({ globalVariables: await options.globalVariables?.read?.(), character: typeof options.readCard === "function" ? await options.readCard(chat) : chat.cardDefinitionSnapshot, extensionSettings: await options.extensionSettings?.read?.(), presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || [] }),\n',
  "    resolveChat: typeof options.resolveChat === 'function' ? options.resolveChat : undefined,\n",
  '    host: { updateVariables, updateMessages, createMessages, getWorldbook, replaceWorldbook, updatePrompts,\n',
  '      saveExtensionSettings: async (sessionId, settings, expected) => {\n',
  '        if (settlementTransactions.has(str(sessionId))) throw new Error("MVU结算事务不允许写入跨存储正则设置")\n',
  '        return saveExtensionSettings(sessionId, settings, expected)\n',
  '      } }\n',
  '  })\n',
  '  // 适配器生命周期由宿主接管：main 的 index 注入 options.ownExecution（内部走 ctx.effect），\n',
  '  // 释放时把在飞 runtime/定时器/绑定一起清掉（不留下跨会话的沙箱资源）。\n',
  "  if (typeof options.ownExecution === 'function') options.ownExecution(() => serverExecution.disposeAll())\n"
].join('')

const REQUIRED_WHEN_APPLIED = [
  RUNTIME_MARKER,
  SHIM_SPECIFIER,
  'const serverExecution = createServerExecution({',
  'serverExecution.executeMvuUpdate({',
  'serverExecution.dispatchLifecycleEvent({',
  'if (browserScripts === 0) return {',
  'originalText,',
  'readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),',
  'createGenerationTasks: options.createGenerationTasks,',
  'generate: options.generate,',
  'presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || []',
  'preserveForeground: input.preserveForeground === true,',
  'const settledText = rewrittenText === null ? originalText : rewrittenText',
  'const lifecycleBefore = (Array.isArray(patches) ? patches : []).map(patch => {',
  'const ownOperation = serverExecution.isOwnOperation(serverOperationMeta)',
  'if (!ownOperation && serverExecution.isSessionBusy(str(sessionId))) {',
  "const lifecycleEvent = targetSwipe !== before.swipeId ? 'MESSAGE_SWIPED' : (textAfter !== before.text ? 'MESSAGE_EDITED' : null)",
  '!ownOperation && serverExecution.isSessionBusy(str(sessionId))',
  'if (lifecycleBefore.length > 0 && !ownOperation) {',  'options.ownExecution(() => serverExecution.disposeAll())',
  'dispose: () => serverExecution.disposeAll(),',
  'serverOwned: true',
  'host: { updateVariables, updateMessages, createMessages, getWorldbook, replaceWorldbook'
]
// 施缝后**必须消失**的浏览器执行器痕迹（漏一条即视为变换不完整）
const FORBIDDEN_WHEN_APPLIED = [
  'options.scriptDispatch.status?.(',
  "scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED'",
  'initializationRejected',
  'beforeDispatch',
  'const lazy = options.scriptDispatch.supportsContextProjection'
]

function replaceUnique(source, anchor, next, label) {
  const first = source.indexOf(anchor)
  if (first < 0) throw new Error('核心运行时接缝锚点未命中（' + label + '）：作者源码布局未知，拒绝猜测修补')
  if (source.indexOf(anchor, first + anchor.length) >= 0) throw new Error('核心运行时接缝锚点不唯一（' + label + '）：拒绝施缝')
  return source.slice(0, first) + next + source.slice(first + anchor.length)
}

// 旧代（v1 已施但没有作者2.5生成消费面）的**可升级**判据：这些必须都在，才允许走升级路径。
// 不在这里放宽 fail-loud —— 缺任一条仍按"不完整"抛错，绝不猜测修复。
const REQUIRED_OLD_GEN = [
  RUNTIME_MARKER,
  SHIM_SPECIFIER,
  'const serverExecution = createServerExecution({',
  'serverExecution.executeMvuUpdate({',
  'if (browserScripts === 0) return {',
  'readGenerationContext: binding => fullContext(binding.chat),',
  'generateRaw: options.generateRaw,',
  'serverOwned: true',
  'host: { updateVariables, updateMessages, createMessages, getWorldbook, replaceWorldbook'
]

/** 已施缝判定：标记 + 实现完整性（不完整即抛，不猜测修复）。 */
export function runtimeTransformApplied(source) {
  if (!source.includes(RUNTIME_MARKER)) return false
  const marks = source.split(RUNTIME_MARKER).length - 1
  if (marks !== 1) throw new Error('核心运行时接缝版本标记出现 ' + marks + ' 次（应为 1）：拒绝判断')
  // 旧代（缺作者2.5生成消费面）是**已知且可升级**的中间态：只要旧代实现齐全就放行给升级路径，
  // 升级分支会补齐新面；若连旧代都不齐全，继续按不完整抛错。
  const oldGenComplete = REQUIRED_OLD_GEN.every(required => source.includes(required))
  if (oldGenComplete && !source.includes('readGenerationContext: async binding => ({ chat: binding.chat')) {
    for (const forbidden of FORBIDDEN_WHEN_APPLIED) {
      if (source.includes(forbidden)) throw new Error('核心运行时接缝标记存在但浏览器执行器痕迹仍在（' + forbidden + '），拒绝判断')
    }
    return true
  }
  for (const required of REQUIRED_WHEN_APPLIED) {
    if (!source.includes(required)) throw new Error('核心运行时接缝标记存在但实现不完整（缺少 ' + required + '），拒绝猜测修复')
  }
  for (const forbidden of FORBIDDEN_WHEN_APPLIED) {
    if (source.includes(forbidden)) throw new Error('核心运行时接缝标记存在但浏览器执行器痕迹仍在（' + forbidden + '），拒绝判断')
  }
  return true
}

/**
 * 纯变换：返回施缝后的源码字符串；不读不写文件、不改作者文件。
 * @param source 作者树 tavern-script-host-adapter.js 的源码文本
 */
export function applyRuntimeTransform(source) {
  if (typeof source !== 'string' || source.trim() === '') throw new Error('核心运行时接缝需要作者源码字符串')
  if (runtimeTransformApplied(source)) {
    // 已装v1也升级加载期资源快照消费者，不能只靠旧marker跳过。
    // R3：旧缝的 readGenerationContext 是同步单值；统一升级为 {chat, helperContext}（宿主与
    // helper-generation-api 的 readGenerationContext(binding,config,kind) 同名契约）。
    if (!source.includes('readGenerationContext: async binding => ({ chat: binding.chat')) source = replaceUnique(source,
      '    readGenerationContext: binding => fullContext(binding.chat),',
      '    readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),', 'R3生成可信上下文{chat,helperContext}')
    // R4：旧缝没有生成任务工厂与作者 generate 出口；补上（缺一则作者2.5生成消费面半接线）。
    if (!source.includes('createGenerationTasks: options.createGenerationTasks,')) source = replaceUnique(source,
      '    generateRaw: options.generateRaw,',
      '    generateRaw: options.generateRaw,\n    createGenerationTasks: options.createGenerationTasks,\n    generate: options.generate,', 'R4生成任务工厂与作者generate出口')
    if (!source.includes('presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || []')) source = replaceUnique(source,
      '    readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),',
      '    readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),\n    readResourceSnapshot: async (sessionId, chat) => ({ globalVariables: await options.globalVariables?.read?.(), character: typeof options.readCard === "function" ? await options.readCard(chat) : chat.cardDefinitionSnapshot, extensionSettings: await options.extensionSettings?.read?.(), presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || [] }),', 'ESM全局变量同步快照')
    if (!source.includes('saveExtensionSettings: async (sessionId, settings, expected) =>')) source = replaceUnique(source,
      'host: { updateVariables, updateMessages, createMessages, getWorldbook, replaceWorldbook }',
      'host: { updateVariables, updateMessages, createMessages, getWorldbook, replaceWorldbook, updatePrompts,\n      saveExtensionSettings: async (sessionId, settings, expected) => {\n        if (settlementTransactions.has(str(sessionId))) throw new Error("MVU结算事务不允许写入跨存储正则设置")\n        return saveExtensionSettings(sessionId, settings, expected)\n      } }', 'Helper真实设置CAS写口')
    // 旧V2接线也传递同一取消信号；消费者在完成屏障和草稿回填前拒绝已取消操作。
    if (!source.includes('signal: input.signal,')) source = replaceUnique(source,
      '        sessionId, draft: transaction.draft, transaction, messageId, swipeId,',
      '        sessionId, draft: transaction.draft, transaction, messageId, swipeId,\n        signal: input.signal,', '服务端结算取消信号')
    return source
  }
  let out = source
  out = replaceUnique(out, IMPORT_ANCHOR,
    IMPORT_ANCHOR + RUNTIME_MARKER + ' 服务端执行消费者薄垫片（作者树文件由部署侧创建，实现归本包）\n' + SHIM_SPECIFIER + '\n',
    '① 顶部垫片 import')
  out = replaceUnique(out, DISPATCH_EVENT_ANCHOR, DISPATCH_EVENT_NEXT, '② dispatchEvent 事件路由（核心拒绝浏览器 / 生命周期服务端优先）')
  out = replaceUnique(out, LIFECYCLE_TAIL_ANCHOR, LIFECYCLE_TAIL_NEXT, '②b 纯计算卡立即回执（browserScripts===0 不下发）')
  out = replaceUnique(out, BUSY_ANCHOR, '', '③ 删执行前 busy 判断')
  out = replaceUnique(out, DISPATCH_ANCHOR, DISPATCH_NEXT, '④ MESSAGE_RECEIVED 浏览器派发 → 服务端执行')
  out = replaceUnique(out, RESTORE_ANCHOR, RESTORE_NEXT, '④b 正文槽回填（应用 BEFORE_MESSAGE_UPDATE 改写）')
  out = replaceUnique(out, MESSAGES_SIGNATURE_ANCHOR, MESSAGES_SIGNATURE_NEXT, '④c0 updateMessages 第 5 参内部令牌')
  out = replaceUnique(out, MESSAGES_CHAT_ANCHOR, MESSAGES_CHAT_NEXT, '④c1 写前并发闸 + 同 operation 判定')
  out = replaceUnique(out, MESSAGES_ANCHOR, MESSAGES_NEXT, '④c updateMessages 记目标楼前像')
  out = replaceUnique(out, MESSAGES_RETURN_ANCHOR, MESSAGES_RETURN_NEXT, '④d 写成功后派 MESSAGE_SWIPED/EDITED（仅 server）')
  out = replaceUnique(out, SETTLE_ANCHOR, SERVER_EXECUTION_CONST + SETTLE_COMMENT + '  async function settleMvuUpdate(input = {}) {\n', '⑤ 构造 serverExecution')
  out = replaceUnique(out, RETURN_ANCHOR, RETURN_NEXT, '⑥ 导出面加 dispatchServerEvent / dispose')
  // 自证：变换结果必须同时满足「实现齐全」与「浏览器痕迹清零」
  if (!runtimeTransformApplied(out)) throw new Error('核心运行时接缝变换后自证失败：实现不完整')
  for (const forbidden of FORBIDDEN_WHEN_APPLIED) {
    if (out.includes(forbidden)) throw new Error('核心运行时接缝变换后仍有浏览器执行器痕迹（' + forbidden + '）')
  }
  return out
}
