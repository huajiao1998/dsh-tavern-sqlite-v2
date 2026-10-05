// rc.2同连接回退通知：借现有control的JSON projection帧，不改Remote协议、不断任何连接。
import assert from 'node:assert/strict'
export const ROLLBACK_SYNC_KEY='$dsh-tavern/rollback-sync-v1'
export const SESSION_CUT_SYNC_KEY='$dsh-tavern/session-cut-sync-v1'

export function installRollbackSync(ctx) {
  const controller=ctx.get('sessionController'),control=controller?.controlState
  const projections=control?.ctx?.sessionProjections
  const assertReady=()=>{
    assert.equal(typeof control?.broadcast,'function','回退缺少同连接control广播')
    assert.equal(typeof projections?.snapshot,'function','回退缺少完整状态基线')
    assert.equal(typeof control?.jobsFor,'function','回退缺少任务状态读取')
    assert.equal(typeof controller?.history?.assistantStreams?.delete,'function','回退缺少旧助手流缓存清理')
  }
  assertReady()
  // 后台任务复用只重置该child的订阅基线，不冒充剧情回退/Chat revision，不生成持久事件。
  const publishSessionCut=({session,agent})=>{
    assertReady()
    const sessionId=session?.header?.id,parentSessionId=session?.header?.parentSession
    assert.ok(typeof sessionId==='string' && session.header.origin==='subagent' && typeof parentSessionId==='string' && parentSessionId,'后台截断同步缺少真实child/parent身份')
    assert.ok(agent?.session===session && agent.phase?.kind!=='running','后台截断同步必须是已静止的同一Agent')
    const block=projections.snapshot(session),cursor=session.snapshotEvents().at(-1)?.seq??-1
    assert.equal(block.asOfSeq,cursor,'后台截断基线水位与保留日志不一致')
    const rows=agent.inbox,queues=[...rows.nextTurn.map(message=>({id:message.id,placement:'queued',message:{id:message.id,content:message.content},...(message.source.kind==='user' && 'rpcId' in message.source?{rpcId:message.source.rpcId}:{})})),...rows.nextStep.map(message=>({id:message.id,placement:message.source.kind==='user'?'steering':'context',message:{id:message.id,content:message.content},...(message.source.kind==='user' && 'rpcId' in message.source?{rpcId:message.source.rpcId}:{})}))]
    const value=structuredClone({protocol:1,sessionId,parentSessionId,asOfSeq:cursor,values:block.values,queues,jobs:control.jobsFor(agent)})
    // 该常驻Agent的助手帧revision仍递增，保留当前空闲accumulator基线；删成revision0会使下一帧跳号。
    control.broadcast({type:'projection',sessionId,key:SESSION_CUT_SYNC_KEY,seq:cursor,value})
    return value
  }
  const publish=({chat,rollbackId,hiddenTurn,subjects})=>{
    assertReady()
    assert.ok(typeof rollbackId==='string' && rollbackId.length>0,'回退同步缺少操作身份')
    assert.ok(Number.isSafeInteger(chat?._storageRevision) && chat._storageRevision>0,'回退同步缺少最终SQL版本')
    assert.ok(Array.isArray(subjects) && subjects.length>0,'回退同步缺少明确受影响会话')
    const ids=new Set()
    const sessions=subjects.map(({session,agent})=>{
      const sessionId=session?.header?.id
      assert.ok(typeof sessionId==='string' && !ids.has(sessionId),'回退同步会话身份重复或缺失');ids.add(sessionId)
      assert.ok(!agent || (agent.session===session && agent.phase?.kind!=='running'),'回退同步必须是已静止的同一Session')
      const block=projections.snapshot(session),cursor=session.snapshotEvents().at(-1)?.seq??-1
      assert.equal(block.asOfSeq,cursor,'回退完整状态水位与保留日志不一致')
      const inbox=agent?{'next-turn':agent.inbox.nextTurn,'next-step':agent.inbox.nextStep}:block.values.inbox??{'next-turn':[],'next-step':[]}
      const queues=[...inbox['next-turn'].map(message=>({id:message.id,placement:'queued',message:{id:message.id,content:message.content},...(message.source.kind==='user' && 'rpcId' in message.source?{rpcId:message.source.rpcId}:{})})),...inbox['next-step'].map(message=>({id:message.id,placement:message.source.kind==='user'?'steering':'context',message:{id:message.id,content:message.content},...(message.source.kind==='user' && 'rpcId' in message.source?{rpcId:message.source.rpcId}:{})}))]
      return {sessionId,asOfSeq:cursor,values:block.values,queues,jobs:agent?control.jobsFor(agent):[],running:false,blank:block.values.sessionListMetadata?.blank??cursor===-1,...session.header.parentSession?{parentSessionId:session.header.parentSession}:{}}
    })
    assert.ok(ids.has(chat.sessionId),'回退同步没有前台Session')
    const receipt={protocol:1,id:rollbackId,chatId:chat.id,sessionId:chat.sessionId,revision:chat._storageRevision,hiddenTurn,sessions}
    // 结构化脱离成传输边界独立值；不把会被后续运行改写的队列/投影对象留在广播buffer。
    const wire=structuredClone(receipt)
    for(const row of sessions)controller.history.assistantStreams.delete(row.sessionId)
    control.broadcast({type:'projection',sessionId:chat.sessionId,key:ROLLBACK_SYNC_KEY,seq:sessions.find(row=>row.sessionId===chat.sessionId).asOfSeq,value:wire})
    return wire
  }
  ctx.provide('tavernRollbackSync',Object.freeze({assertReady,publish,publishSessionCut}))
}
