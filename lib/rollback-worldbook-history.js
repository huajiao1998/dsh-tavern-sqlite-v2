// V2本档回退基准去重复：当前书接口不变，历史全文只在同一个archive.db保存。
// 调用方在写事务内compact；不缓存未提交数据，不制造文件/hash/跨库一致性机制。
import { isDeepStrictEqual } from 'node:util'
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value)
const own=(value,key)=>Object.hasOwn(value,key)
function assertRef(ref,chatId){
 if(!object(ref) || ref.version!==1 || ref.chatId!==chatId || !Number.isSafeInteger(ref.bookId) || ref.bookId<1)throw Error('世界书历史引用格式或本档身份不匹配')
 return ref.bookId
}
export function createRollbackWorldbookHistory(){
 // 仅缓存从真实库行读到的解码结果；每次核对行文本，不缓存compact的未提交插入。
 const parsedRows=new WeakMap()
 function decoded(db,row){
  let cache=parsedRows.get(db)
  if(!cache){cache=new Map();parsedRows.set(db,cache)}
  const id=Number(row.book_id),old=cache.get(id)
  if(old?.text===row.snapshot_json)return old.value
  const value=JSON.parse(row.snapshot_json)
  cache.set(id,{text:row.snapshot_json,value})
  return value
 }
 function ensureTables(db){db.exec('CREATE TABLE IF NOT EXISTS archive_worldbook_history (book_id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_json TEXT NOT NULL)')}
 function compact(db,chat){
  if(!db.isTransaction)throw Error('世界书基准必须与本档写入在同一事务')
  const chatId=chat?.id
  if(typeof chatId!=='string' || !chatId)throw Error('世界书基准缺少本档身份')
  // 普通账本只有小引用；有新内联基准时才加载历史书，不每次读/解析所有全文。
  const available=new Set(db.prepare('SELECT book_id FROM archive_worldbook_history').all().map(row=>Number(row.book_id)))
  const used=new Set()
  let candidates,changed=false
  function findBook(snapshot){
   if(!candidates)candidates=db.prepare('SELECT book_id,snapshot_json FROM archive_worldbook_history ORDER BY book_id').all().map(row=>({id:Number(row.book_id),value:decoded(db,row)}))
   const found=candidates.find(item=>isDeepStrictEqual(item.value,snapshot))
   if(found)return found.id
   const text=JSON.stringify(snapshot)
   if(text===undefined)throw Error('世界书历史快照不是有效JSON状态')
   const id=Number(db.prepare('INSERT INTO archive_worldbook_history(snapshot_json) VALUES(?)').run(text).lastInsertRowid)
   available.add(id);candidates.push({id,value:snapshot})
   return id
  }
  function baseline(before){
   if(!object(before))return before
   if(before.version!==1 || !object(before.fields)){
    if(own(before,'worldbookRef'))throw Error('世界书历史引用基准版本或字段布局未知，拒绝回收必要历史')
    return before
   }
   if(own(before,'worldbookRef')){
    if(own(before.fields,'openingWorldbookSnapshot'))throw Error('世界书基准同时有全文与引用')
    const id=assertRef(before.worldbookRef,chatId)
    if(!available.has(id))throw Error('世界书历史引用缺少对应快照行')
    used.add(id);return before
   }
   if(!own(before.fields,'openingWorldbookSnapshot'))return before
   const id=findBook(before.fields.openingWorldbookSnapshot),fields={...before.fields}
   delete fields.openingWorldbookSnapshot
   used.add(id);changed=true
   return {...before,fields,worldbookRef:{version:1,chatId,bookId:id}}
  }
  const incoming=chat.timeline
  let timeline=incoming
  if(object(incoming)){
   const operations=object(incoming.operations)?Object.fromEntries(Object.entries(incoming.operations).map(([id,op])=>{
    if(!object(op))return [id,op]
    const before=baseline(op.businessBefore)
    return [id,before===op.businessBefore?op:{...op,businessBefore:before}]
   })):incoming.operations
   const checkpoints=Array.isArray(incoming.checkpoints)?incoming.checkpoints.map(cp=>{
    if(!object(cp))return cp
    const before=baseline(cp.businessBefore)
    return before===cp.businessBefore?cp:{...cp,businessBefore:before}
   }):incoming.checkpoints
   if(changed)timeline={...incoming,operations,checkpoints}
  }
  // 所有引用先验证再回收；被删除轮独占的书版本同事务物理删除，不碰仍被引用者。
  const remove=db.prepare('DELETE FROM archive_worldbook_history WHERE book_id=?')
  for(const id of available)if(!used.has(id)){remove.run(id);parsedRows.get(db)?.delete(id)}
  return changed?{...chat,timeline}:chat
 }
 // 捕获可复用已提交且与当前书完全相同的历史行；未命中留内联，由下一次写事务保存。
 function currentRef(db,chat){
  if(!own(chat,'openingWorldbookSnapshot'))return undefined
  const rows=db.prepare('SELECT book_id,snapshot_json FROM archive_worldbook_history ORDER BY book_id DESC').iterate()
  for(const row of rows)if(isDeepStrictEqual(decoded(db,row),chat.openingWorldbookSnapshot))return {version:1,chatId:chat.id,bookId:Number(row.book_id)}
  return undefined
 }
 function read(db,chat,ref){
  const id=assertRef(ref,chat?.id)
  if(!Number.isSafeInteger(chat?._storageRevision))throw Error('世界书历史读取缺少明确存档revision')
  const head=db.prepare('SELECT revision FROM archive_head WHERE id=1').get()
  if(!head || Number(head.revision)!==chat._storageRevision)throw Error('世界书历史引用存档revision已过期')
  const owner=db.prepare("SELECT value_json FROM archive_head_fields WHERE key='id'").get()
  if(!owner || JSON.parse(owner.value_json)!==chat.id)throw Error('世界书历史引用与数据库身份不匹配')
  const row=db.prepare('SELECT snapshot_json FROM archive_worldbook_history WHERE book_id=?').get(id)
  if(!row)throw Error('世界书历史引用缺少对应快照行，不能以当前书猜历史')
  return JSON.parse(row.snapshot_json)
 }
 return Object.freeze({ensureTables,compact,currentRef,read})
}
