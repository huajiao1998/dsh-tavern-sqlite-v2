#!/usr/bin/env node
// dsh-tavern-sqlite-v2 · 干净尾部回退（PLG-011）作者树**纯 transform**
//
// 目标：把 B2.4 作者树的 `tavern-plugin/lib/domain/round-history.js` 从
//   「软隐藏（suppressedDshTurns 累积）+ 空 surface 替换（append-only 保留）+ 后台只换 surface」
// 改成
//   「不可逆点之前严格预检（前台轮次轴 + 后台 seq 轴）→ Chat 提交 → 前台/后台 Session transcript
//     **当场物理截断** → 最后写 head 之后 L4 → 读回最新 chat 再出视图」。
//
// 边界（本文件**只做文本变换**，不读盘、不写盘、不安装、不重启）：
//   · 纯函数 `applyRollbackTransform(text)`：`text → { text, changed, version, markers }`，**幂等**；
//     锚点未知/不唯一、作者版本不同、CRLF、半施状态 ⇒ **抛错**（fail closed，绝不猜合并）。
//   · 不注入变量删除：变量与存档统一进同一 archive 事务后，尾部 DELETE 已覆盖，重复 deleteFrom 会双删。
//   · 后台参与者改走 **seq 轴**物理回退（`cleanupAfterRollbackAtSeq`，边界 = `participant.rewindTo`）。
//     producer 语义：`needs-rewind/rewindTo` 只出现在 `storyTimeline.apply` 的**纯计算结果** `rolled.chat` 上
//     ⇒ 先把 `const rolled = …` 提前（纯计算，不落库），再查 `inspect({ chat: rolled.chat })`；
//     用旧 chat 查永远是空的（后台一条都不截）。Phase A 必须先 cancel + whenIdle + flush 再预检
//     （否则"前景已删、后台还在跑"，边界会漂移）；Phase B 才做物理截断。
//     作者的「空 surface 替换 + checkpoint/undo.background 表面补偿 + catch 成 warning」整体剔除，
//     失败**响亮抛出**（不降级成 rollbackWarning）。后台轮次独立于前台，绝不由 turn 反推。
//   · strict 段落里三处 warning 式 fallback 一并改掉：`prepareRollbackIntent` 缺快照 ⇒ 突变前抛错
//     （不再 `allowMissingHistory` 兜底）；`cancelSettlement` 失败 ⇒ 抛出；参与者 cancel 的吞错 ⇒ 抛出。
//
// 依赖（由主入口/施缝层提供，本文件不创建）：
//   · 作者树 `lib/domain/storage-rollback.js`（**主 owned 薄垫片**）：转出本包的
//     `rollback-cleanup` / `rollback-layers` / `rollback-head-prune` 三个模块，至少包含
//     `preflightRollback`、`preflightRollbackAtSeq`、`cleanupAfterRollback`、`cleanupAfterRollbackAtSeq`、
//     `cleanupRollbackHeadIndex`；本模块仅旧文本转换过渡，必须接cleanRollback才允许执行。
//   · 作者 `lib/index.js` 侧（**主 index transform**）：给 `createRoundHistory({...})` 注入
//     `persistenceProvider / projectionsProvider / projectionCacheProvider / tokenMeterProvider /
//      （历史过渡webServerProvider，最终接rollbackSyncProvider）/ variableStore`，并给它的 `chats` 字面量补 `readSlice: chatPersistence.readSlice`
//     （L4 head 修剪要 `readSlice`；缺了会在预检阶段**明确拒绝**，而不是回退到一半）。
//
// 用法（在酒馆主机上跑；默认**只检查不写**）：
//   node <包目录>/deploy/core-rollback-transform.mjs --check <round-history.js>   # 0=已是最新 / 3=需要施缝 / 1=错误
//   主入口直接 import：`applyRollbackTransform(source)` 拿 `{ text, changed }` 自己写盘 + `node --check`。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyCleanRollbackTransform, applyLatestCleanRollbackTransform } from './clean-rollback-transform.mjs'

export const ROLLBACK_TRANSFORM_VERSION = 1
/** 施缝标记（幂等键）：出现在作者树里就说明本 transform 已施过。 */
export const ROLLBACK_MARKER = '// [dsh-tavern-core-rollback:v1]'
/** 作者树里的垫片路径（相对 `lib/domain/round-history.js`）。 */
export const ROLLBACK_SHIM = './storage-rollback.js'
const IMPORT_LINE = `import * as storageRollback from '${ROLLBACK_SHIM}'\n`

// ---------------------------------------------------------------------------
// 锚点：逐字取自 B2.4（tmp/plg-standard-1001-code/b/lib/domain/round-history.js，
// manifest sha256 403d13d2e125bd9181c5873da68eff72052ad054a4d44aa07d50a9196f31e4b5）。
// 空白是判据（AGENTS §二.11）：测试逐条断言锚点在真实 B 源码里**恰好出现一次**。
// ---------------------------------------------------------------------------
export const ROLLBACK_ANCHORS = Object.freeze({
  import: "import { diagnosticIdentity, regenerationTargetDiagnostic } from './regeneration-diagnostics.js'",
  signature: 'export function createRoundHistory({ chats, sessions, scripts, timeline, queueSettlement, cancelSettlement, present, diagnostics, sessionPatch }) {',
  suppressed: [
    '    chat.suppressedDshTurns = Array.from(new Set((Array.isArray(chat.suppressedDshTurns) ? chat.suppressedDshTurns : []).concat(',
    '      [hiddenTurn], Number.isSafeInteger(regeneratedVisibleTurn) && regeneratedVisibleTurn > 0 ? [regeneratedVisibleTurn] : []))).sort(function (left, right) { return left - right })',
  ].join('\n'),
  rollbackCommit: '    const rolled = storyTimeline.apply({ chat, intent: rollbackIntent })',
  emptySurface: [
    '    // 3) 原生消息面：用空消息替换最近一轮的所有 surface 节点（模型不再看到），UI 由客户端隐藏对应 turn tail',
    '    try {',
    "      replaceSessionSurface(session, 'assistant/message', {",
    '        turn: rollbackSurface.turn,',
    '        step: rollbackSurface.step,',
    '        message: {',
    '          id: randomUUID(),',
    "          role: 'assistant',",
    '          content: [],',
    '          source: rollbackSurface.source',
    '        }',
    '      }, { start: rollbackSurface.userSeq, end: rollbackSurface.endSeq, sourceEventSeqs: shadowedSeqs })',
    '    } catch (error) {',
    '      // Keep append-only history intact. A rejected surface replacement must not consume the story checkpoint.',
    '      try {',
    '        await updateChat(chat.id, current => {',
    '          assertRollbackSnapshot(current, chat)',
    "          return storyTimeline.apply({ chat: current, intent: { kind: 'replacement.abort', restoreChat: originalChat } }).chat",
    "        }, { source: 'rollback.abort' })",
    '      } catch (restoreError) {',
    "        throw new Error('回退失败且剧情恢复未完成：' + str(error?.message || error) + '；' + str(restoreError?.message || restoreError), { cause: error })",
    '      }',
    '      throw error',
    '    }',
  ].join('\n'),
  undoPoint: '        current.rollbackUndo = { ...undo, ready: true, branchId: current.timeline.branchId, revision: current.timeline.revision,',
  // 后台参与者软行（B2.4 round-history :525-562）：只做 surface 替换 + 撤销点表面补偿，无物理截断。
  backgroundRewind: [
    '    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {',
    "      if (participant.status !== 'needs-rewind' || !participant.sessionId) continue",
    '      let restoredHandle',
    '      try {',
    '        let worker = sessions.get(participant.sessionId)',
    '        let background = worker?.session || sessions.getSession?.(participant.sessionId)',
    "        if (!background && typeof sessions.resume === 'function') {",
    '          restoredHandle = await sessions.resume(participant.sessionId)',
    '          worker = restoredHandle.agent',
    '          background = worker?.session',
    '        }',
    "        if (!background) throw new Error('后台会话尚未加载，将在下次后台任务启动时重试')",
    "        if (worker?.phase?.kind === 'running') {",
    "          worker.cancel({ kind: 'parent' })",
    '        }',
    "        if (typeof worker?.whenIdle === 'function') {",
    '          let timeout',
    '          try {',
    '            await Promise.race([worker.whenIdle(), new Promise((_, reject) => {',
    "              timeout = setTimeout(() => reject(new Error('后台尚未停止，将在下次任务启动时重试')), 3000)",
    '            })])',
    '          } finally { clearTimeout(timeout) }',
    '        }',
    "        if (typeof sessions.flush !== 'function') throw new Error('当前宿主未提供后台会话保存接口')",
    '        const checkpoint = { sessionId: participant.sessionId, nodes: [...background.surface.nodes] }',
    '        rewindBackgroundSurface(background, participant.rewindTo)',
    '        checkpoint.afterCount = sessionEvents(background).length',
    '        undo.background.push(checkpoint)',
    '        await sessions.flush(background)',
    '      } catch (error) {',
    "        rollbackWarning = [rollbackWarning, '正文已回退，后台上下文回退未完成：' + str(error?.message || error)].filter(Boolean).join('；')",
    '      } finally {',
    '        if (restoredHandle) {',
    '          try { await restoredHandle.dispose() }',
    "          catch (error) { rollbackWarning = [rollbackWarning, '后台回退临时会话释放失败：' + str(error?.message || error)].filter(Boolean).join('；') }",
    '        }',
    '      }',
    '    }',
  ].join('\n'),
  rollbackTail: [
    '    const result = await view(chat, card)',
    "    if (rollbackWarning !== '') result.rollbackWarning = rollbackWarning",
    '    result.rolledBack = { hiddenTurn: hiddenTurn, removedUserText: removedUserText, removedAssistantText: removedAssistantText }',
  ].join('\n'),
  undoRollbackHead: '  async function undoRollback(sessionId, chatId) {',
  // strict 段落里的三处「warning 式 fallback」（B2.4 :456-473）：必须改成响亮拒绝/停止。
  prepareFallback: [
    '    let rollbackIntent',
    '    try {',
    '      rollbackIntent = await prepareRollbackIntent(chat, { kind: \'turn.rollback\', turn: hiddenTurn, legacyBefore })',
    '    } catch (error) {',
    "      rollbackWarning = '正文已回退，后台历史快照不可用，保留当前状态：' + str(error?.message || error)",
    "      rollbackIntent = { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore: { ...chat, messages: msgs.slice(0, assistantIndex - 1), candidates: null, settleStatus: 'idle', settleError: null }, allowMissingHistory: true }",
    '    }',
  ].join('\n'),
  cancelSettlementCatch: [
    '    if (typeof cancelSettlement === \'function\') {',
    '      try { await cancelSettlement(chat.id, { wait: false }) }',
    "      catch (error) { rollbackWarning = '正文已回退，后台停止请求失败：' + str(error?.message || error) }",
    '    }',
  ].join('\n'),
  participantCancelCatch: [
    '    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {',
    '      const worker = sessions.get(participant.sessionId)',
    '      if (worker && worker !== agent && typeof worker.cancel === \'function\') {',
    '        try { worker.cancel({ kind: \'parent\' }) } catch { /* Old results are rejected by the new branch. */ }',
    '      }',
    '    }',
  ].join('\n'),
  undoRollbackTail: '  return Object.freeze({ regenerate, replayFailed: replayFailedTurn, recover: regenerationRecovery.recover, rollback: rollbackTurn, undoRollback })',
})

// ---------------------------------------------------------------------------
// 替换文本
// ---------------------------------------------------------------------------
const SIGNATURE_NEXT = [
  'export function createRoundHistory({ chats, sessions, scripts, timeline, queueSettlement, cancelSettlement, present, diagnostics, sessionPatch,',
  '  persistenceProvider, projectionsProvider, projectionCacheProvider, tokenMeterProvider, webServerProvider, variableStore }) {',
].join('\n')

const SUPPRESSED_NEXT = [
  `    ${ROLLBACK_MARKER} 物理清除语义：被回退轮的 transcript 已当场截断，不再用 suppressedDshTurns 遮蔽`,
  '    //（残留标记正是"回退后页面空白"的根源）。变量随存档统一事务删除，故不在这里重复 deleteFrom。',
  '    chat.suppressedDshTurns = []',
].join('\n')

const PREFLIGHT_NEXT = [
  "    throw new Error('旧回退编排已退役；缺少统一同连接cleanRollback接缝')",
  `    ${ROLLBACK_MARKER} 回退不可逆点之前的**严格预检**（必须早于下面的正文 update）。`,
  '    // 纯尾边界 / 引用链 / 四层接线任一不满足 ⇒ 当场拒绝；绝不在库被截断之后再 try 恢复 oldchat（幽灵状态）。',
  '    const rollbackExport = function (name) {',
  '      const value = storageRollback[name]',
  "      if (typeof value !== 'function') throw new Error('storage-rollback.js 未导出 ' + name + '（包与作者树垫片版本不同步，拒绝半回退）')",
  '      return value',
  '    }',
  '    const livePersistence = typeof persistenceProvider === "function" ? persistenceProvider() : persistenceProvider',
  '    const liveServices = {',
  '      projections: typeof projectionsProvider === "function" ? projectionsProvider() : projectionsProvider,',
  '      projectionCache: typeof projectionCacheProvider === "function" ? projectionCacheProvider() : projectionCacheProvider,',
  '      agentProvider: () => sessions.get(chat.sessionId),',
  '      tokenMeterProvider: () => (typeof tokenMeterProvider === "function" ? tokenMeterProvider() : tokenMeterProvider),',
  '      webServerProvider: () => (typeof webServerProvider === "function" ? webServerProvider() : webServerProvider),',
  '    }',
  "    const rollbackPreflight = rollbackExport('preflightRollback')(session, hiddenTurn, {",
  '      strict: true, persistence: livePersistence, services: liveServices, head: chats,',
  '    })',
  `    ${ROLLBACK_MARKER} 后台参与者（needs-rewind）：先停下来 + flush，再按 seq 轴预检（全部早于正文 update）。`,
  '    // ① `storyTimeline.apply` 是**纯计算**（不落库）：needs-rewind/rewindTo 只出现在 rolled 结果里，',
  '    //    用旧 chat 查 participants 永远是空的 ⇒ 后台完全不会被截断。所以先取 rolled，再查 rolled.chat。',
  '    // ② 边界只按 seq（participant.rewindTo，该会话自己的 seq）；后台轮次独立于前台，绝不由 turn 反推。',
  '    // ③ 必须先 cancel + whenIdle（有界）+ flush：否则"前景已删、后台还在跑"，预检出的边界会漂移。',
  '    const rolled = storyTimeline.apply({ chat, intent: rollbackIntent })',
  '    const backgroundRewinds = []',
  '    for (const participant of Object.values(storyTimeline.inspect({ chat: rolled.chat }).participants || {})) {',
  "      if (participant.status !== 'needs-rewind' || !participant.sessionId) continue",
  '      let previewHandle',
  '      let preview = sessions.get(participant.sessionId)?.session || sessions.getSession?.(participant.sessionId)',
  '      if (!preview) {',
  "        if (typeof sessions.resume !== 'function') throw new Error('后台会话 ' + participant.sessionId + ' 尚未加载且宿主不支持 resume：无法在正文提交前完成停止与预检')",
  '        previewHandle = await sessions.resume(participant.sessionId)',
  '        preview = previewHandle?.agent?.session',
  '      }',
  '      try {',
  "        if (!preview) throw new Error('后台会话 ' + participant.sessionId + ' resume 后仍无活会话，拒绝在正文提交前继续')",
  '        const previewWorker = sessions.get(participant.sessionId) || previewHandle?.agent',
  "        if (previewWorker?.phase?.kind === 'running') {",
  "          if (typeof previewWorker.cancel === 'function') previewWorker.cancel({ kind: 'parent' })",
  "          if (typeof previewWorker.whenIdle === 'function') {",
  '            let timeout',
  '            try {',
  '              await Promise.race([previewWorker.whenIdle(), new Promise((_, reject) => {',
  "                timeout = setTimeout(() => reject(new Error('后台尚未停止：拒绝在运行中截断后台会话')), 3000)",
  '              })])',
  '            } finally { clearTimeout(timeout) }',
  '          }',
  '        }',
  "        if (typeof sessions.flush !== 'function') throw new Error('当前宿主未提供后台会话保存接口')",
  '        await sessions.flush(preview)',
  "        const plan = rollbackExport('preflightRollbackAtSeq')(preview, participant.rewindTo, {",
  '          strict: true, persistence: livePersistence, head: chats,',
  '          services: { ...liveServices, agentProvider: () => sessions.get(participant.sessionId) || previewWorker },',
  '        })',
  '        backgroundRewinds.push({ participant, plan })',
  '      } finally {',
  '        if (previewHandle) await previewHandle.dispose()',
  '      }',
  '    }',
].join('\n')

const COMMIT_NEXT = [
  `    ${ROLLBACK_MARKER} 3) 原生持久层：**物理截断（纯尾）**，取代原来的"空 surface 替换 + append-only 保留"。`,
  '    // 边界与四层接线已在上面的严格预检里核过；此处**不 catch-and-warn**：截断失败就响亮抛出',
  '    //（宁可报失败，也不假装回退成功），更不回头 try 恢复 oldchat（那正是删库之后的幽灵）。',
  '    // ⚠ 失败边界：Session transcript 与 Chat 是**两个库**，本步与上面的正文 update 不构成跨库原子事务。',
  '    //   此处抛错时的状态是「Chat 已回退、transcript 未截断」（rollbackUndo.ready=false），由上层报错，',
  '    //   不静默、不伪造成功；收敛需要重试或人工介入。',
  "    await rollbackExport('cleanupAfterRollback')(livePersistence, session, chats, chat.id, hiddenTurn, liveServices, {",
  '      strict: true, preflight: rollbackPreflight, head: chats,',
  '    })',
].join('\n')

const TAIL_NEXT = [
  `    ${ROLLBACK_MARKER} T3 L4：被回退轮的 head 痕迹清理（四类索引 / 世界书投递缓存 / 时间线账本 / rollbackUndo）。`,
  '    // ⚠ 必须排在作者**最后一次写 head**（上面的 rollback.undo-point）之后，',
  '    //   否则作者那次整档写回会把刚删掉的条目原样带回来（2026-09-28 实测踩过）。',
  "    await rollbackExport('cleanupRollbackHeadIndex')(chats, chat.id, hiddenTurn)",
  '    // 读回**最新**的 chat 再交给视图：L4 已把 rollbackUndo 从 head 删掉，不能返回还带着旧 head undo 的视图。',
  '    chat = await readChat(chat.id) || chat',
  ROLLBACK_ANCHORS.rollbackTail,
].join('\n')

const UNDO_POINT_NEXT = '        current.rollbackUndo = { ...undo, ready: false, branchId: current.timeline.branchId, revision: current.timeline.revision,'

// strict 段落的三处 warning 式 fallback ⇒ 响亮拒绝（都发生在任何突变之前）。
const PREPARE_NEXT = [
  `    ${ROLLBACK_MARKER} strict：快照缺失/读取失败 ⇒ 在**任何突变之前**抛错；`,
  '    // 不再降级成 rollbackWarning + allowMissingHistory（那会让"回退已完成"带着缺快照的半状态）。',
  '    const rollbackIntent = await prepareRollbackIntent(chat, { kind: \'turn.rollback\', turn: hiddenTurn, legacyBefore })',
].join('\n')

const CANCEL_SETTLEMENT_NEXT = [
  `    ${ROLLBACK_MARKER} strict：后台停止请求失败 ⇒ 拒绝继续（不 warn 后带着还在跑的后台进入删除）。`,
  '    if (typeof cancelSettlement === \'function\') await cancelSettlement(chat.id, { wait: false })',
].join('\n')

const PARTICIPANT_CANCEL_NEXT = [
  `    ${ROLLBACK_MARKER} strict：取消参与者 worker 失败 ⇒ 抛出（不吞掉：吞掉会在后面变成边界漂移）。`,
  '    for (const participant of Object.values(storyTimeline.inspect({ chat }).participants || {})) {',
  '      const worker = sessions.get(participant.sessionId)',
  '      if (worker && worker !== agent && typeof worker.cancel === \'function\') worker.cancel({ kind: \'parent\' })',
  '    }',
].join('\n')

const BACKGROUND_REWIND_NEXT = [
  `    ${ROLLBACK_MARKER} 后台参与者：**物理截断**（按该会话自己的 rewindTo seq 边界），取代作者的"空 surface 替换"。`,
  '    // 预检已在正文 update 之前完成（Phase A）；这里**错误响亮**（不再 warn 后当作已完成）。',
  '    // `noop:true` = 整个落在边界内（核对过的无事可做）⇒ 不报"已物理回退"，也不动库。',
  '    for (const entry of backgroundRewinds) {',
  '      const participant = entry.participant',
  '      let restoredHandle',
  '      try {',
  '        let worker = sessions.get(participant.sessionId)',
  "        let background = worker?.session || sessions.getSession?.(participant.sessionId)",
  "        if (!background && typeof sessions.resume === 'function') {",
  '          restoredHandle = await sessions.resume(participant.sessionId)',
  '          worker = restoredHandle.agent',
  '          background = worker?.session',
  '        }',
  "        if (!background) throw new Error('后台会话 ' + participant.sessionId + ' 尚未加载，拒绝假装已完成物理回退')",
  "        if (worker?.phase?.kind === 'running') throw new Error('后台会话 ' + participant.sessionId + ' 仍在运行：Phase A 的停止未生效，拒绝截断')",
  "        if (typeof sessions.flush !== 'function') throw new Error('当前宿主未提供后台会话保存接口')",
  '        const backgroundAgent = worker || restoredHandle?.agent',
  "        await rollbackExport('cleanupAfterRollbackAtSeq')(livePersistence, background, participant.rewindTo, {",
  '          ...liveServices,',
  '          agentProvider: () => backgroundAgent,',
  '        }, { strict: true, preflight: entry.plan, head: chats })',
  '        await sessions.flush(background)',
  '        // [dsh-tavern-background-rewind-complete:v1]',
  '        const settled = await updateChat(chat.id, current => {' ,
  '          const live = current.timeline?.participants?.[participant.role]',
  "          if (!live || live.sessionId !== participant.sessionId || live.status !== 'needs-rewind' || live.rewindTo !== participant.rewindTo) throw new Error('后台参与者状态已漂移，拒绝静默标记完成')",
  "          current.timeline.participants[participant.role] = { ...live, status: 'current', boundary: participant.rewindTo, rewindTo: null, syncedRevision: current.timeline.revision, updatedAt: Date.now() }",
  '          return current',
  "        }, { source: 'rollback.background-rewind-complete' })",
  '        chat = settled || chat',
  '      } finally {',
  '        if (restoredHandle) {',
  '          try { await restoredHandle.dispose() }',
  "          catch (error) { throw new Error('后台回退后释放临时会话失败：' + str(error?.message || error), { cause: error }) }",
  '        }',
  '      }',
  '    }',
].join('\n')

const UNDO_ROLLBACK_NEXT = [
  '  async function undoRollback(sessionId, chatId) {',
  `    ${ROLLBACK_MARKER} 物理清除语义：被回退轮的正文/变量/索引已从库里删除，撤销回退只能靠历史 revision 重建 ——`,
  '    // 那会得到"正文与变量不一致"的幽灵状态。⇒ **明确拒绝**（不再从 revision 重建、不静默返回旧快照）。',
  '    void sessionId',
  '    void chatId',
  "    throw new Error('回退已物理清除，不可撤销：被回退轮的正文/变量/索引已从库中删除（不提供 undo，也不从历史 revision 重建）')",
  '  }',
  '',
  ROLLBACK_ANCHORS.undoRollbackTail,
].join('\n')

// 既有已完整v1代的后台循环，用于精确升级；只移除本轮新增片段，保留原缩进/失败语义。
const BACKGROUND_REWIND_OLD = BACKGROUND_REWIND_NEXT
  .replace('        const backgroundAgent = worker || restoredHandle?.agent\n', '')
  .replace('          agentProvider: () => backgroundAgent,', '          agentProvider: () => sessions.get(participant.sessionId) || restoredHandle?.agent,')
  .replace(/        \/\/ \[dsh-tavern-background-rewind-complete:v1\][\s\S]*?        chat = settled \|\| chat\n/, '')
const COMPLETION_MARKER = '// [dsh-tavern-background-rewind-complete:v1]'

/** 施缝完成后必须**同时**具备的片段（缺一即视为半施，拒绝放行）。 */
export const ROLLBACK_MARKERS = Object.freeze([
  IMPORT_LINE.trimEnd(),
  "chat.suppressedDshTurns = []",
  "const rollbackIntent = await prepareRollbackIntent(chat, { kind: 'turn.rollback', turn: hiddenTurn, legacyBefore })",
  "if (typeof cancelSettlement === 'function') await cancelSettlement(chat.id, { wait: false })",
  'if (worker && worker !== agent && typeof worker.cancel === \'function\') worker.cancel({ kind: \'parent\' })',
  "rollbackExport('preflightRollback')(session, hiddenTurn",
  "rollbackExport('preflightRollbackAtSeq')(preview, participant.rewindTo",
  'for (const participant of Object.values(storyTimeline.inspect({ chat: rolled.chat }).participants',
  "rollbackExport('cleanupAfterRollback')(livePersistence",
  "rollbackExport('cleanupAfterRollbackAtSeq')(livePersistence, background, participant.rewindTo",
  'for (const entry of backgroundRewinds) {',
  'current.rollbackUndo = { ...undo, ready: false',
  "rollbackExport('cleanupRollbackHeadIndex')(chats, chat.id, hiddenTurn",
  '回退已物理清除，不可撤销',
])

/** 出现即说明**别人**已经接过回退清理：拒绝叠加（A 例那种"空 surface + cleanup"接线）。 */
const FOREIGN_MARKERS = Object.freeze(['cleanupAfterRollback', 'preflightRollback', 'storage-rollback', 'rollback-cleanup'])

/** 是否已施过（幂等键：标记 + 全部片段）。 */
export function rollbackTransformApplied(source) {
  return typeof source === 'string' && source.includes(ROLLBACK_MARKER)
    && ROLLBACK_MARKERS.every(snippet => source.includes(snippet))
}

/** 锚点出现次数（测试/诊断用；≠1 即不可施缝）。 */
export function countAnchor(source, anchor) {
  let count = 0
  let index = source.indexOf(anchor)
  while (index >= 0) { count += 1; index = source.indexOf(anchor, index + anchor.length) }
  return count
}

function replaceOnce(source, anchor, next, label) {
  const hits = countAnchor(source, anchor)
  if (hits !== 1) {
    throw new Error(`回退接线锚点不唯一/未命中（${label}，命中 ${hits} 次）—— 作者版本不同或换行不是 LF；拒绝猜测施缝`)
  }
  const at = source.indexOf(anchor)
  return source.slice(0, at) + next + source.slice(at + anchor.length)
}

/**
 * 纯 transform：作者 `lib/domain/round-history.js` 源码 → 施缝后的源码。
 * **幂等**：已施过 ⇒ `{ changed: false }` 且 text 原样返回。
 * **失败关闭**：半施状态、他人接线、锚点不唯一、未知作者版本 ⇒ 抛错（绝不静默返回原文冒充成功）。
 * @returns {{ text: string, changed: boolean, version: number, markers: string[] }}
 */
export function applyRollbackTransform(source) {
  if (typeof source !== 'string' || source === '') throw new Error('applyRollbackTransform：需要作者 round-history.js 的源码文本')
  // 新唯一编排已替代整个函数；v1转换不得再按旧片段判半施或重新注入旧路径。
  if (source.includes('// [dsh-tavern-clean-rollback:v1]')) return { text: applyCleanRollbackTransform(source), changed: false, version: ROLLBACK_TRANSFORM_VERSION, markers: [] }
  if (rollbackTransformApplied(source)) {
    if (source.includes(COMPLETION_MARKER)) {
      if (!source.includes(BACKGROUND_REWIND_NEXT)) throw new Error('后台完成标记与当前消费者不一致，拒绝半升级')
      return { text: source, changed: false, version: ROLLBACK_TRANSFORM_VERSION, markers: [...ROLLBACK_MARKERS] }
    }
    const text = replaceOnce(source, BACKGROUND_REWIND_OLD, BACKGROUND_REWIND_NEXT, '既有v1后台清理完成升级')
    return { text, changed: true, version: ROLLBACK_TRANSFORM_VERSION, markers: [...ROLLBACK_MARKERS] }
  }
  if (source.includes(ROLLBACK_MARKER)) {
    throw new Error('round-history.js 处于半施状态（有 core-rollback v1 标记但片段不全）—— 拒绝猜测合并，请用首次原像还原后重施')
  }
  const foreign = FOREIGN_MARKERS.filter(marker => source.includes(marker))
  if (foreign.length > 0) {
    throw new Error('作者 round-history.js 已存在他人的回退清理接线（' + foreign.join('、') + '）—— 拒绝叠加，请先还原作者原样')
  }
  const anchors = ROLLBACK_ANCHORS
  if (source.includes('  async function rollbackRecent(') || source.includes('  async function regenRecent(')) {
    let latest = replaceOnce(source, anchors.import, anchors.import + '\n' + IMPORT_LINE.trimEnd() + '\n' + ROLLBACK_MARKER, '新布局import锚点')
    latest = replaceOnce(latest, anchors.signature, SIGNATURE_NEXT, '新布局createRoundHistory参数表')
    return { text: applyLatestCleanRollbackTransform(latest), changed: true, version: ROLLBACK_TRANSFORM_VERSION, markers: [] }
  }
  let out = replaceOnce(source, anchors.import, anchors.import + '\n' + IMPORT_LINE.trimEnd(), 'import 锚点')
  out = replaceOnce(out, anchors.signature, SIGNATURE_NEXT, 'createRoundHistory 参数表')
  out = replaceOnce(out, anchors.suppressed, SUPPRESSED_NEXT, 'suppressedDshTurns 累积')
  out = replaceOnce(out, anchors.prepareFallback, PREPARE_NEXT, 'prepareRollbackIntent 的 catch fallback')
  out = replaceOnce(out, anchors.cancelSettlementCatch, CANCEL_SETTLEMENT_NEXT, 'cancelSettlement 的 catch-warn')
  out = replaceOnce(out, anchors.participantCancelCatch, PARTICIPANT_CANCEL_NEXT, '参与者 cancel 的吞错')
  out = replaceOnce(out, anchors.rollbackCommit, PREFLIGHT_NEXT, '正文提交前的预检插入点')
  out = replaceOnce(out, anchors.emptySurface, COMMIT_NEXT, '空 surface try/catch 块')
  out = replaceOnce(out, anchors.backgroundRewind, BACKGROUND_REWIND_NEXT, '后台参与者表面补偿循环')
  out = replaceOnce(out, anchors.undoPoint, UNDO_POINT_NEXT, 'rollback.undo-point 的 ready 标志')
  out = replaceOnce(out, anchors.rollbackTail, TAIL_NEXT, 'rollbackChat 收尾视图')
  // undoRollback：函数体整体替换（签名 → 文件末尾的 Object.freeze 返回）——物理清除后不可撤销。
  const head = out.indexOf(anchors.undoRollbackHead)
  if (out.indexOf(anchors.undoRollbackHead, head + 1) >= 0 || head < 0) throw new Error('回退接线锚点不唯一/未命中（undoRollback 签名）—— 拒绝猜测施缝')
  const tail = out.indexOf(anchors.undoRollbackTail, head)
  if (tail < 0 || out.indexOf(anchors.undoRollbackTail, tail + 1) >= 0) throw new Error('回退接线锚点不唯一/未命中（undoRollback 结尾 Object.freeze）—— 拒绝猜测施缝')
  out = out.slice(0, head) + UNDO_ROLLBACK_NEXT + out.slice(tail + anchors.undoRollbackTail.length)
  const result = { text: out, changed: true, version: ROLLBACK_TRANSFORM_VERSION, markers: [...ROLLBACK_MARKERS] }
  if (!rollbackTransformApplied(out)) throw new Error('内部错误：施缝后自检失败（片段不全），拒绝输出半成品')
  return result
}

// ---------------------------------------------------------------------------
// CLI（薄壳；**只检查，不写盘** —— 写盘/备份/语法闸/卸载由主入口的施缝层负责）
// ---------------------------------------------------------------------------
function runCli() {
  const args = process.argv.slice(2)
  const file = args.find(arg => !arg.startsWith('--'))
  if (file === undefined) {
    console.error('用法：node deploy/core-rollback-transform.mjs --check <作者树 lib/domain/round-history.js>（只检查，不写盘）')
    process.exit(1)
  }
  const source = readFileSync(path.resolve(file), 'utf8')
  const result = applyRollbackTransform(source)
  console.log(`${result.changed ? '✗ 需要施缝' : '✓ 已是最新'}：${path.resolve(file)}（transform v${result.version}，${result.markers.length} 个片段）`)
  if (result.changed) console.log('  用主入口 apply（备份 + 写入 + node --check + 失败还原）；本 CLI 不写盘。')
  process.exit(result.changed ? 3 : 0)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runCli() } catch (error) { console.error('✗ ' + String(error?.message || error)); process.exit(1) }
}

// ---------------------------------------------------------------------------
// 剩余义务（不得当成已完成）
//   1. 作者 `lib/index.js`（**主 owned** `deploy/core-host-transform.mjs`）：注入六个 provider +
//      `chats.readSlice`（L4 需要）—— 2026-10-01 已由主接线落地。缺任一项 ⇒ 回退预检明确拒绝
//      （不是回退一半）。变量 `variableStore` 只保留注入位：变量与存档统一进同一 archive 事务后，
//      尾部 DELETE 已覆盖，不再单独 `deleteFrom`（避免双删）。
//   2. 作者树 `lib/domain/storage-rollback.js`（**主 owned** 薄垫片）除原有四名外，**还需转出**
//      `preflightRollbackAtSeq` / `cleanupAfterRollbackAtSeq`（后台 seq 轴）；缺哪个就在后台参与者
//      预检处**响亮抛错**（`storage-rollback.js 未导出 …`），不会静默半回退。
//   3. 后台物理回退**已由本 transform 落地**：`const rolled` 提前到纯计算处 → Phase A（每个 needs-rewind
//      参与者 cancel + whenIdle(3s) + flush → `preflightRollbackAtSeq`，未加载者 resume 预检后**立即释放**）
//      → 正文 update → Phase B（`cleanupAfterRollbackAtSeq` 物理截断 + flush；未加载者再 resume，
//      句柄在 finally 释放；仍在运行 ⇒ 响亮拒绝）。边界 = `participant.rewindTo`（该会话自己的 seq；
//      `-1` = 新建 ⇒ 保留第一个 turn/start 之前的初始事件；turn/start 就是第一条 ⇒ 预检**拒绝**）；
//      整个落在边界内 ⇒ `noop:true`（不报"已物理回退"）。仍未做（留给主）：作者 `background-surface.js`
//      本身没改（`rewindBackgroundSurface` 退化为未调用 import）；participant 落 `current`/`syncedRevision`
//      的时间线语义不变；Phase A/B 共两次 resume（Phase A 已 stop+flush ⇒ 复检边界；若主另建"一次 resume
//      全程持有 + try/finally"的模块 API，可替换 Phase A）。
//   3b. 刻意保留（**不在 strict 段**）：脚本联动失败、rollback.undo-point 保存失败仍写成
//      `rollbackWarning`（两者都在正文/transcript 已提交之后，属于"已完成但某副作用失败"的通知，不是
//      半状态兜底；L4 仍会把 ready:false 的 rollbackUndo 删掉）。若要求这两处也硬拒，需另批。
//   4. L1.5 已升级为**硬判据**（`stateOf(session,'turnBoundary').lastTurn` 非有效数 ⇒ 预检硬拒），
//      与 `rewindRuntimeTurnCounter` 的值级行为一致；调用方必须给 `agentProvider` 传**对应会话**
//      的 agent（前台 = chat.sessionId；后台 = participant.sessionId），否则会回拨错对象。
//   5. 客户端 resync（补丁 ⑧，主 `applyClientRollbackTransform`）与真机连续回退验收不在本 transform 范围。
// ---------------------------------------------------------------------------
