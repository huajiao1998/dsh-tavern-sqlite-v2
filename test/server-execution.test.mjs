// 服务端 MVU 执行消费者 + 核心运行时接缝变换的定向测试（原创小 fixture，不依赖作者树）
//
// 覆盖（每条对应一个可复现断言，不跑全量）：
//   A. 变换：幂等 / 版本标记唯一 / 未知布局抛错 / 浏览器执行器痕迹清零 / 变换产物语法可编译
//      （后者对 workspace 里的 B 2.4 权威源做一次集成；源不在则明确 SKIP 并打印原因）。
//   B. 服务端结算路径：变量核心命令路径（fake core）/ 卡脚本钩子 strict / 失败不提交
//      / 无浏览器派发依赖 / 迟到写拒绝 / session+operation 隔离 / 闭合释放 runtime。
//   C. 兼容面：getVariables / replaceVariables / insertOrAssignVariables / deleteVariable / 楼层 API /
//      events / `_` / Mvu / jQuery ready / generateRaw 身份闸 / 仍未接线的族抛明确信息。
//      deleteVariable 已由 Helper 层以真实 lodash unset 接线 ⇒ 是**异步**能力（旧断言按同步 throw
//      调用它会漏成 unhandled rejection 并杀掉整个测试进程，不是断言强度问题）。
//   D. 依赖闸：readCardExtensions 未接线时，卡真有脚本 ⇒ 响亮失败（不静默跳过钩子）。
//
// 场景：变量核心真实实现依赖 lodash/yaml/json5/jsonrepair，本机包内没有 node_modules
//      （禁止自行 npm install），因此核心以 DI 注入的 fake 断言"命令路径与写回语义"；
//      真实核心的接线由部署期（profile 安装依赖）验证。
//      **例外**：Helper 兼容面的 insertOrAssignVariables/deleteVariable 由真实 lodash
//      mergeWith/unset 承载（部署期注入点：lib/server-dependencies.js serverLodash() →
//      deploy/standard-seams.mjs 的 options.lodash），故这里借本地既有冻结核心依赖
//      （tools/mvu-server-core）解析同族真实 lodash —— 只读、不安装、不联网。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createServerExecution, classifyCardScript, projectServerScripts, storageBrowserScripts, effectiveScriptKind,
  mvuRuntimeOwnership, executeServerSettlement, executeServerLifecycle, releaseServerSettlement,
  SERVER_EXECUTION_EVENTS, SERVER_EXECUTION_ERRORS
} from '../lib/server-execution.js'
import { applyRuntimeTransform, runtimeTransformApplied, RUNTIME_MARKER } from '../deploy/core-runtime-transform.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const B_SOURCE = path.join(HERE, '..', '..', '..', 'tmp', 'plg-standard-1001-code', 'b', 'lib', 'domain', 'tavern-script-host-adapter.js')
// 本地既有冻结核心依赖（tools/mvu-server-core/package.json 声明 lodash）：只读解析，不安装、不联网。
const MVU_CORE_PACKAGE = path.join(HERE, '..', '..', '..', 'tools', 'mvu-server-core', 'package.json')
const coreRequire = createRequire(MVU_CORE_PACKAGE)
let serverLodash
try { serverLodash = coreRequire('lodash') } catch { serverLodash = undefined }
// 两族"未接线"码并不相同（事实，不在此统一）：执行层 api 字面量用 SERVER_EXECUTION_ERRORS.unsupported
// （'SERVER_EXECUTION_UNSUPPORTED_API'），Helper 层 tavern-helper-api.js:8 用自己的
// 'DSH_TAVERN_SERVER_UNSUPPORTED_API'；装配后同名方法按 Object.assign 顺序由 Helper 层覆盖，
// 所以断言必须按**真实来源**分别取码，而不是一律用执行层常量。
const HELPER_UNSUPPORTED_CODE = 'DSH_TAVERN_SERVER_UNSUPPORTED_API'

let passed = 0
let failed = 0
const targeted = process.env.DSH_TAVERN_SERVER_TEST_PATTERN ? new RegExp(process.env.DSH_TAVERN_SERVER_TEST_PATTERN) : null
async function test(name, fn) {
  if (targeted && !targeted.test(name)) return
  try {
    await fn()
    passed += 1
    console.log('  ok -', name)
  } catch (error) {
    failed += 1
    console.error('  FAIL -', name, '\n    ', error && error.message)
    process.exitCode = 1
  }
}
const codeOf = error => error && error.code
async function rejects(promise, check, label) {
  try { await promise } catch (error) {
    assert.ok(check(error), label + '：错误不符合预期（' + String(error && error.message) + '）')
    return error
  }
  assert.fail(label + '：预期抛错但没有')
}

// ---------------- A. 变换 ----------------
// 原创 fixture：把 B 2.4 的**锚点布局**（顶部 import / dispatchEvent / busy 判断 / 浏览器派发块）
// 缩进一个小模块里；不含任何作者实现，仅用于断言变换的锚点契约与幂等。
const FIXTURE = [
  "import { createScopedMessages } from './scoped-messages.js'",
  "import { createMvuSettlementEffect } from './mvu-settlement-effect.js'",
  '',
  'export function createFixtureAdapter(options = {}) {',
  '  const settlementTransactions = new Map()',
  '  const str = value => String(value ?? "")',
  '  async function context(sessionId) { return { sessionId, messages: [] } }',
  '  async function resolveChat(sessionId) { return { id: sessionId } }',
  '  async function fullContext(chat) { return { chatId: chat.id, messages: [] } }',
  '  async function updateVariables() { return { updated: true } }',
  '  async function updateMessages() { return { updated: true } }',
  '  async function createMessages() { return { updated: true } }',
  '  async function getWorldbook() { return { worldbook: [] } }',
  '  async function replaceWorldbook() { return { updated: true } }',
  '',
  '  async function dispatchEvent(input = {}) {',
  '    const eventContext = input.context || await context(input.sessionId, input.chat, input.transientUserText)',
  '    // Context preparation can await I/O before MVU has queued its dispatch.',
  '    // Respect that reservation just as dispatch respects an executing event.',
  '    if (settlementTransactions.has(str(input.sessionId))) return { handled: false, busy: true, args: structuredClone(input.args || []) }',
  '    return await options.scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)',
  '  }',
  '',
  '  /** Run one internal MVU command against an isolated draft and commit once. */',
  '  async function settleMvuUpdate(input = {}) {',
  '    const sessionId = str(input.sessionId)',
  '    const current = await resolveChat(sessionId)',
  '    const messageId = Number(input.messageId)',
  '    const swipeId = Number(input.swipeId)',
  '    const record = async () => {}',
  '    if (settlementTransactions.has(sessionId)) throw new Error("当前对话已有 MVU 变量结算正在执行")',
  '    // An earlier lifecycle event still owns the executor. Installing an MVU',
  '    // transaction now would reject its legitimate writes during context loading,',
  '    // even though dispatch would eventually return busy and defer this attempt.',
  '    const beforeDispatch = options.scriptDispatch.status?.(sessionId)',
  '    if (beforeDispatch?.busy) {',
  "      await record('runtime-deferred', { availability: beforeDispatch })",
  "      return { updated: false, deferred: true, deferredReason: 'runtime-busy', context: await fullContext(current) }",
  '    }',
  '    const internalText = "story"',
  '    let priorId = -1',
  '    async function executionContext() { return { messages: [] } }',
  '    transaction.executionContext = executionContext',
  '      const lazy = options.scriptDispatch.supportsContextProjection === true',
  '      const eventContext = lazy ? null : await executionContext()',
  '      const availability = options.scriptDispatch.status?.(sessionId)',
  '      const currentSnapshot=hasMvuSnapshot(transaction.draft.messages[messageId].variables?.[swipeId])',
  "      await record('runtime-dispatch', { availability, baseline: { currentSnapshot, priorSnapshot:priorId>=0, usesCurrentFallback:currentSnapshot && priorId<0 } })",
  '      async function initializationRejected(error) {',
  '        const validation = { changes: [], sideEffects: [], failures: [{ message: error }] }',
  "        await record('runtime-initialization-failed', { error })",
  '        return { updated: false, rejected: true, retryable: false, validation,',
  "          diagnostics: [{ kind: 'initialization', level: 'error', initializationFailed: true, message: error }],",
  '          context: await fullContext(current) }',
  '      }',
  '      if (availability?.initializationError) return await initializationRejected(availability.initializationError)',
  '      // MVU is a local capability of the chat. A temporarily absent browser',
  '      // executor is scheduling state, not a failed settlement. Return the',
  '      // prepared transaction immediately so the caller can persist and resume',
  '      // it when the executor registers again.',
  '      if (availability && availability.ready !== true) {',
  "        await record('runtime-deferred', { availability })",
  "        return { updated: false, deferred: true, deferredReason: 'runtime-not-ready', context: await fullContext(current) }",
  '      }',
  "      const dispatched = await options.scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED', [messageId], eventContext, { eventId: transaction.eventId, signal: input.signal, ...(lazy ? { contextForBaseline: executionContext } : {}) })",
  "      await record('runtime-completed', { handled: dispatched.handled === true, timedOut: dispatched.timedOut === true, executionLost: dispatched.executionLost === true, claimTimedOut: dispatched.claimTimedOut === true, phase: dispatched.phase, disposed: dispatched.disposed === true, error: dispatched.error, diagnostics: dispatched.diagnostics || [] })",
  '      if (dispatched.handled !== true) {',
  '        if (dispatched.initializationFailed === true) return await initializationRejected(str(dispatched.error))',
  '        if (dispatched.unavailable === true || (input.durable === true && (dispatched.disposed === true || dispatched.timedOut === true || /超时|timed?\\s*out|timeout/i.test(str(dispatched.error))))) {',
  "          await record('runtime-deferred', { availability: options.scriptDispatch.status?.(sessionId) })",
  "          return { updated: false, deferred: true, deferredReason: dispatched.claimTimedOut === true ? 'claim-timeout' : 'delivery-interrupted', context: await fullContext(current) }",
  '        }',
  "        if (str(dispatched.error).trim() !== '' && !dispatched.timedOut && !dispatched.disposed",
  '          && !/超时|timed?\\s*out|timeout/i.test(str(dispatched.error))) {',
  '          const validation = { changes: [], sideEffects: [], failures: [{ message: str(dispatched.error) }] }',
  "          await record('validation-rejected', { failures: validation.failures, externalEffects: transaction.externalEffects === true })",
  '          return { updated: false, rejected: true, retryable: transaction.externalEffects !== true, retryAfterMs: MVU_RETRY_AFTER_MS,',
  '            validation, diagnostics: dispatched.diagnostics || [], context: await fullContext(current) }',
  '        }',
  "        if (dispatched.timedOut === true) throw new Error('MVU 脚本执行回执超时，本轮结算未确认完成，请重试结算')",
  "        if (dispatched.disposed === true) throw new Error('MVU 浏览器执行器已断开，本轮结算中断，请重试结算')",
  "        throw new Error(str(dispatched.error).trim() || '官方 MVU 浏览器运行时尚未就绪，本轮未执行变量结算')",
  '      }',
  '      const settled = transaction.draft.messages[messageId]',
  '      if (!settled) return { updated: false, stale: true }',
  '      if (!Array.isArray(settled.swipes)) settled.swipes = [originalText]',
  '      settled.swipes[swipeId] = originalText',
  '      settled.sourceText = originalText',
  '      settled.projectionText = originalText',
  '      settled.text = originalText',
  '      settled.sessionText = originalText',
  '      settled.displayText = originalText',
  '  }',
  '',
  '  async function updateMessages(sessionId, messages, expectedLifecycleRevision, eventId) {',
  '    const transaction = settlementTransactions.get(str(sessionId))',
  '    const chat = transaction === undefined ? await resolveChat(sessionId) : transaction.draft',
  '    const patches = transaction === undefined ? messages : messages',
  '    const updated = replaceTavernHelperMessages(chat, patches)',
  '    const transactional = await transactionResult(sessionId, updated, true, eventId)',
  '    if (transactional !== null) return transactional',
  '    await options.writeChat(chat, { source: "tavern-helper.messages" })',
  '    return { updated: true, targets: updated, context: await fullContext(chat) }',
  '  }',
  '',
  '  return Object.freeze({',
  '    context,',
  '    dispatchEvent,',
  '    settleMvuUpdate,',
  '    updateVariables,',
  '    updateMessages',
  '  })',
  '}',
  ''
].join('\n')

await test('变换：锚点命中 + 浏览器痕迹清零 + 服务端执行接线就位', () => {
  const out = applyRuntimeTransform(FIXTURE)
  assert.notStrictEqual(out, FIXTURE)
  assert.ok(out.includes("import { createServerExecution } from './storage-server-execution.js'"), '插入垫片 import')
  assert.ok(out.includes('const serverExecution = createServerExecution({'), '构造 serverExecution')
  assert.ok(out.includes('serverExecution.executeMvuUpdate({'), '结算走服务端执行')
  assert.ok(out.includes('serverOwned: true'), 'MESSAGE_RECEIVED 结构化拒绝浏览器重跑')
  assert.ok(!out.includes('options.scriptDispatch.status?.('), '浏览器 availability 判断已删')
  assert.ok(!out.includes("scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED'"), '浏览器 MESSAGE_RECEIVED 派发已删')
  assert.ok(!out.includes('initializationRejected'), '浏览器初始化失败分支已删')
  assert.ok(out.includes("dispatch(sessionId, input.name, input.args, eventContext)") || out.includes('scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)'), '其它生命周期事件仍可下发浏览器（有 browser-ui 脚本时）')
  assert.ok(out.includes('const browserScripts = serverEvent ? serverEvent.browserScripts : null'), '浏览器下发前先取真投影计数')
  assert.ok(out.includes('if (browserScripts === 0) return {'), '纯计算卡（browserScripts=0）立即回执，不等浏览器')
  assert.ok(!out.includes('input.context || await context(input.sessionId'), '浏览器上下文重新取（不复用可能过期的 input.context）')
  assert.ok(out.includes('const eventContext = await context(input.sessionId, input.chat, input.transientUserText)'), '服务端钩子改变量后重取上下文')
  assert.ok(out.includes('commandText: internalText'), '核心收到与浏览器同形的 internalText')
  assert.ok(out.includes('originalText,'), 'BEFORE_MESSAGE_UPDATE 只拿前台原文')
  assert.ok(out.includes('const settledText = rewrittenText === null ? originalText : rewrittenText'), '改写正文落回正文槽')
  assert.ok(out.includes('const ownOperation = serverExecution.isOwnOperation(serverOperationMeta)'), '第 5 参内部令牌 → 同 operation 判定')
  assert.ok(out.includes('async function updateMessages(sessionId, messages, expectedLifecycleRevision, eventId, serverOperationMeta)'), '内部第 5 参不影响 4 参 RPC 调用')
  assert.ok(out.indexOf('if (!ownOperation && serverExecution.isSessionBusy(str(sessionId))) {') < out.indexOf('replaceTavernHelperMessages(chat, patches)'),
    '外部并发在**写之前**就被 busy 拒绝（原子：不会已 commit 却丢事件）')
  assert.ok(out.includes('if (lifecycleBefore.length > 0 && !ownOperation) {'), '同 operation 写跳递归派；不再靠 isSessionBusy 静默跳外部')
})

await test('变换：幂等（二次施缝字节不变） + 版本标记唯一', () => {
  const once = applyRuntimeTransform(FIXTURE)
  const twice = applyRuntimeTransform(once)
  assert.strictEqual(twice, once)
  assert.strictEqual(once.split(RUNTIME_MARKER).length - 1, 1)
  assert.strictEqual(runtimeTransformApplied(once), true)
  assert.strictEqual(runtimeTransformApplied(FIXTURE), false)
})

await test('变换：标记存在但实现不完整 ⇒ 抛错（拒绝猜测修复）', () => {
  const broken = FIXTURE.replace("import { createScopedMessages } from './scoped-messages.js'", RUNTIME_MARKER + '\nimport { createScopedMessages } from "./scoped-messages.js"')
  assert.throws(() => runtimeTransformApplied(broken), /实现不完整/)
})

await test('变换：未知布局 ⇒ 抛错（锚点未命中）', () => {
  assert.throws(() => applyRuntimeTransform(FIXTURE.replace('const lazy = options.scriptDispatch.supportsContextProjection === true', 'const lazy2 = true')), /锚点未命中/)
})

await test('变换：对 B 2.4 权威源集成 + 变换产物 node --check 通过', () => {
  if (!existsSync(B_SOURCE)) {
    console.log('    SKIP - 权威源不在本机：' + B_SOURCE)
    return
  }
  const source = readFileSync(B_SOURCE, 'utf8')
  const out = applyRuntimeTransform(source)
  assert.ok(out.startsWith(source.slice(0, 2000).split('\n')[0]) || out.includes('createTavernScriptHostAdapter'), '变换保留作者模块身份')
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-tavern-core-runtime-'))
  try {
    const file = path.join(dir, 'adapter.mjs')
    writeFileSync(file, out, 'utf8')
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    assert.strictEqual(result.status, 0, 'node --check 变换产物失败（status=' + result.status + '）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------- B/C/D. 服务端执行 ----------------
function fixtureChat(overrides = {}) {
  return {
    id: 'chat-1', sessionId: 's1', cardPath: 'cards/fixture.png', mvu: { enabled: true },
    variables: { chatVar: 1 },
    messages: [
      { role: 'user', text: '第一楼', swipes: ['第一楼'], swipeId: 0, turn: 1, variables: [] },
      { role: 'assistant', text: '第二楼', swipes: ['第二楼'], swipeId: 0, turn: 2, variables: [{ stat_data: { 好感度: 1 }, schema: { type: 'object' } }] }
    ],
    ...overrides
  }
}

function fakeRuntimeFactory(plan = {}) {
  const factory = runtimeOptions => {
    const { cardPath, sources, hostApi, onDomAccess } = runtimeOptions
    // 加载期 DOM 探针模拟：真实 runtime 会在加载该脚本时回调 onDomAccess（宿主据此落 browser-ui 标记）
    if (plan.loadDomProbe) {
      try { onDomAccess?.(plan.loadDomProbe) } catch { /* 探针回调失败不影响 fixture */ }
    }
    const runtime = {
      cardPath, sources, hostApi, events: [], errors: plan.errors || [], domAccessed: false, disposed: false,
      dispose() { runtime.disposed = true; return { clearedTimers: 1 } },
      async dispatchEvent(...args) {
        const strict = Boolean(args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]))
        const event = String(strict ? args[1] : args[0])
        const eventArgs = strict ? args.slice(2) : args.slice(1)
        const outcome = { ok: true, event, strict, results: [], committed: true }
        factory.events.push({ event, strict, args: eventArgs })
        const wanted = plan.onEvent === undefined ? SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED : plan.onEvent
        if (typeof plan.onDispatch === 'function' && (wanted === '*' || event === wanted)) {
          await plan.onDispatch({ runtime, hostApi, args, outcome, event, eventArgs })
        }
        return outcome
      }
    }
    if (plan.registerHooks !== false) {
      if (typeof plan.registerHooks === 'function') plan.registerHooks(runtime)
      else runtime.events.push({ event: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED, handler() {}, source: 'fixture' })
    }
    factory.created.push(runtime)
    factory.instances += 1
    return runtime
  }
  factory.created = []
  factory.events = []
  factory.instances = 0
  return factory
}

function harness({ plan = {}, execution = {} } = {}) {
  const hostCalls = { updateVariables: [], updateMessages: [], createMessages: [] }
  const coreCalls = []
  const runtimeFactory = fakeRuntimeFactory(plan)
  const execution2 = createServerExecution({
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    isHostOwnedMvu: script => /^mvu$/i.test(String(script && script.name).trim()),
    readCardExtensions: async () => ({ helperScripts: [{ id: 'srv', name: 'srv', type: 'script', content: 'const a = 1', enabled: true }] }),
    hasScripts: async () => true,
    createRuntime: runtimeFactory,
    // 忠实模拟真实核心：命令前后按上游顺序把事件投给**本次操作注入的 emitter**（core 第 3 参）。
    executeCommand: async (text, variables, emitter) => {
      coreCalls.push({ text, variables: JSON.parse(JSON.stringify(variables)) })
      if (plan.coreFails) throw new Error('core-boom')
      if (typeof emitter === 'function') await emitter(SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_STARTED, variables)
      if (typeof emitter === 'function') await emitter(SERVER_EXECUTION_EVENTS.COMMAND_PARSED, variables, [{ type: 'set' }], text)
      variables.stat_data = { ...(variables.stat_data || {}), 好感度: 7 }
      if (typeof emitter === 'function') await emitter(SERVER_EXECUTION_EVENTS.SINGLE_VARIABLE_UPDATED, variables.stat_data, '好感度', 1, 7)
      if (typeof emitter === 'function') await emitter(SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED, variables, {})
      return true
    },
    hookLoadBudgetMs: plan.hookLoadBudgetMs ?? 0,
    host: {
      updateVariables: async (...args) => { hostCalls.updateVariables.push(args); return { updated: true, target: { type: 'message' } } },
      updateMessages: async (...args) => { hostCalls.updateMessages.push(args); return { updated: true } },
      createMessages: async (...args) => { hostCalls.createMessages.push(args); return { updated: true } }
    },
    ...execution
  })
  return { execution: execution2, hostCalls, coreCalls, runtimeFactory }
}

function callInput(draft, extra = {}) {
  return {
    sessionId: 's1', draft, transaction: { eventId: 'mvu-work:op-1', draft },
    messageId: 1, swipeId: 0, commandText: 'story\n\n<json_patch/>', ...extra
  }
}

await test('结算：变量核心命令路径（文本 + 基线 → 写回事务草稿）', async () => {
  const draft = fixtureChat()
  const { execution, coreCalls } = harness()
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(result.handled, true)
  assert.strictEqual(result.mode, 'server-compute')
  assert.strictEqual(coreCalls.length, 1)
  assert.strictEqual(coreCalls[0].text, 'story\n\n<json_patch/>')
  assert.strictEqual(draft.messages[1].variables[0].stat_data.好感度, 7)
  assert.deepStrictEqual(result.variables.stat_data, { 好感度: 7 })
})

await test('结算：基线变量优先于楼层旧树（与浏览器执行器同形）', async () => {
  const draft = fixtureChat()
  const { execution, coreCalls } = harness()
  await execution.executeMvuUpdate(callInput(draft, { baselineVariables: { stat_data: { 好感度: 100 }, schema: { type: 'object' } } }))
  assert.deepStrictEqual(coreCalls[0].variables.stat_data, { 好感度: 100 })
  assert.deepStrictEqual(coreCalls[0].variables.schema, { type: 'object' })
})

await test('结算：无浏览器派发依赖（不注入 scriptDispatch 也能跑，且它永不被调用）', async () => {
  const draft = fixtureChat()
  const scriptDispatch = { dispatch() { throw new Error('浏览器执行器不应被调用') }, status() { throw new Error('浏览器执行器不应被调用') } }
  const { execution } = harness({ execution: { scriptDispatch } })
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(result.handled, true)
})

await test('失败不提交：核心抛错 ⇒ 拒绝且草稿保持原样，卡脚本钩子未派发（runtime 已释放）', async () => {
  const draft = fixtureChat()
  const before = JSON.parse(JSON.stringify(draft.messages[1].variables))
  const { execution, runtimeFactory } = harness({ plan: { coreFails: true } })
  const error = await rejects(execution.executeMvuUpdate(callInput(draft)), e => codeOf(e) === SERVER_EXECUTION_ERRORS.coreFailed, '核心失败')
  assert.match(error.message, /core-boom/)
  assert.deepStrictEqual(draft.messages[1].variables, before)
  // runtime 建在命令之前（钩子要先注册）⇒ 这里断言"建了但没派发任何钩子、且已释放"
  assert.strictEqual(runtimeFactory.instances, 1)
  assert.deepStrictEqual(runtimeFactory.events, [])
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
})

await test('失败不提交：钩子 strict 抛错 ⇒ 拒绝且草稿保持原样，runtime 已释放', async () => {
  const draft = fixtureChat()
  const before = JSON.parse(JSON.stringify(draft.messages[1].variables))
  const { execution, runtimeFactory } = harness({ plan: { onDispatch: () => { throw new Error('hook-boom') } } })
  await rejects(execution.executeMvuUpdate(callInput(draft)), e => codeOf(e) === SERVER_EXECUTION_ERRORS.hookFailed, '钩子失败')
  assert.deepStrictEqual(draft.messages[1].variables, before)
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
})

await test('失败不提交：$(ready) 里抛的异步错误不许吞（收尾抛出）', async () => {
  const draft = fixtureChat()
  const before = JSON.parse(JSON.stringify(draft.messages[1].variables))
  const { execution } = harness({
    plan: {
      onDispatch: async ({ hostApi }) => {
        hostApi.$(async () => { throw new Error('ready-boom') })
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
  })
  const error = await rejects(execution.executeMvuUpdate(callInput(draft)), e => codeOf(e) === SERVER_EXECUTION_ERRORS.hookFailed, 'ready 异步错误')
  assert.match(error.message, /ready-boom/)
  assert.deepStrictEqual(draft.messages[1].variables, before)
})

await test('依赖闸：真实 lodash（mergeWith/unset）可解析 ⇒ 兼容面不静默降级到 unsupported', () => {
  assert.strictEqual(typeof serverLodash?.mergeWith, 'function', '本地 lodash 不可解析（' + MVU_CORE_PACKAGE + '）：拒绝在没有真实 mergeWith 的情况下弱化兼容面断言')
  assert.strictEqual(typeof serverLodash?.unset, 'function', '本地 lodash 缺 unset：deleteVariable 真实路径无法验证')
})

await test('兼容面：getVariables / replaceVariables / insertOrAssignVariables 绑定当前事务 eventId', async () => {
  const draft = fixtureChat()
  const captured = {}
  const { execution, hostCalls } = harness({
    // 注入真实 lodash：insertOrAssignVariables 走 Helper 层真实 mergeWith（不是 fixture 自造合并）。
    execution: { lodash: serverLodash },
    plan: {
      onDispatch: async ({ hostApi }) => {
        captured.tree = hostApi.getVariables()
        captured.tree.stat_data.好感度 = 999          // 读取是克隆，改不到权威树
        captured.coreValue = hostApi.getVariables().stat_data.好感度
        // replaceVariables 是**整树替换**语义（与浏览器/作者一致）：写入时带上当前树，别把它抹掉
        await hostApi.replaceVariables({ ...hostApi.getVariables(), a: 1 }, { type: 'message' })
        await hostApi.insertOrAssignVariables({ b: 2 }, { type: 'message' })
        captured.current = hostApi.getCurrentMessageId()
        captured.last = hostApi.getLastMessageId()
        captured.rows = await hostApi.getChatMessages()
        captured.mvuEvent = hostApi.Mvu.events.VARIABLE_UPDATE_ENDED
      }
    }
  })
  await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(captured.coreValue, 7, '钩子读到 core 之后的权威树')
  assert.strictEqual(draft.messages[1].variables[0].stat_data.好感度, 7)     // 克隆未污染 + core 结果未被覆盖
  assert.strictEqual(captured.current, 1)
  assert.strictEqual(captured.last, 1)
  assert.strictEqual(captured.mvuEvent, 'mag_variable_update_ended')
  assert.deepStrictEqual(captured.rows.map(row => row.message_id), [1])
  assert.strictEqual(captured.rows[0].role, 'assistant')
  assert.strictEqual(captured.rows[0].content, '第二楼')
  assert.strictEqual(hostCalls.updateVariables.length, 2)
  assert.strictEqual(hostCalls.updateVariables[0][0], 's1')
  assert.deepStrictEqual(hostCalls.updateVariables[0][1], { type: 'message', message_id: 1, swipe_id:0 })
  assert.strictEqual(hostCalls.updateVariables[0][4], 'mvu-work:op-1', '写绑定当前事务 eventId')
  assert.strictEqual(hostCalls.updateVariables[0][2].a, 1)
  assert.strictEqual(hostCalls.updateVariables[0][2].stat_data.好感度, 7, '整树替换带上了 core 的结果')
  // 合并语义：读当前权威树 + 覆盖新键（宿主 fake 不回写，写也必须落权威树）
  assert.deepStrictEqual(hostCalls.updateVariables[1][2], { initialized_lorebooks: {}, stat_data: { 好感度: 7 }, schema: { type: 'object' }, a: 1, b: 2 })
  assert.deepStrictEqual(Object.keys(draft.messages[1].variables[0]).sort(), ['a', 'b', 'initialized_lorebooks', 'schema', 'stat_data'], '最终草稿 = 权威树（含钩子写）')
})

await test('兼容面：deleteVariable 已是真实异步能力（真实 lodash unset + 当前事务 eventId）', async () => {
  const draft = fixtureChat()
  const captured = {}
  const { execution, hostCalls } = harness({
    execution: { lodash: serverLodash },
    plan: {
      onDispatch: async ({ hostApi }) => {
        captured.pending = hostApi.deleteVariable('stat_data.好感度', { type: 'message' })
        assert.strictEqual(typeof captured.pending.then, 'function', 'deleteVariable 是异步能力（不是同步 throw）')
        captured.returned = await captured.pending
        captured.after = hostApi.getVariables()
      }
    }
  })
  await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(Object.hasOwn(captured.returned.variables.stat_data, '好感度'), false, '返回值已删除该路径（非 no-op）')
  assert.strictEqual(Object.hasOwn(captured.after.stat_data, '好感度'), false, '权威树已删除')
  assert.strictEqual(captured.after.schema.type, 'object', '未删除的兄弟键保留')
  assert.strictEqual(hostCalls.updateVariables.length, 1, 'deleteVariable 走一次真实写')
  assert.strictEqual(hostCalls.updateVariables[0][4], 'mvu-work:op-1', '写绑定当前事务 eventId')
  assert.strictEqual(Object.hasOwn(hostCalls.updateVariables[0][2].stat_data, '好感度'), false, '写入树不含被删路径')
  assert.deepStrictEqual(hostCalls.updateVariables[0][2].schema, { type: 'object' }, '写入树保留非目标键')
})

await test('兼容面：仍未接线的族抛明确信息（不 no-op 伪成功；deleteVariable 已是异步真实能力）', async () => {
  const draft = fixtureChat()
  const seen = []
  let capturedUnwired
  const { execution } = harness({
    plan: {
      onDispatch: async ({ hostApi }) => {
        // 执行层未接线族（api 字面量的 unsupported 工厂）：必须当场抛，不得返回 undefined 伪成功。
        for (const name of ['generate', 'deleteChatMessages']) {
          assert.throws(() => hostApi[name]({}), error => codeOf(error) === SERVER_EXECUTION_ERRORS.unsupported, name + ' 应抛 unsupported')
        }
        assert.equal(await hostApi.triggerSlash('/pass 已接只读'), '已接只读')
        // Helper 层转发族：装配后被 createTavernHelperExtensions 的同名方法覆盖（host 未接线 ⇒ 当场抛），
        // 但码是 Helper 层自己的 HELPER_UNSUPPORTED_CODE（见上方常量注释），不是执行层常量。
        assert.throws(() => hostApi.getWorldbookNames({}), error => codeOf(error) === HELPER_UNSUPPORTED_CODE, 'getWorldbookNames 应抛 unsupported（Helper 层码）')
        assert.throws(() => hostApi._.set, error => codeOf(error) === SERVER_EXECUTION_ERRORS.unsupported, 'lodash 未接线应抛')
        assert.throws(() => hostApi.getVariables({ type: 'global' }), error => codeOf(error) === SERVER_EXECUTION_ERRORS.unsupported, '全局变量读未接线应抛')
        // deleteVariable：Helper 层已接线为**异步**真实能力（lodash unset）。本 harness 未注入 lodash，
        // 因此它必须响亮失败 —— 形态是 rejected Promise（旧断言用同步 assert.throws 会漏成
        // unhandled rejection 并杀掉进程），失败原因必须点名缺失的 unset，不得静默成功。
        // 码取 Helper 层自己的 HELPER_UNSUPPORTED_CODE（requireLodash 走 tavern-helper-api.js:8）。
        // Helper rejected Promise也被完成屏障记录；钩子内捕获不允许把失败伪装成成功。
        capturedUnwired = hostApi.deleteVariable('stat_data.好感度', { type: 'message' })
        await capturedUnwired.catch(() => {})
        seen.push('checked')
      }
    }
  })
  await rejects(execution.executeMvuUpdate(callInput(draft)), error => /unset/.test(String(error.message)), 'Helper失败必须阻断结算')
  await rejects(capturedUnwired, error => codeOf(error) === HELPER_UNSUPPORTED_CODE, '缺少真实unset明确失败')
  assert.deepStrictEqual(seen, ['checked'])
})

await test('兼容面：generateRaw 走本包 wrapGenerateRaw（窗口 + 身份 + 当前事务 eventId）', async () => {
  const draft = fixtureChat()
  const rawCalls = []
  const captured = {}
  const { execution } = harness({
    plan: {
      onDispatch: async ({ hostApi }) => {
        captured.out = await hostApi.generateRaw({ user_input: 'hi' })
        captured.api = hostApi
      }
    },
    execution: { generateRaw: async (config, context) => { rawCalls.push([config, context]); return { text: 'RAW-OK' } } }
  })
  await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(captured.out, 'RAW-OK')
  assert.deepStrictEqual(rawCalls[0][1], { sessionId: 's1', eventId: 'mvu-work:op-1' })
  const late = await rejects(captured.api.generateRaw({}), e => /窗口未开启/.test(String(e && e.message)), '窗口关闭后调用')
  assert.match(String(late.message), /窗口未开启/)
})

await test('兼容面：generateRaw 未接线 ⇒ 明确抛错（不静默空串）', async () => {
  const draft = fixtureChat()
  let message = ''
  const { execution } = harness({ plan: { onDispatch: async ({ hostApi }) => { try { await hostApi.generateRaw({}) } catch (error) { message = String(error.message) } } } })
  // 未接线是**硬失败**：脚本侧抛明确信息，且该失败必须阻断本次结算（fail-closed，不静默空串、
  // 不伪成功提交）。两面都要断言 —— 只断言 message 会把结算的拒绝变成未处理拒绝。
  await rejects(execution.executeMvuUpdate(callInput(draft)),
    error => codeOf(error) === SERVER_EXECUTION_ERRORS.hookFailed, '未接线必须阻断结算')
  assert.match(message, /尚未接线/)
  assert.strictEqual(draft.messages[1].variables[0].stat_data.好感度, 1, '失败不提交：草稿保持原样')
})

await test('迟到写拒绝：结算闭合后任何写/读窗口调用都被拒（含 await 期间的替换）', async () => {
  const draft = fixtureChat()
  let api = null
  const { execution, hostCalls, runtimeFactory } = harness({ plan: { onDispatch: ({ hostApi }) => { api = hostApi } } })
  await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
  assert.strictEqual(execution.isBusy('s1', 'mvu-work:op-1'), false)
  await rejects(api.replaceVariables({ late: true }), error => codeOf(error) === SERVER_EXECUTION_ERRORS.lateWrite, '迟到写')
  assert.throws(() => api.getVariables(), error => codeOf(error) === SERVER_EXECUTION_ERRORS.lateWrite, '迟到读')
  assert.strictEqual(hostCalls.updateVariables.length, 0)
  assert.deepStrictEqual(execution.stats().bindings, 0)
})

await test('session+operation 隔离：同卡不同会话各自 runtime，互不串写', async () => {
  const draftA = fixtureChat({ id: 'chat-A', sessionId: 'sA' })
  const draftB = fixtureChat({ id: 'chat-B', sessionId: 'sB' })
  const captured = {}
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  const { execution, runtimeFactory } = harness({
    plan: {
      onDispatch: async ({ hostApi, runtime }) => {
        captured[runtime.cardPath + ':' + runtimeFactory.instances] = hostApi
        if (runtimeFactory.instances === 1) await gate
      }
    }
  })
  const slow = execution.executeMvuUpdate(callInput(draftB, { sessionId: 'sB', transaction: { eventId: 'mvu-work:op-B', draft: draftB } }))
  const fast = execution.executeMvuUpdate(callInput(draftA, { sessionId: 'sA', transaction: { eventId: 'mvu-work:op-A', draft: draftA } }))
  await fast
  assert.strictEqual(runtimeFactory.instances >= 1, true)
  assert.strictEqual(execution.isBusy('sA', 'mvu-work:op-A'), false)
  release()
  await slow
  assert.strictEqual(runtimeFactory.instances, 2, '两个会话各构造自己的 runtime（无全局卡缓存）')
  assert.notStrictEqual(runtimeFactory.created[0], runtimeFactory.created[1])
  assert.deepStrictEqual(execution.stats().bindings, 0)
  assert.strictEqual(execution.disposeSession('sA'), 0)
})

await test('同会话同事件重入 ⇒ 结构化拒绝（session+event 唯一）', async () => {
  const draft = fixtureChat()
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  let apiSeen = null
  const { execution } = harness({ plan: { onDispatch: async ({ hostApi }) => { apiSeen = hostApi; await gate } } })
  const first = execution.executeMvuUpdate(callInput(draft))
  await new Promise(resolve => setTimeout(resolve, 5))
  await rejects(execution.executeMvuUpdate(callInput(draft)), error => codeOf(error) === SERVER_EXECUTION_ERRORS.busy, '重入')
  release()
  await first
  assert.ok(apiSeen)
})

await test('异步注册的钩子：有界轮询等到注册（不用固定 sleep）', async () => {
  const draft = fixtureChat()
  const { execution } = harness({
    plan: {
      registerHooks: runtime => { setTimeout(() => runtime.events.push({ event: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED, handler() {}, source: 'late' }), 12) },
      hookLoadBudgetMs: 400
    }
  })
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(result.hooks.hooks, 1)
  assert.ok(result.hooks.turns > 0, '轮询次数 > 0 说明确实等了异步注册')
})

await test('依赖闸：readCardExtensions 未接线且卡真有脚本 ⇒ 命令前就响亮失败（不静默跳过钩子）', async () => {
  const draft = fixtureChat()
  const { execution, coreCalls } = harness({ execution: { readCardExtensions: undefined } })
  const error = await rejects(execution.executeMvuUpdate(callInput(draft)), e => codeOf(e) === SERVER_EXECUTION_ERRORS.missingDependency, '依赖缺失')
  assert.match(error.message, /readCardExtensions/)
  assert.strictEqual(coreCalls.length, 0, '钩子依赖缺失在命令前失败：不先算一半再丢派生值')
  assert.deepStrictEqual(execution.stats().bindings, 0)
})

await test('依赖闸：卡没有脚本 ⇒ 不需要钩子，正常返回', async () => {
  const draft = fixtureChat()
  const { execution, runtimeFactory } = harness({ execution: { readCardExtensions: undefined, hasScripts: async () => false } })
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(result.handled, true)
  assert.strictEqual(result.hooks.scripts, 0)
  assert.strictEqual(runtimeFactory.instances, 0)
})

await test('分类（自有实现）：不认识即 server-compute；DOM 走浏览器、esm 进服务端 ESM 沙箱；宿主 MVU 核心与已标记脚本被排除', () => {
  assert.strictEqual(classifyCardScript('const a = 1'), 'server-compute')
  assert.strictEqual(classifyCardScript('document.getElementById("x")'), 'browser-ui')
  assert.strictEqual(classifyCardScript('querySelector(".x")'), 'browser-ui')
  assert.strictEqual(classifyCardScript("import x from 'y'"), 'esm')
  // DOM/facade 判据前置于 esm：带 import 的界面模块不算 esm（不许误投服务端 ESM 沙箱）。
  assert.strictEqual(classifyCardScript("import x from 'y'\ndocument.body.innerHTML = ''"), 'browser-ui')
  assert.strictEqual(classifyCardScript('   '), 'empty')
  const marked = new Set(['b'])
  const selected = projectServerScripts([
    { id: 'a', name: 'calc', content: 'const a = 1' },
    { id: 'b', name: 'ui-marked', content: 'const b = 2' },
    { id: 'c', name: 'dom', content: 'document.body.innerHTML = ""' },
    { id: 'd', name: 'esm', content: "import z from 'z'" },
    { id: 'e', name: 'mvu', content: 'const e = 1' }
  ], { isHostOwnedMvu: script => script.name === 'mvu', store: { lookupScript: (_cardPath, id) => marked.has(id) }, cardPath: 'cards/fixture.png' })
  // esm 现由服务端 ESM 沙箱执行（projectServerScripts 收它并打 kind:'esm' 标记；浏览器侧不再下发，
  // 见 storageBrowserScripts 与 esm-server-consumer.test.mjs:28）。仍排除：DOM、被 DOM 标记、宿主 MVU 核心。
  assert.deepStrictEqual(selected.map(item => item.id), ['a', 'd'])
  assert.strictEqual(Object.hasOwn(selected[0], 'kind'), false, 'server-compute 不打 kind 标记')
  assert.strictEqual(selected[1].kind, 'esm', 'esm 脚本必须带 kind 标记（服务端沙箱据此分派）')
})

await test('释放安全：等待钩子注册期间被 disposeSession ⇒ 拒绝（不挂起、不提交）', async () => {
  const draft = fixtureChat()
  const before = JSON.parse(JSON.stringify(draft.messages[1].variables))
  const { execution, runtimeFactory } = harness({ plan: { registerHooks: false, hookLoadBudgetMs: 5000 } })
  const pending = execution.executeMvuUpdate(callInput(draft))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.strictEqual(execution.disposeSession('s1'), 1)
  await rejects(pending, error => codeOf(error) === SERVER_EXECUTION_ERRORS.lateWrite, '释放期间等待')
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
  assert.deepStrictEqual(draft.messages[1].variables, before)
  assert.deepStrictEqual(execution.stats().bindings, 0)
})

await test('生命周期通道：MESSAGE_SENT 走服务端钩子（Host 变更 API 提交，非事务 eventId）', async () => {
  const chat = fixtureChat()
  const captured = {}
  const { execution, runtimeFactory, hostCalls } = harness({
    plan: {
      registerHooks: runtime => runtime.events.push({ event: 'MESSAGE_SENT', handler() {}, source: 'fixture' }),
      onEvent: 'MESSAGE_SENT',
      onDispatch: async ({ hostApi, eventArgs }) => {
        captured.arg = eventArgs[0]
        await hostApi.replaceVariables({ sent: true }, { type: 'message' })
      }
    }
  })
  const result = await execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_SENT', args: [2] })
  assert.strictEqual(result.handled, true)
  assert.strictEqual(result.event, 'MESSAGE_SENT')
  assert.strictEqual(captured.arg, 2)
  assert.strictEqual(hostCalls.updateVariables[0][4], '', '生命周期写走非事务 eventId（与浏览器 RPC 同形）')
  assert.strictEqual(runtimeFactory.created[0].disposed, true, '即用即毁：事件结束释放 runtime')
  assert.deepStrictEqual(execution.stats().bindings, 0)
})

await test('生命周期通道：可用 options.resolveChat 兜底取聊天（不传 chat 也能派发）', async () => {
  const chat = fixtureChat()
  const { execution, runtimeFactory } = harness({
    execution: { resolveChat: async sessionId => (sessionId === 's1' ? chat : undefined) },
    plan: { registerHooks: runtime => runtime.events.push({ event: 'MESSAGE_DELETED', handler() {}, source: 'fixture' }), onEvent: 'MESSAGE_DELETED' }
  })
  const result = await execution.dispatchLifecycleEvent({ sessionId: 's1', event: 'MESSAGE_DELETED', args: [1] })
  assert.strictEqual(result.event, 'MESSAGE_DELETED')
  assert.strictEqual(runtimeFactory.events[0].event, 'MESSAGE_DELETED')
})

await test('生命周期通道：变量核心事件不得走本通道；有结算在飞时返回 busy（不并发）', async () => {
  const chat = fixtureChat()
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  const { execution } = harness({ plan: { onDispatch: async () => { await gate } } })
  await rejects(execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_RECEIVED' }),
    error => codeOf(error) === SERVER_EXECUTION_ERRORS.badInput, '核心事件走生命周期通道')
  const settling = execution.executeMvuUpdate(callInput(chat))
  await new Promise(resolve => setTimeout(resolve, 5))
  // busy 必须 reject（不静默跳过），否则调用方会以为事件已派发
  await rejects(execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_SENT' }),
    error => codeOf(error) === SERVER_EXECUTION_ERRORS.busy, '结算在飞时的生命周期派发')
  release()
  await settling
})

await test('核心事件桥：命令前建 runtime，STARTED/PARSED/SINGLE/ENDED 全投当前 runtime（不多派 ENDED）', async () => {
  const draft = fixtureChat()
  const { execution, runtimeFactory } = harness({ plan: { onEvent: '*' } })
  const result = await execution.executeMvuUpdate(callInput(draft))
  const dispatched = runtimeFactory.events.map(item => item.event)
  // MESSAGE_RECEIVED 是 2026-10-04 落地的**内联派发**（server-execution L1203：core 成功、
  // BEFORE_MESSAGE_UPDATE 之后、提交之前，给投影后的卡钩子补一次）。它与变量核心事件同投当前
  // runtime，因此必须在本列表里；只由核心 emit 一次的仍然是 ENDED（下面单独断言）。
  assert.deepStrictEqual(dispatched, [
    SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_STARTED,
    SERVER_EXECUTION_EVENTS.COMMAND_PARSED,
    SERVER_EXECUTION_EVENTS.SINGLE_VARIABLE_UPDATED,
    SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
    SERVER_EXECUTION_EVENTS.BEFORE_MESSAGE_UPDATE,
    'MESSAGE_RECEIVED'
  ])
  assert.strictEqual(runtimeFactory.events.filter(item => item.event === SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED).length, 1, 'ENDED 只由核心 emit 一次')
  assert.strictEqual(runtimeFactory.events.filter(item => item.event === 'MESSAGE_RECEIVED').length, 1, 'MESSAGE_RECEIVED 恰好补派一次（不重复 core）')
  assert.strictEqual(runtimeFactory.events.every(item => item.strict === true), true, '全部以 strict 第一参派发')
  assert.strictEqual(result.hooks.hooks >= 1, true)
})

await test('BEFORE_MESSAGE_UPDATE：仅在「有修改且非 user 楼」触发一次，可改写 message_content（不静默丢）', async () => {
  const draft = fixtureChat()
  const captured = []
  const { execution, runtimeFactory } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.BEFORE_MESSAGE_UPDATE,
      onDispatch: ({ eventArgs }) => { captured.push(eventArgs[0]); eventArgs[0].message_content = '改写后的正文' }
    }
  })
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(captured.length, 1, '只触发一次')
  assert.deepStrictEqual(Object.keys(captured[0]).sort(), ['message_content', 'variables'])
  assert.deepStrictEqual(result.beforeMessageUpdate, { changed: true, messageContent: '改写后的正文' })
  assert.strictEqual(result.diagnostics.some(item => /BEFORE_MESSAGE_UPDATE 改写了正文/.test(item.message)), true, '改写要透出诊断，不静默丢')
  // user 楼不触发（上游 update_variables.ts 条件：role !== 'user'）
  const userDraft = fixtureChat()
  const userHarness = harness({ plan: { onEvent: SERVER_EXECUTION_EVENTS.BEFORE_MESSAGE_UPDATE, onDispatch: () => { throw new Error('user 楼不应触发') } } })
  await userHarness.execution.executeMvuUpdate({ ...callInput(userDraft), messageId: 0, swipeId: 0 })
  assert.strictEqual(userHarness.runtimeFactory.events.some(item => item.event === SERVER_EXECUTION_EVENTS.BEFORE_MESSAGE_UPDATE), false)
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
})

await test('view 投影：storageBrowserScripts 只下发 browser-ui（esm 已归服务端） 与 mvu.serverOwned（前端不初始化浏览器核心）', () => {
  const scripts = [
    { id: 'a', name: 'calc', content: 'const a = 1' },
    { id: 'b', name: 'ui', content: 'document.body.innerHTML = ""' },
    { id: 'c', name: 'esm', content: "import z from 'z'" },
    { id: 'd', name: 'mvu', content: 'const d = 1' }
  ]
  const owned = script => script.name === 'mvu'
  // 浏览器侧只下发 browser-ui：esm 已改由服务端 ESM 沙箱执行，不再两端都跑（同判据见 projectServerScripts）。
  assert.deepStrictEqual(storageBrowserScripts(scripts, { isHostOwnedMvu: owned }).map(item => [item.id, item.kind]),
    [['b', 'browser-ui']])
  const ownership = mvuRuntimeOwnership({ chat: { cardPath: 'cards/x.png', mvu: { enabled: true } }, scripts, isHostOwnedMvu: owned })
  assert.strictEqual(ownership.serverOwned, true)
  assert.strictEqual(ownership.enabled, true)
  assert.deepStrictEqual(ownership.serverScripts.map(item => item.id), ['a', 'c'])
  assert.deepStrictEqual(ownership.browserScripts.map(item => item.id), ['b'])
})

await test('模块级便捷入口：同一 host 身份复用实例（busy 互斥可见）+ 生命周期即用即毁', async () => {
  const draft = fixtureChat()
  const host = {
    updateVariables: async () => ({ updated: true }), updateMessages: async () => ({ updated: true }),
    createMessages: async () => ({ updated: true })
  }
  const coreCalls = []
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  const runtimeFactory = fakeRuntimeFactory({
    registerHooks: runtime => runtime.events.push({ event: 'MESSAGE_SENT', handler() {}, source: 'fixture' }),
    onDispatch: async () => { await gate }
  })
  const deps = {
    host, createRuntime: runtimeFactory, hookLoadBudgetMs: 0,
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    readCardExtensions: async () => ({ helperScripts: [{ id: 'srv', name: 'srv', type: 'script', content: 'const a = 1' }] }),
    executeCommand: async (text, variables, emitter) => {
      coreCalls.push(text)
      variables.stat_data = { ok: 1 }
      if (typeof emitter === 'function') await emitter(SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED, variables, {})
    }
  }
  const running = executeServerSettlement({ ...deps, ...callInput(draft) })
  await new Promise(resolve => setTimeout(resolve, 5))
  // 同一 host 身份 ⇒ 同一实例 ⇒ 同 session+event 重入被 busy 拒绝（证明实例被复用，不是每次新建）
  await rejects(executeServerSettlement({ ...deps, ...callInput(draft) }),
    error => codeOf(error) === SERVER_EXECUTION_ERRORS.busy, '同 host 重入')
  release()
  const settled = await running
  assert.strictEqual(settled.mode, 'server-compute')
  assert.deepStrictEqual(coreCalls, ['story\n\n<json_patch/>'])
  const lifecycle = await executeServerLifecycle({ ...deps, sessionId: 's1', chat: draft, event: 'MESSAGE_SENT' })
  assert.strictEqual(lifecycle.event, 'MESSAGE_SENT')
  assert.strictEqual(runtimeFactory.instances, 2, '结算 1 个 + 生命周期 1 个（生命周期即用即毁）')
  assert.strictEqual(runtimeFactory.created[1].disposed, true)
  assert.strictEqual(releaseServerSettlement('s1'), 0)
  assert.strictEqual(releaseServerSettlement(), 0)
})

await test('emitter 契约：无钩子时也传 no-op 函数（绝不传 null 回落全局 emit）', async () => {
  const draft = fixtureChat()
  let emitterType = 'missing'
  const { execution } = harness({
    plan: { registerHooks: false },
    execution: {
      executeCommand: async (text, variables, emitter) => { emitterType = typeof emitter; variables.stat_data = { ok: 1 }; return true }
    }
  })
  await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(emitterType, 'function', 'core 第 3 参必须是函数（no-op），不是 null/undefined')
})

await test('BEFORE_MESSAGE_UPDATE 改写 + preserveForeground ⇒ 显式拒绝（不 overwrite、不静默丢弃）', async () => {
  const draft = fixtureChat()
  const before = JSON.parse(JSON.stringify(draft.messages[1].variables))
  const { execution } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.BEFORE_MESSAGE_UPDATE,
      onDispatch: ({ eventArgs }) => { eventArgs[0].message_content = '改写后的正文' }
    }
  })
  await rejects(execution.executeMvuUpdate({ ...callInput(draft), preserveForeground: true }),
    error => codeOf(error) === SERVER_EXECUTION_ERRORS.unsupported, 'preserveForeground + 正文改写')
  assert.deepStrictEqual(draft.messages[1].variables, before, '拒绝路径不提交')
})

await test('生命周期回执带 browserScripts：纯计算卡为 0（调用方据此免下发浏览器）', async () => {
  const chat = fixtureChat()
  const { execution } = harness({
    plan: { registerHooks: runtime => runtime.events.push({ event: 'MESSAGE_SENT', handler() {}, source: 'fixture' }), onEvent: 'MESSAGE_SENT' }
  })
  const result = await execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_SENT' })
  assert.strictEqual(result.browserScripts, 0)
  const browserOnly = harness({
    execution: { readCardExtensions: async () => ({ helperScripts: [{ id: 'ui', name: 'ui', type: 'script', content: 'document.body.innerHTML = ""', enabled: true }] }) },
    plan: { registerHooks: false }
  })
  const second = await browserOnly.execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_SENT' })
  assert.strictEqual(second.browserScripts, 1, '纯 browser-ui 卡：服务端无钩子但仍报告浏览器脚本数')
  assert.strictEqual(second.handled, false)
})

await test('生产 bug 修复：钩子读的是权威树（core 改过的），且钩子写不被最终写回覆盖', async () => {
  const draft = fixtureChat()
  const seen = {}
  const { execution, hostCalls } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async ({ hostApi }) => {
        // core 已把 好感度 改成 7（同一个对象）⇒ 钩子必须读到 7，而不是建立绑定时的旧值 1
        seen.read = hostApi.getVariables().stat_data.好感度
        await hostApi.replaceVariables({ stat_data: { 好感度: 7, 派生: 14 }, schema: { type: 'object' } }, { type: 'message' })
        seen.afterWrite = hostApi.getVariables().stat_data.派生
      }
    }
  })
  const draftMessage = draft.messages[1]
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(seen.read, 7, '钩子读到 core 之后的权威树')
  assert.strictEqual(seen.afterWrite, 14, '钩子写入后自己也能读到（同一权威树）')
  assert.strictEqual(result.variables.stat_data.派生, 14, '钩子写不被最终写回覆盖')
  assert.strictEqual(draftMessage.variables[0].stat_data.派生, 14, '草稿楼层槽位拿到权威树（含钩子写）')
  assert.strictEqual(hostCalls.updateVariables.length, 1, '钩子写仍然走 Host 变更 API（CAS/校验/跟踪）')
})

await test('权威树写回：宿主替换楼层树对象后，槽位重新指回权威对象（不丢 core 后续写）', async () => {
  const draft = fixtureChat()
  const { execution } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async ({ hostApi }) => {
        await hostApi.replaceVariables({ stat_data: { 好感度: 7 }, schema: { type: 'object' }, replaced: true }, { type: 'message' })
      }
    },
    execution: {
      host: {
        // 模拟适配器事务写：把楼层里的树**替换成另一个对象**（正是丢写的来源）
        updateVariables: async (_sessionId, option, variables) => {
          draft.messages[option.message_id].variables[option.swipe_id ?? 0] = JSON.parse(JSON.stringify(variables))
          return { updated: true }
        },
        updateMessages: async () => ({ updated: true }),
        createMessages: async () => ({ updated: true })
      }
    }
  })
  const result = await execution.executeMvuUpdate(callInput(draft))
  const slot = draft.messages[1].variables[0]
  assert.strictEqual(slot.replaced, true, '替换写进去了')
  assert.strictEqual(slot.stat_data.好感度, 7)
  assert.strictEqual(result.variables.replaced, true, '回执里也是权威树的最终内容')
})

await test('disposeAll：终止位拒绝新工作 + 在飞 await 结束后不再提交（迟到提交被堵）', async () => {
  const draft = fixtureChat()
  const before = JSON.parse(JSON.stringify(draft.messages[1].variables))
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  const { execution, runtimeFactory } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async () => { await gate }   // 卡在钩子里 ⇒ 结算处于 await 中
    }
  })
  const running = execution.executeMvuUpdate(callInput(draft))
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.strictEqual(execution.disposeAll(), 1, '释放了在飞绑定')
  // 新工作必须被拒绝（此前 disposeAll 只清表，新结算照样能开）
  await rejects(execution.executeMvuUpdate(callInput(draft, { transaction: { eventId: 'mvu-work:op-2', draft } })),
    error => codeOf(error) === SERVER_EXECUTION_ERRORS.disposed, 'dispose 后新工作')
  release()
  await rejects(running, error => [SERVER_EXECUTION_ERRORS.lateWrite, SERVER_EXECUTION_ERRORS.disposed].includes(codeOf(error)), '在飞执行收尾')
  assert.deepStrictEqual(draft.messages[1].variables, before, 'await 结束后不许再写回目标楼')
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
})

await test('加载失败必须阻断：非 DOM 的加载错误在变量核心之前抛错（不伪成功、不提交）', async () => {
  const draft = fixtureChat()
  const { execution, coreCalls } = harness({ plan: { errors: [{ source: '坏脚本', error: 'SyntaxError: Unexpected token' }] } })
  const error = await rejects(execution.executeMvuUpdate(callInput(draft)),
    e => codeOf(e) === SERVER_EXECUTION_ERRORS.loadFailed, '加载失败')
  assert.match(error.message, /加载失败/)
  assert.match(error.message, /坏脚本/)
  assert.strictEqual(coreCalls.length, 0, '加载失败后不允许继续变量核心')
})

await test('DOM 探针加载（脚本其实是界面脚本）⇒ 抛错重试 + 落 browser-ui 标记（不提交成功回执）', async () => {
  const draft = fixtureChat()
  const marked = []
  const { execution, coreCalls } = harness({
    plan: { errors: [{ source: 'srv', error: '转浏览器', domProbe: true }], loadDomProbe: 'srv', registerHooks: false },
    execution: {
      cardScriptDispatchStore: {
        lookupCard: () => null, lookupScript: () => null,
        markScript: (...args) => marked.push(args), markCard: () => {}
      }
    }
  })
  const error = await rejects(execution.executeMvuUpdate(callInput(draft)),
    e => codeOf(e) === SERVER_EXECUTION_ERRORS.loadFailed, 'DOM 探针加载')
  assert.match(error.message, /DOM 探针/)
  // 措辞随 impl 演进而变（历史上是「下一轮该脚本走浏览器」，现为「后续交浏览器」/明细里的「转浏览器」）；
  // 断言的是**语义**：必须告诉调用方该脚本改走浏览器，不许静默丢弃。
  assert.match(error.message, /(下一轮该脚本走浏览器|后续交浏览器|转浏览器)/, 'DOM 探针消息必须说明该脚本改走浏览器（不静默丢弃）')
  assert.strictEqual(coreCalls.length, 0, '钩子没跑的这一轮不许变量核心成功回执')
  assert.strictEqual(marked.length, 1, '标记已落（下一轮走浏览器，不再重复失败）')
})

await test('生成上下文 DI：readGenerationContext(binding) 的投影经 wrapGenerateRaw 交给宿主（脚本看不到 binding）', async () => {
  const draft = fixtureChat()
  const seen = {}
  const { execution } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async ({ hostApi }) => { seen.out = await hostApi.generateRaw({ user_input: 'hi' }) }
    },
    execution: {
      readGenerationContext: async binding => {
        seen.binding = { sessionId: binding.sessionId, messageId: binding.messageId, hasChat: Boolean(binding.chat) }
        return { messages: [{ role: 'assistant', content: 'read-your-writes' }] }
      },
      generateRaw: async (config, context) => { seen.hostContext = context; return 'OK' }
    }
  })
  await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(seen.out, 'OK')
  assert.deepStrictEqual(seen.binding, { sessionId: 's1', messageId: 1, hasChat: true })
  assert.deepStrictEqual(seen.hostContext.context, { messages: [{ role: 'assistant', content: 'read-your-writes' }] })
  assert.strictEqual(seen.hostContext.sessionId, 's1')
  assert.strictEqual(seen.hostContext.eventId, 'mvu-work:op-1')
})

await test('递归守卫：hook 内写导致的变更不递归派发；操作结束后 isSessionBusy=false', async () => {
  const chat = fixtureChat()
  let sawBusyDuring = null
  const { execution, runtimeFactory } = harness({
    plan: {
      registerHooks: runtime => runtime.events.push({ event: 'MESSAGE_SENT', handler() {}, source: 'fixture' }),
      onEvent: 'MESSAGE_SENT',
      onDispatch: () => { sawBusyDuring = execution.isSessionBusy('s1') }
    }
  })
  assert.strictEqual(execution.isSessionBusy('s1'), false)
  await execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_SENT' })
  assert.strictEqual(sawBusyDuring, true, '钩子跑的时候会话是忙的（据此跳过递归派发）')
  assert.strictEqual(execution.isSessionBusy('s1'), false, '操作结束后不再忙')
  assert.strictEqual(runtimeFactory.created[0].disposed, true)
})

await test('卡级 DOM 标记：生命周期回执 browserScripts 非 0（不许吞掉已判给浏览器的卡）', async () => {
  const chat = fixtureChat()
  const { execution } = harness({
    plan: { registerHooks: false },
    execution: { cardScriptDispatchStore: { lookupCard: () => ({ reason: 'dom-probe' }), lookupScript: () => null } }
  })
  const result = await execution.dispatchLifecycleEvent({ sessionId: 's1', chat, event: 'MESSAGE_SENT' })
  assert.notStrictEqual(result.browserScripts, 0, '整卡判给浏览器 ⇒ 回执必须 >0')
  assert.strictEqual(result.handled, false)
})

await test('统一投影：store 标记的脚本出现在浏览器侧结果里（两端都不跑的缺口堵死）', () => {
  const scripts = [
    { id: 'calc', name: 'calc', content: 'const a = 1' },
    { id: 'marked', name: 'marked', content: 'const b = 2' }
  ]
  const store = { lookupScript: (_cardPath, id) => (id === 'marked' ? { reason: 'dom-probe-hook' } : null) }
  const browser = storageBrowserScripts(scripts, { store, cardPath: 'cards/x.png' })
  assert.deepStrictEqual(browser.map(item => [item.id, item.kind]), [['marked', 'browser-ui']])
  assert.deepStrictEqual(projectServerScripts(scripts, { store, cardPath: 'cards/x.png' }).map(item => item.id), ['calc'])
  assert.strictEqual(effectiveScriptKind(scripts[1], { store, cardPath: 'cards/x.png' }), 'browser-ui', '标记即 browser-ui（同一判据）')
})

await test('迟到采纳：宿主写 await 期间被 dispose ⇒ 拒绝且不采纳（assertOpen 在 await 之后）', async () => {
  const draft = fixtureChat()
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  let inside = false
  const { execution } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async ({ hostApi }) => {
        inside = true
        try { await hostApi.replaceVariables({ stat_data: { 好感度: 999 } }, { type: 'message' }) } catch { /* 预期被拒 */ }
      }
    },
    execution: {
      host: {
        updateVariables: async () => { await gate; return { updated: true } },
        updateMessages: async () => ({ updated: true }),
        createMessages: async () => ({ updated: true })
      }
    }
  })
  const running = execution.executeMvuUpdate(callInput(draft))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.strictEqual(inside, true, '钩子里已进入宿主写')
  execution.disposeAll()
  release()
  await rejects(running, error => [SERVER_EXECUTION_ERRORS.lateWrite, SERVER_EXECUTION_ERRORS.disposed].includes(codeOf(error)), '释放后的在飞写')
})

await test('写目标归一：latest/负数归一到当前楼；别的 swipe 的写不采纳进权威树', async () => {
  const draft = fixtureChat()
  draft.messages[1].variables = [{ stat_data: { 好感度: 1 } }, { stat_data: { 好感度: 2 } }]
  const seen = {}
  const { execution, hostCalls } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async ({ hostApi }) => {
        await hostApi.replaceVariables({ stat_data: { 好感度: 50 } }, { type: 'message', message_id: 'latest', swipe_id: 0 })
        await hostApi.replaceVariables({ stat_data: { 好感度: 99 } }, { type: 'message', message_id: 1, swipe_id: 1 })
        seen.after = hostApi.getVariables().stat_data.好感度
      }
    }
  })
  const result = await execution.executeMvuUpdate(callInput(draft))
  assert.strictEqual(hostCalls.updateVariables[0][1].message_id, 1, "'latest' 归一成当前楼层号")
  assert.strictEqual(seen.after, 50, '本楼本 swipe 的写生效')
  assert.strictEqual(result.variables.stat_data.好感度, 50, '别的 swipe 的写没有采纳进权威树')
})

await test('同 operation 令牌：本模块签发才认（伪造/外部参数不是授权）；busy 外部写在写之前被拒', async () => {
  const draft = fixtureChat()
  const seen = {}
  const { execution, hostCalls } = harness({
    plan: {
      onEvent: SERVER_EXECUTION_EVENTS.VARIABLE_UPDATE_ENDED,
      onDispatch: async ({ hostApi }) => {
        await hostApi.setChatMessages(1, [{ message: '改正文' }])
        seen.busy = execution.isSessionBusy('s1')
      }
    }
  })
  await execution.executeMvuUpdate(callInput(draft))
  const meta = hostCalls.updateMessages[0][4]
  assert.strictEqual(execution.isOwnOperation(meta), true, '本模块签发的令牌 ⇒ 同 operation')
  assert.strictEqual(execution.isOwnOperation({ serverOperation: meta.serverOperation }), false, '伪造同形对象不认')
  assert.strictEqual(execution.isOwnOperation(undefined), false, 'RPC 4 参调用（无令牌）不认')
  assert.strictEqual(execution.isOwnOperation('mvu-work:op-1'), false, '字符串参数不是授权')
  assert.strictEqual(seen.busy, true, 'hook 内写时会话在忙')
  // 外部并发：无令牌 + 会话在忙 ⇒ 变换后的入口会在写之前抛 busy（谓词即该判定）
  assert.strictEqual(execution.isSessionBusy('s1'), false, '操作结束后不再忙')
})

// 拆除守卫（方案 B，2026-10-06 真机踩坑后补）：软拆除（窗口释放/取消/迟到写）时抛出的错误必须
// 带 `mvuReceipt={status:'interrupted'}`——作者失败出口认这个字段（作者 `lib/index.js:2805`
// `receipt: err?.mvuReceipt ? … : {status:'error'}`），从而把 `pending:false + status='interrupted'`
// 落回目标消息，不再出现“永久变量结算中”。真实业务失败不得挂 interrupted（那些走作者 error 出口）。
await test('拆除守卫：软拆除抛错带 interrupted receipt；真实业务失败不挂', async () => {
  const baseDeps = executeCommand => ({
    host: {
      updateVariables: async () => ({ updated: true }), updateMessages: async () => ({ updated: true }),
      createMessages: async () => ({ updated: true })
    },
    hookLoadBudgetMs: 0,
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    readCardExtensions: async () => ({ helperScripts: [] }),
    executeCommand
  })
  const torn = fixtureChat()
  await rejects(
    executeServerSettlement({
      ...baseDeps(async () => {
        const error = new Error('结算窗口已释放，本轮结算中断')
        error.code = SERVER_EXECUTION_ERRORS.disposed
        throw error
      }),
      ...callInput(torn), diagnosticId: 'diag-interrupted'
    }),
    error => error.mvuReceipt?.status === 'interrupted'
      && error.mvuReceipt.summary === '变量结算已中断'
      && error.mvuReceipt.diagnosticId === 'diag-interrupted'
      && Array.isArray(error.mvuReceipt.changes) && error.mvuReceipt.changes.length === 0,
    '软拆除 ⇒ interrupted receipt'
  )
  const genuine = fixtureChat()
  await rejects(
    executeServerSettlement({
      ...baseDeps(async () => {
        const error = new Error('卡脚本核心执行失败')
        error.code = SERVER_EXECUTION_ERRORS.coreFailed
        throw error
      }),
      ...callInput(genuine)
    }),
    error => error.mvuReceipt === undefined && codeOf(error) === SERVER_EXECUTION_ERRORS.coreFailed,
    '真实业务失败不挂 interrupted'
  )
})

// 撤回误判根因添加的等待闸，保留真正的并发契约：同key/lifecycle快速busy拒绝、
// 不同会话独立、不同eventId的直接嵌套计算不自等。计算日志不用于证明外层提交成功。
await test('并发护栏：结算链路内重入 lifecycle 被拒（排队重试语义，不自等死锁）', async () => {
  const order = []
  const host = {
    updateVariables: async () => ({ updated: true }), updateMessages: async () => ({ updated: true }),
    createMessages: async () => ({ updated: true })
  }
  const deps = {
    host, createRuntime: fakeRuntimeFactory(), hookLoadBudgetMs: 0,
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    readCardExtensions: async () => ({ helperScripts: [] }),
    executeCommand: async (text, variables) => {
      try {
        await executeServerLifecycle({ ...deps, sessionId: 's1', chat: fixtureChat(), event: 'MESSAGE_SENT' })
        order.push('unexpected-pass')
      } catch (error) {
        order.push('refused:' + String(error && error.message).slice(0, 24))
      }
      variables.stat_data = { ok: 1 }
    }
  }
  const result = await executeServerSettlement({ ...deps, ...callInput(fixtureChat()) })
  assert.strictEqual(result.handled, true)
  assert(order.some(entry => String(entry).startsWith('refused:该会话的 MVU 结算正在进行')), '结算在飞时 lifecycle 应被拒（请排队后重试）')
  assert(!order.includes('unexpected-pass'), '不得放行并发 lifecycle')
})

await test('并发护栏：他会话 lifecycle 不受结算影响', async () => {
  let releaseSettle = () => {}
  const gate = new Promise(resolve => { releaseSettle = resolve })
  const host = {
    updateVariables: async () => ({ updated: true }), updateMessages: async () => ({ updated: true }),
    createMessages: async () => ({ updated: true })
  }
  const deps = {
    host, createRuntime: fakeRuntimeFactory(), hookLoadBudgetMs: 0,
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    readCardExtensions: async () => ({ helperScripts: [] }),
    executeCommand: async (text, variables) => { await gate; variables.stat_data = { ok: 1 } }
  }
  const settle = executeServerSettlement({ ...deps, ...callInput(fixtureChat()) })
  await new Promise(resolve => setTimeout(resolve, 30))
  const fast = await Promise.race([
    executeServerLifecycle({ ...deps, sessionId: 's2', chat: fixtureChat(), event: 'MESSAGE_SENT' }).then(() => 'done'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 2000))
  ])
  assert.strictEqual(fast, 'done', 's2 的 lifecycle 不应被 s1 的结算阻塞')
  releaseSettle()
  await settle
})

await test('并发护栏：不同 eventId 的直接嵌套计算不自等', async () => {
  const order = []
  const host = {
    updateVariables: async () => ({ updated: true }), updateMessages: async () => ({ updated: true }),
    createMessages: async () => ({ updated: true })
  }
  let depth = 0
  const deps = {
    host, createRuntime: fakeRuntimeFactory(), hookLoadBudgetMs: 0,
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    readCardExtensions: async () => ({ helperScripts: [] }),
    // 深度闸：同一实例的 executeCommand 是首调定型的实例级 DI，嵌套结算会复用它——
    // 不加闸会自递归（第二层被 busy 重入保护拦下，属正确行为，但会把外层带挂）。
    executeCommand: async (text, variables) => {
      depth += 1
      order.push('core-depth' + depth)
      if (depth === 1) {
        const nestedResult = await executeServerSettlement({
          ...deps, ...callInput(fixtureChat(), { transaction: { eventId: 'mvu-work:inline-n', draft: fixtureChat() }, eventId: 'mvu-work:inline-n' })
        })
        order.push('nested-handled=' + nestedResult.handled)
      }
      variables.stat_data = { ok: depth }
    }
  }
  const result = await executeServerSettlement({ ...deps, ...callInput(fixtureChat()) })
  assert.strictEqual(result.handled, true)
  assert(order.includes('core-depth2'), '嵌套派发应真正执行（走到核心）')
  assert(order.includes('nested-handled=true'), '嵌套计算应在外层等待其结果时完成（无自等死锁）')
  assert(order.indexOf('core-depth2') < order.indexOf('nested-handled=true'))
})

console.log('\n服务端执行 + 核心运行时接缝：' + passed + ' 组通过 / ' + failed + ' 组失败')
if (failed > 0) process.exitCode = 1
