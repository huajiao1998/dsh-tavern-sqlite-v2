// 仅验标准目录安装实际文件与作者真实扫描/同步；不碰用户数据，不假造扫描器。
import test from 'node:test'
import assert from 'node:assert/strict'
import fsDefault from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync, existsSync, lstatSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createStandardInstallation, uninstallOwnedRows, installOwnedRows, parsePatch, pluginDirFor, PERSISTED_ROWS, ORDINARY_ROW_ID } from '../deploy/maintenance/standard-installation.mjs'
const product = fileURLToPath(new URL('../', import.meta.url)), workspace = fileURLToPath(new URL('../../../', import.meta.url))
const author = process.env.DSH_TAVERN_TEST_AUTHOR_TREE || path.join(workspace, 'tmp/plugin-standard-migration-20261010/author-tree/dsh-tavern-7cdd287eef24ad410ecea38c20e6e63d1da8704e')
const NAME = 'dsh-tavern-sqlite-v2'
const USER = '# 用户保留的说明\n- insert:\n    - id: keep\n      name: ./keep.js\n      config:\n        userSetting: 123\n'
const rows = doc => doc.contents.items.flatMap(op => op.get?.('insert', true)?.items ?? [])
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'standard-install-actual-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('standard-install-actual-')); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), profileDir = path.join(home, 'profiles', 'tavern')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), '{"name":"dsh-profile-tavern","dependencies":{"keep":"1"},"dsh":{"profile":{"bundles":["keep"]}}}\n', 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), USER, 'utf8')
  const pluginDir = pluginDirFor({ home, packageName: NAME })
  const assembly = createStandardInstallation({ op: { home, profileDir }, adapter: { packageName: NAME }, packageRoot: product, evidence: path.join(root, 'evidence') })
  return { root, home, profileDir, pluginDir, assembly }
}
async function scanner(root) {
  const dir = path.join(root, 'author-scanner'), file = path.join(dir, 'user-plugins.mjs')
  mkdirSync(dir, { recursive: true })
  // 完整公开源逐字复制，只把它的 'yaml' 说明符解析到本包 vendored 的同代实现（只改依赖解析，不改算法）。
  const yamlEntry = pathToFileURL(path.join(product, 'lib', 'vendor', 'yaml', 'dist', 'index.js')).href
  const source = readFileSync(path.join(author, 'tavern-plugin', 'lib', 'domain', 'user-plugins.js'), 'utf8')
    .replace("from 'yaml'", "from '" + yamlEntry + "'")
  writeFileSync(file, source, 'utf8')
  return import(pathToFileURL(file).href)
}

test('标准装配：宿主peer链接失败后恢复已写profile与原位置', async t => {
  const f = fixture(t)
  const profileFile = path.join(f.profileDir, 'package.json'), patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const beforeProfile = readFileSync(profileFile), beforePatch = readFileSync(patchFile)
  const failing = createStandardInstallation({
    op: { home: f.home, profileDir: f.profileDir }, adapter: { packageName: NAME }, packageRoot: product,
    evidence: path.join(f.root, 'evidence-fail'), linkPeers: () => { throw Error('合成宿主 peer 链接失败') },
  })
  // 失败发生在装配写盘之后（profile 已被改写为 indent 输出），恢复必须回到**捕获的原字节**而不是紧凑原文。
  await assert.rejects(failing.manage('install'), /合成宿主 peer 链接失败/)
  assert.deepEqual(readFileSync(patchFile), beforePatch, 'peer 链接失败后 patch 必须原字节恢复')
  // 失败发生在已写盘之后：profile 可能被格式化重写（紧凑原文 → indent 输出），语义必须与 before 一致；
  // 半写现场（已复制的标准目录）在 restore 之前的处置由 helper 负责，本叶只核 restore 后的最终态。
  assert.deepEqual(JSON.parse(readFileSync(profileFile, 'utf8')), JSON.parse(beforeProfile.toString('utf8')), 'peer 链接失败后 profile 语义必须回到 before')
  await failing.restore()
  assert.deepEqual(readFileSync(profileFile), beforeProfile, 'restore 必须把 profile 恢复成 before 原字节')
  assert.deepEqual(readFileSync(patchFile), beforePatch, 'restore 幂等：patch 仍是原字节')
  assert.equal(existsSync(f.pluginDir), false, 'restore 后标准目录仍不存在')
})

test('标准装配：非法动作及预检后外改拒绝零写', async t => {
  const f = fixture(t)
  const profileFile = path.join(f.profileDir, 'package.json'), patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const beforeProfile = readFileSync(profileFile), beforePatch = readFileSync(patchFile)
  await assert.rejects(f.assembly.manage('oops'), /动作|action|不支持|未知/)
  assert.equal(existsSync(f.pluginDir), false, '非法动作不得写标准目录')
  assert.deepEqual(readFileSync(patchFile), beforePatch, '非法动作不得改 patch')
  assert.deepEqual(readFileSync(profileFile), beforeProfile, '非法动作不得改 profile')
  // 预检后用户在块外追加条目 ⇒ 现场已漂移，预检/manage/restore 都必须拒绝且不覆盖用户现场。
  await f.assembly.preflight('install')
  writeFileSync(patchFile, readFileSync(patchFile, 'utf8') + '- insert:\n    - id: late-user\n      name: ./late.js\n', 'utf8')
  const afterEdit = readFileSync(patchFile)
  await assert.rejects(f.assembly.preflight('install'), /外部改动|装配预检后/)
  await assert.rejects(f.assembly.manage('install'), /外部改动|装配预检后/)
  assert.deepEqual(readFileSync(patchFile), afterEdit, '拒绝时不得覆盖用户外改后的现场')
  await assert.rejects(f.assembly.restore(), /外部改动|装配预检后|无/)
  assert.deepEqual(readFileSync(patchFile), afterEdit, 'restore 拒绝后现场仍保持用户字节')
})

// a2008bf 适配：scanner 现在把普通行指向它生成的 `.tavern-entry.mjs` guard（真实入口在 guard 内 relative main），
// 因此本包"自有普通行"必须同时认这两个确切绝对路径；外部/越界同 id 行仍须拒绝。
// 公开源取自 canonical flizzywine @ a2008bf 固定 sha，仅把 `from 'yaml'` 重写到包内 vendored 解析器（不改扫描算法）。
test('标准装配：a2008bf guard 普通行归属适配且 early 与用户条目保留', async t => {
  const f = fixture(t)
  const scannerSrc = path.join(workspace, 'tmp/upstream-a2008-review-20261010/loader/user-plugins.a2008bf.js')
  assert.equal(existsSync(scannerSrc), true, '需要 canonical flizzywine@a2008bf 的公开源副本')
  const dir = path.join(f.root, 'canonical-scanner'), file = path.join(dir, 'user-plugins.mjs')
  mkdirSync(dir, { recursive: true })
  const yamlEntry = pathToFileURL(path.join(product, 'lib', 'vendor', 'yaml', 'dist', 'index.js')).href
  writeFileSync(file, readFileSync(scannerSrc, 'utf8').replace("from 'yaml'", "from '" + yamlEntry + "'"), 'utf8')
  const scanner = await import(pathToFileURL(file).href)
  // 标准目录里的普通插件文件夹：真实 manifest + 真实入口文件（不使用假 scanner）
  const pluginsDir = path.join(f.home, 'profile-data', 'tavern', 'data', 'plugins')
  const folder = path.join(pluginsDir, NAME)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: NAME, private: true, type: 'module', exports: { '.': './plugin.js' } }, null, 2) + '\n', 'utf8')
  writeFileSync(path.join(folder, 'plugin.js'), 'export const inject = []\nexport function apply() {}\n', 'utf8')
  const scanned = await scanner.scanUserPlugins(pluginsDir, { installed: () => false })
  assert.deepEqual(scanned.problems, [])
  assert.equal(scanned.plugins.length, 1)
  assert.equal(scanned.plugins[0].id, ORDINARY_ROW_ID)
  assert.equal(scanned.plugins[0].main, './plugin.js', '真实入口必须以相对 main 交给 guard')
  assert.equal(scanned.plugins[0].entry, path.join(folder, '.tavern-entry.mjs'), 'a2008bf：patch 行指向 guard 而不是 plugin.js')
  // 现场先有 early 行（本包安装器写的），再让上游 sync 写 guard 行
  const patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const seeded = installOwnedRows(readFileSync(patchFile, 'utf8'), { pluginDir: f.pluginDir, home: f.home })
  writeFileSync(patchFile, seeded.text, 'utf8')
  const before = readFileSync(patchFile, 'utf8')
  const dataRoot = path.join(f.home, 'profile-data', 'tavern', 'data')
  const synced = await scanner.syncUserPlugins({ dataRoot })
  assert.equal(synced.changed, true)
  assert.equal(readFileSync(path.join(folder, '.tavern-entry.mjs'), 'utf8'), scanner.guardSource(scanned.plugins[0]), 'guard 必须按 scanner 自己生成的文本写盘')
  const after = readFileSync(patchFile, 'utf8')
  const ids = rows(parsePatch(after)).map(row => String(row.get('id')))
  for (const row of PERSISTED_ROWS) assert.ok(ids.includes(row.id), 'early 行必须保留：' + row.id)
  assert.equal(ids.filter(id => id === ORDINARY_ROW_ID).length, 1, '普通行同 ID 只能一条')
  assert.ok(rows(parsePatch(after)).some(row => String(row.get('id')) === ORDINARY_ROW_ID && String(row.get('name')) === path.join(folder, '.tavern-entry.mjs')), '普通行必须指向 guard 绝对路径')
  assert.equal(after.includes('id: keep'), true, '用户条目必须保留')
  const again = await scanner.syncUserPlugins({ dataRoot })
  assert.equal(again.changed, false, '第二次 sync 必须无变化（同 ID 替换而非新增）')
  assert.deepEqual(readFileSync(patchFile, 'utf8'), after, '第二次 sync 不得改写 patch')
  // 适配核心：guard 形态的普通行必须被本包安装器认作自有并可撤；early 行同时撤净
  const stripped = uninstallOwnedRows(after, { pluginDir: f.pluginDir })
  assert.equal(stripped.changed, true)
  const left = rows(parsePatch(stripped.text)).map(row => String(row.get('id')))
  assert.equal(left.includes(ORDINARY_ROW_ID), false, 'guard 形态普通行必须被撤（否则 stripRows 会判外部占用并拒绝）')
  for (const row of PERSISTED_ROWS) assert.equal(left.includes(row.id), false, 'early 行必须撤净：' + row.id)
  assert.ok(stripped.text.includes('id: keep'), '用户条目必须保留')
  assert.equal(stripped.text.includes('.tavern-entry.mjs'), false, '普通行（含 guard 路径）不得残留')
  // 负例：同 id 指向本包目录之外 ⇒ 仍必须拒绝（归属判据不得放宽成目录前缀）
  const foreign = before + '- insert:\n    - id: ' + ORDINARY_ROW_ID + '\n      name: ' + path.join(f.root, 'outside', 'plugin.js') + '\n'
  assert.throws(() => uninstallOwnedRows(foreign, { pluginDir: f.pluginDir }), /其他入口占用/, '外部同 id 行必须拒绝')
})

// 归属于普通行的**严格性**：只允许 `<pluginDir>/plugin.js` 与 `<pluginDir>/.tavern-entry.mjs` 两个确切绝对路径。
// 同目录别的文件、子目录同名文件、相对路径都必须拒绝（否则"外部占用即拒"的判据形同虚设）。
test('标准装配：同目录别文件与相对路径的同 id 行仍拒绝认领', t => {
  const f = fixture(t)
  const patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const base = readFileSync(patchFile, 'utf8')
  const withRow = name => base + '- insert:\n    - id: ' + ORDINARY_ROW_ID + '\n      name: ' + name + '\n'
  const rejected = {
    '同目录别的文件': path.join(f.pluginDir, 'other.js'),
    '子目录同名文件': path.join(f.pluginDir, 'sub', 'plugin.js'),
    '相对路径': './plugin.js',
    '父目录同名文件': path.join(path.dirname(f.pluginDir), 'plugin.js'),
    '本包目录前缀相似的旁边目录': path.join(f.pluginDir + '-evil', 'plugin.js'),
  }
  for (const [label, name] of Object.entries(rejected)) {
    assert.throws(() => uninstallOwnedRows(withRow(name), { pluginDir: f.pluginDir }), /其他入口占用/, '必须拒绝：' + label)
  }
  // 两个确切归属路径必须都能撤，且不残留该行
  for (const file of ['plugin.js', '.tavern-entry.mjs']) {
    const stripped = uninstallOwnedRows(withRow(path.join(f.pluginDir, file)), { pluginDir: f.pluginDir })
    assert.equal(stripped.changed, true, '必须撤掉：' + file)
    assert.equal(rows(parsePatch(stripped.text)).some(row => String(row.get('id')) === ORDINARY_ROW_ID), false, '不得残留普通行：' + file)
    assert.ok(stripped.text.includes('userSetting: 123'), '用户条目必须保留：' + file)
  }
})

// 真生命周期：本包安装 → canonical a2008bf sync 落 guard 行 → **新 helper 实例** 卸载/重装/回读，
// 用户内容、early 行与"单份装配"都必须保持；随后在**独立 fixture** 上用 residual 三件套撤/验/恢复 guard 现场。
// （独立 fixture 是刻意的：residual 的 capture 不能跨用例漂移，否则 assertUnchanged 会误判。）
test('标准装配：a2008bf guard 真实生命周期装卸与残留恢复', async t => {
  const scannerFor = async root => {
    const src = path.join(workspace, 'tmp/upstream-a2008-review-20261010/loader/user-plugins.a2008bf.js')
    assert.equal(existsSync(src), true, '需要 canonical flizzywine@a2008bf 公开源副本')
    const dir = path.join(root, 'canonical-scanner'), file = path.join(dir, 'user-plugins.mjs')
    mkdirSync(dir, { recursive: true })
    const yamlEntry = pathToFileURL(path.join(product, 'lib', 'vendor', 'yaml', 'dist', 'index.js')).href
    writeFileSync(file, readFileSync(src, 'utf8').replace("from 'yaml'", "from '" + yamlEntry + "'"), 'utf8')
    return import(pathToFileURL(file).href)
  }
  const prepare = async (f, scanner) => {
    const pluginsDir = path.join(f.home, 'profile-data', 'tavern', 'data', 'plugins')
    const folder = path.join(pluginsDir, NAME)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: NAME, private: true, type: 'module', exports: { '.': './plugin.js' } }, null, 2) + '\n', 'utf8')
    writeFileSync(path.join(folder, 'plugin.js'), 'export const inject = []\nexport function apply() {}\n', 'utf8')
    await f.assembly.manage('install')
    assert.equal(existsSync(path.join(f.pluginDir, 'package.json')), true, '本包必须先真装进标准目录')
    const patchFile = path.join(f.profileDir, 'cordis.patch.yml'), profileFile = path.join(f.profileDir, 'package.json')
    const synced = await scanner.syncUserPlugins({ dataRoot: path.join(f.home, 'profile-data', 'tavern', 'data') })
    assert.equal(synced.changed, true, 'sync 必须写入 guard 行')
    const guardPath = path.join(folder, '.tavern-entry.mjs')
    assert.equal(existsSync(guardPath), true, 'guard 文件必须落盘')
    const guardText = readFileSync(guardPath, 'utf8'), patch = readFileSync(patchFile, 'utf8'), profile = readFileSync(profileFile)
    const ids = rows(parsePatch(patch)).map(row => String(row.get('id')))
    assert.ok(ids.includes(ORDINARY_ROW_ID) && PERSISTED_ROWS.every(row => ids.includes(row.id)), 'guard 行与 early 行必须共存')
    assert.equal(ids.filter(id => id === ORDINARY_ROW_ID).length, 1, '普通行必须恰好一份')
    assert.ok(patch.includes('userSetting: 123'), '用户条目必须保留')
    return { patchFile, profileFile, guardPath, guardText, patch, profile }
  }
  const f = fixture(t), scanner = await scannerFor(f.root)
  const a = await prepare(f, scanner)
  const fresh = createStandardInstallation({
    op: { home: f.home, profileDir: f.profileDir }, adapter: { packageName: NAME },
    packageRoot: product, evidence: path.join(f.root, 'evidence-lifecycle'), linkPeers: () => {},
  })
  assert.equal((await fresh.preflight('uninstall')).present, true, '新实例必须认出现装（标准目录 + guard 行）')
  await fresh.manage('uninstall')
  assert.equal(existsSync(f.pluginDir), false, '卸载必须撤掉标准目录')
  await fresh.manage('install')
  assert.equal(existsSync(path.join(f.pluginDir, 'package.json')), true, '重装必须回到标准目录（单份）')
  fresh.assertAssembly('install')
  const idsAfter = rows(parsePatch(readFileSync(a.patchFile, 'utf8'))).map(row => String(row.get('id')))
  // 本包装卸会撤掉自有普通行（guard 行由上游按目录重新写），early 行必须由 install 补回、用户条目绝不动。
  assert.ok(PERSISTED_ROWS.every(row => idsAfter.includes(row.id)), '装卸不得丢掉 early 行')
  assert.ok(readFileSync(a.patchFile, 'utf8').includes('userSetting: 123'), '装卸不得动用户条目')
  // 注意：本包 reinstall 用 copy 重建插件目录 ⇒ 上游生成的 guard 文件会被覆盖掉，
  // 它会由上游下一次 sync 重新写出（因此这里只断言"重装后普通行/early/用户条目都还在"，不要求 guard 立刻在场）。
  await fresh.restore()
  // 强断言：a.patch 取自 readFileSync(..., 'utf8')，这里也必须按 utf8 读回，类型一致才谈得上逐字相等。
  assert.deepEqual(readFileSync(a.patchFile, 'utf8'), a.patch, 'restore 后 patch 必须精确回到 guard 现场（utf8 字符串逐字比较）')
  assert.ok(a.patch.includes('userSetting: 123'), '现场必须含用户条目')
  assert.deepEqual(readFileSync(a.profileFile), a.profile, 'restore 后 profile 必须精确回到现场字节')
  assert.equal(existsSync(path.join(f.pluginDir, 'package.json')), true, 'restore 后本包必须回到标准目录')
  assert.deepEqual(readFileSync(a.guardPath, 'utf8'), a.guardText, 'restore 不得改写 guard 内容')
  // restore 完成后（helper 的 assertUnchanged 窗口已关闭）再让上游 sync：必须识别为"同 ID 已存在"而非新增第二份
  const resync = await scanner.syncUserPlugins({ dataRoot: path.join(f.home, 'profile-data', 'tavern', 'data') })
  const idsResync = rows(parsePatch(readFileSync(a.patchFile, 'utf8'))).map(row => String(row.get('id')))
  assert.equal(idsResync.filter(id => id === ORDINARY_ROW_ID).length, 1, 'guard 行必须恰好一份（同 ID 替换，不新增）')
  assert.ok(PERSISTED_ROWS.every(row => idsResync.includes(row.id)), 'sync 后 early 行必须仍在')
  assert.equal(resync.changed, false, 'restore 现场与上游期望一致 ⇒ 该次 sync 不应再改文件')

  // 残留三件套：独立 fixture（避免与上面 capture 互相干扰），同叶内验证 guard 现场的可撤/可验/可恢复
  const g = fixture(t), gScanner = await scannerFor(g.root)
  const b = await prepare(g, gScanner)
  // 同样必须用**新实例**：g.assembly 的 capture 早于上游 sync，直接复用会触发 assertUnchanged 误报。
  const gFresh = createStandardInstallation({
    op: { home: g.home, profileDir: g.profileDir }, adapter: { packageName: NAME },
    packageRoot: product, evidence: path.join(g.root, 'evidence-residual'), linkPeers: () => {},
  })
  const residual = gFresh.residual()
  assert.equal(residual.present, true, '标准目录在装 ⇒ residual 必须认出残留')
  assert.equal(typeof residual.verify, 'function', 'residual 必须提供 verify')
  await residual.uninstall()
  assert.equal(existsSync(g.pluginDir), false, 'residual 卸载必须撤掉标准目录')
  await residual.verify()
  assert.equal(lstatSync(b.guardPath, { throwIfNoEntry: false }), undefined, '残留撤走后 guard 也必须不在')
  await residual.restore()
  assert.deepEqual(readFileSync(b.patchFile, 'utf8'), b.patch, 'residual restore 后 patch 必须精确回到 guard 现场（utf8 字符串逐字比较，类型与 prepare 捕获一致）')
  assert.deepEqual(readFileSync(b.profileFile), b.profile, 'residual restore 后 profile 必须回到现场字节')
  assert.deepEqual(readFileSync(b.guardPath, 'utf8'), b.guardText, 'residual restore 必须把 guard 原字节放回原位')
})

test('标准装配：标准父链接越界与输入原位重装预检有界', async t => {
  const outside = mkdtempSync(path.join(tmpdir(), 'standard-install-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  mkdirSync(path.join(outside, 'guard'), { recursive: true })
  writeFileSync(path.join(outside, 'guard', 'keep.txt'), 'guard\n', 'utf8')
  const linked = fixture(t)
  mkdirSync(path.join(linked.home, 'profile-data', 'tavern', 'data'), { recursive: true })
  const pluginsLink = path.join(linked.home, 'profile-data', 'tavern', 'data', 'plugins')
  symlinkSync(outside, pluginsLink, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(linked.assembly.preflight('install'), /链接|越界|父目录|symbolic/)
  assert.deepEqual(readFileSync(path.join(outside, 'guard', 'keep.txt')), Buffer.from('guard\n'), '越界父目录不得被写入')
  assert.equal(existsSync(path.join(outside, 'dsh-tavern-sqlite-v2')), false, '越界目标下不得出现本包目录')
  // 原位重装：packageRoot 就是标准目录本身时，预检必须有限（同一现场两次等价），且装/卸仍命中同一位置。
  const base = fixture(t)
  await base.assembly.manage('install')
  const profileFile = path.join(base.profileDir, 'package.json'), patchFile = path.join(base.profileDir, 'cordis.patch.yml')
  const beforeProfile = readFileSync(profileFile), beforePatch = readFileSync(patchFile)
  const inPlace = createStandardInstallation({
    op: { home: base.home, profileDir: base.profileDir }, adapter: { packageName: NAME },
    packageRoot: base.pluginDir, evidence: path.join(base.root, 'evidence-inplace'),
  })
  const first = await inPlace.preflight('install')
  assert.deepEqual(await inPlace.preflight('install'), first, '同一现场两次预检必须等价（有界，不把目标目录当已占用）')
  await inPlace.manage('uninstall')
  await inPlace.manage('install')
  assert.equal(existsSync(path.join(base.pluginDir, 'package.json')), true, '原位重装必须命中同一标准目录')
  await inPlace.restore()
  assert.deepEqual(readFileSync(profileFile), beforeProfile, '原位重装恢复：profile 回到 before 字节')
  assert.deepEqual(readFileSync(patchFile), beforePatch, '原位重装恢复：patch 回到 before 字节')
})

// 半写证据：profile 已成功写盘、patch 首次写入即失败 ⇒ 恢复必须把两者都按原字节送回。
// 只伪造"单次真实 writeFileSync 抛错"，不伪造截断写（截断属外改拒绝路径，另测）。
test('标准装配：profile写成功而patch写失败仍恢复原字节', async t => {
  const f = fixture(t)
  const profileFile = path.join(f.profileDir, 'package.json'), patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const beforeProfile = readFileSync(profileFile), beforePatch = readFileSync(patchFile)
  await f.assembly.preflight('install') // 先 capture，before 必须在注入失败之前取好
  let injected = 0
  const original = fsDefault.writeFileSync
  t.mock.method(fsDefault, 'writeFileSync', function (file, ...rest) {
    if (injected === 0 && path.resolve(String(file)) === path.resolve(patchFile)) { injected += 1; throw Error('合成patch写入失败') }
    return original.apply(this, [file, ...rest])
  })
  syncBuiltinESMExports() // 让 helper 里 named 导入的 writeFileSync 同步到被测包装
  try {
    await assert.rejects(f.assembly.manage('install'), /合成patch写入失败/)
    assert.equal(injected, 1, '注入点必须命中 patch 的首次写入')
    const afterProfile = readFileSync(profileFile)
    assert.deepEqual(JSON.parse(afterProfile.toString('utf8')), JSON.parse(beforeProfile.toString('utf8')), 'profile 语义必须与 before 一致')
    assert.notDeepEqual(afterProfile, beforeProfile, 'profile 必须确实被写过（紧凑 fixture → 格式化输出）⇒ 本叶证的是"写成功后的恢复"')
    assert.deepEqual(readFileSync(patchFile), beforePatch, 'patch 未写成功：字节必须仍是原样')
    assert.equal(existsSync(f.pluginDir), false, 'patch 失败时尚在写配置，标准目录不得已存在')
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  await f.assembly.restore()
  assert.deepEqual(readFileSync(profileFile), beforeProfile, 'restore 后 profile 必须逐字节回到 before')
  assert.deepEqual(readFileSync(patchFile), beforePatch, 'restore 后 patch 必须逐字节回到 before')
  assert.equal(existsSync(f.pluginDir), false, 'restore 后标准目录仍不存在')
})

// 残留消费路径回归：认领依据是**显式装配证据**（profile 同名 dep，或自有 early 区块 = owned patch），
// 因此 manifest 可缺、最终链接可悬空；但 foreign manifest 与"无任何显式依据的外包目录"仍不得认领。
// 注意：悬空链接上 `existsSync` 恒为 false，判"在/不在"必须用 `lstatSync` 看链接本体。
test('标准残留：显式装配悬空链接及缺清单目录可撤且精确恢复', async t => {
  const f = fixture(t)
  const profileFile = path.join(f.profileDir, 'package.json'), patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const beforeProfile = readFileSync(profileFile), beforePatch = readFileSync(patchFile)
  const ownRoot = path.join(f.root, 'own-root'), target = path.join(ownRoot, 'missing-program')
  mkdirSync(ownRoot, { recursive: true }) // 真实自有根：故意不建 target ⇒ 最终链接悬空
  const link = path.join(f.profileDir, 'node_modules', NAME)
  mkdirSync(path.dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  const profile = JSON.parse(beforeProfile.toString('utf8'))
  profile.dependencies[NAME] = 'link:' + target.split(path.sep).join('/') // 显式 link: 装配；无 bundle ⇒ 合法半装
  writeFileSync(profileFile, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  // 消费前的现场以**注入之后**为准：helper 只会恢复到它接手时那一份字节。
  const baselineProfile = readFileSync(profileFile), baselinePatch = readFileSync(patchFile)
  assert.equal(existsSync(link), false, '悬空链接：existsSync 为 false（不得据此当不存在）')
  assert.equal(lstatSync(link).isSymbolicLink(), true, 'lstat 必须仍能看到链接本体')
  const residual = f.assembly.residual()
  assert.equal(residual.present, true, '显式同名链接即为装配证据（manifest 可缺/可悬空）')
  await residual.uninstall()
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined, '卸载后链接本体必须消失（用 lstat）')
  assert.equal(JSON.parse(readFileSync(profileFile, 'utf8')).dependencies[NAME], undefined, '同名 dep 必须撤净')
  assert.deepEqual(readFileSync(patchFile), beforePatch, '卸载不得改 patch')
  await residual.restore()
  const back = lstatSync(link, { throwIfNoEntry: false })
  assert.ok(back?.isSymbolicLink(), 'restore 必须把链接本体放回原位')
  assert.equal(readlinkSync(link), target, 'restore 必须恢复同一链接文本（悬空目标不要求存在）')
  assert.deepEqual(readFileSync(profileFile), baselineProfile, 'restore 后 profile 必须逐字节回到消费前的现场')
  assert.deepEqual(readFileSync(patchFile), baselinePatch, 'restore 后 patch 必须逐字节回到消费前的现场')
})

test('标准残留：仅自有patch仍有装配且外包目录不可认领', async t => {
  // ②-a 缺清单目录：唯一认领依据是"显式同名 profile dep"，目录里的 raw 内容必须原样去回。
  const f = fixture(t)
  const profileFile = path.join(f.profileDir, 'package.json'), patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  const beforeProfile = readFileSync(profileFile), beforePatch = readFileSync(patchFile)
  mkdirSync(f.pluginDir, { recursive: true })
  const sentinel = path.join(f.pluginDir, 'sentinel.bin')
  writeFileSync(sentinel, 'raw-keep\n', 'utf8')
  assert.equal(existsSync(path.join(f.pluginDir, 'package.json')), false, '本叶前置：目录存在但没有 manifest')
  const data = JSON.parse(beforeProfile.toString('utf8'))
  data.dependencies[NAME] = 'file:old-broken'
  writeFileSync(profileFile, JSON.stringify(data, null, 2) + '\n', 'utf8')
  const baselineProfile = readFileSync(profileFile), baselinePatch = readFileSync(patchFile) // 消费前现场＝注入之后
  const residual = f.assembly.residual()
  assert.equal(residual.present, true, '显式同名 dep 是缺清单目录的唯一认领依据')
  await residual.uninstall()
  assert.equal(existsSync(sentinel), false, '撤走后该目录内容随归档移出')
  await residual.restore()
  assert.deepEqual(readFileSync(sentinel), Buffer.from('raw-keep\n'), 'restore 必须逐字节还给原 raw 目录')
  assert.deepEqual(readFileSync(profileFile), baselineProfile, 'restore 后 profile 逐字节回到消费前现场')
  assert.deepEqual(readFileSync(patchFile), baselinePatch, 'restore 后 patch 逐字节回到消费前现场')

  // ②-b foreign manifest：即便有同名 dep，方向不符也不得认领，且不得改动任何字节。
  const g = fixture(t)
  const gProfile = path.join(g.profileDir, 'package.json')
  mkdirSync(g.pluginDir, { recursive: true })
  const foreignManifest = path.join(g.pluginDir, 'package.json')
  writeFileSync(foreignManifest, JSON.stringify({ name: 'dsh-tavern-sqlite-v1', version: '0.0.1' }) + '\n', 'utf8')
  const gData = JSON.parse(readFileSync(gProfile, 'utf8'))
  gData.dependencies[NAME] = 'file:old'
  writeFileSync(gProfile, JSON.stringify(gData, null, 2) + '\n', 'utf8')
  const foreignBefore = readFileSync(foreignManifest), gProfileBefore = readFileSync(gProfile)
  assert.throws(() => g.assembly.residual(), Error, 'foreign manifest 不得被认领为自有装配')
  assert.deepEqual(readFileSync(foreignManifest), foreignBefore, 'foreign manifest 不得被改动')
  assert.deepEqual(readFileSync(gProfile), gProfileBefore, '拒绝时不得改 profile')

  // ②-c patch-only：无同名 dep、标准目录不存在，仅自有 early 区块即构成装配证据；撤/恢复只动 patch。
  const h = fixture(t)
  const hPatch = path.join(h.profileDir, 'cordis.patch.yml'), hProfile = path.join(h.profileDir, 'package.json')
  const seeded = installOwnedRows(readFileSync(hPatch, 'utf8'), { pluginDir: h.pluginDir, home: h.home })
  assert.equal(seeded.changed, true, '本叶前置：必须真的写入自有 early 行')
  writeFileSync(hPatch, seeded.text, 'utf8')
  const hPatchBefore = readFileSync(hPatch), hProfileBefore = readFileSync(hProfile)
  assert.equal(existsSync(h.pluginDir), false, '本叶前置：标准目录并不存在')
  const hResidual = h.assembly.residual()
  assert.equal(hResidual.present, true, '自有 early 区块（owned patch）本身就是装配证据')
  await hResidual.uninstall()
  assert.equal(existsSync(h.pluginDir), false, '卸载不得凭空造出标准目录')
  await hResidual.restore()
  assert.deepEqual(readFileSync(hPatch), hPatchBefore, 'restore 必须把 patch 逐字节还给原样')
  assert.deepEqual(readFileSync(hProfile), hProfileBefore, 'restore 不得改 profile')
})

test('标准装配：真实扫描首装并保留early与他人条目', async t => {
  const f = fixture(t), upstream = await scanner(f.root)
  const beforeProfile = readFileSync(path.join(f.profileDir, 'package.json'))
  assert.equal((await f.assembly.preflight('install')).present, false)
  await f.assembly.manage('install')
  const scanned = await upstream.scanUserPlugins(path.dirname(f.pluginDir), { installed: name => existsSync(path.join(f.profileDir, 'node_modules', name, 'package.json')) })
  assert.deepEqual(scanned.problems, [])
  assert.equal(scanned.plugins.length, 1); assert.equal(scanned.plugins[0].id, ORDINARY_ROW_ID)
  assert.equal(scanned.plugins[0].entry, path.join(f.pluginDir, 'plugin.js'))
  const patchFile = path.join(f.profileDir, 'cordis.patch.yml'), installed = readFileSync(patchFile, 'utf8')
  const synced = upstream.syncPatchText(installed, scanned.plugins)
  assert.equal(typeof synced, 'string')
  const doc = parsePatch(synced), ids = rows(doc).map(row => row.get('id'))
  for (const id of [...PERSISTED_ROWS.map(row => row.id), ORDINARY_ROW_ID, 'keep']) assert.ok(ids.includes(id), id)
  assert.equal(rows(doc).find(row => row.get('id') === 'keep').get('config').get('userSetting'), 123)
  assert.equal(upstream.syncPatchText(synced, scanned.plugins), null)
  writeFileSync(patchFile, synced, 'utf8')
  const afterProfile = JSON.parse(readFileSync(path.join(f.profileDir, 'package.json'), 'utf8'))
  assert.equal(afterProfile.dependencies[NAME], undefined); assert.deepEqual(afterProfile.dsh.profile.bundles, ['keep'])
  assert.equal(existsSync(path.join(f.profileDir, 'node_modules', NAME)), false)
  const bootstrap = JSON.parse(readFileSync(path.join(f.pluginDir, 'bootstrap', 'package.json'), 'utf8'))
  assert.equal(bootstrap.dsh?.client, undefined, 'early 不能拥有第二个客户端来源')
  // 作者正常启动写普通行后，下一次维护按现场新 patch 捕获，不复用启动前快照。
  const next = createStandardInstallation({ op: f, adapter: { packageName: NAME }, packageRoot: product, evidence: path.join(f.root, 'uninstall-evidence') })
  await next.preflight('uninstall'); await next.manage('uninstall')
  assert.equal(next.assertAssembly('uninstall').present, false)
  const restored = readFileSync(patchFile, 'utf8')
  assert.deepEqual(rows(parsePatch(restored)).map(row => row.get('id')), ['keep'])
  assert.ok(restored.includes('用户保留的说明')); assert.ok(restored.includes('userSetting: 123'))
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.profileDir, 'package.json'), 'utf8')), JSON.parse(beforeProfile))
})

test('标准装配：归属冲突和双源拒绝且不改用户现场', async t => {
  const f = fixture(t)
  await f.assembly.preflight('install'); await f.assembly.manage('install')
  const patchFile = path.join(f.profileDir, 'cordis.patch.yml'), installed = readFileSync(patchFile, 'utf8')
  const foreign = installed + '- insert:\n    - id: ' + ORDINARY_ROW_ID + '\n      name: ./foreign.js\n'
  assert.throws(() => uninstallOwnedRows(foreign, { pluginDir: f.pluginDir }), /占用/)
  assert.equal(readFileSync(patchFile, 'utf8'), installed)
  const profileFile = path.join(f.profileDir, 'package.json'), pkg = JSON.parse(readFileSync(profileFile, 'utf8'))
  pkg.dependencies[NAME] = 'link:foreign'
  writeFileSync(profileFile, JSON.stringify(pkg), 'utf8')
  const before = readFileSync(profileFile)
  const conflict = createStandardInstallation({ op: f, adapter: { packageName: NAME }, packageRoot: product, evidence: path.join(f.root, 'conflict-evidence') })
  await assert.rejects(conflict.preflight('install'), /双源/)
  assert.deepEqual(readFileSync(profileFile), before)
})
