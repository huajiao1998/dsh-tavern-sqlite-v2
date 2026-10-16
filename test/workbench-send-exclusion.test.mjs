// 只用合成档：实际施缝产物 + 真实SQL；不连接现场、不调用模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertSendAfterCleanup } from '../lib/failure-state.js'
import { latestSendRecord, latestSendTarget } from '../lib/latest-send.js'
import { inspectNativeFailureTail } from '../lib/failure-cleanup-target.js'
import { prepareCommentAuthorTree, commentAuthorTreeSource } from './fixtures/comment-author-tree.mjs'
import { buildCore } from '../deploy/standard-seam-transforms.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { activeSendCapture } from '../lib/send-acceptance.js'
import { SqliteSessionDb } from '../store.js'
import { rollbackBarrier, rollbackSchedulingBarrier, rollbackCancellationBarrier, assertRollbackChatWritable } from '../lib/rollback-barrier.js'
import { recordRollbackBusinessWrites } from '../lib/rollback-business-state.js'
const DOMAIN = 'tavern-plugin/lib/domain/'
const chat = (mode, extra = {}) => ({
  id: 'chat-workbench', sessionId: 'session-workbench', mode, _storageRevision: 4,
  timeline: { schemaVersion: 1, branchId: 'main', revision: 3, operations: {
    'op-1': { id: 'op-1', kind: 'body', role: 'body', status: 'running', turn: 1, nativeStartSeq: 8,
      basedOn: { branchId: 'main', revision: 3 } } }, checkpoints: [], participants: {} },
  messages: [{ role: 'user', text: '改卡需求' }, { role: 'assistant', turn: 1, text: '已生成人物卡草稿' }], ...extra,
})
const events = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'user/message', data: { turn: 1, source: { kind: 'user' } } },
  { seq: 2, type: 'assistant/message', data: { turn: 1 } },
  { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } },
  { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
test('工作台：残留 running 正文账本不得再挡住下一轮发送', () => {
  assert.equal(latestSendRecord(chat('card')), null)
  assert.equal(latestSendRecord(chat('story')).turn, 1)
  assert.equal(latestSendTarget(chat('story'), { events }, 4).turn, 1)
  assert.equal(latestSendTarget(chat('card'), { events }, 4), null)
  assert.throws(() => assertSendAfterCleanup(chat('story'), { events, accepting: true }), /尚未物理清理/)
  assert.doesNotThrow(() => assertSendAfterCleanup(chat('card'), { events, accepting: true }))
  assert.equal(inspectNativeFailureTail(chat('card'), { events }, 4), null)
})

const sourceFunctions = source => source.replace(/^import .*$/gm, '').replace(/^export /gm, '')
test('工作台复审：真实prepare不触碰游玩前像，原版模板助手可执行，无额外回退入口提示', async () => {
  const tree = prepareCommentAuthorTree();assert.ok(tree)
  try {
    const core = buildCore(tree.appDir, tree.original),source = core.get(DOMAIN+'turn-orchestration.js')
    const api=new Function(sourceFunctions(source)+';return {createTurnOrchestrator,stageTemplateInput}')( )
    const native=tree.original.get(DOMAIN+'turn-orchestration.js')
    const helper = s => s.slice(s.indexOf('function stageTemplateInput('),s.indexOf('function restoreTemplateInput('))
    assert.equal(helper(source),helper(native),'原版公共模板函数必须逐字保留，不能误植无定义mode')
    const staged={variables:{hp:2},promptTemplateInput:{turn:1,before:{variables:{hp:1},initial:null}}}
    api.stageTemplateInput(staged,2,'新输入',{message:{text:'投影'},scopes:{local:{hp:3},initial:{}}})
    assert.equal(staged.variables.hp,3)
    const current=chat('card',{rollbackPending:{turn:1},cardPath:'cards/损坏卡.json',cardName:'待修卡',promptTemplateInput:{turn:1,before:{variables:{hp:0}}},variables:{hp:8}})
    const before=structuredClone(current);let written
    const fail=()=>{throw Error('工作台不应调用游玩依赖')}
    const turns=api.createTurnOrchestrator({store:{chatForSession:async()=>structuredClone(current),readCard:fail,writeChat:async value=>{written=value}},timeline:{captureBusiness:fail,apply:fail},resolveSendInputAnchor:fail,frameBuilder:{build:fail},planner:{plan:async input=>{assert.equal(input.purpose,'card');return {text:'原版改卡提示词'}}}})
    const result=await turns.prepare({sessionId:current.sessionId,turn:2,userText:'修卡',requestId:'synthetic-card-2'})
    assert.equal(result.ready,true);assert.equal(result.mode,'card');assert.equal(result.text,'原版改卡提示词')
    assert.deepEqual(written.timeline,before.timeline);assert.deepEqual(written.variables,before.variables);assert.deepEqual(written.promptTemplateInput,before.promptTemplateInput)
    const history=core.get(DOMAIN+'round-history.js')
    assert.ok(!history.includes('[dsh-tavern-workbench-history:'))
    const a=history.indexOf('  async function rollbackChat('),b=history.indexOf('  async function undoRollback(',a)
    const rollback=new Function(sourceFunctions(history.slice(a,b))+';return rollbackChat')()
    await assert.rejects(rollback(chat('card'),1),/仅游玩模式支持回退本轮/,'只保留原版已有模式限制，不进入物理回退')
  } finally {tree.cleanup()}
})

test('工作台复审：真实SQL连续发轮不建账本，残留屏障不挡改卡和事件追加',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'workbench-real-sql-')),author=path.join(commentAuthorTreeSource(),DOMAIN)
  const module=name=>import(new URL('file:///'+path.join(author,name).replaceAll('\\','/')).href)
  const helpers={...await module('copy-json-tree.js'),...await module('json-mutation.js'),...await module('chat-session-state.js')}
  const store=createChatSqliteStore({dataRoot:root,helpers});let native
  const sid='session-workbench'
  try{
    await store.update('chat-workbench',()=>chat('card',{_storageRevision:1,rollbackPending:{turn:1}}))
    rollbackBarrier.add(sid);rollbackSchedulingBarrier.add(sid);rollbackCancellationBarrier.add(sid)
    const capture=activeSendCapture(root),before=await store.read('chat-workbench')
    for(const turn of [2,3])for(const type of ['turn/start','user/message'])assert.equal(capture('chat-workbench',{sessionId:sid,type,turn,seq:turn*10,events,data:{source:{kind:'user'},content:[{type:'text',text:'改卡'}]}}),undefined)
    assert.deepEqual(await store.read('chat-workbench'),before,'捕获工作台消息不能推进revision或补游玩账本')
    await store.update('chat-workbench',current=>({...current,cardName:'已改名',_storageRevision:current._storageRevision+1}),{source:'foreground.commit',rollbackOwner:{chatId:'retired',turn:99}})
    assert.equal((await store.read('chat-workbench')).cardName,'已改名')
    assert.doesNotThrow(()=>recordRollbackBusinessWrites(before,structuredClone(before),{rollbackOwner:{chatId:'retired'}}))
    assert.doesNotThrow(()=>assertRollbackChatWritable(chat('story',{rollbackPending:{turn:1}}),{source:'card-name.sync'}))
    assert.throws(()=>assertRollbackChatWritable(chat('story',{rollbackPending:{turn:1}}),{source:'foreground.commit'}),/物理回退未完成/)
    native=new SqliteSessionDb(path.join(root,'native.db'))
    native.materialize({id:sid,version:3,createdAt:1},0,[])
    native.bindRollbackArchive(path.join(root,'chats','chat-workbench','archive.db'));native.setRollbackPending(true)
    const backend=readFileSync(new URL('../index.js',import.meta.url),'utf8'),start=backend.indexOf('\tguardTurnStart(id, events) {'),end=backend.indexOf('\n\t}',start)+4
    const guard=new Function('return ({'+backend.slice(start,end)+'}).guardTurnStart')()
    assert.doesNotThrow(()=>guard.call({assertWritable:()=>{},store:{openExisting:()=>native}},sid,[{type:'turn/start'}]),'实际后端入口也必须跳过工作台屏障')
    native.appendBatch([{seq:0,type:'turn/start',time:1,data:{turn:2}}])
    assert.equal(native.cursor(),1)
    await store.update('chat-workbench',current=>({...current,mode:'story',_storageRevision:current._storageRevision+1}))
    assert.throws(()=>guard.call({assertWritable:()=>{},store:{openExisting:()=>native}},sid,[{type:'turn/start'}]),/会话正在物理回退/,'story原持久入口仍拒绝回退中的事件追加')
    rollbackBarrier.delete(sid);rollbackSchedulingBarrier.delete(sid)
    assert.throws(()=>native.appendBatch([{seq:1,type:'turn/start',time:2,data:{turn:3}}]),/物理回退未完成/,'story仍拒绝持久半态追加');assert.equal(native.cursor(),1)
  }finally{rollbackBarrier.delete(sid);rollbackSchedulingBarrier.delete(sid);rollbackCancellationBarrier.delete(sid);native?.close();store.dispose();rmSync(root,{recursive:true,force:true})}
})
