// 最新上游接缝定向闸（2026-10-06）：三代固定作者树上的纯变换断言。
//
// 范围：只调 deploy/ 的纯转换函数——不写盘、不装插件、不连现场、不跑真实消费者。
//   ① index 链：transformStorageIndex → transformLegacyIndex → applyHostTransform → applyRollbackHostTransform
//   ② round 真实链：applyRollbackTransform(...).text → applyRowHistoryTransform → applyCleanRollbackTransform
//   ③ turn：applyRollbackBodyCommitTurnTransform
// 变换结果只用 vm.SourceTextModule **解析**（不链接 import、不执行任何业务代码）。
// **未验证**：真实消费者行为、部署装配、页面/HTTP 结果——本闸不构成那些层面的证据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformStorageIndex } from '../deploy/apply-seams.mjs'
import { transformLegacyIndex } from '../deploy/apply-legacy-view-seams.mjs'
import { applyHostTransform } from '../deploy/core-host-transform.mjs'
import { applyRollbackHostTransform } from '../deploy/rollback-host-transform.mjs'
import { applyRollbackTransform } from '../deploy/core-rollback-transform.mjs'
import { applyRowHistoryTransform } from '../deploy/row-rollback-transform.mjs'
import { applyCleanRollbackTransform } from '../deploy/clean-rollback-transform.mjs'
import { applyRollbackBodyCommitTurnTransform } from '../deploy/rollback-body-commit-transform.mjs'

const AUTHOR_ROOT = new URL('../../../tmp/upstream25-author-fixture/src/', import.meta.url)
const SHA_OLD = '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const SHA_MID = '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544'
const SHA_NEW = '5c69907994df9f432b8898168ce5dff371929c2a'
const OLD_TREES = [SHA_OLD, SHA_MID]
const libUrl = sha => new URL('dsh-tavern-' + sha + '/tavern-plugin/lib/', AUTHOR_ROOT)
for (const sha of [...OLD_TREES, SHA_NEW]) {
  for (const rel of ['index.js', 'domain/round-history.js', 'domain/turn-orchestration.js']) {
    if (!existsSync(new URL(rel, libUrl(sha)))) {
      throw new Error('缺三代作者树夹具：' + sha + '/' + rel + '（按 loud 失败处理，不 skip）')
    }
  }
}
const readLib = (sha, rel) => readFileSync(new URL(rel, libUrl(sha)), 'utf8')
const indexPreRollback = source => applyHostTransform(transformLegacyIndex(transformStorageIndex(source)))
const indexChain = source => applyRollbackHostTransform(indexPreRollback(source))
const roundChain = source => {
  const first = applyRollbackTransform(source)
  return { first, text: applyCleanRollbackTransform(applyRowHistoryTransform(first.text)) }
}
const PRESENT_NEW = '    cancelSettlement,\n    present: presentStory,'
const PRESENT_OLD = '    cancelSettlement,\n    present: view,'
const SIG_NEW = '  async function finalizeSnapshot(input, chat, writeChat, expectedTimeline, history) {'
const SIG_OLD = '  async function finalizeSnapshot(input, chat, writeChat, expectedTimeline) {'

/** 只解析不链接：SourceTextModule 构造不解析 import、不求值，业务代码不执行。 */
function parseOnly(label, source) {
  assert.equal(typeof vm.SourceTextModule, 'function',
    'vm.SourceTextModule 不可用：本闸须经 node tools/run-plugin-gate.mjs 运行（入口已带 --experimental-vm-modules）')
  const mod = new vm.SourceTextModule(source, { identifier: label })
  assert.equal(mod.status, 'unlinked', label + '：只解析，不链接、不执行')
}

test('三代夹具身份：新树独有 readRecent/changedSince/rowsAt/presentStory，两旧树确无', () => {
  const fresh = readLib(SHA_NEW, 'index.js')
  for (const needle of ['readRecent: async chatId => {', 'changedSince: (chatId, revision) => chatPersistence.readChangedIndices(',
    'rowsAt: async (chatId, revision, indices) => {', 'async function presentStory(chat) {']) {
    assert.equal(fresh.split(needle).length - 1, 1, '新树必须恰有一处：' + needle)
  }
  assert.equal(fresh.split(PRESENT_NEW).length - 1, 1, '新树 presentStory 展示位必须唯一')
  for (const sha of OLD_TREES) {
    const older = readLib(sha, 'index.js')
    for (const needle of ['readRecent:', 'changedSince:', 'rowsAt:', 'presentStory']) {
      assert.equal(older.includes(needle), false, sha.slice(0, 8) + ' 不应含新作者面：' + needle)
    }
    assert.equal(older.split(PRESENT_OLD).length - 1, 1, sha.slice(0, 8) + ' 旧展示位必须唯一')
    assert.equal(readLib(sha, 'domain/round-history.js').includes('  async function rollbackRecent('), false)
    assert.equal(readLib(sha, 'domain/turn-orchestration.js').includes(SIG_OLD), true)
  }
  assert.equal(readLib(SHA_NEW, 'domain/round-history.js').includes('  async function rollbackRecent('), true)
  assert.equal(readLib(SHA_NEW, 'domain/turn-orchestration.js').includes(SIG_NEW), true)
})

test('index链（新树）：施缝落地且新作者 patch/readRecent/changedSince/rowsAt 与 presentStory 逐项保留', () => {
  const next = indexChain(readLib(SHA_NEW, 'index.js'))
  // 我们自己的缝确实落地（不是原样返回）。
  assert.equal(next.includes("ctx.provide('tavernChats'"), true, 'S1 暴露服务缺失')
  assert.equal(next.includes('readSlice: chatPersistence.readSlice,'), true, '宿主回退head行键读接口缺失')
  assert.equal(next.includes('quiesceRollback: async chat =>'), true, '回退静止门面缺失')
  // 作者新面原样保留。
  assert.equal(next.split('readRevision: readChatRevision, write: writeChat, update: updateChat, patch: patchChat,').length - 1, 1, '新作者 patch 门面成员必须保留')
  assert.equal(next.split('readRecent: async chatId => {').length - 1, 1)
  assert.equal(next.split('changedSince: (chatId, revision) => chatPersistence.readChangedIndices(chatId, revision, { limit: 2048 }),').length - 1, 1)
  assert.equal(next.split('rowsAt: async (chatId, revision, indices) => {').length - 1, 1)
  // 静止门面插在作者展示位之前，且展示名仍是作者的 presentStory（未被换回 view）。
  assert.equal(next.includes('    cleanupRollbackSides: (chat, turn) => worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId),\n    quiesceRollback: async chat => {'), true)
  assert.match(next, /\n    \},\n    present: presentStory,/)
  assert.equal(next.split('    present: presentStory,').length - 1, 2, '两处作者 presentStory 调用点都必须保留')
  parseOnly('index-chain-new', next)
})

test('index链（两旧树）：同一链兼容施缝、作者门面不被改写、夹具文件零写入', () => {
  for (const sha of OLD_TREES) {
    const file = new URL('index.js', libUrl(sha))
    const raw = readFileSync(file, 'utf8')
    const next = indexChain(raw)
    assert.equal(next.includes('readSlice: chatPersistence.readSlice,'), true, sha.slice(0, 8) + ' 宿主缝未落地')
    assert.equal(next.split('    present: view,').length - 1, 1, sha.slice(0, 8) + ' 旧展示门面必须保留')
    assert.match(next, /\n    \},\n    present: view,/, sha.slice(0, 8) + ' 静止门面必须插在作者 view 展示位之前')
    assert.equal(next.includes('presentStory'), false, sha.slice(0, 8) + ' 不得凭空造出作者没有的 presentStory')
    assert.equal(next.includes('patch: patchChat,'), true, sha.slice(0, 8) + ' 作者门面不得被改写')
    assert.equal(readFileSync(file, 'utf8'), raw, sha.slice(0, 8) + ' 纯变换不得写夹具文件')
  }
})

test('重复展示门面写前拒：布局重复即抛错，夹具文件保持原样', () => {
  const file = new URL('index.js', libUrl(SHA_NEW))
  const before = readFileSync(file, 'utf8')
  const pre = indexPreRollback(before)
  assert.throws(() => applyRollbackHostTransform(pre.replace(PRESENT_NEW, PRESENT_NEW + PRESENT_NEW)),
    /回退Host展示布局缺失或重复/)
  const oldPre = indexPreRollback(readLib(SHA_OLD, 'index.js'))
  assert.throws(() => applyRollbackHostTransform(oldPre.replace(PRESENT_OLD, PRESENT_OLD + PRESENT_OLD)),
    /回退Host展示布局缺失或重复/)
  assert.equal(readFileSync(file, 'utf8'), before, '拒绝必须发生在写盘之前：夹具文件零变化')
})

test('round真实链（新树）：四函数退役、冷恢复marker/唯一clean/undo拒绝/rowCheckpoint在场且幂等', () => {
  const { first, text } = roundChain(readLib(SHA_NEW, 'domain/round-history.js'))
  assert.equal(first.changed, true, '新树必须真的施缝')
  for (const gone of ['  async function rollbackRecent(', '  async function regenRecent(',
    '  async function finishRollback(', '  async function undoPoint(']) {
    assert.equal(text.includes(gone), false, '新链必须退役作者函数：' + gone)
  }
  assert.equal(text.split('// [dsh-tavern-rollback-cold:v1]').length - 1, 1, '冷恢复marker必须唯一在场')
  assert.equal(text.split('// [dsh-tavern-clean-rollback:v1]').length - 1, 1, 'clean编排marker必须唯一')
  assert.equal(text.includes("throw new Error('物理删除不可撤销；旧回退恢复入口已退役')"), true, '旧undo入口必须改为拒绝')
  assert.equal(text.includes('rowCheckpointId: target.checkpointId'), true, '行级checkpoint基准必须在场')
  assert.equal(text.split('// [dsh-tavern-row-rollback:v1]').length - 1, 1, '行级回退接缝marker必须唯一在场')
  // 幂等：clean 阶段自反；整链对已施产物不再改动。
  assert.equal(applyCleanRollbackTransform(text), text)
  const again = applyRollbackTransform(text)
  assert.equal(again.changed, false)
  assert.equal(again.text, text)
  parseOnly('round-chain-new', text)
})

test('round重复消费者拒绝：完整片段还在也不允许重复marker或函数边界', () => {
  const { text } = roundChain(readLib(SHA_NEW, 'domain/round-history.js'))
  for (const extra of ['// [dsh-tavern-clean-rollback:v1]', '  async function rollbackChat(chat, requestedTurn, restoredAgent) {', '  async function undoRollback(sessionId, chatId) {']) {
    assert.throws(() => applyCleanRollbackTransform(text + '\n' + extra), /重复\/边界不唯一/)
  }
  assert.equal(applyCleanRollbackTransform(text), text)
})

test('round破损marker拒绝：clean标记在但统一消费者被破坏即抛错', () => {
  const { text } = roundChain(readLib(SHA_NEW, 'domain/round-history.js'))
  const broken = text.replace('const cleanRollback = storageRollback.cleanRollback', 'const brokenCleanRollback = storageRollback.cleanRollback')
  assert.notEqual(broken, text, '破损点必须命中真实消费者行')
  assert.throws(() => applyCleanRollbackTransform(broken), /同连接统一回退消费者不完整/)
})

test('turn真实新旧源码：history参数保留、共用入口owner防护在场且幂等', () => {
  const next = applyRollbackBodyCommitTurnTransform(readLib(SHA_NEW, 'domain/turn-orchestration.js'))
  assert.equal(next.split(SIG_NEW).length - 1, 1, '新签名（含 history 参数）必须原样保留')
  assert.equal(next.includes(SIG_OLD), false, '不得把新签名降级成旧签名')
  assert.equal(next.split('    const history = {').length - 1, 1, '作者 history 消费者必须保留')
  assert.equal(next.split('expectedTimeline, history)').length - 1, 2, 'history 消费点（定义＋调用）两处都必须保留')
  const older = applyRollbackBodyCommitTurnTransform(readLib(SHA_OLD, 'domain/turn-orchestration.js'))
  assert.equal(older.split(SIG_OLD).length - 1, 1, '旧树旧签名必须保留')
  assert.equal(older.includes(SIG_NEW), false, '不得给旧树凭空加 history 参数')
  for (const [label, source] of [['turn-new', next], ['turn-old', older]]) {
    assert.equal(source.split('function rollbackBodyCommitMatches(chat,input)').length - 1, 1, label + '：共用入口 owner 防护函数必须唯一在场')
    assert.equal(source.includes('!rollbackBodyCommitMatches(current,input)'), true, label + '：提交路径 owner 防护缺失')
    assert.equal(source.includes('!rollbackBodyCommitMatches(chat,input)'), true, label + '：finalizeSnapshot 路径 owner 防护缺失')
    assert.equal(source.includes("reason:'stale-body-owner'"), true)
    assert.equal(applyRollbackBodyCommitTurnTransform(source), source, label + '：必须幂等')
    parseOnly(label, source)
  }
})

test('turn有限重复签名拒绝：新旧签名同时在场或同一签名重复即拒', () => {
  const fresh = readLib(SHA_NEW, 'domain/turn-orchestration.js')
  const older = readLib(SHA_OLD, 'domain/turn-orchestration.js')
  assert.throws(() => applyRollbackBodyCommitTurnTransform(fresh.replace(SIG_NEW, SIG_NEW + '\n' + SIG_NEW)),
    /未知\/重复finalizeSnapshot签名/)
  assert.throws(() => applyRollbackBodyCommitTurnTransform(older.replace(SIG_OLD, SIG_OLD + '\n' + SIG_OLD)),
    /未知\/重复finalizeSnapshot签名/)
  assert.throws(() => applyRollbackBodyCommitTurnTransform(fresh + '\n' + SIG_OLD),
    /未知\/重复finalizeSnapshot签名/)
})
