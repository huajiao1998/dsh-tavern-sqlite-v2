// 捕获所有后台会话发任务前的独立seq切点，并等待队列+run+释放全过程。
const MARKER='// [dsh-tavern-rollback-background-lifetime:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('后台整体run锚点未命中/不唯一：'+old.slice(0,100));return source.replace(old,next)}
export function applyRollbackBackgroundLifetimeTransform(source){
 function creationBoundary(value){
  const disposeAnchor='      } catch (error) {\n        const wrapped = traceError(error, traceSessionId, input.task)'
  if(value.includes('// [dsh-tavern-background-identity-boundary:v2]'))return value
  if(value.includes('// [dsh-tavern-background-created-boundary:v1]'))return value.includes(disposeAnchor)?once(value,disposeAnchor,'      } catch (error) {\n        if(handle!==undefined){await handle.dispose();handle=undefined}\n        const wrapped = traceError(error, traceSessionId, input.task)'):value
  let next=once(value,'      } catch (error) {\n        const wrapped = traceError(error, traceSessionId, input.task)',`      } catch (error) {
        if(handle!==undefined){await handle.dispose();handle=undefined}
        const wrapped = traceError(error, traceSessionId, input.task)`)
  return once(next,"          // Publish identity before the first model turn, including failed starts.",`          // [dsh-tavern-background-created-boundary:v1]
          try {
            if(typeof options.recordRollbackBoundary!=='function')throw new Error('新后台会话缺少创建归属接线')
            await options.recordRollbackBoundary(input,handle.agent.session)
          } catch(error) {
            // 未登记归属就不能追加descriptor或进入任务；保留错误，必须释放已取得句柄。
            await handle.dispose()
            handle=undefined
            throw error
          }
          // Publish identity before the first model turn, including failed starts.`)
 }
 function identityBoundary(value){
  if(value.includes('// [dsh-tavern-background-identity-boundary:v2]'))return value
  const start=value.indexOf('          // [dsh-tavern-background-created-boundary:v1]')
  const end=value.indexOf('          // Publish identity before the first model turn, including failed starts.',start)
  if(start<0 || end<start)throw Error('后台创建切点迁移锚点缺失')
  const block=value.slice(start,end).replace('// [dsh-tavern-background-created-boundary:v1]','// [dsh-tavern-background-identity-boundary:v2]').replace('未登记归属就不能追加descriptor或进入任务','身份已建立，但未登记归属就不能进入任务')
  const without=value.slice(0,start)+value.slice(end)
  return once(without,"          handle.agent.session.append('subagent/descriptor', descriptor)","          handle.agent.session.append('subagent/descriptor', descriptor)\n"+block.trimEnd())
 }
 if(source.includes(MARKER)){if(!source.includes('async function whenIdle(parentId)'))throw Error('后台整体run标记不完整');return identityBoundary(creationBoundary(source))}
 let next="import { rollbackSchedulingBarrier } from './domain/storage-rollback-business.js'\n"+MARKER+'\n'+source
 next=once(next,'  async function execute(input) {',"  async function execute(input) {\n    if (rollbackSchedulingBarrier.has(input.sessionId)) throw new Error('物理回退期间禁止新后台任务')")

 next=once(next,'        void Promise.resolve().then(async () => {','        await Promise.resolve().then(async () => {')
 next=once(next,'  function run(input) {','  function runNow(input) {')
 next=once(next,'  function owns(sessionId) {',`  const pendingRuns=new Map()
  function run(input) {
    if(rollbackSchedulingBarrier.has(input.sessionId))return Promise.reject(new Error('物理回退期间禁止新后台任务'))
    const task=runNow(input)
    pendingRuns.set(task,input.sessionId)
    task.finally(()=>pendingRuns.delete(task)).catch(()=>{})
    return task
  }
  async function whenIdle(parentId) {
    while(true){const active=[...pendingRuns].filter(([,id])=>id===parentId).map(([task])=>task);if(!active.length)return;await Promise.allSettled(active)}
  }
  function owns(sessionId) {`)
 next=once(next,'return Object.freeze({ progress, run,','return Object.freeze({ progress, run, whenIdle, clearRollbackState,')
 next=once(next,'  function owns(sessionId) {',`  async function clearRollbackState(parentId) {
    await whenIdle(parentId)
    for(const [id,resident] of residentHandles){
      if(resident.parentSessionId!==parentId)continue
      const state=resident.state
      delete state.currentWorldbook;delete state.activeToolTask;delete state.imageReadTask
      const previous=state.input || {}
      state.input={task:previous.task,sessionId:parentId,selection:previous.selection,backgroundTasksSnapshot:previous.backgroundTasksSnapshot,webSearchEnabled:previous.webSearchEnabled}
      requestContexts.delete(id);requestSessions.delete(id)
    }
  }
  function owns(sessionId) {`)
 return identityBoundary(creationBoundary(next))
}
export function applyRollbackBackgroundOwnerHostTransform(source){
 const marker='// [dsh-tavern-rollback-background-owner-host:v1]'
 const correct=value=>{
  let next=(value.includes('const boundary=session.log.at(-1)?.seq ?? -1')?value:value.replace('const boundary=session.log.at(-1)?.seq','const boundary=session.log.at(-1)?.seq ?? -1')).replace('if(!Object.hasOwn(cuts,session.id))cuts[session.id]=boundary','cuts[session.id]=Object.hasOwn(cuts,session.id)?Math.min(cuts[session.id],boundary):boundary')
  next=next.replace('const turn=Number(latest?.turn ?? chat.messages?.findLast','const turn=Number((Number.isSafeInteger(input.turn)&&input.turn>0?input.turn:undefined) ?? latest?.turn ?? chat.messages?.findLast')
  if(!next.includes('// [dsh-tavern-background-created-archive:v1]'))next=once(next,"      },{source:'background.rollback-boundary'})",`      },{source:'background.rollback-boundary'})
      // [dsh-tavern-background-created-archive:v1] 新身份在descriptor/业务事件前绑定确切前台屏障。
      await ctx.get('sessionPersistence').bindRollbackArchive(session.id,chatJournalStore.rollbackArchivePath(chat.id))`)
  return next
 }
 if(source.includes(marker)){if(!source.includes('recordRollbackBoundary: async (input, session) =>')||!source.includes('backgroundAgentRunner.whenIdle(chat.sessionId)'))throw Error('后台seq归属Host标记不完整');return correct(source)}
 let next=marker+'\n'+source
 next=once(next,'    retirement: backgroundRetirement,',`    recordRollbackBoundary: async (input, session) => {
      const chat=await chatForSession(input.sessionId)
      if(!chat || !['story','script'].includes(chat.mode || 'story'))return
      const latest=Object.values(chat.timeline?.operations || {}).filter(op=>op.kind==='body').sort((a,b)=>Number(b.turn)-Number(a.turn))[0]
      const turn=Number(latest?.turn ?? chat.messages?.findLast(row=>row.role==='assistant')?.turn)
      const boundary=session.log.at(-1)?.seq
      if(!Number.isSafeInteger(turn)||turn<1||!Number.isSafeInteger(boundary))throw new Error('后台任务缺少权威轮归属或初始seq，未发模型')
      await updateChat(chat.id,current=>{
        current.rollbackSessionCuts ||= {}
        const cuts=current.rollbackSessionCuts[String(turn)] ||= {}
        if(!Object.hasOwn(cuts,session.id))cuts[session.id]=boundary
        return current
      },{source:'background.rollback-boundary'})
    },
    retirement: backgroundRetirement,`)
 next=once(next,'    cleanupRollbackSides: async (chat, turn) => {','    cleanupRollbackSides: async (chat, turn, cuts) => {')
 next=once(next,'      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)',`      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)
      await backgroundAgentRunner.clearRollbackState(chat.sessionId)
      for(const cut of cuts){
        requestCoordinates.delete(cut.sessionId)
        runtimePresetSnapshots.delete(cut.sessionId)
        foregroundStrategies.clearRequestState(cut.sessionId)
      }`)
 next=once(next,'      await candidateWorldbookPreparation?.whenIdle(chat.sessionId)','      await candidateWorldbookPreparation?.whenIdle(chat.sessionId)\n      await backgroundAgentRunner.whenIdle(chat.sessionId)')
 return correct(next)
}
