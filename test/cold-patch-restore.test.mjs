// 只验证后端冷恢复实际方法接线；真实宿主扩展日志验证另有运行时夹具，不把本闸冒称真Session。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8')
const body=source.slice(source.indexOf('\tasync loadRollbackSession(id) {'),source.indexOf('\n\tasync bindRollbackArchive'))
const load=new Function('SessionPersistenceNotFoundError','rewindSessionMemory','return ({'+body+'}).loadRollbackSession')(class extends Error{},(session,n)=>{session.log.length=n})
test('冷恢复经共享ready补丁而非stock validate，保留required marker及SQL事件不写',async()=>{
 const stored={header:{id:'session-owned'},events:[{seq:0,type:'dsh-tavern/required-session-patch-v1',data:{version:1,hostVersion:'0.1.5-rc.2'}}],inheritedEventCount:1},before=structuredClone(stored),calls=[]
 const patch={serverReady:true,restoreStoredSession(value){calls.push('patch');assert.equal(value,stored);return {id:stored.header.id,log:[...stored.events,{type:'session/end-seed'}]}}}
 const persistence={assertWritable:id=>calls.push('guard:'+id),drainOpenHandles:async()=>calls.push('drain'),store:{openExisting:()=>({readAll:()=>stored})},[Symbol.for('dsh-tavern.host-session-patch.v1')]:patch}
 const restored=await load.call(persistence,'session-owned');assert.deepEqual(calls,['guard:session-owned','drain','patch']);assert.equal(restored.log.length,1);assert.equal(restored.log[0].type,stored.events[0].type);assert.equal(restored.log[0].ignorable,undefined);assert.deepEqual(stored,before)
 for(const invalid of [{serverReady:false,restoreStoredSession:patch.restoreStoredSession},{serverReady:true},undefined]){persistence[Symbol.for('dsh-tavern.host-session-patch.v1')]=invalid;await assert.rejects(()=>load.call(persistence,'session-owned'),/缺少已就绪/)}
 persistence[Symbol.for('dsh-tavern.host-session-patch.v1')]={serverReady:true,restoreStoredSession:()=>({id:'other'})};await assert.rejects(()=>load.call(persistence,'session-owned'),/身份不一致/)
 assert.doesNotMatch(body,/persistMod\.validateStoredEvents|Session\.fromRestore/)
})
