// 定向闸：**裸树首装**（standard-seams 唯一验收缺口）—— 无垫片 / 无 manifest / 无标准记录的树上首装，
// 以及卸载后逐字回到首装前源码（含"垫片本来不存在 ⇒ 卸后必须仍不存在"）。
//
// 裸树从哪来（2026-10-05 换源：从"合成"改为"真·裸树"）：
//   直接解压**作者 2.5.0 固定 release tarball**（固定 SHA 5d2ffacf…，与 upstream-25-standard-consumer
//   同一来源、同一身份门），整棵 `tavern-plugin/` 拷进自有临时树。2.5.0 裸树本就没有我们任何一代缝，
//   输入即裸，因此**不再需要**按 patchIndex 反向剥离 S1/S2，也不再有"合成树"这一层不确定性。
//   · 旧法（已弃）：拿 2.4 已施缝镜像 tmp/plg-standard-1001-code/b 反向还原。它有两处硬伤：
//     ① 镜像是 2.4.0，而产品门禁 AUTHOR_VERSION 已是 2.5.0（lib/standard-host.js），fail-closed 正确拒绝；
//     ② 镜像里的历史标记是 `[dsh-tavern-storage-sqlite]`，与现行 deploy 写的 `[dsh-tavern-sqlite-v2]` 不同代。
//     旧法因此既无法通过版本门，也无法证明"2.5 裸树首装"。
//
// 本闸证明 / 不证明（写清边界，别把解压子树当上游全根工程证据）：
//   ✅ 证明：**host（S1/S2）缝的首装**在 2.5.0 真裸树上可跑通——备份保真、记录 before 里垫片为 null、
//      check ready、卸载后 index 逐字回到裸源码且两代 S1/S2 标记与垫片全部消失、零残留。
//   ❌ 不证明：legacy（原件只读/另存）缝与 save-UI 缝的**首装**（本闸只覆盖 host S1/S2 首装）。
//   ❌ 不证明：解压出的子树 === 作者 GitHub 全根工程（只拷 tavern-plugin，作者仓库其余目录不拷）。
//   缺 fixture 时打印 SKIP 正常退出（发布环境不依赖 tmp/）；**代码坏一律 throw 非零**，不静默绿。
//
// 只用 node 内置：node test/standard-bare-install.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { checkAllSeams } from '../deploy/apply-seams.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.resolve(HERE, '..')
const roots = []
// —— 裸树来源（2026-10-05 换源；原因见文件头"裸树从哪来"）——
// 用**作者 2.5.0 固定 release tarball** 解出的真·裸树，而不是拿 2.4 已施缝镜像反推。
// 与 upstream-25-standard-consumer.test.mjs 同源同法（同一 tarball、同一固定 SHA），
// 区别只在本闸只关心"首装前是裸的"这一形态，不做维护侧预演。
const FIXTURE_ROOT = path.resolve(PACKAGE, '../../tmp/upstream25-author-fixture')
const AUTHOR_SHA = '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const AUTHOR_VERSION = '2.5.0'
const TARBALL = path.join(FIXTURE_ROOT, 'dsh-tavern-' + AUTHOR_SHA + '.tar.gz')
const INDEX_REL = 'tavern-plugin/lib/index.js'
const SHIM_REL = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
const RECORD_REL = '.tavern-standard-seams.json'
const MANIFEST_REL = '.tavern-seams.json'
// 2.5 裸树**本就没有**我们这两代 S1/S2 标记：历史代 `[dsh-tavern-storage-sqlite]`（2.4 镜像里的）
// 与现行代 `[dsh-tavern-sqlite-v2]`（deploy/apply-seams.mjs 写的）都不得出现。
const LEGACY_S1_MARK = '[dsh-tavern-storage-sqlite]'
const CURRENT_S1_MARK = '[dsh-tavern-sqlite-v2]'
// 本闸只读这些消费者做首装/卸缝断言；整棵 tavern-plugin 拷贝保证转换链 include 齐全。
const FILES = [
  'tavern-plugin/package.json',
  INDEX_REL,
  'tavern-plugin/lib/client.js',
  'tavern-plugin/src/client/main.js',
  'tavern-plugin/lib/domain/round-history.js',
  'tavern-plugin/lib/domain/story-timeline.js',
  'tavern-plugin/lib/domain/model-error-presentation.js',
  'tavern-plugin/lib/domain/tavern-script-host-adapter.js',
  'tavern-plugin/lib/domain/tavern-script-dispatch.js',
  'tavern-plugin/lib/domain/server-template-runtime.js',
  'tavern-plugin/lib/domain/tavern-conversation-registry.js',
  'tavern-plugin/lib/domain/conversation-initialization.js',
  'tavern-plugin/lib/domain/session-view-reader.js',
]

const read = (app, rel) => readFileSync(path.join(app, rel), 'utf8')
const listFiles = app => {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next)
      else out.push(next)
    }
  }
  walk(app, '')
  return out
}
// 只认**我们接缝自己生成的**产物（记录 / manifest / 备份），不把作者 vendored 的
// `.gitignore`/`.yarnrc.yml`/`vendor/**/upstream/.github/**` 之类固有 dotfile 误判成残留。
// 2.5.0 整棵 tavern-plugin 拷贝带这些文件，旧"含点即残留"的判据在真裸树上不再成立。
const ARTIFACT_RE = /(?:^|\/)(?:\.tavern-[^/]+\.json|index\.js\.pre-seams-[\w-]+\.bak|[\w.-]*\.bak|[\w.-]*\.backup|[\w.-]*\.save-ui-seam\.backup)$/
const generated = app => listFiles(app).filter(rel => ARTIFACT_RE.test(rel)).sort()

/** 作者自带 dotfile 基线：卸缝后必须逐字仍在（防"把作者文件当残留删掉"）。 */
const AUTHOR_DOTFILE_RE = /(?:^|\/)\.[^/]+$|(?:^|\/)\.github\/[^/]+$/

/**
 * 从固定 2.5.0 tarball 解出一棵**自有裸树**（整棵 tavern-plugin 拷贝，保证转换链 include 齐全）。
 * 不再做 S1/S2 反向剥离：2.5.0 裸树本就没有我们任何一代缝，输入即裸，无需合成。
 */
function buildBareTree(label = 'bare') {
  const base = mkdtempSync(path.join(os.tmpdir(), 'tavern-standard-bare-' + label + '-'))
  roots.push(base)
  const unpack = path.join(base, 'unpack')
  mkdirSync(unpack, { recursive: true })
  const fired = spawnSync('tar', ['-xzf', TARBALL, '-C', unpack], { stdio: 'inherit' })
  assert.equal(fired.status, 0, '固定 2.5.0 tarball 必须可解压')
  const tops = readdirSync(unpack, { withFileTypes: true }).map(entry => entry.name)
  assert.deepEqual(tops, ['dsh-tavern-' + AUTHOR_SHA], 'tarball 必须只有一个固定 SHA 顶层目录')
  const app = path.join(base, 'app')
  cpSync(path.join(unpack, tops[0], 'tavern-plugin'), path.join(app, 'tavern-plugin'), { recursive: true })
  return app
}

if (!existsSync(TARBALL)) {
  console.log('standard-bare-install: SKIP —— 本机缺少 2.5.0 固定源码 fixture（' + TARBALL + '）；发布环境不依赖 tmp/')
  process.exit(0)
}

const app = buildBareTree()
const bareIndex = read(app, INDEX_REL)
// 作者自带 dotfile 基线（卸缝不得动它们，也不得把它们当残留）。
const authorDotfiles = listFiles(app).filter(rel => AUTHOR_DOTFILE_RE.test(rel)).sort()
try {
  // ---------- 解压裸树自证：两代 S1/S2 标记皆无、无垫片、四缝全 false、语法有效、版本 2.5.0 ----------
  assert.equal(bareIndex.includes(LEGACY_S1_MARK), false, '裸树 index 不得带历史代 S1/S2 标记')
  assert.equal(bareIndex.includes(CURRENT_S1_MARK), false, '裸树 index 不得带现行代 S1/S2 标记')
  assert.equal(bareIndex.includes("ctx.provide('tavernChats'"), false, '裸树 index 不得暴露 tavernChats')
  assert.ok(bareIndex.includes('const chatJournalStore = createChatJournalStore({'), '裸树必须是作者单行装配')
  assert.ok(bareIndex.includes("ctx.effect(() => () => chatJournalStore.flushMaintenance(),"), '裸树必须是作者 flush 行')
  assert.equal(existsSync(path.join(app, SHIM_REL)), false, '裸树不得存在 Chat 垫片')
  assert.deepEqual(checkAllSeams({ appDir: app }).state, { s1: false, s2Import: false, s2Store: false, s2Flush: false, shim: false }, '裸树四缝必须全未施')
  assert.equal(spawnSync(process.execPath, ['--check', path.join(app, INDEX_REL)]).status, 0, '解压裸树必须语法有效')
  assert.equal(JSON.parse(read(app, 'tavern-plugin/package.json')).version, AUTHOR_VERSION, '裸树必须是已适配的作者 2.5.0')
  assert.deepEqual(checkStandardSeams({ appDir: app }), { ready: false, coverage: 'standard-core', reason: '尚未标准接入' })

  // ---------- 首装：host 缝真的第一次施上（备份保真 + 记录 before 里垫片为 null）----------
  const applied = applyStandardSeams({ appDir: app })
  assert.equal(applied.changed, true)
  assert.equal(applied.ready, true)
  assert.equal(checkAllSeams({ appDir: app }).ready, true, '首装后四缝必须就绪')
  assert.equal(checkStandardSeams({ appDir: app }).ready, true)
  assert.equal(existsSync(path.join(app, MANIFEST_REL)), true, '首装必须落主缝 manifest')
  const backups = readdirSync(path.join(app, 'tavern-plugin/lib')).filter(name => /^index\.js\.pre-seams-.*\.bak$/.test(name))
  assert.equal(backups.length, 1, '首装必须留一份 index 前像备份')
  assert.equal(read(app, 'tavern-plugin/lib/' + backups[0]), bareIndex, '备份必须逐字等于首装前 index')
  assert.equal(read(app, INDEX_REL).includes(CURRENT_S1_MARK), true, '首装后 index 必须带上 S1/S2 缝')

  const record = JSON.parse(read(app, RECORD_REL))
  assert.equal(record.version, 1)
  assert.equal(record.authorVersion, AUTHOR_VERSION)
  assert.equal(record.before[INDEX_REL], Buffer.from(bareIndex, 'utf8').toString('base64'), '首装前像必须逐字记录裸 index')
  assert.equal(record.before[SHIM_REL], null, '首装前像里垫片必须是"不存在"（null），不是某份旧垫片')

  const again = applyStandardSeams({ appDir: app })
  assert.equal(again.changed, false, '首装后复跑必须幂等')

  // ---------- 卸载：逐字回到裸树；S1/S2 标记与垫片全部消失；零残留 ----------
  const removed = uninstallStandardSeams({ appDir: app })
  assert.equal(removed.changed, true)
  assert.equal(removed.requiresRestart, true)
  assert.equal(removed.restored, 'standard-generation-before-image')
  assert.equal(removed.legacySeamsRemain, false, '本 fixture 无历史 manifest ⇒ 无历史记录残留')
  assert.equal(read(app, INDEX_REL), bareIndex, '卸载必须逐字回到首装前裸源码')
  assert.equal(read(app, INDEX_REL).includes(CURRENT_S1_MARK), false, '卸载后不得残留 S1/S2 标记')
  assert.equal(read(app, INDEX_REL).includes("ctx.provide('tavernChats'"), false, '卸载后不得残留 tavernChats 服务')
  assert.equal(existsSync(path.join(app, SHIM_REL)), false, '首装前不存在的垫片，卸载后必须仍不存在')
  assert.equal(existsSync(path.join(app, MANIFEST_REL)), false, '卸载必须移除主缝 manifest')
  assert.equal(existsSync(path.join(app, RECORD_REL)), false, '卸载必须移除标准记录')
  assert.deepEqual(generated(app), [], '卸载不得留下记录 / 备份（只判接缝产物，不误伤作者 dotfile）')
  assert.deepEqual(listFiles(app).filter(rel => AUTHOR_DOTFILE_RE.test(rel)).sort(), authorDotfiles, '卸载不得动作者自带 dotfile')
  assert.deepEqual(uninstallStandardSeams({ appDir: app }), { changed: false }, '卸载复跑必须幂等')

  console.log('standard-bare-install: 裸树首装（备份保真/垫片 null 前像/逐字还原/无 S1 残留）断言全部通过')
  console.log('standard-bare-install: 边界 —— 只证明 host(S1/S2) 首装；legacy 与 save-UI 首装、以及"解压子树===作者全根工程"均未证明')
} finally {
  // roots 装的是 mkdtemp 建的自有 base 目录（换源后不再装 app 路径）；核前缀后精确删除。
  for (const base of roots) {
    assert.ok(path.basename(base).startsWith('tavern-standard-bare-'), '只删本闸自建的临时目录：' + base)
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
