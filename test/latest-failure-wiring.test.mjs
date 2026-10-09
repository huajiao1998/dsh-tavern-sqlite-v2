// 最新失败接线（主新增 transform）的具名独立覆盖：文件内共 5 条，逐条按主核定的精确 pattern 定向执行，不跑宽 pattern。
//   ① 标准完整施缝：真实作者 source fixture（helper 有限复制 maintenanceTargets + 作者包）⇒ applyStandardSeams ⇒ ready，
//      且产物**ACTIVE 投影**同时含 host DI（appendMessages/setMessageFloor 两键）与 failureTarget/failureCleanupReason 接线
//      （RPC 参数、视图字段、窄摘要分支）。
//   ② transform 自身：RPC/视图两转换作用在**完整 pending 状态 source** 上幂等，缺块/半应用/标记异常一律拒。
//   ③ 窗口 pin（2026-10-10 修，本次唯一执行条目）：窗口副本 `_storageRevision` 为 undefined（作者形状）时必须以同快照 `windowRevision` 作 pin。
//      真链：真 store（合成 57 条正文：56 条交替 user/assistant + 尾 assistant turn41；挂 failed body42 带真实基准 messageCount57）
//      → `store.readOpeningWindow(limit48,requirePartial)` 原函数算摘要（from=9，非早退 null 分支）
//      → `createSessionWindowProjector.project`（真 store 窗口字段 + fixture 依赖 + 真变换产物抽出的 `latestFailureTarget/latestFailureCleanupReason` 作 rollbackViewFields）
//      → 断言确切 target（revision 取摘要动态值）／无通用缺基准文案／过期摘要拒（无 replayTarget 不产原因）／全档 `store.read()` 走真基准 fallback。
//      身份全合成（branch-window-pin 等），不复制现场值。
//   ④ 窄摘要分支：变换产物内真函数 latestFailureTarget/latestFailureCleanupReason 对 chat.failureCleanup 的采信与原因优先级。
//   ⑤ queryFailureCleanup：真 node:sqlite 临时库五场景（基准在位／缺基准／检查点／正文行／任务推进）。
// 只读作者夹具、仅写自建 SQLite 并清自建 mkdtemp；不联网、不读真实档、不修改作者原树。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { SqliteSessionDb } from '../store.js'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { createSessionWindowProjector } from '../lib/session-window-projector.js'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { applyRollbackPendingViewTransform } from '../deploy/rollback-pending-view-transform.mjs'
import { applyLatestFailureHostTransform, applyLatestFailureViewTransform } from '../deploy/latest-failure-transform.mjs'
import { queryFailureCleanup } from '../lib/chat-query-service.js'
import { readFailureEvidence } from '../lib/failure-view-evidence.js'
import { applyNativeMessageHostTransform } from '../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { activeSource, commentAuthorTreeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const INDEX_REL = 'tavern-plugin/lib/index.js'
const VIEW_REL = 'tavern-plugin/lib/domain/chat-session-state.js'
const DI_KEYS = ['appendMessages: appendMessagesNarrow,', 'setMessageFloor: setMessageFloorNarrow,']
const FAILURE_RPC = 'args.failureTarget || args.expectedTurn'
const FAILURE_FIELDS = [
  'failureTarget: latestFailureTarget(chat, replayTarget, evidence),',
  'failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),',
  'canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,',
  'failureTarget: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence),',
]
/** 窄摘要分支必须逐项在位（缺失＝退回"窄视图永远无目标"，就是本次修复要消掉的行为）。 */
const NARROW_NEEDLES = [
  'const narrow = chat.failureCleanup',
  'narrow.cleanable === true',
  'const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision',
  'Number.isSafeInteger(revision) && Number.isSafeInteger(Number(narrow.revision)) && Number(narrow.revision) === Number(revision)',
  'narrowTurn !== null && narrowTurn >= 1 && narrow.operationId',
  'if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason',
  'const native = inspectNativeFailureTail(chat, evidence, revision)',
]
const trees = []
/** 真实作者 source fixture → 自有 mkdtemp（helper 只复制维护 targets + 作者包；缺失即响亮失败，不 skip）。 */
const buildTree = () => {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  trees.push(tree)
  return tree
}
const read = (tree, rel) => readFileSync(path.join(tree.appDir, rel), 'utf8')
/** 宿主真身解析（冷开集成用例用）：把真 Session 源码里的 @deepseek-ai/* 指到本机已装宿主。
 *  用**命名空间** import 包（不顶层 import 具体导出），避免本机打包形态差异导致整模块加载失败。 */
const requireHost = createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app', 'package.json'))
const loadHostSessionSource = () => readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
  .replace(/from "(@deepseek-ai\/[^\"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
const loadHostSession = async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tavern-cold-session-'))
  const file = path.join(dir, 'session.mjs')
  writeFileSync(file, loadHostSessionSource(), 'utf8')
  const mod = await import(pathToFileURL(file).href)
  trees.push({ appDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) })
  return mod
}
const loadHostModule = async name => await import(pathToFileURL(requireHost.resolve(name)).href)
test.after(() => { for (const tree of trees) tree.cleanup() })   // 只清 helper 自建目录

test('最新失败接线：标准完整施缝真作者树含DI与failureTarget并ready', async () => {
  const tree = buildTree(), app = tree.appDir
  const applied = applyStandardSeams({ appDir: app, authorVersion: AUTHOR_VERSION, assertStopped: () => true })
  assert.equal(applied.changed, true, '首装必须产生变更')
  assert.equal(applied.ready, true, '首装必须 ready')
  assert.equal(checkStandardSeams({ appDir: app }).ready, true, '严格 check 必须 ready')
  const record = JSON.parse(readFileSync(path.join(app, COMMENT_SEAMS_RECORD), 'utf8'))
  assert.equal(record.format, 1)
  assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
  assert.ok(Object.hasOwn(record.files, INDEX_REL), 'index 必须记成注释块文件')
  assert.ok(record.files[INDEX_REL].blocks.length > 0, 'index 必须有接缝块')
  // 注释块协议：作者旧代码按 '// ' 保留在 ORIGINAL 区 ⇒ 业务接线一律只看 ACTIVE 投影。
  const index = activeSource(read(tree, INDEX_REL), INDEX_REL)
  for (const key of DI_KEYS) assert.equal(index.includes(key), true, '宿主 DI 必须接线到真实 index：' + key)
  assert.equal(index.includes('async function appendMessagesNarrow('), true, 'DI 闭包必须在位（appendMessages）')
  assert.equal(index.includes('async function setMessageFloorNarrow('), true, 'DI 闭包必须在位（setMessageFloor）')
  assert.equal(index.includes(FAILURE_RPC), true, 'RPC 必须带 failureTarget 参数接线')
  const view = activeSource(read(tree, VIEW_REL), VIEW_REL)
  assert.equal(view.includes('function latestFailureTarget(chat, replayTarget, evidence) {'), true, '视图必须带 latestFailureTarget 助手（含 evidence）')
  assert.equal(view.includes('function latestFailureCleanupReason(chat, replayTarget, evidence) {'), true, '视图必须带 latestFailureCleanupReason 助手（含 evidence）')
  for (const needle of NARROW_NEEDLES) assert.equal(view.includes(needle), true, '窄摘要分支缺失：' + needle)
  for (const field of FAILURE_FIELDS) assert.equal(view.includes(field), true, '视图字段接线缺失：' + field)
  assert.equal(view.includes("'当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理'"), true, '缺基准原因必须如实接线（不猜删）')
  // owned 垫片：applyStandardSeams 必须**真渲染**出 native-only/RPC 依赖的导出（不只 ready）
  const shimDomain = read(tree, 'tavern-plugin/lib/domain/storage-rollback.js')
  assert.equal(shimDomain.includes("import { storagePackage } from './storage-package.js'"), true, 'domain 垫片必须走 storagePackage 转出')
  assert.equal(shimDomain.includes("export const { cleanRollback, inspectNativeFailureTail, readFailureEvidence } = await storagePackage('clean-rollback')"), true, 'domain 垫片必须导出 cleanRollback/inspectNativeFailureTail/readFailureEvidence')
  assert.equal(shimDomain.includes('export const { cleanupAfterRollback, cleanupRollbackHeadIndex, preflightRollback, preflightRollbackAtSeq, cleanupAfterRollbackAtSeq } = impl'), true, 'domain 垫片原回退导出不得丢')
  // 视图就在 lib/domain，`./storage-rollback.js` 相对解析即该 domain 垫片；必须真 import（不是只写在常量里）
  assert.equal(VIEW_REL.includes('lib/domain/'), true, '被接线的视图必须位于 domain（相对 import 才指到该垫片）')
  assert.equal(view.includes("import { inspectNativeFailureTail } from './storage-rollback.js'"), true, '视图必须真的 import 该导出')
  // 该 evidence import 属于 index.js（沿用 :93 的 index）；视图侧只需下一句的 inspectNativeFailureTail
  assert.equal(index.includes("import { readFailureEvidence as readFailureEvidenceFromQuery } from './domain/storage-rollback.js'"), true, 'index 证据读口必须由 domain 垫片转出')
  // owned 导出必须是**真 runtime 函数类型**（presence 不等 type），与 core 实际实现对照
  const coreClean = await import(new URL('../lib/clean-rollback.js', import.meta.url).href)
  const coreTarget = await import(new URL('../lib/failure-cleanup-target.js', import.meta.url).href)
  const coreEvidence = await import(new URL('../lib/failure-view-evidence.js', import.meta.url).href)
  assert.equal(typeof coreClean.cleanRollback, 'function', 'core cleanRollback 必须是函数')
  assert.equal(typeof coreTarget.inspectNativeFailureTail, 'function', 'core inspectNativeFailureTail 必须是函数')
  assert.equal(typeof coreEvidence.readFailureEvidence, 'function', 'core readFailureEvidence 必须是函数')
  assert.equal(coreEvidence.readFailureEvidence.constructor.name, 'AsyncFunction', 'core readFailureEvidence 必须是 async（冷读含 await lease 与 finally 释放）')
  assert.equal(coreEvidence.readFailureEvidence.length, 3, 'core readFailureEvidence 必须三参（liveEvidence, query, sessionId）')
  // owned 垫片经 storagePackage('clean-rollback') 转出的必须是**同一实现**（core export 路径严格覆盖）
  assert.equal(coreClean.readFailureEvidence, coreEvidence.readFailureEvidence, 'core clean-rollback 转出的 readFailureEvidence 必须与 failure-view-evidence 同一函数')
  assert.equal(coreClean.inspectNativeFailureTail, coreTarget.inspectNativeFailureTail, 'core clean-rollback 转出的 inspectNativeFailureTail 必须与 failure-cleanup-target 同一函数')
  // index 侧：DI 同时转出证据读口，且证据取用处包成 async（冷档 await 观察口）
  assert.equal(index.includes('get readFailureEvidence() { return readFailureEvidence }'), true, 'index nativeData DI 必须转出 readFailureEvidence getter')
  assert.equal(index.includes('const rollbackEvidence = await readFailureEvidence'), true, '证据取用处必须 async 包装')
  // 幂等：同树复跑不变更
  assert.equal(applyStandardSeams({ appDir: app, assertStopped: () => true }).changed, false, '复跑必须幂等')
  // 宿主 DI 与失败接线的转换都必须可判定为"已应用"（复跑不重复插入）
  assert.equal(applyNativeMessageHostTransform(index), index, '宿主 DI 转换对已施缝 index 必须幂等')
  assert.equal(applyLatestFailureHostTransform(index), index, '失败宿主转换对已施缝 index 必须幂等')
  assert.equal(applyLatestFailureViewTransform(view), view, '失败视图转换对已施缝视图必须幂等')
})

test('最新失败接线：RPC与投影幂等及缺块拒绝', async () => {
  const tree = buildTree()
  const indexRaw = read(tree, INDEX_REL)
  // RPC：真完整 index source（含 pending 状态字段所在的整文件）
  const hostOnce = applyLatestFailureHostTransform(indexRaw)
  assert.equal(hostOnce.includes(FAILURE_RPC), true, 'RPC 必须改为 failureTarget 优先')
  assert.equal(hostOnce.includes('// [dsh-tavern-latest-failure-host:v1]'), true, '宿主标记必须在位')
  assert.equal(applyLatestFailureHostTransform(hostOnce), hostOnce, '宿主复跑必须幂等')
  assert.throws(() => applyLatestFailureHostTransform(hostOnce.replace(FAILURE_RPC, 'args.expectedTurn')), /不完整/, '缺 RPC 改动必须拒')
  assert.throws(() => applyLatestFailureHostTransform(hostOnce + '\n// [dsh-tavern-latest-failure-host:v1]\n'), /不完整/, '标记重复必须拒')
  assert.throws(() => applyLatestFailureHostTransform(indexRaw.replace("case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn) }", '')), /锚点缺失\/不唯一/, '锚点缺失必须拒')
  // 视图：真完整 chat-session-state source；失败视图接缝接在**既有 pending 视图转换产物**之后（真实标准组合顺序）
  const viewRaw = applyRollbackPendingViewTransform(read(tree, VIEW_REL))
  const viewOnce = applyLatestFailureViewTransform(viewRaw)
  for (const field of FAILURE_FIELDS) assert.equal(viewOnce.includes(field), true, '视图字段必须接线：' + field)
  assert.equal(viewOnce.includes('// [dsh-tavern-latest-failure-view:v1]'), true, '视图标记必须在位')
  assert.equal(applyLatestFailureViewTransform(viewOnce), viewOnce, '视图复跑必须幂等')
  // 缺块拒：先把真三参行替换成坏行（必须先断言 source 真的变了，防"替换没命中"的假缺块）
  const brokenClear = viewOnce.replace('canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,', 'canClearIncompleteReply: false,')
  assert.notEqual(brokenClear, viewOnce, '缺块用的 mutation 必须真正改变 source（三参 literal）')
  assert.throws(() => applyLatestFailureViewTransform(brokenClear), /不完整/, '缺视图改动必须拒')
  assert.throws(() => applyLatestFailureViewTransform(viewOnce + '\n// [dsh-tavern-latest-failure-view:v1]\n'), /不完整/, '视图标记重复必须拒')
  assert.throws(() => applyLatestFailureViewTransform(viewRaw.replace('      canReplayFailedTurn: replayTarget !== null,', '')), /锚点缺失\/不唯一/, '视图锚点缺失必须拒')
})

/** 真投影依赖（native-opening-view.test.mjs 的 buildDeps 同形）：无关 side-effect 一律 stub，核心 store/projector/rollback 接真。 */
function projectorDeps() {
  const noop = () => undefined
  const idleActivity = { busy: false, phase: 'idle', role: '', operationId: '', basedOn: null, updatedAt: 0 }
  return {
    str: value => (value === undefined || value === null ? '' : String(value)),
    readTavernSettings: async () => ({ trustedCardMode: false, frameSizing: 'fill' }),
    readScript: async () => undefined,
    scriptContinuity: { inspect: () => null },
    groupOfMode: () => 'story',
    replyProjectionsOf: () => [],
    incrementalReplyView: { project: async () => ({ projections: [], statusViews: [] }) },
    composeTavernRegexScripts: () => [],
    liveCardUpdate: { project: async (_c, _card, display) => display },
    withLegacyPresentationProjection: (_chat, projections) => projections,
    readCardExtensions: async () => ({ regexScripts: [], helperScripts: [], variables: {}, globalRegexScripts: [], characterRegexScripts: [], frameSizing: 'fill' }),
    tavernRemoteAssets: { pinExtensions: async extensions => ({ helperScripts: extensions.helperScripts || [], regexScripts: extensions.regexScripts || [], diagnostics: [], pins: [] }) },
    activityOf: () => idleActivity,
    liveSessionFor: noop,
    assistantResultForTurn: () => null,
    forkTurnsForChat: () => ({}),
    inputFieldsProjection: { project: () => ({ inputSources: [], inputTemplateDisplays: [] }) },
    cardUpdateStatus: async () => ({ available: false }),
    hasTavernScriptRuntime: () => false,
    projectTavernHelperScripts: () => ({ scripts: [], diagnostics: [] }),
    worldBooks: { bound: async () => null },
    projectTavernHelperWorldbook: view => view,
    worldBookDisplayName: document => document.name,
    sessionResources: { issue: (chatId, revision, kind) => ({ kind, chatId, revision }) },
    projectTavernHelperContext: async () => ({ messages: [], turnMessageIds: {} }),
    sessionDebugEvidence: () => undefined,
    rollbackViewFields: () => ({}),
    cardViewOf: (card, chat) => ({ path: card.path || chat.cardPath, name: card.name || chat.cardName, tags: card.tags || [] }),
    readChatCard: async () => ({ path: 'cards/window-pin.json', name: '窗口pin卡', tags: [] }),
    readLedger: ledger => ledger ?? null,
    manualLedger: { project: () => null },
    projectCharacterDesignDocument: document => document ?? null,
    manualCharacterDesign: { project: () => null },
    phoneChat: { project: () => null },
    mvuReceiptsOf: (_chat, changes) => ({ receipts: [], changes: changes ?? null }),
    OFFICIAL_MVU_VERSION: { commit: 'fixture-commit', assetUrl: 'fixture://mvu' },
    sessionOpeningDescriptor: () => ({ kind: 'story' }),
    readPromptTemplateGlobalVariables: async () => ({}),
    tavernExtensionSettings: { read: async () => ({}) },
    TAVERN_COMPATIBILITY_CAPABILITIES: { fixture: true },
    TAVERN_RELEASE_CAPABILITIES: { fixture: true },
    helperHistoryAccess: { issue: input => ({ access: `history:${input.chatId}`, ...input }) },
    candidateWorldbookPreparation: { warm: noop },
    scheduleTemplateSync: noop,
    rescueHistoryNotice: () => '',
    settlementTurn: () => 0,
    helperMessageColdWindow: 48,
    activityBridge: { set: noop, get: () => undefined },
    backgroundTasks: { activity: () => idleActivity },
    sessionStore: { get: () => undefined },
    agentRegistry: { get: () => undefined },
    requestPerformance: { stage: async (_name, run) => run() },
  }
}

test('最新失败接线：窗口副本缺 _storageRevision 时以 windowRevision 作 pin（真 store→真投影→真 target 函数）', async (t) => {
  const tree = buildTree()
  const root = mkdtempSync(path.join(os.tmpdir(), 'window-pin-store-'))
  // 先释放 store 再删目录，避免 Windows 句柄占用（既有真 store 夹具同法）
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  // 真 store 依赖：作者 copy-json-tree / json-mutation（从 commentAuthorTreeSource 原路径直接 import，避免 fixture 只含 maintenanceTargets）
  const authorSrc = commentAuthorTreeSource()
  assert.ok(authorSrc, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  const authorDomain = path.join(authorSrc, 'tavern-plugin/lib/domain')
  const { copyJsonTree } = await import(pathToFileURL(path.join(authorDomain, 'copy-json-tree.js')).href)
  const { diffJson, applyJsonChangesShared } = await import(pathToFileURL(path.join(authorDomain, 'json-mutation.js')).href)
  const passthrough = value => (value === undefined ? undefined : structuredClone(value))
  const helpers = { copyJsonTree, diffJson, applyJsonChangesShared }
  for (const name of ['projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint', 'projectSceneImageState']) helpers[name] = passthrough
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers })
  // 真变换产物 → 真 target 函数（不重造整作者模块、不用 seam.rollback）
  const viewSeamed = applyLatestFailureViewTransform(applyRollbackPendingViewTransform(read(tree, VIEW_REL)))
  for (const field of FAILURE_FIELDS) assert.equal(viewSeamed.includes(field), true, '注入面必须含字段：' + field)
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewSeamed, { inspectNativeFailureTail: await loadInspectNativeFailureTail() })
  // 合成身份（不得复制现场 identities）
  const chatId = 'chat-window-pin'
  const sessionId = 'session-window-pin'
  const branchId = 'branch-window-pin'
  const operationId = 'operation-window-pin-42'
  // 56 条交替 user/assistant（assistant turn1..28，user 不带 turn）+ 尾 assistant turn41 ⇒ 共 57 条
  const messages = Array.from({ length: 56 }, (_, index) => index % 2 === 0
    ? { role: 'user', text: '输入' + (index / 2 + 1) }
    : { role: 'assistant', text: '正文' + (Math.floor(index / 2) + 1), turn: Math.floor(index / 2) + 1, swipeId: 0, swipes: ['正文' + (Math.floor(index / 2) + 1)] })
  messages.push({ role: 'assistant', text: '尾轮正文', turn: 41, swipeId: 0, swipes: ['尾轮正文'] })
  assert.equal(messages.length, 57, '合成正文必须 57 条')
  assert.equal(messages.at(-1).turn, 41, '尾必须是 assistant turn41')
  assert.equal(messages.filter(row => row.role === 'assistant').every(row => row.turn <= 41), true, '所有 assistant turn 必须 <=41')
  assert.equal(messages.filter(row => row.role === 'user').every(row => row.turn === undefined), true, 'user 不得带 turn')
  // ① 一次写入 57 条正文 + failed body42（真实基准形状）。带 `_storageRevision: 1`（既有真 store 夹具同法）：
  //    首写据此落 revision 1；否则 head 落在 0，queryActivitySummary 解析不出合法正整数 ⇒ 窗口快照拿不到 revision。
  await store.update(chatId, () => ({
    id: chatId, sessionId, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    _storageRevision: 1, updatedAt: 1, cardPath: 'cards/window-pin.json', settleStatus: 'done',
    macroState: { userName: '玩家' }, variables: { hp: 41 },
    timeline: {
      schemaVersion: 1, branchId, revision: 9, participants: {}, checkpoints: [],
      operations: {
        [operationId]: {
          id: operationId, kind: 'body', turn: 42, status: 'failed',
          basedOn: { branchId, revision: 9 },
          beforeParticipants: {},
          businessBefore: { version: 1, fields: { variables: { hp: 41 } }, messageCount: 57, participants: {}, operationIds: [], operationStates: {} },
        },
      },
    },
    messages,
  }))
  const window = await store.readOpeningWindow(chatId, { limit: 48, requirePartial: true, sessionId })
  assert.ok(window && window.nativeData === true, '真 store 必须给出原生 opening 窗口：' + String(window && window.kind))
  assert.equal(window.messageCount, 57, '窗口必须报告 57 条正文')
  assert.equal(window.from, 9, 'limit48 + 57 条 ⇒ from=9（非早退 null 分支）')
  const summary = window.failureCleanup
  assert.equal(summary.cleanable, true, '同快照摘要必须 cleanable：' + String(summary && summary.reason))
  assert.equal(summary.turn, 42)
  assert.equal(summary.operationId, operationId)
  assert.equal(summary.revision, window.revision)
  assert.equal(summary.branchId, branchId)
  assert.equal(window.chat.messages.at(-1).turn, 41, '窗口尾必须是 assistant turn41')
  // 真投影：真 store 窗口字段 + fixture 依赖；rollbackViewFields 只回真 target 函数结果
  const projector = createSessionWindowProjector({ ...projectorDeps(), rollbackViewFields: chat => ({
    failureTarget: latestFailureTarget(chat, null),
    canClearIncompleteReply: latestFailureTarget(chat, null) !== null,
    failureCleanupReason: latestFailureCleanupReason(chat, null),
  }) })
  const project = async source => {
    const result = await projector.project({ chat: source.chat, window: source, activity: source.activity })
    assert.equal(result.kind, 'value', '真投影必须返回 value：' + String(result && result.kind))
    return result.view
  }
  // ① 窗口副本（真投影写法：_storageRevision undefined + windowRevision）⇒ 必须给出确切 target（revision 动态取摘要）
  const windowView = await project(window)
  assert.deepEqual(windowView.failureTarget, {
    chatId, sessionId, turn: 42, branchId, revision: summary.revision, operationId,
  }, '窗口副本必须经 windowRevision pin 得到确切 target（修复前为 null）')
  assert.equal(windowView.failureCleanupReason, '', '可清理时不得出现通用缺基准文案')
  assert.equal(windowView.canClearIncompleteReply, true, '可清理态必须让 UI 认到可清')
  // ② 摘要 revision 与窗口不符 ⇒ 必须拒（无 replayTarget ⇒ 不产原因，只断言 target 为 null）
  const stale = { ...window, failureCleanup: { ...summary, revision: Number(summary.revision) - 1 } }
  const staleView = await project(stale)
  assert.equal(staleView.failureTarget, null, '过期摘要必须拒')
  assert.equal(staleView.failureCleanupReason, '', '无 replayTarget 时不产通用原因（原语义保持）')
  // ③ 全档路径：真 store read() 带 _storageRevision 且无摘要 ⇒ 走真 baseline fallback（拿同一轮的真实基准）
  const fullChat = await store.read(chatId)
  assert.equal(Number.isSafeInteger(fullChat._storageRevision), true, '全档必须带存储版本')
  assert.equal(Object.hasOwn(fullChat, 'failureCleanup'), false, '全档本就不带窄摘要')
  assert.deepEqual(latestFailureTarget(fullChat, { turn: 42 }), {
    chatId, sessionId, turn: 42, branchId, revision: fullChat._storageRevision, operationId,
  }, '全档必须经 replayTarget 走真实基准 fallback 给同一轮目标')
  assert.equal(latestFailureTarget({ ...fullChat, timeline: { ...fullChat.timeline, operations: {} } }, { turn: 42 }), null, '缺该轮操作 ⇒ 拒绝')
})

/** 从变换产物里按花括号配对取出真实函数文本（与 save-ui-seam/extractFunction 同法，不用正则猜边界）。 */
function extractFunction(text, header) {
  const start = text.indexOf(header)
  assert.ok(start >= 0, '应能定位 ' + header)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('函数花括号不平衡：' + header)
}
/** 取出两个助手真身并在本进程求值：断言的是**变换产物里的那份代码**，不是复述的替身。
 *  默认注入真实 inspectNativeFailureTail（前端输出已把它当 formal parameter 调用）：
 *  所有调用点（含窄摘要用例）都必须能拿到真身，否则 new Function 求值即 ReferenceError。
 *  本文件不顶层 import 该名（缺导出会让整模块加载失败），由各用例 await import 后传入。 */
function failureHelpers(source, deps = null) {
  if (deps === null || typeof deps.inspectNativeFailureTail !== 'function') {
    throw new Error('failureHelpers 必须注入真实 inspectNativeFailureTail（native-only 协议依赖）')
  }
  const names = Object.keys(deps)
  const text = extractFunction(source, 'function latestFailureTarget(chat, replayTarget, evidence) {')
    + '\n' + extractFunction(source, 'function latestFailureCleanupReason(chat, replayTarget, evidence) {')
    + '\nreturn { latestFailureTarget, latestFailureCleanupReason }'
  return new Function(...names, text)(...names.map(name => deps[name]))
}
/** 各用例共用的真身取用口（缺导出即响亮失败）。 */
async function loadInspectNativeFailureTail() {
  const module = await import('../lib/clean-rollback.js')
  assert.equal(typeof module.inspectNativeFailureTail, 'function', '后端 clean-rollback.js 必须导出 inspectNativeFailureTail')
  return module.inspectNativeFailureTail
}

test('最新失败接线：窄摘要分支与原因优先级（变换产物内真函数）', async () => {
  const tree = buildTree()
  const viewOnce = applyLatestFailureViewTransform(applyRollbackPendingViewTransform(read(tree, VIEW_REL)))
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewOnce, { inspectNativeFailureTail: await loadInspectNativeFailureTail() })
  const narrow = { cleanable: true, revision: 9, turn: 7, operationId: 'op7', branchId: 'b1' }
  const chat = { id: 'c1', sessionId: 's1', _storageRevision: 9, failureCleanup: narrow }
  assert.deepEqual(latestFailureTarget(chat, null),
    { chatId: 'c1', sessionId: 's1', turn: 7, branchId: 'b1', revision: 9, operationId: 'op7' },
    '窄摘要 cleanable 且 revision 相符 ⇒ 直接给目标（窄视图不再永远 null）')
  assert.equal(latestFailureTarget({ ...chat, _storageRevision: 10 }, null), null, '窄摘要 revision 与现场不符 ⇒ 不采信')
  assert.equal(latestFailureTarget({ ...chat, failureCleanup: { ...narrow, turn: 0 } }, null), null, '窄摘要 turn 非安全整数 ⇒ 不采信')
  assert.equal(latestFailureTarget({ ...chat, failureCleanup: { ...narrow, operationId: '' } }, null), null, '窄摘要缺 operationId ⇒ 不采信')
  // pending 形态仍优先于窄摘要（半提交只许完成同一清理）。
  assert.equal(latestFailureTarget({ ...chat, rollbackPending: { id: 'rb1', failureTarget: { turn: 6, operationId: 'op6', branchId: 'b0' } } }, null).turn, 6,
    'rollbackPending.failureTarget 优先')
  assert.equal(latestFailureCleanupReason(chat, null), '', '窄摘要 cleanable ⇒ 无原因')
  assert.equal(latestFailureCleanupReason({ ...chat, failureCleanup: { cleanable: false, reason: '该失败轮缺少发轮前回退基准，不能安全清理' } }, null),
    '该失败轮缺少发轮前回退基准，不能安全清理', '窄摘要 reason 优先于通用原因')
  assert.equal(latestFailureCleanupReason({ id: 'c1', sessionId: 's1', _storageRevision: 9 }, { turn: 7 }),
    '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理', '无窄摘要且 replayTarget 不可清 ⇒ 原因回落')
})

test('最新失败接线：native-only 尾（guard 失败轮无 op）经注入 inspectNativeFailureTail 成为 ft（合成身份）', async () => {
  const tree = buildTree()
  const viewOnce = applyLatestFailureViewTransform(applyRollbackPendingViewTransform(read(tree, VIEW_REL)))
  // 真 helper 真身（缺导出会整模块加载失败，故按需 import；签名 chat, evidence, revision）
  const inspectNativeFailureTail = await loadInspectNativeFailureTail()
  // 合成身份（不得复制现场 title/branch/operation 值）
  const chatId = 'chat-native-seam'
  const sessionId = 'session-native-seam'
  const branchId = 'branch-native-seam'
  // 真 source events：seq === index 从 0；turn1..41 completed + turn42 aborted + turn43 guard（43 无 user/message，只有 agent/inbox 元事件）
  const GUARD = '失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准'
  const events = []
  let seq = 0
  for (let turn = 1; turn <= 41; turn += 1) {
    events.push({ seq: seq++, type: 'turn/start', data: { turn } })
    events.push({ seq: seq++, type: 'user/message', data: { id: 'u' + turn, role: 'user', content: [{ type: 'text', text: '输入' + turn }] } })
    events.push({ seq: seq++, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  events.push({ seq: seq++, type: 'turn/start', data: { turn: 42 } })
  events.push({ seq: seq++, type: 'user/message', data: { id: 'u42', role: 'user', content: [{ type: 'text', text: '输入42' }] } })
  events.push({ seq: seq++, type: 'user/message', data: { id: 'u42b', role: 'user', content: [{ type: 'text', text: '输入42（重发）' }] } })
  events.push({ seq: seq++, type: 'turn/end', data: { turn: 42, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const before43 = events.length                                    // 43 段起点（真坐标下标，不用常数减法）
  events.push({ seq: seq++, type: 'agent/inbox/spliced', data: { inserted: [] } })   // 43 段之前的 spliced（无 turn）
  events.push({ seq: seq++, type: 'turn/start', data: { turn: 43 } })
  events.push({ seq: seq++, type: 'agent/inbox/spliced', data: { inserted: [] } })   // 43 段之内的 spliced（无 turn）
  events.push({ seq: seq++, type: 'turn/end', data: { turn: 43, reason: { kind: 'error', error: { message: GUARD } } } })
  const revision = 12
  const chat = {
    id: chatId, sessionId, _storageRevision: revision, windowRevision: revision,
    timeline: { schemaVersion: 1, branchId, revision, operations: { op42: { kind: 'body', turn: 42, status: 'failed', businessBefore: { version: 1, messageCount: 57 } } }, checkpoints: [] },
    messages: [{ role: 'assistant', turn: 41, text: '正文41', swipeId: 0, swipes: ['正文41'] }],
    hiddenDshErrorTurns: [], suppressedDshTurns: [], regeneratedDshTurns: {},
  }
  // ① 真 helper：无 events ⇒ null；小连续 events 的末轮 43 必须是 native 目标，坐标按真 events 算（不写死 507/508）
  assert.equal(inspectNativeFailureTail(chat, { events: [] }, revision), null, '无 events ⇒ null（不得凭 turn 猜）')
  assert.equal(inspectNativeFailureTail(chat, {}, revision), null, '缺 events ⇒ null')
  const native = inspectNativeFailureTail(chat, { events }, revision)
  assert.equal(native.cleanable, true, '43 必须可 native 清理：' + String(native && native.reason))
  assert.equal(native.turn, 43)
  assert.equal(native.endSeq, events.at(-1).seq, 'endSeq 必须是 terminal 事件 seq，实际 ' + String(events.at(-1).seq))
  assert.equal(native.eventCount, events.length, 'eventCount 必须是 events.length')
  assert.equal(native.target.kind, 'native-only')
  assert.equal(native.target.turn, 43)
  assert.equal(native.target.endSeq, native.endSeq)
  assert.equal(native.target.eventCount, native.eventCount)
  assert.equal(native.target.branchId, branchId)
  assert.equal(native.target.revision, revision)
  assert.equal(Object.hasOwn(native.target, 'operationId'), false, 'native-only 不得伪造 operationId')
  // ② 真 helper 注入变换产物（formal parameter）⇒ native 目标必须成为 ft，且不得落到通用缺基准文案
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewOnce, { inspectNativeFailureTail })
  assert.deepEqual(latestFailureTarget(chat, null, { events }), {
    kind: 'native-only', chatId, sessionId, turn: 43, branchId, revision,
    endSeq: events.at(-1).seq, eventCount: events.length,
  }, 'native 末轮必须给带真坐标的目标（无 operationId）')
  assert.equal(latestFailureCleanupReason(chat, null, { events }), '', '可清时不得出现通用缺基准文案')
  // ③ 冷开（无 narrow 摘要）+ 尾轮 42 有 body 基准 ⇒ 真冷 API 支持給 42（不是 null，也不挑更旧 op）
  const events42 = events.slice(0, before43)
  const coldChat = { ...chat, revision: 13, windowRevision: 13 }
  assert.deepEqual(latestFailureTarget(coldChat, null, { events: events42 }), {
    chatId, sessionId, turn: 42, branchId, revision: 13, operationId: 'op42',
  }, '冷开备选：events 有 body42 基准且无 narrow ⇒ 必须给 42 完整目标（核心同尾轮，不挑更旧 op）')
  assert.equal(inspectNativeFailureTail(coldChat, { events: events42 }, 13).turn, 42, '真 helper 必须报真实尾轮 42')
  // ④ 43 已清但 narrow 仍指向 43 的过期摘要（native 真尾是 42）⇒ 必须拒：
  //    前端已加 narrow.turn !== native.turn 的拒；本断言即该守卫的验收。
  const staleNarrow = Object.freeze({ cleanable: true, revision: 13, turn: 43, operationId: 'op-window-pin-stale', branchId })
  const cleaned = { ...chat, revision: 13, windowRevision: 13, failureCleanup: staleNarrow, timeline: { ...chat.timeline, revision: 13 } }
  assert.equal(latestFailureTarget(cleaned, null, { events: events42 }), null, '过期 narrow(43) 不得冒充当前目标')
  // ⑤ 43 清完后再清 42：narrow 指向 42 时必须正常给出 body 42 目标（动态，不凭函数固定重做）
  const narrow42 = Object.freeze({ cleanable: true, revision: 13, turn: 42, operationId: 'op42', branchId })
  assert.deepEqual(latestFailureTarget({ ...cleaned, failureCleanup: narrow42 }, null, { events: events42 }), {
    chatId, sessionId, turn: 42, branchId, revision: 13, operationId: 'op42',
  }, '先清 43 之后必须能正常拿到 42 的 body 目标')
})

test('最新失败接线：冷开只读原生事件签发43且清后暴露42', async (t) => {
  // 本条**整合原 native-only 用例的全部协议断言**（真 helper 无 events/缺 events/坐标/无 operationId/身份），
  // 故独立的 native-only 用例不再单独执行；不新增文件、不扩用例数。
  const tree = buildTree()
  const { Session } = await loadHostSession()
  // 冷 helper 不构造 Session：不需要 projections/Context/z 管理器
  // 真 Session → 真 SqliteSessionDb（events 从 seq 0，materialize 一次全量）
  const session = Session.create('session-cold-native')
  const userRow = (n, text) => session.append('user/message', { id: 'u' + n, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  const assistantRow = (n, text) => session.append('assistant/message', { turn: n, step: 1, message: { id: 'a' + n, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, stream: [] }, { surfaceOp: 'append' })
  for (let turn = 1; turn <= 41; turn += 1) { session.append('turn/start', { turn }); userRow(turn, '输入' + turn); assistantRow(turn, '正文' + turn); session.append('turn/end', { turn, reason: { kind: 'completed' } }) }
  session.append('turn/start', { turn: 42 }); userRow(42, '输入42'); userRow(42, '输入42（重发）'); session.append('turn/end', { turn: 42, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  const seq42End = session.seq - 1
  session.append('agent/inbox/spliced', { inserted: [] })
  session.append('turn/start', { turn: 43 })
  session.append('agent/inbox/spliced', { inserted: [] })
  session.append('turn/end', { turn: 43, reason: { kind: 'error', error: { message: '失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准' } } })
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-cold-native-'))
  // 资源声明（不用 const shadow），供单一收尾钩子按真实 present 清理
  let sessionDb = null, store = null, storeRoot = null
  t.after(() => {
    if (store && typeof store.dispose === 'function') store.dispose()
    if (sessionDb && typeof sessionDb.close === 'function') sessionDb.close()
    if (storeRoot) rmSync(storeRoot, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  sessionDb = new SqliteSessionDb(path.join(root, 'session.db'))
  sessionDb.materialize(session.header, session.inheritedEventCount, session.snapshotEvents())
  // 真 store（57 条正文 + failed body42 带基准）
  const { copyJsonTree } = await import(pathToFileURL(path.join(commentAuthorTreeSource(), 'tavern-plugin/lib/domain/copy-json-tree.js')).href)
  const { diffJson, applyJsonChangesShared } = await import(pathToFileURL(path.join(commentAuthorTreeSource(), 'tavern-plugin/lib/domain/json-mutation.js')).href)
  const passthrough = value => (value === undefined ? undefined : structuredClone(value))
  const helpers = { copyJsonTree, diffJson, applyJsonChangesShared }
  for (const name of ['projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint', 'projectSceneImageState']) helpers[name] = passthrough
  storeRoot = mkdtempSync(path.join(os.tmpdir(), 'tavern-cold-store-'))
  mkdirSync(path.join(storeRoot, 'chats'), { recursive: true })
  const chatId = 'chat-cold-native', sessionId = session.id, branchId = 'branch-cold-native', operationId = 'op-cold-native-42'
  store = createChatSqliteStore({ dataRoot: storeRoot, legacyData: undefined, helpers })
  const messages = Array.from({ length: 56 }, (_, index) => index % 2 === 0
    ? { role: 'user', text: '输入' + (index / 2 + 1) }
    : { role: 'assistant', text: '正文' + (Math.floor(index / 2) + 1), turn: Math.floor(index / 2) + 1, swipeId: 0, swipes: ['正文' + (Math.floor(index / 2) + 1)] })
  messages.push({ role: 'assistant', text: '尾轮正文', turn: 41, swipeId: 0, swipes: ['尾轮正文'] })
  assert.equal(messages.length, 57)
  await store.update(chatId, () => ({
    id: chatId, sessionId, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    _storageRevision: 1, updatedAt: 1, cardPath: 'cards/cold-native.json', settleStatus: 'done',
    macroState: { userName: '玩家' }, variables: { hp: 41 }, messages,
    timeline: { schemaVersion: 1, branchId, revision: 9, participants: {}, checkpoints: [], operations: {
      [operationId]: { id: operationId, kind: 'body', turn: 42, status: 'failed', basedOn: { branchId, revision: 9 }, beforeParticipants: {}, businessBefore: { version: 1, fields: { variables: { hp: 41 } }, messageCount: 57, participants: {}, operationIds: [], operationStates: {} } },
    } },
  }))
  // 冷读证据：真 lib 消费者 readFailureEvidence(liveEvidence, query, id)；query.observeSession 造真 lease
  // （{header, events: 真 SqliteSessionDb.readAll().events, [Symbol.dispose]: released++}）
  const leases = { opened: 0, released: 0 }
  const coldQuery = {
    observeSession: async (id, opts) => {
      leases.opened += 1
      assert.equal(opts && opts.projectionMode, 'none', '冷观察必须用 projectionMode:none')
      return {
        header: { id },
        events: sessionDb.readAll().events,
        [Symbol.dispose]: () => { leases.released += 1 },
      }
    },
  }
  const readFailureEvidenceDI = id => readFailureEvidence({ loaded: false, events: [] }, coldQuery, id)
  const viewSeamed = applyLatestFailureViewTransform(applyRollbackPendingViewTransform(read(tree, VIEW_REL)))
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewSeamed, { inspectNativeFailureTail: await loadInspectNativeFailureTail() })
  const evidence = await readFailureEvidenceDI(sessionId)
  assert.equal(evidence.loaded, true, '冷证据必须标记 loaded')
  assert.equal(evidence.session, null, '冷证据不得伪造 session')
  assert.equal(evidence.events[0].seq, 0, '真 Session 事件必须从 seq 0')
  assert.equal(evidence.events.every((event, index) => event.seq === index), true, '事件坐标必须与下标一致')
  assert.equal(leases.opened, leases.released, '冷读必须读取即释放（opened===released）')
  // 原生协议断言（原 native-only 用例核心，这里用真证据/真 helper 覆盖）
  const inspectNativeFailureTail = await loadInspectNativeFailureTail()
  const helperChat = await store.read(chatId)
  assert.equal(inspectNativeFailureTail(helperChat, { events: [] }, helperChat._storageRevision), null, '无 events ⇒ null（不猜）')
  assert.equal(inspectNativeFailureTail(helperChat, {}, helperChat._storageRevision), null, '缺 events ⇒ null')
  const nativeInfo = inspectNativeFailureTail(helperChat, { events: evidence.events }, helperChat._storageRevision)
  assert.equal(nativeInfo.cleanable, true, '43 必须可 native 清理：' + String(nativeInfo && nativeInfo.reason))
  assert.equal(nativeInfo.turn, 43)
  assert.equal(nativeInfo.endSeq, evidence.events.at(-1).seq, 'endSeq 必须是 terminal 事件 seq')
  assert.equal(nativeInfo.eventCount, evidence.events.length, 'eventCount 必须是 events.length')
  assert.equal(nativeInfo.target.kind, 'native-only')
  assert.equal(nativeInfo.target.branchId, helperChat.timeline.branchId)
  assert.equal(nativeInfo.target.revision, helperChat._storageRevision)
  assert.equal(nativeInfo.target.chatId, chatId)
  assert.equal(nativeInfo.target.sessionId, sessionId)
  assert.equal(Object.hasOwn(nativeInfo.target, 'operationId'), false, 'native-only 不得伪造 operationId')
  // 真消费者：签名必须是 (chat, currentEvidence)——第三参用**投影当次送入的 evidence**（含检查点标量）；
  // 用 outer evidence 或 chat.windowRevision 作第三参 ⇒ 第二次投影仍读旧证据，检查点分支会假过。
  const projector = createSessionWindowProjector({ ...projectorDeps(), readFailureEvidence: readFailureEvidenceDI, rollbackViewFields: (chat, currentEvidence) => ({
    failureTarget: latestFailureTarget(chat, null, currentEvidence),
    canClearIncompleteReply: latestFailureTarget(chat, null, currentEvidence) !== null,
    failureCleanupReason: latestFailureCleanupReason(chat, null, currentEvidence),
  }) })
  const openWindow = () => store.readOpeningWindow(chatId, { limit: 48, requirePartial: true, sessionId })
  const project = async source => {
    const result = await projector.project({ chat: source.chat, window: source, activity: source.activity })
    assert.equal(result.kind, 'value', '真投影必须返回 value：' + String(result && result.kind))
    return result.view
  }
  // ① 冷开：窗口快照 + 真原生事件 ⇒ 43 native 目标（真 DB 坐标），narrow 摘要只有 42、不得冒充 43
  const window = await openWindow()
  assert.equal(window.nativeData, true)
  const chatBefore = await store.read(chatId)
  const cold = await project(window)
  const chatAfter = await store.read(chatId)
  assert.equal(chatAfter._storageRevision, chatBefore._storageRevision, '冷投影不得改业务档 revision')
  assert.deepEqual(chatAfter.messages, chatBefore.messages, '冷投影不得改业务档正文')
  assert.equal(chatAfter.timeline.operations[operationId].businessBefore.messageCount, 57, '42 的基准必须原样保留')
  assert.equal(cold.failureTarget.kind, 'native-only', '冷开必须由原生事件签发 43：' + String(cold.failureTarget && cold.failureTarget.turn))
  assert.equal(cold.failureTarget.turn, 43)
  assert.equal(cold.failureTarget.endSeq, evidence.events.at(-1).seq, 'endSeq 必须是真 DB 终事件 seq')
  assert.equal(cold.failureTarget.eventCount, evidence.events.length)
  assert.equal(cold.failureTarget.chatId, chatId)
  assert.equal(cold.failureTarget.sessionId, sessionId)
  assert.equal(Object.hasOwn(cold.failureTarget, 'operationId'), false, 'native-only 不得伪造 operationId')
  assert.equal(cold.failureCleanupReason, '', '可清时不得出现缺基准文案')
  // ② 隐藏检查点：真 store 追加 cp43 后，opening 的 timeline.checkpoints 仍为 []、只有 scalar 报 43
  //    ⇒ 必须 refuse（target null + 检查点原因），只删这条合成 cp 后继续 43→42→41 原生截断链
  await store.update(chatId, current => {
    current.timeline = { ...current.timeline, checkpoints: [...(current.timeline.checkpoints || []), { id: 'cp-cold-native-43', turn: 43 }] }
    current._storageRevision += 1     // 真 store CAS：写入 revision 必须连续（同 sequential 夹具写法）
    return current
  })
  const cpWindow = await openWindow()
  assert.deepEqual(cpWindow.chat.timeline.checkpoints, [], '窄窗口不得把 checkpoints 抄进 chat')
  assert.equal(cpWindow.nativeFailureCheckpointTurn, 43, 'opening 必须在同快照报出检查点 scalar')
  const cpView = await project(cpWindow)
  assert.equal(cpView.failureTarget, null, '已有成功检查点的错误轮不得签发清理目标')
  assert.match(String(cpView.failureCleanupReason), /检查点/, '必须给检查点原因：' + String(cpView.failureCleanupReason))
  const cpBack = await store.read(chatId)
  assert.equal(cpBack.timeline.checkpoints.length, 1, '检查点必须真写在业务档（负例前提）')
  await store.update(chatId, current => {
    current.timeline = { ...current.timeline, checkpoints: current.timeline.checkpoints.filter(cp => cp.id !== 'cp-cold-native-43') }
    current._storageRevision += 1     // 同上：移除也必须递增，保持 revision 连续
    return current
  })
  const afterCpRemoval = await store.read(chatId)   // 收尾基准：cp 注入两次写之后的存档状态（投影无写须与它比）
  assert.deepEqual(afterCpRemoval.timeline.checkpoints, [], '合成检查点必须删净后才能继续原生截断链')
  assert.equal((await openWindow()).nativeFailureCheckpointTurn, 0, '删净后 scalar 必须回到 0')
  // ③ 清 43（真物理纯尾）：用真 SqliteSessionDb 截断到 42 末事件，再投影 ⇒ 必须暴露 42 body 目标
  const meta = sessionDb.truncateFrom(seq42End)
  assert.equal(meta.eventCount, seq42End + 1)
  const afterNative = await readFailureEvidenceDI(sessionId)
  assert.equal(afterNative.events.length, seq42End + 1, '截断后证据必须只到 42 尾')
  const window42 = await openWindow()
  const body42View = await project(window42)
  assert.equal(body42View.failureTarget.operationId, operationId, '清 43 后必须暴露 42 的正文目标')
  assert.equal(body42View.failureTarget.turn, 42)
  assert.equal(body42View.failureTarget.revision, window42.revision, '42 目标 revision 必须取当前窗口动态版本')
  // ③ 清 42 后（真 DB 截到 41 尾）：不得再有 ft，且不得有 live session/resume
  const seq41End = afterNative.events.findLastIndex(event => event.type === 'turn/end' && Number(event.data.turn) === 41)
  assert.equal(seq41End >= 0, true)
  const meta41 = sessionDb.truncateFrom(seq41End)
  const window41 = await openWindow()
  assert.equal(window41.nativeData, true, '清到 41 后窗口仍必须可用')
  const afterAll = await project(window41)
  assert.equal(afterAll.failureTarget, null, '清完 42 不得再签发失败目标')
  assert.equal(leases.opened > 0, true, '冷读必须真的走过 readFailureEvidence')
  assert.equal(leases.opened, leases.released, '每个观察 lease 必须读完即释放（opened===released）')
  assert.equal(sessionDb.readMeta().eventCount, meta41.eventCount, '真 DB 事件数必须与截断回执一致')
  const chatNow = await store.read(chatId)
  assert.equal(chatNow._storageRevision, afterCpRemoval._storageRevision, '纯投影区间不得改业务档 revision（cp 注入的两次写不算投影写）')
  assert.deepEqual(chatNow.messages, afterCpRemoval.messages, '纯投影区间不得改业务档正文')
})

test('最新失败接线：queryFailureCleanup 真实SQLite五场景', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tavern-failure-cleanup-'))
  const db = new DatabaseSync(path.join(dir, 'archive.db'))
  try {
    // DDL 参照 lib/timeline-nodes.js:27-31（timeline 子行表）与 chat-sqlite-store.js:551-554（消息行）。
    db.exec('CREATE TABLE IF NOT EXISTS archive_timeline_nodes (node_key TEXT PRIMARY KEY, ord INTEGER NOT NULL, value_json TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT NOT NULL)')
    const node = (key, value) => db.prepare('INSERT OR REPLACE INTO archive_timeline_nodes (node_key,ord,value_json) VALUES (?,?,?)').run(key, 0, JSON.stringify(value))
    const dropNode = key => db.prepare('DELETE FROM archive_timeline_nodes WHERE node_key=?').run(key)
    const body = extra => ({ id: 'op7', kind: 'body', turn: 7, status: 'failed', ...extra })
    const timeline = operations => ({ schemaVersion: 1, branchId: 'b1', revision: 4, operations, checkpoints: [] })
    const single = timeline({ op7: body({ businessBefore: { messages: [] } }) })
    // ① 基准在位且无 checkpoint/尾行/后继操作 ⇒ cleanable
    node('operations:op7', single.operations.op7)
    const clean = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(clean.cleanable, true, '失败轮基准在位 ⇒ cleanable')
    assert.equal(clean.turn, 7)
    assert.equal(clean.operationId, 'op7')
    assert.equal(clean.revision, 4)
    assert.equal(clean.branchId, 'b1')
    assert.equal(clean.reason, '')
    // ② 无发轮前基准 ⇒ 拒绝并给原因
    node('operations:op7', body())
    const noBase = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(noBase.cleanable, false)
    assert.match(noBase.reason, /回退基准/)
    node('operations:op7', single.operations.op7)
    // ③ 同轮已有 checkpoint ⇒ 不是失败态
    node('checkpoints#ck7', { id: 'ck7', turn: 7 })
    const checkpoint = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(checkpoint.cleanable, false)
    assert.match(checkpoint.reason, /检查点/)
    dropNode('checkpoints#ck7')
    // ④ 之后已有正文行 ⇒ 不是最新尾部
    db.prepare('INSERT INTO archive_messages (message_index,message_json) VALUES (?,?)').run(0, JSON.stringify({ turn: 8, role: 'assistant' }))
    const tail = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(tail.cleanable, false)
    assert.match(tail.reason, /正文行/)
    db.prepare('DELETE FROM archive_messages').run()
    // ⑤ 之后已有任务推进（非 body 操作 turn 8）⇒ 不是最新尾部
    const ahead = timeline({
      op7: body({ businessBefore: { messages: [] } }),
      op8: { id: 'op8', kind: 'agent', turn: 8, status: 'running' },
    })
    const advanced = queryFailureCleanup(db, { revision: 4, timeline: ahead })
    assert.equal(advanced.cleanable, false)
    assert.match(advanced.reason, /任务推进/)
    // ⑥ 没有失败 body 操作 ⇒ 空摘要（不报原因）
    assert.deepEqual(queryFailureCleanup(db, { revision: 4, timeline: timeline({}) }), { cleanable: false, reason: '' })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('最新失败接线：新增证据读口施缝源码语法与卸载回原', async () => {
  // 新增依赖（index 的 async 证据读口 + domain 视图 inspect import + owned 垫片 export）必须是**可解析源码**，
  // 且卸载后逐字回到作者原文。只碰这 4 个 exact 文件；不跑全树、不做全树字节哈希。
  const tree = buildTree(), app = tree.appDir
  applyStandardSeams({ appDir: app, authorVersion: AUTHOR_VERSION, assertStopped: () => true })
  const { parseSeamSource } = await import('../deploy/comment-seam-blocks.mjs')
  const { parse } = await import('../lib/vendor/acorn/acorn.mjs')
  const bridge = 'tavern-plugin/lib/domain/storage-rollback.js'
  const files = [INDEX_REL, VIEW_REL, bridge, 'tavern-plugin/src/client/turn-error-controls.js']
  for (const rel of files) {
    const seamed = read(tree, rel)
    // ① 接管判定走**块记录**（作者文件本就是接缝块，无 owned-new 标记）：blocks 里有本 owner 的块
    const { blocks } = parseSeamSource(seamed, { rel })
    assert.ok(blocks.some(block => block.metadata && block.metadata.owner === 'dsh-tavern-sqlite-v2'), rel + ' 必须含本 owner 的接缝块')
    // ② 消费面语法：与 comment-seam-blocks:85 同口径的 strict 选项（module 顶层 await 自然支持，不放开函数内 await）
    const active = activeSource(seamed, rel)
    assert.doesNotThrow(() => parse(active, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }), rel + ' ACTIVE 消费投影必须可解析（module）')
  }
  // ③ 撤缝即删：新增桥文件施缝前不存在（不 read 不存在的文件、不扫全树）
  assert.equal(tree.original.has(bridge), false, '新增 owned 桥文件施缝前不得存在')
  // ④ 卸载：原作者 3 文件逐字回 original；新增桥文件必须被删
  uninstallStandardSeams({ appDir: app, assertStopped: () => true })
  for (const rel of files) {
    if (rel === bridge) { assert.equal(existsSync(path.join(app, rel)), false, '卸载必须删除新增桥文件'); continue }
    assert.equal(read(tree, rel), tree.original.get(rel), rel + ' 卸载必须逐字回到作者原文')
  }
  // ⑤ 唯一一次重装：owned 3 导出 + 4 文件消费投影严格 parse；ready 只是计划比对（此处仅记其边界）
  const applied = applyStandardSeams({ appDir: app, authorVersion: AUTHOR_VERSION, assertStopped: () => true })
  assert.equal(applied.ready, true)
  assert.equal(checkStandardSeams({ appDir: app }).ready, true, 'ready 单断言：计划比对口径（非语法门）')
  assert.equal(read(tree, bridge).includes("await storagePackage('clean-rollback')"), true, '重装后 owned 桥必须转出 clean-rollback 三导出')
  for (const rel of files) {
    const seamed = read(tree, rel)
    const { blocks } = parseSeamSource(seamed, { rel })
    assert.ok(blocks.some(block => block.metadata && block.metadata.owner === 'dsh-tavern-sqlite-v2'), rel + ' 重装后必须仍含本 owner 接缝块')
    assert.doesNotThrow(() => parse(activeSource(seamed, rel), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }), rel + ' 重装后消费投影必须可解析')
  }
})
