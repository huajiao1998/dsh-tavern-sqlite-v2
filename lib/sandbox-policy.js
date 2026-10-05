// 卡脚本沙箱的「策略层」—— 我们加的策略集中在本包，作者文件只留薄调用（见 deploy/sandbox-policy.seams.md）
//
// 三件东西（原来以补丁形式内联在作者文件里）：
//   1) activity 注册表：每张卡一个 { pending }（随 runtime 缓存复用）—— 判定"是否有生成在飞"
//   2) wrapGenerateRaw：沙箱侧 generateRaw 的真实实现（调用窗口校验 + 在飞计数 + 返回字符串对齐 ST 语义）
//   3) hookBudget：活动感知的异步钩子预算 —— 默认 timeoutMs（8s，防护跑飞的钩子）；
//      沙箱内有生成在飞时放宽到 awaitTimeoutMs（模型调用远超 8s）；定时器 unref、settled 早退，
//      避免放宽后长期占住事件循环。
//
// 为什么放在这里而不是内联进作者文件：作者文件会被上游更新覆盖，而"预算/接线策略"是我们的资产。
// 依赖由调用方注入（bindingOf / options / str 都是作者的局部设施）—— 不在本包 fork 作者代码。
//
// 2026-10-01 资源受控化（本文件 ②③ 两项）：
//   - hookBudget 仍是「返回 Promise」的旧签名（`Promise.race([handler, hookBudget(...)])` 原样可用），
//     但追加 **onCancel**（dispose 用）：取消不掉「已 reject 的旧 promise」是上一版的漏洞，
//     这里让 cancel 真正让 race 结束，且**保证不留定时器**。
//   - wrapGenerateRaw 增加**回程校验**：进入时的 binding 对象必须在 await 之后仍是同一个且未关闭，
//     否则抛错（旧请求不许借新窗口的返回值）。这一条是"结算提交坏结果"的源头之一。

const sandboxActivities = new Map()

/** 错误文案集中（测试与 runtime 都靠这些字符串断言） */
export const SANDBOX_ERRORS = {
  noWindow: '卡脚本 generateRaw 调用窗口未开启（不在结算或兜底派发期）',
  noImpl: 'generateRaw 尚未接线（缺少 options.generateRaw）',
  windowClosed: '卡脚本 generateRaw 的调用窗口已在等待期间关闭（结果作废，不提交）',
  windowSwapped: '卡脚本 generateRaw 的调用窗口已在等待期间被替换（结果作废，不提交）',
  timeout: '钩子执行超时',
  awaitTimeout: '钩子等待生成超时',
  timeoutCode: 'SANDBOX_TIMEOUT',
  disposeTimeout: '运行时已释放（钩子预算取消）',
  disposed: '运行时已释放',
}

/** 取（或建）某张卡的 activity 计数对象；与 runtime 缓存同生命周期复用。 */
export function activityFor(cardPath) {
  let activity = sandboxActivities.get(cardPath)
  if (!activity) {
    activity = { pending: 0 }
    sandboxActivities.set(cardPath, activity)
  }
  return activity
}

/** 诊断/测试用：清空注册表（生产路径不调用）。 */
export function resetSandboxActivities() {
  sandboxActivities.clear()
}

/**
 * 绑定（调用窗口）是否还能用 —— 只认我们注入得起的几种形状，不猜作者内部结构：
 *   - `binding.closed === true` / `binding.disposed === true`（绑定对象自己关门）
 *   - `binding.active === false`（显式非活动）
 *   - 调用方给了 `isClosed(binding)` 就以它为准（adapter 侧可注入更精确的判定）
 * @returns true=已关闭，不可用
 */
export function isBindingClosed(binding, isClosed) {
  if (!binding) return true
  if (typeof isClosed === 'function') {
    try { return Boolean(isClosed(binding)) } catch { return true }
  }
  if (binding.closed === true || binding.disposed === true) return true
  if (binding.active === false) return true
  return false
}

/**
 * 沙箱侧 generateRaw 的真实实现（原来是 host-adapter 里的内联 async 函数）。
 * @param bindingOf - () => binding|null：调用窗口（结算或兜底派发期）由作者侧决定
 * @param options - 作者传给 createTavernScriptHostAdapter 的 options（需含 generateRaw）
 * @param activity - { pending }：在飞计数
 * @param str - 作者的字符串化工具
 * @param isClosed - 可选 (binding) => boolean：更精确的"窗口已关闭"判定
 * @returns async (config) => string
 *
 * 回程校验（2026-10-01）：结果回来时**再取一次** bindingOf()，要求
 *   ① 是同一个对象（不是新窗口的 binding）；② 该对象未关闭。
 * 不满足就抛错 —— 绝不把一个已经作废的生成结果交回脚本去提交。
 */
export function wrapGenerateRaw({ bindingOf, options, activity, str, isClosed } = {}) {
  return async config => {
    const binding = typeof bindingOf === 'function' ? bindingOf() : null
    if (!binding) throw new Error(SANDBOX_ERRORS.noWindow)
    if (typeof options?.generateRaw !== 'function') throw new Error(SANDBOX_ERRORS.noImpl)
    activity.pending += 1
    try {
      const result = await options.generateRaw(config, {
        sessionId: binding.sessionId, eventId: binding.eventId,
        // 仅可信宿主消费者按需投影事务当前态；不向卡脚本开放绑定对象，也不强制整档物化。
        ...(typeof options.readGenerationContext === 'function'
          ? { context: await options.readGenerationContext(binding) } : {}),
      })
      // —— 回程校验：同一对象 + 未关闭，缺一不许提交 ——
      if (isBindingClosed(binding, isClosed)) throw new Error(SANDBOX_ERRORS.windowClosed)
      const now = typeof bindingOf === 'function' ? bindingOf() : null
      if (now !== binding) throw new Error(SANDBOX_ERRORS.windowSwapped)
      return typeof result === 'string' ? result : str(result && result.text)
    } finally {
      activity.pending -= 1
    }
  }
}

/**
 * 活动感知的异步钩子预算（原是 card-runtime 里的内联 Promise）。
 * 兼容旧签名：`await Promise.race([handler, hookBudget({ isSettled, activity, timeoutMs, awaitTimeoutMs })])`
 *
 * @param isSettled - () => boolean：调用方的 settled 早退信号
 * @param activity - { pending }|null
 * @param timeoutMs - 默认预算（无生成在飞时）
 * @param awaitTimeoutMs - 生成在飞时的放宽预算
 * @param tickMs - 轮询间隔（默认 250ms）
 * @param maxTicks - 轮询次数上限（缺省 0 = 不限；只作保险，正常由两档预算先到）
 * @param onTimeout - 超时钩子（可观测）
 * @param onCancel - 取消钩子（可观测）
 * @param signal - 可选 { promise }：调用方给的取消信号（如 runtime.dispose 的 deferred）
 * @returns Promise（**只会 reject**：超时 / 取消；正常路径由 e.handler 胜出 Promise.race）
 *
 * 资源受控：无论超时、取消还是 settled 早退，**所有定时器都在退出路径上清掉**；
 * 定时器一律 unref（不占事件循环），但轮询是持续的 ⇒ 不会出现"unref 导致永不 settle"的旧坑。
 */
export function hookBudget({
  isSettled,
  activity,
  timeoutMs = 8000,
  awaitTimeoutMs = 180000,
  tickMs = 250,
  maxTicks = 0,
  onTimeout,
  onCancel,
  signal,
} = {}) {
  // 若把 api 自身 resolve 进自己，就形成自引用 thenable ⇒ settle 链永不推进（实测坑）。
  // 因此内部用一个**独立 promise** 作结算链，api 只是包在外面的门面（含 cancel）。
  let settleReject = () => {}
  const internal = new Promise((_, reject) => { settleReject = reject })
  const api = (() => {
    const start = Date.now()
    let done = false
    let timer = null
    let ticks = 0
    let cancelReason = SANDBOX_ERRORS.disposeTimeout
    const stop = () => { if (timer) { clearTimeout(timer); timer = null } }

    const finish = (error, viaCancel) => {
      if (done) return
      done = true
      stop()
      try { (viaCancel ? onCancel : onTimeout)?.(error) } catch {}
      settleReject(error)
    }
    const settleViaCancel = reason => {
      if (typeof reason === 'string' && reason) cancelReason = reason
      finish(new Error(cancelReason), true)
    }
    /** 到点判断（tick 与 waiter 共用，避免只看下一次 tick 造成晚到） */
    const dueCheck = () => {
      if (done) return true
      const generating = Boolean(activity && activity.pending > 0)
      const limit = generating ? awaitTimeoutMs : timeoutMs
      const overBudget = Date.now() - start >= limit
      if (overBudget || (maxTicks && ticks >= maxTicks)) {
        finish(new Error(generating ? SANDBOX_ERRORS.awaitTimeout : SANDBOX_ERRORS.timeout), false)
        return true
      }
      return false
    }
    const tick = () => {
      timer = null
      if (done) return
      if (typeof isSettled === 'function' && isSettled()) {
        // 早退：主体已结束（或是我们的赛跑已判定），不再占定时器
        stop()
        return
      }
      ticks += 1
      if (dueCheck()) return
      schedule()
    }
    const schedule = () => {
      if (done) return
      timer = setTimeout(tick, tickMs)
      if (timer && timer.unref) timer.unref()
    }
    // 有界等待兜底：unref 定时器在“事件循环被更晚的 timer 顶住”时会晚到 ⇒ 这里用自带 waiter
    // 独立校验到点（保证 wait 上限有界、可释放），结算后立即退出、不留定时器。
    const startWaiter = () => {
      const loop = () => {
        if (done) return
        if (typeof isSettled === 'function' && isSettled()) return
        if (dueCheck()) return
        const t = setTimeout(loop, tickMs)
        if (t && t.unref) t.unref()
      }
      const first = setTimeout(loop, tickMs)
      if (first && first.unref) first.unref()
    }
    const facade = {
      cancel(reason) { settleViaCancel(reason) },
      get settled() { return done },
      /** 兼容：允许调用方 await 这个 thenable（旧调用方走 Promise.race，不受影响） */
      then(onFulfilled, onRejected) { return internal.then(onFulfilled, onRejected) },
      catch(onRejected) { return internal.catch(onRejected) },
      finally(onFinally) { return internal.finally(onFinally) },
    }
    // 取消信号（dispose）：既让 race 结束，也保证定时器清掉
    if (signal && signal.promise) {
      signal.promise.then(
        reason => settleViaCancel(typeof reason === 'string' && reason ? reason : undefined),
        () => settleViaCancel(),
      )
    }
    schedule()
    startWaiter()
    return facade
  })()
  // facade 本身即 thenable（then 转发内部结算链）：Promise.race / await 都能直接用
  return api
}
