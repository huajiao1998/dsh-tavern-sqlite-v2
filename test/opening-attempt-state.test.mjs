// 二状态使用真实作者openPicker/discardOpening/store/lifecycle；外部SDK/RPC为原创隔离契约，不等于页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { applyOpeningAttemptStateTransform, OPENING_ATTEMPT_STATE_MARKER, OPENING_ATTEMPT_STORE_MARKER } from '../deploy/opening-attempt-state-transform.mjs'
import { applyStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { prepareCommentAuthorTree, commentAuthorTreeSource, activeSource } from './fixtures/comment-author-tree.mjs'

const authorRoot = commentAuthorTreeSource()
assert.ok(authorRoot, '必须使用真实作者客户端')
const SIDEBAR = 'tavern-plugin/src/client/features/sidebar.js', RUNTIME = 'tavern-plugin/src/client/runtime/conversation-lifecycle.js', BUNDLE = 'tavern-plugin/lib/client.js'
const originalSidebar = readFileSync(path.join(authorRoot, SIDEBAR), 'utf8'), originalRuntime = readFileSync(path.join(authorRoot, RUNTIME), 'utf8')
const { createConversationAttemptStore, createConversationLifecycleModule, createConversationHostAdapter } = new Function(applyOpeningAttemptStateTransform(originalRuntime) + '\nreturn {createConversationAttemptStore,createConversationLifecycleModule,createConversationHostAdapter};')()
const request = { kind: 'play', targetMode: 'story', card: { path: 'synthetic-card-a' }, openingId: 'opening-a', userName: '你', requestMode: 'dsh' }
const keyFor = value => JSON.stringify([value.kind, value.targetMode, value.card && value.card.path, value.openingId, value.userName, value.requestMode, value.task, value.pending])
const key = keyFor(request), otherPlay = keyFor({ ...request, card: { path: 'synthetic-card-b' } }), workbench = keyFor({ ...request, kind: 'card', targetMode: 'card' })
function storageFixture() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function functionText(source, name) {
  const found = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(source.slice(node.start, node.end))
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }))
  assert.equal(found.length, 1, '真实消费者必须唯一：' + name)
  return found[0]
}
function sidebarHarness(source, attempts, { openingPicker = null, uiMode = 'play', busy = false, confirm = true } = {}) {
  const calls = [], bindings = {
    startAttemptsRef: { current: attempts }, openingPicker, uiMode, busy,
    setMenuSession: () => {}, setCardEntry: () => {}, setRequestMode: mode => calls.push('requestMode:' + mode), setError: () => {},
    setPicking: () => {}, setCards: () => {}, tavernErrorHub: { resolve: () => {}, report: error => { throw error } },
    call: async method => { calls.push(method); return {} }, askConfirm: async () => { calls.push('confirm'); return confirm },
    playPrewarmRef: { current: { cancel: () => calls.push('cancelPrewarm') } },
    setChatImport: () => calls.push('clearImport'), setOpeningPicker: () => calls.push('clearPicker')
  }
  const load = name => new Function(...Object.keys(bindings), functionText(source, name) + ';return ' + name + ';')(...Object.values(bindings))
  return { calls, openPicker: load('openPicker'), discardOpening: load('discardOpening') }
}
function startHarness(attempts, { failOpen = false } = {}) {
  const calls = []
  const host = createConversationHostAdapter({ remote: { agentPresets: { select: async (id, preset) => { calls.push('preset:' + id + ':' + preset); return { ok: true } } } },
    sessions: { create: async ({ workspaceId }) => { calls.push('create:' + workspaceId); return 'session-fresh' } },
    uiWorkspace: { connectWorkspace: () => { throw Error('新开局不允许复用工作区旧Session') } }
  })
  return { calls, module: createConversationLifecycleModule({ attempts, archiveCurrent: async () => {}, resolveWorkspace: async () => 'workspace-synthetic', connectWorkspace: host.connectWorkspace,
    waitForSession: async id => { calls.push('wait:' + id) }, ensurePreset: host.ensurePreset,
    createChat: async (_request, id) => { calls.push('startChat:' + id) }, rememberPending: () => {},
    finishOpen: async pending => { calls.push('open:' + pending.sessionId); if (failOpen) throw Error('原创打开失败') }
  }) }
}

test('开局二状态正式接线：新开无条件清旧游玩记录，刷新后相同选项新Session且不搜历史', async t => {
  const tree = prepareCommentAuthorTree(); assert.ok(tree); t.after(tree.cleanup)
  applyStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
  const sources = new Map([SIDEBAR, RUNTIME, BUNDLE].map(rel => [rel, activeSource(readFileSync(path.join(tree.appDir, rel), 'utf8'), rel)]))
  assert.ok(sources.get(RUNTIME).includes(OPENING_ATTEMPT_STORE_MARKER))
  assert.ok(sources.get(SIDEBAR).includes(OPENING_ATTEMPT_STATE_MARKER))
  for (const name of ['openPicker', 'discardOpening']) assert.equal(functionText(sources.get(SIDEBAR), name), functionText(sources.get(BUNDLE), name))
  assert.equal(functionText(sources.get(RUNTIME), 'createConversationAttemptStore'), functionText(sources.get(BUNDLE), 'createConversationAttemptStore'))
  const storage = storageFixture(), makeStore = new Function(functionText(sources.get(BUNDLE), 'createConversationAttemptStore') + ';return createConversationAttemptStore;')()
  let attempts = makeStore(storage)
  attempts.set(key, { sessionId: 'session-stale-before-update', initialized: false })
  attempts.set(otherPlay, { sessionId: 'session-stale-other-play', initialized: true })
  attempts.set(workbench, { sessionId: 'session-workbench', initialized: false })
  storage.setItem('unrelated-setting', '保留')
  const view = sidebarHarness(sources.get(BUNDLE), attempts)
  view.openPicker(); await Promise.resolve()
  assert.equal(attempts.get(key), undefined); assert.equal(attempts.get(otherPlay), undefined)
  assert.equal(attempts.get(workbench).sessionId, 'session-workbench'); assert.equal(storage.getItem('unrelated-setting'), '保留')
  attempts = makeStore(storage)
  assert.equal(attempts.get(key), undefined); assert.equal(attempts.get(otherPlay), undefined)
  const fresh = startHarness(attempts), result = await fresh.module.start(request)
  assert.equal(result.sessionId, 'session-fresh')
  assert.deepEqual(fresh.calls, ['create:workspace-synthetic', 'wait:session-fresh', 'preset:session-fresh:tavern', 'startChat:session-fresh', 'open:session-fresh'])
  uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
  for (const rel of [SIDEBAR, RUNTIME, BUNDLE]) assert.equal(readFileSync(path.join(tree.appDir, rel), 'utf8'), tree.original.get(rel))
})

test('开局二状态继续：暂时收起后继续保留同次Session，失败后再开不重复创建或写入开场', async () => {
  const storage = storageFixture(), attempts = createConversationAttemptStore(storage)
  const first = startHarness(attempts, { failOpen: true })
  await assert.rejects(first.module.start(request), /原创打开失败/)
  assert.equal(attempts.get(key).sessionId, 'session-fresh'); assert.equal(attempts.get(key).initialized, true)
  const view = sidebarHarness(applyOpeningAttemptStateTransform(originalSidebar), attempts, { openingPicker: { card: request.card, requestMode: 'dsh' } })
  view.openPicker(); await Promise.resolve()
  assert.equal(attempts.get(key).sessionId, 'session-fresh')
  const afterRefresh = createConversationAttemptStore(storage), retry = startHarness(afterRefresh), result = await retry.module.start(request)
  assert.equal(result.sessionId, 'session-fresh')
  assert.deepEqual(retry.calls, ['wait:session-fresh', 'open:session-fresh'])
  assert.equal(afterRefresh.get(key), undefined)
})

test('开局二状态放弃：确认后只清当前卡含不同选项，跨刷新不复用且不删除服务器会话', async () => {
  const storage = storageFixture(), attempts = createConversationAttemptStore(storage), variant = keyFor({ ...request, openingId: 'opening-b', userName: '原创玩家' })
  for (const [candidate, id] of [[key, 'session-stale'], [variant, 'session-variant'], [otherPlay, 'session-other'], [workbench, 'session-workbench']]) attempts.set(candidate, { sessionId: id, initialized: false })
  const view = sidebarHarness(applyOpeningAttemptStateTransform(originalSidebar), attempts, { openingPicker: { card: request.card, preparationId: 'preview-synthetic' } })
  await view.discardOpening()
  assert.deepEqual(view.calls, ['confirm', 'cancelPrewarm', 'clearImport', 'clearPicker', 'releaseOpeningPreparation'])
  assert.equal(attempts.get(key), undefined); assert.equal(attempts.get(variant), undefined)
  assert.equal(attempts.get(otherPlay).sessionId, 'session-other'); assert.equal(attempts.get(workbench).sessionId, 'session-workbench')
  const afterRefresh = createConversationAttemptStore(storage)
  assert.equal(afterRefresh.get(key), undefined); assert.equal(afterRefresh.get(variant), undefined)
  const fresh = startHarness(afterRefresh), result = await fresh.module.start(request)
  assert.equal(result.sessionId, 'session-fresh'); assert.equal(fresh.calls[0], 'create:workspace-synthetic')
})

test('开局二状态护栏：拒绝放弃或忙碌不清记录，卡片模式不清游玩记录', async () => {
  const storage = storageFixture(), attempts = createConversationAttemptStore(storage), source = applyOpeningAttemptStateTransform(originalSidebar)
  attempts.set(key, { sessionId: 'session-pending', initialized: false })
  const declined = sidebarHarness(source, attempts, { openingPicker: { card: request.card }, confirm: false })
  await declined.discardOpening(); assert.deepEqual(declined.calls, ['confirm']); assert.ok(attempts.get(key))
  const busy = sidebarHarness(source, attempts, { openingPicker: { card: request.card }, busy: true })
  await busy.discardOpening(); assert.deepEqual(busy.calls, []); assert.ok(attempts.get(key))
  const card = sidebarHarness(source, attempts, { uiMode: 'card' })
  card.openPicker(); await Promise.resolve(); assert.equal(attempts.get(key).sessionId, 'session-pending')
})

test('开局二状态接缝合同：source和bundle幂等，锚点缺失重复半截拒绝，旧代无能力不改', () => {
  for (const source of [originalRuntime, originalSidebar, readFileSync(path.join(authorRoot, BUNDLE), 'utf8')]) {
    const next = applyOpeningAttemptStateTransform(source)
    assert.equal(applyOpeningAttemptStateTransform(next), next)
  }
  const anchor = '\t\t\tfunction openPicker() {'
  assert.throws(() => applyOpeningAttemptStateTransform(originalSidebar.replace(anchor, '')), /缺失\/重复/)
  assert.throws(() => applyOpeningAttemptStateTransform(originalSidebar.replace(anchor, anchor + '\n' + anchor)), /缺失\/重复/)
  assert.throws(() => applyOpeningAttemptStateTransform(applyOpeningAttemptStateTransform(originalRuntime).replace('this.delete(key);', '')), /实现不完整/)
  const old = 'function legacyPicker() {}'
  assert.equal(applyOpeningAttemptStateTransform(old), old)
})
