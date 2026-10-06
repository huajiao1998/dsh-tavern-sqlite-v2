// 上游 9e9b26d（v2.5 晚间重发布＋MVU 修复）树兼容闸（2026-10-06，0.2.2）。
//
// 目的：0.2.1 的接缝锚点基于 5d2ffacf 代 2.5.0 树；上游 main(9e9b26d) 仍有 50+ 提交
// （压缩重写/台账手动化/卡片工作台/MVU $meta 修复等）。本闸在**新树副本**上跑完整
// 标准接缝链（protect→apply→check→幂等→卸载演练→再接入），证明锚点与语义注入
// 在新树上逐项成立；缺夹具直接炸，不许 skip。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AUTHOR_SHA = '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544'
const FIXTURE = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-' + AUTHOR_SHA + '/tavern-plugin/', import.meta.url)
if (!existsSync(new URL('lib/index.js', FIXTURE))) {
  throw new Error('缺上游 9e9b26d 作者树夹具（tmp/upstream25-author-fixture/src/dsh-tavern-' + AUTHOR_SHA + '/）；0.2.2 兼容基线无法对账，按 loud 失败处理')
}

const seams = await import(new URL('../deploy/standard-seams.mjs', import.meta.url).href)
const { protectAuthorStartup } = await import(new URL('../deploy/maintenance/author-safety.mjs', import.meta.url).href)

function freshApp() {
  const app = mkdtempSync(path.join(os.tmpdir(), 'upstream25b-compat-'))
  cpSync(FIXTURE, path.join(app, 'tavern-plugin'), { recursive: true })
  return app
}
const read = (app, rel) => readFileSync(path.join(app, rel), 'utf8')

test('① 新树身份：确为 9e9b26d 代（新模块在场＋MVU $meta 修复在场），版本仍 2.5.0', () => {
  // 新树独有的作者模块（5d2ffacf 代没有）：证明夹具不是旧树复用。
  for (const rel of ['lib/domain/manual-ledger.js', 'lib/domain/foreground-variable-changes.js', 'lib/domain/request-lineage.js']) {
    assert.equal(existsSync(new URL(rel, FIXTURE)), true, '新树独有模块缺失：' + rel)
  }
  // 95949fc 的 $meta 隐藏修复必须在新结算模块里（语义锚，防夹具错代）。
  const settlement = readFileSync(new URL('lib/domain/mvu-background-settlement.js', FIXTURE), 'utf8')
  assert.equal(settlement.includes('withoutMetadataKeys'), true, '上游 $meta 修复不在场，夹具代际错误')
  // 470a473 删掉旧压缩协调器（5d2ffacf 代仍在）：再证新代。
  assert.equal(existsSync(new URL('lib/domain/tavern-compaction.js', FIXTURE)), false, '旧压缩协调器仍在，夹具代际错误')
  const pkg = JSON.parse(readFileSync(new URL('package.json', FIXTURE), 'utf8'))
  assert.equal(pkg.name, 'dsh-tavern-plugin'); assert.equal(pkg.version, '2.5.0')
})

test('② 完整标准接缝链在新树上成立：apply→check ready→幂等', () => {
  const app = freshApp()
  try {
    const idx = path.join(app, 'tavern-plugin/lib/index.js')
    const raw = readFileSync(idx, 'utf8')
    writeBack(idx, protectAuthorStartup(raw))
    const applied = seams.applyStandardSeams({ appDir: app })
    assert.equal(applied.changed, true, '新树上必须真的施缝')
    const check = seams.checkStandardSeams({ appDir: app })
    assert.equal(check.ready, true, '新树施缝后必须 ready')
    assert.deepEqual(check.pending, [])
    // 幂等：复跑不再改。
    assert.equal(seams.applyStandardSeams({ appDir: app }).changed, false)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('③ 语义注入抽查：关键缝标记与合并投影在新树产物里逐项在场', () => {
  const app = freshApp()
  try {
    const idx = path.join(app, 'tavern-plugin/lib/index.js')
    writeBack(idx, protectAuthorStartup(readFileSync(idx, 'utf8')))
    seams.applyStandardSeams({ appDir: app })
    const index = read(app, 'tavern-plugin/lib/index.js')
    // 压缩警告：合并投影同时保留作者 forkTurnsByMessageId 与我们的警告字段。
    assert.equal(index.includes('forkTurnsByMessageId: forkTurnsForChat(chat)'), true)
    assert.equal(index.includes("contextCompaction: projectCompactionWarning(chat.contextCompaction, ctx.llm.listProviders())"), true)
    assert.equal(index.includes("from './domain/storage-compaction-warning.js'"), true)
    // 核心宿主＋服务端执行线。
    assert.equal(index.includes('[dsh-tavern-core-host:v1]'), true)
    assert.equal(index.includes('createOpeningPreparation({ readCard, worldBooks, dispatchMarksProvider:'), true, '开局动态分类宿主注入必须在场')
    // 标准垫片：chat-sqlite-store 为部署件（解析 dsh-tavern-sqlite-v2/chat-store），其余 owned 标记行开头。
    assert.equal(read(app, 'tavern-plugin/lib/domain/chat-sqlite-store.js').includes("resolve('dsh-tavern-sqlite-v2/chat-store')"), true, '存储垫片缺失：chat-sqlite-store.js')
    for (const rel of ['tavern-plugin/lib/domain/storage-server-execution.js', 'tavern-plugin/lib/domain/storage-package.js']) {
      assert.equal(read(app, rel).startsWith('// [dsh-tavern-standard-owned:v1]'), true, '标准垫片缺失：' + rel)
    }
    // 后台任务回退缝（该文件被上游台账提交改过，锚点必须仍命中）。
    assert.equal(read(app, 'tavern-plugin/lib/background-agent-task.js').includes('[dsh-tavern-background-task-rewind:v1]'), true)
    // 会话状态视图缝（该文件被上游清理提交改过）。
    assert.equal(read(app, 'tavern-plugin/lib/domain/chat-session-state.js').includes('[dsh-tavern-rollback-pending-view:v1]'), true)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('④ 卸载演练：标准记录恢复 protect 后原像，逐字节一致', () => {
  const app = freshApp()
  try {
    const idx = path.join(app, 'tavern-plugin/lib/index.js')
    const protectedOriginal = protectAuthorStartup(readFileSync(idx, 'utf8'))
    writeBack(idx, protectedOriginal)
    seams.applyStandardSeams({ appDir: app })
    const result = seams.uninstallStandardSeams({ appDir: app })
    assert.equal(result.changed, true)
    assert.equal(read(app, 'tavern-plugin/lib/index.js'), protectedOriginal, '卸载必须逐字节还原 protect 后原像')
    assert.equal(existsSync(path.join(app, '.tavern-standard-seams.json')), false, '标准记录必须已删')
    // 再接入（真实升级路径：卸了又装）。
    assert.equal(seams.applyStandardSeams({ appDir: app }).changed, true)
    assert.equal(seams.checkStandardSeams({ appDir: app }).ready, true)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

function writeBack(file, body) { writeFileSync(file, body, 'utf8') }
