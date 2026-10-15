// 公开 API 合同闸（定向）：只核"文档 ↔ package.json exports ↔ 替代符号在仓内存在"三者一致，
// 并登记 2026-10-15 计算重构按用户授权的删除集合；**不测任何未改行为**。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const doc = fs.readFileSync(new URL('../PUBLIC-API-COMPATIBILITY.md', import.meta.url), 'utf8')
const read = rel => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
const keys = Object.keys(manifest.exports)

test('兼容文档与 package.json exports 一一对应：45 键、退役集合已删尽', () => {
  assert.equal(keys.length, 46, '公开合同面必须为 46 个子路径；增删应同步更新兼容文档与策略')
  for (const key of keys) assert.ok(doc.includes(key === '.' ? '`.`' : key), '兼容文档缺少导出条目：' + key)
  assert.match(doc, /prod（仓内生产消费者\/根入口\/宿主装配） \| 32/, 'prod 计数必须为 32')
  assert.match(doc, /deploy-only（仅 deploy 动态装配） \| 11/, 'deploy-only 计数必须为 11')
  assert.match(doc, /test-only \| 1 \| `\.\/variable-store`/, './variable-store 必须登记为 test-only')
  assert.match(doc, /infra（解析器基础设施） \| 2/, 'infra 计数必须为 2')
  assert.ok(doc.includes('2026-10-15 计算重构'), '必须记录本次计算重构的删除授权')
  // 计算重构删除的 11 个导出必须全部不在 exports 中；文档只能把它们登记为已删除，不得当作现存导出。
  const retired = ['./sandbox-policy', './mvu-card-runtime', './mvu-script-sandbox', './mvu-update-core', './card-script-dispatch-store', './server-execution', './server-dependencies', './opening-server-init', './esm-module-loader', './tavern-helper-api', './tavern-regex-api']
  for (const key of retired) {
    assert.ok(!manifest.exports[key], '计算专用导出必须已删除：' + key)
    assert.ok(doc.includes('| `' + key + '` | `lib/'), '文档必须把 ' + key + ' 登记为已删除条目')
    assert.ok(!doc.includes('`' + key + '` —— **prod'), key + ' 不得再登记为 prod 现存导出')
  }
  for (const rel of ['lib/server-execution.js', 'lib/sandbox-policy.js', 'lib/opening-server-init.js', 'lib/server-dependencies.js', 'lib/card-script-dispatch-store.js', 'lib/tavern-helper-api.js', 'lib/tavern-regex-api.js', 'lib/mvu/mvu-card-runtime.js', 'lib/mvu/mvu-update-core.js', 'lib/mvu/mvu-script-sandbox.js', 'lib/mvu/esm-module-loader.js', 'lib/vendor/lodash/lodash.min.js', 'lib/vendor/json5/index.mjs', 'lib/vendor/jsonrepair/esm/index.js'])
    assert.ok(!fs.existsSync(new URL('../' + rel, import.meta.url)), '自有计算实现必须已删除：' + rel)
  // 上游接入与现役存储链的替代符号必须真实存在。
  assert.match(read('lib/upstream-compute.js'), /export function authorizeUpstreamCall/, 'authorizeUpstreamCall 必须存在于 lib/upstream-compute.js')
  assert.match(read('lib/variable-archive.js'), /export function createVariableArchive/, 'createVariableArchive 必须存在于 lib/variable-archive.js')
  assert.match(read('chat-sqlite-store.js'), /from '\.\/lib\/variable-archive\.js'/, '现役变量链必须仍由 chat-sqlite-store.js 构造')
  assert.match(read('lib/rollback-head-prune.js'), /export (?:async )?function cleanupRollbackHeadIndex/, 'cleanupRollbackHeadIndex 必须存在（该导出仍保留）')
  assert.match(read('deploy/core-host-transform.mjs'), /authorizeUpstreamCall/, 'Host 必须改走上游身份策略')
})

test('计算重构政策不变量在文档中就位：唯一上游执行、禁客户端、不留兼容分支', () => {
  assert.ok(doc.includes('唯一公开合同面'), '必须写明 exports 是唯一合同面')
  assert.ok(doc.includes('不转交页面、不切旧引擎'), '必须明确失败不回落')
  assert.ok(doc.includes('不留垫片、不留兼容分支'), '必须明确删除是彻底的')
  assert.ok(doc.includes('不直接写库'), '必须明确外部集成不直接写库')
  // 计算重构只删除**已授权**的计算专用导出；其余导出仍遵守"未核外部消费者不得删除"。
  assert.match(doc, /未核[\s\S]*不得删除/, '未核外部消费者前必须禁止删除其余导出')
  assert.ok(doc.includes('退役三步'), '其余导出仍走标注→停新→大版本移除流程')
  assert.ok(!/直接使用 variable-archive 写库|用 variable-archive 直接写/.test(doc), '不得推荐外部用 variable-archive 直接写库')
})

console.log('public-api-compatibility: 文档↔exports一致/计算退役集合清零/替代符号可证/政策不变量 定向通过')
