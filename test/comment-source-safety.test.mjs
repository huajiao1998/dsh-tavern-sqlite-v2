// comment-source 安全闸（tiny 隔离源，不依赖 factory/catalog/业务）：真 lexer 判定、restore 不猜第三方删除、坏 UTF-8 与无记录块拒。
// 合成块用 mode=insert（无 ORIGINAL 子区域要求）；replace 块必须带子区域，合成时不用它以免混淆夹具与产品判据。
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sourceAccess, assertPackageSource, SEAM_OWNER, STANDARD_RECORD } from '../deploy/maintenance/source.mjs'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { executeMaintenance } from '../deploy/maintenance/runner.mjs'
import { prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const TARGET = 'tavern-plugin/lib/domain/probe.js'
const INDEX = 'tavern-plugin/lib/index.js'
const OWN = `// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=${SEAM_OWNER} id=probe mode=insert purpose="p"\n// [dsh-tavern-seam:ACTIVE_BEGIN]\nconst x = 1\n// [dsh-tavern-seam:ACTIVE_END]\n// [dsh-tavern-seam:END] format=1 owner=${SEAM_OWNER} id=probe\n`
const FOREIGN = `// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=other-plugin id=probe mode=insert purpose="p"\n// [dsh-tavern-seam:ACTIVE_BEGIN]\nconst x = 1\n// [dsh-tavern-seam:ACTIVE_END]\n// [dsh-tavern-seam:END] format=1 owner=other-plugin id=probe\n`
const LEGACY = '// [dsh-tavern-core-host:v1] 旧接管标记\nconst y = 2\n'
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-source-safety-'))
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
  fs.mkdirSync(path.join(root, 'tavern-plugin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tavern-plugin', 'package.json'), '{"name":"dsh-tavern-plugin","version":"2.5.0"}\n')
  return root
}
const drop = root => { assert.ok(path.basename(root).startsWith('comment-source-safety-'), '只清自建临时目录'); fs.rmSync(root, { recursive: true, force: true }) }
const access = root => sourceAccess(root, [TARGET, INDEX])
const block = (rel, fragment) => ({ format: 1, owner: SEAM_OWNER, rel, blocks: [{ beforeFragment: fragment, afterFragment: fragment }] })
const recordText = files => JSON.stringify({ format: 1, owner: SEAM_OWNER, files, owned: {} }, null, 2) + '\n'

test('comment-source1 旧真注释命中/字符串伪marker与他方块不误判', () => {
  const root = tree({
    [TARGET]: `${LEGACY}const pseudo = '// [dsh-tavern-core-host:v1] 字符串里的伪标记'\nconst str = "[dsh-tavern-seam:BEGIN] format=1 revision=1 owner=${SEAM_OWNER} id=x mode=insert purpose=\\"p\\""\n`,
    [INDEX]: `${FOREIGN}const user = 1 // 用户注释提到 dsh-tavern-sqlite-v2 但不是协议前缀\n`,
  })
  try {
    const src = access(root)
    assert.deepEqual(src.blockPresence(), [], '他方块与字符串里的伪 marker 都不算本 owner 块')
    assert.deepEqual(src.takeoverPresence(), [TARGET], '只认真实行注释里的旧前缀（字符串/普通注释提及插件名不算）')
    assert.equal(src.cleanState(), false, '存在旧机制真实注释 ⇒ 不干净')
  } finally { drop(root) }
})

test('comment-source2 第三方删记录后 restore(expected) 必须冲突不回盖', () => {
  const root = tree({ [TARGET]: `${OWN}const tail = 3\n` })
  try {
    const src = access(root), recordPath = path.join(root, STANDARD_RECORD)
    fs.writeFileSync(recordPath, recordText({ [TARGET]: block(TARGET, 'old\n') })) // 本次操作前像：已有旧记录
    const before = src.capture()
    fs.writeFileSync(recordPath, recordText({ [TARGET]: block(TARGET, 'new\n') })) // 本次写入结果
    const expected = src.capture()
    fs.rmSync(recordPath) // 第三方删除本次 tmp 记录文件（非业务数据）
    assert.throws(() => src.restore(before, { expected }), /保留现场不回盖|冲突/, '现场既非前像也非本次结果时必须冲突')
    assert.equal(fs.existsSync(recordPath), false, '冲突后不得伪盖回旧记录')
  } finally { drop(root) }
})

test('comment-source3 无记录本owner块可识别且坏UTF8拒', () => {
  const root = tree({ [TARGET]: `${OWN}const tail = 3\n` })
  const bad = tree({ [TARGET]: Buffer.from([0x61, 0xff, 0xfe, 0x62]) })
  try {
    // 新契约：无记录但现场有本 owner **完整块**不拒（可识别即可按现场块处置）；只有坏 UTF-8 才拒。
    assert.doesNotThrow(() => assertPackageSource(access(root), {}), '无记录＋完整本 owner 块不得拒')
    assert.throws(() => access(bad).text(TARGET), /合法 UTF-8/, '坏 UTF-8 必须严格拒（不用容错解码）')
  } finally { drop(root); drop(bad) }
})

test('块CLI4 护栏部分写失败保留现场并报告未恢复', async t => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  t.after(() => tree.cleanup())
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-cli4-evidence-'))
  t.after(() => fs.rmSync(evidence, { recursive: true, force: true }))
  const src = sourceAccess(tree.appDir, adapter.targets), index = src.file('tavern-plugin/lib/index.js')
  const calls = []
  const driver = {
    runtime: {}, wasRunning: false,
    preflight: async () => ({ noop: false, wasRunning: false }), assertIdentity: async () => {},
    assertStopped: async () => calls.push('stopped'), stop: async () => {}, manage: async k => calls.push('manage:' + k),
    start: async () => ({}), verify: async () => ({ basicHealthVerified: true }), verifyRecovery: async () => {},
    restorePackage: async () => calls.push('restorePackage'), beginRecovery: () => {}, stoppedAfterError: async () => true,
    stopFailedStart: async () => {}, stopIfAlive: async () => {},
  }
  // 只此一次护栏注入：拦**真实 app index 的写入**（预演路径不匹配，故不污染预演），先真写 partial malformed 再抛。
  const origWrite = fs.writeFileSync.bind(fs)
  let injected = 0
  mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(index) && String(data).includes('[dsh-tavern-seam:BEGIN]') && injected === 0 && calls.includes('manage:install')) {
      injected += 1
      origWrite(index, 'const broken = (\n', 'utf8')
      throw new Error('注入 apply 部分写失败')
    }
    return origWrite(file, data, ...rest)
  })
  let fail = null
  try {
    await executeMaintenance({ action: 'install', adapter, driver, source: src, evidenceDir: evidence, progress: () => {} })
  } catch (error) { fail = error } finally { mock.restoreAll() }
  assert.ok(fail, '必须抛错')
  assert.equal(injected, 1, '护栏必须在真实 index 写入时才触发一次（预演副本不匹配）')
  assert.ok(calls.includes('manage:install'), '护栏注入必须发生在 manage 之后')
  const text = String(fail.message) + ' | ' + String(fail.cause?.message ?? '')
  assert.match(text, /维护失败/, '必须报维护失败而不是成功')
  assert.match(text, /未完成|部分写|第三方|冲突/, '必须报告未恢复/冲突，不得冒恢复成功')
  assert.equal(/源码未写入/.test(text), false, '不得把"源码未写"当成功恢复结论')
  assert.equal(fs.readFileSync(index, 'utf8'), 'const broken = (\n', '部分写现场必须保留（不回盖、不伪恢复）')
})
