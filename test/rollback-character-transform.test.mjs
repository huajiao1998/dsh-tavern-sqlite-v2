import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
import {applyRollbackCharacterHostTransform,applyRollbackCharacterAdapterTransform} from '../deploy/rollback-character-transform.mjs'
import {applyRollbackGlobalHostTransform,applyRollbackGlobalAdapterTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
test('实际人物保存及extensions消费者保SQL当前编辑；版本投影与任务身份不变，不写卡文件',async()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8')
 const host=applyRollbackCharacterHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(source)));assert.equal(applyRollbackCharacterHostTransform(host),host)
 const root=mkdtempSync(path.join(os.tmpdir(),'character-consumer-')),sql=createRollbackCharacterVariables({dataRoot:root})
 try{
  const workspace={raw:{spec:'chara_card_v3',data:{name:'fixture',extensions:{tavern_helper:{variables:{hp:52}}}}}}
  const start=host.indexOf('  async function projectCharacterVariables'),end=host.indexOf('  const fileResources',start)
  const project=new Function('characterVariableStore','normalizeResourcePath',host.slice(start,end)+';return projectCharacterVariables')(sql,value=>value)
  assert.equal((await project('cards/fixture.json',workspace)).raw.data.extensions.tavern_helper.variables.hp,52)
  const begin=host.indexOf('  async function replaceCardVariables('),finish=host.indexOf('  async function syncCardName(',begin)
  const save=new Function('readCardWorkspace','characterVariableStore','normalizeResourcePath','bumpCardProjectionRevision',host.slice(begin,finish)+';return replaceCardVariables')(async()=>project('cards/fixture.json',workspace),sql,value=>value,async()=>{})
  await save('cards/fixture.json',{hp:53,new:'旧53'},{chatId:'fixture',turn:53});assert.equal((await project('cards/fixture.json',workspace)).raw.data.extensions.tavern_helper.variables.hp,53)
  assert.equal(sql.pruneRollback,undefined);assert.deepEqual((await project('cards/fixture.json',workspace)).raw.data.extensions.tavern_helper.variables,{hp:53,new:'旧53'});assert.equal(workspace.raw.data.extensions.tavern_helper.variables.hp,52)
  const revBegin=host.indexOf('  async function cardProjectionRevision('),revEnd=host.indexOf('  async function bumpCardProjectionRevision(',revBegin)
  const revision=new Function('readJson','CARD_PROJECTION_REVISIONS','str','characterVariableStore',host.slice(revBegin,revEnd)+';return cardProjectionRevision')(async()=>({cards:{}}),'unused',String,sql)
  const oldRevision=await revision('cards/fixture.json');await sql.save('cards/fixture.json',{hp:99});assert.ok(await revision('cards/fixture.json')>oldRevision)
  assert.ok(!host.slice(begin,finish).includes('updateCard('));assert.ok(host.includes('card: await projectCharacterVariables(cardPath,workspace)'));assert.ok(!host.includes('characterVariableStore.reserveRollback('));assert.ok(!host.includes('characterVariableStore.pruneRollback('))
  const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8'),next=applyRollbackCharacterAdapterTransform(applyRollbackGlobalAdapterTransform(adapter));assert.equal(applyRollbackCharacterAdapterTransform(next),next);assert.ok(next.includes('{}, str(sessionId), rollbackGlobalOwner(chat))'))
  const branchStart=next.indexOf("    if (option && option.type === 'character')"),branchEnd=next.indexOf('    const canPatch',branchStart)
  const writes=[],chat={id:'fixture',cardPath:'cards/fixture.json'}
  const mutation=new Function('options','settlementTransactions','str','chat','serializeWorldbook','rollbackGlobalOwner','return async function(option,variables,sessionId){'+next.slice(branchStart,branchEnd)+'}')({characterVariables:{save:async(...args)=>{writes.push(args);return args[1]}}},new Map(),String,chat,async(_key,work)=>work(),()=>({chatId:'fixture',turn:53}))
  await mutation({type:'character'},{hp:53},'fixture-session');assert.deepEqual(writes[0],['cards/fixture.json',{hp:53},'fixture-session',{chatId:'fixture',turn:53}])
  const editStart=host.indexOf('  async function updateCard('),editEnd=host.indexOf('  async function replaceCardVariables(',editStart)
  const fileWrites=[],preparation={update:({card,patch})=>{const changed=structuredClone(card);changed.raw.data.name=patch.name;return {card:changed,view:{name:patch.name},changed:true,nameChanged:false}},present:({card})=>({variables:card.raw.data.extensions.tavern_helper.variables})}
  const edit=new Function('readCardWorkspace','cardPreparation','characterVariableStore','normalizeResourcePath','fileResources','bumpCardProjectionRevision','syncCardName',host.slice(editStart,editEnd)+';return updateCard')(async()=>project('cards/fixture.json',workspace),preparation,sql,value=>value,{writeWorking:async(_path,text)=>fileWrites.push(JSON.parse(text))},async()=>{},async()=>{})
  await save('cards/fixture.json',{hp:53,new:'运行53'}, {chatId:'fixture',turn:53});await edit('cards/fixture.json',{name:'新名字'})
  assert.equal(fileWrites[0].raw.data.extensions.tavern_helper.variables,undefined);assert.deepEqual(await sql.read('cards/fixture.json'),{hp:53,new:'运行53'})
  assert.deepEqual(await sql.read('cards/fixture.json'),{hp:53,new:'运行53'})
 }finally{await sql.dispose();rmSync(root,{recursive:true,force:true})}
})
