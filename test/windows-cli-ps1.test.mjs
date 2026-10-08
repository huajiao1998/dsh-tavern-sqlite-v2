// WinCLI PS1：只按原文本抽取实际 Assert-CliTarget；自建假 target 记录入参、临时 PS1 加 BOM，不跑整份入口、不碰真 SDK/profile。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const src = readFileSync(new URL('../deploy/install.ps1', import.meta.url), 'utf8')
const cli = src.slice(src.indexOf('function Assert-CliTarget('), src.indexOf('function Assert-DesktopTarget('))
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64')
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'v2-wincli-ps1-')))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-wincli-ps1-')); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true }) })
  const put = (file, value, bom) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, (bom ? '\uFEFF' : '') + value, 'utf8') }
  return { root, put }
}
function run(shell, f, body, { timeout = 15000 } = {}) {
  const file = path.join(f.root, 'fixture.ps1')
  const data = { root: f.root, home: path.join(f.root, '中文 空格 home'), node: process.execPath,
    cases: ['install', 'check', 'uninstall', 'update', ''].map(action => ({ tag: action || 'menu', action })) }
  f.put(file, [
    "$ErrorActionPreference='Stop'",
    '$a=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64(data) + '\')) | ConvertFrom-Json',
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    'function Fail([string]$text){throw $text}',
    '$root=$a.root',
    'Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64(cli) + '\')))',
    ...(Array.isArray(body) ? body : [body]),
  ].join('\n'), true)
  const out = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout })
  assert.ifError(out.error); assert.equal(out.status, 0, out.stdout + out.stderr)
  return JSON.parse(out.stdout.trim())
}
if (process.platform === 'win32') for (const [label, shell] of [
  ['pwsh', 'pwsh'], ['PS5', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
]) {
  test('WinCLI PS1：' + label + 'Assert-CliTarget 按动作判资格、桥接还原 RUN_AS_NODE 并只记录 target 入口（BOM 临时 PS1）', { timeout: label === 'pwsh' ? 35000 : 90000 }, t => {
    assert.ok(!cli.includes('function Assert-DesktopTarget'), '只抽取 Assert-CliTarget，不能带桌面判据')
    assert.ok(!cli.includes('# ——— 6.'), '只抽取函数，不能带菜单入口')
    const f = fixture(t), home = path.join(f.root, '中文 空格 home')
    f.put(path.join(f.root, 'deploy', 'maintenance', 'target.mjs'), `import {writeFileSync} from 'node:fs';
export function options(argv){writeFileSync(process.env.FIXTURE_RECORD,JSON.stringify({options:argv}),'utf8');return {host:'cli',home:argv[2]};}
export function runtimeFor(op){writeFileSync(process.env.FIXTURE_RUNTIME,JSON.stringify({runtimeFor:op.home}),'utf8');return {cli:'fixture-sdk/bin.js'};}`)
    const cases = [
      { tag: 'install', action: 'install', verb: 'install' }, { tag: 'check', action: 'check', verb: 'install' },
      { tag: 'uninstall', action: 'uninstall', verb: 'uninstall' }, { tag: 'update', action: 'update', verb: 'uninstall' },
      { tag: 'menu', action: '', verb: 'uninstall' },
    ]
    const got = run(shell, f, [
      "$env:ELECTRON_RUN_AS_NODE='fixture-original'", '$out=@()',
      'foreach($case in $a.cases){',
      ' $Action=$case.action; $env:FIXTURE_RECORD=Join-Path $a.root ($case.tag+".options.json"); $env:FIXTURE_RUNTIME=Join-Path $a.root ($case.tag+".runtime.json")',
      ' $tavern=@{kind="cli";home=(Join-Path $a.home $case.tag)}; $node=@{exe=$a.node;runAsNode=$false}',
      ' Assert-CliTarget $tavern $node',
      ' $out+=@{tag=$case.tag;sdkEntry=$tavern.sdkEntry;env=$env:ELECTRON_RUN_AS_NODE;preference=[string]$ErrorActionPreference}',
      '}',
      'ConvertTo-Json -InputObject $out -Depth 5 -Compress',
    ].join('\n'), label === 'pwsh' ? { timeout: 30000 } : { timeout: 60000 })
    for (const result of got) {
      const c = cases.find(item => item.tag === result.tag)
      const opts = JSON.parse(readFileSync(path.join(f.root, c.tag + '.options.json'), 'utf8'))
      const rt = JSON.parse(readFileSync(path.join(f.root, c.tag + '.runtime.json'), 'utf8'))
      assert.deepEqual(opts.options, [c.verb, '--home', path.join(home, c.tag)])
      assert.equal(rt.runtimeFor, path.join(home, c.tag))
      assert.equal(result.sdkEntry, 'fixture-sdk/bin.js')
      assert.equal(result.env, 'fixture-original'); assert.equal(result.preference, 'Stop')
    }
  })
  test('WinCLI PS1：' + label + '假 target 抛错走 Fail 且 RUN_AS_NODE/ErrorActionPreference 复原；CLI 只用 PATH Node 不代停启（源码判据）', t => {
    const f = fixture(t), home = path.join(f.root, '中文 空格 home')
    f.put(path.join(f.root, 'deploy', 'maintenance', 'target.mjs'), `export function options(){throw Error('fixture options refused');}
export function runtimeFor(){throw Error('must not reach runtimeFor');}`)
    const got = run(shell, f, [
      "$env:ELECTRON_RUN_AS_NODE='fixture-original'", '$tavern=@{kind="cli";home=$a.home}; $node=@{exe=$a.node;runAsNode=$false}; $Action="install"; $err=""',
      'try {Assert-CliTarget $tavern $node} catch {$err=$_.Exception.Message}',
      '$out=[ordered]@{error=$err;sdkEntry=$tavern.sdkEntry;env=$env:ELECTRON_RUN_AS_NODE;preference=[string]$ErrorActionPreference}',
      'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
      '$err2=""; try {Assert-CliTarget $tavern $node} catch {$err2=$_.Exception.Message}',
      '$out.unsetError=$err2; $out.unsetEnv=$null -eq $env:ELECTRON_RUN_AS_NODE; $out.unsetPreference=[string]$ErrorActionPreference',
      '$out | ConvertTo-Json -Depth 5 -Compress',
    ].join('\n'))
    assert.match(got.error, /CLI 目标识别未通过/); assert.match(got.error, /fixture options refused/)
    assert.equal(got.sdkEntry, null); assert.equal(got.env, 'fixture-original'); assert.equal(got.preference, 'Stop')
    assert.match(got.unsetError, /CLI 目标识别未通过/); assert.equal(got.unsetEnv, true); assert.equal(got.unsetPreference, 'Stop')
    // 主调用顺序与 CLI 不代停/代启：读源码文本，不执行入口。
    const main = src.slice(src.indexOf('# ——— 6. 菜单 / 直用 ———'))
    assert.ok(main.indexOf('Assert-CliTarget $tavern $node') > 0 && main.indexOf('Assert-CliTarget $tavern $node') < main.indexOf('if (-not $Action)'))
    assert.ok(main.indexOf('Assert-CliTarget $tavern $node') < main.indexOf("switch ($Action)"))
    assert.ok(main.indexOf('Assert-DesktopTarget $tavern $node') < main.indexOf('Assert-CliTarget $tavern $node'))
    // stop/start 只在提示文本里出现（Show-CliServiceNotice/Get-CliStopHint），判据函数本身不代停/代启。
    const notice = src.slice(src.indexOf('function Show-CliServiceNotice('), src.indexOf('function Assert-DesktopTarget('))
    assert.match(notice, /dsh-tavern stop/); assert.match(notice, /安装器不代停\/代启/)
    assert.ok(!/taskkill|dsh-tavern\s+(stop|start)/.test(cli), 'CLI 判据不代停/代启、不 taskkill')
    assert.match(cli, /if \(\$node\.runAsNode\) \{ Fail /)
    assert.ok(!/ELECTRON_RUN_AS_NODE\s*=\s*'1'/.test(cli), 'CLI 不把 Electron 宿主当 Node')
  })
}
