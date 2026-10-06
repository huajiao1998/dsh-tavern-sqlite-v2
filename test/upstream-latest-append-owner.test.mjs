// 最新作者finalizeAppend→真实persistence→SQLite；只用自有合成库，不请求模型/真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { applyRollbackBodyCommitTurnTransform } from '../deploy/rollback-body-commit-transform.mjs'
const testRequire=createRequire(new URL('../../../tools/sql-test-kit/package.json',import.meta.url))
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){
 if(error.code!=='ERR_MODULE_NOT_FOUND'||!context.parentURL?.includes('/upstream25-author-fixture/')||specifier.startsWith('.')||specifier.startsWith('node:'))throw error
 return next(pathToFileURL(testRequire.resolve(specifier)).href,context)
}}})
const author=new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5c69907994df9f432b8898168ce5dff371929c2a/tavern-plugin/lib/domain/',import.meta.url)
const [copy,mutation,persistence,story]=await Promise.all(['copy-json-tree.js','json-mutation.js','chat-persistence.js','story-timeline.js'].map(file=>import(new URL(file,author))))
// 卡片记忆工具不在正文append路径；只复用真实常量，避免载入本闸未安装的Mnemon服务依赖。
const memorySource=readFileSync(new URL('../../packages/dsh-tavern-card-memory/index.js',author),'utf8')
const memoryConstant=memorySource.split('\n').find(line=>line.startsWith('export const CARD_MEMORY_TOOLS = '))
assert.ok(memoryConstant)
const memoryImport="import { CARD_MEMORY_TOOLS } from '../../packages/dsh-tavern-card-memory/index.js'"
let turnSource=readFileSync(new URL('turn-orchestration.js',author),'utf8');assert.equal(turnSource.split(memoryImport).length,2)
turnSource=turnSource.replace(memoryImport,memoryConstant.replace('export const','const'))
const source=applyRollbackBodyCommitTurnTransform(turnSource).replace(/from '(\.[^']+)'/g,(_,name)=>'from '+JSON.stringify(new URL(name,author).href))
const {createTurnOrchestrator}=await import('data:text/javascript;base64,'+Buffer.from(source,'utf8').toString('base64'))
async function fixture(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-latest-append-')),helpers={...copy,...mutation}
 for(const name of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[name]=value=>value===undefined?undefined:structuredClone(value)
 const store=createChatSqliteStore({dataRoot:root,helpers}),id='synthetic-append'
 t.after(()=>{store.dispose();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('tavern-latest-append-'));rmSync(root,{recursive:true,force:true})})
 let seq=0;const timeline=story.createStoryTimeline({now:()=>10,id:prefix=>prefix+'-'+(++seq)})
 let chat={id,sessionId:'synthetic-session',mode:'story',_storageRevision:1,messages:[{role:'user',text:'前轮输入'},{role:'assistant',turn:1,text:'前轮正文'}]}
 chat=timeline.apply({chat,intent:{kind:'body.begin',turn:2,userText:'新输入'}}).chat
 const op=Object.values(chat.timeline.operations).find(op=>op.kind==='body')
 await store.update(id,()=>chat)
 const records=persistence.createChatPersistence({store,now:()=>11})
 const counts={slice:0,patch:0,full:0,update:0};let beforePatch
 const facade={
  readChatSlice:async(_session,indices,fields)=>{counts.slice++;return records.readSlice(id,indices,fields)},
  chatForSession:async()=>{counts.full++;return records.read(id)},
  patchChat:async(...args)=>{counts.patch++;await beforePatch?.();return records.patch(...args)},
  updateChat:async(...args)=>{counts.update++;return records.update(...args)},
 }
 const orchestrator=createTurnOrchestrator({store:facade,timeline,frameBuilder:{build(){}},now:()=>10,
  projectReply:text=>({sourceText:text,projectionText:text,sessionText:text,displayText:text,warnings:[]})})
 const input={sessionId:chat.sessionId,turn:2,userText:'新输入',assistantText:'新正文',requestId:'synthetic-request',rollbackBodyOwner:{chatId:id,sessionId:chat.sessionId,turn:2,branchId:chat.timeline.branchId,operationId:op.id}}
 return {store,id,records,counts,orchestrator,input,beforePatch:fn=>{beforePatch=fn}}
}
test('最新finalizeAppend实际消费者：缺失/错owner与rollbackPending均零提交，未落入旧update路径',async t=>{
 const f=await fixture(t),baseline=await f.records.read(f.id)
 for(const input of [{...f.input,rollbackBodyOwner:undefined},{...f.input,rollbackBodyOwner:{...f.input.rollbackBodyOwner,branchId:'wrong'}},{...f.input,rollbackBodyOwner:{...f.input.rollbackBodyOwner,operationId:'wrong'}},{...f.input,rollbackBodyOwner:{...f.input.rollbackBodyOwner,sessionId:'wrong'}}]){
  assert.deepEqual(await f.orchestrator.finalize(input),{saved:false,reason:'stale-body-owner'})
  assert.equal(f.counts.patch,0);assert.equal(f.counts.full,0);assert.equal(f.counts.update,0);assert.deepEqual(await f.records.read(f.id),baseline)
 }
 await f.store.update(f.id,current=>({...current,_storageRevision:2,rollbackPending:{version:1,id:'synthetic-pending',cuts:[]}}),{source:'rollback.prepare'})
 assert.deepEqual(await f.orchestrator.finalize(f.input),{saved:false,reason:'stale-body-owner'})
 assert.equal(f.counts.patch,0);assert.equal(f.counts.full,0);assert.equal(f.counts.update,0)
})
test('最新finalizeAppend合法消费者：一次patch原子追加正文与完成字段，不整档update',async t=>{
 const f=await fixture(t),result=await f.orchestrator.finalize(f.input)
 assert.equal(result.saved,true);assert.equal(f.counts.patch,1);assert.equal(f.counts.full,0);assert.equal(f.counts.update,0)
 const saved=await f.records.read(f.id)
 assert.equal(saved.messages.length,4);assert.equal(saved.messages.at(-1).text,'新正文');assert.equal(saved.messages[0].text,'前轮输入')
 assert.equal(saved._storageRevision,2);assert.equal(saved.nativeCommits['2'].requestId,'synthetic-request');assert.equal(saved.settleStatus,'pending')
 assert.ok(['completed','foreground-completed'].includes(saved.timeline.operations[f.input.rollbackBodyOwner.operationId].status))
})
test('最新append CAS重试：异步准备后换branch使旧patch失败，重读拒旧owner且不覆盖新态',async t=>{
 const f=await fixture(t)
 f.beforePatch(async()=>{f.beforePatch(undefined);await f.store.update(f.id,current=>({...current,_storageRevision:2,timeline:{...current.timeline,branchId:'synthetic-new-branch'}}))})
 const result=await f.orchestrator.finalize(f.input)
 assert.deepEqual(result,{saved:false,reason:'stale-body-owner'});assert.equal(f.counts.patch,1);assert.equal(f.counts.full,0);assert.equal(f.counts.update,0)
 const saved=await f.records.read(f.id)
 assert.equal(saved._storageRevision,2);assert.equal(saved.timeline.branchId,'synthetic-new-branch');assert.equal(saved.messages.length,2);assert.equal(saved.nativeCommits?.['2'],undefined)
})
