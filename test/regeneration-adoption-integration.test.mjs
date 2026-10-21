// 与产品同施缝、真实Session/SQL/投影；响应adapter不请求外部模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './regeneration-rollback-integration.test.mjs'
import {cleanRollback} from '../lib/clean-rollback.js'

test('正文物理采用：原用户保位、连续重生成、真实Session SQL投影归原轮及普通回退',async()=>{
 const f=await fixture({physical:true})
 try{
  const before=await f.read(),originalUser=structuredClone(f.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user').at(-1))
  const checkpoint=before.timeline.checkpoints.find(cp=>cp.turn===53)
  for(let i=0;i<2;i++){
   const result=await f.roundHistory.regenerate(before.id,'指导'+i)
   assert.equal(result.adopted.hiddenTurn,53);assert.equal(result.adopted.syntheticTurn,53)
  }
  const after=await f.read(),events=f.session.snapshotEvents()
  assert.equal(after.messages.at(-1).turn,53);assert.deepEqual(after.messages.at(-2),before.messages.at(-2))
  assert.deepEqual(after.timeline.checkpoints,[checkpoint])
  assert.deepEqual(events.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='user').at(-1),originalUser)
  assert.equal(events.some(e=>e.type==='user/message'&&e.data?.source?.plugin==='dsh-tavern-regen'),false)
  assert.equal(events.some(e=>Number(e.data?.turn)>=54),false)
  assert.equal(events.some(e=>e.type==='assistant/message'&&e.data.message.content.some(p=>p.text==='原53')),false)
  assert.deepEqual(f.mainDb.readAll().events,events);assert.equal(f.mainDb.cursor(),events.length)
  assert.equal(f.agent.phase.lastTurn,53)
  for(const h of f.handles)if(h.id===f.session.id)assert.equal(h.state.cursor,events.length)
  assert.equal(f.syncFrames.length,2)
  // physical 采用：新 assistant 必须保留同 mvuBaseline、mvu.pending 为真，且不继承旧 receipt/delivery。
   const lastMessages = after.messages.filter(message => message.role === 'assistant')
  const lastAssistant = lastMessages.at(-1)
  assert.equal(lastAssistant.mvuBaseline.swipeId, 0, '必须保留同 mvuBaseline（swipeId）')
  assert.deepEqual(lastAssistant.mvuBaseline.variables, { hp: 53 }, 'baseline 变量必须逐字保留')
  assert.equal(after.settleStatus, 'pending', '采用后必须进入待结算状态')
  assert.equal(JSON.stringify(lastAssistant.mvu ?? {}).includes('legacy-delivery'), false, '不得继承旧 mvu delivery/receipt')
  await cleanRollback({...f.args(),chat:after,requestedTurn:53});await f.assertRolled()
 }finally{await f.cleanup()}
})
