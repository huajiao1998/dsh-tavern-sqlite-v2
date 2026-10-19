// 旧导出名只作兼容，最新轮定位沿同一个latestSendRecord，不认证失败/完整度/原生匹配资格。
import {latestSendRecord,latestSendTarget} from './latest-send.js'
export const FAILED_BODY_PREPARATION_ERROR = '失败正文必须先统一物理清理，再准备新回合；禁止直接重试覆盖回退基准'

// 独立旧轮编辑的确切同步证据；这是保留用户独立编辑范围，不是发送对象资格。
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

export function inspectNativeFailureTail(chat, evidence = {}, revision = chat?._storageRevision) {
  const record=latestSendRecord(chat,evidence)
  if(!record)return null
  const events=Array.isArray(evidence.events)?evidence.events:evidence.session?.snapshotEvents?.() || []
  return {turn:record.turn,endSeq:events.at(-1)?.seq,eventCount:events.length,cleanable:true,
    target:latestSendTarget(chat,evidence,revision),reason:''}
}
