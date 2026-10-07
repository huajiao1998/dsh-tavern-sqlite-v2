// 只验最新b741标准接缝：用随包恢复资产的官方源码组独占fixture，静态检查接缝产物（不加载SDK/业务/服务）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadAuthorCleanImages } from '../deploy/maintenance/residual-uninstall.mjs'
import { applyStandardSeams, checkStandardSeams } from '../deploy/standard-seams.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
const B741 = 'b74135535ec0b37b11ed77f252dd034c3ce5e285'
const NEW_APP = '04bda78eaad25adfe6979cb211a17fd85d852393'
const BRIDGE = 'tavern-plugin/lib/domain/storage-db-save.js'
const INDEX = 'tavern-plugin/lib/index.js'
const BRIDGE_BODY = '// [dsh-tavern-standard-owned:v1]\nimport { storagePackage } from \'./storage-package.js\'\nexport const { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } = await storagePackage(\'db-save-exchange\')\n'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(t, commit = B741) {
  const catalog = loadAuthorCleanImages(), tree = catalog.trees.find(item => item.commit === commit)
  assert.ok(tree, 'catalog 缺 tree：' + commit)
  const appDir = mkdtempSync(path.join(tmpdir(), 'dsh-db-latest-seams-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const target = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(item.body, 'base64'))
  }
  return { catalog, tree, appDir, index: path.join(appDir, ...INDEX.split('/')), bridge: path.join(appDir, ...BRIDGE.split('/')) }
}
test('DB最新04bda78标准接缝接同一SQL交换资源桥', t => {
  const f = fixture(t, NEW_APP)
  assert.equal(AUTHOR_VERSION, f.tree.authorVersion, '作者版本与04bda78树不一致')
  assert.equal(f.tree.authorVersion, '2.5.0')
  // 输入必须是官方新字节（不是旧 b741 bundle）：client.js 原始字节＝catalog 新树 sha，且含新代 UI 文案
  const clientPath = path.join(f.appDir, 'tavern-plugin', 'lib', 'client.js')
  const clientBefore = readFileSync(clientPath)
  assert.equal(sha(clientBefore), f.tree.files['tavern-plugin/lib/client.js'].sha256, '新代 client bundle 原始字节不是官方新字节')
  assert.ok(clientBefore.toString('utf8').includes('导入 SillyTavern 聊天记录'), '新代 client bundle 未含新代 UI 文案')
  assert.equal(checkStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION }).ready, false)
  const applied = applyStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION })
  assert.equal(applied.changed, true); assert.equal(applied.ready, true)
  assert.equal(checkStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION }).ready, true)
  assert.ok(readFileSync(clientPath).toString('utf8').includes('导入 SillyTavern 聊天记录'), '接缝破坏新代 client bundle 字节')
  const index = readFileSync(f.index, 'utf8')
  // 新代官方语义保存：lastSubmittedPosture import＋settleUserText(knownPosture) 与姿势结算路径不得被接缝破坏
  assert.ok(index.includes("lastSubmittedPosture, normalizePostureSubmission } from './domain/posture-submission.js'"), '新代官方 posture import 被破坏')
  assert.ok(index.includes('lastSubmittedPosture('), '新代官方姿势已知值调用被破坏')
  assert.ok(index.includes('knownPosture'), '新代 settleUserText knownPosture 语义被破坏')
  // b741 原有 DB 锚点语义保留（唯一入口 + 删局消费在 registry.remove 之前 + 卡校验契约）
  assert.equal(index.split('// [dsh-tavern-db-save:v1]').length - 1, 1)
  assert.ok(index.includes('  async function exportGameSave(sessionId, options = {}) {\n    return await dbSaveExchange.exportGameSave(sessionId, options)\n  }'))
  assert.ok(index.includes('  async function importGameSave(args) {\n    return await dbSaveExchange.importGameSave(args)\n  }'))
  const deleteCall = index.indexOf('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId')
  assert.ok(deleteCall > 0 && deleteCall < index.indexOf('const result = await conversationRegistry.remove(chatId)'), '删局消费未在 registry.remove 之前')
  assert.ok(index.includes("validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }"))
})
test('DB最新b741标准接缝接同一SQL交换资源桥', t => {
  const f = fixture(t)
  assert.equal(AUTHOR_VERSION, f.tree.authorVersion, '作者版本与b741树不一致')
  assert.equal(checkStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION }).ready, false)
  const applied = applyStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION })
  assert.equal(applied.changed, true); assert.equal(applied.ready, true)
  // apply 之后复检必须 ready：final index 派生链含 db-save transform 才算接齐
  assert.equal(checkStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION }).ready, true)
  const index = readFileSync(f.index, 'utf8'), bridge = readFileSync(f.bridge, 'utf8')
  // ① 桥：3 factory 生成体逐字，且与 catalog.ownedFiles 可信字节一致
  assert.equal(bridge, BRIDGE_BODY)
  assert.equal(sha(Buffer.from(bridge, 'utf8')), f.catalog.ownedFiles[BRIDGE][0])
  // ①b index：marker 唯一 + 3 factory import + 3 个 dbSave 常量装配
  assert.equal(index.split('// [dsh-tavern-db-save:v1]').length - 1, 1)
  assert.ok(index.includes("import { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } from './domain/storage-db-save.js'"))
  assert.ok(index.includes('const dbSaveExchange = createDbSaveExchange({'))
  // ② index：唯一两个 consumer RPC transport 保留、images 传输语义不改、原版旧函数体不残留
  assert.equal(index.split("case 'exportGameSave'").length - 1, 1)
  assert.equal(index.split("case 'importGameSave'").length - 1, 1)
  // b741 官方传输语义逐字保留：images !== false 与 args 透传不被接缝改写
  assert.ok(index.includes("case 'exportGameSave': return await exportGameSave(args && args.sessionId, { images: args && args.images !== false })"))
  assert.ok(index.includes("case 'importGameSave': return await importGameSave(args)"))
  // 旧函数体已被唯一新入口替换（不残留原版实现）
  assert.ok(index.includes('  async function exportGameSave(sessionId, options = {}) {\n    return await dbSaveExchange.exportGameSave(sessionId, options)\n  }'))
  assert.ok(index.includes('  async function importGameSave(args) {\n    return await dbSaveExchange.importGameSave(args)\n  }'))
  // ③ 登记补偿与资源桥都接在同一注入点，sceneFiles 旧 dep 不残留
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
  // 删局消费接在真实 b741 deleteChat 上，且位于 registry.remove 之前（只 stage 路径，不执行删除）
  const deleteCall = index.indexOf('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId')
  assert.ok(deleteCall > 0, '缺删局预检消费')
  assert.ok(deleteCall < index.indexOf('const result = await conversationRegistry.remove(chatId)'), '删局预检未在 registry.remove 之前')
  assert.equal(index.split('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId').length - 1, 1)
  // ④ 入口 renderer/image anchor 与 Set cache consumer 静态保留：官方字节未被接缝串改
  for (const literal of [
    "import { computeSceneTarget, createSceneIllustrations, sceneTarget } from './domain/scene-illustration.js'",
    'const importingGameSaves = new Set()',
    'const deletedChatIds = new Set()',
    'const original = sceneTarget(historical, target.turn)'
  ]) assert.ok(index.includes(literal), '官方锚点被串改：' + literal)
  assert.equal(index.split('const importingGameSaves = new Set()').length - 1, 1)
  assert.equal(index.split('const deletedChatIds = new Set()').length - 1, 1)
  // ⑤ 非接缝目标的官方字节保持逐字（package.json 不在接缝写集内）
  const pkg = readFileSync(path.join(f.appDir, 'tavern-plugin', 'package.json'), 'utf8')
  assert.equal(sha(Buffer.from(pkg, 'utf8')), f.tree.files['tavern-plugin/package.json'].sha256)
})
