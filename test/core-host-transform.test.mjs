// 仅本轮Host策略delta与SQLite变量消费者断言；不启动作者/GUI，不读取存档。
// 作者源码根默认取本机当前上游树（只读），可用环境变量覆盖；不用旧版本快照冒充现役锚点。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { applyHostTransform, applyBudgetTransform } from '../deploy/core-host-transform.mjs'
const authorRoot = path.resolve(process.env.DSH_TAVERN_COMPUTE_AUTHOR || 'D:/Program Files (x86)/DSH-Tavern/data/harness/apps/dsh-tavern')
const fixture = path.join(authorRoot, 'tavern-plugin/lib/index.js')
if (!existsSync(fixture)) throw new Error('缺少当前上游作者 index.js；不能把未执行的生产锚点当通过：' + fixture)

test('上游计算策略/幂等/预算/SQLite消费者：现役作者Host命中且旧计算与兼容残留清零', () => {
  const transformed = applyHostTransform(readFileSync(fixture, 'utf8'))
  assert.equal(applyHostTransform(transformed), transformed)
  // 上游唯一计算：策略接线、旧自有执行器与浏览器脚本投影均已退役。
  for (const required of [
    'authorizeUpstreamCall(method, args,',
    "owner: 'official'",
    'requiresBrowser: async () => false',
    'priority: () => 0',
    'compute: () => serverScripts',
    'readSlice: chatPersistence.readSlice',
  ]) assert.ok(transformed.includes(required), required)
  for (const removed of ['createServerExecution', 'storageBrowserScripts', 'pagesInFront', 'DSH_TAVERN_SERVER_SCRIPTS', "ctx.get('serverScripts')"])
    assert.ok(!transformed.includes(removed), '旧计算/兼容残留：' + removed)
  const dispatch = applyBudgetTransform('export const TAVERN_SCRIPT_CLAIM_TIMEOUT_MS = 30000', 'dispatch')
  assert.equal(applyBudgetTransform(dispatch, 'dispatch'), dispatch)
  assert.ok(dispatch.includes('BUDGETS.scriptClaimMs'))
  assert.ok(applyBudgetTransform('function runtime({timeoutMs = 120000, idleMs = 600000}) {}', 'template').includes('BUDGETS.serverTemplateMs'))
})
