import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'
test('旧召回精确迁入SQL后物理删53，保留52并重绑分支；重试不重新导入旧数据',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-recalls-')),old=new Map(),chat={id:'fixture',sessionId:'session',timeline:{branchId:'old'}}
 for(const turn of [52,53])old.set('worldbook-recalls/fixture/op'+turn+'.json',{chatId:chat.id,sessionId:chat.sessionId,turn,operationId:'op'+turn,branchId:'old',createdAt:turn,outputs:[{text:'业务'+turn}]})
 old.set('worldbook-recalls/fixture/index.json',{records:[52,53].map(turn=>({operationId:'op'+turn,path:'worldbook-recalls/fixture/op'+turn+'.json'}))})
 const removed=[],store=createRollbackWorldbookRecallLog({dataRoot:root,store:{readJson:async p=>old.get(p),remove:async p=>{removed.push(p);old.delete(p)}}})
 try{
  await store.pruneRollback(chat,53,'new');await store.pruneRollback(chat,53,'new')
  assert.equal(old.size,0);assert.equal(removed.length,3)
  const read=await store.read({...chat,timeline:{branchId:'new'}});assert.deepEqual(read.availableTurns,[52]);assert.equal(read.log.outputs[0].text,'业务52')
  const db=new DatabaseSync(path.join(root,'worldbook-recalls.db'));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM recalls WHERE turn>=53').get().n,0)}finally{db.close()}
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})
