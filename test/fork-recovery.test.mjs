// 真实SQLite冻结记录 + 原创业务消费者；不连接Host/模型、不创建真实分叉。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createForkRecords} from '../lib/legacy-fork-records.js'
import {createLegacySaveActions} from '../lib/legacy-view-seams.js'
import {describeSaveFormat,formatSaveResult} from '../lib/migration-ops.js'
test('全新service恢复持久bound同SID且token不出状态；claimed/错SID拒绝不清记录',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'fork-recovery-owned-')),prior=process.env.DSH_HOME;process.env.DSH_HOME=dir
 try {
  const records=createForkRecords(),source='chat-source',sid='session-source',target='session-target',calls=[]
  const claimed=records.claim({sourceChatId:source,sourceSessionId:sid,sourceRevision:7,turn:2,atSeq:8,targetTitle:'DB.原创'})
  const chats={version:async id=>id===source?'legacy:1:2':'sqlite:gen:1',read:async()=>{throw Error('本闸不读正文')}}
  const deps={chats,resolveChatId:async id=>id===sid?source:'',forkRecords:records,describeSaveFormat,formatSaveResult,
   prepareFork:async()=>{throw Error('recover不应新prepare')},completeFork:async(...args)=>{calls.push(args);return {chatId:'chat-target',sessionId:target}},
   readSourceSessionTitle:async()=>{throw Error('recover不应重新claim')},renameTargetSession:async(_id,title)=>title,setTargetChatTitle:async()=>{},validateTargetNaming:async()=>{}}
  let service=createLegacySaveActions(deps)
  await assert.rejects(()=>service.recover({sessionId:sid,targetSessionId:target}),/未冻结/)
  assert.equal((await service.status({sessionId:sid})).recoverable,false)
  records.bind({sourceChatId:source,token:claimed.record.token,targetSessionId:target})
  service=createLegacySaveActions(deps)
  const status=await service.status({sessionId:sid});assert.equal(status.recoverable,true);assert.equal(JSON.stringify(status).includes(claimed.record.token),false)
  await assert.rejects(()=>service.recover({sessionId:sid,targetSessionId:'session-other'}),/不一致/);assert.equal(records.read(source).state,'bound')
  const result=await service.recover({sessionId:sid,targetSessionId:target});assert.equal(result.sessionId,target);assert.equal(result.chatId,'chat-target');assert.deepEqual(calls,[[source,sid,target,2,7,8]])
  assert.equal(records.read(source).state,'complete');await assert.rejects(()=>service.recover({sessionId:sid,targetSessionId:target}),/未冻结|已完成/)
 }finally{if(prior===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prior;rmSync(dir,{recursive:true,force:true})}
})
