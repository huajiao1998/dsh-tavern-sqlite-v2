import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {readVariables} from '../lib/read-variables.js'
import {rewriteSaveTables} from '../lib/db-save-identities.js'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
const chatOf=stat_data=>({id:'chat-issue15',_storageRevision:1,messages:[{role:'assistant',turn:1,variables:[{stat_data}]}]})
const pages=(chat,args)=>{const out=[];let cursor;const seen=new Set();do{const page=readVariables(chat,{...args,...(cursor?{cursor}:{})});out.push(page);cursor=page.nextCursor;if(cursor){assert.ok(!seen.has(cursor),'游标必须推进');seen.add(cursor)}assert.ok(out.length<100,'页数有界')}while(cursor);return out}

test('B02 UTF-8预算：中文ASCII条目逐页不超4000字节且不漏不重',()=>{
 for(const char of ['汉','a']){
  const stat=Object.fromEntries(Array.from({length:30},(_,i)=>['字段'+i,char.repeat(200)])),all=pages(chatOf(stat),{action:'read',limit:50})
  for(const p of all)assert.ok(p.entries.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e),'utf8'),0)<=4000)
  assert.deepEqual(all.flatMap(p=>p.entries.map(e=>e.path)),Object.keys(stat).map(k=>'/'+k))
 }
})
test('B03 Unicode分页预览：代理对跨边界完整且多页拼接等于原文',()=>{
 const text='a'.repeat(999)+'😀'+'中'.repeat(1000)+'😀end',chat=chatOf({text})
 const all=pages(chatOf({text}),{action:'read',path:'/text'})
 assert.ok(all.every(p=>p.value.isWellFormed()));assert.equal(all.map(p=>p.value).join(''),text)
 const preview=readVariables(chatOf({text:'a'.repeat(199)+'😀end'}),{action:'read'})
 assert.ok(preview.entries[0].value.isWellFormed(),true);assert.equal(preview.entries[0].truncated,true)
})
test('B04 单项超限：控制字符转义后超预算必须明确报错而非重复空游标',()=>{
 assert.throws(()=>readVariables(chatOf({['\u0001'.repeat(700)]:1})),/单项超过4000字节/)
 const chat=chatOf({first:1,['\u0001'.repeat(700)]:2})
 const first=readVariables(chat,{limit:1});assert.ok(first.nextCursor)
 assert.throws(()=>readVariables(chat,{limit:1,cursor:first.nextCursor}),/单项超过4000字节/)
})
test('B06 私有载荷：消息插件数据同名身份保持原值且系统引用仍重映射拒越界',()=>{
 const source={id:'chat-source',sessionId:'session-source',timeline:{branchId:'old'}},identity={chatId:'chat-target',sessionId:'session-target',branchId:'new',sessions:new Map([['session-source','session-target']])}
 for(const sid of ['session-source','plugin-private-session']){
  const privateData={custom:{sessionId:sid,chatId:'chat-source',branchId:'old',sessionCuts:{private:99}}}
  const input={archive_head_fields:[],archive_messages:[{message_index:0,message_json:JSON.stringify({role:'assistant',text:'hello',tavernPluginData:privateData,pluginData:privateData,variables:[privateData],sessionId:'session-source'})}],archive_timeline_nodes:[{node_key:'@meta',value_json:JSON.stringify({participants:{background:{sessionId:'session-source'}}})}]}
  const out=rewriteSaveTables(input,source,identity),msg=JSON.parse(out.archive_messages[0].message_json)
  assert.deepEqual(msg.tavernPluginData,privateData);assert.deepEqual(msg.pluginData,privateData);assert.deepEqual(msg.variables,[privateData]);assert.equal(msg.sessionId,'session-target')
  assert.equal(JSON.parse(out.archive_timeline_nodes[0].value_json).participants.background.sessionId,'session-target')
  input.archive_timeline_nodes[0].value_json=JSON.stringify({participants:{background:{sessionId:'outside'}}})
  assert.throws(()=>rewriteSaveTables(input,source,identity),/闭包外会话引用/)
 }
})
test('B07 同毫秒召回：实际SQL写入顺序替代ID字典序且迁移重开顺序保留',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'issue15-recalls-')),chat={id:'chat-issue15',sessionId:'session-test',timeline:{branchId:'main'}}
 const old=new Map(),prefix='worldbook-recalls/'+chat.id+'/'
 old.set(prefix+'index.json',{records:[{operationId:'z-old',path:prefix+'z-old.json'},{operationId:'a-old',path:prefix+'a-old.json'}]})
 for(const op of ['z-old','a-old'])old.set(prefix+op+'.json',{chatId:chat.id,operationId:op,turn:1,branchId:'main',createdAt:1000})
 const make=()=>createRollbackWorldbookRecallLog({dataRoot:root,now:()=>1000,store:{readJson:async p=>old.get(p),remove:async p=>old.delete(p)}})
 let store=make()
 try{
  assert.equal((await store.read(chat,1)).log.operationId,'a-old');assert.equal(old.size,0)
  for(const op of ['z-first','a-second'])await store.record({chat,frame:{turn:2,operationId:op,branchId:'main'},log:{outputs:[{text:op}]}})
  assert.equal((await store.read(chat,2)).log.operationId,'a-second');assert.deepEqual((await store.read(chat)).availableTurns,[1,2])
  store.dispose();store=make();assert.equal((await store.read(chat,2)).log.operationId,'a-second')
  await store.pruneRollback(chat,2,'new');chat.timeline.branchId='new';assert.equal((await store.read(chat)).log.operationId,'a-old')
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})
// 采用已下载作者copy/diff/apply真模块；显示投影不在本断言范围。
async function realHelpers(){
 const base=new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/tavern-plugin/lib/domain/',import.meta.url)
 const [copy,mutation]=await Promise.all(['copy-json-tree.js','json-mutation.js'].map(n=>import(new URL(n,base))))
 return {...copy,...mutation,...Object.fromEntries(['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'].map(k=>[k,v=>structuredClone(v)]))}
}
const seed=id=>({id,sessionId:'session-test',mode:'story',_storageRevision:1,title:'base',messages:[]})
async function stores(t,options={}){
 const root=mkdtempSync(path.join(os.tmpdir(),'issue15-chat-')),helpers=await realHelpers(),a=createChatSqliteStore({dataRoot:root,helpers,...options}),b=createChatSqliteStore({dataRoot:root,helpers})
 t.after(()=>{a.dispose();b.dispose();rmSync(root,{recursive:true,force:true})});return {root,a,b}
}
test('B08 双实例异步update：旧草稿拒绝且新字段冷读保留，串行更新可用',async t=>{
 const {root,a,b}=await stores(t),id='chat-race';await a.update(id,()=>seed(id));await b.read(id)
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const pending=a.update(id,async current=>{entered();await gate;return {...current,title:'late-A',_storageRevision:2}})
 const rejected=assert.rejects(pending,/revision/)
 await ready;await b.update(id,c=>({...c,title:'committed-B',newField:'must survive',_storageRevision:2}));release();await rejected
 assert.equal((await b.read(id)).newField,'must survive');a.dispose()
 const c=createChatSqliteStore({dataRoot:root,helpers:await realHelpers()});try{assert.equal((await c.read(id)).title,'committed-B');await c.update(id,v=>({...v,_storageRevision:3,extra:1}));assert.equal((await c.read(id)).newField,'must survive')}finally{c.dispose()}
})
test('B08 原子边界：预检查后外部提交仍由事务内CAS拒绝，首写碰撞不覆盖',async t=>{
 let hook=()=>{};const {root,a,b}=await stores(t,{now:()=>{hook();return 1000}}),id='chat-atomic';await a.update(id,()=>seed(id))
 hook=()=>{hook=()=>{};const db=new DatabaseSync(path.join(root,'chats',id,'archive.db'));try{db.prepare("INSERT INTO archive_head_fields(key,ord,kind,value_json) VALUES('external',99,0,'true')").run();db.prepare('UPDATE archive_head SET revision=2').run();db.prepare("UPDATE archive_head_fields SET value_json='2' WHERE key='_storageRevision'").run()}finally{db.close()}}
 await assert.rejects(()=>a.update(id,c=>({...c,title:'stale',_storageRevision:2})),e=>e.code==='DSH_TAVERN_REVISION_CONFLICT')
 assert.equal((await b.read(id)).external,true);assert.equal((await b.read(id)).title,'base')
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r)
 const first=a.update('chat-first-race',async()=>{entered();await gate;return seed('chat-first-race')});const rejected=assert.rejects(first,e=>e.code==='DSH_TAVERN_REVISION_CONFLICT')
 await ready;await b.update('chat-first-race',()=>({...seed('chat-first-race'),title:'winner'}));release();await rejected;assert.equal((await b.read('chat-first-race')).title,'winner')
})
test('B10 update身份：首写零建库，后续拒绝后热冷读取都保持原档',async t=>{
 const {root,a}=await stores(t),id='chat-id'
 await assert.rejects(()=>a.update(id,()=>seed('wrong')),/chat.id/);assert.equal(existsSync(path.join(root,'chats',id,'archive.db')),false)
 await a.update(id,()=>seed(id));await assert.rejects(()=>a.update(id,c=>({...c,id:'wrong',_storageRevision:2})),/chat.id/)
 assert.equal((await a.read(id)).id,id);assert.equal((await a.read(id))._storageRevision,1);a.dispose()
 const b=createChatSqliteStore({dataRoot:root,helpers:await realHelpers()});try{assert.equal((await b.read(id)).id,id);await b.update(id,c=>({...c,title:'valid',_storageRevision:2}));assert.equal((await b.read(id)).title,'valid')}finally{b.dispose()}
})
