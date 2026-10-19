// 42 失败正文物理尾识别（匿名同形夹具，禁止现场值）：
//   · native：41 成功前缀（user41 + assistant41 + foreground-frame41 在 assistant 之后/之前皆可，均被 context 过滤）
//     ＋ 42 = turn/start + snapshot(user/message form:'snapshot') + foreground-frame 空 replacement
//     （source:{kind:'plugin',plugin:'dsh-tavern',form:'foreground-frame'}，surfaceOp {op:'replace',startSeq:frame41.seq,endSeq:frame41.seq}
//      + sourceEventSeqs:[frame41.seq]）＋ turn/end(reason.kind:'aborted')；**无 42 的正文 user/assistant**。
//   · 真作者 rollbackAvailability（原路径 import，不 stub）在本形态必须 {canRollback:true, failedTurns:[]} —— 表面判据不可用。
//   · Session 走真 author rc2 原文 + production:85 锚点替换（仅允许 assistant replace 携带来源引用）并 add KNOWN marker；不做 fromRestore 预置。
//   · 目标坐标来自 liveTarget()（含 revision），不接受 timeline.rev 漂移造 target。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { SqliteSessionDb } from '../store.js'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { cleanRollback } from '../lib/clean-rollback.js'
import { installRollbackSync } from '../lib/rollback-sync.js'
import { configureRollbackCleanup } from '../lib/rollback-cleanup.js'
import { rewindRollbackHandles } from '../lib/rollback-handles.js'
import { rollbackSchedulingBarrier } from '../lib/rollback-barrier.js'

configureRollbackCleanup({ sessionEvents: s => s.snapshotEvents() })
const requireHost = createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app', 'package.json'))
// 真作者 surface 判定（原路径 import，不 stub；与 sequential-failure-cleanup.test.mjs:33 同款）。
const { rollbackAvailability } = await import(new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/rollback-surface.js', import.meta.url).href)
assert.equal(typeof rollbackAvailability, 'function', '作者 rollbackAvailability 必须可 import（原路径）')
const helpers = { copyJsonTree: value => value === undefined ? undefined : structuredClone(value), applyJsonChangesShared: value => value }
for (const key of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[key] = value => value
helpers.diffJson = (old, next) => {
  const changes = []
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) if (key !== 'messages' && JSON.stringify(old[key]) !== JSON.stringify(next[key])) changes.push({ op: 'set', path: [key], value: next[key] })
  if (next.messages.length < old.messages.length) changes.push({ op: 'splice', path: ['messages'], index: next.messages.length, deleteCount: old.messages.length - next.messages.length, items: [] })
  else for (let i = 0; i < next.messages.length; i++) if (JSON.stringify(old.messages[i]) !== JSON.stringify(next.messages[i])) changes.push({ op: 'set', path: ['messages', i], value: next.messages[i] })
  return changes
}
const CHAT_ID = 'fixture-failed-body-tail'
const PREFIX_TURN = 41
const TARGET_TURN = 42
const NAME_POSITIVE = '失败正文物理尾识别：跨轮替换来源不妨碍清42并保留41纯前缀'
const NAME_NEGATIVE = '退役迁移：终态缺前像旧版本不阻止删42，旧42请求不连删后继43'
const FOREGROUND_MARKER = 'dsh-tavern/required-session-patch-v1'
// 57 行正文形状：首 1 条 greeting assistant + **27 对普通 user/assistant** + 末 41 对 2 行 = 57 总（41 对含在末两行，不再另加）。
// 关键证据：作者 `hasRollbackMessages`（rollback-surface.js:466-473）要求「最新非 greeting assistant 的前一条必须是 user」；
// sequential 的 rows57 以 assistant 收尾两行（…assistant28, assistant41）⇒ 该断言 false ⇒ canRollback=false（gate1 实证）。
function rows57 () {
  const rows = [{ role: 'assistant', greeting: true, turn: 0, text: '开场', swipeId: 0, swipes: ['开场'] }]
  for (let n = 1; n <= 27; n++) {
    rows.push({ role: 'user', turn: n, text: '输入' + n })
    rows.push({ role: 'assistant', turn: n, text: '正文' + n, swipeId: 0, swipes: ['正文' + n] })
  }
  rows.push({ role: 'user', turn: 41, text: '输入41' })
  rows.push({ role: 'assistant', turn: 41, text: '尾轮正文', swipeId: 0, swipes: ['尾轮正文'] })
  return rows
}
// context 事件：data 不带 turn（与 actual 形状一致），surfaceOp 用 append。
const contextRow = (id, form, extra = {}) => ['user/message', { id, role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern', form, ...extra } }, { surfaceOp: 'append' }]

/** 真 author rc2 原文 + production:85 锚点替换 + KNOWN marker（不做 fromRestore 预置）。 */
async function loadPatchedSession (root) {
  const raw = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
    .replace(/from "(@deepseek-ai\/[^\"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
  const anchor = 'if (event.type === "assistant/message" && raw !== void 0) throw'
  assert.equal(raw.split(anchor).length, 2, 'production:85 锚点必须唯一')
  const patched = raw.replace(anchor, 'if (event.type === "assistant/message" && raw !== void 0 && !(event.surfaceOp?.op === \'replace\')) throw')
  const file = path.join(root, 'session.mjs'); writeFileSync(file, patched, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  assert.equal(mod.KNOWN_SESSION_EVENT_TYPES instanceof Set, true, 'patched rc2 必须导出 KNOWN_SESSION_EVENT_TYPES（Set）')
  mod.KNOWN_SESSION_EVENT_TYPES.add(FOREGROUND_MARKER)
  return mod
}

/** options: { ending42:'aborted'|'completed'|'running', missingEnd42:boolean, push43:boolean, noBaseline:boolean, targetRevisionDelta:number } */
async function fixture (options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-failed-body-tail-'))
  const { Session, KNOWN_SESSION_EVENT_TYPES } = await loadPatchedSession(root)
  assert.equal(typeof Session?.create, 'function', 'patched rc2 Session 必须可用')
  const { SessionProjectionRegistry } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
  const { Context } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href), { z } = await import(pathToFileURL(requireHost.resolve('zod')).href)
  const ctx = new Context(), projections = new SessionProjectionRegistry(ctx)
  projections.register({ key: 'turnBoundary', stateVersion: 1, stateSchema: z.object({ lastTurn: z.number() }), init: () => ({ lastTurn: 0 }), apply: (state, e) => e.type === 'turn/end' ? { lastTurn: e.data.turn } : state })
  const session = Session.create('fixture-failed-body-tail')
  const appendUser = (n, text, op = 'append') => session.append('user/message', { id: 'u' + n, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: op })
  const appendAssistant = (n, text, op = 'append', extra = {}) => session.append('assistant/message', { turn: n, step: 1, message: { id: 'a' + n, role: 'assistant', content: text === '' ? [] : [{ type: 'text', text }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, stream: [] }, { surfaceOp: op, ...extra })
  const appendContext = (...args) => session.append(...contextRow(...args))
  // 41：成功前缀（frame41 放 assistant 之后；context 过滤后不影响尾判定）
  session.append('turn/start', { turn: PREFIX_TURN })
  appendUser(PREFIX_TURN, '轮41')
  appendAssistant(PREFIX_TURN, '轮41')
  const frame41 = appendContext('ctx41-frame', 'foreground-frame')
  session.append('turn/end', { turn: PREFIX_TURN, reason: { kind: 'completed' } })
  const prefixSeq = session.seq
  // 42：turn/start + snapshot + foreground-frame 空 replacement(refs→frame41) + turn/end；无正文
  session.append('turn/start', { turn: TARGET_TURN })
  const snapshot42 = appendContext('ctx42-snapshot', 'snapshot')
  const empty42 = session.append('user/message',
    { id: 'ctx42-frame', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'foreground-frame' } },
    { surfaceOp: { op: 'replace', startSeq: frame41.seq, endSeq: frame41.seq }, sourceEventSeqs: [frame41.seq] })
  if (!options.missingEnd42) {
    const ending = options.ending42 === 'completed' ? 'completed' : options.ending42 === 'running' ? 'running' : 'aborted'
    session.append('turn/end', { turn: TARGET_TURN, reason: { kind: ending } })
  }
  if (options.push43) {
    session.append('turn/start', { turn: 43 })
    appendContext('ctx43-snapshot', 'snapshot')
    session.append('turn/end', { turn: 43, reason: { kind: 'error', error: { message: 'guard' } } })
  }
  const mainDb = new SqliteSessionDb(path.join(root, 'session.db'))
  mainDb.materialize(session.header, session.inheritedEventCount, session.snapshotEvents())
  const store = createChatSqliteStore({ dataRoot: root, helpers })
  const messages = rows57()
  assert.equal(messages.length, 57, '正文必须恰好 57 行（首 greeting + 27 对普通 + 末 41 对 2 行）')
  assert.equal(messages.at(-1).role, 'assistant', '末行必须是 assistant')
  assert.equal(messages.at(-1).turn, PREFIX_TURN, '末 assistant 必须是 turn41')
  assert.equal(messages.at(-2).role, 'user', '末 assistant 前一条必须是 user（作者 hasRollbackMessages 前提）')
  const base = { id: CHAT_ID, sessionId: session.id, _storageRevision: 7, mode: 'story', messages, variables: { hp: PREFIX_TURN }, lastWorldBookRecall: { turn: PREFIX_TURN }, contextCompaction: { warning: '轮41' }, hiddenDshErrorTurns: [], timeline: { schemaVersion: 1, branchId: 'branch-failed-body-tail', revision: PREFIX_TURN, checkpoints: [], operations: {}, participants: {} } }
  await store.update(base.id, () => base)
  const baseline42 = { version: 1, fields: { variables: { hp: PREFIX_TURN }, lastWorldBookRecall: { turn: PREFIX_TURN }, contextCompaction: { warning: '轮41' }, presentationWarnings: [], hiddenDshErrorTurns: [], rollbackSessionCuts: {}, taskMailbox: {} }, messageCount: messages.length, participants: {}, operationIds: [], operationStates: {} }
  const op42 = { id: 'op42', kind: 'body', turn: TARGET_TURN, status: 'failed', basedOn: { branchId: base.timeline.branchId, revision: PREFIX_TURN }, beforeParticipants: {}, ...(options.noBaseline ? {} : { businessBefore: baseline42 }) }
  const current = { ...base, _storageRevision: 8, timeline: { ...base.timeline, revision: TARGET_TURN, operations: { op42 } } }
  await store.update(base.id, () => current)
  const agents = new Map([[session.id, { session, phase: { kind: 'idle', lastTurn: TARGET_TURN }, runtimeContext: { retained: { text: '轮42' } } }]])
  for (const agent of agents.values()) agent.inbox = { nextTurn: [], nextStep: [] }
  const handles = new Set([...agents].map(([id, a]) => ({ id, access: 'write', state: { cursor: a.session.seq, primed: { text: '轮42' } }, observedLength: a.session.seq })))
  const dbs = new Map([[session.id, mainDb]])
  const persistence = { bindRollbackArchive: async (id, f) => dbs.get(id).bindRollbackArchive(f), setRollbackPending: async (id, value) => dbs.get(id).setRollbackPending(value), drainOpenHandles: async () => {}, truncateEvents: async (header, boundary) => { const db = dbs.get(header.id), meta = db.truncateFrom(boundary); rewindRollbackHandles(handles, header.id, meta.eventCount); return meta } }
  const synced = []; let rollbackSync
  installRollbackSync({ get: () => ({ controlState: { ctx: { sessionProjections: projections }, jobsFor: () => [], broadcast: frame => synced.push(frame) }, history: { assistantStreams: new Map() } }), provide: (_key, value) => { rollbackSync = value } })
  const meter = { states: new WeakMap() }, services = { projections, projectionCache: { write: async () => {} }, tokenMeterProvider: () => meter, rollbackSyncProvider: () => rollbackSync }
  const read = () => store.read(base.id), update = (_id, fn, metadata) => store.update(base.id, async now => { const next = await fn(now); next._storageRevision = now._storageRevision + 1; return next }, metadata)
  const liveTarget = async () => { const live = await read(); return { turn: TARGET_TURN, branchId: live.timeline.branchId, revision: live._storageRevision + (options.targetRevisionDelta ?? 0), operationId: 'op42', chatId: live.id, sessionId: live.sessionId } }
  const availability = (chat, input) => rollbackAvailability(chat, input)
  const args = { chat: undefined, requestedTurn: TARGET_TURN, availability, readChat: read, updateChat: update, chats: { rollbackArchivePath: store.rollbackArchivePath, readRollbackWorldbook: store.readRollbackWorldbook, readSlice: store.readSlice, update }, sessions: { get: id => agents.get(id), getSession: id => agents.get(id)?.session, flush: async () => {} }, persistence, services, quiesce: async () => {}, sideCleanup: async () => {}, view: async chat => ({ turn: chat.messages.at(-1).turn, variables: chat.variables }), readCard: async () => ({}) }
  const item = {
    root, base, current, session, store, agents, args, read, mainDb, synced, handles, projections, availability, liveTarget, prefixSeq, frame41, snapshot42, empty42,
    listEvents: () => mainDb.readAll().events,
    eventCount: () => mainDb.readAll().events.length,
    prefixEvents: () => mainDb.readAll().events.slice(0, prefixSeq),
    availabilityOf: () => rollbackAvailability({ ...current }, { events: session.snapshotEvents(), nodes: session.surface.nodes }),
    cleanup: async () => { for (const id of agents.keys()) rollbackSchedulingBarrier.delete(id); store.dispose(); mainDb.close(); await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) },
  }
  item.args.chat = await read()
  return item
}

test(NAME_POSITIVE, async t => {
  const f = await fixture({})
  t.after(async () => { await f.cleanup() })
  const before = await f.read()
  const prefixBefore = f.prefixEvents()
  const messagesBefore = structuredClone(before.messages), variablesBefore = structuredClone(before.variables)
  // 前置：真作者 availability 在本形态 failedTurns 为空（表面判据不可用），且原生 42 段在场
  const availability = f.availabilityOf()
  assert.equal(availability.canRollback, true, '真作者 availability 必须 canRollback=true')
  assert.deepEqual(availability.failedTurns, [], '真作者 availability 在本形态必须 failedTurns=[]')
  assert.equal(f.listEvents().some(e => e.data?.turn === TARGET_TURN), true, '原生 42 段必须在场')
  const target = await f.liveTarget()
  const result = await cleanRollback({ ...f.args, requestedTurn: target })
  // 回执：cleanedFailureTarget.turn=42 且 sync 协议为 1
  assert.equal(result?.rolledBack?.cleanedFailureTarget?.turn, TARGET_TURN, '回执必须确认清理目标 42')
  assert.equal(result?.rolledBack?.sync?.protocol, 1, '回执必须带同连接同步协议 1')
  // 原生纯尾：事件数回到 prefixSeq，且前缀逐字深等价
  assert.equal(f.eventCount(), f.prefixSeq, '原生事件必须回到 41 尾（prefixSeq）')
  assert.deepStrictEqual(f.prefixEvents(), prefixBefore, '41 纯前缀事件必须逐字保留')
  // 业务：op42 消失、pending 归零、正文/变量与基准一致、计数相位回 41
  const after = await f.read()
  assert.equal(after.timeline.operations.op42, undefined, '业务 op42 必须被清')
  assert.equal(after.rollbackPending ?? 0, 0, 'pending 必须归零')
  assert.deepStrictEqual(after.messages, messagesBefore, '正文必须与清理前逐字相同（42 未 append 正文）')
  assert.deepStrictEqual(after.variables, variablesBefore, '变量必须回到基准值')
  // 相位：真 agent 相位（不看 timeline cp 兜底，避免常数假证）
  assert.equal(f.agents.get(f.session.id).phase.lastTurn, PREFIX_TURN, '真 agent phase.lastTurn 必须回到 41')
  // 投影水位：接口已核——snapshot() 的 values 只含**被选中**的 client-visible unit（未选中可为空对象，L140/L150），
  // 而 stateOf(session,key)（L127）是按键读 cell 的权威口；故 asOfSeq 用 snapshot、turnBoundary 用 stateOf，不猜结构。
  const postProjection = f.projections.snapshot(f.session)
  assert.equal(postProjection.asOfSeq, f.prefixSeq - 1, '投影水位 asOfSeq 必须回到 prefixSeq-1')
  assert.equal(f.projections.stateOf(f.session, 'turnBoundary').lastTurn, PREFIX_TURN, '投影 turnBoundary.lastTurn 必须回到 41')
  // 句柄/同步：primed 产品侧设 undefined（非 null）；同步帧恰 1 帧
  const handle = [...f.handles][0]
  assert.equal(handle.state.cursor, f.prefixSeq, '句柄 cursor 必须回卷到 prefixSeq')
  assert.equal(handle.state.primed, undefined, 'primed 必须为 undefined（产品 rewindRollbackHandles 语义）')
  assert.equal(handle.observedLength, f.prefixSeq, 'observedLength 必须回卷到 prefixSeq')
  assert.equal(f.synced.length, 1, '必须恰好广播 1 帧同连接同步')
  assert.equal(f.synced[0]?.value?.hiddenTurn, TARGET_TURN, '同步帧必须指向被清轮 42')
  assert.equal(f.synced[0]?.value?.revision, after._storageRevision, '同步帧 revision 必须等于最终 SQL 版本')
})

test(NAME_NEGATIVE, async () => {
 const allowed=[
  ['completed',{ending42:'completed'}],['无end',{missingEnd42:true}],
  ['running',{ending42:'running'}],['缺前像',{noBaseline:true}],['旧版本',{targetRevisionDelta:1}],
 ]
 for(const [label,options] of allowed){
  const f=await fixture(options)
  try{
   const prefix=f.prefixEvents(),before=await f.read()
   await cleanRollback({...f.args,requestedTurn:await f.liveTarget()})
   assert.deepEqual(f.listEvents(),prefix,label+'：只删42原生尾')
   const after=await f.read()
   assert.deepEqual(after.messages,before.messages,label+'：41正文不变')
   assert.deepEqual(after.variables,before.variables,label+'：已有41值保留')
   assert.equal(after.timeline.operations.op42,undefined)
   assert.equal(f.synced.length,1)
  }finally{await f.cleanup()}
 }
 const f=await fixture({push43:true})
 try{
  const before=await f.read(),events=f.listEvents()
  const result=await cleanRollback({...f.args,requestedTurn:await f.liveTarget()})
  assert.equal(result.changed,false);assert.equal(result.rolledBack.alreadyClean,true)
  assert.deepEqual(await f.read(),before);assert.deepEqual(f.listEvents(),events)
  assert.equal(f.synced.length,0,'旧42请求不得清43或广播假完成')
 }finally{await f.cleanup()}
})
