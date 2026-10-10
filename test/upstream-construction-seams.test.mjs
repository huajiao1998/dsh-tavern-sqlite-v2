// 最新施工（42852b0/2.5.0 冻结源）三处宿主锚点：saveBodyEdit 通知保留 + rollback 回执保留 + fork lastNativeTurn 双形态幂等。
// 只断言本次施工改动，不做整产品全量。fork 必须先走 transformLegacyIndex 提供命名依赖链（coldRename 的块由该链插入）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { applyBodyEditEventTransform } from '../deploy/core-host-transform.mjs'
import { applyLatestFailureHostTransform } from '../deploy/latest-failure-transform.mjs'
import { applyForkHistoryTransform } from '../deploy/fork-history-transform.mjs'
import { transformLegacyIndex } from '../deploy/apply-legacy-view-seams.mjs'
import { prepareCommentAuthorTree, activeSource } from './fixtures/comment-author-tree.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { SAVE_HANDLERS } from '../save-handlers.js'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { parseSeamSource } from '../deploy/comment-seam-blocks.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const frozenRoot = process.env.DSH_TAVERN_TEST_APP || path.join(workspace, 'tmp/upstream-construction-20261010-42852b0/dsh-tavern-42852b0d160fc8d165faf291ddc779b71fc429ef')
const indexPath = path.join(frozenRoot, 'tavern-plugin/lib/index.js')

test('最新施工：三处宿主锚点', () => {
  assert.ok(existsSync(indexPath), '需要冻结的上游 index.js：' + indexPath)
  const source = readFileSync(indexPath, 'utf8')

  // ① saveBodyEdit：本次注入体必须在，且**作者的 notifyPluginTimeline('edit') 保留**；二次应用幂等。
  const bodyOnce = applyBodyEditEventTransform(source)
  assert.ok(bodyOnce.includes('// [dsh-tavern-body-edit-event:v1]'), '必须注入正文编辑事件标记')
  assert.ok(bodyOnce.includes("dispatchServerEvent({ sessionId, chat: current, event: 'MESSAGE_EDITED'"), '必须保留 MESSAGE_EDITED 服务端派发')
  assert.ok(bodyOnce.includes('await tavernScriptHostAdapter.dispatchServerEvent'), 'MESSAGE_EDITED 必须 await 在请求内完成')
  assert.ok(bodyOnce.includes("notifyPluginTimeline(sessionId, 'edit', { settled: true })"), '作者 saveBodyEdit 的 notifyPluginTimeline 必须保留')
  assert.equal(applyBodyEditEventTransform(bodyOnce), bodyOnce, '正文编辑接缝二次应用必须幂等')

  // ② rollbackTurn：失败目标透传 + 作者回执通知保留；二次应用幂等。
  const rollbackOnce = applyLatestFailureHostTransform(source)
  assert.ok(rollbackOnce.includes('(args.failureTarget || args.expectedTurn)'), 'rollbackTurn 必须透传 failureTarget')
  assert.ok(rollbackOnce.includes("notifyPluginTimeline(args && args.sessionId, 'rollback', { turn: args && args.expectedTurn })"), '作者 rollback 回执通知必须保留')
  assert.equal(applyLatestFailureHostTransform(rollbackOnce), rollbackOnce, '最新失败宿主接缝二次应用必须幂等')

  // ③ fork：先走 legacy 接缝链（coldRename/冷目标等命名块由该链提供），再施工 fork 归一化；二次应用幂等。
  const prepared = transformLegacyIndex(source)
  const forkNew = applyForkHistoryTransform(prepared)
  assert.ok(forkNew.includes('normalizeForkHistoryMarkers(forkConversationChat(state, { chatId: uid(\'chat\'), sessionId: targetId, id: uid, now: Date.now, lastNativeTurn })'), '必须保留上游 lastNativeTurn 并包裹归一化')
  assert.ok(forkNew.includes("import { normalizeForkHistoryMarkers } from './domain/storage-fork-history.js'"), '必须注入归一化 import')
  assert.equal(applyForkHistoryTransform(forkNew), forkNew, '新形态 fork 二次应用必须幂等')

  // ④ 旧形态（仅在 prepared 上删掉那一行的 lastNativeTurn）同样可施工，且二次幂等（本轮修的 marker 幂等分支）。
  const legacySource = prepared.replace(', lastNativeTurn })', ' })')
  assert.notEqual(legacySource, prepared, '旧形态构造必须实际改动那一行')
  const forkLegacy = applyForkHistoryTransform(legacySource)
  assert.ok(forkLegacy.includes('normalizeForkHistoryMarkers(forkConversationChat(state, { chatId: uid(\'chat\'), sessionId: targetId, id: uid, now: Date.now }), sessionEvents(target), atSeq)'), '旧形态必须走 legacy 注入体')
  assert.equal(applyForkHistoryTransform(forkLegacy), forkLegacy, '旧形态 fork 二次应用必须幂等（marker 分支认 legacy）')
})

// ② 完整接入与现场卸载（独立有限副本；只测本轮链的共同接入/源码语法/就绪/原文保留，不做整产品全量）。
test('最新施工：完整接入及现场卸载', t => {
  const previousRoot = process.env.DSH_TAVERN_TEST_APP
  process.env.DSH_TAVERN_TEST_APP = frozenRoot
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '需要真实冻结作者源码，不能跳过接入验收')
  const indexRel = 'tavern-plugin/lib/index.js'
  const builtClient = 'tavern-plugin/lib/client.js'
  const srcMain = 'tavern-plugin/src/client/main.js'
  const srcFeature = 'tavern-plugin/src/client/features/play-controls.js'
  const read = rel => readFileSync(path.join(tree.appDir, rel), 'utf8')
  const active = rel => activeSource(read(rel), rel)
  try {
    const stopped = () => true // 独立有限源码副本，无运行实例。
    const applied = applyStandardSeams({ appDir: tree.appDir, assertStopped: stopped })
    assert.equal(applied.ready, true)
    assert.equal(checkStandardSeams({ appDir: tree.appDir }).ready, true)
    const record = JSON.parse(read(COMMENT_SEAMS_RECORD))
    for (const rel of applied.written.filter(rel => rel.endsWith('.js'))) parseSeamSource(read(rel), { rel })

    // 现场生成的根解析器（owned-new）：作者原树**不含** storage-package.js 是设计预期，
    // 因此只断言施缝后现场：解析器被生成并登记为自有文件、且数据根落到标准目录。
    const resolverRel = applied.written.find(rel => rel.endsWith('storage-package.js'))
    assert.ok(resolverRel, '施缝必须现场生成 storage-package.js（owned-new），不要求作者原树自带')
    assert.ok(Object.hasOwn(record.owned, resolverRel), '生成的解析器必须登记为自有文件：' + resolverRel)
    const resolver = active(resolverRel)
    assert.ok(resolver.includes('resolveTavernDataRoot'), resolverRel + ' 必须提供数据根解析入口')
    assert.match(resolver, /['"]plugins['"]/, resolverRel + ' 必须解析到标准 plugins 目录')
    assert.ok(resolver.includes('dsh-tavern-sqlite-v2'), resolverRel + ' 必须落到本包目录名')
    // 存储消费者必须经**同一个**解析器取根，不再各自拼路径。
    const rootConsumers = applied.written.filter(rel => rel.endsWith('.js') && /from\s+['"]\.\/storage-package\.js['"]/.test(active(rel)))
    assert.ok(rootConsumers.length >= 2, '存储消费者必须经 storage-package.js 取根，实测 ' + rootConsumers.length + ' 个：' + rootConsumers.join(', '))

    // 桥在主客户端运行域提供，原错误行消费者在 play-controls 的功能闭包中。
    for (const rel of [builtClient, srcMain]) assert.ok(active(rel).includes('ctx.provide("tavernStorageView"'), rel)
    const playSource = active(srcMain).includes('// @include features/play-controls.js') ? srcFeature : srcMain
    for (const rel of [builtClient, playSource]) {
      assert.ok(active(rel).includes('storageUi.cleanFailure(props.sessionId, turn, failureTarget || liveTarget)'), rel)
      assert.equal(active(rel).includes('[dsh-tavern-save-ui-seam:'), false, rel)
      // props getter 变化后的强断言：storageUi 必须是运行时 ctx.get 取用（不得退化成装配期捕获的值）。
      assert.match(active(rel), /storageUi\s*:\s*(?:function\s*\([^)]*\)\s*\{|\(\s*\)\s*=>)[^}]{0,80}ctx\.get\(/, rel + ' 必须把 storageUi 接成 ctx.get 运行时取用')
    }
    for (const rel of [builtClient, 'tavern-plugin/src/client/turn-error-controls.js']) {
      assert.equal(active(rel).includes('[dsh-tavern-failure-fallback:'), false, rel)
      assert.equal(active(rel).includes('function syncFailureRow('), false, rel)
    }
    const installed = active(indexRel)
    assert.equal(installed.split("ctx.provide('tavernSaveActions'").length - 1, 1)
    assert.ok(installed.includes('chats: chatPersistence, runtimeGeneration,'))
    for (const method of Object.keys(SAVE_HANDLERS)) assert.equal(installed.includes("case '" + method + "':"), false, method)
    assert.ok(installed.includes('lastNativeTurn'))
    assert.equal(maintenanceTargets.length, 58)

    // 块外用户说明必须保留，卸载恢复现场原文而非旧官方整文件。
    const userComment = '\n// 用户现场说明，卸载必须保留\n'
    writeFileSync(path.join(tree.appDir, indexRel), read(indexRel) + userComment, 'utf8')
    const removed = uninstallStandardSeams({ appDir: tree.appDir, assertStopped: stopped })
    assert.equal(removed.changed, true)
    for (const [rel, original] of tree.original) assert.equal(read(rel), original + (rel === indexRel ? userComment : ''), rel)
    for (const rel of Object.keys(record.owned)) assert.equal(existsSync(path.join(tree.appDir, rel)), false, rel)
    assert.equal(existsSync(path.join(tree.appDir, COMMENT_SEAMS_RECORD)), false)
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_TAVERN_TEST_APP
    else process.env.DSH_TAVERN_TEST_APP = previousRoot
    tree.cleanup()
  }
})

test('最新施工：a2008bf完整接缝安装就绪并卸载保留现场修改', () => {
  const root = path.join(workspace, 'tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312')
  assert.ok(existsSync(path.join(root, 'tavern-plugin/package.json')), '需要固定a2008bf公开源码，不能回落旧树')
  const previous = process.env.DSH_TAVERN_TEST_APP
  process.env.DSH_TAVERN_TEST_APP = root
  let tree
  try {
    tree = prepareCommentAuthorTree()
    assert.ok(tree, '必须实际准备新树隔离副本')
    const stopped = () => true
    const read = rel => readFileSync(path.join(tree.appDir, rel), 'utf8')
    const applied = applyStandardSeams({ appDir: tree.appDir, assertStopped: stopped })
    assert.equal(applied.ready, true)
    assert.equal(checkStandardSeams({ appDir: tree.appDir }).ready, true)
    const record = JSON.parse(read(COMMENT_SEAMS_RECORD))
    for (const rel of applied.written.filter(rel => rel.endsWith('.js'))) parseSeamSource(read(rel), { rel })
    const indexRel = 'tavern-plugin/lib/index.js'
    const installed = activeSource(read(indexRel), indexRel)
    // 区块描述器按语法节点保存实现，内部辅助注释不作为准入条件；检查实际新入口消费者。
    const editStart = installed.indexOf('editText: async (material, text) =>')
    assert.ok(editStart >= 0, '必须保留新编辑入口')
    const editBody = installed.slice(editStart, installed.indexOf('runTask: runPluginTask', editStart))
    assert.ok(editBody.includes('await bodyEditor.replaceText(sessionId, text)'), '必须执行真实正文保存')
    assert.ok(editBody.includes("await tavernScriptHostAdapter.dispatchServerEvent({ sessionId, chat: current, event: 'MESSAGE_EDITED', args: [after.to] })"), '必须实际施新编辑入口事件')
    assert.equal(installed.split("event: 'MESSAGE_EDITED'").length - 1, 2, '旧UI与新插件编辑各一条事件派发')
    assert.ok(installed.includes('playWorldBook(chat, card)'), '保留作者新世界书调用链')
    assert.ok(installed.includes("source: 'plugin.variables'"), '保留作者新变量写入链')
    const note = '\n// 用户新树现场说明，卸载不能回盖\n'
    writeFileSync(path.join(tree.appDir, indexRel), read(indexRel) + note, 'utf8')
    assert.equal(uninstallStandardSeams({ appDir: tree.appDir, assertStopped: stopped }).changed, true)
    for (const [rel, original] of tree.original) assert.equal(read(rel), original + (rel === indexRel ? note : ''), rel)
    for (const rel of Object.keys(record.owned)) assert.equal(existsSync(path.join(tree.appDir, rel)), false, rel)
    assert.equal(existsSync(path.join(tree.appDir, COMMENT_SEAMS_RECORD)), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_TAVERN_TEST_APP
    else process.env.DSH_TAVERN_TEST_APP = previous
    tree?.cleanup()
  }
})
