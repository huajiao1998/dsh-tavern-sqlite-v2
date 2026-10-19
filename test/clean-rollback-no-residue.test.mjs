// 纯尾清理与普通回退（generic 6 case，匿名轮，不硬编现场）：基准只在**发轮前** capture 一次；只 append 一处 target 轮。
// 真依赖：宿主 Session（projection-baseline-1001 夹具真身 + 本机宿主解析）、真 SqliteSessionDb、真 chat sqlite store、
//   真 SessionProjectionRegistry(turnBoundary)、真 captureRollbackBusinessState、真作者 rollbackAvailability、
//   真 rollbackBoundarySeq/rewindRollbackHandles、真 recall sideCleanup（**有限 scope**：只演 recall store，不冒称全部副库）、真 rollbackBarrier。
import test from 'node:test'
import assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import os from 'node:os'
import {SqliteSessionDb} from '../store.js'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
import {cleanRollback} from '../lib/clean-rollback.js'
import {captureRollbackBusinessState} from '../lib/rollback-business-state.js'
import {installRollbackSync} from '../lib/rollback-sync.js'
import {configureRollbackCleanup, rollbackBoundarySeq, preflightRollback, preflightRollbackAtSeq} from '../lib/rollback-cleanup.js'
import {rewindRollbackHandles} from '../lib/rollback-handles.js'
import {rollbackBarrier} from '../lib/rollback-barrier.js'
import {createRollbackWorldbookRecallLog} from '../lib/worldbook-recall-store.js'

configureRollbackCleanup({sessionEvents: session => session.snapshotEvents()})
const requireHost = createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app', 'package.json'))
const AUTHOR = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
const {rollbackAvailability} = await import(new URL('lib/domain/rollback-surface.js', AUTHOR).href) // 真作者判定（不 stub）
const {diffJson, applyJsonChangesShared} = await import(new URL('lib/domain/json-mutation.js', AUTHOR).href)
const treeModule = await import(new URL('lib/domain/copy-json-tree.js', AUTHOR).href)
const helpers = {copyJsonTree: treeModule.copyJsonTree ?? treeModule.default, diffJson, applyJsonChangesShared,
  projectSceneImageState: v => v, projectChatSessionState: v => v, projectDisplayRuntimeState: v => v, projectChatBackgroundConfig: v => v, projectSettlementCheckpoint: v => v}
const TURNS = [3, 19, 58] // 匿名不同轮；每 case 独立 DB/session
const MARKER = 'dsh-tavern/required-session-patch-v1'

async function scenario(targetTurn, mode) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-no-residue-'))
  const raw = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
    .replace(/from "(@deepseek-ai\/[^"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
  const sessionFile = path.join(root, 'session.mjs')
  writeFileSync(sessionFile, raw, 'utf8')
  const {Session, KNOWN_SESSION_EVENT_TYPES} = await import(pathToFileURL(sessionFile).href)
  const {SessionProjectionRegistry} = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
  const {Context} = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href)
  const {z} = await import(pathToFileURL(requireHost.resolve('zod')).href)
  const ctx = new Context()
  const projections = new SessionProjectionRegistry(ctx)
  projections.register({key: 'turnBoundary', stateVersion: 1, stateSchema: z.object({lastTurn: z.number()}), init: () => ({lastTurn: 0}), apply: (state, event) => event.type === 'turn/end' ? {lastTurn: event.data.turn} : state})
  const session = Session.create('synthetic-no-residue-' + targetTurn + '-' + mode)
  const sessionId = session.header?.id ?? session.id
  assert.ok(sessionId, 'header.id 必须存在（身份以 header 为准）')
  KNOWN_SESSION_EVENT_TYPES.add(MARKER) // 生产 marker registry：与 clean-rollback 预检同一词汇表
  session.append(MARKER, {version: 1}) // 生产形状的事件数据（只加版本），由真 Session 接受
  const markerEvent = session.snapshotEvents().find(event => event.type === MARKER)
  assert.ok(markerEvent && isDeepStrictEqual(markerEvent.data, {version: 1}), '生产 marker 事件必须被真 Session 接受且形状一致（不得吞失败造假）')
  const priorTurn = targetTurn - 1
  session.append('turn/start', {turn: priorTurn})
  session.append('user/message', {id: 'u' + priorTurn, role: 'user', content: [{type: 'text', text: 'in' + priorTurn}], source: {kind: 'user'}}, {surfaceOp: 'append'})
  session.append('assistant/message', {turn: priorTurn, step: 1, message: {id: 'a' + priorTurn, role: 'assistant', content: [{type: 'text', text: 'out' + priorTurn}], source: {kind: 'model', provider: 'fixture', model: 'fixture'}}, stream: []}, {surfaceOp: 'append'})
  session.append('turn/end', {turn: priorTurn, reason: {kind: 'completed'}})
  const db = new SqliteSessionDb(path.join(root, 'session.db'))
  db.materialize(session.header, session.inheritedEventCount, session.snapshotEvents())
  const store = createChatSqliteStore({dataRoot: root, helpers})
  const beforeMessages = [{role: 'user', turn: priorTurn, text: 'in' + priorTurn}, {role: 'assistant', turn: priorTurn, text: 'out' + priorTurn, swipeId: 0, swipes: ['out' + priorTurn]}]
  const before = {id: 'synthetic-chat', sessionId, _storageRevision: 1, mode: 'story', messages: beforeMessages, variables: {hp: priorTurn},
    macroState: {userName: 'user-edit', local: {keep: true}}, cardPath: 'cards/user-chosen.json', runtimePresetPath: 'presets/user.json', runtimePresetSnapshot: {kept: true},
    runtimeInputs: {[priorTurn]: {seed: priorTurn}}, nativeCommits: {[priorTurn]: priorTurn}, foregroundFrames: [], suppressedDshTurns: [],
    timeline: {schemaVersion: 1, branchId: 'branch-' + targetTurn, revision: 1, checkpoints: [], operations: {}, participants: {}}}
  await store.update(before.id, () => before)
  const baseline = captureRollbackBusinessState(await store.read(before.id)) // 真 capture：目标尚未发轮
  assert.equal(baseline.version, 1)
  const baselineFieldKeys = Object.keys(baseline.fields).sort()
  const preTargetEvents = session.snapshotEvents().slice()
  const boundary = rollbackBoundarySeq(session, targetTurn) + 1
  // 只 append 这一处 target 轮
  session.append('turn/start', {turn: targetTurn})
  session.append('user/message', {id: 'u' + targetTurn, role: 'user', content: [{type: 'text', text: 'in' + targetTurn}], source: {kind: 'user'}}, {surfaceOp: 'append'})
  if (mode !== 'failed') session.append('assistant/message', {turn: targetTurn, step: 1, message: {id: 'a' + targetTurn, role: 'assistant', content: [{type: 'text', text: 'out' + targetTurn}], source: {kind: 'model', provider: 'fixture', model: 'fixture'}}, stream: []}, {surfaceOp: 'append'})
  session.append('turn/end', {turn: targetTurn, reason: {kind: mode === 'failed' ? 'error' : 'completed'}})
  db.appendBatch(session.snapshotEvents().slice(preTargetEvents.length), preTargetEvents.length) // 真 Session 无 offset 参数：显式 slice 尾部
  const targetRows = [{role: 'user', turn: targetTurn, text: 'in' + targetTurn}, ...(mode === 'failed' ? [] : [{role: 'assistant', turn: targetTurn, text: 'out' + targetTurn, swipeId: 0, swipes: ['out' + targetTurn]}])]
  const current = {...before, _storageRevision: 2, messages: [...beforeMessages, ...targetRows], variables: {hp: targetTurn},
    runtimeInputs: {...before.runtimeInputs, [targetTurn]: {seed: targetTurn}}, nativeCommits: {...before.nativeCommits, [targetTurn]: targetTurn},
    timeline: {...before.timeline, revision: 2,
      operations: mode === 'failed' ? {body: {kind: 'body', turn: targetTurn, status: 'failed', businessBefore: baseline}} : {},
      checkpoints: mode === 'failed' ? [] : [{id: 'cp' + targetTurn, turn: targetTurn, businessBefore: baseline}]}}
  await store.update(before.id, () => current)
  const read = () => store.read(before.id)
  const update = (_id, fn, metadata) => store.update(before.id, async now => { const next = await fn(now); next._storageRevision = now._storageRevision + 1; return next }, metadata)
  const agent = {session, phase: {kind: 'idle', lastTurn: targetTurn}, runtimeContext: {}, inbox: {nextTurn: [], nextStep: []}}
  const handle = {id: sessionId, access: 'write', state: {cursor: session.seq, primed: {}}, observedLength: session.seq}
  const handles = new Set([handle])
  const counters = {bind: 0, pending: 0, truncate: 0, sideCleanup: 0, syncFrames: 0}
  const persistence = {
    bindRollbackArchive: async (id, file) => { counters.bind += 1; return db.bindRollbackArchive(file) },
    setRollbackPending: async (id, value) => { counters.pending += 1; return db.setRollbackPending(value) },
    drainOpenHandles: async () => {},
    truncateEvents: async (header, boundarySeq) => { counters.truncate += 1; const meta = db.truncateFrom(boundarySeq); rewindRollbackHandles(handles, header.id, meta.eventCount); return meta },
  }
  let rollbackSync = null
  installRollbackSync({get: () => ({controlState: {ctx: {sessionProjections: projections}, jobsFor: () => [], broadcast: () => { counters.syncFrames += 1 }}, history: {assistantStreams: new Map()}}), provide: (_key, value) => { rollbackSync = value }})
  const recalls = createRollbackWorldbookRecallLog({dataRoot: root, store: {readJson: async () => undefined, remove: async () => {}}})
  const live = await read()
  const availability = rollbackAvailability(live, {events: session.snapshotEvents(), nodes: session.surface.nodes}) // 真作者判定（失败/普通同一真函数）
  const target = {turn: targetTurn, branchId: live.timeline.branchId, revision: live._storageRevision, operationId: 'body', chatId: live.id, sessionId: live.sessionId}
  let result = null, error = null
  try {
    result = await cleanRollback({
      chat: live, requestedTurn: mode === 'failed' ? target : targetTurn,
      availability: (value, extra) => rollbackAvailability(value, extra || {}),
      readChat: read, updateChat: update,
      chats: {rollbackArchivePath: store.rollbackArchivePath, readRollbackWorldbook: store.readRollbackWorldbook, readSlice: store.readSlice, update},
      sessions: {get: () => agent, getSession: () => session, flush: async () => {}},
      persistence, services: {projections, projectionCache: {write: async () => {}}, tokenMeterProvider: () => ({states: new WeakMap()}), rollbackSyncProvider: () => rollbackSync},
      quiesce: async () => {}, view: async value => ({turn: value.messages.at(-1)?.turn ?? null, variables: value.variables}), readCard: async () => ({}),
      sideCleanup: async (value, turn) => { counters.sideCleanup += 1; return recalls.pruneRollback(value, turn, value.timeline.branchId) },
      ...(mode === 'failed' ? {failureTarget: target} : {}),
    })
  } catch (caught) { error = caught }
  const after = await read()
  const afterEvents = db.readAll().events
  const afterFields = captureRollbackBusinessState(after).fields
  const checks = {
    noError: error === null,
    wholeFieldKeysEqualBaseline: isDeepStrictEqual(Object.keys(afterFields).sort(), baselineFieldKeys),
    wholeFieldsDeepEqualBaseline: isDeepStrictEqual(afterFields, baseline.fields),
    nativePurePrefixBeforeTarget: isDeepStrictEqual(afterEvents, preTargetEvents.slice(0, boundary)),
    nativeCountIsBoundary: afterEvents.length === boundary,
    noTurnAtOrAfterTarget: !afterEvents.some(event => Number(event?.data?.turn) >= targetTurn),
    noRefsAtOrAfterKeep: afterEvents.flatMap(event => Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []).filter(seq => Number(seq) >= boundary).length === 0,
    targetOperationGone: after.timeline?.operations?.body === undefined,
    checkpointsCleared: (after.timeline?.checkpoints || []).every(cp => Number(cp.turn) < targetTurn),
    messagesEqualBefore: isDeepStrictEqual(after.messages, beforeMessages),
    configPreserved: after.macroState?.userName === before.macroState.userName && after.cardPath === before.cardPath && after.runtimePresetPath === before.runtimePresetPath,
    pendingGone: after.rollbackPending === undefined,
    barrierClean: rollbackBarrier.size === 0,
    handleRewound: handle.state?.cursor === boundary && handle.state?.primed === undefined,
    memoryLogKeptPrefix: isDeepStrictEqual(session.snapshotEvents(), preTargetEvents.slice(0, boundary)),
    projectionAtKeep: (projections.stateOf(session, 'turnBoundary')?.lastTurn ?? null) === priorTurn,
  }
  const coldStore = createChatSqliteStore({dataRoot: root, helpers})
  const coldChat = await coldStore.read(before.id)
  const coldNative = new SqliteSessionDb(path.join(root, 'session.db'))
  const coldFields = captureRollbackBusinessState(coldChat).fields
  const cold = {
    wholeFieldsDeepEqualBaseline: isDeepStrictEqual(coldFields, baseline.fields),
    messagesEqual: isDeepStrictEqual(coldChat.messages, beforeMessages),
    eventCountEqual: (coldNative.readMeta()?.eventCount ?? null) === boundary,
    residueFree: coldChat.rollbackPending === undefined && coldChat.timeline?.operations?.body === undefined && !coldNative.readAll().events.some(event => Number(event?.data?.turn) >= targetTurn),
  }
  const cleanup = async () => { recalls.dispose(); store.dispose(); db.close(); coldNative.close(); coldStore.dispose(); await ctx.fiber.dispose(); rmSync(root, {recursive: true, force: true}) }
  return {targetTurn, mode, boundary, checks, cold, counters, markerAccepted: true, availabilityFailed: Array.isArray(availability.failedTurns) ? availability.failedTurns : null, resultTurn: result?.turn ?? null, error, cleanup}
}

test('纯尾清理与普通回退：任意轮恢复完整基准且冷开无被撤销运行痕迹', async () => {
  const seen = []
  for (const targetTurn of TURNS) {
    for (const mode of ['failed', 'completed']) {
      const scene = await scenario(targetTurn, mode)
      try {
        const failed = Object.entries(scene.checks).filter(([, value]) => value !== true).map(([key]) => key)
        seen.push({turn: targetTurn, mode, boundary: scene.boundary, failed, marker: scene.markerAccepted, availabilityFailed: scene.availabilityFailed, resultTurn: scene.resultTurn, counters: scene.counters, cold: scene.cold})
        assert.deepEqual(failed, [], `turn ${targetTurn}/${mode} 残留或未复原：` + failed.join(',') + (scene.error ? ' err=' + scene.error.message : ''))
        assert.equal(scene.cold.wholeFieldsDeepEqualBaseline, true, `turn ${targetTurn}/${mode} 冷开后须与发轮前基准整份 fields 等值`)
        assert.equal(scene.cold.messagesEqual, true, `turn ${targetTurn}/${mode} 冷开后正文须回到发轮前`)
        assert.equal(scene.cold.eventCountEqual, true, `turn ${targetTurn}/${mode} 冷开后原生 event_count 须等于边界`)
        assert.equal(scene.cold.residueFree, true, `turn ${targetTurn}/${mode} 冷开后不得有被撤销运行痕迹`)
      } finally { await scene.cleanup() }
    }
  }
  assert.equal(seen.length, TURNS.length * 2, '覆盖失败清理与普通回退两类输入，各轮匿名独立')
})

// 空轮压缩（turn 真实为 null）不得经 Number(null)=0 被冒认成“0 轮旧事件”而误判 MIDDLE_DELETE；真实旧轮与半轮仍必须拒。
test('纯尾预检：空轮压缩不冒认零轮且真实旧轮与半轮仍拒', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-nullturn-'))
  try {
    const raw = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
      .replace(/from "(@deepseek-ai\/[^"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
    const sessionFile = path.join(root, 'session.mjs')
    writeFileSync(sessionFile, raw, 'utf8')
    const {Session, KNOWN_SESSION_EVENT_TYPES} = await import(pathToFileURL(sessionFile).href) // 真 Session，不造 fake log
    KNOWN_SESSION_EVENT_TYPES.add(MARKER)
    const session = Session.create('null-turn-preflight')
    const priorTurn = 5, targetTurn = 6
    session.append(MARKER, {version: 1})
    session.append('turn/start', {turn: priorTurn})
    session.append('user/message', {id: 'u' + priorTurn, role: 'user', content: [{type: 'text', text: 'p'}], source: {kind: 'user'}}, {surfaceOp: 'append'})
    session.append('turn/end', {turn: priorTurn, reason: {kind: 'completed'}})
    session.append('session/end-seed', {}) // 代表旧 baseline 的 seed
    // 空洞压缩：turn 真实为 null
    session.append('compaction/start', {turn: null})
    session.append('compaction/summary', {turn: null})
    session.append('compaction/end', {turn: null})
    session.append('turn/start', {turn: targetTurn})
    session.append('user/message', {id: 'u' + targetTurn, role: 'user', content: [{type: 'text', text: 't'}], source: {kind: 'user'}}, {surfaceOp: 'append'})
    session.append('turn/end', {turn: targetTurn, reason: {kind: 'error'}})
    const codesOf = plan => (plan?.violations ?? []).map(item => item.code)
    const positive = preflightRollback(session, targetTurn, {strict: false}) // 纯诊断：不装四层服务，也不会因缺 service 反断言 missing
    assert.equal(codesOf(positive).filter(code => code === 'MIDDLE_DELETE').length, 0, '空轮压缩（turn null）不得被判成 0 轮旧事件 ⇒ 不得 MIDDLE_DELETE')
    assert.equal(positive.boundarySeq,session.snapshotEvents().find(event=>event.type==='turn/start'&&event.data?.turn===targetTurn).seq-1,'当前切点从目标真实start定位，不复用旧分类扫描')
    // 旧预检分类已退役；显式seq只定位，实际SQL/折叠承担真实错误。
    const boundary=session.snapshotEvents().find(event=>event.type==='turn/start'&&event.data?.turn===targetTurn).seq
    assert.equal(preflightRollbackAtSeq(session,boundary,{strict:true}).keep,boundary+1)
    assert.throws(()=>preflightRollbackAtSeq(session,session.seq,{strict:true}),/超出当前日志范围/)
  } finally { rmSync(root, {recursive: true, force: true}) }
})
