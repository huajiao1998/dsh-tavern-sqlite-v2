// 原创SQL输入＋真实作者投影/缓存caller；不启动服务、不触真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import path from 'node:path'
import os from 'node:os'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {inspectNativeFailureTail} from '../lib/failure-cleanup-target.js'
import {applyLatestFailureHostTransform,applyLatestFailureViewTransform} from '../deploy/latest-failure-transform.mjs'
import {applyLatestSendViewTransform} from '../deploy/latest-send-view-transform.mjs'
import {latestSendTarget} from '../lib/latest-send.js'
import {applyRollbackPendingViewTransform} from '../deploy/rollback-pending-view-transform.mjs'
import {commentAuthorTreeSource} from './fixtures/comment-author-tree.mjs'
import {clientCoreWrites} from '../deploy/client-seams.mjs'
const author=commentAuthorTreeSource(),domain=path.join(author,'tavern-plugin/lib/domain')
const load=name=>import(pathToFileURL(path.join(domain,name+'.js')).href)
const [copy,lazy,json,scoped,rollback,freeze,receipt,rescue,restore,failed]=await Promise.all(['copy-json-tree','lazy-history-read','json-mutation','scoped-messages','rollback-surface','freeze-json','mvu-receipt-index','chat-history-rescue','surface-restoration','failed-error-visibility'].map(load))
const rawView=readFileSync(path.join(domain,'chat-session-state.js'),'utf8')
const view=applyLatestSendViewTransform(applyLatestFailureViewTransform(applyRollbackPendingViewTransform(rawView)))
const rawHost=readFileSync(path.join(author,'tavern-plugin/lib/index.js'),'utf8')
const host=applyLatestFailureHostTransform(rawHost)
function functions(source,names){const out=[];const walk=node=>{if(!node || typeof node!=='object')return;if(node.type==='FunctionDeclaration' && names.includes(node.id?.name))out.push(source.slice(node.start,node.end));for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value && typeof value==='object')walk(value)}};walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}));assert.equal(out.length,names.length);return out.join('\n')}
const wanted=['pendingMvuSettlementState','projectChatSessionState','projectSessionMessage','settlementTurn','createSessionStateView','latestFailureTarget','latestFailureCleanupReason','rollbackViewFields','rollbackViewFieldsBase','projectChatBackgroundConfig','projectDisplayRuntimeState','projectSettlementCheckpoint','projectSceneImageState']
const declared=new Set([...view.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match=>match[1]))
const names=wanted.filter(name=>declared.has(name))
const context=vm.createContext({...copy,...lazy,...rollback,...freeze,...receipt,...rescue,...restore,...failed,inspectNativeFailureTail,latestSendTarget})
vm.runInContext(functions(view,names)+'\nglobalThis.api={'+names.join(',')+'};',context)
const helpers={...copy,...lazy,...json,...scoped,...context.api}
const chat=()=>({id:'volatile-chat',sessionId:'volatile-session',_storageRevision:1,mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,updatedAt:1,timeline:{schemaVersion:1,branchId:'b',revision:6,participants:{},operations:{six:{kind:'body',turn:6,status:'completed',background:{phase:'completed'}}},checkpoints:[{turn:6}]},messages:[{role:'user',text:'普通正文',variables:[{large:'无关变量'}],displayRuntime:{large:'无关显示'}},{role:'assistant',turn:6,text:'上轮保存编辑',bodyEdit:{id:'edit-six',turn:6,seq:1},variables:[{large:'无关变量'}],displayRuntime:{large:'无关显示'}}]})
const events=()=>[
 {seq:0,type:'turn/start',data:{turn:6}},
 {seq:1,type:'assistant/message',surfaceOp:'append',data:{turn:6,message:{id:'six',content:[{type:'text',text:'six'}]}}},
 {seq:2,type:'turn/end',data:{turn:6,reason:{kind:'completed'}}},
 {seq:3,type:'turn/start',data:{turn:7}},
 {seq:4,type:'assistant/message',surfaceOp:'append',data:{turn:7,message:{id:'seven',content:[{type:'reasoning',text:'原创思考'},{type:'text',text:'异常正文'}]}}},
 {seq:5,type:'turn/end',data:{turn:7,reason:{kind:'completed'}}},
 {seq:6,type:'dsh-tavern/required-session-patch-v1',data:{version:1}},
 {seq:7,type:'assistant/message',surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1],data:{turn:6,message:{id:'edit-six',content:[{type:'text',text:'上轮保存编辑'}],source:{kind:'model',provider:'dsh-tavern',model:'body-edit'}}}}
]
const idle={phase:'idle',busy:false}
function renderRealMenu(view) {
 const writes=clientCoreWrites(author),source=writes.get('tavern-plugin/src/client/features/play-controls.js')
 const registrations=new Map(),React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()}),Fragment:'fragment',useState:v=>[v,()=>{}],useRef:current=>({current}),useEffect(){},useLayoutEffect(){},useMemo:fn=>fn(),useCallback:fn=>fn}
 const realm=vm.createContext({React,rpc:()=>{throw new Error('渲染不应发送请求')},tavernErrorHub:{report(){}},window:{__ModuleLoader__:{load(){}}},createTurnHistoryProjection:()=>({}),createBackgroundSuppressionPoller:()=>()=>{},TavernPluginComposerActions:()=>null,createTavernFrameSlashExecutor:()=>()=>{},useTavernSessionMode:()=> 'play',isPlayMode:()=>true,latestTavernAssistantMessageId:()=>null,useLiveTavernView:()=>({view}),useRegenPanel:()=>null,useTavernCoordination:()=>({view:{}}),describeTavernActivity:()=>({busy:false})})
 const feature=vm.runInContext('('+functions(source,['createPlayControlsFeatureModule'])+')()',realm)
 const slots={inject:(_name,fn)=>fn(),register:(meta,render)=>{registrations.set(meta.id,render);return ()=>{}}},ctx={slots,sessions:{subagentAddress:()=>null},effect:fn=>fn(),get:()=>({}),betterSidebar:{registerTab:()=>()=>{}},remote:{commands:{}}}
 feature.register({ctx,slots})
 const find=(tree,name)=>tree?.type?.name===name?tree:(tree?.children||[]).map(child=>find(child,name)).find(Boolean)
 const dock=registrations.get('dsh-tavern-candidate-actions')({sessionId:'volatile-session',useChat:()=>null,useSession:()=>false})
 const more=find(dock.type(dock.props),'TavernMoreActions'),action=find(more.type(more.props),'TavernRollbackAction')
 return action.type(action.props)
}
test('易变清理链：真实SQL状态经缓存和脏投影保持7目标，静止/旧编辑/部分推进证据不丢',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'volatile-cleanup-')),store=createChatSqliteStore({dataRoot:root,helpers})
 try {
  const full=await store.update('volatile-chat',()=>chat()),state=await store.readSessionState(full.id,{scoped:true})
  assert.equal(state.messages[0].text,undefined);assert.equal(state.messages[0].variables,undefined)
  assert.equal(state.messages[1].text,'上轮保存编辑');assert.equal(state.messages[1].bodyEdit.id,'edit-six');assert.equal(state.messages[1].variables,undefined);assert.equal(state.messages[1].displayRuntime,undefined)
  let native=events(),busy=false,proofs=0
  const evidence=()=>({events:native,nodes:[1,4,7],cleanupIdle:!busy,foregroundActive:busy,backgroundActive:false})
  const stateView=context.api.createSessionStateView({activity:()=>idle,evidence:()=>({events:native,nodes:[1,4,7]}),sharedMappings:false})
  // 真native immutable契约命中作者rollbackCache；静止变化时旧清理布尔不得沿用。
  const frozen=Object.freeze(events()),surfaceNodes=[1,4,7],session={header:{id:full.sessionId,version:3},surface:{nodes:surfaceNodes,replaceGeneration:0},snapshotEvents:()=>frozen}
  const cachedView=context.api.createSessionStateView({activity:()=>idle,evidence:()=>null,sharedMappings:false})
  const cleanEvidence={session,events:frozen,nodes:surfaceNodes,cleanupIdle:true,activity:idle}
  assert.equal(cachedView.rollback(full,cleanEvidence).failureTarget.turn,7)
  const activeCache=cachedView.rollback(full,{...cleanEvidence,cleanupIdle:false,foregroundActive:true},{baseRevision:full._storageRevision,layoutChanged:false})
  assert.equal(activeCache.failureTarget.turn,7,'活动态/前台忙不决定签出资格');assert.equal(activeCache.canRollback,true);assert.equal(activeCache.rollbackTargetTurn,7)
  // 首次正常可签；其后的实际caller必须补证据，不能被裸evidence默认值覆盖。
  const opening=stateView.rollback(full,{...evidence(),activity:idle})
  assert.ok(opening.failureTarget,JSON.stringify({reason:opening.failureCleanupReason,inspect:inspectNativeFailureTail(full,{...evidence(),activity:idle},full._storageRevision)}));assert.equal(opening.failureTarget.turn,7)
  // latestTurnFields 是 2.7.0 作者树 index.js 自有的头部轮次助手（index.js:2042），projectDirtySessionView 会调它。
  // 它另依赖 str/sessionStore/agentRegistry/assistantResultForTurn 一整条宿主链，而本叶不断言它的返回值
  //（只断言 failureTarget/canRollback/proofs），故在闭包里给同形状 stub，不拖无关宿主链（换源 2.7.0 后修）。
  const hostContext=vm.createContext({sessionStateView:stateView,readFailureEvidence:async(sid,cid)=>{assert.equal(sid,full.sessionId);assert.equal(cid,full.id);proofs++;return evidence()},forkTurnsForChat:()=>({}),readChatCard:async()=>({}),requestPerformance:{stage:async(_name,fn)=>fn()},projectTavernHelperContext:async()=>({messages:[]}),inputFieldsProjection:{project:()=>({})},readLedger:()=>({}),manualLedger:{project:()=>({})},projectCharacterDesignDocument:()=>({}),manualCharacterDesign:{project:()=>({})},latestTurnFields:()=>({debugTurns:[],latestAssistantTurn:0,latestAssistantMessageId:''})})
  // 抽真实caller，只stub剧情显示依赖；mode/card避开无关regex/脚本渲染，但正文/轮号完全同一份SQLstate。
  vm.runInContext(functions(host,['volatileSessionViewFields','projectCachedSessionView','projectDirtySessionView'])+'\nglobalThis.api={projectCachedSessionView,projectDirtySessionView};',hostContext)
  const reused=await hostContext.api.projectCachedSessionView(state,opening,idle)
  assert.equal(reused.failureTarget.turn,7);assert.equal(reused.rollbackTargetTurn,7)
  // 文案跟随统一撤销接线（rollback-menu-transform）：clearIncomplete 时不再是独立的
  // "清除未完成回复"，而是并入 targetLabel + "（未完成发送）"；该接缝的幂等校验自身
  // 就要求产物含"（未完成发送）"，故此处按现行产品文案断言（2026-10-15 更新）。
  const button=renderRealMenu(reused);assert.equal(button.props.disabled,false);assert.match(button.children.join(''),/回退第 7 轮/);assert.equal(typeof button.props.onClick,'function')
  const dirty=await hostContext.api.projectDirtySessionView({...state,mode:'card'}, {...opening,tavernHelper:{messages:[]}},new Set([1]),idle,{layoutChanged:false})
  assert.equal(dirty.failureTarget.turn,7);assert.equal(dirty.canRollback,true);assert.equal(proofs,2)
  busy=true;assert.equal((await hostContext.api.projectCachedSessionView(state,opening,idle)).failureTarget.turn,7,'前台忙不再取消签出')
  busy=false;assert.equal((await hostContext.api.projectCachedSessionView(state,opening,{phase:'pending',busy:false})).failureTarget.turn,7,'后台 pending 不再取消签出')
  native[4].data.message.content.push({type:'tool-call'});const rejected=await hostContext.api.projectCachedSessionView(state,opening,idle)
  assert.equal(rejected.failureTarget.turn,7,'工具调用不作签出资格');assert.equal(rejected.failureCleanupReason,'')
  native=events()
  await store.update(full.id,current=>({...current,_storageRevision:current._storageRevision+1,runtimeInputs:{7:{turn:7,payload:'不可随投影带出'}},foregroundError:{turn:7,payload:'不可带出'}}))
  const partial=await store.readSessionState(full.id,{scoped:true})
  assert.equal(partial.runtimeInputs['7'].turn,7);assert.equal(partial.runtimeInputs['7'].payload,undefined);assert.equal(partial.foregroundError.payload,undefined)
  const refused=await hostContext.api.projectCachedSessionView(partial,opening,idle)
  // 分层：最终 overlay 无可执行 target 时可静默（不展示旧错误分类），但这不代表签名依据消失。
  assert.equal(applyLatestFailureHostTransform(host),host);assert.equal(applyLatestSendViewTransform(view),view,'最后一层是 latest-send overlay：幂等必须用它校验，不能拿旧 failure transform 复验')
 } finally {store.dispose();rmSync(root,{recursive:true,force:true})}
})
