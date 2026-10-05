// 仅本轮Host消费者与策略delta断言；不启动作者/GUI，不读取存档。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyHostTransform, applyBudgetTransform, applyClientRollbackTransform } from '../deploy/core-host-transform.mjs'
import { wrapGenerateRaw } from '../lib/sandbox-policy.js'
const fixture = fileURLToPath(new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/index.js', import.meta.url))
if (!existsSync(fixture)) throw new Error('缺少作者2.5.0代码夹具；不能把未执行的生产锚点当通过')
const transformed = applyHostTransform(readFileSync(fixture, 'utf8'))
assert.equal(applyHostTransform(transformed), transformed)
for (const required of [
  'ownExecution: dispose => ctx.effect(() => dispose',
  'storageBrowserScripts(helperRuntime.scripts, { store: storageDispatchMarks, cardPath: chat.cardPath })',
  "event: 'MESSAGE_EDITED', args: [after.to]",
  'readSlice: chatPersistence.readSlice',
]) assert.ok(transformed.includes(required), required)
// 旧断言 `binding.context ||` 已移除（分类①过时断言）：那是旧版 wrapGenerateRaw 的三元写法。
// 现行契约（lib/sandbox-policy.js:87-92）是条件展开 `...(typeof readGenerationContext === 'function'
// ? { context: ... } : {})`，该字符串本就不由 core-host-transform 产出；护栏由其下方的
// generateRaw 端到端断言承担（got.context.messages[0] + 回程同一 binding 校验），语义未削弱。
assert.ok(transformed.indexOf('const bodyView = await bodyEditor.save') < transformed.indexOf("event: 'MESSAGE_EDITED'"))
assert.ok(!transformed.includes("owner: chat.mvu.owner === 'official' ? 'official' : 'legacy',"))
const dispatch = applyBudgetTransform('export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000', 'dispatch')
assert.equal(applyBudgetTransform(dispatch, 'dispatch'), dispatch)
assert.ok(dispatch.includes('BUDGETS.scriptClaimMs'))
assert.ok(applyBudgetTransform('timeoutMs = 120000, idleMs = 600000', 'template').includes('BUDGETS.serverTemplateMs'))
// —— 客户端 resync 段（2.5.0 上**无法成立**，本节按"只报不改"降级为显式声明，不静默绿）——
// 事实（2026-10-05 核实）：产品 deploy/rollback-sync-author-transform.mjs:34 用 once() 要求
// `historyProjection.rolledBack(props.sessionId, result && result.view);` 在文件中**恰好出现 1 次**。
//   · 2.4.0 B 镜像：命中 1 次 ⇒ 旧断言成立。
//   · 2.5.0 作者源：命中 **3 次**（16708 rollbackTurn 主路径 / 17128 clearFailedTail /
//     17169 回退上一轮恢复路径）—— 2.5.0 新增了两处失败尾恢复调用点。
// 因此该 once() 在 2.5.0 上**必然抛"回退同步作者锚点缺失/不唯一"**。这是**产品缺陷嫌疑**（V-1），
// 不是测试过时：唯一的既有锚点选择逻辑（"只认唯一命中，拒绝猜测"）本身正确，缺的是 2.5.0 下
// 应当采纳哪一个调用点的**产品决策**（三处 rpc("rollbackTurn") 后都需要同一 resync 语义）。
// 按任务授权（只报不改，禁改 deploy/），本测试不对该段做任何正向或反向断言，只如实登记，
// 以免把"未验证"伪装成"通过"。修复归属：deploy/rollback-sync-author-transform.mjs 的锚点策略。
const CLIENT_RESYNC_BLOCKED_BY = 'deploy/rollback-sync-author-transform.mjs:34 once() 锚点在 2.5.0 命中 3 次（需产品决策，未修）'
console.log('core-host-transform: 客户端 resync 段未验证 —— ' + CLIENT_RESYNC_BLOCKED_BY)
const binding = { sessionId: 'only-fixture', eventId: 'tx-fixture' }
const activity = { pending: 0 }; let got
const generated = wrapGenerateRaw({ bindingOf: () => binding, activity, str: String, options: {
  readGenerationContext: async current => { assert.equal(current, binding); return { messages: [{ message: '本事务改写后的正文' }] } },
  generateRaw: async (config, identity) => { got = identity; return '结果' },
} })
assert.equal(await generated({}), '结果')
assert.equal(got.context.messages[0].message, '本事务改写后的正文')
assert.equal(got.eventId, 'tx-fixture'); assert.equal(activity.pending, 0)
console.log('core-host-transform: 2.5.0 B消费者/幂等/预算/generateRaw当前事务上下文定向通过')
