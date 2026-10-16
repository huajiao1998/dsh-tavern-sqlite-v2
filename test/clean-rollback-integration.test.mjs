// 原创隔离archive+Session SQLite组合；用实际rc.2 Session、projection registry和turn()。
// 不读用户数据，不请求模型；adapter仅提供作者读写/availability契约，非真实页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {SqliteSessionDb} from '../store.js'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {cleanRollback,inspectNativeFailureTail} from '../lib/clean-rollback.js'
import {installRollbackSync} from '../lib/rollback-sync.js'
import {applyRowTimelineTransform} from '../deploy/row-rollback-transform.mjs'
import {configureRollbackCleanup,cleanupAfterRollbackAtSeq} from '../lib/rollback-cleanup.js'
import {applyBackgroundTaskRollbackTransform} from '../deploy/background-rollback-transform.mjs'
import {ensureSessionSystemHead} from '../../../tools/live-plugin-src/lib/domain/session-events.js'
import {captureRollbackBusinessState} from '../lib/rollback-business-state.js'
import {rollbackSchedulingBarrier,rollbackBarrier} from '../lib/rollback-barrier.js'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
import {createRollbackWorldbookBindings} from '../lib/rollback-worldbook-bindings.js'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
import {createRollbackGlobalVariables} from '../lib/rollback-global-variables.js'
import {createRollbackExtensionSettings} from '../lib/rollback-extension-settings.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {installSendAcceptance, activeSendCapture} from '../lib/send-acceptance.js'
import {assertSendAfterCleanup} from '../lib/failure-state.js'
import {TASK_STATE_FIELDS} from '../lib/chat-query-service.js'
configureRollbackCleanup({sessionEvents:s=>s.snapshotEvents()})
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
const helpers={copyJsonTree:value=>value===undefined?undefined:structuredClone(value),applyJsonChangesShared:value=>value}
for(const key of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[key]=value=>value
helpers.diffJson=(old,next)=>{
 const changes=[]
 for(const key of new Set([...Object.keys(old),...Object.keys(next)]))if(key!=='messages'&&JSON.stringify(old[key])!==JSON.stringify(next[key]))changes.push({op:'set',path:[key],value:next[key]})
 if(next.messages.length<old.messages.length)changes.push({op:'splice',path:['messages'],index:next.messages.length,deleteCount:old.messages.length-next.messages.length,items:[]})
 else for(let i=0;i<next.messages.length;i++)if(JSON.stringify(old.messages[i])!==JSON.stringify(next.messages[i]))changes.push({op:'set',path:['messages',i],value:next.messages[i]})
 return changes
}
async function fixture(failed=false,withBook=false,shape=null){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-clean-rollback-'))
 const raw=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 // 与实际host-session-patch相同，只准assistant替换携带引用；不是跳过整套校验。
  const patched=raw.replace('if (event.type === "assistant/message" && raw !== void 0) throw','if (event.type === "assistant/message" && raw !== void 0 && event.surfaceOp?.op !== "replace") throw')
  const file=path.join(root,'session.mjs');writeFileSync(file,patched,'utf8');const {Session,KNOWN_SESSION_EVENT_TYPES}=await import(pathToFileURL(file).href)
  KNOWN_SESSION_EVENT_TYPES.add('dsh-tavern/required-session-patch-v1')
 const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
 const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href),{z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
 const ctx=new Context(),projections=new SessionProjectionRegistry(ctx)
 projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(state,e)=>e.type==='turn/end'?{lastTurn:e.data.turn}:state})
 const session=Session.create('fixture-session'),background=Session.create('fixture-background')
 background.append('session/end-seed',{})
 function turn(s,n,text,reason='completed',reply=true,ended=true,user=true){
  s.append('turn/start',{turn:n});if(user)s.append('user/message',{id:'u'+n,role:'user',content:[{type:'text',text:'输入'+text}],source:{kind:'user'}},{surfaceOp:'append'})
  if(reply)s.append('assistant/message',{turn:n,step:1,message:{id:'a'+n,role:'assistant',content:[{type:'reasoning',text:'原创思考'},{type:'text',text}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
  if(ended)s.append('turn/end',{turn:n,reason:{kind:reason}})
 }
 if(shape?.before52)await shape.before52(session,projections)
 if(!shape?.firstTurn)turn(session,52,'上一轮52')
 const keep=session.seq
 const mainDb=new SqliteSessionDb(path.join(root,'session.db'));mainDb.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
 const workerDb=new SqliteSessionDb(path.join(root,'background.db'));workerDb.materialize(background.header,background.inheritedEventCount,background.snapshotEvents())
 const baseMessages=[{role:'user',text:'上一轮输入'},{role:'assistant',turn:52,text:'上一轮52',swipeId:0,swipes:['上一轮52'],variables:[{hp:52}]}]
 const store=createChatSqliteStore({dataRoot:root,helpers})
 const base={id:'fixture-chat',sessionId:session.id,_storageRevision:1,mode:'story',messages:baseMessages,variables:{hp:52},lastWorldBookRecall:{turn:52},contextCompaction:{warning:'上一轮'},timeline:{schemaVersion:1,branchId:'old',revision:52,checkpoints:[],operations:{},participants:{}}}
 if(withBook)base.openingWorldbookSnapshot={version:1,document:{entries:[{uid:0,content:'原创上轮52世界书'}]},unknown:{keep:true}}
 await store.update(base.id,()=>base)
 if(shape?.legacyFailedTurn)base.timeline.operations['bodyFailed'+shape.legacyFailedTurn]={kind:'body',role:'body',status:'failed',turn:shape.legacyFailedTurn,userText:'历史失败轮',businessBefore:captureRollbackBusinessState(base)}
 const baseline=captureRollbackBusinessState(base)
 // shape 第三参（可空，缺省＝旧行为）：按真实原生 Session 生成 53 的形态（有/无正文、终态 kind、操作状态、变量、是否已 turn/end）。
 const shapeReply=shape?(shape.reply!==false):true
 const shapeEnded=shape?(shape.end!==false):true
 const halfCut=shape?(shape.reply===false):failed
 const turn53Reason=shape?.reason??(failed?'error':'completed')
 const turn53Status=shape?.status??(failed?'failed':'completed')
 const turn53Variables=shape?.variables===false?undefined:[{hp:53}]
 const shapeUser=shape?(shape.user!==false):true
 if(shape?.nativeSend)await shape.nativeSend(session,projections)
 else turn(session,53,'旧53',turn53Reason,shapeReply,shapeEnded,shapeUser)
 mainDb.appendBatch(session.snapshotEvents(keep),keep)
 const bgKeep=background.seq;turn(background,1,'旧53后台');workerDb.appendBatch(background.snapshotEvents(bgKeep),bgKeep)
 const current={...base,_storageRevision:2,messages:shapeUser?(halfCut?[...baseMessages,{role:'user',turn:53,text:'输入旧53半截'}]:[...baseMessages,{role:'user',text:'输入旧53'},{role:'assistant',turn:53,text:'旧53',swipeId:0,swipes:['旧53'],...(turn53Variables?{variables:turn53Variables}:{})}]):[...baseMessages],variables:(shape?.variables===false||!shapeUser)?base.variables:{hp:53},lastWorldBookRecall:{turn:53},contextCompaction:{warning:'旧53'},foregroundError:{message:'旧53'},unknownBusiness:'用户独立编辑保留',timeline:{...base.timeline,revision:53,operations:{...(shape?.legacyFailedTurn?{['bodyFailed'+shape.legacyFailedTurn]:base.timeline.operations['bodyFailed'+shape.legacyFailedTurn]}:{}),body:{kind:'body',turn:53,status:turn53Status,businessBefore:baseline},orphan:{kind:'agent',role:'filter',text:'旧53'}},checkpoints:(failed||shape?.checkpoint===false)?[]:[{id:'cp53',turn:53,businessBefore:baseline}],participants:{settlement:{role:'settlement',sessionId:background.id,lifetime:'chat',boundary:background.seq-1}}}}
 if(withBook)current.openingWorldbookSnapshot={version:1,document:{entries:[{uid:0,content:'原创本轮53世界书'}]}}
 await store.update(base.id,()=>current)
 const agents=new Map([[session.id,{session,phase:{kind:'idle',lastTurn:53},runtimeContext:{retained:{text:'旧53'}},requestHeaderLogged:true}],[background.id,{session:background,phase:{kind:'idle',lastTurn:1},runtimeContext:{retained:{text:'旧53后台'}}}]])
 const handles=new Set([...agents].map(([id,a])=>({id,access:'write',state:{cursor:a.session.seq,primed:{text:'旧53'}},observedLength:a.session.seq})))
 const dbs=new Map([[session.id,mainDb],[background.id,workerDb]])
 let fault=false
 const persistence={bindRollbackArchive:async(id,file)=>dbs.get(id).bindRollbackArchive(file),setRollbackPending:async(id,value)=>dbs.get(id).setRollbackPending(value),drainOpenHandles:async()=>{},truncateEvents:async(header,boundary,identity,retainedEvents)=>{if(fault&&header.id===background.id)throw Error('原创故障点');const db=dbs.get(header.id),meta=db.truncateFrom(boundary,identity,retainedEvents);rewindRollbackHandles(handles,header.id,meta.eventCount);return meta}}
 for(const agent of agents.values())agent.inbox={nextTurn:[],nextStep:[]}
 const syncFrames=[];let rollbackSync
 installRollbackSync({get:()=>({controlState:{ctx:{sessionProjections:projections},jobsFor:()=>[],broadcast:frame=>syncFrames.push(frame)},history:{assistantStreams:new Map()}}),provide:(_key,value)=>{rollbackSync=value}})
 const meter={states:new WeakMap()},services={projections,projectionCache:{write:async()=>{}},tokenMeterProvider:()=>meter,rollbackSyncProvider:()=>rollbackSync}
 const globals=createRollbackGlobalVariables({dataRoot:root,profileData:{readJson:async()=>undefined,remove:async()=>{}}})
 await globals.save({hp:52},undefined)
 await globals.save({hp:53,new:'旧53共享全局'},await globals.read(),{chatId:base.id,turn:53})
 const recalls=createRollbackWorldbookRecallLog({dataRoot:root,store:{readJson:async()=>undefined,remove:async()=>{}}})
 await recalls.record({chat:base,frame:{operationId:'recall52',turn:52,branchId:'old'},log:{outputs:[{text:'上一轮52'}]}})
 await recalls.record({chat:current,frame:{operationId:'recall53',turn:53,branchId:'old'},log:{outputs:[{text:'旧53'}]}})
 const read=()=>store.read(base.id),update=(_id,fn,metadata)=>store.update(base.id,async current=>{const next=await fn(current);next._storageRevision=current._storageRevision+1;return next},metadata)
 const args={chat:await read(),requestedTurn:failed?null:53,availability:()=>({failedTurns:failed?[53]:[],canRollback:!failed}),readChat:read,updateChat:update,chats:{rollbackArchivePath:store.rollbackArchivePath,readRollbackWorldbook:store.readRollbackWorldbook,readSlice:store.readSlice,update},sessions:{get:id=>agents.get(id),getSession:id=>agents.get(id)?.session,flush:async()=>{}},persistence,services,quiesce:async()=>{},sideCleanup:async(chat,turn)=>{await recalls.pruneRollback(chat,turn,chat.timeline.branchId)}, view:async chat=>{assert.equal(rollbackBarrier.has(chat.sessionId),true,'构造返回视图期间仍阻止新写，完整基线发布后才解除');return {turn:chat.messages.at(-1).turn,variables:chat.variables}},readCard:async()=>({})}
 return {root,base,keep,session,background,syncFrames,mainDb,workerDb,store,agents,args,read,update,handles,recalls,globals,setFault:value=>{fault=value},cleanup:async()=>{for(const id of agents.keys())rollbackBarrier.delete(id);await globals.dispose();recalls.dispose();store.dispose();mainDb.close();workerDb.close();await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}}
}
test('PR13真实SQLite：基准后台null采用同Session记录切点删尽尾并同连接同步',async()=>{
 const f=await fixture(true)
 try{
  const id=f.background.id
  await f.update(f.base.id,current=>{
   current.timeline.operations.body.businessBefore.participants={settlement:{role:'settlement',sessionId:id,lifetime:'chat',boundary:null,status:'current'}}
   current.rollbackSessionCuts={'53':{[id]:0}}
   return current
  })
  const result=await cleanRollback({...f.args,chat:await f.read()})
  assert.equal(result.turn,52)
  assert.equal(f.workerDb.cursor(),1,'SQLite只留后台种子，失败产物物理删尽')
  assert.equal(f.background.log.length,1)
  assert.equal(f.mainDb.cursor(),f.keep)
  assert.equal((await f.read()).timeline.operations.body,undefined)
  assert.equal(f.syncFrames.length,1)
 }finally{await f.cleanup()}
})
test('PR13真实SQLite：只有后置后台水位时前后台零删且账本不变',async()=>{
 const f=await fixture(true)
 try{
  await f.update(f.base.id,current=>{
   current.timeline.operations.body.businessBefore.participants={settlement:{role:'settlement',sessionId:f.background.id,lifetime:'chat',boundary:null,status:'current'}}
   return current
  })
  const before=await f.read(),mainCursor=f.mainDb.cursor(),backgroundCursor=f.workerDb.cursor()
  await assert.rejects(cleanRollback({...f.args,chat:before}),/上一轮后台缺少权威seq边界/)
  assert.equal(f.mainDb.cursor(),mainCursor)
  assert.equal(f.workerDb.cursor(),backgroundCursor)
  assert.deepEqual(await f.read(),before)
  assert.equal(f.syncFrames.length,0)
 }finally{await f.cleanup()}
})
for(const failed of [false,true])test((failed?'失败':'正常')+'正文的书历史引用在真实Session纯尾回退恢复52并回收独占版本',async()=>{
 const f=await fixture(failed,true)
 try{
  const before=await f.read(),cp=failed?before.timeline.operations.body:before.timeline.checkpoints[0]
  assert.ok(cp.businessBefore.worldbookRef)
  assert.equal(Object.hasOwn(cp.businessBefore.fields,'openingWorldbookSnapshot'),false)
  const result=await cleanRollback(f.args),after=await f.read()
  assert.equal(result.turn,52);assert.deepEqual(after.openingWorldbookSnapshot,f.base.openingWorldbookSnapshot)
  assert.equal(f.session.seq,f.keep)
  const db=new DatabaseSync(f.store.rollbackArchivePath(f.base.id))
  try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM archive_worldbook_history').get().n,0)}finally{db.close()}
 }finally{await f.cleanup()}
})
for(const failure of ['view','publish'])test('SQL已完成但'+failure+'失败硬报错，不残留永久写屏障或假成功通知',async()=>{
 const f=await fixture()
 try{
  const args={...f.args,...(failure==='view'?{view:async()=>{throw Error('view failed')}}:{services:{...f.args.services,rollbackSyncProvider:()=>({assertReady:()=>{},publish:()=>{throw Error('publish failed')}})}})}
  await assert.rejects(cleanRollback(args),new RegExp(failure+' failed'))
  const latest=await f.read();assert.equal(latest.rollbackPending,undefined);assert.equal(latest.messages.at(-1).turn,52)
  assert.equal(f.syncFrames.length,0);assert.equal(rollbackBarrier.has(f.session.id),false);assert.equal(rollbackBarrier.has(f.background.id),false);assert.equal(rollbackSchedulingBarrier.has(f.session.id),false)
  const completion=latest.rollbackCompletion,revision=latest._storageRevision,main=f.mainDb.cursor(),worker=f.workerDb.cursor()
  assert.ok(completion,'view/publish失败后必须保留已完成目标身份')
  const recovered=await cleanRollback({...f.args,chat:latest,requestedTurn:completion.ordinaryTarget,sideCleanup:async()=>{throw Error('完成重试不得重复副清理')}})
  assert.equal(recovered.rolledBack.sync.id,completion.id);assert.equal(recovered.rolledBack.sync.revision,revision)
  assert.equal(f.syncFrames.length,1,'原失败未发布，补发必须恰一次')
  assert.equal((await f.read())._storageRevision,revision,'完成重试不能再次写SQL')
  assert.equal(f.mainDb.cursor(),main);assert.equal(f.workerDb.cursor(),worker)
 }finally{await f.cleanup()}
})
for(const failed of [false,true,'row-v1'])test((failed==='row-v1'?'更新前row-v1生成，更新后':failed?'失败':'正常')+'53统一删尾，DB正文变量与Agent恢复52，实际turn()重发53',async()=>{
 const f=await fixture(failed===true)
 try{
  if(failed==='row-v1'){
   const original=readFileSync(new URL('../../../tools/live-plugin-src/lib/domain/story-timeline.js',import.meta.url),'utf8'),oldSource=applyRowTimelineTransform(original).replace("'./scoped-messages.js'",JSON.stringify(new URL('../../../tools/live-plugin-src/lib/domain/scoped-messages.js',import.meta.url).href))
   const {createStoryTimeline}=await import('data:text/javascript;base64,'+Buffer.from(oldSource).toString('base64')),timeline=createStoryTimeline()
   const begun=timeline.apply({chat:f.base,intent:{kind:'body.begin',turn:53,userText:'输入旧53'}})
   const committed=timeline.complete({chat:begun.chat,operationId:begun.value.operationId,basedOn:begun.value.basedOn,outcome:{status:'success'}}).chat
   const cp=committed.timeline.checkpoints.at(-1);assert.ok(cp.rowBefore);assert.equal(cp.businessBefore,undefined)
   await f.update(f.base.id,c=>{c.timeline.operations[begun.value.operationId]=committed.timeline.operations[begun.value.operationId];delete c.timeline.operations.body;c.timeline.checkpoints=[cp];c.guides=[{text:'手改保留'}];c.macroState={userName:'手改称呼',local:{step:53}};c.mvu={enabled:true};c.openingWorldbookSnapshot={version:1,document:{entries:[]}};return c},{source:'fixture.old-generation'})
   f.args.chat=await f.read()
  }
  const result=await cleanRollback(f.args);assert.equal(result.turn,52);assert.deepEqual(result.variables,{hp:52})
   assert.equal(f.syncFrames.length,1);assert.equal(f.syncFrames[0].value.revision,(await f.read())._storageRevision)
   assert.deepEqual(f.syncFrames[0].value.sessions.map(row=>row.sessionId).sort(),[f.session.id,f.background.id].sort())
   assert.equal(result.rolledBack.sync.id,f.syncFrames[0].value.id)
   assert.equal(result.rolledBack.sync.sessions,undefined,'RPC只携带去重身份，不二次安装旧全量状态')
  const chat=await f.read();assert.deepEqual(chat.messages,f.base.messages);assert.deepEqual(chat.variables,f.base.variables);if(failed==='row-v1'){assert.equal(chat.lastWorldBookRecall,undefined);assert.equal(chat.contextCompaction,undefined);assert.deepEqual(chat.guides,[{text:'手改保留'}]);assert.equal(chat.macroState.userName,'手改称呼');assert.equal(chat.macroState.local,undefined);assert.deepEqual(chat.mvu,{enabled:true});assert.deepEqual(chat.openingWorldbookSnapshot,{version:1,document:{entries:[]}})}else{assert.deepEqual(chat.lastWorldBookRecall,f.base.lastWorldBookRecall);assert.deepEqual(chat.contextCompaction,f.base.contextCompaction)};assert.equal(chat.foregroundError,undefined);assert.equal(chat.unknownBusiness,'用户独立编辑保留');assert.deepEqual(chat.timeline.operations,{});assert.deepEqual(chat.timeline.participants,{});assert.equal(chat.rollbackPending,undefined)
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events WHERE seq >= ?').get(f.keep).n,0)
  assert.ok(!JSON.stringify(f.mainDb.readAll()).includes('旧53'));assert.ok(!JSON.stringify(f.workerDb.readAll()).includes('旧53'))
  const archive=new DatabaseSync(path.join(f.root,'chats',f.base.id,'archive.db'))
  try{assert.equal(archive.prepare('SELECT count(*) n FROM variable_snapshots WHERE turn >= 53').get().n,0);assert.equal(archive.prepare('SELECT count(*) n FROM archive_messages WHERE message_index >= 2').get().n,0);assert.ok(!JSON.stringify(archive.prepare('SELECT value_json FROM archive_head_fields').all()).includes('旧53'))}finally{archive.close()}
  assert.deepEqual(await f.globals.read(),{hp:53,new:'旧53共享全局'})
  const globalDb=new DatabaseSync(path.join(f.root,'prompt-template-variables.db'));try{assert.equal(globalDb.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='global_undo'").get().n,0)}finally{globalDb.close()}
  const recall=await f.recalls.read(chat);assert.deepEqual(recall.availableTurns,[52]);assert.equal(recall.log.outputs[0].text,'上一轮52')
  const recallDb=new DatabaseSync(path.join(f.root,'worldbook-recalls.db'));try{assert.equal(recallDb.prepare('SELECT COUNT(*) n FROM recalls WHERE turn>=53').get().n,0)}finally{recallDb.close()}
  assert.equal(f.agents.get(f.session.id).phase.lastTurn,52);assert.equal(f.agents.get(f.session.id).runtimeContext.retained,undefined)
  const loop=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-agent-loop.js',import.meta.url),'utf8'),method=loop.slice(loop.indexOf('\tasync turn() {'),loop.indexOf('\tasync step(decision)'))
  const Agent=vm.runInNewContext('class Agent {'+method+'};Agent',{AbortController,Error});const agent=new Agent(),turns=[]
  agent.phase={kind:'running',turn:f.agents.get(f.session.id).phase.lastTurn,step:0,abort:new AbortController()};agent.session={append:(type,data)=>{if(type==='turn/start')turns.push(data.turn)}};agent.preStep=async()=>({kind:'reject'});agent.inbox={hasPending:false};await agent.turn();assert.deepEqual(turns,[53])
 }finally{await f.cleanup()}
})
test('旧轮物理回退后后台turn1固定系统头保留，真实任务入口清首轮后SQL与Agent一致',async()=>{
 const f=await fixture()
 try{
  await cleanRollback(f.args)
  const background=f.background,agent=f.agents.get(background.id),cursor=f.workerDb.cursor()
  ensureSessionSystemHead(background)
  assert.equal(background.log.at(-1).data.turn,1)
  const seedSeq=background.log.at(-1).seq
  background.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'old-queued-work',role:'user',content:[{type:'text',text:'旧任务入队'}],source:{kind:'user'}}]})
  background.append('turn/start',{turn:1})
  background.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
  background.append('assistant/message',{turn:1,step:1,message:{id:'old-worker',role:'assistant',content:[{type:'text',text:'新后台旧任务'}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
  background.append('turn/end',{turn:1,reason:{kind:'completed'}})
  f.workerDb.appendBatch(background.snapshotEvents(cursor),cursor);agent.phase.lastTurn=1
  const original=readFileSync(new URL('../../../tools/live-plugin-src/lib/background-agent-task.js',import.meta.url),'utf8'),source=applyBackgroundTaskRollbackTransform(original)
  const start=source.indexOf('    // [dsh-tavern-background-task-rewind:v1]'),end=source.indexOf('    const progress =',start)
  const consume=vm.runInNewContext('(async function(options,agent,input){const traceSessionId="fixture-background";'+source.slice(start,end)+';return "continued"})')
  let records=0
  const value=await consume({rewindSession:(a,seq)=>cleanupAfterRollbackAtSeq(f.args.persistence,a.session,seq,{...f.args.services,agentProvider:()=>a},{head:f.args.chats}),recordRollbackBoundary:async()=>{records++;assert.equal(background.log.at(-1).seq,seedSeq)}},agent,{rewindTo:-1})
  assert.equal(value,'continued');assert.equal(records,1);assert.equal(agent.phase.lastTurn,0)
  assert.equal(f.workerDb.db.prepare('SELECT count(*) n FROM events WHERE seq>?').get(seedSeq).n,0)
  assert.equal(background.log.some(e=>e.type==='turn/start'),false)
  assert.equal(background.log.at(-1).data.message.id,'tavern-system-head:'+background.id)
  assert.deepEqual((await f.read()).variables,{hp:52})
  assert.equal(f.workerDb.cursor(),background.log.length)
 }finally{await f.cleanup()}
})
for(const kind of ['missing-token','unknown-worker','missing-sync','missing-inbox'])test('删前硬拒：'+kind+'不能假报干净，archive与Session尾部均不变',async()=>{
 const f=await fixture()
 try{
  if(kind==='unknown-worker')await f.update(f.base.id,c=>{c.timeline.operations.independent={id:'independent',kind:'agent',startedSessionId:'untracked-session'};return c},{source:'fixture.prepare'})
  const before=await f.read(),eventCount=f.mainDb.cursor()
  if(kind==='missing-inbox')delete f.agents.get(f.session.id).inbox
  const args={...f.args,chat:before,...(kind==='missing-token'?{services:{...f.args.services,tokenMeterProvider:()=>undefined}}:kind==='missing-sync'?{services:{...f.args.services,rollbackSyncProvider:()=>undefined}}:{})}
  const reasons={'missing-token':/token/,'unknown-worker':/独立任务会话/,'missing-sync':/同连接同步/,'missing-inbox':/inbox/}
  await assert.rejects(cleanRollback(args),reasons[kind])
  const after=await f.read();assert.equal(after._storageRevision,before._storageRevision);assert.equal(after.rollbackPending,undefined);assert.equal(f.mainDb.cursor(),eventCount);assert.deepEqual(after.messages,before.messages)
 }finally{await f.cleanup()}
})
test('资源库五类独立编辑不阻止剧情物理回退，当前值保留而迟到旧任务仍拒',async()=>{
 const f=await fixture(),profileData={readJson:async()=>undefined,remove:async()=>{}},archiveForChat=id=>f.store.rollbackArchivePath(id),options={dataRoot:f.root,profileData,archiveForChat}
 const characters=createRollbackCharacterVariables(options),books=createRollbackWorldbookResources(options),bindings=createRollbackWorldbookBindings(options),settings=createRollbackExtensionSettings(options)
 try{
  f.globals.bindArchiveResolver(archiveForChat)
  const current=await f.read(),old={chatId:current.id,turn:53,branchId:current.timeline.branchId},source={kind:'standalone',path:'worldbooks/fixture.json'}
  await characters.read('cards/fixture.json',{hp:52});await books.read(source,{entries:{0:{content:'52'}}});await bindings.save({'cards/fixture.json':null},{})
  await f.globals.save({hp:53},undefined,old);await characters.save('cards/fixture.json',{hp:53},old);await books.save(source,{entries:{0:{content:'53'}}},await books.read(source),old);await settings.save({EjsTemplate:{n:53}},{},old)
  const manualBook={entries:{0:{content:'用户编辑保留'}}},manualBinding={'cards/fixture.json':'worldbooks/manual.json'}
  await f.globals.save({hp:99},await f.globals.read());await characters.save('cards/fixture.json',{hp:99});await books.save(source,manualBook,await books.read(source));await settings.save({EjsTemplate:{n:99}},await settings.read());await bindings.save(manualBinding,await bindings.read())
  await f.update(f.base.id,c=>({...c,guides:[{id:'manual',text:'新要求'}]}))
  await cleanRollback({...f.args,chat:await f.read()});const latest=await f.read()
  assert.equal(latest.messages.at(-1).turn,52);assert.deepEqual(latest.variables,{hp:52});assert.deepEqual(latest.guides,[{id:'manual',text:'新要求'}]);assert.equal(f.agents.get(f.session.id).phase.lastTurn,52)
  assert.deepEqual(await f.globals.read(),{hp:99});assert.deepEqual(await characters.read('cards/fixture.json'),{hp:99});assert.deepEqual(await books.read(source),manualBook);assert.deepEqual(await settings.read(),{EjsTemplate:{n:99}});assert.deepEqual(await bindings.read(),manualBinding)
  await assert.rejects(f.globals.save({hp:0},undefined,old),/已退役分支/);await assert.rejects(characters.save('cards/fixture.json',{hp:0},old),/已退役分支/);await assert.rejects(books.save(source,{entries:{}},manualBook,old),/已退役分支/)
  assert.equal(f.mainDb.db.prepare('SELECT count(*) n FROM events WHERE seq >= ?').get(f.keep).n,0)
 }finally{for(const store of [characters,books,bindings,settings])await store.dispose();await f.cleanup()}
})
test('后台Session持久archive绑定让前台静止屏障覆盖其turn/start',async()=>{
 const f=await fixture()
 try{
  f.workerDb.bindRollbackArchive(f.store.rollbackArchivePath(f.base.id))
  rollbackSchedulingBarrier.add(f.session.id)
  const seq=f.workerDb.cursor()
  assert.throws(()=>f.workerDb.appendBatch([{type:'turn/start',seq,time:1,data:{turn:2}}],seq),/静止期间禁止/)
  assert.equal(f.workerDb.cursor(),seq)
 }finally{rollbackSchedulingBarrier.delete(f.session.id);await f.cleanup()}
})
test('最早失败53同时纳入后来54独立worker归属，不遗漏无participant会话',async()=>{
 const f=await fixture(true)
 try{
  await f.update(f.base.id,c=>{c.rollbackSessionCuts={'54':{[f.background.id]:0}};c.timeline.participants={};c.timeline.operations.later={kind:'agent',startedSessionId:f.background.id};return c},{source:'fixture.prepare'})
  await cleanRollback({...f.args,chat:await f.read()});assert.ok(!JSON.stringify(f.workerDb.readAll()).includes('旧53'));assert.equal((await f.read()).rollbackSessionCuts,undefined)
 }finally{await f.cleanup()}
})
test('前台冷装载与后台stop分别有界，超时不删且迟到清理最终释放',async()=>{
 for(const stage of ['resume','worker']){
  const f=await fixture();let finish,closed=0;const gate=new Promise(r=>finish=r)
  try{
   const before=await f.read(),count=f.mainDb.cursor(),main=f.agents.get(f.session.id)
   if(stage==='resume'){f.agents.delete(f.session.id);f.args.persistence.loadRollbackSession=async()=>{await gate;return main.session}}
   else {const agent=f.agents.get(f.background.id);agent.phase.kind='running';agent.cancel=()=>{};agent.whenIdle=async()=>{await gate;agent.phase.kind='idle'}}
   await assert.rejects(cleanRollback({...f.args,quiescenceTimeoutMs:5}),/静止等待超时/)
   assert.deepEqual(await f.read(),before);assert.equal(f.mainDb.cursor(),count);assert.equal(rollbackSchedulingBarrier.has(f.session.id),true)
   await assert.rejects(cleanRollback(f.args),/禁止并发/)
   finish();await new Promise(r=>setImmediate(r));assert.equal(rollbackSchedulingBarrier.has(f.session.id),false)
   if(stage==='resume')assert.equal(closed,0,'冷只读构造不持有Agent租约')
  }finally{finish();await new Promise(r=>setImmediate(r));rollbackSchedulingBarrier.delete(f.session.id);await f.cleanup()}
 }
})
test('静止超时不删库，旧run未结算前保持调度屏障并拒绝并发回退',async()=>{
 const f=await fixture();let finish
 const pending=new Promise(resolve=>{finish=resolve})
 try{
  const before=await f.read(),count=f.mainDb.cursor()
  await assert.rejects(cleanRollback({...f.args,quiesce:()=>pending,quiescenceTimeoutMs:5}),/静止等待超时/)
  assert.equal((await f.read())._storageRevision,before._storageRevision);assert.equal(f.mainDb.cursor(),count)
  assert.ok(rollbackSchedulingBarrier.has(f.session.id))
  await assert.rejects(cleanRollback(f.args),/禁止并发回退/)
  finish();await pending;await new Promise(resolve=>setImmediate(resolve))
  assert.ok(!rollbackSchedulingBarrier.has(f.session.id))
  await cleanRollback(f.args);assert.equal((await f.read()).messages.at(-1).turn,52)
 }finally{finish();await pending;await f.cleanup()}
})
test('后台participant替换身份有创建记录时新旧两个Session都清理并恢复旧participant',async()=>{
 const f=await fixture();let oldDb
 try{
  const oldSession=f.background.constructor.create('fixture-old-worker');oldSession.append('session/end-seed',{});const boundary=oldSession.seq-1
  oldDb=new SqliteSessionDb(path.join(f.root,'old-worker.db'));oldDb.materialize(oldSession.header,oldSession.inheritedEventCount,oldSession.snapshotEvents())
  oldSession.append('turn/start',{turn:1});oldSession.append('user/message',{id:'old-user',role:'user',content:[{type:'text',text:'旧53被替换worker'}],source:{kind:'user'}},{surfaceOp:'append'});oldSession.append('turn/end',{turn:1,reason:{kind:'completed'}});oldDb.appendBatch(oldSession.snapshotEvents(boundary+1),boundary+1)
  f.agents.set(oldSession.id,{session:oldSession,phase:{kind:'idle',lastTurn:1},inbox:{nextTurn:[],nextStep:[]}})
  await f.update(f.base.id,c=>{c.rollbackSessionCuts={'53':{[f.background.id]:0}};const prior={role:'settlement',sessionId:oldSession.id,boundary,status:'current'};c.timeline.operations.body.businessBefore.participants={settlement:prior};c.timeline.checkpoints[0].businessBefore.participants={settlement:prior};return c},{source:'fixture.prepare'})
  const persistence={...f.args.persistence,bindRollbackArchive:async(id,file)=>id===oldSession.id?oldDb.bindRollbackArchive(file):f.args.persistence.bindRollbackArchive(id,file),setRollbackPending:async(id,value)=>id===oldSession.id?oldDb.setRollbackPending(value):f.args.persistence.setRollbackPending(id,value),truncateEvents:async(header,seq)=>header.id===oldSession.id?oldDb.truncateFrom(seq):f.args.persistence.truncateEvents(header,seq)}
  await cleanRollback({...f.args,chat:await f.read(),persistence});const done=await f.read()
  assert.equal(done.timeline.participants.settlement.sessionId,oldSession.id);assert.equal(done.timeline.participants.settlement.boundary,boundary)
  assert.equal(oldDb.cursor(),boundary+1);assert.ok(!JSON.stringify(oldDb.readAll()).includes('旧53'));assert.ok(!JSON.stringify(f.workerDb.readAll()).includes('旧53'));assert.equal(done.rollbackSessionCuts,undefined)
 }finally{oldDb?.close();await f.cleanup()}
})
test('独立后台会话有发任务前seq归属时统一物理删净，无需body引用',async()=>{
 const f=await fixture()
 try{
  await f.update(f.base.id,c=>{c.rollbackSessionCuts={'53':{[f.background.id]:0}};c.timeline.participants={};c.timeline.operations.independent={id:'independent',kind:'agent',startedSessionId:f.background.id};return c},{source:'fixture.prepare'})
  await cleanRollback({...f.args,chat:await f.read()})
  const done=await f.read();assert.equal(done.rollbackSessionCuts,undefined);assert.deepEqual(done.timeline.operations,{});assert.ok(!JSON.stringify(f.workerDb.readAll()).includes('旧53'))
 }finally{await f.cleanup()}
})
for(const window of ['prepare-before-native-bit','clear-native-before-complete','after-recall-commit'])test('跨库窗口：'+window+'由archive持久意图拦截重开写入',async()=>{
 const f=await fixture();let once=true
 const args={...f.args,sideCleanup:async(chat,turn)=>{
  await f.recalls.pruneRollback(chat,turn,chat.timeline.branchId)
  if(window==='after-recall-commit'&&once){once=false;throw Error('原创提交窗口故障')}
 },persistence:{...f.args.persistence,setRollbackPending:async(id,pending)=>{
  if(window==='prepare-before-native-bit'&&once){once=false;throw Error('原创提交窗口故障')}
  await f.args.persistence.setRollbackPending(id,pending)
 }},updateChat:async(id,fn,metadata)=>{
  if(window==='clear-native-before-complete'&&metadata.source==='rollback.complete'&&once){once=false;throw Error('原创提交窗口故障')}
  return f.args.updateChat(id,fn,metadata)
 }}
 try{
  await assert.rejects(cleanRollback(args),/提交窗口故障/)
   assert.equal(f.syncFrames.length,0,'清理或最终提交失败不能通知客户端成功')
  const partial=await f.read();assert.ok(partial.rollbackPending)
  rollbackBarrier.clear();rollbackSchedulingBarrier.clear()
  const reopened=new SqliteSessionDb(f.mainDb.path)
  try{const cursor=reopened.cursor();assert.throws(()=>reopened.appendBatch([{type:'turn/start',seq:cursor,time:Date.now(),data:{turn:53}}],cursor),/archive禁止Session/)}finally{reopened.close()}
  await cleanRollback({...f.args,chat:partial});assert.equal((await f.read()).rollbackPending,undefined)
 }finally{await f.cleanup()}
})
test('跨库故障保留无业务负载的完成意图并拒绝新写，重试立即收敛',async()=>{
 const f=await fixture(false,true)
 try{
  f.setFault(true);await assert.rejects(cleanRollback(f.args),/原创故障点/)
  const partial=await f.read();assert.ok(partial.rollbackPending);assert.ok(!JSON.stringify(partial.rollbackPending).includes('旧53'))
  assert.deepEqual(partial.openingWorldbookSnapshot,f.base.openingWorldbookSnapshot,'准备已精确恢复书，重试不依赖已回收引用')
  await assert.rejects(f.update(f.base.id,c=>c,{source:'foreground.prepare'}),/回退未完成/)
  rollbackBarrier.clear() // 模拟进程屏障消失，SQLite meta仍必须挡住新写。
  assert.throws(()=>f.mainDb.appendBatch([{type:'turn/start',seq:f.keep,time:Date.now(),data:{turn:53}}],f.keep),/回退未完成/)
  f.setFault(false);await cleanRollback({...f.args,chat:partial});const done=await f.read();assert.equal(done.rollbackPending,undefined);assert.equal(f.mainDb.readMeta().eventCount,f.keep);assert.ok(!JSON.stringify(f.workerDb.readAll()).includes('旧53'));assert.equal(f.agents.get(f.session.id).phase.lastTurn,52)
 }finally{await f.cleanup()}
})
// 普通回退完成记录（R2）：完成时持久 rollbackCompletion，同目标 retry 只重新发布完成帧。
function archiveRows(root,chatId,table,since=0){
 const db=new DatabaseSync(path.join(root,'chats',chatId,'archive.db'))
 try{return db.prepare('SELECT count(*) n FROM '+table+' WHERE message_index >= ?').get(since).n}finally{db.close()}
}
function once(input,message){let fired=false;return async(...args)=>{if(!fired){fired=true;throw Error(message)}return input(...args)}}
test('普通回退完成记录：rollbackCompletion落version/id/turn/cuts/revision/branchId/ordinaryTarget，完成帧同id同rev',async()=>{
 const f=await fixture()
 try{
  const result=await cleanRollback(f.args),after=await f.read()
  assert.equal(result.turn,52,'普通目标仍回退到52')
  const completion=after.rollbackCompletion
  assert.ok(completion,'完成记录必须持久在chat上')
  assert.equal(completion.version,1)
  assert.ok(typeof completion.id==='string' && completion.id!=='')
  assert.equal(completion.turn,53)
  assert.deepEqual(completion.cuts.map(cut=>cut.sessionId).sort(),[f.session.id,f.background.id].sort())
  assert.equal(completion.revision,after._storageRevision,'revision必须是完成时的SQL版本')
  assert.equal(completion.branchId,after.timeline.branchId)
  assert.ok(completion.ordinaryTarget && typeof completion.ordinaryTarget==='object','普通回退必须留发起凭据')
  assert.equal(completion.failureTarget,undefined,'普通回退无失败目标')
  assert.equal(after.rollbackPending,undefined,'完成记录与半提交意图互斥')
  assert.equal(f.syncFrames.length,1)
  assert.equal(result.rolledBack.sync.id,completion.id,'完成帧id必须等于完成记录id')
  assert.equal(result.rolledBack.sync.revision,completion.revision)
  assert.equal(f.syncFrames[0].value.id,completion.id)
  assert.equal(f.syncFrames[0].value.revision,completion.revision)
  assert.deepEqual(f.syncFrames[0].value.sessions.map(row=>row.sessionId).sort(),[f.session.id,f.background.id].sort())
 }finally{await f.cleanup()}
})
test('同目标retry：原凭据重发完成帧同id同rev，零truncate/零sideCleanup/零SQL写',async()=>{
 const f=await fixture()
 try{
  const first=await cleanRollback(f.args),after=await f.read()
  const completion=after.rollbackCompletion,creditTarget=completion.ordinaryTarget
  assert.ok(creditTarget,'完成记录必须留原普通目标')
  assert.equal(first.turn,52)
  let sideCleanups=0
  const framesBefore=f.syncFrames.length,revisionBefore=after._storageRevision,cursorBefore=f.mainDb.cursor(),workerBefore=f.workerDb.cursor(),archiveBefore=archiveRows(f.root,f.base.id,'archive_messages',2),metaBefore=f.mainDb.readMeta().eventCount
  const retried=await cleanRollback({...f.args,chat:await f.read(),requestedTurn:creditTarget,sideCleanup:async(chat,turn)=>{sideCleanups+=1;await f.recalls.pruneRollback(chat,turn,chat.timeline.branchId)}})
  const second=await f.read()
  assert.equal(sideCleanups,0,'retry不得再跑sideCleanup')
  assert.equal(f.syncFrames.length,framesBefore+1,'retry必须重新publish一次完成帧')
  assert.equal(f.syncFrames.at(-1).value.id,completion.id,'retry帧必须是同一完成id')
  assert.equal(f.syncFrames.at(-1).value.revision,completion.revision)
  assert.equal(retried.rolledBack.sync.id,completion.id)
  assert.equal(retried.rolledBack.sync.revision,completion.revision)
  assert.equal(second._storageRevision,revisionBefore,'retry不得写SQL')
  assert.equal(f.mainDb.cursor(),cursorBefore,'retry不得truncate原生事件')
  assert.equal(f.mainDb.readMeta().eventCount,metaBefore)
  assert.equal(f.workerDb.cursor(),workerBefore)
  assert.equal(archiveRows(f.root,f.base.id,'archive_messages',2),archiveBefore,'retry不得再删archive正文')
  assert.deepEqual(second.messages,after.messages)
  assert.equal(second.rollbackCompletion.id,completion.id,'完成记录必须保留供再次retry')
 }finally{await f.cleanup()}
})
test('兼容数字retry：旧普通回退以turn 53重发同样幂等，零删零写',async()=>{
 const f=await fixture()
 try{
  await cleanRollback(f.args)
  const after=await f.read(),completion=after.rollbackCompletion
  const framesBefore=f.syncFrames.length,cursorBefore=f.mainDb.cursor(),revisionBefore=after._storageRevision
  const retried=await cleanRollback({...f.args,chat:await f.read(),requestedTurn:53})
  assert.equal(f.syncFrames.length,framesBefore+1)
  assert.equal(f.syncFrames.at(-1).value.id,completion.id,'数字目标必须收敛到同一完成记录')
  assert.equal(retried.rolledBack.sync.id,completion.id)
  assert.equal((await f.read())._storageRevision,revisionBefore)
  assert.equal(f.mainDb.cursor(),cursorBefore)
 }finally{await f.cleanup()}
})
test('readCard分支：完成期间readCard抛错则响亮失败且释放屏障，同目标retry收敛同id',async()=>{
 const f=await fixture()
 try{
  await assert.rejects(cleanRollback({...f.args,readCard:once(async()=>({}),'readCard故障点')}),/readCard故障点/)
  assert.equal(rollbackSchedulingBarrier.has(f.session.id),false,'readCard失败不得永久占屏障')
  const pending=await f.read()
  assert.ok(pending.rollbackCompletion,'readCard失败后完成记录必须保留供同目标retry')
  assert.equal(pending.rollbackCompletion.revision,pending._storageRevision)
  assert.equal(f.mainDb.cursor(),f.keep,'SQL已提交的完成不得回滚原生事件')
  let sawCard
  const retried=await cleanRollback({...f.args,chat:await f.read(),requestedTurn:pending.rollbackCompletion.ordinaryTarget,readCard:async()=>{sawCard={title:'卡片'};return sawCard}})
  assert.equal(sawCard.title,'卡片','成功retry必须用当前readCard构造视图')
  assert.equal(retried.rolledBack.sync.id,pending.rollbackCompletion.id,'retry必须publish同id')
  const done=await f.read()
  assert.equal(done.rollbackCompletion.id,pending.rollbackCompletion.id)
  assert.equal(done._storageRevision,pending._storageRevision,'retry不得写SQL')
 }finally{await f.cleanup()}
})
test('普通目标身份安全：错branch/错rev/异档/写后过期全拒且零删零写',async()=>{
 const f=await fixture()
 try{
  await cleanRollback(f.args)
  const after=await f.read(),completion=after.rollbackCompletion,credit=completion.ordinaryTarget
  const revision=after._storageRevision,cursor=f.mainDb.cursor(),workerCursor=f.workerDb.cursor(),archiveCount=archiveRows(f.root,f.base.id,'archive_messages',2)
  const assertIntact=async()=>{const now=await f.read();assert.equal(now._storageRevision,revision,'拒绝路径不得写业务');assert.equal(f.mainDb.cursor(),cursor);assert.equal(f.workerDb.cursor(),workerCursor);assert.equal(archiveRows(f.root,f.base.id,'archive_messages',2),archiveCount)}
  await assert.rejects(cleanRollback({...f.args,chat:await f.read(),requestedTurn:{...credit,chatId:'other-chat'}}),/不一致/)
  await assertIntact()
  await assert.rejects(cleanRollback({...f.args,chat:await f.read(),requestedTurn:{...credit,sessionId:'other-session'}}),/不一致/)
  await assertIntact()
  await assert.rejects(cleanRollback({...f.args,chat:await f.read(),requestedTurn:{...credit,branchId:'other-branch'}}),/版本已过期|分支|revision|不一致/)
  await assertIntact()
  await assert.rejects(cleanRollback({...f.args,chat:await f.read(),requestedTurn:{...credit,revision:revision+1}}),/revision|版本|不一致/)
  await assertIntact()
  // 更晚的新普通目标（真实 Session/DB 写入：物理删过的轮号可被新输入复用）允许发起新回退；此后旧目标必须在任何新revision后拒。
  const bgKeep=f.background.seq
  f.background.append('turn/start',{turn:2});f.background.append('user/message',{id:'u2',role:'user',content:[{type:'text',text:'后台2'}],source:{kind:'user'}},{surfaceOp:'append'});f.background.append('turn/end',{turn:2,reason:{kind:'completed'}})
  f.workerDb.appendBatch(f.background.snapshotEvents(bgKeep),bgKeep)
  const sessKeep=f.session.seq
  f.session.append('turn/start',{turn:53});f.session.append('user/message',{id:'u53b',role:'user',content:[{type:'text',text:'输入53新一轮'}],source:{kind:'user'}},{surfaceOp:'append'});f.session.append('assistant/message',{turn:53,step:1,message:{id:'a53b',role:'assistant',content:[{type:'text',text:'新53'}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'});f.session.append('turn/end',{turn:53,reason:{kind:'completed'}})
  f.mainDb.appendBatch(f.session.snapshotEvents(sessKeep),sessKeep)
  const after2=await f.read(),baseline2=captureRollbackBusinessState(after2)
  await f.update(f.base.id,chat=>{chat.messages=[...chat.messages,{role:'user',turn:53,text:'输入53新一轮'},{role:'assistant',turn:53,text:'新53',swipeId:0,swipes:['新53']}];chat.variables={hp:53};chat.timeline={...chat.timeline,revision:53,operations:{body:{kind:'body',turn:53,status:'completed',businessBefore:baseline2}},checkpoints:[{id:'cp53b',turn:53,businessBefore:baseline2}],participants:{settlement:{role:'settlement',sessionId:f.background.id,lifetime:'chat',boundary:f.background.seq-1}}};return chat},{source:'fixture.turn53-new'})
  const newer=await f.read()
  const newTarget={kind:'rollback',turn:53,branchId:newer.timeline.branchId,revision:newer._storageRevision,chatId:newer.id,sessionId:newer.sessionId}
  const second=await cleanRollback({...f.args,chat:newer,requestedTurn:newTarget,availability:()=>({failedTurns:[],canRollback:true})})
  const done=await f.read()
  assert.equal(second.turn,52,'新普通目标必须允许发起新的完成（本轮=53，回退到52之前）')
  assert.notEqual(done.rollbackCompletion.id,completion.id)
  const staleRevision=done._storageRevision,staleCursor=f.mainDb.cursor(),staleArchive=archiveRows(f.root,f.base.id,'archive_messages',2)
  await assert.rejects(cleanRollback({...f.args,chat:done,requestedTurn:credit}),/revision|版本|过期|不一致/)
  const final=await f.read()
  assert.equal(final._storageRevision,staleRevision,'过期目标不得写业务')
  assert.equal(f.mainDb.cursor(),staleCursor)
  assert.equal(archiveRows(f.root,f.base.id,'archive_messages',2),staleArchive)
 }finally{await f.cleanup()}
})

test('不完整撤销：目标漂移零取消，运行器必须真实停止后才删库',async()=>{
 const f=await fixture(false)
 try {
   await f.update(f.base.id,current=>({...f.base,_storageRevision:current._storageRevision+1,timeline:{...f.base.timeline,participants:{background:{sessionId:f.background.id,turn:52}},operations:{body52:{kind:'body',turn:52,status:'completed',background:{phase:'completed'}}},checkpoints:[{turn:52}]}}))
   const chat=await f.read(),target=inspectNativeFailureTail(chat,{session:f.session,events:f.session.snapshotEvents(),cleanupIdle:true}).target
   assert.ok(target?.incomplete)
   let quiesced=0,stopped=0
   const foreground=f.agents.get(f.session.id);foreground.cancel=()=>{stopped++};foreground.whenIdle=async()=>{}
   const services={...f.args.services,isFailureCleanupIdle:()=>true},events=f.session.snapshotEvents()
   const invoke=(failureTarget=target,overrides={})=>cleanRollback({...f.args,chat,requestedTurn:failureTarget,services,quiesce:async()=>{quiesced++},...overrides})
   for(const change of [{branchId:'other'},{revision:target.revision+1},{endSeq:target.endSeq+1,eventCount:target.eventCount+1},{incomplete:undefined}])await assert.rejects(invoke({...target,...change}),/变化|漂移|不合法|坐标/)
   assert.equal(quiesced,0);assert.equal(stopped,0,'漂移凭据不得先取消当前任务')
   // cancel/whenIdle 不能假成功：仍running时必须拒绝，且两库均不删。
   foreground.phase.kind='running';await assert.rejects(invoke(),/Agent尚未静止/)
   assert.equal(stopped,1);assert.equal(quiesced,0)
   assert.deepEqual(await f.read(),chat);assert.deepEqual(f.session.snapshotEvents(),events);assert.equal(f.syncFrames.length,0)
   // 用户选择活动轮撤销；真实cancel使运行器静止，旧资格idle旁证不再决定可否执行。
   foreground.cancel=()=>{stopped++;foreground.phase.kind='idle'}
   const result=await invoke(target,{services:{...services,isFailureCleanupIdle:()=>false}})
   assert.equal(result.turn,52);assert.equal(stopped,2);assert.equal(quiesced,1)
   assert.equal(f.session.snapshotEvents().some(e=>e.type==='turn/start'&&e.data.turn===53),false)
   assert.equal((await f.read()).rollbackPending,undefined);assert.equal(f.syncFrames.length,1)
 }finally{await f.cleanup()}
})
test('不完整清理A：native53完成但业务未登记时按纯尾前缀签incomplete且业务保持52',async()=>{
 const f=await fixture(false)
 try{
  // 退回"上一轮52完成"：无 body53/无 message53/无 checkpoint53，保留 52 的业务基准与检查点
  await f.update(f.base.id,current=>{const baseline=current.timeline.operations.body.businessBefore
   return {...f.base,_storageRevision:current._storageRevision+1,messages:[...f.base.messages],variables:{hp:52},
    timeline:{...f.base.timeline,revision:52,operations:{body52:{kind:'body',turn:52,status:'completed',background:{phase:'completed'},businessBefore:baseline}},checkpoints:[{id:'cp52',turn:52,businessBefore:baseline}]}}})
  const services={...f.args.services,isFailureCleanupIdle:()=>true}
  const editId='tavern-body-edit:synthetic'
   await f.update(f.base.id,current=>{current.messages[1]={...current.messages[1],text:'上轮独立编辑',bodyEdit:{id:editId,turn:52,seq:2}};return current})
   const editStart=f.session.seq
   f.session.append('dsh-tavern/required-session-patch-v1',{version:1})
   f.session.append('assistant/message',{turn:52,step:1,message:{id:editId,role:'assistant',content:[{type:'text',text:'上轮独立编辑'}],source:{kind:'model',provider:'dsh-tavern',model:'body-edit'}}},{surfaceOp:{op:'replace',startSeq:2,endSeq:2},sourceEventSeqs:[2]})
   f.mainDb.appendBatch(f.session.snapshotEvents(editStart),editStart)
   const retained=f.session.snapshotEvents().slice(editStart).map((e,i)=>({...e,seq:f.keep+i}))
   services.preserveRetainedBodyEdits=true
   const chat=await f.read(),failureTarget=inspectNativeFailureTail(chat,{session:f.session,events:f.session.snapshotEvents(),cleanupIdle:true}).target
   assert.ok(failureTarget?.incomplete)
   const prefix=f.session.snapshotEvents().slice(0,f.keep),backgroundBefore=f.background.snapshotEvents()
   const result=await cleanRollback({...f.args,chat,services,requestedTurn:failureTarget})
  const after=await f.read()
  assert.equal(result.turn,52,'A：清理到上一正确轮 52')
  assert.equal(f.mainDb.cursor(),f.keep+2,'A：native53物理删除，前缀和独立编辑保留')
  assert.deepEqual(f.background.snapshotEvents(),backgroundBefore,'A：独立后台原样保留')
   assert.deepEqual(f.session.snapshotEvents(),[...prefix,...retained],'A：原生前缀逐事件保持且旧编辑精确保留')
    assert.equal(after.messages[1].text,'上轮独立编辑')
    assert.equal(f.session.surface.nodes.includes(f.keep+1),true,'编辑替换保持模型面')
    assert.equal(f.session.surface.nodes.includes(2),false)
   assert.equal(f.agents.get(f.session.id).phase.lastTurn,52)
   assert.equal([...f.handles].find(handle=>handle.id===f.session.id).state.cursor,f.keep+2)
   assert.ok(f.syncFrames.length>0)
  assert.deepEqual({...after.variables},{hp:52},'A：变量仍是 52（未登记轮不产生新变量）')
  assert.equal(after.messages.length,2,'A：消息前缀仍为 2 行')
  assert.equal(after.timeline.operations.body52.kind,'body','A：52 的业务操作保留')
  assert.equal(after.timeline.operations.body,undefined,'A：未登记的 53 不得留下业务残留')
 }finally{await f.cleanup()}
})

test('不完整清理B：正常body53后台failed时按ordinary回退恢复52并清后台种子',async()=>{
 const f=await fixture(false)
 try{
  const bgId=f.background.id
  // 正常完成轮：不改 body.status（不迎合）、不签 incomplete；只让 body 的后台相位停在 failed
  await f.update(f.base.id,current=>{current.timeline.operations.body.background={phase:'failed'}
   current.timeline.operations.body.committedBranchId=current.timeline.branchId
   // 后台错误取真实 body.background，不另造 chat 后台状态。
   current.rollbackSessionCuts={'53':{[bgId]:0}}
   return current})
  const services={...f.args.services,isFailureCleanupIdle:()=>true}
  const chat=await f.read()
  const prefix=f.session.snapshotEvents().slice(0,f.keep),backgroundBefore=f.background.snapshotEvents()
  const result=await cleanRollback({...f.args,chat,services,requestedTurn:53})
  const after=await f.read()
  assert.equal(result.turn,52,'B：ordinary 回退到上一轮 52')
  assert.equal(f.workerDb.cursor(),1,'B：后台失败尾物理删尽，只留种子')
  assert.equal(after.timeline.operations.body,undefined,'B：body53 撤净')
  assert.deepEqual({...after.variables},{hp:52},'B：按 businessBefore 恢复变量 52')
  assert.equal(after.messages.length,2,'B：消息恢复到前缀 2 行')
  assert.equal(f.syncFrames.length>=1,true,'B：同连接同步帧已广播')
  assert.deepEqual(f.session.snapshotEvents(),prefix,'B：原生前缀逐事件保持')
 }finally{await f.cleanup()}
})

test('普通回退：同轮陈旧完成凭据不锁死，同轮陈旧凭据幂等补发同 id',async()=>{
 const f=await fixture()
 try{
  const firstChat=await f.read()
  // 结构化 ordinaryTarget：revision 取首次调用时的当前值；第二次仍用这枚旧 target 重发。
  const target={kind:'rollback',turn:53,revision:firstChat._storageRevision,chatId:firstChat.id,sessionId:firstChat.sessionId,branchId:firstChat.timeline.branchId}
  const first=await cleanRollback({...f.args,chat:firstChat,requestedTurn:target})
  assert.equal(first.rolledBack.hiddenTurn,53)
  const c1=(await f.read()).rollbackCompletion
  assert.ok(c1&&c1.id,'首次普通回退必须留下完成凭据')
  assert.equal((await f.read()).messages.some(row=>Number(row.turn)>=53),false,'首次回退后不得残留该轮正文')
  const framesAfterFirst=f.syncFrames.length
  // 推进一个非剧情 Chat revision（同 branch、同 turn 不变）：旧逻辑会因 revision 落后永久拒绝同轮重发。
  await f.update(f.base.id,current=>{current.guides=[{text:'非剧情编辑后的配置'}];return current},{source:'configuration.edit'})
  const edited=await f.read()
  assert.equal(edited.timeline.branchId,c1.branchId,'分支必须不变')
  assert.notEqual(edited._storageRevision,c1.revision,'revision 必须已推进')
  const sqlBefore=f.mainDb.stmts.selectEvents.all().length
  const second=await cleanRollback({...f.args,chat:edited,requestedTurn:target})
  assert.equal(second.rolledBack.hiddenTurn,53,'同轮重发必须成功而不是拒绝')
  const c2=(await f.read()).rollbackCompletion
  assert.ok(c2&&c2.id,'重发后仍需留下完成凭据')
  assert.equal(c2.id,c1.id,'陈旧且已删净时必须复用原 completion id（幂等补发）')
  assert.equal(f.mainDb.stmts.selectEvents.all().length,sqlBefore,'幂等补发不得删除或写入任何 SQL 行')
  assert.equal((await f.read()).messages.some(row=>Number(row.turn)>=53),false,'重发后仍不得残留该轮正文')
  assert.ok(f.syncFrames.length>framesAfterFirst,'重发必须再次广播')
 }finally{ if(f.cleanup) await f.cleanup() }
})
test('账本前像集成：物理回退可重建已回收的上轮body节点',async()=>{
 const f=await fixture()
 try{
  // 真消费者：cleanRollback 经 args.chats 取前像历史（公导出），不是只测 core。
  f.args.chats.readRollbackOperationSnapshot=f.store.readRollbackOperationSnapshot
  // 1) base52 业务基准：hp51 + 确切 messageCount（= base.messages.length-2，即52之前）
  const captured=captureRollbackBusinessState(f.base)
  const fields52={...captured.fields,variables:{hp:51}}
  const messageCount52=f.base.messages.length-2
  const body52={kind:'body',turn:52,businessBefore:{version:1,fields:fields52,messageCount:messageCount52,participants:{},operationIds:[],states:{}}}
  await f.update(f.base.id,c=>{
   c.timeline.operations.body52=structuredClone(body52)
   return c
  })
  f.args.chat=await f.read()   // 准备态改动后必须清 stale
  // 2) 53 的 before 必须取自 base52 状态（不含 53 正文）：历史 body52 落在 53before 内，当前主状态保持 53，
  //    否则 messageCount 会把 53 正文算进去，清理后仍停 53。
  const base52={...f.base,timeline:{...f.base.timeline,operations:{body52:structuredClone(body52)},checkpoints:[],participants:{}}}
  const recaptured=captureRollbackBusinessState(base52)
  await f.update(f.base.id,c=>{
   c.timeline.operations.body.businessBefore=structuredClone(recaptured)
   const cp=[...c.timeline.checkpoints].reverse().find(item=>item.businessBefore!==undefined)
   if(cp)cp.businessBefore=structuredClone(recaptured)
   return c
  })
  f.args.chat=await f.read()
  // 3) 回收 52 的 body 节点与其 checkpoint（52 前像只剩历史引用）
  await f.update(f.base.id,c=>{
   delete c.timeline.operations.body52
   c.timeline.checkpoints=c.timeline.checkpoints.filter(item=>Number(item.turn)!==52)
   return c
  })
  f.args.chat=await f.read()
  assert.equal(f.args.chat.timeline.operations.body52,undefined,'52 body 必须已从当前档回收')
  // 4) 真入口物理回退：必须经 chats resolver 从历史重建 52 body（含其 hp51 前像）
  const result=await cleanRollback(f.args)
  const after=await f.read()
  assert.equal(result.turn,52)
  assert.deepEqual(after.variables,{hp:52},'变量必须回到 52 的值')
  assert.equal(after.messages.at(-1).turn,52,'正文必须回到 52')
  const rebuilt=after.timeline.operations.body52
  assert.ok(rebuilt,'历史 resolver 必须重建已回收的 52 body 节点')
  assert.equal(rebuilt.businessBefore.fields.variables.hp,51,'重建前像必须来自历史（hp51）')
  assert.equal(rebuilt.businessBefore.messageCount,messageCount52,'重建前像 messageCount 必须与历史一致')
  assert.equal(f.mainDb.cursor(),f.keep,'原生 session 必须回到 keep')
  assert.equal(after.rollbackPending,undefined,'回退后不得残留 rollbackPending')
 }finally{await f.cleanup()}
})
test('发送先清理闭环：拒绝新轮零写，物理清理后接受新轮自身基准并可再次撤销',async()=>{
 const f=await fixture(true),capture=activeSendCapture(f.root)
 const uninstall=installSendAcceptance(f.session.constructor,(session,type,data)=>capture(f.base.id,{sessionId:session.id,type,data,turn:type==='turn/start'?data.turn:session.snapshotEvents().findLast(e=>e.type==='turn/start')?.data?.turn,seq:session.seq,events:session.snapshotEvents()}))
 try{
  const {latestSendTarget}=await import('../lib/clean-rollback.js')
  const before=await f.read(),seq=f.session.seq
  assert.throws(()=>f.session.append('turn/start',{turn:54}),/先回退或清理/)
  assert.equal(f.session.seq,seq,'拒绝发生在native append之前')
  assert.deepEqual(await f.read(),before,'拒绝零Chat写，不登记新轮，不遮挡旧轮目标')
  const target=latestSendTarget(before,{events:f.session.snapshotEvents()})
  assert.equal(target.turn,53)
  await cleanRollback({...f.args,chat:before,requestedTurn:target})
  const cleaned=await f.read()
  assert.deepEqual(cleaned.variables,{hp:52})
  f.session.append('turn/start',{turn:54})
  f.session.append('user/message',{id:'next54',role:'user',content:[{type:'text',text:'新54'}],source:{kind:'user'}},{surfaceOp:'append'})
  const accepted=await f.read(),op=Object.values(accepted.timeline.operations).find(op=>op.turn===54)
  assert.deepEqual(op.businessBefore.fields.variables,cleaned.variables,'新轮记录清理后的自身前像')
  assert.equal(op.businessBefore.messageCount,cleaned.messages.length)
  assert.doesNotThrow(()=>assertSendAfterCleanup(accepted,{events:f.session.snapshotEvents()}),'请求准备不得把本轮running占位当作上一错误轮')
  f.mainDb.appendBatch(f.session.snapshotEvents(f.keep),f.keep)
  const nextTarget=latestSendTarget(accepted,{events:f.session.snapshotEvents()})
  assert.equal(nextTarget.turn,54)
  await cleanRollback({...f.args,chat:accepted,requestedTurn:nextTarget})
  assert.deepEqual((await f.read()).variables,cleaned.variables)
  assert.equal(f.session.seq,f.keep,'新轮无正文也能再次物理清理')
 }finally{uninstall();await f.cleanup()}
})

test('最新发送统一撤销：状态和终态不作资格，只有输入与部分产物均恢复发轮前像',async()=>{
 const {latestSendTarget}=await import('../lib/clean-rollback.js')
 const cases=[['completed','completed'],['failed','error'],['weird','未知终态']].flatMap(([status,reason])=>[
  {name:reason+'+无正文',shape:{status,reason,reply:false,variables:false}},
  {name:reason+'+部分输出',shape:{status,reason,reply:true,variables:false}},
  {name:reason+'+正文与变量',shape:{status,reason,reply:true,variables:true}},
 ])
 cases.push({name:'running+无end',shape:{status:'running',reason:'interrupted',reply:false,variables:false,ended:false}})
 for(const item of cases){
  const f=await fixture(false,false,item.shape)
  try{
   const before=await f.read()
   // 旧判断明确不认可该轮（canRollback:false + 无失败列表）——统一撤销仍必须通过。
   const signed=latestSendTarget(before,{events:f.session.snapshotEvents()},before._storageRevision)
   assert.equal(signed?.kind,'rollback',item.name+'：必须签出统一目标')
   assert.equal(signed.turn,53,item.name+'：统一目标必须是最新发送轮')
   let cancels=0
   const agent=f.agents.get(f.session.id)
   agent.phase={kind:'running',lastTurn:53}
   agent.cancel=()=>{cancels+=1;agent.phase={kind:'idle',lastTurn:53}}
   agent.whenIdle=async()=>{}
   const result=await cleanRollback({...f.args,chat:before,requestedTurn:signed,availability:()=>({failedTurns:[],canRollback:false,reason:'旧判断不认可该轮'})})
   const after=await f.read()
   assert.equal(result.turn,52,item.name+'：返回视图轮号必须是恢复后的 52')
   assert.deepEqual(result.variables,{hp:52},item.name+'：视图变量必须回到发轮前像')
   // 库行数/游标/原生残留
   assert.equal(f.mainDb.readMeta().eventCount,f.keep,item.name+'：原生库行数必须回到 keep')
   assert.equal(f.mainDb.cursor(),f.keep,item.name+'：原生游标必须回到 keep')
   assert.ok(!JSON.stringify(f.mainDb.readAll()).includes('旧53'),item.name+'：SQL 不得残留 53 产物')
   assert.ok(!f.session.snapshotEvents().some(e=>Number(e.data?.turn)===53),item.name+'：内存 log（投影源）不得残留 53')
   // 变量/正文/operation/checkpoint/pending
   assert.deepEqual(after.variables,{hp:52},item.name+'：变量必须回到 52')
   assert.equal(after.messages.at(-1).turn,52,item.name+'：正文必须回到 52')
   assert.equal(after.messages.some(row=>Number(row.turn)===53),false,item.name+'：不得残留 53 正文行')
   assert.equal(after.timeline.operations.body,undefined,item.name+'：53 body 操作必须删除')
   assert.deepEqual((after.timeline.checkpoints||[]).filter(cp=>Number(cp.turn)===53),[],item.name+'：53 checkpoint 必须删除')
   assert.equal(after.rollbackPending,undefined,item.name+'：不得残留 rollbackPending')
   // phase/句柄/同步
   assert.equal(f.agents.get(f.session.id).phase.kind,'idle',item.name+'：phase 必须静止')
   assert.equal(f.agents.get(f.session.id).phase.lastTurn,52,item.name+'：phase.lastTurn 必须回 52')
   assert.equal([...f.handles].find(h=>h.id===f.session.id).state.cursor,f.keep,item.name+'：前台句柄游标必须回到 keep')
   assert.ok(f.syncFrames.length>=1,item.name+'：必须发布同连接同步帧')
   assert.ok(after.rollbackCompletion,item.name+'：必须落完成记录')
   assert.ok(f.syncFrames.some(frame=>JSON.stringify(frame).includes(after.rollbackCompletion.id)),item.name+'：完成帧必须同 id 发布')
   assert.equal(cancels,item.shape.reply===false?1:1,item.name+'：在途代理必须被取消一次')
  }finally{await f.cleanup()}
 }
})
test('统一撤销先取消在途发送且拒陈旧凭据',async()=>{
 const {latestSendTarget}=await import('../lib/clean-rollback.js')
 // 通过案例：53 尚未 turn/end（真在途）；cancel 内合理补原生 turn/end 并落库，whenIdle 内写迟到 stop（身份相同、revision 变化）。
 const f=await fixture(false,false,{status:'running',reason:'interrupted',reply:false,variables:true,end:false})
 try{
  const before=await f.read()
  const signed=latestSendTarget(before,{events:f.session.snapshotEvents()},before._storageRevision)
  assert.equal(signed?.kind,'rollback')
  let cancels=0,idleWaits=0,lateWrites=0
  const agent=f.agents.get(f.session.id)
  agent.phase={kind:'running',lastTurn:53}
  agent.cancel=({kind})=>{
   cancels+=1;assert.equal(kind,'parent','必须按 parent 身份取消')
   // cancel 内合理完成原生 turn end（真事件追加，不改不可变日志），随后落库。
   // 只完成**内存 log** 的原生 turn end：回退静止期间经 store 追加会被守卫拒绝（实测 assertRollbackWritable
   // 「物理回退静止期间禁止新Session轮次」），真实落库交给回退自身的物理纯尾；迟到写走下面 whenIdle 的业务负载。
   if(!f.session.snapshotEvents().some(e=>e.type==='turn/end'&&Number(e.data?.turn)===53))f.session.append('turn/end',{turn:53,reason:{kind:'aborted'}})
   agent.phase={kind:'idle',lastTurn:53}
  }
  agent.whenIdle=async()=>{
   idleWaits+=1
   // late stop：取消后迟到写 discard revision（身份相同、只动本轮操作状态与 revision）。
   await f.update(f.base.id,c=>{lateWrites+=1;if(c.timeline.operations.body)c.timeline.operations.body={...c.timeline.operations.body,status:'discarded',discardedAt:'旧53迟到写'};return c})
  }
  const result=await cleanRollback({...f.args,chat:before,requestedTurn:signed,availability:()=>({failedTurns:[],canRollback:false})})
  assert.equal(cancels,1,'在途发送必须先被取消')
  assert.equal(idleWaits,1,'必须等待代理静止')
  assert.equal(lateWrites,1,'迟到写必须真的发生（模拟）')
   assert.equal((await f.read()).rollbackCompletion.ordinaryTarget.revision,signed.revision,'完成意图保留发起版本，同一凭据才能精确重试')
   assert.ok((await f.read())._storageRevision>signed.revision,'取消终态写入真实推进revision，不能把同轮正常收口误判为陈旧目标')
  const after=await f.read()
  assert.equal(result.turn,52,'返回视图轮号必须是恢复后的 52')
  assert.equal(f.mainDb.readMeta().eventCount,f.keep,'取消后写入的终态必须随纯尾一并删除')
  assert.equal(after.messages.at(-1).turn,52,'正文必须回到 52')
  assert.equal(after.timeline.operations.body,undefined,'迟到 discard 操作必须随物理纯尾删除')
  assert.equal(JSON.stringify(after.timeline).includes('discarded'),false,'迟到 discard 状态不得残留')
  assert.equal(after.rollbackPending,undefined)
  assert.equal(f.agents.get(f.session.id).phase.lastTurn,52)
 }finally{await f.cleanup()}
  // 伪造**身份/锚点**必须拒（防删错数据）：chat/session/branch 与原生输入锚点仍是硬底线。
  // 入口仍拒绝过期版本；静止期间同轮正常终态可推进revision，但分支/轮次/操作漂移仍拒。
  for(const [name,mutate,pattern] of [
   ['分支变化',c=>{c.timeline.branchId='new-branch';return c},/版本已过期|分支/],
   ['轮次变化',c=>{c.timeline.operations.body.turn=54;return c},/回退目标已经变化/],
   ['操作变化',c=>{c.timeline.operations.replacement=c.timeline.operations.body;delete c.timeline.operations.body;return c},/操作身份已变化/],
  ]){
   const g=await fixture(false,false,{status:'running',reason:'interrupted',reply:false,variables:true,end:false})
   try{
    const chat=await g.read(),signed=latestSendTarget(chat,{events:g.session.snapshotEvents()})
    const agent=g.agents.get(g.session.id)
    agent.phase={kind:'running',lastTurn:53}
    agent.cancel=()=>{agent.phase={kind:'idle',lastTurn:53}}
    agent.whenIdle=async()=>{await g.update(g.base.id,mutate)}
    const cursor=g.mainDb.cursor()
    await assert.rejects(cleanRollback({...g.args,chat,requestedTurn:signed}),pattern,name)
    const after=await g.read()
    assert.equal(g.mainDb.cursor(),cursor,name+'：不得截断原生库')
    assert.deepEqual(after.messages,chat.messages,name+'：不得删除正文')
    assert.deepEqual(after.variables,chat.variables,name+'：不得改写变量')
    assert.equal(after.rollbackPending,undefined,name+'：不得创建完成意图')
   }finally{await g.cleanup()}
  }
 const forged=[
  ['错chat',t=>({...t,chatId:'other-chat'}),/不一致/],
   ['错revision',t=>({...t,revision:t.revision+1}),/版本已过期/],
  ['错session',t=>({...t,sessionId:'other-session'}),/不一致/],
  ['错branch',t=>({...t,branchId:'other-branch'}),/不一致|过期/],
  ['错nativeAnchor',t=>({...t,nativeAnchor:{...(t.nativeAnchor||{}),input:Number(t.nativeAnchor?.input||0)+999}}),/锚点|已变化|不一致/],
 ]
 for(const [name,mutate,pattern] of forged){
  const g=await fixture(false,false,{status:'running',reason:'aborted',reply:false,variables:true})
  try{
   const chat=await g.read()
   const signed=latestSendTarget(chat,{events:g.session.snapshotEvents()},chat._storageRevision)
   let cancels=0
   const agent=g.agents.get(g.session.id)
   agent.phase={kind:'running',lastTurn:53}
   agent.cancel=()=>{cancels+=1;agent.phase={kind:'idle',lastTurn:53}}
   agent.whenIdle=async()=>{}
   const rowsBefore=g.mainDb.readMeta().eventCount,revisionBefore=(await g.read())._storageRevision
   await assert.rejects(cleanRollback({...g.args,chat,requestedTurn:mutate(signed),availability:()=>({failedTurns:[],canRollback:false})}),pattern,name)
   assert.equal(cancels,0,name+'：伪造凭据不得取消在途发送')
   assert.equal(g.mainDb.readMeta().eventCount,rowsBefore,name+'：伪造凭据零库写')
   assert.equal((await g.read())._storageRevision,revisionBefore,name+'：伪造凭据零 store 写')
   assert.equal(g.agents.get(g.session.id).phase.kind,'running',name+'：伪造凭据不得改变 phase')
  }finally{await g.cleanup()}
 }
 // 锚点原事件故意坏（target 与 saved **同坏**）：op.nativeAnchor 指向别轮的 user 事件 ⇒ 主新增的"原事件 turn 所属"校验必须拒，且零取消/零库写。
 const bad=await fixture(false,false,{status:'running',reason:'aborted',reply:false,variables:true})
 try{
  const beforeBad=await bad.read()
  const foreignSeq=bad.session.snapshotEvents().find(event=>event.type==='user/message')?.seq
  assert.ok(Number.isSafeInteger(foreignSeq),'夹具必须含更早轮的原生 user 事件')
  await bad.update(bad.base.id,c=>{
   const op=Object.values(c.timeline.operations).find(item=>item?.kind==='body'&&Number(item.turn)===53)
   op.nativeAnchor={turn:53,input:foreignSeq,reply:null}
   return c
  })
  const chatBad=await bad.read()
  const signedBad=latestSendTarget(chatBad,{events:bad.session.snapshotEvents()},chatBad._storageRevision)
  assert.equal(signedBad.nativeAnchor.input,foreignSeq,'构造条件：target 与 saved 必须同坏')
  let cancelsBad=0
  const agentBad=bad.agents.get(bad.session.id)
  agentBad.phase={kind:'running',lastTurn:53}
  agentBad.cancel=()=>{cancelsBad+=1;agentBad.phase={kind:'idle',lastTurn:53}}
  agentBad.whenIdle=async()=>{}
  const rowsBeforeBad=bad.mainDb.readMeta().eventCount,revisionBeforeBad=(await bad.read())._storageRevision
  await assert.rejects(cleanRollback({...bad.args,chat:chatBad,requestedTurn:signedBad,availability:()=>({failedTurns:[],canRollback:false})}),/锚点|不一致|拒绝|事件/, '锚点原事件不属于该轮必须拒')
  assert.equal(cancelsBad,0,'坏锚点不得取消在途发送')
  assert.equal(bad.mainDb.readMeta().eventCount,rowsBeforeBad,'坏锚点零库写')
  assert.equal((await bad.read())._storageRevision,revisionBeforeBad,'坏锚点零 store 写')
 }finally{await bad.cleanup()}
})
test('最早轮仅turn/start（无user未prepare）：latestSendTarget仍有body基准并物理回到前轮',async()=>{
 const {latestSendTarget}=await import('../lib/clean-rollback.js')
 const f=await fixture(false,false,{status:'running',reason:'interrupted',reply:false,variables:true,end:false,user:false})
 try{
  const before=await f.read()
  const signed=latestSendTarget(before,{events:f.session.snapshotEvents()},before._storageRevision)
  assert.equal(signed?.kind,'rollback','只有 turn/start 时也必须签出统一目标')
  assert.equal(signed.turn,53,'目标轮必须是本轮')
  assert.equal(signed.nativeAnchor,undefined,'原生输入还没到 ⇒ 不得猜 anchor')
  const result=await cleanRollback({...f.args,chat:before,requestedTurn:signed,availability:()=>({failedTurns:[],canRollback:false,reason:'旧判断不认可'})})
  const after=await f.read()
  assert.equal(result.turn,52,'必须物理回到前轮 52')
  assert.equal(f.mainDb.readMeta().eventCount,f.keep,'原生库行数必须回到 keep')
  assert.equal(after.messages.at(-1).turn,52,'正文必须回到前轮 52')
  assert.deepEqual(after.variables,{hp:52})
  assert.equal(after.timeline.operations.body,undefined,'53 body 操作必须删除')
  assert.equal(after.rollbackPending,undefined)
 }finally{await f.cleanup()}
})
test('数字旧入口同样撤最新发送而非历史失败轮',async()=>{
 const f=await fixture(false,false,{status:'completed',reason:'completed',reply:true,variables:true,legacyFailedTurn:51})
 try{
  const before=await f.read()
  assert.ok(before.timeline.operations.bodyFailed51,'夹具必须含更旧 failed 51 op（带基准）')
  assert.ok(before.timeline.operations.body,'53 body op 必须在位')
  // 数字旧入口（无 kind）＋ availability 把 51/53 都列为 failed：必须仍撤最新 53 ⇒ 回到 52 且保留 51。
  const result=await cleanRollback({...f.args,chat:before,requestedTurn:53,availability:()=>({failedTurns:[51,53],canRollback:true}),chats:{...f.args.chats,readRollbackOperationSnapshot:f.store.readRollbackOperationSnapshot}})
  const after=await f.read()
  assert.equal(result.turn,52,'数字旧入口必须撤最新发送（回到 52）')
  assert.equal(after.messages.at(-1).turn,52,'正文必须回到 52')
  assert.ok(after.timeline.operations.bodyFailed51,'历史 failed 51 的 op 必须保留（不得被抢删）')
  assert.deepEqual(after.timeline.operations.bodyFailed51.businessBefore,before.timeline.operations.bodyFailed51.businessBefore,'历史轮基准必须逐字保留')
  assert.equal(after.timeline.operations.body,undefined,'最新 53 op 必须删除')
  assert.equal(f.mainDb.readMeta().eventCount,f.keep,'原生库行数必须回到 keep')
 }finally{await f.cleanup()}
 const g=await fixture(false,false,{status:'completed',reason:'completed',reply:true,variables:true,legacyFailedTurn:51})
 try{
  const before=await g.read()
  const rowsBefore=g.mainDb.readMeta().eventCount,revisionBefore=(await g.read())._storageRevision
  // 旧入口指定历史失败轮 51：不是最新发送 ⇒ 必须拒且零删零写。
  await assert.rejects(cleanRollback({...g.args,chat:before,requestedTurn:51,availability:()=>({failedTurns:[51,53],canRollback:true})}),/已经变化|最新|不一致|拒绝/)
  assert.equal(g.mainDb.readMeta().eventCount,rowsBefore,'拒绝时零删')
  assert.equal((await g.read())._storageRevision,revisionBefore,'拒绝时零 store 写')
  assert.ok((await g.read()).timeline.operations.bodyFailed51,'拒绝时不得删除任何 op')
 }finally{await g.cleanup()}
})

test('统一撤销新增：旧轮独立正文编辑在新发送之后仍精确保留',async()=>{
 const {latestSendTarget}=await import('../lib/latest-send.js')
 const f=await fixture(false,false,{reply:false,status:'running',variables:true})
 try {
  const editId='tavern-body-edit:after-send',editStart=f.session.seq
  await f.update(f.base.id,current=>{current.messages[1]={...current.messages[1],text:'52用户独立改稿',bodyEdit:{id:editId,turn:52,seq:2}};return current},{source:'foreground.body-edit'})
  f.session.append('dsh-tavern/required-session-patch-v1',{version:1})
  f.session.append('assistant/message',{turn:52,step:1,message:{id:editId,role:'assistant',content:[{type:'text',text:'52用户独立改稿'}],source:{kind:'model',provider:'dsh-tavern',model:'body-edit'}}},{surfaceOp:{op:'replace',startSeq:2,endSeq:2},sourceEventSeqs:[2]})
  f.mainDb.appendBatch(f.session.snapshotEvents(editStart),editStart)
  const chat=await f.read(),target=latestSendTarget(chat,{events:f.session.snapshotEvents()})
  await cleanRollback({...f.args,chat,requestedTurn:target,services:{...f.args.services,preserveRetainedBodyEdits:true}})
  const after=await f.read()
  assert.equal(after.messages[1].text,'52用户独立改稿')
  assert.equal(f.mainDb.cursor(),f.keep+2)
  assert.equal(f.session.surface.nodes.includes(2),false)
  assert.equal(f.session.snapshotEvents().some(event=>event.data?.turn===53),false)
  assert.equal(f.session.snapshotEvents().at(-1).data.message.content[0].text,'52用户独立改稿')
 } finally {await f.cleanup()}
})
test('统一撤销新增：无前像原生尾成功与未知终态输出均可物理清理',async()=>{
 for(const reason of ['completed','未来终态']) {
  const f=await fixture(false)
  try {
   // 旧业务未记53且无变更：完整原生53保留reason/思考/正文；不是只允许空错误。
   await f.update(f.base.id,current=>({...f.base,_storageRevision:current._storageRevision+1}),{source:'configuration.fixture'})
   const events=f.session.snapshotEvents()
   // 原生类型不改，未知终态是Session已能保存的opaque reason。
   if(reason!=='completed') {
    // 夹具events不可变，使用原生尾替换接口保存新输入，不能直接改内存来源。
    f.session.append('turn/start',{turn:54})
    f.session.append('user/message',{id:'u54',role:'user',content:[{type:'text',text:'未知尾输入'}],source:{kind:'user'}},{surfaceOp:'append'})
    f.session.append('assistant/message',{turn:54,step:1,message:{id:'a54',role:'assistant',content:[{type:'reasoning',text:'未知尾思考'},{type:'text',text:'未知尾正文'}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
    f.session.append('turn/end',{turn:54,reason:{kind:reason}})
    f.mainDb.appendBatch(f.session.snapshotEvents(events.length),events.length)
    // 清理最新54保留53原生前缀；两轮纯尾不能冒充一次发送。
   }
   const chat=await f.read(),target=inspectNativeFailureTail(chat,{events:f.session.snapshotEvents()}).target
   assert.ok(target,reason+'必须签最新原生发送，不按终态/输出分类')
   const keep=reason==='completed'?f.keep:events.length
   await cleanRollback({...f.args,chat,requestedTurn:target,services:{...f.args.services,isFailureCleanupIdle:()=>true}})
   assert.equal(f.mainDb.cursor(),keep)
   assert.equal(f.session.snapshotEvents().some(event=>Number(event.data?.turn)===target.turn),false)
   assert.deepEqual((await f.read()).variables,{hp:52})
  } finally {await f.cleanup()}
 }
})

test('统一撤销新增：实际SQLite更新记录未知运行根及旧消息前像并恢复，配置保留',async()=>{
 const {latestSendTarget}=await import('../lib/latest-send.js')
 const f=await fixture()
 try {
  await f.update(f.base.id,current=>{current.futureRuntime={payload:['旧53未知工具'],turn:53};current.messages[1]={...current.messages[1],text:'本轮工具改了旧消息'};return current},{source:'foreground.commit'})
  await f.update(f.base.id,current=>{current.guides=[{text:'用户独立新Guide'}];return current},{source:'guide.add'})
  const before=await f.read()
  assert.deepEqual(before.timeline.operations.body.businessBefore.runtimeFields.futureRuntime,{present:false})
  assert.equal(before.timeline.operations.body.businessBefore.messagePreimages['1'].text,'上一轮52')
  assert.deepEqual(before.timeline.checkpoints[0].businessBefore.runtimeFields,before.timeline.operations.body.businessBefore.runtimeFields)
  const target=latestSendTarget(before,{events:f.session.snapshotEvents()})
  await cleanRollback({...f.args,chat:before,requestedTurn:target})
  const after=await f.read()
  assert.equal(after.futureRuntime,undefined)
  assert.equal(after.messages[1].text,'上一轮52')
  assert.deepEqual(after.guides,[{text:'用户独立新Guide'}])
  assert.ok(!JSON.stringify(after).includes('旧53未知工具'))
 } finally {await f.cleanup()}
})

test('窄写撤销新增：append与单楼命令同事务累计未知头及历史行前像',async()=>{
 const {latestSendTarget}=await import('../lib/latest-send.js')
 const f=await fixture()
 try {
  let chat=await f.read()
  await f.store.appendMessages(f.base.id,chat._storageRevision,{items:[{role:'assistant',turn:53,text:'旧53工具追加',swipeId:0,swipes:['旧53工具追加']}],headerSets:{futureNarrowRuntime:{payload:'旧53未知窄写'}}},{sessionId:f.session.id,source:'foreground.commit'})
  chat=await f.read()
  await f.store.setMessageFloor(f.base.id,chat._storageRevision,1,{changes:[{op:'set',path:['messages',1,'text'],value:'旧53窄写改历史消息'}],headerSets:{futureNarrowRuntime:{payload:'旧53二次窄写'},anotherRuntime:{text:'旧53新增'}}},{sessionId:f.session.id,source:'settlement.commit'})
  const before=await f.read(),baseline=before.timeline.operations.body.businessBefore
  assert.deepEqual(baseline.runtimeFields.futureNarrowRuntime,{present:false})
  assert.deepEqual(baseline.runtimeFields.anotherRuntime,{present:false})
  assert.equal(baseline.messagePreimages['1'].text,'上一轮52')
  assert.deepEqual(before.timeline.checkpoints[0].businessBefore.runtimeFields,baseline.runtimeFields)
  await cleanRollback({...f.args,chat:before,requestedTurn:latestSendTarget(before,{events:f.session.snapshotEvents()})})
  const after=await f.read()
  assert.equal(after.futureNarrowRuntime,undefined);assert.equal(after.anotherRuntime,undefined)
  assert.equal(after.messages[1].text,'上一轮52');assert.equal(after.messages.length,2)
  assert.ok(!JSON.stringify(after).includes('旧53窄写'))
 }finally{await f.cleanup()}
})
test('兼容重试新增：旧失败凭据半提交后selector不签前轮且同一意图能收敛',async()=>{
 const {latestSendTarget}=await import('../lib/latest-send.js')
 const f=await fixture(true)
 try {
  const chat=await f.read(),target={turn:53,operationId:'body',branchId:chat.timeline.branchId,revision:chat._storageRevision,chatId:chat.id,sessionId:chat.sessionId}
  f.setFault(true)
  await assert.rejects(cleanRollback({...f.args,chat,requestedTurn:target}),/原创故障点/)
  const partial=await f.read()
  assert.equal(latestSendTarget(partial,{events:f.session.snapshotEvents()}),null)
  assert.equal(partial.rollbackPending.turn,53)
  const retry={...partial.rollbackPending.failureTarget,rollbackId:partial.rollbackPending.id}
  f.setFault(false)
  await cleanRollback({...f.args,chat:partial,requestedTurn:retry})
  assert.equal((await f.read()).rollbackPending,undefined)
  assert.equal(f.mainDb.cursor(),f.keep);assert.equal(f.workerDb.cursor(),1)
 }finally{await f.cleanup()}
})
// 提取本机SDK原样Inbox/投影/Agent类，只添加导出；零模型请求，生产turn()在首step拒绝结束。
async function nativeInboxSdk() {
 const source=readFileSync(requireHost.resolve('@deepseek-ai/dsh-agent-loop'),'utf8')
 const rewritten=source.replace(/from "([^\"]+)"/g,(all,name)=>name.startsWith('node:')?all:'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 return import('data:text/javascript;base64,'+Buffer.from(rewritten+'\nexport {ReactLoopInbox,inboxProjectionDefinition,ReactLoopAgent};').toString('base64'))
}
test('前台队列切点：真实SDK入队start领取消息经SQLite撤销后重折及重开不复活',async()=>{
 const {ReactLoopInbox,inboxProjectionDefinition,ReactLoopAgent}=await nativeInboxSdk()
 for(const mode of ['claimed','before-claim','replaced']) {
  let inbox
  const f=await fixture(false,false,{reply:false,checkpoint:false,nativeSend:async(session,projections)=>{
   projections.register(inboxProjectionDefinition)
   inbox=new ReactLoopInbox(projections,session,{emit(){}})
   const input={id:'queued53',role:'user',content:[{type:'text',text:'要撤销的队列输入53'}],source:{kind:'user'}}
   inbox.append('next-turn',input)
   if(mode==='replaced')inbox.replace(input.id,{...input,id:'replaced53',content:[{type:'text',text:'替换后输入53'}]})
   session.append('turn/start',{turn:53})
   if(mode!=='before-claim')for(const message of inbox.claim('next-turn',53))session.append('user/message',message,{surfaceOp:'append'})
   session.append('turn/end',{turn:53,reason:{kind:'未来未知终态'}})
  }})
  try {
   const chat=await f.read(),{latestSendTarget}=await import('../lib/latest-send.js')
   f.agents.get(f.session.id).inbox=inbox
   const receipt=await cleanRollback({...f.args,chat,requestedTurn:latestSendTarget(chat,{events:f.session.snapshotEvents()})})
   assert.equal(receipt.rolledBack.hiddenTurn,53)
   assert.equal(f.mainDb.cursor(),f.keep)
   assert.deepEqual(inbox.current(),{'next-turn':[],'next-step':[]},mode+'活动投影不能复活输入')
   const durable=f.mainDb.readAll().events
   assert.ok(!JSON.stringify(durable).includes('queued53'))
   assert.ok(!JSON.stringify(durable).includes('replaced53'))
   const reopened=new SqliteSessionDb(path.join(f.root,'session.db'))
   try {assert.deepEqual(reopened.readAll().events.reduce((s,e)=>inboxProjectionDefinition.apply(s,e),inboxProjectionDefinition.init()),inboxProjectionDefinition.init())}finally{reopened.close()}
   assert.deepEqual((await f.read()).messages,f.base.messages)
   assert.deepEqual((await f.read()).variables,{hp:52})
   assert.equal(f.syncFrames.length,1)
   const agent=f.agents.get(f.session.id)
   agent.phase={kind:'running',turn:agent.phase.lastTurn,step:0,abort:new AbortController()}
   agent.preStep=async()=>({kind:'reject'});agent.dispatch={emit(){}};agent.throwError=error=>{throw error}
   const at=f.session.seq
   await ReactLoopAgent.prototype.turn.call(agent)
   assert.deepEqual(f.session.snapshotEvents(at).filter(e=>e.type==='turn/start').map(e=>e.data.turn),[53])
   assert.equal(inbox.hasPending,false)
  }finally{await f.cleanup()}
 }
})
test('前台队列切点：独立后继输入与跨旧轮入队均零删库拒绝',async()=>{
 const {ReactLoopInbox,inboxProjectionDefinition}=await nativeInboxSdk()
 for(const overlap of [false,true]) {
  let inbox
  const f=await fixture(false,false,{nativeSend:async(session,projections)=>{
   projections.register(inboxProjectionDefinition);inbox=new ReactLoopInbox(projections,session,{emit(){}})
   const message={id:'owned53',role:'user',content:[{type:'text',text:'本轮输入'}],source:{kind:'user'}}
   inbox.append('next-turn',message)
   if(overlap){session.append('turn/start',{turn:52});session.append('turn/end',{turn:52,reason:{kind:'completed'}})}
   session.append('turn/start',{turn:53})
   for(const input of inbox.claim('next-turn',53))session.append('user/message',input,{surfaceOp:'append'})
   session.append('turn/end',{turn:53,reason:{kind:'completed'}})
   if(!overlap)inbox.append('next-turn',{...message,id:'independent54'})
  }})
  try {
   f.agents.get(f.session.id).inbox=inbox
   const chat=await f.read(),events=f.mainDb.readAll().events,worker=f.workerDb.cursor(),{latestSendTarget}=await import('../lib/latest-send.js')
   await assert.rejects(cleanRollback({...f.args,chat,requestedTurn:latestSendTarget(chat,{events:f.session.snapshotEvents()})}),overlap?/目标输入入队早于其它独立轮/:/独立输入/)
   assert.deepEqual(await f.read(),chat)
   assert.deepEqual(f.mainDb.readAll().events,events);assert.equal(f.workerDb.cursor(),worker)
   assert.equal(f.syncFrames.length,0)
  }finally{await f.cleanup()}
 }
})
test('前台精确前缀：首轮仅撤目标入队并保留更早独立待输入，旧后台首队不夺切点',async()=>{
 const {ReactLoopInbox,inboxProjectionDefinition}=await nativeInboxSdk()
 let inbox
 const f=await fixture(false,false,{firstTurn:true,before52:async(session,projections)=>{
  session.append('session/end-seed',{})
  projections.register(inboxProjectionDefinition);inbox=new ReactLoopInbox(projections,session,{emit(){}})
  inbox.append('next-turn',{id:'independent-earlier',role:'user',content:[{type:'text',text:'用户更早独立待输入'}],source:{kind:'user'}})
 },nativeSend:async(session)=>{
  inbox.prepend('next-turn',{id:'owned-first',role:'user',content:[{type:'text',text:'目标首轮输入'}],source:{kind:'user'}})
  session.append('turn/start',{turn:53})
  for(const message of inbox.claim('next-turn',53))session.append('user/message',message,{surfaceOp:'append'})
  session.append('turn/end',{turn:53,reason:{kind:'completed'}})
 }})
 try {
  const chat=await f.read(),{latestSendTarget}=await import('../lib/latest-send.js')
  f.agents.get(f.session.id).inbox=inbox
  await cleanRollback({...f.args,chat,requestedTurn:latestSendTarget(chat,{events:f.session.snapshotEvents()})})
  assert.equal(f.mainDb.cursor(),f.keep)
  assert.deepEqual(inbox.nextTurn.map(m=>m.id),['independent-earlier'])
  assert.ok(!JSON.stringify(f.mainDb.readAll().events).includes('owned-first'))
  assert.deepEqual(f.mainDb.readAll().events.reduce((s,e)=>inboxProjectionDefinition.apply(s,e),inboxProjectionDefinition.init())['next-turn'].map(m=>m.id),['independent-earlier'])
  assert.equal(f.agents.get(f.session.id).phase.lastTurn,0)
 }finally{await f.cleanup()}
})
test('原生取消新增：无前像活动尾取消新终态后按原接受身份清理',async()=>{
 const f=await fixture(false,false,{reply:false,end:false})
 try {
  await f.update(f.base.id,current=>({...f.base,_storageRevision:current._storageRevision+1}),{source:'configuration.fixture'})
  const chat=await f.read(),target=inspectNativeFailureTail(chat,{events:f.session.snapshotEvents()}).target
  assert.ok(target)
  const agent=f.agents.get(f.session.id);let canceled=0
  agent.phase={kind:'running',lastTurn:53}
  agent.cancel=()=>{canceled++;const at=f.session.seq;f.session.append('turn/end',{turn:53,reason:{kind:'aborted'}});f.mainDb.appendBatch(f.session.snapshotEvents(at),at);agent.phase={kind:'idle',lastTurn:53}}
  agent.whenIdle=async()=>{}
  await cleanRollback({...f.args,chat,requestedTurn:target})
  assert.equal(canceled,1);assert.equal(f.mainDb.cursor(),f.keep)
  assert.equal(f.session.snapshotEvents().some(event=>event.data?.turn===53),false)
 }finally{await f.cleanup()}
})

// 真实作者 2.7.0 入口链路回归（本轮核心修复）：
// round-history.js:551-565 经 chats.readState(=taskStateReader.read) 读档，taskStateFields
// **不含** timeline.checkpoints 与 messages；clean-rollback-transform 的 rollbackChat 垫片
// 又直接把这枚摘要当作 chat 传给 cleanRollback。若执行端用摘要判"是否最新发送/是否带基准"，
// 就会把可回退的最新轮误判成不可回退（现场报"回退目标不是当前最新发送"）。
// 这里复现该形态：最新轮 body 已被账本回收、发轮前基准只存在于 checkpoint。
test('真实入口：任务摘要缺checkpoints与messages仍能回退最新轮，并可连续清理上一轮',async()=>{
  // 真实会话在首轮之前必有会话头/种子（resolveTurnCut 的 first-turn 模式据此保留 metadata），
  // 否则第一轮回退会被「没有安全边界」拒绝——那是夹具不真实，不是回退资格问题。
  const f=await fixture(false,false,{before52:s=>s.append('session/end-seed',{})})
  const {latestSendTarget}=await import('../lib/latest-send.js')
  try{
   // ① 构造真实形态：最新轮(53) body operation 已回收，同轮 checkpoint 仍是唯一发轮前基准。
   await f.update(f.base.id,c=>{
    delete c.timeline.operations.body
    // 同时给上一轮(52)补真实发轮前像（messageCount=1、hp51），否则连续回退只能走 synthetic 基准。
    const before52=structuredClone((c.timeline.checkpoints||[]).find(cp=>Number(cp.turn)===53).businessBefore)
    before52.messageCount=1;before52.fields={...before52.fields,variables:{hp:51}}
    c.timeline.checkpoints=[{id:'cp52',turn:52,businessBefore:before52},...(c.timeline.checkpoints||[])]
    return c})
   f.args.chat=await f.read()
   assert.equal(f.args.chat.timeline.operations.body,undefined,'构造条件：最新轮 body 必须已回收')
   assert.ok((f.args.chat.timeline.checkpoints||[]).some(cp=>Number(cp.turn)===53),'构造条件：同轮 checkpoint 必须仍在')
   // ② 按作者入口口径取窄摘要（不含 checkpoints/messages）。
   const entry=await f.store.readSlice(f.base.id,[],TASK_STATE_FIELDS)
   assert.ok(entry?.chat,'窄读必须返回摘要')
   assert.equal(entry.chat.timeline.checkpoints,undefined,'构造条件：入口摘要必须没有 checkpoints')
   assert.equal(entry.chat.messages.length,0,'构造条件：入口摘要 messages 必须为空')
   // ③ 视图层用完整档签目标（与线上一致），执行端只收到摘要。
   const signed=latestSendTarget(await f.read(),{events:f.session.snapshotEvents()})
   assert.equal(signed?.kind,'rollback')
   assert.equal(signed.turn,53)
   // ④ 摘要作入口发起回退：不得因"摘要里找不到同轮基准"而拒绝。
   const result=await cleanRollback({...f.args,chat:entry.chat,requestedTurn:signed})
   assert.equal(result.turn,52,'必须回到上一轮边界')
   const after=await f.read()
   assert.equal(after.messages.at(-1).turn,52,'正文必须回到 52')
   assert.deepEqual(after.variables,{hp:52},'变量必须恢复 52 的发轮前像')
   assert.equal(after.rollbackPending,undefined)
   assert.equal(f.mainDb.readMeta().eventCount,f.keep,'必须正好删掉最新轮，不多删上一轮')
   // ⑤ 上一轮成为最新轮后必须仍可继续清理（连续回退，不因形态/分支变化拒绝）。
   const nextEntry=await f.store.readSlice(f.base.id,[],TASK_STATE_FIELDS)
   const nextTarget=latestSendTarget(await f.read(),{events:f.session.snapshotEvents()})
   assert.equal(nextTarget.turn,52,'上一轮必须成为新的最新发送')
   const second=await cleanRollback({...f.args,chat:nextEntry.chat,requestedTurn:nextTarget})
   assert.equal(second.rolledBack.hiddenTurn,52,'必须撤销当前最新轮 52')
   const settled=await f.read()
   assert.equal(settled.messages.length,1,'必须回到 52 的发轮前像（只剩上一条输入）')
   assert.deepEqual(settled.variables,{hp:51},'必须恢复 52 的发轮前像变量 hp51')
   assert.equal(settled.rollbackPending,undefined)
   assert.equal(f.mainDb.readMeta().eventCount,1,'连续回退必须只留会话头，不删 metadata')
   assert.equal(f.session.snapshotEvents().some(event=>Number(event.data?.turn)>=52),false,'52/53 的事件必须都已物理删除')
  }finally{await f.cleanup()}
})
