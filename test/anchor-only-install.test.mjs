// 接入锚点-only 具名最小断言（**先写不跑**，待主给确切断言执行）。
//
// 契约（2026-10-09 用户授权）：
//   · 首次安装不再要求发布清单/冻结字节一致：无清单、坏清单、过时清单、未知作者版本都不阻挡；
//     准入＝隔离完整施缝＋语法检查＋ready（applyStandardSeams 的锚点-only 首装路径）。
//   · authorVersion 只是诊断（package name=dsh-tavern-plugin 身份保留）；严格 installed check 只看 record.after。
//   · planAuthorRebase 不再以 catalog/manifest 归约：after 命中 ⇒ 用记录真实 before 还原作者字节；
//     before 为 null/缺键仅"明确 owned/artifact 路径"才归零；未命中 after 的裸作者更新保当前字节。
//   · uninstall 严格 after 保护：漂移即拒绝且不写。
// 夹具：真实 catalog 末树（3100d223）复制到自有 tmp；package version 改为未知代 '2.5.91'。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAuthorCleanImages } from '../deploy/maintenance/residual-uninstall.mjs'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { AUTHOR_PACKAGE_REL } from '../deploy/author-runtime-manifest.mjs'

const RECORD_REL = '.tavern-standard-seams.json'
const MANIFEST_REL = 'dsh-tavern-runtime.json'
const PKG_REL = AUTHOR_PACKAGE_REL
const OWNED_BRIDGE_REL = 'tavern-plugin/lib/domain/storage-native-data.js'
const COMMENT_REL = 'tavern-plugin/lib/domain/settlement-jobs.js'          // 非锚点：仅追加注释
const NEXT_REL = 'tavern-plugin/lib/domain/auto-compaction.js'              // 同上，用于"裸作者更新"
// 真必需锚点（buildCore 强制；与 deploy/standard-seams.mjs 的 openingHostAnchor 逐字一致）
const OPENING_HOST_ANCHOR = 'createOpeningPreparation({ readCard, worldBooks, extensionSettings:'

function fixture(t, label) {
  const catalog = loadAuthorCleanImages()
  const tree = catalog.trees.at(-1)
  assert.ok(tree, '缺 catalog 末树')
  const appDir = mkdtempSync(path.join(tmpdir(), 'anchor-only-' + label + '-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  // 未知作者代：版本改成 catalog 里没有的值（不再是准入条件，只作诊断）
  const pkgFile = path.join(appDir, ...PKG_REL.split('/'))
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  assert.equal(pkg.name, 'dsh-tavern-plugin', '夹具必须仍是作者包名')
  pkg.version = '2.5.91'
  writeFileSync(pkgFile, Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8'))
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
const authorRelsOf = tree => Object.entries(tree.files).filter(([, item]) => item !== null).map(([rel]) => rel)
/** 作者源码快照（作者文件 + package；清单单列，插件自有桥/记录不算作者原件）。 */
const authorSnapshot = (appDir, tree, { manifest = null } = {}) => {
  const rels = [...authorRelsOf(tree), PKG_REL, ...(manifest ? [MANIFEST_REL] : [])]
  return new Map(rels.map(rel => [rel, readFileSync(fileOf(appDir, rel))]))
}
function assertAuthorBytes(appDir, snapshot, label) {
  const extras = listFiles(appDir).filter(rel => !snapshot.has(rel))
  assert.deepEqual(extras.filter(rel => rel !== RECORD_REL && !rel.includes('storage-') && !rel.endsWith('.bak') && !rel.endsWith('.backup')), [], label + '：不得留下非插件自有残留')
  for (const [rel, bytes] of snapshot) assert.deepEqual(readFileSync(fileOf(appDir, rel)), bytes, label + '：字节必须逐字相同：' + rel)
}
const appendComment = (appDir, rel, note) => {
  const file = fileOf(appDir, rel)
  assert.equal(existsSync(file), true, '夹具缺该文件：' + rel)
  writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('\n// ' + note + '\n', 'utf8')]))
}

test('无manifest未知版本变量注释首装check卸回精确字节', async t => {
  const { appDir, tree } = fixture(t, 'nomanifest')
  assert.equal(existsSync(fileOf(appDir, MANIFEST_REL)), false, '前置：本用例不提供发布清单')
  appendComment(appDir, COMMENT_REL, '未知代变量注释（非锚点）')
  // 用户变量数值：**真实修改既有非锚点常量**（domain/tavern-script-dispatch.js 的 EXECUTION_TIMEOUT_MS），
  // 并确认同文件转换锚点（CLAIM_TIMEOUT_MS 行）仍在 ⇒ 证明"接入点仍命中、非锚点数值原样带入"。
  const dispatchRel = maintenanceTargets.find(rel => rel.endsWith('/tavern-script-dispatch.js'))
  assert.ok(dispatchRel, '夹具缺受管目标 tavern-script-dispatch.js')
  const dispatchAbs = fileOf(appDir, dispatchRel)
  const dispatchRaw = readFileSync(dispatchAbs, 'utf8')
  assert.equal(dispatchRaw.includes('export const TAVERN_SCRIPT_EXECUTION_TIMEOUT_MS = 60000'), true, '前置：既有非锚点常量应为 60000')
  assert.equal(dispatchRaw.includes('export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000'), true, '前置：转换锚点（CLAIM 行）在场')
  writeFileSync(dispatchAbs, dispatchRaw.replace('export const TAVERN_SCRIPT_EXECUTION_TIMEOUT_MS = 60000', 'export const TAVERN_SCRIPT_EXECUTION_TIMEOUT_MS = 61000'), 'utf8')
  const snapshot = authorSnapshot(appDir, tree)
  const applied = applyStandardSeams({ appDir })                      // 不传 authorVersion：诊断值由 package 读取
  assert.equal(applied.changed, true, '无清单未知版本首装必须成功（锚点-only 隔离预演）')
  assert.equal(applied.compatibilityMode, 'anchor-only', 'apply 首装返回值必须标 anchor-only')
  assert.equal(checkStandardSeams({ appDir }).ready, true, '首装后严格 check 必须 ready')
  const record = JSON.parse(readFileSync(fileOf(appDir, RECORD_REL), 'utf8'))
  assert.equal(record.version, 1)
  assert.equal(record.authorVersion, '2.5.91', 'record.authorVersion 取作者包版本（诊断）')
  assert.equal(record.compatibilityMode, 'anchor-only', '新记录必须写真实 anchor-only 模式字段')
  assert.equal(Object.hasOwn(record, 'runtimeManifest'), false, '新记录不得写 runtimeManifest')
  assert.ok(Object.hasOwn(record.after, 'tavern-plugin/lib/index.js'), 'after 必须覆盖 TARGETS 现存文件')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), true, '首装应写入自有桥')
  // 用户修改必须带入缝合态：非锚点数值原样、既有注释不得被无故删除
  assert.equal(readFileSync(dispatchAbs, 'utf8').includes('TAVERN_SCRIPT_EXECUTION_TIMEOUT_MS = 61000'), true, '首装后非锚点用户数值必须原样保留')
  assert.equal(readFileSync(dispatchAbs, 'utf8').includes('TAVERN_SCRIPT_CLAIM_TIMEOUT_MS'), true, '转换锚点仍应在场（预算转换已接）')
  assert.equal(readFileSync(fileOf(appDir, COMMENT_REL), 'utf8').includes('未知代变量注释'), true, '首装不得无故删除既有注释')
  assert.equal(uninstallStandardSeams({ appDir }).changed, true, '卸载必须成功')
  assertAuthorBytes(appDir, snapshot, '卸载后')
  assert.equal(readFileSync(fileOf(appDir, COMMENT_REL), 'utf8').includes('未知代变量注释（非锚点）'), true, '卸载必须逐字回到含变量注释的作者前像')
  assert.equal(readFileSync(dispatchAbs, 'utf8').includes('TAVERN_SCRIPT_EXECUTION_TIMEOUT_MS = 61000'), true, '卸载必须回到用户修改后的数值 61000')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), false, '卸载必须删除自有桥')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '卸载必须删除标准记录')
})

test('坏或过时manifest不阻挡首装与卸载', async t => {
  for (const [label, bytes] of [
    ['坏清单（非 JSON）', Buffer.from('{ this is not json', 'utf8')],
    ['过时清单（自洽但描述别的代）', Buffer.from(JSON.stringify({ schemaVersion: 2, revision: 'c'.repeat(40), releaseSequence: 1, version: '2.5.0', files: [{ path: PKG_REL, sha256: 'd'.repeat(64), size: 1 }] }), 'utf8')],
  ]) {
    const { appDir, tree } = fixture(t, label === '坏清单（非 JSON）' ? 'badmanifest' : 'stalemanifest')
    appendComment(appDir, COMMENT_REL, '注释位（' + label + '）')
    writeFileSync(fileOf(appDir, MANIFEST_REL), bytes)
    const snapshot = authorSnapshot(appDir, tree, { manifest: true })
    const applied = applyStandardSeams({ appDir })
    assert.equal(applied.changed, true, label + '：必须不阻挡首装')
    assert.equal(checkStandardSeams({ appDir }).ready, true, label + '：首装后必须 ready')
    assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), bytes, label + '：安装不得改动清单字节')
    assert.equal(uninstallStandardSeams({ appDir }).changed, true, label + '：卸载必须成功')
    assertAuthorBytes(appDir, snapshot, label + ' 卸载后')
    assert.deepEqual(readFileSync(fileOf(appDir, MANIFEST_REL)), bytes, label + '：卸载不得改动清单字节')
  }
})

test('必要锚点破坏预演失败现场不写', async t => {
  const { appDir, tree } = fixture(t, 'broken')
  appendComment(appDir, COMMENT_REL, '注释位（锚点破坏）')
  const indexFile = fileOf(appDir, 'tavern-plugin/lib/index.js')
  const source = readFileSync(indexFile, 'utf8')
  assert.equal(source.split(OPENING_HOST_ANCHOR).length - 1, 1, '前置：必需锚点在夹具里恰一处')
  writeFileSync(indexFile, source.replace(OPENING_HOST_ANCHOR, 'createOpeningPreparation({ readCard, worldBooks, /* anchor removed */ extensionSettings:'))
  const snapshot = authorSnapshot(appDir, tree)
  const before = new Map(listFiles(appDir).map(rel => [rel, readFileSync(fileOf(appDir, rel))]))
  assert.throws(() => applyStandardSeams({ appDir }), /锚点-only 隔离预演失败|锚点-only 安装失败/, '必需锚点破坏必须 throw（隔离预演失败）')
  assert.deepEqual(listFiles(appDir).sort(), [...before.keys()].sort(), '被拒后不得新增/删除文件（含记录）')
  for (const [rel, bytes] of before) assert.deepEqual(readFileSync(fileOf(appDir, rel)), bytes, '被拒后字节必须不变：' + rel)
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '被拒首装不得留下标准记录')
  assert.equal(checkStandardSeams({ appDir }).ready, false, '被拒后严格 check 必须 not ready')
  void snapshot
})

test('作者裸更新重接并卸回修改后源码', async t => {
  const { appDir, tree } = fixture(t, 'bareupdate')
  appendComment(appDir, COMMENT_REL, '首装注释位')
  assert.equal(applyStandardSeams({ appDir }).changed, true, '前置：首装成功')
  // 裸作者更新：从 tree.files 恢复全部作者字节 + 新版本 + 另一处修改（无清单）
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = fileOf(appDir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  const pkgFile = fileOf(appDir, PKG_REL)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.version = '2.5.92'
  writeFileSync(pkgFile, Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8'))
  appendComment(appDir, NEXT_REL, '裸更新的修改（非锚点）')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), true, '裸更新时记录仍在（未卸载）')
  const updated = authorSnapshot(appDir, tree)
  const applied = applyStandardSeams({ appDir })
  assert.equal(applied.changed, true, '裸作者更新必须允许预演重接')
  assert.equal(checkStandardSeams({ appDir }).ready, true, '重接后严格 check 必须 ready')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), true, '重接后自有桥仍应在场')
  assert.equal(uninstallStandardSeams({ appDir }).changed, true, '重接后卸载必须成功')
  assertAuthorBytes(appDir, updated, '重接后卸载')
  assert.equal(readFileSync(fileOf(appDir, NEXT_REL), 'utf8').includes('裸更新的修改（非锚点）'), true, '卸载必须回到"修改后"源码（不是首装前旧字节）')
  assert.equal(JSON.parse(readFileSync(fileOf(appDir, PKG_REL), 'utf8')).version, '2.5.92', '卸载后作者版本必须是裸更新后的 2.5.92')
  assert.equal(existsSync(fileOf(appDir, OWNED_BRIDGE_REL)), false, '卸载必须删除自有桥')
})
