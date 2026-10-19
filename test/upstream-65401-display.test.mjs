// 固定最新酒馆源夹具；只验证新增iframe诊断SQL适配/接缝，不模型、不真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { buildCore } from '../deploy/standard-seam-transforms.mjs'
import { maintenanceTargets, maintenanceReadSources, prepareStandardSeams, writePreparedStandardSeams } from '../deploy/standard-seams.mjs'
import { applyDisplayRuntimeTransform } from '../deploy/display-runtime-transform.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { activeSource } from './fixtures/comment-author-tree.mjs'
import { snapshotDatabase, inspectDatabase } from '../lib/db-save-codec.js'
const ROOT = fileURLToPath(new URL('../../../tmp/adapt-65401-pr17/dsh-tavern-65401c0f67465acd3988f65e6c33881c40189dd0/', import.meta.url))
const domain = pathToFileURL(path.join(ROOT, 'tavern-plugin/lib/domain/')).href
const require = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context) } catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/adapt-65401-pr17/') || specifier.startsWith('.') || specifier.startsWith('node:')) throw e
  return next(pathToFileURL(require.resolve(specifier)).href, context)
} } })
const [copy, mutation, projections, receipt, persistenceModule] = await Promise.all(['copy-json-tree.js', 'json-mutation.js', 'chat-session-state.js', 'display-runtime-store.js', 'chat-persistence.js'].map(name => import(domain + name)))
const helpers = { ...copy, ...mutation, ...projections }
const text = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')
function owned(t, prefix, beforeCleanup = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => { beforeCleanup(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith(prefix)); fs.rmSync(root, { recursive: true, force: true }) })
  return root
}
async function fixture(t, count = 2) {
  let store
  const root = owned(t, 'sqv2-display-65401-', () => store?.dispose())
  store = createChatSqliteStore({ dataRoot: root, helpers })
  const messages = Array.from({ length: count }, (_, i) => ({ role: 'assistant', turn: i + 1, text: 'body-' + i, variables: [{ stat_data: { hp: i }, schema: {} }] }))
  await store.update('chat-a', () => ({ id: 'chat-a', sessionId: 'session-a', mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1, _storageRevision: 1, messages }))
  const persistence = persistenceModule.createChatPersistence({ store, normalize: value => value, now: Date.now })
  const raw = applyDisplayRuntimeTransform(text('tavern-plugin/lib/index.js'))
  const body = raw.slice(raw.indexOf('  function cleanRuntimeUrl('), raw.indexOf('  const tavernScriptHostAdapter ='))
  const capture = vm.runInNewContext(`(function(){${body};return captureDisplayRuntime})()`, {
    str: v => String(v ?? ''), groupOfMode: () => 'play', readSessionMap: async () => ({ 'session-a': 'chat-a' }),
    chatPersistence: persistence, chatForSession: () => persistence.read('chat-a'), projectDisplayRuntimeState: projections.projectDisplayRuntimeState,
    patchChat: (...args) => persistence.patch(...args), displayRuntimeStore: store.displayRuntime, displayRuntimeReceipt: receipt.displayRuntimeReceipt,
    Date, Math, Object, Array, Number, JSON,
  })
  return { root, store, persistence, capture }
}

test('65401接缝：最新作者构建、注释装卸、诊断SQL接线完整', t => {
  const sources = new Map([...maintenanceTargets, ...maintenanceReadSources].filter(rel => fs.existsSync(path.join(ROOT, rel))).map(rel => [rel, text(rel)]))
  const writes = buildCore(ROOT, sources)
  const index = writes.get('tavern-plugin/lib/index.js')
  assert.match(index, /chatJournalStore\.displayRuntime\.mergeFrame/)
  assert.match(index, /if \(!await displayRuntimeStore\.mergeFrame/)
  assert.equal(applyDisplayRuntimeTransform(index), index)
  assert.throws(() => applyDisplayRuntimeTransform(text('tavern-plugin/lib/index.js').replace('reset: !receipt, sourceActivityAt', 'reset: false, sourceActivityAt')), /锚点缺失或重复/)
  for (const value of writes.values()) parse(value, { ecmaVersion: 'latest', sourceType: 'module' })
  const app = owned(t, 'sqv2-seams-65401-')
  for (const rel of [...sources.keys(), 'tavern-plugin/package.json']) { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), text(rel), 'utf8') }
  writePreparedStandardSeams(prepareStandardSeams({ appDir: app, operation: 'install' }))
  const installed = fs.readFileSync(path.join(app, 'tavern-plugin/lib/index.js'), 'utf8')
  assert.match(activeSource(installed), /chatJournalStore\.displayRuntime\.mergeFrame/)
  assert.equal(prepareStandardSeams({ appDir: app, operation: 'install' }).changes.length, 0)
  writePreparedStandardSeams(prepareStandardSeams({ appDir: app, operation: 'uninstall' }))
  assert.equal(fs.readFileSync(path.join(app, 'tavern-plugin/lib/index.js'), 'utf8'), sources.get('tavern-plugin/lib/index.js'))
})

test('65401采集：真实capture重绘不推revision、并发面板不丢、旧行内收缩', async t => {
  const { root, store, persistence, capture } = await fixture(t)
  await Promise.all([capture('session-a', 2, 0, { panelId: 'a', dom: 'A' }), capture('session-a', 2, 1, { panelId: 'b', dom: 'B' })])
  assert.deepEqual(store.displayRuntime.read('chat-a', 2).frames.map(f => f.panelId), ['a', 'b'])
  const first = (await store.read('chat-a'))._storageRevision
  for (let i = 0; i < 3; i++) await capture('session-a', 2, 0, { panelId: 'a', dom: 'paint-' + i })
  assert.equal((await store.read('chat-a'))._storageRevision, first)
  assert.equal(store.displayRuntime.read('chat-a', 2).frames[0].dom, 'paint-2')
  const saved = await store.read('chat-a')
  assert.equal(saved.messages[1].displayRuntime.version, 2)
  assert.equal(saved.messages[1].displayRuntime.frames[0].dom, undefined)
  await capture('session-a', 2, 0, { panelId: 'a', dom: '', mvuViewUsed: true })
  assert.equal((await store.read('chat-a'))._storageRevision, first + 1)
  const before = await store.read('chat-a')
  await persistence.patch('chat-a', before._storageRevision, [{ op: 'set', path: ['messages', 0, 'displayRuntime'], value: { version: 1, frames: [{ partIndex: 0, panelId: 'old', dom: 'legacy' }] } }])
  await capture('session-a', 1, 1, { panelId: 'new', dom: 'fresh' })
  assert.deepEqual(store.displayRuntime.read('chat-a', 1).frames.map(f => f.panelId), ['old', 'new'])
  assert.equal((await store.read('chat-a')).messages[0].displayRuntime.frames[0].dom, undefined)
  assert.equal(fs.existsSync(path.join(root, 'display-runtime')), false, '不落外置JSON')
  const db = new DatabaseSync(path.join(root, 'chats/chat-a/archive.db'))
  try { assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM archive_display_frames').get().n), 4) } finally { db.close() }
})

test('65401诊断读桥：保作者Promise catch合同和同档方法透传', async () => {
  const wired = applyDisplayRuntimeTransform(text('tavern-plugin/lib/index.js'))
  const begin = wired.indexOf('  const displayRuntimeStore = Object.freeze({'), end = wired.indexOf('\n  })', begin) + 5
  const calls = []
  const store = vm.runInNewContext('(function(){' + wired.slice(begin, end) + ';return displayRuntimeStore})()', { chatJournalStore: { displayRuntime: {
    read: (...args) => { calls.push(['read', ...args]); return { frames: [] } }, recent: (...args) => { calls.push(['recent', ...args]); return {} },
    mergeFrame: (...args) => { calls.push(['merge', ...args]); return true }, remove: (...args) => { calls.push(['remove', ...args]); return undefined },
  } } })
  await store.read('chat-a', 2).catch(() => { throw Error('读桥意外失败') })
  await store.recent('chat-a').catch(() => { throw Error('recent桥意外失败') })
  store.mergeFrame('chat-a', 2, { panelId: 'a' }, { revision: 7 }); store.remove('chat-a')
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['read', 'chat-a', 2], ['recent', 'chat-a'], ['merge', 'chat-a', 2], ['remove', 'chat-a']])
})

test('65401交换：本机导出剥离诊断、外来触发器仍拒绝且不改源', async t => {
  const { root, store, capture } = await fixture(t)
  await capture('session-a', 2, 0, { panelId: 'status', dom: 'not-portable' })
  const source = path.join(root, 'chats/chat-a/archive.db'), output = path.join(root, 'portable.db')
  assert.throws(() => inspectDatabase(source, 'archive'), /未知或虚拟表|不允许的视图\/触发器/, '外来库不能用自有名字放行触发器')
  snapshotDatabase(source, output, 'archive')
  const portable = inspectDatabase(output, 'archive')
  assert.equal(portable.head.messages[1].displayRuntime.version, 2)
  assert.equal(Object.hasOwn(portable.tables, 'archive_display_frames'), false, '诊断不进可移植剧情库')
  assert.equal(store.displayRuntime.read('chat-a', 2).frames[0].dom, 'not-portable', '导出不删除源诊断')
  const db = new DatabaseSync(source)
  try {
    db.exec('DROP TRIGGER archive_display_delete; CREATE TRIGGER archive_display_delete AFTER DELETE ON archive_messages BEGIN DELETE FROM archive_messages; END;')
  } finally { db.close() }
  assert.throws(() => snapshotDatabase(source, path.join(root, 'rejected.db'), 'archive'), /本机诊断schema不兼容/, '自有名字不能冒充精确清理触发器')
})

test('65401诊断：物理尾清理、正文换代、CAS迟到拒写与20轮预算', async t => {
  const { store, persistence } = await fixture(t, 22)
  const revision = (await store.read('chat-a'))._storageRevision
  const frame = { partIndex: 0, panelId: 'status', dom: 'evidence' }
  for (let turn = 1; turn <= 22; turn++) await store.displayRuntime.mergeFrame('chat-a', turn, frame, { revision, messageIndex: turn - 1 })
  assert.equal(Object.keys(store.displayRuntime.recent('chat-a')).length, 20)
  assert.equal(store.displayRuntime.read('chat-a', 2), undefined)
  await persistence.patch('chat-a', revision, [{ op: 'splice', path: ['messages'], index: 21, deleteCount: 1, items: [] }])
  assert.equal(store.displayRuntime.read('chat-a', 22), undefined)
  await assert.rejects(store.displayRuntime.mergeFrame('chat-a', 22, frame, { revision, messageIndex: 21 }), /目标已变化/)
  assert.equal(await store.displayRuntime.mergeFrame('chat-a', 21, frame, { revision, messageIndex: 20 }), false, '旧CAS不能覆盖保留楼')
  const next = (await store.read('chat-a'))._storageRevision
  await persistence.patch('chat-a', next, [{ op: 'set', path: ['messages', 20, 'text'], value: 'regenerated' }])
  assert.equal(store.displayRuntime.read('chat-a', 21), undefined)
  const current = (await store.read('chat-a'))._storageRevision
  await assert.rejects(store.displayRuntime.mergeFrame('chat-a', 20, frame, { revision: current, messageIndex: 20 }), /目标已变化/)
})
