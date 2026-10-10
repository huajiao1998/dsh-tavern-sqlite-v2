// 标准目录（data/plugins）迁移后的**物理纯尾回退**单场景定向证据：本插件已按标准装配装进本用例自有 home，
// 存储/Session/回退实现**全部从标准程序安装副本导入**（不再从开发树 `../store.js` 之类导入），
// 业务 DB 仍由本用例自建 temp 库；真 Session 与 projection 注册来自现 clean-session 公共夹具 + 真实 ctx。
// **合成夹具，非现场**：不部署、不读真实存档、不起宿主进程；本叶只跑 targetTurn=7 / mode='failed' 这一场景。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { copyPackage } from '../deploy/maintenance/runner.mjs'
import { createStandardInstallation, installOwnedRows, pluginDirFor } from '../deploy/maintenance/standard-installation.mjs'

const product = fileURLToPath(new URL('../', import.meta.url))
const requireHost = createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app', 'package.json'))
const AUTHOR = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
const { rollbackAvailability } = await import(new URL('lib/domain/rollback-surface.js', AUTHOR).href) // 真作者判定（不 stub）
const { diffJson, applyJsonChangesShared } = await import(new URL('lib/domain/json-mutation.js', AUTHOR).href)
const treeModule = await import(new URL('lib/domain/copy-json-tree.js', AUTHOR).href)
const helpers = { copyJsonTree: treeModule.copyJsonTree ?? treeModule.default, diffJson, applyJsonChangesShared,
  projectSceneImageState: v => v, projectChatSessionState: v => v, projectDisplayRuntimeState: v => v, projectChatBackgroundConfig: v => v, projectSettlementCheckpoint: v => v }
const MARKER = 'dsh-tavern/required-session-patch-v1'
const PACKAGE_NAME = 'dsh-tavern-sqlite-v2'

/** 标准装配：本用例自有 home 下 data/plugins 现装态；模块一律从安装副本导入。 */
async function installStandardProgram(root) {
  const home = path.join(root, 'home'), profileDir = path.join(home, 'profiles', 'tavern')
  const evidence = path.join(home, 'maintenance', PACKAGE_NAME, 'rollback-1')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(evidence, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-tavern', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n', 'utf8')
  const pluginDir = pluginDirFor({ home, packageName: PACKAGE_NAME })
  const packageRoot = path.join(root, 'selected-package')
  copyPackage(product, packageRoot)
  const seeded = installOwnedRows('[]\n', { pluginDir, home })
  assert.equal(seeded.changed, true, '标准装配必须写出 early 行')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), seeded.text, 'utf8')
  const assembly = createStandardInstallation({ op: { home, profileDir }, adapter: { packageName: PACKAGE_NAME }, packageRoot, evidence, linkPeers: () => {} })
  await assembly.manage('install')
  assert.equal(existsSync(path.join(pluginDir, 'package.json')), true, '标准目录必须已装（业务实现从该副本导入）')
  const load = rel => import(pathToFileURL(path.join(pluginDir, rel)).href)
  const [storeMod, chatMod, cleanMod, businessMod, syncMod, cleanupMod, handlesMod, barrierMod, recallMod] = await Promise.all([
    load('store.js'), load('chat-sqlite-store.js'), load('lib/clean-rollback.js'), load('lib/rollback-business-state.js'),
    load('lib/rollback-sync.js'), load('lib/rollback-cleanup.js'), load('lib/rollback-handles.js'), load('lib/rollback-barrier.js'), load('lib/worldbook-recall-store.js'),
  ])
  return { home, profileDir, pluginDir, mods: { storeMod, chatMod, cleanMod, businessMod, syncMod, cleanupMod, handlesMod, barrierMod, recallMod } }
}

async function scenario(program, targetTurn = 7, mode = 'failed') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-standard-rollback-'))
  const { SqliteSessionDb } = program.mods.storeMod
  const { createChatSqliteStore } = program.mods.chatMod
  const { cleanRollback } = program.mods.cleanMod
  const { captureRollbackBusinessState } = program.mods.businessMod
  const { installRollbackSync } = program.mods.syncMod
  const { configureRollbackCleanup, rollbackBoundarySeq } = program.mods.cleanupMod
  const { rewindRollbackHandles } = program.mods.handlesMod
  const { rollbackBarrier } = program.mods.barrierMod
  const { createRollbackWorldbookRecallLog } = program.mods.recallMod
  configureRollbackCleanup({ sessionEvents: session => session.snapshotEvents() })
  const raw = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-session.js', import.meta.url), 'utf8')
    .replace(/from "(@deepseek-ai\/[^"]+)"/g, (_all, name) => 'from ' + JSON.stringify(pathToFileURL(requireHost.resolve(name)).href))
  const sessionFile = path.join(root, 'session.mjs')
  writeFileSync(sessionFile, raw, 'utf8')
  const { Session, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(sessionFile).href)
  const { SessionProjectionRegistry } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-session-projection')).href)
  const { Context } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href)
  const { z } = await import(pathToFileURL(requireHost.resolve('zod')).href)
  const ctx = new Context()
  const projections = new SessionProjectionRegistry(ctx)
  projections.register({ key: 'turnBoundary', stateVersion: 1, stateSchema: z.object({ lastTurn: z.number() }), init: () => ({ lastTurn: 0 }), apply: (state, event) => event.type === 'turn/end' ? { lastTurn: event.data.turn } : state })
  const session = Session.create('synthetic-standard-' + targetTurn + '-' + mode)
  const sessionId = session.header?.id ?? session.id
  assert.ok(sessionId, 'header.id 必须存在（身份以 header 为准）')
  KNOWN_SESSION_EVENT_TYPES.add(MARKER)
  session.append(MARKER, { version: 1 })
  const markerEvent = session.snapshotEvents().find(event => event.type === MARKER)
  assert.ok(markerEvent && isDeepStrictEqual(markerEvent.data, { version: 1 }), '生产 marker 事件必须被真 Session 接受且形状一致')
  const priorTurn = targetTurn - 1
  session.append('turn/start', { turn: priorTurn })
  session.append('user/message', { id: 'u' + priorTurn, role: 'user', content: [{ type: 'text', text: 'in' + priorTurn }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: priorTurn, step: 1, message: { id: 'a' + priorTurn, role: 'assistant', content: [{ type: 'text', text: 'out' + priorTurn }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: priorTurn, reason: { kind: 'completed' } })
  const db = new SqliteSessionDb(path.join(root, 'session.db'))
  db.materialize(session.header, session.inheritedEventCount, session.snapshotEvents())
  const store = createChatSqliteStore({ dataRoot: root, helpers })
  const beforeMessages = [{ role: 'user', turn: priorTurn, text: 'in' + priorTurn }, { role: 'assistant', turn: priorTurn, text: 'out' + priorTurn, swipeId: 0, swipes: ['out' + priorTurn] }]
  const before = { id: 'synthetic-chat', sessionId, _storageRevision: 1, mode: 'story', messages: beforeMessages, variables: { hp: priorTurn },
    macroState: { userName: 'user-edit', local: { keep: true } }, cardPath: 'cards/user-chosen.json', runtimePresetPath: 'presets/user.json', runtimePresetSnapshot: { kept: true },
    runtimeInputs: { [priorTurn]: { seed: priorTurn } }, nativeCommits: { [priorTurn]: priorTurn }, foregroundFrames: [], suppressedDshTurns: [],
    timeline: { schemaVersion: 1, branchId: 'branch-' + targetTurn, revision: 1, checkpoints: [], operations: {}, participants: {} } }
  await store.update(before.id, () => before)
  const baseline = captureRollbackBusinessState(await store.read(before.id))
  assert.equal(baseline.version, 1)
  const baselineFieldKeys = Object.keys(baseline.fields).sort()
  const preTargetEvents = session.snapshotEvents().slice()
  const boundary = rollbackBoundarySeq(session, targetTurn) + 1
  session.append('turn/start', { turn: targetTurn })
  session.append('user/message', { id: 'u' + targetTurn, role: 'user', content: [{ type: 'text', text: 'in' + targetTurn }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  if (mode !== 'failed') session.append('assistant/message', { turn: targetTurn, step: 1, message: { id: 'a' + targetTurn, role: 'assistant', content: [{ type: 'text', text: 'out' + targetTurn }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, stream: [] }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: targetTurn, reason: { kind: mode === 'failed' ? 'error' : 'completed' } })
  db.appendBatch(session.snapshotEvents().slice(preTargetEvents.length), preTargetEvents.length)
  const targetRows = [{ role: 'user', turn: targetTurn, text: 'in' + targetTurn }, ...(mode === 'failed' ? [] : [{ role: 'assistant', turn: targetTurn, text: 'out' + targetTurn, swipeId: 0, swipes: ['out' + targetTurn] }])]
  const current = { ...before, _storageRevision: 2, messages: [...beforeMessages, ...targetRows], variables: { hp: targetTurn },
    runtimeInputs: { ...before.runtimeInputs, [targetTurn]: { seed: targetTurn } }, nativeCommits: { ...before.nativeCommits, [targetTurn]: targetTurn },
    timeline: { ...before.timeline, revision: 2,
      operations: mode === 'failed' ? { body: { kind: 'body', turn: targetTurn, status: 'failed', businessBefore: baseline } } : {},
      checkpoints: mode === 'failed' ? [] : [{ id: 'cp' + targetTurn, turn: targetTurn, businessBefore: baseline }] } }
  await store.update(before.id, () => current)
  const read = () => store.read(before.id)
  const update = (_id, fn, metadata) => store.update(before.id, async now => { const next = await fn(now); next._storageRevision = now._storageRevision + 1; return next }, metadata)
  const agent = { session, phase: { kind: 'idle', lastTurn: targetTurn }, runtimeContext: {}, inbox: { nextTurn: [], nextStep: [] } }
  const handle = { id: sessionId, access: 'write', state: { cursor: session.seq, primed: {} }, observedLength: session.seq }
  const handles = new Set([handle])
  const counters = { bind: 0, pending: 0, truncate: 0, sideCleanup: 0, syncFrames: 0 }
  const persistence = {
    bindRollbackArchive: async (id, file) => { counters.bind += 1; return db.bindRollbackArchive(file) },
    setRollbackPending: async (id, value) => { counters.pending += 1; return db.setRollbackPending(value) },
    drainOpenHandles: async () => {},
    truncateEvents: async (header, boundarySeq) => { counters.truncate += 1; const meta = db.truncateFrom(boundarySeq); rewindRollbackHandles(handles, header.id, meta.eventCount); return meta },
  }
  let rollbackSync = null
  installRollbackSync({ get: () => ({ controlState: { ctx: { sessionProjections: projections }, jobsFor: () => [], broadcast: () => { counters.syncFrames += 1 } }, history: { assistantStreams: new Map() } }), provide: (_key, value) => { rollbackSync = value } })
  const recalls = createRollbackWorldbookRecallLog({ dataRoot: root, store: { readJson: async () => undefined, remove: async () => {} } })
  const live = await read()
  const availability = rollbackAvailability(live, { events: session.snapshotEvents(), nodes: session.surface.nodes })
  const target = { turn: targetTurn, branchId: live.timeline.branchId, revision: live._storageRevision, operationId: 'body', chatId: live.id, sessionId: live.sessionId }
  let error = null
  try {
    await cleanRollback({
      chat: live, requestedTurn: mode === 'failed' ? target : targetTurn,
      availability: (value, extra) => rollbackAvailability(value, extra || {}),
      readChat: read, updateChat: update,
      chats: { rollbackArchivePath: store.rollbackArchivePath, readRollbackWorldbook: store.readRollbackWorldbook, readSlice: store.readSlice, update },
      sessions: { get: () => agent, getSession: () => session, flush: async () => {} },
      persistence, services: { projections, projectionCache: { write: async () => {} }, tokenMeterProvider: () => ({ states: new WeakMap() }), rollbackSyncProvider: () => rollbackSync },
      quiesce: async () => {}, view: async value => ({ turn: value.messages.at(-1)?.turn ?? null, variables: value.variables }), readCard: async () => ({}),
      sideCleanup: async (value, turn) => { counters.sideCleanup += 1; return recalls.pruneRollback(value, turn, value.timeline.branchId) },
      ...(mode === 'failed' ? { failureTarget: target } : {}),
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
  const coldStore = createChatSqliteStore({ dataRoot: root, helpers })
  const coldChat = await coldStore.read(before.id)
  const coldNative = new SqliteSessionDb(path.join(root, 'session.db'))
  const coldFields = captureRollbackBusinessState(coldChat).fields
  const cold = {
    wholeFieldsDeepEqualBaseline: isDeepStrictEqual(coldFields, baseline.fields),
    messagesEqual: isDeepStrictEqual(coldChat.messages, beforeMessages),
    eventCountEqual: (coldNative.readMeta()?.eventCount ?? null) === boundary,
    residueFree: coldChat.rollbackPending === undefined && coldChat.timeline?.operations?.body === undefined && !coldNative.readAll().events.some(event => Number(event?.data?.turn) >= targetTurn),
  }
  const cleanup = async () => { recalls.dispose(); store.dispose(); db.close(); coldNative.close(); coldStore.dispose(); await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) }
  return { targetTurn, mode, boundary, checks, cold, counters, cleanup }
}

test('标准目录回退：迁后真实SQL与Session纯尾及冷开零撤销残留', async t => {
  const installRoot = mkdtempSync(path.join(os.tmpdir(), 'tavern-standard-home-'))
  t.after(() => rmSync(installRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const program = await installStandardProgram(installRoot)
  const outcome = await scenario(program, 7, 'failed')
  t.after(() => outcome.cleanup())
  for (const [name, ok] of Object.entries(outcome.checks)) assert.equal(ok, true, '现场检查失败：' + name)
  for (const [name, ok] of Object.entries(outcome.cold)) assert.equal(ok, true, '冷开检查失败：' + name)
  assert.equal(outcome.checks.noError, true, '失败轮回退不得报错（结构化失败也要走同一真路径）')
  assert.ok(outcome.counters.truncate >= 1, '必须真走原生截断（truncateEvents 调用计数）')
  assert.equal(outcome.targetTurn, 7)
  assert.equal(outcome.mode, 'failed')
})
