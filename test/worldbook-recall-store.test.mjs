import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'
test('旧召回精确迁入SQL后物理删53，保留52并重绑分支；重试不重新导入旧数据',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-recalls-')),old=new Map(),chat={id:'fixture',sessionId:'session',timeline:{branchId:'old'}}
 for(const turn of [52,53])old.set('worldbook-recalls/fixture/op'+turn+'.json',{chatId:chat.id,sessionId:chat.sessionId,turn,operationId:'op'+turn,branchId:'old',createdAt:turn,outputs:[{text:'业务'+turn}]})
 old.set('worldbook-recalls/fixture/index.json',{records:[52,53].map(turn=>({operationId:'op'+turn,path:'worldbook-recalls/fixture/op'+turn+'.json'}))})
 const removed=[],store=createRollbackWorldbookRecallLog({dataRoot:root,store:{readJson:async p=>old.get(p),remove:async p=>{removed.push(p);old.delete(p)}}})
 try{
  await store.pruneRollback(chat,53,'new');await store.pruneRollback(chat,53,'new')
  assert.equal(old.size,0);assert.equal(removed.length,3)
  const read=await store.read({...chat,timeline:{branchId:'new'}});assert.deepEqual(read.availableTurns,[52]);assert.equal(read.log.outputs[0].text,'业务52')
  const db=new DatabaseSync(path.join(root,'worldbook-recalls.db'));try{assert.equal(db.prepare('SELECT COUNT(*) n FROM recalls WHERE turn>=53').get().n,0)}finally{db.close()}
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})
test('record 后按 10 轮窗口裁剪，prune(chatId) 复裁并回报删除数',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-recalls-retain-')),old=new Map(),chat={id:'fixture',sessionId:'session',timeline:{branchId:'b1'}}
 const removed=[],store=createRollbackWorldbookRecallLog({dataRoot:root,now:()=>1000,store:{readJson:async p=>old.get(p),remove:async p=>{removed.push(p);old.delete(p)}}})
 try{
  // 写 15 轮；record 内 retain 应立即裁到只留最近 10 个 turn。
  for(let turn=1;turn<=15;turn++)await store.record({chat,frame:{turn,operationId:'op'+turn,frameId:'f'+turn,branchId:'b1',basedOnRevision:turn},log:{entries:[],outputs:[{text:'正文'+turn}]}})
  let db=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
  let turns=db.prepare('SELECT turn FROM recalls WHERE chat_id=? ORDER BY turn').all('fixture').map(r=>r.turn)
  db.close()
  assert.deepEqual(turns,[6,7,8,9,10,11,12,13,14,15],'record 后必须只留最近 10 轮，实际 '+JSON.stringify(turns))
  // prune 幂等：刚裁过，再调一次不得再删。
  const again=await store.prune('fixture')
  assert.equal(again.pruned,0,'无新轮次时 prune 必须删 0 行')
  // 再写一轮到 16，旧窗口整体前移。
  await store.record({chat,frame:{turn:16,operationId:'op16',frameId:'f16',branchId:'b1',basedOnRevision:16},log:{entries:[],outputs:[{text:'正文16'}]}})
  db=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
  turns=db.prepare('SELECT turn FROM recalls WHERE chat_id=? ORDER BY turn').all('fixture').map(r=>r.turn)
  db.close()
  assert.deepEqual(turns,[7,8,9,10,11,12,13,14,15,16],'写入第16轮后窗口应前移到 7..16，实际 '+JSON.stringify(turns))
  // prune 对不存在的档不得报错、不得删任何行。
  const none=await store.prune('no-such-chat')
  assert.equal(none.pruned,0,'不存在的档 prune 必须为 0')
  // read 的 availableTurns 只反映窗口内轮次。
  const read=await store.read({...chat,timeline:{branchId:'b1'}})
  assert.deepEqual(read.availableTurns,[7,8,9,10,11,12,13,14,15,16],'availableTurns 必须与保留窗口一致')
  assert.equal(read.log.turn,16,'未指定 turn 时 read 必须取最新一轮')
 }finally{store.dispose();rmSync(root,{recursive:true,force:true})}
})
test('outputs 逐行化：三态还原、主行瘦身、requested 只改布尔列、级联删除',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-recalls-outputs-')),old=new Map(),chat={id:'fixture',sessionId:'session',timeline:{branchId:'b1'}}
 const store=createRollbackWorldbookRecallLog({dataRoot:root,now:()=>1000,store:{readJson:async p=>old.get(p),remove:async p=>{old.delete(p)}}})
 const db=()=>new DatabaseSync(path.join(root,'worldbook-recalls.db'))
 try{
  const outputs=[
   {ref:'entry:1',text:'前台正文甲',location:'foreground'},
   {ref:'entry:2',text:'前缀正文乙',location:'prefix'},
   {ref:'entry:3',text:'后台正文丙',location:'background'},
  ]
  await store.record({chat,frame:{turn:1,operationId:'op1',frameId:'f1',branchId:'b1',basedOnRevision:1},log:{entries:[{ref:'entry:1'}],outputs}})
  // ① 主行不再含 outputs；entries 仍留主行（不做 slim）；outputs 逐行落 3 行
  let d=db(),main=JSON.parse(d.prepare('SELECT value_json v FROM recalls WHERE operation_id=?').get('op1').v)
  assert.equal('outputs' in main,false,'主行 value_json 不得再含 outputs')
  assert.deepEqual(main.entries,[{ref:'entry:1'}],'entries 仍留在主行，不做 slim')
  assert.equal(d.prepare('SELECT COUNT(*) n FROM recall_outputs WHERE operation_id=?').get('op1').n,3,'outputs 必须逐行落 3 行')
  const beforeLen=d.prepare('SELECT LENGTH(value_json) n FROM recalls WHERE operation_id=?').get('op1').n
  d.close()
  // ② read 三态还原：未请求时不得出现 requestContainsText 键
  let read=await store.read({...chat,timeline:{branchId:'b1'}},1)
  assert.equal(read.log.outputs.length,3,'read 必须还原 3 个 output')
  assert.deepEqual(Object.keys(read.log.outputs[0]).sort(),['location','ref','text'],'未请求时不得带 requestContainsText 键，实际 '+JSON.stringify(Object.keys(read.log.outputs[0])))
  assert.equal(read.log.outputs[0].ref,'entry:1');assert.equal(read.log.outputs[0].text,'前台正文甲');assert.equal(read.log.outputs[0].location,'foreground')
  // ③ requested：foreground 得布尔、非 foreground 得 null；主行只增少量元数据字节
  await store.requested({...chat,foregroundFrames:{f1:{operationId:'op1',frameId:'f1',source:{worldBook:{recallLog:'worldbook-recalls/fixture/op1.json'}}}}},{messages:[{role:'user',source:{form:'foreground-frame',trace:{frameId:'f1'}},content:[{type:'text',text:'这里包含前台正文甲与别的内容'}]}]},'req-1')
  read=await store.read({...chat,timeline:{branchId:'b1'}},1)
  assert.equal(read.log.outputs[0].requestContainsText,true,'foreground 项命中正文应为 true')
  assert.equal(read.log.outputs[1].requestContainsText,null,'非 foreground 项应为 null')
  assert.equal(read.log.outputs[2].requestContainsText,null,'非 foreground 项应为 null')
  assert.equal(read.log.status,'requested');assert.deepEqual(read.log.requestIds,['req-1'])
  d=db();const afterLen=d.prepare('SELECT LENGTH(value_json) n FROM recalls WHERE operation_id=?').get('op1').n;d.close()
  assert.ok(afterLen-beforeLen<200,'requested 只应给主行增加少量元数据字节，实际增加 '+(afterLen-beforeLen)+'（改造前会重写整个 outputs 正文）')
  // ④ 级联：retain 与 pruneRollback 都必须同时清掉 outputs 行
  for(let turn=2;turn<=12;turn++)await store.record({chat,frame:{turn,operationId:'op'+turn,frameId:'f'+turn,branchId:'b1',basedOnRevision:turn},log:{entries:[],outputs:[{ref:'e'+turn,text:'正文'+turn,location:'foreground'}]}})
  d=db();const left=d.prepare('SELECT COUNT(*) n FROM recalls WHERE chat_id=?').get('fixture').n,leftOut=d.prepare('SELECT COUNT(*) n FROM recall_outputs WHERE chat_id=?').get('fixture').n
  assert.equal(left,10,'窗口后主行应留 10 行');assert.equal(leftOut,10,'outputs 行必须与主行同步裁剪到 10，实际 '+leftOut)
  assert.equal(d.prepare('SELECT COUNT(*) n FROM recall_outputs WHERE chat_id=? AND operation_id NOT IN (SELECT operation_id FROM recalls WHERE chat_id=?)').get('fixture','fixture').n,0,'不得残留无主行的 outputs')
  d.close()
  await store.pruneRollback({...chat,id:'fixture'},12,'b2')
  d=db();assert.equal(d.prepare('SELECT COUNT(*) n FROM recalls WHERE chat_id=?').get('fixture').n,9,'回退到12轮后主行应留 9');assert.equal(d.prepare('SELECT COUNT(*) n FROM recall_outputs WHERE chat_id=?').get('fixture').n,9,'回退后 outputs 行必须级联删到 9');d.close()
 }finally{store.dispose();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
})
test('outputs 升级幂等：旧格式主行重开后拆进行表且可读，重复构造不重复拆',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'rollback-recalls-upgrade-')),old=new Map(),chat={id:'fixture',sessionId:'session',timeline:{branchId:'b1'}}
 const store=createRollbackWorldbookRecallLog({dataRoot:root,now:()=>1000,store:{readJson:async p=>old.get(p),remove:async p=>{old.delete(p)}}})
 try{
  // 直接写一条旧格式行（outputs 塞在主行 value_json 里），模拟升级前的存量数据
  const d=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
  d.prepare('INSERT INTO recalls VALUES(?,?,?,?,?,?)').run('fixture','opLegacy',99,'b1',1000,JSON.stringify({version:1,status:'requested',turn:99,operationId:'opLegacy',branchId:'b1',createdAt:1000,requestedAt:7777,requestIds:['req-old'],chatId:'fixture',outputs:[{ref:'L1',text:'前台旧正文',location:'foreground',requestContainsText:true},{ref:'L2',text:'前缀旧正文',location:'prefix',requestContainsText:null}]}))
  d.close()
  // 注意：store 不在测试体 dispose，统一放到 finally，避免二次 close 占住 WAL 句柄导致清理失败。
  // reopened 与 store 可同时持有同一库（WAL 多连接），先由 reopened 触发一次性升级。
  const reopened=createRollbackWorldbookRecallLog({dataRoot:root,now:()=>1000,store:{readJson:async p=>old.get(p),remove:async p=>{old.delete(p)}}})
  try{
   const d2=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
   const legacyMain=JSON.parse(d2.prepare('SELECT value_json v FROM recalls WHERE operation_id=?').get('opLegacy').v)
   assert.equal('outputs' in legacyMain,false,'升级后旧行主行不得再含 outputs')
   assert.equal(d2.prepare('SELECT COUNT(*) n FROM recall_outputs WHERE operation_id=?').get('opLegacy').n,2,'升级应把旧 outputs 拆成 2 行（该fixture 有 2 个 output）')
   d2.close()
   const legacyRead=await reopened.read({...chat,timeline:{branchId:'b1'}},99)
   assert.equal(legacyRead.log.outputs.length,2,'升级后旧数据的 outputs 必须完整还原')
   assert.equal(legacyRead.log.outputs[0].text,'前台旧正文','升级后旧数据仍可读')
   assert.equal(legacyRead.log.outputs[0].ref,'L1')
   // 关键回归：requestedAt 是主行级字段，升级时必须透传到 outputs 行，否则三态会塌成「未请求」
   assert.equal(legacyRead.log.outputs[0].requestContainsText,true,'升级后 foreground 项必须保留 requestContainsText=true')
   assert.equal(legacyRead.log.outputs[1].requestContainsText,null,'升级后非 foreground 项必须保留 requestContainsText=null')
   assert.equal(legacyRead.log.status,'requested','升级后主行 status 必须保留')
   assert.deepEqual(legacyRead.log.requestIds,['req-old'],'升级后 requestIds 必须保留')
  }finally{reopened.dispose()}
  // 再重开一次：幂等，不得重复拆（行数仍为 1，主行仍无 outputs）
  const third=createRollbackWorldbookRecallLog({dataRoot:root,now:()=>1000,store:{readJson:async p=>old.get(p),remove:async p=>{old.delete(p)}}})
  try{
   const d3=new DatabaseSync(path.join(root,'worldbook-recalls.db'))
   assert.equal(d3.prepare('SELECT COUNT(*) n FROM recall_outputs WHERE operation_id=?').get('opLegacy').n,2,'重复构造不得重复拆出 outputs 行（应仍为 2）')
   assert.equal('outputs' in JSON.parse(d3.prepare('SELECT value_json v FROM recalls WHERE operation_id=?').get('opLegacy').v),false,'重复构造后主行仍不得含 outputs')
   d3.close()
  }finally{third.dispose()}
 }finally{store.dispose();try{rmSync(root,{recursive:true,force:true})}catch(error){process.stderr.write('[tmp-cleanup] 临时目录未能立即清理（Windows WAL 句柄延迟，不影响断言）: '+root+' :: '+String(error?.message||error)+'\n')}}
})

