// 嵌入PS1：只抽取实际函数；仅自建Unicode/空格元数据与假SDK模块，不运行顶层或真实桌面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const src = readFileSync(new URL('../deploy/install.ps1', import.meta.url), 'utf8')
const extract = (start, end) => src.slice(src.indexOf(start), src.indexOf(end))
const detect = extract('function Test-TavernRoot(', 'function Find-Tavern')
const node = extract('function Find-NodeRuntime(', '# 与实际维护共用目标/运行时判据')
const check = extract('function Assert-DesktopTarget(', '# ——— 3.')
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64')
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'v2-embedded-ps1-new-')))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-embedded-ps1-new-')); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true }) })
  const put = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8') }
  return { root, put }
}
function run(shell, f, helper, data, body, { timeout = 15000 } = {}) {
  const file = path.join(f.root, 'fixture.ps1')
  f.put(file, [
    "$ErrorActionPreference='Stop'",
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    'function Fail([string]$text){throw $text}',
    "Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(helper) + "')))",
    "$a=([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(data) + "')) | ConvertFrom-Json)",
    ...body,
  ].join('\n'))
  const out = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, timeout })
  assert.ifError(out.error); assert.equal(out.status, 0, out.stdout + out.stderr)
  return JSON.parse(out.stdout.trim())
}
if (process.platform === 'win32') for (const [label, shell] of [
  ['pwsh', 'pwsh'], ['PS5', path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
]) {
  test('嵌入PS1：' + label + '实际候选函数标准.dsh布局与缺Node边界（新Unicode夹具）', t => {
    assert.ok(!detect.includes('function Find-Tavern'), '只抽取候选函数，不能包含Find-Tavern')
    const f = fixture(t), home = path.join(f.root, '用户 空间', '.dsh'), app = path.join(home, 'apps', 'dsh-tavern')
    const launcherRoot = path.join(f.root, '独立酒馆'), harness = path.join(launcherRoot, 'data', 'harness')
    const noNode = path.join(f.root, '无缓存', '.dsh')
    f.put(path.join(home, 'profiles', 'tavern', 'package.json'), {})
    f.put(path.join(app, '.dsh-tavern-local.json'), { host: 'desktop', dshHome: home })
    f.put(path.join(harness, 'profiles', 'tavern', 'package.json'), {})
    f.put(path.join(launcherRoot, 'launcher-settings.xml'), '<fixture/>')
    const cache = path.join(home, 'tools', 'desktop-package-manager', 'node-v24.0.0-win-x64', 'node.exe')
    const standalone = path.join(launcherRoot, 'runtime-one', 'DSH Desktop.exe')
    f.put(cache, 'fake node, never executed'); f.put(standalone, 'fake exe, never executed')
    // 如果embedded错误地继续向祖先扫runtime，会撞上这个陷阱，而不是返回null。
    f.put(path.join(f.root, 'runtime-trap', 'DSH Desktop.exe'), 'must not select')
    mkdirSync(noNode, { recursive: true })
    const got = run(shell, f, detect + node, { home, launcherRoot, noNode, node: process.execPath }, [
      'function Get-Command {param($Name,$ErrorAction) $script:cmd}',
      '$script:cmd=$null',
      '$embedded=Test-TavernRoot $a.home; $launcher=Test-TavernRoot $a.launcherRoot',
      '$out=[ordered]@{embedded=$embedded;launcher=$launcher}',
      '$out.none=Find-NodeRuntime @{home=$a.noNode;kind="desktop";layout="embedded"}',
      '$out.cache=Find-NodeRuntime $embedded; $out.standalone=Find-NodeRuntime $launcher',
      '$script:cmd=@{Source=$a.node}; $out.path=Find-NodeRuntime $embedded',
      '$out | ConvertTo-Json -Depth 5 -Compress',
    ])
    assert.equal(got.embedded.layout, 'embedded'); assert.equal(got.embedded.home, home)
    assert.equal(got.launcher.layout, 'launcher'); assert.equal(got.launcher.home, harness)
    assert.equal(got.none, null); assert.equal(got.cache.exe, cache); assert.equal(got.cache.runAsNode, false)
    assert.equal(got.standalone.exe, standalone); assert.equal(got.path.exe, process.execPath)
  })
  test('嵌入PS1：' + label + '实际前置桥接的动作、失败出口与环境恢复（新记录协议）', t => {
    const f = fixture(t), home = path.join(f.root, '中文 home'), desktop = path.join(f.root, 'Desktop 安装根')
    f.put(path.join(f.root, 'deploy', 'maintenance', 'target.mjs'), `import {writeFileSync} from 'node:fs';
export function options(args){
 writeFileSync(process.env.FIXTURE_RECORD,JSON.stringify({args,env:process.env.ELECTRON_RUN_AS_NODE}),'utf8');
 if(args[2].endsWith('拒绝选项'))throw Error('fixture options refused');
 return {host:'desktop',desktopLayout:'embedded',home:args[2]};
}
export function runtimeFor(op){if(op.home.endsWith('拒绝运行时'))throw Error('fixture runtime refused');return {desktop:{root:'fixture-runtime'}};}`)
    const cases = [
      { tag: 'install', action: 'install' }, { tag: 'check', action: 'check' },
      { tag: 'menu', action: '' }, { tag: 'uninstall', action: 'uninstall' },
      { tag: 'runas', action: 'install', runAsNode: true },
      { tag: '拒绝选项', action: 'install' }, { tag: '拒绝运行时', action: 'uninstall', runAsNode: true },
    ]
    const got = run(shell, f, check, { root: f.root, home, desktop, node: process.execPath, cases }, [
      '$root=$a.root; $DesktopApp=$a.desktop; $env:ELECTRON_RUN_AS_NODE="fixture-original"',
      '$out=@()',
      'foreach($case in $a.cases){',
      ' $Action=$case.action; $env:FIXTURE_RECORD=Join-Path $a.root ($case.tag+".json")',
      ' $tavern=@{home=(Join-Path $a.home $case.tag);kind="desktop";layout="unconfirmed"}',
      ' $runtime=@{exe=$a.node;runAsNode=[bool]$case.runAsNode}; $err=""',
      ' try {Assert-DesktopTarget $tavern $runtime} catch {$err=$_.Exception.Message}',
      ' $out+=@{tag=$case.tag;layout=$tavern.layout;error=$err;env=$env:ELECTRON_RUN_AS_NODE;preference=[string]$ErrorActionPreference}',
      '}',
      'ConvertTo-Json -InputObject $out -Depth 5 -Compress',
    ], { timeout: 30000 })
    for (const result of got) {
      const c = cases.find(item => item.tag === result.tag), record = JSON.parse(readFileSync(path.join(f.root, c.tag + '.json'), 'utf8'))
      assert.deepEqual(record.args, [c.action === 'install' || c.action === 'check' ? 'install' : 'uninstall', '--home', path.join(home, c.tag), '--desktop-app', desktop])
      assert.equal(record.env, c.runAsNode ? '1' : 'fixture-original')
      assert.equal(result.env, 'fixture-original'); assert.equal(result.preference, 'Stop')
      if (c.tag.startsWith('拒绝')) { assert.match(result.error, /桌面目标识别未通过/); assert.equal(result.layout, 'unconfirmed') }
      else { assert.equal(result.error, ''); assert.equal(result.layout, 'embedded') }
    }
  })
}

// 全脚本只做解析，不执行菜单/维护；捕捉新增param和函数拼接语法。
if (process.platform === 'win32') test('嵌入PS1：全入口新增声明可由PS5解析，不执行脚本', t => {
  const f = fixture(t), shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const file = path.join(f.root, 'parse-only.ps1')
  f.put(file, '$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseInput([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' + b64(src) + '\')),[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 1};Write-Output "[]"')
  const parsed = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', timeout: 8000, windowsHide: true })
  assert.ifError(parsed.error); assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr)
})

// 此前子任务的同构临时探针不是本文件门禁；本版已修截取、exe输入和记录协议并收窄到实际新增路径。
