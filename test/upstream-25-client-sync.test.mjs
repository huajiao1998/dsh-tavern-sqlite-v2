// 定向闸（本地，仅 test）：上游 2.5 作者源 / 内置产物上的同连接回退同步消费者。
//
// 对象（全是作者 2.5 真字节，SHA 5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60）：
//   · session-view-sync.js  —— reader 世代：回退使旧 cursor 失效，旧 accept 拒、新 accept 收
//   · live-tavern-view.js   —— live view rebase：回退撤销在飞读，不 install 旧 view，之后仍能 refresh
//   · tavern-coordination.js—— 协调器 refresh：旧 RPC 迟到不发布，SSE 快照只唤醒权威 HTTP 读
//
// 覆盖通道：source（src/client/modules/*.js）与 built（lib/client.js 内联）**两条都要**，
// 因为部署时 source 走 applyAuthorRollbackSyncTransform、bundle 走 core-host-transform 的同名缝。
//
// 边界：只跑本地转换 + VM 行为；不碰产品文件、不提交、不部署、不连远端、不用真实存档、不跑全量。
// 时钟：自造 fake clock（0 延迟唤醒按序驱动），microtask 确定性收敛，不用 sleep、不赌真实时间。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {applyRollbackViewReaderTransform,applyRollbackLiveViewTransform} from '../deploy/rollback-sync-state-transform.mjs'
import {applyAuthorCoordinationTransform,applyAuthorRollbackActionTransform,applyAuthorRollbackSyncTransform} from '../deploy/rollback-sync-author-transform.mjs'

const AUTHOR='dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const BASE=new URL('../../../tmp/upstream25-author-fixture/src/'+AUTHOR+'/tavern-plugin/',import.meta.url)
const read=rel=>readFileSync(new URL(rel,BASE),'utf8')
const SRC={
  reader:read('src/client/modules/session-view-sync.js'),
  live:read('src/client/modules/live-tavern-view.js'),
  coord:read('src/client/modules/tavern-coordination.js'),
  refresh:read('src/client/modules/session-refresh-controller.js'),
}
const DOMAIN=read('lib/domain/indexed-array.js').replace(/export\s*\{[^}]*\};?/g,'')
  +'\n'+read('lib/domain/ordered-numeric-index.js').replace(/export\s*\{[^}]*\};?/g,'')
const BUILT=read('lib/client.js')

/** 从 built bundle 抠出内联函数（按作者自身的缩进边界，不猜名字）。 */
function inline(bundle,name){
  const start=bundle.indexOf('function '+name+'(')
  assert.ok(start>=0,'built 产物缺少内联函数：'+name)
  const lineStart=bundle.lastIndexOf('\n',start)+1
  const indent=bundle.slice(lineStart,start)
  let end=bundle.indexOf('\n'+indent+'function ',start+10)
  if(end<0)end=bundle.length
  return bundle.slice(start,end).replace(/^\t\t/gm,'')
}

/** fake clock：0 延迟=请求唤醒（可驱动）；>0 延迟=load 超时/退避（默认不动，单独断言）。
 *  每次驱动后固定多轮 microtask，让 refresh controller 的多段 await 链收敛（不 sleep、不赌时间）。 */
function fakeClock(){
  const timers=[]
  const schedule=(run,delay)=>{const handle={run,delay,cancelled:false};timers.push(handle);return handle}
  const cancel=handle=>{if(handle)handle.cancelled=true}
  const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve()}
  const drain=async(steps=60)=>{for(let n=0;n<steps;n++){await flush();const i=timers.findIndex(h=>!h.cancelled&&!h.delay);if(i<0)break;const h=timers.splice(i,1)[0];h.run()}await flush()}
  return {schedule,cancel,drain,flush,now:()=>0,pending:()=>timers.filter(h=>!h.cancelled).length}
}

/** 真实作者运行环境：作者代码用 window.setTimeout/innerWidth，VM 里必须给真符号而不是假实现。 */
function sandbox(){
  const box={console,Promise,Map,Set,WeakMap,WeakSet,Symbol,Object,Array,Number,String,Boolean,Error,TypeError,RangeError,Math,JSON,Reflect,Proxy,RegExp,Date,AbortController,AbortSignal,queueMicrotask,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,window:{}}
  box.window.setTimeout=setTimeout;box.window.clearTimeout=clearTimeout;box.window.setInterval=setInterval;box.window.clearInterval=clearInterval
  box.window.innerWidth=1024;box.window.innerHeight=768
  vm.createContext(box)
  return box
}
function run(box,code){vm.runInContext(code,box,{timeout:2000});return box}

// ————————————————————————————————————————————————————————————————
// 1) source / built 对等：同一缝在两条通道上都必须产出等价行为
// ————————————————————————————————————————————————————————————————
test('source与built内联模块同源：三个状态模块文本一致，且分头施缝后行为对等',()=>{
  // 同源判据：按**各自的函数边界**取出整段再归一化空白比较（不跨边界、不比文件尾）。
  const srcSlice=(text,name)=>{
    const start=text.indexOf('function '+name+'(')
    assert.ok(start>=0,'source 缺少函数：'+name)
    let end=text.indexOf('\nfunction ',start+10)
    if(end<0)end=text.length
    return text.slice(start,end)
  }
  const norm=value=>value.replace(/\s+/g,' ').trim()
  for(const [name,text] of [['createSessionViewReader',SRC.reader],['createLiveTavernViewModule',SRC.live],['createTavernCoordinationEventModule',SRC.coord]]){
    assert.equal(norm(inline(BUILT,name)),norm(srcSlice(text,name)),name+'：源/产物不同源')
  }
  // 两条通道分别施缝：标记都要出现，且幂等
  for(const [label,raw,fn] of [
    ['source-reader',SRC.reader,applyRollbackViewReaderTransform],
    ['built-reader',inline(BUILT,'createSessionViewReader')+'\n',applyRollbackViewReaderTransform],
    ['source-live',SRC.live,applyRollbackLiveViewTransform],
    ['built-live',inline(BUILT,'createLiveTavernViewModule')+'\n',applyRollbackLiveViewTransform],
    ['source-coord',SRC.coord,applyAuthorCoordinationTransform],
    ['built-coord',inline(BUILT,'createTavernCoordinationEventModule')+'\n'+inline(BUILT,'createTavernCoordinationConnection')+'\n',applyAuthorCoordinationTransform],
  ]){
    const out=fn(raw)
    assert.notEqual(out,raw,label+'：缝未生效')
    assert.equal(fn(out),out,label+'：不是幂等')
  }
  // reader：built 内联版本的行为必须与 source 版本一致（旧 accept 拒 / 新 accept 收）
  for(const [label,body] of [['source',SRC.reader],['built',inline(BUILT,'createSessionViewReader')+'\n']]){
    const box=sandbox()
    const dependencies = SRC.reader.slice(SRC.reader.indexOf('// Weak array-version keys'))
    run(box,DOMAIN+'\n'+dependencies+'\n'+applyRollbackViewReaderTransform(body)+'\nthis.__make=createSessionViewReader;')
    const begin=box.__make()
    const stale=begin('fx');stale.accept({view:{turn:1},viewCursor:'c1'})
    assert.equal(begin('fx').cursor,'c1',label+'：首次接受未生效')
    begin.rebase('fx')
    assert.equal(begin('fx').cursor,undefined,label+'：rebase 未清基线')
    assert.throws(()=>stale.accept({view:{turn:9},viewCursor:'stale'}),label+'：旧 accept 未被拒')
    begin('fx').accept({view:{turn:2},viewCursor:'c2'})
    assert.equal(begin('fx').cursor,'c2',label+'：新 accept 未生效')
  }
})

// ————————————————————————————————————————————————————————————————
// 2) reader 世代
// ————————————————————————————————————————————————————————————————
test('reader回退：旧accept被世代拒、新accept成功、在飞请求归还后不泄漏pending',()=>{
  const box=sandbox()
  run(box,DOMAIN+'\n'+applyRollbackViewReaderTransform(SRC.reader)+'\nthis.__make=createSessionViewReader;')
  const begin=box.__make()
  const inflight=begin('fx')                       // 在飞：未 release
  inflight.accept({view:{turn:1},viewCursor:'c1'})
  assert.equal(begin('fx').cursor,'c1')
  begin.rebase('fx')                               // 回退：世代 +1
  assert.equal(begin('fx').cursor,undefined,'回退后基线必须为空')
  assert.throws(()=>inflight.accept({view:{turn:9},viewCursor:'stale'}),/过期|取消/,'旧世代 accept 必须被拒')
  const fresh=begin('fx')
  fresh.accept({view:{turn:2},viewCursor:'c2'})
  assert.equal(begin('fx').cursor,'c2','新世代 accept 必须成功')
  // pending 不泄漏：旧在飞 release 后，再开一次仍应拿到正常基线（而不是被旧 owner 卡住）
  inflight.release();fresh.release()
  const after=begin('fx')
  assert.equal(after.cursor,'c2','释放后基线不应被旧 owner 污染')
  after.release()
})

// ————————————————————————————————————————————————————————————————
// 3) live view rebase
// ————————————————————————————————————————————————————————————————
test('live回退：abort旧load、旧view不install、新读publish，且setView之后仍能继续refresh',async()=>{
  const box=sandbox()
  run(box,DOMAIN+'\n'+SRC.refresh+'\n'+applyRollbackLiveViewTransform(SRC.live)+'\nthis.__live=createLiveTavernViewModule;')
  const clock=fakeClock()
  let resolveOld,loads=0,aborted=0
  const view=box.__live({
    load:(id,{signal})=>{loads++;const n=loads
      if(n===1){signal.addEventListener('abort',()=>aborted++);return new Promise(r=>{resolveOld=r})}
      return Promise.resolve({view:{turn:n===2?2:3}})},
    schedule:clock.schedule,cancel:clock.cancel,pollWhileBusy:false,cacheRetentionMs:0,now:()=>0,
  })
  const stop=view.subscribe('fx',()=>{})
  await clock.drain()
  assert.equal(loads,1,'订阅后应发起首次读')
  assert.equal(view.getSnapshot('fx').phase,'loading')
  view.rebase('fx')                                 // 回退
  assert.equal(aborted,1,'回退必须 abort 在飞读')
  resolveOld({view:{turn:99}})                      // 旧读迟到
  await clock.drain()
  assert.notEqual(view.getSnapshot('fx').view?.turn,99,'旧 view 不得被 install')
  assert.equal(loads,2,'回退应安排一次新代读')
  assert.equal(view.getSnapshot('fx').view?.turn,2,'新读结果必须发布')
  // 关键回归（上一 bug）：rebase 之后 setView 仍能继续 refresh
  const release=view.setView('fx',{turn:7,settleStatus:'idle'})
  await clock.drain()
  assert.equal(view.getSnapshot('fx').view?.turn,7,'setView 应立即可见')
  view.invalidate('fx')
  await clock.drain()
  assert.equal(loads,3,'setView 之后 invalidate 必须还能发起读（不得卡死）')
  assert.equal(view.getSnapshot('fx').view?.turn,3,'刷新结果必须发布')
  release();stop()
})

// ————————————————————————————————————————————————————————————————
// 4) 协调器：refresh 撤销在飞读 + SSE 快照只唤醒 HTTP
// ————————————————————————————————————————————————————————————————
test('协调器回退：旧RPC迟到不发布，SSE快照只唤醒权威HTTP读、不安装旧快照',async()=>{
  const box=sandbox()
  run(box,SRC.refresh+'\n'+applyAuthorCoordinationTransform(SRC.coord)+'\nthis.__coord=createTavernCoordinationEventModule;this.__conn=createTavernCoordinationConnection;')
  const clock=fakeClock()
  const published=[],gates=[]
  let signal
  const coordination=box.__coord({
    connect:(id,handlers)=>box.__conn({
      load:()=>{const g={};g.promise=new Promise(r=>{g.resolve=r});gates.push(g);return g.promise},
      schedule:clock.schedule,cancel:clock.cancel,loadTimeoutMs:0,
      subscribe:(message)=>{signal=message;return ()=>{}},
      view:value=>value,
      handlers:{message:value=>handlers.message(value),error:error=>handlers.error(error)},
    }),
  })
  const off=coordination.subscribe('fx',state=>published.push(state.view))
  await clock.drain()
  assert.equal(gates.length,1,'订阅后应发起首次权威读')
  // 订阅会同步回放初始 connecting 快照（view=null），这不是"发布了数据"；只取有 view 的记录。
  const views=()=>published.filter(v=>v!==null)
  gates[0].resolve({turn:2})
  await clock.drain()
  assert.deepEqual(views(),[{turn:2}],'首次读结果必须发布')
  // 回退：协调器 refresh → replace（撤销在飞）+ request（新读）
  coordination.invalidate('fx')
  await clock.drain()
  assert.equal(gates.length,2,'回退后必须重新发起权威读')
  assert.deepEqual(views(),[{turn:2}],'回退本身不得凭空发布')
  // ① 旧读迟到：不得覆盖
  gates[0].resolve({turn:99})
  await clock.drain()
  assert.deepEqual(views(),[{turn:2}],'旧 RPC 迟到不得发布')
  // ② SSE 快照：rollbackRead 之后只唤醒 HTTP，不安装快照
  const beforeSnapshot=published.length
  signal({snapshot:{turn:98}})
  await clock.drain()
  assert.deepEqual(views(),[{turn:2}],'SSE 旧快照不得被 install')
  assert.equal(published.slice(beforeSnapshot).some(v=>v&&v.turn===98),false,'快照值不得出现在发布序列')
  // ③ 权威 HTTP 新读仍必须发布
  gates[1].resolve({turn:5})
  await clock.drain()
  assert.deepEqual(views(),[{turn:2},{turn:5}],'权威 HTTP 新读必须发布')
  off()
})

// ————————————————————————————————————————————————————————————————
// 5) 回退按钮 callback 在这一代作者源上的锚点形态（纯转换层，逐字）
// ————————————————————————————————————————————————————————————————
test('回退callback锚点：在2.5作者源上施加后等待push、且不残留旧view安装路径',()=>{
  const play=read('src/client/features/play-controls.js')
  const out=applyAuthorRollbackActionTransform(play)
  assert.notEqual(out,play,'回退 callback 缝未生效')
  assert.equal(applyAuthorRollbackActionTransform(out),out,'回退 callback 缝不是幂等')
  assert.ok(out.includes('waitForTavernRollbackSync'),'必须等待同连接 push')
  assert.ok(out.includes('RPC旧view不安装'),'必须声明旧 view 不安装')
  assert.equal(out.includes('// [dsh-tavern-core-client-resync:v1]'),false,'不得残留旧代 resync 消费者')
  // 半标记即拒（不允许把半个标记猜成有效旧代）
  assert.throws(()=>applyAuthorRollbackActionTransform(out+'\n// [dsh-tavern-rollback-sync-author:v1]'),/不完整|唯一/)
})
