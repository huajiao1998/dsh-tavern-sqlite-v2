// 发布唯一全量暴露的旧期待，按场景筛选验证，不重跑旧自执行整脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { authorImages, loadAuthorImages } from '../deploy/author-compatibility.mjs'
import { applyStandardSeams, checkStandardSeams, maintenanceTargets as TARGETS } from '../deploy/standard-seams.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'author-release-failure-'))
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('author-release-failure-')); rmSync(root, { recursive: true, force: true }) })
  for (const [rel, bytes] of Object.entries(authorImages(loadAuthorImages()).at(-1).files)) if (bytes !== null) {
    const file = path.join(root, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes)
  }
  applyStandardSeams({ appDir: root })
  return { root, source: sourceAccess(root, TARGETS) }
}
test('标准接缝漂移拒绝兼容重接且现场零改', t => {
  const { root, source } = fixture(t), index = path.join(root, 'tavern-plugin/lib/index.js')
  writeFileSync(index, readFileSync(index, 'utf8') + '\n// drift\n', 'utf8')
  const before = source.capture()
  assert.throws(() => applyStandardSeams({ appDir: root }), /漂移|作者更新不兼容/)
  assert.deepEqual(source.capture(), before)
})
test('作者同代接缝仅版本变化仍严格就绪且只读', t => {
  const { root, source } = fixture(t), file = path.join(root, 'tavern-plugin/package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8')); pkg.version = '2.4.9'
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  const before = source.capture(), manifest = readFileSync(file)
  assert.equal(checkStandardSeams({ appDir: root }).ready, true)
  assert.deepEqual(source.capture(), before); assert.ok(readFileSync(file).equals(manifest))
})
