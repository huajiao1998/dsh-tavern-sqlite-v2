// 只验新bridge的有限残留归属：无记录时仅按catalog.ownedFiles可信字节删除；自建b741官方fixture，不读真实档/业务/服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadAuthorCleanImages, planResidualUninstall } from '../deploy/maintenance/residual-uninstall.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'
import { maintenanceTargets } from '../deploy/standard-seams.mjs'
const BRIDGE = 'tavern-plugin/lib/domain/storage-db-save.js', INDEX = 'tavern-plugin/lib/index.js'
const B741 = 'b74135535ec0b37b11ed77f252dd034c3ce5e285', DD875 = 'dd8757c8b32c5f92152339bed2599c949752a5ce'
const ADAPTER = Object.freeze({
  packageName: 'dsh-tavern-sqlite-v2', targets: [...maintenanceTargets],
  otherHostMarker: '[dsh-tavern-v1-storage-host:v1]', uninstallStandardSeams: () => {}, uninstallAllSeams: () => {}
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function generatorBridgeBody() {
  const text = readFileSync(new URL('../deploy/standard-seams.mjs', import.meta.url), 'utf8')
  const header = /function shim\(body\) \{ return '([^']*)' \+ body \}/.exec(text)
  const line = /storage-db-save\.js', shim\("((?:[^"\\]|\\.)*)"\)/.exec(text)
  assert.ok(header && line, 'standard-seams bridge 生成点未命中')
  const unescape = literal => JSON.parse('"' + literal.replace(/\\'/g, "'") + '"')
  return unescape(header[1]) + unescape(line[1])
}
function fixture(t, { receipt, bridgeBytes } = {}) {
  const catalog = loadAuthorCleanImages(), tree = catalog.trees.find(item => item.commit === B741)
  const appDir = mkdtempSync(path.join(tmpdir(), 'dsh-db-owned-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const target = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(item.body, 'base64'))
  }
  writeFileSync(path.join(appDir, ...BRIDGE.split('/')), bridgeBytes ?? generatorBridgeBody())
  if (receipt) writeFileSync(path.join(appDir, '.dsh-tavern-release.json'), JSON.stringify({ commit: receipt }))
  return { catalog, tree, appDir }
}
function plan(f) { return planResidualUninstall({ source: sourceAccess(f.appDir, ADAPTER.targets), adapter: ADAPTER, catalog: f.catalog }) }
test('DB新桥接有限残留无记录按可信字节归属', t => {
  const body = generatorBridgeBody()
  for (const receipt of [undefined, B741, DD875]) {
    const f = fixture(t, { receipt }), result = plan(f), summary = result.summary
    assert.equal(summary.authorReceipt, receipt || null)
    assert.deepEqual(summary.notes, [], '不应有未决问题')
    const touched = summary.changedFiles.map(entry => entry.relative)
    assert.deepEqual(touched.filter(rel => rel !== BRIDGE && rel !== INDEX), [], '只应动新bridge（index 仅独立原件启动保护）')
    const bridgeChange = summary.changedFiles.find(entry => entry.relative === BRIDGE)
    assert.ok(bridgeChange, '新bridge未被归档：receipt=' + receipt)
    assert.equal(bridgeChange.afterSha256, null)
    assert.equal(result.expected[BRIDGE], null)
    assert.equal(bridgeChange.beforeSha256, sha(Buffer.from(body, 'utf8')))
    // 官方字节一律保留：抽样核对未改
    for (const rel of ['tavern-plugin/lib/http/routes.js', 'tavern-plugin/lib/domain/tavern-conversation-registry.js', 'tavern-plugin/lib/domain/session-resource-access.js']) {
      assert.equal(result.expected[rel], result.before[rel], '官方字节被改写：' + rel)
      assert.ok(summary.keptOfficialFiles.includes(rel), '官方文件未被识别为保留：' + rel)
    }
  }
  // 同名字节不可信：不删且响亮拒绝，不假报卸净
  const unknown = fixture(t, { bridgeBytes: generatorBridgeBody() + '// 外部改动\n' })
  assert.throws(() => plan(unknown), /归属不能确认/)
})
