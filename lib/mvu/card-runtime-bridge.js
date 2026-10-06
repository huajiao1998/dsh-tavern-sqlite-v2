// 卡脚本运行时宿主桥：对 `server-execution` 暴露**与进程内 createCardScriptRuntime 相同**的接口，
// 实际执行在带 `--experimental-vm-modules` 的 Worker 里（见 card-runtime-worker.js）。
//
// 启用条件只有一个：本进程没有 `vm.SourceTextModule`（Electron 打包 harness）。
// Linux / macOS / Windows CLI 版进程自带 vm，**永远走进程内老路**，本文件不参与。
//
// 关键纪律：
//   · 宿主状态是唯一权威（SQLite 事务/CAS/前额），本桥**不复制**权威状态，只做调用转接；
//   · 宿主 API 的同步前缀通过共享槽同步回值（语义与进程内一致），异步尾部走 ticket；
//   · runtime 状态（events/errors/domAccessed/…）由 Worker 推快照，宿主只读镜像，**绝不反向同步查询**；
//   · 不可忠实跨越边界的东西（函数实参、不可序列化返回值）一律**响亮报错**，不静默降级。
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'
import { createSharedSlot, createHostChannel, ipcFail, IPC_ERRORS } from './runtime-ipc.js'
import { VM_MODULES_FLAG } from './vm-capability.js'

const WORKER_ENTRY = fileURLToPath(new URL('./card-runtime-worker.js', import.meta.url))

/** 不能走 RPC 的成员：Worker 侧按同名实现本地解析（行为与宿主同源）。
 *  · `_`/`YAML`/`z`/`zod` —— 命名空间不可序列化，Worker 自行加载同一依赖；
 *  · `$` —— **参数里带回调函数**（jQuery ready）。宿主的 `$` 会在宿主侧调用该回调，
 *    跨线程无法传函数；因此函数分支整体下沉 Worker（在沙箱内登记微任务，语义与进程内一致），
 *    非函数分支（`'#mvu_notification_error'` 只读控件等）仍转回宿主，保留其窗口校验。
 */
const LOCAL_MODULE_BY_KEY = { _: 'lodash', YAML: 'yaml', z: 'zod', zod: 'zod', $: 'dollar' }

function serializable(value, path) {
  try { v8.serialize(value); return { ok: true } }
  catch (error) { return { ok: false, reason: String(error && error.message || error), path } }
}

/** 把宿主真实的 hostApi 结构编译成可跨线程的规格（函数留桩、数据内联、命名空间递归）。 */
export function compileHostApiSpec(api, path = []) {
  const members = {}
  for (const [key, value] of Object.entries(api || {})) {
    const here = path.concat(key)
    const local = path.length === 0 ? LOCAL_MODULE_BY_KEY[key] : undefined
    if (local) { members[key] = { kind: 'local', module: local }; continue }
    if (typeof value === 'function') { members[key] = { kind: 'fn' }; continue }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value instanceof Error ? null : compileHostApiSpec(value, here)
      if (nested && nested.ok) { members[key] = { kind: 'ns', members: nested.members }; continue }
      members[key] = { kind: 'value', value }
      continue
    }
    members[key] = { kind: 'value', value }
  }
  if (path.length === 0) return { ok: true, members }
  return { ok: true, members }
}

/** 校验规格里每个内联值确实可跨线程（不可序列化 ⇒ 响亮失败并指出成员路径）。 */
function assertSpecSerializable(spec, path = []) {
  for (const [key, node] of Object.entries(spec.members || {})) {
    const here = path.concat(key)
    if (node.kind === 'value') {
      const probe = serializable(node.value, here.join('.'))
      if (!probe.ok) throw ipcFail(IPC_ERRORS.protocol, `宿主 API "${here.join('.')}" 的值不可跨线程（${probe.reason}）：拒绝静默降级`)
    } else if (node.kind === 'ns') assertSpecSerializable(node, here)
  }
}

/** 共享活动计数：宿主 wrapGenerateRaw 与 Worker 内 hookBudget 必须看同一个数。 */
export function createSharedActivity() {
  const sab = new SharedArrayBuffer(4)
  const view = new Int32Array(sab, 0, 1)
  return {
    sab,
    activity: {
      get pending() { return Atomics.load(view, 0) },
      set pending(value) { Atomics.store(view, 0, Number(value) || 0) },
    },
  }
}

/**
 * 创建 Worker 版卡脚本运行时。
 * @returns 与进程内 runtime 同形的对象（另含 `mode:'worker'`、`sharedActivity`、`terminate()`）
 */
export function createWorkerCardScriptRuntime(options = {}) {
  const {
    cardPath, sources, hostApi, timeoutMs = 8000, logger = console, onDomAccess,
    activityHolder = null, params = null, moduleOptions = {},
    timerCeilingMs = 0, timerCountMax = 256, pendingCeilingMs = 3000,
    payloadBytes = 8 * 1024 * 1024, ipcTimeoutMs = 30000,
    trackWrite = null, onSharedActivity = null, onWorkerError = null, onAsyncError = null,
    workerEntry = WORKER_ENTRY, execArgv = [VM_MODULES_FLAG],
  } = options

  if (typeof cardPath !== 'string' || !cardPath) throw ipcFail(IPC_ERRORS.protocol, 'Worker 运行时需要明确 cardPath')
  if (!Array.isArray(sources)) throw ipcFail(IPC_ERRORS.protocol, 'Worker 运行时需要 sources 数组')
  // moduleOptions 只能携带纯数据（cacheDir/allowedHosts 等）：classify/fetchImpl 等函数由 Worker 侧
  // 自建同一实现。含函数即**响亮拒绝**——静默丢弃会改变 ESM 加载行为，静默克隆则直接崩。
  // 唯一豁免 `classify`：server-execution.js 生产路径恒传 classifyCardScript，而 Worker 侧
  // （card-runtime-worker.js:20）import 的是**同一模块的同一导出**，桥在发往 Worker 时也
  // 统一剥除（下方 `classify: undefined`）——拒它会让桌面 Worker 路径第一张卡就炸（真机审查发现）。
  for (const [key, value] of Object.entries(moduleOptions || {})) {
    if (key === 'classify') continue
    if (typeof value === 'function') throw ipcFail(IPC_ERRORS.protocol, `moduleOptions.${key} 是函数，不能跨线程（Worker 侧应自建同源实现）：拒绝静默丢弃`)
  }

  const spec = compileHostApiSpec(hostApi || {})
  assertSpecSerializable(spec)

  const slotSab = createSharedSlot(payloadBytes)
  const { sab: activitySab, activity: sharedActivity } = createSharedActivity()
  const channel = createHostChannel({ sab: slotSab, payloadBytes })

  // 宿主侧共享计数必须立刻生效：wrapGenerateRaw 经 activityOf() 惰性取用同一对象。
  if (activityHolder && typeof activityHolder === 'object') activityHolder.current = sharedActivity
  onSharedActivity?.(sharedActivity)

  const state = {
    ready: false, disposed: false, events: [], errors: [], domAccessed: false,
    needsBrowser: [], sources: [], lastDomAccess: null, lastEventOutcome: null,
    currentScriptId: '', currentSource: null, pendingTasks: 0, activityPending: 0,
  }
  const hostApiByPath = path => path.reduce((node, key) => (node == null ? node : node[key]), hostApi)
  let worker = null
  let readySettled = false
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const pendingOps = new Map()
  let opSeq = 0

  const emit = (level, args) => {
    const fn = level === 'error' ? logger?.error : level === 'warn' ? logger?.warn : logger?.info
    try { fn?.('[worker-runtime]', ...args) } catch {}
  }

  const applyState = next => {
    if (!next || typeof next !== 'object') return
    if (next.ready) state.ready = true
    for (const key of ['events', 'errors', 'needsBrowser', 'sources']) if (Array.isArray(next[key])) state[key] = next[key]
    for (const key of ['domAccessed'] ) if (typeof next[key] === 'boolean') state[key] = next[key]
    if ('lastDomAccess' in next) state.lastDomAccess = next.lastDomAccess
    if ('lastEventOutcome' in next) state.lastEventOutcome = next.lastEventOutcome
    if (typeof next.currentScriptId === 'string') state.currentScriptId = next.currentScriptId
    if ('currentSource' in next) state.currentSource = next.currentSource
    if (typeof next.disposed === 'boolean') state.disposed = next.disposed
    if (typeof next.pendingTasks === 'number') state.pendingTasks = next.pendingTasks
    if (typeof next.activityPending === 'number') state.activityPending = next.activityPending
    if (next.snapshotError) logger?.warn?.('[worker-runtime] 状态快照异常：' + next.snapshotError)
  }

  function settleReady(error) {
    if (readySettled) return
    readySettled = true
    if (error) rejectReady(error); else resolveReady(runtime)
  }

  function runOp(op, payload) {
    return new Promise((resolve, reject) => {
      const id = ++opSeq
      pendingOps.set(id, { resolve, reject })
      worker.postMessage({ type: 'op', id, op, ...payload })
    })
  }

  function invokeHostApi(request) {
    const path = Array.isArray(request && request.path) ? request.path : null
    if (!path || path.length === 0) throw ipcFail(IPC_ERRORS.protocol, '宿主 API 调用缺少成员路径')
    // 当前脚本身份由**请求携带**（Worker 自己最清楚），宿主侧绝不反向同步查询 Worker：
    // `variablesOf`/`replaceVariables` 读 `runtime.currentScriptId` 时看到的就是这次调用的真实值。
    if (typeof request.scriptId === 'string') state.currentScriptId = request.scriptId
    const fn = hostApiByPath(path)
    if (typeof fn !== 'function') throw ipcFail(IPC_ERRORS.protocol, '宿主 API 成员不存在或不是函数：' + path.join('.'))
    const result = fn(...(Array.isArray(request.args) ? request.args : []))
    // 真实写在宿主侧登记（提交前等待）；Worker 侧另有代理 promise 进沙箱待办表。
    if (result && typeof result.then === 'function' && typeof trackWrite === 'function') {
      try { trackWrite(result) } catch (error) { logger?.warn?.('[worker-runtime] 登记宿主写失败：' + String(error && error.message || error)) }
    }
    return result
  }

  function fail(fatal) {
    state.disposed = true
    settleReady(new Error(String(fatal && fatal.message || fatal)))
    for (const [, entry] of pendingOps) entry.reject(new Error('Worker 运行时已失败：' + String(fatal && fatal.message || fatal)))
    pendingOps.clear()
    onWorkerError?.(fatal)
  }

  worker = new Worker(workerEntry, {
    // 这里**是唯一**能拿到 vm 能力的入口：Worker 的 execArgv 是纯 Node API，不经 Electron 过滤。
    execArgv,
    workerData: {
      slotSab, activitySab, payloadBytes, timeoutMs: ipcTimeoutMs,
      init: {
        cardPath,
        sources,
        timeoutMs,
        params,
        timerCeilingMs,
        timerCountMax,
        pendingCeilingMs,
        hostApiSpec: spec,
        moduleOptions: { ...moduleOptions, classify: undefined },
      },
    },
  })

  // 启动握手：只罩"Worker 是否活着"——收到**第一条消息**即视为启动成功并清除定时器；
  // 模块加载（ready）**不设额外超时**：慢速远程 ESM 合法地可达 60s 级，误杀会破坏与 Linux 的
  // 行为对等（ready 的最终期限由 server-execution 的 awaitBindingTask(timeoutMs) 负责）。
  let booted = false
  const handshake = setTimeout(() => { if (!booted && !readySettled) settleReady(new Error('Worker 启动超时（未收到任何消息：疑似线程未起或死锁）')) }, ipcTimeoutMs)
  handshake.unref?.()

  worker.on('message', message => {
    if (!message || typeof message !== 'object') return
    if (!booted) { booted = true; clearTimeout(handshake) }
    if (message.type === 'hostcall') { channel.serve(invokeHostApi, m => worker.postMessage(m)); return }
    if (message.type === 'state') { applyState(message.state); return }
    if (message.type === 'ready') { applyState(message.state); settleReady(null); return }
    if (message.type === 'log') { emit(message.level, message.args || []); return }
    if (message.type === 'domAccess') { try { onDomAccess?.(message.source ?? null) } catch (error) { logger?.warn?.('[worker-runtime] onDomAccess 回调失败：' + String(error && error.message || error)) } return }
    if (message.type === 'asyncError') {
      // Worker 侧本地实现的异步失败（如 jQuery ready 回调）：交宿主按"未 await 的写失败"同一出口记账。
      const error = new Error(String(message.message || 'Worker 侧异步失败'))
      if (message.code) error.code = message.code
      try { onAsyncError?.(error) } catch (cause) { logger?.warn?.('[worker-runtime] onAsyncError 回调失败：' + String(cause && cause.message || cause)) }
      return
    }
    if (message.type === 'fatal') { emit('error', ['Worker 运行时致命错误：' + String(message.error)]); fail(message.error); return }
    if (message.type === 'reply') {
      const entry = pendingOps.get(message.id)
      if (!entry) return
      pendingOps.delete(message.id)
      applyState(message.state)
      if (message.ok) entry.resolve(message.value)
      else {
        const error = new Error(message.error && message.error.message || 'Worker 操作失败')
        if (message.error && message.error.code) error.code = message.error.code
        entry.reject(error)
      }
      return
    }
  })
  worker.on('error', error => { emit('error', ['Worker 线程错误：' + String(error && error.message || error)]); fail(error) })
  worker.on('exit', code => { if (!state.disposed && code !== 0) fail(new Error('Worker 线程异常退出，code=' + code)) })

  const runtime = {
    mode: 'worker',
    cardPath,
    timeoutMs,
    ready,
    sharedActivity,
    get events() { return state.events },
    get errors() { return state.errors },
    get domAccessed() { return state.domAccessed === true },
    get needsBrowser() { return state.needsBrowser },
    get sources() { return state.sources },
    get lastDomAccess() { return state.lastDomAccess },
    get lastEventOutcome() { return state.lastEventOutcome },
    get currentScriptId() { return state.currentScriptId },
    get currentSource() { return state.currentSource },
    get disposed() { return state.disposed },
    pendingTasks() { return state.pendingTasks },
    pendingTaskDetails() { return [] },
    async dispatchEvent(options, event, ...args) {
      const outcome = await runOp('dispatch', { options, event: String(event), args })
      return outcome
    },
    async drainPendingTasks(opts = {}) {
      return await runOp('drain', { options: opts })
    },
    /** 宿主把事件投进 Worker 沙箱（等价于进程内 sandbox.eventEmit）。 */
    emit(event, ...args) {
      if (state.disposed) return
      worker.postMessage({ type: 'emit', event: String(event), args })
    },
    /** 释放：先让 Worker 自己 dispose（清定时器/回调），再终止线程。 */
    dispose() {
      if (state.disposed) return
      state.disposed = true
      try { worker.postMessage({ type: 'op', id: ++opSeq, op: 'dispose' }) } catch {}
      const timer = setTimeout(() => { worker.terminate().catch(() => {}) }, 1000)
      timer.unref?.()
    },
    async terminate() { state.disposed = true; await worker.terminate() },
  }
  return runtime
}

export { WORKER_ENTRY }
