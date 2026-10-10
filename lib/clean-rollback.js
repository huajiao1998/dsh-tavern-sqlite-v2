// 唯一物理回退编排：正文/变量提交同一SQL事务；跨Session库用不含旧正文的持久完成意图收敛。
// 任一层失败保留rollbackPending并拒绝游玩；重试立即完成物理清理，不等重开、不填充、不软隐藏。
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {captureRollbackBusinessState,restoreRollbackBusinessState,resolveRollbackBusinessState} from './rollback-business-state.js'
import {readFailureState} from './failure-state.js'
import {preflightRollback,preflightRollbackAtSeq,rollbackBoundarySeq,cleanupAfterRollbackAtSeq} from './rollback-cleanup.js'
import {awaitRollbackQuiescence} from './rollback-quiescence.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from './rollback-barrier.js'
import {inspectNativeFailureTail} from './failure-cleanup-target.js'
export {inspectNativeFailureTail} from './failure-cleanup-target.js'
export {readFailureEvidence} from './failure-view-evidence.js'

// 失败清理目标（协议字段，由 chat-session-state.rollbackViewFields 依 replayTarget 投影）：
// 正文失败用 operationId；纯守卫错误用 kind:'native-only'+endSeq/eventCount（不伪造正文操作）。
// 两者均 pin turn/branchId/revision；native 必带 chatId/sessionId；重试必须带 rollbackId（= pending.id）。
function assertFailureTargetShape(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('失败清理目标格式不合法：须为对象')
  const {turn,branchId,revision,operationId}=target
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error('失败清理目标格式不合法：turn 必须为正整数')
  if (typeof branchId !== 'string' || branchId === '') throw new Error('失败清理目标格式不合法：branchId')
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('失败清理目标格式不合法：revision 须为 chat._storageRevision')
  if (target.kind !== undefined && target.kind !== 'body' && target.kind !== 'native-only') throw new Error('失败清理目标格式不合法：kind')
  const nativeOnly=target.kind === 'native-only'
  if (nativeOnly) {
    if (operationId !== undefined || !Number.isSafeInteger(target.endSeq) || target.endSeq < 0
      || !Number.isSafeInteger(target.eventCount) || target.eventCount !== target.endSeq+1) throw new Error('空错误清理目标格式不合法：无 operationId，须有确切 endSeq/eventCount')
    for (const key of ['chatId','sessionId']) if (typeof target[key] !== 'string' || !target[key]) throw new Error('空错误清理目标缺少身份：'+key)
  } else if (typeof operationId !== 'string' || operationId === '') throw new Error('失败清理目标格式不合法：operationId')
  for (const key of ['chatId','sessionId','rollbackId']) if (target[key] !== undefined && (typeof target[key] !== 'string' || target[key] === '')) throw new Error('失败清理目标格式不合法：' + key)
  return {turn,branchId,revision,...(nativeOnly?{kind:'native-only',endSeq:target.endSeq,eventCount:target.eventCount}:{operationId}),
    ...(target.chatId === undefined?{}:{chatId:target.chatId}),...(target.sessionId === undefined?{}:{sessionId:target.sessionId}),...(target.rollbackId === undefined?{}:{rollbackId:target.rollbackId})}
}
// 重试判定：pending.failureTarget 的 turn+operationId+branchId+revision 四项**全部 exact**，
// 且必须带 retry id（target.rollbackId===pending.id）——不允许选填、也不允许凭旧 op+turn 冒认他人意图。
// 比的是 pending 里存的**发起时快照**（原 branch/revision），不是当前已推进的现场值。
function sameFailureIntent(pending,target) {
  const recorded=pending?.failureTarget
  if (!recorded) return false
  if (Number(recorded.turn)!==Number(target.turn)) return false
  if (!sameFailureCoordinate(recorded,target)) return false
  if (recorded.branchId!==target.branchId) return false
  if (Number(recorded.revision)!==Number(target.revision)) return false
  return target.rollbackId===pending.id
}
function sameFailureCoordinate(left,right) {
  if ((left.kind === 'native-only') !== (right.kind === 'native-only')) return false
  return left.kind === 'native-only'
    ? left.endSeq === right.endSeq && left.eventCount === right.eventCount
    : left.operationId === right.operationId
}
function assertNativeFailureTargetNow(chat,target,session) {
  if (chat.timeline?.branchId !== target.branchId || chat._storageRevision !== target.revision) throw new Error('空错误清理目标分支或存储版本已变化，请刷新确认')
  const current=inspectNativeFailureTail(chat,{session,events:session.snapshotEvents()},chat._storageRevision)
  if (!current?.target || current.turn !== target.turn || !sameFailureCoordinate(current.target,target)) throw new Error(current?.reason || '空错误清理目标事件坐标已变化，请刷新确认')
}
// 会话事件尾：事件流里最后一个带 turn 的事件（不是 failed 最大值）。目标必须是尾，且流里确有该轮事件。
function sessionTurnTail(session) {
  const events=typeof session?.snapshotEvents==='function'?session.snapshotEvents():[]
  const turns=new Set()
  let tail=0
  for (const event of events) {
    const turn=Number(event?.data?.turn)
    if (!Number.isSafeInteger(turn) || turn<1) continue
    turns.add(turn);tail=turn
  }
  return {turns,tail}
}
// 会话事件流里是否留有该轮的**任何**痕迹（turn/start、turn/end、step/*、assistant/message…）。
// 一个都没有 ⇒ 原生流从未开始这一轮（正文操作已入账但 agent 尚未启动）。
function sessionHasTurn(session,turn) {
  const events=typeof session?.snapshotEvents==='function'?session.snapshotEvents():[]
  return events.some(event=>Number(event?.data?.turn)===Number(turn))
}
// 前台原生截断点。轮次轴（preflightRollback）要求事件流里有该轮的生命周期；准备期失败的正文轮
// 没有，此时会话尾恰好停在**上一轮 turn/end**，轮次轴的 NOTHING_TO_TRUNCATE 会把"原生流本来就
// 是干净的"误判成回退失败。改用 seq 轴取它"核对过的无事可做"口径（preflightRollbackAtSeq 的
// noop）—— 仍是同一条 runRollbackPreflight 判据（纯尾/引用链/四层接线），只放行已核对的无事
// 可做，不放行"猜不出边界"：连上一轮 turn/end 都没有时仍走轮次轴响亮拒绝（禁删会话头/种子）。
// cleanNativeTail=false 时完全不改原路径。
function resolveForegroundCut(session,turn,options,cleanNativeTail) {
  if (!cleanNativeTail || sessionHasTurn(session,turn)) return preflightRollback(session,turn,options)
  const boundary=rollbackBoundarySeq(session,turn)
  if (!Number.isSafeInteger(boundary) || boundary<0) return preflightRollback(session,turn,options)
  return preflightRollbackAtSeq(session,boundary,options)
}
// 身份统一前置：foreign 目标（另一档/另一会话）必须在**所有**路径之前拒绝——
// alreadyClean、pending 重试、正常清理三条路都不得绕过；可选字段保留，但给了就必须与现场一致。
function assertFailureTargetIdentity(chat,target) {
  if (target.chatId !== undefined && target.chatId !== chat.id) throw new Error('失败清理目标与本档身份不一致：chatId ' + target.chatId)
  if (target.sessionId !== undefined && target.sessionId !== chat.sessionId) throw new Error('失败清理目标与会话身份不一致：sessionId ' + target.sessionId)
}
// 指定正文失败清理不能借用作者的“表面失败轮”：仅有酒馆上下文的 aborted 轮会被它忽略，
// 即使该轮 body 已 failed 且有基准，也会返回 failedTurns=[] / canRollback=true（指向上轮成功正文）。
// 权威是本会话的完整原生失败生命周期；截断/引用链仍交后续严格纯尾预检，不做表面软清。
function assertBodyFailureLifecycle(session,target) {
  const events=session?.snapshotEvents?.()
  if (!Array.isArray(events) || (target.sessionId!==undefined && session.header?.id!==target.sessionId)) throw new Error('失败清理缺少同一原生会话证据，拒绝猜测')
  if (events.some((event,index)=>event?.seq!==index)) throw new Error('失败清理原生事件坐标不连续，拒绝物理处理')
  const starts=[],ends=[]
  for (let index=0;index<events.length;index++) {
    const event=events[index]
    if (Number(event.data?.turn)!==target.turn) continue
    if (event.type==='turn/start') starts.push(index)
    if (event.type==='turn/end') ends.push(index)
  }
  if (starts.length!==1 || ends.length!==1 || starts[0]>=ends[0]) throw new Error('失败清理目标不成立：原生目标轮缺少唯一完整失败开始/结束；拒绝降级为正常轮回退')
  if (!['error','aborted'].includes(events[ends[0]].data?.reason?.kind)) throw new Error('失败清理目标不成立：原生目标轮不是失败结束；拒绝降级为正常轮回退')
  if (events.slice(ends[0]+1).some(event=>event.type!=='session/end-seed')) throw new Error('失败清理目标结束后仍有事件推进，请刷新确认；拒绝中间删除')
}
// 与当前现场严格比对：指定轮的原生失败＋正文 failed 操作、分支/版本、完整基准与纯尾事实。
// 作者表面 failedTurns 只保留给不指定失败目标的普通回退，不能把它的空数组当作原生失败不存在。
function assertFailureTargetNow(chat,state,target,options={}) {
  const failed=(state.failedTurns || []).map(Number).filter(Number.isSafeInteger)
  // 表面报告更晚失败时仍拒旧目标；它不认识当前上下文轮，不能据缺席否定原生失败。
  const latest=Math.max(0,...failed)
  if (latest>target.turn) throw new Error('失败清理目标不是当前最新失败轮，历史失败不清理：目标 ' + target.turn + '，当前最新失败 ' + latest)
  assertFailureTargetIdentity(chat,target)
  if (chat.timeline?.branchId !== target.branchId) throw new Error('失败清理目标已漂移（分支已变），请刷新确认')
  if (Number(chat._storageRevision) !== target.revision) throw new Error('失败清理目标已漂移（存储版本已变），请刷新确认')
  const operation=chat.timeline?.operations?.[target.operationId]
  if (!operation || operation.kind !== 'body' || Number(operation.turn) !== target.turn) throw new Error('失败清理目标不是当前失败的正文操作；拒绝清理')
  if (operation.status !== 'failed') throw new Error('失败清理目标正文操作不是 failed 状态；拒绝清理')
  if (!operation.businessBefore && !(operation.rowBefore && operation.beforeParticipants)) throw new Error('失败清理缺少该轮业务回退基准（无 businessBefore/rowBefore），界面不可清理；不猜历史')
  // 成功只认 completed checkpoint / op status：同轮已有的半截 assistant 行属于“未完成回复”，必须照清，不得据此拒。
  if ((chat.timeline?.checkpoints || []).some(cp => Number(cp.turn) === target.turn)) throw new Error('失败清理目标轮已有完成检查点，不是失败态；拒绝清理')
  if (operation.businessBefore) {
    if (operation.businessBefore.version !== 1) throw new Error('失败清理基准版本不合法，拒绝物理处理')
    const count=operation.businessBefore.messageCount
    if (!Number.isSafeInteger(count) || count < 0 || count > (chat.messages || []).length) throw new Error('失败清理基准的正文前缀行数不合法，拒绝物理处理：' + count)
  }
  // 必须是真实会话尾：其后不得有任何成功正文/任务推进（拒绝中间删除）。
  for (const [id,op] of Object.entries(chat.timeline?.operations || {})) if (id !== target.operationId && Number(op?.turn) > target.turn) throw new Error('失败清理目标之后仍有任务推进，拒绝中间删除：' + id)
  const afterRow=(chat.messages || []).find(row => Number(row.turn) > target.turn)
  if (afterRow) throw new Error('失败清理目标之后仍有正文行，拒绝中间删除：turn ' + afterRow.turn)
  const afterCheckpoint=(chat.timeline?.checkpoints || []).find(cp => Number(cp.turn) > target.turn)
  if (afterCheckpoint) throw new Error('失败清理目标之后仍有成功正文检查点，拒绝中间删除：turn ' + afterCheckpoint.turn)
  for (const ownerTurn of Object.keys(chat.rollbackSessionCuts || {})) if (Number(ownerTurn) > target.turn) throw new Error('失败清理目标之后仍有后台任务落库边界，拒绝中间删除：轮 ' + ownerTurn)
  if (options.session) {
    const {turns,tail}=sessionTurnTail(options.session)
    if (!turns.has(target.turn)) throw new Error('会话事件流缺少目标轮落库事件，拒绝清理：turn ' + target.turn)
    if (tail !== target.turn) throw new Error('目标轮不是会话事件尾（当前事件尾 turn ' + tail + '），拒绝中间删除')
  }
  assertBodyFailureLifecycle(options.session,target)
}
async function acquire(sessions,id,persistence) {
  let agent=sessions.get(id),session=agent?.session || sessions.getSession?.(id),handle
  if (!session || !agent) {
    if (typeof persistence.loadRollbackSession !== 'function') throw new Error('回退缺少冷Session只读装载接线：'+id)
    if (session) throw new Error('回退Session已加载但无Agent，拒绝另建副本：'+id)
    session=await persistence.loadRollbackSession(id)
    return {session,agent:undefined,handle:undefined,cold:true}
  }
  if (!session || !agent) { await handle?.dispose?.();throw new Error('回退必须取得权威Session及Agent：'+id) }
  return {agent,session,handle}
}
async function stop(agent) {
  if (!agent) return // 冷Session没有运行循环，后续自然从已提交前缀构造Agent。
  if (agent.phase?.kind === 'running') {
    if (typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function') throw new Error('宿主缺少停止/等待Agent能力')
    agent.cancel({kind:'parent'});await agent.whenIdle()
  }
  if (!agent.phase || agent.phase.kind === 'running') throw new Error('Agent尚未静止，拒绝回退')
}
export async function cleanRollback({chat,requestedTurn,availability,readChat,updateChat,chats,sessions,persistence,services,quiesce,sideCleanup,view,readCard,quiescenceTimeoutMs=8000,failureTarget=null}) {
  if (typeof quiesce !== 'function') throw new Error('回退缺少完整任务静止接口')
  if (typeof sideCleanup !== 'function') throw new Error('回退缺少业务副存储清理接口')
  if (typeof persistence?.bindRollbackArchive !== 'function' || typeof chats?.rollbackArchivePath !== 'function') throw new Error('回退缺少Session与archive持久屏障绑定')
  if (typeof persistence?.setRollbackPending !== 'function') throw new Error('回退缺少Session持久写入屏障')
  const rollbackSync=services?.rollbackSyncProvider?.()
  if (typeof rollbackSync?.assertReady!=='function' || typeof rollbackSync?.publish!=='function') throw new Error('回退缺少同连接同步接线')
  rollbackSync.assertReady()
  services={...services,requireAuxiliary:true}
  // 宿主 RPC 第三参（args.failureTarget || args.expectedTurn）经 rollbackTurn 原样进 requestedTurn：
  // 若它是对象就按失败清理目标解释；显式 failureTarget 仍支持（测试/内部调用），两者同时给必须一致。
  const pipelineTarget=requestedTurn && typeof requestedTurn === 'object' && !Array.isArray(requestedTurn) ? assertFailureTargetShape(requestedTurn) : null
  const target=failureTarget===null || failureTarget===undefined ? pipelineTarget : assertFailureTargetShape(failureTarget)
  if (pipelineTarget && target && (pipelineTarget.turn !== target.turn || pipelineTarget.branchId !== target.branchId || pipelineTarget.revision !== target.revision || !sameFailureCoordinate(pipelineTarget,target))) throw new Error('失败清理目标与会话第三参不一致，拒绝猜测：' + pipelineTarget.turn + ' vs ' + target.turn)
  const nativeOnly=target?.kind === 'native-only'
  const requestedTurnNumber=target ? 0 : Number(requestedTurn)
  const leases=[]
  if (rollbackSchedulingBarrier.has(chat.sessionId)) throw new Error('回退或旧任务静止仍在进行，禁止并发回退')
  let quiescenceTask,quiescenceSettled=false
  rollbackSchedulingBarrier.add(chat.sessionId)
  async function bounded(work) {
    quiescenceSettled=false;quiescenceTask=work()
    quiescenceTask.then(()=>{quiescenceSettled=true},()=>{quiescenceSettled=true})
    return await awaitRollbackQuiescence(quiescenceTask,quiescenceTimeoutMs,'回退静止等待超时；当前清理阶段未继续，原任务结束前继续禁止新任务')
  }
  const acquireTracked=id=>bounded(async()=>{const item=await acquire(sessions,id,persistence);leases.push(item);return item})
  const stopTracked=agent=>bounded(()=>stop(agent))
  try {
    const foregroundLease=await acquireTracked(chat.sessionId)
    await bounded(async()=>{await stop(foregroundLease.agent);await quiesce(chat)})
    chat=await readChat(chat.id)
    let pending=chat.rollbackPending
    if (target) assertFailureTargetIdentity(chat,target)
    if (pending?.failureTarget!==undefined) assertFailureTargetShape(pending.failureTarget)
    // 失败清理的完成意图只准由同一失败目标收敛：无目标的普通回退不得替它自动完成。
    if (pending && !target && pending.failureTarget) throw new Error('回退完成意图属于失败清理目标，请用同一失败目标重试：' + pending.id)
    // 重试必须沿用同一失败清理意图（身份 id+turn）；新请求不得冒认他人 pending，也不因 revision 已推进被误拒。
    if (pending && target && !sameFailureIntent(pending,target)) throw new Error('回退完成意图与本次失败清理目标不一致，拒绝冒认：' + pending.id)
    if (!pending) {
      const main=foregroundLease;if (!main.cold) await sessions.flush(main.session)
      // 失败状态**一次算清**（lib/failure-state.js）：账本 + 作者的表面判据 + 事件流尾。
      // 守卫 fence 与本编排读的是同一份投影，两侧判据不再各算各的（缺陷 A 的根治）。
      // 必须在这里算：chat 刚重读过、前台 lease 已到手，预算好的值会是旧的。
      const state=readFailureState(chat,{availability,events:main.session.snapshotEvents(),nodes:main.session.surface.nodes})
      const failed=state.failedTurns
      if (target) {
        if (nativeOnly) {
          const events=main.session.snapshotEvents(),{turns,tail}=sessionTurnTail(main.session)
          if (tail < target.turn && !turns.has(target.turn) && events.length < target.eventCount
            && !(chat.messages || []).some(row=>Number(row.turn)>=target.turn)
            && !Object.values(chat.timeline?.operations || {}).some(op=>Number(op?.turn)>=target.turn)
            && !(chat.timeline?.checkpoints || []).some(cp=>Number(cp.turn)>=target.turn)) {
            const cleanView=await view(chat,await readCard(chat))
            return {...cleanView,changed:false,alreadyClean:true,cleanedFailureTarget:target,rolledBack:{alreadyClean:true,cleanedFailureTarget:target}}
          }
          if (target.rollbackId !== undefined) throw new Error('失败清理重试标识与当前完成意图不一致，请刷新确认')
          assertNativeFailureTargetNow(chat,target,main.session)
        } else {
        const operation=chat.timeline?.operations?.[target.operationId]
        // 目标正文操作已不在：以**当前事件尾**区分「已清理」与「目标已变」——历史失败轮（旧 failed）不参与本判定。
        if (!operation) {
          const {tail}=sessionTurnTail(main.session)
          if (tail > target.turn) throw new Error('失败清理目标已变化：目标操作已不在且事件尾已推进到 turn ' + tail + '，拒绝清理且不删除任何正文')
          if (tail < target.turn && !(chat.messages || []).some(row => Number(row.turn) >= target.turn)) {
            // 已清理干净（此时历史 failed 通常仍在，不能要求 failed=[]）：同形完整 view + 无 sync，changed 且零写。
            const cleanView=await view(chat,await readCard(chat))
            return {...cleanView,changed:false,alreadyClean:true,cleanedFailureTarget:target,rolledBack:{alreadyClean:true,cleanedFailureTarget:target}}
          }
          throw new Error('失败清理目标状态不明确：目标操作已不在但事件尾/正文残留不一致（事件尾 turn ' + tail + '），拒绝清理且不删除任何正文')
        }
        // 目标操作仍在：核原生 ended-failed 与业务基准；表面 failed=[] 不冒认上轮正常回退。
        if (target.rollbackId!==undefined) throw new Error('失败清理重试标识与当前完成意图不一致，请刷新确认')
        assertFailureTargetNow(chat,state,target,{session:main.session})
        }
      }
      const latest=chat.messages?.findLast(row=>row.role==='assistant' && row.greeting!==true)
      // 失败清理只清当前**最新**失败（Math.max）；普通回退保持原语义（最早失败 Math.min / 正常轮）。
      const turn=target?target.turn:(failed.length?Math.min(...failed):Number(latest?.turn))
      if (!Number.isSafeInteger(turn) || turn<1 || (!target && !failed.length && !state.canRollback)) throw new Error(state.reason || '没有安全回退目标')
      if (requestedTurnNumber>0 && requestedTurnNumber!==turn) throw new Error('回退目标已经变化，请刷新确认')
      // 空守卫轮仅截断原生尾；不要求也不猜造该轮业务基准。正文失败仍严格走原基准。
      let baseline=nativeOnly?null:resolveRollbackBusinessState(chat,turn,Boolean(target) || failed.length>0)
      // 所选书版本在任何删库/绑定前解析；其他轮历史保持引用，不全量展开。
      if (Object.hasOwn(baseline || {}, 'worldbookRef')) {
        if (typeof chats.readRollbackWorldbook !== 'function') throw new Error('回退缺少本档世界书历史解析接线')
        if (Object.hasOwn(baseline.fields || {}, 'openingWorldbookSnapshot')) throw new Error('世界书基准同时有全文与引用')
        const book=chats.readRollbackWorldbook(chat,baseline.worldbookRef)
        if (book === undefined || book?.then) throw new Error('世界书历史解析未返回完整同步状态')
        const {worldbookRef,...withoutRef}=baseline
        baseline={...withoutRef,fields:{...baseline.fields,openingWorldbookSnapshot:book}}
      }
      if (!nativeOnly && baseline?.version!==1) throw new Error('本轮缺少完整业务回退基准；未删数据库，不使用旧白名单或当前值猜历史')
      // cleanNativeTail：只有账本失败正文轮才允许走"原生流本来就干净"的 noop 口径；
      // 普通回退完全不走这条路（原判据：只在 ledgerFailed.includes(turn) 时放宽）。
      const foreground=resolveForegroundCut(main.session,turn,{persistence,services:{...services,coldRollback:main.cold===true,agentProvider:()=>main.agent},head:chats},state.ledgerFailed.includes(turn))
      const cuts=[{sessionId:chat.sessionId,boundarySeq:foreground.boundarySeq,role:null}]
      const mapped=chat.regeneratedDshTurns?.[String(turn)]
      if (mapped!==undefined && Number(mapped)!==turn) throw new Error('该轮存在独立重生成轮号，缺少统一原生边界基准，拒绝中间删除')
      const beforeParticipants=baseline?.participants || {},currentParticipants=chat.timeline?.participants || {}
      if (!nativeOnly) {
      const recordedCuts={}
      // 最早失败轮可能后面还有已落库任务；所有被删轮次的独立Session都必须纳入。
      for(const [ownerTurn,entries] of Object.entries(chat.rollbackSessionCuts || {})) {
        if(Number(ownerTurn)<turn)continue
        if(!Number.isSafeInteger(Number(ownerTurn)) || !entries || typeof entries!=='object' || Array.isArray(entries))throw new Error('后台任务轮归属记录无效')
        for(const [id,boundary] of Object.entries(entries)) {
          if(!Number.isSafeInteger(boundary))throw new Error('后台任务初始seq记录无效')
          recordedCuts[id]=Object.hasOwn(recordedCuts,id)?Math.min(recordedCuts[id],boundary):boundary
        }
      }
      const knownIds=new Set([chat.sessionId,...Object.keys(recordedCuts),...Object.values(beforeParticipants).map(p=>p.sessionId),...Object.values(currentParticipants).map(p=>p.sessionId)].filter(Boolean))
      for (const [operationId,operation] of Object.entries(chat.timeline?.operations || {})) {
        if (baseline.operationIds.includes(operationId)) continue
        const id=operation.startedSessionId
        if (id && !knownIds.has(id)) throw new Error('发现未纳入回退边界的独立任务会话，拒绝遗漏：'+id)
      }
      for (const [id,boundary] of Object.entries(recordedCuts)) {
        if(id===chat.sessionId || !Number.isSafeInteger(boundary))throw new Error('后台任务初始seq记录无效')
        const item=await acquireTracked(id);await stopTracked(item.agent);if (!item.cold) await sessions.flush(item.session)
        const plan=preflightRollbackAtSeq(item.session,boundary,{persistence,services:{...services,coldRollback:item.cold===true,agentProvider:()=>item.agent},head:chats})
        cuts.push({sessionId:id,boundarySeq:plan.boundarySeq,role:null})
      }
      for (const role of new Set([...Object.keys(beforeParticipants),...Object.keys(currentParticipants)])) {
        const old=beforeParticipants[role],current=currentParticipants[role],id=old?.sessionId || current?.sessionId
        if (!id) continue
        if (old?.sessionId && current?.sessionId && old.sessionId!==current.sessionId && !Object.hasOwn(recordedCuts,current.sessionId)) throw new Error('后台会话身份已替换，缺少全部参与者物理边界，拒绝遗漏')
        const item=await acquireTracked(id);await stopTracked(item.agent);if (!item.cold) await sessions.flush(item.session)
        const existing=cuts.find(cut=>cut.sessionId===id)
        // 权威 seq 边界的三处来源（都必须是安全整数）：
        //   · existing  —— rollbackSessionCuts 登记的"该后台任务开始前最后一条事件 seq"
        //                  （作者 index.js recordRollbackBoundary：session.log.at(-1).seq）；
        //   · current   —— 现行 participant：作者 prose-authoritative 的已同步水位；
        //   · old       —— 上轮业务基准快照里的 participant。
        // ⚠ old 单独**不是**资格判据：作者 commitParticipant（story-timeline.js:302-312，注释
        //   "Never transfer a boundary between sessions"）会合法写出
        //   {status:'current',boundary:null,syncedRevision:null} 的"已绑定未同步"中间态。
        //   2026-10-10 两份现场实测（chat-muzd2bvc-go5gnx turn 83/113）：baseline 快照停在
        //   null/null，而同一 sessionId 的现行 participant 已是 syncedRevision=34/boundary=48、
        //   rollbackSessionCuts['113'][sid]=34 —— 权威值一直都在，只是不在 old 里。
        // 合并取**较早**边界：recordedCuts 记的是本后台任务的起点，比失败后作者又推进的水位
        // 更靠前 ⇒ min 恰好删掉该轮的后台产物尾，业务基准与后台库才一致。
        const authoritative=[existing?.boundarySeq,current?.boundary,old?.boundary].filter(value=>Number.isSafeInteger(value))
        if(old?.sessionId && !authoritative.length) throw new Error('上一轮后台缺少权威seq边界（基准快照/现行参与者/会话切点三者都没有权威 seq），拒绝用-1猜删')
        // 三处都缺：保持原 -1 哨兵语义（新建 participant ⇒ 保留首个 turn/start 之前的初始事件）。
        const boundary=authoritative.length?Math.min(...authoritative):(old?.boundary ?? -1)
        const plan=preflightRollbackAtSeq(item.session,boundary,{persistence,services:{...services,coldRollback:item.cold===true,agentProvider:()=>item.agent},head:chats})
        if(existing){existing.boundarySeq=Math.min(existing.boundarySeq,plan.boundarySeq);existing.role=role}
        else cuts.push({sessionId:id,boundarySeq:plan.boundarySeq,role})
      }
      }
      // 尚未prepare时绑定所有确切Session。崩溃在prepare后/失败位写前或清后均由archive拦写。
      const archive=chats.rollbackArchivePath(chat.id)
      for(const cut of cuts)await persistence.bindRollbackArchive(cut.sessionId,archive)
      const next=structuredClone(chat)
      if (!nativeOnly) {
      restoreRollbackBusinessState(next,baseline)
      if (!Number.isSafeInteger(baseline.messageCount) || baseline.messageCount<0 || baseline.messageCount>next.messages.length) throw new Error('完整基准缺少正文前缀行数，拒绝猜删')
      // 失败轮也可能已存半截user/assistant/helper；全部按发轮前行数删尾。
      next.messages=next.messages.slice(0,baseline.messageCount)
      const branchId=randomUUID()
      next.timeline={...next.timeline,branchId,revision:Number(chat.timeline.revision)+1,checkpoints:(next.timeline.checkpoints || []).filter(cp=>Number(cp.turn)<turn),participants:{...beforeParticipants}}
      // 本轮新建participant只用于cuts清理，不写进恢复后的上轮业务账本。
      for (const cut of cuts) if (cut.role!==null && beforeParticipants[cut.role]) next.timeline.participants[cut.role]={...beforeParticipants[cut.role],role:cut.role,sessionId:cut.sessionId,branchId,boundary:cut.boundarySeq,rewindTo:null,status:'current',syncedRevision:next.timeline.revision}
      }
      // 空守卫轮保留所有业务与正文分支，仅推进生命周期以拒绝旧运行提交。
      next.tavernHelperLifecycleRevision=Number(chat.tavernHelperLifecycleRevision || 0)+1
      // 意图仅存ID/边界，不存旧53正文、变量、operation负载；成功后当场删除。
      // 失败清理另存 failureTarget（身份＝turn/operationId；branchId/revision 为发起时快照，仅诊断用），
      // 供重试按身份收敛——投影时由宿主补 rollbackId=pending.id，不据此重比已推进的 revision。
      const {rollbackId:oldRollbackId,...intentTarget}=target || {}
      pending={version:1,id:randomUUID(),turn,cuts,...(target?{failureTarget:intentTarget}:{})}
      next.rollbackPending=pending
      const expected=captureRollbackBusinessState(chat)
      await updateChat(chat.id,current=>{
        if (current._storageRevision!==chat._storageRevision || !isDeepStrictEqual(captureRollbackBusinessState(current),expected)) throw new Error('回退期间业务版本变化，拒绝覆盖')
        if (nativeOnly) assertNativeFailureTargetNow(current,target,main.session)
        return next
      },{source:'rollback.prepare'})
    }
    if (pending.version!==1 || !Array.isArray(pending.cuts)) throw new Error('未知回退完成意图')
    for (const cut of pending.cuts) { rollbackBarrier.add(cut.sessionId); await persistence.setRollbackPending(cut.sessionId,true) }
    for (const cut of pending.cuts) {
      const item=leases.find(entry=>entry.session.header.id===cut.sessionId) || await acquireTracked(cut.sessionId)
      await stopTracked(item.agent)
      await cleanupAfterRollbackAtSeq(persistence,item.session,cut.boundarySeq,{...services,coldRollback:item.cold===true,agentProvider:()=>item.agent},{head:chats})
      if (!item.cold) await sessions.flush(item.session)
    }
    const prepared=await readChat(chat.id)
    if (prepared.messages?.some(row=>Number(row.turn)>=pending.turn)) throw new Error('回退正文尾部仍在，保留完成意图拒绝成功')
    await sideCleanup(prepared,pending.turn,pending.cuts)
    for (const cut of pending.cuts) await persistence.setRollbackPending(cut.sessionId,false)
    // 目标轮副数据已删；共享资源不参与剧情回退，不申请或释放跨库键保护。
    await updateChat(chat.id,current=>{
      if (current.rollbackPending?.id!==pending.id) throw new Error('回退完成意图已漂移')
      delete current.rollbackPending;delete current.rollbackUndo
      return current
    },{source:'rollback.complete'})
    const latest=await readChat(chat.id)
    if (latest.rollbackPending || latest.rollbackUndo || latest.messages?.some(row=>Number(row.turn)>=pending.turn)) throw new Error('回退后置核对失败')
    // SQL已完成；基线发布期间仍保持写屏障，通知/视图失败则响亮报错而不永久锁死。
    try {
      const result=await view(latest,await readCard(latest))
      const sync=rollbackSync.publish({chat:latest,rollbackId:pending.id,hiddenTurn:pending.turn,subjects:pending.cuts.map(cut=>leases.find(item=>item.session.header.id===cut.sessionId))})
      // 成功回执统一带 cleanedFailureTarget（普通回退为 null）：client 用它核对 receipt 的 turn/op/branch。
      result.rolledBack={hiddenTurn:pending.turn,cleanedFailureTarget:pending.failureTarget ?? null,sync:{protocol:sync.protocol,id:sync.id,chatId:sync.chatId,revision:sync.revision}};return result
    } finally { for (const cut of pending.cuts) rollbackBarrier.delete(cut.sessionId) }
  } finally {
    const release=async()=>{
      try{for (const {handle} of leases.toReversed()) await handle?.dispose?.()}
      finally{rollbackSchedulingBarrier.delete(chat.sessionId)}
    }
    if(quiescenceTask && !quiescenceSettled)quiescenceTask.then(release,release).catch(error=>console.error('回退静止后租约释放失败',error))
    else await release()
  }
}
