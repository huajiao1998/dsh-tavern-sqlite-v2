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
import {assembleTavernView} from './support/author-view-assembler.mjs'
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
import { latestSendTarget } from '../lib/latest-send.js'
import { applyLatestSendViewTransform } from '../deploy/latest-send-view-transform.mjs'
import { readFailureEvidence } from '../lib/failure-view-evidence.js'
import { applyNativeMessageHostTransform } from '../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { activeSource, commentAuthorTreeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { bumpTreeCopy, composedFailureViewText, readLatestFailureSource } from './support/latest-failure-source.mjs'

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
  'narrowTurn !== null && narrowTurn >= 1 && (narrow.operationId === undefined || narrow.operationId)',
  'if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason',
  'const native = inspectNativeFailureTail(chat, evidence, revision)',
]
const trees = []
/** 真实作者 source fixture → 自有 mkdtemp（helper 只复制维护 targets + 作者包；缺失即响亮失败，不 skip）。
 *  只给**真装卸/真 appDir**用例用；只读消费者改走 support/latest-failure-source.mjs 的原文直读。 */
const buildTree = () => {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  trees.push(tree)
  bumpTreeCopy()
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

// 原正向结果迁至 standard-positive.test.mjs；其余场景保留独立现场。


test('最新失败接线：RPC与投影幂等及缺块拒绝', async () => {
  const indexRaw = readLatestFailureSource(INDEX_REL)
  // RPC：真完整 index source（含 pending 状态字段所在的整文件）
  const hostOnce = applyLatestFailureHostTransform(indexRaw)
  assert.equal(hostOnce.includes(FAILURE_RPC), true, 'RPC 必须改为 failureTarget 优先')
  assert.equal(hostOnce.includes('// [dsh-tavern-latest-failure-host:v1]'), true, '宿主标记必须在位')
  assert.equal(applyLatestFailureHostTransform(hostOnce), hostOnce, '宿主复跑必须幂等')
  assert.throws(() => applyLatestFailureHostTransform(hostOnce.replace(FAILURE_RPC, 'args.expectedTurn')), /不完整/, '缺 RPC 改动必须拒')
  assert.throws(() => applyLatestFailureHostTransform(hostOnce + '\n// [dsh-tavern-latest-failure-host:v1]\n'), /不完整/, '标记重复必须拒')
  // 真作者 index 的 rollbackTurn 是 multiline 分支（index.js:4386-4387）：按真实缩进文本唯一 mutate，先证命中再拒
  // 三种作者形态：旧版单行 return / 新版多行块 / 上游 537e878 起的 reconcile 前置块
  // （const view 前多一行 await reconcileStory）。2.7.0 即第三种，缺它则 replace 不命中、
  // 退化成"假缺块"断言。beforeNew 本身在三种形态里都命中 const view 那一行，故 transform 不受影响。
  const RPC_PLAIN = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn) }"
  const RPC_BLOCK = "      case 'rollbackTurn': {\n        const view = await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn)"
  const RPC_RECONCILE = "      case 'rollbackTurn': {\n        await reconcileStory(args && args.sessionId)\n        const view = await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn)"
  const rpcAnchor = indexRaw.includes(RPC_PLAIN) ? RPC_PLAIN
    : indexRaw.includes(RPC_RECONCILE) ? RPC_RECONCILE
    : RPC_BLOCK
  const brokenRpc = indexRaw.replace(rpcAnchor, '')
  assert.notEqual(brokenRpc, indexRaw, '替换必须命中真实 multiline RPC 锚（防"替换没命中"的假缺块）')
  assert.throws(() => applyLatestFailureHostTransform(brokenRpc), /锚点缺失\/不唯一/, '锚点缺失必须拒')
  // 视图：真完整 chat-session-state source；失败视图接缝接在**既有 pending 视图转换产物**之后（真实标准组合顺序）
  const viewRaw = applyRollbackPendingViewTransform(readLatestFailureSource(VIEW_REL))
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
    assembleTavernView,
    str: value => (value === undefined || value === null ? '' : String(value)),
    readTavernSettings: async () => ({ trustedCardMode: false, frameSizing: 'fill' }),
    readScript: async () => undefined,
    scriptContinuity: { inspect: () => null },
    groupOfMode: () => 'story',
    replyProjectionsOf: () => [],
    incrementalReplyView: { project: async () => ({ projections: [], statusViews: [] }) },
    composeTavernRegexScripts: () => [],
    liveCardUpdate: { project: async (_c, _card, display) => display },
    projectCompactionState: chat => chat.contextCompaction || null,
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
  const viewSeamed = await composedFailureViewText()
  for (const field of FAILURE_FIELDS) assert.equal(viewSeamed.includes(field), true, '注入面必须含字段：' + field)
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewSeamed, { inspectNativeFailureTail: await loadInspectNativeFailureTail() }, true)
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
  // 终止失败证据（合成事件对象，不复制现场身份）：新 guard 只认同轮 turn/end reason=aborted/error。
  // 真投影只回函数结果 ⇒ 证据由 deps 读取口按 chat 上的 `__failureEvidence`（缺省用本轮真实终止证据）传入。
  const evidence42 = endingEvidence(42, 'aborted')
  const evidenceById = new Map([[chatId, evidence42]])
  const evidenceOf = chat => evidenceById.get(chat && chat.id) || evidence42
  const projector = createSessionWindowProjector({ ...projectorDeps(), rollbackViewFields: chat => ({
    failureTarget: latestFailureTarget(chat, null, evidenceOf(chat)),
    canClearIncompleteReply: latestFailureTarget(chat, null, evidenceOf(chat)) !== null,
    failureCleanupReason: latestFailureCleanupReason(chat, null, evidenceOf(chat)),
  }) })
  const project = async source => {
    const result = await projector.project({ chat: source.chat, window: source, activity: source.activity })
    assert.equal(result.kind, 'value', '真投影必须返回 value：' + String(result && result.kind))
    return result.view
  }
  // ① 窗口副本（真投影写法：_storageRevision undefined + windowRevision）⇒ 必须给出确切 target（revision 动态取摘要）
  const windowView = await project(window)
  assert.deepEqual(windowView.failureTarget, {
    kind:'rollback',chatId, sessionId, turn: 42, branchId, revision: summary.revision, operationId,
  }, '窗口副本必须经 windowRevision pin 得到确切 target（修复前为 null）')
  assert.equal(windowView.failureCleanupReason, '', '可清理时不得出现通用缺基准文案')
  assert.equal(windowView.canClearIncompleteReply, true, '可清理态必须让 UI 认到可清')
  // ② 摘要 revision 与窗口不符 ⇒ 必须拒（无 replayTarget ⇒ 不产原因，只断言 target 为 null）
  // 本场景语义＝"摘要过期且无失败证据可用" ⇒ 用无证据投影（投影会丢自定义字段，故走 chatId 侧信道）
  evidenceById.set(chatId, noEvidence())
  const stale = { ...window, failureCleanup: { ...summary, revision: Number(summary.revision) - 1 } }
  const staleView = await project(stale)
  assert.equal(staleView.failureTarget, null, '过期摘要必须拒')
  assert.equal(staleView.failureCleanupReason, '', '无 replayTarget 时不产通用原因（原语义保持）')
  evidenceById.set(chatId, evidence42)   // 复原本轮终止证据（②只作用于该次投影）
  // ③ 全档路径：真 store read() 带 _storageRevision 且无摘要 ⇒ 走真 baseline fallback（拿同一轮的真实基准）
  const fullChat = await store.read(chatId)
  assert.equal(Number.isSafeInteger(fullChat._storageRevision), true, '全档必须带存储版本')
  assert.equal(Object.hasOwn(fullChat, 'failureCleanup'), false, '全档本就不带窄摘要')
  assert.deepEqual(latestFailureTarget(fullChat, { turn: 42 }, evidence42), {
    kind:'rollback',chatId, sessionId, turn: 42, branchId, revision: fullChat._storageRevision, operationId,
  }, '全档必须经 replayTarget 走真实基准 fallback 给同一轮目标（带同证据）')
  // missing baseline 的真实形态：body42 仍在（kind/turn 齐全）但**没有** businessBefore ⇒ 不是 clear all ops
  const noBaselineChat = { ...fullChat, timeline: { ...fullChat.timeline, operations: { [operationId]: { kind: 'body', turn: 42 } } } }
  assert.equal(latestFailureTarget(noBaselineChat, { turn: 42 }, evidence42), null, 'body42 在但缺 businessBefore ⇒ 不签目标')
  // 非终止生命周期（active / completed / 无事件）不再构成拒签资格：有完整真实基准时仍签同一轮 rollback
  for (const [label, buildEvidence] of [['active', activeEvidence], ['completed', completedEvidence], ['无事件', noEvidence]]) {
    const signed = latestFailureTarget(fullChat, { turn: 42 }, buildEvidence(42))
    assert.equal(signed?.kind, 'rollback', label + '：仍应签 rollback 目标')
    assert.equal(signed?.turn, 42, label + '：必须签同一轮 42')
  }
  assert.equal(latestFailureCleanupReason(fullChat, { turn: 42 }, activeEvidence(42)), '', 'active 目标可签，原因仅在无可执行清理目标时出现')
  assert.equal(latestFailureCleanupReason(fullChat, { turn: 42 }, completedEvidence(42)), '', 'completed 目标可签，原因仅在无可执行清理目标时出现')
  assert.equal(latestFailureCleanupReason(fullChat, { turn: 42 }, noEvidence()), '', '无证据仍不伪造原因或目标')
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
function failureHelpers(source, deps = null, unified = false) {
  if(unified){
    const final=applyLatestSendViewTransform(source)
    const text=extractFunction(final,'function latestFailureTarget(chat, replayTarget, evidence) {')+'\n'
      +extractFunction(final,'function latestFailureCleanupReason(chat, replayTarget, evidence) {')+'\n'
      +extractFunction(final,'function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {')+`\n
      function rollbackViewFieldsBase(chat,evidence){
        const failureTarget=latestFailureTarget(chat,null,evidence)
        return {failureTarget,failureCleanupReason:latestFailureCleanupReason(chat,null,evidence),canRollback:failureTarget!==null,
          canClearIncompleteReply:failureTarget!==null,rollbackTargetTurn:failureTarget?.turn??null,rollbackUnavailableReason:'',rollbackPending:!!chat.rollbackPending}
      }
      return {latestFailureTarget:(chat,replay,evidence)=>rollbackViewFields(chat,evidence).failureTarget,
        latestFailureCleanupReason:(chat,replay,evidence)=>rollbackViewFields(chat,evidence).failureCleanupReason}`
    return new Function('inspectNativeFailureTail','latestSendTarget','evidenceOf',text)(deps.inspectNativeFailureTail,latestSendTarget,()=>undefined)
  }
  if (deps === null || typeof deps.inspectNativeFailureTail !== 'function') {
    throw new Error('failureHelpers 必须注入真实 inspectNativeFailureTail（native-only 协议依赖）')
  }
  const names = Object.keys(deps)
  const text = extractFunction(source, 'function latestFailureTarget(chat, replayTarget, evidence) {')
    + '\n' + extractFunction(source, 'function latestFailureCleanupReason(chat, replayTarget, evidence) {')
    + '\nreturn { latestFailureTarget, latestFailureCleanupReason }'
  const production = new Function(...names, text)(...names.map(name => deps[name]))
  // 这些旧夹具只提供只读事件，没有启动前后台运行器；显式补充该隔离条件。
  // 有活动旗的输入原样优先；运行器活动/缺证明的生产拒绝由 incomplete-round-cleanup 独立覆盖。
  const fixtureEvidence = evidence => ({cleanupIdle:true,foregroundActive:false,backgroundActive:false,...evidence})
  return {
    latestFailureTarget: (chat,replay,evidence) => production.latestFailureTarget(chat,replay,fixtureEvidence(evidence)),
    latestFailureCleanupReason: (chat,replay,evidence) => production.latestFailureCleanupReason(chat,replay,fixtureEvidence(evidence)),
  }
}
/** 真实事件形状的**终止失败证据**：最新 turn/start 之后同轮出现 turn/end 且 reason=error/aborted。
 *  新 guard 只认这一种生命周期才会签新 body 目标；active/completed/无事件都不许签。 */
function endingEvidence(turn, kind = 'aborted') {
  return { events: [
    { seq: 0, type: 'turn/start', data: { turn } },
    { seq: 1, type: 'user/message', data: { id: 'u' + turn, role: 'user', content: [{ type: 'text', text: '输入' + turn }] } },
    { seq: 2, type: 'assistant/message', data: { turn, message: { id: 'a' + turn, role: 'assistant', content: [{ type: 'text', text: '正文' + turn }] } } },
    { seq: 3, type: 'turn/end', data: { turn, reason: { kind } } },
  ] }
}
/** 仅 turn/start + turn/end 的终止证据（无正文消息 ⇒ native inspector 无正文回退文案），用于原因回落负例。 */
const endingEvidenceBare = (turn, kind = 'aborted') => ({ events: [
  { seq: 0, type: 'turn/start', data: { turn } },
  { seq: 1, type: 'turn/end', data: { turn, reason: { kind } } },
] })

/** 仍 active（无 end）的证据。 */
const activeEvidence = turn => ({ events: [{ seq: 0, type: 'turn/start', data: { turn } }] })
/** 已 completed（非失败终止）的证据。 */
const completedEvidence = turn => ({ events: [
  { seq: 0, type: 'turn/start', data: { turn } },
  { seq: 1, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
] })
/** 完全没有 events 的证据（冷档/无证据）。 */
const noEvidence = () => ({ events: [] })

/** 各用例共用的真身取用口（缺导出即响亮失败）。 */
async function loadInspectNativeFailureTail() {
  const module = await import('../lib/clean-rollback.js')
  assert.equal(typeof module.inspectNativeFailureTail, 'function', '后端 clean-rollback.js 必须导出 inspectNativeFailureTail')
  return module.inspectNativeFailureTail
}

test('最新失败接线：窄摘要分支与原因优先级（变换产物内真函数）', async () => {
  const viewOnce = await composedFailureViewText()
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewOnce, { inspectNativeFailureTail: await loadInspectNativeFailureTail() }, true)
  const narrow = { cleanable: true, revision: 9, turn: 7, operationId: 'op7', branchId: 'b1' }
  // 该轮是**真实 body 失败**（timeline 内有 body 操作）⇒ 不落 native-only guard 分支；证据仍是同轮终止失败。
  const chat = { id: 'c1', sessionId: 's1', _storageRevision: 9, failureCleanup: narrow,
    timeline: { branchId: 'b1', operations: { op7: { kind: 'body', turn: 7, status: 'failed', businessBefore: { version: 1, messageCount: 0, fields: { variables: { hp: 1 } }, participants: {} } } } } }
  // 终止失败证据（turn7 aborted，真实事件形状；非 guard 轮的 body 失败，不签 native-only）
  const evidence7 = endingEvidence(7, 'aborted')
  assert.deepEqual(latestFailureTarget(chat, null, evidence7),
    { kind: 'rollback', chatId: 'c1', sessionId: 's1', turn: 7, branchId: 'b1', revision: 9, operationId: 'op7' },
    '窄摘要 cleanable 且 revision 相符且终止失败 ⇒ 直接给 rollback 目标（窄视图不再永远 null）')
  // 负例 chat 也带真实 timeline/branch：确保拒绝来自窄摘要 CAS，而不是被 native 兜底掩盖
  const chatBare = { id: 'c1', sessionId: 's1', _storageRevision: 9, failureCleanup: narrow, timeline: { branchId: 'b1', operations: { op7: { kind: 'body', turn: 7 } } } }
  assert.equal(latestFailureTarget({ ...chatBare, _storageRevision: 10 }, null, evidence7), null, '窄摘要 revision 与现场不符 ⇒ 不采信')
  assert.equal(latestFailureTarget({ ...chatBare, failureCleanup: { ...narrow, turn: 0 } }, null, evidence7), null, '窄摘要 turn 非安全整数 ⇒ 不采信')
  assert.equal(latestFailureTarget({ ...chatBare, failureCleanup: { ...narrow, operationId: '' } }, null, evidence7), null, '窄摘要缺 operationId ⇒ 不采信')
  // 非终止生命周期不再构成拒签资格：有完整真实基准时窄摘要仍签同一轮 rollback
  for (const [label, buildEvidence] of [['active', activeEvidence], ['completed', completedEvidence], ['无事件', noEvidence]]) {
    const signed = latestFailureTarget(chat, null, buildEvidence(7))
    assert.equal(signed?.kind, 'rollback', label + '：有完整 baseline 时仍签 rollback')
    assert.equal(signed?.turn, 7, label + '：必须签同一轮 7')
  }
  const other = latestFailureTarget(chat, null, endingEvidence(8, 'error'))
  assert.equal(other?.kind, 'native-only', '终止轮 8 无业务 ⇒ 只能 native-only 8（不得退回旧 7）')
  assert.equal(other?.turn, 8, 'native-only 必须指向 8')
  // 身份缺失：view overlay 静默（''），真实 inspector 必须拒签并给出可靠身份原因
  const inspectNative = await loadInspectNativeFailureTail()
  const noIdentity = { ...chat, id: undefined, sessionId: undefined }
  const inspected = inspectNative(noIdentity, { events: evidence7.events, cleanupIdle: true, activity: { phase: 'idle', busy: false } }, 9)
  assert.equal(inspected.target, null, '缺可靠身份不得签出')
  assert.match(String(inspected.reason || ''), /缺少可靠身份/, 'inspector 必须给出缺身份原因')
  // pending 形态仍优先于窄摘要（半提交只许完成同一清理）：active 证据下也优先
  assert.equal(latestFailureTarget({ ...chat, rollbackPending: { id: 'rb1', failureTarget: { turn: 6, operationId: 'op6', branchId: 'b0' } } }, null, activeEvidence(7)).turn, 6,
    'rollbackPending.failureTarget 优先（不受终止生命周期限制）')
  assert.equal(latestFailureCleanupReason(chat, null, evidence7), '', '窄摘要 cleanable ⇒ 无原因')
  assert.equal(latestFailureCleanupReason(chat, null, activeEvidence(7)), '', 'active ⇒ 零原因（不提示清理活动轮）')
  assert.equal(latestFailureCleanupReason(chat, null, noEvidence()), '', '无证据 ⇒ 零原因')
  // 分层：假摘要（cleanable:false）＋可撤 chat ⇒ 最终 overlay 不再展示旧分类 reason（真实 inspector 原因另有断言）
  assert.equal(latestFailureCleanupReason({ ...chat, failureCleanup: { cleanable: false, reason: '该失败轮缺少发轮前回退基准，不能安全清理' } }, null, evidence7),
    '', '窄摘要假摘要在可撤 chat 上静默（reason 不沿用旧分类）')
  // 原因回落负例（终止失败但无可清目标 ⇒ 必须给出原因、不得静默）：新 guard 下 native inspector 会先报它自己的
  // 权威原因（本档身份/分支/版本缺失、或正文须按该轮基准清理）；通用文案只在 native 无话可说时出现，故这里断言
  // "落在已知清理原因集合内且非空"，不把某一条字面量当成唯一正确值。
  // 严格身份：缺 timeline.branchId（身份/分支/版本）时，真 inspector 先报"缺身份/分支/版本"
  const reasonFallback = latestFailureCleanupReason({ id: 'c1', sessionId: 's1', _storageRevision: 9 }, { turn: 7 }, endingEvidenceBare(7, 'error'))
  assert.equal(reasonFallback, '', 'view overlay 缺身份静默（真实 inspector 的缺身份拒签与原因已在本叶前段保留断言），实际=' + JSON.stringify(reasonFallback))
  // 对偶：身份/分支齐备但该轮没有 body 操作 ⇒ 报"正文须按该轮业务回退基准清理"（同一证据、不同形状）
  const withBranch = latestFailureCleanupReason({ id: 'c1', sessionId: 's1', _storageRevision: 9, timeline: { branchId: 'b1', operations: {} } }, { turn: 7 }, endingEvidenceBare(7, 'error'))
  // 实测合同（真 inspector，非猜测）：有身份/分支但该轮无 body ⇒ 报"不是可证明未进入正文准备的守卫错误，不能无基准清理"
  assert.equal(withBranch, '', '有身份/分支且属连续 native 尾 ⇒ 可撤，view 不再给 reason，实际=' + JSON.stringify(withBranch))
})

test('最新失败接线：native-only 尾（guard 失败轮无 op）经注入 inspectNativeFailureTail 成为 ft（合成身份）', async () => {
  const viewOnce = await composedFailureViewText()
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
    variables: { hp: 41 },
    timeline: { schemaVersion: 1, branchId, revision, operations: { op42: { kind: 'body', turn: 42, status: 'failed', businessBefore: { version: 1, messageCount: 57, fields: { variables: { hp: 41 } }, participants: {}, operationIds: [] } } }, checkpoints: [] },
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
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewOnce, { inspectNativeFailureTail }, true)
  assert.deepEqual(latestFailureTarget(chat, null, { events }), {
    kind: 'native-only', incomplete: true, chatId, sessionId, turn: 43, branchId, revision,
    endSeq: events.at(-1).seq, eventCount: events.length,
  }, 'native 末轮必须给带真坐标的目标（无 operationId；incomplete:true）')
  assert.equal(latestFailureCleanupReason(chat, null, { events }), '', '可清时不得出现通用缺基准文案')
  // ③ 冷开（无 narrow 摘要）+ 尾轮 42 有 body 基准 ⇒ 真冷 API 支持給 42（不是 null，也不挑更旧 op）
  const events42 = events.slice(0, before43)
  const coldChat = { ...chat, revision: 13, windowRevision: 13 }
  assert.deepEqual(latestFailureTarget(coldChat, null, { events: events42 }), {
    kind: 'rollback', chatId, sessionId, turn: 42, branchId, revision: 13, operationId: 'op42',
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
    kind: 'rollback', chatId, sessionId, turn: 42, branchId, revision: 13, operationId: 'op42',
  }, '先清 43 之后必须能正常拿到 42 的 body 目标')
})

test('最新失败接线：冷开只读原生事件签发43且清后暴露42', async (t) => {
  // 本条**整合原 native-only 用例的全部协议断言**（真 helper 无 events/缺 events/坐标/无 operationId/身份），
  // 故独立的 native-only 用例不再单独执行；不新增文件、不扩用例数。
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
  const viewSeamed = await composedFailureViewText()
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewSeamed, { inspectNativeFailureTail: await loadInspectNativeFailureTail() }, true)
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
  assert.equal(cpView.failureCleanupReason, '', '最终 view 无可执行 target 时清空旧分类（检查点挡仍由 failureTarget===null 表达），实际=' + JSON.stringify(cpView.failureCleanupReason))
  // 真实 scalar guard：检查点必须**真挡**（target null ＋ 具体原因），不是把 reason 删掉就算过
  const cpGuard = (await loadInspectNativeFailureTail())(cpWindow.chat, { events: (await readFailureEvidenceDI(sessionId)).events, nativeFailureCheckpointTurn: cpWindow.nativeFailureCheckpointTurn }, cpWindow.revision)
  assert.equal(cpGuard.target, null, '检查点 scalar 必须真挡（不得靠删 reason 放行）')
  assert.match(String(cpGuard.reason || ''), /检查点/, '检查点挡必须给出具体原因')
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
  assert.equal(afterAll.failureTarget, null, '只截原生未同步 Chat，窗口摘要与实际最新轮不一致，拒签旧 42 目标')
  assert.equal(leases.opened > 0, true, '冷读必须真的走过 readFailureEvidence')
  assert.equal(leases.opened, leases.released, '每个观察 lease 必须读完即释放（opened===released）')
  assert.equal(sessionDb.readMeta().eventCount, meta41.eventCount, '真 DB 事件数必须与截断回执一致')
  const chatNow = await store.read(chatId)
  assert.equal(chatNow._storageRevision, afterCpRemoval._storageRevision, '纯投影区间不得改业务档 revision（cp 注入的两次写不算投影写）')
  assert.deepEqual(chatNow.messages, afterCpRemoval.messages, '纯投影区间不得改业务档正文')
})

test('最新发送摘要：queryFailureCleanup 真实SQLite前像、检查点与完整窄读一致', async () => {
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
    const baseline = { version: 1, messageCount: 0, fields: { variables: {} }, participants: {} }
    const single = timeline({ op7: body({ businessBefore: baseline }) })
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
    assert.match(noBase.reason, /发轮前基准/)
    // 新修：完整与窄读都不能把其它分支的前像作为本档发送前基准。
    const foreignBody=body({businessBefore:baseline,basedOn:{branchId:'foreign-branch'}})
    node('operations:op7',foreignBody)
    assert.equal(queryFailureCleanup(db,{revision:4,timeline:single}).cleanable,false,'窄SQL必须携带分支归属证据')
    assert.equal(latestSendTarget({id:'branch-chat',sessionId:'branch-session',_storageRevision:4,timeline:timeline({op7:foreignBody})}),null,'完整档同判据拒其它分支前像')
    node('operations:op7', single.operations.op7)
    // ③ 同轮已有checkpoint仍可撤销；同轮可用checkpoint也不能被坏body遮蔽
    node('checkpoints#ck7', { id: 'ck7', turn: 7 })
    const checkpoint = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(checkpoint.cleanable, true)
    node('operations:op7',body({ businessBefore: { ...baseline, fields: null } }))
    node('checkpoints#ck7',{ id: 'ck7', turn: 7, businessBefore: baseline })
    assert.equal(queryFailureCleanup(db, { revision: 4, timeline: single }).cleanable,true)
    dropNode('checkpoints#ck7')
    for(const invalid of [{...baseline,version:2},{...baseline,version:true},{...baseline,messageCount:true},{...baseline,messageCount:false},{...baseline,messageCount:-1},{...baseline,messageCount:null},{...baseline,messageCount:'0'},{...baseline,fields:null},{...baseline,fields:[]},{...baseline,participants:null},{...baseline,participants:[]}]) {
      node('operations:op7',body({ businessBefore: invalid }))
      assert.equal(queryFailureCleanup(db, { revision: 4, timeline: single }).cleanable,false)
    }
    node('operations:op7',single.operations.op7)
    // ④ 之后已有正文行 ⇒ 不是最新尾部
    db.prepare('INSERT INTO archive_messages (message_index,message_json) VALUES (?,?)').run(0, JSON.stringify({ turn: 8, role: 'assistant' }))
    const tail = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(tail.cleanable, false)
    assert.match(tail.reason, /最新发送缺少发轮前基准/)
    db.prepare('DELETE FROM archive_messages').run()
    // ⑤ 独立任务不能冒认玩家最新发送；新body无基准则拒，不回落7。
    node('operations:op8',{ id:'op8', kind:'agent', turn:8, status:'running' })
    assert.equal(queryFailureCleanup(db, { revision: 4, timeline: single }).turn,7)
    node('operations:op8',{ id:'op8', kind:'body', turn:8, status:'未来状态' })
    assert.equal(queryFailureCleanup(db, { revision: 4, timeline: single }).cleanable,false)
    node('operations:op8',{ id:'op8', kind:'body', turn:8, status:'未来状态', businessBefore:baseline })
    assert.equal(queryFailureCleanup(db, { revision: 4, timeline: single }).turn,8)
    // ⑥ 成败/未知操作状态不会改变有真实前像的最新坐标。
    for(const status of ['completed','failed','running','未来状态']) {
      node('operations:op8',{ id:'op8', kind:'body', turn:8, status,businessBefore:baseline })
      const summary=queryFailureCleanup(db, { revision: 4, timeline: single })
      assert.equal(summary.cleanable,true);assert.equal(summary.turn,8);assert.equal(summary.operationId,'op8')
    }
    dropNode('operations:op8');dropNode('operations:op7')
    assert.deepEqual(queryFailureCleanup(db, { revision: 4, timeline: timeline({}) }), { cleanable: false, reason: '最新发送缺少发轮前基准，不能以当前值猜历史' })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// 活动轮与已完成轮不按终态限制撤销资格；先由静止门收口，再由真实前像、身份、CAS和纯尾预检决定能否执行。
test('活动轮失败提示：所有终态与输出形态均可签清理目标，安全护栏另行拒绝', async () => {
  const viewSource = applyRollbackPendingViewTransform(readLatestFailureSource(VIEW_REL))
  const wired = applyLatestFailureViewTransform(viewSource)
  const deps = { inspectNativeFailureTail: () => null }
  const { latestFailureTarget } = failureHelpers(wired, deps)
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-active-failure-'))
  try {
    const raw = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
      .replace(/from "(@deepseek-ai\/[^"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
    const sessionFile = path.join(root, 'session.mjs')
    writeFileSync(sessionFile, raw, 'utf8')
    const { Session } = await import(pathToFileURL(sessionFile).href)
    const turn = 43
    const base = {id: 'active-chat', sessionId: 'active-session', _storageRevision: 5, windowRevision: 5, messages: [], timeline: {branchId: 'b1', revision: 5, checkpoints: [], participants: {},
      operations: {body: {kind: 'body', turn, status: 'failed', businessBefore: {version: 1, fields: {}, messageCount: 0, participants: {}, operationIds: [], operationStates: {}}}}}}
    const build = close => {
      const session = Session.create('active-failure-' + String(close))
      session.append('turn/start', {turn: turn - 1})
      session.append('turn/end', {turn: turn - 1, reason: {kind: 'completed'}})
      session.append('turn/start', {turn})
      session.append('user/message', {id: 'u' + turn, role: 'user', content: [{type: 'text', text: 'x'}], source: {kind: 'user'}}, {surfaceOp: 'append'})
      if (close === 'error' || close === 'completed') session.append('turn/end', {turn, reason: {kind: close === 'error' ? 'error' : 'completed'}})
      return {events: session.snapshotEvents()}
    }
    assert.equal(latestFailureTarget(base, {turn}, build('none'))?.turn, turn, '生成中有真实基准即可签目标，执行端负责静止与纯尾预检')
    assert.equal(latestFailureTarget(base, {turn}, build('completed'))?.turn, turn, 'completed 不得作为资格白名单限制')
    const signed = latestFailureTarget(base, {turn}, build('error'))
    assert.equal(signed && signed.turn, turn, 'error 终态也可签统一清理目标')
    assert.equal(signed && signed.operationId, 'body')
    const oldFailure = {...base, timeline: {...base.timeline, operations: {...base.timeline.operations,
      old: {kind: 'body', turn: turn - 1, status: 'failed', businessBefore: {version: 1, fields: {}, messageCount: 0, participants: {}, operationIds: [], operationStates: {}}}}}}
    assert.equal(latestFailureTarget(oldFailure, {turn}, build('none'))?.turn, turn, '旧失败记录不得替代最新轮真实目标')
    const completedBody = {...base, timeline: {...base.timeline, operations: {body: {...base.timeline.operations.body, status: 'completed'}}}}
    assert.equal(latestFailureTarget(completedBody, {turn}, build('error'))?.turn, turn, 'body completed 不得作为资格白名单限制')
    // 真实 SQL 窄窗（chat-query-service.queryFailureCleanup 真读 archive_timeline_nodes）：running 与 failed 同为**候选**
    // （延迟 discard 读脚本失败会让整次 update 回滚、body 停在 running）；候选仍须经过 quiesce/CAS/完整基准等执行护栏。
    const authorDomain = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)
    const jsonMutation = await import(new URL('json-mutation.js', authorDomain).href)
    const treeModule = await import(new URL('copy-json-tree.js', authorDomain).href)
    const helpers = {copyJsonTree: treeModule.copyJsonTree ?? treeModule.default, diffJson: jsonMutation.diffJson, applyJsonChangesShared: jsonMutation.applyJsonChangesShared,
      projectSceneImageState: v => v, projectChatSessionState: v => v, projectDisplayRuntimeState: v => v, projectChatBackgroundConfig: v => v, projectSettlementCheckpoint: v => v}
    const store = createChatSqliteStore({dataRoot: root, helpers})
    const narrowBaseline = {version: 1, fields: {}, messageCount: 0, participants: {}, operationIds: [], operationStates: {}}
    const chatFor = status => ({id: 'narrow-chat', sessionId: 'narrow-session', _storageRevision: 1, mode: 'story', messages: [], variables: {}, macroState: {},
      timeline: {schemaVersion: 1, branchId: 'nb', revision: 1, checkpoints: [], participants: {}, operations: {body: {kind: 'body', turn, status, businessBefore: narrowBaseline}}}})
    const readNarrow = async status => {
      const now = await store.read('narrow-chat')
      const next = {...chatFor(status), _storageRevision: (Number.isSafeInteger(now?._storageRevision) ? now._storageRevision : 0) + 1}
      await store.update('narrow-chat', () => next)
      const narrowDb = new DatabaseSync(path.join(root, 'chats', 'narrow-chat', 'archive.db'), {readOnly: true})
      narrowDb.exec('PRAGMA query_only=ON')
      try { return queryFailureCleanup(narrowDb, {revision: next._storageRevision, timeline: next.timeline}) } finally { narrowDb.close() }
    }
    const running = await readNarrow('running')
    assert.equal(running.cleanable, true, 'SQL 窄窗：running 是候选（有发轮前基准），是否真可清由视图 failureEnding 门禁决定')
    assert.equal(running.turn, turn)
    assert.equal(running.operationId, 'body')
    const failedNarrow = await readNarrow('failed')
    assert.equal(failedNarrow.cleanable, true, 'SQL 窄窗：failed + 发轮前基准才 cleanable')
    assert.equal(failedNarrow.turn, turn)
    assert.equal(failedNarrow.operationId, 'body')
    store.dispose()
    // 三反例（本次修复的 affected 正确性）
    const { latestFailureCleanupReason } = failureHelpers(wired, deps)
    assert.equal(latestFailureCleanupReason(base, {turn}, build('none')), '', 'failed op 但 native 无 end ⇒ 说明必须为空')
    const wrongTurnEnd = (() => {
      const session = Session.create('active-wrong-turn')
      session.append('turn/start', {turn})
      session.append('user/message', {id: 'u' + turn, role: 'user', content: [{type: 'text', text: 'x'}], source: {kind: 'user'}}, {surfaceOp: 'append'})
      session.append('turn/end', {turn: turn - 1, reason: {kind: 'error'}})
      return {events: session.snapshotEvents()}
    })()
    assert.equal(latestFailureTarget(base, {turn}, wrongTurnEnd)?.turn, turn, '异轮 turn/end 不得成为终态白名单，仍按真实前像签最新轮')
    const runningBody = {...base, timeline: {...base.timeline, operations: {body: {...base.timeline.operations.body, status: 'running'}}}}
    assert.deepEqual(latestFailureTarget(runningBody, {turn}, build('error')),
      {chatId: 'active-chat', sessionId: 'active-session', turn, branchId: 'b1', revision: 5, operationId: 'body'},
      'native error + body running 是候选（延迟 discard 未跑完），必须给出确切目标')
    assert.equal(latestFailureTarget(runningBody, {turn}, build('none'))?.turn, turn, 'running/无 end 不得作为资格白名单限制')
    assert.equal(latestFailureTarget(runningBody, {turn}, build('completed'))?.turn, turn, 'running/completed 不得作为资格白名单限制')
    // 带 failureEnding、body 仍 `!== 'failed'` 的已施当前代（见上方 priorGeneration 断言）必须被升级成候选式并幂等：
    // 用本次真实变换产物精确还原旧行来模拟上一已施代（不是造替身），再 apply 必须等于新产物。
    const priorGeneration = wired.replace("if (!entry || !(entry[1].businessBefore || entry[1].rowBefore)) return null", "if (!entry || entry[1].status !== 'failed' || !(entry[1].businessBefore || entry[1].rowBefore)) return null")
    assert.notEqual(priorGeneration, wired, '模拟旧状态资格门必须真的改到那一处')
    assert.ok(priorGeneration.includes("entry[1].status !== 'failed'"), '模拟的上一已施代必须带旧 failed 判据')
    const upgradedPrior = applyLatestFailureViewTransform(priorGeneration)
    assert.equal(upgradedPrior, wired, '升级必须删除旧状态资格门，不能原样保留')
    assert.equal(applyLatestFailureViewTransform(upgradedPrior), upgradedPrior, '已施当前代升级必须幂等')
    // 真实 actual-044 源迁移：旧 marked helper 整段字面换成新 helper，再 apply 必须幂等
    const actual44 = activeSource(readFileSync(new URL('../../../tmp/repair-044-active-20261010/chat-session-state-188.js', import.meta.url), 'utf8'), VIEW_REL)
    assert.ok(actual44.includes('// [dsh-tavern-latest-failure-view:v1]'), 'actual-044 源必须带 view marker')
    const migratedOnce = applyLatestFailureViewTransform(actual44)
    assert.ok(migratedOnce.includes('function latestFailureTarget(chat, replayTarget, evidence) {'), '迁移后必须带统一 latestFailure helper')
    assert.equal(applyLatestFailureViewTransform(migratedOnce), migratedOnce, 'actual-044 迁移必须幂等')
  } finally { try { rmSync(root, {recursive: true, force: true, maxRetries: 6, retryDelay: 50}) } catch { /* 临时目录清理不影响断言证据 */ } }
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
