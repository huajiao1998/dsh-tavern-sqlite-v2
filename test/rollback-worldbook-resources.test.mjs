import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
test('世界书SQL完整前态拒过期entry/null写入，不使用剧情撤销或额外水位行',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'worldbook-structure-')),a=createRollbackWorldbookResources({dataRoot:root}),b=createRollbackWorldbookResources({dataRoot:root}),source={kind:'card',cardPath:'cards/fixture.json'},baseline={entries:[{id:0,content:'52'}]}
 try{
  await a.read(source,baseline);await assert.rejects(b.save(source,null,null),/完整读取前态/);await a.save(source,null,baseline,{chatId:'fixture',turn:53})
  const added={entries:[{id:9,content:'手工新增'}]};await b.save(source,added,null)
  await assert.rejects(a.save(source,{entries:[]},null),/完整读取前态/)
  assert.deepEqual(await a.read(source,baseline),added);assert.equal(a.pruneRollback,undefined)
  const db=new DatabaseSync(path.join(root,'worldbook-resources.db'));try{assert.ok(!db.prepare('SELECT * FROM global_values').all().some(row=>JSON.parse(row.key)[1]==='$scope-revision'));assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='global_undo'").get().n,0)}finally{db.close()}
 }finally{await a.dispose();await b.dispose();rmSync(root,{recursive:true,force:true})}
})
test('SQL明确null区别未初始化，删书后种子不复活，重新新增用当前null基准',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'worldbook-null-')),sql=createRollbackWorldbookResources({dataRoot:root}),source={kind:'card',cardPath:'cards/null.json'}
 try{
  assert.equal(await sql.read(source,null),null);const book={entries:[{id:0,content:'新增53'}]}
  await sql.save(source,book,null,{chatId:'fixture',turn:53});assert.deepEqual(await sql.read(source,null),book)
  await sql.save(source,null,book);assert.equal(await sql.read(source,book),null)
  await sql.save(source,{entries:[]},null);assert.deepEqual(await sql.read(source),{entries:[]})
 }finally{await sql.dispose();rmSync(root,{recursive:true,force:true})}
})
test('外部世界书头字段条目和originalData拆行，独立卡书编辑保留且拒非法文档',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'worldbook-rollback-')),sql=createRollbackWorldbookResources({dataRoot:root}),other=createRollbackWorldbookResources({dataRoot:root}),source={kind:'standalone',path:'worldbooks/fixture.json'},second={kind:'card',cardPath:'cards/fixture.json'}
 try{
  const seed={name:'fixture',entries:{'0':{uid:0,content:'52'},'1':{uid:1,content:'保留'}}},baseline=await sql.read(source,seed)
  await assert.rejects(sql.save(source,{...seed,entries:new Array(2)},seed),/稀疏数组/);await assert.rejects(sql.save(source,JSON.parse('{"entries":{},"__proto__":{"polluted":true}}'),seed),/不安全字段/)
  const provenance={...seed,originalData:{entries:[{id:0,content:'转换前种子'}]}};await sql.read({kind:'standalone',path:'worldbooks/provenance.json'},provenance);assert.deepEqual(await sql.read({kind:'standalone',path:'worldbooks/provenance.json'}),provenance)
  const edit={...seed,name:'手工名字',entries:{'0':{uid:0,content:'手工编辑'}}};await sql.save(source,edit,baseline,{chatId:'fixture',turn:53})
  await other.read(second,{entries:[{id:1,content:'其他卡'}]});await other.save(second,{entries:[{id:1,content:'其他卡新值'}]},await other.read(second));assert.deepEqual(await sql.read(source,seed),edit)
  const db=new DatabaseSync(path.join(root,'worldbook-resources.db'));try{const rows=db.prepare('SELECT * FROM global_values').all();assert.ok(rows.some(row=>JSON.parse(row.key)[1]==='entry:0'));assert.ok(!rows.some(row=>JSON.parse(row.key)[1]==='field:originalData'));assert.ok(rows.some(row=>JSON.parse(row.key)[1]==='original:entry:0'))}finally{db.close()}
 }finally{await sql.dispose();await other.dispose();rmSync(root,{recursive:true,force:true})}
})
