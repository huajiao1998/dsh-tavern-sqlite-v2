// 旧导出名只作兼容：最新发送的原生尾清理不按成功/错误/终态、事件或正文类型分类。
// 有业务写入必须沿真实前像恢复；历史无前像只能在没有本轮业务记录时清理原生连续尾，不能猜变量历史。
export const FAILED_BODY_PREPARATION_ERROR = '失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准'

// 独立旧轮编辑的确切同步证据；这不是发送类型资格，不得丢失用户在旧轮的独立编辑。
export function isRetainedBodyEdit(event, events, boundaryIndex, chat, hiddenTurn) {
  const op=event?.surfaceOp, refs=event?.sourceEventSeqs, message=event?.data?.message
  const row=chat?.messages?.find(item=>item?.role==='assistant' && item.bodyEdit?.id===message?.id)
  if(event?.type!=='assistant/message' || message?.source?.kind!=='model' || message.source.provider!=='dsh-tavern' || message.source.model!=='body-edit'
    || !row || row.turn!==event.data.turn || row.bodyEdit.turn!==row.turn || row.turn>=hiddenTurn
    || op?.op!=='replace' || op.startSeq!==op.endSeq || !Number.isSafeInteger(op.startSeq) || op.startSeq>boundaryIndex
    || !Array.isArray(refs) || refs.length!==1 || refs[0]!==op.startSeq
    || !Array.isArray(message.content) || message.content.length!==1 || message.content[0]?.type!=='text' || message.content[0].text!==row.text)return false
  const original=events[op.startSeq]
  return original?.type==='assistant/message' && original.data?.turn===row.turn && original.surfaceOp==='append'
}
// 仅查显式轮归属，不枚举根字段/事件类型；未知本档运行记录也不能冒认没有业务写入。
function hasOwnedTail(value, turn, seen = new Set()) {
  if(!value || typeof value!=='object' || seen.has(value))return false
  seen.add(value)
  if(Number.isSafeInteger(Number(value.turn)) && Number(value.turn)>=turn)return true
  return Object.values(value).some(item=>hasOwnedTail(item,turn,seen))
}
export function inspectNativeFailureTail(chat, evidence = {}, revision = chat?._storageRevision) {
   if (chat?.mode === 'card') return null
  const events=Array.isArray(evidence.events)?evidence.events:evidence.session?.snapshotEvents?.() || []
  const start=events.findLast(event=>event?.type==='turn/start')
  const turn=Number(start?.data?.turn)
  if(!Number.isSafeInteger(turn) || turn<1)return null
  const endSeq=events.at(-1)?.seq,info={turn,endSeq,eventCount:events.length,cleanable:false,target:null,reason:''}
  const blocked=reason=>({...info,reason})
  if(!chat?.id || !chat.sessionId || !chat.timeline?.branchId || !Number.isSafeInteger(revision))return blocked('最新发送缺少可靠身份或版本')
  if(events.some((event,index)=>event.seq!==index))return blocked('原生事件坐标不连续，不能物理删尾')
  if(events.filter(event=>event.type==='turn/start' && Number(event.data?.turn)===turn).length!==1)return blocked('最新发送开始边界不唯一')
  // 窄窗口未载入完整检查点数组；同快照标量也必须阻止无前像空尾兜底。
  if(Number.isSafeInteger(evidence.nativeFailureCheckpointTurn) && evidence.nativeFailureCheckpointTurn>=turn)return blocked('该发送已有检查点记录，须用发轮前基准恢复')
  // 业务前像由统一body/checkpoint选择器消费；无前像兜底不得覆盖任何已登记本轮业务。
  if(Object.values(chat.timeline.operations || {}).some(op=>Number(op?.turn)>=turn)
    || (chat.timeline.checkpoints || []).some(cp=>Number(cp?.turn)>=turn)
    || (chat.messages || []).some(row=>Number(row?.turn)>=turn)
    || ((chat.messages || []).at(-1)?.role==='user' && (chat.messages || []).at(-1)?.turn===undefined))return blocked('该发送已有业务记录，须用发轮前基准恢复')
  const runtime=Object.fromEntries(Object.entries(chat).filter(([key])=>key!=='messages' && key!=='timeline' && key!=='rollbackPending' && key!=='rollbackCompletion'))
  if(hasOwnedTail(runtime,turn) || hasOwnedTail(chat.timeline.participants,turn))return blocked('该发送已有本档运行写入且缺发轮前基准，不能以当前值猜历史')
  // 连续尾里的未知事件/输出直接交纯尾与引用链预检；不再按reason、tool或content block名单拒绝。
  const target={kind:'native-only',incomplete:true,chatId:chat.id,sessionId:chat.sessionId,turn,branchId:chat.timeline.branchId,revision,endSeq,eventCount:events.length}
  return {...info,cleanable:true,target}
}
