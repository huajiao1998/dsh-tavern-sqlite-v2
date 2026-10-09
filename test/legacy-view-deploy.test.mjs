// 最小粒度离线施缝闸：真实缩进锚点、幂等与 fail-closed；纯 transform 断言（不再含 fs 生命周期/卸缝用例）
import assert from 'node:assert/strict'

import vm from 'node:vm'
import { transformLegacyIndex, transformLegacyRegistry, transformLegacyInitialization, transformLegacyViewReader, LEGACY_VIEW_SHIM } from '../deploy/apply-legacy-view-seams.mjs'

const index = `import { createChatPersistence } from './domain/chat-persistence.js'
export async function apply(ctx) {
  const sessionPatch = await installHostSessionPatch({})
  if (sessionPatch.view().hostVersion === '0.1.5-rc.2') {
    const open = (persistence?.tracker?.openHandles?.size || 0) + (persistence?.tracker?.writers?.size || 0)
    if (open) console.warn('dsh-tavern: 会话已经打开，旧档留到下次启动再迁移')
    else await migrateInstalledLegacySessions(resolveTavernDataRoot(), sessionPatch.loadSessionCatalog)
  }
  function scheduleTemplateSync(chat, metadata) {
    templateSync.schedule(chat.sessionId)
  }
  const authorChatStore = createChatJournalStore({ migrateLegacy: process.env.DSH_TAVERN_COMPATIBLE_STORAGE === '1' })
  const chatPersistence = createChatPersistence({ store: chatJournalStore, normalize: normalizeChat, now: Date.now })
  const registry = createTavernConversationRegistry({ store: {
      readLinks: async function () { return await readJson('sessions.json') }
  } })
  const reader = createSessionChatReader({
    needsAdoption: chat => groupOfMode(chat.mode) === 'play'
  })
  async function view(chat, options) {
    if (!options.openingWindow) scheduleTemplateSync(chat)
    else void candidateWorldbookPreparation?.warm(chat.sessionId)
    const cardExtensions = {}
      const pinnedExtensions = await requestPerformance.stage('remoteAssets', () => tavernRemoteAssets.pinExtensions(cardExtensions))
    return pinnedExtensions
  }
  async function ensureNativeOpening(sessionId) {
    return await conversationInitialization.ensureOpening(sessionId)
  }
  async function prepareConversationFork(sourceChatId, sourceSessionId, requestedTurn) {
    const source = await readChat(sourceChatId)
    const { state, turn } = await conversationStateAtTurn(source, requestedTurn, readChatRevision)
    let handle
    let session = sessionStore.get(source.sessionId)
    if (!session) { handle = await agentRegistry.resume({resumeSessionId:source.sessionId}); session = handle.agent.session }
    try { return {source,state,turn,atSeq:conversationForkBoundary(session,state,turn)} }
    finally { if(handle)await handle.dispose() }
  }
  async function forkChat(sourceChatId, sourceSessionId, targetSessionId) {
    const source = await readChat(sourceChatId)
    const target = sessionStore.get(targetSessionId)
    const targetEnd = sessionEvents(target).findLast(event => event.type === 'turn/end')
    return targetEnd
  }
  const chatHistoryImporter = createChatHistoryImportService({})
  async function rpc(method, args) {
    switch(method) {
      case 'prepareConversationFork': {
        return prepareConversationFork(args.chatId,args.sessionId)
      }
    }
  }
}
`
const registry = `export function createTavernConversationRegistry({store}) {
  function str(value) { return String(value || '') }
  async function resolveUsing(sessionId,readChat) {
    const id = str(sessionId)
    const links = await store.readLinks()
    if (typeof links[id] === 'string') {
      const mapped = await readChat(links[id])
      if (mapped !== undefined) return mapped
    }
    let found
    await store.updateLinks(async current => {
      const linkedChatIds = new Set(Object.values(current))
      for (const item of chatRows(await store.readIndex())) {
        if (linkedChatIds.has(item.id)) continue
        const chat = await readChat(item.id)
        if (chat.sessionId === id) found = chat
      }
    })
    return found
  }
  async function publish(chat) {
    return store.writeChat(chat)
  }
  async function sync(chat) {
    return store.writeIndex(chat)
  }
  async function touch(id) {
    const chatId = (await store.readLinks())[id] || ''
    if (chatId === '') return { touched: false }
    await store.writeIndex({})
    return {touched:true}
  }
  async function remove(chatId) {
    return store.removeChat(chatId)
  }
  return {resolveUsing,publish,sync,touch,remove}
}
`
const initialization = `export function createConversationInitialization(options) {
  const chats = options.chats
  async function appendNativeOpening(sessionId, chat, card, readyTarget, recovering = false) {
    if (chat.nativeOpeningAppended === true) return
    await options.native.append(sessionId)
  }
  async function recover(sessionId) {
    const chat = await chats.resolve(sessionId)
    const card = null
    await appendNativeOpening(sessionId, chat, card, undefined, true)
    return await options.present(chat,card)
  }
  return {recover}
}
`
const reader = `function identity(chat) {
  const mode = chat.mode || 'story'
  return { revision: Number(chat._storageRevision) || 0, cardPath: String(chat.cardPath ?? ''),
    cardContextRevision: Number(chat.cardContextRevision) || 0, mode, isCard: mode === 'card' }
}
function matches(cached,next) {
  return cached && ['cardPath', 'cardContextRevision', 'mode', 'isCard', 'resourceVersion'].every(key => cached[key] === next[key])
}
export {identity,matches}
`
const transforms = [[index,transformLegacyIndex], [registry,transformLegacyRegistry], [initialization,transformLegacyInitialization], [reader,transformLegacyViewReader]]
for (const [source,transform] of transforms) {
  const result = transform(source)
  assert.notEqual(result, source)
  assert.equal(transform(result), result, '幂等复跑必须字节不变')
  assert.throws(() => transform('// [dsh-tavern-legacy-view-seams:v1]\n' + source), /实现不完整/)
}
assert.throws(() => transformLegacyIndex(index.replace('    let handle', '  let handle')), /锚点不唯一/)
assert.throws(() => transformLegacyIndex(index + '\n  function scheduleTemplateSync(chat, metadata) {}'), /锚点不唯一/)
assert.match(transformLegacyIndex(index), /if \(legacyViewSeams\.readOnlyChat\(source\)\) \{[\s\S]*withObservedForkSource/)
assert.match(transformLegacyIndex(index), /target\?\.header\?\.parentSession !== source\.sessionId/)
assert.match(LEGACY_VIEW_SHIM, /queryVariables, formatVariableResult/)
assert.match(LEGACY_VIEW_SHIM, /loadOwnedModule\('legacy-fork-records'\)/)
assert.match(LEGACY_VIEW_SHIM, /forkRecords: createForkRecords\(\)/)
const actionsV3 = transformLegacyIndex(index)
assert.match(actionsV3, /\[dsh-tavern-save-actions:v3\]/)
assert.match(actionsV3, /case 'sqliteSaveClaim': return await ctx\.get\('tavernSaveActions'\)\.claim\(args\)/)
assert.match(actionsV3, /case 'sqliteSaveRelease': return await ctx\.get\('tavernSaveActions'\)\.release\(args\)/)
assert.match(actionsV3, /readSourceSessionTitle: async sessionId => await withObservedForkSource\(/)
assert.match(actionsV3, /item\.type === 'session\/title'/)
assert.match(actionsV3, /renameTargetSession: async/)
assert.match(actionsV3, /await sessionStore\.flush\(target\)/)
assert.match(actionsV3, /await conversationRegistry\.sync\(saved\)/)
// 真实生成接缝的两个标题写入器：只写新档、宿主接受值统一、flush/sync完成才返回。
const actionStart = actionsV3.indexOf("  ctx.provide('tavernSaveActions'")
const actionEnd = actionsV3.indexOf('  const chatHistoryImporter', actionStart)
// v2 线上真身（2026-09-30 施缝形态）：没有 readSourceSessionTitle 依赖；升级路径据此验证。
// 区域含标记注释行（SAVE_SERVICE 的首行就是它），否则 v3 标记会被留在原地。
let actionDeps
const titleTrace = []
const targetSession = { id: 'session-target' }
const titleEvents = [{ seq: 27, type: 'session/title', data: { title: '2004年大学生商海推演' } }]
const sessionQuery = Object.freeze({ observeSession: async () => { throw new Error('源标题依赖必须走 withObservedForkSource，不得自行观察') } })
let observations = 0
const titleContext = {
  ctx: {
    provide(name, deps) { assert.equal(name, 'tavernSaveActions'); actionDeps = deps },
    get(name) {
      if (name === 'sessionQuery') return sessionQuery
      assert.equal(name, 'sessionTitle'); return { rename(target, title) {
      assert.equal(target, targetSession); titleTrace.push('rename:' + title); return { title: 'DB.宿主接受值' }
    } }
    },
  },
  // 只读观察的替身：真身见 lib/legacy-view-seams.js withObservedForkSource（冻结门面 {id,header,events}）。
  withObservedForkSource: async ({ query, sessionId, work }) => {
    assert.equal(query, sessionQuery); observations++
    return await work(Object.freeze({ id: sessionId, header: { id: sessionId }, events: titleEvents }))
  },
  createAuthorSaveActions: deps => deps,
  chatPersistence: { async update(id, mutation) {
    assert.equal(id, 'chat-target'); titleTrace.push('chat-title'); return mutation({ id, title: '旧标题' })
  } },
  readSessionMap: async () => ({}), str: value => value,
  prepareConversationFork() {}, forkChat() {},
  sessionStore: { get(id) { return id === targetSession.id ? targetSession : undefined }, async flush(target) {
    assert.equal(target, targetSession); titleTrace.push('flush')
  } },
  agentRegistry: { get() { return undefined } }, isReadOnlySession: id => id === 'session-source',
  legacyViewSeams: { assertWritable(id) { if (id === 'chat-source') throw new Error('原件只读') } },
  conversationRegistry: { async sync(saved) { assert.equal(saved.title, 'DB.宿主接受值'); titleTrace.push('sync') } },
}
vm.runInNewContext(actionsV3.slice(actionStart, actionEnd), titleContext)
await actionDeps.validateTargetNaming()
const oldGetTitle = titleContext.ctx.get
titleContext.ctx.get = () => undefined
await assert.rejects(() => actionDeps.validateTargetNaming(), /尚未创建分叉/)
titleContext.ctx.get = oldGetTitle
assert.equal(titleTrace.length, 0, '命名预检不产生写入')
// v3 源标题依赖：只读观察窗口里折叠**最后一条 session/title**（不是 header / 卡名）。
assert.equal(await actionDeps.readSourceSessionTitle('session-source'), '2004年大学生商海推演')
assert.equal(observations, 1, '标题读取只能走一次 withObservedForkSource')
titleEvents.length = 0
await assert.rejects(() => actionDeps.readSourceSessionTitle('session-source'), /没有原生会话标题/)
titleEvents.push({ seq: 27, type: 'session/title', data: { title: '2004年大学生商海推演' } })
const accepted = await actionDeps.renameTargetSession('session-target', 'DB.原名')
assert.equal(accepted, 'DB.宿主接受值')
await actionDeps.setTargetChatTitle('chat-target', accepted)
assert.deepEqual(titleTrace, ['rename:DB.原名', 'flush', 'chat-title', 'sync'])
await assert.rejects(() => actionDeps.renameTargetSession('session-source', 'DB.不得写'), /不可写/)
await assert.rejects(() => actionDeps.setTargetChatTitle('chat-source', 'DB.不得写'), /原件只读/)
assert.equal(titleTrace.length, 4, '原件不调用任何写入器')
assert.match(LEGACY_VIEW_SHIM, /createRequire\(path\.join\(home, 'profiles', 'tavern', 'package\.json'\)\)/)
assert.match(LEGACY_VIEW_SHIM, /profileRequire\.resolve\('dsh-tavern-sqlite-v2\/' \+ name\)/)
assert.doesNotMatch(LEGACY_VIEW_SHIM, /from 'dsh-tavern-sqlite-v2\//)
assert.doesNotMatch(transformLegacyIndex(index), /migrateInstalledLegacySessions\s*\(/)
assert.doesNotMatch(transformLegacyIndex(index), /installHostSessionPatch\s*\(/, '作者树不得再自带官方宿主补丁安装调用')
assert.doesNotMatch(transformLegacyIndex(index), /from '\.\/domain\/host-session-patch\.js'/, '作者树不得再导入官方宿主补丁')
assert.match(transformLegacyIndex(index), /const sessionPatch = await installAuthorHostSessionPatch\(ctx\)/)
assert.match(LEGACY_VIEW_SHIM, /export async function installAuthorHostSessionPatch\(ctx\)/)
assert.ok(transformLegacyIndex(index).indexOf('await initializeAuthorLegacyWorkspaces(ctx)') > transformLegacyIndex(index).indexOf('await installAuthorHostSessionPatch(ctx)'),'workspace stat 必须在作者宿主补丁完成之后')
assert.throws(()=>transformLegacyIndex(transformLegacyIndex(index)+'\nmigrateInstalledLegacySessions()'),/仍有启动迁移/)
// 升级路径：已施缝但作者仍带官方安装调用（线上真实形态）→ 必须就地改成我们的入口，且复跑幂等
const legacyDeployed = transformLegacyIndex(index).replace('await installAuthorHostSessionPatch(ctx)', "await installHostSessionPatch({\n    persistence,\n    query: ctx.get('sessionQuery'),\n  })").replace("\nimport { legacyViewSeams")
assert.match(legacyDeployed, /installHostSessionPatch\(/)
assert.doesNotMatch(transformLegacyIndex(legacyDeployed), /installHostSessionPatch\s*\(/)
assert.match(transformLegacyIndex(legacyDeployed), /await installAuthorHostSessionPatch\(ctx\)/)
assert.equal(transformLegacyIndex(transformLegacyIndex(legacyDeployed)), transformLegacyIndex(legacyDeployed))
assert.doesNotMatch(transformLegacyIndex(transformLegacyIndex(index)+'\n  const sessionPatch = await installHostSessionPatch({})\n'), /installHostSessionPatch\s*\(/)
assert.throws(()=>transformLegacyIndex(index.replace('    else await migrateInstalledLegacySessions','   else await migrateInstalledLegacySessions')),/锚点不唯一/)
assert.match(transformLegacyReaderForTest(), /\['sessionId', 'cardPath'/)
function transformLegacyReaderForTest() { return transformLegacyViewReader(reader) }

console.log('legacy-view-deploy：锚点/幂等/只查/业务断言全部通过')

