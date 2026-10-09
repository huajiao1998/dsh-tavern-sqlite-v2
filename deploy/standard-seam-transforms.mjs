// 唯一纯业务接线工厂：输入本次真实作者源码，输出目标实现；无备份、无旧协议写入。
import { readFileSync } from 'node:fs'
import { transformStorageIndex } from './apply-seams.mjs'
import { transformLegacyIndex, transformLegacyRegistry, transformLegacyInitialization, transformLegacyViewReader, LEGACY_VIEW_SHIM } from './apply-legacy-view-seams.mjs'
const DOMAIN='tavern-plugin/lib/domain/'
import { applyHostTransform, applyBudgetTransform, applyHelperCurrentTransform } from './core-host-transform.mjs'
import { applyRuntimeTransform } from './core-runtime-transform.mjs'
import { applyOpeningRuntimeTransform } from './opening-runtime-transform.mjs'
import { applyRollbackTransform } from './core-rollback-transform.mjs'
import { applyModelErrorTransform } from './model-error-transform.mjs'
import { applyCompactionWarningTransform } from './compaction-warning-transform.mjs'
import { applyDbSaveHostTransform, applyDbSaveFootprintTransform, applyDbSaveFootprintHostTransform } from './db-save-transform.mjs'
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

import { clientCoreWrites } from './client-seams.mjs'
import { applyForkHistoryTransform } from './fork-history-transform.mjs'
import { applyNativeDataTransform, isNativeDataApplied, ANCHORS as NATIVE_DATA_ANCHORS } from './native-data-transform.mjs'
import { applyNativeMessageTransform, isNativeMessageApplied, applyNativeMessageHostTransform } from './native-data-transform.mjs'
import { applyLatestFailureHostTransform, applyLatestFailureViewTransform } from './latest-failure-transform.mjs'


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
// 原生数据服务只接「完整 opening 合同」的作者代：全部锚点各恰一次才施转换/生成桥；
// 已应用标记（幂等输入）同样放行——applyNativeDataTransform 幂等返回、桥照常重生成，
// 否则 check 的 buildCore 对比会误报 pending。旧代（缺任一锚点/布局重复）保持原兼容投影。
function nativeDataCapable(source) {
  if (isNativeDataApplied(source)) return true
  // split 片段数 = 出现次数 + 1：恰一次 ⇒ length === 2（写成 1 会把所有真实作者代误判为不可接）。
  return Object.values(NATIVE_DATA_ANCHORS).every(anchor => typeof anchor === 'string' && source.split(anchor).length === 2)
}
const NATIVE_DATA_OPTIONS = { projectorImportPath: './domain/storage-native-data.js' }

export function buildCore(appDir, sourceFiles) {
  const text = (_root, rel) => { if (!sourceFiles.has(rel)) throw Error('缺少接入源码：'+rel); return sourceFiles.get(rel) }
  const present = rel => sourceFiles.has(rel)
  const write = new Map()
  // V2也需从裸S1/S2布局首装预检；纯转换保留服务端执行线，不复用V1浏览器转换。
  const legacyIndex = transformLegacyIndex(transformStorageIndex(text(appDir, 'tavern-plugin/lib/index.js')))
  const indexSource = nativeDataCapable(legacyIndex) ? applyNativeMessageHostTransform(legacyIndex) : legacyIndex
  write.set('tavern-plugin/lib/index.js', applyRollbackBodyCommitHostTransform(applyRollbackBodySignalHostTransform(applyRollbackSharedBranchHostTransform(applyRollbackWorldbookBindingsHostTransform(applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackBackgroundOwnerHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(applyBackgroundHostRollbackTransform(applyCompactionWarningTransform(applyHostTransform(indexSource)))))))))))))
  write.set('tavern-plugin/lib/index.js', applyLatestFailureHostTransform(applyRollbackWorldbookHistoryHostTransform(applyRollbackSyncHostTransform(write.get('tavern-plugin/lib/index.js')))))
  write.set('tavern-plugin/lib/index.js', applyCurrentResourceHostTransform(applyBackgroundRetirementHostTransform(applyForkHistoryTransform(write.get('tavern-plugin/lib/index.js')))))
  const saveHost = write.get('tavern-plugin/lib/index.js')
  if (saveHost.includes('  async function exportGameSave(') || saveHost.includes('// [dsh-tavern-db-save:v1]')) {
    write.set('tavern-plugin/lib/index.js', applyDbSaveFootprintHostTransform(applyDbSaveHostTransform(saveHost)))
    if (present(DOMAIN + 'game-footprint.js')) write.set(DOMAIN + 'game-footprint.js', applyDbSaveFootprintTransform(text(appDir, DOMAIN + 'game-footprint.js')))
    write.set(DOMAIN + 'storage-db-save.js', shim("import { storagePackage } from './storage-package.js'\nexport const { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } = await storagePackage('db-save-exchange')\n"))
  }
  write.set(DOMAIN + 'tavern-conversation-registry.js', transformLegacyRegistry(text(appDir, DOMAIN + 'tavern-conversation-registry.js')))
  write.set(DOMAIN + 'conversation-initialization.js', transformLegacyInitialization(text(appDir, DOMAIN + 'conversation-initialization.js')))
  write.set(DOMAIN + 'session-view-reader.js', transformLegacyViewReader(text(appDir, DOMAIN + 'session-view-reader.js')))
  write.set(DOMAIN + 'legacy-view-seams.js', LEGACY_VIEW_SHIM)
  write.set(DOMAIN + 'session-resource-access.js', applyCurrentResourceAccessTransform(text(appDir, DOMAIN + 'session-resource-access.js')))
  write.set('tavern-plugin/lib/http/routes.js', applySessionResourceRouteTransform(text(appDir, 'tavern-plugin/lib/http/routes.js')))
  write.set(DOMAIN + 'background-session-retirement.js', applyBackgroundRetirementTransform(text(appDir, DOMAIN + 'background-session-retirement.js')))
  if(indexSource.includes('  registerTurnLifecycleHooks({'))write.set('tavern-plugin/lib/hooks/turn-lifecycle.js',applyRollbackBodyCommitHooksTransform(applyRollbackBodySignalHooksTransform(text(appDir,'tavern-plugin/lib/hooks/turn-lifecycle.js'))))
  write.set('tavern-plugin/lib/background-agent-sessions.js', applyRollbackBackgroundLifetimeTransform(text(appDir, 'tavern-plugin/lib/background-agent-sessions.js')))
  write.set('tavern-plugin/lib/background-agent-task.js', applyBackgroundTaskRollbackTransform(text(appDir, 'tavern-plugin/lib/background-agent-task.js')))
  write.set(DOMAIN + 'tavern-script-host-adapter.js', applyRollbackWorldbookAdapterTransform(applyRollbackCharacterAdapterTransform(applyRollbackGlobalAdapterTransform(applyHelperCurrentTransform(applyRuntimeTransform(text(appDir, DOMAIN + 'tavern-script-host-adapter.js')))))))
  write.set(DOMAIN + 'file-resources.js',applyRollbackWorldbookBindingsFileTransform(text(appDir,DOMAIN+'file-resources.js')))
  write.set(DOMAIN + 'worldbook-library.js',applyRollbackWorldbookLibraryTransform(text(appDir,DOMAIN+'worldbook-library.js')))
  if(present(DOMAIN+'card-summary-cache.js'))write.set(DOMAIN+'card-summary-cache.js',applyWorldbookSummaryCacheTransform(text(appDir,DOMAIN+'card-summary-cache.js')))
  write.set(DOMAIN + 'round-history.js', applyCleanRollbackTransform(applyRowHistoryTransform(applyRollbackTransform(text(appDir, DOMAIN + 'round-history.js')).text)))
  write.set(DOMAIN + 'story-timeline.js', applySettlementRoundTransform(applyRollbackBusinessTimelineTransform(applyRowTimelineTransform(text(appDir, DOMAIN + 'story-timeline.js')))))
  write.set(DOMAIN + 'turn-orchestration.js', applyRollbackBodyCommitTurnTransform(applyRollbackBodySignalTurnTransform(applyRollbackSharedBranchTurnTransform(applyRollbackBusinessTurnTransform(text(appDir, DOMAIN + 'turn-orchestration.js'))))))
  write.set(DOMAIN + 'settlement-jobs.js', applyRollbackBodyCommitJobsTransform(applySettlementQuiescenceTransform(text(appDir, DOMAIN + 'settlement-jobs.js'))))
  write.set(DOMAIN + 'foreground-handoff.js', applyRollbackBodyCommitHandoffTransform(applyRollbackBodySignalHandoffTransform(applyForegroundQuiescenceTransform(text(appDir, DOMAIN + 'foreground-handoff.js')))))
  write.set(DOMAIN + 'server-template-sync.js', applyTemplateQuiescenceTransform(text(appDir, DOMAIN + 'server-template-sync.js')))
  write.set(DOMAIN + 'candidate-worldbook-preparation.js', applyCandidateQuiescenceTransform(text(appDir, DOMAIN + 'candidate-worldbook-preparation.js')))
  write.set(DOMAIN + 'auto-compaction.js', applyCompactionQuiescenceTransform(text(appDir, DOMAIN + 'auto-compaction.js')))
  write.set(DOMAIN + 'chat-session-state.js', applyLatestFailureViewTransform(applyRollbackPendingViewTransform(text(appDir, DOMAIN + 'chat-session-state.js'))))
  write.set(DOMAIN + 'storage-rollback-business.js', shim("import { storagePackage } from './storage-package.js'\nexport const { captureRollbackBusinessState, restoreRollbackBusinessState } = await storagePackage('rollback-business-state')\nexport const { rollbackBarrier, rollbackSchedulingBarrier } = await storagePackage('rollback-barrier')\nexport const { createRollbackWorldbookRecallLog } = await storagePackage('worldbook-recall-store')\nexport const { createRollbackGlobalVariables, rollbackGlobalOwner } = await storagePackage('rollback-global-variables')\nexport const { createRollbackExtensionSettings } = await storagePackage('rollback-extension-settings')\nexport const { createRollbackCharacterVariables } = await storagePackage('rollback-character-variables')\nexport const { createRollbackWorldbookResources } = await storagePackage('rollback-worldbook-resources')\nexport const { createRollbackWorldbookBindings } = await storagePackage('rollback-worldbook-bindings')\n"))
  write.set(DOMAIN + 'model-error-presentation.js', applyModelErrorTransform(text(appDir, DOMAIN + 'model-error-presentation.js')))
  write.set(DOMAIN + 'tavern-script-dispatch.js', applyBudgetTransform(text(appDir, DOMAIN + 'tavern-script-dispatch.js'), 'dispatch'))
  write.set(DOMAIN + 'server-template-runtime.js', applyBudgetTransform(text(appDir, DOMAIN + 'server-template-runtime.js'), 'template'))
  for (const [rel,body] of clientCoreWrites(appDir,{sourceReader:rel=>text(appDir,rel)})) write.set(rel,body)
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
  write.set(DOMAIN + 'storage-rollback.js', shim("import { storagePackage } from './storage-package.js'\nimport { sessionEvents } from './session-events.js'\nconst impl = await storagePackage('rollback-cleanup')\nimpl.configureRollbackCleanup({ sessionEvents })\nexport const { cleanupAfterRollback, cleanupRollbackHeadIndex, preflightRollback, preflightRollbackAtSeq, cleanupAfterRollbackAtSeq } = impl\nexport const { cleanRollback, inspectNativeFailureTail, readFailureEvidence } = await storagePackage('clean-rollback')\n"))
  write.set(DOMAIN + 'conversation-fork-point.js', shim("import { storagePackage } from './storage-package.js'\nimport { isRescuedHistoryMessage } from './chat-history-rescue.js'\nimport { assistantResultForTurn } from './session-turn-result.js'\nimport { sessionEvents } from './session-events.js'\nimport { assertConversationForkable } from './conversation-fork.js'\nconst impl = await storagePackage('conversation-fork-point')\nimpl.configureConversationForkPoint({ isRescuedHistoryMessage, assistantResultForTurn, sessionEvents, assertConversationForkable })\nexport const { conversationStateAtTurn, conversationForkBoundary } = impl\n"))
  write.set(DOMAIN + 'chat-history-rescue.js', shim("import { storagePackage } from './storage-package.js'\nexport const { rescueHistoryInput, isRescuedHistoryMessage, assertRescueHistoryEditable, rescueHistoryNotice } = await storagePackage('chat-history-rescue')\n"))
  write.set(DOMAIN + 'storage-fork-history.js', shim("import { storagePackage } from './storage-package.js'\nexport const { normalizeForkHistoryMarkers } = await storagePackage('fork-history-markers')\n"))
  // 原生数据服务只接支持 opening 合同的作者代；旧代继续原兼容投影。
  if (nativeDataCapable(write.get('tavern-plugin/lib/index.js'))) {
    write.set('tavern-plugin/lib/index.js', applyNativeDataTransform(write.get('tavern-plugin/lib/index.js'), NATIVE_DATA_OPTIONS))
    write.set(DOMAIN + 'storage-native-data.js', shim("import { storagePackage } from './storage-package.js'\nexport const { createSessionWindowProjector, createActivitySummaryBridge } = await storagePackage('session-window-projector')\n"))
    // S5 与宿主最终代同一门控，接在turn其它回退接线后；不再依赖旧恢复资产中是否有此文件。
    write.set(DOMAIN + 'turn-orchestration.js', applyNativeMessageTransform(write.get(DOMAIN + 'turn-orchestration.js'), 'appendMessages'))
    if (present(DOMAIN + 'background-task-coordinator.js')) write.set(DOMAIN + 'background-task-coordinator.js', applyNativeMessageTransform(text(appDir, DOMAIN + 'background-task-coordinator.js'), 'setMessageFloor'))
  }
  // 接管期的资源历史恢复也属于可撤接缝；不在 CLI 块外永久改作者入口。
  const startup = write.get('tavern-plugin/lib/index.js')
  const initializer = '    const recoveredIndex = await initializeRuntimeState()'
  const recovery = "    setImmediate(function () {\n      recoverRuntimeHistory(recoveredIndex).catch(function (error) {\n        console.error('dsh-tavern: 后台恢复历史对话失败', error && error.message || error)\n      })\n    })"
  // 旧 CLI 卸载后可能留下用户已授权的独立启动保护；它是当前源码，不回填旧原文，也不要求重新注入。
  const alreadyProtected = startup.includes('    const recoveredIndex = { chats: [] }') && !startup.includes('recoverRuntimeHistory(recoveredIndex).catch(')
  if (!alreadyProtected) {
    if (startup.split(initializer).length !== 2 || startup.split(recovery).length !== 2) throw Error('接管期启动历史恢复接口缺失或不唯一')
    write.set('tavern-plugin/lib/index.js', startup.replace(initializer, '    // 接管期不扫描或自动迁移原档；卸载解除现场原代码注释。\n    const recoveredIndex = { chats: [] }').replace(recovery, '    // 接管期不自动启动作者历史恢复；用户明确操作仍沿各自接口。'))
  }
  // 新版Chat协议shim必须更新，不能只凭首行标记跳过旧副本。
  write.set(DOMAIN + 'chat-sqlite-store.js', readFileSync(new URL('./chat-sqlite-store.shim.js', import.meta.url), 'utf8'))
  return write
}
