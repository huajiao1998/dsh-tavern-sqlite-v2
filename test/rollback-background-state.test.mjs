import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyRollbackBackgroundLifetimeTransform} from '../deploy/rollback-background-lifetime-transform.mjs'
test('常驻后台state的旧任务输入/召回/工具闭包清除，不丢后续必要task配置',async()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-background-agent-sessions.js',import.meta.url),'utf8'),next=applyRollbackBackgroundLifetimeTransform(source)
 const start=next.indexOf('  async function clearRollbackState'),end=next.indexOf('  function owns',start)
 const state={input:{task:'settlement',sessionId:'fixture',selection:{model:'fixture'},storyText:'旧53',preparedWorldbook:'旧53',currentVariables:{hp:53}},currentWorldbook:'旧53',activeToolTask:()=>{},imageReadTask:()=>{}}
 const residentHandles=new Map([['background',{parentSessionId:'fixture',state}]]),requestContexts=new Map([['background',{text:'旧53'}]]),requestSessions=new Map([['background',{}]])
 const clear=new Function('whenIdle','residentHandles','requestContexts','requestSessions',next.slice(start,end)+'return clearRollbackState;')(async()=>{},residentHandles,requestContexts,requestSessions)
 await clear('fixture');assert.ok(!JSON.stringify(state).includes('旧53'));assert.equal(state.input.task,'settlement');assert.equal(requestContexts.size,0);assert.equal(requestSessions.size,0);assert.equal(state.currentWorldbook,undefined);assert.equal(state.activeToolTask,undefined)
})
