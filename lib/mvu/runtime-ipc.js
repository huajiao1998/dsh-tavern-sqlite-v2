// 卡脚本宿主 API 的跨线程调用原语。
//
// 语义目标（与进程内实现**逐字对齐**）：宿主 API 分两种形态——
//   · 同步返回（`getvar` 这类读）：脚本必须立刻拿到值；
//   · 返回 Promise（`replaceVariables` 这类写）：**同步前缀**（到第一个 await 之前）仍须在
//     脚本下一条语句前跑完，异步尾部稍后结算。
// 因此这里不按成员硬编码，而按**每次调用的实际返回形态**自适应：
//   1) Worker 把请求写进 SharedArrayBuffer，postMessage 通知宿主，然后 `Atomics.wait` 阻塞；
//   2) 宿主在事件循环里同步调用宿主函数：
//      · 返回值不是 thenable ⇒ 立刻写回 SAB ＋ notify（Worker 拿到值，同步语义保住）；
//      · 返回值是 thenable   ⇒ 同步前缀已执行完，回一张 ticket；异步尾部完成后再 postMessage
//        通知 Worker（Worker 侧代理的 Promise 届时才 resolve）。
//   3) Worker 线程是单线程 ⇒ 同一时刻只有一个在飞同步调用，SAB 单槽即可，无需队列。
//
// 死锁护栏：宿主**永远不阻塞**（不调用 Atomics.wait）；Worker 的等待带超时，超时即响亮失败
// （宿主 bug/死锁时不会静默挂死）。
import { Buffer } from 'node:buffer'
import v8 from 'node:v8'

const HEADER_INTS = 16
const HEADER_BYTES = HEADER_INTS * 4
/** 请求/响应载荷容量缺省 8 MiB：同步返回值（单楼变量树等）远小于此；超限**响亮失败**，不静默截断。 */
export const DEFAULT_PAYLOAD_BYTES = 8 * 1024 * 1024

/** SAB 头部槽位 */
const SLOT_SEQ = 0
const SLOT_STATE = 1
const SLOT_LENGTH = 2
const SLOT_TICKET = 3
/** 状态值 */
export const STATE_IDLE = 0
export const STATE_VALUE = 1
export const STATE_TICKET = 2
export const STATE_ERROR = 3

export const IPC_ERRORS = {
  timeout: 'RUNTIME_IPC_TIMEOUT',
  oversize: 'RUNTIME_IPC_OVERSIZE',
  protocol: 'RUNTIME_IPC_PROTOCOL',
}

export function ipcFail(code, message) {
  return Object.assign(new Error(`[runtime-ipc] ${message}`), { code })
}

/** 新建共享槽（宿主侧创建，传给 Worker） */
export function createSharedSlot(payloadBytes = DEFAULT_PAYLOAD_BYTES) {
  if (!Number.isInteger(payloadBytes) || payloadBytes < 64 * 1024) throw ipcFail(IPC_ERRORS.protocol, '载荷容量不合理')
  return new SharedArrayBuffer(HEADER_BYTES + payloadBytes)
}

function views(sab) {
  return { header: new Int32Array(sab, 0, HEADER_INTS), payload: new Uint8Array(sab, HEADER_BYTES) }
}

/** 值编码：v8.serialize（保真度高于 JSON，支持 Date/Map/二进制等；函数仍不可跨线程，按错误响亮失败） */
export function encodeValue(value) {
  try {
    return v8.serialize(value)
  } catch (error) {
    throw ipcFail(IPC_ERRORS.protocol, '同步返回值无法跨线程编码（含函数/句柄等）：' + (error && error.message))
  }
}

export function decodeValue(bytes) {
  return v8.deserialize(Buffer.from(bytes.buffer ? bytes : Buffer.from(bytes)))
}

/** 错误编码（跨线程只传身份与文本，不传栈对象） */
export function encodeError(error) {
  return {
    name: String((error && error.name) || 'Error'),
    message: String((error && error.message) || error || '未知错误'),
    code: (error && error.code) || undefined,
    stack: typeof (error && error.stack) === 'string' ? String(error.stack).split('\n').slice(0, 6).join('\n') : undefined,
  }
}

/**
 * 宿主侧通道。
 * @param options.sab 共享槽（宿主创建）
 * @param options.payloadBytes 载荷容量（用于越界判定）
 * @param options.onLog 诊断回调（可选）
 */
export function createHostChannel({ sab, payloadBytes = DEFAULT_PAYLOAD_BYTES, onLog } = {}) {
  if (!(sab instanceof SharedArrayBuffer)) throw ipcFail(IPC_ERRORS.protocol, '宿主通道需要 SharedArrayBuffer')
  const { header, payload } = views(sab)
  let ticketSeq = 0
  const tickets = new Map()

  function writeResponse(state, bytes, ticketId) {
    if (bytes && bytes.length > payloadBytes) {
      throw ipcFail(IPC_ERRORS.oversize, `同步返回超过共享槽容量（${bytes.length} > ${payloadBytes}）`)
    }
    if (bytes) payload.set(bytes, 0)
    Atomics.store(header, SLOT_LENGTH, bytes ? bytes.length : 0)
    if (state === STATE_TICKET) Atomics.store(header, SLOT_TICKET, ticketId)
    Atomics.store(header, SLOT_STATE, state)
    Atomics.notify(header, SLOT_STATE)
  }

  function readRequest() {
    const length = Atomics.load(header, SLOT_LENGTH)
    if (!Number.isInteger(length) || length < 0 || length > payloadBytes) throw ipcFail(IPC_ERRORS.protocol, '宿主收到非法请求长度')
    return decodeValue(payload.subarray(0, length))
  }

  /**
   * 处理一次宿主 API 调用（宿主事件循环内调用，**不要 await 后再回应**）。
   * @param invoke (request) => value | Promise<value>
   * @param send (message) => void  宿主→Worker 的消息发送（ticket 结算用）
   */
  function serve(invoke, send) {
    let request
    try {
      request = readRequest()
    } catch (error) {
      writeResponse(STATE_ERROR, encodeValue(encodeError(error)))
      return
    }
    let result
    try {
      result = invoke(request)
    } catch (error) {
      writeResponse(STATE_ERROR, encodeValue(encodeError(error)))
      return
    }
    if (result && typeof result.then === 'function') {
      // 同步前缀已执行完（async 函数体到首个 await）⇒ 与进程内语义一致；尾部走 ticket。
      const id = ++ticketSeq
      tickets.set(id, true)
      try {
        writeResponse(STATE_TICKET, null, id)
      } catch (error) {
        tickets.delete(id)
        writeResponse(STATE_ERROR, encodeValue(encodeError(error)))
        return
      }
      const settle = (ok, value) => {
        if (!tickets.delete(id)) return
        send({ type: 'ticket', id, ok, value: ok ? value : encodeError(value) })
      }
      Promise.resolve(result).then(value => settle(true, value), error => settle(false, error))
      return
    }
    try {
      writeResponse(STATE_VALUE, encodeValue(result))
    } catch (error) {
      writeResponse(STATE_ERROR, encodeValue(encodeError(error)))
    }
  }

  /** 已登记未结算的 ticket 数（诊断/收尾用） */
  function pendingTickets() {
    return tickets.size
  }

  /** 逆转：请求尚未被服务（诊断用，识别宿主没在事件循环里服务同步调用） */
  function requestPending() {
    return Atomics.load(header, SLOT_STATE) === STATE_IDLE && Atomics.load(header, SLOT_LENGTH) > 0
  }

  return { sab, serve, pendingTickets, requestPending, payloadBytes, log: onLog }
}

/**
 * Worker 侧通道。
 * @param options.sab 宿主传来的共享槽
 * @param options.notify (message) => void  Worker→宿主 的消息发送（请求通知）
 * @param options.timeoutMs 同步调用等待上限（超时=响亮失败）
 */
export function createWorkerChannel({ sab, notify, timeoutMs = 30000, payloadBytes = DEFAULT_PAYLOAD_BYTES } = {}) {
  if (!(sab instanceof SharedArrayBuffer)) throw ipcFail(IPC_ERRORS.protocol, 'Worker 通道需要 SharedArrayBuffer')
  const { header, payload } = views(sab)
  let seq = 0

  /** 发起同步调用；返回 {kind:'value', value} 或 {kind:'promise', promise} */
  function call(request) {
    const bytes = encodeValue(request)
    if (bytes.length > payloadBytes) throw ipcFail(IPC_ERRORS.oversize, `同步调用参数超过共享槽容量（${bytes.length} > ${payloadBytes}）`)
    seq += 1
    payload.set(bytes, 0)
    Atomics.store(header, SLOT_LENGTH, bytes.length)
    Atomics.store(header, SLOT_STATE, STATE_IDLE)
    notify({ type: 'hostcall', seq })
    const waited = Atomics.wait(header, SLOT_STATE, STATE_IDLE, timeoutMs)
    if (waited === 'timed-out') {
      throw ipcFail(IPC_ERRORS.timeout, `宿主 API 同步调用超时 ${timeoutMs}ms（宿主未在事件循环内服务：疑似死锁或宿主卡死）`)
    }
    const state = Atomics.load(header, SLOT_STATE)
    const length = Atomics.load(header, SLOT_LENGTH)
    if (state === STATE_VALUE) return { kind: 'value', value: decodeValue(payload.subarray(0, length)) }
    if (state === STATE_TICKET) return { kind: 'ticket', ticket: Atomics.load(header, SLOT_TICKET) }
    if (state === STATE_ERROR) {
      const detail = decodeValue(payload.subarray(0, length))
      const error = new Error(detail.message)
      error.name = detail.name || 'Error'
      if (detail.code) error.code = detail.code
      if (detail.stack) error.stack = detail.stack
      throw error
    }
    throw ipcFail(IPC_ERRORS.protocol, `未知通道状态：${state}`)
  }

  return { sab, call, timeoutMs, payloadBytes }
}
