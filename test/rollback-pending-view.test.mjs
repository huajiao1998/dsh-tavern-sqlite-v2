import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyRollbackPendingViewTransform} from '../deploy/rollback-pending-view-transform.mjs'
test('实际半提交视图仍指向53可重试，不把已回退到52当成下一删除目标',()=>{
 const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-chat-session-state.js',import.meta.url),'utf8')
 const next=applyRollbackPendingViewTransform(source);assert.equal(applyRollbackPendingViewTransform(next),next)
 const start=next.indexOf('  function rollbackViewFields'),end=next.indexOf('    const mappings = normalizedMappings',start)
 const run=new Function(next.slice(start,end)+'\n};return rollbackViewFields;')()
 const result=run({sessionId:'fixture',messages:[{role:'assistant',turn:52}],rollbackPending:{turn:53}}, {})
 assert.equal(result.rollbackTargetTurn,53);assert.equal(result.canRollback,true);assert.equal(result.canRegenerate,false)
})
