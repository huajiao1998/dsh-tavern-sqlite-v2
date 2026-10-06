// 最新上游运行时接缝定向闸（2026-10-07）：三代固定作者树上的 core-runtime 纯变换 + dispatchEvent 行为断言。
//
// 范围：只调 deploy/core-runtime-transform.mjs 的纯变换；再从变换产物里**精确截取 dispatchEvent 函数**，
// 用 Function 注入假 options / serverExecution / context / str / settlementTransactions 观察调用轨迹。
// 不写盘、不装插件、不连现场、不跑真实消费者、不碰真实存档与服务。
// 覆盖：① 三代真源变换落地 + 幂等 + 只解析（import 不链接）② 未知/重复 dispatchEvent 布局拒绝
//   ③ 旧施缝升级补 [dsh-tavern-browser-recent-context:v1] 逐字节收敛 ④ server 先跑（完整 chat）→ 浏览器后取
//   recent 窗口 contextWindow ⑤ browserScripts===0 立即回执 ⑥ MESSAGE_RECEIVED 结构化拒绝 ⑦ busy 阻止。
// **未验证**：真实消费者行为、部署装配、页面/HTTP 结果——本闸不构成那些层面的证据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { applyRuntimeTransform } from '../deploy/core-runtime-transform.mjs'

const AUTHOR_ROOT = new URL('../../../tmp/upstream25-author-fixture/src/', import.meta.url)
const SHA_OLD = '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const SHA_MID = '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544'
const SHA_NEW = '5c69907994df9f432b8898168ce5dff371929c2a'
const OLD_TREES = [SHA_OLD, SHA_MID]
const ADAPTER_REL = 'tavern-plugin/lib/domain/tavern-script-host-adapter.js'
const adapterUrl = sha => new URL('dsh-tavern-' + sha + '/' + ADAPTER_REL, AUTHOR_ROOT)
for (const sha of [...OLD_TREES, SHA_NEW]) {
  if (!existsSync(adapterUrl(sha))) {
    throw new Error('缺三代作者树夹具：' + sha + '/' + ADAPTER_REL + '（按 loud 失败处理，不 skip）')
  }
}
const readAdapter = sha => readFileSync(adapterUrl(sha), 'utf8')

const DISPATCH_SIG = '  async function dispatchEvent(input = {}) {'
const RECENT_MARKER = '// [dsh-tavern-browser-recent-context:v1]'
const RECENT_LINE = '    const recent = input.recent === true ? await options.resolveHelperWindow?.(input.sessionId) : undefined'
const RECENT_CTX_LINE = '    const eventContext = recent ? { contextWindow: recent } : await context(input.sessionId, input.chat, input.transientUserText)'
const AUTHOR_CTX_LINE = '    const eventContext = input.context || await context(input.sessionId, input.chat, input.transientUserText)'
const AUTHOR_RECENT_CTX_LINE = '    const eventContext = input.context || (recent ? { contextWindow: recent } : await context(input.sessionId, input.chat, input.transientUserText))'
const LEGACY_CTX_LINE = '    const eventContext = await context(input.sessionId, input.chat, input.transientUserText)'
const LEGACY_TAIL = LEGACY_CTX_LINE + '\n    const dispatched = await options.scriptDispatch.dispatch(input.sessionId, input.name, input.args, eventContext)'
const REJECT_MSG = /核心运行时dispatchEvent新旧布局缺失\/混合\/重复，拒绝施缝/
const RECENT_SOURCE_NEEDLE = 'const recent = !input.context && input.recent === true ?'

/** 只解析不链接：SourceTextModule 构造不解析 import、不求值，业务代码不执行。 */
function parseOnly(label, source) {
  assert.equal(typeof vm.SourceTextModule, 'function',
    'vm.SourceTextModule 不可用：本闸须经 node tools/run-plugin-gate.mjs 运行（入口已带 --experimental-vm-modules）')
  const mod = new vm.SourceTextModule(source, { identifier: label })
  assert.equal(mod.status, 'unlinked', label + '：只解析，不链接、不执行')
}

/**
 * 精确截取 dispatchEvent：签名行 → 第一个「2 空格缩进的收尾 }」。
 * 不能用「下一函数」当边界——变换产物在 dispatchEvent 之后还插入了适配器级
 * `const serverExecution = createServerExecution({...})`，那是顶层语句、不是函数。
 */
function sliceDispatchEvent(source, label) {
  const lines = source.split('\n')
  const start = lines.indexOf(DISPATCH_SIG)
  assert.notEqual(start, -1, label + '：找不到 dispatchEvent 签名行（布局变了？）')
  let end = start + 1
  while (end < lines.length && lines[end] !== '  }') end++
  assert.notEqual(end, lines.length, label + '：dispatchEvent 函数体没有 2 空格缩进的收尾 }')
  const block = lines.slice(start, end + 1).join('\n')
  assert.equal(block.split(DISPATCH_SIG).length - 1, 1, label + '：截取块必须恰含一个 dispatchEvent 签名')
  assert.equal(block.includes('const serverExecution = createServerExecution'), false,
    label + '：截取必须止于 dispatchEvent，不得带入适配器级 serverExecution 构造')
  return block
}

/** 变换产物 → 可独立调用的 dispatchEvent（DI 全假件，不 import 作者树、不跑真实业务）。 */
function makeDispatch(source, deps) {
  const block = sliceDispatchEvent(source, 'dispatch')
  const factory = new Function('options', 'serverExecution', 'context', 'str', 'settlementTransactions',
    block + '\n  return dispatchEvent\n')
  return factory(deps.options, deps.serverExecution, deps.context,
    deps.str ?? (value => (value == null ? '' : String(value))), deps.settlementTransactions ?? new Set())
}

/** 假 DI + 调用轨迹：server / browser / window / context 各自记账，供"谁先谁后、拿到什么"断言。 */
function makeHarness(sha, { serverResult, busy = false } = {}) {
  const trace = []
  const fullChat = { chatId: 'chat-1', marker: 'FULL-CHAT' }
  const recentWindow = { chatId: 'chat-1', marker: 'RECENT-WINDOW' }
  const sparseWindow = { chatId: 'chat-1', marker: 'SERVER-SPARSE-PROJECTION' }
  const seen = { server: null, browser: null, window: null, context: null, resolveChat: null }
  const options = {
    resolveChat: async sessionId => { trace.push('resolveChat'); seen.resolveChat = sessionId; return fullChat },
    resolveHelperWindow: async sessionId => { trace.push('resolveHelperWindow'); seen.window = sessionId; return recentWindow },
    scriptDispatch: {
      dispatch: async (sessionId, name, args, eventContext) => {
        trace.push('browser')
        seen.browser = { sessionId, name, args, eventContext }
        return { handled: true }
      },
    },
  }
  const serverExecution = {
    dispatchLifecycleEvent: async input => {
      trace.push('server')
      seen.server = input
      return serverResult ?? { handled: true, browserScripts: 2, hooks: ['hook-1'] }
    },
  }
  const context = async (sessionId, chat, transient) => {
    trace.push('context')
    seen.context = { sessionId, chat, transient }
    return sparseWindow
  }
  const dispatch = makeDispatch(applyRuntimeTransform(readAdapter(sha)), {
    options, serverExecution, context, settlementTransactions: busy ? new Set(['session-1']) : new Set(),
  })
  return { dispatch, trace, seen, fullChat, recentWindow, sparseWindow }
}

test('三代夹具身份：新树独有 recent 布局，两旧树为 input.context 直取布局', () => {
  const fresh = readAdapter(SHA_NEW)
  assert.equal(fresh.split(DISPATCH_SIG).length - 1, 1, '新树 dispatchEvent 签名必须唯一')
  assert.equal(fresh.split(RECENT_SOURCE_NEEDLE).length - 1, 1, '新树必须恰有一处 recent 取窗口分支')
  assert.equal(fresh.split(AUTHOR_RECENT_CTX_LINE).length - 1, 1, '新树必须恰有一处 recent 分流行')
  assert.equal(fresh.includes(AUTHOR_CTX_LINE), false, '新树不得同时保留旧布局行（混排会让锚点判重失效）')
  assert.equal(fresh.includes(RECENT_LINE), false, '新树是作者源、不是变换产物，不得带变换侧 recent 行')
  for (const sha of OLD_TREES) {
    const older = readAdapter(sha)
    assert.equal(older.split(DISPATCH_SIG).length - 1, 1, sha.slice(0, 8) + ' dispatchEvent 签名必须唯一')
    assert.equal(older.includes(RECENT_SOURCE_NEEDLE), false, sha.slice(0, 8) + ' 不应含新树 recent 布局')
    assert.equal(older.split(AUTHOR_CTX_LINE).length - 1, 1, sha.slice(0, 8) + ' 旧布局 eventContext 行必须唯一')
    assert.equal(older.includes(AUTHOR_RECENT_CTX_LINE), false, sha.slice(0, 8) + ' 不得含新树分流行')
  }
})

test('两旧树真源：变换落地（含 recent 消费面标记）+ 幂等 + 只解析不链接', () => {
  for (const sha of OLD_TREES) {
    const label = sha.slice(0, 8)
    const raw = readAdapter(sha)
    const once = applyRuntimeTransform(raw)
    assert.notEqual(once, raw, label + '：变换必须真的落地（不是原样返回）')
    assert.equal(once.split(RECENT_MARKER).length - 1, 1, label + '：recent 消费面标记必须唯一在场')
    assert.equal(once.split(RECENT_LINE).length - 1, 1, label + '：recent 取窗口行必须唯一在场')
    assert.equal(applyRuntimeTransform(once), once, label + '：变换必须幂等')
    parseOnly(label + '-product', once)
  }
})

test('新树真源（recent 布局）：变换必须落地 + 幂等 + 只解析不链接', () => {
  const raw = readAdapter(SHA_NEW)
  let once
  try {
    once = applyRuntimeTransform(raw)
  } catch (error) {
    assert.fail('新树 recent 布局真源变换被拒：' + error.message
      + '（若为 dispatchEvent 锚点缺失，说明 deploy/core-runtime-transform.mjs 的 recent 锚点未逐字覆盖该树布局）')
  }
  assert.notEqual(once, raw, '新树变换必须真的落地（不是原样返回）')
  assert.equal(once.split(RECENT_MARKER).length - 1, 1, '新树产物 recent 消费面标记必须唯一在场')
  assert.equal(applyRuntimeTransform(once), once, '新树变换必须幂等')
  parseOnly('new-product', once)
})

test('未知/重复 dispatchEvent 布局拒绝，且夹具文件零写入', () => {
  const raw = readAdapter(SHA_OLD)
  const lines = raw.split('\n')
  const start = lines.indexOf(DISPATCH_SIG)
  let end = start + 1
  while (end < lines.length && lines[end] !== '  }') end++
  const block = lines.slice(start, end + 1).join('\n')
  const renamed = raw.replace(DISPATCH_SIG, '  async function dispatchEventRenamed(input = {}) {')
  assert.notEqual(renamed, raw, '改签名必须命中真实锚点行')
  assert.throws(() => applyRuntimeTransform(renamed), REJECT_MSG)
  const duplicated = lines.slice(0, end + 1).join('\n') + '\n' + block + '\n' + lines.slice(end + 1).join('\n')
  assert.throws(() => applyRuntimeTransform(duplicated), REJECT_MSG)
  assert.equal(readFileSync(adapterUrl(SHA_OLD), 'utf8'), raw, '拒绝必须发生在写盘之前：夹具文件零变化')
})

test('旧施缝升级：补 recent 消费面后与全量产物逐字节收敛且幂等', () => {
  const raw = readAdapter(SHA_OLD)
  const full = applyRuntimeTransform(raw)
  const lines = full.split('\n')
  const markerAt = lines.findIndex(line => line.includes(RECENT_MARKER))
  assert.notEqual(markerAt, -1, '全量产物必须带 recent 消费面标记')
  const recentAt = lines.findIndex(line => line === RECENT_LINE)
  assert.equal(recentAt, markerAt + 1, '标记行必须紧邻 recent 取窗口行')
  assert.equal(lines[recentAt + 1], RECENT_CTX_LINE, 'recent 行之后必须是 contextWindow 分流行')
  const legacyLines = lines.slice()
  legacyLines.splice(recentAt, 2, LEGACY_CTX_LINE)
  legacyLines.splice(markerAt, 1)
  const legacy = legacyLines.join('\n')
  assert.equal(legacy.includes(RECENT_MARKER), false, '旧施缝样本必须无 recent 消费面标记')
  assert.equal(legacy.split(LEGACY_TAIL).length - 1, 1, '旧施缝消费面必须唯一命中（否则升级锚点不成立）')
  const upgraded = applyRuntimeTransform(legacy)
  assert.equal(upgraded, full, '旧施缝升级必须与全量产物逐字节一致')
  assert.equal(applyRuntimeTransform(upgraded), upgraded, '升级后必须幂等')
  parseOnly('legacy-upgraded', upgraded)
})

test('最新树事件实际路由：recent浏览器刷新，服务端完整chat，半施标记明确拒绝', async () => {
  const h = makeHarness(SHA_NEW)
  await h.dispatch({ sessionId: 'session-1', name: 'MESSAGE_SENT', args: ['new'], recent: true, context: { obsolete: true } })
  assert.deepEqual(h.trace, ['resolveChat', 'server', 'resolveHelperWindow', 'browser'])
  assert.equal(h.seen.server.chat, h.fullChat)
  assert.deepEqual(h.seen.browser.eventContext, { contextWindow: h.recentWindow })
  const full = applyRuntimeTransform(readAdapter(SHA_NEW))
  const broken = full.replace(RECENT_LINE, '    const recent = undefined')
  assert.notEqual(broken, full)
  assert.throws(() => applyRuntimeTransform(broken), /recent消费面标记不完整/)
})

test('变换产物 dispatchEvent：server 先跑（收完整 chat）→ 浏览器后取 recent 窗口，服务端稀疏投影不下发', async () => {
  for (const sha of OLD_TREES) {
    const label = sha.slice(0, 8)
    const h = makeHarness(sha)
    const result = await h.dispatch({ sessionId: 'session-1', name: 'MESSAGE_SENT', args: ['a'], recent: true })
    assert.deepEqual(h.trace, ['resolveChat', 'server', 'resolveHelperWindow', 'browser'],
      label + '：必须先解析完整 chat → 服务端跑完 → 再取浏览器窗口 → 最后下发浏览器')
    assert.equal(h.seen.resolveChat, 'session-1', label + '：完整 chat 必须按 sessionId 解析')
    assert.equal(h.seen.server.chat, h.fullChat, label + '：服务端必须收到完整权威 chat（不是稀疏窗口）')
    assert.equal(h.seen.server.event, 'MESSAGE_SENT', label + '：服务端事件名必须原样')
    assert.deepEqual(h.seen.server.args, ['a'], label + '：服务端 args 必须原样')
    assert.equal(h.seen.window, 'session-1', label + '：浏览器窗口必须按 sessionId 现取')
    assert.deepEqual(h.seen.browser.eventContext, { contextWindow: h.recentWindow },
      label + '：浏览器必须收到 recent 窗口的 contextWindow')
    assert.equal(h.seen.browser.eventContext.contextWindow === h.sparseWindow, false,
      label + '：不得把服务端稀疏投影当窗口下发')
    assert.equal(h.seen.context, null, label + '：recent 路径不得再走服务端 context 投影')
    assert.equal(result.browserDispatched, true, label + '：有浏览器脚本时必须真下发')
    assert.equal(result.serverOwned, true)
    assert.equal(result.serverHandled, true)
    assert.deepEqual(result.serverHooks, ['hook-1'])
  }
})

test('browserScripts===0：服务端跑完立即回执，不下发浏览器、不取窗口', async () => {
  for (const sha of OLD_TREES) {
    const label = sha.slice(0, 8)
    const h = makeHarness(sha, { serverResult: { handled: true, browserScripts: 0, hooks: null } })
    const args = ['x', 1]
    const result = await h.dispatch({ sessionId: 'session-1', name: 'MESSAGE_DELETED', args, recent: true })
    assert.deepEqual(h.trace, ['resolveChat', 'server'], label + '：纯计算卡只该有「解析完整 chat → 服务端跑完」两次调用')
    assert.equal(result.browserDispatched, false, label + '：纯计算卡不得下发浏览器执行器')
    assert.equal(result.serverOwned, true)
    assert.equal(result.serverHandled, true)
    assert.equal(result.serverHooks, null)
    assert.deepEqual(result.args, args, label + '：立即回执必须回带 args')
    assert.equal(h.seen.browser, null, label + '：浏览器执行器不得被调用')
    assert.equal(h.seen.window, null, label + '：纯计算卡不得再取浏览器窗口')
    assert.equal(h.seen.context, null, label + '：纯计算卡不得再走 context 投影')
  }
})

test('MESSAGE_RECEIVED：结构化拒绝浏览器执行，不调 server/browser/窗口（结算在飞也照样拒）', async () => {
  for (const sha of OLD_TREES) {
    const label = sha.slice(0, 8)
    const h = makeHarness(sha, { busy: true })
    const result = await h.dispatch({ sessionId: 'session-1', name: 'MESSAGE_RECEIVED', args: [{ id: 1 }] })
    assert.equal(result.handled, false, label + '：变量核心不由浏览器执行')
    assert.equal(result.serverOwned, true, label + '：必须结构化标注归服务端')
    assert.deepEqual(result.args, [{ id: 1 }], label + '：拒绝必须回带 args 快照')
    assert.deepEqual(Object.keys(result).sort(), ['args', 'handled', 'serverOwned'], label + '：拒绝回执面必须恰为这三项')
    assert.deepEqual(h.trace, [], label + '：拒绝分支不得触发任何 DI 调用（含 busy 判定）')
  }
})

test('busy：结算在飞时抛 SERVER_EXECUTION_BINDING_BUSY，且 server/browser 都没被调用', async () => {
  for (const sha of OLD_TREES) {
    const label = sha.slice(0, 8)
    const h = makeHarness(sha, { busy: true })
    await assert.rejects(
      h.dispatch({ sessionId: 'session-1', name: 'MESSAGE_SENT', args: [], chat: h.fullChat }),
      error => error.code === 'SERVER_EXECUTION_BINDING_BUSY' && /未派发/.test(error.message),
      label + '：结算在飞必须抛明确错误（不是静默跳过）')
    assert.deepEqual(h.trace, [], label + '：busy 必须在任何 DI 调用之前阻断')
  }
})
