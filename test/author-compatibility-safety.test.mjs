// 独立安全门（4 条具名）：批准 UI 文案可接纳，而模块路径/数据键/插值表达式变化必须拒。
// 只读真实有限 catalog（既有 8 tree，摘要门禁）；metadata 级、无 SDK、无真实数据、不做整轮 apply。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadAuthorImages, authorImages, compareAuthorContract, classifyAuthorCompatibility, AUTHOR_PACKAGE_REL } from '../deploy/author-compatibility.mjs'

const CLIENT = 'tavern-plugin/lib/client.js'
const INDEX = 'tavern-plugin/lib/index.js'
const TASK = 'tavern-plugin/lib/background-agent-task.js'

const trees = authorImages(loadAuthorImages())
function treeWith(rel, needle) {
  const tree = trees.find(candidate => candidate.files[rel]?.toString('utf8').includes(needle))
  assert.ok(tree, '需要含真实锚点的有限 tree：' + rel + ' :: ' + needle)
  return tree
}
function newestTree() {
  const tree = trees.at(-1)
  assert.equal(typeof tree?.commit, 'string', '需要既有官方基线 tree')
  return tree
}
function finiteApp(tree, version) {
  const appDir = mkdtempSync(path.join(tmpdir(), 'author-compat-safety-'))
  for (const [rel, buf] of Object.entries(tree.files)) {
    if (!buf) continue
    const file = path.join(appDir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, buf)
  }
  if (version) {
    const file = path.join(appDir, AUTHOR_PACKAGE_REL)
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    pkg.version = version
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }
  return appDir
}
const classify = (appDir, tree) => classifyAuthorCompatibility({ appDir, targets: Object.keys(tree.files), images: trees })

test('批准导入按钮文案保持调用结构时可接纳', () => {
  const tree = treeWith(CLIENT, '导入聊天记录')
  const base = tree.files[CLIENT].toString('utf8')
  const current = base.replace('导入聊天记录', '导入 SillyTavern 聊天记录')
  const verdict = compareAuthorContract(current, base, CLIENT)
  assert.equal(verdict.same, true, '同一 label 槽位改文案应判契约相同')
  assert.equal(verdict.presentation, true, '应识别为 presentation 差异')

  const appDir = finiteApp(tree, '2.5.1')
  try {
    writeFileSync(path.join(appDir, CLIENT), current, 'utf8')
    const result = classify(appDir, tree)
    assert.equal(result.ok, true, '真实 asset 单一共同基线下应接纳（' + JSON.stringify(result.failures.slice(0, 2)) + '）')
    assert.equal(result.mode, 'presentation')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})

test('模块路径变化不能冒充文案兼容', () => {
  const tree = newestTree()
  const base = tree.files[INDEX].toString('utf8')
  const match = /from (['"])([^'"]+)\1/.exec(base)
  assert.ok(match, '需要真实 import 路径锚点')
  const current = base.slice(0, match.index) + 'from ' + match[1] + './bogus' + match[1] + base.slice(match.index + match[0].length)
  assert.equal(compareAuthorContract(current, base, INDEX).same, false, 'import 路径变化必须拒')

  const appDir = finiteApp(tree, '2.5.1')
  try {
    writeFileSync(path.join(appDir, INDEX), current, 'utf8')
    const result = classify(appDir, tree)
    assert.equal(result.ok, false, '整树判定必须拒')
    assert.ok(result.failures.some(line => line.includes(INDEX)), '失败清单应点名该文件：' + JSON.stringify(result.failures.slice(0, 2)))
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})

test('数据键变化不能冒充文案兼容', () => {
  const tree = newestTree()
  const base = tree.files[TASK].toString('utf8')
  const match = /input\.postHistoryText/.exec(base)
  assert.ok(match, '需要真实 input.* 数据键锚点')
  const current = base.replace(match[0], 'input.postHistoryTextRenamed')
  assert.equal(compareAuthorContract(current, base, TASK).same, false, '数据键变化必须拒')

  const appDir = finiteApp(tree, '2.5.1')
  try {
    writeFileSync(path.join(appDir, TASK), current, 'utf8')
    const result = classify(appDir, tree)
    assert.equal(result.ok, false, '整树判定必须拒')
    assert.ok(result.failures.some(line => line.includes(TASK)), '失败清单应点名该文件：' + JSON.stringify(result.failures.slice(0, 2)))
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})

test('批准文案改为插值表达式时仍拒绝', () => {
  const tree = newestTree()
  const base = tree.files[TASK].toString('utf8')
  const from = "sections.push('【任务要求】\\n' + protocol)"
  assert.ok(base.includes(from), '需要真实批准槽位锚点')
  const current = base.replace(from, 'sections.push(`${unexpected}` + protocol)')
  assert.equal(compareAuthorContract(current, base, TASK).same, false, '插值表达式不得冒充批准文案')

  const appDir = finiteApp(tree, '2.5.1')
  try {
    writeFileSync(path.join(appDir, TASK), current, 'utf8')
    const result = classify(appDir, tree)
    assert.equal(result.ok, false, '整树判定必须拒')
  } finally {
    rmSync(appDir, { recursive: true, force: true })
  }
})
