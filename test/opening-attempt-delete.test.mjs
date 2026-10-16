// 实际作者删除函数/持久attempt/lifecycle/预设adapter＋正式施缝；仅SDK/RPC边界用原创控制器契约，不宣称现场开场成功。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { applyOpeningAttemptDeleteTransform, OPENING_ATTEMPT_DELETE_MARKER } from '../deploy/opening-attempt-delete-transform.mjs'
import { applyStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { prepareCommentAuthorTree, commentAuthorTreeSource, activeSource } from './fixtures/comment-author-tree.mjs'

const authorRoot = commentAuthorTreeSource()
assert.ok(authorRoot, '需要真实作者客户端源码，不使用替身lifecycle')
const SOURCE = 'tavern-plugin/src/client/features/sidebar.js', BUNDLE = 'tavern-plugin/lib/client.js'
const lifecycle = readFileSync(path.join(authorRoot, 'tavern-plugin/src/client/runtime/conversation-lifecycle.js'), 'utf8')
const { createConversationAttemptStore, createConversationLifecycleModule, createConversationHostAdapter } = new Function(lifecycle + '\nreturn {createConversationAttemptStore,createConversationLifecycleModule,createConversationHostAdapter}')()
const request = { kind: 'play', targetMode: 'story', card: { path: 'original-fixture-card' }, openingId: 'opening-fixture', userName: '你', requestMode: 'dsh' }
const keyFor = value => JSON.stringify([value.kind, value.targetMode, value.card && value.card.path, value.openingId, value.userName, value.requestMode, value.task, value.pending])
function storageFixture() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function deleteFunction(source) {
  const found = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'deleteConversation') found.push(source.slice(node.start, node.end))
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }))
  assert.equal(found.length, 1, '必须使用真实唯一侧栏删除消费者')
  return found[0]
}
function deleteHarness(source, attempts, { deleteError } = {}) {
  const calls = [], errors = []
  const deleteConversation = new Function('startAttemptsRef', 'props', 'call', 'askConfirm', 'setMenuSession', 'setBusy', 'setError', 'current', 'history', 'uiMode', 'requestMode', 'refresh', 'isMissingSessionArchiveError',
    deleteFunction(source) + ';return deleteConversation;')(
    { current: attempts }, { archiveSession: async id => { calls.push('archive:' + id) } },
    async (method, args) => {
      calls.push(method + ':' + (args.chatId || args.chatIds[0]))
      if (method === 'prepareDeleteChats') return { results: [{ ok: true }] }
      assert.equal(method, 'deleteChat')
      if (deleteError) throw deleteError
    }, async () => true, () => {}, () => {}, message => { if (message) errors.push(message) }, '', [], 'play', 'dsh', async () => { calls.push('refresh') }, () => false)
  return { deleteConversation, calls, errors }
}
function startHarness(attempts) {
  const calls = [], remote = { agentPresets: { select: async (id, preset) => {
    calls.push('preset:' + id + ':' + preset)
    return id === 'session-old-failed' ? { ok: false, error: { message: 'session "session-old-failed" has already started; its agent preset is fixed' } } : { ok: true }
  } } }
  const host = createConversationHostAdapter({ remote, sessions: { create: async ({ workspaceId }) => { calls.push('create:' + workspaceId); return 'session-new-fixture' } } })
  return { calls, module: createConversationLifecycleModule({ attempts,
    archiveCurrent: async () => {}, resolveWorkspace: async () => 'workspace-fixture', connectWorkspace: host.connectWorkspace,
    waitForSession: async id => { calls.push('wait:' + id) }, ensurePreset: host.ensurePreset,
    createChat: async (_request, id) => { calls.push('startChat:' + id) }, rememberPending: () => {}, finishOpen: async pending => { calls.push('open:' + pending.sessionId) }
  }) }
}

test('开局删除正式接线：旧删除复现复用失败，删除清当前attempt后刷新新建并按预设开场顺序完成', async t => {
  const tree = prepareCommentAuthorTree(); assert.ok(tree); t.after(tree.cleanup)
  const storage = storageFixture(), key = keyFor(request), otherKey = 'other-pending-fixture'
  let attempts = createConversationAttemptStore(storage)
  attempts.set(key, { sessionId: 'session-old-failed', initialized: false })
  attempts.set(otherKey, { sessionId: 'session-other', initialized: false })
  const old = deleteHarness(readFileSync(path.join(authorRoot, SOURCE), 'utf8'), attempts)
  await old.deleteConversation({ sessionId: 'session-old-failed', chatId: 'chat-fixture' }, '原创测试开局')
  assert.equal(attempts.get(key).sessionId, 'session-old-failed', '旧消费者删除后仍留下浏览器attempt')
  const stuck = startHarness(attempts)
  await assert.rejects(stuck.module.start(request), error => error.phase === '切换到酒馆模式' && /agent preset is fixed/.test(error.message))
  assert.deepEqual(stuck.calls, ['wait:session-old-failed', 'preset:session-old-failed:tavern'])

  applyStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
  const source = activeSource(readFileSync(path.join(tree.appDir, SOURCE), 'utf8'), SOURCE)
  const bundle = activeSource(readFileSync(path.join(tree.appDir, BUNDLE), 'utf8'), BUNDLE)
  assert.ok(source.includes(OPENING_ATTEMPT_DELETE_MARKER)); assert.ok(bundle.includes(OPENING_ATTEMPT_DELETE_MARKER))
  assert.equal(deleteFunction(source), deleteFunction(bundle), 'source与实际bundle必须执行同一清理')
  const installed = deleteHarness(bundle, attempts)
  await installed.deleteConversation({ sessionId: 'session-old-failed', chatId: 'chat-fixture' }, '原创测试开局')
  assert.deepEqual(installed.calls, ['prepareDeleteChats:chat-fixture', 'archive:session-old-failed', 'deleteChat:chat-fixture', 'refresh'])
  assert.deepEqual(installed.errors, [])
  assert.equal(attempts.get(key), undefined, '内存旧attempt已清')
  assert.equal(attempts.get(otherKey).sessionId, 'session-other', '不能影响其他待开局')
  attempts = createConversationAttemptStore(storage)
  assert.equal(attempts.get(key), undefined, '跨刷新旧attempt也已清')
  assert.equal(attempts.get(otherKey).sessionId, 'session-other')
  const fresh = startHarness(attempts), result = await fresh.module.start(request)
  assert.equal(result.sessionId, 'session-new-fixture')
  assert.deepEqual(fresh.calls, ['create:workspace-fixture', 'wait:session-new-fixture', 'preset:session-new-fixture:tavern', 'startChat:session-new-fixture', 'open:session-new-fixture'])
  assert.equal(attempts.get(key), undefined)
  uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
  for (const rel of [SOURCE, BUNDLE]) assert.equal(readFileSync(path.join(tree.appDir, rel), 'utf8'), tree.original.get(rel), '正式卸载只恢复作者现场原文')
})

test('开局删除失败护栏：deleteChat失败不清内存或持久attempt，不掩盖原错误', async () => {
  const storage = storageFixture(), attempts = createConversationAttemptStore(storage), key = keyFor(request)
  attempts.set(key, { sessionId: 'session-old-failed', initialized: false })
  const source = applyOpeningAttemptDeleteTransform(readFileSync(path.join(authorRoot, SOURCE), 'utf8'))
  const failed = deleteHarness(source, attempts, { deleteError: Error('原创删除失败') })
  await failed.deleteConversation({ sessionId: 'session-old-failed', chatId: 'chat-fixture' }, '原创测试开局')
  assert.deepEqual(failed.errors, ['原创删除失败'])
  assert.equal(failed.calls.includes('refresh'), false)
  assert.equal(attempts.get(key).sessionId, 'session-old-failed')
  assert.equal(createConversationAttemptStore(storage).get(key).sessionId, 'session-old-failed')
})

test('开局删除接缝合同：完整幂等、缺失重复和半截实现拒绝，旧代不造不存在的能力', () => {
  const source = readFileSync(path.join(authorRoot, SOURCE), 'utf8'), next = applyOpeningAttemptDeleteTransform(source)
  assert.equal(applyOpeningAttemptDeleteTransform(next), next)
  const anchor = '\t\t\t\t\tawait call("deleteChat", { chatId: item.chatId });'
  assert.throws(() => applyOpeningAttemptDeleteTransform(source.replace(anchor, '')), /缺失\/重复/)
  assert.throws(() => applyOpeningAttemptDeleteTransform(source.replace(anchor, anchor + '\n' + anchor)), /缺失\/重复/)
  assert.throws(() => applyOpeningAttemptDeleteTransform(next.replace('startAttemptsRef.current.complete(item.sessionId);', '')), /实现不完整/)
  const old = 'async function deleteConversation() { await call("deleteChat", {}); }'
  assert.equal(applyOpeningAttemptDeleteTransform(old), old)
})
