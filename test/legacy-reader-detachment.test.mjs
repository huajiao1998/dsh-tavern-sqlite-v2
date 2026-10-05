// 单一回归：作者读源返回缓存/冻结原件时，revision归一化不得在源对象赋值。
// 只生成本测试独占夹具；不联网、不读真实档、不调用Agent或迁移。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-legacy-detachment-'))
const helpers = Object.fromEntries([
  'copyJsonTree', 'diffJson', 'applyJsonChangesShared', 'projectSceneImageState',
  'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig',
  'projectSettlementCheckpoint',
].map(name => [name, () => undefined]))
helpers.copyJsonTree = value => value === undefined ? undefined : structuredClone(value)
const stores = []
try {
  for (const carrier of ['journal', 'block']) {
    let assignments = 0
    const messages = Object.freeze([Object.freeze({ role: 'assistant', text: '只读夹具' })])
    const raw = { id: 'chat-' + carrier, sessionId: 'session-source-' + carrier, messages }
    // 写回同值也是源修改路径；不是只有值变化才违反只读契约。
    Object.defineProperty(raw, '_storageRevision', {
      enumerable: true, get: () => '7', set: () => { assignments++; throw Error('原件revision禁止赋值') },
    })
    Object.freeze(raw)
    const store = createChatSqliteStore({ dataRoot: root, helpers,
      legacyData: { readJson: async () => carrier === 'journal' ? raw : undefined },
      legacyStore: { read: async () => carrier === 'block' ? raw : undefined },
    })
    stores.push(store)
    const viewed = await store.read(raw.id)
    assert.notEqual(viewed, raw)
    assert.equal(viewed._storageRevision, 7, '脱离视图归一化成数值')
    assert.equal(viewed.sessionId, raw.sessionId)
    assert.deepEqual(viewed.messages, messages)
    assert.equal(raw._storageRevision, '7', '源revision类型和原ID不能变')
    assert.equal(assignments, 0, '不能在作者缓存原件写回，哪怕是同值')
    viewed.messages[0].text = '只改视图'
    assert.equal(raw.messages[0].text, '只读夹具')
    let updaterCalls = 0
    await assert.rejects(() => store.update(raw.id, () => { updaterCalls++; return raw }), { code: 'DSH_TAVERN_LEGACY_READ_ONLY' })
    assert.equal(updaterCalls, 0)
    assert.equal(assignments, 0)
  }
  console.log('legacy-reader-detachment：journal/block冻结缓存原件零赋值，视图归一化及拒写通过')
} finally {
  for (const store of stores) store.dispose()
  // 仅本测试亲建mkdtemp精确子目录，不删除共享临时根。
  assert.ok(path.basename(root).startsWith('tavern-legacy-detachment-'))
  rmSync(root, { recursive: true, force: true })
}
