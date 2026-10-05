// 后台任务入口不再调用作者软surface回退；纯文本转换，未知锚点拒绝。
const TASK_MARKER = '// [dsh-tavern-background-task-rewind:v1]'
const HOST_MARKER = '// [dsh-tavern-background-host-rewind:v1]'
function once(source, old, next) {
  if (source.split(old).length !== 2) throw new Error('后台物理回退锚点缺失/不唯一：' + old.slice(0, 80))
  return source.replace(old, next)
}
export function applyBackgroundTaskRollbackTransform(source) {
  const next = `    ${TASK_MARKER}
    try {
      if (Number.isSafeInteger(input.rewindTo)) {
        if (typeof options.rewindSession !== 'function') throw new Error('后台任务缺少插件物理回退接线')
        await options.rewindSession(agent, input.rewindTo)
      }
    }`
  const boundaryMarker='// [dsh-tavern-background-task-boundary:v1]'
  function boundaryAfterRewind(value){
    if(value.includes(boundaryMarker))return value
    return once(value,'    const progress = createBackgroundProgress(',`    ${boundaryMarker}
    if (typeof options.recordRollbackBoundary !== 'function') throw new Error('缺少后台任务seq归属记录')
    await options.recordRollbackBoundary(input, agent.session)
    const progress = createBackgroundProgress(`)
  }
  const oldCatch = "    catch (error) { throw new Error('后台历史回退失败，本次任务已停止，未基于旧上下文继续执行。', { cause: error }) }"
  const newCatch = `    catch (error) {
      // [dsh-tavern-background-rewind-cause:v1] 保留可定位的清理层与预检code，不吞为泛化失败。
      const code = typeof error?.code === 'string' ? error.code : 'BACKGROUND_REWIND_FAILED'
      const wrapped = new Error('后台历史回退失败，本次任务已停止，未基于旧上下文继续执行。原因 [' + code + ']：' + String(error?.message || error), { cause: error })
      wrapped.code = code
      wrapped.traceSessionId = traceSessionId
      throw wrapped
    }`
  if (source.includes(TASK_MARKER)) {
    if (!source.includes(next) || source.includes('try { rewindBackgroundSurface(')) throw new Error('后台回退标记与消费者不一致')
    if (source.includes(newCatch)) return boundaryAfterRewind(source)
    return boundaryAfterRewind(once(source, oldCatch, newCatch))
  }
  return boundaryAfterRewind(once(once(source, '    try { rewindBackgroundSurface(agent.session, input.rewindTo) }', next), oldCatch, newCatch))
}
export function applyBackgroundHostRollbackTransform(source) {
  const old = `  ${HOST_MARKER}
  const backgroundAgentRunner = createBackgroundAgentRunner({
    async rewindSession(agent, boundarySeq) {
      if (agent?.phase?.kind === 'running') throw new Error('后台运行中，拒绝截断')
      const persistence = ctx.get('sessionPersistence')
      const services = {
        projections: ctx.get('sessionProjections'), projectionCache: ctx.get('sessionProjectionCache'),
        agentProvider: () => agent, tokenMeterProvider: () => ctx.get('tokenMeter'),
      }
      const head = { readSlice: chatPersistence.readSlice, update: updateChat }
      await cleanupAfterRollbackAtSeq(persistence, agent.session, boundarySeq, services, { head })
    },`
  const next=old.replace("      const persistence = ctx.get('sessionPersistence')", `      // [dsh-tavern-background-task-cut-sync:v1] 必须在删前核同连接能力，删后发新任务前通知child基线。
      const sync = ctx.get('tavernRollbackSync')
      if (typeof sync?.publishSessionCut !== 'function') throw new Error('后台任务缺少同连接截断同步')
      sync.assertReady()
      const persistence = ctx.get('sessionPersistence')`).replace('      await cleanupAfterRollbackAtSeq(persistence, agent.session, boundarySeq, services, { head })','      await cleanupAfterRollbackAtSeq(persistence, agent.session, boundarySeq, services, { head })\n      // SQL已删但上次通知失败的重试会是noop，仍重置旧订阅；不把noop报成物理删除。\n      sync.publishSessionCut({ session: agent.session, agent })')
  if (source.includes(HOST_MARKER)) {
    if(source.includes('// [dsh-tavern-background-task-cut-sync:v1]')){if(!source.includes(next))throw new Error('后台同步标记与消费者不一致');return source}
    if (!source.includes(old)) throw new Error('后台回退Host标记与消费者不一致')
    return once(source,old,next)
  }
  return "import { cleanupAfterRollbackAtSeq } from './domain/storage-rollback.js'\n" + once(source,
    '  const backgroundAgentRunner = createBackgroundAgentRunner({', next)
}
