// 真作者2.5 effect/coordinator/persistence → V2 SQLite，不直接patch冒充结算消费者。
// 不调用模型/真实档；未使用的显示投影只在夹具中明确拒绝，不代表页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,readdirSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
const author=new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/',import.meta.url)
const mutation=await import(new URL('json-mutation.js',author)),{copyJsonTree}=await import(new URL('copy-json-tree.js',author))
const {createStoryTimeline}=await import(new URL('story-timeline.js',author))
const {createBackgroundTaskCoordinator}=await import(new URL('background-task-coordinator.js',author))
const {createMvuSettlementEffect,applyMvuSettlementEffect}=await import(new URL('mvu-settlement-effect.js',author))
// Persistence显示投影导入带DOM依赖；这个纯写口夹具不走它，明确替身只替换该import。
let persistenceSource=readFileSync(new URL('chat-persistence.js',author),'utf8')
const displayImport="import { projectSceneImageState, projectDisplayRuntimeState, projectChatBackgroundConfig } from './chat-session-state.js'"
assert.ok(persistenceSource.includes(displayImport))
persistenceSource=persistenceSource.replace(displayImport,"const projectSceneImageState=()=>{throw Error('本闸不使用显示投影')}, projectDisplayRuntimeState=projectSceneImageState, projectChatBackgroundConfig=projectSceneImageState")
persistenceSource=persistenceSource.replace(/from '([.][^']+)'/g,(_all,name)=>'from '+JSON.stringify(new URL(name,author).href))
const {createChatPersistence}=await import('data:text/javascript;base64,'+Buffer.from(persistenceSource).toString('base64'))
const baseline=()=>({version:1,fields:{openingWorldbookSnapshot:{version:1,document:{entries:[{uid:0,content:'原创合成世界书'}]}}}})
async function fixture(run){
 const root=path.resolve(mkdtempSync(path.join(os.tmpdir(),'kws-consumer-test-'))),counts={patch:0,update:0,rootDiff:0}
 const helpers={copyJsonTree,applyJsonChangesShared:mutation.applyJsonChangesShared,
  diffJson:(a,b)=>{if(Array.isArray(a?.messages))counts.rootDiff++;return mutation.diffJson(a,b)}}
 for(const name of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[name]=()=>{throw Error('未使用的显示投影')}
 const store=createChatSqliteStore({dataRoot:root,helpers,now:()=>10}),id='synthetic'
 let db
 try{
  await store.update(id,()=>({id,sessionId:'session',_storageRevision:1,mode:'story',tavernHelperLifecycleRevision:0,
   messages:Array.from({length:12},(_,i)=>({role:'assistant',turn:i+1,swipeId:0,text:'原创'+i,swipes:['原创'+i],variables:[{stat_data:{hp:10},schema:{}}]})),
   timeline:{schemaVersion:1,branchId:'b',revision:1,operations:{},checkpoints:[],participants:{}}}))
  db=new DatabaseSync(path.join(root,'chats',id,'archive.db'))
  const persistence=createChatPersistence({store,now:()=>10})
  const facade={readChat:persistence.read,writeChat:persistence.write,readSlice:persistence.readSlice,
   patchChat:(...args)=>{counts.patch++;return persistence.patch(...args)},updateChat:(...args)=>{counts.update++;return persistence.update(...args)}}
  let sequence=0;const timeline=createStoryTimeline({now:()=>10,id:prefix=>prefix+'-'+(++sequence)})
  const coordinator=createBackgroundTaskCoordinator({store:facade,timeline})
  const task=await coordinator.begin(await persistence.read(id),'settlement',{reuseSnapshot:true})
  const before=await persistence.read(id),after=copyJsonTree(before);after.messages[11].variables[0].stat_data.hp=9
  const effect=createMvuSettlementEffect({operationId:task.operationId,chatId:id,sessionId:'session',branchId:'b',basedOnRevision:1,expectedLifecycleRevision:0,messageId:11,swipeId:0,before,after,messageIndices:[11],guardChanges:true})
  Object.assign(counts,{patch:0,update:0,rootDiff:0})
  await run({store,db,persistence,task,before,effect,counts,id})
 }finally{db?.close();store.dispose();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('kws-consumer-test-'));readdirSync(root,{recursive:true});rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30})}
}
test('真实结算完成一次patch，内联基准整理无全根diff；完整receipt/状态/时间线同事务落库',async()=>fixture(async({store,db,persistence,task,before,effect,counts,id})=>{
 const completed=await task.commit({messageIndices:[11],stateChanged:true,apply(draft,scope){
  applyMvuSettlementEffect(draft,effect,scope)
  draft.messages[11].mvu={pending:false,receipt:{status:'updated'}};draft.settleStatus='done';draft.lastSettle={raw:'合成结果'}
  draft.timeline.operations[task.operationId].businessBefore=baseline()
 }})
 assert.equal(completed.status,'committed');assert.deepEqual(counts,{patch:1,update:0,rootDiff:0})
 const saved=await persistence.read(id)
 assert.equal(saved.messages[11].variables[0].stat_data.hp,9);assert.equal(saved.messages[11].mvu.receipt.status,'updated')
 assert.equal(saved.settleStatus,'done');assert.equal(saved.lastSettle.raw,'合成结果')
 assert.equal(saved.timeline.operations[task.operationId].status,'completed');assert.ok(saved.timeline.operations[task.operationId].businessBefore.worldbookRef)
 assert.equal(saved.messages[0].text,'原创0');assert.equal(before.messages[11].variables[0].stat_data.hp,10)
 assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_worldbook_history').get().n,1)
 const delta=await store.readChangedSlice(id,before._storageRevision)
 assert.deepEqual(delta.indices,[11]);assert.ok(delta.changedHeaderFields.includes('timeline'));assert.ok(delta.changedHeaderFields.includes('settleStatus'))
}))
test('结算effect身份、生命周期、swipe、branch或未声明楼失效仍拒绝且不部分提交',async()=>fixture(async({store,db,persistence,task,before,effect,id})=>{
 for(const mutate of [c=>c.sessionId='other',c=>c.timeline.branchId='other',c=>c.tavernHelperLifecycleRevision=1,c=>c.messages[11].swipeId=1]){
  const draft=copyJsonTree(before);mutate(draft);const unchanged=copyJsonTree(draft)
  assert.throws(()=>applyMvuSettlementEffect(draft,effect,{messageIndices:[11]}));assert.deepEqual(draft,unchanged)
 }
 const revision=db.prepare('SELECT revision FROM archive_head').get().revision
 const invalid={...effect,changes:[...effect.changes,{op:'set',path:['messages',0,'text'],value:'不得写入'}]};delete invalid.expected
 await assert.rejects(()=>task.commit({messageIndices:[11],stateChanged:true,apply:(draft,scope)=>applyMvuSettlementEffect(draft,invalid,scope)}),/undeclared/)
 assert.equal(db.prepare('SELECT revision FROM archive_head').get().revision,revision)
 const saved=await persistence.read(id);assert.equal(saved.messages[0].text,'原创0');assert.equal(saved.messages[11].variables[0].stat_data.hp,10)
 assert.deepEqual((await store.readChangedIndices(id,before._storageRevision)).indices,[])
}))
