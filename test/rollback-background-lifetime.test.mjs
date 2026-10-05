import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyRollbackBackgroundLifetimeTransform,applyRollbackBackgroundOwnerHostTransform} from '../deploy/rollback-background-lifetime-transform.mjs'
import {applyBackgroundTaskRollbackTransform} from '../deploy/background-rollback-transform.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
test('实际创建登记回调在descriptor之后，登记失败释放句柄；回拨校准取较早seq',async()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-background-agent-sessions.js',import.meta.url),'utf8'),next=applyRollbackBackgroundLifetimeTransform(source)
 const start=next.indexOf('          // [dsh-tavern-background-identity-boundary:v2]'),end=next.indexOf('\n        }\n      } catch',start)
 assert.ok(next.indexOf("handle.agent.session.append('subagent/descriptor'")<start)
 assert.equal(applyRollbackBackgroundLifetimeTransform(next),next)
 const consumer=new Function('options','input','handle','return (async()=>{'+next.slice(start,end)+';return handle})()')
 let disposed=0,recorded=0;const handle={agent:{session:{id:'worker'}},dispose:async()=>disposed++}
 assert.equal(await consumer({recordRollbackBoundary:async()=>recorded++},{},handle),handle);assert.equal(recorded,1);assert.equal(disposed,0)
 await assert.rejects(consumer({recordRollbackBoundary:async()=>{throw Error('登记故障')}},{},handle),/登记故障/);assert.equal(disposed,1)
 const catchStart=next.indexOf('      } catch (error) {\n        if(handle!==undefined)'),catchEnd=next.indexOf('        const wrapped = traceError',catchStart)
 const cleanup=new Function('handle','return (async()=>{'+next.slice(catchStart+'      } catch (error) {'.length,catchEnd)+';return handle})()')
 assert.equal(await cleanup(handle),undefined);assert.equal(disposed,2)
 const host=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8'),updated=applyRollbackBackgroundOwnerHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(host)))
 const begin=updated.indexOf('    recordRollbackBoundary: async'),finish=updated.indexOf('    retirement: backgroundRetirement,',begin)
 const chat={id:'fixture',mode:'story',timeline:{operations:{body:{kind:'body',turn:53}}}}
 const callbacks=new Function('chatForSession','updateChat','ctx','chatJournalStore','return ({'+updated.slice(begin,finish)+'})')(async()=>chat,async(_id,mutate)=>mutate(chat),{get:()=>({bindRollbackArchive:async()=>{}})},{rollbackArchivePath:()=>'/fixture/archive.db'})
 await callbacks.recordRollbackBoundary({sessionId:'fixture'},{id:'worker',log:[{seq:100}]});await callbacks.recordRollbackBoundary({sessionId:'fixture'},{id:'worker',log:[{seq:62}]});assert.equal(chat.rollbackSessionCuts['53'].worker,62)
 await callbacks.recordRollbackBoundary({sessionId:'fixture'},{id:'new-worker',log:[]});assert.equal(chat.rollbackSessionCuts['53']['new-worker'],-1)
 await callbacks.recordRollbackBoundary({sessionId:'fixture',turn:54},{id:'new54-worker',log:[]});assert.equal(chat.rollbackSessionCuts['54']['new54-worker'],-1)
 assert.ok(updated.includes('bindRollbackArchive(session.id,chatJournalStore.rollbackArchivePath(chat.id))'))
})
test('实际后台所有任务发模型前保存session独立seq且完整run可等待',()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-background-agent-sessions.js',import.meta.url),'utf8')
 const next=applyRollbackBackgroundLifetimeTransform(source);assert.equal(applyRollbackBackgroundLifetimeTransform(next),next)
 const taskSource=readFileSync(new URL('../../../tmp/projection-baseline-1001/background-agent-task.js',import.meta.url),'utf8')
 const task=applyBackgroundTaskRollbackTransform(taskSource);assert.equal(applyBackgroundTaskRollbackTransform(task),task)
 assert.ok(task.indexOf('await options.rewindSession')<task.indexOf('await options.recordRollbackBoundary'))
 assert.ok(task.indexOf('await options.recordRollbackBoundary')<task.indexOf('agent.followup({'))
 assert.ok(next.indexOf("handle.agent.session.append('subagent/descriptor'")<next.indexOf('await options.recordRollbackBoundary'))
 assert.ok(next.includes('cuts[session.id]')===false)
 assert.ok(next.includes('return Object.freeze({ progress, run, whenIdle,'));assert.ok(!next.includes('void Promise.resolve().then(async () => {'))
 const host=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8')
 const updated=applyRollbackBackgroundOwnerHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(host)));assert.equal(applyRollbackBackgroundOwnerHostTransform(updated),updated)
 assert.ok(updated.includes('session.log.at(-1)?.seq'));assert.ok(updated.includes('backgroundAgentRunner.whenIdle(chat.sessionId)'))
})
