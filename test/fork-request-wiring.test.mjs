// fork-request 接线：① 真作者 hooks（a2008 lib/hooks/request.js）经真 applyForkRequestTransform 后注册，配**真 rc.2 SessionStore**
// 造官方分叉会话，核"分叉绑定进入 prepare、后台/未绑定/错绑定跳过"；② 变换接缝：旧代兼容、幂等、缺重混合拒绝。
// 只剥 module 语法（import/export）不改逻辑；外部副作用以计次 stub 注入；不读任何档/会话/日志，不伪接口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  applyForkRequestTransform, MARKER, LEGACY_GUARD as LEGACY_ANCHOR, CHAT_DECL as CHAT_DECL_ANCHOR,
  FORK_AWARE_GUARD,
} from '../deploy/fork-request-transform.mjs'

const authorRoot = fileURLToPath(new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/', import.meta.url))
const authorRequest = () => readFileSync(path.join(authorRoot, 'lib/hooks/request.js'), 'utf8')
// 上游 #204（flizzywine/dsh-tavern a390af17，2.7.0）起的新守卫原文：原生分叉也带 parentSession，
// 作者改为只跳过"有亲本且查不到本局 chat"的会话。该提交是 0.4.15 适配目标，随仓保存以便跨机器复现。
const forkAwareRequest = () => readFileSync(fileURLToPath(new URL('./fixtures/author-hooks-request-a390af17.js.txt', import.meta.url)), 'utf8')
const desktopRuntime = process.env.DSH_TAVERN_TEST_DESKTOP_RUNTIME || 'D:/Program Files (x86)/DSH-Tavern/runtime-9be856025c1522cb-setup7-5ae29095747f4f4a9fc3f12a68611fd7/resources/app'
const runtimeRequire = createRequire(path.join(desktopRuntime, 'package.json'))
const loadRuntime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)

/** 真作者 hooks：只剥 module 语法，其余原样求值。 */
function loadAuthorHooks(source, stubs) {
  const script = source.replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const sandbox = { console, ...stubs }
  vm.createContext(sandbox)
  vm.runInContext(script, sandbox)
  assert.equal(typeof sandbox.registerRequestHooks, 'function', '真作者源必须暴露 registerRequestHooks')
  return sandbox
}
/** 真 registerRequestHooks：捕获 ctx.on 的 handler；外部资源计次、不 throw（普通/绑定路径会真经过）。 */
function registerHooks(module, overrides = {}) {
  const handlers = new Map()
  const calls = { prepare: [], template: 0, body: 0, read: 0, recall: 0, next: 0, owned: [] }
  const deps = {
    backgroundAgentRunner: { owns: id => { calls.owned.push(id); return false } },
    cardMemory: { appendRecall: async ({ decision }) => { calls.recall++; return decision } },
    chatForSession: async () => { calls.read++; return null },
    ctx: { on: (name, handler) => handlers.set(name, handler) },
    foregroundStrategies: { prepareStep: async input => { calls.prepare.push(input); return { kind: 'enter', messages: [], prepared: true } } },
    persistClearedBodyEdits: undefined,
    requestCoordinates: { set: () => {} },
    requestIdForMessages: messages => 'req-' + (Array.isArray(messages) ? messages.length : 0),
    sessionStore: { flush: () => {} },
    tavernRetryLimiter: { handle: () => {} },
    ...overrides,
  }
  module.registerRequestHooks(deps)
  const preStep = handlers.get('agent/pre-step')
  assert.equal(typeof preStep, 'function', '必须注册 agent/pre-step')
  const run = (session, extra = {}) => preStep({ agent: { session }, turn: 7, step: 1, messages: [{ id: 'm1' }], ...extra },
    async () => { calls.next++; return { kind: 'enter', messages: [], fromNext: true } })
  return { run, calls, deps }
}
const countingStubs = calls => ({
  synchronizeTemplateHistory: async () => { calls.template++ },
  synchronizeBodyEdits: async () => { calls.body++ },
  lastRoundVariableChanges: () => '',
})

test('fork请求真注册：官方分叉绑定进入prepare，后台/未绑定/错绑定跳过', async t => {
  const { Context } = await loadRuntime('@deepseek-ai/cordis')
  const { SessionStore } = await loadRuntime('@deepseek-ai/dsh-session')
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  const store = new SessionStore(ctx)
  const parent = store.create('synthetic-parent')
  parent.append('turn/start', { turn: 1 })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const child = store.fork(parent, parent.snapshotEvents().at(-1).seq, 'synthetic-child')
  assert.equal(child.header?.parentSession, parent.id, '官方 fork 子会话 header 必须带 parentSession')
  const childSession = { id: child.id, header: child.header }
  const rawSource = authorRequest()
  const wiredSource = applyForkRequestTransform(rawSource)

  // 反证：未施缝旧代源对分叉会话一律跳过（即使 chat 绑定正确）
  const rawHooks = registerHooks(loadAuthorHooks(rawSource, countingStubs({})), { chatForSession: async () => ({ id: 'synthetic-chat', sessionId: child.id, mode: 'story' }) })
  await rawHooks.run(childSession)
  assert.equal(rawHooks.calls.prepare.length, 0, '旧代源：分叉会话不得进入 prepareStep')

  // 正例：真变换后，官方分叉 + 正确绑定 ⇒ 进入 prepare，同步/读取/post 齐备
  const boundChat = { id: 'synthetic-chat', sessionId: child.id, mode: 'story' }
  const wiredCounts = { template: 0, body: 0, read: 0 }
  const wired = registerHooks(loadAuthorHooks(wiredSource, countingStubs(wiredCounts)), {
    chatForSession: async () => { wiredCounts.read++; return boundChat },
  })
  const decision = await wired.run(childSession)
  assert.equal(wired.calls.prepare.length, 1, '分叉且绑定正确的会话必须进入 prepareStep')
  assert.equal(wired.calls.prepare[0].payload.turn, 7, 'prepareStep 必须收到本轮 turn')
  assert.equal(wired.calls.prepare[0].chat, boundChat, 'prepareStep 必须收到真实绑定的 chat')
  assert.equal(wiredCounts.read, 1, '绑定读取恰一次')
  assert.equal(wiredCounts.template, 1, '绑定路径必须真的经过 template 同步')
  assert.equal(wiredCounts.body, 1, '绑定路径必须真的经过 body 同步')
  assert.equal(wired.calls.recall, 1, 'post 必须交给 cardMemory.appendRecall')
  assert.equal(decision.fromNext === undefined, true, '返回必须是 post 结果，而非 next 原值')

  // 普通（无 parentSession）会话：照常进入 prepare
  const ordinary = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { chatForSession: async () => ({ id: 'synthetic-chat', sessionId: 's-top', mode: 'story' }) })
  await ordinary.run({ id: 's-top', header: {} })
  assert.equal(ordinary.calls.prepare.length, 1, '无 parentSession 的顶层会话必须照常 prepare')

  // 后台 owns / 分叉未绑定 / 分叉错绑定：一律跳过
  const bg = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { backgroundAgentRunner: { owns: () => true }, chatForSession: async () => boundChat })
  await bg.run(childSession)
  assert.equal(bg.calls.prepare.length, 0, 'backgroundAgentRunner.owns 必须跳过')
  const unbound = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { chatForSession: async () => null })
  await unbound.run(childSession)
  assert.equal(unbound.calls.prepare.length, 0, '分叉会话未绑定 chat 必须跳过')
  const mismatched = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { chatForSession: async () => ({ id: 'synthetic-chat', sessionId: 'other-session', mode: 'story' }) })
  await mismatched.run(childSession)
  assert.equal(mismatched.calls.prepare.length, 0, '分叉会话绑定到别的 session 必须跳过')
})

test('fork请求接缝：旧代兼容、幂等与缺重混合拒绝', () => {
  for (const [name, value] of [['MARKER', MARKER], ['LEGACY_ANCHOR', LEGACY_ANCHOR], ['CHAT_DECL_ANCHOR', CHAT_DECL_ANCHOR]]) {
    assert.equal(typeof value, 'string', name + ' 必须是导出字符串锚点')
    assert.ok(value.length > 0, name + ' 不得为空')
  }
  const raw = authorRequest()
  const guard = 'if (backgroundAgentRunner.owns(sessionId) || payload.agent.session.header?.parentSession) return next()'
  assert.ok(raw.includes(guard), '前置：真作者源必须含现行 guard')
  const legacyOnly = raw.replace(' || payload.agent.session.header?.parentSession', '')
  assert.ok(legacyOnly.includes('if (backgroundAgentRunner.owns(sessionId)) return next()'), '前置：旧代 only-owns 形态')
  assert.equal(applyForkRequestTransform(legacyOnly), legacyOnly, '旧代 only-owns 必须原样返回（兼容不猜改）')
  const marked = applyForkRequestTransform(raw)
  assert.notEqual(marked, raw, '真作者源必须被实际施缝')
  assert.ok(marked.includes(MARKER), '施缝产物必须含最新标记')
  assert.equal(applyForkRequestTransform(marked), marked, 'new 形态必须幂等')
  const negative = label => assert.throws(() => applyForkRequestTransform(label.source), /锚点|标记|拒绝|不唯一|缺失/, label.name)
  negative({ name: 'guard 被外改（缺锚点）', source: raw.replace(guard, 'if (false) return next()') })
  negative({ name: 'CHAT_DECL 锚点缺失', source: marked.replace(CHAT_DECL_ANCHOR, '') })
  negative({ name: '旧 guard 重复', source: raw + '\n' + guard + '\n' })
  negative({ name: 'marked + 旧 guard 混合', source: marked + '\n' + guard + '\n' })
  negative({ name: '标记重复', source: marked + '\n' + MARKER + '\n' })
})

// 上游 #204 新守卫（a390af17）：锚点从"见 parentSession 即跳过"改成"有亲本且无本局 chat 才跳过"。
// 接缝必须识别两种形态，并把作者判据替换为我方更严的显式绑定判据。
test('fork请求接缝：上游#204新守卫可施缝、幂等且不改安全边界', () => {
  const raw = forkAwareRequest()
  assert.ok(raw.includes(FORK_AWARE_GUARD.trim()), '前置：夹具必须是上游 #204 之后的守卫原文')
  const marked = applyForkRequestTransform(raw)
  assert.notEqual(marked, raw, '新守卫必须被实际施缝')
  assert.ok(marked.includes(MARKER), '施缝产物必须含标记')
  assert.ok(!marked.includes(FORK_AWARE_GUARD.trim()), '作者守卫必须被替换，不得与新判据并存')
  assert.ok(marked.includes('if (parent && !bound) return decision'), '必须保留显式游戏绑定判据')
  assert.equal(applyForkRequestTransform(marked), marked, '新守卫形态必须幂等')
  // 新守卫不得顺带放宽：后台 owns 与未绑定仍必须跳过。
  const negative = label => assert.throws(() => applyForkRequestTransform(label.source), /锚点|标记|拒绝|不唯一|缺失|重复/, label.name)
  negative({ name: '新守卫被外改', source: raw.replace(FORK_AWARE_GUARD, '    if (false) return next()') })
  negative({ name: '新守卫重复', source: raw + '\n' + FORK_AWARE_GUARD + '\n' })
  negative({ name: 'marked + 新守卫混合', source: marked + '\n' + FORK_AWARE_GUARD + '\n' })
})

// 上游 #204 之后：官方分叉 + 本局 chat 绑定 ⇒ 必须进入前台准备（作者已修，我方不得再把它跳过）。
test('fork请求真注册：上游#204源码下官方分叉绑定进入prepare，未绑定/后台仍跳过', async () => {
  const raw = forkAwareRequest()
  const wiredSource = applyForkRequestTransform(raw)
  const boundChat = { id: 'synthetic-chat', sessionId: 'synthetic-child', mode: 'story' }
  const childSession = { id: 'synthetic-child', header: { parentSession: 'synthetic-parent' } }

  // 未施缝的上游源码：分叉且**有**本局 chat 时作者已放行；但查不到 chat 时仍跳过。
  const rawUnbound = registerHooks(loadAuthorHooks(raw, countingStubs({})), { chatForSession: async () => null })
  await rawUnbound.run(childSession)
  assert.equal(rawUnbound.calls.prepare.length, 0, '上游原文：分叉无本局 chat 必须跳过')

  const wired = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { chatForSession: async () => boundChat })
  const decision = await wired.run(childSession)
  assert.equal(wired.calls.prepare.length, 1, '官方分叉且绑定正确必须进入 prepareStep')
  assert.equal(wired.calls.prepare[0].chat, boundChat, 'prepareStep 必须收到真实绑定的 chat')

  const unbound = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { chatForSession: async () => null })
  await unbound.run(childSession)
  assert.equal(unbound.calls.prepare.length, 0, '分叉未绑定 chat 必须跳过')

  const mismatched = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { chatForSession: async () => ({ id: 'synthetic-chat', sessionId: 'other-session', mode: 'story' }) })
  await mismatched.run(childSession)
  assert.equal(mismatched.calls.prepare.length, 0, '分叉绑定到别的 session 必须跳过')

  const bg = registerHooks(loadAuthorHooks(wiredSource, countingStubs({})), { backgroundAgentRunner: { owns: () => true }, chatForSession: async () => boundChat })
  await bg.run(childSession)
  assert.equal(bg.calls.prepare.length, 0, 'backgroundAgentRunner.owns 必须跳过')
  assert.equal(decision.kind, 'enter', '返回必须是 post 处理后的决定')
})
