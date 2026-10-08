// 标准启动唯一接入入口；作者模块尚未import时执行，绝不访问用户数据库。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
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
import { applyDbSaveHostTransform } from './db-save-transform.mjs'
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
import { classifyAuthorCompatibility, loadAuthorImages, authorImages } from './author-compatibility.mjs'
import { planAuthorRebase } from './author-rebase-plan.mjs'

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
    'storage-db-save.js', 'storage-current-variables.js', 'storage-compaction-warning.js', 'read-variables.js', 'storage-rollback-business.js', 'turn-orchestration.js', 'settlement-jobs.js', 'foreground-handoff.js', 'server-template-sync.js', 'candidate-worldbook-preparation.js', 'auto-compaction.js', 'chat-session-state.js', 'card-summary-cache.js', 'worldbook-library.js', 'file-resources.js', 'session-resource-access.js', 'background-session-retirement.js'].map(name => DOMAIN + name),
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
let cachedImages = null
function trustedAuthorImages() {
  if (cachedImages === null) cachedImages = authorImages(loadAuthorImages())
  return cachedImages
}
function readStandardRecord(appDir) {
  artifacts(appDir) // 读取记录及其目标之前先拒绝有限目录中的外部链接。
  const file = inside(appDir, RECORD)
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw Error('标准记录不是普通文件')
  if (!existsSync(file)) return null
  const record = JSON.parse(readFileSync(file, 'utf8'))
  const object = value => value && typeof value === 'object' && !Array.isArray(value)
  if (record.version !== 1 || typeof record.authorVersion !== 'string' || !record.authorVersion.trim() || !object(record.before) || !object(record.after) || !Object.keys(record.after).length) throw Error('标准接入记录格式未知')
  const allowed = rel => TARGETS.includes(rel) || (DIRS.includes(path.posix.dirname(rel)) && /\.(?:pre-seams-[\w-]+\.bak|legacy-view-seams\.backup|save-ui[^/]*\.backup)$/.test(path.posix.basename(rel)))
  if (!Object.hasOwn(record.after, 'tavern-plugin/lib/index.js') || !Object.hasOwn(record.before, 'tavern-plugin/lib/index.js')) throw Error('标准记录缺少作者入口归属')
  for (const rel of new Set([...Object.keys(record.before), ...Object.keys(record.after)])) {
    if (!allowed(rel)) throw Error('标准记录越过有限源码目标：' + rel)
    const target = inside(appDir, rel)
    if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw Error('标准目标不是普通文件：' + rel)
  }
  for (const [rel, body] of Object.entries(record.before)) if (body !== null && (typeof body !== 'string' || Buffer.from(body, 'base64').toString('base64') !== body)) throw Error('标准前像编码不合法：' + rel)
  for (const [rel, digest] of Object.entries(record.after)) if (!/^[a-f0-9]{64}$/.test(digest)) throw Error('标准后像摘要不合法：' + rel)
  return record
}
/** 只读投影：旧 before 仅用于还原已核 after 的文件，最终必须匹配同一可信作者契约。 */
function compatibleAuthorVerdict(appDir) {
  const record = readStandardRecord(appDir)
  if (!record) return classifyAuthorCompatibility({ appDir, targets: TARGETS, images: trustedAuthorImages() })
  const plan = planAuthorRebase({ appDir, targets: TARGETS, record, images: trustedAuthorImages() })
  return { ...plan, ok: plan.compatible }
}
function authorManifest(appDir) {
  return JSON.parse(readFileSync(inside(appDir, 'tavern-plugin/package.json'), 'utf8'))
}
/** 已施缝同代：标准记录 schema 合法且 record.after 与当前文件逐一相符（记录 CAS 即“本次已接受”的证明）。 */
function appliedRecordIntact(appDir) {
  const recordFile = inside(appDir, RECORD)
  if (!existsSync(recordFile)) return null
  try {
    const record = readStandardRecord(appDir)
    const intact = Object.entries(record.after).every(([rel, expected]) => {
      const target = inside(appDir, rel)
      return existsSync(target) && hash(readFileSync(target)) === expected
    })
    return intact ? record : null
  } catch { return null }
}
/**
 * 作者门禁：同版走原有严格路径；**仅当 allowRebase**（install/apply/运行时 initial prepare）且版本不同时，
 * 才用共享兼容判定（单一共同基线覆盖全部作者目标）放行；uninstall/dispose 永不传 allowRebase。
 */
function requireAuthor(appDir, authorVersion, { allowRebase = false } = {}) {
  const pkg = authorManifest(appDir)
  if (pkg.name !== 'dsh-tavern-plugin') throw new Error('标准接入仅支持作者包 dsh-tavern-plugin，拒绝未知包名')
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw Error('作者版本字段不合法')
  if (authorVersion !== undefined && authorVersion !== pkg.version) throw Error('作者版本与解析所得版本不一致')
  if (pkg.version === AUTHOR_VERSION) return pkg
  // 已施缝同代（record.after 全等）无需 rebase 也无需资产比对：记录 CAS 即证明；结构由严格 transform 检查兜底。
  if (appliedRecordIntact(appDir)) return { ...pkg, compatible: { ok: true, mode: 'applied', matchedCommit: null, skippedOwned: [], failures: [] } }
  if (!allowRebase) throw new Error('标准接入仅支持已适配作者' + AUTHOR_VERSION + '，拒绝未知版本')
  const verdict = compatibleAuthorVerdict(appDir)
  if (!verdict.ok) throw new Error('作者版本 ' + pkg.version + ' 与可信基线不兼容：' + verdict.failures.slice(0, 5).join('；'))
  return { ...pkg, compatible: verdict }
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
  const saveHost = write.get('tavern-plugin/lib/index.js')
  if (saveHost.includes('  async function exportGameSave(') || saveHost.includes('// [dsh-tavern-db-save:v1]')) {
    write.set('tavern-plugin/lib/index.js', applyDbSaveHostTransform(saveHost))
    write.set(DOMAIN + 'storage-db-save.js', shim("import { storagePackage } from './storage-package.js'\nexport const { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } = await storagePackage('db-save-exchange')\n"))
  }
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
export function checkStandardSeams({ appDir, authorVersion, allowRebase = false } = {}) {
  const author = requireAuthor(appDir, authorVersion, { allowRebase })
  const file = inside(appDir, RECORD)
  if (!existsSync(file)) return { ready: false, coverage: 'standard-core', reason: '尚未标准接入' }
  const record = readStandardRecord(appDir)
  // 作者版本用于诊断；已接入态的真正判据是全部 after 摘要和消费者复检。
  const drifted = []
  for (const [rel, expected] of Object.entries(record.after)) {
    const target = inside(appDir, rel)
    if (!existsSync(target) || hash(readFileSync(target)) !== expected) drifted.push(rel)
  }
  if (drifted.length > 0) {
    if (!allowRebase) throw new Error('标准接入文件发生漂移，拒绝旧原像覆盖更新：' + drifted[0])
    const compatible = compatibleAuthorVerdict(appDir)
    if (!compatible.ok) throw Error('作者更新不兼容，保留现场：' + compatible.failures.slice(0, 5).join('；'))
    return { ready: false, coverage: 'standard-core', pending: [], drifted, needsReapply: true, compatible }
  }
  const core = buildCore(appDir)
  const pending = [...core].filter(([rel, body]) => text(appDir, rel) !== body).map(([rel]) => rel)
  return { ready: checkAllSeams({ appDir }).ready && pending.length === 0, coverage: 'standard-core', pending, drifted }
}
function applyCompatibleRebase(appDir, plan) {
  if (!plan?.ok || !plan.before) throw Error('兼容重接缺少已证明的作者前像')
  const original = snapshot(appDir), recordFile = inside(appDir, RECORD), oldRecord = readFileSync(recordFile)
  let writeStarted = false
  const stage = mkdtempSync(path.join(os.tmpdir(), 'dsh-author-rebase-'))
  try {
    // 副本只包含有限程序源码，旧自有记录/备份归零，重新生成正确的新作者恢复链。
    for (const [rel, body] of Object.entries(plan.before)) if (body !== null) {
      const target = inside(stage, rel)
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(body, 'base64'))
    }
    const result = applyStandardSeams({ appDir: stage, allowRebase: true })
    if (!checkStandardSeams({ appDir: stage }).ready) throw Error('兼容重接副本未就绪')
    // 展示字段使用真实应用根；重新计算记录摘要，不篡改旧记录来假称一致。
    for (const rel of ['.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']) {
      const file = inside(stage, rel)
      if (existsSync(file)) { const metadata = JSON.parse(readFileSync(file, 'utf8')); if (Object.hasOwn(metadata, 'app')) metadata.app = path.resolve(appDir); writeFileSync(file, JSON.stringify(metadata, null, 2) + '\n', 'utf8') }
    }
    const freshFile = inside(stage, RECORD), fresh = JSON.parse(readFileSync(freshFile, 'utf8'))
    const image = snapshot(stage)
    fresh.after = Object.fromEntries(Object.entries(image).filter(([, body]) => body !== null).map(([rel, body]) => [rel, hash(Buffer.from(body, 'base64'))]))
    writeFileSync(freshFile, JSON.stringify(fresh, null, 2) + '\n', 'utf8')
    const previous = JSON.parse(oldRecord.toString('utf8'))
    for (const [rel, body] of Object.entries(image)) if (body !== null && !TARGETS.includes(rel) && original[rel] !== undefined && original[rel] !== null && !Object.hasOwn(previous.after, rel)) throw Error('新备份与未知现场文件冲突，拒绝覆盖：' + rel)
    // 写前比较有限现场和标准记录；不在副本预演期间覆盖外部更新。
    const now = snapshot(appDir)
    if (JSON.stringify(now) !== JSON.stringify(original) || !readFileSync(recordFile).equals(oldRecord)) throw Error('兼容预演期间作者树发生变化，拒绝覆盖')
    // 仅撤当前记录已经证明归属的自有文件；未列入旧记录的额外备份保持不动。
    writeStarted = true
    for (const rel of plan.ownedCleanup) if (!Object.hasOwn(image, rel) || image[rel] === null) {
      const target = inside(appDir, rel); if (existsSync(target)) unlinkSync(target)
    }
    for (const [rel, body] of Object.entries(image)) if (body !== null) {
      const target = inside(appDir, rel); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(body, 'base64'))
    }
    writeFileSync(recordFile, readFileSync(freshFile))
    if (!checkStandardSeams({ appDir }).ready) throw Error('兼容重接后严格检查未就绪')
    return { ...result, authorRebased: true, authorVersion: plan.authorVersion }
  } catch (error) {
    if (writeStarted) { restore(appDir, original); writeFileSync(recordFile, oldRecord) }
    throw new Error(writeStarted ? '兼容重接失败，已恢复本次现场' : '兼容预演失败，目标未写入', { cause: error })
  } finally {
    if (path.dirname(stage) !== path.resolve(os.tmpdir()) || !path.basename(stage).startsWith('dsh-author-rebase-')) throw Error('临时源码副本路径不符，拒绝清理')
    rmSync(stage, { recursive: true, force: true })
  }
}
export function applyStandardSeams({ appDir, authorVersion, allowRebase = true } = {}) {
  const author = requireAuthor(appDir, authorVersion, { allowRebase })
  const state = checkStandardSeams({ appDir, authorVersion, allowRebase })
  if (state.ready) return { changed: false, ...state }
  if (state.needsReapply) return applyCompatibleRebase(appDir, state.compatible)
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
    // applyAllSeams重写同一入口后必须在最终代重新接DB存档；否则桥文件存在但原按钮仍走作者JSON包。
    const finalSaveHost = core.get('tavern-plugin/lib/index.js')
    if (finalSaveHost.includes('  async function exportGameSave(') || finalSaveHost.includes('// [dsh-tavern-db-save:v1]')) core.set('tavern-plugin/lib/index.js', applyDbSaveHostTransform(finalSaveHost))
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
    // 既有路径保持原样（盲 merge 未改，避免 partial regression）；新首装无旧记录，不涉及此合并。
    writeFileSync(recordPath, JSON.stringify({ version: 1, authorVersion: author.version, before: old?.before ? { ...before, ...old.before } : before, after }, null, 2) + '\n', 'utf8')
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

/**
 * 只读计划（供维护 adapter/check 报告；**不写盘、不改树**）：
 * 返回就绪状态、待施缝文件、记录身份与（仅 allowRebase 时）兼容判定；uninstall 不调用本函数。
 */
export function inspectStandardSeamsPlan({ appDir, authorVersion, allowRebase = true } = {}) {
  const author = requireAuthor(appDir, authorVersion, { allowRebase })
  const file = inside(appDir, RECORD)
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  const identity = record ? { version: record.version, authorVersion: record.authorVersion } : null
  // 无记录的新版本首装：requireAuthor 的能力判定结果必须透传（否则 driver 会把 fresh 新版本误拒）。
  const capability = author.compatible || null
  try {
    const state = checkStandardSeams({ appDir, authorVersion, allowRebase })
    return { ready: state.ready, needsReapply: state.needsReapply === true, reason: state.ready ? 'ready' : (state.reason || 'needs-reapply'), pending: state.pending || [], drifted: state.drifted || [], compatible: state.compatible || capability, authorVersion: author.version, record: identity }
  } catch (error) {
    return { ready: false, reason: error.message, pending: [], drifted: [], compatible: null, authorVersion: author.version, record: identity }
  }
}
