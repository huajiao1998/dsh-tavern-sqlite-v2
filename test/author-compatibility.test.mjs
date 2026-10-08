// 单一具名断言：兼容版本（作者新版本、契约不变）首装 → 严格 check → 卸回当前作者。
// 真实有限源码（既有 8 tree 资产，摘要门禁）+ 真实标准接缝管线；只在临时目录，不碰产品/用户数据/存档。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAuthorImages, authorImages, AUTHOR_PACKAGE_REL, classifyAuthorCompatibility } from '../deploy/author-compatibility.mjs'
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

// ===== 新增（唯一具名）：新增可选删局模块仅同一可信作者前像双缺可跳 =====
// 全部用 minimal mock images（`{commit, authorVersion, files:{rel:Buffer}}`），不依赖 live 8/9 catalog；
// game body 读入库的官方 fixture（tracked），不联网、不读产品/用户数据。
test('新增可选删局模块仅同一可信作者前像双缺可跳', () => {
  const GAME_REL = 'tavern-plugin/lib/domain/game-footprint.js'
  const REQUIRED_REL = 'tavern-plugin/lib/example.js'
  const gameBody = readFileSync(new URL('./fixtures/game-footprint-68215.js', import.meta.url))
  const requiredBody = Buffer.from('export const n = 1\n')
  const manifest = Buffer.from(JSON.stringify({ name: 'dsh-tavern-plugin', version: '2.5.0' }, null, 2) + '\n')
  const image = (commit, files) => ({ commit, authorVersion: '2.5.0', files })
  const dirs = []
  const classify = (currentFiles, images) => {
    const appDir = mkdtempSync(path.join(tmpdir(), 'author-compat-optional-'))
    dirs.push(appDir)
    for (const [rel, buf] of Object.entries(currentFiles)) {
      if (!buf) continue
      const file = path.join(appDir, rel)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, buf)
    }
    return classifyAuthorCompatibility({ appDir, targets: [REQUIRED_REL, GAME_REL], images })
  }
  const base = { [REQUIRED_REL]: requiredBody, [AUTHOR_PACKAGE_REL]: manifest }
  const old = image('old-commit', { [REQUIRED_REL]: requiredBody, [AUTHOR_PACKAGE_REL]: manifest })
  const fresh = image('new-commit', { [REQUIRED_REL]: requiredBody, [AUTHOR_PACKAGE_REL]: manifest, [GAME_REL]: gameBody })
  try {
    // ① 旧 image 无 game ＋ 当前也无 game、其余同树完整 ⇒ 双缺跳过，ok
    assert.equal(classify(base, [old]).ok, true, '同树双缺应可跳过 optional')
    // ② 新 image 带官方 game body ＋ 当前同 bytes、其它 complete ⇒ ok 且 matchedCommit＝新树
    const withGame = classify({ ...base, [GAME_REL]: gameBody }, [old, fresh])
    assert.equal(withGame.ok, true, '新树带该可选文件且当前逐字节相同应通过')
    assert.equal(withGame.matchedCommit, 'new-commit', '应以覆盖全部目标的那棵 image 为匹配树')
    // ③ 安全反例（主指定，不得弱化）：当前 game 存在、而唯一比对 image（旧树）无该文件 ⇒ 拒
    assert.equal(classify({ ...base, [GAME_REL]: gameBody }, [old]).ok, false, '当前有该可选文件而比对树无，必须按作者未知拒绝')
    // ③b 追加反例：当前 game 与所有声明该文件的可信 image 都不同（未知来源）⇒ 拒
    assert.equal(classify({ ...base, [GAME_REL]: Buffer.from('export const unknown = 1\n') }, [old, fresh]).ok, false, '当前该可选文件与所有可信 image 都不同必须拒绝')
    // ④ 当前 game 缺而新 image 有该 body ⇒ 不得用另一棵补 ⇒ 拒
    assert.equal(classify(base, [fresh]).ok, false, '当前缺而比对树存在该文件不得拼合')
    // ⑤ 跨 image 拼合：A 有正确 game 但 required 错、B required 正确但无 game ⇒ 拒
    const imageA = image('a', { [REQUIRED_REL]: Buffer.from('export const n = 2\n'), [AUTHOR_PACKAGE_REL]: manifest, [GAME_REL]: gameBody })
    const imageB = image('b', { [REQUIRED_REL]: requiredBody, [AUTHOR_PACKAGE_REL]: manifest })
    assert.equal(classify({ ...base, [GAME_REL]: gameBody }, [imageA, imageB]).ok, false, '不得跨 image 拼字节')
    // ⑥ 普通 required 缺 ⇒ 仍拒
    assert.equal(classify({ [AUTHOR_PACKAGE_REL]: manifest }, [old]).ok, false, '普通受管目标缺失仍必须拒绝')
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
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
