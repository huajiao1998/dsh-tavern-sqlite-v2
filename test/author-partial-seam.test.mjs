// 单一负例具名：部分施缝漂移（我方 patch 未回滚、作者/局部更新在位）必须整体拒绝且不覆盖现场。
// 真实 catalog 有限源码 + 真实 apply/plan/uninstall；只读 sourceAccess 校验字节未变；无 SDK、无真实数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAuthorImages, authorImages } from '../deploy/author-compatibility.mjs'
import { applyStandardSeams, inspectStandardSeamsPlan, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'

const RECORD = '.tavern-standard-seams.json'
const INDEX = 'tavern-plugin/lib/index.js'

test('部分施缝漂移拒绝且不覆盖作者更新', () => {
  const tree = authorImages(loadAuthorImages()).at(-1)
  assert.equal(typeof tree?.commit, 'string', '需要既有官方基线 tree')
  const appDir = mkdtempSync(path.join(tmpdir(), 'author-partial-seam-'))
  try {
    for (const [rel, buf] of Object.entries(tree.files)) {
      if (!buf) continue
      const file = path.join(appDir, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, buf)
    }
    assert.equal(applyStandardSeams({ appDir }).changed, true, '首装应实际施缝')

    // 只改“已施缝”的 host：保留我方 core 标记，同时让 record.after 哈希失配（部分施缝漂移）
    const index = readFileSync(path.join(appDir, INDEX), 'utf8')
    assert.ok(index.includes('[dsh-tavern'), '已施缝 host 应含我方标记')
    writeFileSync(path.join(appDir, INDEX), '// 局部修改\n' + index, 'utf8')

    const access = sourceAccess(appDir, maintenanceTargets)
    const before = access.capture()
    const recordBefore = readFileSync(path.join(appDir, RECORD))

    const plan = inspectStandardSeamsPlan({ appDir })
    assert.equal(plan.ready, false, '部分施缝漂移不得判 ready')
    assert.equal(plan.compatible, null, '部分施缝漂移不得判契约兼容')

    assert.throws(() => applyStandardSeams({ appDir }), /漂移|兼容|拒|未知|失败/, '重接必须拒绝')
    assert.throws(() => uninstallStandardSeams({ appDir }), /漂移|标准|记录/, '严格卸载必须拒绝')

    assert.deepEqual(access.capture(), before, '拒绝路径不得改写任何源码字节')
    assert.ok(readFileSync(path.join(appDir, RECORD)).equals(recordBefore), '标准记录不得被改写')
    assert.ok(readFileSync(path.join(appDir, INDEX), 'utf8').startsWith('// 局部修改\n'), '局部/作者更新必须原样保留')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})
