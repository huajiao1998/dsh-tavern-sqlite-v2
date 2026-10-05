// 仅断言本次新SQL标记消费者：惰性读不建库、内容变更失效、持久读回、释放后拒绝。
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServerDispatchStore } from '../lib/server-dependencies.js'
const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-plg-dispatch-owned-'))
try {
  const store = createServerDispatchStore({ dataRoot: root })
  assert.equal(store.lookupScript('卡一', '脚本一', 'before'), null)
  assert.equal(existsSync(path.join(root, 'storage-server-dispatch.db')), false)
  store.markScript('卡一', '脚本一', 'before', 'dom-probe')
  assert.equal(store.lookupScript('卡一', '脚本一', 'before').class, 'browser-ui')
  assert.equal(store.lookupScript('卡一', '脚本一', 'after'), null)
  assert.equal(store.lookupScript('卡二', '脚本一', 'before'), null)
  store.dispose(); store.dispose()
  assert.throws(() => store.markCard('卡一', 'disposed'), /已释放/)
  const next = createServerDispatchStore({ dataRoot: root })
  assert.equal(next.lookupScript('卡一', '脚本一', 'before').reason, 'dom-probe')
  next.markCard('卡二', 'card-probe')
  assert.equal(next.lookupCard('卡二').class, 'browser-ui')
  next.dispose()
  console.log('server-dispatch-store: 惰性建库/身份/持久化/释放定向断言通过')
} finally {
  // 已核绝对目标：仅删此测试刚创建的唯一目录内精确文件。
  for (const name of readdirSync(root)) rmSync(path.join(root, name), { force: true })
  rmdirSync(root)
}
