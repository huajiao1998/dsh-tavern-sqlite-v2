// R2目标生产者：真作者完整view经真实接缝，验证window/current/pending/failure身份，不仿写目标选择。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {registerHooks,createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {applyRollbackPendingViewTransform} from '../deploy/rollback-pending-view-transform.mjs'
import {applyLatestFailureViewTransform} from '../deploy/latest-failure-transform.mjs'
import {applyLatestSendViewTransform} from '../deploy/latest-send-view-transform.mjs'
const AUTHOR=new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/domain/',import.meta.url)
registerHooks({resolve(spec,context,next){
 if(spec==='./tavern-macro-engine.js')return {url:'target-view-unused:macro',shortCircuit:true}
 if(['jsdom','marked'].includes(spec))return {url:'target-view-unused:display',shortCircuit:true}
 return next(spec,context)
},load(url,context,next){
 if(url==='target-view-unused:macro')return {format:'module',source:"export const renderTavernMacros=()=>{throw Error('不调用宏渲染')}",shortCircuit:true}
 if(url==='target-view-unused:display')return {format:'module',source:"const no=()=>{throw Error('不调用DOM')};export const JSDOM=no,marked=no,VirtualConsole=no",shortCircuit:true}
 return next(url,context)
}})
test('R2普通目标视图：真作者cold与window签原凭据，pending保留原目标，failure不混普通目标',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-ordinary-target-'))
 try{
  const inspector=new URL('../lib/failure-cleanup-target.js',import.meta.url).href
  const shim=path.join(root,'storage-rollback.mjs');writeFileSync(shim,`export {inspectNativeFailureTail} from ${JSON.stringify(inspector)}\nexport {latestSendTarget} from ${JSON.stringify(new URL('../lib/latest-send.js',import.meta.url).href)}\n`,'utf8')
  const source=applyLatestSendViewTransform(applyLatestFailureViewTransform(applyRollbackPendingViewTransform(readFileSync(new URL('chat-session-state.js',AUTHOR),'utf8'))))
  const output=source.replace(/from '(.+?)'/g,(_all,spec)=>'from '+JSON.stringify(spec==='./storage-rollback.js'?pathToFileURL(shim).href:new URL(spec,AUTHOR).href))
  const file=path.join(root,'session-view.mjs');writeFileSync(file,output,'utf8')
  const {createSessionStateView}=await import(pathToFileURL(file).href)
  const chat={id:'chat-ordinary-view',sessionId:'session-ordinary-view',_storageRevision:7,mode:'story',messages:[{role:'user',turn:52,text:'输入52'},{role:'assistant',turn:52,text:'正文52'}],timeline:{schemaVersion:1,branchId:'branch-view',revision:52,checkpoints:[],operations:{},participants:{}}}
  const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT||'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
  const {Session}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session')).href)
  const session=Session.create(chat.sessionId)
  session.append('turn/start',{turn:52})
  session.append('user/message',{id:'u52',role:'user',source:{kind:'user'},content:[{type:'text',text:'输入52'}]},{surfaceOp:'append'})
  session.append('assistant/message',{turn:52,step:1,message:{id:'a52',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'正文52'}]},stream:[]},{surfaceOp:'append'})
  session.append('turn/end',{turn:52,reason:{kind:'completed'}})
  const evidence={sessionId:chat.sessionId,loaded:true,session:null,header:session.header,events:session.snapshotEvents(),nodes:[...session.surface.nodes]}
  const view=createSessionStateView({activity:()=>undefined,evidence:()=>evidence})
  const target={kind:'rollback',turn:52,chatId:chat.id,sessionId:chat.sessionId,branchId:'branch-view',revision:7,nativeAnchor:{turn:52,input:1,reply:null}}
  assert.deepEqual(view.rollback(chat,evidence).rollbackTarget,target)
  const window={...chat,_storageRevision:undefined,windowRevision:9}
  assert.deepEqual(view.rollback(window,evidence).rollbackTarget,{...target,revision:9})
  const pending={...chat,_storageRevision:10,messages:[],rollbackPending:{version:1,id:'rollback-owned',turn:52,cuts:[],ordinaryTarget:target}}
  const fields=view.rollback(pending,evidence)
  assert.equal(fields.canRollback,true);assert.equal(fields.rollbackPending,true);assert.equal(fields.canClearIncompleteReply,false)
  assert.deepEqual(fields.rollbackTarget,{...target,rollbackId:'rollback-owned'},'pending沿原turn及持久id')
  const failureTarget={chatId:chat.id,sessionId:chat.sessionId,turn:53,operationId:'failed-body',branchId:'branch-view',revision:10}
  const failure={...pending,rollbackPending:{...pending.rollbackPending,ordinaryTarget:undefined,turn:53,failureTarget}}
  const failed=view.rollback(failure,evidence)
  assert.equal(failed.canClearIncompleteReply,false);assert.equal(failed.rollbackTarget.turn,53,'失败pending也只签统一目标');assert.equal(failed.rollbackTarget.rollbackId,'rollback-owned')
 }finally{assert.ok(path.basename(root).startsWith('rollback-ordinary-target-'));rmSync(root,{recursive:true,force:true})}
})
