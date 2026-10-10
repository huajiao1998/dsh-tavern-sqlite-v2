// 作者2.4投影的SQL输入选择；不另造输出投影，不缓存/出借调用方可变对象。
// 2026-10-06 P2-a（D-5）：timeline 子行形态（v4）——整键＝行缓存组装（timelineNodes，不进键池）；
//   点路径走 @meta；oldBody/checkpoint 子集改扫子行。旧形态（v3 整键）全分支保留兜底。
// 2026-10-06 P1（R-1/R-2/R-5）：
//   · R-5 键级池：头字段按"字段标签"池化 parsed 值，写口按 changed 顶层键前缀精确删池
//     （invalidate），不再于每次写后整条丢缓存（旧 bumpGeneration→forget 使修A从未生效）。
//     直接头部读（readWindow 等，'settlement' 全键形状）共用同一键池：键列表小查询 + 逐键
//     命中/单键读，出借前 copyJsonTree 脱离，不交出池中对象。
//   · R-2 oldBody：改 json_each EXISTS（C 层扫 operations，2.60ms）并按 timeline 部件版本
//     记忆，避免为判一个布尔解析整条 2.5MB。
//   · R-1 checkpoint：只读作者投影消费的 timeline 子集（schemaVersion/branchId/revision/
//     单条 operation），不再整条 parse。
// 2026-10-05 修B：热路径 db.prepare 全部换连接级语句缓存（lib/statement-cache.js）。
// 2026-10-05 修A：缓存条目改分部件失效（header/messages）——修A 的最终生效依赖 P1 的
//   invalidate（此前写后 forget 整条，部件粒度无从发挥）。
// 2026-10-05 修C 审查结论：L0 冻结视图不适用——projection-reads.test.mjs 明确测试
//   "调用方可改返回值且不影响缓存"（变更隔离契约），冻结对象会抛 TypeError 违反该契约。
//   保留 L2 深拷贝（copyJsonTree），靠精确失效降低重建频率来摊薄拷贝成本。
import { stmt } from './statement-cache.js'
import { revisions as componentRevisions } from './component-revisions.js'
import { usesTimelineNodes, readTimelineTree } from './timeline-nodes.js'
const SESSION_FIELDS = ['id','sessionId','_storageRevision','mode','cardPath','cardContextRevision','backgroundConfigVersion','conversationFeaturesVersion','disabledWritingSkills','contextCompaction','updatedAt','timeline','candidateAgent','cardName','requestMode','statusBarPlacement','webSearchEnabled','candidates','taskMailbox','regenInProgress','settleError','scriptState','hiddenDshErrorTurns','suppressedDshTurns','regeneratedDshTurns','tavernHelperLifecycleRevision','importHistory','pendingMvuSettlement']
const UNDO_FIELDS = ['version','ready','branchId','revision','lifecycleRevision','storageRevision','turn','foreground.afterCount']
const BACKGROUND_FIELDS = ['id','sessionId','mode','backgroundConfigVersion','conversationFeaturesVersion','backgroundModelSelection','backgroundModelRevision','imageModelSelection','backgroundTasks','webSearchEnabled','sceneImagesEnabled','cardContextRevision','timeline.participants.background.status']
const SCENE_FIELDS = ['id','sessionId','mode','backgroundConfigVersion','conversationFeaturesVersion','sceneImagesEnabled']
const DISPLAY_FIELDS = ['id','sessionId','mode','_storageRevision','backgroundConfigVersion','conversationFeaturesVersion','updatedAt','rollbackUndo.ready','rollbackUndo.storageRevision']
const SUMMARY_FIELDS = ['role','turn','greeting','importSource.operationId','mvu.receipt','mvu.diagnostics','mvu.pending','mvu.modified']
const safeParts = field => String(field).split('.').filter(Boolean)
const poison = key => ['__proto__','prototype','constructor'].includes(key)
const SCENE_ROW_FIELDS = ['role','turn','greeting','text','sourceText','swipeId','swipes']
const DISPLAY_ROW_FIELDS = ['role','turn','greeting']
const parse = text => text == null ? undefined : JSON.parse(text)
function defineValue(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}
/** P2-a（D-5）：timeline 子行组装（经行级缓存）。**不进键池**——组装树与行缓存共享行对象，
 *  双重计字节会把条目顶过 maxBytes（P1 审查 BUG① 的教训写进设计）。行缓存 fill 记账由本函数做。
 *  外部行缓存（timelineRowsFor，按连接持有、由 store 写口精确失效）不占条目预算：
 *  否则大档 timeline 单条就超过 maxBytes，条目永远记不住 ⇒ 每次快照都整表重解析 59MB。 */
function timelineAssembled(db, pool) {
  const cache = pool !== undefined ? pool.timelineNodes : undefined
  const { value, added } = readTimelineTree(db, cache, { detach: true })
  if (pool !== undefined && pool.ownedTimelineNodes === true) for (const [, parsed] of added) pool.addBytes(sizeOf(parsed))
  return value
}
function put(target, field, value) {
  const parts=field.split('.');let parent=target
  for(const key of parts.slice(0,-1)){if(!Object.hasOwn(parent,key) || !parent[key] || typeof parent[key]!=='object')Object.defineProperty(parent,key,{value:{},enumerable:true,writable:true,configurable:true});parent=parent[key]}
  Object.defineProperty(parent,parts.at(-1),{value,enumerable:true,writable:true,configurable:true})
}

// 无await的读取事务固定多条SELECT的同一SQL快照；返回的懒读只引用本版本内存摘要。
export function readSqlSnapshot(db, read) {
  const own=!db.isTransaction
  if(own)db.exec('BEGIN')
  try{const value=read();if(own)db.exec('COMMIT');return value}
  catch(error){if(own){try{db.exec('ROLLBACK')}catch{}}throw error}
}
export function readProjectionHeader(db, fields, revision, pool) {
  const result={}
  if(Array.isArray(fields)){
    const statement=stmt(db,'SELECT value_json -> ? AS value_json FROM archive_head_fields WHERE key=? AND kind=0')
    for(const field of fields){
      const parts=safeParts(field),[key,...path]=parts
      if(!key || key==='messages' || parts.some(poison))continue
      const label=parts.join('.')
      if(key==='_storageRevision'){if(path.length===0)put(result,label,revision);continue}
      // P2-a（D-5）：timeline 子行形态——整键＝行缓存组装；点路径＝@meta 抽取（标量/participants）
      // 或全组装（checkpoints/operations 深路径，现无消费者，防御保留）。
      if(key==='timeline' && usesTimelineNodes(db)){
        if(path.length===0){
          const value=timelineAssembled(db,pool)
          if(value!==undefined)put(result,label,value)
          continue
        }
        if(path[1]!=='checkpoints' && path[1]!=='operations' && path.every(part=>/^[A-Za-z_][A-Za-z_0-9]*$/.test(part))){
          const row=stmt(db,"SELECT value_json -> ? AS value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get('$.'+path.join('.'))
          const value=parse(row?.value_json)
          if(value!==undefined)put(result,label,value)
          continue
        }
        let value=timelineAssembled(db,pool)
        for(const part of path)value=value && Object.hasOwn(value,part)?value[part]:undefined
        if(value!==undefined)put(result,label,value)
        continue
      }
      // R-5（2026-10-06）：键级池——同一个头字段不再每次重读+重解析。
      //   写口按 changed 键精确删池（projectionReads.invalidate），外部写走 entry() 的保守全清。
      if(pool!==undefined && pool.has(label)){put(result,label,pool.get(label));continue}
      // 普通字段可直接用JSON路径；含点/引号的任意调用方字段按顶层键解码再选择，不能误读。
      const simple=path.every(part=>/^[A-Za-z_][A-Za-z_0-9]*$/.test(part))
      const row=statement.get(simple && path.length?'$.'+path.join('.'):'$',key)
      let value=parse(row?.value_json)
      if(!simple)for(const part of path)value=value && Object.hasOwn(value,part)?value[part]:undefined
      if(value!==undefined){if(pool!==undefined)pool.set(label,value);put(result,label,value)}
    }
  }else{
    // P1（R-5）：全键形状（'settlement' 等）同样走键级池——先取**键列表**（小查询），再逐键
    // 命中池或单键读。不再整表读 4MB 文本重解析，也不额外保留一整份组装好的大对象
    // （否则与键池重复计字节，会把条目顶过 maxBytes 上限而彻底失去缓存）。
    for(const row of stmt(db,'SELECT key FROM archive_head_fields WHERE kind=0 ORDER BY ord').all()){
      const key=row.key
      if(key==='messages' || poison(key))continue
      // S2：窗口最终投影的 timeline 由同快照活动窄查询补入，绝不先恢复完整子行。
      if(fields==='opening' && key==='timeline')continue
      if(key==='timeline' && usesTimelineNodes(db)){
        // P2-a：占位 NULL → 子行组装（行缓存；不进键池）
        const value=timelineAssembled(db,pool)
        if(value!==undefined)defineValue(result,key,value)
        continue
      }
      if(pool!==undefined && pool.has(key)){defineValue(result,key,pool.get(key));continue}
      const value=parse(stmt(db,"SELECT value_json -> '$' AS value_json FROM archive_head_fields WHERE key=?").get(key)?.value_json)
      if(value===undefined)continue
      if(pool!==undefined)pool.set(key,value)
      defineValue(result,key,value)   // 字面键：头键名不做点路径拆分（与旧全键分支同语义）
    }
    result._storageRevision=revision
    if(fields==='settlement' && result.timeline && typeof result.timeline==='object' && !Array.isArray(result.timeline)){
      const timeline={}
      for(const timelineKey of Object.keys(result.timeline))if(timelineKey!=='checkpoints')defineValue(timeline,timelineKey,result.timeline[timelineKey])
      defineValue(timeline,'checkpoints',[])
      result.timeline=timeline
    }
  }
  return result
}
/** R-2（2026-10-06）：oldBody 判定的 SQL 版——json_each 在 C 层扫 operations，不解析整条 timeline。
 *  实测 2.60ms/次，比"解析 2.5MB 再遍历"（7.23ms）便宜；结果按 timeline 部件版本记忆（见 oldBodyOf）。
 *  P2-a：子行形态改扫 operations 行（~1.3MB，行数=操作数）。 */
function timelineOldBody(db){
  if(usesTimelineNodes(db)){
    return Boolean(stmt(db,`SELECT EXISTS(SELECT 1 FROM archive_timeline_nodes
      WHERE node_key LIKE 'operations:%' AND json_extract(value_json,'$.kind')='body' AND json_extract(value_json,'$.status')='foreground-completed') AS found`).get()?.found)
  }
  return Boolean(stmt(db,`SELECT EXISTS(SELECT 1 FROM archive_head_fields, json_each(value_json,'$.operations')
    WHERE archive_head_fields.key='timeline' AND json_extract(value,'$.kind')='body' AND json_extract(value,'$.status')='foreground-completed') AS found`).get()?.found)
}
/** R-1（2026-10-06）：checkpoint 只取它真正消费的 timeline 子集（作者投影只用
 *  schemaVersion/branchId/revision/operations[operationId]），不再整条 parse 2.5MB。 */
function readTimelineSubset(db,operationId){
  // P2-a：子行形态——@meta 取标量＋单 operation 行 PK 直取（无引号转义问题）。
  if(usesTimelineNodes(db)){
    const meta=parse(stmt(db,"SELECT value_json FROM archive_timeline_nodes WHERE node_key='@meta'").get()?.value_json)
    if(!meta || meta.schemaVersion!==1)return undefined       // 与作者投影同判据：非 schema 1 一律 undefined
    const timeline={...meta,operations:{}}
    const key=operationId==null?undefined:String(operationId)
    if(key!==undefined && key!==''){
      const operation=parse(stmt(db,'SELECT value_json FROM archive_timeline_nodes WHERE node_key=?').get('operations:'+key)?.value_json)
      if(operation!==undefined)timeline.operations[key]=operation
    }
    return timeline
  }
  const meta=stmt(db,`SELECT value_json -> '$.schemaVersion' AS schema_version, value_json -> '$.branchId' AS branch_id,
    value_json -> '$.revision' AS timeline_revision FROM archive_head_fields WHERE key='timeline'`).get()
  if(meta===undefined || meta.schema_version==null)return undefined
  const schemaVersion=parse(meta.schema_version)
  if(schemaVersion!==1)return undefined                       // 与作者投影同判据：非 schema 1 一律 undefined
  const timeline={schemaVersion,branchId:parse(meta.branch_id),revision:parse(meta.timeline_revision),operations:{}}
  // 审查修复③（2026-10-06）：键按 JS 语义强转（作者侧 operations[operationId] 对数字同样转字符串键）。
  const key=operationId==null?undefined:String(operationId)
  if(key===undefined || key==='')return timeline
  let operation
  if(/^[A-Za-z_][A-Za-z_0-9-]*$/.test(key)){
    const row=stmt(db,'SELECT value_json -> ? AS value_json FROM archive_head_fields WHERE key=?').get(`$.operations.${key}`,'timeline')
    operation=parse(row?.value_json)
  } else if(!/["\\]/.test(key)){
    const row=stmt(db,'SELECT value_json -> ? AS value_json FROM archive_head_fields WHERE key=?').get(`$.operations."${key}"`,'timeline')
    operation=parse(row?.value_json)
  } else {
    // 含引号/反斜杠的 id：SQLite JSON 路径不支持转义（实测 $."a""b" 恒 null）⇒ 退回 $.operations 子树，
    // 仍不解析整条 timeline（1.3MB 而非 2.5MB），且不改变 id 本身。
    const row=stmt(db,"SELECT value_json -> '$.operations' AS value_json FROM archive_head_fields WHERE key='timeline'").get()
    const operations=parse(row?.value_json)
    operation=operations && typeof operations==='object' ? operations[key] : undefined
  }
  if(operation!==undefined)timeline.operations[key]=operation
  return timeline
}
function rowsSql(fields) {return 'SELECT message_index,'+fields.map((field,index)=>`message_json -> '$.${field}' AS f${index}`).join(',')+", json_type(message_json) AS row_type, CASE WHEN json_type(message_json)<>'object' THEN message_json END AS unusual FROM archive_messages ORDER BY message_index"}
function decode(row,fields){if(row.row_type!=='object')return parse(row.unusual);const value={};for(let index=0;index<fields.length;index++)if(row['f'+index]!=null)put(value,fields[index],parse(row['f'+index]));return value}
function summarySql(){return rowsSql(SUMMARY_FIELDS).replace(' FROM archive_messages',`, ${truth('$.mvu')} AS has_mvu, ${truth('$.importSource')} AS has_import FROM archive_messages`)}
function weight(rows){return rows.reduce((sum,row)=>sum+64+Object.values(row).reduce((n,value)=>n+(typeof value==='string'?value.length*2:8),0),0)}
function sizeOf(value){if(typeof value==='string')return 24+value.length*2;if(!value || typeof value!=='object')return 8;return 64+Object.keys(value).reduce((sum,key)=>sum+24+key.length*2+sizeOf(value[key]),0)}
function truth(path,column='message_json'){return `CASE COALESCE(json_type(${column},'${path}'),'null') WHEN 'null' THEN 0 WHEN 'false' THEN 0 WHEN 'integer' THEN json_extract(${column},'${path}')<>0 WHEN 'real' THEN json_extract(${column},'${path}')<>0 WHEN 'text' THEN json_extract(${column},'${path}')<>'' ELSE 1 END`}
function headerTruthy(db,key){return Boolean(stmt(db,`SELECT ${truth('$','value_json')} AS present FROM archive_head_fields WHERE key=?`).get(key)?.present)}

export function createChatProjectionReads({helpers,maxEntries=8,maxBytes=16*1024*1024,timelineRowsFor,beforeRead,afterRead,rowStats}) {
  const cache=new Map();let bytes=0
  // 零预算＝真禁用（maxBytes<=0 或 maxEntries<=0 一律不保留，也不给 oversized 开一档）
  const cacheDisabled=()=>!(maxBytes>0)||!(maxEntries>0)
  const requireHelper=name=>{if(typeof helpers[name]!=='function')throw Error('SQL投影按需读取缺少作者helper '+name+'，请更新标准存储shim');return helpers[name]}
  // timeline 子行缓存：默认随条目（历史行为）；给了 timelineRowsFor 就改成按连接持有，
  // 由 store 写口的精确写集（writeTimelineNodes 的 {rows, full}）失效，与完整态读缓存同刀。
  const rowsOf = current => timelineRowsFor ? timelineRowsFor(current.db) : current.timelineNodes
  function entry(db,id,revision){
    const compRev=componentRevisions(db)
    const previous=cache.get(id)
    if(previous){bytes-=previous.bytes;cache.delete(id)}
    if(previous&&previous.db===db&&previous.revision===revision){
      // DB revision 相同＝本进程写后 bump 过、部件版本已同步 → 全命中
      return previous
    }
    if(previous&&previous.db===db){
      // DB revision 变了：按部件版本决定哪些缓存组件需要重建。
      // 部件版本没变而 DB revision 变了 ⇒ 外部写入（非本进程）⇒ 保守全量失效。
      const headerStale=previous.compRev.header!==compRev.header
      const messagesStale=previous.compRev.messages!==compRev.messages
      // PR10 修复①（standalone 形态）：无宿主 beforeRead 探针、本进程又无部件证据却 revision 变了 ⇒ 当外部写，
      // 清掉该连接的行缓存（保住『外部提交不得返回旧行』旧契约；有探针时由探针精确清）。
      if(!headerStale&&!messagesStale&&typeof beforeRead!=='function'){const rows=rowsOf(previous);if(rows&&typeof rows.clear==='function')rows.clear()}
      if(headerStale||messagesStale){
        // 审查修复②（2026-10-06）：header 变更必须连清内嵌 header 的 full/scene/display
        //   （修A 只清 sessionHead 是漏项，此前被写后整条 forget 掩盖）；
        //   同时回减字节（审查修复①：否则记账单调膨胀，条目被顶过 maxBytes 后缓存自毁）。
        if(headerStale){
          for(const label of [...previous.keys.keys()]){previous.bytes-=sizeOf(previous.keys.get(label))}
          previous.keys.clear()
          // 外部行缓存不在这里清：行内容由写口的 timeline 写集精确失效（invalidate），
          // 头部字段变更不动任何子行；整表重解析 59MB 的代价比这保守一丁点贵得多。
          if (previous.timelineNodes && previous.timelineNodes.size && !timelineRowsFor) {
            for(const value of previous.timelineNodes.values())previous.bytes-=sizeOf(value)
            previous.timelineNodes.clear()
          }
          previous.oldBody=undefined
          release(previous,'full');release(previous,'scene');release(previous,'display')
        }
        if(messagesStale){
          release(previous,'summaries');release(previous,'full');release(previous,'scene');release(previous,'display')
          previous.pending=undefined
        }
        previous.revision=revision
        previous.compRev={header:compRev.header,messages:compRev.messages}
        return previous
      }
    }
    return {db,revision,compRev:{header:compRev.header,messages:compRev.messages},keys:new Map(),timelineNodes:new Map(),oldBody:undefined,bytes:0}
  }
  /** 审查修复①（2026-10-06）：释放缓存组件时回减字节。各 populate 点记录 delta
   *  （summariesBytes/sceneBytes/displayBytes/fullBytes），释放与加法严格对称；
   *  池键的加/减用同一份 sizeOf。否则写→读循环会让 bytes 单调膨胀，
   *  真实档（池+full≈14MB）第一次写读后即超 maxBytes → remember 拒收 → 缓存自毁。 */
  function release(current,component){
    if(current[component]===undefined)return
    current.bytes-=(current[component+'Bytes']||0)
    current[component+'Bytes']=0
    current[component]=undefined
  }
  /** 键级池适配器：池值计入条目字节（与 summaries/full 同式，供 maxBytes 淘汰判断）。
   *  P2-a：timeline 行缓存；ownedTimelineNodes 标记它是否随条目生灭（外部按连接持有的不占预算、
   *  也不由 header 变更整清）。 */
  function poolOf(current){
    const external=timelineRowsFor!==undefined
    return {
      has:key=>current.keys.has(key),
      get:key=>current.keys.get(key),
      set:(key,value)=>{if(!current.keys.has(key))current.bytes+=sizeOf(value);current.keys.set(key,value)},
      timelineNodes:cacheDisabled()?undefined:rowsOf(current),
      ownedTimelineNodes:!external,
      addBytes:delta=>{current.bytes+=delta},
    }
  }
  /** P2-a：timeline 子行粒度失效（行缓存精确删行；full 全清）。记账与 fill 严格对称（BUG① 纪律）：
   *  随条目生灭的行缓存要回减字节；外部按连接持有的不占条目预算，只删行。 */
  function dropTimelineRows(current, timeline) {
    const rows = rowsOf(current)
    if(!rows)return   // 预算禁用时 rowsOf(current) 返回 undefined（不得对 undefined 调 delete/clear）
    if (!timeline.full) {for (const nodeKey of timeline.rows || []) rows.delete(nodeKey);return;}
    if (!timelineRowsFor) for (const value of rows.values()) current.bytes -= sizeOf(value)
    rows.clear()
  }
  /** 单条就超过总预算（大档 timeline/大头部）时允许它独占一个槽：投影缓存被击穿的代价是
   *  每次快照都整表重解析（实测 59MB/次），比同一时刻多占一份解析结果贵得多。 */
  function remember(id,current){
    if(cacheDisabled())return
    if(maxEntries<=0)return
    while(cache.size>0 && bytes+current.bytes>maxBytes){const key=cache.keys().next().value;bytes-=cache.get(key).bytes;cache.delete(key)}
    if(current.bytes>maxBytes&&cache.size>0)return
    cache.set(id,current);bytes+=current.bytes
    // 条数上限照旧回收；但 oversized 独占槽不自我淘汰（它已是最后一道防线）。
    while(cache.size>1 && cache.size>maxEntries){const key=cache.keys().next().value;bytes-=cache.get(key).bytes;cache.delete(key)}
  }
  function snapshot(db,id,read){return readSqlSnapshot(db,()=>{
    // PR10 修复①：宿主探针必须在 head 查询之前（BEGIN 之后）⇒ 覆盖 handle→BEGIN 之间的外部提交 race
    if(typeof beforeRead==='function')beforeRead(db,id)
    const head=stmt(db,"SELECT revision,(SELECT value_json FROM archive_head_fields WHERE key='id') AS chat_id FROM archive_head WHERE id=1").get()
    if(!head)return undefined
    if(parse(head.chat_id)!==id)throw Error('Archive state 不合法: '+id)
    const revision=Number(head.revision),current=entry(db,id,revision)
    const result=read(current,revision);remember(id,current);if(typeof afterRead==='function')afterRead();return result
  })}
  /** R-2：oldBody 判定按 timeline 部件版本记忆（写口 timeline 变更时 invalidate 清），每轮至多一次 SQL。 */
  function oldBodyOf(db,current){
    if(current.oldBody===undefined)current.oldBody=timelineOldBody(db)
    return current.oldBody
  }
  function summaries(current){
    if(current.summaries)return current.summaries
    const project=requireHelper('projectSessionMessage'),rows=stmt(current.db,summarySql()).all()
    current.summaries=rows.map(row=>{
      if(row.row_type!=='object')return project(parse(row.unusual))
      const input=decode(row,SUMMARY_FIELDS)
      if(!row.has_mvu)delete input.mvu;else input.mvu ||= {}
      if(!row.has_import)delete input.importSource;else input.importSource ||= {}
      return project(input)
    });const summariesBytes=weight(rows)+sizeOf(current.summaries);current.summariesBytes=summariesBytes;current.bytes+=summariesBytes
    const pending=stmt(current.db,`SELECT ${truth('$.mvu.pendingSubmission')} AS submitted,${truth('$.mvu.delivery.prepared')} AS prepared FROM archive_messages WHERE json_type(message_json,'$.mvu.pending')='true' AND json_extract(message_json,'$.role')='assistant' ORDER BY message_index DESC LIMIT 1`).get()
    current.pending=pending?{hasSubmission:Boolean(pending.submitted),prepared:Boolean(pending.prepared)}:null
    return current.summaries
  }
  return Object.freeze({
    session(db,id,options={}){return snapshot(db,id,(current,revision)=>{
      // R-1/R-2：先判 oldBody（记忆化 SQL），legacy 前台上屏档直接回 {full:true} 走内存路径，
      // 连头部投影都不再组装。R-5：头部按键池组装（命中零 SQL、零 parse）。
      if(oldBodyOf(db,current))return {full:true}
      const pool=poolOf(current)
      const chat=readProjectionHeader(db,SESSION_FIELDS,revision,pool)
      if(headerTruthy(db,'rollbackUndo'))chat.rollbackUndo=readProjectionHeader(db,UNDO_FIELDS.map(key=>'rollbackUndo.'+key),revision,pool).rollbackUndo || {}
      const rows=summaries(current)
      const pendingMvuSettlement=Object.hasOwn(chat,'pendingMvuSettlement')?chat.pendingMvuSettlement:current.pending
      if(options.scoped===true){
        const scoped=requireHelper('createScopedMessages'),owned=new Map()
        const messages=scoped(rows.length,[],index=>{if(!owned.has(index))owned.set(index,helpers.copyJsonTree(rows[index]));return owned.get(index)})
        return {value:helpers.projectChatSessionState(chat,{pendingMvuSettlement,messages})}
      }
      if(!current.full){current.full=helpers.projectChatSessionState({...chat,messages:rows},{pendingMvuSettlement});const fullBytes=sizeOf(current.full);current.fullBytes=fullBytes;current.bytes+=fullBytes}
      return {value:helpers.copyJsonTree(current.full)}
    })},
    /** 直接头部读（readWindow/readHelperContext/readSettlementBase 的 source.header）：
     *  与投影读共用键级池（全键形状也一样，见 readProjectionHeader 的 else 分支），
     *  出借前一律 copyJsonTree 脱离——调用方会往 chat 上挂 messages 并可能继续改。 */
    header(db,id,fields){return snapshot(db,id,(current,revision)=>helpers.copyJsonTree(readProjectionHeader(db,fields,revision,poolOf(current))))},
    background(db,id){return snapshot(db,id,(current,revision)=>helpers.projectChatBackgroundConfig(readProjectionHeader(db,BACKGROUND_FIELDS,revision,poolOf(current))))},
    scene(db,id){return snapshot(db,id,(current,revision)=>{
      if(!current.scene){const rows=stmt(db,rowsSql(SCENE_ROW_FIELDS)).all();current.scene=helpers.projectSceneImageState({...readProjectionHeader(db,SCENE_FIELDS,revision,poolOf(current)),messages:rows.map(row=>decode(row,SCENE_ROW_FIELDS))});const sceneBytes=weight(rows)+sizeOf(current.scene);current.sceneBytes=sceneBytes;current.bytes+=sceneBytes}
      return helpers.copyJsonTree(current.scene)
    })},
    display(db,id,turn){return snapshot(db,id,(current,revision)=>{
      if(!current.display){const rows=stmt(db,rowsSql(DISPLAY_ROW_FIELDS)).all();current.display=rows.map(row=>decode(row,DISPLAY_ROW_FIELDS));const displayBytes=weight(rows);current.displayBytes=displayBytes;current.bytes+=displayBytes}
      const rows=current.display.map((row,index)=>row && typeof row==='object'?{...row,get displayRuntime(){return parse(stmt(db,"SELECT message_json -> '$.displayRuntime' AS value_json FROM archive_messages WHERE message_index=?").get(index)?.value_json)}}:row)
      const chat=readProjectionHeader(db,DISPLAY_FIELDS,revision,poolOf(current))
      if(headerTruthy(db,'rollbackUndo'))chat.rollbackUndo ||= {}
      return helpers.projectDisplayRuntimeState({...chat,messages:rows},turn)
    })},
    checkpoint(db,id,messageId,operationId){return snapshot(db,id,(current,revision)=>{
      if(oldBodyOf(db,current))return undefined
      // R-1：只取作者投影真正消费的 timeline 子集，不整条 parse（实测整键 7.23ms → 子集 ~3.5ms，且不含 1MB 静态键）
      const timeline=readTimelineSubset(db,operationId)
      if(timeline===undefined)return undefined
      const chat=readProjectionHeader(db,['id','sessionId','_storageRevision','tavernHelperLifecycleRevision'],revision,poolOf(current))
      chat.timeline=timeline
      const row=Number.isSafeInteger(messageId)&&messageId>=0?stmt(db,'SELECT message_json FROM archive_messages WHERE message_index=?').get(messageId):undefined
      const messages=[];if(row)messages[messageId]=parse(row.message_json)
      return helpers.projectSettlementCheckpoint({...chat,messages},messageId,operationId)
    })},
    /** 写后精确失效（R-5）：写口按实际改动删键池，不再整条丢缓存。
     *  keys=变更的顶层键（含删除键）；messages=楼层行有变（含 K4 修剪）；
     *  timeline={rows:[变更 node_key], full}＝P2-a 子行粒度（行缓存精确删行）。
     *  审查修复①（2026-10-06）：删池键/清组件一律回减字节（与 populate 的加法对称），
     *  否则写→读循环 bytes 单调膨胀，条目被顶过 maxBytes 后缓存自毁（真实档第一次写读即触发）。 */
    invalidate(id,{revision,keys=[],messages=false,timeline}={}){
      const current=cache.get(id)
      if(!current)return
      const drop=label=>{
        if(!current.keys.has(label))return
        current.bytes-=sizeOf(current.keys.get(label))
        current.keys.delete(label)
      }
      for(const key of keys)for(const label of [...current.keys.keys()])if(label===key||label.startsWith(key+'.'))drop(label)
      if(keys.length){release(current,'full');release(current,'scene');release(current,'display')}
      if(keys.includes('timeline'))current.oldBody=undefined
      if(messages){release(current,'summaries');release(current,'full');release(current,'scene');release(current,'display');current.pending=undefined}
      // P2-a：timeline 子行粒度失效（行缓存精确删行；full 全清）。
      if(timeline)dropTimelineRows(current,timeline)
      // 消费掉本次推进：entry() 不再对同一批改动二次全清（外部写仍走它的保守路径）。
      if(Number.isSafeInteger(revision))current.revision=revision
      const compRev=componentRevisions(current.db)
      current.compRev={header:compRev.header,messages:compRev.messages}
    },
    /** 只读诊断（测试与排障用）：条目数、总字节、逐档字节。 */
    stats(){return {entries:cache.size,bytes,perChat:cache.size?[...cache.entries()].map(([id,entry])=>({id,bytes:entry.bytes})):[],...(typeof rowStats==='function'?{timelineRows:rowStats()}: {})}},
    forget(id){const current=cache.get(id);if(current)bytes-=current.bytes;cache.delete(id)},
    dispose(){cache.clear();bytes=0},
  })
}
