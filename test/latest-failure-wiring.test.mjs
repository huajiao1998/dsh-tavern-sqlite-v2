// 最新失败接线（主新增 transform）的具名独立覆盖：只写不跑，待主批准后一次 gate（pattern '最新失败接线'，共 4 条）。
//   ① 标准完整施缝：真实作者 source fixture（helper 有限复制 maintenanceTargets + 作者包）⇒ applyStandardSeams ⇒ ready，
//      且产物**ACTIVE 投影**同时含 host DI（appendMessages/setMessageFloor 两键）与 failureTarget/failureCleanupReason 接线
//      （RPC 参数、视图字段、窄摘要分支）。
//   ② transform 自身：RPC/视图两转换作用在**完整 pending 状态 source** 上幂等，缺块/半应用/标记异常一律拒。
//   ③ 窄摘要分支：变换产物内真函数 latestFailureTarget/latestFailureCleanupReason 对 chat.failureCleanup 的采信与原因优先级。
//   ④ queryFailureCleanup：真 node:sqlite 临时库五场景（基准在位／缺基准／检查点／正文行／任务推进）。
// 只读夹具、只清自建 mkdtemp；不联网/不读真实档/不动主 standard-seams 与 latest-failure 文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { applyStandardSeams, checkStandardSeams } from '../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { applyRollbackPendingViewTransform } from '../deploy/rollback-pending-view-transform.mjs'
import { applyLatestFailureHostTransform, applyLatestFailureViewTransform } from '../deploy/latest-failure-transform.mjs'
import { queryFailureCleanup } from '../lib/chat-query-service.js'
import { applyNativeMessageHostTransform } from '../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const INDEX_REL = 'tavern-plugin/lib/index.js'
const VIEW_REL = 'tavern-plugin/lib/domain/chat-session-state.js'
const DI_KEYS = ['appendMessages: appendMessagesNarrow,', 'setMessageFloor: setMessageFloorNarrow,']
const FAILURE_RPC = 'args.failureTarget || args.expectedTurn'
const FAILURE_FIELDS = [
  'failureTarget: latestFailureTarget(chat, replayTarget),',
  'failureCleanupReason: latestFailureCleanupReason(chat, replayTarget),',
  'canClearIncompleteReply: latestFailureTarget(chat, replayTarget) !== null,',
  'failureTarget: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}),',
]
/** 窄摘要分支必须逐项在位（缺失＝退回"窄视图永远无目标"，就是本次修复要消掉的行为）。 */
const NARROW_NEEDLES = [
  'const narrow = chat.failureCleanup',
  'narrow.cleanable === true',
  'Number(narrow.revision) === Number(chat._storageRevision)',
  'Number.isSafeInteger(Number(narrow.turn)) && Number(narrow.turn) >= 1 && narrow.operationId',
  'if (narrow && narrow.cleanable !== true && narrow.reason) return narrow.reason',
]
const trees = []
/** 真实作者 source fixture → 自有 mkdtemp（helper 只复制维护 targets + 作者包；缺失即响亮失败，不 skip）。 */
const buildTree = () => {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  trees.push(tree)
  return tree
}
const read = (tree, rel) => readFileSync(path.join(tree.appDir, rel), 'utf8')
test.after(() => { for (const tree of trees) tree.cleanup() })   // 只清 helper 自建目录

test('最新失败接线：标准完整施缝真作者树含DI与failureTarget并ready', async () => {
  const tree = buildTree(), app = tree.appDir
  const applied = applyStandardSeams({ appDir: app, authorVersion: AUTHOR_VERSION, assertStopped: () => true })
  assert.equal(applied.changed, true, '首装必须产生变更')
  assert.equal(applied.ready, true, '首装必须 ready')
  assert.equal(checkStandardSeams({ appDir: app }).ready, true, '严格 check 必须 ready')
  const record = JSON.parse(readFileSync(path.join(app, COMMENT_SEAMS_RECORD), 'utf8'))
  assert.equal(record.format, 1)
  assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
  assert.ok(Object.hasOwn(record.files, INDEX_REL), 'index 必须记成注释块文件')
  assert.ok(record.files[INDEX_REL].blocks.length > 0, 'index 必须有接缝块')
  // 注释块协议：作者旧代码按 '// ' 保留在 ORIGINAL 区 ⇒ 业务接线一律只看 ACTIVE 投影。
  const index = activeSource(read(tree, INDEX_REL), INDEX_REL)
  for (const key of DI_KEYS) assert.equal(index.includes(key), true, '宿主 DI 必须接线到真实 index：' + key)
  assert.equal(index.includes('async function appendMessagesNarrow('), true, 'DI 闭包必须在位（appendMessages）')
  assert.equal(index.includes('async function setMessageFloorNarrow('), true, 'DI 闭包必须在位（setMessageFloor）')
  assert.equal(index.includes(FAILURE_RPC), true, 'RPC 必须带 failureTarget 参数接线')
  const view = activeSource(read(tree, VIEW_REL), VIEW_REL)
  assert.equal(view.includes('function latestFailureTarget(chat, replayTarget) {'), true, '视图必须带 latestFailureTarget 助手')
  assert.equal(view.includes('function latestFailureCleanupReason(chat, replayTarget) {'), true, '视图必须带 latestFailureCleanupReason 助手')
  for (const needle of NARROW_NEEDLES) assert.equal(view.includes(needle), true, '窄摘要分支缺失：' + needle)
  for (const field of FAILURE_FIELDS) assert.equal(view.includes(field), true, '视图字段接线缺失：' + field)
  assert.equal(view.includes("'当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理'"), true, '缺基准原因必须如实接线（不猜删）')
  // 幂等：同树复跑不变更
  assert.equal(applyStandardSeams({ appDir: app, assertStopped: () => true }).changed, false, '复跑必须幂等')
  // 宿主 DI 与失败接线的转换都必须可判定为"已应用"（复跑不重复插入）
  assert.equal(applyNativeMessageHostTransform(index), index, '宿主 DI 转换对已施缝 index 必须幂等')
  assert.equal(applyLatestFailureHostTransform(index), index, '失败宿主转换对已施缝 index 必须幂等')
  assert.equal(applyLatestFailureViewTransform(view), view, '失败视图转换对已施缝视图必须幂等')
})

test('最新失败接线：RPC与投影幂等及缺块拒绝', async () => {
  const tree = buildTree()
  const indexRaw = read(tree, INDEX_REL)
  // RPC：真完整 index source（含 pending 状态字段所在的整文件）
  const hostOnce = applyLatestFailureHostTransform(indexRaw)
  assert.equal(hostOnce.includes(FAILURE_RPC), true, 'RPC 必须改为 failureTarget 优先')
  assert.equal(hostOnce.includes('// [dsh-tavern-latest-failure-host:v1]'), true, '宿主标记必须在位')
  assert.equal(applyLatestFailureHostTransform(hostOnce), hostOnce, '宿主复跑必须幂等')
  assert.throws(() => applyLatestFailureHostTransform(hostOnce.replace(FAILURE_RPC, 'args.expectedTurn')), /不完整/, '缺 RPC 改动必须拒')
  assert.throws(() => applyLatestFailureHostTransform(hostOnce + '\n// [dsh-tavern-latest-failure-host:v1]\n'), /不完整/, '标记重复必须拒')
  assert.throws(() => applyLatestFailureHostTransform(indexRaw.replace("case 'rollbackTurn': return { view: await rollbackTurn(args && args.sessionId, args && args.chatId, args && args.expectedTurn) }", '')), /锚点缺失\/不唯一/, '锚点缺失必须拒')
  // 视图：真完整 chat-session-state source；失败视图接缝接在**既有 pending 视图转换产物**之后（真实标准组合顺序）
  const viewRaw = applyRollbackPendingViewTransform(read(tree, VIEW_REL))
  const viewOnce = applyLatestFailureViewTransform(viewRaw)
  for (const field of FAILURE_FIELDS) assert.equal(viewOnce.includes(field), true, '视图字段必须接线：' + field)
  assert.equal(viewOnce.includes('// [dsh-tavern-latest-failure-view:v1]'), true, '视图标记必须在位')
  assert.equal(applyLatestFailureViewTransform(viewOnce), viewOnce, '视图复跑必须幂等')
  assert.throws(() => applyLatestFailureViewTransform(viewOnce.replace('canClearIncompleteReply: latestFailureTarget(chat, replayTarget) !== null,', 'canClearIncompleteReply: false,')), /不完整/, '缺视图改动必须拒')
  assert.throws(() => applyLatestFailureViewTransform(viewOnce + '\n// [dsh-tavern-latest-failure-view:v1]\n'), /不完整/, '视图标记重复必须拒')
  assert.throws(() => applyLatestFailureViewTransform(viewRaw.replace('      canReplayFailedTurn: replayTarget !== null,', '')), /锚点缺失\/不唯一/, '视图锚点缺失必须拒')
})

/** 从变换产物里按花括号配对取出真实函数文本（与 save-ui-seam/extractFunction 同法，不用正则猜边界）。 */
function extractFunction(text, header) {
  const start = text.indexOf(header)
  assert.ok(start >= 0, '应能定位 ' + header)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('函数花括号不平衡：' + header)
}
/** 取出两个助手真身并在本进程求值：断言的是**变换产物里的那份代码**，不是复述的替身。 */
function failureHelpers(source) {
  const text = extractFunction(source, 'function latestFailureTarget(chat, replayTarget) {')
    + '\n' + extractFunction(source, 'function latestFailureCleanupReason(chat, replayTarget) {')
    + '\nreturn { latestFailureTarget, latestFailureCleanupReason }'
  return new Function(text)()
}

test('最新失败接线：窄摘要分支与原因优先级（变换产物内真函数）', async () => {
  const tree = buildTree()
  const viewOnce = applyLatestFailureViewTransform(applyRollbackPendingViewTransform(read(tree, VIEW_REL)))
  const { latestFailureTarget, latestFailureCleanupReason } = failureHelpers(viewOnce)
  const narrow = { cleanable: true, revision: 9, turn: 7, operationId: 'op7', branchId: 'b1' }
  const chat = { id: 'c1', sessionId: 's1', _storageRevision: 9, failureCleanup: narrow }
  assert.deepEqual(latestFailureTarget(chat, null),
    { chatId: 'c1', sessionId: 's1', turn: 7, branchId: 'b1', revision: 9, operationId: 'op7' },
    '窄摘要 cleanable 且 revision 相符 ⇒ 直接给目标（窄视图不再永远 null）')
  assert.equal(latestFailureTarget({ ...chat, _storageRevision: 10 }, null), null, '窄摘要 revision 与现场不符 ⇒ 不采信')
  assert.equal(latestFailureTarget({ ...chat, failureCleanup: { ...narrow, turn: 0 } }, null), null, '窄摘要 turn 非安全整数 ⇒ 不采信')
  assert.equal(latestFailureTarget({ ...chat, failureCleanup: { ...narrow, operationId: '' } }, null), null, '窄摘要缺 operationId ⇒ 不采信')
  // pending 形态仍优先于窄摘要（半提交只许完成同一清理）。
  assert.equal(latestFailureTarget({ ...chat, rollbackPending: { id: 'rb1', failureTarget: { turn: 6, operationId: 'op6', branchId: 'b0' } } }, null).turn, 6,
    'rollbackPending.failureTarget 优先')
  assert.equal(latestFailureCleanupReason(chat, null), '', '窄摘要 cleanable ⇒ 无原因')
  assert.equal(latestFailureCleanupReason({ ...chat, failureCleanup: { cleanable: false, reason: '该失败轮缺少发轮前回退基准，不能安全清理' } }, null),
    '该失败轮缺少发轮前回退基准，不能安全清理', '窄摘要 reason 优先于通用原因')
  assert.equal(latestFailureCleanupReason({ id: 'c1', sessionId: 's1', _storageRevision: 9 }, { turn: 7 }),
    '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理', '无窄摘要且 replayTarget 不可清 ⇒ 原因回落')
})

test('最新失败接线：queryFailureCleanup 真实SQLite五场景', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tavern-failure-cleanup-'))
  const db = new DatabaseSync(path.join(dir, 'archive.db'))
  try {
    // DDL 参照 lib/timeline-nodes.js:27-31（timeline 子行表）与 chat-sqlite-store.js:551-554（消息行）。
    db.exec('CREATE TABLE IF NOT EXISTS archive_timeline_nodes (node_key TEXT PRIMARY KEY, ord INTEGER NOT NULL, value_json TEXT NOT NULL)')
    db.exec('CREATE TABLE IF NOT EXISTS archive_messages (message_index INTEGER PRIMARY KEY, message_json TEXT NOT NULL)')
    const node = (key, value) => db.prepare('INSERT OR REPLACE INTO archive_timeline_nodes (node_key,ord,value_json) VALUES (?,?,?)').run(key, 0, JSON.stringify(value))
    const dropNode = key => db.prepare('DELETE FROM archive_timeline_nodes WHERE node_key=?').run(key)
    const body = extra => ({ id: 'op7', kind: 'body', turn: 7, status: 'failed', ...extra })
    const timeline = operations => ({ schemaVersion: 1, branchId: 'b1', revision: 4, operations, checkpoints: [] })
    const single = timeline({ op7: body({ businessBefore: { messages: [] } }) })
    // ① 基准在位且无 checkpoint/尾行/后继操作 ⇒ cleanable
    node('operations:op7', single.operations.op7)
    const clean = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(clean.cleanable, true, '失败轮基准在位 ⇒ cleanable')
    assert.equal(clean.turn, 7)
    assert.equal(clean.operationId, 'op7')
    assert.equal(clean.revision, 4)
    assert.equal(clean.branchId, 'b1')
    assert.equal(clean.reason, '')
    // ② 无发轮前基准 ⇒ 拒绝并给原因
    node('operations:op7', body())
    const noBase = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(noBase.cleanable, false)
    assert.match(noBase.reason, /回退基准/)
    node('operations:op7', single.operations.op7)
    // ③ 同轮已有 checkpoint ⇒ 不是失败态
    node('checkpoints#ck7', { id: 'ck7', turn: 7 })
    const checkpoint = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(checkpoint.cleanable, false)
    assert.match(checkpoint.reason, /检查点/)
    dropNode('checkpoints#ck7')
    // ④ 之后已有正文行 ⇒ 不是最新尾部
    db.prepare('INSERT INTO archive_messages (message_index,message_json) VALUES (?,?)').run(0, JSON.stringify({ turn: 8, role: 'assistant' }))
    const tail = queryFailureCleanup(db, { revision: 4, timeline: single })
    assert.equal(tail.cleanable, false)
    assert.match(tail.reason, /正文行/)
    db.prepare('DELETE FROM archive_messages').run()
    // ⑤ 之后已有任务推进（非 body 操作 turn 8）⇒ 不是最新尾部
    const ahead = timeline({
      op7: body({ businessBefore: { messages: [] } }),
      op8: { id: 'op8', kind: 'agent', turn: 8, status: 'running' },
    })
    const advanced = queryFailureCleanup(db, { revision: 4, timeline: ahead })
    assert.equal(advanced.cleanable, false)
    assert.match(advanced.reason, /任务推进/)
    // ⑥ 没有失败 body 操作 ⇒ 空摘要（不报原因）
    assert.deepEqual(queryFailureCleanup(db, { revision: 4, timeline: timeline({}) }), { cleanable: false, reason: '' })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
