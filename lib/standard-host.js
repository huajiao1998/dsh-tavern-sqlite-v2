// dsh-tavern-sqlite-v2 · 标准装包路径的宿主包装（按 0.1.5-rc.2 真身接口实现）
//
// 背景（真身核对，全部只读自 tmp/plg-standard-1001-loader：
// cordis-plugin-loader 1.0.3 / cordis 4.0.2 / dsh-client-modules 0.1.5-rc.2 /
// dsh-app-boot 0.1.5-rc.2）：
//   · 禁用的 loader 行**不会 import**：Entry.update() 无 fiber 分支
//     `if (!this._disabled(candidate)) await this.init()`（src/config/entry.ts:168-179），
//     唯一 import 点 _init() 只被 init() 调用 ⇒ 作者树那份 installHostSessionPatch 不会跑。
//   · loader.create(options, parent=null, position=Infinity): Promise<id>
//     （src/config/tree.ts:96-104）内部完成 import + apply + `await fiber.await()`
//     （entry.ts:277-302、cordis:1398-1402 会重抛 _error）⇒ resolve=真 active、reject=真失败；
//     失败时 EntryGroup.create 回滚并 `delete store[id]`（group.ts:31-38）。
//   · **parent 必须为 null（Loader 根 group）**：Loader.write() 是 no-op
//     （cordis-plugin-loader/src/index.ts:162-164）⇒ 零落盘；写进 include group 会触发
//     Include.write() 把合成树 yaml dump + rename 落盘（dsh-app-boot:245-283）。
//   · 作者 client bundle 归包要求「同名 + 已挂载 + 未禁用」的行
//     （dsh-client-modules:774-781）⇒ 作者行被禁用后，必须由我们 create 的这一行把作者包
//     `dsh.client` 顶回 window.__DSH_BOOT__ 图（:813-822 还会拒同一包多个 active source）。
//
// 本模块的职责与边界：
//   1) 在**作者被 import 之前**断言：原行确实 disabled 且没有 fiber（覆盖失败/已被 import 就拒绝，
//      **绝不**"晚 disable 已经 import 过的作者树继续接"）；
//   2) 校验作者真身（包名 dsh-tavern-plugin、版本 2.5.0）并定位 app 树（一律相对已知锚点，不用 cwd 兜底）；
//   3) exact 缓存预检：只认调用方给定的**精确**依赖行清单，不做任何 ESM 缓存侦测
//      （Node 没有标准接口，造一个"猜缓存"的探测是假安全）；
//   4) 同步预检/施缝（由 deploy/standard-seams.mjs 提供）→ `await` 唯一集成点 create 出固定 id `owned` 的根行；
//   5) 返回 lifecycle disposer：`await loader.remove(ownedId)` 之后才 `uninstallStandardSeams(...)`。
//
// 不承诺的事（写清楚，避免误读）：
//   · 热 uninstall **不保证整包干净**：删掉 owned 行只是让作者 host 在本进程里不再被我们挂载；
//     作者原行仍是 disabled（配置层），要恢复作者回归必须新进程（standby 重启）。
//   · 本模块不 import 任何 @deepseek-ai/* 包，也不 new Context；所有宿主能力都从 loader 形参进来。
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 根 Loader 里我们这条固定 id（不用泛名 owned：同 id 冲突时归属必须可判）。 */
export const STANDARD_HOST_ROW_ID = 'dsh-tavern-storage-author-host-v2'
/** 作者 bundle 的主行 id / 模块 specifier（dsh-tavern-plugin/cordis.patch.yml）。 */
export const ORIGINAL_ROW_ID = 'dsh-tavern'
export const ORIGINAL_ROW_NAME = 'dsh-tavern-plugin'
/** 作者包版本门禁（b/package.json: version 2.5.0）。放宽前必须先重读作者树。 */
export const AUTHOR_VERSION = '2.5.0'
/**
 * 允许的"已挂载作者子路径行"白名单（默认放行 inspect）。
 * 依据：tmp/plg-standard-1001-code/b/lib/cordis-inspect.js 已下载核对——只 import `node:util`，
 * 不 import 任何缝目标，因此它先于施缝被 import 不会让缝失效。改这个名单必须先重新核对真身。
 */
export const DEFAULT_ALLOWED_DEPENDENT_ROWS = Object.freeze(['tavern-cordis-inspect'])
/** runtime 版本门禁：本包装只按这一代的 loader / loader.create / Fiber.await 语义实现。 */
export const RUNTIME_PACKAGE_NAME = '@deepseek-ai/dsh'
export const RUNTIME_VERSION = '0.1.5-rc.2'
export const BOOT_PACKAGE_NAME = '@deepseek-ai/dsh-app-boot'
export const BOOT_VERSION = '0.1.5-rc.2'
/** 只上报、不参与门禁（版本不同未必代表语义变了，但必须留痕）。 */
export const DIAGNOSTIC_PACKAGE_NAMES = Object.freeze(['@deepseek-ai/cordis-plugin-loader', '@deepseek-ai/cordis'])
/** 归属标记：只挂在内存 Entry 实例上（Loader 根树 write() no-op，不会落盘）。 */
export const OWNED_MARKER = Symbol.for('dsh-tavern-sqlite-v2.standard-host.owned')
/** 部署侧缝模块（由整合方提供：checkStandardSeams/applyStandardSeams/uninstallStandardSeams）。 */
export const SEAMS_MODULE_URL = new URL('../deploy/standard-seams.mjs', import.meta.url).href
/** 行级注入：apply 里要取 ctx.loader。 */
export const inject = ['loader']

const PKG_ROOT_LOOKUP_LIMIT = 8

function fail(message) {
  throw new Error('[standard-host] ' + message)
}

/** 只排除 null 与数组：类实例、Object.create(null)、宿主 ctx/Entry/Fiber 一律算对象（不做"纯对象"过度限制）。 */
function isNonArrayObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// 纯判定 / 纯派生（无 IO，单测不需要任何假文件系统）
// ---------------------------------------------------------------------------

/** path-like specifier：绝对路径、file: URL 或 ./ ../ 相对。 */
export function isPathLikeSpec(spec) {
  return typeof spec === 'string' && spec !== '' &&
    (spec.startsWith('file:') || spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec))
}

/** 把原行的 name 折算成绝对 file: URL。相对路径必须有 baseUrl（不做 cwd 兜底）。 */
export function toFileUrl(spec, baseUrl) {
  if (typeof spec !== 'string' || spec === '') fail('specifier 为空，无法折算 URL')
  if (spec.startsWith('file:')) return spec
  if (path.isAbsolute(spec)) return pathToFileURL(spec).href
  if (typeof baseUrl === 'string' && baseUrl !== '') return new URL(spec, baseUrl).href
  fail('相对 specifier 缺少 baseUrl，拒绝用 cwd 兜底：' + spec)
}

/**
 * 从作者包目录/入口路径推出 app 树根：`<APP>/tavern-plugin/lib/index.js` ⇒ `<APP>`。
 * 纯路径运算，不做任何猜测：形状不符就返回 undefined + 原因。
 * @returns {{appDir: string|undefined, reason?: string}}
 */
export function deriveAppDir({ packageDir, entryPath } = {}) {
  const reasons = []
  if (typeof packageDir === 'string' && packageDir !== '') {
    if (path.basename(packageDir) === 'tavern-plugin') return { appDir: path.dirname(packageDir) }
    reasons.push('包目录名不是 tavern-plugin：' + packageDir)
  } else {
    reasons.push('没有包目录')
  }
  if (typeof entryPath === 'string' && entryPath !== '') {
    const segments = entryPath.split(/[\\/]/).filter(Boolean)
    if (segments.slice(-3).join('/') === 'tavern-plugin/lib/index.js') {
      return { appDir: path.dirname(path.dirname(path.dirname(entryPath))) }
    }
    reasons.push('入口路径不是 <APP>/tavern-plugin/lib/index.js：' + entryPath)
  } else {
    reasons.push('没有入口路径')
  }
  return { appDir: undefined, reason: reasons.join('；') }
}

/** 作者 manifest 门禁（纯函数）。不符直接抛，不做任何"尽力而为"的降级。 */
export function assertAuthorManifest(pkg, { name = ORIGINAL_ROW_NAME, version = AUTHOR_VERSION } = {}) {
  if (!isNonArrayObject(pkg)) fail('作者 package.json 无法解析（需要 { name, version }）')
  if (pkg.name !== name) fail(`作者包名不符：期望 ${name}，实际 ${String(pkg.name)}`)
  if (pkg.version !== version) {
    fail(`作者包版本不符：期望 ${version}，实际 ${String(pkg.version)}（先重读作者树并确认缝锚点，再改门禁，不要就地放宽）`)
  }
  return { name: pkg.name, version: pkg.version }
}

/** 在 loader 树里按 id + name 找作者主行（entries() 覆盖嵌套子树）。 */
export function findOriginalRow(loader, { id = ORIGINAL_ROW_ID, name = ORIGINAL_ROW_NAME } = {}) {
  for (const entry of loader.entries()) {
    if (entry?.options?.id === id && entry?.options?.name === name) return entry
  }
  return undefined
}

/**
 * 原行必须**确实**禁用且没有 fiber。
 * 这条断言是本机制的前提：只要作者 host 已经被 import 过，缝就晚了（见文件头），
 * 所以覆盖失败时只能响亮拒绝，不能继续。
 */
export function assertOriginalRowDisabled(entry, { id = ORIGINAL_ROW_ID, name = ORIGINAL_ROW_NAME } = {}) {
  if (entry === undefined) {
    fail(`找不到作者主行 id=${id} name=${name}：合成树里没有它（作者 bundle 的 patch 层没进？）或它已被改名/移除；拒绝在没有作者 host 的情况下接管`)
  }
  if (entry.disabled !== true) {
    fail(`作者主行 ${id} 仍是启用态（disabled=${String(entry.disabled)}）：我们的 disabled 覆盖层没有赢（检查 dsh.profile.bundles 顺序与 profile 用户层），拒绝继续`)
  }
  if (entry.fiber !== undefined && entry.fiber !== null) {
    fail(`作者主行 ${id} 已经被 import 并挂载（fiber 存在）：缝已经晚了，拒绝在已加载的作者树上继续接（需要先让该行保持 disabled 再新进程启动）`)
  }
  return entry
}

/**
 * 找出**已挂载**的其它作者包行（子路径行，如 dsh-tavern-plugin/cordis-inspect）。
 * 只按 options.name 前缀做**精确名单**判断，不解析模块、不探测 ESM 缓存。
 * @returns {Array<object>} 需要调用方裁决的行
 */
export function findImportedAuthorDependents(loader, { name = ORIGINAL_ROW_NAME, exceptId = ORIGINAL_ROW_ID, allowed = [] } = {}) {
  const allowedSet = new Set(allowed)
  const dependents = []
  for (const entry of loader.entries()) {
    const spec = entry?.options?.name
    if (typeof spec !== 'string' || spec === name) continue
    if (spec !== name && !spec.startsWith(name + '/')) continue
    if (entry.options.id === exceptId) continue
    if (entry.disabled === true) continue
    if (entry.fiber === undefined || entry.fiber === null) continue
    if (allowedSet.has(entry.options.id) || allowedSet.has(spec)) continue
    dependents.push(entry)
  }
  return dependents
}

/**
 * 默认预检：若其它作者包行**已挂载**且不在精确放行名单里，就拒绝。
 * 默认名单 = DEFAULT_ALLOWED_DEPENDENT_ROWS（inspect 已下载核对：只 import `node:util`、不 import 缝目标）。
 * 之所以仍要名单而不是一律放行：那条行一旦已 import 就可能吃到缝前模块，而我们无法（也不该）探测 ESM 缓存。
 */
export function assertNoImportedDependents({ loader, originalRowName = ORIGINAL_ROW_NAME, originalRowId = ORIGINAL_ROW_ID, allowedDependentRows = DEFAULT_ALLOWED_DEPENDENT_ROWS } = {}) {
  const dependents = findImportedAuthorDependents(loader, {
    name: originalRowName,
    exceptId: originalRowId,
    allowed: allowedDependentRows,
  })
  if (dependents.length === 0) return { pending: [] }
  const list = dependents.map((entry) => `${entry.options.id} (${entry.options.name})`).join('、')
  fail(
    '检测到已挂载的其它作者包行，需人工裁决后再放行（不得假设它们没吃到缝前模块）：' + list +
    '；核对后把它们加入 config.allowedDependentRows（精确 id 或精确 name）',
  )
}

/** app 树根解析基准（与 index.js 同一约定；不用 cwd）。 */
export function resolveDshHome(env = process.env) {
  const value = env?.DSH_HOME
  if (typeof value === 'string' && value !== '') return value
  return path.join(os.homedir(), '.dsh-tavern')
}

/** 默认：真读 package.json。 */
export function defaultReadPackageJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 默认：createRequire(anchor).resolve(spec)。anchor 是文件路径，文件本身不必存在。 */
export function defaultResolveInstalled(spec, anchorFile) {
  return createRequire(anchorFile).resolve(spec)
}

/** 向上找声明了目标包名的 package.json 目录（限深，绝不越界猜测）。 */
export function findPackageRoot(entryPath, { name = ORIGINAL_ROW_NAME, readPackageJson = defaultReadPackageJson, exists = existsSync } = {}) {
  let dir = path.dirname(path.resolve(entryPath))
  for (let depth = 0; depth < PKG_ROOT_LOOKUP_LIMIT; depth += 1) {
    const candidate = path.join(dir, 'package.json')
    if (exists(candidate)) {
      try {
        const pkg = readPackageJson(candidate)
        if (pkg?.name === name) return dir
      } catch { /* 读不动就继续向上 */ }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 定位作者 host 入口（真 IO 可注入）。
 * 顺序（全部相对已知锚点，不用 cwd）：
 *   1) 原行 name 已是 path-like ⇒ 直接折算 file: URL；
 *   2) 原行所在 include 树的 baseUrl（原 tree base）做 require 锚；
 *   3) `$DSH_HOME/profiles/<profile>/package.json`（profile 锚）；
 *   4) `$DSH_HOME/apps/dsh-tavern/tavern-plugin`（作者树约定路径）。
 * @returns {{url:string, entryPath:string, packageDir:string, packageJson:object, version:string, appDir:string, appDirReason?:string, source:string, attempts:string[]}}
 */
export function resolveAuthorEntry({
  originalEntry,
  readPackageJson = defaultReadPackageJson,
  resolveInstalled = defaultResolveInstalled,
  exists = existsSync,
  dshHome = resolveDshHome(),
  profileName = 'tavern',
  authorName = ORIGINAL_ROW_NAME,
  authorVersion = AUTHOR_VERSION,
  authorTreeRelative = path.join('apps', 'dsh-tavern', 'tavern-plugin'),
} = {}) {
  const spec = originalEntry?.options?.name
  if (typeof spec !== 'string' || spec === '') fail('原行缺少 options.name，无法定位作者 host')
  const attempts = []
  const candidates = []

  if (isPathLikeSpec(spec)) {
    const includeBase = originalEntry?.parent?.tree?.ctx?.baseUrl
    candidates.push({ source: 'original-entry-path', entryUrl: toFileUrl(spec, includeBase) })
  } else {
    const includeBase = originalEntry?.parent?.tree?.ctx?.baseUrl
    if (typeof includeBase === 'string' && includeBase !== '') {
      candidates.push({ source: 'include-base', anchor: fileURLToPath(new URL('package.json', includeBase)) })
    }
    candidates.push({ source: 'profile-anchor', anchor: path.join(dshHome, 'profiles', profileName, 'package.json') })
    candidates.push({ source: 'author-tree', dir: path.join(dshHome, authorTreeRelative) })
  }

  const finish = (source, entryPath, packageDir, packageJson) => {
    assertAuthorManifest(packageJson, { name: authorName, version: authorVersion })
    const derived = deriveAppDir({ packageDir, entryPath })
    let appDir = derived.appDir
    let appDirReason = derived.reason
    if (appDir !== undefined && !exists(path.join(appDir, 'tavern-plugin', 'lib', 'index.js'))) {
      appDirReason = `推出的 app 树里没有 tavern-plugin/lib/index.js：${appDir}`
      appDir = undefined
    }
    return {
      url: pathToFileURL(entryPath).href,
      entryPath,
      packageDir,
      packageJson,
      version: packageJson.version,
      appDir,
      ...(appDirReason === undefined ? {} : { appDirReason }),
      source,
      attempts,
    }
  }

  for (const candidate of candidates) {
    try {
      if (candidate.entryUrl !== undefined) {
        const entryPath = fileURLToPath(candidate.entryUrl)
        if (!exists(entryPath)) {
          attempts.push(`${candidate.source}: 入口不存在 ${entryPath}`)
          continue
        }
        const packageDir = findPackageRoot(entryPath, { name: authorName, readPackageJson, exists })
        if (packageDir === undefined) {
          attempts.push(`${candidate.source}: 从 ${entryPath} 向上找不到 ${authorName} 包根`)
          continue
        }
        return finish(candidate.source, entryPath, packageDir, readPackageJson(path.join(packageDir, 'package.json')))
      }
      if (candidate.dir !== undefined) {
        const packageJsonPath = path.join(candidate.dir, 'package.json')
        if (!exists(packageJsonPath)) {
          attempts.push(`${candidate.source}: 无 ${packageJsonPath}`)
          continue
        }
        const entryPath = path.join(candidate.dir, 'lib', 'index.js')
        if (!exists(entryPath)) {
          attempts.push(`${candidate.source}: 无 ${entryPath}`)
          continue
        }
        return finish(candidate.source, entryPath, candidate.dir, readPackageJson(packageJsonPath))
      }
      const resolvedPath = resolveInstalled(authorName, candidate.anchor)
      const packageDir = findPackageRoot(resolvedPath, { name: authorName, readPackageJson, exists })
      if (packageDir === undefined) {
        attempts.push(`${candidate.source}: ${resolvedPath} 向上找不到 ${authorName} 包根`)
        continue
      }
      return finish(candidate.source, resolvedPath, packageDir, readPackageJson(path.join(packageDir, 'package.json')))
    } catch (error) {
      attempts.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  fail('无法解析作者 host（不做 cwd 猜测）：\n  - ' + attempts.join('\n  - '))
}

// ---------------------------------------------------------------------------
// runtime 版本门禁（exact；boot 路径版本 DI 可核准）
// ---------------------------------------------------------------------------

/**
 * runtime 模块目录候选（**每个包一组有序路径**，命中即止）。
 * 目标真身（tmp/plg-standard-1001-loader 下载的 rc.2 件 + B 现场）报的是
 * `$DSH_HOME/runtime/node_modules/...`，放**第一位**；`runtime/lib/node_modules/...`
 * 是仓内在产脚本与我们 index.js 一直在用的写法，并列保留 ⇒ 不靠单一布局假设。
 * 2026-10-06 追加桌面宿主锚点（真机实测桌面版没有 $DSH_HOME/runtime 目录）：
 * Electron utilityProcess 的 execPath 即应用目录下的可执行文件，宿主包在
 * `resources/app/node_modules`；再兜底共享安装闭包 `<home>/profiles/node_modules`。
 */
export function runtimeDirectPaths(dshHome = resolveDshHome()) {
  const bases = [
    path.join(dshHome, 'runtime', 'node_modules'),
    path.join(dshHome, 'runtime', 'lib', 'node_modules'),
    ...(process.versions?.electron
      ? [path.join(path.dirname(process.execPath), 'resources', 'app', 'node_modules')]
      : []),
    path.join(dshHome, 'profiles', 'node_modules'),
  ]
  return Object.fromEntries(
    [RUNTIME_PACKAGE_NAME, BOOT_PACKAGE_NAME, ...DIAGNOSTIC_PACKAGE_NAMES]
      .map((name) => [name, bases.map((base) => path.join(base, ...name.split('/'), 'package.json'))]),
  )
}

/** require 锚点：profile 清单 + 原行 include 树 baseUrl（根配置文件所在目录）。 */
export function runtimeAnchors({ dshHome = resolveDshHome(), profileName = 'tavern', includeBase } = {}) {
  const anchors = [path.join(dshHome, 'profiles', profileName, 'package.json')]
  if (typeof includeBase === 'string' && includeBase !== '') {
    try {
      anchors.push(fileURLToPath(new URL('package.json', includeBase)))
    } catch { /* 非法 baseUrl 就只用 profile 锚 */ }
  }
  return anchors
}

/** 解析单个包的版本：runtime 目录直读 → require 锚点；失败把明细留在 attempts。 */
export function resolvePackageVersion(pkgName, {
  directPaths = {},
  anchors = [],
  readPackageJson = defaultReadPackageJson,
  exists = existsSync,
  resolveInstalled = defaultResolveInstalled,
} = {}) {
  const attempts = []
  const directs = directPaths[pkgName]
  for (const direct of (Array.isArray(directs) ? directs : (directs === undefined ? [] : [directs]))) {
    if (exists(direct)) {
      try {
        const pkg = readPackageJson(direct)
        if (isNonArrayObject(pkg) && typeof pkg.version === 'string') {
          return { version: pkg.version, path: direct, source: 'runtime-modules', attempts }
        }
        attempts.push(`runtime-modules: ${direct} 缺 version`)
      } catch (error) {
        attempts.push(`runtime-modules: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      attempts.push(`runtime-modules: 无 ${direct}`)
    }
  }
  for (const anchor of anchors) {
    try {
      const file = resolveInstalled(pkgName + '/package.json', anchor)
      const pkg = readPackageJson(file)
      if (isNonArrayObject(pkg) && typeof pkg.version === 'string') {
        return { version: pkg.version, path: file, source: 'anchor:' + anchor, attempts }
      }
      attempts.push(`anchor ${anchor}: ${file} 缺 version`)
    } catch (error) {
      attempts.push(`anchor ${anchor}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { version: undefined, path: undefined, source: undefined, attempts }
}

/**
 * 解析 runtime 各包版本（真 IO 可注入）。
 * dsh / dsh-app-boot 参与门禁；loader / cordis 只上报（语义认定仍以本模块头部锚点为准）。
 */
export function resolveRuntimeVersions({ dshHome = resolveDshHome(), profileName = 'tavern', includeBase, ...io } = {}) {
  const directPaths = runtimeDirectPaths(dshHome)
  const anchors = runtimeAnchors({ dshHome, profileName, includeBase })
  const result = { anchors, directPaths, attempts: [] }
  const slots = [['dsh', RUNTIME_PACKAGE_NAME], ['boot', BOOT_PACKAGE_NAME]]
  for (const name of DIAGNOSTIC_PACKAGE_NAMES) slots.push([name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name])
  for (const [key, name] of slots) {
    const resolved = resolvePackageVersion(name, { directPaths, anchors, ...io })
    result[key] = { name, version: resolved.version, path: resolved.path, source: resolved.source }
    result.attempts.push(...resolved.attempts.map((item) => `${name} ← ${item}`))
  }
  return result
}

/** exact 门禁（纯函数）：dsh 与 boot 路径都必须等于本模块真身核对过的那一代。 */
export function assertRuntimeVersions(runtime, { runtimeVersion = RUNTIME_VERSION, bootVersion = BOOT_VERSION } = {}) {
  if (!isNonArrayObject(runtime)) fail('拿不到 runtime 版本信息：拒绝在没有版本核准的 runtime 上改作者树')
  const problems = []
  if (runtime.dsh?.version !== runtimeVersion) problems.push(`${RUNTIME_PACKAGE_NAME} 期望 ${runtimeVersion}，实际 ${String(runtime.dsh?.version)}`)
  if (runtime.boot?.version !== bootVersion) problems.push(`${BOOT_PACKAGE_NAME} 期望 ${bootVersion}，实际 ${String(runtime.boot?.version)}`)
  if (problems.length > 0) {
    const detail = runtime.attempts?.length ? '\n  解析明细：\n  - ' + runtime.attempts.join('\n  - ') : ''
    fail('runtime 版本门禁未通过（本包装只按该代 loader / loader.create / Fiber.await 语义实现）：\n  - ' + problems.join('\n  - ') + detail)
  }
  return { dsh: runtime.dsh.version, boot: runtime.boot.version, loader: runtime.loader?.version, cordis: runtime.cordis?.version }
}

// ---------------------------------------------------------------------------
// owned 行归属
// ---------------------------------------------------------------------------

function readStore(loader) {
  return isNonArrayObject(loader?.store) ? loader.store : undefined
}

function findOwnedRow(loader, ownedId) {
  const store = readStore(loader)
  if (store !== undefined && store[ownedId] !== undefined) return store[ownedId]
  // 门面只暴露 resolve() 的场合也认（Tree.resolve 对不存在的 id 会抛，所以必须兜住）
  if (typeof loader?.resolve === 'function') {
    try {
      return loader.resolve(ownedId)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 已有同名行时**只能按标记认领**（归属唯一来源 = OWNED_MARKER，本进程里我们建的）。
 * 光"name 等于作者入口 URL"**不算**归属证明：那可能是上一代进程遗留、或别人照抄同 URL 建的行；
 * 认错就会在 dispose 时误删别人的挂载 ⇒ 一律拒绝，人工核对后新进程重启。
 */
export function assertOwnedRowIsOurs(entry, { expectedName, ownedId = STANDARD_HOST_ROW_ID } = {}) {
  if (entry?.[OWNED_MARKER] === true) return { adopted: true, reason: 'marker' }
  fail(
    `已存在同名行 ${ownedId}（name=${JSON.stringify(entry?.options?.name)}）但没有本插件归属标记：` +
    `拒绝按 URL 认领（期望 name=${JSON.stringify(expectedName)} 不构成归属证明）；人工核对后新进程重启`,
  )
}

function markOwned(entry) {
  if (isNonArrayObject(entry)) {
    try {
      Object.defineProperty(entry, OWNED_MARKER, { value: true, configurable: true, enumerable: false })
    } catch { /* 冻结对象就退化为按 name 归属 */ }
  }
}

/**
 * 只在"确实是我们的"时才删（Tree.remove 对不存在的 id 会抛）。
 * 归属判据：本模块标记（唯一可靠）/ 同一 Entry 实例。
 * `forCleanup` 是唯一的例外：只用于"我们自己刚发起的那次 create 抛出之后"的清理
 * （发起前已确认该 id 为空 ⇒ 此刻出现的同名行只能是那次尝试留下的），**不是**归属判定。
 * @returns {{removed: boolean, reason: 'removed'|'absent'|'not-ours'}}
 */
async function removeOwnedRow(loader, ownedId, { entry, expectedName, forCleanup = false } = {}) {
  const current = findOwnedRow(loader, ownedId)
  if (current === undefined) return { removed: false, reason: 'absent' }
  const ours = current[OWNED_MARKER] === true ||
    current === entry ||
    (forCleanup === true && typeof expectedName === 'string' && expectedName !== '' && current?.options?.name === expectedName)
  if (!ours) return { removed: false, reason: 'not-ours' }
  await loader.remove(ownedId)
  return { removed: true, reason: 'removed' }
}

// ---------------------------------------------------------------------------
// 控制器（DI；不 new ctx、不 import cordis）
// ---------------------------------------------------------------------------

/** prepare 若回报了 ready 字段，就必须是 true —— 不许"看着像成功"就挂作者 host。 */
function assertPreparedReady(prepared, appDir) {
  if (isNonArrayObject(prepared) && 'ready' in prepared && prepared.ready !== true) {
    fail(`施缝/预检未就绪（app=${appDir}）：拒绝在未就绪的作者树上挂载作者 host`)
  }
}

/** 默认集成点：rc.2 的 Loader 公开 API；parent 固定 null（Loader 根 group，write() no-op）。 */
function defaultCreateOwnedRow(loader) {
  return async (spec) => {
    const options = { id: spec.id, name: spec.name }
    if (spec.config !== undefined) options.config = spec.config
    if (spec.inject !== undefined && spec.inject !== null) options.inject = spec.inject
    const createdId = await loader.create(options, null)
    return createdId
  }
}

/**
 * 标准装包路径的宿主启动器。
 *
 * 契约（全部从形参进来，便于纯单测）：
 *   loader        必须提供 entries() / create(options, parent) / remove(id)；store 可选（用于归属与清理）
 *   resolveAuthor ({ originalEntry, loader }) => { url, appDir, packageJson, version, packageDir, source }（可 async）
 *   resolveRuntime DI 核准 boot 路径版本（默认 resolveRuntimeVersions：$DSH_HOME/runtime + profile 锚）
 *   prepare       ({ appDir, authorDir, authorUrl, authorVersion, mode }) => 任意（可 async）；
 *                 **同步预检/施缝**：mode='create' 时未就绪就施缝，mode='verify' 时只许校验、未就绪必须抛
 *                 （作者 host 已 import 的情况下补施缝是假安全）；**须回报 { applied:boolean }**，
 *                 只有本次真的施过缝，失败时才允许回滚；抛错即本行失败
 *   createOwnedRow 唯一"core unified integration"：({ id, name, config, inject, parent:null, source }) => Promise<id>
 *   uninstall     ({ appDir, ownedId, reason, adopted, seams, runtime }) => 任意（可 async）；
 *                 reason='dispose'（作者行 remove 成功之后才撤缝）| 'rollback-after-failed-create'
 *   preflight     exact 缓存裁决钩子（默认 assertNoImportedDependents + DEFAULT_ALLOWED_DEPENDENT_ROWS）
 *
 * 顺序（不可调换）：原行 disabled/fiber 断言 → 作者真身与 app 定位 → **runtime exact 门禁** → owned 归属
 *                  → exact 预检 → 同步预检/施缝 → await 集成点 → 登记 disposer。
 * @returns {Promise<function>} disposer：`await loader.remove(ownedId)` 成功之后才 uninstall；
 *          remove 抛错或行不是我方的 ⇒ 保持源码接缝不动并抛（绝不"卸源码而作者还在跑"）
 */
export async function startStandardHost({
  loader,
  prepare,
  resolveAuthor,
  resolveRuntime,
  createOwnedRow,
  uninstall,
  preflight = assertNoImportedDependents,
  ownedId = STANDARD_HOST_ROW_ID,
  originalRowId = ORIGINAL_ROW_ID,
  originalRowName = ORIGINAL_ROW_NAME,
  expectedVersion = AUTHOR_VERSION,
  expectedRuntimeVersion = RUNTIME_VERSION,
  expectedBootVersion = BOOT_VERSION,
  allowedDependentRows = DEFAULT_ALLOWED_DEPENDENT_ROWS,
  appDir,
  logger,
} = {}) {
  if (!isNonArrayObject(loader) || typeof loader.entries !== 'function' || typeof loader.create !== 'function' || typeof loader.remove !== 'function') {
    fail('缺少 Loader 接口（需要 entries()/create()/remove()）：该包装行必须 inject loader')
  }
  if (typeof prepare !== 'function') fail('缺少 prepare()：同步预检/施缝钩子')
  if (typeof resolveAuthor !== 'function') fail('缺少 resolveAuthor()：作者 host 定位钩子')
  const create = createOwnedRow ?? defaultCreateOwnedRow(loader)

  // 1) 原行必须存在、确实 disabled、且没有 fiber（覆盖失败 ⇒ 拒绝，绝不"晚 disable 已 import"）
  const original = findOriginalRow(loader, { id: originalRowId, name: originalRowName })
  assertOriginalRowDisabled(original, { id: originalRowId, name: originalRowName })

  // 2) 作者真身 + 版本门禁 + app 定位
  const author = await resolveAuthor({ originalEntry: original, loader })
  if (!isNonArrayObject(author)) fail('resolveAuthor 未返回作者信息对象')
  if (typeof author.url !== 'string' || author.url === '') fail('resolveAuthor 未返回作者入口 url（必须是 file: URL）')
  if (!author.url.startsWith('file:')) fail('作者入口必须是 file: URL（client 归包与 import 都按它解析）：' + author.url)
  const manifest = author.packageJson ?? author.manifest
  assertAuthorManifest(manifest, { name: originalRowName, version: expectedVersion })
  const effectiveAppDir = appDir ?? author.appDir
  if (typeof effectiveAppDir !== 'string' || effectiveAppDir === '') {
    fail('拿不到 app 树根' + (author.appDirReason === undefined ? '' : '（' + author.appDirReason + '）') + '：请在行 config 里显式给 appDir，不要靠 cwd 猜')
  }

  // 2.5) runtime exact 门禁：不只信作者版本 —— 本包装的语义依赖这一代 loader / create / Fiber.await
  const runtimeResolver = resolveRuntime ?? (({ originalEntry }) => resolveRuntimeVersions({
    includeBase: originalEntry?.parent?.tree?.ctx?.baseUrl,
  }))
  const runtime = assertRuntimeVersions(await runtimeResolver({ originalEntry: original, loader, appDir: effectiveAppDir }), {
    runtimeVersion: expectedRuntimeVersion,
    bootVersion: expectedBootVersion,
  })

  // 3) owned 行归属：存在就必须能证明是我们的
  const existing = findOwnedRow(loader, ownedId)
  if (existing !== undefined) {
    const owned = assertOwnedRowIsOurs(existing, { expectedName: author.url, ownedId })
    markOwned(existing)
    // 已挂载的路径只能"验"不能"补施缝"：作者 host 已经 import 过，此刻补缝是假安全。
    const verified = await prepare({
      appDir: effectiveAppDir,
      authorDir: author.packageDir,
      authorUrl: author.url,
      authorVersion: author.version,
      mode: 'verify',
    })
    assertPreparedReady(verified, effectiveAppDir)
    logger?.info?.('[standard-host] 复用本进程已建的 owned 行 %s（%s）', ownedId, owned.reason)
    return makeDisposer({ loader, ownedId, uninstall, entry: existing, appDir: effectiveAppDir, adopted: true, runtime, logger })
  }

  // 4) exact 缓存预检（只认精确名单，不探测 ESM 缓存）
  await preflight?.({
    loader,
    author,
    original,
    ownedId,
    originalRowName,
    originalRowId,
    allowedDependentRows,
  })

  // 5) 同步预检/施缝：必须在作者 host 被 import 之前完成；prepare 若回报 ready 就必须是 true
  const seamResult = await prepare({
    appDir: effectiveAppDir,
    authorDir: author.packageDir,
    authorUrl: author.url,
    authorVersion: author.version,
    mode: 'create',
  })
  assertPreparedReady(seamResult, effectiveAppDir)

  // 6) await core unified integration（唯一挂载点）
  try {
    await create({
      id: ownedId,
      name: author.url,
      config: original.options?.config,
      inject: original.options?.inject,
      parent: null,
      source: author.source,
    })
    const entry = findOwnedRow(loader, ownedId)
    if (entry === undefined) {
      fail(`集成点返回成功但 store 里没有 owned 行 ${ownedId}：不登记为 ready（拿不到行就无法保证 disposer 清理）`)
    }
    markOwned(entry)
    logger?.info?.('[standard-host] 作者 host 已挂载为 %s（source=%s, app=%s, runtime=%s/%s）',
      ownedId, author.source, effectiveAppDir, runtime.dsh, runtime.boot)
    return makeDisposer({ loader, ownedId, uninstall, entry, appDir: effectiveAppDir, adopted: false, seams: seamResult, runtime, logger })
  } catch (error) {
    // 1) 清 created row。真 loader.create 自己会回滚（group.ts:31-38），但集成点可替换 ⇒ 按"可能留下半行"兜底。
    //    清理失败/被拒 ⇒ **直接抛**并保持源码接缝不动：活着的 row 还在跑，撤源码 = 半坏树。
    let cleanup
    try {
      cleanup = await removeOwnedRow(loader, ownedId, { expectedName: author.url, forCleanup: true })
      if (cleanup.removed) logger?.warn?.('[standard-host] 集成失败，已清理 owned 行 %s', ownedId)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        '[standard-host] 集成失败且清理 created row 也失败：owned 行可能仍在运行，保持源码接缝不动，需人工核对',
      )
    }
    if (cleanup.removed !== true && cleanup.reason !== 'absent') {
      throw new AggregateError(
        [error, new Error(`[standard-host] 清理被拒（reason=${String(cleanup.reason)}）：${ownedId} 仍在且无法证明可删，保持源码接缝不动，需人工核对`)],
        `[standard-host] 集成失败且 created row 未清掉（reason=${String(cleanup.reason)}）：不撤缝（避免半坏树），需人工核对`,
      )
    }
    // 2) 只有"row 已清掉或本来不存在" **且** 本次真的施过缝（prepare 回报 applied）才回滚；既有/别人的缝绝不动。
    if (seamResult?.applied === true && typeof uninstall === 'function') {
      try {
        const rolledBack = await uninstall({
          appDir: effectiveAppDir,
          ownedId,
          reason: 'rollback-after-failed-create',
          adopted: false,
          seams: seamResult,
          runtime,
          cleanup,
        })
        logUninstallOutcome(logger, '失败回滚', rolledBack)
      } catch (rollbackError) {
        throw new Error(
          '[standard-host] 集成失败且缝回滚也失败：源码可能仍是本次施缝后的状态，需人工核对（不静默）',
          { cause: new AggregateError([error, rollbackError]) },
        )
      }
    }
    throw error
  }
}

/** 卸缝结果不许丢：requiresRestart / legacySeamsRemain 必须落到日志（cordis 不消费 disposer 返回值）。 */
function logUninstallOutcome(logger, phase, result) {
  if (!isNonArrayObject(result)) return
  if (result.requiresRestart === true) {
    logger?.warn?.(
      '[standard-host] %s：源码接缝已按记录恢复，但 requiresRestart=true —— 进程内仍存活（作者模块 ESM 实例、' +
      '缝期间已求值的我们包模块级状态、原型补丁 / Symbol.for 注册表、DB 句柄与定时器、已下发的 client bundle）' +
      '⇒ 只有新进程才真正回到作者实现；仅 restore 源码 + 重启仍会重新施缝（我们的 patch 层还在）',
      phase,
    )
  }
  if (result.legacySeamsRemain === true) {
    logger?.warn?.('[standard-host] %s：历史三缝记录仍在（legacySeamsRemain=true），整包移除仍须按历史记录维护，别当"已干净回退"', phase)
  }
  logger?.info?.('[standard-host] %s：changed=%s requiresRestart=%s legacySeamsRemain=%s restored=%s',
    phase, String(result.changed), String(result.requiresRestart), String(result.legacySeamsRemain), String(result.restored))
}

function makeDisposer({ loader, ownedId, uninstall, entry, appDir, adopted, seams, runtime, logger }) {
  let done = false
  const dispose = async () => {
    if (done) return
    done = true
    const current = findOwnedRow(loader, ownedId)
    if (current !== undefined && current !== entry && current[OWNED_MARKER] !== true) {
      // 状态不明：绝不撤缝（撤了源码而作者 host 还在跑 = 半坏树）
      fail(`disposer 拒绝：${ownedId} 存在但不是我方行（name=${JSON.stringify(current?.options?.name)}）；保持源码接缝不动，需人工核对`)
    }
    if (current !== undefined) {
      // remove 失败 ⇒ 直接抛出（下面一行不会执行）⇒ 绝不撤缝
      await loader.remove(ownedId)
      logger?.info?.('[standard-host] disposer: remove(%s) 成功', ownedId)
    } else {
      logger?.info?.('[standard-host] disposer: %s 已不存在，跳过 remove', ownedId)
    }
    const removed = current !== undefined
    // 走到这里才是"作者 remove 成功"；此时才撤缝。热 uninstall 不承诺整包干净（作者回归需新进程）。
    let uninstallResult
    if (typeof uninstall === 'function') {
      uninstallResult = await uninstall({ appDir, ownedId, reason: 'dispose', adopted: adopted === true, seams, runtime })
      logUninstallOutcome(logger, 'dispose', uninstallResult)
    }
    // cordis 不消费 disposer 返回值，但 API 层如实返回：调用方/tests 能拿到 requiresRestart 等真值。
    return {
      removed,
      adopted: adopted === true,
      uninstall: uninstallResult ?? null,
      ...(isNonArrayObject(uninstallResult) ? {
        requiresRestart: uninstallResult.requiresRestart === true,
        legacySeamsRemain: uninstallResult.legacySeamsRemain === true,
        changed: uninstallResult.changed === true,
      } : { requiresRestart: undefined }),
    }
  }
  Object.defineProperty(dispose, 'ownedId', { value: ownedId, enumerable: false })
  Object.defineProperty(dispose, 'adopted', { value: adopted === true, enumerable: false })
  return dispose
}

// ---------------------------------------------------------------------------
// cordis 面向的插件（apply）
// ---------------------------------------------------------------------------

function assertSeamsModule(seams) {
  for (const name of ['checkStandardSeams', 'applyStandardSeams', 'uninstallStandardSeams']) {
    if (typeof seams?.[name] !== 'function') {
      fail(`deploy/standard-seams.mjs 缺少 ${name}()（整合方负责提供；本模块不内置缝实现）`)
    }
  }
}

async function defaultLoadSeams() {
  return await import(SEAMS_MODULE_URL)
}

/**
 * 生成 apply。生产用导出的 `apply`；`overrides` 仅测试用（注入纯 controller 的假件）。
 * 返回 disposer 函数 ⇒ cordis 视为合法 effect（返回字符串 id 之类会 `Invalid effect`）。
 */
export function createStandardHostApply({
  loadSeams = defaultLoadSeams,
  resolveAuthor,
  overrides = {},
} = {}) {
  return async function apply(ctx, config = {}) {
    const loader = ctx?.get?.('loader') ?? ctx?.loader
    if (!isNonArrayObject(loader)) fail('apply 拿不到 loader 服务：行级 inject 需要 loader')
    const seams = await loadSeams()
    assertSeamsModule(seams)
    const prepare = ({ appDir: dir, authorUrl, authorVersion, mode }) => {
      const before = seams.checkStandardSeams({ appDir: dir, authorUrl, authorVersion })
      if (isNonArrayObject(before) && before.ready === true) return { ready: true, mode, applied: false, checked: 'before' }
      if (mode === 'verify') {
        fail('owned 行已在本进程挂载，但缝预检未就绪：拒绝在已 import 的作者树上补施缝（需要新进程）')
      }
      const result = seams.applyStandardSeams({ appDir: dir, authorUrl, authorVersion })
      // 施缝后**必须复检**。复检若失败，源码**已经**被写过，而这条 prepare 是在 controller 的
      // create-try 之外跑的（controller 的失败回滚不会覆盖它）⇒ 必须在这里就地回滚，绝不把
      // "写过缝但没挂上作者 host" 的状态留下。
      const rollback = (cause) => {
        try {
          seams.uninstallStandardSeams({ appDir: dir, authorUrl, authorVersion, reason: 'failed-postcheck' })
        } catch (rollbackError) {
          throw new AggregateError(
            [cause, rollbackError],
            '[standard-host] 施缝后复检失败且就地回滚缝也失败：源码可能仍是本次施缝后的状态，需人工核对',
          )
        }
      }
      // 真身若"自身失败但 restore 后仍返回 ready:false"，也按复检失败处理（拒 + 恢复）
      if (isNonArrayObject(result) && result.ready === false) {
        const cause = new Error('applyStandardSeams 自报 ready=false（其自身失败/未就绪）：拒绝挂载作者 host 并恢复源码')
        rollback(cause)
        throw cause
      }
      let after
      try {
        after = seams.checkStandardSeams({ appDir: dir, authorUrl, authorVersion })
      } catch (postCheckError) {
        rollback(postCheckError)
        throw postCheckError
      }
      if (!isNonArrayObject(after) || after.ready !== true) {
        const cause = new Error('施缝后复检仍未就绪（applied=' + String(result?.changed === true) + '）：拒绝在未就绪的作者树上挂载作者 host')
        rollback(cause)
        throw cause
      }
      return { ready: true, mode, applied: result?.changed === true, checked: 'after' }
    }
    return await startStandardHost({
      loader,
      prepare,
      uninstall: (args) => seams.uninstallStandardSeams(args),
      resolveAuthor: resolveAuthor ?? resolveAuthorEntry,
      ownedId: typeof config.ownedId === 'string' ? config.ownedId : STANDARD_HOST_ROW_ID,
      // 默认的 inspect 名单永远在（已核对缓存安全）；行 config 只能**追加**精确放行，不能把默认名单顶掉。
      allowedDependentRows: [...new Set([
        ...DEFAULT_ALLOWED_DEPENDENT_ROWS,
        ...(Array.isArray(config.allowedDependentRows) ? config.allowedDependentRows : []),
      ])],
      appDir: typeof config.appDir === 'string' ? config.appDir : undefined,
      logger: isNonArrayObject(ctx?.logger) ? ctx.logger : undefined,
      ...overrides,
    })
  }
}

export const apply = createStandardHostApply()
