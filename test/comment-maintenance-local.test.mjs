// 现场维护本地集成：真 helper 作者树 + 真 standard/source adapter；shellDriver 只 mock 本地 lifecycle（不 fake seams/DB）。
// 事实依据：夹具真实存在（前轮产品用例已证），故 index/client/工厂缺块一律 assert 失败而非 skip；失败文案取自 runner 实现两分支。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { sourceAccess, sameImage, STANDARD_RECORD } from '../deploy/maintenance/source.mjs'
import { executeMaintenance } from '../deploy/maintenance/runner.mjs'
import { prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
const OUTSIDE = 'tavern-plugin/lib/client.js'
const REVISION = "\nconst userUpstreamRevision = '9.9.9'\n"

function shellDriver({ wasRunning = false, upgrading = false, failManageAt = 0 } = {}) {
  const calls = []
  let manages = 0
  const driver = {
    runtime: {}, wasRunning, upgrading,
    async preflight(kind) { calls.push('preflight:' + kind); return { noop: false, wasRunning, upgrading, host: 'local-shell' } },
    async assertIdentity() { calls.push('identity') },
    async assertStopped() { calls.push('assertStopped') },
    async stop() { calls.push('stop') },
    async manage(kind) { manages += 1; calls.push('manage:' + kind); if (failManageAt && manages === failManageAt) throw new Error('注入 manage 失败') },
    async start() { calls.push('start'); return { pid: 1 } },
    async verify() { calls.push('verify'); return { basicHealthVerified: true } },
    async verifyRecovery() { calls.push('verifyRecovery') },
    async restorePackage() { calls.push('restorePackage') },
    beginRecovery() { calls.push('beginRecovery') },
    async stoppedAfterError() { return true },
    async stopFailedStart() { calls.push('stopFailedStart') },
    async stopIfAlive() { calls.push('stopIfAlive') },
  }
  return { driver, calls }
}
const evidence = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comment-local-evidence-'))
const run = (action, driver, source, dir) => executeMaintenance({ action, adapter, driver, source, evidenceDir: dir, progress: () => {} })
function fixture(t) {
  const tree = prepareCommentAuthorTree()
  if (!tree) return null // 唯一允许的 skip：完全没有真实作者源码来源
  t.after(() => tree.cleanup())
  const prepared = { tree, source: sourceAccess(tree.appDir, adapter.targets), evidence: evidence() }
  t.after(() => fs.rmSync(prepared.evidence, { recursive: true, force: true }))
  assert.ok(prepared.source.text(INDEX) !== null, '真实 helper 必须提供作者入口：' + INDEX)
  assert.ok(prepared.source.text(OUTSIDE) !== null, '真实 helper 必须提供块外目标：' + OUTSIDE)
  return prepared
}

test('现场CLI1 无记录变量修改真实装卸', async t => {
  const f = fixture(t)
  if (!f) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  const edited = f.source.text(OUTSIDE) + '\nconst userVar = 7\n' // 无记录的块外用户改动
  fs.writeFileSync(f.source.file(OUTSIDE), edited, 'utf8')
  assert.equal(f.source.readRecord(), null, '前置：首装前不应有记录')
  // 两式各一轮：每轮都**先真装**再破坏记录 —— 证的是"按现场完整块还原 + 块外改动保留"，不是只清记录
  for (const broken of ['{broken\n', 'null\n']) {
    const on = await run('install', shellDriver().driver, f.source, f.evidence)
    assert.equal(on.changed, true, '真实施缝必须产生变更：' + broken.trim())
    assert.ok(f.source.readRecord() !== null, '真实施缝必须落记录：' + broken.trim())
    fs.writeFileSync(f.source.file(STANDARD_RECORD), broken, 'utf8')
    const off = await run('uninstall', shellDriver().driver, f.source, f.evidence)
    assert.equal(off.changed, true, '坏记录不得阻断按现场块卸载：' + broken.trim())
    assert.equal(f.source.blockPresence().length, 0, '卸载后不得残留本 owner 块：' + broken.trim())
    assert.equal(f.source.text(OUTSIDE), edited, '块外用户改动必须逐字节保留：' + broken.trim())
  }
})

test('现场CLI2 上游覆盖部分区块清残留保留新源码', async t => {
  const f = fixture(t)
  if (!f) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  const original = f.source.text(INDEX)
  assert.equal((await run('install', shellDriver().driver, f.source, f.evidence)).changed, true, '前置：先真装一次')
  assert.ok(f.source.blockPresence().length >= 1, '前置：安装后必须存在本 owner 块')
  // 上游覆盖：入口回到作者 base，并在**源码末尾精确追加**新语句（保持锚点；不用正则改可能不存在的字面）
  fs.writeFileSync(f.source.file(INDEX), original + REVISION, 'utf8')
  const again = await run('install', shellDriver().driver, f.source, f.evidence)
  assert.equal(again.changed, true, '上游覆盖后必须能清残留并按当前源码重接')
  const now = f.source.text(INDEX)
  assert.ok(now.endsWith(REVISION), '上游新增必须精确保留在源码末尾（不回历史 before）')
  assert.ok(now.includes('[dsh-tavern-seam:BEGIN]'), '必须重新命中接缝安装')
})

test('现场CLI3 新块插件换代装配与失败恢复', async t => {
  const f = fixture(t)
  if (!f) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  const base = await run('install', shellDriver().driver, f.source, f.evidence) // 先建立"已装"基线
  assert.equal(base.changed, true, '前置：基线安装必须成功')
  const upgrade = shellDriver({ upgrading: true })
  assert.equal((await run('install', upgrade.driver, f.source, f.evidence)).changed, true, '同名换代必须成功')
  assert.deepEqual(upgrade.calls.filter(call => call.startsWith('manage:')), ['manage:uninstall', 'manage:install'], '换代必须单命令内先卸旧装配再装新代')
  const beforeFail = f.source.capture()
  const failing = shellDriver({ upgrading: true, failManageAt: 2 }) // 卸旧成功、装新代失败
  let failure = null
  try { await run('install', failing.driver, f.source, f.evidence) } catch (error) { failure = error }
  assert.ok(failure, '装新代失败必须抛错')
  assert.match(String(failure.message), /维护失败/, 'runner 两分支都带"维护失败"前缀（读实现，不猜）')
  assert.ok(failing.calls.includes('restorePackage'), '失败必须走装配恢复')
  assert.ok(sameImage(f.source.capture(), beforeFail), '失败后源码/记录必须回到本次升级前现场（不只"调用过 restorePackage"）')
})
