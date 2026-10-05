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
import {cleanRollback} from '../lib/clean-rollback.js'
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
async function fixture(failed=false,withBook=false){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-clean-rollback-'))
 const raw=readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 const file=path.join(root,'session.mjs');writeFileSync(file,raw,'utf8');const {Session}=await import(pathToFileURL(file).href)
 const {SessionProjectionRegistry}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
 const {Context}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href),{z}=await import(pathToFileURL(requireHost.resolve('zod')).href)
 const ctx=new Context(),projections=new SessionProjectionRegistry(ctx)
 projections.register({key:'turnBoundary',stateVersion:1,stateSchema:z.object({lastTurn:z.number()}),init:()=>({lastTurn:0}),apply:(state,e)=>e.type==='turn/end'?{lastTurn:e.data.turn}:state})
 const session=Session.create('fixture-session'),background=Session.create('fixture-background')
 background.append('session/end-seed',{})
 function turn(s,n,text,reason='completed'){
  s.append('turn/start',{turn:n});s.append('user/message',{id:'u'+n,role:'user',content:[{type:'text',text:'输入'+text}],source:{kind:'user'}},{surfaceOp:'append'})
  s.append('assistant/message',{turn:n,step:1,message:{id:'a'+n,role:'assistant',content:[{type:'text',text}],source:{kind:'model',provider:'fixture',model:'fixture'}},stream:[]},{surfaceOp:'append'})
  s.append('turn/end',{turn:n,reason:{kind:reason}})
 }
 turn(session,52,'上一轮52');const keep=session.seq
 const mainDb=new SqliteSessionDb(path.join(root,'session.db'));mainDb.materialize(session.header,session.inheritedEventCount,session.snapshotEvents())
 const workerDb=new SqliteSessionDb(path.join(root,'background.db'));workerDb.materialize(background.header,background.inheritedEventCount,background.snapshotEvents())
 const baseMessages=[{role:'user',text:'上一轮输入'},{role:'assistant',turn:52,text:'上一轮52',swipeId:0,swipes:['上一轮52'],variables:[{hp:52}]}]
 const store=createChatSqliteStore({dataRoot:root,helpers})
 const base={id:'fixture-chat',sessionId:session.id,_storageRevision:1,mode:'story',messages:baseMessages,variables:{hp:52},lastWorldBookRecall:{turn:52},contextCompaction:{warning:'上一轮'},timeline:{schemaVersion:1,branchId:'old',revision:52,checkpoints:[],operations:{},participants:{}}}
 if(withBook)base.openingWorldbookSnapshot={version:1,document:{entries:[{uid:0,content:'原创上轮52世界书'}]},unknown:{keep:true}}
 await store.update(base.id,()=>base)
 const baseline=captureRollbackBusinessState(base)
 turn(session,53,'旧53',failed?'error':'completed');mainDb.appendBatch(session.snapshotEvents(keep),keep)
 const bgKeep=background.seq;turn(background,1,'旧53后台');workerDb.appendBatch(background.snapshotEvents(bgKeep),bgKeep)
 const current={...base,_storageRevision:2,messages:failed?[...baseMessages,{role:'user',turn:53,text:'输入旧53半截'}]:[...baseMessages,{role:'user',text:'输入旧53'},{role:'assistant',turn:53,text:'旧53',swipeId:0,swipes:['旧53'],variables:[{hp:53}]}],variables:{hp:53},lastWorldBookRecall:{turn:53},contextCompaction:{warning:'旧53'},foregroundError:{message:'旧53'},unknownBusiness:'用户独立编辑保留',timeline:{...base.timeline,revision:53,operations:{body:{kind:'body',turn:53,status:failed?'failed':'completed',businessBefore:baseline},orphan:{kind:'agent',role:'filter',text:'旧53'}},checkpoints:failed?[]:[{id:'cp53',turn:53,businessBefore:baseline}],participants:{settlement:{role:'settlement',sessionId:background.id,lifetime:'chat',boundary:background.seq-1}}}}
 if(withBook)current.openingWorldbookSnapshot={version:1,document:{entries:[{uid:0,content:'原创本轮53世界书'}]}}
 await store.update(base.id,()=>current)
 const agents=new Map([[session.id,{session,phase:{kind:'idle',lastTurn:53},runtimeContext:{retained:{text:'旧53'}},requestHeaderLogged:true}],[background.id,{session:background,phase:{kind:'idle',lastTurn:1},runtimeContext:{retained:{text:'旧53后台'}}}]])
 const handles=new Set([...agents].map(([id,a])=>({id,access:'write',state:{cursor:a.session.seq,primed:{text:'旧53'}},observedLength:a.session.seq})))
 const dbs=new Map([[session.id,mainDb],[background.id,workerDb]])
 let fault=false
 const persistence={bindRollbackArchive:async(id,file)=>dbs.get(id).bindRollbackArchive(file),setRollbackPending:async(id,value)=>dbs.get(id).setRollbackPending(value),drainOpenHandles:async()=>{},truncateEvents:async(header,boundary)=>{if(fault&&header.id===background.id)throw Error('原创故障点');const db=dbs.get(header.id),meta=db.truncateFrom(boundary);rewindRollbackHandles(handles,header.id,meta.eventCount);return meta}}
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
for(const kind of ['missing-token','missing-baseline','unknown-worker','missing-sync','missing-inbox'])test('删前硬拒：'+kind+'不能假报干净，archive与Session尾部均不变',async()=>{
 const f=await fixture()
 try{
  if(kind==='missing-baseline')await f.update(f.base.id,c=>{delete c.timeline.checkpoints[0].businessBefore;return c},{source:'fixture.prepare'})
  if(kind==='unknown-worker')await f.update(f.base.id,c=>{c.timeline.operations.independent={id:'independent',kind:'agent',startedSessionId:'untracked-session'};return c},{source:'fixture.prepare'})
  const before=await f.read(),eventCount=f.mainDb.cursor()
  if(kind==='missing-inbox')delete f.agents.get(f.session.id).inbox
  const args={...f.args,chat:before,...(kind==='missing-token'?{services:{...f.args.services,tokenMeterProvider:()=>undefined}}:kind==='missing-sync'?{services:{...f.args.services,rollbackSyncProvider:()=>undefined}}:{})}
  const reasons={'missing-token':/token/,'missing-baseline':/业务回退基准/,'unknown-worker':/独立任务会话/,'missing-sync':/同连接同步/,'missing-inbox':/inbox/}
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
