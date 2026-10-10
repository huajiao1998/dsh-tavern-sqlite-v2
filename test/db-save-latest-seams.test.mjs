// DB 交换桥标准接缝（块机制版）：夹具＝fixtures/comment-author-tree.mjs 的真实作者源码有限复制（env DSH_TAVERN_TEST_APP 可显式指定该代）；
// 无夹具或夹具不是目标作者代时 skip（不造 catalog API、不假造旧树字节）；记录期待改用新 files/blocks/owned 形状；不加载 SDK/业务/服务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { STANDARD_RECORD } from '../deploy/maintenance/source.mjs'
const BRIDGE = 'tavern-plugin/lib/domain/storage-db-save.js'
const INDEX = 'tavern-plugin/lib/index.js'
const CLIENT = 'tavern-plugin/lib/client.js'
const BRIDGE_BODY = '// [dsh-tavern-standard-owned:v1]\nimport { storagePackage } from \'./storage-package.js\'\nexport const { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } = await storagePackage(\'db-save-exchange\')\n'
function fixture(t) {
  const prepared = prepareCommentAuthorTree()
  if (!prepared) return null
  t.after(() => prepared.cleanup())
  const file = rel => path.join(prepared.appDir, ...rel.split('/'))
  return { appDir: prepared.appDir, original: prepared.original, index: file(INDEX), bridge: file(BRIDGE), client: file(CLIENT), record: file(STANDARD_RECORD) }
}
const needTree = (f, rel, literal, label) => {
  if (!f) return '无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）'
  if (!(f.original.get(rel) ?? '').includes(literal)) return label + '：请用 DSH_TAVERN_TEST_APP 指向该代作者源码'
  return null
}

test('DB最新作者代标准接缝接同一SQL交换资源桥', t => {
  const f = fixture(t)
  const skip = needTree(f, CLIENT, '导入 SillyTavern 聊天记录', '当前夹具不是含新代 UI 文案的作者代')
  if (skip) return t.skip(skip)
  assert.equal(checkStandardSeams({ appDir: f.appDir }).ready, false, '未接缝树不得 ready')
  const applied = applyStandardSeams({ appDir: f.appDir, assertStopped: () => true })
  assert.equal(applied.changed, true); assert.equal(applied.ready, true)
  assert.equal(checkStandardSeams({ appDir: f.appDir }).ready, true)
  assert.ok(readFileSync(f.client, 'utf8').includes('导入 SillyTavern 聊天记录'), '接缝破坏新代 client bundle 字节')
  const rawIndex = readFileSync(f.index, 'utf8')
  // 注释块协议：业务字节看 ACTIVE 投影；raw 只承担块标记计数（与测试②同口径）。
  const index = activeSource(rawIndex, INDEX)
  // 新代官方语义保存：posture import 与已知姿势结算路径不得被接缝破坏
  assert.ok(index.includes("lastSubmittedPosture, normalizePostureSubmission } from './domain/posture-submission.js'"), '新代官方 posture import 被破坏')
  assert.ok(index.includes('lastSubmittedPosture('), '新代官方姿势已知值调用被破坏')
  assert.ok(index.includes('knownPosture'), '新代 settleUserText knownPosture 语义被破坏')
  // DB 锚点语义保留：唯一入口 + 删局消费在 registry.remove 之前 + 卡校验契约
  assert.equal(rawIndex.split('// [dsh-tavern-db-save:v1]').length - 1, 1)
  assert.ok(index.includes('  async function exportGameSave(sessionId, options = {}) {\n    return await dbSaveExchange.exportGameSave(sessionId, options)\n  }'))
  assert.ok(index.includes('  async function importGameSave(args) {\n    return await dbSaveExchange.importGameSave(args)\n  }'))
  const deleteCall = index.indexOf('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId')
  assert.ok(deleteCall > 0 && deleteCall < index.indexOf('const result = await conversationRegistry.remove(chatId)'), '删局消费未在 registry.remove 之前')
  assert.ok(index.includes("validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }"))
})

// 注（T4）：原第 2 条「DB标准接缝桥为owned-new且卸载逐字节还原」已迁至 support/db-positive-observers.mjs
// （逐条断言改成读共享生命周期阶段快照）并注册在 test/standard-positive.test.mjs 统一入口；本文件只保留第 1 条（最新 UI capability）。
