#!/usr/bin/env node
// dsh-tavern-sqlite-v2 · 施缝 / 卸缝工具（幂等 · 备份 · 语法校验 · 失败回滚）
//
// 为什么需要它：本包装完（`dsh plugin --profile tavern add <tgz>`）只是把**装配层**接上，
// 但**聊天存档**不在服务槽里 —— 必须往作者树打两条缝，面板与迁移才真正可用：
//   S1 expose-chats      ：作者 lib/index.js 里加 1 行 `ctx.provide('tavernChats', chatPersistence)`
//   S2 chat-sqlite-store ：写垫片 lib/domain/chat-sqlite-store.js + index.js 3 处装配
//                        （import、作者 store 保留作 legacy 读源、我们的 store 叠在上面；flushMaintenance 指向作者 store）
//
// 用法（在酒馆主机上跑；`node` 需 ≥22）：
//   node <包目录>/deploy/apply-seams.mjs              # 施缝（幂等；已是最新则只报告）
//   node <包目录>/deploy/apply-seams.mjs --check      # 只检查不改（退出码 0=已就绪 / 3=需施缝）
//   node <包目录>/deploy/apply-seams.mjs --uninstall  # 卸缝（恢复作者原样；幂等）
//   node <包目录>/deploy/apply-seams.mjs --app <目录> # 指定酒馆应用树（默认自动定位）
//
// 阶段顺序（三条缝共用一个入口；都有独立 manifest，互不代管）：
//   CHECK    ：先查「存档格式桥（客户端 UI 接缝）」再查 legacy，最后查本文件的 S1/S2；
//              UI 一侧锚点未知 ⇒ 直接失败退出，**不触碰 host**。
//              （本树无作者客户端文件时 UI 项打印「不在覆盖范围」，结论只是**已声明 coverage**
//               = S1/S2 + legacy，**不代表整包已就绪**。）
//   APPLY    ：**先预检（无写入）** UI + legacy + S1/S2 三边锚点 ⇒ 再 **先施 UI（捕获内存前像）** ⇒ 再施 host；
//              host 任一步失败（含末尾 legacySeams 失败）⇒ 回退**本次 UI 前像**（不是卸载用的首次原像，
//              不动已有 manifest / backup 文件）。
//   UNINSTALL：**先预检 main owned 条目（backup 存在 / created 头部完整）** ⇒ 再 **UI → legacy → main**。
//              UI 侧没有 manifest 却仍有接缝标记 ⇒ 抛错（拒绝猜测还原），因此能在动 legacy/main 之前失败；
//              main 侧 backup 缺失/身份不符 ⇒ 预检即抛，**不动任何一处**（不再有"备份缺失却删 manifest"的假成功）。
//              ⚠ **uninstall 不是跨缝原子事务**：三缝各自预检/回滚；若 UI 已卸而 legacy 卸缝失败，会停在
//                 「UI 已卸、legacy/main 未卸」的中间态（legacy 模块自行回滚它那四个文件），需人工按报错继续。
//              未施过的树（三份 manifest 都不存在）⇒ 安全幂等跳过。
//
//   不留长期跨模块事务：只用「本次操作的内存前像」+「各缝自己已定义的 backup 文件」。
//
//   施缝/卸缝后**服务端接缝都要重启**才生效 —— ⚠ **不要用 launcher 的 `dsh-tavern restart`**：
//   它的 `startService` 会跑 `migrateSessionPrefixEvents`（全量扫描并重写原生日志前缀），
//   与本轮"原件严格只读"政策冲突。安全做法（2026-09-30 洁净实例实测流程）：
//     ① 记录并**独立核验**目标 PID（`/proc/<pid>/cmdline` + `cwd` 指向该实例的应用树）；
//     ② 只对该 PID `SIGTERM`，有界等待退出；
//     ③ 用**同一份现有 CLI 命令行**重新起（`setsid nohup <node> <runtime>/bin/dsh --profile tavern
//        --host 127.0.0.1 --port 3091 --no-open > <log> 2>&1 < /dev/null &`），
//        环境里必须带对 `DSH_HOME`；
//     ④ 更新 PID 记录并探测认证首页 200 再收尾。
//   ⚠ 客户端 UI 接缝**不在此列**：它只改作者客户端资源，重新加载客户端即可；不据此承诺「无需重启」。
//
// 安全设计：
//   · 目标文件**先备份**再改；首次备份即"作者原样"，后续重复施缝不覆盖该备份（卸载据此还原）；
//   · 改完逐个 `node --check`；**任一失败 ⇒ 全部还原**（含删除本次新建的文件）并报错退出；
//   · 幂等：按**标记**判断（S1 `tavernChats` / S2 `createChatSqliteStore`+`legacyStore`），已施则跳过；
//   · 施缝记录写进应用树根 `.tavern-seams.json`，卸载据此精确还原；
//   · `chat-sqlite-store.js` 只在本文件**带我们的部署件头**时才允许删除/覆盖（防误删作者文件）。
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync, rmSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { applyLegacyViewSeams } from './apply-legacy-view-seams.mjs'
import { applySaveUiSeam, restoreSaveUiSnapshot, saveUiTargets } from './apply-save-ui-seam.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHIM_SOURCE = path.join(HERE, 'chat-sqlite-store.shim.js')
const MANIFEST_NAME = '.tavern-seams.json'
const INDEX_REL = 'tavern-plugin/lib/index.js'
const SHIM_REL = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
const SHIM_HEADER = '// ⚠ 部署件：把本文件内容**整份写入**作者树'   // 垫片首行（删/覆盖前的身份凭据）

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const CHECK = flag('--check')
const UNINSTALL = flag('--uninstall')

/** 库调用一律**抛错**（CLI 薄壳统一打印 ✗ 并 exit 1），这样失败路径可被测试与上层 catch。 */
function fail(message) { throw new Error(message) }

/** 精确路径越界守卫：删除/覆盖前一律先确认目标在应用树内。 */
function assertInside(root, target) {
  const resolved = path.resolve(target)
  const base = path.resolve(root)
  if (resolved === base || resolved.startsWith(base + path.sep)) return resolved
  throw new Error('路径越界，拒绝操作：' + resolved)
}

/** 酒馆应用树：--app > profile 清单的 dshTavern.source > <DSH_HOME>/apps/dsh-tavern */
function resolveAppDir() {
  const explicit = value('--app')
  if (explicit) return path.resolve(explicit)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
  try {
    const manifest = JSON.parse(readFileSync(path.join(home, 'profiles', 'tavern', 'package.json'), 'utf8'))
    const source = manifest?.dshTavern?.source
    if (typeof source === 'string' && source !== '' && existsSync(path.join(source, INDEX_REL))) return source
  } catch { /* 退回约定路径 */ }
  const conventional = path.join(home, 'apps', 'dsh-tavern')
  if (existsSync(path.join(conventional, INDEX_REL))) return conventional
  fail('找不到酒馆应用树：请用 --app <目录> 指定（其下应有 tavern-plugin/lib/index.js）')
}

// 三条缝共用一份「当前应用树」配置（下面所有 helper 读这几个模块级变量）。
let APP, INDEX, SHIM, MANIFEST
function configure(appDir) {
  APP = path.resolve(appDir)
  INDEX = path.join(APP, INDEX_REL)
  SHIM = path.join(APP, SHIM_REL)
  MANIFEST = path.join(APP, MANIFEST_NAME)
  if (!existsSync(INDEX)) fail('应用树缺少 ' + INDEX_REL + '：' + APP)
  return APP
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true })
  return result.status === 0 ? '' : String(result.error?.message || 'node --check 退出码 ' + result.status)
}
function legacySeams(options = {}) {
  return applyLegacyViewSeams({ appDir: APP, ...options })
}

/**
 * 「存档格式桥」是否适用于这棵树：
 *   · 两个作者客户端文件都不在 ⇒ 不适用（宿主-only 树，例如只验 S1/S2/legacy 的离线 fixture）；
 *   · 只有一个在 ⇒ 拒绝（绝不对一半施缝）。
 */
function uiTargets() {
  const SAVE_UI_TARGETS = saveUiTargets(APP)
  const present = SAVE_UI_TARGETS.filter(rel => existsSync(path.join(APP, rel)))
  if (present.length === 0) return { applicable: false }
  if (present.length !== SAVE_UI_TARGETS.length) {
    const missing = SAVE_UI_TARGETS.filter(rel => !present.includes(rel))
    fail('作者客户端文件不完整（缺 ' + missing.join('、') + '）——拒绝只对一半施缝')
  }
  return { applicable: true }
}

// ---------- 备份 / 还原 ----------
function readdirSafe(dir) { try { return readdirSync(dir) } catch { return [] } }

// ---------- 断言 / 文案 ----------
function applied(indexText) {
  return {
    s1: indexText.includes("ctx.provide('tavernChats'") || indexText.includes('ctx.provide("tavernChats"'),
    s2Import: indexText.includes("from './domain/chat-sqlite-store.js'"),
    s2Store: indexText.includes('createChatSqliteStore(') && indexText.includes('legacyStore'),
    s2Flush: indexText.includes('authorChatStore.flushMaintenance'),
    shim: existsSync(SHIM) && readFileSync(SHIM, 'utf8').startsWith(SHIM_HEADER),
  }
}

// ---------- S2 三处装配（保持作者原参数不变，只在外面套一层） ----------
function patchIndex(text, changes) {
  let next = text
  // (a) 导入
  if (!next.includes("from './domain/chat-sqlite-store.js'")) {
    const anchor = "import { createChatJournalStore } from './domain/chat-journal-store.js'\n"
    if (!next.includes(anchor)) fail('S2(a)：找不到 createChatJournalStore 的 import 锚点（上游可能改了导入形态）')
    next = next.replace(anchor, anchor + "import { createChatSqliteStore } from './domain/chat-sqlite-store.js'\n")
    changes.push('S2(a) 加 chat-sqlite-store 的 import')
  }
  // (b) 作者 store 保留作 legacy 读源 + 我们的 store 叠在上面（**原选项整段保留**）
  if (!(next.includes('createChatSqliteStore(') && next.includes('legacyStore'))) {
    const rx = /^([ \t]*)const chatJournalStore = createChatJournalStore\(\{([\s\S]*?)\}\)[ \t]*$/m
    const hit = rx.exec(next)
    if (!hit) fail('S2(b)：找不到 `const chatJournalStore = createChatJournalStore({ … })` 锚点')
    const indent = hit[1]
    const options = hit[2]
    const replacement = [
      `${indent}// [dsh-tavern-sqlite-v2] 作者原存储**保留**：上游块布局 / journal 单文件的读源与维护者（我们只读它）`,
      `${indent}const authorChatStore = createChatJournalStore({${options}})`,
      `${indent}// [dsh-tavern-sqlite-v2] 我们的行级 SQLite store 叠在上面：写入走 archive.db，未迁移档的读取（含块布局）交给作者 store`,
      `${indent}const chatJournalStore = createChatSqliteStore({ dataRoot, legacyData: profileData, legacyStore: authorChatStore, now: Date.now, logger: console })`,
    ].join('\n')
    next = next.replace(rx, replacement)
    changes.push('S2(b) 装配改为「作者 store（legacy 读源）+ 我们的 SQLite store」')
  }
  // (c) 维护钩子指向作者 store
  if (!next.includes('authorChatStore.flushMaintenance')) {
    const rx = /^([ \t]*)ctx\.effect\(\(\) => \(\) => chatJournalStore\.flushMaintenance\(\), '([^']*)'\)[ \t]*$/m
    const hit = rx.exec(next)
    if (hit) {
      next = next.replace(rx, `${hit[1]}ctx.effect(() => () => { if (typeof authorChatStore.flushMaintenance === 'function') authorChatStore.flushMaintenance() }, '${hit[2]}')`)
      changes.push('S2(c) flushMaintenance 指向作者 store（加存在性守卫）')
    }
  }
  // S1：聊天存储接口暴露成服务（`/tavern-save`、变量面板要用）
  if (!(next.includes("ctx.provide('tavernChats'") || next.includes('ctx.provide("tavernChats"'))) {
    const start = next.indexOf('const chatPersistence = createChatPersistence(')
    if (start < 0) fail('S1：找不到 `const chatPersistence = createChatPersistence(` 锚点')
    let i = next.indexOf('(', start)
    let depth = 0
    let end = -1
    for (; i < next.length; i += 1) {
      const ch = next[i]
      if (ch === '(') depth += 1
      else if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    if (end < 0) fail('S1：createChatPersistence(...) 括号不平衡')
    const lineStart = next.lastIndexOf('\n', start) + 1
    const indent = next.slice(lineStart, start)
    const insertAt = next.indexOf('\n', end) + 1
    const block = [
      `${indent}// [dsh-tavern-sqlite-v2] 把聊天存储接口暴露给我们的插件（/tavern-save 命令与迁移面板要用）`,
      `${indent}ctx.provide('tavernChats', chatPersistence)`,
      '',
    ].join('\n')
    next = next.slice(0, insertAt) + block + next.slice(insertAt)
    changes.push('S1 暴露 tavernChats 服务（1 行）')
  }
  return next
}

// 纯转换用于首装预检：补足S1/S2锚点，不提前写作者树。
export function transformStorageIndex(source) { return patchIndex(source, []) }

// ---------- 三条缝的库入口（CLI 只是薄壳；库调用一律抛错） ----------

/** CHECK：先 UI、再 legacy、最后 S1/S2。UI 一侧锚点未知 ⇒ 抛错，**不触碰 host**。
 *  ⚠ 本树没有作者客户端文件时（headless / 既有基线），结论只是**本工具已声明的 coverage**
 *  （S1/S2 + legacy），**不代表整包已就绪**；返回值用 coverage 标注。 */
export function checkAllSeams({ appDir }) {
  configure(appDir)
  const state = applied(readFileSync(INDEX, 'utf8'))
  const ui = uiTargets()
  const uiResult = ui.applicable
    ? { applicable: true, ...applySaveUiSeam({ appDir: APP, check: true }) }
    : { applicable: false, needsApply: false }
  const legacy = legacySeams({ check: true })
  const ready = state.s1 && state.s2Import && state.s2Store && state.shim && state.s2Flush
    && !legacy.needsApply && !uiResult.needsApply
  return { ready, state, legacy, ui: uiResult, coverage: uiResult.applicable ? 'full' : 'declared' }
}

function printCheck(result) {
  const { ready, state, legacy, ui } = result
  console.log(`${ready ? '✓' : '✗'} 应用树：${APP}`)
  for (const [key, label] of [['s1', 'S1 暴露 tavernChats'], ['s2Import', 'S2 import'], ['s2Store', 'S2 装配（legacyStore）'], ['s2Flush', 'S2 flushMaintenance'], ['shim', 'S2 垫片文件']]) {
    console.log(`  ${state[key] ? '✓' : '✗'} ${label}`)
  }
  console.log(`  ${legacy.needsApply ? '✗' : '✓'} 原件只读 / 手动另存 / 显式 workspace 接缝`)
  console.log(ui.applicable
    ? `  ${ui.needsApply ? '✗' : '✓'} 存档格式桥（作者客户端两文件）`
    : '  · 存档格式桥：不在本树覆盖范围（本树无作者客户端文件）')
  console.log(ready
    ? (ui.applicable
      ? '已就绪（无需施缝）'
      : '已就绪（仅「已声明 coverage」：S1/S2 + legacy；不含存档格式桥，不代表整包已就绪）')
    : '需要施缝：node deploy/apply-seams.mjs')
}

/**
 * UNINSTALL：**先预检 main 自己拥有的条目** → 再 **UI → legacy → main**。
 * 预检（无写入）要求每个 owned 条目的 backup 存在、created 条目头部是我们部署件；任一不满足即抛错，
 * 此时**尚未动 UI/legacy/main 任何一处**（不再有「备份缺失却 rm manifest」的假成功）。
 * ⚠ 本流程**不是跨缝原子事务**：三条缝各自预检/回滚；若 UI 已卸而 legacy 卸缝失败，会停在
 * 「UI 已卸、legacy/main 未卸」的中间态（legacy 模块自行回滚它那四个文件），需人工按报错继续。
 */
export function uninstallAllSeams({ appDir }) {
  configure(appDir)
  const hadMainManifest = existsSync(MANIFEST)
  const manifest = hadMainManifest ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : undefined
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : []
  // —— 预检（无写入）：main 自己拥有的条目先全部核过，才允许动 UI/legacy/main ——
  for (const entry of entries) {
    const target = assertInside(APP, path.join(APP, entry.rel))
    if (entry.backup) {
      const backup = assertInside(APP, path.join(APP, entry.backup))
      if (!existsSync(backup)) fail('备份缺失：' + entry.backup + '（拒绝部分卸载，全部保持现状）')
    } else if (entry.created) {
      if (!existsSync(target)) continue
      if (!readFileSync(target, 'utf8').startsWith(SHIM_HEADER)) {
        fail(entry.rel + ' 不是我们的部署件（头部不符）——拒绝删除，请人工确认')
      }
    }
  }
  // —— 执行：UI → legacy → main ——
  const restored = []
  const ui = uiTargets()
  if (ui.applicable) {
    const removed = applySaveUiSeam({ appDir: APP, uninstall: true })
    if (removed.changed) restored.push('还原存档格式桥（作者客户端两文件）')
  }
  const legacy = legacySeams({ uninstall: true })
  if (legacy.changed) restored.push('还原原件只读 / 手动另存 / 显式 workspace 接缝')
  const mainRestored = []
  if (hadMainManifest) {
    for (const entry of entries) {
      const target = assertInside(APP, path.join(APP, entry.rel))
      if (entry.backup) {
        const backup = assertInside(APP, path.join(APP, entry.backup))
        if (!existsSync(backup)) fail('备份缺失：' + entry.backup)   // 预检后被改动 ⇒ 响亮失败，不静默 continue
        copyFileSync(backup, target)
        mainRestored.push(`还原 ${entry.rel} ← ${entry.backup}`)
      } else if (entry.created) {
        if (!existsSync(target)) continue
        if (!readFileSync(target, 'utf8').startsWith(SHIM_HEADER)) {
          fail(entry.rel + ' 不是我们的部署件（头部不符）——拒绝删除，请人工确认')
        }
        unlinkSync(target)
        mainRestored.push(`删除我们创建的 ${entry.rel}`)
      }
    }
    const syntax = checkSyntax(INDEX)
    if (syntax !== '') fail('卸载后 index.js 语法检查失败：' + syntax + '（请人工用备份还原）')
    rmSync(MANIFEST, { force: true })
  }
  // 2026-10-06 修复：清扫孤儿 .pre-seams-*.bak（manifest 未引用的残留）——
  // 卸载后残留的备份会在下次装回时被 ensureBackup 复用（哪怕内容已污染），
  // 形成"卸载恢复出脏前像 → 锚点找不到"死循环（188 实测）。
  // 限定本缝声明条目：manifest 引用的备份由 finishSourceUninstall 归档，不在此处动；
  // 其他维护或未知来源的 .bak 不清扫，防止 uninstallAllSeams 的目录扫描与标准卸缝的明确集合打架。
  const referencedBackups = new Set(entries.filter(e => e.backup).map(e => path.posix.normalize(e.backup)))
  const ownedPrefixes = new Set(entries.filter(e => e.rel && !e.created).map(e => path.posix.normalize(e.rel) + '.pre-seams-'))
  for (const dirRel of ['tavern-plugin/lib', 'tavern-plugin/lib/domain']) {
    const dir = path.join(APP, dirRel)
    if (!existsSync(dir)) continue
    for (const name of readdirSafe(dir)) {
      if (!/\.pre-seams-[\w.-]+\.bak$/.test(name)) continue
      const rel = path.posix.join(dirRel, name)
      if (referencedBackups.has(rel)) continue
      if (![...ownedPrefixes].some(prefix => rel.startsWith(prefix))) continue
      try { unlinkSync(path.join(dir, name)) } catch { /* 清不了不挡卸载 */ }
    }
  }
  return { restored, mainRestored, hadMainManifest }
}

/** host 侧（S1/S2 + legacy）写入；失败时先恢复 main 自己的当前前像，再把错误抛给上层（由上层回退 UI 前像）。 */
function applyHostWrites({ indexText, nextIndex, changes, shimNeedsWrite, previousShim, previousManifest }) {
  const entries = previousManifest ? JSON.parse(previousManifest).entries || [] : []
  const ts = stamp()
  const backups = []
  function ensureBackup(rel) {
    const target = path.join(APP, rel)
    if (!existsSync(target)) return undefined
    const dir = path.dirname(target)
    const prefix = path.basename(rel) + '.pre-seams-'
    // 已有manifest的精确引用是恢复链，不能另选孤儿、更不能删旧备份后复制当前缝合态。
    const owner = entries.find(entry => entry.rel === rel)
    if (owner?.created) return undefined
    const candidates = readdirSafe(dir).filter(n => n.startsWith(prefix) && n.endsWith('.bak')).sort()
    if (owner && !owner.backup) fail('主接缝缺前像恢复材料：' + rel)
    const existingRel = owner?.backup || (candidates.length === 1 ? path.posix.join(path.dirname(rel), candidates[0]) : undefined)
    if (!owner && candidates.length > 1) fail('前像备份存在歧义，拒绝按文件名猜测：' + rel)
    const isSeamed = code => /\[dsh-tavern-|from ['"]\.\/domain\/(?:chat-sqlite-store|legacy-view-seams|storage-[\w-]+)\.js['"]/.test(code)
    if (existingRel) {
      const existingPath = assertInside(APP, path.join(APP, existingRel))
      if (!existsSync(existingPath)) fail('前像备份缺失：' + existingRel)
      const backupBytes = readFileSync(existingPath)
      if (rel === INDEX_REL && isSeamed(backupBytes.toString('utf8'))) fail('前像污染：' + existingRel + ' 含接缝内容；保留备份，交由一键维护入口验证历史安装前像')
      if (!owner && !backupBytes.equals(readFileSync(target))) fail('孤儿前像与当前作者源码不一致，拒绝复用：' + existingRel)
      return existingRel
    }
    if (rel === INDEX_REL && isSeamed(readFileSync(target, 'utf8'))) fail('前像污染：当前入口已施缝且无可信备份，拒绝用它新建前像')
    const backupRel = path.posix.join(path.dirname(rel), `${path.basename(rel)}.pre-seams-${ts}.bak`)
    if (existsSync(assertInside(APP, path.join(APP, backupRel)))) fail('前像备份目的已存在，拒绝覆盖：' + backupRel)
    copyFileSync(target, assertInside(APP, path.join(APP, backupRel)))
    backups.push(backupRel)
    return backupRel
  }
  try {
    const indexBackup = ensureBackup(INDEX_REL)
    if (!entries.some(entry => entry.rel === INDEX_REL)) entries.push({ rel: INDEX_REL, backup: indexBackup })
    if (shimNeedsWrite) {
      const shimBackup = existsSync(SHIM) ? ensureBackup(SHIM_REL) : undefined
      if (!entries.some(entry => entry.rel === SHIM_REL)) entries.push({ rel: SHIM_REL, backup: shimBackup, created: shimBackup === undefined })
      mkdirSync(path.dirname(SHIM), { recursive: true })
      copyFileSync(SHIM_SOURCE, SHIM)
    }
    writeFileSync(INDEX, nextIndex)
    const syntaxIndex = checkSyntax(INDEX)
    if (syntaxIndex !== '') throw new Error('index.js 语法检查失败：' + syntaxIndex)
    if (existsSync(SHIM)) {
      const syntaxShim = checkSyntax(SHIM)
      if (syntaxShim !== '') throw new Error('垫片语法检查失败：' + syntaxShim)
    }
    writeFileSync(MANIFEST, JSON.stringify({
      version: 1, package: 'dsh-tavern-sqlite-v2', appliedAt: new Date().toISOString(), app: APP, entries,
    }, null, 2) + '\n', 'utf8')
    // main 就绪后施 legacy；legacy 自己回滚其多模块，失败时抛给本函数 catch 恢复 main 当前代。
    legacySeams()
    return { backups }
  } catch (error) {
    try {
      writeFileSync(INDEX, indexText, 'utf8')
      if (previousShim === undefined) { if (existsSync(SHIM)) unlinkSync(SHIM) }
      else writeFileSync(SHIM, previousShim, 'utf8')
      if (previousManifest === undefined) { if (existsSync(MANIFEST)) unlinkSync(MANIFEST) }
      else writeFileSync(MANIFEST, previousManifest, 'utf8')
      for (const rel of backups) {
        const target = assertInside(APP, path.join(APP, rel))
        if (existsSync(target)) unlinkSync(target)
      }
    } catch (restoreError) { throw new Error('施缝失败且回滚异常：' + String(restoreError?.message || restoreError)) }
    throw new Error('施缝失败已回滚：' + String(error?.message || error))
  }
}

/**
 * APPLY：**预检（无写入）** → **先施 UI（捕获本次操作的内存前像）** → 再施 host。
 * UI 已写之后**任何一步失败**（host 写入失败，或 host 已就绪只需补 legacy 而 legacy 失败）
 * ⇒ 只回退本次 UI 前像（不是卸载用的首次原像；不动已有 manifest / backup）。
 * @param applyHost - 测试可注入 host 写入；默认 applyHostWrites（生产路径无 fallback）。
 * @param applyLegacy - 测试可注入 legacy **施缝**步骤；默认 legacySeams。预检始终用真实 check，不受注入影响。
 */
export function applyAllSeams({ appDir, applyHost, applyLegacy } = {}) {
  configure(appDir)
  const indexText = readFileSync(INDEX, 'utf8')
  const ui = uiTargets()
  const runLegacyApply = applyLegacy || legacySeams
  // —— 预检：三边锚点全部先算一遍，任何未知锚点都在**任何写入之前**抛错 ——
  const uiCheck = ui.applicable
    ? { applicable: true, ...applySaveUiSeam({ appDir: APP, check: true }) }
    : { applicable: false, needsApply: false }
  const legacyCheck = legacySeams({ check: true })
  const changes = []
  const previousShim = existsSync(SHIM) ? readFileSync(SHIM, 'utf8') : undefined
  const previousManifest = existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : undefined
  const shimNeedsWrite = !(previousShim !== undefined && previousShim.startsWith(SHIM_HEADER))
  const nextIndex = patchIndex(indexText, changes)   // 未知/不合法锚点 ⇒ 抛错（此刻尚无任何写入）
  const hostNeedsWork = changes.length > 0 || shimNeedsWrite
  const legacyNeedsWork = legacyCheck.needsApply === true
  if (!hostNeedsWork && !uiCheck.needsApply) {
    // 此处 UI 尚未写过，没有可回退的前像。
    const legacyChanged = legacyNeedsWork ? runLegacyApply().changed === true : false
    return { uiApplied: false, hostApplied: false, legacyChanged, shimNeedsWrite: false, changes: [], backups: [], files: [] }
  }
  // —— 先施 UI（幂等；返回本次操作的内存前像）——
  const uiResult = uiCheck.needsApply ? applySaveUiSeam({ appDir: APP }) : undefined
  const uiApplied = Boolean(uiResult?.changed)
  const uiSnapshot = uiResult?.snapshot
  const uiFiles = uiResult?.files || []
  try {
    // host 已就绪、只需补 legacy：这步也在同一 try 内 —— UI 已写，legacy 失败必须回退 UI 前像。
    if (!hostNeedsWork) {
      const legacyChanged = legacyNeedsWork ? runLegacyApply().changed === true : false
      return { uiApplied, hostApplied: false, legacyChanged, shimNeedsWrite: false, changes: [], backups: [], files: uiFiles }
    }
    const host = applyHost || applyHostWrites
    const result = host({ indexText, nextIndex, changes, shimNeedsWrite, previousShim, previousManifest })
    return { uiApplied, hostApplied: true, legacyChanged: true, shimNeedsWrite,
      changes, backups: result?.backups || [], files: uiFiles }
  } catch (error) {
    if (uiSnapshot) restoreSaveUiSnapshot({ appDir: APP, snapshot: uiSnapshot })
    throw error
  }
}

// ---------- CLI（薄壳） ----------
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const appDir = resolveAppDir()
    if (CHECK) {
      const result = checkAllSeams({ appDir })
      printCheck(result)
      process.exit(result.ready ? 0 : 3)
    }
    if (UNINSTALL) {
      const result = uninstallAllSeams({ appDir })
      if (!result.restored.length && !result.mainRestored.length) console.log('· 没有施缝记录 —— 无需卸载')
      else {
        console.log('✓ 已卸缝（恢复作者原样）：')
        for (const line of [...result.restored, ...result.mainRestored]) console.log('  · ' + line)
      }
      console.log('  服务端接缝重启生效：⚠ 不要用 launcher 重启（会跑 prefix migration）；按脚本头部安全流程执行')
      console.log('  客户端 UI 接缝不在重启之列：重新加载客户端资源即可。')
      process.exit(0)
    }
    const result = applyAllSeams({ appDir })
    if (!result.uiApplied && !result.hostApplied && !result.legacyChanged) {
      console.log('✓ 已是最新（幂等跳过）')
      console.log('  应用树：' + APP)
      process.exit(0)
    }
    if (!result.uiApplied && !result.hostApplied && result.legacyChanged) {
      console.log('✓ 已补齐原件只读 / 手动另存 / workspace 接缝')
      console.log('  应用树：' + APP)
      process.exit(0)
    }
    console.log('✓ 已施缝（幂等）：')
    for (const line of result.changes) console.log('  · ' + line)
    if (result.shimNeedsWrite) console.log('  · 写入垫片 ' + SHIM_REL)
    for (const line of result.backups) console.log('  · 备份 ' + line)
    if (result.uiApplied) console.log('  · 存档格式桥（作者客户端两文件）')
    console.log('  记录：' + MANIFEST_NAME + ' / .tavern-save-ui-seam.json（各自卸载据此还原）')
    console.log('  服务端接缝重启生效：⚠ 不要用 launcher 重启（会跑 prefix migration）；按脚本头部安全流程执行')
    console.log('  客户端 UI 接缝不在重启之列：重新加载客户端资源即可。')
    process.exit(0)
  } catch (error) {
    console.error('✗ ' + String(error?.message || error))
    process.exit(1)
  }
}
