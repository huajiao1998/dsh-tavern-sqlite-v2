// 定向离线闸：原档手动分叉的**持久去重记录**（真实 SQLite + 临时 DSH_HOME）与保存 service 的接线契约。
// 只用 Node 内置：node test/legacy-fork-records.test.mjs
// 不读真实存档、不部署、不联网、不碰凭据；临时目录只在本文件自己的 mkdtemp 前缀下创建并精确删除。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FORK_RECORD_STATES, bindForkRecord, claimForkRecord, createForkRecords,
  finishForkRecord, markForkRecordCreated, readForkRecord, releaseCompletedForkRecord } from '../lib/legacy-fork-records.js'
import { legacyBindingsPath, listLegacyBindings, setLegacyBinding } from '../lib/legacy-bindings.js'
import { createLegacySaveActions } from '../lib/legacy-view-seams.js'
import { describeSaveFormat, formatSaveResult } from '../lib/migration-ops.js'

const roots = []
const previousHome = process.env.DSH_HOME
function freshHome(label) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'tavern-fork-records-' + label + '-'))
  roots.push(home)
  mkdirSync(path.join(home, 'profiles', 'tavern'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'tavern', 'package.json'),
    JSON.stringify({ name: 'dsh-profile-tavern', dshTavern: { dataRoot: path.join(home, 'profile-data', 'tavern', 'data') } }), 'utf8')
  process.env.DSH_HOME = home
  return home
}
function tablesOf(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name) }
  finally { db.close() }
}
/** code 传 undefined = 该错误没有错误码（纯 Error）。 */
function rejects(promise, code, pattern) {
  return assert.rejects(promise, error => {
    assert.equal(error?.code, code, '错误码必须是 ' + String(code) + '，实际 ' + String(error?.code) + '：' + String(error?.message))
    assert.match(String(error?.message), pattern)
    return true
  })
}

try {
  // ── 1) 记录模块：claim/bind/created/finish 的 CAS、唯一源记录、幂等与 SID 冻结 ──────────
  const home = freshHome('records')
  const file = path.join(home, 'profile-data', 'tavern', 'storages', 'tavern-sqlite-bindings.db')
  assert.equal(legacyBindingsPath(), file, '分叉记录必须与 legacy_bindings 同库同路径')
  assert.equal(readForkRecord('chat-none'), undefined)
  assert.equal(existsSync(file), false, '只读查询不得创建库文件')
  assert.deepEqual(FORK_RECORD_STATES, ['claimed', 'bound', 'created', 'complete'])

  const claimed = claimForkRecord({ sourceChatId: 'chat-src', sourceSessionId: 'session-src',
    sourceRevision: 7, turn: 3, atSeq: 42, targetTitle: 'DB.原名', now: 1000 })
  assert.equal(claimed.changed, true)
  assert.match(claimed.token, /^[0-9a-f-]{36}$/)
  assert.deepEqual({ ...claimed.record, token: 'x', claimedAt: 0, boundAt: 'y', createdAt: 'y', completedAt: 'y' },
    { sourceChatId: 'chat-src', sourceSessionId: 'session-src', sourceRevision: 7, turn: 3, atSeq: 42,
      targetTitle: 'DB.原名', token: 'x', state: 'claimed', targetSessionId: '', targetChatId: '', title: '',
      claimedAt: 0, boundAt: 'y', createdAt: 'y', completedAt: 'y' })
  assert.equal(claimed.record.boundAt, undefined)
  assert.equal(claimed.record.claimedAt, 1000)
  // 新库必须同时具备 legacy_bindings 表，否则旧读路径（会话目录 list()/启动登记/原档读/写闸）会炸。
  assert.deepEqual(tablesOf(file), ['legacy_bindings', 'legacy_fork_records'])
  assert.deepEqual(listLegacyBindings(), [], '新库上的旧读路径必须正常返回空')
  assert.equal(readForkRecord('chat-src').token, claimed.token, '记录里的 token 可被服务端读回')

  // 一个源档一条记录：重复 claim 一律拒绝，且不得改掉原记录的 token/revision。
  await rejects(Promise.resolve().then(() => claimForkRecord({ sourceChatId: 'chat-src', sourceSessionId: 'session-other',
    sourceRevision: 99, turn: 9, atSeq: 99, targetTitle: 'DB.别的' })), 'DSH_TAVERN_FORK_RECORD_EXISTS', /拒绝再次 claim/)
  assert.equal(readForkRecord('chat-src').token, claimed.token)
  assert.equal(readForkRecord('chat-src').sourceRevision, 7)

  // bind：错误 token / 未知源档拒绝；同 SID 幂等；换 SID 永久冻结即拒。
  await rejects(Promise.resolve().then(() => bindForkRecord({ sourceChatId: 'chat-src', token: 'token-other', targetSessionId: 'session-fork' })),
    'DSH_TAVERN_FORK_TOKEN_MISMATCH', /token 不一致/)
  await rejects(Promise.resolve().then(() => bindForkRecord({ sourceChatId: 'chat-none', token: claimed.token, targetSessionId: 'session-fork' })),
    'DSH_TAVERN_FORK_RECORD_MISSING', /找不到/)
  const bound = bindForkRecord({ sourceChatId: 'chat-src', token: claimed.token, targetSessionId: 'session-fork', now: 2000 })
  assert.equal(bound.changed, true)
  assert.equal(bound.record.state, 'bound')
  assert.equal(bound.record.targetSessionId, 'session-fork')
  assert.equal(bound.record.boundAt, 2000)
  assert.equal(bindForkRecord({ sourceChatId: 'chat-src', token: claimed.token, targetSessionId: 'session-fork' }).changed, false, '同 SID 重复绑定必须幂等')
  await rejects(Promise.resolve().then(() => bindForkRecord({ sourceChatId: 'chat-src', token: claimed.token, targetSessionId: 'session-other' })),
    'DSH_TAVERN_FORK_TARGET_FROZEN', /已冻结/)
  assert.equal(readForkRecord('chat-src').targetSessionId, 'session-fork')

  // created：目标 SID 不匹配拒绝；首个目标写定后不得改写；重复（同目标）幂等。
  await rejects(Promise.resolve().then(() => markForkRecordCreated({ sourceChatId: 'chat-src', token: claimed.token,
    targetSessionId: 'session-other', targetChatId: 'chat-other' })), 'DSH_TAVERN_FORK_CREATED_CONFLICT', /拒绝改写/)
  const created = markForkRecordCreated({ sourceChatId: 'chat-src', token: claimed.token,
    targetSessionId: 'session-fork', targetChatId: 'chat-fork', now: 3000 })
  assert.equal(created.changed, true)
  assert.equal(created.record.state, 'created')
  assert.equal(created.record.targetChatId, 'chat-fork')
  assert.equal(markForkRecordCreated({ sourceChatId: 'chat-src', token: claimed.token,
    targetSessionId: 'session-fork', targetChatId: 'chat-fork' }).changed, false)
  await rejects(Promise.resolve().then(() => markForkRecordCreated({ sourceChatId: 'chat-src', token: claimed.token,
    targetSessionId: 'session-fork', targetChatId: 'chat-second' })), 'DSH_TAVERN_FORK_CREATED_CONFLICT', /拒绝改写/)

  // finish：收口；重复收口幂等并保留首个（用户可能已改名的）标题。
  const finished = finishForkRecord({ sourceChatId: 'chat-src', token: claimed.token, title: 'DB.原名（已接受）', now: 4000 })
  assert.equal(finished.changed, true)
  assert.equal(finished.record.state, 'complete')
  assert.equal(finished.record.title, 'DB.原名（已接受）')
  const refinished = finishForkRecord({ sourceChatId: 'chat-src', token: claimed.token, title: 'DB.用户改名' })
  assert.equal(refinished.changed, false)
  assert.equal(refinished.record.title, 'DB.原名（已接受）', '重复收口不得覆盖已接受的标题')
  assert.equal(existsSync(file), true)
  for (const suffix of ['-wal', '-shm']) assert.equal(existsSync(file + suffix), false, '收尾不得留下 ' + suffix)

  // ── 2) 老库缺表容忍 / 损坏不吞 ──────────────────────────────────────────────────────
  freshHome('old-db')
  const oldFile = legacyBindingsPath()
  const artifact = path.join(process.env.DSH_HOME, 'artifact.json')
  writeFileSync(artifact, '{}', 'utf8')
  setLegacyBinding({ chatId: 'chat-bound', sessionId: 'session-bound', originalSessionId: 'session-original', artifactPath: artifact })
  assert.deepEqual(tablesOf(oldFile), ['legacy_bindings'], '旧库只有 legacy_bindings 表')
  assert.equal(readForkRecord('chat-bound'), undefined, '缺表必须当作"没有记录"而不是抛错')
  assert.equal(listLegacyBindings().length, 1, '旧读路径不受影响')

  freshHome('broken-db')
  mkdirSync(path.dirname(legacyBindingsPath()), { recursive: true })
  writeFileSync(legacyBindingsPath(), 'not a sqlite database at all', 'utf8')
  assert.throws(() => readForkRecord('chat-src'), /not a database|SQLITE|malformed/i, '损坏的库必须抛，不得吞成"没有记录"')

  // ── 2b) 显式释放：**只**释放"完成 + 精确目标"的一行；claimed/bound/created 与错目标一律拒 ──────
  freshHome('release')
  const releaseSource = 'chat-release-src'
  const releaseClaim = claimForkRecord({ sourceChatId: releaseSource, sourceSessionId: 'session-release-src',
    sourceRevision: 3, turn: 2, atSeq: 11, targetTitle: 'DB.释放源', now: 10 })
  const releaseArgs = { sourceChatId: releaseSource, targetChatId: 'chat-release-target', targetSessionId: 'session-release-target' }
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord(releaseArgs)),
    'DSH_TAVERN_FORK_RELEASE_NOT_COMPLETE', /不是 complete/) // claimed：SID 回执未知，禁止自动重置
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord({ ...releaseArgs, sourceChatId: 'chat-none' })),
    'DSH_TAVERN_FORK_RECORD_MISSING', /无需释放/)
  bindForkRecord({ sourceChatId: releaseSource, token: releaseClaim.token, targetSessionId: releaseArgs.targetSessionId, now: 11 })
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord(releaseArgs)),
    'DSH_TAVERN_FORK_RELEASE_NOT_COMPLETE', /不是 complete/) // bound：SID 已冻结
  markForkRecordCreated({ sourceChatId: releaseSource, token: releaseClaim.token,
    targetSessionId: releaseArgs.targetSessionId, targetChatId: releaseArgs.targetChatId, now: 12 })
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord(releaseArgs)),
    'DSH_TAVERN_FORK_RELEASE_NOT_COMPLETE', /不是 complete/) // created：未收口 ≠ 不存在
  finishForkRecord({ sourceChatId: releaseSource, token: releaseClaim.token, title: 'DB.释放源', now: 13 })
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord({ ...releaseArgs, targetSessionId: 'session-other' })),
    'DSH_TAVERN_FORK_RELEASE_TARGET_MISMATCH', /不一致/)
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord({ ...releaseArgs, targetChatId: 'chat-other' })),
    'DSH_TAVERN_FORK_RELEASE_TARGET_MISMATCH', /不一致/)
  assert.equal(readForkRecord(releaseSource).state, 'complete', '拒绝路径不得改动记录')
  // 另一条已完成关系必须原样保留：释放只删精确一行。
  const otherClaim = claimForkRecord({ sourceChatId: 'chat-release-other', sourceSessionId: 'session-release-other',
    sourceRevision: 1, turn: 1, atSeq: 2, targetTitle: 'DB.别的源', now: 14 })
  bindForkRecord({ sourceChatId: 'chat-release-other', token: otherClaim.token, targetSessionId: 'session-other-target', now: 15 })
  markForkRecordCreated({ sourceChatId: 'chat-release-other', token: otherClaim.token,
    targetSessionId: 'session-other-target', targetChatId: 'chat-other-target', now: 16 })
  finishForkRecord({ sourceChatId: 'chat-release-other', token: otherClaim.token, title: 'DB.别的源', now: 17 })
  const releasedRow = releaseCompletedForkRecord(releaseArgs)
  assert.equal(releasedRow.changed, true)
  assert.equal(releasedRow.removed.state, 'complete')
  assert.equal(releasedRow.removed.targetChatId, releaseArgs.targetChatId)
  assert.equal(releasedRow.removed.targetSessionId, releaseArgs.targetSessionId)
  assert.equal(releasedRow.removed.title, 'DB.释放源')
  assert.equal(readForkRecord(releaseSource), undefined, '释放后必须查不到该源记录')
  assert.equal(readForkRecord('chat-release-other').state, 'complete', '非目标关系必须原样保留')
  await rejects(Promise.resolve().then(() => releaseCompletedForkRecord(releaseArgs)),
    'DSH_TAVERN_FORK_RECORD_MISSING', /无需释放/) // 重复释放必须拒
  // 释放后同一源可重新 claim（新 token）；旧 SID 只作为回执，不参与任何后续绑定。
  const reclaimed = claimForkRecord({ sourceChatId: releaseSource, sourceSessionId: 'session-release-src',
    sourceRevision: 3, turn: 2, atSeq: 11, targetTitle: 'DB.释放源', now: 18 })
  assert.equal(reclaimed.changed, true)
  assert.notEqual(reclaimed.token, releaseClaim.token, '重新创建必须拿到新 token（新一次 native fork → 新 SID）')
  assert.equal(reclaimed.record.targetSessionId, '', '新记录不得复用旧目标 SID')

  // ── 3) 与保存 service 接线：claim 占位 → 冻结 SID → 建档 → 标题 → 收口 ────────────────
  freshHome('service')
  const records = createForkRecords()
  const sourceChat = 'chat-legacy-source'
  const sourceSession = 'session-legacy-source'
  const dbSession = 'session-db-source'
  const dbChat = 'chat-db-source'
  const targetTitle = 'DB.原名'
  const formats = { [sourceChat]: 'legacy:11:22', [dbChat]: 'sqlite:gen:9' }
  const calls = { prepare: 0, complete: 0, rename: 0, titleSet: [] }
  let resolveTarget = () => ''
  const chats = {
    async version(chatId) { return formats[chatId] || 'sqlite:gen:1' },
    async read(chatId) { throw new Error('本源路径不得读档：' + chatId) },
  }
  const baseDeps = {
    chats,
    resolveChatId: async sessionId => sessionId === sourceSession ? sourceChat
      : (sessionId === dbSession ? dbChat : resolveTarget(sessionId)),
    prepareFork: async (chatId, sessionId) => {
      calls.prepare++
      // 聊天档 title / 卡名故意都设成卡名：目标标题必须只认原生标题 '原名'（2026-10-01 缺陷回归）。
      return { source: { id: chatId, sessionId, _storageRevision: 7, title: '重回1980-2020年代创业增量版',
        cardName: '重回1980-2020年代创业增量版' }, turn: 3, atSeq: 42 }
    },
    completeFork: async (chatId, sessionId, target, turn, revision, atSeq) => {
      calls.complete++
      assert.deepEqual([chatId, sessionId, target, turn, revision, atSeq], [sourceChat, sourceSession, 'session-fork', 3, 7, 42])
      formats['chat-fork'] = 'sqlite:gen:1'
      resolveTarget = id => id === 'session-fork' ? 'chat-fork' : ''
      return { chatId: 'chat-fork', sessionId: target }
    },
    describeSaveFormat, formatSaveResult,
    forkRecords: records,
    readSourceSessionTitle: async () => '原名',
    renameTargetSession: async (sessionId, title) => { calls.rename++; assert.equal(sessionId, 'session-fork'); assert.equal(title, targetTitle); return targetTitle },
    setTargetChatTitle: async (chatId, title) => { calls.titleSet.push([chatId, title]); return title },
    validateTargetNaming: async () => {},
    queryVariables: async () => ({}), formatVariableResult: () => '',
  }
  const service = createLegacySaveActions(baseDeps)
  let status = await service.status({ sessionId: sourceSession })
  assert.equal(status.forked, false); assert.equal(status.pending, false); assert.equal(status.legacy, true)

  const plan = await service.prepare({ sessionId: sourceSession })
  assert.deepEqual(Object.keys(plan).sort(), ['atSeq', 'sourceChatId', 'sourceRevision', 'sourceSessionId', 'targetTitle', 'turn'])
  assert.equal(plan.targetTitle, targetTitle, '标题必须由**源会话原生标题**派生（非聊天档 title / 卡名）')
  // 客户端塞进来的标题只用于一致性核对，不一致立即拒（此时还不得写任何记录）。
  await rejects(service.claim({ ...plan, sessionId: sourceSession, targetTitle: 'DB.伪造' }), undefined, /标题不一致/)
  assert.equal(readForkRecord(sourceChat), undefined, '核对失败不得落 claim 记录')
  // 严格源判据（prepare 也要）：数据库档直接拒，且不得进入 prepareFork。
  const prepareBefore = calls.prepare
  await rejects(service.prepare({ sessionId: dbSession }), 'DSH_TAVERN_FORK_SOURCE_NOT_LEGACY', /只有只读原档/)
  await rejects(service.claim({ sessionId: dbSession }), 'DSH_TAVERN_FORK_SOURCE_NOT_LEGACY', /只有只读原档/)
  assert.equal(calls.prepare, prepareBefore, '非原档必须在 prepareFork 之前就被拒')

  const claim = await service.claim({ ...plan, sessionId: sourceSession })
  assert.equal(claim.state, 'claimed'); assert.equal(claim.targetTitle, targetTitle)
  assert.match(claim.token, /^[0-9a-f-]{36}$/)
  const beforeDuplicate = calls.prepare
  await rejects(service.claim({ ...plan, sessionId: sourceSession }), 'DSH_TAVERN_FORK_RECORD_EXISTS', /已有.*分叉记录|已经分叉过/)
  await rejects(service.prepare({ sessionId: sourceSession }), 'DSH_TAVERN_FORK_RECORD_EXISTS', /拒绝再次分叉|拒绝重复创建/)
  assert.equal(calls.prepare, beforeDuplicate, '既有记录必须先于重 plan 被拒（连 prepareFork 都不做）')
  assert.equal(calls.complete, 0)

  const inflight = [
    service.complete({ ...claim, sessionId: sourceSession, targetSessionId: 'session-fork' }),
    service.complete({ ...claim, sessionId: sourceSession, targetSessionId: 'session-fork' }),
  ]
  const [first, second] = await Promise.all(inflight)
  assert.equal(calls.complete, 1, '同 token 并发 complete 只能建一次分叉')
  assert.equal(calls.rename, 1, '同 token 并发 complete 只能 rename 一次')
  assert.deepEqual(calls.titleSet, [['chat-fork', targetTitle]])
  assert.equal(first.chatId, second.chatId)
  assert.equal(first.changed, true)
  const stored = readForkRecord(sourceChat)
  assert.equal(stored.state, 'complete')
  assert.equal(stored.targetSessionId, 'session-fork')
  assert.equal(stored.targetChatId, 'chat-fork')
  assert.equal(stored.title, targetTitle)

  status = await service.status({ sessionId: sourceSession })
  assert.equal(status.forked, true); assert.equal(status.pending, false)
  assert.deepEqual(status.targetInfo, { state: 'complete', targetChatId: 'chat-fork', targetSessionId: 'session-fork', title: targetTitle })
  assert.equal(JSON.stringify(status).includes(claim.token), false, 'status 不得泄露 token')

  // 已收口重试：只回执，绝不再次 rename / 建档；换 SID 必须拒。
  const retry = await service.complete({ ...claim, sessionId: sourceSession, targetSessionId: 'session-fork' })
  assert.equal(retry.changed, false); assert.equal(retry.retry, true)
  assert.equal(calls.complete, 1, '已收口重试不得再次 completeFork')
  assert.equal(calls.rename, 1, '已收口重试不得再次 rename（用户可能已改名）')
  await rejects(service.complete({ ...claim, sessionId: sourceSession, targetSessionId: 'session-other' }), 'DSH_TAVERN_FORK_TARGET_FROZEN', /已冻结/)
  await rejects(service.complete({ ...claim, token: '', sessionId: sourceSession, targetSessionId: 'session-fork' }), undefined, /缺少分叉记录 token/)

  // 3b) 同 token 并发但参数不同（换目标 SID）⇒ 必须拒且只能 fork 一次（不许复用别人的 run）。
  const raceSource = 'chat-legacy-race'
  const raceSession = 'session-legacy-race'
  formats[raceSource] = 'legacy:51:61'
  const raceCalls = { complete: 0, rename: 0 }
  const raceService = createLegacySaveActions({
    chats: { async version(chatId) { return formats[chatId] || 'sqlite:gen:1' }, async read() { throw new Error('不应读档') } },
    resolveChatId: async sessionId => sessionId === raceSession ? raceSource : '',
    prepareFork: async (chatId, sessionId) => ({ source: { id: chatId, sessionId, _storageRevision: 2, title: '竞态源' }, turn: 2, atSeq: 21 }),
    completeFork: async (chatId, sessionId, target) => {
      raceCalls.complete++
      formats['chat-race-' + target.slice(-1)] = 'sqlite:gen:1'
      return { chatId: 'chat-race-' + target.slice(-1), sessionId: target }
    },
    describeSaveFormat, formatSaveResult, forkRecords: records,
    readSourceSessionTitle: async () => '竞态源',
    renameTargetSession: async (sessionId, title) => { raceCalls.rename++; return title },
    setTargetChatTitle: async (chatId, title) => title,
    validateTargetNaming: async () => {},
    queryVariables: async () => ({}), formatVariableResult: () => '',
  })
  const racePlan = await raceService.prepare({ sessionId: raceSession })
  const raceClaim = await raceService.claim({ ...racePlan, sessionId: raceSession })
  const raceResults = await Promise.allSettled([
    raceService.complete({ ...raceClaim, sessionId: raceSession, targetSessionId: 'session-race-a' }),
    raceService.complete({ ...raceClaim, sessionId: raceSession, targetSessionId: 'session-race-b' }),
  ])
  assert.equal(raceResults.filter(entry => entry.status === 'fulfilled').length, 1, '同 token 不同参数只能有一个成立')
  const raceRejection = raceResults.find(entry => entry.status === 'rejected')
  assert.match(String(raceRejection?.reason?.message || raceRejection?.reason), /并发另存参数不一致|已冻结/)
  assert.equal(raceCalls.complete, 1, '同 token 并发不同参数只能 fork 一次')
  assert.equal(raceCalls.rename, 1)

  // 3c) 原生标题：只接受 string / {title:string}，且必须带 DB. 前缀；失败停在 created，可同 token 重试补齐。
  const titleSource = 'chat-legacy-title'
  const titleSession = 'session-legacy-title'
  formats[titleSource] = 'legacy:71:81'
  const titleWrites = []
  let renameReturn = {}
  const titleService = createLegacySaveActions({
    chats: { async version(chatId) { return formats[chatId] || 'sqlite:gen:1' }, async read() { throw new Error('不应读档') } },
    resolveChatId: async sessionId => sessionId === titleSession ? titleSource : '',
    prepareFork: async (chatId, sessionId) => ({ source: { id: chatId, sessionId, _storageRevision: 3, title: '标题源' }, turn: 3, atSeq: 31 }),
    completeFork: async (chatId, sessionId, target) => { formats['chat-title-fork'] = 'sqlite:gen:1'; return { chatId: 'chat-title-fork', sessionId: target } },
    describeSaveFormat, formatSaveResult, forkRecords: records,
    readSourceSessionTitle: async () => '标题源',
    renameTargetSession: async () => renameReturn,
    setTargetChatTitle: async (chatId, title) => { titleWrites.push([chatId, title]); return title },
    validateTargetNaming: async () => {},
    queryVariables: async () => ({}), formatVariableResult: () => '',
  })
  const titlePlan = await titleService.prepare({ sessionId: titleSession })
  const titleClaim = await titleService.claim({ ...titlePlan, sessionId: titleSession })
  assert.equal(titleClaim.targetTitle, 'DB.标题源')
  await assert.rejects(titleService.complete({ ...titleClaim, sessionId: titleSession, targetSessionId: 'session-title-fork' }), /标题未被接受/)
  assert.equal(readForkRecord(titleSource).state, 'created', '标题失败必须停在 created（档已建，不得回退/重建）')
  assert.deepEqual(titleWrites, [], '标题未被接受时不得写目标档标题')
  renameReturn = '原名'
  await assert.rejects(titleService.complete({ ...titleClaim, sessionId: titleSession, targetSessionId: 'session-title-fork' }), /未带 DB\. 前缀/)
  assert.equal(readForkRecord(titleSource).state, 'created')
  assert.deepEqual(titleWrites, [])
  // 前导空白：维持 DB. 前缀严格（拒），但服务端不得替宿主 trim 后再放行。
  renameReturn = ' DB.标题源'
  await assert.rejects(titleService.complete({ ...titleClaim, sessionId: titleSession, targetSessionId: 'session-title-fork' }), /未带 DB\. 前缀/)
  assert.deepEqual(titleWrites, [])
  // 尾部空白：前缀成立 ⇒ 必须**逐字节原样**写进目标档（不 trim、不改宿主接受值）。
  renameReturn = 'DB.标题源 '
  const titleDone = await titleService.complete({ ...titleClaim, sessionId: titleSession, targetSessionId: 'session-title-fork' })
  assert.equal(titleDone.changed, true)
  assert.equal(readForkRecord(titleSource).state, 'complete')
  assert.deepEqual(titleWrites, [['chat-title-fork', 'DB.标题源 ']], 'accepted 必须原样写入，不得 trim')
  assert.equal(readForkRecord(titleSource).title, 'DB.标题源 ')

  // 3d) 命名 preflight：服务不可用时 prepare/claim 都必须早失败——不重核 plan、不写 claim、不留记录。
  const preflightSource = 'chat-legacy-preflight'
  const preflightSession = 'session-legacy-preflight'
  formats[preflightSource] = 'legacy:91:92'
  const preflight = { prepare: 0, claim: 0 }
  const spyRecords = { ...records, claim: (...args) => { preflight.claim++; return records.claim(...args) } }
  const preflightService = createLegacySaveActions({
    chats: { async version(chatId) { return formats[chatId] || 'sqlite:gen:1' }, async read() { throw new Error('不应读档') } },
    resolveChatId: async sessionId => sessionId === preflightSession ? preflightSource : '',
    prepareFork: async (chatId, sessionId) => { preflight.prepare++; return { source: { id: chatId, sessionId, _storageRevision: 1, title: '预检源' }, turn: 1, atSeq: 9 } },
    completeFork: async () => { throw new Error('preflight 失败不得进入 completeFork') },
    describeSaveFormat, formatSaveResult, forkRecords: spyRecords,
    readSourceSessionTitle: async () => '预检源',
    renameTargetSession: async () => '', setTargetChatTitle: async () => '',
    validateTargetNaming: async () => { throw new Error('目标命名服务未接线（sessionTitle/flush/chat-title sync）') },
    queryVariables: async () => ({}), formatVariableResult: () => '',
  })
  await assert.rejects(preflightService.prepare({ sessionId: preflightSession }), /目标命名服务未接线/)
  await assert.rejects(preflightService.claim({ sessionId: preflightSession }), /目标命名服务未接线/)
  assert.equal(preflight.prepare, 0, 'preflight 失败必须早于 plan 重核')
  assert.equal(preflight.claim, 0, 'preflight 失败不得写 claim 占位')
  assert.equal(readForkRecord(preflightSource), undefined, 'preflight 失败不得留下任何记录')

  // ── 3e) 显式释放的 service 编排：只读 status.targetExists + release 的逐条前置与 CAS ─────────
  const releaseSource3 = 'chat-legacy-release-svc'
  const releaseSession3 = 'session-legacy-release-svc'
  const targetSession3 = 'session-release-svc-target'
  const targetChat3 = 'chat-' + targetSession3
  formats[releaseSource3] = 'legacy:71:72'
  const releaseService = createLegacySaveActions({
    // 未登记的 chatId 一律 ''（= describeSaveFormat 抛 DSH_TAVERN_SAVE_NOT_FOUND），模拟目标已被删除。
    chats: { async version(chatId) { return formats[chatId] ?? '' }, async read() { throw new Error('不应读档') } },
    resolveChatId: async sessionId => sessionId === releaseSession3 ? releaseSource3 : '',
    prepareFork: async (chatId, sessionId) => ({ source: { id: chatId, sessionId, _storageRevision: 5, title: '释放源' }, turn: 2, atSeq: 31 }),
    completeFork: async (chatId, sessionId, target) => { formats['chat-' + target] = 'sqlite:gen:2'; return { chatId: 'chat-' + target, sessionId: target } },
    describeSaveFormat, formatSaveResult, forkRecords: records,
    readSourceSessionTitle: async () => '释放源',
    renameTargetSession: async (sessionId, title) => title,
    setTargetChatTitle: async (chatId, title) => title,
    validateTargetNaming: async () => {},
    queryVariables: async () => ({}), formatVariableResult: () => '',
  })
  const releasePlan3 = await releaseService.prepare({ sessionId: releaseSession3 })
  const releaseClaim3 = await releaseService.claim({ ...releasePlan3, sessionId: releaseSession3 })
  const releaseDone3 = await releaseService.complete({ ...releaseClaim3, sessionId: releaseSession3, targetSessionId: targetSession3 })
  assert.equal(releaseDone3.chatId, targetChat3)
  const releaseArgs3 = { sessionId: releaseSession3, targetChatId: targetChat3, targetSessionId: targetSession3 }
  // 目标在位 ⇒ targetExists=true，release 必须拒（仍在的档绝不能释放）
  let releaseStatus3 = await releaseService.status({ sessionId: releaseSession3 })
  assert.equal(releaseStatus3.forked, true); assert.equal(releaseStatus3.targetExists, true)
  await rejects(releaseService.release(releaseArgs3), undefined, /仍存在或无法确认/)
  // 目标确证 missing：status 只报事实，**不改** forked/pending，也不自动放行
  delete formats[targetChat3]
  releaseStatus3 = await releaseService.status({ sessionId: releaseSession3 })
  assert.equal(releaseStatus3.forked, true, '目标 missing 不得把完成关系降级为"未分叉"')
  assert.equal(releaseStatus3.pending, false)
  assert.equal(releaseStatus3.targetExists, false)
  assert.deepEqual(releaseStatus3.targetInfo, { state: 'complete', targetChatId: targetChat3, targetSessionId: targetSession3, title: 'DB.释放源' })
  assert.match(releaseStatus3.text, /已不存在|显式释放/)
  assert.equal(readForkRecord(releaseSource3).state, 'complete', 'status 只读，不得改动记录')
  // tuple 必须回显（缺失/不符都拒），拒绝路径不得改动记录
  await rejects(releaseService.release({ sessionId: releaseSession3, targetChatId: targetChat3 }), undefined, /不一致/)
  await rejects(releaseService.release({ sessionId: releaseSession3, targetChatId: targetChat3, targetSessionId: 'session-other' }), undefined, /不一致/)
  assert.equal(readForkRecord(releaseSource3).state, 'complete')
  // 未知（不是我们的存储实现）绝不当作 missing
  formats[targetChat3] = 'author-native'
  await rejects(releaseService.release(releaseArgs3), undefined, /仍存在或无法确认/)
  assert.equal(readForkRecord(releaseSource3).state, 'complete')
  // 确证 missing 后才放行：单条 CAS + 精确回执
  delete formats[targetChat3]
  const released3 = await releaseService.release(releaseArgs3)
  assert.equal(released3.released, true); assert.equal(released3.changed, true); assert.equal(released3.targetExists, false)
  assert.equal(released3.chatId, releaseSource3); assert.equal(released3.sessionId, releaseSession3)
  assert.deepEqual(released3.removed, { state: 'complete', targetChatId: targetChat3, targetSessionId: targetSession3, title: 'DB.释放源' })
  assert.match(released3.text, /原生会话不由此动作删除/)
  assert.equal(released3.text.includes(releaseClaim3.token), false, '回执不得泄露 token')
  assert.equal(readForkRecord(releaseSource3), undefined, '释放后该源必须查不到记录')
  releaseStatus3 = await releaseService.status({ sessionId: releaseSession3 })
  assert.equal(releaseStatus3.forked, false); assert.equal(releaseStatus3.pending, false)
  assert.equal(releaseStatus3.targetExists, undefined, '无记录时不报在位状态')
  // 释放后同一源可再次显式创建：新记录没有冻结 SID，且能接受**新的**目标 SID
  const nextTarget3 = 'session-release-svc-target-2'
  const releasePlan4 = await releaseService.prepare({ sessionId: releaseSession3 })
  const releaseClaim4 = await releaseService.claim({ ...releasePlan4, sessionId: releaseSession3 })
  assert.equal(readForkRecord(releaseSource3).targetSessionId, '', '新记录不得复用旧目标 SID')
  const releaseDone4 = await releaseService.complete({ ...releaseClaim4, sessionId: releaseSession3, targetSessionId: nextTarget3 })
  assert.equal(releaseDone4.chatId, 'chat-' + nextTarget3)
  assert.equal(readForkRecord(releaseSource3).targetSessionId, nextTarget3, '释放后必须以新 SID 建成新分叉')
  assert.notEqual(nextTarget3, targetSession3)

  // ── 4) 恢复路径：publish 已成功但回执丢失时，不再建第二个档 ──────────────────────────
  const recoverySource = 'chat-legacy-recovery'
  const recoverySession = 'session-legacy-recovery'
  formats[recoverySource] = 'legacy:31:44'
  const recovered = { id: 'chat-recovered', sessionId: 'session-recovered', forkedFrom: { chatId: recoverySource } }
  const recoveryCalls = { complete: 0, rename: 0, title: [] }
  const recoveryService = createLegacySaveActions({
    chats: { async version(chatId) { return formats[chatId] || 'sqlite:gen:1' }, async read(chatId) { assert.equal(chatId, 'chat-recovered'); return recovered } },
    resolveChatId: async sessionId => sessionId === recoverySession ? recoverySource
      : (sessionId === 'session-recovered' ? 'chat-recovered' : ''),
    prepareFork: async (chatId, sessionId) => ({ source: { id: chatId, sessionId, _storageRevision: 1, title: '恢复源' }, turn: 1, atSeq: 5 }),
    completeFork: async () => { recoveryCalls.complete++; throw new Error('恢复路径不得再建档') },
    describeSaveFormat, formatSaveResult, forkRecords: records,
    readSourceSessionTitle: async () => '恢复源',
    renameTargetSession: async (sessionId, title) => { recoveryCalls.rename++; assert.equal(sessionId, 'session-recovered'); return title },
    setTargetChatTitle: async (chatId, title) => { recoveryCalls.title.push([chatId, title]); return title },
    validateTargetNaming: async () => {},
    queryVariables: async () => ({}), formatVariableResult: () => '',
  })
  const recoveryPlan = await recoveryService.prepare({ sessionId: recoverySession })
  const recoveryClaim = await recoveryService.claim({ ...recoveryPlan, sessionId: recoverySession })
  assert.equal(recoveryClaim.targetTitle, 'DB.恢复源')
  const recoveryResult = await recoveryService.complete({ ...recoveryClaim, sessionId: recoverySession, targetSessionId: 'session-recovered' })
  assert.equal(recoveryCalls.complete, 0, '恢复路径不得再次 completeFork')
  assert.equal(recoveryResult.chatId, 'chat-recovered')
  assert.equal(recoveryResult.changed, true)
  assert.deepEqual(recoveryCalls.title, [['chat-recovered', 'DB.恢复源']])

  // 恢复出的目标不是本源的分叉 ⇒ 必须拒绝复用（且不得改标题/建档）。
  const otherSource = 'chat-legacy-other'
  formats[otherSource] = 'legacy:1:2'
  const guardService = createLegacySaveActions({
    chats: { async version(chatId) { return formats[chatId] || 'sqlite:gen:1' }, async read() { return recovered } },
    resolveChatId: async sessionId => sessionId === 'session-other-source' ? otherSource
      : (sessionId === 'session-recovered' ? 'chat-recovered' : ''),
    prepareFork: async (chatId, sessionId) => ({ source: { id: chatId, sessionId, _storageRevision: 1, title: '别的源' }, turn: 1, atSeq: 5 }),
    completeFork: async () => { throw new Error('不得建档') },
    describeSaveFormat, formatSaveResult, forkRecords: records,
    readSourceSessionTitle: async () => '别的源',
    renameTargetSession: async () => { throw new Error('不得改标题') },
    setTargetChatTitle: async () => { throw new Error('不得改标题') },
    validateTargetNaming: async () => {},
    queryVariables: async () => ({}), formatVariableResult: () => '',
  })
  const guardPlan = await guardService.prepare({ sessionId: 'session-other-source' })
  const guardClaim = await guardService.claim({ ...guardPlan, sessionId: 'session-other-source' })
  await assert.rejects(guardService.complete({ ...guardClaim, sessionId: 'session-other-source', targetSessionId: 'session-recovered' }),
    /分叉目标不是本源档的分叉/)

  // ── 5) 缺依赖必须响亮失败，绝不静默走无去重旧路径 ────────────────────────────────────
  const { forkRecords: _ignored, ...withoutRecords } = baseDeps
  assert.throws(() => createLegacySaveActions(withoutRecords), /缺少 forkRecords/)
  assert.throws(() => createLegacySaveActions({ ...withoutRecords, forkRecords: {} }), /forkRecords 缺少 read/)
  assert.throws(() => createLegacySaveActions({ ...withoutRecords, forkRecords: { read() {}, claim() {}, bind() {}, created() {} } }), /forkRecords 缺少 finish/)
  assert.throws(() => createLegacySaveActions({ ...withoutRecords, forkRecords: createForkRecordsWithoutRelease() }), /forkRecords 缺少 release/)
  function createForkRecordsWithoutRelease() { const { release: _drop, ...rest } = createForkRecords(); return rest }
  assert.throws(() => createLegacySaveActions({ ...baseDeps, renameTargetSession: undefined }), /缺少 renameTargetSession/)
  assert.throws(() => createLegacySaveActions({ ...baseDeps, readSourceSessionTitle: undefined }), /缺少 readSourceSessionTitle/)
  assert.throws(() => createLegacySaveActions({ ...baseDeps, setTargetChatTitle: undefined }), /缺少 setTargetChatTitle/)
  assert.throws(() => createLegacySaveActions({ ...baseDeps, validateTargetNaming: undefined }), /缺少 validateTargetNaming/)
  assert.doesNotThrow(() => createLegacySaveActions(baseDeps))

  console.log('legacy-fork-records：claim/bind/created/finish/release CAS、唯一源记录、SID 冻结、老库容忍、损坏不吞、service 接线与释放/恢复/幂等全部通过')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  for (const home of roots) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
