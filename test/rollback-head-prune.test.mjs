// 仅保留已公开deprecated L4导出的兼容合同，不作为当前cleanRollback主路径覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanupRollbackHeadIndex } from '../lib/rollback-head-prune.js'

test('兼容导出L4：删除目标轮索引与终态账本，保留更早轮和在途非悬空项',async()=>{
  let chat={
    foregroundFrames:{'1':{turn:1},'2':{turn:2}},runtimeInputs:{'1':{x:1},'2':{x:2}},nativeCommits:{'1':{},'2':{}},
    preparedWorldBook:{turn:2},preparedWorldBookContext:'old',lastWorldBookRecall:{turn:2},worldBookReads:{old:{turn:1},new:{turn:2}},
    timeline:{checkpoints:[{turn:1},{turn:2}],operations:{
      bodyOld:{kind:'body',turn:1,status:'completed'},bodyNew:{kind:'body',turn:2,status:'completed'},
      agentOld:{kind:'agent',roundOperationId:'bodyOld',status:'completed'},
      agentNew:{kind:'agent',roundOperationId:'bodyNew',status:'completed'},
      agentRunning:{kind:'agent',roundOperationId:'bodyNew',status:'running'},
      agentOther:{kind:'agent',roundOperationId:'other',status:'running'},
    }},rollbackUndo:{turn:2},
  }
  const sources=[]
  const chats={
    async readSlice(){return {chat:structuredClone(chat)}},
    async update(_id,mutation,meta){sources.push(meta?.source);chat=mutation(chat);return chat},
  }
  const removed=await cleanupRollbackHeadIndex(chats,'fixture-chat',2)
  assert.equal(removed,10)
  assert.deepEqual(sources,['rollback.cleanup'])
  assert.deepEqual(chat.foregroundFrames,{'1':{turn:1}})
  assert.deepEqual(chat.runtimeInputs,{'1':{x:1}})
  assert.deepEqual(chat.nativeCommits,{'1':{}})
  assert.deepEqual(chat.timeline.checkpoints,[{turn:1}])
  assert.equal(chat.preparedWorldBook,null);assert.equal(chat.preparedWorldBookContext,'')
  assert.equal(chat.lastWorldBookRecall,null);assert.deepEqual(chat.worldBookReads,{old:{turn:1}})
  assert.deepEqual(chat.timeline.operations,{bodyOld:{kind:'body',turn:1,status:'completed'},agentOld:{kind:'agent',roundOperationId:'bodyOld',status:'completed'},agentRunning:{kind:'agent',status:'running'},agentOther:{kind:'agent',roundOperationId:'other',status:'running'}})
  assert.equal(chat.rollbackUndo,undefined)
})
