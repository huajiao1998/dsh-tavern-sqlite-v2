// 唯一物理回退编排：正文/变量提交同一SQL事务；跨Session库用不含旧正文的持久完成意图收敛。
// 任一层失败保留rollbackPending并拒绝游玩；重试立即完成物理清理，不等重开、不填充、不软隐藏。
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {captureRollbackBusinessState,restoreRollbackBusinessState,resolveRollbackBusinessState} from './rollback-business-state.js'
import {preflightRollback,preflightRollbackAtSeq,cleanupAfterRollbackAtSeq} from './rollback-cleanup.js'
import {awaitRollbackQuiescence} from './rollback-quiescence.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from './rollback-barrier.js'

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
export async function cleanRollback({chat,requestedTurn,availability,readChat,updateChat,chats,sessions,persistence,services,quiesce,sideCleanup,view,readCard,quiescenceTimeoutMs=8000}) {
  if (typeof quiesce !== 'function') throw new Error('回退缺少完整任务静止接口')
  if (typeof sideCleanup !== 'function') throw new Error('回退缺少业务副存储清理接口')
  if (typeof persistence?.bindRollbackArchive !== 'function' || typeof chats?.rollbackArchivePath !== 'function') throw new Error('回退缺少Session与archive持久屏障绑定')
  if (typeof persistence?.setRollbackPending !== 'function') throw new Error('回退缺少Session持久写入屏障')
  const rollbackSync=services?.rollbackSyncProvider?.()
  if (typeof rollbackSync?.assertReady!=='function' || typeof rollbackSync?.publish!=='function') throw new Error('回退缺少同连接同步接线')
  rollbackSync.assertReady()
  services={...services,requireAuxiliary:true}
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
    if (!pending) {
      const main=foregroundLease;if (!main.cold) await sessions.flush(main.session)
      const state=availability(chat,{events:main.session.snapshotEvents(),nodes:main.session.surface.nodes})
      const failed=state.failedTurns || []
      const latest=chat.messages?.findLast(row=>row.role==='assistant' && row.greeting!==true)
      const turn=failed.length?Math.min(...failed):Number(latest?.turn)
      if (!Number.isSafeInteger(turn) || turn<1 || (!failed.length && !state.canRollback)) throw new Error(state.reason || '没有安全回退目标')
      if (Number(requestedTurn)>0 && Number(requestedTurn)!==turn) throw new Error('回退目标已经变化，请刷新确认')
      let baseline=resolveRollbackBusinessState(chat,turn,failed.length>0)
      // 所选书版本在任何删库/绑定前解析；其他轮历史保持引用，不全量展开。
      if (Object.hasOwn(baseline || {}, 'worldbookRef')) {
        if (typeof chats.readRollbackWorldbook !== 'function') throw new Error('回退缺少本档世界书历史解析接线')
        if (Object.hasOwn(baseline.fields || {}, 'openingWorldbookSnapshot')) throw new Error('世界书基准同时有全文与引用')
        const book=chats.readRollbackWorldbook(chat,baseline.worldbookRef)
        if (book === undefined || book?.then) throw new Error('世界书历史解析未返回完整同步状态')
        const {worldbookRef,...withoutRef}=baseline
        baseline={...withoutRef,fields:{...baseline.fields,openingWorldbookSnapshot:book}}
      }
      if (baseline?.version!==1) throw new Error('本轮缺少完整业务回退基准；未删数据库，不使用旧白名单或当前值猜历史')
      const foreground=preflightRollback(main.session,turn,{persistence,services:{...services,coldRollback:main.cold===true,agentProvider:()=>main.agent},head:chats})
      const cuts=[{sessionId:chat.sessionId,boundarySeq:foreground.boundarySeq,role:null}]
      const mapped=chat.regeneratedDshTurns?.[String(turn)]
      if (mapped!==undefined && Number(mapped)!==turn) throw new Error('该轮存在独立重生成轮号，缺少统一原生边界基准，拒绝中间删除')
      const beforeParticipants=baseline.participants || {},currentParticipants=chat.timeline?.participants || {}
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
        if (old?.sessionId && !Number.isSafeInteger(old.boundary)) throw new Error('上一轮后台缺少权威seq边界，拒绝用-1猜删')
        // 同SID已有物理cut时按两者较早边界统一预检：旧半轮落在待删尾内不算第二个切点。
        const existing=cuts.find(cut=>cut.sessionId===id)
        const boundary=existing?Math.min(existing.boundarySeq,old?.boundary ?? -1):old?.boundary ?? -1
        const plan=preflightRollbackAtSeq(item.session,boundary,{persistence,services:{...services,coldRollback:item.cold===true,agentProvider:()=>item.agent},head:chats})
        if(existing){existing.boundarySeq=Math.min(existing.boundarySeq,plan.boundarySeq);existing.role=role}
        else cuts.push({sessionId:id,boundarySeq:plan.boundarySeq,role})
      }
      // 尚未prepare时绑定所有确切Session。崩溃在prepare后/失败位写前或清后均由archive拦写。
      const archive=chats.rollbackArchivePath(chat.id)
      for(const cut of cuts)await persistence.bindRollbackArchive(cut.sessionId,archive)
      const next=structuredClone(chat)
      restoreRollbackBusinessState(next,baseline)
      if (!Number.isSafeInteger(baseline.messageCount) || baseline.messageCount<0 || baseline.messageCount>next.messages.length) throw new Error('完整基准缺少正文前缀行数，拒绝猜删')
      // 失败轮也可能已存半截user/assistant/helper；全部按发轮前行数删尾。
      next.messages=next.messages.slice(0,baseline.messageCount)
      const branchId=randomUUID()
      next.timeline={...next.timeline,branchId,revision:Number(chat.timeline.revision)+1,checkpoints:(next.timeline.checkpoints || []).filter(cp=>Number(cp.turn)<turn),participants:{...beforeParticipants}}
      // 本轮新建participant只用于cuts清理，不写进恢复后的上轮业务账本。
      for (const cut of cuts) if (cut.role!==null && beforeParticipants[cut.role]) next.timeline.participants[cut.role]={...beforeParticipants[cut.role],role:cut.role,sessionId:cut.sessionId,branchId,boundary:cut.boundarySeq,rewindTo:null,status:'current',syncedRevision:next.timeline.revision}
      next.tavernHelperLifecycleRevision=Number(chat.tavernHelperLifecycleRevision || 0)+1
      // 意图仅存ID/边界，不存旧53正文、变量、operation负载；成功后当场删除。
      pending={version:1,id:randomUUID(),turn,cuts}
      next.rollbackPending=pending
      const expected=captureRollbackBusinessState(chat)
      await updateChat(chat.id,current=>{
        if (current._storageRevision!==chat._storageRevision || !isDeepStrictEqual(captureRollbackBusinessState(current),expected)) throw new Error('回退期间业务版本变化，拒绝覆盖')
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
      result.rolledBack={hiddenTurn:pending.turn,sync:{protocol:sync.protocol,id:sync.id,chatId:sync.chatId,revision:sync.revision}};return result
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
