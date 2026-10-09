# dsh-tavern-sqlite-v2 —— Windows 一键装卸（桌面版 / CLI 版）
#
# 直接双击/右键运行时进入**菜单模式**（全部进度都在同一个窗口里）：
#   1) 安装插件        用本包（离线）
#   2) 更新插件        先联网查官方最新版本：有新版就下载官方包安装；已是最新就用本包覆盖安装
#   3) 卸载插件
#   4) 只读预检        不改酒馆源码/装配，仅写维护证据，可以开着酒馆跑
#   0) 退出
#
# 也支持命令行直用（自动化/排错）：
#   .\install.ps1 install|update|uninstall|check [-TavernHome <目录>] [-DesktopApp <宿主安装目录>] [-Yes]
#
# Windows CLI（本地未公开适配，说明见 deploy/INSTALL.md）：home 是 %USERPROFILE%\.dsh-tavern 或自选目录，
# 自选目录用 -TavernHome 指定；装卸前请你自己执行 dsh-tavern stop，装/卸完成后自己 dsh-tavern start。
# 本脚本只提示、不代停/代启（关浏览器或终端不等于停止），CLI 全程用 Node，不借 Electron 宿主进程。
#
# 约定：把压缩包解压到**酒馆目录内任意一层**（例如 D:\Program Files (x86)\DSH-Tavern\），
# 脚本会从自身位置**向上扫描**找酒馆；找不到时再扫常见默认位置，仍找不到则报错并提示 -TavernHome。
# 本脚本只下载官方 GitHub Release 资产，不索取任何凭据。

param(
  [Parameter(Position = 0)][string]$Action = '',
  [string]$TavernHome,
  # 嵌入式Desktop使用独立宿主安装根目录，不占用作者源码--app参数。
  [string]$DesktopApp,
  [switch]$Yes,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding } catch {}
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$repo = 'huajiao1998/dsh-tavern-sqlite-v2'
# 安装器自己的日志（不是酒馆维护证据）：脚本同目录 install.log，每次运行覆盖。
# **必须在任何校验之前就打开**：否则前面几步失败（没找到酒馆/Node、参数不合法）会连日志都没有，
# 用户只看到窗口一闪，没有任何可发回的原因（2026-10-07 实测踩到）。
# 脚本目录不可写时退回 %TEMP%，并如实告知真实路径。
function New-LogWriter([string]$path) {
  $w = [System.IO.StreamWriter]::new($path, $false, [System.Text.UTF8Encoding]::new($false))
  $w.NewLine = "`n"
  $w.AutoFlush = $true
  return $w
}
$script:installLogPath = Join-Path $root 'install.log'
$script:installLogDir = $root
$script:installLogWriter = $null
try { $script:installLogWriter = New-LogWriter $script:installLogPath }
catch {
  $alt = Join-Path $env:TEMP 'dsh-tavern-install.log'
  try { $script:installLogWriter = New-LogWriter $alt; $script:installLogPath = $alt; $script:installLogDir = $env:TEMP } catch { $script:installLogWriter = $null }
}

function Say([string]$text) { Write-Host $text; try { if ($script:installLogWriter) { $script:installLogWriter.WriteLine($text) } } catch {} }
function Ok([string]$text) { $line = '√ ' + $text; Write-Host $line -ForegroundColor Green; try { if ($script:installLogWriter) { $script:installLogWriter.WriteLine($line) } } catch {} }
function Warn([string]$text) { $line = '! ' + $text; Write-Host $line -ForegroundColor Yellow; try { if ($script:installLogWriter) { $script:installLogWriter.WriteLine($line) } } catch {} }
# 双击运行时保留窗口等用户看一眼；显式 -Yes 或输入被重定向（自动化/管道）时不等待，避免挂住。
# 只要还连着控制台就等（不再要求 Host 必须是 ConsoleHost：宿主判断过窄会让窗口直接消失）。
# 只有用户主动点窗口叉关闭或输入 0 退出才是正常结束；其他任何异常退出前都必须停住等用户看。
function Wait-Exit {
  if ($Yes) { return }
  # 由 run-install.cmd 启动时，最后那次暂停归外层负责，避免用户连按两次回车。
  if ($env:DSH_TAVERN_LAUNCHER -eq '1') { return }
  if ([Console]::IsInputRedirected) { return }
  try { Read-Host '按回车退出' | Out-Null } catch {}
}
function Fail([string]$text) { Write-Host ''; $line = '× ' + $text; Write-Host $line -ForegroundColor Red; try { if ($script:installLogWriter) { $script:installLogWriter.WriteLine(''); $script:installLogWriter.WriteLine($line) } } catch {}; Wait-Exit; exit 1 }

# 全脚本异常兜底：任何未捕获异常（联网失败/解压失败/维护崩溃…）都先写日志再停住等用户，
# 不允许闪退。只有点叉或输入 0 退出才不经过这里。
trap {
  $msg = '× 安装器异常退出：' + $_.Exception.Message
  try {
    if (-not $script:installLogWriter) { $script:installLogWriter = New-LogWriter $script:installLogPath }
    $script:installLogWriter.WriteLine($msg)
    $script:installLogWriter.WriteLine('  完整日志：' + $script:installLogPath)
  } catch {}
  Write-Host ''; Write-Host $msg -ForegroundColor Red
  Write-Host ('  完整日志：' + $script:installLogPath) -ForegroundColor Yellow
  try { $script:installLogWriter.Dispose() } catch {}
  $script:installLogWriter = $null
  Wait-Exit
  exit 1
}

if ($Help) {
  Say '用法：.\install.ps1 [install|update|uninstall|check] [-TavernHome <酒馆目录>] [-DesktopApp <DSH Desktop 安装目录>] [-Yes]'
  Say '不带参数运行 = 打开菜单（安装/更新/卸载/预检）'
  exit 0
}
# 第一行就把日志位置说清楚：用户不必猜、不必翻目录。
Say ('dsh-tavern-sqlite-v2 安装器 —— 日志：' + $script:installLogPath)
# 参数值手工校验（不用 ValidateSet：-File 调用方式下空默认值会被误判为非法值）
if ($Action -and @('install', 'update', 'uninstall', 'check') -notcontains $Action) {
  Fail ('未知动作：' + $Action + '（可用：install | update | uninstall | check）')
}

# ——— 0. 包根与自身完整性 ———
# 发行 zip 里 install.ps1 与 package.json 同级；源码树里它在 deploy/ 下（父目录才是包根）。
$packageJson = Join-Path $root 'package.json'
if (-not (Test-Path $packageJson)) {
  $parent = Split-Path $root -Parent
  if ($parent -and (Test-Path (Join-Path $parent 'package.json'))) { $root = $parent; $packageJson = Join-Path $root 'package.json' }
}
if (-not (Test-Path $packageJson)) { Fail '本目录没有 package.json：请先解压压缩包，再运行其中的 install.ps1' }
$meta = Get-Content $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
if ($meta.name -ne 'dsh-tavern-sqlite-v2') { Fail ('本目录不是 dsh-tavern-sqlite-v2 包（name=' + $meta.name + '）') }
$localEntry = Join-Path $root 'deploy\maintenance.mjs'
if (-not (Test-Path $localEntry)) { Fail '本目录缺少 deploy\maintenance.mjs：压缩包不完整，请重新解压' }
$localVersion = [string]$meta.version

# ——— 1. 找酒馆（先向上扫描，再扫默认位置）———
function Test-TavernRoot([string]$dir) {
  if (-not $dir -or -not (Test-Path $dir)) { return $null }
  $harness = Join-Path $dir 'data\harness'
  if ((Test-Path (Join-Path $dir 'launcher-settings.xml')) -and (Test-Path (Join-Path $harness 'profiles\tavern\package.json'))) {
    return @{ home = $harness; kind = 'desktop'; layout = 'launcher' }
  }
  foreach ($base in @($dir, (Join-Path $dir 'apps\dsh-tavern'), (Join-Path $dir 'data\harness\apps\dsh-tavern'))) {
    $marker = Join-Path $base '.dsh-tavern-local.json'
    if (-not (Test-Path $marker)) { continue }
    try { $local = Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    if ($local.host -eq 'desktop') {
      if (-not $local.dshHome -or -not [System.IO.Path]::IsPathRooted($local.dshHome)) { return $null }
      if (-not (Test-Path (Join-Path $local.dshHome 'profiles\tavern\package.json'))) { return $null }
      $homePath = [System.IO.Path]::GetFullPath($local.dshHome).TrimEnd('\', '/')
      $parent = Split-Path $homePath -Parent
      $isLauncher = (Split-Path $homePath -Leaf) -eq 'harness' -and (Split-Path $parent -Leaf) -eq 'data'
      if ($isLauncher -and -not (Test-Path (Join-Path (Split-Path $parent -Parent) 'launcher-settings.xml'))) { return $null }
      # 这里只识别候选；菜单前用Node的options/runtimeFor核作者link、home及运行时，判据与实际维护一致。
      return @{ home = $homePath; kind = 'desktop'; layout = $(if ($isLauncher) { 'launcher' } else { 'embedded' }) }
    }
  }
  if (Test-Path (Join-Path $dir 'profiles\tavern\package.json')) { return @{ home = $dir; kind = 'cli' } }
  return $null
}

function Find-Tavern {
  if ($TavernHome) {
    $hit = Test-TavernRoot $TavernHome
    if (-not $hit) { Fail ('-TavernHome 指定的目录不是有效的酒馆安装：' + $TavernHome) }
    return $hit
  }
  $dir = $root
  while ($dir) {
    $hit = Test-TavernRoot $dir
    if ($hit) { return $hit }
    $parent = Split-Path $dir -Parent
    if ($parent -eq $dir) { break }
    $dir = $parent
  }
  # 空环境变量要防 Join-Path 抛错（32 位系统没有 ProgramFiles(x86)）
  $defaults = @(
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'DSH-Tavern' }),
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'DSH-Tavern' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'DSH-Tavern' }),
    $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh-tavern' })
  ) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($candidate in $defaults) { $hit = Test-TavernRoot $candidate; if ($hit) { return $hit } }
  return $null
}

# ——— 2. 找 Node 运行时（用户机器可能没装 Node）———
function Find-NodeRuntime([hashtable]$tavern) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return @{ exe = $cmd.Source; runAsNode = $false } }
  if ($tavern.kind -eq 'desktop') {
    $tools = Join-Path $tavern.home 'tools\desktop-package-manager'
    if (Test-Path $tools) {
      $node = Get-ChildItem $tools -Directory -Filter 'node-v*-win-*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'node.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($node) { return @{ exe = $node; runAsNode = $false } }
    }
    # 嵌入式首版维护用PATH或工具缓存中的Node，不能盲把共享Desktop.exe当Node：进程保护按宿主路径判在跑。
    if ($tavern.layout -eq 'embedded') { return $null }
    $tavernRoot = Split-Path (Split-Path $tavern.home -Parent) -Parent
    $runtime = Get-ChildItem $tavernRoot -Directory -Filter 'runtime-*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($runtime) {
      $exe = Join-Path $runtime.FullName 'DSH Desktop.exe'
      if (Test-Path $exe) { return @{ exe = $exe; runAsNode = $true } }
    }
  }
  return $null
}

# 与实际维护共用目标/运行时判据；仅导入只读识别模块，不执行维护或启动profile。
# 桌面形态走 Assert-DesktopTarget、Windows CLI 走 Assert-CliTarget：两套只读判据互不认领，都在菜单前调用。
# 这里不抽公共桥接函数：桌面那条路径已有过闸断言按原文本抽取，保持一字不动，CLI 自己写一份自足桥。

# Windows CLI 的服务生命周期不归安装器（stop-only）：只提示用户自己 dsh-tavern stop/start，不代跑、不 taskkill。
# -ReadOnly 用于只读预检：预检不改装配、不碰存档，可以开着酒馆跑，不把 stop 说成必要步骤。
function Show-CliServiceNotice([hashtable]$tavern, [switch]$After, [switch]$ReadOnly) {
  if ($tavern.kind -ne 'cli') { return }
  if ($ReadOnly) {
    if ($After) { Say '  CLI 版：预检只写日志与证据，未停/未启酒馆，可继续开着跑。' }
    else { Say '  CLI 版：只读预检不改装配、不碰存档，可以开着酒馆跑（不必先停）。' }
    return
  }
  if ($After) { Say '  CLI 版：请你自己执行 dsh-tavern start 启动酒馆后再验证（安装器不代启）。' }
  else { Warn 'CLI 版：装卸前请你自己执行 dsh-tavern stop 停稳酒馆；关浏览器或终端不等于停止，安装器不代停/代启。' }
}
# 失败提示里带上 CLI 的停止前提；桌面形态返回空串，原提示一字不变。
function Get-CliStopHint([hashtable]$tavern) {
  if ($tavern.kind -ne 'cli') { return '' }
  return '；Windows CLI 请确认已自己执行 dsh-tavern stop 停稳（关浏览器或终端不等于停止），本安装器不代停/代启'
}

# Windows CLI 目标识别：只读跑 target 的 options/runtimeFor（与实际维护同一判据），识别不过绝不进入维护。
# SDK/JS 入口由 target 从宿主自己的 runtime/dsh 包 bin 解析——PS1 不猜 bin、不改其它 profile、不写目标。
function Assert-CliTarget([hashtable]$tavern, [hashtable]$node) {
  if ($tavern.kind -eq 'desktop') { return }
  # CLI 全程 Node：Electron 宿主进程不能当维护 Node（桌面形态才允许 RUN_AS_NODE）。
  if ($node.runAsNode) { Fail 'CLI 版维护必须用 Node.js 运行，不能借 Electron 宿主进程当 Node；-DesktopApp 只属于桌面形态' }
  $target = Join-Path $root 'deploy\maintenance\target.mjs'
  $probe = @'
import { pathToFileURL } from 'node:url';
const { options, runtimeFor } = await import(pathToFileURL(process.argv[1]).href);
const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const op = options([request.action, '--home', request.home]);
if (op.host !== 'cli') throw Error('该目录实际是桌面版宿主，不能按 CLI 认领；桌面形态请带 -DesktopApp');
const runtime = runtimeFor(op);
console.log(JSON.stringify({ host: op.host, cli: runtime.cli }));
'@
  # 统一新接口：只有 uninstall 按卸资格；install/update/check 都按 **install** 动作判资格（换代由驱动单命令内清旧装配）。
  $verb = if ($Action -eq 'uninstall') { 'uninstall' } else { 'install' }
  $request = @{ action = $verb; home = $tavern.home } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($request))
  $saved = $env:ELECTRON_RUN_AS_NODE
  $savedErrorAction = $ErrorActionPreference
  try {
    # 桥接不继承 Electron 的 RUN_AS_NODE；用完原样恢复，不持久改用户环境。
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $ErrorActionPreference = 'Continue'
    $lines = @(& $node.exe --input-type=module -e $probe $target $encoded 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorAction
    if ($null -eq $saved) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $saved }
  }
  if ($code -ne 0) { Fail ('CLI 目标识别未通过：' + ($lines -join "`n")) }
  $checked = ($lines -join "`n") | ConvertFrom-Json
  if ($checked.host -ne 'cli') { Fail ('CLI 目标识别未通过：target 判定为 ' + $checked.host) }
  # 只记录 target 解析出的真实 JS 入口供显示；维护命令仍只走 maintenance.mjs，不由 PS1 拼运行时。
  $tavern.sdkEntry = [string]$checked.cli
}

function Assert-DesktopTarget([hashtable]$tavern, [hashtable]$node) {
  if ($tavern.kind -ne 'desktop') {
    if ($DesktopApp) { Fail '-DesktopApp 只适用于桌面宿主，不能用它认领 CLI 酒馆' }
    return
  }
  $target = Join-Path $root 'deploy\maintenance\target.mjs'
  $probe = @'
import { pathToFileURL } from 'node:url';
const { options, runtimeFor } = await import(pathToFileURL(process.argv[1]).href);
const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const args = [request.action, '--home', request.home];
if (request.desktopApp) args.push('--desktop-app', request.desktopApp);
const op = options(args);
if (op.host !== 'desktop') throw Error('桌面候选未通过实际宿主判定');
const runtime = runtimeFor(op);
console.log(JSON.stringify({ layout: op.desktopLayout, runtimeRoot: runtime.desktop.root }));
'@
  # 统一新接口：只有 uninstall 按卸资格；install/update/check 都按 **install** 动作判资格（换代由驱动单命令内清旧装配）。
  $verb = if ($Action -eq 'uninstall') { 'uninstall' } else { 'install' }
  $request = @{ action = $verb; home = $tavern.home; desktopApp = $DesktopApp } | ConvertTo-Json -Compress
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($request))
  $saved = $env:ELECTRON_RUN_AS_NODE
  $savedErrorAction = $ErrorActionPreference
  try {
    if ($node.runAsNode) { $env:ELECTRON_RUN_AS_NODE = '1' }
    $ErrorActionPreference = 'Continue'
    $lines = @(& $node.exe --input-type=module -e $probe $target $encoded 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorAction
    if ($node.runAsNode) { if ($null -eq $saved) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $saved } }
  }
  if ($code -ne 0) { Fail ('桌面目标识别未通过：' + ($lines -join "`n")) }
  $checked = ($lines -join "`n") | ConvertFrom-Json
  $tavern.layout = $checked.layout
}

# ——— 3. 跑维护（同一窗口内显示全部进度）———
function Invoke-Maintenance([hashtable]$tavern, [hashtable]$node, [string]$entry, [string]$verb, [switch]$Check, [string]$LogFile = '') {
  $argv = @($entry, $verb, '--home', $tavern.home)
  if ($DesktopApp) { $argv += @('--desktop-app', $DesktopApp) }
  if ($Check) { $argv += '--check' }
  # 安装阶段的所有用户可见产物都必须落在**插件包目录**（install.ps1 旁边）：
  # install.log 在这里，维护写出的 result.json 也要求写到这里，用户报错不必去翻酒馆维护目录。
  # 酒馆维护目录只保留维护证据材料（预演副本/单元备份），那是安装期内部产物、不需要用户翻。
  $argv += @('--report-dir', $script:installLogDir)
  # 日志已在脚本开头打开并全程复用；$LogFile 仅供自动化测试指定隔离位置。
  if ($LogFile -and $LogFile -ne $script:installLogPath) {
    if ($script:installLogWriter) { try { $script:installLogWriter.Dispose() } catch {} }
    $script:installLogWriter = New-LogWriter $LogFile
    $script:installLogPath = $LogFile
  } elseif (-not $script:installLogWriter) {
    $script:installLogWriter = New-LogWriter $script:installLogPath
  }
  $logFile = $script:installLogPath
  $writer = $script:installLogWriter
  Say ('安装日志：' + $logFile)
  $saved = $env:ELECTRON_RUN_AS_NODE
  $savedErrorAction = $ErrorActionPreference
  if ($node.runAsNode) { $env:ELECTRON_RUN_AS_NODE = '1' }
  try {
    # Windows PowerShell 5 把原生 stderr 转成 ErrorRecord；这里合流而非因 Stop 提前中断。
    # 不代启酒馆、不另开窗口；仅维护子进程的输出同时显示并落盘。
    $ErrorActionPreference = 'Continue'
    & $node.exe @argv 2>&1 | ForEach-Object {
      $line = [string]$_
      # 与维护侧同款脱敏：登录链接/授权头不进安装日志，也不回显给排错分享。
      $line = $line -replace '(?i)([?&#](?:token|password|secret|access_token)=)[^\s&)]+', '$1<redacted>'
      $line = $line -replace '(?i)(Bearer\s+)[\w.\-]+', '$1<redacted>'
      $writer.WriteLine($line)
      Write-Host $line
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) { Warn ('维护失败（exit ' + $code + '）；完整日志：' + $logFile) }
    return $code
  } finally {
    # 不在这里关日志：它是脚本级句柄，后面还有「安装完成/已卸载」等提示要落盘；
    # AutoFlush 已保证内容实时写盘，进程退出时由系统回收句柄。
    try { $script:installLogWriter.Flush() } catch {}
    $ErrorActionPreference = $savedErrorAction
    if ($node.runAsNode) { if ($null -eq $saved) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $saved } }
  }
}

# ——— 4. 联网查最新版本 / 下载官方包（仅"更新"用）———
function Compare-Version([string]$a, [string]$b) {
  try { return ([version]($a -replace '[^0-9.].*$', '')).CompareTo([version]($b -replace '[^0-9.].*$', '')) } catch { return 0 }
}

function Get-LatestRelease {
  try {
    return Invoke-RestMethod -Uri ("https://api.github.com/repos/$repo/releases/latest") -Headers @{ 'User-Agent' = 'dsh-tavern-installer'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 25
  } catch {
    return $null
  }
}

function Save-ReleasePackage([hashtable]$release) {
  $asset = $release.assets | Where-Object { $_.name -like '*.tgz' } | Select-Object -First 1
  if (-not $asset) { return $null }
  $temp = Join-Path $env:TEMP ('dsh-tavern-v2-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $temp | Out-Null
  $file = Join-Path $temp $asset.name
  Say ('  下载：' + $asset.name)
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing -TimeoutSec 300
  # 有 SHA256SUMS 就核对（缺了不阻断，但不静默跳过校验：明确告知）
  $sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS' } | Select-Object -First 1
  if ($sums) {
    try {
      $lines = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing -TimeoutSec 60).Content -split "`n"
      $want = ($lines | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1)
      if ($want) {
        $expect = ($want -split '\s+')[0].Trim().ToLower()
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
        if ($expect -ne $actual) { Remove-Item -Recurse -Force $temp; Fail '下载包摘要与官方 SHA256SUMS 不一致，已中止（不安装未校验的包）' }
        Ok '  下载包 SHA256 与官方一致'
      } else { Warn '  官方 SHA256SUMS 未列出该资产，跳过摘要核对' }
    } catch { Warn '  摘要核对失败（网络/格式）：继续但未经核对' }
  } else { Warn '  官方未提供 SHA256SUMS，跳过摘要核对' }
  $extract = Join-Path $temp 'x'
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  & tar -xzf $file -C $extract
  if ($LASTEXITCODE -ne 0) { Fail '解压失败（需要 Windows 自带的 tar；Win10 1803+ 默认有）' }
  $entry = Join-Path $extract 'package\deploy\maintenance.mjs'
  if (-not (Test-Path $entry)) { Fail '下载包结构不对（缺 package\deploy\maintenance.mjs）' }
  return $entry
}

# ——— 5. 动作实现 ———
function Do-Install([hashtable]$tavern, [hashtable]$node, [string]$entry, [switch]$QuietNotice) {
  Say '开始安装（离线，使用本地包）…'
  # 更新流程自己已经念过前后 notice，这里不重复念第二遍。
  if (-not $QuietNotice) { Show-CliServiceNotice $tavern }
  $code = Invoke-Maintenance $tavern $node $entry 'install'
  if ($code -ne 0) { Fail ('安装失败（exit ' + $code + '）：请把上面的输出发给维护者' + (Get-CliStopHint $tavern)) }
  Ok '安装完成。'
  if ($tavern.kind -eq 'desktop') { Say '  桌面版：请从托盘**完全退出**酒馆后重新启动，再从 Profile 菜单进入 tavern。' }
  if (-not $QuietNotice) { Show-CliServiceNotice $tavern -After }
}

function Do-Uninstall([hashtable]$tavern, [hashtable]$node, [string]$entry) {
  Say '开始卸载（离线；含安装中断/酒馆升级覆盖后的残留兜底，不碰存档和数据库）…'
  Show-CliServiceNotice $tavern
  $code = Invoke-Maintenance $tavern $node $entry 'uninstall'
  if ($code -ne 0) { Fail ('卸载失败（exit ' + $code + '）：请把上面的输出发给维护者' + (Get-CliStopHint $tavern)) }
  Ok '已卸载。若酒馆桌面版曾经运行，请重开一次使其回到原状。'
  Show-CliServiceNotice $tavern -After
}

function Do-Check([hashtable]$tavern, [hashtable]$node, [string]$entry) {
  Say '只读预检（不改酒馆源码/装配，仅写维护日志与证据，可开着酒馆）…'
  # 只读预检不要求先停：CLI 用 -ReadOnly 提示，不把 stop 说成必要步骤。
  Show-CliServiceNotice $tavern -ReadOnly
  $code = Invoke-Maintenance $tavern $node $entry 'install' -Check
  if ($code -ne 0) { Fail ('预检未通过（exit ' + $code + '）') }
  Ok '预检通过。'
  Show-CliServiceNotice $tavern -ReadOnly -After
}

function Do-Update([hashtable]$tavern, [hashtable]$node) {
  Say ('本机包版本：' + $localVersion)
  # 更新＝**一次统一 install**：同包换代由驱动在单命令内先清旧装配再装新代（不再"先卸再装"两次维护事务）。
  # ≤0.3.7 旧机制不代卸：现场旧记录/旧 marker 会被 source 门禁拒绝并提示先用旧版 CLI 卸载，这里只提示一次，不代停/代启。
  Show-CliServiceNotice $tavern
  Say '联网查询官方最新版本…'
  $release = Get-LatestRelease
  if ($release) {
    $latest = [string]$release.tag_name
    if ($latest.StartsWith('v')) { $latest = $latest.Substring(1) }
    Say ('官方最新版本：' + $latest)
    $cmp = Compare-Version $latest $localVersion
    if ($cmp -gt 0) {
      Say '发现新版本，使用官方包更新（单次 install 完成换代；存档与用户配置不动）'
      $remote = Save-ReleasePackage $release
      if ($remote) {
        $code = Invoke-Maintenance $tavern $node $remote 'install'
        if ($code -ne 0) { Fail ('更新到 ' + $latest + ' 失败（exit ' + $code + '）：若现场是 ≤0.3.7 旧机制，请先用**旧版插件自带 CLI** 完整卸载后再安装（新版拒绝旧记录/旧标记，不做自动接管）；其余请把上面的输出发给维护者') }
        Ok ('已更新到 ' + $latest + '。')
        if ($tavern.kind -eq 'desktop') { Say '  桌面版：请从托盘**完全退出**酒馆后重新启动，再从 Profile 菜单进入 tavern。' }
        Show-CliServiceNotice $tavern -After
        return
      }
      Warn '新版本资产不完整，改用本包覆盖安装'
    } elseif ($cmp -eq 0) {
      Say '已是最新版本，用本包覆盖安装'
    } else {
      Warn ('本包（' + $localVersion + '）比官方最新（' + $latest + '）更新：按本包覆盖安装')
    }
  } else {
    Warn '联网查询失败（网络不可达或被拦截）：改用本包覆盖安装'
  }
  # 本包覆盖：同样**单次 install**（驱动按现场区块清残留后重接，不再单独代卸旧代）。
  $code = Invoke-Maintenance $tavern $node $localEntry 'install'
  if ($code -ne 0) { Fail ('覆盖安装失败（exit ' + $code + '）：≤0.3.7 旧机制请先用旧版插件自带 CLI 完整卸载后再安装；其余请把上面的输出发给维护者') }
  Show-CliServiceNotice $tavern -After
}

# ——— 6. 菜单 / 直用 ———
Say ('dsh-tavern-sqlite-v2 ' + $localVersion + ' —— Windows 安装器')
$tavern = Find-Tavern
if (-not $tavern) {
  Fail '没找到酒馆安装。请把本压缩包解压到酒馆目录（例如 D:\Program Files (x86)\DSH-Tavern\）后重试，或用 -TavernHome 指定目录。'
}
if ($tavern.layout -eq 'embedded' -and -not $DesktopApp) {
  Fail '借助 DSH Desktop 的酒馆需指定宿主安装目录：-DesktopApp <含 DSH Desktop.exe 的目录>；不猜运行时、不要求改装独立酒馆。'
}
if ($DesktopApp) { $DesktopApp = [System.IO.Path]::GetFullPath($DesktopApp) }
$node = Find-NodeRuntime $tavern
if (-not $node) { Fail '没找到可用的 Node 运行时：请安装 Node.js 22+，或使用带独立 Node 的酒馆桌面版。' }
Assert-DesktopTarget $tavern $node
Assert-CliTarget $tavern $node
Say ('酒馆目录：' + $tavern.home + '（' + $tavern.kind + '）')
Say ('使用运行时：' + $node.exe + $(if ($node.runAsNode) { '（Electron RUN_AS_NODE）' } else { '' }))
if ($tavern.kind -eq 'cli' -and $tavern.sdkEntry) { Say ('  CLI 维护入口（target 解析）：' + $tavern.sdkEntry) }
Say ''

if (-not $Action) {
  Say '请选择操作：'
  Say '  1) 安装插件'
  Say '  2) 更新插件（联网查最新版本；已是最新则用本包覆盖安装）'
  Say '  3) 卸载插件'
  Say '  4) 只读预检（不改文件）'
  Say '  0) 退出'
  # 交互时用 Read-Host；输入被重定向（自动化/脚本调用）时从 stdin 读一行。
  $choice = if ([Console]::IsInputRedirected) { [Console]::In.ReadLine() } else { Read-Host '输入序号后回车' }
  if ($null -eq $choice) { $choice = '' }
  switch ($choice.Trim()) {
    '1' { $Action = 'install' }
    '2' { $Action = 'update' }
    '3' { $Action = 'uninstall' }
    '4' { $Action = 'check' }
    '0' { Say '已退出，未做任何改动。'; exit 0 }
    default { Fail ('无效选项：' + $choice) }
  }
  Say ''
}

switch ($Action) {
  'check' { Do-Check $tavern $node $localEntry }
  'install' { Do-Install $tavern $node $localEntry }
  'uninstall' { Do-Uninstall $tavern $node $localEntry }
  'update' { Do-Update $tavern $node }
}
Wait-Exit
exit 0
