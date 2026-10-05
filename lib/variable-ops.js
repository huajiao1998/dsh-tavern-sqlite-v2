// 变量查看（B 第二阶段）—— host 侧操作
//
// 「一个操作，两个调用者」：本文件是 UI（/tavern-vars 命令 → 面板）与 agent 工具共用的那一份**读取逻辑**。
// 真正的查询引擎是我们自己的 lib/read-variables.js（纯函数 + JSON Pointer 游标分页 + 防漂移 revision +
// 4000B/50 项预算；stat_data 快照按消息倒序取最近一份）。
//
// 与既有 agent 工具 `tavern_read_variables` 的关系：那个工具在作者侧接线，**调用的是同一个纯函数** ⇒
// 不重复实现（这里的 queryVariables 只是把"取 chat"这一步补上）。
//
// 依赖由调用方注入：chats = 酒馆聊天存储接口（read(chatId) 返回存档文档）。
import { readVariables } from './read-variables.js'

/** 允许的动作（与 read-variables 保持一致）。 */
export const VARIABLE_ACTIONS = ['list', 'read', 'search']

/**
 * 读当前游玩会话的变量。
 * @param chats - 需实现 read(chatId) → chat 文档（含 mode/messages/settleStatus/_storageRevision）
 * @param chatId - 会话/聊天 id（酒馆里二者一致）
 * @param args - { action?, path?, query?, cursor?, limit? }
 */
export async function queryVariables({ chats, chatId, args = {} }) {
  if (!chats || typeof chats.read !== 'function') throw new Error('queryVariables：缺少 chats.read（酒馆聊天存储接口未接入）')
  if (typeof chatId !== 'string' || chatId === '') throw new Error('queryVariables：缺少 chatId')
  const chat = await chats.read(chatId)
  if (!chat) throw new Error('当前会话没有可读的游玩存档')
  return readVariables(chat, args)
}

/** 把命令行的 `action 参数…` 解析成 readVariables 的 args（UI 与工具共用同一解析）。 */
export function parseVariableArgs(rawInput) {
  const text = String(rawInput ?? '').trim()
  const tokens = text === '' ? [] : text.split(/\s+/u)
  const action = tokens[0] && VARIABLE_ACTIONS.includes(tokens[0]) ? tokens.shift() : 'list'
  const args = { action }
  if (action === 'search') args.query = tokens.shift() || ''
  else if (action === 'read') args.path = tokens.shift() || ''
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '--limit' && tokens[index + 1] !== undefined) { args.limit = Number(tokens[index + 1]); index += 1 }
    else if (tokens[index] === '--cursor' && tokens[index + 1] !== undefined) { args.cursor = tokens[index + 1]; index += 1 }
  }
  return args
}

/** 结果 → 一行摘要（UI 与工具共用文案）。 */
export function formatVariableResult(result) {
  if (!result || result.available === false) return '当前会话尚无已保存的变量快照（结算状态 ' + String(result?.settlement ?? 'idle') + '）'
  const head = '变量 ' + String(result.action) + (result.path ? ' ' + String(result.path) : '') + '：turn=' + String(result.turn) + ' 结算=' + String(result.settlement)
  if (result.found === false) return head + '（路径不存在）'
  if (result.value !== undefined) return head + ' = ' + JSON.stringify(result.value).slice(0, 400)
  const count = Array.isArray(result.entries) ? result.entries.length : 0
  return head + '，' + String(count) + ' 项' + (result.truncated ? '（还有更多，nextCursor 非空）' : '')
}