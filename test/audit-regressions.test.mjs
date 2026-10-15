// 独立合成回归：不依赖作者工作区、网络或玩家数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readVariables } from '../lib/read-variables.js'
import { rewriteSaveTables } from '../lib/db-save-identities.js'
import { createVariableArchive } from '../lib/variable-archive.js'
import { createDbSaveExchange } from '../lib/db-save-exchange.js'
import { encodeDbSave, decodeDbSave, DB_SAVE_FORMAT, DB_SAVE_VERSION } from '../lib/db-save-zip.js'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
const chatWith = stat_data => ({id:'chat-test',messages:[{role:'assistant',turn:1,variables:[{stat_data}]}]})

test('B02: UTF-8 entry budget and pagination preserve all entries', () => {
  const data=Object.fromEntries(Array.from({length:30},(_,i)=>['字段'+i,'汉'.repeat(200)]))
  const chat=chatWith(data), seen=[];let cursor
  do {
    const page=readVariables(chat,{action:'read',limit:50,...(cursor?{cursor}:{})})
    assert.ok(page.entries.reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(e)),0)<=4000)
    assert.ok(page.entries.length>0)
    seen.push(...page.entries.map(e=>e.path));cursor=page.nextCursor
  }while(cursor)
  assert.equal(new Set(seen).size,30);assert.equal(seen.length,30)
})

test('B03: every string page and preview preserves surrogate pairs', () => {
  const text='a'.repeat(999)+'😀'+'b'.repeat(999)+'😀end',chat=chatWith({text})
  let cursor,joined=''
  do {
    const page=readVariables(chat,{action:'read',path:'/text',...(cursor?{cursor}:{})})
    assert.ok(page.value.isWellFormed());assert.ok(page.value.length>0)
    joined+=page.value;cursor=page.nextCursor
  }while(cursor)
  assert.equal(joined,text)
  const preview=readVariables(chatWith({text:'a'.repeat(199)+'😀'}),{action:'read'})
  assert.ok(preview.entries[0].value.isWellFormed());assert.equal(preview.entries[0].truncated,true)
})

test('B04: one oversized escaped path fails explicitly rather than repeating a cursor', () => {
  assert.throws(()=>readVariables(chatWith({['\u0001'.repeat(700)]:1})),/单项超过4000字节/)
})

test('B05: large Base64 reaches database validation; malformed Base64 is rejected', async () => {
  const root=mkdtempSync(path.join(tmpdir(),'sqv2-base64-')),file=path.join(root,'probe.db')
  const db=new DatabaseSync(file);db.exec('CREATE TABLE probe(value TEXT)');db.close()
  const data=readFileSync(file),noop=()=>{}
  const engine=createDbSaveExchange({chatStore:{},chatForSession:noop,readChat:noop,persistence:noop,assertForkable:noop,ownsSession:noop,publish:noop,unpublish:noop,attach:noop,detach:noop,resources:{capture:noop,validate:noop,install:noop}})
  for(const size of [1,4,8]) {
    const manifest={format:DB_SAVE_FORMAT,formatVersion:DB_SAVE_VERSION,storage:'sqlite',source:{chatId:'chat-source',sessionId:'session-source'},sessions:['session-source'],resources:['images/test.bin']}
    const buffer=encodeDbSave({manifest,archive:data,sessions:[{id:'session-source',data}],resources:[{path:'images/test.bin',data:Buffer.alloc(size*1024*1024)}]})
    assert.equal(decodeDbSave(buffer).resources.length,1)
    // 合法容器但不是完整业务库：应到达 schema 校验，而不是前置正则栈溢出。
    await assert.rejects(engine.importGameSave({fileB64:buffer.toString('base64')}),e=>e.name!=='RangeError'&&/schema|表|数据库/i.test(e.message))
  }
  for(const fileB64 of ['', 'A===','AAAA=','AA=A','AA!A','AAAA\n','===='])
    await assert.rejects(engine.importGameSave({fileB64}),/请选择有效/)
})

test('B06: opaque plugin fields survive while real session references are remapped', () => {
  const source={id:'chat-source',sessionId:'session-source'}
  const identity={chatId:'chat-new',sessionId:'session-new',branchId:'new',sessions:new Map([['session-source','session-new']])}
  for(const sessionId of ['session-source','plugin-private-session']) {
    const plugin={custom:{sessionId,chatId:'chat-source'}}
    const tables={archive_head_fields:[{key:'sessionId',value_json:JSON.stringify(source.sessionId)}],archive_messages:[{message_json:JSON.stringify({role:'assistant',tavernPluginData:plugin})}]}
    const out=rewriteSaveTables(tables,source,identity)
    assert.deepEqual(JSON.parse(out.archive_messages[0].message_json).tavernPluginData,plugin)
    assert.equal(JSON.parse(out.archive_head_fields[0].value_json),'session-new')
  }
})

test('B10: mismatched IDs are rejected before first write and before updating an existing archive', async () => {
  const dataRoot=mkdtempSync(path.join(tmpdir(),'sqv2-identity-'))
  // 该测试只走 update 整对象写入，不调用投影或 patch；无需外部宿主夹具。
  const helpers={copyJsonTree:structuredClone,applyJsonChangesShared:value=>value,diffJson:(_before,next)=>[{op:'set',path:[],value:next}]}
  for(const key of ['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'])helpers[key]=structuredClone
  const open=()=>createChatSqliteStore({dataRoot,helpers})
  let store=open()
  try {
    await assert.rejects(store.update('chat-a',()=>({id:'chat-b',messages:[],_storageRevision:1})),/chat\.id.*不一致/)
    assert.equal(existsSync(path.join(dataRoot,'chats','chat-a','archive.db')),false)
    await store.update('chat-a',()=>({id:'chat-a',sessionId:'session-a',messages:[],_storageRevision:1}))
    await assert.rejects(store.update('chat-a',c=>({...c,id:'chat-b',_storageRevision:2})),/chat\.id.*不一致/)
    assert.equal((await store.read('chat-a')).id,'chat-a')
    store.dispose();store=open();assert.equal((await store.read('chat-a')).id,'chat-a')
  }finally{store.dispose()}
})

test('B11: shared archive cache isolates A-B-A reads and returned trees', () => {
  const archive=createVariableArchive(),a=new DatabaseSync(':memory:'),b=new DatabaseSync(':memory:')
  try {
    for(const [db,tag] of [[a,'A'],[b,'B']]){
      archive.ensureTables(db)
      db.prepare("INSERT INTO variable_snapshots(message_index,swipe_id,turn,slot_count,selected,source,mvu_ready,tree_json,created_at) VALUES(1,0,2,1,1,'audit',1,?,0)").run(JSON.stringify({stat_data:{tag},schema:{}}))
    }
    const row=()=>({role:'assistant',turn:2})
    for(const [db,id,expected] of [[a,'chat-a','A'],[b,'chat-b','B'],[a,'chat-a','A']]){
      const value=archive.hydrateRow(db,id,1,row());assert.equal(value.variables[0].stat_data.tag,expected)
      value.variables[0].stat_data.tag='mutated'
    }
  }finally{archive.dispose();a.close();b.close()}
})
