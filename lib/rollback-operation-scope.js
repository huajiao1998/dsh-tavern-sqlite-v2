// 只记录任务以便回退取消并等它结束；不做租约、所有权或资格验证。
import {AsyncLocalStorage} from 'node:async_hooks'
import {rollbackSchedulingBarrier,rollbackCancellationBarrier} from './rollback-barrier.js'
export function createRollbackOperationScope({sessions}) {
 const context=new AsyncLocalStorage(),active=new Map(),cancelling=new Map()
 const check=()=>context.getStore()?.controller.signal.throwIfAborted()
 function run(sessionId,work){
  const job={controller:new AbortController()}
  const tasks=active.get(sessionId)||new Set();active.set(sessionId,tasks);tasks.add(job)
  job.done=context.run(job,()=>Promise.resolve().then(work).then(value=>{check();return value})).finally(()=>{tasks.delete(job);if(!tasks.size)active.delete(sessionId)})
  return job.done
 }
 async function cancelAndJoin(sessionId){
  const self=context.getStore(),tasks=[...(active.get(sessionId)||[])].filter(job=>job!==self)
  cancelling.set(sessionId,(cancelling.get(sessionId)||0)+1)
  rollbackCancellationBarrier.add(sessionId);rollbackSchedulingBarrier.add(sessionId)
  const release=()=>{
   if(release.done)return;release.done=true
   const remaining=cancelling.get(sessionId)-1
   if(remaining)cancelling.set(sessionId,remaining)
   else{cancelling.delete(sessionId);rollbackCancellationBarrier.delete(sessionId);rollbackSchedulingBarrier.delete(sessionId)}
  }
  try{
   for(const job of tasks)job.controller.abort(Error('玩家回退取消了本次重放/重生成'))
   const agent=sessions.get(sessionId)
   if(agent?.phase?.kind==='running')agent.cancel({kind:'user'})
   await Promise.allSettled(tasks.map(job=>job.done))
   if(agent?.phase?.kind==='running')await agent.whenIdle()
   return release
  }catch(error){release();throw error}
 }
 return {run,check,cancelAndJoin}
}
