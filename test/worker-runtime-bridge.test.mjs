// Worker 版卡脚本运行时（宿主桥）端到端测试。
//
// 这个测试**与宿主机是否有 vm 无关**：Worker 路径只在缺 vm 时被生产代码选路，
// 但桥本身的正确性可以在任何 Node 上验证——而且**宿主进程不带 --experimental-vm-modules 时
// 才是桌面版真实条件**（`node --test test/worker-runtime-bridge.test.mjs` 不带旗标即模拟桌面）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createWorkerCardScriptRuntime, compileHostApiSpec, createSharedActivity } from '../lib/mvu/card-runtime-bridge.js'

const HOST_HAS_VM = typeof vm.SourceTextModule === 'function'

const CLASSIC_CARD = `
eventOn('MESSAGE_RECEIVED', async (id) => {
  const before = getHp()
  await setHp(before + 1)
  window.__observed = [before, getHp()]
})
`

const ESM_CARD = {
  name: 'esm-card.js',
  kind: 'esm',
  identifier: 'card:esm-card',
  code: 'export const marker = 41 + (await Promise.resolve(1))\n',
}

function makeHost() {
  const calls = []
  const tracked = []
  let hp = 10
  const hostApi = {
    getHp: () => { calls.push(['getHp']); return hp },
    setHp: (value) => {
      calls.push(['setHp', value])
      // 真实写是异步的（与生产一致：宿主 await 后才落地）
      return Promise.resolve().then(() => { hp = value; return true })
    },
    Mvu: { events: { MESSAGE_RECEIVED: 'MESSAGE_RECEIVED' } },
  }
  return { hostApi, calls, tracked, read: () => hp }
}

test('worker 桥：钩子派发 + 宿主 API 同步读/异步写 + 状态镜像', async () => {
  const { hostApi, calls, tracked, read } = makeHost()
  const activityHolder = { current: null }
  const runtime = createWorkerCardScriptRuntime({
    cardPath: '/tmp/worker-bridge-card',
    sources: [{ name: 'classic-card.js', code: CLASSIC_CARD }, ESM_CARD],
    hostApi,
    timeoutMs: 5000,
    logger: { info() {}, warn() {}, error() {} },
    activityHolder,
    trackWrite: promise => { tracked.push(promise); return promise },
  })
  try {
    await runtime.ready
    assert.equal(runtime.mode, 'worker', '必须标记为 worker 模式')
    assert.ok(activityHolder.current, '宿主侧共享活动计数必须已回填')
    assert.equal(activityHolder.current.pending, 0, '初始在飞计数为 0')
    assert.deepEqual(runtime.errors, [], '加载期不应有错误：' + JSON.stringify(runtime.errors))
    assert.ok(Array.isArray(runtime.events) && runtime.events.length >= 1, '宿主镜像必须看到已注册钩子，实际：' + JSON.stringify(runtime.events))

    const outcome = await runtime.dispatchEvent({ strict: true }, 'MESSAGE_RECEIVED', 3)
    assert.ok(outcome && outcome.ok !== false, 'strict 派发必须成功：' + JSON.stringify(outcome))
    await Promise.all(tracked)
    assert.deepEqual(calls[0], ['getHp'], '同步读必须真的被调用')
    assert.deepEqual(calls[1], ['setHp', 11], '异步写必须收到同步前缀算出的新值')
    assert.equal(read(), 11, '宿主状态必须落地')

    // 状态镜像：派发后宿主可读到当前脚本身份/待办等，不需反向查询
    assert.equal(typeof runtime.currentScriptId, 'string')
    assert.equal(runtime.disposed, false)
  } finally {
    runtime.dispose()
    await runtime.terminate()
  }
})

test('worker 桥：函数实参必须响亮失败（不静默降级）', async () => {
  const { hostApi } = makeHost()
  hostApi.withCallback = () => 'should-not-reach'
  const runtime = createWorkerCardScriptRuntime({
    cardPath: '/tmp/worker-bridge-callback',
    sources: [{ name: 'cb.js', code: "eventOn('PING', () => { withCallback(() => 1) })\n" }],
    hostApi,
    timeoutMs: 5000,
    logger: { info() {}, warn() {}, error() {} },
  })
  try {
    await runtime.ready
    assert.deepEqual(runtime.errors, [], '加载期不应有错误')
    await assert.rejects(
      () => runtime.dispatchEvent({ strict: true }, 'PING'),
      error => {
        assert.match(String(error && error.message), /参数是函数/, '必须明确报"回调参数暂不支持"')
        return true
      },
    )
  } finally {
    runtime.dispose()
    await runtime.terminate()
  }
})

test('worker 桥：宿主 API 规格编译（函数留桩/数据内联/本地模块/命名空间）', () => {
  const host = makeHost()
  host.hostApi.YAML = { parse: () => ({}) }
  host.hostApi._ = () => {}
  host.hostApi.zod = { object: () => ({}) }
  const spec = compileHostApiSpec(host.hostApi)
  assert.equal(spec.members.getHp.kind, 'fn')
  // 普通对象递归成命名空间（函数继续留桩、叶子内联）：功能上等价于内联整对象，
  // 但能让 Mvu 这类「既含数据又含方法」的命名空间逐成员正确处理。
  assert.equal(spec.members.Mvu.kind, 'ns')
  assert.deepEqual(spec.members.Mvu.members.events.members.MESSAGE_RECEIVED, { kind: 'value', value: 'MESSAGE_RECEIVED' })
  assert.deepEqual(spec.members._, { kind: 'local', module: 'lodash' })
  assert.deepEqual(spec.members.YAML, { kind: 'local', module: 'yaml' })
  assert.deepEqual(spec.members.zod, { kind: 'local', module: 'zod' })
})

test('共享活动计数：宿主与 Worker 看到同一个数', async () => {
  const { activity, sab } = createSharedActivity()
  assert.equal(activity.pending, 0)
  activity.pending = 3
  assert.equal(Atomics.load(new Int32Array(sab, 0, 1), 0), 3, '写共享计数必须原子可见')
})

test('能力选路：无 vm 的宿主必须选 worker 路径', async () => {
  const { selectRuntimeHost, hasInProcessVmModules } = await import('../lib/mvu/vm-capability.js')
  assert.equal(selectRuntimeHost(), hasInProcessVmModules() ? 'in-process' : 'worker')
  assert.equal(HOST_HAS_VM, hasInProcessVmModules(), '能力判定必须与宿主真实状态一致')
})
