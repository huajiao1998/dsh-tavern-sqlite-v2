import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import {captureRollbackBusinessState,restoreRollbackBusinessState,resolveRollbackBusinessState} from '../lib/rollback-business-state.js'
import {applyRollbackBusinessTimelineTransform,applyRollbackBusinessTurnTransform} from '../deploy/rollback-business-transform.mjs'
test('旧row-v1兼容只接受确切完整布局和行前缀，不降级未知新版基准',()=>{
 const row={presentation:null,presentationWarnings:[],macroState:null,tavernScriptPrompts:[],runtimeInputs:null,posture:'',ledger:null,scriptState:null,candidates:null,settleStatus:'idle',settleError:null,lastSettle:null,preparedWorldBookContext:'',preparedWorldBook:null,worldBookReads:null}
 const chat={messages:[{role:'assistant',turn:52},{role:'user'},{role:'assistant',turn:53}],timeline:{checkpoints:[{turn:53,rowBefore:row,participants:{}}],operations:{}}}
 assert.equal(resolveRollbackBusinessState(chat,53).messageCount,1)
 const partial=structuredClone(chat);delete partial.timeline.checkpoints[0].rowBefore.macroState;assert.throws(()=>resolveRollbackBusinessState(partial,53),/基准/)
 const unsupported=structuredClone(chat);unsupported.timeline.checkpoints[0].businessBefore={version:99};assert.deepEqual(resolveRollbackBusinessState(unsupported,53),{version:99})
 const noHistory=structuredClone(chat);delete noHistory.timeline.checkpoints[0].rowBefore;noHistory.timeline.checkpoints[0].beforeRevision=12;assert.throws(()=>resolveRollbackBusinessState(noHistory,53),/基准/)
 const failed=structuredClone(chat);failed.messages.pop();failed.messages.at(-1).turn=53;failed.timeline.operations.body={kind:'body',turn:53,rowBefore:row,beforeParticipants:{}};assert.equal(resolveRollbackBusinessState(failed,53,true).messageCount,1)
})
test('定向剧情头恢复旧值及缺失语义，未知字段保持当前且无body引用任务删除',()=>{
 const before={id:'fixture',sessionId:'s',_storageRevision:1,messages:[],variables:{hp:52},lastWorldBookRecall:{turn:52},contextCompaction:{warning:'old'},unknownBusiness:{value:'old'},timeline:{operations:{old:{kind:'agent'}},participants:{}}}
 const baseline=captureRollbackBusinessState(before)
 const after={...before,_storageRevision:3,variables:{hp:53},lastWorldBookRecall:{turn:53},contextCompaction:{warning:'new'},unknownBusiness:{value:'new'},newBusiness:{text:'旧53'},timeline:{operations:{old:{kind:'agent'},orphan53:{kind:'agent',role:'filter'}},participants:{}},rollbackUndo:{text:'旧53'}}
 restoreRollbackBusinessState(after,baseline)
 assert.deepEqual(after.variables,{hp:52});assert.deepEqual(after.lastWorldBookRecall,{turn:52});assert.deepEqual(after.contextCompaction,{warning:'old'});assert.deepEqual(after.unknownBusiness,{value:'new'});assert.equal(Object.hasOwn(baseline.fields,'unknownBusiness'),false)
 assert.deepEqual(after.newBusiness,{text:'旧53'});assert.equal(after.rollbackUndo,undefined);assert.equal(after.timeline.operations.orphan53,undefined);assert.equal(after._storageRevision,3)
 assert.throws(()=>restoreRollbackBusinessState(after,{}),/基准/)
})
test('Guide与用户配置保留当前增删，旧基准不覆盖；剧情变量和书副本恢复52',()=>{
 const before={guides:[{id:'old',text:'旧要求'}],requestMode:'dsh',runtimePresetSnapshot:{text:'旧预设'},backgroundModelSelection:{model:'old'},backgroundTasks:{variables:true},webSearchEnabled:false,variables:{hp:52},openingWorldbookSnapshot:{version:1,document:{entries:{0:{content:'52'}}}},tavernHelperScriptVariables:{script:{hp:52}},timeline:{operations:{},participants:{}},messages:[]}
 const baseline=captureRollbackBusinessState(before)
 assert.equal(Object.hasOwn(baseline.fields,'guides'),false);assert.equal(Object.hasOwn(baseline.fields,'runtimePresetSnapshot'),false)
 // 已落旧代整头基准仍需忽略配置；当前用户删旧Guide/add新Guide或清空都不能复活旧条目。
 baseline.fields.guides=before.guides;baseline.fields.runtimePresetSnapshot=before.runtimePresetSnapshot
 for(const guides of [[{id:'new',text:'新要求'}],[]]){
  const after=structuredClone(before);Object.assign(after,{guides,requestMode:'sillytavern',runtimePresetSnapshot:{text:'新预设'},backgroundModelSelection:{model:'new'},backgroundTasks:{variables:false},webSearchEnabled:true,variables:{hp:53},openingWorldbookSnapshot:{version:1,document:{entries:{0:{content:'旧53'}}}},tavernHelperScriptVariables:{script:{hp:53}}})
  restoreRollbackBusinessState(after,baseline)
  assert.deepEqual(after.guides,guides);assert.equal(after.requestMode,'sillytavern');assert.deepEqual(after.runtimePresetSnapshot,{text:'新预设'});assert.deepEqual(after.backgroundModelSelection,{model:'new'});assert.deepEqual(after.backgroundTasks,{variables:false});assert.equal(after.webSearchEnabled,true)
  assert.deepEqual(after.variables,{hp:52});assert.deepEqual(after.openingWorldbookSnapshot,before.openingWorldbookSnapshot);assert.deepEqual(after.tavernHelperScriptVariables,before.tavernHelperScriptVariables)
 }
})
test('实际已施row-v1 timeline与prepare源码精确升级，复跑幂等半标记拒绝',async()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/plugin-story-timeline.js',import.meta.url),'utf8')
 const next=applyRollbackBusinessTimelineTransform(source)
 assert.equal(applyRollbackBusinessTimelineTransform(next),next)
 assert.throws(()=>applyRollbackBusinessTimelineTransform(next.replace('businessBefore: operation.businessBefore','missing')),/不完整/)
 const loaded=next.replace("'./storage-rollback-business.js'",JSON.stringify(new URL('../lib/rollback-business-state.js',import.meta.url).href)).replace("'./scoped-messages.js'",JSON.stringify(new URL('../../../tmp/rollback-compare-1001/scoped-messages.js',import.meta.url).href))
 const {createStoryTimeline}=await import('data:text/javascript;base64,'+Buffer.from(loaded).toString('base64'))
 const timeline=createStoryTimeline({id:prefix=>prefix+'-'+Math.random(),now:()=>99})
 const initial={id:'fixture',messages:[{role:'assistant',greeting:true,turn:52,text:'上一轮'}],variables:{hp:52},lastWorldBookRecall:{turn:52},contextCompaction:{warning:'old'},macroState:{userName:'旧称呼',local:{step:52},global:{step:52}}}
 const begun=timeline.apply({chat:initial,intent:{kind:'body.begin',turn:53,userText:'输入'}})
 const body=begun.chat.timeline.operations[begun.value.operationId]
 assert.equal(body.businessBefore.version,1)
 const current=begun.chat;current.messages.push({role:'user',text:'输入'},{role:'assistant',turn:53,text:'旧53'});current.variables={hp:53};current.contextCompaction={warning:'new'};current.lastWorldBookRecall={turn:53};current.foregroundError={message:'旧53'};current.timeline.operations.orphan={kind:'agent'};current.macroState={userName:'新玩家称呼',local:{step:53},global:{step:53},userControl:'保留'}
 current.timeline.checkpoints=[{id:'cp',turn:53,rowBefore:body.rowBefore,businessBefore:body.businessBefore,participants:{}}]
 const result=timeline.apply({chat:current,intent:{kind:'turn.rollback',turn:53,rowCheckpointId:'cp'}}).chat
 assert.deepEqual(result.messages,initial.messages);assert.deepEqual(result.variables,initial.variables);assert.deepEqual(result.lastWorldBookRecall,initial.lastWorldBookRecall);assert.deepEqual(result.contextCompaction,initial.contextCompaction);assert.equal(result.foregroundError,undefined);assert.equal(result.timeline.operations.orphan,undefined);assert.deepEqual(result.macroState,{userName:'新玩家称呼',local:{step:52},global:{step:52},userControl:'保留'})
 const prepare=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-turn-orchestration.js',import.meta.url),'utf8')
 const updated=applyRollbackBusinessTurnTransform(prepare);assert.equal(applyRollbackBusinessTurnTransform(updated),updated)
 assert.ok(updated.indexOf('const rollbackBusinessBefore')<updated.indexOf('let chatChanged = clearStaleStages(chat, turn)'))
})

test('实际画像切换与玩家称呼保留当前，资源路径和未知手工控制不复旧，剧情局部宏与副本恢复',async()=>{
 // 只执行真实preferenceReplacement及sanitize，不调用显示DOM、宏引擎或世界书规划。
 const dependencies=registerHooks({resolve(spec,context,next){if(spec==='./tavern-macro-engine.js')return {url:'fixture-profile-macros:unused',shortCircuit:true};if(['jsdom','marked'].includes(spec))return {url:'fixture-profile-display:'+spec,shortCircuit:true};return next(spec,context)},load(url,context,next){if(url.startsWith('fixture-profile-'))return {format:'module',source:"const unused=()=>{throw Error('本画像断言禁止调用显示或宏依赖')};export const renderTavernMacros=unused;export const JSDOM=unused;export const VirtualConsole=unused;export const marked=unused",shortCircuit:true};return next(url,context)}})
 let createPlayCardSnapshots
 try{({createPlayCardSnapshots}=await import('../../../tools/live-plugin-src/lib/domain/play-card-snapshots.js'))}finally{dependencies.deregister()}
 const snapshots=createPlayCardSnapshots({userPreferenceProfile:{stableContext:async id=>({profileId:id,revision:2,text:'新确认画像'})}})
 const before={mode:'story',cardPath:'cards/before.json',cardName:'旧卡名',cardContextSnapshot:'旧画像\n\n固定人物上下文',cardContextRevision:1,userProfileContextSnapshot:'旧画像',userProfileEnabled:true,userProfileId:'old',userProfileRevision:1,macroState:{userName:'旧称呼',local:{hp:52},global:{hp:52}},openingWorldbookSnapshot:{version:1,document:{entries:{0:{content:'本档52'}}}},timeline:{operations:{},participants:{}},messages:[]}
 const baseline=captureRollbackBusinessState(before),after=structuredClone(before)
 Object.assign(after,await snapshots.preferenceReplacement(after,true,'new'))
 after.cardPath='cards/renamed.json';after.cardName='手改卡名';after.runtimePresetPath='presets/new.json';after.bypassPlanId='manual-new';after.macroState={userName:'手改称呼',local:{hp:53},global:{hp:53},newControl:'手改'};after.openingWorldbookSnapshot.document.entries[0].content='本档旧53';after.independentControl='手改未知配置'
 const config=Object.fromEntries(['cardContextSnapshot','cardContextRevision','userProfileContextSnapshot','userProfileEnabled','userProfileId','userProfileRevision','cardPath','cardName','runtimePresetPath','bypassPlanId','independentControl'].map(key=>[key,after[key]]))
 // 旧版整头基准中存在所有配置和称呼，也不能恢复它们。
 Object.assign(baseline.fields,structuredClone(before))
 restoreRollbackBusinessState(after,baseline)
 for(const [key,value] of Object.entries(config))assert.deepEqual(after[key],value,key)
 assert.deepEqual(after.macroState,{userName:'手改称呼',local:{hp:52},global:{hp:52},newControl:'手改'});assert.deepEqual(after.openingWorldbookSnapshot,before.openingWorldbookSnapshot)
 for(const key of Object.keys(config))assert.equal(Object.hasOwn(captureRollbackBusinessState(after).fields,key),false,key)
 delete after.macroState.userName;restoreRollbackBusinessState(after,baseline);assert.equal(Object.hasOwn(after.macroState,'userName'),false)
})
