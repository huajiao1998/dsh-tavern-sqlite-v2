// 新 file（A 独占）：官方残留卸载计划必须保留"已接纳的新作者文案"，不得用旧 baseline 覆盖。
// 场景：真实有限官方资产 latest bare → 作者新文案（prompt 任务帧标题）→ 真实施缝（记录 before/after）→ manifest 版本变 2.5.1
//      → 官方残留卸载 fallback 计划/落地：expected 必须保留新文案与新版本，index 仅保留启动保护，own 标记归零，且不触碰任何用户业务文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'
import { planResidualUninstall, applyResidualPlan } from '../deploy/maintenance/residual-uninstall.mjs'
import { applyStandardSeams } from '../deploy/standard-seams.mjs'
import { authorImages, loadAuthorImages } from '../deploy/author-compatibility.mjs'
import { protectAuthorStartup } from '../deploy/maintenance/author-safety.mjs'

const AUTHOR_VERSION = '2.5.0'
const NEW_VERSION = '2.5.1'
const PROMPT_REL = 'tavern-plugin/lib/background-agent-task.js'
const INDEX_REL = 'tavern-plugin/lib/index.js'
const MANIFEST_REL = 'tavern-plugin/package.json'
const OLD_TITLE = '【DSH 后台任务协议（最终指令）】'
const BASE_TITLE = '【任务要求】'
const NEW_TITLE = '【新的任务要求】'
const RECEIPT = '.dsh-tavern-release.json'
const BACKUP_RE = /\.(?:pre-seams-[\w-]+\.bak|legacy-view-seams\.backup|save-ui[^/]*\.backup)$/
const RECORDS = ['.tavern-standard-seams.json', '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']

const ownMarkers = text => /dsh-tavern-(?:storage-)?sqlite(?:-v[12])?/.test(text) || text.includes('[dsh-tavern-standard-owned:v1]') || text.includes('[dsh-tavern-core-host:v1]')
const decodeImage = body => (body === null || body === undefined ? null : Buffer.from(body, 'base64'))

function materialize(appDir, image) {
  let written = 0
  for (const [rel, body] of Object.entries(image.files)) {
    if (body === null) continue
    const target = path.join(appDir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, body)
    written += 1
  }
  return written
}

test('官方卸载计划保留已接纳的新作者文案', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-residual-'))
  const appDir = path.join(root, 'app'), evidenceDir = path.join(root, 'evidence')
  mkdirSync(appDir, { recursive: true }); mkdirSync(evidenceDir, { recursive: true })
  try {
    const image = authorImages(loadAuthorImages()).filter(item => item.authorVersion === AUTHOR_VERSION).at(-1)
    assert.ok(image, '官方资产需含 ' + AUTHOR_VERSION + ' 树')
    assert.ok(materialize(appDir, image) > 20, '官方树应物化有限作者源码')

    // 作者新文案：任务帧标题（属批准的 presentation 槽位）
    const promptFile = path.join(appDir, PROMPT_REL)
    const promptRaw = readFileSync(promptFile, 'utf8')
    assert.equal(promptRaw.includes(NEW_TITLE), false, 'baseline 不应已含新标题，否则本用例无意义')
    const renamed = promptRaw.includes(OLD_TITLE) ? promptRaw.replace(OLD_TITLE, NEW_TITLE) : promptRaw.replace(BASE_TITLE, NEW_TITLE)
    assert.notEqual(renamed, promptRaw, '必须实际改到任务帧标题')
    writeFileSync(promptFile, renamed)

    // 真实施缝：记录 before/after，兼容判定接纳该 presentation
    applyStandardSeams({ appDir })

    // 作者再发版：manifest 版本变化（计划必须保留新版本，不退回 baseline）
    const manifestFile = path.join(appDir, MANIFEST_REL)
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.version = NEW_VERSION
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
    // 发布标记：强选择所属 baseline，避免"无 receipt 也绿"
    writeFileSync(path.join(appDir, RECEIPT), JSON.stringify({ commit: image.commit }) + '\n')

    const source = sourceAccess(appDir, adapter.targets)
    const snapshot = source.capture()
    const plan = planResidualUninstall({ source, adapter })

    assert.equal(plan.summary.fallback, true, '官方残留卸载必须走 fallback 计划')
    assert.equal(plan.summary.authorReceipt, image.commit, '必须按发布标记选定所属 baseline')
    const beforePrompt = decodeImage(plan.before[PROMPT_REL]).toString('utf8')
    const expectedPrompt = decodeImage(plan.expected[PROMPT_REL]).toString('utf8')
    assert.equal(beforePrompt.includes(NEW_TITLE), true, '当前源码应含新文案')
    assert.equal(expectedPrompt.includes(NEW_TITLE), true, '卸载计划必须保留已接纳的新作者文案')
    assert.equal(expectedPrompt.includes(OLD_TITLE), false, '不得回退成旧 canonical 文案')
    assert.equal(JSON.parse(decodeImage(plan.expected[MANIFEST_REL]).toString('utf8')).version, NEW_VERSION, '必须保留作者新版本')
    // 施缝后的树基本全为接管态：kept 允许为空；但计划不得报告任何归属/前像问题
    assert.deepEqual(plan.summary.notes, [], '计划不应报告无法证明/损坏的项')
    assert.ok(plan.summary.changedFiles.length > 0, '接缝文件应被撤回到作者原像')
    assert.equal(plan.summary.changed, true)
    // index 只保留"作者原像 + 启动保护"（不得从缝合态猜恢复，故对官方原像做保护后比对）
    assert.equal(decodeImage(plan.expected[INDEX_REL]).toString('utf8'), protectAuthorStartup(image.files[INDEX_REL].toString('utf8')), 'index 只保留启动保护')
    for (const rel of adapter.targets) {
      if (!rel.endsWith('.js') || rel === INDEX_REL) continue
      const expected = decodeImage(plan.expected[rel])
      if (expected === null) continue
      assert.equal(ownMarkers(expected.toString('utf8')), false, '预期卸载结果不得仍接管：' + rel)
    }
    assert.deepEqual(source.capture(), snapshot, 'plan 只读：不得改动源码（无 live copy）')
    // 维护捕获只能含有限作者目标/记录/接缝备份，绝不出现用户业务或存档文件
    const BUSINESS_RE = /(^|\/)(chats?|sessions?|originals?|cards?|worldbooks?|scene-images|saves?|data)(\/|$)|\.(?:sqlite|sqlite3|db|db-wal|db-shm|jsonl|zip)$/
    assert.equal(Object.keys(snapshot).every(rel => !BUSINESS_RE.test(rel)), true, '维护捕获不得含用户业务/存档文件')

    const applied = applyResidualPlan(source, plan, evidenceDir)
    applied.verify()
    assert.equal(readFileSync(promptFile, 'utf8').includes(NEW_TITLE), true, '落盘后新文案仍在')
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).version, NEW_VERSION, '落盘后新版本仍在')
    assert.equal(existsSync(path.join(evidenceDir, 'residual-source-before.json')), true, '应留有限写集 journal')
  } finally {
    const parent = path.dirname(root), base = path.basename(root)
    if (parent === tmpdir() && base.startsWith('tavern-residual-')) rmSync(root, { recursive: true, force: true })
  }
})
