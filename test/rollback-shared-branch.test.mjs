import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {rollbackGlobalOwner,createRollbackGlobalVariables} from '../lib/rollback-global-variables.js'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
import {createRollbackWorldbookBindings} from '../lib/rollback-worldbook-bindings.js'
import {createRollbackExtensionSettings} from '../lib/rollback-extension-settings.js'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackCharacterHostTransform} from '../deploy/rollback-character-transform.mjs'
import {applyRollbackWorldbookHostTransform} from '../deploy/rollback-worldbook-transform.mjs'
import {applyRollbackWorldbookBindingsHostTransform} from '../deploy/rollback-worldbook-bindings-transform.mjs'
import {applyRollbackSharedBranchHostTransform,applyRollbackSharedBranchTurnTransform} from '../deploy/rollback-shared-branch-transform.mjs'
test('共享五库不再撤销当前值：换分支后旧53任务拒绝，新分支CAS仍正常',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'shared-branch-')),archive=path.join(root,'archive.db'),head=new DatabaseSync(archive),stores=[]
 head.exec('CREATE TABLE archive_head_fields(key TEXT PRIMARY KEY,value_json TEXT)');const field=(key,value)=>head.prepare('INSERT INTO archive_head_fields VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,JSON.stringify(value));field('id','fixture');field('timeline',{branchId:'old'})
 const profileData={readJson:async()=>undefined,remove:async()=>{}},archiveForChat=id=>{assert.equal(id,'fixture');return archive},options={dataRoot:root,profileData,archiveForChat},old={chatId:'fixture',turn:53,branchId:'old'},fresh={...old,branchId:'new'}
 try{
  const global=createRollbackGlobalVariables(options),extension=createRollbackExtensionSettings(options),characters=createRollbackCharacterVariables(options),books=createRollbackWorldbookResources(options),bindings=createRollbackWorldbookBindings(options);stores.push(global,extension,characters,books,bindings)
  await characters.read('cards/fixture.json',{hp:52});await books.read({kind:'card',cardPath:'cards/fixture.json'},{entries:[{id:0,content:'52'}]});await global.save({hp:52});await extension.save({hp:52},{});await bindings.save({'cards/fixture.json':null},{})
  const writes=[()=>global.save({hp:53},undefined,old),()=>extension.save({hp:53},{hp:52},old),()=>characters.save('cards/fixture.json',{hp:53},old),()=>books.save({kind:'card',cardPath:'cards/fixture.json'},{entries:[{id:0,content:'旧53'}]},{entries:[{id:0,content:'52'}]},old),()=>bindings.save({'cards/fixture.json':'worldbooks/旧53.json'},{'cards/fixture.json':null},old)]
  for(const write of writes)await write()
  // 回退仅换本档分支，资源库当前值不还原；之后旧任务拒，新分支写仍可正常CAS。
  field('timeline',{branchId:'new'});field('rollbackPending',null)
  assert.deepEqual(await global.read(),{hp:53});assert.deepEqual(await extension.read(),{hp:53});assert.deepEqual(await characters.read('cards/fixture.json'),{hp:53})
  for(const write of writes)await assert.rejects(write(),/已退役分支/)
  const second=createRollbackGlobalVariables(options);stores.push(second);await assert.rejects(second.save({hp:999},undefined,old),/已退役分支/);await assert.rejects(second.save({hp:999},undefined,{chatId:'fixture',turn:53}),/分支身份/)
  await global.save({hp:53},undefined,fresh);await extension.save({hp:54},{hp:53},fresh);await characters.save('cards/fixture.json',{hp:54},fresh);await books.save({kind:'card',cardPath:'cards/fixture.json'},{entries:[{id:0,content:'新53'}]},{entries:[{id:0,content:'旧53'}]},fresh);await bindings.save({'cards/fixture.json':'worldbooks/新53.json'},{'cards/fixture.json':'worldbooks/旧53.json'},fresh)
  field('rollbackPending',{id:'next-intent',turn:53});await assert.rejects(second.save({hp:99},undefined,fresh),/未完成/);field('rollbackPending',null)
  for(const name of ['prompt-template-variables.db','tavern-extension-settings.db','character-variables.db','worldbook-resources.db','worldbook-bindings.db']){const db=new DatabaseSync(path.join(root,name));try{assert.ok(!JSON.stringify(db.prepare('SELECT * FROM global_values').all()).includes('旧53'))}finally{db.close()}}
  assert.deepEqual(rollbackGlobalOwner({id:'fixture',sessionId:'s',timeline:{branchId:'new',operations:{body:{kind:'body',turn:53}}}}),fresh)
 }finally{for(const store of stores)await store.dispose();head.close();rmSync(root,{recursive:true,force:true})}
})
test('实际turn模板调用前先登记首次新分支，两消费者即使模板失败仍留下body基准',async()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-turn-orchestration.js',import.meta.url),'utf8'),next=applyRollbackSharedBranchTurnTransform(source);assert.equal(applyRollbackSharedBranchTurnTransform(next),next)
 const cases=[['await savePreparation({source:', '        const projected = await options.projectUserTemplate({chat,card,turn,text:runtimeUserText})'],['        await store.writeChat(chat)','        const projected = await options.projectUserTemplate({chat,card:await store.readCard(cardPathOf(chat), chat),turn,text:userText})']]
 for(const [anchor,call] of cases){const end=next.indexOf(call)+call.length,start=next.lastIndexOf(anchor,end);assert.ok(start>=0&&end>start);const order=[],chat={timeline:{branchId:'first',operations:{body:{businessBefore:{version:1}}}}}
  const run=new Function('savePreparation','store','options','chat','card','turn','runtimeUserText','userText','cardPathOf','return async()=>{'+next.slice(start,end)+'}') (async()=>order.push('archive'),{writeChat:async()=>order.push('archive'),readCard:async()=>({})},{projectUserTemplate:async()=>{order.push('template');assert.equal(order[0],'archive');throw Error('原创模板故障')}},chat,{},1,'fixture','fixture',()=> 'cards/fixture.json')
  await assert.rejects(run(),/模板故障/);assert.deepEqual(order,['archive','template']);assert.equal(chat.timeline.operations.body.businessBefore.version,1)
 }
})
test('实际Host五库确切archive解析绑定与两个显式全局写分支身份，标准升级幂等',()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8'),host=applyRollbackSharedBranchHostTransform(applyRollbackWorldbookBindingsHostTransform(applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(source))))))
 assert.equal(applyRollbackSharedBranchHostTransform(host),host)
 const begin=host.indexOf('  const rollbackSharedArchive=id=>'),end=host.indexOf('\n',host.indexOf('store.bindArchiveResolver(rollbackSharedArchive)',begin)),bound=[]
 const stores=Array.from({length:5},()=>({bindArchiveResolver:resolver=>bound.push(resolver)}))
 new Function('chatJournalStore','promptTemplateGlobalVariables','tavernExtensionSettings','characterVariableStore','rollbackWorldbookResources','rollbackWorldbookBindings',host.slice(begin,end))({rollbackArchivePath:id=>'fixture/'+id},...stores)
 assert.equal(bound.length,5);assert.ok(bound.every(resolver=>resolver('exact')==='fixture/exact'));assert.ok(host.includes('turn, branchId:chat.timeline?.branchId'));assert.ok(host.includes('branchId:input.chat.timeline?.branchId'))
})
