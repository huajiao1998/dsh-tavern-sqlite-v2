// 只验新上游（04bda78）姿势去重复算法：lastSubmittedPosture 只读可见历史；回退/压缩后旧提交不可见即失效。
// fixture=官方 posture-submission.js 字节级原件（SHA 断言）；唯一 import 是 normalize 用的纯工具，本测试经 data URL 重写为本地 stub（不改原字节），lastSubmittedPosture 不依赖它。非 SDK/真实业务。
// 官方出处（非执行，仅供追溯）：https://raw.githubusercontent.com/flizzywine/dsh-tavern/04bda78eaad25adfe6979cb211a17fd85d852393/tavern-plugin/lib/domain/posture-submission.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SOURCE_SHA256 = '8f64403010ecc65ef70d44c8c4ac237ab02dc3006bc1879b4d30f80d2964f9e1'
const source = readFileSync(new URL('./fixtures/author-posture-submission-04bda78.js', import.meta.url), 'utf8')
assert.equal(createHash('sha256').update(source, 'utf8').digest('hex'), SOURCE_SHA256)
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(
  source.replace("import { resolveRuntimeMacroText } from './runtime-content-projection.js'", 'const resolveRuntimeMacroText = text => ({ text })'),
  'utf8').toString('base64')
const { lastSubmittedPosture, POSTURE_SUBMIT_TOOL_NAME } = await import(moduleUrl)

// 合成可见历史 host（正形 assistant/message + surface.nodes/eventAt），无 Session/SDK 业务。
function host() {
  const events = new Map(), nodes = []
  return {
    events, nodes,
    surface: { nodes },
    eventAt: seq => events.get(seq),
    push(seq, event) { events.set(seq, event); nodes.push(seq); return seq },
    submit(seq, args) { return this.push(seq, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: seq, name: POSTURE_SUBMIT_TOOL_NAME, arguments: args }] } } }) },
    story(seq, text) { return this.push(seq, { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }) },
    summary(seq, from) {   // 压缩/回退：可见 surface 只留摘要，旧 seq 不再可见（源事件仍在 events 里）
      const start = nodes.indexOf(from), removed = nodes.splice(start)
      return this.push(seq, { type: 'user/message', data: { id: seq, role: 'user', content: [{ type: 'text', text: '摘要' }] } }) && removed
    },
  }
}

test('新代姿势去重复仅读可见历史且回退压缩后失效', () => {
  const session = host()
  assert.equal(lastSubmittedPosture(undefined), '')
  assert.equal(lastSubmittedPosture(session), '')
  // 正形 JSON 字符串 args + 空白 trim
  session.submit('t1', JSON.stringify({ posture: ' 她站在门边。 ' }))
  assert.equal(lastSubmittedPosture(session), '她站在门边。')
  // 对象 args（非字符串）同样接受；新 turn 取最新
  session.submit('t2', { posture: '她坐回椅子上。' })
  assert.equal(lastSubmittedPosture(session), '她坐回椅子上。')
  // 其它 tool name / 普通正文 / 坏 JSON 不影响结果
  session.push('t3', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'x', name: 'mvu_submit_update', arguments: JSON.stringify({ posture: '不该被读' }) }] } } })
  session.story('t4', '她抬头看了一眼。')
  session.submit('t5', '{坏 JSON')
  assert.equal(lastSubmittedPosture(session), '她坐回椅子上。')
  // 空 posture 不采纳
  session.submit('t6', JSON.stringify({ posture: '   ' }))
  assert.equal(lastSubmittedPosture(session), '她坐回椅子上。')
  // 只读可见：Map 里存在但不在 surface.nodes 的提交不得被读到
  session.events.set('hidden', { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'hidden', name: POSTURE_SUBMIT_TOOL_NAME, arguments: JSON.stringify({ posture: '不可见的旧姿势' }) }] } } })
  assert.equal(lastSubmittedPosture(session), '她坐回椅子上。')
  const before = structuredClone(session.events.get('t2'))   // 脱离快照：证明纯函数未改写源事件
  const removed = session.summary('s1', 't1')   // 压缩/回退：t1..t6 从可见 surface 摘除
  assert.equal(removed.length >= 1, true)
  assert.equal(lastSubmittedPosture(session), '')   // 旧提交不可见 → 失效
  assert.deepEqual(session.events.get('t2'), before)  // 源事件未被改写
  // 摘要后新 turn 再提交 → 重新可见
  session.submit('t7', JSON.stringify({ posture: '她转身离开。' }))
  assert.equal(lastSubmittedPosture(session), '她转身离开。')
})
