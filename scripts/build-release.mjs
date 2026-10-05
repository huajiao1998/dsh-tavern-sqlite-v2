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
for (const rel of packageFiles(root).filter(rel => rel !== 'README.md' && !rel.startsWith('test' + path.sep))) {
  const target = path.join(packRoot, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, rel), target)
}
fs.writeFileSync(path.join(packRoot, 'package.json'), JSON.stringify({ ...pkg, files: pkg.files.filter(rel => rel !== 'test/**') }, null, 2) + '\n', 'utf8')
// 公开包README独立，不把运维README及内部台账链接带进发行包。
fs.writeFileSync(path.join(packRoot, 'README.md'), fs.readFileSync(path.join(root, 'deploy', 'INSTALL.md'), 'utf8'), 'utf8')
const source = fs.readFileSync(path.join(root, 'deploy', 'bootstrap.mjs'), 'utf8')
const template = fs.readFileSync(path.join(root, 'deploy', 'install.template.sh'), 'utf8')
const embedded = template.replace('__DSH_RELEASE_VERSION__', pkg.version).replace('__DSH_BOOTSTRAP_SOURCE__', source)
// 包内入口本地即用；联网地址由发行副本填入，避免tgz摘要自引用。
fs.writeFileSync(path.join(packRoot, 'deploy', 'install.sh'), embedded, 'utf8')
const tarball = pkg.name + '-' + pkg.version + '.tgz', result = spawnSync('tar', ['-czf', path.join(out, tarball), '-C', out, 'package'], { stdio: 'inherit', timeout: 10000 })
if (result.error) throw result.error
if (result.status !== 0) throw Error('打包失败')
const digest = createHash('sha256').update(fs.readFileSync(path.join(out, tarball))).digest('hex')
const url = values.repository ? `https://github.com/${values.repository}/releases/download/${tag}/${tarball}` : '__DSH_RELEASE_URL__'
fs.writeFileSync(path.join(out, 'install.sh'), embedded.replace('__DSH_RELEASE_URL__', url).replace('__DSH_RELEASE_SHA256__', digest), 'utf8')
fs.writeFileSync(path.join(out, 'SHA256SUMS'), digest + '  ' + tarball + '\n', 'utf8')
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ package: pkg.name, version: pkg.version, repository: values.repository || null, tag, asset: tarball, sha256: digest, published: false, command: values.repository ? `curl -fsSL https://raw.githubusercontent.com/${values.repository}/main/install.sh | sh` : null }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ out, asset: tarball, sha256: digest, repositoryConfigured: !!values.repository, uploaded: false }))
