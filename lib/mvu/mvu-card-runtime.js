// MVU 卡脚本服务端运行时（第二阶段 M2 沙箱）
// 在服务端 node:vm 沙箱中执行卡脚本源码，让脚本通过 eventOn 注册钩子。
// 服务端事件（MESSAGE_RECEIVED 等）触发时，沙箱内的钩子通过宿主 API 读写变量。
//
// 生命周期：按 runtime 实例自治（createCardScriptRuntime 每次调用都是**全新实例**）；
//           getOrCreateRuntime 保留旧的“按 cardPath 缓存”语义（调用方未改），但 dispose()
//           会**自摘缓存**，因此释放后不会再把旧实例交给下一位调用者。
//
// ⚠ 安全边界声明（2026-10-01，别说过头）：node:vm **不是安全边界**。同进程脚本可以绕过它；
//   本模块的目标是**资源受控**：定时器/回调/异步预算可释放、错误不被吞、旧请求不污染新窗口。
//   真正的隔离要靠进程/权限，本模块不提供。
//
// ⚠ 跨 chat 串数据（2026-10-01 修）：本模块**不再按 cardPath 缓存**。
//   旧实现 `runtimes.get(cardPath)` 会让多个 chat/会话复用同一个 vm 上下文 ⇒ 前一个 chat 的
//   闭包/变量状态流进后一个 chat。需要复用请由调用方自己持有实例（或显式用 getOrCreateRuntime），
//   并且必须用 dispose 释放。
//
// 有界短定时器回调（2026-10-04 补，对应两张创业卡 250ms 防抖 / 1500ms 兜底）：
//   ⑤ 沙箱 `setTimeout` 的**短**延迟（ms <= timerCeilingMs，是调用方给的数值，本模块不自设缺省）
//      与**立即微任务**登记进本 runtime 的待办表；回调源 scriptId 沿 timer / 嵌套 / async await 保归属
//      （node:async_hooks AsyncLocalStorage 承担上下文传播，不自造 framework）。
//   ⑥ `drainPendingTasks({ timeoutMs })` 有界等待：既等 timer 回调，也等回调里**未被 await** 的
//      thenable（Promise.all 收不到的"发射后不管"写）。**不等待 `setInterval` 与长延迟**（不盲等、
//      不续命）；超预算 ⇒ 抛错（不返回半成功）；dispose / closeTimers 立刻唤醒等待方并拒新回调。
//   ⑦ 屏障**只接受 run 自身给出的源**：调用方传 `{ source: 'hook' | 'microtask' | 'timer' }`，
//      缺省 `'timer'`（= 只作用在短 timer 源上）。timer 源另有 3s 身份期限（上限 ceiling 本身）。
//
// 资源受控（本轮四项）：
//   ① dispose 清 setTimeout/setInterval/requestAnimationFrame/queueMicrotask 的**全部**登记回调，
//      并让所有在飞 hookBudget 立刻结束（不留定时器）；释放后 eventOn / dispatchEvent / 定时器回调一律拒绝。
//   ② 钩子**在 vm 上下文内**调用（vm.Script + runInContext{timeout}）⇒ 同步死循环也能被同步 timeout 打断，
//      不再有“dispatch 直接 e.handler、不受 vm timeout 管”的漏洞。
//   ③ 钩子错误默认照旧只告警（兼容旧调用方），但 `dispatchEvent(event, { strict: true })` 时**向上抛**，
//      绝不把坏结果当成成功交回调用方去提交；超时也进 outcome（不再只是 console.warn）。
//   ④ DOM 探针：加载期把标记落到**具体脚本名**，运行期可回读来源（lastDomAccess / needsBrowser）；
//      读走自愈 no-op（可链式、缓存实例），写被丢弃但**记入 outcome**；strict 下探针触发即抛（不静默结算）。
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createEsmModuleLoader } from './esm-module-loader.js'

// [t3-generate-raw] 活动感知的异步钩子预算由本包统一提供（见 lib/sandbox-policy.js）
import { hookBudget, SANDBOX_ERRORS } from '../sandbox-policy.js'

const runtimes = new Map() // 兼容旧入口 getOrCreateRuntime：cardPath → runtime

const DOM_MARK = 'card-script-dom'
const DISPOSED_MARK = 'CARD_RUNTIME_DISPOSED'
const REENTRANT_MARK = 'CARD_RUNTIME_REENTRANT'
const PENDING_MARK = 'CARD_RUNTIME_PENDING_FAILED'

/** 该错误是不是"待办回调/未 await 写失败"标记（drainPendingTasks 的失败出口） */
export function isPendingTaskError(error) {
  return Boolean(error && typeof error === 'object' && error.code === PENDING_MARK)
}

/** 该错误是不是“DOM 探针触发”标记（加载期与运行期同标记，便于宿主识别） */
export function isDomProbeError(error) {
  return Boolean(error && typeof error === 'object' && error.code === DOM_MARK)
}
/** 该错误是不是“运行时已释放” */
export function isDisposedError(error) {
  return Boolean(error && (error.code === DISPOSED_MARK || String(error && error.message || '').includes(SANDBOX_ERRORS.disposed)))
}

export function createCardScriptRuntime({
  cardPath,
  sources,
  hostApi,
  timeoutMs = 8000,
  logger = console,
  onDomAccess,
  activity = null,
  activityHolder = null, // { current }：消费方把 wrapGenerateRaw 接到**同一个**计数对象上的锚点
  awaitTimeoutMs = 180000,
  syncTimeoutMs = null, // 钩子**同步**执行上限（缺省 = timeoutMs）；同步死循环靠它打断
  tickMs = 250,         // 异步预算轮询间隔
  maxBudgetTicks = 0,   // 异步预算轮询次数上限（0=不限，只作保险）
  params = null,        // 透传给宿主 API 的附加参数（可选）
  moduleOptions = {},  // ESM依赖加载/缓存选项，不允许模块跳出本runtime上下文
  onRuntimeCreated,    // 顶层同步代码执行前绑定当前script owner/资源读口
  timerCeilingMs = 0,  // >0 才接管 setTimeout 短延迟（缺省 0 = 一个都不接管，行为完全不变）
  timerCountMax = 256, // 待办短回调数量上限（超出即拒登记并记错，对应 V1 scope.count>256）
  pendingCeilingMs = 3000, // timer 源待办的身份期限上限（V1 sticky 同值；ceiling 更小时以 ceiling 为准）
} = {}) {
  const key = String(cardPath ?? '(unknown-card)')
  const events = []            // [{event, handler, source}]
  const errors = []            // 加载期错误（对外兼容旧形状）
  const sourceRecords = []     // [{name, ok, error, dom}]
  const timers = new Map()     // handle → { kind, handle }：定时器/RAF 登记表（dispose 全清）
  const budgets = new Set()    // 在飞 hookBudget（dispose 全部 cancel）
  const needBrowserSources = new Set() // DOM 探针触发的脚本名（null = 运行期触发，无法定位脚本）
  const handlerSources = new Map()     // handler 函数 → 脚本名（钩子异常可定位）
  const probeMap = new Map()           // DOM 探针缓存（同一属性名返回同一实例，防无界膨胀）
  const PROBE_CACHE_MAX = 512          // 上界：动态属性名再野也不会把探针缓存撑爆
  const syncTimeout = Number(syncTimeoutMs) > 0 ? Number(syncTimeoutMs) : timeoutMs
  // activity：沙箱侧的“有生成在飞”计数。旧接线里它是调用方注入的共享对象；新接线里 runtime 自建，
  // 并通过 activityHolder.current 暴露 ⇒ 消费方必须拿**同一个对象**去 wrapGenerateRaw，否则计数永远为 0、
  // 放宽预算静默失效（2026-10-01 实测踩中：runtime 自建而 wrapper 用自己那个，60ms 预算把 120ms 生成掐掉）。
  const selfActivity = { pending: 0 }
  const sharedActivity = activity || selfActivity
  if (activityHolder && typeof activityHolder === 'object') activityHolder.current = sharedActivity

  let disposed = false
  let booting = true           // 加载期：此时不允许派发（顶层 eventEmit 会撞到未建好的 API）
  let lastEventOutcome = null
  let lastDomAccess = null     // { source, prop, op }：最近一次探针访问（运行期来源标记）
  let activeSource = null
  let moduleLoader = null
  const moduleImports = new Set()
  let activeHandler = null
  let strictNow = false
  let reentrant = false
  let proxyId = 0

  // dispose 的取消信号：deferred（不产生 unhandled rejection）
  let cancelResolve = () => {}
  const cancelSignal = { promise: new Promise(res => { cancelResolve = res }) }

  // ——— 待办回调（有界短 timer + 微任务）：登记、身份归属、有界 drain、关闭 ———
  // 上下文只放**脚本身份符串**（不放 handler/闭包），沿 timer / 嵌套 / async await 自动继承；
  // 不创建任何业务状态、不改沙箱可见对象 ⇒ 不构成新 framework。
  const callbackScope = new AsyncLocalStorage()
  const pendingTasks = new Set()   // receipt（对外不导出：{ pattern, task, promise, kind, source, timer, deadline, resolve }）
  const pendingWaiters = new Set() // drainPendingTasks 的唤醒器
  const pendingErrors = []
  const taskCeiling = Math.min(3000, Math.max(0, Number(timerCeilingMs) || 0))
  const taskCountMax = Math.min(256, Math.max(1, Number(timerCountMax) || 256))
  const identityWindow = Math.max(0, Math.min(Number(pendingCeilingMs) || 3000, 3000))
  const settleWaiters = () => { for (const wake of [...pendingWaiters]) { try { wake() } catch {} } }
  /** 本次回调的脚本身份：ALS 上下文优先（timer/嵌套/await 继承），退回同步执行期身份。 */
  const currentScript = () => callbackScope.getStore() ?? activeSource ?? (activeHandler ? handlerSources.get(activeHandler) : null) ?? null
  const notePendingError = (message, source) => {
    const error = new Error(String(message))
    error.code = PENDING_MARK
    error.source = source || null
    pendingErrors.push(error)
    try { logger?.warn?.(`[mvu-card-runtime] ${key} 待办回调：${error.message}（来源 ${source || '?'}）`) } catch {}
    return error
  }
  /** 登记一个待办：既进等待表（drain 能等到），也进跟踪集（settle 的 promise 一并等）。 */
  const registerPending = (pattern, kind, source, deadline) => {
    const task = { pattern, kind, source: source || null, timer: null, deadline, resolve: () => {} }
    const receipt = { task, promise: null }
    task.resolve = () => { receipt.promise = null; pendingTasks.delete(receipt); settleWaiters() }
    receipt.promise = new Promise(resolve => {
      task.resolve = () => { receipt.promise = null; pendingTasks.delete(receipt); resolve(); settleWaiters() }
    })
    if (pendingTasks.size >= taskCountMax) {
      const error = notePendingError(`待办回调数量超过上限 ${taskCountMax}，本次登记被拒绝`, source)
      task.reject = error
      task.resolve()
      return { receipt: null, error }
    }
    pendingTasks.add(receipt)
    return { receipt, error: null }
  }
  /** 跟踪一个 thenable（未被 await 的 Helper 写也进同一张表，随 drain 一起等）。 */
  const trackPending = (thenable, source) => {
    if (!thenable || typeof thenable.then !== 'function') return thenable
    const task = { pattern: 'promise', kind: 'promise', source: source || null, timer: null, deadline: 0, reject: null, tracked: thenable }
    const receipt = { task, promise: null }
    receipt.promise = new Promise(resolve => { task.resolve = () => { receipt.promise = null; pendingTasks.delete(receipt); resolve(); settleWaiters() } })
    if (pendingTasks.size >= taskCountMax) {
      notePendingError(`待办回调数量超过上限 ${taskCountMax}，本次登记被拒绝`, source)
      Promise.resolve(thenable).catch(() => {})
      return thenable
    }
    pendingTasks.add(receipt)
    Promise.resolve(thenable).then(
      value => { task.resolve(); return value },
      error => {
        // 先记失败再唤醒 drain，避免任务刚摘空而错误尚在下一微任务的假成功窗口。
        task.reject = error
        const failure = notePendingError(`未 await 的异步写失败：${error && error.message || error}`, source)
        failure.cause = error
        task.resolve()
      },
    )
    return thenable
  }
  // 宿主已跟踪过的 thenable：登记时刻（**不是 settle 之后**）交给本表，drain 才能等到"脚本没 await 的写"。
  // 只接 thenable，且只按对象身份去重（WeakSet）—— 同一 promise 不会被登记两次。
  const trackedByHost = new WeakSet()
  const trackPendingOnce = (thenable, source) => {
    if (!thenable || typeof thenable.then !== 'function') return thenable
    if (trackedByHost.has(thenable)) return thenable
    trackedByHost.add(thenable)
    return trackPending(thenable, source)
  }
  /** 宿主侧结算完一条已跟踪的写：从等待表摘掉（找不到就什么都不做，幂等）。 */
  const forgetPending = thenable => {
    if (!thenable || typeof thenable !== 'object') return 0
    let removed = 0
    for (const receipt of [...pendingTasks]) {
      if (receipt.task.pattern !== 'promise' || receipt.task.tracked !== thenable) continue
      receipt.task.resolve()
      removed += 1
    }
    return removed
  }
  const closePending = reason => {
    for (const receipt of [...pendingTasks]) {
      const task = receipt.task
      // **先摘 handle 再置 null**：`timers.delete(task.timer)` 必须拿到真 handle。
      // 反过来写（先 `task.timer = null` 再 delete）就是拿 null 去查表 —— 登记表里的定时器条目
      // 永远摘不掉，dispose 后残留悬空条目（与 clearTimer 的正确顺序一致）。
      if (task.timer) {
        const handle = task.timer
        try { globalThis.clearTimeout(handle) } catch {}
        timers.delete(handle)
        task.timer = null
      }
      task.reject = task.reject || Object.assign(new Error(String(reason)), { code: PENDING_MARK })
      task.resolve()
    }
  }
  const drainError = (task, reason) => Object.assign(new Error(String(reason)), {
    code: PENDING_MARK, source: task.source || null, kind: task.kind, taskPattern: task.pattern,
  })

  const disposedError = () => {
    const err = new Error(`${SANDBOX_ERRORS.disposed}：${key}`)
    err.code = DISPOSED_MARK
    return err
  }

  // ——— 定时器登记（沙箱可见的定时器全部经此，dispose 必须清干净） ———
  const trackTimer = (kind, handle) => { timers.set(handle, { kind, handle }); return handle }
  const clearTimer = handle => {
    if (handle === null || handle === undefined) return
    const entry = timers.get(handle)
    timers.delete(handle)
    globalThis.clearTimeout(handle)
    globalThis.clearInterval(handle)
    // 被脚本显式取消的待办也要从等待表里摘掉（否则 drain 会一直等一个永不触发的回调）。
    const receipt = entry?.pending
    if (receipt) { receipt.task.reject = drainError(receipt.task, '定时器回调在触发前被 clearTimeout 取消'); receipt.task.resolve() }
  }
  /**
   * 派发一个**被登记**的回调：取消/超期/dispose ⇒ 拒绝执行并记错（拒旧写）；执行体随 thenable 结算。
   * sourceId 在**登记时刻**取定（不在回调里现取），保证来源归属于登记它的那次脚本执行。
   */
  const dispatchPending = (task, sourceId, body) => {
    if (task.reject) { // 登记时就被拒（数量超限等）
      task.resolve()
      return
    }
    if (disposed) { task.reject = disposedError(); task.resolve(); return }
    if (task.deadline > 0 && Date.now() > task.deadline) {
      task.reject = notePendingError('延迟回调已超出本次 run 的身份期限，未执行旧回调', task.source)
      task.resolve()
      return
    }
    // **在 vm 执行内调用**：走与钩子同一条 makeCaller 桥（`vm.Script#runInContext({ timeout: syncTimeout })`），
    // 而不是先 runInContext 取回函数、再在宿主里 `fn.apply` —— 那样调用的**是宿主栈上的函数**，
    // vm 的同步 timeout 完全管不到它：待办回调里的同步死循环会永久挂住 drain（有界预算形同失效）。
    // 返回的 promise 由 makeCaller 从 vm 状态对象里取回（跨 realm thenable，仍可 await）。
    let result
    let syncError = null
    let out = null
    try {
      out = callbackScope.run(sourceId || null, () => makeCaller(body, []))
    } catch (error) {
      // **不吞**：同步 throw（含脚本里未捕获的 Error、DOM 探针）一律进 pendingErrors，
      // 由 drainPendingTasks 抛出；绝不只 log 一句就当成"这次 run 干净"。
      syncError = error
    }
    if (!syncError && out?.error) syncError = out.error
    if (syncError) {
      const noted = notePendingError(syncError.message || String(syncError), task.source)
      // 保留原错误身份：DOM 探针（DOM_MARK）与已释放（DISPOSED_MARK）的码要按原样向上透，
      // 且 cause 指向真凶（不 new 一个只剩文案的壳）。
      if (syncError.code) noted.code = syncError.code
      noted.cause = syncError
      task.reject = noted
      task.resolve()
      return
    }
    result = out ? out.state.promise : null
    // 回调**返回**的任何 thenable 也归入本表（脚本没 await 的写同样要被等到）。
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(value => { task.resolve(); return value }, error => {
        const noted = notePendingError(error?.message || String(error), task.source)
        noted.cause = error
        if (error?.code) noted.code = error.code
        task.reject = noted
        task.resolve()
      })
    } else {
      task.resolve()
    }
  }
  const scheduleTimer = (fn, ms, args, kind) => {
    if (disposed || typeof fn !== 'function') return null
    const raw = Number(ms)
    const delay = Math.min(Number.isFinite(raw) ? Math.max(raw, 0) : 0, 60_000)
    // 只有**显式启用**且 delay 在 ceiling 内才纳入等待表：长延迟照旧只登记 handle（不接管、不盲等）。
    const tracked = taskCeiling > 0 && delay <= taskCeiling
    const registered = tracked ? registerPending('timer', kind || 'timeout', currentScript(), Date.now() + identityWindow) : null
    const sourceId = currentScript()
    const handle = globalThis.setTimeout(() => {
      const entry = timers.get(handle)
      timers.delete(handle)
      if (entry) entry.pending = null
      if (disposed) { registered?.receipt?.task.resolve(); return }
      const task = registered?.receipt?.task
      if (task && registered.receipt) {
        try {
          dispatchPending(task, sourceId, () => fn(...args))
        } catch (error) {
          task.reject = error
          task.resolve()
        }
        return
      }
      // 未纳入等待表的（长延迟 / 未启用 / 数量超限）：保持旧行为，只告警不吞
      if (registered && !registered.receipt && registered.error) return
      try {
        const result = callbackScope.run(sourceId, () => makeCaller(() => fn(...args), []))
        if (result.error) throw result.error
        Promise.resolve(result.state.promise).catch(error => logger?.warn?.(`[mvu-card-runtime] ${key} 非屏障定时器回调失败:`, String(error?.message || error)))
      } catch (error) {
        try { logger?.warn?.(`[mvu-card-runtime] ${key} 定时器回调异常:`, String(error && error.message || error)) } catch {}
      }
    }, delay)
    if (registered?.receipt) registered.receipt.task.timer = handle
    const trackedHandle = trackTimer(kind || 'timeout', handle)
    if (registered?.receipt) timers.get(trackedHandle).pending = registered.receipt
    return trackedHandle
  }
  const sandboxSetTimeout = (fn, ms, ...args) => scheduleTimer(fn, ms, args, 'timeout')
  const sandboxSetInterval = (fn, ms, ...args) => {
    if (disposed || typeof fn !== 'function') return null
    const raw = Number(ms)
    const delay = Math.min(Number.isFinite(raw) ? Math.max(raw, 1) : 1000, 60_000)
    const owner = currentScript()
    const handle = globalThis.setInterval(() => {
      if (disposed) return
      try {
        const result = callbackScope.run(owner, () => makeCaller(() => fn(...args), []))
        if (result.error) throw result.error
        Promise.resolve(result.state.promise).catch(error => logger?.warn?.(`[mvu-card-runtime] ${key} interval 回调失败:`, String(error?.message || error)))
      } catch (error) {
        try { logger?.warn?.(`[mvu-card-runtime] ${key} 定时器回调异常:`, String(error && error.message || error)) } catch {}
      }
    }, delay)
    return trackTimer('interval', handle)
  }
  /**
   * 微任务也纳入等待表：`Promise.resolve().then(fn)` / `await Promise.resolve()` 在等待侧**没有定时器**，
   * 单靠 setTimeout tick 的 drain 会先判空返回 ⇒ 回调在提交后才跑（实测：微任务排在 drain 的 setTimeout 之前
   * 但排在 drain 的 await 返回之后）。缺省**只覆盖回调登记时刻在同步执行段内的微任务**
   * （异步段的“发射后不管”微任务无法在登记时刻看见，本模块不声称覆盖）。
   */
  const sandboxMicrotask = (fn, tracked = true) => {
    if (disposed || typeof fn !== 'function') return
    if (!tracked) {
      queueMicrotask(() => {
        if (disposed) return
        try { fn() } catch (error) {
          try { logger?.warn?.(`[mvu-card-runtime] ${key} 微任务异常:`, String(error && error.message || error)) } catch {}
        }
      })
      return
    }
    const registered = registerPending('microtask', 'microtask', currentScript(), 0)
    const sourceId = registered.receipt?.task.source ?? null
    queueMicrotask(() => {
      const task = registered.receipt?.task
      if (!task) { if (registered.error) return; return }
      if (disposed) { task.reject = disposedError(); task.resolve(); return }
      try {
        dispatchPending(task, sourceId, fn)
      } catch (error) {
        task.reject = error
        task.resolve()
      }
    })
  }
  const sandboxRaf = cb => scheduleTimer(() => cb(Date.now()), 16, [], 'raf')

  // ——— DOM 探针（A.6.2 自愈）：读=no-op、写=丢弃但记账；标记来源；可回读 ———
  const noteDomAccess = detail => {
    // activeHandler 在**同步**调用之前就已挂上 ⇒ 加载期与运行期的来源都能定位到脚本
    const src = detail.source ?? currentScript()
    lastDomAccess = { source: src || null, prop: detail.prop, op: detail.op }
    // 在抛错之前持久标记，脚本即使 catch 探针异常也不能取得半成功提交。
    const firstForSource = !needBrowserSources.has(src || null)
    needBrowserSources.add(src || null)
    if (firstForSource) { try { onDomAccess?.(src ?? null) } catch {} }
    if (detail.op === 'write') {
      const err = new Error(`卡脚本写入 DOM 属性 ${String(detail.prop)}：服务端无 DOM，写入已丢弃`)
      err.code = DOM_MARK
      err.domProbe = { source: lastDomAccess.source, prop: detail.prop, op: 'write' }
      throw err
    }
    if (strictNow) {
      const err = new Error(`卡脚本访问 DOM（${String(detail.prop)}，${detail.op}）：服务端探针不提供真实 DOM`)
      err.code = DOM_MARK
      err.domProbe = { source: lastDomAccess.source, prop: detail.prop, op: detail.op }
      throw err
    }
  }
  const makeDomProbe = (prop, kind, source = null) => {
    const cacheKey = `${kind}:${String(prop)}`
    const hit = probeMap.get(cacheKey)
    if (hit) return hit
    const target = function cardUiDomProbe() {}
    const probe = new Proxy(target, {
      get(t, p) {
        if (typeof p === 'symbol') {
          // 原语化（innerHTML += x / `${x}` / x == ''）：给空字符串，避免 "undefined"/"[object Function]" 污染数据
          if (p === Symbol.toPrimitive) return hint => (hint === 'number' ? 0 : '')
          return Reflect.get(t, p)
        }
        if (p === 'toString' || p === 'valueOf') return () => `[${DOM_MARK}:${String(prop)}]`
        noteDomAccess({ prop: `${String(prop)}.${String(p)}`, op: 'read', source })
        return makeDomProbe(`${String(prop)}.${String(p)}`, 'child', source)
      },
      apply() {
        noteDomAccess({ prop: String(prop), op: 'call', source })
        return makeDomProbe(String(prop), 'call', source)
      },
      set(t, p, v) {
        noteDomAccess({ prop: `${String(prop)}.${String(p)}`, op: 'write', source })
        return true
      },
      has() { return true },
      ownKeys() { return ['dshDomProbe'] },
      getOwnPropertyDescriptor() { return { configurable: true, enumerable: false, value: DOM_MARK } },
    })
    probeMap.set(cacheKey, probe)
    if (probeMap.size > PROBE_CACHE_MAX) { // 超上界就整体丢弃（下次访问重建），不设淘汰算法的复杂度
      probeMap.clear()
      probeMap.set(cacheKey, probe)
    }
    return probe
  }

  // ——— 事件注册（释放后拒绝） ———
  const eventOn = (event, handler) => {
    if (disposed) return handler
    if (typeof handler !== 'function') return handler
    if (currentScript()) handlerSources.set(handler, currentScript())
    events.push({ event: String(event), handler, source: handlerSources.get(handler) || null })
    return handler
  }
  const eventOff = (event, handler) => {
    if (disposed) return handler
    const idx = events.findIndex(e => e.event === String(event) && e.handler === handler)
    if (idx >= 0) events.splice(idx, 1)
    return handler
  }
  const eventTavern = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
    MESSAGE_SENT: 'MESSAGE_SENT',
    MESSAGE_UPDATED: 'MESSAGE_UPDATED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
  }
  // 通用别名（2026-10-04）：MVU 上游卡脚本既写 `eventTavern` 也写 `eventTypes`/`tavern_events`
  // 指同一张**真事件名**表。**只做别名，不加假事件**：仍是上面 6 个真名，
  // 不凭空补 `CHAT_COMPLETION_PROMPT_READY` / iframe 之类未接线的事件（那会让卡脚本以为能收到）。
  const tavernEvents = eventTavern
  const eventTypes = eventTavern

  const consoleShim = {
    log: (...a) => logger.info?.(`[${key}]`, ...a),
    info: (...a) => logger.info?.(`[${key}]`, ...a),
    warn: (...a) => logger.warn?.(`[${key}]`, ...a),
    error: (...a) => logger.error?.(`[${key}]`, ...a),
    debug: () => {},
  }

  // 沙箱内自派发：只投回本 runtime（释放后不再分发；加载期拒绝，避免撞到未建好的 API）
  const eventEmit = async (event, ...args) => {
    if (disposed || booting) return null
    return runtimeApi.dispatchEvent(String(event), ...args)
  }

  const sandbox = {
    // 宿主 API（由调用方注入：变量读写、楼层操作等）
    ...(hostApi || {}),
    // 事件系统
    eventOn, eventOff, eventTavern, eventEmit,
    // 别名（同 6 真事件名，见上）：`tavern_events` / `eventTypes` 是卡脚本的常见写法。
    tavern_events: tavernEvents,
    eventTypes,
    eventOnce: (event, handler) => { eventOn(event, handler); const entry = events.at(-1); if (entry?.handler === handler) entry.once = true; return handler },
    eventMakeFirst: (event, handler) => { eventOff(event, handler); eventOn(event, handler); const entry = events.pop(); if (entry?.handler === handler) events.unshift(entry); return handler },
    eventMakeLast: (event, handler) => { eventOff(event, handler); return eventOn(event, handler) },
    eventRemoveListener: eventOff,
    eventClearEvent: event => { for (let i = events.length - 1; i >= 0; i--) if (events[i].event === String(event)) events.splice(i, 1) },
    eventClearListener: handler => { for (let i = events.length - 1; i >= 0; i--) if (events[i].handler === handler) events.splice(i, 1) },
    eventClearAll: () => { events.length = 0 },
    initializeGlobal: (name, value) => { if (disposed) throw disposedError(); sandbox[String(name)] = value },
    waitGlobalInitialized: async name => {
      const wanted = String(name)
      const until = Date.now() + timeoutMs
      while (sandbox[wanted] === undefined) {
        if (disposed) throw disposedError()
        if (Date.now() >= until) throw new Error('等待全局初始化超时：' + wanted)
        await Promise.race([new Promise(resolve => globalThis.setTimeout(resolve, 5)), cancelSignal.promise])
      }
      return sandbox[wanted]
    },
    // 环境
    console: consoleShim,
    setTimeout: sandboxSetTimeout,
    clearTimeout: clearTimer,
    setInterval: sandboxSetInterval,
    clearInterval: clearTimer,
    queueMicrotask: sandboxMicrotask,
    structuredClone,
    performance: { now: () => Date.now() },
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) dsh-server-engine', language: 'zh-CN', languages: ['zh-CN'], platform: 'Linux x86_64', onLine: true },
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1', protocol: 'http:', host: '127.0.0.1', pathname: '/', search: '', hash: '' },
    getComputedStyle: () => ({ getPropertyValue: () => '', getPropertyPriority: () => '', setProperty: () => {} }),
    requestAnimationFrame: sandboxRaf,
    cancelAnimationFrame: clearTimer,
    localStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size } } })(),
    sessionStorage: (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), get length() { return m.size } } })(),
    alert() {}, confirm() { return false }, prompt() { return null },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
    fetch: undefined,
    crypto: globalThis.crypto,
    document: makeDomProbe('document', 'document'),
    params,
    // 钩子执行桥（沙箱内的薄垫片，见 makeCaller）
    _dshRt: { fn: null, args: null, out: null },
    // 宿主侧"未被脚本 await 的异步写"跟踪桥：hostApi 把返回的 thenable 交进来，随 drain 一起等。
    // 放在沙箱对象上是为了让 hostApi 拿得到（不是给卡脚本用的 API；脚本无从知道它的存在）。
    // **登记时刻就要调用**（不是 settle 之后）：settled promise 进表只会立刻回吐、与已结算顺序打架。
    // 同一 thenable 按对象身份去重（WeakSet），宿主忘了摘也不会重复登记。
    _dshTrackPending: (thenable, source) => trackPendingOnce(thenable, source ?? currentScript()),
    // 宿主侧把已跟踪的写摘掉（与 _dshTrackPending 成对；幂等，找不到即无操作）。
    _dshForgetPending: thenable => forgetPending(thenable),
    // 宿主侧"在本次 run 的**同步段**登记一个微任务"的桥：jQuery ready / `$(fn)` 走它，
    // 这样 ready 回调里再登记的短 timer 归属正确、且能被 drain 等到（否则加载期没人等它）。
    _dshRegisterMicrotask: fn => sandboxMicrotask(fn, true),
    _dshRunHandlerSync: () => { throw new Error('runtime bridge not installed') },
  }
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.top = sandbox
  sandbox.parent = sandbox
  sandbox.frames = sandbox
  // 作者公开Helper同时暴露window与TavernHelper；使用实时访问器，事件API也必须是本runtime真桥。
  const helper = {}
  for (const name of Object.keys(hostApi || {}).concat(['tavern_events','eventTypes','eventTavern','eventOn','eventOff','eventOnce','eventEmit','eventMakeFirst','eventMakeLast','eventRemoveListener','eventClearEvent','eventClearListener','eventClearAll','initializeGlobal','waitGlobalInitialized'])) {
    if (name.startsWith('_') || Object.prototype.hasOwnProperty.call(helper,name)) continue
    Object.defineProperty(helper,name,{enumerable:true,configurable:true,get:()=>sandbox[name],set:value=>{sandbox[name]=value}})
  }
  sandbox.TavernHelper = helper

  const context = vm.createContext(sandbox)

  // ——— 钩子调用桥：**在 vm 上下文内**调用 handler，同步部分受 vm timeout 约束 ———
  function makeCaller(fn, args) {
    const state = { promise: null, syncError: null }
    sandbox._dshRt.fn = fn
    sandbox._dshRt.args = args
    sandbox._dshRt.out = state
    try {
      // IIFE 包一层：同一 vm 全局里反复 runInContext，顶层 const 会 "already been declared"
      const script = new vm.Script(
        ';(function () { const __r = _dshRt; try { __r.out.promise = __r.fn(...__r.args) } catch (e) { __r.out.syncError = e } })()',
        { filename: `${key}:<hook:${++proxyId}>` },
      )
      // **来源绑定**：钩子执行（含其 async 后续段）都在它自己的脚本身份作用域内 ⇒ 期间登记的 timer
      // 归属该脚本，不串到同卡另一个脚本（callbackScope 只携带脚本身份，不携带任何业务状态）。
      callbackScope.run(handlerSources.get(fn) ?? currentScript() ?? null, () => script.runInContext(context, { timeout: syncTimeout }))
    } finally {
      sandbox._dshRt.fn = null
      sandbox._dshRt.args = null
      sandbox._dshRt.out = null
    }
    return { state, error: state.syncError }
  }

  const isTimeoutError = error => /timed out|执行超时|钩子执行超时|钩子等待生成超时/i.test(String(error && error.message || error))
  /**
   * 等钩子 promise：**先挂 no-op 处理**再交给 Promise.race。
   * 否则 race 由预算先结算时，败方钩子稍后 reject 会变成进程级 unhandledRejection
   * （dispose 取消正在等待的钩子时就会走到这条路径）。
   */
  function awaitHandler(handlerPromise, budget) {
    handlerPromise.then(() => {}, () => {})
    // 脚本 promise 的**后续段**（await 之后的 timer 登记）要继承它自己的脚本身份；
    // awaitHandler 本身也在本次派发的 ALS 作用域内被调，因此这里只是显式再钉一次来源。
    const source = currentScript()
    return callbackScope.run(source, () => Promise.race([handlerPromise, budget]))
  }
  function serializeError(error) {
    if (!error) return { message: 'unknown error', name: 'Error' }
    return {
      name: String(error.name || 'Error'),
      message: String(error.message || error),
      code: error.code,
      stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 4).join('\n') : undefined,
      domProbe: error.domProbe || undefined,
    }
  }
  const isOptsLike = value =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error) &&
    (Object.prototype.hasOwnProperty.call(value, 'strict') || Object.keys(value).length === 0)
  /**
   * 支持两种新式写法（其余一律按旧式「事件名 + 位置参数」，零破坏）：
   *   dispatchEvent({ strict: true }, 'event', ...args)   // 选项在前
   *   dispatchEvent('event', { strict: true }, ...args)   // 事件名在前、选项在其后
   */
  function parseDispatchArgs(args) {
    const first = args[0]
    if (isOptsLike(first)) return { event: String(args[1] ?? ''), eventArgs: args.slice(2), strict: Boolean(first.strict) }
    if (typeof first === 'string' && isOptsLike(args[1])) return { event: first, eventArgs: args.slice(2), strict: Boolean(args[1].strict) }
    return { event: String(first ?? ''), eventArgs: args.slice(1), strict: false }
  }
  /**
   * strict 模式的统一失败出口：**任何**失败都必须走这里抛出。
   * 不区分「策略拦截 vs 坏结果」——超时/已释放/DOM 探针在 strict 下让消费者继续提交，
   * 正是"吞 error 提交坏结果"的原始形态，所以一律抛。
   * 抛出物携带 kind/event/source/code/outcome，消费方可判别（domProbe / timeout / disposed / error）。
   */
  function strictError({ event, source, result, outcome, error, cause }) {
    const kind = result?.timedOut ? 'timeout' : (result?.error?.code === DOM_MARK ? 'dom' : (result?.error?.code === DISPOSED_MARK ? 'disposed' : 'error'))
    const detail = result?.error?.message || (error && error.message) || '未知错误'
    const wrapped = Object.assign(new Error(`[strict] 钩子失败 ${event}${source ? ` @${source}` : ''}（${kind}）: ${detail}`), {
      event, source: source || null, kind, outcome, result: result || null, cause: cause || error || null,
    })
    if (kind === 'timeout') wrapped.code = SANDBOX_ERRORS.timeoutCode
    else if (result?.error?.code) wrapped.code = result.error.code
    if (result?.error?.domProbe) wrapped.domProbe = result.error.domProbe
    return wrapped
  }

  const runtimeApi = {
    cardPath: key,
    context,
    sandbox,
    events,
    errors,
    timeoutMs,
    syncTimeoutMs: syncTimeout,
    /** 本运行时正在用的“生成在飞”计数对象（新接线：把它交给 wrapGenerateRaw 的 activity） */
    activity: sharedActivity,
    get disposed() { return disposed },
    get currentScriptId() { const name = currentScript(); return (Array.isArray(sources) ? sources : []).find(source => source.name === name)?.id || '' },
    get currentSource() { return currentScript() },
    /** 是否有脚本/运行期触发过 DOM 探针（宿主据此转浏览器） */
    get domAccessed() { return needBrowserSources.size > 0 || sourceRecords.some(r => r.dom) },
    /** 需要转浏览器执行的脚本名集合（null = 运行期触发、无法定位脚本） */
    get needsBrowser() { return [...needBrowserSources] },
    /** 加载结果快照（含 DOM 标记与脚本名） */
    get sources() { return sourceRecords.map(r => ({ name: r.name, ok: r.ok, error: r.error, dom: r.dom })) },
    /** 最近一次探针访问的来源标记（运行期 DOM 触发可回读，不再只能传 null） */
    get lastDomAccess() { return lastDomAccess },
    /** 最近一次 dispatchEvent 的结果元数据（ok / 每钩子错误 / 超时 / committed） */
    get lastEventOutcome() { return lastEventOutcome },
    /** 已登记未结算的待办数（诊断用；不含 interval 与超 ceiling 的长延迟） */
    pendingTasks() { return pendingTasks.size },
    /** 待办明细快照（诊断用：来源 / 种类 / 是否 timer） */
    pendingTaskDetails() {
      return [...pendingTasks].map(receipt => ({ source: receipt.task.source, kind: receipt.task.kind, pattern: receipt.task.pattern }))
    },
    /**
     * **有界 drain**：等本次 run 已登记的待办全部结算 —— 既等 timer 回调，也等回调里未被 await 的
     * thenable（`Promise.all` 收不到的"发射后不管"写）。
     *
     * @param opts.source 要等的**来源**（本 runtime 自己的登记标签）：`'timer'`（缺省，只作用在短延迟
     *        定时器上，对应 V1 的"只接管 setTimeout"）/ `'microtask'` / `'promise'` / `'hook'`
     *        —— 后者把 timer / microtask / promise 三类一起纳入（宿主 jQuery ready 用）。
     * @param opts.timeoutMs 预算（有界；<=0 取 pendingCeilingMs；缺省 ceiling 本身）
     * @param opts.throwOnTimeout 缺省 true ⇒ 超预算抛错（**不返回半成功**，不宽 latewrite）
     * @returns { drained, errors, remaining, expired }；throwOnTimeout=false 时超预算返回 remaining>0
     */
    async drainPendingTasks({ source = 'timer', timeoutMs = 0, throwOnTimeout = true } = {}) {
      const want = source === 'hook' ? ['timer', 'microtask', 'promise'] : [String(source)]
      const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : (identityWindow || 3000)
      const started = Date.now()
      // 不盲等：每轮先判空，空了立刻返回；被拍到空的时间窗内没有登记 ⇒ 不空转、不续命。
      let remaining = [...pendingTasks].filter(receipt => want.includes(receipt.task.pattern)).length
      while (remaining > 0) {
        const left = budget - (Date.now() - started)
        if (left <= 0) break
        await new Promise(resolve => {
          const wake = () => { clearTimeout(waiter); pendingWaiters.delete(wake); resolve() }
          // **不 unref**：这个 tick 承载的是 drain 自己的有界预算，unref 会让"回调永不结算"
          // 的现场直接退出进程（实测：顶层 await 变成 unsettled），即"超时抛错"这条契约永远不触发。
          const waiter = globalThis.setTimeout(wake, Math.max(1, left))
          pendingWaiters.add(wake)
        })
        remaining = [...pendingTasks].filter(receipt => want.includes(receipt.task.pattern)).length
      }
      const errors = pendingErrors.slice()
      pendingErrors.length = 0
      if (remaining > 0 && throwOnTimeout) {
        const stuck = [...pendingTasks].find(receipt => want.includes(receipt.task.pattern))
        throw drainError(stuck?.task || { kind: 'timer', pattern: want[0], source: null }, `待办回调超出 ${budget}ms 预算（仍有 ${remaining} 项未结算）`)
      }
      // 回调抛错 / 异步 reject **不吞**：与超时同一条出口，抛第一项（消费方据此不提交）。
      if (errors.length > 0 && throwOnTimeout) throw errors[0]
      return { drained: remaining === 0, errors, remaining, expired: Date.now() - started }
    },
    /** 关闭本 runtime 的待办回调：未触发的**不再执行**，等待方立刻唤醒（拒新回调 + 拒旧写）。 */
    closeTimers(reason = '本次 run 已结束，未触发的待办回调被取消') {
      const count = pendingTasks.size
      closePending(reason)
      return count
    },

    /**
     * 触发事件 → 调用沙箱内所有匹配的钩子（钩子在 vm 上下文内执行，同步部分受 syncTimeoutMs 约束）。
     * @param event 事件名
     * @param opts  可选 **第一或第二参数** { strict?: boolean }
     *   - strict:true  ⇒ **任何失败（钩子异常 / 超时 / DOM 探针 / 已释放）一律向上抛**，
     *     调用方拿不到「继续提交」的机会（消费方约定：`dispatchEvent({ strict: true }, event, ...args)`）
     *   - strict:false ⇒ 旧兼容：返回 outcome、只告警
     * @returns outcome { ok, event, strict, args, results[], committed }（非 strict 恒 resolve）
     */
    async dispatchEvent(...args) {
      if (booting) await runtimeApi.ready
      const parsed = parseDispatchArgs(args)
      const event = parsed.event
      const eventArgs = parsed.eventArgs
      const strict = parsed.strict
      const outcome = {
        ok: true, event, strict, args: eventArgs.length, results: [],
        committed: false, startedAt: Date.now(), finishedAt: null, error: null,
      }
      if (disposed) {
        outcome.ok = false
        outcome.error = serializeError(disposedError())
        outcome.finishedAt = Date.now()
        lastEventOutcome = outcome
        const err = Object.assign(new Error(`${SANDBOX_ERRORS.disposed}（strict）`), { code: DISPOSED_MARK, event, kind: 'disposed', outcome })
        throw err
      }
      strictNow = strict
      lastEventOutcome = outcome
      lastDomAccess = null // 本次派发重新记录来源：别把加载期的旧来源当成本次运行的标记
      const batch = events.filter(e => e.event === event)

      for (const e of batch) {
        if (!events.includes(e)) continue
        if (e.once) eventOff(e.event, e.handler)
        if (disposed) {
          outcome.ok = false
          outcome.error = serializeError(disposedError())
          outcome.finishedAt = Date.now()
          lastEventOutcome = outcome
          const err = Object.assign(new Error(`${SANDBOX_ERRORS.disposed}（strict）`), { code: DISPOSED_MARK, event, kind: 'disposed', outcome })
          if (strict) throw err
          return outcome
        }
        if (reentrant) {
          const err = new Error(`钩子内重入 dispatchEvent(${event}) 被拒绝（防无限递归）`)
          err.code = REENTRANT_MARK
          outcome.ok = false
          outcome.error = serializeError(err)
          outcome.finishedAt = Date.now()
          lastEventOutcome = outcome
          if (strict) throw err
          return outcome
        }
        const result = { event, source: e.source || null, ok: false, timedOut: false, elapsedMs: 0, value: undefined, error: null }
        const startedAt = Date.now()
        let settled = false
        let budget = null
        let out = null
        try {
          reentrant = true
          activeHandler = e.handler // 同步执行前挂上 ⇒ 运行期 DOM 探针能定位到脚本
          out = makeCaller(e.handler, eventArgs)
        } catch (error) {
          // vm 同步 timeout / 编译失败：同步阶段就没有可用结果
          result.timedOut = isTimeoutError(error)
          result.error = serializeError(error)
          result.elapsedMs = Date.now() - startedAt
          outcome.ok = false
          if (!outcome.error) outcome.error = result.error
          outcome.results.push(result)
          logger?.warn?.(`[mvu-card-runtime] 钩子${result.timedOut ? '同步超时' : '异常'} ${key}/${event}/${result.source || '?'}: ${result.error.message}`)
          if (strict) { // strict：连同步失败也不许消费者继续提交
            outcome.finishedAt = Date.now()
            lastEventOutcome = outcome
            throw strictError({ event, source: result.source, result, outcome, error, cause: error })
          }
          continue
        } finally {
          reentrant = false
          activeHandler = null
        }

        try {
          if (out.error) throw out.error
          activeHandler = e.handler
          if (out.state.promise && typeof out.state.promise.then === 'function') {
            budget = hookBudget({
              isSettled: () => settled,
              activity: sharedActivity,
              timeoutMs,
              awaitTimeoutMs,
              tickMs,
              maxTicks: maxBudgetTicks,
              signal: cancelSignal,
              onTimeout: err => { result.timedOut = true; result.error = serializeError(err) },
            })
            budgets.add(budget)
            result.value = await awaitHandler(out.state.promise, budget)
          } else {
            result.value = out.state.promise
          }
          if (moduleLoader) await moduleLoader.waitForImports()
          if (result.timedOut) throw new Error(result.error?.message || SANDBOX_ERRORS.timeout)
          result.ok = true
        } catch (error) {
          result.timedOut = result.timedOut || isTimeoutError(error)
          if (!result.error) result.error = serializeError(error)
          const code = result.error.code
          const isDom = code === DOM_MARK
          const isDisposed = code === DISPOSED_MARK
          const detail = `[mvu-card-runtime] 钩子异常 ${key}/${event}/${result.source || '?'}: ${result.error.message}`
          if (isDisposed) {
            // dispose 与在飞钩子的竞态：预期路径，但要记录（strict 下仍然抛，见下）
            logger?.warn?.(detail)
          } else if (result.timedOut || isDom) {
            logger?.warn?.(detail)
          } else {
            logger?.error?.(detail)
          }
          if (isDom) { try { onDomAccess?.(result.source || result.error.domProbe?.source || null) } catch {} }
          outcome.ok = false
          if (!outcome.error) outcome.error = result.error
          if (strict) {
            // strict：**任何**失败（异常/超时/DOM/已释放）一律向上抛
            outcome.finishedAt = Date.now()
            lastEventOutcome = outcome
            throw strictError({ event, source: result.source, result, outcome, error, cause: error })
          }
          if (isDisposed) {
            outcome.finishedAt = Date.now()
            lastEventOutcome = outcome
            return outcome
          }
        } finally {
          activeHandler = null
          settled = true
          if (budget) { budgets.delete(budget); budget.cancel('dispatch settled') }
          result.elapsedMs = Date.now() - startedAt
          if (!outcome.results.includes(result)) outcome.results.push(result)
        }
        if (disposed) {
          outcome.ok = false
          outcome.error = serializeError(disposedError())
          outcome.finishedAt = Date.now()
          lastEventOutcome = outcome
          const err = Object.assign(new Error(`${SANDBOX_ERRORS.disposed}（strict）`), { code: DISPOSED_MARK, event, kind: 'disposed', outcome })
          if (strict) throw err
          return outcome
        }
      }
      outcome.committed = outcome.ok
      outcome.finishedAt = Date.now()
      lastEventOutcome = outcome
      return outcome
    },

    /** 释放：清全部定时器/在飞预算，并禁掉后续 eventOn / dispatchEvent / 回调 */
    dispose() {
      if (disposed) return { alreadyDisposed: true, clearedTimers: 0, cancelledBudgets: 0, closedPending: 0 }
      disposed = true
      moduleLoader?.dispose()
      strictNow = false
      const clearedTimers = timers.size
      for (const { kind, handle } of [...timers.values()]) {
        if (kind === 'interval') globalThis.clearInterval(handle)
        else globalThis.clearTimeout(handle)
      }
      timers.clear()
      // 待办表必须**先**关闭并唤醒 drain 的等待方：否则 drain 会一直等到预算耗尽（dispose 之后
      // 新回调已经一律拒绝，等下去没有任何意义）。
      const closedPending = pendingTasks.size
      closePending(SANDBOX_ERRORS.disposed)
      settleWaiters()
      pendingErrors.length = 0
      const cancelledBudgets = budgets.size
      for (const b of [...budgets]) { try { b.cancel() } catch {} }
      budgets.clear()
      events.length = 0
      handlerSources.clear()
      probeMap.clear()
      cancelResolve(SANDBOX_ERRORS.disposed)
      if (runtimes.get(key) === runtimeApi) runtimes.delete(key)
      return { alreadyDisposed: false, clearedTimers, cancelledBudgets, closedPending }
    },
  }

  // ——— 加载期脚本执行（逐脚本，DOM 触发的脚本名可定位） ———
  function modules() {
    if (!moduleLoader) moduleLoader = createEsmModuleLoader({ ...moduleOptions, context, hostApi: sandbox, timeoutMs,
      isDisposed: () => disposed,
      onBrowserModule: detail => { const source = runtimeApi.currentSource; needBrowserSources.add(source); onDomAccess?.(source) },
    })
    return moduleLoader
  }
  function dynamicImport(specifier, reference) {
    const pending = modules().importModuleDynamically(specifier, reference)
    moduleImports.add(pending)
    pending.then(() => moduleImports.delete(pending), () => moduleImports.delete(pending))
    return pending
  }
  const sourceList = Array.isArray(sources) ? sources : (sources ? [...sources] : [])
  async function loadSources() {
  for (const src of sourceList) {
    const name = src?.name || `${key}:script`
    const rec = { name, ok: false, error: null, dom: false }
    sourceRecords.push(rec)
    activeSource = name
    try {
      const code = String(src?.code ?? '')
      if (!code.trim()) { rec.ok = true; continue }
      if (src.kind === 'esm') {
        await callbackScope.run(name, () => modules().load({ code, name, identifier: src.identifier }))
      } else {
        const script = new vm.Script(code, { filename: name, importModuleDynamically: dynamicImport })
        callbackScope.run(name, () => script.runInContext(context, { timeout: timeoutMs }))
        while (moduleImports.size) await Promise.all([...moduleImports])
      }
      if (moduleLoader) await moduleLoader.waitForImports()
      if (disposed) throw disposedError()
      rec.ok = true
    } catch (error) {
      if (error && error.code === DOM_MARK) {
        rec.dom = true
        rec.error = `已自动识别为界面脚本，转浏览器执行（来源 ${error.domProbe?.source ?? name}，访问 ${error.domProbe?.prop ?? '?'}）`
        errors.push({ source: name, error: rec.error, domProbe: true })
        needBrowserSources.add(name)
        try { onDomAccess?.(name) } catch {}
        logger?.info?.(`[mvu-card-runtime] ${key}/${name}: DOM 探针触发，转浏览器执行`)
        continue
      }
      rec.error = String(error && error.message || error)
      errors.push({ source: name, error: rec.error })
      logger?.warn?.(`[mvu-card-runtime] 脚本执行失败 ${key}/${name}:`, rec.error)
    } finally {
      activeSource = null
    }
  }
  booting = false
  // 兜底：极少数经别名注册的钩子拿不到脚本名
  for (const e of events) if (!e.source) e.source = handlerSources.get(e.handler) || null
  }
  onRuntimeCreated?.(runtimeApi)
  runtimeApi.ready = loadSources()
  // 调用方可能因dispose提前离开，异步加载异常不可变成进程级unhandledRejection。
  runtimeApi.ready.catch(() => {})

  return runtimeApi
}

/** 获取或创建某卡的运行时（按 cardPath 缓存）——兼容旧签名与旧语义（dispose 会自摘缓存） */
export function getOrCreateRuntime(cardPath, sources, hostApi, timeoutMs, onDomAccess, extra = {}) {
  const key = String(cardPath ?? '(unknown-card)')
  let rt = runtimes.get(key)
  if (!rt || rt.disposed) {
    rt = createCardScriptRuntime({ cardPath, sources, hostApi, timeoutMs, onDomAccess, ...extra })
    runtimes.set(key, rt)
  }
  return rt
}

export function disposeRuntime(cardPath) {
  const key = String(cardPath ?? '(unknown-card)')
  const rt = runtimes.get(key)
  if (rt) { rt.dispose(); runtimes.delete(key) }
}

export function disposeAll() {
  for (const rt of runtimes.values()) rt.dispose()
  runtimes.clear()
}
