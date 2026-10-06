// 正文提交与完成后排队沿用发轮身份，不通过当前同号轮反推旧结果所属任务。
function once(source,old,next){if(source.split(old).length!==2)throw Error('正文提交归属锚点缺失/不唯一：'+old.slice(0,100));return source.replace(old,next)}
export function applyRollbackBodyCommitTurnTransform(source){
 const marker='// [dsh-tavern-body-commit-owner:v1]'
 if(source.includes(marker)){
  for(const fragment of ['function rollbackBodyCommitMatches(chat,input)', '!rollbackBodyCommitMatches(current,input)', '!rollbackBodyCommitMatches(chat,input)']) {
   if(source.split(fragment).length!==2)throw Error('正文提交归属消费者缺失/重复：'+fragment)
  }
  return source
 }
 let next=marker+`\nfunction rollbackBodyCommitMatches(chat,input) {
 const owner=input.rollbackBodyOwner,op=chat.timeline?.operations?.[owner?.operationId]
 return !!owner && !chat.rollbackPending && owner.chatId===chat.id && owner.sessionId===chat.sessionId && owner.turn===Number(input.turn) && owner.branchId===chat.timeline?.branchId && op?.kind==='body' && ['running','completed'].includes(op.status) && Number(op.turn)===owner.turn && op.basedOn?.branchId===owner.branchId
}
`+source
 next=once(next,'    await store.updateChat(chat.id, async current => {',`    await store.updateChat(chat.id, async current => {
      if(!rollbackBodyCommitMatches(current,input)){result={saved:false,reason:'stale-body-owner'};return undefined}`)
 const snapshots=['  async function finalizeSnapshot(input, chat, writeChat, expectedTimeline) {','  async function finalizeSnapshot(input, chat, writeChat, expectedTimeline, history) {']
 if(snapshots.reduce((count,anchor)=>count+next.split(anchor).length-1,0)!==1)throw Error('正文提交归属：未知/重复finalizeSnapshot签名')
 const snapshot=snapshots.find(anchor=>next.includes(anchor))
 return once(next,snapshot,snapshot+`\n    if(['story','script'].includes(chat.mode || 'story') && !rollbackBodyCommitMatches(chat,input))return {saved:false,reason:'stale-body-owner'}`)
}
export function applyRollbackBodyCommitHandoffTransform(source){
 const marker='// [dsh-tavern-body-commit-handoff:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+once(source,'        if (chat === undefined) return',`        if (chat === undefined) return
        if(['story','script'].includes(chat.mode || 'story')){
          const owner=rollbackBodyOwner,op=chat.timeline?.operations?.[owner?.operationId]
          if(!owner || chat.rollbackPending || owner.chatId!==chat.id || owner.sessionId!==chat.sessionId || owner.turn!==Number(input.turn) || owner.branchId!==chat.timeline?.branchId || op?.kind!=='body' || op.status!=='completed' || Number(op.turn)!==owner.turn || op.basedOn?.branchId!==owner.branchId)return
        }`)
 return once(next,'          await queueBackground(chat.id)','          await queueBackground(chat.id,rollbackBodyOwner)')
}
export function applyRollbackBodyCommitJobsTransform(source){
 const marker='// [dsh-tavern-body-commit-jobs:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+once(source,'  function start(chatId) {','  function start(chatId,rollbackBodyOwner) {')
 next=once(next,'      return run(chatId, signal)',`      return Promise.resolve(run(chatId, signal,rollbackBodyOwner)).then(result=>{job.staleBody=result===false;return result})`)
 return once(next,'if (!disposed && !signal.aborted) await onSettled(chatId, signal)','if (!disposed && !signal.aborted && !job.staleBody) await onSettled(chatId, signal)')
}
export function applyRollbackBodyCommitHooksTransform(source){
 const marker='// [dsh-tavern-body-commit-hooks:v1]'
 const next='    const saved = await foregroundHandoff.finalize({\n      rollbackBodyOwner,\n      sessionId,'
 if(source.includes(marker)){if(!source.includes(next))throw Error('正文hooks提交归属标记不完整');return source}
 return marker+'\n'+once(source,'    const saved = await foregroundHandoff.finalize({\n      sessionId,',next)
}
export function applyRollbackBodyCommitHostTransform(source){
 const marker='// [dsh-tavern-body-commit-host:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+(source.includes('  registerTurnLifecycleHooks({')?source:applyRollbackBodyCommitHooksTransform(source))
 next=once(next,'  function queueSettlement(chatId) { return settlementJobs.start(chatId) }','  function queueSettlement(chatId,rollbackBodyOwner) { return settlementJobs.start(chatId,rollbackBodyOwner) }')
 next=once(next,'  async function runSettlement(chatId, signal) {','  async function runSettlement(chatId, signal,rollbackBodyOwner) {')
 return once(next,'      if (snapshot === undefined) return',`      if (snapshot === undefined) return
      if(rollbackBodyOwner){
        // settlement-input可能仅投影消息，不假设其保留timeline；确切chat权威另读。
        const current=await readChat(chatId),owner=rollbackBodyOwner,op=current?.timeline?.operations?.[owner.operationId]
        if(!current || current.rollbackPending || owner.chatId!==current.id || owner.sessionId!==current.sessionId || owner.branchId!==current.timeline?.branchId || op?.kind!=='body' || op.status!=='completed' || Number(op.turn)!==owner.turn || op.basedOn?.branchId!==owner.branchId)return false
      }`)
}
