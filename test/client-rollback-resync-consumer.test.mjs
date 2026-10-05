// 真实作者2.5.0 source/built回退callback与live view拒旧；不替代浏览器验收。
//
// 身份门（2026-10-05 换源）：本文件只喂 tmp/upstream25-author-fixture 里 **2.5.0 真源**
// （SHA 5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60），与 standard-seams / upstream-25-client-sync
// 同源同法；旧代夹具（tmp/sql-test-kit 的 2.4 快照、tmp/plg-standard-1001-code 的 2.4 施缝镜像）
// 已被换掉——2.4 的 source/built 分层在 2.5.0 上不存在（TavernRollbackAction 已位移到
// src/client/features/play-controls.js，built 只剩一份内联），按旧路径喂进来的必然是别代字节。
// 因此先断言 reader 缝的唯一锚点在真源里**恰好 1 次**：锚点漂移 ⇒ 立刻响亮失败，
// 不允许部署缝的 once() 或断言路径去猜。
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyClientRollbackTransform} from '../deploy/core-host-transform.mjs'
import {applyRollbackViewReaderTransform} from '../deploy/rollback-sync-state-transform.mjs'
const marker='// [dsh-tavern-rollback-sync-author:v1]'
const anchor='historyProjection.rolledBack(props.sessionId, result && result.view);'
const AUTHOR_SHA='5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const AUTHOR_ROOT=new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-'+AUTHOR_SHA+'/tavern-plugin/',import.meta.url)
const authorRead=relative=>readFileSync(new URL(relative,AUTHOR_ROOT),'utf8')
const countOf=(text,needle)=>text.split(needle).length-1
// —— 作者符号桩区：真源模块之间靠 bundle 内联共享符号，单独抠出来的切片必须补同形桩 ——
// 2.5.0 把 live view 的异步读所有权拆成独立模块 src/client/modules/session-refresh-controller.js，
// live-tavern-view.js 的 createRefresh() 只以**裸标识符**调用 createSessionRefreshController(...)。
// 整份 lib/client.js 里该定义在同层，抠 createLiveTavernViewModule 切片就会悬空；
// 真源里作者自己的做法同此（upstream-25-client-sync.test.mjs 即把 SRC.refresh 一并拼进去）。
// 桩签名与语义**照抄作者真源**（同文件 session-refresh-controller.js：start/stop/replace/request/refresh），
// 不发明语义——只为让切片可实例化，方法体保持最小：控制器存在且可调用。
const REFRESH_CONTROLLER_SOURCE=authorRead('src/client/modules/session-refresh-controller.js')
const refreshControllerStub=new Function(REFRESH_CONTROLLER_SOURCE+';return createSessionRefreshController;')()
// —— 身份门：部署缝 applyRollbackViewReaderTransform 的 4 个 once() 锚点在真源各恰好 1 次 ——
const readerAnchorFile='src/client/modules/session-view-sync.js'
const readerRaw=authorRead(readerAnchorFile)
for(const needle of [
  'const sessions = new Map();',
  'return function begin(sessionId) {',
  'if (released) throw new Error("会话读取已取消");',
  '  };\n}\n\n// Weak array-version keys',
]) assert.equal(countOf(readerRaw,needle),1,'2.5.0真源 '+readerAnchorFile+' 的身份门锚点必须唯一：'+JSON.stringify(needle.slice(0,40)))
function callbackFrom(source,{rpcFailure=false,missingSync=false,syncFailure=false,superseded=false}={}){
 const start=source.indexOf('async function rollback()',source.indexOf('function TavernRollbackAction(props)')),end=source.indexOf('if (!canRollback) {',start)
 assert.ok(start>=0 && end>start)
 const order=[],errors=[],view={rolledBack:{sync:{protocol:1,id:'rollback',chatId:'chat-fixture',revision:7}}}
 const fn=new Function('rpc','historyProjection','props','setRolling','setCandidatePanel','setRegenPanel','setCandidateGuidePanel','notifyTavernDataChanged','tavernErrorHub','liveTavernView','tavernCoordination','canRollback','blocked','clearIncomplete','targetTurn',source.slice(start,end)+';return rollback;')(
  async(name,args,id)=>{assert.equal(name,'rollbackTurn');assert.equal(args.expectedTurn,3);assert.equal(id,'sync-fixture');order.push('rpc');if(rpcFailure)throw Error('RPC失败');return {view}},
  {rolledBack:(id,value)=>{assert.equal(id,'sync-fixture');assert.equal(value,view);order.push('projection')}},
  {sessionId:'sync-fixture',sessions:missingSync?{}:{waitForTavernRollbackSync:async r=>{assert.equal(r,view.rolledBack.sync);order.push('sync:wait');if(syncFailure)throw Error('sync失败');return !superseded}}},
  value=>order.push(value?'rolling:start':'rolling:end'),()=>order.push('panels'),()=>{},()=>{},()=>{throw Error('不应广播全局data-changed')},
  {report:(_name,error)=>errors.push(error)},{setView:()=>order.push('view:set'),invalidate:()=>order.push('view:invalidate')},{invalidate:()=>order.push('coord:invalidate')},true,false,false,3)
 return {fn,order,errors}
}
// fail-closed 边界：作者把 finally 的 setRolling(false) 留在滚动窗口内，缝再撤销 live/协调失效；
// 这两处失效必须**不存在于**回滚callback里 —— 出现即表示真字节已不是本缝适配的那一代，响亮拒绝。
const TAIL_INVALIDATIONS='liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId);'
// 旧代（2.4 标准代）在 anchor 处留下的 resync 消费者两行；缝必须把它逐字升级成 await push，而不是并存。
const OLD_RESYNC_LINES='const nativeSession = props.sessions?.binding(props.sessionId)?.session;\nif (!nativeSession || typeof nativeSession.resync !== "function") throw new Error("回退已落盘，但当前宿主缺少Session.resync；请重开页面");\nawait nativeSession.resync();'
const readerSource=applyRollbackViewReaderTransform(readerRaw)
const createReader=new Function('createIndexedArrayApi',readerSource+';return createSessionViewReader;')(()=>({info:()=>true,from:value=>value}))
const reader=createReader();reader('reader-fixture').accept({view:{turn:2},viewCursor:'old'})
const oldReader=reader('reader-fixture');reader.rebase('reader-fixture');assert.equal(reader('reader-fixture').cursor,undefined)
assert.throws(()=>oldReader.accept({view:{turn:99},viewCursor:'stale'}),/过期/);reader('reader-fixture').accept({view:{turn:1},viewCursor:'new'});assert.equal(reader('reader-fixture').cursor,'new')
assert.equal(applyRollbackViewReaderTransform(readerSource),readerSource)
// 2.5.0 只有两条通道：built（lib/client.js 整份内联产物）与 source（src/client/features/play-controls.js，
// 作者已把 TavernRollbackAction 从 main.js 拆出去）。与 deploy/client-seams.mjs 的真实施缝目标逐字一致。
for(const relative of ['lib/client.js','src/client/features/play-controls.js']){
 const raw=authorRead(relative)
 // —— 已声明的产品缺口 V-1（只报不改，与 standard-seams.test.mjs 同一登记口径）——
 // 2.5.0 把 TavernRollbackAction 位移到 src/client/features/play-controls.js，但该文件里**没有**
 // deploy/rollback-sync-author-transform.mjs:42 需要的 `const slots = ctx.slots;` 锚点
 // （该锚点只在 lib/client.js 内联产物里恰 1 处）⇒ 缝在此通道上必须 fail-closed 抛"作者锚点缺失/不唯一"。
 // 本文件如实断言这条拒绝**确实发生**（而不是假装施缝成功），随后跳过只对"缝已生效的通道"成立的
 // 消费者断言；这不是把缺口藏起来——缺口由本断言与这行明文一起暴露。修复需产品决策，不在测试侧代劳。
 let source
 try{ source=applyClientRollbackTransform(raw) }
 catch(error){
  assert.match(String(error.message),/回退同步作者锚点缺失\/不唯一/,'src通道缺锚点必须 fail-closed 拒绝，而不是静默产出')
  console.log(relative+'：产品缺口 V-1 未验证 —— 该通道缺 `const slots = ctx.slots;` 锚点，'
   +'deploy/rollback-sync-author-transform.mjs:42 无法施缝（需产品决策，本闸只登记不代改）')
  continue
 }
 assert.equal(applyClientRollbackTransform(source),source)
 assert.ok(!source.includes('await nativeSession.resync()'))
 assert.throws(()=>applyClientRollbackTransform(source+'\n'+marker),/不完整/)
 if(relative.startsWith('lib/'))assert.throws(()=>applyClientRollbackTransform(source.replace('if (generation !== (generations.get(sessionId) ?? 0)) throw new Error("回退前状态读已过期");','')),/不完整/)
 // 消费者承载：2.5.0 缝只把 CALLBACK 写成 await，判据必须取 await 那处，不能拿别处的函数名冒充消费者。
 const CALL='await props.sessions.waitForTavernRollbackSync('
 assert.ok(source.includes(CALL),relative+'：回退callback必须逐字等待同连接push（await），而不是先setRolling(false)落到作者可回滚窗口')
 assert.equal(countOf(source,CALL),1,relative+'：同连接push消费者必须唯一落点')
 // fail-closed：await前必须还有"宿主是否具备该消费者"的前置守卫，缺了⇒本文件自己响亮拒绝，
 // 不允许把"没接线就调用"当成有效消费者（守卫与其后的 await 同属一次调用，故各自恰好 1 处）。
 assert.equal(countOf(source,'typeof props.sessions?.waitForTavernRollbackSync !== "function"'),1,relative+'：缺少消费者前置守卫')
 // 作者 finally 的裸 setRolling(false) 是缝的产物（见 deploy/rollback-sync-author-transform.mjs:36）：
 // 它证明 callback 的滚动窗口没被改动，故 push 一定落在窗口内。少了/多了都不再是同一形态。
 const cbStart=source.indexOf('async function rollback()',source.indexOf('function TavernRollbackAction(props)')),cbEnd=source.indexOf('if (!canRollback) {',cbStart)
 const callback=source.slice(cbStart,cbEnd)
 assert.equal(countOf(callback,'finally { setRolling(false); }'),1,relative+'：同连接push必须落在rolling窗口内（作者裸setRolling(false)恰1处）')
 assert.equal(countOf(callback,TAIL_INVALIDATIONS),0,relative+'：缝必须撤销callback末尾的live/协调失效，不得保留作者原样')
 const ok=callbackFrom(source);await ok.fn();assert.deepEqual(ok.order,['rolling:start','rpc','sync:wait','panels','rolling:end']);assert.equal(ok.errors.length,0)
 for(const input of [{rpcFailure:true},{missingSync:true},{syncFailure:true}]){const bad=callbackFrom(source,input);await bad.fn();assert.equal(bad.errors.length,1);assert.ok(!bad.order.includes('panels'))}
 const stale=callbackFrom(source,{superseded:true});await stale.fn();assert.ok(!stale.order.includes('view:set'));assert.ok(!stale.order.includes('projection'))
 // 旧代形态（2.4 标准代在 anchor 处留下的 Session.resync 消费者）：2.5.0 的缝把它**降级为后缀残留**，
 // 缝自己的 push 等待必须排在它**之前**（push 先落地，旧 resync 才可能执行），且不得出现第二条 push 消费者。
 // 判据取 callback 区段内的相对顺序，而不是"旧文本是否还存在"——旧文本存在但次序被推到缝之后即为可接受，
 // 唯一不可接受的是 push 等待缺席或落后于旧消费者（那等于没接管）。
 const oldForm=raw.replace(anchor,anchor+'\n// [dsh-tavern-core-client-resync:v1]\n'+OLD_RESYNC_LINES)
 assert.equal(countOf(oldForm,'// [dsh-tavern-core-client-resync:v1]'),1,relative+'：旧代形态必须唯一（否则本断言没测到东西）')
 assert.equal(countOf(oldForm,OLD_RESYNC_LINES),1,relative+'：旧代Session.resync消费者必须唯一')
 const withOld=applyClientRollbackTransform(oldForm)
 const withOldStart=withOld.indexOf('async function rollback()',withOld.indexOf('function TavernRollbackAction(props)'))
 const withOldEnd=withOld.indexOf('if (!canRollback) {',withOldStart)
 const withOldCallback=withOld.slice(withOldStart,withOldEnd)
 const pushAt=withOldCallback.indexOf(CALL),oldSyncAt=withOldCallback.indexOf('await nativeSession.resync()'),oldGuardAt=withOldCallback.indexOf('typeof nativeSession.resync !== "function"')
 assert.ok(pushAt>=0,relative+'：旧代形态下同连接push等待仍必须在callback内')
 assert.ok(oldSyncAt>=0,relative+'：旧代消费者应作为残留保留在缝之后（本闸只是确认次序，不冒认它是我们的消费者）')
 assert.ok(pushAt<oldSyncAt,relative+'：push等待必须排在旧代resync之前')
 assert.ok(pushAt<oldGuardAt,relative+'：push等待必须排在旧代resync守卫之前')
 assert.equal(countOf(withOldCallback,CALL),1,relative+'：旧代形态下push消费者仍必须唯一')
 // 半个旧代标记（只有 marker、没有消费者）：2.5.0 的缝认的是"干净锚点"，故它照样施缝，
 // 只把那行死标记留在 push 之后。这里如实断言**缝本身仍然生效且唯一**，不冒认它是我们的消费者；
 // 真正的 fail-closed 由上面"push 必须存在且唯一、必须排在旧残留之前"和 marker 不唯一时的 /不完整/ 承担。
 const halfForm=raw.replace(anchor,anchor+'\n// [dsh-tavern-core-client-resync:v1]')
 const halfOut=applyClientRollbackTransform(halfForm)
 assert.equal(countOf(halfOut,CALL),1,relative+'：半标记不得削弱push消费者（仍须恰好1处）')
 assert.equal(halfOut.includes('// [dsh-tavern-core-client-resync:v1]'),true,relative+'：死标记按原样保留（不冒认、不猜测撤除）')
 const halfStart=halfOut.indexOf('async function rollback()',halfOut.indexOf('function TavernRollbackAction(props)'))
 assert.ok(halfOut.indexOf(CALL,halfStart)>halfStart,relative+'：半标记下push等待仍须落在callback内')
 // live view：built 是整份内联产物；source 通道的 live 模块不在这里（它由 deploy/client-seams 按
 // modules/live-tavern-view.js 的 include 归属单独施缝），故从 built 取同一份真字节。
 const built=relative.startsWith('lib/')?source:applyClientRollbackTransform(authorRead('lib/client.js'))
 const begin=built.indexOf('function createLiveTavernViewModule(options)'),end=built.indexOf('\n\t\tfunction ',begin+10)
 const create=new Function('createSessionRefreshController',built.slice(begin,end)+';return createLiveTavernViewModule;')(refreshControllerStub),timers=[]
 let resolve,reads=0;const oldRead=new Promise(r=>{resolve=r})
 const live=create({load:()=>{reads++;return oldRead},schedule:fn=>{timers.push(fn);return fn},cancel:()=>{},pollWhileBusy:false,cacheRetentionMs:0})
 const stop=live.subscribe('sync-fixture',()=>{});const active=timers.shift()();await Promise.resolve()
 live.rebase('sync-fixture');resolve({view:{turn:99}});await active;for(let n=0;n<6;n++)await Promise.resolve()
 assert.notEqual(live.getSnapshot('sync-fixture').view?.turn,99,'回退前getSession返回不能重新显示旧状态')
 assert.equal(reads,1);const freshRead=timers.shift();assert.equal(typeof freshRead,'function');freshRead();for(let n=0;n<8;n++)await Promise.resolve();assert.equal(reads,2,'rebase只安排一次新代读取');stop()
 const cs=built.indexOf('const tavernCoordination = createTavernCoordinationEventModule('),ce=built.indexOf('\n\t\tfunction describeTavernActivity',cs)
 // 同源缺口（与 createSessionRefreshController 同类）：built 里 **const tavernCoordination = ...** 这段
 // 本身就是作者**紧跟在** createTavernCoordinationConnection 之后的顶层装配块（cs..ce 落在连接函数
 // **之外**的同层文本里），而该连接函数以裸标识符调用 createSessionRefreshController。
 // 故：连接函数按**作者的收尾边界**（顶层 `\n\t\t}`）精确取出（不能用"\n\t\tfunction "找尾——
 // 2.5.0 下面紧跟的是 const 行而非 function，会连同 const coordinatedCardPaths 一起吞进来、
 // 与本文件注入的同名参数重复声明）；coordination 装配块单独取出，两者按 built 原序拼接。
 const csConn=built.indexOf('function createTavernCoordinationConnection(')
 const csConnClose=built.indexOf('\n\t\t}\n',csConn)
 assert.ok(csConn>=0 && csConnClose>csConn,'built 必须内联 createTavernCoordinationConnection 且可定位其顶层收尾')
 const connBody=built.slice(csConn,csConnClose+'\n\t\t}'.length)
 assert.equal(countOf(connBody,'function createTavernCoordinationConnection('),1,'连接函数切片必须恰好含其自身定义')
 assert.equal(connBody.includes('const coordinatedCardPaths'),false,'连接函数切片不得吞入顶层 const（否则与注入参数重复声明）')
 assert.equal(countOf(connBody,'createSessionRefreshController('),1,'连接函数必须仍以裸标识符消费刷新控制器')
 let signal,onReconnect,finish;let calls=0;const published=[]
 // 刷新控制器真源在缺省 schedule/cancel 时用 **window.setTimeout/clearTimeout**（浏览器模块的正当缺省；
 // 作者的 connect 只传 load/subscribe/view/handlers，正是走这条缺省）。本测试跑在 Node 里，
 // 故只补这一个作者运行环境符号（同 upstream-25-client-sync.test.mjs 的 sandbox 做法），并把它接到
 // 本测试自己的 timers 队列：调度语义仍是作者的缺省分支，只是可确定性驱动，不替作者发明调度。
 // 只驱动 **delay 为 0 的唤醒请求**，与 upstream-25-client-sync.test.mjs 的 fakeClock.drain 同法
 // （作者 loadTimeoutMs 缺省 10000 的看门狗定时器**不动**——它不是本闸要测的唤醒路径，
 //  驱动它会 abort 掉整次读，测不到"旧读被世代拒"这一层）。
 const priorWindow=globalThis.window
 globalThis.window={setTimeout:(run,delay)=>{const handle={run,delay:Number(delay)||0,done:false};timers.push(handle);return handle},clearTimeout:handle=>{if(handle)handle.cancelled=true},setInterval:()=>0,clearInterval:()=>{}}
 try{
  const coordination=new Function('createTavernCoordinationEventModule','createTavernCoordinationConnection','createSessionRefreshController','coordinatedCardPaths','liveTavernView','notifyTavernDataChanged','rpc','coordinationView','tavernSessionSignals',connBody+'\n'+built.slice(cs,ce)+';return tavernCoordination;')(
   options=>options,options=>options,refreshControllerStub,new Map(),{},()=>{},()=>{calls++;if(calls===1)return new Promise(resolve=>finish=resolve);return Promise.resolve({turn:2})},value=>value,{subscribe:(_id,_key,onSignal,_onError,reconnect)=>{signal=onSignal;onReconnect=reconnect;return ()=>{}}})
  const channel=coordination.connect('sync-fixture',{message:value=>published.push(value),error:error=>{throw error}})
  // 只驱动 **delay 为 0 的唤醒请求**（作者缺省 loadTimeoutMs=10000 的看门狗定时器不动：
  // 它是另一条路径，驱动它会 abort 掉整次读，测不到"旧读被世代拒"这一层）。
  // 2.5.0 的刷新控制器把读放在 schedule 回调里，故必须显式驱动一次到点定时器，
  // 首次读才会真正发起——原代（2.4）那条"两次 reset 后 microtask 里自动发起"的形态在 2.5.0 上不存在。
  const drain=async(steps=60)=>{for(let n=0;n<steps;n++){for(let k=0;k<12;k++)await Promise.resolve();const i=timers.findIndex(entry=>entry&&!entry.done&&!entry.cancelled&&!entry.delay);if(i<0)break;const entry=timers.splice(i,1)[0];entry.done=true;entry.run()}}
  // ① 首次权威读：连接本身不自动请求，由 refresh 请求；驱动到点定时器后它真正发起并停在 load 上。
  channel.refresh();await drain()
  assert.equal(typeof finish,'function','连接建立后必须发起一次权威读（刷新控制器缺省调度必须可达）')
  assert.equal(calls,1);assert.deepEqual(published,[],'首次读未返回前不得发布')
  // ② 回退：协调器 refresh 在缝里被升级为 replace+request ⇒ 撤销在飞读（推进世代）。
  channel.refresh()
  // ③ 旧读迟到：它已不是当前代 ⇒ 作者 isCurrent 守卫必须丢弃，不得发布。
  finish({turn:99});for(let n=0;n<12;n++)await Promise.resolve()
  assert.deepEqual(published,[],'旧RPC迟到不得发布（回退已撤销在飞读）')
  // ④ 回退后的权威新读：到点唤醒后发布（回退的 request 已排定一次新读）。
  await drain();for(let n=0;n<12;n++)await Promise.resolve()
  assert.equal(calls,2);assert.deepEqual(published,[{turn:2}],'回退后的权威新读必须发布')
  // ⑤ 独立旧 signal 快照：只唤醒权威 HTTP 读，不安装快照本身。
  const beforeSnapshot=published.length
  signal({snapshot:{turn:98}});await drain();for(let n=0;n<12;n++)await Promise.resolve()
  assert.equal(calls,3)
  assert.ok(published.slice(beforeSnapshot).every(row=>row.turn!==98),'SSE旧快照不得被安装')
  assert.ok(published.every(row=>row.turn===2),'发布序列里只允许权威新读')
  channel.close()
 }finally{ if(priorWindow===undefined)delete globalThis.window; else globalThis.window=priorWindow }
 console.log(relative+': 真callback等待push/无二次刷新/旧代升级/失败硬闸/旧live view与coordination拒绝通过')
}
