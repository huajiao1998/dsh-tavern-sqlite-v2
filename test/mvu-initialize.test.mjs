// MVU headless 变量初始化定向验证（本文件独占；不改其余源码/manifest/deploy/runtime）。
//
// 覆盖 6 项（纯原创夹具，不读真实卡/档，不联网，不跑全量）：
//   ① 世界书 [initvar] 来源 + 开场白 <initvar> 覆盖 + 世界书优先重置
//   ② schema 生成正确（含 meta 清理与数组整体替换语义）
//   ③ 已 initialized_lorebooks 的书不重复初始化
//   ④ 保留既有运行变量（用户值胜初始值）
//   ⑤ substituteMacros / executeCommand 回调真实被调用
//   ⑥ 非法输入中止，且失败时输入变量保持原值
//
// lib/mvu 下无 node_modules：lodash/yaml/json5/jsonrepair 只读借既有冻结核心依赖（tools/mvu-server-core），
// 沿用 test/upstream-event-contract.test.mjs:21-37 的 registerHooks 短路法，不安装依赖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CORE_PACKAGE = new URL('../../../tools/mvu-server-core/package.json', import.meta.url)
if (!existsSync(fileURLToPath(CORE_PACKAGE))) {
    throw new Error('缺少本地冻结核心依赖 tools/mvu-server-core/package.json：拒绝在无真实 lodash 时弱化断言')
}
const coreRequire = createRequire(CORE_PACKAGE)
const RESOLVED = new Map()
for (const name of ['lodash', 'yaml', 'json5', 'jsonrepair']) {
    try { RESOLVED.set(name, pathToFileURL(coreRequire.resolve(name)).href) } catch { /* 由依赖闸点名 */ }
}
registerHooks({
    resolve(specifier, context, next) {
        if (RESOLVED.has(specifier)) return { url: RESOLVED.get(specifier), shortCircuit: true }
        return next(specifier, context)
    },
})

const { initializeMvuData } = await import(new URL('../lib/mvu/mvu-initialize.js', import.meta.url))

// 夹具：两本世界书，条目 comment 带 [initvar]，内容分别为 YAML 与 codefence JSON。
// entries 走取值器：未记账的书被读取时才计数（供 ③ 判定「是否重放」）。
const BOOK_ENTRIES = {
    主书: [
        { comment: '[initvar] 基础', content: 'hp: 100\nmp: 50\n队伍: [甲, 乙]' },
        { comment: '无关条目', content: 'hp: 999' },
    ],
    全局书: [
        { comment: '[InitVar] 附加', content: '```json\n{"金币": 7, "队伍": ["丙"]}\n```' },
    ],
}
const worldbooks = () => Object.keys(BOOK_ENTRIES).map(name => ({
    name,
    get entries() { return BOOK_ENTRIES[name] },
}))

const greetingWithInitvar = '开场白正文\n<initvar>\n```yaml\nhp: 5\n状态: 覆盖\n```\n</initvar>\n结束'

test('① 世界书 [initvar] + 开场白覆盖 + 世界书优先重置', async () => {
    const emitted = []
    const base = { stat_data: {}, schema: {}, initialized_lorebooks: {} }
    const { result } = await initializeMvuData({
        variables: base,
        worldbooks: worldbooks(),
        greeting: greetingWithInitvar,
        swipeId: 3,
        emit: async (data, id) => emitted.push({ stat_data: data.stat_data, id }),
    })

    // 开场白 <initvar> 以自身为基准：hp 为覆盖值、状态来自开场白，世界书的 mp 被忽略。
    assert.equal(result.statData.hp, 5, '开场白 <initvar> 必须覆盖世界书初始值')
    assert.equal(result.statData['状态'], '覆盖', '开场白非 YAML 常规键也要生效')
    assert.equal(result.statData.mp, undefined, '开场白覆盖后世界书 [initvar] 内容被忽略')
    assert.equal(result.greetingInitvarApplied, true)
    // 世界书优先重置：账本重置为仅主书，其余书重放后回到账本。
    assert.deepEqual(Object.keys(result.initializedLorebooks).sort(), ['主书', '全局书'].sort(), '重置后重放其余世界书')
    assert.equal(result.emitted, 1, '真实初始化仅 emit 一次')
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].id, 3, 'emit 必须回传 swipeId')
})

test('② schema 正确生成且数据 meta 已清理', async () => {
    const { result } = await initializeMvuData({
        variables: { stat_data: {}, schema: {}, initialized_lorebooks: {} },
        worldbooks: [
            { name: '书', entries: [{ comment: '[initvar] 数据', content: 'hp: 1\n队伍:\n  - 甲\n  - 乙\n配置:\n  $meta:\n    extensible: true\n  键: 值' }] },
        ],
        greeting: '',
    })
    const schema = result.schema
    assert.equal(schema.type, 'object', '根 schema 必须是 object')
    assert.equal(schema.properties.hp.type, 'number', 'hp 推为 number')
    assert.equal(schema.properties['队伍'].type, 'array', '数组字段推为 array')
    assert.equal(schema.properties['队伍'].elementType.type, 'string', '数组元素类型正确')
    assert.equal(schema.properties['配置'].properties['键'].type, 'string', '嵌套对象属性生成')
    assert.equal(result.statData['配置'].$meta, undefined, '数据里的 $meta 必须被清理')
})

test('③ 已 initialized_lorebooks 的书不重复初始化', async () => {
    let reads = 0
    const counting = Object.keys(BOOK_ENTRIES).map(name => ({
        name,
        get entries() { reads++; return BOOK_ENTRIES[name] },
    }))
    const { initialized, result, } = await initializeMvuData({
        variables: { stat_data: { hp: 42 }, schema: {}, initialized_lorebooks: { 主书: [], 全局书: [] } },
        worldbooks: counting,
        greeting: '',
    })
    assert.equal(reads, 0, '两本都已记账 ⇒ 不得再读条目内容')
    assert.equal(result.statData.hp, 42, '不重放时不变更既有数据')
    assert.equal(result.emitted, 0, '无真实变化 ⇒ 不发事件')
    void initialized
})

test('④ 保留既有运行变量（用户值胜初始值）', async () => {
    const { result } = await initializeMvuData({
        variables: { stat_data: { hp: 3, 仅存于运行: true }, schema: {}, initialized_lorebooks: {} },
        worldbooks: worldbooks(),
        greeting: '',
    })
    assert.equal(result.statData.hp, 3, '既有运行值必须覆盖世界书初始值')
    assert.equal(result.statData['仅存于运行'], true, '既有独有变量必须保留')
    assert.equal(result.statData['金币'], 7, '未冲突的初始值正常并入')
    // 上游 :319 的 `{...merged_data, ...stat_data}` 是「逐本合并 + 现有值胜出」：
    // 主书先写入 队伍，随后它已成为「现有值」，故全局书的 队伍 不能覆盖它。
    assert.deepEqual(result.statData['队伍'], ['甲', '乙'], '先合并的书成为现有值，按其胜出（上游 :319 语义）')

    // 同一本内两条 [initvar] 累积时才真正考验 correctlyMerge：数组必须整体替换而非按下标合并。
    const sameBook = await initializeMvuData({
        variables: { stat_data: {}, schema: {}, initialized_lorebooks: {} },
        worldbooks: [{
            name: '书',
            entries: [
                { comment: '[initvar] 一', content: '队伍: [甲, 乙]\nhp: 100' },
                { comment: '[initvar] 二', content: '队伍: [丙]' },
            ],
        }],
        greeting: '',
    })
    assert.deepEqual(sameBook.result.statData['队伍'], ['丙'], '数组整体替换，不得残留 [甲,乙]')
    assert.equal(sameBook.result.statData.hp, 100, '未冲突键正常累积')
})

test('⑤ substitueMacros 与 executeCommand 回调真实生效', async () => {
    const seenMacros = []
    const commands = []
    const { result } = await initializeMvuData({
        variables: { stat_data: {}, schema: {}, initialized_lorebooks: {} },
        worldbooks: [{ name: '书', entries: [{ comment: '[initvar] 宏', content: '名字: "{{user}}"' }] }],
        greeting: '正文 /hp+1',
        swipeId: 0,
        substituteMacros: text => { seenMacros.push(text); return text.replace('{{user}}', '旅人') },
        executeCommand: async (text, variables, emit) => { commands.push({ text, variables, emit }); return true },
    })
    assert.deepEqual(seenMacros, ['名字: "{{user}}"'], 'substituteMacros 必须收到条目原文')
    assert.equal(result.statData['名字'], '旅人', '宏替换结果必须进入变量')
    assert.equal(commands.length, 1, 'executeCommand 必须被调用一次')
    assert.equal(commands[0].text, '正文 /hp+1', '变量指令取开场白文本')
    assert.equal(commands[0].variables, result.variables, '指令作用于同一变量对象')
    assert.equal(result.executedCommands, 1)
})

test('⑦ 初始化严格先于 executeCommand（上游 188/191 顺序）且 primaryBook 走显式 input', async () => {
    // 顺序：emit（初始化事件）必须先于 executeCommand（开场白命令）——上游 :188 先 `await eventOn`
    // 再在 :191 走命令；反序会让命令看不到初始化注册的 schema/派生字段。
    const order = []
    const { result } = await initializeMvuData({
        variables: { stat_data: {}, schema: {}, initialized_lorebooks: {} },
        worldbooks: worldbooks(),
        greeting: '正文 /set',
        swipeId: 1,
        emit: async (data) => { order.push({ at: 'emit', hp: data.stat_data.hp }) },
        executeCommand: async (text, data) => { order.push({ at: 'executeCommand', hp: data.stat_data.hp }); return true },
    })
    // 严格顺序 + 状态可见性：命令必须已能看到初始化写入的变量（emit 时 hp 已就位）。
    assert.deepEqual(order.map(x => x.at), ['emit', 'executeCommand'],
        '初始化事件必须严格早于开场白命令（上游 188 先于 191）')
    assert.equal(order[0].hp, 100, 'emit 时必须已装载世界书初始值')
    assert.equal(order[1].hp, 100, '命令必须看到初始化后的同一份变量')
    assert.equal(result.emitted, 1, '先初始化后命令')

    // primaryBook 是**显式 input**：reset 账本必须锚定调用方给的主书，且不得偷读 data.primaryBook。
    const { result: r } = await initializeMvuData({
        variables: { stat_data: {}, schema: {}, initialized_lorebooks: {}, primaryBook: '被偷的书' },
        worldbooks: worldbooks(),
        greeting: greetingWithInitvar,
        primaryBook: '全局书',
    })
    assert.deepEqual(Object.keys(r.initializedLorebooks).sort(), ['主书', '全局书'].sort(),
        'reset 后仍按主书锚定再重放其余书')
    assert.equal(Object.hasOwn(r.initializedLorebooks, '被偷的书'), false,
        '不得从 variables.primaryBook 偷取主书名（必须用显式 input）')

    // 端到端区分：显式 input 与 data 内同名字段不同，结果必须只认显式 input。
    const { result: probe } = await initializeMvuData({
        variables: { stat_data: {}, schema: {}, initialized_lorebooks: {} },
        worldbooks: [{ name: '显式主书', entries: [{ comment: '[initvar] x', content: 'a: 1' }] },
            { name: '末位书', entries: [{ comment: '[initvar] y', content: 'b: 2' }] }],
        greeting: greetingWithInitvar,
        primaryBook: '显式主书',
    })
    assert.equal(Object.hasOwn(probe.initializedLorebooks, '显式主书'), true,
        '显式 primaryBook 必须是 reset 的锚点')
    assert.equal(probe.statData.hp, 5, '开场白覆盖仍生效')
})

test('⑥ 非法输入中止且输入变量保持原值', async () => {
    const input = { stat_data: { hp: 9 }, schema: {}, initialized_lorebooks: {} }
    const snapshot = JSON.stringify(input)

    await assert.rejects(
        initializeMvuData({ variables: input, worldbooks: '不是数组' }),
        /worldbooks 必须是已规范化的数组/,
        'worldbooks 形态非法必须中止',
    )
    await assert.rejects(
        initializeMvuData({ variables: input, worldbooks: [{ name: '书' }] }),
        /缺少 entries 数组/,
        '世界书缺 entries 不得以伪空数据继续',
    )
    await assert.rejects(
        initializeMvuData({
            variables: input,
            worldbooks: [{ name: '书', entries: [{ comment: '[initvar] 坏内容', content: 'a: *未定义锚点' }] }],
        }),
        /\[initvar\] 条目解析失败/,
        '上游遇解析错 strict throw，不得吞成绿色',
    )
    // 解析成标量的合法内容不是变量对象：上游 `if (parsedData)` 会静默跳过，
    // 这里必须点名上抛，否则「写错层级」永远不可见（例如整条只写了一个 URL）。
    await assert.rejects(
        initializeMvuData({
            variables: input,
            worldbooks: [{ name: '书', entries: [{ comment: '[initvar] 标量', content: 'https://example.invalid/说明' }] }],
        }),
        /条目解析结果不是变量对象/,
        '标量内容必须 strict 上抛，不得当有效初始值',
    )

    assert.equal(JSON.stringify(input), snapshot, '失败路径不得修改输入变量')
    assert.deepEqual(input.initialized_lorebooks, {}, '失败路径不得留下账本污染')

    // 成功路径同样不修改输入（初始化前 clone）。
    const okInput = { stat_data: { hp: 1 }, schema: {}, initialized_lorebooks: {} }
    const okSnapshot = JSON.stringify(okInput)
    await initializeMvuData({ variables: okInput, worldbooks: worldbooks(), greeting: '' })
    assert.equal(JSON.stringify(okInput), okSnapshot, '成功路径也不得修改输入变量')
})
