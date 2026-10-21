// 作者负责目标选择、临时生成与正文提交；这里只把本次事件尾写回原轮。
// 保留原输入和请求前上下文，不按插件名、source.kind枚举或事件类型名单决定能否重生成。
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => value === undefined ? undefined : structuredClone(value)
const fail = message => { throw new Error('重新生成SQL尾替换：' + message) }

// 只改实际重映射的坐标；未知来源字段原样保留，不判断插件资格。
function remapSource(source, context) {
  if (!isRecord(source)) return source
  const out = clone(source), traceChat = out.trace?.chatId ?? out.chatId
  if (traceChat !== undefined && context.chatId !== undefined && traceChat !== context.chatId) fail('新事件指向其它档')
  if (out.turn === context.syntheticTurn) out.turn = context.oldTurn
  if (isRecord(out.trace) && out.trace.turn === context.syntheticTurn) out.trace.turn = context.oldTurn
  if (isRecord(out.source)) out.source = remapSource(out.source, context)
  return out
}
function remapData(value, context) {
  const data = clone(value)
  if (!isRecord(data)) return data
  if (data.turn === context.syntheticTurn) data.turn = context.oldTurn
  if (context.steps.has(data.step)) data.step = context.steps.get(data.step)
  if (data.source !== undefined) data.source = remapSource(data.source, context)
  if (isRecord(data.message) && data.message.source !== undefined) data.message.source = remapSource(data.message.source, context)
  if (isRecord(data.frame)) {
    if (data.frame.chatId !== undefined && context.chatId !== undefined && data.frame.chatId !== context.chatId) fail('新事件frame指向其它档')
    if (data.frame.turn === context.syntheticTurn) data.frame.turn = context.oldTurn
  }
  return data
}

export function planRegenerationEvents({ events, oldTurn, syntheticTurn, eventStart, oldAssistantSeq, chatId, replacement, nodes = [], previousRange }) {
  const oldStart = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === oldTurn)
  let reply = events[oldAssistantSeq]
  // 作者定位的是当前可见正文；物理删尾需追到被该正文替换的实际原始事件。
  while (reply?.surfaceOp?.op === 'replace') {
    const parent = reply.sourceEventSeqs?.map(seq => events[seq]).find(event => event?.type === 'assistant/message' && event.seq < reply.seq)
    if (!parent) break
    reply = parent
  }
  const input = events.slice(oldStart + 1, reply?.seq).find(event => event.type === 'user/message' && event.data?.source?.kind === 'user' && !isRecord(event.surfaceOp))
  if (oldStart < 0 || !reply || !input) fail('找不到原正文与玩家输入的SQL切点')
  // 注入早于请求头；固定从原玩家输入后换尾，退役的原轮注入也不锁进前缀。
  const keep = input.seq + 1
  const replaced = new Set([replacement, ...(replacement?.cleanups || [])].flatMap(run => run?.shadowedSeqs || []))
  const previous = seq => previousRange && seq >= previousRange.start && seq < previousRange.end
  // 纯尾不能吞掉另一次发送；输入重写不是新发送。其余上下文不构成准入条件。
  for (const event of events.slice(input.seq + 1)) {
    if (event.type === 'turn/start' && event.data.turn !== syntheticTurn ||
        event.type === 'user/message' && event.data?.source?.kind === 'user' && !isRecord(event.surfaceOp)) fail('原正文之后已有独立轮次或真实玩家输入')
  }

  let openedStep
  for (const event of events.slice(oldStart + 1, keep)) {
    if (event.type === 'step/start') openedStep = event
    else if (event.type === 'step/end') openedStep = undefined
  }
  const attempt = events.slice(eventStart), firstStep = attempt.find(event => event.type === 'step/start')
  const steps = new Map(), mapping = new Map()
  if (openedStep && firstStep) {
    let step = openedStep.data.step
    for (const event of attempt) if (event.type === 'step/start' && !steps.has(event.data.step)) steps.set(event.data.step, step++)
    mapping.set(firstStep.seq, openedStep.seq)
  }
  // 原版已有的重生成输入标记仅用于接回原玩家输入，不是插件允许名单。
  for (const event of attempt) if (event.type === 'user/message' && event.data?.source?.plugin === 'dsh-tavern-regen' && !isRecord(event.surfaceOp)) mapping.set(event.seq, input.seq)
  const mapSeq = seq => {
    if (seq < keep) return seq
    const mapped = mapping.get(seq)
    if (mapped === undefined) fail('引用指向被删除的事件：' + seq)
    return mapped
  }
  const out = [], context = { chatId, syntheticTurn, oldTurn, steps }
  // 搬运当前有效状态及其实际引用，不按插件或来源名称推测归属。
  const emit = (event, preserveTime = false) => {
    const output = clone(event)
    delete output.seq
    if (!preserveTime) delete output.time
    output.data = remapData(event.data, context)
    if (event.sourceEventSeqs !== undefined) output.sourceEventSeqs = event.sourceEventSeqs.map(mapSeq)
    if (event.surfaceOp?.op === 'replace') {
      const start = event.surfaceOp.startSeq !== undefined ? 'startSeq' : 'start'
      const end = event.surfaceOp.endSeq !== undefined ? 'endSeq' : 'end'
      output.surfaceOp[start] = mapSeq(event.surfaceOp[start])
      output.surfaceOp[end] = mapSeq(event.surfaceOp[end])
    }
    mapping.set(event.seq, keep + out.length)
    out.push(output)
  }
  const surface = new Set(nodes), retained = new Set()
  for (const event of events.slice(keep, eventStart)) {
    // 用户/系统节点是可沿用的输入状态；仍在当前消息面才保留，旧正文/工具仍随前次批次删除。
    if (surface.has(event.seq) && !replaced.has(event.seq) &&
        (!previous(event.seq) || event.type === 'user/message' || event.type === 'system/message')) retained.add(event.seq)
  }
  const emptyReplacement = event => event.surfaceOp?.op === 'replace' &&
    (event.data?.message?.content ?? event.data?.content)?.length === 0
  // 新替换仍然需要旧节点占位；连同真实祖先搬回，不能因旧节点已不在最终面上就丢掉新状态。
  const retainReferences = (event, onlyExisting = false) => {
    const refs = [...(event.sourceEventSeqs || [])], ancestors = new Set()
    let needed = !onlyExisting
    for (let index = 0; index < refs.length; index++) {
      const ref = refs[index]
      if (ref < keep || retained.has(ref)) { needed = true; continue }
      if (ref >= eventStart || ancestors.has(ref)) continue
      ancestors.add(ref);refs.push(...(events[ref].sourceEventSeqs || []))
    }
    if (needed) for (const ref of ancestors) retained.add(ref)
  }
  for (const event of attempt) if (event.surfaceOp?.op === 'replace') retainReferences(event, emptyReplacement(event))
  // 路由是增量日志，尝试未重复写入时仅延续最后有效值，不把历次请求都搬回。
  for (const type of ['request/header', 'request/context']) {
    if (attempt.some(event => event.type === type)) continue
    const latest = events.slice(0, eventStart).findLast(event => event.type === type)
    if (latest?.seq >= keep) retained.add(latest.seq)
  }
  for (const seq of [...retained]) retainReferences(events[seq])
  for (const event of events.slice(keep, eventStart)) if (retained.has(event.seq)) emit(event, true)
  const attemptStart = keep + out.length
  for (const event of attempt) {
    // 临时轮边界与队列记录不再次入队；保留所有其余事件及扩展字段，不设输出类型名单。
    if (event.type === 'turn/start' || event.type === 'agent/inbox/spliced' || event.type === 'session/end-seed' ||
        event.type === 'user/message' && mapping.get(event.seq) === input.seq || openedStep && event === firstStep) continue
    // 只省略确已删除目标上的空退役；有内容的替换或前缀清空都必须正常重放。
    if (emptyReplacement(event) && event.sourceEventSeqs?.length &&
        event.sourceEventSeqs.every(seq => seq >= keep && seq < eventStart && !retained.has(seq))) continue
    emit(event)
  }
  // 作者锚点沿替换引用定位正文；这里只把其根坐标换为SQL实际写入位置。
  let replySeq = null
  for (let index = out.length - 1; index >= 0; index--) {
    if (out[index].type !== 'assistant/message') continue
    let root = index
    while (out[root]?.surfaceOp?.op === 'replace') {
      const parent = out[root].sourceEventSeqs?.find(seq => seq >= keep && seq < keep + root && out[seq - keep]?.type === 'assistant/message')
      if (parent === undefined) break
      root = parent - keep
    }
    replySeq = keep + root
    break
  }
  return { keep, events: out, attemptRange: { start: attemptStart, end: keep + out.length }, originalTail: clone(events.slice(keep, eventStart)),
    anchor: replySeq === null ? null : { turn: oldTurn, input: input.seq, reply: replySeq } }
}
