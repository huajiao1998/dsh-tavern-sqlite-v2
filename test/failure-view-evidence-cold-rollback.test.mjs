// R1 冷普通回退证据：真 SDK fold（buildSessionEventRecords ＝ foldSurface 分类器）在**唯一权威 events** 上推导节点；
// 作者 rollbackViewFields 经 applyLatestFailureViewTransform 的 `session?.surface?.nodes ?? evidence.nodes` 消费。
// 本文件消费**完整真 a2008bf chat-session-state**（先 pending 缝、再最新失败视图缝），不仿写可用性判定、不 stub canRollback。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {registerHooks,createRequire} from 'node:module'
import os from 'node:os'
import vm from 'node:vm'
import path from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {isLiveFailureEvidence,readFailureEvidence} from '../lib/failure-view-evidence.js'
import {applyRollbackPendingViewTransform} from '../deploy/rollback-pending-view-transform.mjs'
import {applyLatestFailureViewTransform,applyLatestFailureHostTransform} from '../deploy/latest-failure-transform.mjs'
import {transformSessionReplacementSource} from '../lib/domain/host-session-patch.js'

/** 当前离线作者树（真源码，不复制）。 */
const AUTHOR=new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/domain/',import.meta.url)
const SESSION_ID='session-cold-evidence-fixture'
// SDK 走 checkout（与其他真实 SDK 测试同一范式）：requireHost 解析包名，再动态 import。
const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT||'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
// 仅未调用的显示 DOM／宏引擎装 fail-closed 占位（作者 chat-session-state 依赖闭包会带到），核心不 stub。
registerHooks({resolve(spec,context,next){
 if(spec==='./tavern-macro-engine.js')return {url:'fixture-macros:unused',shortCircuit:true}
 if(['jsdom','marked'].includes(spec))return {url:'fixture-display:'+spec,shortCircuit:true}
 return next(spec,context)
},load(url,context,next){
 if(url==='fixture-macros:unused')return {format:'module',source:"export const renderTavernMacros=()=>{throw Error('本断言禁止调用未打包宏引擎')}",shortCircuit:true}
 if(url.startsWith('fixture-display:'))return {format:'module',source:"const unavailable=()=>{throw Error('本断言禁止调用显示DOM依赖')};export const JSDOM=unavailable;export const marked=unavailable;export const VirtualConsole=unavailable",shortCircuit:true}
 return next(url,context)
}})
/** 真 SDK：Session（造真实 events/nodes）+ buildSessionEventRecords（真 fold helper，宿主 DI 用的同一个导出）。 */
async function loadSdk(){
 const {Session}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session')).href)
 const {buildSessionEventRecords}=await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-query')).href)
 return {Session,buildSessionEventRecords}
}
/** 隔离 compile 的补丁链（**不 install、不碰 worker/persistence**）：来源＝真 SDK 文件经产品同一纯函数
 *  `transformSessionReplacementSource` 放行 own replace，再把 bare import 重写到 checkout，产出真 patched `Session`。
 *  范围声明：本叶证明"patch source 级放行 + 真 fold 一致"，不代表本机安装态（worker/persistence 未参与）。 */
async function loadIsolatedPatchedSession(root){
 // 隔离 compile（**不 install、不碰 worker/persistence、不改任何 prototype**）：
 // ① 真 rc2 产物 tmp/projection-baseline-1001/clean-session.js 经产品纯函数 transformSessionReplacementSource 施缝；
 //    它内联了自己的 assertProvenance（真实源第 285 行即是该整句），相对 `./surface.js` 由隔离目录同名文件承载 patched surface；
 // ② 真 SDK query 源码编译时把 `@deepseek-ai/dsh-session` 映射到①的独立 module（其余 bare import 按 checkout 解析）。
 const runtime=process.env.DSH_CHECKOUT||'D:/Program Files (x86)/DSH Desktop/resources/app'
 const runtimeRequire=createRequire(path.join(runtime,'package.json'))
 const rewire=source=>source
  .replace(/\bfrom\s+(["'])([^"']+)\1/g,(all,quote,specifier)=>(specifier.startsWith(".")||specifier.startsWith("node:"))?all:"from "+JSON.stringify(pathToFileURL(runtimeRequire.resolve(specifier)).href))
  .replace(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g,(all,quote,specifier)=>(specifier.startsWith(".")||specifier.startsWith("node:"))?all:"import("+JSON.stringify(pathToFileURL(runtimeRequire.resolve(specifier)).href)+")")
 const compile=(source,name)=>{const file=path.join(root,name);writeFileSync(file,source,"utf8");return import(pathToFileURL(file).href)}
 // ① surface：未压缩真源（单引号布局），生产同一纯函数；相对 import 指回 SDK 原目录（隔离文件不复制兄弟）
 const surfaceFile=runtimeRequire.resolve("@deepseek-ai/dsh-session/surface")
 const surfaceDir=path.dirname(surfaceFile)
 const relToOriginal=source=>source.replace(/(["'])(\.\/[^"']+)\1/g,(all,quote,specifier)=>JSON.stringify(pathToFileURL(path.resolve(surfaceDir,specifier)).href))
 const patchedSurfaceSource=relToOriginal(rewire(transformSessionReplacementSource(readFileSync(surfaceFile,"utf8"))))
 const surfaceModule=await compile(patchedSurfaceSource,"surface.js")
 const surfaceAlias=await compile(patchedSurfaceSource,"surface-alias.js")
 void surfaceAlias
 // ② rc2 clean-session 产物：相对 import 留原地（其 ./surface.js 即①），bare import 按 runtime 解析，自身同施缝
 const cleanSource=readFileSync(new URL("../../../tmp/projection-baseline-1001/clean-session.js",import.meta.url),"utf8")
 const patchedSessionSource=transformSessionReplacementSource(cleanSource)
  .replace(/from\s+(["'])([^"']+)\1/g,(all,quote,specifier)=>specifier.startsWith(".")?"from "+JSON.stringify(specifier):"from "+JSON.stringify(specifier.startsWith("node:")?specifier:pathToFileURL(runtimeRequire.resolve(specifier)).href))
 const sessionModule=await compile(patchedSessionSource,"patched-session.js")
 if(typeof sessionModule.Session!=="function")throw new Error("隔离 clean-session 未导出 Session")
 // ③ 真 SDK query 源码：@dsh-session 映射②；@dsh-session/surface 映射 surface-alias（独立副本，避免裸名解析回原包）
 const queryFile=runtimeRequire.resolve("@deepseek-ai/dsh-session-query")
 const querySource=rewire(readFileSync(queryFile,"utf8"))
   .replace(JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-session')).href),JSON.stringify(pathToFileURL(path.join(root,'patched-session.js')).href))
  .replace(/(["'])@deepseek-ai\/dsh-session\/surface\1/g,JSON.stringify(pathToFileURL(path.join(root,"surface-alias.js")).href))
  .replace(/(["'])@deepseek-ai\/dsh-session\1/g,JSON.stringify(pathToFileURL(path.join(root,"patched-session.js")).href))
 const queryModule=await compile(querySource,"patched-query.js")
 if(typeof queryModule.buildSessionEventRecords!=="function")throw new Error("隔离 query 未导出 buildSessionEventRecords")
 return {Session:sessionModule.Session,buildSessionEventRecords:queryModule.buildSessionEventRecords,foldSurface:surfaceModule.foldSurface}
}
/** 域内 `storage-rollback.js` 垫片（作者树没有这个文件，生产是插件注入的产品包）：测试里等价转出**真产品**实现。
 *  视图缝会向 chat-session-state 注入 `import { inspectNativeFailureTail } from './storage-rollback.js'`，
 *  故这里必须同时转出真检查器与真业务基准（照生产 storage-package.js 的清单，不自造实现）。 */
function writeStorageRollbackShim(root){
 const target=new URL('../lib/failure-cleanup-target.js',import.meta.url).href
 const business=new URL('../lib/rollback-business-state.js',import.meta.url).href
 const file=path.join(root,'storage-rollback.mjs')
 writeFileSync(file,`export { inspectNativeFailureTail } from ${JSON.stringify(target)}\nexport {latestSendTarget} from ${JSON.stringify(new URL('../lib/latest-send.js',import.meta.url).href)}\nexport { captureRollbackBusinessState, restoreRollbackBusinessState, resolveRollbackBusinessState } from ${JSON.stringify(business)}\n`,'utf8')
 return pathToFileURL(file).href
}
/** 真施缝：作者 chat-session-state 先施 pending 缝（本 transform 的前置要求），再施最新失败视图缝（含 R1 节点行）。 */
async function loadSeamedSessionState(root,buildSessionEventRecords){
 const pending=applyRollbackPendingViewTransform(readFileSync(new URL('chat-session-state.js',AUTHOR),'utf8'))
 const {applyLatestSendViewTransform}=await import('../deploy/latest-send-view-transform.mjs')
 const source=applyLatestSendViewTransform(applyLatestFailureViewTransform(pending))
 assert.equal(applyLatestFailureViewTransform(source),source,'视图缝必须幂等（接线在位）')
 assert.ok(source.includes('latestSendTarget(chat, evidence)'),'新作者最终视图直接消费真实事件目标，不复活旧节点资格')
 const file=path.join(root,'chat-session-state.mjs')
 // 作者模块自身的相对依赖照作者目录解析；域内 storage-rollback 垫片接到本包**真产品**检查器/业务基准。
 const rewritten=source.replace(/from '(.+?)'/g,(all,spec)=>spec.startsWith('./')?'from '+JSON.stringify(new URL(spec,AUTHOR).href):all)
   .replace(new URL('storage-rollback.js',AUTHOR).href,writeStorageRollbackShim(root))
 writeFileSync(file,rewritten,'utf8')
 const module=await import(pathToFileURL(file).href)
 // 真实导出（按实际 grep）：工厂 createSessionStateView；后端权威判据 rollbackAvailability 从作者 rollback-surface 真身 import。
 assert.equal(typeof module.createSessionStateView,'function','作者必须导出 createSessionStateView')
 const {rollbackAvailability}=await import(new URL('rollback-surface.js',AUTHOR).href)
 assert.equal(typeof rollbackAvailability,'function','作者真身必须导出 rollbackAvailability')
 // 宿主 DI 的真实推导：与 deploy/latest-failure-transform.mjs 的 EVIDENCE_METHOD 同一表达式。
 const deriveSurfaceNodes=(id,events)=>buildSessionEventRecords(id,events).filter(record=>record.surface==='current').map(record=>record.seq)
 return {module,deriveSurfaceNodes,rollbackAvailability}
}
const modelSource={kind:'model',provider:'fixture-provider',model:'fixture-model'}
/** 唯一事件序列（真 Session.append；surfaceOp/消息形状由 SDK 自己校验）。冷证据与 live 证据共用，避免两路漂移。 */
function appendEvents(session){
 for(const turn of [51,52]){
  session.append('turn/start',{turn})
  session.append('user/message',{id:'u'+turn,role:'user',source:{kind:'user'},content:[{type:'text',text:'输入'+turn}]},{surfaceOp:'append'})
  session.append('assistant/message',{turn,step:1,message:{id:'a'+turn,role:'assistant',source:modelSource,content:[{type:'text',text:'正文'+turn}]}},{surfaceOp:'append'})
  session.append('turn/end',{turn,reason:{kind:'completed'}})
 }
 return session
}
/** live 也用**真实 Session**（不手造假 session：作者 live 路径要真 header/surface，否则会用错分支）。 */
function buildSession(Session){
 return appendEvents(Session.create(SESSION_ID))
}
const buildChat=()=>({id:'chat-cold-evidence-fixture',sessionId:SESSION_ID,mode:'story',tavernHelperLifecycleRevision:52,
 messages:[{role:'user',turn:51,text:'输入51'},{role:'assistant',turn:51,text:'正文51'},{role:'user',turn:52,text:'输入52'},{role:'assistant',turn:52,text:'正文52'}],
 timeline:{schemaVersion:1,branchId:'branch-cold-evidence',revision:52,checkpoints:[],operations:{},participants:{}}})

test('失败视图证据3 冷普通回退证据：真fold nodes与后端availability一致、损坏纯尾拒、live原样且lease释放',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'failure-view-evidence-'))
 try{
  const {Session,buildSessionEventRecords}=await loadSdk()
  assert.equal(typeof buildSessionEventRecords,'function','真 fold helper 必须可解析（否则响亮失败，不退化成空节点）')
  const {module,deriveSurfaceNodes,rollbackAvailability}=await loadSeamedSessionState(root,buildSessionEventRecords)
  const {createSessionStateView}=module
  const session=buildSession(Session)
  const events=session.snapshotEvents()
  const sessionNodes=[...session.surface.nodes]
  assert.equal(events.length,8,'真 Session 必须产出 2 轮 × (start+user+assistant+end) = 8 条事件：实际 '+events.length)
  assert.equal(sessionNodes.length,4,'真 Session 当前模型面必须 4 个节点：实际 '+JSON.stringify(sessionNodes))
  // ① 真 fold 事实（不猜、不自写折叠）：分类器结果必须与 Session 真身 nodes 逐字一致
  assert.deepEqual(deriveSurfaceNodes(SESSION_ID,events),sessionNodes,'真 fold 必须与 Session 真 nodes 一致')
  // ② 后端权威判据（作者真 rollbackAvailability）：51/52 两轮成功 ⇒ 可回退到 52
  const chat=buildChat()
  const authoritative=rollbackAvailability(chat,{events,nodes:sessionNodes})
  assert.equal(authoritative.canRollback,true,'后端同源判据必须可回退（turn='+String(authoritative.target&&authoritative.target.turn)+'）')
  assert.equal(authoritative.target.turn,52,'后端目标轮必须是 52')
  // ③ 冷档：真观察一次 + 真 fold 推导 + 释放恰一次；nodes 为普通可枚举（spread 证据对象时不得丢）
  let released=0;const observed=[]
  const query={observeSession:async(id,options)=>{observed.push([id,options]);return {header:{id},events,[Symbol.dispose]:()=>{released++}}}}
  const evidence=await readFailureEvidence({sessionId:SESSION_ID,loaded:false,events:[],session:null},query,SESSION_ID,deriveSurfaceNodes)
  assert.deepEqual(observed,[[SESSION_ID,{projectionMode:'none'}]],'冷读必须只观察一次且 projectionMode=none')
  assert.equal(released,1,'lease 必须释放恰一次')
  assert.equal(evidence.session,null,'冷证据不得伪造 Session')
  assert.equal(evidence.loaded,true)
  assert.deepEqual([...evidence.nodes],sessionNodes,'冷证据 nodes 必须来自真 fold')
  assert.deepEqual({...evidence}.nodes,sessionNodes,'nodes 必须可枚举（spread 后仍在）')
  // ④ 真作者 rollbackViewFields：冷档（无 session）用证据节点得出 canRollback，与后端同源一致
  const view=createSessionStateView({activity:()=>undefined,evidence:()=>evidence})
  const coldFields=view.rollback(chat,evidence)
  assert.equal(coldFields.canRollback,true,'冷档视图必须可回退（不再因缺 session 误禁）')
  assert.equal(coldFields.rollbackUnavailableReason,'')
  // ⑤ live 原样返回：不额外观察、不释放、不派生 nodes（live 用**真 Session**，作者路径仍走 session.surface.nodes）
  const liveSession=buildSession(Session)
  const live={sessionId:SESSION_ID,loaded:true,session:liveSession,events:liveSession.snapshotEvents()}
  assert.equal(await readFailureEvidence(live,query,SESSION_ID,deriveSurfaceNodes),live,'live 证据必须原样返回')
  assert.equal(observed.length,1,'live 路径不得触发额外观察')
  assert.equal(released,1,'live 路径不得释放（无 lease）')
  assert.equal(isLiveFailureEvidence(live),true)
  assert.deepEqual([...liveSession.surface.nodes],sessionNodes,'live 真 Session 节点必须与快照 Session 一致')
  const liveFields=view.rollback(chat,live)
  assert.equal(liveFields.canRollback,true,'live 档视图必须仍可回退')
  assert.equal(liveFields.rollbackUnavailableReason,'')
  // ⑥ 损坏纯尾：真 fold 抛错 ⇒ 响亮拒绝且 lease 仍被释放（不把坏日志当可用证据）
  const corruptEvents=events.map((event,index)=>index===6?{...event,seq:99}:event)
  let corruptReleased=0
  const corruptQuery={observeSession:async(id)=>({header:{id},events:corruptEvents,[Symbol.dispose]:()=>{corruptReleased++}})}
  await assert.rejects(()=>readFailureEvidence({sessionId:SESSION_ID,loaded:false,events:[]},corruptQuery,SESSION_ID,deriveSurfaceNodes),/invalid session surface|INVALID_SURFACE|失败证据/,'损坏纯尾必须响亮拒绝')
  assert.equal(corruptReleased,1,'损坏路径也必须释放 lease')
  // ⑦ 异身份：合法观察但 header.id 不符 ⇒ 拒且仍释放一次（校验必须在 try 内）
  let foreignReleased=0
  const foreignQuery={observeSession:async()=>({header:{id:'session-foreign-fixture'},events,[Symbol.dispose]:()=>{foreignReleased++}})}
  await assert.rejects(()=>readFailureEvidence({sessionId:SESSION_ID,loaded:false,events:[]},foreignQuery,SESSION_ID,deriveSurfaceNodes),/会话身份不一致/,'异 Session 事件必须拒')
  assert.equal(foreignReleased,1,'异身份路径也必须释放 lease')
 }finally{
  assert.ok(path.basename(root).startsWith('failure-view-evidence-'))
  rmSync(root,{recursive:true,force:true})
 }
})

/** 补丁会话冷折叠（R1 叶4）：真实 production session patch 下，带 replacement 引用的 edited surface 必须可冷折叠。
 *  patch 返回的纯 helper（compiled patched query 导出 `buildSessionEventRecords`）与 `restoreStoredSession` 才是生产链；
 *  unpatched SDK helper 对同一 events 的拒绝是**前置冲突事实**（证明本叶确实在考 patch 放行，而不是它本来就能过）。
 *  本叶只验函数级：不碰外部现场、不写盘、dispose 在 finally。 */
test('失败视图证据4 补丁会话冷折叠：真实replacement引用可读，坏引用仍拒',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'failure-view-evidence-patch-'))
 try{
  const {buildSessionEventRecords:nativeBuildRecords}=await loadSdk()
  // ── 隔离 compile 的真施缝链（不 install、不改 prototype）：独立 Session + 独立 query fold
  const patched=await loadIsolatedPatchedSession(root)
  const {Session,buildSessionEventRecords:buildRecords}=patched
  const session=Session.create(SESSION_ID)
  const modelSource={kind:'model',provider:'fixture-provider',model:'fixture-model'}
  session.append('turn/start',{turn:51})
  session.append('user/message',{id:'u51',role:'user',content:[{type:'text',text:'输入51'}],source:{kind:'user'}},{surfaceOp:'append'})
  session.append('assistant/message',{turn:51,step:1,message:{id:'a51',role:'assistant',content:[{type:'text',text:'正文51'}],source:modelSource},stream:[]},{surfaceOp:'append'})
  session.append('turn/end',{turn:51,reason:{kind:'completed'}})
  const {replaceSessionSurface}=await import(new URL('session-surface-mutations.js',AUTHOR).href)
  const priorSeq=session.seq-2
  // 真作者替换：带 prior assistant 的 refs（走 transformSessionReplacementSource 的 own-replace 放行点）
  replaceSessionSurface(session,'assistant/message',{turn:51,step:1,message:{id:'a51-new',role:'assistant',content:[{type:'text',text:'改写51'}],source:modelSource}},{start:priorSeq,end:priorSeq,sourceEventSeqs:[priorSeq]})
  const events=session.snapshotEvents()
  const sessionNodes=[...session.surface.nodes]
  assert.equal(sessionNodes.length>=2,true,'施缝会话替换后当前面必须仍有节点：'+JSON.stringify(sessionNodes))
  assert.equal(buildRecords(SESSION_ID,events).filter(record=>record.surface==="current").map(record=>record.seq).join(","),sessionNodes.join(","),"独立 query fold 必须与施缝 Session 真 nodes 一致")
  // 前置冲突事实：同一份带 refs 的替换事件在**未施缝**原 SDK query 下必须被拒（本叶考的正是施缝放行）。
  // 这里用 try 吞掉自身抛错：负控若意外通过，由下面"施缝 fold 与真 nodes 一致"的正断言把它暴露出来，不能取消整叶。
  try{
   assert.throws(()=>nativeBuildRecords(SESSION_ID,events),/assistant\/message embeds its source stream|cannot carry|surface/i,'未施缝原 SDK query 必须拒绝带 refs 的替换事件')
  }catch(error){assert.fail('前置冲突事实失败：未施缝原 SDK query 竟放行了带 refs 的替换事件或抛错不符：'+String(error&&error.message||error))}
  // ── 冷证据第四参：真观察一次、释放恰一次、nodes 与真 nodes 相等
  let released=0
  const query={observeSession:async(id,options)=>{assert.equal(options.projectionMode,'none');return {header:{id},events,[Symbol.dispose]:()=>{released++}}}}
  const evidence=await readFailureEvidence({sessionId:SESSION_ID,loaded:false,events:[],session:null},query,SESSION_ID,(id,list)=>buildRecords(id,list).filter(record=>record.surface==='current').map(record=>record.seq))
  assert.equal(released,1,'lease 必须释放恰一次')
  assert.deepEqual([...evidence.nodes],sessionNodes,'冷证据 nodes 必须等于施缝会话真 nodes')
  assert.equal(evidence.session,null,'冷证据不得伪造 Session')
  // ── 坏引用仍拒：空 sourceEventSeqs 与非法 surface（含 source.nextSequence 破位）一律不得放行
  const bad=Session.create(SESSION_ID)
  bad.append('turn/start',{turn:51})
  bad.append('user/message',{id:'u51',role:'user',content:[{type:'text',text:'输入51'}],source:{kind:'user'}},{surfaceOp:'append'})
  bad.append('assistant/message',{turn:51,step:1,message:{id:'a51',role:'assistant',content:[{type:'text',text:'正文51'}],source:modelSource},stream:[]},{surfaceOp:'append'})
  assert.throws(()=>replaceSessionSurface(bad,'assistant/message',{turn:51,step:1,message:{id:'a51-x',role:'assistant',content:[{type:'text',text:'x'}],source:modelSource}},{start:bad.seq-2,end:bad.seq-2,sourceEventSeqs:[]}),/./,'缺引用（空 sourceEventSeqs）必须仍拒')
  assert.throws(()=>buildRecords(SESSION_ID,events.map((event,index)=>index===2?{...event,seq:99}:event)),/invalid session surface|INVALID_SURFACE|surface/i,'seq 破位（非法 surface）仍必须拒')
  const brokenRef=events.map(event=>event.surfaceOp?.op==='replace'?{...event,sourceEventSeqs:[999]}:event)
  assert.throws(()=>buildRecords(SESSION_ID,brokenRef),/invalid session surface|INVALID_SURFACE|surface/i,'缺引用（引用不存在 seq）仍必须拒')
 }finally{
  assert.ok(path.basename(root).startsWith('failure-view-evidence-patch-'))
  rmSync(root,{recursive:true,force:true})
 }
})

/** 叶5 用：真 SDK 两轮（51/52）→ 对**最前** 51 assistant 做真替换（新事件落在尾部 seq8），
 *  故 Session.surface.nodes 是有序真值 [1,8,5,6]，而"records 过滤 current 再排序"会得到 [1,5,6,8]（失真）。 */
function buildMidReplacementSession(Session,replaceSessionSurface){
 const session=Session.create(SESSION_ID)
 const modelSource={kind:'model',provider:'fixture-provider',model:'fixture-model'}
 for(const turn of [51,52]){
  session.append('turn/start',{turn})
  session.append('user/message',{id:'u'+turn,role:'user',content:[{type:'text',text:'输入'+turn}],source:{kind:'user'}},{surfaceOp:'append'})
  session.append('assistant/message',{turn,step:1,message:{id:'a'+turn,role:'assistant',content:[{type:'text',text:'正文'+turn}],source:modelSource},stream:[]},{surfaceOp:'append'})
  session.append('turn/end',{turn,reason:{kind:'completed'}})
 }
 const firstAssistantSeq=2
 replaceSessionSurface(session,'assistant/message',{turn:51,step:1,message:{id:'a51-new',role:'assistant',content:[{type:'text',text:'改写51'}],source:modelSource}},{start:firstAssistantSeq,end:firstAssistantSeq,sourceEventSeqs:[firstAssistantSeq]})
 return session
}

test('失败视图证据5 中间替换节点顺序与真实旧marked升级',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'failure-view-evidence-order-'))
 try{
  const patched=await loadIsolatedPatchedSession(root)
  const {Session,foldSurface:patchedFoldSurface}=patched
  const {replaceSessionSurface}=await import(new URL('session-surface-mutations.js',AUTHOR).href)
  const session=buildMidReplacementSession(Session,replaceSessionSurface)
  const events=session.snapshotEvents()
  const ordered=[...session.surface.nodes]
  assert.equal(events.length,9,'51/52 共 8 条 + 替换前注入的 marker 1 条 = 9（替换事件落尾部 seq8）：实际 '+events.length)
  assert.equal(ordered.length,4,'当前面必须 4 个节点：实际 '+JSON.stringify(ordered))
  assert.deepEqual(ordered,[1,8,5,6],'Session.nodes 必须是有序真值（替换节点在中间位置）：实际 '+JSON.stringify(ordered))
  // 真 patched foldSurface（非 records.filter current 再排序）必须给出同一有序结果
  const foldedNodes=patchedFoldSurface(events).nodes
  assert.deepEqual([...foldedNodes],ordered,'patched foldSurface.nodes 必须等于 Session.nodes（records 排序会失真）')
  assert.notDeepEqual([...foldedNodes].slice().sort((left,right)=>left-right),[1,8,5,6],'若与升序 [1,5,6,8] 相同则说明用了排序口径（失真）')
  // 冷读证据：第四参走真 foldSurface.nodes
  let released=0
  const query={observeSession:async(id,options)=>{assert.equal(options.projectionMode,'none');return {header:{id},events,[Symbol.dispose]:()=>{released++}}}}
  const evidence=await readFailureEvidence({sessionId:SESSION_ID,loaded:false,events:[],session:null},query,SESSION_ID,(id,list)=>patchedFoldSurface(list).nodes)
  assert.equal(released,1,'lease 必须释放恰一次')
  assert.deepEqual([...evidence.nodes],ordered,'冷证据 nodes 必须等于有序真值')
  // 作者冷视图与后端可用性：仍必须可回退 52
  const backendNodes=[...patchedFoldSurface(events).nodes]
  // 真作者侧冷 view / 后端可用性（同叶3 的真 helper 与真身导出）
  const author=await loadSeamedSessionState(root,patched.buildSessionEventRecords)
  const chat=buildChat()
  const availability=author.rollbackAvailability(chat,{events,nodes:[...patchedFoldSurface(events).nodes]})
  assert.equal(availability.canRollback,true,'后端真 rollbackAvailability 必须仍可回退（中间替换节点不得破坏可用性）')
  const coldFields=author.module.createSessionStateView({activity:()=>undefined,evidence:()=>evidence}).rollback(chat,evidence)
  assert.equal(coldFields.canRollback,true,'作者冷 view 必须仍可回退 52')
  assert.equal(coldFields.rollbackUnavailableReason,'')

  assert.equal(backendNodes.includes(8),true,'真 fold 必须包含中间替换节点 8')
  assert.equal(backendNodes[1],8,"替换节点必须位于索引 1（有序）")
  // 真host输入与真实旧代施缝；这里只解析模块，不安装或执行其业务服务。
  const raw=readFileSync(new URL('../index.js',AUTHOR),'utf8')
  const oldSource=execFileSync('git',['show','a7a614c:plugins/dsh-tavern-sqlite-v2/deploy/latest-failure-transform.mjs'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8'})
  const oldFile=path.join(root,'old-latest-transform.mjs');writeFileSync(oldFile,oldSource,'utf8')
  const old=await import(pathToFileURL(oldFile).href)
  const legacy=old.applyLatestFailureHostTransform(raw)
  assert.ok(legacy.includes("sessionId) }"),'旧代host证据方法必须没有第四参fold')
  for(const source of [raw,legacy]){
   const upgraded=applyLatestFailureHostTransform(source)
   assert.ok(upgraded.includes('sessionPatch.surfaceNodes(events)'))
   assert.ok(upgraded.includes('foldSurfaceForEvidence(events).nodes'))
   assert.equal(applyLatestFailureHostTransform(upgraded),upgraded)
   new vm.SourceTextModule(upgraded,{identifier:'host-evidence-ready.mjs'})
   assert.throws(()=>applyLatestFailureHostTransform(upgraded.replace("import { readFailureEvidence as readFailureEvidenceFromQuery } from './domain/storage-rollback.js'",'')),/不完整/)
   // 当前实现是两参签名（latest-failure-transform.mjs:77 EVIDENCE_METHOD = (sessionId, chatId)）：按真实文本替换并先证命中
   const brokenReader = upgraded.replace('async function readFailureEvidence(sessionId, chatId)','async function unknownReader(sessionId, chatId)')
   assert.notEqual(brokenReader, upgraded, '替换必须命中当前两参签名（防"替换没命中"的假缺块）')
   assert.throws(()=>applyLatestFailureHostTransform(brokenReader),/缺失|未知形状/)
  }
 }finally{
  assert.ok(path.basename(root).startsWith('failure-view-evidence-order-'))
  rmSync(root,{recursive:true,force:true})
 }
})

