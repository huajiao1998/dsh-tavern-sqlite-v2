// 只用原创输入，覆盖正文思考与独立旧轮编辑；不读真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {inspectNativeFailureTail,isRetainedBodyEdit} from '../lib/failure-cleanup-target.js'
import {latestSendTarget} from '../lib/latest-send.js'
import {applyLatestSendViewTransform} from '../deploy/latest-send-view-transform.mjs'
import {SqliteSessionDb} from '../store.js'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
import {composedFailureViewText} from './support/latest-failure-source.mjs'
const chatOf=()=>({id:'chat',sessionId:'s',_storageRevision:3,messages:[{role:'assistant',turn:6,text:'edited six',bodyEdit:{id:'tavern-body-edit:synthetic',seq:1,turn:6}}],timeline:{branchId:'b',operations:{six:{kind:'body',turn:6,status:'completed',background:{phase:'failed'}}},checkpoints:[{turn:6}]}})
const eventsOf=()=>[
 {seq:0,type:'turn/start',time:1,data:{turn:6}},
 {seq:1,type:'assistant/message',time:2,data:{turn:6,message:{id:'a6',content:[{type:'text',text:'old six'}]}},surfaceOp:'append'},
 {seq:2,type:'turn/end',time:3,data:{turn:6,reason:{kind:'completed'}}},
 {seq:3,type:'turn/start',time:4,data:{turn:7}},
 {seq:4,type:'assistant/message',time:5,data:{turn:7,message:{id:'a7',content:[{type:'reasoning',text:'reasoning'},{type:'text',text:'seven'}]}},surfaceOp:'append'},
 {seq:5,type:'turn/end',time:6,data:{turn:7,reason:{kind:'completed'}}},
 {seq:6,type:'session/end-seed',time:7,data:{}},
 {seq:7,type:'dsh-tavern/required-session-patch-v1',time:8,data:{version:1,hostVersion:'0.1.5-rc.2'}},
 {seq:8,type:'assistant/message',time:9,data:{turn:6,step:1,message:{id:'tavern-body-edit:synthetic',role:'assistant',content:[{type:'text',text:'edited six'}],source:{kind:'model',provider:'dsh-tavern',model:'body-edit'}}},surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]}
]
test('真实形态异常尾：reasoning不误拒、旧轮编辑不改末轮、精确安全引用才签',()=>{
 const chat=chatOf(),events=eventsOf(),inspect=(c=chat,e=events)=>inspectNativeFailureTail(c,{events:e,cleanupIdle:true,activity:{phase:'idle',busy:false}},c._storageRevision)
 assert.equal(inspect().target?.turn,7);assert.equal(inspect().target?.kind,'rollback')
 for(const change of [e=>e[8].data.message.content[0].text='not saved',e=>e[8].data.message.source.model='unknown',e=>e[7].data.version=2,e=>e[4].data.message.content.push({type:'tool-call'})]){
  const copy=structuredClone(events);change(copy);assert.equal(inspect(chat,copy).target?.turn,7,'model/content/source/version 类都不决定签出资格（仅身份/seq/owned business）')
 }
 // 独立旧轮编辑的**引用安全**由真实 guard 判定：inspector 不做引用校验，不能靠它期待 null。
 const legal=structuredClone(events);assert.equal(isRetainedBodyEdit(legal[8],legal,2,chat,7),true,'合法独立 body edit 引用必须为 true（可安全保留）')
 for(const change of [e=>e[8].sourceEventSeqs=[4],e=>e[8].data.message.content[0].text='not saved',e=>e[8].data.message.source.model='unknown']){
  const copy=structuredClone(events);change(copy);assert.equal(isRetainedBodyEdit(copy[8],copy,2,chat,7),false,'错引用/未保存正文/未知 model 必须为 false（引用 guard 不削弱）')
 }
 const normal=chatOf();normal.messages.push({role:'assistant',turn:7,text:'seven'});normal.timeline.operations.seven={kind:'body',turn:7,status:'completed',background:{phase:'failed'}};assert.equal(inspect(normal).target.turn,7,'成功正文同样统一可回退')
})
test('异常清理菜单真实视图：普通surface不匹配也启用清理，目标轮来自原生7',async()=>{
 const source=applyLatestSendViewTransform(await composedFailureViewText()),ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),nodes=[]
 function walk(node){if(!node || typeof node!=='object')return;if(node.type==='FunctionDeclaration' && ['rollbackViewFields'].includes(node.id?.name))nodes.push(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value && typeof value==='object')walk(value)}}walk(ast)
 assert.equal(nodes.length,1)
 const context=vm.createContext({latestSendTarget,rollbackViewFieldsBase:()=>({}),inspectNativeFailureTail,evidenceOf:()=>null,normalizedMappings:()=>({}),sharedMappings:false,rollbackCache:new Map(),rollbackAvailability:()=>({canRollback:false,reason:'普通轮不匹配'}),failedTurnReplayAvailability:()=>({target:null}),hasRollbackMessages:()=>true,failedErrorTurnStates:()=>({staleTurns:[],filteredStreak:0}),foregroundSuppressedTurns:()=>[],supersededRegenerationErrorTurns:()=>[],isRescuedHistoryMessage:()=>false,settlementTurn:()=>6,canUndoRollback:()=>false})
 vm.runInContext(nodes.map(n=>source.slice(n.start,n.end)).join('\n')+'\nglobalThis.viewOf=rollbackViewFields;',context)
 const result=context.viewOf(chatOf(),{events:eventsOf(),nodes:[],cleanupIdle:true,activity:{phase:'idle',busy:false}})
 assert.equal(result.canRollback,true);assert.equal(result.canClearIncompleteReply,false);assert.equal(result.rollbackTargetTurn,7);assert.equal(result.failureTarget.turn,7)
})
test('旧轮编辑保留SQL：纯尾同事务保留精确原事件并重编号，伪造或跨尾引用零删',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'retained-body-edit-')),db=new SqliteSessionDb(path.join(root,'s.db')),events=eventsOf()
 try {
  db.materialize({id:'s',version:3,createdAt:1},0,events)
  const before=db.cursor(),unsafe=structuredClone(events.slice(7));unsafe[1].sourceEventSeqs=[4]
  assert.throws(()=>db.truncateFrom(2,undefined,unsafe),/精确引用/);assert.equal(db.cursor(),before)
  const meta=db.truncateFrom(2,undefined,events.slice(7))
  assert.equal(meta.eventCount,5);assert.deepEqual(meta.retainedEvents,events.slice(7).map((e,i)=>({...e,seq:3+i})))
  const raw=db.db.prepare('SELECT seq,type FROM events ORDER BY seq').all()
  assert.deepEqual(raw.map(r=>r.type),[...events.slice(0,3),...events.slice(7)].map(e=>e.type));assert.equal(db.cursor(),5)
 } finally {db.close();rmSync(root,{recursive:true,force:true})}
})
