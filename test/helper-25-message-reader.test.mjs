// 卡脚本消息读取器对照测试（范围：限定 source 函数语义，不声称性能、不声称页面生效）。
//
// 对照方式（不引 jsdom、不另造 fixture 框架）：
//   · **实际 source 链条**：raw floor → 作者 `projectTavernHelperMessage`（真实源码，
//     lib/domain/tavern-helper-context.js:58-79）→ 作者 `createTavernHelperMessageReader`
//     （真实源码，lib/client.js:3580-3615）。
//   · 我们这一侧喂**同一份 raw floor**，用作者的 projectTavernHelperMessage 做 projectRow 注入。
//   · **不用自己写的伪投影当对照基准** —— 那只能证明"我的投影等于我的投影"（同义反复）。
//
// 必要性：该 reader 是公开 `getChatMessages`/`getAllChatMessages` 的语义来源；
// 上游 2.5 明确改了 range/负数/clamp/role/hide_state/data/extra/swipes_info 这些可观察行为，
// 而这些行为**旧 server-execution 内部 chatMessages 并不具备**（非法 range 回落当前楼、
// 数组 range 当闭区间）。不逐项比对，就只能靠"看起来像"。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {createHelperMessageReader, projectRawHelperFloor} from '../lib/helper-message-reader.js'

// 作者源码路径：**由仓库根绝对锚定**（实测 `test/` 上溯 3 层 = 仓库根），不靠数 `../` 猜深度。
// `new URL('../../..', import.meta.url)` 从 `.../plugins/dsh-tavern-sqlite-v2/test/` → `dsh-tavern/`。
const REPO_ROOT = new URL('../../../', import.meta.url)
const upstreamClientSource = () => readFileSync(new URL('tmp/upstream25-helper-contract/raw/author__lib__client.js', REPO_ROOT), 'utf8')
const upstreamContextSource = () => readFileSync(new URL(
  'tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/tavern-helper-context.js',
  REPO_ROOT), 'utf8')

/** 从作者 raw 里按函数名切出**真实**函数源码（花括号配平扫描；找不到即抛，绝不用手写赝品顶替）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error('作者源中找不到函数：' + name)
  let depth = 0
  let seen = false
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index]
    if (ch === '{') { depth += 1; seen = true }
    else if (ch === '}') {
      depth -= 1
      if (seen && depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('函数源码未闭合：' + name)
}

/** 作者 `projectTavernHelperMessage` 的**真实源码**（含它真实引用的 clone/selectedSwipe/tavernHelperRole/str）。 */
function authorProjector() {
  const code = extractFunction(upstreamContextSource(), 'projectTavernHelperMessage')
  const context = vm.createContext({structuredClone})
  // 这些是作者原文真实引用的同文件依赖，一并抽**真实源码**（不手写替身）。
  const deps = ['selectedSwipe', 'tavernHelperRole', 'str', 'clone']
    .map(name => extractFunction(upstreamContextSource(), name))
  vm.runInContext(deps.join('\n'), context)
  return vm.runInContext(`(${code})`, context)
}

/** 用作者真实源码建一个上游 reader（vm 隔离，只给 structuredClone）。 */
function upstreamReader(options) {
  const code = extractFunction(upstreamClientSource(), 'createTavernHelperMessageReader')
  const context = vm.createContext({structuredClone})
  const factory = vm.runInContext(`(${code})`, context)
  return factory(options)
}

// —— 共享 **raw storage floor** fixture（self raw，不依赖 jsdom）——
// 形态照**作者真实存档行**：native-conversation-storage.js:262 的字段清单
// (`role`,`tavernRole`,`tavernHidden`,`name`,`turn`,`greeting`,`swipeId`,`swipes`,`sourceText`,…)
// + `variables` 是**每 swipe 一棵树**的数组（同文件 :241-242、:291-293 的 `variables[swipe]`）
// + tavern-script-host-adapter.js:681 造 user 楼用的 `{role,text,swipeId,swipes,variables}`。
// 三处"raw 行 vs 投影行"最容易混同的地方正是本测试要盯的：
//   role 用 `'tavern-helper'`（不是 system/user/assistant）、隐藏位叫 `tavernHidden`、
//   插件元数据叫 `tavernPluginData`、正文是 `sourceText/text`。
function rawFixture() {
  return [
    {
      role: 'user', swipeId: 0, swipes: ['你好'], sourceText: '你好', text: '你好',
      variables: [{tree: 'm0s0'}]
    },
    {
      role: 'assistant', swipeId: 1, swipes: ['开场一', '开场二'], sourceText: '开场一', text: '开场一',
      // 两个 swipe 都带真树：swipes_data 必须**保全部**，不能非 active 全 {}。
      variables: [{tree: 'm1s0'}, {tree: 'm1s1'}],
      tavernPluginData: {swipe_info: [{info: 'i0'}, {info: 'i1'}], extra: {extraRoot: true}}
    },
    {
      role: 'tavern-helper', tavernRole: 'system', tavernHidden: true, swipeId: 0,
      swipes: ['隐藏楼'], sourceText: '隐藏楼', text: '隐藏楼',
      variables: [{tree: 'm2s0'}], name: '助手楼'
    },
    {
      // swipeId 越界（swipes/variables 都只有 1 项）⇒ selectedSwipe 必须 clamp 到 0。
      role: 'assistant', swipeId: 5, swipes: ['单条'], sourceText: '单条', text: '单条',
      variables: [{tree: 'm3s0'}]
    },
    {
      // 缺 swipeId、缺 sourceText/text（只有 message 语义）⇒ swipeId=0，正文由 swipes 给。
      role: 'assistant', swipes: ['仅message'], variables: [{}]
    }
  ]
}

/** 两侧共用：raw floors + 玩家/角色名 + 权威树解析口。 */
function harness() {
  const floors = rawFixture()
  const project = authorProjector()
  const CURRENT_ID = 1
  // 投影行：**作者真实投影**（两侧同一份）。作者的模型是**单一来源**：
  // `readMessage(id)` 返回 `state.messages[id]`，其 `variables` 已是选中 swipe 的那棵树
  // （helper-bootstrap.js:338-339 `getVariables` 直接读 `message.variables`）。
  // 没有"读时再叠一层 active 树"的第二来源 —— 本测试据此对照，不伪造覆盖。
  const projected = floors.map((floor, index) => project(floor, index))
  const upstreamState = () => ({messages: projected, playerName: '旅人', characterName: '艾莉'})
  const upstream = upstreamReader({
    context: upstreamState,
    currentId: () => CURRENT_ID,
    copy: value => (value === undefined ? undefined : structuredClone(value)),
    readMessage: id => projected[id]
  })
  const ours = createHelperMessageReader({
    readOpen: () => ({
      chat: {messages: floors, macroState: {userName: '旅人'}, cardName: '艾莉'},
      messageId: CURRENT_ID, swipeId: 1, playerName: '旅人', characterName: '艾莉'
    }),
    // 真实 source 链：raw floor → 作者投影（不是自己写的伪投影）。
    projectRow: (floor, messageId) => project(floor, messageId),
    // 与作者接线同源：投影行的 variables 即权威树。
    variablesOf: option => projected[option.message_id]?.variables ?? {},
    copy: value => (value === undefined ? undefined : structuredClone(value))
  })
  return {floors, projected, project, upstream, ours, CURRENT_ID}
}

/** 逐字段比对：先比字段集合，再比值。 */
function compareRows(actual, expected, label) {
  assert.deepStrictEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
    `${label}：字段集合须与上游一致`
  )
  assert.deepStrictEqual(actual, expected, `${label}：整行须与上游逐字段相等`)
}

/**
 * 跨 realm 取值：上游函数跑在 vm 里，其数组/对象原型与本 realm 不同 —— `deepStrictEqual`
 * 会因原型差异假失败。比较前统一 JSON 往返成**本 realm 的普通值**（只用于比较，不参与实现）。
 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 取楼号序列（本 realm 普通数组）。 */
function idsOf(reader, range, settings) {
  return plain(reader(range, settings).map(row => row.message_id))
}

test('必要性：作者raw中确有该函数的真实createTavernHelperMessageReader形态（不是赝品锚点）', () => {
  const code = extractFunction(upstreamClientSource(), 'createTavernHelperMessageReader')
  // 关键真实语句必须在：range 正则、lastMessageId 宏、clamp、role/hide_state、extra/swipes_info。
  assert.equal(code.includes('function createTavernHelperMessageReader(options) {'), true)
  assert.equal(code.includes('/^(-?\\d+)(?:-(-?\\d+))?$/'), true, 'range 正则须为真实上游形态')
  assert.equal(code.includes('{{\\s*lastMessageId\\s*}}'), true, 'lastMessageId 宏须真实存在')
  assert.equal(code.includes('Math.max(0, Math.min(count - 1,'), true, 'clamp 须真实存在')
  assert.equal(code.includes("filter.hide_state === 'hidden'"), true)
  assert.equal(code.includes('swipes_info'), true)
  // 上游没有 last_user/last_char 语义 —— 不得在本模块自造。
  assert.equal(code.includes('last_user'), false)
  assert.equal(code.includes('last_char'), false)
})

test('必要性：投影链是作者的 projectTavernHelperMessage（raw 改名：tavernRole/tavernHidden/tavernPluginData）', () => {
  const code = extractFunction(upstreamContextSource(), 'projectTavernHelperMessage')
  // 这三个改名是本轮的真 source 契约，缺一即说明对照基准不是作者投影。
  assert.equal(code.includes('tavernHelperRole(source)'), true, 'role 须经 tavernHelperRole 映射')
  assert.equal(code.includes('source.tavernHidden === true'), true, 'is_hidden 须来自 tavernHidden')
  assert.equal(code.includes('source.tavernPluginData || {}'), true, 'pluginData 须来自 tavernPluginData')
  assert.equal(code.includes('swipes_data: variables'), true, 'swipes_data 须保全部 swipe 变量')
  assert.equal(code.includes('{type:' + ''), false, '不得出现自造口径')
  // raw floor 字段清单（native 存档真身）与投影字段名必须**不同**，否则本测试测不到改名。
  const floors = rawFixture()
  assert.equal(Object.hasOwn(floors[2], 'tavernHidden'), true)
  assert.equal(Object.hasOwn(floors[2], 'is_hidden'), false)
  assert.equal(Object.hasOwn(floors[1], 'tavernPluginData'), true)
  assert.equal(Object.hasOwn(floors[1], 'pluginData'), false)
  assert.equal(floors[0].role !== 'tavern-helper' && floors[2].role === 'tavern-helper', true)
})

test('数字/负数/双端range与{{lastMessageId}}：非法range返回[]（不回落当前楼）', () => {
  const {upstream, ours} = harness()
  for (const range of [
    1, '1', 0, -1, -3,
    '0-2', '2-0', '-2--1',
    '{{lastMessageId}}', '0-{{lastMessageId}}', '{{ lastMessageId }}',
    undefined, null
  ]) {
    assert.deepStrictEqual(idsOf(ours, range), idsOf(upstream, range), `range=${String(range)}`)
  }
  // 非法 range → []（上游 3588 行），而非当前楼。
  for (const range of ['', 'abc', '1-', '-', '1-2-3', '{{lastMessage}}', {}, [], 'all']) {
    assert.deepStrictEqual(plain(ours(range)), [], `非法 range ${String(range)} 必须返回 []`)
    assert.deepStrictEqual(idsOf(ours, range), idsOf(upstream, range), `非法 range ${String(range)} 与上游一致`)
  }
})

test('越界clamp与reverse normalize：两端各自夹进[0,count-1]，min→max 顺序读出', () => {
  const {floors, upstream, ours} = harness()
  const last = floors.length - 1
  assert.deepStrictEqual(idsOf(ours, '0-99'), [0, 1, 2, 3, 4], '超上界 clamp 到 count-1')
  // 两端**各自**归一：-99 → count-99 < 0 → 夹到 0，故 '-99-0' 实为 [0,0]。
  assert.deepStrictEqual(idsOf(ours, '-99-0'), [0], '超下界 clamp 到 0')
  assert.deepStrictEqual(idsOf(ours, '2-0'), [0, 1, 2], 'reverse normalize：仍按 min→max')
  assert.deepStrictEqual(idsOf(ours, '99-99'), [last], '双端同上界')
  assert.deepStrictEqual(idsOf(ours, -1), [last], '单楼负数=倒数第一')
  for (const range of ['0-99', '-99-0', '2-0', '99-99', -1, -99, '-1--99']) {
    assert.deepStrictEqual(idsOf(ours, range), idsOf(upstream, range), `range=${range}`)
  }
})

test('role/hide_state过滤：raw 楼按 tavernRole/tavernHidden 映射后再过滤，与上游一致', () => {
  const {upstream, ours} = harness()
  for (const settings of [
    {role: 'user'}, {role: 'assistant'}, {role: 'all'}, {role: 'system'}, {role: 'tavern-helper'},
    {hide_state: 'hidden'}, {hide_state: 'unhidden'},
    {role: 'assistant', hide_state: 'unhidden'}, {role: 'all', hide_state: 'hidden'}
  ]) {
    assert.deepStrictEqual(
      idsOf(ours, '0-4', settings),
      idsOf(upstream, '0-4', settings),
      `settings=${JSON.stringify(settings)}`
    )
  }
  // raw 楼 2 是 `role:'tavern-helper', tavernRole:'system'` ⇒ 作者投影 role='system'，
  // 故 role:'system' 必须命中它。`role:'tavern-helper'` 是 raw 字段值、不是作者映射后的公开 role
  // ——这里只断言**与上游一致**（上游同样按投影后的 role 过滤）。
  assert.deepStrictEqual(idsOf(ours, '0-4', {role: 'system'}), [2])
  assert.deepStrictEqual(idsOf(ours, '0-4', {role: 'tavern-helper'}), idsOf(upstream, '0-4', {role: 'tavern-helper'}))
  // raw 楼 2 的隐藏位是 tavernHidden:true ⇒ hide_state:'hidden' 只留它。
  assert.deepStrictEqual(idsOf(ours, '0-4', {hide_state: 'hidden'}), [2])
})

test('整行投影逐字段等于上游：role/message_id/swipe_id/message/swipes/swipes_data/variables/data/name/is_hidden/swipes_info/extra', () => {
  const {upstream, ours} = harness()
  const expected = plain(upstream('0-4'))
  const actual = plain(ours('0-4'))
  assert.equal(actual.length, expected.length)
  for (let index = 0; index < expected.length; index += 1) {
    compareRows(actual[index], expected[index], `楼${expected[index].message_id}`)
  }
  // 显式点名必存字段（防未来重构静默丢字段）。
  for (const key of ['role', 'message_id', 'swipe_id', 'message', 'swipes', 'swipes_data', 'variables', 'data', 'name', 'is_hidden', 'swipes_info', 'extra', 'pluginData']) {
    assert.equal(Object.hasOwn(actual[1], key), true, `必须保留字段 ${key}`)
  }
  // variables = 作者的**选中 swipe 树**（raw `variables[swipeId]`，作者投影 :72 设定）。
  assert.deepStrictEqual(actual[1].variables, {tree: 'm1s1'}, 'variables 取选中 swipe 的那棵树')
  assert.equal(actual[1].message, '开场二', 'message 取 swipes[swipe_id]')
  assert.equal(actual[1].swipe_id, 1)
  assert.deepStrictEqual(actual[1].swipes, ['开场一', '开场二'])
})

test('swipes_data 保**全部 swipe** 的变量（非 active 不得变 {}）', () => {
  const {ours, upstream} = harness()
  const row = plain(ours(1))[0]
  // 楼 1 有两个 swipe，两棵真树都在 ⇒ 两棵都要在（非 active 的 s0 也必须保留）。
  assert.deepStrictEqual(row.swipes_data, [{tree: 'm1s0'}, {tree: 'm1s1'}],
    'swipes_data 保全部 swipe 的变量')
  assert.notDeepStrictEqual(row.swipes_data[0], {}, '非 active swipe 不得被清成 {}')
  assert.deepStrictEqual(row.swipes_data, plain(upstream(1))[0].swipes_data, '与上游逐字段一致')
  // data 按上游 3607 行优先级：swipes_data[swipe] 优先。
  assert.deepStrictEqual(row.data, {tree: 'm1s1'}, 'data 取 swipes_data[swipe_id]')
  // 槽位**真的缺失**时（swipes 2 项、variables 只 1 项、swipeId=1）：
  // 作者实测 reader 输出 `[{only0}, {}]` —— 缺的那个补 {}，不是 undefined、也不是抛错。
  // 这条盯的是"保全部 swipe"的边界：有值必须保、无值才补 {}。
  const sparse = [{role: 'assistant', swipeId: 1, swipes: ['s0', 's1'], variables: [{tree: 'only0'}]}]
  const sp = createHelperMessageReader({
    readOpen: () => ({chat: {messages: sparse}, messageId: 0, swipeId: 1}),
    projectRow: authorProjector(),
    variablesOf: () => ({})
  })
  assert.deepStrictEqual(plain(sp(0))[0].swipes_data, [{tree: 'only0'}, {}],
    '缺失的非 active 槽补 {}（与作者实测一致）')
})

test('swipe_id 按 selectedSwipe clamp（swipes/variables count），越界与缺省都落到合法槽', () => {
  const {floors, ours, upstream} = harness()
  // 楼 3：swipeId=5 但 swipes/variables 只有 1 项 ⇒ 投影 clamp 到 0。
  assert.equal(floors[3].swipeId, 5, 'fixture 确实是越界 raw swipeId')
  assert.equal(plain(ours(3))[0].swipe_id, 0, '越界 swipeId 必须 clamp 到 count-1')
  // 楼 4：缺 swipeId ⇒ 0。
  assert.equal(plain(ours(4))[0].swipe_id, 0, '缺 swipeId 落 0')
  for (const id of [3, 4]) {
    compareRows(plain(ours(id))[0], plain(upstream(id))[0], `楼${id}`)
  }
})

test('raw sourceText||text 契约：正文取 sourceText，缺失时以 swipes 为源', () => {
  const {floors, ours} = harness()
  // 楼 0：sourceText 与 text 都在，swipes 也在 ⇒ swipes 优先，message 取 swipes[0]。
  assert.equal(plain(ours(0))[0].message, '你好')
  // 楼 4：有 swipes、无 sourceText/text ⇒ 正文由 swipes 给（作者 :60 的 swipes 分支）。
  assert.equal(floors[4].sourceText, undefined)
  assert.deepStrictEqual(plain(ours(4))[0].swipes, ['仅message'])
  assert.equal(plain(ours(4))[0].message, '仅message')
  // `||` 是真值回落：sourceText 为空串时回落 text（作者 :62 逐字口径），且无 swipes 时走该分支。
  const project = authorProjector()
  const reader = createHelperMessageReader({
    readOpen: () => ({chat: {messages: [{role: 'assistant', sourceText: '', text: '回落文本'}]}, messageId: 0}),
    projectRow: (floor, messageId) => project(floor, messageId),
    variablesOf: () => ({})
  })
  assert.deepStrictEqual(plain(reader(0))[0].swipes, ['回落文本'], '空 sourceText 须回落 text')
})

test('playerName/char 来自 macroState.userName / cardName（不只 state.playerName）', () => {
  // 真实接线（lib/index.js:1594/1623）：reader 的 state.playerName 由产品这样供出：
  //   playerName   = chat.macroState.userName
  //   characterName = card.name || chat.cardName
  // 故本读取器必须能**从 chat 自身**推出这两个名字，而不是只认已被喂好的 state.playerName。
  const reader = createHelperMessageReader({
    readOpen: () => ({
      chat: {
        messages: [{role: 'user', swipes: ['嗨'], variables: [{}]}, {role: 'assistant', swipes: ['哟'], variables: [{}]}],
        macroState: {userName: '旅人'},
        cardName: '艾莉'
      },
      messageId: 0, swipeId: 0
    }),
    projectRow: floor => floor,
    variablesOf: () => ({})
  })
  const rows = plain(reader('0-1'))
  assert.equal(rows[0].name, '旅人', 'user 楼 name 取 chat.macroState.userName')
  assert.equal(rows[1].name, '艾莉', '助手楼 name 取 chat.cardName')
  // cardDefinitionSnapshot.name 优先于 chat.cardName（lib/index.js:633/925 的卡身份来源）。
  const snap = createHelperMessageReader({
    readOpen: () => ({
      chat: {
        messages: [{role: 'assistant', swipes: ['哟'], variables: [{}]}],
        cardName: '旧名', cardDefinitionSnapshot: {name: '卡内名'}
      },
      messageId: 0, swipeId: 0
    }),
    projectRow: floor => floor,
    variablesOf: () => ({})
  })
  assert.equal(plain(snap(0))[0].name, '卡内名', 'cardDefinitionSnapshot.name 优先于 cardName')
  // 完全没有名字来源时才回落原文的「你」/「角色」。
  const bare = createHelperMessageReader({
    readOpen: () => ({
      chat: {messages: [{role: 'user', swipes: ['嗨'], variables: [{}]}, {role: 'assistant', swipes: ['哟'], variables: [{}]}]},
      messageId: 0, swipeId: 0
    }),
    projectRow: floor => floor,
    variablesOf: () => ({})
  })
  assert.equal(plain(bare('0-1'))[0].name, '你', '无玩家名时回落原文「你」')
  assert.equal(plain(bare('0-1'))[1].name, '角色', '无角色名时回落原文「角色」')
})

test('只输出作者契约字段：raw storage 内部字段不得泄漏给卡脚本', () => {
  const {ours} = harness()
  const row = plain(ours(1))[0]
  // 作者 projectTavernHelperMessage 的字段集 + 本包 name 别名，多一个都不许。
  assert.deepStrictEqual(
    Object.keys(row).sort(),
    ['data', 'extra', 'is_hidden', 'message', 'message_id', 'name', 'pluginData', 'role',
      'swipe_id', 'swipes', 'swipes_data', 'swipes_info', 'variables'].sort(),
    '输出字段必须恰为作者契约集'
  )
  // raw floor 的内部字段一个都不许出现。
  for (const leaked of ['tavernRole', 'tavernHidden', 'tavernPluginData', 'sourceText', 'text',
    'swipeId', 'projectionText', 'displayText', 'sessionText', 'turn', 'greeting', '_storageRevision']) {
    assert.equal(Object.hasOwn(row, leaked), false, `不得泄漏 raw 字段 ${leaked}`)
  }
  // 楼 2 是 tavern-helper 楼：pluginData/is_hidden 必须**改名后**出现，原始名不得出现。
  const helperRow = plain(ours(2))[0]
  assert.equal(helperRow.is_hidden, true)
  assert.equal(helperRow.role, 'system')
  assert.equal(Object.hasOwn(helperRow, 'tavernHidden'), false)
  assert.equal(Object.hasOwn(helperRow, 'tavernRole'), false)
})

test('泄漏闸门：raw floor 带**额外**内部字段时也不得出现在输出里', () => {
  // 这条是上面那条的**加强版**：fixture 里塞满 raw storage 的真实内部字段，
  // 并用 raw floor **直投**（projectRawHelperFloor）与**恒等投影**两条路径各验一次 ——
  // 否则"输出字段集恰好正确"可能只是因为 fixture monkey 没有多余字段（断言空转）。
  const dirty = [{
    role: 'tavern-helper', tavernRole: 'system', tavernHidden: true, swipeId: 0,
    swipes: ['x'], sourceText: 'x', text: 'x', variables: [{v: 1}],
    tavernPluginData: {p: 1}, name: 'N',
    // —— 以下都是 raw storage 内部字段，绝不许外泄 ——
    turn: 3, greeting: true, projectionText: 'p', displayText: 'd', sessionText: 's',
    projectionVersion: 2, projectionWarnings: [], displayMode: 'markdown',
    _storageRevision: 7, runtimeRef: {a: 1}, template_display: 't'
  }]
  const expectedKeys = ['data', 'extra', 'is_hidden', 'message', 'message_id', 'name', 'pluginData',
    'role', 'swipe_id', 'swipes', 'swipes_data', 'swipes_info', 'variables'].sort()
  const readers = {
    'raw 直投': createHelperMessageReader({
      readOpen: () => ({chat: {messages: dirty, macroState: {userName: 'U'}, cardName: 'C'}, messageId: 0, swipeId: 0}),
      projectRow: projectRawHelperFloor, variablesOf: () => ({})
    }),
    '恒等投影': createHelperMessageReader({
      readOpen: () => ({chat: {messages: dirty}, messageId: 0, swipeId: 0}),
      projectRow: floor => floor, variablesOf: () => ({})
    })
  }
  for (const [label, reader] of Object.entries(readers)) {
    const row = plain(reader(0))[0]
    assert.deepStrictEqual(Object.keys(row).sort(), expectedKeys, `${label}：输出字段集必须恰为作者契约集`)
    for (const key of Object.keys(dirty[0])) {
      if (expectedKeys.includes(key)) continue
      assert.equal(Object.hasOwn(row, key), false, `${label}：不得泄漏 raw 字段 ${key}`)
    }
  }
})

test('raw/投影 message_id 都不作权威：缺 swipe / 外带 message_id=999 一律按**位置**', () => {
  // 两条路径都验：① 恒等投影（行自带 999）② 作者投影（raw 自带 999）——
  // 作者投影本来就按位置重写 message_id，所以只有断言"位置优先"才能同时盯住两边。
  const floors = [
    {role: 'user', swipes: ['甲'], variables: [{tree: 'a'}], message_id: 999},
    {role: 'assistant', swipes: ['乙'], variables: [{tree: 'b'}], message_id: 999}
  ]
  const identity = createHelperMessageReader({
    readOpen: () => ({chat: {messages: floors}, messageId: 0, playerName: 'P', characterName: 'C'}),
    projectRow: (floor, messageId) => ({...floor, message_id: messageId}),
    variablesOf: () => ({})
  })
  assert.deepStrictEqual(plain(identity('0-1')).map(row => row.message_id), [0, 1],
    'raw 外带的 message_id=999 不可信；message_id 按所选位置')
  const project = authorProjector()
  const projected = createHelperMessageReader({
    readOpen: () => ({chat: {messages: floors}, messageId: 0, playerName: 'P', characterName: 'C'}),
    projectRow: project,
    variablesOf: () => ({})
  })
  assert.deepStrictEqual(plain(projected('0-1')).map(row => row.message_id), [0, 1],
    '作者投影路径同样按位置给 message_id')
  // 单楼读（range=1）时也必须回位置 1，而不是行自带的 999。
  assert.deepStrictEqual(plain(identity(1)).map(row => row.message_id), [1])
})

test('resolve message var 走注入 variablesOf({type:message,message_id,swipe_id})：每行一次、只对选中行', () => {
  const calls = []
  const floors = rawFixture()
  const project = authorProjector()
  const reader = createHelperMessageReader({
    readOpen: () => ({chat: {messages: floors}, messageId: 1, swipeId: 1}),
    projectRow: (floor, messageId) => project(floor, messageId),
    variablesOf: option => { calls.push(option); return {tree: 'RESOLVED-' + option.message_id + 's' + option.swipe_id} },
    copy: value => structuredClone(value)
  })
  const rows = plain(reader('0-2'))
  assert.deepStrictEqual(calls, [
    {type: 'message', message_id: 0, swipe_id: 0},
    {type: 'message', message_id: 1, swipe_id: 1},
    {type: 'message', message_id: 2, swipe_id: 0}
  ], '每行一次、只对选中行、用 {type:message,message_id,swipe_id} 口径解析')
  // 作者的投影行已自带 variables ⇒ 按上游语义**不被外部覆盖**（helper-bootstrap.js:338-339 同源）。
  assert.equal(rows[1].variables.tree, 'm1s1', 'variables 保留作者投影的选中 swipe 树')
  // variablesOf 仍是**必需依赖**（缺它构造即抛），并且只在行缺 variables 时作为兜底来源。
  const noVars = createHelperMessageReader({
    readOpen: () => ({chat: {messages: [{role: 'assistant', swipes: ['x']}]}, messageId: 0}),
    projectRow: floor => floor,
    variablesOf: () => ({tree: 'FALLBACK'})
  })
  assert.equal(plain(noVars(0))[0].variables.tree, 'FALLBACK', '行缺 variables 时由 variablesOf 兜底')
})

test('只读所选行：不 spread 整历史（读 1 行只解析 1 棵树）', () => {
  let calls = 0
  const reader = createHelperMessageReader({
    readOpen: () => ({chat: {messages: rawFixture()}, messageId: 1, swipeId: 0}),
    projectRow: (floor, messageId) => projectRawHelperFloor(floor, messageId),
    variablesOf: () => { calls += 1; return {} }
  })
  reader(0)
  assert.equal(calls, 1, '单楼只解析一棵树')
  calls = 0
  reader('0-0')
  assert.equal(calls, 1, '双端同一楼也只解析一次')
})

test('同步读隔离：返回值改动不污染 raw 行与解析出的树', () => {
  const {floors, ours} = harness()
  const before = JSON.stringify(floors)
  const rows = ours('0-4')
  rows[1].swipes.push('注入')
  rows[1].variables.tree = '被改'
  rows[1].data.tree = '被改'
  rows[1].swipes_data[1].tree = '被改'
  assert.equal(JSON.stringify(floors), before, 'raw 行未被污染')
  assert.equal(plain(ours('0-4'))[1].variables.tree, 'm1s1', '选中 swipe 树未被污染')
  assert.equal(plain(ours('0-4'))[1].swipes_data[0].tree, 'm1s0', '行内 swipes_data 未被污染')
})

test('closed 读抛：readOpen 关闭时本模块不吞异常、不伪空数组', () => {
  const closed = Object.assign(new Error('卡脚本读窗口已关闭（本次结算已结束）'), {code: 'SERVER_EXECUTION_LATE_WRITE'})
  const reader = createHelperMessageReader({
    readOpen: () => { throw closed },
    variablesOf: () => ({})
  })
  assert.throws(() => reader('0-2'), err => err === closed, '原异常须原样抛出')
  assert.throws(() => reader(), err => err.code === 'SERVER_EXECUTION_LATE_WRITE')
})

test('空聊天与缺依赖：空数组/明确 TypeError，不静默造假', () => {
  const empty = createHelperMessageReader({readOpen: () => ({chat: {messages: []}}), variablesOf: () => ({})})
  assert.deepStrictEqual(plain(empty('0-2')), [], '无楼层时与上游一致返回 []')
  assert.deepStrictEqual(plain(empty()), [])
  assert.throws(() => createHelperMessageReader({variablesOf: () => ({})}), /readOpen/)
  assert.throws(() => createHelperMessageReader({readOpen: () => ({})}), /variablesOf/)
  assert.throws(() => createHelperMessageReader(), /readOpen/)
})

test('不自造 last_user/last_char：该语义只存在于上游显示层，不在本读取器', () => {
  const {ours} = harness()
  // 上游 reader 的 range 正则不接受非数字 token ⇒ 这两个串是非法 range，返回 []。
  assert.deepStrictEqual(plain(ours('last_user')), [])
  assert.deepStrictEqual(plain(ours('last_char')), [])
  const moduleSource = readFileSync(new URL('../lib/helper-message-reader.js', import.meta.url), 'utf8')
  assert.equal(moduleSource.includes('last_user'), false, '模块源码不得出现 last_user')
  assert.equal(moduleSource.includes('last_char'), false, '模块源码不得出现 last_char')
})

test('字段来源照实：swipes_info 取 pluginData.swipe_info，extra 缺失为 {}', () => {
  const {ours} = harness()
  const row = plain(ours(1))[0]
  assert.deepStrictEqual(row.swipes_info, [{info: 'i0'}, {info: 'i1'}], 'pluginData.swipe_info 原样投影')
  assert.deepStrictEqual(row.extra, {info: 'i1'}, 'extra 取当前 swipe 的 swipes_info')
  assert.deepStrictEqual(plain(ours(0))[0].swipes_info, [{}], '缺失值为 {}（不编造）')
  assert.deepStrictEqual(plain(ours(0))[0].extra, {}, '缺失值为 {}（不编造）')
})
