// 固定上游79d3414真实源码：新版接缝与作者自愈接线，不执行安装或现场玩法。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {maintenanceTargets,maintenanceReadSources} from '../deploy/standard-seams.mjs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
const ROOT=fileURLToPath(new URL('../../../tmp/upstream-79d3414-adapt-20261017/',import.meta.url))
function transformed(){
 const sources=new Map([...maintenanceTargets,...maintenanceReadSources].filter(rel=>fs.existsSync(path.join(ROOT,rel))).map(rel=>[rel,fs.readFileSync(path.join(ROOT,rel),'utf8')]))
 assert.ok(sources.size>30,'真实作者源夹具必须齐全')
 return buildCore(ROOT,sources)
}

test('最新版79d3414：真实接缝保留作者自愈并传入物理回退消费者',()=>{
 const writes=transformed()
 for(const [rel,source] of writes) {try{parse(source,{ecmaVersion:'latest',sourceType:'module',allowHashBang:true})}catch(error){throw new Error(rel+': '+error.message,{cause:error})}}
 const history=writes.get('tavern-plugin/lib/domain/round-history.js')
 assert.match(history,/storageRollback\.cleanRollback/)
 assert.match(history,/repairNative[,\s]/,'不能丢失作者现有自愈参数')
 assert.match(history,/repairNative: typeof repairNative === 'function' \? repairNative : undefined/,'必须把纯自愈回调传给清理消费者')
 const index=writes.get('tavern-plugin/lib/index.js')
 assert.match(index,/repairNative: \(sessionId, session\) => repairNativeStory/)
 assert.match(index,/function repairNativeStory/)
 assert.match(index,/recordNativeSurfaceRepair/)
 for(const name of ['clearFailedTurns','cleanupFailedTurn']) {
  const from=index.indexOf('    '+name+': async function ('),to=index.indexOf('\n    },',from)
  const block=index.slice(from,to)
  assert.ok(block.includes('return 0'),'失败状态仍由作者处理，不能自动软隐藏')
  assert.ok(!block.includes('clearFailedTurnSurface('))
 }
 const route=index.slice(index.indexOf("      case 'rollbackTurn': {"),index.indexOf("      case 'callPluginHandler':"))
 assert.ok(route.includes('await rollbackTurn('))
 assert.ok(!route.includes('reconcileStory('),'回退前不认证或补记待删原生对象；清理后只调用纯修复')
})

test('最新版79d3414视图：缺前像与原生不匹配仍提供同一最新轮清理入口',async()=>{
 const rel='tavern-plugin/lib/domain/chat-session-state.js',writes=transformed()
 const source=writes.get(rel).replace(/from '([^']+)'/g,(_all,spec)=>{
  const url=spec==='./storage-rollback.js'?new URL('../lib/clean-rollback.js',import.meta.url):pathToFileURL(path.resolve(ROOT,path.dirname(rel),spec))
  return 'from '+JSON.stringify(url.href)
 })
 const {createSessionStateView,projectChatSessionState}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
 const fields=createSessionStateView({activity:()=>({busy:false}),evidence:()=>({events:[{seq:0,type:'turn/start',data:{turn:8}}]})})
 for(const status of ['completed','failed','running','aborted','unknown']) {
  const chat={id:'fixture-chat',sessionId:'fixture-session',mode:'story',messages:[],timeline:{schemaVersion:1,operations:{body:{kind:'body',turn:8,status}}}}
  const value=fields.rollback(projectChatSessionState(chat))
  assert.equal(value.canRollback,true,status+'缺字段/缺前像不能禁用')
  assert.equal(value.rollbackTarget.turn,8);assert.equal(value.rollbackTargetTurn,8)
  assert.equal(value.canClearIncompleteReply,false,'所有对象只保留同一回退入口')
 }
 const pending={id:'fixture-chat',sessionId:'fixture-session',mode:'story',messages:[],rollbackPending:{id:'retry',turn:8,cuts:[]},timeline:{operations:{}}}
 assert.equal(fields.rollback(projectChatSessionState(pending)).rollbackTarget.rollbackId,'retry','半提交仍重试同次清理')
 assert.equal(fields.rollback({...pending,mode:'card',rollbackPending:undefined}).canRollback,false,'工作台不改成剧情回退')
})
