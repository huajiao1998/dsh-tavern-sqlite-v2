// 新增受管客户端目标 tavern-plugin/src/client/turn-error-controls.js 的真实装卸：夹具＝fixtures/comment-author-tree.mjs 的真实作者源码，
// 只留纯业务断言（接缝后字节变化、卸载后作者自定义字节逐字节零改动）；旧 catalog 摘要/覆盖门禁/旧 before-after 记录期待已随旧协议退役。
import test from 'node:test'
import assert from 'node:assert/strict'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { sourceAccess, sameImage } from '../deploy/maintenance/source.mjs'
import { prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const TARGET = 'tavern-plugin/src/client/turn-error-controls.js'
// 夹具里没有目标进程：常量断言表达"无进程可停"，不是把异步函数假当真。
const noProcess = () => true

test('新增客户端目标真装卸：作者自定义字节逐字节零改动', async t => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  t.after(() => tree.cleanup())
  const source = sourceAccess(tree.appDir, adapter.targets)
  const pristine = source.read(TARGET)
  if (pristine === null) return t.skip('当前作者夹具不含新增受管客户端目标：' + TARGET)
  const before = source.capture()
  // 真实施缝：新增目标必须被接缝改写，且进入新记录（blocks 或 owned-new 两类之一）
  const applied = adapter.applyStandardSeams({ appDir: tree.appDir, assertStopped: noProcess })
  assert.equal(applied.changed, true, '首装必须产生变更')
  assert.equal(adapter.checkStandardSeams({ appDir: tree.appDir }).ready, true, '首装后必须 ready')
  const record = source.readRecord()
  assert.ok(record.files[TARGET] || record.owned[TARGET], '新增客户端目标必须进入块记录或 owned 表')
  assert.ok(!source.read(TARGET).equals(pristine), '接缝后新增目标字节必须改变')
  // 真实卸载：只按块记录还原，作者自定义字节必须逐字节零改动
  assert.equal(adapter.uninstallStandardSeams({ appDir: tree.appDir, assertStopped: noProcess }).changed, true)
  assert.ok(source.read(TARGET).equals(pristine), '卸载后新增目标必须逐字节零改动')
  assert.equal(source.readRecord(), null, '卸载后不得残留块记录')
  assert.ok(sameImage(source.capture(), before), '卸载后全部作者文件必须逐字节零改动')
})
