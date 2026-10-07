// 原菜单DB-only交换：先验证，后建全新SQL目标；不运行外来SQL，不修改源档。
import { mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotDatabase, watchDbSaveSources, inspectDatabase, restoreDatabase, encodeDbSave, decodeDbSave, DB_SAVE_FORMAT, DB_SAVE_VERSION } from './db-save-codec.js'
import { ownedSaveSessions, saveIdentityMap, rewriteSaveTables, saveId } from './db-save-identities.js'
import { rowToEvent } from '../store.js'
export { createDbSaveRegistration } from './db-save-registration.js'
export { createDbSaveResourceTransfer } from './db-save-resource-transfer.js'

function withDirectory(work) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-tavern-db-save-'))
  return Promise.resolve().then(() => work(dir)).finally(() => {
    // 只清本函数独占创建的一层，外来包路径永不参与清理路径。
    const files = readdirSync(dir)
    for (const name of files) {
      if (!/^(chat|native-\d+)\.db(?:-wal|-shm)?$/.test(name)) throw Error('DB交换临时目录含未知文件，拒绝扩大清理')
      rmSync(path.join(dir, name), { force: true })
    }
    rmdirSync(dir)
  })
}
function assertIdleChat(chat) {
  ownedSaveSessions(chat)
  if (chat.settleStatus && !['done', 'failed'].includes(chat.settleStatus)) throw Error('本局结算尚未静止')
}
function nativeStored(tables) {
  const row = tables.sessions[0]
  return { header: JSON.parse(row.header_json), formatVersion: row.format_version, eventCount: row.event_count, inheritedEventCount: row.inherited_event_count, events: tables.events.map(rowToEvent) }
}
function validateBoundaries(chat, native) {
  const counts = new Map(native.map(item => [item.id, item.tables.events.length]))
  const check = (id, seq) => {
    if (!counts.has(id) || !Number.isSafeInteger(seq) || seq < -1 || seq >= counts.get(id)) throw Error('DB存档回退原生边界超出本局事件范围')
  }
  for (const cuts of Object.values(chat.rollbackSessionCuts || {})) for (const [id, seq] of Object.entries(cuts || {})) check(id, seq)
  for (const participant of Object.values(chat.timeline?.participants || {})) {
    if (participant.sessionId && participant.boundary != null) check(participant.sessionId, participant.boundary)
  }
  for (const checkpoint of chat.timeline?.checkpoints || []) {
    for (const [id, seq] of Object.entries(checkpoint.sessionCuts || {})) check(id, seq)
    for (const participant of Object.values(checkpoint.participants || {})) if (participant.sessionId && participant.boundary != null) check(participant.sessionId, participant.boundary)
  }
}
export function createDbSaveExchange(deps) {
  const { chatStore, chatForSession, readChat, persistence, sessions, agents, assertForkable, ownsSession, publish, unpublish, attach, detach, dataRoot } = deps
  const importing = new Set(), resources = deps.resources
  for (const name of ['capture', 'validate', 'install']) if (typeof resources?.[name] !== 'function') throw Error('DB交换缺少本局资源接线：' + name)
  for (const [name, fn] of Object.entries({ chatForSession, readChat, persistence, assertForkable, ownsSession, publish, unpublish, attach, detach })) if (typeof fn !== 'function') throw Error('DB交换缺少宿主接线：' + name)
  function backend() {
    const value = persistence()
    for (const name of ['dbSaveSessionPath', 'dbSaveDrain', 'dbSaveValidate', 'dbSaveInstall', 'dbSaveRemove', 'dbSaveFinish']) if (typeof value?.[name] !== 'function') throw Error('DB交换原生SQL后端尚未接齐：' + name)
    return value
  }
  async function exportGameSave(sessionId, options = {}) {
    saveId(sessionId)
    const header = await chatForSession(sessionId)
    if (!header) throw Error('当前Session没有绑定Tavern对话')
    if (typeof chatStore.dbSaveArchivePath !== 'function') throw Error('DB导出缺少Chat原件优先校验接线')
    const source = chatStore.dbSaveArchivePath(header.id)
    const chat = await readChat(header.id)
    if (chat?.sessionId !== sessionId) throw Error('DB存档Chat/Session绑定不一致')
    assertIdleChat(chat)
    assertForkable(chat, { agentRunning: agents.get(sessionId)?.phase?.kind === 'running' })
    const ids = ownedSaveSessions(chat), store = backend()
    if (typeof deps.whenIdle !== 'function') throw Error('DB导出缺少本局任务静止接线')
    await deps.whenIdle(chat)
    for (const id of ids) {
      if (id !== sessionId && !await ownsSession(chat, id)) throw Error('DB存档后台会话未确认为本局专属')
      if (agents.get(id)?.phase?.kind === 'running') throw Error('本局原生任务仍在运行，不能导出')
      const live = sessions.get(id)
      if (live) await sessions.flush(live)
      await store.dbSaveDrain(id)
    }
    return withDirectory(async dir => {
      if (ids.some(id => agents.get(id)?.phase?.kind === 'running')) throw Error('导出静止条件已变化')
      const sourceFiles = [source, ...ids.map(id => store.dbSaveSessionPath(id))]
      const observer = watchDbSaveSources(sourceFiles)
      try {
      snapshotDatabase(source, path.join(dir, 'chat.db'), 'archive')
      const archive = inspectDatabase(path.join(dir, 'chat.db'), 'archive')
      if (archive.head.id !== chat.id || archive.head.sessionId !== sessionId || archive.head._storageRevision !== chat._storageRevision) throw Error('准备导出期间本局状态已变化，请重试')
      const capturedIds = ownedSaveSessions(archive.head)
      if (JSON.stringify(capturedIds) !== JSON.stringify(ids)) throw Error('导出会话闭包已变化')
      const native = ids.map((id, index) => {
        const file = path.join(dir, 'native-' + index + '.db')
        snapshotDatabase(store.dbSaveSessionPath(id), file, 'native')
        const inspected = inspectDatabase(file, 'native')
        if (inspected.tables.sessions[0].id !== id) throw Error('DB存档原生会话身份不一致')
        const stored = nativeStored(inspected.tables)
        store.dbSaveValidate(stored)
        if (id !== sessionId && stored.header.parentSession !== sessionId) throw Error('后台原生会话父身份不属于本局')
        return { id, tables: inspected.tables, data: readFileSync(file) }
      })
      validateBoundaries(archive.head, native)
      const captured = await resources.capture({ chat: archive.head, tables: archive.tables, nativeEvents: native.map(item => nativeStored(item.tables).events), images: options.images !== false })
      if (!Array.isArray(captured.files) || typeof captured.assertStable !== 'function') throw Error('DB资源捕获缺少稳定窗口凭据')
      // 导出与导入使用同一闭包/卡载荷预检，禁止生成只有导入时才发现缺资源的包。
      await resources.validate({ files: captured.files, chat: archive.head, tables: archive.tables, nativeEvents: native.map(item => nativeStored(item.tables).events) })
      await captured.assertStable()
      const manifest = { format: DB_SAVE_FORMAT, formatVersion: DB_SAVE_VERSION, storage: 'sqlite', exportedAt: Date.now(), source: { chatId: chat.id, sessionId }, sessions: ids, resources: captured.files.map(item => item.path), portable: { cardSnapshot: true, nativeContext: true, rollback: true, sceneImages: options.images !== false, pluginMedia: false } }
      if (ids.some(id => agents.get(id)?.phase?.kind === 'running')) throw Error('DB导出期间本局任务已启动，拒绝发布快照')
      observer.assertStable()
      const buffer = encodeDbSave({ manifest, archive: readFileSync(path.join(dir, 'chat.db')), sessions: native.map(({ id, data }) => ({ id, data })), resources: captured.files })
      const name = String(chat.title || chat.cardName || 'game').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
      return { filename: name + '.db.dshsave', base64: buffer.toString('base64'), bytes: buffer.length, revisions: 1, images: captured.files.filter(item => /^images\//.test(item.path)).length, storage: 'sqlite' }
      } finally { observer.close() }
    })
  }
  async function importGameSave(args) {
    if (typeof args?.fileB64 !== 'string' || !args.fileB64 || args.fileB64.length > 90 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.fileB64)) throw Error('请选择有效的插件DB存档包')
    const save = decodeDbSave(Buffer.from(args.fileB64, 'base64')), sourceId = saveId(save.manifest.source.chatId)
    if (importing.has(sourceId)) throw Error('这份DB存档正在导入，请稍候')
    importing.add(sourceId)
    try {
      return await withDirectory(async dir => {
        // 外来DB仅放本次独占临时路径、只读验证；restoreDatabase不会执行它的schema。
        const file = path.join(dir, 'chat.db'); writeFileSync(file, save.archive, { flag: 'wx' })
        const archive = inspectDatabase(file, 'archive'), chat = archive.head, store = backend()
        if (chat.id !== sourceId || chat.sessionId !== save.manifest.source.sessionId) throw Error('DB包清单与Chat身份不一致')
        const ids = ownedSaveSessions(chat)
        if (ids.length !== save.sessions.length || ids.some(id => !save.sessions.some(item => item.id === id))) throw Error('DB包原生会话不等于本局闭包')
        const native = save.sessions.map((item, index) => {
          const target = path.join(dir, 'native-' + index + '.db'); writeFileSync(target, item.data, { flag: 'wx' })
          const inspected = inspectDatabase(target, 'native')
          if (inspected.tables.sessions[0].id !== item.id) throw Error('DB包原生清单身份不一致')
          const stored = nativeStored(inspected.tables)
          store.dbSaveValidate(stored)
          if (item.id !== chat.sessionId && stored.header.parentSession !== chat.sessionId) throw Error('DB包后台父会话不属于本局')
          return { id: item.id, tables: inspected.tables }
        })
        validateBoundaries(chat, native)
        const resourceBundle = await resources.validate({ files: save.resources, chat, tables: archive.tables, nativeEvents: native.map(item => nativeStored(item.tables).events) })
        const identity = saveIdentityMap(chat, ids)
        if (typeof chatStore.dbSaveNewArchivePath !== 'function') throw Error('DB导入缺少Chat新目标碰撞校验接线')
        const archiveTarget = chatStore.dbSaveNewArchivePath(identity.chatId), cwd = path.join(dataRoot, 'resources')
        const installed = []; let written = false, attached = false, publicationAttempted = false, resourceLease, resourceRollback
        try {
          try { resourceLease = await resources.install(resourceBundle, chat, identity) }
          catch (error) { if (typeof error?.resourceRollback === 'function') resourceRollback = error.resourceRollback; throw error }
          if (typeof resourceLease?.rewriteTables !== 'function' || typeof resourceLease?.rollback !== 'function') throw Error('DB导入资源租约未接齐，拒绝半可玩目标')
          mkdirSync(path.dirname(archiveTarget), { recursive: true })
          restoreDatabase(archiveTarget, 'archive', rewriteSaveTables(resourceLease.rewriteTables(archive.tables), chat, identity, { cwd, cardPath: resourceLease.cardPath }))
          written = true
          for (const item of native) {
            const targetId = identity.sessions.get(item.id)
            store.dbSaveInstall(targetId, rewriteSaveTables(resourceLease.rewriteTables(item.tables), chat, identity, { cwd }), archiveTarget)
            installed.push(targetId)
          }
          attached = true; await attach(identity.sessionId)
          const saved = await readChat(identity.chatId)
          if (saved?.id !== identity.chatId || saved?.sessionId !== identity.sessionId) throw Error('DB导入目标回读身份失败')
          publicationAttempted = true
          await publish(saved)
          store.dbSaveFinish(installed)
          return { chatId: identity.chatId, sessionId: identity.sessionId, cardPath: saved.cardPath, title: saved.title, revisions: 1, images: resourceLease.attachmentMap?.size || 0, storage: 'sqlite' }
        } catch (error) {
          const failures = []
          if (publicationAttempted) try { await unpublish(identity) } catch (cleanup) { failures.push(cleanup) }
          if (attached) try { await detach(identity.sessionId) } catch (cleanup) { failures.push(cleanup) }
          for (const id of installed) try { store.dbSaveRemove(id) } catch (cleanup) { failures.push(cleanup) }
          if (written) try { await chatStore.remove(identity.chatId) } catch (cleanup) { failures.push(cleanup) }
          const rollbackResources = resourceLease?.rollback || resourceRollback
          if (rollbackResources) try { await rollbackResources() } catch (cleanup) { failures.push(cleanup) }
          try { if (existsSync(path.dirname(archiveTarget)) && readdirSync(path.dirname(archiveTarget)).length === 0) rmdirSync(path.dirname(archiveTarget)) } catch (cleanup) { failures.push(cleanup) }
          if (failures.length) throw new AggregateError([error, ...failures], 'DB导入失败且本次新目标清理不完整；源档未修改')
          throw error
        }
      })
    } finally { importing.delete(sourceId) }
  }
  return Object.freeze({ exportGameSave, importGameSave })
}
