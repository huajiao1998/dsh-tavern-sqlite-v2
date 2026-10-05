import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applySettlementQuiescenceTransform,applyForegroundQuiescenceTransform} from '../deploy/rollback-quiescence-transform.mjs'
import {applyRollbackHostTransform,applyTemplateQuiescenceTransform,applyCandidateQuiescenceTransform,applyCompactionQuiescenceTransform} from '../deploy/rollback-host-transform.mjs'
import {applyCleanRollbackTransform} from '../deploy/clean-rollback-transform.mjs'
const read=name=>readFileSync(new URL('../../../tmp/rollback-compare-1001/'+name,import.meta.url),'utf8')
const load=async source=>import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
test('取消wait:false仍保留旧run可等待；新start不能覆盖它',async()=>{
 const source=applySettlementQuiescenceTransform(read('plugin-settlement-jobs.js'));assert.equal(applySettlementQuiescenceTransform(source),source)
 const {createSettlementJobs}=await load(source);let release,runs=0,done=false
 const gate=new Promise(r=>{release=r});const jobs=createSettlementJobs({run:async()=>{runs++;await gate},onSettled:async()=>{}})
 const run=jobs.start('fixture');await Promise.resolve();await jobs.cancel('fixture',{wait:false})
 assert.equal(jobs.start('fixture'),run)
 const stopped=jobs.cancel('fixture',{wait:true}).then(()=>{done=true});await Promise.resolve();assert.equal(done,false)
 release();await stopped;assert.equal(runs,1)
})
test('延迟前台任务可等到整体结束，不再追加失败软清',async()=>{
 const source=applyForegroundQuiescenceTransform(read('current-foreground-handoff.js'));assert.equal(applyForegroundQuiescenceTransform(source),source)
 const {createForegroundHandoff}=await load(source);let callback,release,discarded=false,soft=false
 const gate=new Promise(r=>{release=r})
 const handoff=createForegroundHandoff({turns:{finalize(){},discard:async()=>{await gate;discarded=true}},store:{},tasks:{activity(){}},queueBackground(){},cleanupFailedTurn:()=>{soft=true},defer:fn=>{callback=fn}})
 handoff.end({sessionId:'fixture',turn:53,reason:'error'});let done=false
 const wait=handoff.whenIdle('fixture').then(()=>{done=true});await Promise.resolve();assert.equal(done,false)
 callback();release();await wait;assert.equal(discarded,true);assert.equal(soft,false)
})
test('结算onSettled尚未完成也必须可join，不能在finally开头丢失旧run',async()=>{
 const {createSettlementJobs}=await load(applySettlementQuiescenceTransform(read('plugin-settlement-jobs.js')))
 let entered,release;const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r})
 const jobs=createSettlementJobs({run:async()=>{},onSettled:async()=>{entered();await gate}})
 const run=jobs.start('fixture');await started;let done=false
 const wait=jobs.cancel('fixture',{wait:true}).then(()=>{done=true});await Promise.resolve();assert.equal(done,false)
 release();await wait;await run
})
test('候选entry被revision移除后仍等待正在进行的完整load',async()=>{
 const source=applyCandidateQuiescenceTransform(read('current-candidate-worldbook-preparation.js')).replace("import {copyJsonTree} from './copy-json-tree.js'",'const copyJsonTree=structuredClone')
 const {createCandidateWorldbookPreparation}=await load(source);let entered,release
 const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{release=r})
 const cache=createCandidateWorldbookPreparation({version:async()=>({revision:1,resources:'fixture'}),prepare:async()=>{entered();await gate;return {text:'旧53'}}})
 const run=cache.get('fixture');await started;cache.changed({sessionId:'fixture',_storageRevision:2},{source:'rollback.prepare'})
 let done=false;const wait=cache.whenIdle('fixture').then(()=>{done=true});await Promise.resolve();assert.equal(done,false)
 release();await wait;await assert.rejects(run,/游戏状态已变化/);cache.dispose()
})
test('实际Host与所有调度器锚点升级且幂等，回退函数不含旧软清/undo/script写口',()=>{
 for (const [name,transform] of [['current-index.js',applyRollbackHostTransform],['current-server-template-sync.js',applyTemplateQuiescenceTransform],['current-candidate-worldbook-preparation.js',applyCandidateQuiescenceTransform],['current-auto-compaction.js',applyCompactionQuiescenceTransform],['plugin-round-history.js',applyCleanRollbackTransform]]) {
  const next=transform(read(name));assert.equal(transform(next),next,name)
  if(name==='plugin-round-history.js') {
   const body=next.slice(next.indexOf('async function rollbackChat'),next.indexOf('async function undoRollback'))
   assert.ok(!body.includes('clearFailedTurnSurface'));assert.ok(!body.includes('MESSAGE_DELETED'));assert.ok(!body.includes('rollbackUndo'));assert.ok(body.includes('cleanRollback'))
   assert.equal((next.match(/clearFailedTurnSurface\(/g)||[]).length,0,'全部执行消费者已退役软清')
   assert.ok(next.includes('await rollbackChat(chat, target.turn)'))
   assert.ok(next.includes('物理删除不可撤销'))
   const outer=next.slice(next.indexOf('async function rollbackTurn'),next.indexOf('async function rollbackChat'))
   assert.ok(outer.includes('[dsh-tavern-rollback-cold:v1]'))
   assert.ok(!outer.includes('sessions.resume('),'外层不得在持久屏障下先resume')
  }
 }
})
