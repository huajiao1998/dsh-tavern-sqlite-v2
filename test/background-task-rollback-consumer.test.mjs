// 定向闸：真实后台任务入口的await/错误/无边界与Host接线；只原创fixture，不读用户数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, existsSync } from 'node:fs'
import { applyBackgroundTaskRollbackTransform, applyBackgroundHostRollbackTransform } from '../deploy/background-rollback-transform.mjs'
const sourceUrl = new URL('../../../tmp/projection-baseline-1001/background-agent-task.js', import.meta.url)
test('真实后台入口：不调用软回退，等待物理回退后才继续；缺接线/失败不继续', async t => {
  if (!existsSync(sourceUrl)) return t.skip('缺真实源码fixture')
  const source=readFileSync(sourceUrl,'utf8'),next=applyBackgroundTaskRollbackTransform(source)
  assert.equal(applyBackgroundTaskRollbackTransform(next),next)
  const start=next.indexOf('    // [dsh-tavern-background-task-rewind:v1]')
  const end=next.indexOf('    const progress =',start)
  assert.ok(start>=0 && end>start)
  const consumer=vm.runInNewContext('(async function(options,agent,input){const traceSessionId="background-fixture";'+next.slice(start,end)+';return "continued"})')
  let release,called=0,recorded=0,done=false
  const agent={session:{seq:100}}
  const pending=consumer({rewindSession(subject,boundary){called++;assert.equal(boundary,62);assert.equal(subject,agent);return new Promise(resolve=>release=()=>{subject.session.seq=63;resolve()})},recordRollbackBoundary(input,session){recorded++;assert.equal(session.seq,63)}},agent,{rewindTo:62}).then(v=>{done=true;return v})
  assert.equal(called,1);assert.equal(recorded,0);assert.equal(done,false);release();assert.equal(await pending,'continued');assert.equal(recorded,1)
  assert.equal(await consumer({recordRollbackBoundary(){}}, {}, {rewindTo:null}),'continued')
  await assert.rejects(consumer({}, {}, {rewindTo:null}),/seq归属记录/)
  await assert.rejects(consumer({}, {}, {rewindTo:62}),/后台历史回退失败/)
  const underlying=Object.assign(new Error('缺少宿主服务'),{code:'ROLLBACK_PREFLIGHT_NO_PROJECTIONS'})
  await assert.rejects(consumer({rewindSession(){throw underlying}},{},{rewindTo:104}),error=>{
    assert.match(error.message,/原因 \[ROLLBACK_PREFLIGHT_NO_PROJECTIONS\]：缺少宿主服务/)
    assert.equal(error.cause,underlying)
    assert.equal(error.code,underlying.code)
    assert.equal(error.traceSessionId,'background-fixture')
    return true
  })
  assert.throws(()=>applyBackgroundTaskRollbackTransform(source.replace('try { rewindBackgroundSurface','try { changedSurface')),/锚点/)
})
test('真实后台入口：变量结算 rewindTo:-1 也 await 物理回退并登记 seq 归属', async t => {
  if (!existsSync(sourceUrl)) return t.skip('缺真实源码fixture')
  const source=readFileSync(sourceUrl,'utf8'),next=applyBackgroundTaskRollbackTransform(source)
  const start=next.indexOf('    // [dsh-tavern-background-task-rewind:v1]')
  const end=next.indexOf('    const progress =',start)
  assert.ok(start>=0 && end>start)
  const consumer=vm.runInNewContext('(async function(options,agent,input){const traceSessionId="background-fixture";'+next.slice(start,end)+';return "continued"})')
  let release,called=0,recorded=0,done=false
  const agent={session:{seq:6}}
  const pending=consumer({
    rewindSession(subject,boundary){called++;assert.equal(boundary,-1,'-1（新建participant）必须原样传给物理回退，不得跳过');assert.equal(subject,agent);return new Promise(resolve=>release=()=>{subject.session.seq=7;resolve()})},
    recordRollbackBoundary(input,session){recorded++;assert.equal(input.rewindTo,-1);assert.equal(session.seq,7,'归属登记必须在物理回退之后')},
  },agent,{rewindTo:-1}).then(v=>{done=true;return v})
  assert.equal(called,1,'-1 是真物理回退路径（Number.isSafeInteger(-1) 为真），不是软回退')
  assert.equal(recorded,0,'await 未完成前不得登记')
  assert.equal(done,false)
  release()
  assert.equal(await pending,'continued')
  assert.equal(recorded,1)
})
test('Host消费者：动态拿真实服务与后台agent，无systemd/前台turn反推',()=>{
 const source='  const backgroundAgentRunner = createBackgroundAgentRunner({\n    agents: registry,\n  })'
 const next=applyBackgroundHostRollbackTransform(source)
 assert.equal(applyBackgroundHostRollbackTransform(next),next)
 assert.match(next,/agentProvider: \(\) => agent/)
 assert.match(next,/await cleanupAfterRollbackAtSeq\(persistence, agent.session, boundarySeq, services, \{ head \}\)/)
 assert.doesNotMatch(next,/hiddenTurn|systemctl|rewindBackgroundSurface/)
})
