// 现场产品1：真实裸 index 里用户改过接缝原参数 → 装后参数进 ORIGINAL 注释层；按现场解除（不核历史、不重找 anchor）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { applyStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { parseSeamSource } from '../deploy/comment-seam-blocks.mjs'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { protectAuthorStartup } from '../deploy/maintenance/author-safety.mjs'

const OWNER = 'dsh-tavern-sqlite-v2', INDEX = 'tavern-plugin/lib/index.js'
const USER = '// 用户在文件末尾的自有代码\n'

test('现场产品1 接缝原参数修改后注释并按现场解除', () => {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  try {
    const file = path.join(tree.appDir, INDEX)
    const bare = readFileSync(file, 'utf8')
    // ① 真实裸树上注入用户参数（不动既有 names），并追加块外用户代码
    const at = bare.indexOf('createChatJournalStore({')
    assert.ok(at > 0, '夹具必须是真实作者代：含 createChatJournalStore({')
    const injected = bare.slice(0, at + 'createChatJournalStore({'.length) + '\n      userSetting: 1,\n' + bare.slice(at + 'createChatJournalStore({'.length) + USER
    writeFileSync(file, injected, 'utf8')
    const before = new Map(maintenanceTargets.filter(rel => existsSync(path.join(tree.appDir, rel))).map(rel => [rel, readFileSync(path.join(tree.appDir, rel), 'utf8')]))
    // ② 真装
    const applied = applyStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
    assert.equal(applied.changed, true)
    assert.equal(applied.ready, true)
    const installed = readFileSync(file, 'utf8')
    // 作者 index 有多个 replace 块：取 ORIGINAL 里真正含用户参数的那一块（不假设是第一块）
    const found = parseSeamSource(installed, { rel: INDEX }).blocks
      .filter(b => b.metadata.owner === OWNER && b.regions.original)
      .map(b => ({ block: b, region: installed.slice(b.regions.original.beginEnd, b.regions.original.endStart) }))
      .find(item => /userSetting: 1,/.test(item.region))
    assert.ok(found, '用户参数必须进某个 replace 块的 ORIGINAL 注释层')
    const { block, region } = found
    // 按 ORIGINAL 区实际行解析（不依赖整行正则形态）：该行必须带本机制加的 `// ` 前缀
    const paramLine = region.split('\n').find(line => line.includes('userSetting: 1,'))
    assert.ok(paramLine, '用户参数必须留在 ORIGINAL 层')
    assert.match(paramLine, /^[ \t]*\/\/ /, '该行必须带本机制加的 `// ` 注释前缀')
    // ③ ACTIVE 仍是我们的 SQLite 实现；**只**要求 SQLite 构造自身的标量参数不采用用户值
    //   （ACTIVE 合法复用 authorChatStore/legacy 只读参数，不能一概禁止 userSetting 字符串出现）
    const active = activeSource(installed, INDEX)
    assert.match(active, /createChatSqliteStore\(/, 'ACTIVE 必须仍是 SQLite 存储构造')
    const sqliteLine = active.split('\n').find(line => line.includes('createChatSqliteStore('))
    assert.ok(sqliteLine, '必须能定位 createChatSqliteStore 构造行')
    assert.equal(/userSetting/.test(sqliteLine), false, 'SQLite store 构造不得采用用户的 userSetting（legacy 读源参数保留）')
    // ④ 现场改 ORIGINAL 里用户参数 1→2，并把被注释原函数的 callee 改掉（仍可解析）
    const tweaked = region.replace(paramLine, paramLine.replace('userSetting: 1,', 'userSetting: 2,')).replace('createChatJournalStore(', 'otherCreateStore(')
    const tampered = installed.slice(0, block.regions.original.beginEnd) + tweaked + installed.slice(block.regions.original.endStart)
    writeFileSync(file, tampered, 'utf8')
    // ⑤ 删记录后按现场解除（不核历史、不重找 anchor）
    rmSync(path.join(tree.appDir, COMMENT_SEAMS_RECORD), { force: true })
    const off = uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
    assert.equal(off.changed, true)
    const expected = injected.replace('userSetting: 1,', 'userSetting: 2,').replace('createChatJournalStore(', 'otherCreateStore(')
    assert.equal(readFileSync(file, 'utf8'), expected, '必须按现场 ORIGINAL 还原（含用户 1→2 与新 callee）')
    assert.equal(readFileSync(file, 'utf8').includes('[dsh-tavern-seam:'), false, '不得残留任何块标记')
    for (const [rel, text] of before) if (rel !== INDEX) assert.equal(existsSync(path.join(tree.appDir, rel)) ? readFileSync(path.join(tree.appDir, rel), 'utf8') : null, text, '其余文件逐字节还原：' + rel)
    for (const rel of maintenanceTargets) if (!before.has(rel)) assert.equal(existsSync(path.join(tree.appDir, rel)), false, 'owned-new/新增文件必须清掉：' + rel)
  } finally { tree.cleanup() }
})

test('现场产品2 旧CLI保留启动保护可接入且按现场解除', () => {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  try {
    const file = path.join(tree.appDir, INDEX)
    const raw = readFileSync(file, 'utf8')
    // 旧 CLI 卸后的用户当前代码：raw 经独立启动保护（纯变换，不读数据、不备份）
    const protectedCurrent = protectAuthorStartup(raw)
    assert.notEqual(protectedCurrent, raw, '前置：启动保护变换必须真的改了现场')
    writeFileSync(file, protectedCurrent, 'utf8')
    // ① 这种现场必须能接入（alreadyProtected 分支）
    const applied = applyStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
    assert.equal(applied.changed, true, '旧保护现场必须能接入并产生变更')
    assert.equal(applied.ready, true)
    // ② 卸载必须回到**现场**（保护后的当前代码），不是 raw
    assert.equal(uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true }).changed, true)
    const restored = readFileSync(file, 'utf8')
    assert.equal(restored, protectedCurrent, '卸载必须回到旧 CLI 保护后的现场，不得回 raw')
    assert.equal(restored.includes('[dsh-tavern-seam:'), false, '不得残留任何块标记')
    for (const [rel, text] of tree.original) if (rel !== INDEX) assert.equal(existsSync(path.join(tree.appDir, rel)) ? readFileSync(path.join(tree.appDir, rel), 'utf8') : null, text, '其余目标必须保持原字节：' + rel)
    for (const rel of maintenanceTargets) if (!tree.original.has(rel)) assert.equal(existsSync(path.join(tree.appDir, rel)), false, 'new-owned 必须清掉：' + rel)
  } finally { tree.cleanup() }
})
