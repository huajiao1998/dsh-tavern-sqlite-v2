// 真实作者修复写口→Session.append→生产captureAcceptedSend→真实SQLite前像注册。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {installSendAcceptance} from '../lib/send-acceptance.js'
import {invalidateLinkMap} from '../lib/tavern-chat-state.js'
import {rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
const AUTHOR=new URL('../../../tmp/upstream-79d3414-adapt-20261017/tavern-plugin/lib/domain/',import.meta.url)
const {createSessionSurfaceMutator}=await import(new URL('session-surface-mutations.js',AUTHOR).href)
const {copyJsonTree}=await import(new URL('copy-json-tree.js',AUTHOR).href)
const {diffJson,applyJsonChangesShared}=await import(new URL('json-mutation.js',AUTHOR).href)
const helpers={copyJsonTree,diffJson,applyJsonChangesShared}
for(const key of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[key]=v=>v

test('作者修复输入：真实mutator经过生产捕获时SQL无新body且原生照常追加',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-repair-capture-')),oldHome=process.env.DSH_HOME
 let store,uninstall
 try {
  const home=path.join(root,'home'),dataRoot=path.join(root,'data')
  mkdirSync(path.join(home,'profiles','tavern'),{recursive:true});mkdirSync(dataRoot)
  writeFileSync(path.join(home,'profiles','tavern','package.json'),JSON.stringify({dshTavern:{dataRoot}}),'utf8')
  const sessionId='session-repair-capture',chatId='chat-repair-capture'
  writeFileSync(path.join(dataRoot,'sessions.json'),JSON.stringify({[sessionId]:chatId}),'utf8')
  process.env.DSH_HOME=home;invalidateLinkMap()
  store=createChatSqliteStore({dataRoot,helpers})
  await store.update(chatId,()=>({id:chatId,sessionId,_storageRevision:1,mode:'story',messages:[],timeline:{schemaVersion:1,branchId:'branch',revision:1,operations:{},participants:{},checkpoints:[]}}))
  class Session {
   constructor(){this.id=sessionId;this.events=[];this.header={id:sessionId,version:3}}
   get seq(){return this.events.length}
   snapshotEvents(){return this.events.slice()}
   append(type,data,intent){const event={seq:this.seq,type,data,...intent};this.events.push(event);return event}
  }
  const session=new Session();uninstall=installSendAcceptance(Session)
  session.append('turn/start',{turn:1})
  const before=await store.read(chatId),ids=Object.keys(before.timeline.operations)
  assert.equal(ids.length,1,'真实新发送必须先在SQLite保存前像，非空绕过的假证明')
  rollbackSchedulingBarrier.add(sessionId)
  const repaired={id:'repair-user',role:'user',content:[{type:'text',text:'保留历史输入'}],source:{kind:'user',repair:{id:'native-repair'}}}
  createSessionSurfaceMutator(session).append('user/message',repaired,{surfaceOp:'append'})
  const after=await store.read(chatId)
  assert.deepEqual(after,before,'修复输入不能写入旧body的用户锚点或新增操作/版本')
  assert.equal(session.events.at(-1).data.id,'repair-user','修复的原生写入必须确实执行')
  rollbackSchedulingBarrier.delete(sessionId)
  session.append('user/message',{...repaired,id:'real-user',source:{kind:'user'}},{surfaceOp:'append'})
  const accepted=await store.read(chatId)
  assert.equal(accepted.timeline.operations[ids[0]].nativeAnchor.input,session.seq-1,'真实用户消息仍补原生输入锚点')
 } finally {
  uninstall?.();rollbackSchedulingBarrier.delete('session-repair-capture');store?.dispose()
  if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome
  invalidateLinkMap();rmSync(root,{recursive:true,force:true})
 }
})
