// 原创事件/Chat夹具；仅核分叉规范、接缝幂等、SQL冷读；无真实数据或模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {normalizeForkHistoryMarkers as norm} from '../lib/fork-history-markers.js'
import {applyForkHistoryTransform as transform} from '../deploy/fork-history-transform.mjs'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
function fixture() {
  const events=[
    {seq:0,type:'user/message',data:{source:{kind:'plugin',plugin:'dsh-tavern',form:'synthetic-trajectory',version:1}}},
    {seq:1,type:'assistant/message',data:{turn:0,step:1,message:{source:{kind:'model',provider:'dsh-tavern',model:'synthetic-trajectory',version:1},content:[{type:'text',text:'原创种子'}]}}},
    {seq:2,type:'user/message',data:{source:{kind:'plugin',plugin:'dsh-tavern',form:'synthetic-trajectory',version:1}}},
  ]
  for(let turn=1;turn<=35;turn++) for(const event of [
    {type:'turn/start',data:{turn}},
    {type:'assistant/message',data:{turn,message:{source:{kind:'model'},content:[{type:'text',text:'原创'+turn}]}}},
    {type:'turn/end',data:{turn,reason:{kind:turn===32?'error':'completed'}}},
  ]) events.push({...event,seq:events.length,time:1})
  return {events,atSeq:events.length-1,chat:{id:'chat-fixture',sessionId:'session-fixture',messages:[{role:'assistant',turn:2,text:'原创'},{role:'assistant',turn:28,text:'替代'},{role:'assistant',turn:35,text:'尾'}],suppressedDshTurns:[3,29,32,36,37,38,39],hiddenDshErrorTurns:[32,37],regeneratedDshTurns:{2:3,28:29,38:39},timeline:{checkpoints:[],operations:{},participants:{}}}}
}
test('只去分叉外孤立标记，合法旧失败/重生成保留且输入不改',()=>{
  const f=fixture(),before=structuredClone(f),next=norm(f.chat,f.events,f.atSeq)
  assert.deepEqual(next.suppressedDshTurns,[3,29,32]);assert.deepEqual(next.hiddenDshErrorTurns,[32]);assert.deepEqual(next.regeneratedDshTurns,{2:3,28:29})
  assert.equal(next.messages,f.chat.messages);assert.deepEqual(f,before);assert.deepEqual(norm(next,f.events,f.atSeq),next)
})
test('最新故事28的替代原生29不能按故事max误删',()=>{
  const f=fixture();f.chat.messages=[{role:'assistant',turn:28,text:'原创'}];f.chat.regeneratedDshTurns={28:29}
  const at=f.events.find(event=>event.type==='turn/end'&&event.data.turn===29).seq
  const next=norm(f.chat,f.events,at);assert.deepEqual(next.regeneratedDshTurns,{28:29});assert.deepEqual(next.suppressedDshTurns,[3,29]);assert.deepEqual(next.hiddenDshErrorTurns,[])
})
test('缺边界/缺前缀/畸形轮号/剧情仍依赖未继承映射均零输入写入拒绝',()=>{
  const f=fixture(),before=structuredClone(f)
  assert.throws(()=>norm(f.chat,[],f.atSeq),/不连续/)
  assert.throws(()=>norm(f.chat,f.events.slice(1),f.atSeq),/不连续/)
  assert.throws(()=>norm(f.chat,f.events,f.atSeq-1),/已完成/)
  assert.throws(()=>norm({...f.chat,suppressedDshTurns:[null]},f.events,f.atSeq),/无效/)
  assert.throws(()=>norm({...f.chat,regeneratedDshTurns:{28:39}},f.events,f.atSeq),/缺少继承/)
  assert.deepEqual(f,before)
})
test('只允许确切作者turn0种子，未知turn0/负轮/缺轮仍拒绝且不隐藏种子',()=>{
  const f=fixture()
  for(const source of [{kind:'model',provider:'other',model:'synthetic-trajectory',version:1},{kind:'model',provider:'dsh-tavern',model:'synthetic-trajectory',version:2}]) {
    const events=structuredClone(f.events);events[1].data.message.source=source;assert.throws(()=>norm(f.chat,events,f.atSeq),/轮身份/)
  }
  for(const turn of [undefined,-1]){const events=structuredClone(f.events);events[1].data.turn=turn;assert.throws(()=>norm(f.chat,events,f.atSeq),/轮身份/)}
  assert.equal(norm(f.chat,f.events,f.atSeq).suppressedDshTurns.includes(0),false)
})
test('无标记普通分叉不造空字段；非连续遗留未来轮全部去除',()=>{
  const f=fixture();const clean={messages:f.chat.messages};assert.deepEqual(norm(clean,f.events,f.atSeq),clean)
  const next=norm({...clean,suppressedDshTurns:[32,99,36,99]},f.events,f.atSeq);assert.deepEqual(next.suppressedDshTurns,[32])
})
test('真实Host锚点转换首次publish之前执行，复跑幂等、漂移零产物拒绝',()=>{
  const source="async function forkChat() {\n    const target = sessionStore.get(targetId) || agentRegistry.get(targetId)?.session\n    const fork = forkConversationChat(state, { chatId: uid('chat'), sessionId: targetId, id: uid, now: Date.now })\n    await conversationRegistry.publish(fork)\n}\n" + `async function renameTargetSession(sessionId, title) {
      const target = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      if (!target || isReadOnlySession(sessionId)) throw new Error('数据库分叉目标会话不可写，未重命名')
      const titleService = ctx.get('sessionTitle')
      if (!titleService || typeof titleService.rename !== 'function') throw new Error('缺少原生会话标题服务')
      const accepted = titleService.rename(target, title)
      await sessionStore.flush(target)
      if (typeof accepted?.title !== 'string' || !accepted.title) throw new Error('宿主未返回接受的标题')
      return accepted.title
}`
  const next=transform(source);assert.equal(transform(next),next);assert.ok(next.includes('sessionEvents(target), atSeq)'));assert.ok(next.indexOf('const fork = normalize')<next.indexOf('await conversationRegistry.publish'))
  assert.throws(()=>transform(''),/锚点/);assert.throws(()=>transform(next.replace('sessionEvents(target)','events')),/漂移/)
})
test('写入真实SQLite后全新store冷读，旧合法索引仍在、未来标记没有复活',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'fork-marker-owned-')),stores=[]
  const helpers={copyJsonTree:structuredClone,diffJson:()=>[{path:[],op:'replace'}],applyJsonChangesShared:()=>{throw Error('本闸不应patch')},projectSessionMessage:row=>({role:row.role,turn:row.turn}),projectChatSessionState:(chat,options)=>({...chat,messages:options.messages||chat.messages}),...Object.fromEntries(['projectSceneImageState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'].map(key=>[key,()=>undefined]))}
  try{
    const f=fixture(),chat=norm(f.chat,f.events,f.atSeq),writer=createChatSqliteStore({dataRoot:dir,helpers});stores.push(writer)
    await writer.update(chat.id,()=>chat)
    const cold=createChatSqliteStore({dataRoot:dir,helpers});stores.push(cold)
    const read=await cold.read(chat.id),state=await cold.readSessionState(chat.id)
    for(const value of [read,state]){assert.deepEqual(value.suppressedDshTurns,[3,29,32]);assert.deepEqual(value.hiddenDshErrorTurns,[32]);assert.deepEqual(value.regeneratedDshTurns,{2:3,28:29});assert.equal(value.messages.length,3)}
  }finally{for(const store of stores)store.dispose();rmSync(dir,{recursive:true,force:true})}
})
