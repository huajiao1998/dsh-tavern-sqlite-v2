// 块机制 CLI 集成（真实 maintenanceAdapter + 真实 sourceAccess/runner；driver 只是进程/profile 生命周期外壳，不假 seams、不虚拟业务数据）。
// 真实作者 source 树由 fixtures/comment-author-tree.mjs 有限复制；没有来源时 skip（不假 pass）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { maintenanceAdapter } from '../deploy/maintenance.mjs'
import { sourceAccess, sameImage } from '../deploy/maintenance/source.mjs'
import { executeMaintenance } from '../deploy/maintenance/runner.mjs'
import { prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

/** 生命周期外壳：只记录/模拟 进程与 profile 装配，不提供任何 seam 行为（seams 一律走真实 adapter）。 */
function shellDriver({ noop = false, wasRunning = false, onStop = null, onVerify = null } = {}) {
  const calls = []
  const driver = {
    runtime: {}, wasRunning,
    async preflight(kind) { calls.push('preflight:' + kind); return { noop, wasRunning, host: 'test-shell' } },
    async assertIdentity() { calls.push('assertIdentity') },
    async assertStopped() { calls.push('assertStopped') },
    async stop() { calls.push('stop'); if (onStop) onStop() },
    async manage(kind) { calls.push('manage:' + kind) },
    async start() { calls.push('start'); return { pid: 1 } },
    async verify(kind) { calls.push('verify:' + kind); if (onVerify) onVerify(); return { basicHealthVerified: true, state: 'stopped' } },
    async verifyRecovery() { calls.push('verifyRecovery') },
    async restorePackage() { calls.push('restorePackage') },
    beginRecovery() { calls.push('beginRecovery') },
    async stoppedAfterError() { calls.push('stoppedAfterError'); return true },
    async stopFailedStart() { calls.push('stopFailedStart') },
    async stopIfAlive() { calls.push('stopIfAlive') },
  }
  return { driver, calls }
}
const evidenceDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comment-cli-evidence-'))
const exists = (root, rel) => fs.existsSync(path.join(root, rel))
const run = (action, driver, source, evidence) => executeMaintenance({ action, adapter: maintenanceAdapter, driver, source, evidenceDir: evidence, progress: () => {} })

test('块CLI1 真实本地安装卸载路径不读旧作者资产', async t => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  const evidence = evidenceDir()
  try {
    const source = sourceAccess(tree.appDir, maintenanceAdapter.targets)
    const install = shellDriver()
    const installed = await run('install', install.driver, source, evidence)
    assert.equal(installed.changed, true, '真实施缝必须产生变更')
    assert.equal(installed.verified, true)
    assert.deepEqual(install.calls.filter(call => call.startsWith('manage:')), ['manage:install'])
    const record = source.readRecord()
    assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
    assert.ok(Object.keys(record.files).length >= 1, '必须落块记录')
    assert.ok(source.blockPresence().length >= 1, '现场必须出现本 owner 的真实块')
    assert.deepEqual(source.oldRecordNames(), [], '不得生成任何旧机制记录')
    assert.equal(exists(tree.appDir, 'deploy'), false, 'app 树内不得出现旧资产/部署目录')
    // 块外用户编辑后真实卸载：编辑保留、块与记录撤净
    const rel = Object.keys(record.files)[0]
    fs.writeFileSync(source.file(rel), source.text(rel) + '\n// user outside edit\n', 'utf8')
    const uninstall = shellDriver()
    const removed = await run('uninstall', uninstall.driver, source, evidence)
    assert.equal(removed.changed, true)
    assert.deepEqual(uninstall.calls.filter(call => call.startsWith('manage:')), ['manage:uninstall'])
    assert.equal(source.readRecord(), null, '卸载后块记录必须移除')
    assert.deepEqual(source.blockPresence(), [], '卸载后不得残留本插件块')
    assert.ok(source.text(rel).includes('// user outside edit'), '块外用户编辑必须保留')
  } finally { tree.cleanup(); fs.rmSync(evidence, { recursive: true, force: true }) }
})

test('块CLI2 启动验证失败只撤本次写集且保留第三方变更', async t => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  const evidence = evidenceDir()
  try {
    const source = sourceAccess(tree.appDir, maintenanceAdapter.targets)
    const rels = maintenanceAdapter.targets.filter(rel => exists(tree.appDir, rel))
    const victim = rels.find(rel => rel.endsWith('.js'))
    const { driver } = shellDriver({
      onVerify: () => {
        fs.writeFileSync(source.file(victim), source.text(victim) + '\n// third party during verify\n', 'utf8')
        throw new Error('注入启动验证失败')
      },
    })
    let failure = null
    try { await run('install', driver, source, evidence) } catch (error) { failure = error }
    assert.ok(failure, '启动验证失败必须抛错')
    assert.match(String(failure.message), /维护失败/, '必须报"维护失败"而不是静默成功')
    assert.ok(source.text(victim).includes('// third party during verify'), '第三方变更必须保留、不得回盖')
    for (const rel of rels) {
      if (rel === victim || rel.endsWith('package.json')) continue
      assert.equal(source.text(rel), tree.original.get(rel), '本次写过的其它文件必须回到本次写前字节：' + rel)
    }
  } finally { tree.cleanup(); fs.rmSync(evidence, { recursive: true, force: true }) }
})

test('块CLI3 停止disposer撤块后安装重接与卸载幂等', async t => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  const evidence = evidenceDir()
  try {
    const source = sourceAccess(tree.appDir, maintenanceAdapter.targets)
    await run('install', shellDriver().driver, source, evidence) // 前置：先真实装好（造出"已装"现场）
    // 运行中重接：stop 回调＝runtime disposer 真撤缝（删记录＋撤作者行），随后必须能按块记录重接
    const reapply = shellDriver({ wasRunning: true, onStop: () => { maintenanceAdapter.uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true }) } })
    const result = await run('install', reapply.driver, source, evidence)
    assert.equal(result.changed, true)
    assert.ok(reapply.calls.includes('stop') && reapply.calls.includes('start'), 'stop/start 必须走外壳回调')
    assert.ok(reapply.calls.includes('assertStopped'), '写前后都必须核停态')
    assert.deepEqual(reapply.calls.filter(call => call.startsWith('manage:')), ['manage:install'])
    assert.equal(source.readRecord()?.owner, 'dsh-tavern-sqlite-v2', '重接后必须重新落块记录')
    assert.ok(source.blockPresence().length >= 1, '重接后现场必须有本 owner 块')
    // 卸载两次：第一次真撤缝；第二次（noop）必须幂等零写
    const first = await run('uninstall', shellDriver({ wasRunning: false }).driver, source, evidence)
    assert.equal(first.changed, true)
    const after = source.capture()
    const second = await run('uninstall', shellDriver({ wasRunning: false, noop: true }).driver, source, evidence)
    assert.equal(second.changed, false, '重复卸载必须幂等')
    assert.ok(sameImage(source.capture(), after), '重复卸载必须零写（现场逐字节不变）')
  } finally { tree.cleanup(); fs.rmSync(evidence, { recursive: true, force: true }) }
})
