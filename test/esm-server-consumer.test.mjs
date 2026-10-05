// 原创模拟卡与假远程响应，验证真实服务端执行消费者；不读取实际卡/档或启动GUI。
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createServerExecution, classifyCardScript, projectServerScripts, storageBrowserScripts } from '../lib/server-execution.js'
import { createCardScriptRuntime } from '../lib/mvu/mvu-card-runtime.js'
import { applyRuntimeTransform } from '../deploy/core-runtime-transform.mjs'
const require = createRequire(new URL('../../../tools/mvu-server-core/package.json',import.meta.url))
const lodash=require('lodash')
const YAML=require('yaml')
// 作者已有发布资源仅用于本地API消费者夹具，不冒认裁剪B2.4树具有完整资源。
const zod=await import('../../../dsh-tavern-main/tavern-plugin/lib/vendor/runtime-assets/zod/index.mjs')
const logger={info(){},warn(){},error(){}}
const chat=()=>({id:'esm-owned-chat',sessionId:'esm-owned-session',cardPath:'esm-owned-card',cardDefinitionSnapshot:{name:'夹具卡',extensions:{fixture:true}},messages:[{role:'assistant',text:'正文',swipeId:0,swipes:['正文'],variables:[{stat_data:{hp:1},schema:{}}]}]})
const root={id:'schema-script',name:'schema脚本',content:`import { derived } from 'https://modules.example/derived.mjs';
import { eventOn, Mvu, getVariables, getScriptVariables, getChatMessages, insertVariables, deleteVariable, replaceScriptVariables } from 'tavern-helper';
await Promise.resolve();
eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async (_before, after) => {
  after.stat_data.derived=derived(getVariables().stat_data.hp);
  after.stat_data.global=getVariables({type:'global'}).score;
  after.stat_data.character=getVariables({type:'character'}).flag;
  after.stat_data.floor=getChatMessages('0-{{lastMessageId}}')[0].message;
  await replaceScriptVariables({registered: true});
  after.stat_data.owner=getScriptVariables().registered ? 1 : 0;
  await insertVariables({extra:1});
  await deleteVariable('extra');
});`}
const ui={id:'ui-script',name:'界面',content:"import x from 'https://modules.example/ui.mjs'; document.querySelector('#app')"}
assert.equal(classifyCardScript('// schema脚本说明\n'+root.content),'esm','首行注释不能让静态import漏分派');
assert.equal(classifyCardScript(root.content),'esm'); assert.equal(classifyCardScript(ui.content),'browser-ui')
assert.deepEqual(projectServerScripts([root,ui]).map(x=>x.id),[root.id]); assert.deepEqual(storageBrowserScripts([root,ui]).map(x=>x.id),[ui.id])
const scriptWrites=[]
function execution(scripts, esm={}) {return createServerExecution({logger,lodash,hookLoadBudgetMs:1,
  host:{updateVariables:async (_session,option,value)=> {if(option.type==='script')scriptWrites.push(option.script_id);return {updated:true}}, updateMessages:async()=>({updated:true})},
  readResourceSnapshot:async()=>({globalVariables:{score:9}}),readCardExtensions:async()=>({helperScripts:scripts,variables:{flag:7}}),project:scripts=>({scripts}),
  esm:{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>new Response('export const derived = hp => hp + 10'),...esm},
  executeCommand:async (_text,variables,emit)=>{variables.stat_data.hp=3;await emit('mag_variable_update_ended',variables,variables);return true},
})}
const execute=(e,draft=chat())=>e.executeMvuUpdate({sessionId:draft.sessionId,draft,transaction:{eventId:'mvu-work:esm-owned'},messageId:0,swipeId:0,commandText:'受控命令'})
if(typeof vm.SourceTextModule!=='function'){
  const e=execution([root]); try{await assert.rejects(execute(e),/experimental-vm-modules/)}finally{e.disposeAll()}
  console.log('esm-server-consumer: 缺flag真实消费者明确拒绝通过')
}else{
  const e=execution([root,ui]);try{
    const outcome=await execute(e)
    assert.equal(outcome.variables.stat_data.derived,13);assert.equal(outcome.variables.stat_data.global,9);assert.equal(outcome.variables.stat_data.character,7)
    assert.equal(outcome.variables.stat_data.floor,'正文');assert.equal(outcome.variables.extra,undefined)
    assert.deepEqual(scriptWrites,['schema-script'],'模块钩子默认脚本变量必须带真实owner')
    assert.equal(outcome.variables.stat_data.owner,1,'脚本变量读取同步且read-your-writes')
  }finally{e.disposeAll()}
  const hookDom={id:'hook-dom',name:'钩子依赖界面',content:"import {eventOn,Mvu} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, async()=> { await import('https://hook-ui.example/widget.mjs') })"}
  // 实际生产标记器必须只标当前根脚本；不能把依赖URL匹配失败退成整卡标记。
  const marks=[]
  const marked=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true})},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[hookDom]}),
    cardScriptDispatchStore:{lookupCard:()=>null,lookupScript:()=>null,markScript:(_card,id)=>marks.push(id),markCard:()=>marks.push('整卡')},
    esm:{lookupImpl:async()=>[{address:'8.8.8.8',family:4}],fetchImpl:async()=>new Response("document.querySelector('#app')")},
    executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true},
  })
  try{await assert.rejects(execute(marked),/DOM/);assert.ok(marks.length>0);assert.ok(marks.every(id=>id==='hook-dom'))}finally{marked.disposeAll()}
  const backgroundRoot={id:'background-import',name:'不等待导入',content:"import {eventOn,Mvu} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,()=> { import('https://missing.example/bad.mjs').catch(()=>{}) })"}
  const background=execution([backgroundRoot],{fetchImpl:async()=>new Response('throw new Error("模块执行失败")')})
  try{await assert.rejects(execute(background),/模块执行失败/)}finally{background.disposeAll()}
  const domRoot={id:'domroot',name:'依赖界面',content:"import 'https://ui.example/widget.mjs'"}
  const bad=execution([domRoot],{fetchImpl:async()=>new Response("document.querySelector('#app')")})
  try{await assert.rejects(execute(bad),/DOM|浏览器|界面/)}finally{bad.disposeAll()}
  const promptRoot={id:'prompt',name:'提示词模块',content:"import {eventOn,Mvu,injectPrompts} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,()=>injectPrompts([{id:'fixture-prompt',content:'fixture'}],{once:true}))"}
  const prompts=[]
  const promptExecution=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true}),updatePrompts:async(_session,operation,_revision,eventId)=>{await Promise.resolve();prompts.push({operation,eventId});return {updated:true}}},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[promptRoot]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{await execute(promptExecution);assert.equal(prompts[0].operation.once,true);assert.equal(prompts[0].eventId,'mvu-work:esm-owned')}finally{promptExecution.disposeAll()}
  const failedPrompt=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true}),updatePrompts:async()=>{await Promise.resolve();throw new Error('提示词CAS失败')}},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[promptRoot]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{await assert.rejects(execute(failedPrompt),/提示词CAS失败/)}finally{failedPrompt.disposeAll()}
  const regexRoot={id:'regex',name:'正则模块',content:"import {eventOn,Mvu,getTavernRegexes,replaceTavernRegexes} from 'tavern-helper';eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,async(_before,after)=>{after.stat_data.regexes=getTavernRegexes({type:'global'}).length;await replaceTavernRegexes([], {type:'global'})})"}
  const regex=createServerExecution({logger,lodash,host:{updateVariables:async()=>({updated:true}),saveExtensionSettings:async()=>{throw new Error('MVU结算事务不允许写入跨存储正则设置')}},project:scripts=>({scripts}),readResourceSnapshot:async()=>({extensionSettings:{regex:[]}}),readCardExtensions:async()=>({helperScripts:[regexRoot],globalRegexScripts:[{id:'g',name:'fixture',findRegex:'foo',placement:[2]}]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{await assert.rejects(execute(regex),/跨存储正则设置/)}finally{regex.disposeAll()}
  const schemaRoot={id:'schema-api',name:'schema/YAML模块',content:"import {eventOn,Mvu,z,YAML} from 'tavern-helper';const schema=z.object({hp:z.number()});eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,(_before,after)=>{after.stat_data.schemaHp=schema.parse(YAML.parse('hp: 12')).hp})"}
  const schemaExecution=createServerExecution({logger,lodash,YAML,zod,host:{updateVariables:async()=>({updated:true})},project:scripts=>({scripts}),readCardExtensions:async()=>({helperScripts:[schemaRoot]}),executeCommand:async(_text,v,emit)=>{await emit('mag_variable_update_ended',v,v);return true}})
  try{assert.equal((await execute(schemaExecution)).variables.stat_data.schemaHp,12)}finally{schemaExecution.disposeAll()}
  const trace=[]
  const rt=createCardScriptRuntime({cardPath:'event-fixture',logger,sources:[{id:'events',name:'events',kind:'esm',code:`
    import { eventOn,eventOnce,eventMakeFirst,eventMakeLast,eventClearEvent } from 'tavern-helper';
    eventOn('x',()=>trace.push('normal'));eventOnce('x',()=>trace.push('once'));eventMakeFirst('x',()=>trace.push('first'));eventMakeLast('x',()=>trace.push('last'));
    initializeGlobal('schema', {ready:true});await waitGlobalInitialized('schema');
  `}],hostApi:{trace}})
  try{await rt.ready;await rt.dispatchEvent({strict:true},'x');await rt.dispatchEvent({strict:true},'x');assert.deepEqual(trace,['first','normal','once','last','first','normal','last']);assert.equal(rt.sandbox.schema.ready,true)}finally{rt.dispose()}
  console.log('esm-server-consumer: 真实模块派生钩子/同步快照/Helper/graphDOM拒绝/事件一次及顺序通过')
}
const source=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8')
const transformed=applyRuntimeTransform(source)
assert.ok(transformed.includes('readResourceSnapshot: async (sessionId, chat)'))
assert.equal(applyRuntimeTransform(transformed),transformed)
console.log('esm-server-consumer: 实际作者加载期资源快照DI/幂等通过')
