// 实际客户端消费者+原创DOM/storage契约；不声称真实浏览器验收。
// 身份门（2026-10-05 换源）：旧读源 tmp/rollback-compare-1001/current-client.js 是 2.4 代残拷贝，
// 2.5.0 适配后的施缝锚点对不上（once() 正确拒绝）；只喂 upstream25-author-fixture 的 2.5.0 真源。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyClientRollbackTransform} from '../deploy/core-host-transform.mjs'
test('旧53隐藏记录不能隐藏复用的新53；只清当前session、消费者可升级且幂等',()=>{
 const source=readFileSync(new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/client.js',import.meta.url),'utf8')
 const next=applyClientRollbackTransform(source)
 assert.equal(applyClientRollbackTransform(next),next)
 const start=next.indexOf('function createTurnHistoryProjection(options)'),end=next.indexOf('function applyBodyRegenerationResult',start)
 const make=new Function(next.slice(start,end)+';return createTurnHistoryProjection;')()
 const values={'dsh-tavern-rolled-back-turns':JSON.stringify({fixture:[53],other:[53]})}
 const row={style:{display:''},previousElementSibling:null,getAttribute:key=>key==='data-chat-turn'?'53':key==='data-chat-flow-kind'?'turn-tail':null,querySelector:()=>null}
 const storage={getItem:key=>values[key]??null,setItem:(key,value)=>{values[key]=value},removeItem:key=>{delete values[key]}}
 const projection=make({root:()=>({querySelectorAll:selector=>selector==='[data-chat-flow-kind="turn-tail"]'||selector==='[data-chat-turn]'?[row]:[]}),storage:()=>storage})
 projection.rolledBack('fixture',{suppressedDshTurns:[],regeneratedDshTurns:{}})
 assert.equal(row.style.display,'');assert.deepEqual(JSON.parse(values['dsh-tavern-rolled-back-turns']),{other:[53]})
 values['dsh-tavern-hidden-turns']='invalid';projection.rolledBack('fixture',{suppressedDshTurns:[],regeneratedDshTurns:{}});assert.equal(row.style.display,'')
})
