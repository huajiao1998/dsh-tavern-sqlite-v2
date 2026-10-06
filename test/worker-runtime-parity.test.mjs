// 双路 parity：**同一张卡**分别走「进程内 vm 运行时」与「Worker 运行时」，断言两条路的
// 可观测结果**逐字相同**。这是 Worker 重构的验收核心——不是"Worker 能跑"，而是"跑得一样"。
//
// 运行前提：本测试需要宿主进程带 `--experimental-vm-modules`（进程内那条路要用 vm）；
// 缺 flag 时自动跳过进程内对照，只验证 Worker 路（桌面真实条件），并在输出里标明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createCardScriptRuntime } from '../lib/mvu/mvu-card-runtime.js'
import { createWorkerCardScriptRuntime } from '../lib/mvu/card-runtime-bridge.js'

const HOST_HAS_VM = typeof vm.SourceTextModule === 'function'
const silent = { info() {}, warn() {}, error() {}, debug() {} }

// 真实形态的卡：①classic 脚本注册钩子 + jQuery ready（回调参数）+ 短定时器防抖；
// ②ESM 脚本带顶层 await + 导出；③钩子里同步读、异步写宿主变量。
const CLASSIC_SOURCE = {
  name: 'classic-card.js',
  code: `
$(function () {
  record('ready')
  setTimeout(() => record('debounce'), 20)
})
eventOn('MESSAGE_RECEIVED', id => {
  record('msg:' + id)
  const before = getValue()
  setValue(before + 1)
})
eventOn('MESSAGE_SENT', () => { record('sent') })
`,
}
const ESM_SOURCE = {
  name: 'esm-card.js',
  kind: 'esm',
  identifier: 'card:esm-parity',
  code: `
const awaited = await Promise.resolve(1)
export const total = 41 + awaited
window.__esmTotal = total
record('esm:' + total)
`,
}
// ④DOM 探针用例：**写** DOM（读走自愈 no-op 不抛、只标记；写按设计立即抛 DOM_MARK）。
// 这条是**防退化闸**：Worker 快照曾把错误记录字符串化、丢掉 domProbe 字段，导致桌面端
// DOM 探针被误分类成真实加载错误（该 bug 的断言两边都是 '[object Object]'，空等于掩盖了它）。
const DOM_SOURCE = {
  name: 'dom-card.js',
  code: `
record('dom-start')
document.body.innerHTML = 'x'
record('dom-unreached')
`,
}

/** 跑一条路，返回**可观测结果**（只含可跨线程比较的纯数据）。 */
async function runCase(mode) {
  const effects = []
  const writes = []
  let value = 10
  const runtimeRef = { current: null }
  const activityHolder = { current: null }
  const hostApi = {
    record: name => { effects.push(String(name)); return effects.length },
    getValue: () => value,
    setValue: next => Promise.resolve().then(() => { value = next; writes.push(next); return value }),
    Mvu: { events: { MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', MESSAGE_SENT: 'MESSAGE_SENT' } },
    // 进程内路径的 `$`（含回调参数）由宿主实现；Worker 路径的 `$` 在 Worker 内本地实现。
    $: fn => {
      const sandbox = runtimeRef.current?.sandbox
      const register = sandbox?._dshRegisterMicrotask
      const pending = typeof register === 'function'
        ? new Promise((resolve, reject) => register(() => {
          try { const result = fn(); Promise.resolve(result).then(resolve, reject); return result }
          catch (error) { reject(error); throw error }
        }))
        : Promise.resolve().then(fn)
      return pending
    },
  }
  const options = {
    cardPath: '/tmp/parity-card',
    sources: [CLASSIC_SOURCE, ESM_SOURCE, DOM_SOURCE],
    hostApi,
    timeoutMs: 5000,
    logger: silent,
    activityHolder,
    timerCeilingMs: 3000,
    timerCountMax: 256,
    pendingCeilingMs: 3000,
  }
  const runtime = mode === 'worker'
    ? createWorkerCardScriptRuntime(options)
    : createCardScriptRuntime({ ...options, activity: { pending: 0 } })
  runtimeRef.current = runtime
  try {
    await runtime.ready
    // 加载期的 ready/防抖回调：有界 drain（与生产同一条出口）
    await runtime.drainPendingTasks({ source: 'hook', timeoutMs: 2000 })
    const first = await runtime.dispatchEvent({ strict: true }, 'MESSAGE_RECEIVED', 7)
    await runtime.drainPendingTasks({ source: 'hook', timeoutMs: 2000 })
    const second = await runtime.dispatchEvent({ strict: true }, 'MESSAGE_SENT')
    return {
      effects: effects.slice(),
      writes: writes.slice(),
      value,
      hookEvents: runtime.events.map(item => String(item.event)).sort(),
      hookSources: runtime.events.map(item => String(item.source || '')).sort(),
      // **按真实形状比较**错误记录（source/error/domProbe）：server-execution 靠 domProbe 字段
      // 分类 DOM 探针。早先版本两边都 String 化成 '[object Object]'，断言空等于、掩盖过真 bug。
      loadErrors: runtime.errors.map(item => ({ source: item?.source ?? null, error: String(item?.error ?? item?.message ?? ''), domProbe: item?.domProbe === true })),
      needsBrowser: (Array.isArray(runtime.needsBrowser) ? runtime.needsBrowser : []).slice().sort(),
      domAccessed: runtime.domAccessed === true,
      firstOk: first?.ok !== false,
      secondOk: second?.ok !== false,
    }
  } finally {
    runtime.dispose?.()
    await runtime.terminate?.()
  }
}

test('双路 parity：同一张卡的钩子/宿主调用/变量结果必须逐字一致', { skip: HOST_HAS_VM ? false : '宿主无 vm：进程内对照路不可用（桌面条件下只验 Worker 路）' }, async () => {
  const inProcess = await runCase('in-process')
  const worker = await runCase('worker')
  assert.deepEqual(worker, inProcess, 'Worker 路与进程内路的可观测结果必须完全一致')
  // 结果本身要"有内容"，否则 deepEqual 可能只是两边都空
  assert.ok(inProcess.effects.includes('ready'), 'ready 回调必须跑过：' + JSON.stringify(inProcess.effects))
  assert.ok(inProcess.effects.some(name => name.startsWith('msg:')), '消息钩子必须跑过：' + JSON.stringify(inProcess.effects))
  assert.ok(inProcess.effects.some(name => name.startsWith('esm:')), 'ESM 脚本必须加载执行：' + JSON.stringify(inProcess.effects))
  assert.equal(inProcess.value, 11, '同步读 + 异步写必须落地')
  // DOM 探针必须被识别（browser-ui），且分类字段在两路上形状一致
  assert.ok(inProcess.effects.includes('dom-start'), 'DOM 探针用例必须执行到写操作：' + JSON.stringify(inProcess.effects))
  assert.equal(inProcess.domAccessed, true, 'DOM 访问必须被标记')
  assert.ok(inProcess.loadErrors.some(item => item.domProbe && item.source === 'dom-card.js'), 'DOM 探针必须带 domProbe 标记：' + JSON.stringify(inProcess.loadErrors))
  assert.equal(inProcess.loadErrors.filter(item => !item.domProbe).length, 0, '除 DOM 探针外不应有加载错误：' + JSON.stringify(inProcess.loadErrors))
})

test('Worker 路（无 vm 宿主条件）：同一张卡必须产出与进程内相同的可观测结果', async () => {
  const worker = await runCase('worker')
  assert.ok(worker.effects.includes('ready'), 'ready 回调必须跑过：' + JSON.stringify(worker.effects))
  assert.ok(worker.effects.some(name => name.startsWith('esm:')), 'ESM 脚本必须加载执行：' + JSON.stringify(worker.effects))
  assert.equal(worker.value, 11, '同步读 + 异步写必须落地')
  assert.ok(worker.effects.includes('dom-start'), 'DOM 探针用例必须执行到写操作：' + JSON.stringify(worker.effects))
  assert.equal(worker.domAccessed, true, 'DOM 访问必须被标记（桌面条件下的 browser-ui 分诊证据）')
  assert.ok(worker.loadErrors.some(item => item.domProbe && item.source === 'dom-card.js'), 'DOM 探针必须带 domProbe 标记（跨线程不丢形状）：' + JSON.stringify(worker.loadErrors))
  assert.equal(worker.loadErrors.filter(item => !item.domProbe).length, 0, '除 DOM 探针外不应有加载错误：' + JSON.stringify(worker.loadErrors))
  assert.deepEqual(worker.hookEvents, ['MESSAGE_RECEIVED', 'MESSAGE_SENT'], '钩子注册必须完整：' + JSON.stringify(worker.hookEvents))
  if (!HOST_HAS_VM) {
    // 桌面真实条件：这条断言就是"桌面版能跑真实卡"的证据。
    assert.equal(typeof vm.SourceTextModule, 'undefined', '本进程确实没有 vm（模拟桌面）')
  }
})
