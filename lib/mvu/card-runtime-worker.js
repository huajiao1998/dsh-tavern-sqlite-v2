// 卡脚本运行时的 Worker 入口：在**带 `--experimental-vm-modules` 的 Worker 线程**里
// 原样构建 `mvu-card-runtime`（零改动复用），宿主 API 经共享槽代理回宿主进程。
//
// 为什么需要它：Windows 桌面版酒馆的 harness 是 Electron 打包进程，`vm.SourceTextModule`
// 被 Electron 的 node_bindings 白名单挡死（NODE_OPTIONS 与 fork 的 execArgv 两路都无效）；
// 而 Worker 的 `execArgv` 是纯 Node API，不经该过滤——实测完整 link+evaluate+顶层 await 可用。
// Linux / macOS / Windows CLI 版进程自带 vm，**不会走到这里**（见 vm-capability.js 选路）。
//
// 边界纪律（详见 docs/workstreams/plugin/WINDOWS-0.2.3-DESIGN.md §2）：
//   · 宿主状态（SQLite 事务、binding/chat/host）**留在宿主**，本文件不复制权威状态；
//   · 同步读走共享槽（宿主同步前缀执行完即回值），异步写走 ticket；
//   · **函数实参一律响亮失败**（阶段一不静默序列化）；
//   · 任何无法忠实跨越边界的能力都抛错，不静默降级。
import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createWorkerChannel } from './runtime-ipc.js'
import { createCardScriptRuntime } from './mvu-card-runtime.js'
import { classifyCardScript, authorZodNamespace, authorYamlNamespace } from '../server-execution.js'

const require = createRequire(import.meta.url)
const data = workerData || {}
const init = data.init || {}

if (!parentPort) throw new Error('card-runtime-worker 必须在 Worker 线程内运行')
if (!(data.slotSab instanceof SharedArrayBuffer)) throw new Error('card-runtime-worker 缺少共享槽')

const post = message => parentPort.postMessage(message)
const channel = createWorkerChannel({ sab: data.slotSab, notify: post, timeoutMs: data.timeoutMs || 30000, payloadBytes: data.payloadBytes })

// ——— 共享活动计数（宿主 wrapGenerateRaw 与本 runtime 的 hookBudget 必须看同一个计数）———
function sharedActivityFrom(sab) {
  if (!(sab instanceof SharedArrayBuffer)) return null
  const view = new Int32Array(sab, 0, 1)
  return {
    get pending() { return Atomics.load(view, 0) },
    set pending(value) { Atomics.store(view, 0, Number(value) || 0) },
  }
}
const activity = sharedActivityFrom(data.activitySab)

// ——— 本地解析成员：不能走 RPC 的成员（同源加载，行为与宿主一致）———
// 依赖走**包内 vendor**（安装零外部依赖）：Worker 线程里同样按相对路径加载，
// 不再依赖宿主 node_modules 里是否装了 lodash/yaml。
const vendor = name => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', name)
const LOCAL_MODULES = {
  lodash: () => require(vendor('lodash/lodash.min.js')),
  // YAML：与进程内同一来源——**作者随包 yaml 资产**（server-execution.js 统一实现，作者树
  // 找不到时 vendor 同库兜底），不再各写一份。
  yaml: () => authorYamlNamespace(),
  // z/zod：与进程内同一来源——**作者随包 zod 资产**懒加载代理（server-execution.js 统一实现，
  // Worker 里同一文件、同一候选路径）；资产缺失/失败响亮抛错，不做空操作。
  zod: () => authorZodNamespace('zod'),
  // jQuery ready：**参数是回调函数**，跨线程不可传 ⇒ 函数分支在 Worker 侧本地实现。
  // 语义对齐宿主版（server-execution.js 的 `$`）：
  //   · 回调经沙箱自己的 `_dshRegisterMicrotask` 登记 ⇒ 归本 run 待办表、能被 drain 等到，
  //     且回调里再登记的短 timer 归属正确；
  //   · 在飞活动计数走共享计数（宿主 wrapGenerateRaw 看到的是同一个数）；
  //   · 错误**不吞**：由沙箱待办表/drain 通道回宿主记账（与进程内同一条出口）。
  //   · 非函数实参：`'#mvu_notification_error'` 只读控件**就地实现**——宿主版为它返回
  //     `Object.freeze({ prop: fn })`，对象里带函数，RPC 结果过不了线程（真机实测卡在
  //     "同步返回值无法跨线程编码"）；语义与宿主版逐字对齐（checked 恒 true、其余响亮拒）。
  //     其余选择器仍转回宿主：宿主响亮抛"服务端不支持 jQuery DOM选择器"，错误可序列化可跨线程。
  dollar: () => function $(fn) {
    if (typeof fn !== 'function') {
      if (fn === '#mvu_notification_error') {
        if (runtime?.disposed === true) throw fail('卡脚本只读控件探针窗口已关闭（本次结算已结束）')
        return Object.freeze({
          prop: (...args) => {
            if (runtime?.disposed === true) throw fail('卡脚本只读控件探针窗口已关闭（本次结算已结束）')
            if (args.length === 1 && args[0] === 'checked') return true
            throw fail('MVU错误通知开关仅支持只读 prop(checked)')
          },
        })
      }
      return callHost(['$'], [fn])
    }
    const sandbox = runtime?.sandbox
    if (!sandbox) throw fail('jQuery ready 在运行时尚未建立时被调用')
    if (runtime.disposed === true) throw fail('卡脚本 jQuery ready 窗口已关闭（本次结算已结束）')
    const register = sandbox._dshRegisterMicrotask
    const pending = typeof register === 'function'
      ? new Promise((resolve, reject) => register(() => {
        try { const result = fn(); Promise.resolve(result).then(resolve, reject); return result }
        catch (error) { reject(error); throw error }
      }))
      : Promise.resolve().then(fn)
    if (activity) activity.pending += 1
    return pending.then(
      value => { if (activity) activity.pending -= 1; return value },
      error => {
        if (activity) activity.pending -= 1
        // 不静默：让宿主看见未 await 的 ready 回调失败（宿主侧结算前会取走）
        post({ type: 'asyncError', message: String(error && error.message || error), code: error && error.code })
        return undefined
      },
    )
  },
}

let runtime = null
const pendingTickets = new Map()

function fail(message, code = 'CARD_RUNTIME_WORKER_UNSUPPORTED') {
  return Object.assign(new Error('[card-runtime-worker] ' + message), { code })
}

/** 函数实参不可跨线程；阶段一响亮拒绝，绝不静默替换。 */
function rejectFunctionArgs(args) {
  for (let index = 0; index < args.length; index++) {
    if (typeof args[index] === 'function') {
      throw fail(`宿主 API 第 ${index + 1} 个参数是函数（Worker 模式暂不支持回调参数）：拒绝静默降级`)
    }
  }
}

/** 把宿主返回的 thenable 变成 Worker 侧 promise：ticket 回来才结算。 */
function awaitTicket(ticket) {
  return new Promise((resolve, reject) => pendingTickets.set(ticket, { resolve, reject }))
}

function callHost(path, args) {
  rejectFunctionArgs(args)
  const request = { path, args, scriptId: currentScriptId() }
  const result = channel.call(request)
  if (result.kind === 'value') return result.value
  if (result.kind === 'ticket') {
    const promise = awaitTicket(result.ticket)
    // 让沙箱待办表看得见这次未 await 的写（drain 语义），但**不把错误重复记一遍**：
    // 错误记账由宿主侧权威完成，这里只提供结算探针。
    try { runtime?.sandbox?._dshTrackPending?.(promise.catch(() => undefined), currentSourceName()) } catch {}
    return promise
  }
  throw fail('未知宿主返回形态：' + String(result.kind))
}

function buildHostApi(spec, path) {
  const out = {}
  for (const [key, node] of Object.entries(spec && spec.members ? spec.members : {})) {
    const here = path.concat(key)
    if (!node || typeof node !== 'object') throw fail('宿主 API 规格节点非法：' + here.join('.'))
    if (node.kind === 'fn') out[key] = (...args) => callHost(here, args)
    else if (node.kind === 'value') out[key] = node.value
    else if (node.kind === 'local') {
      const factory = LOCAL_MODULES[node.module]
      if (!factory) throw fail('未知本地模块：' + String(node.module))
      out[key] = factory()
    } else if (node.kind === 'ns') out[key] = buildHostApi(node, here)
    else throw fail('未知宿主 API 规格种类：' + String(node.kind) + '（' + here.join('.') + '）')
  }
  return out
}

function currentSourceName() {
  try { return runtime?.currentSource || null } catch { return null }
}
function currentScriptId() {
  try { return runtime?.currentScriptId || '' } catch { return '' }
}

/** runtime 状态快照：宿主侧只读镜像，绝不反向同步查询。 */
function snapshot() {
  if (!runtime) return { ready: false }
  try {
    return {
      ready: true,
      events: Array.isArray(runtime.events) ? runtime.events.map(item => ({ event: item.event, source: item.source || null })) : [],
      // **必须保留错误记录的形状**（{source, error, domProbe?}）：server-execution 靠 item.domProbe
      // 把 DOM 探针与真实加载错误分类（domProbes/loadFailures），字符串化会让桌面端误分类。
      errors: Array.isArray(runtime.errors) ? runtime.errors.map(item => {
        if (item && typeof item === 'object') {
          return { source: item.source ?? null, error: String(item.error ?? item.message ?? ''), ...(item.domProbe ? { domProbe: true } : {}) }
        }
        return { source: null, error: String(item ?? ''), domProbe: false }
      }) : [],
      domAccessed: runtime.domAccessed === true,
      needsBrowser: Array.isArray(runtime.needsBrowser) ? runtime.needsBrowser.slice() : [],
      sources: Array.isArray(runtime.sources) ? runtime.sources : [],
      lastDomAccess: runtime.lastDomAccess ?? null,
      lastEventOutcome: runtime.lastEventOutcome ?? null,
      currentScriptId: runtime.currentScriptId || '',
      currentSource: runtime.currentSource || null,
      disposed: runtime.disposed === true,
      pendingTasks: typeof runtime.pendingTasks === 'function' ? runtime.pendingTasks() : 0,
      activityPending: activity ? activity.pending : null,
    }
  } catch (error) {
    return { ready: true, snapshotError: String(error && error.message || error) }
  }
}

const logger = {
  info: (...args) => post({ type: 'log', level: 'info', args: args.map(render) }),
  warn: (...args) => post({ type: 'log', level: 'warn', args: args.map(render) }),
  error: (...args) => post({ type: 'log', level: 'error', args: args.map(render) }),
  debug: () => {},
}
function render(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return String(value) }
}

// ——— 构建运行时（sources 等纯数据来自 init；classify 用同一实现，不由宿主注入函数）———
let runtimeReady
const ready = new Promise((resolve, reject) => { runtimeReady = { resolve, reject } })
try {
  const hostApi = buildHostApi(init.hostApiSpec, [])
  runtime = createCardScriptRuntime({
    cardPath: init.cardPath,
    sources: init.sources,
    hostApi,
    timeoutMs: init.timeoutMs,
    logger,
    onDomAccess: source => post({ type: 'domAccess', source: source ?? null }),
    activity,
    activityHolder: { current: null },
    params: init.params ?? null,
    moduleOptions: { ...(init.moduleOptions || {}), classify: classifyCardScript },
    // **必须在这里就绑定 runtime**：`createCardScriptRuntime` 内部的 `loadSources()` 会**同步**
    // 执行首个 classic 脚本（到第一个 await 之前），此时构造函数尚未返回——本地实现的成员
    //（如 `$`）若等到赋值后才可用，加载期的 `$(fn)` 就会看到 null。onRuntimeCreated 在
    // loadSources 之前触发，是唯一正确的绑定点。
    onRuntimeCreated: instance => { runtime = instance; post({ type: 'state', state: snapshot() }) },
    timerCeilingMs: init.timerCeilingMs,
    timerCountMax: init.timerCountMax,
    pendingCeilingMs: init.pendingCeilingMs,
  })
  if (!runtime || typeof runtime.dispatchEvent !== 'function') throw new Error('卡脚本运行时构造失败（未返回可派发的运行时）')
  runtimeReady.resolve(runtime)
} catch (error) {
  runtimeReady.reject(error)
  post({ type: 'fatal', error: String(error && error.message || error) })
}

// 就绪握手：`runtime.ready` 是**模块加载**完成（与进程内 runtimeApi.ready 同一语义），
// 宿主 bridge 的 ready 镜像它；构造完成只推状态、不放行 ready。
// 构造失败（runtime 仍为 null）时 fatal 已发，这里的守卫防止二次抛错。
if (runtime && typeof runtime.ready?.then === 'function') {
  runtime.ready.then(
    () => post({ type: 'ready', state: snapshot() }),
    error => post({ type: 'fatal', error: String(error && error.message || error) }),
  )
}

parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'ticket') {
    const entry = pendingTickets.get(message.id)
    if (!entry) return
    pendingTickets.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else {
      const error = new Error(message.value && message.value.message || '宿主异步写失败')
      if (message.value && message.value.code) error.code = message.value.code
      entry.reject(error)
    }
    return
  }
  if (message.type === 'emit') {
    // 宿主向沙箱投事件：事件本来异步，语义不变。
    Promise.resolve(runtime?.sandbox?.eventEmit?.(message.event, ...(message.args || []))).catch(error => post({ type: 'log', level: 'error', args: ['eventEmit 失败：' + String(error && error.message || error)] }))
    return
  }
  if (message.type === 'op') {
    // reply 必须兜底：postMessage 遇到不可克隆的返回值（函数/句柄）会同步抛 DataCloneError，
    // 若不接住，宿主侧 op 永远挂起。兜底回一个明确的错误，让宿主响亮失败。
    const reply = (ok, value, error) => {
      try {
        post({ type: 'reply', id: message.id, ok, value, error: error ? { message: String(error && error.message || error), code: error && error.code } : undefined, state: snapshot() })
      } catch (cause) {
        try {
          post({ type: 'reply', id: message.id, ok: false, error: { message: '操作结果无法跨线程传回（' + String(cause && cause.message || cause) + '）', code: 'CARD_RUNTIME_IPC_OVERSIZE' }, state: snapshot() })
        } catch {}
      }
    }
    const run = async () => {
      if (message.op === 'dispatch') return await runtime.dispatchEvent(message.options || {}, message.event, ...(message.args || []))
      if (message.op === 'drain') return await runtime.drainPendingTasks(message.options || {})
      if (message.op === 'dispose') { runtime.dispose?.(); return null }
      if (message.op === 'state') return null
      throw fail('未知操作：' + String(message.op))
    }
    Promise.resolve().then(run).then(value => reply(true, value), error => reply(false, undefined, error))
    return
  }
})

post({ type: 'boot', pid: process.pid })
