// 只读Helper API最小闸：抽取真实作者函数（macro/regex installer/readPipeline/buttons）对照本包包装层。
// 不读真实档、不启作者/GUI、不调模型；worldbook 用本档伪宿主；scope 关闭必须响亮。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHelperReadonlyApi, beginReadonlyProbe } from '../lib/helper-readonly-api.js'

const FIXTURE = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/', import.meta.url)
const read = rel => readFileSync(new URL(rel, FIXTURE), 'utf8')
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a)
  assert.ok(a >= 0 && b > a, '真实作者锚点必须存在：' + start)
  return source.slice(a, b)
}

// —— 真实作者函数抽取（逐字，不是复制存档）——
const macroSource = read('src/client/runtime/helper-macro-api.js')
const regexDomain = read('lib/domain/tavern-helper-regex-api.js')
const regexEngineSrc = read('lib/domain/tavern-regex-engine.js')
const client = read('lib/client.js')
const bootstrap = read('src/client/runtime/helper-bootstrap.js')

// 作者 macro：整文件去掉 export? 无 export；直接 new Function 装载 installTavernHelperMacroApi。
const installMacros = new Function(macroSource + '\nreturn installTavernHelperMacroApi')()

// 作者 regex engine + installer：抽取真实函数体，按作者的模块序装载。
const engineBody = between(regexEngineSrc, 'function createTavernRegexEngine() {', '\nexport {')
let createTavernRegexEngine
new Function(engineBody + '\nreturn createTavernRegexEngine')().call(null)
createTavernRegexEngine = new Function(engineBody + '\nreturn createTavernRegexEngine')()
const installerBody = between(regexDomain, 'function installTavernHelperRegexApi(options) {', '\nexport {')
const installTavernHelperRegexApi = new Function(installerBody + '\nreturn installTavernHelperRegexApi')()

// 作者 readPipeline（lib/client.js 内联、无 export）：抽真实函数体 + 其依赖 slashError/decodeSlashText。
// 缩进实测为 12 空格（非 tab），锚点须逐字（AGENTS §二.11）。
const slashSource = between(client, '            function slashError(message) {', '            async function executeReadPipeline(line, sessionId) {')
const actualPipeline = new Function(slashSource + '\nreturn {readPipeline, decodeSlashText, slashError}')()
assert.equal(typeof actualPipeline.readPipeline, 'function', '作者 readPipeline 必须可抽取')

// 作者 buttons 真值（helper-bootstrap.js:432-441 投影规则）+ 真实 buttonEvent 哈希（:291-303）。
assert.match(bootstrap, /script\.buttonsEnabled === false \|\| script\.failed/, '作者按钮先按 buttonsEnabled/failed 过滤脚本')
assert.match(bootstrap, /script\.buttons\.filter\(button => button && button\.visible === true\)/, '作者按钮只取 visible===true')
assert.match(bootstrap, /button_id: buttonEvent\(button\.name, script\.id\), button_name: button\.name/, 'button_id 必须走真实 buttonEvent')

// 作者 projectTavernHelperScripts 的真实 shape（lib/domain/tavern-helper-scripts.js:18-46）——不猜，直接抽真身。
const helperScriptsSrc = read('lib/domain/tavern-helper-scripts.js')
const projectSource = (() => {
  const a = helperScriptsSrc.indexOf('export function projectTavernHelperScripts')
  assert.ok(a >= 0, '作者 projectTavernHelperScripts 必须存在')
  return helperScriptsSrc.slice(a).replace(/^export /, '')
})()
const actualProject = new Function(helperScriptsSrc.replace(/^export /gm, '') + '\nreturn {projectTavernHelperScripts, isHostOwnedMvu}')()
assert.equal(typeof actualProject.projectTavernHelperScripts, 'function', '作者 project 必须可抽取')

// 作者 buttonEvent 真身（helper-bootstrap.js:291-303），逐字抽出做真对照。
const hashBody = between(bootstrap, 'function stringHash(value, seed) {', 'function reportSubscriptions() {')
const actualButtonEvent = new Function(hashBody + '\nreturn buttonEvent')()

// —— 被测包装层夹具 ——
const AUTHOR_VERSION = '4.8.19'
const tree = { hp: 12, nested: { deep: '值' }, $secret: 'x', arr: [1, 2] }
function harness({ worldbookEntries = [{ uid: 3, name: '注释', content: '正文', strategy: { keys: ['校园', '学园'], keys_secondary: { keys: ['雨'] } } }, { uid: 9, name: '别', content: '校园生活', strategy: { keys: ['校园生活'] } }] } = {}) {
  const calls = []
  const live = {
    open: true, sessionId: 'readonly-fixture', messageId: 2,
    state: { playerName: '玩家', characterName: '角色', character: { name: '角色' }, messages: [0, 1, 2], regexScripts: { global: [], character: [] } },
  }
  const readOpen = () => { if (!live.open) throw new Error('窗口已关闭'); return live }
  const variablesByType = { chat: tree, global: { hp: 1 }, character: {}, message: { hp: 2 } }
  const api = createHelperReadonlyApi({
    readOpen,
    getVariables: option => { const type = option?.type || 'chat'; calls.push({ type, option }); return structuredClone(variablesByType[type] ?? {}) },
    getCurrentMessageId: () => live.messageId,
    getLastMessageId: () => live.state.messages.length - 1,
    options: {
      // 新契约：state(open) 收到 readOpen() 的 live 回执；本夹具也从 open 取 sessionId（证明参数可用）。
      state: open => ({ ...live.state, sessionProjection: open.sessionId }),
      getVersion: () => AUTHOR_VERSION,
      createRegexEngine: createTavernRegexEngine,
      installRegexApi: installTavernHelperRegexApi,
    },
    host: { getWorldbook: async (sessionId, name, consistent) => { calls.push({ sessionId, name, consistent }); return { worldbook: { entries: structuredClone(worldbookEntries) } } } },
  })
  return { api, live, calls }
}

// —— 1. macro：与作者 installTavernHelperMacroApi 逐值对照 ——
function authorMacroWindow(state, getVariables, currentId, lastId) {
  const window = { getVariables, getCurrentMessageId: () => currentId, getLastMessageId: () => lastId }
  new Function('window', 'context', macroSource + '\ninstallTavernHelperMacroApi({window: window, context: context})')(
    window, () => state)
  return window
}
{
  const h = harness()
  const author = authorMacroWindow(h.live.state,
    option => structuredClone(variablesByType(h, option)), h.live.messageId, h.live.state.messages.length - 1)
  function variablesByType(h2, option) { return { chat: tree, global: { hp: 1 }, character: {}, message: { hp: 2 } }[option?.type || 'chat'] }
  const cases = ['{{user}} 与 {{char}}', '{{lastMessageId}}/{{messageId}}', '{{getvar::hp}}', '{{getglobalvar::hp}}',
    '{{get_chat_variable::hp}}', '{{get_message_variable::hp}}', '{{get_chat_variable::nested.deep}}',
    '{{get_chat_variable::arr}}', '{{get_chat_variable::$secret}}', '{{get_chat_variable::__proto__}}',
    '{{get_chat_variable::constructor}}', '{{未知写macro}}', '{{roll:2d6}}', '纯文本无宏']
  for (const input of cases) {
    assert.equal(h.api.substitudeMacros(input), author.substitudeMacros(input), 'macro 必须与作者一致：' + input)
  }
  assert.equal(h.api.substituteMacros('{{user}}'), h.api.substitudeMacros('{{user}}'), '别名同实现')
  // 未知写 macro 保 literal（不执行、不吞掉）
  assert.equal(h.api.substitudeMacros('a{{roll:2d6}}b'), 'a{{roll:2d6}}b')
  // 毒 key 必须拦成空串，不能读到原型/自有遮蔽属性。
  // 判别性构造：把 __proto__/constructor/prototype 定义成**自有可枚举属性**，
  // 无拦截时 readPath 会取到 LEAK_*（可区分），有拦截时必为 ''。这是变异测试的真闸。
  const poisonTable = Object.create(null)
  poisonTable.hp = 12
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    Object.defineProperty(poisonTable, key, { value: 'LEAK_' + key, enumerable: true, configurable: true, writable: true })
  }
  const poisonApi = createHelperReadonlyApi({
    readOpen: () => ({ sessionId: 'poison-fixture' }), getVariables: () => poisonTable,
    getCurrentMessageId: () => 0, getLastMessageId: () => 0, options: { state: () => ({}) },
  })
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(poisonApi.substitudeMacros('{{get_chat_variable::' + key + '}}'), '', '毒 key 必须拦成空串：' + key)
  }
  assert.equal(poisonApi.substitudeMacros('{{get_chat_variable::hp}}'), '12', '正常 key 不受影响')
  // 原型链上的 key（非自有属性）也必须取不到 —— 专打 hasOwnProperty 校验的变异。
  const chainTable = {}
  assert.equal(poisonApi.substitudeMacros('{{get_chat_variable::toString}}'), '', '原型链 key 必须取不到（hasOwn 校验）')
  assert.equal(createHelperReadonlyApi({
    readOpen: () => ({ sessionId: 'p' }), getVariables: () => chainTable,
    getCurrentMessageId: () => 0, getLastMessageId: () => 0, options: { state: () => ({}) },
  }).substitudeMacros('{{get_chat_variable::toString}}'), '', 'toString 不是自有属性 ⇒ 空串')
  // 作者位置宏回落用**非默认夹具**判别：playerName/characterName 都不设 ⇒ 必须回落 '你'/'角色'。
  // （变异成其他字面量会被此断言抓住。）
  const bareApi = createHelperReadonlyApi({
    readOpen: () => ({ sessionId: 'bare-fixture' }), getVariables: () => ({}),
    getCurrentMessageId: () => 0, getLastMessageId: () => 0, options: { state: () => ({}) },
  })
  assert.equal(bareApi.substitudeMacros('{{user}}/{{char}}'), '你/角色', '作者默认回落必须是 你/角色')
  assert.equal(bareApi.substitudeMacros('{{user}}/{{char}}'), authorMacroWindow({}, () => ({}), 0, 0).substitudeMacros('{{user}}/{{char}}'), '与作者一致')
  // 有 state 时必须用 state 的真名（不能被常量回落吞掉）
  assert.equal(h.api.substitudeMacros('{{user}}/{{char}}'), '玩家/角色')
  // options.message_id / character_name 覆盖
  assert.equal(h.api.substitudeMacros('{{char}}', { character_name: '别名' }), '别名')
}

// —— 2. regex：作者 installer 真 DI，isCharacterTavernRegexesEnabled + formatAsTavernRegexedString ——
{
  const h = harness()
  assert.equal(h.api.isCharacterTavernRegexesEnabled(), true, '卡对象存在 ⇒ true（作者 boundCharacter）')
  h.live.state.character = null
  assert.equal(h.api.isCharacterTavernRegexesEnabled(), false, '无卡 ⇒ false')
  h.live.state.character = { name: '角色' }
  // 真实正则脚本：display 位置 (placement 2)、markdownOnly 使 display 生效
  h.live.state.regexScripts = { global: [{ id: 'g1', name: '替换', enabled: true, findRegex: '/foo/gi', replaceString: 'bar', trimStrings: [], placement: [2], markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null }], character: [] }
  const authorWindow = { substitudeMacros: (v) => authorMacroFor(h, v) }
  function authorMacroFor(h2, v) { return v }
  const authorTarget = { substitudeMacros: v => v, console: { warn() {} } }
  installTavernHelperRegexApi({ window: authorTarget, context: () => h.live.state, createEngine: () => createTavernRegexEngine() })
  const out = h.api.formatAsTavernRegexedString('say foo here', 'ai_output', 'display', { depth: 0 })
  assert.equal(out, authorTarget.formatAsTavernRegexedString('say foo here', 'ai_output', 'display', { depth: 0 }), 'regex 输出必须与作者 installer 一致')
  assert.equal(out, 'say bar here')
  // 作者 TypeError 契约照抄（非法 source/destination/settings/depth）
  for (const bad of [['x', 'bogus', 'display', {}], ['x', 'ai_output', 'bogus', {}], ['x', 'ai_output', 'display', []], ['x', 'ai_output', 'display', { depth: 'a' }]]) {
    assert.throws(() => h.api.formatAsTavernRegexedString(...bad), TypeError, '非法入参必须 TypeError：' + JSON.stringify(bad))
  }
}
// 缺 DI 必须响亮，不伪空正则
{
  const h = harness()
  const broken = createHelperReadonlyApi({
    readOpen: () => h.live, getVariables: () => ({}), getCurrentMessageId: () => 0, getLastMessageId: () => 0,
    options: { state: () => h.live.state, installRegexApi: installTavernHelperRegexApi }, host: {},
  })
  assert.throws(() => broken.isCharacterTavernRegexesEnabled(), /engine依赖缺失/, '缺 createRegexEngine ⇒ 抛错')
  const broken2 = createHelperReadonlyApi({
    readOpen: () => h.live, getVariables: () => ({}), getCurrentMessageId: () => 0, getLastMessageId: () => 0,
    options: { state: () => h.live.state, createRegexEngine: createTavernRegexEngine }, host: {},
  })
  assert.throws(() => broken2.formatAsTavernRegexedString('a', 'ai_output', 'display', {}), /installer依赖缺失/, '缺 installer ⇒ 抛错')
}

// —— 3. version：作者真值，不猜 ——
{
  const h = harness()
  assert.equal(h.api.getTavernHelperVersion(), AUTHOR_VERSION)
  assert.match(bootstrap, /window\.getTavernHelperVersion = function \(\) \{ return "4\.8\.19"; \}/, '作者版本锚点必须是 4.8.19')
  const noVersion = createHelperReadonlyApi({ readOpen: () => h.live, getVariables: () => ({}), getCurrentMessageId: () => 0, getLastMessageId: () => 0 })
  assert.throws(() => noVersion.getTavernHelperVersion(), e => e.code === 'DSH_TAVERN_SERVER_UNSUPPORTED_API', '未接线必须 unavailable 而非猜值')
}

// —— 4. 只读 slash 管道：与作者 readPipeline 解析逐条对照（含 quote/escape/pipe） ——
{
  const h = harness()
  const parseCases = ['/pass 你好', '/return "带|竖线"', '/findentry file=书 校园',
    '/findentry file=书 field=comment 注释', '/findentry file="我的 书" 校园', '/pass a\\|b',
    "/findentry file='x' field=uid 3", '/pass {{pipe}}尾巴']
  // 真对照：**本包解析** vs **作者解析** 逐条 deepEqual（不是作者与作者自比）。
  // 本包经 beginReadonlyProbe 暴露内部 readPipeline（仅测试用，不污染已冻结的生产 API 面）。
  const probe = beginReadonlyProbe(h.api)
  for (const line of parseCases) {
    assert.deepEqual(probe.readPipeline(line), actualPipeline.readPipeline(line), '解析必须与作者一致：' + line)
  }
  // 非法管道两侧都必须抛，且 code 相同
  for (const bad of ['/pass "未闭合', '/bogus x', '/findentry 校园', '/findentry file=书 field=zzz x', '/findentry file=书 field=uid field=name x']) {
    assert.throws(() => probe.readPipeline(bad), e => e.code === 'UNSUPPORTED_SLASH_PIPELINE', '本包必须拒绝：' + bad)
    assert.throws(() => actualPipeline.readPipeline(bad), e => e.code === 'UNSUPPORTED_SLASH_PIPELINE', '作者必须拒绝：' + bad)
  }
  // 执行：/pass 原样回、/findentry 返回 uid 字符串（搜索词是位置参数）
  assert.equal(await h.api.triggerSlash('/pass 你好'), '你好')
  assert.equal(await h.api.triggerSlash('/findentry file=书 校园'), '3', '精确匹配取 uid')
  assert.equal(await h.api.triggerSlash('/findentry file=书 学园'), '3')
  assert.equal(await h.api.triggerSlash('/findentry file=书 校园生活'), '9', '长候选次优')
  assert.equal(await h.api.triggerSlash('/findentry file=书 field=comment 注释'), '3')
  assert.equal(await h.api.triggerSlash('/pass a\\|b'), 'a|b', '转义竖线必须解回，不能重切管道')
  // {{pipe}} 替换（不 reparse）
  assert.equal(await h.api.triggerSlash('/pass 前缀|/pass {{pipe}}后缀'), '前缀后缀')
  // 引号内的竖线**不得**切分管道（专打"退化为忽略引号的 split"变异）：
  // `"a|b"` 若被切开，就会多出一段非法命令 ⇒ 必须整体当一个 /pass 文本返回。
  assert.equal(await h.api.triggerSlash('/pass "a|b"'), 'a|b', '引号内竖线不得切分')
  assert.equal(await h.api.triggerSlash('/pass "a|/send b"'), 'a|/send b', '引号内命令字样不得触发拒绝')
  // 作者侧同输入同结果（真对照）
  assert.equal(actualPipeline.readPipeline('/pass "a|b"').length, 1, '作者解析引号内竖线为单段')
  // 未匹配 → 空串
  assert.equal(await h.api.triggerSlash('/findentry file=书 不存在的词'), '')
  // 本档世界书：只用本次 sessionId，且 consistent=false
  const calls = h.calls.filter(c => c.name !== undefined)
  assert.ok(calls.length > 0 && calls.every(c => c.sessionId === 'readonly-fixture' && c.consistent === false), '世界书必须走本档 sessionId 且 consistent=false')
  // 管道预校验：混合/生成命令必须在**提交前**拒绝且不读世界书。
  // 每条都断言**专属文案**（不只断言 code）—— 否则删掉某个分支的 throw，后续兜底仍会抛同 code ⇒ 变异漏检。
  const before = h.calls.length
  const rejections = [
    ['/cut 3', /\/cut/],
    ['/send 你好 | /trigger', /生成命令/],
    ['/trigger', /生成命令/],
    ['/ejs x', /仅支持/],
    // 混合管道由**作者 readPipeline 整条预校验**拒绝（非只读命令段 ⇒ 专属文案）
    ['/pass a|/send b', /只能与只读命令组合/],
  ]
  for (const [bad, pattern] of rejections) {
    await assert.rejects(h.api.triggerSlash(bad), e => e.code === 'UNSUPPORTED_SLASH_PIPELINE' && pattern.test(e.message), '必须预检拒绝：' + bad)
  }
  assert.equal(h.calls.length, before, '被拒绝的生成/混合命令不得触发世界书读')
  // 引号未闭合必须响亮
  await assert.rejects(h.api.triggerSlash('/pass "未闭合'), e => e.code === 'UNSUPPORTED_SLASH_PIPELINE')
}

// —— 5. DOM/display 不做服务端假 facade ——
{
  const h = harness()
  for (const name of ['getMessageId', 'getIframeName', 'retrieveDisplayedMessage', 'formatAsDisplayedMessage']) {
    assert.throws(() => h.api[name]('x'), e => e.code === 'DSH_TAVERN_SERVER_UNSUPPORTED_API', name + ' 必须 unsupported')
  }
}

// —— 6b. 世界书：缺 host / 回执缺 entries 必须抛错，不伪空列表（"第三方缺 DI 须错误不伪空"） ——
{
  const make = host => createHelperReadonlyApi({
    readOpen: () => ({ sessionId: 'wb-fixture' }), getVariables: () => ({}),
    getCurrentMessageId: () => 0, getLastMessageId: () => 0, options: { state: () => ({}) }, host,
  })
  // 缺 host.getWorldbook ⇒ unsupported（不是返回 []）
  await assert.rejects(make({}).getWorldbook('书'), e => e.code === 'DSH_TAVERN_SERVER_UNSUPPORTED_API')
  await assert.rejects(make({}).triggerSlash('/findentry file=书 x'), e => e.code === 'DSH_TAVERN_SERVER_UNSUPPORTED_API')
  // host 回执缺 worldbook.entries ⇒ TypeError（不把缺字段当空书）
  const noEntries = make({ getWorldbook: async () => ({ worldbook: {} }) })
  await assert.rejects(noEntries.getWorldbook('书'), /缺少 worldbook\.entries/)
  await assert.rejects(noEntries.triggerSlash('/findentry file=书 x'), /缺少 worldbook\.entries/)
  // 正常回执：本档只读副本，且改副本不污染宿主
  const entries = [{ uid: 1, name: 'n', content: 'c', strategy: { keys: ['k'], keys_secondary: { keys: [] } } }]
  const ok = make({ getWorldbook: async () => ({ worldbook: { entries } }) })
  const got = await ok.getWorldbook('书')
  assert.deepEqual(got, entries)
  got[0].name = '被改'
  assert.equal(entries[0].name, 'n', '返回必须是脱离副本，不得外泄宿主真身')
}
// —— 6c. buttons：真投影（作者 project 产出）+ 真实 buttonEvent；无投影必须响亮 ——
{
  // 真作者投影：用**作者自己的 projectTavernHelperScripts** 从 fixture 卡脚本生成 scriptProjection，
  // 不手写 shape（folder/enabled/变量/源码隔离都走真身）。
  const helperScriptsFixture = [
    { id: 's1', name: '一', type: 'script', enabled: true, content: '/* s1 */', info: 'i1',
      buttons: [{ name: '开始', visible: true }, { name: '隐藏', visible: false }, { name: '无visible' }, null] },
    { id: 's2', name: '二', type: 'script', enabled: true, content: '/* s2 */', buttonsEnabled: false,
      buttons: [{ name: '关掉的', visible: true }] },
    { id: 's3', name: '三', type: 'script', enabled: false, content: '/* s3 */',
      buttons: [{ name: '未启用脚本的钮', visible: true }] },
    { id: 'mvu', name: 'MVU', type: 'script', enabled: true, content: 'MagicalAstrogy/MagVarUpdate', buttons: [{ name: 'x', visible: true }] },
    { id: 's4', name: '四', type: 'script', enabled: true, content: '   ', buttons: [{ name: '空脚本钮', visible: true }] },
  ]
  const projected = actualProject.projectTavernHelperScripts(helperScriptsFixture, { s1: { hp: 7 } })
  // 真身 shape 校验（不猜）：只剩 s1/s2，且带 buttons/buttonsEnabled/data。
  assert.deepEqual(projected.scripts.map(s => s.id), ['s1', 's2'], '作者 project：enabled/type/空内容/MVU 都要滤掉')
  assert.equal(projected.scripts[0].buttonsEnabled, true)
  assert.equal(projected.scripts[1].buttonsEnabled, false, '显式 buttonsEnabled:false 必须留在投影里')
  assert.deepEqual(projected.scripts[0].data, { hp: 7 }, '变量按 script id 取（真作者契约）')

  const h = harness()
  h.live.state.scriptProjection = projected
  // 运行时置位的 failed（投影本身不含该字段）——由夹具补，等价于 server 侧 runtime 回填。
  h.live.state.scriptProjection = { scripts: projected.scripts.map(s => ({ ...s })) }
  h.live.state.scriptProjection.scripts.push({ id: 's5', name: '五', buttonsEnabled: true, failed: true, buttons: [{ name: '失败脚本钮', visible: true }] })

  const buttons = h.api.getAllEnabledScriptButtons()
  // 真对照：button_id 必须等于作者 buttonEvent（真身抽取）的结果，不是猜的格式。
  assert.deepEqual(buttons, {
    s1: [{ button_id: actualButtonEvent('开始', 's1'), button_name: '开始' }],
  }, '只留 visible===true 且脚本启用/未失败的按钮')
  assert.equal(buttons.s2, undefined, 'buttonsEnabled:false 整脚本跳过')
  assert.equal(buttons.s5, undefined, 'failed 脚本整脚本跳过')
  assert.equal(buttons.s3, undefined, '未启用脚本不出现（作者 project 已滤）')
  // 空按钮脚本**不得建键**（作者 :438 `if (buttons.length)`）——判别构造：s6 全部按钮都不可见、
  // 若去掉该守卫就会留下 `s6: []`，与作者返回 shape 不同。用 Object.keys 断言，避免 deepEqual 对 undefined 键不敏感。
  h.live.state.scriptProjection.scripts.push({ id: 's6', name: '六', buttonsEnabled: true, buttons: [{ name: '看不见', visible: false }] })
  const withEmpty = h.api.getAllEnabledScriptButtons()
  assert.deepEqual(Object.keys(withEmpty), ['s1'], '空按钮脚本不得建键（作者 :438 守卫）')
  assert.equal('s6' in withEmpty, false, '空按钮脚本不得留下 s6:[] 键')
  // 真身格式判别：button_id = `${id}_${stringHash(name)}`，且 hash 必须被真身复现。
  assert.equal(buttons.s1[0].button_id, 's1_' + String(actualButtonEvent('开始', 's1')).split('_')[1])
  assert.match(buttons.s1[0].button_id, /^s1_\d+$/, 'button_id 形如 <scriptId>_<hash>')
  // 返回值必须是脱离副本：改**数组项与数组本身**都不能污染投影真身；且每次调用都给出新对象
  // （判别的是"外部改动不回流 + 不共享可变容器"，不要求与投影真身做整档文本往返）。
  const firstCall = h.api.getAllEnabledScriptButtons()
  assert.notEqual(firstCall, h.api.getAllEnabledScriptButtons(), '每次调用必须是新的结果对象')
  buttons.s1[0].button_name = '被改'
  buttons.s1.push({ button_id: '注入', button_name: '注入' })
  assert.equal(h.live.state.scriptProjection.scripts[0].buttons[0].name, '开始', '返回必须是脱离副本（项）')
  const fresh = h.api.getAllEnabledScriptButtons()
  assert.equal(fresh.s1.length, 1, '返回必须是脱离副本（数组长度不得被外部 push 影响）')
  assert.equal(fresh.s1[0].button_name, '开始', '重复调用必须回到真身值')
  assert.notEqual(fresh.s1, buttons.s1, '按钮数组不得与上次返回共享容器')
  assert.equal(fresh.s1[0].button_name, h.live.state.scriptProjection.scripts[0].buttons[0].name, '真身未被改动')

  // 无投影 ⇒ unsupported（不伪空对象）；只读面不得泄露内部计划字段。
  const bare = harness()
  assert.throws(() => bare.api.getAllEnabledScriptButtons(), e => e.code === 'DSH_TAVERN_SERVER_UNSUPPORTED_API', '无投影必须响亮')
  assert.equal('readonlyPlan' in bare.api, false, 'readonlyPlan 计划字段已删除，不向脚本暴露内部计划')
  assert.equal('readonlyPlan' in h.api, false, '有投影时也不暴露内部计划')
}

// —— 7. scope 关闭：读口必须抛，不吞 ——
{
  const h = harness()
  h.live.open = false
  assert.throws(() => h.api.substitudeMacros('{{user}}'), /窗口已关闭/)
  await assert.rejects(h.api.triggerSlash('/pass x'), /窗口已关闭/)
  await assert.rejects(h.api.getWorldbook('书'), /窗口已关闭/)
  // 新增接线的方法同样必须在**方法 wrapper 内**过窗口检查（不在工厂期快照），close 后一律响亮。
  assert.throws(() => h.api.getTavernHelperVersion(), /窗口已关闭/, 'version 关闭必须抛')
  assert.throws(() => h.api.getAllEnabledScriptButtons(), /窗口已关闭/, 'buttons 关闭必须抛')
  assert.throws(() => h.api.isCharacterTavernRegexesEnabled(), /窗口已关闭/, 'regex 关闭必须抛')
  assert.throws(() => h.api.formatAsTavernRegexedString('a', 'ai_output', 'display', {}), /窗口已关闭/, 'regex format 关闭必须抛')
  // 反向判别：state() 在 close 时**根本不应被调用**（窗口检查留在 wrapper 内 ⇒ 不触发 state 读）。
  {
    let stateReads = 0
    const closed = createHelperReadonlyApi({
      readOpen: () => { throw new Error('窗口已关闭') }, getVariables: () => ({}),
      getCurrentMessageId: () => 0, getLastMessageId: () => 0,
      options: { state: () => { stateReads += 1; return {} } },
    })
    assert.throws(() => closed.getAllEnabledScriptButtons(), /窗口已关闭/)
    assert.equal(stateReads, 0, '关闭时 state() 不得被调用（窗口检查必须在方法 wrapper 内）')
  }
}

// —— 8. 只读性：本模块不得有任何写/保存入口 ——
{
  const h = harness()
  const forbidden = ['replaceVariables', 'insertVariables', 'deleteVariable', 'setChatMessages', 'createChatMessages',
    'replaceTavernRegexes', 'updateTavernRegexesWith', 'replaceWorldbook', 'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries']
  for (const name of forbidden) assert.equal(name in h.api, false, '只读层不得暴露 ' + name)
  assert.deepEqual(Object.isFrozen(h.api), true, 'API 必须冻结')
}

console.log('helper-25-readonly: macro作者对照/regex真实installer+engine/version真值/readPipeline逐条对照/本档世界书/预校验拒绝/DOM unsupported/scope关闭/只读面 全部通过')
