// 只打包V2公开发布产物，不执行上传、不包含运维台账或凭据。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
const workspace = fileURLToPath(new URL('../', import.meta.url)), root = workspace
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2), values = {}
for (let i = 0; i < args.length; i += 2) { if (!['--out', '--repository', '--tag'].includes(args[i]) || !args[i + 1]) throw Error('用法：node scripts/build-release.mjs --out <新目录> [--repository owner/repo] [--tag v0.1.0]'); values[args[i].slice(2)] = args[i + 1] }
const out = path.resolve(values.out || path.join(workspace, 'dist-' + Date.now()))
if (fs.existsSync(out)) throw Error('产物目录必须不存在；不覆盖共享文件')
if (values.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository)) throw Error('仓库名不合法')
values.repository ||= 'huajiao1998/dsh-tavern-sqlite-v2'
const tag = values.tag || 'v' + pkg.version
if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw Error('tag不合法')
fs.mkdirSync(out, { recursive: true })
const packRoot = path.join(out, 'package'); fs.mkdirSync(packRoot)
const { packageFiles } = await import('../deploy/maintenance/runner.mjs')
const { assertPackageDependencies } = await import('../deploy/maintenance/driver.mjs')
const { maintenanceTargets } = await import('../deploy/standard-seams.mjs')
const { RELEASE_GUIDE, releaseManifestJson } = await import('./release-manifest.mjs')
const packFilter = rel => rel !== 'README.md' && rel !== 'INSTALL.zh-CN.md' && rel !== '安装指南.md' && rel !== 'install.log' && !rel.endsWith(path.sep + 'install.log') && !rel.startsWith('test' + path.sep)
for (const rel of packageFiles(root).filter(packFilter)) {
  const target = path.join(packRoot, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, rel), target)
}
// 产物 manifest：显式声明根安装指南（pnpm 目录打包只保留 manifest.files 内文件），且**无末尾换行**，
// 与 pnpm 重写后的实际字节一致——否则维护入口 samePackage() 会判“安装后包字节不是选定本地代”。
fs.writeFileSync(path.join(packRoot, 'package.json'), releaseManifestJson(pkg), 'utf8')
// 指南必须在**包完整性门禁之前**落盘：新 manifest 声明了它，缺失会让 packageFiles(packRoot) 直接 throw。
// 发行包不带包根 README.md：包根 README 是仓库门面，曾被安装说明覆盖。
// 包内中文文件名跨平台解码不可靠（Windows tar 默认按系统代码页写条目，曾把中文名写成乱码），
// 中文安装指南改用 ASCII 文件名，用户入口一律用它，构建门禁同时拒绝 README 回流。
fs.writeFileSync(path.join(packRoot, RELEASE_GUIDE), fs.readFileSync(path.join(root, 'deploy', 'INSTALL.md'), 'utf8'), 'utf8')
// —— 包完整性门禁（0.2.8 起，教训见 docs/workstreams/plugin/INSTALLER-BLOCKERS-2026-10-07.md）——
// 0.2.5–0.2.7 三个发行包因公开仓 .gitignore 的 `dist/` 吞掉 lib/vendor/yaml/dist/** 而缺 74 个文件，
// 用户侧安装被维护入口的 vendor 台账护栏拒绝；而我只核了“附件齐全/摘要一致”，把三个装不上的包发了出去。
// 现在：①逐文件比对源与打包结果；②跑维护入口同一道 vendor 台账校验。任一不符即构建失败，不允许出包。
{
  const expected = [...packageFiles(root).filter(packFilter), RELEASE_GUIDE], actual = packageFiles(packRoot)
  const missing = expected.filter(rel => !actual.includes(rel))
  if (missing.length) throw Error('发行包不完整：缺少 ' + missing.length + ' 个文件（例：' + missing.slice(0, 3).join('、') + '）；拒绝出包')
  assertPackageDependencies(JSON.parse(fs.readFileSync(path.join(packRoot, 'package.json'), 'utf8')), packRoot)
  // —— 阶段③门禁：块机制必需模块存在性/声明完整性 + 旧资产路径禁重流入 ——
  // 不再读旧 catalog、不要求旧 residual-uninstall 模块、不做 SHA 增量、不运行块预演（发布前检查只做存在性）。
  for (const required of [
    'deploy/standard-seams.mjs', 'deploy/standard-seam-transforms.mjs', 'deploy/comment-seam-blocks.mjs', 'deploy/comment-seam-plan.mjs',
    'deploy/comment-seam-descriptors.mjs', 'deploy/comment-seam-files.mjs', 'deploy/maintenance.mjs', 'deploy/maintenance/source.mjs',
    'deploy/maintenance/runner.mjs', 'deploy/maintenance/driver.mjs', 'deploy/maintenance/residual-assembly.mjs',
    'lib/vendor/manifest.json', 'lib/vendor/acorn/acorn.mjs',
  ]) if (!fs.existsSync(path.join(packRoot, required)) || !actual.includes(required.split('/').join(path.sep))) throw Error('发行包缺块机制必需模块/声明：' + required + '；拒绝出包')
  // 旧资产/旧模块名单（阶段③退役）：路径级拒绝，不读内容、不做摘要。
  for (const retired of ['deploy/maintenance/author-clean-images.json.gz', 'deploy/author-compatibility.mjs', 'deploy/author-rebase-plan.mjs', 'deploy/author-runtime-manifest.mjs', 'deploy/maintenance/preimage-recovery.mjs', 'deploy/maintenance/residual-uninstall.mjs']) {
    if (fs.existsSync(path.join(packRoot, retired)) || actual.includes(retired.split('/').join(path.sep))) throw Error('发行包含已退役旧资产：' + retired + '；拒绝出包')
  }
  if (!Array.isArray(maintenanceTargets) || maintenanceTargets.length < 10) throw Error('块机制有限目标清单异常（少于 10 项）：拒绝出包')
}
// 发行包不带包根 README.md：包根 README 是仓库门面，曾被安装说明覆盖。
// 包内中文文件名跨平台解码不可靠（Windows tar 默认按系统代码页写条目，曾把中文名写成乱码），
// 中文安装指南改用 ASCII 文件名，用户入口一律用它，构建门禁同时拒绝 README 回流。
// （指南已在包完整性门禁之前写盘，见上方。）
const source = fs.readFileSync(path.join(root, 'deploy', 'bootstrap.mjs'), 'utf8')
const template = fs.readFileSync(path.join(root, 'deploy', 'install.template.sh'), 'utf8')
// 替换一律用函数形式：replacement 字符串里的 $&/$` 等会被当替换模式展开
// （实测源码含正则转义 '$&' 时生成物被写坏）；函数形式杜绝一切 $ 序列解释。
const embedded = template.replace('__DSH_RELEASE_VERSION__', () => pkg.version).replace('__DSH_BOOTSTRAP_SOURCE__', () => source)
// 包内入口本地即用；联网地址由发行副本填入，避免tgz摘要自引用。
fs.writeFileSync(path.join(packRoot, 'deploy', 'install.sh'), embedded, 'utf8')
const tarball = pkg.name + '-' + pkg.version + '.tgz', result = spawnSync('tar', ['-czf', path.join(out, tarball), '-C', out, 'package'], { stdio: 'inherit', timeout: 10000, windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) throw Error('打包失败')
const digest = createHash('sha256').update(fs.readFileSync(path.join(out, tarball))).digest('hex')
const url = values.repository ? `https://github.com/${values.repository}/releases/download/${tag}/${tarball}` : '__DSH_RELEASE_URL__'
fs.writeFileSync(path.join(out, 'install.sh'), embedded.replace('__DSH_RELEASE_URL__', () => url).replace('__DSH_RELEASE_SHA256__', () => digest), 'utf8')
// —— Windows 一键包（0.2.3）：zip 顶层目录 dsh-tavern-sqlite-v2/ = 包体 + 根 install.ps1 ——
// 分发例外：zip 内 install.ps1 带 UTF-8 BOM（PowerShell 5.1 对无 BOM 脚本按 ANSI 解码，中文提示会乱码）。
// tgz 内保持无 BOM（POSIX 侧 PowerShell 7 按 UTF-8 读，且仓库源码规约是无 BOM/LF）。
const zipName = pkg.name + '-' + pkg.version + '-win.zip'
const zipStageRoot = path.join(out, 'win-zip'), zipStage = path.join(zipStageRoot, 'dsh-tavern-sqlite-v2')
fs.mkdirSync(zipStage, { recursive: true })
fs.cpSync(packRoot, zipStage, { recursive: true })
fs.writeFileSync(path.join(zipStage, 'install.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(path.join(root, 'deploy', 'install.ps1'))]))
// 双击安全入口：纯 ASCII 的 .cmd，绕过执行策略、把所有输出（含PS解析错误）落进 install.log 并总是暂停。
// 0.2.6 实测教训：有些失败在 PowerShell 脚本开始执行之前就发生（无BOM乱码、执行策略拦截），
// 那种情况脚本自己的 trap 根本跑不到，只有外层 .cmd 能留下证据并阻止窗口闪退。
fs.copyFileSync(path.join(root, 'deploy', 'run-install.cmd'), path.join(zipStage, 'run-install.cmd'))
const zipTool = spawnSync('tar', ['-a', '-cf', path.join(out, zipName), '-C', zipStageRoot, 'dsh-tavern-sqlite-v2'], { stdio: 'inherit', timeout: 30000, windowsHide: true })
if (zipTool.error || zipTool.status !== 0) {
  const alt = spawnSync('zip', ['-r', '-q', path.join(out, zipName), 'dsh-tavern-sqlite-v2'], { cwd: zipStageRoot, timeout: 30000, windowsHide: true })
  if (alt.error || alt.status !== 0) throw Error('Windows zip 打包失败：需要 bsdtar（Windows 自带 tar）或 zip 命令')
}
fs.rmSync(zipStageRoot, { recursive: true, force: true })
// zip 层逐文件核：tgz 完整不等于 zip 完整，用户装的是 zip；缺文件同样会被维护入口拒绝。
{
  const listed = spawnSync('tar', ['-tf', path.join(out, zipName)], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  if (listed.error || listed.status !== 0) throw Error('无法列出 zip 内容做完整性核验，拒绝出包')
  const inZip = new Set(listed.stdout.split(/\r?\n/).map(s => s.trim().replace(/^dsh-tavern-sqlite-v2\//, '')).filter(Boolean))
  const missing = packageFiles(packRoot).filter(rel => !inZip.has(rel.split(path.sep).join('/')))
  if (missing.length) throw Error('Windows zip 不完整：缺少 ' + missing.length + ' 个文件（例：' + missing.slice(0, 3).join('、') + '）；拒绝出包')
  for (const must of ['install.ps1', 'run-install.cmd']) if (!inZip.has(must)) throw Error('Windows zip 缺少入口：' + must + '；拒绝出包')
}
const zipDigest = createHash('sha256').update(fs.readFileSync(path.join(out, zipName))).digest('hex')
fs.writeFileSync(path.join(out, 'SHA256SUMS'), digest + '  ' + tarball + '\n' + zipDigest + '  ' + zipName + '\n', 'utf8')
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ package: pkg.name, version: pkg.version, repository: values.repository || null, tag, asset: tarball, sha256: digest, assetZip: zipName, sha256Zip: zipDigest, published: false, command: values.repository ? `curl -fsSL https://raw.githubusercontent.com/${values.repository}/main/install.sh | sh` : null }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ out, asset: tarball, sha256: digest, assetZip: zipName, sha256Zip: zipDigest, repositoryConfigured: !!values.repository, uploaded: false }))
