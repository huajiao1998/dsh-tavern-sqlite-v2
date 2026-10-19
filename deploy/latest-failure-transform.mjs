// 最新失败清理只接当前尾部的确切目标，不从旧失败挑选删除范围。
// native-only（terminal guard error，无 op/无基准）由后端 inspectNativeFailureTail 只读判定后签发的确切目标承担；
// 前端一律"最新优先"：native 末轮更晚（或同轮但无 body 操作）时必须先物理清它，不得把更旧的 body 目标当当前失败。
import { parse } from '../lib/vendor/acorn/acorn.mjs'
const HOST_MARKER = '// [dsh-tavern-latest-failure-host:v1]'
const VIEW_MARKER = '// [dsh-tavern-latest-failure-view:v1]'
// R1 冷普通回退证据：宿主 DI 用 **SDK 真 fold** 派生当前模型面 seq 列表（唯一权威仍是 events）。
// `sessionQuery.observeSession` 真身（SessionObservationReader.preparedLease/live）不公开 surface/nodes，
// 作者nodes是有序模型面，不能把按seq排序的current记录集合冒充顺序；直接消费SDK的真实fold.nodes。
const EVIDENCE_FOLD_LINE = "import { foldSurfaceForEvidence } from './domain/storage-failure-state.js'\n"
// 作者 2.5 `rollbackViewFields` 里**唯一一行**节点推导；冷档（无 session）改用证据节点，live 仍走 session.surface.nodes。
const AUTHOR_NODES_LINE = 'const nodes = session?.surface?.nodes\n'
const AUTHOR_NODES_NEXT = 'const nodes = session?.surface?.nodes ?? evidence.nodes\n'
// 上一代（marked）helper 的**完整字面**：迁移只认这个整段，逐字替换为新 helper；半截/未知形状由后续 required 检查抛错。
const LEGACY_HELPER = `function latestFailureTarget(chat, replayTarget, evidence) {
  // 窗口投影副本（session-window-projector:148）显式把 _storageRevision 置 undefined 以保作者窗口形状，
  // 该副本上可用的是同快照的 window.revision（windowRevision）。pin 必须二选一，不把 _storageRevision 塞回窗口副本。
  const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision
  const pending = chat.rollbackPending
  if (pending?.failureTarget) return { ...pending.failureTarget, chatId: chat.id, sessionId: chat.sessionId, rollbackId: pending.id }
  // native-only：只信真实 session events 的判定；无可信 events 回 null，绝不合成 operationId。
  const native = inspectNativeFailureTail(chat, evidence, revision)
  if (native && native.target) return native.target
  const narrow = chat.failureCleanup
  const narrowTurn = narrow && Number.isSafeInteger(Number(narrow.turn)) ? Number(narrow.turn) : null
  const replayTurn = Number.isSafeInteger(Number(replayTarget?.turn)) ? Number(replayTarget.turn) : null
  if (native && Number.isSafeInteger(native.turn)) {
    const known = [narrowTurn, replayTurn].filter(value => value !== null)
    const newestKnown = known.length > 0 ? Math.max(...known) : 0
    const terminalHasBody = Object.values(chat.timeline?.operations || {}).some(op => op?.kind === 'body' && Number(op.turn) === native.turn)
    // native 末轮与任何 body 候选（窄摘要/replay）不是同一轮 ⇒ 不得给出该 body 目标：
    // 既不许把更旧的失败（如 native 已是 42/成功 41，timeline 里还留着历史 failed 20）当"当前失败"，也不许越过 native 末轮。
    if (known.some(turn => turn !== native.turn)) return null
    // 同一轮但该轮根本没有 body 操作（native-only，如 43）⇒ 必须先物理清 native 失败，再谈下一轮 body。
    if (!terminalHasBody && native.turn >= newestKnown) return null
  }
  if (narrow && narrow.cleanable === true && Number.isSafeInteger(revision) && Number.isSafeInteger(Number(narrow.revision)) && Number(narrow.revision) === Number(revision)
    && narrowTurn !== null && narrowTurn >= 1 && (narrow.operationId === undefined || narrow.operationId)) {
    return { chatId: chat.id, sessionId: chat.sessionId, turn: narrowTurn, branchId: narrow.branchId, revision: Number(narrow.revision), operationId: narrow.operationId }
  }
  // 冷视图（作者 nodes 无 session ⇒ replayTarget 为 null）只允许用**可信 native 尾轮号**去选 body；
  // 其后仍是同一套严格检查：该轮 body 操作存在、未完成、有基准，且尾部无后继正文/检查点/操作。
  const turn = replayTurn !== null ? replayTurn : (native && Number.isSafeInteger(native.turn) ? native.turn : null)
  if (turn === null || turn < 1 || !Number.isSafeInteger(revision) || !chat.timeline?.branchId) return null
  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)
  if (!entry || !(entry[1].businessBefore || entry[1].rowBefore)) return null
  if ((chat.timeline.checkpoints || []).some(cp => Number(cp.turn) >= turn)) return null
  if ((chat.messages || []).some(row => Number(row.turn) > turn)) return null
  if (Object.values(chat.timeline.operations || {}).some(op => Number(op?.turn) > turn)) return null
  return { chatId: chat.id, sessionId: chat.sessionId, turn, branchId: chat.timeline.branchId, revision, operationId: entry[0] }
}
function latestFailureCleanupReason(chat, replayTarget, evidence) {
  const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision
  const native = inspectNativeFailureTail(chat, evidence, revision)
  // native 挡住了更旧 body 目标时优先报 native 的真实原因（只有确实没有可清理目标才给说明）。
  if (native && !native.target && Number.isSafeInteger(native.turn) && typeof native.reason === 'string' && native.reason !== ''
    && !latestFailureTarget(chat, replayTarget, evidence)) return native.reason
  const narrow = chat.failureCleanup
  if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason
  if (replayTarget && !latestFailureTarget(chat, replayTarget, evidence)) return '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理'
  return ''
}
`
// owned storage-rollback 垫片转出（整层区块的卸载由 comment 引擎处理）。
const IMPORT_LINE = "import { inspectNativeFailureTail } from './storage-rollback.js'\n"
// 冷视图失败证据接线：index.js 里 sessionDebugEvidence 只查已装载注册表，冷档 events 为空 ⇒ 必须经宿主只读观察口补证据。
const EVIDENCE_IMPORT = "import { readFailureEvidence as readFailureEvidenceFromQuery } from './domain/storage-rollback.js'\n"
const EVIDENCE_ANCHOR = '  function sessionDebugEvidence(sessionId, includeSession = false) {'
const EVIDENCE_CALL_BEFORE = 'const rollbackEvidence = sessionDebugEvidence(chat.sessionId, true)'
const EVIDENCE_CALL_AFTER_LEGACY = 'const rollbackEvidence = await readFailureEvidence(chat.sessionId)'
// 证据读口同步传 chat.id：后台结算作业按 chatId 归属，缺它无法证明"该档后台已停"。
const EVIDENCE_CALL_AFTER = 'const rollbackEvidence = { ...await readFailureEvidence(chat.sessionId, chat.id), activity }'
// 证据读口方法体**只含函数**（不夹 import；折叠导入由最终 return 一次性前置到顶层）。
const EVIDENCE_METHOD_LEGACY = "async function readFailureEvidence(sessionId) { return await readFailureEvidenceFromQuery(sessionDebugEvidence(sessionId, true), ctx.get('sessionQuery'), sessionId) }"
const EVIDENCE_METHOD_V1 = "async function readFailureEvidence(sessionId) { return await readFailureEvidenceFromQuery(sessionDebugEvidence(sessionId, true), ctx.get('sessionQuery'), sessionId, (_id, events) => typeof sessionPatch?.surfaceNodes === 'function' ? sessionPatch.surfaceNodes(events) : foldSurfaceForEvidence(events).nodes) }"
// v2：新增可选 chatId 与**前后台静止证明**（同闭包真实 API：agentRegistry / foregroundHandoff.isBusy / settlementJobs.isBusy）。
// 只有前台 agent 不在 running、且该 chat 无在跑的交接/结算作业，才算 idle；证据里同时带上活动快照（调用方可再据此守）。
const EVIDENCE_METHOD = "async function readFailureEvidence(sessionId, chatId) { if (typeof foregroundHandoff?.isBusy !== 'function' || typeof settlementJobs?.isBusy !== 'function' || typeof chatId !== 'string' || !chatId) throw new Error('失败清理缺少前后台运行器静止接线'); const evidence = await readFailureEvidenceFromQuery(sessionDebugEvidence(sessionId, true), ctx.get('sessionQuery'), sessionId, (_id, events) => typeof sessionPatch?.surfaceNodes === 'function' ? sessionPatch.surfaceNodes(events) : foldSurfaceForEvidence(events).nodes); const foregroundActive = agentRegistry.get(sessionId)?.phase?.kind === 'running' || foregroundHandoff.isBusy(sessionId) === true; const backgroundActive = settlementJobs.isBusy(chatId) === true; return { ...evidence, foregroundActive, backgroundActive, cleanupIdle: foregroundActive !== true && backgroundActive !== true } }"
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('最新失败接缝锚点缺失/不唯一：' + before.slice(0, 90))
  return source.replace(before, after)
}
// 缓存/脏消息路径同样必须异步取得运行器证明；不能用默认sessionDebugEvidence覆盖首次目标。
function upgradeVolatileEvidenceHost(source) {
  const marker='// [dsh-tavern-failure-volatile-evidence:v1]'
  const calls=[
    ['volatileSessionViewFields(chat, activity, {baseRevision:chat._storageRevision,indices:[],layoutChanged:false})','await volatileSessionViewFields(chat, activity, {baseRevision:chat._storageRevision,indices:[],layoutChanged:false})'],
    ['volatileSessionViewFields(chat, activity, changes), {','await volatileSessionViewFields(chat, activity, changes), {']
  ]
  if(source.includes(marker)) {
    if(source.split(marker).length!==2 || !source.includes('async function volatileSessionViewFields(chat, activity, changes)') || !source.includes('sessionStateView.volatile(chat, activity, changes, evidence)') || calls.some(([,next])=>!source.includes(next)))throw new Error('易变视图失败证据接线不完整')
    return source
  }
  source=once(source,'function volatileSessionViewFields(chat, activity, changes) {','async function volatileSessionViewFields(chat, activity, changes) {\n    '+marker+'\n    const evidence = { ...await readFailureEvidence(chat.sessionId, chat.id), activity }')
  source=once(source,'sessionStateView.volatile(chat, activity, changes)','sessionStateView.volatile(chat, activity, changes, evidence)')
  for(const [before,after] of calls)source=once(source,before,after)
  return source
}
function addIdleSignals(source) {
  const runners=['runSettlementCycle','runSettlement'].filter(run=>source.includes('createSettlementJobs({ run: '+run+', onSettled: onSettlementSettled'))
  if(runners.length!==1)throw Error('结算静止入口缺失/不唯一')
  const run=runners[0]
  const old='const settlementJobs = createSettlementJobs({ run: '+run+', onSettled: onSettlementSettled })'
  const next='const settlementJobs = createSettlementJobs({ run: '+run+", onSettled: onSettlementSettled, onIdle: chatId => { void taskStateReader.read(chatId).then(chat => { if (chat) sessionSignals.publish(chat.sessionId, {kind:'tavern-state',version:'cleanup-idle:' + Date.now()}) }).catch(error => console.warn('dsh-tavern: 结算静止通知失败', error)) } })"
  if(!source.includes(next))source=once(source,old,next)
  if(source.includes('  const pluginTaskJobs = new Map()')) {
    const oldBusy='const backgroundActive = settlementJobs.isBusy(chatId) === true;'
    const newBusy='const backgroundActive = settlementJobs.isBusy(chatId) === true || pluginTaskJobs.has(chatId);'
    if(!source.includes(newBusy))source=once(source,oldBusy,newBusy)
  }
  const anchor='    turns: turnOrchestrator,',withIdle=anchor+"\n    onIdle: sessionId => sessionSignals.publish(sessionId, {kind:'tavern-state',version:'cleanup-idle:' + Date.now()}),"
  if(!source.includes(withIdle))source=once(source,anchor,withIdle)
  return upgradeVolatileEvidenceHost(source)
}
export function applyLatestFailureHostTransform(source) {
  // 先清理最新轮，再纯修复；不能在删尾前补记或认证待清理的原生对象。
  source=source.replace("      case 'rollbackTurn': {\n        await reconcileStory(args && args.sessionId)","      case 'rollbackTurn': {\n        // [dsh-tavern-native-repair-after-cut:v1] 作者纯修复由物理清理完成后调用。")
  // 双形态严格唯一：新版上游（42852b0/2.5.0）rollbackTurn 为多行块（save/回执后自带 notifyPluginTimeline('rollback')），旧版为单行 return。
  const before = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn) }"
  const after = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && (args.failureTarget || args.expectedTurn)) }"
  const beforeNew = "        const view = await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn)"
  const afterNew = "        const view = await rollbackTurn(args && args.sessionId, args && args.chatId, args && (args.failureTarget || args.expectedTurn))"
  if (source.includes(HOST_MARKER)) {
    if (source.split(HOST_MARKER).length !== 2 || !(source.includes(after) || source.includes(afterNew)) || !source.includes(EVIDENCE_IMPORT)
      || !(source.includes(EVIDENCE_CALL_AFTER) || source.includes(EVIDENCE_CALL_AFTER_LEGACY))) throw new Error('最新失败宿主接线不完整')
    // 已 marked 的旧代证据读口（无真 fold 推导/无静止证明）必须**可升级**，不能只判"不完整"就拒。
    if ((source.includes(EVIDENCE_METHOD) || source.includes(EVIDENCE_METHOD.replace('const backgroundActive = settlementJobs.isBusy(chatId) === true;', 'const backgroundActive = settlementJobs.isBusy(chatId) === true || pluginTaskJobs.has(chatId);'))) && source.includes(EVIDENCE_FOLD_LINE)) return addIdleSignals(source)
    if (source.includes(EVIDENCE_METHOD_V1)) {
      const upgradedV1 = once(source, EVIDENCE_METHOD_V1, EVIDENCE_METHOD)
      return addIdleSignals(once(upgradedV1, EVIDENCE_CALL_AFTER_LEGACY, EVIDENCE_CALL_AFTER))
    }
    const prior=EVIDENCE_METHOD_LEGACY
    if (!source.includes(prior)) throw new Error('最新失败宿主证据读口缺失/未知形状')
    // 升级：完整旧读口只替换一次，折叠导入只补一次且留在顶层。
    const upgraded = once(source, prior, EVIDENCE_METHOD)
    const withCall=upgraded.includes(EVIDENCE_CALL_AFTER_LEGACY)?once(upgraded, EVIDENCE_CALL_AFTER_LEGACY, EVIDENCE_CALL_AFTER):upgraded
    return addIdleSignals(withCall.includes(EVIDENCE_FOLD_LINE) ? withCall : once(withCall, EVIDENCE_IMPORT, EVIDENCE_IMPORT + EVIDENCE_FOLD_LINE))
  }
  const hasNew = source.split(beforeNew).length === 2
  const hasLegacy = source.split(before).length === 2
  if (hasNew === hasLegacy) throw new Error('最新失败接缝锚点缺失/不唯一：' + before.slice(0, 90))
  let next = HOST_MARKER + '\n' + (hasNew ? source.replace(beforeNew, afterNew) : source.replace(before, after))
  next = once(next, EVIDENCE_CALL_BEFORE, EVIDENCE_CALL_AFTER)
  next = once(next, EVIDENCE_ANCHOR, '  ' + EVIDENCE_METHOD + '\n' + EVIDENCE_ANCHOR)
  // 折叠导入**只此一处**前置到顶层（与证据导入相邻），不插进任何函数体。
  return addIdleSignals(EVIDENCE_IMPORT + EVIDENCE_FOLD_LINE + next)
}
export function applyLatestFailureViewTransform(source) {
  // 作者自愈版的其他操作状态由作者管理；回退由最后一层统一最新轮视图接管。
  if(source.includes('const hasRound = hasRollbackMessages(chat.messages)') || source.includes('// [dsh-tavern-native-repair-rollback-view:v1]'))return source
  if(source.includes('// [dsh-tavern-latest-send-undo:v1]') && source.includes('void replayTarget')) {
    // 已统一代不再复活旧分类器；仍验证唯一自有helper/字段与原生判定导入，半截块拒绝。
    const funcs=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.filter(node=>node.type==='FunctionDeclaration')
    if(source.split(VIEW_MARKER).length!==2 || ['latestFailureTarget','latestFailureCleanupReason'].some(name=>funcs.filter(node=>node.id?.name===name).length!==1)
      || !source.includes("import { inspectNativeFailureTail } from './storage-rollback.js'")
      || !source.includes('canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,'))throw new Error('统一撤销兼容视图接线不完整')
    return source
  }
  const fields = `      failureTarget: latestFailureTarget(chat, replayTarget, evidence),
      failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),`
  const helper = `function latestFailureTarget(chat, replayTarget, evidence) {
  // 前后台静止门（用户合同）：前台 agent/交接或该档结算作业仍在跑时不签任何清理目标。
  // cleanupIdle 由宿主证据读口按同闭包真实 API 签发；activity 由 view 传入（pending 的 durable 结算即使 busy=false 也不得提前弹）。
  if (!evidence || evidence.cleanupIdle !== true) return null
  if (evidence && (evidence.foregroundActive === true || evidence.backgroundActive === true)) return null
  if (evidence && evidence.activity && (evidence.activity.busy === true || evidence.activity.phase === 'pending' || evidence.activity.phase === 'running')) return null
  // 撤销资格不按终态、输出形态或正文/变量形态分类：只要身份、版本、尾部和真实发轮前基准成立，就签统一清理目标。
  // active/无 end 仍必须先满足 cleanupIdle；执行端随后会取消并等待静止，再做纯尾预检，避免卡死或误删。
  // 窗口投影副本（session-window-projector:148）显式把 _storageRevision 置 undefined 以保作者窗口形状，
  // 该副本上可用的是同快照的 window.revision（windowRevision）。pin 必须二选一，不把 _storageRevision 塞回窗口副本。
  const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision
  const pending = chat.rollbackPending
  if (pending?.failureTarget) return { ...pending.failureTarget, chatId: chat.id, sessionId: chat.sessionId, rollbackId: pending.id }
  // native-only：只信真实 session events 的判定；无可信 events 回 null，绝不合成 operationId。
  const native = inspectNativeFailureTail(chat, evidence, revision)
  if (native && native.target) return native.target
  const narrow = chat.failureCleanup
  const narrowTurn = narrow && Number.isSafeInteger(Number(narrow.turn)) ? Number(narrow.turn) : null
  const replayTurn = Number.isSafeInteger(Number(replayTarget?.turn)) ? Number(replayTarget.turn) : null
  if (native && Number.isSafeInteger(native.turn)) {
    const known = [narrowTurn, replayTurn].filter(value => value !== null)
    const newestKnown = known.length > 0 ? Math.max(...known) : 0
    const terminalHasBody = Object.values(chat.timeline?.operations || {}).some(op => op?.kind === 'body' && Number(op.turn) === native.turn)
    // native 末轮与任何 body 候选（窄摘要/replay）不是同一轮 ⇒ 不得给出该 body 目标：
    // 既不许把更旧的失败（如 native 已是 42/成功 41，timeline 里还留着历史 failed 20）当"当前失败"，也不许越过 native 末轮。
    if (known.some(turn => turn !== native.turn)) return null
    // 同一轮但该轮根本没有 body 操作（native-only，如 43）⇒ 必须先物理清 native 失败，再谈下一轮 body。
    if (!terminalHasBody && native.turn >= newestKnown) return null
  }
  if (narrow && narrow.cleanable === true
    && Number.isSafeInteger(revision) && Number.isSafeInteger(Number(narrow.revision)) && Number(narrow.revision) === Number(revision)
    && narrowTurn !== null && narrowTurn >= 1 && (narrow.operationId === undefined || narrow.operationId)) {
    return { chatId: chat.id, sessionId: chat.sessionId, turn: narrowTurn, branchId: narrow.branchId, revision: Number(narrow.revision), operationId: narrow.operationId }
  }
  // 冷视图（作者 nodes 无 session ⇒ replayTarget 为 null）只允许用**可信 native 尾轮号**去选 body；
  // 其后仍是同一套严格检查：该轮 body 操作存在、未完成、有基准，且尾部无后继正文/检查点/操作。
  const turn = replayTurn !== null ? replayTurn : (native && Number.isSafeInteger(native.turn) ? native.turn : null)
  if (turn === null || turn < 1 || !Number.isSafeInteger(revision) || !chat.timeline?.branchId) return null
  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)
  if (!entry || !(entry[1].businessBefore || entry[1].rowBefore)) return null
  if ((chat.timeline.checkpoints || []).some(cp => Number(cp.turn) >= turn)) return null
  if ((chat.messages || []).some(row => Number(row.turn) > turn)) return null
  if (Object.values(chat.timeline.operations || {}).some(op => Number(op?.turn) > turn)) return null
  return { chatId: chat.id, sessionId: chat.sessionId, turn, branchId: chat.timeline.branchId, revision, operationId: entry[0] }
}
function latestFailureCleanupReason(chat, replayTarget, evidence) {
  const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision
  // 仅用于说明与记录生命周期，不参与目标资格；目标资格由真实前像与物理安全护栏决定。

  if (!evidence || evidence.cleanupIdle !== true || evidence.foregroundActive || evidence.backgroundActive || evidence.activity?.busy || ['pending','running'].includes(evidence.activity?.phase)) return ''
  const native = inspectNativeFailureTail(chat, evidence, revision)
  if (native?.incomplete || native?.target?.incomplete) return native.reason
  // ending 只用于诊断，不作为撤销资格白名单。
  // native 挡住了更旧 body 目标时优先报 native 的真实原因（只有确实没有可清理目标才给说明）。
  if (native && !native.target && Number.isSafeInteger(native.turn) && typeof native.reason === 'string' && native.reason !== ''
    && !latestFailureTarget(chat, replayTarget, evidence)) return native.reason
  const narrow = chat.failureCleanup
  if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason
  if (replayTarget && !latestFailureTarget(chat, replayTarget, evidence)) return '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理'
  return ''
}
`
  const cacheHitTarget = 'latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence)'
  const cacheHitReason = 'latestFailureCleanupReason(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence)'
  const cacheHitReturn = 'return {...copyRollback(previous.value),failureTarget: ' + cacheHitTarget + ',failureCleanupReason: ' + cacheHitReason + ',undoRollbackTurn:'
  if (source.includes(VIEW_MARKER)) {
    // 旧代 marked 源（已证 shape）：按**完整字面** LEGACY_HELPER 整段替换为新 helper；半截/未知由后续 required 检查抛错。
    if (source.includes(LEGACY_HELPER)) source = once(source, LEGACY_HELPER, helper)
    // 已施完整兼容 helper 统一替换为本代，不允许遗留状态/终态资格门。
    const functions=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.filter(node=>node.type==='FunctionDeclaration' && ['latestFailureTarget','latestFailureCleanupReason'].includes(node.id?.name))
    if(functions.length!==2 || new Set(functions.map(node=>node.id.name)).size!==2)throw Error('最新失败兼容helper缺失或不唯一')
    const replacements=parse(helper,{ecmaVersion:'latest',sourceType:'module'}).body
    for(const node of functions.toReversed()) {
      const replacement=replacements.find(value=>value.id?.name===node.id.name)
      source=source.slice(0,node.start)+helper.slice(replacement.start,replacement.end)+source.slice(node.end)
    }
    // R1：作者节点推导改走证据节点（冷档 evidence.nodes / live 仍 session.surface.nodes）；已升级则原样。
    source = upgradeAuthorNodesLine(source)
    // 清理目标可独立于普通回退surface；菜单必须同样可用，目标轮号来自同一签名。
    source=upgradeIncompleteAvailability(source)
    // 旧 marked 视图只按完整 helper 迁移；不再引入终态生命周期分类或原因白名单。
    source = upgradeLatestFailureHelper(source, helper)
    const required = [IMPORT_LINE,
      'function latestFailureTarget(chat, replayTarget, evidence) {',
      'function latestFailureCleanupReason(chat, replayTarget, evidence) {',
      'failureTarget: latestFailureTarget(chat, replayTarget, evidence),',
      'failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),',
      'const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision',
      'canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,',
      'failureTarget: latestFailureTarget(chat, replayTarget, evidence),',
      'failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),',
      cacheHitReturn.slice(cacheHitReturn.indexOf('failureTarget: '))]
     if (source.includes('canRollback: rollbackState.canRollback,')) source = once(source, 'canRollback: rollbackState.canRollback,', 'canRollback: rollbackState.canRollback || latestFailureTarget(chat, replayTarget, evidence) !== null,')

    if (source.split(VIEW_MARKER).length !== 2 || required.some(block => !source.includes(block))) throw new Error('最新失败视图接线不完整')
    return source
  }
  let next = IMPORT_LINE + VIEW_MARKER + '\n' + helper + source
  next = once(next, '      canReplayFailedTurn: replayTarget !== null,', fields + '\n      canReplayFailedTurn: replayTarget !== null,')
  next = once(next, '      canClearIncompleteReply: rollbackState.canClearIncompleteReply,', '      canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,')
  // 半提交只允许完成同一清理；不能从已经截断的正文重新选择目标。
  next = once(next, '      undoRollbackTurn: canUndoRollback(chat, evidence.session) ? chat.rollbackUndo.turn : null,\n      rollbackUnavailableReason: rollbackState.reason', '      failureTarget: latestFailureTarget(chat, replayTarget, evidence),\n      failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),\n      undoRollbackTurn: canUndoRollback(chat, evidence.session) ? chat.rollbackUndo.turn : null,\n      rollbackUnavailableReason: rollbackState.reason')
  next = once(next, 'canRollback: true, canClearIncompleteReply: false,', 'canRollback: true, canClearIncompleteReply: !!chat.rollbackPending.failureTarget,')
  // 命中旧rollback缓存也必须重签发当前revision与原因（旧凭据不得续用，说明也不许停在旧视图）。
  next = once(next, 'return {...copyRollback(previous.value),undoRollbackTurn:', cacheHitReturn)
  next = upgradeAuthorNodesLine(next)
  return upgradeIncompleteAvailability(next)
}
function upgradeIncompleteAvailability(source) {
  const stateMarker='// [dsh-tavern-failure-state-input:v1]'
  if(!source.includes(stateMarker)) {
    source=once(source,'  function volatileSessionViewFields(chat, activity, changes) {','  '+stateMarker+'\n  function volatileSessionViewFields(chat, activity, changes, evidence) {')
    source=once(source,'const rollback = rollbackViewFields(chat,undefined,changes)','const rollback = rollbackViewFields(chat,evidence,changes)')
    const messageHead="export function projectSessionMessage(message) {\n  if (!message || typeof message !== 'object') return message\n  return {\n    role: message.role, turn: message.turn, greeting: message.greeting,"
    source=once(source,messageHead,messageHead+'\n    // 只携带已保存编辑的精确校验输入，普通楼不读取正文/变量/显示载荷。\n    ...(message.bodyEdit ? {bodyEdit:{id:message.bodyEdit.id,turn:message.bodyEdit.turn},text:message.text} : {}),')
    const key="'regeneratedDshTurns', 'tavernHelperLifecycleRevision'])"
    source=once(source,key,"'regeneratedDshTurns', 'tavernHelperLifecycleRevision', 'runtimeInputs', 'foregroundFrames', 'nativeCommits', 'pendingCardChanges', 'compatibilityTraces', 'historyRecallCooldowns', 'worldBookReads', 'rollbackSessionCuts', 'foregroundError', 'promptTemplateInput', 'promptTemplateInitialVariables', 'lastSettle', 'lastWorldBookRecall', 'preparedWorldBook', 'worldBookRandomState'])")
  } else if(source.split(stateMarker).length!==2 || !source.includes('function volatileSessionViewFields(chat, activity, changes, evidence)') || !source.includes('rollbackViewFields(chat,evidence,changes)') || !source.includes('bodyEdit:{id:message.bodyEdit.id,turn:message.bodyEdit.turn}'))throw new Error('清理只读状态投影接线不完整')
  const staleCache='canRollback: previous.value.canRollback || latestFailureTarget'
  if(source.includes(staleCache))source=once(source,staleCache,'canRollback: (previous.value.canRollback && !previous.value.canClearIncompleteReply) || latestFailureTarget')
  const staleTurn='?.turn ?? previous.value.rollbackTargetTurn'
  if(source.includes(staleTurn))source=once(source,staleTurn,'?.turn ?? settlementTurn(chat)')
  const replacements=[
    ['      canRollback: rollbackState.canRollback,','      canRollback: rollbackState.canRollback || latestFailureTarget(chat, replayTarget, evidence) !== null,'],
    ['      rollbackTargetTurn: settlementTurn(chat),','      rollbackTargetTurn: latestFailureTarget(chat, replayTarget, evidence)?.turn ?? settlementTurn(chat),'],
    ['return {...copyRollback(previous.value),failureTarget:', 'return {...copyRollback(previous.value),canRollback: (previous.value.canRollback && !previous.value.canClearIncompleteReply) || latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence) !== null,canClearIncompleteReply: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence) !== null,rollbackTargetTurn: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence)?.turn ?? settlementTurn(chat),failureTarget:']
  ]
  for(const [old,next] of replacements)if(!source.includes(next))source=once(source,old,next)
  return source
}

/** R1：作者 `rollbackViewFields` 的节点推导行 → 冷档回退证据节点。全文件必须**恰一行**，否则拒绝猜测施缝。 */
function upgradeLatestFailureHelper(source, helper) {
  if (source.includes('evidence.cleanupIdle !== true')) return source // 已升级（幂等）
  const hits = source.split(LEGACY_HELPER).length - 1
  if (hits === 0) return source // 形状未知：交给 required 块检查响亮拒绝，不在这里猜
  if (hits !== 1) throw new Error('最新失败 helper 旧块不唯一：' + hits)
  return source.replace(LEGACY_HELPER, helper)
}
function upgradeAuthorNodesLine(source) {
  const hits = source.split(AUTHOR_NODES_LINE).length - 1
  const upgraded = source.split(AUTHOR_NODES_NEXT).length - 1
  if (hits === 0 && upgraded === 1) return source // 已升级（幂等）
  if (hits !== 1 || upgraded !== 0) throw new Error('作者节点推导行缺失/重复（命中 ' + hits + '，已升级 ' + upgraded + '）—拒绝猜测施缝')
  return source.replace(AUTHOR_NODES_LINE, AUTHOR_NODES_NEXT)
}
