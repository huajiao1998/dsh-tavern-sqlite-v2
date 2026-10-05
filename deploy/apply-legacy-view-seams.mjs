#!/usr/bin/env node
// 原件只读与另存作者接缝；仅施缝，不打开会话、不迁移数据、不重启服务。
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { prepareProtectedLegacySource } from './maintenance/author-safety.mjs'

const MARKER = '// [dsh-tavern-legacy-view-seams:v1]'
const MANIFEST = '.tavern-legacy-view-seams.json'
const LEGACY_SHIM_IMPORT = "import { legacyViewSeams, isReadOnlySession, withObservedForkSource, createAuthorSaveActions, initializeAuthorLegacyWorkspaces } from './domain/legacy-view-seams.js'"
const IMPORT = "import { legacyViewSeams, isReadOnlySession, withObservedForkSource, createAuthorSaveActions, initializeAuthorLegacyWorkspaces, installAuthorHostSessionPatch } from './domain/legacy-view-seams.js'"
const INSTALLER_CALL = "  // 宿主会话补丁只由我们的包安装一份（作者树那份是官方实现，会盖回接管接缝）。\n  const sessionPatch = await installAuthorHostSessionPatch(ctx)\n"
const DOMAIN_IMPORT = "import { legacyViewSeams, isReadOnlySession } from './legacy-view-seams.js'"
const OLD_SAVE_SERVICE = "  ctx.provide('tavernSaveActions', createAuthorSaveActions({\n    chats: chatPersistence,\n    resolveChatId: async sessionId => (await readSessionMap())[str(sessionId)],\n    prepareFork: prepareConversationFork, completeFork: forkChat\n  }))\n"
const SAVE_ACTIONS_V2_MARKER = '// [dsh-tavern-save-actions:v2]'
const SAVE_ACTIONS_V3_MARKER = '// [dsh-tavern-save-actions:v3]'
// 源会话原生标题只读读取（v3 新增）：`sessionTitle.get` 需要**活 Session**（`session.snapshotEvents()`），
// 而这里只有官方只读观察给的事件门面 ⇒ 直接折叠同一份观察到的日志里最后一条 `session/title`。
// 权威性证据（0.1.5-rc.2）：原生 header 无 title；标题只由 `session/title` 事件承载
// （tools/dsh-persist-src/dsh-session/lib/index.js 事件白名单 + jsonl worker 对 data.title 的校验）。
// 只读：不 resume、不 adopt、不 append；读不到就抛，绝不回退卡名。
const READ_SOURCE_TITLE_DEP = `    readSourceSessionTitle: async sessionId => await withObservedForkSource({
      query: ctx.get('sessionQuery'), sessionId,
      work: session => {
        // 门面只有 {id, header, events}（见 lib/legacy-view-seams.js 的只读契约）；事件日志缺一不可。
        const events = session && session.events
        if (!Array.isArray(events)) throw new Error('原生观察未返回已验证的事件日志；无法读取源会话标题')
        const event = events.findLast(item => item && item.type === 'session/title')
        const title = event && event.data ? event.data.title : undefined
        if (typeof title !== 'string' || title.trim() === '') throw new Error('源会话没有原生会话标题（session/title）；拒绝用卡名代替命名新存档')
        return title
      }
    }),
`
const SAVE_SERVICE = `  // [dsh-tavern-save-actions:v3] 唯一同源占位与新档命名；只写目标。
  ctx.provide('tavernSaveActions', createAuthorSaveActions({
    chats: chatPersistence,
    resolveChatId: async sessionId => (await readSessionMap())[str(sessionId)],
    prepareFork: prepareConversationFork, completeFork: forkChat,
${READ_SOURCE_TITLE_DEP}    validateTargetNaming: async () => {
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
function upgradeSaveActions(source) {
  let out = source
  if (out.includes(SAVE_ACTIONS_V3_MARKER)) {
    // 幂等：标记在就必须实现完整，否则拒绝猜测修复。
    for (const required of ['readSourceSessionTitle:', 'renameTargetSession:', 'setTargetChatTitle:', 'validateTargetNaming:']) {
      if (!out.includes(required)) throw new Error('保存动作 v3 标记存在但不完整（缺少 ' + required + '），拒绝猜测修复')
    }
  } else if (out.includes(SAVE_ACTIONS_V2_MARKER)) {
    // 已施过 v2 的线上树就地升级到 v3：补源会话标题依赖 + 标记改写；两个锚点都必须唯一命中。
    out = replace(out, SAVE_ACTIONS_V2_MARKER, SAVE_ACTIONS_V3_MARKER, '保存动作 v2→v3 标记升级')
    out = replace(out, '    validateTargetNaming: async () => {',
      READ_SOURCE_TITLE_DEP + '    validateTargetNaming: async () => {', '保存动作 v2→v3 源会话标题依赖')
  } else {
    out = replace(out, OLD_SAVE_SERVICE, SAVE_SERVICE, '保存动作 v3 升级')
  }
  if (!out.includes("case 'sqliteSaveClaim':")) out = replace(out, "      case 'sqliteSavePrepare': return await ctx.get('tavernSaveActions').prepare(args)", "      case 'sqliteSavePrepare': return await ctx.get('tavernSaveActions').prepare(args)\n      case 'sqliteSaveClaim': return await ctx.get('tavernSaveActions').claim(args)", '用户点击占位 RPC')
  // 显式释放 RPC（2026-10-01）：只对 complete + 目标确证 missing 生效（实现见 lib/legacy-view-seams.js release）。
  // 守卫式追加：老树（只有 claim 的形态）就地升级；**不**加入上面 v3 必填串，否则老树会先报"实现不完整"而无法升级。
  if (!out.includes("case 'sqliteSaveRelease':")) out = replace(out, "      case 'sqliteSaveClaim': return await ctx.get('tavernSaveActions').claim(args)", "      case 'sqliteSaveClaim': return await ctx.get('tavernSaveActions').claim(args)\n      case 'sqliteSaveRelease': return await ctx.get('tavernSaveActions').release(args)", '显式释放已完成关系 RPC')
  if (!out.includes("case 'sqliteSaveRecover':")) out = replace(out, "      case 'sqliteSaveRelease': return await ctx.get('tavernSaveActions').release(args)", "      case 'sqliteSaveRelease': return await ctx.get('tavernSaveActions').release(args)\n      case 'sqliteSaveRecover': return await ctx.get('tavernSaveActions').recover(args)", '同冻结SID恢复 RPC')
  return out
}

export const LEGACY_VIEW_SHIM = `${MARKER}
// 作者树薄垫片：全部实现由插件拥有，缺包时响亮失败，不能降级为可写原档。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
// 作者应用树与 profile 包不在同一解析祖先链，必须按安装 profile 定位，缺包直接失败。
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
const profileRequire = createRequire(path.join(home, 'profiles', 'tavern', 'package.json'))
const loadOwnedModule = name => import(pathToFileURL(profileRequire.resolve('dsh-tavern-sqlite-v2/' + name)).href)
const { createLegacyViewSeams, withObservedForkSource, createLegacySaveActions } = await loadOwnedModule('legacy-view-seams')
const { legacyBindingForChat, listLegacyBindings, overlayLegacyLinks, projectLegacyEnvelope } = await loadOwnedModule('legacy-bindings')
const { createForkRecords } = await loadOwnedModule('legacy-fork-records')
const { initializeLegacySourceWorkspaces } = await loadOwnedModule('legacy-source-workspace')
const { hasLegacyArtifact, isLegacySession } = await loadOwnedModule('tavern-chat-state')
const { describeSaveFormat, formatSaveResult } = await loadOwnedModule('migration-ops')
const { queryVariables, formatVariableResult } = await loadOwnedModule('variable-ops')
export const legacyViewSeams = createLegacyViewSeams({
  bindingForChat: legacyBindingForChat, overlayLinks: overlayLegacyLinks,
  projectEnvelope: projectLegacyEnvelope,
  isLegacyChat: chatId => !!legacyBindingForChat(chatId) || hasLegacyArtifact(chatId)
})
export const isReadOnlySession = isLegacySession
export { withObservedForkSource }
export async function initializeAuthorLegacyWorkspaces(ctx) {
  return await initializeLegacySourceWorkspaces({ bindings: listLegacyBindings(),
    persistence: ctx.get('sessionPersistence'), registry: ctx.get('workspaceRegistry') })
}
// 作者树的宿主会话补丁调用点改用这里：只由我们的包安装一份（官方那份会把官方 stat/open/…
// 盖回接管实现之上 → 原档 stat 失效 → workspace 登记失败、起不来）。
export async function installAuthorHostSessionPatch(ctx) {
  const mod = await loadOwnedModule('host-session-install')
  return await mod.installSharedHostSessionPatch({ ctx })
}
export function createAuthorSaveActions(deps) {
  return createLegacySaveActions({ ...deps, forkRecords: createForkRecords(), describeSaveFormat, formatSaveResult, queryVariables, formatVariableResult })
}
`

function replace(source, anchor, next, label) {
  const first = source.indexOf(anchor)
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) throw new Error('原件只读接缝锚点不唯一：' + label)
  return source.slice(0, first) + next + source.slice(first + anchor.length)
}
function insertImport(source, statement) {
  if (source.startsWith('#!')) throw new Error('不支持带 shebang 的作者模块')
  return MARKER + '\n' + statement + '\n' + source
}
function patched(source, required) {
  if (!source.includes(MARKER)) return false
  if (!required.every(value => source.includes(value))) throw new Error('原件只读接缝标记存在但实现不完整，拒绝猜测修复')
  return true
}
/** 用括号配对定位作者的 `const sessionPatch = await installHostSessionPatch(...)` 整句并替换。 */
function replaceInstallerCall(source, next) {
  const HEAD = 'const sessionPatch = await installHostSessionPatch('
  const start = source.indexOf(HEAD)
  if (start < 0) throw new Error('作者树缺少宿主补丁调用点，拒绝部署')
  if (source.indexOf(HEAD, start + 1) >= 0) throw new Error('作者树宿主补丁调用点不唯一，拒绝部署')
  let depth = 0
  let index = start + HEAD.length - 1
  for (; index < source.length; index++) {
    if (source[index] === '(') depth++
    else if (source[index] === ')') { depth--; if (depth === 0) break }
  }
  if (depth !== 0) throw new Error('作者树宿主补丁调用点括号不平衡，拒绝部署')
  let end = index + 1
  if (source[end] === '\n') end++
  return source.slice(0, start) + next + source.slice(end)
}

// 把作者树自带的官方宿主补丁安装点改成我们的共享入口（幂等：已是我们的入口时字节不变）。
// 官方那份会把官方 stat/open/… 盖回接管实现（2026-09-30 洁净实例实测：原档 stat 失效 →
// workspace 登记失败 → 插件树起不来），所以这一步是**必需**的部署缝。
function upgradeInstallerCall(source) {
  let out = source
  // 早期版本施的缝导出较少：先升级垫片导入行，再处理作者树自带的官方安装点。
  if (out.includes(LEGACY_SHIM_IMPORT)) out = replace(out, LEGACY_SHIM_IMPORT, IMPORT, '垫片导入升级')
  if (/installHostSessionPatch\s*\(/.test(out)) {
    const installerImport = "import { installHostSessionPatch } from './domain/host-session-patch.js'\n"
    if (out.includes(installerImport)) out = replace(out, installerImport, '', '作者宿主补丁 import')
    out = replaceInstallerCall(out, INSTALLER_CALL)
  }
  return out
}
export function transformLegacyIndex(source) {
  if (patched(source, ["from './domain/legacy-view-seams.js'", "ctx.provide('tavernSaveActions'", 'wrapStore(chatJournalStore)', "case 'sqliteSaveStatus':", "case 'sqliteVariablesQuery':", 'withObservedForkSource({', 'isReadOnlySession(sessionId)', 'await initializeAuthorLegacyWorkspaces(ctx)', "export const inject = ['sessionPersistence', 'workspaceRegistry']", '原件禁止启动迁移'])) {
    if (/migrateInstalledLegacySessions\s*\(/.test(source)) throw new Error('原件接缝仍有启动迁移调用，拒绝部署')
    return upgradeSaveActions(upgradeInstallerCall(source))
  }
  source = prepareProtectedLegacySource(source)
  if (/export\s+(?:const|let|var)\s+inject\b/.test(source)) throw new Error('作者模块已有 inject；拒绝猜测合并依赖')
  let out = insertImport(source, IMPORT)
  out = upgradeInstallerCall(out)
  out = replace(out, 'export async function apply(ctx) {', "export const inject = ['sessionPersistence', 'workspaceRegistry']\nexport async function apply(ctx) {", '原生服务启动依赖')
  out = replace(out, "  if (sessionPatch.view().hostVersion === '0.1.5-rc.2') {\n    const open = (persistence?.tracker?.openHandles?.size || 0) + (persistence?.tracker?.writers?.size || 0)\n    if (open) console.warn('dsh-tavern: 会话已经打开，旧档留到下次启动再迁移')\n    else await migrateInstalledLegacySessions(resolveTavernDataRoot(), sessionPatch.loadSessionCatalog)\n  }", "  // 原件禁止启动迁移；仅在宿主补丁完成后登记显式绑定源 workspace。\n  await initializeAuthorLegacyWorkspaces(ctx)", '禁止启动扫描原生存档 / 宿主补丁后登记')
  out = replace(out, "migrateLegacy: process.env.DSH_TAVERN_COMPATIBLE_STORAGE === '1'", 'migrateLegacy: false', '禁止作者读取时迁移')
  out = replace(out, 'store: chatJournalStore, normalize: normalizeChat', 'store: legacyViewSeams.wrapStore(chatJournalStore), normalize: normalizeChat', '全读取 envelope')
  out = replace(out, '  function scheduleTemplateSync(chat, metadata) {', '  function scheduleTemplateSync(chat, metadata) {\n    if (legacyViewSeams.readOnlyChat(chat)) return', '模板调度')
  out = replace(out, '    needsAdoption: chat => groupOfMode(chat.mode)', '    needsAdoption: chat => !legacyViewSeams.readOnlyChat(chat) && groupOfMode(chat.mode)', '只读不 adoption')
  out = replace(out, "      readLinks: async function () { return await readJson('sessions.json') }", "      readLinks: async function () { return legacyViewSeams.links(await readJson('sessions.json')) }", '链接只读覆盖')
  out = replace(out, '    if (!options.openingWindow) scheduleTemplateSync(chat)\n    else void candidateWorldbookPreparation?.warm(chat.sessionId)', '    if (!options.openingWindow) scheduleTemplateSync(chat)\n    else if (!legacyViewSeams.readOnlyChat(chat)) void candidateWorldbookPreparation?.warm(chat.sessionId)', '视图不预热')
  out = replace(out, "      const pinnedExtensions = await requestPerformance.stage('remoteAssets', () => tavernRemoteAssets.pinExtensions(cardExtensions))", "      const pinnedExtensions = legacyViewSeams.readOnlyChat(chat)\n        ? { helperScripts: cardExtensions.helperScripts, regexScripts: cardExtensions.regexScripts, diagnostics: [], pins: [] }\n        : await requestPerformance.stage('remoteAssets', () => tavernRemoteAssets.pinExtensions(cardExtensions))", '视图不下载 pin')
  out = replace(out, '  async function ensureNativeOpening(sessionId) {\n    return await conversationInitialization.ensureOpening(sessionId)\n  }', '  async function ensureNativeOpening(sessionId) {\n    if (isReadOnlySession(sessionId)) return await sessionView(sessionId)\n    return await conversationInitialization.ensureOpening(sessionId)\n  }', '原生开场只读')
  out = replace(out, '    const { state, turn } = await conversationStateAtTurn(source, requestedTurn, readChatRevision)\n    let handle', "    const {state,turn}=await conversationStateAtTurn(source,requestedTurn,readChatRevision)\n    if (legacyViewSeams.readOnlyChat(source)) {\n      return await withObservedForkSource({ query: ctx.get('sessionQuery'), sessionId: source.sessionId,\n        work: session => ({ source, state, turn, atSeq: conversationForkBoundary(session, state, turn) }) })\n    }\n    let handle", '原件分叉不 resume')
  out = replace(out, "    const targetEnd = sessionEvents(target).findLast(event => event.type === 'turn/end')", "    if (legacyViewSeams.readOnlyChat(source) && target?.header?.parentSession !== source.sessionId) throw new Error('另存目标不是源原生 Session 的真实分叉')\n    const targetEnd = sessionEvents(target).findLast(event => event.type === 'turn/end')", '分叉亲本 guard')
  out = replace(out, '  const chatHistoryImporter = createChatHistoryImportService({', "  ctx.provide('tavernSaveActions', createAuthorSaveActions({\n    chats: chatPersistence,\n    resolveChatId: async sessionId => (await readSessionMap())[str(sessionId)],\n    prepareFork: prepareConversationFork, completeFork: forkChat\n  }))\n  const chatHistoryImporter = createChatHistoryImportService({", '唯一另存 service')
  out = replace(out, "      case 'prepareConversationFork': {", "      case 'sqliteSaveStatus': return await ctx.get('tavernSaveActions').status(args)\n      case 'sqliteSavePrepare': return await ctx.get('tavernSaveActions').prepare(args)\n      case 'sqliteSaveComplete': return await ctx.get('tavernSaveActions').complete(args)\n      case 'sqliteVariablesQuery': return await ctx.get('tavernSaveActions').variables(args)\n      case 'prepareConversationFork': {", 'RPC 只转 service')
  if (/migrateInstalledLegacySessions\s*\(/.test(out)) throw new Error('原件接缝仍有启动迁移调用，拒绝部署')
  return upgradeSaveActions(out)
}

export function transformLegacyRegistry(source) {
  if (patched(source, [DOMAIN_IMPORT, 'isReadOnlySession(id)', '原件映射不可读取', 'readOnlyChat(item.id)', "assertWritable(chat, '发布')", "assertWritable(chatId, '删除')", 'readOnly: true'])) return source
  let out = insertImport(source, DOMAIN_IMPORT)
  out = replace(out, '      if (mapped !== undefined) return mapped\n    }\n    let found', "      if (mapped !== undefined) return mapped\n      if (legacyViewSeams.readOnlyChat(links[id])) throw new Error('原件映射不可读取；禁止自动修复链接')\n    }\n    if (isReadOnlySession(id)) return undefined\n    let found", '原件不进入恢复写')
  out = replace(out, '        if (linkedChatIds.has(item.id)) continue', '        if (linkedChatIds.has(item.id) || legacyViewSeams.readOnlyChat(item.id)) continue', '原件不扫描恢复')
  out = replace(out, '  async function publish(chat) {', "  async function publish(chat) {\n    legacyViewSeams.assertWritable(chat, '发布')", '发布 guard')
  out = replace(out, '  async function sync(chat) {', "  async function sync(chat) {\n    legacyViewSeams.assertWritable(chat, '同步索引')", '索引 guard')
  out = replace(out, "    if (chatId === '') return { touched: false }", "    if (chatId === '') return { touched: false }\n    if (legacyViewSeams.readOnlyChat(chatId)) return { touched: false, readOnly: true }", '原件不 touch')
  out = replace(out, '  async function remove(chatId) {', "  async function remove(chatId) {\n    legacyViewSeams.assertWritable(chatId, '删除')", '删除 guard')
  return out
}

export function transformLegacyInitialization(source) {
  if (patched(source, [DOMAIN_IMPORT, "assertWritable(chat, '原生开场追加')", 'if (!legacyViewSeams.readOnlyChat(chat)) await appendNativeOpening'])) return source
  let out = insertImport(source, DOMAIN_IMPORT)
  out = replace(out, '  async function appendNativeOpening(sessionId, chat, card, readyTarget, recovering = false) {', "  async function appendNativeOpening(sessionId, chat, card, readyTarget, recovering = false) {\n    legacyViewSeams.assertWritable(chat, '原生开场追加')", '开场 guard')
  out = replace(out, '    await appendNativeOpening(sessionId, chat, card, undefined, true)', '    if (!legacyViewSeams.readOnlyChat(chat)) await appendNativeOpening(sessionId, chat, card, undefined, true)', 'recover 纯 present')
  return out
}

export function transformLegacyViewReader(source) {
  if (patched(source, ["sessionId: String(chat.sessionId ?? '')", "['sessionId', 'cardPath'"])) return source
  let out = MARKER + '\n' + source
  out = replace(out, '    cardContextRevision: Number(chat.cardContextRevision) || 0, mode, isCard:', "    cardContextRevision: Number(chat.cardContextRevision) || 0, sessionId: String(chat.sessionId ?? ''), mode, isCard:", 'cache 绑定身份')
  out = replace(out, "['cardPath', 'cardContextRevision', 'mode', 'isCard', 'resourceVersion']", "['sessionId', 'cardPath', 'cardContextRevision', 'mode', 'isCard', 'resourceVersion']", 'cache identity guard')
  return out
}

/** 所有锚点先验证，再统一备份/写入/语法检查；失败恢复本次前像。 */
export function applyLegacyViewSeams({ appDir, check = false, uninstall = false, syntaxCheck } = {}) {
  if (!appDir || !path.isAbsolute(appDir)) throw new Error('必须明确指定作者应用树绝对路径')
  const manifestPath = path.join(appDir, MANIFEST)
  if (uninstall) {
    if (!existsSync(manifestPath)) return { changed: false, removed: false }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const entry of manifest.entries) {
      const file = path.join(appDir, entry.relative)
      if (entry.created) {
        if (existsSync(file) && !readFileSync(file, 'utf8').startsWith(MARKER)) throw new Error('部署垫片身份不符，拒绝删除')
      } else if (!existsSync(path.join(appDir, entry.backup))) throw new Error('缺少原件只读接缝备份：' + entry.relative)
    }
    if (check) return { changed: false, needsUninstall: true }
    for (const entry of manifest.entries) {
      const file = path.join(appDir, entry.relative)
      if (entry.created) { if (existsSync(file)) unlinkSync(file) }
      else copyFileSync(path.join(appDir, entry.backup), file)
    }
    // 已完整恢复后移除本 manifest 精确拥有的备份，允许卸缝后重新施缝。
    for (const entry of manifest.entries) if (!entry.created) unlinkSync(path.join(appDir, entry.backup))
    unlinkSync(manifestPath)
    return { changed: true, removed: true }
  }
  const transforms = [
    ['tavern-plugin/lib/index.js', transformLegacyIndex],
    ['tavern-plugin/lib/domain/tavern-conversation-registry.js', transformLegacyRegistry],
    ['tavern-plugin/lib/domain/conversation-initialization.js', transformLegacyInitialization],
    ['tavern-plugin/lib/domain/session-view-reader.js', transformLegacyViewReader]
  ]
  const changes = transforms.map(([relative, transform]) => {
    const file = path.join(appDir, relative)
    if (!existsSync(file)) throw new Error('缺少作者源模块：' + relative)
    const before = readFileSync(file, 'utf8')
    return { relative, file, before, after: transform(before), created: false }
  })
  const shimRelative = 'tavern-plugin/lib/domain/legacy-view-seams.js'
  const shimFile = path.join(appDir, shimRelative)
  const shimBefore = existsSync(shimFile) ? readFileSync(shimFile, 'utf8') : undefined
  if (shimBefore !== undefined && !shimBefore.startsWith(MARKER)) throw new Error('作者已有同名模块，拒绝覆盖')
  changes.push({ relative: shimRelative, file: shimFile, before: shimBefore, after: LEGACY_VIEW_SHIM, created: shimBefore === undefined })
  const dirty = changes.filter(entry => entry.before !== entry.after)
  if (!dirty.length || check) return { changed: false, needsApply: dirty.length > 0, files: dirty.map(entry => entry.relative) }
  const oldManifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : undefined
  const entries = oldManifest ? JSON.parse(oldManifest).entries : []
  const newBackups = []
  const validate = syntaxCheck || (file => execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }))
  try {
    for (const entry of dirty) {
      if (!entries.some(old => old.relative === entry.relative)) {
        const backup = entry.relative + '.legacy-view-seams.backup'
        if (!entry.created) {
          if (existsSync(path.join(appDir, backup))) throw new Error('未知旧备份存在，拒绝覆盖：' + backup)
          copyFileSync(entry.file, path.join(appDir, backup)); newBackups.push(path.join(appDir, backup))
        }
        entries.push({ relative: entry.relative, created: entry.created, ...(entry.created ? {} : { backup }) })
      }
      writeFileSync(entry.file, entry.after, 'utf8')
    }
    for (const entry of dirty) validate(entry.file)
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries }, null, 2) + '\n', 'utf8')
  } catch (error) {
    for (const entry of dirty) {
      if (entry.before === undefined) { if (existsSync(entry.file)) unlinkSync(entry.file) }
      else writeFileSync(entry.file, entry.before, 'utf8')
    }
    for (const file of newBackups) if (existsSync(file)) unlinkSync(file)
    if (oldManifest === undefined) { if (existsSync(manifestPath)) unlinkSync(manifestPath) }
    else writeFileSync(manifestPath, oldManifest, 'utf8')
    throw error
  }
  return { changed: true, needsApply: false, files: dirty.map(entry => entry.relative) }
}

function defaultAppDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
  const profile = path.join(home, 'profiles', 'tavern', 'package.json')
  if (existsSync(profile)) {
    const declared = JSON.parse(readFileSync(profile, 'utf8'))?.dshTavern?.source
    if (typeof declared === 'string' && declared) return path.resolve(declared)
  }
  return path.join(home, 'apps', 'dsh-tavern')
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    const position = args.indexOf('--app')
    if (position >= 0 && (!args[position + 1] || args[position + 1].startsWith('--'))) throw new Error('--app 缺少应用树路径')
    const appDir = position >= 0 ? path.resolve(args[position + 1]) : defaultAppDir()
    const result = applyLegacyViewSeams({ appDir, check: args.includes('--check'), uninstall: args.includes('--uninstall') })
    console.log(result.changed ? '原件只读接缝已更新；未重启服务。' : result.needsApply ? '需要施加原件只读接缝。' : '原件只读接缝已是最新。')
    process.exitCode = result.needsApply ? 3 : 0
  } catch (error) { console.error('原件只读接缝失败：' + String(error?.message || error)); process.exitCode = 1 }
}
