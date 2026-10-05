import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyRollbackGlobalAdapterTransform,applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
test('实际adapter清理回调解除旧53正文基线和模板环境缓存，保留他档活动reader',async()=>{
 const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8'),next=applyRollbackGlobalAdapterTransform(adapter)
 const start=next.indexOf('    clearRollbackState: async'),end=next.indexOf('    settleMvuUpdate:',start)
 const build=new Function('whenRollbackAdapterIdle','createFullPromptTemplateSync','createJsonValueProjectionCache',`let settlementBase={sessionId:'fixture',text:'旧53'},settlementReaders=new WeakMap(),settlementSizes=new WeakMap(),syncTemplateState={old:53},templateCharacters={old:53};const prior=[settlementReaders,settlementSizes,syncTemplateState,templateCharacters];const consumer={${next.slice(start,end)}};return {consumer,state:()=>({settlementBase,current:[settlementReaders,settlementSizes,syncTemplateState,templateCharacters],prior})}`)
 let joined=false;const instance=build(async()=>joined=true,()=>({fresh:52}),()=>({fresh:52}))
 await instance.consumer.clearRollbackState('fixture');assert.equal(joined,true);const state=instance.state();assert.equal(state.settlementBase,null);assert.equal(state.current[0],state.prior[0]);assert.equal(state.current[1],state.prior[1]);assert.notEqual(state.current[2],state.prior[2]);assert.notEqual(state.current[3],state.prior[3])
})
test('实际adapter手动写入口整个Promise可join且静止期间新请求拒绝',async()=>{
 const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8'),next=applyRollbackGlobalAdapterTransform(adapter)
 const start=next.indexOf('  // [dsh-tavern-adapter-runs:v1]'),end=next.indexOf('    await serverExecution.whenIdle(id)\n  }',start)+'    await serverExecution.whenIdle(id)\n  }'.length
 const barrier=new Set(),runState=new Function('serverExecution','rollbackBarrier','rollbackSchedulingBarrier',next.slice(start,end)+';return {trackRollbackAdapterRun,whenRollbackAdapterIdle}')({whenIdle:async()=>{}},new Set(),barrier)
 let release;const gate=new Promise(r=>release=r);const manual=runState.trackRollbackAdapterRun(async()=>{await gate;return 53})
 const task=manual('fixture');let done=false;const idle=runState.whenRollbackAdapterIdle('fixture').then(()=>done=true);await Promise.resolve();assert.equal(done,false)
 barrier.add('fixture');await assert.rejects(manual('fixture'),/禁止新手动写任务/);await assert.rejects(manual({sessionId:'fixture'}),/禁止新手动写任务/);release();assert.equal(await task,53);await idle;assert.equal(done,true)
})
test('旧施缝marker源码升级补完整脚本run等待且第二次幂等',()=>{
 const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8')
 const expected=applyRollbackGlobalAdapterTransform(adapter)
 const start=expected.indexOf('  // [dsh-tavern-adapter-runs:v1]'),end=expected.indexOf('\n',expected.indexOf('    await serverExecution.whenIdle(id)\n  }',start))+1
 // 从本代移除增量块，构造旧global标记+旧whenIdle门面，验证升级。
 let old=expected
 const clearStart=old.indexOf('    // [dsh-tavern-adapter-clear:v1]'),clearEnd=old.indexOf('    settleMvuUpdate:',clearStart)
 old=old.slice(0,clearStart)+old.slice(clearEnd)
 for(const name of ['syncTemplateState','templateCharacters','settlementReaders','settlementSizes'])old=old.replace('  let '+name+' =','  const '+name+' =')
 old=old.replace("import { rollbackBarrier, rollbackSchedulingBarrier } from './storage-rollback-business.js'\n",'')
 const blockEnd=old.indexOf('    await serverExecution.whenIdle(id)\n  }',old.indexOf('  // [dsh-tavern-adapter-runs:v1]'))+'    await serverExecution.whenIdle(id)\n  }'.length
 old=old.slice(0,old.indexOf('  // [dsh-tavern-adapter-runs:v1]'))+old.slice(blockEnd+1)
 old=old.replace('    whenIdle: whenRollbackAdapterIdle,','    whenIdle: sessionId => serverExecution.whenIdle(sessionId),').replace(/    (\w+): trackRollbackAdapterRun\(\1\),/g,'    $1,')
 assert.ok(start>=0&&end>start);assert.notEqual(old,expected);assert.equal(applyRollbackGlobalAdapterTransform(old),expected);assert.equal(applyRollbackGlobalAdapterTransform(expected),expected)
 const host=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8')
 const expectedHost=applyRollbackHostTransform(host),oldHost=expectedHost.replace('      await tavernScriptHostAdapter.whenIdle(chat.sessionId)\n','')
 assert.notEqual(oldHost,expectedHost);assert.equal(applyRollbackHostTransform(oldHost),expectedHost);assert.equal(applyRollbackHostTransform(expectedHost),expectedHost)
})
test('实际输入模板消费者运行时使用传入53归属，不重读archive的旧52',async()=>{
 const host=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8')
 const updated=applyRollbackGlobalHostTransform(applyRollbackHostTransform(host))
 const start=updated.indexOf('    projectUserTemplate: async'),end=updated.indexOf('    projectReply:',start)
 const saves=[]
 const consumer=new Function('readPromptTemplateGlobalVariables','fullTemplateRuntime','promptTemplateGlobalVariables','currentVariablesOf','return ({'+updated.slice(start,end)+'})')(
  async()=>({hp:52}),{forSession:()=>({renderInput:async()=>({message:{mes:'新53',swipes:['新53'],swipe_id:0},scopes:{global:{hp:53}}})})},{save:async(...args)=>saves.push(args)},()=>({}))
 await consumer.projectUserTemplate({chat:{id:'fixture',sessionId:'fixture',timeline:{operations:{old:{kind:'body',turn:52}}}},text:'新53',turn:53})
 assert.deepEqual(saves,[[{hp:53},{hp:52},{chatId:'fixture',turn:53}]])
})
test('实际共享写保分支身份但Host不挂共享撤销，旧五库挂钩升级清除且幂等',()=>{
 const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8')
 const next=applyRollbackGlobalAdapterTransform(adapter);assert.equal(applyRollbackGlobalAdapterTransform(next),next)
 assert.ok(next.includes('rollbackGlobalOwner(globalChat)'));assert.ok(next.includes('rollbackGlobalOwner(chat)'))
 const host=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8')
 const updated=applyRollbackGlobalHostTransform(applyRollbackHostTransform(host));assert.equal(applyRollbackGlobalHostTransform(updated),updated)
 assert.ok(!updated.includes('preflightRollbackSides:'));assert.ok(!updated.includes('promptTemplateGlobalVariables.pruneRollback('));assert.ok(updated.includes('turn: Number(input.turn)'));assert.ok(!updated.includes("profileData.version('prompt-template-variables.json')"));assert.ok(updated.includes('promptTemplateGlobalVariables.version()'))
 assert.ok(updated.includes('projectUserTemplate: async ({chat,text,turn})'))
 assert.ok(updated.includes('save(result.scopes.global, global, { chatId: chat.id, turn })'))
 assert.ok(!updated.includes('saveFullPromptTemplateGlobals(chat.sessionId, result.scopes.global, global)'))
 const stores=['promptTemplateGlobalVariables','tavernExtensionSettings','characterVariableStore','rollbackWorldbookResources','rollbackWorldbookBindings']
 const methods=['preflightRollback','reserveRollback','releaseRollback']
 const oldOptions=methods.map(method=>`    ${method.replace('Rollback','RollbackSides')}: async (chat, turn${method==='releaseRollback'?', archive':''}) => {\n${stores.map(store=>'      await '+store+'.'+method+'(chat, turn'+(method==='releaseRollback'?', archive':'')+')').join('\n')}\n    },`).join('\n')+'\n'
 const old=updated.replace('    cleanupRollbackSides: async',oldOptions+'    cleanupRollbackSides: async').replace('      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)',stores.map(store=>'      await '+store+'.pruneRollback(chat, turn)').join('\n')+'\n      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)')
 assert.notEqual(old,updated);const retired=applyRollbackGlobalHostTransform(old)
 for(const store of stores)for(const method of [...methods,'pruneRollback'])assert.ok(!retired.includes(store+'.'+method+'('))
 assert.ok(!retired.includes('reserveRollbackSides:'));assert.ok(!retired.includes('releaseRollbackSides:'));assert.ok(!retired.includes('preflightRollbackSides:'));assert.equal(retired,updated)
})
