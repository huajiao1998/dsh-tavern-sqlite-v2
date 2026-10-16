// 进程内屏障只保存会话ID，不保存业务负载；持久失败屏障由archive.rollbackPending承担。
const KEY=Symbol.for('dsh-tavern.rollback-barrier')
export const rollbackBarrier=globalThis[KEY] ||= new Set()
export const rollbackCancellationBarrier=globalThis[Symbol.for('dsh-tavern.rollback-cancellation-barrier')] ||= new Set()
export const rollbackSchedulingBarrier=globalThis[Symbol.for('dsh-tavern.rollback-scheduling-barrier')] ||= new Set()
export function assertRollbackSessionWritable(id) {
 if (rollbackBarrier.has(id)) throw new Error('会话正在物理回退，拒绝旧任务或新轮次写入')
}
export function assertRollbackChatWritable(chat,metadata) {
 if (chat?.mode === 'card' || metadata?.source === 'card-name.sync') return
 // 回退优先：rollback.prepare/complete 可与半态重生成竞争，迟到提交由各自 SQL 回执校验拒绝。
 if (['committed','aborting'].includes(chat?.regenRecovery?.phase) && !['foreground.regen-projected','foreground.regen-abort','foreground.regen-ready'].includes(metadata?.source) && !/^rollback\./.test(metadata?.source || '')) throw new Error('正文物理采用未完成，禁止旧任务写入；请先恢复重生成')
 if (chat?.rollbackPending && !/^rollback\.(prepare|complete)$/.test(metadata?.source || '')) throw new Error('物理回退未完成，请先重试回退；禁止基于半态继续游玩或写入')
}
