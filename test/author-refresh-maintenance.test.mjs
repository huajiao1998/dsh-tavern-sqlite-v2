// 新 file（A 独立；不改产品/旧测试）：真实 runner 的「同包重装刷新」分支 + 真实有限官方资产/维护 adapter，假 driver 只做回调计数。
// 场景＝同包作者重装（作者原像覆盖源码、标准记录与自有文件仍在）⇒ 安装只刷新源码接缝，绝不重装插件包（manage 不可被调用）。
// 说明：runner 的 noop 早退分支（`state.noop===true`）会先做严格 ready 检查并直接复演卸载前像链，漂移树在此路径按设计拒绝；
// 本用例要覆盖的是安装刷新分支（`state.compatRefresh===true` ⇒ 跳过 manage、只 applyStandardSeams({allowRebase:true}) 后严格 ready）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executeMaintenance } from '../deploy/maintenance/runner.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'
import { authorImages, loadAuthorImages } from '../deploy/author-compatibility.mjs'
import { applyStandardSeams, checkStandardSeams } from '../deploy/standard-seams.mjs'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
const AUTHOR_VERSION = '2.5.0'
const STANDARD_RECORD_REL = '.tavern-standard-seams.json'

/** 把官方有限作者树的 non-null 文件物化进 appDir（只写声明目标，不遍历业务目录）。 */
function materializeAuthor(appDir, image) {
  let written = 0
  for (const [rel, body] of Object.entries(image.files)) {
    if (body === null) continue
    const target = path.join(appDir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body)
    written += 1
  }
  return written
}

test('同包作者重装安装只刷新源码而不重装插件包', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-refresh-'))
  const appDir = path.join(root, 'app'), evidenceDir = path.join(root, 'evidence')
  mkdirSync(appDir, { recursive: true }); mkdirSync(evidenceDir, { recursive: true })
  try {

  const image = authorImages(loadAuthorImages()).filter(item => item.authorVersion === AUTHOR_VERSION).at(-1)   // 同版本多树：取当前资产最新一棵
  assert.ok(image, '官方有限资产需含作者 ' + AUTHOR_VERSION + ' 树')
  const written = materializeAuthor(appDir, image)
  assert.ok(written > 20, '官方树应物化有限作者源码，实际 ' + written)

  // 真实施缝 → 严格 ready
  applyStandardSeams({ appDir })
  assert.equal(checkStandardSeams({ appDir }).ready, true)

  // 模拟作者重装：作者原像覆盖全部 non-null 文件，保留标准记录与自有文件
  materializeAuthor(appDir, image)
  assert.equal(existsSync(path.join(appDir, STANDARD_RECORD_REL)), true, '重装后标准记录应仍在')
  assert.throws(() => checkStandardSeams({ appDir }), /漂移/, '作者重装后严格检查应识别漂移（不静默通过）')
  // 同包重装必须由真实 plan 判定为"需重接"，runner 才能走刷新分支而不是重装
  const plan = adapter.inspectStandardSeamsPlan?.({ appDir })
  assert.ok(plan, '维护 adapter 必须提供 inspectStandardSeamsPlan')
  assert.equal(plan.needsRefresh === true || plan.needsReapply === true, true, 'plan 应判定需重接：' + JSON.stringify({ needsRefresh: plan.needsRefresh, needsReapply: plan.needsReapply }))

  const calls = []
  const driver = {
    runtime: { windowsCli: true },
    preflight: async action => { calls.push('preflight:' + action); return { noop: true, wasRunning: false } },   // 同包已装：compatRefresh 必须由 runner 自己判定，不由 fixture 代设
    assertIdentity: async () => { calls.push('assertIdentity') },
    assertStopped: async () => { calls.push('assertStopped') },
    stop: async () => { calls.push('stop') },
    start: async () => { calls.push('start'); throw new Error('原本停止不得拉起服务') },
    manage: async action => { calls.push('manage:' + action); throw new Error('不得重装同包') },
    verify: async action => { calls.push('verify:' + action); return { basicHealthVerified: true, state: 'stopped' } },
    verifyRecovery: async () => { calls.push('verifyRecovery'); throw new Error('本路径不应调用 verifyRecovery') },
    restorePackage: async () => { calls.push('restorePackage') },
    beginRecovery: () => { calls.push('beginRecovery') },
    stoppedAfterError: async () => { calls.push('stoppedAfterError'); return false },
    stopIfAlive: async () => { calls.push('stopIfAlive') },
    stopFailedStart: async () => { calls.push('stopFailedStart') },
  }

  const result = await executeMaintenance({
    action: 'install', adapter, driver,
    source: sourceAccess(appDir, adapter.targets),
    evidenceDir,
    budget: { remaining() {}, elapsed() { return 0 } },
  })

  assert.equal(result.changed, true)
  assert.equal(result.action, 'install')
  assert.equal(result.initialState, 'stopped')
  assert.equal(result.finalState, 'stopped')
  assert.equal(result.verified, true)
  assert.equal(calls.some(name => name.startsWith('manage')), false, '同包重装不得调用 manage：' + calls.join(','))
  assert.equal(calls.includes('verifyRecovery'), false, '不应调用 verifyRecovery：' + calls.join(','))
  assert.equal(calls.includes('restorePackage'), false, '成功路径不得触发恢复：' + calls.join(','))
  assert.equal(calls.includes('assertIdentity'), true, '停前须重核身份：' + calls.join(','))
  assert.ok(calls.filter(name => name === 'assertStopped').length >= 1, 'windowsCli 写前必须重核停止：' + calls.join(','))
  assert.equal(calls.includes('start'), false, '原本停止不得拉起：' + calls.join(','))
  assert.equal(checkStandardSeams({ appDir }).ready, true, '刷新后必须严格 ready')
  assert.equal(existsSync(path.join(appDir, STANDARD_RECORD_REL)), true, '刷新后标准记录应保留')
  } finally {
    // 只清自己 mkdtemp 的 root：父目录必须是 tmpdir 且前缀匹配，绝不触碰用户目录
    const parent = path.dirname(root), base = path.basename(root)
    if (parent === tmpdir() && base.startsWith('tavern-refresh-')) rmSync(root, { recursive: true, force: true })
  }
})
