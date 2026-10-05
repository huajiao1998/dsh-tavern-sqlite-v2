// 原创隔离V2本档数据库闸：只验证世界书历史引用与业务恢复，不代替原生/页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {mkdtempSync,readdirSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {captureRollbackBusinessState,restoreRollbackBusinessState} from '../lib/rollback-business-state.js'
const copy=value=>value===undefined?undefined:structuredClone(value)
const helpers={copyJsonTree:copy,applyJsonChangesShared:()=>{throw Error('本闸不调用patch')}}
for(const key of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[key]=copy
helpers.diffJson=(a,b)=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>!isDeepStrictEqual(a[k],b[k]) || Object.hasOwn(a,k)!==Object.hasOwn(b,k)).map(k=>Object.hasOwn(b,k)?{op:'set',path:[k],value:b[k]}:{op:'remove',path:[k]})
const book=content=>({version:1,libraryDigest:'original',source:{kind:'card',cardPath:'cards/synthetic.json'},document:{entries:[{uid:0,content}]},unknown:{keep:true}})
const big=book('原创完整世界书标记-'+ '故事'.repeat(175000))
const seed=id=>({id,sessionId:'synthetic-'+id,_storageRevision:1,messages:[],variables:{hp:1},timeline:{schemaVersion:1,branchId:'b',revision:0,operations:{},checkpoints:[],participants:{}},openingWorldbookSnapshot:copy(big),guides:[{text:'手工配置'}]})
function baseline(chat){return captureRollbackBusinessState(chat)}
function attach(chat,name){const before=baseline(chat);chat.timeline.operations[name]={kind:'body',turn:Number(name.slice(1))||1,businessBefore:before};chat.timeline.checkpoints.push({id:name,turn:Number(name.slice(1))||1,businessBefore:before});return chat}
async function fixture(run){
 const root=path.resolve(mkdtempSync(path.join(os.tmpdir(),'v2-book-history-test-')))
 const store=createChatSqliteStore({dataRoot:root,helpers}),id='synthetic-chat'
 let db
 try{await store.update(id,()=>seed(id));db=new DatabaseSync(path.join(root,'chats',id,'archive.db'));return await run({root,id,store,db})}
 finally{db?.close();store.dispose();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('v2-book-history-test-'));readdirSync(root,{recursive:true});rmSync(root,{recursive:true,force:true})}
}
async function update(store,id,fn){return store.update(id,c=>{const result=fn(c)||c;result._storageRevision=c._storageRevision+1;return result})}
const rows=db=>db.prepare('SELECT book_id,snapshot_json FROM archive_worldbook_history').all()
const restore=(store,chat,before)=>restoreRollbackBusinessState(chat,before,copy,(state,ref)=>store.readRollbackWorldbook(state,ref))

test('8轮不变书只存1历史版本；普通更新不插入、不写当前书，不展开历史',async()=>fixture(async({id,store,db})=>{
 db.exec('CREATE TABLE writes(kind TEXT); CREATE TRIGGER count_book AFTER INSERT ON archive_worldbook_history BEGIN INSERT INTO writes VALUES(\'history\'); END; CREATE TRIGGER count_head AFTER UPDATE ON archive_head_fields WHEN NEW.key=\'openingWorldbookSnapshot\' BEGIN INSERT INTO writes VALUES(\'head\'); END;')
 const original=await store.read(id)
 for(let i=1;i<=8;i++)await update(store,id,c=>attach(c,'t'+i))
 const saved=await store.read(id),text=db.prepare("SELECT value_json FROM archive_head_fields WHERE key='timeline'").get().value_json
 assert.equal(rows(db).length,1);assert.ok(!text.includes('原创完整世界书标记'));assert.deepEqual(saved.openingWorldbookSnapshot,big)
 assert.equal(original.timeline.checkpoints.length,0,'外借旧根不得被compact改写')
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes WHERE kind='history'").get().n,1)
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM writes WHERE kind='head'").get().n,0)
 for(const cp of saved.timeline.checkpoints){assert.ok(cp.businessBefore.worldbookRef);assert.equal(Object.hasOwn(cp.businessBefore.fields,'openingWorldbookSnapshot'),false)}
 const ref=store.readCurrentRollbackWorldbookRef(saved)
 assert.ok(ref);const compactCapture=captureRollbackBusinessState(saved,copy,ref)
 assert.equal(Object.hasOwn(compactCapture.fields,'openingWorldbookSnapshot'),false);assert.deepEqual(compactCapture.worldbookRef,ref)
 const changed=copy(saved);changed.openingWorldbookSnapshot=book('尚未提交的新书')
 assert.equal(store.readCurrentRollbackWorldbookRef(changed),undefined,'同revision也必须核书真实内容，不能误用旧引用')
 const next=await update(store,id,c=>{c.variables.hp++;return c})
 assert.equal(rows(db).length,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM writes').get().n,1)
 assert.equal(store.readCurrentRollbackWorldbookRef(saved),undefined,'过期快照不得给当前引用')
 assert.ok(store.readCurrentRollbackWorldbookRef(next))
}))

test('书A到B与重新打开后按基准精确恢复；删除轮只回收无人引用版本',async()=>fixture(async({id,store,db,root})=>{
 await update(store,id,c=>attach(c,'t1'))
 const second=book('原创书B')
 await update(store,id,c=>{c.openingWorldbookSnapshot=second;return c})
 await update(store,id,c=>attach(c,'t2'))
 assert.equal(rows(db).length,2)
 const fresh=createChatSqliteStore({dataRoot:root,helpers})
 try{
  const current=await fresh.read(id),a=current.timeline.checkpoints[0].businessBefore,b=current.timeline.checkpoints[1].businessBefore
  const restoredA=restore(fresh,copy(current),a),restoredB=restore(fresh,copy(current),b)
  assert.deepEqual(restoredA.openingWorldbookSnapshot,big);assert.deepEqual(restoredB.openingWorldbookSnapshot,second)
  assert.deepEqual(restoredA.guides,current.guides)
 }finally{fresh.dispose()}
 await update(store,id,c=>{c.timeline.checkpoints.pop();delete c.timeline.operations.t2;return c})
 assert.equal(rows(db).length,1,'A还有基准引用，不删；B无人引用物理删除')
 assert.deepEqual(JSON.parse(rows(db)[0].snapshot_json),big)
 await update(store,id,c=>{c.timeline.operations={};c.timeline.checkpoints=[];return c})
 assert.equal(rows(db).length,0)
}))

test('缺失、整个字段null、document null均精确保存与恢复',async()=>fixture(async({id,store,db})=>{
 await update(store,id,c=>{delete c.openingWorldbookSnapshot;return attach(c,'t1')})
 await update(store,id,c=>{c.openingWorldbookSnapshot=null;return attach(c,'t2')})
 await update(store,id,c=>{c.openingWorldbookSnapshot={version:1,document:null};return attach(c,'t3')})
 assert.equal(rows(db).length,2)
 const current=await store.read(id),[a,b,c]=current.timeline.checkpoints.map(cp=>cp.businessBefore)
 assert.equal(Object.hasOwn(restore(store,copy(current),a),'openingWorldbookSnapshot'),false)
 assert.equal(restore(store,copy(current),b).openingWorldbookSnapshot,null)
 assert.deepEqual(restore(store,copy(current),c).openingWorldbookSnapshot,{version:1,document:null})
}))

test('缺接线、悬空、跨档与过期引用均失败且不修改业务头',async()=>fixture(async({id,store})=>{
 const current=await update(store,id,c=>attach(c,'t1')),before=current.timeline.checkpoints[0].businessBefore
 const destination=copy(current),original=copy(destination)
 assert.throws(()=>restoreRollbackBusinessState(destination,before),/世界书/);assert.deepEqual(destination,original)
 assert.throws(()=>restore(store,destination,{...before,worldbookRef:{...before.worldbookRef,bookId:99999}}),/世界书/);assert.deepEqual(destination,original)
 assert.throws(()=>restore(store,destination,{...before,worldbookRef:{...before.worldbookRef,chatId:'another'}}),/世界书/);assert.deepEqual(destination,original)
 assert.throws(()=>restore(store,destination,{...before,fields:{...before.fields,openingWorldbookSnapshot:big}}),/世界书/);assert.deepEqual(destination,original)
 await update(store,id,c=>{c.variables.hp++;return c})
 assert.throws(()=>restore(store,destination,before),/过期/);assert.deepEqual(destination,original)
}))

test('历史插入及后续头写失败均同事务回滚；悬空写入拒绝保旧态',async()=>fixture(async({id,store,db})=>{
 const first=await update(store,id,c=>attach(c,'t1')),old=copy(first)
 db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON archive_worldbook_history BEGIN SELECT RAISE(ABORT,'synthetic history fault'); END")
 await assert.rejects(update(store,id,c=>{c.openingWorldbookSnapshot=book('fault new');return attach(c,'t2')}),/synthetic history fault/)
 assert.deepEqual(await store.read(id),old);assert.equal(rows(db).length,1)
 db.exec('DROP TRIGGER fail_history')
 db.exec("CREATE TRIGGER fail_head BEFORE UPDATE ON archive_head BEGIN SELECT RAISE(ABORT,'synthetic head fault'); END")
 await assert.rejects(update(store,id,c=>{c.openingWorldbookSnapshot=book('fault new');return attach(c,'t2')}),/synthetic head fault/)
 assert.deepEqual(await store.read(id),old);assert.equal(rows(db).length,1)
 db.exec('DROP TRIGGER fail_head')
 await assert.rejects(update(store,id,c=>{c.timeline.checkpoints[0].businessBefore.worldbookRef.bookId=999;return c}),/世界书/)
 assert.deepEqual(await store.read(id),old)
 await assert.rejects(update(store,id,c=>{c.timeline.checkpoints[0].businessBefore.version=99;return c}),/世界书/)
 assert.deepEqual(await store.read(id),old);assert.equal(rows(db).length,1,'未知引用布局不能被当成无引用清表')
 const final=await update(store,id,c=>{c.openingWorldbookSnapshot=book('correct new');return attach(c,'t2')})
 assert.equal(rows(db).length,2);assert.deepEqual(restore(store,copy(final),final.timeline.checkpoints[1].businessBefore).openingWorldbookSnapshot,book('correct new'))
}))

test('新ID新timeline的档只复制当前完整书、不携带旧档引用',async()=>fixture(async({id,store,db})=>{
 const old=await update(store,id,c=>attach(c,'t1')),next=copy(old)
 next.id='synthetic-new';next.sessionId='synthetic-new-session';next._storageRevision=1;next.timeline={schemaVersion:1,branchId:'new',revision:0,operations:{},checkpoints:[],participants:{}}
 const fork=await store.update(next.id,()=>next)
 assert.deepEqual(fork.openingWorldbookSnapshot,big);assert.equal(rows(db).length,1)
 assert.equal(store.readCurrentRollbackWorldbookRef(fork),undefined)
 const saved=await update(store,next.id,c=>attach(c,'t1'))
 assert.equal(saved.timeline.checkpoints[0].businessBefore.worldbookRef.chatId,next.id)
 assert.throws(()=>store.readRollbackWorldbook(saved,old.timeline.checkpoints[0].businessBefore.worldbookRef),/世界书/)
}))
