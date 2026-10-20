// 前台输入边界按实际inbox splice归属追溯；不以输出/终态类型判断可撤销。
// 返回连续纯尾起点；只限制不吞独立输入/旧轮，不认证对象终态或完整性。
export function foregroundInboxBoundary(events, turn, startSeq, chat) {
  const regenerated=Number(chat?.regeneratedDshTurns?.[String(turn)])
  const ownRegeneratedInput=message=>message?.source?.kind!=='user' && (message?.source?.trace?.chatId===chat?.id
    || (message?.source?.plugin==='dsh-tavern-regen' && (message.source.trace?.chatId===undefined || message.source.trace.chatId===chat?.id)))
  const queues={'next-turn':[],'next-step':[]}
  let activeTurn=null, proposed=[], claimed=[]
  const roots=[],canceled=new Set()
  for(const event of events) {
    if(event.type==='turn/start') {
      activeTurn=Number(event.data?.turn)
      if(activeTurn===turn) {
        proposed=[...queues['next-step'],...queues['next-turn'].slice(0,1)]
      }
    }
    if(event.type==='turn/end')activeTurn=null
    if(event.type!=='agent/inbox/spliced')continue
    const data=event.data || {},queue=queues[data.target]
    // 这是持久队列协议校验，不是产物类型准入名单；未知协议无法猜历史位置。
    if(!queue || !Number.isSafeInteger(data.start) || data.start<0 || data.start>queue.length
      || !Number.isSafeInteger(data.removedCount ?? 0) || (data.removedCount ?? 0)<0
      || data.start+(data.removedCount ?? 0)>queue.length || !Array.isArray(data.inserted))continue // 残缺队列只丢失该定位线索，不拒绝清理对象。
    const removed=queue.slice(data.start,data.start+(data.removedCount ?? 0))
    // 已明确取消且无替代的待输入不再阻挡纯尾；替换仍沿原入队身份追踪。
    if(data.outcome==='canceled' && data.inserted.length===0)for(const item of removed)canceled.add(item.key)
    if(activeTurn===turn && data.outcome===undefined && removed.length && data.inserted.length===0)claimed.push(...removed)
    const inserted=data.inserted.map((message,index)=>{
      // 原位替换（含改ID）仍追原入队，不保留会复活被替换输入的旧前缀。
      const previous=removed.find(item=>item.id===message?.id) || (removed.length===1 && data.inserted.length===1?removed[0]:null)
      const item={id:message?.id,message,origin:previous?.origin ?? event.seq,key:previous?.key ?? event.seq+':'+index}
      if(!previous)roots.push(item)
      return item
    })
    queue.splice(data.start,data.removedCount ?? 0,...inserted)
  }
  const owned=claimed.length?claimed:proposed
  const origins=owned.map(item=>item.origin).filter(Number.isSafeInteger)
  // 目标轮的tool/runtime片段可能先于turn/start落盘；同属本轮也须纳入物理尾。
  const ownFirst=events.find(event=>Number(event.data?.turn)===turn)?.seq ?? startSeq
  const first=Math.min(startSeq,ownFirst,...origins),keys=new Set(owned.map(item=>item.key))
  // 不能为删除本轮入队而吞掉中间独立旧轮；这是纯尾范围，不是对象形态资格。
  if(events.some(event=>event.seq>=first && event.seq<startSeq && event.type==='turn/start' && Number(event.data?.turn)!==turn))throw Error('目标输入入队早于其它独立轮，不能扩大纯尾删除')
  if(regenerated>turn) {
    const originalEnd=events.findLast(event=>event.type==='turn/end' && Number(event.data?.turn)===turn)?.seq ?? startSeq
    if(events.some(event=>event.seq>originalEnd && event.type==='user/message' && !event.data?.source?.repair && !ownRegeneratedInput(event.data)))throw Error('重新生成尾部存在独立输入，不能扩大纯尾删除')
  }
  // 同一入队事件或其后的连续尾含另一条未领取输入，不能把它按最近发送吞掉。
  if(roots.some(item=>item.origin>=first && !keys.has(item.key) && !canceled.has(item.key)
    && !(regenerated>turn && ownRegeneratedInput(item.message))))throw new Error('目标发送入队之后存在独立输入记录，拒绝扩大纯尾删除')
  return {boundarySeq:first-1,inputIds:owned.map(item=>item.id),queueStartSeq:origins.length?Math.min(...origins):null}
}
