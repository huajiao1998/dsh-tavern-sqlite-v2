// 真实卡 script → createServerExecution → 真 hostApi 的**端到端消费者**测试（2026-10-05 收窄版）。
//
// 与既有 server-execution.test.mjs 的分工（刻意不同，不重复其 fake-runtime 断言）：
//   · 消费者 = **真 createCardScriptRuntime**（node:vm 沙箱 + 真 eventOn 事件桥），不是 fixture runtime；
//   · 驱动 = 真 `dispatchLifecycleEvent`（作者 MESSAGE_SENT 生产调用点：index.js:3989
//     `tavernScriptHostAdapter.dispatchEvent({ name: 'MESSAGE_SENT', args: [messageId] })`）；
//   · hostApi = createServerExecution 内部真 makeHostApi；本文件**不自造 hostApi**。
//
// ── 真 / 假 的边界（逐项写明，不含糊）────────────────────────────────────────────
//   **真**：createServerExecution（lib 真实工厂）；createCardScriptRuntime（真 VM 沙箱）；
//         真 eventOn 事件桥与 6 个真事件名（mvu-card-runtime.js:454-466）；
//         作者 projectTavernHelperScripts / 作者 regex engine+installer（逐字抽真实源码）；
//         真实 lodash（tools/mvu-server-core 本地既有，不安装不断网）；真 abort 语义。
//   **假（明确标注，不冒充真）**：① `host.updateVariables` 是**写入捕获替身**（只做真落值 + 记账，
//         不是真 SQLite 适配器）；② 生成组的 `options.generate` / `options.generateRaw` 是**假模型出口**
//         （自 resolve，**不调 LLM、不联网**）；③ 生成任务的挂起由**测试内微任务闸门** `Promise.withResolvers()`
//         手动放行，不是 sleep 轮询；挂起段的 `await flushes()` 只让微任务/已排队短 timer 跑完。
//   生成任务层**不是手写替身**：`test/fixtures/upstream-25-helper-generation/helper-generation-tasks.js`
//   与作者 2.5 `lib/domain/helper-generation-tasks.js` **逐字节相同**（① 里做 sha256 对账）。
//
// 只跑本文件：node --test test/helper-25-server-consumer.test.mjs。无网络、无真实档、不写盘、不调模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServerExecution, classifyCardScript } from '../lib/server-execution.js'
import { HELPER_GENERATION_EVENTS } from '../lib/helper-generation-api.js'
import { createHelperGenerationTasks } from './fixtures/upstream-25-helper-generation/helper-generation-tasks.js'

const require = createRequire(import.meta.url)
// 真实 lodash：与 lib/server-dependencies.js serverLodash() 同一实现（本地既有冻结依赖）。
const lodash = require('../../../tools/mvu-server-core/node_modules/lodash/lodash.js')
assert.equal(typeof lodash.mergeWith, 'function', '真实 lodash.mergeWith 不可解析')
assert.equal(typeof lodash.unset, 'function', '真实 lodash.unset 不可解析')

// 作者 2.5 归档（缺失即响亮失败，不用手抄赝品顶替）。
const AUTHOR = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/', import.meta.url)
const authorRead = rel => {
  const url = new URL(rel, AUTHOR)
  if (!existsSync(url)) throw new Error('作者2.5归档缺失（' + rel + '）：基线无法对账，按 loud 失败处理')
  return readFileSync(url, 'utf8')
}

/** 抽真实作者函数源码（花括号配平；找不到即抛）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error('作者源中找不到函数：' + name)
  let depth = 0
  let seen = false
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') { depth += 1; seen = true } else if (source[i] === '}') { depth -= 1; if (seen && depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error('函数源码未闭合：' + name)
}

const scriptsSource = authorRead('lib/domain/tavern-helper-scripts.js')
const authorProject = new Function(scriptsSource.replace(/^export /gm, '') + '\nreturn {projectTavernHelperScripts, isHostOwnedMvu}')()
const engineSource = authorRead('lib/domain/tavern-regex-engine.js')
const authorRegexEngine = new Function(extractFunction(engineSource, 'createTavernRegexEngine') + '\nreturn createTavernRegexEngine')()
const installerSource = authorRead('lib/domain/tavern-helper-regex-api.js')
const authorRegexInstaller = new Function(extractFunction(installerSource, 'installTavernHelperRegexApi') + '\nreturn installTavernHelperRegexApi')()

const quietLogger = { info () {}, warn () {}, error () {}, debug () {} }
/** 微任务冲刷：不放 sleep、不轮询，也不等真实长延时。 */
const flushes = async () => { for (let i = 0; i < 3; i += 1) await Promise.resolve() }
/** 只让已排队的**短** timer 跑完（生成组闸门放行后等 await 链推进用），不是 sleep 循环。 */
const settleMicrotasks = async () => { await new Promise(resolve => setImmediate(resolve)) }
const sha256 = url => createHash('sha256').update(readFileSync(url)).digest('hex')

/** 真卡 script：真 eventOn + TavernHelper.tavern_events.MESSAGE_SENT（作者卡脚本常见写法）。 */
const CARD_SCRIPT = [
  'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, function (messageId) {',
  '  var all = TavernHelper.getAllVariables()',
  '  TavernHelper.replaceVariables({ sent_summary: JSON.stringify({ sent: messageId, scope: all.scope_value, sentinel: all.sentinel }) }, { type: "chat" })',
  '})',
  ''
].join('\n')

/** raw 卡脚本源码：静态可判的 DOM 访问（用于分类断言）。 */
const RAW_DOM_SCRIPT = [
  'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, function () {',
  '  TavernHelper.replaceVariables({ dom_view: document.querySelector("#mvu").innerHTML }, { type: "chat" })',
  '})',
  ''
].join('\n')

const scriptEntry = content => ({ id: 'card_script', name: 'card_script', type: 'script', enabled: true, content })

let counter = 0
/**
 * 消费者夹具：真 createCardScriptRuntime（缺省 createRuntime）＋ 真作者 project ＋ 真 dispatchLifecycleEvent。
 * fake host 只做 write capture（updateVariables 真落值 + 记账），不是 hostApi 替身。
 */
function consumer({ extensionScripts, extra = {} } = {}) {
  counter += 1
  const sessionId = 'consumer-' + counter
  const writes = []
  const chat = {
    id: 'chat-' + counter,
    sessionId,
    cardPath: 'cards/consumer-' + counter + '.png',
    mvu: { enabled: true },
    cardName: '测试卡',
    macroState: { userName: '玩家' },
    variables: { chat_value: 'c' },
    tavernHelperScriptVariables: { card_script: { script_value: 's' } },
    messages: [{
      role: 'assistant', message_id: 0, swipeId: 0, swipes: ['第一楼'], sourceText: '第一楼', text: '第一楼',
      variables: [{ stat_data: { hp: 1 }, schema: { type: 'object' } }]
    }]
  }
  const entries = extensionScripts || [scriptEntry(CARD_SCRIPT)]
  const execution = createServerExecution({
    // 真作者投影（本包 project 的接线来源；不手写简化版）
    project: (helperScripts, savedVariables) => authorProject.projectTavernHelperScripts(helperScripts, savedVariables),
    isHostOwnedMvu: script => authorProject.isHostOwnedMvu(script),
    readCardExtensions: async () => ({
      helperScripts: entries,
      globalRegexScripts: [], characterRegexScripts: [], variables: { scope_value: 'k' }
    }),
    hasScripts: async () => entries.length > 0,
    readResourceSnapshot: async () => ({
      globalVariables: { sentinel: 1 },
      characterVariables: { scope_value: 'k' }
    }),
    host: {
      updateVariables: async (receivedSessionId, projected, variables) => {
        writes.push({ sessionId: receivedSessionId, option: projected, variables })
        if (projected?.type === 'chat') chat.variables = structuredClone(variables)
        if (projected?.type === 'script') chat.tavernHelperScriptVariables[projected.script_id] = structuredClone(variables)
        return { updated: true }
      }
    },
    lodash,
    logger: quietLogger,
    timerCeilingMs: 0,
    hookLoadBudgetMs: 300,
    ...extra
  })
  return { execution, chat, writes, sessionId, entries }
}

const sentInput = (fixture, extra = {}) => ({ sessionId: fixture.sessionId, chat: fixture.chat, event: 'MESSAGE_SENT', args: [0], ...extra })

// ───────────────── ① 真 runtime + 真 eventOn(TavernHelper.tavern_events.*) + vars order/delete receipt ─────────────────
test('① 真 createServerExecution + 真 CardRuntime eventOn：TavernHelper.tavern_events 派发、getAllVariables 四作用域顺序、deleteVariable 真回执', async () => {
  const SCRIPT = [
    'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, async function (messageId) {',
    '  var merged = TavernHelper.getAllVariables()',
    '  await TavernHelper.insertOrAssignVariables({ list: [7], nested: { deep: 9 } }, { type: "chat" })',
    '  var receipt = await TavernHelper.deleteVariable("nested.deep", { type: "chat" })',
    '  var absent = await TavernHelper.deleteVariable("no.such.path", { type: "chat" })',
    '  TavernHelper.replaceVariables({ var_probe: JSON.stringify({',
    '    sent: messageId,',
    '    mergedKeys: Object.keys(merged),',
    '    mergedScope: merged.scope_value,',
    '    mergedSentinel: merged.sentinel,',
    '    hasMessageVar: Object.prototype.hasOwnProperty.call(merged, "from_message"),',
    '    listAfterMerge: receipt.variables.list,',
    '    receiptKeys: Object.keys(receipt).sort(),',
    '    deleted: receipt.delete_occurred,',
    '    treeHasDeep: Object.prototype.hasOwnProperty.call(receipt.variables.nested, "deep"),',
    '    absentFlag: absent.delete_occurred,',
    '    missingSibling: Object.prototype.hasOwnProperty.call(receipt.variables, "chat_value")',
    '  }) }, { type: "chat" })',
    '})',
    ''
  ].join('\n')
  const fixture = consumer({ extensionScripts: [scriptEntry(SCRIPT)] })
  fixture.chat.variables = { chat_value: 'c', nested: { deep: 1 }, list: [1, 2, 3] }
  fixture.chat.messages[0].variables[0].from_message = 'm0'
  try {
    const result = await fixture.execution.dispatchLifecycleEvent(sentInput(fixture))
    assert.equal(result.handled, true, '有钩子即 handled=true（钩子经真 eventOn 注册、被真派发命中）')
    assert.equal(result.browserScripts, 0, '纯计算卡：浏览器侧脚本数为 0')
    const probe = JSON.parse(fixture.chat.variables.var_probe)
    assert.equal(probe.sent, 0, 'args 逐字到达回调（不是硬编码楼层号）')
    // **真实现语义**（实测，不按猜想写）：getAllVariables 是 Object.assign({}, global, character, script, chat)，
    // 后写覆盖先写 ⇒ 同名键以 chat 为准，且**键的顺序就是 global→character→script→chat 的拼接顺序**。
    assert.deepEqual(probe.mergedKeys, ['sentinel', 'scope_value', 'script_value', 'chat_value', 'nested', 'list'],
      'getAllVariables 真顺序：global(sentinel) → character(scope_value) → script(script_value) → chat(chat_value…)')
    assert.equal(probe.mergedScope, 'k')
    assert.equal(probe.mergedSentinel, 1)
    assert.equal(probe.hasMessageVar, false, 'getAllVariables 不遍历聊天消息（消息变量不掺入）')
    assert.deepEqual(probe.listAfterMerge, [7], '真 lodash mergeWith 语义：数组整体替换（不被逐元素合并）')
    assert.equal(probe.treeHasDeep, false, 'deleteVariable 真删掉了 nested.deep')
    assert.equal(probe.missingSibling, true, '未删除的兄弟键保留')
    assert.deepEqual(probe.receiptKeys, ['delete_occurred', 'variables'], '回执形状 {variables, delete_occurred}')
    assert.equal(probe.deleted, true)
    assert.equal(probe.absentFlag, true, 'lodash 规定：路径不存在时 unset 仍返回 true（不把标志重定义为"真删掉了"）')
    // 真身查证走**回执里的树**：脚本最后那次 replaceVariables 把整个 chat 树换成了 var_probe 一份，
    // 所以 host 上的 nested 已随整树替换消失 —— 断言回执（删除当刻的树）才是这条链路的真证据。
    assert.equal(fixture.chat.variables.var_probe !== undefined, true, '最后一次 replaceVariables 真落 host')
    assert.equal(fixture.writes.filter(write => write.option.type === 'chat').length >= 4, true,
      'insertOrAssign + 两次 deleteVariable + 最终 replace 都真写 host（写入捕获口）')
    assert.equal(fixture.execution.stats().bindings, 0, '生命周期事件即用即毁，绑定不残留')
  } finally { fixture.execution.disposeAll() }
})

// ───────────────── ② message scope：数字/负数/隐藏位/swipe 非 active/raw 泄漏/content 别名 ─────────────────
const FLOOR_SCRIPT = [
  'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, function () {',
  '  var rows = TavernHelper.getChatMessages("0-{{lastMessageId}}")',
  '  var hidden = TavernHelper.getChatMessages("0-{{lastMessageId}}", { hide_state: "hidden" })',
  '  var numeric = TavernHelper.getVariables({ type: "message", message_id: 1 })',
  '  var negative = TavernHelper.getVariables({ type: "message", message_id: -1 })',
  '  var nonActive = TavernHelper.getVariables({ type: "message", message_id: 0, swipe_id: 0 })',
  '  var bySwipe = TavernHelper.getVariables({ type: "message", message_id: 1, swipe_id: 1 })',
  '  TavernHelper.replaceVariables({ floor_probe: JSON.stringify({',
  '    rowKeys: Object.keys(rows[1]).sort(),',
  '    rowsLength: rows.length,',
  '    swipeIds: rows.map(function (row) { return row.swipe_id }),',
  '    swipesKept: rows[0].swipes_data.length,',
  '    nonActiveTree: rows[0].swipes_data[0],',
  '    contentAlias: rows[0].content,',
  '    messageAlias: rows[0].message,',
  '    hiddenIds: hidden.map(function (row) { return row.message_id }),',
  '    numericTree: numeric,',
  '    negativeTree: negative,',
  '    nonActiveRead: nonActive,',
  '    activeSwipeTree: bySwipe,',
  '    swipeExtra: rows[0].swipes_info.length',
  '  }) }, { type: "chat" })',
  '})',
  ''
].join('\n')

test('② 数字/负数楼层归一、tavernHidden→hide_state、swipes_data 保非 active swipe、raw 字段不泄漏、content 别名与 content 一致', async () => {
  const fixture = consumer({ extensionScripts: [scriptEntry(FLOOR_SCRIPT)] })
  fixture.chat.messages = [
    {
      role: 'tavern-helper', tavernRole: 'assistant', tavernHidden: false, swipeId: 1,
      swipes: ['开场一', '开场二'], sourceText: '开场一', text: '开场一', name: '助手楼',
      variables: [{ stat_data: { tree: 'm0s0' }, schema: { type: 'object' } }, { stat_data: { tree: 'm0s1' }, schema: { type: 'object' } }],
      // raw storage 内部字段：绝不许出现在给卡脚本的公开行里
      tavernPluginData: { internal: 'secret' }, projectionText: 'P', displayText: 'D', turn: 3, _storageRevision: 9
    },
    {
      role: 'tavern-helper', tavernRole: 'system', tavernHidden: true, swipeId: 0,
      swipes: ['隐藏楼'], sourceText: '隐藏楼', text: '隐藏楼', name: '助手楼',
      variables: [{ stat_data: { tree: 'm1s0' }, schema: { type: 'object' } }, { stat_data: { tree: 'm1s1' }, schema: { type: 'object' } }],
      tavernPluginData: {}
    }
  ]
  try {
    await fixture.execution.dispatchLifecycleEvent(sentInput(fixture, { args: [1] }))
    const probe = JSON.parse(fixture.chat.variables.floor_probe)
    assert.deepEqual(probe.swipeIds, [1, 0], 'raw 行经作者投影 selectedSwipe clamp 后给出')
    assert.equal(probe.rowsLength, 2)
    assert.equal(probe.swipesKept, 2, 'swipes_data 保全部 swipe（非 active 不清成 {}）')
    assert.deepEqual(probe.nonActiveTree, { stat_data: { tree: 'm0s0' }, schema: { type: 'object' } },
      'swipe_id:0 非 active 槽位仍保留该 swipe 的真树（不是 {}）')
    assert.deepEqual(probe.hiddenIds, [1], 'raw tavernHidden:true → 投影 is_hidden → hide_state:"hidden" 命中')
    assert.deepEqual(probe.numericTree, { stat_data: { tree: 'm1s0' }, schema: { type: 'object' } },
      '数字 message_id 按位置读 raw 行 → 该行 swipeId 索引的活跃那棵树')
    assert.deepEqual(probe.negativeTree, probe.numericTree, '负数楼层从尾部数（-1 === 末楼）')
    assert.deepEqual(probe.nonActiveRead, { stat_data: { tree: 'm0s0' }, schema: { type: 'object' } },
      '显式 swipe_id 读该 swipe 的树，不是行内选中的那一棵')
    assert.deepEqual(probe.activeSwipeTree, { stat_data: { tree: 'm1s1' }, schema: { type: 'object' } },
      'swipe_id 显式给出时读该 swipe 的树（不是行内选中 swipe）')
    assert.equal(probe.contentAlias, '开场二', 'content 别名 = 选中 swipe（swipeId:1）的正文明，与 row.message 同源')
    assert.equal(probe.contentAlias, probe.messageAlias, 'content 与 message 是同一正文的两个别名（不各读一棵树）')
    assert.equal(probe.swipeExtra, 2, 'swipes_info 与 swipes 同长（逐 swipe 保留）')
    // raw 泄漏检查：这些是 SQLite/native raw floor 的内部字段，一条都不许出现在公开行里。
    for (const leaked of ['tavernRole', 'tavernHidden', 'tavernPluginData', 'sourceText', 'projectionText', 'displayText', 'turn', '_storageRevision']) {
      assert.equal(probe.rowKeys.includes(leaked), false, 'raw 字段不得泄漏给卡脚本：' + leaked)
    }
  } finally { fixture.execution.disposeAll() }
})

// ───────────────── ③ generate / generateRaw：独立假模型出口 + descriptor + 真任务层 + 真取消 ─────────────────
// 任务层 = 作者 2.5 helper-generation-tasks.js 的逐字节 fixture（不是手写替身）；
// 模型出口 = 假函数（不调 LLM）；挂起 = 测试内微任务闸门手动放行（不是 sleep）。
const GENERATE_SCRIPT = [
  'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, async function () {',
  '  var plain = await TavernHelper.generate({ user_input: "普通", generation_id: "gen-plain" })',
  '  var streamed = await TavernHelper.generateRaw({ user_input: "原始", generation_id: "gen-raw", should_stream: true })',
  '  var stopped = await TavernHelper.stopGenerationById("gen-missing")',
  '  var stoppedAll = await TavernHelper.stopAllGeneration()',
  '  TavernHelper.replaceVariables({ gen_probe: JSON.stringify({',
  '    plain: plain, streamed: streamed, stopped: stopped, stoppedAll: stoppedAll',
  '  }) }, { type: "chat" })',
  '})',
  ''
].join('\n')

test('③ generate 与 generateRaw 各走自己的假模型出口；descriptor 带真 AbortSignal；真作者任务层驱动', async () => {
  const fixture0 = readFileSync(new URL('./fixtures/upstream-25-helper-generation/helper-generation-tasks.js', import.meta.url), 'utf8')
  assert.equal(fixture0.includes('export function createHelperGenerationTasks'), true)
  assert.equal(sha256(new URL('./fixtures/upstream-25-helper-generation/helper-generation-tasks.js', import.meta.url)),
    sha256(new URL('lib/domain/helper-generation-tasks.js', AUTHOR)),
    '生成任务层 fixture 必须与作者 helper-generation-tasks.js 逐字节相同（不是手写 run 替身）')

  const modelCalls = { generate: [], generateRaw: [] }
  const tasks = createHelperGenerationTasks()
  const tracked = {
    run: (...args) => tasks.run(...args),
    stop: (...args) => tasks.stop(...args),
    stopAll: (...args) => tasks.stopAll(...args),
    dispose: () => tasks.dispose()
  }
  const fixture = consumer({
    extensionScripts: [scriptEntry(GENERATE_SCRIPT)],
    extra: {
      executeCommand: async () => false, // 本组只验生成面，不跑变量核心
      createGenerationTasks: () => tracked,
      generate: async (config, descriptor) => { modelCalls.generate.push({ config, descriptor }); return { text: 'GENERATED' } },
      generateRaw: async (config, descriptor) => { modelCalls.generateRaw.push({ config, descriptor }); return { text: 'RAW-TEXT' } }
    }
  })
  try {
    await fixture.execution.dispatchLifecycleEvent(sentInput(fixture))
    assert.equal(modelCalls.generate.length, 1, 'generate 只进 generate 出口')
    assert.equal(modelCalls.generateRaw.length, 1, 'generateRaw 只进 generateRaw 出口')
    assert.equal(modelCalls.generate[0].config.user_input, '普通')
    assert.equal(modelCalls.generate[0].config.generation_id, 'gen-plain')
    assert.equal(modelCalls.generateRaw[0].config.should_stream, true)
    for (const call of [modelCalls.generate[0], modelCalls.generateRaw[0]]) {
      assert.equal(call.descriptor.sessionId, fixture.sessionId)
      assert.equal(call.descriptor.eventId, 'lifecycle:MESSAGE_SENT:0', 'descriptor.eventId = 本绑定的生命周期事件身份')
      assert.equal(typeof call.descriptor.signal?.throwIfAborted, 'function', '模型侧拿到真 AbortSignal（不是 undefined）')
      assert.equal(call.descriptor.signal.aborted, false)
    }
    const probe = JSON.parse(fixture.chat.variables.gen_probe)
    assert.equal(probe.plain, 'GENERATED', 'generate 返回假模型文本')
    assert.equal(probe.streamed, 'RAW-TEXT', 'generateRaw 返回假模型文本')
    assert.equal(probe.stopped, false, '未命中的 stopGenerationById ⇒ false（不抛）')
    assert.equal(probe.stoppedAll, true, 'stopAllGeneration 恒 true（含空表）')
    assert.deepEqual(Object.values(HELPER_GENERATION_EVENTS).sort(),
      ['js_generation_ended', 'js_generation_started', 'js_stream_token_received_fully', 'js_stream_token_received_incrementally'].sort(),
      '生成事件名逐字来自 lib/helper-generation-api.js 的冻结常量')
  } finally { fixture.execution.disposeAll() }
})

test('③b 真取消：stopGenerationById 让挂起的假模型走作者任务层 AbortError（微任务闸门手动放行，无 sleep 轮询）', async () => {
  const script = [
    'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, async function () {',
    '  var outcome = "none"',
    '  try { await TavernHelper.generate({ generation_id: "g-cancel" }) } catch (error) { outcome = String(error && error.name) }',
    '  TavernHelper.replaceVariables({ cancel_probe: outcome }, { type: "chat" })',
    '})',
    ''
  ].join('\n')
  const gate = Promise.withResolvers()
  const signals = []
  const stopped = []
  const tasks = createHelperGenerationTasks()
  const fixture = consumer({
    extensionScripts: [scriptEntry(script)],
    extra: {
      executeCommand: async () => false,
      createGenerationTasks: () => ({
        run: (...args) => tasks.run(...args),
        stop: (sessionId, id, options) => { stopped.push([sessionId, id, options]); return tasks.stop(sessionId, id, options) },
        stopAll: (...args) => tasks.stopAll(...args),
        dispose: () => tasks.dispose()
      }),
      // 假模型：永不 settle（也不理会 abort）——取消必须由作者任务层给出，而不是靠模型自觉。
      generate: (_config, descriptor) => { signals.push(descriptor.signal); return gate.promise }
    }
  })
  try {
    const pending = fixture.execution.dispatchLifecycleEvent(sentInput(fixture))
    // 脚本从 eventOn 到进入模型出口要跨若干宏任务（ready/加载队列）⇒ 不能只冲刷微任务就断言。
    await settleMicrotasks()
    assert.equal(signals.length, 1, '假模型已进入（挂起中），任务层已登记')
    assert.equal(signals[0].aborted, false)

    // 真取消入口：卡脚本/宿主显式停这个 generation_id（不是"等着它自己失败"）。
    // 用**真作者任务层** stop：与产品里 stopGenerationById 落到的是同一条链路。
    assert.equal(tasks.stop(fixture.sessionId, 'g-cancel', {}), true, '真任务层命中该 id ⇒ true')
    const error = await pending.then(() => null, err => err)
    assert.ok(error, '挂起模型被取消后本次生命周期派发必须失败（不伪成功）')
    assert.equal(error.code, 'SERVER_EXECUTION_HOOK_FAILED')
    assert.match(error.message, /AbortError|生成已停止/, '失败原因必须来自作者任务层的真取消，不是别处误报')
    assert.equal(signals[0].aborted, true, 'abort 已抵达模型侧真 signal')
    assert.equal(fixture.chat.variables.cancel_probe, 'AbortError', '脚本观测到的正是 AbortError（真取消语义）')
  } finally {
    // 闸门放行：挂起的假模型即使迟到 resolve，也不得把迟到文本当结果（本次派发已定案）。
    gate.resolve({ text: 'LATE-MUST-NOT-SURFACE' })
    await settleMicrotasks()
    fixture.execution.disposeAll()
  }
})

// ───────────────── ④ 只读族：macro / 真 regex installer+engine / buttons / version ─────────────────
const READONLY_SCRIPT = [
  'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, function () {',
  '  var macro = TavernHelper.substitudeMacros("{{user}}|{{char}}|{{lastMessageId}}")',
  '  var regexed = TavernHelper.formatAsTavernRegexedString("这里的 foo 出现了", "ai_output", "display", {})',
  '  var buttons = TavernHelper.getAllEnabledScriptButtons()',
  '  var version = TavernHelper.getTavernHelperVersion()',
  '  var flag = TavernHelper.isCharacterTavernRegexesEnabled()',
  '  TavernHelper.replaceVariables({ readonly_probe: JSON.stringify({',
  '    macro: macro, regexed: regexed, buttonKeys: Object.keys(buttons),',
  '    buttons: buttons, version: version, flag: flag',
  '  }) }, { type: "chat" })',
  '})',
  ''
].join('\n')

test('④ 只读族真接线：macro 纯计算、作者 regex installer/engine 真跑、按钮真 buttonEvent、version 真值', async () => {
  const fixture = consumer({
    extensionScripts: [{
      id: 'card_script', name: 'card_script', type: 'script', enabled: true, content: READONLY_SCRIPT,
      buttons: [{ name: '重来', visible: true }, { name: '隐藏', visible: false }]
    }],
    extra: {
      // 只读层需要作者真 installer/engine（缺失即响亮失败，本包不伪空正则）
      installRegexApi: authorRegexInstaller,
      createRegexEngine: () => authorRegexEngine()
    }
  })
  try {
    await fixture.execution.dispatchLifecycleEvent(sentInput(fixture))
    const probe = JSON.parse(fixture.chat.variables.readonly_probe)
    assert.equal(probe.macro, '玩家|测试卡|0', 'macro 读 state（playerName/characterName/末楼号）而非猜值')
    assert.equal(probe.regexed, '这里的 foo 出现了', '无匹配正则时原文返回（作者 engine 真跑）')
    assert.equal(probe.flag, true, '有卡对象 ⇒ isCharacterTavernRegexesEnabled true（作者 boundCharacter）')
    assert.equal(probe.version, '4.8.19', 'version 取真值来源（makeHostApi options.getVersion）')
    assert.equal(probe.buttonKeys.length, 1, '空按钮数组不建键；脚本有可见按钮 ⇒ 建键')
    const buttons = probe.buttons[probe.buttonKeys[0]]
    assert.deepEqual(buttons.map(button => button.button_name), ['重来'], '只取 visible===true 的按钮')
    assert.match(buttons[0].button_id, /^card_script_\d+$/, 'button_id = 真 buttonEvent(scriptId, hash(name))')
  } finally { fixture.execution.disposeAll() }
})

// ───────────────── ⑤ 分类：DISPLAY_APIs 留浏览器；纯计算不迁 ─────────────────
test('⑤ DISPLAY_APIs（getMessageId/retrieveDisplayedMessage）判 browser-ui；纯计算与 ESM 判服务端', async () => {
  const displayOnly = consumer({
    extensionScripts: [{ id: 'display', name: 'display', type: 'script', enabled: true,
      content: 'eventOn("MESSAGE_SENT", function () { return getMessageId() })' }]
  })
  const compute = consumer({
    extensionScripts: [
      { id: 'calc', name: 'calc', type: 'script', enabled: true, content: 'eventOn("MESSAGE_SENT", function () {})' },
      { id: 'mvu', name: 'mvu', type: 'script', enabled: true, content: 'const core = 1' },
      { id: 'ui', name: 'ui', type: 'script', enabled: true, content: RAW_DOM_SCRIPT }
    ]
  })
  try {
    // 显示类 API 只能在浏览器侧读（DOM/iframe 特权）⇒ 整脚本判 browser-ui，不由服务端执行。
    const displayResult = await displayOnly.execution.dispatchLifecycleEvent(sentInput(displayOnly))
    assert.equal(displayResult.hooks.scripts, 0, 'DISPLAY_APIs 脚本不进服务端脚本集')
    assert.equal(displayResult.browserScripts, 1, '如实报"需浏览器"（调用方据此下发浏览器）')
    assert.equal(displayResult.handled, false, '服务端无可执行钩子 ⇒ handled=false，调用方可直接回执')
    assert.equal(displayOnly.writes.length, 0, '未执行 ⇒ 无 host 写')

    // 纯计算不迁浏览器（ESM 需要 Node --experimental-vm-modules，是**加载期**约束、不是分类问题：
    // 本机默认旗标下 ESM 会响亮失败于 SERVER_EXECUTION_LOAD_FAILED，故这里只断言**分类**与纯计算真跑）。
    assert.equal(classifyCardScript('import x from "y"\neventOn("MESSAGE_SENT", function () {})'), 'esm',
      'ESM 判为 esm（走服务端 ESM 通道，不是迁浏览器）')
    const computeResult = await compute.execution.dispatchLifecycleEvent(sentInput(compute))
    assert.equal(computeResult.hooks.scripts, 1, '服务端只跑 calc（裸事件名）；宿主 MVU 核心与 DOM 脚本都不进')
    assert.equal(computeResult.handled, true, '纯计算脚本真跑过钩子')
    assert.equal(computeResult.browserScripts, 1, 'DOM 脚本如实计入浏览器侧数目')
    assert.equal(computeResult.diagnostics.some(item => /界面脚本（browser-ui）不在服务端执行/.test(item.message)), true,
      '被排除的 DOM 脚本透出明确诊断（不静默）')
  } finally {
    displayOnly.execution.disposeAll()
    compute.execution.disposeAll()
  }
})

// ───────────────── ⑥ TavernHelper 事件别名与 window 访问器 ─────────────────
test('⑥ TavernHelper.tavern_events/eventTavern/eventTypes 指同一张真事件名表；window 访问器反映同一 sandbox', async () => {
  // 真卡脚本写法：三个别名各注册一次 + 一次裸名；再经 window 访问器读同一张表。
  const ALIAS_SCRIPT = [
    'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, function () { seen.push("alias") })',
    'eventOn(TavernHelper.eventTavern.MESSAGE_SENT, function () { seen.push("tavern") })',
    'eventOn(TavernHelper.eventTypes.MESSAGE_SENT, function () { seen.push("types") })',
    'eventOn("MESSAGE_SENT", function () { seen.push("bare") })',
    'eventOn(TavernHelper.tavern_events.MESSAGE_SENT, function () {',
    '  TavernHelper.replaceVariables({ alias_probe: JSON.stringify({',
    '    seen: seen,',
    '    sameTable: TavernHelper.tavern_events === TavernHelper.eventTavern',
    '      && TavernHelper.eventTavern === TavernHelper.eventTypes,',
    '    names: Object.keys(TavernHelper.tavern_events).sort(),',
    '    windowSame: window.tavern_events === TavernHelper.tavern_events,',
    '    windowOptional: window.eventTavern?.MESSAGE_SENT === "MESSAGE_SENT"',
    '      && window.eventTypes?.MESSAGE_UPDATED === "MESSAGE_UPDATED",',
    '    onWindow: typeof window.eventOn === "function"',
    '  }) }, { type: "chat" })',
    '})',
    'var seen = []',
    ''
  ].join('\n')
  const fixture = consumer({ extensionScripts: [scriptEntry(ALIAS_SCRIPT)] })
  try {
    await fixture.execution.dispatchLifecycleEvent(sentInput(fixture))
    const probe = JSON.parse(fixture.chat.variables.alias_probe)
    assert.equal(probe.sameTable, true, '三个别名指同一张真事件名表（作者脚本三种写法都可用）')
    assert.deepEqual(probe.names,
      ['MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED'],
      '只有 6 个真事件名，不凭空补未接线事件（如 CHAT_COMPLETION_PROMPT_READY）')
    assert.equal(probe.windowSame, true, 'window 访问器与 TavernHelper 读的是同一 sandbox 成员（同一张表）')
    assert.equal(probe.windowOptional, true, '可选链读 window.eventTavern/eventTypes 命中同一 6 真名')
    assert.equal(probe.onWindow, true, 'window.eventOn 是同一真事件桥（不是另一套）')
    // 四个真 eventOn 注册都在同一次真派发中命中（别名不是空壳）。
    for (const marker of ['alias', 'tavern', 'types', 'bare']) {
      assert.equal(probe.seen.includes(marker), true, '真派发命中注册来源：' + marker)
    }
  } finally { fixture.execution.disposeAll() }
})