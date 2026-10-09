// apply-save-ui-seam 接缝测试：合成 fixture（mkdtemp 独占临时树）+ 离线真身只读 transform 检查。
// 不写真实源码树、不部署、不重启；临时目录只删自己 mkdtemp 出来的那一个（删前核对路径身份）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
const defaultSyntaxCheck = (code, file) => new vm.Script(code, { filename: file })
import {
  transformSaveUiClient,
  SAVE_UI_BRIDGE, SAVE_UI_EVENT, SAVE_UI_MARKER, SAVE_UI_SERVICE, SAVE_UI_TARGETS
} from '../deploy/apply-save-ui-seam.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMP_PREFIX = 'dsh-tavern-save-ui-seam-'
const BODY_FIRST_LINE = 'h(TavernBackgroundWait, {sessionId:props.sessionId, activity:view.activity}),'
// 作者迁移区渲染点：逐字来自 2026-09-30 洁净实例真身 `blank-clean-client-0930.js:14465`。
const MIGRATION_LINE = 'h(TavernStorageMigration, {key:props.sessionId,sessionId:props.sessionId,busy:running || view.activity?.busy || view.settleStatus === "running"}),'
const BRIDGE_CALL_LINE = `h(${SAVE_UI_BRIDGE}, { ctx: props.storageUiCtx, sessionId: props.sessionId }),`
const BASELINE = path.resolve(HERE, '../../../tools/deployed-baseline/repo-latest/tavern-plugin')
const CLEAN_CLIENT = path.resolve(HERE, '../../../.tmp-verify-clean-install/blank-clean-client-0930.js')

const tempRoots = []
after(() => {
  for (const dir of tempRoots) {
    const expected = path.join(os.tmpdir(), path.basename(dir))
    assert.equal(path.resolve(dir), expected, '临时目录身份核对应与 mkdtemp 返回值一致')
    assert.ok(path.basename(dir).startsWith(TEMP_PREFIX), '只删自己按前缀建的临时目录')
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 最小但结构忠实的作者客户端 fixture：两个接缝的锚点逐字来自真身正文。
 *  withMigration=true 复刻 2026-09-30 洁净实例布局（背景等待 → 作者迁移区 → 重载人物卡）。 */
function fixtureSource({ withMigration = false } = {}) {
  return [
    'window.__ModuleLoader__.load({',
    '\tid: "dsh-tavern-plugin",',
    '\tfactory: (require) => {',
    '\t\tlet React = require("react");',
    '',
    '\t\tfunction TavernStatusPanel(props) {',
    '\t\t\tconst h = React.createElement;',
    '\t\t\treturn h("aside", { className: "dsh-tavern-status" },',
    '\t\t\t\th("div", { className: "dsh-tavern-status-head" }, h("div", { className: "dsh-tavern-status-title" }, "酒馆状态")),',
    '\t\t\t\th("div", { className: "dsh-tavern-status-body" },',
    `                        ${BODY_FIRST_LINE}`,
    ...(withMigration ? [`                        ${MIGRATION_LINE}`] : []),
    '\t\t\t\t\t["story", "script"].includes(view.mode || "story") && view.cardUpdate ? h("section", { className: "dsh-tavern-status-section" }, h("div", { className: "dsh-tavern-card-reload" })) : null',
    '\t\t\t\t));',
    '\t\t}',
    '',
    '\t\tfunction TavernStatusTab(props) {',
    '\t\t\treturn h(TavernStatusPanel, { sessionId: props.sessionId, useSession: useSession, useChat: useChat, executeSlash: props.executeSlash, openStyleTab: props.openStyleTab });',
    '\t\t}',
    '',
    '\t\tfunction register(input) {',
    '\t\t\tconst ctx = input.ctx;',
    '\t\t\tctx.effect(() => ctx.betterSidebar.registerTab({',
    '\t\t\t\tid: "dsh-tavern:status", title: "酒馆状态", order: 7, single: true,',
    '\t\t\t\tcomponent: function (props) {',
    '\t\t\t\t\treturn React.createElement(TavernStatusTab, { sessions: ctx.sessions, uiConversation: uiConversation, sessionId: props.scope.sessionId, executeSlash: executeSlash, openStyleTab: function (type) { openTavernSidebarTab(ctx, { type: type }, { sessionId: props.scope.sessionId }); } });',
    '\t\t\t\t}',
    '\t\t\t}), "dsh-tavern: status tab");',
    '\t\t}',
    '\t\treturn { inject: ["slots"], apply(ctx) { register({ ctx: ctx, slots: ctx.slots }) } };',
    '\t}',
    '});',
    ''
  ].join('\n')
}

function seamBlock(text) {
  const start = text.indexOf(SAVE_UI_MARKER)
  const endNeedle = 'return ui.renderSavePanel({ sessionId: props.sessionId });'
  const end = text.indexOf(endNeedle, start)
  assert.ok(start >= 0 && end > start, '应能在输出里定位桥定义块')
  return text.slice(start, end + endNeedle.length)
}

/** 从 transform 输出里按花括号配对取出真实函数文本（要跑的就是被插入的那份代码本身）。 */
function extractFunction(text, header) {
  const start = text.indexOf(header)
  assert.ok(start >= 0, '应能定位 ' + header)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('函数花括号不平衡：' + header)
}

/** 最小 hooks 运行时：只服务 bridge 用到的 useState/useEffect；渲染与副作用由测试显式驱动。 */
function createHookRuntime({ onSet = () => {} } = {}) {
  const hooks = []
  let cursor = 0
  let pending = []
  return {
    React: {
      useState(initial) {
        const at = cursor++
        if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
        const set = value => { hooks[at] = typeof value === 'function' ? value(hooks[at]) : value; onSet() }
        return [hooks[at], set]
      },
      useEffect(effect, deps) {
        const at = cursor++
        const prev = hooks[at]
        const changed = prev === undefined || deps === undefined
          || deps.length !== prev.deps.length || deps.some((value, index) => value !== prev.deps[index])
        if (!changed) { pending.push(prev); return }
        if (prev && typeof prev.cleanup === 'function') prev.cleanup()
        const slot = { deps, effect, cleanup: undefined }
        hooks[at] = slot
        pending.push(slot)
      }
    },
    render(Component, props) {
      cursor = 0
      pending = []
      const output = Component(props)
      for (const slot of pending) {
        if (typeof slot.effect !== 'function') continue
        const cleanup = slot.effect()
        slot.effect = undefined
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
      return output
    },
    unmount() {
      for (const slot of hooks) if (slot && typeof slot.cleanup === 'function') { slot.cleanup(); slot.cleanup = undefined }
    }
  }
}

/** 假 ctx：只实现 bridge 用到的 get/on（on 返回 disposer），并暴露监听数。 */
function createFakeCtx() {
  const listeners = new Set()
  const state = { service: undefined }
  return {
    ctx: {
      get: name => (name === SAVE_UI_SERVICE ? state.service : undefined),
      on: (event, handler) => { assert.equal(event, SAVE_UI_EVENT); listeners.add(handler); return () => { listeners.delete(handler) } }
    },
    provide: value => { state.service = value },
    emit: () => { for (const handler of [...listeners]) handler() },
    get listeners() { return listeners.size }
  }
}

/** 真实 bridge 函数在 VM 里跑一遍：late provide / active=false / dispose / 监听归零。 */
test('bridge 生命周期（真实插入函数 + VM hooks，不模拟 DOM）', () => {
  const out = transformSaveUiClient(fixtureSource({ withMigration: true }))
  const bridgeSource = extractFunction(out, `function ${SAVE_UI_BRIDGE}(props) {`)
  const order = []
  const hooks = createHookRuntime({ onSet: () => order.push('bump') })
  const sandbox = { React: hooks.React, console }
  vm.runInNewContext(`${bridgeSource}\n;globalThis.${SAVE_UI_BRIDGE} = ${SAVE_UI_BRIDGE};`, sandbox)
  const bridge = sandbox[SAVE_UI_BRIDGE]
  assert.equal(typeof bridge, 'function')

  const fake = createFakeCtx()
  const originalOn = fake.ctx.on
  fake.ctx.on = (event, handler) => { order.push('on'); return originalOn(event, handler) }
  const props = { ctx: fake.ctx, sessionId: 's-1' }

  assert.equal(hooks.render(bridge, props), null, '服务缺席时必须渲染 null')
  assert.equal(fake.listeners, 1, '必须先订阅（等迟到的 provide）')
  assert.deepEqual(order, ['on', 'bump'], '订阅必须早于 mount 后的补读 refresh')

  fake.provide({ active: true, renderSavePanel: ({ sessionId }) => 'PANEL:' + sessionId })
  fake.emit()
  assert.equal(hooks.render(bridge, props), 'PANEL:s-1', 'late provide + change 后渲染我们的面板')

  fake.ctx.get(SAVE_UI_SERVICE).active = false   // dispose 顺序：先 active=false
  fake.emit()                                    // 再 emit（此时服务可能仍读得到）
  assert.equal(hooks.render(bridge, props), null, 'active=false 必须立刻不渲染')
  assert.equal(fake.listeners, 1, '此时桥仍挂载，仍在订阅')

  hooks.unmount()
  assert.equal(fake.listeners, 0, 'cleanup 必须摘掉监听')
  fake.provide(undefined)
  fake.emit()
  assert.equal(hooks.render(bridge, props), null)
  assert.equal(fake.listeners, 0)
})

test('transform：无迁移区（更早真身）⇒ 桥落在状态体最前，且不接管作者迁移区', () => {
  const source = fixtureSource()
  const out = transformSaveUiClient(source)
  assert.equal(source, fixtureSource(), '纯函数：输入不得被就地修改')
  assert.equal(out.split(SAVE_UI_MARKER).length - 1, 1, '标记必须恰好一次')
  const lines = out.split('\n')
  const first = lines.findIndex(line => line.includes(BODY_FIRST_LINE))
  assert.ok(first > 0, '应保留作者原有状态体首子节点')
  assert.equal(lines[first - 1].trim(), BRIDGE_CALL_LINE, '桥调用必须紧贴状态体首子节点之前')
  assert.equal(lines[first - 1].match(/^[ \t]*/)[0], lines[first].match(/^[ \t]*/)[0], '缩进必须与相邻行一致')
  assert.equal(out.indexOf(SAVE_UI_MARKER) < out.indexOf('function TavernStatusTab(props) {'), true, '定义必须在 TavernStatusTab 之前')
  assert.match(out, /storageUiCtx: ctx, sessions: ctx\.sessions,/)
  assert.match(out, /return h\(TavernStatusPanel, \{ storageUiCtx: props\.storageUiCtx, sessionId: props\.sessionId,/)
  assert.match(out, new RegExp(`ctx\\.get\\("${SAVE_UI_SERVICE}"\\)`))
  assert.match(out, new RegExp(`ctx\\.on\\("${SAVE_UI_EVENT}", refresh\\)`))
  assert.match(out, /ui\.active === true/)
  defaultSyntaxCheck(out, 'fixture.js')
  assert.equal(transformSaveUiClient(out), out, '无迁移区布局同样幂等')
})

test('transform：有作者迁移区（当前真身布局）⇒ 桥紧邻迁移区之后、重载人物卡之前', () => {
  const out = transformSaveUiClient(fixtureSource({ withMigration: true }))
  const lines = out.split('\n')
  const migration = lines.findIndex(line => line.includes('h(TavernStorageMigration, {'))
  const background = lines.findIndex(line => line.includes(BODY_FIRST_LINE))
  assert.ok(migration > background, '作者布局应保持 背景等待 → 迁移区')
  assert.equal(lines[migration + 1].trim(), BRIDGE_CALL_LINE, '桥必须紧邻作者迁移区之后')
  assert.equal(lines[migration + 1].match(/^[ \t]*/)[0], lines[migration].match(/^[ \t]*/)[0], '缩进必须与迁移区一致')
  assert.equal(lines[migration + 2].trim().startsWith('["story", "script"].includes('), true, '桥之后应仍是重载人物卡分支')
  defaultSyntaxCheck(out, 'fixture.js')
  assert.equal(transformSaveUiClient(out), out, '有迁移区布局同样幂等')
})

test('fail closed：锚点缺失', () => {
  const broken = fixtureSource().replace(`                        ${BODY_FIRST_LINE}\n`, '')
  assert.throws(() => transformSaveUiClient(broken), /锚点缺失/)
})

test('fail closed：锚点不唯一', () => {
  const broken = fixtureSource().replace(BODY_FIRST_LINE, `${BODY_FIRST_LINE}\n${BODY_FIRST_LINE}`)
  assert.throws(() => transformSaveUiClient(broken), /锚点不唯一/)
})

test('fail closed：作者改版（无迁移区且状态体首子节点被挤走）不合规即拒绝', () => {
  const broken = fixtureSource().replace(
    `                        ${BODY_FIRST_LINE}`,
    `${' '.repeat(24)}h("section", { className: "dsh-tavern-status-section" }, h("div", { className: "dsh-tavern-status-label" }, "存档格式")),\n                        ${BODY_FIRST_LINE}`
  )
  assert.throws(() => transformSaveUiClient(broken), /未知布局 fail closed/)
})

test('fail closed：迁移区上一行不是背景等待 ⇒ 拒绝（不猜迁移区位置）', () => {
  const broken = fixtureSource({ withMigration: true }).replace(`                        ${BODY_FIRST_LINE}\n`, '')
  assert.throws(() => transformSaveUiClient(broken), /作者迁移区上一行不是 TavernBackgroundWait/)
})

test('fail closed：迁移区锚点不唯一', () => {
  const broken = fixtureSource({ withMigration: true }).replace(MIGRATION_LINE, `${MIGRATION_LINE}\n${MIGRATION_LINE}`)
  assert.throws(() => transformSaveUiClient(broken), /锚点不唯一（作者迁移区/)
})

test('fail closed：已有同名桥但无标记', () => {
  const broken = fixtureSource().replace('function TavernStatusTab(props) {', `function ${SAVE_UI_BRIDGE}(props) { return null }\n\t\tfunction TavernStatusTab(props) {`)
  assert.throws(() => transformSaveUiClient(broken), /拒绝覆盖/)
})

test('fail closed：标记在但缺桥调用（完整性）⇒ 拒绝', () => {
  const applied = transformSaveUiClient(fixtureSource())
  const without = applied.split('\n').filter(line => line.trim() !== BRIDGE_CALL_LINE).join('\n')
  assert.equal(without.includes(SAVE_UI_MARKER), true, '仍应保留标记')
  assert.equal(without.includes(SAVE_UI_BRIDGE), true, '仍应保留桥定义/名字')
  assert.throws(() => transformSaveUiClient(without), /实现不完整/)
})

test('接缝输出不含写死颜色（主题语义变量/无样式）', () => {
  const out = transformSaveUiClient(fixtureSource())
  const block = seamBlock(out) + '\n' + BRIDGE_CALL_LINE
  assert.equal(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/.test(block), false)
  assert.equal(/\b(?:rgb|rgba|hsl|hsla)\(/.test(block), false)
})

test('离线真身（存在才跑）：源码与产物同构、可双向 transform、幂等', () => {
  const srcPath = path.join(BASELINE, 'src/client/main.js')
  const bundlePath = path.join(BASELINE, 'lib/client.js')
  if (!existsSync(srcPath) || !existsSync(bundlePath)) return
  const src = readFileSync(srcPath, 'utf8')
  const bundle = readFileSync(bundlePath, 'utf8')
  const srcOut = transformSaveUiClient(src)
  const bundleOut = transformSaveUiClient(bundle)
  assert.equal(srcOut.split(SAVE_UI_MARKER).length - 1, 1)
  assert.equal(bundleOut.split(SAVE_UI_MARKER).length - 1, 1)
  assert.equal(seamBlock(srcOut), seamBlock(bundleOut), '源码与产物的桥定义必须逐字一致')
  assert.equal(srcOut.split('\n').findIndex(line => line.trim() === BRIDGE_CALL_LINE) > 0, true)
  assert.equal(bundleOut.split('\n').findIndex(line => line.trim() === BRIDGE_CALL_LINE) > 0, true)
  defaultSyntaxCheck(srcOut, 'main.js')
  new vm.Script(bundleOut, { filename: 'client.js' })
  assert.equal(transformSaveUiClient(srcOut), srcOut)
  assert.equal(transformSaveUiClient(bundleOut), bundleOut)
})

test('离线当前真身（存在才跑）：有作者迁移区 ⇒ 桥落在迁移区之后、重载人物卡之前', () => {
  if (!existsSync(CLEAN_CLIENT)) return
  const source = readFileSync(CLEAN_CLIENT, 'utf8')
  assert.equal(source.includes(MIGRATION_LINE), true, '真身应含作者迁移区渲染点')
  const out = transformSaveUiClient(source)
  assert.equal(out.split(SAVE_UI_MARKER).length - 1, 1)
  const lines = out.split('\n')
  const migration = lines.findIndex(line => line.trim() === MIGRATION_LINE)
  assert.ok(migration > 0, '应能定位作者迁移区那一行')
  assert.equal(lines[migration + 1].trim(), BRIDGE_CALL_LINE, '桥必须紧邻作者迁移区之后')
  assert.equal(lines[migration + 2].trim().startsWith('["story", "script"].includes('), true, '桥之后应是重载人物卡分支')
  assert.equal(lines[migration + 1].match(/^[ \t]*/)[0], lines[migration].match(/^[ \t]*/)[0], '缩进与迁移区一致')
  new vm.Script(out, { filename: 'blank-clean-client-0930.js' })
  assert.equal(transformSaveUiClient(out), out, '真身幂等')
})
