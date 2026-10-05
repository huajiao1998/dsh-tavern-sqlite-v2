// 明确可选的 rc.2 真身锚点闸：仅已下载的源码 fixture，绝不读取存档。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformLegacyIndex, transformLegacyRegistry, transformLegacyInitialization, transformLegacyViewReader } from '../deploy/apply-legacy-view-seams.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.resolve(here,'../../../.tmp-verify-clean-install')
const cases = [
  ['blank-clean-host-0930.js',transformLegacyIndex],
  ['blank-clean-registry-0930.js',transformLegacyRegistry],
  ['blank-clean-initialization-0930.js',transformLegacyInitialization],
  ['blank-clean-view-reader-0930.js',transformLegacyViewReader]
]
const own = mkdtempSync(path.join(here,'.legacy-production-anchors-'))
try {
  writeFileSync(path.join(own,'package.json'),'{"type":"module"}\n','utf8')
  for (const [name,transform] of cases) {
    const source = readFileSync(path.join(fixtureRoot,name),'utf8')
    const transformed = transform(source)
    assert.equal(transform(transformed),transformed,'真实锚点幂等：'+name)
    const output = path.join(own,name)
    writeFileSync(output,transformed,'utf8')
    execFileSync(process.execPath,['--check',output],{stdio:'inherit'})
  }
} finally { rmSync(own,{recursive:true,force:true}) }
console.log('legacy-view-production-anchors：rc.2 真身四模块锚点/幂等/语法全部通过')
