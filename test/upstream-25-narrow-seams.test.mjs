// 上游2.5.0(5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60)窄缝最小断言：
// 仅验证 opening generate 传递与 compaction 合并投影，不冒充整包安装/部署/页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyOpeningRuntimeTransform} from '../deploy/opening-runtime-transform.mjs'
import {applyCompactionWarningTransform} from '../deploy/compaction-warning-transform.mjs'

const upstream = name => readFileSync(new URL(`../../../tmp/upstream-review-20261005-seams/raw/${name}`, import.meta.url), 'utf8')
const openingSource = () => upstream('tavern-plugin__lib__domain__opening-preparation.js')
const indexSource = () => upstream('tavern-plugin__lib__index.js')

test('固定作者2.5 raw确为带generate DI与多行fork投影的形态，不作假锚点', () => {
  const opening = openingSource()
  const index = indexSource()
  assert.equal(opening.split('createOpeningPreparation({ readCard, worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, now = Date.now })').length - 1, 1)
  assert.equal((index.split('forkTurnsByMessageId: forkTurnsForChat(chat)').length - 1) >= 1, true)
  assert.equal(index.split('function volatileSessionViewFields(chat, activity, changes) {').length - 1, 1)
  // 旧2.4单行签名锚点在2.5确不存在（证明本测试打的是真实新形态，而非沿用旧锚点）。
  assert.equal(opening.includes('createOpeningPreparation({ readCard, worldBooks, generateRaw, readRuntimeExtensions'), false)
})

test('opening：新签名下只加标记并原样传递作者generate/generateRaw，吞参数即拒', () => {
  const next = applyOpeningRuntimeTransform(openingSource())
  // 标记落在作者DI名单内，作者generate仍在、generateRaw仍在、我们只追加dispatchMarksProvider。
  assert.equal(next.split('generate, generateRaw, readRuntimeExtensions, extensionSettings, dispatchMarksProvider, now = Date.now })').length - 1, 1)
  assert.equal(next.split('generate, generateRaw, readRuntimeExtensions, extensionSettings, now = Date.now })').length - 1, 0, '旧签名不得残留')
  // 本缝不得复刻作者Helper生成消费面：以作者源为基线做差分（作者源自带 createHelperGenerationTasks，不能整串判0）。
  const helperGenerationRefs = s => (s.match(/createHelperGenerationTasks|helperGenerationPreset|validateHelperGenerateConfig|identifyHelperModelMessages/g) || []).length
  assert.equal(helperGenerationRefs(next), helperGenerationRefs(openingSource()), '本缝净新增0处Helper生成实现')
  // 本档书来源/服务端归属/dispatch标记三项消费者完整。
  assert.equal(next.split('draft.initializationWorldbookSources =').length - 1, 1)
  assert.equal(next.split('initializationWorldbookSources: copy(draft.initializationWorldbookSources)').length - 1, 1)
  assert.equal(next.split('serverOwned: true').length - 1, 1)
  assert.equal(next.split('storageBrowserScripts(draft.helperScripts, { store: dispatchMarksProvider?.(), cardPath: draft.cardPath })').length - 1, 1)
  // 幂等：二次apply返回同一字符串。
  assert.equal(applyOpeningRuntimeTransform(next), next)
  // 半标记拒绝：标记在但作者generate DI被吞 → 抛错，不静默放过。
  assert.throws(() => applyOpeningRuntimeTransform(next.replace('worldBooks, generate, generateRaw,', 'worldBooks, generateRaw,')), /作者generate DI被吞/)
  // 半标记拒绝：标记在但dispatchMarksProvider被回退成作者原签名 → 拒绝（签名必须保持我们合并后的形态）。
  assert.throws(() => applyOpeningRuntimeTransform(next.replace(', dispatchMarksProvider, now = Date.now })', ', now = Date.now })')), /作者generate DI被吞/)
  // 半标记拒绝：标记在但来源消费者残缺 → 抛错（破坏的是守卫生效的那一项）。
  assert.throws(() => applyOpeningRuntimeTransform(next.replace('draft.initializationWorldbooks =', 'missing =')), /消费者不完整/)
  assert.throws(() => applyOpeningRuntimeTransform(next.replace('await initializeOpeningRuntime({ draft,', 'await initializeOpeningRuntime({ other,')), /消费者不完整/)
  assert.throws(() => applyOpeningRuntimeTransform(next.replace('serverOwned: true', 'serverOwned: false')), /消费者不完整/)
  // 未知来源fail closed：作者签名既非2.4也非2.5可有形态时，不得产出半初始化结果。
  assert.throws(() => applyOpeningRuntimeTransform(openingSource().replace('worldBooks, generate, generateRaw,', 'worldBooks, generateRaw,')), /锚点不唯一/)
})

test('opening：作者generate/generateRaw真被透传到初始化调用，且generationContext按当前草稿当场构造', () => {
  const next = applyOpeningRuntimeTransform(openingSource())
  // 透传：初始化调用点必须把作者的 generate / generateRaw 原样交出去（不是吞掉、不是自造实现）。
  assert.equal(next.split(', generate, generateRaw,\n').length - 1, 1, '作者两个生成DI必须原样透传给 initializeOpeningRuntime')
  assert.equal(next.split('worldbook: draft.document ? projectTavernHelperWorldbook(inspectWorldBookDocument(draft.document)) : null, generate, generateRaw,').length - 1, 1)
  // generationContext：作者编译器期望的上下文由**当前私有草稿**当场构造（chat 参数真被使用）。
  const block = next.slice(next.indexOf('generationContext: (chat, signal) => ({'), next.indexOf('history: helperGenerationHistory(chat) }) }))'))
  assert.ok(block.length > 200, '必须抽出真实 generationContext 块')
  assert.equal(block.includes('sessionId: draft.sourceSessionId'), true, 'sessionId 取私有草稿来源会话')
  assert.equal(block.includes('chat,'), true, 'chat 即调用当场传入的当前草稿')
  assert.equal(block.includes('card: draft.card'), true, 'card 取当前私有草稿')
  assert.equal(block.includes('presetSnapshot: draft.presetSnapshot'), true)
  assert.equal(block.includes('characterVariables: draft.characterVariables'), true)
  assert.equal(block.includes('history: helperGenerationHistory(chat)'), true, 'history 由 chat 参数当场投影')
  // 不得在生成块内回落"持久化最新"读法。
  assert.equal(block.includes('readHelperContext('), false, '开局生成块内不得回落持久化 helper 上下文')
  assert.equal(block.includes('getSession('), false, '开局生成块内不得读会话存档')
  // 幂等：追加本组断言不改产物语义。
  assert.equal(applyOpeningRuntimeTransform(next), next)
})

test('compaction：2.5多行volatile合并投影，保留作者fork新字段并追加我们的警告字段', () => {
  const next = applyCompactionWarningTransform(indexSource())
  // 作者新字段原样保留（fork=新字段，不是“已有warning”，不得删除）。
  assert.equal(next.split('forkTurnsByMessageId: forkTurnsForChat(chat)').length - 1, 1)
  // 我们的压缩警告字段进入同一投影与快照字段。
  assert.match(next, /function volatileSessionViewFields\(chat, activity, changes\) \{\s+return \{ \.\.\.sessionStateView\.volatile\(chat, activity, changes\), contextCompaction: projectCompactionWarning\(chat\.contextCompaction, ctx\.llm\.listProviders\(\)\)/)
  assert.equal(next.split('contextCompaction: projectCompactionWarning(chat.contextCompaction, ctx.llm.listProviders()),').length - 1, 2, '快照字段与投影字段各接一次')
  assert.equal(next.split("from './domain/storage-compaction-warning.js'").length - 1, 1)
  // 合并后投影行仍是单条作者行，未经整段替换丢失字段：warning与fork同处一行。
  assert.match(next, /changes\), contextCompaction: projectCompactionWarning\(chat\.contextCompaction, ctx\.llm\.listProviders\(\)\), forkTurnsByMessageId: forkTurnsForChat\(chat\) \}/)
  // 幂等。
  assert.equal(applyCompactionWarningTransform(next), next)
  // 半标记拒绝：标记在但合并投影被退回单行 → 抛错。
  assert.throws(() => applyCompactionWarningTransform(next.replace(', contextCompaction: projectCompactionWarning(chat.contextCompaction, ctx.llm.listProviders())', '')), /消费者缺失/)
  // 半标记拒绝：标记在但fork新字段被删 → 抛错（不能说fork=已有warning就删）。
  assert.throws(() => applyCompactionWarningTransform(next.replace(', forkTurnsByMessageId: forkTurnsForChat(chat)', '')), /消费者缺失/)
  // 未知形态fail closed：既非2.4单行也非2.5多行时不得静默产出。
  const orphan = indexSource().replace('function volatileSessionViewFields(chat, activity, changes) {', 'function volatileSessionViewFields(chat, activity) {')
  assert.throws(() => applyCompactionWarningTransform(orphan), /锚点不唯一/)
})
