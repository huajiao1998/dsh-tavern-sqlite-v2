// 定向断言：截图错误是压缩警告；注册恢复立即投影失效，不篡改历史或宣称压缩成功。
// 身份门（2026-10-05 换源）：旧读源 tmp/plg-standard-1001-code/b 是 2.4 代残拷贝（forkTurnsByMessageId
// 锚点已随 2.5.0 位移）；只喂 upstream25-author-fixture 的 2.5.0 真源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { projectCompactionWarning } from '../lib/compaction-warning.js'
import { applyCompactionWarningTransform } from '../deploy/compaction-warning-transform.mjs'

const AUTHOR_25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/'

const warning = 'no adapter registered for provider "gcli2api"'
const providers = [{ id: 'gcli2api', name: '网关' }]
test('路由恢复只消除无操作的过时诊断，原状态不改', () => {
  const state = { warning, baseline: ['1'] }
  assert.equal(projectCompactionWarning(state, []), state)
  assert.equal(projectCompactionWarning(state, providers).warning, '')
  assert.equal(state.warning, warning)
  assert.equal(projectCompactionWarning(state, undefined), state)
  assert.equal(projectCompactionWarning(state, [{ provider: 'gcli2api' }]), state)
})
test('失败、部分成功、运行中压缩和其他错误不可被路由恢复隐藏', () => {
  for (const status of ['running', 'failed', 'partial', 'unknown']) {
    const state = { warning, operation: { status } }
    assert.equal(projectCompactionWarning(state, providers), state)
  }
  for (const message of ['请求超时', warning + ' 其他失败', 'no adapter registered for provider "other"']) {
    const state = { warning: message }
    assert.equal(projectCompactionWarning(state, providers), state)
  }
})
test('真实作者完整与缓存消费者同步响应注册变化，不依赖正文新轮或刷新数据库', () => {
  const original = readFileSync(new URL(AUTHOR_25 + 'lib/index.js', import.meta.url), 'utf8')
  const transformed = applyCompactionWarningTransform(original)
  assert.equal(applyCompactionWarningTransform(transformed), transformed)
  assert.throws(() => applyCompactionWarningTransform(original.replace('contextCompaction: chat.contextCompaction || null,', '')), /锚点/)
  // 2.5.0 起该函数为三行形态（签名/单行函数体/收尾），正则须取整函数；体内新引用
  // forkTurnsByMessageId 的 forkTurnsForChat —— 上下文按同形补桩（不发明语义，只回稳定值）。
  const volatile = transformed.match(/function volatileSessionViewFields\([\s\S]*?\n  \}/)[0]
  let registered = []
  const context = vm.createContext({ projectCompactionWarning, ctx: { llm: { listProviders: () => registered } }, sessionStateView: { volatile: () => ({ status: 'ready' }) }, forkTurnsForChat: () => ({}) })
  vm.runInContext(volatile + '; globalThis.project = volatileSessionViewFields', context)
  const chat = { contextCompaction: { warning } }
  assert.equal(context.project(chat).contextCompaction.warning, warning)
  registered = providers
  assert.equal(context.project(chat).contextCompaction.warning, '')
  registered = []
  assert.equal(context.project(chat).contextCompaction.warning, warning)
  const expression = transformed.match(/contextCompaction: (projectCompactionWarning\([^\n]+\)),/)[1]
  context.chat = chat
  registered = providers
  assert.equal(vm.runInContext(expression, context).warning, '')
  assert.equal(chat.contextCompaction.warning, warning)
  const client = readFileSync(new URL(AUTHOR_25 + 'lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /live\.view\.contextCompaction\.warning \|\| "正在压缩前后台上下文…"/)
})
