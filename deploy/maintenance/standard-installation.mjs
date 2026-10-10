// 一次性标准目录装配：程序单份落 data/plugins，正常启动只加载已保存行/区块。
// 仅操作本包确切目录和具名 patch 行；本次快照用于失败恢复，不是卸载原文资产。
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, readlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { parseDocument, YAMLSeq } from '../../lib/vendor/yaml/dist/index.js'

export const ORDINARY_ROW_ID = 'tavern-user-plugin-dsh-tavern-sqlite-v2'
// 不能用 tavern-user-plugin- 前缀：作者同步目录时会整批重写该前缀的行。
export const PERSISTED_ROWS = Object.freeze([
  { id: 'dsh-tavern-sqlite-v2', file: 'bootstrap/session-persistence.js' },
  { id: 'dsh-tavern-storage-host-patch-v2', file: 'bootstrap/host-patch.js' },
  { id: 'dsh-tavern-storage-standard-host-v2', file: 'bootstrap/standard-host.js' },
])
const DISABLED_IDS = ['session-persistence-jsonl', 'dsh-tavern']
const LEGACY_ROWS = new Map([
  ['dsh-tavern-sqlite-v2', 'dsh-tavern-sqlite-v2'],
  ['dsh-tavern-storage-host-patch-v2', 'dsh-tavern-sqlite-v2/host-patch'],
  ['dsh-tavern-storage-host-actions-v2', 'dsh-tavern-sqlite-v2/host-actions'],
  ['dsh-tavern-storage-save-routes-v2', 'dsh-tavern-sqlite-v2/save-routes'],
  ['dsh-tavern-storage-standard-host-v2', 'dsh-tavern-sqlite-v2/standard-host'],
])
const stat = file => { try { return lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const bytes = file => existsSync(file) ? readFileSync(file) : null
const same = (a, b) => a === null ? b === null : b !== null && a.equals(b)
const json = file => JSON.parse(readFileSync(file, 'utf8'))
export const pluginDirFor = ({ home, packageName }) => path.join(path.resolve(home), 'profile-data', 'tavern', 'data', 'plugins', packageName)
export const patchFileFor = ({ home, profileName = 'tavern' }) => path.join(path.resolve(home), 'profiles', profileName, 'cordis.patch.yml')
export function parsePatch(text) {
  const doc = parseDocument(text?.trim() ? text : '[]\n')
  if (doc.errors.length || !(doc.contents instanceof YAMLSeq)) throw Error('cordis.patch.yml 须是可解析列表：' + (doc.errors[0]?.message || '顶层不是列表'))
  return doc
}
function pathName(name, expected) {
  return typeof name === 'string' && path.isAbsolute(name) && path.resolve(name) === path.resolve(expected)
}
function inserted(doc) {
  return doc.contents.items.flatMap(op => {
    const rows = op?.get?.('insert', true)
    return rows instanceof YAMLSeq ? rows.items : []
  })
}
/**
 * 普通行（`ORDINARY_ROW_ID`）的宿主入口只有这两个确切绝对路径是"我方归属"：
 * · `plugin.js`：7cdd287 及更早的 scanner 直接指向真实入口；
 * · `.tavern-entry.mjs`：a2008bf 起的 scanner 指向它生成的 guard（真实入口在 guard 的 `new URL(main)` 里）。
 * 只做严格 resolve 相等比较——不放宽成目录前缀，`stripRows` 的外部占用判据必须保持有效。
 */
export const ORDINARY_ENTRY_FILES = Object.freeze(['plugin.js', '.tavern-entry.mjs'])
function ownedRow(row, pluginDir) {
  const id = String(row?.get?.('id') || ''), name = row?.get?.('name')
  const early = PERSISTED_ROWS.find(item => item.id === id)
  if (early && pathName(name, path.join(pluginDir, early.file))) return true
  if (LEGACY_ROWS.get(id) === name) return true
  if (id === ORDINARY_ROW_ID && ORDINARY_ENTRY_FILES.some(file => pathName(name, path.join(pluginDir, file)))) return true
  return false
}
function stripRows(doc, pluginDir) {
  for (let i = doc.contents.items.length - 1; i >= 0; i--) {
    const op = doc.contents.items[i], rows = op?.get?.('insert', true)
    if (!(rows instanceof YAMLSeq)) continue
    rows.items = rows.items.filter(row => {
      const id = String(row?.get?.('id') || '')
      if (!LEGACY_ROWS.has(id) && id !== ORDINARY_ROW_ID) return true
      if (!ownedRow(row, pluginDir)) throw Error('本包行 id 被其他入口占用，拒绝覆盖/删除：' + id)
      return false
    })
    if (!rows.items.length) doc.contents.items.splice(i, 1)
  }
}
function print(doc, original) {
  doc.contents.flow = false
  const text = doc.toString({ lineWidth: 0 })
  return { text: text === (original || '') ? null : text, changed: text !== (original || '') }
}
export function installOwnedRows(text, { pluginDir, home } = {}) {
  const doc = parsePatch(text)
  stripRows(doc, pluginDir)
  const overrides = DISABLED_IDS.map(id => doc.contents.items.filter(op => op?.get?.('id') === id && !op?.get?.('insert')))
  for (let i = 0; i < overrides.length; i++) {
    if (overrides[i].length > 1) throw Error('禁用行重复，拒绝猜优先级：' + DISABLED_IDS[i])
    // 不覆盖用户现有配置；已有 disabled:true 可以共存，卸载时保留。
    if (overrides[i].length && overrides[i][0].get('disabled') !== true) throw Error('用户层显式启用了接管目标，拒绝覆盖：' + DISABLED_IDS[i])
    if (!overrides[i].length) {
      const op = doc.createNode({ id: DISABLED_IDS[i], disabled: true })
      op.commentBefore = ' dsh-tavern-sqlite-v2: 安装器禁用原入口'
      doc.contents.items.push(op)
    }
  }
  const rows = PERSISTED_ROWS.map(row => ({ id: row.id, name: path.join(pluginDir, row.file) }))
  rows[0].config = { root: path.join(home, 'profile-data', 'tavern', 'sessions') }
  rows[2].inject = ['loader', 'sessionPersistence', 'tavernStorageBootstrapReady']
  rows[2].config = { persistedSeams: true }
  const op = doc.createNode({ insert: rows })
  op.commentBefore = ' dsh-tavern-sqlite-v2: 持久启动装配；安装一次，正常启动自动加载，无额外安装命令'
  doc.contents.items.push(op)
  return print(doc, text)
}
export function uninstallOwnedRows(text, { pluginDir } = {}) {
  const doc = parsePatch(text)
  stripRows(doc, pluginDir)
  doc.contents.items = doc.contents.items.filter(op => {
    if (!DISABLED_IDS.includes(op?.get?.('id'))) return true
    if (!String(op.commentBefore || '').includes('dsh-tavern-sqlite-v2: 安装器禁用原入口')) return true
    if (op.get('disabled') !== true || op.items.length !== 2) throw Error('本包禁用行已被外部修改，拒绝删除')
    return false
  })
  return print(doc, text)
}
function assertSafe(file, home) {
  const resolved = path.resolve(file), root = path.resolve(home)
  if (!resolved.startsWith(root + path.sep)) throw Error('本包装配路径越界：' + resolved)
  for (let parent = path.dirname(resolved); parent !== path.dirname(root); parent = path.dirname(parent)) {
    if (stat(parent)?.isSymbolicLink()) throw Error('装配父目录是链接，拒绝修改：' + parent)
    if (parent === root) break
  }
  return resolved
}
function manifestAt(dir, name) {
  if (!existsSync(path.join(dir, 'package.json')) || json(path.join(dir, 'package.json')).name !== name) throw Error('不能认领无清单或其他包目录：' + dir)
}
export function createStandardInstallation({ op, adapter, packageRoot, evidence, linkPeers = () => {} }) {
  const name = adapter.packageName, pluginDir = pluginDirFor({ home: op.home, packageName: name })
  const link = path.join(op.profileDir, 'node_modules', name), oldDir = path.join(op.home, 'plugins', name)
  const profileFile = path.join(op.profileDir, 'package.json'), patchFile = path.join(op.profileDir, 'cordis.patch.yml')
  let before, expected, state, incoming = packageRoot, moves = [], currentDir = null, captured = false, restored = false
  const paths = [pluginDir, link, oldDir]
  let residualPaths = null
  function residualPath(file, evidenced) {
    const entry = stat(file)
    if (!entry) return null
    assertSafe(file, op.home)
    if (!entry.isDirectory() && !entry.isSymbolicLink()) throw Error('残留包路径不是目录/链接：' + file)
    const manifest = bytes(path.join(file, 'package.json'))
    let owner = null
    if (manifest) {
      try { owner = JSON.parse(manifest.toString('utf8')).name } catch { /* 损坏清单只在明确装配证据下可撤 */ }
    }
    if (owner && owner !== name) throw Error('残留装配指向另一包，不能认领：' + file)
    if ((!manifest || !owner) && !evidenced) throw Error('没有本包装配证据，不能认领无有效清单目录/链接：' + file)
    return { file, symbolic: entry.isSymbolicLink(), linkTarget: entry.isSymbolicLink() ? readlinkSync(file) : null, manifest }
  }
  const current = () => ({ profile: bytes(profileFile), patch: bytes(patchFile) })
  const assertUnchanged = () => {
    const now = current()
    if (!same(expected.profile, now.profile) || !same(expected.patch, now.patch)) throw Error('装配预检后 profile/patch 有外部改动，拒绝覆盖')
  }
  function inspect() {
    const pkg = json(profileFile), dep = !!pkg.dependencies?.[name], bundle = !!pkg.dsh?.profile?.bundles?.includes(name), linked = !!stat(link), standard = !!stat(pluginDir)
    if (standard) {
      assertSafe(pluginDir, op.home)
      if (stat(pluginDir).isSymbolicLink()) throw Error('标准插件目录不能是外部链接')
      manifestAt(pluginDir, name)
      if (dep || bundle || linked || stat(oldDir)) throw Error('同时存在标准目录与同名 profile/旧目录装配，拒绝双源')
      const doc = parsePatch(bytes(patchFile)?.toString('utf8'))
      const rows = inserted(doc)
      for (const early of PERSISTED_ROWS) {
        const found = rows.filter(row => row.get('id') === early.id)
        if (found.length !== 1 || !pathName(found[0].get('name'), path.join(pluginDir, early.file))) throw Error('标准启动装配缺失/重复/归属错误：' + early.id)
      }
      if (rows.find(row => row.get('id') === PERSISTED_ROWS[0].id)?.get('config')?.get('root') !== path.join(op.home, 'profile-data', 'tavern', 'sessions')) throw Error('SQLite 会话根装配漂移，拒绝修改数据库位置')
      if (rows.find(row => row.get('id') === PERSISTED_ROWS[2].id)?.get('config')?.get('persistedSeams') !== true) throw Error('标准启动未声明持久区块合同')
      for (const id of DISABLED_IDS) if (!doc.contents.items.some(row => row.get?.('id') === id && row.get?.('disabled') === true)) throw Error('标准接管缺少禁用原入口：' + id)
      return { present: true, layout: 'standard', dir: pluginDir }
    }
    if (dep || bundle || linked) {
      if (!(dep && bundle && linked)) throw Error('旧 profile 装配不完整，拒绝猜测')
      assertSafe(link, op.home); manifestAt(link, name)
      if (stat(oldDir)) { assertSafe(oldDir, op.home); manifestAt(oldDir, name) }
      return { present: true, layout: 'legacy', dir: realpathSync(link) }
    }
    if (stat(oldDir)) throw Error('旧程序目录存在但无装配，不冒认；请先按旧维护入口卸载')
    return { present: false, layout: 'absent', dir: null }
  }
  function capture() {
    if (captured) return
    before = current(); expected = { ...before }; captured = true
  }
  function writeState(profile, patch) {
    writeFileSync(profileFile, profile)
    // 每一步成功后只更新该文件的本次预期；下一步失败仍能恢复已写 profile，不吞外部改动。
    expected.profile = Buffer.from(profile)
    if (patch !== null) writeFileSync(patchFile, patch)
    else if (stat(patchFile)) rmSync(patchFile) // 确切受管 profile patch，恢复其原本不存在的状态。
    expected.patch = patch === null ? null : Buffer.from(patch)
  }
  function archive(file) {
    if (!stat(file)) return
    assertSafe(file, op.home)
    const residualItem = residualPaths?.get(file)
    if (state?.layout === 'residual') {
      const now = residualPath(file, true)
      if (!residualItem || now.symbolic !== residualItem.symbolic || now.linkTarget !== residualItem.linkTarget || !same(now.manifest, residualItem.manifest)) throw Error('残留程序预检后身份变化，不覆盖：' + file)
    } else manifestAt(file, name)
    const dest = path.join(evidence, 'assembly-before', String(moves.length))
    if (stat(dest)) throw Error('本次装配归档目的已占用：' + dest)
    mkdirSync(path.dirname(dest), { recursive: true })
    // 移动确切本包目录/最终链接，不跟随链接删除共享依赖目录；仅供本次恢复。
    const symbolic = stat(file).isSymbolicLink(), linkTarget = symbolic ? readlinkSync(file) : null
    const manifest = residualItem ? residualItem.manifest : readFileSync(path.join(file, 'package.json'))
    renameSync(file, dest)
    moves.push({ file, dest, symbolic, linkTarget, manifest })
  }
  function clearCurrent() {
    if (currentDir && stat(currentDir)) {
      assertSafe(currentDir, op.home)
      if (stat(currentDir).isSymbolicLink()) throw Error('本次安装目的被替换成外部链接，拒绝清理')
      // 本次确切新建目录可能因复制失败尚无清单；有清单时必须仍属于本包。
      if (existsSync(path.join(currentDir, 'package.json'))) manifestAt(currentDir, name)
      rmSync(currentDir, { recursive: true, force: true })
    }
    currentDir = null
  }
  async function manage(action, root = incoming) {
    if (!['install', 'uninstall'].includes(action)) throw Error('标准装配动作必须是 install/uninstall')
    capture(); assertUnchanged()
    // 写/移程序前先验所有父目录；不能清掉旧装配之后才发现标准目的越界。
    for (const file of [...paths, profileFile, patchFile]) assertSafe(file, op.home)
    const pkg = json(profileFile)
    if (pkg.dependencies) delete pkg.dependencies[name]
    if (Array.isArray(pkg.dsh?.profile?.bundles)) pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(item => item !== name)
    const patch = uninstallOwnedRows(expected.patch?.toString('utf8'), { pluginDir })
    // incoming 已在 preflight 按需脱离，卸载不能删正在执行/准备安装的原代程序。
    clearCurrent()
    // 残留双源时先归档最终链接本体，再移程序目标，避免把本次移目标造成的悬空误认成外改。
    const archivePaths = state?.layout === 'residual'
      ? [...paths.filter(file => stat(file)?.isSymbolicLink()), ...paths.filter(file => !stat(file)?.isSymbolicLink())] : paths
    for (const file of archivePaths) if (stat(file)) archive(file)
    const text = patch.text ?? expected.patch?.toString('utf8') ?? null
    writeState(Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), text === null ? null : Buffer.from(text))
    if (action === 'uninstall') return { present: false }
    if (action !== 'install') throw Error('标准装配动作必须是 install/uninstall')
    const { copyPackage, samePackage } = await import('./runner.mjs')
    const source = root === packageRoot ? incoming : root
    manifestAt(source, name)
    assertSafe(pluginDir, op.home)
    if (stat(pluginDir)) throw Error('标准安装目的已存在，拒绝覆盖')
    currentDir = pluginDir
    copyPackage(source, pluginDir)
    const bootstrap = json(path.join(pluginDir, 'bootstrap', 'package.json'))
    if (bootstrap.dsh?.client || bootstrap.name === name) throw Error('启动入口不得拥有第二个浏览器来源')
    await linkPeers(json(path.join(pluginDir, 'package.json')), pluginDir)
    const installed = installOwnedRows(text, { pluginDir, home: op.home })
    writeState(expected.profile, Buffer.from(installed.text ?? text ?? '[]\n'))
    if (!samePackage(source, pluginDir)) throw Error('标准目录程序与本次选定程序不一致')
    return assertAssembly('install')
  }
  function assertAssembly(action) {
    const now = inspect()
    if (now.present !== (action === 'install') || (action === 'install' && now.layout !== 'standard' && !(restored && state?.layout === 'legacy'))) throw Error('标准插件目录/持久装配回读不一致')
    return now
  }
  async function preflight(action) {
    if (!['install', 'uninstall'].includes(action)) throw Error('标准装配动作必须是 install/uninstall')
    if (captured) assertUnchanged()
    for (const file of [...paths, profileFile, patchFile]) assertSafe(file, op.home)
    state = inspect(); capture()
    // 提前校验归属/配置冲突，不在停服后才发现不可安装的 patch。
    if (action === 'install') installOwnedRows(expected.patch?.toString('utf8'), { pluginDir, home: op.home })
    else uninstallOwnedRows(expected.patch?.toString('utf8'), { pluginDir })
    if (action === 'install' && state.present) {
      const { samePackage, copyPackage } = await import('./runner.mjs')
      state.upgrading = state.layout !== 'standard' || !samePackage(packageRoot, state.dir)
      if (incoming === packageRoot && (path.resolve(packageRoot) === path.resolve(state.dir) || realpathSync(packageRoot) === realpathSync(state.dir))) {
        incoming = path.join(evidence, 'assembly-input-package')
        if (stat(incoming)) throw Error('本次输入程序目录已占用')
        copyPackage(packageRoot, incoming)
      }
    }
    return state
  }
  async function restore() {
    if (!captured) return
    assertUnchanged(); clearCurrent()
    for (const item of [...moves].reverse()) {
      const archived = stat(item.dest)
      if (stat(item.file) || !archived || archived.isSymbolicLink() !== item.symbolic
        || (item.symbolic && readlinkSync(item.dest) !== item.linkTarget)
        || (!item.symbolic && !same(bytes(path.join(item.dest, 'package.json')), item.manifest))) {
        throw Error('原装配目的/归档变化，不覆盖：' + item.file)
      }
      mkdirSync(path.dirname(item.file), { recursive: true })
      renameSync(item.dest, item.file)
      if (item.symbolic && !same(bytes(path.join(item.file, 'package.json')), item.manifest)) throw Error('原链接恢复后的目标包变化：' + item.file)
    }
    moves = []
    writeState(before.profile, before.patch)
    restored = true
    // 残留维护允许原本就是半装的状态；恢复只要求本次归档和配置回原位，不能用完整安装准入拒绝原状态。
    return state?.layout === 'residual' ? state : inspect()
  }
  function residual() {
    capture(); assertUnchanged()
    for (const file of [...paths, profileFile, patchFile]) assertSafe(file, op.home)
    // 残留维护不要求旧包能运行。明确同名装配/自有行允许悬空最终链接或缺清单；有效外包清单仍拒绝。
    uninstallOwnedRows(expected.patch?.toString('utf8'), { pluginDir }) // 先拒同 id 外部入口与被改过的安装器覆盖
    const doc = parsePatch(expected.patch?.toString('utf8')), pkg = json(profileFile)
    const evidenced = !!pkg.dependencies?.[name] || !!pkg.dsh?.profile?.bundles?.includes(name)
      || inserted(doc).some(row => ownedRow(row, pluginDir))
    residualPaths = new Map(paths.map(file => [file, residualPath(file, evidenced)]).filter(([, item]) => item))
    const present = residualPaths.size > 0 || evidenced
      || doc.contents.items.some(op => String(op?.commentBefore || '').includes('dsh-tavern-sqlite-v2: 安装器禁用原入口'))
    state = { present, layout: 'residual', dir: null }
    return { present, uninstall: () => manage('uninstall'), restore,
      verify: () => {
        const doc = parsePatch(bytes(patchFile)?.toString('utf8'))
        if (paths.some(file => stat(file)) || json(profileFile).dependencies?.[name] || json(profileFile).dsh?.profile?.bundles?.includes(name)
          || inserted(doc).some(row => LEGACY_ROWS.has(row.get('id')) || row.get('id') === ORDINARY_ROW_ID)
          || doc.contents.items.some(op => String(op?.commentBefore || '').includes('dsh-tavern-sqlite-v2: 安装器禁用原入口'))) throw Error('本包残留装配未清理')
      } }
  }
  return { preflight, manage, assertAssembly, restore, residual }
}
