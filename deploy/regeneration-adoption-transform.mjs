// 原按钮/临时生成/结算不改，替换作者遮蔽采用与历史revision恢复消费者。
import {applyRollbackOperationTransform} from './rollback-operation-transform.mjs'
const MARKER='// [dsh-tavern-regeneration-physical:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('正文物理采用锚点缺失/不唯一：'+old.slice(0,100));return source.replace(old,next)}
export function applyRegenerationAdoptionTransform(source){
 if(source.includes(MARKER)){
  for(const key of ['const regenerationRecovery = createRegenerationAdoption(', 'const adoption = regenerationRecovery.plan(', 'restore: regenerationRestore.record'])if(!source.includes(key))throw Error('正文物理采用接线不完整')
  return applyRollbackOperationTransform(source)
 }
 source=once(source,"import { createRegenerationRecovery } from './regeneration-recovery.js'",MARKER+"\nimport { createRegenerationAdoption } from './storage-rollback.js'")
 source=once(source,'  const regenerationRecovery = createRegenerationRecovery({ chats, sessions, timeline, isActive: id => pendingRegenerations.has(id) })',`  const regenerationRecovery = createRegenerationAdoption({ chats, sessions, timeline, sessionPatch,
    persistenceProvider, projectionsProvider, projectionCacheProvider, tokenMeterProvider,
    rollbackSyncProvider, quiesceRollback, cleanupRollbackSides })`)
 source=once(source,'    const { eventStart, msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource } = selection','    const { msgs0, oldAssistantIndex, oldSeq, oldTurn, oldSource } = selection\n    let eventStart = selection.eventStart')
 source=once(source,'    let originalChat = structuredClone(chat)',`    const regenerationRestore = await regenerationRecovery.prepare(chat, { ...selection, oldAssistantIndex })
    chat = regenerationRestore.chat
    eventStart = regenerationRestore.record.eventStart
    let originalChat = structuredClone(chat)`)
 source=once(source,'        ...(Number(current._storageRevision || 0) ? {} : { before: structuredClone(current) }),','        restore: regenerationRestore.record,')
 source=once(source,'      next.regenRecovery = { id: operationId, beforeRevision: Number(current._storageRevision || 0),','      next.regenRecovery = { id: operationId, turn: oldTurn,')
 source=once(source,"        next.regenRecovery = { ...current.regenRecovery, phase: 'committed', projection }",`        next.regenRecovery = { ...current.regenRecovery, phase: 'committed', projection, adoption }`)
 source=once(source,'        const next = merged.chat\n        retainRegenerationRollbackState(next, originalChat, regenerationCheckpoint)',`        const adoption = regenerationRecovery.plan(session, { oldTurn, syntheticTurn, eventStart, oldSeq, chatId: chat.id })\n        const next = regenerationRecovery.adopted(merged.chat, { oldTurn, syntheticTurn, generatedAssistant: currentAssistant, originalAssistant: originalChat.messages[oldAssistantIndex], adoption })
        retainRegenerationRollbackState(next, originalChat, regenerationCheckpoint)`)
 source=once(source,`        next.regeneratedDshTurns = next.regeneratedDshTurns && typeof next.regeneratedDshTurns === 'object' && !Array.isArray(next.regeneratedDshTurns)
          ? structuredClone(next.regeneratedDshTurns) : {}
        next.regeneratedDshTurns[String(oldTurn)] = syntheticTurn`,'        // 新输出已物理写回原turn，不创建临时轮别名。')
 source=once(source,'        next.suppressedDshTurns = Array.from(new Set((Array.isArray(next.suppressedDshTurns) ? next.suppressedDshTurns : []).concat([syntheticTurn]))).sort(function (left, right) { return left - right })','        // 本次临时轮从SQL事件尾真正删除，不靠suppressed隐藏。')
 // 失败恢复不调用作者空消息覆盖；提交后原生采用失败保留同SQL可重入意图。
 source=once(source,'    result.adopted = { text: body, guidance: guide, hiddenTurn: oldTurn, syntheticTurn: syntheticTurn }','    result.adopted = { text: body, guidance: guide, hiddenTurn: oldTurn, syntheticTurn: oldTurn }')
 return applyRollbackOperationTransform(source)
}
