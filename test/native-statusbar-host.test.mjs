// S3 宿主接线：`setStatusBarPlacement` 窄写 + 同一 hook 链（**只写不跑**）。
// 做法：从**施缝后**的真实作者源里摘出该 case 块（不是手抄），用同步 Function 工厂执行；
// `candidateWorldbookPreparation.changed` 用**真实模块**（fixed 68215 `domain/candidate-worldbook-preparation.js`），
// 以「再取一次是否重新 prepare」观测它是否真的失效；`updateChat`/`view` 用会抛的探针证明未被调用。
// scope：`chatForSession`（真实实现含 registry.resolve + needsAdoption/adopt）、`scheduleTemplateSync`、`syncChatSummary`、
// `coordinationEvents`、`queueAutoCompaction` 为受控替身（其真实字段消费已在分析中逐条核对并在此按语义镜像）；
// 低层 store 为受控 fixture（A 的真 store consumer 另证）。完整宿主席位未验。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyNativeDataTransform } from '../deploy/native-data-transform.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AUTHOR_LIB = path.resolve(HERE, '..', '..', '..', 'tmp', 'release-034-20261008', 'author-fixture', 'src',
  'dsh-tavern-68215e47516637e00c75d2b4bba3192679559425', 'tavern-plugin', 'lib')
const AUTHOR_INDEX = path.join(AUTHOR_LIB, 'index.js')

/** 从施缝后源码摘出 `setStatusBarPlacement` case 块（含花括号，可直接作为函数体执行并 return）。 */
function seamedStatusBarBlock() {
  const applied = applyNativeDataTransform(fs.readFileSync(AUTHOR_INDEX, 'utf8'), { projectorImportPath: 'dsh-tavern-sqlite-v2/lib/session-window-projector.js' })
  const start = applied.indexOf("case 'setStatusBarPlacement': {")
  assert.notEqual(start, -1, '施缝后源码必须仍有 setStatusBarPlacement case')
  const end = applied.indexOf('\n      }\n', start)
  assert.notEqual(end, -1, '未找到 case 块结尾')
  const caseText = applied.slice(start, end + '\n      }\n'.length)
  const block = caseText.slice(caseText.indexOf('{'))
  assert.ok(block.includes('chatJournalStore.setStatusBarPlacement'), '施缝后 case 必须走窄写')
  assert.ok(!block.includes('updateChat('), '施缝后 case 不得再调用 updateChat')
  return block
}

const DEP_NAMES = ['args', 'chatForSession', 'chatJournalStore', 'candidateWorldbookPreparation', 'syncChatSummary', 'coordinationEvents', 'scheduleTemplateSync', 'queueAutoCompaction', 'updateChat', 'view']
// case 块本身含 await ⇒ 必须用 **async** 函数体；此处块是「执行 + return 结果」，不是「返回函数」的工厂，
// 故 await run(...) 直接得到 case 的返回值（与「AsyncFunction 工厂返回函数」那种误用无关）。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function buildRunner(block) {
  return new AsyncFunction(...DEP_NAMES, block)
}

test('S3 setStatusBarPlacement 宿主接线：窄写+同一hook链（不调updateChat/view；changed/同值no-op两路）', async () => {
  const { createCandidateWorldbookPreparation } = await import(pathToFileURL(path.join(AUTHOR_LIB, 'domain', 'candidate-worldbook-preparation.js')).href)
  assert.equal(typeof createCandidateWorldbookPreparation, 'function', '真实候选准备模块必须可 import')

  const block = seamedStatusBarBlock()
  const run = buildRunner(block)

  /** 每次执行都独立的受控依赖；真实 prepared 模块照真实语义（changed 依据 sessionId/_storageRevision/source）。 */
  async function execute({ placement = 'body', storeRevision = 9, storeUpdatedAt = 99, settleStatus = 'done', mode = 'story', sessionId = 'session-1' } = {}) {
    const chat = { id: 'chat-1', sessionId, mode, settleStatus, statusBarPlacement: 'sidebar', _storageRevision: 5, updatedAt: 5 }
    const calls = { store: [], changed: 0, sync: [], publish: [], schedule: [], queue: [], updateChat: 0, view: 0 }
    let prepareCount = 0
    const prepared = createCandidateWorldbookPreparation({
      version: async () => ({ revision: 5, resources: 'r1' }),
      prepare: async () => { prepareCount += 1; return { prepared: true } }
    })
    await prepared.get(sessionId) // 建立 entry（revision 5）；changed 只在 revision 前进时失效

    const chatJournalStore = {
      setStatusBarPlacement: async (chatId, input) => { calls.store.push([chatId, input]); return { changed: storeRevision !== 5, statusBarPlacement: placement, revision: storeRevision, updatedAt: storeUpdatedAt } }
    }
    const candidateWorldbookPreparation = {
      changed: (saved, metadata) => { calls.changed += 1; return prepared.changed(saved, metadata) }
    }
    const result = await run(
      { sessionId, placement },
      async id => (id === sessionId ? chat : undefined), // 镜像 chatForSession：真实实现含 registry.resolve + 收养
      chatJournalStore,
      candidateWorldbookPreparation,
      async saved => { calls.sync.push(saved) },
      { publish: savedSessionId => { calls.publish.push(savedSessionId) } },
      (saved, metadata) => { calls.schedule.push([saved, metadata]) },
      savedSessionId => { calls.queue.push(savedSessionId) },
      () => { calls.updateChat += 1; throw new Error('窄路径不得调用 updateChat') },
      () => { calls.view += 1; throw new Error('窄路径不得调用 view') }
    )
    // 观测 changed 是否真的失效（失效 ⇒ 再取一次会重新 prepare）
    await prepared.get(sessionId)
    return { chat, calls, result, prepareCount }
  }

  // —— ① 变更路（store 推 revision 9）——
  const changed = await execute({ placement: 'body', storeRevision: 9, storeUpdatedAt: 99 })
  assert.deepEqual(changed.result, { statusBarPlacement: 'body' }, '返回值必须仍是 {statusBarPlacement}')
  assert.equal(changed.calls.updateChat, 0, '不得调用 updateChat')
  assert.equal(changed.calls.view, 0, '不得调用 view')
  assert.deepEqual(changed.calls.store, [['chat-1', { sessionId: 'session-1', placement: 'body' }]], 'store 必须收到窄参 (chatId,{sessionId,placement})')
  // 四个 hook（+协调事件）各恰好一次
  assert.equal(changed.calls.changed, 1, 'candidateWorldbookPreparation.changed 必须恰好 1 次')
  assert.equal(changed.calls.sync.length, 1, 'syncChatSummary 必须恰好 1 次（无条件，不带 candidate.mailbox 条件）')
  assert.deepEqual(changed.calls.publish, ['session-1'], 'coordinationEvents.publish 收 sessionId')
  assert.equal(changed.calls.schedule.length, 1, 'scheduleTemplateSync 必须恰好 1 次')
  assert.deepEqual(changed.calls.queue, ['session-1'], 'queueAutoCompaction 收 sessionId')
  const savedChanged = changed.calls.sync[0]
  assert.equal(savedChanged._storageRevision, 9, 'saved._storageRevision 必须取 store 返回的 revision')
  assert.equal(savedChanged.updatedAt, 99, 'saved.updatedAt 必须取 store 返回的 updatedAt')
  assert.equal(savedChanged.statusBarPlacement, 'body', 'saved 必须带新 placement')
  assert.equal(savedChanged.id, 'chat-1', 'saved 保留已物化 chat 身份字段')
  assert.equal(savedChanged.settleStatus, 'done', 'saved 保留 settleStatus（供 scheduleTemplateSync blocked 判定）')
  assert.deepEqual(changed.calls.schedule[0][1], { source: 'ui.status-bar-placement' }, 'scheduleTemplateSync 收 metadata.source')
  assert.equal(changed.prepareCount, 2, 'revision 前进 ⇒ 真实 changed 失效（重取会重新 prepare）')

  // —— ② 同值 no-op 路（store 不推 revision）——
  const noop = await execute({ placement: 'sidebar', storeRevision: 5, storeUpdatedAt: 5 })
  assert.deepEqual(noop.result, { statusBarPlacement: 'sidebar' })
  assert.equal(noop.calls.updateChat, 0, 'no-op 路同样不得调用 updateChat')
  assert.equal(noop.calls.changed, 1, 'no-op 路 hook 仍必须触发一次')
  assert.equal(noop.calls.sync.length, 1, 'no-op 路 syncChatSummary 仍触发')
  assert.equal(noop.calls.schedule.length, 1, 'no-op 路 scheduleTemplateSync 仍触发')
  assert.equal(noop.calls.sync[0]._storageRevision, 5, 'no-op 时 _storageRevision 保持当前值')
  assert.equal(noop.prepareCount, 1, 'no-op（revision 未前进）⇒ 真实 changed 不失效（不重新 prepare）')

  // —— ③ scheduleTemplateSync 的 enabled/blocked 与 mode/settleStatus 一致（镜像作者 306–315）——
  const pending = await execute({ settleStatus: 'pending', storeRevision: 9 })
  const scheduledChat = pending.calls.schedule[0][0]
  assert.equal(scheduledChat.settleStatus, 'pending')
  assert.equal(['pending', 'running'].includes(scheduledChat.settleStatus), true, 'pending ⇒ blocked 判定为真（作者 :313）')
  const running = await execute({ settleStatus: 'running', storeRevision: 9 })
  assert.equal(['pending', 'running'].includes(running.calls.schedule[0][0].settleStatus), true, 'running ⇒ blocked')
  const done = await execute({ settleStatus: 'done', storeRevision: 9 })
  assert.equal(['pending', 'running'].includes(done.calls.schedule[0][0].settleStatus), false, 'done ⇒ 不 blocked')
  assert.equal(done.calls.schedule[0][0].mode, 'story', 'mode 必须原样交给 scheduleTemplateSync（enabled 依赖 groupOfMode(mode)）')

  // —— ④ 校验与守卫（与作者逐字一致）——
  await assert.rejects(() => execute({ placement: 'floating' }), /无效的状态栏位置/)
  const guardDeps = () => [null, { setStatusBarPlacement: async () => { throw new Error('不得写入') } },
    { changed: () => { throw new Error('不得触发') } }, async () => {}, { publish: () => { throw new Error('不得发布') } },
    () => { throw new Error('不得调度') }, () => { throw new Error('不得排队') }, () => { throw new Error('不得调用 updateChat') }, () => { throw new Error('不得调用 view') }]
  await assert.rejects(() => run({ sessionId: 'nope', placement: 'body' }, async () => undefined, ...guardDeps()), /请先打开游玩会话/)
  await assert.rejects(() => run({ sessionId: 's', placement: 'body' }, async () => ({ id: 'c', sessionId: 's', mode: 'card' }), ...guardDeps()), /请先打开游玩会话/)
})
