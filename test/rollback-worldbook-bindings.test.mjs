import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync,mkdirSync,writeFileSync,existsSync,unlinkSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {registerHooks} from 'node:module'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
import {createResourceGraph} from '../../../tools/live-plugin-src/lib/domain/resource-graph.js'
import {createRollbackWorldbookBindings} from '../lib/rollback-worldbook-bindings.js'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackCharacterHostTransform} from '../deploy/rollback-character-transform.mjs'
import {applyRollbackWorldbookHostTransform} from '../deploy/rollback-worldbook-transform.mjs'
import {applyRollbackWorldbookBindingsFileTransform,applyRollbackWorldbookBindingsHostTransform} from '../deploy/rollback-worldbook-bindings-transform.mjs'
test('绑定SQL迁入COMMIT后旧表退役故障retry不解析损坏残留，不覆盖SQL新值',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'bindings-retire-'));let first=true,reads=0
 const legacy={'cards/fixture.json':'worldbooks/52.json'},profileData={readJson:async()=>{reads++;if(reads>1)throw Error('残留旧表损坏不应读取');return legacy},remove:async()=>{if(first){first=false;throw Error('原创退役故障')}}},sql=createRollbackWorldbookBindings({dataRoot:root,profileData})
 try{await assert.rejects(sql.read(),/退役故障/);assert.deepEqual(await sql.read(),legacy);assert.equal(reads,1);await sql.save({'cards/fixture.json':null},legacy);assert.deepEqual(await sql.read(),{'cards/fixture.json':null})}finally{await sql.dispose();rmSync(root,{recursive:true,force:true})}
})
test('实际FileResource单多绑定SQL权威旧文件退役，独立当前绑定保留且另一卡不覆盖',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'worldbook-bindings-')),legacy=path.join(root,'.worldbook-bindings.json');let reads=0
 writeFileSync(legacy,JSON.stringify({'cards/fixture.json':'worldbooks/52.json'}),'utf8')
 const profileData={readJson:async()=>{reads++;return existsSync(legacy)?JSON.parse(readFileSync(legacy,'utf8')):undefined},remove:async()=>{if(existsSync(legacy))unlinkSync(legacy)}}
 const sql=createRollbackWorldbookBindings({dataRoot:root,profileData}),other=createRollbackWorldbookBindings({dataRoot:root,profileData})
 try{
  const original=readFileSync(new URL('../../../tools/live-plugin-src/lib/domain/file-resources.js',import.meta.url),'utf8'),next=applyRollbackWorldbookBindingsFileTransform(original);assert.equal(applyRollbackWorldbookBindingsFileTransform(next),next);assert.ok(!next.includes('worldBookBindingsPath'));assert.ok(!next.includes('worldBookBindingsChanged'));assert.ok(!next.includes('let worldBookBindings = null'));assert.ok(!next.includes('SQL资源身份生命周期尚未接管'))
  // 重建确切旧SQL文件缝布局：原作者消费者+SQL读写+全面禁用，升级必须得到同一当前源码。
  let legacySource='// [dsh-tavern-worldbook-bindings-sql:v1]\n'+original.replace("  const worldBookBindingsPath = path.join(dataRoot, '.worldbook-bindings.json')",'  const bindingBefore=new WeakMap()')
  const beginRead=legacySource.indexOf('  async function readWorldBookBindings()'),endRead=legacySource.indexOf('  async function worldBookBindingForCard(',beginRead),currentBegin=next.indexOf('  async function readWorldBookBindings()'),currentEnd=next.indexOf('  async function worldBookBindingForCard(',currentBegin)
  legacySource=legacySource.slice(0,beginRead)+next.slice(currentBegin,currentEnd)+legacySource.slice(endRead)
  for(const signature of ['bindWorldBook(cardPath, locator)','bindWorldBooks(cardPath, sources)','unbindWorldBook(cardPath)'])legacySource=legacySource.replace(signature,signature.slice(0,-1)+', owner)')
  legacySource=legacySource.replaceAll('await writeWorldBookBindings(bindings)','await writeWorldBookBindings(bindings,owner)').replaceAll('      if (worldBookBindingsChanged) await plan.write(worldBookBindingsPath, JSON.stringify(worldBookBindings, null, 2))',"      if(worldBookBindingsChanged)throw new Error('禁止世界书绑定写回文件journal')").replace('        await plan.write(worldBookBindingsPath, JSON.stringify(bindings, null, 2))',"        throw new Error('禁止世界书绑定写回文件journal')")
  legacySource=legacySource.replace('    const kind = resourceKind(normalized)\n',"    const kind = resourceKind(normalized)\n    if(kind==='card'||kind==='worldbook')throw new Error('SQL资源身份生命周期尚未接管，禁止文件层删除人物卡/世界书')\n").replace('    const kind = resourceKind(oldPath)\n',"    const kind = resourceKind(oldPath)\n    if(kind==='card'||kind==='worldbook')throw new Error('SQL资源身份生命周期尚未接管，禁止文件层改名人物卡/世界书')\n").replace('  function saveMvuCard({ sourcePath, targetPath, document, expectedSourceText, expectedTargetText, finalize }) {',"  function saveMvuCard({ sourcePath, targetPath, document, expectedSourceText, expectedTargetText, finalize }) {\n    return Promise.reject(new Error('SQL资源身份生命周期尚未接管，禁止文件层MVU转换复制与绑定'))")
  assert.notEqual(legacySource,next);assert.equal(applyRollbackWorldbookBindingsFileTransform(legacySource),next)
  const file=path.join(root,'resources.mjs'),base=new URL('../../../tools/live-plugin-src/lib/domain/',import.meta.url);writeFileSync(file,next.replaceAll(/from '(\.\.?\/[^']+)'/g,(_match,rel)=>"from '"+new URL(rel,base).href+"'"),'utf8')
  const {createFileResourceStore}=await import(pathToFileURL(file).href)
  for(const relative of ['cards/fixture.json','cards/other.json','worldbooks/52.json','worldbooks/53.json']){const target=path.join(root,'resources',relative);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,'{}','utf8')}
  const resources=createFileResourceStore({dataRoot:root,rollbackBindings:sql,files:{read:async()=>{throw Error('不应读旧绑定文件')},write:async()=>{throw Error('不应写绑定文件')}},mutations:{recover:async()=>{},run:async()=>{throw Error('禁止文件生命周期写')}}})
  assert.equal((await resources.worldBookBindingForCard('cards/fixture.json')).path,'worldbooks/52.json');assert.equal(existsSync(legacy),false)
  await resources.bindWorldBooks('cards/fixture.json',[{kind:'standalone',path:'worldbooks/53.json'},{kind:'embedded',cardPath:'cards/other.json'}],{chatId:'fixture',turn:53});assert.equal((await resources.worldBookBindingForCard('cards/fixture.json')).sources.length,2)
  assert.equal(sql.reserveRollback,undefined);assert.equal(sql.pruneRollback,undefined)
  const before=await other.read();await other.save({...before,'cards/other.json':null},before);assert.equal((await resources.worldBookBindingForCard('cards/fixture.json')).sources.length,2);assert.equal((await other.read())['cards/other.json'],null)
  const archive=path.join(root,'archive.db'),db=new DatabaseSync(archive);db.exec('CREATE TABLE archive_head_fields(key TEXT PRIMARY KEY,value_json TEXT)');db.prepare('INSERT INTO archive_head_fields VALUES(?,?)').run('id',JSON.stringify('fixture'));db.close()
  await resources.bindWorldBook('cards/fixture.json','worldbooks/53.json',{chatId:'fixture',turn:53});assert.equal((await resources.worldBookBindingForCard('cards/fixture.json')).path,'worldbooks/53.json')
  await assert.rejects(resources.remove('worldbooks/53.json'),/禁止文件生命周期写/)
  const check=new DatabaseSync(path.join(root,'worldbook-bindings.db'));try{assert.equal(check.prepare('SELECT COUNT(*) n FROM global_values').get().n,2);assert.ok(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='global_undo'").get().n===0);assert.ok(!JSON.stringify(check.prepare('SELECT * FROM global_values').all()).includes('version'))}finally{check.close()}
  assert.ok(reads>=1);assert.equal(existsSync(legacy),false)
  const hostSource=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8'),host=applyRollbackWorldbookBindingsHostTransform(applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(hostSource)))));assert.equal(applyRollbackWorldbookBindingsHostTransform(host),host)
  const begin=host.indexOf('  async function renameResource('),end=host.indexOf('  async function deleteResource(',begin);let graphCalls=0
  const guards=new Function('resourceKind','resourceGraph',host.slice(begin,end)+';return {renameResource,deleteLibraryResource}')(value=>value.startsWith('cards/')?'card':value.startsWith('worldbooks/')?'worldbook':'source',{rename:async()=>{graphCalls++;return {}},remove:async()=>{graphCalls++;return {path:'materials/fixture.txt'}}})
  await guards.renameResource('cards/fixture.json','new');await guards.deleteLibraryResource('worldbooks/53.json','worldbook');assert.equal(graphCalls,2);await guards.deleteLibraryResource('materials/fixture.txt','source');assert.equal(graphCalls,3);assert.ok(!host.includes('assertSqlResourceLifecycle('))
  assert.ok(host.includes('versions, await rollbackWorldbookBindings.version(),'));assert.ok(!host.includes('rollbackWorldbookBindings.pruneRollback('))
  const oldHost=host.replace('  async function renameResource(resourcePath, name)',"  // [dsh-tavern-resource-lifecycle-guard:v1] 文件资源图写意图之前拒绝，不留下永远无法执行的journal。\n  function assertSqlResourceLifecycle(resourcePath){const kind=resourceKind(resourcePath);if(kind==='card'||kind==='worldbook')throw new Error('SQL资源身份生命周期尚未接管，禁止文件层改名或删除')}\n  async function renameResource(resourcePath, name)").replace('return await resourceGraph.rename(resourcePath, name)','assertSqlResourceLifecycle(resourcePath);return await resourceGraph.rename(resourcePath, name)').replace('  async function deleteLibraryResource(resourcePath, expectedKind) {','  async function deleteLibraryResource(resourcePath, expectedKind) {\n    assertSqlResourceLifecycle(resourcePath)')
  assert.notEqual(oldHost,host);assert.equal(applyRollbackWorldbookBindingsHostTransform(oldHost),host)
 }finally{await sql.dispose();await other.dispose();rmSync(root,{recursive:true,force:true})}
})

test('实际资源图改名文件后SQL故障重试保当前卡书绑定，删除去旧路径且无稳定ID层',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'resource-path-sql-')),characters=createRollbackCharacterVariables({dataRoot:root}),books=createRollbackWorldbookResources({dataRoot:root}),bindings=createRollbackWorldbookBindings({dataRoot:root,profileData:{readJson:async()=>undefined,remove:async()=>{}}})
 try{
  const source=readFileSync(new URL('../../../tools/live-plugin-src/lib/domain/file-resources.js',import.meta.url),'utf8'),patched=applyRollbackWorldbookBindingsFileTransform(source),base=new URL('../../../tools/live-plugin-src/lib/domain/',import.meta.url)
  await characters.read('cards/collision.json',{hp:1});await characters.read('cards/destination.json',{hp:2})
  await assert.rejects(characters.movePath('cards/collision.json','cards/destination.json'),/目标已存在/);assert.deepEqual(await characters.read('cards/collision.json'),{hp:1});await characters.movePath('cards/collision.json',null);await characters.movePath('cards/destination.json',null)
  const file=path.join(root,'resources.mjs');writeFileSync(file,patched.replaceAll(/from '(\.\.?\/[^']+)'/g,(_m,rel)=>"from '"+new URL(rel,base).href+"'"),'utf8')
  const {createFileResourceStore}=await import(pathToFileURL(file).href)
  for(const name of ['cards/a.json','cards/other.json','worldbooks/a.json']){const target=path.join(root,'resources',name);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,'{}','utf8')}
  await characters.read('cards/a.json',{hp:99});await books.read({kind:'card',cardPath:'cards/a.json'},{entries:[{id:0,content:'手改嵌入书'}]});await books.read({kind:'standalone',path:'worldbooks/a.json'},{entries:{0:{content:'手改独立书'}}})
  await bindings.save({'cards/a.json':{kind:'embedded',cardPath:'cards/a.json'},'cards/other.json':{version:2,sources:[{kind:'embedded',cardPath:'cards/a.json'},{kind:'standalone',path:'worldbooks/a.json'}]}},{})
  let fail=true,operation=null,chat={id:'fixture',cardPath:'cards/a.json',workspace:{}},index={chats:[{id:'fixture',cardPath:chat.cardPath}]}
  const resources=createFileResourceStore({dataRoot:root,rollbackBindings:bindings,characterVariables:characters,worldbookResources:()=>({...books,movePath:async(...args)=>{if(fail){fail=false;throw Error('原创文件改名后SQL故障')}return books.movePath(...args)}})})
  const graph=createResourceGraph({resources,chats:{readIndex:async()=>index,writeIndex:async value=>index=value,readChat:async()=>chat,writeChat:async value=>chat=value},operations:{read:async()=>operation,write:async value=>operation=structuredClone(value),remove:async()=>operation=null}})
  await assert.rejects(graph.rename('cards/a.json','renamed'),/SQL故障/);assert.ok(operation);assert.equal(existsSync(path.join(root,'resources/cards/renamed.json')),true)
  await graph.recover();assert.equal(operation,null);assert.equal(chat.cardPath,'cards/renamed.json');assert.deepEqual(await characters.read('cards/renamed.json'),{hp:99});assert.deepEqual(await books.read({kind:'card',cardPath:'cards/renamed.json'}),{entries:[{id:0,content:'手改嵌入书'}]})
  assert.equal((await bindings.read())['cards/other.json'].sources[0].cardPath,'cards/renamed.json')
  await graph.rename('worldbooks/a.json','renamed.json');assert.equal((await bindings.read())['cards/other.json'].sources[1].path,'worldbooks/renamed.json');assert.equal((await books.read({kind:'standalone',path:'worldbooks/renamed.json'})).entries[0].content,'手改独立书')
  await graph.remove('cards/renamed.json','card');assert.equal(existsSync(path.join(root,'resources/cards/renamed.json')),false);assert.equal((await bindings.read())['cards/renamed.json'],undefined);assert.equal((await bindings.read())['cards/other.json'].sources.length,1)
  await graph.remove('worldbooks/renamed.json','worldbook');assert.deepEqual((await bindings.read())['cards/other.json'].sources,[])
  for(const name of ['character-variables.db','worldbook-resources.db']){const db=new DatabaseSync(path.join(root,name));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM global_values').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM global_scopes').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='resource_paths'").get().n,0)}finally{db.close()}}
 }finally{for(const sql of [characters,books,bindings])await sql.dispose();rmSync(root,{recursive:true,force:true})}
})

test('实际FileResource普通复制与新MVU转换当前SQL卡书，已有副本混合写前拒绝且提交后故障可重试',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'resource-copy-sql-')),characters=createRollbackCharacterVariables({dataRoot:root}),books=createRollbackWorldbookResources({dataRoot:root}),bindings=createRollbackWorldbookBindings({dataRoot:root,profileData:{readJson:async()=>undefined,remove:async()=>{}}})
 try{
  const source=readFileSync(new URL('../../../tools/live-plugin-src/lib/domain/file-resources.js',import.meta.url),'utf8'),patched=applyRollbackWorldbookBindingsFileTransform(source),base=new URL('../../../tools/live-plugin-src/lib/domain/',import.meta.url)
  const file=path.join(root,'resources.mjs');writeFileSync(file,patched.replaceAll(/from '(\.\.?\/[^']+)'/g,(_m,rel)=>"from '"+new URL(rel,base).href+"'"),'utf8');const {createFileResourceStore}=await import(pathToFileURL(file).href)
  const sourcePath='cards/source.json',document={spec:'chara_card_v3',data:{name:'原创卡',description:'定义内容',first_mes:'原创开场',extensions:{tavern_helper:{variables:{hp:1}}},character_book:{entries:[{id:0,keys:[],content:'文件旧种子',enabled:true}]}}}
  const target=path.join(root,'resources',sourcePath);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(document),'utf8')
  await characters.read(sourcePath,{hp:99});await books.read({kind:'card',cardPath:sourcePath},{entries:[{id:0,keys:[],content:'SQL当前手改',enabled:true}]})
  const resources=createFileResourceStore({dataRoot:root,rollbackBindings:bindings,characterVariables:characters,worldbookResources:()=>books})
  const current=await resources.readCard(sourcePath);assert.equal(current.data.extensions.tavern_helper.variables.hp,99);assert.equal(current.data.character_book.entries[0].content,'SQL当前手改')
  // 真实MVU inspect/read/snapshot；不调用未打包DOM验证和宏显示。
  const dependencies=registerHooks({resolve(spec,context,next){if(spec==='./tavern-macro-engine.js')return {url:'fixture-copy-macros:unused',shortCircuit:true};if(['jsdom','marked','acorn'].includes(spec))return {url:'fixture-copy-display:'+spec,shortCircuit:true};return next(spec,context)},load(url,context,next){if(url.startsWith('fixture-copy-'))return {format:'module',source:"const unused=()=>{throw Error('本转换读口断言禁止调用显示或宏依赖')};export const renderTavernMacros=unused;export const JSDOM=unused;export const VirtualConsole=unused;export const marked=unused;export const parseExpressionAt=unused",shortCircuit:true};return next(url,context)}})
  let createMvuConversion;try{({createMvuConversion}=await import('../../../tools/live-plugin-src/lib/domain/mvu-conversion.js'))}finally{dependencies.deregister()}
  const conversion=createMvuConversion({resources}),inspection=await conversion.convert({action:'inspect',sourcePath,name:'消费副本',detail:'catalog'})
  const fields=await conversion.convert({action:'read',sourcePath,sourceRevision:inspection.sourceRevision,paths:['/extensions/tavern_helper/variables/hp','/character_book/entries/0/content']});assert.ok(JSON.stringify(fields).includes('SQL当前手改'));assert.ok(JSON.stringify(fields).includes('99'))
  const copied=await resources.copyCard(sourcePath,'普通副本');assert.deepEqual(await characters.read(copied.path),{hp:99});assert.equal((await books.read({kind:'card',cardPath:copied.path})).entries[0].content,'SQL当前手改')
  const mvuPath='cards/mvu.json',mvu=structuredClone(current);mvu.data.name='新MVU副本';mvu.data.character_book.entries.push({id:1,keys:[],comment:'[mvu_update]规则',content:'新规则',enabled:true})
  let fault=true;const originalSave=bindings.save;bindings.save=async(...args)=>{const result=await originalSave(...args);if(fault){fault=false;throw Error('原创绑定提交后回包故障')}return result}
  const input={sourcePath,targetPath:mvuPath,document:mvu,expectedSourceText:await resources.readText(sourcePath),expectedTargetText:undefined}
  await assert.rejects(resources.saveMvuCard(input),/绑定提交后/);assert.equal(existsSync(path.join(root,'resources',mvuPath)),true)
  const expectedTargetText=await resources.readText(mvuPath);await resources.saveMvuCard({...input,expectedTargetText});const published=JSON.parse(readFileSync(path.join(root,'resources',mvuPath),'utf8'));assert.equal(published.data.extensions.tavern_helper.variables,undefined);assert.deepEqual(published.data.character_book,{entries:[]});assert.deepEqual(JSON.parse(await resources.readText(mvuPath)),mvu);assert.equal((await bindings.read())[mvuPath].cardPath,mvuPath);assert.equal((await books.read({kind:'card',cardPath:mvuPath})).entries.length,2);assert.deepEqual(await characters.read(mvuPath),{hp:99})
  const changed=structuredClone(mvu);changed.data.description='不应部分落文件';changed.data.character_book.entries[0].content='混合改运行书';const versions=[await characters.version(),await books.version(),await bindings.version()],raw=readFileSync(path.join(root,'resources',mvuPath),'utf8')
  await assert.rejects(resources.saveMvuCard({...input,document:changed,expectedTargetText:await resources.readText(mvuPath)}),/已有MVU副本跨文件\/SQL/);assert.equal(readFileSync(path.join(root,'resources',mvuPath),'utf8'),raw);assert.deepEqual([await characters.version(),await books.version(),await bindings.version()],versions)
  await characters.save(sourcePath,{hp:100},undefined,{hp:99});await assert.rejects(resources.saveMvuCard({...input,targetPath:'cards/stale.json'}),/已变化/);assert.equal(existsSync(path.join(root,'resources/cards/stale.json')),false)
  assert.equal(existsSync(path.join(root,'.worldbook-bindings.json')),false);assert.equal(readFileSync(target,'utf8'),JSON.stringify(document));assert.deepEqual(await characters.read(sourcePath),{hp:100});assert.equal((await books.read({kind:'card',cardPath:sourcePath})).entries[0].content,'SQL当前手改')
 }finally{for(const sql of [characters,books,bindings])await sql.dispose();rmSync(root,{recursive:true,force:true})}
})
