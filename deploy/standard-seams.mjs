// 标准启动唯一接入入口；作者模块尚未import时执行，绝不访问用户数据库。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { applyAllSeams, checkAllSeams, transformStorageIndex } from './apply-seams.mjs'
import { transformLegacyIndex } from './apply-legacy-view-seams.mjs'
import { applyHostTransform, applyBudgetTransform, applyHelperCurrentTransform } from './core-host-transform.mjs'
import { applyRuntimeTransform } from './core-runtime-transform.mjs'
import { applyOpeningRuntimeTransform } from './opening-runtime-transform.mjs'
import { applyRollbackTransform } from './core-rollback-transform.mjs'
import { applyModelErrorTransform } from './model-error-transform.mjs'
import { applyCompactionWarningTransform } from './compaction-warning-transform.mjs'
import { applyRowHistoryTransform, applyRowTimelineTransform } from './row-rollback-transform.mjs'
import { applySettlementRoundTransform } from './settlement-round-transform.mjs'
import { applyRollbackBusinessTimelineTransform, applyRollbackBusinessTurnTransform } from './rollback-business-transform.mjs'
import { applyRollbackWorldbookHistoryHostTransform } from './rollback-worldbook-history-transform.mjs'
import { applyCleanRollbackTransform } from './clean-rollback-transform.mjs'
import { applyRollbackSyncHandshakeTransform } from './rollback-sync-install-transform.mjs'
import { applyRollbackSyncHostTransform } from './rollback-sync-author-transform.mjs'
import { applyRollbackViewReaderTransform, applyRollbackLiveViewTransform } from './rollback-sync-state-transform.mjs'
import { applyRollbackBackgroundLifetimeTransform, applyRollbackBackgroundOwnerHostTransform } from './rollback-background-lifetime-transform.mjs'
import { applyRollbackGlobalAdapterTransform, applyRollbackGlobalHostTransform } from './rollback-global-transform.mjs'
import { applyRollbackCharacterAdapterTransform, applyRollbackCharacterHostTransform } from './rollback-character-transform.mjs'
import { applyRollbackWorldbookLibraryTransform, applyRollbackWorldbookAdapterTransform, applyRollbackWorldbookHostTransform, applyWorldbookSummaryCacheTransform } from './rollback-worldbook-transform.mjs'
import { applyRollbackBodyCommitTurnTransform, applyRollbackBodyCommitHostTransform, applyRollbackBodyCommitHandoffTransform, applyRollbackBodyCommitJobsTransform, applyRollbackBodyCommitHooksTransform } from './rollback-body-commit-transform.mjs'
import { applyRollbackBodySignalTurnTransform, applyRollbackBodySignalHostTransform, applyRollbackBodySignalHandoffTransform, applyRollbackBodySignalHooksTransform } from './rollback-body-signal-transform.mjs'
import { applyRollbackSharedBranchHostTransform, applyRollbackSharedBranchTurnTransform } from './rollback-shared-branch-transform.mjs'
import { applyRollbackWorldbookBindingsFileTransform, applyRollbackWorldbookBindingsHostTransform } from './rollback-worldbook-bindings-transform.mjs'
import { applyRollbackPendingViewTransform } from './rollback-pending-view-transform.mjs'
import { applySettlementQuiescenceTransform, applyForegroundQuiescenceTransform } from './rollback-quiescence-transform.mjs'
import { applyRollbackHostTransform, applyTemplateQuiescenceTransform, applyCandidateQuiescenceTransform, applyCompactionQuiescenceTransform } from './rollback-host-transform.mjs'
import { applyBackgroundTaskRollbackTransform, applyBackgroundHostRollbackTransform } from './background-rollback-transform.mjs'
import { applyBackgroundRetirementTransform, applyBackgroundRetirementHostTransform } from './background-retirement-transform.mjs'
import { applySessionResourceRouteTransform } from './session-resource-route-transform.mjs'
import { applyCurrentResourceAccessTransform, applyCurrentResourceHostTransform } from './session-current-resource-transform.mjs'

import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { clientCoreWrites } from './client-seams.mjs'
import { applyForkHistoryTransform } from './fork-history-transform.mjs'

const RECORD = '.tavern-standard-seams.json'
const DOMAIN = 'tavern-plugin/lib/domain/'
const TARGETS = [
  'tavern-plugin/lib/hooks/turn-lifecycle.js',
  'tavern-plugin/src/client/features/play-controls.js', 'tavern-plugin/src/client/features/turn-history.js',
  'tavern-plugin/src/client/ui/error-center.js', 'tavern-plugin/src/client/helper-resources.js',
  'tavern-plugin/src/client/runtime/helper-bootstrap.js', 'tavern-plugin/src/client/runtime/helper-script-runtime.js',
  'tavern-plugin/src/client/modules/host-session-patch.js',
  'tavern-plugin/src/client/modules/session-view-sync.js', 'tavern-plugin/src/client/modules/live-tavern-view.js', 'tavern-plugin/src/client/modules/tavern-coordination.js',
  'tavern-plugin/lib/index.js', 'tavern-plugin/src/client/main.js', 'tavern-plugin/lib/client.js', 'tavern-plugin/lib/background-agent-task.js', 'tavern-plugin/lib/background-agent-sessions.js',
  'tavern-plugin/lib/http/routes.js',
  ...['chat-sqlite-store.js', 'tavern-conversation-registry.js', 'conversation-initialization.js', 'session-view-reader.js',
    'legacy-view-seams.js', 'round-history.js', 'story-timeline.js', 'model-error-presentation.js', 'tavern-script-host-adapter.js', 'tavern-script-dispatch.js',
    'server-template-runtime.js', 'conversation-fork-point.js', 'chat-history-rescue.js',
    'opening-preparation.js', 'storage-opening-runtime.js', 'storage-fork-history.js', 'storage-server-execution.js', 'storage-rollback.js', 'storage-budgets.js', 'storage-package.js',
    'storage-current-variables.js', 'storage-compaction-warning.js', 'read-variables.js', 'storage-rollback-business.js', 'turn-orchestration.js', 'settlement-jobs.js', 'foreground-handoff.js', 'server-template-sync.js', 'candidate-worldbook-preparation.js', 'auto-compaction.js', 'chat-session-state.js', 'card-summary-cache.js', 'worldbook-library.js', 'file-resources.js', 'session-resource-access.js', 'background-session-retirement.js'].map(name => DOMAIN + name),
  '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json',
]
export const maintenanceTargets = Object.freeze([...TARGETS])
const DIRS = ['.', 'tavern-plugin/lib', 'tavern-plugin/lib/domain', 'tavern-plugin/lib/hooks', 'tavern-plugin/src/client', 'tavern-plugin/src/client/features', 'tavern-plugin/src/client/ui', 'tavern-plugin/src/client/runtime', 'tavern-plugin/src/client/modules']
function inside(root, rel) {
  const base = path.resolve(root), target = path.resolve(base, rel)
  if (!target.startsWith(base + path.sep)) throw new Error('接缝路径越界：' + rel)
  return target
}
const hash = data => createHash('sha256').update(data).digest('hex')
function artifacts(appDir) {
  const names = new Set(TARGETS)
  for (const rel of DIRS) {
    const dir = path.resolve(appDir, rel), root=path.resolve(appDir)
    for(let p=dir;;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('标准备份目录不接受符号链接：'+p);if(p===root)break}
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /(?:\.pre-seams-[\w-]+\.bak|\.legacy-view-seams\.backup|\.save-ui[^/]*\.backup)$/.test(entry.name)) {
        names.add(path.posix.join(rel === '.' ? '' : rel, entry.name))
      }
    }
  }
  return [...names].sort()
}
function snapshot(appDir) {
  return Object.fromEntries(artifacts(appDir).map(rel => {
    const file = inside(appDir, rel)
    return [rel, existsSync(file) ? readFileSync(file).toString('base64') : null]
  }))
}
function restore(appDir, before, owned = artifacts(appDir)) {
  for (const rel of new Set([...owned, ...Object.keys(before)])) {
    const file = inside(appDir, rel), body = before[rel]
    if (body == null) { if (existsSync(file)) unlinkSync(file) }
    else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(body, 'base64')) }
  }
}
function requireAuthor(appDir, authorVersion) {
  const pkg = JSON.parse(readFileSync(inside(appDir, 'tavern-plugin/package.json'), 'utf8'))
  if (pkg.name !== 'dsh-tavern-plugin' || pkg.version !== AUTHOR_VERSION || (authorVersion && authorVersion !== pkg.version)) {
    throw new Error('标准接入仅支持已适配作者' + AUTHOR_VERSION + '，拒绝未知版本')
  }
  return pkg
}
function text(appDir, rel) { return readFileSync(inside(appDir, rel), 'utf8') }
const RESOLVER = `// [dsh-tavern-standard-owned:v1]
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
export async function storagePackage(subpath) {
  let last
  for (const anchor of [path.join(home, 'profiles/tavern/package.json'), path.join(home, 'apps/dsh-tavern/package.json')]) {
    let url
    try { url = pathToFileURL(createRequire(anchor).resolve('dsh-tavern-sqlite-v2/' + subpath)).href }
    catch (error) { last = error; continue }
    // 路径命中后的加载异常直接上抛，不在另一个锚点重做初始化副作用。
    return await import(url)
  }
  throw new Error('标准核心模块不可用：' + subpath, { cause: last })
}
`
function shim(body) { return '// [dsh-tavern-standard-owned:v1]\n' + body }
function buildCore(appDir) {
  const write = new Map()
  // V2也需从裸S1/S2布局首装预检；纯转换保留服务端执行线，不复用V1浏览器转换。
  const indexSource = transformLegacyIndex(transformStorageIndex(text(appDir, 'tavern-plugin/lib/index.js')))
  write.set('tavern-plugin/lib/index.js', applyRollbackBodyCommitHostTransform(applyRollbackBodySignalHostTransform(applyRollbackSharedBranchHostTransform(applyRollbackWorldbookBindingsHostTransform(applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackBackgroundOwnerHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(applyBackgroundHostRollbackTransform(applyCompactionWarningTransform(applyHostTransform(indexSource)))))))))))))
  write.set('tavern-plugin/lib/index.js', applyRollbackWorldbookHistoryHostTransform(applyRollbackSyncHostTransform(write.get('tavern-plugin/lib/index.js'))))
  write.set('tavern-plugin/lib/index.js', applyCurrentResourceHostTransform(applyBackgroundRetirementHostTransform(write.get('tavern-plugin/lib/index.js'))))
  write.set(DOMAIN + 'session-resource-access.js', applyCurrentResourceAccessTransform(text(appDir, DOMAIN + 'session-resource-access.js')))
  write.set('tavern-plugin/lib/http/routes.js', applySessionResourceRouteTransform(text(appDir, 'tavern-plugin/lib/http/routes.js')))
  write.set(DOMAIN + 'background-session-retirement.js', applyBackgroundRetirementTransform(text(appDir, DOMAIN + 'background-session-retirement.js')))
  if(indexSource.includes('  registerTurnLifecycleHooks({'))write.set('tavern-plugin/lib/hooks/turn-lifecycle.js',applyRollbackBodyCommitHooksTransform(applyRollbackBodySignalHooksTransform(text(appDir,'tavern-plugin/lib/hooks/turn-lifecycle.js'))))
  write.set('tavern-plugin/lib/background-agent-sessions.js', applyRollbackBackgroundLifetimeTransform(text(appDir, 'tavern-plugin/lib/background-agent-sessions.js')))
  write.set('tavern-plugin/lib/background-agent-task.js', applyBackgroundTaskRollbackTransform(text(appDir, 'tavern-plugin/lib/background-agent-task.js')))
  write.set(DOMAIN + 'tavern-script-host-adapter.js', applyRollbackWorldbookAdapterTransform(applyRollbackCharacterAdapterTransform(applyRollbackGlobalAdapterTransform(applyHelperCurrentTransform(applyRuntimeTransform(text(appDir, DOMAIN + 'tavern-script-host-adapter.js')))))))
  write.set(DOMAIN + 'file-resources.js',applyRollbackWorldbookBindingsFileTransform(text(appDir,DOMAIN+'file-resources.js')))
  write.set(DOMAIN + 'worldbook-library.js',applyRollbackWorldbookLibraryTransform(text(appDir,DOMAIN+'worldbook-library.js')))
  if(existsSync(inside(appDir,DOMAIN+'card-summary-cache.js')))write.set(DOMAIN+'card-summary-cache.js',applyWorldbookSummaryCacheTransform(text(appDir,DOMAIN+'card-summary-cache.js')))
  write.set(DOMAIN + 'round-history.js', applyCleanRollbackTransform(applyRowHistoryTransform(applyRollbackTransform(text(appDir, DOMAIN + 'round-history.js')).text)))
  write.set(DOMAIN + 'story-timeline.js', applySettlementRoundTransform(applyRollbackBusinessTimelineTransform(applyRowTimelineTransform(text(appDir, DOMAIN + 'story-timeline.js')))))
  write.set(DOMAIN + 'turn-orchestration.js', applyRollbackBodyCommitTurnTransform(applyRollbackBodySignalTurnTransform(applyRollbackSharedBranchTurnTransform(applyRollbackBusinessTurnTransform(text(appDir, DOMAIN + 'turn-orchestration.js'))))))
  write.set(DOMAIN + 'settlement-jobs.js', applyRollbackBodyCommitJobsTransform(applySettlementQuiescenceTransform(text(appDir, DOMAIN + 'settlement-jobs.js'))))
  write.set(DOMAIN + 'foreground-handoff.js', applyRollbackBodyCommitHandoffTransform(applyRollbackBodySignalHandoffTransform(applyForegroundQuiescenceTransform(text(appDir, DOMAIN + 'foreground-handoff.js')))))
  write.set(DOMAIN + 'server-template-sync.js', applyTemplateQuiescenceTransform(text(appDir, DOMAIN + 'server-template-sync.js')))
  write.set(DOMAIN + 'candidate-worldbook-preparation.js', applyCandidateQuiescenceTransform(text(appDir, DOMAIN + 'candidate-worldbook-preparation.js')))
  write.set(DOMAIN + 'auto-compaction.js', applyCompactionQuiescenceTransform(text(appDir, DOMAIN + 'auto-compaction.js')))
  write.set(DOMAIN + 'chat-session-state.js', applyRollbackPendingViewTransform(text(appDir, DOMAIN + 'chat-session-state.js')))
  write.set(DOMAIN + 'storage-rollback-business.js', shim("import { storagePackage } from './storage-package.js'\nexport const { captureRollbackBusinessState, restoreRollbackBusinessState } = await storagePackage('rollback-business-state')\nexport const { rollbackBarrier, rollbackSchedulingBarrier } = await storagePackage('rollback-barrier')\nexport const { createRollbackWorldbookRecallLog } = await storagePackage('worldbook-recall-store')\nexport const { createRollbackGlobalVariables, rollbackGlobalOwner } = await storagePackage('rollback-global-variables')\nexport const { createRollbackExtensionSettings } = await storagePackage('rollback-extension-settings')\nexport const { createRollbackCharacterVariables } = await storagePackage('rollback-character-variables')\nexport const { createRollbackWorldbookResources } = await storagePackage('rollback-worldbook-resources')\nexport const { createRollbackWorldbookBindings } = await storagePackage('rollback-worldbook-bindings')\n"))
  write.set(DOMAIN + 'model-error-presentation.js', applyModelErrorTransform(text(appDir, DOMAIN + 'model-error-presentation.js')))
  write.set(DOMAIN + 'tavern-script-dispatch.js', applyBudgetTransform(text(appDir, DOMAIN + 'tavern-script-dispatch.js'), 'dispatch'))
  write.set(DOMAIN + 'server-template-runtime.js', applyBudgetTransform(text(appDir, DOMAIN + 'server-template-runtime.js'), 'template'))
  for (const [rel,body] of clientCoreWrites(appDir)) write.set(rel,body)
  write.set('tavern-plugin/src/client/modules/host-session-patch.js', applyRollbackSyncHandshakeTransform(text(appDir, 'tavern-plugin/src/client/modules/host-session-patch.js')))
  write.set('tavern-plugin/src/client/modules/session-view-sync.js', applyRollbackViewReaderTransform(text(appDir, 'tavern-plugin/src/client/modules/session-view-sync.js')))
  write.set('tavern-plugin/src/client/modules/live-tavern-view.js', applyRollbackLiveViewTransform(text(appDir, 'tavern-plugin/src/client/modules/live-tavern-view.js')))
  write.set(DOMAIN + 'storage-package.js', RESOLVER)
  write.set(DOMAIN + 'storage-compaction-warning.js', shim("import { storagePackage } from './storage-package.js'\nexport const { projectCompactionWarning } = await storagePackage('compaction-warning')\n"))
  write.set(DOMAIN + 'storage-current-variables.js', shim("import { storagePackage } from './storage-package.js'\nexport const { createCurrentVariableReader } = await storagePackage('current-variables')\n"))
  write.set(DOMAIN + 'read-variables.js', shim("import { storagePackage } from './storage-package.js'\nexport const { readVariables, registerVariableReadTool } = await storagePackage('read-variables')\n"))
  write.set(DOMAIN + 'storage-server-execution.js', shim("import { storagePackage } from './storage-package.js'\nconst impl = await storagePackage('server-execution')\nconst deps = await storagePackage('server-dependencies')\nimport path from 'node:path'\nimport os from 'node:os'\nimport * as authorScripts from './tavern-helper-scripts.js'\nimport { createHelperGenerationTasks } from './helper-generation-tasks.js'\nimport { installTavernHelperRegexApi } from './tavern-helper-regex-api.js'\nimport { createTavernRegexEngine } from './tavern-regex-engine.js'\nexport const createServerDispatchStore = deps.createServerDispatchStore\n// 卡schema使用作者随包发布的zod，与浏览器同源；不下载或伪造替代实现。\nlet zod, zodLoadError\ntry { zod = await import('../vendor/runtime-assets/zod/index.mjs') } catch (error) { zodLoadError = error }\nexport function createServerExecution(options) { return impl.createServerExecution({ ...options, createGenerationTasks: createHelperGenerationTasks, installRegexApi: installTavernHelperRegexApi, createRegexEngine: createTavernRegexEngine, esm: { cacheDir: path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern'), 'runtime-cache', 'tavern-esm'), ...options.esm }, lodash: deps.serverLodash(), YAML: deps.serverYaml(), zod, zodLoadError, project: authorScripts.projectTavernHelperScripts, isHostOwnedMvu: authorScripts.isHostOwnedMvu }) }\nexport function storageBrowserScripts(scripts, dispatchDeps = {}) { return impl.storageBrowserScripts(scripts, { isHostOwnedMvu: authorScripts.isHostOwnedMvu, ...dispatchDeps }) }\n"))
  const openingHostAnchor = 'createOpeningPreparation({ readCard, worldBooks, extensionSettings:'
  const openingHostNext = 'createOpeningPreparation({ readCard, worldBooks, dispatchMarksProvider: () => storageDispatchMarks, extensionSettings:'
  const openingHost = write.get('tavern-plugin/lib/index.js')
  if (!openingHost.includes(openingHostNext)) {
    if (openingHost.split(openingHostAnchor).length !== 2) throw new Error('开局动态分类宿主锚点缺失/重复')
    write.set('tavern-plugin/lib/index.js', openingHost.replace(openingHostAnchor, openingHostNext))
  }
  write.set(DOMAIN + 'opening-preparation.js', applyOpeningRuntimeTransform(text(appDir, DOMAIN + 'opening-preparation.js')))
  write.set(DOMAIN + 'storage-opening-runtime.js', shim("import { storagePackage } from './storage-package.js'\nimport { renderTavernMacros } from './tavern-macro-engine.js'\nconst impl = await storagePackage('opening-server-init')\nexport function initializeOpeningRuntime(options) {\n  return impl.initializeOpeningRuntime({ ...options, substituteMacros: (text, draft) => { const result = renderTavernMacros(text, { userName: draft.userName, charName: draft.card.name, localVariables: draft.chat.variables, globalVariables: draft.globalVariables || {} }); draft.chat.variables = result.localVariables; draft.globalVariables = result.globalVariables; return result.text } })\n}\n"))
  write.set(DOMAIN + 'storage-budgets.js', shim("import { storagePackage } from './storage-package.js'\nexport const { BUDGETS } = await storagePackage('budgets')\n"))
  write.set(DOMAIN + 'storage-rollback.js', shim("import { storagePackage } from './storage-package.js'\nimport { sessionEvents } from './session-events.js'\nconst impl = await storagePackage('rollback-cleanup')\nimpl.configureRollbackCleanup({ sessionEvents })\nexport const { cleanupAfterRollback, cleanupRollbackHeadIndex, preflightRollback, preflightRollbackAtSeq, cleanupAfterRollbackAtSeq } = impl\nexport const { cleanRollback } = await storagePackage('clean-rollback')\n"))
  write.set(DOMAIN + 'conversation-fork-point.js', shim("import { storagePackage } from './storage-package.js'\nimport { isRescuedHistoryMessage } from './chat-history-rescue.js'\nimport { assistantResultForTurn } from './session-turn-result.js'\nimport { sessionEvents } from './session-events.js'\nimport { assertConversationForkable } from './conversation-fork.js'\nconst impl = await storagePackage('conversation-fork-point')\nimpl.configureConversationForkPoint({ isRescuedHistoryMessage, assistantResultForTurn, sessionEvents, assertConversationForkable })\nexport const { conversationStateAtTurn, conversationForkBoundary } = impl\n"))
  write.set(DOMAIN + 'chat-history-rescue.js', shim("import { storagePackage } from './storage-package.js'\nexport const { rescueHistoryInput, isRescuedHistoryMessage, assertRescueHistoryEditable, rescueHistoryNotice } = await storagePackage('chat-history-rescue')\n"))
  write.set(DOMAIN + 'storage-fork-history.js', shim("import { storagePackage } from './storage-package.js'\nexport const { normalizeForkHistoryMarkers } = await storagePackage('fork-history-markers')\n"))
  write.set('tavern-plugin/lib/index.js', applyForkHistoryTransform(write.get('tavern-plugin/lib/index.js')))
  // 新版Chat协议shim必须逐字更新，不能只凭首行标记跳过旧副本。
  write.set(DOMAIN + 'chat-sqlite-store.js', readFileSync(new URL('./chat-sqlite-store.shim.js', import.meta.url), 'utf8'))
  return write
}
export function checkStandardSeams({ appDir, authorVersion } = {}) {
  requireAuthor(appDir, authorVersion)
  const file = inside(appDir, RECORD)
  if (!existsSync(file)) return { ready: false, coverage: 'standard-core', reason: '尚未标准接入' }
  const record = JSON.parse(readFileSync(file, 'utf8'))
  if (record.version !== 1 || record.authorVersion !== AUTHOR_VERSION) throw new Error('标准接入记录版本未知')
  for (const [rel, expected] of Object.entries(record.after)) {
    const target = inside(appDir, rel)
    if (!existsSync(target) || hash(readFileSync(target)) !== expected) throw new Error('标准接入文件发生漂移，拒绝旧原像覆盖更新：' + rel)
  }
  const core = buildCore(appDir)
  const pending = [...core].filter(([rel, body]) => text(appDir, rel) !== body).map(([rel]) => rel)
  return { ready: checkAllSeams({ appDir }).ready && pending.length === 0, coverage: 'standard-core', pending }
}
export function applyStandardSeams({ appDir, authorVersion } = {}) {
  requireAuthor(appDir, authorVersion)
  const state = checkStandardSeams({ appDir, authorVersion })
  if (state.ready) return { changed: false, ...state }
  // 所有核心锚点先算；版本不符、必要锚点缺失/重复或既有受管文件漂移时写前拒绝。
  const core = buildCore(appDir)
  const before = snapshot(appDir), recordPath = inside(appDir, RECORD)
  const previousRecord = existsSync(recordPath) ? readFileSync(recordPath) : null
  // 标准记录缺失时，不能把完整核心接管态捕获成“首装前像”。历史S1/S2升级仍由其manifest恢复链管理。
  if (!previousRecord && text(appDir, 'tavern-plugin/lib/index.js').includes('[dsh-tavern-core-host:v1]')) throw new Error('前像污染：核心接缝仍在但标准记录缺失，拒绝从当前缝合态重建记录')
  try {
    applyAllSeams({ appDir })
    // 原S1/S2/legacy/UI会修改相同入口和客户端；核心转换必须用刚施缝的当前源码。
    core.set('tavern-plugin/lib/index.js', applyRollbackBodyCommitHostTransform(applyRollbackBodySignalHostTransform(applyRollbackSharedBranchHostTransform(applyRollbackWorldbookBindingsHostTransform(applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackBackgroundOwnerHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(applyBackgroundHostRollbackTransform(applyCompactionWarningTransform(applyHostTransform(text(appDir, 'tavern-plugin/lib/index.js'))))))))))))))
    core.set('tavern-plugin/lib/index.js', applyRollbackWorldbookHistoryHostTransform(applyRollbackSyncHostTransform(core.get('tavern-plugin/lib/index.js'))))
    core.set('tavern-plugin/lib/index.js', applyCurrentResourceHostTransform(applyBackgroundRetirementHostTransform(applyForkHistoryTransform(core.get('tavern-plugin/lib/index.js')))))
    const openingHostAnchor = 'createOpeningPreparation({ readCard, worldBooks, extensionSettings:'
    const openingHostNext = 'createOpeningPreparation({ readCard, worldBooks, dispatchMarksProvider: () => storageDispatchMarks, extensionSettings:'
    if (!core.get('tavern-plugin/lib/index.js').includes(openingHostNext)) {
      if (core.get('tavern-plugin/lib/index.js').split(openingHostAnchor).length !== 2) throw new Error('开局动态分类宿主锚点缺失/重复')
      core.set('tavern-plugin/lib/index.js', core.get('tavern-plugin/lib/index.js').replace(openingHostAnchor, openingHostNext))
    }
    for (const [rel,body] of clientCoreWrites(appDir)) core.set(rel,body)
    for (const [rel, body] of core) {
      const target = inside(appDir, rel)
      if (existsSync(target) && text(appDir, rel) === body) continue
      if (rel.includes('/storage-') && existsSync(target) && !text(appDir, rel).startsWith('// [dsh-tavern-standard-owned:v1]')) throw new Error('作者已有同名核心垫片，拒绝覆盖：' + rel)
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body, 'utf8')
    }
    for (const rel of core.keys()) {
      const result = spawnSync(process.execPath, ['--check', inside(appDir, rel)], { stdio: 'inherit', windowsHide: true })
      if (result.status !== 0) throw new Error('核心接缝语法拒绝：' + rel)
    }
    const after = Object.fromEntries(artifacts(appDir).filter(rel => existsSync(inside(appDir, rel))).map(rel => [rel, hash(readFileSync(inside(appDir, rel)))]))
    const old = previousRecord ? JSON.parse(previousRecord.toString('utf8')) : undefined
    writeFileSync(recordPath, JSON.stringify({ version: 1, authorVersion: AUTHOR_VERSION, before: old?.before ? { ...before, ...old.before } : before, after }, null, 2) + '\n', 'utf8')
    return { changed: true, ready: true, coverage: 'standard-core', files: [...core.keys()] }
  } catch (error) {
    restore(appDir, before)
    if (previousRecord) writeFileSync(recordPath, previousRecord)
    else if (existsSync(recordPath)) unlinkSync(recordPath)
    throw new Error('标准接入失败，已恢复本次源码前像', { cause: error })
  }
}
export function uninstallStandardSeams({ appDir } = {}) {
  const file = inside(appDir, RECORD)
  if (!existsSync(file)) return { changed: false }
  checkStandardSeams({ appDir }) // 有漂移则不写：不能把旧作者源码覆盖到新版本。
  const current = snapshot(appDir), recordBytes = readFileSync(file)
  const record = JSON.parse(recordBytes.toString('utf8'))
  const indexImage = record.before['tavern-plugin/lib/index.js']
  if (typeof indexImage !== 'string' || !indexImage || Buffer.from(indexImage, 'base64').toString('base64') !== indexImage) throw new Error('标准前像缺合法作者入口，拒绝写入恢复')
  const originalIndex = Buffer.from(indexImage, 'base64').toString('utf8')
  if (originalIndex.includes('[dsh-tavern-core-host:v1]')) throw new Error('前像污染：标准代前像含完整核心接缝；拒绝落盘恢复，请由一键维护入口验证历史安装材料')
  try {
    // 卸载只撤record明确覆盖的文件；事后出现的无关备份不因遍历而被删除。
    restore(appDir, record.before, Object.keys(record.after))
    // 只恢复本标准代拥有的升级前像；预先存在的历史接缝不冒认、不猜测撤除。
    // 裸作者首装的before就是裸源码；旧已施缝树恢复为其升级前代，整包移除仍须历史记录维护。
    unlinkSync(file)
    return { changed: true, requiresRestart: true, restored: 'standard-generation-before-image',
      legacySeamsRemain: ['.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json'].some(rel => existsSync(inside(appDir, rel))) }
  } catch (error) {
    restore(appDir, current); writeFileSync(file, recordBytes)
    throw new Error('标准卸缝失败，已恢复源码当前代；不承诺热切回文件后端', { cause: error })
  }
}
