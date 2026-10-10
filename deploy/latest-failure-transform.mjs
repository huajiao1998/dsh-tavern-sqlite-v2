// 最新失败清理只接当前尾部的确切目标，不从旧失败挑选删除范围。
// native-only（terminal guard error，无 op/无基准）由后端 inspectNativeFailureTail 只读判定后签发的确切目标承担；
// 前端一律"最新优先"：native 末轮更晚（或同轮但无 body 操作）时必须先物理清它，不得把更旧的 body 目标当当前失败。
const HOST_MARKER = '// [dsh-tavern-latest-failure-host:v1]'
const VIEW_MARKER = '// [dsh-tavern-latest-failure-view:v1]'
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
    && narrowTurn !== null && narrowTurn >= 1 && narrow.operationId) {
    return { chatId: chat.id, sessionId: chat.sessionId, turn: narrowTurn, branchId: narrow.branchId, revision: Number(narrow.revision), operationId: narrow.operationId }
  }
  // 冷视图（作者 nodes 无 session ⇒ replayTarget 为 null）只允许用**可信 native 尾轮号**去选 body；
  // 其后仍是同一套严格检查：该轮 body 操作存在、未完成、有基准，且尾部无后继正文/检查点/操作。
  const turn = replayTurn !== null ? replayTurn : (native && Number.isSafeInteger(native.turn) ? native.turn : null)
  if (turn === null || turn < 1 || !Number.isSafeInteger(revision) || !chat.timeline?.branchId) return null
  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)
  if (!entry || entry[1].status === 'completed' || !(entry[1].businessBefore || entry[1].rowBefore)) return null
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
const EVIDENCE_CALL_AFTER = 'const rollbackEvidence = await readFailureEvidence(chat.sessionId)'
const EVIDENCE_METHOD = "async function readFailureEvidence(sessionId) { return await readFailureEvidenceFromQuery(sessionDebugEvidence(sessionId, true), ctx.get('sessionQuery'), sessionId) }"
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('最新失败接缝锚点缺失/不唯一：' + before.slice(0, 90))
  return source.replace(before, after)
}
export function applyLatestFailureHostTransform(source) {
  const before = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn) }"
  const after = "case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && (args.failureTarget || args.expectedTurn)) }"
  if (source.includes(HOST_MARKER)) {
    if (source.split(HOST_MARKER).length !== 2 || !source.includes(after) || !source.includes(EVIDENCE_IMPORT)
      || !source.includes(EVIDENCE_METHOD) || !source.includes(EVIDENCE_CALL_AFTER)) throw new Error('最新失败宿主接线不完整')
    return source
  }
  let next = HOST_MARKER + '\n' + once(source, before, after)
  next = once(next, EVIDENCE_CALL_BEFORE, EVIDENCE_CALL_AFTER)
  next = once(next, EVIDENCE_ANCHOR, '  ' + EVIDENCE_METHOD + '\n' + EVIDENCE_ANCHOR)
  return EVIDENCE_IMPORT + next
}
export function applyLatestFailureViewTransform(source) {
  const fields = `      failureTarget: latestFailureTarget(chat, replayTarget, evidence),
      failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),`
  const helper = `function latestFailureTarget(chat, replayTarget, evidence) {
  // 终止失败生命周期（当前已证最小必要合同）：只有"最新 turn/start 之后同轮出现 turn/end 且 reason 为 error/aborted"才允许签**新 body 目标**；
  // 仍 active（无 end）或 end completed 一律不签——停止中的轮没有明确失败生命周期，不提示清理是安全的。
  const failureEnding = (source) => {
    const list = source && Array.isArray(source.events) ? source.events
      : (source && source.session && typeof source.session.snapshotEvents === 'function' ? source.session.snapshotEvents()
        : (source && Array.isArray(source.session && source.session.events) ? source.session.events : null))
    if (!list || list.length === 0) return 'none'
    let start = -1
    for (let index = list.length - 1; index >= 0; index -= 1) if (list[index] && list[index].type === 'turn/start') { start = index; break }
    if (start < 0) return 'none'
    for (let index = start + 1; index < list.length; index += 1) {
      const event = list[index]
      if (event && event.type === 'turn/end' && Number(event.data && event.data.turn) === Number(list[start].data && list[start].data.turn)) {
        const kind = event.data && event.data.reason ? event.data.reason.kind : null
        return kind === 'error' || kind === 'aborted' ? kind : 'completed'
      }
    }
    return 'active'
  }
  const ending = failureEnding(evidence)
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
  if (narrow && narrow.cleanable === true && (ending === 'error' || ending === 'aborted')
    && Number.isSafeInteger(revision) && Number.isSafeInteger(Number(narrow.revision)) && Number(narrow.revision) === Number(revision)
    && narrowTurn !== null && narrowTurn >= 1 && narrow.operationId) {
    return { chatId: chat.id, sessionId: chat.sessionId, turn: narrowTurn, branchId: narrow.branchId, revision: Number(narrow.revision), operationId: narrow.operationId }
  }
  // 冷视图（作者 nodes 无 session ⇒ replayTarget 为 null）只允许用**可信 native 尾轮号**去选 body；
  // 其后仍是同一套严格检查：该轮 body 操作存在、未完成、有基准，且尾部无后继正文/检查点/操作。
  const turn = replayTurn !== null ? replayTurn : (native && Number.isSafeInteger(native.turn) ? native.turn : null)
  if (turn === null || turn < 1 || !Number.isSafeInteger(revision) || !chat.timeline?.branchId) return null
  if (ending !== 'error' && ending !== 'aborted') return null // 新 body 目标只认终止失败生命周期（active/无 end/completed 都不得签）
  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)
  if (!entry || entry[1].status !== 'failed' || !(entry[1].businessBefore || entry[1].rowBefore)) return null
  if ((chat.timeline.checkpoints || []).some(cp => Number(cp.turn) >= turn)) return null
  if ((chat.messages || []).some(row => Number(row.turn) > turn)) return null
  if (Object.values(chat.timeline.operations || {}).some(op => Number(op?.turn) > turn)) return null
  return { chatId: chat.id, sessionId: chat.sessionId, turn, branchId: chat.timeline.branchId, revision, operationId: entry[0] }
}
function latestFailureCleanupReason(chat, replayTarget, evidence) {
  const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision
  const failureEnding = (source) => {
    const list = source && Array.isArray(source.events) ? source.events
      : (source && source.session && typeof source.session.snapshotEvents === 'function' ? source.session.snapshotEvents()
        : (source && Array.isArray(source.session && source.session.events) ? source.session.events : null))
    if (!list || list.length === 0) return 'none'
    let start = -1
    for (let index = list.length - 1; index >= 0; index -= 1) if (list[index] && list[index].type === 'turn/start') { start = index; break }
    if (start < 0) return 'none'
    for (let index = start + 1; index < list.length; index += 1) {
      const event = list[index]
      if (event && event.type === 'turn/end' && Number(event.data && event.data.turn) === Number(list[start].data && list[start].data.turn)) {
        const kind = event.data && event.data.reason ? event.data.reason.kind : null
        return kind === 'error' || kind === 'aborted' ? kind : 'completed'
      }
    }
    return 'active'
  }
  const ending = failureEnding(evidence)
  // 活动/成功/无轮先截断说明（pending-retry 说明仍优先）：不让 native inspector 对 running body 的“须清理”文案漏出
  if ((ending === 'active' || ending === 'completed' || ending === 'none') && !(chat.rollbackPending && chat.rollbackPending.failureTarget)) return ''
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
  const cacheHitTarget = 'latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence)'
  const cacheHitReason = 'latestFailureCleanupReason(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence)'
  const cacheHitReturn = 'return {...copyRollback(previous.value),failureTarget: ' + cacheHitTarget + ',failureCleanupReason: ' + cacheHitReason + ',undoRollbackTurn:'
  if (source.includes(VIEW_MARKER)) {
    // 旧代 marked 源（已证 shape）：按**完整字面** LEGACY_HELPER 整段替换为新 helper；半截/未知由后续 required 检查抛错。
    if (source.includes(LEGACY_HELPER)) source = once(source, LEGACY_HELPER, helper)
    if (!source.includes('const failureEnding = (source) => {')) {
      const ENDING = `  const failureEnding = (source) => {
    const list = source && Array.isArray(source.events) ? source.events
      : (source && source.session && typeof source.session.snapshotEvents === 'function' ? source.session.snapshotEvents()
        : (source && Array.isArray(source.session && source.session.events) ? source.session.events : null))
    if (!list || list.length === 0) return 'none'
    let start = -1
    for (let index = list.length - 1; index >= 0; index -= 1) if (list[index] && list[index].type === 'turn/start') { start = index; break }
    if (start < 0) return 'none'
    for (let index = start + 1; index < list.length; index += 1) {
      const event = list[index]
      if (event && event.type === 'turn/end' && Number(event.data && event.data.turn) === Number(list[start].data && list[start].data.turn)) {
        const kind = event.data && event.data.reason ? event.data.reason.kind : null
        return kind === 'error' || kind === 'aborted' ? kind : 'completed'
      }
    }
    return 'active'
  }
  const ending = failureEnding(evidence)
`
      let up = once(source, 'function latestFailureTarget(chat, replayTarget, evidence) {\n', 'function latestFailureTarget(chat, replayTarget, evidence) {\n' + ENDING)
      up = once(up, 'function latestFailureCleanupReason(chat, replayTarget, evidence) {\n', 'function latestFailureCleanupReason(chat, replayTarget, evidence) {\n' + ENDING)
      up = once(up, '  if (narrow && narrow.cleanable === true && Number.isSafeInteger(revision) && Number.isSafeInteger(Number(narrow.revision)) && Number(narrow.revision) === Number(revision)',
        "  if (narrow && narrow.cleanable === true && (ending === 'error' || ending === 'aborted')\n    && Number.isSafeInteger(revision) && Number.isSafeInteger(Number(narrow.revision)) && Number(narrow.revision) === Number(revision)")
      up = once(up, "  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)\n  if (!entry || entry[1].status === 'completed' || !(entry[1].businessBefore || entry[1].rowBefore)) return null",
        "  if (ending !== 'error' && ending !== 'aborted') return null\n  const entry = Object.entries(chat.timeline.operations || {}).find(([id, op]) => op?.kind === 'body' && Number(op.turn) === turn)\n  if (!entry || entry[1].status !== 'failed' || !(entry[1].businessBefore || entry[1].rowBefore)) return null")
      up = once(up, '  if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason',
        "  if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason\n  if (ending === 'active' || ending === 'completed' || ending === 'none') return ''")
      source = up
    }
    const required = [IMPORT_LINE, helper, fields,
      'const revision = Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision',
      'canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,',
      'failureTarget: latestFailureTarget(chat, replayTarget, evidence),',
      'failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),',
      cacheHitReturn]
    const hasNewPendingForm = source.includes('canRollback: true, canClearIncompleteReply: !!chat.rollbackPending.failureTarget,')
    if (source.split(VIEW_MARKER).length !== 2 || required.some(block => !source.includes(block)) || !hasNewPendingForm) throw new Error('最新失败视图接线不完整')
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
  return next
}
