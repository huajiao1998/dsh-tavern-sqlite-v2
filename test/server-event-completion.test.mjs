// 定向回归：服务端事件的「完成屏障」（2026-10-04）
//
// 覆盖本轮改动的必要点，**用真实 runtime + 真实 createServerExecution**（不拿 fake runtime 过绿）：
//   ① 短延迟回调（ceiling 内，如 250ms 防抖 / 1500ms 兜底）在提交前被真正 await 到
//   ② 超 ceiling 的长延迟**不**纳屏障（不盲等）；②b dispose 后长延迟不得再落写
//   ③ 未被 await 的 Helper 写（Promise.all 收不到的 thenable）在提交前被等到
//   ④ 回调抛错 / 异步 reject **向上抛**（不吞、不半成功），且调用方拿不到提交
//   ⑤ 超预算（回调永不结算）⇒ 有界抛错，**不无限等**
//   ⑥ input.signal 取消 ⇒ assertOpen 拒绝提交（结果不回填）、等待方被唤醒
//   ⑦ eventTavern 别名同真事件名；MESSAGE_RECEIVED 给投影钩子派发一次且读到**已更新的权威树**
//      （探针读 `stat_data.hp`：权威树的数值在那里，读 `.hp` 永远是 undefined）
//   ⑧ 别名与真事件名逐值相同、无假事件
//   ⑨ async 回调 reject / 同步无限 timer / 未 await 的 updater 写 / signal 门闸取消 —— 四条高牙断言
//
// 运行：node --test test/server-event-completion.test.mjs（或 node test/server-event-completion.test.mjs）
// 依赖：仅 node 内置 + 本包源码；无网络、无真实存档、不写盘、不读聊天。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServerExecution, SERVER_EXECUTION_ERRORS } from '../lib/server-execution.js'

const quietLogger = { info () {}, warn () {}, error () {}, debug () {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 真实 runtime：走 createServerExecution 的缺省 createRuntime（node:vm 沙箱 + 真 eventOn）。 */
function scriptsOf(cardPath, ...entries) {
  return {
    cardPath,
    readCardExtensions: async () => ({ helperScripts: entries.map(([id, content]) => ({ id, name: id, content })) }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    logger: quietLogger,
  }
}
const draftOf = (variables = { hp: 1 }) => ({
  cardPath: 'fixture-card',
  messages: [{ role: 'assistant', variables: [{ ...variables }] }],
})

// ───────────────── ① 短延迟回调在提交前被 await 到（真 250ms 防抖写进入提交） ─────────────────
test('① ceiling 内的短延迟回调在提交前执行完（真 runtime，非盲等）', async () => {
  const writes = []
  const execution = createServerExecution({
    readCardExtensions: async () => ({ helperScripts: [{ id: 'debounce.js', name: 'debounce.js', content: `
      eventOn('MESSAGE_RECEIVED', function () {
        // 真卡写法：防抖 250ms 后再写派生值（脚本**不 await** 这个定时器）。
        setTimeout(function () { replaceVariables({ derived: 42 }) }, 250)
      })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async (_sid, _projected, variables) => { writes.push(variables); return { updated: true } } },
    executeCommand: async (_text, data) => { data.stat_data = { ...(data.stat_data || {}), hp: 5 }; return true },
    logger: quietLogger,
  })
  const started = Date.now()
  try {
    const run = await execution.executeMvuUpdate({
      sessionId: 'c1',
      transaction: { eventId: 'mvu-work:c1', draft: draftOf() },
      draft: draftOf(), messageId: 0, swipeId: 0, commandText: 'fixture',
      originalText: '前台原文',
    })
    const elapsed = Date.now() - started
    assert.equal(run.handled, true, '结算成功返回')
    assert.ok(elapsed >= 200, `确实等了那个 250ms 回调（实测 ${elapsed}ms）`)
    assert.equal(writes.length, 1, '防抖回调里的写已落到 Host（屏障真的等到了它）')
    assert.equal(writes[0].derived, 42, '写的是回调算出的派生值')
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ② 超 ceiling 的长延迟不纳屏障（不盲等） ─────────────────
test('② 超出 ceiling 的长延迟不被等待（提交不等它，且不 keepalive）', async () => {
  // **长延迟必须能被真观察到**（旧版 longFired 恒 false、没有任何桥接 ⇒ 断言永远不可能失败 = 假绿）：
  // 用它自己的一次 Host 写当桥 —— 只要那个 5s 回调真跑了，writes 里就会多出一条 `late`。
  const writes = []
  const started = Date.now()
  const execution = createServerExecution({
    readCardExtensions: async () => ({ helperScripts: [{ id: 'long.js', name: 'long.js', content: `
      eventOn('MESSAGE_RECEIVED', function () { setTimeout(function () { replaceVariables({ late: true }) }, 5000) })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async (_sid, _projected, variables) => { writes.push(variables); return { updated: true } } },
    executeCommand: async (_text, data) => { data.stat_data = { ...(data.stat_data || {}), hp: 5 }; return true },
    logger: quietLogger,
  })
  try {
    const run = await execution.executeMvuUpdate({
      sessionId: 'c2',
      transaction: { eventId: 'mvu-work:c2', draft: draftOf() },
      draft: draftOf(), messageId: 0, swipeId: 0, commandText: 'fixture',
    })
    const elapsed = Date.now() - started
    assert.equal(run.handled, true)
    assert.ok(elapsed < 3000, `长延迟未被盲等（实测 ${elapsed}ms < 3000ms 预算）`)
    // 真探针：本次 run 已结束，那个 5s 回调**没有被屏障等到**（分支在提交前就收了）。
    assert.equal(writes.some(write => write.late === true), false, '5s 回调里的一次写尚未发生（未被纳入本次屏障）')
    // runtime 侧也自证：超 ceiling 的定时器**不进**待办表（pendingTasks 归零，屏障没有为它留任何挂点）。
    assert.equal(execution.stats().bindings, 0, '结算已收口，绑定不残留')
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ②b 超 ceiling 的长延迟在 dispose 后不得再写（真探针的完整性） ─────────────────
test('②b 超 ceiling 的长延迟不被接管，且 dispose 后不得再落 Host 写', async () => {
  // 只测**未被接管**的那一类（delay 120ms > ceiling 50ms）：它不进待办表、不参与屏障，
  // 但也**不能**在 dispose 之后还活着去写 Host。ceiling 内的短延迟是另一回事 —— 它会被屏障
  // 正常等到（写发生在提交前，见 ①），不在这里断言。
  const writes = []
  const execution = createServerExecution({
    timerCeilingMs: 50,
    readCardExtensions: async () => ({ helperScripts: [{ id: 'long3.js', name: 'long3.js', content: `
      eventOn('MESSAGE_RECEIVED', function () { setTimeout(function () { replaceVariables({ late: true }) }, 120) })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async (_sid, _projected, variables) => { writes.push(variables); return { updated: true } } },
    executeCommand: async (_text, data) => { data.stat_data = { ...(data.stat_data || {}), hp: 5 }; return true },
    logger: quietLogger,
  })
  try {
    const started = Date.now()
    const run = await execution.executeMvuUpdate({
      sessionId: 'c2b',
      transaction: { eventId: 'mvu-work:c2b', draft: draftOf() },
      draft: draftOf(), messageId: 0, swipeId: 0, commandText: 'fixture',
    })
    // 超 ceiling 的长延迟不被屏障等到 ⇒ 提交很快（远小于 120ms 的触发点）。
    assert.equal(run.handled, true)
    assert.ok(Date.now() - started < 100, `未盲等超 ceiling 的长延迟（实测 ${Date.now() - started}ms）`)
    assert.equal(writes.length, 0, '提交时那个 120ms 长回调还没跑')
    execution.disposeAll()
    // 等过长延迟的触发点：dispose 已清定时器 ⇒ 一次都不许落。
    await sleep(300)
    assert.equal(writes.length, 0, 'dispose 后长延迟回调不再落 Host 写（定时器真被清掉）')
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ③ 未被 await 的 Helper 写在提交前被等到 ─────────────────
test('③ 脚本不 await 的 Host 写被完成屏障等到（提交前已落）', async () => {
  let enter, release
  const entered = new Promise(r => { enter = r })
  const gate = new Promise(r => { release = r })
  let finished = false
  const execution = createServerExecution({
    readCardExtensions: async () => ({ helperScripts: [{ id: 'fire.js', name: 'fire.js', content: `
      eventOn('MESSAGE_RECEIVED', function () { replaceVariables({ hp: 53 }) })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async () => { enter(); await gate; finished = true; return { updated: true } } },
    executeCommand: async (_text, data) => { data.stat_data = { ...(data.stat_data || {}), hp: 5 }; return true },
    logger: quietLogger,
  })
  let run
  try {
    // 直接在后台起结算，随后放行 Host 写；断言：结算返回时 finished 已为 true（屏障等到了它）
    run = execution.executeMvuUpdate({
      sessionId: 'c3',
      transaction: { eventId: 'mvu-work:c3', draft: draftOf() },
      draft: draftOf(), messageId: 0, swipeId: 0, commandText: 'fixture',
    })
    await entered
    release()
    await run
    assert.equal(finished, true, '结算返回前未被 await 的 Host 写已经结算（屏障真的等了）')
  } finally {
    release?.()
    await run?.catch(() => {})
    execution.disposeAll()
  }
})

// ───────────────── ④ 回调抛错 / 异步 reject 向上抛（不吞） ─────────────────
test('④ 短回调里抛错 ⇒ 结算抛错、不返回半成功（不吞错误）', async () => {
  const execution = createServerExecution({
    readCardExtensions: async () => ({ helperScripts: [{ id: 'boom.js', name: 'boom.js', content: `
      eventOn('MESSAGE_RECEIVED', function () { setTimeout(function () { throw new Error('延迟回调炸了') }, 30) })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async () => ({ updated: true }) },
    executeCommand: async () => true,
    logger: quietLogger,
  })
  try {
    await assert.rejects(
      execution.executeMvuUpdate({
        sessionId: 'c4',
        transaction: { eventId: 'mvu-work:c4', draft: draftOf() },
        draft: draftOf(), messageId: 0, swipeId: 0, commandText: 'fixture',
      }),
      error => /延迟回调炸了|待办|超时|超出/.test(String(error?.message || error)),
      '回调 throw 必须向上抛（不是只 log）',
    )
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ⑤ 超预算有界抛错（不无限等） ─────────────────
test('⑤ 回调永不结算 ⇒ 有界超预算抛错（不无限等待）', async () => {
  // 用一个永不同步的 timer：脚本登记 3000ms（= ceiling 内最慢）但我们的预算被压到 300ms
  const execution = createServerExecution({
    timerDrainBudgetMs: 300,
    readCardExtensions: async () => ({ helperScripts: [{ id: 'stuck.js', name: 'stuck.js', content: `
      eventOn('MESSAGE_RECEIVED', function () { setTimeout(function () {}, 2900) })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async () => ({ updated: true }) },
    executeCommand: async () => true,
    logger: quietLogger,
  })
  const started = Date.now()
  try {
    await assert.rejects(
      execution.executeMvuUpdate({
        sessionId: 'c5',
        transaction: { eventId: 'mvu-work:c5', draft: draftOf() },
        draft: draftOf(), messageId: 0, swipeId: 0, commandText: 'fixture',
      }),
      error => /超出|超时|预算/.test(String(error?.message || error)),
      '超预算必须有界抛错',
    )
    assert.ok(Date.now() - started < 3000, `有界（实测 ${Date.now() - started}ms），不无限等`)
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ⑥ input.signal 取消 ⇒ 拒绝提交 + 唤醒等待方 ─────────────────
test('⑥ signal 已 abort ⇒ 结算被拒、草稿不回填（等待方不挂死）', async () => {
  const controller = new AbortController()
  controller.abort()
  const draft = draftOf({ hp: 7 })
  const execution = createServerExecution({
    readCardExtensions: async () => ({ helperScripts: [] }),
    project: () => ({ scripts: [] }),
    host: { updateVariables: async () => ({ updated: true }) },
    executeCommand: async () => true,
    logger: quietLogger,
  })
  try {
    await assert.rejects(
      execution.executeMvuUpdate({
        sessionId: 'c6', signal: controller.signal,
        transaction: { eventId: 'mvu-work:c6', draft },
        draft, messageId: 0, swipeId: 0, commandText: 'fixture',
      }),
      error => error?.code === SERVER_EXECUTION_ERRORS.cancelled,
      'aborted signal ⇒ SERVER_EXECUTION_CANCELLED',
    )
    assert.deepEqual(draft.messages[0].variables[0], { hp: 7 }, '取消后草稿零回填（结果未提交）')
    // whenIdle 不被取消路径挂死（写契约未改：只 join 在飞 run）
    await execution.whenIdle('c6')
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ⑦ MESSAGE_RECEIVED 派发一次，且回调读到 core 更新后的权威树 ─────────────────
test('⑦ MESSAGE_RECEIVED 派发一次：回调读到 core 更新后的权威树', async () => {
  const writes = []
  const execution = createServerExecution({
    readCardExtensions: async () => ({ helperScripts: [{ id: 'alias.js', name: 'alias.js', content: `
      eventOn(tavern_events.MESSAGE_RECEIVED, function () {
        // 别名可用 + 回调里读权威树：应是 core 已经更新过的值（stat_data.hp 1 → 99）。
        // ⚠ 两个坑都要绕开：
        //   ① 权威树的数值在 **stat_data.hp**，不是 hp —— 探针写 getVariables({type:'message'}).hp
        //      永远是 undefined，那样断言"等于结算前的 hp=1"也会假过（本轮实测：旧探针取到 undefined）。
        //   ② 写成 **script scope**：message scope 的 replaceVariables 语义是"替换整棵树"
        //      （见 replaceVariables 的 adopt 分支），用它当探针会把 core 的结果覆盖掉，
        //      于是测的就不是"读到什么"而是"整树被替换"了。
        replaceVariables({ seen: getVariables({ type: 'message' }).stat_data.hp }, { type: 'script' })
      })
    ` }] }),
    project: list => ({ scripts: Array.isArray(list) ? list : [] }),
    host: { updateVariables: async (_sid, _projected, variables) => { writes.push(variables); return { updated: true } } },
    // 真 core：fixture 命令把 hp 写成 99（模拟核心结算）
    executeCommand: async (_text, data) => { data.stat_data = { ...(data.stat_data || {}), hp: 99 }; return true },
    logger: quietLogger,
  })
  try {
    const draft = draftOf({ hp: 1 })
    const run = await execution.executeMvuUpdate({
      sessionId: 'c7',
      transaction: { eventId: 'mvu-work:c7', draft },
      draft, messageId: 0, swipeId: 0, commandText: 'fixture',
      originalText: '原文',
    })
    assert.equal(run.handled, true)
    assert.equal(run.variables.stat_data.hp, 99, 'core 写入生效并提交')
    assert.equal(writes.length, 1, 'MESSAGE_RECEIVED 钩子恰好派发一次（只看到一次写）')
    assert.equal(writes[0].seen, 99, '回调读到的是**已更新**的权威树（不是结算前的旧树 hp=1）')
  } finally {
    execution.disposeAll()
  }
})

// ───────────────── ⑧ 别名与真事件名逐值相同（真 runtime 沙箱内自证） ─────────────────
test('⑧ 沙箱内 tavern_events/eventTypes 与 eventTavern 逐值相同，且无假事件', async () => {
  const { createCardScriptRuntime } = await import('../lib/mvu/mvu-card-runtime.js')
  const rt = createCardScriptRuntime({
    cardPath: '/probe/alias',
    sources: [{ name: 'probe.js', code: 'eventOn("noop", function () {})' }],
    hostApi: {},
    timeoutMs: 1000,
    logger: quietLogger,
  })
  try {
    await rt.ready
    const same = rt.sandbox.tavern_events === rt.sandbox.eventTavern && rt.sandbox.eventTypes === rt.sandbox.eventTavern
    assert.equal(same, true, '别名指向同一张表')
    const names = Object.keys(rt.sandbox.eventTavern)
    assert.deepEqual(names.sort(), ['MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED'], '仍是 6 个真事件名')
    assert.equal(names.includes('CHAT_COMPLETION_PROMPT_READY'), false, '不凭空补未接线的假事件')
    assert.equal(names.some(n => /iframe/i.test(n)), false, '不补 iframe 假事件')
  } finally {
    rt.dispose()
  }
})
