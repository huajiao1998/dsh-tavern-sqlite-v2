// 本轮新增断言：使用固定作者真源码和真实转换函数，不使用玩家数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {maintenanceTargets,maintenanceReadSources} from '../deploy/standard-seams.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyCleanRollbackTransform} from '../deploy/clean-rollback-transform.mjs'
import {applyRegenerationAdoptionTransform} from '../deploy/regeneration-adoption-transform.mjs'
import {applyOpeningCommitTransform} from '../deploy/opening-commit-transform.mjs'
import {applyUnifiedRollbackBusyRelax} from '../deploy/rollback-sync-author-transform.mjs'
import {createRollbackOperationScope} from '../lib/rollback-operation-scope.js'
import {rollbackSchedulingBarrier,rollbackCancellationBarrier} from '../lib/rollback-barrier.js'
import {latestSendTarget} from '../lib/latest-send.js'
import {resolveRollbackBusinessState,restoreRollbackBusinessState} from '../lib/rollback-business-state.js'
const fixture=path.resolve('../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b')
function generated(){const files=new Map();for(const rel of [...maintenanceTargets,...maintenanceReadSources]){const f=path.join(fixture,rel);if(fs.existsSync(f))files.set(rel,fs.readFileSync(f,'utf8'))}return buildCore(fixture,files)}

test('审查修复R7-R10：真实作者输出复施、旧consumer升级、按钮和开场',()=>{
 const output=generated(),round=output.get('tavern-plugin/lib/domain/round-history.js'),host=output.get('tavern-plugin/lib/index.js'),opening=output.get('tavern-plugin/lib/domain/conversation-initialization.js')
 assert.equal(applyRollbackHostTransform(host),host,'宿主复施无未定义IDLE')
 assert.equal(applyCleanRollbackTransform(round),round,'最终回退消费者复施不丢取消接线')
 assert.equal(applyRegenerationAdoptionTransform(round),round)
 assert.equal(applyOpeningCommitTransform(opening),opening)
 assert.match(output.get('tavern-plugin/lib/domain/storage-rollback.js'),/createRollbackOperationScope, withNativeOpening/)
 for(const [name,text] of output){if(name.endsWith('.js'))new vm.SourceTextModule(text,{identifier:name})}
 const old=fs.readFileSync(new URL('../../../tmp/rollback-minimal-20261016/effective/tavern-plugin/lib/domain/round-history.js',import.meta.url),'utf8')
 const legacy=old.replace('void restoredAgent','if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())\n    void restoredAgent').replace('cleanupRollbackSides })','cleanupRollbackSides, isFailureCleanupIdle })').replace('preserveRetainedBodyEdits: true,','preserveRetainedBodyEdits: true,\n        isFailureCleanupIdle,')
 const upgraded=applyRegenerationAdoptionTransform(applyCleanRollbackTransform(legacy))
 const body=upgraded.slice(upgraded.indexOf('async function rollbackChat('),upgraded.indexOf('async function undoRollback('))
 assert.doesNotMatch(body,/isFailureCleanupIdle|replacementAllowed|availability/)
 assert.match(body,/cancelPendingOperations: operationScope.cancelAndJoin/)
 assert.doesNotMatch(upgraded,/scopedChats|operationScope.guard|metadata\?\.assertCurrent/,'不再包装读写反复验证')
 assert.equal(applyRegenerationAdoptionTransform(applyCleanRollbackTransform(upgraded)),upgraded)
 const client=output.get('tavern-plugin/src/client/features/play-controls.js')
 assert.match(client,/const blocked = rolling;/)
 const prev=client.replace('const blocked = rolling;','const blocked = rolling || regenBusy || (!signedUnifiedTarget && (frontRunning || activity.busy || settlementActive));')
 assert.equal(applyUnifiedRollbackBusyRelax(prev),client)
})

test('审查修复UI提示：部分恢复在错误行和菜单可见，旧同步前置升级且复施幂等',async()=>{
 const {applyErrorPurgePlayControlsTransform}=await import('../deploy/error-purge-transform.mjs')
 const {applyRollbackSyncActionGuardTransform}=await import('../deploy/rollback-sync-install-transform.mjs')
 const client=generated().get('tavern-plugin/src/client/features/play-controls.js')
 assert.equal(applyErrorPurgePlayControlsTransform(client),client)
 assert.doesNotMatch(client,/未执行回退/)
 assert.match(client,/if \(clearIncomplete\) \{\s*setCandidatePanel\(null\); setRegenPanel\(null\); setCandidateGuidePanel\(null\);\s*if \(result && result.view && result.view.rollbackWarning\) tavernErrorHub.report\("回退提示"[^\n]+\n\s*return result;/,'菜单提前return前必须展示部分恢复警告')
 const at=client.indexOf('onPurge: async function (turn, failureTarget) {'),end=client.indexOf('\n                    },',at)
 assert.ok(at>=0&&end>at)
 const notices=[],resp={view:{rollbackWarning:'前台已物理回退；缺少旧值'}}
 const purge=new Function('props','failureViewRef','tavernErrorHub','setCandidatePanel','setRegenPanel','setCandidateGuidePanel','return ('+client.slice(at+'onPurge: '.length,end)+'\n})')({sessionId:'s',storageUi:()=>({cleanFailure:async()=>resp})},{current:{view:{rollbackTarget:{turn:3}}}},{report:(label,error)=>notices.push([label,error.message])},()=>{},()=>{},()=>{})
 assert.equal(await purge(3),resp);assert.deepEqual(notices,[['回退提示',resp.view.rollbackWarning]])
 const old='if (typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行回退");\n'+client
 const upgraded=applyRollbackSyncActionGuardTransform(old)
 assert.doesNotMatch(upgraded,/未执行回退/);assert.equal(applyRollbackSyncActionGuardTransform(upgraded),upgraded)
})

test('最小取消：等待旧任务结束，重复取消合流，无租约资格拒绝',async()=>{
 const id='minimal-cancel',scope=createRollbackOperationScope({sessions:{get:()=>undefined}})
 let resume,entered,late=0
 const gate=new Promise(r=>resume=r),ready=new Promise(r=>entered=r)
 const job=scope.run(id,async()=>{entered();await gate;scope.check();late++})
 const observed=assert.rejects(job,/玩家回退取消/);await ready
 const first=scope.cancelAndJoin(id),second=scope.cancelAndJoin(id)
 resume();await observed
 const a=await first,b=await second
 assert.equal(late,0);assert.equal(rollbackSchedulingBarrier.has(id),true)
 a();assert.equal(rollbackSchedulingBarrier.has(id),true)
 b();assert.equal(rollbackSchedulingBarrier.has(id),false)
})

test('最小取消重入：重放内部清理与玩家回退直接等待，不验证所有者',async()=>{
 const id='minimal-reentrant',scope=createRollbackOperationScope({sessions:{get:()=>undefined}})
 let resume,entered
 const gate=new Promise(r=>resume=r),ready=new Promise(r=>entered=r)
 const job=scope.run(id,async()=>{const release=await scope.cancelAndJoin(id);entered();await gate;release();scope.check()})
 const observed=assert.rejects(job,/玩家回退取消/);await ready
 const outer=scope.cancelAndJoin(id);resume();await observed
 const release=await outer;release();assert.equal(rollbackCancellationBarrier.has(id),false)
})

test('审查修复R5：部分旧前像只恢复剧情宏，不覆盖独立用户配置',()=>{
 const chat={id:'c',sessionId:'s',messages:[{role:'user',turn:2}],macroState:{userName:'新名字',local:{hp:2},global:{x:2},custom:'保留'},timeline:{operations:{body:{kind:'body',turn:2,rowBefore:{macroState:{userName:'旧名字',local:{hp:1},global:{x:1}}}}},checkpoints:[],participants:{}}}
 const baseline=resolveRollbackBusinessState(chat,2);assert.equal(baseline.partial,true)
 restoreRollbackBusinessState(chat,baseline)
 assert.deepEqual(chat.macroState,{userName:'新名字',local:{hp:1},global:{x:1},custom:'保留'})
})

test('审查修复R10：仅静态开场不签用户发送，无输入真实新轮仍可撤',()=>{
 const chat={id:'c',sessionId:'s',_storageRevision:3,messages:[{role:'assistant',greeting:true,turn:1}],timeline:{branchId:'b',operations:{},checkpoints:[]}}
 const events=[{seq:0,type:'turn/start',data:{turn:1}},{seq:1,type:'assistant/message',data:{turn:1,message:{id:'tavern-opening:fixture'}}},{seq:2,type:'turn/end',data:{turn:1}}]
 assert.equal(latestSendTarget(chat,{events}),null)
 events.push({seq:3,type:'turn/start',data:{turn:2}})
 assert.equal(latestSendTarget(chat,{events}).turn,2,'不按无user/turn1等泛化禁新轮')
})
