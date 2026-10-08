// 单一具名断言：兼容版本（作者新版本、契约不变）首装 → 严格 check → 卸回当前作者。
// 真实有限源码（既有 8 tree 资产，摘要门禁）+ 真实标准接缝管线；只在临时目录，不碰产品/用户数据/存档。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAuthorImages, authorImages, AUTHOR_PACKAGE_REL } from '../deploy/author-compatibility.mjs'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams, inspectStandardSeamsPlan } from '../deploy/standard-seams.mjs'

const RECORD = '.tavern-standard-seams.json'

test('兼容版本首装可检查并卸回当前作者', () => {
  const images = authorImages(loadAuthorImages())
  const baseline = images.at(-1)
  assert.equal(typeof baseline?.commit, 'string', '需要既有官方基线 tree')
  const appDir = mkdtempSync(path.join(tmpdir(), 'author-compat-install-'))
  try {
    for (const [rel, buf] of Object.entries(baseline.files)) {
      if (!buf) continue
      const file = path.join(appDir, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, buf)
    }
    // 作者新版本：仅 manifest 版本变化，其余与基线逐字节一致
    const pkgPath = path.join(appDir, AUTHOR_PACKAGE_REL)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.version = '2.5.1'
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    const newManifest = readFileSync(pkgPath)   // 卸载后 manifest 应与这份“本次作者原件”逐字节一致

    const applied = applyStandardSeams({ appDir, allowRebase: true })
    assert.equal(applied.changed, true, '新版本首装应实际施缝')
    const record = JSON.parse(readFileSync(path.join(appDir, RECORD), 'utf8'))
    assert.equal(record.version, 1)
    assert.equal(record.authorVersion, '2.5.1', '记录应写实际接受的作者版本')
    assert.ok(Object.keys(record.before).length > 0 && Object.keys(record.after).length > 0)

    const ready = checkStandardSeams({ appDir, allowRebase: true })
    assert.equal(ready.ready, true, '施缝后同代应就绪')
    const strictReady = checkStandardSeams({ appDir })
    assert.equal(strictReady.ready, true, '已施缝同代在严格模式也应就绪（不因新版本常量拒）')

    const uninstalled = uninstallStandardSeams({ appDir })
    assert.equal(uninstalled.changed, true, '新版本代应可卸载')
    for (const [rel, buf] of Object.entries(baseline.files)) {
      if (!buf) continue
      const expected = rel === AUTHOR_PACKAGE_REL ? newManifest : buf
      assert.ok(readFileSync(path.join(appDir, rel)).equals(expected), '作者源码未回到本次原件：' + rel)
    }
    assert.equal(JSON.parse(readFileSync(pkgPath, 'utf8')).version, '2.5.1', '卸载不得改写作者 manifest 版本')
    assert.equal(existsSync(path.join(appDir, RECORD)), false, '卸载后不应残留标准记录')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})

// 只读计划：未施缝的兼容新版本首装必须透传 compatible（driver 的版本放行来源），且不写任何文件。
test('维护计划接纳兼容新版本首装', () => {
  const baseline = authorImages(loadAuthorImages()).at(-1)
  assert.equal(typeof baseline?.commit, 'string', '需要既有官方基线 tree')
  const appDir = mkdtempSync(path.join(tmpdir(), 'author-compat-plan-'))
  try {
    for (const [rel, buf] of Object.entries(baseline.files)) {
      if (!buf) continue
      const file = path.join(appDir, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, buf)
    }
    const pkgPath = path.join(appDir, AUTHOR_PACKAGE_REL)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.version = '2.5.1'
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

    const plan = inspectStandardSeamsPlan({ appDir, authorVersion: '2.5.1' })
    assert.equal(plan.ready, false, '未施缝不得报 ready')
    assert.equal(plan.compatible?.ok, true, '兼容新版本首装必须透传 compatible（否则维护入口误拒）')
    assert.equal(plan.authorVersion, '2.5.1')
    assert.equal(plan.record, null, '未施缝不应有标准记录')
    assert.equal(existsSync(path.join(appDir, RECORD)), false, '只读计划不得写记录')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})

// —— 以下为“文案更新重接 / 作者原样重装”两条具名断言（真实 catalog 有限源码，无 SDK、无真实数据）——
function materializeFinite(appDir, baseline) {
  for (const [rel, buf] of Object.entries(baseline.files)) {
    if (!buf) continue
    const file = path.join(appDir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, buf)
  }
}
function overwriteAuthorBodies(appDir, baseline) {
  const raw = {}
  for (const [rel, buf] of Object.entries(baseline.files)) {
    if (!buf) continue
    const file = path.join(appDir, rel)
    writeFileSync(file, buf)
    raw[rel] = buf
  }
  return raw
}
function replaceOnce(appDir, rel, from, to, raw) {
  const file = path.join(appDir, rel)
  const text = readFileSync(file, 'utf8')
  assert.ok(text.includes(from), '批准文案锚点缺失：' + rel)
  const next = text.replace(from, to)
  writeFileSync(file, next, 'utf8')
  raw[rel] = Buffer.from(next, 'utf8')
}
function setAuthorVersion(appDir, version, raw) {
  const file = path.join(appDir, AUTHOR_PACKAGE_REL)
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.version = version
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  if (raw) raw[AUTHOR_PACKAGE_REL] = readFileSync(file)
}

test('兼容文案更新重接并卸回新作者文本', () => {
  const baseline = authorImages(loadAuthorImages()).at(-1)
  assert.equal(typeof baseline?.commit, 'string', '需要既有官方基线 tree')
  const owned = Object.keys(baseline.files).filter(rel => baseline.files[rel] === null)
  const appDir = mkdtempSync(path.join(tmpdir(), 'author-compat-retext-'))
  try {
    materializeFinite(appDir, baseline)
    assert.equal(applyStandardSeams({ appDir }).changed, true, '同版首装应实际施缝')
    assert.equal(checkStandardSeams({ appDir }).ready, true)

    const raw = overwriteAuthorBodies(appDir, baseline)
    replaceOnce(appDir, 'tavern-plugin/lib/background-agent-task.js', '【任务要求】', '【新的任务要求】', raw)
    // 注：批准的第二个上下文（client UI label `导入 Silly Tavern 聊天记录`）在**有限 catalog 树**里不存在
    // （该树的 lib/client.js 是作者源码客户端，label 只在构建产物中），故本断言只覆盖 prompt 文案上下文。

    const plan = inspectStandardSeamsPlan({ appDir })
    assert.equal(plan.needsReapply, true, '文案更新后应判需重接')
    assert.equal(plan.compatible?.ok, true, '批准文案差异应判契约兼容')

    assert.throws(() => uninstallStandardSeams({ appDir }), /漂移|标准|记录/, '未重接前严格卸载必须拒')
    for (const [rel, buf] of Object.entries(raw)) {
      assert.ok(readFileSync(path.join(appDir, rel)).equals(buf), '严格拒后不得改写作者字节：' + rel)
    }

    assert.equal(applyStandardSeams({ appDir }).changed, true, '兼容文案更新应真实重接')
    const record = JSON.parse(readFileSync(path.join(appDir, RECORD), 'utf8'))
    for (const rel of owned) {
      if (Object.hasOwn(record.before, rel)) assert.equal(record.before[rel], null, 'owned/artifact 前像必须为 null：' + rel)
    }
    assert.equal(checkStandardSeams({ appDir }).ready, true, '重接后严格模式应就绪')
    assert.equal(uninstallStandardSeams({ appDir }).changed, true, '重接后应可卸载')
    for (const [rel, buf] of Object.entries(raw)) {
      assert.ok(readFileSync(path.join(appDir, rel)).equals(buf), '卸后应回到新作者文本：' + rel)
    }
    assert.equal(existsSync(path.join(appDir, RECORD)), false, '卸载后不应残留标准记录')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})

test('作者原样重装可重新接入且保留当前作者版本', () => {
  const baseline = authorImages(loadAuthorImages()).at(-1)
  assert.equal(typeof baseline?.commit, 'string', '需要既有官方基线 tree')
  const appDir = mkdtempSync(path.join(tmpdir(), 'author-compat-reinstall-'))
  try {
    materializeFinite(appDir, baseline)
    setAuthorVersion(appDir, '2.5.1')
    assert.equal(applyStandardSeams({ appDir }).changed, true, '兼容新版本首装应实际施缝')
    assert.equal(checkStandardSeams({ appDir }).ready, true)

    const raw = overwriteAuthorBodies(appDir, baseline)
    setAuthorVersion(appDir, '2.5.2', raw)

    assert.equal(applyStandardSeams({ appDir }).changed, true, '作者原样重装应能重新接入')
    const record = JSON.parse(readFileSync(path.join(appDir, RECORD), 'utf8'))
    assert.equal(record.authorVersion, '2.5.2', '记录应写本次实际作者版本')
    assert.equal(checkStandardSeams({ appDir }).ready, true)
    assert.equal(uninstallStandardSeams({ appDir }).changed, true)
    for (const [rel, buf] of Object.entries(raw)) {
      assert.ok(readFileSync(path.join(appDir, rel)).equals(buf), '卸后应回到本次作者原件：' + rel)
    }
    assert.equal(existsSync(path.join(appDir, RECORD)), false, '卸载后不应残留标准记录')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})
