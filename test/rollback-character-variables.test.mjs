import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
test('人物变量SQL共享编辑不挂剧情撤销，双连接种子/CAS保留且另一卡独立',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'character-rollback-')),a=createRollbackCharacterVariables({dataRoot:root}),b=createRollbackCharacterVariables({dataRoot:root})
 try{
  await assert.rejects(a.save('cards/a.json',{hp:53}),/尚未初始化/)
  await Promise.all([a.read('cards/a.json',{hp:52}),b.read('cards/a.json',{hp:52})]);await b.read('cards/b.json',{hp:8})
  await a.save('cards/a.json',{hp:53},{chatId:'fixture',turn:53});await b.save('cards/b.json',{hp:10})
  await b.save('cards/a.json',{hp:99,new:'手工编辑'})
  assert.deepEqual(await a.read('cards/a.json',{hp:999}),{hp:99,new:'手工编辑'});assert.deepEqual(await a.read('cards/b.json'),{hp:10})
  await assert.rejects(a.save('cards/a.json',{hp:54},undefined,{hp:53}),/其他对话修改/)
  assert.equal(a.pruneRollback,undefined)
  const db=new DatabaseSync(path.join(root,'character-variables.db'));try{const rows=db.prepare('SELECT * FROM global_values').all();assert.equal(rows.length,3);assert.ok(rows.every(row=>JSON.parse(row.key).length===2));assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='global_undo'").get().n,0)}finally{db.close()}
 }finally{await a.dispose();await b.dispose();rmSync(root,{recursive:true,force:true})}
})
