// 正文物理采用的恢复路径：先完成采用与结算，再发布当前状态；广播故障保留已采用正文。
// 恢复仅待结算时接续原周期，已完成则只补当前同步，不重写SQL或重新生成。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './regeneration-rollback-integration.test.mjs'

const CHAT_ID = 'chat-regen-rollback-fixture'
const COMPLETION_KEYS = ['version', 'id', 'turn', 'sessionId', 'revision', 'branchId', 'eventCount', 'attemptRange']
const texts = value => { const out = []; const walk = v => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk) }; walk(value); return out }
const rowsOf = db => db.stmts.selectEvents.all().map(row => ({ seq: Number(row.seq), type: row.type, data: JSON.parse(row.data_json) }))

test('正文采用恢复：广播故障保留新正文且恢复不再生成、不误走abort', async () => {
  const f = await fixture({ physical: true })
  try {
    assert.equal(rowsOf(f.mainDb).some(row => texts(row.data).includes('原53')), true, '前置：SQL 内必须有原轮正文')

    f.faults.broadcast = new Error('fixture broadcast failure')
    await assert.rejects(() => f.roundHistory.regenerate(CHAT_ID, '补充要求'), /fixture broadcast failure/, '广播故障必须抛给调用方')
    assert.equal(f.syncFrames.length, 0, '广播在 push 前抛出，此时不得有同步帧')

    const adopted = await f.read()
    assert.equal(adopted.regenRecovery, undefined, 'complete 已在广播前删除重生成记录')
    assert.equal(adopted.regenInProgress, undefined, 'complete 已在广播前清掉进行中标记')
    const completion = adopted.regenerationCompletion
    assert.deepEqual(Object.keys(completion ?? {}).sort(), [...COMPLETION_KEYS].sort(), 'completion 只含小型完成坐标与连续重生成所用attemptRange')
    assert.deepEqual(Object.keys(completion.attemptRange).sort(), ['end', 'start'])
    assert.ok(Number.isSafeInteger(completion.attemptRange.start) && completion.attemptRange.start < completion.attemptRange.end)
    assert.equal(completion.attemptRange.end, f.session.seq, '范围消费真实SQL采用后的坐标，不携带旧正文副本')
    assert.equal(completion.version, 1)
    assert.equal(completion.turn, 53)
    assert.equal(texts(completion).includes('原53'), false, 'completion 不得携带正文')
    assert.equal(texts(completion).some(text => text.length > 40), false, 'completion 不得夹带长正文文本')

    const afterFault = rowsOf(f.mainDb)
    assert.equal(afterFault.some(row => row.type === 'assistant/message' && Number(row.data?.turn) === 53 && texts(row.data).includes('原53')), false, '旧 53 assistant 正文必须已在 SQL 中物理删除')
    assert.equal(afterFault.some(row => row.type === 'user/message' && row.data?.source?.kind === 'user'), true, '原 user 必须仍在 SQL')
    const assistants53 = afterFault.filter(row => row.type === 'assistant/message' && Number(row.data?.turn) === 53)
    assert.equal(assistants53.length, 1, '原轮必须恰有一条 assistant（新正文已写回原轮）')
    assert.equal(assistants53.some(row => texts(row.data).includes('原53')), false, '新正文不得是旧正文')

    f.faults.broadcast = null
    let followups = 0
    const originalFollowup = f.agent.followup
    f.agent.followup = (...args) => { followups += 1; return originalFollowup.apply(f.agent, args) }
    const seqBefore = f.session.seq, lastTurnBefore = f.agent.phase.lastTurn
    const revisionBefore = adopted._storageRevision, sqlBefore = rowsOf(f.mainDb)
    await f.roundHistory.recover(CHAT_ID)
    const recovered = await f.read()
    assert.equal(followups, 0, '恢复不得触发 agent.followup（不重新生成）')
    assert.equal(recovered._storageRevision, revisionBefore, '恢复不得改变 Chat revision（零 Chat 写）')
    assert.deepEqual(recovered.regenerationCompletion, completion, '完成凭据必须保留且逐字不变')
    assert.equal(recovered.regenRecovery, undefined, '恢复后不得残留重生成记录')
    assert.deepEqual(rowsOf(f.mainDb), sqlBefore, '恢复不得重写 SQL')
    assert.equal(f.syncFrames.at(-1).value.revision, recovered._storageRevision, '补发的 sync revision 必须等于当前 Chat revision')
    assert.equal(f.session.seq, seqBefore, '恢复不得新增原生事件')
    assert.equal(f.agent.phase.lastTurn, lastTurnBefore, '恢复不得推进轮次')
  } finally { await f.cleanup() }
})

test('正文生成失败：失败尾物理清除且原正文保留', async () => {
  const f = await fixture({ physical: true })
  try {
    const before = rowsOf(f.mainDb)
    assert.equal(before.some(row => row.type === 'assistant/message' && Number(row.data?.turn) === 53), true, '前置：原轮正文在 SQL 内')
    // 真实接口：followup 提交临时尾（seam 后由 agent.followup 驱动），whenIdle 抛错模拟生成失败。
    let followups = 0, tempTask
    const originalFollowup = f.agent.followup
    f.agent.followup = message => { followups += 1; tempTask = f.commitTurn(54, '临时54', message?.source) }
    const originalWhenIdle = f.agent.whenIdle
    f.agent.whenIdle = async () => { await tempTask; throw new Error('fixture generation failure') }
    try {
      await assert.rejects(() => f.roundHistory.regenerate(CHAT_ID, '补充要求'), /fixture generation failure/, '生成失败必须抛给调用方')
    } finally { f.agent.followup = originalFollowup; f.agent.whenIdle = originalWhenIdle }

    assert.equal(followups, 1, '生成阶段必须只调用一次 followup')
    const chat = await f.read()
    const rows = rowsOf(f.mainDb)
    assert.equal(rows.some(row => row.type === 'assistant/message' && Number(row.data?.turn) === 53), true, '原 assistant 必须保留')
    assert.equal(rows.some(row => row.type === 'assistant/message' && Number(row.data?.turn) === 53 && texts(row.data).includes('原53')), true, '原正文文本必须逐字保留')
    assert.equal(rows.some(row => row.type === 'user/message' && row.data?.source?.kind === 'user'), true, '原 user 必须保留')
    assert.equal(rows.some(row => Number(row.data?.turn) >= 54), false, '临时轮（turn>=54）必须物理清除')
    assert.equal(rows.some(row => texts(row.data).includes('临时54')), false, '临时尾正文必须物理清除')
    assert.equal(chat.regenRecovery, undefined, '失败后不得残留重生成记录')
    assert.equal(chat.regenInProgress, undefined, '失败后不得残留进行中标记')
    assert.deepEqual(rows.map(row => row.seq), f.session.snapshotEvents().map(event => event.seq), 'SQL 必须与内存 Session 一致')
  } finally { await f.cleanup() }
})
