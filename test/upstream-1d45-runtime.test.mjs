// 冻结作者源实际执行：新发送前入口不造软墓碑，失败输入模板变量按作者实现撤销。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { assertSendAfterCleanup } from '../lib/failure-state.js'
import { applyRollbackBusinessTurnTransform } from '../deploy/rollback-business-transform.mjs'
import { applyUpstreamFailureInputTransform, applyTemplateRollbackInputOrderTransform } from '../deploy/upstream-failure-input-transform.mjs'
const ROOT=new URL('../../../tmp/upstream-1d45-review-20261012/author-tree/tavern-plugin/lib/',import.meta.url)
const text=name=>fs.readFileSync(new URL(name,ROOT),'utf8')
test('上游1d45失败输入：错误账本与回退进行中必须先清理，未知终态不列资格白名单',async()=>{
 const source=applyUpstreamFailureInputTransform(text('index.js'))
 assert.equal(applyUpstreamFailureInputTransform(source),source)
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});let callback
 const walk=n=>{if(!n || typeof n!=='object')return;if(n.type==='Property'&&n.key?.name==='clearFailedTurns')callback=n.value;for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v)};walk(ast)
 assert.ok(callback)
 let chat={id:'c',sessionId:'s',mode:'story',messages:[{role:'assistant',turn:1}],timeline:{operations:{}}},events=[],writes=0
 const session={append:()=>{writes++},surface:{nodes:[]}}
 const fn=new Function('turnOrchestrator','sessionStore','agentRegistry','chatForSession','sessionEvents','rollbackAvailability','assertSendAfterCleanup','return ('+source.slice(callback.start,callback.end)+')')({modeFor:async()=> 'story'},{get:()=>session,flush:()=>{writes++}},{get:()=>undefined},async()=>chat,()=>events,()=>({unclearedTurns:[]}),assertSendAfterCleanup)
 assert.equal(await fn('s'),0)
 chat.timeline.operations.body={kind:'body',status:'failed',turn:2}
 assert.equal(await fn('s'),0,'历史failed不阻止新发送')
 chat.timeline.operations.body={kind:'body',status:'running',turn:2}
 assert.equal(await fn('s'),0,'旧body状态不作发送资格')
 delete chat.timeline.operations.body
 for(const kind of ['error','failed','aborted','unknown-terminal']){
  events=[{seq:0,type:'turn/start',data:{turn:2}},{seq:1,type:'turn/end',data:{turn:2,reason:{kind}}}]
  assert.equal(await fn('s'),0,'终态 '+kind+' 不作新发送资格')
 }
 events=[{seq:0,type:'turn/start',data:{turn:2}},{seq:1,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}}]
  assert.equal(await fn('s'),0,'completed 不作为错误白名单限制')
  events=[];chat.rollbackPending={id:'pending'}
 await assert.rejects(()=>fn('s'),/物理回退未完成/,'rollbackPending 必须真阻止')
 assert.equal(writes,0,'账本/多终态/rollbackPending 全程零软写与零 flush')
 assert.throws(()=>applyUpstreamFailureInputTransform(source.replace('assertSendAfterCleanup(chat, { events: sessionEvents(session) })','void chat')),/消费者不完整/)
})
test('上游1d45模板撤销：真实stage及restore清除失败输入变量且下一轮不继承',()=>{
 const source=text('domain/turn-orchestration.js'),ast=parse(source,{ecmaVersion:'latest',sourceType:'module'})
 const declarations=ast.body.filter(n=>n.type==='FunctionDeclaration'&&['stageTemplateInput','restoreTemplateInput'].includes(n.id.name))
 assert.equal(declarations.length,2)
 const {stageTemplateInput,restoreTemplateInput}=new Function('clone',declarations.map(n=>source.slice(n.start,n.end)).join('\n')+'\nreturn {stageTemplateInput,restoreTemplateInput}')(structuredClone)
 const chat={variables:{hp:1},promptTemplateInitialVariables:{seed:1}}
 stageTemplateInput(chat,2,'失败输入',{message:{text:'失败输入'},scopes:{local:{hp:2},initial:{seed:2}}})
 assert.deepEqual(chat.promptTemplateInput.before,{variables:{hp:1},initial:{seed:1}})
 restoreTemplateInput(chat)
 assert.deepEqual(chat.variables,{hp:1});assert.deepEqual(chat.promptTemplateInitialVariables,{seed:1});assert.equal(chat.promptTemplateInput,undefined)
 stageTemplateInput(chat,3,'新的输入',{message:{text:'新的输入'},scopes:{local:{hp:3},initial:{seed:3}}})
 assert.deepEqual(chat.promptTemplateInput.before.variables,{hp:1})
 restoreTemplateInput(chat)
 assert.deepEqual(chat.variables,{hp:1})
 const adapted=applyTemplateRollbackInputOrderTransform(applyRollbackBusinessTurnTransform(source))
 assert.equal(applyTemplateRollbackInputOrderTransform(adapted),adapted)
 const start=adapted.indexOf('    // [dsh-tavern-template-before-rollback-capture:v1]'),end=adapted.indexOf('\n    let chatChanged',start)
 assert.ok(start>=0&&end>start)
 const capture=new Function('chat','turn','restoreTemplateInput','timeline','captureRollbackBusinessState',adapted.slice(start,end)+'\nreturn rollbackBusinessBefore')
 stageTemplateInput(chat,4,'遗留输入',{message:{text:'遗留'},scopes:{local:{hp:99},initial:{seed:99}}})
 const base=capture(chat,5,restoreTemplateInput,{captureBusiness:structuredClone},structuredClone)
 assert.deepEqual(base.variables,{hp:1});assert.deepEqual(base.promptTemplateInitialVariables,{seed:1});assert.equal(base.promptTemplateInput,undefined)
 // 同一轮继续准备不撤销已投影输入。
 stageTemplateInput(chat,5,'同轮',{message:{text:'同轮'},scopes:{local:{hp:5},initial:{seed:5}}})
 const same=capture(chat,5,restoreTemplateInput,{captureBusiness:structuredClone},structuredClone)
 assert.deepEqual(same.variables,{hp:5});assert.equal(same.promptTemplateInput.turn,5)
})
