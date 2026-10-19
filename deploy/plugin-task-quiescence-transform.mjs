// 作者插件任务接缝：实际run与其已发起写入收尾后才静止；取消不能靠Promise.race提前释放。
const HOST='// [dsh-tavern-plugin-task-host:v1]',API='// [dsh-tavern-plugin-task-api:v1]'
export function needsPluginTaskSeams(source) {
 const modern=source.includes('run: runSettlementCycle') || source.includes('pluginApi.runManualTask(') || source.includes('pluginApi.runSettlementTasks(')
 if(modern && !source.includes('  const pluginTaskJobs = new Map()'))throw Error('插件任务运行接口存在但静止Map锚点缺失')
 return modern || source.includes('  const pluginTaskJobs = new Map()')
}
function once(source,old,next){if(source.split(old).length!==2)throw Error('插件任务接缝锚点缺失/不唯一：'+old.slice(0,100));return source.replace(old,next)}
export function applyPluginTaskHostTransform(source){
 if(!needsPluginTaskSeams(source))return source
 if(source.includes(HOST)){
  if(!source.includes('async function quiescePluginTasks(chat)')||!source.includes('job.controller = controller')||!source.includes('pluginTaskJobs.delete(chat.id)'))throw Error('插件任务Host静止接线不完整')
  return source
 }
 const start=source.indexOf('  async function startPluginTask(sessionId, key, input) {'),end=source.indexOf('  async function onSettlementSettled(',start)
 if(start<0||end<0)throw Error('插件任务Host运行函数缺失')
 const body=`  ${HOST}
  async function quiescePluginTasks(chat) {
    const job = pluginTaskJobs.get(chat.id)
    if (!job) return
    job.controller.abort(new Error('会话正在物理回退'))
    pluginApi.stopTasks(chat.sessionId)
    await job
  }
  async function startPluginTask(sessionId, key, input) {
    const chat = await taskStateReader.forSession(str(sessionId))
    if (!chat || !['story', 'script'].includes(chat.mode)) throw new Error('当前没有游玩对话')
    if (rollbackSchedulingBarrier.has(chat.sessionId) || chat.rollbackPending) throw new Error('会话正在物理回退，禁止新插件任务')
    if (agentRegistry.get(chat.sessionId)?.phase?.kind === 'running' || chat.regenInProgress) throw new Error('请等待正文生成完成后再运行插件任务')
    if (pluginTaskJobs.has(chat.id)) throw new Error('已有插件任务在运行，请等它完成')
    const controller = new AbortController()
    let admitted, rejectAdmission
    const admission = new Promise((resolve, reject) => { admitted = resolve; rejectAdmission = reject })
    // 先占位，再等待资格/后台登记，回退与并发启动均能看见整个准入过程。
    const job = Promise.resolve().then(async () => {
      let taskRun
      try {
        controller.signal.throwIfAborted()
        await pluginApi.manualTaskFor(chat.sessionId, key, input)
        controller.signal.throwIfAborted()
        taskRun = await backgroundTasks.begin(chat, 'plugin-task')
        controller.signal.throwIfAborted()
        admitted()
        await pluginApi.runManualTask({ gameId: chat.sessionId, key, input, operationId: taskRun.operationId, signal: controller.signal,
          onStart: label => pluginSettlementProgress.begin(chat.sessionId, label) })
      } catch (error) {
        rejectAdmission(error)
        if (!controller.signal.aborted) console.warn('dsh-tavern: 插件任务失败:', str(error?.message || error))
      } finally {
        controller.abort()
        if (taskRun) await taskRun.commit({ stateChanged: false }).catch(error => console.warn('dsh-tavern: 插件任务收尾失败:', str(error?.message || error)))
        if (pluginTaskJobs.get(chat.id) === job) pluginTaskJobs.delete(chat.id)
        sessionSignals.publish(chat.sessionId, { kind: 'tavern-state', version: 'cleanup-idle:' + Date.now() })
      }
    })
    job.controller = controller
    pluginTaskJobs.set(chat.id, job)
    await admission
    return { started: true }
  }
`
 source=source.slice(0,start)+body+source.slice(end)
 source=once(source,'      await cancelSettlement(chat.id, { wait: true })','      await cancelSettlement(chat.id, { wait: true })\n      await quiescePluginTasks(chat)')
 source=once(source,'    pluginApi.stopTasks(chat.sessionId)\n    backgroundAgentRunner.cancel(chat.sessionId)',"    pluginTaskJobs.get(chat.id)?.controller.abort(new Error('玩家停止了插件任务'))\n    pluginApi.stopTasks(chat.sessionId)\n    backgroundAgentRunner.cancel(chat.sessionId)")
 return source
}
export function applyPluginTaskApiTransform(source){
 if(source.includes(API)){
  if(!source.includes('await taskWork.catch(() => {})')||!source.includes('pluginTaskWrites.run(taskScope'))throw Error('插件任务API实际静止接线不完整')
  return source
 }
 // 新作者已有任务上下文；保留其operationId身份，不重复声明AsyncLocalStorage导入。
 source=(source.includes("import { AsyncLocalStorage } from 'node:async_hooks'")?'':"import { AsyncLocalStorage } from 'node:async_hooks'\n")+API+'\n'+source
 source=once(source,'  const taskRuns = new Map()','  const taskRuns = new Map()\n  const pluginTaskWrites = new AsyncLocalStorage()\n  function assertPluginTaskWritable() { pluginTaskWrites.getStore()?.signal.throwIfAborted() }')
 source=once(source,'    const finish = onStart?.(entry.owner + \' · \' + entry.title)',"    const taskScope = { signal: combined, pending: new Set() }\n    let taskWork\n    const finish = onStart?.(entry.owner + ' · ' + entry.title)")
 const contextual = '      const work = taskContext.run(scope, () => entry.run({ ...structuredClone(context), signal: combined, runAgent }))'
 if (source.includes('  const taskContext = new AsyncLocalStorage()')) {
  source=once(source,contextual,'      taskWork = Promise.resolve().then(() => { combined.throwIfAborted(); return pluginTaskWrites.run(taskScope, () => taskContext.run(scope, () => entry.run({ ...structuredClone(context), signal: combined, runAgent }))) })')
  source=once(source,'      await bounded(untilAborted(work, combined), stage,','      await bounded(untilAborted(taskWork, combined), stage,')
 } else {
  const old="      await bounded(untilAborted(entry.run({ ...structuredClone(context), signal: combined, runAgent }), combined), stage,"
  source=once(source,old,"      taskWork = Promise.resolve().then(() => { combined.throwIfAborted(); return pluginTaskWrites.run(taskScope, () => entry.run({ ...structuredClone(context), signal: combined, runAgent })) })\n      await bounded(untilAborted(taskWork, combined), stage,")
 }
 source=once(source,'      controller.abort()\n      if (taskRuns.get(context.gameId) === run)', '      controller.abort()\n      if (taskWork) await taskWork.catch(() => {})\n      while (taskScope.pending.size) await Promise.allSettled([...taskScope.pending])\n      if (taskRuns.get(context.gameId) === run)')
 // 仅任务可调用的作者写API：记录在途调用，取消后拒绝新的及跨await迟到写入。
 const writes=['saveTurnData','saveGameData','setVariables','editTurn','attach','update','remove']
 for(const name of writes){
  const anchors={saveTurnData:'      await deps.data.saveTurn(',saveGameData:'      await deps.data.saveGame(',setVariables:'      await deps.writeVariables(',editTurn:'      await deps.editText(',attach:'      const record = await deps.media.attach(',update:'      const record = await deps.media.patch(',remove:'      const removed = await deps.media.remove('}
  source=once(source,anchors[name],'      assertPluginTaskWritable()\n'+anchors[name])
 }
 const anchor='  /** One plugin task under Tavern\'s watch: bounded, stoppable, its failure recorded for the panel. */'
 const wrapping=`  // 仅插件任务作用域内记录已有写API，不改变普通用户调用的生命周期。
  for (const name of ${JSON.stringify(writes)}) {
    const write = service[name]
    service[name] = function (...args) {
      const scope = pluginTaskWrites.getStore()
      if (!scope) return write.apply(this, args)
      const pending = Promise.resolve().then(() => { scope.signal.throwIfAborted(); return write.apply(this, args) })
      scope.pending.add(pending)
      pending.finally(() => scope.pending.delete(pending)).catch(() => {})
      return pending
    }
  }
`
 return once(source,anchor,wrapping+anchor)
}
