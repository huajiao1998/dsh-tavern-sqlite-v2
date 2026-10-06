// 回退写入不再触发模板/预热/压缩等新任务，整个任务run先静止。
const MARKER='// [dsh-tavern-rollback-host-barrier:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw new Error('回退Host锚点未命中/不唯一：'+old.slice(0,80));return source.replace(old,next)}
export function applyRollbackHostTransform(source){
 if(source.includes(MARKER)){if(!source.includes('quiesceRollback: async chat =>') || !source.includes('rollbackSchedulingBarrier.has(sessionId)'))throw new Error('回退Host屏障不完整');return source.includes('await tavernScriptHostAdapter.whenIdle(chat.sessionId)')?source:once(source,'      await candidateWorldbookPreparation?.whenIdle(chat.sessionId)','      await candidateWorldbookPreparation?.whenIdle(chat.sessionId)\n      await tavernScriptHostAdapter.whenIdle(chat.sessionId)')}
 let next="import { rollbackSchedulingBarrier, createRollbackWorldbookRecallLog } from './domain/storage-rollback-business.js'\n"+MARKER+'\n'+source
 next=once(next,'  const worldbookRecallLog = createWorldbookRecallLog({ store: profileData })',"  const worldbookRecallLog = createRollbackWorldbookRecallLog({ store: profileData, dataRoot })\n  ctx.effect(() => () => worldbookRecallLog.dispose(), 'dsh-tavern: 召回SQLite释放')")
 next=once(next,'    if (!autoCompaction || compactionAbort.signal.aborted || compactionTimers.has(sessionId)) return','    if (rollbackSchedulingBarrier.has(sessionId) || !autoCompaction || compactionAbort.signal.aborted || compactionTimers.has(sessionId)) return')
 next=once(next,'    if (legacyViewSeams.readOnlyChat(chat)) return',"    if (rollbackSchedulingBarrier.has(chat.sessionId) || str(metadata?.source).startsWith('rollback.') || legacyViewSeams.readOnlyChat(chat)) return")
 next=once(next,'readSlice: chatPersistence.readSlice },','readSlice: chatPersistence.readSlice, rollbackArchivePath: chatJournalStore.rollbackArchivePath },')
 const presentations=['view','presentStory'].map(name=>'    cancelSettlement,\n    present: '+name+',')
 if(presentations.reduce((count,anchor)=>count+next.split(anchor).length-1,0)!==1)throw Error('回退Host展示布局缺失或重复')
 const presentation=presentations.find(anchor=>next.includes(anchor))
 const presentationName=presentation.endsWith('presentStory,')?'presentStory':'view'
 next=once(next,presentation,`    cancelSettlement,
    cleanupRollbackSides: (chat, turn) => worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId),
    quiesceRollback: async chat => {
      await foregroundHandoff.whenIdle(chat.sessionId)
      await cancelSettlement(chat.id, { wait: true })
      const timer = compactionTimers.get(chat.sessionId)
      if (timer) { clearTimeout(timer); compactionTimers.delete(chat.sessionId) }
      await autoCompaction?.whenIdle(chat.id)
      await templateSync.whenIdle(chat.sessionId)
      await candidateWorldbookPreparation?.whenIdle(chat.sessionId)
      await tavernScriptHostAdapter.whenIdle(chat.sessionId)
    },
    present: ${presentationName},`)
 return next
}
export function applyTemplateQuiescenceTransform(source){
 const marker='// [dsh-tavern-template-quiescence:v1]'
 if(source.includes(marker)){if(!source.includes('async function whenIdle(id)'))throw new Error('模板静止消费者不完整');return source}
 let next=marker+'\n'+source
 next=once(next,'      record.timer = null; record.running = true; record.dirty = false','      record.timer = null; record.running = true; record.dirty = false\n      let settle; record.done = new Promise(resolve => { settle = resolve })')
 next=once(next,'        record.running = false','        record.running = false; settle()')
 next=once(next,'  return { schedule, unchanged, dispose()',`  async function whenIdle(id) {
    const record=records.get(id)
    if (!record) return
    clearTimeout(record.timer); record.timer=null; record.blocked=true; record.dirty=false
    await record.done
    records.delete(id)
  }
  return { schedule, unchanged, whenIdle, dispose()`)
 return next
}
export function applyCandidateQuiescenceTransform(source){
 const marker='// [dsh-tavern-candidate-quiescence:v1]'
 if(source.includes(marker)){if(!source.includes('async whenIdle(id)'))throw new Error('候选静止消费者不完整');return source}
 let next=marker+'\n'+source
 next=once(next,'  async function load(id,warming=false){','  async function loadNow(id,warming=false){')
 next=once(next,'  return Object.freeze({',`  const active=new Map()
  function load(id,warming=false){
    const task=loadNow(id,warming)
    if(!active.has(id))active.set(id,new Set())
    active.get(id).add(task)
    task.finally(()=>{const tasks=active.get(id);tasks?.delete(task);if(!tasks?.size)active.delete(id)}).catch(()=>{})
    return task
  }
  return Object.freeze({`)
 next=once(next,'    get:id=>load(id),','    get:id=>load(id),\n    async whenIdle(id){while(active.get(id)?.size)await Promise.allSettled([...active.get(id)]);remove(id)},')
 return next
}
export function applyCompactionQuiescenceTransform(source){
 const marker='// [dsh-tavern-compaction-quiescence:v1]'
 if(source.includes(marker)){if(!source.includes('async whenIdle(id)'))throw new Error('压缩静止消费者不完整');return source}
 let next=marker+'\n'+source
 next=once(next,'    job.promise = execute(chat, options, job)','    let finish;job.done=new Promise(resolve=>{finish=resolve})\n    job.promise = execute(chat, options, job)')
 next=once(next,'      if (jobs.get(chat.id) === job) { jobs.delete(chat.id); reserved.delete(chat.id) }','      if (jobs.get(chat.id) === job) { jobs.delete(chat.id); reserved.delete(chat.id) }\n      finish()')
 return once(next,'  return { run, blocked, recordForeground }','  return { run, blocked, recordForeground, async whenIdle(id) { const job=jobs.get(id); if(job)await job.done } }')
}
