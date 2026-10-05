// 借用隔离组合fixture做删前安全拒绝；不请求模型、不读真实存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {SqliteSessionDb} from '../store.js'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
test('Session持久失败位跨重新打开拒绝追加，清除才恢复',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-persist-barrier-')),file=path.join(root,'fixture.db')
 let db=new SqliteSessionDb(file)
 try{
  db.materialize({id:'fixture',version:3,createdAt:1},0,[{type:'session/end-seed',seq:0,time:1,data:{}}]);db.setRollbackPending(true);db.close();db=new SqliteSessionDb(file)
  const events=[{type:'turn/start',seq:1,time:2,data:{turn:53}}]
  assert.throws(()=>db.appendBatch(events,1),/回退未完成/);assert.equal(db.cursor(),1)
  db.setRollbackPending(false);db.appendBatch(events,1);assert.equal(db.cursor(),2)
 }finally{db.close();rmSync(root,{recursive:true,force:true})}
})
