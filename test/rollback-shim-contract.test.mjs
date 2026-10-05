// 部署契约闸：作者树核心变换动态索引的后台 seq 导出必须真的存在。
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const source=readFileSync(new URL('../deploy/rollback-cleanup.shim.js',import.meta.url),'utf8')
test('部署shim导出前台与后台严格回退函数',async()=>{
  const exportNames=[...source.matchAll(/export const (\w+)\s*=/g)].map(match=>match[1])
  for(const name of ['cleanupAfterRollback','preflightRollback','preflightRollbackAtSeq','cleanupAfterRollbackAtSeq','cleanupRollbackHeadIndex']) assert.ok(exportNames.includes(name),`shim缺少${name}`)
  assert.match(source,/impl\?\.preflightRollbackAtSeq/)
  assert.match(source,/impl\?\.cleanupAfterRollbackAtSeq/)
})
test('后台回退transform引用的shim函数与实际出口同名',async()=>{
  const transform=readFileSync(new URL('../deploy/core-rollback-transform.mjs',import.meta.url),'utf8')
  const required=[...transform.matchAll(/rollbackExport\('(\w+)'\)/g)].map(match=>match[1])
  const exported=new Set([...source.matchAll(/export const (\w+)\s*=/g)].map(match=>match[1]))
  for(const name of new Set(required)) assert.ok(exported.has(name),`transform引用${name}但shim未导出`)
})
