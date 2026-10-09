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

// 安装阶段用户可见的结果必须落在插件包目录（install.ps1 旁边），不能只留酒馆维护目录：
// 用户报错时应当只需发手边的 install.log 与 result.json，不必去翻深层路径。
test('安装阶段result.json按report-dir落到插件包目录，证据目录不再出现在提示里', t => {
  const root = temp(t), pkgDir = path.join(root, 'pkg'), evidence = path.join(root, 'tavern', 'maintenance', 'dsh-tavern-sqlite-v2', 'run-1')
  spawnSync('cmd', ['/c', 'mkdir', pkgDir], { windowsHide: true })
  spawnSync('cmd', ['/c', 'mkdir', evidence], { windowsHide: true })
  const lines = [], error = new Error('合成安装失败')
  reportMaintenanceFailure(error, evidence, 12, line => lines.push(line), pkgDir)
  assert.equal(existsSync(path.join(pkgDir, 'result.json')), true, '结果必须落在插件包目录')
  assert.equal(existsSync(path.join(evidence, 'result.json')), false, '安装阶段不再往维护目录写用户结果')
  assert.deepEqual(lines, ['维护失败：合成安装失败', '失败结果：' + path.join(pkgDir, 'result.json')])
})

test('PS1把report-dir指向install.ps1同目录，维护入口接受该参数', () => {
  assert.match(installer, /\$argv \+= @\('--report-dir', \$script:installLogDir\)/)
  assert.match(installer, /\$script:installLogDir = \$root/)
  const target = readFileSync(new URL('../deploy/maintenance/target.mjs', import.meta.url), 'utf8')
  assert.match(target, /'--report-dir'\]/, '维护入口参数白名单必须接受--report-dir，否则安装直接被拒')
  const runner = readFileSync(new URL('../deploy/maintenance/runner.mjs', import.meta.url), 'utf8')
  assert.match(runner, /reportMaintenanceFailure\(error, evidence, Math\.round\(budget\.elapsed\(\)\), console\.log, reportDir\)/)
  assert.match(runner, /writeFileSync\(reportFile\(\)/)
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
  // 日志必须在任何校验之前就打开：否则早期失败（没找到酒馆/Node、参数不合法）连日志都没有。
  const openAt = installer.indexOf('$script:installLogWriter = New-LogWriter $script:installLogPath')
  assert.ok(openAt > 0 && openAt < installer.indexOf("$packageJson = Join-Path $root 'package.json'"), '日志必须在包校验前打开')
  const wait = installer.slice(installer.indexOf('function Wait-Exit'), installer.indexOf('function Fail('))
  assert.ok(!wait.includes("$Host.Name -eq 'ConsoleHost'"), '等待条件不得依赖 ConsoleHost，否则宿主不同就闪退')
  assert.match(wait, /Read-Host/)
  // 双击安全入口：外层 .cmd 必须绕过执行策略、把输出落盘并总是暂停（解析错误/策略拦截也要留证据）。
  const launcher = readFileSync(new URL('../deploy/run-install.cmd', import.meta.url), 'utf8')
  assert.match(launcher, /-ExecutionPolicy Bypass/)
  const calls = launcher.split(/\r?\n/).filter(line => /^\s*"%PS%"\s+-NoLogo\b/.test(line))
  assert.equal(calls.length, 1, '不论日志位置如何，启动器只执行一次')
  assert.match(calls[0], /%\* 2> "%ERR%"$/)
  assert.ok(!calls[0].replace('2> "%ERR%"', '').includes('>'), 'stdout菜单不能重定向')
  assert.match(launcher, /^\s*pause\s*$/m)
  // 正跑那一次绝不能重定向：菜单/进度必须留在窗口里，日志由 install.ps1 自己写。
  // 0.2.9 实测缺陷：`-File ... %* >> "%LOG%" 2>&1` 把整个菜单吞进日志，用户只看到“输入序号”。
  const liveRun = launcher.split(/\r?\n/).filter(line => /^\s*"%PS%"\s+-NoLogo\b/.test(line))
  assert.equal(liveRun.length, 1, '必须恰好有一条不重定向的实时运行行：' + JSON.stringify(liveRun))
  assert.match(launcher, /DSH_TAVERN_LAUNCHER=1/)
  assert.match(installer, /\$env:DSH_TAVERN_LAUNCHER -eq '1'/, 'PS1 必须认可外层负责最后暂停')
  assert.match(readFileSync(new URL('../scripts/build-release.mjs', import.meta.url), 'utf8'), /run-install\.cmd/, '发行包必须带上该入口')
  const runner = readFileSync(new URL('../deploy/maintenance/runner.mjs', import.meta.url), 'utf8')
  assert.match(runner, /reportMaintenanceFailure\(error, evidence, Math\.round\(budget\.elapsed\(\)\), console\.log, reportDir\)/)
  assert.match(runner, /if \(!error\.maintenanceReported\) console\.log/)
})

if (process.platform === 'win32') {
  // 只抽取两个真实函数：New-LogWriter（建UTF8日志句柄）＋Invoke-Maintenance（跑维护）。
  // 不整段加载脚本：避免执行包校验、找酒馆、菜单等顶层代码。
  const helper = installer.slice(installer.indexOf('function New-LogWriter('), installer.indexOf('$script:installLogPath ='))
    + installer.slice(installer.indexOf('function Invoke-Maintenance('), installer.indexOf('# ——— 4.'))
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
  // 早期校验失败（没找到酒馆/没找到Node/参数不合法）发生在维护子进程之前：
  // 旧实现的日志是懒创建的，这类失败只打印在窗口里、不落盘，用户什么都发不出来。
  test('PS1早期失败也必生成install.log（不再只在窗口一闪）', t => {
    const root = temp(t), ps5 = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    assert.ok(existsSync(ps5), 'Windows PowerShell 5必须在场，不SKIP')
    const dir = path.join(root, 'pkg'), deployDir = path.join(dir, 'deploy')
    spawnSync('cmd', ['/c', 'mkdir', deployDir], { windowsHide: true })
    // 只造出「校验能过、但酒馆目录无效」的最小包：真实发行包同款带BOM脚本。
    writeFileSync(path.join(dir, 'install.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(new URL('../deploy/install.ps1', import.meta.url))]))
    writeFileSync(path.join(dir, 'package.json'), readFileSync(new URL('../package.json', import.meta.url)))
    writeFileSync(path.join(deployDir, 'maintenance.mjs'), '// 占位：仅用于通过入口存在性校验\n')
    const logFile = path.join(dir, 'install.log')
    const result = spawnSync(ps5, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(dir, 'install.ps1'), 'install', '-TavernHome', path.join(root, 'no-such-tavern'), '-Yes'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.ok(existsSync(logFile), '失败必须留下日志文件')
    const log = readFileSync(logFile, 'utf8')
    assert.match(log, /不是有效的酒馆安装/)
    assert.match(log, /安装器 —— 日志：/, '日志开头就要写明位置')
  })
  // 有一类失败在 PowerShell 脚本开始执行之前就发生（无BOM乱码、执行策略拦截），
  // 脚本自己的 trap 根本跑不到；只有外层 .cmd 能留下证据并阻止窗口闪退。
  test('cmd入口把PowerShell解析错误也写进install.log，窗口不闪退', t => {
    const root = temp(t), dir = path.join(root, 'no-bom')
    spawnSync('cmd', ['/c', 'mkdir', dir], { windowsHide: true })
    // 故意放无BOM副本：PS5按GBK解码中文必然解析失败，正是用户看到的"一闪就没"。
    writeFileSync(path.join(dir, 'install.ps1'), readFileSync(new URL('../deploy/install.ps1', import.meta.url)))
    writeFileSync(path.join(dir, 'run-install.cmd'), readFileSync(new URL('../deploy/run-install.cmd', import.meta.url)))
    const logFile = path.join(dir, 'install.log')
    const result = spawnSync('cmd', ['/c', 'run-install.cmd', 'install', '-TavernHome', path.join(root, 'no-such-tavern'), '-Yes', '<', 'nul'], { cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.ifError(result.error)
    assert.notEqual(result.status, 0, '解析失败必须是非零退出')
    assert.ok(existsSync(logFile), '.cmd 必须留下日志')
    const log = readFileSync(logFile, 'utf8')
    assert.ok(log.length > 100, '日志必须包含真实错误文本')
    assert.match(log, /install\.ps1/, '日志要指向出问题的脚本')
  })
  // 0.2.9 实测缺陷：`-File ... %* >> "%LOG%" 2>&1` 把菜单和进度全吞进日志，
  // 用户窗口里只剩 Read-Host 的“输入序号后回车”，根本看不到要选什么。
  test('cmd入口同目录无日志仍只执行一次', t => {
    const root = temp(t), counter = path.join(root, 'count.txt')
    writeFileSync(path.join(root, 'run-install.cmd'), readFileSync(new URL('../deploy/run-install.cmd', import.meta.url)))
    writeFileSync(path.join(root, 'install.ps1'), [
      "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "[System.IO.File]::AppendAllText((Join-Path $PSScriptRoot 'count.txt'), 'RUN' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))",
      "[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'temp-fake.log'), 'TEMP-LOG', [System.Text.UTF8Encoding]::new($false))",
      "Write-Host 'MENU-NOLOG: 1) install 0) exit'", 'exit 7',
    ].join('\n'), 'utf8')
    const result = spawnSync('cmd', ['/c', 'run-install.cmd', '<', 'nul'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true })
    assert.ifError(result.error); assert.equal(result.status, 7, result.stdout + result.stderr)
    assert.match(result.stdout, /MENU-NOLOG/)
    assert.equal(readFileSync(counter, 'utf8').trim(), 'RUN')
    assert.equal(existsSync(path.join(root, 'install.log')), false)
    assert.equal(readFileSync(path.join(root, 'temp-fake.log'), 'utf8'), 'TEMP-LOG')
  })
  test('cmd入口把菜单实时显示在窗口里，且只跑一次', t => {
    const root = temp(t), dir = path.join(root, 'live')
    spawnSync('cmd', ['/c', 'mkdir', dir], { windowsHide: true })
    // 假安装器：像真 install.ps1 一样自己写日志并打印菜单（全 ASCII，免编码干扰）。
    writeFileSync(path.join(dir, 'install.ps1'), [
      "param([string]$Action = '', [switch]$Yes)",
      "$log = Join-Path $PSScriptRoot 'install.log'",
      "[System.IO.File]::AppendAllText($log, 'RUN-MARKER' + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))",
      "Write-Host 'MENU-LIVE: 1) install  2) update  0) exit'",
      "if ($env:DSH_TAVERN_LAUNCHER -ne '1') { throw 'launcher env missing' }",
      'exit 0',
    ].join('\n') + '\n', 'utf8')
    writeFileSync(path.join(dir, 'run-install.cmd'), readFileSync(new URL('../deploy/run-install.cmd', import.meta.url)))
    const result = spawnSync('cmd', ['/c', 'run-install.cmd', '<', 'nul'], { cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true })
    assert.ifError(result.error)
    const out = result.stdout + result.stderr
    assert.match(out, /MENU-LIVE: 1\) install/, '双击入口必须把菜单显示在窗口里，不能只进日志')
    const log = readFileSync(path.join(dir, 'install.log'), 'utf8')
    assert.equal((log.match(/RUN-MARKER/g) || []).length, 1, '脚本自己写过日志时不得再兜底重跑（否则可能把真安装跑两遍）')
  })
}

// 静态合同：Windows 更新只走**一次** install（驱动单命令内清旧装配），不再代卸旧机制。
// 证据边界：只对真实 install.ps1 源文本做静态断言（可选 PS 解析器语法检查），不执行脚本、不联网、不启进程；
// 因此**不能**据此宣称真实 Windows 升级行为已验证。
test('现场更新1 Windows更新统一install而不代卸旧机制', () => {
  const body = installer.slice(installer.indexOf('function Do-Update'), installer.indexOf('# ——— 6. 菜单 / 直用 ———'))
  assert.ok(body.length > 0, '必须定位到 Do-Update：' + body.length)
  assert.equal((body.match(/Invoke-Maintenance[^\n]*\$remote[^\n]*'install'/g) || []).length, 1, '远程更新必须恰好一次 install')
  assert.equal((body.match(/Invoke-Maintenance[^\n]*\$localEntry[^\n]*'install'/g) || []).length, 1, '本包覆盖必须恰好一次 install')
  assert.equal((body.match(/Invoke-Maintenance[^\n]*'uninstall'/g) || []).length, 0, 'Do-Update 内不得代卸旧代（旧机制由旧 CLI 先卸）')
  assert.ok(!/Do-Install\s+\$tavern/.test(body), '不得再走"先卸再 Do-Install"两段式')
  // 动作映射：两处 $verb 只保留 uninstall 分支（install/update/check 一律 install）
  const maps = installer.match(/\$verb = if \(\$Action -eq 'uninstall'\) \{ 'uninstall' \} else \{ 'install' \}/g) || []
  assert.equal(maps.length, 2, '两处资格映射都必须只留 uninstall 分支，实际 ' + maps.length)
  const old = installer.match(/\$verb = if \(\$Action -eq 'install' -or \$Action -eq 'check'\)/g) || []
  assert.equal(old.length, 0, '旧 install/check 映射必须已移除')
  // 说明：可选 PowerShell 解析器语法检查**不在此处执行**——扁平字符串传参易假失败（空 stderr/引号与 [ref] 语义），
  // 且它是可选增强；本用例只做上面这些真实源文本的静态合同断言（不执行脚本、不联网、不启进程）。
})
