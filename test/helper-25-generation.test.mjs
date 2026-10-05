// Tavern Helper 生成 API（服务端接缝层）定向断言 —— 2026-10-05，作者基线 2.5.0
// `5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60`。
//
// 被测模块：`lib/helper-generation-api.js`（本轮重写版，59 行）。
// 真实作者任务层：`test/fixtures/upstream-25-helper-generation/helper-generation-tasks.js`
//   （与作者 `lib/domain/helper-generation-tasks.js` 逐字节相同；归档存在时做 sha256 对账）。
// 只跑本文件；未跑全量、未提交、未部署、未连远端、未读真实档。
//
// 关键契约（按重写模块逐条对照，不按旧 403 行版）：
//   · 工厂 `options.createGenerationTasks` **必填**，缺失 ⇒ 构造当场 throw（不半接线）。
//   · `tasks.stop(sessionId,id,{generationToken,pending:true})` 返回 **boolean**；
//     `stopGenerationById` 命中 ⇒ true、未命中/invalid id ⇒ false，**不抛**。
//   · `stopAllGeneration()` 恒返回 **true**（空表也 true）。
//   · 模型出口 `options.generate` / `options.generateRaw` 是 **descriptor 形态**：
//     调用时给 `(payload, descriptor)`，descriptor = `{sessionId,eventId,signal[,context]}`。
//   · `readGenerationContext(binding,config,kind)` 在 **run 内部、模型调用之前** 读（不是延迟到模型自己调）。
//   · `dispose()` 用 `tasks.dispose()` 真停所有任务（不返回计数），之后新生成 fail loud。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createHelperGenerationApi, HELPER_GENERATION_EVENTS } from '../lib/helper-generation-api.js'
import { createHelperGenerationTasks } from './fixtures/upstream-25-helper-generation/helper-generation-tasks.js'

const AUTHOR_TASKS = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/helper-generation-tasks.js', import.meta.url)
const FIXTURE_TASKS = new URL('./fixtures/upstream-25-helper-generation/helper-generation-tasks.js', import.meta.url)

const sha256 = url => createHash('sha256').update(readFileSync(url)).digest('hex')
const flushes = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

// ---------------------------------------------------------------- 基线真伪（缺 fixture 直接炸）
test('① 基线：作者任务层 fixture 存在且与作者源逐字节相同（不是手写赝品）', () => {
  assert.equal(existsSync(FIXTURE_TASKS), true, '缺 fixture 必须响亮失败，不许 skip')
  const fixture = readFileSync(FIXTURE_TASKS, 'utf8')
  assert.equal(fixture.includes('export function createHelperGenerationTasks'), true)
  assert.equal(fixture.includes('生成 ID 正在使用：'), true)
  assert.equal(fixture.includes('cancellationKey'), true)
  if (!existsSync(AUTHOR_TASKS)) {
    assert.fail('作者归档缺失（/tmp/upstream25-author-fixture/...）：基线无法对账，按 loud 失败处理')
  }
  assert.equal(sha256(FIXTURE_TASKS), sha256(AUTHOR_TASKS), 'fixture 必须与作者 helper-generation-tasks.js 逐字节相同')
})

// ---------------------------------------------------------------- 夹具
/** 建一个生成 API 实例：真实作者任务层 + 假模型（自 resolve/reject，不调 LLM）。 */
function harness({ api = {}, emit, activity, binding, logger, createGenerationTasks } = {}) {
  const events = []
  const state = {
    binding: { sessionId: 's1', eventId: 'mvu-work:op-1', ...binding },
    open: true,
  }
  const counters = activity || { pending: 0 }
  const instance = createHelperGenerationApi({
    bindingOf: () => (state.open ? state.binding : null),
    assertOpen: candidate => {
      if (!state.open || candidate !== state.binding) {
        const error = new Error('卡脚本写窗口已关闭（本次结算已结束），迟到写入已拒绝')
        error.code = 'SERVER_EXECUTION_LATE_WRITE'
        throw error
      }
    },
    activity: counters,
    str: value => (value === undefined || value === null ? '' : String(value)),
    emit: emit === undefined ? (name, ...args) => { events.push([name, ...args]) } : emit,
    options: {
      logger,
      createGenerationTasks: createGenerationTasks || (() => createHelperGenerationTasks()),
      ...api,
    },
  })
  return { api: instance, state, counters, events, binding: state.binding }
}

// ---------------------------------------------------------------- ② kind 路由与 descriptor
test('② kind 路由分离：generate / generateRaw 各取自己的实现；descriptor 带 sessionId+eventId+真 AbortSignal', async () => {
  const seen = []
  const { api, counters } = harness({
    api: {
      generate: (config, descriptor) => { seen.push(['generate', config, descriptor]); return { text: 'G' } },
      generateRaw: (config, descriptor) => { seen.push(['generateRaw', config, descriptor]); return { text: 'R' } },
    },
  })
  assert.equal(await api.generate({ generation_id: 'g1', user_input: 'a' }), 'G')
  assert.equal(await api.generateRaw({ generation_id: 'r1', user_input: 'b' }), 'R')
  assert.deepStrictEqual(seen.map(item => item[0]), ['generate', 'generateRaw'], '两种 kind 必须路由到各自实现，不得互相串')
  const raw = seen[1][2]
  assert.equal(raw.sessionId, 's1')
  assert.equal(raw.eventId, 'mvu-work:op-1')
  assert.equal(typeof raw.signal?.throwIfAborted, 'function', '模型侧拿到的是作者任务的 AbortSignal')
  assert.equal(raw.signal.aborted, false)
  assert.equal(Object.hasOwn(raw, 'context'), false, '没有 readGenerationContext 时不得伪造 context 键')
  assert.equal(seen[0][1].generation_id, 'g1', 'payload 原样透传（含 generation_id 回填）')
  assert.equal(counters.pending, 0, '收尾后计数必须复位')
})

// ---------------------------------------------------------------- ③ context 当前草稿
test('③ readGenerationContext：读当前草稿、(binding,config,kind) 三参、模型调用前已读、脚本面看不到 binding', async () => {
  const calls = []
  let first = null
  first = harness({
    api: {
      readGenerationContext: async (binding, config, kind) => {
        calls.push([binding.chat.id, config.generation_id, kind, binding === first.state.binding])
        return { sessionId: binding.sessionId, draftRev: binding.chat.revision, kind }
      },
      generateRaw: (config, descriptor) => descriptor.context.kind,
    },
  })
  first.state.binding.chat = { id: 'chat-live', revision: 9 }
  assert.equal(await first.api.generateRaw({ generation_id: 'c1' }), 'generateRaw')
  assert.deepStrictEqual(calls, [['chat-live', 'c1', 'generateRaw', true]], 'kind 必须是 generateRaw，且拿到的是同一 binding')
  const { api } = harness({
    api: {
      readGenerationContext: (binding, config, kind) => ({ sessionId: binding.sessionId, draftRev: binding.chat?.revision ?? 0, kind }),
      generate: (config, descriptor) => {
        assert.deepStrictEqual(Object.keys(descriptor).sort(), ['context', 'eventId', 'sessionId', 'signal'], '脚本面只有值 + signal，没有 binding/chat')
        return { text: descriptor.context.draftRev }
      },
    },
  })
  assert.equal(await api.generate({ generation_id: 'c2' }), '0', 'context 在模型调用前已就绪（不是延迟到模型自己调）')
})

// ---------------------------------------------------------------- ④ STARTED 立即 cancel
test('④ STARTED 监听器当场取消 ⇒ AbortError、模型从未被调、ENDED 文本为空、计数归零', async () => {
  const modelCalls = []
  const events = []
  const stopCalls = []
  const tasks = createHelperGenerationTasks()
  const tracked = {
    run: (...args) => tasks.run(...args),
    stopAll: (...args) => tasks.stopAll(...args),
    dispose: () => tasks.dispose(),
    stop: (sessionId, id, options) => { stopCalls.push([sessionId, id, options]); return tasks.stop(sessionId, id, options) },
  }
  let instance = null
  let startedId = null
  instance = createHelperGenerationApi({
    bindingOf: () => ({ sessionId: 's1', eventId: 'e1' }),
    assertOpen: () => {},
    activity: { pending: 0 },
    emit: (name, ...args) => {
      events.push([name, ...args])
      if (name === HELPER_GENERATION_EVENTS.GENERATION_STARTED) {
        startedId = args[0]
        Promise.resolve(instance.stopGenerationById(args[0])).catch(() => {})
      }
    },
    options: {
      createGenerationTasks: () => tracked,
      generate: (config, descriptor) => { modelCalls.push([config.generation_id, typeof descriptor.signal?.throwIfAborted]); return { text: 'late' } },
    },
  })
  const error = await instance.generate({ generation_id: 'g-early' }).then(() => null, err => err)
  await flushes()
  assert.ok(error, 'STARTED 监听器取消后必须 reject')
  assert.equal(error.name, 'AbortError')
  assert.equal(startedId, 'g-early')
  assert.deepStrictEqual(modelCalls, [], '被取消的请求不得进入模型出口')
  assert.deepStrictEqual(events.map(item => item[0]), [HELPER_GENERATION_EVENTS.GENERATION_STARTED, HELPER_GENERATION_EVENTS.GENERATION_ENDED])
  assert.equal(events[1][1], '', '取消路径的 ENDED 文本为空（text 仍为初值）')
  assert.deepStrictEqual(stopCalls.map(call => call[1]), ['g-early'], '取消经作者任务层执行')
  assert.equal(stopCalls[0][2].pending, true, '通知宿主时带 pending:true')
  assert.match(stopCalls[0][2].generationToken, /^[0-9a-f-]{36}$/, 'token 是固定 uuid')
})

// ---------------------------------------------------------------- ⑤ abort 真传给模型
test('⑤ AbortSignal 真传：模型挂起不理会 abort 时，stop 仍让作者任务层立刻 AbortError（signal.aborted 变真）', async () => {
  const signals = []
  const { api, counters } = harness({
    api: {
      generate: (config, descriptor) => new Promise(() => { signals.push(descriptor.signal) }), // 刻意永不 settle、不理会 abort
    },
  })
  const pending = api.generate({ generation_id: 'g-abort' })
  await flushes()
  assert.equal(signals.length, 1, '假模型已被调用（挂起中）')
  assert.equal(signals[0].aborted, false)
  assert.equal(counters.pending, 1, '在飞期间 activity +1')
  assert.equal(await api.stopGenerationById('g-abort'), true, 'stop 返回 boolean true')
  const error = await pending.then(() => null, err => err)
  assert.equal(error && error.name, 'AbortError', '不理会 abort 的挂起模型也必须被作者任务层 reject')
  assert.equal(signals[0].aborted, true, 'abort 已抵达模型侧 signal')
  await flushes()
  assert.equal(counters.pending, 0, '计数归零')
})

// ---------------------------------------------------------------- ⑥ duplicate / autogen id
test('⑥ 编号：重复 id 拒；空 id 自动生成 uuid；重复 id 不进入模型出口', async () => {
  const ids = []
  const gate = []
  const { api } = harness({
    api: { generate: config => { ids.push(config.generation_id); return new Promise(resolve => gate.push(resolve)) } },
  })
  assert.equal(ids.length, 0)
  const first = api.generate({ generation_id: 'dup-1' })
  await flushes()
  await assert.rejects(() => api.generate({ generation_id: 'dup-1' }), /生成编号正在使用/)
  assert.deepStrictEqual(ids, ['dup-1'], '重复 id 不得进入模型出口')
  gate.forEach(resolve => resolve({ text: 'first' }))
  assert.equal(await first, 'first')

  const auto = harness({ api: { generate: config => ({ text: config.generation_id }) } })
  const generated = await auto.api.generate({})
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, '空 id 走 randomUUID 形态')
  const blank = await auto.api.generate({ generation_id: '' })
  assert.match(blank, /^[0-9a-f-]{36}$/, '空串 id 同样自动生成')
  assert.notEqual(generated, blank)
  await assert.rejects(() => auto.api.generate(null), TypeError)
  await assert.rejects(() => auto.api.generate([]), TypeError)
})

// ---------------------------------------------------------------- ⑦ 双 stream + stop id
test('⑦ 正向流式：双流事件带全文（有序）后 ENDED；非流式只 ENDED；stop id 非法/未命中 false、stopAll 恒 true', async () => {
  const { api, events } = harness({ api: { generate: () => ({ text: 'FULL-TEXT' }) } })
  assert.equal(await api.generate({ generation_id: 'g-plain' }), 'FULL-TEXT')
  await flushes()
  assert.deepStrictEqual(events, [
    [HELPER_GENERATION_EVENTS.GENERATION_STARTED, 'g-plain'],
    [HELPER_GENERATION_EVENTS.GENERATION_ENDED, 'FULL-TEXT', 'g-plain'],
  ], '非流式：STARTED 后直接 ENDED，不发双流事件（作者语义）')

  const streamed = harness({ api: { generateRaw: () => ({ text: 'FULL-TEXT' }) } })
  assert.equal(await streamed.api.generateRaw({ generation_id: 'g-stream', should_stream: true }), 'FULL-TEXT')
  await flushes()
  assert.deepStrictEqual(streamed.events, [
    [HELPER_GENERATION_EVENTS.GENERATION_STARTED, 'g-stream'],
    [HELPER_GENERATION_EVENTS.STREAM_TOKEN_RECEIVED_FULLY, 'FULL-TEXT', 'g-stream'],
    [HELPER_GENERATION_EVENTS.STREAM_TOKEN_RECEIVED_INCREMENTALLY, 'FULL-TEXT', 'g-stream'],
    [HELPER_GENERATION_EVENTS.GENERATION_ENDED, 'FULL-TEXT', 'g-stream'],
  ], '流式：STARTED → FULLY → INCREMENTALLY → ENDED，有序')
  assert.equal(streamed.events[1][1], streamed.events[2][1], '两个流事件都传全文（作者语义，非增量）')

  assert.equal(await streamed.api.stopGenerationById('missing'), false, '未命中 ⇒ false，不抛')
  assert.equal(await streamed.api.stopGenerationById(''), false, '空 id ⇒ false')
  assert.equal(await streamed.api.stopGenerationById(123), false, '非字符串 id ⇒ false')
  assert.equal(await streamed.api.stopAllGeneration(), true, '空表 stopAll 也返回 true（与作者一致）')
})

// ---------------------------------------------------------------- ⑧ dispose
test('⑧ dispose：真 abort 在飞 job（模型 new Promise 永不 settle）、随后新生成 fail loud、外部 binding abort 也停', async () => {
  const { api, state, counters } = harness({
    api: { generate: () => new Promise(() => {}) },
  })
  const inflight = api.generate({ generation_id: 'g-dispose' })
  await flushes()
  assert.equal(counters.pending, 1)
  api.dispose()
  const error = await inflight.then(() => null, err => err)
  assert.equal(error && error.name, 'AbortError', 'dispose 必须真 abort 在飞任务，而不是留下永不 settle 的 Promise')
  await flushes()
  assert.equal(counters.pending, 0, 'dispose 后计数复位')
  await assert.rejects(() => api.generate({ generation_id: 'after' }), /生成调用窗口已关闭/, 'dispose 后新生成 fail loud')
  await assert.rejects(() => api.stopGenerationById('g-dispose'), /生成调用窗口已关闭/)

  // 外部 binding.signal.abort：同一个实例、另一个 binding。
  const controller = new AbortController()
  const external = harness({ binding: { signal: controller.signal }, api: { generate: () => new Promise(() => {}) } })
  const pendingExternal = external.api.generate({ generation_id: 'g-ext' })
  await flushes()
  controller.abort()
  const externalError = await pendingExternal.then(() => null, err => err)
  assert.equal(externalError && externalError.name, 'AbortError', '外部 binding abort 必须停掉在飞生成')
  await flushes()
  assert.equal(external.counters.pending, 0)
  assert.equal(external.state.open, true, '外部 abort 不该关窗口（只是停 job）')
})

// ---------------------------------------------------------------- ⑨ late / 计数回零
test('⑨ late ignored：窗口关闭后模型 resolve 不得返回结果（loop 计数回零）；emit 抛错不覆盖结果', async () => {
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  const { api, state, counters, events } = harness({ api: { generate: () => gate.then(() => ({ text: 'LATE' })) } })
  const pending = api.generate({ generation_id: 'g-late' })
  await flushes()
  assert.equal(counters.pending, 1, 'loop 计数在飞 = 1')
  state.open = false
  release()
  const error = await pending.then(() => null, err => err)
  assert.equal(error && error.code, 'SERVER_EXECUTION_LATE_WRITE', '关闭后迟到结果必须 reject，不能当成功返回')
  assert.equal(counters.pending, 0, 'loop 计数回零（不残留永久放宽）')
  await flushes()
  assert.deepStrictEqual(events, [
    [HELPER_GENERATION_EVENTS.GENERATION_STARTED, 'g-late'],
    [HELPER_GENERATION_EVENTS.GENERATION_ENDED, '', 'g-late'],
  ], 'late 结果不得当成功广播（只留 STARTED + ENDED 空文本）')
  assert.equal(events[1][1], '')

  const boom = harness({
    logger: { error: () => {} },
    emit: name => { if (name === HELPER_GENERATION_EVENTS.GENERATION_ENDED) throw new Error('emit-boom') },
    api: { generate: () => ({ text: 'OK' }) },
  })
  assert.equal(await boom.api.generate({ generation_id: 'g-emit', should_stream: true }), 'OK', 'emit 抛错不得覆盖生成结果')
  assert.equal(boom.counters.pending, 0)
})
