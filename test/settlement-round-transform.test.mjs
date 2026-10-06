// 真作者timeline/coordinator/effect/persistence→真实临时SQLite，全部原创数据。
// 只核轮次绑定、完成写集与旧写拒绝；不访问真实档/日志/卡、不执行模型或服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {applySettlementRoundTransform} from '../deploy/settlement-round-transform.mjs'

const author=new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544/tavern-plugin/lib/domain/',import.meta.url)
const source=name=>readFileSync(new URL(name,author),'utf8')
const rewrite=code=>code.replace(/from '([.][^']+)'/g,(_all,name)=>'from '+JSON.stringify(new URL(name,author).href))
const load=code=>import('data:text/javascript;base64,'+Buffer.from(rewrite(code)).toString('base64'))
const rawTimeline=source('story-timeline.js'),patched=applySettlementRoundTransform(rawTimeline)
const {createStoryTimeline}=await load(patched)
const {createBackgroundTaskCoordinator}=await load(source('background-task-coordinator.js'))
const {createMvuSettlementEffect,applyMvuSettlementEffect}=await load(source('mvu-settlement-effect.js'))
const displayImport="import { projectSceneImageState, projectDisplayRuntimeState, projectChatBackgroundConfig } from './chat-session-state.js'"
const persistenceSource=source('chat-persistence.js')
assert.ok(persistenceSource.includes(displayImport),'显示投影import改变，拒绝盲改夹具')
const {createChatPersistence}=await load(persistenceSource.replace(displayImport,"const projectSceneImageState=()=>{throw Error('本闸不使用显示投影')}, projectDisplayRuntimeState=projectSceneImageState, projectChatBackgroundConfig=projectSceneImageState"))
const mutation=await import(new URL('json-mutation.js',author))
const {copyJsonTree}=await import(new URL('copy-json-tree.js',author))
const ROUND='body-round',OLD='settlement-old'
function baseChat(id){
  return {id,sessionId:'synthetic-session',mode:'story',tavernHelperLifecycleRevision:0,settleStatus:'idle',settleError:null,
    messages:Array.from({length:12},(_,i)=>({role:'assistant',turn:i+1,swipeId:0,text:'原创正文'+i,swipes:['原创正文'+i],variables:[{stat_data:{hp:10},schema:{}}],mvu:{pending:true}})),
    timeline:{schemaVersion:1,branchId:'branch-a',revision:1,operations:{},checkpoints:[],participants:{}}}
}
function oldBody(){return {id:ROUND,kind:'body',role:'body',status:'completed',turn:12,basedOn:{branchId:'branch-a',revision:0},createdAt:1,completedAt:2,committedBranchId:'branch-a',committedRevision:1,background:{phase:'failed',role:'settlement',updatedAt:2}}}
function effectFor(task,before){
  const after=structuredClone(before);after.messages[11].variables[0].stat_data.hp=9
  return createMvuSettlementEffect({operationId:task.operationId,chatId:before.id,sessionId:before.sessionId,branchId:before.timeline.branchId,basedOnRevision:before.timeline.revision,expectedLifecycleRevision:0,messageId:11,swipeId:0,before,after,messageIndices:[11],guardChanges:true})
}
const commit=(task,effect,extra)=>task.commit({messageIndices:[11],stateChanged:true,apply(draft,scope){applyMvuSettlementEffect(draft,effect,scope);extra?.(draft,scope)}})
async function fixture(run){
  const root=path.resolve(mkdtempSync(path.join(os.tmpdir(),'settle-round-test-')))
  const helpers={copyJsonTree,...mutation}
  for(const name of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[name]=()=>{throw Error('本闸不使用显示投影')}
  const store=createChatSqliteStore({dataRoot:root,helpers,now:()=>10}),id='synthetic'
  let db
  try{
    await store.update(id,()=>baseChat(id))
    db=new DatabaseSync(path.join(root,'chats',id,'archive.db'))
    const persistence=createChatPersistence({store,now:()=>10})
    let sequence=0
    const timeline=createStoryTimeline({now:()=>10,id:prefix=>prefix+'-'+(++sequence)})
    const coordinator=createBackgroundTaskCoordinator({timeline,store:{readChat:persistence.read,writeChat:persistence.write,readSlice:persistence.readSlice,patchChat:persistence.patch,updateChat:persistence.update}})
    const chat=()=>persistence.read(id)
    const sqlRevision=()=>db.prepare('SELECT revision FROM archive_head WHERE id=1').get().revision
    const sqlRow=()=>JSON.parse(db.prepare('SELECT message_json FROM archive_messages WHERE message_index=11').get().message_json)
    const sqlHead=key=>JSON.parse(db.prepare('SELECT value_json FROM archive_head_fields WHERE key=?').get(key).value_json)
    const seedBody=async()=>{
      // body.begin/complete才创建正文；coordinator.begin(role='body')只是agent，不能替代。
      const begun=timeline.apply({chat:await chat(),intent:{kind:'body.begin',turn:12,userText:'原创输入'}})
      const done=timeline.complete({chat:begun.chat,operationId:begun.value.operationId,basedOn:begun.value.basedOn,outcome:{status:'success'}})
      assert.equal(done.value.status,'committed')
      await persistence.write(done.chat)
      return begun.value.operationId
    }
    await run({id,persistence,timeline,coordinator,chat,sqlRevision,sqlRow,sqlHead,seedBody})
  }finally{
    db?.close();store.dispose()
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('settle-round-test-'))
    rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:30})
  }
}

test('轮次转换幂等，缺锚/重复锚/半标记失败关闭',()=>{
  const marker='// [dsh-tavern-settlement-round:v1]'
  assert.notEqual(patched,rawTimeline)
  assert.equal(applySettlementRoundTransform(patched),patched)
  assert.throws(()=>applySettlementRoundTransform(rawTimeline.replace('pendingSettlementBody(chat)','renamedBody(chat)')),/锚点/)
  assert.throws(()=>applySettlementRoundTransform(rawTimeline+'\nfunction pendingSettlementBody(chat) {}'),/不唯一/)
  assert.throws(()=>applySettlementRoundTransform(marker+'\n'),/锚点|标记/)
  assert.throws(()=>applySettlementRoundTransform(patched.replace('Number(latest.committedRevision) === Number(chat.timeline.revision)','false')),/标记存在但正文不完整/)
  // 代码改动只在选择函数；complete的全部护栏和apply出口逐字保留。
  assert.equal(patched.slice(patched.indexOf('  function complete(input)')),rawTimeline.slice(rawTimeline.indexOf('  function complete(input)')))
})

test('同版本正常正文仍绑定round，结算提交不额外推进正文版本',async()=>fixture(async({coordinator,chat,sqlRow,sqlRevision,seedBody})=>{
  const bodyId=await seedBody(),current=await chat()
  assert.equal(current.timeline.operations[bodyId].kind,'body')
  assert.equal(current.timeline.operations[bodyId].committedRevision,current.timeline.revision)
  const task=await coordinator.begin(current,'settlement',{reuseSnapshot:true})
  const before=await chat(),storageBefore=sqlRevision()
  assert.equal(before.timeline.operations[task.operationId].roundOperationId,bodyId)
  const done=await commit(task,effectFor(task,before))
  assert.equal(done.status,'committed')
  const saved=await chat()
  assert.equal(saved.timeline.revision,current.timeline.revision)
  assert.equal(saved.timeline.operations[bodyId].background.phase,'completed')
  assert.equal(saved.timeline.operations[task.operationId].status,'completed')
  assert.equal(sqlRow().variables[0].stat_data.hp,9)
  assert.ok(sqlRevision()>storageBefore,'SQL存储版本与剧情版本是两个概念')
}))

test('错配孤儿经官方恢复，新重试不绑旧round；变量/receipt/pending/head/任务同帧落SQL',async()=>fixture(async({id,persistence,timeline,coordinator,chat,sqlRow,sqlHead,sqlRevision})=>{
  await persistence.update(id,draft=>{
    draft.timeline.revision=2;draft.timeline.operations[ROUND]=oldBody()
    draft.timeline.operations[OLD]={id:OLD,kind:'agent',role:'settlement',status:'stale',basedOn:{branchId:'branch-a',revision:2},roundOperationId:ROUND,createdAt:3}
    draft.timeline.operations[ROUND].background.phase='running'
    return draft
  })
  await persistence.update(id,draft=>timeline.apply({chat:draft,intent:{kind:'background.recover'}}).chat)
  assert.equal((await chat()).timeline.operations[ROUND].background.phase,'failed')
  const task=await coordinator.begin(await chat(),'settlement',{reuseSnapshot:true}),before=await chat()
  assert.equal(before.timeline.operations[task.operationId].roundOperationId,undefined)
  assert.equal(task.basedOn.revision,2)
  const storageBefore=sqlRevision()
  const done=await commit(task,effectFor(task,before),draft=>{
    draft.messages[11].mvu={pending:false,modified:true,receipt:{version:1,status:'updated'}}
    draft.settleStatus='done';draft.settleError=null;draft.lastSettle={raw:'原创合成结果'}
  })
  assert.equal(done.status,'committed')
  const saved=await chat(),row=sqlRow()
  assert.equal(row.variables[0].stat_data.hp,9)
  assert.equal(row.mvu.pending,false);assert.equal(row.mvu.receipt.status,'updated')
  assert.equal(sqlHead('settleStatus'),'done');assert.equal(sqlHead('settleError'),null)
  assert.equal(saved.timeline.operations[task.operationId].status,'completed')
  assert.equal(saved.timeline.revision,3)
  assert.equal(saved.timeline.operations[ROUND].committedRevision,1,'不伪修历史正文版本')
  assert.equal(saved.timeline.operations[ROUND].background.phase,'completed')
  assert.equal(saved.timeline.operations[OLD].status,'stale','不解除旧任务错误绑定或伪修旧结果')
  assert.ok(sqlRevision()>storageBefore)
}))

for(const field of ['revision','branchId'])test('开始后'+field+'变化，旧结果仍stale且不部分写业务',async()=>fixture(async({id,persistence,coordinator,chat,sqlRow,sqlHead,sqlRevision,seedBody})=>{
  await seedBody()
  const task=await coordinator.begin(await chat(),'settlement',{reuseSnapshot:true}),before=await chat(),effect=effectFor(task,before)
  await persistence.update(id,draft=>{if(field==='revision')draft.timeline.revision++;else draft.timeline.branchId='other-branch';return draft})
  const storageBefore=sqlRevision(),current=await chat()
  let applied=0
  const done=await commit(task,effect,()=>{applied++})
  assert.equal(done.status,'stale');assert.equal(applied,0)
  const saved=await chat()
  assert.equal(saved.timeline.operations[task.operationId].status,'stale')
  assert.equal(saved.timeline.revision,current.timeline.revision);assert.equal(saved.timeline.branchId,current.timeline.branchId)
  assert.equal(sqlRow().variables[0].stat_data.hp,10);assert.equal(sqlRow().mvu.pending,true)
  assert.equal(sqlHead('settleStatus'),'idle')
  assert.ok(sqlRevision()>storageBefore,'拒绝结果的stale状态本身需落库，不要求SQLhead完全不变')
}))

test('已绑定错版本旧operation仍被第二道round护栏拒绝',async()=>fixture(async({id,persistence,coordinator,chat,sqlRow})=>{
  await persistence.update(id,draft=>{
    draft.timeline.revision=2;draft.timeline.operations[ROUND]=oldBody()
    draft.timeline.operations[OLD]={id:OLD,kind:'agent',role:'settlement',status:'running',requestId:'old-request',basedOn:{branchId:'branch-a',revision:2},createdAt:3,roundOperationId:ROUND}
    return draft
  })
  const before=await chat(),task=await coordinator.begin(before,'settlement',{reuseSnapshot:true,requestId:'old-request'})
  assert.equal(task.operationId,OLD)
  assert.equal((await chat()).timeline.operations[OLD].roundOperationId,ROUND)
  let applied=0
  const done=await commit(task,effectFor(task,before),()=>{applied++})
  assert.equal(done.status,'stale');assert.equal(applied,0)
  assert.equal((await chat()).timeline.operations[OLD].status,'stale')
  assert.equal(sqlRow().variables[0].stat_data.hp,10);assert.equal(sqlRow().mvu.pending,true)
}))

test('effect身份/lifecycle/swipe/字段预期冲突拒绝，SQL事务无部分写',async()=>fixture(async({coordinator,chat,sqlRow,sqlRevision,seedBody})=>{
  await seedBody()
  const task=await coordinator.begin(await chat(),'settlement',{reuseSnapshot:true}),before=await chat(),effect=effectFor(task,before)
  const cases=[{...effect,sessionId:'other'},{...effect,branchId:'other'},{...effect,basedOnRevision:effect.basedOnRevision+1},{...effect,expectedLifecycleRevision:1},{...effect,swipeId:1},{...effect,expected:effect.expected.map(()=>({present:false}))}]
  for(const invalid of cases){
    const storageBefore=sqlRevision()
    await assert.rejects(()=>commit(task,invalid),/已变化|目标字段/)
    assert.equal(sqlRevision(),storageBefore)
    assert.equal(sqlRow().variables[0].stat_data.hp,10);assert.equal(sqlRow().mvu.pending,true)
    assert.equal((await chat()).timeline.operations[task.operationId].status,'running')
  }
}))
