// 定向回归：卡脚本运行时的「资源受控生命周期」
//
// 覆盖范围（只测本轮改动的四项能力，不做全包 E2E）：
//   ① dispose 清 timer/interval/RAF/微任务，释放后 eventOn / dispatchEvent / 回调一律拒绝
//   ② dispatchEvent 在 vm 内执行钩子 ⇒ 同步死循环被**同步 timeout** 打断（不再不受 vm timeout 管）
//   ③ strict:true 钩子错误向上抛；非 strict 保持旧行为（只告警、继续）；超时也进 outcome
//   ④ DOM 探针标记来源（脚本名 / 运行期 lastDomAccess）+ 自愈标记（读返回链式 no-op）
//   ⑤ 异步预算有界可释放（hookBudget 旧签名兼容 + cancel 清定时器）
//   ⑥ generateRaw 回程校验：await 之后 binding 必须同一个且未关闭，旧请求不许借新窗口
//
// 运行：node test/mvu-runtime-lifecycle.test.mjs
// 依赖：仅 node 内置 + 本包源码；无网络、无真实存档、不写盘。
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCardScriptRuntime, getOrCreateRuntime, disposeRuntime, isDomProbeError } from '../lib/mvu/mvu-card-runtime.js'
import { hookBudget, wrapGenerateRaw, SANDBOX_ERRORS } from '../lib/sandbox-policy.js'

let pass = 0
const ok = (label, detail = '') => { pass += 1; console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`) }
const quietLogger = { info () {}, warn () {}, error () {}, debug () {} }
const mk = (name, code) => ({ name, code })
const domSources = []

// ───────────────────────────── 1. dispose 资源清理与拒绝 ─────────────────────────────
console.log('1) dispose：清 timer/interval/RAF/微任务，释放后拒绝')
{
  const trace = []
  const rt = createCardScriptRuntime({
    cardPath: '/probe/dispose',
    sources: [mk('t1.js', `
      eventOn('ping', function () { trace('sync') });
      setTimeout(function () { trace('timeout') }, 30);
      setInterval(function () { trace('interval') }, 10);
      requestAnimationFrame(function () { trace('raf') });
      queueMicrotask(function () { trace('micro') });
    `)],
    hostApi: { trace: v => trace.push(v) },
    timeoutMs: 1000,
    logger: quietLogger,
  })
  assert.equal(rt.events.length, 1, '加载期钩子应注册成功')
  assert.equal(rt.disposed, false, '新建运行时未释放')
  assert.equal(rt.sources[0].ok, true, '脚本加载成功')
  ok('加载期 eventOn 注册 + sources 快照')

  const before = trace.slice()
  const released = rt.dispose()
  assert.equal(released.clearedTimers >= 3, true, 'dispose 应清掉登记的定时器（timeout/interval/raf）')
  assert.equal(rt.disposed, true, 'dispose 后 disposed=true')
  assert.equal(rt.events.length, 0, 'dispose 清空钩子表')
  ok('dispose 清定时器并置 disposed', `clearedTimers=${released.clearedTimers}`)

  await sleep(120)
  assert.deepEqual(trace.filter(x => x !== 'micro'), before.filter(x => x !== 'micro'), 'dispose 后定时器/RAF 回调一个都不许跑')
  ok('dispose 后 timeout/interval/RAF 零回调')

  const addTwo = `eventOn('late', function () { trace('late') })`
  const added = new Function('eventOn', addTwo)
  const count = rt.events.length
  added(rt.sandbox.eventOn)
  assert.equal(rt.events.length, count, 'dispose 后 eventOn 不再收新钩子')
  assert.equal(rt.sandbox.eventOn('late2', () => {}) instanceof Function, true, '（旧返回值契约不变）')
  ok('dispose 后 eventOn 拒绝注册')

  await assert.rejects(() => rt.dispatchEvent('ping'), err => {
    assert.equal(err.code, 'CARD_RUNTIME_DISPOSED', 'dispose 后非 strict 调用也必须抛（旧行为保持）')
    assert.equal(err.kind, 'disposed', '抛出物带 kind=disposed')
    return true
  })
  assert.equal(rt.lastEventOutcome.ok, false, '拒绝时也要留 outcome 证据')
  ok('dispose 后 dispatchEvent 抛 + 留 outcome')
}

// ───────────────────── 1b. 在飞钩子遇 dispose：预算取消 + 后续回调/write 被禁 ─────────────────────
console.log('1b) dispose 与在飞异步钩子的竞态')
{
  const seen = []
  const rt = createCardScriptRuntime({
    cardPath: '/probe/inflight',
    sources: [mk('t1b.js', `
      eventOn('go', async function () {
        await new Promise(function (r) { setTimeout(r, 50) });
        document.title = 'x';
        record('after-dispose');
      });
    `)],
    hostApi: { record: v => seen.push(v) },
    timeoutMs: 2000,
    logger: quietLogger,
    onDomAccess: src => seen.push(`access:${src}`),
  })
  const inflight = rt.dispatchEvent('go')
  await sleep(10)
  const released = rt.dispose()
  assert.equal(released.cancelledBudgets, 1, 'dispose 必须取消在飞钩子预算（不留定时器）')
  const outcome = await inflight
  assert.equal(outcome.ok, false, '在飞钩子被 dispose 打断 ⇒ outcome.ok=false（不当成功）')
  assert.equal(outcome.error.message.startsWith(SANDBOX_ERRORS.disposed), true, 'outcome 保留“已释放”原因')
  assert.equal(outcome.committed, false, '被打断的事件不得标记 committed')
  assert.deepEqual(seen, [], 'dispose 后：hooked 定时器回调、write 回调、DOM 标记都不许再发生')
  ok('在飞钩子被 dispose 打断：结果不提交、后续回调全禁', `cleared=${released.clearedTimers}`)
}

// ───────────────────────────── 2. 同步 timeout 与 strict 语义 ─────────────────────────────
console.log('2) dispatchEvent：vm 内执行钩子（同步 timeout）+ strict 不吞错')
{
  const rt = createCardScriptRuntime({
    cardPath: '/probe/strict',
    sources: [mk('t2.js', `
      eventOn('boom', function () { throw new Error('handler-broke') });
      eventOn('fine', function () { return 42 });
      eventOn('spin', function () { while (true) {} });
    `)],
    timeoutMs: 600,
    syncTimeoutMs: 120,
    logger: quietLogger,
  })

  // 同步死循环：必须在同步 timeout 处被打断，而不是挂死
  const t0 = Date.now()
  const spin = await rt.dispatchEvent('spin')
  const spinMs = Date.now() - t0
  assert.equal(spin.results[0].timedOut, true, '同步死循环必须被判定为超时')
  assert.equal(spinMs < 600, true, `同步 timeout 必须真的生效（实测 ${spinMs}ms）`)
  ok('同步死循环被 vm 同步 timeout 打断', `${spinMs}ms`)

  // 旧行为：非 strict ⇒ 只告警、继续，不抛
  const loose = await rt.dispatchEvent('boom')
  assert.equal(loose.ok, false, '非 strict 下 outcome.ok 应为 false（不吞结果元数据）')
  assert.equal(loose.error.message, 'handler-broke', 'outcome.error 保留钩子异常原文')
  assert.equal(loose.committed, false, '失败的事件不得标记为已提交')
  ok('非 strict：错误进 outcome 且不抛（旧行为保持）')

  // 新行为：strict ⇒ 向上抛，绝不交出坏结果
  await assert.rejects(() => rt.dispatchEvent('boom', { strict: true }), err => {
    assert.equal(err.message.includes('handler-broke'), true, 'strict 抛错必须带钩子原因')
    assert.equal(err.event, 'boom', 'strict 抛错必须带事件名')
    assert.equal(err.kind, 'error', 'strict 抛错必须带 kind=error')
    assert.equal(err.outcome.ok, false, 'strict 抛错必须带 outcome')
    return true
  })
  ok('strict：钩子错误向上抛')

  // strict + 消费方真实调用约定（选项在前）：超时也必须是**抛出**，不许返回 outcome 让消费者继续提交
  await assert.rejects(() => rt.dispatchEvent({ strict: true }, 'spin'), err => {
    assert.equal(err.kind, 'timeout', 'strict 下同步超时必须抛且 kind=timeout')
    assert.equal(err.code, SANDBOX_ERRORS.timeoutCode, 'strict 超时必须带 SANDBOX_TIMEOUT 码')
    assert.equal(err.event, 'spin', 'strict 超时抛错必须带事件名')
    return true
  })
  ok('strict（选项在前）：同步超时也向上抛')

  const fine = await rt.dispatchEvent('fine', { strict: true })
  assert.equal(fine.ok, true, 'strict 下正常钩子仍成功')
  assert.equal(fine.results[0].value, 42, '返回值透传')
  assert.equal(fine.committed, true, '成功才标记 committed')
  ok('strict：正例不受影响（返回 42、committed=true）')

  // strict + 异步超时（非同步死循环路径）：返回的 promise 挂住 ⇒ 预算掐掉后必须抛
  const slow = createCardScriptRuntime({
    cardPath: '/probe/strict-async-timeout',
    sources: [mk('t2b.js', "eventOn('wait', function () { return new Promise(function () {}) })")],
    timeoutMs: 120,
    awaitTimeoutMs: 10_000,
    tickMs: 20,
    logger: quietLogger,
  })
  const keepAsync = sleep(400) // 预算定时器 unref，需要 ref 保活才能看到结算
  await assert.rejects(() => slow.dispatchEvent({ strict: true }, 'wait'), err => {
    assert.equal(err.kind, 'timeout', 'strict 下异步超时必须抛且 kind=timeout')
    assert.equal(err.code, SANDBOX_ERRORS.timeoutCode, 'strict 异步超时必须带 SANDBOX_TIMEOUT 码')
    return true
  })
  await keepAsync
  slow.dispose()
  ok('strict：异步超时也向上抛（不返回 outcome）')
}

// ───────────────────────────── 3. DOM 探针：来源标记 + 自愈标记 ─────────────────────────────
console.log('3) DOM 探针：加载期按脚本名标记 + 运行期可回读来源 + 自愈标记')
{
  const rt = createCardScriptRuntime({
    cardPath: '/probe/dom',
    sources: [
      mk('ui-card.js', "document.getElementById('x').innerHTML = 'hi'"),
      mk('logic-card.js', "eventOn('touch', function () { record(typeof document.body.textContent) }); eventOn('type', function () { return typeof document.nodeType }); eventOn('concat', function () { return '[' + document.body.innerHTML + ']' })"),
    ],
    hostApi: { record: v => domSources.push(v) },
    timeoutMs: 1000,
    logger: quietLogger,
    onDomAccess: src => domSources.push(`access:${src}`),
  })
  assert.equal(rt.domAccessed, true, 'DOM 探针触发后 domAccessed=true（宿主据此转浏览器）')
  assert.equal(rt.needsBrowser.includes('ui-card.js'), true, '加载期来源必须标记到具体脚本名')
  assert.deepEqual(domSources.filter(x => String(x).startsWith('access:')).slice(0, 1), ['access:ui-card.js'], 'onDomAccess 必须收到脚本名')
  assert.equal(rt.sources[0].dom, true, 'sources 快照带 dom 标记')
  assert.equal(rt.sources[1].dom, false, '未碰 DOM 的脚本不得被误标')
  assert.match(rt.errors[0].error, /界面脚本/, '加载期 DOM 命中记入 errors（不静默）')
  ok('加载期 DOM 探针标记来源（ui-card.js）')

  await rt.dispatchEvent('touch')
  assert.equal(domSources.includes('function'), true, 'document.body.textContent 自愈为链式 no-op 标记（不炸）')
  assert.equal(rt.lastDomAccess.source, 'logic-card.js', '运行期来源必须可回读（不再只能传 null）')
  assert.match(rt.lastDomAccess.prop, /document\.body/, '回读要带访问路径')
  ok('运行期 DOM：自愈 no-op + 来源可回读')

  const typed = await rt.dispatchEvent('type')
  assert.equal(typed.results[0].value, 'function', 'document.nodeType 必须返回可链式/可调用的自愈标记')
  ok('DOM 自愈标记可链式返回（typeof=function）')

  const concat = await rt.dispatchEvent('concat')
  assert.equal(concat.results[0].value, '[]', '原语化必须给空串（不产生 "undefined" 脏数据）')
  ok('DOM 标记原语化为空串（+ 拼接安全）')

  const strictRt = createCardScriptRuntime({
    cardPath: '/probe/dom-strict',
    sources: [mk('s.js', "eventOn('d', function () { return typeof document.body })")],
    timeoutMs: 1000,
    logger: quietLogger,
  })
  await assert.rejects(() => strictRt.dispatchEvent('d', { strict: true }), err => {
    assert.equal(err.code, 'card-script-dom', 'strict 下 DOM 探针必须带 dom 码抛出')
    assert.equal(err.kind, 'dom', 'strict 下 DOM 探针必须带 kind=dom')
    assert.equal(err.domProbe?.source, 's.js', 'strict 抛错必须保留探针来源（供 markBrowserUi）')
    assert.equal(isDomProbeError(err), true, '消费方 isDomProbeError() 必须能识别该抛出物')
    return true
  })
  ok('strict：DOM 探针触发向上抛且可被 isDomProbeError 识别')

  // 另一种真实写法：选项在第二参（event, { strict: true }）
  const strictRt2 = createCardScriptRuntime({
    cardPath: '/probe/dom-strict2',
    sources: [mk('s2.js', "eventOn('d2', function () { return typeof document.body })")],
    timeoutMs: 1000,
    logger: quietLogger,
  })
  await assert.rejects(() => strictRt2.dispatchEvent({ strict: true }, 'd2'), err => err.kind === 'dom', '选项在前时同样抛')
  ok('strict：两种选项位置都能识别')
}

// ───────────────────────────── 4. 异步预算：旧签名兼容 + cancel 可释放 ─────────────────────────────
console.log('4) hookBudget：旧签名兼容 + cancel 清定时器')
{
  const activity = { pending: 0 }
  let timedOut = null
  let settled = false
  const race = await Promise.race([
    sleep(150).then(() => 'handler'),
    hookBudget({ isSettled: () => settled, activity, timeoutMs: 1000, awaitTimeoutMs: 5000, tickMs: 25, onTimeout: e => { timedOut = e } }),
  ])
  assert.equal(race, 'handler', '旧签名（无 cancel）仍由 handler 胜出')
  settled = true
  assert.equal(timedOut, null, 'handler 胜出时预算不得超时')
  await sleep(80)
  assert.equal(timedOut, null, 'settled 后预算必须停表（不再 tick）')
  ok('旧签名照旧可用（Promise.race 不需要改调用方）')

  let cancelled = null
  let cancelledTimedOut = null
  const budget = hookBudget({ isSettled: () => false, activity, timeoutMs: 60_000, tickMs: 10, onTimeout: e => { cancelledTimedOut = e }, onCancel: e => { cancelled = e } })
  const neverSettles = new Promise(() => {}) // 不带定时器的“永挂”hook（避免测试自己留 30s timer）
  const pending = Promise.race([neverSettles, budget])
  await sleep(30)
  assert.equal(budget.settled, false, 'cancel 之前预算仍在飞')
  budget.cancel()
  await assert.rejects(() => pending, err => err.message === SANDBOX_ERRORS.disposeTimeout, 'cancel 必须让 race 立刻结束（不留 60s 定时器）')
  assert.equal(budget.settled, true, 'cancel 之后预算立即结算')
  assert.equal(cancelled?.message, SANDBOX_ERRORS.disposeTimeout, 'onCancel 必须被回调（可观测）')
  assert.equal(cancelledTimedOut, null, 'cancel 不得被误报成超时')
  await sleep(60)
  assert.equal(cancelledTimedOut, null, 'cancel 之后不得再有 tick（定时器已清）')
  ok('cancel 立即结束 race 且清定时器（不再留 60s timer）')

  let generated = null
  const started = Date.now()
  activity.pending += 1
  // ⚠ 预算定时器是 unref 的（不占事件循环）：没有别的 ref 定时器时进程会直接退出、预算永不触发
  //   （旧台账 §27.3 的坑）。这里用 keepAlive 让本段真的活在事件循环里，模拟“派发等待中”的现场。
  const keepAlive = sleep(900)
  const flight = hookBudget({ isSettled: () => false, activity, timeoutMs: 200, awaitTimeoutMs: 300, tickMs: 20, onTimeout: e => { generated = e } })
  await assert.rejects(
    () => flight,
    err => err.message === SANDBOX_ERRORS.awaitTimeout,
    '生成在飞时必须用放宽预算并给出「等待生成超时」',
  )
  const waited = Date.now() - started // 预算结算耗时（不含 keepAlive 尾巴）
  await keepAlive
  assert.equal(waited >= 280, true, `等待生成必须等满放宽预算（实测 ${waited}ms）`)
  assert.equal(waited < 600, true, `放宽预算必须有界（实测 ${waited}ms）`)
  assert.equal(generated?.message, SANDBOX_ERRORS.awaitTimeout, '放宽档文案必须可观测')
  activity.pending -= 1
  ok('生成在飞 ⇒ 放宽预算有界（等待生成超时）', `${waited}ms`)
}

// ───────────────────────────── 5. generateRaw 回程校验 ─────────────────────────────
console.log('5) wrapGenerateRaw：await 之后校验 binding 同一对象且未关闭')
{
  const str = v => (v === undefined || v === null ? '' : String(v))

  const b1 = { sessionId: 's1', eventId: 'e1' }
  let closed1 = false
  const raws1 = []
  const gen1 = wrapGenerateRaw({
    bindingOf: () => b1,
    options: { generateRaw: async () => { raws1.push('call'); closed1 = true; return { text: 'OLD' } } },
    activity: { pending: 0 },
    str,
    isClosed: () => closed1,
  })
  await assert.rejects(() => gen1({}), err => err.message === SANDBOX_ERRORS.windowClosed, '窗口在等待期间关闭 ⇒ 结果作废')
  assert.equal(raws1.length, 1, '作废路径确实等到了真实返回（不是提前抛）')
  ok('窗口关闭：旧结果不返回', SANDBOX_ERRORS.windowClosed)

  const b2 = { sessionId: 's2', eventId: 'e2' }
  const cur2 = { binding: b2 }
  const gen2 = wrapGenerateRaw({
    bindingOf: () => cur2.binding,
    options: { generateRaw: async () => { cur2.binding = { sessionId: 's3', eventId: 'e3' }; return 'NEW' } },
    activity: { pending: 0 },
    str,
    isClosed: () => false,
  })
  await assert.rejects(() => gen2({}), err => err.message === SANDBOX_ERRORS.windowSwapped, '窗口被替换 ⇒ 旧请求不许借新窗口返回')
  ok('窗口被替换：旧请求不借新窗口', SANDBOX_ERRORS.windowSwapped)

  const b3 = { sessionId: 's3', eventId: 'e3', closed: true }
  const act3 = { pending: 0 }
  const gen3 = wrapGenerateRaw({ bindingOf: () => b3, options: { generateRaw: async () => 'SECRET' }, activity: act3, str })
  await assert.rejects(() => gen3({}), err => err.message === SANDBOX_ERRORS.windowClosed, 'binding.closed=true（无 isClosed 注入）也要拦住')
  assert.equal(act3.pending, 0, '作废路径也必须归还 pending 计数')
  ok('binding.closed 兜底判据 + pending 归零')

  const b4 = { sessionId: 's4', eventId: 'e4' }
  const act4 = { pending: 0 }
  const gen4 = wrapGenerateRaw({ bindingOf: () => b4, options: { generateRaw: async () => ({ text: 'GOOD' }) }, activity: act4, str })
  const value = await gen4({})
  assert.equal(value, 'GOOD', '正常路径返回字符串（ST 语义对齐）')
  assert.equal(act4.pending, 0, '正常路径 pending 归零')
  await assert.rejects(() => wrapGenerateRaw({ bindingOf: () => null, options: { generateRaw: async () => '' }, activity: { pending: 0 }, str })({}), err => err.message === SANDBOX_ERRORS.noWindow, '无窗口调用照旧拒绝')
  ok('正常路径 + 无窗口拒绝（旧判据/文案不变）')
}

// ───────────────────────────── 6. 实例自治：不再跨 chat 复用 ─────────────────────────────
console.log('6) createCardScriptRuntime：实例自治（旧全局缓存不再是主路径）')
{
  const src = [mk('t6.js', "eventOn('q', function () { return stamp })")]
  const hostApi = { stamp: 'A' }
  const a = createCardScriptRuntime({ cardPath: '/probe/same-card', sources: src, hostApi, timeoutMs: 1000, logger: quietLogger })
  const b = createCardScriptRuntime({ cardPath: '/probe/same-card', sources: src, hostApi: { stamp: 'B' }, timeoutMs: 1000, logger: quietLogger })
  assert.notEqual(a.context, b.context, '同一 cardPath 的两次创建必须是两个独立 vm 上下文（不串 chat）')
  assert.equal((await a.dispatchEvent('q')).results[0].value, 'A', '实例 A 用自己的 hostApi')
  assert.equal((await b.dispatchEvent('q')).results[0].value, 'B', '实例 B 用自己的 hostApi')
  ok('同 cardPath 两次创建 = 两个独立上下文')
  a.dispose(); b.dispose()

  // 兼容旧入口：仍是缓存语义，但 dispose 后自摘缓存
  const c = getOrCreateRuntime('/probe/legacy', src, { stamp: 'C' }, 1000, null, { logger: quietLogger })
  const d = getOrCreateRuntime('/probe/legacy', src, { stamp: 'C' }, 1000, null, { logger: quietLogger })
  assert.equal(c, d, 'getOrCreateRuntime 保持旧缓存语义')
  disposeRuntime('/probe/legacy')
  assert.equal(c.disposed, true, 'disposeRuntime 释放旧实例')
  const e = getOrCreateRuntime('/probe/legacy', src, { stamp: 'E' }, 1000, null, { logger: quietLogger })
  assert.notEqual(e, c, '释放后不得再把旧实例交给下一位调用者')
  assert.equal((await e.dispatchEvent('q')).results[0].value, 'E', '新实例用新的 hostApi')
  ok('旧入口兼容且 dispose 自摘缓存')
  e.dispose()
}

// ───────────── 6b. strict 契约：任何失败都抛（不许返回 outcome 让消费者继续提交） ─────────────
console.log('6b) strict：timeout/disposed/DOM/异常 四类失败一律向上抛')
{
  const rtBoom = createCardScriptRuntime({
    cardPath: '/probe/strict-contract',
    sources: [mk('c.js', "eventOn('boom', function () { throw new Error('boom-x') })")],
    timeoutMs: 300,
    logger: quietLogger,
  })
  await assert.rejects(() => rtBoom.dispatchEvent({ strict: true }, 'boom'), err => {
    assert.equal(err.kind, 'error', 'strict 钩子异常 kind=error')
    assert.equal(err.event, 'boom', 'strict 抛错带事件名（消费方回执要能定位）')
    assert.equal(err.source, 'c.js', 'strict 抛错带脚本来源')
    assert.equal(err.result.ok, false, 'strict 抛错带该钩子的 result（未提交）')
    assert.equal(err.outcome.committed, false, 'strict 抛错时 committed 必须为 false')
    return true
  })
  ok('strict：钩子异常抛出（带 kind/event/source/result）')

  rtBoom.dispose()
  await assert.rejects(() => rtBoom.dispatchEvent({ strict: true }, 'boom'), err => {
    assert.equal(err.kind, 'disposed', 'strict 遇已释放必须抛且 kind=disposed')
    assert.equal(err.code, 'CARD_RUNTIME_DISPOSED', 'strict 已释放抛出物带 CARD_RUNTIME_DISPOSED 码')
    return true
  })
  ok('strict：已释放 ⇒ 抛出（不是 return outcome）')
}

// ───────────────────────────── 7. 标准链集成：真 hookBudget + wrapGenerateRaw 在运行期内跑通 ─────────────────────────────
console.log('7) 标准链：createCardScriptRuntime + wrapGenerateRaw + 预算放宽')
{
  let binding = null
  const seen = []
  const str = v => (v === undefined || v === null ? '' : String(v))
  // 正解接线：runtime 自建计数对象并通过 activityHolder 暴露 ⇒ wrapper 必须用**同一个**
  const holder = {}
  const rt = createCardScriptRuntime({
    cardPath: '/probe/chain',
    sources: [mk('chain.js', "eventOn('turn', async function (tag) { record(await generateRaw({ tag: tag })) })")],
    hostApi: { record: v => seen.push(v) },
    timeoutMs: 60,           // 默认预算 60ms —— 生成期间必须有放宽，否则必然超时
    awaitTimeoutMs: 5000,
    tickMs: 20,
    logger: quietLogger,
    activityHolder: holder,
  })
  assert.equal(typeof holder.current?.pending, 'number', 'runtime 必须把共享计数对象暴露给消费方（否则放宽预算静默失效）')
  const gen = wrapGenerateRaw({
    bindingOf: () => binding,
    options: { generateRaw: async (config, ctx) => { await sleep(120); return { text: `GEN:${config.tag}:${ctx.sessionId}` } } },
    activity: holder.current,
    str,
  })
  rt.sandbox.generateRaw = gen
  binding = { sessionId: 'sess-9', eventId: 'evt-9' }
  const okOutcome = await rt.dispatchEvent('turn', 'unit')
  assert.equal(okOutcome.ok, true, '生成期必须被放宽预算覆盖（60ms 预算下 120ms 生成仍成功）')
  assert.deepEqual(seen, ['GEN:unit:sess-9'], '返回值经脚本回传，且带上绑定会话')
  assert.equal(holder.current.pending, 0, 'generateRaw 在飞计数必须归零')
  ok('标准链跑通：放宽预算让 120ms 生成越过 60ms 默认预算')

  // 反例（本轮的静默失效形态）：runtime 计数对象与 wrapper 的不是同一个 ⇒ 预算按默认档掐掉生成
  const holder2 = {}
  const rtBad = createCardScriptRuntime({
    cardPath: '/probe/chain-bad',
    sources: [mk('bad.js', "eventOn('turn', async function () { record(await generateRaw({})) })")],
    hostApi: { generateRaw: wrapGenerateRaw({ bindingOf: () => binding, options: { generateRaw: async () => { await sleep(120); return 'X' } }, activity: { pending: 0 }, str }), record: v => seen.push(v) },
    timeoutMs: 60,
    awaitTimeoutMs: 5000,
    tickMs: 20,
    logger: quietLogger,
    activityHolder: holder2,
  })
  const bad = await rtBad.dispatchEvent('turn')
  assert.equal(bad.ok, false, '接错计数对象时必须表现为（可见的）超时，而不是悄悄放宽')
  assert.equal(bad.results[0].timedOut, true, '掐掉的原因必须是超时（可诊断）')
  assert.equal(holder2.current.pending, 0, '接错对象也不许漏计数')
  rtBad.dispose()
  ok('接错计数对象：以可见超时暴露（不静默失效）')

  // 窗口关闭（结算结束）后，在飞请求不得借新窗口把旧结果交回去
  let closeAfter = false
  const holder3 = {}
  const rt2 = createCardScriptRuntime({
    cardPath: '/probe/chain2',
    sources: [mk('c2.js', "eventOn('t', async function () { record(await generateRaw({})) })")],
    hostApi: { record: v => seen.push(v) },
    timeoutMs: 60,
    awaitTimeoutMs: 5000,
    tickMs: 20,
    logger: quietLogger,
    activityHolder: holder3,
  })
  const gen2 = wrapGenerateRaw({
    bindingOf: () => binding,
    options: { generateRaw: async () => { await sleep(60); return 'STALE' } },
    activity: holder3.current,
    str,
    isClosed: () => closeAfter,
  })
  rt2.sandbox.generateRaw = gen2
  setTimeout(() => { closeAfter = true }, 20) // 生成在飞期间窗口关闭
  const stale = await rt2.dispatchEvent('t')
  assert.equal(stale.ok, false, '窗口关闭后的旧结果不得被当成成功')
  assert.equal(seen.includes('STALE'), false, '旧结果绝不许回传脚本')
  assert.equal(holder3.current.pending, 0, '作废路径也必须归还计数')
  ok('在飞期间窗口关闭：旧结果不提交（回程校验生效）')
}

console.log(`\nmvu-runtime-lifecycle: ${pass} 项断言全部通过（退出码 0）`)
