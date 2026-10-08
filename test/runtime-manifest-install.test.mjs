// runtime-manifest 首装/重接/卸载 端到端断言（契约已冻结：record.compatibilityMode/runtimeManifest、
//   apply 返回 compatibilityMode、预演失败与漂移一律 throw 且不写、after＝全 TARGETS+artifacts 现存文件）。
//
// 夹具：真实 catalog **末树**（3100d223）的有限源码集复制到自有 tmp；package version→2.5.91；
//   在非锚点文件尾部追加无害注释 ⇒ 冻结 classify（catalog 逐字节比较）必拒 ⇒ 只能走 local-runtime-manifest；
//   清单按现场实际字节重签：schemaVersion=2、revision='a'*40、releaseSequence=9999、version=2.5.91、
//   files=现存全部作者 .js + package.json（真实 sha256/size）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadAuthorCleanImages, planResidualUninstall, applyResidualPlan } from '../deploy/maintenance/residual-uninstall.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { validateRuntimeManifest, RUNTIME_MANIFEST_REL, AUTHOR_PACKAGE_REL } from '../deploy/author-runtime-manifest.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const RECORD_REL = '.tavern-standard-seams.json'
const PKG_REL = AUTHOR_PACKAGE_REL
const MANIFEST_REL = RUNTIME_MANIFEST_REL
const COMMENT_REL = 'tavern-plugin/lib/domain/settlement-jobs.js'      // 非锚点：仅文件尾追加注释
const COMMENT_REL_NEXT = 'tavern-plugin/lib/domain/auto-compaction.js' // 同上，用于"新作者代"
const OWNED_BRIDGE_REL = 'tavern-plugin/lib/domain/storage-native-data.js'
const LOCAL_MODE = 'local-runtime-manifest'
// 真必需锚点（buildCore 强制；与 deploy/standard-seams.mjs:436 的 openingHostAnchor 逐字一致）。
// 注：NATIVE_DATA 系列锚点是 optional（作者新代缺它可合法降级），不能用来断言"必需锚点失败"。
const OPENING_HOST_ANCHOR = 'createOpeningPreparation({ readCard, worldBooks, extensionSettings:'
const OWN_MARKER_RE = /dsh-tavern-(?:storage-)?sqlite(?:-v[12])?|\[dsh-tavern-standard-owned:v1\]|\[dsh-tavern-core-host:v1\]/
const GZ = new URL('../deploy/maintenance/author-clean-images.json.gz', import.meta.url)
const decodeImage = body => (body === null || body === undefined ? null : Buffer.from(body, 'base64'))

function copyLastTree(t, label) {
  const catalog = loadAuthorCleanImages()
  const tree = catalog.trees.at(-1)
  assert.ok(tree, '缺 catalog 末树')
  const appDir = mkdtempSync(path.join(tmpdir(), 'runtime-manifest-' + label + '-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  return { appDir, tree }
}

const fileOf = (appDir, rel) => path.join(appDir, ...rel.split('/'))
const listFiles = (root, prefix = '') => {
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (entry.isDirectory()) out.push(...listFiles(path.join(root, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}
const snapshotDir = (appDir, { exclude = [] } = {}) => new Map(listFiles(appDir).filter(rel => !exclude.includes(rel)).map(rel => [rel, readFileSync(fileOf(appDir, rel))]))
function assertSameDir(appDir, snapshot, label) {
  assert.deepEqual(listFiles(appDir).sort(), [...snapshot.keys()].sort(), label + '：目录文件清单必须不变')
  for (const [rel, bytes] of snapshot) assert.deepEqual(readFileSync(fileOf(appDir, rel)), bytes, label + '：字节必须不变：' + rel)
}
function rewritePackageVersion(appDir, version) {
  const file = fileOf(appDir, PKG_REL)
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(pkg.name, 'dsh-tavern-plugin', '夹具 package 必须是作者包名')
  pkg.version = version
  writeFileSync(file, Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8'))
}
function appendHarmlessComment(appDir, rel, note) {
  const file = fileOf(appDir, rel)
  assert.equal(existsSync(file), true, '夹具缺该文件：' + rel)
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n// ' + note + '\n', 'utf8')]))
}
/** 按**作者文件集**签清单（authorRels ∪ package.json 中现存者；插件自有桥/记录不得进清单），返回清单 bytes。 */
function signManifest(appDir, { revision = 'a'.repeat(40), releaseSequence = 9999, version, authorRels }) {
  assert.ok(Array.isArray(authorRels) && authorRels.length > 0, '签清单必须给作者文件集（authorRels）')
  const pkg = JSON.parse(readFileSync(fileOf(appDir, PKG_REL), 'utf8'))
  const wanted = new Set([PKG_REL, ...authorRels])
  const files = [...wanted].sort().filter(rel => existsSync(fileOf(appDir, rel))).map(rel => {
    const bytes = readFileSync(fileOf(appDir, rel))
    return { path: rel, sha256: sha(bytes), size: bytes.length }
  })
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, revision, releaseSequence, version: version ?? pkg.version, files }), 'utf8')
  writeFileSync(fileOf(appDir, MANIFEST_REL), bytes)
  return bytes
}
const authorRelsOf = tree => Object.entries(tree.files).filter(([, item]) => item !== null).map(([rel]) => rel)
const readRecord = appDir => JSON.parse(readFileSync(fileOf(appDir, RECORD_REL), 'utf8'))
const assertLocalManifestRecord = (record, manifestBytes, label) => {
  assert.equal(record.compatibilityMode, LOCAL_MODE, label + '：record.compatibilityMode 必须是 ' + LOCAL_MODE)
  assert.ok(record.runtimeManifest && typeof record.runtimeManifest === 'object', label + '：record.runtimeManifest 必须存在')
  assert.equal(record.runtimeManifest.body, manifestBytes.toString('base64'), label + '：runtimeManifest.body 必须是清单 bytes 的 canonical base64')
  assert.equal(record.runtimeManifest.sha256, sha(manifestBytes), label + '：runtimeManifest.sha256 必须是清单 bytes 摘要')
}
/** 自洽性前置：用自带 validator 确认清单与现场一致（不含 images ⇒ 不做 owned 判定）。 */
function assertManifestSelfConsistent(appDir, manifestBytes) {
  const targets = listFiles(appDir).filter(rel => rel.endsWith('.js'))
  const validated = validateRuntimeManifest({ appDir, targets, images: null, projection: null })
  assert.equal(validated.ok, true, '前置：本地清单必须自洽：' + JSON.stringify(validated?.failures || validated))
  assert.equal(validated.witness.sha256, sha(manifestBytes))
}

test('本地清单未收录代首装放行记录模式且卸载逐字节复原', async t => {
  const { appDir, tree } = copyLastTree(t, 'install')
  rewritePackageVersion(appDir, '2.5.91')
  appendHarmlessComment(appDir, COMMENT_REL, 'local harmless note (non-anchor)')
  const manifestBytes = signManifest(appDir, { version: '2.5.91', authorRels: authorRelsOf(tree) })
  assertManifestSelfConsistent(appDir, manifestBytes)
  const before = snapshotDir(appDir)
  // authorVersion 一律不传：由真实 package.json（2.5.91）读取，不迎合固定身份
  const applied = applyStandardSeams({ appDir })
  assert.equal(applied.changed, true, '首装必须产生变更（未收录代走本地清单路径）')
  assert.equal(applied.compatibilityMode, LOCAL_MODE, 'apply 首装返回值必须带 compatibilityMode=' + LOCAL_MODE)
  assert.equal(checkStandardSeams({ appDir }).ready, true, '首装后严格 check 必须 ready')
  const record = readRecord(appDir)
  assertLocalManifestRecord(record, manifestBytes, '首装后')
  assert.equal(record.authorVersion, '2.5.91', 'record.authorVersion 取作者包版本')
  assert.equal(Object.hasOwn(record.after, PKG_REL), false, 'package.json 不得进 after（after＝全 TARGETS+artifacts 现存文件）')
  assert.ok(Object.hasOwn(record.after, 'tavern-plugin/lib/index.js'), 'after 必须覆盖 TARGETS 现存文件（例：入口）')
  assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), manifestBytes, '安装不得改动现场清单')
  assert.deepEqual(readFileSync(fileOf(appDir, PKG_REL)), before.get(PKG_REL), '安装不得改动 package.json')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), true, '首装必须写入自有桥')
  const removed = uninstallStandardSeams({ appDir })
  assert.equal(removed.changed, true, '卸载必须产生变更')
  assertSameDir(appDir, before, '卸载后')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), false, '卸载必须删除自有桥')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '卸载后不得残留标准记录')
})

test('本地清单自洽但必需转换锚点被破坏时首装拒绝且现场不变', async t => {
  const { appDir, tree } = copyLastTree(t, 'broken-anchor')
  rewritePackageVersion(appDir, '2.5.91')
  appendHarmlessComment(appDir, COMMENT_REL, 'local harmless note (non-anchor)')
  const indexFile = fileOf(appDir, 'tavern-plugin/lib/index.js')
  const source = readFileSync(indexFile, 'utf8')
  assert.equal(source.split(OPENING_HOST_ANCHOR).length - 1, 1, '前置：必需锚点在夹具里恰一处')
  writeFileSync(indexFile, source.replace(OPENING_HOST_ANCHOR, 'createOpeningPreparation({ readCard, worldBooks, /* anchor removed by fixture */ extensionSettings:'))
  const manifestBytes = signManifest(appDir, { version: '2.5.91', authorRels: authorRelsOf(tree) })
  assertManifestSelfConsistent(appDir, manifestBytes)
  const before = snapshotDir(appDir)
  assert.throws(() => applyStandardSeams({ appDir }), /清单代(?:隔离预演|安装)失败/, '必需锚点被破坏时首装必须 throw（隔离预演失败）')
  assertSameDir(appDir, before, '首装被拒后现场')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '被拒首装不得留下标准记录')
  // 裁定（2026-10-08）：无记录 + 未知代的**严格 check 就是 throw**（既有契约）；可用身份只在授权兼容模式（allowRebase:true）下判定。
  assert.throws(() => checkStandardSeams({ appDir }), /拒绝未知版本/, '无记录未知代的严格 check 必须 throw（拒绝未知版本）')
  assert.equal(checkStandardSeams({ appDir, allowRebase: true }).ready, false, '授权兼容模式下该树仍不是可用身份（not ready）')
  assertSameDir(appDir, before, 'check 之后现场')
})

test('首装后作者代覆盖重接成功且卸载回新原字节', async t => {
  const { appDir, tree } = copyLastTree(t, 'reapply')
  rewritePackageVersion(appDir, '2.5.91')
  appendHarmlessComment(appDir, COMMENT_REL, 'local harmless note (non-anchor)')
  const firstManifest = signManifest(appDir, { version: '2.5.91', authorRels: authorRelsOf(tree) })
  assert.equal(applyStandardSeams({ appDir }).changed, true, '前置：首装成功')
  assertLocalManifestRecord(readRecord(appDir), firstManifest, '前置首装后')
  // 作者代覆盖：**从 tree.files 恢复全部非 null 作者字节**（不是在我们已安装的字节上追加），再注释并重签新 pkg
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = fileOf(appDir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  rewritePackageVersion(appDir, '2.5.92')
  appendHarmlessComment(appDir, COMMENT_REL_NEXT, 'next author release note')
  // 清单只签作者文件集（插件自有桥/记录不得进清单——owned artifacts 保留在树上但不属作者代）
  const newManifest = signManifest(appDir, { revision: 'b'.repeat(40), releaseSequence: 10000, version: '2.5.92', authorRels: authorRelsOf(tree) })
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), true, '覆盖时必须保留标准记录')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), true, '覆盖时必须保留 owned artifacts')
  // 期望"新裸原字节"＝tree.files 非 null 作者 rels + package + MANIFEST 的**当下**字节
  // （保留中的插件 owned 桥/历史 records/backups 不是作者原件，uninstall 会删掉，不进期望 Map）
  const newOriginal = new Map([...authorRelsOf(tree), PKG_REL, MANIFEST_REL].map(rel => [rel, readFileSync(fileOf(appDir, rel))]))
  const applied = applyStandardSeams({ appDir })
  assert.equal(applied.changed, true, '作者代覆盖后 apply 必须重接成功')
  assert.equal(checkStandardSeams({ appDir }).ready, true, '重接后严格 check 必须 ready')
  const record = readRecord(appDir)
  assert.equal(record.compatibilityMode, LOCAL_MODE, '重接后记录仍须标记 ' + LOCAL_MODE)
  assert.ok(record.runtimeManifest && typeof record.runtimeManifest.body === 'string', '重接后记录仍须带 runtimeManifest')
  assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), newManifest, '重接不得改动新清单')
  assert.equal(uninstallStandardSeams({ appDir }).changed, true, '重接后卸载必须产生变更')
  assertSameDir(appDir, newOriginal, '重接后卸载')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), false, '卸载必须删除自有桥')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '卸载后不得残留标准记录')
})

test('已装package.json漂移且清单未更新时check与卸载拒绝且不写', async t => {
  const { appDir, tree } = copyLastTree(t, 'drift')
  rewritePackageVersion(appDir, '2.5.91')
  appendHarmlessComment(appDir, COMMENT_REL, 'local harmless note (non-anchor)')
  const manifestBytes = signManifest(appDir, { version: '2.5.91', authorRels: authorRelsOf(tree) })
  assert.equal(applyStandardSeams({ appDir }).changed, true, '前置：首装成功')
  const record = readRecord(appDir)
  assert.equal(Object.hasOwn(record.after, PKG_REL), false, '前置：package.json 不在 after（漂移点应落在清单身份上）')
  // 漂移：package.json 加 extra 字段（version 保持），**不更新清单**
  const pkgFile = fileOf(appDir, PKG_REL)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.localExtraField = 'unauthorized drift'
  writeFileSync(pkgFile, Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8'))
  assert.equal(JSON.parse(readFileSync(pkgFile, 'utf8')).version, '2.5.91', '漂移不得改 version')
  assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), manifestBytes, '漂移不得更新清单')
  const drifted = snapshotDir(appDir)
  assert.throws(() => checkStandardSeams({ appDir }), /漂移/, '严格 check 必须 throw')
  assertSameDir(appDir, drifted, 'check 之后现场')
  // 裁定（2026-10-08）：manifest plan 失败时**无论 allowRebase 都 throw**（防 allowRebase 漂移 ready 假阳性）
  assert.throws(() => checkStandardSeams({ appDir, allowRebase: true }), /漂移/, '授权兼容模式下本地清单计划失败也必须 throw')
  assertSameDir(appDir, drifted, '授权模式 check 之后现场')
  assert.throws(() => uninstallStandardSeams({ appDir }), /漂移|拒绝/, '漂移后卸载必须 throw')
  assertSameDir(appDir, drifted, '卸载被拒后现场')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), true, '被拒卸载不得删除标准记录')
})

test('本地清单首装后残留卸载保留未知代作者字节且不补冻结字节', async t => {
  const { appDir, tree } = copyLastTree(t, 'residual')
  rewritePackageVersion(appDir, '2.5.91')
  appendHarmlessComment(appDir, COMMENT_REL, 'local harmless note (non-anchor)')
  const manifestBytes = signManifest(appDir, { version: '2.5.91', authorRels: authorRelsOf(tree) })
  // 首装前的"未知代裸作者字节"（含注释）——残留卸载必须回到这些字节，而不是冻结目录的字节
  const bareAuthor = new Map(authorRelsOf(tree).map(rel => [rel, readFileSync(fileOf(appDir, rel))]))
  const gzSha = sha(readFileSync(GZ))
  assert.equal(applyStandardSeams({ appDir }).changed, true, '前置：本地清单首装成功')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), true, '前置：自有桥已写入')
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'runtime-manifest-evidence-'))
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }))
  const adapter = { packageName: 'dsh-tavern-sqlite-v2', targets: maintenanceTargets }
  const source = sourceAccess(appDir, maintenanceTargets)
  const snapshot = source.capture()
  const plan = planResidualUninstall({ source, adapter })
  assert.deepEqual(source.capture(), snapshot, '计划只读：不得改动源码')
  // ① 未知代非锚点注释必须保留在原位（＝用记录前像，不从冻结目录补字节）
  const expectedComment = decodeImage(plan.expected[COMMENT_REL])
  assert.ok(expectedComment, '计划必须给出该受管目标的卸载后字节')
  assert.equal(expectedComment.equals(bareAuthor.get(COMMENT_REL)), true, '未知代作者字节（含非锚点注释）必须逐字节保留，不得补冻结目录字节')
  assert.equal(expectedComment.toString('utf8').includes('local harmless note (non-anchor)'), true, '注释必须留在计划结果里')
  const expectedPkg = decodeImage(plan.expected[PKG_REL])
  assert.ok(expectedPkg, '计划必须给出作者 package.json 的字节（受管作者 manifest）')
  assert.equal(JSON.parse(expectedPkg.toString('utf8')).version, '2.5.91', '未知代作者 pkg 版本必须保留（不得退回冻结目录的 2.5.0）')
  // ② 零 own 标记（计划结果里不得残留任何接管标记/包名）
  for (const rel of adapter.targets) {
    if (!rel.endsWith('.js')) continue
    const expected = decodeImage(plan.expected[rel])
    if (expected === null) continue
    assert.equal(OWN_MARKER_RE.test(expected.toString('utf8')), false, '计划结果不得残留接管标记：' + rel)
  }
  assert.equal(plan.summary.fallback, true, '未知代（未收录 revision）必须走 fallback 计划')
  assert.deepEqual(plan.summary.notes ?? [], [], '计划不得报告无法证明/损坏项：' + JSON.stringify(plan.summary.notes))
  // 裁定（2026-10-08）：residual summary 必须带回本地清单模式与 witness（供 residual 侧核身份）
  assert.equal(plan.summary.compatibilityMode, LOCAL_MODE, 'summary.compatibilityMode 必须是 ' + LOCAL_MODE)
  assert.ok(plan.summary.runtimeWitness && typeof plan.summary.runtimeWitness === 'object', 'summary.runtimeWitness 必须存在')
  assert.equal(plan.summary.runtimeWitness.sha256, sha(manifestBytes), 'summary.runtimeWitness.sha256 必须等于现场清单 bytes 摘要')
  // ③ 清单与 pkg 不被计划/落地破坏
  assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), manifestBytes, '计划不得改动清单')
  assert.equal(JSON.parse(readFileSync(fileOf(appDir, PKG_REL), 'utf8')).version, '2.5.91', '计划不得改动作者 pkg 版本')
  const applied = applyResidualPlan(source, plan, evidenceDir)
  applied.verify()
  assert.equal(readFileSync(fileOf(appDir, COMMENT_REL), 'utf8').includes('local harmless note (non-anchor)'), true, '落盘后未知代注释仍在（未补冻结字节）')
  assert.equal(JSON.parse(readFileSync(fileOf(appDir, PKG_REL), 'utf8')).version, '2.5.91', '落盘后作者新版本仍在（不得退回冻结 2.5.0）')
  assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), manifestBytes, '落盘不得改动清单')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), false, '残留卸载必须撤除自有桥')
  for (const rel of adapter.targets) {
    if (!rel.endsWith('.js')) continue
    if (!existsSync(fileOf(appDir, rel))) continue
    assert.equal(OWN_MARKER_RE.test(readFileSync(fileOf(appDir, rel), 'utf8')), false, '落盘后不得残留接管标记：' + rel)
  }
  assert.equal(sha(readFileSync(GZ)), gzSha, '冻结 gz 不得被改动')
})
