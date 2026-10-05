// 作者2.4投影的SQL输入选择；不另造输出投影，不缓存/出借调用方可变对象。
const SESSION_FIELDS = ['id','sessionId','_storageRevision','mode','cardPath','cardContextRevision','backgroundConfigVersion','conversationFeaturesVersion','disabledWritingSkills','contextCompaction','updatedAt','timeline','candidateAgent','cardName','requestMode','statusBarPlacement','webSearchEnabled','candidates','taskMailbox','regenInProgress','settleError','scriptState','hiddenDshErrorTurns','suppressedDshTurns','regeneratedDshTurns','tavernHelperLifecycleRevision','importHistory','pendingMvuSettlement']
const UNDO_FIELDS = ['version','ready','branchId','revision','lifecycleRevision','storageRevision','turn','foreground.afterCount']
const BACKGROUND_FIELDS = ['id','sessionId','mode','backgroundConfigVersion','conversationFeaturesVersion','backgroundModelSelection','backgroundModelRevision','backgroundTasks','webSearchEnabled','sceneImagesEnabled','cardContextRevision','timeline.participants.background.status']
const SCENE_FIELDS = ['id','sessionId','mode','backgroundConfigVersion','conversationFeaturesVersion','sceneImagesEnabled']
const DISPLAY_FIELDS = ['id','sessionId','mode','_storageRevision','backgroundConfigVersion','conversationFeaturesVersion','updatedAt','rollbackUndo.ready','rollbackUndo.storageRevision']
const SUMMARY_FIELDS = ['role','turn','greeting','importSource.operationId','mvu.receipt','mvu.diagnostics','mvu.pending','mvu.modified']
const safeParts = field => String(field).split('.').filter(Boolean)
const poison = key => ['__proto__','prototype','constructor'].includes(key)
const SCENE_ROW_FIELDS = ['role','turn','greeting','text','sourceText','swipeId','swipes']
const DISPLAY_ROW_FIELDS = ['role','turn','greeting']
const parse = text => text == null ? undefined : JSON.parse(text)
function put(target, field, value) {
  const parts=field.split('.');let parent=target
  for(const key of parts.slice(0,-1)){if(!Object.hasOwn(parent,key) || !parent[key] || typeof parent[key]!=='object')Object.defineProperty(parent,key,{value:{},enumerable:true,writable:true,configurable:true});parent=parent[key]}
  Object.defineProperty(parent,parts.at(-1),{value,enumerable:true,writable:true,configurable:true})
}
const oldBody = chat => Object.values(chat.timeline?.operations || {}).some(op=>op?.kind==='body' && op.status==='foreground-completed')

// 无await的读取事务固定多条SELECT的同一SQL快照；返回的懒读只引用本版本内存摘要。
export function readSqlSnapshot(db, read) {
  const own=!db.isTransaction
  if(own)db.exec('BEGIN')
  try{const value=read();if(own)db.exec('COMMIT');return value}
  catch(error){if(own){try{db.exec('ROLLBACK')}catch{}}throw error}
}
export function readProjectionHeader(db, fields, revision) {
  const result={}
  if(Array.isArray(fields)){
    const statement=db.prepare('SELECT value_json -> ? AS value_json FROM archive_head_fields WHERE key=? AND kind=0')
    for(const field of fields){
      const parts=safeParts(field),[key,...path]=parts
      if(!key || key==='messages' || parts.some(poison))continue
      const label=parts.join('.')
      if(key==='_storageRevision'){if(path.length===0)put(result,label,revision);continue}
      // 普通字段可直接用JSON路径；含点/引号的任意调用方字段按顶层键解码再选择，不能误读。
      const simple=path.every(part=>/^[A-Za-z_][A-Za-z_0-9]*$/.test(part))
      const row=statement.get(simple && path.length?'$.'+path.join('.'):'$',key)
      let value=parse(row?.value_json)
      if(!simple)for(const part of path)value=value && Object.hasOwn(value,part)?value[part]:undefined
      if(value!==undefined)put(result,label,value)
    }
  }else{
    for(const row of db.prepare('SELECT key,value_json FROM archive_head_fields WHERE kind=0 ORDER BY ord').all())if(row.value_json!=null && row.key!=='messages' && !poison(row.key))Object.defineProperty(result,row.key,{value:parse(row.value_json),enumerable:true,writable:true,configurable:true})
    result._storageRevision=revision
    if(fields==='settlement' && result.timeline && typeof result.timeline==='object' && !Array.isArray(result.timeline))result.timeline.checkpoints=[]
  }
  return result
}
function rowsSql(fields) {return 'SELECT message_index,'+fields.map((field,index)=>`message_json -> '$.${field}' AS f${index}`).join(',')+", json_type(message_json) AS row_type, CASE WHEN json_type(message_json)<>'object' THEN message_json END AS unusual FROM archive_messages ORDER BY message_index"}
function decode(row,fields){if(row.row_type!=='object')return parse(row.unusual);const value={};for(let index=0;index<fields.length;index++)if(row['f'+index]!=null)put(value,fields[index],parse(row['f'+index]));return value}
function summarySql(){return rowsSql(SUMMARY_FIELDS).replace(' FROM archive_messages',`, ${truth('$.mvu')} AS has_mvu, ${truth('$.importSource')} AS has_import FROM archive_messages`)}
function weight(rows){return rows.reduce((sum,row)=>sum+64+Object.values(row).reduce((n,value)=>n+(typeof value==='string'?value.length*2:8),0),0)}
function sizeOf(value){if(typeof value==='string')return 24+value.length*2;if(!value || typeof value!=='object')return 8;return 64+Object.keys(value).reduce((sum,key)=>sum+24+key.length*2+sizeOf(value[key]),0)}
function truth(path,column='message_json'){return `CASE COALESCE(json_type(${column},'${path}'),'null') WHEN 'null' THEN 0 WHEN 'false' THEN 0 WHEN 'integer' THEN json_extract(${column},'${path}')<>0 WHEN 'real' THEN json_extract(${column},'${path}')<>0 WHEN 'text' THEN json_extract(${column},'${path}')<>'' ELSE 1 END`}
function headerTruthy(db,key){return Boolean(db.prepare(`SELECT ${truth('$','value_json')} AS present FROM archive_head_fields WHERE key=?`).get(key)?.present)}

export function createChatProjectionReads({helpers,maxEntries=8,maxBytes=16*1024*1024}) {
  const cache=new Map();let bytes=0
  const requireHelper=name=>{if(typeof helpers[name]!=='function')throw Error('SQL投影按需读取缺少作者helper '+name+'，请更新标准存储shim');return helpers[name]}
  function entry(db,id,revision){
    const previous=cache.get(id)
    if(previous){bytes-=previous.bytes;cache.delete(id)}
    return previous?.db===db && previous.revision===revision ? previous : {db,revision,bytes:0}
  }
  function remember(id,current){
    if(maxEntries>0 && current.bytes<=maxBytes){cache.set(id,current);bytes+=current.bytes}
    while(cache.size>maxEntries || bytes>maxBytes){const key=cache.keys().next().value;bytes-=cache.get(key).bytes;cache.delete(key)}
  }
  function snapshot(db,id,read){return readSqlSnapshot(db,()=>{
    const head=db.prepare("SELECT revision,(SELECT value_json FROM archive_head_fields WHERE key='id') AS chat_id FROM archive_head WHERE id=1").get()
    if(!head)return undefined
    if(parse(head.chat_id)!==id)throw Error('Archive state 不合法: '+id)
    const revision=Number(head.revision),current=entry(db,id,revision)
    const result=read(current,revision);remember(id,current);return result
  })}
  function summaries(current){
    if(current.summaries)return current.summaries
    const project=requireHelper('projectSessionMessage'),rows=current.db.prepare(summarySql()).all()
    current.summaries=rows.map(row=>{
      if(row.row_type!=='object')return project(parse(row.unusual))
      const input=decode(row,SUMMARY_FIELDS)
      if(!row.has_mvu)delete input.mvu;else input.mvu ||= {}
      if(!row.has_import)delete input.importSource;else input.importSource ||= {}
      return project(input)
    });current.bytes+=weight(rows)+sizeOf(current.summaries)
    const pending=current.db.prepare(`SELECT ${truth('$.mvu.pendingSubmission')} AS submitted,${truth('$.mvu.delivery.prepared')} AS prepared FROM archive_messages WHERE json_type(message_json,'$.mvu.pending')='true' AND json_extract(message_json,'$.role')='assistant' ORDER BY message_index DESC LIMIT 1`).get()
    current.pending=pending?{hasSubmission:Boolean(pending.submitted),prepared:Boolean(pending.prepared)}:null
    return current.summaries
  }
  return Object.freeze({
    session(db,id,options={}){return snapshot(db,id,(current,revision)=>{
      if(!current.sessionHead){
        const chat=readProjectionHeader(db,SESSION_FIELDS,revision)
        if(headerTruthy(db,'rollbackUndo'))chat.rollbackUndo=readProjectionHeader(db,UNDO_FIELDS.map(key=>'rollbackUndo.'+key),revision).rollbackUndo || {}
        current.sessionHead=chat;current.bytes+=sizeOf(chat)
      }
      const chat=current.sessionHead
      if(oldBody(chat))return {full:true}
      const rows=summaries(current)
      const pendingMvuSettlement=Object.hasOwn(chat,'pendingMvuSettlement')?chat.pendingMvuSettlement:current.pending
      if(options.scoped===true){
        const scoped=requireHelper('createScopedMessages'),owned=new Map()
        const messages=scoped(rows.length,[],index=>{if(!owned.has(index))owned.set(index,helpers.copyJsonTree(rows[index]));return owned.get(index)})
        return {value:helpers.projectChatSessionState(chat,{pendingMvuSettlement,messages})}
      }
      if(!current.full){current.full=helpers.projectChatSessionState({...chat,messages:rows},{pendingMvuSettlement});current.bytes+=sizeOf(current.full)}
      return {value:helpers.copyJsonTree(current.full)}
    })},
    background(db,id){return snapshot(db,id,(_current,revision)=>helpers.projectChatBackgroundConfig(readProjectionHeader(db,BACKGROUND_FIELDS,revision)))},
    scene(db,id){return snapshot(db,id,(current,revision)=>{
      if(!current.scene){const rows=db.prepare(rowsSql(SCENE_ROW_FIELDS)).all();current.scene=helpers.projectSceneImageState({...readProjectionHeader(db,SCENE_FIELDS,revision),messages:rows.map(row=>decode(row,SCENE_ROW_FIELDS))});current.bytes+=weight(rows)+sizeOf(current.scene)}
      return helpers.copyJsonTree(current.scene)
    })},
    display(db,id,turn){return snapshot(db,id,(current,revision)=>{
      if(!current.display){const rows=db.prepare(rowsSql(DISPLAY_ROW_FIELDS)).all();current.display=rows.map(row=>decode(row,DISPLAY_ROW_FIELDS));current.bytes+=weight(rows)}
      const rows=current.display.map((row,index)=>row && typeof row==='object'?{...row,get displayRuntime(){return parse(db.prepare("SELECT message_json -> '$.displayRuntime' AS value_json FROM archive_messages WHERE message_index=?").get(index)?.value_json)}}:row)
      const chat=readProjectionHeader(db,DISPLAY_FIELDS,revision)
      if(headerTruthy(db,'rollbackUndo'))chat.rollbackUndo ||= {}
      return helpers.projectDisplayRuntimeState({...chat,messages:rows},turn)
    })},
    checkpoint(db,id,messageId,operationId){return snapshot(db,id,(_current,revision)=>{
      const chat=readProjectionHeader(db,['id','sessionId','_storageRevision','tavernHelperLifecycleRevision','timeline'],revision)
      if(oldBody(chat))return undefined
      const row=Number.isSafeInteger(messageId)&&messageId>=0?db.prepare('SELECT message_json FROM archive_messages WHERE message_index=?').get(messageId):undefined
      const messages=[];if(row)messages[messageId]=parse(row.message_json)
      return helpers.projectSettlementCheckpoint({...chat,messages},messageId,operationId)
    })},
    forget(id){const current=cache.get(id);if(current)bytes-=current.bytes;cache.delete(id)},
    dispose(){cache.clear();bytes=0},
  })
}
