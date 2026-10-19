// 固定stable作者源→标准安装接缝→真实retrySettlement与SQL投影；队列/视图仅作外部边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { activityFromSmallRows } from '../lib/activity-state.js'
import { applyMvuRedeliveryTransform } from '../deploy/mvu-redelivery-transform.mjs'
import { applyStandardSeams, uninstallStandardSeams, maintenanceTargets, maintenanceReadSources } from '../deploy/standard-seams.mjs'
import { activeSource } from './fixtures/comment-author-tree.mjs'

const author = new URL('../../../tmp/adapt-dsh-021rc2-20261018/stable/', import.meta.url)
const domain = new URL('tavern-plugin/lib/domain/', author)
const { copyJsonTree } = await import(new URL('copy-json-tree.js', domain))
const { diffJson, applyJsonChangesShared } = await import(new URL('json-mutation.js', domain))
const { createStoryTimeline } = await import(new URL('story-timeline.js', domain))
const helpers = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const key of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[key] = value => value
const guard = "          if (activity.phase !== 'pending') throw new Error('等待中的结算状态已经变化，请刷新后重试')"
const rel = 'tavern-plugin/lib/index.js'

function retryFrom(source, deps) {
  const start = source.indexOf('  async function retrySettlement(')
  const end = source.indexOf('\n  async function ', start + 1)
  assert.ok(start >= 0 && end > start)
  return new Function(...Object.keys(deps), source.slice(start, end) + '\nreturn retrySettlement')(...Object.values(deps))
}

test('stable重投修复：标准装卸可复原，deferred真实SQL投影idle仍重投已保存操作', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'stable-mvu-redelivery-'))
  const app = path.join(root, 'app')
  const store = createChatSqliteStore({ dataRoot: path.join(root, 'data'), helpers })
  t.after(() => { store.dispose(); rmSync(root, { recursive: true }) })
  const original = readFileSync(new URL(rel, author), 'utf8')
  assert.ok(original.includes(guard), '输入必须真的带现场旧拒绝')
  for (const file of new Set(['tavern-plugin/package.json', ...maintenanceTargets, ...maintenanceReadSources])) {
    const src = fileURLToPath(new URL(file, author))
    if (!existsSync(src)) continue
    const dest = path.join(app, file)
    mkdirSync(path.dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
  const installed = applyStandardSeams({ appDir: app, authorUnloaded: true })
  assert.equal(installed.ready, true)
  const source = activeSource(readFileSync(path.join(app, rel), 'utf8'), rel)
  assert.ok(!source.includes(guard), '标准buildCore必须实际包含该删除，不只测试孤立转换')
  assert.equal(applyMvuRedeliveryTransform(source), source, '已修来源不重复修改')

  const id = 'fixture-redelivery', sessionId = 'fixture-session'
  const submission = { operations: [{ op: 'set', path: ['gold'], value: 3 }] }
  const base = {
    id, sessionId, mode: 'story', _storageRevision: 1, mvu: { enabled: true, owner: 'official' },
    timeline: { schemaVersion: 1, branchId: 'fixture-branch', revision: 2, checkpoints: [], participants: {}, operations: {
      delivery: { id: 'delivery', kind: 'agent', role: 'settlement', status: 'deferred', createdAt: 1, completedAt: 2 },
    } },
    messages: [{ role: 'assistant', turn: 5, text: '夹具正文', mvu: { pending: true, receipt: { status: 'pending' }, pendingSubmission: submission } }],
  }
  await store.update(id, () => structuredClone(base))
  const queued = [], deliveries = []
  const timeline = createStoryTimeline()
  const deps = {
    readOpeningWindow: async () => ({ chat: await store.read(id), from: 0 }),
    chatForSession: async () => { throw Error('本例不得回落整档适配器') },
    backgroundTasks: { activity: chat => activityFromSmallRows(chat.timeline) },
    storyTimeline: timeline, str: value => String(value ?? ''),
    queueSettlement: chatId => {
      const job = store.read(chatId).then(chat => { queued.push({ chatId, chat }) })
      deliveries.push(job)
      return job
    },
    projectOpeningWindow: async window => ({ revision: window.chat._storageRevision }),
    patchChat: async () => { throw Error('重新投递不得重置MVU或重新生成计划') },
  }
  const retry = retryFrom(source, deps)
  const before = await store.read(id)
  assert.equal(activityFromSmallRows(before.timeline).phase, 'idle', '真实deferred操作汇总为idle，覆盖现场根因')
  await retry(sessionId, 5)
  await Promise.all(deliveries) // 收齐队列边界的真实SQL回读，不用微任务次数猜完成。
  assert.equal(queued.length, 1)
  assert.equal(queued[0].chatId, id)
  assert.deepEqual(queued[0].chat.messages[0].mvu.pendingSubmission, submission)
  assert.deepEqual(await store.read(id), before, '只重投，不改库或重置变量/收据')
  await assert.rejects(() => retry(sessionId, 4), /只能重试当前最新正文/)
  await assert.rejects(() => retry(sessionId, 5, '重写计划'), /不能追加指导意见/)

  const noSubmission = structuredClone(base)
  delete noSubmission.messages[0].mvu.pendingSubmission
  await store.update(id, current => ({ ...noSubmission, _storageRevision: current._storageRevision + 1 }))
  await assert.rejects(() => retry(sessionId, 5), /尚未保存可重新投递/)
  const prepared = structuredClone(noSubmission)
  prepared.messages[0].mvu.delivery = { prepared: { effect: 'fixture-effect' } }
  await store.update(id, current => ({ ...prepared, _storageRevision: current._storageRevision + 1 }))
  await retry(sessionId, 5)
  await Promise.all(deliveries)
  assert.equal(queued.length, 2, '已有prepared操作同样复用原队列')
  assert.deepEqual(queued[1].chat.messages[0].mvu.delivery.prepared, { effect: 'fixture-effect' })
  const running = structuredClone(base)
  running.timeline.operations.delivery.status = 'running'
  await store.update(id, current => ({ ...running, _storageRevision: current._storageRevision + 1 }))
  await assert.rejects(() => retry(sessionId, 5), /后台 Agent 正在运行/)
  assert.equal(queued.length, 2, '已有忙/最新正文/已保存操作约束不被削弱')

  const repeated = applyStandardSeams({ appDir: app, authorUnloaded: true })
  assert.equal(repeated.changed, false, '相同安装输入幂等')
  uninstallStandardSeams({ appDir: app, authorUnloaded: true })
  assert.equal(readFileSync(path.join(app, rel), 'utf8'), original, '卸载只恢复现场作者原文，包含原拒绝')
  const alreadyFixed = applyMvuRedeliveryTransform(original)
  assert.equal(applyMvuRedeliveryTransform(alreadyFixed), alreadyFixed, '200已修来源保留，不重复补门')
  assert.equal(applyMvuRedeliveryTransform('export const legacy = true\n'), 'export const legacy = true\n', '无旧入口不另造实现')
})
