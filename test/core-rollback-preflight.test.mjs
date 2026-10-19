// preflight旧导出现在只定位切点；不分类原生形态、完整度、终态或先认证服务能力。
// 实际删库/内存/投影动作由native-repair-cleanup和clean-rollback-integration真实SQLite断言覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import {configureRollbackCleanup,preflightRollback,preflightRollbackAtSeq} from '../lib/rollback-cleanup.js'
import {foregroundInboxBoundary} from '../lib/foreground-inbox-boundary.js'
configureRollbackCleanup({sessionEvents:session=>session.snapshotEvents()})
const eventsOf=()=>[
 {seq:0,type:'session/end-seed',data:{}},
 {seq:1,type:'turn/start',data:{turn:1}},
 {seq:2,type:'turn/end',data:{turn:1,reason:{kind:'error'}}},
 {seq:3,type:'turn/start',data:{turn:2}},
 {seq:4,type:'user/message',data:{source:{kind:'user'}}},
 {seq:5,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}},
]
const sessionOf=log=>({log,header:{id:'synthetic-range'},get seq(){return this.log.length},snapshotEvents(){return this.log}})

test('切点定位：只删最新轮且不要求前轮成功，初始化与前轮保留',()=>{
 const plan=preflightRollback(sessionOf(eventsOf()),2)
 assert.equal(plan.keep,3);assert.equal(plan.dropped,3);assert.equal(plan.boundarySeq,2)
 const first=preflightRollback(sessionOf(eventsOf().slice(0,3)),1)
 assert.equal(first.keep,1,'首轮之前的初始化必须保留')
})
test('切点定位：无end、未知终态和无start碎片不设对象资格',()=>{
 for(const log of [eventsOf().slice(0,-1),eventsOf().map(e=>e.seq===5?{...e,data:{turn:2,reason:{kind:'future-status'}}}:e),[...eventsOf().slice(0,3),{seq:3,type:'turn/end',data:{turn:2}}]]) {
  const plan=preflightRollback(sessionOf(log),2,{strict:true})
  assert.equal(plan.boundarySeq,2);assert.equal(plan.ok,true)
 }
})
test('切点定位：没有任何原生事件的首轮可用空前缀，不冒造初始化',()=>{
 assert.equal(preflightRollback(sessionOf([{seq:0,type:'turn/start',data:{turn:1}}]),1).keep,0)
 assert.equal(preflightRollbackAtSeq(sessionOf([]),-1,{foregroundExact:true}).noop,true)
})
test('切点定位：原生整轮已缺失时同尾幂等，不倒删上一轮',()=>{
 const log=[...eventsOf().slice(0,3),{seq:3,type:'session/end-seed',data:{}}],plan=preflightRollback(sessionOf(log),2)
 assert.equal(plan.keep,log.length);assert.equal(plan.noop,true)
})
test('切点定位：不预认证原生引用或服务接线，实际操作失败由执行端报告',()=>{
 const log=eventsOf();log[1].sourceEventSeqs=[99]
 const plan=preflightRollback(sessionOf(log),2,{strict:true,persistence:{},services:{}})
 assert.equal(plan.boundarySeq,2);assert.equal(plan.ok,true)
})
test('切点范围：越界坐标不替换成零或删除整库',()=>{
 const session=sessionOf(eventsOf())
 for(const seq of [-2,6,999,NaN,1.5])assert.throws(()=>preflightRollbackAtSeq(session,seq,{foregroundExact:true}),/超出当前日志范围/)
 assert.equal(session.log.length,6)
})
test('切点范围：只限制独立历史，不以目标产物形态拒绝',()=>{
 const queued={seq:0,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'queued',source:{kind:'user'}}]}}
 const cross=[queued,{seq:1,type:'turn/start',data:{turn:1}},{seq:2,type:'turn/end',data:{turn:1}},{seq:3,type:'turn/start',data:{turn:2}}]
 assert.throws(()=>foregroundInboxBoundary(cross,2,3,{}),/早于其它独立轮/)
 const independent=[queued,{seq:1,type:'turn/start',data:{turn:2}},{seq:2,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{seq:3,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'other',source:{kind:'user'}}]}}]
 assert.throws(()=>foregroundInboxBoundary(independent,2,1,{}),/独立输入/)
})
