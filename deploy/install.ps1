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
#   .\install.ps1 install|update|uninstall|check [-TavernHome <目录>] [-Yes]
#
# 约定：把压缩包解压到**酒馆目录内任意一层**（例如 D:\Program Files (x86)\DSH-Tavern\），
# 脚本会从自身位置**向上扫描**找酒馆；找不到时再扫常见默认位置，仍找不到则报错并提示 -TavernHome。
# 本脚本只下载官方 GitHub Release 资产，不索取任何凭据。

param(
  [Parameter(Position = 0)][string]$Action = '',
  [string]$TavernHome,
  [switch]$Yes,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding } catch {}
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$repo = 'huajiao1998/dsh-tavern-sqlite-v2'

function Say([string]$text) { Write-Host $text }
function Ok([string]$text) { Write-Host ('√ ' + $text) -ForegroundColor Green }
function Warn([string]$text) { Write-Host ('! ' + $text) -ForegroundColor Yellow }
# 双击运行时保留窗口等用户看一眼；输入被重定向（自动化/管道）或显式 -Yes 时不等待，避免挂住。
function Wait-Exit { if ($Yes) { return }; if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) { Read-Host '按回车退出' | Out-Null } }
function Fail([string]$text) { Write-Host ''; Write-Host ('× ' + $text) -ForegroundColor Red; Wait-Exit; exit 1 }

if ($Help) {
  Say '用法：.\install.ps1 [install|update|uninstall|check] [-TavernHome <酒馆目录>] [-Yes]'
  Say '不带参数运行 = 打开菜单（安装/更新/卸载/预检）'
  exit 0
}
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
    return @{ home = $harness; kind = 'desktop' }
  }
  foreach ($base in @($dir, (Join-Path $dir 'apps\dsh-tavern'), (Join-Path $dir 'data\harness\apps\dsh-tavern'))) {
    $marker = Join-Path $base '.dsh-tavern-local.json'
    if (-not (Test-Path $marker)) { continue }
    try { $local = Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    if ($local.host -eq 'desktop' -and $local.dshHome -and (Test-Path (Join-Path $local.dshHome 'profiles\tavern\package.json'))) {
      return @{ home = $local.dshHome; kind = 'desktop' }
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
    $tavernRoot = Split-Path (Split-Path $tavern.home -Parent) -Parent
    $runtime = Get-ChildItem $tavernRoot -Directory -Filter 'runtime-*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($runtime) {
      $exe = Join-Path $runtime.FullName 'DSH Desktop.exe'
      if (Test-Path $exe) { return @{ exe = $exe; runAsNode = $true } }
    }
  }
  return $null
}

# ——— 3. 跑维护（同一窗口内显示全部进度）———
function Invoke-Maintenance([hashtable]$tavern, [hashtable]$node, [string]$entry, [string]$verb, [switch]$Check) {
  $argv = @($entry, $verb, '--home', $tavern.home)
  if ($Check) { $argv += '--check' }
  # 仅在维护目录留本次输出，不扫描旧日志/存档；控制台明确给出位置。
  $logDir = Join-Path $tavern.home 'maintenance\dsh-tavern-sqlite-v2'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logFile = Join-Path $logDir ('installer-' + [guid]::NewGuid().ToString('N') + '.log')
  $writer = [System.IO.StreamWriter]::new($logFile, $false, [System.Text.UTF8Encoding]::new($false))
  $writer.NewLine = "`n"
  $writer.AutoFlush = $true
  Say ('维护日志：' + $logFile)
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
      Say $line
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) { Warn ('维护失败（exit ' + $code + '）；完整日志：' + $logFile) }
    return $code
  } finally {
    $writer.Dispose()
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
function Do-Install([hashtable]$tavern, [hashtable]$node, [string]$entry) {
  Say '开始安装（离线，使用本地包）…'
  $code = Invoke-Maintenance $tavern $node $entry 'install'
  if ($code -ne 0) { Fail ('安装失败（exit ' + $code + '）：请把上面的输出发给维护者') }
  Ok '安装完成。'
  if ($tavern.kind -eq 'desktop') { Say '  桌面版：请从托盘**完全退出**酒馆后重新启动，再从 Profile 菜单进入 tavern。' }
  else { Say '  CLI 版：请按你原来的方式重启酒馆服务后验证页面。' }
}

function Do-Uninstall([hashtable]$tavern, [hashtable]$node, [string]$entry) {
  Say '开始卸载（离线）…'
  $code = Invoke-Maintenance $tavern $node $entry 'uninstall'
  if ($code -ne 0) { Fail ('卸载失败（exit ' + $code + '）：请把上面的输出发给维护者') }
  Ok '已卸载。若酒馆桌面版曾经运行，请重开一次使其回到原状。'
}

function Do-Check([hashtable]$tavern, [hashtable]$node, [string]$entry) {
  Say '只读预检（不改酒馆源码/装配，仅写维护日志与证据，可开着酒馆）…'
  $code = Invoke-Maintenance $tavern $node $entry 'install' -Check
  if ($code -ne 0) { Fail ('预检未通过（exit ' + $code + '）') }
  Ok '预检通过。'
}

function Do-Update([hashtable]$tavern, [hashtable]$node) {
  Say ('本机包版本：' + $localVersion)
  Say '联网查询官方最新版本…'
  $release = Get-LatestRelease
  if ($release) {
    $latest = [string]$release.tag_name
    if ($latest.StartsWith('v')) { $latest = $latest.Substring(1) }
    Say ('官方最新版本：' + $latest)
    $cmp = Compare-Version $latest $localVersion
    if ($cmp -gt 0) {
      Say '发现新版本，使用官方包安装（先卸载旧代，再安装新版；存档与用户配置不动）'
      $remote = Save-ReleasePackage $release
      if ($remote) {
        $code = Invoke-Maintenance $tavern $node $localEntry 'uninstall'
        if ($code -ne 0) { Fail ('卸载旧代失败（exit ' + $code + '）：已停止，未安装新版') }
        $code = Invoke-Maintenance $tavern $node $remote 'install'
        if ($code -ne 0) { Fail ('安装新版本失败（exit ' + $code + '）：请把上面的输出发给维护者') }
        Ok ('已更新到 ' + $latest + '。')
        if ($tavern.kind -eq 'desktop') { Say '  桌面版：请从托盘**完全退出**酒馆后重新启动，再从 Profile 菜单进入 tavern。' }
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
  $code = Invoke-Maintenance $tavern $node $localEntry 'uninstall'
  if ($code -ne 0) { Fail ('卸载旧代失败（exit ' + $code + '）：已停止，未安装') }
  Do-Install $tavern $node $localEntry
}

# ——— 6. 菜单 / 直用 ———
Say ('dsh-tavern-sqlite-v2 ' + $localVersion + ' —— Windows 安装器')
$tavern = Find-Tavern
if (-not $tavern) {
  Fail '没找到酒馆安装。请把本压缩包解压到酒馆目录（例如 D:\Program Files (x86)\DSH-Tavern\）后重试，或用 -TavernHome 指定目录。'
}
$node = Find-NodeRuntime $tavern
if (-not $node) { Fail '没找到可用的 Node 运行时：请安装 Node.js 22+，或使用带独立 Node 的酒馆桌面版。' }
Say ('酒馆目录：' + $tavern.home + '（' + $tavern.kind + '）')
Say ('使用运行时：' + $node.exe + $(if ($node.runAsNode) { '（Electron RUN_AS_NODE）' } else { '' }))
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
