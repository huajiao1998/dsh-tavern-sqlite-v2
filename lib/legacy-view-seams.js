// 原件只读视图接缝：只改脱离的读取信封，不改 archive/header/links/index。
// 依赖注入使作者薄垫片、离线断言共用一份行为；不会注册第二份存储实例。
const READS = ['read', 'readRevision', 'readSessionState', 'readSceneImageState',
  'readBackgroundConfig', 'readDisplayRuntimeState', 'readWindow', 'readSlice',
  'readSettlementBase', 'readChangedSlice', 'readViewDelta']
const WRITES = ['write', 'writeHeader', 'update', 'patch', 'remove']
const idOf = value => typeof value === 'string' ? value : String(value?.id || '')

export function createLegacyViewSeams({ bindingForChat, overlayLinks, projectEnvelope, isLegacyChat }) {
  for (const [name, fn] of Object.entries({ bindingForChat, overlayLinks, projectEnvelope, isLegacyChat })) {
    if (typeof fn !== 'function') throw new Error('原件只读接缝缺少 ' + name)
  }
  function readOnlyChat(value) { return isLegacyChat(idOf(value)) === true }
  function assertWritable(value, operation = '写入') {
    if (readOnlyChat(value)) {
      const error = new Error('原件只读，拒绝' + operation + '；请另存为新的数据库存档后继续游玩')
      error.code = 'DSH_TAVERN_ORIGINAL_READ_ONLY'
      throw error
    }
  }
  function envelope(chat, chatId = idOf(chat)) {
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return chat
    const binding = bindingForChat(chatId)
    const detached = () => ({ ...chat,
      ...(chat.macroState && typeof chat.macroState === 'object' ? { macroState: { ...chat.macroState } } : {}),
      ...(chat.workspace && typeof chat.workspace === 'object' ? { workspace: { ...chat.workspace } } : {}),
      ...(chat.extract && typeof chat.extract === 'object' ? { extract: { ...chat.extract } } : {}) })
    if (!binding) return readOnlyChat(chatId) ? detached() : chat
    if (chat.id !== undefined && chat.id !== binding.chatId) throw new Error('只读绑定的 Chat 身份不一致')
    if (typeof chat.sessionId === 'string' && ![binding.sessionId, binding.originalSessionId].includes(chat.sessionId)) {
      throw new Error('只读绑定与原档 Session 身份不一致，拒绝覆盖')
    }
    // 只给映射函数独占的浅层信封；messages、nativeOpeningAppended 等均不合成。
    const projected = projectEnvelope({ ...detached(), ...(chat.id === undefined ? { id: chatId } : {}) })
    if (!projected || projected.id !== chatId || projected.sessionId !== binding.sessionId) {
      throw new Error('只读绑定投影未返回正确的原生 Session 身份')
    }
    if (projected.nativeOpeningAppended !== chat.nativeOpeningAppended) throw new Error('只读绑定不得合成原生开场标记')
    return projected
  }
  function resultEnvelope(value, chatId) {
    if (!value || typeof value !== 'object') return value
    if (value.chat && typeof value.chat === 'object') return { ...value, chat: envelope(value.chat, chatId) }
    return envelope(value, chatId)
  }
  function wrapStore(store) {
    const wrapped = { ...store }
    for (const name of READS) {
      if (typeof store[name] === 'function') wrapped[name] = async (chatId, ...args) =>
        resultEnvelope(await store[name](chatId, ...args), chatId)
    }
    // 原件写入口明确报错；viewer 的跳过逻辑与写操作的失败不可混淆。
    for (const name of WRITES) {
      if (typeof store[name] === 'function') wrapped[name] = (...args) => {
        assertWritable(args[0], name)
        return store[name](...args)
      }
    }
    return Object.freeze(wrapped)
  }
  function links(value) { return overlayLinks(value) }
  return Object.freeze({ readOnlyChat, assertWritable, envelope, resultEnvelope, wrapStore, links })
}

/** 在调用方独占 observation lease 的期间计算边界，不 resume 源 Agent。 */
export async function withObservedForkSource({ query, sessionId, work }) {
  if (!query || typeof query.observeSession !== 'function') throw new Error('缺少原生 Session 只读观察接口')
  const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
  try {
    if (observation.header?.id !== sessionId) throw new Error('原生分叉源身份不一致')
    if (!Array.isArray(observation.events)) throw new Error('原生观察未返回已验证的事件日志')
    // rc.2 observation 不公开 prepared Session；作者边界函数只消费 sessionEvents。
    // 仅提供不可写 event reader，不新建 Session、surface 或任何合成事件。
    const reader = Object.freeze({ id: sessionId, header: observation.header, events: observation.events })
    return await work(reader)
  } finally {
    const dispose = observation[Symbol.dispose]
    if (typeof dispose !== 'function') throw new Error('原生观察缺少释放契约')
    dispose.call(observation)
  }
}

/**
 * 作者提供此 service，RPC/UI/插件动作调用同一个 prepare→claim→native fork→complete 流程。
 *
 * 去重契约（2026-09-30 定稿）：prepare 保持**只读**；claim 是"一次 native fork 之前"的独占占位
 * （源档唯一记录，token 由服务端生成；claimed 只表示 SID 回执未知，不保证没有 SID）；complete 先
 * **永久冻结目标 SID** 再进入 completeFork，之后同 token 同 SID 的重试只恢复/收口，绝不会再建一个档。
 * 没有自动 lease/过期/回收：状态放行只能由用户显式动作完成。缺 forkRecords 一律响亮失败，
 * **不允许**静默退回"无去重"的旧路径。
 *
 * 释放契约（2026-10-01 定稿）：唯一的"完成 → 可再创建"出口是 `release`，且只对
 * **complete + 目标 Chat 被 `DSH_TAVERN_SAVE_NOT_FOUND` 确证不存在 + 客户端回显精确 tuple** 生效；
 * status 的只读 `targetExists` 只报告事实，不改 forked/pending、不自动放行。claimed/bound/created
 * 一律没有出口（未知回执必须人工核实）。本动作不调用任何原生接口、不删原生会话。
 *
 * 命名契约（2026-10-01 定稿）：目标标题**只认源会话原生标题**（dep `readSourceSessionTitle` 折叠
 * 源会话日志最后一条 `session/title`，只读、不 resume/adopt）；聊天档 title / 卡名都不作权威、
 * 也不作兜底 —— 读不到就在 prepare/claim（即 native fork 之前）响亮失败。
 *
 * 并发作用域（明确不承诺的部分）：持久权威是插件自有 SQLite 的单条 CAS；"同 token 只跑一次
 * completeFork"由本 service 实例的内存表保证 ⇒ **只承诺单个 service 进程**。跨进程（多实例同时写
 * 同一 profile）不做承诺：极端并发下可能各跑一次 completeFork；亲本/边界校验并不是跨进程
 * 原子建档保证。不能用此接口承诺多进程共享同一 profile 的去重安全。
 */
export function createLegacySaveActions({ chats, resolveChatId, prepareFork, completeFork,
  describeSaveFormat, formatSaveResult, queryVariables, formatVariableResult,
  forkRecords, readSourceSessionTitle, renameTargetSession, setTargetChatTitle, validateTargetNaming }) {
  for (const [name, fn] of Object.entries({ resolveChatId, prepareFork, completeFork, describeSaveFormat,
    formatSaveResult, readSourceSessionTitle, renameTargetSession, setTargetChatTitle, validateTargetNaming })) {
    if (typeof fn !== 'function') throw new Error('另存动作缺少 ' + name)
  }
  if (!forkRecords || typeof forkRecords !== 'object') throw new Error('另存动作缺少 forkRecords（拒绝无去重的另存路径）')
  for (const name of ['read', 'claim', 'bind', 'created', 'finish', 'release']) {
    if (typeof forkRecords[name] !== 'function') throw new Error('另存动作的 forkRecords 缺少 ' + name)
  }
  // 单进程内的 inflight 表：key = token，value = {fingerprint, promise}。只有**参数指纹完全相同**的并发
  // 调用才复用同一个 run；参数不同一律拒（见 complete）。
  const completing = new Map()

  /**
   * 目标标题只由**源会话的原生标题**派生（宿主 `sessionTitle` 折叠的 `session/title`），客户端副本只用于一致性核对。
   * 聊天档 `title` / `cardName` 都不是权威（2026-10-01 实测：聊天档无 title 时曾回退卡名，
   * 新分叉被命名成 `DB.重回1980-2020年代创业增量版`，而源会话原生标题是 `2004年大学生商海推演`）。
   * 缺原生标题一律响亮失败，**不回退卡名、不自造标题**；有标题时保留其原始字节（只 trim 判空）。
   */
  function targetTitleOf(nativeTitle) {
    const title = String(nativeTitle ?? '')
    if (title.trim() === '') {
      throw forkRecordError('DSH_TAVERN_FORK_SOURCE_TITLE_MISSING',
        '源会话没有可用的原生标题（session/title）；拒绝用卡名代替命名新存档')
    }
    return title.startsWith('DB.') ? title : 'DB.' + title
  }
  function forkExists(record) {
    const error = new Error(record.state === 'complete'
      ? '本源档已经分叉过数据库存档，拒绝重复创建新会话'
      : '本源档已有未完成的分叉记录（' + record.state + '），拒绝再次分叉；请用当前记录重试或人工处理')
    error.code = 'DSH_TAVERN_FORK_RECORD_EXISTS'
    error.state = record.state
    error.targetChatId = record.targetChatId
    error.targetSessionId = record.targetSessionId
    return error
  }
  function forkRecordError(code, message) { const error = new Error(message); error.code = code; return error }
  /** 严格判据：只读原档 = legacy 且**明确**未迁移、明确只读。 */
  function requireLegacyOriginal(format, chatId) {
    if (format?.legacy === true && format.migrated === false && format.readonly === true) return
    const error = new Error('只有只读原档可以分叉迁移；当前存档不是未迁移原档（' + chatId + '），拒绝重复分叉')
    error.code = 'DSH_TAVERN_FORK_SOURCE_NOT_LEGACY'
    throw error
  }
  // 我们自己 SQLite 档的权威 stamp（与 lib/migration-ops.js 的值域一致）。
  const OWNED_SQLITE_STAMP = /^sqlite:gen:\d+(?::empty)?$/
  /** 严格判据：目标档必须是我们自己的可写 SQLite 档（migrated 真、legacy 假、readonly 假、stamp 正则）。 */
  function requireOwnedSqlite(format, chatId) {
    if (format?.migrated === true && format?.legacy === false && format?.readonly === false
      && OWNED_SQLITE_STAMP.test(String(format?.stamp ?? ''))) return
    throw forkRecordError('DSH_TAVERN_FORK_TARGET_NOT_SQLITE', '另存后置校验失败：新存档必须是我们自己的 SQLite 档（chatId=' + chatId + '）')
  }
  /**
   * 目标 Chat 的在位判定（只读，**只**用错误码下结论）：
   *   · 返回我们的格式对象            ⇒ 'present'（在位，含 legacy 承载：旧原件优先语义不变）
   *   · 抛 `DSH_TAVERN_SAVE_NOT_FOUND` ⇒ 'missing'（确证不存在：db 与两种 legacy 承载都没有）
   *   · 其他任何情况（读取失败 / 权限 / 损坏 / 不是我们的存储实现 / 返回非对象）⇒ 'unknown'
   * **unknown 绝不等于 missing**：未知一律由调用方拒绝，避免把"读不出来"当成"已删除"。
   */
  async function targetChatState(chatId) {
    try {
      const format = await describeSaveFormat({ chats, chatId })
      return format !== null && typeof format === 'object' ? 'present' : 'unknown'
    } catch (error) {
      return error?.code === 'DSH_TAVERN_SAVE_NOT_FOUND' ? 'missing' : 'unknown'
    }
  }
  /** 客户端副本只用于一致性核对：与持久记录不一致即拒（不许漂移）。 */
  function checkPlanned(record, args) {
    if (args?.sourceRevision !== undefined && Number(args.sourceRevision) !== record.sourceRevision) throw new Error('源存档已变化，请重新准备另存')
    if (args?.atSeq !== undefined && Number(args.atSeq) !== record.atSeq) throw new Error('源存档分叉边界已变化，请重新准备另存')
    if (args?.turn !== undefined && Number(args.turn) !== record.turn) throw new Error('源存档回合已变化，请重新准备另存')
  }
  /**
   * dep 返回的 accepted 标题：只接受 string 或 {title:string}，**原样返回**（不 trim、不改字节），
   * 保证写进目标档的标题与宿主接受值逐字节一致；trim 只用于判空。
   */
  function acceptedTitleOf(value) {
    return typeof value === 'string' ? value
      : (value !== null && typeof value === 'object' && typeof value.title === 'string' ? value.title : '')
  }
  async function source(args) {
    const sessionId = String(args?.sessionId || args?.sourceSessionId || '')
    if (!sessionId) throw new Error('缺少源 Session 身份')
    if (args?.sessionId && args?.sourceSessionId && args.sessionId !== args.sourceSessionId) throw new Error('源 Session 参数不一致')
    const chatId = await resolveChatId(sessionId)
    if (!chatId || (args?.sourceChatId && args.sourceChatId !== chatId)) throw new Error('源存档绑定已变化，请重新准备另存')
    return { sessionId, chatId }
  }
  /** 重新核 identity/revision/turn/boundary，并从**源会话原生标题**派生目标标题。 */
  async function verifiedPlan({ sessionId, chatId, args }) {
    // 原生标题只读读取必须早于 plan 重核、更早于 claim 写与任何 native fork：读不到就响亮失败，绝不回退卡名。
    const targetTitle = targetTitleOf(await readSourceSessionTitle(sessionId))
    const plan = await prepareFork(chatId, sessionId, args?.turn)
    if (plan.source?.id !== chatId || plan.source?.sessionId !== sessionId) throw new Error('分叉准备与源绑定不一致')
    if (!Number.isSafeInteger(plan.source._storageRevision) || plan.source._storageRevision < 0
      || !Number.isSafeInteger(plan.atSeq) || plan.atSeq < 0 || !Number.isSafeInteger(plan.turn) || plan.turn < 1) {
      throw new Error('分叉准备缺少真实的已完成回合边界')
    }
    if (args?.sourceRevision !== undefined && Number(args.sourceRevision) !== plan.source._storageRevision) throw new Error('源存档已变化，请重新准备另存')
    if (args?.atSeq !== undefined && Number(args.atSeq) !== plan.atSeq) throw new Error('源存档分叉边界已变化，请重新准备另存')
    if (args?.turn !== undefined && Number(args.turn) !== plan.turn) throw new Error('源存档回合已变化，请重新准备另存')
    return { plan, targetTitle }
  }
  /** 对外只给最小对象；token 绝不出现在 status/回执里（重试要求客户端当前持有 token）。 */
  function targetInfo(record) {
    return Object.freeze({ state: record.state, targetChatId: String(record.targetChatId || ''),
      targetSessionId: String(record.targetSessionId || ''), title: String(record.title || record.targetTitle || '') })
  }
  async function status(args) {
    const { sessionId, chatId } = await source(args)
    const result = await describeSaveFormat({ chats, chatId })
    const record = await forkRecords.read(chatId)
    if (!record) return { ...result, chatId, sessionId, forked: false, pending: false, text: formatSaveResult(result) }
    const info = targetInfo(record)
    const forked = record.state === 'complete'
    // 只读在位探测：只在记录里已有目标 Chat 时做（claimed/bound 还没有 chat，不查）。
    // 语义与 targetInfo 并列：**不改** forked/pending —— 目标 missing 不等于"没分叉过"，
    // 也绝不自动放行创建；显式释放是单独的用户动作（见 release()）。
    const state = info.targetChatId === '' ? 'unknown' : await targetChatState(info.targetChatId)
    const targetExists = state === 'present' ? true : (state === 'missing' ? false : undefined)
    return { ...result, chatId, sessionId, forked, pending: !forked, targetInfo: info, targetExists,
      recoverable: ['bound', 'created'].includes(record.state) && info.targetSessionId !== '' && info.targetSessionId !== sessionId,
      text: forked
        ? (targetExists === false
          ? '本源档的目标数据库存档已不存在（关系仍为完成）；如确需重新创建，请显式释放该完成关系——原生会话不由此动作删除'
          : '本源档已分叉到数据库存档（' + info.title + '）；原档未改动')
        : '本源档已有未完成的分叉记录（' + record.state + '）；请在当前页面用同一记录继续，禁止再次分叉' }
  }
  async function prepare(args) {
    const { sessionId, chatId } = await source(args)
    // 先做便宜的严格判定（只读原档 + 无既有记录），只有都通过才做重的 plan 重核。
    requireLegacyOriginal(await describeSaveFormat({ chats, chatId }), chatId)
    const record = await forkRecords.read(chatId)
    if (record) throw forkExists(record)
    // 命名 preflight 必须在**任何 claim 写之前**：命名服务没接线就先失败，绝不先占位再发现缺 title。
    await validateTargetNaming()
    const { plan, targetTitle } = await verifiedPlan({ sessionId, chatId, args })
    return { sourceChatId: chatId, sourceSessionId: sessionId,
      sourceRevision: plan.source._storageRevision, turn: plan.turn, atSeq: plan.atSeq, targetTitle }
  }
  /** 一次 native fork 之前的独占占位：源档必须仍是只读原档，且必须没有任何既有记录。 */
  async function claim(args) {
    const { sessionId, chatId } = await source(args)
    requireLegacyOriginal(await describeSaveFormat({ chats, chatId }), chatId)
    const record = await forkRecords.read(chatId)
    if (record) throw forkExists(record)
    // 同上：preflight 早于 claim 写（也早于 plan 重核），失败时不留任何记录、不产生新 SID。
    await validateTargetNaming()
    const { plan, targetTitle } = await verifiedPlan({ sessionId, chatId, args })
    if (args?.targetTitle !== undefined && String(args.targetTitle) !== targetTitle) throw new Error('准备结果已变化，请重新准备另存（目标标题不一致）')
    const claimed = await forkRecords.claim({ sourceChatId: chatId, sourceSessionId: sessionId,
      sourceRevision: plan.source._storageRevision, turn: plan.turn, atSeq: plan.atSeq, targetTitle })
    const stored = claimed?.record || claimed
    if (!stored?.token) throw new Error('分叉记录未返回 token，拒绝继续')
    return { token: stored.token, sourceChatId: chatId, sourceSessionId: sessionId,
      sourceRevision: plan.source._storageRevision, turn: plan.turn, atSeq: plan.atSeq,
      targetTitle: stored.targetTitle || targetTitle, state: stored.state }
  }
  async function finishResult(record, changed) {
    const result = await describeSaveFormat({ chats, chatId: record.targetChatId })
    requireOwnedSqlite(result, record.targetChatId)
    const title = String(record.title || record.targetTitle || '')
    return { ...result, changed, retry: !changed, chatId: record.targetChatId, sessionId: record.targetSessionId,
      sourceChatId: record.sourceChatId, sourceSessionId: record.sourceSessionId, title,
      fork: { chatId: record.targetChatId, sessionId: record.targetSessionId },
      text: changed ? formatSaveResult({ ...result, changed: true })
        : '本源档已分叉到数据库存档（' + title + '）；原档未改动' }
  }
  async function complete(args) {
    const token = String(args?.token || '')
    if (token === '') throw new Error('另存缺少分叉记录 token，请重新准备另存')
    const { sessionId, chatId } = await source(args)
    const target = String(args?.targetSessionId || '')
    if (!target || target === sessionId) throw new Error('另存必须使用新的原生分叉 Session')
    // 先按**持久记录**核对身份/计划，再允许复用同 token 的 inflight run：换 SID/换边界/换源一律拒，
    // 绝不复用别人的 run。
    const stored = await forkRecords.read(chatId)
    if (!stored) throw forkRecordError('DSH_TAVERN_FORK_RECORD_MISSING', '找不到本源档的分叉记录，请重新准备另存')
    if (stored.token !== token) throw forkRecordError('DSH_TAVERN_FORK_TOKEN_MISMATCH', '分叉记录 token 不一致，拒绝写入（记录已被另一次分叉占用）')
    if (String(stored.sourceSessionId || '') !== sessionId) throw new Error('源 Session 已变化，请重新准备另存')
    if (String(stored.targetSessionId || '') !== '' && String(stored.targetSessionId) !== target) {
      throw forkRecordError('DSH_TAVERN_FORK_TARGET_FROZEN', '本源档的目标 SID 已冻结为其他会话，拒绝改用新 SID')
    }
    checkPlanned(stored, args)
    const fingerprint = [chatId, sessionId, token, target, stored.sourceRevision, stored.turn, stored.atSeq].join('|')
    const pending = completing.get(token)
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new Error('同一 token 的并发另存参数不一致，拒绝复用同一次另存')
      return await pending.promise
    }
    const promise = runComplete({ token, sessionId, chatId, target })
    completing.set(token, { fingerprint, promise })
    try { return await promise } finally { completing.delete(token) }
  }
  async function runComplete({ token, sessionId, chatId, target }) {
    // ① 先永久冻结目标 SID（同 token 同 SID 幂等；换 SID 即拒），再进入 completeFork。
    const bound = await forkRecords.bind({ sourceChatId: chatId, token, targetSessionId: target })
    let record = bound?.record || bound
    if (record?.token !== token) throw forkRecordError('DSH_TAVERN_FORK_TOKEN_MISMATCH', '分叉记录 token 不一致，拒绝写入')
    if (String(record.sourceSessionId || '') !== sessionId) throw new Error('源 Session 已变化，请重新准备另存')
    // ② 已收口：只回执（仍强校验目标档是我们自己的 SQLite），绝不再次 rename（用户可能已经改名）。
    if (record.state === 'complete') return await finishResult(record, false)
    // ③ 目标 chat 精确恢复：publish 已成功但回执丢失时，绝不建第二个档。
    let targetChatId = String(record.targetChatId || '')
    if (targetChatId === '') {
      const mapped = String(await resolveChatId(target) || '')
      if (mapped !== '' && mapped === chatId) throw new Error('分叉记录指向源档本身，拒绝继续')
      if (mapped !== '') {
        const recovered = await chats.read(mapped)
        if (String(recovered?.id || '') !== mapped || String(recovered?.sessionId || '') !== target) throw new Error('分叉目标身份不一致，拒绝复用')
        if (String(recovered?.forkedFrom?.chatId || '') !== chatId) throw new Error('分叉目标不是本源档的分叉，拒绝复用')
        targetChatId = mapped
      }
    }
    // ④ 仅在恢复不出目标档时建档；参数取记录里的 plan，忽略客户端可漂移的副本。
    if (targetChatId === '') {
      const fork = await completeFork(chatId, sessionId, target, record.turn, record.sourceRevision, record.atSeq)
      targetChatId = String(fork?.chatId || fork?.id || '')
      if (!targetChatId || targetChatId === chatId) throw new Error('另存未生成独立的新存档')
      if (fork?.sessionId !== target) throw new Error('另存回执与原生分叉目标不一致')
    }
    // ⑤ 标记 created 之前必须拿到**权威** SQLite 判定：未验 DB 不允许 created，更不允许 rename。
    requireOwnedSqlite(await describeSaveFormat({ chats, chatId: targetChatId }), targetChatId)
    const marked = await forkRecords.created({ sourceChatId: chatId, token, targetSessionId: target, targetChatId })
    record = marked?.record || marked
    if (record?.token !== token) throw forkRecordError('DSH_TAVERN_FORK_TOKEN_MISMATCH', '分叉记录 token 不一致，拒绝写入')
    if (record.state === 'complete') return await finishResult(record, false)
    // ⑥ 标题：原生 rename（dep 负责 flush）只接受 string / {title:string} 且必须带 DB. 前缀；再写目标档
    //    title（dep 负责严格 registry sync）；最后收口。
    const accepted = acceptedTitleOf(await renameTargetSession(target, record.targetTitle))
    if (accepted.trim() === '') throw new Error('原生分叉标题未被接受（只接受 string 或 {title:string}），拒绝写入目标档标题')
    if (!accepted.startsWith('DB.')) throw new Error('原生分叉标题未带 DB. 前缀，拒绝写入目标档标题')
    await setTargetChatTitle(targetChatId, accepted)
    const finished = await forkRecords.finish({ sourceChatId: chatId, token, title: accepted })
    const final = finished?.record || finished
    if (final?.token !== token) throw forkRecordError('DSH_TAVERN_FORK_TOKEN_MISMATCH', '分叉记录 token 不一致，拒绝收口')
    return await finishResult(final, true)
  }
  /**
   * 显式释放（用户点「重新创建」的唯一入口，2026-10-01 定稿）：
   * **只**处理"记录确为 complete 且目标 Chat 被确证不存在"的精确关系，释放后源档可再次显式分叉。
   *
   * 逐条硬判（全只读通过后才写，任一不满足即拒）：
   *   ① 源仍是只读原档（顺带当"chats 根可用"互锁：根不可用时源自己就先失败，不会把"全空"误判成目标已删）；
   *   ② 记录存在；③ `state === 'complete'` —— claimed（SID 回执未知）/bound（SID 已冻结）/created
   *   一律拒绝：未知/未完成不是"不存在"，禁止自动重置；
   *   ④ targetChatId / targetSessionId 非空，且客户端回显的 tuple 必须逐字段等于记录（防陈旧 UI 删错关系）；
   *   ⑤ 目标必须由 `DSH_TAVERN_SAVE_NOT_FOUND` **确证** missing（在位/读取失败/权限/损坏/非本存储 ⇒ 拒绝）。
   *
   * 本动作**不调用任何原生接口**：不 observe/resume/adopt 旧 SID、不删原生会话、不动 legacy_bindings、
   * 不改源档；写只有 legacy_fork_records 的单条 SQL CAS。旧 SID 只出现在回执里，谁都不许再 claim 它；
   * 下一次创建由宿主分配**新的** SID（因此不会命中"已冻结为其他会话"）。
   */
  async function release(args) {
    const { sessionId, chatId } = await source(args)
    requireLegacyOriginal(await describeSaveFormat({ chats, chatId }), chatId)
    const record = await forkRecords.read(chatId)
    if (!record) throw forkRecordError('DSH_TAVERN_FORK_RECORD_MISSING', '找不到本源档的分叉记录，无需释放')
    if (record.state !== 'complete') {
      throw forkRecordError('DSH_TAVERN_FORK_RELEASE_NOT_COMPLETE',
        '本源档的分叉记录状态是 ' + record.state + '，不是已完成；拒绝释放（未知/未完成回执必须人工核实，禁止自动重置）')
    }
    const targetChatId = String(record.targetChatId || '')
    const targetSessionId = String(record.targetSessionId || '')
    if (targetChatId === '' || targetSessionId === '') throw new Error('完成关系缺少目标 Chat/SID，拒绝释放')
    if (String(args?.targetChatId ?? '') !== targetChatId || String(args?.targetSessionId ?? '') !== targetSessionId) {
      throw new Error('释放参数与记录里的目标不一致（需要 targetChatId + targetSessionId 回显），拒绝释放')
    }
    if (await targetChatState(targetChatId) !== 'missing') {
      throw new Error('目标数据库存档仍存在或无法确认（不是"确证不存在"），拒绝释放')
    }
    const released = await forkRecords.release({ sourceChatId: chatId, targetChatId, targetSessionId })
    const removed = targetInfo(released?.removed || released?.record || released)
    return { released: true, changed: true, chatId, sessionId, sourceChatId: chatId, sourceSessionId: sessionId,
      removed, targetExists: false,
      text: '已释放该源档的“已完成”分叉关系（' + removed.title + '，目标 SID ' + removed.targetSessionId +
        '）；原生会话不由此动作删除。现在可以重新点击创建新的数据库分叉。' }
  }
  async function variables(args) {
    if (typeof queryVariables !== 'function' || typeof formatVariableResult !== 'function') throw new Error('只读变量接口未接入')
    const { sessionId, chatId } = await source(args)
    const result = await queryVariables({ chats, chatId, args: {
      action: args?.action, path: args?.path, query: args?.query, limit: args?.limit, cursor: args?.cursor
    } })
    return { ...result, chatId, sessionId, text: formatVariableResult(result) }
  }
  // 显式恢复仅消费持久冻结的SID/计划，token留Host；不claim/native fork。
  async function recover(args) {
    const { sessionId, chatId } = await source(args)
    requireLegacyOriginal(await describeSaveFormat({ chats, chatId }), chatId)
    const record = await forkRecords.read(chatId)
    if (!record || !['bound', 'created'].includes(record.state) || !record.targetSessionId || record.targetSessionId === sessionId) throw new Error('分叉回执尚未冻结或已完成，不能猜测恢复或重新创建')
    if (record.sourceSessionId !== sessionId || args?.targetSessionId !== record.targetSessionId) throw new Error('恢复目标与持久冻结记录不一致')
    return await complete({ sessionId, sourceChatId: chatId, sourceSessionId: sessionId,
      token: record.token, targetSessionId: record.targetSessionId, sourceRevision: record.sourceRevision, turn: record.turn, atSeq: record.atSeq })
  }
  return Object.freeze({ status, prepare, claim, complete, recover, release, variables })
}
