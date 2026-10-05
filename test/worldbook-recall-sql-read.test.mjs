// 召回日志读取：面板请求必须由 SQL 先筛（chat/branch/turn 可选的 created_at DESC, operation_id DESC LIMIT 1），
// 只对最终候选行 parse payload；轮次菜单只做 metadata-only 投影，绝不 parse value_json。
// 本文件独立自有 tmp DB + 独立 fixture，不触真实档、不做整表 JSON 往返、不新增产品后门/探针。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'

// 每次用例独立 root；空 old map = 无旧索引，migrate 直接短路，只走 SQL 路径。
function freshStore(seed){
 const root=mkdtempSync(path.join(os.tmpdir(),'recall-sql-read-')),old=new Map()
 if(seed)seed({root,old})
 const store=createRollbackWorldbookRecallLog({dataRoot:root,store:{readJson:async p=>old.get(p),remove:async p=>{old.delete(p)}}})
 return {root,old,store}
}

// 直连自有 DB 造状态：绕过 record() 的业务字段，才能精确摆放 created_at / turn / branch / 损坏 payload。
function seedRows(root,rows){
 const db=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
 try{
  const ins=db.prepare('INSERT INTO recalls VALUES(?,?,?,?,?,?)')
  for(const r of rows){
    let value=r.valueJson
    try{value=JSON.stringify({...JSON.parse(value),chatId:r.chatId,createdAt:r.createdAt})}catch{/* 故意损坏的负载保留原字节。 */}
    ins.run(r.chatId,r.operationId,r.turn,r.branchId??null,r.createdAt,value)
   }
 }finally{db.close()}
}

function countRows(root,sql,...params){
 const db=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
 try{return db.prepare(sql).get(...params).n}finally{db.close()}
}

// 旧契约内存 oracle：升序 (created_at, operation_id) → findLast(match) → 首次出现去重。
// 仅用于小型 synthetic 对照，不作为产品实现。
function legacyRead(rows,chat,turn){
 const sorted=[...rows].sort((a,b)=>a.createdAt-b.createdAt||(a.operationId<b.operationId?-1:a.operationId>b.operationId?1:0))
 const target=sorted.findLast(r=>(!turn||r.turn===Number(turn))&&(!chat.timeline?.branchId||r.branchId===chat.timeline.branchId))
 const availableTurns=[...new Set(sorted.filter(r=>!chat.timeline?.branchId||r.branchId===chat.timeline.branchId).map(r=>r.turn))]
 return {log:target||null,availableTurns}
}

const payload=(turn,operationId,branchId,extra)=>JSON.stringify({version:1,status:'prepared',turn,operationId,branchId,chatId:'fixture',sessionId:'session',outputs:[{text:'业务'+turn}],...extra})

test('case1 最新按 created_at 而非最大 turn；同 created_at 由 operation_id 降序夺标',async()=>{
 // 第200轮的召回是更早写的（createdAt 小）：旧 max-turn 思路会错取它。
 const {root,store}=freshStore()
 try{
  seedRows(root,[
   {chatId:'fixture',operationId:'op200',turn:200,branchId:'main',createdAt:1000,valueJson:payload(200,'op200','main')},
   {chatId:'fixture',operationId:'op015',turn:15,branchId:'main',createdAt:5000,valueJson:payload(15,'op015','main')},
  ])
  const r=await store.read({id:'fixture',timeline:{branchId:'main'}},null)
  assert.equal(r.log.turn,15,'最新必须按 created_at 取第15轮，而不是最大 turn 的200')
  assert.equal(r.log.createdAt,5000)
  assert.deepEqual(r.availableTurns,[200,15],'availableTurns 是首次出现顺序，不是数值排序')

  // 同 created_at：operation_id 字典序大者胜（非 max-turn）；共用 chat 避免反例被主键撞掉。
  const b=freshStore()
  try{
   seedRows(b.root,[
    {chatId:'fixture',operationId:'op015',turn:15,branchId:'main',createdAt:9000,valueJson:payload(15,'op015','main')},
    {chatId:'fixture',operationId:'op200',turn:200,branchId:'main',createdAt:9000,valueJson:payload(200,'op200','main')},
   ])
   const rb=await b.store.read({id:'fixture',timeline:{branchId:'main'}},null)
   assert.equal(rb.log.operationId,'op200','同时间戳应以较大 operation_id 夺标')
   assert.equal(rb.log.turn,200)
   assert.deepEqual(rb.availableTurns,[15,200])
  }finally{b.store.dispose();rmSync(b.root,{recursive:true,force:true})}
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case2 指定早期 turn 仍取该轮；第200轮日志里保留的第15轮承诺内容完整不被截断',async()=>{
 const {root,store}=freshStore()
 const promise='我答应过：第15轮结束前把北门的钥匙交给守夜人。'
 try{
  seedRows(root,[
   {chatId:'fixture',operationId:'op015',turn:15,branchId:'main',createdAt:3000,valueJson:JSON.stringify({version:1,status:'requested',turn:15,operationId:'op015',branchId:'main',chatId:'fixture',sessionId:'session',outputs:[{text:promise,location:'foreground'}]})},
   {chatId:'fixture',operationId:'op050',turn:50,branchId:'main',createdAt:4000,valueJson:payload(50,'op050','main')},
   {chatId:'fixture',operationId:'op200',turn:200,branchId:'main',createdAt:6000,valueJson:JSON.stringify({version:1,status:'prepared',turn:200,operationId:'op200',branchId:'main',chatId:'fixture',sessionId:'session',outputs:[{text:'第200轮正文'},{text:promise,location:'foreground'}]})},
  ])
  const chat={id:'fixture',timeline:{branchId:'main'}}
  const latest=await store.read(chat,null)
  assert.equal(latest.log.turn,200,'无 turn 参数时取最新一轮')
  assert.equal(latest.log.outputs[1].text,promise,'第200轮日志内嵌的承诺内容必须原样保留，不做截断/改写')

  const early=await store.read(chat,15)
  assert.equal(early.log.turn,15,'指定早期轮次必须精确命中该轮')
  assert.equal(early.log.outputs[0].text,promise,'指定早期轮次时承诺内容完整')
  assert.equal(early.message,'','命中时不应给出兜底提示')

  const earlyAsString=await store.read(chat,'15')
  assert.equal(earlyAsString.log.turn,15,'字符串轮次按 Number() 归一')
  assert.deepEqual(latest.availableTurns,[15,50,200])
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case3 有 branch 只认本分支；无 branch 跨分支取最新；不同 chat 相互隔离',async()=>{
 const {root,store}=freshStore()
 try{
  seedRows(root,[
   {chatId:'fixture',operationId:'opOld',turn:10,branchId:'old',createdAt:2000,valueJson:payload(10,'opOld','old')},
   {chatId:'fixture',operationId:'opNew',turn:11,branchId:'new',createdAt:7000,valueJson:payload(11,'opNew','new')},
   {chatId:'other',operationId:'opX',turn:99,branchId:'new',createdAt:9999,valueJson:payload(99,'opX','new')},
  ])
  const scoped=await store.read({id:'fixture',timeline:{branchId:'new'}},null)
  assert.equal(scoped.log.operationId,'opNew','分支存在时不得串到 old 分支')
  assert.deepEqual(scoped.availableTurns,[11],'轮次菜单按同一分支过滤')

  const unscoped=await store.read({id:'fixture'},null)
  assert.equal(unscoped.log.operationId,'opNew','无分支约束时取全 chat 最新（new 的 created_at 更大）')
  assert.deepEqual(unscoped.availableTurns,[10,11],'无分支约束时不按分支过滤')

  const other=await store.read({id:'other',timeline:{branchId:'new'}},null)
  assert.equal(other.log.operationId,'opX','不同 chat 互不可见')
  assert.deepEqual(other.availableTurns,[99])

  const missing=await store.read({id:'nobody',timeline:{branchId:'new'}},null)
  assert.equal(missing.log,null)
  assert.deepEqual(missing.availableTurns,[])
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case4 availableTurns 按升序首次出现去重且保持相遇顺序，不受操作顺序影响',async()=>{
 const {root,store}=freshStore()
 try{
  // created_at 升序下的首次出现序列为 [9,3,7,1]；数值排序会是 [1,3,7,9]。
  // 重复轮次与 7 在 tie 中先后出现，用来同时核对去重与 tie 次序。
  const rows=[
   {chatId:'fixture',operationId:'op9',turn:9,branchId:'main',createdAt:100,valueJson:payload(9,'op9','main')},
   {chatId:'fixture',operationId:'op3',turn:3,branchId:'main',createdAt:200,valueJson:payload(3,'op3','main')},
   {chatId:'fixture',operationId:'op7a',turn:7,branchId:'main',createdAt:300,valueJson:payload(7,'op7a','main')},
   {chatId:'fixture',operationId:'op9b',turn:9,branchId:'main',createdAt:300,valueJson:payload(9,'op9b','main')},
   {chatId:'fixture',operationId:'op1',turn:1,branchId:'main',createdAt:400,valueJson:payload(1,'op1','main')},
   {chatId:'fixture',operationId:'op7b',turn:7,branchId:'main',createdAt:500,valueJson:payload(7,'op7b','main')},
   {chatId:'fixture',operationId:'op7c',turn:7,branchId:'main',createdAt:500,valueJson:payload(7,'op7c','main')},
  ]
  seedRows(root,rows)
  const chat={id:'fixture',timeline:{branchId:'main'}}
  const ordered=await store.read(chat,null)
  assert.deepEqual(ordered.availableTurns,[9,3,7,1],'首次出现顺序，不是数值升序')
  assert.deepEqual(legacyRead(rows,chat,null).availableTurns,ordered.availableTurns,'与旧算法 oracle 的小样对照')

  // 指定轮次给出 null 时，menu 仍返回完整去重清单。
  const explicitNull=await store.read(chat,null)
  assert.deepEqual(explicitNull.availableTurns,[9,3,7,1])
  const hit7=await store.read(chat,7)
  assert.equal(hit7.log.turn,7)
  assert.equal(hit7.log.createdAt,500,'同 created_at 的两条 op7 应取字典序更大的 op7c')
  assert.equal(hit7.log.operationId,'op7c')
  assert.deepEqual(hit7.availableTurns,[9,3,7,1])
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case5 空日志/不存在轮次/非数值 turn 均有兜底且不误命中；turn=0 是 falsy 走旧 latest 契约',async()=>{
 const empty=freshStore()
 try{
  const r=await empty.store.read({id:'fixture',timeline:{branchId:'main'}},null)
  assert.equal(r.log,null)
  assert.deepEqual(r.availableTurns,[])
  assert.match(r.message,/没有保存详细召回日志/)
  const r5=await empty.store.read({id:'fixture',timeline:{branchId:'main'}},5)
  assert.equal(r5.log,null)
  assert.deepEqual(r5.availableTurns,[])
  assert.match(r5.message,/没有保存详细召回日志/)
 }finally{empty.store.dispose();rmSync(empty.root,{recursive:true,force:true})}

 const {root,store}=freshStore()
 try{
  seedRows(root,[
   {chatId:'fixture',operationId:'op0',turn:0,branchId:'main',createdAt:1000,valueJson:JSON.stringify({version:1,status:'prepared',turn:0,operationId:'op0',branchId:'main',chatId:'fixture',sessionId:'session',outputs:[{text:'第0轮'}]})},
   {chatId:'fixture',operationId:'op5',turn:5,branchId:'main',createdAt:2000,valueJson:payload(5,'op5','main')},
  ])
  const chat={id:'fixture',timeline:{branchId:'main'}}
  // 旧契约：!turn 为真 → 忽略 turn 过滤 → 取最新（第5轮）。此处按现状钉住，不改语义。
  const zero=await store.read(chat,0)
  assert.equal(zero.log.turn,5,'turn=0 是 falsy：走 latest 契约，不当作筛第0轮')
  const zeroString=await store.read(chat,'0')
  assert.equal(zeroString.log.turn,0,'字符串 "0" 为真值：按第0轮精确筛选，命中 turn=0 的行')
  assert.equal(zeroString.log.outputs[0].text,'第0轮','必须命中0轮自身日志，而非 latest 的第5轮')

  const absent=await store.read(chat,404)
  assert.equal(absent.log,null,'不存在的轮次不得回落到 latest')
  assert.equal(absent.message,'这一轮没有保存详细召回日志；旧轮次不从当前世界书反推。')
  assert.deepEqual(absent.availableTurns,[0,5],'未命中时轮次菜单仍完整')

  // falsy 参数（含 NaN，走 Number 归一）→ 旧 latest 契约；真值但无常量轮次 → 不命中；两者都不得抛错。
  for(const bad of ['abc',NaN,'',null,undefined,true,'5abc',{},1.5]){
   const bad_r=await store.read(chat,bad)
   if(bad)assert.equal(bad_r.log,null,'真值但不匹配有效轮次的参数不得回落到最新')
   else assert.equal(bad_r.log.turn,5,'只有falsy参数走旧latest契约')
  }
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case6 未选中行的损坏 value_json 不影响读取（证明没有全量 parse）；选中行损坏则响亮报错且同 chat queue 可恢复',async()=>{
 const {root,store}=freshStore()
 try{
  seedRows(root,[
   {chatId:'fixture',operationId:'op_broken_old',turn:1,branchId:'main',createdAt:500,valueJson:'{"turn":1,@@@ 损坏'},
   {chatId:'fixture',operationId:'op_good',turn:20,branchId:'main',createdAt:8000,valueJson:payload(20,'op_good','main')},
  ])
  const chat={id:'fixture',timeline:{branchId:'main'}}
  const ok=await store.read(chat,20)
  assert.equal(ok.log.turn,20,'未选中行损坏时仍须正常返回选中行')
  assert.equal(ok.log.outputs[0].text,'业务20')
  assert.deepEqual(ok.availableTurns,[1,20],'轮次菜单由 metadata 得出，不依赖损坏 payload')

  const broken=freshStore()
  try{
   seedRows(broken.root,[
    {chatId:'fixture',operationId:'op_ok_other',turn:2,branchId:'main',createdAt:500,valueJson:payload(2,'op_ok_other','main')},
    {chatId:'fixture',operationId:'op_broken_new',turn:30,branchId:'main',createdAt:9000,valueJson:'{"turn":30,@@@ 损坏'},
   ])
   await assert.rejects(()=>broken.store.read(chat,30),'选中最新行损坏必须响亮报错，不静默降级')
   // 修复后：同 chat 的 serial queue 未被毒化，后续读取必须恢复。
   const db=new DatabaseSync(path.join(broken.root,'worldbook-recalls.db'))
   try{db.prepare('UPDATE recalls SET value_json=? WHERE chat_id=? AND operation_id=?').run(payload(30,'op_broken_new','main'),'fixture','op_broken_new')}finally{db.close()}
   const healed=await broken.store.read(chat,30)
   assert.equal(healed.log.turn,30,'损坏修复后同 chat queue 必须仍可用')
   assert.equal(healed.log.outputs[0].text,'业务30')
   assert.deepEqual(healed.availableTurns,[2,30])
  }finally{broken.store.dispose();rmSync(broken.root,{recursive:true,force:true})}

  // 无分支约束（branch 缺省）时，损坏行也会进入候选：此处仅证明它不影响现有正常读。
  const noBranch=await store.read({id:'fixture'},20)
  assert.equal(noBranch.log.turn,20)
  assert.deepEqual(noBranch.availableTurns,[1,20])
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case7 读取只做 SQL 筛选且不改写库；已持久化行在多次读后逐字不变',async()=>{
 const {root,store}=freshStore()
 try{
  const rows=[
   {chatId:'fixture',operationId:'opA',turn:4,branchId:'main',createdAt:1000,valueJson:payload(4,'opA','main')},
   {chatId:'fixture',operationId:'opB',turn:8,branchId:'main',createdAt:2000,valueJson:payload(8,'opB','main')},
   {chatId:'other',operationId:'opC',turn:8,branchId:'main',createdAt:3000,valueJson:payload(8,'opC','main')},
  ]
  seedRows(root,rows)
  const snapshot=()=>{
   const db=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
   try{return db.prepare('SELECT chat_id,operation_id,turn,branch_id,created_at,value_json FROM recalls ORDER BY chat_id,operation_id').all()}finally{db.close()}
  }
  const before=snapshot()
  const chat={id:'fixture',timeline:{branchId:'main'}}
  await store.read(chat,null);await store.read(chat,4);await store.read(chat,999);await store.read({id:'other'},null)
  assert.deepEqual(snapshot(),before,'read 必须只读：行内容逐字不变')
  assert.equal(countRows(root,'SELECT COUNT(*) n FROM recalls WHERE chat_id=?','fixture'),2,'read 不得增删行')
  assert.equal(countRows(root,'SELECT COUNT(*) n FROM recalls'),3,'read 不得跨 chat 增删行')
  // read 不产生旧文件副作用（fixture 的 store 无任何 write 通道，此处核对目录仍只有 DB 与其 WAL 边车）。
  const names=(await import('node:fs')).readdirSync(root).sort()
  assert.ok(names.includes('worldbook-recalls.db'),'DB 必须存在')
  assert.ok(!names.includes('worldbook-recalls'),'不得回退成旧文件式存储目录')
  assert.ok(!names.includes('index.json'),'read 不得写出旧索引')
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})

test('case8 record 仍落 SQL 行且读回一致；pruneRollback 尾部清零契约不变',async()=>{
 const {root,store}=freshStore()
 try{
  const chat={id:'fixture',sessionId:'session',timeline:{branchId:'main'}}
  const frame=t=>({turn:t,operationId:'op'+t,branchId:'main',frameId:'f'+t,basedOnRevision:1})
  await store.record({chat,frame:frame(1),log:{outputs:[{text:'一'}]}})
  await store.record({chat,frame:frame(2),log:{outputs:[{text:'二'}]}})
  const r=await store.read(chat,null)
  assert.equal(r.log.turn,2,'record 之后最新为第2轮')
  assert.equal(r.log.status,'prepared')
  assert.equal(r.log.version,1)
  assert.deepEqual(r.availableTurns,[1,2])
  assert.equal(countRows(root,'SELECT COUNT(*) n FROM recalls WHERE chat_id=?','fixture'),2)

  await store.pruneRollback(chat,2,'main')
  assert.equal(countRows(root,'SELECT COUNT(*) n FROM recalls WHERE chat_id=? AND turn>=?','fixture',2),0,'回退尾部必须清零')
  const after=await store.read(chat,null)
  assert.equal(after.log.turn,1)
  assert.deepEqual(after.availableTurns,[1])
  assert.equal((await store.read(chat,2)).log,null)
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})
