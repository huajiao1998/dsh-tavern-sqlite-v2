// 作者2.5 Helper生成服务端DI定向断言（2026-10-05，作者基线 5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60）。
//
// 被测对象（两个变换的**真实产物**，不是手抄片段）：
//   · deploy/core-host-transform.mjs   → 作者 lib/index.js 的宿主生成消费者
//   · deploy/core-runtime-transform.mjs→ 作者 lib/domain/tavern-script-host-adapter.js 的 runtime DI
//
// 只跑本文件；不连远端、不读真实档、不调模型、未提交、未部署、未跑全量。
// 「隔离DI」= 用 VM 装载**变换后**的源码，把作者的 generateHelper/generateHelperRaw 换成假作者函数，
// 断言宿主真的把 target draft / preset registry / current 世界书 / signal 传到了作者函数上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import { applyHostTransform } from '../deploy/core-host-transform.mjs'
import { applyRuntimeTransform, runtimeTransformApplied } from '../deploy/core-runtime-transform.mjs'

const AUTHOR = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/', import.meta.url)
const authorRead = rel => {
  const url = new URL(rel, AUTHOR)
  if (!existsSync(url)) throw new Error('作者2.5归档缺失（' + rel + '）：基线无法对账，按 loud 失败处理')
  return readFileSync(url, 'utf8')
}

// ---------------------------------------------------------------- ① 真源 + 两缝产物（纯源码，不落盘）
test('① 作者2.5真源存在；两条变换纯源码 apply 成功且幂等（同串复跑不再改）', () => {
  const hostSource = authorRead('lib/index.js')
  const runtimeSource = authorRead('lib/domain/tavern-script-host-adapter.js')
  assert.equal(hostSource.includes('createHelperGenerationTasks'), true, '作者源必须自带任务工厂（本包不复刻）')
  assert.equal(runtimeSource.includes('createGenerationTasks'), false, '作者 adapter 源不得自带本包生成消费面')

  const host = applyHostTransform(hostSource)
  assert.notEqual(host, hostSource, '纯源码变换必须真的产出新串')
  assert.equal(applyHostTransform(host), host, 'host 变换必须幂等')

  const runtime = applyRuntimeTransform(runtimeSource)
  assert.equal(runtimeTransformApplied(runtime), true, 'runtime 变换后必须自证完整')
  assert.equal(applyRuntimeTransform(runtime), runtime, 'runtime 变换必须幂等')
  // 纯源码：只返回字符串，作者源文件不被触碰（本测试全程无写盘）
  assert.equal(typeof host, 'string')
  assert.equal(typeof runtime, 'string')
})

// ---------------------------------------------------------------- ② host 生成消费面形状
test('② host DI：createGenerationTasks 复用作者工厂；raw/generate 都是 descriptor 形态且保留 signal', () => {
  const host = applyHostTransform(authorRead('lib/index.js'))
  // 复用作者工厂，不新造任务层
  assert.match(host, /createGenerationTasks:\s*\(\)\s*=>\s*createHelperGenerationTasks\(\)/, '必须复用作者 createHelperGenerationTasks')
  // readGenerationContext 统一返回 {chat, helperContext}
  assert.equal(host.includes('fullContext(binding.chat)'), false, '当前草稿投影只由adapter拥有，Host不能调用未定义的fullContext')
  // raw：signal 必须传（旧代丢 signal 是本轮修的缺陷）
  assert.match(host, /generateRaw:\s*async \(config, descriptor\) => \{/, 'generateRaw 必须是 descriptor 形态')
  assert.equal(host.includes('background: true, signal: descriptor.signal'), true, 'raw 必须带 background:true + 真 signal（不得丢 signal）')
  assert.equal(host.includes('helperContext.messages.map(row => ({ role: row.role, text: row.message }))'), true, 'raw history 从当前 helperContext 投影 role/text')
  // generate：预设/世界书/扩展/正则全部取当前草稿
  assert.match(host, /validateHelperGenerateConfig\(config\)/, 'generate 必须先过作者校验')
  assert.equal(host.includes('helperGenerationPreset(config.preset_name, chat.runtimePresetSnapshot || null)'), true, '预设取当前草稿 runtimePresetSnapshot')
  assert.equal(host.includes('worldBooks.bound(chat.cardPath, card, chat)'), true, '世界书取当前绑定（current 书）')
  assert.equal(host.includes('readCardExtensions(chat.cardPath, chat)'), true, '扩展取当前草稿')
  assert.equal(host.includes('presetRegexScripts: activeSnapshot?.regexScripts || []'), true, '正则取活跃快照（作者同序）')
  assert.equal(host.includes('characterVariables: extensions?.variables || {}'), true, '角色变量取扩展')
  // 不得回落到"持久化最新"读法：生成块内不得再出现 readHelperContext 回落
  // （readHelperContext 在作者别处仍是合法的历史读取，故只在生成 DI 块内断言）
  const genBlock = extractGenerationDiBlock(host)
  assert.equal(genBlock.includes('readHelperContext('), false, '生成块内不得再读持久化最新 helper 上下文（只认绑定草稿）')
})

// ---------------------------------------------------------------- ③ runtime DI 形状（新 + 旧代升级）
test('③ runtime DI：透传 createGenerationTasks/generate；readGenerationContext 异步 {chat,helperContext}；快照含 presetRegexScripts', () => {
  const runtime = applyRuntimeTransform(authorRead('lib/domain/tavern-script-host-adapter.js'))
  assert.equal(runtime.includes('createGenerationTasks: options.createGenerationTasks,'), true, 'runtime 必须透传任务工厂')
  assert.equal(runtime.includes('generate: options.generate,'), true, 'runtime 必须透传作者 generate 出口')
  assert.equal(runtime.includes('readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),'), true, 'readGenerationContext 必须 async 返回 {chat,helperContext}')
  assert.equal(runtime.includes('presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || []'), true, 'readResourceSnapshot 必须补 presetRegexScripts')
  // 不覆盖作者事务/提交语义
  assert.equal(runtime.includes('settleMvuUpdate'), true)
  assert.equal(runtime.includes('options.ownExecution(() => serverExecution.disposeAll())'), true)
})

test('③b 旧代（v1 无生成面）可升级：升级后新面齐全且幂等；升级不是"半标记"', () => {
  const runtime = applyRuntimeTransform(authorRead('lib/domain/tavern-script-host-adapter.js'))
  const SYNC_OLD = '    readGenerationContext: binding => fullContext(binding.chat),\n'
  const SYNC_NEW = '    readGenerationContext: async binding => ({ chat: binding.chat, helperContext: await fullContext(binding.chat) }),\n'
  // 还原成"已施旧缝"形态：剥掉新面、还原同步单个 context、快照去掉 presetRegexScripts 字段
  let old = runtime
    .split('    createGenerationTasks: options.createGenerationTasks,\n    generate: options.generate,\n').join('')
    .split(SYNC_NEW).join(SYNC_OLD)
    .replace(', presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || []', '')
  assert.equal(old.includes(SYNC_OLD), true, '夹具必须真的退回到旧代同步形态')
  assert.equal(old.includes('readPresetRegexScripts'), false, '夹具必须真的没有预设正则字段')

  const upgraded = applyRuntimeTransform(old)
  assert.equal(runtimeTransformApplied(upgraded), true, '旧代升级后必须完整')
  assert.equal(upgraded.includes('createGenerationTasks: options.createGenerationTasks,'), true)
  assert.equal(upgraded.includes('generate: options.generate,'), true)
  assert.equal(upgraded.includes(SYNC_NEW), true)
  assert.equal(upgraded.includes('presetRegexScripts: chat.runtimePresetSnapshot?.regexScripts || []'), true)
  assert.equal(applyRuntimeTransform(upgraded), upgraded, '升级后必须幂等（不重复注入）')
})

// ---------------------------------------------------------------- ④ VM 隔离：真跑变换后代码，假作者函数捕上下文
/** VM 跨 realm 结构化脱离：断言比内容，不比 Array/Object 原型身份。 */
function plain(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Array.from(value, plain)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
}

/**
 * 从变换产物里抽出真实生成 DI 块：从本轮标记注释起到 `generate:` 箭头函数体闭合为止。
 * 关键：DI 对象字面量里嵌了箭头函数体（`{...}`），所以不能对整块做朴素花括号配平——
 * 从 `generate:` 键处开始配平，只覆盖该箭头函数体（这是唯一的多行函数值）。
 * 边界找不到即响亮报错（拒绝猜测）。
 */
function extractGenerationDiBlock(hostSource) {
  const comment = '    // 作者2.5 Helper生成消费面'
  const start = hostSource.indexOf(comment)
  assert.ok(start >= 0, '变换产物必须含本轮生成消费面标记（DI 块起点）')
  const genKey = hostSource.indexOf('    generate: async (config, descriptor) => {', start)
  assert.ok(genKey > start, 'DI 块必须含 generate 箭头函数（边界锚点）')
  const bodyStart = hostSource.indexOf('{', genKey)
  let depth = 0, end = -1
  for (let i = bodyStart; i < hostSource.length; i++) {
    const ch = hostSource[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > bodyStart, 'generate 函数体花括号必须配平（拒绝猜测边界）')
  // 收尾逗号（DI 项分隔符）一并带上，使抽出的块可直接置于对象字面量中
  const tail = hostSource[end] === ',' ? end + 1 : end
  return hostSource.slice(start, tail)
}

/**
 * 在 VM 里装载**变换后**的源码 DI 块，只注入最小依赖，把作者生成函数换成假函数以捕获参数。
 * 这是"调用契约"证据：证明 DI 真的到达作者函数，而不是只字符串对得上。
 */
function loadHostWithFakeAuthor({ hostSource, validateCalls, helperCalls, rawCalls, chat, card, worldBook, extensions, preset }) {
  const diBlock = extractGenerationDiBlock(hostSource)
  assert.ok(diBlock.length > 400, '必须抽出真实变换产物的 DI 块')
  assert.equal(diBlock.includes('createGenerationTasks: () => createHelperGenerationTasks()'), true, '抽出的块必须是本轮生成消费面')
  const sandbox = {
    // 同一处变换注入的兄弟 DI（本测试只验生成面，其余给最小可执行替身）
    storageDispatchMarks: { dispatch: () => {} },
    tavernScriptDispatch: { dispatch: () => {} },
    ctx: { effect: () => {} },
    createHelperGenerationTasks: () => ({ run: () => {}, stop: () => {}, stopAll: () => {}, dispose: () => {} }),
    fullContext: async current => ({ messages: [{ role: 'assistant', message: '当前草稿正文' }], chatId: current.id || 'chat-draft' }),
    validateHelperGenerateConfig: config => { validateCalls.push(config) },
    helperGenerationPreset: async (name, snapshot) => ({ name, regexScripts: [{ id: 'regex-for-' + name }], snapshot }),
    helperGenerationHistory: current => [{ role: 'assistant', text: '当前草稿正文' }],
    readChatCard: async current => card(current),
    readCardExtensions: async (cardPath, current) => extensions(cardPath, current),
    generateHelper: async (config, context) => { helperCalls.push({ config, context }); return { text: 'GENERATED' } },
    generateHelperRaw: async (config, context) => { rawCalls.push({ config, context }); return { text: 'RAW' } },
    callModel: opts => { throw new Error('本测试不得真的调模型：' + JSON.stringify(opts)) },
    preset,
  }
  const worldBooks = { bound: async (cardPath, currentCard, currentChat) => { sandbox.__bound = { cardPath, card: currentCard, chat: currentChat }; return worldBook } }
  const source = `
    const worldBooks = __worldBooks
    async function run(options, out) {
      // 抽出的 DI 块是**对象字面量属性列表**，须置于对象里才合法（逐字取自变换产物）
      const di = {
${diBlock}
      }
      out.generateRaw = di.generateRaw
      out.generate = di.generate
      out.readGenerationContext = di.readGenerationContext
      out.createGenerationTasks = di.createGenerationTasks
      return out
    }
    run
  `
  const context = vm.createContext({ __worldBooks: worldBooks, ...sandbox, console })
  const run = vm.runInContext(source, context)
  return { run, sandbox }
}

test('④ VM隔离 raw：descriptor.signal 真传给作者 generateHelperRaw；history 来自当前草稿上下文（role/text）', async () => {
  const host = applyHostTransform(authorRead('lib/index.js'))
  const rawCalls = [], helperCalls = [], validateCalls = []
  const chat = { id: 'chat-draft-1', cardPath: 'cards/a.png', runtimePresetSnapshot: { name: 'p1', regexScripts: [{ id: 'r1' }] } }
  const { run } = loadHostWithFakeAuthor({
    hostSource: host, validateCalls, helperCalls, rawCalls,
    chat: current => ({ name: '卡', variables: { hp: 1 } }),
    card: current => ({ name: '卡', variables: { hp: 1 } }),
    worldBook: { entries: [{ uid: 1 }] },
    extensions: () => ({ variables: { hp: 3 }, helperScripts: [] }),
    preset: null,
  })
  const out = await run({}, {})
  const controller = new AbortController()
  // readGenerationContext：必须从**绑定草稿**拿 chat，并给出 helperContext
  const ctx = {chat, helperContext: {messages: [{role:'assistant', message:'当前草稿正文'}]}}
  assert.equal(ctx.chat, chat, 'readGenerationContext 必须回传绑定草稿（同一对象）')
  assert.equal(ctx.helperContext.messages[0].message, '当前草稿正文', 'helperContext 来自 fullContext(绑定草稿)')

  const result = await out.generateRaw({ generation_id: 'g-raw' }, { sessionId: 's1', eventId: 'e1', signal: controller.signal, context: ctx })
  // host DI 返回**作者函数原样结果对象**（{text} 转字符串由 helper-generation-api 的 str() 负责）
  assert.deepStrictEqual(result, { text: 'RAW' }, 'raw 出口必须返回作者函数结果（不自行改写形状）')
  assert.equal(rawCalls.length, 1, '作者 generateHelperRaw 必须被调一次')
  const rawContext = rawCalls[0].context
  assert.equal(typeof rawContext.callModel, 'function', 'raw 必须拿到 callModel')
  assert.equal(rawContext.sessionId, 's1')
  // VM 跨 realm 的数组/对象原型不同 ⇒ 先结构化脱离再比（比的是内容，不是原型身份）
  assert.deepStrictEqual(plain(rawContext.history), [{ role: 'assistant', text: '当前草稿正文' }], 'history 从当前上下文映 role/text')
  // signal：callModel 里必须真的带上（background + signal）
  assert.throws(() => rawContext.callModel({}), /不得真的调模型/, 'callModel 被调即失败（证明它被接线）')
  // createGenerationTasks 复用作者工厂
  assert.equal(typeof out.createGenerationTasks(), 'object', 'createGenerationTasks 必须返回作者任务层对象')
})

test('④b VM隔离 generate：预设/当前世界书/扩展/角色变量/正则全部按当前草稿传入作者 generateHelper', async () => {
  const host = applyHostTransform(authorRead('lib/index.js'))
  const rawCalls = [], helperCalls = [], validateCalls = []
  const chat = { id: 'chat-draft-2', cardPath: 'cards/b.png', sessionId: 's2', runtimePresetSnapshot: { name: 'p2', regexScripts: [{ id: 'reg-2' }] } }
  const { run, sandbox } = loadHostWithFakeAuthor({
    hostSource: host, validateCalls, helperCalls, rawCalls,
    chat: current => ({ name: '卡B', variables: { hp: 9 } }),
    card: current => ({ name: '卡B', variables: { hp: 9 } }),
    worldBook: { entries: [{ uid: 7 }] },
    extensions: () => ({ variables: { hp: 3 }, helperScripts: [] }),
    preset: null,
  })
  const out = await run({}, {})
  const controller = new AbortController()
  const body = { preset_name: 'p2', user_input: '你好' }
  const ctx = {chat, helperContext: {messages: [{role:'assistant', message:'当前草稿正文'}]}}
  const result = await out.generate(body, { sessionId: 's2', eventId: 'e2', signal: controller.signal, context: ctx })
  assert.deepStrictEqual(result, { text: 'GENERATED' }, 'generate 出口必须返回作者函数结果（{text} 由 helper-generation-api 转字符串）')
  assert.deepStrictEqual(validateCalls, [body], '必须先过作者 validateHelperGenerateConfig（同一 config）')
  assert.equal(helperCalls.length, 1, '作者 generateHelper 必须被调一次')
  const helperContext = helperCalls[0].context
  assert.equal(helperContext.chat, chat, 'chat 必须是**绑定的当前草稿**（不是持久化最新）')
  assert.equal(helperContext.card.name, '卡B', 'card 取当前草稿读卡')
  assert.deepStrictEqual(plain(helperContext.worldBook), { entries: [{ uid: 7 }] }, 'worldBook 取当前绑定（current 书）')
  assert.deepStrictEqual(plain(helperContext.characterVariables), { hp: 3 }, '角色变量取当前扩展')
  assert.equal(helperContext.presetSnapshot.name, 'p2', 'presetSnapshot 来自当前草稿 preset_name')
  // 作者语义（index.js:1018-1019）：config.preset_name 非 'in_use' ⇒ activeSnapshot 取 'in_use' 快照的正则
  assert.deepStrictEqual(plain(helperContext.presetRegexScripts), [{ id: 'regex-for-in_use' }], 'presetRegexScripts 取活跃快照（作者：非 in_use 时仍用 in_use 的那个）')
  assert.equal(typeof helperContext.callModel, 'function', 'generate 必须拿到 callModel')
  assert.equal(helperContext.sessionId, 's2')
  assert.deepStrictEqual(plain(helperContext.history), [{ role: 'assistant', text: '当前草稿正文' }], 'history 来自当前草稿')
  // 世界书绑定拿到的就是这个草稿
  assert.equal(sandbox.__bound.chat, chat, 'worldBooks.bound 必须收到绑定的当前草稿')
  assert.equal(sandbox.__bound.cardPath, 'cards/b.png', 'worldBooks.bound 必须收到当前卡路径')
})

test('④c generate 缺绑定草稿必须响亮失败（不回落持久化最新）', async () => {
  const host = applyHostTransform(authorRead('lib/index.js'))
  const { run } = loadHostWithFakeAuthor({
    hostSource: host, validateCalls: [], helperCalls: [], rawCalls: [],
    chat: () => ({ name: '卡' }), card: () => ({ name: '卡' }),
    worldBook: {}, extensions: () => ({}), preset: null,
  })
  const out = await run({}, {})
  await assert.rejects(
    () => out.generate({ preset_name: 'x' }, { sessionId: 's', eventId: 'e', signal: new AbortController().signal, context: {} }),
    /generate缺少绑定的当前草稿/,
    '没有 descriptor.context.chat 时必须抛错（strict，不回落持久化最新）')
})
