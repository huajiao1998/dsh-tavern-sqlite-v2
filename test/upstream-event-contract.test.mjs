// 上游事件契约定向验证（本文件独占；不改其余源码/manifest/deploy/runtime）。
//
// 覆盖三件已稳定的上游兼容事实（runtime/server-execution 的未知变更不在本文件内）：
//   ① 事件常量：纯 core 与 server-execution 取值一致，且逐值等于 pinned 上游 variable_def.ts；
//   ② 真实 core 受控 _.set / _.add ⇒ 单变量事件恰好触发一次，监听用**服务端事件值**注册，
//      core 出值正确；监听名错值（旧 'mag_single_variable_updated'）必须**零命中**；
//   ③ core-runtime-transform 新旧两代升级都带 `signal: input.signal`，两次字节幂等，
//      浏览器派发痕迹清零；只从纯作者 fixture 只读构造（不写 source-fixture / 真 app）。
//
// 不运行 minbundle，不跑 server-execution.test 的自定义全块，不读存档/卡，不联网。
// lodash/yaml/json5/jsonrepair 借本地既有冻结核心依赖（tools/mvu-server-core）：只读解析、不安装。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = new URL('../../../', import.meta.url)

// ---- 真实 core 的第三方依赖解析（lib/mvu 下无 node_modules；只读借既有依赖，不安装）----
const CORE_PACKAGE = new URL('../../../tools/mvu-server-core/package.json', import.meta.url)
if (!existsSync(fileURLToPath(CORE_PACKAGE))) {
  throw new Error('缺少本地冻结核心依赖 tools/mvu-server-core/package.json：拒绝在无真实 lodash 时弱化断言')
}
const coreRequire = createRequire(CORE_PACKAGE)
const RESOLVED = new Map()
for (const name of ['lodash', 'yaml', 'json5', 'jsonrepair']) {
  try { RESOLVED.set(name, pathToFileURL(coreRequire.resolve(name)).href) } catch { /* 缺失时由下面依赖闸点名 */ }
}
// 只短路这几个裸包名，其余一律交给默认解析（不伪造模块、不改 core 源码）。
registerHooks({
  resolve(specifier, context, next) {
    if (RESOLVED.has(specifier)) return { url: RESOLVED.get(specifier), shortCircuit: true }
    return next(specifier, context)
  },
})

const events = await import(new URL('../lib/mvu/mvu-events.js', import.meta.url))
const core = await import(new URL('../lib/mvu/mvu-update-core.js', import.meta.url))
const { SERVER_EXECUTION_EVENTS } = await import(new URL('../lib/server-execution.js', import.meta.url))
const transform = await import(new URL('../deploy/core-runtime-transform.mjs', import.meta.url))

core.setMathjs(null) // 不加载 mathjs：受控命令不含数学表达式，避免可选动态依赖干扰

const UPSTREAM = new URL('../../../tmp/upstream-audit-20261003/head/tavern-plugin/lib/vendor/magvarupdate/upstream/src/variable_def.ts', import.meta.url)

// ---------- ① 事件常量：core 与 server 一致，且逐值等于上游 ----------

test('依赖闸：真实 lodash 可解析 ⇒ 单变量事件路径不是降级替身', () => {
  assert.ok(RESOLVED.has('lodash'), '本地 lodash 不可解析：拒绝在无真实 lodash 的情况下断言 core 事件路径')
  const lodash = coreRequire('lodash')
  for (const fn of ['set', 'add', 'get', 'has']) {
    assert.strictEqual(typeof lodash[fn], 'function', 'lodash 缺 ' + fn + '：受控命令无法真实执行')
  }
})

test('事件常量：core 与 server-execution 同名同值（两处常量表不得互不一致）', () => {
  const coreEvents = events.VARIABLE_EVENTS
  for (const [key, value] of Object.entries(SERVER_EXECUTION_EVENTS)) {
    assert.ok(key in coreEvents, 'core 缺服务端已登记的事件键 ' + key)
    assert.strictEqual(coreEvents[key], value, '事件键 ' + key + ' 在 core 与 server-execution 取值不一致')
  }
  for (const key of Object.keys(coreEvents)) {
    assert.ok(key in SERVER_EXECUTION_EVENTS, 'core 多出服务端未登记的事件键 ' + key)
  }
})

test('事件常量逐值等于 pinned 上游 variable_def.ts（含 deprecated 单变量事件）', () => {
  if (!existsSync(fileURLToPath(UPSTREAM))) {
    assert.fail('缺少 pinned 上游 variable_def.ts：不能把未核对的上游值当通过')
  }
  const source = readFileSync(fileURLToPath(UPSTREAM), 'utf8')
  const block = source.slice(source.indexOf('export const variable_events'), source.indexOf('} as const;', source.indexOf('export const variable_events')))
  assert.ok(block.length > 0, '上游 variable_events 块未定位到：布局未知，拒绝猜测')
  for (const [key, value] of Object.entries(events.VARIABLE_EVENTS)) {
    const match = block.match(new RegExp('\\b' + key + ":\\s*'([^']+)'"))
    assert.ok(match, '上游 variable_events 无键 ' + key)
    assert.strictEqual(value, match[1], key + ' 与上游取值不符（上游 ' + match[1] + '，core ' + value + '）')
  }
  // 拼错的自造名在上游全文零命中——它是缺陷名，不是别名。
  assert.ok(!source.includes('mag_single_variable_updated'), '上游出现 mag_single_variable_updated：别名假设需重核')
})

// ---------- ② 真实 core 受控命令 ⇒ 单变量事件恰好一次 ----------

function baseline() {
  return {
    stat_data: { hp: 10 },
    schema: { type: 'object', properties: { hp: { type: 'number' } }, extensible: true },
    initialized_lorebooks: {},
  }
}

/** 用**服务端事件值**注册监听（消费面口径），跑一条真实命令，返回命中与出值。 */
async function runCommand(text, listenName = SERVER_EXECUTION_EVENTS.SINGLE_VARIABLE_UPDATED) {
  const variables = baseline()
  const hits = []
  const handler = (statData, path, oldValue, newValue) => hits.push({ path, oldValue, newValue, statData })
  events.on(listenName, handler)
  const before = events.listenerCount(listenName)
  // core 的 info/warn 是正常日志噪音；断言只关心事件与出值，这里静音避免污染 TAP 输出。
  const real = { log: console.log, info: console.info, warn: console.warn }
  const swallow = () => {}
  console.log = swallow; console.info = swallow; console.warn = swallow
  let modified
  try {
    modified = await core.updateVariables(text, variables, events.emit)
  } finally {
    console.log = real.log; console.info = real.info; console.warn = real.warn
    events.off(listenName, handler)
  }
  return { variables, hits, modified, registeredBefore: before, listenerAfter: events.listenerCount(listenName) }
}

test('真实 core：_.set 触发单变量事件恰好一次，监听用服务端事件值即可收到', async () => {
  const { variables, hits, modified } = await runCommand("_.set('hp', 20);")
  assert.strictEqual(modified, true, 'core 应报告变量已变化')
  assert.strictEqual(variables.stat_data.hp, 20, 'core 出值应为 20')
  assert.strictEqual(hits.length, 1, '单变量事件应恰好触发一次（实际 ' + hits.length + '）')
  assert.strictEqual(hits[0].path, 'hp')
  assert.strictEqual(hits[0].oldValue, 10)
  assert.strictEqual(hits[0].newValue, 20)
  assert.strictEqual(hits[0].statData, variables.stat_data, '第 1 参应是当前 stat_data 本体')
})

test('真实 core：_.add 触发单变量事件恰好一次，出值正确', async () => {
  const { variables, hits, modified } = await runCommand("_.add('hp', 5);")
  assert.strictEqual(modified, true)
  assert.strictEqual(variables.stat_data.hp, 15, 'core 出值应为 15')
  assert.strictEqual(hits.length, 1, '单变量事件应恰好触发一次（实际 ' + hits.length + '）')
  assert.deepEqual([hits[0].path, hits[0].oldValue, hits[0].newValue], ['hp', 10, 15])
})

test('真实 core：两条命令各自触发一次（不是合并成一次）', async () => {
  const { variables, hits } = await runCommand("_.set('hp', 20);\n_.add('hp', 5);")
  assert.strictEqual(variables.stat_data.hp, 25)
  assert.strictEqual(hits.length, 2, '两条命令应各触发一次（实际 ' + hits.length + '）')
  assert.deepEqual(hits.map(h => [h.oldValue, h.newValue]), [[10, 20], [20, 25]])
})

test('真实 core：监听名错值（旧 mag_single_variable_updated）零命中 ⇒ 该名确为断链缺陷名', async () => {
  const { hits, listenerAfter } = await runCommand("_.set('hp', 20);", 'mag_single_variable_updated')
  assert.strictEqual(hits.length, 0, 'core 若仍投旧名，则此断言失败（说明值未修正）')
  assert.strictEqual(listenerAfter, 0, '错名监听应已被摘除，不留残留')
})

test('真实 core：派发名 = 服务端/上游值，且监听器在跑完后不残留', async () => {
  const { hits, registeredBefore, listenerAfter } = await runCommand("_.set('hp', 20);")
  assert.strictEqual(registeredBefore, 1, '注册后监听数应为 1')
  assert.strictEqual(hits.length, 1)
  assert.strictEqual(listenerAfter, 0, 'off 之后不得残留监听（避免跨用例串监听）')
  assert.strictEqual(events.VARIABLE_EVENTS.SINGLE_VARIABLE_UPDATED, 'mag_variable_updated')
})

// ---------- ③ core-runtime-transform：新旧升级带取消 signal + 幂等 + 浏览器痕迹清零 ----------

const AUTHOR_FIXTURE = new URL('../../../tmp/v2-fork-sync-20261003/source-fixture/tavern-plugin/lib/domain/tavern-script-host-adapter.js', import.meta.url)
const BROWSER_TRACES = [
  'options.scriptDispatch.status?.(',
  "scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED'",
  'initializationRejected',
  'beforeDispatch',
  'const lazy = options.scriptDispatch.supportsContextProjection',
]

function authorSource() {
  const file = fileURLToPath(AUTHOR_FIXTURE)
  if (!existsSync(file)) assert.fail('缺少纯作者 fixture：不能把未执行的转换当通过')
  return readFileSync(file, 'utf8')
}

test('变换：从纯作者 fixture 施缝 ⇒ 两次字节幂等 + 浏览器派发核心痕迹清零', () => {
  const source = authorSource()
  const once = transform.applyRuntimeTransform(source)
  const twice = transform.applyRuntimeTransform(once)
  assert.strictEqual(twice, once, '二次施缝必须字节不变（幂等）')
  assert.strictEqual(once.split(transform.RUNTIME_MARKER).length - 1, 1, '版本标记应唯一')
  assert.strictEqual(transform.runtimeTransformApplied(once), true)
  // 浏览器派发核心清零：MESSAGE_RECEIVED 不再下发浏览器执行器
  for (const trace of BROWSER_TRACES) {
    assert.ok(!once.includes(trace), '浏览器执行器痕迹未清零：' + trace)
  }
  assert.ok(once.includes('serverOwned: true'), 'MESSAGE_RECEIVED 应结构化拒绝浏览器重跑')
  assert.ok(once.includes('serverExecution.executeMvuUpdate({'), '结算应走服务端执行')
})

test('变换：新施缝结果传取消 signal（新旧两代升级都要有）', () => {
  const fresh = transform.applyRuntimeTransform(authorSource())
  assert.ok(fresh.includes('signal: input.signal,'), '新施缝结果缺取消 signal')
})

test('变换：旧代产物（缺 signal）升级 ⇒ 补上 signal，且升级后幂等', () => {
  const fresh = transform.applyRuntimeTransform(authorSource())
  // 旧代来源：从已施缝产物移除 signal 行，模拟上次部署的 v1 产物（其 marker 仍在、判为已施缝）。
  const legacy = fresh.replace('        signal: input.signal,\n', '')
  assert.notStrictEqual(legacy, fresh, '构造旧代失败：signal 行未命中')
  assert.ok(!legacy.includes('signal: input.signal,'), '旧代不应含 signal')
  assert.strictEqual(transform.runtimeTransformApplied(legacy), true, '旧代应仍被判为已施缝（走升级分支）')
  const upgraded = transform.applyRuntimeTransform(legacy)
  assert.ok(upgraded.includes('signal: input.signal,'), '旧代升级未补上取消 signal')
  assert.strictEqual(transform.applyRuntimeTransform(upgraded), upgraded, '升级后必须幂等')
  // 升级只补缺口，不重复插入
  assert.strictEqual(upgraded.split('signal: input.signal,').length - 1, 1, 'signal 行应恰好一处')
  for (const trace of BROWSER_TRACES) {
    assert.ok(!upgraded.includes(trace), '升级后浏览器执行器痕迹未清零：' + trace)
  }
})

test('变换：旧代同时缺 signal + 资源快照 ⇒ 一并补齐（升级分支不漏项）', () => {
  const fresh = transform.applyRuntimeTransform(authorSource())
  // 旧代构造必须贴真实 v1 输出形态：除了缺 signal 与资源快照，readGenerationContext 也得是
  // 旧式同步单值（REQUIRED_OLD_GEN 的判据之一；2.5.0 现代产物里它是 async {chat,helperContext}）。
  // 资源快照与 presetRegexScripts 在本代是同一行内联（变换按整行插入），删快照即连字段一起删。
  const ASYNC_CTX = '    readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),'
  const OLD_CTX = '    readGenerationContext: binding => fullContext(binding.chat),'
  assert.equal(fresh.split(ASYNC_CTX).length - 1, 1, 'fresh 应恰好含一处新式 readGenerationContext（还原旧代的锚点）')
  let legacy = fresh.replace('        signal: input.signal,\n', '')
  legacy = legacy.replace(/\s*readResourceSnapshot: async \(sessionId, chat\) => \(\{[\s\S]*?\}\),\n/, '\n')
  assert.ok(!legacy.includes('signal: input.signal,'), '旧代应缺 signal')
  assert.ok(!legacy.includes('readResourceSnapshot: async (sessionId, chat) =>'), '旧代应缺资源快照')
  assert.ok(!legacy.includes('presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || []'), '旧代应缺资源快照内联的 presetRegexScripts')
  legacy = legacy.replace(ASYNC_CTX, OLD_CTX)
  assert.ok(legacy.includes(OLD_CTX), '旧代应带旧式同步 readGenerationContext（否则不构成可升级旧代）')
  const upgraded = transform.applyRuntimeTransform(legacy)
  assert.ok(upgraded.includes('signal: input.signal,'), '升级未补 signal')
  assert.ok(upgraded.includes('readResourceSnapshot: async (sessionId, chat) =>'), '升级未补资源快照')
  assert.strictEqual(transform.applyRuntimeTransform(upgraded), upgraded, '补齐后必须幂等')
})

test('变换只读：作者 fixture 未被本文件改写（真 app/source-fixture 保持原样）', () => {
  const source = authorSource()
  assert.ok(source.includes("import { createMvuSettlementEffect } from './mvu-settlement-effect.js'"), 'fixture 首部锚点应保持作者原样')
  assert.ok(!source.includes(transform.RUNTIME_MARKER), 'fixture 不应被施缝写回（变换是纯函数，只返回字符串）')
  assert.ok(!source.includes('storage-server-execution.js'), 'fixture 不应出现垫片 import')
})

console.log('upstream-event-contract: 事件常量/真实core单变量事件/变换signal+幂等+浏览器痕迹清零 定向通过')
