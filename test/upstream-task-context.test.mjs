// 固定5bfc7b4作者源码，只测本次任务operationId/上下文接缝与其生产装配顺序。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {fileURLToPath} from 'node:url'
import {AsyncLocalStorage} from 'node:async_hooks'
import {applyPluginTaskApiTransform} from '../deploy/plugin-task-quiescence-transform.mjs'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {maintenanceTargets,maintenanceReadSources} from '../deploy/standard-seams.mjs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
const root=fileURLToPath(new URL('../../../tmp/inspect-main-20261018/fixed/',import.meta.url))
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8')
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const tick=()=>new Promise(r=>setImmediate(r))
function factory(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'})
 const cuts=ast.body.filter(n=>n.type==='ImportDeclaration').map(n=>({start:n.start,end:n.end})).concat(ast.body.filter(n=>n.type==='ExportNamedDeclaration').map(n=>({start:n.start,end:n.declaration.start})))
 for(const cut of cuts.sort((a,b)=>b.start-a.start))source=source.slice(0,cut.start)+source.slice(cut.end)
 return vm.runInNewContext(source+'\ncreateTavernPluginApi',{AsyncLocalStorage,AbortController,AbortSignal,structuredClone,setTimeout,clearTimeout,console})
}

test('5bfc7b4任务上下文：保留作者operationId，取消等待实际run与未await写，迟到写拒绝',async()=>{
 const source=applyPluginTaskApiTransform(read('tavern-plugin/lib/plugin-api.js'))
 assert.equal(applyPluginTaskApiTransform(source),source)
 assert.equal(source.split("import { AsyncLocalStorage } from 'node:async_hooks'").length-1,1)
 const material={chatId:'chat',sessionId:'session',turn:2,key:'version-2',text:'原创正文',source:'原创正文',card:{path:'card',name:'原创卡'}}
 const entered=deferred(),release=deferred(),writeEntered=deferred(),writeRelease=deferred();let operationId,writes=0,lateRejected=false
 const api=factory(source)({ctx:{fiber:{name:'synthetic-plugin'},effect:fn=>fn()},resolveGame:async()=>({chatId:'chat',sessionId:'session'}),data:{readSettings:async()=>({}),saveGame:async()=>{writeEntered.resolve();await writeRelease.promise;writes++}},readLatestSettledTurn:async()=>material,readTurn:async()=>material,writeVariables:async(_material,_vars,options)=>{operationId=options.taskOperation()}})
 api.service.manualTask({name:'context',run:async()=>{
  await api.service.setVariables({gameId:'session',turn:2,textVersion:'version-2',variables:{gold:7}})
  api.service.saveGameData({gameId:'session',data:{owned:true}}).catch(()=>{})
  entered.resolve();await release.promise
  try{await api.service.setVariables({gameId:'session',turn:2,textVersion:'version-2',variables:{gold:8}})}catch{lateRejected=true}
 }})
 let quiet=false
 const job=api.runManualTask({gameId:'session',key:'synthetic-plugin:context',operationId:'operation-2',signal:new AbortController().signal}).then(()=>quiet=true)
 await entered.promise;await writeEntered.promise
 assert.equal(operationId,'operation-2','作者任务身份必须在嵌套异步上下文内保留')
 api.stopTasks('session');await tick();assert.equal(quiet,false);assert.ok(api.runningTask('session'))
 release.resolve();await tick();assert.equal(lateRejected,true);assert.equal(quiet,false,'未await的在途写仍阻止静止')
 writeRelease.resolve();await job;assert.equal(writes,1);assert.equal(api.runningTask('session'),null)
 await api.service.setVariables({gameId:'session',turn:2,textVersion:'version-2',variables:{gold:9}})
 assert.equal(operationId,null,'任务外写入不冒用已结束的operation')
})

test('5bfc7b4生产施缝：前置命名与取消接线齐备，保留operationId及作者taskContext',async()=>{
 const sources=new Map([...maintenanceTargets,...maintenanceReadSources].filter(rel=>fs.existsSync(path.join(root,rel))).map(rel=>[rel,read(rel)]))
 const writes=buildCore(root,sources),index=writes.get('tavern-plugin/lib/index.js'),api=writes.get('tavern-plugin/lib/plugin-api.js')
 for(const source of [index,api])parse(source,{ecmaVersion:'latest',sourceType:'module'})
 assert.ok(index.includes('[dsh-tavern-fork-cold-title:v1]'))
 assert.ok(index.includes('normalizeForkHistoryMarkers(forkConversationChat('))
 assert.ok(index.includes('await quiescePluginTasks(chat)'))
 assert.ok(api.includes('taskContext.run(scope, () => entry.run('))
 const from=index.indexOf('  async function quiescePluginTasks('),to=index.indexOf('  async function onSettlementSettled(',from)
 const calls=[],map=new Map(),done=deferred()
 const context={pluginTaskJobs:map,rollbackSchedulingBarrier:new Set(),AbortController,taskStateReader:{forSession:async()=>({id:'chat',sessionId:'session',mode:'story'})},str:x=>x,agentRegistry:{get:()=>null},pluginApi:{manualTaskFor:async()=>{},runManualTask:async input=>{calls.push(input.operationId);await done.promise},stopTasks:()=>{}},backgroundTasks:{begin:async()=>({operationId:'host-operation',commit:async()=>calls.push('commit')})},pluginSettlementProgress:{begin:()=>{}},sessionSignals:{publish:()=>calls.push('idle')},console,Date}
 const host=vm.runInNewContext(index.slice(from,to)+'\n({startPluginTask,quiescePluginTasks})',context)
 await host.startPluginTask('session','key')
 assert.equal(calls[0],'host-operation','真实Host替换体不能丢掉作者operationId')
 let quiet=false;const quiescing=host.quiescePluginTasks({id:'chat',sessionId:'session'}).then(()=>quiet=true)
 await tick();assert.equal(quiet,false);assert.equal(map.size,1)
 done.resolve();await quiescing;assert.equal(map.size,0);assert.deepEqual(calls,['host-operation','commit','idle'])
})
