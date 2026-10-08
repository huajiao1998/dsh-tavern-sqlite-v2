// 发行打包契约（单一具名）：产物 manifest 必须含根安装指南、排除 test/**、JSON 无末尾换行，
// 且除 files 外所有源字段原样保留。纯函数级，不跑 build/pack/发布。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeReleaseManifest, releaseManifestJson, RELEASE_GUIDE } from '../scripts/release-manifest.mjs'

test('发行清单包含指南且匹配目录打包格式', () => {
  const source = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const manifest = makeReleaseManifest(source)

  assert.ok(manifest.files.includes(RELEASE_GUIDE), '产物 files 必须显式包含根安装指南（否则 pnpm 目录打包会丢弃它）')
  assert.ok(!manifest.files.some(rel => rel === 'test/**' || rel.startsWith('test/')), '产物 files 不得含 test 目录')
  assert.deepEqual(manifest.files, source.files.filter(rel => rel !== 'test/**').concat(manifest.files.includes(RELEASE_GUIDE) && !source.files.includes(RELEASE_GUIDE) ? [RELEASE_GUIDE] : []), '除追加指南外，其余声明顺序必须原样不变')

  const json = releaseManifestJson(source)
  assert.ok(!json.endsWith('\n'), '产物 package.json 不得带末尾换行（对齐 pnpm 目录打包实际字节）')
  assert.equal(json, JSON.stringify(manifest, null, 2), '必须是 JSON.stringify(...,null,2) 的规范输出')

  const { files: _ignoredSourceFiles, ...restSource } = source
  const { files: _ignoredManifestFiles, ...restManifest } = JSON.parse(json)
  assert.deepEqual(restManifest, restSource, '除 files 外所有源字段必须逐字保留')

  // 源声明不得被改动：源根没有该文件，加进源 files 会让 packageFiles(root) 直接 throw。
  assert.ok(!source.files.includes(RELEASE_GUIDE), '源 package.json 不得声明根安装指南')
})
