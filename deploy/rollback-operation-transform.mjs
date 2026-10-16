// 回退只取消在途编排并等待；不包装Chat读写、不增加运行资格验证。
const OLD_MARKER='// [dsh-tavern-rollback-operation-cancel:v1]'
const MARKER='// [dsh-tavern-rollback-operation-cancel:v2]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('任务取消接缝缺失：'+old.slice(0,90));return source.replace(old,()=>next)}
export function applyRollbackOperationTransform(source){
 if(source.includes(MARKER))return source
 if(source.includes(OLD_MARKER)){
  const start=source.indexOf('  const scopedChats ='),end=source.indexOf('  const { read: readChat,',start)
  if(start>=0&&end>start)source=source.slice(0,start)+source.slice(end)
  return source.replace(OLD_MARKER,MARKER).replace('update: updateChat } = scopedChats','update: updateChat } = chats')
 }
 source=MARKER+"\nimport { createRollbackOperationScope } from './storage-rollback.js'\n"+source
 source=once(source,'  const { read: readChat, forSession: chatForSession, readCard: readChatCard,',`  const operationScope = createRollbackOperationScope({sessions})
  const { read: readChat, forSession: chatForSession, readCard: readChatCard,`)
 source=once(source,'      services: {','      services: {\n        cancelPendingOperations: operationScope.cancelAndJoin,\n        finishCancelledOperations: chat => regenerationRecovery.cancelForRollback(chat.id,chat.sessionId),')
 // 只在实际继续生成、采用、恢复和结算前响应取消，不对读写反复验证。
 for(const anchor of ['      agent.followup({','      await restoreFailedRegen()','    committedChat = await regenerationRecovery.complete(','      await queueSettlement(','    const regenerationRestore = await regenerationRecovery.prepare(']){
  if(source.includes(anchor)){const indent=anchor.match(/^ */)[0];source=source.replaceAll(anchor,indent+'operationScope.check()\n'+anchor)}
 }
 const exported='  return Object.freeze({ regenerate, replayFailed: replayFailedTurn, recover: regenerationRecovery.recover, rollback: rollbackTurn, undoRollback })'
 return once(source,exported,`  async function runOperation(fn,args,recovery=false){
    const sessionId=recovery?undefined:(fn===regenerate?args[2]:args[1])
    const chat=str(args[0])===''?await chatForSession(sessionId):await readChat(args[0])
    return operationScope.run(chat.sessionId,()=>fn(...args))
  }
  return Object.freeze({regenerate:(...args)=>runOperation(regenerate,args),replayFailed:(...args)=>runOperation(replayFailedTurn,args),recover:(...args)=>runOperation(regenerationRecovery.recover,args,true),rollback:rollbackTurn,undoRollback})`)
}
