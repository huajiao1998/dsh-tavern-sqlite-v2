// 作者2.5(5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60) **开局准备页生成链**定向断言（2026-10-05）。
//
// 被测对象（全部是**真实产物**，不是手抄片段）：
//   · deploy/opening-runtime-transform.mjs  → 作者 lib/domain/opening-preparation.js 的开局接线产物（纯源码）
//   · lib/opening-server-init.js            → initializeOpeningRuntime 真实实现（真跑）
//   · lib/server-execution.js               → createServerExecution 真实工厂（真跑）
//   · lib/helper-generation-api.js + test/fixtures/upstream-25-helper-generation/helper-generation-tasks.js
//                                           → 真作者任务层 + 真生成 API（**模型出口是假函数，不调 LLM**）
//
// 本闸回答的问题（主线程担心的那一个）：
//   接线里的 `runtimeContext(draft)` 是**外层准备草稿**的服务端 VM 上下文（present/更新时快照），
//   而 `generationContext(chat, signal)` 的 `chat` 参数是**作者编译器当时传进来的当前草稿**。
//   二者同源但**取用时机不同**。故本闸必须证明——生成拿到的 history/card/worldBook/presetSnapshot/
//   global(character)Variables **严格等于当前草稿**，不是接线时定格的旧副本，也不回落"持久化最新"。
//
// 依赖解析沿用同目录 test/opening-server-init.test.mjs 的既有做法（registerHooks + mvu-server-core 解析根）：
// 本包 lib 里的 lodash/yaml 等由宿主运行时提供，本地仓库没有 node_modules，故显式短路解析，不新装依赖。
//
// 只跑本文件；不连远端、不读真实档、不调模型、未提交、未部署、未跑全量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

const require = createRequire(new URL('../../../tools/mvu-server-core/package.json', import.meta.url))
const dependencies = new Map(['lodash', 'yaml', 'json5', 'jsonrepair'].map(name => [name, pathToFileURL(require.resolve(name)).href]))
registerHooks({ resolve(name, context, next) { return dependencies.has(name) ? { url: dependencies.get(name), shortCircuit: true } : next(name, context) } })

const { applyOpeningRuntimeTransform, OPENING_RUNTIME_MARKER } = await import('../deploy/opening-runtime-transform.mjs')
const { createServerExecution } = await import('../lib/server-execution.js')
const { initializeOpeningRuntime } = await import('../lib/opening-server-init.js')
const { createHelperGenerationApi, HELPER_GENERATION_EVENTS } = await import('../lib/helper-generation-api.js')
const { createHelperGenerationTasks } = await import('../test/fixtures/upstream-25-helper-generation/helper-generation-tasks.js')

// —— 固定 5d2 路径（known；缺任一即响亮失败，不静默 SKIP）——
const RAW = rel => new URL(`../../../tmp/upstream-review-20261005-seams/raw/${rel}`, import.meta.url)
const AUTHOR = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/', import.meta.url)
const OPENING_RAW = RAW('tavern-plugin__lib__domain__opening-preparation.js')
const AUTHOR_OPENING = new URL('lib/domain/opening-preparation.js', AUTHOR)
const AUTHOR_PROMPTS = new URL('lib/domain/helper-generation-prompts.js', AUTHOR)

const readOrFail = (url, label) => {
  if (!existsSync(url)) throw new Error('缺固定 5d2 基线（' + label + '）：本闸不做静默 SKIP')
  return readFileSync(url, 'utf8')
}
const openingSource = () => readOrFail(OPENING_RAW, 'raw/opening-preparation.js')
const flushes = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/**
 * 真工厂：与 test/opening-server-init.test.mjs 同一形状（quiet logger + 真实 lodash）。
 *
 * 注意 createGenerationTasks = 真作者任务层：`server-execution.js:841` 只有在该 DI 是函数时才把
 * `generate/generateRaw/stopGenerationById/stopAllGeneration` 接进卡脚本宿主 API；否则 `generate` 是
 * `unsupported('generate')` 占位（抛"未接线"）。所以"卡脚本能调 generate"本身就需要它。
 */
function factory(extra = {}, capture = () => {}) {
  return options => {
    const execution = createServerExecution({ ...options, logger: quiet, lodash: require('lodash'),
      project: scripts => ({ scripts: scripts || [] }), isHostOwnedMvu: () => false,
      createGenerationTasks: () => createHelperGenerationTasks(), ...extra })
    capture(execution)
    return execution
  }
}

/** 私有准备草稿（作者 create 内那份的形状）。 */
function draftOf(swipes = ['开场白'], scripts = []) {
  return {
    id: 'fixture', cardPath: '/fixture/card.png', card: { name: '原创卡' }, userName: '旅人',
    helperScripts: scripts, globalVariables: {}, characterVariables: {}, extensionSettings: {},
    presetSnapshot: { name: 'p-draft', regexScripts: [{ id: 'r-draft' }] },
    regexScripts: { global: [], character: [] },
    chat: { id: 'fixture', sessionId: 'opening:fixture', cardPath: '/fixture/card.png', mode: 'story',
      mvu: { enabled: true }, variables: {},
      messages: [{ greeting: true, role: 'assistant', text: swipes[0], sourceText: swipes[0], swipeId: 0, swipes, variables: swipes.map(() => ({})) }] },
  }
}
const bookOf = () => ({ name: '主书', entries: [{ uid: 1, name: '[initvar] 基础', content: 'hp: 7\nflag: false' }] })
const scriptOf = (id, content) => ({ id, name: id, content })

/** 从接线产物里抽出真实 `generationContext:` 箭头函数体（花括号配平；找不到即响亮失败）。 */
function extractGenerationContext(source) {
  const key = source.indexOf('generationContext: (chat, signal) => ({')
  assert.ok(key >= 0, '接线产物必须含 generationContext 箭头函数（边界锚点）')
  const bodyStart = source.indexOf('({', key) + 1
  let depth = 0, end = -1
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > bodyStart, 'generationContext 函数体花括号必须配平（拒绝猜测边界）')
  return source.slice(key, end)
}

// ================================================================ ① 基线真伪
test('① 基线：固定 5d2 作者源自带 generate/generateRaw DI，且作者编译器真实消费 history/card/worldBook/preset/characterVariables', () => {
  const opening = openingSource()
  assert.equal(opening.split('createOpeningPreparation({ readCard, worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, now = Date.now })').length - 1, 1,
    '作者 2.5 签名必须带 generate 与 generateRaw 两个 DI')
  // 作者自己的开局生成（callRuntime）传的上下文形状 —— 我们的接线必须与之一致，而不是另造一套。
  const authorOpening = readOrFail(AUTHOR_OPENING, '作者 opening-preparation.js')
  assert.equal(authorOpening.includes('history: helperGenerationHistory(draft.chat)'), true)
  assert.equal(authorOpening.includes('presetSnapshot: copy(draft.presetSnapshot)'), true)
  assert.equal(authorOpening.includes('characterVariables: copy(draft.characterVariables || {})'), true)
  // 作者编译器 compileHelperGenerate 真实消费的字段名（缺一即我们传的上下文到不了模型）。
  const prompts = readOrFail(AUTHOR_PROMPTS, '作者 helper-generation-prompts.js')
  for (const field of ['history = []', 'worldBook', 'presetSnapshot = null', 'characterVariables = {}', 'card = {}']) {
    assert.equal(prompts.includes(field), true, '作者编译器必须消费 ' + field)
  }
})

// ================================================================ ② 语法 + 幂等
test('② 接线产物：保留 2.5 签名 + 标记 + 幂等 + 语法有效（node --check 真解析）', async () => {
  const next = applyOpeningRuntimeTransform(openingSource())
  assert.equal(next.includes(OPENING_RUNTIME_MARKER), true, '必须带本轮标记')
  // 签名：作者两个生成 DI 原样在名单内，我们只在末尾追加 dispatchMarksProvider 一个 DI。
  assert.equal(next.split('createOpeningPreparation({ readCard, worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, dispatchMarksProvider, now = Date.now })').length - 1, 1)
  assert.equal(next.split('createOpeningPreparation({ readCard, worldBooks, generateRaw, readRuntimeExtensions').length - 1, 0, '旧 2.4 单线签名不得残留')
  // 幂等（同串复跑不再改）。
  assert.equal(applyOpeningRuntimeTransform(next), next)
  // 语法有效：写临时副本交 `node --check` 真解析。
  // 为什么不是"真 import"：产物首行 import './storage-opening-runtime.js' 等**施缝时才创建**的垫片
  //   （作者裸树没有这些文件），而且 data: URL 非层级基地址、解析不了相对说明符（实测报
  //   "Invalid relative URL or base scheme is not hierarchical"）。故这里只证**语法**，
  //   真实消费者由 ④ 用真 createServerExecution + 真任务层覆盖，不在此假装跑通。
  const tmp = new URL('./.opening-transform-probe.mjs', import.meta.url)
  const { writeFileSync, rmSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  writeFileSync(tmp, next, 'utf8')
  try {
    const checked = spawnSync(process.execPath, ['--check', fileURLToPath(tmp)], { encoding: 'utf8' })
    assert.equal(checked.status, 0, '接线产物必须语法有效：' + (checked.stderr || ''))
  } finally {
    rmSync(tmp, { force: true })
  }
})

// ================================================================ ③ generationContext 语义（主线程的担心）
test('③ generationContext：history/card/worldBook/preset/全局变量严格当前草稿；chat 参数当场读，不回落持久化', () => {
  const block = extractGenerationContext(applyOpeningRuntimeTransform(openingSource()))
  // 签名必须接 (chat, signal)：chat 是被真实使用的**当前草稿**（否则就是"接线时定格"的旧副本）。
  assert.equal(block.includes('generationContext: (chat, signal) => ({'), true)
  // 六个消费者齐备，每一个都取自 draft / chat 参数当场读。
  assert.equal(block.includes('sessionId: draft.sourceSessionId'), true, 'sessionId 取私有草稿的来源会话（不是新会话）')
  assert.equal(block.includes('signal,'), true, 'signal 原样透传（取消可抵达模型）')
  assert.equal(block.includes('chat,'), true, 'chat 即调用当场传入的当前草稿')
  assert.equal(block.includes('card: draft.card'), true, 'card 取私有草稿（准备页允许的不可变资源读取）')
  assert.equal(block.includes('history: helperGenerationHistory(chat)'), true, 'history 必须由 chat 参数当场投影')
  assert.equal(block.includes('presetSnapshot: draft.presetSnapshot'), true)
  assert.equal(block.includes('characterVariables: draft.characterVariables'), true)
  assert.equal(block.includes('globalRegexScripts: draft.regexScripts.global'), true)
  assert.equal(block.includes('characterRegexScripts: draft.regexScripts.character'), true)
  // 不回落"持久化最新"：生成块内不许读存档/最近会话。
  for (const forbidden of ['readHelperContext(', 'lastTavernHelperVariables(', 'getSession(', 'chatSqliteStore', 'store.get(', 'readStoredLog']) {
    assert.equal(block.includes(forbidden), false, '开局生成块内不得出现持久化回落：' + forbidden)
  }
  // 也不得在生成块里创建会话 / 写资源原件（只读准备页）。
  for (const forbidden of ['registry.create', 'attachSession', 'createSession(', 'nativeOpeningAppended', 'writeFileSync', 'replaceWorldbook(']) {
    assert.equal(block.includes(forbidden), false, '开局生成块内不得创建会话/写资源：' + forbidden)
  }
})

// ================================================================ ④ 真跑：consumer=true，最少 1 卡脚本 generate
test('④ 真跑 initializeOpeningRuntime(真 createServerExecution + 真任务层)：卡脚本 generate 在 init 事件内被调且身份正确', async () => {
  const draft = draftOf()
  // 卡脚本在开局初始化事件里调 generate({user_input...})；真作者任务层承载，只有模型出口是假函数。
  // 必须 await：生成是异步 host 调用，不 await 会被结算屏障当成迟到写入。
  draft.helperScripts = [scriptOf('gen.js', "eventOn('mag_variable_initialized', async function(data) { return await generate({generation_id:'g-open', user_input:'开局问一句'}) })")]
  const modelCalls = []
  const captured = []
  let execution = null
  const result = await initializeOpeningRuntime({
    draft, worldbook: bookOf(),
    createServerExecution: factory({}, value => { execution = value }),
    // 作者编译器期望的上下文：由接线从**当前私有草稿**当场构造。
    generationContext: (chat, signal) => {
      captured.push({ chat, signal })
      return { sessionId: draft.sourceSessionId, signal, chat, card: draft.card, worldBook: null,
        presetSnapshot: draft.presetSnapshot, characterVariables: draft.characterVariables,
        extensions: { globalRegexScripts: draft.regexScripts.global, characterRegexScripts: draft.regexScripts.character },
        history: [{ role: 'assistant', text: '当前草稿正文' }] }
    },
    generate: (config, context) => { modelCalls.push(['generate', config, context]); return { text: 'G' } },
    generateRaw: (config, context) => { modelCalls.push(['generateRaw', config, context]); return { text: 'R' } },
  })
  assert.equal(result.initialized, true, '真实初始化必须跑过（worldbook 真实投影 + mvu.enabled）')
  assert.equal(captured.length >= 1, true, 'generationContext 必须真被调用（不是只接线不生效）')
  assert.equal(modelCalls.length >= 1, true, '卡脚本的 generate 必须真的抵达模型出口（假函数）')
  assert.equal(modelCalls[0][0], 'generate', '走 generate，不误走 generateRaw')
  assert.equal(modelCalls[0][1].user_input, '开局问一句', '脚本 payload 原样透传')
  const context = modelCalls[0][2]
  assert.equal(context.sessionId, draft.sourceSessionId, 'sessionId 是私有草稿来源会话')
  assert.equal(context.chat, captured[0].chat, 'context.chat 就是当场传入的当前草稿')
  assert.equal(context.card, draft.card, 'card 取当前私有草稿的卡（准备页允许的不可变资源读取）')
  assert.equal(context.presetSnapshot, draft.presetSnapshot)
  assert.equal(typeof context.signal?.throwIfAborted, 'function', '模型侧拿到真 AbortSignal')
  await flushes()
  execution?.disposeAll()
})

test('④b 未接任务工厂时 generate 是"未接线"占位（不伪成功）：卡脚本调用必须当场报错', async () => {
  const draft = draftOf()
  draft.helperScripts = [scriptOf('gen.js', "eventOn('mag_variable_initialized', async function() { return await generate({user_input:'x'}) })")]
  // 刻意**不**传 createGenerationTasks：server-execution 只接 generateRaw，generate 应为 unsupported 占位。
  await assert.rejects(() => initializeOpeningRuntime({
    draft, worldbook: bookOf(),
    createServerExecution: options => createServerExecution({ ...options, logger: quiet, lodash: require('lodash'),
      project: scripts => ({ scripts: scripts || [] }), isHostOwnedMvu: () => false }),
    generate: () => ({ text: '不应被调用' }),
  }), /未接线的宿主 API "generate"/, '未接任务工厂时不得静默伪成功')
})

// ================================================================ ⑤ 无早期 session / 无资源写
test('⑤ 接线：初始化只发生在私有草稿发布前；不含早期 session 创建与资源原件写；浏览器不再下发 MVU 脚本', () => {
  const next = applyOpeningRuntimeTransform(openingSource())
  const marker = next.indexOf('此时只存在准备页私有草稿：不创建原生会话、不写资源原件')
  assert.ok(marker > 0, '必须保留"私有草稿"边界注释')
  // 初始化调用必须先于 drafts.set（失败不发布半初始化结果）。
  const initCall = next.indexOf('await initializeOpeningRuntime({ draft,')
  const publish = next.indexOf('drafts.set(draft.id, draft)', initCall)
  assert.ok(initCall > 0 && publish > publish - 1 && publish > initCall, '初始化必须先于草稿发布')
  const wrapped = next.slice(initCall, publish)
  for (const forbidden of ['registry.create', 'attachSession', 'createSession(', 'nativeOpeningAppended']) {
    assert.equal(wrapped.includes(forbidden), false, '发布前初始化不得创建原生会话：' + forbidden)
  }
  for (const forbidden of ['writeFileSync', 'replaceWorldbook(', 'saveExtensionSettings(']) {
    assert.equal(wrapped.includes(forbidden), false, '发布前初始化不得写资源原件：' + forbidden)
  }
  // 浏览器侧只留开局界面脚本（服务端拥有），MVU 官方脚本不再下发浏览器。
  assert.equal(next.includes('scripts: draft.helperScripts || [], serverOwned: true'), true)
  assert.equal(next.includes("id: '__dsh_official_mvu__'"), false, 'MVU 官方脚本不得再出现在浏览器下发列表')
})

// ================================================================ ⑥ 失败语义
test('⑥ 失败：初始化抛错 ⇒ reject 且私有草稿逐字不变、disposeAll 收尾；缺依赖/伪空世界书响亮拒绝', async () => {
  const draft = draftOf()
  const before = structuredClone(draft)
  let disposed = 0
  const bad = await initializeOpeningRuntime({
    draft, worldbook: bookOf(),
    // 注入失败：真工厂 + 在真实初始化之后抛错。
    createServerExecution: options => {
      const real = createServerExecution({ ...options, logger: quiet, lodash: require('lodash'),
        project: scripts => ({ scripts: scripts || [] }), isHostOwnedMvu: () => false })
      return { ...real,
        initializeOpeningData: async data => { await real.initializeOpeningData(data); throw new Error('注入失败') },
        disposeAll: () => { disposed += 1; return real.disposeAll() } }
    },
  }).then(() => null, error => error)
  assert.ok(bad, '注入失败必须 reject（不静默）')
  assert.match(bad.message, /注入失败/)
  assert.deepEqual(draft, before, '失败时私有草稿必须逐字不变（不半写回）')
  assert.equal(disposed, 1, '收尾必须 disposeAll 一次（关写窗）')

  const two = draftOf()
  const twoBefore = structuredClone(two)
  await assert.rejects(() => initializeOpeningRuntime({ draft: two }), /缺少 createServerExecution 接线/)
  await assert.rejects(() => initializeOpeningRuntime({ draft: { chat: {} }, createServerExecution: factory() }), /缺少 chat\.messages/)
  assert.deepEqual(two, twoBefore, '拒绝路径不得改草稿')
  await assert.rejects(() => initializeOpeningRuntime({
    draft: draftOf(), createServerExecution: factory(), worldbook: { name: '', entries: [] } }), /真实投影/)
})

// ================================================================ ⑦ 真作者任务层：2.5 signature 语义 + dispose/abort
test('⑦ 真作者任务层 + 真生成 API：kind 路由/descriptor 上下文/真 AbortSignal/dispose 关闭窗口', async () => {
  const seen = [], events = []
  let opened = true
  const controller = new AbortController()
  const api = createHelperGenerationApi({
    bindingOf: () => (opened ? { sessionId: 'opening:fixture', eventId: 'opening-gen', chat: { id: 'draft-chat' }, signal: controller.signal } : null),
    assertOpen: () => { if (!opened) throw Object.assign(new Error('卡脚本写窗口已关闭'), { code: 'SERVER_EXECUTION_LATE_WRITE' }) },
    activity: { pending: 0 },
    emit: (name, ...args) => { events.push([name, ...args]) },
    options: {
      createGenerationTasks: () => createHelperGenerationTasks(),
      // 作者编译器期望：模型调用**之前**当场读当前草稿（不是延迟到模型自己调）。
      readGenerationContext: binding => ({ chat: binding.chat, history: [{ role: 'assistant', text: '当前草稿正文' }] }),
      generate: (config, descriptor) => { seen.push(['generate', config, descriptor]); return { text: 'G' } },
      generateRaw: (config, descriptor) => { seen.push(['generateRaw', config, descriptor]); return { text: 'R' } },
    },
  })
  assert.equal(await api.generate({ generation_id: 'g1', user_input: 'u' }), 'G')
  assert.equal(await api.generateRaw({ generation_id: 'r1', user_input: 'u' }), 'R')
  assert.deepEqual(seen.map(item => item[0]), ['generate', 'generateRaw'], 'kind 必须路由到各自实现，不互相串')
  assert.equal(seen[0][2].context.chat.id, 'draft-chat', 'readGenerationContext 的当前草稿进入 descriptor.context')
  assert.deepEqual(seen[0][2].context.history, [{ role: 'assistant', text: '当前草稿正文' }], 'history 来自当前草稿')
  assert.equal(typeof seen[0][2].signal.throwIfAborted, 'function', '模型侧拿到作者任务层的真 AbortSignal')
  assert.equal(seen[0][1].generation_id, 'g1', 'payload 原样透传（含 generation_id 回填）')
  await flushes()
  assert.deepEqual(events.map(item => item[0]), [
    HELPER_GENERATION_EVENTS.GENERATION_STARTED, HELPER_GENERATION_EVENTS.GENERATION_ENDED,
    HELPER_GENERATION_EVENTS.GENERATION_STARTED, HELPER_GENERATION_EVENTS.GENERATION_ENDED])
  assert.equal(await api.stopAllGeneration(), true, '空表 stopAll 也返回 true（作者语义）')
  api.dispose()
  await assert.rejects(() => api.generate({ generation_id: 'after' }), /生成调用窗口已关闭/, 'dispose 后 fail loud')
})

// ================================================================ ⑧ dispose abort 与 error reject
test('⑧ 真任务层：dispose 真 abort 在飞生成（模型永不 settle）；generationContext 抛错 ⇒ reject 且草稿不变', async () => {
  const api = createHelperGenerationApi({
    bindingOf: () => ({ sessionId: 'opening:fixture', eventId: 'opening-gen', chat: { id: 'draft-chat' } }),
    assertOpen: () => {}, activity: { pending: 0 }, emit: () => {},
    options: { createGenerationTasks: () => createHelperGenerationTasks(),
      generate: () => new Promise(() => {}),   // 永不 settle、不理会 abort
      generateRaw: () => new Promise(() => {}) },
  })
  const inflight = api.generate({ generation_id: 'g-inflight' })
  await flushes()
  api.dispose()
  const aborted = await inflight.then(() => null, error => error)
  assert.equal(aborted && aborted.name, 'AbortError', 'dispose 必须真 abort 在飞生成，不留永不 settle 的 Promise')
  await flushes()

  // generationContext 抛错：必须 reject（不静默成 undefined 上下文喂给模型）。
  // 注意：只有当脚本**真的调 generate** 时该回调才会被触达 —— 故脚本必须触发它，否则测的是"没调用"。
  const draft = draftOf()
  draft.helperScripts = [scriptOf('gen.js', "eventOn('mag_variable_initialized', async function() { return await generate({generation_id:'g-fail', user_input:'x'}) })")]
  const before = structuredClone(draft)
  const failed = await initializeOpeningRuntime({
    draft, worldbook: bookOf(), createServerExecution: factory(),
    generationContext: () => { throw new Error('上下文读取失败') },
    generate: () => ({ text: 'X' }),
  }).then(() => null, error => error)
  assert.ok(failed, 'generationContext 抛错必须 reject')
  assert.match(failed.message, /上下文读取失败/)
  assert.deepEqual(draft, before, '拒绝路径不得改私有草稿')
})
