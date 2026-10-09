// Windows CLI 新消费者：默认主进程无 VM 旗标时，必须按能力选择已有 Worker。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
const root = fileURLToPath(new URL('../', import.meta.url))

test('WinCLI runner: 默认Node无旗标选择既有Worker且真实ESM及宿主读写可用', () => {
  const selector = new URL('../lib/mvu/vm-capability.js', import.meta.url).href
  const bridge = new URL('../lib/mvu/card-runtime-bridge.js', import.meta.url).href
  const code = `
    import assert from 'node:assert/strict';
    import {selectRuntimeHost,hasInProcessVmModules} from ${JSON.stringify(selector)};
    import {createWorkerCardScriptRuntime} from ${JSON.stringify(bridge)};
    assert.equal(hasInProcessVmModules(),false);
    assert.equal(selectRuntimeHost(),'worker');
    let hp=10;
    const runtime=createWorkerCardScriptRuntime({
      cardPath:'C:/合成 Windows CLI/卡片',timeoutMs:4000,
      logger:{info(){},warn(){},error(){}},
      sources:[{name:'esm.js',kind:'esm',identifier:'card:wincli',
        code:'export const marker=await Promise.resolve(42);'},
        {name:'hook.js',code:"eventOn('PING',async()=>{await setHp(getHp()+1)})"}],
      hostApi:{getHp:()=>hp,setHp:v=>Promise.resolve().then(()=>{hp=v})}
    });
    try {
      await runtime.ready;assert.deepEqual(runtime.errors,[]);
      assert.equal(runtime.mode,'worker');
      await runtime.dispatchEvent({strict:true},'PING');
      assert.equal(hp,11);console.log(JSON.stringify({host:'worker',hp}));
    } finally {runtime.dispose();await runtime.terminate();}
  `
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (['node_options', 'electron_run_as_node'].includes(key.toLowerCase())) delete env[key]
  // 外层只给"进程整体"一个有界上限（测试侧 30s）：业务超时仍是上面 runtime 的 timeoutMs:4000，
  // 不随本行移动。原 7s 只比内部 4s 多 3s，冷启动＋并行下不足以跑完 worker ESM 探针，
  // 会以 ETIMEDOUT 把机器负载误报成业务失败（2026-10-09 全量实测 7083ms 超时）。
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.deepEqual(JSON.parse(result.stdout.trim()), { host: 'worker', hp: 11 })
})

test('WinCLI runner: 停态专用入口与每次源码写前复核，不落POSIX启停', () => {
  const runner = readFileSync(new URL('../deploy/maintenance/runner.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(runner, /Windows CLI 版安装通路尚未接线/)
  assert.match(runner, /process\.platform === 'win32' && op\.host === 'cli' && \(op\['systemd-unit'\] \|\| op\['prepare-env'\]\)/)
  for (const point of ['undo = commitRecoveredPreimage', 'source.protect(); adapter.applyStandardSeams', 'source.restore(baseline)']) {
    const at = runner.indexOf(point)
    assert.ok(at > 0)
    assert.match(runner.slice(at - 150, at), /if \(driver\.runtime\?\.windowsCli\) await driver\.assertStopped\(\)/)
  }
  const uninstall = readFileSync(new URL('../deploy/maintenance/residual-uninstall.mjs', import.meta.url), 'utf8')
  assert.match(uninstall, /if \(driver\.runtime\?\.windowsCli\) await driver\.assertStopped\(\)\s+applied = applyResidualPlan/)
})
