// 阶段③：只保留**纯业务 transform**（无 fs 写入 / 无 manifest / 无备份 / 无 CLI / 无 __main__ 入口）。
// 仍读盘的只有 `saveUiTargets()`（只读布局判定）：唯一消费者是 client-seams 的唯一 client 链。
//
// 作者构建脚本 `bin/build-tavern-client.mjs` 只做「// @include 内联 + 追加 CSS」，正文逐字保留
// ⇒ 源码（拆分树 features/play-controls.js 或旧内联树 main.js）与产物 lib/client.js **同构**，同一 transform 对两者都成立。
//
// ── 宿主侧契约（由我们的 client 模块实现；本文件只做作者树接缝） ──
//   service 名： 'tavernStorageUi'
//   value 形状： { active: true, renderSavePanel(props) { … } }
//   自有 ephemeral 事件（非 Session 事件）： 'tavern-storage-ui/change'
//   卸载顺序（必须）：先 `ui.active = false`，**再** `ctx.emit('tavern-storage-ui/change')`；桥每 render 读一次并检查 `active === true`。
//   本文件不使用 cordis `internal/*` 内部事件。
//
// ── 两个接缝（transformSaveUiClient） ──
//   ① 状态体里插入桥：变体甲（作者已有迁移区）⇒ 紧邻 `h(TavernStorageMigration, …)` 之后；
//      变体乙（无迁移区）⇒ 正常状态体最前（TavernBackgroundWait 之前）；两种变体各自要求结构证据，否则 fail closed。
//   ② 桥函数定义（内联在 TavernStatusTab 之前）+ 两处 ctx 转发（status tab 注册处、TavernStatusPanel props）。
//   不接管作者原有「迁移旧存档」区块：不读、不删、不替换，只做插入。
//
// ── fail-closed 纪律 ──
//   每个锚点必须**唯一命中**，0 或 >1 一律抛错；结构证据不成立 ⇒ 抛错，不猜、不编造锚点。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const SAVE_UI_MARKER = '// [dsh-tavern-save-ui-seam:v1]'
export const SAVE_UI_SERVICE = 'tavernStorageUi'
export const SAVE_UI_EVENT = 'tavern-storage-ui/change'
export const SAVE_UI_BRIDGE = 'TavernStorageSaveBridge'
/** 施缝目标：源码与构建产物（同构 ⇒ 同一 transform）。 */
export const SAVE_UI_TARGETS = Object.freeze([
  'tavern-plugin/src/client/main.js',
  'tavern-plugin/lib/client.js'
])
/** 只读布局判定：拆分布局（main.js 仍带 include）⇒ 落 features/play-controls.js，否则落内联 main.js。 */
export function saveUiTargets(appDir){
  const main='tavern-plugin/src/client/main.js',feature='tavern-plugin/src/client/features/play-controls.js'
  if(existsSync(path.join(appDir,main)) && readFileSync(path.join(appDir,main),'utf8').includes('// @include features/play-controls.js'))return [feature,'tavern-plugin/lib/client.js']
  return [...SAVE_UI_TARGETS]
}

// ── 锚点（作者客户端正文；源码与产物逐字相同） ──
const BODY_OPEN = 'h("div", { className: "dsh-tavern-status-body" },'
const BODY_FIRST = 'h(TavernBackgroundWait, {sessionId:props.sessionId, activity:view.activity}),'
const MIGRATION_CALL = 'h(TavernStorageMigration, '
const STATUS_TAB_FN = 'function TavernStatusTab(props) {'
const STATUS_TAB_VIEW = 'return h(TavernStatusPanel, { sessionId: props.sessionId,'
const STATUS_TAB_REGISTER = 'React.createElement(TavernStatusTab, { sessions: ctx.sessions,'

const BRIDGE_CALL = `h(${SAVE_UI_BRIDGE}, { ctx: props.storageUiCtx, sessionId: props.sessionId }),`
const BRIDGE_VIEW_NEXT = 'return h(TavernStatusPanel, { storageUiCtx: props.storageUiCtx, sessionId: props.sessionId,'
const BRIDGE_REGISTER_NEXT = `React.createElement(TavernStatusTab, { storageUiCtx: ctx, sessions: ctx.sessions,`

/** 桥函数定义（相对缩进；插入时按 TavernStatusTab 的实际缩进补齐）。 */
function bridgeDefinitionLines() {
  return [
    SAVE_UI_MARKER,
    '// 作者面板里的纯 React 桥：只读我们的可选服务；每 render 读一次，active !== true 一律不渲染。',
    `function ${SAVE_UI_BRIDGE}(props) {`,
    '\tconst ctx = props.ctx;',
    '\tconst read = function () {',
    `\t\tconst ui = ctx && typeof ctx.get === "function" ? ctx.get(${JSON.stringify(SAVE_UI_SERVICE)}) : undefined;`,
    '\t\treturn ui && ui.active === true && typeof ui.renderSavePanel === "function" ? ui : undefined;',
    '\t};',
    '\tconst [, bump] = React.useState(0);',
    '\tReact.useEffect(function () {',
    '\t\tif (!ctx || typeof ctx.on !== "function") return function () {};',
    '\t\tconst refresh = function () { bump(function (value) { return value + 1; }); };',
    `\t\tconst dispose = ctx.on(${JSON.stringify(SAVE_UI_EVENT)}, refresh); // 先订阅，避免 mount 间隙漏事件`,
    '\t\trefresh();',
    '\t\treturn function () { if (typeof dispose === "function") dispose(); };',
    '\t}, [ctx]);',
    '\tconst ui = read();',
    '\tif (ui === undefined) return null;',
    '\treturn ui.renderSavePanel({ sessionId: props.sessionId });',
    '}',
    ''
  ]
}

function countOf(source, needle) {
  let count = 0
  let index = 0
  while ((index = source.indexOf(needle, index)) >= 0) { count += 1; index += needle.length }
  return count
}

function requireUnique(source, needle, label) {
  const count = countOf(source, needle)
  if (count !== 1) {
    throw new Error(`存档格式桥接缝锚点${count === 0 ? '缺失' : '不唯一'}（${label}，命中 ${count}）——作者客户端布局未知，拒绝猜测`)
  }
  return source.indexOf(needle)
}

function lineStartOf(source, index) {
  const newline = source.lastIndexOf('\n', index - 1)
  return newline + 1
}

function indentOf(source, lineStart) {
  const matched = /^[ \t]*/.exec(source.slice(lineStart, lineStart + 128))
  return matched === null ? '' : matched[0]
}

function replaceOnce(source, needle, next, label) {
  const at = requireUnique(source, needle, label)
  return source.slice(0, at) + next + source.slice(at + needle.length)
}

/** 把整段行插到某锚点所在行的前面，缩进取该锚点行的实际缩进。 */
function insertLinesBefore(source, needle, lines, label) {
  const at = requireUnique(source, needle, label)
  const lineStart = lineStartOf(source, at)
  const indent = indentOf(source, lineStart)
  const block = lines.map(line => (line === '' ? '' : indent + line)).join('\n') + '\n'
  return source.slice(0, lineStart) + block + source.slice(lineStart)
}

function lineEndOf(source, index) {
  const newline = source.indexOf('\n', index)
  return newline < 0 ? source.length : newline
}

/** 读锚点所在行的「上一行」去空白文本（用于结构证据）；无上一行时返回 undefined。 */
function previousLineOf(source, lineStart) {
  if (lineStart === 0) return undefined
  return source.slice(lineStartOf(source, lineStart - 1), lineStart - 1).trim()
}

/** 接缝①变体甲：紧邻作者迁移区之后插入（不接管作者的区块）。 */
function insertAfterMigration(source) {
  const at = requireUnique(source, MIGRATION_CALL, '作者迁移区 h(TavernStorageMigration, …)')
  const lineStart = lineStartOf(source, at)
  if (previousLineOf(source, lineStart) !== BODY_FIRST) {
    throw new Error('存档格式桥接缝：作者迁移区上一行不是 TavernBackgroundWait——未知布局 fail closed，'
      + '待现场 anchor 再支持，不编造锚点')
  }
  const indent = indentOf(source, lineStart)
  const lineEnd = lineEndOf(source, at)
  return source.slice(0, lineEnd + 1) + indent + BRIDGE_CALL + '\n' + source.slice(lineEnd + 1)
}

/** 接缝①变体乙：正常状态体最前（TavernBackgroundWait 之前）插入。 */
function insertAtBodyFront(source) {
  const at = requireUnique(source, BODY_FIRST, '状态体首子节点 TavernBackgroundWait')
  const lineStart = lineStartOf(source, at)
  if (lineStart === 0) throw new Error('存档格式桥接缝：状态体首子节点不在独立行，布局未知，拒绝猜测')
  if (previousLineOf(source, lineStart) !== BODY_OPEN) {
    throw new Error('存档格式桥接缝：正常状态体首子节点既不是作者迁移区、上一行也不是状态体开头'
      + '（作者可能已改版）——未知布局 fail closed，待现场 anchor 再支持，不编造锚点')
  }
  const indent = indentOf(source, lineStart)
  return source.slice(0, lineStart) + indent + BRIDGE_CALL + '\n' + source.slice(lineStart)
}

/**
 * 接缝①：正常状态体里插入桥。
 *   变体甲 = 作者已有迁移区（当前真身）⇒ 紧邻迁移区之后；
 *   变体乙 = 无迁移区（更早真身）⇒ 状态体最前；
 *   迁移区锚点 >1 命中或结构证据不成立 ⇒ fail closed。
 */
function insertBridgeCall(source) {
  const migrationHits = countOf(source, MIGRATION_CALL)
  if (migrationHits > 1) {
    throw new Error(`存档格式桥接缝锚点不唯一（作者迁移区 h(TavernStorageMigration, …)，命中 ${migrationHits}）——拒绝猜测`)
  }
  return migrationHits === 1 ? insertAfterMigration(source) : insertAtBodyFront(source)
}

/**
 * 作者客户端源码 → 施缝后的源码（纯函数；两个接缝）。
 * 幂等：已含标记时校验完整性后原样返回；部分施缝/同名函数已存在时响亮拒绝。
 * 纯业务检查只保证**同一次变换链稳定**，不承担安装幂等（安装幂等由块记录/装配层判定）。
 */
export function transformSaveUiClient(source) {
  if (typeof source !== 'string' || source === '') throw new Error('transformSaveUiClient：缺少作者客户端源码文本')
  if (source.includes(SAVE_UI_MARKER)) {
    for (const required of [SAVE_UI_BRIDGE, BRIDGE_CALL, `ctx.get(${JSON.stringify(SAVE_UI_SERVICE)})`,
      `ctx.on(${JSON.stringify(SAVE_UI_EVENT)}`, 'storageUiCtx: ctx', 'storageUiCtx: props.storageUiCtx']) {
      if (!source.includes(required)) throw new Error('存档格式桥接缝标记存在但实现不完整（缺少 ' + required + '），拒绝猜测修复')
    }
    return source
  }
  if (source.includes(SAVE_UI_BRIDGE)) {
    throw new Error('作者客户端已存在 ' + SAVE_UI_BRIDGE + '（可能被其它工具改过），拒绝覆盖')
  }
  let out = insertBridgeCall(source)
  out = insertLinesBefore(out, STATUS_TAB_FN, bridgeDefinitionLines(), 'TavernStatusTab 定义')
  out = replaceOnce(out, STATUS_TAB_VIEW, BRIDGE_VIEW_NEXT, 'TavernStatusPanel props 转发')
  out = replaceOnce(out, STATUS_TAB_REGISTER, BRIDGE_REGISTER_NEXT, 'status tab 注册 ctx 转发')
  if (!out.includes(SAVE_UI_MARKER) || !out.includes(BRIDGE_CALL)) throw new Error('存档格式桥接缝未生效，拒绝写入')
  return out
}
