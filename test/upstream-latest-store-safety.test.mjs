// 最新作者协议的数据安全闸：仅独占临时合成库；真实三代scoped与copy/diff，不调用模型/真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
const shas = ['5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60','9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544','5c69907994df9f432b8898168ce5dff371929c2a']
const modules = await Promise.all(shas.map(async sha => {
  const base = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-' + sha + '/tavern-plugin/lib/domain/', import.meta.url)
  const [copy, mutation, scoped] = await Promise.all(['copy-json-tree.js','json-mutation.js','scoped-messages.js'].map(file => import(new URL(file, base))))
  // 显示投影不在此闸范围，用显式脱离替身；消息复制和patch完全沿作者真实实现。
  const projection = value => value === undefined ? undefined : structuredClone(value)
  return { sha, scoped, helpers: { ...copy, ...mutation, ...scoped, ...Object.fromEntries(['projectSceneImageState','projectChatSessionState','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint'].map(name => [name, projection])) } }
}))
function fixture(t, helpers) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-latest-safety-'))
  const store = createChatSqliteStore({ dataRoot: root, helpers })
  t.after(() => { store.dispose(); assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'tavern-latest-safety-'))); rmSync(root, { recursive: true, force: true }) })
  return { root, store }
}
const seed = id => ({ id, sessionId: 'synthetic-session', mode: 'story', _storageRevision: 1, messages: [
  { role: 'user', turn: 1, text: '合成输入' }, { role: 'assistant', turn: 1, text: '合成正文', variables: [{stat_data:{score:1},schema:{}}] }
] })
async function unchanged(store, id, action) {
  const before = await store.read(id), version = await store.version(id), snap = await store.variables.snapshotAll(id)
  await assert.rejects(action, /局部读取|楼层|完整|空洞/)
  assert.deepEqual(await store.read(id), before)
  assert.equal(await store.version(id), version)
  assert.deepEqual(await store.variables.snapshotAll(id), snap)
}
for (const { sha, scoped, helpers } of modules) {
  test('复制前拒写：三代scoped整档update与结构patch均不改变库 ' + sha.slice(0, 8), async t => {
    const { root, store } = fixture(t, helpers), id = 'synthetic-safety'
    await store.update(id, () => seed(id))
    const partial = () => scoped.createScopedMessages(2, [[1, seed(id).messages[1]]])
    await unchanged(store, id, () => store.update(id, current => ({...current, _storageRevision: 2, messages: partial()})))
    for (const change of [
      {op:'set',path:['messages'],value:partial()},
      {op:'set',path:[],value:{...seed(id),_storageRevision:2,messages:partial()}},
      {op:'splice',path:['messages'],index:0,deleteCount:2,items:partial()}
    ]) await unchanged(store, id, () => store.patch(id, 1, [{op:'set',path:['_storageRevision'],value:2},change]))
    const db = new DatabaseSync(path.join(root, 'chats', id, 'archive.db'))
    try { assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_messages WHERE message_json IS NULL OR message_json=\'null\'').get().n, 0) }
    finally { db.close() }
  })
}
test('完整性守卫：普通稀疏数组/空楼/越界整楼写入均写前拒绝；首写不建空库', async t => {
  const { root, store } = fixture(t, modules.at(-1).helpers), id = 'synthetic-complete'
  const sparse = new Array(2); sparse[1] = seed(id).messages[1]
  await assert.rejects(() => store.update(id, () => ({...seed(id),messages:sparse})), /局部读取|楼层/)
  assert.equal(existsSync(path.join(root,'chats',id,'archive.db')), false)
  await store.update(id, () => seed(id))
  for (const messages of [sparse,[null,seed(id).messages[1]]]) await unchanged(store,id,()=>store.update(id,current=>({...current,_storageRevision:2,messages})))
  for (const change of [{op:'set',path:['messages',0],value:null},{op:'delete',path:['messages',0]},{op:'set',path:['messages',20],value:seed(id).messages[1]}]) {
    await unchanged(store,id,()=>store.patch(id,1,[{op:'set',path:['_storageRevision'],value:2},change]))
  }
})
test('合法header/局部点写保持增量、CAS与assertCurrent；不会因scoped拒写禁用局部协议', async t => {
  const { store } = fixture(t,modules.at(-1).helpers),id='synthetic-patch'
  await store.update(id,()=>seed(id))
  let asserted=0
  const changes=[{op:'set',path:['_storageRevision'],value:2},{op:'set',path:['messages',1,'text'],value:'合法点写'}]
  const head=await store.patch(id,1,changes,{assertCurrent:()=>asserted++})
  assert.equal(head._storageRevision,2); assert.equal(asserted,1)
  assert.equal((await store.read(id)).messages[1].text,'合法点写')
  assert.equal(await store.patch(id,1,changes),undefined)
  await assert.rejects(()=>store.patch(id,2,[{op:'set',path:['_storageRevision'],value:3},{op:'set',path:['title'],value:'不得提交'}],{assertCurrent:()=>{throw Error('synthetic-identity-changed')}}),/synthetic-identity-changed/)
  assert.equal((await store.read(id))._storageRevision,2)
})
