// 唯一上游计算接入：策略、私有草稿与任务静止；不实现卡算法或运行时兼容。
export const UPSTREAM_COMPUTE_MARKER = '// [dsh-tavern-upstream-compute:v1]'
export function replaceOnce(source, before, after, label = before.slice(0, 80)) {
  if (source.split(before).length !== 2) throw Error('上游计算接入锚点缺失/重复：' + label)
  return source.replace(before, after)
}
export function applyUpstreamComputeHost(source) {
  const once = (before, after) => { source = replaceOnce(source, before, after) }
  source = "import { authorizeUpstreamCall, pageView, computationBlocked, upstreamRequest } from './domain/storage-upstream-compute.js'\n" + UPSTREAM_COMPUTE_MARKER + '\n' + source
  once('  // Sessions whose page last reported being visible, in front, on a desktop.\n  const pagesInFront = new Map()\n  const pageInFront = sessionId => Date.now() - (pagesInFront.get(String(sessionId || \'\')) || 0) < 25000\n', '')
  once("    // A page in front of the player executes card scripts itself; otherwise\n    // (closed, hidden, or a phone) the server runtime takes over.\n    priority: (runtimeId, sessionId) => !serverScripts ? 0\n      : String(runtimeId).startsWith('server-') ? (pageInFront(sessionId) ? 0 : 1) : (pageInFront(sessionId) ? 1 : 0)", '    // 父进程身份决定执行权，页面不注册计算presence。\n    priority: () => 0')
  once('if (serverScripts && !pageInFront(sessionId)) serverScripts.demand(sessionId)', 'if (serverScripts && !computationBlocked(sessionId)) serverScripts.demand(sessionId)')
  once('  async function dispatchMethod(method, args, serverTemplate = false) {', `  async function dispatchMethod(method, args, serverTemplate = false) {
    const deniedClaim = authorizeUpstreamCall(method, args, id => {
      if (!isReadOnlySession(id)) serverScripts?.demand(id)
    })
    if (deniedClaim) return deniedClaim`)
  const begin = source.indexOf("\t  case 'claimTavernScriptWork': {")
  const end = source.indexOf("\t  case 'startTavernScriptWork':", begin)
  if (begin < 0 || end < 0) throw Error('上游claim实际区块缺失')
  source = source.slice(0, begin) + "\t  case 'claimTavernScriptWork': return await tavernScriptHostAdapter.claimWork(args && args.sessionId, args && args.runtimeId, args && args.ready, args && args.initializationError, args && args.contextBaseline)\n" + source.slice(end)
  once('return sessionViews.response(args || {})', `const result = await sessionViews.response(args || {})
        if (!upstreamRequest(args?.sessionId) && result?.view?.chatId && !legacyViewSeams.readOnlyChat(result.view.chatId)) serverScripts?.demand(args?.sessionId)
        return pageView(result, args?.sessionId)`)
  once('    requiresBrowser: async chat => hasTavernScriptRuntime(chat, (await readCardExtensions(chat.cardPath, chat))?.helperScripts)', '    requiresBrowser: async () => false')
  once("owner: chat.mvu.owner === 'official' ? 'official' : 'legacy',", "owner: 'official',")
  once('createOpeningPreparation({ readCard, worldBooks, extensionSettings:', 'createOpeningPreparation({ readCard, worldBooks, compute: () => serverScripts, readRuntimePolicy: readTavernSettings, extensionSettings:')
  once("  // Card scripts run on the server by default; DSH_TAVERN_SERVER_SCRIPTS=0 leaves them to the page.\n  if (process.env.DSH_TAVERN_SERVER_SCRIPTS !== '0') {", '  { // 不提供禁用服务端后回落页面的开关。')
  once('preparationId ? openingPreparation.resolve(preparationId, cardPath, openingId) : undefined', 'preparationId ? await openingPreparation.resolve(preparationId, cardPath, openingId) : undefined')
  once('      handle: (req, res) => tavernHttpHandle(req, res),', `      handle: (req, res) => tavernHttpHandle(req, res),
      canDemand: sessionId => !computationBlocked(sessionId),
      invalidate: sessionId => { tavernScriptDispatch.dispose(sessionId); helperGenerationTasks.stopAll(sessionId) },
      openingRequest: (id, method, args) => openingPreparation.workerRequest(id, method, args),`)
  return source
}

export function applyUpstreamExecutor(source) {
  let next = "import { runUpstreamRequest } from './storage-upstream-compute.js'\n" + UPSTREAM_COMPUTE_MARKER + '\n' + source
  const once = (before, after) => { next = replaceOnce(next, before, after) }
  once('busy = () => false, lingerMs', 'busy = () => false, canDemand = () => true, invalidate = () => {}, openingRequest, lingerMs')
  once('const ALLOWED_METHODS = new Set([', "const ALLOWED_METHODS = new Set(['confirmSessionPatch',")
  once('  const records = new Map(), retryAfter = new Map()', '  const records = new Map(), retryAfter = new Map(), pending = new Map(), closing = new Map(), openingWaiters = new Map()\n  let disposed = false')
  once('本次运行改由页面执行卡脚本', '暂停本次服务端尝试；任务保留，禁止客户端计算')
  // 私有开局有自己的超时与取消；等待初始化/IPC期间不能被普通空闲回收器提前终止。
  once('if (now() - record.demandedAt <= lingerMs) continue', 'if (openingWaiters.has(record.sessionId) || now() - record.demandedAt <= lingerMs) continue')
  once('    records.delete(sessionId)\n    record.stopSignals()', "    records.delete(sessionId)\n    invalidate(sessionId)\n    openingWaiters.get(sessionId)?.reject(new Error('服务端开局任务已失效'))\n    openingWaiters.delete(sessionId)\n    record.stopSignals()")
  once('  async function answer(record, message) {', `  function track(id, work) {
    const task = Promise.resolve().then(work)
    if (!pending.has(id)) pending.set(id, new Set())
    pending.get(id).add(task)
    task.finally(() => { const tasks = pending.get(id); tasks?.delete(task); if (!tasks?.size) pending.delete(id) }).catch(() => {})
    return task
  }
  async function whenIdle(id) {
    while (pending.get(id)?.size || closing.get(id)?.size) {
      await Promise.allSettled([...pending.get(id) || [], ...closing.get(id) || []])
    }
  }
  async function opening(id, timeoutMs = 30000) {
    const key = 'opening:' + id
    if (openingWaiters.has(key)) throw new Error('私有开局计算正在执行')
    let timer
    const done = new Promise((resolve, reject) => {
      openingWaiters.set(key, { resolve, reject })
      timer = setTimeout(() => { stop(key); reject(new Error('上游私有开局计算超时')) }, timeoutMs)
    })
    try {
      try { demand(key) } catch (error) { openingWaiters.get(key)?.reject(error) }
      if (!records.has(key)) openingWaiters.get(key)?.reject(new Error('服务端不可用或容量已满，开局未完成'))
      await done
      await whenIdle(key)
    } catch (error) { stop(key); await whenIdle(key); throw error }
    finally { clearTimeout(timer); openingWaiters.delete(key) }
  }
  async function answer(record, message) {`)
  once("      const path = String(message.path || '')", "      if (!record.isCurrent()) throw new Error('上游计算请求已失效')\n      const path = String(message.path || '')")
  once('      // The session is pinned: a card cannot address another game through this channel.', `      // worker没有真实页面，不安装页面历史门面；此探测不授予计算身份。
      if (method === 'confirmSessionPatch') { reply({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: true, installed: false })).toString('base64') }); return }
      if (record.sessionId.startsWith('opening:') && message.method === 'POST') {
        const result = await runUpstreamRequest(record, () => openingRequest(record.sessionId.slice(8), method, message.body ? JSON.parse(message.body) : {}))
        reply({ status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: true, ...result })).toString('base64') })
        return
      }
      // sessionId由父进程钉定，卡脚本不能调用另一游戏。`)
  once('Promise.resolve(handle(req, res)).catch(reject)', 'Promise.resolve(runUpstreamRequest(record, () => handle(req, res))).catch(reject)')
  once('    if (!id) return', '    if (!id || disposed || !canDemand(id)) return')
  once('    if (existing) { existing.demandedAt = now(); return }', '    if (existing) { existing.demandedAt = now(); return }\n    if (pending.get(id)?.size || closing.get(id)?.size) return')
  once('// A host that cannot run the headless runtime keeps the page path: after\n    // repeated failures stop trying instead of respawning on every claim.', '// 上游不可用仅暂停服务端尝试，不转交页面或旧引擎。')
  once('// At capacity, leave this game to its page (or let it wait for a slot):\n    // evicting would let retained pages of other games restart theirs in a loop.', '// 容量已满只等待，不转交页面。')
  once("const record = { sessionId: id, child, demandedAt: now(), stderr: '', stopSignals: () => {} }", "const record = { sessionId: id, child, demandedAt: now(), stderr: '', stopSignals: () => {}, isCurrent: () => !disposed && records.get(id) === record && canDemand(id) }")
  once('    records.set(id, record)', `    records.set(id, record)
    const closed = new Promise(resolve => child.once('close', resolve))
    if (!closing.has(id)) closing.set(id, new Set())
    closing.get(id).add(closed)
    closed.then(() => { const tasks = closing.get(id); tasks?.delete(closed); if (!tasks?.size) closing.delete(id) })`)
  // 活worker的close不能计入业务idle，否则opening永远等不到；只在stop/exit后join。
  once('...closing.get(id) || []', '...(records.has(id) ? [] : closing.get(id) || [])')
  once('pending.get(id)?.size || closing.get(id)?.size) {', 'pending.get(id)?.size || (!records.has(id) && closing.get(id)?.size)) {')
  once("if (message.type === 'fetch') void answer(record, message)", "if (message.type === 'fetch') void track(id, () => answer(record, message))\n      else if (message.type === 'opening-ready' && record.isCurrent()) openingWaiters.get(id)?.resolve()")
  once('        records.delete(id)\n        record.stopSignals()', "        records.delete(id)\n        invalidate(id)\n        openingWaiters.get(id)?.reject(new Error('上游开局进程退出'))\n        openingWaiters.delete(id)\n        record.stopSignals()")
  once('    demand, stop,', '    demand, stop, whenIdle, opening,')
  once('dispose() { clearInterval(reaper);', 'dispose() { disposed = true; clearInterval(reaper);')
  return next
}

export function applyUpstreamWorker(source) {
  const addition = `  if (sessionId.startsWith('opening:')) {
    const result = await readView(sessionId)
    const runtime = exports.createTavernHelperScriptRuntime({ window: w, document,
      rpc: async (method, args = {}) => {
        const response = await w.fetch('/api/dsh-tavern/' + method, { method: 'POST', body: JSON.stringify(args) })
        const result = await response.json()
        if (!result.ok) throw new Error(result.error || '私有开局宿主调用失败')
        return result
      },
      onMutation() {},
      onReady: async () => {
        try {
          const current = await readView(sessionId)
          await runtime.emit('CHAT_CHANGED', [current.view.chatId], current.view.tavernHelper)
          const state = runtime.inspect()
          if (state.initializationError || state.mvuDataReady === false || state.scripts.some(item => item.initializationFailed)) throw new Error(state.initializationError || '上游开局初始化失败')
          send({ type: 'opening-ready' })
        } catch (error) { send({ type: 'failed', error: String(error?.stack || error) }) }
      },
      reportError: (source, error) => { log('error', source, error); send({ type: 'failed', error: String(error?.stack || error) }) }, resolveError() {}
    })
    runtime.sync(sessionId, result.view)
    return
  }
`
  const marked = replaceOnce(source, "  w.eval(await readFile(clientUrl, 'utf8'))", "  w.__dshUpstreamServerCompute = true\n  w.eval(await readFile(clientUrl, 'utf8'))")
  return replaceOnce(marked, '  const owner = exports.createTavernScriptSessionOwner({', addition + '  const owner = exports.createTavernScriptSessionOwner({')
}

// 上游取消回执不等于底层模型operation结束；撤销必须join已受理的operation。
export function applyUpstreamGenerationTasks(source) {
  let next = replaceOnce(source, '  const sessions = new Map()', '  const sessions = new Map()\n  const operations = new Map()')
  next = replaceOnce(next, '        return operation(controller.signal, id)', `        const pending = Promise.resolve().then(() => operation(controller.signal, id))
        if (!operations.has(sessionId)) operations.set(sessionId, new Set())
        operations.get(sessionId).add(pending)
        pending.finally(() => { const tasks = operations.get(sessionId); tasks?.delete(pending); if (!tasks?.size) operations.delete(sessionId) }).catch(() => {})
        return pending`)
  return replaceOnce(next, '  return { run, stop, stopAll, dispose }', `  async function whenIdle(sessionId) {
    while (operations.get(sessionId)?.size) await Promise.allSettled([...operations.get(sessionId)])
  }
  return { run, stop, stopAll, dispose, whenIdle }`)
}

export function applyUpstreamClient(source) {
  const anchor = 'function sync(sessionId, view) {\n\t\t\t\tconst nextSessionId = String(sessionId || "");\n\t\t\t\tif (activeSessionId && activeSessionId !== nextSessionId) clear();'
  // 幂等：本接缝把 const nextSessionId 前插一行守卫，替换后原 anchor 字符串就不再完整匹配，
  // 二次施缝（同链重复安装 / check 的 buildCore 对比）会报"锚点缺失"。已注入过就直接返回，
  // 与其它 transform 的 marker 守卫同效；未注入才走 replaceOnce 的严格唯一校验。
  if (source.includes('if (hostWindow.__dshUpstreamServerCompute !== true) { clear(); return; }')) return source
  return replaceOnce(source, anchor, anchor.replace('const nextSessionId', 'if (hostWindow.__dshUpstreamServerCompute !== true) { clear(); return; }\n\t\t\t\tconst nextSessionId'))
}
