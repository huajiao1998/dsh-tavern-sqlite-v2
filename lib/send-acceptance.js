// 已装配Chat存储的同步写口注册；不是身份或业务状态存储。
// 身份复用作者sessions映射，前像存入既有body operation，Session开始轮次前先提交。
// 同一数据根可合法并存多个store（冷读/维护会新建第二实例）：注册按到达顺序保留，
// 实际捕获交最后注册者，卸载只摘自己那条——不抛错、不静默夺走他人注册。
import { chatIdForSession, tavernDataRoot } from './tavern-chat-state.js'
import path from 'node:path'
const captures = new Map()
const openingSessions=new WeakSet()
// 只包作者静态appendOpeningEvents同步区间；不依据turn=1或模型名跳过真实发送。
export function withNativeOpening(session,work){
 const nested=openingSessions.has(session);openingSessions.add(session)
 try{return work()}finally{if(!nested)openingSessions.delete(session)}
}
export function registerSendCapture(root, capture) {
  const key = path.resolve(root)
  const list = captures.get(key) || []
  list.push(capture)
  captures.set(key, list)
  return () => {
    const current = captures.get(key)
    if (!current) return
    const at = current.indexOf(capture)
    if (at < 0) return
    current.splice(at, 1)
    if (current.length === 0) captures.delete(key)
  }
}
export function activeSendCapture(root = tavernDataRoot()) {
  const list = captures.get(path.resolve(root))
  return list && list.length ? list[list.length - 1] : null
}
export function captureAcceptedSend(session, type, data) {
  if (openingSessions.has(session)) return
  if (type !== 'turn/start' && type !== 'user/message') return
  // 酒馆自愈只重建已保留的历史，不是一次新发送。
  if (type === 'user/message' && (data?.source?.kind !== 'user' || data.source.repair)) return
  const chatId = chatIdForSession(session.id)
  if (!chatId) return
  const capture = activeSendCapture()
  if (!capture) throw new Error('酒馆发送前像写口尚未装配；未开启新轮次')
  const turn = type === 'turn/start' ? data?.turn : session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data?.turn
  if (!Number.isSafeInteger(turn) || turn < 1) return
  return capture(chatId, { sessionId: session.id, turn, type, data, seq: session.seq,
    ...(type === 'turn/start' ? { events: session.snapshotEvents() } : {}) })
}
export function installSendAcceptance(Session, capture = captureAcceptedSend) {
  const original = Session.prototype.append
  const append = function (type, data, ...args) {
    const undoCapture=(type === 'turn/start' || type === 'user/message') ? capture(this,type,data) : null
    const beforeSeq=this.seq
    try {return original.call(this,type,data,...args)}
    catch(error) {
      // 原生验证在接受前拒绝才补偿；已推进seq的异常不能冒称未接受，也不猜删已存在发送。
      if(this.seq===beforeSeq && typeof undoCapture==='function') {
        try{undoCapture()}catch(rollbackError){throw new AggregateError([error,rollbackError],'原生发送未接受且前像补偿失败，须先恢复记录')}
      }
      throw error
    }
  }
  Session.prototype.append = append
  return () => { if (Session.prototype.append === append) Session.prototype.append = original }
}
