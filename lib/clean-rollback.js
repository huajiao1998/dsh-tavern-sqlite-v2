// 唯一物理回退编排：正文/变量提交同一SQL事务；跨Session库用不含旧正文的持久完成意图收敛。
// 任一层失败保留rollbackPending并拒绝游玩；重试立即完成物理清理，不等重开、不填充、不软隐藏。
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {captureRollbackBusinessState,restoreRollbackBusinessState,resolveRollbackBusinessState} from './rollback-business-state.js'
import {latestSendRecord} from './latest-send.js'
import {foregroundInboxBoundary} from './foreground-inbox-boundary.js'
export {latestSendTarget} from './latest-send.js'
import {preflightRollback,preflightRollbackAtSeq,cleanupAfterRollbackAtSeq} from './rollback-cleanup.js'
import {awaitRollbackQuiescence} from './rollback-quiescence.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from './rollback-barrier.js'
import {inspectNativeFailureTail,isRetainedBodyEdit} from './failure-cleanup-target.js'
export {inspectNativeFailureTail} from './failure-cleanup-target.js'
export {readFailureEvidence} from './failure-view-evidence.js'

// 普通回退凭据与失败清理凭据分开；普通凭据也固定发起时档/会话/分支/版本。
function assertOrdinaryTarget(value) {
  if (!value || value.kind !== 'rollback' || !Number.isSafeInteger(value.turn) || value.turn < 1
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || ['chatId','sessionId','branchId'].some(key => typeof value[key] !== 'string' || !value[key])) throw new Error('普通回退目标格式不合法')
  if (value.operationId !== undefined && (typeof value.operationId !== 'string' || !value.operationId)) throw new Error('回退操作身份不合法')
  if (value.nativeAnchor !== undefined && (!value.nativeAnchor || value.nativeAnchor.turn !== value.turn || !Number.isSafeInteger(value.nativeAnchor.input)
    || (value.nativeAnchor.reply !== null && !Number.isSafeInteger(value.nativeAnchor.reply)))) throw new Error('回退原生锚点不合法')
  return {kind:'rollback',turn:value.turn,revision:value.revision,chatId:value.chatId,sessionId:value.sessionId,branchId:value.branchId,
    ...(value.operationId === undefined?{}:{operationId:value.operationId}),...(value.nativeAnchor === undefined?{}:{nativeAnchor:structuredClone(value.nativeAnchor)})}
}
function sameOrdinaryTarget(left,right) {
  return !!left && !!right && ['kind','turn','revision','chatId','sessionId','branchId','operationId'].every(key => left[key] === right[key])
    && isDeepStrictEqual(left.nativeAnchor,right.nativeAnchor)
}
function sameOrdinaryCompletionTarget(left,right) {
  // 已完成后仅允许原凭据重发；可放宽当前Chat已推进的版本，不得接受伪造的新凭据revision。
  return sameOrdinaryTarget(left,right)
}

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
  if (target.incomplete !== undefined && target.incomplete !== true) throw new Error('不完整轮清理标记不合法')
  if (target.incomplete === true && !nativeOnly) throw new Error('已登记正文沿重新结算或普通回退，不接受不完整正文目标')
  if (target.incomplete === true && (!Number.isSafeInteger(target.endSeq) || target.endSeq<0 || target.eventCount!==target.endSeq+1 || !target.chatId || !target.sessionId)) throw new Error('不完整轮清理缺少末尾坐标或身份')
  if (nativeOnly) {
    if (operationId !== undefined || !Number.isSafeInteger(target.endSeq) || target.endSeq < 0
      || !Number.isSafeInteger(target.eventCount) || target.eventCount !== target.endSeq+1) throw new Error('空错误清理目标格式不合法：无 operationId，须有确切 endSeq/eventCount')
    for (const key of ['chatId','sessionId']) if (typeof target[key] !== 'string' || !target[key]) throw new Error('空错误清理目标缺少身份：'+key)
  } else if (typeof operationId !== 'string' || operationId === '') throw new Error('失败清理目标格式不合法：operationId')
  for (const key of ['chatId','sessionId','rollbackId']) if (target[key] !== undefined && (typeof target[key] !== 'string' || target[key] === '')) throw new Error('失败清理目标格式不合法：' + key)
  return {turn,branchId,revision,...(target.incomplete===true?{incomplete:true,endSeq:target.endSeq,eventCount:target.eventCount}:{}),...(nativeOnly?{kind:'native-only',endSeq:target.endSeq,eventCount:target.eventCount}:{operationId}),
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
  if ((left.kind === 'native-only') !== (right.kind === 'native-only') || (left.incomplete===true)!==(right.incomplete===true)) return false
  if (left.incomplete===true && (left.endSeq!==right.endSeq || left.eventCount!==right.eventCount)) return false
  return left.kind === 'native-only'
    ? left.endSeq === right.endSeq && left.eventCount === right.eventCount
    : left.operationId === right.operationId
}
function assertNativeFailureTargetNow(chat,target,session,sessions,services,acceptedEvents) {
  if (chat.timeline?.branchId !== target.branchId) throw new Error('撤销目标分支已变化，请刷新确认')
  const events=session.snapshotEvents()
  const current=inspectNativeFailureTail(chat,{session,events},chat._storageRevision)
  const sameAcceptedTail=acceptedEvents && isDeepStrictEqual(events.slice(0,acceptedEvents.length),acceptedEvents)
    && events.slice(acceptedEvents.length).every(event=>event.type!=='turn/start'
      && !(event.type==='user/message' && event.data?.source?.kind==='user')
      && (event.data?.turn===undefined || Number(event.data.turn)===target.turn))
  if (!current?.target || current.turn !== target.turn || (!sameFailureCoordinate(current.target,target) && !sameAcceptedTail)) throw new Error(current?.target ? '不完整轮目标坐标已漂移，请刷新确认' : (current?.reason || '空错误清理目标事件坐标已变化，请刷新确认'))
}
// 最新开始轮才代表原生当前轮；编辑旧正文不能把轮计数拉回。
function sessionTurnTail(session) {
  const events=typeof session?.snapshotEvents==='function'?session.snapshotEvents():[]
  const turns=new Set()
  let tail=0
  for (const event of events) {
    const turn=Number(event?.data?.turn)
    if (!Number.isSafeInteger(turn) || turn<1) continue
    turns.add(turn);if(event.type==='turn/start')tail=turn
  }
  return {turns,tail}
}
// 会话事件流里是否留有该轮的**任何**痕迹（turn/start、turn/end、step/*、assistant/message…）。
// 一个都没有 ⇒ 原生流从未开始这一轮（正文操作已入账但 agent 尚未启动）。
function sessionHasTurn(session,turn) {
  const events=typeof session?.snapshotEvents==='function'?session.snapshotEvents():[]
  return events.some(event=>Number(event?.data?.turn)===Number(turn))
}
// 前台统一seq轴：真实发送start前保留前缀；前像已登记但原生未开始则验证noop。
// 仍经同一纯尾/引用链/四层接线预检，不按错误名称放宽，不猜删会话头/种子。
function resolveForegroundCut(session,turn,options) {
  const events=session.snapshotEvents(),start=events.find(event=>event.type==='turn/start' && Number(event.data?.turn)===turn)
  // 真正发送前前缀包含前轮完成后的独立编辑/系统事件；不能按上轮end把这些一并删掉。
  if(start && start.seq>0) {
    const input=foregroundInboxBoundary(events,turn,start.seq,options.retainedBodyEdits?.chat)
    // 队列记录可早于start；不能把该次输入保留在重折后的待领取队列。
    // 即使更早完整轮全部落在待删段，也不能以“未切半轮”为由吞掉它。
    if(events.some(event=>event.seq>input.boundarySeq && event.type==='turn/start' && Number(event.data?.turn)<turn))throw new Error('目标输入入队早于其它独立轮，拒绝扩大纯尾删除')
    // 仍保持纯尾/完整轮/引用护栏；重叠其它轮的早期输入不猜删。
    return preflightRollbackAtSeq(session,input.boundarySeq,{...options,foregroundExact:true})
  }
  if(start || sessionHasTurn(session,turn))return preflightRollback(session,turn,options)
  const boundary=events.at(-1)?.seq
  if(!Number.isSafeInteger(boundary) || boundary<0)return preflightRollback(session,turn,options)
  return preflightRollbackAtSeq(session,boundary,options)
}
// 身份统一前置：foreign 目标（另一档/另一会话）必须在**所有**路径之前拒绝——
// alreadyClean、pending 重试、正常清理三条路都不得绕过；可选字段保留，但给了就必须与现场一致。
function assertFailureTargetIdentity(chat,target) {
  if (target.chatId !== undefined && target.chatId !== chat.id) throw new Error('失败清理目标与本档身份不一致：chatId ' + target.chatId)
  if (target.sessionId !== undefined && target.sessionId !== chat.sessionId) throw new Error('失败清理目标与会话身份不一致：sessionId ' + target.sessionId)
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
  const ordinaryTarget=requestedTurn?.kind === 'rollback' ? assertOrdinaryTarget(requestedTurn) : null
  const pipelineTarget=!ordinaryTarget && requestedTurn && typeof requestedTurn === 'object' && !Array.isArray(requestedTurn) ? assertFailureTargetShape(requestedTurn) : null
  const target=failureTarget===null || failureTarget===undefined ? pipelineTarget : assertFailureTargetShape(failureTarget)
  if (pipelineTarget && target && (pipelineTarget.turn !== target.turn || pipelineTarget.branchId !== target.branchId || pipelineTarget.revision !== target.revision || !sameFailureCoordinate(pipelineTarget,target))) throw new Error('失败清理目标与会话第三参不一致，拒绝猜测：' + pipelineTarget.turn + ' vs ' + target.turn)
  const nativeOnly=target?.kind === 'native-only'
  const requestedTurnNumber=target ? 0 : ordinaryTarget?.turn ?? Number(requestedTurn)
  if (ordinaryTarget && target) throw new Error('普通回退目标不能同时携带失败清理目标')
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
    // 用户撤销先核发起凭据，避免旧页面取消另一轮任务；取消产生的终态写入不决定回退资格。
    // **只核身份与分支**（不删错档的底线）。轮次、基准一律以取得完整权威档与真实 Session 之后的
    // 读数为准——入口可能是任务摘要（taskStateFields 不含 timeline.checkpoints 与 messages），
    // 在此用投影判"是否最新发送/是否带前像"，会把可回退的最新轮误判成不可回退（现场即此报错）。
    const completedRetry=ordinaryTarget && sameOrdinaryCompletionTarget(chat.rollbackCompletion?.ordinaryTarget,ordinaryTarget)
    if (ordinaryTarget && !chat.rollbackPending && !completedRetry) {
      if (ordinaryTarget.chatId !== chat.id || ordinaryTarget.sessionId !== chat.sessionId || ordinaryTarget.branchId !== chat.timeline?.branchId) throw new Error('普通回退目标身份或分支不一致')
      if (ordinaryTarget.revision !== chat._storageRevision) throw new Error('普通回退目标版本已过期，请刷新确认')
    }
    // 旧native-only凭据保留其严格空尾验证；统一body撤销不经错误类别或静止资格门。
    // 旧凭据也只核身份/版本，活动轮由同一cancel+quiesce收口，不按失败分类决定资格。
    if(target) {
      assertFailureTargetIdentity(chat,target)
      const stillRecorded=nativeOnly || !!chat.timeline?.operations?.[target.operationId]
      if(!chat.rollbackPending && stillRecorded && (target.branchId!==chat.timeline?.branchId || target.revision!==chat._storageRevision))throw new Error('撤销目标分支或版本已变化')
    }
    const foregroundLease=await acquireTracked(chat.sessionId)
    const acceptedNative=nativeOnly && !chat.rollbackPending ? foregroundLease.session.snapshotEvents() : null
    if(acceptedNative)assertNativeFailureTargetNow(chat,target,foregroundLease.session,sessions,services)
    if (ordinaryTarget) {
      // 只核"发起凭据的原生锚点仍属于该轮的输入"（防删错数据）。
      // 不把轮次/操作身份当回退资格：静止期间若又有新轮，目标一律改取执行时的最新发送。
      if (ordinaryTarget.nativeAnchor) {
        const events=foregroundLease.session.snapshotEvents(),anchor=ordinaryTarget.nativeAnchor
        const original=events.find(event=>event.seq===anchor.input)
        const start=events.findLast(event=>event.seq<anchor.input && event.type==='turn/start')
        if(original?.type!=='user/message' || !start || Number(start.data?.turn)!==anchor.turn) throw new Error('原生输入锚点不属于目标发送，未停止或删除任何数据')
      }
    }
    await bounded(async()=>{await stop(foregroundLease.agent);await quiesce(chat)})
    chat=await readChat(chat.id)
    let pending=chat.rollbackPending
    if (ordinaryTarget && (ordinaryTarget.chatId !== chat.id || ordinaryTarget.sessionId !== chat.sessionId)) throw new Error('普通回退目标身份不一致')
    const completion=chat.rollbackCompletion
    // 同一完成请求＝同一凭据身份（同 turn/target），且 revision 未变或该轮已在 Chat 中删净；
    // 已删净说明目标已达成 ⇒ 复用原 completion id 幂等补发，不重建凭据、不删除任何数据。
    const completionSettled=completion && !(chat.messages||[]).some(row=>Number(row.turn)>=completion.turn)
    const sameCompletedRequest=!target && !pending && completion && (completion.revision === chat._storageRevision || completionSettled) && (ordinaryTarget
      ? sameOrdinaryCompletionTarget(completion.ordinaryTarget,ordinaryTarget) : requestedTurnNumber === completion.turn)
    // 陈旧凭据仅用于放宽 revision 比对；目标仍需同档/同会话/同分支/同轮，且已删净时才幂等补发。
    const staleCompletion=!target && !pending && completion && completion.version === 1
      && completion.branchId === chat.timeline?.branchId && Array.isArray(completion.cuts)
      && completion.cuts.some(cut => cut.sessionId === chat.sessionId)
      && (ordinaryTarget ? sameOrdinaryCompletionTarget(completion.ordinaryTarget,ordinaryTarget) : requestedTurnNumber === completion.turn)
    if (sameCompletedRequest) {
      if (completion.version !== 1 || completion.branchId !== chat.timeline?.branchId
        || !Array.isArray(completion.cuts) || !completion.cuts.some(cut => cut.sessionId === chat.sessionId)) throw new Error('普通回退完成记录版本已过期，请刷新确认')
      const subjects=[]
      try {
        for (const cut of completion.cuts) {
          const item=leases.find(entry=>entry.session.header.id===cut.sessionId) || await acquireTracked(cut.sessionId)
          await stopTracked(item.agent)
          if ((item.session.snapshotEvents().at(-1)?.seq ?? -1) !== cut.boundarySeq) throw new Error('回退完成后会话已推进，拒绝重发旧基线')
          rollbackBarrier.add(cut.sessionId);subjects.push(item)
        }
        const result=await view(chat,await readCard(chat))
        const verified=await readChat(chat.id)
        if (verified._storageRevision !== chat._storageRevision || verified.timeline?.branchId !== completion.branchId) throw new Error('补发完成通知期间业务版本变化，拒绝旧基线')
        const sync=rollbackSync.publish({chat,rollbackId:completion.id,hiddenTurn:completion.turn,subjects})
        result.rolledBack={hiddenTurn:completion.turn,cleanedFailureTarget:null,sync:{protocol:sync.protocol,id:sync.id,chatId:sync.chatId,revision:sync.revision}}
        return result
      } finally { for (const item of subjects) rollbackBarrier.delete(item.session.header.id) }
    }
    if (ordinaryTarget && !pending && ((!staleCompletion && ordinaryTarget.revision !== chat._storageRevision) || ordinaryTarget.branchId !== chat.timeline?.branchId)) throw new Error('普通回退目标版本已过期，请刷新确认')
    if (ordinaryTarget && pending && !sameOrdinaryTarget(pending.ordinaryTarget,ordinaryTarget)) throw new Error('普通回退完成意图与目标不一致')
    if (!target && !ordinaryTarget && pending && requestedTurnNumber > 0 && requestedTurnNumber !== pending.turn) throw new Error('普通回退完成意图与轮号不一致')
    if (target) assertFailureTargetIdentity(chat,target)
    if (pending?.failureTarget!==undefined) assertFailureTargetShape(pending.failureTarget)
    // 失败清理的完成意图只准由同一失败目标收敛：无目标的普通回退不得替它自动完成。
    if (pending && !target && pending.failureTarget) throw new Error('回退完成意图属于失败清理目标，请用同一失败目标重试：' + pending.id)
    // 重试必须沿用同一失败清理意图（身份 id+turn）；新请求不得冒认他人 pending，也不因 revision 已推进被误拒。
    if (pending && target && !sameFailureIntent(pending,target)) throw new Error('回退完成意图与本次失败清理目标不一致，拒绝冒认：' + pending.id)
    if (!pending) {
      const main=foregroundLease;if (!main.cold) await sessions.flush(main.session)
      // 兼容旧目标仅保留身份/坐标，不再调用失败可用性分类器。
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
          assertNativeFailureTargetNow(chat,target,main.session,sessions,services,acceptedNative)
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
        const selected=latestSendRecord(chat,{events:main.session.snapshotEvents()})
        if(!selected || selected.turn!==target.turn || selected.operationId!==target.operationId)throw new Error('撤销目标不是当前最新发送或缺少发轮前基准，拒绝清理')
        }
      }
      const latestSend=latestSendRecord(chat,{events:main.session.snapshotEvents()})
      // 数字旧调用与签名新调用同样只撤最新发送，不因历史失败改选更早轮。
      const turn=target?target.turn:latestSend?.turn
      if (!Number.isSafeInteger(turn) || turn<1) throw new Error('最新发送缺少完整发轮前基准，未删除任何数据')
      if (requestedTurnNumber>0 && requestedTurnNumber!==turn) throw new Error('回退目标已经变化，请刷新确认（请求轮 ' + requestedTurnNumber + '，当前最新发送轮 ' + turn + '）')
      if (ordinaryTarget?.operationId && latestSend?.operationId!==ordinaryTarget.operationId) throw new Error('最新发送操作身份已变化')
      const source=!target?latestSend?.source:null
      // 操作/检查点里已是完整发轮前像就直接用；旧 row-v1 等非完整形态仍交既有解析器升级/回溯，
      // 不在这里把不完整前像当基准（否则会误报"缺少完整业务回退基准"）。
      let baseline=nativeOnly?null:resolveRollbackBusinessState(chat,turn,source || undefined)
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
      // 真实前像允许原生无产物的核对noop；所有入口同一规则，不按失败账本放宽。
      const foregroundOptions={persistence,services:{...services,coldRollback:main.cold===true,agentProvider:()=>main.agent},head:chats}
       const retainedBodyEdits={chat,turn}
       const foreground=resolveForegroundCut(main.session,turn,{...foregroundOptions,retainedBodyEdits})
       if(retainedBodyEdits && main.session.log.some(e=>isRetainedBodyEdit(e,main.session.log,foreground.boundarySeq,chat,turn)) && services.preserveRetainedBodyEdits!==true)throw new Error('旧轮编辑保留接口未接线，拒绝丢失编辑')
      const cuts=[{sessionId:chat.sessionId,boundarySeq:foreground.boundarySeq,role:null}]
      const mapped=chat.regeneratedDshTurns?.[String(turn)]
      if (mapped!==undefined && Number(mapped)!==turn) {
        const checkpoint=chat.timeline?.checkpoints?.findLast(cp=>Number(cp.turn)===turn)
        const events=main.session.snapshotEvents()
        if (!Number.isSafeInteger(mapped) || mapped<=turn || !checkpoint?.businessBefore
          || !events.some(event=>event.type==='turn/start' && event.data?.turn===turn)
          || !events.some(event=>event.type==='turn/start' && event.data?.turn===mapped)) throw new Error('重生成缺少原轮业务基准或原生发送边界，拒绝猜删')
        // 允许删原轮及连续重生成完整尾；自有请求上下文不是玩家独立输入，不能被误拒。
        const originalEnd=events.find(event=>event.type==='turn/end' && event.data?.turn===turn)?.seq
        if (!Number.isSafeInteger(originalEnd)) throw new Error('重生成缺少原轮结束边界')
        for (const event of events.slice(foreground.keep)) {
          if (event.type==='turn/start' && event.data?.turn>mapped) throw new Error('重生成之后会话已推进，拒绝删除后继轮')
          if (event.type==='user/message' && event.seq>originalEnd) {
            const source=event.data?.source
            // 不按form类型认归属；本档trace或重生成生产者身份是记录边界，异档/玩家独立输入仍不能吞掉。
            const own=source?.kind!=='user' && (source?.trace?.chatId===chat.id
              || (source?.plugin==='dsh-tavern-regen' && (source.trace?.chatId===undefined || source.trace.chatId===chat.id)))
            if (!own) throw new Error('重生成之后存在独立输入，拒绝中间删除')
          }
        }
      }
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
        // 只比较该 Session 的发轮前切点：登记记录按 sessionId 查得，旧参与者来自业务基准。
        // old.boundary=null 的合法中间态可由同 Session 的登记切点补足。
        // current.boundary 是当前同步水位，可能包含待删轮产物，或属于换代后的另一 Session，
        // 无论数值是否合法都不能冒充发轮前前像，亦不能跨 Session 取 min。
        const authoritative=[existing?.boundarySeq,old?.sessionId===id?old.boundary:undefined].filter(value=>Number.isSafeInteger(value))
        if(old?.sessionId && !authoritative.length) throw new Error('上一轮后台缺少权威seq边界（基准快照/同Session发轮前记录均无切点），拒绝用当前水位或-1猜删')
        // 基准中不存在该参与者：沿原 -1 哨兵保留首轮前初始事件，不保留它的当前产物。
        const boundary=authoritative.length?Math.min(...authoritative):-1
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
      restoreRollbackBusinessState(next,baseline,structuredClone,chats.readRollbackWorldbook,chats.readRollbackOperationSnapshot)
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
      pending={version:1,id:randomUUID(),turn,cuts,...(target?{failureTarget:intentTarget}:{ordinaryTarget:ordinaryTarget || {kind:'rollback',turn,chatId:chat.id,sessionId:chat.sessionId,branchId:chat.timeline.branchId,revision:chat._storageRevision}})}
      delete next.rollbackCompletion
      next.rollbackPending=pending
      const expected=captureRollbackBusinessState(chat)
      await updateChat(chat.id,current=>{
        if (current._storageRevision!==chat._storageRevision || !isDeepStrictEqual(captureRollbackBusinessState(current),expected)) throw new Error('回退期间业务版本变化，拒绝覆盖')
        if (nativeOnly) assertNativeFailureTargetNow(current,target,main.session,sessions,services,acceptedNative)
        return next
      },{source:'rollback.prepare'})
    }
    if (pending.version!==1 || !Array.isArray(pending.cuts)) throw new Error('未知回退完成意图')
    for (const cut of pending.cuts) { rollbackBarrier.add(cut.sessionId); await persistence.setRollbackPending(cut.sessionId,true) }
    for (const cut of pending.cuts) {
      const item=leases.find(entry=>entry.session.header.id===cut.sessionId) || await acquireTracked(cut.sessionId)
      await stopTracked(item.agent)
      await cleanupAfterRollbackAtSeq(persistence,item.session,cut.boundarySeq,{...services,coldRollback:item.cold===true,agentProvider:()=>item.agent},{head:chats,...(cut.sessionId===chat.sessionId?{foregroundExact:true,retainedBodyEdits:{chat:await readChat(chat.id),turn:pending.turn}}:{})})
      if (!item.cold) await sessions.flush(item.session)
    }
    const prepared=await readChat(chat.id)
    if (prepared.messages?.some(row=>Number(row.turn)>=pending.turn)) throw new Error('回退正文尾部仍在，保留完成意图拒绝成功')
    await sideCleanup(prepared,pending.turn,pending.cuts)
    for (const cut of pending.cuts) await persistence.setRollbackPending(cut.sessionId,false)
    // 目标轮副数据已删；共享资源不参与剧情回退，不申请或释放跨库键保护。
    await updateChat(chat.id,current=>{
      if (current.rollbackPending?.id!==pending.id) throw new Error('回退完成意图已漂移')
      // 无业务负载的完成凭据：不拦新写；只在此SQL版本/分支与原生切点仍相同时补发同步。
      if (!pending.failureTarget) current.rollbackCompletion={...pending,cuts:pending.cuts.map(cut=>({...cut,boundarySeq:leases.find(item=>item.session.header.id===cut.sessionId).session.snapshotEvents().at(-1)?.seq ?? -1})),revision:current._storageRevision+1,branchId:current.timeline.branchId}
      delete current.rollbackPending;delete current.rollbackUndo
      return current
    },{source:'rollback.complete'})
    // SQL已完成；读档/视图/通知失败都释放运行写屏障，完成凭据允许同目标补发。
    try {
      const latest=await readChat(chat.id)
      if (latest.rollbackPending || latest.rollbackUndo || latest.messages?.some(row=>Number(row.turn)>=pending.turn)) throw new Error('回退后置核对失败')
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
