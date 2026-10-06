// 世界书召回是业务数据，不是可以保留旧53的运行日志。每条召回一SQL行；旧文件仅精确按chat索引迁入，删除后不再双源。
import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
const id=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]+$/.test(value))throw Error('世界书日志标识无效');return value}
export function createRollbackWorldbookRecallLog({store,dataRoot,now=Date.now}){
 const root=resolve(dataRoot);mkdirSync(root,{recursive:true});const db=new DatabaseSync(join(root,'worldbook-recalls.db'))
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-256; CREATE TABLE IF NOT EXISTS recalls(chat_id TEXT NOT NULL, operation_id TEXT NOT NULL, turn INTEGER NOT NULL, branch_id TEXT, created_at INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(chat_id,operation_id))')
 // 面板索引只含定位列，不复制日志正文；已有库按同一schema补索引。
 db.exec('CREATE INDEX IF NOT EXISTS recalls_chat_time ON recalls(chat_id,created_at,operation_id); CREATE INDEX IF NOT EXISTS recalls_chat_branch_turn_time ON recalls(chat_id,branch_id,turn,created_at,operation_id)')
 const queue=new Map(), migrated=new Set()
 function serial(chatId,work){const task=(queue.get(chatId)||Promise.resolve()).catch(()=>{}).then(work);queue.set(chatId,task);task.finally(()=>{if(queue.get(chatId)===task)queue.delete(chatId)}).catch(()=>{});return task}
 const base=chatId=>'worldbook-recalls/'+id(chatId)+'/'
 const put=value=>db.prepare('INSERT INTO recalls VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,operation_id) DO UPDATE SET turn=excluded.turn,branch_id=excluded.branch_id,created_at=excluded.created_at,value_json=excluded.value_json').run(value.chatId,value.operationId,value.turn,value.branchId||null,value.createdAt,JSON.stringify(value))
 async function migrate(chat){
  if(migrated.has(chat.id))return
  const prefix=base(chat.id),index=await store.readJson(prefix+'index.json'),rows=[]
  for(const item of index?.records||[]){const expected=prefix+id(item.operationId)+'.json';if(item.path!==expected)throw Error('召回旧索引路径越界');const value=await store.readJson(expected);if(!value)continue;if(value.chatId!==chat.id||value.operationId!==item.operationId||!Number.isSafeInteger(value.turn))throw Error('召回旧记录身份无效');rows.push(value)}
  db.exec('BEGIN IMMEDIATE');try{for(const value of rows)put(value);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  // SQL已持久化后精确删除对应旧负载，失败就响亮重试，不成功报告迁移或回退。
  for(const item of index?.records||[])await store.remove(prefix+id(item.operationId)+'.json')
  if(index)await store.remove(prefix+'index.json')
  migrated.add(chat.id)
 }
 return {
  record({chat,frame,log}){return serial(chat.id,async()=>{await migrate(chat);const value={...log,version:1,status:'prepared',createdAt:now(),chatId:chat.id,sessionId:chat.sessionId,turn:frame.turn,operationId:id(frame.operationId),frameId:frame.frameId,branchId:frame.branchId,basedOnRevision:frame.basedOnRevision};put(value);return base(chat.id)+id(frame.operationId)+'.json'})},
  read(chat,turn){return serial(chat.id,async()=>{
   await migrate(chat)
   const branch=chat.timeline?.branchId,scope='chat_id=?'+(branch?' AND branch_id=?':''),parameters=branch?[chat.id,branch]:[chat.id]
   // 轮次指执行召回的那一轮，不限制日志正文中引用的早期记忆。保旧falsy=最新契约。
   const requested=Number(turn),valid=!turn||Number.isSafeInteger(requested)
   const row=valid?db.prepare('SELECT value_json FROM recalls WHERE '+scope+(turn?' AND turn=?':'')+' ORDER BY created_at DESC,operation_id DESC LIMIT 1').get(...parameters,...(turn?[requested]:[])):undefined
   // DISTINCT只读元数据；按每轮首次出现顺序保原面板顺序，不改为轮号排序。
   const availableTurns=db.prepare('SELECT DISTINCT turn,FIRST_VALUE(created_at) OVER first_record AS first_time,FIRST_VALUE(operation_id) OVER first_record AS first_operation FROM recalls WHERE '+scope+' WINDOW first_record AS (PARTITION BY turn ORDER BY created_at,operation_id) ORDER BY first_time,first_operation').all(...parameters).map(row=>row.turn)
   const target=row?JSON.parse(row.value_json):null
   return {log:target||null,availableTurns,message:target?'':'这一轮没有保存详细召回日志；旧轮次不从当前世界书反推。'}
  })},
  requested(chat,options,requestId){return serial(chat.id,async()=>{await migrate(chat);const frame=(options.messages||[]).findLast(m=>m.source?.form==='foreground-frame'),saved=Object.values(chat.foregroundFrames||{}).find(v=>v.frameId===frame?.source?.trace?.frameId);if(!saved?.operationId||saved.source?.worldBook?.recallLog!==base(chat.id)+id(saved.operationId)+'.json')return;const row=db.prepare('SELECT value_json FROM recalls WHERE chat_id=? AND operation_id=?').get(chat.id,saved.operationId);if(!row)return;const value=JSON.parse(row.value_json),text=(options.messages||[]).flatMap(m=>m.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');put({...value,status:'requested',requestedAt:now(),requestIds:[...new Set([...(value.requestIds||[]),requestId])],outputs:(value.outputs||[]).map(o=>({...o,requestContainsText:o.location==='foreground'?text.includes(o.text):null}))})})},
  pruneRollback(chat,turn,branchId){return serial(chat.id,async()=>{await migrate(chat);db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM recalls WHERE chat_id=? AND turn>=?').run(chat.id,turn);db.prepare('UPDATE recalls SET branch_id=?,value_json=json_set(value_json,\'$.branchId\',?) WHERE chat_id=?').run(branchId,branchId,chat.id);if(db.prepare('SELECT COUNT(*) n FROM recalls WHERE chat_id=? AND turn>=?').get(chat.id,turn).n!==0)throw Error('世界书召回尾部未清零');db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}})},
  dispose(){if(queue.size)throw Error('召回存储仍有运行任务');db.close()}
 }
}
