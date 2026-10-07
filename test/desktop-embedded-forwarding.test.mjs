// 嵌入参数（--desktop-app）贯通：PS1 -DesktopApp → bootstrapOptions → maintenanceChildArgs → 维护子进程argv。
// 只做纯函数断言、源码抽取与假Node合成argv：不启动真实维护/桌面、不联网、不读任何真实安装路径。
// 桌面宿主根目录是独立runtime，与作者源码 --app 语义分开，因此必须逐层原样传递（含空格的单argv）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { bootstrapOptions } from '../deploy/bootstrap.mjs'
import { maintenanceChildArgs } from '../deploy/maintenance/runner.mjs'

const PREFIX = '嵌入参数：'
const installer = readFileSync(new URL('../deploy/install.ps1', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../deploy/maintenance/runner.mjs', import.meta.url), 'utf8')
// 全部用合成路径（含空格与括号）：正是独立宿主安装根目录的真实形态，用来验证单argv不被拆。
const DESKTOP = 'D:\\Program Files (x86)\\DSH Desktop'
const HOME = 'C:\\Program Files (x86)\\DSH-Tavern\\data\\harness'
const APP = 'C:\\Program Files (x86)\\DSH-Tavern\\data\\harness\\apps\\dsh-tavern'
const ENTRY = 'C:\\tavern\\maintenance\\run-1\\executor-package\\deploy\\maintenance.mjs'
const EVIDENCE = 'C:\\Program Files (x86)\\DSH-Tavern\\data\\harness\\maintenance\\dsh-tavern-sqlite-v2\\run-1'
const REPORT = 'C:\\Users\\fixture\\Downloads\\pkg dir'

function temp(t) {
  const prefix = 'v2-embedded-args-', root = mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => { assert.ok(path.basename(root).startsWith(prefix)); rmSync(root, { recursive: true, force: true }) })
  return root
}

test(PREFIX + 'bootstrapOptions透传--desktop-app，install/uninstall与--check都不丢且缺值拒绝', () => {
  for (const action of ['install', 'uninstall']) {
    const op = bootstrapOptions([action, '--desktop-app', DESKTOP, '--home', HOME, '--app', APP, '--profile', 'tavern', '--port', '3091', '--systemd-unit', 'dsh-tavern.service', '--evidence', EVIDENCE, '--check', '--prepare-env'])
    assert.equal(op.action, action)
    assert.equal(op.local, undefined)
    assert.deepEqual(op.pass, ['--desktop-app', DESKTOP, '--home', HOME, '--app', APP, '--profile', 'tavern', '--port', '3091', '--systemd-unit', 'dsh-tavern.service', '--evidence', EVIDENCE, '--check', '--prepare-env'], action + ' 必须整表透传（含--check），--desktop-app 不得被拆或丢')
  }
  // 默认动作开关 --apply 与桌面参数同现时两者都留在 pass 里
  assert.deepEqual(bootstrapOptions(['uninstall', '--apply', '--desktop-app', DESKTOP]).pass, ['--apply', '--desktop-app', DESKTOP])
  // 含空格值必须是单个 pass 元素，不能被拆成多个
  const single = bootstrapOptions(['install', '--desktop-app', DESKTOP]).pass
  assert.deepEqual(single, ['--desktop-app', DESKTOP])
  assert.equal(single.filter(value => value === DESKTOP).length, 1, '含空格路径必须保持单个元素')
  // 缺值拒：末尾缺值、下一项是另一个参数
  assert.throws(() => bootstrapOptions(['install', '--desktop-app']), /参数缺值/)
  assert.throws(() => bootstrapOptions(['uninstall', '--desktop-app', '--home', HOME]), /参数缺值/)
})

test(PREFIX + 'maintenanceChildArgs两动作完整argv：既有--home/--app/--check/--apply/--report-dir一个不丢', () => {
  const op = { home: HOME, app: APP, profile: 'tavern', port: '3091', 'systemd-unit': 'dsh-tavern.service', 'prepare-env': true, 'report-dir': REPORT }
  for (const action of ['install', 'uninstall']) for (const check of [true, false]) {
    assert.deepEqual(maintenanceChildArgs(ENTRY, { ...op, action, check }, EVIDENCE, REPORT, 12), [
      ENTRY, action, '--home', HOME, '--app', APP, '--profile', 'tavern', check ? '--check' : '--apply',
      '--internal', '--evidence', EVIDENCE, '--elapsed', '12',
      '--port', '3091', '--systemd-unit', 'dsh-tavern.service', '--prepare-env', '--report-dir', REPORT,
    ], action + '（' + (check ? '--check' : '--apply') + '）必须与既有argv表逐元素一致')
  }
  // 没有桌面参数时不得凭空出现 --desktop-app，也不得有空值占位
  const plain = maintenanceChildArgs(ENTRY, { home: HOME, app: APP, profile: 'tavern', action: 'install', check: true }, EVIDENCE, EVIDENCE, 0)
  assert.equal(plain.includes('--desktop-app'), false)
  assert.ok(plain.every(value => typeof value === 'string' && value.length > 0), 'argv不得出现空元素')
  assert.deepEqual(plain, [ENTRY, 'install', '--home', HOME, '--app', APP, '--profile', 'tavern', '--check', '--internal', '--evidence', EVIDENCE, '--elapsed', '0'])
})

test(PREFIX + 'maintenanceChildArgs新增--desktop-app：含空格单argv、与作者源码--app分开、不转发空值', () => {
  const base = { home: HOME, app: APP, profile: 'tavern', action: 'install', check: true, 'report-dir': REPORT }
  const withDesktop = maintenanceChildArgs(ENTRY, { ...base, 'desktop-app': DESKTOP }, EVIDENCE, REPORT, 12)
  assert.deepEqual(withDesktop, [
    ENTRY, 'install', '--home', HOME, '--app', APP, '--profile', 'tavern', '--check', '--internal', '--evidence', EVIDENCE, '--elapsed', '12',
    '--desktop-app', DESKTOP, '--report-dir', REPORT,
  ], '新增参数只能插在既有argv表里，其余元素与顺序不变')
  const at = withDesktop.indexOf('--desktop-app')
  assert.equal(withDesktop.filter(value => value === DESKTOP).length, 1, '含空格路径必须是单个argv元素')
  assert.ok(!withDesktop.some(value => value === 'D:\\Program' || value === 'Files' || value === '(x86)\\DSH'), '含空格路径不得被拆开')
  // 独立runtime根目录 vs 作者源码 --app：两个参数各归各，不互相顶替
  assert.equal(withDesktop[withDesktop.indexOf('--app') + 1], APP)
  assert.notEqual(withDesktop[at + 1], withDesktop[withDesktop.indexOf('--app') + 1])
  // 缺省或空值一律不转发（不产生悬空 --desktop-app）
  for (const value of [undefined, '']) {
    const args = maintenanceChildArgs(ENTRY, { ...base, 'desktop-app': value }, EVIDENCE, REPORT, 12)
    assert.equal(args.includes('--desktop-app'), false)
    assert.ok(args.every(item => typeof item === 'string' && item.length > 0), '不得转发空argv')
  }
})

test(PREFIX + '前台与后台共用maintenanceChildArgs：runner无内联argv残留', () => {
  assert.equal(typeof maintenanceChildArgs, 'function')
  assert.match(runner, /export function maintenanceChildArgs\(entry, op, evidence, reportDir, elapsed\)/)
  assert.match(runner, /const args = maintenanceChildArgs\(/, '两个spawn都必须用helper的返回值')
  assert.equal((runner.match(/'--internal'/g) || []).length, 1, 'argv只能由helper拼装一次，不得另留内联表')
  assert.equal((runner.match(/'--desktop-app'/g) || []).length, 1, '--desktop-app只能在helper里转发一次')
  assert.equal((runner.match(/spawn\(process\.execPath, args,/g) || []).length, 2, '前台等待与后台detached必须共用同一个args')
})

test(PREFIX + 'PS1声明[string]$DesktopApp并只在Invoke-Maintenance里追加，所有动作共用', () => {
  const paramBlock = installer.slice(installer.indexOf('param('), installer.indexOf("$ErrorActionPreference = 'Stop'"))
  assert.match(paramBlock, /\[string\]\$DesktopApp,/, '缺[string]$DesktopApp就无法从命令行接收独立宿主根目录')
  const invoke = installer.slice(installer.indexOf('function Invoke-Maintenance('), installer.indexOf('# ——— 4.'))
  assert.match(invoke, /\$argv = @\(\$entry, \$verb, '--home', \$tavern\.home\)/)
  assert.match(invoke, /if \(\$DesktopApp\) \{ \$argv \+= @\('--desktop-app', \$DesktopApp\) \}/, '只在非空时追加，避免悬空参数')
  assert.match(invoke, /if \(\$Check\) \{ \$argv \+= '--check' \}/)
  assert.match(invoke, /\$argv \+= @\('--report-dir', \$script:installLogDir\)/)
  // argv 拼装只允许这一处：install/uninstall/check/update 都经同一函数，不各自拼
  const argvLines = installer.split('\n').map(line => line.trim()).filter(line => /\$argv\s*\+?=/.test(line))
  assert.ok(argvLines.length >= 3, '必须存在argv拼装行：' + argvLines.length)
  for (const line of argvLines) assert.ok(invoke.includes(line), 'argv拼装只能出现在Invoke-Maintenance：' + line)
  // 桌面宿主根目录不得占用作者源码 --app 语义
  assert.ok(!/\$argv[^\n]*'--app'/.test(installer), '独立runtime不能用作者源码--app转发')
  const calls = installer.match(/Invoke-Maintenance \$tavern \$node/g) || []
  assert.ok(calls.length >= 4, '安装/卸载/预检/更新必须共用Invoke-Maintenance：' + calls.length)
})

if (process.platform === 'win32') {
  // 只抽取两个真实函数：New-LogWriter（建UTF8日志句柄）＋Invoke-Maintenance（跑维护）。
  // 不整段加载脚本：不执行包校验、找酒馆、菜单、联网、桌面识别等顶层代码。
  const helper = installer.slice(installer.indexOf('function New-LogWriter('), installer.indexOf('$script:installLogPath ='))
    + installer.slice(installer.indexOf('function Invoke-Maintenance('), installer.indexOf('# ——— 4.'))
  assert.ok(helper.includes('return $code'), '只抽取维护调用函数，不执行菜单或联网')
  const shells = [['pwsh', 'pwsh'], ['Windows PowerShell 5', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]]
  for (const [label, shell] of shells) {
    test(PREFIX + label + '真执行Invoke-Maintenance：DesktopApp完整传递install/uninstall/check', t => {
      if (shell !== 'pwsh') assert.ok(existsSync(shell), 'Windows PowerShell 5必须在场，不SKIP')
      const root = temp(t), entry = path.join(root, 'fake-maintenance.mjs')
      // 假Node：只把收到的合成argv落盘，不跑任何维护逻辑、不碰真实安装。
      writeFileSync(entry, "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.env.FIXTURE_ARGV_FILE, JSON.stringify(process.argv.slice(1)), 'utf8')\nconsole.log('FAKE-MAINTENANCE-OK')\nprocess.exitCode = Number(process.env.FIXTURE_EXIT || 0)\n", 'utf8')
      const home = path.join(root, 'harness dir'), desktop = path.join(root, 'DSH Desktop 独立根'), reportDir = path.join(root, 'pkg dir'), exitCode = 7
      // ASCII载入脚本，从UTF8 base64解码可信函数；PS5不按GBK误读中文，不需要BOM。
      const encoded = Buffer.from('function Say([string]$text){Write-Host $text}\nfunction Warn([string]$text){Write-Host $text}\n' + helper, 'utf8').toString('base64')
      const inputs = Buffer.from(JSON.stringify({ root, exe: process.execPath, entry, home, desktop, reportDir, exitCode }), 'utf8').toString('base64')
      const script = path.join(root, 'invoke.ps1')
      writeFileSync(script, [
        "$ErrorActionPreference='Stop'",
        '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
        "Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')))",
        "$a=([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + inputs + "')) | ConvertFrom-Json)",
        // 真实脚本里 $DesktopApp 是 param，函数按动态作用域读取；这里同样用脚本作用域赋值。
        '$DesktopApp = $a.desktop',
        '$script:installLogDir = $a.reportDir',
        "$env:ELECTRON_RUN_AS_NODE='fixture-original'",
        '$env:FIXTURE_EXIT = [string]$a.exitCode',
        '$tavern = @{ home = $a.home }',
        '$node = @{ exe = $a.exe; runAsNode = $true }',
        '$codes = @()',
        "foreach ($case in @(@{verb='install';check=$false},@{verb='uninstall';check=$false},@{verb='install';check=$true})) {",
        "  $tag = $case.verb + $(if ($case.check) { '-check' } else { '' })",
        "  $env:FIXTURE_ARGV_FILE = Join-Path $a.root ($tag + '.json')",
        "  $log = Join-Path $a.root ($tag + '.log')",
        "  if ($case.check) { $code = Invoke-Maintenance $tavern $node $a.entry $case.verb -Check -LogFile $log }",
        "  else { $code = Invoke-Maintenance $tavern $node $a.entry $case.verb -LogFile $log }",
        '  $codes += $code',
        "  Write-Host ('CASE=' + $tag + ' CODE=' + $code)",
        '}',
        "if ($ErrorActionPreference -ne 'Stop') { throw 'preference not restored' }",
        "if ($env:ELECTRON_RUN_AS_NODE -ne 'fixture-original') { throw 'environment not restored' }",
        "Write-Host ('RESULT_CODES=' + ($codes -join ','))",
        'exit [int]$codes[0]',
      ].join('\n') + '\n', 'utf8')
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', timeout: 30000, windowsHide: true })
      assert.ifError(result.error)
      assert.equal(result.status, exitCode, result.stdout + result.stderr)
      const out = result.stdout + result.stderr
      assert.match(out, /RESULT_CODES=7,7,7/, '每次调用的退出码都必须原样返回：' + out)
      const expected = {
        install: [entry, 'install', '--home', home, '--desktop-app', desktop, '--report-dir', reportDir],
        uninstall: [entry, 'uninstall', '--home', home, '--desktop-app', desktop, '--report-dir', reportDir],
        'install-check': [entry, 'install', '--home', home, '--desktop-app', desktop, '--check', '--report-dir', reportDir],
      }
      for (const [tag, argv] of Object.entries(expected)) {
        const file = path.join(root, tag + '.json')
        assert.ok(existsSync(file), tag + ' 未落盘合成argv：' + out)
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), argv, tag + ' 必须完整传递DesktopApp（含空格的单argv）')
        assert.match(readFileSync(path.join(root, tag + '.log'), 'utf8'), /FAKE-MAINTENANCE-OK/, tag + ' 日志句柄链路必须仍落盘')
      }
    })
  }
}
