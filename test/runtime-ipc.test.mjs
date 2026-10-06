// runtime-ipc 原语测试：同步值 / 抛错 / 异步尾部 ticket / **同步前缀时序**。
// 这里是 Worker 桥的地基，语义必须与进程内实现一致：宿主函数返回 thenable 时，
// 其**同步前缀**（到首个 await 之前）必须在脚本下一条语句前执行完。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSharedSlot, createHostChannel, STATE_IDLE } from '../lib/mvu/runtime-ipc.js'

const ipcUrl = pathToFileURL(fileURLToPath(new URL('../lib/mvu/runtime-ipc.js', import.meta.url))).href

const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const channel = createWorkerChannel({ sab: workerData.sab, notify: (m) => parentPort.postMessage(m), timeoutMs: 10000 });
  const tickets = new Map();
  const results = { steps: [] };
  parentPort.on('message', (message) => {
    if (message && message.type === 'ticket' && tickets.has(message.id)) {
      const entry = tickets.get(message.id); tickets.delete(message.id);
      if (message.ok) entry.resolve(message.value); else entry.reject(new Error(message.value && message.value.message));
    }
  });
  (async () => {
    try {
      // ① 同步返回值
      const a = channel.call({ member: 'syncValue', args: [21] });
      results.steps.push(['syncValue', a.kind, a.value]);
      // ② 宿主抛错：必须带 code 传回，且不吞
      let thrown = null;
      try { channel.call({ member: 'boom', args: [] }); } catch (error) { thrown = { message: error.message, code: error.code }; }
      results.steps.push(['boom', thrown]);
      // ③ 异步尾部：拿到 ticket 时**同步前缀必须已经跑完**
      const b = channel.call({ member: 'asyncWrite', args: [] });
      results.steps.push(['asyncKind', b.kind]);
      const counterRightAfter = channel.call({ member: 'readCounter', args: [] });
      results.steps.push(['counterAtTicketTime', counterRightAfter.value]);
      const promise = new Promise((resolve, reject) => tickets.set(b.ticket, { resolve, reject }));
      const settled = await promise;
      results.steps.push(['asyncSettled', settled]);
      const counterAfter = channel.call({ member: 'readCounter', args: [] });
      results.steps.push(['counterAfterTail', counterAfter.value]);
      // ④ 超时护栏：宿主不服务即响亮失败（用不存在的成员模拟宿主异常路径由宿主侧覆盖）
      parentPort.postMessage({ type: 'done', results });
    } catch (error) {
      parentPort.postMessage({ type: 'failed', error: String(error && error.message), steps: results.steps });
    }
  })();
}).catch((error) => parentPort.postMessage({ type: 'failed', error: 'import failed: ' + error.message }));
`

test('runtime-ipc：同步值/抛错/异步尾部/同步前缀时序', async () => {
  const payloadBytes = 1024 * 1024
  const sab = createSharedSlot(payloadBytes)
  let counter = 0
  const channel = createHostChannel({ sab, payloadBytes })
  const invoke = (request) => {
    if (request.member === 'syncValue') return request.args[0] * 2
    if (request.member === 'boom') throw Object.assign(new Error('宿主炸弹'), { code: 'BOOM' })
    if (request.member === 'readCounter') return counter
    if (request.member === 'asyncWrite') {
      counter += 1
      return new Promise(resolve => setTimeout(() => { counter += 10; resolve('done') }, 80))
    }
    throw new Error('未知成员：' + request.member)
  }
  const worker = new Worker(workerCode, { eval: true, execArgv: ['--experimental-vm-modules'], workerData: { sab, ipcUrl } })
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试 Worker 超时 20s')), 20000)
    worker.on('message', message => {
      if (message && message.type === 'hostcall') { channel.serve(invoke, m => worker.postMessage(m)); return }
      if (message && message.type === 'ticket') return
      if (message && (message.type === 'done' || message.type === 'failed')) { clearTimeout(timer); resolve(message) }
    })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
  })
  await worker.terminate()

  assert.equal(outcome.type, 'done', 'worker 报告失败：' + JSON.stringify(outcome))
  const steps = new Map(outcome.results.steps.map(([name, ...rest]) => [name, rest]))
  assert.deepEqual(steps.get('syncValue'), ['value', 42], '同步返回值必须原样传回')
  assert.deepEqual(steps.get('boom'), [{ message: '宿主炸弹', code: 'BOOM' }], '宿主异常必须带 code 传回')
  assert.deepEqual(steps.get('asyncKind'), ['ticket'], 'thenable 返回必须走 ticket')
  assert.deepEqual(steps.get('counterAtTicketTime'), [1], '同步前缀必须在 ticket 返回前执行完（语义与进程内一致）')
  assert.deepEqual(steps.get('asyncSettled'), ['done'], '异步尾部结果必须结算到 Worker 侧 Promise')
  assert.deepEqual(steps.get('counterAfterTail'), [11], '异步尾部必须在 Worker 继续后可见其效果')
  assert.equal(channel.pendingTickets(), 0, 'ticket 必须全部结算，不留悬挂')
  assert.equal(Atomics.load(new Int32Array(sab, 0, 16), 1) !== STATE_IDLE, true, '通道最终必须离开 IDLE')
})

test('runtime-ipc：同步等待超时即响亮失败（不死等）', async () => {
  const payloadBytes = 256 * 1024
  const sab = createSharedSlot(payloadBytes)
  const workerCodeShort = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.ipcUrl).then(({ createWorkerChannel }) => {
  const channel = createWorkerChannel({ sab: workerData.sab, notify: (m) => parentPort.postMessage(m), timeoutMs: 300 });
  try { channel.call({ member: 'never' }); parentPort.postMessage({ type: 'failed', error: '不该返回' }); }
  catch (error) { parentPort.postMessage({ type: 'done', code: error.code, message: error.message }); }
});
`
  const worker = new Worker(workerCodeShort, { eval: true, execArgv: ['--experimental-vm-modules'], workerData: { sab, ipcUrl } })
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时测试自身卡住')), 10000)
    // 收到 hostcall **故意不服务**，模拟宿主卡死
    worker.on('message', message => { if (message && message.type === 'done') { clearTimeout(timer); resolve(message) } })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
  })
  await worker.terminate()
  assert.equal(outcome.code, 'RUNTIME_IPC_TIMEOUT', '宿主不服务必须响亮超时失败')
})
