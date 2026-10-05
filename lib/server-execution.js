// dsh-tavern 服务端 MVU 执行消费者（B2.4 统一 seams 的 server-compute 半边）
//
// 作用：把「变量核心执行 + 卡脚本钩子」从浏览器执行器搬进服务端进程，由作者树
// `lib/domain/tavern-script-host-adapter.js` 的 settleMvuUpdate（事务结算）直接调用。
// 作者树只多一行薄 import（见 deploy/core-runtime-transform.mjs），实现归本包所有。
//
// 依赖全部由调用方注入（DI），本模块不 import 作者代码：
//   · project —— 作者的 projectTavernHelperScripts（由作者树垫片 storage-server-execution.js
//     按 profile 锚点绑定）；isHostOwnedMvu 同为作者导出（MVU 核心由宿主跑，不进沙箱）。
//   · classify —— **本模块自有**（导出 classifyCardScript）：B 2.4 的作者 helper-scripts
//     只有 isHostOwnedMvu / projectTavernHelperScripts / hasTavernScriptRuntime，
//     **没有 classifyCardScript**，因此这里不能 import 不存在的符号。判定规则保持
//     「纯计算及ESM进入服务端，DOM与浏览器独有facade留浏览器」；模块图运行前复核依赖分类
//     （宁可在服务端跑纯计算脚本，也不把变量核心丢回浏览器）。
//   · host —— Host 变更 API（updateVariables / updateMessages / createMessages /
//     getWorldbook / replaceWorldbook）；本模块按**当前事务 eventId** 绑定调用，
//     写入落在事务草稿里，由作者侧 validation / effect / CAS 协议统一提交。
//   · executeCommand —— 变量核心（缺省动态 import 本包 `./mvu/mvu-update-core.js`）；
//     签名 (text, variables, eventEmitter) —— eventEmitter 是**本次操作的局部事件出口**，
//     核心用它替代全局 emit（STARTED / COMMAND_PARSED(+_for_zod) / SINGLE_VARIABLE_UPDATED /
//     ENDED 全部只投当前 runtime），因此 hook 必须在命令**之前**注册好。
//   · createRuntime —— 卡脚本运行时（缺省本包 `createCardScriptRuntime`，每绑定新实例）。
//   · readCardExtensions / hasScripts / cardScriptDispatchStore / generateRaw —— 作者树的
//     读卡扩展、脚本存在性判定、DOM 标记存储、LLM 生成接线。
//     加载前异步预取全局/人物/正则快照，Helper读口同步返回脱离数据；缺资源不伪成Promise或空数据。
//
// 与 A 线实现的三处刻意不同（本轮要求）：
//   ① **不吞错误**：钩子以 strict 派发，钩子异常/DOM 探针/异步($ 回调)异常一律向上抛，
//      结算失败绝不返回"成功"、也不继续提交；未接线的宿主 API **抛明确信息**（不 no-op 伪成功）。
//   ② **不用固定 sleep**：脚本钩子是异步注册的，这里用**有界轮询**等待注册完成
//      （累计预算 hookLoadBudgetMs，默认 300ms；注册到就立刻返回），无 A 的 60/320/6500ms 盲等。
//   ③ **按 session+operation 隔离**：绑定键 = (sessionId, transaction.eventId)，没有模块级
//      cardPath 缓存 ⇒ 同一张卡的另一个 chat / 另一个结算事件拿不到别人的 runtime 与写窗口；
//      关闭后的迟到写一律拒绝（含 await 期间被替换的窗口）。
//
// 明确边界（现状，别当成缺口也别当成已实现）：
//   · **MESSAGE_RECEIVED 已接服务端**（2026-10-04 落地）：走 executeMvuUpdate 的内联派发 ——
//     core 成功、BEFORE_MESSAGE_UPDATE 成功之后、**提交之前**，对**投影后的卡钩子**派发一次，
//     随后立刻走完成屏障（短延迟回调 + 未 await 的写，有界预算）。回调读到的是 core 更新后的
//     权威树（binding.activeData 被 core 就地改过）。它不是"提交后的延迟兜底"：那些
//     A 线 1200ms / 6500ms 的固定 sleep 仍然**不做** —— 作者所有权在 settleMvuUpdate 的 finally
//     里随事务释放，服务端没有"提交后仍持有作者写权"的安全窗口，提交后写回会造出无法归属的迟到写。
//     （旧版此处写"未实现"是陈旧表述，已按实际实现更正。）
//   · **普通生命周期事件已接服务端**（本轮）：变换后的 `dispatchEvent` 先跑 server-compute 钩子，
//     `browserScripts > 0`（真投影同判据）才再下发浏览器；`updateMessages` 非事务写成功后按
//     before/after 派 MESSAGE_SWIPED / MESSAGE_EDITED（**仅 server**，浏览器 UI 自有 eventsBetween）。
//     并发语义：外部并发写在**写之前**被 busy 拒绝（`SERVER_EXECUTION_BINDING_BUSY`）；同 operation
//     的 hook 内写凭本模块签发的令牌（`isOwnOperation`，WeakSet 身份识别）放行但不递归派事件。
//   · DOM / browser-ui 脚本不在服务端执行：命中即标记 card-script-dispatch（下次分派自动排除），
//     本次结算**响亮失败**（不静默提交半结果）；变量核心不会重新下发给浏览器执行。
import { createCardScriptRuntime, isDomProbeError } from './mvu/mvu-card-runtime.js'
import { createTavernHelperExtensions } from './tavern-helper-api.js'
import { createTavernRegexApi } from './tavern-regex-api.js'
import { createHelperMessageReader, projectRawHelperFloor } from './helper-message-reader.js'
import { createHelperGenerationApi, HELPER_GENERATION_EVENTS } from './helper-generation-api.js'
import { createHelperReadonlyApi } from './helper-readonly-api.js'
import { SANDBOX_ERRORS, wrapGenerateRaw } from './sandbox-policy.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from './rollback-barrier.js'

/** 服务端派发的事件名（pinned upstream src/variable_def.ts variable_events）。 */
export const SERVER_EXECUTION_EVENTS = Object.freeze({
  VARIABLE_INITIALIZED: 'mag_variable_initialized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
  SINGLE_VARIABLE_UPDATED: 'mag_variable_updated'
})

/** 错误码（测试与部署侧按码断言，不按文案猜）。 */
export const SERVER_EXECUTION_ERRORS = Object.freeze({
  badInput: 'SERVER_EXECUTION_BAD_INPUT',
  busy: 'SERVER_EXECUTION_BINDING_BUSY',
  lateWrite: 'SERVER_EXECUTION_LATE_WRITE',
  missingDependency: 'SERVER_EXECUTION_MISSING_DEPENDENCY',
  unsupported: 'SERVER_EXECUTION_UNSUPPORTED_API',
  coreFailed: 'SERVER_EXECUTION_CORE_FAILED',
  hookFailed: 'SERVER_EXECUTION_HOOK_FAILED',
  timeout: 'SERVER_EXECUTION_HOOK_TIMEOUT',
  disposed: 'SERVER_EXECUTION_RUNTIME_DISPOSED',
  domProbe: 'SERVER_EXECUTION_DOM_PROBE',
  loadFailed: 'SERVER_EXECUTION_LOAD_FAILED',
  cancelled: 'SERVER_EXECUTION_CANCELLED'
})

// 脚本分派判定（本包自有，不依赖作者树是否有 classifyCardScript —— B 2.4 没有）。
// 浏览器独有的 SillyTavern / getContext / variables.local 必须留浏览器，不伪造服务端facade。
// 纯计算ESM使用原生VM模块；DOM/browser facade留浏览器，变量核心/派生计算不整体退回前端。
// 静态判据不做任意动态名称/反射的数据流分析；DOM漏判仍由运行期探针响亮失败并持久标记。
const DOM_TOKENS = /\b(document\s*\.|querySelector(?:All)?|getElementById|getElementsByClassName|createElement|createTextNode|innerHTML|outerHTML|insertAdjacentHTML|addEventListener|classList|getComputedStyle|matchMedia)\b/
const ESM_TOKENS = /(^\s*(?:import[\s{("']|export\s))|\bimport\s*\(/m
const DISPLAY_APIS = new Set(['getMessageId','getIframeName','retrieveDisplayedMessage','formatAsDisplayedMessage'])

// 仅识别静态facade引用，不引入解析器依赖。跳过注释/普通字符串，避免MVU描述文字误迁端；
// 模板插值仍扫描（模板正文中的同名词保守留浏览器）。标识符引用覆盖别名/解构/可选链，
// 方括号字面量覆盖 window['getContext'] / window['SillyTavern'] / variables['local']。
// 动态拼接、eval与反射不是此静态边界的兼容承诺。
function usesBrowserFacade(src) {
  const tokens = []
  const lex = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_$][\w$]*|\?\.|[^\s]/g
  for (const match of src.matchAll(lex)) {
    const value = match[0]
    if (value.startsWith('//') || value.startsWith('/*')) continue
    // 模板内URL的 // 不是注释；保守扫描整段模板，不能漏掉 ${getContext()}。
    if (value[0] === '`') {
      if (/\b(?:SillyTavern|getContext|getMessageId|getIframeName|retrieveDisplayedMessage|formatAsDisplayedMessage)\b|\bvariables\b[\s\S]*\blocal\b/.test(value)) return true
      continue
    }
    const quoted = value[0] === '"' || value[0] === "'"
    tokens.push({ value: quoted ? value.slice(1, -1) : value, quoted })
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.value === 'SillyTavern' || token.value === 'getContext' || DISPLAY_APIS.has(token.value)) {
      if (!token.quoted || (tokens[index - 1]?.value === '[' && tokens[index + 1]?.value === ']')) return true
    }
    if (token.value !== 'variables') continue
    const quotedProperty = token.quoted && tokens[index - 1]?.value === '[' && tokens[index + 1]?.value === ']'
    if (token.quoted && !quotedProperty) continue
    const after = index + (quotedProperty ? 2 : 1)
    const next = tokens[after], property = tokens[after + 1]
    if (['.', '?.'].includes(next?.value) && !property?.quoted && property?.value === 'local') return true
    const bracket = next?.value === '?.' ? after + 1 : after
    if (tokens[bracket]?.value === '[' && tokens[bracket + 1]?.quoted
      && tokens[bracket + 1].value === 'local' && tokens[bracket + 2]?.value === ']') return true
  }
  return false
}

/** 脚本分类：'empty' | 'esm' | 'browser-ui' | 'server-compute'（供本模块与主 seams 共用同一判据）。 */
export function classifyCardScript(code) {
  const src = str(code)
  if (src.trim() === '') return 'empty'
  // UI/facade优先：带import的界面模块也不能误投服务端。
  if (DOM_TOKENS.test(src) || usesBrowserFacade(src)) return 'browser-ui'
  if (ESM_TOKENS.test(src)) return 'esm'
  return 'server-compute'
}

/**
 * **唯一判据**：服务端执行server-compute/esm且未被DOM标记的；界面留浏览器。
 * kind ∈ 'server-compute' | 'browser-ui' | 'esm' | 'empty'；DOM 标记存储里登记过的脚本
 * **一律按 browser-ui**（即使静态特征看不出 DOM）—— 这样"服务端排除"与"浏览器纳入"用同一条
 * 规则，不会出现两端都不跑；宿主自带的 MVU 核心由 isHostOwnedMvu 单独排除。
 */
export function effectiveScriptKind(script, deps = {}) {
  const classify = typeof deps.classify === 'function' ? deps.classify : classifyCardScript
  const code = str(script && script.content)
  const id = str(script && script.id)
  const store = deps.store
  const cardPath = str(deps.cardPath)
  if (store && cardPath !== '' && typeof store.lookupScript === 'function' && store.lookupScript(cardPath, id, code)) return 'browser-ui'
  return classify(code)
}

/**
 * 从作者 projectTavernHelperScripts 的产出里选出**服务端要跑**的脚本（与 storageBrowserScripts 同判据）。
 * @param scripts 作者 project 产出的 scripts（[{id,name,content}]）
 * @param deps { classify?, isHostOwnedMvu?, store?, cardPath? }
 * @returns [{ id, name, code }]
 */
export function projectServerScripts(scripts, deps = {}) {
  const owned = typeof deps.isHostOwnedMvu === 'function' ? deps.isHostOwnedMvu : null
  const out = []
  for (const script of Array.isArray(scripts) ? scripts : []) {
    const code = str(script && script.content)
    const id = str(script && script.id)
    const name = str(script && script.name) || id
    if (owned && owned({ id, name, content: code })) continue
    const kind = effectiveScriptKind({ id, name, content: code }, deps)
    if (kind !== 'server-compute' && kind !== 'esm') continue
    out.push({ id, name, code, ...(kind === 'esm' ? { kind } : {}) })
  }
  return out
}

/**
 * 浏览器侧脚本（view / helperRuntime 过滤 + 生命周期是否需下发浏览器，**与 projectServerScripts 同判据**）：
 * 只返回browser-ui及已被DOM标记的脚本；server-compute/计算ESM与宿主MVU核心都不返回。
 * @param scripts 作者 projectTavernHelperScripts 的 scripts（[{id,name,content}]）
 * @param deps { classify?, isHostOwnedMvu?, store?, cardPath? } —— view 侧请把**真实的 DOM 标记存储**
 *        与 cardPath 一起传入（否则被标记的脚本会两端都不跑）
 * @returns [{ id, name, content, kind: 'browser-ui' }]
 */
export function storageBrowserScripts(scripts, deps = {}) {
  const owned = typeof deps.isHostOwnedMvu === 'function' ? deps.isHostOwnedMvu : null
  const out = []
  for (const script of Array.isArray(scripts) ? scripts : []) {
    const code = str(script && script.content)
    const id = str(script && script.id)
    const name = str(script && script.name) || id
    if (owned && owned({ id, name, content: code })) continue
    const kind = effectiveScriptKind({ id, name, content: code }, deps)
    if (kind === 'browser-ui') out.push({ id, name, content: code, kind })
  }
  return out
}

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  if (value === undefined) return undefined
  try { return structuredClone(value) } catch { return JSON.parse(JSON.stringify(value)) }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 变量树合并（insertOrAssignVariables 语义）：只合对象，数组与标量取新值。 */
function mergeVariables(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...(isObject(base) ? base : {}) }
  for (const [key, value] of Object.entries(isObject(patch) ? patch : {})) {
    const current = out[key]
    out[key] = isObject(value) && isObject(current) ? mergeVariables(current, value) : (value === undefined ? current : value)
  }
  return out
}

/** 楼层号归一：undefined/'latest'/负数 与酒馆助手同义。 */
function resolveMessageId(messages, value, fallback) {
  const raw = value === undefined || value === null || value === 'latest' ? -1 : Number(value)
  const messageId = raw < 0 ? messages.length + raw : raw
  if (!Number.isInteger(messageId) || messageId < 0 || messageId >= messages.length) return fallback
  return messageId
}

/**
 * 创建服务端执行消费者。
 * @param options 见文件头 DI 清单；`host.updateVariables` 是硬依赖（构造期即校验）。
 */
export function createServerExecution(options = {}) {
  const pendingHostCalls = new Map()
  const hostSource = options.host || {}
  // 代理壳不以冻结 Host 为 target，包装函数不会违反 non-configurable 属性不变量。
  const host = new Proxy({}, {
    get(_target,key){
      // 同步读取保留原契约；所有已发出的异步Host写独立于runtime释放可等待。
      const value=hostSource[key]
      if(typeof value!=='function')return value
      return (...args)=>{
        const result=value.apply(hostSource,args)
        if(!result || typeof result.then!=='function')return result
        const id=str(args[0]),task=Promise.resolve(result)
        if(!pendingHostCalls.has(id))pendingHostCalls.set(id,new Set())
        pendingHostCalls.get(id).add(task)
        task.finally(()=>{const set=pendingHostCalls.get(id);set?.delete(task);if(!set?.size)pendingHostCalls.delete(id)}).catch(()=>{})
        return task
      }
    },
  })
  if (typeof host.updateVariables !== 'function') throw new Error('服务端执行缺少依赖: host.updateVariables')
  const project = options.project
  const classify = typeof options.classify === 'function' ? options.classify : classifyCardScript
  const isHostOwnedMvu = typeof options.isHostOwnedMvu === 'function' ? options.isHostOwnedMvu : null
  const createRuntime = typeof options.createRuntime === 'function' ? options.createRuntime : createCardScriptRuntime
  const logger = options.logger || console
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 8000)
  const loadBudgetMs = Math.max(0, Number(options.hookLoadBudgetMs) || 300)
  const loadTickMs = Math.max(1, Number(options.hookLoadTickMs) || 5)
  const loadMaxTurns = Math.max(1, Number(options.hookLoadMaxTurns) || 80)
  // 有界短定时器屏障的 ceiling（>0 才启用）。**沿 V1 的 3000**（V1 `MVU_WORK_EVENT_STICKY_MS = 3000`）：
  // 只纳**短**延迟（实证的两张卡是 250ms 防抖 / 1500ms 兜底，均在 3000 内）；超 ceiling 的长延迟一律
  // 不接管、不盲等（`setInterval` / 长 `setTimeout` 也不会 keepalive 本进程）。
  const timerCeilingMs = Math.min(3000, Math.max(0, Number(options.timerCeilingMs ?? 3000)))
  // drain 预算：有界，且**与 ceiling 同值（3000）**。超预算 ⇒ 抛错、不提交（不返回半成功）。
  const timerDrainBudgetMs = Math.max(1, Math.min(Number(options.timerDrainBudgetMs) || 3000, 3000))

  // 绑定表：key = sessionId + eventId。没有 cardPath 索引，绝不跨 chat/session 复用。
  const bindings = new Map()
  const bySession = new Map()
  // 生命周期run注册独立于binding：disposeSession提前删binding也不能丢失在飞await。
  const pendingRuns = new Map()
  function trackRun(input, execute) {
    const id=str(input.sessionId)
    if((rollbackBarrier.has(id)||rollbackSchedulingBarrier.has(id)))return Promise.reject(fail(SERVER_EXECUTION_ERRORS.busy,'物理回退期间禁止新服务端脚本run'))
    const task=execute(input)
    if(!pendingRuns.has(id))pendingRuns.set(id,new Set())
    pendingRuns.get(id).add(task)
    task.finally(()=>{const set=pendingRuns.get(id);set?.delete(task);if(!set?.size)pendingRuns.delete(id)}).catch(()=>{})
    return task
  }
  async function whenIdle(sessionId) {
    const id=str(sessionId)
    while(pendingRuns.get(id)?.size || pendingHostCalls.get(id)?.size)await Promise.allSettled([...(pendingRuns.get(id)||[]),...(pendingHostCalls.get(id)||[])])
  }
  let coreModule = null
  let closedRuntimes = 0
  // 标准 dispose 后的终止位：**拒绝新工作**（只清表的话 dispose 之后还能开新绑定，且在飞
  // await 结束后仍会写回目标楼 ⇒ 迟到提交）。disposeSession 只清会话，不置终止位。
  let terminated = false

  const keyOf = (sessionId, eventId) => str(sessionId) + '\u0000' + str(eventId)

  // operation 令牌：只由本模块签发（WeakSet 按对象身份识别）。宿主写层据此区分
  // 「hook 内同 operation 写」（跳过递归派发）与「外部并发写」（写之前就 busy 拒绝）——
  // **绝不把外部传入的任意参数当授权**：不是我们签发的对象一律不认。
  const issuedOperationTokens = new WeakSet()
  function operationMeta(binding) {
    const token = { serverOperation: binding.key }
    issuedOperationTokens.add(token)
    return token
  }
  function isOwnOperation(token) {
    // 只验证**来源**（本模块签发的对象身份）；"此刻是否在 operation 中间"由调用方用
    // isSessionBusy 单独判定 —— 两个条件都成立才放行/跳递归。
    return Boolean(token) && issuedOperationTokens.has(token)
  }

  async function defaultExecuteCommand(text, variables, eventEmitter) {
    if (coreModule === null) coreModule = await import('./mvu/mvu-update-core.js')
    // 第 3 参 = 本次操作的局部事件出口（core 内所有 eventEmit 只投给它，不走全局注册表）。
    return await coreModule.updateVariables(text, variables, eventEmitter)
  }

  const executeCommand = typeof options.executeCommand === 'function' ? options.executeCommand : defaultExecuteCommand

  function openBinding(input) {
    if(rollbackBarrier.has(str(input.sessionId))||rollbackSchedulingBarrier.has(str(input.sessionId)))throw fail(SERVER_EXECUTION_ERRORS.busy,'物理回退期间禁止新服务端脚本绑定')
    const key = keyOf(input.sessionId, input.eventId)
    // 标准 dispose 后**拒绝新工作**：只清表不置终止位的话，dispose 之后还能开新绑定，
    // 而且已经在飞的 await 结束后仍会写回目标楼 ⇒ 迟到提交。
    if (terminated) throw fail(SERVER_EXECUTION_ERRORS.disposed, '服务端执行已释放（disposeAll），拒绝新工作')
    if (bindings.has(key)) throw fail(SERVER_EXECUTION_ERRORS.busy, '该会话的这次 MVU 结算已有服务端执行绑定在飞（session+event 唯一）')
    const binding = {
      key,
      sessionId: str(input.sessionId),
      eventId: str(input.eventId),
      operationId: str(input.operationId),
      messageId: Number(input.messageId),
      swipeId: Number(input.swipeId),
      chat: input.chat,
      // **唯一权威变量树**：读与写都走这一个对象（core 持有的也是它）。null = 绑定无树
      // （生命周期事件），此时回落到聊天快照里当前楼层的树。
      activeData: input.activeData === undefined ? null : input.activeData,
      // 传给 Host 变更 API 的事件身份：结算=事务 eventId（写入落事务草稿）；生命周期=''（非事务，
      // 与浏览器路径的 updateTavernHelperVariables RPC 同形 —— 适配器按同一规则处理）。
      hostEventId: input.hostEventId === undefined ? str(input.eventId) : str(input.hostEventId),
      // 生成在飞计数：runtime 自建并通过 activityHolder.current 交回；同时把**同一个对象**
      // 作为 activity 注入（主 runtime 实际交付 API：activity 注入即共享，holder 只是回填锚点）。
      activity: { pending: 0 },
      activityHolder: { current: null },
      timers: new Map(),          // handle → 唤醒函数（closeBinding 必须唤醒等待方）
      asyncErrors: [],
      pendingWrites: new Set(),
      // 本次 run 的"完成屏障"登记表：tracked thenable（Helper 返回但脚本没 await 的写）。
      // **不写回 V1**、不新造框架：与 pendingWrites 同形（Set + 自摘），只是**覆盖全部 thenable**
      // 而不只是我们自己构造的那几个（见 makeHostApi 末尾的统一 wrap）。
      pendingTasks: new Set(),
      runtime: null,
      closed: false,
      // **取消信号**（可选）：`input.signal` 是调用方的取消出口。abort ⇒ binding.cancelled 置位
      // 并**立刻唤醒**等待方（与 closeBinding 同一路：等待钩子注册/屏障的 await 不能挂死），
      // 之后的 `assertOpen` 一律拒绝提交（不写回目标楼、不返回成功回执）。
      signal: input.signal && typeof input.signal === 'object' && typeof input.signal.addEventListener === 'function' ? input.signal : null,
      cancelled: false,
      abortListener: null,
      record: typeof input.record === 'function' ? input.record : null
    }
    if (binding.signal) {
      const onAbort = () => {
        binding.cancelled = true
        // 同 closeBinding：唤醒等待方，否则在飞的 await 会一直等到自己的预算耗尽。
        for (const [timer, wake] of binding.timers) {
          clearTimeout(timer)
          try { wake() } catch { /* 唤醒失败不影响取消 */ }
        }
        binding.timers.clear()
        // **不在这里 closeBinding**：绑定要留着让在飞的 run 走到自己的 assertOpen 得到
        // SERVER_EXECUTION_CANCELLED（而不是被当成"窗口关闭"的 lateWrite），由它的 finally 收尾。
        try { binding.runtime?.dispose?.() } catch { /* 释放唤醒 runtime，取消身份仍由 assertOpen 判断 */ }
      }
      binding.abortListener = onAbort
      if (binding.signal.aborted === true) binding.cancelled = true
      else binding.signal.addEventListener('abort', onAbort, { once: true })
    }
    bindings.set(key, binding)
    const set = bySession.get(binding.sessionId) || new Set()
    set.add(key)
    bySession.set(binding.sessionId, set)
    return binding
  }

  function closeBinding(binding) {
    binding.closed = true
    binding.helperGeneration?.dispose()
    // 取消监听必须摘掉（否则长命 signal 上会积累悬空监听器 ⇒ 泄漏）；
    // 摘监听**不改** binding.cancelled —— 已取消这一事实由 assertOpen 继续拒提交。
    if (binding.abortListener && binding.signal) {
      try { binding.signal.removeEventListener('abort', binding.abortListener) } catch { /* 摘监听失败不影响释放 */ }
      binding.abortListener = null
    }
    // 等待钩子注册的定时器必须**唤醒**等待方（只 clearTimeout 会把 await 永久挂住），
    // 唤醒后循环按 binding 已关闭退出并抛迟到/释放错误。
    for (const [timer, wake] of binding.timers) {
      clearTimeout(timer)
      try { wake() } catch { /* 唤醒失败不影响释放 */ }
    }
    binding.timers.clear()
    if (binding.runtime) {
      try { binding.runtime.dispose?.(); closedRuntimes += 1 } catch (error) {
        logger?.warn?.('[server-execution] 释放卡脚本运行时失败:', str(error && error.message || error))
      }
      binding.runtime = null
    }
    bindings.delete(binding.key)
    const set = bySession.get(binding.sessionId)
    if (set) {
      set.delete(binding.key)
      if (set.size === 0) bySession.delete(binding.sessionId)
    }
  }

  const bindingIsOpen = binding => Boolean(binding) && binding.closed !== true && bindings.get(binding.key) === binding

  /** 当前楼层的树（**每次现取**：work.touch 会把楼层对象整体 structuredClone 掉，
   *  缓存 target 引用会写到被丢弃的旧对象上 ⇒ 丢写）。 */
  function slotTreeOf(binding) {
    const messages = Array.isArray(binding.chat?.messages) ? binding.chat.messages : []
    const message = messages[binding.messageId]
    if (!message) return null
    if (!Array.isArray(message.variables)) message.variables = []
    while (message.variables.length <= binding.swipeId) message.variables.push({})
    return message.variables[binding.swipeId]
  }

  /** 当前楼层对象（**每次现取**：work.touch 会整体 structuredClone 掉楼层对象）。 */
  function slotMessage(binding) {
    const messages = Array.isArray(binding.chat?.messages) ? binding.chat.messages : []
    const message = messages[binding.messageId]
    if (!message) throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端执行的目标楼层已不存在（草稿被替换？）')
    return message
  }

  /** 把新树的内容**就地**写进权威对象（保持对象身份：core 的引用不能失效）。 */
  function adoptTreeInPlace(target, source) {
    if (!isObject(target) || !isObject(source) || target === source) return target
    for (const key of Object.keys(target)) delete target[key]
    for (const [key, value] of Object.entries(source)) target[key] = value
    return target
  }

  function assertOpen(binding) {
    if (!bindingIsOpen(binding)) {
      throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '卡脚本写窗口已关闭（本次结算已结束），迟到写入已拒绝')
    }
    // 取消信号（input.signal）也是窗口的一部分：已 abort ⇒ 与"窗口关闭"同类，**拒绝提交**。
    // 两侧都查（binding.cancelled 由监听器置位；signal.aborted 兜住监听器来不及跑的时刻），
    // 这样 core await 之后、完成屏障之后都不会再写回目标楼。
    if (binding.cancelled === true || binding.signal?.aborted === true) {
      throw fail(SERVER_EXECUTION_ERRORS.cancelled, '本次结算已被取消（signal.aborted），结果作废、不提交')
    }
  }

  async function recordFor(binding, stage, details) {
    try { await binding.record?.(stage, details) } catch { /* 诊断永不改变结算行为 */ }
  }

  // ---------- 卡脚本宿主 API（按绑定构造；窗口关闭即整份失效） ----------
  function makeHostApi(binding) {
    const bindingOf = () => (bindingIsOpen(binding) ? binding : null)
    const activityOf = () => binding.activityHolder.current || binding.activity
    // wrapGenerateRaw 的 activity 必须是 **runtime 的那个计数对象**（activityHolder.current，
    // 缺省即 binding.activity）：hostApi 在 runtime 之前构造，因此按"当前对象身份"惰性绑定/重绑，
    // 绝不固定成另一个对象（否则在飞计数永远为 0、生成期间预算不放宽）。
    let rawWrapper = null
    let rawWrapperFor = null
    const generateRaw = config => {
      const activity = activityOf()
      if (rawWrapper === null || rawWrapperFor !== activity) {
        rawWrapper = wrapGenerateRaw({ bindingOf, options, activity, str, isClosed: candidate => candidate.closed === true })
        rawWrapperFor = activity
      }
      return rawWrapper(config)
    }
    const requireOpen = () => {
      assertOpen(binding)
      return binding
    }
    const messagesOf = chat => (Array.isArray(chat?.messages) ? chat.messages : [])
    const unsupported = name => () => {
      throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本调用了服务端未接线的宿主 API "' + name + '"：本包不提供该能力，不做空操作伪成功')
    }
    const variablesOf = (option = {}) => {
      const current = bindingOf()
      if (!current) throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '卡脚本读窗口已关闭（本次结算已结束）')
      const type = (option && option.type) || 'message'
      const chat = current.chat
      if (type === 'global' || type === 'character') {
        const value = current.resourceSnapshot?.[type + 'Variables']
        if (value === undefined) throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本同步读取' + type + '变量缺少加载期真实快照：不返回Promise或其他scope假数据')
        return cloneJson(value)
      }
      if (!['message', 'chat', 'script'].includes(type)) throw fail(SERVER_EXECUTION_ERRORS.unsupported, '不支持变量scope：' + type)
      if (type === 'chat') return cloneJson(isObject(chat.variables) ? chat.variables : {})
      if (type === 'script') {
        const id = str(option && option.script_id || current.runtime?.currentScriptId).trim()
        const saved = chat.tavernHelperScriptVariables
        return cloneJson(isObject(saved?.[id]) ? saved[id] : {})
      }
      const messages = messagesOf(chat)
      const wanted = option && option.message_id !== undefined ? option.message_id : current.messageId
      const messageId = resolveMessageId(messages, wanted, current.messageId)
      if (messageId < 0 || messageId >= messages.length) return {}
      const message = messages[messageId]
      const swipeId = option && Object.hasOwn(option, 'swipe_id')
        ? Math.max(0, Number(option.swipe_id) || 0)
        : (current.eventId === 'opening-init' && messageId === current.messageId ? current.swipeId : Math.max(0, Number(message?.swipeId) || 0))
      // **当前楼读的就是权威树**（core 正在改的那一个对象）——不再读绑定建立时的旧快照，
      // 否则钩子读到的树落后于 core/其它钩子的写入。
      if (messageId === current.messageId && swipeId === current.swipeId && current.activeData) {
        return cloneJson(isObject(current.activeData) ? current.activeData : {})
      }
      const tree = Array.isArray(message?.variables) ? message.variables[swipeId] : undefined
      return cloneJson(isObject(tree) ? tree : {})
    }
    const replaceVariables = async (variables, option = {}) => {
      const current = requireOpen()
      const type = (option && option.type) || 'message'
      const projected = { type }
      let targetMessageId = current.messageId
      let targetSwipeId = current.swipeId
      if (type === 'message') {
        // 归一：'latest' / 负数 / 越界 与酒馆助手同义（此前原样透传 ⇒ 与当前楼比较永远不等，
        // 既可能漏采纳、也可能把别的楼层/别的 swipe 的树当成当前楼的树采纳）。
        const messages = messagesOf(current.chat)
        const wanted = option && option.message_id !== undefined ? option.message_id : current.messageId
        targetMessageId = resolveMessageId(messages, wanted, current.messageId)
        projected.message_id = targetMessageId
        const message = messages[targetMessageId]
        targetSwipeId = option && option.swipe_id !== undefined
          ? Math.max(0, Number(option.swipe_id) || 0)
          : (current.eventId === 'opening-init' && targetMessageId === current.messageId ? current.swipeId : Math.max(0, Number(message?.swipeId) || 0))
        projected.swipe_id = targetSwipeId
      } else if (type === 'script') {
        projected.script_id = str(option && option.script_id || current.runtime?.currentScriptId).trim()
        if (!projected.script_id) throw fail(SERVER_EXECUTION_ERRORS.unsupported, '脚本变量写入缺少当前脚本身份')
      }
      // Host 变更 API 绑定当前事务：eventId 必须匹配，写入落事务草稿并计入 work dirty（CAS/校验都在里面）。
      const slotBefore = type === 'message' ? slotTreeOf(current) : null
      const receipt = await host.updateVariables(current.sessionId, projected, isObject(variables) ? variables : {}, undefined, current.hostEventId)
      // **await 之后先确认窗口还开着**：dispose/结算收尾期间的迟到返回不许再改写权威树（迟到采纳）。
      assertOpen(current)
      // 只有"写的就是本绑定的当前楼当前 swipe"时才把结果并回权威对象；其它楼层/swipe 的写按原样
      // 交给宿主结果，不污染本次结算的权威树。
      if (type === 'message' && current.activeData && targetMessageId === current.messageId && targetSwipeId === current.swipeId) {
        const next = isObject(variables) ? variables : {}
        const slotAfter = slotTreeOf(current)
        // 宿主**替换**了槽位对象（适配器事务写就是这种）⇒ 以宿主的最终结果为准；
        // 否则（宿主原地写/未写）⇒ 脚本这次 replace 的内容直接落权威树。两种情况都把槽位指回
        // 权威对象，保证 core 的引用一直有效、且不丢任何一次写。
        const hostReplaced = Boolean(slotAfter) && slotAfter !== slotBefore && slotAfter !== current.activeData
        adoptTreeInPlace(current.activeData, hostReplaced ? slotAfter : next)
        slotMessage(current).variables[current.swipeId] = current.activeData
      }
      if (type === 'global' || type === 'character') current.resourceSnapshot[type + 'Variables'] = cloneJson(variables)
      if (type === 'script' && receipt?.stale !== true) {
        current.chat.tavernHelperScriptVariables ||= {}
        current.chat.tavernHelperScriptVariables[projected.script_id] = cloneJson(variables)
      }
      return receipt
    }
    const chatMessages = (current, range) => {
      if (typeof range === 'string' && /^-?\d+-(?:-?\d+|\{\{lastMessageId\}\})$/.test(range)) {
        const match = range.match(/^(-?\d+)-(-?\d+|\{\{lastMessageId\}\})$/)
        range = [Number(match[1]), match[2] === '{{lastMessageId}}' ? current.chat.messages.length - 1 : Number(match[2])]
      }
      const messages = messagesOf(current.chat)
      let indices
      if (range === undefined || range === null) indices = [current.messageId]
      else if (range === 'all') indices = messages.map((_value, index) => index)
      else if (Array.isArray(range)) {
        const start = Math.max(0, Number(range[0]) || 0)
        const end = Math.min(messages.length - 1, Number(range[1]) || 0)
        indices = []
        for (let index = start; index <= end; index += 1) indices.push(index)
      } else indices = [resolveMessageId(messages, range, current.messageId)]
      return indices.filter(index => index >= 0 && index < messages.length).map(index => {
        const message = messages[index]
        const swipeId = current.eventId === 'opening-init' && index === current.messageId ? current.swipeId : Math.max(0, Number(message?.swipeId) || 0)
        const slot = Array.isArray(message?.variables) ? message.variables[swipeId] : undefined
        const tree = index === current.messageId && swipeId === current.swipeId && current.activeData ? current.activeData : slot
        return {
          message_id: index,
          role: message?.role === 'user' || message?.tavernRole === 'user' ? 'user' : message?.role === 'system' ? 'system' : 'assistant',
          is_user: message?.role === 'user' || message?.tavernRole === 'user',
          is_system: message?.role === 'system' || message?.tavernRole === 'system',
          swipe_id: swipeId,
          content: str(current.eventId === 'opening-init' ? message?.swipes?.[swipeId] : message?.sourceText || message?.text),
          message: str(current.eventId === 'opening-init' ? message?.swipes?.[swipeId] : message?.sourceText || message?.text),
          variables: cloneJson(isObject(tree) ? tree : {}),
          swipes: cloneJson(message?.swipes || [str(message?.text)]),
          swipes_data: cloneJson(message?.variables || []),
          data: cloneJson(isObject(tree) ? tree : {})
        }
      })
    }
    const readOpen = () => {
      const current = bindingOf()
      if (!current) throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '卡脚本读窗口已关闭（本次结算已结束）')
      return current
    }
    const lodash = options.lodash
    const lodashStub = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined
        throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本使用了 lodash `_.' + String(prop) + '`，服务端未接线（缺少 options.lodash）：不做静默 undefined')
      }
    })
    function writePrompts(operation) {
      const current = requireOpen()
      if (typeof host.updatePrompts !== 'function') throw fail(SERVER_EXECUTION_ERRORS.unsupported, '提示词写入口未接线')
      const task = Promise.resolve().then(() => { assertOpen(current); return host.updatePrompts(current.sessionId, operation, undefined, current.hostEventId) }).then(result => {
        assertOpen(current)
        if (result?.stale) throw new Error('提示词写入遇到旧上下文')
        return result
      })
      current.pendingWrites.add(task)
      task.then(() => current.pendingWrites.delete(task), error => { current.pendingWrites.delete(task); current.asyncErrors.push(error) })
    }
    /**
     * 把**任何** thenable 纳入本次 run 的完成屏障（binding.pendingTasks），并同时交给 runtime 的待办表
     * （`_dshTrackPending`）—— 后者让 drainPendingTasks 也能等到"脚本没 await 的写"。
     *
     * 为什么需要它：`binding.pendingWrites` 只装我们自己构造的那几个 task；而 Helper 层
     * （`tavern-helper-api.js` 的 replaceVariables / updateVariablesWith / setChatMessages …）
     * **自带 await 与 assertOpen**，其返回的 promise 是**外层新造**的，脚本不 await 时
     * `Promise.all([...binding.pendingWrites])` **收不到**它（本计划此前把这条写成"已满足"是错的）。
     * 这里在 makeHostApi 末尾统一 wrap 返回值（含 Mvu 函数），把它们也跟踪起来。
     */
    function trackWrite(thenable) {
      if (!thenable || typeof thenable.then !== 'function') return thenable
      const current = bindingOf() || binding
      const task = Promise.resolve(thenable)
      current.pendingTasks.add(task)
      // **登记即注册**（不是 forget 时才注册）：`_dshTrackPending` 把任务交给 runtime 的待办表，
      // 使 `drainPendingTasks` 也能等到"脚本没 await 的写"。若等到 forget（task 已 settle）才注册，
      // 交进去的已是一个 settled promise —— runtime 表里凭空多一条、又立刻回吐，与已结算的顺序
      // 互相打架（drain 拍到假非空 / 假错误）。登记时刻注册；forget 只负责摘除两边的登记。
      // runtime 由 onRuntimeCreated 回填；尚未建立时，binding.pendingTasks 仍由 drainRunTasks join。
      current.runtime?.sandbox?._dshTrackPending?.(task, current.runtime?.currentSource || null)
      const forget = () => {
        current.pendingTasks.delete(task)
        current.runtime?.sandbox?._dshForgetPending?.(task)
      }
      task.then(forget, error => {
        forget()
        // 未被脚本 await 的失败写：进 asyncErrors（结算前 takeAsyncErrors 抛出），不静默。
        if (bindingIsOpen(current)) current.asyncErrors.push(error)
        else logger?.error?.('[server-execution] 结算闭合后卡脚本异步写失败（结果作废，未提交）:', str(error && error.message || error))
      })
      return thenable
    }
    const api = {
      injectPrompts: (prompts, option = {}) => {
        if (!Array.isArray(prompts)) throw new TypeError('提示词必须是数组')
        if (prompts.some(prompt => prompt?.filter !== undefined)) throw new Error('DSH暂不支持提示词filter回调')
        const ids = prompts.map(prompt => prompt.id)
        writePrompts({ kind: 'inject', prompts: cloneJson(prompts), once: Boolean(option.once) })
        return { uninject: () => writePrompts({ kind: 'remove', ids }) }
      },
      uninjectPrompts: ids => writePrompts({ kind: 'remove', ids: cloneJson(ids) }),
      getScriptId: () => { const id = readOpen().runtime?.currentScriptId; if (!id) throw new Error('当前脚本身份未绑定'); return id },
      getScriptName: () => readOpen().runtime?.currentSource || '',
      // ---- 变量（数据类） ----
      getVariables: option => variablesOf(option),
      replaceVariables,
      insertOrAssignVariables: async (variables, option = {}) => replaceVariables(mergeVariables(variablesOf(option), variables), option),
      deleteVariable: unsupported('deleteVariable'),
      // ---- 楼层 ----
      getCurrentMessageId: () => readOpen().messageId,
      getLastMessageId: () => {
        const current = readOpen()
        return Math.max(0, messagesOf(current.chat).length - 1)
      },
      getChatMessages: (range, option = {}) => {
        // 公开字符串按2.5契约；只保旧内部消费者已使用的数组/all形式。
        if (Array.isArray(range) || range === 'all') return chatMessages(readOpen(), range).filter(row => !option.role || option.role === 'all' || row.role === option.role)
        return publicMessages(range, option).map(row => ({...row, content:row.message}))
      },
      getAllChatMessages: () => publicMessages('0-{{lastMessageId}}').map(row => ({...row, content:row.message})),
      setChatMessages: async (range, patches) => {
        const current = requireOpen()
        // 作者公开契约单参patches[]；保留旧内部双参形态但不把公开patch误当楼号。
        if (patches === undefined && Array.isArray(range) && range.every(row => isObject(row))) {
          if (typeof host.updateMessages !== 'function') throw fail(SERVER_EXECUTION_ERRORS.unsupported, '楼层写入口未接线')
          const updates = cloneJson(range)
          const slotBefore = slotTreeOf(current)
          const receipt = await host.updateMessages(current.sessionId, updates, undefined, current.hostEventId, operationMeta(current))
          assertOpen(current)
          if (receipt?.stale === true) throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '楼层写回执已过期，不确认成功')
          if (current.activeData && updates.some(patch => Number(patch.message_id) === current.messageId && (patch.data !== undefined || patch.swipes_data !== undefined))) {
            const slotAfter = slotTreeOf(current)
            if (slotAfter !== slotBefore && isObject(slotAfter)) adoptTreeInPlace(current.activeData, slotAfter)
            slotMessage(current).variables[current.swipeId] = current.activeData
          }
          return receipt
        }
        const list = Array.isArray(patches) ? patches : [patches]
        const base = chatMessages(current, range)
        if (base.length === 0) return { updated: false }
        if (typeof host.updateMessages !== 'function') throw fail(SERVER_EXECUTION_ERRORS.unsupported, '楼层写入口未接线')
        const receipt = await host.updateMessages(current.sessionId, base.map((projected, offset) => {
          const patch = list[offset] !== undefined ? list[offset] : list[0]
          if (!isObject(patch)) return { message_id: projected.message_id }
          return {
            message_id: projected.message_id,
            ...(patch.message !== undefined ? { message: patch.message } : {}),
            ...(patch.data !== undefined ? { data: patch.data } : {}),
            ...(patch.swipe_id !== undefined ? { swipe_id: patch.swipe_id } : {})
          }
        // 第 5 参 = 本模块**自己签发**的 operation 令牌（WeakSet 识别，伪造对象无效）：
        // 让作者侧 updateMessages 能在"写之前"区分 hook 内同 operation 写 / 外部并发写。
        }), undefined, current.hostEventId, operationMeta(current))
        assertOpen(current)
        if (receipt?.stale === true) throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '楼层写回执已过期，不确认成功')
        return receipt
      },
      createChatMessages: async (messages, option = {}) => {
        const current = requireOpen()
        if (typeof host.createMessages !== 'function') {
          throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本创建楼层未接线（缺少 host.createMessages）')
        }
        return await host.createMessages(current.sessionId, Array.isArray(messages) ? messages : [messages], option, undefined, current.hostEventId)
      },
      deleteChatMessages: unsupported('deleteChatMessages'),
      // ---- 脚本变量 ----
      getScriptVariables: (option = {}) => variablesOf({ type: 'script', script_id: option && option.script_id }),
      replaceScriptVariables: async (variables, option = {}) => replaceVariables(variables, { type: 'script', script_id: option && option.script_id }),
      insertOrAssignScriptVariables: async (variables, option = {}) =>
        replaceVariables(mergeVariables(variablesOf({ type: 'script', script_id: option && option.script_id }), variables), { type: 'script', script_id: option && option.script_id }),
      // ---- 世界书 ----
      getWorldbook: async name => {
        const current = requireOpen()
        if (typeof host.getWorldbook !== 'function') throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本读取世界书未接线（缺少 host.getWorldbook）')
        return await host.getWorldbook(current.sessionId, str(name), false)
      },
      replaceWorldbook: async (name, entries) => {
        const current = requireOpen()
        if (typeof host.replaceWorldbook !== 'function') throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本替换世界书未接线（缺少 host.replaceWorldbook）')
        return await host.replaceWorldbook(current.sessionId, str(name), Array.isArray(entries) ? entries : [], undefined, false)
      },
      // ---- 人物卡 ----
      getCurrentCharacterName: () => str(readOpen().resourceSnapshot?.character?.name || readOpen().chat?.cardDefinitionSnapshot?.name),
      getCharData: () => {
        const current = readOpen()
        const snapshot = current.resourceSnapshot?.character || current.chat?.cardDefinitionSnapshot
        return isObject(snapshot) ? cloneJson(snapshot) : null
      },
      // ---- 事件与环境 ----
      waitGlobalInitialized: async () => {},
      Mvu: { events: SERVER_EXECUTION_EVENTS },
      _: typeof lodash === 'undefined' ? lodashStub : lodash,
      ...(options.YAML ? { YAML: options.YAML } : {}),
      z: options.zod || new Proxy({}, { get: (_target, key) => { throw fail(SERVER_EXECUTION_ERRORS.missingDependency, '卡schema依赖zod未加载（z.' + String(key) + '）：' + str(options.zodLoadError?.message || '缺少作者随包资源')) } }),
      zod: options.zod || new Proxy({}, { get: (_target, key) => { throw fail(SERVER_EXECUTION_ERRORS.missingDependency, '卡schema依赖zod未加载（zod.' + String(key) + '）：' + str(options.zodLoadError?.message || '缺少作者随包资源')) } }),
      $: fn => {
        if (typeof fn !== 'function') {
          // mvu_zod读取官方面板通知开关决定是否报告schema错误；服务端无面板，
          // 与作者浏览器事件桥一致强制开启诊断。只适配这一只读控件，不模拟任意DOM。
          readOpen()
          if (fn === '#mvu_notification_error') return Object.freeze({
            prop: (...args) => {
              readOpen()
              if (args.length === 1 && args[0] === 'checked') return true
              throw fail(SERVER_EXECUTION_ERRORS.unsupported, 'MVU错误通知开关仅支持只读 prop(checked)')
            }
          })
          throw fail(SERVER_EXECUTION_ERRORS.unsupported, '服务端不支持 jQuery DOM选择器：' + str(fn))
        }
        const current = bindingOf()
        if (!current) throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '卡脚本 jQuery ready 窗口已关闭（本次结算已结束）')
        // jQuery ready 语义：回调走微任务；**错误不吞** —— 记账后在钩子派发收尾时抛出。
        // 经 runtime 的 `_dshRegisterMicrotask` 登记：ready 回调里再 `setTimeout(…, 250)` 时，
        // 该 timer 归本次 run 的待办表、能被 drain 等到（否则加载期没人等它）。
        const registerMicrotask = current.runtime?.sandbox?._dshRegisterMicrotask
        const pending = typeof registerMicrotask === 'function'
          ? new Promise((resolve, reject) => registerMicrotask(() => {
              try { const result = fn(); Promise.resolve(result).then(resolve, reject); return result }
              catch (error) { reject(error); throw error }
            }))
          : Promise.resolve().then(fn)
        current.activity.pending += 1
        const tracked = pending.then(
          value => { current.activity.pending -= 1; return value },
          error => {
            current.activity.pending -= 1
            // 结算已闭合后的异步失败没有可提交的去处：**不静默**，按迟到失败报出来。
            if (!bindingIsOpen(current)) logger?.error?.('[server-execution] 结算闭合后卡脚本异步回调失败（结果作废，未提交）:', str(error && error.message || error))
            else current.asyncErrors.push(error)
            return undefined
          }
        )
        return trackWrite(tracked)
      },
      // ---- 生成（本包 wrapGenerateRaw：窗口校验 + 在飞计数 + 回程身份校验；不经客户端 HTTP） ----
      // 计数对象必须是 runtime 正在用的那一个（runtime.activity === binding.activity，由 runtime
      // 通过 activityHolder.current 回填）；hostApi 先于 runtime 构造 ⇒ 这里惰性绑定/重绑。
      generateRaw,
      // ---- 未接线（抛明确信息，不 no-op） ----
      generate: unsupported('generate'),
      triggerSlash: unsupported('triggerSlash'),
      getTavernRegexes: unsupported('getTavernRegexes'),
      replaceTavernRegexes: unsupported('replaceTavernRegexes'),
      getWorldbookNames: unsupported('getWorldbookNames'),
      createLorebook: unsupported('createLorebook'),
      deleteLorebook: unsupported('deleteLorebook')
    }
    const publicMessages = createHelperMessageReader({ readOpen, variablesOf, copy: cloneJson,
      projectRow: (row, id) => {
        const projected = projectRawHelperFloor(row, id)
        const active = variablesOf({type:'message', message_id:id, swipe_id:projected.swipe_id})
        projected.variables = active
        projected.swipes_data[projected.swipe_id] = active
        return projected
      } })
    const readonly = createHelperReadonlyApi({ readOpen, getVariables: variablesOf,
      getCurrentMessageId: api.getCurrentMessageId, getLastMessageId: api.getLastMessageId, host,
      // `state(open)` 收到**方法 wrapper 内已取到的** readOpen() 回执：这里不再自行 readOpen，
      // 既避免重复过窗口，也保证 state 与本次调用看到的是同一个 open（无跨次快照）。
      options: { ...options, getVersion: () => '4.8.19', state: open => {
        const current = open, snapshot = current.resourceSnapshot || {}, chat = current.chat
        return { playerName: chat.macroState?.userName || '你', characterName: snapshot.character?.name || chat.cardDefinitionSnapshot?.name || chat.cardName || chat.name || '角色',
          character: snapshot.character || chat.cardDefinitionSnapshot || (chat.cardPath ? {name: chat.cardName || chat.name} : null),
          messages: {length: messagesOf(chat).length}, regexScripts: {...snapshot.regexScripts, preset: snapshot.presetRegexScripts || []},
          scriptProjection: snapshot.scriptProjection }
      } }
    })
    // readonly中的同名世界书/DOM占位不能覆盖已有权威资源API。
    const readonlyNames = ['substitudeMacros','substituteMacros','formatAsTavernRegexedString','isCharacterTavernRegexesEnabled','getTavernHelperVersion','getAllEnabledScriptButtons','triggerSlash']
    for (const name of readonlyNames) api[name] = readonly[name]
    api.iframe_events = HELPER_GENERATION_EVENTS
    if (typeof options.createGenerationTasks === 'function') {
      const generation = createHelperGenerationApi({ bindingOf, assertOpen, options,
        activity: {get pending(){return activityOf().pending}, set pending(value){activityOf().pending=value}},
        emit: (name,...args) => binding.runtime?.sandbox.eventEmit(name,...args), str })
      binding.helperGeneration = generation
      for (const name of ['generate','generateRaw','stopGenerationById','stopAllGeneration']) api[name] = generation[name]
    }
    const assembled = Object.assign(api, createTavernHelperExtensions({
      getVariables: variablesOf, replaceVariables, readOpen, requireOpen, assertOpen, host, lodash,
      currentScriptId: () => binding.runtime?.currentScriptId || '',
      globals: () => binding.runtime?.sandbox || api, Mvu: api.Mvu,
    }), createTavernRegexApi({
      readSnapshot: current => current.resourceSnapshot, readOpen, requireOpen, assertOpen,
      saveExtensionSettings: async (...args) => {
        if (typeof host.saveExtensionSettings !== 'function') throw fail(SERVER_EXECUTION_ERRORS.unsupported, '正则设置CAS写口未接线')
        return await host.saveExtensionSettings(...args)
      },
    }))
    // —— 统一 wrap（本计划的关键补丁）——
    // Helper 层（replaceVariables / updateVariablesWith / setChatMessages / Mvu.replace …）自带 await，
    // 返回的 promise 是**外层新造**的：脚本不 await 时 `Promise.all([...binding.pendingWrites])` 收不到它。
    // 这里在**最后一个出口**把所有函数成员的 thenable 返回值（含 Mvu 命名空间，递归一层）登记进
    // binding.pendingTasks；已经由 pendingWrites 覆盖的那几个重复登记是幂等的（同一 Set 去重）。
    // 不改任何方法的同步返回值/抛错语义：只在返回**是 thenable** 时加一层跟踪。
    const wrapTracked = (target, depth) => {
      for (const key of Object.keys(target)) {
        // lodash 本体是带方法的函数，zod/YAML 是依赖命名空间，不是 Host API，不能包装或改写。
        if (['_', 'z', 'zod', 'YAML'].includes(key)) continue
        const value = target[key]
        if (typeof value === 'function') {
          if (value.__dshTracked === true) continue
          const wrapped = function (...args) {
            const result = value.apply(this, args)
            return result && typeof result.then === 'function' ? trackWrite(result) : result
          }
          Object.defineProperty(wrapped, '__dshTracked', { value: true, enumerable: false })
          Object.defineProperty(wrapped, 'name', { value: value.name || key, configurable: true })
          target[key] = wrapped
        } else if (key === 'Mvu' && depth > 0 && isObject(value)) {
          wrapTracked(value, depth - 1)
        }
      }
      return target
    }
    return wrapTracked(assembled, 1)
  }

  // ---------- 卡脚本：加载 → 有界等待注册 → strict 派发 ----------
  async function waitForHookRegistration(binding, runtime) {
    const deadline = Date.now() + loadBudgetMs
    let turns = 0
    while (runtime.events.length === 0 && bindingIsOpen(binding) && turns < loadMaxTurns && Date.now() < deadline) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { binding.timers.delete(timer); resolve() }, loadTickMs)
        binding.timers.set(timer, () => { binding.timers.delete(timer); resolve() })
      })
      turns += 1
    }
    if (!bindingIsOpen(binding)) throw fail(SERVER_EXECUTION_ERRORS.lateWrite, '服务端执行在等待钩子注册期间已被释放（结果作废，不提交）')
    return { turns, hooks: runtime.events.length }
  }

  function markBrowserUi(cardPath, sourceName, sources, reason) {
    const store = options.cardScriptDispatchStore
    if (!store) return
    try {
      const hit = sourceName ? sources.find(item => item.name === sourceName) : null
      if (hit && typeof store.markScript === 'function') store.markScript(cardPath, hit.id, hit.code, reason)
      else if (typeof store.markCard === 'function') store.markCard(cardPath, reason)
    } catch (error) {
      logger?.warn?.('[server-execution] 落 browser-ui 标记失败:', str(error && error.message || error))
    }
  }

  /**
   * 阶段一：建 runtime + 等钩子注册（**必须在变量命令之前**，否则 mag_variable_update_started /
   * mag_command_parsed / mag_variable_updated 这些"命令前/命令中"事件没有监听者）。
   */
  async function prepareCardHooks(binding) {
    const diagnostics = []
    const chat = binding.chat
    const cardPath = str(chat?.cardPath)
    const prepared = { runtime: null, sources: [], hooks: 0, turns: 0, cardPath, dispatched: false, browserScripts: null, diagnostics }
    if (cardPath === '') return prepared
    const store = options.cardScriptDispatchStore
    if (store && typeof store.lookupCard === 'function' && store.lookupCard(cardPath)) {
      // 卡级 DOM 标记 = **整卡判给浏览器**：服务端不跑钩子，但必须如实回报"需要浏览器"，
      // 否则生命周期快捷回执（browserScripts===0）会把已判给浏览器的卡吞掉。
      prepared.browserScripts = 1
      return prepared
    }
    const missing = []
    if (typeof options.readCardExtensions !== 'function') missing.push('readCardExtensions')
    if (typeof project !== 'function') missing.push('project')
    if (missing.length > 0) {
      // 卡真有脚本 ⇒ 响亮失败（不静默跳过派生值重算）；卡没脚本 ⇒ 无需钩子，正常继续。
      const hasScripts = typeof options.hasScripts === 'function' ? await options.hasScripts(chat) : true
      if (hasScripts) {
        throw fail(SERVER_EXECUTION_ERRORS.missingDependency, '卡脚本服务端执行依赖未接线（缺少 ' + missing.join('、') + '）：拒绝静默跳过卡脚本钩子')
      }
      prepared.browserScripts = 0
      return prepared
    }
    const extensions = await options.readCardExtensions(chat.cardPath, chat)
    assertOpen(binding)
    binding.resourceSnapshot = {
      ...(extensions?.variables !== undefined ? { characterVariables: cloneJson(extensions.variables) } : {}),
      regexScripts: { global: cloneJson(extensions?.globalRegexScripts || []), character: cloneJson(extensions?.characterRegexScripts || []) },
      characterRegexes: cloneJson(extensions?.characterRegexScripts || []),
      ...(typeof options.readResourceSnapshot === 'function' ? await options.readResourceSnapshot(binding.sessionId, chat) : {}),
    }
    assertOpen(binding)
    const projected = project(extensions && extensions.helperScripts, chat.tavernHelperScriptVariables)
    binding.resourceSnapshot.scriptProjection = projected
    const sources = projectServerScripts(projected?.scripts, { classify, isHostOwnedMvu, store, cardPath })
    // 浏览器侧脚本数（真投影 + 同一判据）：0 ⇒ 生命周期事件**无需下发浏览器**，直接回执不阻塞。
    prepared.browserScripts = storageBrowserScripts(projected?.scripts, { classify, isHostOwnedMvu, store, cardPath }).length
    for (const script of Array.isArray(projected?.scripts) ? projected.scripts : []) {
      // 未选入的浏览器/宿主核心脚本透出诊断；纯计算ESM已在sources，不能沿用全部迁浏览器口径。
      if (sources.some(item => item.id === str(script.id))) continue
      const klass = classify(str(script.content))
      if (klass === 'server-compute') continue
      diagnostics.push({
        kind: 'card-script', name: str(script.name) || str(script.id) || '卡脚本', level: 'warn', scriptId: str(script.id),
        message: klass === 'browser-ui' ? '界面脚本（browser-ui）不在服务端执行' : klass === 'esm' ? '该ESM已按显式分派标记留浏览器' : '空脚本已跳过'
      })
    }
    if (sources.length === 0) return prepared
    const runtime = createRuntime({
      cardPath,
      sources,
      moduleOptions: { ...options.esm, classify: classifyCardScript },
      onRuntimeCreated: instance => { binding.runtime = instance },
      hostApi: makeHostApi(binding),
      timeoutMs,
      logger,
      activity: binding.activity,
      activityHolder: binding.activityHolder,
      params: null,
      // **短延迟接管**：ceiling 沿 V1 的 3000（`timerCeilingMs` 缺省 0 时 runtime 一个都不接管，
      // 这里显式传，覆盖 ceiling 内的 250ms 防抖 / 1500ms 兜底；长延迟与 setInterval 不纳、不盲等）。
      timerCeilingMs,
      timerCountMax: 256,
      pendingCeilingMs: timerCeilingMs,
      onDomAccess: sourceName => {
        markBrowserUi(cardPath, sourceName, sources, 'dom-probe')
        diagnostics.push({ kind: 'card-script', name: sourceName || '卡脚本', level: 'warn', scriptId: '', message: '已识别为界面脚本（browser-ui），服务端不再执行' })
      }
    })
    if (!runtime || typeof runtime.dispatchEvent !== 'function') throw fail(SERVER_EXECUTION_ERRORS.loadFailed, '卡脚本运行时构造失败（createRuntime 未返回可派发的运行时）')
    binding.runtime = runtime
    // 原生ESM链接/顶层await及动态import全部结束后才检查错误和派发；加载中dispose会取消。
    await awaitBindingTask(binding, runtime.ready, timeoutMs)
    // 加载期（含 jQuery ready 回调）派生的短延迟回调：在**检查加载错误之前**有界等一轮，
    // 这样"ready 里 setTimeout(…, 1500) 再写变量"的兜底不会溜到 closed 窗口。有界（drain 自带预算），
    // 超预算抛错 ⇒ 本次不提交（与派发期同一出口，不返回半成功）。
    await drainRunTasks(binding, prepared)
    assertOpen(binding)
    const bootWriteError = takeAsyncErrors(binding)
    if (bootWriteError) throw bootWriteError
    // 加载期结果：
    //   · DOM 探针命中（脚本其实是界面脚本）⇒ 已落 browser-ui 标记，**并抛错重试** —— 不允许
    //     "钩子没跑"的这一轮以变量核心成功回执提交（标记保证下一轮该脚本走浏览器、不再失败）。
    //   · 其它加载错误（语法/执行）⇒ 同样抛错，绝不"记诊断继续"。
    const loadFailures = (Array.isArray(runtime.errors) ? runtime.errors : []).filter(item => !item?.domProbe)
    const domProbes = (Array.isArray(runtime.errors) ? runtime.errors : []).filter(item => item?.domProbe)
    if (loadFailures.length > 0 || domProbes.length > 0 || runtime.domAccessed === true) {
      for (const item of loadFailures) {
        diagnostics.push({ kind: 'card-script', name: str(item?.source) || '卡脚本', level: 'error', scriptId: '', message: '服务端加载失败：' + str(item?.error) })
      }
      prepared.diagnostics = diagnostics
      const detail = [
        ...loadFailures.map(item => (str(item?.source) || '卡脚本') + ' → ' + str(item?.error)),
        ...domProbes.map(item => (str(item?.source) || '卡脚本') + ' → DOM 探针，转浏览器')
      ].join('；')
      throw fail(SERVER_EXECUTION_ERRORS.loadFailed, '卡脚本服务端加载失败（' + detail
        + '），本次未执行变量核心、不提交；' + (domProbes.length > 0 || runtime.domAccessed === true ? 'DOM来源已标记browser-ui，后续交浏览器' : '需修复加载错误或Node启动旗标，不自动迁到浏览器'))
    }
    const settle = await waitForHookRegistration(binding, runtime)
    prepared.sources = sources
    prepared.settle = settle
    prepared.hooks = settle.hooks
    prepared.turns = settle.turns
    prepared.runtime = runtime
    if (settle.hooks === 0) {
      diagnostics.push({ kind: 'card-script', name: '卡脚本', level: 'warn', scriptId: '', message: '服务端脚本未注册任何事件钩子（turns=' + settle.turns + '）' })
    }
    return prepared
  }

  /** 阶段二：strict 派发单个事件（含错误码分类）；返回 outcome。 */
  async function dispatchHookEvent(binding, prepared, event, args) {
    if (!prepared.runtime || prepared.hooks === 0) return null
    try {
      // strict 是**第一参数对象**（{strict:true} 在前，事件与其参数跟在其后）——
      // 绝不把 strict 当末尾普通参数传，否则它会被当事件负载。
      const outcome = await prepared.runtime.dispatchEvent({ strict: true }, event, ...(Array.isArray(args) ? args : []))
      // 未 await 的写与短回调统一交完成屏障累计计时；不能每个 core 事件各发一份新 3 秒预算。
      assertOpen(binding)
      const writeError = takeAsyncErrors(binding)
      if (writeError) throw writeError
      return outcome
    } catch (error) {
      if (Object.values(SERVER_EXECUTION_ERRORS).includes(error?.code)) throw error
      if (isDomProbeError(error)) {
        // strict 包装错误把 domProbe 放在 cause 上（runtime 侧），两处都读，拿不到就退卡级标记。
        const sourceName = str(error?.source || error?.domProbe?.source || error?.cause?.domProbe?.source) || null
        markBrowserUi(prepared.cardPath, sourceName, prepared.sources, 'dom-probe-hook')
        throw fail(SERVER_EXECUTION_ERRORS.domProbe, '卡脚本钩子触发 DOM 探针（' + (sourceName || '未知脚本') + '）：已标记 browser-ui，本次结算未提交')
      }
      const message = str(error && error.message || error)
      // strict 下的超时 / 已释放也是抛（runtime 侧保证）：按码分开，便于上层区分"卡脚本坏了"与"资源被释放"。
      if (/超时|timed?\s*out|timeout/i.test(message)) throw fail(SERVER_EXECUTION_ERRORS.timeout, '卡脚本钩子执行超时（' + event + '）：' + message)
      if (/已释放|disposed/i.test(message)) throw fail(SERVER_EXECUTION_ERRORS.disposed, '卡脚本运行时已释放（' + event + '）：' + message)
      throw fail(SERVER_EXECUTION_ERRORS.hookFailed, '卡脚本钩子执行失败（' + event + '）：' + message)
    }
  }

  /** 阶段三：收尾（异步 $ 错误不吞）+ 记录派发诊断。 */
  function finishCardHooks(prepared, event) {
    if (prepared.dispatched) {
      prepared.diagnostics.push({
        kind: 'card-script', name: '卡脚本', level: 'warn', scriptId: '',
        message: '服务端派发 ' + event + '：钩子 ' + prepared.hooks + ' 个，脚本 ' + prepared.sources.length + ' 个'
      })
    }
    return prepared
  }

  function takeAsyncErrors(binding) {
    if (binding.asyncErrors.length === 0) return null
    const [first] = binding.asyncErrors
    binding.asyncErrors.length = 0
    return first
  }

  /** 可取消、有界且会摘掉败方计时器的等待；已发 Host 调用仍由 whenIdle 独立 join。 */
  async function awaitBindingTask(binding, task, budgetMs) {
    assertOpen(binding)
    let timer
    const stopped = new Promise((resolve, reject) => {
      const wake = () => { try { assertOpen(binding); reject(fail(SERVER_EXECUTION_ERRORS.timeout, '卡脚本异步完成超出预算，本次不提交')) } catch (error) { reject(error) } }
      timer = setTimeout(wake, Math.max(1, budgetMs))
      binding.timers.set(timer, wake)
    })
    try { const value = await Promise.race([task, stopped]); assertOpen(binding); return value }
    finally { clearTimeout(timer); binding.timers.delete(timer) }
  }

  /** 等所有已登记短回调与 Helper thenable；各阶段累计等待不超过 3 秒，无任务不盲等。 */
  async function drainRunTasks(binding, hooks) {
    assertOpen(binding)
    const started = Date.now()
    const budget = Math.max(1, timerDrainBudgetMs - (binding.completionWaitMs || 0))
    const deadline = started + budget
    const runtime = binding.runtime
    try {
      do {
        // 即使任务刚被摘空，也必须读取 runtime 的异步错误队列。
        if (typeof runtime?.drainPendingTasks === 'function') {
          await awaitBindingTask(binding, runtime.drainPendingTasks({ source: 'hook', timeoutMs: Math.max(1, deadline - Date.now()) }), Math.max(1, deadline - Date.now()))
        }
        const tasks = [...binding.pendingTasks, ...binding.pendingWrites]
        if (tasks.length) await awaitBindingTask(binding, Promise.all(tasks), Math.max(1, deadline - Date.now()))
        await Promise.resolve()
        assertOpen(binding)
        const error = takeAsyncErrors(binding)
        if (error) throw error
        if (runtime?.domAccessed) throw fail(SERVER_EXECUTION_ERRORS.domProbe, '卡脚本异步回调触发 DOM 探针，拒绝提交半结果')
        if (!binding.pendingTasks.size && !binding.pendingWrites.size && !(runtime?.pendingTasks?.() || 0)) return hooks
        if (Date.now() >= deadline) throw fail(SERVER_EXECUTION_ERRORS.timeout, '卡脚本完成屏障超出预算，本次不提交')
      } while (true)
    } finally { binding.completionWaitMs = (binding.completionWaitMs || 0) + Date.now() - started }
  }

  // ---------- 对外：一次结算的服务端执行 ----------
  /**
   * 在事务草稿上执行「变量核心 + 卡脚本钩子」。
   * 失败一律抛错（调用方 catch → 不提交）；返回值形如浏览器执行器回执，供作者侧沿用。
   */
  async function executeMvuUpdate(input = {}) {
    const sessionId = str(input.sessionId)
    if (sessionId === '') throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端 MVU 执行缺少 sessionId')
    const transaction = input.transaction
    const eventId = str(transaction?.eventId)
    if (eventId === '') throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端 MVU 执行缺少结算事件身份（transaction.eventId）')
    const draft = input.draft || transaction?.draft
    if (!draft || !Array.isArray(draft.messages)) throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端 MVU 执行缺少事务草稿（draft.messages）')
    const messageId = Number(input.messageId)
    const swipeId = Number(input.swipeId)
    if (!Number.isInteger(messageId) || messageId < 0 || messageId >= draft.messages.length) throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端 MVU 执行楼层不存在')
    if (!Number.isInteger(swipeId) || swipeId < 0) throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端 MVU 执行 swipeId 无效')
    const text = str(input.commandText ?? input.command)
    if (text.trim() === '') throw fail(SERVER_EXECUTION_ERRORS.badInput, '服务端 MVU 执行缺少变量命令文本')
    const binding = openBinding({
      sessionId, eventId, operationId: input.operationId, messageId, swipeId,
      chat: draft, record: input.record, signal: input.signal
    })
    let beforeMessageUpdate = null
    try {
      // **先装权威树**：把基线/旧树合成的树直接装进楼层槽位，并把它登记为绑定唯一权威对象。
      // 之后 host 读（getVariables）与 core 的写入都作用在**同一个对象**上 —— 修
      // 「钩子读旧树 / 钩子写被最终写回覆盖」的正确性 bug。
      const slot0 = slotTreeOf({ chat: draft, messageId, swipeId })
      const prior = slot0
      const baseline = isObject(input.baselineVariables) ? input.baselineVariables : null
      const mvuData = {
        initialized_lorebooks: baseline?.initialized_lorebooks ?? prior?.initialized_lorebooks ?? {},
        stat_data: cloneJson(baseline && baseline.stat_data !== undefined ? baseline.stat_data : (prior && prior.stat_data !== undefined ? prior.stat_data : {})) || {},
        schema: cloneJson(baseline && baseline.schema !== undefined ? baseline.schema : (prior && prior.schema !== undefined ? prior.schema : { type: 'object', properties: {}, extensible: true })) || { type: 'object', properties: {}, extensible: true }
      }
      // 登记为绑定唯一权威对象（**先不写进槽位**：失败路径保持草稿原样；槽位在成功收尾时
      // 才指向它，中途 host 写进来时再就地采纳）。
      binding.activeData = mvuData
      // —— ① 先建 runtime 并等钩子注册：命令**前/命令中**的事件（STARTED / COMMAND_PARSED /
      //    SINGLE_VARIABLE_UPDATED）必须有监听者，否则卡脚本派生逻辑静默丢失（MVU 正确性）。——
      const hooks = await prepareCardHooks(binding)
      // **永不传 null**：null 会让核心回落到模块级全局 emit（跨 operation 串监听/混写的风险）。
      // 没有钩子时给 no-op async emitter —— 事件进黑洞，但绝不进全局注册表。
      const emitter = hooks.runtime && hooks.hooks > 0
        ? (event, ...args) => dispatchHookEvent(binding, hooks, event, args)
        : async () => {}
      await recordFor(binding, 'server-core-start', { messageId, swipeId, hasBaseline: Boolean(baseline), hooks: hooks.hooks })
      let modified = false
      try {
        // —— ② 变量核心：事件只投给本次操作的 emitter（core 第 3 参局部出口，不用全局注册表）——
        modified = await executeCommand(text, mvuData, emitter) !== false
      } catch (error) {
        // 钩子错误已经由 dispatchHookEvent 分好码（timeout/disposed/domProbe/hookFailed）：
        // 不能被"核心执行失败"再包一层，否则上层分不清是脚本坏了还是核心坏了。
        if (str(error?.code).startsWith('SERVER_EXECUTION_')) throw error
        const message = str(error && error.message || error)
        const code = /Cannot find (package|module)/.test(message) ? SERVER_EXECUTION_ERRORS.missingDependency : SERVER_EXECUTION_ERRORS.coreFailed
        throw fail(code, 'MVU 变量核心执行失败：' + message)
      }
      await recordFor(binding, 'server-core-completed', { statDataKeys: Object.keys(isObject(mvuData.stat_data) ? mvuData.stat_data : {}).length, hooks: hooks.hooks })
      // —— ③ BEFORE_MESSAGE_UPDATE：按上游真调用点（update_variables.ts:1519-1527）——
      //    仅在「有变量被修改」且目标楼不是 user 时触发**一次**，参数为 { variables, message_content }。
      //    ⚠ message_content 必须是**前台原文**（input.originalText），绝不能拿 internalText（含变量命令）
      //    回填正文；位置 = 事务已准备、尚未提交。
      if (modified && hooks.runtime && hooks.hooks > 0 && str(slotMessage(binding)?.role) !== 'user') {
        const target = slotMessage(binding)
        const originalText = str(input.originalText ?? target?.sourceText ?? target?.text)
        const context = { variables: mvuData, message_content: originalText }
        hooks.dispatched = true
        await dispatchHookEvent(binding, hooks, SERVER_EXECUTION_EVENTS.BEFORE_MESSAGE_UPDATE, [context])
        if (str(context.message_content) !== originalText) {
          // 要求保留前台（preserveForeground）时不能覆盖正文 ⇒ **显式拒绝**，不静默丢弃也不 overwrite。
          if (input.preserveForeground === true) {
            throw fail(SERVER_EXECUTION_ERRORS.unsupported, '卡脚本在 BEFORE_MESSAGE_UPDATE 改写了正文，但本次结算要求保留前台正文（preserveForeground）：拒绝覆盖，本次未提交')
          }
          beforeMessageUpdate = { changed: true, messageContent: str(context.message_content) }
          hooks.diagnostics.push({ kind: 'card-script', name: '卡脚本', level: 'warn', scriptId: '', message: 'BEFORE_MESSAGE_UPDATE 改写了正文：已交调用方应用到正文槽（不再回填原文）' })
        }
      }
      finishCardHooks(hooks, SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED)
      // —— ③b MESSAGE_RECEIVED 给**投影后的卡钩子派发一次**（2026-10-04）——
      //    位置固定：core 成功、BEFORE_MESSAGE_UPDATE 成功之后，**提交之前**。
      //    宿主 MVU 已把 MESSAGE_RECEIVED 从浏览器侧 exclude（防重复 core），这里只补"卡脚本作为
      //    事件消费者"该收到的那一次（上游真调用点：消息落库前的变量更新收尾）。
      //    目标楼不是 user 时才发（与 BEFORE 同判据）；仅本轮有钩子时发；随后立刻走完成屏障，
      //    回调读到的就是 core 更新后的权威树（binding.activeData 被 core 就地改过）。
      if (hooks.runtime && hooks.hooks > 0 && str(slotMessage(binding)?.role) !== 'user') {
        await dispatchHookEvent(binding, hooks, 'MESSAGE_RECEIVED', [messageId])
        await drainRunTasks(binding, hooks)
        assertOpen(binding)
      }
      // —— ④ **提交前完成屏障**：等本次 run 派生的短延迟回调与未被 await 的 Helper 写，
      //    有界（binding 级截止时间 = timerDrainBudgetMs），超预算/回调抛错 ⇒ 抛出 ⇒ 本次不提交。
      await drainRunTasks(binding, hooks)
      const asyncError = takeAsyncErrors(binding)
      if (asyncError) throw fail(SERVER_EXECUTION_ERRORS.hookFailed, '卡脚本异步回调失败（jQuery ready / 微任务）：' + str(asyncError && asyncError.message || asyncError))
      // 核心与钩子都成功后才写回事务草稿；**await 之后必须再确认绑定还开着**（dispose 期间的
      // 迟到结果不许落盘）：这条把"disposeAll 只清表 → core await 后仍写 target"堵死。
      assertOpen(binding)
      // 权威树就是唯一结果：把它写回楼层槽位（此时槽位可能还是结算前的旧树 —— 只许覆盖，
      // **绝不许反向采纳**，否则 core 的结算结果会被旧树覆盖 = 丢写）。
      slotMessage(binding).variables[binding.swipeId] = binding.activeData
      await recordFor(binding, 'server-compute-completed', { hooks: hooks.hooks, scripts: hooks.sources.length, modified })
      const diagnostics = [
        { kind: 'server-engine', name: 'server-compute', level: 'warn', scriptId: '', ready: true, message: '变量核心与卡脚本钩子由服务端进程内执行（浏览器执行器未参与）' },
        ...hooks.diagnostics
      ]
      return {
        handled: true,
        mode: 'server-compute',
        diagnostics,
        modified,
        hooks: { scripts: hooks.sources.length, dispatched: hooks.hooks > 0, hooks: hooks.hooks, turns: hooks.turns ?? 0 },
        messageId,
        swipeId,
        ...(beforeMessageUpdate === null ? {} : { beforeMessageUpdate }),
        variables: cloneJson(mvuData)
      }
    } finally {
      closeBinding(binding)
    }
  }

  /**
   * 服务端派发**普通生命周期事件**（MESSAGE_SENT / MESSAGE_DELETED / MESSAGE_UPDATED /
   * MESSAGE_SWIPED / MESSAGE_EDITED …）给卡脚本钩子 —— 走 Host 变更 API 提交（非事务 eventId=''，
   * 与浏览器路径的 updateTavernHelperVariables RPC 同形），因此脚本写是被校验后真落盘的，
   * 不是"只在事务草稿里"的假提交。
   *
   * 边界：
   *   · 变量核心事件（MESSAGE_RECEIVED / mag_*）**不走本通道**，必须走 executeMvuUpdate。
   *   · 同一会话有 MVU 结算在飞时**抛错 reject**（`SERVER_EXECUTION_BINDING_BUSY`），不静默跳过
   *     ——静默会让调用方以为事件已派发。同步 mutation 保证不会与 MVU 事务并发改同一对话；
   *     调用方自己排队/稍后重试（队列/预路由由主 seams 决定，本 API 不做隐式重试）。
   *   · 按事件派发即用即毁：每次调用新建 runtime 并在结束时释放（含定时器）；
   *     脚本异常/DOM 探针一律抛（不吞、不伪成功）。
   * @returns { handled, event, browserScripts, hooks, diagnostics }（busy 情形抛错，不返回半状态）
   *          browserScripts：该卡浏览器侧脚本数（真投影同判据）；0 ⇒ 调用方无需再下发浏览器。
   */
  async function dispatchLifecycleEvent(input = {}) {
    const sessionId = str(input.sessionId)
    if (sessionId === '') throw fail(SERVER_EXECUTION_ERRORS.badInput, '生命周期事件派发缺少 sessionId')
    const event = str(input.event ?? input.name).trim()
    if (event === '') throw fail(SERVER_EXECUTION_ERRORS.badInput, '生命周期事件派发缺少事件名')
    if (event === 'MESSAGE_RECEIVED' || event.startsWith('mag_')) {
      throw fail(SERVER_EXECUTION_ERRORS.badInput, '变量核心事件（' + event + '）必须走 executeMvuUpdate，不能走生命周期通道')
    }
    const chat = input.draft || input.chat
      || (typeof options.resolveChat === 'function' ? await options.resolveChat(sessionId) : undefined)
    if (!chat || !Array.isArray(chat.messages)) throw fail(SERVER_EXECUTION_ERRORS.badInput, '生命周期事件派发缺少聊天快照（chat/draft；可用 options.resolveChat 接线）')
    for (const open of bindings.values()) {
      if (open.sessionId === sessionId && open.eventId.startsWith('mvu-work:')) {
        throw fail(SERVER_EXECUTION_ERRORS.busy, '该会话的 MVU 结算正在进行，生命周期事件（' + event + '）未派发：请排队后重试')
      }
    }
    const messageId = Number.isInteger(Number(input.messageId)) ? Number(input.messageId) : Math.max(0, chat.messages.length - 1)
    const binding = openBinding({
      sessionId, eventId: 'lifecycle:' + event + ':' + String(messageId), hostEventId: '', operationId: '',
      messageId, swipeId: 0, chat, record: input.record, signal: input.signal
    })
    try {
      const hooks = await prepareCardHooks(binding)
      const args = Array.isArray(input.args) ? input.args : [messageId]
      if (hooks.runtime && hooks.hooks > 0) {
        hooks.dispatched = true
        await dispatchHookEvent(binding, hooks, event, args)
      }
      finishCardHooks(hooks, event)
      // 提交前完成屏障（同 executeMvuUpdate）：短延迟回调 + 未 await 的写，有界预算、超时抛错。
      await drainRunTasks(binding, hooks)
      const asyncError = takeAsyncErrors(binding)
      if (asyncError) throw fail(SERVER_EXECUTION_ERRORS.hookFailed, '卡脚本异步回调失败（' + event + '）：' + str(asyncError && asyncError.message || asyncError))
      // await 之后确认绑定仍开（dispose 期间的迟到回执不许当成成功）。
      assertOpen(binding)
      return { handled: hooks.hooks > 0, event, browserScripts: hooks.browserScripts, hooks: { scripts: hooks.sources.length, hooks: hooks.hooks, dispatched: hooks.hooks > 0 }, diagnostics: hooks.diagnostics }
    } finally {
      closeBinding(binding)
    }
  }

  /** 开局准备页私有草稿：一次加载卡钩子，逐 swipe 真初始化，再按上游顺序执行开场白命令。 */
  async function initializeOpeningData(input = {}) {
    const draft = input.draft
    const sessionId = str(input.sessionId)
    const target = draft?.messages?.[0]
    if (!sessionId.startsWith('opening:') || !target?.greeting || draft.messages.length !== 1 || typeof input.initializeData !== 'function') {
      throw fail(SERVER_EXECUTION_ERRORS.badInput, '开局初始化只允许准备页单楼私有草稿及显式初始化器')
    }
    const swipes = target.swipes
    const selectedSwipe = target.swipeId
    if (!Array.isArray(swipes) || !swipes.length) throw fail(SERVER_EXECUTION_ERRORS.badInput, '开局初始化缺少开场白列表')
    const binding = openBinding({ sessionId, eventId: 'opening-init', hostEventId: '', chat: draft, messageId: 0, swipeId: 0, signal: input.signal })
    try {
      const hooks = await prepareCardHooks(binding)
      const emit = (event, ...args) => dispatchHookEvent(binding, hooks, event, args)
      const outputs = []
      for (let swipeId = 0; swipeId < swipes.length; swipeId++) {
        assertOpen(binding)
        binding.swipeId = swipeId
        target.swipeId = swipeId
        binding.activeData = null
        // Helper 默认读写以本次 swipe 为准，但最终保留用户选择的 swipe。
        const initialized = await input.initializeData({ variables: target.variables?.[swipeId] || {}, greeting: swipes[swipeId], swipeId })
        assertOpen(binding)
        if (!isObject(initialized?.variables)) throw fail(SERVER_EXECUTION_ERRORS.badInput, '初始化器没有返回真实变量树')
        binding.activeData = initialized.variables
        if (initialized.initialized) {
          await emit(SERVER_EXECUTION_EVENTS.VARIABLE_INITIALIZED, binding.activeData, swipeId)
          await drainRunTasks(binding, hooks)
          const command = typeof input.prepareCommand === 'function' ? await input.prepareCommand(swipes[swipeId]) : swipes[swipeId]
          assertOpen(binding)
          await executeCommand(command, binding.activeData, emit)
          await drainRunTasks(binding, hooks)
        }
        outputs.push(cloneJson(binding.activeData))
      }
      assertOpen(binding)
      target.variables = outputs
      return { handled: true, serverOwned: true, diagnostics: hooks.diagnostics, variables: outputs }
    } finally { target.swipeId = selectedSwipe; closeBinding(binding) }
  }

  /** 释放某会话的全部绑定（含在飞 runtime / 定时器）；会话关闭或运行时释放时调用。 */
  function disposeSession(sessionId) {
    const set = bySession.get(str(sessionId))
    if (!set) return 0
    let released = 0
    for (const key of [...set]) {
      const binding = bindings.get(key)
      if (binding) { closeBinding(binding); released += 1 }
    }
    return released
  }

  function disposeAll() {
    // 先置终止位：之后 openBinding 一律拒绝（新工作不再能开），再唤醒/关闭在飞绑定，
    // 使得已在 await 中的执行在下一个 assertOpen 处停下 —— 不会再写回目标楼（迟到提交）。
    terminated = true
    let released = 0
    for (const binding of [...bindings.values()]) { closeBinding(binding); released += 1 }
    bindings.clear()
    bySession.clear()
    return released
  }

  return Object.freeze({
    executeMvuUpdate: (input={}) => trackRun(input,executeMvuUpdate),
    dispatchLifecycleEvent: (input={}) => trackRun(input,dispatchLifecycleEvent),
    initializeOpeningData: (input={}) => trackRun(input,initializeOpeningData),
    whenIdle,
    disposeSession,
    disposeAll,
    /** 诊断/测试用：在飞绑定数与已释放 runtime 数（无业务语义）。 */
    stats: () => ({ bindings: bindings.size, sessions: bySession.size, disposedRuntimes: closedRuntimes, events: SERVER_EXECUTION_EVENTS, sandboxErrors: SANDBOX_ERRORS }),
    isBusy: (sessionId, eventId) => bindings.has(keyOf(sessionId, eventId)),
    /** 该会话是否有**任何**在飞绑定（结算或生命周期）。宿主写层用来做递归/并发判定。 */
    isSessionBusy: sessionId => {
      const set = bySession.get(str(sessionId))
      return Boolean(set && set.size > 0)
    },
    /** 传入的令牌是否是**本模块签发**的 operation 令牌（只证来源，不代表此刻在 operation 中间；
     *  与 `isSessionBusy` 合起来才是"同 operation 的 hook 内写"）。外部调用方伪造的
     *  `{serverOperation:'…'}` / 字符串 / undefined 一律 false —— 任意参数都不是授权。 */
    isOwnOperation
  })
}

// ---------- 主 seams 约定的模块级入口（作者树垫片同名转出） ----------
// DI 与结算数据同一个 input；实例按 **host 对象身份**缓存 —— 适配器里 host 只构造一次，
// 于是 busy 互斥 / disposeSession / 迟到写窗口在同一适配器内保持一致（不是每次调用新实例）。
const settlementExecutions = new WeakMap()
const settlementInstances = new Set()

function executionFor(input) {
  const host = input && input.host
  if (!host || typeof host.updateVariables !== 'function') {
    throw fail(SERVER_EXECUTION_ERRORS.missingDependency, '服务端结算缺少依赖: host.updateVariables')
  }
  let execution = settlementExecutions.get(host)
  if (execution === undefined) {
    execution = createServerExecution({ ...input, host })
    settlementExecutions.set(host, execution)
    settlementInstances.add(execution)
  }
  return execution
}

/**
 * 服务端结算入口（可选便捷入口；主 seams 标准垫片用的是 createServerExecution 实例 API）。
 * @param input { host, project?, isHostOwnedMvu?, classify?, readCardExtensions?, hasScripts?,
 *                cardScriptDispatchStore?, generateRaw?, readGlobalVariables?, executeCommand?,
 *                createRuntime?, logger?, sessionId, draft, transaction, messageId, swipeId,
 *                baselineVariables?, commandText?|command, operationId?, record? }
 * @returns { handled: true, mode: 'server-compute', diagnostics, hooks, messageId, swipeId, variables }
 */
export async function executeServerSettlement(input = {}) {
  return await executionFor(input).executeMvuUpdate(input)
}

/**
 * 普通生命周期事件的服务端派发入口（语句同 dispatchLifecycleEvent；DI 与数据同一个 input）。
 * @returns { handled, busy?, event, hooks, diagnostics }
 */
export async function executeServerLifecycle(input = {}) {
  return await executionFor(input).dispatchLifecycleEvent(input)
}

/** 释放某会话（或全部）的服务端执行绑定：会话关闭 / 运行时释放时由主 seams 调用。 */
export function releaseServerSettlement(sessionId) {
  let released = 0
  for (const execution of settlementInstances) released += sessionId === undefined ? execution.disposeAll() : execution.disposeSession(sessionId)
  return released
}

/**
 * view 用的运行时归属投影：给玩家/前端一个明确信号 —— **变量核心由服务端拥有**
 * （前端据此不初始化浏览器 MVU core，即便 `mvu.enabled === true`）。
 * @param input { chat, helperScripts?, project?, classify?, isHostOwnedMvu?, store?, cardPath? }
 * @returns { serverOwned: true, enabled, cardPath, serverScripts, browserScripts }
 */
export function mvuRuntimeOwnership(input = {}) {
  const chat = input.chat || {}
  const project = typeof input.project === 'function' ? input.project : scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] })
  const projected = Array.isArray(input.scripts) ? { scripts: input.scripts } : project(input.helperScripts, chat.tavernHelperScriptVariables)
  const classify = typeof input.classify === 'function' ? input.classify : classifyCardScript
  const isHostOwnedMvu = typeof input.isHostOwnedMvu === 'function' ? input.isHostOwnedMvu : null
  const cardPath = str(input.cardPath ?? chat.cardPath)
  const serverScripts = projectServerScripts(projected?.scripts, { classify, isHostOwnedMvu, store: input.store, cardPath })
  const browserScripts = storageBrowserScripts(projected?.scripts, { classify, isHostOwnedMvu, store: input.store, cardPath })
  return {
    serverOwned: true,
    enabled: chat?.mvu?.enabled === true,
    cardPath,
    serverScripts: serverScripts.map(item => ({ id: item.id, name: item.name })),
    browserScripts: browserScripts.map(item => ({ id: item.id, name: item.name, kind: item.kind }))
  }
}
