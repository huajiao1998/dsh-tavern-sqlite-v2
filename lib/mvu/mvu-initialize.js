// MVU headless 变量初始化（移植自 MagVarUpdate src/function/initvar/variable_init.ts:250-326 与 128-193）
// 纯函数：不读卡、不联网、不碰存储与 UI；世界书与开场白全部由调用方显式注入。
// 上游契约固定：已初始化的书不重放、每本 correctlyMerge 合并、既有运行值胜初始值、
// 开场白 <initvar> 覆盖 stat_data 并按世界书优先重置 initialized_lorebooks。
import _ from '../vendor/lodash/lodash.min.js'
import { clone } from './mvu-clone.js'
import { parseString } from './mvu-parse-string.js'
import { cleanUpMetadata, generateSchema, isObjectSchema } from './mvu-schema.js'

// 上游 util/common.ts:7-9：修正 lodash 对数组的按下标合并 —— 数组整体替换，不做元素级 merge。
function correctlyMerge(lhs, rhs) {
    return _.mergeWith(lhs, rhs, (_lhs, rhsValue) => (_.isArray(rhsValue) ? rhsValue : undefined))
}

// 开场白 <initvar> 块（上游 :155 同一正则，gim 保留大小写不敏感与多块累积）。
const GREETING_INITVAR_PATTERN = /<(initvar)>(?:\s*```.*)?([\s\S]*?)(?:```\s*)?<\/\1>/gim

// [initvar] 条目内容剥离（上游 :273-281）：先剥 XML 包裹，再剥 ``` 代码块；两步都需先 trim。
function stripInitvarEntryContent(content) {
    let text = content.trim()
    const xmlMatch = text.match(/.*<initvar>.*\n([\s\S]*)\n.*<\/initvar>.*/m)
    if (xmlMatch) text = xmlMatch[1]
    const codeblockMatch = text.trim().match(/```.*\n([\s\S]*)\n```/m)
    if (codeblockMatch) text = codeblockMatch[1]
    return text
}

// 结构规范化（上游 :257-266、:46-66）：initialized_lorebooks 旧数组式转对象，缺字段补默认。
function normalizeInitializedLorebooks(value) {
    if (_.isArray(value)) {
        const converted = {}
        for (const name of value) converted[name] = []
        return converted
    }
    if (_.isPlainObject(value)) return value
    return {}
}

// 只校验世界书外壳（name + 是否声明 entries），**不读取 entries 内容**：
// 已记账的书必须能在读完条目之前被跳过（惰性读取是上游 :264 语义的一部分）。
function assertWorldbooks(worldbooks) {
    if (worldbooks === undefined || worldbooks === null) return []
    if (!_.isArray(worldbooks)) {
        throw new Error('worldbooks 必须是已规范化的数组 [{name, entries:[{comment/name,content}]}]')
    }
    for (const entry of worldbooks) {
        if (!_.isPlainObject(entry) || typeof entry.name !== 'string' || entry.name === '') {
            throw new Error('世界书项必须带非空 name（本模块不代读卡/网络）')
        }
        // 刻意不在此处读 entry.entries：entries 可能是惰性取值器，读取即触发真实数据获取，
        // 而已记账的书必须能在读取之前被跳过（上游 :264）。数组形态检查下沉到 assertBookEntries。
    }
    return worldbooks
}

// 条目内容校验放在真正要合并时执行（已跳过的书永不读取）。
function assertBookEntries(book) {
    if (!_.isArray(book.entries)) {
        throw new Error(`世界书 ${book.name} 缺少 entries 数组（不以伪空数据代替真实读取）`)
    }
    for (const item of book.entries) {
        if (!_.isPlainObject(item) || typeof item.content !== 'string') {
            throw new Error(`世界书 ${book.name} 的条目必须带 content 字符串`)
        }
    }
}

// 上游 :262-324：逐书合并 [initvar] 条目；已记账的书整本跳过（不重放）。
async function loadInitVarData(data, worldbooks, { substituteMacros }) {
    let isUpdated = false

    for (const book of worldbooks) {
        const currentLorebook = book.name
        // 上游 :264：已记账的书整本跳过 —— 不重放、不重复合并。
        if (Object.prototype.hasOwnProperty.call(data.initialized_lorebooks, currentLorebook)) continue
        data.initialized_lorebooks[currentLorebook] = []
        assertBookEntries(book)

        const mergedData = {}
        for (const item of book.entries) {
            const comment = item.comment ?? item.name ?? ''
            if (!String(comment).toLowerCase().includes('[initvar]')) continue
            // 先做宏替换再剥壳：宏展开出的 <initvar> / ``` 包裹同样要能被识别。
            const content = stripInitvarEntryContent(substituteMacros(item.content))
            let parsedData = null
            try {
                parsedData = parseString(content)
            } catch (parseError) {
                // 上游 :293-311 记录后 throw：这里同样 strict 上抛，不吞成绿色成功。
                throw new Error(`[initvar] 条目解析失败（${comment || currentLorebook}）：${parseError?.message ?? parseError}`)
            }
            // 上游 :314 的 `if (parsedData)` 会放过「解析成字符串」的残缺 YAML（如 `a: [1,` ⇒ "a: [1,"），
            // 那等于把难以发现的格式错误静默吞掉；这里按用户要求 strict 上抛，不猜作者意图。
            if (typeof parsedData === 'string' || typeof parsedData === 'number' || typeof parsedData === 'boolean') {
                throw new Error(`[initvar] 条目解析结果不是变量对象（${comment || currentLorebook}）：` +
                    `拒绝把残缺内容当作有效初始值`)
            }
            if (parsedData) correctlyMerge(mergedData, parsedData)
        }
        // 上游 :319：现有值覆盖初始值 —— 用户运行中的变量必须胜出。
        data.stat_data = { ...mergedData, ...data.stat_data }
        isUpdated = true
    }

    return isUpdated
}

/**
 * headless 变量初始化（纯函数）。
 * @returns {Promise<{initialized:boolean, result:object}>}
 */
export async function initializeMvuData({
    variables,
    worldbooks,
    greeting = '',
    swipeId = 0,
    primaryBook: suppliedPrimaryBook,
    emit,
    executeCommand,
    substituteMacros,
} = {}) {
    // 初始化前先 clone：输入（含 stat_data）全程不被修改，调用方可安全复用/回滚。
    const data = clone(variables ?? {})
    if (!_.isPlainObject(data)) throw new Error('variables 必须是变量对象')

    const books = assertWorldbooks(worldbooks)
    const subs = typeof substituteMacros === 'function' ? substituteMacros : text => text
    if (emit !== undefined && typeof emit !== 'function') throw new Error('emit 必须是函数')
    if (greeting !== undefined && greeting !== null && typeof greeting !== 'string') {
        throw new Error('greeting 必须是字符串（本模块不代读卡）')
    }

    data.initialized_lorebooks = normalizeInitializedLorebooks(data.initialized_lorebooks)
    if (!_.isPlainObject(data.stat_data)) data.stat_data = {}
    if (!_.isPlainObject(data.schema)) data.schema = { extensible: false, properties: {}, type: 'object' }

    const greetingText = typeof greeting === 'string' ? greeting : ''
    const explicitPrimary = typeof suppliedPrimaryBook === 'string' && suppliedPrimaryBook !== '' ? suppliedPrimaryBook : undefined
    // greeting override 生效时需要主世界书名：显式字段优先；否则取注入书列表首项。两者皆无则不猜。
    const primaryBook = explicitPrimary ?? books[0]?.name

    let isUpdated = await loadInitVarData(data, books, { substituteMacros: subs })

    let greetingInitvarApplied = false
    const greetingInitvars = [...greetingText.matchAll(GREETING_INITVAR_PATTERN)]
    if (greetingInitvars.length > 0 && (isUpdated || !variables?.schema)) {
        const overriddenInitvar = {}
        for (const match of greetingInitvars) {
            const parsed = parseString(subs(match[2]))
            if (!_.isPlainObject(parsed)) throw new Error('开场白 initvar 必须解析为变量对象，拒绝残缺内容')
            correctlyMerge(overriddenInitvar, parsed)
        }
        // 上游 :176-186：开场白 <initvar> 以自身为基准，忽略角色世界书的 [initvar]，
        // 并把 initialized_lorebooks 重置为「仅主世界书」，随后重放其余世界书。
        data.stat_data = overriddenInitvar
        data.initialized_lorebooks = {}
        if (primaryBook) {
            data.initialized_lorebooks[primaryBook] = []
        } else {
            // 无主世界书可锚定：不伪造记账项，仅清账本后按上游顺序重放。
            data.initialized_lorebooks = {}
        }
        greetingInitvarApplied = true
        await loadInitVarData(data, books, { substituteMacros: subs })
        isUpdated = true
    }

    // schema：以 clone 生成，generateSchema 会消费克隆体里的 $meta/魔法标记。
    if (isUpdated || !data.schema || _.isEmpty(data.schema)) {
        const dataForSchema = clone(data.stat_data)
        const generatedSchema = generateSchema(dataForSchema, data.schema)
        if (isObjectSchema(generatedSchema)) {
            if (_.has(data.stat_data, '$meta.strictTemplate')) {
                generatedSchema.strictTemplate = data.stat_data['$meta']?.strictTemplate
            }
            if (_.has(data.stat_data, '$meta.concatTemplateArray')) {
                generatedSchema.concatTemplateArray = data.stat_data['$meta']?.concatTemplateArray
            }
            if (_.has(data.stat_data, '$meta.strictSet')) {
                generatedSchema.strictSet = data.stat_data['$meta']?.strictSet
            }
            data.schema = generatedSchema
        }
    }

    // 魔法字符串清理只作用于本模块拥有的 data（上游 :122-124）。
    if (isUpdated) cleanUpMetadata(data.stat_data)

    // 上游顺序：初始化事件先于开场白命令，事件里注册的 schema/派生字段可供命令使用。
    let emitted = 0
    if (isUpdated && typeof emit === 'function') {
        await emit(data, swipeId)
        emitted = 1
    }
    let executedCommands = 0
    if (typeof executeCommand === 'function' && greetingText !== '') {
        const handled = await executeCommand(greetingText, data, emit)
        if (handled !== false && handled !== undefined && handled !== null) executedCommands = 1
    }

    return {
        initialized: isUpdated,
        result: {
            variables: data,
            statData: data.stat_data,
            schema: data.schema,
            initializedLorebooks: data.initialized_lorebooks,
            updated: isUpdated,
            emitted,
            greetingInitvarApplied,
            executedCommands,
        },
    }
}
