// 实际宿主 prepare 消费者：有限作者源码真实施缝；Loader 是按既有 DI 契约的内存假件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { authorImages, loadAuthorImages } from '../deploy/author-compatibility.mjs'
import * as seams from '../deploy/standard-seams.mjs'
import { createStandardHostApply, ORIGINAL_ROW_ID, ORIGINAL_ROW_NAME, STANDARD_HOST_ROW_ID } from '../lib/standard-host.js'

test('宿主在作者加载前重接兼容更新且复检严格', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'author-startup-'))
  try {
    const baseline = authorImages(loadAuthorImages()).at(-1)
    const materialize = () => { for (const [rel, bytes] of Object.entries(baseline.files)) if (bytes !== null) {
      const file = path.join(root, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes)
    } }
    materialize(); seams.applyStandardSeams({ appDir: root })
    materialize()
    const pkgPath = path.join(root, 'tavern-plugin/package.json'), pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.version = '2.5.1'; writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    const prompt = path.join(root, 'tavern-plugin/lib/background-agent-task.js')
    const updated = readFileSync(prompt, 'utf8').replace('【任务要求】', '【新的任务要求】')
    writeFileSync(prompt, updated, 'utf8')
    const original = { options: { id: ORIGINAL_ROW_ID, name: ORIGINAL_ROW_NAME, disabled: true }, disabled: true, fiber: undefined }
    const store = {}, order = []
    const loader = {
      store, entries: () => [original, ...Object.values(store)],
      async create(options, parent) {
        assert.equal(parent, null); assert.equal(original.fiber, undefined)
        assert.equal(seams.checkStandardSeams({ appDir: root }).ready, true, '作者 create 前必须严格就绪')
        assert.ok(readFileSync(prompt, 'utf8').includes('【新的任务要求】'))
        order.push('create'); store[options.id] = { options, disabled: false, fiber: { state: 2 } }; return options.id
      },
      async remove(id) { order.push('remove'); delete store[id] },
    }
    const run = createStandardHostApply({ loadSeams: async () => seams, overrides: {
      resolveAuthor: async () => ({ url: pathToFileURL(path.join(root, 'tavern-plugin/lib/index.js')).href, entryPath: path.join(root, 'tavern-plugin/lib/index.js'), packageDir: path.join(root, 'tavern-plugin'), packageJson: pkg, version: pkg.version, appDir: root }),
      resolveRuntime: async () => ({ dsh: { version: '0.1.5-rc.2' }, boot: { version: '0.1.5-rc.2' }, loader: { version: '1.0.3' }, cordis: { version: '4.0.2' } }),
      preflight: () => order.push('preflight'),
    } })
    const dispose = await run({ get: name => name === 'loader' ? loader : undefined, logger: { info() {}, warn() {} } }, { appDir: root })
    assert.deepEqual(order, ['preflight', 'create']); assert.ok(store[STANDARD_HOST_ROW_ID]); assert.equal(original.fiber, undefined)
    await dispose()
    assert.deepEqual(order, ['preflight', 'create', 'remove']); assert.equal(store[STANDARD_HOST_ROW_ID], undefined)
    assert.equal(readFileSync(prompt, 'utf8'), updated, '撤缝必须恢复新作者文案')
    assert.equal(JSON.parse(readFileSync(pkgPath, 'utf8')).version, '2.5.1')
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('author-startup-'))
    rmSync(root, { recursive: true, force: true })
  }
})
