// --prepare-env 环境预修定向验证（2026-10-05 新增；不改其余源码/manifest/deploy/runtime）。
// 覆盖：ExecStart 纯改写幂等/拒绝、残留血统扫描与隔离（只移不删）、CLI 开关解析与互斥、
// driver.prepareEnvironment 的运行态补旗标全链（假 systemctl/进程，含失败回滚路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rewriteExecStartVmFlag, findLegacyLeftovers, quarantineLeftovers, describeError, leftoverDecision } from '../deploy/maintenance/environment.mjs'
import { options } from '../deploy/maintenance/target.mjs'
import { createDriver } from '../deploy/maintenance/driver.mjs'

test('rewriteExecStartVmFlag：可执行后插入旗标，幂等，形态不明拒绝', () => {
  const unit = ['[Unit]', 'Description=x', '', '[Service]', 'ExecStart=/usr/bin/node /opt/dsh --profile tavern --port 3081', 'Restart=on-failure', ''].join('\n')
  const once = rewriteExecStartVmFlag(unit)
  assert.equal(once.includes('ExecStart=/usr/bin/node --experimental-vm-modules /opt/dsh --profile tavern'), true)
  assert.equal(rewriteExecStartVmFlag(once), once, '已带旗标必须字节幂等')
  assert.equal(once.split('ExecStart=').length - 1, 1, '只动 ExecStart 一行')
  assert.equal(once.includes('Description=x'), true)
  assert.throws(() => rewriteExecStartVmFlag('[Service]\nExecStart=relative-cmd --x\n'), /形态未识别/)
  assert.throws(() => rewriteExecStartVmFlag('[Service]\n'), /恰好一条ExecStart/)
})

test('findLegacyLeftovers/quarantine：只认三类血统残留；隔离只移动不删除', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'prep-env-leftovers-'))
  try {
    const tp = path.join(root, 'tavern-plugin')
    for (const rel of ['lib/index.js', 'lib/client.js.save-ui-seam.backup', 'lib/index.js.legacy-view-seams.backup',
      'lib/index.js.pre-seams-20261004-024849.bak', 'src/client/features/play-controls.js.save-ui-seam.backup',
      'lib/author-own.bak', 'lib/keep.js']) {
      mkdirSync(path.dirname(path.join(tp, rel)), { recursive: true })
      writeFileSync(path.join(tp, rel), 'x', 'utf8')
    }
    const found = findLegacyLeftovers(root)
    assert.deepEqual(found, [
      'tavern-plugin/lib/client.js.save-ui-seam.backup',
      'tavern-plugin/lib/index.js.legacy-view-seams.backup',
      'tavern-plugin/lib/index.js.pre-seams-20261004-024849.bak',
      'tavern-plugin/src/client/features/play-controls.js.save-ui-seam.backup',
    ], '只认三类血统，不误伤作者自有 bak')
    const dest = path.join(root, 'evidence', 'leftovers')
    const moved = quarantineLeftovers(root, dest)
    assert.equal(moved.length, 4)
    assert.equal(existsSync(path.join(dest, 'tavern-plugin_lib_client.js.save-ui-seam.backup')), true, '扁平命名落盘')
    assert.equal(findLegacyLeftovers(root).length, 0, '隔离后复扫为零')
    assert.equal(existsSync(path.join(tp, 'lib/author-own.bak')), true, '非血统文件不动')
    assert.equal(existsSync(path.join(tp, 'lib/keep.js')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('options：--prepare-env 仅 install 可用（互斥在解析期拦截，先于目录解析）', () => {
  // 若 --prepare-env 未被接受为布尔开关，这里会抛「未知参数」而非互斥错误——两种失败可区分。
  assert.throws(() => options(['uninstall', '--home', '/tmp/definitely-not-a-home', '--prepare-env']), /仅用于 install/)
})

test('leftoverDecision：仅非noop的install拦截血统残留；uninstall/noop放行（自管产物由归档收口）', () => {
  assert.equal(leftoverDecision({ action: 'install', noop: false, prepareEnv: false, found: 7 }), 'refuse')
  assert.equal(leftoverDecision({ action: 'install', noop: false, prepareEnv: true, found: 7 }), 'quarantine')
  assert.equal(leftoverDecision({ action: 'uninstall', noop: false, prepareEnv: false, found: 7 }), 'allow', '当前安装自管备份不得阻断卸载（188实测回归）')
  assert.equal(leftoverDecision({ action: 'install', noop: true, prepareEnv: false, found: 7 }), 'allow', '幂等重装不拦自管备份')
  assert.equal(leftoverDecision({ action: 'install', noop: false, prepareEnv: false, found: 0 }), 'allow')
})

test('引导源头bootstrap.mjs：--prepare-env透传；install.sh/template无漂移（一键路径实测回归）', async () => {
  // 真源头是 deploy/bootstrap.mjs（build-release 读它填模板生成发行 install.sh；
  // 0.1.5 曾误改生成物 install.sh 而源头未动，一键路径继续拦截——本用例锁源头+双漂移闸）。
  const mod = await import(new URL('../deploy/bootstrap.mjs', import.meta.url).href)
  const parsed = mod.bootstrapOptions(['install', '--home', '/opt/home', '--systemd-unit', 'dsh-tavern.service', '--prepare-env'])
  assert.deepEqual(parsed.pass, ['--home', '/opt/home', '--systemd-unit', 'dsh-tavern.service', '--prepare-env'], '--prepare-env 必须透传')
  assert.equal(parsed.action, 'install')
  assert.throws(() => mod.bootstrapOptions(['install', '--nonsense']), /未知参数/, '白名单语义保留')
  // 漂移闸①：工作区 deploy/install.sh 内嵌体必须与 bootstrap.mjs 逐字节一致（构建会用源头覆盖包内副本）。
  const source = readFileSync(new URL('../deploy/bootstrap.mjs', import.meta.url), 'utf8')
  const sh = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8')
  const begin = sh.indexOf("<<'DSH_STORAGE_BOOTSTRAP'"), end = sh.indexOf('\nDSH_STORAGE_BOOTSTRAP', begin)
  assert.ok(begin > 0 && end > begin, 'install.sh 内嵌块边界未定位')
  assert.equal(sh.slice(sh.indexOf('\n', begin) + 1, end), source, 'install.sh 内嵌体与 bootstrap.mjs 漂移')
  // 漂移闸②：模板只允许占位符引用源头，不得自带另一份实现。
  const template = readFileSync(new URL('../deploy/install.template.sh', import.meta.url), 'utf8')
  assert.ok(template.includes('__DSH_BOOTSTRAP_SOURCE__'), '模板必须引用 bootstrap.mjs 占位符')
  assert.equal(template.includes('bootstrapOptions'), false, '模板不得内嵌第二份参数解析实现')
})

test('describeError：cause 链并入一条消息（去重、限深）', () => {
  const inner = new Error('内层锚点漂移')
  const mid = new Error('标准接入失败，已恢复本次源码前像', { cause: inner })
  const outer = new Error('维护失败，已恢复原装配及原运行状态', { cause: mid })
  const text = describeError(outer)
  assert.match(text, /维护失败/)
  assert.match(text, /原因：标准接入失败/)
  assert.match(text, /原因：内层锚点漂移/)
})

const ADAPTER = { packageName: 'dsh-tavern-sqlite-v2', requiresVmModules: true }

/** 假 systemctl/进程环境：驱动 prepareEnvironment 的运行态补旗标链。 */
function fakeWorld({ startWithFlag = false, restartFails = false } = {}) {
  const world = { calls: [], pid: 421, running: true }
  const exe = '/usr/bin/node', cli = '/opt/home/runtime/bin/dsh'
  const baseArgv = [exe, cli, '--profile', 'tavern', '--host', '127.0.0.1', '--port', '3081', '--no-open']
  world.unitPath = path.join(world.tmp = mkdtempSync(path.join(os.tmpdir(), 'prep-env-unit-')), 'dsh-tavern.service')
  writeFileSync(world.unitPath, '[Service]\nType=simple\nExecStart=' + exe + ' ' + cli + ' --profile tavern --host 127.0.0.1 --port 3081 --no-open\n', 'utf8')
  world.currentArgv = () => world.running ? (world.flagged ? [exe, '--experimental-vm-modules', ...baseArgv.slice(1)] : baseArgv) : null
  const identity = () => ({ pid: world.pid, argv: world.currentArgv(), env: { PATH: '/usr/bin' }, cwd: '/opt/app', start: '1', cgroup: '0::/system.slice/dsh-tavern.service', host: '127.0.0.1', port: 3081 })
  const show = unitName => {
    if (unitName !== 'dsh-tavern.service') return 'MainPID=0\n'
    const argv = world.currentArgv()
    return ['MainPID=' + (world.running && argv ? world.pid : 0), 'ActiveState=' + (world.running ? 'active' : 'inactive'),
      'ExecStart={ path=' + exe + ' ; argv[]=' + (argv ? argv.join(' ') : baseArgv.join(' ')) + ' ; ignore_errors=no ; start_time=… }',
      'FragmentPath=' + world.unitPath, 'Type=simple', 'KillMode=control-group', 'WorkingDirectory=/opt/app', 'Restart=on-failure'].join('\n')
  }
  const runCommand = (exeName, args) => {
    world.calls.push([exeName, ...args])
    if (exeName !== 'systemctl') throw Error('非预期命令：' + exeName)
    const sub = args[0]
    if (sub === 'show') return show(args[1])
    if (sub === 'stop') { world.running = false; return '' }
    if (sub === 'start') {
      if (restartFails && !world.calls.some(c => c[1] === 'daemon-reload')) { /* daemon-reload 先行 */ }
      world.running = true; world.flagged = readFileSync(world.unitPath, 'utf8').includes('--experimental-vm-modules')
      if (restartFails) throw Error('模拟启动失败')
      return ''
    }
    if (sub === 'daemon-reload') return ''
    throw Error('非预期子命令：' + sub)
  }
  return {
    world,
    runCommand,
    processFinder: () => world.running ? identity() : null,
    processReader: pid => (world.running && pid === world.pid) ? identity() : null,
    portOpen: async () => world.running,
  }
}

function buildDriver(op, deps, evidence) {
  return createDriver(op, ADAPTER, '/nonexistent-package-root', evidence, { remaining: () => 1000, elapsed: () => 0 }, {
    processFinder: deps.processFinder, processReader: deps.processReader, runCommand: deps.runCommand,
    portOpen: deps.portOpen, request: async () => { throw Error('不应触网') }, runPackage: async () => { throw Error('预修阶段不应装包') },
    runtimeResolver: () => ({ cli: '/opt/home/runtime/bin/dsh', cliEntries: [], atomicUrl: 'file:///nonexistent-atomic' }),
  })
}

test('prepareEnvironment：运行缺旗标 → 备份unit→改写→重启复验；证据留备份', async () => {
  const deps = fakeWorld()
  const evidence = mkdtempSync(path.join(os.tmpdir(), 'prep-env-evidence-'))
  try {
    const op = { action: 'install', home: '/opt/home', app: '/opt/app', profile: 'tavern', profileDir: '/opt/home/profiles/tavern', 'systemd-unit': 'dsh-tavern.service', 'prepare-env': true }
    const driver = buildDriver(op, deps, evidence)
    const result = await driver.prepareEnvironment('install')
    assert.equal(result.changed, true)
    assert.equal(result.vmFlag, 'unit-updated')
    assert.equal(readFileSync(deps.world.unitPath, 'utf8').includes('ExecStart=/usr/bin/node --experimental-vm-modules '), true, 'unit 已带旗标')
    assert.equal(existsSync(result.backup), true, '原 unit 备份落证据目录')
    assert.equal(deps.world.flagged, true, '重启后进程 argv 带旗标')
    assert.deepEqual(deps.world.calls.filter(c => c[0] === 'systemctl' && c[1] === 'stop').length, 1)
    assert.deepEqual(deps.world.calls.filter(c => c[0] === 'systemctl' && c[1] === 'start').length, 1)
    // 幂等：已带旗标再跑为 no-op
    const again = await driver.prepareEnvironment('install')
    assert.equal(again.changed, false)
  } finally { rmSync(deps.world.tmp, { recursive: true, force: true }); rmSync(evidence, { recursive: true, force: true }) }
})

test('prepareEnvironment：无开关不做事；非systemd拒绝', async () => {
  const deps = fakeWorld()
  const evidence = mkdtempSync(path.join(os.tmpdir(), 'prep-env-evidence-'))
  try {
    const opNoFlag = { action: 'install', home: '/opt/home', app: '/opt/app', profile: 'tavern', profileDir: '/x' }
    assert.deepEqual(await buildDriver(opNoFlag, deps, evidence).prepareEnvironment('install'), { changed: false }, '无开关 no-op')
    const opNoUnit = { ...opNoFlag, 'prepare-env': true }
    const bareDeps = { ...deps, processFinder: () => ({ ...deps.processFinder(), cgroup: '0::/user.slice/foo' }) }
    await assert.rejects(buildDriver(opNoUnit, bareDeps, evidence).prepareEnvironment('install'), /非systemd管理/)
  } finally { rmSync(deps.world.tmp, { recursive: true, force: true }); rmSync(evidence, { recursive: true, force: true }) }
})

test('prepareEnvironment：改写后启动失败 → 回滚原unit并重启原形态', async () => {
  const deps = fakeWorld({ restartFails: true })
  const evidence = mkdtempSync(path.join(os.tmpdir(), 'prep-env-evidence-'))
  try {
    const op = { action: 'install', home: '/opt/home', app: '/opt/app', profile: 'tavern', profileDir: '/x', 'systemd-unit': 'dsh-tavern.service', 'prepare-env': true }
    await assert.rejects(buildDriver(op, deps, evidence).prepareEnvironment('install'), /已回滚|回滚/)
    assert.equal(readFileSync(deps.world.unitPath, 'utf8').includes('--experimental-vm-modules'), false, 'unit 内容回到原样')
    assert.equal(deps.world.running, true, '服务已按原形态重启')
    assert.equal(deps.world.flagged, false, '回滚后进程无旗标')
  } finally { rmSync(deps.world.tmp, { recursive: true, force: true }); rmSync(evidence, { recursive: true, force: true }) }
})

console.log('prepare-env: ExecStart改写/残留隔离/开关解析/驱动补旗标含回滚 定向通过')
