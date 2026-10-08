// S2 debug 稳定片段缓存：跨身份隔离 + 界限缓存（**只写不跑**）。
// scope：本文件只验证「缓存键/出借语义」，依赖为受控实现（非真实 helper 语义）；真实 helper 整 view 差分见 native-real-helper-diff.test.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionWindowProjector, REQUIRED_FUNCTIONS, REQUIRED_VALUES } from '../lib/session-window-projector.js'

function buildDeps(fixture) {
  const deps = {}
  for (const name of REQUIRED_FUNCTIONS) {
    const parts = name.split('.')
    if (parts.length === 2) { deps[parts[0]] = deps[parts[0]] || {}; deps[parts[0]][parts[1]] = function named() { return null } }
    else deps[name] = function named() { return null }
  }
  for (const name of REQUIRED_VALUES) deps[name] = name === 'helperMessageColdWindow' ? 24 : { fixture: true }
  Object.assign(deps, {
    str: value => (value === undefined || value === null ? '' : String(value)),
    activityOf: () => fixture.activity,
    activityBridge: { set() {}, get() { return undefined } },
    readChatCard: async () => ({ path: '', name: '卡', tags: [] }),
    readTavernSettings: async () => ({ trustedCardMode: false, frameSizing: 'fill' }),
    readCardExtensions: async () => ({ regexScripts: [], helperScripts: [] }),
    tavernRemoteAssets: { pinExtensions: async () => ({ helperScripts: [], regexScripts: [], diagnostics: [], pins: [] }) },
    projectTavernHelperScripts: () => ({ scripts: [], diagnostics: [] }),
    hasTavernScriptRuntime: () => false,
    composeTavernRegexScripts: () => [],
    withLegacyPresentationProjection: (_chat, projections) => projections,
    replyProjectionsOf: () => [],
    incrementalReplyView: { project: async () => ({ projections: [], statusViews: [] }) },
    liveCardUpdate: { project: async (_c, _card, display) => display },
    inputFieldsProjection: { project: () => ({ inputSources: [], inputTemplateDisplays: [] }) },
    rollbackViewFields: () => ({}),
    cardViewOf: () => ({}),
    mvuReceiptsOf: () => ({ receipts: [] }),
    forkTurnsForChat: () => ({}),
    settlementTurn: () => 0,
    worldBooks: { bound: async () => null },
    projectTavernHelperWorldbook: () => null,
    worldBookDisplayName: () => 'b',
    sessionOpeningDescriptor: () => null,
    projectTavernHelperContext: async () => null,
    candidateWorldbookPreparation: { warm: () => undefined },
    scheduleTemplateSync: () => undefined
  })
  return deps
}

test('S2 debug缓存：跨身份隔离 + 同身份命中副本 + 无resourceKey不缓存', async () => {
  const activity = Object.freeze({ busy: false, phase: 'idle', role: '', updatedAt: 3 })
  const base = {
    id: 'chat-cache', sessionId: 'session-A', mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    messages: [{ role: 'assistant', turn: 1, text: 'a' }], timeline: { branchId: 'branch-A', revision: 5 },
    tavernHelperLifecycleRevision: 1, updatedAt: 3
  }
  const window = { from: 0, to: 0, messageCount: 1, revision: 5 }
  const projector = createSessionWindowProjector(buildDeps({ activity }))

  // ① 同 chatId、不同身份维度（sessionId / branchId / lifecycle）⇒ 不得命中同一条缓存
  const first = await projector.project({ chat: base, window, activity, resourceKey: 'k1' })
  assert.equal(first.kind, 'value')
  const firstArray = first.view.debugTurns
  firstArray[0].preview = 'MUTATED-BY-CALLER'
  const otherSession = await projector.project({ chat: { ...base, sessionId: 'session-B' }, window, activity, resourceKey: 'k1' })
  assert.notEqual(otherSession.view.debugTurns, firstArray, '不同 sessionId 必须是不同缓存条目（改前会命中同一条）')
  assert.notEqual(otherSession.view.debugTurns[0].preview, 'MUTATED-BY-CALLER', '不同身份的缓存不得被上一次调用污染')
  const otherBranch = await projector.project({ chat: { ...base, timeline: { branchId: 'branch-B', revision: 5 } }, window, activity, resourceKey: 'k1' })
  assert.notEqual(otherBranch.view.debugTurns[0].preview, 'MUTATED-BY-CALLER')
  const otherLifecycle = await projector.project({ chat: { ...base, tavernHelperLifecycleRevision: 2 }, window, activity, resourceKey: 'k1' })
  assert.notEqual(otherLifecycle.view.debugTurns[0].preview, 'MUTATED-BY-CALLER')

  // ② 同身份 + 同 window + 同 resourceKey ⇒ 命中缓存，且**出借副本**（调用方改前缀不污染缓存）
  const again = await projector.project({ chat: { ...base }, window, activity, resourceKey: 'k1' })
  assert.notEqual(again.view.debugTurns, firstArray, '命中缓存也必须返回新数组（副本）')
  assert.equal(again.view.debugTurns[0].preview, 'a', '第一次调用的改动不得进入缓存')
  again.view.debugTurns[0].preview = 'SECOND-MUTATION'
  const third = await projector.project({ chat: { ...base }, window, activity, resourceKey: 'k1' })
  assert.equal(third.view.debugTurns[0].preview, 'a', '副本改动不得回流缓存')
  assert.notEqual(third.view.debugTurns, again.view.debugTurns, '每次出借都是新的副本')

  // ③ resourceKey 缺失 ⇒ 不缓存：两次调用各自是新数组，互不影响
  const noKey1 = await projector.project({ chat: { ...base }, window, activity })
  noKey1.view.debugTurns[0].preview = 'NO-KEY-MUTATION'
  const noKey2 = await projector.project({ chat: { ...base }, window, activity })
  assert.notEqual(noKey2.view.debugTurns[0].preview, 'NO-KEY-MUTATION', '无 resourceKey 时不得复用上次结果')
  assert.equal(noKey2.view.debugTurns[0].preview, 'a')

  // ④ window revision 变化 ⇒ 不同缓存条目（键含 revision）
  const newRev = await projector.project({ chat: { ...base }, window: { ...window, revision: 6 }, activity, resourceKey: 'k1' })
  assert.equal(newRev.view.debugTurns[0].preview, 'a')

  // ⑤ 缓存上限：连续 12 个不同 resourceKey 后仍可用且不报错（容量 8，逐出最旧，无泄漏迹象）
  for (let index = 0; index < 12; index += 1) {
    const round = await projector.project({ chat: { ...base }, window, activity, resourceKey: 'k' + index })
    assert.equal(round.view.debugTurns[0].preview, 'a')
  }
})
