// 审查回归（2026-10-06）：P1 键级池的两项审查修复——
//   ① 记账对称：invalidate/entry 释放组件与池键必须回减字节，否则写→读循环 bytes 单调膨胀，
//      条目被顶过 maxBytes 后 remember 拒收 → 缓存自毁（真实档第一次写读即触发，KB 级 fixture 测不出）。
//   ② 保守路径新鲜度：entry() 的 headerStale 分支必须连清内嵌 header 的 full/scene/display
//      （修A 只清 sessionHead 是漏项；外部写/漏 invalidate 的边缘路径会端出旧 full）。
// 只测 createChatProjectionReads 模块本身（原创临时SQL档＋核准作者投影），不启动服务、不碰真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {createChatProjectionReads} from '../lib/chat-projection-reads.js'
import {revisions as componentRevisions} from '../lib/component-revisions.js'
const workspace=fileURLToPath(new URL('../../../',import.meta.url))
const author=path.resolve(process.env.TAVERN_PROJECTION_AUTHOR_ROOT || path.join(workspace,'tmp/sql-test-kit/author-Jhnday/dsh-tavern-5173c8d593d1a4edc704cbb3da736ce1226e791b/tavern-plugin/lib/domain'))
assert.ok(existsSync(path.join(author,'chat-session-state.js')),'需要本机核准作者源码，只读源码，不下载、不读存档')
const load=name=>import(pathToFileURL(path.join(author,name+'.js')).href)
const [copy]=await Promise.all([load('copy-json-tree')])
const source=readFileSync(path.join(author,'chat-session-state.js'),'utf8')
for(const marker of ['pendingMvuSettlementState','projectChatSessionState','projectSessionMessage'])assert.ok(source.includes('export function '+marker),'作者锚点漂移：'+marker)
const exact=source.slice(source.indexOf('export function pendingMvuSettlementState'),source.indexOf('export function settlementTurn'))
const names=['projectChatSessionState','projectSessionMessage']
const projection=Function('copyJsonTree','copyLazyHistoryHeader',exact.replaceAll('export function ','function ')+';return {'+names.join(',')+'}')(copy.copyJsonTree,()=>({}))
const helpers={...projection,copyJsonTree:copy.copyJsonTree}

const root=mkdtempSync(path.join(os.tmpdir(),'tavern-cache-accounting-'))
const CHAT_ID='accounting-fixture'
function buildDb(name){
  const db=new DatabaseSync(path.join(root,name+'.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE archive_head (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE archive_head_fields (key TEXT PRIMARY KEY, ord INTEGER NOT NULL, kind INTEGER NOT NULL, value_json TEXT);
CREATE TABLE archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT NOT NULL);`)
  const timeline={schemaVersion:1,branchId:'b',revision:1,participants:{background:{status:'idle'}},
    operations:{op1:{kind:'mvu',status:'prepared'}},checkpoints:[{payload:'历史头'.repeat(8000)}]}
  const head={id:CHAT_ID,sessionId:'s',mode:'card',_storageRevision:1,updatedAt:1,
    cardDefinitionSnapshot:{large:'快照'.repeat(12000)},timeline}
  const put=db.prepare('INSERT INTO archive_head_fields VALUES (?,?,?,?)')
  let ord=0
  for(const [key,value] of Object.entries(head))put.run(key,ord++,0,JSON.stringify(value))
  put.run('messages',ord++,1,null)
  db.prepare('INSERT INTO archive_head VALUES (1,1,0)').run()
  const putMsg=db.prepare('INSERT INTO archive_messages VALUES (?,?)')
  for(let index=0;index<8;index++)putMsg.run(index,JSON.stringify({role:index%2?'user':'assistant',turn:index+1,greeting:index===0,text:'正文'+index}))
  return db
}
const entryBytes=(reads,id)=>reads.stats().perChat.find(item=>item.id===id)?.bytes

try {
  test('记账对称：写→读循环不膨胀条目字节（审查修复①回归）',()=>{
    const db=buildDb('cycle')
    const reads=createChatProjectionReads({helpers,maxEntries:2,maxBytes:16*1024*1024})
    const first=reads.session(db,CHAT_ID)
    assert.ok(first?.value,'无 body 完成操作时走投影路径')
    assert.equal(first.value.timeline.revision,1)
    const before=entryBytes(reads,CHAT_ID)
    assert.ok(before>0,'首次读后条目应被记住')
    // 模拟写口：改 timeline/updatedAt、bump DB revision 与部件版本，然后精确失效（同 writeChat→invalidate 顺序）
    db.prepare("UPDATE archive_head_fields SET value_json=? WHERE key='timeline'").run(JSON.stringify({schemaVersion:1,branchId:'b',revision:2,participants:{background:{status:'idle'}},operations:{op1:{kind:'mvu',status:'prepared'}},checkpoints:[{payload:'历史头'.repeat(8000)}]}))
    db.prepare("UPDATE archive_head_fields SET value_json=? WHERE key='updatedAt'").run(JSON.stringify(2))
    db.prepare('UPDATE archive_head SET revision=2, updated_at=2').run()
    componentRevisions(db).header++
    reads.invalidate(CHAT_ID,{revision:2,keys:['timeline','updatedAt'],messages:false})
    const second=reads.session(db,CHAT_ID)
    assert.equal(second.value.timeline.revision,2,'失效后重读反映新 timeline')
    const after=entryBytes(reads,CHAT_ID)
    assert.ok(after!==undefined,'写读循环后条目仍被记住（记账泄漏会让 bytes 超 maxBytes 被 remember 拒收）')
    assert.ok(Math.abs(after-before)<64,'记账对称：写→读循环后条目字节不膨胀（before='+before+' after='+after+'）')
    // 连续多轮：泄漏会按轮数线性放大，这里再压 6 轮
    for(let round=3;round<=8;round++){
      db.prepare('UPDATE archive_head SET revision=?, updated_at=?').run(round,round)
      componentRevisions(db).header++
      reads.invalidate(CHAT_ID,{revision:round,keys:['updatedAt'],messages:false})
      reads.session(db,CHAT_ID)
    }
    const final=entryBytes(reads,CHAT_ID)
    assert.ok(final!==undefined && Math.abs(final-after)<64,'多轮写读后字节仍稳定（after='+after+' final='+final+'）')
    db.close()
  })

  test('保守路径新鲜度：headerStale 连清 full，不留旧投影（审查修复②回归）',()=>{
    const db=buildDb('stale')
    const reads=createChatProjectionReads({helpers,maxEntries:2,maxBytes:16*1024*1024})
    reads.session(db,CHAT_ID)                       // 缓存 full（timeline.revision=1）
    // 模拟"部件版本变了但 invalidate 没走到"（外部写/写后异常跳过失效的边缘路径）
    db.prepare("UPDATE archive_head_fields SET value_json=? WHERE key='timeline'").run(JSON.stringify({schemaVersion:1,branchId:'b',revision:3,participants:{background:{status:'idle'}},operations:{op1:{kind:'mvu',status:'prepared'}},checkpoints:[{payload:'历史头'.repeat(8000)}]}))
    db.prepare('UPDATE archive_head SET revision=3, updated_at=3').run()
    componentRevisions(db).header++
    const stale=reads.session(db,CHAT_ID)
    assert.equal(stale.value.timeline.revision,3,'entry() 保守路径必须清掉内嵌 header 的 full，端出新值')
    db.close()
  })
} finally {
  // node:test 顶层 test 异步返回 Promise；清理由 after 管理，避免尚在运行时拆临时目录。
  test.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));rmSync(root,{recursive:true,force:true})})
}
