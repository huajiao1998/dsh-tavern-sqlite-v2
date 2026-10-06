// 共享资源逐键SQL权威；不属于剧情存档，不保存或恢复逐轮前态。
import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {rollbackSchedulingBarrier} from './rollback-barrier.js'
import {assertRollbackArchiveWritable} from './rollback-archive-guard.js'
import {stmt} from './statement-cache.js'
const own=(v,k)=>Object.hasOwn(v,k)
export const validateRollbackJsonObject=v=>{
 if(!v||typeof v!=='object'||Array.isArray(v))throw Error('全局变量必须是对象')
 const seen=new Set()
 function visit(item){
  if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return
  if(!item||typeof item!=='object'||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw Error('全局变量必须是有限JSON数据')
  if(seen.has(item))throw Error('全局变量不能包含循环引用')
  if(Object.getOwnPropertySymbols(item).length)throw Error('全局变量必须是JSON数据，不能包含Symbol键')
  if(Array.isArray(item)&&Object.keys(item).length!==item.length)throw Error('全局变量必须是JSON数据，不能包含稀疏数组')
  seen.add(item);for(const [key,child] of Object.entries(item)){if(key==='__proto__')throw Error('全局变量包含不安全字段');visit(child)}seen.delete(item)
 }
 visit(v)
}
const valid=validateRollbackJsonObject
// 仅为任务写屏障传确切chat/branch；不代表共享值属于该正文轮。
export function rollbackGlobalOwner(chat) {
 if(chat?.rollbackPending || rollbackSchedulingBarrier.has(chat?.sessionId))throw Error('物理回退未完成，禁止共享全局变量写入')
 if(!['story','script'].includes(chat?.mode||'story'))return undefined
 const operation=Object.values(chat.timeline?.operations||{}).filter(op=>op.kind==='body').sort((a,b)=>Number(b.turn)-Number(a.turn))[0]
 const turn=Number(operation?.turn??chat.messages?.findLast(row=>row.role==='assistant')?.turn)
 return Number.isSafeInteger(turn)&&turn>0?{chatId:chat.id,turn,...(chat.timeline?.branchId?{branchId:chat.timeline.branchId}:{})}:undefined
}
export function createRollbackGlobalVariables({profileData,dataRoot,databaseName='prompt-template-variables.db',legacyName='prompt-template-variables.json',legacyField='global',archiveForChat}){
 if(!['prompt-template-variables.db','tavern-extension-settings.db','character-variables.db','worldbook-resources.db','worldbook-bindings.db'].includes(databaseName)||![null,'prompt-template-variables.json','tavern-extension-settings.json','.worldbook-bindings.json'].includes(legacyName))throw Error('共享SQL存储名称不在明确清单')
 const root=resolve(dataRoot);mkdirSync(root,{recursive:true});const db=new DatabaseSync(join(root,databaseName))
 // P2-b：全局小库内容 KB 级，默认 2MB 页缓存纯浪费 → 256KB（5 库共省 ~10MB，零风险）。
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-256;
 CREATE TABLE IF NOT EXISTS global_values(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS global_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS global_scopes(scope TEXT PRIMARY KEY);`)
 if(['character-variables.db','worldbook-resources.db'].includes(databaseName))db.exec("CREATE INDEX IF NOT EXISTS character_variable_scope ON global_values(json_extract(key,'$[0]'))")
 let queue=Promise.resolve(),ready=false
 const serial=work=>{const task=queue.then(work);queue=task.catch(()=>{});return task}
 async function init(){
  if(ready)return
  const initialized=!!db.prepare("SELECT value FROM global_meta WHERE key='initialized'").get()
  const old=legacyName===null||initialized?undefined:await profileData.readJson(legacyName)
  db.exec('BEGIN IMMEDIATE');try{
   // 旧宽边界撤销表直接退役，不回放历史、不覆盖当前资源。SQL权威行保留。
   db.exec('DROP TABLE IF EXISTS global_undo; DROP TABLE IF EXISTS global_rollback_keys; DROP TABLE IF EXISTS global_rollback_owners; DROP TABLE IF EXISTS global_key_revisions;')
   if(databaseName==='worldbook-resources.db')db.exec("DELETE FROM global_values WHERE json_valid(key) AND json_extract(key,'$[1]')='$scope-revision'")
   // 两连接都可能已读旧JSON；是否迁入必须在SQL锁内判定，不覆盖先提交的新值。
   if(!db.prepare("SELECT value FROM global_meta WHERE key='initialized'").get()){
    const initial=(legacyField===null?old:old?.[legacyField])??{};valid(initial)
    for(const [key,value] of Object.entries(initial))db.prepare('INSERT INTO global_values VALUES(?,?,0)').run(key,JSON.stringify(value))
    db.prepare("INSERT INTO global_meta VALUES('revision',0),('initialized',1)").run()
   }
   db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
  if(legacyName!==null&&(old!==undefined||initialized))await profileData.remove(legacyName)
  ready=true
 }
 // 2026-10-06 P1（R-7）：热读/热写路径改连接级语句缓存——实测 readScopeNow 是插件第 2 热 JS 函数
 // （1.9s 自耗时/456s 运行），每次调用都 db.prepare 解析 SQL 是其中一部分；表达式索引已存在（见上）。
 const readNow=()=>Object.fromEntries(stmt(db,'SELECT key,value_json FROM global_values ORDER BY key').all().map(r=>[r.key,JSON.parse(r.value_json)]))
 const readScopeNow=scope=>Object.fromEntries(stmt(db,"SELECT key,value_json FROM global_values WHERE json_extract(key,'$[0]')=? ORDER BY key").all(scope).map(row=>[row.key,JSON.parse(row.value_json)]))
 const decodeScope=value=>Object.fromEntries(Object.entries(value).map(([key,entry])=>[JSON.parse(key)[1],entry]))
 const equal=(a,b,k)=>own(a,k)===own(b,k)&&isDeepStrictEqual(a[k],b[k])
 return {
  bindArchiveResolver:resolver=>{if(typeof resolver!=='function')throw Error('共享写确切archive解析器无效');if(archiveForChat&&archiveForChat!==resolver)throw Error('共享写archive解析器已绑定');archiveForChat=resolver},
  read:()=>serial(async()=>{await init();return readNow()}),
  readScope:scope=>serial(async()=>{await init();if(!stmt(db,'SELECT 1 FROM global_scopes WHERE scope=?').get(scope))return undefined;return decodeScope(readScopeNow(scope))}),
  seedScope:(scope,variables)=>serial(async()=>{valid(variables);await init();db.exec('BEGIN IMMEDIATE');try{if(!db.prepare('SELECT 1 FROM global_scopes WHERE scope=?').get(scope)){for(const [key,value] of Object.entries(variables))db.prepare('INSERT INTO global_values VALUES(?,?,0)').run(JSON.stringify([scope,key]),JSON.stringify(value));db.prepare('INSERT INTO global_scopes VALUES(?)').run(scope)}db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}}),
  // 路径即资源键；仅供既有资源图改名/删除重试调用，不创建稳定ID或新操作日志。
  moveScope:(from,to)=>serial(async()=>{
   await init();db.exec('BEGIN IMMEDIATE');try{
    const source=db.prepare('SELECT 1 FROM global_scopes WHERE scope=?').get(from)
    if(!source){db.exec('COMMIT');return}
    if(to!==null&&db.prepare('SELECT 1 FROM global_scopes WHERE scope=?').get(to))throw Error('SQL资源目标已存在，拒绝覆盖')
    const rows=db.prepare("SELECT key,value_json FROM global_values WHERE json_extract(key,'$[0]')=?").all(from)
    db.prepare("DELETE FROM global_values WHERE json_extract(key,'$[0]')=?").run(from);db.prepare('DELETE FROM global_scopes WHERE scope=?').run(from)
    const revision=Number(db.prepare("SELECT value FROM global_meta WHERE key='revision'").get().value)+1
    if(to!==null){db.prepare('INSERT INTO global_scopes VALUES(?)').run(to);for(const row of rows)db.prepare('INSERT INTO global_values VALUES(?,?,?)').run(JSON.stringify([to,JSON.parse(row.key)[1]]),row.value_json,revision)}
    db.prepare("UPDATE global_meta SET value=? WHERE key='revision'").run(revision);db.exec('COMMIT')
   }catch(error){db.exec('ROLLBACK');throw error}
  }),
  version:()=>serial(async()=>{await init();return 'sqlite:global:'+stmt(db,"SELECT value FROM global_meta WHERE key='revision'").get().value}),
  save:(variables,expected,owner,scope)=>serial(async()=>{
   valid(variables);if(expected!==undefined)valid(expected)
   if(scope!==undefined){if(typeof scope!=='string'||!scope)throw Error('共享变量范围无效');const encode=value=>Object.fromEntries(Object.entries(value).map(([key,entry])=>[JSON.stringify([scope,key]),entry]));variables=encode(variables);if(expected!==undefined)expected=encode(expected)}
   await init()
   if(owner&&(!owner.chatId||!Number.isSafeInteger(owner.turn)||owner.turn<1))throw Error('共享写任务身份无效')
   // SQL锁覆盖读取、CAS和提交；旧任务仍校验archive分支，不因取消共享撤销而放行。
   db.exec('BEGIN IMMEDIATE');try{
    if(owner&&archiveForChat){
     if(typeof owner.branchId!=='string'||!owner.branchId)throw Error('共享写入缺少权威分支身份')
     const archive=archiveForChat(owner.chatId);assertRollbackArchiveWritable(archive)
     const head=new DatabaseSync(archive,{readOnly:true});try{
      const id=JSON.parse(head.prepare("SELECT value_json FROM archive_head_fields WHERE key='id'").get()?.value_json??'null')
      // P2-a：子行形态读 @meta（~3KB，含 branchId）；旧形态（迁移前窗口）兜底整键。
      let branchId
      try{
       const meta=head.prepare("SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get()?.value_json
       if(meta!==undefined)branchId=JSON.parse(meta)?.branchId
      }catch{ /* 旧形态无子行表 */ }
      if(branchId===undefined)branchId=JSON.parse(head.prepare("SELECT value_json FROM archive_head_fields WHERE key='timeline'").get()?.value_json??'null')?.branchId
      if(id!==owner.chatId||branchId!==owner.branchId)throw Error('共享写入来自已退役分支，禁止旧任务回写')
     }finally{head.close()}
    }
    const before=scope===undefined?readNow():readScopeNow(scope),scoped=value=>scope===undefined?value:decodeScope(value),base=expected??before,next={...before},changed=[]
    if(databaseName==='worldbook-resources.db'&&scope!==undefined&&(expected===undefined||!isDeepStrictEqual(before,expected)))throw Error('世界书完整读取前态已被其他操作修改，请重新读取')
    for(const key of new Set([...Object.keys(base),...Object.keys(variables)])){
     if(equal(base,variables,key))continue
     if(!equal(before,base,key)&&!equal(before,variables,key))throw Error('全局变量已被其他对话修改，请重新加载后重试: '+key)
     if(own(variables,key))Object.defineProperty(next,key,{value:structuredClone(variables[key]),enumerable:true,writable:true,configurable:true});else delete next[key]
     if(!equal(before,next,key))changed.push(key)
    }
    if(!changed.length){db.exec('COMMIT');return scoped(before)}
    const revision=Number(stmt(db,"SELECT value FROM global_meta WHERE key='revision'").get().value)+1
    const deleteValue=stmt(db,'DELETE FROM global_values WHERE key=?')
    const upsertValue=stmt(db,'INSERT INTO global_values VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=excluded.revision')
    for(const key of changed){
     if(!own(next,key))deleteValue.run(key)
     else upsertValue.run(key,JSON.stringify(next[key]),revision)
    }
    stmt(db,"UPDATE global_meta SET value=? WHERE key='revision'").run(revision);db.exec('COMMIT');return scoped(next)
   }catch(e){db.exec('ROLLBACK');throw e}
  }),
  dispose:async()=>{await queue;db.close()}
 }
}
