// 合成数据库；不依赖作者工作区或真实玩家存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { createVariableArchive } from '../lib/variable-archive.js'
import { setMessageFloor as setFloorCommand } from '../lib/chat-command-service.js'

// 只实现本套件使用的 update 行差量和 patch set/delete；投影不参与断言。
const helpers = {
  copyJsonTree: structuredClone,
  diffJson(before, after) {
    if (!before) return [{ op: 'set', path: [], value: after }]
    const changes = []
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (key === 'messages') continue
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(Object.hasOwn(after, key)
        ? { op: 'set', path: [key], value: after[key] } : { op: 'delete', path: [key] })
    }
    if (!Array.isArray(before.messages) && !Array.isArray(after.messages)) return changes
    assert.equal(before.messages.length, after.messages.length, '本夹具 update 不修改数组长度')
    after.messages.forEach((row, index) => {
      if (JSON.stringify(before.messages[index]) !== JSON.stringify(row)) changes.push({ op: 'set', path: ['messages', index], value: row })
    })
    return changes
  },
  applyJsonChangesShared(value, changes) {
    let next = structuredClone(value)
    for (const change of changes) {
      if (change.path.length === 0) { next = structuredClone(change.value); continue }
      let parent = next
      for (const key of change.path.slice(0, -1)) { assert.ok(parent && Object.hasOwn(parent, key)); parent = parent[key] }
      const key = change.path.at(-1)
      if (change.op === 'splice') parent[key].splice(change.index, change.deleteCount, ...(structuredClone(change.items ?? [])))
      else if (change.op === 'delete') delete parent[key]
      else { assert.equal(change.op, 'set'); parent[key] = structuredClone(change.value) }
    }
    return next
  },
}
for (const key of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[key] = structuredClone
const seed = id => ({
  id, sessionId: 'session-' + id, _storageRevision: 1,
  timeline: { schemaVersion: 1, branchId: 'main', revision: 0, operations: {}, checkpoints: [], participants: {} },
  messages: Array.from({ length: 8 }, (_, index) => ({
    role: 'assistant', turn: index, text: 'floor-' + index, swipeId: 0, swipes: ['settled', 'pending'],
    variables: [{ stat_data: { floor: index }, schema: {} }, { pending: true }],
    mvu: { delivery: { obsolete: 'remove me' } },
  })),
})
async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'sqv2-store-regressions-'))
  let store = createChatSqliteStore({ dataRoot: root, helpers })
  t.after(() => { store.dispose(); rmSync(root, { recursive: true, force: true }) })
  const reopen = () => { store.dispose(); store = createChatSqliteStore({ dataRoot: root, helpers }); return store }
  const id = 'chat-test'
  await store.update(id, () => seed(id))
  return { id, get store() { return store }, reopen }
}
const set = (index, leaf, value) => ({ op: 'set', path: ['messages', index, ...leaf], value })

for (const entry of ['patch','update','setMessageFloor']) test('B20-B23修复：真实协议冷楼深写与首次撤销 ' + entry, async t => {
  const protocol=await import('../../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b/tavern-plugin/lib/domain/json-mutation.js')
  const {captureRollbackBusinessState,restoreRollbackBusinessState}=await import('../lib/rollback-business-state.js')
  const root=mkdtempSync(path.join(tmpdir(),'sqv2-full-undo-'))
  const make=()=>createChatSqliteStore({dataRoot:root,helpers:{...helpers,...protocol}})
  let store=make();t.after(()=>{store.dispose();rmSync(root,{recursive:true,force:true})})
  const id='chat-cold-undo';await store.update(id,()=>seed(id))
  const initial=await store.read(id),expected=structuredClone(initial.messages[1])
  initial.timeline.operations.body8={id:'body8',kind:'body',status:'running',turn:8,businessBefore:captureRollbackBusinessState(initial)}
  initial._storageRevision=2;await store.update(id,()=>initial)
  const db=new DatabaseSync(store.rollbackArchivePath(id))
  try{assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT message_json FROM archive_messages WHERE message_index=1').get().message_json),'variables'),false)}finally{db.close()}
  const metadata={source:'tavern-helper.variables'}
  async function write(revision,value,remove=false){
    if(entry==='update')return store.update(id,draft=>{if(remove)delete draft.messages[1].variables;else draft.messages[1].variables[0].stat_data.floor=value;draft._storageRevision=revision+1;return draft},metadata)
    const changes=[remove?{op:'delete',path:['messages',1,'variables']}:set(1,['variables',0,'stat_data','floor'],value)]
    if(entry==='patch')return store.patch(id,revision,[...changes,{op:'set',path:['_storageRevision'],value:revision+1}],metadata)
    return store.setMessageFloor(id,revision,1,{changes},metadata)
  }
  await write(2,101);await write(3,202)
  assert.equal((await store.read(id)).messages[1].variables[0].stat_data.floor,202)
  await write(4,null,true)
  store.dispose();store=make()
  const written=await store.read(id),baseline=written.timeline.operations.body8.businessBefore
  assert.equal(written.messages[1].variables,undefined,'删除不被旧快照复活')
  assert.deepEqual(baseline.messagePreimages[1],expected,'重复写仍保留完整首次旧值和全部swipe')
  restoreRollbackBusinessState(written,baseline);written._storageRevision++
  await store.update(id,()=>written,{source:'rollback.prepare'})
  store.dispose();store=make()
  assert.deepEqual((await store.read(id)).messages[1],expected,'真实回退恢复消费者写回后冷开仍完整')
})

test('B23异步护栏：callback已返回但提交前失效，变量和前像同事务零写',async t=>{
 const f=await fixture(t),{captureRollbackBusinessState}=await import('../lib/rollback-business-state.js')
 const initial=await f.store.read(f.id);initial.timeline.operations.body8={kind:'body',turn:8,businessBefore:captureRollbackBusinessState(initial)};initial._storageRevision=2
 await f.store.update(f.id,()=>initial)
 await assert.rejects(f.store.update(f.id,async draft=>{await Promise.resolve();draft.messages[1].variables[0].stat_data.floor=999;draft._storageRevision++;return draft},{source:'tavern-helper.variables',assertCurrent:()=>{throw Error('运行已失效')}}),/运行已失效/)
 const saved=await f.reopen().read(f.id);assert.equal(saved._storageRevision,2);assert.equal(saved.messages[1].variables[0].stat_data.floor,1);assert.equal(saved.timeline.operations.body8.businessBefore.messagePreimages,undefined)
})

for(const entry of ['patch','update'])for(const mode of ['unowned','failure'])test('B23通用护栏：'+entry+' '+mode+' 不污染首次旧值或快照',async t=>{
 const f=await fixture(t),{captureRollbackBusinessState}=await import('../lib/rollback-business-state.js')
 const initial=await f.store.read(f.id)
 initial.timeline.operations.body8={kind:'body',turn:8,status:'running',businessBefore:captureRollbackBusinessState(initial)}
 initial._storageRevision=2;await f.store.update(f.id,()=>initial)
 const metadata={source:mode==='unowned'?'configuration.edit':'tavern-helper.variables'}
 if(mode==='failure'){const db=new DatabaseSync(f.store.rollbackArchivePath(f.id));try{db.exec("CREATE TRIGGER reject_generic BEFORE INSERT ON archive_messages WHEN NEW.message_index=1 BEGIN SELECT RAISE(ABORT,'generic failed'); END")}finally{db.close()}}
 const write=()=>entry==='patch'?f.store.patch(f.id,2,[set(1,['variables'],[{stat_data:{floor:99},schema:{}}]),{op:'set',path:['_storageRevision'],value:3}],metadata):f.store.update(f.id,draft=>{draft.messages[1].variables=[{stat_data:{floor:99},schema:{}}];draft._storageRevision++;return draft},metadata)
 if(mode==='failure')await assert.rejects(write,/generic failed/);else await write()
 const saved=await f.reopen().read(f.id)
 assert.equal(saved._storageRevision,mode==='failure'?2:3);assert.equal(saved.messages[1].variables[0].stat_data.floor,mode==='failure'?1:99)
 assert.equal(saved.timeline.operations.body8.businessBefore.messagePreimages,undefined)
})
for(const entry of ['patch','setMessageFloor'])test('B20父路径护栏：'+entry+' 不虚构真实缺失父容器',async t=>{
 const f=await fixture(t),changes=[set(1,['variables',0,'stat_data','missing','leaf'],1)]
 await assert.rejects(entry==='patch'?f.store.patch(f.id,1,[...changes,{op:'set',path:['_storageRevision'],value:2}]):f.store.setMessageFloor(f.id,1,1,{changes}))
 const current=await f.reopen().read(f.id);assert.equal(current._storageRevision,1);assert.deepEqual(current.messages[1].variables[0].stat_data,{floor:1})
})

for (const selected of [0, 1, 2, 3]) test('B21: history APIs agree for null/missing/selected swipe ' + selected, async t => {
  const f = await fixture(t)
  await f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['swipes'], ['A','B','C','D']),
    set(7, ['variables'], [null, {stat_data:{tag:'B'},schema:{}}, {stat_data:{tag:'C'},schema:{}}]), set(7, ['swipeId'], selected)] })
  for (let attempt=0; attempt<2; attempt++) {
    const store = attempt ? f.reopen() : f.store
    assert.equal(store.variables.snapshotAt(f.id,7).stat_data.tag, selected === 2 ? 'C' : 'B')
    assert.deepEqual(store.variables.snapshotAt(f.id,7), store.variables.snapshotAll(f.id).get(7))
  }
})

const splice = (index, deleteCount, items=[]) => ({op:'splice',path:['messages'],index,deleteCount,items})
test('PR19 merge: splice keeps shared undefined normalization on hydrated rows', async t => {
  const f = await fixture(t)
  await f.store.patch(f.id,1,[splice(1,1),set(1,['variables'],undefined),{op:'set',path:['_storageRevision'],value:2}])
  const chat=await f.reopen().read(f.id)
  assert.equal(chat.messages[1].text,'floor-2')
  assert.equal(Object.hasOwn(chat.messages[1],'variables'),false)
  assert.equal(chat.messages[2].variables[0].stat_data.floor,3)
})
for (const mode of ['delete-cold','insert-empty','multiple','tail','rollback']) test('B22: splice preserves variable identity: ' + mode, async t => {
  const f = await fixture(t)
  const before = await f.store.read(f.id)
  const edits = mode === 'insert-empty' ? [splice(1,0,[{role:'user',turn:100,text:'inserted'}])]
    : mode === 'multiple' ? [splice(1,1),splice(2,0,[{role:'user',turn:100,text:'inserted'}]),splice(5,1)]
    : mode === 'tail' ? [splice(7,1)] : [splice(1,1)]
  const expected = helpers.applyJsonChangesShared(before,edits)
  const changes = [...edits,{op:'set',path:['_storageRevision'],value:2}]
  if (mode === 'rollback') {
    const db = new DatabaseSync(f.store.rollbackArchivePath(f.id))
    try { db.exec("CREATE TRIGGER fail_splice BEFORE INSERT ON archive_messages WHEN NEW.message_index=2 BEGIN SELECT RAISE(ABORT,'splice failed'); END") }
    finally { db.close() }
    await assert.rejects(f.store.patch(f.id,1,changes),/splice failed/)
    assert.deepEqual((await f.reopen().read(f.id)).messages,before.messages)
  } else {
    await f.store.patch(f.id,1,changes)
    assert.deepEqual((await f.reopen().read(f.id)).messages,expected.messages)
  }
})

for (const mode of ['floor', 'patch']) for (const index of [1, 7]) test(`B16: ${mode} deletes variables on floor ${index} durably`, async t => {
  const f = await fixture(t)
  const change = { op: 'delete', path: ['messages', index, 'variables'] }
  if (mode === 'floor') await f.store.setMessageFloor(f.id, 1, index, { changes: [change] })
  else await f.store.patch(f.id, 1, [change, { op: 'set', path: ['_storageRevision'], value: 2 }])
  const cold = f.reopen()
  assert.equal(Object.hasOwn((await cold.read(f.id)).messages[index], 'variables'), false)
  assert.equal(cold.variables.snapshotAt(f.id, index), undefined)
  assert.equal(cold.variables.snapshot(f.id).stat_data.floor, index === 7 ? 6 : 7)
  assert.equal((await cold.read(f.id)).messages[2].variables[0].stat_data.floor, 2)
})

test('B16: delete followed by replacement keeps the final variables', async t => {
  const f = await fixture(t)
  await f.store.setMessageFloor(f.id, 1, 7, { changes: [
    { op: 'delete', path: ['messages', 7, 'variables'] },
    set(7, ['variables'], [{ stat_data: { floor: 77 }, schema: {} }]),
  ] })
  assert.equal(f.reopen().variables.snapshot(f.id).stat_data.floor, 77)
})

test('B16: a rejected deletion rolls back snapshots and current state', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.store.rollbackArchivePath(f.id))
  try {
    db.exec("CREATE TRIGGER reject_delete BEFORE INSERT ON archive_messages WHEN NEW.message_index=7 BEGIN SELECT RAISE(ABORT,'reject deletion'); END")
    await assert.rejects(f.store.setMessageFloor(f.id, 1, 7, { changes: [
      { op: 'delete', path: ['messages', 7, 'variables'] },
    ] }), /reject deletion/)
    assert.equal(f.store.variables.snapshotAt(f.id, 7).stat_data.floor, 7)
    assert.equal(f.reopen().variables.snapshot(f.id).stat_data.floor, 7)
  } finally { db.close() }
})

test('B17: editing one hot floor does not rewrite archived cold floors', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.store.rollbackArchivePath(f.id))
  try {
    db.exec(`CREATE TABLE audit_counts(kind TEXT, idx INTEGER);
      CREATE TRIGGER count_messages AFTER UPDATE ON archive_messages BEGIN INSERT INTO audit_counts VALUES('message',NEW.message_index); END;
      CREATE TRIGGER count_snapshots AFTER UPDATE ON variable_snapshots BEGIN INSERT INTO audit_counts VALUES('snapshot',NEW.message_index); END;`)
    await f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['text'], 'edited')] })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_counts WHERE idx!=7').get().n, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_counts WHERE kind='message'").get().n, 1)
    assert.equal((await f.reopen().read(f.id)).messages[1].variables[0].stat_data.floor, 1)
  } finally { db.close() }
})

test('B18: deleting every snapshot leaves no current tree, including after reopen', async t => {
  const f = await fixture(t)
  await f.store.update(f.id, chat => ({ ...chat, _storageRevision: 2,
    messages: chat.messages.map(row => ({ ...row, turn: row.turn + 1 })) }))
  assert.equal(f.store.variables.deleteFrom(f.id, 1).state, false)
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = attempt === 0 ? f.store : f.reopen()
    assert.equal(store.variables.has(f.id), false)
    assert.equal(store.variables.snapshot(f.id), undefined)
    assert.equal(store.variables.snapshotAll(f.id).size, 0)
    assert.equal(store.variables.snapshotAt(f.id, 8), undefined)
  }
})

test('B19: partial hot caches preserve latest-floor precedence within one turn', async t => {
  const f = await fixture(t)
  await f.store.setMessageFloor(f.id, 1, 1, { changes: [set(1, ['turn'], 7)] })
  f.reopen()
  await f.store.setMessageFloor(f.id, 2, 1, { changes: [set(1, ['variables'], [{ stat_data: { floor: 101 }, schema: {} }])] })
  assert.equal(f.store.variables.snapshotAt(f.id, 7).stat_data.floor, 7)
  assert.equal(f.store.variables.snapshotAll(f.id).get(7).stat_data.floor, 7)
  assert.equal(f.reopen().variables.snapshotAt(f.id, 7).stat_data.floor, 7)
})

for (const command of ['appendMessages', 'setMessageFloor']) test('B10: ' + command + ' rejects chat ID header writes before committing', async t => {
  const f = await fixture(t)
  const invoke = headerSets => command === 'appendMessages'
    ? f.store.appendMessages(f.id, 1, { items: [{ role: 'assistant', turn: 8, text: 'new' }], headerSets })
    : f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['text'], 'new')], headerSets })
  for (const id of ['chat-other', undefined]) await assert.rejects(invoke({ id }), /id|身份/)
  const original = await f.reopen().read(f.id)
  assert.equal(original.id, f.id); assert.equal(original._storageRevision, 1); assert.equal(original.messages.length, 8)
  assert.equal(original.messages[7].text, 'floor-7')
  const result = await invoke({ title: 'valid header' })
  assert.equal(result.revision, 2); assert.equal((await f.reopen().read(f.id)).title, 'valid header')
})

for (const mode of ['helper', 'pending-swipe', 'full-helper']) test('B12: current variables recover after ' + mode, async t => {
  const f = await fixture(t)
  assert.equal(f.store.variables.snapshot(f.id).stat_data.floor, 7)
  if (mode === 'full-helper') await f.store.update(f.id, chat => ({
    ...chat, _storageRevision: 2, messages: chat.messages.map((row, index) => index === 7 ? { ...row, role: 'tavern-helper' } : row),
  }))
  else await f.store.setMessageFloor(f.id, 1, 7, { changes: [mode === 'helper' ? set(7, ['role'], 'tavern-helper') : set(7, ['swipeId'], 1)] })
  assert.equal(f.store.variables.snapshot(f.id).stat_data.floor, 6)
  assert.equal(f.reopen().variables.snapshot(f.id).stat_data.floor, 6)
  // 更改较早楼不能把未触碰的较新当前树退回去。
  await f.store.setMessageFloor(f.id, 2, 5, { changes: [set(5, ['text'], 'earlier edit')] })
  assert.equal(f.store.variables.snapshot(f.id).stat_data.floor, 6)
})

test('B12: removing the only eligible current tree clears state', async t => {
  const f = await fixture(t)
  await f.store.update(f.id, chat => ({ ...chat, _storageRevision: 2, messages: chat.messages.map(row => ({ ...row, role: 'tavern-helper' })) }))
  assert.equal(f.store.variables.snapshot(f.id), undefined)
  assert.equal(f.reopen().variables.snapshot(f.id), undefined)
})

test('B12: a cold helper becoming eligible can become the current tree', async t => {
  const f = await fixture(t)
  await f.store.update(f.id, chat => ({ ...chat, _storageRevision: 2, messages: chat.messages.map((row, index) => index === 0 ? row : { ...row, role: 'tavern-helper' }) }))
  assert.equal(f.reopen().variables.snapshot(f.id).stat_data.floor, 0)
  await f.store.setMessageFloor(f.id, 2, 1, { changes: [set(1, ['role'], 'assistant')] })
  assert.equal(f.store.variables.snapshot(f.id).stat_data.floor, 1)
  assert.equal(f.reopen().variables.snapshot(f.id).stat_data.floor, 1)
})

test('B13: a failed single-floor write clears uncommitted variable caches', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.store.rollbackArchivePath(f.id))
  try { db.exec("CREATE TRIGGER audit_fail BEFORE INSERT ON archive_messages WHEN NEW.message_index=7 BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END") } finally { db.close() }
  await assert.rejects(f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['variables', 0, 'stat_data', 'floor'], 70)] }), /synthetic write failure/)
  assert.equal(f.store.variables.snapshotAt(f.id, 7).stat_data.floor, 7)
  assert.equal(f.store.variables.snapshot(f.id).stat_data.floor, 7)
  assert.equal((await f.store.read(f.id))._storageRevision, 1)
  assert.equal(f.reopen().variables.snapshotAt(f.id, 7).stat_data.floor, 7)
  const clean = new DatabaseSync(f.store.rollbackArchivePath(f.id))
  try { clean.exec('DROP TRIGGER audit_fail') } finally { clean.close() }
  await f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['variables', 0, 'stat_data', 'floor'], 71)] })
  assert.equal(f.store.variables.snapshot(f.id).stat_data.floor, 71)
})

test('B14: single-floor changes preserve object replacement and ordered operations', async t => {
  const f = await fixture(t), value = { version: 1, taskId: 'new-task' }
  await f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['mvu', 'delivery'], value)] })
  assert.deepEqual((await f.reopen().read(f.id)).messages[7].mvu.delivery, value)
  await f.store.setMessageFloor(f.id, 2, 7, { changes: [set(7, ['mvu', 'delivery'], null)] })
  await f.store.setMessageFloor(f.id, 3, 7, { changes: [set(7, ['mvu', 'delivery'], {}), set(7, ['mvu', 'delivery', 'version'], 2)] })
  assert.deepEqual((await f.store.read(f.id)).messages[7].mvu.delivery, { version: 2 })
  await f.store.setMessageFloor(f.id, 4, 7, { changes: [{ op: 'delete', path: ['messages', 7, 'mvu', 'delivery'] }, set(7, ['mvu', 'delivery'], {})] })
  assert.deepEqual((await f.reopen().read(f.id)).messages[7].mvu.delivery, {})
})

test('B14: direct changes retain undefined, array and invalid-path boundaries', async t => {
  const f = await fixture(t)
  await f.store.setMessageFloor(f.id, 1, 7, { changes: [set(7, ['mvu', 'delivery', 'obsolete'], undefined), set(7, ['variables', 1], undefined)] })
  const row = (await f.store.read(f.id)).messages[7]
  assert.deepEqual(row.mvu.delivery, {}); assert.equal(row.variables[1], null)
  for (const change of [set(7, ['__proto__', 'polluted'], true), set(7, ['mvu', 'missing', 'deep'], 1), { op: 'splice', path: ['messages', 7, 'swipes'], index: 0, deleteCount: 1, items: [] }]) {
    await assert.rejects(f.store.setMessageFloor(f.id, 2, 7, { changes: [change] }))
  }
  assert.equal((await f.reopen().read(f.id))._storageRevision, 2)
  assert.equal({}.polluted, undefined)
})

test('B14: command patch compatibility and empty JSON keys remain supported', async t => {
  const f = await fixture(t)
  const db = new DatabaseSync(f.store.rollbackArchivePath(f.id)), archive = createVariableArchive({ handle: () => db })
  try {
    const result = setFloorCommand(db, { chatId: f.id, revision: 1, index: 7, patch: { text: 'legacy patch' } }, {
      archiveLocalWrite: (...args) => archive.prepareLocalWrite(...args),
    })
    assert.equal(result.revision, 2)
  } finally { archive.dispose(); db.close() }
  assert.equal((await f.reopen().read(f.id)).messages[7].text, 'legacy patch')
  await f.store.setMessageFloor(f.id, 2, 7, { changes: [set(7, ['mvu', 'delivery'], { '': 1 }), set(7, ['mvu', 'delivery', ''], 2)] })
  assert.deepEqual((await f.reopen().read(f.id)).messages[7].mvu.delivery, { '': 2 })
})

for (const command of ['setMessageFloor', 'patch']) test('B15: ' + command + ' synchronizes cold snapshot turn metadata', async t => {
  const f = await fixture(t), db = new DatabaseSync(f.store.rollbackArchivePath(f.id))
  try { assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT message_json FROM archive_messages WHERE message_index=1').get().message_json), 'variables'), false) } finally { db.close() }
  const changes = [set(1, ['turn'], 101)]
  if (command === 'patch') await f.store.patch(f.id, 1, [...changes, { op: 'set', path: ['_storageRevision'], value: 2 }])
  else await f.store.setMessageFloor(f.id, 1, 1, { changes })
  assert.equal(f.store.variables.snapshotAt(f.id, 1), undefined)
  assert.equal(f.store.variables.snapshotAt(f.id, 101).stat_data.floor, 1)
  assert.equal(f.reopen().variables.snapshotAt(f.id, 101).stat_data.floor, 1)
  assert.equal((await f.store.read(f.id)).messages[1].turn, 101)
})

for (const index of [1,7]) for (const mode of ['replace','delete','twice','unowned','failure']) test(`B23: durable undo for ${mode} on floor ${index}`, async t => {
  const f = await fixture(t)
  const {captureRollbackBusinessState,restoreRollbackBusinessState} = await import('../lib/rollback-business-state.js')
  const initial=await f.store.read(f.id)
  initial.timeline.operations.body8={id:'body8',kind:'body',status:'running',turn:8,businessBefore:captureRollbackBusinessState(initial)}
  initial._storageRevision=2
  await f.store.update(f.id,()=>initial)
  const changes=[mode==='delete'?{op:'delete',path:['messages',index,'variables']}:set(index,['variables'],[{stat_data:{floor:101},schema:{}}])]
  const metadata={source:mode==='unowned'?'configuration.edit':'tavern-helper.test'}
  if(mode==='failure') {
    const db=new DatabaseSync(f.store.rollbackArchivePath(f.id))
    try { db.exec(`CREATE TRIGGER reject_undo BEFORE INSERT ON archive_messages WHEN NEW.message_index=${index} BEGIN SELECT RAISE(ABORT,'undo failed'); END`) }
    finally {db.close()}
    await assert.rejects(f.store.setMessageFloor(f.id,2,index,{changes},metadata),/undo failed/)
    const cold=await f.reopen().read(f.id)
    assert.equal(cold.messages[index].variables[0].stat_data.floor,index)
    assert.equal(cold.timeline.operations.body8.businessBefore.messagePreimages,undefined)
    return
  }
  await f.store.setMessageFloor(f.id,2,index,{changes},metadata)
  if(mode==='twice') await f.store.setMessageFloor(f.id,3,index,{changes:[set(index,['variables'],[{stat_data:{floor:202},schema:{}}])]},metadata)
  const written=await f.reopen().read(f.id)
  const baseline=written.timeline.operations.body8.businessBefore
  if(mode==='unowned') {assert.equal(baseline.messagePreimages,undefined);return}
  assert.equal(baseline.messagePreimages[index].variables[0].stat_data.floor,index)
  const restored=restoreRollbackBusinessState(structuredClone(written),baseline)
  restored._storageRevision=written._storageRevision+1
  await f.store.update(f.id,()=>restored)
  assert.equal((await f.reopen().read(f.id)).messages[index].variables[0].stat_data.floor,index)
})
