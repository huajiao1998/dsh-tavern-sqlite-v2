// 76513ba审查新增输入：新生产退役实际进入作者重生成的失败恢复；只用合成SQL与真实Session。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { fixture } from './regeneration-rollback-integration.test.mjs'
import { applyRegenerationInputTransform } from '../deploy/regeneration-input-transform.mjs'
const AUTHOR = new URL('../../../tmp/adapt-dsh-021rc2-20261018/stable/tavern-plugin/lib/hooks/request.js', import.meta.url)

async function productionHooks(root) {
  const source = applyRegenerationInputTransform(readFileSync(AUTHOR, 'utf8'))
  const file = path.join(root, 'review-variable-request.mjs')
  writeFileSync(file, source.replace(/from '(.+?)'/g, (all, spec) => spec.startsWith('.') ? 'from ' + JSON.stringify(new URL(spec, AUTHOR).href) : all), 'utf8')
  return import(pathToFileURL(file))
}

test('审查76513ba：真实重生成首步退役后生成失败，SQL及冷会话完整恢复原输入', async () => {
  const f = await fixture({ physical: true, currentAuthor: true })
  try {
    const { registerRequestHooks } = await productionHooks(f.root)
    const chat = await f.read(), handlers = new Map()
    const old = f.session.append('user/message', { id: 'review-old-variable', role: 'user', content: [{ type: 'text', text: '旧轮仍需恢复的变量变化' }], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'variable-changes' } }, { surfaceOp: 'append' })
    await f.sessions.flush(f.session)
    const before = f.session.snapshotEvents()
    registerRequestHooks({ ctx: { on: (name, run) => handlers.set(name, run) }, backgroundAgentRunner: { owns: () => false },
      cardMemory: { appendRecall: async ({ decision }) => decision }, chatForSession: f.read,
      foregroundStrategies: { prepareStep: async ({ decision }) => decision }, persistClearedBodyEdits: async () => {},
      requestCoordinates: new Map(), requestIdForMessages: () => 'review-request', sessionStore: f.sessions, tavernRetryLimiter: { handle: () => {} } })
    let task, retired = false, savedTurn
    f.agent.followup = message => {
      f.agent.phase.kind = 'running'
      task = (async () => {
        const turn = 54
        f.session.append('turn/start', { turn })
        const rolled = await f.read()
        savedTurn = rolled.regenRecovery?.turn
        const decision = await handlers.get('agent/pre-step')({ agent: f.agent, turn, step: 1, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
        retired = !f.session.surface.nodes.includes(old.seq)
        f.session.append('step/start', { turn, step: 1 })
        for (const input of decision.messages) f.session.append('user/message', input, { surfaceOp: 'append' })
        f.session.append('step/end', { turn, step: 1 })
        f.session.append('turn/end', { turn, reason: { kind: 'aborted' } })
        await f.sessions.flush(f.session)
        throw Error('review-generation-failed-after-retirement')
      })().finally(() => { f.agent.phase.kind = 'idle'; f.agent.phase.lastTurn = 54 })
    }
    f.agent.whenIdle = async () => task
    await assert.rejects(f.roundHistory.regenerate(chat.id, '审查失败恢复'), /review-generation-failed-after-retirement/)
    assert.equal(savedTurn, 53, '真实作者及产品施缝必须把原轮放入hook实际读取的恢复记录')
    assert.equal(retired, true, '失败发生前新退役生产入口确实执行，而非未走代码的假恢复')
    assert.deepEqual(f.mainDb.readAll().events, before, '失败恢复SQL原尾逐字还原，不留空退役或临时输入')
    assert.deepEqual(f.session.snapshotEvents(), before, '热会话与原事件完整一致')
    const cold = f.Session.fromRestore(f.session.id, f.mainDb.readAll().events, f.session.header, 0, 'detached')
    assert.deepEqual(cold.deriveMessages(), f.session.deriveMessages(), '冷恢复不能漏掉失败前仍有效的旧变量输入')
    assert.ok(cold.deriveMessages().some(message => message.id === old.data.id && message.content.length))
    const restored = await f.read()
    assert.deepEqual(restored.messages, chat.messages)
    assert.equal(restored.regenRecovery, undefined)
    assert.equal(restored.regenInProgress, undefined)
  } finally { await f.cleanup() }
})
