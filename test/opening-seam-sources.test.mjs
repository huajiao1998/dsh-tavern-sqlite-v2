// 开局来源接线的新定向数据断言；原创条目，不访问用户卡书或业务存档。
// fixture 来源（2026-10-05 换源）：作者 2.5.0 固定源码，而非 tmp/upstream-audit-20261003/head（那是 2.4.0 代）。
// 依据：本缝的锚点 OPENING_SIGNATURE_25 要求 DI 名单含作者 generate，2.4.0 的签名
//   `createOpeningPreparation({ readCard, worldBooks, generateRaw, readRuntimeExtensions, extensionSettings, now = Date.now })`
// 不含 generate，故 2.4 源码上该锚点命中为 0 —— 那是**夹具版本不符**，不是产品缺陷。
// 2.5.0 签名命中恰好 1（见下 assert），fail-loud 唯一性护栏保留。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyOpeningRuntimeTransform } from '../deploy/opening-runtime-transform.mjs'
const FIXTURE = new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/opening-preparation.js', import.meta.url)
const original = readFileSync(FIXTURE, 'utf8')
// 身份门：夹具必须是作者 2.5.0 签名，且签名在文件中**恰好出现一次**（唯一性不得靠猜测）。
assert.equal(original.split('worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, now = Date.now })').length, 2,
  '夹具必须是作者 2.5.0 签名（含 generate）且唯一；否则本闸不成立')
const transformed = applyOpeningRuntimeTransform(original)
function sourceProject(draft, record, settings = {}) {
  const from = transformed.indexOf('      draft.initializationWorldbookSources =')
  const to = transformed.indexOf('      draft.card = copy(card)', from)
  assert.ok(from > 0 && to > from)
  const apply = new Function('draft', 'record', 'settings', 'projectTavernHelperWorldbook', transformed.slice(from, to))
  apply(draft, record, settings, view => view)
}
test('开局合并书按源UID映射，快照仅存来源不重复条目全文，已改运行书以当前投影为准', () => {
  const record = { view: { entries: [{ uid: 1, content: '主书' }, { uid: 9, content: '附加' }, { uid: 10, content: '全局' }] },
    mergedSources: [{ name: '主书', entries: [{ originalUid: 1, uid: 1 }] }, { name: '附加', entries: [{ originalUid: 1, uid: 9 }] }, { name: '全局', entries: [{ originalUid: 1, uid: 10 }] }] }
  const draft = {}
  sourceProject(draft, record)
  assert.deepEqual(draft.initializationWorldbooks.map(book => [book.name, book.entries[0].content]), [['主书', '主书'], ['附加', '附加'], ['全局', '全局']])
  assert.deepEqual(draft.initializationWorldbookSources, [{ name: '主书', entryUids: [1] }, { name: '附加', entryUids: [9] }, { name: '全局', entryUids: [10] }])
  assert.match(transformed, /initializationWorldbookSources: copy\(draft.initializationWorldbookSources\)/)
  assert.doesNotMatch(transformed, /initializationWorldbooks: copy\(draft.initializationWorldbooks\)/)
  const edited = { view: { entries: record.view.entries.map(entry => ({ ...entry, content: entry.content + '已改' })) } }
  const reopened = {}
  sourceProject(reopened, edited, { sourceChat: { openingWorldbookSnapshot: { initializationWorldbookSources: draft.initializationWorldbookSources } } })
  assert.deepEqual(reopened.initializationWorldbooks.map(book => book.entries[0].content), ['主书已改', '附加已改', '全局已改'])
  assert.equal(applyOpeningRuntimeTransform(transformed), transformed)
})
test('来源UID失联和不完整标记明确拒绝，原作者源不变', () => {
  assert.throws(() => sourceProject({}, { view: { entries: [] }, mergedSources: [{ name: '主书', entries: [{ uid: 42 }] }] }), /来源映射缺少条目/)
  assert.throws(() => applyOpeningRuntimeTransform(transformed.replace('initializationWorldbookSources: copy(draft.initializationWorldbookSources)', 'removed: true')), /消费者不完整/)
  assert.equal(readFileSync(FIXTURE, 'utf8'), original)
})
