// 本轮R1/R2/R3最小闸：同库真实SQL+原创helper协议夹具+变换后的真实作者调用函数。
// 不读真实档、不启作者/GUI；不把纯内存客户端断言当页面验收。
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, rmdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { createCurrentVariableReader } from '../lib/current-variables.js'
import { registerVariableReadTool } from '../lib/read-variables.js'
import { applyHostTransform, applyHelperCurrentTransform } from '../deploy/core-host-transform.mjs'
const clone = value => value === undefined ? undefined : structuredClone(value)
const helpers = Object.fromEntries(['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'].map(name => [name, clone]))
Object.assign(helpers, { copyJsonTree: clone, diffJson: (_a,b) => [{op:'set',path:[],value:b}], applyJsonChangesShared: (a,changes) => {
    const next=clone(a)
    for(const change of changes){if(change.path.length===0)return clone(change.value);let parent=next;for(const key of change.path.slice(0,-1))parent=parent[key];parent[change.path.at(-1)]=clone(change.value)}
    return next
  },
  projectTavernHelperMessage: (row,id) => ({ message_id:id, role:row.role, variables:clone(row.variables?.[row.swipeId||0] ?? {}), swipes_data:clone(row.variables||[]) }),
  projectTavernHelperContext: chat => ({ chatId:chat.id, stateRevision:chat._storageRevision, chatVariables:clone(chat.variables||{}), messages:[] }),
  createScopedMessages: (length,_entries,read) => new Proxy([], { get: (a,k) => k==='length' ? length : /^\d+$/.test(String(k)) ? read(Number(k)) : a[k] }),
})
const root = mkdtempSync(path.join(os.tmpdir(),'tavern-current-owned-'))
const id = 'current-variables-fixture'
let store = createChatSqliteStore({ dataRoot:root, helpers }); let probe
try {
  const tree = hp => ({stat_data:{hp},schema:{}})
  const messages = Array.from({length:8},(_x,index)=>({role:'assistant',turn:index+1,swipeId:0,swipes:['正文'],variables:[tree(index)],
    mvuBaseline:{swipeId:0,variables:tree(index+100)}, mvu:{pending:true,delivery:{prepared:{id:'pending-'+index}}} }))
  messages[1].swipes.push('历史另一版本'); messages[1].variables.push(tree(11))
  messages[7].swipeId=1; messages[7].swipes.push('另一版本'); messages[7].variables.push(tree(70))
  messages.push({role:'tavern-helper',turn:9,swipeId:0,variables:[tree(999)],swipes:['辅助']})
  await store.update(id,()=>({id,sessionId:'fixture-session',_storageRevision:1,mode:'story',messages}))
  probe = new DatabaseSync(path.join(root,'chats',id,'archive.db'))
  const physical = JSON.parse(probe.prepare('SELECT message_json FROM archive_messages WHERE message_index=1').get().message_json)
  assert.equal(physical.variables,undefined,'K4必须真实修剪变量树')
  assert.equal(physical.mvuBaseline.variables.stat_data.hp,101,'基线不能被结算后快照替代')
  assert.equal(physical.mvu.delivery.prepared.id,'pending-1','未完成投递不能剪')
  store.dispose(); store=createChatSqliteStore({dataRoot:root,helpers})
  const snapshot = store.readCurrentVariableSnapshot({id,_storageRevision:1,messages:[]})
  assert.equal(snapshot.tree.stat_data.hp,70); assert.equal(snapshot.messageIndex,7); assert.equal(snapshot.swipeId,1,'不读helper999')
  assert.equal(store.readCurrentVariableSnapshot({id,_storageRevision:0}),undefined)
  assert.equal(store.readCurrentVariableSnapshot({id,_storageRevision:2}),undefined)
  const lastBody = readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-helper-context.js',import.meta.url),'utf8')
  const selected = lastBody.slice(lastBody.indexOf('function selectedSwipe('),lastBody.indexOf('function normalizeMessageId('))
  const last = lastBody.slice(lastBody.indexOf('export function lastTavernHelperVariables('),lastBody.indexOf('/** How many trailing'))
  const lastVariables = new Function('clone',selected+'\n'+last.replace('export ','')+'\nreturn lastTavernHelperVariables')(clone)
  const reader=createCurrentVariableReader({lastVariables,readSnapshot:chat=>store.readCurrentVariableSnapshot(chat)})
  assert.equal(reader({id,_storageRevision:1,messages:[]}).stat_data.hp,70,'窗口局部数组不能当绝对楼号')
  for(const value of [null,{}]) assert.deepEqual(reader({id,_storageRevision:1,messages:[{variables:[value],swipeId:0}]}),value)
  const full=await store.read(id)
  const ranged=await store.readHelperContext(id,{from:1,to:1,revision:1})
  assert.equal(ranged.context.messages[0].variables.stat_data.hp,1,'R2历史Helper按楼补回')
  const base=await store.readSettlementBase(id)
  assert.equal(base.chat.messages[1].variables[0].stat_data.hp,1)
  assert.equal(base.chat.messages[1].mvuBaseline.variables.stat_data.hp,101,'R1b指定楼基线优先保真')
  let tool
  registerVariableReadTool({tools:{register:value=>{tool=value}},defineTool:value=>value,chatForSession:async()=>({id,_storageRevision:1,mode:'story',messages:[]}),readSnapshot:chat=>store.readCurrentVariableSnapshot(chat)})
  assert.equal((await tool.execute({action:'read',path:'/hp'},{agent:{session:{id:'fixture'}}})).report.value,70,'R1c工具执行兜底')
  const index=applyHostTransform(readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/index.js',import.meta.url),'utf8'))
  assert.ok(index.includes('message:currentVariablesOf(chat) || {}')); assert.ok(index.includes('message: currentVariablesOf(chat)'))
  assert.ok(index.includes('readSnapshot: readCurrentVariableSnapshot')); assert.equal(applyHostTransform(index),index)
  const adapter=applyHelperCurrentTransform(readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8'))
  const transient=adapter.slice(adapter.indexOf("    if (userText !== '') {"),adapter.indexOf('    const projected = selected?.context'))
  const inherited=new Function('options','lastTavernHelperVariables','draft','userText','structuredClone',transient+'\nreturn draft.messages.at(-1)')({currentVariablesOf:reader},lastVariables,{id,_storageRevision:1,messages:[]},'继续',structuredClone)
  assert.equal(inherited.variables[0].stat_data.hp,70,'R1d真实adapter临时用户楼继承兜底')
  // 不是只测首次建库：已有helper快照后再写一轮也不能污染当前态。
  await store.update(id,current=>({...current,_storageRevision:2,messages:[...current.messages,{role:'user',text:'继续'}]}))
  assert.equal(store.variables.snapshot(id).stat_data.hp,70)
  const headOnly={id,_storageRevision:2}
  probe.prepare('UPDATE variable_state SET swipe_id=0 WHERE id=1').run()
  assert.equal(store.readCurrentVariableSnapshot(headOnly),undefined,'身份不符不能借别的swipe')
  probe.prepare('UPDATE variable_state SET swipe_id=1,message_index=8 WHERE id=1').run()
  assert.equal(store.readCurrentVariableSnapshot(headOnly),undefined,'辅助楼来源不能兜底')
  probe.prepare('UPDATE variable_state SET message_index=999 WHERE id=1').run()
  assert.equal(store.readCurrentVariableSnapshot(headOnly),undefined,'已不存在来源不能兜底')
  // 正常回退同事务重新计算state，旧revision不补；幸存冷楼仍有结算前baseline/delivery。
  await store.update(id,current=>({...current,_storageRevision:3,messages:current.messages.slice(0,2)}))
  store.dispose(); store=createChatSqliteStore({dataRoot:root,helpers})
  assert.equal(store.readCurrentVariableSnapshot({id,_storageRevision:1}),undefined)
  const rolled=await store.read(id)
  assert.equal(rolled.messages[1].variables[0].stat_data.hp,1)
  assert.equal(rolled.messages[1].mvuBaseline.variables.stat_data.hp,101)
  assert.equal(rolled.messages[1].mvu.delivery.prepared.id,'pending-1')
  assert.equal(store.readCurrentVariableSnapshot({id,_storageRevision:3}).tree.stat_data.hp,1)
  await store.patch(id,3,[{op:'set',path:['messages',1,'swipeId'],value:1},{op:'set',path:['_storageRevision'],value:4}])
  assert.equal(store.readCurrentVariableSnapshot({id,_storageRevision:4}).tree.stat_data.hp,11,'冷楼只改swipe也按本轮选中槽重算state')
  assert.equal(probe.prepare('SELECT swipe_id FROM variable_snapshots WHERE message_index=1 AND selected=1').get().swipe_id,1)
  console.log('current-variable-consumers: R1a/c/d同revision兜底/作者null语义/R1b身份基线/R2历史补数/R3保retry/回退state全部通过')
} finally {
  probe?.close(); store.dispose()
  function cleanOwn(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())cleanOwn(file);else rmSync(file)}rmdirSync(dir)}
  cleanOwn(root)
}
