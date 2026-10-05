// HTTP首页就绪不代表Loader已完成；有限等待同代完整运行库存，失败态不重试。
export async function waitCompleteInventory({initial,read,assertComplete,assertIdentity,snapshot,deadline,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 let value=initial
 while(true){
  assertIdentity();snapshot(value)
  try{assertComplete(value);return value}catch(error){
   if(value.entries.some(r=>r.enabled&&['failed','disposed','error'].includes(r.fiberPhase)))throw error
   if(now()>=deadline)throw Error('45秒内完整运行库存未就绪：'+error.message)
  }
  await pause(250);assertIdentity();value=await read(value.cookie)
 }
}
