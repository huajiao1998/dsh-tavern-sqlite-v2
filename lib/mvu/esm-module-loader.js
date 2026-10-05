// 原生VM模块图加载器：不转译ESM、不用宿主import逃离卡上下文。源码缓存不是业务存档。
// node:vm不是安全隔离；DNS预检不能消除fetch二次解析的重绑定风险，真正防SSRF仍需出站策略。
import vm from 'node:vm'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const MAX_SOURCE_BYTES = 5 * 1024 * 1024
const MAX_GRAPH_BYTES = 32 * 1024 * 1024
const MAX_MODULES = 128
const MAX_CACHE_BYTES = 24 * 1024 * 1024
const MAX_CACHE_ENTRIES = 128
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const memorySources = new Map()
const FACADE_NAMES = new Set(['tavern-helper', '@dsh/tavern-helper'])
const fail = (code, message) => Object.assign(new Error(message), { code })

function publicAddress(address) {
  const ip = String(address).toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
  }
  // 仅全球单播2000::/3；也拒绝展开写法的loopback、mapped IPv4、链路本地。
  if (isIP(ip) === 6) return /^[23][0-9a-f]{0,3}:/.test(ip) && !ip.startsWith('2001:db8:')
  return false
}

function validateUrl(value, allowedHosts) {
  let url
  try { url = new URL(value) } catch { throw fail('ESM_URL_DENIED', 'ESM模块URL无效：' + value) }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || host === 'localhost' || /(?:\.localhost|\.local|\.internal)$/.test(host)
    || (isIP(host) ? !publicAddress(host) : !host.includes('.'))
    || (allowedHosts && !allowedHosts.has(host))) {
    throw fail('ESM_URL_DENIED', 'ESM只允许无凭据的公网HTTPS模块（443端口）：' + url.origin)
  }
  url.hash = ''
  return url
}

/** load完成原生link+evaluate（含TLA）；动态import也必须返回已执行的同context模块。 */
export function createEsmModuleLoader({
  context, hostApi = {}, timeoutMs = 8000, loadTimeoutMs = 60000, cacheDir,
  fetchImpl = globalThis.fetch, lookupImpl = lookup, isDisposed = () => false,
  onBrowserModule, classify, allowedHosts,
} = {}) {
  if (typeof vm.SourceTextModule !== 'function' || typeof vm.SyntheticModule !== 'function') {
    throw fail('ESM_VM_MODULES_UNAVAILABLE', '服务端ESM需要Node启动参数 --experimental-vm-modules；当前进程未启用，拒绝转译或绕到宿主执行')
  }
  if (!vm.isContext(context)) throw fail('ESM_CONTEXT_REQUIRED', 'ESM必须使用当前卡运行时的VM上下文')
  if (allowedHosts !== undefined && (!Array.isArray(allowedHosts) || allowedHosts.some(value => typeof value !== 'string' || !value || value.trim() !== value))) {
    throw fail('ESM_ALLOWLIST_INVALID', 'ESM allowedHosts必须是明确域名字符串数组；错误配置不能静默取消白名单')
  }
  const allow = allowedHosts === undefined ? null : new Set(allowedHosts.map(value => value.toLowerCase()))
  const modules = new Map(), canonicalModules = new Map(), linking = new Map(), evaluating = new Map(), controllers = new Set(), timers = new Set()
  const dynamicTasks = new Set(), dynamicFailures = []
  let disposed = false, graphBytes = 0, cache = null
  let cancel
  const cancellation = new Promise((_resolve, reject) => { cancel = reject })
  cancellation.catch(() => {})
  const assertOpen = () => { if (disposed || isDisposed()) throw fail('CARD_RUNTIME_DISPOSED', 'ESM运行时已释放，模块结果作废') }
  const bounded = async (promise, label) => {
    promise.catch(() => {})
    assertOpen()
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(fail('ESM_LOAD_TIMEOUT', 'ESM加载/顶层await超时：' + label)), loadTimeoutMs)
      timers.add(timer)
    })
    try { const result = await Promise.race([promise, timeout, cancellation]); assertOpen(); return result }
    catch (error) { if (error?.code === 'ESM_LOAD_TIMEOUT') dispose(); throw error }
    finally { clearTimeout(timer); timers.delete(timer) }
  }
  if (cacheDir) {
    mkdirSync(cacheDir, { recursive: true })
    cache = new DatabaseSync(path.join(cacheDir, 'esm-source-cache.db'))
    cache.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS module_sources (url TEXT PRIMARY KEY, source TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at INTEGER NOT NULL, used_at INTEGER NOT NULL)')
  }
  function cacheRead(url) {
    let entry = cache ? undefined : memorySources.get(url)
    if (cache) {
      const row = cache.prepare('SELECT source, bytes, saved_at FROM module_sources WHERE url=?').get(url)
      if (row) entry = { source: row.source, bytes: Number(row.bytes), savedAt: Number(row.saved_at) }
    }
    if (!entry || Date.now() - entry.savedAt > CACHE_TTL_MS) { memorySources.delete(url); return null }
    if (!cache) { memorySources.delete(url); memorySources.set(url, entry) }
    if (cache) cache.prepare('UPDATE module_sources SET used_at=? WHERE url=?').run(Date.now(), url)
    return entry.source
  }
  function cacheSave(url, source) {
    assertOpen()
    const entry = { source, bytes: Buffer.byteLength(source, 'utf8'), savedAt: Date.now() }
    if (!cache) {
      memorySources.delete(url); memorySources.set(url, entry)
      let bytes = [...memorySources.values()].reduce((sum, item) => sum + item.bytes, 0)
      while (memorySources.size > MAX_CACHE_ENTRIES || bytes > MAX_CACHE_BYTES) {
        const [key, item] = memorySources.entries().next().value
        bytes -= item.bytes; memorySources.delete(key)
      }
      return
    }
    cache.prepare('INSERT INTO module_sources VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET source=excluded.source,bytes=excluded.bytes,saved_at=excluded.saved_at,used_at=excluded.used_at')
      .run(url, source, entry.bytes, entry.savedAt, entry.savedAt)
    const rows = cache.prepare('SELECT url, bytes FROM module_sources ORDER BY used_at DESC').all()
    let total = 0
    rows.forEach((row,index) => { total += Number(row.bytes); if (index >= MAX_CACHE_ENTRIES || total > MAX_CACHE_BYTES) cache.prepare('DELETE FROM module_sources WHERE url=?').run(row.url) })
  }
  async function checkedUrl(value) {
    const url = validateUrl(value, allow)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!isIP(host)) {
      const addresses = await lookupImpl(host, { all: true, verbatim: true })
      assertOpen()
      if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw fail('ESM_URL_DENIED', 'ESM域名解析包含非公网地址：' + host)
    }
    return url
  }
  async function download(value) {
    const initial = await checkedUrl(value)
    const saved = cacheRead(initial.href)
    if (saved !== null) return { source: saved, identifier: initial.href, cached: true }
    const controller = new AbortController(); controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), loadTimeoutMs); timers.add(timer)
    try {
      let url = initial
      for (let redirects = 0; redirects <= 3; redirects++) {
        assertOpen()
        const response = await fetchImpl(url.href, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/javascript, application/javascript, application/ecmascript, text/plain' } })
        assertOpen()
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel?.()
          if (!location || redirects === 3) throw fail('ESM_REDIRECT_DENIED', 'ESM远程模块重定向过多或无目标')
          url = await checkedUrl(new URL(location, url).href)
          continue
        }
        if (!response.ok) throw fail('ESM_FETCH_FAILED', 'ESM模块HTTP失败：' + response.status + ' ' + url.href)
        const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        if (!['text/javascript','application/javascript','application/ecmascript','text/ecmascript','text/plain','application/octet-stream'].includes(mime)) {
          await response.body?.cancel?.(); throw fail('ESM_CONTENT_TYPE_DENIED', 'ESM响应不是JavaScript源码：' + mime)
        }
        if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) {
          await response.body?.cancel?.(); throw fail('ESM_SOURCE_LIMIT', 'ESM单模块超过5MiB限额')
        }
        if (!response.body?.getReader) throw fail('ESM_FETCH_FAILED', 'ESM响应缺少有界流读口')
        const reader = response.body.getReader(), chunks = []
        let bytes = 0
        try {
          while (true) {
            const { done, value: chunk } = await reader.read()
            assertOpen()
            if (done) break
            bytes += chunk.byteLength
            if (bytes > MAX_SOURCE_BYTES) { await reader.cancel(); throw fail('ESM_SOURCE_LIMIT', 'ESM单模块超过5MiB限额') }
            chunks.push(chunk)
          }
        } finally { reader.releaseLock() }
        return { source: Buffer.concat(chunks).toString('utf8'), identifier: url.href, requested: initial.href, cached: false }
      }
    } finally { clearTimeout(timer); timers.delete(timer); controllers.delete(controller) }
  }
  function resolve(specifier, ref) {
    if (FACADE_NAMES.has(specifier)) return specifier
    let url
    try { url = new URL(specifier, ref.identifier) } catch { throw fail('ESM_SPECIFIER_DENIED', 'ESM不支持宿主包或无HTTPS基准的相对import：' + specifier) }
    return validateUrl(url.href, allow).href
  }
  function facade(identifier) {
    const names = Object.keys(hostApi).filter(name => name !== 'default')
    return new vm.SyntheticModule([...names, 'default'], function () {
      for (const name of names) this.setExport(name, hostApi[name])
      this.setExport('default', hostApi)
    }, { context, identifier })
  }
  function compile(source, identifier) {
    assertOpen()
    const bytes = Buffer.byteLength(source, 'utf8')
    if (bytes > MAX_SOURCE_BYTES || graphBytes + bytes > MAX_GRAPH_BYTES) throw fail('ESM_SOURCE_LIMIT', 'ESM源码或模块图超过字节限额')
    if (classify?.(source) === 'browser-ui') {
      onBrowserModule?.(identifier)
      throw Object.assign(fail('card-script-dom', 'ESM依赖图含浏览器脚本，不在服务端执行：' + identifier), { domProbe: { source: identifier, prop: 'module-graph', op: 'load' } })
    }
    const module = new vm.SourceTextModule(source, {
      context, identifier,
      initializeImportMeta(meta) { meta.url = identifier },
      importModuleDynamically,
    })
    graphBytes += bytes
    return module
  }
  async function getModule(identifier, inlineSource) {
    assertOpen()
    if (modules.has(identifier)) return modules.get(identifier)
    if (modules.size >= MAX_MODULES) throw fail('ESM_GRAPH_LIMIT', 'ESM模块图超过128个模块')
    const task = (async () => {
      if (FACADE_NAMES.has(identifier)) return facade(identifier)
      if (inlineSource !== undefined) return compile(inlineSource, identifier)
      const source = await download(identifier)
      assertOpen()
      // 请求URL promise与最终URL module分表：若这里await modules.get(finalURL)，两条重定向
      // 请求可能互等自身/彼此。compile是同步原子段，谁先拿到最终源码谁登记唯一模块实例。
      if (canonicalModules.has(source.identifier)) return canonicalModules.get(source.identifier)
      const module = compile(source.source, source.identifier)
      canonicalModules.set(source.identifier, module)
      if (!modules.has(source.identifier)) modules.set(source.identifier, Promise.resolve(module))
      // 只有语法编译成功的源码入缓存；网络失败不悄悄回退旧版本。
      // 重定向后的源码只按最终URL缓存，避免下次误用原URL作为相对import的base。
      if (!source.cached) cacheSave(source.identifier, source.source)
      return module
    })()
    modules.set(identifier, task)
    task.catch(() => {})
    return task
  }
  async function link(module) {
    assertOpen()
    if (module.status === 'linked' || module.status === 'evaluating' || module.status === 'evaluated') return
    if (linking.has(module)) return linking.get(module)
    // linker只提供依赖模块；递归/循环链接交由原生Module.link，不能在linker再次await依赖link。
    const task = module.link((specifier, ref, attributes) => {
      if (attributes && Object.keys(attributes.attributes || attributes.assert || {}).length) throw fail('ESM_IMPORT_ATTRIBUTES_DENIED', 'ESM仅支持JavaScript模块，不伪造JSON/import attributes语义')
      return getModule(resolve(specifier, ref))
    })
    linking.set(module, task); task.catch(() => {})
    await task
  }
  async function evaluate(module) {
    assertOpen()
    if (module.status === 'evaluated') return module
    if (module.status === 'errored') throw module.error
    if (!evaluating.has(module)) {
      const task = module.evaluate({ timeout: timeoutMs })
      evaluating.set(module, task); task.catch(() => {})
    }
    await evaluating.get(module)
    assertOpen()
    return module
  }
  function importModuleDynamically(specifier, ref, attributes) {
    if (attributes && Object.keys(attributes).length) return Promise.reject(fail('ESM_IMPORT_ATTRIBUTES_DENIED', 'ESM仅支持JavaScript模块，不伪造JSON/import attributes语义'))
    const task = bounded((async () => { const module = await getModule(resolve(String(specifier), ref)); await link(module); return evaluate(module) })(), String(specifier))
    dynamicTasks.add(task)
    task.then(() => dynamicTasks.delete(task), error => { dynamicTasks.delete(task); dynamicFailures.push(error) })
    return task
  }
  async function load({ code, name = 'card-script', identifier } = {}) {
    const key = identifier || (/^https:\/\//.test(name) ? validateUrl(name, allow).href : 'dsh:script/' + encodeURIComponent(name))
    return bounded((async () => { const module = await getModule(key, String(code ?? '')); await link(module); return evaluate(module) })(), key)
  }
  function dispose() {
    if (disposed) return
    disposed = true
    cancel(fail('CARD_RUNTIME_DISPOSED', 'ESM加载器已释放，迟到模块不可提交'))
    for (const controller of controllers) controller.abort()
    controllers.clear()
    for (const timer of timers) clearTimeout(timer)
    timers.clear(); modules.clear(); canonicalModules.clear(); linking.clear(); evaluating.clear()
    cache?.close(); cache = null
  }
  return { load, importModuleDynamically, dispose, async waitForImports() { while (dynamicTasks.size) await Promise.all([...dynamicTasks]); if (dynamicFailures.length) throw dynamicFailures[0]; assertOpen() } }
}
