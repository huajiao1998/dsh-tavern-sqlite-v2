// 包装自检闸：exports 里声明的每个入口，必须真的会被打进 npm 包。
//
// 为什么要有它：`files` 白名单与 `exports` 是两份互不校验的清单，漏一个就是
// “本机 link: 部署看着好好的，打成 tgz 一装就 ERR_MODULE_NOT_FOUND”。
// 2026-09-30 实测踩中：`./rollback-layers` 声明了导出，`files` 里却没有该文件。
//
// 用法：node test/check-package.mjs   （退出码 0=全过，1=有入口打不进包）
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

// 把 npm `files` 的写法收敛成匹配函数（只支持本项目实际用到的三种形态）
function matcher(pattern) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3) + '/'
    return (rel) => rel.startsWith(prefix)
  }
  if (pattern.includes('*')) {
    const rx = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$')
    return (rel) => rx.test(rel)
  }
  // 单文件条目：npm 同时接受该路径与其目录下的内容
  return (rel) => rel === pattern || rel.startsWith(pattern + '/')
}

const rules = (pkg.files || []).map(matcher)
const packaged = (rel) => rel === 'package.json' || rules.some((rule) => rule(rel))

const targets = []
for (const [key, value] of Object.entries(pkg.exports || {})) {
  if (key.includes('*')) {
    // 通配导出：把磁盘上真实存在的文件都当成候选
    const dir = path.dirname(value)
    const ext = path.extname(value)
    const base = path.join(root, dir)
    if (existsSync(base)) {
      for (const name of readdirSync(base)) {
        if (!ext || name.endsWith(ext)) targets.push({ key: key.replace('*', path.basename(name, ext)), rel: path.posix.join(dir, name) })
      }
    }
    continue
  }
  targets.push({ key, rel: value.replace(/^\.\//, '') })
}

let failed = 0
for (const { key, rel } of targets.sort((a, b) => a.rel.localeCompare(b.rel))) {
  const onDisk = existsSync(path.join(root, rel))
  const inPack = packaged(rel)
  // 源码目录（*.js/.json）必须既存在又被打包；构建产物若尚未生成，只要会被 files 收进去即可
  const ok = onDisk && inPack
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${key.padEnd(34)} ${rel.padEnd(38)} 磁盘=${onDisk ? '有' : '无'} 进包=${inPack ? '是' : '否'}`)
}
console.log(`\n共 ${targets.length} 个导出入口，${failed} 个不进包或不存在`)
process.exit(failed === 0 ? 0 : 1)
