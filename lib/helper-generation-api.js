// 服务端Helper生成接线：复用作者任务工厂和编译器；任务只活在当前绑定，不保存到SQL。
import {randomUUID} from 'node:crypto'
export const HELPER_GENERATION_EVENTS=Object.freeze({GENERATION_STARTED:'js_generation_started',STREAM_TOKEN_RECEIVED_FULLY:'js_stream_token_received_fully',STREAM_TOKEN_RECEIVED_INCREMENTALLY:'js_stream_token_received_incrementally',GENERATION_ENDED:'js_generation_ended'})
export function createHelperGenerationApi({bindingOf,assertOpen,options={},activity,emit,str=String}={}){
 if(typeof options.createGenerationTasks!=='function')throw Error('生成任务工厂未接线')
 const tasks=options.createGenerationTasks(),jobs=new Map()
 let disposed=false
 const read=()=>{const binding=bindingOf();if(disposed||!binding)throw Error('生成调用窗口已关闭');assertOpen(binding);return binding}
 const event=async(name,...args)=>{try{await emit?.(HELPER_GENERATION_EVENTS[name],...args)}catch(error){options.logger?.error?.('Helper生成事件失败',error)}}
 const stopJob=job=>tasks.stop(job.binding.sessionId,job.id,{generationToken:job.token,pending:true})
 async function start(kind,config={}){
  const binding=read()
  if(!config||typeof config!=='object'||Array.isArray(config))throw TypeError('生成参数必须是对象')
  const payload=structuredClone(config),id=payload.generation_id==null||payload.generation_id===''?randomUUID():String(payload.generation_id)
  payload.generation_id=id
  if(jobs.has(id))throw Error('生成编号正在使用：'+id)
  const implementation=options[kind]
  if(typeof implementation!=='function')throw Error(kind+'尚未接线')
  const job={id,token:randomUUID(),binding};jobs.set(id,job)
  let text=''
  const abort=()=>stopJob(job)
  binding.signal?.addEventListener('abort',abort,{once:true})
  // 在tasks.run前计数；模型即使忽略abort也不能把脚本活动一直留成在飞。
  activity.pending++
  try{
   const pending=tasks.run(binding.sessionId,id,async signal=>{
    read();signal.throwIfAborted()
    const context=typeof options.readGenerationContext==='function'?await options.readGenerationContext(binding,payload,kind):undefined
    read();signal.throwIfAborted()
    const result=await implementation(payload,{sessionId:binding.sessionId,eventId:binding.eventId,signal,...(context===undefined?{}:{context})})
    assertOpen(binding);signal.throwIfAborted()
    return result
   },job.token)
   // run已登记，STARTED监听器现在可以准确取消该job，包括operation尚未进入的情况。
   if(binding.signal?.aborted)abort()
   void event('GENERATION_STARTED',id)
   const result=await pending
   assertOpen(binding)
   if(disposed)throw Error('生成窗口已释放')
   text=typeof result==='string'?result:str(result?.text??'')
   if(payload.should_stream===true){await event('STREAM_TOKEN_RECEIVED_FULLY',text,id);await event('STREAM_TOKEN_RECEIVED_INCREMENTALLY',text,id)}
   read()
   return text
  }finally{
   binding.signal?.removeEventListener('abort',abort)
   if(jobs.get(id)===job)jobs.delete(id)
   activity.pending--
   await event('GENERATION_ENDED',text,id)
  }
 }
 async function stopGenerationById(id){
  read()
  if(typeof id!=='string'||!id)return false
  const job=jobs.get(id)
  return job?stopJob(job):false
 }
 // 作者stopAll RPC回执stopped:true；公开Helper将其折算为boolean，空表也为true。
 async function stopAllGeneration(){read();for(const job of jobs.values())stopJob(job);return true}
 function dispose(){if(disposed)return;disposed=true;for(const job of jobs.values())stopJob(job);tasks.dispose()}
 return {generate:config=>start('generate',config),generateRaw:config=>start('generateRaw',config),stopGenerationById,stopAllGeneration,dispose}
}
