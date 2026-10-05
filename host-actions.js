// host 侧命令入口（存档格式 + 变量查看）—— 官方「一个操作，两个调用者」：本文件只做**接线**，
// 逻辑分别在 lib/migration-ops.js 与 lib/variable-ops.js；两条命令的逻辑与 agent 工具**共用同一份实现**
//（变量那条：作者侧的 `tavern_read_variables` 工具调用的就是同一个纯函数 readVariables）。
//
// 数据库会话可使用宿主命令；原档 UI 使用作者直接 RPC，不进入 command/run → command/done。
//
// 依赖：酒馆的聊天存储接口（chats）目前**不是**服务 ⇒ 需要一行缝：
//   index.js 里 `ctx.provide('tavernChats', chatPersistence)`（见 deploy/expose-chats.seam.md）。
//   拿不到就**响亮报错**（不静默假装成功）。
// 原档UI只走直接RPC；命令只供数据库会话使用（宿主会写command生命周期）。
import { chatIdForSession, assertLegacySessionWritable } from './lib/tavern-chat-state.js'

/** 取当前会话 id（拿不到就返回空串，由调用方响亮报错）。
 *  ⚠ 路径按作者宿主侧实测对齐：`invocation.agent.session.id`
 *  （tavern-plugin/lib/index.js:261 的 `/ejs` 命令就是这么读的）；
 *  2026-09-30 之前我们读 `invocation.agent.id` —— 那条路径拿不到会话 id。 */
function sessionIdOf(invocation) {
  const agent = invocation?.agent
  const id = agent?.session?.id ?? agent?.sessionId ?? invocation?.sessionId ?? (typeof agent === 'string' ? agent : '')
  return id === undefined || id === null ? '' : String(id)
}

/** 取酒馆聊天存储接口（缺缝时返回 undefined）。 */
function chatsOf(ctx) {
  return ctx.get('tavernChats')
}

/** 酒馆数据根：见 lib/tavern-chat-state.js（profile 清单的 dshTavern.dataRoot 优先）。 */

/** 精确 Session → Chat 映射：插件绑定优先，其次作者 links；禁止遍历存档正文反查。 */
async function resolveChatId({ chats, invocation }) {
  const sessionId = sessionIdOf(invocation)
  if (sessionId === '') throw new Error(MISSING_SESSION)
  const linked = chatIdForSession(sessionId)
  if (linked !== '') return linked
  throw new Error('找不到会话 ' + sessionId + ' 的明确存档绑定；禁止扫描原档正文反查')
}

const MISSING_CHATS = '酒馆聊天存储接口未接入（缺少 ctx.get("tavernChats")）—— 请先应用 expose-chats 缝'
const MISSING_SESSION = '拿不到当前会话 id，无法定位本局存档/变量'

/** 本局的酒馆档 id：命令尾部的显式 `chat-<id>` 优先（排障/脚本用），否则反查会话→档。 */
async function chatIdFor({ chats, invocation }) {
  const explicit = /(?:^|\s)(chat-[A-Za-z0-9_-]+)/.exec(String(invocation?.rawInput || ''))
  if (explicit) return explicit[1]
  return await resolveChatId({ chats, invocation })
}

// ⚠ **必须声明 inject**（2026-09-30 实测踩中）：没有它，cordis 不等 `commands` 服务就位，
//   `ctx.get('commands')` 可能拿到 undefined ⇒ 静默 return ⇒ **命令根本没注册** ⇒
//   客户端 `/tavern-save status` 解析不到 ⇒ 宿主内部报错 ⇒ 面板显示「命令未解析 + gateway/internal」。
//   （对照：host-patch.js 一直有 `export const inject`，所以它从未出这个问题。）
export const inject = ['commands']

export function apply(ctx) {
  const say = message => { try { console.warn('[TAVERN-HOST-ACTIONS] ' + message) } catch { /* 忽略 */ } }
  const commands = ctx.get('commands')
  say('apply 开始 commands=' + (commands ? '有' : '无'))
  if (!commands || typeof commands.register !== 'function') {
    try { ctx.logger?.warn?.('[dsh-tavern-sqlite-v2] 缺少 commands 服务，命令未注册') } catch { /* 忽略 */ }
    say('缺少 commands 服务 ⇒ 命令未注册（这就是面板"命令未解析"的原因）')
    return
  }
  const disposers = []

  disposers.push(commands.register({
    name: 'tavern-save',
    description: '数据库会话存档状态；原档请使用只读面板，另存必须显式原生分叉',
    input: { hint: 'status | migrate [chat-<档 id>]' },
    handler: async invocation => {
      try {
        assertLegacySessionWritable(sessionIdOf(invocation))
        const { runSaveAction, formatSaveResult } = await import('./lib/migration-ops.js')
        const chats = chatsOf(ctx)
        if (!chats) return { kind: 'error', text: MISSING_CHATS }
        const chatId = await chatIdFor({ chats, invocation })
        const result = await runSaveAction({ chats, chatId, action: String(invocation?.rawInput ?? 'status').trim().split(/\s+/)[0] || 'status' })
        return { kind: 'success', text: formatSaveResult(result) }
      } catch (error) {
        return { kind: 'error', text: '存档命令失败：' + String(error?.message || error) }
      }
    },
  }))

  disposers.push(commands.register({
    name: 'tavern-vars',
    description: '变量查看（只读）：list 列顶层；read <path> 读某路径；search <query> 按路径搜索；可选 --limit n / --cursor c',
    input: { hint: 'list | read <path> | search <query> [--limit n] [chat-<档 id>]' },
    handler: async invocation => {
      try {
        assertLegacySessionWritable(sessionIdOf(invocation))
        const { queryVariables, parseVariableArgs, formatVariableResult } = await import('./lib/variable-ops.js')
        const chats = chatsOf(ctx)
        if (!chats) return { kind: 'error', text: MISSING_CHATS }
        const chatId = await chatIdFor({ chats, invocation })
        const result = await queryVariables({ chats, chatId, args: parseVariableArgs(invocation?.rawInput) })
        // 第一行人读摘要；`---` 之后是完整 JSON（面板按这个分隔符解析，避免二次格式化分叉）
        return { kind: 'success', text: formatVariableResult(result) + '\n---\n' + JSON.stringify(result) }
      } catch (error) {
        return { kind: 'error', text: '变量查询失败：' + String(error?.message || error) }
      }
    },
  }))

  ctx.effect(() => () => { for (const dispose of disposers) { try { dispose?.() } catch { /* 已释放 */ } } },
    'dsh-tavern-sqlite-v2: unregister commands')
  // 注册结果写进日志（console.warn 保证可见）：面板报"命令未解析"时，先看这行
  say('已注册命令 ' + disposers.length + ' 条: ' + disposers.map(d => typeof d).join('/'))
}