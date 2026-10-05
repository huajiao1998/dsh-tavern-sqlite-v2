// 原创隔离SQL；实际rc.2 Session/写句柄＋生产后端方法＋完整cleanRollback屏障。
// 零用户档、模型或线上操作；只测试唯一身份与纯尾截断收口。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {SqliteSessionDb} from '../store.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {rollbackBarrier,rollbackSchedulingBarrier,assertRollbackSessionWritable} from '../lib/rollback-barrier.js'
import {cleanRollback} from '../lib/clean-rollback.js'
import {installRollbackSync} from '../lib/rollback-sync.js'
import {configureRollbackCleanup,rewindSessionMemory} from '../lib/rollback-cleanup.js'
configureRollbackCleanup({sessionEvents:s=>s.snapshotEvents()})
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
const actual=readFileSync(new URL('../../../tmp/rollback-barrier-20261002/jsonl.js',import.meta.url),'utf8')
const persistenceSource=readFileSync(new URL('../../../tmp/rollback-barrier-20261002/persistence.js',import.meta.url),'utf8')
const start=persistenceSource.indexOf('function assertContiguous(')
const contiguous=new Function(persistenceSource.slice(start,persistenceSource.indexOf('//#endregion',start))+';return assertContiguous')()
const handleSource=actual.slice(actual.indexOf('var JsonlSessionHandle = class {'),actual.indexOf('\n/**',actual.indexOf('var JsonlSessionHandle = class {')))
const Handle=new Function('materializeAppendBatch','assertContiguous','SessionReadOnlyError','SessionHandleClosedError','errorChain',handleSource+';return JsonlSessionHandle')(structuredClone,contiguous,Error,Error,String)
const backend=readFileSync(new URL('../index.js',import.meta.url),'utf8')
function method(name){
 const pattern=new RegExp('\\t(?:async )?'+name+'\\('),begin=backend.search(pattern),end=backend.indexOf('\n\t}',begin)+4
 assert.ok(begin>0 && end>begin,name)
 return new Function('assertRollbackSessionWritable','rollbackSchedulingBarrier','rewindRollbackHandles','SessionPersistenceNotFoundError','return ({'+backend.slice(begin,end)+'}).'+name)(assertRollbackSessionWritable,rollbackSchedulingBarrier,rewindRollbackHandles,Error)
}
const methods=Object.fromEntries(['guardTurnStart','persistBatch','truncateEvents','drainOpenHandles','rewindOpenHandles','setRollbackPending'].map(name=>[name,method(name)]))
const descriptor={version:3,mode:'continuable',provider:'fixture-original',label:'原创后台身份',agentProvider:'fixture',agentModel:'fixed'}
async function fixture(){
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-identity-barrier-'))
 const raw=readFileSync(new URL('../../../tmp/rollback-barrier-20261002/session.js',import.meta.url),'utf8').replace(/from "(@deepseek-ai\/[^\"]+)"/g,(_all,name)=>'from '+JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
 const file=path.join(root,'session.mjs');writeFileSync(file,raw,'utf8');const {Session}=await import(pathToFileURL(file).href)
 const main=Session.create('original-main'),child=Session.create('original-child',undefined,{version:3,id:'original-child',createdAt:Date.now(),origin:'subagent',parentSession:main.id,cwd:root,delegationDepth:1,isSeeded:false})
 function turn(s,n){s.append('turn/start',{turn:n});s.append('user/message',{id:'u'+n,role:'user',content:[{type:'text',text:'原创'+n}],source:{kind:'user'}},{surfaceOp:'append'});s.append('turn/end',{turn:n,reason:{kind:'completed'}})}
 turn(main,37);const mainKeep=main.seq;turn(main,38)
 child.append('session/end-seed',{});const childKeep=child.seq;turn(child,1);child.append('subagent/descriptor',descriptor)
 const archiveFile=path.join(root,'archive.db'),archive=new DatabaseSync(archiveFile)
 archive.exec('CREATE TABLE archive_head_fields(key TEXT PRIMARY KEY,value_json TEXT NOT NULL); CREATE TABLE archive_messages(message_index INTEGER PRIMARY KEY,message_json TEXT NOT NULL)')
 const pending={version:1,id:'original-intent',turn:38,cuts:[{sessionId:main.id,boundarySeq:mainKeep-1,role:null},{sessionId:child.id,boundarySeq:childKeep-1,role:'background'}]}
 const chat={id:'original-chat',sessionId:main.id,messages:[{turn:37,text:'原创第37轮'}],rollbackPending:pending,timeline:{branchId:'original-branch'}}
 archive.prepare('INSERT INTO archive_head_fields VALUES(?,?)').run('sessionId',JSON.stringify(main.id));archive.prepare('INSERT INTO archive_messages VALUES(0,?)').run(JSON.stringify(chat.messages[0]))
 const dbs=new Map(),handles=new Set();let writes=0
 for(const s of [main,child]){const db=new SqliteSessionDb(path.join(root,s.id+'.db'));db.materialize(s.header,s.inheritedEventCount,s.snapshotEvents());db.bindRollbackArchive(archiveFile);db.setRollbackPending(true);dbs.set(s.id,db)}
 archive.prepare('INSERT INTO archive_head_fields VALUES(?,?)').run('rollbackPending',JSON.stringify(pending))
 const store={openExisting:id=>dbs.get(id)}
 const persistence={...methods,assertWritable(){},store,tracker:{openHandles:handles},releaseHandle(){},bindRollbackArchive:async(id,file)=>dbs.get(id).bindRollbackArchive(file)}
 const realPersist=persistence.persistBatch;persistence.persistBatch=async(...args)=>{writes++;return realPersist.apply(persistence,args)}
 for(const s of [main,child])handles.add(new Handle(persistence,s.id,s.header,'write',{cursor:s.seq,materialized:true,inheritedEventCount:0},{release:async()=>{}}))
 const agents=new Map([[main.id,{session:main,phase:{kind:'idle',lastTurn:38}}],[child.id,{session:child,phase:{kind:'idle',lastTurn:1}}]])
 const registrations=new Map([['turnBoundary',{def:{key:'turnBoundary'},cells:new Map()}]])
 const projections={registrations,hydrate(s,_input,events){for(const reg of registrations.values())reg.cells.set(s,{observedSeq:events.at(-1)?.seq??-1})},stateOf:s=>({lastTurn:s.log.findLast(e=>e.type==='turn/end')?.data.turn??0})}
 let fail=false,rollbackSync
 chat._storageRevision=1
 for(const agent of agents.values())agent.inbox={nextTurn:[],nextStep:[]}
 projections.snapshot=s=>({asOfSeq:s.snapshotEvents().at(-1)?.seq??-1,values:{turnBoundary:projections.stateOf(s)}})
 installRollbackSync({get:()=>({controlState:{ctx:{sessionProjections:projections},jobsFor:()=>[],broadcast:()=>{}},history:{assistantStreams:new Map()}}),provide:(_key,value)=>{rollbackSync=value}})
 const args={chat,requestedTurn:38,availability:()=>{throw Error('既有意图不得重新选择回退轮')},readChat:async()=>structuredClone(chat),updateChat:async(_id,fn,metadata)=>{assert.equal(metadata.source,'rollback.complete');await fn(chat);archive.prepare("DELETE FROM archive_head_fields WHERE key='rollbackPending'").run()},chats:{rollbackArchivePath:()=>archiveFile,readSlice:async()=>({chat:{}}),update:async()=>{}},sessions:{get:id=>agents.get(id),flush:async s=>{await persistence.drainOpenHandles(s.id)}},persistence,services:{projections,projectionCache:{write:async()=>{}},tokenMeterProvider:()=>({states:new WeakMap()}),rollbackSyncProvider:()=>rollbackSync},quiesce:async()=>{},sideCleanup:async()=>{if(fail)throw Error('原创收尾故障')},view:async c=>({turn:c.messages.at(-1).turn}),readCard:async()=>({})}
 return {root,Session,main,child,mainKeep,childKeep,archive,dbs,handles,persistence,args,agents,writes:()=>writes,setFault:v=>{fail=v},async close(){for(const h of handles){if(h.batchTimer!==undefined)clearTimeout(h.batchTimer);await h.close()}for(const id of dbs.keys()){rollbackBarrier.delete(id);rollbackSchedulingBarrier.delete(id)}archive.close();for(const db of dbs.values())db.close();rmSync(root,{recursive:true,force:true})}}
}
test('完整回退屏障＋真实写句柄：身份与DELETE同事务，保37/不触发普通追加，重试无重复',async()=>{
 const f=await fixture()
 try{
  f.setFault(true);await assert.rejects(cleanRollback(f.args),/原创收尾故障/)
  assert.equal(f.writes(),0,'身份不经过普通persistBatch，屏障没有豁免')
  assert.equal(f.dbs.get(f.main.id).cursor(),f.mainKeep)
  const db=f.dbs.get(f.child.id);assert.equal(db.cursor(),f.childKeep+1);assert.equal(db.readAll().events.at(-1).type,'subagent/descriptor')
  assert.deepEqual(db.readAll().events.at(-1).data,descriptor);assert.deepEqual(f.child.snapshotEvents(),db.readAll().events)
  for(const h of f.handles){assert.equal(h.buffered.length,0);assert.equal(h.state.cursor,f.dbs.get(h.id).cursor())}
  await assert.rejects(f.persistence.persistBatch(f.child.header,[{seq:f.child.seq,type:'subagent/descriptor',time:3,data:descriptor}],true,0),/会话正在物理回退/)
  assert.throws(()=>db.appendBatch([{seq:f.child.seq,type:'turn/start',time:3,data:{turn:1}}]),/archive禁止Session追加事件/)
  f.setFault(false);const result=await cleanRollback({...f.args,chat:await f.args.readChat()})
  assert.equal(result.turn,37);assert.equal(f.agents.get(f.main.id).phase.lastTurn,37);assert.equal(f.agents.get(f.child.id).phase.lastTurn,0)
  assert.equal(db.db.prepare("SELECT count(*) n FROM events WHERE type='subagent/descriptor'").get().n,1)
  assert.equal(db.db.prepare("SELECT count(*) n FROM events WHERE type IN ('turn/start','turn/end','user/message')").get().n,0)
  assert.equal(f.archive.prepare("SELECT count(*) n FROM archive_head_fields WHERE key='rollbackPending'").get().n,0)
  for(const [id,s] of f.dbs){assert.equal(s.db.prepare("SELECT count(*) n FROM meta WHERE key='rollback_pending'").get().n,0);assert.equal(rollbackBarrier.has(id),false)}
 }finally{await f.close()}
})
test('冷恢复实际rc.2构造会生成end-seed：专用只读Session去未存后缀、不resume/append，既有意图仍完成',async()=>{
 const f=await fixture()
 try{
  f.agents.clear();let reads=0
  const begin=backend.indexOf('\tasync loadRollbackSession('),end=backend.indexOf('\n\t}',begin)+4
  const load=new Function('requireFrom','persistMod','rewindSessionMemory','SessionPersistenceNotFoundError','return ({'+backend.slice(begin,end)+'}).loadRollbackSession')(()=>({Session:f.Session}),{validateStoredEvents:requireHost('@deepseek-ai/dsh-session-persistence').validateStoredEvents},rewindSessionMemory,Error)
  // 冷恢复只走**已就绪的共享宿主补丁**（index.js 从 this[Symbol.for(...)] 取，拒绝用原生词汇猜测）。
  // 本用例先前漏了这一步接线 ⇒ 必然抛"缺少已就绪的酒馆宿主补丁"。这里按 cold-patch-restore.test.mjs
  // 的同形接法补上：补丁用真实 rc.2 构造器复建 Session（会追加未发布的 end-seed，由被测方法只在内存移除）。
  f.persistence[Symbol.for('dsh-tavern.host-session-patch.v1')]={serverReady:true,restoreStoredSession:stored=>
    // 走真实 rc.2 snapshot 构造器（seed 必须自 seq 0 连续；surfaceOp 等元数据随事件原样带上）。
    f.Session.fromRestore(stored.header.id,stored.events,stored.header,stored.inheritedEventCount??0)}
  f.persistence.loadRollbackSession=async function(id){reads++;const session=await load.call(this,id);assert.deepEqual(session.snapshotEvents(),f.dbs.get(id).readAll().events,'实际构造额外end-seed必须只在内存移除');return session}
  f.args.sessions.resume=()=>{throw Error('冷回退禁止Agent resume写入恢复标记')};f.args.sessions.flush=()=>{throw Error('冷Session不附着或flush')}
  const result=await cleanRollback(f.args);assert.equal(result.turn,37);assert.equal(reads,2);assert.equal(f.writes(),0)
  assert.equal(f.dbs.get(f.main.id).cursor(),f.mainKeep);assert.equal(f.dbs.get(f.child.id).cursor(),f.childKeep+1)
  assert.equal(f.dbs.get(f.child.id).readAll().events.filter(e=>e.type==='session/end-seed').length,1)
 }finally{await f.close()}
})
test('SQL原子身份保存拒绝伪造、普通业务、前台身份；插入故障回滚DELETE',async()=>{
 const f=await fixture()
 try{
  const db=f.dbs.get(f.child.id),before=db.readAll(),identity=before.events.at(-1)
  assert.throws(()=>db.truncateFrom(f.childKeep-1,{...identity,data:{...identity.data,label:'伪造'}}),/既有唯一/)
  assert.throws(()=>db.truncateFrom(f.childKeep-1,{...identity,type:'user/message'}),/既有唯一/)
  assert.throws(()=>f.dbs.get(f.main.id).truncateFrom(0,identity),/既有唯一/)
  db.db.exec("CREATE TRIGGER original_identity_fault BEFORE INSERT ON events WHEN NEW.type='subagent/descriptor' BEGIN SELECT RAISE(ABORT,'原创SQL故障'); END")
  assert.throws(()=>db.truncateFrom(f.childKeep-1,identity),/原创SQL故障/)
  assert.deepEqual(db.readAll(),before,'身份插入失败必须连DELETE一起回滚')
 }finally{await f.close()}
})
