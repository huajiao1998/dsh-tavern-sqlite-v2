// 本地随包作者清单（dsh-tavern-runtime.json）验证器。
//
// 定位：**local-manifest** —— 只把"目录外的更新代"当本地清单用，**不声称官方认证**：
//   · 清单与被检文件同处一棵树、无签名 ⇒ 不能作第二信任根；消费方须先看 witness/ok，再由
//     standard-seams/rebase 走完整隔离施缝 + 语法 + CAS 后才放行首装。
//   · 冻结兜底（author-clean-images.json.gz）不因此删除；本模块只读、不联网、不写盘、不改 gz。
//
// 契约（主冻结）：
//   validateRuntimeManifest({ appDir, targets, images, projection, manifestBytes? })
//     -> null（该目录无清单，交 caller 既有 fallback）
//      | { ok, failures: string[], image: {commit,authorVersion,files,source}|null, witness: {revision,releaseSequence,version,sha256,targets}|null }
//   非法一律 ok:false（**不抛**，供"已知目录 fallback"判定）；witness 不含任何 body。
//   · manifestBytes（可选 Buffer）：**提供则完全不读现场 manifest**，只解析该 bytes——shape/sha/结构判定与读现场时逐字相同，
//     witness.sha256 即该 bytes 的摘要。供 rebase/残留卸载用"安装记录里保存的 canonical base64 清单"（caller 先核对摘要相等再传入）；
//     这样"已安装文件 hash 不到裸 manifest"时，仍能用 after 命中后的 **before 投影** + 记录清单完成验证。
//     非 Buffer ⇒ ok:false；不提供时才走下面的现场路径取清单（无清单 ⇒ null）。
//   · 只检查 targets 里的 .js 与 tavern-plugin/package.json；.tavern-* 记录/备份一律忽略。
//   · projection: Map<rel, Buffer|null>（传裸投影即不读现场）；不传则读现场（先 nofollow 再 read）。
//     只传投影时可不传 appDir；未受管 package 的投影来自当前 package（不传投影时读现场 tavern-plugin/package.json，必须真读到且摘要一致）。
//   · 插件 owned 只由 images（所有 tree 的该路径均无正文）确定；`background-task-coordinator.js`
//     明确属作者 ⇒ 永不当 owned。owned 路径若当前裸树有文件即拒。
//   · optional（game-footprint.js）：manifest 有 entry ⇒ 必读且必须匹配；无 entry 时仅"实物也缺"才 null。
//   · 必需作者目标在 manifest 里无 entry ⇒ 拒。
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

export const RUNTIME_MANIFEST_REL = 'dsh-tavern-runtime.json'
export const RUNTIME_MANIFEST_MAX_BYTES = 4 * 1024 * 1024
export const AUTHOR_PACKAGE_REL = 'tavern-plugin/package.json'
export const AUTHOR_PACKAGE_NAME = 'dsh-tavern-plugin'
export const RUNTIME_MANIFEST_SOURCE = 'local-runtime-manifest'
/** 唯一 optional 作者目标（旧代确实没有该文件）：缺 entry 时只允许"entry 与实物均缺"。 */
export const OPTIONAL_AUTHOR_TARGETS = Object.freeze(['tavern-plugin/lib/domain/game-footprint.js'])
/** 明确属作者的受管路径：即使 images 判无正文也**不得**归为 owned（manifest 不得据此把它当插件自有）。 */
export const AUTHOR_REQUIRED_OVERRIDES = Object.freeze(['tavern-plugin/lib/domain/background-task-coordinator.js'])
/** 脚本前像里出现这些标记/包名 ⇒ 是插件接管代码，不得冒充作者字节。 */
export const OWN_CODE_MARKERS = Object.freeze([
  '[dsh-tavern-standard-owned', '[dsh-tavern-core-host', '[dsh-tavern-db-save',
  '[dsh-tavern-native-data', '[dsh-tavern-v1-storage-host', '[dsh-tavern-sqlite',
  'dsh-tavern-sqlite-v1', 'dsh-tavern-sqlite-v2', 'dsh-tavern-storage-sqlite', 'dsh-tavern-plugin-owned',
])

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const isSafeSize = value => Number.isSafeInteger(value) && value >= 0
const isRecordFile = rel => /^\.tavern-|\.pre-seams-[\w-]+\.bak$|\.backup$/.test(rel)

/** 规范 posix 相对路径：无绝对/`..`/反斜杠/冒号/NUL、无空段、无重复分隔符。 */
export function isCanonicalRel(rel) {
  if (typeof rel !== 'string' || rel === '') return false
  if (rel.startsWith('/') || rel.endsWith('/') || rel.includes('//')) return false
  if (/[\\:\u0000]/.test(rel)) return false
  return rel.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function insideApp(baseReal, rel) {
  const target = path.resolve(baseReal, rel)
  if (target !== baseReal && !target.startsWith(baseReal + path.sep)) return null
  return target
}

/**
 * 先 nofollow 再 read：appDir 之下每一段祖先必须是普通目录且非 symlink/junction，
 * 叶子必须是普通文件且非 symlink/junction；realpath 收口确认没有借链接逃出 appDir。
 * @returns {{state:'missing'}|{state:'unsafe',reason:string}|{state:'file',bytes:Buffer}}
 */
function readPlainFile(baseReal, rel, maxBytes) {
  const abs = insideApp(baseReal, rel)
  if (abs === null) return { state: 'unsafe', reason: '路径越界：' + rel }
  const segments = rel.split('/')
  let current = baseReal
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    let stat
    try { stat = lstatSync(current) } catch { return { state: 'missing' } }
    if (stat.isSymbolicLink()) return { state: 'unsafe', reason: '祖先为符号链接/junction：' + current }
    if (!stat.isDirectory()) return { state: 'unsafe', reason: '祖先不是目录：' + current }
  }
  let stat
  try { stat = lstatSync(abs) } catch { return { state: 'missing' } }
  if (stat.isSymbolicLink()) return { state: 'unsafe', reason: '目标为符号链接/junction：' + rel }
  if (!stat.isFile()) return { state: 'unsafe', reason: '目标不是普通文件：' + rel }
  if (maxBytes !== null && stat.size > maxBytes) return { state: 'unsafe', reason: '文件超过尺寸上限（' + stat.size + ' > ' + maxBytes + '）：' + rel }
  let real
  try { real = realpathSync(abs) } catch { return { state: 'unsafe', reason: '目标不可解析：' + rel } }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) return { state: 'unsafe', reason: '目标实际位置逃出 appDir：' + rel }
  // 读取失败（权限/竞态/被替换）一律按异常处理：校验器契约是"不抛"，交 caller 走 fallback。
  try { return { state: 'file', bytes: readFileSync(abs) } } catch (error) { return { state: 'unsafe', reason: '目标不可读：' + rel + '（' + String(error?.code || error?.message || error) + '）' } }
}

/** 校验单个清单条目的结构（不做任何读取）。 */
function entryProblems(entry, index, seen, lowerSeen) {
  const problems = []
  const at = 'files[' + index + ']'
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [at + ' 不是对象']
  if (!isCanonicalRel(entry.path)) { problems.push(at + ' path 不是规范 posix 相对路径：' + String(entry.path)); return problems }
  if (seen.has(entry.path)) problems.push(at + ' path 重复：' + entry.path)
  seen.add(entry.path)
  const lower = entry.path.toLowerCase()
  if (lowerSeen.has(lower)) problems.push(at + ' path 大小写碰撞（Windows 风险）：' + entry.path)
  lowerSeen.add(lower)
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) problems.push(at + ' sha256 非 64 位小写十六进制：' + entry.path)
  if (!isSafeSize(entry.size)) problems.push(at + ' size 非非负安全整数：' + entry.path)
  return problems
}

/**
 * @param {{ appDir?: string, targets?: string[], images?: Array<{commit:string,authorVersion?:string,files:object}>|null,
 *           projection?: Map<string, Buffer|null>|null, manifestBytes?: Buffer|null }} input
 *   manifestBytes 提供时**不读现场 manifest**，只解析该 bytes（shape/sha/结构判定与读现场时逐字相同）；
 *   供 rebase/残留卸载用安装记录里保存的 canonical base64 清单（caller 先核对摘要相等再传入）。
 * @returns {null | { ok: boolean, failures: string[], image: object|null, witness: object|null }}
 */
export function validateRuntimeManifest({ appDir, targets, images = null, projection = null, manifestBytes = null } = {}) {
  const fail = (...reasons) => ({ ok: false, failures: reasons.flat().filter(Boolean), image: null, witness: null })
  if (!Array.isArray(targets) || targets.length === 0) return fail('缺少声明受管目标清单（targets）')
  const hasProjection = projection instanceof Map
  const hasManifestBytes = manifestBytes !== null && manifestBytes !== undefined
  if (hasManifestBytes && !Buffer.isBuffer(manifestBytes)) return fail('manifestBytes 必须是 Buffer')
  if (!hasProjection && (typeof appDir !== 'string' || appDir === '')) return fail('缺少 appDir（未传投影时必须给现场目录）')
  let baseReal = null
  if (typeof appDir === 'string' && appDir !== '') {
    try { baseReal = realpathSync(path.resolve(appDir)) } catch { return fail('appDir 不存在或不可解析：' + appDir) }
  }

  // ① 清单来源：manifestBytes 优先（**不读现场**，也因而没有"无清单 ⇒ null"这条）；否则现场入口：
  //    无 ⇒ null（交 caller 既有 fallback）；异常符号链接/越界 ⇒ ok:false 且不读取
  let manifestBuffer
  if (hasManifestBytes) {
    if (manifestBytes.length === 0) return fail('manifestBytes 为空')
    manifestBuffer = manifestBytes
  } else {
    if (baseReal === null) return fail('缺少 appDir：无法读取现场清单')
    const manifest = readPlainFile(baseReal, RUNTIME_MANIFEST_REL, RUNTIME_MANIFEST_MAX_BYTES)
    if (manifest.state === 'missing') return null
    if (manifest.state === 'unsafe') return fail('清单路径异常，拒绝读取：' + manifest.reason)
    manifestBuffer = manifest.bytes
  }
  if (manifestBuffer.length > RUNTIME_MANIFEST_MAX_BYTES) return fail('清单超过尺寸上限：' + manifestBuffer.length)

  let parsed
  try { parsed = JSON.parse(manifestBuffer.toString('utf8')) } catch (error) { return fail('清单不是合法 JSON：' + String(error?.message || error)) }

  // ② 清单结构（所有条目都验结构，但不读非 target）
  const structure = []
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) structure.push('清单根不是对象')
  else {
    if (parsed.schemaVersion !== 2) structure.push('schemaVersion 必须为 2（实际 ' + String(parsed.schemaVersion) + '）')
    if (typeof parsed.revision !== 'string' || !/^[a-f0-9]{40}$/.test(parsed.revision)) structure.push('revision 必须是 40 位小写十六进制')
    if (!Number.isSafeInteger(parsed.releaseSequence) || parsed.releaseSequence <= 0) structure.push('releaseSequence 必须是正安全整数')
    if (typeof parsed.version !== 'string' || parsed.version.trim() === '') structure.push('version 必须是非空字符串')
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) structure.push('files 必须是非空数组')
  }
  if (structure.length) return fail(structure)
  const seen = new Set(), lowerSeen = new Set()
  for (const [index, entry] of parsed.files.entries()) structure.push(...entryProblems(entry, index, seen, lowerSeen))
  if (structure.length) return fail(structure)

  const entries = new Map(parsed.files.map(entry => [entry.path, entry]))
  // ③ 检查集：targets 的 .js + 作者包清单；.tavern 记录/备份一律忽略
  const checked = [...new Set(targets.filter(rel => typeof rel === 'string' && !isRecordFile(rel) && (rel.endsWith('.js') || rel === AUTHOR_PACKAGE_REL)))].sort()
  if (!checked.includes(AUTHOR_PACKAGE_REL)) checked.push(AUTHOR_PACKAGE_REL)
  const witnessTargets = {}
  for (const rel of checked) {
    const entry = entries.get(rel)
    witnessTargets[rel] = entry ? { sha256: entry.sha256, size: entry.size } : null
  }
  const witness = {
    revision: parsed.revision, releaseSequence: parsed.releaseSequence, version: parsed.version,
    sha256: sha256(manifestBuffer), targets: witnessTargets,
  }

  // ④ owned 判定**只由 images**（所有 tree 该路径均无正文）确定；AUTHOR_REQUIRED_OVERRIDES 永不当 owned
  const catalogImages = Array.isArray(images) ? images.filter(image => image && typeof image === 'object' && image.files) : []
  const isOwned = rel => catalogImages.length > 0 && !OPTIONAL_AUTHOR_TARGETS.includes(rel) && !AUTHOR_REQUIRED_OVERRIDES.includes(rel)
    && catalogImages.every(image => !image.files[rel])

  const failures = []
  const files = {}
  const verified = new Map()
  const readCurrent = rel => {
    if (projection instanceof Map) {
      if (!projection.has(rel)) return { state: 'missing' }
      const value = projection.get(rel)
      if (value === null || value === undefined) return { state: 'missing' }
      return Buffer.isBuffer(value) ? { state: 'file', bytes: value } : { state: 'unsafe', reason: 'projection 值不是 Buffer/null：' + rel }
    }
    return baseReal === null ? { state: 'unsafe', reason: '未传投影且没有可读现场目录' } : readPlainFile(baseReal, rel, null)
  }

  for (const rel of checked) {
    const entry = entries.get(rel)
    const owned = isOwned(rel)
    const current = readCurrent(rel)
    if (current.state === 'unsafe') { failures.push('当前文件路径异常：' + current.reason); files[rel] = null; continue }
    if (owned) {
      // 自有路径：manifest 不该定义它（不据此当作者）；裸树出现文件即拒
      if (entry) failures.push(rel + '：插件 owned 路径不得由本地清单定义成作者文件')
      if (current.state === 'file') failures.push(rel + '：插件 owned 路径在裸树里已有文件，拒绝')
      files[rel] = null
      continue
    }
    if (!entry) {
      if (OPTIONAL_AUTHOR_TARGETS.includes(rel)) {
        if (current.state === 'file') failures.push(rel + '：optional 目标在清单里缺 entry 但实物存在，拒绝（只有 entry 与实物均缺才允许）')
        files[rel] = null
        continue
      }
      failures.push(rel + '：必需作者目标在本地清单里缺 entry')
      files[rel] = null
      continue
    }
    if (current.state !== 'file') { failures.push(rel + '：清单声明了该目标但当前树缺该文件'); files[rel] = null; continue }
    const bytes = current.bytes
    const actualSha = sha256(bytes), actualSize = bytes.length
    if (actualSha !== entry.sha256) { failures.push(rel + '：字节摘要与清单不符（清单 ' + entry.sha256 + '，实际 ' + actualSha + '）'); files[rel] = null; continue }
    if (actualSize !== entry.size) { failures.push(rel + '：字节长度与清单不符（清单 ' + entry.size + '，实际 ' + actualSize + '）'); files[rel] = null; continue }
    if (rel.endsWith('.js')) {
      const text = bytes.toString('utf8')
      const marker = OWN_CODE_MARKERS.find(item => text.includes(item))
      if (marker) { failures.push(rel + '：作者前像含插件接管标记（' + marker + '），拒绝当作者字节'); files[rel] = null; continue }
    }
    verified.set(rel, bytes)
    files[rel] = bytes
  }

  // ⑤ 作者包清单：必须真读到（投影或现场）且 name/version 与清单一致
  const pkgBytes = verified.get(AUTHOR_PACKAGE_REL) ?? null
  if (pkgBytes !== null) {
    try {
      const pkg = JSON.parse(pkgBytes.toString('utf8'))
      if (pkg?.name !== AUTHOR_PACKAGE_NAME) failures.push(AUTHOR_PACKAGE_REL + '：name 必须是 ' + AUTHOR_PACKAGE_NAME + '（实际 ' + String(pkg?.name) + '）')
      if (pkg?.version !== parsed.version) failures.push(AUTHOR_PACKAGE_REL + '：version 与清单不一致（包 ' + String(pkg?.version) + '，清单 ' + parsed.version + '）')
    } catch { failures.push(AUTHOR_PACKAGE_REL + '：不是合法 JSON') }
  }

  const image = { commit: parsed.revision, authorVersion: parsed.version, files, source: RUNTIME_MANIFEST_SOURCE }
  return { ok: failures.length === 0, failures, image, witness }
}

export default validateRuntimeManifest
