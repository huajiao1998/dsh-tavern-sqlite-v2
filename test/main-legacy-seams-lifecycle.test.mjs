// 真实作者源码 fixture 的主入口生命周期；不执行作者插件，不读取任何存档。
//
// fixture 来源（2026-10-05 修正，见 tmp/v2-publish/fixround1/C2-REPORT.md）：
//   `.tmp-verify-clean-install/blank-clean-host-0930.js` 是**三条包线共用**的一份真身快照，
//   其施缝标记是 `[dsh-tavern-storage-sqlite]`（storage-sqlite 线代）。v2 线自己的施缝器
//   （deploy/apply-seams.mjs L165/167/199）与 v1 线分别写 `[dsh-tavern-sqlite-v2]` /
//   `[dsh-tavern-storage-sqlite-v1]`，因此那份共用快照对 v2 线**永远过不了**下面的反向还原守卫
//   （三处 replace 全不匹配 → 缝块残留）。共用快照不能改：storage-sqlite 线正靠它跑绿。
//   ⇒ v2 线改从**作者原始源**取基材（唯一目录见 author-path.txt），自己派生「已施 main 缝」基线。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformStorageIndex } from '../deploy/apply-seams.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))

// 作者原始源（v2 夹具基材）：唯一目录，逐字节取自上游 5d2ffacf。
const authorRoot = path.resolve(here, '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin')
const authorIndexRel = 'lib/index.js'
const authorLegacy = {
  'tavern-plugin/lib/domain/tavern-conversation-registry.js': 'lib/domain/tavern-conversation-registry.js',
  'tavern-plugin/lib/domain/conversation-initialization.js': 'lib/domain/conversation-initialization.js',
  'tavern-plugin/lib/domain/session-view-reader.js': 'lib/domain/session-view-reader.js'
}
// 存在性/身份门：基材缺失或已被施缝 ⇒ 立即失败，不用「推导出空基线」冒充通过。
assert.ok(existsSync(path.join(authorRoot, authorIndexRel)), '作者源缺失：' + authorRoot)
for (const rel of Object.values(authorLegacy)) assert.ok(existsSync(path.join(authorRoot, rel)), '作者源缺失：' + rel)
const script = path.resolve(here,'../deploy/apply-seams.mjs')
const indexRel = 'tavern-plugin/lib/index.js'
const mainShimRel = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
const legacyShimRel = 'tavern-plugin/lib/domain/legacy-view-seams.js'
const rawIndex = readFileSync(path.join(authorRoot, authorIndexRel), 'utf8')
assert.ok(!rawIndex.includes('createChatSqliteStore(') && !rawIndex.includes("ctx.provide('tavernChats'"),
  '作者源本身已施缝，拒绝据其推导基线：' + authorRoot)
// 「已施 main 缝」基线 = v2 自己的施缝器对作者原样的输出（用产品代码推导，不手抄锚点）。
const mainReady = transformStorageIndex(rawIndex)
const author = mainReady
  .replace("import { createChatSqliteStore } from './domain/chat-sqlite-store.js'\n",'')
  .replace(/  \/\/ \[dsh-tavern-sqlite-v2\] 作者原存储[^\n]*\n  const authorChatStore = (createChatJournalStore\([^\n]*\))\n  \/\/ \[dsh-tavern-sqlite-v2\] 我们的行级 SQLite store[^\n]*\n  const chatJournalStore = createChatSqliteStore\([^\n]*\)\n/,'  const chatJournalStore = $1\n')
  .replace("ctx.effect(() => () => { if (typeof authorChatStore.flushMaintenance === 'function') authorChatStore.flushMaintenance() },",'ctx.effect(() => () => chatJournalStore.flushMaintenance(),')
  .replace(/  \/\/ \[dsh-tavern-sqlite-v2\] 把聊天存储接口暴露[^\n]*\n  ctx\.provide\('tavernChats', chatPersistence\)\n/,'')
assert.ok(!author.includes('createChatSqliteStore(') && !author.includes("ctx.provide('tavernChats'"),'fixture 必须回到 main 施缝前')
// 身份门：反向还原必须逐字节回到作者原样（否则说明施缝代不是这一代）
assert.equal(author, rawIndex, '反向还原必须逐字节回到作者原样')
const sources = new Map([
  [indexRel,author],
  ...Object.entries(authorLegacy).map(([rel, src]) => [rel, readFileSync(path.join(authorRoot, src), 'utf8')])
])
const own = mkdtempSync(path.join(here,'.main-legacy-lifecycle-'))
const file = rel => path.join(own,rel)
function run(flags=[],expected=0) {
  const result = spawnSync(process.execPath,[script,'--app',own,...flags],{stdio:'inherit'})
  assert.equal(result.error,undefined); assert.equal(result.status,expected,'main CLI 退出码')
}
function pristine() {
  for (const [rel,text] of sources) assert.equal(readFileSync(file(rel),'utf8'),text,'还原 '+rel)
  for (const rel of [mainShimRel,legacyShimRel,'.tavern-seams.json','.tavern-legacy-view-seams.json']) assert.equal(existsSync(file(rel)),false,'不留 '+rel)
}
try {
  mkdirSync(file('tavern-plugin/lib/domain'),{recursive:true})
  writeFileSync(file('package.json'),'{"type":"module"}\n','utf8')
  for (const [rel,text] of sources) writeFileSync(file(rel),text,'utf8')
  run(['--check'],3); pristine()
  // legacy 锚点失败时 main 也恢复其本次 preimage，而不是报成功留半代。
  const registryRel = 'tavern-plugin/lib/domain/tavern-conversation-registry.js'
  writeFileSync(file(registryRel),'export const unsupported = true\n','utf8')
  run([],1)
  writeFileSync(file(registryRel),sources.get(registryRel),'utf8'); pristine()
  run(); run(['--check'])
  const applied = readFileSync(file(indexRel),'utf8')
  assert.ok(applied.includes('await initializeAuthorLegacyWorkspaces(ctx)'))
  assert.ok(applied.includes("export const inject = ['sessionPersistence', 'workspaceRegistry']"))
  run(); assert.equal(readFileSync(file(indexRel),'utf8'),applied,'复跑 index 字节不变')
  run(['--uninstall']); pristine()
  run(['--uninstall']); pristine()
  run(); run(['--check']); run(['--uninstall']); pristine()
  // main 老薄缝已存在但没有 main manifest：幂等分支仍须补 legacy；卸只恢复已有 main。
  writeFileSync(file(indexRel),mainReady,'utf8')
  writeFileSync(file(mainShimRel),readFileSync(path.resolve(here,'../deploy/chat-sqlite-store.shim.js'),'utf8'),'utf8')
  run(['--check'],3); run(); run(['--check']); run(['--uninstall'])
  assert.equal(readFileSync(file(indexRel),'utf8'),mainReady)
  assert.equal(existsSync(file(mainShimRel)),true)
  assert.equal(existsSync(file(legacyShimRel)),false)
} finally { rmSync(own,{recursive:true,force:true}) }
console.log('main-legacy-seams-lifecycle：只查/失败回滚/施缝/幂等/逆序卸缝/重施/已有 main 路径通过')
