// 新增 Windows CLI 跨实例绑定及 CIM 非终止错误边界；仅合成程序元数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { windowsCliRuntimeFor } from '../deploy/maintenance/target.mjs'
import { windowsCliProcessList } from '../deploy/maintenance/process.mjs'

test('WinCLI identity: 作者树及cli标记不能归属另一个home', t => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'v2-wincli-identity-')))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-wincli-identity-')); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), foreign = path.join(root, '另一个实例'), app = path.join(home, 'apps', 'dsh-tavern')
  for (const dir of [home, foreign, app]) mkdirSync(dir, { recursive: true })
  assert.throws(() => windowsCliRuntimeFor({ home, app: foreign, host: 'cli', action: 'uninstall' }), /不属于当前 home/)
  const marker = path.join(app, '.dsh-tavern-local.json')
  for (const value of [{ host: 'cli', dshHome: foreign }, { host: 'desktop', dshHome: home }, { host: 'cli', dshHome: 'relative' }]) {
    writeFileSync(marker, JSON.stringify(value), 'utf8')
    assert.throws(() => windowsCliRuntimeFor({ home, app, host: 'cli', action: 'uninstall' }), /作者标记与当前 home 不一致/)
  }
})

test('WinCLI identity: CIM通道终止错误并固定UTF8，不能吞权限错误假报空表', () => {
  let calls = 0
  const list = windowsCliProcessList({ run: (exe, args, options) => {
    calls++
    assert.equal(exe, 'powershell')
    assert.match(args.at(-1), /\$ErrorActionPreference='Stop'/)
    assert.match(args.at(-1), /OutputEncoding=.*UTF8Encoding/)
    assert.match(args.at(-1), /Name='node\.exe'/)
    assert.equal(options.timeout, 5000)
    return '[]'
  } })
  assert.equal(calls, 1)
  assert.deepEqual(list, [])
  assert.throws(() => windowsCliProcessList({ run: () => { throw Error('CIM access denied') } }), /CIM access denied/)
})
