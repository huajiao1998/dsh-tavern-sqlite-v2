// 世界书召回是业务数据，不是可以保留旧53的运行日志。每条召回一SQL行；旧文件仅精确按chat索引迁入，删除后不再双源。
// 轮次窗口与上游 lib/domain/worldbook-recall-log.js:12 WORLDBOOK_RECALL_KEEP_TURNS 对齐：record 落库后即裁，
// prune 再暴露给 save-maintenance 的闲时 sweep 复裁（上游 record 内同样每次 retain，见其 L52）。
// outputs 逐行化：正文文本占单行 65.9%（实测 chat-muvevn4u 69,246B 中 outputs 45,599B），
// 塞在主行里会让 requested() 每轮重写整块；改存 recall_outputs 行表后 requested() 只 UPDATE 布尔列。
// 兼容：行表无行且 value_json 仍带 outputs 数组时，read/requested 回落到旧字段，不强制迁移。
import {DatabaseSync} from 'node:sqlite'
import {mkdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
const id=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]+$/.test(value))throw Error('世界书日志标识无效');return value}
// 与上游 WORLDBOOK_RECALL_KEEP_TURNS 同值；上游是调试证据只留近期明细，我方同一窗口，避免两套口径。
const WORLDBOOK_RECALL_KEEP_TURNS=10
export function createRollbackWorldbookRecallLog({store,dataRoot,now=Date.now}){
 const root=resolve(dataRoot);mkdirSync(root,{recursive:true});const db=new DatabaseSync(join(root,'worldbook-recalls.db'))
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-256; CREATE TABLE IF NOT EXISTS recalls(chat_id TEXT NOT NULL, operation_id TEXT NOT NULL, turn INTEGER NOT NULL, branch_id TEXT, created_at INTEGER NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(chat_id,operation_id))')
 // 面板索引只含定位列，不复制日志正文；已有库按同一schema补索引。
 db.exec('CREATE INDEX IF NOT EXISTS recalls_chat_time ON recalls(chat_id,created_at,operation_id); CREATE INDEX IF NOT EXISTS recalls_chat_branch_turn_time ON recalls(chat_id,branch_id,turn,created_at,operation_id)')
 // outputs 行表：ref/location/text 逐项一列；request_contains_text 与 requested_at 合起来还原三态
 //（未请求=requested_at NULL 不输出该键；已请求非前台=输出 null；已请求前台=输出布尔）。
 db.exec('CREATE TABLE IF NOT EXISTS recall_outputs(chat_id TEXT NOT NULL, operation_id TEXT NOT NULL, idx INTEGER NOT NULL, ref TEXT, location TEXT, text TEXT, request_contains_text INTEGER, requested_at INTEGER, PRIMARY KEY(chat_id,operation_id,idx))')
 db.exec('CREATE INDEX IF NOT EXISTS recall_outputs_op ON recall_outputs(chat_id,operation_id,idx)')
 const queue=new Map(), migrated=new Set()
 function serial(chatId,work){const task=(queue.get(chatId)||Promise.resolve()).catch(()=>{}).then(work);queue.set(chatId,task);task.finally(()=>{if(queue.get(chatId)===task)queue.delete(chatId)}).catch(()=>{});return task}
 const base=chatId=>'worldbook-recalls/'+id(chatId)+'/'
 const put=value=>db.prepare('INSERT INTO recalls VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,operation_id) DO UPDATE SET turn=excluded.turn,branch_id=excluded.branch_id,created_at=excluded.created_at,value_json=excluded.value_json').run(value.chatId,value.operationId,value.turn,value.branchId||null,value.createdAt,JSON.stringify(value))
 const putOutputs=(chatId,operationId,outputs,rowRequestedAt=null)=>{
  db.prepare('DELETE FROM recall_outputs WHERE chat_id=? AND operation_id=?').run(chatId,operationId)
  const insert=db.prepare('INSERT INTO recall_outputs VALUES(?,?,?,?,?,?,?,?)')
  let index=0
  for(const item of outputs||[]){
   if(!item||typeof item!=='object')throw Error('召回输出项必须为对象')
   // requestedAt 是主行级字段（一次 requested 覆盖整轮），拆行时由上透传到每一项，
   // 否则升级/迁移会把"已请求"误判成"未请求"，丢掉 requestContainsText 三态。
   insert.run(chatId,operationId,index++,typeof item.ref==='string'?item.ref:null,typeof item.location==='string'?item.location:null,typeof item.text==='string'?item.text:null,item.requestContainsText===true?1:(item.requestContainsText===false?0:null),Number.isSafeInteger(item.requestedAt)?item.requestedAt:(Number.isSafeInteger(rowRequestedAt)?rowRequestedAt:null))
  }
 }
 // 行表还原成面板契约的 outputs 数组；行表无行时保留 value_json 原值（旧数据/直插 fixture）。
 const attachOutputs=(chatId,operationId,value)=>{
  const rows=db.prepare('SELECT ref,location,text,request_contains_text,requested_at FROM recall_outputs WHERE chat_id=? AND operation_id=? ORDER BY idx').all(chatId,operationId)
  if(!rows.length)return
  value.outputs=rows.map(row=>{const out={};if(row.ref!==null)out.ref=row.ref;if(row.location!==null)out.location=row.location;if(row.text!==null)out.text=row.text;if(row.requested_at!==null)out.requestContainsText=row.location==='foreground'?row.request_contains_text===1:null;return out})
 }
 // 保留 [latest-KEEP, latest] 这些 turn，删更早的；latest 取该档最大 turn，与上游 retain 同义（上游 L35-38）。
 // 子查询在 DELETE 开始时求值，故取的是删除前的最大值；库内无该档行时子查询为 NULL，比较为假、不删任何行。
 // 顺序不可换：必须先删 outputs（其子查询依赖 recalls 现存行），再删 recalls 主行。
 const retain=chatId=>{const c=id(chatId);db.prepare('DELETE FROM recall_outputs WHERE chat_id=? AND operation_id IN (SELECT operation_id FROM recalls WHERE chat_id=? AND turn<=(SELECT MAX(turn) FROM recalls WHERE chat_id=?)-?)').run(c,c,c,WORLDBOOK_RECALL_KEEP_TURNS);return db.prepare('DELETE FROM recalls WHERE chat_id=? AND turn<=(SELECT MAX(turn) FROM recalls WHERE chat_id=?)-?').run(c,c,WORLDBOOK_RECALL_KEEP_TURNS).changes}
 async function migrate(chat){
  if(migrated.has(chat.id))return
  const prefix=base(chat.id),index=await store.readJson(prefix+'index.json'),rows=[]
  for(const item of index?.records||[]){const expected=prefix+id(item.operationId)+'.json';if(item.path!==expected)throw Error('召回旧索引路径越界');const value=await store.readJson(expected);if(!value)continue;if(value.chatId!==chat.id||value.operationId!==item.operationId||!Number.isSafeInteger(value.turn))throw Error('召回旧记录身份无效');rows.push(value)}
  db.exec('BEGIN IMMEDIATE');try{for(const value of rows){const {outputs,...rest}=value;put(rest);putOutputs(chat.id,rest.operationId,outputs,rest.requestedAt)}db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  // SQL已持久化后精确删除对应旧负载，失败就响亮重试，不成功报告迁移或回退。
  for(const item of index?.records||[])await store.remove(prefix+id(item.operationId)+'.json')
  if(index)await store.remove(prefix+'index.json')
  migrated.add(chat.id)
 }
 // 一次性升级：旧版把 outputs 塞在主行 value_json 里。逐行 try-parse（不用 SQL JSON 函数，
 // 免得损坏 payload 让整库构造失败），拆进行表后从主行移除该键；幂等，拆完不再命中。
 ;(function upgradeOutputs(){
  const legacy=db.prepare('SELECT chat_id,operation_id,value_json FROM recalls').all().filter(row=>{
   try{const value=JSON.parse(row.value_json);return Boolean(value&&typeof value==='object'&&Array.isArray(value.outputs))}catch{return false}
  })
  if(!legacy.length)return
  db.exec('BEGIN IMMEDIATE')
  try{
   for(const row of legacy){
    const value=JSON.parse(row.value_json),{outputs,...rest}=value
    putOutputs(row.chat_id,row.operation_id,outputs,value.requestedAt)
    db.prepare('UPDATE recalls SET value_json=? WHERE chat_id=? AND operation_id=?').run(JSON.stringify(rest),row.chat_id,row.operation_id)
   }
   db.exec('COMMIT')
  }catch(error){db.exec('ROLLBACK');throw error}
 })()
 return {
  record({chat,frame,log}){return serial(chat.id,async()=>{await migrate(chat);const {outputs,...rest}=log||{};const value={...rest,version:1,status:'prepared',createdAt:now(),chatId:chat.id,sessionId:chat.sessionId,turn:frame.turn,operationId:id(frame.operationId),frameId:frame.frameId,branchId:frame.branchId,basedOnRevision:frame.basedOnRevision};db.exec('BEGIN IMMEDIATE');try{put(value);putOutputs(chat.id,value.operationId,outputs);retain(chat.id);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e};return base(chat.id)+id(frame.operationId)+'.json'})},
  read(chat,turn){return serial(chat.id,async()=>{
   await migrate(chat)
   const branch=chat.timeline?.branchId,scope='chat_id=?'+(branch?' AND branch_id=?':''),parameters=branch?[chat.id,branch]:[chat.id]
   // 轮次指执行召回的那一轮，不限制日志正文中引用的早期记忆。保旧falsy=最新契约。
   const requested=Number(turn),valid=!turn||Number.isSafeInteger(requested)
   const row=valid?db.prepare('SELECT value_json FROM recalls WHERE '+scope+(turn?' AND turn=?':'')+' ORDER BY created_at DESC,rowid DESC LIMIT 1').get(...parameters,...(turn?[requested]:[])):undefined
   // DISTINCT只读元数据；按每轮首次出现顺序保原面板顺序，不改为轮号排序。
   const availableTurns=db.prepare('SELECT DISTINCT turn,FIRST_VALUE(created_at) OVER first_record AS first_time,FIRST_VALUE(rowid) OVER first_record AS first_row FROM recalls WHERE '+scope+' WINDOW first_record AS (PARTITION BY turn ORDER BY created_at,rowid) ORDER BY first_time,first_row').all(...parameters).map(row=>row.turn)
   const target=row?JSON.parse(row.value_json):null
   if(target&&target.operationId!==undefined)attachOutputs(chat.id,id(target.operationId),target)
   return {log:target||null,availableTurns,message:target?'':'这一轮没有保存详细召回日志；旧轮次不从当前世界书反推。'}
  })},
  requested(chat,options,requestId){return serial(chat.id,async()=>{await migrate(chat);const frame=(options.messages||[]).findLast(m=>m.source?.form==='foreground-frame'),saved=Object.values(chat.foregroundFrames||{}).find(v=>v.frameId===frame?.source?.trace?.frameId);if(!saved?.operationId||saved.source?.worldBook?.recallLog!==base(chat.id)+id(saved.operationId)+'.json')return;const row=db.prepare('SELECT value_json FROM recalls WHERE chat_id=? AND operation_id=?').get(chat.id,saved.operationId);if(!row)return;const value=JSON.parse(row.value_json),text=(options.messages||[]).flatMap(m=>m.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');const at=now(),ids=[...new Set([...(value.requestIds||[]),requestId])]
   const outputs=db.prepare('SELECT idx,location,text FROM recall_outputs WHERE chat_id=? AND operation_id=? ORDER BY idx').all(chat.id,saved.operationId)
   db.exec('BEGIN IMMEDIATE')
   try{
    if(outputs.length){
     // 新路径：主行只改小字段，outputs 逐行只改布尔列与时间戳，不再重写整块正文。
     db.prepare('UPDATE recalls SET value_json=? WHERE chat_id=? AND operation_id=?').run(JSON.stringify({...value,status:'requested',requestedAt:at,requestIds:ids}),chat.id,saved.operationId)
     const update=db.prepare('UPDATE recall_outputs SET request_contains_text=?,requested_at=? WHERE chat_id=? AND operation_id=? AND idx=?')
     for(const item of outputs)update.run(item.location==='foreground'?(text.includes(item.text??'')?1:0):null,at,chat.id,saved.operationId,item.idx)
    }else{
     // 旧路径：outputs 仍在 value_json 里（未升级或直插 fixture），按原语义整块更新。
     put({...value,status:'requested',requestedAt:at,requestIds:ids,outputs:(value.outputs||[]).map(o=>({...o,requestContainsText:o.location==='foreground'?text.includes(o.text):null}))})
    }
    db.exec('COMMIT')
   }catch(e){db.exec('ROLLBACK');throw e}
  })},
  pruneRollback(chat,turn,branchId){return serial(chat.id,async()=>{await migrate(chat);db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM recall_outputs WHERE chat_id=? AND operation_id IN (SELECT operation_id FROM recalls WHERE chat_id=? AND turn>=?)').run(chat.id,chat.id,turn);db.prepare('DELETE FROM recalls WHERE chat_id=? AND turn>=?').run(chat.id,turn);db.prepare('UPDATE recalls SET branch_id=?,value_json=json_set(value_json,\'$.branchId\',?) WHERE chat_id=?').run(branchId,branchId,chat.id);if(db.prepare('SELECT COUNT(*) n FROM recalls WHERE chat_id=? AND turn>=?').get(chat.id,turn).n!==0)throw Error('世界书召回尾部未清零');db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}})},
  prune(chatId){return serial(id(chatId),async()=>{await migrate({id:chatId});return {pruned:retain(chatId)}})},
  dispose(){if(queue.size)throw Error('召回存储仍有运行任务');db.close()}
 }
}
