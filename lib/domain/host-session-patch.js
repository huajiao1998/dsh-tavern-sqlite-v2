// In-memory host/client patch for DSH 0.1.5-rc.2. Official package files stay unchanged.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, sep } from 'node:path'
import { applyRollbackSyncClientTransform } from '../../deploy/rollback-sync-client-transform.mjs'

export async function prepareExpandedPatch(runtime, options = {}) {
  const expectedVersion = options.version ?? '0.1.6-alpha.2'
  const marker = 'dsh-tavern/required-session-patch-v1'
  const require = createRequire(join(runtime, 'package.json'))
  const originals = new Map()
  const urls = new Map()
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  // Tavern rollback preserves the original provider, so provider allowlists
  // cannot represent ownership. This experimental profile-wide fix permits
  // citations on replacement only, for every provider; append stays native.
  const own = "(event.surfaceOp?.op === 'replace')"
  async function source(name) {
    const path = require.resolve(name)
    const text = await readFile(path, 'utf8')
    originals.set(path, text)
    return { path, text }
  }
  function once(text, before, after) {
    assert.equal(text.split(before).length, 2, 'Pinned patch target drifted: ' + before)
    return text.replace(before, after)
  }
  async function compile(name, transform = text => text) {
    const { path, text } = await source(name)
    const localRequire = createRequire(path)
    function resolveSpecifier(specifier) {
      if (urls.has(specifier)) return urls.get(specifier)
      if (/^(node:|file:|data:)/.test(specifier)) return specifier
      return pathToFileURL(localRequire.resolve(specifier)).href
    }
    // data: modules cannot resolve bare specifiers. Rewrite both static and
    // dynamic imports (Windows persistence lazily `import("koffi")`).
    let modified = transform(text)
    modified = modified.replace(/\bfrom\s+"([^"]+)"/g, (_, specifier) => 'from ' + JSON.stringify(resolveSpecifier(specifier)))
    modified = modified.replace(/\bfrom\s+'([^']+)'/g, (_, specifier) => 'from ' + JSON.stringify(resolveSpecifier(specifier)))
    modified = modified.replace(/\bimport\s*\(\s*"([^"]+)"\s*\)/g, (_, specifier) => 'import(' + JSON.stringify(resolveSpecifier(specifier)) + ')')
    modified = modified.replace(/\bimport\s*\(\s*'([^']+)'\s*\)/g, (_, specifier) => 'import(' + JSON.stringify(resolveSpecifier(specifier)) + ')')
    modified = modified.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path).href))
    const url = 'data:text/javascript;base64,' + Buffer.from(modified).toString('base64')
    urls.set(name, url)
    return import(url)
  }
  function facade(name, selectedExports) {
    const text = `export * from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)};\nexport { ${selectedExports.join(', ')} } from ${JSON.stringify(urls.get(name))};`
    urls.set(name, 'data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
  }
  const pkg = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'))
  assert.equal(pkg.version, expectedVersion)
  const { Session } = await load('@deepseek-ai/dsh-session')
  const patchedSurface = await compile('@deepseek-ai/dsh-session/surface', text => once(text,
    "if (event.type === 'assistant/message' && raw !== undefined) {",
    `if (event.type === 'assistant/message' && raw !== undefined && !${own}) {`))
  const surfacePrototype = Object.getPrototypeOf(Session.create('patch-prototype-probe').surface)
  const surfaceDescriptors = Object.fromEntries(['validateNext', '_processDelta'].map(key => [key, Object.getOwnPropertyDescriptor(surfacePrototype, key)]))
  // Append admission, coverage validation, and system-head protection stay native.
  for (const key of Object.keys(surfaceDescriptors)) Object.defineProperty(surfacePrototype, key, Object.getOwnPropertyDescriptor(patchedSurface.SurfaceManager.prototype, key))
  const originalAppend = Session.prototype.append
  const markedSessions = new WeakSet()
  Session.prototype.append = function (type, data, ...args) {
    if (type === 'assistant/message' && args[0]?.surfaceOp?.op === 'replace' && !markedSessions.has(this)) {
      if (!this.snapshotEvents().some(event => event.type === marker)) {
        originalAppend.call(this, marker, { version: 1, hostVersion: pkg.version })
      }
      markedSessions.add(this)
    }
    return originalAppend.call(this, type, data, ...args)
  }
  const restoreSurface = () => {
    Session.prototype.append = originalAppend
    Object.defineProperties(surfacePrototype, surfaceDescriptors)
  }
  try {
    // Stored-event adoption has another bundled copy of the local validator.
    // Cloned storage modules use this copy; the already-live Session service
    // keeps its original identity and the prototype patch above.
    const patchedSession = await compile('@deepseek-ai/dsh-session', text => once(text,
      'if (event.type === "assistant/message" && raw !== void 0) throw',
      `if (event.type === "assistant/message" && raw !== void 0 && !${own}) throw`))
    // Only the in-memory cloned vocabulary understands this required marker.
    // Stock readers refuse the archive instead of treating the edit as a torn tail.
    patchedSession.KNOWN_SESSION_EVENT_TYPES.add(marker)
    // Preserve public class identities: service owners and error consumers
    // imported those classes before this patch. Only validation is replaced.
    facade('@deepseek-ai/dsh-session', ['adoptSessionEvent', 'snapshotSessionEvent', 'foldSurface', 'KNOWN_SESSION_EVENT_TYPES'])
    const patchedStoredPersistence = await compile('@deepseek-ai/dsh-session-persistence', text =>
      `import * as NativeErrors from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href)};\n` +
      text.replace(/\bnew (Session\w+Error)\(/g, 'new NativeErrors.$1(').replace(/\binstanceof (Session\w+Error)\b/g, 'instanceof NativeErrors.$1'))
    facade('@deepseek-ai/dsh-session-persistence', ['validateStoredEvents'])
    // compile() 当场解析并导入依赖；先接好 v0 → v1 → v2，避免 v2 捕获原版 v1/v0。
    // v1 无需改校验，只重编译以转接已补丁的 v0。
    await compile('@deepseek-ai/dsh-session-format-v0-to-v1', text => once(text,
      'if (data["turn"] !== openTurn || data["step"] !== openStep || openTurn === null || openStep === null) throw new SessionFormatError(`${event.type} does not match an open turn and step`);',
      'if ((openTurn !== null || openStep !== null) && (data["turn"] !== openTurn || data["step"] !== openStep)) throw new SessionFormatError(`${event.type} does not match an open turn and step`);'))
    await compile('@deepseek-ai/dsh-session-format-v1-to-v2')
    await compile('@deepseek-ai/dsh-session-format-v2-to-v3', text => once(
      once(text,
        'if (event.type === "assistant/message" && sources !== void 0) throw',
        `if (event.type === "assistant/message" && sources !== void 0 && !${own}) throw`),
      // §4.1/(i) 2026-09-30：放行「turn 之前的 system/message」。
      //   作者写会话初始系统提示时，那条 system/message 会带 turn/step 但**尚无打开的 step**
      //   （cold-read 校验却要求它落在打开的 step 里）⇒ 读写不对称：prod 的档在 prod 活读没事，
      //   搬到别处冷读必炸 `system/message does not match an open step`（实测红字：历史加载失败）。
      //   改法只放宽"没有打开的 step"这一种情形；step 已打开但 turn/step 不匹配**照旧报错**。
      'if (step === void 0 || step.turn !== data["turn"] || step.step !== data["step"]) throw new SessionFormatError("system/message does not match an open step");',
      'if (step !== void 0 && (step.turn !== data["turn"] || step.step !== data["step"])) throw new SessionFormatError("system/message does not match an open step");'))
    // ⚠ 同一类校验在**多个代际模块里各有一份**（实测：修好 v2-to-v3 那份后，红字换成
    //   `assistant/message does not match an open turn and step` —— 它来自 v0-to-v1；另一份在
    //   jsonl 后端的 worker 线程里，见 preparePatchedWorker）。三处口径统一：
    //   **没有打开的轮/步时放行**；有打开的轮/步时照旧严格。
    const { sessionFormatCatalog: catalog } = await compile('@deepseek-ai/dsh-session-format-catalog')
    // ⚠ 读取路径的校验**还有一份在 jsonl 后端的 worker 线程里**（`lib/worker.cjs`，独立文件 ⇒
    //   `data:` 内存改写打不到它；本环境实测：v2-to-v3 那份放行后，红字换成 worker 里的
    //   `assistant/message does not match an open turn and step`）。
    //   做法：把 worker.cjs **复制并打补丁**到临时目录（内容寻址命名，官方文件零改动），
    //   再把主模块里 spawn 的地址改写指向这份副本 —— `compile()` 会把 `import.meta.url` 换成
    //   原文件的 file:// URL，所以 `new URL(<绝对 file: URL>)` 合法。
    //   两条放行（都是"上游读写不对称"）：① 没有打开的 turn/step 时允许 message（作者会在
    //   turn 之外写 system 提示与 surfaceOp 的 assistant 改写）；② 同 v2-to-v3 的 system/message。
    const patchedWorker = preparePatchedWorker(require)
    const { default: PatchedPersistence } = await compile('@deepseek-ai/dsh-session-persistence-jsonl',
      text => patchedWorker === undefined ? text : once(text,
        'entry: new URL("./worker.cjs", import.meta.url),',
        `entry: new URL(${JSON.stringify(patchedWorker)}),`))
    // Tavern take-over: the SQLite session backend owns every session artifact,
    // so this provider's kernel write lease has nothing left to guard. Its
    // acquireLease/acquireWriteLease run `SessionWriteLease.acquire`, whose only
    // job is creating/`flock`ing `session.lock` in the session directory — with
    // the take-over active that file must never be created, for existing and
    // newly created sessions alike. Neutralizing the methods on the compiled
    // class itself, before patchPersistence() copies them onto the live
    // instance, keeps every copy of this provider on the lock-free path: the
    // echoed descriptors would otherwise reinstate the lease on write-open and
    // recreate session.lock once per boot. In-process single-writer safety is
    // unaffected (tracker claim + SQLite transactions).
    {
      const noLease = async () => ({ release: async () => {} })
      for (const key of ['acquireLease', 'acquireWriteLease']) {
        Object.defineProperty(PatchedPersistence.prototype, key, {
          value: noLease,
          writable: true,
          enumerable: false,
          configurable: true,
        })
      }
    }
    // Guard #74: Windows create/rename path does `await import("koffi")`. If the
    // bare specifier survived into the data: module, new chats fail immediately.
    {
      const encoded = urls.get('@deepseek-ai/dsh-session-persistence-jsonl')
      const decoded = Buffer.from(String(encoded).slice(String(encoded).indexOf(',') + 1), 'base64').toString('utf8')
      assert.doesNotMatch(decoded, /\bimport\s*\(\s*["']koffi["']\s*\)/)
      if (decoded.includes('koffi')) assert.match(decoded, /\bimport\s*\(\s*"file:[^"]*koffi[^"]*"\s*\)/)
    }
    const query = await compile('@deepseek-ai/dsh-session-query', text =>
      `import { SessionQueryError as NativeQueryError } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-query')).href)};\n` +
      text.replace(/\bnew SessionQueryError\(/g, 'new NativeQueryError(').replace(/\binstanceof SessionQueryError\b/g, 'instanceof NativeQueryError') +
      '\nexport { SessionCorpus, SessionObservationReader };')
    const { text: originalClient } = await source('@deepseek-ai/dsh-api-session-controller/client')
    const clientSource = applyRollbackSyncClientTransform(once(originalClient,
      'if (event.type === "assistant/message" && raw !== void 0) throw',
      `if (event.type === "assistant/message" && raw !== void 0 && !${own}) throw`))
    const undoPersistence = []
    return {
      catalog, patchedSurface, clientSource, marker,
      // 冷SQLite恢复使用与catalog相同的补丁词汇和surface，不忽略必需标记。
      restoreStoredSession(stored) {
        const events = structuredClone(stored.events)
        patchedStoredPersistence.validateStoredEvents(stored.header, events)
        return patchedSession.Session.fromRestore(stored.header.id, events, structuredClone(stored.header), stored.inheritedEventCount, 'detached')
      },
      patchQuery(instance) {
        assert.equal(instance._observations.cache.size, 0, 'Install before querying Session history')
        for (const [target, prototype] of [
          [instance, query.SessionQueryEngine.prototype],
          [instance._corpus, query.SessionCorpus.prototype],
          [instance._observations, query.SessionObservationReader.prototype],
        ]) {
          const keys = Reflect.ownKeys(prototype).filter(key => key !== 'constructor')
          const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(target, key)]))
          for (const key of keys) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(prototype, key))
          undoPersistence.push(() => {
            for (const [key, descriptor] of descriptors) {
              if (descriptor) Object.defineProperty(target, key, descriptor)
              else delete target[key]
            }
          })
        }
      },
      patchPersistence(instance) {
        // Existing handles must be closed before this experimental installation.
        // Install own methods on ONE backend instance, not its shared prototype.
        assert.equal(instance.tracker.openHandles.size, 0, 'Install before opening Session handles')
        assert.equal(instance.tracker.writers.size, 0, 'Install before acquiring Session writers')
        // 接管后端（我们的 SQLite 会话后端）拥有这些存储接缝。宿主把服务交给 cordis 时，
        // 服务门面会把实例方法**绑定复制**成自己的 own-property ⇒ 官方补丁一旦把官方
        // stat/open/… 盖到门面上，原档 stat 就变回官方语义（对显式绑定的原档返回 undefined），
        // workspace 登记失败、整棵树起不来（2026-09-30 洁净实例实测）。靠装配后的"重装"
        // 救不回来（经 cordis 服务代理的写入会被丢弃），所以在这里**从源头钉住**：
        // 只装非存储接缝的官方实现，存储接缝一律钉回接管实现。
        // 清单走 globalThis 注册表：门面只复制 own-property，实例上的标记到不了这里。
        const owned = (() => {
          try { return globalThis[Symbol.for('dsh-tavern.session-backend.owned-seams')] } catch { return undefined }
        })()
        const seamKeys = Array.isArray(owned?.keys) ? owned.keys : []
        const seamSet = new Set(seamKeys)
        const keys = Reflect.ownKeys(PatchedPersistence.prototype).filter(key => key !== 'constructor')
        const internal = keys.filter(key => !seamSet.has(key))
        const pinned = seamKeys.filter(key => typeof Object.getOwnPropertyDescriptor(owned?.impl ?? {}, key)?.value === 'function')
        const descriptors = new Map([...internal, ...pinned].map(key => [key, Object.getOwnPropertyDescriptor(instance, key)]))
        const format = instance.generationFormat
        for (const key of internal) Object.defineProperty(instance, key, Object.getOwnPropertyDescriptor(PatchedPersistence.prototype, key))
        for (const key of pinned) {
          const { value } = Object.getOwnPropertyDescriptor(owned.impl, key)
          Object.defineProperty(instance, key, { value, configurable: true, writable: true, enumerable: false })
        }
        instance.generationFormat = {
          ...format,
          currentVersion: catalog.currentVersion,
          // 默认仍严格冷读；迁移调用显式声明的恢复/验证策略必须透传。
          createRestore: (header, restoreOptions = {}) => catalog.createRestore(header, {
            recovery: 'strict', validation: 'current', ...restoreOptions,
          }),
          encodeHeader: (header, count) => catalog.encodeCurrentHeader(header, count),
          encodeEvent: event => catalog.encodeCurrentEvent(event),
        }
        instance.coldLogMemo.clear()
        // A take-over backend (the Tavern SQLite session store) owns the storage
        // seams this copy just overwrote. Let it re-install its own methods right
        // now instead of waiting for its next scheduled re-scan, so no window
        // exists in which a write could reach the stock JSONL provider.
        instance[Symbol.for('dsh-tavern.session-backend.reassert')]?.()
        undoPersistence.push(() => {
          for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(instance, key, descriptor)
            else delete instance[key]
          }
          instance.generationFormat = format
          instance.coldLogMemo.clear()
        })
      },
      async verifyFilesUnchanged() {
        const hashes = []
        for (const [path, text] of originals) {
          assert.equal(await readFile(path, 'utf8'), text)
          hashes.push({ packageFile: path.split('/node_modules/').at(-1), sha256: createHash('sha256').update(text).digest('hex') })
        }
        return hashes
      },
      dispose() {
        for (const undo of undoPersistence.reverse()) undo()
        restoreSurface()
      },
    }
  } catch (error) {
    restoreSurface()
    throw error
  }
}

export const SESSION_PATCH_PROTOCOL = 1
export const SESSION_PATCH_VERSION = '0.1.5-rc.2'
const INSTALLED = Symbol.for('dsh-tavern.host-session-patch.v1')
// Concurrent-installer handshake marker; see claimHostSessionPatch().
const CLAIM = Symbol.for('dsh-tavern-sqlite-v2.host-session-patch.claim')

// Synchronous claim of the INSTALLED guard, so that a second installer cannot slip
// past the idempotence check while this one is still awaiting its host packages.
//
// Why this exists (2026-09-30, reproduced on a stock Tavern at 188): cordis applies
// loader entries concurrently (`Promise.allSettled`, entries 156 and 159), and the
// Tavern plugin installs this very patch from its own entry. Both installers passed
// the guard before either reached the `Object.defineProperty(persistence, INSTALLED)`
// at the end, so the second one threw
//   TypeError: Cannot redefine property: Symbol(dsh-tavern.host-session-patch.v1)
// which failed the whole plugin tree ("plugin tree failed to load") and kept the
// server from booting. The claim is taken in the synchronous prefix of `apply()`
// (before any `await`), which is the only window guaranteed to precede the other
// installer's guard.
//
// The claim object must already look like a handle: the Tavern entry early-returns
// whatever it finds under INSTALLED and immediately calls `view()` / reads
// `loadSessionCatalog` (tavern-plugin/lib/index.js:213-218). All methods here are
// side-effect free; the real handle replaces them in place via publishHandle().
export function claimHostSessionPatch(persistence) {
  if (!persistence || (typeof persistence !== 'object' && typeof persistence !== 'function')) {
    return { ok: false, reason: '没有 sessionPersistence 服务' }
  }
  const existing = persistence[INSTALLED]
  if (existing !== undefined && existing !== null) {
    if (existing[CLAIM] === true) return { ok: true, claim: existing }
    let status = '?'
    try { status = existing.view?.().status ?? '?' } catch { /* unknown shape */ }
    return { ok: false, reason: '宿主会话补丁已安装（status=' + status + '）', existing }
  }
  const claim = {
    view: () => ({ status: 'pending', hostVersion: SESSION_PATCH_VERSION, reason: 'dsh-tavern-sqlite-v2 正在安装宿主会话补丁' }),
    dispose: () => {},
  }
  Object.defineProperty(claim, CLAIM, { value: true, configurable: true })
  Object.defineProperty(persistence, INSTALLED, { value: claim, configurable: true, writable: true, enumerable: false })
  return { ok: true, claim }
}

// Final guard publication. When we hold a claim, upgrade that object **in place**:
// the other installer already returned it to its caller, so swapping the object would
// freeze that reference at "pending" forever. Own methods are `this`-based, so the
// claim must receive the handle's fields as well.
function publishHandle(persistence, handle, claimed) {
  if (claimed && claimed[CLAIM] === true) {
    for (const key of Reflect.ownKeys(handle)) {
      const descriptor = Object.getOwnPropertyDescriptor(handle, key)
      if (!descriptor) continue
      try { Object.defineProperty(claimed, key, { ...descriptor, configurable: true }) } catch { /* best effort */ }
    }
    try { if (Object.getOwnPropertyDescriptor(claimed, CLAIM)?.configurable) delete claimed[CLAIM] } catch { /* marker may stay; our guard accepts it */ }
    return claimed
  }
  try { Object.defineProperty(persistence, INSTALLED, { value: handle, configurable: true }) }
  catch (error) { console.warn('[dsh-tavern-sqlite-v2] 宿主会话补丁守卫被并发装配者抢先钉死，本次句柄未登记：' + (error?.message || error)) }
  return handle
}

// Each entry lists every known-good bytes of that file for 0.1.5-rc.2.
// Official npm is always first. DSHA v0.1.5-rc2 rewrites two packages at
// packaging time (legacy rc.1 session shape + Android atomic publish); those
// variants keep the same Tavern replacement anchors and must be accepted.
const PINNED_SHA256 = Object.freeze({
  '@deepseek-ai/dsh-session/surface': Object.freeze(['aad7aaabe6cd9b39ae4cc3b50a2873c9b5d73b69d929051f31b18ecc13647c72']),
  '@deepseek-ai/dsh-session': Object.freeze(['05e94f57d96e7979670a5b51024c8591572eb0051ce793613dbdec35cf2c47bf']),
  '@deepseek-ai/dsh-session-persistence': Object.freeze(['0dc2a1634e4b6ebb558aac214009da3dc00f54f315762a56a1841d12baf770d4']),
  '@deepseek-ai/dsh-session-format-v2-to-v3': Object.freeze([
    '2d35e1e0ed497af569d5735fc590187de1568489cfe60d070b5f61330cd5a338',
    '8e7cc1aab2eef1099cbca390dd04c4a8ff3e6b3f64bd9e34e2357630b5e65af5',
  ]),
  '@deepseek-ai/dsh-session-format-catalog': Object.freeze(['bf4bde9e6563d7793f820c4a1b3141f6527283dd6c58f16bf43a67bc557cc48c']),
  // v0-to-v1 也带同款 requireOpenStep 校验（冷读时实测命中）⇒ 一并钉扎 + 放行
  '@deepseek-ai/dsh-session-format-v0-to-v1': Object.freeze(['15ae26b90310d83b1b90a5e7cad9e2f34282fddaba2f19f2fd2232382065603d']),
  '@deepseek-ai/dsh-session-format-v1-to-v2': Object.freeze(['23950e7d0366d1bf5f46c9db69cbbfc64c0cfaab786147bdd40d044cefc74584']),
  '@deepseek-ai/dsh-session-persistence-jsonl': Object.freeze([
    '7d0640c9fc4be6c703b77605fdee6af519c542fae28a6cd4489353309812f062',
    'd387931d4ae848152411ec5f152064108b899bd9b5bd813c540afa2274703998',
  ]),
  '@deepseek-ai/dsh-session-query': Object.freeze(['c2a3954a0060942b179a92111cce556f27b8d659a4d815bb0e9defadbdb874da']),
  '@deepseek-ai/dsh-api-session-controller/client': Object.freeze(['ff33d1f85a0b2f14568fcb555d5f52d2ba5f57f2e0ecfa5d7885ba83e7ff6069']),
})

function hostRequireFrom(anchor) {
  return createRequire(createRequire(anchor).resolve('@deepseek-ai/dsh-tools'))
}

// ---- jsonl 后端的 worker 线程补丁副本（见 prepareExpandedPatch 里的调用点）----
// worker.cjs 是**独立文件**（自包含，无相对 require），内存改写打不到 ⇒ 复制+打补丁到临时目录，
// 再把主模块的 spawn 地址指过去。官方文件零改动。
const WORKER_PINNED = Object.freeze({
  relative: 'lib/worker.cjs',
  sha256: Object.freeze(['b067a35a421d5a5313b1e197a00bcc829d8d6921d2829503d4604c13e226fd64']),
})
const WORKER_REPLACEMENTS = Object.freeze([
  Object.freeze([
    // ① 没有打开的 turn/step 时允许消息 —— 上游读写不对称：作者在 turn 之外写会话初始 system
    //    提示，以及对既有楼层做 surfaceOp 的 assistant 改写（本环境 prod 的档实测如此）。
    //    打开的 turn/step 存在时**照旧严格**（保住上游校验价值）。
    'if (data["turn"] !== openTurn || data["step"] !== openStep || openTurn === null || openStep === null) throw new SessionFormatError(`${event.type} does not match an open turn and step`);',
    'if ((openTurn !== null || openStep !== null) && (data["turn"] !== openTurn || data["step"] !== openStep)) throw new SessionFormatError(`${event.type} does not match an open turn and step`);',
  ]),
  Object.freeze([
    // ② 与 v2-to-v3 同款：放行「turn 之前的 system/message」。
    'if (step === void 0 || step.turn !== data["turn"] || step.step !== data["step"]) throw new SessionFormatError("system/message does not match an open step");',
    'if (step !== void 0 && (step.turn !== data["turn"] || step.step !== data["step"])) throw new SessionFormatError("system/message does not match an open step");',
  ]),
])

/** 生成（或复用）打过补丁的 worker 副本，返回它的 file:// URL；拿不到就回 undefined（不阻断装配）。 */
function preparePatchedWorker(require) {
  // 诊断用 console.warn（一定会进 DSH 的 stderr/tavern.log；ctx.logger 不一定）
  const say = message => { try { console.warn('[TAVERN-WORKER-PATCH] ' + message) } catch { /* 忽略 */ } }
  let workerPath
  try {
    workerPath = join(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl').replace(/[\\/]index\.js$/, ''), 'worker.cjs')
    say('解析到 worker: ' + workerPath)
  } catch (error) { say('resolve 失败，跳过：' + (error?.message || error)); return undefined }
  let text
  try { text = readFileSync(workerPath, 'utf8') } catch (error) { say('读取失败，跳过：' + (error?.message || error)); return undefined }
  const actual = createHash('sha256').update(text).digest('hex')
  if (!WORKER_PINNED.sha256.includes(actual)) {
    throw new Error('jsonl worker 与钉扎清单不一致（上游动了校验代码）：' + workerPath + ' sha256=' + actual)
  }
  say('钉扎通过 sha256=' + actual.slice(0, 16))
  let patched = text
  for (const [before, after] of WORKER_REPLACEMENTS) {
    assert.equal(patched.split(before).length, 2, 'worker 补丁锚点漂移：' + before.slice(0, 64))
    patched = patched.replace(before, after)
  }
  say('两处放行已写入内存副本')
  const digest = createHash('sha256').update(patched).digest('hex').slice(0, 16)
  // ⚠ 副本必须放在**原文件旁边**（同目录）：worker.cjs 里有 `require('../package.json')` 这类
  //   **上层相对依赖**（2026-09-30 实测：放 /tmp 会 `Cannot find module '../package.json'`，
  //   副本起不来 ⇒ 宿主等 worker ⇒ 前端报「DSH Session 列表同步超时」）。
  //   仍是**新增文件**，官方文件零改动；名字内容寻址，重复安装幂等复用。
  const target = join(dirname(workerPath), 'worker.tavern-' + digest + '.cjs')
  try {
    if (existsSync(target)) say('副本已存在（复用）: ' + target)
    else { writeFileSync(target, patched, 'utf8'); say('已写出副本: ' + target) }
  } catch (error) {
    throw new Error('无法写出打过补丁的 worker 副本（需要该目录可写）：' + (error?.message || error))
  }
  return pathToFileURL(target).href
}

// The plugin file lives in this repo. The running host packages live next to
// the dsh launcher. Pick the copy that actually constructed the live store.
export async function defaultHostRequire(persistence) {
  const anchors = [fileURLToPath(new URL('../../package.json', import.meta.url))]
  if (process.argv[1]) anchors.push(process.argv[1])
  const found = []
  const errors = []
  for (const anchor of anchors) {
    try { found.push(hostRequireFrom(anchor)) }
    catch (error) { errors.push(error) }
  }
  if (!found.length) throw errors.at(-1) || new Error('无法解析宿主包')
  if (!persistence) return found[0]
  for (const candidate of found) {
    const loaded = await import(pathToFileURL(candidate.resolve('@deepseek-ai/dsh-session-persistence')).href)
    if (Object.values(loaded).some(exported => typeof exported === 'function' && persistence instanceof exported)) return candidate
  }
  throw new Error('解析到的宿主包与正在运行的会话存储不是同一份')
}

function runtimeRoot(sessionFile) {
  const parts = sessionFile.split(sep)
  const index = parts.lastIndexOf('node_modules')
  if (index <= 0) throw new Error('无法从宿主包路径定位安装根目录')
  return parts.slice(0, index).join(sep)
}

function createHandle(fields) {
  const handle = {
    protocol: SESSION_PATCH_PROTOCOL,
    status: fields.status,
    serverReady: fields.status === 'ready',
    clientReady: false,
    hostVersion: fields.hostVersion || '',
    reason: fields.reason || '',
    clientReason: '',
    clientSource: fields.clientSource || '',
    confirmClient(report = {}) {
      if (this.status !== 'ready') return
      if (report.protocol !== SESSION_PATCH_PROTOCOL || report.installed !== true) {
        this.clientReady = false
        this.clientReason = report.reason || '客户端会话补丁没有装上'
        return
      }
      this.clientReady = true
      this.clientReason = ''
    },
    replacementAllowed() {
      return this.status === 'skipped' || (this.serverReady && this.clientReady)
    },
    blockReason() {
      if (this.status === 'failed') return this.reason
      if (this.serverReady && !this.clientReady) return this.clientReason || '页面尚未完成会话补丁握手，请刷新后再试'
      return this.reason || '会话补丁未就绪'
    },
    view() {
      const waitingForClient = this.serverReady && !this.clientReady
      return {
        protocol: this.protocol,
        status: this.status,
        ready: this.replacementAllowed(),
        serverReady: this.serverReady,
        clientReady: this.clientReady,
        hostVersion: this.hostVersion,
        reason: waitingForClient ? this.blockReason() : this.reason,
      }
    },
  }
  return handle
}

export async function installHostSessionPatch({ hostRequire, persistence, query } = {}) {
  let require
  try { require = hostRequire || await defaultHostRequire(persistence) }
  catch (error) {
    return createHandle({ status: 'failed', reason: '无法解析宿主 DSH 包：' + (error.message || error) })
  }
  let hostVersion = ''
  try {
    hostVersion = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version || ''
  } catch (error) {
    return createHandle({ status: 'failed', reason: '无法读取宿主 Session 版本：' + (error.message || error) })
  }
  const loadSessionCatalog = async () => {
    const loaded = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
    return loaded.sessionFormatCatalog
  }
  const finish = fields => Object.assign(createHandle(fields), { loadSessionCatalog })
  if (hostVersion !== SESSION_PATCH_VERSION) return finish({ status: 'skipped', hostVersion })
  const claimed = persistence?.[INSTALLED]
  if (claimed && claimed[CLAIM] !== true) {
    if (!claimed.loadSessionCatalog) claimed.loadSessionCatalog = loadSessionCatalog
    return claimed
  }
  for (const [name, allowed] of Object.entries(PINNED_SHA256)) {
    let actual = ''
    try { actual = createHash('sha256').update(readFileSync(require.resolve(name))).digest('hex') }
    catch (error) {
      return finish({ status: 'failed', hostVersion, reason: '无法校验宿主文件 ' + name + '：' + (error.message || error) })
    }
    if (!allowed.includes(actual)) return finish({ status: 'failed', hostVersion, reason: '宿主文件与 0.1.5-rc.2 补丁清单不一致：' + name })
  }
  if (!persistence?.tracker?.openHandles || !persistence?.tracker?.writers) {
    return finish({ status: 'failed', hostVersion, reason: '宿主没有 JSONL 会话存储，不能安装补丁' })
  }
  if (persistence.tracker.openHandles.size || persistence.tracker.writers.size) {
    return finish({ status: 'failed', hostVersion, reason: '会话已经打开，不能热替换。请重启后再使用正文编辑、回退和重新生成。' })
  }
  if (!query?._observations?.cache || !query?._corpus) {
    return finish({ status: 'failed', hostVersion, reason: '宿主会话查询尚未就绪，不能安装补丁' })
  }
  if (query._observations.cache.size) {
    return finish({ status: 'failed', hostVersion, reason: '会话查询缓存已经建立，不能安装补丁。请重启后再试。' })
  }
  let patch
  try {
    patch = await prepareExpandedPatch(runtimeRoot(require.resolve('@deepseek-ai/dsh-session')), { version: SESSION_PATCH_VERSION })
    patch.patchPersistence(persistence)
    patch.patchQuery(query)
  } catch (error) {
    try { patch?.dispose() } catch { /* The installer already restored what it changed. */ }
    return finish({ status: 'failed', hostVersion, reason: '会话补丁安装失败：' + (error.message || error) })
  }
  const handle = finish({ status: 'ready', hostVersion, clientSource: patch.clientSource })
  handle.restoreStoredSession = stored => patch.restoreStoredSession(stored)
  handle.dispose = () => patch.dispose()
  publishHandle(persistence, handle, claimed)
  return handle
}
