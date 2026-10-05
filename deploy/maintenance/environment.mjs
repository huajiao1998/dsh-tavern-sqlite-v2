// 显式环境预修（--prepare-env）：旧代残留备份隔离 + systemd单元VM旗标补齐。
// 原则不变：默认不动任何环境；只有操作员显式授权才改，且全部可回溯（备份/只移不删）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'

// 已知血统的旧代维护备份（V1卸载后实测残留三类）；不匹配通用 *.bak，防误伤作者自有文件。
const LEFTOVER_TESTS = [
  rel => /\.save-ui-seam\.backup$/.test(rel),
  rel => /\.legacy-view-seams\.backup$/.test(rel),
  rel => /\.pre-seams-[^/]*\.bak$/.test(rel),
]

/** 递归收集 app 树 tavern-plugin 下命中已知血统模式的残留备份（相对 appDir 的路径）。 */
export function findLegacyLeftovers(appDir) {
  const root = path.join(appDir, 'tavern-plugin')
  if (!existsSync(root)) return []
  const out = []
  const walk = rel => {
    for (const name of readdirSync(path.join(root, rel))) {
      const relFile = rel ? rel + '/' + name : name
      const st = lstatSync(path.join(root, relFile))
      if (st.isDirectory()) walk(relFile)
      else if (st.isFile() && LEFTOVER_TESTS.some(test => test(relFile))) out.push('tavern-plugin/' + relFile)
    }
  }
  walk('')
  return out.sort()
}

/** 隔离（只移动、不删除）到证据目录；扁平命名防冲突，返回移动清单。 */
export function quarantineLeftovers(appDir, destDir) {
  mkdirSync(destDir, { recursive: true })
  const moved = []
  for (const rel of findLegacyLeftovers(appDir)) {
    const flat = rel.split('/').join('_')
    const target = path.join(destDir, flat)
    if (existsSync(target)) throw Error('隔离目标已存在，拒绝覆盖：' + target)
    renameSync(path.join(appDir, rel), target)
    moved.push({ from: rel, to: path.basename(target) })
  }
  return moved
}

/**
 * 纯变换：给单元文本的 ExecStart 在可执行文件后插入 --experimental-vm-modules。
 * 幂等（已带旗标原样返回）；无 ExecStart 或形态不识别时拒绝（不猜测）。
 */
export function rewriteExecStartVmFlag(unitText) {
  const lines = unitText.split('\n')
  let hit = 0
  const next = lines.map(line => {
    if (!line.startsWith('ExecStart=')) return line
    hit++
    const value = line.slice('ExecStart='.length)
    if (value.includes('--experimental-vm-modules')) return line
    const match = /^(\/\S+)(\s.*)?$/s.exec(value)
    if (!match) throw Error('ExecStart形态未识别，拒绝改写：' + value.slice(0, 80))
    return 'ExecStart=' + match[1] + ' --experimental-vm-modules' + (match[2] || '')
  })
  if (hit !== 1) throw Error('单元须恰好一条ExecStart（实际 ' + hit + ' 条），拒绝改写')
  return next.join('\n')
}

/** 错误链描述：把 cause 逐层并进一条可读消息（上限3层，去重），供 result.json/控制台。 */
export function describeError(error) {
  let out = String(error && error.message || error), cause = error && error.cause, depth = 0
  while (cause && depth < 3 && cause.message && !out.includes(cause.message)) {
    out += '；原因：' + cause.message
    cause = cause.cause
    depth++
  }
  return out
}

/**
 * 残留门决策：血统残留只对**非 noop 的 install** 构成障碍（会与新一轮施缝冲突）。
 * uninstall / noop-install 下这些备份是**当前安装的自管产物**（卸载由"确切备份归档"
 * 收口移入证据目录），拦截它们会把同代卸载/幂等重装误杀——2026-10-05 188 实测踩过。
 */
export function leftoverDecision({ action, noop, prepareEnv, found }) {
  if (!found || action !== 'install' || noop) return 'allow'
  return prepareEnv ? 'quarantine' : 'refuse'
}
