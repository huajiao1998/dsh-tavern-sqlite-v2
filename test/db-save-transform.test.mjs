// 只验新原菜单Host转换，不加载真实作者Host或SDK。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDbSaveHostTransform, applyDbSaveDeleteTransform, DB_SAVE_MARKER } from '../deploy/db-save-transform.mjs'
const source = `export async function apply(ctx) {
  async function exportGameSave(sessionId, options = {}) {
    const revisions = await collectSaveRevisions(chat, readChatRevision)
    return buildGameSave({ chat, revisions })
  }
  // Imports always create a new game: new chat and session ids, the native session rebuilt
  const importingGameSaves = new Set()
  async function importGameSave(args) {
    const save = readGameSave(args.fileB64)
    try {
      await rawWriteChat(save.chat)
    } finally { importingGameSaves.delete(sourceChatId) }
  }
  async function dispatch(method,args) {
    switch(method) {
      case 'importGameSave': return await importGameSave(args)
      case 'exportGameSave': return await exportGameSave(args.sessionId, {images:args.images})
    }
  }
}`
test('DB原按钮唯一导入导出入口', () => {
  const next = applyDbSaveHostTransform(source)
  assert.ok(next.includes('return await dbSaveExchange.exportGameSave(sessionId, options)'))
  assert.ok(next.includes('return await dbSaveExchange.importGameSave(args)'))
  assert.ok(!next.includes('collectSaveRevisions(chat'))
  assert.ok(!next.includes('rawWriteChat(save.chat)'))
  assert.ok(next.includes("case 'importGameSave'")); assert.ok(next.includes("case 'exportGameSave'"))
  // 3 factory import + 真实新 deps（旧 sceneFiles dep 已删）
  assert.ok(next.includes("import { createDbSaveExchange, createDbSaveRegistration, createDbSaveResourceTransfer } from './domain/storage-db-save.js'"))
  for (const literal of [
    'const dbSaveRegistration = createDbSaveRegistration({ store: profileData })',
    'const dbSaveResources = createDbSaveResourceTransfer({',
    "fileResources, profileData, gameFootprint, attachments: ctx.get('attachments'),",
    'readChatCard, importCard, computeSceneTarget,',
    "validateCard: async payload => { const card = await cardPreparation.create({ kind: 'import', payload }); return { raw: cardPreparation.present({ card, as: 'raw' }), definition: cardPreparation.project(card) } }",
    'resources: dbSaveResources,',
    'unpublish: identity => dbSaveRegistration.discard(identity)'
  ]) assert.ok(next.includes(literal), '缺新接缝字面：' + literal)
  assert.ok(!next.includes('sceneFiles:'))
  // 装配顺序 registration → resource → exchange，RPC 委托在 exchange 之后
  const order = ['const dbSaveRegistration = createDbSaveRegistration(', 'const dbSaveResources = createDbSaveResourceTransfer(', 'const dbSaveExchange = createDbSaveExchange('].map(literal => next.indexOf(literal))
  assert.ok(order.every(at => at >= 0) && order[0] < order[1] && order[1] < order[2], '装配顺序应为 registration→resource→exchange')
  assert.ok(next.indexOf('return await dbSaveExchange.importGameSave(args)') > order[2])
})
test('DB接缝幂等并拒半装配', () => {
  const next = applyDbSaveHostTransform(source)
  assert.equal(applyDbSaveHostTransform(next), next)
  assert.throws(() => applyDbSaveHostTransform(DB_SAVE_MARKER + source), /消费者缺失/)
  // required 现含资源 factory 与 resources dep：缺任一项必须 fail-closed，不静默半装配
  assert.throws(() => applyDbSaveHostTransform(next.replace('resources: dbSaveResources,', '')), /消费者缺失/)
  assert.throws(() => applyDbSaveHostTransform(next.replace('const dbSaveResources = createDbSaveResourceTransfer({', 'const dbSaveResources = createOther({')), /消费者缺失/)
  // 删局消费：含真实 deleteChat 的源才接入，且插在 registry.remove 之前；无删局源保持原样（旧最小夹具兼容）
  const deleteSource = '  async function deleteChat(chatId) {\n    const result = await conversationRegistry.remove(chatId)\n    return result\n  }\n'
  const withDelete = applyDbSaveDeleteTransform(deleteSource)
  const callAt = withDelete.indexOf('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId')
  assert.ok(callAt > 0 && callAt < withDelete.indexOf('const result = await conversationRegistry.remove(chatId)'), '删局预检未插在 registry.remove 之前')
  assert.equal(applyDbSaveDeleteTransform(withDelete), withDelete)
  assert.equal(applyDbSaveDeleteTransform('const x = 1\n'), 'const x = 1\n')
  // 旧 v1 标记源（缺删局消费）在含真实 deleteChat 时须被升级补齐，再幂等
  const legacy = applyDbSaveHostTransform(source) + deleteSource
  const upgraded = applyDbSaveHostTransform(legacy)
  assert.ok(upgraded.includes('dbSaveDeleteFootprint(chatId, [footprint.foregroundSessionId'), '旧 v1 标记源未升级删局消费')
  assert.equal(applyDbSaveHostTransform(upgraded), upgraded)
})
test('DB接缝原菜单锚点缺失拒绝', () => {
  assert.throws(() => applyDbSaveHostTransform(source.replace('  async function importGameSave(args) {', '  async function oldImport(args) {')), /锚点不唯一/)
  assert.throws(() => applyDbSaveHostTransform(source + '\n  const importingGameSaves = new Set()'), /锚点不唯一/)
})
