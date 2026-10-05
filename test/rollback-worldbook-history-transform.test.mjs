// 仅验证本轮新增Host/时间线引用消费者锚点，不冒充整包安装或页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyRollbackWorldbookHistoryHostTransform} from '../deploy/rollback-worldbook-history-transform.mjs'
import {applyHostTransform} from '../deploy/core-host-transform.mjs'
import {applyCompactionWarningTransform} from '../deploy/compaction-warning-transform.mjs'
import {applyBackgroundHostRollbackTransform} from '../deploy/background-rollback-transform.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackBackgroundOwnerHostTransform} from '../deploy/rollback-background-lifetime-transform.mjs'
import {applyRollbackCharacterHostTransform} from '../deploy/rollback-character-transform.mjs'
import {applyRollbackWorldbookHostTransform} from '../deploy/rollback-worldbook-transform.mjs'
import {applyRollbackWorldbookBindingsHostTransform} from '../deploy/rollback-worldbook-bindings-transform.mjs'
import {applyRollbackSharedBranchHostTransform} from '../deploy/rollback-shared-branch-transform.mjs'
import {applyRollbackBodySignalHostTransform} from '../deploy/rollback-body-signal-transform.mjs'
import {applyRollbackBodyCommitHostTransform} from '../deploy/rollback-body-commit-transform.mjs'
import {applyRollbackSyncHostTransform} from '../deploy/rollback-sync-author-transform.mjs'
import {transformLegacyIndex} from '../deploy/apply-legacy-view-seams.mjs'
import {transformStorageIndex} from '../deploy/apply-seams.mjs'
import {applyRowTimelineTransform} from '../deploy/row-rollback-transform.mjs'
import {applyRollbackBusinessTimelineTransform} from '../deploy/rollback-business-transform.mjs'
import {captureRollbackBusinessState} from '../lib/rollback-business-state.js'
test('Host当前书ref捕获与所选历史解析同时接线，幂等且残缺拒绝',()=>{
 const source="const storyTimeline = createStoryTimeline({ id: uid, now: Date.now })\nconst chats = { rollbackArchivePath: chatJournalStore.rollbackArchivePath },"
 const next=applyRollbackWorldbookHistoryHostTransform(source)
 assert.match(next,/readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef\(chat\)/)
 assert.match(next,/readRollbackWorldbook: chatJournalStore.readRollbackWorldbook/)
 assert.equal(applyRollbackWorldbookHistoryHostTransform(next),next)
 assert.throws(()=>applyRollbackWorldbookHistoryHostTransform(next.replace('readCurrentRollbackWorldbookRef','missing')),/不完整/)
})
test('真实作者timeline暴露瘦基准capture并接同步历史读取，回退不修改当前书消费者',async()=>{
 const original=readFileSync(new URL('../../../tmp/upstream-audit-20261003/head/tavern-plugin/lib/domain/story-timeline.js',import.meta.url),'utf8')
 const transformed=applyRollbackBusinessTimelineTransform(applyRowTimelineTransform(original))
 assert.equal(applyRollbackBusinessTimelineTransform(transformed),transformed)
 assert.throws(()=>applyRollbackBusinessTimelineTransform(transformed.replace('captureBusiness: chat =>','missingCapture: chat =>')),/不完整/)
 const source=transformed.replace("'./storage-rollback-business.js'",JSON.stringify(new URL('../lib/rollback-business-state.js',import.meta.url).href)).replace("'./scoped-messages.js'",JSON.stringify(new URL('../../../tmp/upstream-audit-20261003/head/tavern-plugin/lib/domain/scoped-messages.js',import.meta.url).href))
 const {createStoryTimeline}=await import('data:text/javascript;base64,'+Buffer.from(source,'utf8').toString('base64'))
 const ref={version:1,chatId:'synthetic',bookId:1},book={version:1,document:{entries:[{uid:0,content:'原创世界书'}]}}
 const timeline=createStoryTimeline({readRollbackWorldbookRef:()=>ref,readRollbackWorldbook:()=>structuredClone(book)})
 const chat={id:'synthetic',_storageRevision:1,messages:[],openingWorldbookSnapshot:book}
 const baseline=timeline.captureBusiness(chat)
 assert.deepEqual(baseline.worldbookRef,ref);assert.equal(Object.hasOwn(baseline.fields,'openingWorldbookSnapshot'),false)
 assert.deepEqual(chat.openingWorldbookSnapshot,book)
 const begun=timeline.apply({chat,intent:{kind:'body.begin',turn:1,userText:'输入'}})
 assert.deepEqual(begun.chat.timeline.operations[begun.value.operationId].businessBefore.worldbookRef,ref)
 const completed=timeline.complete({chat:begun.chat,operationId:begun.value.operationId,basedOn:begun.value.basedOn,outcome:{status:'success'}}).chat
 completed.messages=[{role:'user',turn:1,text:'输入'},{role:'assistant',turn:1,text:'正文'}]
 completed.openingWorldbookSnapshot={version:1,document:{entries:[{uid:0,content:'本轮新书'}]}}
 const rolled=timeline.apply({chat:completed,intent:{kind:'turn.rollback',turn:1,rowCheckpointId:completed.timeline.checkpoints.at(-1).id}}).chat
 assert.deepEqual(rolled.openingWorldbookSnapshot,book,'真实timeline.restore接到所选版本，不用当前书')
 assert.equal(Object.hasOwn(captureRollbackBusinessState(chat).fields,'openingWorldbookSnapshot'),true,'旧内联仍支持')
})
test('真实作者lib/index按源码序施完全部前置Host缝后，本档书历史接线两callback与chats读取就位、幂等且残缺拒绝',()=>{
 // 前置链与顺序照标准接入源码序，不写任何作者缓存文件、不改无关消费者。
 // 身份门（2026-10-05 换源）：旧读源 tmp/upstream-audit-20261003/head 是前代审计快照（compaction
 // 前置缝锚点对不上）；lib/index 只喂 upstream25-author-fixture 的 2.5.0 真源（与 standard-seams 同源）。
 const original=readFileSync(new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/index.js',import.meta.url),'utf8')
 const pre=[applyHostTransform,applyCompactionWarningTransform,applyBackgroundHostRollbackTransform,applyRollbackHostTransform,applyRollbackGlobalHostTransform,applyRollbackBackgroundOwnerHostTransform,applyRollbackCharacterHostTransform,applyRollbackWorldbookHostTransform,applyRollbackWorldbookBindingsHostTransform,applyRollbackSharedBranchHostTransform,applyRollbackBodySignalHostTransform,applyRollbackBodyCommitHostTransform]
 let source=transformLegacyIndex(transformStorageIndex(original))
 for(const fn of pre)source=fn(source)
 const before=applyRollbackSyncHostTransform(source)
 // 接线前的旧锚点必须已由前置缝建立，且不得提前带新Host标记。
 assert.equal(before.includes('// [dsh-tavern-worldbook-history-host:v1]'),false,'旧baseline不得预先带新Host标记')
 assert.equal(before.split('rollbackArchivePath: chatJournalStore.rollbackArchivePath },').length-1,1,'rollbackArchivePath锚点应由前置Host缝唯一建立')
 const next=applyRollbackWorldbookHistoryHostTransform(before)
 assert.equal(next.split('// [dsh-tavern-worldbook-history-host:v1]').length-1,1)
 // 时间线两callback：当前书ref捕获 + 所选历史读取。
 assert.match(next,/createStoryTimeline\(\{ id: uid, now: Date.now, readRollbackWorldbook: \(chat, ref\) => chatJournalStore\.readRollbackWorldbook\(chat, ref\), readRollbackWorldbookRef: chat => chatJournalStore\.readCurrentRollbackWorldbookRef\(chat\) \}\)/)
 assert.equal(next.split('readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat)').length-1,1)
 assert.equal(next.split('readRollbackWorldbook: (chat, ref) => chatJournalStore.readRollbackWorldbook(chat, ref)').length-1,1)
 // 回退业务消费者chats面暴露历史读取，且仍保留原有rollbackArchivePath。
 assert.match(next,/rollbackArchivePath: chatJournalStore\.rollbackArchivePath, readRollbackWorldbook: chatJournalStore\.readRollbackWorldbook \},/)
 assert.equal(next.split('readRollbackWorldbook: chatJournalStore.readRollbackWorldbook }').length-1,1)
 // 幂等：二次apply返回同一字符串。
 assert.equal(applyRollbackWorldbookHistoryHostTransform(next),next)
 // 残缺：标记在但消费者不全时拒绝，不静默放过。
 assert.throws(()=>applyRollbackWorldbookHistoryHostTransform(next.replace('readCurrentRollbackWorldbookRef','missing')),/不完整/)
 assert.throws(()=>applyRollbackWorldbookHistoryHostTransform(next.replace('readRollbackWorldbook: chatJournalStore.readRollbackWorldbook }','readRollbackWorldbook: missing }')),/不完整/)
})
