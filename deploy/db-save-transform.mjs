// 最新原存档按钮的最小Host接缝：保留RPC/传输名，替换引擎，不重走原版revision历史。
export const DB_SAVE_MARKER = '// [dsh-tavern-db-save:v1]'
export const DB_SAVE_DELETE_ANCHOR = '  async function deleteChat(chatId) {'
const DB_SAVE_DELETE_CALL = "    if (footprint) footprint.items.push(...ctx.get('sessionPersistence').dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId, ...(footprint.backgroundSessionIds || [])], chatJournalStore.rollbackArchivePath(chatId)))\n"
const DB_SAVE_REQUIRED = ['const dbSaveExchange = createDbSaveExchange({', 'const dbSaveRegistration = createDbSaveRegistration({ store: profileData })', 'unpublish: identity => dbSaveRegistration.discard(identity)', 'return await dbSaveExchange.exportGameSave(sessionId, options)', 'return await dbSaveExchange.importGameSave(args)', 'resources: dbSaveResources,', 'const dbSaveResources = createDbSaveResourceTransfer({', "validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }", 'await tavernScriptHostAdapter.whenIdle(chat.sessionId)']
const DB_SAVE_DELETE_REQUIRED = 'dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId'
function unique(source, text, label) {
  const count = source.split(text).length - 1
  if (count !== 1) throw Error('DB交换接缝锚点不唯一：' + label + '（' + count + '）')
  return source.indexOf(text)
}
// 删局消费是可选模块：仅当源里存在真实 deleteChat 时接入（旧版本/最小夹具无删局源则原样返回，保持兼容）。
export function applyDbSaveDeleteTransform(source) {
  if (!source.includes(DB_SAVE_DELETE_ANCHOR)) return source
  if (source.includes(DB_SAVE_DELETE_CALL)) return source
  const point = unique(source, '    const result = await conversationRegistry.remove(chatId)', '原删局登记点')
  return source.slice(0, point) + DB_SAVE_DELETE_CALL + source.slice(point)
}
export function applyDbSaveHostTransform(source) {
  if (source.includes(DB_SAVE_MARKER)) {
    // 旧 v1 标记源允许升级：先补删局消费，再按是否含 deleteChat 做必需消费者校验（缺项即 fail-closed）。
    const oldCardValidation = "validateCard: payload => cardPreparation.project(cardPreparation.create({ kind: 'import', payload }))"
    const currentCardValidation = DB_SAVE_REQUIRED.find(item => item.startsWith('validateCard:'))
    const upgraded = applyDbSaveDeleteTransform(source.includes(oldCardValidation) ? source.replace(oldCardValidation, currentCardValidation) : source)
    const required = [...DB_SAVE_REQUIRED, ...(upgraded.includes(DB_SAVE_DELETE_ANCHOR) ? [DB_SAVE_DELETE_REQUIRED] : [])]
    for (const item of required) if (!upgraded.includes(item)) throw Error('DB交换接缝标记存在但消费者缺失：' + item)
    return upgraded
  }
  const exportStart = '  async function exportGameSave(sessionId, options = {}) {'
  const exportEnd = '  // Imports always create a new game:'
  const importStart = '  async function importGameSave(args) {'
  const importEnd = '    } finally { importingGameSaves.delete(sourceChatId) }\n  }'
  let next = source
  let start = unique(next, exportStart, '原导出函数'), end = unique(next, exportEnd, '原导出尾')
  if (end < start) throw Error('DB交换原导出布局顺序错误')
  next = next.slice(0, start) + '  async function exportGameSave(sessionId, options = {}) {\n    return await dbSaveExchange.exportGameSave(sessionId, options)\n  }\n' + next.slice(end)
  start = unique(next, importStart, '原导入函数'); end = unique(next, importEnd, '原导入尾') + importEnd.length
  if (end < start) throw Error('DB交换原导入布局顺序错误')
  next = next.slice(0, start) + '  async function importGameSave(args) {\n    return await dbSaveExchange.importGameSave(args)\n  }' + next.slice(end)
  const initialization = `  const dbSaveRegistration = createDbSaveRegistration({ store: profileData })
  const dbSaveResources = createDbSaveResourceTransfer({
    fileResources, profileData, gameFootprint, attachments: ctx.get('attachments'),
    readChatCard, importCard, computeSceneTarget,
    validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }
  })
  const dbSaveExchange = createDbSaveExchange({
    resources: dbSaveResources,
    chatStore: chatJournalStore, chatForSession, readChat, dataRoot,
    persistence: () => ctx.get('sessionPersistence'), sessions: sessionStore, agents: agentRegistry,
    ownsSession: ownsBackgroundSession, assertForkable: assertConversationForkable,
    whenIdle: async chat => {
      await foregroundHandoff.whenIdle(chat.sessionId)
      await templateSync.whenIdle(chat.sessionId)
      await candidateWorldbookPreparation.whenIdle(chat.sessionId)
      await tavernScriptHostAdapter.whenIdle(chat.sessionId)
      await autoCompaction?.whenIdle(chat.id)
    },
    publish: chat => conversationRegistry.publish(chat),
    unpublish: identity => dbSaveRegistration.discard(identity),
    attach: async id => {
      const workspace = await ctx.get('workspaceRegistry')?.resolveByPath(path.join(dataRoot, 'resources'))
      if (typeof workspace?.attachSession !== 'function') throw Error('DB导入缺少已登记资源工作区，不创建半可玩目标')
      await workspace.attachSession(id)
    },
    detach: async id => {
      const workspace = await ctx.get('workspaceRegistry')?.resolveByPath(path.join(dataRoot, 'resources'))
      if (typeof workspace?.detachSession !== 'function') throw Error('DB导入失败清理缺少工作区detach')
      await workspace.detachSession(id)
    }
  })
`
  const point = unique(next, '  const importingGameSaves = new Set()', '引擎依赖装配')
  next = next.slice(0, point) + initialization + next.slice(point)
  return "import { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } from './domain/storage-db-save.js'\n" + DB_SAVE_MARKER + '\n' + applyDbSaveDeleteTransform(next)
}
// 0.3.4：延后删除足迹接缝——复用作者既有 pending 队列，仅扩**只读 SQL 路径核验**；不改队列格式、不换 root、不新增存储。
export const DB_SAVE_FOOTPRINT_MARKER = '// [dsh-tavern-db-save-footprint:v1]'
const FOOTPRINT_FACTORY_ANCHOR = "export function createGameFootprint({ dataRoot, sessionsRoot = path.join(path.dirname(dataRoot), 'sessions') }) {"
const FOOTPRINT_FACTORY_PATCHED = "export function createGameFootprint({ dataRoot, sessionsRoot = path.join(path.dirname(dataRoot), 'sessions'), canDeleteDeferredPath }) {"
const FOOTPRINT_LEFTOVER_ANCHOR = "      if (!resolved.startsWith(root + path.sep) && !resolved.startsWith(path.resolve(sessionsRoot) + path.sep)) continue"
// 先算 sqlTarget（原 root 范围内也调用：active 必须 throw 保 pending），再 original 允许 || sqlTarget；不尾追 && 只在 outside 才 guard。
const FOOTPRINT_LEFTOVER_PATCHED = "      const sqlTarget = canDeleteDeferredPath === undefined ? false : canDeleteDeferredPath(resolved) === true\n      if (!resolved.startsWith(root + path.sep) && !resolved.startsWith(path.resolve(sessionsRoot) + path.sep) && !sqlTarget) continue"
const FOOTPRINT_DEFERRED_ANCHOR = "      if (typeof target !== 'string' || !path.resolve(target).startsWith(sessions)) continue"
const FOOTPRINT_DEFERRED_PATCHED = "      if (typeof target !== 'string') continue\n      const sqlTarget = canDeleteDeferredPath === undefined ? false : canDeleteDeferredPath(path.resolve(target)) === true\n      if (!path.resolve(target).startsWith(sessions) && !sqlTarget) continue"
const HOST_FACTORY_ANCHOR = '  const gameFootprint = createGameFootprint({ dataRoot })'
const HOST_FACTORY_PATCHED = `  const dbSaveDeferredVerifier = resolved => {
    const persistence = ctx.get('sessionPersistence')
    if (typeof persistence?.dbSaveCanDeleteDeferredPath !== 'function') throw Error('延后删除缺少 SQL 路径核验服务，保留登记')
    return persistence.dbSaveCanDeleteDeferredPath(resolved)
  }
  const gameFootprint = createGameFootprint({ dataRoot, canDeleteDeferredPath: dbSaveDeferredVerifier })`
const HOST_LIVE_ANCHOR = "      const live = footprint.items.filter(item => item.category === 'subsession' && agentRegistry.get(item.sessionId))"
const HOST_LIVE_PATCHED = "      const live = footprint.items.filter(item => item.category === 'subsession' && (item.deferred === true || agentRegistry.get(item.sessionId)))"
const FOOTPRINT_PATCHES = [
  ['createGameFootprint factory', FOOTPRINT_FACTORY_ANCHOR, FOOTPRINT_FACTORY_PATCHED],
  ['removeLeftovers', FOOTPRINT_LEFTOVER_ANCHOR, FOOTPRINT_LEFTOVER_PATCHED],
  ['processDeferredDeletions', FOOTPRINT_DEFERRED_ANCHOR, FOOTPRINT_DEFERRED_PATCHED]
]
const count = (source, text) => source.split(text).length - 1
export function applyDbSaveFootprintTransform(source) {
  const applied = FOOTPRINT_PATCHES.every(([, , patched]) => count(source, patched) === 1)
  if (applied) {
    for (const [label, anchor] of FOOTPRINT_PATCHES) if (count(source, anchor) !== 0) throw Error('game-footprint 接缝同时含新旧锚点：' + label)
    return source
  }
  const missing = FOOTPRINT_PATCHES.filter(([, anchor, patched]) => !(count(source, patched) === 1 && count(source, anchor) === 1))
  if (source.includes(DB_SAVE_FOOTPRINT_MARKER) || missing.length !== FOOTPRINT_PATCHES.length) throw Error('game-footprint 延后删除接缝半施或标记不符：' + missing.map(([label]) => label).join(','))
  let next = source
  for (const [, anchor, patched] of FOOTPRINT_PATCHES) next = next.replace(anchor, patched)
  for (const [label, anchor, patched] of FOOTPRINT_PATCHES) {
    if (count(next, patched) !== 1 || count(next, anchor) !== 0) throw Error('game-footprint 延后删除接缝未命中：' + label)
  }
  return DB_SAVE_FOOTPRINT_MARKER + '\n' + next
}
export function applyDbSaveFootprintHostTransform(source) {
  if (!source.includes('createGameFootprint')) return source
  const liveApplied = count(source, HOST_LIVE_PATCHED) === 1, factoryApplied = count(source, HOST_FACTORY_PATCHED) === 1
  if (liveApplied && factoryApplied) {
    if (count(source, HOST_LIVE_ANCHOR) !== 0 || count(source, HOST_FACTORY_ANCHOR) !== 0) throw Error('作者删局延后删除接缝同时含新旧锚点')
    return source
  }
  if (liveApplied || factoryApplied) throw Error('作者删局延后删除接缝半施：' + (liveApplied ? 'live filter 已施而 createGameFootprint 装配缺失' : 'createGameFootprint 装配已施而 live filter 缺失'))
  const liveOld = count(source, HOST_LIVE_ANCHOR) === 1, factoryOld = count(source, HOST_FACTORY_ANCHOR) === 1
  if (!liveOld || !factoryOld) throw Error('作者删局存在但延后删除接缝锚点缺失：' + (!factoryOld ? 'createGameFootprint 装配' : 'live filter'))
  return source.replace(HOST_FACTORY_ANCHOR, HOST_FACTORY_PATCHED).replace(HOST_LIVE_ANCHOR, HOST_LIVE_PATCHED)
}
