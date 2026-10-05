// 回归闸：§4.1「未迁移档可看不可玩」——开始轮次前必须被拦住
//
// 依据 issues/def-migration-vs-fork.md §4.1/§4.2（2026-09-30 定稿）：
//   原档「可看不可玩」；发送/开始轮次必须失败；用户显式创建新 ID SQLite 分叉后才能继续。
//   拦截点判据：必须在 turn/start 落库**之前**（写层拦会留半状态）。
//
// 只用 node 内置：node test/unmigrated-guard.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPlayable, chatIdForSession, isChatMigrated } from '../lib/tavern-chat-state.js'

const home = mkdtempSync(path.join(os.tmpdir(), 'tavern-guard-home-'))
const dataRoot = path.join(home, 'profile-data', 'tavern', 'data')
const previousHome = process.env.DSH_HOME
try {
  // 造一个假 DSH_HOME + profile 清单（dataRoot 走清单，和真机一致）
  mkdirSync(path.join(home, 'profiles', 'tavern'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'tavern', 'package.json'), JSON.stringify({ name: 'dsh-profile-tavern', dshTavern: { dataRoot } }))
  mkdirSync(path.join(dataRoot, 'chats'), { recursive: true })
  process.env.DSH_HOME = home

  // 链接表：三个会话
  writeFileSync(path.join(dataRoot, 'sessions.json'), JSON.stringify({
    'session-legacy': 'chat-legacy',      // 未迁移（只有块布局原档）
    'session-migrated': 'chat-migrated',  // 已迁移（archive.db 在位）
    'session-missing': 'chat-missing',    // 档不存在
  }))

  // chat-legacy：块布局原档，无 archive.db
  mkdirSync(path.join(dataRoot, 'chats', 'chat-legacy', 'blocks', 'ab'), { recursive: true })
  writeFileSync(path.join(dataRoot, 'chats', 'chat-legacy', 'head.json'), '{"format":1,"headId":"ab0"}')
  // chat-migrated：有 archive.db
  mkdirSync(path.join(dataRoot, 'chats', 'chat-migrated'), { recursive: true })
  writeFileSync(path.join(dataRoot, 'chats', 'chat-migrated', 'archive.db'), '')

  // 1) 链接表查询（不该再靠扫档）
  assert.equal(chatIdForSession('session-legacy'), 'chat-legacy')
  assert.equal(chatIdForSession('session-unknown'), '')
  assert.equal(isChatMigrated('chat-migrated'), true)
  assert.equal(isChatMigrated('chat-legacy'), false)

  // 2) ★未迁移档：开始轮次必须失败，且文案指向迁移按钮
  assert.throws(() => assertPlayable('session-legacy'), /只读原存档.*分叉迁移到数据库存档/s)

  // 3) 已迁移档：放行
  assert.doesNotThrow(() => assertPlayable('session-migrated'))

  // 4) 不是酒馆会话（链接表里没有）：放行（不许拦别家的会话）
  assert.doesNotThrow(() => assertPlayable('session-unknown'))

  // 5) 链接表里有、但档根本不存在：放行（交给上层自己报"找不到档"）
  assert.doesNotThrow(() => assertPlayable('session-missing'))

  // 6) 同ID影子库不能绕过只读原存档，不得假报已迁移。
  writeFileSync(path.join(dataRoot, 'chats', 'chat-legacy', 'archive.db'), '')
  assert.equal(isChatMigrated('chat-legacy'), false)
  assert.throws(() => assertPlayable('session-legacy'), /只读原存档/)
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

console.log('unmigrated-guard: 6 组断言全部通过（未迁移档开始轮次被拦 / 已迁移放行 / 非酒馆会话不拦）')
