// 统一回退忙资格放开（独占新叶）：只对已签 kind:'rollback' 的统一目标放开 running/busy/settlement 的按钮禁止，
// regen/edit 的 gate 一律不动；已装旧 transform 必须能幂等升级（不是"一见 marker 就跳过"）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyAuthorRollbackActionTransform } from '../deploy/rollback-sync-author-transform.mjs'

const TREE = fileURLToPath(new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/', import.meta.url))
const PLAY_CONTROLS = 'tavern-plugin/src/client/features/play-controls.js'
const MARKER = '// [dsh-tavern-unified-rollback-busy-relax:v1]'
const BLOCKED_NEW = '\t\t\tconst blocked = rolling;'
const BLOCKED_OLD = '\t\t\tconst blocked = rolling || frontRunning || regenBusy || activity.busy || settlementActive;'
const REGEN_GATE = 'disabled: frontRunning || (!canReplayFailed && activity.busy && !settlementActive) || regenBusy || replayBusy'
const EDIT_GATE = 'disabled: busy || running || activity.busy, onClick: openEditor'
const inline = source => import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
const count = (text, needle) => text.split(needle).length - 1

test('统一回退忙资格放开：kind rollback 时 busy/running 不 disable 且 regen/edit 不动，幂等升级', async () => {
  const raw = readFileSync(new URL(PLAY_CONTROLS, new URL('file:///' + TREE.replace(/\\/g, '/'))), 'utf8')
  const seamed = applyAuthorRollbackActionTransform(raw)
  assert.ok(seamed.includes(MARKER), '必须注入忙资格放开标记')
  assert.ok(seamed.includes('const signedUnifiedTarget = !!(rollbackViewState.view && rollbackViewState.view.rollbackTarget && rollbackViewState.view.rollbackTarget.kind === \'rollback\')'))
  assert.ok(seamed.includes(BLOCKED_NEW), '所有回退入口仅rolling互斥，忙状态交执行端取消')
  assert.ok(seamed.includes('将先停止当前发送，再回退到这条消息之前'), '按钮 title 必须提示会先停止当前发送')
  // regen（重新生成）与编辑正文的 gate 必须逐字未动。
  assert.equal(count(seamed, REGEN_GATE), count(raw, REGEN_GATE), 'regen gate 必须未动')
  assert.equal(count(seamed, EDIT_GATE), count(raw, EDIT_GATE), 'edit gate 必须未动')
  assert.equal(count(seamed, BLOCKED_OLD), 0, '旧 blocked 行不得残留')
  // 真实执行被改后的表达式：所有目标协议都不按业务忙状态禁用；没有可回退发送由目标选择器判断。
  const lines = seamed.split('\n').filter(line => line.includes('const signedUnifiedTarget =') || line.includes('const blocked = rolling;'))
  assert.equal(lines.length, 2, '必须抽出两行真实表达式')
  const mod = await inline(`export const blockedOf = (rolling, frontRunning, regenBusy, activity, settlementActive, rollbackViewState) => {\n${lines.map(line => line.replace(/^\t+/, '')).join('\n')}\n  return blocked\n}\n`)
  const unified = { view: { rollbackTarget: { kind: 'rollback', turn: 25 } } }
  const native = { view: { rollbackTarget: { kind: 'native-only', turn: 25 } } }
  assert.equal(mod.blockedOf(false, true, false, { busy: true }, false, unified), false, '统一目标 + 前台 running ⇒ 可点')
  assert.equal(mod.blockedOf(false, false, false, { busy: true }, false, unified), false, '统一目标 + activity busy ⇒ 可点')
  assert.equal(mod.blockedOf(false, false, false, { busy: false }, true, unified), false, '统一目标 + settlement 活跃 ⇒ 可点')
  assert.equal(mod.blockedOf(true, false, false, { busy: false }, false, unified), true, '物理回退进行中（rolling）仍必须禁')
  assert.equal(mod.blockedOf(false, false, true, { busy: false }, false, unified), false, '统一目标重生成中仍可发起取消回退')
  assert.equal(mod.blockedOf(false, true, false, { busy: true }, false, {}), false, '不以目标协议类型和忙状态禁止发起')
  assert.equal(mod.blockedOf(false, true, false, { busy: true }, false, native), false, '旧native-only目标同样由执行端收口')
  // 幂等 + 旧代已施缝树升级：移除 marker 并把 blocked 退回旧行后，再次施缝必须补上（不得一见 marker 就跳过整段）。
  assert.equal(applyAuthorRollbackActionTransform(seamed), seamed, '二次施缝必须零改写')
  const legacy = seamed.replace(lines[1], BLOCKED_OLD).replace(MARKER, '')
  assert.ok(!legacy.includes(MARKER) && legacy.includes(BLOCKED_OLD), '旧代形态构造必须成立')
  const markedOld=seamed.replace(BLOCKED_NEW,'\t\t\tconst blocked = rolling || (!signedUnifiedTarget && (frontRunning || regenBusy || activity.busy || settlementActive));')
  assert.equal(applyAuthorRollbackActionTransform(markedOld),seamed,'上一代带marker条件门也必须升级')
  const upgraded = applyAuthorRollbackActionTransform(legacy)
  assert.ok(upgraded.includes(MARKER) && upgraded.includes(BLOCKED_NEW), '旧代已施缝树必须就地升级')
  assert.equal(applyAuthorRollbackActionTransform(upgraded), upgraded, '升级后仍必须幂等')
})
