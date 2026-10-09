// comment-seam-files 文件级有限写集：真实临时目录装卸 + 明确故障注入（mock 只在测试侧，try/finally 复原）。
// 每个用例独立 mkdtemp 根，只删本用例自己那一个目录；不碰共享模块、不跑旧用例、不做全量。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCommentSeams, COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'

const OWNER = 'test-plugin'
const SOURCE = 'const result = db.prepare("SELECT 1");\n'
const descriptor = { owner: OWNER, id: 'route', format: 1, revision: 1, mode: 'replace', purpose: '重定向', anchor: { type: 'VariableDeclaration', name: 'result', init: { callee: 'db.prepare' } }, body: 'const result = plugin.prepare();\n' }

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comment-seam-files-'))
function drop(dir) {
  const base = path.basename(dir)
  if (!dir.startsWith(path.resolve(os.tmpdir()) + path.sep) || !base.startsWith('comment-seam-files-')) return
  fs.rmSync(dir, { recursive: true, force: true })
}
function put(dir, rel, text) {
  const file = path.join(dir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}
const target = (rel, descriptors = [descriptor]) => ({ rel, descriptors })
const run = (dir, targets, operation, extra = {}) => applyCommentSeams({ appDir: dir, owner: OWNER, targets, operation, assertStopped: () => true, checkReady: () => true, ...extra })
const recordOf = dir => path.join(dir, COMMENT_SEAMS_RECORD)

test('comment-seam-files 1 正常装卸+同代重装+重复卸载+CRLF+块外编辑', () => {
  const dir = makeRoot()
  try {
    const file = put(dir, 'a.js', 'const outside = 1\n' + SOURCE)
    const on = run(dir, [target('a.js')], 'install')
    assert.equal(on.changed, true, '首装应写入')
    assert.deepEqual(on.written, ['a.js'])
    const installed = fs.readFileSync(file)
    const recordText = fs.readFileSync(recordOf(dir), 'utf8')
    assert.match(installed.toString('utf8'), /\[dsh-tavern-seam:BEGIN\]/, '安装后应有 BEGIN 标记')
    assert.equal(JSON.parse(recordText).owner, OWNER)
    assert.ok(JSON.parse(recordText).files['a.js'], '记录应有该 file 级条目')
    const twice = run(dir, [target('a.js')], 'install')
    assert.equal(twice.changed, false, '同代重装应幂等零写')
    assert.ok(fs.readFileSync(file).equals(installed), '重装后字节不变')
    assert.equal(fs.readFileSync(recordOf(dir), 'utf8'), recordText, '重装后记录不变')
    put(dir, 'a.js', installed.toString('utf8').replace('const outside = 1', 'const outside = 2'))
    const off = run(dir, [target('a.js')], 'uninstall')
    assert.equal(off.changed, true)
    assert.equal(fs.readFileSync(file, 'utf8'), 'const outside = 2\n' + SOURCE, '卸载应回填块内作者原字节并保留块外编辑')
    assert.equal(fs.existsSync(recordOf(dir)), false, '卸载后记录应移除')
    const again = run(dir, [target('a.js')], 'uninstall')
    assert.equal(again.changed, false, '重复卸载应幂等零写')
    assert.equal(fs.readFileSync(file, 'utf8'), 'const outside = 2\n' + SOURCE)
    const crlfFile = put(dir, 'crlf.js', 'const outside = 1\r\nconst result = db.prepare("SELECT 1");\r\n')
    const crlfBefore = fs.readFileSync(crlfFile)
    run(dir, [target('crlf.js')], 'install')
    run(dir, [target('crlf.js')], 'uninstall')
    assert.ok(fs.readFileSync(crlfFile).equals(crlfBefore), 'CRLF 往返必须逐字节一致（不 normalize 现场 EOL）')
    const protoFile = put(dir, '__proto__', SOURCE)
    run(dir, [target('__proto__')], 'install')
    assert.ok(Object.hasOwn(JSON.parse(fs.readFileSync(recordOf(dir), 'utf8')).files, '__proto__'), 'aggregate.files 必须无原型：__proto__ 只能是 own key')
    run(dir, [target('__proto__')], 'uninstall')
    assert.ok(fs.readFileSync(protoFile).equals(Buffer.from(SOURCE, 'utf8')), '__proto__ rel 往返应还原原字节')
  } finally { drop(dir) }
})

test('comment-seam-files 2 有块无记录或坏记录按现场卸载并保留修改', () => {
  const dir = makeRoot()
  try {
    // ① 现场 ORIGINAL 里用户改过的变量值（SELECT 1 → SELECT 2）不影响按现场块卸载
    const file = put(dir, 'a.js', SOURCE.replace('SELECT 1', 'SELECT 2'))
    run(dir, [target('a.js')], 'install')
    fs.rmSync(recordOf(dir))
    const offNoRecord = run(dir, [target('a.js')], 'uninstall')          // 无 record 也按现场块卸
    assert.equal(offNoRecord.changed, true, '有块无记录必须能按现场卸载（不凭 marker 猜，也不拒）')
    const restored = fs.readFileSync(file, 'utf8')
    assert.match(restored, /SELECT 2/, '卸载必须保留用户在 ORIGINAL 里改过的变量值')
    assert.equal(restored.includes('[dsh-tavern-seam:'), false, '自有块必须撤干净')
    // ② 每条坏 record：重新放 SOURCE → 真实 install 落块 → 换坏 record → 卸载仍按现场还原
    const broken = ['{oops\n', 'null\n', '[]\n', '{"format":1,"owner":"' + OWNER + '","files":{},"owned":{}}\n', '{"format":1,"owner":"other","files":{"a.js":{}},"owned":{}}\n', '{"format":1,"owner":"' + OWNER + '","files":{"a.js":{}},"owned":{},"extra":1}\n']
    for (const body of broken) {
      put(dir, 'a.js', SOURCE)
      fs.rmSync(recordOf(dir), { force: true })
      run(dir, [target('a.js')], 'install')
      fs.writeFileSync(recordOf(dir), body, 'utf8')
      const off = run(dir, [target('a.js')], 'uninstall')
      assert.equal(fs.readFileSync(file, 'utf8'), SOURCE, '坏 record 不得阻按现场卸载：' + body.trim())
      assert.equal(off.changed, true)
    }
  } finally { drop(dir) }
})

test('comment-seam-files 3 路径越界/链接/重复 target 拒', t => {
  const dir = makeRoot()
  try {
    put(dir, 'a.js', SOURCE)
    assert.throws(() => run(dir, [target('../evil.js')], 'install'), /空段|非规范/, '../ 必须拒')
    assert.throws(() => run('relative-root', [target('a.js')], 'install'), /绝对路径/, 'appDir 必须绝对路径，不按 cwd 静默解析')
    assert.throws(() => run(dir, [target('sub/../a.js')], 'install'), /空段|非规范/, '含 .. 的非规范路径必须拒')
    assert.throws(() => run(dir, [target('a.js:stream')], 'install'), /冒号|ADS|盘符/, 'Windows ADS/冒号必须拒')
    assert.throws(() => run(dir, [target('a.js'), target('a.js')], 'install'), /重复/, '重复 rel 必须拒')
    assert.throws(() => run(dir, [], 'install'), /非空/, '空 targets 必须拒')
    assert.throws(() => run(dir, [target('a.js'), target('a.js'), target('b.js')], 'install'), /重复/)
    let rootLink = null, fileLink = null, dangling = null
    try { rootLink = path.join(dir, 'rootlink'); fs.symlinkSync(dir, rootLink, process.platform === 'win32' ? 'junction' : 'dir') } catch { rootLink = null }
    if (rootLink) assert.throws(() => run(rootLink, [target('a.js')], 'install'), /真实目录|符号链接/, 'root 为链接必须拒')
    try { fileLink = path.join(dir, 'link.js'); fs.symlinkSync(path.join(dir, 'a.js'), fileLink, 'file') } catch { fileLink = null }
    if (fileLink) assert.throws(() => run(dir, [target('link.js')], 'install'), /符号链接/, 'target 为链接必须拒')
    try { dangling = path.join(dir, 'dangling.js'); fs.symlinkSync(path.join(dir, 'missing.js'), dangling, 'file') } catch { dangling = null }
    if (dangling) assert.throws(() => run(dir, [target('dangling.js')], 'install'), /符号链接/, '悬空链接不得当“不存在”')
    if (!rootLink && !fileLink && !dangling) t.diagnostic('本机创建链接失败（Windows 需特权/开发者模式）：只 skip 链接子案例，越界/冒号/重复用例已测，不假 pass')
  } finally { drop(dir) }
})

test('comment-seam-files 4 checkReady 非严格 true 零写', () => {
  const dir = makeRoot()
  try {
    const file = put(dir, 'a.js', SOURCE)
    const before = fs.readFileSync(file)
    assert.throws(() => run(dir, [target('a.js')], 'install', { checkReady: () => false }), /checkReady/)
    assert.throws(() => run(dir, [target('a.js')], 'install', { checkReady: () => 1 }), /checkReady/, '必须严格 === true')
    assert.throws(() => run(dir, [target('a.js')], 'install', { checkReady: undefined }), /checkReady/, '必须传函数，不允许默认放行')
    assert.throws(() => run(dir, [target('a.js')], 'install', { assertStopped: () => false }), /assertStopped/, '停态断言非 true 必须拒')
    assert.throws(() => run(dir, [target('a.js')], 'install', { assertStopped: () => undefined }), /assertStopped/, 'undefined 不放行（必须严格 true）')
    assert.throws(() => run(dir, [target('a.js')], 'install', { assertStopped: undefined }), /assertStopped/, '必须传停态断言')
    assert.ok(fs.readFileSync(file).equals(before), '门禁失败必须零写')
    assert.equal(fs.existsSync(recordOf(dir)), false)
  } finally { drop(dir) }
})

test('comment-seam-files 5 checkReady 期间第三方改写即拒且保留', () => {
  const dir = makeRoot()
  try {
    const file = put(dir, 'a.js', SOURCE)
    const thirdParty = () => { fs.writeFileSync(file, '// 第三方接管\n', 'utf8'); return true }
    assert.throws(() => run(dir, [target('a.js')], 'install', { checkReady: thirdParty }), /外部修改/)
    assert.equal(fs.readFileSync(file, 'utf8'), '// 第三方接管\n', '第三方内容必须保留')
    assert.equal(fs.existsSync(recordOf(dir)), false, '记录不得写入')
  } finally { drop(dir) }
})

test('comment-seam-files 6 第2文件写失败回滚第1且记录未写', () => {
  const dir = makeRoot()
  const real = fs.writeFileSync.bind(fs)
  try {
    const first = put(dir, 'a.js', SOURCE)
    const second = put(dir, 'b.js', SOURCE)
    mock.method(fs, 'writeFileSync', (file, ...rest) => { if (String(file).endsWith('b.js')) throw Error('注入写失败'); return real(file, ...rest) })
    let failure = null
    try { run(dir, [target('a.js'), target('b.js')], 'install') } catch (error) { failure = error }
    assert.ok(failure, '必须抛错')
    assert.match(failure.message, /注入写失败/)
    assert.deepEqual(failure.recovery.files.map(item => item.rel), ['a.js', 'b.js'], 'recovery 必须留下本次写集依据')
    assert.equal(failure.recovery.recordBefore, null)
    assert.equal(typeof failure.recovery.recordAfter, 'string')
    assert.equal(fs.readFileSync(first, 'utf8'), SOURCE, '第1文件应按本次写前字节回滚')
    assert.equal(fs.readFileSync(second, 'utf8'), SOURCE, '第2文件未被写过')
    assert.equal(fs.existsSync(recordOf(dir)), false, '记录必须未写（文件先于记录）')
  } finally { mock.restoreAll(); drop(dir) }
})

test('comment-seam-files 7 回滚遇第三方改写保留冲突', () => {
  const dir = makeRoot()
  const real = fs.writeFileSync.bind(fs)
  try {
    const first = put(dir, 'a.js', SOURCE)
    put(dir, 'b.js', SOURCE)
    mock.method(fs, 'writeFileSync', (file, ...rest) => {
      if (String(file).endsWith('b.js')) { real(first, '// 第三方接管\n', 'utf8'); throw Error('注入写失败') }
      return real(file, ...rest)
    })
    let failure = null
    try { run(dir, [target('a.js'), target('b.js')], 'install') } catch (error) { failure = error }
    assert.ok(failure, '必须抛错')
    assert.match(failure.message, /并发修改/, '回滚发现第三方改写必须报冲突')
    assert.deepEqual(failure.recovery.files.map(item => item.rel), ['a.js', 'b.js'])
    assert.equal(failure.recovery.files[0].before, SOURCE, 'recovery 应带写前字节')
    assert.match(failure.recovery.files[0].after, /\[dsh-tavern-seam:BEGIN\]/, 'recovery 应带本次 after')
    assert.equal(fs.readFileSync(first, 'utf8'), '// 第三方接管\n', '第1文件已被第三方改写：保留不覆盖')
    assert.equal(fs.existsSync(recordOf(dir)), false)
  } finally { mock.restoreAll(); drop(dir) }
})

test('comment-seam-files 8 记录提交与部分写失败恢复边界', () => {
  const dir = makeRoot(), fresh = makeRoot()
  const real = fs.writeFileSync.bind(fs), realUnlink = fs.unlinkSync.bind(fs)
  try {
    // A 记录提交（unlink）失败：回滚到本次 snapshot（含块外用户编辑），既有 record 逐字节不变
    const file = put(dir, 'a.js', SOURCE)
    run(dir, [target('a.js')], 'install')
    const recordBefore = fs.readFileSync(recordOf(dir))
    put(dir, 'a.js', fs.readFileSync(file, 'utf8') + 'const userEdit = 1\n') // 块外编辑，进本次 snapshot
    const snapshot = fs.readFileSync(file)
    let injected = false
    mock.method(fs, 'unlinkSync', target => { if (String(target) === recordOf(dir) && !injected) { injected = true; throw Error('注入记录删除失败') } return realUnlink(target) })
    let failA = null
    try { run(dir, [target('a.js')], 'uninstall') } catch (error) { failA = error }
    assert.ok(failA, '记录提交失败必须抛错')
    assert.equal(injected, true, '必须真的走到记录 unlink 提交')
    assert.ok(fs.readFileSync(file).equals(snapshot), '回滚须回到本次 snapshot（含用户块外编辑）')
    assert.ok(fs.readFileSync(recordOf(dir)).equals(recordBefore), '既有 record 必须逐字节不变')
    assert.equal(failA.recovery.files[0].before, snapshot.toString('utf8'))
    assert.equal(failA.recovery.recordBefore, recordBefore.toString('base64'))
    assert.equal(failA.recovery.recordAfter, null)
    // B 新装首个文件部分写后抛：partial 保留不覆盖，recovery 带本次 snapshot
    mock.restoreAll()
    const partial = put(fresh, 'a.js', SOURCE)
    mock.method(fs, 'writeFileSync', (target, ...rest) => { if (String(target) === partial) { real(target, SOURCE.slice(0, 8), 'utf8'); throw Error('注入部分写失败') } return real(target, ...rest) })
    let failB = null
    try { run(fresh, [target('a.js')], 'install') } catch (error) { failB = error }
    assert.ok(failB, '部分写失败必须抛错')
    assert.equal(failB.recovery.files[0].before, SOURCE, 'recovery 必须带本次 snapshot')
    assert.match(failB.recovery.files[0].after, /\[dsh-tavern-seam:BEGIN\]/)
    assert.match(failB.message, /部分写/)
    assert.equal(fs.readFileSync(partial, 'utf8'), SOURCE.slice(0, 8), '部分写必须保留、不得被盖回')
    assert.equal(fs.existsSync(recordOf(fresh)), false)
    // C 写后停态断言 false：已写完的文件与记录都必须回滚
    mock.restoreAll()
    const later = put(fresh, 'b.js', SOURCE)
    let stops = 0, failC = null
    try { run(fresh, [target('b.js')], 'install', { assertStopped: () => ++stops < 3 }) } catch (error) { failC = error }
    assert.ok(failC, '写后停态 false 必须回滚并抛错')
    assert.equal(stops, 3, '必须真的走到写后断言')
    assert.ok(fs.readFileSync(later).equals(Buffer.from(SOURCE, 'utf8')), '写后停态失败须回滚文件')
    assert.equal(fs.existsSync(recordOf(fresh)), false, '写后停态失败须回滚记录')
  } finally { mock.restoreAll(); drop(dir); drop(fresh) }
})
