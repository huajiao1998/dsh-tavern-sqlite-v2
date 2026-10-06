// 安装失败可见性：自有temp证据 + 假Node维护程序，不执行真实安装/停启/网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { reportMaintenanceFailure } from '../deploy/maintenance/runner.mjs'

const installer = readFileSync(new URL('../deploy/install.ps1', import.meta.url), 'utf8')
function temp(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v2-installer-output-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-installer-output-')); rmSync(root, { recursive: true, force: true }) })
  return root
}

test('维护失败stdout包含完整脱敏初因和结果路径，JSON与前台一致', t => {
  const root = temp(t), lines = []
  const cause = new Error('合成初因 ?token=fixture-token-value Bearer fixture-bearer-value')
  const error = new Error('现装不同代（合成测试）', { cause })
  reportMaintenanceFailure(error, root, 7, line => lines.push(line))
  const file = path.join(root, 'result.json'), bytes = readFileSync(file)
  const result = JSON.parse(bytes.toString('utf8'))
  assert.equal(result.ok, false)
  assert.equal(result.elapsedMs, 7)
  assert.match(result.message, /现装不同代.*原因：合成初因/)
  assert.deepEqual(lines, ['维护失败：' + result.message, '失败结果：' + file])
  assert.equal(error.maintenanceReported, true)
  assert.equal(bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), false)
  assert.equal(bytes.includes(13), false, '结果必须LF')
  assert.ok(![...lines, result.message].join('\n').includes('fixture-token-value'))
  assert.ok(![...lines, result.message].join('\n').includes('fixture-bearer-value'))
})

test('PS1双流日志与CLI失败报告连到真实调用位置，不依赖用户自行找stderr', () => {
  assert.match(installer, /& \$node\.exe @argv 2>&1/)
  assert.match(installer, /UTF8Encoding\]::new\(\$false\)/)
  assert.match(installer, /\$writer\.WriteLine\(\$line\)/)
  assert.match(installer, /\$ErrorActionPreference = \$savedErrorAction/)
  assert.match(installer, /Join-Path \$root 'install\.log'/) // 安装器日志正式默认落脚本同目录固定文件
  assert.ok(!installer.includes("maintenance\\dsh-tavern-sqlite-v2"), '用户日志不得再进酒馆深层维护目录')
  assert.match(installer, /trap \{/) // 未捕获异常必须写日志并停住等用户，不许闪退
  assert.match(installer, /\$script:installLogWriter\.WriteLine\(\$text\)/) // 更新/下载分支输出同步进安装日志
  const runner = readFileSync(new URL('../deploy/maintenance/runner.mjs', import.meta.url), 'utf8')
  assert.match(runner, /reportMaintenanceFailure\(error, evidence, Math\.round\(budget\.elapsed\(\)\)\)/)
  assert.match(runner, /if \(!error\.maintenanceReported\) console\.log/)
})

if (process.platform === 'win32') {
  const helper = installer.slice(installer.indexOf('function Invoke-Maintenance('), installer.indexOf('# ——— 4.'))
  assert.ok(helper.includes('return $code'), '只抽取维护调用函数，不执行菜单或联网')
  test('PS1未捕获异常写日志并停住等用户，不闪退', t => {
    for (const shell of ['pwsh', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) {
      if (shell !== 'pwsh') assert.ok(existsSync(shell), 'Windows PowerShell 5必须在场，不SKIP')
      const root = temp(t), target = path.join(root, 'trap-target.ps1'), logFile = path.join(root, 'install.log')
      // 必须写成真实脚本文件执行：trap 只在自己所在的脚本作用域生效，
      // 用 Invoke-Expression 加载时捕不到外层 throw（实测用例因此漏报）。
      const head = installer.slice(0, installer.indexOf('if ($Help)'))
      // 带BOM写盘：PS5.1 对无 BOM 脚本按 ANSI 解码，中文断言会因乱码失败。
      writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(head + "throw '合成更新下载失败'\n", 'utf8')]))
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', target], {
        encoding: 'utf8', timeout: 15000, windowsHide: true, input: '\n',
      })
      assert.ifError(result.error)
      assert.equal(result.status, 1, result.stdout + result.stderr)
      const out = result.stdout + result.stderr
      assert.match(out, /安装器异常退出：合成更新下载失败/)
      assert.ok(out.includes(logFile), '必须告诉用户日志在哪')
      const log = readFileSync(logFile, 'utf8')
      assert.match(log, /安装器异常退出：合成更新下载失败/)
    }
  })
  const shells = ['pwsh', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
  for (const shell of shells) for (const exitCode of [0, 7]) {
    test(path.basename(shell) + '：PS1真执行双流UTF8日志、脱敏、退出码' + exitCode + '与环境恢复', t => {
      if (shell !== 'pwsh') assert.ok(existsSync(shell), 'Windows PowerShell 5必须在场，不SKIP')
      const root = temp(t), entry = path.join(root, 'fake-maintenance.mjs'), script = path.join(root, 'invoke.ps1'), logFile = path.join(root, 'install.log')
      writeFileSync(entry, "console.log('标准输出：中文');console.error('原始错误：中文 ?token=fixture-token-value Bearer fixture-bearer-value');process.exitCode=Number(process.env.FIXTURE_EXIT);\n", 'utf8')
      // ASCII载入脚本，从UTF8 base64解码可信函数；PS5不按GBK误读中文，不需要BOM。
      const encoded = Buffer.from("function Say([string]$text){Write-Host $text}\nfunction Warn([string]$text){Write-Host $text}\n" + helper, 'utf8').toString('base64')
      const inputs = Buffer.from(JSON.stringify({ home: root, exe: process.execPath, entry, log: logFile }), 'utf8').toString('base64')
      const ps = [
        "$ErrorActionPreference='Stop'",
        '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
        "Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')))",
        "$a=([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + inputs + "')) | ConvertFrom-Json)",
        "$env:ELECTRON_RUN_AS_NODE='fixture-original'",
        '$code=Invoke-Maintenance @{home=$a.home} @{exe=$a.exe;runAsNode=$true} $a.entry install -LogFile $a.log',
        "if($ErrorActionPreference -ne 'Stop'){throw 'preference not restored'}",
        "if($env:ELECTRON_RUN_AS_NODE -ne 'fixture-original'){throw 'environment not restored'}",
        "Write-Host ('RESULT_CODE='+$code)",
        'exit $code',
      ].join('\n') + '\n'
      writeFileSync(script, ps, 'utf8')
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, FIXTURE_EXIT: String(exitCode) },
      })
      assert.ifError(result.error)
      assert.equal(result.status, exitCode, result.stdout + result.stderr)
      const out = result.stdout + result.stderr
      assert.match(out, /标准输出：中文/)
      assert.match(out, /原始错误：中文/)
      assert.match(out, new RegExp('RESULT_CODE=' + exitCode))
      assert.ok(!out.includes('fixture-token-value'))
      assert.ok(!out.includes('fixture-bearer-value'))
      assert.ok(out.includes(logFile), '控制台必须显示日志完整位置')
      const bytes = readFileSync(logFile), log = bytes.toString('utf8')
      assert.match(log, /标准输出：中文/)
      assert.match(log, /原始错误：中文/)
      assert.equal(bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), false)
      assert.equal(bytes.includes(13), false)
      assert.ok(!log.includes('fixture-token-value'))
      assert.ok(!log.includes('fixture-bearer-value'))
    })
  }
}
