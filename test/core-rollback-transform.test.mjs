// 干净回退作者树**纯 transform**（deploy/core-rollback-transform.mjs）
//
// 判据（PLG-011 / AGENTS §六）：
//   · 空 surface 替换 + append-only 保留 ⇒ 换成当场物理截断（不软隐藏、不延迟截断、不中间删）；
//   · 预检必须早于正文 update；L4 必须晚于作者最后一次写 head（rollback.undo-point）；
//   · 收尾必须读回最新 chat 再出视图；undo 不再从 revision 重建（明确 throw）；
//   · 幂等；锚点未知/不唯一/CRLF/半施/他人接线 ⇒ **抛错**（失败不得说成功）；
//   · 空白按**真实 B 权威源码**核对（锚点逐字命中一次）；B 源码缺失时该对拍**属可选项**跳过。
// fixture 为本地原创（不读任何 .tmp 目录、不读真实存档）；可选对拍只读仓库内 B2.4 权威源码。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  applyRollbackTransform, rollbackTransformApplied, countAnchor,
  ROLLBACK_ANCHORS, ROLLBACK_MARKER, ROLLBACK_MARKERS, ROLLBACK_TRANSFORM_VERSION,
} from '../deploy/core-rollback-transform.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
/** B2.4 权威源码（manifest sha256 403d13d2…e4b5）：可选对拍，缺失即跳过。 */
const B_SOURCE = path.join(REPO, 'tmp', 'plg-standard-1001-code', 'b', 'lib', 'domain', 'round-history.js')
/** 仓库里的作者树副本（另一修订版）：锚点相同才额外对拍，不同只记诊断。 */
const AUTHOR_COPY = path.join(REPO, 'dsh-tavern-main', 'tavern-plugin', 'lib', 'domain', 'round-history.js')

// ---------------------------------------------------------------------------
// 原创 fixture：与作者 B2.4 同形的**最小可施缝模块**（含全部锚点区域，逐字）
// ---------------------------------------------------------------------------
const FIXTURE = `import { projectPlayerContent } from './player-input-content.js'
import { assertRescueHistoryEditable } from './chat-history-rescue.js'
import { replaceSessionSurface } from './session-surface-mutations.js'
import { canUndoRollback, restoreSurface, preflightSurfaceRestore, unchangedSinceRollback } from './surface-restoration.js'
import { rewindBackgroundSurface } from './background-surface.js'
import { sessionEvents, appendSessionEvent } from './session-events.js'
import { randomUUID } from 'node:crypto'
import { createRegenerationRecovery } from './regeneration-recovery.js'
import { isDeepStrictEqual } from 'node:util'
import { rollbackAvailability, clearFailedTurnSurface, locateRegenerationSurface, planRegenerationSurface, failedTurnReplayAvailability } from './rollback-surface.js'
import { assertRegenerationSourceCurrent, replaceLastRound } from './last-round-replacement.js'
import { diagnosticIdentity, regenerationTargetDiagnostic } from './regeneration-diagnostics.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

export function createRoundHistory({ chats, sessions, scripts, timeline, queueSettlement, cancelSettlement, present, diagnostics, sessionPatch }) {
  const { read: readChat, forSession: chatForSession, readCard: readChatCard,
    readRevision: readChatRevision, write: writeChat, update: updateChat } = chats
  const { read: readScript, continuity: scriptContinuity } = scripts
  const tavernScriptHostAdapter = scripts
  const storyTimeline = timeline
  const view = present
  const pendingRollbacks = new Set()
  const regenerationRecovery = createRegenerationRecovery({ chats, sessions, timeline, isActive: () => false })

  function rollbackBodyMessages(chat) {
    return (chat.messages || []).map(({ role, turn, text }) => ({ role, turn, text }))
  }

  function assertRollbackSnapshot(current, expected) {
    if (!isDeepStrictEqual(current, expected)) throw new Error('回退期间聊天已被其他操作修改，请刷新后重试')
  }

  async function prepareRollbackIntent(chat, intent) {
    const target = storyTimeline.rollbackTarget({ chat })
    if (target === null) return intent
    const beforeChat = await readChatRevision(chat.id, target.beforeRevision)
    if (beforeChat === undefined) throw new Error('找不到剧情 checkpoint 对应的历史 Chat revision: ' + target.beforeRevision)
    return Object.assign({}, intent, { beforeChat })
  }

  async function stopRollbackGeneration(chat) {
    const running = sessions.get(chat.sessionId)
    if (running?.phase?.kind !== 'running') return
    if (typeof running.cancel !== 'function') throw new Error('当前宿主不支持停止生成，请先停止后再回退')
    running.cancel({ kind: 'user' })
    await running.whenIdle()
  }

  async function rollbackTurn(sessionId, chatId, expectedTurn) {
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (chat === undefined) throw new Error('聊天不存在: ' + chatId)
    if (pendingRollbacks.has(chat.id)) throw new Error('正在回退本轮，请等待完成')
    pendingRollbacks.add(chat.id)
    try { return await rollbackChat(chat, expectedTurn, undefined) }
    finally { pendingRollbacks.delete(chat.id) }
  }

  async function regenerate() { throw new Error('fixture：regenerate 不在本测试范围') }

  async function replayFailedTurn() { throw new Error('fixture：replayFailed 不在本测试范围') }

  async function rollbackChat(chat, requestedTurn, restoredAgent) {
    const originalChat = structuredClone(chat)
    const card = await readChatCard(chat)
    const agent = sessions.get(chat.sessionId) || restoredAgent
    const session = agent?.session || sessions.getSession?.(chat.sessionId)
    if (!session) throw new Error('无法访问 DSH 会话: ' + chat.sessionId)
    const events = sessionEvents(session)
    const nodes = session.surface !== undefined && Array.isArray(session.surface.nodes) ? session.surface.nodes : []
    const availability = rollbackAvailability(chat, { events, nodes })
    const rollbackSurface = availability.target
    if (rollbackSurface === null) throw new Error(availability.reason)
    const hiddenTurn = rollbackSurface.turn
    const shadowedSeqs = rollbackSurface.shadowedSeqs
    const regeneratedDshTurns = originalChat.regeneratedDshTurns && typeof originalChat.regeneratedDshTurns === 'object' && !Array.isArray(originalChat.regeneratedDshTurns)
      ? originalChat.regeneratedDshTurns : {}
    const regeneratedVisibleTurn = Number(regeneratedDshTurns[String(hiddenTurn)])
    const msgs = chat.messages || []
    let assistantIndex = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m !== null && typeof m === 'object' && m.role === 'assistant' && m.greeting !== true) { assistantIndex = i; break }
    }
    if (assistantIndex < 0 || assistantIndex - 1 < 0) throw new Error('没有可回退的用户输入与正文组合')
    const removedUserText = str(msgs[assistantIndex - 1]?.text).trim()
    const removedAssistantText = str(msgs[assistantIndex]?.text).trim()
    const legacyBefore = { messages: msgs.slice(0, assistantIndex - 1), posture: '', ledger: null, scriptState: chat.scriptState,
      candidates: null, settleStatus: 'idle', settleError: null, lastSettle: null, participants: {} }
    let rollbackWarning = ''
    let rollbackIntent
    try {
      rollbackIntent = await prepareRollbackIntent(chat, { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore })
    } catch (error) {
      rollbackWarning = '正文已回退，后台历史快照不可用，保留当前状态：' + str(error?.message || error)
      rollbackIntent = { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore: { ...chat, messages: msgs.slice(0, assistantIndex - 1), candidates: null, settleStatus: 'idle', settleError: null }, allowMissingHistory: true }
    }
    await stopRollbackGeneration(chat)
    if (typeof cancelSettlement === 'function') {
      try { await cancelSettlement(chat.id, { wait: false }) }
      catch (error) { rollbackWarning = '正文已回退，后台停止请求失败：' + str(error?.message || error) }
    }
    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {
      const worker = sessions.get(participant.sessionId)
      if (worker && worker !== agent && typeof worker.cancel === 'function') {
        try { worker.cancel({ kind: 'parent' }) } catch { /* Old results are rejected by the new branch. */ }
      }
    }
    const undo = {
      version: 1, id: randomUUID(), ready: false, turn: hiddenTurn,
      foreground: { sessionId: session.id || chat.sessionId, nodes: [...nodes] }, background: []
    }
    if (undo.before) delete undo.before.rollbackUndo
    const rolled = storyTimeline.apply({ chat, intent: rollbackIntent })
    chat = rolled.chat
    chat.rollbackUndo = undo
    chat.regenInProgress = false
    delete chat.regenRecovery
    chat.tavernHelperLifecycleRevision = Math.max(0, Number(chat.tavernHelperLifecycleRevision) || 0) + 1
    chat.suppressedDshTurns = Array.from(new Set((Array.isArray(chat.suppressedDshTurns) ? chat.suppressedDshTurns : []).concat(
      [hiddenTurn], Number.isSafeInteger(regeneratedVisibleTurn) && regeneratedVisibleTurn > 0 ? [regeneratedVisibleTurn] : []))).sort(function (left, right) { return left - right })
    chat.regeneratedDshTurns = chat.regeneratedDshTurns && typeof chat.regeneratedDshTurns === 'object' && !Array.isArray(chat.regeneratedDshTurns)
      ? structuredClone(chat.regeneratedDshTurns) : {}
    delete chat.regeneratedDshTurns[String(hiddenTurn)]
    chat.updatedAt = Date.now()
    chat = await updateChat(chat.id, current => {
      if (!isDeepStrictEqual(rollbackBodyMessages(current), rollbackBodyMessages(originalChat)) || current.timeline?.branchId !== originalChat.timeline?.branchId) throw new Error('回退期间正文已被其他操作修改，请刷新后重试')
      return chat
    }, { source: 'rollback' })

    // 3) 原生消息面：用空消息替换最近一轮的所有 surface 节点（模型不再看到），UI 由客户端隐藏对应 turn tail
    try {
      replaceSessionSurface(session, 'assistant/message', {
        turn: rollbackSurface.turn,
        step: rollbackSurface.step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [],
          source: rollbackSurface.source
        }
      }, { start: rollbackSurface.userSeq, end: rollbackSurface.endSeq, sourceEventSeqs: shadowedSeqs })
    } catch (error) {
      // Keep append-only history intact. A rejected surface replacement must not consume the story checkpoint.
      try {
        await updateChat(chat.id, current => {
          assertRollbackSnapshot(current, chat)
          return storyTimeline.apply({ chat: current, intent: { kind: 'replacement.abort', restoreChat: originalChat } }).chat
        }, { source: 'rollback.abort' })
      } catch (restoreError) {
        throw new Error('回退失败且剧情恢复未完成：' + str(error?.message || error) + '；' + str(restoreError?.message || restoreError), { cause: error })
      }
      throw error
    }
    // Rewind immediately after the foreground commit; retain the timeline's retry
    // boundary so the next task can safely retry if this best-effort step fails.
    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {
      if (participant.status !== 'needs-rewind' || !participant.sessionId) continue
      let restoredHandle
      try {
        let worker = sessions.get(participant.sessionId)
        let background = worker?.session || sessions.getSession?.(participant.sessionId)
        if (!background && typeof sessions.resume === 'function') {
          restoredHandle = await sessions.resume(participant.sessionId)
          worker = restoredHandle.agent
          background = worker?.session
        }
        if (!background) throw new Error('后台会话尚未加载，将在下次后台任务启动时重试')
        if (worker?.phase?.kind === 'running') {
          worker.cancel({ kind: 'parent' })
        }
        if (typeof worker?.whenIdle === 'function') {
          let timeout
          try {
            await Promise.race([worker.whenIdle(), new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('后台尚未停止，将在下次任务启动时重试')), 3000)
            })])
          } finally { clearTimeout(timeout) }
        }
        if (typeof sessions.flush !== 'function') throw new Error('当前宿主未提供后台会话保存接口')
        const checkpoint = { sessionId: participant.sessionId, nodes: [...background.surface.nodes] }
        rewindBackgroundSurface(background, participant.rewindTo)
        checkpoint.afterCount = sessionEvents(background).length
        undo.background.push(checkpoint)
        await sessions.flush(background)
      } catch (error) {
        rollbackWarning = [rollbackWarning, '正文已回退，后台上下文回退未完成：' + str(error?.message || error)].filter(Boolean).join('；')
      } finally {
        if (restoredHandle) {
          try { await restoredHandle.dispose() }
          catch (error) { rollbackWarning = [rollbackWarning, '后台回退临时会话释放失败：' + str(error?.message || error)].filter(Boolean).join('；') }
        }
      }
    }
    try {
      await tavernScriptHostAdapter.dispatchEvent({ sessionId: chat.sessionId, chat, name: 'MESSAGE_DELETED', args: [(chat.messages || []).length] })
    } catch (error) { rollbackWarning = '回退已完成，但脚本联动失败：' + str(error?.message || error) }
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
      chat = await updateChat(chat.id, current => {
        if (current.timeline?.branchId !== chat.timeline?.branchId || current.timeline?.revision !== chat.timeline?.revision) return current
        current.rollbackUndo = { ...undo, ready: true, branchId: current.timeline.branchId, revision: current.timeline.revision,
          lifecycleRevision: Number(current.tavernHelperLifecycleRevision || 0),
          storageRevision: Number(current._storageRevision || 0) + 1,
          foreground: { ...undo.foreground, afterCount: sessionEvents(session).length } }
        return current
      }, { source: 'rollback.undo-point' })
    } catch (error) { rollbackWarning = [rollbackWarning, '回退已完成，但撤销恢复点保存失败：' + str(error?.message || error)].filter(Boolean).join('；') }
    const result = await view(chat, card)
    if (rollbackWarning !== '') result.rollbackWarning = rollbackWarning
    result.rolledBack = { hiddenTurn: hiddenTurn, removedUserText: removedUserText, removedAssistantText: removedAssistantText }
    return result
  }

  async function undoRollback(sessionId, chatId) {
    const chat = str(chatId) === '' ? await chatForSession(sessionId) : await readChat(chatId)
    if (!chat || pendingRollbacks.has(chat.id)) throw new Error('没有可撤销的回退，或正在处理回退')
    const saved = chat.rollbackUndo
    const before = saved.before || await readChatRevision(chat.id, saved.beforeRevision)
    if (!before || before.id !== chat.id) throw new Error('找不到回退前的恢复点')
    return await view(before, await readChatCard(before))
  }

  return Object.freeze({ regenerate, replayFailed: replayFailedTurn, recover: regenerationRecovery.recover, rollback: rollbackTurn, undoRollback })
}
`

/** 施缝后必须成立的断言（fixture 与真实 B 源码共用）。 */
function assertPatched(out, label) {
  const has = snippet => assert.ok(out.includes(snippet), `${label}：缺少「${snippet}」`)
  const lacks = snippet => assert.ok(!out.includes(snippet), `${label}：不应再有「${snippet}」`)
  // ① 新依赖：主 owned 薄垫片（不是包说明符）
  has("import * as storageRollback from './storage-rollback.js'")
  // ② 注入参数
  has('persistenceProvider, projectionsProvider, projectionCacheProvider, tokenMeterProvider, webServerProvider, variableStore }) {')
  // ③ 物理清除语义：不再累积遮蔽标记；变量不重复删（统一 archive 事务）
  has('chat.suppressedDshTurns = []')
  lacks('Array.from(new Set((Array.isArray(chat.suppressedDshTurns)')
  lacks('variableStore.deleteFrom')
  // ④ 空 surface 替换 + 幽灵恢复整块消失
  lacks('content: [],')
  lacks('sourceEventSeqs: shadowedSeqs')
  lacks('replacement.abort')
  has("await rollbackExport('cleanupAfterRollback')(livePersistence, session, chats, chat.id, hiddenTurn, liveServices, {")
  // ④b strict 段落的三处 warning 式 fallback 必须改成响亮拒绝/停止（不得 warn 后继续）
  lacks("rollbackWarning = '正文已回退，后台历史快照不可用")
  lacks('allowMissingHistory: true')
  lacks("rollbackWarning = '正文已回退，后台停止请求失败")
  lacks('catch { /* Old results are rejected by the new branch. */ }')
  has("const rollbackIntent = await prepareRollbackIntent(chat, { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore })")
  has("if (typeof cancelSettlement === 'function') await cancelSettlement(chat.id, { wait: false })")
  // ⑤ 撤销回退：明确 throw，不再从 revision 重建；undo-point 不给 ready: true
  lacks('ready: true')
  lacks('saved.before || await readChatRevision(chat.id, saved.beforeRevision)')
  has('回退已物理清除，不可撤销')
  // ⑥ 后台参与者：物理 seq 回退取代作者的「只换 surface」软行（表面补偿/撤销点一并剔除）
  lacks('rewindBackgroundSurface(background, participant.rewindTo)')
  lacks('undo.background.push(checkpoint)')
  lacks('后台上下文回退未完成')
  has("rollbackExport('preflightRollbackAtSeq')(preview, participant.rewindTo")
  has("await rollbackExport('cleanupAfterRollbackAtSeq')(livePersistence, background, participant.rewindTo")
  has("const settled = await updateChat(chat.id, current => {")
  has("status: 'current', boundary: participant.rewindTo, rewindTo: null")
  has("source: 'rollback.background-rewind-complete'")
  has('for (const entry of backgroundRewinds) {')
  // ⑦ 顺序：预检（前台+后台） < 正文提交 < 前台截断 < 后台物理回退 < 最后写 head < L4 < L1.7 < 读回最新 chat/出视图
  const at = snippet => {
    const index = out.indexOf(snippet)
    assert.ok(index >= 0, `${label}：找不到顺序锚点「${snippet}」`)
    return index
  }
  const preflight = at("rollbackExport('preflightRollback')")
  const backgroundPreflight = at("rollbackExport('preflightRollbackAtSeq')")
  const rolledAt = at('const rolled = storyTimeline.apply({ chat, intent: rollbackIntent })')
  const commit = at("{ source: 'rollback' }")
  const cleanup = at("rollbackExport('cleanupAfterRollback')")
  const backgroundCleanup = at("rollbackExport('cleanupAfterRollbackAtSeq')")
  const undoPoint = at("source: 'rollback.undo-point'")
  const l4 = at("rollbackExport('cleanupRollbackHeadIndex')")
  assert.ok(!out.includes('kickUpgradedSockets'))
  const retired = at("throw new Error('旧回退编排已退役；缺少统一同连接cleanRollback接缝')")
  const reread = at('chat = await readChat(chat.id) || chat')
  // 视图调用在作者原文里出现多次 ⇒ 取**最后一次**（= rollbackChat 的收尾那处）
  const viewAt = out.lastIndexOf('const result = await view(chat, card)')
  assert.ok(viewAt >= 0, `${label}：找不到 rollbackChat 收尾的视图调用`)
  assert.ok(preflight < commit, `${label}：前台预检必须早于正文 update`)
  // producer：needs-rewind 只存在于 timeline.apply 的**纯计算结果** rolled.chat 上 ⇒ 必须先取 rolled 再查参与者。
  assert.equal(countAnchor(out, 'const rolled = storyTimeline.apply({ chat, intent: rollbackIntent })'), 1, `${label}：rolled 不得重复/缺失`)
  assert.ok(out.includes('storyTimeline.inspect({ chat: rolled.chat }).participants'), `${label}：后台参与者必须查 rolled.chat（旧 chat 永远没有 needs-rewind）`)
  assert.ok(rolledAt < backgroundPreflight && backgroundPreflight < commit, `${label}：rolled → 后台停止/预检 → 正文 update 的顺序不可换`)
  assert.ok(commit < cleanup, `${label}：前台截断必须在正文提交之后`)
  assert.ok(cleanup < backgroundCleanup, `${label}：后台物理回退排在前台截断之后`)
  const settled = at("source: 'rollback.background-rewind-complete'")
  assert.ok(backgroundCleanup < settled, `${label}：后台参与者只能在物理清理成功后收敛`)
  assert.ok(settled < undoPoint, `${label}：参与者完成状态必须早于最后一次head写入`)
  assert.ok(backgroundCleanup < undoPoint, `${label}：后台回退仍在最后一次写 head 之前`)
  assert.ok(undoPoint < l4, `${label}：L4 必须晚于 rollback.undo-point（否则整档写回带回残留）`)
  assert.ok(retired < preflight && retired < commit, `${label}：旧编排必须在删写前硬拒，不独立运行旧链路`)
  assert.ok(l4 < reread && reread < viewAt, `${label}：必须先读回最新 chat 再出视图（不返回旧 head undo）`)
}

function checkSyntax(source, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-core-rollback-transform-'))
  try {
    const file = path.join(dir, 'round-history.mjs')
    fs.writeFileSync(file, source, 'utf8')
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    assert.equal(result.status, 0, `${label}：node --check 失败（status=${String(result.status)}）`)
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())), '临时目录必须在系统临时根下')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

test('锚点：fixture 里每个锚点恰好命中一次（空白/文本逐字对齐）', () => {
  for (const [name, anchor] of Object.entries(ROLLBACK_ANCHORS)) {
    assert.equal(countAnchor(FIXTURE, anchor), 1, `fixture 锚点 ${name} 命中数不为 1`)
  }
})

test('transform：空 surface 块被物理截断取代（顺序、幂等、语法）', () => {
  const first = applyRollbackTransform(FIXTURE)
  assert.equal(first.changed, true)
  assert.equal(first.version, ROLLBACK_TRANSFORM_VERSION)
  assert.deepEqual(first.markers, [...ROLLBACK_MARKERS])
  assertPatched(first.text, 'fixture')
  checkSyntax(first.text, 'fixture')
  const second = applyRollbackTransform(first.text)
  assert.equal(second.changed, false, '幂等：第二次不得再改')
  assert.equal(second.text, first.text)
  assert.equal(rollbackTransformApplied(first.text), true)
})

test('transform：多行锚点未知（作者改版）⇒ 抛错，不静默返回原文冒充成功', () => {
  const tampered = FIXTURE.replace('    // 3) 原生消息面：用空消息替换最近一轮的所有 surface 节点（模型不再看到），UI 由客户端隐藏对应 turn tail',
    '    // 3) 原生消息面：用空消息替换最近一轮的 surface 节点（模型不再看到）')
  assert.notEqual(tampered, FIXTURE)
  assert.throws(() => applyRollbackTransform(tampered), /锚点不唯一\/未命中/)
})

test('transform：签名行未知 / CRLF / 半施 / 他人接线 ⇒ 全部 fail closed', () => {
  assert.throws(() => applyRollbackTransform(FIXTURE.replace(', sessionPatch }) {', ', sessionPatch, extra }) {')), /锚点不唯一\/未命中/)
  assert.throws(() => applyRollbackTransform(FIXTURE.replace(/\n/g, '\r\n')), /锚点不唯一\/未命中/)
  const applied = applyRollbackTransform(FIXTURE).text
  assert.throws(() => applyRollbackTransform(applied.replace('chat.suppressedDshTurns = []', 'chat.suppressedDshTurns = [1]')), /半施状态/)
  const foreign = FIXTURE.replace("import { diagnosticIdentity, regenerationTargetDiagnostic } from './regeneration-diagnostics.js'",
    "import { diagnosticIdentity, regenerationTargetDiagnostic } from './regeneration-diagnostics.js'\nimport { cleanupAfterRollback } from './rollback-cleanup.js'")
  assert.throws(() => applyRollbackTransform(foreign), /拒绝叠加/)
})

test('后台参与者：物理 seq 回退取代作者的「空 surface + 表面补偿」软行（缺口已闭合）', () => {
  const out = applyRollbackTransform(FIXTURE).text
  // 作者那套软行（空 surface 替换 + checkpoint/undo.background 表面补偿 + catch 成 warning）必须整体消失。
  assert.ok(!out.includes('rewindBackgroundSurface(background, participant.rewindTo)'), '不得再走 surface 替换')
  assert.ok(!out.includes('undo.background.push(checkpoint)'), '表面补偿（撤销点）不适用于物理 delete，必须剔除')
  assert.ok(!out.includes('后台上下文回退未完成'), '失败不得降级成 rollbackWarning（必须响亮）')
  // 物理回退走 seq cutoff：边界是 participant.rewindTo（该会话自己的 seq），不由 turn 反推。
  assert.ok(out.includes("rollbackExport('cleanupAfterRollbackAtSeq')(livePersistence, background, participant.rewindTo"))
  const physicalLoop = out.slice(out.indexOf('for (const entry of backgroundRewinds) {'), out.indexOf("source: 'rollback.undo-point'"))
  assert.ok(physicalLoop.length > 0)
  for (const required of ["rollbackExport('cleanupAfterRollbackAtSeq')", 'await sessions.flush(background)']) {
    assert.ok(physicalLoop.includes(required), '后台物理回退段缺少：' + required)
  }
  // 未加载的后台会话：resume 拿活句柄、finally 释放（Phase A 预览句柄 + Phase B 执行句柄都在）。
  assert.ok(out.includes('previewHandle = await sessions.resume(participant.sessionId)'))
  assert.ok(out.includes('if (previewHandle) await previewHandle.dispose()'))
  assert.ok(physicalLoop.includes('restoredHandle = await sessions.resume(participant.sessionId)'))
  assert.ok(physicalLoop.includes('await restoredHandle.dispose()'))
})

// ---------------------------------------------------------------------------
// 运行时 fixture：**真的执行**变换后的模块（不只是 token 断言）
//   目的：证明 producer 语义 —— needs-rewind/rewindTo 只出现在 `timeline.apply` 的纯计算结果
//   （rolled.chat）上；若退回用旧 chat 查 participants，backgroundRewinds 会永远为空、后台一条不截，
//   本测试就会因为缺少后台 resume/truncate/flush 而失败。
// ---------------------------------------------------------------------------

const STUB_MODULES = {
  'player-input-content.js': "export function projectPlayerContent(attachments, text) { return [{ type: 'text', text }] }\n",
  'chat-history-rescue.js': 'export function assertRescueHistoryEditable() {}\n',
  'session-surface-mutations.js': "export function replaceSessionSurface() { globalThis.__surfaceRewinds = (globalThis.__surfaceRewinds ?? 0) + 1; throw new Error('不得再调用 replaceSessionSurface（空 surface 软行应已删除）') }\n",
  'background-surface.js': "export function rewindBackgroundSurface() { globalThis.__surfaceRewinds = (globalThis.__surfaceRewinds ?? 0) + 1; throw new Error('不得再调用 rewindBackgroundSurface（后台软行应已改为物理截断）') }\n",
  'surface-restoration.js': 'export function canUndoRollback() { return false }\nexport function restoreSurface() {}\nexport function preflightSurfaceRestore() {}\nexport function unchangedSinceRollback() { return true }\n',
  'session-events.js': [
    'export function sessionEvents(session) { return typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : (Array.isArray(session?.log) ? session.log : []) }',
    'export function appendSessionEvent() {}',
    'export function surfaceReplacementRange() { return { start: 0, end: 0 } }',
    '',
  ].join('\n'),
  'regeneration-recovery.js': 'export function createRegenerationRecovery() { return { recover: async () => {}, abort: async () => {}, complete: async () => undefined } }\n',
  'rollback-surface.js': [
    'export function rollbackAvailability() { return globalThis.__availability }',
    'export function clearFailedTurnSurface() { return 0 }',
    'export function locateRegenerationSurface() { return null }',
    'export function planRegenerationSurface() { throw new Error("fixture: 未使用") }',
    'export function failedTurnReplayAvailability() { return { target: null, reason: "fixture" } }',
    '',
  ].join('\n'),
  'last-round-replacement.js': 'export function assertRegenerationSourceCurrent() {}\nexport function replaceLastRound({ originalChat }) { return { chat: originalChat } }\n',
  'regeneration-diagnostics.js': 'export function diagnosticIdentity() { return {} }\nexport function regenerationTargetDiagnostic() { return {} }\n',
}

function turnEvents(turn, startSeq) {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn } },
    { seq: startSeq + 1, type: 'user/message', data: { turn, message: { role: 'user', content: [{ type: 'text', text: 'u' + turn }] } } },
    { seq: startSeq + 2, type: 'assistant/message', data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a' + turn }] } } },
    { seq: startSeq + 3, type: 'turn/end', data: { turn, reason: { kind: 'stop' } } },
  ]
}
const BG_SEED = { seq: 0, type: 'system/message', data: { turn: 1, step: 1, message: { id: 'tavern-system-head:background-synthetic', role: 'system', content: [] } } }

class HarnessSurfaceManager {
  constructor(log, baseSeq) {
    this.baseSeq = baseSeq
    this._state = {}
    this._lastProcessedSeq = baseSeq + log.length - 1
    this._nodes = log.map(event => event.seq)
  }
  get nodes() { return this._nodes }
}
function harnessSession(id, events) {
  return {
    header: { id }, log: events, surface: { nodes: events.map(event => event.seq) },
    surfaceManager: new HarnessSurfaceManager(events, 0), firstLiveSeq: 0,
    snapshotEvents() { return this.log },
    get seq() { return this.log.length },
  }
}

/** 执行变换后的 fixture（真实 rollback 全链路），返回记录与断言素材。 */
async function runRollbackHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tavern-core-rollback-runtime-'))
  const record = []
  try {
    const transformed = applyRollbackTransform(FIXTURE)
    assert.equal(transformed.changed, true)
    fs.writeFileSync(path.join(dir, 'round-history.mjs'), transformed.text, 'utf8')
    for (const [name, source] of Object.entries(STUB_MODULES)) fs.writeFileSync(path.join(dir, name), source, 'utf8')
    const real = rel => pathToFileURL(path.resolve(HERE, '..', rel)).href
    fs.writeFileSync(path.join(dir, 'storage-rollback.js'), [
      "import { sessionEvents } from './session-events.js'",
      `import * as impl from '${real('lib/rollback-cleanup.js')}'`,
      `import { cleanupRollbackHeadIndex } from '${real('lib/rollback-head-prune.js')}'`,
      'impl.configureRollbackCleanup({ sessionEvents })',
      'export const preflightRollback = impl.preflightRollback',
      'export const preflightRollbackAtSeq = impl.preflightRollbackAtSeq',
      'export const cleanupAfterRollback = impl.cleanupAfterRollback',
      'export const cleanupAfterRollbackAtSeq = impl.cleanupAfterRollbackAtSeq',
      'export { cleanupRollbackHeadIndex }',
      '',
    ].join('\n'), 'utf8')

    // ---- 真实 producer：needs-rewind/rewindTo 只出现在 timeline.apply 的纯计算结果里 ----
    const foregroundSession = harnessSession('foreground-1', [...turnEvents(1, 0), ...turnEvents(2, 4)])
    const backgroundSession = harnessSession('background-synthetic', [BG_SEED, ...turnEvents(7, 1), ...turnEvents(8, 5)])
    const foregroundAgent = { phase: { kind: 'idle', lastTurn: 9 }, session: foregroundSession }
    const backgroundAgent = { phase: { kind: 'idle', lastTurn: 9 }, session: backgroundSession }
    let backgroundLoaded = false
    const sessions = {
      get: id => (id === 'foreground-1' ? foregroundAgent : (id === 'background-synthetic' && backgroundLoaded ? backgroundAgent : undefined)),
      getSession: () => undefined,
      resume: async id => {
        record.push('resume:' + id)
        backgroundLoaded = true
        return { agent: backgroundAgent, dispose: async () => { record.push('dispose:' + id); backgroundLoaded = false } }
      },
      flush: async session => record.push('flush:' + session.header.id),
    }
    let chat = { id: 'chat-1', sessionId: 'foreground-1', updatedAt: 0, nativeCommits: {},
      messages: [{ role: 'user', text: 'u2', turn: 2 }, { role: 'assistant', text: 'a2', turn: 2 }],
      timeline: { branchId: 'b', revision: 1 } }
    const chats = {
      read: async () => chat,
      forSession: async () => chat,
      readCard: async () => ({}),
      readRevision: async () => undefined,
      write: async () => {},
      update: async (id, fn, meta) => { record.push('chat.update:' + String(meta?.source ?? '')); chat = fn(chat); return chat },
      readSlice: async () => ({ chat: structuredClone(chat) }),
    }
    const timeline = {
      rollbackTarget: () => null,
      apply: ({ chat: base }) => ({ chat: { ...base, timeline: { branchId: 'b', revision: 2,
        participants: { background: { role: 'background', sessionId: 'background-synthetic', status: 'needs-rewind', rewindTo: 4 } } } } }),
      inspect: ({ chat: target }) => ({ participants: target?.timeline?.participants ?? {}, operations: {}, checkpointCount: 0 }),
    }
    const registrations = new Map([['turnBoundary', { def: { key: 'turnBoundary' }, cells: new Map() }]])
    const services = {
      projections: {
        registrations,
        hydrate(session, _input, events) { for (const registration of registrations.values()) registration.cells.set(session, { observedSeq: events.at(-1)?.seq ?? -1 }) },
        stateOf(session) { record.push('stateOf:' + session.header.id); return { lastTurn: session.header.id === 'background-synthetic' ? 4 : 1 } },
      },
      projectionCache: { write: async session => record.push('cache.write:' + session.header.id) },
    }
    globalThis.__surfaceRewinds = 0
    globalThis.__availability = { reason: '', failedTurns: [], unclearedTurns: [],
      target: { turn: 2, step: 1, userSeq: 4, endSeq: 7, source: { kind: 'model' }, shadowedSeqs: [4, 5, 6, 7] } }
    const mod = await import(pathToFileURL(path.join(dir, 'round-history.mjs')).href)
    const api = mod.createRoundHistory({
      chats, sessions,
      scripts: { read: async () => undefined, continuity: { transition: () => ({ state: {} }) }, dispatchEvent: async () => record.push('script.dispatch') },
      timeline, queueSettlement: async () => {}, cancelSettlement: async () => record.push('cancelSettlement'),
      present: async view => ({ view }), diagnostics: { record: async () => {} },
      persistenceProvider: () => ({ drainOpenHandles: async id => record.push('drain:' + id),
        truncateEvents: async (header, boundarySeq) => { record.push('truncate:' + header.id + ':' + boundarySeq); return { eventCount: boundarySeq + 1 } } }),
      projectionsProvider: () => services.projections,
      projectionCacheProvider: () => services.projectionCache,
      tokenMeterProvider: () => undefined,
      webServerProvider: () => ({ upgradedSockets: [] }),
      variableStore: {},
    })
    await assert.rejects(api.rollback('foreground-1', 'chat-1', 0), /旧回退编排已退役/)
    const result = undefined
    return { record, result, chat, foregroundSession, backgroundSession, foregroundAgent, backgroundAgent, surfaceRewinds: globalThis.__surfaceRewinds }
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())), '临时目录必须在系统临时根下')
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('旧文本过渡编排运行时删写前硬拒；只有标准cleanRollback消费者可执行回退', async () => {
  const run = await runRollbackHarness()
  assert.equal(run.record.some(item => item.startsWith('truncate:') || item.startsWith('chat.update:')), false)
  assert.equal(run.surfaceRewinds, 0)
})

test('部署旧v1源码：完成提交精确升级且复跑幂等，标记漂移拒绝', t => {
  const file = path.resolve(HERE, '../../../tmp/projection-baseline-1001/round-history-deploy-before.js')
  if (!fs.existsSync(file)) return t.skip('缺限定部署源码fixture')
  const previous = fs.readFileSync(file, 'utf8')
  const next = applyRollbackTransform(previous)
  assert.equal(next.changed, true)
  assert.ok(next.text.includes('// [dsh-tavern-background-rewind-complete:v1]'))
  assert.ok(next.text.includes("source: 'rollback.background-rewind-complete'"))
  assert.equal(applyRollbackTransform(next.text).changed, false)
  assert.throws(() => applyRollbackTransform(next.text.replace('const settled = await updateChat', 'const drifted = await updateChat')), /半升级/)
  checkSyntax(next.text, '部署旧v1升级')
})

test('对拍（可选）：真实 B2.4 权威源码锚点逐字命中 + 施缝结果同样成立', t => {
  if (!fs.existsSync(B_SOURCE)) {
    t.diagnostic('未找到 B2.4 权威源码（可选项），跳过对拍：' + B_SOURCE)
    return
  }
  const source = fs.readFileSync(B_SOURCE, 'utf8')
  for (const [name, anchor] of Object.entries(ROLLBACK_ANCHORS)) {
    assert.equal(countAnchor(source, anchor), 1, `B2.4 源码锚点 ${name} 命中数不为 1（空白/版本不符）`)
  }
  const result = applyRollbackTransform(source)
  assert.equal(result.changed, true)
  assertPatched(result.text, 'B2.4 源码')
  checkSyntax(result.text, 'B2.4 源码')
  assert.equal(rollbackTransformApplied(result.text), true)
  if (fs.existsSync(AUTHOR_COPY)) {
    const copy = fs.readFileSync(AUTHOR_COPY, 'utf8')
    if (Object.values(ROLLBACK_ANCHORS).every(anchor => countAnchor(copy, anchor) === 1)) {
      assert.equal(applyRollbackTransform(copy).changed, true, '作者树副本（锚点相同）也必须可施缝')
    } else {
      t.diagnostic('作者树副本与 B2.4 锚点不同（版本不同）——按设计 fail closed，跳过额外对拍')
    }
  }
})
