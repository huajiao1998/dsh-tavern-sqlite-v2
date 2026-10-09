// 最新失败接线（主新增 transform）的具名独立覆盖：只写不跑，待主批准后一次 gate（pattern '最新失败接线'，共 2 条）。
//   ① 标准完整施缝：真实作者 source fixture（helper 有限复制 maintenanceTargets + 作者包）⇒ applyStandardSeams ⇒ ready，
//      且产物**ACTIVE 投影**同时含 host DI（appendMessages/setMessageFloor 两键）与 failureTarget 接线（RPC 参数与视图字段）。
//   ② transform 自身：RPC/视图两转换作用在**完整 pending 状态 source** 上幂等，缺块/半应用/标记异常一律拒。
// 只读夹具、只清自建 mkdtemp；不联网/不读真实档/不动主 standard-seams 与 latest-failure 文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { applyStandardSeams, checkStandardSeams } from '../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { applyRollbackPendingViewTransform } from '../deploy/rollback-pending-view-transform.mjs'
import { applyLatestFailureHostTransform, applyLatestFailureViewTransform } from '../deploy/latest-failure-transform.mjs'
import { applyNativeMessageHostTransform } from '../deploy/native-data-transform.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const INDEX_REL = 'tavern-plugin/lib/index.js'
const VIEW_REL = 'tavern-plugin/lib/domain/chat-session-state.js'
const DI_KEYS = ['appendMessages: appendMessagesNarrow,', 'setMessageFloor: setMessageFloorNarrow,']
const FAILURE_RPC = 'args.failureTarget || args.expectedTurn'
const FAILURE_FIELDS = [
  'failureTarget: latestFailureTarget(chat, replayTarget),',
  "failureCleanupReason: replayTarget && !latestFailureTarget(chat, replayTarget) ? '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理' : '',",
  'canClearIncompleteReply: latestFailureTarget(chat, replayTarget) !== null,',
  'failureTarget: latestFailureTarget(chat, previous.value.replayFailedTurn === null ? null : {turn: previous.value.replayFailedTurn}),',
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
