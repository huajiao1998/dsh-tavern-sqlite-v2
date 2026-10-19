// 最新发送撤销接缝定向测试（2026-10-13 第四批：相对路径夹具 + client/error-purge 叶）。
// 夹具一律相对本文件解析（可交付，无绝对 D:/ 路径）；作者源为 537e878 真实树。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const TREE = new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/', import.meta.url)
const DEPLOY = new URL('../deploy/', import.meta.url)
const PLUGIN = new URL('../', import.meta.url)
const DOMAIN = 'tavern-plugin/lib/domain/'
const domainUrl = new URL(DOMAIN, TREE)
const load = name => import(new URL(name, DEPLOY).href)
const text = rel => readFileSync(new URL(rel, TREE), 'utf8')
const pluginText = rel => readFileSync(new URL(rel, PLUGIN), 'utf8')
// 作者域模块的相对导入按 domain/ 解析（data: 模块自身无法解析相对名）。
const dataModule = source => import('data:text/javascript;base64,' + Buffer.from(
  source.replace(/from '(\.[^']+)'/g, (_, rel) => 'from ' + JSON.stringify(new URL(rel, domainUrl).href)), 'utf8').toString('base64'))
const inline = source => import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
// 从产物/宿主文件里按大括号配对抽出函数（任意缩进）。
function extractFunction(source, name) {
  const match = new RegExp('(^|\\n)([ \\t]*)function ' + name + '\\(').exec(source)
  if (!match) throw new Error('缺少函数：' + name)
  const start = match.index + match[1].length
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') { depth -= 1; if (depth === 0) return source.slice(start, index + 1) }
  }
  throw new Error('函数括号未闭合：' + name)
}

test('① round-anchor：input-only 锚点被接受且能定位输入（reply=null）', async () => {
  const { applyInputOnlyAnchorResolverTransform } = await load('latest-send-anchor-transform.mjs')
  const seamed = applyInputOnlyAnchorResolverTransform(text(DOMAIN + 'round-anchor.js'))
  assert.equal(seamed, applyInputOnlyAnchorResolverTransform(seamed), '二次施缝必须零改写')
  assert.ok(seamed.includes('// [dsh-tavern-input-only-anchor:v1]'))
  const mod = await dataModule(seamed)
  assert.equal(mod.validAnchor({ turn: 3, input: 7, reply: null }), true, 'input-only 必须合法')
  assert.equal(mod.validAnchor({ turn: 3, input: 7 }), false, '缺 reply 字段非法')
  assert.equal(mod.validAnchor({ turn: 3, input: null, reply: null }), false, 'input 必须是整数')
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 3 } },
    { seq: 1, type: 'user/message', data: { id: 'u', role: 'user', content: [], source: { kind: 'user', rpcId: 'r' } } },
  ]
  assert.deepEqual(mod.resolveRoundAnchor({ events, nodes: [0, 1] }, { turn: 3, input: 1, reply: null }), { input: 1, reply: null }, '只有输入时 reply 必须为 null 而 input 命中')
})

test('② story-timeline：body operation 记录 intent.nativeAnchor，且沿用现实链顺序', async () => {
  const [row, business, settlement, anchor] = await Promise.all([
    load('row-rollback-transform.mjs'), load('rollback-business-transform.mjs'),
    load('settlement-round-transform.mjs'), load('latest-send-anchor-transform.mjs')])
  const chained = settlement.applySettlementRoundTransform(business.applyRollbackBusinessTimelineTransform(row.applyRowTimelineTransform(text(DOMAIN + 'story-timeline.js'))))
  const seamed = anchor.applySendAnchorTimelineTransform(chained)
  assert.equal(seamed, anchor.applySendAnchorTimelineTransform(seamed), '二次施缝必须零改写')
  assert.ok(seamed.includes('// [dsh-tavern-body-operation-anchor:v1]'), '必须注入 op 锚点标记')
  assert.ok(seamed.includes('nativeAnchor: { turn: Number(intent.nativeAnchor.turn), input: intent.nativeAnchor.input'), '必须把 intent 锚点写入 operation')
  const moved = seamed.replace('// [dsh-tavern-body-operation-anchor:v1]', '').replace(', beforeParticipants: clone(chat.timeline.participants), createdAt: now(),', ', beforeParticipants: [], createdAt: Date.now(),')
  assert.throws(() => anchor.applySendAnchorTimelineTransform(moved), /body operation 锚点字段锚点缺失\/不唯一/)
})

test('③ turn-orchestration：prepare 捕获点算出 nativeAnchor 并随 body.begin 传入', async () => {
  const [business, anchor] = await Promise.all([load('rollback-business-transform.mjs'), load('latest-send-anchor-transform.mjs')])
  const seamed = anchor.applySendAnchorTurnTransform(business.applyRollbackBusinessTurnTransform(text(DOMAIN + 'turn-orchestration.js')))
  assert.equal(seamed, anchor.applySendAnchorTurnTransform(seamed), '二次施缝必须零改写')
  assert.ok(seamed.includes("import { inputEventForTurn } from './session-turn-input.js'"), '必须注入 inputEventForTurn')
  assert.ok(seamed.includes('// [dsh-tavern-send-anchor-prepare:v1]'))
  assert.ok(seamed.includes('options.resolveSendInputAnchor'), '必须支持宿主 DI')
  assert.ok(seamed.includes('options.sessions.get(chat.sessionId)'), '必须支持 orchestrator sessions 取值')
  assert.ok(seamed.includes('businessBefore: rollbackBusinessBefore, nativeAnchor: rollbackSendAnchor } })'), '必须把锚点随 body.begin 传入')
  const moved = seamed.replace(/\/\/ \[dsh-tavern-send-anchor-prepare:v1\][\s\S]*?\)\(\)\n/, '').replace('businessBefore: rollbackBusinessBefore } })', 'businessBeforeX: rollbackBusinessBefore } })')
  assert.throws(() => anchor.applySendAnchorTurnTransform(moved), /发轮前锚点 body\.begin 锚点缺失\/不唯一/)
})

test('④ send guard：错误轮必须先统一清理，不软清且不按终态筛选', async () => {
  const { applyUpstreamFailureInputTransform, FAILURE_INPUT_FORMS } = await load('upstream-failure-input-transform.mjs')
  const seamed = applyUpstreamFailureInputTransform(text('tavern-plugin/lib/index.js'))
  assert.equal(seamed, applyUpstreamFailureInputTransform(seamed), '二次施缝必须零改写')
  const region = seamed.slice(seamed.indexOf('    clearFailedTurns: async function (sessionId) {'), seamed.indexOf('\n    },', seamed.indexOf('    clearFailedTurns: async function (sessionId) {')))
  assert.ok(region.includes('assertSendAfterCleanup(chat, { events: sessionEvents(session) })'))
  assert.ok(!region.includes('clearFailedTurnSurface'), '绝不软清/软墓碑')
  assert.ok(seamed.includes("import { assertSendAfterCleanup } from './domain/storage-failure-state.js'"), '实际消费者必须导入同一发送顺序守卫')
  assert.ok(!region.includes("['error', 'aborted']"), '不再按终态 kind 筛选')
  const v1 = text('tavern-plugin/lib/index.js').replace(FAILURE_INPUT_FORMS.ORIGINAL, FAILURE_INPUT_FORMS.V1_REPLACEMENT)
  assert.ok(v1.includes(FAILURE_INPUT_FORMS.V1_MARKER), '旧代构造必须成立')
  const upgraded = applyUpstreamFailureInputTransform(v1)
  assert.ok(upgraded.includes(FAILURE_INPUT_FORMS.MARKER) && upgraded.includes('assertSendAfterCleanup(chat, { events: sessionEvents(session) })'))
  const v1Broken = text('tavern-plugin/lib/index.js').replace(FAILURE_INPUT_FORMS.ORIGINAL, FAILURE_INPUT_FORMS.V1_REPLACEMENT.replace('再继续发送', '再继续发送！'))
  assert.ok(v1Broken.includes(FAILURE_INPUT_FORMS.V1_MARKER), '变异旧代构造必须成立')
  assert.throws(() => applyUpstreamFailureInputTransform(v1Broken), /v1 升级锚点未命中\/不唯一/)
})

test('⑤ view overlay：实际产物的 wrapper 覆盖 canRollback/canClearIncompleteReply/rollbackTarget', async () => {
  const [pending, overlay] = await Promise.all([load('rollback-pending-view-transform.mjs'), load('latest-send-view-transform.mjs')])
  const seamed = overlay.applyLatestSendViewTransform(pending.applyRollbackPendingViewTransform(text(DOMAIN + 'chat-session-state.js')))
  assert.equal(seamed, overlay.applyLatestSendViewTransform(seamed), '二次施缝必须零改写')
  assert.ok(seamed.includes('evidence = evidenceOf(chat.sessionId)'), 'wrapper 必须补 evidence 默认值')
  const wrapper = extractFunction(seamed, 'rollbackViewFields')
  const di = 'data:text/javascript;base64,' + Buffer.from(`
export let latestSendTarget = () => null
export const setLatestSend = value => { latestSendTarget = () => value }
export const rollbackViewFieldsBase = () => globalThis.__base
export const evidenceOf = () => ({ events: [] })
`, 'utf8').toString('base64')
  const mod = await import('data:text/javascript;base64,' + Buffer.from(
    `import { latestSendTarget, rollbackViewFieldsBase, evidenceOf, setLatestSend } from ${JSON.stringify(di)}\n` + wrapper + '\nexport { rollbackViewFields, setLatestSend }\n', 'utf8').toString('base64'))
  const chat = { id: 'c', sessionId: 's', messages: [], timeline: { branchId: 'b' } }
  const target = { kind: 'rollback', turn: 25, chatId: 'c', sessionId: 's', branchId: 'b', revision: 9 }
  globalThis.__base = { canRollback: false, canClearIncompleteReply: false, rollbackTarget: null, failureTarget: null, failureCleanupReason: '旧的失败原因', rollbackUnavailableReason: '当前轮次已不在可回退的消息流中' }
  mod.setLatestSend(target)
  const hit = mod.rollbackViewFields(chat, undefined, undefined)
  assert.equal(hit.canRollback, true, '最新发送存在即可回退（不看终态）')
  assert.equal(hit.canClearIncompleteReply, false)
  assert.deepEqual(hit.rollbackTarget, target)
  assert.equal(hit.rollbackTargetTurn, 25, '菜单接错修复遗漏：命中统一目标时 rollbackTargetTurn 必须取目标轮（25）')
  assert.equal(hit.rollbackUnavailableReason, '')
  assert.deepEqual(hit.failureTarget, target, 'latestSend 存在时 failureTarget 必须 alias 到统一目标')
  assert.equal(hit.failureCleanupReason, '', '最新发送存在时失败清理原因必须清空')
  // latestSend 为 null：旧 body 目标绝不允许回落（不误选更早轮）。
  mod.setLatestSend(null)
  globalThis.__base = { canRollback: true, canClearIncompleteReply: false, rollbackTarget: null, failureTarget: { kind: 'body', turn: 25, operationId: 'op25', branchId: 'b', revision: 9 }, failureCleanupReason: '旧 body 失败', rollbackUnavailableReason: '当前轮次已不在可回退的消息流中' }
  const miss = mod.rollbackViewFields(chat, undefined, undefined)
  assert.equal(miss.canRollback, false, 'latestSend 为 null 时不得回落更早一轮')
  assert.equal(miss.rollbackTarget, null)
  assert.equal(miss.failureTarget, null, '旧 body failureTarget 不得回落误选')
  assert.equal(miss.failureCleanupReason, '')
  // 新作者不回落旧分类或旧base.pending，重试统一由真实selector签发。
  globalThis.__base = {canRollback:true,failureTarget:{kind:'native-only',turn:25},rollbackPending:true}
  const noFallback=mod.rollbackViewFields(chat,undefined,undefined)
  assert.equal(noFallback.failureTarget,null);assert.equal(noFallback.canRollback,false)
  mod.setLatestSend({...target,rollbackId:'pending-owned'})
  assert.equal(mod.rollbackViewFields(chat).rollbackTarget.rollbackId,'pending-owned')

})

test('退役迁移：client只核清理范围，不认证版本分类或锚点', async () => {
  const compare = await inline(extractFunction(pluginText('client.js'), 'targetCompare') + '\nexport { targetCompare }\n')
  const base = { kind: 'rollback', turn: 25, chatId: 'c', sessionId: 's', branchId: 'b', revision: 9 }
  assert.equal(compare.targetCompare(base, { ...base }), '')
  for (const changed of [{operationId:'op'}, {revision:10}, {branchId:'b2'}, {kind:'native-only'},
    {chatId:undefined}, {sessionId:undefined}, {revision:undefined},
    {nativeAnchor:{turn:25,input:334,reply:null}}, {nativeAnchor:{turn:25,input:null}}]) {
    assert.equal(compare.targetCompare(base, {...base,...changed}), '', '同范围不按形态或坐标完整度设资格')
    assert.equal(compare.targetCompare({...base,...changed}, base), '', '比较方向不恢复旧认证')
  }
  assert.equal(compare.targetCompare(base, {...base,chatId:'other'}), 'chatId 不一致')
  assert.equal(compare.targetCompare(base, {...base,sessionId:'other'}), 'sessionId 不一致')
  assert.equal(compare.targetCompare(base, {...base,turn:24}), 'turn 不一致')
  assert.equal(compare.targetCompare(null, base), 'turn 不一致')
})

test('⑦ error-purge：实产物两代 getter 兼容且 ordinary 菜单逐字不变', async () => {
  const { applyErrorPurgePlayControlsTransform } = await load('error-purge-transform.mjs')
  const GETTER_NEW = 'get failureTarget() { const liveView = failureViewRef.current.view; return (liveView && (liveView.rollbackTarget || liveView.failureTarget)) || null }'
  const GETTER_OLD = 'get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }'
  const seamed = applyErrorPurgePlayControlsTransform(text('tavern-plugin/src/client/features/play-controls.js'))
  assert.ok(seamed.includes(GETTER_NEW), '实产物 purge/菜单 getter 必须统一到 rollbackTarget 优先')
  assert.ok(!seamed.includes(GETTER_OLD), '旧代 getter 不得残留')
  const ordinaryLines = seamed.split('\n').filter(line => line.includes('expectedTurn: ordinaryTurn') || line.includes('expectedTurn: rollbackRetryTarget || ordinaryTurn'))
  assert.ok(ordinaryLines.length >= 1, 'ordinary 菜单行必须仍在')
  assert.ok(ordinaryLines.every(line => !line.includes('rollbackTarget') && !line.includes('failureTarget')), 'ordinary 菜单行不得被统一目标改写')
  assert.equal(applyErrorPurgePlayControlsTransform(seamed), seamed, '二次施缝必须零改写')
  // 旧代已施缝树：getter 退回旧形态 ⇒ 再施缝必须就地升级（而不是"容忍旧形态"原样返回）。
  const legacyTree = seamed.replace(GETTER_NEW, GETTER_OLD)
  assert.ok(legacyTree.includes(GETTER_OLD))
  const upgraded = applyErrorPurgePlayControlsTransform(legacyTree)
  assert.ok(upgraded.includes(GETTER_NEW), '旧代 getter 必须被就地升级')
  assert.ok(!upgraded.includes(GETTER_OLD), '升级后旧代 getter 不得残留')
})

test('统一视图最终产物', async () => {
  const [pending, failure, overlay] = await Promise.all([
    load('rollback-pending-view-transform.mjs'), load('latest-failure-transform.mjs'), load('latest-send-view-transform.mjs'),
  ])
  // 真实源码按 rollback-pending → latest-failure → latest-send 组合施缝。
  const seamed = overlay.applyLatestSendViewTransform(
    failure.applyLatestFailureViewTransform(pending.applyRollbackPendingViewTransform(text(DOMAIN + 'chat-session-state.js'))))
  const wrapper=extractFunction(seamed,'rollbackViewFields')
  assert.ok(wrapper.includes('latestSendTarget(chat, evidence)'))
  assert.ok(wrapper.includes('failureTarget: rollbackTarget'))
  assert.equal(seamed.includes('function latestFailureTarget('),false,'新作者不得复活退役分类helper')
  assert.equal(failure.applyLatestFailureViewTransform(seamed),seamed)
  assert.equal(overlay.applyLatestSendViewTransform(seamed),seamed)

})

test('旧dev.1统一视图原位升级', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const rel = 'plugins/dsh-tavern-sqlite-v2/deploy/latest-send-view-transform.mjs'
  // 冻结的**已提交旧 dev.1 模板**：固定 Git 对象读取（不是 SHA 增量扫描）；不能用 HEAD——升级代码一旦提交，HEAD 就会变成新版。
  const committed = spawnSync('git', ['show', 'ed0e025:' + rel], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(committed.status, 0, 'git show ed0e025 读取冻结旧变换必须成功：' + String(committed.stderr).slice(0, 160))
  // 旧变换（dev.1 形态）经 data URL 加载；相对导入按 deploy/ 解析（与真实文件同目录语义）。
  const deployUrl = new URL('../deploy/', import.meta.url)
  const oldModule = await inline(committed.stdout.replace(/from '(\.[^']+)'/g, (_all, dep) => 'from ' + JSON.stringify(new URL(dep, deployUrl).href)))
  const pending = await load('rollback-pending-view-transform.mjs')
  const overlay = await load('latest-send-view-transform.mjs')
  const base = pending.applyRollbackPendingViewTransform(text(DOMAIN + 'chat-session-state.js'))
  const legacy = oldModule.applyLatestSendViewTransform(base)
  assert.equal(oldModule.applyLatestSendViewTransform(legacy), legacy, '旧变换自身二次施缝必须零改写（旧形态幂等）')
  const OLD_CLEAR_LINE = 'canClearIncompleteReply: pendingLegacy ? base.canClearIncompleteReply === true : false,'
  assert.ok(legacy.includes(OLD_CLEAR_LINE), '构造条件：旧 overlay 产物必须含旧 canClear 行')
  // 原位升级：已装 dev.1 的旧 overlay 必须被完整块替换成新形态，并回签 rollbackTargetTurn。
  const upgraded = overlay.applyLatestSendViewTransform(legacy)
  assert.match(upgraded, /rollbackTargetTurn:\s*rollbackTarget\?\.turn/, '新作者升级必须回签统一目标轮')
  assert.equal(upgraded.includes(OLD_CLEAR_LINE), false, '升级后旧 canClear 行必须被替换（不得保留旧 overlay）')
  assert.equal(overlay.applyLatestSendViewTransform(upgraded), upgraded, '升级后当前变换二次施缝必须零改写')
  // 半截/被改块必须拒绝：只动旧完整块里一处文字。
  const mutated = legacy.replace(OLD_CLEAR_LINE, OLD_CLEAR_LINE.replace('=== true', '!== true'))
  assert.notEqual(mutated, legacy, '构造条件：必须真的改到一处旧块文字')
  assert.equal(overlay.applyLatestSendViewTransform(mutated),upgraded,'旧overlay完整包装由新统一包装替换，不认证退役内部分类文案')
})
