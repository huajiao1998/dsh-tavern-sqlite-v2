// 真实作者初始化→registry/persistence→合成SQLite，复现flush期间版本推进；不读真实档、不调用模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { prepareCommentAuthorTree, commentAuthorTreeSource, activeSource } from './fixtures/comment-author-tree.mjs'
import { applyStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { applyOpeningCommitTransform, applyOpeningCommitHostTransform } from '../deploy/opening-commit-transform.mjs'

const authorRoot = commentAuthorTreeSource()
assert.ok(authorRoot, '必须有真实作者源码，不能用替身初始化器')
const domain = pathToFileURL(path.join(authorRoot, 'tavern-plugin/lib/domain/'))
const testRequire = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.startsWith(pathToFileURL(authorRoot).href) || specifier.startsWith('.') || specifier.startsWith('node:')) throw error
    return next(pathToFileURL(testRequire.resolve(specifier)).href, context)
  }
} })
const [copy, mutation, persistence, registry, timeline] = await Promise.all(
  ['copy-json-tree.js', 'json-mutation.js', 'chat-persistence.js', 'tavern-conversation-registry.js', 'story-timeline.js'].map(name => import(new URL(name, domain)))
)
const loadInitialization = async source => {
  const guardImport = "import { legacyViewSeams, isReadOnlySession } from './legacy-view-seams.js'"
  // 只替代原件访问边界：合成库没有原件，若调用只读会话检查仍明确失败。
  source = source.replace(guardImport, "const legacyViewSeams={assertWritable:()=>{},readOnlyChat:()=>false};const isReadOnlySession=()=>{throw Error('本闸不读原件')}")
  source = source.replace(/from '(\.[^']+)'/g, (_, specifier) => 'from ' + JSON.stringify(new URL(specifier, domain).href))
  return (await import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))).createConversationInitialization
}
async function fixture(t, { installed = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opening-baseline-commit-'))
  const helpers = { ...copy, ...mutation }
  for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[name] = () => { throw Error('本闸不使用显示投影') }
  const store = createChatSqliteStore({ dataRoot: root, helpers }), records = persistence.createChatPersistence({ store, now: () => 10 })
  let tree
  t.after(() => {
    store.dispose(); tree?.cleanup()
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('opening-baseline-commit-'))
    rmSync(root, { recursive: true, force: true })
  })
  let initializationSource = readFileSync(new URL('conversation-initialization.js', domain), 'utf8')
  if (installed) {
    tree = prepareCommentAuthorTree(); assert.ok(tree)
    applyStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
    const rel = 'tavern-plugin/lib/domain/conversation-initialization.js'
    initializationSource = activeSource(readFileSync(path.join(tree.appDir, rel), 'utf8'), rel)
    const host = activeSource(readFileSync(path.join(tree.appDir, 'tavern-plugin/lib/index.js'), 'utf8'))
    assert.ok(host.includes('publish: conversationRegistry.publish, write: writeChat, writeHeader: writeChatHeader'), '真实初始化facade必须暴露字段保存接口')
  }
  const createInitialization = await loadInitialization(initializationSource)
  let links = {}, index = { chats: [] }, seq = 0, beforeFlush, beforeEnsure, flushCount = 0, markerHeader = 0, markerFull = 0
  const conversationRegistry = registry.createTavernConversationRegistry({ store: {
    readLinks: async () => structuredClone(links), updateLinks: async mutate => { links = (await mutate(structuredClone(links))) ?? links },
    readIndex: async () => structuredClone(index), writeIndex: async value => { index = structuredClone(value) },
    readChat: records.read, writeChat: records.write, removeChat: records.remove
  } })
  const session = { id: 'session-synthetic-opening', events: [], append(type, data) { this.events.push({ seq: this.events.length + 1, type, data }) } }
  const card = { path: 'synthetic-card', name: '原创角色', first_mes: '原创开场白' }
  const initialization = createInitialization({
    cards: { read: async () => card, readChat: async () => card, script: async () => undefined, extensions: async () => ({}) },
    chats: { resolve: conversationRegistry.resolve, publish: conversationRegistry.publish,
      write: (...args) => { if (args[1]?.source === 'opening.native-append') markerFull++; return records.write(...args) },
      writeHeader: (...args) => { markerHeader++; return records.writeHeader(...args) } },
    timeline: timeline.createStoryTimeline({ id: prefix => prefix + '-' + (++seq), now: () => 10 }),
    snapshots: { prepare: async chat => { chat.cardContextSnapshot = '原创卡片快照' }, ensure: async chat => { await beforeEnsure?.(chat); return chat.cardContextSnapshot } },
    presets: { fullSnapshot: async () => ({}) }, settings: async () => ({}), emptyCardWorkspace: () => ({}),
    id: prefix => prefix + '-synthetic-opening', now: () => 10,
    native: { wait: async () => ({ session, agent: { phase: { kind: 'idle' } } }), ensurePrefix: async () => {},
      flush: async () => { flushCount++; await beforeFlush?.(flushCount) } }, present: async chat => structuredClone(chat)
  })
  const start = () => initialization.start({ cardPath: card.path, sessionId: session.id, mode: 'story' })
  return { store, records, session, start, initialization, tree, beforeFlush: fn => { beforeFlush = fn }, beforeEnsure: fn => { beforeEnsure = fn },
    counts: () => ({ markerHeader, markerFull }), id: 'chat-synthetic-opening' }
}

test('开场基线旧路径复现：flush推进无关字段后整档标记写入确实报baseline', async t => {
  const f = await fixture(t)
  f.beforeFlush(async count => { if (count === 2) await f.records.update(f.id, chat => ({ ...chat, statusBarPlacement: 'bottom' })) })
  await assert.rejects(f.start, error => error.code === 'DSH_TAVERN_CHAT_CONFLICT' && error.path === '<baseline>')
  assert.equal((await f.records.read(f.id)).nativeOpeningAppended, undefined)
  assert.equal(f.session.events.filter(event => event.type === 'assistant/message' && event.data.message.id.startsWith('tavern-opening:')).length, 1)
})

test('开场基线正式接线：flush推进字段和正文后只保存header且保新态，重入不重复开场', async t => {
  const f = await fixture(t, { installed: true })
  f.beforeFlush(async count => {
    if (count === 2) await f.records.update(f.id, chat => ({ ...chat, statusBarPlacement: 'bottom',
      messages: chat.messages.map(message => ({ ...message, displayRuntime: { synthetic: true } })) }))
  })
  const result = await f.start(), saved = await f.records.read(f.id)
  assert.equal(result.nativeOpeningAppended, true); assert.equal(saved.nativeOpeningAppended, true)
  assert.equal(result.statusBarPlacement, 'bottom'); assert.deepEqual(result.messages, saved.messages)
  assert.deepEqual(saved.messages[0].displayRuntime, { synthetic: true }); assert.equal(saved.messages[0].text, '原创开场白')
  assert.deepEqual(f.counts(), { markerHeader: 1, markerFull: 0 })
  await f.initialization.ensureOpening(f.session.id)
  assert.equal(f.session.events.filter(event => event.type === 'assistant/message' && event.data.message.id.startsWith('tavern-opening:')).length, 1)
  assert.deepEqual(f.counts(), { markerHeader: 1, markerFull: 0 })
  const rel = 'tavern-plugin/lib/domain/conversation-initialization.js'
  uninstallStandardSeams({ appDir: f.tree.appDir, assertStopped: () => true })
  assert.equal(readFileSync(path.join(f.tree.appDir, rel), 'utf8'), f.tree.original.get(rel), '卸载须恢复现场作者原文，不残留新接缝')
})

test('开场字段提交护栏：同字段冲突不覆盖，失败后重入只补标记不重复原生开场', async t => {
  const f = await fixture(t, { installed: true })
  f.beforeEnsure(chat => { chat.cardContextSnapshot = '本次异步准备值' })
  f.beforeFlush(async count => { if (count === 2) await f.records.update(f.id, chat => ({ ...chat, cardContextSnapshot: '另一写入者已提交值' })) })
  await assert.rejects(f.start, error => error.code === 'DSH_TAVERN_CHAT_CONFLICT' && error.path === 'cardContextSnapshot')
  const failed = await f.records.read(f.id)
  assert.equal(failed.nativeOpeningAppended, undefined); assert.equal(failed.cardContextSnapshot, '另一写入者已提交值')
  f.beforeEnsure(undefined); f.beforeFlush(undefined)
  await f.initialization.ensureOpening(f.session.id)
  const recovered = await f.records.read(f.id)
  assert.equal(recovered.nativeOpeningAppended, true); assert.equal(recovered.cardContextSnapshot, '另一写入者已提交值')
  assert.equal(f.session.events.filter(event => event.type === 'assistant/message' && event.data.message.id.startsWith('tavern-opening:')).length, 1)
})

test('开场字段提交护栏：原生flush失败不发布标记，重入从既有开场恢复', async t => {
  const f = await fixture(t, { installed: true })
  f.beforeFlush(count => { if (count === 2) throw Error('合成原生flush失败') })
  await assert.rejects(f.start, /合成原生flush失败/)
  assert.equal((await f.records.read(f.id)).nativeOpeningAppended, undefined)
  assert.deepEqual(f.counts(), { markerHeader: 0, markerFull: 0 })
  f.beforeFlush(undefined)
  const recovered = await f.initialization.ensureOpening(f.session.id)
  assert.equal(recovered.nativeOpeningAppended, true)
  assert.equal(f.session.events.filter(event => event.type === 'assistant/message' && event.data.message.id.startsWith('tavern-opening:')).length, 1)
})

test('开场字段提交护栏：flush期间会话换绑则拒绝标记且不覆盖新身份', async t => {
  const f = await fixture(t, { installed: true })
  f.beforeFlush(async count => { if (count === 2) await f.records.update(f.id, chat => ({ ...chat, sessionId: 'session-synthetic-rebound' })) })
  await assert.rejects(f.start, error => error.code === 'DSH_TAVERN_CHAT_CONFLICT' && error.path === 'sessionId')
  const saved = await f.records.read(f.id)
  assert.equal(saved.nativeOpeningAppended, undefined); assert.equal(saved.sessionId, 'session-synthetic-rebound')
})

test('开场字段接缝合同：锚点唯一与实现完整性拒绝猜测，二次转换幂等', () => {
  const original = readFileSync(new URL('conversation-initialization.js', domain), 'utf8')
  const installed = applyOpeningCommitTransform(original)
  assert.equal(applyOpeningCommitTransform(installed), installed)
  const write = "    const saved = await chats.write(draft, { source: 'opening.native-append' })\n    const committed = saved && typeof saved === 'object' ? saved : draft"
  assert.throws(() => applyOpeningCommitTransform(original.replace(write, write + '\n' + write)), /缺失\/重复/)
  assert.throws(() => applyOpeningCommitTransform(installed.replace('const openingBaseline = captureChatHeader(chat)', 'const openingBaseline = null')), /实现不完整/)
  const host = '    chats: { resolve: chatForSession, publish: conversationRegistry.publish, write: writeChat },'
  assert.ok(applyOpeningCommitHostTransform(host).includes('writeHeader: writeChatHeader'))
  assert.throws(() => applyOpeningCommitHostTransform(host + '\n' + host), /缺失\/重复/)
})
