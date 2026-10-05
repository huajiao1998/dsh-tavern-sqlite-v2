import test from 'node:test'
import assert from 'node:assert/strict'
import {createServerExecution} from '../lib/server-execution.js'
import {rollbackBarrier,rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
test('跨库失败后调度屏障已释放但持久失败进程位仍禁止新脚本run',async()=>{
 const execution=createServerExecution({host:{updateVariables:async()=>{}}})
 rollbackBarrier.add('fixture')
 try{await assert.rejects(execution.dispatchLifecycleEvent({sessionId:'fixture',chat:{messages:[]},event:'MESSAGE_SENT'}),/禁止新服务端脚本run/)}finally{rollbackBarrier.delete('fixture');execution.disposeAll()}
})
test('脚本不await的Host写由完成屏障有界等待，超预算拒绝后仍被whenIdle收口',async()=>{
 // 语义对齐（2026-10-05 改写）：dispatchLifecycleEvent 自 bb5d562 起带提交前完成屏障
 // （drainRunTasks：短回调 + 未 await 的写，有界预算、超时抛错、本次不提交），
 // 原断言"派发立即返回、只靠 whenIdle 等"与该设计矛盾（出生即红）。本测试改验两层真实不变量：
 //   ① 屏障期内派发不得带伤返回 —— 超预算按 timeout 拒绝，不返回半成功；
 //   ② 写不悬挂 —— 派发被拒、binding 关闭后，未 await 的 Host 写仍由 whenIdle join 到完成。
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let api,write,finished=false
 const execution=createServerExecution({timerDrainBudgetMs:60,host:{updateVariables:async()=>{enter();await gate;finished=true;return {updated:true}}},readCardExtensions:async()=>({helperScripts:[]}),project:()=>({scripts:[{id:'fixture',content:'fixture();'}]}),createRuntime:options=>{api=options.hostApi;return {ready:Promise.resolve(),events:['MESSAGE_SENT'],errors:[],dispatchEvent:async()=>{write=api.replaceVariables({hp:53},{type:'chat'}).catch(error=>error);return {}},dispose(){}}}})
 try{
  const dispatched=execution.dispatchLifecycleEvent({sessionId:'fixture',chat:{cardPath:'fixture',messages:[{role:'assistant'}]},event:'MESSAGE_SENT'})
  await entered
  let done=false;const idle=execution.whenIdle('fixture').then(()=>done=true)
  for(let n=0;n<8;n++)await Promise.resolve()
  assert.equal(done,false,'未await的写在飞时whenIdle不得提前完成')
  await assert.rejects(dispatched,/卡脚本异步完成超出预算/,'完成屏障超预算应拒绝提交（不返回半成功）')
  assert.equal(execution.stats().bindings,0,'派发结束（含被拒）后binding必须已闭合')
  assert.equal(done,false,'派发被拒后写仍在飞，whenIdle仍不得完成')
  release();await write
  assert.equal(finished,true);await idle;assert.equal(done,true,'写收口后whenIdle完成')
 }finally{release();try{await write}catch{};execution.disposeAll()}
})
test('dispose提前移除binding后完整服务端run仍可join，静止期间新run拒绝',async()=>{
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r)
 const execution=createServerExecution({host:{updateVariables:async()=>{}},executeCommand:async(_text,data)=>{enter();await gate;data.stat_data={hp:53};return true}})
 const draft={messages:[{role:'assistant',variables:[{stat_data:{hp:52}}]}]}
 const run=execution.executeMvuUpdate({sessionId:'fixture',transaction:{eventId:'mvu-work:fixture'},draft,messageId:0,swipeId:0,commandText:'fixture'})
 const result=run.catch(error=>error)
 try{
  await entered;execution.disposeSession('fixture');assert.equal(execution.stats().bindings,0)
  let done=false;const joined=execution.whenIdle('fixture').then(()=>done=true);await Promise.resolve();assert.equal(done,false)
  rollbackSchedulingBarrier.add('fixture')
  await assert.rejects(execution.dispatchLifecycleEvent({sessionId:'fixture',chat:draft,event:'MESSAGE_SENT'}),/禁止新服务端脚本run/)
  release();await joined;assert.equal(done,true);assert.ok((await result) instanceof Error);assert.deepEqual(draft.messages[0].variables[0].stat_data,{hp:52})
 }finally{release();await result;rollbackSchedulingBarrier.delete('fixture');execution.disposeAll()}
})
