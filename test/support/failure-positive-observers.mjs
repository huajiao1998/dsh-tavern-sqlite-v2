// 同源正向观察复用阶段快照；不注册其他场景、不共享业务状态。
import assert from 'node:assert/strict'
import { activeSource } from '../fixtures/comment-author-tree.mjs'
import { applyNativeMessageHostTransform } from '../../deploy/native-data-transform.mjs'
import { applyLatestFailureHostTransform, applyLatestFailureViewTransform } from '../../deploy/latest-failure-transform.mjs'
const INDEX_REL = 'tavern-plugin/lib/index.js'
const VIEW_REL = 'tavern-plugin/lib/domain/chat-session-state.js'
const DI_KEYS = ['appendMessages: appendMessagesNarrow,', 'setMessageFloor: setMessageFloorNarrow,']
const FAILURE_RPC = 'args.failureTarget || args.expectedTurn'
const FAILURE_FIELDS = [
  'failureTarget: latestFailureTarget(chat, replayTarget, evidence),',
  'failureCleanupReason: latestFailureCleanupReason(chat, replayTarget, evidence),',
  'canClearIncompleteReply: latestFailureTarget(chat, replayTarget, evidence) !== null,',
  'failureTarget: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}, evidence),',
]
/** 最终视图必须共用统一目标路径（窄摘要消费已迁 `lib/latest-send.js`：视图不再持有旧的 narrow 状态门）。
 *  此处只核 **ACTIVE 视图产物**里真实存在的接线，不用 lib 源码文本冒称产物内容。 */
const FINAL_VIEW_NEEDLES = [
  'latestSendTarget(chat, evidence,',
  'rollbackTargetTurn: latestSend?.turn',
]

export function registerFailureTests(test, lifecycle) {
  test('最新失败接线：标准完整施缝真作者树含DI与failureTarget并ready', async () => {
    const installed = await lifecycle.ensureInstalled()
    const noop = await lifecycle.ensureNoop()
    const applied = installed.applyResult
    assert.equal(applied.changed, true, '首装必须产生变更')
    assert.equal(applied.ready, true, '首装必须 ready')
    assert.equal(installed.ready.ready, true, '严格 check 必须 ready')
    const record = installed.record
    assert.equal(record.format, 1)
    assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
    assert.ok(Object.hasOwn(record.files, INDEX_REL), 'index 必须记成注释块文件')
    assert.ok(record.files[INDEX_REL].blocks.length > 0, 'index 必须有接缝块')
    // 注释块协议：作者旧代码按 '// ' 保留在 ORIGINAL 区 ⇒ 业务接线一律只看 ACTIVE 投影。
    const index = activeSource(installed.installed[INDEX_REL], INDEX_REL)
    for (const key of DI_KEYS) assert.equal(index.includes(key), true, '宿主 DI 必须接线到真实 index：' + key)
    assert.equal(index.includes('async function appendMessagesNarrow('), true, 'DI 闭包必须在位（appendMessages）')
    assert.equal(index.includes('async function setMessageFloorNarrow('), true, 'DI 闭包必须在位（setMessageFloor）')
    assert.equal(index.includes(FAILURE_RPC), true, 'RPC 必须带 failureTarget 参数接线')
    const view = activeSource(installed.installed[VIEW_REL], VIEW_REL)
    assert.equal(view.includes('function latestFailureTarget(chat, replayTarget, evidence) {'), true, '视图必须带 latestFailureTarget 助手（含 evidence）')
    assert.equal(view.includes('function latestFailureCleanupReason(chat, replayTarget, evidence) {'), true, '视图必须带 latestFailureCleanupReason 助手（含 evidence）')
    for (const needle of FINAL_VIEW_NEEDLES) assert.equal(view.includes(needle), true, '最终视图统一目标接线缺失：' + needle)
    assert.equal(view.includes('failureEnding'), false, '退役分类 helper failureEnding 不得残留在最终视图产物')
    for (const field of FAILURE_FIELDS) assert.equal(view.includes(field), true, '视图字段接线缺失：' + field)
    // 缺基准原因已改由后端只读 inspector 提供：视图不再持有旧文案字面量（只核真实路径）。
    assert.equal(view.includes('inspectNativeFailureTail(chat,evidence,'), true, '缺基准原因必须由后端只读 inspector 提供')
    assert.equal(view.includes("?.reason || ''"), true, 'inspector 的原因文本必须如实接线（不猜删）')
    // owned 垫片：applyStandardSeams 必须**真渲染**出 native-only/RPC 依赖的导出（不只 ready）
    const shimDomain = installed.installed['tavern-plugin/lib/domain/storage-rollback.js']
    assert.equal(shimDomain.includes("import { storagePackage } from './storage-package.js'"), true, 'domain 垫片必须走 storagePackage 转出')
    for (const name of ['cleanRollback', 'inspectNativeFailureTail', 'readFailureEvidence', 'latestSendTarget'])
      assert.equal(new RegExp("export const \\{[^}]*\\b" + name + "\\b[^}]*\\} = await storagePackage\\('clean-rollback'\\)").test(shimDomain), true, 'domain 垫片必须导出 ' + name)
    assert.equal(shimDomain.includes('export const { cleanupAfterRollback, preflightRollback, preflightRollbackAtSeq, cleanupAfterRollbackAtSeq } = impl'), true, 'domain 垫片原回退导出不得丢')
    assert.equal(shimDomain.includes('cleanupRollbackHeadIndex'), false, '退役L4不应再由垫片转出')
    // 视图就在 lib/domain，`./storage-rollback.js` 相对解析即该 domain 垫片；必须真 import（不是只写在常量里）
    assert.equal(VIEW_REL.includes('lib/domain/'), true, '被接线的视图必须位于 domain（相对 import 才指到该垫片）')
    assert.equal(view.includes("import { inspectNativeFailureTail } from './storage-rollback.js'"), true, '视图必须真的 import 该导出')
    // 该 evidence import 属于 index.js（沿用 :93 的 index）；视图侧只需下一句的 inspectNativeFailureTail
    assert.equal(index.includes("import { readFailureEvidence as readFailureEvidenceFromQuery } from './domain/storage-rollback.js'"), true, 'index 证据读口必须由 domain 垫片转出')
    // owned 导出必须是**真 runtime 函数类型**（presence 不等 type），与 core 实际实现对照
    const coreClean = await import(new URL('../../lib/clean-rollback.js', import.meta.url).href)
    const coreTarget = await import(new URL('../../lib/failure-cleanup-target.js', import.meta.url).href)
    const coreEvidence = await import(new URL('../../lib/failure-view-evidence.js', import.meta.url).href)
    assert.equal(typeof coreClean.cleanRollback, 'function', 'core cleanRollback 必须是函数')
    assert.equal(typeof coreTarget.inspectNativeFailureTail, 'function', 'core inspectNativeFailureTail 必须是函数')
    assert.equal(typeof coreEvidence.readFailureEvidence, 'function', 'core readFailureEvidence 必须是函数')
    assert.equal(coreEvidence.readFailureEvidence.constructor.name, 'AsyncFunction', 'core readFailureEvidence 必须是 async（冷读含 await lease 与 finally 释放）')
    assert.equal(coreEvidence.readFailureEvidence.length, 3, 'core readFailureEvidence 必须三参（liveEvidence, query, sessionId）')
    // owned 垫片经 storagePackage('clean-rollback') 转出的必须是**同一实现**（core export 路径严格覆盖）
    assert.equal(coreClean.readFailureEvidence, coreEvidence.readFailureEvidence, 'core clean-rollback 转出的 readFailureEvidence 必须与 failure-view-evidence 同一函数')
    assert.equal(coreClean.inspectNativeFailureTail, coreTarget.inspectNativeFailureTail, 'core clean-rollback 转出的 inspectNativeFailureTail 必须与 failure-cleanup-target 同一函数')
    // index 侧：DI 同时转出证据读口，且证据取用处包成 async（冷档 await 观察口）
    assert.equal(index.includes('get readFailureEvidence() { return readFailureEvidence }'), true, 'index nativeData DI 必须转出 readFailureEvidence getter')
    assert.equal(index.includes('const rollbackEvidence = { ...await readFailureEvidence(chat.sessionId, chat.id), activity }'), true, '首次视图必须等待当前chat/session的静止证明')
    assert.equal(index.includes('async function volatileSessionViewFields(chat, activity, changes)'), true, '缓存/dirty必须同样异步取证')
    assert.equal(index.includes('sessionStateView.volatile(chat, activity, changes, evidence)'), true, '易变视图必须传同一证明')
    assert.equal(index.split('await volatileSessionViewFields(chat, activity,').length - 1, 2, '缓存和dirty两个真实caller均必须等待')
    // 幂等：同树复跑不变更
    assert.equal(noop.noopResult.changed, false, '复跑必须幂等')
    // 宿主 DI 与失败接线的转换都必须可判定为"已应用"（复跑不重复插入）
    assert.equal(applyNativeMessageHostTransform(index), index, '宿主 DI 转换对已施缝 index 必须幂等')
    assert.equal(applyLatestFailureHostTransform(index), index, '失败宿主转换对已施缝 index 必须幂等')
    assert.equal(applyLatestFailureViewTransform(view), view, '失败视图转换对已施缝视图必须幂等')
  })
}
