// V2 public 独占改动定向验证（最小断言；本文件独占，不改其余源码）。
//
// 覆盖本轮 5 组 public 改动，全部从 **public-fixture（纯作者源）** 只读施缝：
//   ① 后台每任务删尾：Host 删前核同连接能力、删后发 child 基线；noop 重试仍同步；失败阻止后续任务；
//      旧 V2 产物升级幂等（marker 在但缺 sync 行 ⇒ 补上，不重复插）。
//   ② 客户端 applyTavernSessionCut：接基线后清旧 cell、保 running、不动前台；安装器键含 applyTavernSessionCut。
//   ③ empty identity 退役：只保可见/不删行（不是 DB delete）、读失败 fail-visible、只读 4 条初始化。
//   ④ current 资源：签名 scope 带 current、read 取实际 revision、不落 cache；路由 no-store；
//      客户端 current 放宽 revision 且不写 token cache；世界书守卫 !access.current（不写回旧值）。
//   ⑤ UI 寿命：V2 仍 iframe ⇒ copy bootstrap/runtime；official loader 不跑 ⇒ 不套 Proxy 包装。
//      标准 build 预检与 applyAll 后置重算两处都挂 background-retirement / current-resource / route。
//
// 不跑现有 custom 全块 tests；不运行服务/Agent/模型/真实档；不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { applyBackgroundHostRollbackTransform, applyBackgroundTaskRollbackTransform } from '../deploy/background-rollback-transform.mjs'
import { applySessionCutSyncClientTransform } from '../deploy/session-cut-sync-client-transform.mjs'
import { applyRollbackSyncClientTransform } from '../deploy/rollback-sync-client-transform.mjs'
import { ROLLBACK_INSTALLER } from '../deploy/rollback-sync-install-transform.mjs'
import { applyBackgroundRetirementTransform, applyBackgroundRetirementHostTransform } from '../deploy/background-retirement-transform.mjs'
import {
  applyCurrentResourceAccessTransform, applyCurrentResourceHostTransform,
  applyCurrentResourceClientTransform, applyCurrentResourceBookGuardTransform,
} from '../deploy/session-current-resource-transform.mjs'
import { applySessionResourceRouteTransform } from '../deploy/session-resource-route-transform.mjs'
import {
  applyBrowserUiLifetimeBootstrapTransform, applyBrowserUiLifetimeRuntimeTransform,
} from '../deploy/browser-ui-lifetime-transform.mjs'

const FX = new URL('../../../tmp/v2-compat-20261004-1648/public-fixture/tavern-plugin/', import.meta.url)

/** 缺 fixture 就 fail（不静默 skip、不伪 PASS）。 */
function author(rel) {
  const file = fileURLToPath(new URL(rel, FX))
  if (!existsSync(file)) assert.fail('缺少 public-fixture 纯作者源：' + rel + '（先跑 build-public-fixture.mjs）')
  return readFileSync(file, 'utf8')
}

// 从已施缝文本里切出 rewindSession 方法体（测试直接用真实作者实现，不手抄）。
// 结束边界改用后台 Host 施缝真正注入的删后通知行（该行唯一），不再依赖其它 transform 才产生的后置锚点。
function rewindBody(source) {
  const a = source.indexOf('    async rewindSession(agent, boundarySeq) {')
  const notify = source.indexOf('sync.publishSessionCut({ session: agent.session, agent })', a)
  const close = source.indexOf('    },', notify)
  assert.ok(a >= 0 && notify > a && close > notify, 'rewindSession 未定位到（施缝注入缺失或通知行不唯一）')
  assert.equal(source.split('sync.publishSessionCut({ session: agent.session, agent })').length - 1, 1, '删后通知行应恰好一处')
  return source.slice(a, close + 5).trim().replace(/,$/, '')   // close+5 含方法自身的收尾 `    }`
}

// ---------- ① 后台每任务删尾：删前核接线 / 删后发 child 基线 ----------

test('后台删尾：删前核同连接能力，删后发 child 基线；noop 重试仍同步，能力缺失即拒且不删', async () => {
  const sealed = applyBackgroundHostRollbackTransform(author('lib/index.js'))
  const body = rewindBody(sealed)
  let trace = []
  let cut = { truncated: true }
  const session = { id: 'background-fixture' }
  const agent = { session, phase: { kind: 'idle' } }
  const sync = {
    assertReady() { trace.push('ready') },
    publishSessionCut(input) { trace.push('publish'); assert.equal(input.agent, agent); assert.equal(input.session, session) },
  }
  const build = (services) => new Function('ctx', 'chatPersistence', 'updateChat', 'cleanupAfterRollbackAtSeq',
    'return ({' + body + '})')({ get: (n) => n === 'tavernRollbackSync' ? services : {} }, { readSlice() {} }, () => {},
    async () => { trace.push('cut'); return cut }).rewindSession

  await build(sync)(agent, -1)
  assert.deepEqual(trace, ['ready', 'cut', 'publish'], '删前核 → 物理删 → 删后通知，顺序不得颠倒')

  // 物理无删除（noop 重试）仍重置旧订阅，且**不冒充**成真实物理删除。
  trace = []; cut = { truncated: false }
  await build(sync)(agent, -1)
  assert.deepEqual(trace, ['ready', 'cut', 'publish'], 'noop 重试仍须同步，不把无删除报成物理删除')

  // 能力缺失：在删之前就拒绝，物理删一步都不能发生。
  trace = []
  await assert.rejects(build({ assertReady() {} })(agent, -1), /缺少同连接截断同步/)
  assert.deepEqual(trace, [], '能力缺失必须在删除前拒绝（trace 应为空）')

  // 通知失败必须上抛，不能吞掉后让后续任务继续。
  await assert.rejects(build({ ...sync, publishSessionCut() { throw Error('原创通知失败') } })(agent, -1), /原创通知失败/)
})

test('后台删尾 Host：作者态施缝补同连接接线且幂等，缺删后通知即拒（半标记/漂移）', () => {
  const authorSrc = author('lib/index.js')
  const fresh = applyBackgroundHostRollbackTransform(authorSrc)
  assert.ok(fresh.includes('// [dsh-tavern-background-task-cut-sync:v1]'), '新施缝应带同步标记')
  assert.ok(fresh.includes("const sync = ctx.get('tavernRollbackSync')"), '应补同连接能力核')
  assert.ok(fresh.includes('sync.assertReady()'), '应补删除前就绪核')
  assert.equal(applyBackgroundHostRollbackTransform(fresh), fresh, '二次施缝必须字节不变')

  // 半标记：标记与接线都在，但删后通知被摘掉 ⇒ 标记不完整，拒绝。
  const halfMarker = fresh.replace('      sync.publishSessionCut({ session: agent.session, agent })\n', '')
  assert.notEqual(halfMarker, fresh, '构造半标记失败：publishSessionCut 行未命中')
  assert.ok(halfMarker.includes('// [dsh-tavern-background-task-cut-sync:v1]'), '半标记应保留 marker')
  assert.throws(() => applyBackgroundHostRollbackTransform(halfMarker), /不一致/, '缺删后通知必须被判为半标记')

  // 锚点漂移：消费者被改名 ⇒ 拒绝（不静默跳过）。反例构造在**纯作者源**上，改真实消费者初始化字面量。
  const driftAnchor = '  const backgroundAgentRunner = createBackgroundAgentRunner({'
  const driftedSource = authorSrc.replace(driftAnchor, '  const renamedRunner = createBackgroundAgentRunner({')
  assert.notEqual(driftedSource, authorSrc, '构造漂移反例失败：消费者初始化未命中')
  assert.throws(() => applyBackgroundHostRollbackTransform(driftedSource), /锚点缺失|不唯一|不一致/, '锚点漂移必须拒绝')

  // 通知行唯一：升级不得重复插入。
  assert.equal(fresh.split('sync.publishSessionCut({ session: agent.session, agent })').length - 1, 1, '通知行应恰好一处')
})

// ---------- ② 客户端 applyTavernSessionCut：清旧 cell / 保 running / 不动前台 ----------

const CUT_MARKER = '// [dsh-tavern-session-cut-sync-client:v1]'
const CUT_BRANCH = 'if (frame.type === "projection" && frame.key === "$dsh-tavern/session-cut-sync-v1")'

test('客户端截断同步：装到真实 rc.2 客户端的同连接产物上，键含 applyTavernSessionCut 且幂等', () => {
  // 真实链路：rc.2 客户端原件 → rollback-sync（落同连接安装器）→ session-cut（挂分支与方法）。
  const stepped = applyRollbackSyncClientTransform(author('src/client/rc2-session-client.js'))
  assert.ok(stepped.includes(CUT_MARKER), '同连接产物应已含截断同步标记（由 rollback-sync 转换串接施加）')
  assert.equal(stepped.split(CUT_MARKER).length - 1, 1, '标记应唯一')
  assert.ok(stepped.includes(CUT_BRANCH), 'control 分支应挂截断同步帧')
  assert.ok(stepped.includes('            applyTavernSessionCut(value) {'), '应写入 manager 方法')
  assert.ok(ROLLBACK_INSTALLER.includes('"applyTavernSessionCut"'), '同连接管理器方法键必须含 applyTavernSessionCut')

  // 幂等：两条转换各自对待施缝产物稳定。
  assert.equal(applyRollbackSyncClientTransform(stepped), stepped, 'rollback-sync 二次施缝必须字节不变')
  assert.equal(applySessionCutSyncClientTransform(stepped), stepped, 'session-cut 二次施缝必须字节不变')

  // 半标记必须拒绝：方法名被改即判不完整。
  const broken = stepped.replace('            applyTavernSessionCut(value) {', '            missingCut(value) {')
  assert.throws(() => applyRollbackSyncClientTransform(broken), /不完整/, '半标记必须拒绝（方法名被改）')
})

test('客户端截断同步：接基线后清旧 cell、保 running、不动前台，且不冒充 Chat 回退', () => {
  const stepped = applyRollbackSyncClientTransform(author('src/client/rc2-session-client.js'))
  const a = stepped.indexOf('            applyTavernSessionCut(value) {')
  const b = stepped.indexOf('            waitForTavernRollbackSync(receipt) {', a)
  assert.ok(a >= 0 && b > a, 'applyTavernSessionCut 未定位到')
  const method = stepped.slice(a, b)

  // 只核结构语义：无效基线抛错；清旧 rows；seed 新基线；不触碰 chat revision/前台。
  assert.ok(method.includes('throw new Error("后台截断同步基线无效")'), '无效基线必须拒')
  assert.ok(method.includes('store.rows.delete(key); store.changed(key);'), '必须清旧 cell')
  assert.ok(method.includes('store.seed({ asOfSeq: value.asOfSeq, values: value.values });'), '必须落新基线')
  assert.ok(method.includes('session?.replaceControl(value.queues);'), '必须保留 running/输入草稿（可选链，冷 child 不炸）')
  assert.ok(method.includes('return session ? session.resync() : Promise.resolve();'), '冷 child 不得被通知打开')
  assert.ok(!method.includes('chatId'), '截断同步不得冒充 Chat 身份')
  assert.ok(!method.includes('revision ='), '截断同步不得改 Chat revision')
})

// ---------- ③ empty identity 退役：可见性过滤，不是 DB delete ----------

test('空后台退役：只过滤发现可见性，不删行、不永久禁 resume、读失败 fail-visible', async () => {
  const next = applyBackgroundRetirementTransform(author('lib/domain/background-session-retirement.js'))
  assert.equal(applyBackgroundRetirementTransform(next), next, '二次施缝必须字节不变')
  const create = new Function(next.replace(/export /g, '') + ';return createBackgroundSessionRetirement')()

  const chat = {
    timeline: {
      participants: { background: { sessionId: 'current' }, image: { sessionId: 'picture' } },
      operations: { a: { kind: 'agent', status: 'completed', startedSessionId: 'op-owned' } },
      checkpoints: [{ participants: { background: { sessionId: 'checkpoint-owned' } } }],
    },
  }
  const rows = ['old', 'current', 'picture', 'op-owned', 'checkpoint-owned', 'running', 'tree', 'other-kind']
    .map((id) => ({ id, kind: 'child', parentId: 'parent', activity: id === 'running' ? 'running' : 'inactive', hasChildren: id === 'tree' }))
  const observed = []
  const store = create({ readJson: async () => ({}) }, {
    readState: async () => chat,
    isRunning: (id) => id === 'live',
    readEmptyIdentity: async (id, p) => { observed.push([id, p]); return id === 'old' },
  })

  const out = await store.filter(rows, 'parent')
  // 只有空身份 old 不出现；其余（当前/图片/操作拥有/checkpoint 拥有/运行/有子树/他类）全部保留。
  assert.deepEqual(out.map((r) => r.id), rows.filter((r) => r.id !== 'old').map((r) => r.id),
    '只退役无引用的空身份，其余可见性一律保留')
  // 过滤不是删除：行数只少 1，且退役不永久禁旧身份 resume。
  assert.equal(out.length, rows.length - 1, '这是可见性过滤，不是 DB delete')
  assert.equal(await store.isRetired('old'), false, '推断发现可见性不得永久禁旧身份 resume')

  // 回退恢复旧 participant ⇒ 立刻重新可见。
  chat.timeline.participants.background.sessionId = 'old'
  assert.ok((await store.filter(rows, 'parent')).some((r) => r.id === 'old'), '恢复引用即保可见')

  // 读身份失败 ⇒ fail-visible（宁可见不误删）。
  const failing = create({ readJson: async () => ({}) }, {
    readState: async () => ({ timeline: { participants: {}, operations: {} } }),
    isRunning: () => false,
    readEmptyIdentity: async () => { throw Error('fixture') },
  })
  assert.deepEqual(await failing.filter(rows), rows, '读身份失败必须 fail-visible')
})

test('空后台退役 Host：只 4 条初始化 + descriptor 精确 provider，count 变即保；幂等', async () => {
  const sealed = applyBackgroundRetirementHostTransform(author('lib/index.js'))
  assert.equal(applyBackgroundRetirementHostTransform(sealed), sealed, '二次施缝必须字节不变')
  const a = sealed.indexOf('    readEmptyIdentity: async')
  const b = sealed.indexOf('\n  })', a)
  assert.ok(a >= 0 && b > a, 'readEmptyIdentity 未定位到')

  const events = ['permission/preset', 'sandbox/mode', 'approval/policy', 'subagent/descriptor']
    .map((type, seq) => ({ type, seq, data: seq === 3 ? { provider: 'dsh-tavern-background-tools-v4', mode: 'continuable' } : {} }))
  const header = { id: 'old', parentSession: 'parent', origin: 'subagent' }
  let n = 4, reads = 0
  const reader = new Function('ctx', 'return ({' + sealed.slice(a, b) + '}).readEmptyIdentity')({
    get: () => ({
      stat: async () => ({ header, eventCount: n }),
      requireStoredLog: async () => { reads++; return { meta: header, events } },
    }),
  })

  assert.equal(await reader('old', 'parent'), true, '精确 4 条初始化 + 正确 provider 才算空身份')
  events[3].data.provider = 'unrelated'
  assert.equal(await reader('old', 'parent'), false, 'provider 不符即保可见')
  events[3].data.provider = 'dsh-tavern-background-tools-v4'
  assert.equal(await reader('old', 'other-parent'), false, '不同 parent 不做判断')
  n = 22
  assert.equal(await reader('old', 'parent'), false, 'count 变即有任务尾 ⇒ 保')
  assert.equal(reads, 2, '有任务尾时不读全日志（只 header/count 筛选）')
  n = 4
  events[2].type = 'tool/call'
  assert.equal(await reader('old', 'parent'), false, '事件类型序列不符即保')
})

// ---------- ④ current 资源：签名 current / 实际 revision / 不落 cache / 守卫 ----------

test('current 资源：签名 scope 带 current，read 取实际 revision 且不落 cache', async () => {
  const raw = author('lib/domain/session-resource-access.js')
  const sealed = applyCurrentResourceAccessTransform(raw)
  assert.equal(applyCurrentResourceAccessTransform(sealed), sealed, '二次施缝必须字节不变')

  const load = async (code) => (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).createSessionResourceAccess
  let revision = 0
  const make = async (code) => (await load(code))({ read: async () => ({ revision, value: { name: '卡' + revision } }) })

  const legacy = await make(raw)
  const cur = await make(sealed)

  // legacy 仍按签发 revision 相等校验。
  const legacyCap = legacy.issue('c1', 0, 'card')
  assert.equal(legacyCap.current, undefined, 'legacy 签发不得带 current')
  assert.equal(JSON.parse(await legacy.read(legacyCap.token)).revision, 0)

  // current：签发 hint=0，读时 revision 已变 1 ⇒ 返回**实际** revision 并标 current。
  const cap = cur.issue('c1', 0, 'card', true)
  assert.equal(cap.current, true, 'current 签发应带 current')
  revision = 1
  const reply = JSON.parse(await cur.read(cap.token))
  assert.equal(reply.revision, 1, 'current 必须返回读取当刻的实际 revision，不是签发 hint')
  assert.equal(reply.current, true, 'current 回执应标记 current')
  assert.equal(reply.value.name, '卡1')

  // 不落 cache：同一 token 再读拿到新值（值随当前卡变化）。
  revision = 2
  assert.equal(JSON.parse(await cur.read(cap.token)).revision, 2, 'current 不得缓存，必须每次取当前值')

  // 篡改/无效能力仍拒。
  await assert.rejects(cur.read(cap.token + 'x'), /Invalid resource capability/, '篡改签名仍拒')
})

test('current 资源 Host：零正文取头行 + 实际 revision；legacy 分支不动', async () => {
  const sealed = applyCurrentResourceHostTransform(author('lib/index.js'))
  assert.equal(applyCurrentResourceHostTransform(sealed), sealed, '二次施缝必须字节不变')
  const a = sealed.indexOf('  const sessionResources = createSessionResourceAccess({ read: async')
  const b = sealed.indexOf('\n  } })', a)
  assert.ok(a >= 0 && b > a, '资源读回调未定位到')
  assert.ok(sealed.includes("sessionResources.issue(chat.id, resourceRevision, 'card', true)"), 'current 卡能力未签发')
  assert.ok(sealed.includes("sessionResources.issue(chat.id, resourceRevision, 'worldbook', true)"), 'current 书能力未签发')
  assert.ok(sealed.includes('const chat = await readChatRevision(chatId, revision)'), 'legacy 分支必须保留')

  // 关键：current 只读头行（limit1/before0 指定字段），零 messages。
  assert.ok(sealed.includes("fields: ['id', 'sessionId', 'mode', 'cardPath', 'cardDefinitionSnapshot', 'openingWorldbookSnapshot'] })"),
    'current 必须只取头行指定字段')

  // 用**真实转换后的 read 实现**跑一次：确认只读 1 条、before0、零 messages、回实际 revision。
  const raw = author('lib/domain/session-resource-access.js')
  const sealedAccess = applyCurrentResourceAccessTransform(raw)
  const createAccess = (await import('data:text/javascript;base64,' + Buffer.from(sealedAccess).toString('base64'))).createSessionResourceAccess
  const calls = []
  const persistence = {
    readWindow: async (id, o) => {
      calls.push({ id, o })
      return {
        revision: 7,
        chat: { id, messages: [], mode: 'story', cardPath: 'p', cardDefinitionSnapshot: { name: '当前卡' }, openingWorldbookSnapshot: { version: 1 } },
      }
    },
  }
  const resource = new Function('createSessionResourceAccess', 'deletedChatIds', 'chatPersistence', 'readChatRevision', 'readChatCard', 'cardViewOf', 'worldBooks', 'projectTavernHelperWorldbook',
    sealed.slice(a, b + 8) + ';return sessionResources')(
    createAccess, new Set(), persistence,
    () => { throw Error('current 分支不得回放旧整档') },
    async (c) => c.cardDefinitionSnapshot, (c) => c,
    { bound: async () => ({ view: { entries: ['当前书'] } }) }, (v) => v)

  const cap = resource.issue('c1', 0, 'card', true)
  const reply = JSON.parse(await resource.read(cap.token))
  assert.equal(calls.length, 1, 'current 必须恰好读一次头行')
  assert.equal(calls[0].o.limit, 1, 'current 只取头行')
  assert.equal(calls[0].o.before, 0, 'current 只取头行')
  assert.equal(reply.revision, 7, 'current 回**读取当刻**的实际 revision，不是签发 hint 0')
  assert.equal(reply.value.name, '当前卡')
})

test('current 客户端：放宽 revision、current 不写 token cache、世界书守卫 !access.current', () => {
  const readerSrc = author('src/client/helper-resources.js')
  const sealed = applyCurrentResourceClientTransform(readerSrc)
  assert.equal(applyCurrentResourceClientTransform(sealed), sealed, '二次施缝必须字节不变')
  assert.ok(sealed.includes('assertResourceActive();'), 'current 客户端应带窗口寿命门禁')
  assert.ok(sealed.includes('const current = access && access.current === true;'), 'current 分支应识别 current 令牌')
  assert.ok(sealed.includes('if (result.current !== true || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error(\'人物卡资源版本不匹配，请刷新会话\');'),
    'current 必须放行任意合法 revision（值随当前卡变化）')
  assert.ok(sealed.includes('if (!(access && access.current === true) && cache.has(access.token)) return cache.get(access.token);'),
    'current 不得命中 token cache')
  assert.ok(sealed.includes('if (!current && cache.has(access.token)) return cache.get(access.token);'),
    'readAsync 对 current 必须跳过 cache')

  // 世界书守卫：current 令牌下 token 相等不代表值相同，必须加 !access.current。
  const bundle = author('lib/client.js')
  const guarded = applyCurrentResourceBookGuardTransform(bundle)
  assert.equal(applyCurrentResourceBookGuardTransform(guarded), guarded, '守卫二次施缝必须字节不变')
  assert.ok(guarded.includes('if (!access.current && state.worldbook?.resourceAccess?.token === access.token) state.worldbook = copy(book);'),
    '世界书守卫必须加 !access.current（否则把旧当前书写回）')
  assert.throws(() => applyCurrentResourceBookGuardTransform('no anchor here'), /锚点缺失/, '守卫锚点缺失必须抛错，不静默放过')
})

// ---------- ⑤ 路由 no-store + 标准两处挂点 + UI 寿命边界 ----------

test('资源路由：200/403 同带 no-store，403 只给安全原因码', () => {
  const sealed = applySessionResourceRouteTransform(author('lib/http/routes.js'))
  assert.equal(applySessionResourceRouteTransform(sealed), sealed, '二次施缝必须字节不变')
  assert.ok(sealed.includes("res.writeHead(200, {...headers,'Cache-Control':'no-store'}); res.end(json)"), '200 必须 no-store')
  assert.ok(sealed.includes("res.writeHead(403, {...headers, 'Cache-Control':'no-store'})"), '403 必须 no-store')
  assert.ok(sealed.includes('RESOURCE_CAPABILITY_INVALID') && sealed.includes('RESOURCE_REVISION_UNAVAILABLE'), '403 只给安全原因码')
  assert.ok(!sealed.includes('cap,') && !sealed.includes('token:'), '403 不得回显 cap/token')
})

test('标准预检与 applyAll 后置重算两处都挂退役/current/route；UI 寿命令 V2 只 copy 不套 official loader', () => {
  const standard = readFileSync(new URL('../deploy/standard-seams.mjs', import.meta.url), 'utf8')
  const transforms = readFileSync(new URL('../deploy/standard-seam-transforms.mjs', import.meta.url), 'utf8')

  // index 写口（预检与 applyAll 后置重算合并后的单一挂点）必须保留 current+retirement（含 forkHistory）。
  const compose = "write.set('tavern-plugin/lib/index.js', applyCurrentResourceHostTransform(applyBackgroundRetirementHostTransform(applyForkHistoryTransform(write.get('tavern-plugin/lib/index.js')))))"
  assert.ok(transforms.includes(compose), 'index 写口缺 current+retirement 挂点')
  // route 转换仍挂；新旧 domain 目标都要进 DOMAINS/HOST 清单。
  assert.ok(transforms.includes("write.set('tavern-plugin/lib/http/routes.js', applySessionResourceRouteTransform(text(appDir, 'tavern-plugin/lib/http/routes.js')))"), 'route 转换未挂')
  assert.ok(standard.includes("'background-session-retirement.js'") && standard.includes("'session-resource-access.js'"), '新旧 domain 目标未进 DOMAINS')
  assert.ok(standard.includes("'index.js'") && standard.includes("'http/routes.js'"), 'HOST 清单缺 index/routes')

  // UI 寿命：V2 仍 iframe ⇒ copy bootstrap/runtime（不发明新挂点）；
  // official loader 在 V2 **不跑**（标准装配不传该转换）⇒ 不得给官方 bundle 套 jQuery Proxy 包装。
  const bootSrc = author('src/client/runtime/helper-bootstrap.js')
  const boot = applyBrowserUiLifetimeBootstrapTransform(bootSrc)
  assert.equal(applyBrowserUiLifetimeBootstrapTransform(boot), boot, 'UI bootstrap 二次施缝必须字节不变')
  assert.ok(boot.includes('// [dsh-tavern-ui-lifetime-bootstrap:v1]'), 'bootstrap 应写入寿命标记')
  assert.ok(boot.includes('function uiRuntimeIsActive() { return !helperUiDisposed && !window.closed; }'), 'bootstrap 应有窗口寿命判据')
  assert.ok(boot.includes('const resources = modules.createResourceReader({isActive:uiRuntimeIsActive});'), 'bootstrap 应把寿命门禁接进 reader')
  assert.ok(boot.includes("window.addEventListener(\"pagehide\", disposeScriptRuntime, { once: true });"), 'bootstrap 应挂 pagehide 清理')

  const runtimeSrc = author('src/client/runtime/helper-script-runtime.js')
  const runtime = applyBrowserUiLifetimeRuntimeTransform(runtimeSrc)
  assert.equal(applyBrowserUiLifetimeRuntimeTransform(runtime), runtime, 'UI runtime 二次施缝必须字节不变')
  assert.ok(runtime.includes('__dshTavernDisposeScriptRuntime?.();'), 'runtime 必须先卸载再移除 iframe')
  assert.ok(runtime.indexOf('__dshTavernDisposeScriptRuntime?.();') < runtime.indexOf('record.frame.remove();'), 'unmount 必须在 remove 之前')

  // official loader：V2 不施加（未挂进标准装配），且其独有 Proxy 包装不得出现在 bootstrap 产物里。
  const loaderSrc = author('src/client/runtime/helper-loader.js')
  assert.ok(!standard.includes('applyBrowserUiLifetimeLoaderTransform'), 'V2 标准装配不得施加 official loader 包装')
  assert.ok(!boot.includes('__jq = window.jQuery'), 'V2 不得给官方 bundle 套 jQuery Proxy（official loader 不跑）')
  assert.ok(!loaderSrc.includes('__jq = window.jQuery'), '官方 loader 源本身不应带我们的包装')
})

// ---------- 幂等回读：全部 5 组转换对已施缝产物稳定 ----------

test('全部 public 转换幂等回读：二次施缝逐字节不变，作者 fixture 未被写回', () => {
  const pairs = [
    [applyCurrentResourceAccessTransform, 'lib/domain/session-resource-access.js'],
    [applyCurrentResourceHostTransform, 'lib/index.js'],
    [applyBackgroundRetirementHostTransform, 'lib/index.js'],
    [applySessionResourceRouteTransform, 'lib/http/routes.js'],
  ]
  for (const [fn, rel] of pairs) {
    const once = fn(author(rel))
    assert.equal(fn(once), once, rel + ' 二次施缝不幂等')
  }
  // 纯函数：作者源原样不落标记。
  assert.ok(!author('lib/index.js').includes('// [dsh-tavern-v1-empty-worker-reader:v1]'), 'fixture 不应被写回（转换是纯函数）')
  assert.ok(!author('lib/http/routes.js').includes('// [dsh-tavern-v1-resource-route:v1]'), 'fixture 不应被写回')
})

console.log('public-sync: 后台删尾同步/客户端截断/空身份退役/current资源/路由no-store/UI寿命边界/标准两处挂点 定向通过')
