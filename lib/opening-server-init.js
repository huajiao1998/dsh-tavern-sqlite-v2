// 开局准备（私有草稿）的服务端变量初始化消费者。
//
// 位置：准备页只存在**私有 draft**（作者 `opening-preparation.js` create 内的 drafts Map），
// 既没有原生会话、也没有资源原件写权。本模块把这棵私有草稿接给服务端 MVU 初始化。
//
// 分工（重要）：server 侧 `createServerExecution` 新增的 `initializeOpeningData(input)` **不在本文件**
// （由主实现，本文件是它的消费者）。按规格：server 方法一次 loadCardHooks，**逐 swipe** 调本文件提供的
// `initializeData({variables, greeting, swipeId})` 拿 `{initialized, variables}`，派
// `mag_variable_initialized(data, index)`，再 `executeCommand(greeting, data, emitter)`、drain 回填。
// ⇒ 派事件 / 执行命令 / 完成屏障都在 server 方法内；本模块**只负责产出每个 swipe 的权威变量树**，
//    并在整轮成功后**才**更新 draft.chat（出错不发布、不半写回）。
//
// 依赖全部由调用方注入（DI），本模块**不 import 作者代码**：
//   · createServerExecution —— 作者树垫片 `storage-server-execution.js` 按 profile 锚点绑定。
//   · worldbook —— 已投影 `{ name, entries }`（含合并 globals + additional）。
//   · generateRaw —— 现成 DI；本模块只透传，测试不调用模型。
//   · substituteMacros —— 宏替换（生产由 `storage-opening-runtime.js` 垫片注入 renderTavernMacros）。
//
// 本模块只做**私有草稿**：不碰 SQLite 会话、不建事务、不签发 operation 令牌。
import { initializeMvuData } from './mvu/mvu-initialize.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value) {
  if (value === undefined) return undefined
  try { return structuredClone(value) } catch { return JSON.parse(JSON.stringify(value)) }
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** 开场楼（作者 opening-preparation.js:56 建的那一条 greeting 楼）。 */
function openingMessageOf(draft) {
  const messages = Array.isArray(draft?.chat?.messages) ? draft.chat.messages : []
  return messages[0] || null
}

/** 开场白文本列表（swipes）；缺失时回落单条，不伪造多条。 */
function swipesOf(draft) {
  const message = openingMessageOf(draft)
  if (!message) return []
  if (Array.isArray(message.swipes) && message.swipes.length > 0) return message.swipes.map(str)
  return [str(message.sourceText ?? message.text)]
}

/** 当前选中的 swipe（作者 select() 把它写在开场楼的 swipeId 上）。 */
function selectedSwipeOf(draft) {
  const raw = Number(openingMessageOf(draft)?.swipeId)
  return Number.isInteger(raw) && raw >= 0 ? raw : 0
}

/**
 * 私有准备草稿的临时 host（**只写 draft**）。
 *
 * 与正式会话 host 的差别：
 *   · 拒绝新增/删除故事楼 —— 准备阶段只允许更新开场变量；
 *   · updateVariables 按 scope 提供 message / chat / script / global / character；
 *   · getWorldbook 返回**真实**投影，书不存在时点名报错，**不返回伪空 entries**；
 *   · replaceWorldbook / saveExtensionSettings 直接 strict 拒绝（跨存储各有其所有者）。
 *
 * 注：准备阶段是**私有操作、已签名的 host**，没有 SQLite 假事务，因此不使用 expected 版本参数。
 */
function makeOpeningHost({ draft, worldbook }) {
  const messagesOf = () => (Array.isArray(draft?.chat?.messages) ? draft.chat.messages : [])

  // swipe 身份必须是**显式**给出的：option.swipe_id 优先；缺省回落"当前选中开场白"。
  // 绝不按"最后一个 swipe"猜 —— 那会把写落错位置。
  const resolveSwipeId = option => {
    if (option && Object.hasOwn(option, 'swipe_id')) {
      const raw = Number(option.swipe_id)
      if (!Number.isInteger(raw) || raw < 0) throw fail('OPENING_INIT_BAD_INPUT', 'updateVariables 的 swipe_id 无效')
      return raw
    }
    return selectedSwipeOf(draft)
  }
  const resolveMessageId = option => {
    const messages = messagesOf()
    if (option && Object.hasOwn(option, 'message_id')) {
      const raw = Number(option.message_id)
      const id = raw < 0 ? messages.length + raw : raw
      if (!Number.isInteger(id) || id < 0 || id >= messages.length) {
        throw fail('OPENING_INIT_BAD_INPUT', 'updateVariables 的目标楼层不存在（准备阶段只有开场楼）')
      }
      return id
    }
    return 0
  }

  const slotFor = (message, swipeId) => {
    if (!Array.isArray(message.variables)) message.variables = []
    while (message.variables.length <= swipeId) message.variables.push({})
    return message.variables
  }
  const touch = () => { draft.chat._storageRevision = (Number(draft.chat._storageRevision) || 0) + 1 }

  return {
    /** 私有草稿只允许**更新开场变量**：新增/删除故事楼一律拒绝（不 no-op 伪成功）。 */
    async updateMessages(_sessionId, patches) {
      const list = Array.isArray(patches) ? patches : [patches]
      const messages = messagesOf()
      const message = messages[0]
      if (!message) throw fail('OPENING_INIT_BAD_INPUT', '私有草稿缺少开场楼')
      for (const patch of list) {
        if (!isObject(patch)) throw fail('OPENING_INIT_BAD_INPUT', '准备阶段楼层补丁必须是对象')
        if (Number(patch.message_id) !== 0) {
          throw fail('OPENING_INIT_UNSUPPORTED_FLOOR', '准备阶段只能更新开场楼（message_id 0），不允许新增/删除故事楼')
        }
        if (Object.keys(patch).some(key => !['message_id', 'swipe_id', 'data', 'swipes_data'].includes(key))) {
          throw fail('OPENING_INIT_UNSUPPORTED_FLOOR', '准备阶段变量运行时只能更新开场变量（message_id/data/swipes_data）')
        }
        if (patch.data !== undefined) {
          const swipeId = resolveSwipeId(patch)
          slotFor(message, swipeId)[swipeId] = cloneJson(isObject(patch.data) ? patch.data : {}) || {}
        }
        if (patch.swipes_data !== undefined) {
          if (!Array.isArray(patch.swipes_data)) throw fail('OPENING_INIT_BAD_INPUT', 'swipes_data 必须是数组')
          message.variables = patch.swipes_data.map(value => cloneJson(isObject(value) ? value : {}) || {})
        }
      }
      touch()
      return { updated: true, floors: messages.length }
    },
    async createMessages() {
      throw fail('OPENING_INIT_UNSUPPORTED_FLOOR', '准备阶段不创建故事楼：开局初始化只写开场变量')
    },
    /** 变量写入口：按 option.type 落到正确 scope。 */
    async updateVariables(_sessionId, option = {}, variables = {}) {
      const list = messagesOf()
      const message = list[0]
      if (!message) throw fail('OPENING_INIT_BAD_INPUT', '私有草稿缺少开场楼')
      const type = str(option.type) || 'message'
      const next = cloneJson(isObject(variables) ? variables : {}) || {}
      if (type === 'message') {
        const messageId = resolveMessageId(option)
        const swipeId = resolveSwipeId(option)
        slotFor(list[messageId], swipeId)[swipeId] = next
      } else if (type === 'chat') {
        draft.chat.variables = next
      } else if (type === 'script') {
        const id = str(option.script_id).trim()
        if (id === '') throw fail('OPENING_INIT_BAD_INPUT', '脚本变量写入缺少 script_id')
        draft.chat.tavernHelperScriptVariables ||= {}
        draft.chat.tavernHelperScriptVariables[id] = next
      } else if (type === 'global') {
        draft.globalVariables = next
      } else if (type === 'character') {
        draft.characterVariables = next
      } else {
        throw fail('OPENING_INIT_UNSUPPORTED_SCOPE', '不支持的变量 scope：' + type)
      }
      touch()
      return { updated: true, type }
    },
    /** 世界书读口：真实投影；书不存在时点名报错，**不返回伪空对象**。 */
    async getWorldbook(_sessionId, name) {
      const wanted = str(name)
      if (!isObject(worldbook) || str(worldbook.name) === '' || !Array.isArray(worldbook.entries)) {
        throw fail('OPENING_INIT_NO_WORLDBOOK', '本次开局没有可用的世界书投影（不做伪空返回）')
      }
      if (wanted !== '' && wanted !== 'current' && wanted !== str(worldbook.name)) {
        throw fail('OPENING_INIT_NO_WORLDBOOK', '世界书不存在：' + wanted + '（本次开局只有 ' + str(worldbook.name) + '）')
      }
      return { worldbook: { name: str(worldbook.name), entries: cloneJson(worldbook.entries) } }
    },
    // 跨存储一律 strict 拒绝：世界书原件与扩展设置各有所有者，准备阶段只产出变量。
    async replaceWorldbook() {
      throw fail('OPENING_INIT_UNSUPPORTED_STORAGE', '准备阶段不写世界书原件：开局初始化只产出变量（拒绝跨存储写）')
    },
    async saveExtensionSettings() {
      throw fail('OPENING_INIT_UNSUPPORTED_STORAGE', '准备阶段不写扩展设置：开局初始化只产出变量（拒绝跨存储写）')
    },
  }
}

/** 读给卡脚本的资源快照（按 makeHostApi 的消费面：卡/character/global/extension/regex）。 */
function readResourceSnapshot(draft) {
  const regexScripts = isObject(draft.regexScripts) ? draft.regexScripts : {}
  const helperScripts = cloneJson(draft.helperScripts || []) || []
  return {
    character: cloneJson(draft.card),
    helperScripts,
    globalVariables: cloneJson(draft.globalVariables || {}),
    characterVariables: cloneJson(draft.characterVariables || {}),
    extensionSettings: cloneJson(draft.extensionSettings || {}),
    regexScripts: {
      global: cloneJson(regexScripts.global || []) || [],
      character: cloneJson(regexScripts.character || []) || [],
    },
  }
}

/**
 * 开局私有草稿的服务端变量初始化。
 *
 * @param {object} input
 * @param {object} input.draft                    私有准备草稿（作者 opening-preparation.js create 内那份）
 * @param {function} input.createServerExecution  服务端执行工厂（作者树垫片）
 * @param {{name:string, entries:Array}} [input.worldbook] 已投影世界书（含合并 globals + additional）
 * @param {function} [input.generateRaw]          现成生成接线（透传，测试不调用模型）
 * @param {function} [input.substituteMacros]     宏替换
 * @returns {Promise<{handled, initialized, swipes, swipeId, openingVariables}>}
 */
export async function initializeOpeningRuntime({
  draft,
  createServerExecution,
  worldbook,
  generate,
  generateRaw,
  generationContext,
  substituteMacros,
  signal,
  cardScriptDispatchStore,
} = {}) {
  if (!isObject(draft)) throw fail('OPENING_INIT_BAD_INPUT', '开局初始化缺少私有草稿（draft）')
  if (!isObject(draft.chat) || !Array.isArray(draft.chat.messages) || draft.chat.messages.length === 0) {
    throw fail('OPENING_INIT_BAD_INPUT', '开局草稿缺少 chat.messages：拒绝在没有私有草稿时继续')
  }
  if (typeof createServerExecution !== 'function') {
    throw fail('OPENING_INIT_MISSING_DEPENDENCY', '开局初始化缺少 createServerExecution 接线')
  }

  const originalDraft = draft
  // 只脱离准备页的私有数据，不读取或复制 SQLite 存档；失败不修改未发布草稿。
  draft = structuredClone(draft)
  const swipes = swipesOf(draft)
  const selectedSwipeId = selectedSwipeOf(draft)

  // 世界书：**真实**投影才进初始化；未提供即"无世界书初始化"，绝不造伪空条目对象。
  const books = []
  if (worldbook !== undefined && worldbook !== null) {
    if (!isObject(worldbook) || str(worldbook.name) === '' || !Array.isArray(worldbook.entries)) {
      throw fail('OPENING_INIT_BAD_INPUT', 'worldbook 必须是 { name, entries:[...] } 的真实投影（不以伪空代替）')
    }
    books.push({ name: str(worldbook.name), entries: worldbook.entries })
  }
  const initializationBooks = draft.initializationWorldbooks || books
  if (!Array.isArray(initializationBooks)) throw fail('OPENING_INIT_BAD_INPUT', '开局世界书来源必须是明确的书列表')

  const host = makeOpeningHost({ draft, worldbook: books[0] || null })
  const execution = createServerExecution({
    host,
    cardScriptDispatchStore,
    readCardExtensions: () => ({ helperScripts: draft.helperScripts }),
    readResourceSnapshot: async () => readResourceSnapshot(draft),
    // 作者开局编译器的context与已保存聊天DI不同：只从本次私有准备草稿构造。
    ...(typeof generationContext !== 'function' ? (generateRaw === undefined ? {} : {generateRaw}) : {
      readGenerationContext: binding => binding.chat,
      generate: (config, descriptor) => {
        if (typeof generate !== 'function') throw new Error('开局generate未接线')
        return generate(config, generationContext(descriptor.context, descriptor.signal))
      },
      generateRaw: (config, descriptor) => {
        if (typeof generateRaw !== 'function') throw new Error('开局generateRaw未接线')
        return generateRaw(config, generationContext(descriptor.context, descriptor.signal))
      },
    }),
  })
  const sessionId = str(draft.chat.sessionId) || ('opening:' + str(draft.id))

  // 每个 swipe 一棵独立的树（上游 variable_init.ts:142-194 逐 swipe 独立初始化）。
  // server 逐 swipe 调本回调取数据；本模块不预先把全部 swipe 算完（顺序与发射时机由 server 掌握）。
  let initializedAny = false

  try {
    const handled = await execution.initializeOpeningData({
      sessionId,
      draft: draft.chat,
      signal,
      prepareCommand: text => typeof substituteMacros === 'function' ? substituteMacros(text, draft) : text,
      // server 逐 swipe 调它：{variables 是该 swipe 的当前树, greeting, swipeId} → {initialized, variables}
      initializeData: async ({ variables, greeting, swipeId } = {}) => {
        if (draft.chat.mvu?.enabled !== true) return { initialized: false, variables: structuredClone(variables || {}) }
        const { initialized, result } = await initializeMvuData({
          variables: isObject(variables) ? variables : {},
          worldbooks: initializationBooks,
          primaryBook: initializationBooks[0]?.name,
          greeting: str(greeting),
          swipeId,
          substituteMacros: text => typeof substituteMacros === 'function' ? substituteMacros(text, draft) : text,
        })
        const tree = cloneJson(result.variables) || {}
        if (initialized) initializedAny = true
        return { initialized, variables: tree }
      },
    })

    // 完成屏障：等全部在飞 run 与已发出的 host 调用结算，再谈回填。
    await execution.whenIdle(sessionId)

    // 使用服务端最终树，不能用初始化回调返回的旧副本覆盖钩子/命令的计算结果。
    draft.chat._storageRevision = (Number(draft.chat._storageRevision) || 0) + 1
    originalDraft.chat = draft.chat
    originalDraft.globalVariables = draft.globalVariables
    originalDraft.characterVariables = draft.characterVariables

    return {
      handled: handled?.handled === true,
      initialized: initializedAny,
      swipes: swipes.length,
      swipeId: selectedSwipeId,
      openingVariables: cloneJson(draft.chat.messages[0].variables),
    }
  } finally {
    // 成功时上面已经 join；失败立即拒绝并关写窗，已发 Host 调用仍由 execution.whenIdle 跟踪。
    // 不在失败收尾再次等待 Host，避免取消/超时被一个不返回的调用重新阻塞。
    try { execution.disposeAll() } catch { /* 释放失败不改变结算结论 */ }
  }
}
