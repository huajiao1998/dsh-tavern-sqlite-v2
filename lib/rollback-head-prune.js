// 回退后的 head 索引修剪（L4）—— 实现在本包，由作者树 rollback-cleanup.js 的垫片转出
//
// 覆盖：head 四类索引（foregroundFrames / runtimeInputs / nativeCommits / timeline.checkpoints）
//      + 世界书投递缓存（preparedWorldBook / preparedWorldBookContext / lastWorldBookRecall / worldBookReads）
//      + 时间线操作账本（timeline.operations，含"删 body 不删引用它的 agent"的悬空引用处理）
//      + rollbackUndo（作者回退最后一步写的撤销点）
//
// ⚠ 调用时机（不可改）：必须在作者**最后一次写 head**（rollback.undo-point）之后 —— 作者那次整档写回
//   会把它自己那份还带着被回退轮的 head 原样写回，之前删的会被带回来（2026-09-28 实测踩过）。
//   ⇒ 因此触发点留在**知道真实 hiddenTurn 的编排层**（round-history），不下沉到 store：
//     store 的楼层数组里**没有轮次信息**（实测：chat-sqlite-store 全文无 per-message turn），
//     用"楼层数"反推 hiddenTurn 会差一轮 —— 正是 issues/bug-floor-turn-offset.md 那个坑。
//
// 代码逐字来自 tools/deployed-baseline/.../rollback-cleanup.js L299–L425（脚本提取，非手抄）。

const HEAD_INDEX_FIELDS = [
  'foregroundFrames', 'runtimeInputs', 'nativeCommits', 'timeline.checkpoints',
  'preparedWorldBook', 'preparedWorldBookContext', 'lastWorldBookRecall', 'worldBookReads',
  'rollbackUndo', 'timeline.operations'
]

/** 操作条目里"已终态"的状态集合（在途条目绝不删：推进中的完成路径还要按 id 找它）。 */
const TERMINAL_OPERATION_STATUS = new Set(['completed', 'failed', 'stale', 'cancelled'])

/**
 * L4 的就地清理：删除 `turn >= hiddenTurn` 的痕迹（hiddenTurn = 要删的那一轮）。
 * 覆盖（全部按"被回退那一轮"判定，不碰更早的轮次）：
 *   · head 四类索引：foregroundFrames / runtimeInputs / nativeCommits / timeline.checkpoints
 *   · 世界书投递缓存：preparedWorldBook（置 null）+ preparedWorldBookContext（置 ''）
 *     + lastWorldBookRecall（置 null）+ worldBookReads 里该轮的"已读"记录
 *   · 时间线操作账本 timeline.operations：该轮的正文操作 + 引用它们的 agent 操作
 *     （agent 靠 roundOperationId 指向 body，删 body 不删引用它的 agent 会留悬空引用）；
 *     只删已终态的条目，在途（running/pending/deferred）保留但摘掉悬空引用。
 *   · rollbackUndo：作者在回退最后一步写的撤销点，指向的正是被回退的那一轮 → 一并删。
 * ⚠️ 必须在作者最后一次写 head（`rollback.undo-point`）**之后**调用：作者那次整档写回
 *   会把它自己那份还带着被回退轮的 head 原样写回，之前删的会被带回来（2026-09-28 实测踩过）。
 * 只用 `chats.readSlice` 的小快照做"有没有东西要删"的探测（结构化克隆，改它无副作用），
 * 真正删除在 `chats.update` 的 current 上重算（store 串行写入，避免读改写之间被并发写入插队）。
 * @returns 删除/清空的项数
 */
function pruneRollbackIndex(container, hiddenTurn) {
  let removed = 0
  const index = container
  const staleTurn = (turn) => Number.isFinite(Number(turn)) && Number(turn) >= hiddenTurn
  if (index.foregroundFrames && typeof index.foregroundFrames === 'object') {
    for (const key of Object.keys(index.foregroundFrames)) {
      if ((index.foregroundFrames[key].turn ?? 0) >= hiddenTurn) {
        delete index.foregroundFrames[key]
        removed++
      }
    }
  }
  if (index.runtimeInputs && typeof index.runtimeInputs === 'object') {
    for (const key of Object.keys(index.runtimeInputs)) {
      if (Number(key) >= hiddenTurn) {
        delete index.runtimeInputs[key]
        removed++
      }
    }
  }
  if (index.nativeCommits && typeof index.nativeCommits === 'object') {
    for (const key of Object.keys(index.nativeCommits)) {
      if (Number(key) >= hiddenTurn) {
        delete index.nativeCommits[key]
        removed++
      }
    }
  }
  if (Array.isArray(index.timeline?.checkpoints)) {
    const before = index.timeline.checkpoints.length
    index.timeline.checkpoints = index.timeline.checkpoints.filter((checkpoint) => (checkpoint.turn ?? 0) < hiddenTurn)
    removed += before - index.timeline.checkpoints.length
  }
  if (staleTurn(index.preparedWorldBook?.turn)) {
    index.preparedWorldBook = null
    index.preparedWorldBookContext = ''
    removed++
  }
  if (staleTurn(index.lastWorldBookRecall?.turn)) {
    index.lastWorldBookRecall = null
    removed++
  }
  if (index.worldBookReads && typeof index.worldBookReads === 'object') {
    for (const [ref, read] of Object.entries(index.worldBookReads)) {
      if (staleTurn(read?.turn)) {
        delete index.worldBookReads[ref]
        removed++
      }
    }
  }
  const operations = index.timeline?.operations
  if (operations !== undefined && operations !== null && typeof operations === 'object') {
    const droppedBodies = new Set()
    for (const [id, operation] of Object.entries(operations)) {
      if (operation?.kind !== 'body') continue
      if (!staleTurn(operation.turn)) continue
      if (!TERMINAL_OPERATION_STATUS.has(String(operation.status))) continue
      delete operations[id]
      droppedBodies.add(id)
      removed++
    }
    for (const [id, operation] of Object.entries(operations)) {
      if (operation?.kind !== 'agent') continue
      if (!droppedBodies.has(String(operation.roundOperationId))) continue
      if (TERMINAL_OPERATION_STATUS.has(String(operation.status))) {
        delete operations[id]
        removed++
      } else {
        // 在途条目保留（完成路径还要按 id 找它），但不留悬空引用
        delete operation.roundOperationId
      }
    }
  }
  if (staleTurn(index.rollbackUndo?.turn)) {
    delete index.rollbackUndo
    removed++
  }
  return removed
}

/**
 * L4：head 四类索引 + 时间线操作账本清理 —— 删除 `turn >= hiddenTurn` 的痕迹
 * （hiddenTurn = 要删的那一轮）。
 * ⚠️ 读必须用 `chats.readSlice`：`chats.readState`（= `chatPersistence.readSessionState`）返回的是
 *   `projectChatSessionState` 的**投影**（白名单键里没有 foregroundFrames / runtimeInputs / nativeCommits）
 *   → 拿它做删除会"一项都不匹配 → changed=false → 静默不写"。2026-09-28 生产实测踩过：回退后
 *   `foregroundFrames[233]` / `runtimeInputs["233"]` 仍留在 head，UI 继续渲染被回退那一轮。
 * @returns 删除的条目数
 */
export async function cleanupRollbackHeadIndex(chats, chatId, hiddenTurn) {
  if (typeof chats?.readSlice !== 'function') throw new Error('回退清理：聊天存储缺少 readSlice（读不到 head 索引字段）')
  if (typeof chats?.update !== 'function') throw new Error('回退清理：聊天存储缺少 update（写不回 head 索引字段）')
  const snapshot = await chats.readSlice(chatId, [], HEAD_INDEX_FIELDS)
  if (snapshot === undefined) throw new Error(`回退清理：聊天 ${chatId} 的索引字段读不到（readSlice 返回 undefined）`)
  if (pruneRollbackIndex(snapshot.chat, hiddenTurn) === 0) return 0
  let removed = 0
  await chats.update(chatId, (current) => {
    removed = pruneRollbackIndex(current, hiddenTurn)
    return current
  }, { source: 'rollback.cleanup' })
  return removed
}
