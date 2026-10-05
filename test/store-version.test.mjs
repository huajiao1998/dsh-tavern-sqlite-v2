// 回归闸：未迁移的档**两种承载**都要认（2026-09-30 从 145 导入块布局档时踩中）
//
//   ① journal 单文件 `chats/<id>.json`（旧版作者存储）
//   ② 上游 v2.4 起的**内容寻址块布局** `chats/<id>/head.json` + `blocks/**`（上游新档全是这种）
//
// 只认 ① 会把"档存在但未迁移"误判成 `''`（= 没有存档）⇒ 面板显示"找不到本局存档"、
// 迁移按钮出不来。本闸用真文件系统（临时目录）验证两种承载都回 `legacy:` stamp。
//
// 只用 node 内置：node test/store-version.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'

// store 构造要求 8 个注入 helper（由作者树垫片提供）；本闸只测 version()，用空实现即可
const noop = () => undefined
const helpers = Object.fromEntries([
  'copyJsonTree', 'diffJson', 'applyJsonChangesShared',
  'projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState',
  'projectChatBackgroundConfig', 'projectSettlementCheckpoint',
].map(name => [name, noop]))

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-store-version-'))
try {
  const chatsRoot = path.join(root, 'chats')
  mkdirSync(chatsRoot, { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, helpers, legacyData: undefined })

  // 0) 什么都没有 ⇒ 空串（上层据此报"找不到本局存档"）
  assert.equal(await store.version('chat-none'), '', '不存在的档必须回空串')

  // 1) journal 单文件承载
  writeFileSync(path.join(chatsRoot, 'chat-journal.json'), '{"id":"chat-journal"}')
  const journalStamp = await store.version('chat-journal')
  assert.match(journalStamp, /^legacy:\d+:\d+$/, 'journal 单文件必须回 legacy stamp')

  // 2) 上游块布局承载（head.json + blocks/**）
  mkdirSync(path.join(chatsRoot, 'chat-blocky', 'blocks', 'ab'), { recursive: true })
  writeFileSync(path.join(chatsRoot, 'chat-blocky', 'head.json'), '{"format":1,"headId":"ab' + '0'.repeat(62) + '"}')
  writeFileSync(path.join(chatsRoot, 'chat-blocky', 'blocks', 'ab', 'ab' + '0'.repeat(62) + '.json'), '{"kind":"state"}')
  const blockStamp = await store.version('chat-blocky')
  assert.match(blockStamp, /^legacy:\d+:\d+$/, '块布局（head.json）必须回 legacy stamp')

  // 3) 两种承载的 stamp 形状一致（上层判据只认 legacy:/sqlite:gen:）
  assert.equal(journalStamp.split(':')[0], blockStamp.split(':')[0])

  // 4) 非法 id 依旧 fail-loud
  await assert.rejects(() => store.version('../etc/passwd'), /不合法/)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('store-version: 5 组断言全部通过')
