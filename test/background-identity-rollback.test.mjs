// 原创临时SQLite/rc.2 Session：只核身份保留/恢复、真实目录及打开拒绝函数；零模型、零用户档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {SqliteSessionDb} from '../store.js'
import {configureRollbackCleanup,preflightRollbackAtSeq,cleanupAfterRollbackAtSeq} from '../lib/rollback-cleanup.js'
import {applyRollbackBackgroundLifetimeTransform} from '../deploy/rollback-background-lifetime-transform.mjs'
configureRollbackCleanup({sessionEvents:s=>s.snapshotEvents()})
const host=createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
const descriptor={version:3,mode:'continuable',provider:'dsh-tavern-background-tools-v4',label:'酒馆后台 Agent',agentProvider:'fixture',agentModel:'fixed'}
const official=readFileSync(new URL('../../../tmp/background-entry-20261002/subagent.js',import.meta.url),'utf8')
const parse=official.slice(official.indexOf('function parseSubagentDescriptor('),official.indexOf('function snapshotSubagentDescriptor('))
const descriptorHelpers=official.slice(official.indexOf('const SUBAGENT_DESCRIPTOR_VERSION'),official.indexOf('function parseSubagentDescriptor('))
const parseDescriptor=new Function(descriptorHelpers+parse+';return parseSubagentDescriptor')()
const fold=official.slice(official.indexOf('function foldSubagentDescriptor('),official.indexOf('\n}',official.indexOf('function foldSubagentDescriptor('))+2)
const foldDescriptor=new Function('parseSubagentDescriptor',fold+';return foldSubagentDescriptor')(parseDescriptor)
const identitySource=official.slice(official.indexOf('function descriptorIdentity('),official.indexOf('\n}',official.indexOf('function descriptorIdentity('))+2)
const descriptorIdentity=new Function('foldSubagentDescriptor',identitySource+';return descriptorIdentity')(foldDescriptor)
const controller=readFileSync(new URL('../../../tmp/background-entry-20261002/dsh-api-session-controller.js',import.meta.url),'utf8')
const validateSource=controller.slice(controller.indexOf('function validateAddress('),controller.indexOf('function rejectNotFound('))
const validateAddress=new Function('RemoteError',validateSource+';return validateAddress')(class extends Error{constructor(code,message){super(message);this.code=code}})
const loopSource=readFileSync(new URL('../../../tmp/background-context-20261002/agent-loop.js',import.meta.url),'utf8')
const inboxStart=loopSource.indexOf('\tapply(state, event) {'),inboxEnd=loopSource.indexOf('\n\twire: {',inboxStart)
const inboxFold=new Function('return ({'+loopSource.slice(inboxStart,inboxEnd)+'})')()
const foldInbox=events=>events.reduce((state,event)=>inboxFold.apply(state,event),{'next-turn':[],'next-step':[]})
async function fixture(late=false,queued=false,unstarted=false){
 const root=mkdtempSync(path.join(os.tmpdir(),'background-identity-original-'))
 const raw=readFileSync(new URL('../../../tmp/background-entry-20261002/dsh-session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(host.resolve(name)).href))
 const file=path.join(root,'session.mjs');writeFileSync(file,raw,'utf8');const {Session}=await import(pathToFileURL(file).href)
 const session=Session.create('background-original',undefined,{version:3,id:'background-original',createdAt:Date.now(),isSeeded:false,origin:'subagent',parentSession:'parent-original',cwd:root,delegationDepth:1})
 session.append('session/end-seed',{})
 if(!late)session.append('subagent/descriptor',descriptor)
 const message={id:'u',role:'user',content:[{type:'text',text:'原创旧任务'}],source:{kind:'user'}}
 const taskSeq=session.seq
 if(queued)session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]})
 if(!unstarted){
  session.append('turn/start',{turn:1})
  if(queued)session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
  session.append('user/message',message,{surfaceOp:'append'})
  if(queued){
   session.append('assistant/message',{turn:1,step:1,message:{id:'old-reply',role:'assistant',content:[{type:'text',text:'原创旧回复'}],source:{kind:'model',provider:'fixture',model:'fixed'}},stream:[]},{surfaceOp:'append'})
   session.append('tool/call',{turn:1,step:1,callId:'old-tool',name:'fixture_tool',arguments:'{}'})
   session.append('tool/result',{turn:1,step:1,message:{id:'old-result',role:'tool',toolCallId:'old-tool',content:[{type:'text',text:'原创旧结果'}],source:{kind:'tool'}}},{surfaceOp:'append'})
  }
  session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 }
 if(late)session.append('subagent/descriptor',descriptor)
 const db=new SqliteSessionDb(path.join(root,'fixture.db'));db.materialize(session.header,0,session.snapshotEvents())
 let cursor=session.seq
 const agent={phase:{kind:'idle',lastTurn:1}},registrations=new Map([['turnBoundary',{def:{key:'turnBoundary'},cells:new Map()}]])
 const services={agentProvider:()=>agent,projectionCache:{write:async()=>{}},projections:{registrations,hydrate(s,_input,events){for(const reg of registrations.values())reg.cells.set(s,{observedSeq:events.at(-1)?.seq??-1})},stateOf(s,key){return key==='inbox'?foldInbox(s.snapshotEvents()):{lastTurn:s.log.findLast(e=>e.type==='turn/end')?.data.turn??0}}}}
 const persistence={truncateEvents:async(h,n,identity)=>{const result=db.truncateFrom(n,identity);cursor=result.eventCount;return result},drainOpenHandles:async()=>{const tail=session.snapshotEvents(cursor);if(tail.length){db.appendBatch(tail,cursor);cursor=session.seq}},open:async()=>({read:async()=>({events:db.readAll().events}),close:async()=>{}})}
 const head={readSlice:async()=>({chat:{}}),update:async()=>{}}
 return {session,db,services,persistence,head,agent,taskSeq,dispose(){db.close();rmSync(root,{recursive:true,force:true})}}
}
function checkOpening(session){
 const own=session.log.filter(e=>e.type==='subagent/descriptor');assert.equal(own.length,1)
 const identity=descriptorIdentity(own[0]);assert.ok(identity)
 validateAddress({kind:'subagent',parentSessionId:'parent-original',childSessionId:session.id,mode:'continuable'},session.header,0,{values:{subagent:identity}})
}
test('旧创建切点在descriptor之前：连续初始化前缀保身份，真正轮内切点仍拒绝',async()=>{
 const f=await fixture()
 try{
  const pre=preflightRollbackAtSeq(f.session,0,{persistence:f.persistence,services:f.services,head:f.head})
  assert.equal(pre.boundarySeq,1);assert.equal(pre.keep,2)
  assert.throws(()=>preflightRollbackAtSeq(f.session,3,{persistence:f.persistence,services:f.services,head:f.head}),e=>e.code==='ROLLBACK_PREFLIGHT_MIDDLE_DELETE')
  await cleanupAfterRollbackAtSeq(f.persistence,f.session,0,f.services,{head:f.head})
  checkOpening(f.session);assert.equal(f.db.readAll().events.length,2);assert.equal(f.agent.phase.lastTurn,0)
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM events WHERE type='turn/start'").get().n,0)
 }finally{f.dispose()}
})
test('已修复尾部身份的后台再次回退：仅重建同一身份、业务尾物理零残留、官方打开校验通过',async()=>{
 const f=await fixture(true)
 try{
  await cleanupAfterRollbackAtSeq(f.persistence,f.session,0,f.services,{head:f.head})
  checkOpening(f.session);assert.deepEqual(f.session.log.map(e=>e.type),['session/end-seed','subagent/descriptor'])
  assert.deepEqual(f.db.readAll().events.map(e=>e.type),f.session.log.map(e=>e.type));assert.equal(f.agent.phase.lastTurn,0)
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM events WHERE type IN('turn/start','user/message','turn/end')").get().n,0)
  await cleanupAfterRollbackAtSeq(f.persistence,f.session,0,f.services,{head:f.head});checkOpening(f.session);assert.equal(f.session.log.length,2)
 }finally{f.dispose()}
})
test('现场v1部署缝升级：登记切点移到descriptor后且重复施缝幂等',()=>{
 const source=readFileSync(new URL('../../../tmp/background-entry-20261002/background-agent-sessions.js',import.meta.url),'utf8')
 const next=applyRollbackBackgroundLifetimeTransform(source)
 assert.ok(next.indexOf("handle.agent.session.append('subagent/descriptor'")<next.indexOf('await options.recordRollbackBoundary'))
 assert.equal(applyRollbackBackgroundLifetimeTransform(next),next)
})

for(const [late,unstarted] of [[false,false],[true,false],[false,true]])test('首轮任务入队随纯尾删除：'+(late?'尾部修复身份':unstarted?'尚未turn/start':'正常身份')+'保留且官方队列为空',async()=>{
 const f=await fixture(late,true,unstarted)
 try{
  const boundary=f.taskSeq-1
  const oldQueueBoundary=f.taskSeq
  const pre=preflightRollbackAtSeq(f.session,-1,{persistence:f.persistence,services:f.services,head:f.head})
  assert.equal(pre.boundarySeq,boundary)
  const oldPlan=preflightRollbackAtSeq(f.session,oldQueueBoundary,{persistence:f.persistence,services:f.services,head:f.head})
  assert.equal(oldPlan.boundarySeq,boundary)
  await cleanupAfterRollbackAtSeq(f.persistence,f.session,-1,f.services,{head:f.head})
  checkOpening(f.session)
  assert.deepEqual(f.services.projections.stateOf(f.session,'inbox'),{'next-turn':[],'next-step':[]})
  assert.deepEqual(foldInbox(f.db.readAll().events),{'next-turn':[],'next-step':[]})
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM events WHERE type IN('agent/inbox/spliced','turn/start','user/message','assistant/message','tool/call','tool/result','turn/end')").get().n,0)
  assert.equal(f.session.deriveMessages().some(m=>m.content.some(b=>b.text==='原创旧任务')),false)
  assert.equal(f.agent.phase.lastTurn,0)
 }finally{f.dispose()}
})
