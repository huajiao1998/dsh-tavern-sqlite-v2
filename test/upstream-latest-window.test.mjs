// 真实作者bounded消费者→同库SQLite；只用自有合成库，显示投影不是本闸验收对象。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
const testRequire=createRequire(new URL('../../../tools/sql-test-kit/package.json',import.meta.url))
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(error){
 if(error.code!=='ERR_MODULE_NOT_FOUND'||!context.parentURL?.includes('/upstream25-author-fixture/')||specifier.startsWith('.')||specifier.startsWith('node:'))throw error
 return next(pathToFileURL(testRequire.resolve(specifier)).href,context)
}}})
const base=new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5c69907994df9f432b8898168ce5dff371929c2a/tavern-plugin/lib/domain/',import.meta.url)
const [copy,mutation,scoped,helper,bounded]=await Promise.all(['copy-json-tree.js','json-mutation.js','scoped-messages.js','tavern-helper-context.js','bounded-history.js'].map(file=>import(new URL(file,base))))
const helpers={...copy,...mutation,...scoped}
for(const name of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[name]=v=>v===undefined?undefined:structuredClone(v)
function fixture(t){
 const root=mkdtempSync(path.join(os.tmpdir(),'tavern-latest-window-'))
 const store=createChatSqliteStore({dataRoot:root,helpers})
 t.after(()=>{store.dispose();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('tavern-latest-window-'));rmSync(root,{recursive:true,force:true})})
 return {root,store}
}
const tree=score=>({stat_data:{score},schema:{}})
function seed(id){return {id,sessionId:'synthetic-session',_storageRevision:1,mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,
 timeline:{schemaVersion:1,branchId:'b',revision:1,operations:{},participants:{},checkpoints:[]},
 messages:Array.from({length:100},(_,i)=>({role:i%2?'assistant':'user',turn:Math.floor(i/2)+1,text:'合成-'+i}))}}
const reader=store=>bounded.createBoundedHistory({links:async()=>({'synthetic-session':'synthetic'}),readWindow:store.readWindow})
test('bounded真实消费者：变量在窗口外，按worldMessage补读同revision一楼，不再完整读降级',async t=>{
 const {store}=fixture(t),chat=seed('synthetic');chat.messages[1].variables=[tree(7)]
 await store.update(chat.id,()=>chat)
 const window=await store.readWindow(chat.id,{limit:48,includeCheckpoints:true})
 assert.equal(window.from,52);assert.equal(window.worldMessage,1)
 const selected=await reader(store).read(chat.id,undefined,{lastAssistant:true,lastVariables:true})
 assert.ok(selected);assert.equal(scoped.isScopedMessages(selected.chat.messages),true)
 assert.equal(selected.chat.messages.length,100);assert.deepEqual(helper.lastTavernHelperVariables(selected.chat.messages),tree(7))
 assert.equal(Object.hasOwn(selected.chat.messages,2),false);assert.equal(selected.revision,1)
 const oldPage=await store.readWindow(chat.id,{limit:1,before:2,revision:1,fields:['_storageRevision']})
 assert.equal(oldPage.revision,selected.revision);assert.equal(oldPage.from,1)
})
test('世界变量楼沿Helper真语义：空对象/null合法、Helper不抢、swipe及无变量均正确',async t=>{
 const {store}=fixture(t),chat=seed('synthetic');chat.messages[1].variables=[tree(1)]
 chat.messages[4].variables=[{},null];chat.messages[4].swipes=['s0','s1'];chat.messages[4].swipeId=1
 chat.messages[99]={role:'tavern-helper',text:'合成辅助',variables:[tree(99)]}
 await store.update(chat.id,()=>chat)
 assert.equal((await store.readWindow(chat.id)).worldMessage,4)
 assert.equal(helper.lastTavernHelperVariables((await reader(store).read(chat.id,undefined,{lastVariables:true})).chat.messages),null)
 await store.patch(chat.id,1,[{op:'set',path:['_storageRevision'],value:2},{op:'set',path:['messages',4,'swipeId'],value:0}])
 assert.deepEqual(helper.lastTavernHelperVariables((await reader(store).read(chat.id,undefined,{lastVariables:true})).chat.messages),{})
 await store.patch(chat.id,2,[{op:'set',path:['_storageRevision'],value:3},{op:'set',path:['messages',4,'variables'],value:[]},{op:'set',path:['messages',1,'variables'],value:[]}])
 assert.equal((await store.readWindow(chat.id)).worldMessage,null)
 assert.ok(await reader(store).read(chat.id,undefined,{lastVariables:true}))
})
test('K4冷楼依既有同库变量快照补定位；所选槽空值仍覆盖旧MVU-ready树',async t=>{
 const {store,root}=fixture(t),chat=seed('synthetic')
 for(const index of [1,3,5,7,9,11])chat.messages[index].variables=[tree(index)]
 await store.update(chat.id,()=>chat)
 // 多树触发K4，侧查第1楼确已剥离，快照仍在；修改后楼选空变量，语义不是MVU-ready。
 const db=new DatabaseSync(path.join(root,'chats',chat.id,'archive.db'))
 try{assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT message_json FROM archive_messages WHERE message_index=1').get().message_json),'variables'),false)}finally{db.close()}
 const changes=[{op:'set',path:['_storageRevision'],value:2},...[3,5,7,9,11].map(index=>({op:'set',path:['messages',index,'variables'],value:[]}))]
 await store.patch(chat.id,1,changes)
 assert.equal((await store.readWindow(chat.id)).worldMessage,1)
 assert.deepEqual(helper.lastTavernHelperVariables((await reader(store).read(chat.id,undefined,{lastVariables:true})).chat.messages),tree(1))
})
test('冷读句柄没有历史change证据：明确undefined，不伪造索引或历史正文',async t=>{
 const {store,root}=fixture(t),chat=seed('synthetic');await store.update(chat.id,()=>chat)
 await store.patch(chat.id,1,[{op:'set',path:['_storageRevision'],value:2},{op:'set',path:['title'],value:'合成改名'}])
 const cold=createChatSqliteStore({dataRoot:root,helpers})
 try{
  assert.equal(await cold.readChangedIndices(chat.id,1,{limit:2048}),undefined)
  assert.deepEqual((await cold.readChangedIndices(chat.id,2,{limit:0})).indices,[])
  assert.equal(await bounded.readRowsAt(cold.readWindow,chat.id,1,[]),undefined)
 }finally{cold.dispose()}
})
test('change覆盖limit是revision跨度不截断indices；历史rowsAt不可用仍明确退出',async t=>{
 const {store}=fixture(t),chat=seed('synthetic');await store.update(chat.id,()=>chat)
 await store.patch(chat.id,1,[{op:'set',path:['_storageRevision'],value:2},...[0,1,2].map(index=>({op:'set',path:['messages',index,'text'],value:'变更-'+index}))])
 assert.equal(await store.readChangedIndices(chat.id,1,{limit:0}),undefined)
 assert.deepEqual((await store.readChangedIndices(chat.id,1,{limit:1})).indices,[0,1,2])
 assert.deepEqual((await store.readChangedIndices(chat.id,1,{limit:2048})).indices,[0,1,2])
 assert.deepEqual((await store.readChangedIndices(chat.id,2,{limit:0})).indices,[])
 assert.equal(await bounded.readRowsAt(store.readWindow,chat.id,1,[]),undefined)
 await assert.rejects(()=>store.readChangedIndices(chat.id,1,{limit:-1}),/coverage limit/)
})
