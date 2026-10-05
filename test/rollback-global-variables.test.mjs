import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {rollbackSchedulingBarrier} from '../lib/rollback-barrier.js'
import {rollbackGlobalOwner,createRollbackGlobalVariables} from '../lib/rollback-global-variables.js'
async function fixture(){const root=mkdtempSync(path.join(os.tmpdir(),'rollback-global-vars-'));let old={global:{hp:52,keep:'上一轮'}},deleted=0;const store=createRollbackGlobalVariables({dataRoot:root,profileData:{readJson:async()=>old,remove:async()=>{old=undefined;deleted++}}});return {root,store,deleted:()=>deleted,cleanup:async()=>{await store.dispose();rmSync(root,{recursive:true,force:true})}}}
test('双连接旧JSON迁入只初始化一次，不覆盖先提交值；非法旧树不删原件',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-global-init-'));let release,removed=0
 const old={global:{hp:52}},gate=new Promise(r=>release=r)
 const a=createRollbackGlobalVariables({dataRoot:root,profileData:{readJson:async()=>{await gate;return old},remove:async()=>removed++}})
 const b=createRollbackGlobalVariables({dataRoot:root,profileData:{readJson:async()=>old,remove:async()=>removed++}})
 try{const readA=a.read();await b.read();await b.save({hp:99});release();assert.deepEqual(await readA,{hp:99});assert.equal(removed,2)}finally{release();await a.dispose();await b.dispose();rmSync(root,{recursive:true,force:true})}
 const badRoot=mkdtempSync(path.join(os.tmpdir(),'rollback-global-bad-init-'));let badRemoved=false
 const bad=createRollbackGlobalVariables({dataRoot:badRoot,profileData:{readJson:async()=>({global:JSON.parse('{"__proto__":{"old":53}}')}),remove:async()=>badRemoved=true}})
 try{await assert.rejects(bad.read(),/不安全字段/);assert.equal(badRemoved,false)}finally{await bad.dispose();rmSync(badRoot,{recursive:true,force:true})}
})
test('共享变量非JSON或非有限数删写前拒绝，不把undefined静默当删除',async()=>{
 const f=await fixture();try{
  const before=await f.store.read(),cycle={};cycle.self=cycle
  for(const invalid of [{hp:undefined},{hp:NaN},{hp:Infinity},{hp:()=>{}},{hp:1n},{hp:new Date()},cycle])await assert.rejects(f.store.save(invalid,undefined,{chatId:'fixture',turn:53}),/JSON|循环/)
  assert.deepEqual(await f.store.read(),before)
 }finally{await f.cleanup()}
})
test('静止屏障拒绝共享写身份，特殊键不修改对象原型',async()=>{
 const chat={id:'fixture',sessionId:'fixture',mode:'story',timeline:{operations:{body:{kind:'body',turn:53}}}}
 rollbackSchedulingBarrier.add(chat.sessionId)
 try{assert.throws(()=>rollbackGlobalOwner(chat),/禁止共享/)}finally{rollbackSchedulingBarrier.delete(chat.sessionId)}
 assert.deepEqual(rollbackGlobalOwner(chat),{chatId:'fixture',turn:53})
 const f=await fixture();try{
  const special=JSON.parse('{"__proto__":{"旧53":true}}')
  for(const invalid of [special,{nested:special},{array:new Array(2)},{[Symbol('fixture')]:53}])await assert.rejects(f.store.save(invalid),/不安全字段|稀疏数组|Symbol键/)
  const read=await f.store.read();assert.equal(Object.getPrototypeOf(read),Object.prototype);assert.ok(!Object.hasOwn(read,'__proto__'))
 }finally{await f.cleanup()}
})
test('共享手工同键修改不生成逐轮撤销；CAS仍拒过期写，不覆盖无关键',async()=>{
 const f=await fixture();try{
  const before=await f.store.read();await f.store.save({hp:53,keep:'上一轮'},before,{chatId:'fixture',turn:53})
  await f.store.save({hp:99,keep:'上一轮',manual:'独立编辑'},await f.store.read())
  await assert.rejects(f.store.save({hp:54,keep:'上一轮'},{hp:53,keep:'上一轮'}),/其他对话修改/)
  await f.store.save({hp:99,keep:'改保留键'},{hp:99,keep:'上一轮'})
  assert.deepEqual(await f.store.read(),{hp:99,keep:'改保留键',manual:'独立编辑'})
  assert.equal(f.store.pruneRollback,undefined)
  const db=new DatabaseSync(path.join(f.root,'prompt-template-variables.db'));try{assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('global_undo','global_rollback_keys','global_rollback_owners','global_key_revisions')").get().n,0)}finally{db.close()}
 }finally{await f.cleanup()}
})
test('旧宽边界撤销表退役只删撤销负载，保留当前SQL资源值且双连接重复安全',async()=>{
 const f=await fixture();let second
 try{
  await f.store.save({hp:99,manual:'当前编辑'})
  const db=new DatabaseSync(path.join(f.root,'prompt-template-variables.db'));try{db.exec("CREATE TABLE global_undo(text); INSERT INTO global_undo VALUES('旧53撤销负载'); CREATE TABLE global_rollback_keys(key); CREATE TABLE global_rollback_owners(id); CREATE TABLE global_key_revisions(key)")}finally{db.close()}
  second=createRollbackGlobalVariables({dataRoot:f.root,profileData:{readJson:async()=>{throw Error('禁止重读旧文件')},remove:async()=>{}}})
  assert.deepEqual(await second.read(),{hp:99,manual:'当前编辑'})
  const check=new DatabaseSync(path.join(f.root,'prompt-template-variables.db'));try{assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'global_rollback_%' OR name='global_undo'").get().n,0)}finally{check.close()}
 }finally{await second?.dispose();await f.cleanup()}
})
