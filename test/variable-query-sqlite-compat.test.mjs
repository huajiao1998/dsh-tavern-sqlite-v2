// 仅本次兼容闸：真实SQLite/K4 → 现有同字节变量查询器 → 工具execute；不读真实档/不启动作者。
// 存储helpers为原创最小契约夹具；不冒认完整作者Loader/浏览器页面验收。
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, rmdirSync, existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { readVariables, registerVariableReadTool } from '../lib/read-variables.js'
const clone = value => value === undefined ? undefined : structuredClone(value)
const helpers = {
  copyJsonTree: clone,
  diffJson: (_before, after) => [{ op: 'set', path: [], value: after }],
  applyJsonChangesShared: (_before, changes) => clone(changes[0].value),
  projectSceneImageState: clone, projectChatSessionState: clone,
  projectDisplayRuntimeState: clone, projectChatBackgroundConfig: clone,
  projectSettlementCheckpoint: clone,
}
const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-variable-query-owned-'))
const chatId = 'chat-query-compat', sessionId = 'session-query-compat'
const tree = value => ({ stat_data: { 好感度: value, 资产: { 现金: value * 10 }, 任务: '寻找线索' }, schema: {} })
const messages = Array.from({ length: 7 }, (_, turn) => ({
  role: 'assistant', turn, swipeId: 0, text: '正文-' + turn, swipes: ['正文-' + turn], variables: [tree(turn)],
}))
// 最新楼选中第二个swipe；其后普通用户楼和helper楼不能遮住真正的游玩变量快照。
messages[6].swipes.push('另一个回复'); messages[6].variables.push(tree(60)); messages[6].swipeId = 1
messages.push({ role: 'user', text: '继续', turn: 7 })
messages.push({ role: 'tavern-helper', variables: [tree(999)], swipeId: 0, text: '辅助楼' })
let store = createChatSqliteStore({ dataRoot: root, helpers })
let probe
try {
  await store.update(chatId, () => ({ id: chatId, sessionId, mode: 'story', _storageRevision: 1, messages, settleStatus: 'running' }))
  probe = new DatabaseSync(path.join(root, 'chats', chatId, 'archive.db'))
  assert.equal(Object.hasOwn(JSON.parse(probe.prepare('SELECT message_json FROM archive_messages WHERE message_index=1').get().message_json), 'variables'), false, '必须真有被K4剪去的楼，不能只测热行')
  store.dispose(); store = createChatSqliteStore({ dataRoot: root, helpers })
  let tool
  registerVariableReadTool({ tools: { register: value => { tool = value } }, defineTool: value => value,
    chatForSession: async id => { assert.equal(id, sessionId); return store.read(chatId) },
  })
  assert.equal(tool.name, 'tavern_read_variables')
  const execute = async args => (await tool.execute(args, { agent: { session: { id: sessionId } } })).report
  const latest = await execute({ action: 'read', path: '/好感度' })
  assert.equal(latest.available, true); assert.equal(latest.value, 60); assert.equal(latest.turn, 6)
  assert.equal(latest.settlement, 'running', '不能把上轮已保存值伪称后台本轮已结算')
  const list = await execute({ action: 'list', limit: 1 })
  assert.equal(list.entries.length, 1); assert.ok(list.nextCursor)
  const next = await execute({ action: 'list', limit: 1, cursor: list.nextCursor })
  assert.notEqual(next.entries[0].path, list.entries[0].path)
  const search = await execute({ action: 'search', query: '现金' })
  assert.ok(search.entries.some(item => item.path === '/资产/现金'))
  // SQLite物理尾删之后冷读必须看到幸存快照，旧分页游标失效；不是仍读已删楼/文件副本。
  await store.update(chatId, current => ({ ...current, _storageRevision: current._storageRevision + 1, messages: current.messages.slice(0, 2), settleStatus: 'idle' }))
  store.dispose(); store = createChatSqliteStore({ dataRoot: root, helpers })
  const rolled = await execute({ action: 'read', path: '/好感度' })
  assert.equal(rolled.value, 1); assert.equal(rolled.turn, 1)
  assert.equal(readVariables(await store.read(chatId), { action: 'read', path: '/资产/现金' }).value, 10)
  await assert.rejects(() => execute({ action: 'list', limit: 1, cursor: list.nextCursor }), /变量已变化/)
  assert.equal(probe.prepare('SELECT COUNT(*) AS n FROM variable_snapshots WHERE message_index >= 2').get().n, 0)
  console.log('variable-query-sqlite-compat: 冷库/K4/选中swipe/前台工具execute/分页搜索/尾删后查询全部通过')
  // 可选冻结B指纹真检索件：并非从目录名推断版本，不存在时只跳这一扩展。
  const recallFile = fileURLToPath(new URL('../../../tools/live-plugin-src/lib/domain/history-recall.js', import.meta.url))
  if (existsSync(recallFile)) {
    const bytes = readFileSync(recallFile)
    assert.equal(createHash('md5').update(bytes).digest('hex'), '002b13865e7df2698c61b5be3f28ecb0', '检索件必须与冻结B审计指纹一致')
    const { createHistoryRecall } = await import(new URL('../../../tools/live-plugin-src/lib/domain/history-recall.js', import.meta.url))
    const recall = createHistoryRecall()
    assert.equal(recall.recall({ chat: await store.read(chatId), turn: 6, radius: 0 }).found, false, '物理删掉的正文不得重现')
    const kept = recall.recall({ chat: await store.read(chatId), query: '正文-1' })
    assert.equal(kept.found, true)
    const varBefore = probe.prepare('SELECT tree_json FROM variable_state WHERE id=1').get().tree_json
    // B入口的同款mutation链：查询当前态+仅写召回冷却，不读旧revision。
    let recalled
    await store.update(chatId, current => {
      recalled = recall.recall({ chat: current, turn: 1, radius: 0, trackCooldown: true, audience: 'foreground' })
      return { ...current, _storageRevision: current._storageRevision + 1 }
    })
    assert.equal(recalled.found, true); assert.equal(recalled.rounds[0].turn, 1)
    store.dispose(); store = createChatSqliteStore({ dataRoot: root, helpers })
    const cold = await store.read(chatId)
    assert.equal(cold.historyRecallCooldowns[0].turn, 1)
    const cooled = createHistoryRecall().recall({ chat: cold, turn: 1, radius: 0, trackCooldown: true, audience: 'foreground' })
    assert.equal(cooled.rounds.length, 0); assert.match(cooled.notice, /冷却/)
    assert.equal(probe.prepare('SELECT tree_json FROM variable_state WHERE id=1').get().tree_json, varBefore)
    assert.equal((await execute({ action: 'read', path: '/好感度' })).value, 1)
    console.log('history-recall-sqlite-compat: 冻结B真检索件读取SQLite/删除正文不重现/冷却持久化/变量不变通过')
  } else console.log('history-recall-sqlite-compat: 缺冻结代码夹具，仅此扩展未执行')
} finally {
  probe?.close(); store.dispose()
  // 仅清此测试自己创建的唯一目录，先枚举实际精确文件，再逐项删除。
  function cleanOwn(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) cleanOwn(file)
      else rmSync(file)
    }
    rmdirSync(dir)
  }
  cleanOwn(root)
}
