import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createRollbackExtensionSettings} from '../lib/rollback-extension-settings.js'
test('扩展设置只存SQL当前值，旧JSON退役、缺基准拒绝、跨连接CAS保留',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-settings-'));let old={EjsTemplate:{value:52},regex:{rules:['旧52']}},removed=0
 const store=createRollbackExtensionSettings({dataRoot:root,profileData:{readJson:async name=>{assert.equal(name,'tavern-extension-settings.json');return old},remove:async name=>{assert.equal(name,'tavern-extension-settings.json');old=undefined;removed++}}})
 try{
  const baseline=await store.read();assert.equal(removed,1)
  await store.save({EjsTemplate:{value:53},regex:{rules:['编辑规则']}},baseline,{chatId:'a',turn:53})
  const before=await store.read();await store.save({...before,EjsTemplate:{value:99},unrelated:'另档'},before)
  await assert.rejects(store.save({...before,EjsTemplate:{value:54}},before),/其他对话修改/)
  assert.deepEqual(await store.read(),{EjsTemplate:{value:99},regex:{rules:['编辑规则']},unrelated:'另档'})
  await assert.rejects(store.save({},undefined),/读取基准/);assert.equal(store.pruneRollback,undefined)
  const db=new DatabaseSync(path.join(root,'tavern-extension-settings.db'));try{assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='global_undo'").get().n,0)}finally{db.close()}
 }finally{await store.dispose();rmSync(root,{recursive:true,force:true})}
})
