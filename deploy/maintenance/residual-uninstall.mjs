// 双平台共用的有限残留卸载。只操作接缝目标/已证明自有备份，不枚举用户数据。
// 无标记不等于作者原像；恢复必须来自随包校验的官方字节，不把污染 before 或旧备份强盖新版。
import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { protectAuthorStartup } from './author-safety.mjs'
import { STANDARD_RECORD } from './source.mjs'
import { planAuthorRebase } from '../author-rebase-plan.mjs'

const RECORDS = [STANDARD_RECORD, '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownCode = code => /dsh-tavern-(?:storage-)?sqlite(?:-v[12])?/.test(code) || code.includes('[dsh-tavern-standard-owned:v1]') || code.includes('[dsh-tavern-core-host:v1]')
const foreignCode = code => /dsh-tavern-(?:storage-)?sqlite-v1\b/.test(code) || code.includes('[dsh-tavern-v1-storage-host:v1]')
const decode = (body, rel) => {
  if (typeof body !== 'string' || Buffer.from(body, 'base64').toString('base64') !== body) throw Error('残留前像编码不合法：' + rel)
  return Buffer.from(body, 'base64')
}
export const AUTHOR_IMAGES_SHA256 = '8ad4f84f5066b73b3c0cbc91ddb48e20c8357b7ed91aa4764cf30fb779293f72'
export function loadAuthorCleanImages(file = new URL('./author-clean-images.json.gz', import.meta.url)) {
  const bytes = readFileSync(file)
  if (hash(bytes) !== AUTHOR_IMAGES_SHA256) throw Error('有限官方恢复资产缺失或摘要不符，不能用损坏恢复材料卸载')
  return JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'))
}
function trustedImages(catalog, adapter) {
  if (catalog.version !== 1 || catalog.package !== adapter.packageName || !Array.isArray(catalog.trees) || !catalog.trees.length) throw Error('有限官方恢复资产身份不符')
  const allowed = new Set([...adapter.targets.filter(rel => rel.endsWith('.js')), 'tavern-plugin/package.json'])
  const trees = catalog.trees.map(tree => {
    if (!/^[a-f0-9]{40}$/.test(tree.commit) || !tree.files) throw Error('官方恢复资产缺确定提交')
    const files = {}
    for (const [rel, item] of Object.entries(tree.files)) {
      if (!allowed.has(rel)) throw Error('官方恢复资产越过有限作者目标：' + rel)
      if (item === null) { files[rel] = null; continue }
      const bytes = decode(item.body, rel)
      if (hash(bytes) !== item.sha256) throw Error('官方恢复资产字节校验失败：' + rel)
      if (rel.endsWith('.js') && ownCode(bytes.toString('utf8'))) throw Error('官方前像含插件接管代码：' + rel)
      files[rel] = bytes
    }
    if ([...allowed].some(rel => !Object.hasOwn(files, rel))) throw Error('官方恢复资产有限目标不完整')
    return { ...tree, files }
  })
  return trees
}
function releaseIdentity(root) {
  const file = path.join(root, '.dsh-tavern-release.json')
  if (!existsSync(file)) return null
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw Error('作者发布标记不是普通文件')
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  return /^[a-f0-9]{40}$/.test(data.commit || '') ? data.commit : null
}
export function planResidualUninstall({ source, adapter, catalog = loadAuthorCleanImages() }) {
  const trees = trustedImages(catalog, adapter), before = source.capture(), expected = { ...before }
  const changed = [], kept = [], archived = [], problems = []
  const sourceTargets = adapter.targets.filter(rel => rel.endsWith('.js'))
  const known = (rel, bytes) => bytes !== null && trees.some(tree => tree.files[rel] !== null && tree.files[rel]?.equals(bytes))
  const protectedKnown = (rel, bytes) => rel === 'tavern-plugin/lib/index.js' && bytes !== null && trees.some(tree => tree.files[rel] && Buffer.from(protectAuthorStartup(tree.files[rel].toString('utf8')), 'utf8').equals(bytes))
  const receipt = releaseIdentity(source.root)
  let selected = trees.find(tree => tree.commit === receipt)
  let record = null
  if (before[STANDARD_RECORD] !== null) {
    try { record = JSON.parse(decode(before[STANDARD_RECORD], STANDARD_RECORD).toString('utf8')) }
    catch { problems.push('标准记录损坏；仅凭官方字节和自有文件清单判断，不采用其前像') }
    if (record && (record.version !== 1 || !record.before || !record.after || typeof record.before !== 'object' || typeof record.after !== 'object' || Array.isArray(record.before) || Array.isArray(record.after))) { problems.push('标准记录不完整，忽略其前像'); record = null }
    if (record) for (const rel of new Set([...Object.keys(record.before), ...Object.keys(record.after)])) source.file(rel)
  }
  // 新接入代的完整裸投影必须匹配同一个可信契约。保留已批准的作者文案，而不是由旧 receipt 覆盖它。
  const accepted = record ? planAuthorRebase({ appDir: source.root, targets: adapter.targets, record, images: trees }) : null
  const acceptedBytes = rel => accepted?.compatible && typeof accepted.before?.[rel] === 'string' ? decode(accepted.before[rel], rel) : null
  // CLI旧安装可能没有发布标记。只用确证为官方字节的before定位所属树，忽略污染before；
  // 此推断仅给仍明确属于本插件的目标恢复，不能据它覆盖零标记的未知升级文件。
  if (!receipt) {
    const current = sourceTargets.filter(rel => before[rel] !== null).map(rel => [rel, decode(before[rel], rel)]).filter(([rel, bytes]) => known(rel, bytes))
    const compatible = trees.filter(tree => current.every(([rel, bytes]) => tree.files[rel]?.equals(bytes)))
    if (current.length > 0 && compatible.length === 1) selected = compatible[0]
    else if (record) {
      const originals = Object.entries(record.before).filter(([rel, body]) => sourceTargets.includes(rel) && typeof body === 'string' && Buffer.from(body, 'base64').toString('base64') === body).map(([rel, body]) => [rel, decode(body, rel)]).filter(([rel, bytes]) => known(rel, bytes))
      const candidates = compatible.filter(tree => originals.length > 0 && originals.every(([rel, bytes]) => tree.files[rel]?.equals(bytes)))
      if (candidates.length === 1) selected = candidates[0]
    }
  }
  // 历史记录只用于限定归属备份；不重放旧 transform，也不依赖旧包/peer/vendor完整。
  const backups = new Set()
  for (const name of RECORDS.slice(1)) {
    if (before[name] === null) continue
    let data
    try { data = JSON.parse(decode(before[name], name).toString('utf8')) } catch { problems.push('历史记录损坏，忽略其恢复内容：' + name); continue }
    if (data.package && data.package !== adapter.packageName) throw Error('残留属于另一包，不自动撤除：' + name)
    if (!Array.isArray(data.entries)) { problems.push('历史记录缺entries：' + name); continue }
    for (const entry of data.entries) {
      const rel = entry.rel || entry.relative
      if (!sourceTargets.includes(rel)) throw Error('历史记录目标越界：' + rel)
      if (entry.backup) {
        source.file(entry.backup)
        if (!entry.backup.startsWith(rel + '.') || !Object.hasOwn(before, entry.backup)) throw Error('历史备份不属于确切目标：' + entry.backup)
        backups.add(entry.backup)
      }
    }
  }
  const replace = (rel, bytes, reason) => {
    expected[rel] = bytes === null ? null : bytes.toString('base64')
    if (expected[rel] !== before[rel]) changed.push({ relative: rel, reason, beforeSha256: before[rel] === null ? null : hash(decode(before[rel], rel)), afterSha256: bytes === null ? null : hash(bytes) })
  }
  for (const rel of sourceTargets) {
    const current = before[rel] === null ? null : decode(before[rel], rel)
    const acceptedOriginal = acceptedBytes(rel)
    if (acceptedOriginal && current?.equals(acceptedOriginal)) { kept.push(rel); continue }
    if (known(rel, current) || protectedKnown(rel, current)) { kept.push(rel); continue }
    const images = trees.map(tree => tree.files[rel])
    const added = images.every(bytes => bytes === null)
    const installedHash = current !== null && record?.after?.[rel] === hash(current)
    const recognizedOwned = current !== null && (catalog.ownedFiles?.[rel] || []).includes(hash(current))
    if (added) {
      if (current === null) continue
      // before=null 单独不足以证明归属；确切after、可信payload摘要或本包垫片引用至少具备一项。
      if (foreignCode(current.toString('utf8'))) throw Error('残留含另一产品线代码：' + rel)
      const managedCreated = record?.before?.[rel] === null && /^[a-f0-9]{64}$/.test(record?.after?.[rel] || '')
      if (installedHash || recognizedOwned || managedCreated || (record?.before?.[rel] === null && ownCode(current.toString('utf8')))) { replace(rel, null, '归档本插件新建模块'); continue }
      throw Error('新增同名文件归属不能确认，保留且拒绝假报卸净：' + rel)
    }
    if (current === null && !selected?.files[rel] && !record?.after?.[rel] && !Object.hasOwn(record?.before || {}, rel)) continue
    if (current !== null && foreignCode(current.toString('utf8'))) throw Error('作者目标含另一产品线代码：' + rel)
    // 未修改作者文件不因为“没有标记”就宣称干净。已装前像若为可信官方原像才能采用。
    let clean = installedHash ? acceptedOriginal : null
    if (!clean && installedHash && typeof record?.before?.[rel] === 'string') {
      try {
        const bytes = decode(record.before[rel], rel)
        if (known(rel, bytes) || protectedKnown(rel, bytes)) clean = selected?.files[rel] || bytes
      } catch { problems.push('忽略损坏/不可用的标准前像：' + rel) }
    }
    const recordedTarget = !!receipt && !!selected && /^[a-f0-9]{64}$/.test(record?.after?.[rel] || '')
    const official = selected?.files[rel]
    const truncatedOfficial = current !== null && official && current.length < official.length && official.subarray(0, current.length).equals(current)
    const wasTouched = current === null || installedHash || recordedTarget || truncatedOfficial || (current !== null && ownCode(current.toString('utf8')))
    if (!clean && wasTouched && selected?.files[rel]) clean = selected.files[rel]
    if (!clean && wasTouched && !receipt) {
      const candidates = images.filter(bytes => bytes !== null)
      if (candidates.length && candidates.every(bytes => bytes.equals(candidates[0]))) clean = candidates[0]
    }
    if (!clean) throw Error('不能证明作者目标已干净或恢复版本；未修改目标：' + rel + '。需要当前酒馆准确官方源码（不是删除酒馆/存档或修改after哈希）')
    replace(rel, clean, installedHash ? '撤回本插件接缝到可信作者原像' : '恢复安装中断/漂移目标的准确官方源码')
  }
  // 非源码产物只撤本插件的四份固定记录和已确证的备份，不遍历整棵app或业务树。
  for (const rel of RECORDS) {
    if (before[rel] !== null) { replace(rel, null, '归档本插件维护记录'); archived.push(rel) }
  }
  for (const rel of Object.keys(before)) {
    if (!/\.(?:pre-seams-[\w-]+\.bak|legacy-view-seams\.backup|save-ui[^/]*\.backup)$/.test(rel) || before[rel] === null) continue
    const target = sourceTargets.find(name => rel.startsWith(name + '.'))
    const bytes = decode(before[rel], rel)
    if (target && (backups.has(rel) || record?.after?.[rel] === hash(bytes) || known(target, bytes))) { replace(rel, null, '归档本插件源码备份'); archived.push(rel) }
  }
  // 原件保护仍保留；撤插件不变成自动迁移旧档/读取SQLite影子。
  const index = 'tavern-plugin/lib/index.js'
  if (expected[index] !== null) {
    const safe = Buffer.from(protectAuthorStartup(decode(expected[index], index).toString('utf8')), 'utf8')
    replace(index, safe, '保留独立原件启动保护')
  }
  for (const rel of sourceTargets) if (expected[rel] !== null && ownCode(decode(expected[rel], rel).toString('utf8'))) throw Error('预期卸载结果仍接管：' + rel)
  return { before, expected, summary: { fallback: true, changed: changed.length > 0, changedFiles: changed, keptOfficialFiles: kept, archived, notes: problems, authorReceipt: receipt, data: '用户存档/数据库未读取、未复制、未转换、未删除', originalPlayabilityVerified: false } }
}
export function applyResidualPlan(source, plan, evidenceDir) {
  source.assertImage(plan.before)
  if (releaseIdentity(source.root) !== plan.summary.authorReceipt) throw Error('计划后作者发布代已变化，不写旧代恢复材料')
  const files = Object.keys(plan.before).filter(rel => plan.before[rel] !== plan.expected[rel])
  const journal = path.join(evidenceDir, 'residual-source-before.json')
  writeFileSync(journal, JSON.stringify(Object.fromEntries(files.map(rel => [rel, plan.before[rel]]))) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  let active = true
  const write = (rel, body) => {
    const file = source.file(rel)
    if (body === null) { if (existsSync(file)) unlinkSync(file) }
    else { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, decode(body, rel)) }
  }
  const undo = () => {
    if (!active) return
    const current = source.capture()
    for (const rel of files) if (current[rel] !== plan.before[rel] && current[rel] !== plan.expected[rel]) throw Error('恢复时目标有外部修改，不覆盖：' + rel)
    for (const rel of files) write(rel, plan.before[rel])
    source.assertImage(plan.before)
    active = false
  }
  try {
    // 写前再次逐字确认；journal 保存所有将删除/恢复字节，任何失败按原有限写集恢复。
    source.assertImage(plan.before)
    for (const rel of files) write(rel, plan.expected[rel])
    source.assertImage(plan.expected)
    source.syntax()
  } catch (error) { undo(); throw error }
  return { undo, verify: () => source.assertImage(plan.expected), summary: plan.summary }
}

export async function executeResidualUninstall({ adapter, driver, source, evidenceDir, progress = () => {}, budget, check = false, catalog }) {
  const step = async (label, fn) => { budget?.remaining(); progress(label); const value = await fn(); budget?.remaining(); return value }
  const state = await step('兜底卸载：核目标身份/原运行状态；不要求旧包依赖完整', () => driver.preflight('uninstall', { residual: true }))
  const plan = await step('逐文件证明归属与可信官方恢复材料（不触碰用户数据）', () => planResidualUninstall({ source, adapter, catalog }))
  if (check) return { ...plan.summary, check: true, changed: false, initialState: state.wasRunning ? 'running' : 'stopped' }
  let stopAttempted = false, changed = false, applied, process
  try {
    await driver.assertIdentity()
    if (state.wasRunning) { stopAttempted = true; await step('按原管理方式精确停止本实例', () => driver.stop()) }
    await driver.assertStopped()
    // disposer 正常退出可能已撤净：停止后重新规划，不把停前已装态强加到干净态。
    const stoppedPlan = planResidualUninstall({ source, adapter, catalog })
    changed = true
    await step('撤残留/归档有限源码前像', async () => {
      if (driver.runtime?.windowsCli) await driver.assertStopped()
      applied = applyResidualPlan(source, stoppedPlan, evidenceDir)
      return applied
    })
    await step('移除本插件装配；不依赖pnpm/损坏旧包，不改其他插件', () => driver.manageResidual('uninstall'))
    applied.verify()
    if (state.wasRunning) process = await step('按原方式恢复本实例', () => driver.start())
    const verification = await step('回读源码/装配与原运行状态', () => driver.verify('uninstall', adapter, { process }))
    return { ...applied.summary, ...verification, changed: applied.summary.changed || state.assemblyPresent, action: 'uninstall', verified: true, initialState: state.wasRunning ? 'running' : 'stopped', finalState: state.wasRunning ? 'running' : 'stopped', elapsedMs: Math.round(budget?.elapsed() || 0) }
  } catch (error) {
    if (changed || stopAttempted) {
      driver.beginRecovery?.()
      try {
        if (process) await driver.stopIfAlive(process)
        else await driver.stopFailedStart?.()
        if (changed) {
          const errors = []
          try { applied?.undo() } catch (restoreSource) { errors.push(restoreSource) }
          try { await driver.manageResidual('restore') } catch (restoreAssembly) { errors.push(restoreAssembly) }
          if (errors.length) throw new AggregateError(errors, '源码/装配恢复未完成，保留恢复材料')
        }
        if (state.wasRunning) { await driver.assertStopped(); const restored = await driver.start({ recovery: true }); await driver.verifyRecovery(restored) }
        else await driver.assertStopped()
      } catch (recovery) { throw new AggregateError([error, recovery], '兜底卸载失败且恢复未完成；保留有限源码/装配恢复材料，不伪报成功') }
    }
    throw error
  }
}
