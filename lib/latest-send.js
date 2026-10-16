// 最新发送撤销：定位沿既有body/checkpoint和原生输入锚点，不把产物、操作状态或终态名称当资格。
// 视图只签身份快照；执行端停止写入后重新核对并走唯一物理纯尾编排。
function integer(value) { return value !== null && value !== undefined && Number.isSafeInteger(Number(value)) ? Number(value) : null }
function hasBaseline(value) {
  const business = value?.businessBefore
  if (business && business.version === 1 && Number.isSafeInteger(business.messageCount)
    && business.messageCount >= 0 && business.fields && typeof business.fields === 'object' && !Array.isArray(business.fields)
    && business.participants && typeof business.participants === 'object' && !Array.isArray(business.participants)) return true
  const row = value?.rowBefore
  return !!(row && typeof row === 'object' && (value?.beforeParticipants || value?.participants)
    && typeof (value.beforeParticipants || value.participants) === 'object')
}
export function latestSendRecord(chat, evidence = {}) {
  if (chat?.mode === 'card') return null
  const events = Array.isArray(evidence?.events) ? evidence.events : evidence?.session?.snapshotEvents?.() || []
  // 重新生成是同一剧情轮的替换：派生原生轮与临时操作都归回原业务轮，
  // 但**临时操作的前像是"原轮完成之后"的状态**，绝不能当作原轮发送前的基准。
  const alias = new Map()
  for (const [business, actual] of Object.entries(chat?.regeneratedDshTurns || {})) {
    const from = integer(business), to = integer(actual)
    if (from > 0 && to > 0) alias.set(to, from)
  }
  // 尚未采用的临时轮不是新玩家发送；只认持久操作ID与原生生产者的共同证据。
  const recovery=chat?.regenRecovery
  if(recovery?.id && integer(recovery.turn)>0 && Number.isSafeInteger(recovery.eventStart)){
    let native
    for(const event of events){
      if(event.seq<recovery.eventStart)continue
      if(event.type==='turn/start')native=integer(event.data?.turn)
      const source=event.type==='user/message'?event.data?.source:null
      if(native>0 && source?.kind==='plugin' && source.plugin==='dsh-tavern-regen' && source.regenerationId===recovery.id)alias.set(native,integer(recovery.turn))
    }
  }
  const businessTurn = value => {
    let at=integer(value)
    const seen=new Set()
    while(alias.has(at) && !seen.has(at)){seen.add(at);at=alias.get(at)}
    return at
  }
  const own = (entry, turn) => integer(entry?.turn) === turn
  const operations = Object.entries(chat?.timeline?.operations || {}).filter(([,op]) => op?.kind === 'body' && integer(op.turn) > 0)
  const checkpoints = (chat?.timeline?.checkpoints || []).filter(cp => integer(cp?.turn) > 0)
  const narrow = chat?.failureCleanup
  const greetingTurns=new Set((chat?.messages || []).filter(row=>row?.greeting===true).map(row=>integer(row.turn)))
   const isGreetingTurn=value=>{
    const turn=integer(value);if(!greetingTurns.has(turn))return false
    const start=events.findLast(e=>e.type==='turn/start' && integer(e.data?.turn)===turn)
    const tail=start?events.filter(e=>e.seq>start.seq):[]
    if(tail.some(e=>e.type==='user/message' && e.data?.source?.kind==='user'))return false
    return !(chat?.messages || []).some(row=>row?.greeting!==true && row?.role==='user' && integer(row.turn)===turn)
   }
   const starts = events.filter(event => event?.type === 'turn/start' && integer(event.data?.turn) > 0 && !isGreetingTurn(event.data.turn))
  const nativeTurn = integer(starts.at(-1)?.data?.turn)
  const eventTurn = nativeTurn === null ? null : businessTurn(nativeTurn)
  const candidates = [...operations.map(([,op]) => businessTurn(op.turn)), ...checkpoints.map(cp => businessTurn(cp.turn))]
  if (integer(narrow?.turn) > 0) candidates.push(businessTurn(narrow.turn))
  for (const row of chat?.messages || []) if (row?.greeting!==true && integer(row?.turn) > 0) candidates.push(businessTurn(row.turn))
  if (eventTurn > 0) candidates.push(eventTurn)
  const turn = Math.max(0, ...candidates.filter(value => integer(value) > 0 && !isGreetingTurn(value)))
  if (!turn) return null
  // 只认"自身就是这一业务轮"的操作/检查点：派生临时轮的前像属于原轮完成之后，不能冒充发送前。
  const entry = operations.find(([,op]) => own(op, turn))
  const checkpoint = checkpoints.findLast(cp => own(cp, turn))
  const summary = own(narrow, turn) ? narrow : null
  // 不向更早基准回落：最新发送未准备完成时由早期接受接缝负责保存基准，不能误删上一轮。
  const belongs = value => !value?.basedOn?.branchId || value.basedOn.branchId === chat.timeline?.branchId
  const source = entry && belongs(entry[1]) && hasBaseline(entry[1]) ? entry[1] : (belongs(checkpoint) && hasBaseline(checkpoint) ? checkpoint : null)
  const revision = chat?.windowRevision ?? chat?._storageRevision
  const validSummary = !!summary && Number.isSafeInteger(summary.turn)
    && summary.branchId === chat.timeline?.branchId && Number.isSafeInteger(summary.revision)
    && summary.revision === revision && (summary.operationId === undefined || (typeof summary.operationId === 'string' && summary.operationId.length > 0))
    && (eventTurn === null || eventTurn === turn)
  // 恢复资料只供执行端使用，不决定最新发送能否撤销。
  const operationId = entry?.[0] || (validSummary ? summary.operationId : undefined)
  const savedAnchor = source?.nativeAnchor || entry?.[1]?.nativeAnchor || checkpoint?.nativeAnchor
    || chat?.messages?.findLast(row => own(row, turn) && row?.nativeAnchor)?.nativeAnchor
  let input = savedAnchor?.input
  if (!Number.isSafeInteger(input)) {
    const start = starts.findLast(event => integer(event.data.turn) === turn)
    const end = start ? events.find(event => event.seq > start.seq && event.type === 'turn/end' && integer(event.data?.turn) === turn) : null
    const user = start ? events.find(event => event.seq > start.seq && (!end || event.seq < end.seq)
      && event.type === 'user/message' && event.data?.source?.kind === 'user') : null
    input = user?.seq
  }
  const nativeAnchor = savedAnchor || (Number.isSafeInteger(input) ? {turn, input, reply:null} : undefined)
  return {turn, ...(operationId ? {operationId} : {}), ...(nativeAnchor ? {nativeAnchor} : {}), source, checkpoint}
}
export function latestSendTarget(chat, evidence = {}, revision = chat?.windowRevision ?? chat?._storageRevision) {
  if (chat?.mode === 'card') return null
  if (chat?.rollbackPending) return chat.rollbackPending.ordinaryTarget ? {...chat.rollbackPending.ordinaryTarget} : null
  const record = latestSendRecord(chat, evidence)
  if (!record || integer(revision) === null || typeof chat?.timeline?.branchId !== 'string' || !chat.id || !chat.sessionId) return null
  const {turn, operationId, nativeAnchor} = record
  return {kind:'rollback', chatId:chat.id, sessionId:chat.sessionId, branchId:chat.timeline.branchId, revision:integer(revision), turn,
    ...(operationId ? {operationId} : {}), ...(nativeAnchor ? {nativeAnchor} : {})}
}
