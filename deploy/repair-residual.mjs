#!/usr/bin/env node
// 双平台兼容别名。全部目标识别、停启与有限源码/装配恢复由共用maintenance入口执行。
// 用法：node deploy/repair-residual.mjs --home <酒馆home> [--check|--apply]
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
if (!args.includes('--apply') && !args.includes('--check')) args.push('--check')
const entry = fileURLToPath(new URL('./maintenance.mjs', import.meta.url))
const result = spawnSync(process.execPath, [entry, 'uninstall', ...args], { stdio: 'inherit', windowsHide: true })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
