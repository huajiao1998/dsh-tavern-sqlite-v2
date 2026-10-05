// Tavern Helper 只读 API 包装层：macro / regex / version / script-buttons / 只读 slash 管道。
//
// 权威基线（逐字照作者源码，不猜）：
//   · macro     src/client/runtime/helper-macro-api.js:28-52 `installTavernHelperMacroApi`（53 行，纯计算）
//   · regex     lib/domain/tavern-helper-regex-api.js:3-74 `installTavernHelperRegexApi(options)`
//               DI 契约：`{window, context, createEngine}`；`createEngine()` 必须返回
//               `{applyTavernRegexText, renderTavernRegexDisplay}`（lib/domain/tavern-regex-engine.js:168）
//   · version   src/client/runtime/helper-bootstrap.js:747 `window.getTavernHelperVersion = () => "4.8.19"`
//   · buttons   src/client/runtime/helper-bootstrap.js:432-441 `getAllEnabledScriptButtons`
//               + :291-303 `stringHash` / :303 `buttonEvent(name, scriptId)`
//               —— 真值来源是 `binding.resourceSnapshot.scriptProjection`（= 作者
//               `lib/domain/tavern-helper-scripts.js:18-46 projectTavernHelperScripts` 的产出，
//               `scripts[].{id,name,buttons,buttonsEnabled}`；`failed` 由运行时置位）。
//   · slash     lib/client.js:10918-10995 `decodeSlashText` / `readPipeline` / `executeReadPipeline`
//               （无 IO、仅抛 `code="UNSUPPORTED_SLASH_PIPELINE"`；执行期只读 `getTavernHelperWorldbook`）
//   · 世界书读   helper-bootstrap.js:544-555 `getWorldbook(name)`；本包 host.getWorldbook(sessionId,name,false)
//
// 边界（用户明确，不得越界）：
//   · 只读：本模块**不写**变量/正则/世界书/消息，不含任何保存入口。
//   · DOM / display（`getMessageId` / `getIframeName` / `retrieveDisplayedMessage` /
//     `formatAsDisplayedMessage`）**不做服务端假 facade** —— 它们是浏览器特权对象，
//     服务端没有真实 DOM/iframe 时调用即 unsupported。
//   · 生成（`/send`+`/trigger`、`/cut`）明确 unsupported，不静默当只读管道吞掉。
//   · 第三方缺 DI 时**抛错**，不返回伪空值（不伪装成"没有正则/没有世界书"）。

const MACRO_IDENTITY = /{{\s*(user|char|lastMessageId|messageId)\s*}}/gi
const MACRO_VARIABLE = /{{\s*(getvar|getglobalvar|get_(message|chat|character|global)_variable)\s*::\s*([^{}]*?)\s*}}/gi
const DANGEROUS_PATH_PARTS = ['__proto__', 'constructor', 'prototype']

/** 结构脱离：只重建骨架，原始标量按引用共享（§五.2 判据，不做整档文本往返）。 */
export function copyHelperReadonlyJson(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(copyHelperReadonlyJson)
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = copyHelperReadonlyJson(item)
  return result
}

/** 上游 helper-bootstrap.js:314-319 `normalizeId`：非有限数回落 lastId、负数从尾部数、clamp。 */
function normalizeMessageId(value, lastId) {
  let id = Number(value)
  if (!Number.isFinite(id)) id = lastId
  if (id < 0) id = lastId + 1 + id
  return Math.max(0, Math.min(lastId, id))
}

/**
 * 上游 helper-bootstrap.js:291-303 `stringHash` —— 逐字等价（32 位 imul/mulberry 混合，返回双精度整数）。
 * `buttonEvent` 用它对按钮名取哈希。
 */
function helperStringHash(value, seed) {
  if (typeof value !== 'string') return 0
  let h1 = 0xdeadbeef ^ (Number(seed) || 0), h2 = 0x41c6ce57 ^ (Number(seed) || 0)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * 上游 helper-bootstrap.js:303 `buttonEvent(name, scriptId)`
 * —— `String(scriptId || currentScript().id) + "_" + stringHash(String(name || ""))`。
 * 服务端不猜格式：本函数逐字复刻该表达式（scriptId 由调用方给出投影里的 `script.id`）。
 */
export function helperButtonEvent(name, scriptId) {
  return String(scriptId || '') + '_' + helperStringHash(String(name || ''))
}

/**
 * 作者 macro 算法（helper-macro-api.js:4-45）的纯计算等价实现。
 *
 * 与作者逐条对齐：
 *   · `readPath` 同正则、同**毒 key 拦截**（`__proto__`/`constructor`/`prototype` 直接 undefined）；
 *   · `publicValue` 同"过滤 `$` 前缀 key + 环检测返回 null"；
 *   · `asText` 同"对象 JSON.stringify、失败空串"；
 *   · `{{user|char|lastMessageId|messageId}}` 与 `{{getvar|getglobalvar|get_(scope)_variable::path}}` 同优先级；
 *   · **未知写 macro 保持 literal**（作者只 replace 这两个模式，其余原样留在字符串里）。
 * 差异（本包口径，非作者）：变量表由注入的 `getVariables` 提供（作者读 `window.getVariables`）。
 */
function createMacroRenderer({ readOpen, getVariables, getCurrentMessageId, getLastMessageId, state }) {
  function readPath(value, path) {
    const parts = []
    String(path).replace(/[^.[\]]+|\[(?:(["'])((?:(?!\1)[^\\]|\\.)*)\1|([^\]]+))\]/g,
      (token, quote, quoted, unquoted) => { parts.push(quote ? quoted.replace(/\\([\\"'])/g, '$1') : unquoted === undefined ? token : unquoted) })
    let current = value
    for (const part of parts) {
      if (DANGEROUS_PATH_PARTS.includes(part) || current == null || !Object.prototype.hasOwnProperty.call(Object(current), part)) return undefined
      current = current[part]
    }
    return current
  }
  function publicValue(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return null
    seen.add(value)
    const result = Array.isArray(value) ? value.map(item => publicValue(item, seen))
      : Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')).map(([key, item]) => [key, publicValue(item, seen)]))
    seen.delete(value)
    return result
  }
  function asText(value) {
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') { try { return JSON.stringify(value) } catch (_) { return '' } }
    return String(value)
  }
  return function substitudeMacros(input, options = {}) {
    // 同步读口必须走结算窗口：关闭时**抛**（与本包 helper-message-reader / tavern-helper-api 同口径），
    // 不吞异常、不返回看似正常的原文（那会把"已关窗"伪装成"没有宏"）。
    const live = state(readOpen())
    const id = options.message_id === undefined ? getCurrentMessageId() : options.message_id
    return String(input ?? '').replace(MACRO_IDENTITY, (_match, name) => {
      switch (name.toLowerCase()) {
        case 'user': return String(live.playerName || '你')
        case 'char': return String(options.character_name ?? live.characterName ?? live.character?.name ?? '角色')
        case 'lastmessageid': return String(getLastMessageId() ?? -1)
        default: return String(id ?? -1)
      }
    }).replace(MACRO_VARIABLE, (_match, command, scope, path) => {
      // 作者 :40 —— 带 scope 的命令用 scope；`getvar`/`getglobalvar` 无 scope 时 getglobalvar→global、否则→chat。
      const type = scope?.toLowerCase() || (command.toLowerCase() === 'getglobalvar' ? 'global' : 'chat')
      const option = type === 'message' ? { type, message_id: id } : { type }
      const value = readPath(getVariables(option), path)
      // 作者 :44 —— 有 scope 时过 `publicValue`（滤 `$` key、环→null），无 scope 时原值。
      return asText(scope ? publicValue(value) : value)
    })
  }
}

/** 作者 readPipeline 的逐字等价解析（lib/client.js:10915-10968）——无 IO、不 reparse。 */
function createSlashReader({ getWorldbook }) {
  function slashError(message) {
    return Object.assign(new Error(message), { code: 'UNSUPPORTED_SLASH_PIPELINE' })
  }
  // 作者 :10918 —— 去引号仅当首尾同引号，再解 `\\ \| \" \'` 四类转义。
  function decodeSlashText(value) {
    let text = String(value).trim()
    if ((text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) text = text.slice(1, -1)
    return text.replace(/\\([\\|"'])/g, '$1')
  }
  // 作者 :10923-10968 —— 引号/转义感知的 `|` 切分，**不是** `split('|')`；切分后逐段整段匹配命令。
  function readPipeline(line) {
    const source = String(line)
    const stages = []
    let start = 0, quote = '', escaped = false
    for (let i = 0; i < source.length; i++) {
      const ch = source[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (quote) { if (ch === quote) quote = ''; continue }
      if ((ch === '"' || ch === "'") && (i === start || /[\s=]/.test(source[i - 1]))) { quote = ch; continue }
      if (ch === '|') { stages.push(source.slice(start, i).trim()); start = i + 1 }
    }
    if (quote) throw slashError('人物卡命令引号未闭合')
    stages.push(source.slice(start).trim())
    return stages.map(stage => {
      const match = /^\/(pass|return|findentry|findlore|findwi)(?:\s+([\s\S]*))?$/i.exec(stage)
      if (!match) throw slashError('暂不支持这条人物卡命令管道；/pass 和 /findentry 只能与只读命令组合，未发送消息')
      const command = match[1].toLowerCase()
      let text = match[2] || ''
      if (command === 'pass' || command === 'return') return { command: 'pass', text: decodeSlashText(text) }
      const args = {}
      for (;;) {
        const named = /^([a-zA-Z_]\w*)=/.exec(text)
        if (!named) break
        const key = named[1]
        if (!['file', 'field'].includes(key) || Object.hasOwn(args, key)) throw slashError('不支持或重复的 /findentry 参数: ' + key)
        text = text.slice(named[0].length)
        let end = 0
        if (text[0] === '"' || text[0] === "'") {
          const inner = text[0]
          end = 1
          for (; end < text.length; end++) {
            if (text[end] === '\\') { end++; continue }
            if (text[end] === inner) { end++; break }
          }
          if (end < text.length && !/\s/.test(text[end])) throw slashError('/findentry 引号后需要空格')
        } else {
          while (end < text.length && !/\s/.test(text[end])) end++
        }
        args[key] = decodeSlashText(text.slice(0, end))
        text = text.slice(end).trimStart()
      }
      const field = args.field || 'key'
      if (!args.file) throw slashError('/findentry 需要 file=当前世界书名称（或 current）')
      if (!['key', 'keysecondary', 'comment', 'name', 'content', 'uid'].includes(field)) throw slashError('暂不支持 /findentry 字段: ' + field)
      return { command: 'findentry', file: args.file, field, text: decodeSlashText(text) }
    })
  }
  /** 作者 :10969-10995 —— 有界只读执行：**先整条管道预校验**，再逐段取书；只读不改写。 */
  async function executeReadPipeline(line, sessionId) {
    const stages = readPipeline(line)
    let pipe = ''
    for (const stage of stages) {
      const text = stage.text.replace(/\{\{pipe\}\}/gi, () => pipe)
      if (stage.command === 'pass') { pipe = text; continue }
      const file = stage.file.replace(/\{\{pipe\}\}/gi, () => pipe)
      const entries = await getWorldbook(sessionId, file)
      const query = text.toLowerCase()
      let found = null, best = Infinity
      for (const entry of Array.isArray(entries) ? entries : []) {
        const value = stage.field === 'key' ? entry?.strategy?.keys
          : stage.field === 'keysecondary' ? entry?.strategy?.keys_secondary?.keys
            : stage.field === 'comment' ? entry?.name : entry?.[stage.field]
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item === undefined || item === null || !query) continue
          const candidate = String(item).toLowerCase()
          const position = candidate.indexOf(query)
          // 作者 :10988 —— 精确匹配优先，其次子串；同分保持书内顺序（严格小于才替换）。
          const score = candidate === query ? 0 : position < 0 ? Infinity : 1 + position + (candidate.length - query.length) / (candidate.length + 1)
          if (score < best) { best = score; found = entry }
        }
      }
      pipe = found?.uid === undefined ? '' : String(found.uid)
    }
    return pipe
  }
  return { readPipeline, executeReadPipeline, slashError }
}

function unsupported(name, reason) {
  const error = new Error('服务端未支持 Tavern Helper API "' + name + '"' + (reason ? '：' + reason : ''))
  error.code = 'DSH_TAVERN_SERVER_UNSUPPORTED_API'
  throw error
}

/**
 * 创建只读 Tavern Helper API。
 *
 * @param {object} deps
 * @param {() => object} deps.readOpen            同步读当前结算窗口（关闭时**抛**，本模块不吞）；
 *   返回值须带 `sessionId` 等 live 字段（`state` 由 `options.state(open)` 从它派生）
 * @param {(option: object) => object} deps.getVariables  按 `{type,message_id,script_id}` 读变量树
 * @param {() => number} deps.getCurrentMessageId 当前楼
 * @param {() => number} deps.getLastMessageId    最后一楼
 * @param {() => object} deps.options             可选；返回 `{state, installRegexApi, createRegexEngine, engine, getVersion}`
 *   —— `state(open)` 收到 **`readOpen()` 的 live 回执**，须返回
 *   `{playerName, characterName, character, messages|messagesLength, regexScripts, macro, names, scriptProjection}`
 * @param {object} deps.host                      可选；`{getWorldbook(sessionId,name,false), getWorldbookEntries?}`
 * @returns 只读 API 对象（无任何写/保存入口，也不暴露内部计划/投影结构）
 */
export function createHelperReadonlyApi({ readOpen, getVariables, getCurrentMessageId, getLastMessageId, options = {}, host = {} } = {}) {
  for (const [name, value] of Object.entries({ readOpen, getVariables, getCurrentMessageId, getLastMessageId })) {
    if (typeof value !== 'function') throw new TypeError('只读Helper API依赖缺失：' + name)
  }
  const resolved = options && typeof options === 'object' ? options : {}
  // `state()` 只接受 `readOpen()` 的 live 回执；**签名不带参数**的旧用法（测试 fake）也照常工作。
  // 关键：**不在这里调 readOpen** —— 窗口检查一律留到各方法 wrapper 内（闭窗时 state() 不被触碰）。
  const state = open => {
    const raw = typeof resolved.state === 'function' ? resolved.state(open) : null
    return raw && typeof raw === 'object' ? raw : (open && typeof open === 'object' ? open : {})
  }
  const substitudeMacros = createMacroRenderer({ readOpen, getVariables, getCurrentMessageId, getLastMessageId, state })
  // 本档世界书只读：`host.getWorldbook(current.sessionId, name, false)` —— 不共享跨档缓存、不写。
  async function readWorldbookEntries(sessionId, name) {
    if (typeof host.getWorldbook !== 'function') unsupported('getWorldbook', '缺少真实宿主接线（host.getWorldbook）')
    const result = await host.getWorldbook(sessionId, String(name), false)
    if (!Array.isArray(result?.worldbook?.entries)) throw new TypeError('世界书宿主返回缺少 worldbook.entries：' + String(name))
    return result.worldbook.entries
  }
  const slash = createSlashReader({
    // sessionId/name 必须取**本次调用**的 live 值，不能在工厂时快照。
    getWorldbook: (sessionId, name) => readWorldbookEntries(sessionId, name),
  })

  // —— regex：**调用作者 installer**（不复制 engine、不重写正则算法）——
  // 第三方缺 DI 必须响亮失败，不许伪空正则列表。
  // ⚠️ 每次方法调用**先过 readOpen()**（窗口检查留在 wrapper 内，不在工厂期），
  //    再把 open 交给 state(open) 取 live 卡/脚本；作者 installer 的 `context` 是**函数**，
  //    每次读都得是当次 open 的派生值（不快照、不缓存跨次状态）。
  function regexBinding() {
    const open = readOpen()
    const engine = typeof resolved.createRegexEngine === 'function' ? resolved.createRegexEngine() : resolved.engine
    // 作者 lib/client.js:4008-4097 / :4174-4176 —— `createEngine()` 必须给出 applyTavernRegexText。
    if (!engine || typeof engine.applyTavernRegexText !== 'function') {
      throw new TypeError('正则engine依赖缺失：需要作者 createTavernRegexEngine() 或 {applyTavernRegexText}')
    }
    if (typeof resolved.installRegexApi !== 'function') {
      throw new TypeError('正则installer依赖缺失：需要作者 installTavernHelperRegexApi')
    }
    const target = {}
    // 作者 installer 会读 `target.substitudeMacros` 做第二步宏替换（:62-65）；喂只读 renderer，
    // 使 regex→macro 链路与浏览器侧同序且仍是只读纯计算。
    target.substitudeMacros = substitudeMacros
    resolved.installRegexApi({ window: target, context: () => state(open), createEngine: () => engine })
    return target
  }

  /**
   * 上游 helper-bootstrap.js:432-441 `getAllEnabledScriptButtons` 的只读投影。
   * 真值来源：`binding.resourceSnapshot.scriptProjection`（作者 projectTavernHelperScripts 产出）。
   * 规则逐字对齐：
   *   · `script.buttonsEnabled === false || script.failed` ⇒ 整脚本跳过（:435）；
   *   · 只取 `button && button.visible === true`（:436）；
   *   · 每项 `{ button_id: buttonEvent(button.name, script.id), button_name: button.name }`（:437）；
   *   · 空数组不建键（:438）；返回结构脱离副本（:440 `copy`）。
   * **无投影 ⇒ unsupported**（响亮失败，不伪空 `{}`）。
   */
  function projectScriptButtons() {
    const projection = state(readOpen()).scriptProjection
    if (!projection || !Array.isArray(projection.scripts)) {
      unsupported('getAllEnabledScriptButtons', '卡脚本按钮投影未接线（resourceSnapshot.scriptProjection）')
    }
    const result = {}
    for (const script of projection.scripts) {
      if (!script || script.buttonsEnabled === false || script.failed) continue
      const buttons = (Array.isArray(script.buttons) ? script.buttons : [])
        .filter(button => button && button.visible === true)
        .map(button => ({ button_id: helperButtonEvent(button.name, script.id), button_name: button.name }))
      if (buttons.length) {
        Object.defineProperty(result, String(script.id), { value: buttons, enumerable: true, configurable: true, writable: true })
      }
    }
    return copyHelperReadonlyJson(result)
  }

  const api = {
    // —— macro（同步、只读）——
    substitudeMacros,
    substituteMacros: substitudeMacros,

    // —— regex（作者 installer 生产）——
    isCharacterTavernRegexesEnabled: () => regexBinding().isCharacterTavernRegexesEnabled(),
    formatAsTavernRegexedString: (value, source, destination, settings) =>
      regexBinding().formatAsTavernRegexedString(value, source, destination, settings),

    // —— version：作者真值（helper-bootstrap.js:747），未接线时明确 unavailable，不猜版本号 ——
    getTavernHelperVersion: () => {
      readOpen()
      return typeof resolved.getVersion === 'function' ? resolved.getVersion() : unsupported('getTavernHelperVersion', '作者版本值未接线（options.getVersion）')
    },

    // —— script buttons：只读投影（helper-bootstrap.js:432-441），过滤 visible===true，不触 DOM ——
    getAllEnabledScriptButtons: projectScriptButtons,

    // —— 只读 slash 管道：预校验整条管道；生成类命令（/send/|/trigger、/cut）明确拒绝 ——
    async triggerSlash(line) {
      const text = String(line ?? '')
      readOpen()
      if (/^\s*\/(?:pass|return|findentry|findlore|findwi)(?:\s|$)/i.test(text)) {
        const result = await slash.executeReadPipeline(text, readOpen().sessionId)
        readOpen()
        return result
      }
      // 作者 lib/client.js:11011-11018 —— 非只读管道在**提交消息之前**预检拒绝，不 reparse。
      // 注意：作者的 `slashError` 是**构造并返回** Error（:10915-10917），调用处必须 `throw`。
      if (/^\/cut(?:\s|$)/.test(text)) throw slash.slashError('暂不支持人物卡命令管道中的 /cut，未发送消息。当前仅支持只读管道')
      if (/^\/send\s/i.test(text) || /^\s*\/trigger\s*$/i.test(text)) {
        throw slash.slashError('暂不支持人物卡命令管道中的生成命令，未发送消息。服务端只读层不执行 /send | /trigger')
      }
      throw slash.slashError('暂不支持这条人物卡命令管道，未发送消息。服务端只读层仅支持 /pass|/return|/findentry|/findlore|/findwi')
    },

    // —— 世界书：本档只读 ——
    async getWorldbook(name) {
      const current = readOpen()
      const text = String(name)
      if (text === 'current') unsupported('getWorldbook', '未提供当前世界书名称（author 侧的 current 别名）')
      const entries = await readWorldbookEntries(current.sessionId, text)
      readOpen()
      return copyHelperReadonlyJson(entries)
    },

    // —— 服务端不实现的浏览器能力：显式 unsupported，不做假 facade ——
    getMessageId: () => unsupported('getMessageId', '消息 iframe 名称是浏览器特权对象，服务端不实现'),
    getIframeName: () => unsupported('getIframeName', '消息 iframe 名称是浏览器特权对象，服务端不实现'),
    retrieveDisplayedMessage: () => unsupported('retrieveDisplayedMessage', 'DOM 显示节点只能在浏览器侧读取'),
    formatAsDisplayedMessage: () => unsupported('formatAsDisplayedMessage', 'Markdown/DOM 显示只能在浏览器侧生成'),
  }

  // 测试探针登记（不进返回对象 ⇒ 生产 API 面仍只有只读能力）。
  const frozen = Object.freeze(api)
  PROBE.set(frozen, { readPipeline: slash.readPipeline })
  return frozen
}

export { normalizeMessageId as normalizeHelperMessageId }

/** 测试专用探针表：`beginReadonlyProbe(api)` 取出内部 readPipeline 与作者解析器真对照。 */
const PROBE = new WeakMap()
export function beginReadonlyProbe(api) {
  const probe = PROBE.get(api)
  if (!probe) throw new TypeError('readonly 探针：需要 createHelperReadonlyApi 的返回值')
  return Object.freeze({ readPipeline: probe.readPipeline })
}
