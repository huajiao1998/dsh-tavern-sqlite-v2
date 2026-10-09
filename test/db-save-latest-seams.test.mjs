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

test('DB标准接缝桥为owned-new且卸载逐字节还原', t => {
  const f = fixture(t)
  const skip = needTree(f, INDEX, "case 'exportGameSave': return await exportGameSave(", '当前夹具不是目标作者代')
  if (skip) return t.skip(skip)
  assert.equal(applyStandardSeams({ appDir: f.appDir, assertStopped: () => true }).changed, true)
  assert.equal(checkStandardSeams({ appDir: f.appDir }).ready, true)
  const rawIndex = readFileSync(f.index, 'utf8'), bridge = readFileSync(f.bridge, 'utf8')
  // 注释块协议：raw 里 BEGIN/END 标记与 ORIGINAL 注释会打断连续字面 ⇒ 业务字节一律看 ACTIVE 投影；
  // raw 只承担"块标记计数"这类协议层断言（marker 恰一处、RPC case 不重复等）。
  const index = activeSource(rawIndex, INDEX)
  // ① 桥：自有新文件以完整 owned-file 注释区块承载；ACTIVE 投影逐字等于自有实现（业务字节不变）。
  assert.ok(bridge.includes('[dsh-tavern-seam:BEGIN]') && bridge.includes('id=owned-file') && bridge.includes('[dsh-tavern-seam:END]'), '自有桥必须是完整 owned-file 注释区块')
  const record = JSON.parse(readFileSync(f.record, 'utf8'))
  assert.equal(record.format, 1); assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
  assert.deepEqual(Object.keys(record).sort(), ['files', 'format', 'owned', 'owner'])
  assert.equal(record.owned[BRIDGE]?.mode, 'owned-new', '自有桥必须以 owned-new 记录')
  // 新契约：owned 记录只留 metadata 四键（不存 body）；实现字节从现场 owned-file 块的 ACTIVE 投影读。
  assert.deepEqual(Object.keys(record.owned[BRIDGE]).sort(), ['format', 'mode', 'owner', 'rel'], 'owned 记录只留 metadata 四键')
  assert.equal(Object.hasOwn(record.owned[BRIDGE], 'body'), false, 'owned 记录不得保存 body 历史')
  assert.equal(activeSource(bridge, BRIDGE), BRIDGE_BODY, 'ACTIVE 投影必须逐字等于自有实现（业务字节不变）')
  assert.ok(record.files[INDEX]?.blocks?.length >= 1, 'index 必须以块记录承载接缝')
  assert.equal(record.files[BRIDGE], undefined, '自有新文件不进 blocks 表')
  // ①b index：marker 唯一（raw 计数）+ 3 factory import + 3 个 dbSave 常量装配（ACTIVE 投影看字节）
  assert.equal(rawIndex.split('// [dsh-tavern-db-save:v1]').length - 1, 1)
  assert.equal(rawIndex.split('[dsh-tavern-seam:BEGIN]').length - 1, rawIndex.split('[dsh-tavern-seam:END]').length - 1)
  assert.ok(index.includes("import { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } from './domain/storage-db-save.js'"))
  assert.ok(index.includes('const dbSaveExchange = createDbSaveExchange({'))
  // ② 两个 consumer RPC transport 保留、images 传输语义不改
  assert.equal(index.split("case 'exportGameSave'").length - 1, 1)
  assert.equal(index.split("case 'importGameSave'").length - 1, 1)
  assert.ok(index.includes("case 'exportGameSave': return await exportGameSave(args && args.sessionId, { images: args && args.images !== false })"))
  assert.ok(index.includes("case 'importGameSave': return await importGameSave(args)"))
  assert.ok(index.includes('  async function exportGameSave(sessionId, options = {}) {\n    return await dbSaveExchange.exportGameSave(sessionId, options)\n  }'))
  assert.ok(index.includes('  async function importGameSave(args) {\n    return await dbSaveExchange.importGameSave(args)\n  }'))
  // ③ 登记补偿与资源桥接在同一注入点，sceneFiles 旧 dep 不残留
  for (const literal of [
    'const dbSaveRegistration = createDbSaveRegistration({ store: profileData })',
    'const dbSaveResources = createDbSaveResourceTransfer({',
    'resources: dbSaveResources,',
    "attachments: ctx.get('attachments'),",
    'computeSceneTarget,',
    "validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }",
    'unpublish: identity => dbSaveRegistration.discard(identity)',
    'await tavernScriptHostAdapter.whenIdle(chat.sessionId)'
  ]) assert.ok(index.includes(literal), '缺接缝字面：' + literal)
  assert.equal(index.includes('sceneFiles:'), false)
  // 删局消费接在真实 deleteChat 上，位于 registry.remove 之前且唯一
  const deleteCall = index.indexOf('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId')
  assert.ok(deleteCall > 0, '缺删局预检消费')
  assert.ok(deleteCall < index.indexOf('const result = await conversationRegistry.remove(chatId)'), '删局预检未在 registry.remove 之前')
  assert.equal(index.split('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId').length - 1, 1)
  // ④ 官方锚点与 Set cache consumer 未被串改
  for (const literal of [
    "import { computeSceneTarget, createSceneIllustrations, sceneTarget } from './domain/scene-illustration.js'",
    'const importingGameSaves = new Set()',
    'const deletedChatIds = new Set()',
    'const original = sceneTarget(historical, target.turn)'
  ]) assert.ok(index.includes(literal), '官方锚点被串改：' + literal)
  assert.equal(index.split('const importingGameSaves = new Set()').length - 1, 1)
  assert.equal(index.split('const deletedChatIds = new Set()').length - 1, 1)
  // ⑤ 卸载必须按块记录与 owned body 逐字节还原到接缝前
  assert.equal(uninstallStandardSeams({ appDir: f.appDir, assertStopped: () => true }).changed, true)
  const bridgeOriginal = f.original.get(BRIDGE)
  if (bridgeOriginal === undefined) assert.equal(existsSync(f.bridge), false, '卸载后 owned-new 文件必须被删除')
  else assert.equal(readFileSync(f.bridge, 'utf8'), bridgeOriginal, '卸载后桥必须逐字节还原作者原文')
  assert.equal(readFileSync(f.index, 'utf8'), f.original.get(INDEX), '卸载后 index 必须逐字节还原作者原文')
  assert.equal(checkStandardSeams({ appDir: f.appDir }).ready, false, '卸载后不得 ready')
})
