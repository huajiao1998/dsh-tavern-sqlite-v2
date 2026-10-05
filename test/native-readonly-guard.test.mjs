// 最小闸：原档 native 浏览只读，跳过自动 promotion 且释放 owned lease；显式 fork 冷读不改。
// 只依赖 Node 内置；node test/native-readonly-guard.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inject, installNativeReadonlyGuard, apply } from '../host-patch.js'
import { isLegacySession, UNMIGRATED_MESSAGE } from '../lib/tavern-chat-state.js'
import { setLegacyBinding } from '../lib/legacy-bindings.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-native-readonly-guard-'))
const oldHome = process.env.DSH_HOME
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value), 'utf8')
}
const snapshot = (directory, prefix = '') => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? Object.entries(snapshot(file, prefix + entry.name + '/')) : [[prefix + entry.name, readFileSync(file)]]
}))
const effects = []
try {
  process.env.DSH_HOME = root
  const dataRoot = path.join(root, 'data')
  writeJson(path.join(root, 'profiles', 'tavern', 'package.json'), { dshTavern: { dataRoot } })
  writeJson(path.join(dataRoot, 'sessions.json'), {
    'session-block': 'chat-block', 'session-journal': 'chat-journal',
    'session-shadow': 'chat-shadow', 'session-migrated': 'chat-migrated', 'session-missing': 'chat-missing',
  })
  writeJson(path.join(dataRoot, 'chats', 'chat-block', 'head.json'), { format: 1 })
  writeJson(path.join(dataRoot, 'chats', 'chat-journal.json'), { id: 'chat-journal' })
  writeJson(path.join(dataRoot, 'chats', 'chat-shadow', 'head.json'), { format: 1 })
  for (const chatId of ['chat-shadow', 'chat-migrated']) {
    mkdirSync(path.join(dataRoot, 'chats', chatId), { recursive: true })
    writeFileSync(path.join(dataRoot, 'chats', chatId, 'archive.db'), 'fixture-only-not-opened', 'utf8')
  }
  const artifactPath = path.join(root, 'parked-fixture.jsonl')
  writeFileSync(artifactPath, '{"id":"session-original"}\n', 'utf8')
  setLegacyBinding({ chatId: 'chat-bound', sessionId: 'session-bound', originalSessionId: 'session-original', artifactPath })
  const bytesBefore = snapshot(root)
  const legacyIds = ['session-block', 'session-journal', 'session-shadow', 'session-bound', 'session-original']
  const ordinaryIds = ['session-migrated', 'session-missing', 'session-unrelated']
  for (const id of legacyIds) assert.equal(isLegacySession(id), true, id)
  for (const id of ordinaryIds) assert.equal(isLegacySession(id), false, id)
  assert.deepEqual(inject, ['sessionController', 'sessionPersistence', 'sessionQuery'])

  const calls = []
  const samePromise = Promise.resolve({ agent: { id: 'nonlegacy' } })
  class Agents {
    resolve(...args) { calls.push({ method: 'resolve', owner: this, args }); return samePromise }
    async resolveAgent(sessionId) { return this.resolve(sessionId) }
    async resolveObservedAgent(observation) { return this.resolve(observation.header.id, observation) }
    ensureSession(...args) { calls.push({ method: 'ensureSession', owner: this, args }); return samePromise }
    resume(...args) { calls.push({ method: 'resume', owner: this, args }); return samePromise }
    resumeObserved(...args) { calls.push({ method: 'resumeObserved', owner: this, args }); return samePromise }
    createOrAdopt(...args) { calls.push({ method: 'createOrAdopt', owner: this, args }); return samePromise }
  }
  const observation = id => ({ header: { id }, disposed: 0, [Symbol.dispose]() { this.disposed++ } })
  const agents = new Agents()
  const query = { observeSession: id => { calls.push({ method: 'observeSession', id }); return observation(id) } }
  const history = {
    promote(...args) { calls.push({ method: 'promote', owner: this, args }); args[0][Symbol.dispose](); return 'ordinary-promotion' },
    observe(...args) { calls.push({ method: 'observe', args }); return query.observeSession(args[0]) },
  }
  const commands = {
    // 与 rc.2 同边界：fork 只 observe 原件，随后建独立孩子；不 resolve/resume 原件。
    async fork(request) {
      const source = await query.observeSession(request.sessionId)
      try { calls.push({ method: 'fork', source }); return { sessionId: 'session-child' } }
      finally { source[Symbol.dispose]() }
    },
  }
  const controller = { agents, history, commands, resolveAgent: id => agents.resolveAgent(id) }
  const ctx = {
    get: key => ({ sessionController: controller, sessionQuery: query, sessionPersistence: {} })[key],
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose },
  }
  const targets = [[history, 'promote'], ...['resolve', 'ensureSession', 'resume', 'resumeObserved', 'createOrAdopt'].map(name => [agents, name])]
  const descriptorsBefore = targets.map(([owner, name]) => Object.getOwnPropertyDescriptor(owner, name))
  const originalMethods = targets.map(([owner, name]) => owner[name])
  const untouched = [commands.fork, history.observe, query.observeSession, agents.resolveAgent, agents.resolveObservedAgent, controller.resolveAgent]
  installNativeReadonlyGuard(ctx)
  assert.equal(effects.length, 1)

  // owned promotion lease 必须恰好释放一次；resolve 的借用 lease 仍归调用者。
  for (const id of legacyIds) {
    const owned = observation(id)
    assert.equal(history.promote(owned), undefined)
    assert.equal(owned.disposed, 1)
    const borrowed = observation(id)
    for (const result of [await agents.resolve(id, borrowed), await agents.resolveAgent(id), await agents.resolveObservedAgent(borrowed), await controller.resolveAgent(id)]) {
      assert.ok(result.error instanceof Error)
      assert.equal(result.error.message, UNMIGRATED_MESSAGE)
      assert.equal(result.error.code, 'DSH_TAVERN_LEGACY_READ_ONLY')
    }
    assert.equal(borrowed.disposed, 0)
    borrowed[Symbol.dispose]()
    assert.equal(borrowed.disposed, 1)
    for (const name of ['ensureSession', 'resume', 'resumeObserved', 'createOrAdopt']) {
      await assert.rejects(agents[name](id, observation(id)), { message: UNMIGRATED_MESSAGE, code: 'DSH_TAVERN_LEGACY_READ_ONLY' })
    }
  }
  assert.equal(calls.length, 0, '拒绝时不能调用任何原始 promotion/resolve/resume/create 方法')
  const mismatched = observation('session-bound')
  assert.equal((await agents.resolve('session-unrelated', mismatched)).error.code, 'DSH_TAVERN_LEGACY_READ_ONLY')
  await assert.rejects(agents.resumeObserved('session-unrelated', mismatched), { code: 'DSH_TAVERN_LEGACY_READ_ONLY' })
  assert.equal(mismatched.disposed, 0, '拒绝不能抢走借用观察的所有权')

  assert.deepEqual([commands.fork, history.observe, query.observeSession, agents.resolveAgent, agents.resolveObservedAgent, controller.resolveAgent], untouched)
  assert.deepEqual(await commands.fork({ sessionId: 'session-original' }), { sessionId: 'session-child' })
  assert.equal(calls.at(-1).method, 'fork')
  assert.equal(calls.at(-1).source.disposed, 1)
  const cold = history.observe('session-bound')
  assert.equal(cold.header.id, 'session-bound')
  cold[Symbol.dispose]()

  for (const id of ordinaryIds) {
    const owned = observation(id)
    const marker = { marker: id }
    assert.equal(history.promote(owned, marker), 'ordinary-promotion')
    assert.equal(owned.disposed, 1)
    assert.equal(calls.at(-1).owner, history)
    assert.deepEqual(calls.at(-1).args, [owned, marker])
    for (const name of ['resolve', 'ensureSession', 'resume', 'resumeObserved', 'createOrAdopt']) {
      assert.equal(agents[name](id), samePromise, name + ' 必须保留原返回对象')
      assert.equal(calls.at(-1).owner, agents)
      assert.deepEqual(calls.at(-1).args, [id], '不补出原调用没有的 undefined 参数')
      assert.equal(agents[name](id, owned, marker), samePromise)
      assert.deepEqual(calls.at(-1).args, [id, owned, marker])
    }
  }
  assert.deepEqual(snapshot(root), bytesBefore, '浏览/拒绝/冷读分叉不能改原档、链接或插件binding库')

  effects[0]()
  effects[0]()
  targets.forEach(([owner, name], i) => {
    assert.equal(owner[name], originalMethods[i])
    assert.deepEqual(Object.getOwnPropertyDescriptor(owner, name), descriptorsBefore[i])
  })
  assert.equal(agents.resolve('session-bound'), samePromise, '卸载恢复原方法，不残留 guard')

  // apply 同步声明缺少 controller 不挂 guard，也不得碰任何原档或 persistence。
  const missingEffects = []
  const warn = console.warn
  try {
    console.warn = () => undefined
    assert.equal(await apply({ get: key => key === 'sessionController' ? undefined : {}, effect: fn => missingEffects.push(fn) }), undefined)
  } finally { console.warn = warn }
  assert.deepEqual(missingEffects, [])
  console.log(JSON.stringify({ result: 'PASS', legacyIds: legacyIds.length, ordinaryIds: ordinaryIds.length, promotionLeaseReleased: true, resolveRejected: true, directResumesRejected: true, forkObserveUnchanged: true, originalFilesUnchanged: true, descriptorsRestored: true, remoteDeployment: false }))
} finally {
  for (const dispose of effects.reverse()) dispose()
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  // 只删除本测试独占 mkdtemp 子目录，不清共享临时根。
  rmSync(root, { recursive: true, force: true })
}
