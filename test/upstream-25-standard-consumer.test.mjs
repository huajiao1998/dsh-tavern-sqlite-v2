// 定向闸：**上游 2.5 固定源码**作为标准消费者——真字节 apply / check / reapply / 升级记录 / install 预演 / uninstall 原字节恢复。
//
// 与 standard-seams.test.mjs、standard-bare-install.test.mjs 的关系（复用其方式，不重复其证明）：
//   · 那两个闸用的 fixture 是 tmp/plg-standard-1001-code/b 的**已施缝镜像**（2.4 代，且部分消费者靠
//     tmp/rollback-compare-1001 / tools/live-plugin-src 拼装）。本闸换成**上游 2.5 的固定 release tarball 全量源码**
//     （单一来源、整包解压、无拼装），因此它证明的是"标准接入在 2.5 真字节上成立"，而不是"在合成/拼装树上成立"。
//   · 与 upstream-25-narrow-seams.test.mjs 的关系：那个闸只把 5 个 raw 文件喂给**纯转换函数**；
//     本闸把 tarball 的 **standard 受管 targets 与必要 include** 落成真实目录树，跑完整 apply/check/uninstall。
//   · 复用方式：同样的 temp 树 + apply → check → reapply 幂等 → uninstall 逐字回原。
//
// fixture 来源与身份（写清，别把本地 tmp 当上游证据）：
//   固定 SHA 5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60（作者 v2.5.0）。signature 的**唯一权威来源**是
//   tmp/upstream25-author-fixture/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60.tar.gz 本身：
//   本闸**不读 tmp 里已解压的旧副本**，而是把该 tarball 重新解压到本闸自有 temp，再从解压根现取文件。
//   身份断言分两层：① tarball 单顶层目录 == 'dsh-tavern-<固定SHA>'（名字与字节同源）；
//   ② 一层目录里作者自带 pkg.json 与已解压 fixture 的同名文件逐字节一致（与独立第二路径的字节交叉印证）。
//   **不 npm install、不起服务、不碰真实作者 app**：本闸只从 tarball 解出受管 targets（+ 必要 include，
//   如作者 import 的 ./apply-seams 目标）到自有临时树，绝不跑作者 GitHub 全根工程。
//
// 维护侧（install / uninstall 预演）的树分离纪律：
//   · install 预演必须用**新裸副本**（另一份全新解压），否则"已施缝树"会被误当首装输入；
//   · uninstall 预演必须用**已施缝树**（另一份实跑过 apply 的树），对未施缝树的卸载预演必须失败。
//   两者都在各自副本上跑，真实树不动。
//
// 只读边界：本闸只断 sourceAccess/rehearseSource/standard-seams 的**源码合同**；
//   不证明页面、不证明运行时、不证明真实档、不证明"解压出的子树 === 作者 GitHub 全根工程"。
//   缺 fixture 时**响亮失败**（本闸是本轮定向证据，不做静默 SKIP 假装通过）。
//
// 只用 node 内置：node test/upstream-25-standard-consumer.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.resolve(HERE, '..')
const FIXTURE_ROOT = path.resolve(PACKAGE, '../../tmp/upstream25-author-fixture')
const AUTHOR_SHA = '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const AUTHOR_VERSION = '2.5.0'
const TARBALL = path.join(FIXTURE_ROOT, 'dsh-tavern-' + AUTHOR_SHA + '.tar.gz')
// 已解压 fixture：**只用于字节交叉印证**，不作为签名权威、不整棵拷贝。
const EXTRACTED_APP = path.join(FIXTURE_ROOT, 'src', 'dsh-tavern-' + AUTHOR_SHA, 'tavern-plugin')
const RECORD_REL = '.tavern-standard-seams.json'
const INDEX_REL = 'tavern-plugin/lib/index.js'
const RECORD_RELS = ['.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']
const BACKUP_RE = /(?:\.pre-seams-[\w-]+\.bak|\.legacy-view-seams\.backup|\.save-ui[^/]*\.backup)$/

const deploy = rel => pathToFileURL(path.join(PACKAGE, 'deploy', rel)).href

// —— 门 0：缺 fixture 必须响亮失败（本轮定向证据不允许静默跳过）——
if (!existsSync(TARBALL)) throw new Error('缺 2.5 固定源码 fixture（' + TARBALL + '）；本闸不做静默 SKIP')

const { maintenanceTargets } = await import(deploy('standard-seams.mjs'))
const seams = await import(deploy('standard-seams.mjs'))
const { checkAllSeams, uninstallAllSeams } = await import(deploy('apply-seams.mjs'))
const { sourceAccess, rehearseSource, assertPackageSource } = await import(deploy('maintenance/source.mjs'))
const { maintenanceAdapter } = await import(deploy('maintenance.mjs'))

const TARGETS = [...maintenanceTargets]
const ADAPTER = {
  otherHostMarker: maintenanceAdapter.otherHostMarker,
  packageName: maintenanceAdapter.packageName,
  targets: TARGETS,
  applyStandardSeams: seams.applyStandardSeams,
  checkStandardSeams: seams.checkStandardSeams,
  uninstallStandardSeams: seams.uninstallStandardSeams,
  uninstallAllSeams,
}

const roots = []
const read = (app, rel) => readFileSync(path.join(app, rel), 'utf8')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * 从固定 tarball 解出一棵**自有**作者树。
 *
 * 为什么拷整棵 `tavern-plugin/` 而不是"只挑受管 targets"（实测教训，2026-10-05）：
 *   `applyStandardSeams` 的 core 转换链会**读取受管 targets 之外**的作者模块（如 core-host-transform
 *   要在 index.js 里插 `webServerProvider` 接线，再由 rollback-sync-host 把它升级掉；链上还有
 *   apply-seams/legacy/UI 各缝共用的作者 include）。只拷 TARGETS 的子树会在链中段抛
 *   "回退同步作者锚点缺失/不唯一"，**那是拷贝不全的症状，不是 2.5 不兼容**。
 *   实测：同一 tarball 整棵 tavern-plugin 拷贝 ⇒ apply changed/ready、check pending 空、
 *   uninstall 原字节恢复全部成立。故本闸拷整棵 `tavern-plugin/`（仅其内部，不带仓库其他目录），
 *   既满足"不跑作者 GitHub 全根工程"，又保证转换链所需 include 齐全。
 * 返回 { app, root }：root = 解压根（含 tavern-plugin 的那层）。
 */
function extractTree(label) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'tavern-25-' + label + '-'))
  roots.push(base)
  const unpack = path.join(base, 'unpack')
  mkdirSync(unpack, { recursive: true })
  // 全量解压（tarball 约 13 MB / 1104 条目），再只拷 tavern-plugin 子树。
  const fired = spawnSync('tar', ['-xzf', TARBALL, '-C', unpack], { stdio: 'inherit' })
  assert.equal(fired.status, 0, '固定 tarball 必须可解压')

  // ① 单顶层目录必须是 dsh-tavern-<固定SHA>
  const tops = readdirNames(unpack)
  assert.equal(tops.length, 1, 'tarball 必须只有一个顶层目录，实际 ' + JSON.stringify(tops))
  assert.equal(tops[0], 'dsh-tavern-' + AUTHOR_SHA, 'tarball 顶层目录名必须带固定 SHA（名字与字节同源）')
  const root = path.join(unpack, tops[0])
  assert.equal(existsSync(path.join(root, 'tavern-plugin/package.json')), true, '解压根必须含作者插件包')

  // ② 只落 tavern-plugin 子树（作者仓库的 android/bin/config/presets 等一律不拷）
  const app = path.join(base, 'app')
  cpSync(path.join(root, 'tavern-plugin'), path.join(app, 'tavern-plugin'), { recursive: true })
  const picked = TARGETS.filter(rel => !RECORD_RELS.includes(rel) && existsSync(path.join(app, rel)))
  const missing = TARGETS.filter(rel => !RECORD_RELS.includes(rel) && !existsSync(path.join(app, rel)))
  return { app, root, picked, missing }
}

function readdirNames(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) out.push(entry.name)
  return out
}

/** check 源码原字节：受管 targets 前后差异，只在本任务受管 artifacts 上比较，不枚举整个仓库。 */
function managedImage(app) {
  const out = {}
  for (const rel of [...TARGETS, RECORD_REL]) {
    const file = path.join(app, rel)
    out[rel] = existsSync(file) ? digest(readFileSync(file)) : null
  }
  // 受管目录里的备份/记录产物（apply 自己生成的 .bak / manifest）
  for (const rel of RECORD_RELS) {
    const file = path.join(app, rel)
    out[rel] = existsSync(file) ? digest(readFileSync(file)) : null
  }
  return out
}
/** 受管目录里新增的接缝产物（只扫受管目录，不扫 dot/.github/.gitignore 之类仓库内容）。 */
function managedArtifacts(app) {
  const dirs = ['.', 'tavern-plugin/lib', 'tavern-plugin/lib/domain', 'tavern-plugin/lib/hooks',
    'tavern-plugin/src/client', 'tavern-plugin/src/client/features', 'tavern-plugin/src/client/ui',
    'tavern-plugin/src/client/runtime', 'tavern-plugin/src/client/modules']
  const out = []
  for (const rel of dirs) {
    const dir = path.join(app, rel)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && BACKUP_RE.test(entry.name)) out.push(path.posix.join(rel === '.' ? '' : rel, entry.name))
    }
  }
  return out.sort()
}

function run() {
  // ---------- 门 0'：sourceAccess 只接受有限目标清单（防越界遍历）----------
  {
    const { app } = extractTree('probe')
    assert.throws(() => sourceAccess(app, ['tavern-plugin/package.json']), /有限目标清单不完整/,
      '目标清单缺 lib/index 与三份历史 manifest 时必须拒绝')
    const access = sourceAccess(app, TARGETS)
    assert.throws(() => access.file('tavern-plugin/../../../etc/passwd'), /不属于有限源码维护范围|源码路径越界/,
      '越界路径必须被拒')
  }

  // ---------- ① 身份门：tarball 字节 ↔ 固定 SHA / 2.5.0 ----------
  const { app, root, picked, missing } = extractTree('consumer')
  const pkg = JSON.parse(read(app, 'tavern-plugin/package.json'))
  assert.equal(pkg.name, 'dsh-tavern-plugin', 'fixture 必须是作者插件包')
  assert.equal(pkg.version, AUTHOR_VERSION, 'fixture 必须是 2.5.0（不混旧文件叫 2.5）')
  // 字节交叉印证：解压根 pkg.json 与已解压 fixture 的同名文件逐字节一致（不是"路径里带 SHA"这种字符串证明）。
  assert.equal(existsSync(path.join(EXTRACTED_APP, 'package.json')), true, '缺已解压 fixture 的 package.json（交叉印证用）')
  assert.equal(digest(read(app, 'tavern-plugin/package.json')),
    digest(readFileSync(path.join(EXTRACTED_APP, 'package.json'))),
    'tarball 解出的作者包描述必须与已解压 fixture 逐字节一致')
  if (existsSync(path.join(EXTRACTED_APP, 'lib/index.js'))) {
    assert.equal(digest(readFileSync(path.join(app, INDEX_REL))),
      digest(readFileSync(path.join(EXTRACTED_APP, 'lib/index.js'))),
      'tarball 解出的作者主入口必须与已解压 fixture 逐字节一致')
  }
  // 受管 targets 的真实覆盖度：作者 2.5 **裸树尚无**我们这批 storage-* 垫片位与 chat-sqlite-store，
  // apply 会在受管目录里创建它们。缺失位必须**逐个**落在"我们自己的垫片"白名单内，别的缺失即清单漂移。
  const ADDED_BY_APPLY = /^tavern-plugin\/lib\/domain\/(?:chat-sqlite-store|storage-[a-z-]+|legacy-view-seams)\.js$/
  for (const rel of missing) {
    assert.match(rel, ADDED_BY_APPLY, '受管 target 缺失但不是 apply 负责创建的垫片位（清单漂移）：' + rel)
  }
  assert.ok(picked.length >= 40, '受管 targets 覆盖过少（' + picked.length + '/' + TARGETS.length + '），疑似解压不全')
  // 转换链需要受管 targets 之外的作者 include：整棵 tavern-plugin 拷贝后必须齐全（实测教训见 extractTree 注释）
  for (const rel of ['tavern-plugin/lib/index.js', 'tavern-plugin/src/client/main.js', 'tavern-plugin/lib/client.js',
    'tavern-plugin/lib/http/routes.js']) {
    assert.equal(existsSync(path.join(app, rel)), true, '转换链必需 include 缺失：' + rel)
  }
  console.log('① 身份门通过：tarball 顶层 dsh-tavern-' + AUTHOR_SHA + ' / ' + AUTHOR_VERSION
    + ' / 受管 targets ' + picked.length + '/' + TARGETS.length + '（apply 待创建 ' + missing.length + ' 个垫片位）')

  // ---------- ② apply：2.5 真字节上标准接入成立 ----------
  const pristine = Object.fromEntries(picked
    .filter(rel => existsSync(path.join(app, rel)))
    .map(rel => [rel, readFileSync(path.join(app, rel))]))
  const beforeAll = checkAllSeams({ appDir: app })
  assert.equal(beforeAll.ready, false, '未接入时不得 ready')
  assert.deepEqual(seams.checkStandardSeams({ appDir: app }),
    { ready: false, coverage: 'standard-core', reason: '尚未标准接入' })

  const applied = seams.applyStandardSeams({ appDir: app })
  assert.equal(applied.changed, true, '2.5 首装必须真的写入')
  assert.equal(applied.ready, true, '2.5 首装必须 ready')
  assert.equal(applied.coverage, 'standard-core')
  assert.equal(existsSync(path.join(app, RECORD_REL)), true, '首装必须落标准记录')

  const record = JSON.parse(read(app, RECORD_REL))
  assert.equal(record.version, 1)
  assert.equal(record.authorVersion, AUTHOR_VERSION, '升级记录必须如实写 2.5.0（不是 2.4.0）')
  assert.ok(record.before && record.after, '升级记录必须同时有前像与后像')

  // 每个受管消费者都必须有前像；前像必须逐字等于施缝前的真字节（原字节恢复的材料）
  for (const rel of Object.keys(pristine)) {
    if (!Object.hasOwn(record.before, rel)) continue
    const body = record.before[rel]
    if (body === null) continue
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), pristine[rel].toString('utf8'),
      '升级记录前像必须逐字等于施缝前源码：' + rel)
  }
  // 后像哈希必须与落盘一致（漂移检测的材料）
  for (const [rel, hash] of Object.entries(record.after)) {
    assert.equal(digest(readFileSync(path.join(app, rel))), hash, '升级记录后像必须与落盘一致：' + rel)
  }
  console.log('② apply 通过：changed/ready/记录 2.5.0/前像逐字/后像哈希一致')

  // ---------- ③ check ready 且 pending 空 ----------
  const checked = seams.checkStandardSeams({ appDir: app })
  assert.equal(checked.ready, true, JSON.stringify(checked))
  assert.deepEqual(checked.pending, [], '2.5 上核心文件必须与当前转换逐字一致（pending 空）')
  assert.equal(checkAllSeams({ appDir: app }).ready, true, '四缝必须全就绪')

  // ---------- ④ reapply 幂等 ----------
  const again = seams.applyStandardSeams({ appDir: app })
  assert.equal(again.changed, false, '复跑必须幂等')
  assert.equal(again.ready, true)
  console.log('③④ check/reapply 通过：ready + pending 空 + 幂等')

  // ---------- ⑤ sourceAccess / assertPackageSource 在已施缝树上成立 ----------
  const access = sourceAccess(app, TARGETS)
  assertPackageSource(access, ADAPTER)
  const installedImage = managedImage(app)
  assert.equal(installedImage[RECORD_REL] !== null, true, '已施缝树必须有标准记录')

  // 写前拒：unknown / 缺锚 / 漂移三类都必须抛，且抛后受管文件字节不变（拒绝=不写）。
  const drifted = (() => {
    const copy = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-25-drift-')), 'app')
    roots.push(path.dirname(copy))
    cpSync(app, copy, { recursive: true })
    return copy
  })()
  const driftedIndex = path.join(drifted, INDEX_REL)
  writeFileSync(driftedIndex, readFileSync(driftedIndex, 'utf8') + '\n// drift\n', 'utf8')
  const driftImage = managedImage(drifted)
  assert.throws(() => assertPackageSource(sourceAccess(drifted, TARGETS), ADAPTER), /漂移/,
    '受管文件漂移必须在写前拒绝')
  assert.throws(() => seams.applyStandardSeams({ appDir: drifted }), /漂移|作者更新不兼容/,
    'apply 对漂移树必须在写前拒绝（兼容重接分支不得吞掉不匹配）')
  assert.deepEqual(managedImage(drifted), driftImage, '拒绝必须不写：漂移树受管字节与 apply 前逐字一致')
  assert.equal(existsSync(path.join(drifted, RECORD_REL)), true, '拒绝必须保留原标准记录（不清也不改）')

  const wrongVersion = (() => {
    const copy = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-25-ver-')), 'app')
    roots.push(path.dirname(copy))
    cpSync(app, copy, { recursive: true })
    return copy
  })()
  const verPkgPath = path.join(wrongVersion, 'tavern-plugin/package.json')
  const verPkg = JSON.parse(readFileSync(verPkgPath, 'utf8'))
  writeFileSync(verPkgPath, JSON.stringify({ ...verPkg, version: '2.4.9' }, null, 2) + '\n', 'utf8')
  const verImage = managedImage(wrongVersion)
  assert.equal(seams.checkStandardSeams({ appDir: wrongVersion }).ready, true,
    '同代接缝仅版号变化（数字不是契约证据）应严格就绪')
  assert.deepEqual(managedImage(wrongVersion), verImage, '只读检查不得改字节：版号变化树受管字节与检查前逐字一致')
  console.log('⑤ 只读检查通过：同代仅版号变化仍严格就绪；漂移树拒绝且不改字节（records 与靶文件原样）')

  // ---------- ⑥ 维护侧 install 预演：**新裸副本**，不得拿已施缝树 ----------
  const evidenceDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-25-rehearse-')), 'evidence')
  mkdirSync(evidenceDir, { recursive: true })
  roots.push(path.dirname(evidenceDir))
  const bare = extractTree('bare')
  const bareAccess = sourceAccess(bare.app, TARGETS)
  assertPackageSource(bareAccess, ADAPTER)   // 裸树无记录：应直接通过（不是"缺前像"）
  const bareImage = managedImage(bare.app)
  assert.equal(bareImage[RECORD_REL], null, 'install 预演输入必须是裸树（无标准记录）')
  const rehearsal = rehearseSource('install', bareAccess, ADAPTER, evidenceDir)
  assert.equal(rehearsal.result.ready, true, '维护侧 install 预演必须 ready')
  assert.equal(rehearsal.result.changed, true, '裸副本 install 预演必须真的写入')
  assert.equal(managedImage(bare.app)[RECORD_REL], null, 'install 预演不得改动输入树')
  assert.deepEqual(managedImage(bare.app), bareImage, 'install 预演必须不触碰输入裸树的受管字节')
  // 预演树（rehearsal/）自证：真的 ready，且是"预演副本"而不是原树
  const rehearsalApp = path.join(evidenceDir, 'rehearsal')
  assert.equal(seams.checkStandardSeams({ appDir: rehearsalApp }).ready, true, '预演副本必须真的 ready')
  console.log('⑥ rehearseSource(install) 通过：裸副本预演 ready（输入裸树字节未动）')

  // ---------- ⑦ 维护侧 uninstall 预演：**已施缝树**；未施缝树的卸载预演必须失败 ----------
  const unEvidence = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-25-unrehearse-')), 'evidence')
  mkdirSync(unEvidence, { recursive: true })
  roots.push(path.dirname(unEvidence))
  const installed = app   // 本闸 ② 已实跑过 apply 的那棵树
  const unRehearsal = rehearseSource('uninstall', sourceAccess(installed, TARGETS), ADAPTER, unEvidence)
  // 真实返回契约（实测）：outcome = uninstallAllSeams 的结果 {restored, mainRestored, hadMainManifest}，**无 changed 字段**；
  // 且预演树先 restore(before) 再卸，故 hadMainManifest 反映的是"预演副本上还有没有主缝 manifest"，
  // 不能用它当"真的卸了"的判据。判据取 expected 像 + 预演副本现场：
  assert.equal(Object.hasOwn(unRehearsal.result, 'outcome'), true, '卸载预演必须返回 outcome')
  assert.equal(unRehearsal.result.data, '用户数据未访问、未删除、未转换', '卸载预演必须声明未触碰用户数据')
  assert.equal(unRehearsal.expected[RECORD_REL], null, '卸载预演后的期望像里标准记录必须归 null')
  for (const rel of RECORD_RELS) assert.equal(unRehearsal.expected[rel], null, '预演卸载清除自有记录：' + rel)
  for (const [rel, body] of Object.entries(pristine)) {
    if (rel === INDEX_REL) continue // 维护卸载明确保留作者启动安全guard，与标准卸缝逐字恢复分开验。
    assert.equal(unRehearsal.expected[rel], body.toString('base64'), '预演卸载保留作者源码：' + rel)
  }
  assert.deepEqual(managedArtifacts(path.join(unEvidence, 'rehearsal')), [], '预演卸载无自有备份残留')
  assert.equal(managedImage(installed)[RECORD_REL] !== null, true, '卸载预演不得改动输入已施缝树')
  assert.equal(existsSync(path.join(unEvidence, 'rehearsal', RECORD_REL)), false,
    '预演副本卸载后不得留下标准记录')
  // 未施缝树（裸）的卸载预演必须响亮拒绝，不许静默当"已卸载"
  const bareUnEvidence = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-25-bareun-')), 'evidence')
  mkdirSync(bareUnEvidence, { recursive: true })
  roots.push(path.dirname(bareUnEvidence))
  assert.throws(() => rehearseSource('uninstall', sourceAccess(bare.app, TARGETS), ADAPTER, bareUnEvidence),
    /卸载缺标准记录|标准记录/,
    '未施缝树的卸载预演必须失败（不猜整包已卸载）')
  console.log('⑦ rehearseSource(uninstall) 通过：已施缝树预演卸净；裸树卸载预演响亮拒绝')

  // ---------- ⑧ 失败回滚：注入一处语法错误，apply 必须整体回滚且不落记录 ----------
  const broken = extractTree('broken').app
  const brokenImage = managedImage(broken)
  const brokenIndex = path.join(broken, INDEX_REL)
  // 注入**具体语法错误**（不是"文件不存在"这类形态错误）：主入口末尾追加未闭合块。
  writeFileSync(brokenIndex, readFileSync(brokenIndex, 'utf8') + '\nfunction __dshSyntaxProbe() {\n', 'utf8')
  assert.notEqual(spawnSync(process.execPath, ['--check', brokenIndex]).status, 0, '注入的确实是语法错误')
  // 只回滚"本次写入"，断言：抛错 + 无标准记录 + 受管字节回到注入后即 apply 前
  const brokenBefore = managedImage(broken)
  assert.throws(() => seams.applyStandardSeams({ appDir: broken }), /标准接入失败，已恢复本次源码前像/,
    '语法错误必须在写前/写中拒绝并整体回滚')
  assert.equal(existsSync(path.join(broken, RECORD_REL)), false, '回滚必须不落标准记录')
  assert.deepEqual(managedImage(broken), brokenBefore, '回滚后受管字节必须等于 apply 前（本次写入已撤）')
  assert.notEqual(brokenImage[INDEX_REL], brokenBefore[INDEX_REL], '注入本身确实改过字节（对照）')
  console.log('⑧ 失败回滚通过：语法错误拒绝 + 不落记录 + 本次写入已撤')

  // ---------- ⑨ uninstall：原字节逐字恢复 ----------
  const removed = seams.uninstallStandardSeams({ appDir: app })
  assert.equal(removed.changed, true)
  assert.equal(removed.requiresRestart, true)
  assert.equal(removed.restored, 'standard-generation-before-image')
  for (const [rel, body] of Object.entries(pristine)) {
    if (!Object.hasOwn(record.before, rel) || record.before[rel] === null) continue
    assert.equal(read(app, rel), body.toString('utf8'), '卸载必须逐字恢复原字节：' + rel)
  }
  assert.equal(existsSync(path.join(app, RECORD_REL)), false, '卸载必须移除标准记录')
  // 零残留：只看**本任务受管 artifacts 前后差异**，不枚举 .github/.gitignore 之类仓库内容。
  assert.deepEqual(managedArtifacts(app), [], '卸载不得留下本任务受管目录里的备份产物')
  for (const rel of RECORD_RELS) assert.equal(existsSync(path.join(app, rel)), false, '卸载必须清历史 manifest：' + rel)
  assert.deepEqual(seams.uninstallStandardSeams({ appDir: app }), { changed: false }, '卸载复跑必须幂等')
  // check 源码原字节：卸载后每个受管 target 必须逐字回到 pristine（不是"整体生成物为空"这种盲目断言）
  for (const rel of Object.keys(pristine)) {
    assert.equal(digest(readFileSync(path.join(app, rel))), digest(pristine[rel]),
      '卸载后受管源码必须逐字回到 2.5 原字节：' + rel)
  }
  // 原字节恢复后，作者主入口必须语法有效（不是恢复了半截）
  assert.equal(spawnSync(process.execPath, ['--check', path.join(app, INDEX_REL)]).status, 0,
    '原字节恢复后作者主入口必须语法有效')
  console.log('⑨ uninstall 通过：原字节逐字恢复 + 记录清零 + 受管无残留 + 语法有效')

  console.log('upstream-25-standard-consumer: 2.5 固定源码 consumer 断言全部通过')
  console.log('upstream-25-standard-consumer: 边界 —— 只证明源码合同（apply/check/reapply/记录/install+uninstall 预演/失败回滚/卸载原字节）；不证明页面/运行时/真实档，也不证明解压子树 === 作者 GitHub 全根工程')
}

try {
  run()
} finally {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* 清理失败不影响结论 */ }
  }
}
