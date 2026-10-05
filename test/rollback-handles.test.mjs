import test from 'node:test'
import assert from 'node:assert/strict'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
test('活动读写句柄回卷并清除旧尾部缓冲，不动其他会话',()=>{
 const writer={id:'fixture',access:'write',state:{cursor:9,primed:{text:'旧53'},tornTruncateTo:9,recoveredTail:{text:'旧53'}},observedLength:9}
 const reader={id:'fixture',access:'read',observedLength:9},other={id:'other',observedLength:9}
 rewindRollbackHandles(new Set([writer,reader,other]),'fixture',4)
 assert.deepEqual(writer.state,{cursor:4,primed:undefined,tornTruncateTo:undefined,recoveredTail:undefined})
 assert.equal(writer.observedLength,4);assert.equal(reader.observedLength,4);assert.equal(other.observedLength,9)
})
test('缺注册表或不能回卷的句柄必须抛错，不能warn成功',()=>{
 assert.throws(()=>rewindRollbackHandles(undefined,'fixture',4),/注册表/)
 assert.throws(()=>rewindRollbackHandles([{id:'fixture',access:'write'}],'fixture',4),/游标/)
 assert.throws(()=>rewindRollbackHandles([Object.freeze({id:'fixture',observedLength:9})],'fixture',4),TypeError)
})
