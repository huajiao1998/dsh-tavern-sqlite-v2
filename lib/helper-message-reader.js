// 卡脚本消息读取器（Tavern Helper `getChatMessages` / `getAllChatMessages` 的同步口径）。
//
// 权威基线（不猜、照抄语义）：
//   · 作者 lib/client.js:3580–3615 `createTavernHelperMessageReader(options)`
//       → 返回 function (target, settings)；settings = {role, hide_state}
//   · 作者 lib/client.js:6822 装配 `modules.createMessageReader({context, currentId, copy, readMessage})`
//   · 作者 lib/domain/tavern-helper-context.js:51–79 `tavernHelperRole` / `projectTavernHelperMessage`
//       ——**这是 raw storage 行 → reader 输入行的权威投影**：reader 自己的 `readMessage` 拿到的
//       已经是 `projectTavernHelperMessage` 的输出（helper-history.js:16-26 的 read 直接返回 state.messages[id]，
//       而 state.messages 由 tavern-helper-context.js:132/157/214 投影而来）。
//   · 上游只读文档 tmp/upstream25-helper-contract/raw/coverage.md:38,48。
//
// 两个**必须分清**的行形态（曾把两者混同，是本模块此前的真错误）：
//   · **raw 行**（SQLite/native 存档 floor）：`role:'tavern-helper'` + `tavernRole` + `tavernHidden`
//     + `tavernPluginData` + `swipes` + `variables[]`（**每 swipe 一棵树**）+ `swipeId` + `sourceText/text`。
//     证据：native-conversation-storage.js:262 的字段清单，与 :237-249 / :291-293 的 `variables[swipeId]`。
//   · **reader 输入行**：`projectTavernHelperMessage` 已把上面那些**改名**成
//     `pluginData` / `is_hidden` / `name` / `role`（经 tavernHelperRole 映射）/ `swipe_id` /
//     `swipes_data`(= 整个 variables 数组) / `variables`(= 选中 swipe 那棵树) / `message`。
//   ⇒ reader 只按**后者**的字段名读；raw 行的别名映射是 projectTavernHelperMessage 的职责，
//     本模块**不重复实现**、也不做 raw 嗅探（那会与作者投影争权威）。
//
// 本模块是**纯函数工厂**：不 import 作者代码、不接触存档、不做 IO。
// 调用方（server-execution.js）注入 readOpen / projectRow / variablesOf / copy 四个口子：
//   · readOpen()      —— 同步读当前结算窗口（关闭时抛；本模块不吞该异常）
//   · projectRow(source, messageId) —— **作者投影**：raw floor → reader 输入行（缺省恒等，即喂进来的已是投影行）
//   · variablesOf(option) —— 用 {type:'message', message_id, swipe_id} 解析**权威树**
//                            （确保读的是 core 正在改的那棵 active 树，不是绑定时的旧快照）
//   · copy(value)     —— 结构化脱离（可选；缺省用本模块的 copyJson）
//
// 与 server-execution 里旧 `chatMessages(current, range)` 的差异（本模块是公开 API 口径）：
//   ① range 支持数字（单楼）、负数（倒数）、'a-b' 双端字符串、`{{lastMessageId}}`、越界 clamp；
//      旧内部函数把数组 range 当成 [start,end] 闭区间、把非法值 resolve 成当前楼 —— 那是**内部私有**口径。
//   ② 非法 range 返回 []（上游 3588 行 `if (!match) return []`），不是回落到当前楼。
//   ③ 只读**所选行**：按 clamp 后的 [min,max] 逐楼读，绝不 spread 整段历史。
//   ④ 补齐上游字段 name / is_hidden / swipes_info / extra，同时保留 DSH 已有别名。
//   ⑤ **只输出作者契约字段**（见 projectRow），不把整个 raw floor 复制出去；message_id 以**位置**为准。

/** 默认结构化脱离：只重建骨架，原始标量按引用共享（§五.2 判据）。 */
function copyJson(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(copyJson)
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = copyJson(item)
  return result
}

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 常量：上游 client.js:3585–3588 的 `{{lastMessageId}}` 与 range 正则（逐字保留）。 */
const LAST_MESSAGE_ID = /\{\{\s*lastMessageId\s*\}\}/gi
const RANGE_PATTERN = /^(-?\d+)(?:-(-?\d+))?$/

/**
 * 作者 `selectedSwipe`（tavern-helper-context.js:16–23）的逐字等价实现。
 *
 * `count = max(swipes.length, variables.length, 1)`，再 `clamp(0, count-1, Number(swipeId)||0)`。
 * 注意作者读的是 **raw floor 的 `swipeId`**（不是投影行的 `swipe_id`）——投影行的 `swipe_id`
 * 已经是同一个 clamp 结果。放在这里是为了让 projectRow 对**未投影的 raw 行**也给出同一答案。
 */
function selectedSwipe(source) {
  const count = Math.max(
    Array.isArray(source?.swipes) ? source.swipes.length : 0,
    Array.isArray(source?.variables) ? source.variables.length : 0,
    1
  )
  return Math.max(0, Math.min(count - 1, Number(source?.swipeId ?? source?.swipe_id) || 0))
}

/**
 * 取正文字段：raw 行与投影行都按作者 `projectTavernHelperMessage:60-62` 的口径。
 * 作者是 `Array.isArray(source.swipes) && length > 0 ? swipes.map(str) : [str(source.sourceText || source.text)]`
 * —— `||` 是**真值回落**（空串也回落），不是 `??`；`message` 只在无 swipes 时才作为源。
 */
function messageTextOf(source) {
  if (Array.isArray(source?.swipes) && source.swipes.length > 0) return source.swipes.map(str)
  if (source?.sourceText !== undefined || source?.text !== undefined) return [str(source.sourceText || source.text)]
  return [str(source?.message)]
}

/**
 * 创建同步消息读取器。
 *
 * @param {object} deps
 * @param {() => object} deps.readOpen        同步读当前窗口；关闭时**抛**（本模块不吞）
 * @param {(source: object, messageId: number) => object} [deps.projectRow]
 *        作者投影（`projectTavernHelperMessage`）。喂 raw floor 时**必须**注入；
 *        喂已投影行时缺省恒等。
 * @param {(option: object) => object} deps.variablesOf  按 {type:'message',message_id,swipe_id} 返回权威树
 * @param {(value: any) => any} [deps.copy]   结构化脱离；缺省 copyJson
 * @returns {(range?: any, settings?: {role?: string, hide_state?: string}) => object[]}
 */
export function createHelperMessageReader({ readOpen, projectRow, variablesOf, copy } = {}) {
  if (typeof readOpen !== 'function') throw new TypeError('createHelperMessageReader 缺少 readOpen 依赖')
  if (typeof variablesOf !== 'function') throw new TypeError('createHelperMessageReader 缺少 variablesOf 依赖')
  const copyValue = typeof copy === 'function' ? copy : copyJson

  const messagesOf = chat => (Array.isArray(chat?.messages) ? chat.messages : [])

  /**
   * 玩家名 / 角色名：作者 reader 读的是 **state**.playerName / state.characterName，
   * 而产品侧这两个值是这样供出的（lib/index.js:1594 / :1623）：
   *   playerName    = chat.macroState.userName
   *   characterName = card.name || chat.cardName   （card 由 cardDefinitionSnapshot 还原，:633/:925）
   * 因此这里按**同一条链**取值，而不只认已被喂好的 state 字段 —— 否则接线稍变就静默回落成「你/角色」。
   */
  function playerNameOf(state) {
    const explicit = str(state?.playerName)
    if (explicit !== '') return explicit
    const macro = str(state?.chat?.macroState?.userName).trim()
    return macro !== '' && macro !== 'User' ? macro : ''
  }

  function characterNameOf(state) {
    const explicit = str(state?.characterName)
    if (explicit !== '') return explicit
    const chat = state?.chat
    const fromSnapshot = str(chat?.cardDefinitionSnapshot?.name)
    if (fromSnapshot !== '') return fromSnapshot
    return str(chat?.cardName)
  }

  /**
   * 由 reader 输入行 + 楼号 + 解析出的权威树，构造一条公开投影行。
   *
   * **输出字段是明确列出的**（作者 projectTavernHelperMessage:64-77 的字段集合），
   * 绝不"复制整个 raw floor 再返回"——那会把 raw storage 的内部字段
   * （`tavernRole` / `tavernHidden` / `tavernPluginData` / `sourceText` / `projectionText` /
   * `displayText` / `turn` / `greeting` / `_storageRevision` …）一并泄漏给卡脚本。
   *
   * 顺序严格照上游 3598–3608：
   *   copy → name 回落 → is_hidden → swipe_id → swipes → swipes_data → swipes_info → message → data → extra
   *
   * **命名注意**：本函数**不得**叫 `projectRow` —— 那会与工厂形参 `projectRow`（注入的作者投影）重名，
   * 形参遮蔽函数声明 ⇒ `selected.push(projectRow(...))` 静默调成作者投影、产出空树。
   */
  function buildPublicRow(source, messageId, tree, state) {
    const row = isObject(source) ? source : {}
    // 上游 3600 行取的是 **state**.playerName / state.characterName（不是行字段）。
    const playerName = playerNameOf(state)
    const characterName = characterNameOf(state)
    // 上游 3599 行 `const swipe = Number(row.swipe_id) || 0`：**不 clamp**，只做 NaN→0。
    // （clamp 已由作者 projectTavernHelperMessage 的 selectedSwipe 完成，此处是 reader 的第二步。）
    const swipeId = Number(row.swipe_id) || 0
    const isHidden = row.is_hidden === true
    const pluginData = isObject(row.pluginData) ? row.pluginData : {}

    const swipes = messageTextOf(row)
    const swipesData = swipes.map((_value, index) => {
      // 上游 3604 行优先级：行内 swipes_data[index] → (index===swipe 时 row.variables) → {}
      // **保全部 swipe**：非 active 的槽位同样保留其真值，不做任何"非当前 swipe 清成 {}"的处理。
      const own = Array.isArray(row.swipes_data) ? row.swipes_data[index] : undefined
      const fallback = index === swipeId ? row.variables : undefined
      return copyValue(isObject(own) ? own : (isObject(fallback) ? fallback : {}))
    })
    const swipesInfo = swipes.map((_value, index) => {
      // 上游 3605 行优先级：行内 swipes_info[index] → pluginData.swipe_info[index]
      //                      → (index===swipe 时 extra ?? pluginData.extra) → {}
      const own = Array.isArray(row.swipes_info) ? row.swipes_info[index] : undefined
      const fromPlugin = Array.isArray(pluginData.swipe_info) ? pluginData.swipe_info[index] : undefined
      const fallback = index === swipeId ? (row.extra ?? pluginData.extra) : undefined
      const picked = own ?? fromPlugin ?? fallback
      return copyValue(isObject(picked) ? picked : {})
    })

    // message 上游 3606 行 `String(row.message ?? row.swipes[swipe] ?? '')`。
    // 投影行已带 message（作者 :68 写好）；缺失才回落 swipes[swipe]。
    const message = str(row.message ?? swipes[swipeId] ?? '')
    // variables 上游**原样保留行值**（不经任何外部覆盖）：作者的投影已把它设成
    // "选中 swipe 的那棵树"（:72），而 `readMessage` 返回的就是**同一棵权威树**
    // （helper-bootstrap.js:338-339 的 getVariables 也直接读 `message.variables`）。
    // `tree`（注入的 variablesOf）只在行**没有** variables 时兜底 —— 它是同一棵树的
    // 另一种取法（本包结算窗口里的 active 树），不是更高优先级的覆盖。
    const variables = copyValue(isObject(row.variables) ? row.variables : (isObject(tree) ? tree : {}))
    // data 上游 3607 行 `row.swipes_data[swipe] || row.variables || {}`（真值回落）。
    const data = copyValue(swipesData[swipeId] || variables || {})
    // extra 上游 3608 行 `row.swipes_info[swipe] || {}`。
    const extra = copyValue(swipesInfo[swipeId] || {})

    // —— 明确输出（作者字段集 + 本包保留的 DSH `name` 别名）——
    const projected = {
      pluginData: copyValue(pluginData),
      message_id: messageId,
      role: str(row.role) !== '' ? str(row.role) : 'assistant',
      swipe_id: swipeId,
      swipes: copyValue(swipes),
      swipes_data: copyValue(swipesData),
      swipes_info: copyValue(swipesInfo),
      message,
      // 上游 reader 保留 row.variables（投影已给选中树）；本包注入的 variablesOf 让它更权威。
      variables,
      data,
      extra,
      // 上游 3600 行：row.name || (role==='user' ? state.playerName||'你' : state.characterName||'角色')。
      // `name` 在作者投影里只对 tavern-helper 楼写入（tavern-helper-context.js:76），故普通楼走状态回落。
      name: str(row.name) || (str(row.role) === 'user' ? (playerName || '你') : (characterName || '角色')),
      is_hidden: isHidden
    }
    return projected
  }

  /**
   * 缺省投影：恒等（喂进来的已是 projectTavernHelperMessage 的输出）。
   * 生产接线若直接给 **raw floor**，必须注入作者投影 `projectTavernHelperMessage`，
   * 由它完成 tavernRole→role / tavernHidden→is_hidden / tavernPluginData→pluginData 的改名。
   */
  const projectSource = typeof projectRow === 'function' ? projectRow : (source, messageId) => source

  return function readMessages(range, settings) {
    // 关闭读**抛**：readOpen 自己抛（本模块不 catch、不伪空数组掩盖）。
    const current = readOpen()
    const messages = messagesOf(current?.chat)
    const count = messages.length
    if (!count) return []
    const filter = settings || {}
    // role / hide_state 过滤在**读树之前**做（省一次权威树解析），语义与上游 3595–3597 一致。
    // 过滤看的是**投影行**（见下方循环内的 projectSource），不是 raw floor。
    const roleFilter = str(filter.role)
    const hideState = str(filter.hide_state)

    // —— range 归一（上游 3585–3590）——
    const currentId = Number(current?.messageId)
    const raw = range === undefined || range === null
      ? String(currentId)
      : String(range).replace(LAST_MESSAGE_ID, String(count - 1))
    const match = RANGE_PATTERN.exec(raw.trim())
    if (!match) return []                       // 非法 range → []（不是回落当前楼）
    const normalize = value => Math.max(0, Math.min(count - 1, value < 0 ? count + value : value))
    const start = normalize(Number(match[1]))
    const end = normalize(Number(match[2] ?? match[1]))

    const selected = []
    // reverse normalize：无条件从 min 走到 max（上游 3592 行 `Math.min/Math.max`）。
    for (let id = Math.min(start, end); id <= Math.max(start, end); id++) {
      const floor = messages[id]
      if (!floor) continue
      // **先投影再过滤**：raw floor 的 role 是 `'tavern-helper'`、隐藏位是 `tavernHidden`，
      // 直接拿 raw 过滤会与作者语义不符（tavernRole:'system' 的助手楼应可被 role:'system' 命中）。
      // 上游 3593–3597 顺序亦然：readMessage → （过滤用的）source 已是投影行。
      const source = projectSource(floor, id)
      if (!isObject(source)) continue
      const role = str(source.role) !== '' ? str(source.role) : 'assistant'
      if (roleFilter && roleFilter !== 'all' && role !== roleFilter) continue
      const hidden = source.is_hidden === true
      if ((hideState === 'hidden' && !hidden) || (hideState === 'unhidden' && hidden)) continue
      // 只对**选中的行**解析权威树（用注入的 variablesOf，确保是 active 树）。
      const swipeId = Number(source.swipe_id) || 0
      const tree = variablesOf({ type: 'message', message_id: id, swipe_id: swipeId })
      selected.push(buildPublicRow(source, id, tree, current))
    }
    return selected
  }
}

export { copyJson as copyHelperMessageJson }

/**
 * 作者 `tavernHelperRole`（tavern-helper-context.js:51–55）的逐字等价实现。
 * 只有 raw floor 需要它；投影行已把 role 改好。
 */
function tavernHelperRole(source) {
  if (source?.role === 'tavern-helper') {
    return ['system', 'assistant', 'user'].includes(source.tavernRole) ? source.tavernRole : 'assistant'
  }
  return ['system', 'user'].includes(source?.role) ? source.role : 'assistant'
}

/**
 * raw storage floor → reader 输入行的**作者投影等价物**（tavern-helper-context.js:58–79）。
 *
 * 生产接线若直接喂 raw floor（SQLite/native 存档行）而拿不到作者模块，就注入这个函数做 `projectRow`；
 * 能拿到作者模块时**优先注入作者原版**（它还有 clone/freeze 语义）。二者字段口径一致：
 *   `tavernRole`→`role`（经 tavernHelperRole）、`tavernHidden`→`is_hidden`、
 *   `tavernPluginData`→`pluginData`、`sourceText||text`→正文、`variables[]`→`swipes_data`。
 *
 * **绝不做 raw 嗅探**：本函数只在调用方明确声明"这是 raw floor"时使用，不在 reader 内部
 * 自动探测字段名——那会与作者投影争权威，也会让两种行形态产生歧义。
 */
export function projectRawHelperFloor(source, messageId) {
  const row = isObject(source) ? source : {}
  const swipeId = selectedSwipe(row)
  const swipes = messageTextOf(row)
  const variables = Array.isArray(row.variables) ? row.variables : []
  const projected = {
    pluginData: copyJson(isObject(row.tavernPluginData) ? row.tavernPluginData : {}),
    message_id: messageId,
    role: tavernHelperRole(row),
    message: swipes[swipeId] ?? swipes[0] ?? '',
    swipe_id: swipeId,
    swipes: swipes.map(str),
    // 作者 :71 —— swipes_data 保**全部 swipe** 的变量（不是只保 active、其余 {}）。
    swipes_data: variables.map(entry => (isObject(entry) ? copyJson(entry) : {})),
    variables: copyJson(isObject(variables[swipeId]) ? variables[swipeId] : {})
  }
  if (row.role === 'tavern-helper') {
    projected.is_hidden = row.tavernHidden === true
    if (str(row.name) !== '') projected.name = str(row.name)
  }
  return projected
}
