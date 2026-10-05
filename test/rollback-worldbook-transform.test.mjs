import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {isDeepStrictEqual} from 'node:util'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
import {applyRollbackWorldbookLibraryTransform,applyRollbackWorldbookAdapterTransform,applyRollbackWorldbookHostTransform} from '../deploy/rollback-worldbook-transform.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackCharacterHostTransform} from '../deploy/rollback-character-transform.mjs'
test('实际worldbook Library读编辑导出/模板与adapter共用SQL归属，更新不写文件',async()=>{
 const source=readFileSync(new URL('../../../tools/live-plugin-src/lib/domain/worldbook-library.js',import.meta.url),'utf8'),next=applyRollbackWorldbookLibraryTransform(source);assert.equal(applyRollbackWorldbookLibraryTransform(next),next)
 const root=mkdtempSync(path.join(os.tmpdir(),'worldbook-consumer-')),sql=createRollbackWorldbookResources({dataRoot:root})
 try{
  const file=path.join(root,'library.mjs'),base=new URL('../../../tools/live-plugin-src/lib/domain/',import.meta.url)
  writeFileSync(file,next.replaceAll(/from '(\.\/[^']+)'/g,(_match,rel)=>"from '"+new URL(rel,base).href+"'"),'utf8')
  const {createWorldBookLibrary}=await import(pathToFileURL(file).href)
  const seed={entries:{'0':{uid:0,key:['fixture'],content:'52',disable:false,order:100}}},locator={kind:'standalone',path:'worldbooks/fixture.json'}
  let reads=0
  const library=createWorldBookLibrary({rollbackResources:sql,resources:{readText:async()=>{if(reads++)throw Error('不应重读旧文件');return JSON.stringify(seed)},write:async()=>{throw Error('不应文件写')}},cards:{},normalizePath:value=>value,removeStandalone:async()=>{}})
  const before=(await library.export(locator)).document;assert.equal(before.entries['0'].content,'52')
  await library.replaceNative(locator,{...before,entries:{'0':{...before.entries['0'],content:'旧53'}}},{chatId:'fixture',turn:53})
  assert.equal((await library.export(locator)).document.entries['0'].content,'旧53');assert.equal(sql.pruneRollback,undefined)
  const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8'),patched=applyRollbackWorldbookAdapterTransform(adapter),start=patched.indexOf('  async function updateBoundWorldbook('),end=patched.indexOf('  async function exportBoundWorldbook(',start)
  const call=new Function('options','rollbackGlobalOwner',patched.slice(start,end)+';return updateBoundWorldbook')({worldBooks:library},()=>({chatId:'fixture',turn:53}))
  await call({chat:{id:'fixture'},record:{source:locator}},{},{...before,entries:{'0':{...before.entries['0'],content:'新53'}}});assert.equal((await library.export(locator)).document.entries['0'].content,'新53');assert.equal(reads,1)
  const embedded={kind:'card',cardPath:'cards/fixture.json'},card={name:'fixture',character_book:{entries:[{id:0,keys:['fixture'],content:'52'}]}}
  const bound=createWorldBookLibrary({rollbackResources:sql,resources:{list:async()=>[],bindingForCard:async()=>({kind:'standalone',path:locator.path,available:true})},cards:{listPaths:async()=>[embedded.cardPath],read:async()=>card},normalizePath:value=>value,removeStandalone:async()=>{}})
  const snapshot=await bound.templateSnapshot(embedded.cardPath,card);assert.equal(snapshot.worldbooks[snapshot.worldName].entries['0'].content,'新53');assert.equal(await bound.templateSnapshot(embedded.cardPath,card),snapshot)
  bound.clearRollbackState();const fresh=await bound.templateSnapshot(embedded.cardPath,card);assert.notEqual(fresh,snapshot);assert.equal(fresh.worldbooks[fresh.worldName].entries['0'].content,'新53')
  const embeddedBefore=(await bound.export(embedded)).document;await bound.replaceNative(embedded,{...embeddedBefore,entries:{'0':{...embeddedBefore.entries['0'],content:'嵌入旧53'}}},{chatId:'embedded-fixture',turn:53});assert.equal((await bound.export(embedded)).document.entries['0'].content,'嵌入旧53');assert.equal(sql.pruneRollback,undefined)
  const hostSource=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8'),host=applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(hostSource))));assert.equal(applyRollbackWorldbookHostTransform(host),host)
  const projectStart=host.indexOf('  async function projectCharacterVariables'),projectEnd=host.indexOf('  const fileResources',projectStart)
  const project=new Function('characterVariableStore','rollbackWorldbookResources','normalizeResourcePath',host.slice(projectStart,projectEnd)+';return projectCharacterVariables')({read:async()=>({})},sql,value=>value)
  const workspace={raw:{data:{character_book:card.character_book},spec:'chara_card_v3'}}
  await bound.replaceNative(embedded,{...embeddedBefore,entries:{'0':{...embeddedBefore.entries['0'],content:'当前嵌入53'}}},{chatId:'embedded-fixture',turn:53});assert.equal((await project(embedded.cardPath,workspace)).raw.data.character_book.entries[0].content,'当前嵌入53');assert.equal(workspace.raw.data.character_book.entries[0].content,'52')
  assert.ok(host.includes('worldBooks.clearRollbackState()'));assert.ok(host.includes('await rollbackWorldbookResources.version(), await characterVariableStore.version()'))
  const currentEmbedded=await sql.read(embedded);await sql.save(embedded,null,currentEmbedded,{chatId:'embedded-fixture',turn:53});assert.equal((await project(embedded.cardPath,workspace)).raw.data.character_book,null);await assert.rejects(bound.export(embedded),/没有自带世界书/);assert.equal((await bound.catalog()).embedded.length,0)
  const emptyLibrary=createWorldBookLibrary({rollbackResources:sql,resources:{bindingForCard:async()=>({kind:'default'})},cards:{read:async()=>({name:'无书'})},normalizePath:value=>value,removeStandalone:async()=>{}});await assert.rejects(emptyLibrary.export({kind:'card',cardPath:'cards/no-book.json'}),/没有自带世界书/);assert.equal(await sql.read({kind:'card',cardPath:'cards/no-book.json'}),null);assert.equal((await emptyLibrary.binding('cards/no-book.json')).kind,'none');await sql.save({kind:'card',cardPath:'cards/no-book.json'},{entries:[]},null);assert.equal((await emptyLibrary.binding('cards/no-book.json')).kind,'embedded')
  const editStart=host.indexOf('  async function updateCard('),editEnd=host.indexOf('  async function replaceCardVariables(',editStart),files=[]
  const preparation={update:({card,patch})=>{const changed=structuredClone(card);changed.raw.data.character_book=patch.character_book;return {card:changed,view:{},changed:true,nameChanged:false}},present:({card,as})=>as==='raw'?card.raw:{variables:{}}}
  const edit=new Function('rollbackCardEqual','readCardWorkspace','cardPreparation','characterVariableStore','rollbackWorldbookResources','normalizeResourcePath','fileResources','bumpCardProjectionRevision','syncCardName',host.slice(editStart,editEnd)+';return updateCard')(isDeepStrictEqual,async()=>project(embedded.cardPath,workspace),preparation,{read:async()=>({}),save:async()=>({})},sql,value=>value,{writeWorking:async(_path,text)=>files.push(JSON.parse(text))},async()=>{},async()=>{})
  await edit(embedded.cardPath,{character_book:{entries:[{id:0,content:'新增book'}]}});assert.equal((await project(embedded.cardPath,workspace)).raw.data.character_book.entries[0].content,'新增book');assert.equal(files.length,0)
  await edit(embedded.cardPath,{character_book:null});assert.equal((await project(embedded.cardPath,workspace)).raw.data.character_book,null);assert.equal(files.length,0)
 }finally{await sql.dispose();rmSync(root,{recursive:true,force:true})}
})
