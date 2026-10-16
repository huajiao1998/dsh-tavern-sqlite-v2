import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {applyRollbackWorldbookBindingsFileTransform} from '../deploy/rollback-worldbook-bindings-transform.mjs'

// 两代真实public源码夹具：旧代(作者5d2ffacf)仍有saveMvuCard，新代(上游next)已完整删除该入口。
// 缺夹具必须响亮失败，不允许skip——跳过会让本回归在无夹具环境下静默失效。
const OLD_FIXTURE=new URL('../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/file-resources.js',import.meta.url)
const NEW_FIXTURE=new URL('../../../tmp/upstream-next-audit-20261005/src-core/tavern-plugin__lib__domain__file-resources.js',import.meta.url)

// 夹具SHA常量：防止夹具被误改后测试静默换义（断言语义依赖这些精确字节）。
// 旧代源来自固定5d2ffacf程序夹具；新代源来自固定d5b2e6c4的公开raw。
// 新代file-resources、client及main已与另行下载的d5b2e6c4完整tar逐字核对一致，见本轮修复报告。
// 哈希锁定测试输入；这只证明该源码快照，不证明真实运行/页面或未来main。
const OLD_SHA='c456e511e0e3bfd9360ffc8f79305dc33cded174cb783c543c43b8456a32c411'
const NEW_SHA='a35b18dbe13e3ba200bdfc5f515600dd87fd2e427e18feaacefac08cae102bc6'

// 工作台可混合编辑后，3961ee9的整份输出快照已失效；下方直接断言原版比较与实际SQL写口。

function fixture(url,label,expectedSha){
 let text
 try{text=readFileSync(url,'utf8')}catch(error){throw new Error('缺少'+label+'真实源码夹具，本测试拒绝跳过：'+error.message)}
 assert.ok(text.length>1000,label+'夹具内容过短，疑似损坏')
 const actual=createHash('sha256').update(text,'utf8').digest('hex')
 assert.equal(actual,expectedSha,label+'夹具SHA与登记常量不符，断言语义已失效（夹具被改动或路径指向别的代）')
 return text
}

// 只观察实际旧API入口与对应专用锚点数量，不用source.includes宽字符串判定代际。
// journalWrite 统计的是**原始作者源**里的 plan.write(bindings) 落盘锚（旧代=1）；
// 注意"禁止世界书绑定写回文件journal"哨兵不是作者锚点——它由 transform 上游 replaceAll 注入、
// 再被 MVU 锚点表移除，作者原raw里恒为0，故不能当作 before 锚点计数（会永久为0，见JOURNAL_INJECTED）。
function anchorCounts(source){
 return {
  entry:source.split('  function saveMvuCard(').length-1,
  finalize:source.split('      if (finalize) finalize(saved)').length-1,
  journalWrite:source.split('        await plan.write(worldBookBindingsPath, JSON.stringify(bindings, null, 2))').length-1,
  publish:source.split('      const text = JSON.stringify(saved, null, 2)\n      const bindings = await readWorldBookBindings()').length-1,
  mvuReturn:source.split('      return { path: target, changed: result.changed, imageCopied: !!image }').length-1
 }
}
const JOURNAL_SENTINEL="        throw new Error('禁止世界书绑定写回文件journal')"

test('新代已删除saveMvuCard完整通过转换，不注入obsolete API与expectedTargetText',()=>{
 const source=fixture(NEW_FIXTURE,'新代',NEW_SHA),before=anchorCounts(source)
 assert.equal(before.entry,0,'新代夹具应无saveMvuCard入口')
 // journalWrite 为0即证明新代无MVU落盘锚；不再用哨兵计数冒充作者锚点。
 assert.deepEqual([before.finalize,before.journalWrite,before.publish,before.mvuReturn],[0,0,0,0],'新代不应残留MVU专用锚点')
 const next=applyRollbackWorldbookBindingsFileTransform(source)
 // 新代无旧入口，无需防旧入口，但普通副本种子语义仍必须注入。
 assert.ok(!next.includes('saveMvuCard'),'不得凭no旧入口注入obsolete API')
 assert.ok(!next.includes('expectedTargetText'),'不得向新代注入expectedTargetText')
 assert.ok(!next.includes(JOURNAL_SENTINEL),'旧journal哨兵不得出现')
 // 标记不保证在首行：copyConsumers 会先加 import、retireBindingCalculations 又会加自己的标记，
 // 故只断言"存在且唯一"，不断言 startsWith（旧断言误把注入顺序当成契约）。
 assert.ok(next.includes('// [dsh-tavern-worldbook-bindings-sql:v1]'),'须带标记')
 assert.equal(next.split('// [dsh-tavern-worldbook-bindings-sql:v1]').length-1,1,'标记须唯一')
 assert.ok(next.includes('await seedCardSql(target,saved)'),'普通副本仍须种子')
})

test('两代真实public源码转换均一次成功且幂等',()=>{
 for(const [url,label,sha] of [[OLD_FIXTURE,'旧代',OLD_SHA],[NEW_FIXTURE,'新代',NEW_SHA]]){
  const source=fixture(url,label,sha),once=applyRollbackWorldbookBindingsFileTransform(source)
  assert.equal(applyRollbackWorldbookBindingsFileTransform(once),once,label+'二次转换必须幂等')
  assert.notEqual(once,source,label+'必须实际改写')
 }
})

test('旧代saveMvuCard保留原版比较并允许混合编辑，SQL变量世界书与绑定实际接线',()=>{
 const source=fixture(OLD_FIXTURE,'旧代',OLD_SHA),before=anchorCounts(source)
 assert.equal(before.entry,1,'旧代夹具应恰有1个saveMvuCard入口')
 assert.deepEqual([before.finalize,before.journalWrite,before.publish,before.mvuReturn],[1,1,1,1],'旧代四处专用锚点应各为1')
 assert.equal(source.split(JOURNAL_SENTINEL).length-1,0,'哨兵非作者锚点')
 const next=applyRollbackWorldbookBindingsFileTransform(source)
 // 整份旧输出快照与插件混合写拒绝按用户明确授权退役；原版比较仍保留。
 const authorCompare="      if (await readText(source) !== expectedSourceText || await readText(target) !== expectedTargetText) throw new Error('人物卡已变化，请重新读取后转换')"
 assert.ok(source.includes(authorCompare));assert.ok(next.includes(authorCompare),'原版读取版本比较未改')
 assert.ok(!next.includes('已有MVU副本跨文件/SQL运行值修改尚不支持原子提交'),'不得恢复已撤插件混合写门槛')
 assert.ok(next.includes('const published=clone(saved)'))
 assert.ok(next.includes('delete data.extensions.tavern_helper.variables'))
 assert.ok(next.includes('data.character_book=data.character_book===null?null:{entries:[]}'))
 const start=next.indexOf('  function saveMvuCard('),end=next.indexOf('      return { path: target, changed: result.changed, imageCopied: !!image }',start)
 assert.ok(start>=0&&end>start)
 const mvu=next.slice(start,end)
 assert.equal(mvu.split('await options.characterVariables.save(target,sqlData.extensions?.tavern_helper?.variables || {})').length-1,1,'MVU更新目标SQL变量而非只种子')
 assert.equal(mvu.split("await options.worldbookResources().save({kind:'card',cardPath:target},sqlData.character_book ?? null)").length-1,1,'MVU更新目标SQL世界书')
 assert.equal(mvu.split('await writeWorldBookBindings(bindings)').length-1,1,'独立编辑不附游玩owner')
 assert.equal(next.split('await seedCardSql(target,saved)').length-1,1,'普通复制保持首次种子语义')
 assert.equal(next.split('await writeWorldBookBindings(bindings,owner)').length-1,6,'其余绑定调用保留既有owner传递')
 assert.equal(next.split('await writeWorldBookBindings(bindings)').length-1,1)
 assert.ok(!next.includes('        await plan.write(worldBookBindingsPath, JSON.stringify(bindings, null, 2))'),'绑定保持SQL权威')
 assert.ok(!next.includes(JOURNAL_SENTINEL))
})

test('半缺形态漂移：旧入口在但任一MVU锚点数量不为1必须拒绝',()=>{
 const source=fixture(OLD_FIXTURE,'旧代',OLD_SHA)
 // 每例登记"应命中的诊断"，防止用宽正则把"因错误原因被拒"也当通过。
 // 重复入口必须报"旧入口重复"，不得落到"残留锚点"分支——后者是误诊（变异C实测会给出[1,1,1,1]的错误归因）。
 const cases=[
  ['单anchor loss',source.replace('      if (finalize) finalize(saved)\n',''),/MVU锚点缺失\/不唯一/],
  ['partial stale',source.replace('      const bindings = await readWorldBookBindings()\n      bindings[target] = { kind: \'embedded\', cardPath: target }\n',''),/MVU锚点缺失\/不唯一/],
  ['duplicate old entry',source.replace('  function saveMvuCard(','  function saveMvuCard(\n  function saveMvuCard('),/saveMvuCard旧入口重复/]
 ]
 for(const [label,broken,expected] of cases){
  // 防夹具改造没命中：replace 未命中则 broken===source，下面的 throws 会变成假阴性（测了个没坏的源）。
  assert.notEqual(broken,source,label+'夹具改造未命中，用例无效')
  // 注意本组只证明**字符串匹配器的拒绝行为**（fail-closed）。
  // replace 删掉锚点行后源码已语法不完整，故**不得**由此宣称"运行期语义被拒绝"——本用例不含运行时语义证据。
  assert.throws(()=>applyRollbackWorldbookBindingsFileTransform(broken),expected,label+'必须以其专属原因拒绝')
 }
})

test('入口已删但残留MVU专用锚点（形态漂移）必须拒绝，不造通用fallback',()=>{
 const source=fixture(NEW_FIXTURE,'新代',NEW_SHA)
 const drifted=source.replace('  async function importCard(payload, card) {','      if (finalize) finalize(saved)\n  async function importCard(payload, card) {')
 assert.notEqual(drifted,source,'注入残留锚点未命中，用例无效')
 // 语义前提：注入后新代仍无 saveMvuCard 入口，但已出现非0的MVU专用锚点。
 assert.equal(drifted.split('  function saveMvuCard(').length-1,0,'漂移源仍应无旧入口')
 assert.equal(drifted.split('      if (finalize) finalize(saved)').length-1,1,'漂移源应恰有1个残留锚点')
 assert.throws(()=>applyRollbackWorldbookBindingsFileTransform(drifted),/形态漂移/, '残留MVU锚点必须拒绝')
})

test('common binding锚点缺失必须响亮失败，不静默产出半成品',()=>{
 const source=fixture(NEW_FIXTURE,'新代',NEW_SHA)
 const broken=source.replace('  const worldBookBindingsPath = path.join(dataRoot, \'.worldbook-bindings.json\')\n','')
 assert.notEqual(broken,source,'删除common锚点未命中，用例无效')
 assert.equal(broken.split("  const worldBookBindingsPath = path.join(dataRoot, '.worldbook-bindings.json')").length-1,0,'common锚点应已删除')
 assert.throws(()=>applyRollbackWorldbookBindingsFileTransform(broken),/锚点/, 'common anchor缺失必须抛错')
})
