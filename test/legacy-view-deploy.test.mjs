// 最小粒度离线施缝闸：真实缩进锚点、幂等、失败关闭、事务回滚；只创建本测试独占目录。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { applyLegacyViewSeams, transformLegacyIndex, transformLegacyRegistry, transformLegacyInitialization,
  transformLegacyViewReader, LEGACY_VIEW_SHIM } from '../deploy/apply-legacy-view-seams.mjs'

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
// 本次新增 RPC 前的线上树（有 v3 标记 + claim，没有 release case）⇒ 守卫式就地补上并与全量产物逐字节收敛。
const preReleaseHost = actionsV3.replace("      case 'sqliteSaveRelease': return await ctx.get('tavernSaveActions').release(args)\n", '')
assert.notEqual(preReleaseHost, actionsV3, 'fixture 必须真的删掉了 release case')
assert.equal(transformLegacyIndex(preReleaseHost), actionsV3, '补 release case 必须与 v1→v3 产物收敛到同一字节')
assert.equal(transformLegacyIndex(actionsV3), actionsV3, '带 release case 的产物必须幂等')
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
const saveRegion = text => text.slice(text.indexOf('  // [dsh-tavern-save-actions:v3]'), text.indexOf('  const chatHistoryImporter'))
const V2_SAVE_SERVICE = `  // [dsh-tavern-save-actions:v2] 唯一同源占位与新档命名；只写目标。
  ctx.provide('tavernSaveActions', createAuthorSaveActions({
    chats: chatPersistence,
    resolveChatId: async sessionId => (await readSessionMap())[str(sessionId)],
    prepareFork: prepareConversationFork, completeFork: forkChat,
    validateTargetNaming: async () => {
      const titles = ctx.get('sessionTitle')
      if (!titles || typeof titles.rename !== 'function' || typeof sessionStore.flush !== 'function') throw new Error('宿主缺少会话命名/持久化接口；尚未创建分叉')
      if (typeof chatPersistence.update !== 'function' || typeof conversationRegistry.sync !== 'function') throw new Error('宿主缺少聊天命名/摘要同步接口；尚未创建分叉')
    },
    renameTargetSession: async (sessionId, title) => {
      const target = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      if (!target || isReadOnlySession(sessionId)) throw new Error('数据库分叉目标会话不可写，未重命名')
      const titleService = ctx.get('sessionTitle')
      if (!titleService || typeof titleService.rename !== 'function') throw new Error('缺少原生会话标题服务')
      const accepted = titleService.rename(target, title)
      await sessionStore.flush(target)
      if (typeof accepted?.title !== 'string' || !accepted.title) throw new Error('宿主未返回接受的标题')
      return accepted.title
    },
    setTargetChatTitle: async (chatId, title) => {
      legacyViewSeams.assertWritable(chatId, '数据库分叉命名')
      const saved = await chatPersistence.update(chatId, chat => ({ ...chat, title }), { source: 'sqlite-fork.title' })
      if (!saved || saved.title !== title) throw new Error('数据库分叉标题未写入')
      await conversationRegistry.sync(saved)
      return saved.title
    }
  }))
`
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
// 升级路径：已施过 v2 的线上树（无 readSourceSessionTitle）必须**就地**补依赖并升到 v3，
// 且与 v1→v3 的产物逐字节收敛（同一 transform ⇒ --check 判脏、apply 后幂等）。
const v2Host = actionsV3.replace(saveRegion(actionsV3), V2_SAVE_SERVICE)
assert.notEqual(v2Host, actionsV3, 'v2 fixture 必须真的把 v3 块换回 v2 块')
assert.match(v2Host, /\[dsh-tavern-save-actions:v2\]/)
assert.doesNotMatch(v2Host, /readSourceSessionTitle:/)
assert.equal(v2Host.split('// [dsh-tavern-save-actions:v2]').length, 2, 'v2 fixture 只能有一个 v2 标记')
const upgraded = transformLegacyIndex(v2Host)
assert.equal(upgraded, actionsV3, 'v2→v3 必须与 v1→v3 收敛到同一字节')
assert.equal(transformLegacyIndex(upgraded), upgraded, 'v2→v3 升级必须幂等')
assert.throws(() => transformLegacyIndex(upgraded.replace('readSourceSessionTitle:', 'readSourceSessionTitleX:')), /v3 标记存在但不完整/)
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
const legacyDeployed = transformLegacyIndex(index).replace('await installAuthorHostSessionPatch(ctx)', "await installHostSessionPatch({\n    persistence,\n    query: ctx.get('sessionQuery'),\n  })").replace("import { legacyViewSeams", "import { installHostSessionPatch } from './domain/host-session-patch.js'\nimport { legacyViewSeams")
assert.match(legacyDeployed, /installHostSessionPatch\(/)
assert.doesNotMatch(transformLegacyIndex(legacyDeployed), /installHostSessionPatch\s*\(/)
assert.match(transformLegacyIndex(legacyDeployed), /await installAuthorHostSessionPatch\(ctx\)/)
assert.equal(transformLegacyIndex(transformLegacyIndex(legacyDeployed)), transformLegacyIndex(legacyDeployed))
assert.doesNotMatch(transformLegacyIndex(transformLegacyIndex(index)+'\n  const sessionPatch = await installHostSessionPatch({})\n'), /installHostSessionPatch\s*\(/)
assert.throws(()=>transformLegacyIndex(index.replace('    else await migrateInstalledLegacySessions','   else await migrateInstalledLegacySessions')),/锚点不唯一/)
assert.match(transformLegacyReaderForTest(), /\['sessionId', 'cardPath'/)
function transformLegacyReaderForTest() { return transformLegacyViewReader(reader) }

const own = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.legacy-view-deploy-'))
try {
  const domain = path.join(own,'tavern-plugin','lib','domain')
  mkdirSync(domain,{recursive:true})
  writeFileSync(path.join(own,'package.json'),'{"type":"module"}\n','utf8')
  const fixtures = new Map([
    ['tavern-plugin/lib/index.js',index],
    ['tavern-plugin/lib/domain/tavern-conversation-registry.js',registry],
    ['tavern-plugin/lib/domain/conversation-initialization.js',initialization],
    ['tavern-plugin/lib/domain/session-view-reader.js',reader]
  ])
  for (const [relative,text] of fixtures) writeFileSync(path.join(own,relative),text,'utf8')
  const manifest = path.join(own,'.tavern-legacy-view-seams.json')
  const shim = path.join(domain,'legacy-view-seams.js')
  const needed = applyLegacyViewSeams({appDir:own,check:true})
  assert.equal(needed.needsApply,true); assert.equal(needed.changed,false); assert.equal(existsSync(manifest),false); assert.equal(existsSync(shim),false)
  for (const [relative,text] of fixtures) assert.equal(readFileSync(path.join(own,relative),'utf8'),text)
  let checked = 0
  assert.throws(() => applyLegacyViewSeams({appDir:own,syntaxCheck:() => { if(++checked === 2)throw new Error('模拟语法失败') }}), /模拟语法失败/)
  assert.equal(existsSync(manifest),false); assert.equal(existsSync(shim),false)
  for (const [relative,text] of fixtures) {
    assert.equal(readFileSync(path.join(own,relative),'utf8'),text,'失败必须恢复本次前像')
    assert.equal(existsSync(path.join(own,relative+'.legacy-view-seams.backup')),false,'失败不得留下未知备份')
  }
  const applied = applyLegacyViewSeams({appDir:own})
  assert.equal(applied.changed,true); assert.equal(applied.needsApply,false); assert.equal(existsSync(manifest),true)
  assert.equal(readFileSync(shim,'utf8'),LEGACY_VIEW_SHIM)
  assert.equal(applyLegacyViewSeams({appDir:own,check:true}).needsApply,false)
  assert.equal(applyLegacyViewSeams({appDir:own}).changed,false)
  const removed = applyLegacyViewSeams({appDir:own,uninstall:true})
  assert.equal(removed.removed,true); assert.equal(existsSync(manifest),false); assert.equal(existsSync(shim),false)
  for (const [relative,text] of fixtures) assert.equal(readFileSync(path.join(own,relative),'utf8'),text)
  assert.equal(applyLegacyViewSeams({appDir:own,uninstall:true}).changed,false)
} finally { rmSync(own,{recursive:true,force:true}) }
console.log('legacy-view-deploy：锚点/幂等/只查/回滚/语法/卸缝定向断言全部通过')
