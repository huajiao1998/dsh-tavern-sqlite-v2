// 定向离线闸：只读身份信封、观察 lease、service 编排；无真实档读取、无网络、无 Agent。
import assert from 'node:assert/strict'
import { createLegacyViewSeams, withObservedForkSource, createLegacySaveActions } from '../lib/legacy-view-seams.js'

const binding = { chatId: 'chat-source', sessionId: 'session-genuine', originalSessionId: 'session-rebound' }
const raw = { id: binding.chatId, sessionId: binding.originalSessionId, nativeOpeningAppended: false,
  macroState: { userName: 'User' }, messages: [{ role: 'assistant', text: '原始正文' }] }
const before = structuredClone(raw)
const seams = createLegacyViewSeams({
  bindingForChat: id => id === binding.chatId ? binding : undefined,
  overlayLinks: links => Object.fromEntries([...Object.entries(links).filter(([, id]) => id !== binding.chatId), [binding.sessionId, binding.chatId]]),
  projectEnvelope: chat => ({ ...chat, sessionId: binding.sessionId }),
  isLegacyChat: id => id === binding.chatId
})
let writes = 0
const methods = ['read', 'readRevision', 'readSessionState', 'readSceneImageState', 'readBackgroundConfig', 'readDisplayRuntimeState',
  'readWindow', 'readSlice', 'readSettlementBase', 'readChangedSlice', 'readViewDelta']
const rawStore = Object.fromEntries(methods.map(name => [name, async () => name.includes('Window') || name.includes('Slice') || name.includes('Delta')
  ? { chat: raw, indices: [0], revision: 9 } : raw]))
Object.assign(rawStore, { update: () => writes++, patch: () => writes++, remove: () => writes++, write: () => writes++, version: () => 'legacy:1:2' })
const store = seams.wrapStore(rawStore)
for (const name of methods) {
  const result = await store[name](binding.chatId)
  const chat = result.chat || result
  assert.equal(chat.sessionId, binding.sessionId, name + ' 必须映射有效身份')
  assert.notEqual(chat, raw)
  assert.equal(chat.messages, raw.messages, name + ' 不复制大正文')
  assert.notEqual(chat.macroState, raw.macroState, 'normalize 可写骨架必须脱离')
  assert.equal(chat.nativeOpeningAppended, false, '不得伪造开场标记')
  chat.macroState.userName = '你'
}
assert.deepEqual(raw, before, '所有读取不得修改缓存原档')
for (const name of ['update', 'patch', 'remove']) assert.throws(() => store[name](binding.chatId), /原件只读/)
assert.throws(() => store.write(raw), /原件只读/)
assert.equal(writes, 0)
store.update('chat-new'); assert.equal(writes, 1, '新档不受原件 guard 影响')
assert.equal(store.version(), 'legacy:1:2')
const links = { [binding.originalSessionId]: binding.chatId, 'session-normal': 'chat-normal' }
assert.deepEqual(seams.links(links), { [binding.sessionId]: binding.chatId, 'session-normal': 'chat-normal' })
assert.deepEqual(links, { [binding.originalSessionId]: binding.chatId, 'session-normal': 'chat-normal' })
assert.throws(() => seams.envelope({ ...raw, sessionId: 'session-unrelated' }), /身份不一致/)
assert.equal(seams.envelope(undefined), undefined)
const ordinary = { id: 'chat-new', sessionId: 'session-new' }
assert.equal(seams.envelope(ordinary), ordinary)
const unboundLegacy = createLegacyViewSeams({ bindingForChat: () => undefined, overlayLinks: value => value,
  projectEnvelope: value => value, isLegacyChat: () => true })
const extractRaw = { id: 'chat-unbound', sessionId: 'session-original', mode: 'extract', extract: { draft: { name: '卡片' } } }
const extractView = unboundLegacy.envelope(extractRaw)
assert.notEqual(extractView, extractRaw); assert.notEqual(extractView.extract, extractRaw.extract)
extractView.workspace = extractView.extract; extractView.workspace.mountedResources = []; delete extractView.extract
assert.equal(extractRaw.extract.mountedResources, undefined, 'extract→workspace normalize不得修改原骨架')
const corrupt = createLegacyViewSeams({ bindingForChat: () => binding, overlayLinks: value => value,
  projectEnvelope: chat => ({ ...chat, sessionId: binding.sessionId, nativeOpeningAppended: true }), isLegacyChat: () => true })
assert.throws(() => corrupt.envelope(raw), /不得合成/)

const events = Object.freeze([{ seq: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
let disposed = 0, observed = 0
const query = { observeSession: async (id, options) => {
  assert.equal(id, binding.sessionId); assert.deepEqual(options, { projectionMode: 'none' }); observed++
  return { header: { id }, events, [Symbol.dispose]: () => disposed++ }
} }
const boundary = await withObservedForkSource({ query, sessionId: binding.sessionId, work: reader => {
  assert.equal(reader.events, events); assert.equal(reader.id, binding.sessionId)
  assert.equal(Object.isFrozen(reader), true); assert.equal(reader.append, undefined); return reader.events.at(-1).seq
} })
assert.equal(boundary, 0); assert.equal(observed, 1); assert.equal(disposed, 1)
await assert.rejects(() => withObservedForkSource({ query, sessionId: binding.sessionId, work: () => { throw new Error('边界失败') } }), /边界失败/)
assert.equal(disposed, 2, '边界失败也必须释放观察')
await assert.rejects(() => withObservedForkSource({ query: { observeSession: async () => ({ header: { id: 'bad' }, events, [Symbol.dispose]: () => disposed++ }) }, sessionId: binding.sessionId, work: () => 0 }), /身份不一致/)
assert.equal(disposed, 3)

let completed = 0, prepared = 0, variableReads = 0
const dbSession = 'session-db-source', dbChat = 'chat-db-source', aliasSession = 'session-alias'
// 严格判据要求 migrated=false 且 readonly=true / migrated=true 且 legacy=false、readonly=false 都在位。
const formats = new Map([
  [binding.chatId, { legacy: true, migrated: false, readonly: true, stamp: 'legacy:1:2' }],
  [dbChat, { legacy: false, migrated: true, readonly: false, stamp: 'sqlite:gen:9' }],
  ['chat-fork', { legacy: false, migrated: true, readonly: false, stamp: 'sqlite:gen:1' }]
])
const renamed = [], titleWrites = []
// 内存版分叉记录：形态与 lib/legacy-fork-records.js 的 CAS 契约一致（真实 SQLite 版在
// test/legacy-fork-records.test.mjs 覆盖），这里只验证 service 的编排。
const forks = new Map()
const forkCalls = { claim: 0, bind: 0, created: 0, finish: 0, release: 0 }
let tokenSeq = 0
const forkFail = (code, message) => { const error = new Error(message); error.code = code; return error }
function forkRecordOf(chatId, token) {
  const record = forks.get(chatId)
  if (!record) throw forkFail('DSH_TAVERN_FORK_RECORD_MISSING', '找不到本源档的分叉记录')
  if (record.token !== token) throw forkFail('DSH_TAVERN_FORK_TOKEN_MISMATCH', '分叉记录 token 不一致，拒绝写入')
  return record
}
const forkRecords = {
  read: chatId => forks.get(chatId) ? { ...forks.get(chatId) } : undefined,
  claim: plan => {
    forkCalls.claim++
    if (forks.has(plan.sourceChatId)) throw forkFail('DSH_TAVERN_FORK_RECORD_EXISTS', '本源档已有分叉记录（' + forks.get(plan.sourceChatId).state + '），拒绝再次 claim')
    const record = { ...plan, token: 'token-' + (++tokenSeq), state: 'claimed', targetSessionId: '', targetChatId: '', title: '' }
    forks.set(plan.sourceChatId, record)
    return { record: { ...record }, changed: true }
  },
  bind: ({ sourceChatId, token, targetSessionId }) => {
    forkCalls.bind++
    const record = forkRecordOf(sourceChatId, token)
    if (record.state !== 'claimed') {
      if (record.targetSessionId !== targetSessionId) throw forkFail('DSH_TAVERN_FORK_TARGET_FROZEN', '本源档的目标 SID 已冻结为其他会话，拒绝改用新 SID')
      return { record: { ...record }, changed: false }
    }
    record.state = 'bound'; record.targetSessionId = targetSessionId
    return { record: { ...record }, changed: true }
  },
  created: ({ sourceChatId, token, targetSessionId, targetChatId }) => {
    forkCalls.created++
    const record = forkRecordOf(sourceChatId, token)
    if (record.targetSessionId !== targetSessionId || (record.targetChatId !== '' && record.targetChatId !== targetChatId)) throw forkFail('DSH_TAVERN_FORK_CREATED_CONFLICT', '分叉记录已持久化其他目标，拒绝改写')
    if (record.state === 'created' || record.state === 'complete') return { record: { ...record }, changed: false }
    if (record.state !== 'bound') throw forkFail('DSH_TAVERN_FORK_STATE_CONFLICT', '分叉记录状态不是 bound，拒绝标记 created')
    record.state = 'created'; record.targetChatId = targetChatId
    return { record: { ...record }, changed: true }
  },
  finish: ({ sourceChatId, token, title }) => {
    forkCalls.finish++
    const record = forkRecordOf(sourceChatId, token)
    if (record.state === 'complete') return { record: { ...record }, changed: false }
    if (record.state !== 'created') throw forkFail('DSH_TAVERN_FORK_STATE_CONFLICT', '分叉记录状态不是 created，拒绝收口')
    record.state = 'complete'; record.title = title
    return { record: { ...record }, changed: true }
  },
  release: ({ sourceChatId, targetChatId, targetSessionId }) => {
    forkCalls.release++
    const record = forks.get(sourceChatId)
    if (!record) throw forkFail('DSH_TAVERN_FORK_RECORD_MISSING', '找不到本源档的分叉记录，无需释放')
    if (record.state !== 'complete') throw forkFail('DSH_TAVERN_FORK_RELEASE_NOT_COMPLETE', '分叉记录状态是 ' + record.state + '，不是 complete，拒绝释放')
    if (record.targetChatId !== targetChatId || record.targetSessionId !== targetSessionId) throw forkFail('DSH_TAVERN_FORK_RELEASE_TARGET_MISMATCH', '释放参数与记录里的目标不一致，拒绝释放')
    forks.delete(sourceChatId)
    return { record: { ...record }, removed: { ...record }, changed: true }
  },
}
const serviceDeps = {
  chats: store,
  resolveChatId: async id => id === binding.sessionId || id === aliasSession ? binding.chatId : (id === dbSession ? dbChat : ''),
  prepareFork: async (chatId, sessionId) => { prepared++; return { source: { id: chatId, sessionId, _storageRevision: 7, title: '原件名' }, turn: 1, atSeq: 0 } },
  completeFork: async (...args) => { assert.deepEqual(args, [binding.chatId, binding.sessionId, 'session-fork', 1, 7, 0]); completed++; return { chatId: 'chat-fork', sessionId: 'session-fork' } },
  // 真身 describeSaveFormat 对"档不存在"抛 DSH_TAVERN_SAVE_NOT_FOUND；替身必须同形，
  // 另给一个 unknown 哨兵模拟"读取失败/权限/损坏"（必须与 missing 区分）。
  describeSaveFormat: async ({ chats, chatId }) => {
    assert.equal(chats, store)
    const format = formats.get(chatId)
    if (format === undefined) {
      const error = new Error('找不到本局存档（chatId=' + chatId + '）')
      error.code = 'DSH_TAVERN_SAVE_NOT_FOUND'
      throw error
    }
    if (format.unknown === true) throw new Error('读存档格式失败（权限/损坏）')
    return format
  },
  formatSaveResult: result => result.migrated ? '已使用数据库存档' : '原件只读',
  forkRecords,
  // 目标标题的唯一权威：源会话**原生标题**（宿主折叠的 session/title），不是聊天档 title / 卡名。
  readSourceSessionTitle: async sessionId => { assert.equal(sessionId, binding.sessionId); return '原件名' },
  renameTargetSession: async (sessionId, title) => { renamed.push([sessionId, title]); return title },
  setTargetChatTitle: async (chatId, title) => { titleWrites.push([chatId, title]); return title },
  queryVariables: async ({ chatId, args }) => { assert.equal(chatId, binding.chatId); assert.equal(args.action, 'read'); variableReads++; return { available: true, value: 9 } },
  formatVariableResult: () => '变量只读',
  validateTargetNaming: async () => {}
}
const service = createLegacySaveActions(serviceDeps)
const status = await service.status({ sessionId: binding.sessionId })
assert.equal(status.legacy, true); assert.equal(status.text, '原件只读'); assert.equal(prepared, 0); assert.equal(completed, 0)
assert.equal(status.forked, false); assert.equal(status.pending, false)
// 严格源判据：数据库档不能走另存；且必须在重 plan 之前就被拒（不得调用 prepareFork）。
await assert.rejects(() => service.prepare({ sessionId: dbSession }), /只有只读原档/)
await assert.rejects(() => service.claim({ sessionId: dbSession }), /只有只读原档/)
assert.equal(prepared, 0, '非原档必须在 prepareFork 之前就被拒')
// 新目标派生严格保留**原生标题**的字节，不擅自 trim；既有 DB. 前缀保持幂等。
for (const title of ['  原名 ', 'DB.已有名', 'DB.已有名 ']) {
  const names = createLegacySaveActions({ ...serviceDeps, readSourceSessionTitle: async () => title })
  const named = await names.prepare({ sessionId: binding.sessionId })
  assert.equal(named.targetTitle, title.startsWith('DB.') ? title : 'DB.' + title)
}
// 卡名 / 聊天档 title 都不是标题权威：2026-10-01 实测曾回退卡名 → 新分叉被命名成
// `DB.重回1980-2020年代创业增量版`，而源会话原生标题是 `2004年大学生商海推演`（源事件 seq27）。
const cardNamed = createLegacySaveActions({ ...serviceDeps,
  readSourceSessionTitle: async () => '2004年大学生商海推演',
  prepareFork: async (chatId, sessionId) => ({ source: { id: chatId, sessionId, _storageRevision: 7, title: '重回1980-2020年代创业增量版', cardName: '重回1980-2020年代创业增量版' }, turn: 1, atSeq: 0 }) })
assert.equal((await cardNamed.prepare({ sessionId: binding.sessionId })).targetTitle, 'DB.2004年大学生商海推演')
// 缺真实原生标题：必须在 prepareFork / claim 之前响亮失败——不回退卡名、不写记录、不建分叉。
const preparedBeforeMissingTitle = prepared
const missingTitle = createLegacySaveActions({ ...serviceDeps, readSourceSessionTitle: async () => '' })
await assert.rejects(() => missingTitle.prepare({ sessionId: binding.sessionId }), /没有可用的原生标题/)
assert.equal(prepared, preparedBeforeMissingTitle, '缺原生标题必须早于 plan 重核（更早于 native fork）失败')
await assert.rejects(() => missingTitle.claim({ sessionId: binding.sessionId }), /没有可用的原生标题/)
assert.equal(forks.size, 0, '缺原生标题不得落 claim 记录')
const plan = await service.prepare({ sessionId: binding.sessionId })
assert.deepEqual(plan, { sourceChatId: binding.chatId, sourceSessionId: binding.sessionId, sourceRevision: 7, turn: 1, atSeq: 0, targetTitle: 'DB.原件名' })
// claim：客户端副本标题只用于核对；核对失败不得落记录；源档必须仍是只读原档。
await assert.rejects(() => service.claim({ ...plan, sessionId: binding.sessionId, targetTitle: 'DB.伪造' }), /标题不一致/)
assert.equal(forks.size, 0, '核对失败不得落 claim 记录')
const claim = await service.claim({ ...plan, sessionId: binding.sessionId })
assert.equal(claim.state, 'claimed'); assert.equal(claim.token, 'token-1'); assert.equal(claim.targetTitle, 'DB.原件名')
assert.equal(forks.get(binding.chatId).state, 'claimed')
// 一个源档只能有一次 native fork：既有记录**先查**即拒，连重 plan 都不做（更不许 fork）。
const preparedBeforeDuplicates = prepared
await assert.rejects(() => service.prepare({ sessionId: binding.sessionId }), /拒绝再次分叉|拒绝重复创建/)
await assert.rejects(() => service.claim({ ...plan, sessionId: binding.sessionId }), /已有.*分叉记录|已经分叉过/)
assert.equal(prepared, preparedBeforeDuplicates, '既有记录必须先于重 plan 被拒')
assert.equal(completed, 0, 'claim 阶段绝不能已经 fork')
const result = await service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork' })
assert.equal(result.chatId, 'chat-fork'); assert.equal(result.sourceSessionId, binding.sessionId); assert.equal(result.migrated, true); assert.equal(completed, 1)
assert.equal(result.title, 'DB.原件名'); assert.equal(result.changed, true)
assert.deepEqual(renamed, [['session-fork', 'DB.原件名']], '原生标题由 dep rename 并返回 accepted')
assert.deepEqual(titleWrites, [['chat-fork', 'DB.原件名']], '目标档标题必须用 accepted 字符串')
assert.deepEqual([forkCalls.bind, forkCalls.created, forkCalls.finish], [1, 1, 1])
const after = await service.status({ sessionId: binding.sessionId })
assert.equal(after.forked, true); assert.equal(after.pending, false)
assert.deepEqual(after.targetInfo, { state: 'complete', targetChatId: 'chat-fork', targetSessionId: 'session-fork', title: 'DB.原件名' })
assert.equal(JSON.stringify(after).includes('token-1'), false, 'status 不得泄露 token')
const retry = await service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork' })
assert.equal(retry.changed, false); assert.equal(retry.retry, true)
assert.equal(completed, 1, '已收口重试不得再次 completeFork')
assert.equal(renamed.length, 1, '已收口重试不得再次 rename（用户可能已改名）')
const vars = await service.variables({ sessionId: binding.sessionId, action: 'read', path: '/x' })
assert.equal(vars.value, 9); assert.equal(vars.text, '变量只读'); assert.equal(variableReads, 1); assert.equal(writes, 1)
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: binding.sessionId }), /新的原生分叉/)
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-other' }), /已冻结/)
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork', token: 'token-other' }), /token 不一致/)
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork', token: '' }), /缺少分叉记录 token/)
await assert.rejects(() => service.complete({ ...claim, targetSessionId: 'session-fork', sourceChatId: 'chat-changed' }), /绑定已变化/)
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork', sourceRevision: -1 }), /源存档已变化/)
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, sourceSessionId: 'session-unrelated', targetSessionId: 'session-fork' }), /参数不一致/)
await assert.rejects(() => service.complete({ ...claim, sessionId: aliasSession, sourceSessionId: aliasSession, targetSessionId: 'session-fork' }), /源 Session 已变化/)
assert.equal(completed, 1, '验证失败不得进入 completeFork')
// 已收口重试仍要强校验目标档；不是我们自己的 SQLite 一律拒（且不得再 rename）。
formats.set('chat-fork', { legacy: true, migrated: false, readonly: true, stamp: 'legacy:1:2' })
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork' }), /后置校验失败/)
assert.equal(completed, 1, '后置校验失败不得再次 completeFork')
assert.equal(renamed.length, 1, '后置校验失败不得再次 rename')
// 严格 stamp：sqlite 前缀但形状不对（非 gen 正则）也必须拒。
formats.set('chat-fork', { legacy: false, migrated: true, readonly: false, stamp: 'sqlite:whatever' })
await assert.rejects(() => service.complete({ ...claim, sessionId: binding.sessionId, targetSessionId: 'session-fork' }), /后置校验失败/)
// 去重记录是硬依赖：缺失一律响亮失败，绝不静默退回"无去重"旧路径。
const { forkRecords: ignoredRecords, ...withoutRecords } = serviceDeps
assert.throws(() => createLegacySaveActions(withoutRecords), /缺少 forkRecords/)
assert.throws(() => createLegacySaveActions({ ...withoutRecords, forkRecords: {} }), /forkRecords 缺少 read/)
assert.throws(() => createLegacySaveActions({ ...serviceDeps, renameTargetSession: undefined }), /缺少 renameTargetSession/)
assert.throws(() => createLegacySaveActions({ ...serviceDeps, readSourceSessionTitle: undefined }), /缺少 readSourceSessionTitle/)
assert.throws(() => createLegacySaveActions({ ...serviceDeps, setTargetChatTitle: undefined }), /缺少 setTargetChatTitle/)
assert.throws(() => createLegacySaveActions({ ...serviceDeps, validateTargetNaming: undefined }), /缺少 validateTargetNaming/)
// ── 显式释放：status 只报事实（不改 forked/pending），release 只放行"完成 + 目标确证 missing" ─────
const releaseArgs = { sessionId: binding.sessionId, targetChatId: 'chat-fork', targetSessionId: 'session-fork' }
formats.delete('chat-fork')
let releaseStatus = await service.status({ sessionId: binding.sessionId })
assert.equal(releaseStatus.forked, true, '目标 missing 不得把完成关系降级为"未分叉"')
assert.equal(releaseStatus.pending, false)
assert.equal(releaseStatus.targetExists, false)
assert.deepEqual(releaseStatus.targetInfo, { state: 'complete', targetChatId: 'chat-fork', targetSessionId: 'session-fork', title: 'DB.原件名' })
assert.match(releaseStatus.text, /已不存在|显式释放/)
// 未知（读取失败/权限/损坏）绝不等于 missing：status 报 undefined，release 一律拒
formats.set('chat-fork', { unknown: true })
assert.equal((await service.status({ sessionId: binding.sessionId })).targetExists, undefined, '未知必须回报未知')
await assert.rejects(() => service.release(releaseArgs), /仍存在或无法确认/)
// 目标仍在 ⇒ 拒绝释放（在位判定为 true）
formats.set('chat-fork', { legacy: false, migrated: true, readonly: false, stamp: 'sqlite:gen:1' })
assert.equal((await service.status({ sessionId: binding.sessionId })).targetExists, true)
await assert.rejects(() => service.release(releaseArgs), /仍存在或无法确认/)
// tuple 必须回显（缺失/不符都拒）；拒绝路径不得改动记录
await assert.rejects(() => service.release({ sessionId: binding.sessionId, targetChatId: 'chat-fork' }), /不一致/)
await assert.rejects(() => service.release({ sessionId: binding.sessionId, targetChatId: 'chat-fork', targetSessionId: 'session-other' }), /不一致/)
assert.equal(forks.get(binding.chatId).state, 'complete', '拒绝路径不得改动记录')
assert.equal(forkCalls.release, 0, '拒绝必须在写之前发生')
// 目标确证 missing ⇒ 放行；单条 CAS 只删精确一行
formats.delete('chat-fork')
const releasedResult = await service.release(releaseArgs)
assert.equal(releasedResult.released, true); assert.equal(releasedResult.changed, true); assert.equal(releasedResult.targetExists, false)
assert.equal(releasedResult.chatId, binding.chatId); assert.equal(releasedResult.sessionId, binding.sessionId)
assert.deepEqual(releasedResult.removed, { state: 'complete', targetChatId: 'chat-fork', targetSessionId: 'session-fork', title: 'DB.原件名' })
assert.match(releasedResult.text, /原生会话不由此动作删除/)
assert.equal(JSON.stringify(releasedResult).includes(claim.token), false, '释放回执不得泄露 token')
assert.equal(forks.has(binding.chatId), false, '释放后记录必须消失')
releaseStatus = await service.status({ sessionId: binding.sessionId })
assert.equal(releaseStatus.forked, false); assert.equal(releaseStatus.pending, false)
assert.equal(releaseStatus.targetExists, undefined, '无记录时不报在位状态')
assert.equal(completed, 1, '释放绝不调用 completeFork')
assert.equal(renamed.length, 1, '释放绝不 rename')
assert.deepEqual(titleWrites, [['chat-fork', 'DB.原件名']], '释放绝不写目标档标题')
// claimed 没有出口（未知回执必须人工核实）
const reclaim = await service.claim({ ...plan, sessionId: binding.sessionId })
assert.equal(reclaim.state, 'claimed')
await assert.rejects(() => service.release(releaseArgs), /不是已完成/)
assert.equal(forks.get(binding.chatId).state, 'claimed', 'claimed 不得被释放')
forks.delete(binding.chatId)
console.log('legacy-view-seams：读取/写闸/观察释放/另存（claim→冻结 SID→建档→标题→收口）与变量/状态在位/显式释放定向断言全部通过')
