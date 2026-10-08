// author-runtime-manifest（local-manifest 验证器）具名断言。
// 范围：只测本模块 validateRuntimeManifest 的**接口语义与安全边界**；真实 fs（自有 mkdtemp）、
//   真实随包目录 images（需要判定 owned 的两条）＋最小明确构造（其余负例）。
// 不联网、不写冻结 gz、不读真实档；只清本文件自建 mkdtemp。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  validateRuntimeManifest, isCanonicalRel,
  RUNTIME_MANIFEST_REL, RUNTIME_MANIFEST_MAX_BYTES, AUTHOR_PACKAGE_REL, OWN_CODE_MARKERS
} from '../deploy/author-runtime-manifest.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const PKG_REL = AUTHOR_PACKAGE_REL
const X_REL = 'tavern-plugin/lib/domain/x-probe.js'
const OPTIONAL_REL = 'tavern-plugin/lib/domain/game-footprint.js'
const OWNED_REL = 'tavern-plugin/lib/domain/storage-native-data.js'
const AUTHOR_REL = 'tavern-plugin/lib/domain/background-task-coordinator.js'
const GZ = new URL('../deploy/maintenance/author-clean-images.json.gz', import.meta.url)
const REV = 'a'.repeat(40)

/** 自有 mkdtemp 目录（测试专用；after 精确删除本目录）。 */
function app(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'author-runtime-manifest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const write = (rel, content) => { const file = path.join(dir, ...rel.split('/')); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content) }
  return { dir, write }
}
const entryOf = (rel, bytes) => ({ path: rel, sha256: sha(bytes), size: bytes.length })
const manifestBytes = ({ files, schemaVersion = 2, revision = REV, releaseSequence = 548, version = '2.5.0' }) =>
  Buffer.from(JSON.stringify({ schemaVersion, revision, releaseSequence, version, files }), 'utf8')
const PKG = Buffer.from(JSON.stringify({ name: 'dsh-tavern-plugin', version: '2.5.0' }), 'utf8')
/** 最小明确构造的随包 images：给定 rel 均有正文（⇒ 不判 owned）。 */
const imagesWith = rels => [{ commit: 'b'.repeat(40), authorVersion: '2.5.0', files: Object.fromEntries(rels.map(rel => [rel, Buffer.from('author-bytes')])) }]
const projectionOf = map => new Map(Object.entries(map))
/** 真实随包目录 images（用于 owned 判定那两条）。 */
const realImages = async () => {
  const { loadAuthorImages, authorImages } = await import('../deploy/author-compatibility.mjs')
  return authorImages(loadAuthorImages())
}

test('清单验证提供bytes与投影时完全不读现场清单', async t => {
  const f = app(t)
  // 现场塞一个"陷阱清单"：内容/摘要都与传入 bytes 不同
  f.write(RUNTIME_MANIFEST_REL, manifestBytes({ files: [entryOf(X_REL, Buffer.from('trap'))], revision: 'c'.repeat(40), version: '9.9.9' }))
  const good = Buffer.from('author-bytes')
  const bytes = manifestBytes({ files: [entryOf(X_REL, good), entryOf(PKG_REL, PKG)] })
  const result = validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL, PKG_REL], images: imagesWith([X_REL, PKG_REL]),
    projection: projectionOf({ [X_REL]: good, [PKG_REL]: PKG }), manifestBytes: bytes
  })
  assert.equal(result.ok, true, '提供 bytes + 投影时必须通过（不读现场）：' + JSON.stringify(result.failures))
  assert.equal(result.witness.sha256, sha(bytes), 'witness.sha256 必须等于传入 bytes 的摘要')
  assert.equal(result.witness.revision, REV, 'witness.revision 取传入 bytes 的 revision（不取现场陷阱清单）')
  assert.equal(result.witness.version, '2.5.0')
  assert.deepEqual(result.witness.targets[X_REL], { sha256: sha(good), size: good.length }, 'witness.targets 只含摘要/尺寸，无 body')
  assert.equal(result.image.commit, REV)
  assert.equal(result.image.source, 'local-runtime-manifest')
  assert.equal(Buffer.isBuffer(result.image.files[X_REL]), true, 'image.files 给通过校验的 Buffer')
  // 同一目录不传 bytes 时读到的是陷阱清单 ⇒ 结果必不同（反证 bytes 优先且现场确有清单）
  const offline = validateRuntimeManifest({ appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: good }) })
  assert.equal(offline.ok, false, '不传 bytes 时用现场陷阱清单 ⇒ 摘要不符而失败')
  assert.equal(offline.witness.revision, 'c'.repeat(40), '现场清单 revision 被读到（证明上一条确实没读现场）')
})

test('清单验证顶层schema与身份字段非法即拒', async t => {
  const f = app(t)
  const good = Buffer.from('author-bytes')
  const files = [entryOf(X_REL, good), entryOf(PKG_REL, PKG)]
  const run = manifestBytesValue => validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL, PKG_REL], images: imagesWith([X_REL, PKG_REL]),
    projection: projectionOf({ [X_REL]: good, [PKG_REL]: PKG }), manifestBytes: manifestBytesValue
  })
  const cases = [
    ['schemaVersion 未知', manifestBytes({ files, schemaVersion: 3 }), /schemaVersion/],
    ['revision 非 40hex', manifestBytes({ files, revision: 'XYZ' }), /revision/],
    ['revision 大写', manifestBytes({ files, revision: 'A'.repeat(40) }), /revision/],
    ['releaseSequence 0', manifestBytes({ files, releaseSequence: 0 }), /releaseSequence/],
    ['releaseSequence 非整数', manifestBytes({ files, releaseSequence: 1.5 }), /releaseSequence/],
    ['version 空', manifestBytes({ files, version: '  ' }), /version/],
    ['files 空数组', manifestBytes({ files: [] }), /files/],
    ['根是数组', Buffer.from('[]', 'utf8'), /清单根不是对象/],
    ['非 JSON', Buffer.from('{oops', 'utf8'), /不是合法 JSON/]
  ]
  for (const [label, bytes, pattern] of cases) {
    const result = run(bytes)
    assert.equal(result.ok, false, label + ' 必须 ok:false')
    assert.ok(result.failures.some(item => pattern.test(item)), label + ' 必须给出对应失败原因：' + JSON.stringify(result.failures))
  }
})

test('清单验证路径规范重复与大小写碰撞即拒', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  const run = files => validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }), manifestBytes: manifestBytes({ files })
  })
  assert.equal(isCanonicalRel('a/b/c.js'), true, '规范相对路径必须被接受')
  for (const bad of ['/abs/x.js', 'a/../b.js', 'a\\b.js', 'C:/x.js', 'a//b.js', 'a/./b.js', 'a/', '']) {
    assert.equal(isCanonicalRel(bad), false, '非规范路径必须被拒：' + JSON.stringify(bad))
  }
  const badCases = [
    ['绝对路径', [entryOf('/abs/x.js', body)]],
    ['含 ..', [entryOf('a/../b.js', body)]],
    ['反斜杠', [{ path: 'a\\b.js', sha256: sha(body), size: body.length }]],
    ['冒号', [{ path: 'C:/x.js', sha256: sha(body), size: body.length }]],
    ['空段', [{ path: 'a//b.js', sha256: sha(body), size: body.length }]],
    ['重复 path', [entryOf(X_REL, body), entryOf(X_REL, body)]],
    ['大小写碰撞', [entryOf(X_REL, body), entryOf('tavern-plugin/lib/domain/X-Probe.js', body)]]
  ]
  for (const [label, files] of badCases) {
    const result = run(files)
    assert.equal(result.ok, false, label + ' 必须 ok:false（' + JSON.stringify(result.failures) + '）')
    assert.ok(result.failures.some(item => /path/.test(item)), label + ' 失败原因必须指向 path：' + JSON.stringify(result.failures))
  }
})

test('清单验证sha与size非法即拒', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  const run = files => validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }), manifestBytes: manifestBytes({ files })
  })
  const badCases = [
    ['sha 非 64 位', [{ path: X_REL, sha256: 'abc', size: body.length }], /sha256/],
    ['sha 大写', [{ path: X_REL, sha256: sha(body).toUpperCase(), size: body.length }], /sha256/],
    ['size 负数', [{ path: X_REL, sha256: sha(body), size: -1 }], /size/],
    ['size 小数', [{ path: X_REL, sha256: sha(body), size: 1.5 }], /size/],
    ['size 缺失', [{ path: X_REL, sha256: sha(body) }], /size/],
    ['条目不是对象', ['x'], /不是对象/]
  ]
  for (const [label, files, pattern] of badCases) {
    const result = run(files)
    assert.equal(result.ok, false, label + ' 必须 ok:false')
    assert.ok(result.failures.some(item => pattern.test(item)), label + ' 失败原因：' + JSON.stringify(result.failures))
  }
})

test('清单验证package身份与清单版本必须一致', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  const run = pkgBytes => validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL, PKG_REL], images: imagesWith([X_REL, PKG_REL]),
    projection: projectionOf({ [X_REL]: body, [PKG_REL]: pkgBytes }),
    manifestBytes: manifestBytes({ files: [entryOf(X_REL, body), entryOf(PKG_REL, pkgBytes)] })
  })
  const okResult = run(PKG)
  assert.equal(okResult.ok, true, 'name/version 一致时必须通过：' + JSON.stringify(okResult.failures))
  const wrongName = Buffer.from(JSON.stringify({ name: 'some-other-plugin', version: '2.5.0' }), 'utf8')
  assert.ok(run(wrongName).failures.some(item => /name 必须是 dsh-tavern-plugin/.test(item)), '包名不符必须拒')
  const wrongVersion = Buffer.from(JSON.stringify({ name: 'dsh-tavern-plugin', version: '2.4.9' }), 'utf8')
  assert.ok(run(wrongVersion).failures.some(item => /version 与清单不一致/.test(item)), '版本不符必须拒')
  assert.ok(run(Buffer.from('not json', 'utf8')).failures.some(item => /不是合法 JSON/.test(item)), 'package 非 JSON 必须拒')
})

test('清单验证必需作者目标缺entry即拒且不得当owned', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  // images 有正文（⇒ 非 owned）但清单缺 entry ⇒ 拒
  const images = imagesWith([X_REL])
  const missing = validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL], images,
    projection: projectionOf({ [X_REL]: body }),
    manifestBytes: manifestBytes({ files: [entryOf('tavern-plugin/lib/index.js', body)] })
  })
  assert.equal(missing.ok, false, '必需作者目标缺 entry 必须拒')
  assert.ok(missing.failures.some(item => /必需作者目标在本地清单里缺 entry/.test(item)), '失败原因：' + JSON.stringify(missing.failures))
  // 真实随包目录 images：background-task-coordinator.js 明确属作者 ⇒ 即使 images 无正文也不得当 owned
  const real = await realImages()
  const authorOverride = validateRuntimeManifest({
    appDir: f.dir, targets: [AUTHOR_REL], images: real,
    projection: projectionOf({ [AUTHOR_REL]: body }),
    manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] })
  })
  assert.equal(authorOverride.ok, false, '作者路径（AUTHOR_REQUIRED_OVERRIDES）不得因 images 无正文被当 owned')
  assert.ok(authorOverride.failures.some(item => /必需作者目标在本地清单里缺 entry/.test(item)), '真实 images 下也必须按"必需作者目标"拒：' + JSON.stringify(authorOverride.failures))
  void f
})

test('清单验证optional目标双缺通过单缺拒绝且entry在即须匹配', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  const games = Buffer.from('game-bytes')
  // ① entry 与实物均缺 ⇒ 通过，files[optional]=null
  const bothMissing = validateRuntimeManifest({
    appDir: f.dir, targets: [OPTIONAL_REL], images: imagesWith([]),
    projection: projectionOf({}), manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] })
  })
  assert.equal(bothMissing.ok, true, '双缺必须通过：' + JSON.stringify(bothMissing.failures))
  assert.equal(bothMissing.image.files[OPTIONAL_REL], null, 'optional 双缺时 image.files 记 null')
  assert.equal(bothMissing.witness.targets[OPTIONAL_REL], null, 'optional 无 entry 时 witness 记 null')
  // ② entry 缺但实物在 ⇒ 拒
  const singleMissing = validateRuntimeManifest({
    appDir: f.dir, targets: [OPTIONAL_REL], images: imagesWith([]),
    projection: projectionOf({ [OPTIONAL_REL]: games }), manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] })
  })
  assert.equal(singleMissing.ok, false, 'optional 单缺（实物在而 entry 缺）必须拒')
  assert.ok(singleMissing.failures.some(item => /optional 目标在清单里缺 entry 但实物存在/.test(item)), '失败原因：' + JSON.stringify(singleMissing.failures))
  // ③ entry 在 ⇒ 必读且必须匹配（内容不符 ⇒ 拒）
  const mismatch = validateRuntimeManifest({
    appDir: f.dir, targets: [OPTIONAL_REL], images: imagesWith([OPTIONAL_REL]),
    projection: projectionOf({ [OPTIONAL_REL]: games }), manifestBytes: manifestBytes({ files: [entryOf(OPTIONAL_REL, Buffer.from('other'))] })
  })
  assert.equal(mismatch.ok, false, 'entry 在而内容不符必须拒')
  assert.ok(mismatch.failures.some(item => /字节摘要与清单不符/.test(item)), '失败原因：' + JSON.stringify(mismatch.failures))
  // ④ entry 在且匹配 ⇒ 通过
  const matched = validateRuntimeManifest({
    appDir: f.dir, targets: [OPTIONAL_REL], images: imagesWith([OPTIONAL_REL]),
    projection: projectionOf({ [OPTIONAL_REL]: games }), manifestBytes: manifestBytes({ files: [entryOf(OPTIONAL_REL, games)] })
  })
  assert.equal(matched.ok, true, 'entry 在且匹配必须通过：' + JSON.stringify(matched.failures))
})

test('清单验证前像含插件接管标记或包名即拒', async t => {
  const f = app(t)
  const cases = [
    ['standard-owned 标记', Buffer.from('// [dsh-tavern-standard-owned:v1]\nexport const x = 1\n', 'utf8')],
    ['core-host 标记', Buffer.from('// [dsh-tavern-core-host:v1]\nexport const y = 2\n', 'utf8')],
    ['插件包名', Buffer.from("export const z = 'dsh-tavern-sqlite-v2'\n", 'utf8')]
  ]
  for (const [label, bytes] of cases) {
    const result = validateRuntimeManifest({
      appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]),
      projection: projectionOf({ [X_REL]: bytes }), manifestBytes: manifestBytes({ files: [entryOf(X_REL, bytes)] })
    })
    assert.equal(result.ok, false, label + ' 必须拒')
    assert.ok(result.failures.some(item => /插件接管标记/.test(item)), label + ' 失败原因：' + JSON.stringify(result.failures))
  }
  assert.ok(OWN_CODE_MARKERS.length > 0, '接管标记清单不得为空')
  // 纯作者正文 ⇒ 通过（负例不误伤）
  const clean = Buffer.from('export const pure = 1\n', 'utf8')
  const okResult = validateRuntimeManifest({
    appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]),
    projection: projectionOf({ [X_REL]: clean }), manifestBytes: manifestBytes({ files: [entryOf(X_REL, clean)] })
  })
  assert.equal(okResult.ok, true, '纯作者正文必须通过：' + JSON.stringify(okResult.failures))
})

test('清单验证owned同名文件与清单定义即拒', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  // 最小构造：images 全无该路径正文 ⇒ owned
  const ownedImages = [{ commit: 'b'.repeat(40), authorVersion: '2.5.0', files: { [X_REL]: null } }]
  // ① owned 路径在投影里有文件 ⇒ 拒
  const withFile = validateRuntimeManifest({
    appDir: f.dir, targets: [OWNED_REL], images: ownedImages,
    projection: projectionOf({ [OWNED_REL]: Buffer.from('plugin-shim') }), manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] })
  })
  assert.equal(withFile.ok, false, 'owned 路径裸树有文件必须拒')
  assert.ok(withFile.failures.some(item => /插件 owned 路径在裸树里已有文件/.test(item)), '失败原因：' + JSON.stringify(withFile.failures))
  // ② 清单给 owned 路径定义 entry ⇒ 拒（不得由清单把它当作者文件）
  const withEntry = validateRuntimeManifest({
    appDir: f.dir, targets: [OWNED_REL], images: ownedImages,
    projection: projectionOf({}), manifestBytes: manifestBytes({ files: [entryOf(OWNED_REL, body)] })
  })
  assert.equal(withEntry.ok, false, '清单定义 owned 路径必须拒')
  assert.ok(withEntry.failures.some(item => /不得由本地清单定义成作者文件/.test(item)), '失败原因：' + JSON.stringify(withEntry.failures))
  // ③ owned 路径双缺（投影无文件、清单无 entry）⇒ 通过
  const bothMissing = validateRuntimeManifest({
    appDir: f.dir, targets: [OWNED_REL], images: ownedImages,
    projection: projectionOf({}), manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] })
  })
  assert.equal(bothMissing.ok, true, 'owned 双缺必须通过：' + JSON.stringify(bothMissing.failures))
  assert.equal(bothMissing.image.files[OWNED_REL], null)
  // ④ 真实随包目录 images：storage-native-data.js 在所有 tree 均无正文 ⇒ owned（不因 identity 变化被当作者）；
  //    注意 checked 集恒含 package.json，真实 images 下它有正文 ⇒ 必须按必需作者目标给 entry+投影
  const real = await realImages()
  const realOwned = validateRuntimeManifest({
    appDir: f.dir, targets: [OWNED_REL], images: real,
    projection: projectionOf({ [PKG_REL]: PKG }),
    manifestBytes: manifestBytes({ files: [entryOf(X_REL, body), entryOf(PKG_REL, PKG)] })
  })
  assert.equal(realOwned.ok, true, '真实 images 下自有桥必须按 owned 放行（不要求清单 entry）：' + JSON.stringify(realOwned.failures))
  assert.equal(realOwned.image.files[OWNED_REL], null, '自有桥 image.files 记 null（不是作者前像）')
  assert.equal(Buffer.isBuffer(realOwned.image.files[PKG_REL]), true, '真实 images 下 package.json 按作者目标核过')
})

test('清单验证拒绝manifest软链祖先软链与目录形态', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  const bytes = manifestBytes({ files: [entryOf(X_REL, body)] })
  // ① manifest 自身是 junction（Windows 免权限）：拒绝且不得读取
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'author-runtime-manifest-target-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  writeFileSync(path.join(elsewhere, 'real.json'), bytes)
  symlinkSync(elsewhere, path.join(f.dir, RUNTIME_MANIFEST_REL), 'junction')
  const linkedManifest = validateRuntimeManifest({ appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }) })
  assert.equal(linkedManifest.ok, false, 'manifest 为 junction 必须拒')
  assert.ok(linkedManifest.failures.some(item => /清单路径异常/.test(item)), '失败原因：' + JSON.stringify(linkedManifest.failures))
  // ② 目标祖先为 junction ⇒ 拒绝（不得借链接读到外部内容）
  const f2 = app(t)
  const outside = mkdtempSync(path.join(tmpdir(), 'author-runtime-manifest-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(path.join(outside, 'x-probe.js'), body)
  mkdirSync(path.join(f2.dir, 'tavern-plugin', 'lib'), { recursive: true })
  symlinkSync(outside, path.join(f2.dir, 'tavern-plugin', 'lib', 'domain'), 'junction')
  const ancestorLink = validateRuntimeManifest({
    appDir: f2.dir, targets: [X_REL], images: imagesWith([X_REL]), manifestBytes: bytes
  })
  assert.equal(ancestorLink.ok, false, '目标祖先为 junction 必须拒')
  assert.ok(ancestorLink.failures.some(item => /祖先为符号链接\/junction/.test(item)), '失败原因：' + JSON.stringify(ancestorLink.failures))
  // ③ manifest 是目录形态 ⇒ 不是普通文件 ⇒ 拒
  const f3 = app(t)
  mkdirSync(path.join(f3.dir, RUNTIME_MANIFEST_REL), { recursive: true })
  const asDir = validateRuntimeManifest({ appDir: f3.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }) })
  assert.equal(asDir.ok, false, 'manifest 为目录必须拒')
  assert.ok(asDir.failures.some(item => /不是普通文件/.test(item)), '失败原因：' + JSON.stringify(asDir.failures))
  void lstatSync
})

test('清单验证无清单返回null而超限与参数非法为失败', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  // ① 现场无 manifest ⇒ null（交 caller fallback）
  assert.equal(validateRuntimeManifest({ appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }) }), null, '无清单必须返回 null')
  // ② 超限（>4MiB）⇒ ok:false（提供 bytes 时同样受限，且不读现场）
  const huge = Buffer.alloc(RUNTIME_MANIFEST_MAX_BYTES + 1, 0x20)
  const tooBig = validateRuntimeManifest({ appDir: f.dir, targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }), manifestBytes: huge })
  assert.equal(tooBig.ok, false, '超过尺寸上限必须拒')
  assert.ok(tooBig.failures.some(item => /超过尺寸上限/.test(item)), '失败原因：' + JSON.stringify(tooBig.failures))
  // ③ 参数非法：manifestBytes 非 Buffer/空、targets 空、未传投影且无 appDir
  assert.ok(validateRuntimeManifest({ appDir: f.dir, targets: [X_REL], manifestBytes: 'not-a-buffer' }).failures.some(item => /manifestBytes 必须是 Buffer/.test(item)), 'manifestBytes 非 Buffer 必须拒')
  assert.ok(validateRuntimeManifest({ appDir: f.dir, targets: [X_REL], manifestBytes: Buffer.alloc(0) }).failures.some(item => /manifestBytes 为空/.test(item)), 'manifestBytes 空必须拒')
  assert.ok(validateRuntimeManifest({ appDir: f.dir, targets: [] }).failures.some(item => /缺少声明受管目标清单/.test(item)), '缺 targets 必须拒')
  const noDir = validateRuntimeManifest({ targets: [X_REL], manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] }) })
  assert.equal(noDir.ok, false, '未传投影且无 appDir 必须拒（不能凭 bytes 猜现场）')
  // ④ 只凭投影 + bytes 时可省 appDir（记录路径）
  const offline = validateRuntimeManifest({
    targets: [X_REL], images: imagesWith([X_REL]), projection: projectionOf({ [X_REL]: body }), manifestBytes: manifestBytes({ files: [entryOf(X_REL, body)] })
  })
  assert.equal(offline.ok, true, '仅投影 + bytes 时必须可用（安装记录路径）：' + JSON.stringify(offline.failures))
})

test('清单验证为只读不改目录不改冻结gz不留临时物', async t => {
  const f = app(t)
  const body = Buffer.from('author-bytes')
  const bytes = manifestBytes({ files: [entryOf(X_REL, body), entryOf(PKG_REL, PKG)] })
  f.write(RUNTIME_MANIFEST_REL, bytes)
  f.write(X_REL, body)
  f.write(PKG_REL, PKG)
  const listBefore = readdirSync(f.dir).sort().join(',')
  const snapshot = new Map([RUNTIME_MANIFEST_REL, X_REL, PKG_REL].map(rel => [rel, sha(readFileSync(path.join(f.dir, ...rel.split('/'))))]))
  const gzBefore = sha(readFileSync(GZ))
  const result = validateRuntimeManifest({ appDir: f.dir, targets: [X_REL, PKG_REL], images: imagesWith([X_REL, PKG_REL]) })
  assert.equal(result.ok, true, '现场路径必须通过：' + JSON.stringify(result.failures))
  assert.equal(readdirSync(f.dir).sort().join(','), listBefore, '校验不得新增/删除目录项')
  for (const [rel, digest] of snapshot) assert.equal(sha(readFileSync(path.join(f.dir, ...rel.split('/')))), digest, '校验不得改动文件字节：' + rel)
  assert.equal(sha(readFileSync(GZ)), gzBefore, '校验不得改动冻结 gz')
  assert.equal(result.witness.sha256, sha(bytes), 'witness.sha256 必须等于现场清单摘要')
  assert.equal(Buffer.isBuffer(result.image.files[X_REL]), true)
})
