// 早期 capture（发送接受同步前像）定向测试 —— **本轮只写不执行**（等主通知；叶③需主 CAS 补完）。
// 用真实 host Session + 真实 SQL chat store + 真实 captureAcceptedSend（经临时 DSH_HOME/profile 清单解析 dataRoot，
// sessions.json 为自建 tmp 夹具，无任何真实数据）。可写文件：仅本文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { installSendAcceptance } from '../lib/send-acceptance.js'
import { invalidateLinkMap } from '../lib/tavern-chat-state.js'

const requireHost = createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app', 'package.json'))
const HOME_BEFORE = process.env.DSH_HOME
const TREE = new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/', import.meta.url)
const DOMAIN = 'tavern-plugin/lib/domain/'
// 真实施缝 timeline 模组：storage-rollback-business 以**本包** rollback-business-state.js 准确导出 DI，
// 其余作者 relative domain 用真实文件绝对 URL；body 逻辑全部来自作者实现（不自造）。
async function seamedTimeline(root) {
  const load = name => import(new URL(name, new URL('../deploy/', import.meta.url)).href)
  const [row, business, settlement, anchor] = await Promise.all([load('row-rollback-transform.mjs'), load('rollback-business-transform.mjs'), load('settlement-round-transform.mjs'), load('latest-send-anchor-transform.mjs')])
  const source = anchor.applySendAnchorTimelineTransform(settlement.applySettlementRoundTransform(business.applyRollbackBusinessTimelineTransform(row.applyRowTimelineTransform(readFileSync(new URL(DOMAIN + 'story-timeline.js', TREE), 'utf8')))))
  const shim = path.join(root, 'storage-rollback-business-deps.mjs')
  writeFileSync(shim, `export * from ${JSON.stringify(new URL('../lib/rollback-business-state.js', import.meta.url).href)}\n`, 'utf8')
  const rewritten = source.replace(/from '(\.[^']+)'/g, (_all, rel) => 'from ' + JSON.stringify(rel === './storage-rollback-business.js' ? pathToFileURL(shim).href : new URL(rel, new URL(DOMAIN, TREE)).href))
  const mod = await import('data:text/javascript;base64,' + Buffer.from(rewritten, 'utf8').toString('base64'))
  return mod.createStoryTimeline({})
}

function helpers() {
  const api = { copyJsonTree: value => value === undefined ? undefined : structuredClone(value), applyJsonChangesShared: value => value }
  for (const key of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) api[key] = value => value
  api.diffJson = (old, next) => {
    const changes = []
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) if (key !== 'messages' && JSON.stringify(old[key]) !== JSON.stringify(next[key])) changes.push({ op: 'set', path: [key], value: next[key] })
    if (next.messages.length < old.messages.length) changes.push({ op: 'splice', path: ['messages'], index: next.messages.length, deleteCount: old.messages.length - next.messages.length, items: [] })
    else for (let i = 0; i < next.messages.length; i += 1) if (JSON.stringify(old.messages[i]) !== JSON.stringify(next.messages[i])) changes.push({ op: 'set', path: ['messages', i], value: next.messages[i] })
    return changes
  }
  return api
}

async function fixture({ sessionId = 'session-send-accept', chatId = 'chat-send-accept' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-send-acceptance-'))
  const home = path.join(root, 'dsh-home')
  const dataRoot = path.join(root, 'tavern-data')
  mkdirSync(path.join(home, 'profiles', 'tavern'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'tavern', 'package.json'), JSON.stringify({ dshTavern: { dataRoot } }), 'utf8')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path.join(dataRoot, 'sessions.json'), JSON.stringify({ [sessionId]: chatId }), 'utf8')
  process.env.DSH_HOME = home
  invalidateLinkMap()
  // 真实 host Session 实现（与 clean-rollback-integration 同法：只放行 assistant replace 形态引用，不是跳过整套校验）。
  const raw = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
    .replace(/from "(@deepseek-ai\/[^"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
  const patched = raw.replace('if (event.type === "assistant/message" && raw !== void 0) throw', 'if (event.type === "assistant/message" && raw !== void 0 && event.surfaceOp?.op !== "replace") throw')
  const file = path.join(root, 'session.mjs')
  writeFileSync(file, patched, 'utf8')
  const { Session } = await import(pathToFileURL(file).href)
  const store = createChatSqliteStore({ dataRoot, helpers: helpers() })
  const chat = {
    id: chatId, sessionId, _storageRevision: 1, mode: 'story',
    messages: [{ role: 'user', text: '上一条输入' }, { role: 'assistant', turn: 5, text: '上一轮正文', swipeId: 0, swipes: ['上一轮正文'], variables: [{ hp: 5 }] }],
    variables: { hp: 5 }, timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 5, checkpoints: [], operations: {}, participants: {} },
  }
  await store.update(chatId, () => chat)
  const uninstallAcceptance = installSendAcceptance(Session)   // 缺省＝真实 captureAcceptedSend
  const read = () => store.read(chatId)
  const bodyOpFor = async turn => (await read()).timeline.operations ? Object.values((await read()).timeline.operations).find(op => op?.kind === 'body' && Number(op.turn) === turn) : undefined
  const cleanup = async () => {
    uninstallAcceptance()
    store.dispose()
    if (HOME_BEFORE === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = HOME_BEFORE
    invalidateLinkMap()
    rmSync(root, { recursive: true, force: true })
  }
  return { root, home, dataRoot, Session, sessionId, chatId, store, read, bodyOpFor, cleanup }
}

test('审查修复R10真实开场：静态append不造running记录，随后真实发送即时捕获完整前像',async()=>{
 const f=await fixture()
 try{
  const {applyOpeningCommitTransform}=await import('../deploy/opening-commit-transform.mjs')
  const {withNativeOpening}=await import('../lib/send-acceptance.js')
  const {latestSendTarget}=await import('../lib/latest-send.js')
  const {createHash}=await import('node:crypto')
  const domain=new URL('../../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b/tavern-plugin/lib/domain/',import.meta.url)
  const {sessionEvents,appendSessionEvent}=await import(new URL('session-events.js',domain))
  const source=applyOpeningCommitTransform(readFileSync(new URL('conversation-initialization.js',domain),'utf8'))
  const from=source.indexOf('  function openingId(chat) {'),to=source.indexOf('  async function appendNativeOpening(',from)
  assert.ok(from>=0&&to>from)
  const append=new Function('withNativeOpening','sessionEvents','appendSessionEvent','createHash','str',source.slice(from,to)+'\nreturn appendOpeningEvents')(withNativeOpening,sessionEvents,appendSessionEvent,createHash,value=>String(value??''))
  await f.store.update(f.chatId,current=>{current.messages=[{role:'assistant',turn:1,greeting:true,text:'原创开场',swipeId:0,swipes:['原创开场'],variables:[{hp:1}]}];current.variables={hp:1};current._storageRevision++;return current})
  const session=f.Session.create(f.sessionId),before=await f.read()
  append(session,before,'原创开场',false)
  const opening=await f.read()
  assert.equal(opening._storageRevision,before._storageRevision,'静态开场不触发发送前像提交')
  assert.equal(Object.values(opening.timeline.operations).some(op=>op.kind==='body'),false)
  assert.equal(latestSendTarget(opening,{events:session.snapshotEvents()}),null)
  session.append('turn/start',{turn:2})
  session.append('user/message',{id:'real-input-2',role:'user',content:[{type:'text',text:'真正发送'}],source:{kind:'user'}},{surfaceOp:'append'})
  const accepted=await f.read(),op=Object.values(accepted.timeline.operations).find(op=>op.turn===2)
  assert.ok(op?.businessBefore);assert.deepEqual(op.businessBefore.fields.variables,{hp:1});assert.equal(op.businessBefore.messageCount,1)
  assert.ok(op.nativeAnchor);assert.equal(latestSendTarget(accepted,{events:session.snapshotEvents()}).turn,2)
 }finally{await f.cleanup()}
})

test('发送接受同步前像：turn/start立即落running body前像、user/message补nativeAnchor且body.begin复用占位不覆盖', async () => {
  const f = await fixture()
  try {
    const session = f.Session.create(f.sessionId)
    session.append('session/end-seed', {})
    const before = await f.read()
    const revisionBefore = before._storageRevision
    const turn = 6
    // ① turn/start：append 之前同步落盘 running body 前像（还没有任何 prepare/模型调用）。
    session.append('turn/start', { turn })
    const started = await f.read()
    const op = Object.values(started.timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === turn)
    assert.ok(op, 'turn/start 必须在 append 之前同步落 running body 前像')
    assert.equal(op.status, 'running')
    assert.equal(op.inputPending, true, '输入未到达前必须留 inputPending 占位')
    assert.equal(op.userText, '', '占位时 userText 必须为空（避免后续同轮 ID 冲突）')
    assert.equal(op.businessBefore?.version, 1, '前像必须是完整业务基准')
    assert.equal(op.businessBefore?.messageCount, before.messages.length, '前像 messageCount 必须等于发轮前正文行数')
    assert.deepEqual(op.businessBefore?.fields?.variables, { hp: 5 }, '前像变量必须是发轮前的值')
    assert.equal(started._storageRevision, revisionBefore + 1, '前像写入必须推进 revision')
    // ② user/message：补 nativeAnchor（input = 该事件自身 seq）与真实输入 text。
    session.append('user/message', { id: 'u6', role: 'user', content: [{ type: 'text', text: '第六条输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const userEvent = session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === 'u6')
    assert.ok(userEvent, '真实输入事件必须已在 Session log')
    const withInput = await f.read()
    const opWithInput = Object.values(withInput.timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === turn)
    assert.deepEqual(opWithInput.nativeAnchor, { turn, input: userEvent.seq, reply: null }, 'nativeAnchor.input 必须等于输入事件自身 seq')
    assert.equal(opWithInput.userText, '第六条输入', '真实输入 text 必须补入占位操作')
    assert.equal(opWithInput.inputPending, undefined, '输入到达后必须去掉 inputPending')
    // ③ 真实 body.begin（施缝后的 story-timeline 模组）：输入已由 capture 补过 ⇒ normal same 文本复用；
    //    intent 不带锚点时必须保持 capture 已写锚点，businessBefore 一律不动，同轮不同输入仍 IDEMPOTENCY_CONFLICT。
    const timeline = await seamedTimeline(f.root)
    const baselineBefore = structuredClone(opWithInput.businessBefore)
    const chatForBegin = structuredClone(withInput)
    const begun = timeline.apply({ chat: chatForBegin, intent: { kind: 'body.begin', turn, userText: '第六条输入' } })
    assert.equal(begun.value?.operationId, op.id, 'body.begin 必须返回被复用的同一 operation（apply 返回 {chat,value}）')
    const reuseOp = Object.values(begun.chat.timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === turn)
    assert.equal(reuseOp.id, op.id, '同轮同文本必须复用同一 operation id')
    assert.deepEqual(reuseOp.businessBefore, baselineBefore, 'body.begin 不得覆盖原 businessBefore')
    assert.deepEqual(reuseOp.nativeAnchor, { turn, input: userEvent.seq, reply: null }, 'intent 无锚点时必须保持 capture 已写锚点')
    assert.throws(() => timeline.apply({ chat: structuredClone(withInput), intent: { kind: 'body.begin', turn, userText: '另一个输入' } }),
      error => error?.code === 'IDEMPOTENCY_CONFLICT', '同轮不同输入必须保持 IDEMPOTENCY_CONFLICT（不得新建覆盖）')
    // 本叶测试占位，不允许用未结束6轮直接开启7轮的旧夹具绕过发送顺序。
    const finish = async previous => {
      await f.store.update(f.chatId, current => {
        const next = structuredClone(current)
        Object.values(next.timeline.operations).find(op => op.turn === previous).status = 'completed'
        next._storageRevision = current._storageRevision + 1
        return next
      })
      session.append('turn/end', { turn: previous, reason: { kind: 'completed' } })
    }
    await finish(6)
    // ④ 占位路径：新开一轮（turn 7）后**原生 player 输入尚未到达**就 body.begin ⇒ 真实复用占位。
    session.append('turn/start', { turn: 7 })
    const placeholder = Object.values((await f.read()).timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === 7)
    assert.ok(placeholder, 'turn/start 必须为新轮落占位前像')
    assert.equal(placeholder.inputPending, true, '原生输入未到前必须保持 inputPending')
    const baseline7 = structuredClone(placeholder.businessBefore)
    const chat7 = structuredClone(await f.read())
    const begun7 = timeline.apply({ chat: chat7, intent: { kind: 'body.begin', turn: 7, userText: '第七条输入', nativeAnchor: { turn: 7, input: 777, reply: null } } })
    const op7 = Object.values(begun7.chat.timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === 7)
    assert.equal(op7.id, placeholder.id, '占位路径必须复用同一 operation id')
    assert.equal(op7.userText, '第七条输入', '占位路径必须补真实输入')
    assert.equal(op7.inputPending, undefined, '补完输入后必须删除 inputPending')
    assert.deepEqual(op7.nativeAnchor, { turn: 7, input: 777, reply: null }, 'intent 带锚点时必须落锚点')
    assert.deepEqual(op7.businessBefore, baseline7, '占位路径 businessBefore 永不改')
    // 占位已被 body.begin 补完并落库后，原生 user/message 到达不得再改写（capture 只在 inputPending 占位时补）。
    await f.store.update(f.chatId, current => {
      const next = structuredClone(begun7.chat)
      next._storageRevision = current._storageRevision + 1
      return next
    })
    // store captureSend user 分支两条语义：
    //   Y：已有 anchor（此处 intent 落的 777）⇒ 晚到原生输入**不得覆盖**，userText/businessBefore 也不得改。
    session.append('user/message', { id: 'u7', role: 'user', content: [{ type: 'text', text: '第七条输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const op7After = await f.bodyOpFor(7)
    assert.deepEqual(op7After.nativeAnchor, { turn: 7, input: 777, reply: null }, '已有 anchor 不得被晚到原生输入覆盖')
    assert.equal(op7After.userText, '第七条输入', '晚到输入不得覆盖已投影的 userText')
    assert.deepEqual(op7After.businessBefore, baseline7, '晚到输入不得改 businessBefore')
    session.append('user/message', { id: 'u7b', role: 'user', content: [{ type: 'text', text: '第七条输入（重复）' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    assert.deepEqual((await f.bodyOpFor(7)).nativeAnchor, { turn: 7, input: 777, reply: null }, '重复原生输入仍不得覆盖已有 anchor')
    //   X：prepare 删了 inputPending 但**没有** anchor（intent 未给）⇒ 晚到原生输入必须补真实 seq（主修的真实缺口）。
    await finish(7)
    session.append('turn/start', { turn: 8 })
    const placeholder8 = Object.values((await f.read()).timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === 8)
    assert.equal(placeholder8.inputPending, true, '新轮必须先落占位')
    const begun8 = timeline.apply({ chat: structuredClone(await f.read()), intent: { kind: 'body.begin', turn: 8, userText: '第八条输入' } })
    const op8 = Object.values(begun8.chat.timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === 8)
    assert.equal(op8.userText, '第八条输入')
    assert.equal(op8.nativeAnchor, undefined, 'intent 未给锚点 ⇒ prepare 之后仍无 anchor')
    assert.equal(op8.inputPending, undefined, 'prepare 复用占位后必须已删 inputPending')
    await f.store.update(f.chatId, current => {
      const next = structuredClone(begun8.chat)
      next._storageRevision = current._storageRevision + 1
      return next
    })
    session.append('user/message', { id: 'u8', role: 'user', content: [{ type: 'text', text: '第八条输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const userEvent8 = session.snapshotEvents().find(event => event.type === 'user/message' && event.data?.id === 'u8')
    const op8After = await f.bodyOpFor(8)
    assert.deepEqual(op8After.nativeAnchor, { turn: 8, input: userEvent8.seq, reply: null }, 'inputPending 已删且无 anchor 时晚到原生输入必须补真实 seq')
    assert.equal(op8After.userText, '第八条输入', '补锚点不得覆盖已投影 userText')
  } finally { await f.cleanup() }
})

test('发送接受跨轮前像：A停止后B的前像保存A状态，A基准保持前A', async () => {
  const f = await fixture()
  try {
    const session = f.Session.create(f.sessionId)
    session.append('session/end-seed', {})
    // A 轮（turn 6）：前像保存"前 A"（hp5、1+1 行正文）。
    session.append('turn/start', { turn: 6 })
    session.append('user/message', { id: 'uA', role: 'user', content: [{ type: 'text', text: 'A输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const opA = await f.bodyOpFor(6)
    const beforeA = structuredClone(opA.businessBefore)
    // A 被停止并产出正文/变量（异步 update 模拟作者提交）。
    await f.store.update(f.chatId, current => {
      const next = structuredClone(current)
      next.messages = [...next.messages, { role: 'assistant', turn: 6, text: 'A正文', swipeId: 0, swipes: ['A正文'], variables: [{ hp: 6 }] }]
      next.variables = { hp: 6 }
      next.timeline.revision = 6
      const op = Object.values(next.timeline.operations).find(item => item?.kind === 'body' && Number(item.turn) === 6)
      op.status = 'completed'
      next._storageRevision = current._storageRevision + 1
      return next
    })
    // A 成功结束后接受 B；未知/错误轮则必须先物理清理，不能仅改 body 状态。
    session.append('turn/end', { turn: 6, reason: { kind: 'completed' } })
    // B 轮（turn 7）：前像必须保存 A 之后的当前状态（而不是前 A）。
    session.append('turn/start', { turn: 7 })
    session.append('user/message', { id: 'uB', role: 'user', content: [{ type: 'text', text: 'B输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const opB = await f.bodyOpFor(7)
    assert.equal(opB.businessBefore.version, 1)
    assert.equal(opB.businessBefore.messageCount, 3, 'B 前像必须含 A 的正文行（前 B 状态）')
    assert.deepEqual(opB.businessBefore.fields.variables, { hp: 6 }, 'B 前像变量必须是 A 之后的值')
    // A 的基准不得被 B 的 capture 覆盖：A 回退仍应回到"前 A"。
    assert.deepEqual((await f.bodyOpFor(6)).businessBefore, beforeA, 'A 的 businessBefore 必须保持前 A')
    assert.equal((await f.bodyOpFor(6)).businessBefore.messageCount, 2, '前 A 只有 2 行正文')
    assert.deepEqual((await f.bodyOpFor(6)).businessBefore.fields.variables, { hp: 5 }, '前 A 变量必须仍是 hp5')
    // 结构核对：B 前像 messageCount 严格大于 A 前像（B 回退到前 B＝保留 A，A 再回退到前 A）。
    assert.ok(opB.businessBefore.messageCount > (await f.bodyOpFor(6)).businessBefore.messageCount, 'B 前像必须晚于 A 前像')
  } finally { await f.cleanup() }
})

test('发送接受与异步update并发：旧updater必须CAS拒绝且前像不丢，非user输入不改anchor', async () => {
  const f = await fixture()
  try {
    const session = f.Session.create(f.sessionId)
    session.append('session/end-seed', {})
    const turn = 6
    // 挂起一个旧的异步 updater（读旧状态后停住），期间 Session 开新轮并同步落前像。
    let release
    const gate = new Promise(resolve => { release = resolve })
    let updaterRejected = null
    const pending = (async () => {
      try {
        await f.store.update(f.chatId, async current => {
          await gate
          const next = structuredClone(current)
          next.messages = [...next.messages, { role: 'assistant', turn: 5, text: '旧updater迟到正文' }]
          next._storageRevision = current._storageRevision + 1
          return next
        })
      } catch (error) { updaterRejected = String(error?.message || error) }
    })()
    await new Promise(resolve => setTimeout(resolve, 20))
    session.append('turn/start', { turn })
    session.append('user/message', { id: 'u6', role: 'user', content: [{ type: 'text', text: '第六条输入' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const capturedOp = await f.bodyOpFor(turn)
    assert.ok(capturedOp?.nativeAnchor && capturedOp.businessBefore, '新前像必须已同步落盘')
    const baseline = structuredClone(capturedOp.businessBefore)
    release()
    await pending
    // 旧 updater 必须被 CAS 拒绝（主补完 revision 连续性校验后），且不得覆盖新前像。
    assert.ok(updaterRejected, '旧 updater 必须被 CAS 拒绝（revision 非连续），实际未报错')
    const after = await f.read()
    assert.deepEqual((await f.bodyOpFor(turn)).businessBefore, baseline, '新前像不得被旧 updater 覆盖')
    assert.equal(after.messages.some(row => row.text === '旧updater迟到正文'), false, '旧 updater 不得写入迟到正文')
    // native-only 非 user 输入（插件上下文）不得改 anchor。
    session.append('user/message', { id: 'plugin6', role: 'user', content: [{ type: 'text', text: '插件上下文' }], source: { kind: 'plugin', plugin: 'dsh-tavern' } }, { surfaceOp: 'append' })
    const afterPlugin = await f.bodyOpFor(turn)
    assert.deepEqual(afterPlugin.nativeAnchor, capturedOp.nativeAnchor, '非 player 输入不得改写 nativeAnchor')
    assert.equal(afterPlugin.userText, capturedOp.userText, '非 player 输入不得改写 userText')
    // 已有 anchor 不得被后续原生输入覆盖（主新语义）。
    session.append('user/message', { id: 'u6b', role: 'user', content: [{ type: 'text', text: '第六条输入（重复）' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    assert.deepEqual((await f.bodyOpFor(turn)).nativeAnchor, capturedOp.nativeAnchor, '已有 anchor 不得被后续原生输入覆盖')
    assert.equal((await f.bodyOpFor(turn)).userText, capturedOp.userText, '已有 anchor 时 userText 也不得改写')
  } finally { await f.cleanup() }
})

test('原生接受拒绝：同步前像补偿不留下phantom发送', async () => {
  const f = await fixture()
  try {
    const session = f.Session.create(f.sessionId)
    session.append('session/end-seed', {})
    const turn = 53
    const before = await f.read()
    const seqBefore = session.seq
    const variablesBefore = structuredClone(before.variables)
    const messagesBefore = structuredClone(before.messages)
    // 真实原生拒绝：turn/start 带 replace surfaceOp 且 startSeq/endSeq 引用不存在的更早事件
    // （clean-session.js:311「must reference earlier events」/ :271-279 surface 资格）⇒ capture 已跑、append 在 publish 前抛。
    assert.throws(() => session.append('turn/start', { turn }, { surfaceOp: { op: 'replace', startSeq: 9999, endSeq: 9999 } }),
      /surface replace|earlier events|surface-eligible|surfaceOp/, '原生 Session 必须真的拒绝该 turn/start')
    assert.equal(session.seq, seqBefore, '原生 append 抛时必须未推进 seq（补偿前提）')
    const after = await f.read()
    assert.equal(Object.values(after.timeline.operations || {}).some(op => op?.kind === 'body' && Number(op.turn) === turn), false,
      '拒绝后不得留下 phantom body53（同步前像必须被补偿撤掉）')
    assert.deepEqual(after.variables, variablesBefore, '业务前态 variables 必须相等')
    assert.deepEqual(after.messages, messagesBefore, '业务前态 messages 必须相等')
    assert.ok(Number(after._storageRevision) >= Number(before._storageRevision), 'revision 只可推进不可倒拨')
    // 同一个 turn 再走合法 start：捕获必须正常（补偿不得留下阻碍）。
    session.append('turn/start', { turn })
    assert.equal(session.seq, seqBefore + 1, '合法 start 必须推进 seq')
    const op = await f.bodyOpFor(turn)
    assert.ok(op?.businessBefore, '合法 start 必须正常落前像')
    assert.equal(op.status, 'running')
  } finally { await f.cleanup() }
})
