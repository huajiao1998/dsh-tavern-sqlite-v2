// 定向契约测试：插件绑定与原生日志只读观察，不迁移、不写原件、不把旧header-only身份当别名。
// generationFormat 是显式模拟的请求契约（本 fixture 只证明我们请求了 strict/current 且不碰正文），
// 不是对真实宿主恢复策略、真实Session事件关系或UI历史的验收。
// 只用Node内置：node test/legacy-session-reader.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  legacyBindingsPath, listLegacyBindings, legacyBindingForChat, legacyBindingForSession,
  setLegacyBinding, overlayLegacyLinks, projectLegacyEnvelope,
} from '../lib/legacy-bindings.js'
import { legacyArtifactFor, readLegacySession, statLegacySession, createLegacyReadHandle } from '../lib/legacy-session-reader.js'

function snapshot(root) {
  const dirs = []
  const files = {}
  function visit(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative + entry.name
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) { dirs.push(name); visit(file, name + '/') }
      else files[name] = readFileSync(file)
    }
  }
  visit(root)
  return { dirs, files }
}

function writeArtifact(file, header, events, compressed = false) {
  mkdirSync(path.dirname(file), { recursive: true })
  const head = JSON.stringify(header) + '\n'
  const body = events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
  // 多帧zstd覆盖原生承载的解码路径；没有调用任何迁移器或SQLite会话写入。
  writeFileSync(file, compressed ? Buffer.concat([zstdCompressSync(Buffer.from(head, 'utf8')), zstdCompressSync(Buffer.from(body, 'utf8'))]) : head + body, compressed ? undefined : 'utf8')
}

function strictFixtureFormat(inheritedEventCount = 2) {
  const calls = []
  return {
    calls,
    createRestore(header, options) {
      assert.deepEqual(options, { recovery: 'strict', validation: 'current' }, '只证明请求参数，不证明真实宿主策略')
      const call = { header: structuredClone(header), options: structuredClone(options), rows: [], finishes: 0 }
      calls.push(call)
      return {
        // 官方 restore 对象在构造期就持有已解码/已迁移的 header
        // （CurrentSessionFormatRestore.header = decoder.header；迁移路径 = migration.header）。
        header: structuredClone(header),
        decodeRow(row) {
          // 这是模拟契约的拒绝标记，不冒充真实宿主的事件语义验证。
          if (row.fixtureInvalid) throw new Error('模拟strict恢复拒绝无效事件')
          call.rows.push(structuredClone(row))
        },
        finish() {
          call.finishes++
          return { header: structuredClone(call.header), events: structuredClone(call.rows), inheritedEventCount }
        },
      }
    },
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-legacy-reader-'))
const previousHome = process.env.DSH_HOME
try {
  const nativeRoot = path.join(root, 'native-root')
  const home = path.join(root, 'isolated-home')
  const chatId = 'chat-bound'
  const realId = 'session-genuine'
  const oldId = 'session-header-only'
  const naturalId = 'session-unbound'
  const cwd = path.join(root, 'workspace')
  mkdirSync(cwd)
  const header = {
    id: realId, version: 3, cwd, title: '只读契约样例', isSeeded: true,
    lineage: { sourceSessionId: 'session-fixture-parent', atSeq: 1 },
    fixtureUnknownHeaderField: { keep: '不裁剪字段' },
  }
  const events = [
    { seq: 0, type: 'turn/start', turn: 1, fixturePayload: { inherited: true } },
    { seq: 1, type: 'user/message', turn: 1, content: '原始输入' },
    { seq: 2, type: 'assistant/message', turn: 1, sourceEventSeqs: [1], content: '原始输出' },
    { seq: 3, type: 'turn/end', turn: 1, fixtureUnknownEventField: { keep: true } },
  ]
  const parkedPath = path.join(root, 'parked', realId, 'session.v3.jsonl.zstd')
  const oldPath = path.join(nativeRoot, 'fixture-project', oldId, 'session.v3.jsonl')
  const naturalPath = path.join(nativeRoot, 'fixture-project', naturalId, 'session.v3.jsonl')
  writeArtifact(parkedPath, header, events, true)
  writeArtifact(oldPath, { id: oldId, version: 3, cwd, isSeeded: false }, [])
  writeArtifact(naturalPath, { id: naturalId, version: 3, cwd }, events)
  writeFileSync(path.join(path.dirname(naturalPath), 'session.v9.jsonl.tmp'), '未发布临时文件', 'utf8')
  process.env.DSH_HOME = home

  // 1) 只读绑定DB不存在时不建目录/DB/sidecar；读取返回原对象或新的links骨架。
  const beforeAbsent = snapshot(root)
  assert.equal(legacyBindingsPath(), path.join(home, 'profile-data', 'tavern', 'storages', 'tavern-sqlite-bindings.db'))
  assert.equal(existsSync(home), false)
  assert.deepEqual(listLegacyBindings(), [])
  assert.equal(legacyBindingForChat(chatId), undefined)
  assert.equal(legacyBindingForSession(realId), undefined)
  const absentLinks = { [oldId]: chatId }
  const absentChat = Object.freeze({ id: chatId, sessionId: oldId })
  assert.deepEqual(overlayLegacyLinks(absentLinks), absentLinks)
  assert.equal(projectLegacyEnvelope(absentChat), absentChat)
  assert.equal(legacyArtifactFor(nativeRoot, 'session-missing'), undefined)
  assert.equal(readLegacySession(nativeRoot, 'session-missing', strictFixtureFormat()), undefined)
  assert.deepEqual(snapshot(root), beforeAbsent, '绑定缺失查询绝不能产生任何文件或目录')

  // 2) 显式配置只写本测试的插件bindings DB；真实SID/path正确，错旧SID不是artifact别名。
  const binding = setLegacyBinding({ chatId, sessionId: realId, originalSessionId: oldId, artifactPath: parkedPath })
  assert.deepEqual(binding, { chatId, sessionId: realId, originalSessionId: oldId, artifactPath: parkedPath })
  assert.deepEqual(legacyBindingForChat(chatId), binding)
  assert.deepEqual(legacyBindingForSession(realId), binding)
  assert.deepEqual(legacyBindingForSession(oldId), binding, '配置可诊断旧身份，但artifact读取不能把它当真实别名')
  assert.deepEqual(listLegacyBindings(), [binding])
  assert.deepEqual(legacyArtifactFor(nativeRoot, realId), { path: parkedPath, version: 3, compressed: true })
  assert.equal(legacyArtifactFor(nativeRoot, oldId), undefined, '旧header-only artifact即使仍在也不得当绑定来源')
  assert.equal(readLegacySession(nativeRoot, oldId, strictFixtureFormat()), undefined)
  assert.deepEqual(legacyArtifactFor(nativeRoot, naturalId), { path: naturalPath, version: 3, compressed: false })
  for (const [name, bytes] of Object.entries(beforeAbsent.files)) {
    assert.deepEqual(readFileSync(path.join(root, name)), bytes, '显式配置绑定也不能修改原件：' + name)
  }
  const configured = snapshot(root)

  // 3) links/envelope只是读投影，不改原链接、chat、消息、revision或包装字段。
  const links = Object.freeze({ [oldId]: chatId, 'session-obsolete-alias': chatId, 'session-other': 'chat-other' })
  const projectedLinks = overlayLegacyLinks(links)
  assert.deepEqual(projectedLinks, { 'session-other': 'chat-other', [realId]: chatId })
  assert.deepEqual(links, { [oldId]: chatId, 'session-obsolete-alias': chatId, 'session-other': 'chat-other' })
  const messages = Object.freeze([{ role: 'user', message: '原档显示正文' }])
  const rawChat = Object.freeze({ id: chatId, sessionId: oldId, _storageRevision: 467, messages })
  const projection = projectLegacyEnvelope(rawChat)
  assert.notEqual(projection, rawChat)
  assert.deepEqual(projection, { ...rawChat, sessionId: realId })
  assert.equal(rawChat.sessionId, oldId)
  assert.equal(projection.messages, messages)
  assert.equal(projectLegacyEnvelope(projection), projection, '正确身份无需再创建投影')
  const envelope = Object.freeze({ chat: rawChat, indices: Object.freeze([0]), messageCount: 1, revision: 467 })
  const projectedEnvelope = projectLegacyEnvelope(envelope)
  assert.notEqual(projectedEnvelope, envelope)
  assert.equal(envelope.chat, rawChat)
  assert.equal(projectedEnvelope.chat.sessionId, realId)
  assert.equal(projectedEnvelope.indices, envelope.indices)
  assert.equal(projectedEnvelope.revision, 467)
  const unrelated = Object.freeze({ id: 'chat-other', sessionId: 'session-other' })
  assert.equal(projectLegacyEnvelope(unrelated), unrelated)
  assert.equal(projectLegacyEnvelope(undefined), undefined)
  assert.equal(projectLegacyEnvelope(null), null)

  // 4) 多帧原件的header/events/seq/sourceEventSeqs/inherited值原样保留，只用strict/current恢复。
  const format = strictFixtureFormat(2)
  const stored = readLegacySession(nativeRoot, realId, format)
  assert.equal(stored.status, 'current')
  assert.deepEqual(stored.meta, header)
  assert.deepEqual(stored.events, events)
  assert.deepEqual(stored.events.map(event => event.seq), [0, 1, 2, 3])
  assert.deepEqual(stored.events[2].sourceEventSeqs, [1])
  assert.equal(stored.inheritedEventCount, 2)
  assert.equal(stored.eventState, 'detached')
  assert.equal(stored.tornTruncateTo, undefined)
  assert.equal(stored.recoveredTail, undefined)
  assert.equal(stored.sizeBytes, readFileSync(parkedPath).length)
  assert.ok(stored.revision.startsWith('legacy:' + parkedPath + ':'))
  assert.equal(format.calls.length, 1)
  assert.deepEqual(format.calls[0].header, header)
  assert.deepEqual(format.calls[0].rows, events)
  assert.equal(format.calls[0].finishes, 1)
  assert.equal(readLegacySession(nativeRoot, naturalId, strictFixtureFormat(0)).meta.id, naturalId)
  assert.deepEqual(snapshot(root), configured, '绑定查询/投影/原件读取不得改DB、日志或目录清单')

  // 4.5) header-only 观测：stat 只读首行/首个 zstd 帧，**只构造官方 restore 并取其构造期 header**，
  //      零 decodeRow、零 finish（不读正文、不合成事件数组）；与全读共用同一 revision/size。
  //      行数≠事件数（旧代次升级 one-to-many）故不假造 eventCount。
  //      mock 只证明「请求到的 options 是 strict/current」与「没有正文调用」，
  //      不证明真实 Host 的执行策略（现场真实 generationFormat 会忽略第 2 个参数）。
  const statSnapshotBefore = snapshot(root)
  const statFormat = strictFixtureFormat()
  const observed = statLegacySession(nativeRoot, realId, statFormat)
  assert.equal(observed.status, 'current')
  assert.deepEqual(observed.meta, header)
  assert.equal(observed.revision, stored.revision, 'header-only 与全读必须给出逐字相同的 revision')
  assert.equal(observed.sizeBytes, stored.sizeBytes)
  assert.equal(Object.hasOwn(observed, 'eventCount'), false, '不得假造 eventCount')
  assert.equal(statFormat.calls.length, 1)
  assert.deepEqual(statFormat.calls[0].options, { recovery: 'strict', validation: 'current' }, '只证明请求参数')
  assert.deepEqual(statFormat.calls[0].rows, [], 'header-only 不得 decodeRow')
  assert.equal(statFormat.calls[0].finishes, 0, 'header-only 不得 finish')
  assert.equal(statLegacySession(nativeRoot, oldId, strictFixtureFormat()), undefined, '旧 header-only 身份不得当别名')
  // 单一路径：未暴露官方 createRestore 时响亮拒绝（不留 readHeader 分支、不留兜底）。
  assert.throws(() => statLegacySession(nativeRoot, realId, {}), /createRestore/)
  assert.deepEqual(snapshot(root), statSnapshotBefore, 'header-only 观测不得改原件字节或目录')

  // 5) 原档句柄只提供detached slice；append/flush立即拒写，范围/取消/关闭契约明确。
  const storedBefore = structuredClone(stored)
  const handle = createLegacyReadHandle(stored)
  assert.equal(handle.id, realId)
  assert.equal(handle.header, stored.meta)
  assert.equal(handle.access, 'read')
  assert.equal(handle.inheritedEventCount, 2)
  const all = await handle.read()
  assert.deepEqual(all, { eventState: 'detached', events })
  assert.notEqual(all.events, stored.events)
  assert.deepEqual(await handle.read(1, 2), { eventState: 'detached', events: events.slice(1, 3) })
  assert.deepEqual(await handle.read(0, 0), { eventState: 'detached', events: [] })
  assert.deepEqual(await handle.read(events.length, 1), { eventState: 'detached', events: [] })
  all.events.pop()
  assert.equal(stored.events.length, events.length, 'slice数组操作不能改变存储事件数组')
  for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, Infinity], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    await assert.rejects(() => handle.read(offset, length), /非负安全整数/)
  }
  const readonly = error => error?.code === 'DSH_TAVERN_LEGACY_READ_ONLY' && /显式分叉迁移/.test(error.message)
  assert.throws(() => handle.append([{ seq: 4 }]), readonly)
  assert.throws(() => handle.flush(), readonly)
  const aborted = new AbortController()
  aborted.abort(new Error('契约测试取消'))
  assert.throws(() => createLegacyReadHandle(stored, aborted.signal), /契约测试取消/)
  await assert.rejects(() => handle.read(0, 1, { signal: aborted.signal }), /契约测试取消/)
  await handle.close()
  await handle.close()
  await assert.rejects(() => handle.read(), /已关闭/)
  assert.throws(() => handle.append([]), readonly)
  assert.throws(() => handle.flush(), readonly)
  const disposed = createLegacyReadHandle(stored)
  await disposed[Symbol.asyncDispose]()
  await assert.rejects(() => disposed.read(), /已关闭/)
  assert.deepEqual(stored, storedBefore)
  assert.deepEqual(snapshot(root), configured, '句柄全部读/拒写/释放后原件与插件DB字节不变')

  // 6) 身份不匹配、seq不连续、strict模拟拒绝、坏压缩尾都fail-closed，不恢复/迁移/重写源。
  const invalidRoot = path.join(root, 'invalid-native-root')
  const mismatchId = 'session-mismatch'
  const gapId = 'session-gap'
  const invalidId = 'session-invalid-row'
  const tailId = 'session-bad-tail'
  const fixturePath = id => path.join(invalidRoot, 'fixture-project', id, 'session.v3.jsonl')
  writeArtifact(fixturePath(mismatchId), { id: 'session-different', version: 3 }, events)
  writeArtifact(fixturePath(gapId), { id: gapId, version: 3 }, [{ seq: 0 }, { seq: 2 }])
  writeArtifact(fixturePath(invalidId), { id: invalidId, version: 3 }, [{ seq: 0, fixtureInvalid: true }])
  const badTail = fixturePath(tailId) + '.zstd'
  writeArtifact(badTail, { id: tailId, version: 3 }, events, true)
  writeFileSync(badTail, Buffer.concat([readFileSync(badTail), Buffer.from('坏尾部', 'utf8')]))
  // header-only 观测不看正文：seq 断层、坏事件行、坏压缩尾（都在 header 帧之后）都不再阻断 stat；
  // 身份不符仍 fail-closed 且不构造 restore。全读路径照旧走原有官方完整恢复校验（下方 assertion）。
  const gapStat = strictFixtureFormat(0)
  assert.equal(statLegacySession(invalidRoot, gapId, gapStat).meta.id, gapId)
  assert.deepEqual(gapStat.calls[0].rows, [], '正文（seq 断层在正文里）不得被 decodeRow')
  const invalidStat = strictFixtureFormat(0)
  assert.equal(statLegacySession(invalidRoot, invalidId, invalidStat).meta.id, invalidId, '坏事件行不得阻断 header-only 观测')
  assert.deepEqual(invalidStat.calls[0].rows, [], '坏事件行不得进入 decodeRow（否则本 fixture 会抛）')
  const tailStat = strictFixtureFormat(0)
  assert.equal(statLegacySession(invalidRoot, tailId, tailStat).meta.id, tailId, '坏压缩尾在首个 header 帧之外，header-only 不读它')
  const mismatchStat = strictFixtureFormat(0)
  assert.throws(() => statLegacySession(invalidRoot, mismatchId, mismatchStat), /identity mismatch/)
  assert.equal(mismatchStat.calls.length, 0, '身份不符应先拒绝，不构造 restore')
  const beforeFailures = snapshot(root)
  const mismatchFormat = strictFixtureFormat()
  assert.throws(() => readLegacySession(invalidRoot, mismatchId, mismatchFormat), /identity mismatch/)
  assert.equal(mismatchFormat.calls.length, 0, '身份不符应先拒绝，不交给恢复器')
  assert.throws(() => readLegacySession(invalidRoot, gapId, strictFixtureFormat()), /seq discontinuity/)
  assert.throws(() => readLegacySession(invalidRoot, invalidId, strictFixtureFormat()), /模拟strict恢复拒绝/)
  assert.throws(() => readLegacySession(invalidRoot, tailId, strictFixtureFormat()))
  assert.deepEqual(snapshot(root), beforeFailures, '失败路径不得生成恢复文件或改原件字节')
  assert.equal(existsSync(legacyBindingsPath() + '-wal'), false)
  assert.equal(existsSync(legacyBindingsPath() + '-shm'), false)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // 只清本测试独占的mkdtemp子树；先列出自己的清单，不碰共享TEMP其它文件。
  snapshot(root)
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

console.log('legacy-session-reader：绑定缺失零副作用、真实SID选择/旧SID不别名、投影不改原对象、请求参数模拟契约（不证真实主机策略）、header-only观测只构造restore取header、原件字节完整、句柄只读通过（非真Session/UI验收）')
