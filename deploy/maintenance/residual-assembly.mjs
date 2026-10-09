// 兜底装配只摘本包依赖/bundle及确切包路径；不用pnpm，不递归删除node_modules，不跟随junction。
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const stat = file => { try { return lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export function residualAssembly({ home, profileDir, packageName, evidence }) {
  const profileFile = path.join(profileDir, 'package.json'), prior = readFileSync(profileFile)
  const data = JSON.parse(prior.toString('utf8'))
  if (data.dsh?.profile?.bundles !== undefined && !Array.isArray(data.dsh.profile.bundles)) throw Error('profile bundles格式无效')
  const target = structuredClone(data)
  if (target.dependencies) delete target.dependencies[packageName]
  if (Array.isArray(target.dsh?.profile?.bundles)) target.dsh.profile.bundles = target.dsh.profile.bundles.filter(name => name !== packageName)
  const next = JSON.stringify(data) === JSON.stringify(target) ? prior : Buffer.from(JSON.stringify(target, null, 2) + '\n', 'utf8')
  const present = !!data.dependencies?.[packageName] || !!data.dsh?.profile?.bundles?.includes(packageName)
  const candidates = [path.join(profileDir, 'node_modules', packageName), path.join(home, 'plugins', packageName)]
  const paths = candidates.filter(file => stat(file)).map((file, index) => {
    // 每一层父目录必须真实存在，node_modules内只允许操作本包最终链接本身。
    for (let dir = path.dirname(file); dir.startsWith(path.resolve(home) + path.sep); dir = path.dirname(dir)) if (stat(dir)?.isSymbolicLink()) throw Error('残留装配父目录是符号链接：' + dir)
    const st = stat(file), symbolic = st.isSymbolicLink()
    if (!symbolic && !st.isDirectory()) throw Error('残留包路径不是目录/链接：' + file)
    const manifest = path.join(file, 'package.json')
    const bytes = existsSync(manifest) ? readFileSync(manifest) : null
    let name = null
    if (bytes) { try { name = JSON.parse(bytes.toString('utf8')).name } catch { if (!present) throw Error('包清单损坏且无本包装配证据：' + file) } }
    if (name && name !== packageName) throw Error('残留装配指向另一包：' + file)
    if ((!bytes || !name) && !present) throw Error('没有本包装配证据，不能认领无manifest目录：' + file)
    return { file, symbolic, link: symbolic ? readlinkSync(file) : null, manifestSha256: bytes === null ? null : sha(bytes), archive: path.join(evidence, 'residual-packages', String(index) + '-' + packageName) }
  })
  let active = false
  const moved = []
  const assertPrior = () => {
    if (!readFileSync(profileFile).equals(prior)) throw Error('兜底装配预检后profile已改变，不覆盖用户修改')
    for (const item of paths) {
      const st = stat(item.file)
      if (!st || st.isSymbolicLink() !== item.symbolic || (item.symbolic && readlinkSync(item.file) !== item.link)) throw Error('兜底装配路径身份变化：' + item.file)
      const manifest = path.join(item.file, 'package.json')
      if ((existsSync(manifest) ? sha(readFileSync(manifest)) : null) !== item.manifestSha256) throw Error('兜底装配包身份变化：' + item.file)
      if (stat(item.archive)) throw Error('残留包归档目的已存在：' + item.archive)
    }
  }
  const restore = () => {
    if (!active) return
    const current = readFileSync(profileFile)
    if (!current.equals(prior) && !current.equals(next)) throw Error('恢复时profile有外部修改，不覆盖用户配置')
    for (const item of [...moved].reverse()) {
      if (stat(item.file)) throw Error('恢复装配时本包路径已被占用，不覆盖：' + item.file)
      renameSync(item.archive, item.file)
    }
    writeFileSync(profileFile, prior)
    active = false
  }
  const verify = () => {
    if (!readFileSync(profileFile).equals(next) || paths.some(item => stat(item.file))) throw Error('兜底卸载装配残留或其他profile字节漂移')
  }
  const uninstall = () => {
    assertPrior()
    writeFileSync(path.join(evidence, 'residual-profile-before.json'), prior, { flag: 'wx', mode: 0o600 })
    active = true
    try {
      writeFileSync(profileFile, next)
      for (const item of paths) {
        mkdirSync(path.dirname(item.archive), { recursive: true })
        try {
          renameSync(item.file, item.archive)
        } catch (error) {
          throw new Error(describeArchiveFailure(error, item, paths))
        }
        moved.push(item)
      }
      verify()
    } catch (error) { restore(); throw error }
  }
  return { present: present || paths.length > 0, uninstall, restore, verify, assertPrior, profileBefore: data }
}

/**
 * 归档 rename 失败时，把"能据以排查的东西"一并抛出来。
 *
 * 只报 `EPERM: operation not permitted, rename 'A' -> 'B'` 是查不下去的：两个路径
 * 都是它自己算出来的，用户既不知道候选列表里还有谁，也不知道该往哪儿看。而这类
 * 失败的原因往往在进程之外（另一个进程占着目录、杀毒/索引在扫、目标已存在），
 * 恰恰需要这些上下文才排得动。
 *
 * 本次实测就是这种情况：从外部（PowerShell 与 Node）反复验证那两条路径**都能
 * 被移动**，只有卸载进程自己失败 —— 没有这份上下文，就只能停在"操作不允许"上。
 *
 * 只加信息，不改行为：调用方拿到异常后仍然是 restore() 整体回滚。
 */
function describeArchiveFailure(error, item, all) {
  const lines = [
    '归档残留包失败（rename 未成功，本次归档已整体回滚）：',
    `  失败项   : ${item.file}`,
    `  归档到   : ${item.archive}`,
    `  路径类型 : ${item.symbolic ? '符号链接' : '目录'}`,
    `  错误     : ${(error && error.code) || '(无 code)'} ${(error && error.message) || error}`,
    '  候选列表（按归档编号顺序）：',
  ]
  for (const p of all) {
    lines.push(`    ${p === item ? '->' : '  '} ${p.file}${p.symbolic ? `  (符号链接 -> ${p.link})` : ''}`)
  }
  lines.push(
    '  排查提示 :',
    '    - Windows 上 rename 目录被拒（EPERM / EACCES）常见三类：',
    '      · 有进程把该目录当作当前工作目录（包括通过上面的符号链接进入的）；',
    '      · 归档目的路径已存在（前置断言本应拦住，若仍失败请核对实际路径）；',
    '      · 杀毒 / 索引正在扫描该目录 —— 这类是秒级的，稍后重试通常可通过。',
    '    - 先用外部工具确认这条路径此刻能否被移动，可以最快把上面几类分开。',
    '    - 若两条路径此刻都能被外部移动，而本进程仍失败，则原因在本进程内部状态，',
    '      需要对照进程的当前工作目录来查。',
  )
  return lines.join('\n')
}
