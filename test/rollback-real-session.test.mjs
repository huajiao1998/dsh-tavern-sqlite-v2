// 定向回归：真实宿主Session/SurfaceManager + 本包SQLite，不读用户数据、不请求模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { SqliteSessionDb } from '../store.js'
import { rewindSessionMemory, configureRollbackCleanup, cleanupAfterRollbackAtSeq } from '../lib/rollback-cleanup.js'
configureRollbackCleanup({sessionEvents:session=>session.snapshotEvents()})

const checkout = process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app'
const requireHost = createRequire(path.join(checkout, 'package.json'))
const roots=[]
async function loadSession() {
  const clean = new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url)
  const file = existsSync(clean) ? fileURLToPath(clean) : requireHost.resolve('@deepseek-ai/dsh-session')
  // 真身源码逐字，仅把包导入定位到本机已装宿主；无网络安装、不造Session替身。
  const source=readFileSync(file,'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g, (_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
  const root=mkdtempSync(path.join(os.tmpdir(),'tavern-real-rollback-'));roots.push(root)
  const module=path.join(root,'host-session.mjs');writeFileSync(module,source,'utf8')
  return { ...(await import(pathToFileURL(module).href)), root, origin:file }
}
function appendTurn(session,turn,model) {
  session.append('turn/start',{turn})
  session.append('request/header',{header:{config:{provider:'fixture',model},tools:[{name:'tool-'+model,description:model,parameters:{type:'object'}}]},reason:'initial'})
  session.append('request/context',{provider:'fixture',model,contextWindow:turn*100})
  session.append('user/message',{id:'user-'+turn,role:'user',content:[{type:'text',text:'输入'+turn}],source:{kind:'user'}},{surfaceOp:'append'})
  session.append('assistant/message',{turn,step:1,message:{id:'assistant-'+turn,role:'assistant',content:[{type:'text',text:'正文'+turn}],source:{kind:'model',provider:'fixture',model}},stream:[]},{surfaceOp:'append'})
  session.append('turn/end',{turn,reason:{kind:'completed'}})
}
test('真实Session：物理删尾后请求header/context与surface等于上一轮，重发再回退无幽灵',async()=>{
  const {Session,root,origin}=await loadSession()
  console.log('真实宿主源码',path.basename(path.dirname(origin)),path.basename(origin))
  const session=Session.create('session-original-fixture')
  appendTurn(session,1,'old-model')
  const prefix=[...session.snapshotEvents()],keep=session.seq,log=session.log,manager=session.surfaceManager
  const expectedHeader=session.requestHeader(),expectedContext=session.requestContext(),expectedMessages=session.deriveMessages()
  const expectedToolHistory=typeof session.toolHistory==='function'?session.toolHistory():undefined
  const db=new SqliteSessionDb(path.join(root,'session.db'))
  try {
    db.materialize(session.header,session.inheritedEventCount,prefix)
    for(let repeat=0;repeat<2;repeat++) {
      appendTurn(session,2,'deleted-model-'+repeat)
      db.appendBatch(session.snapshotEvents(keep),keep)
      // 先触发全部可用缓存，才有资格检验截短后的缓存是否回退。
      assert.equal(session.requestHeader().config.model,'deleted-model-'+repeat)
      assert.equal(session.requestContext().model,'deleted-model-'+repeat)
      if(typeof session.toolHistory==='function')session.toolHistory()
      session.deriveMessages();session.snapshotEvents()
      db.truncateFrom(keep-1)
      rewindSessionMemory(session,keep)
      assert.equal(db.db.prepare('SELECT count(*) AS n FROM events WHERE seq >= ?').get(keep).n,0)
      assert.equal(db.readMeta().eventCount,keep)
      assert.deepEqual(db.readAll().events,prefix)
      assert.equal(session.log,log);assert.equal(session.surfaceManager,manager)
      assert.deepEqual(session.snapshotEvents(),prefix)
      assert.deepEqual(session.deriveMessages(),expectedMessages)
      assert.deepEqual(session.requestHeader(),expectedHeader,'请求头不能继续拿被删除轮的缓存')
      assert.deepEqual(session.requestContext(),expectedContext,'请求上下文不能继续拿被删除轮的缓存')
      if(typeof session.toolHistory==='function')assert.deepEqual(session.toolHistory(),expectedToolHistory)
    }
  } finally {db.close()}
})
test('实际后台Host消费者：真实Session及注册表调用真正cleanup，noop与删尾都完成',async()=>{
  const {Session,root}=await loadSession()
  const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
  const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href)
  const context=new Context()
  const projections=new SessionProjectionRegistry(context)
  const {z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
  projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(state,event)=>event.type==='turn/end'?{lastTurn:event.data.turn}:state})
  const session=Session.create('background-original-fixture')
  appendTurn(session,1,'previous')
  const keep=session.seq,prefix=[...session.snapshotEvents()]
  const db=new SqliteSessionDb(path.join(root,'background.db'));db.materialize(session.header,session.inheritedEventCount,prefix)
  const agent={session,phase:{kind:'idle',lastTurn:1},runtimeContext:{retained:{seq:99,text:'被删除的独立上下文'}},requestHeaderLogged:true,requestSurfaceGeneration:99}
  const head={readSlice:async()=>({chat:{}}),update:async()=>{}}
  const records=[]
  const persistence={drainOpenHandles:async()=>{},truncateEvents:async(_header,boundary)=>{records.push('truncate');return db.truncateFrom(boundary)}}
  const services={projections,projectionCache:{write:async subject=>{records.push('checkpoint');assert.equal(projections.checkpoint(subject).turnBoundary.val.lastTurn,1)}},agentProvider:()=>agent}
  try {
    assert.equal((await cleanupAfterRollbackAtSeq(persistence,session,keep-1,services,{head})).noop,true)
    assert.equal(agent.runtimeContext.retained,undefined,'noop也必须清除不属于保留日志的上下文')
    assert.equal(agent.requestHeaderLogged,false)
    appendTurn(session,2,'dropped');db.appendBatch(session.snapshotEvents(keep),keep);agent.phase.lastTurn=2
    assert.equal(projections.stateOf(session,'turnBoundary').lastTurn,2)
    const result=await cleanupAfterRollbackAtSeq(persistence,session,keep-1,services,{head})
    assert.equal(result.truncated,true)
    assert.equal(agent.phase.lastTurn,1)
    assert.equal(agent.runtimeContext.retained,undefined,'不存在历史系统上下文时，删除独立retained')
    assert.equal(agent.requestHeaderLogged,false)
    assert.equal(agent.requestSurfaceGeneration,session.surface.replaceGeneration)
    assert.deepEqual(db.readAll().events,prefix)
    assert.deepEqual(session.snapshotEvents(),prefix)
    assert.deepEqual(records,['truncate','checkpoint','truncate','checkpoint'])
    assert.equal((await cleanupAfterRollbackAtSeq(persistence,session,keep-1,services,{head})).noop,true)
    // 使用真实宿主RuntimeContextProjection，不用自造投影语义。
    const vm=await import('node:vm')
    const runtime=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-agent-loop.js',import.meta.url),'utf8')
    const start=runtime.indexOf('var RuntimeContextProjection = class'),end=runtime.indexOf('\n};',start)+3
    const {isReplacementSurfaceEvent}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session')).href)
    const RuntimeContext=vm.runInNewContext(runtime.slice(start,end)+';RuntimeContextProjection',{
      SOURCE:'@deepseek-ai/dsh-system-prompt',CLEARED:'none',eventsNewestFirst:s=>s.snapshotEvents().toReversed(),
      isOwned:message=>message.source.kind==='plugin'&&message.source.plugin==='@deepseek-ai/dsh-system-prompt',
      textOf:message=>message.content.length===1&&message.content[0]?.type==='text'?message.content[0].text:undefined,
      isReplacementSurfaceEvent,createUserMessage:value=>value,
    })
    const scoped={on(){}}
    session.append('user/message',{id:'runtime-kept',role:'user',content:[{type:'text',text:'上一轮上下文'}],source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt'}},{surfaceOp:'append'})
    const runtimeKeep=session.seq
    db.appendBatch(session.snapshotEvents(keep),keep)
    agent.runtimeContext=new RuntimeContext(scoped,session)
    assert.equal(agent.runtimeContext.project('上一轮上下文',[]),undefined)
    appendTurn(session,2,'new')
    session.append('user/message',{id:'runtime-dropped',role:'user',content:[{type:'text',text:'本轮上下文'}],source:{kind:'plugin',plugin:'@deepseek-ai/dsh-system-prompt'}},{surfaceOp:'append'})
    agent.runtimeContext=new RuntimeContext(scoped,session)
    db.appendBatch(session.snapshotEvents(runtimeKeep),runtimeKeep)
    assert.equal(agent.runtimeContext.project('本轮上下文',[]),undefined)
    await cleanupAfterRollbackAtSeq(persistence,session,runtimeKeep-1,{...services,projectionCache:{write:async()=>{}}},{head})
    assert.equal(agent.runtimeContext.retained.text,'上一轮上下文')
    assert.equal(agent.runtimeContext.project('上一轮上下文',[]),undefined,'已恢复上轮快照，不再用被删快照比较')
    assert.ok(agent.runtimeContext.project('本轮上下文',[]),'被删快照必须允许重新提交')
  } finally {db.close();await context.fiber.dispose()}
})
test.after(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true})})
