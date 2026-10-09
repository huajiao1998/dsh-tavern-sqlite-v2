// 现场桥（owned-new 整文件）本地协议：无记录换代撤桥、块外用户追加保留、不冒认未知同名文件。
// 用真实 applyCommentSeams + 有限 tmp（不碰产品/真实数据）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyCommentSeams, COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { parseSeamSource } from '../deploy/comment-seam-blocks.mjs'

const OWNER = 'dsh-tavern-sqlite-v2'
const REL = 'tavern-plugin/lib/domain/storage-native-data.js'
const BODY1 = '// [dsh-tavern-standard-owned:v1]\nexport const v = 1\n'
const BODY2 = '// [dsh-tavern-standard-owned:v1]\nexport const v = 2\n'
const USER = '// 用户自行追加的一行\n'
const apply = (appDir, targets, operation = 'install') => applyCommentSeams({ appDir, owner: OWNER, targets, operation, assertStopped: () => true, checkReady: () => true })
const cleanup = dir => rmSync(dir, { recursive: true, force: true })
const fixture = () => { const appDir = mkdtempSync(path.join(os.tmpdir(), 'comment-owned-local-')); return { appDir, file: path.join(appDir, REL), record: path.join(appDir, COMMENT_SEAMS_RECORD) } }

test('现场桥1 无记录换代撤桥与块外用户追加保留', () => {
  // ① 首装 owned body
  const f = fixture()
  try {
    const first = apply(f.appDir, [{ rel: REL, descriptors: [], ownedBody: BODY1 }])
    assert.equal(first.changed, true)
    // 实测契约（main files 层）：自有整文件以 `id=owned-file` 的 **insert 块**落在现场，body 在 ACTIVE 区里。
    const blocks = parseSeamSource(readFileSync(f.file, 'utf8'), { rel: REL }).blocks
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].metadata.id, 'owned-file')
    assert.equal(blocks[0].metadata.mode, 'insert')
    assert.match(readFileSync(f.file, 'utf8'), /dsh-tavern-standard-owned/)
    // ② 用户在块外/文件尾追加（不是我们写的字节）
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + USER, 'utf8')   // 只在**现场已装字节**末尾追加，不得用裸 body 覆盖（会毁掉自描述标记）
    // ③ 记录被删/损坏（换代形态）：换新 body 重装必须保留用户追加
    rmSync(f.record, { force: true })
    const second = apply(f.appDir, [{ rel: REL, descriptors: [], ownedBody: BODY2 }])
    assert.equal(second.changed, true, '无记录换代必须能重装新 body')
    const afterSecond = readFileSync(f.file, 'utf8')
    assert.match(afterSecond, /export const v = 2/, '新 body 必须生效')
    assert.match(afterSecond, /用户自行追加的一行/, '换代后用户追加必须保留')
    // ④ 卸载只撤我们写的整块，用户追加仍在
    const off = apply(f.appDir, [{ rel: REL, descriptors: [] }], 'uninstall')
    assert.equal(off.changed, true)
    assert.equal(readFileSync(f.file, 'utf8'), USER, '卸载只撤自有桥，块外用户追加保留')
    // ⑤ 重复卸载零写
    assert.equal(apply(f.appDir, [{ rel: REL, descriptors: [] }], 'uninstall').changed, false)
  } finally { cleanup(f.appDir) }
  // ⑥ 未知同名文件不得被冒认成 owned-new
  const g = fixture()
  try {
    mkdirSync(path.dirname(g.file), { recursive: true })
    writeFileSync(g.file, 'export const 别人的实现 = 1\n', 'utf8')
    assert.throws(() => apply(g.appDir, [{ rel: REL, descriptors: [], ownedBody: BODY1 }]), /冒认|同名|存在/)
  } finally { cleanup(g.appDir) }
  void existsSync
})
