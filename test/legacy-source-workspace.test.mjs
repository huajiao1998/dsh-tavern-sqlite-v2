// workspace 仅限定绑定源；模拟严格契约，不创建真实会话、目录或 registry 持久记录。
import assert from 'node:assert/strict'
import { initializeLegacySourceWorkspaces } from '../lib/legacy-source-workspace.js'
const binding = { chatId: 'chat-explicit', sessionId: 'session-genuine', originalSessionId: 'session-rebound' }
const calls = []
const header = Object.freeze({ id: binding.sessionId, cwd: '/canonical/resources', parentSession: null })
const members = []
const entity = { id: 'workspace-native', path: header.cwd, sessionIds: members,
  async attachSession(id) { calls.push(['attach',id]); members.push(id) } }
const deps = { bindings: [binding], persistence: { async stat(id) { calls.push(['stat',id]); return {header} } },
  registry: { async create(cwd) { calls.push(['create',cwd]); return entity } } }
assert.deepEqual(await initializeLegacySourceWorkspaces(deps),[
  { sessionId: binding.sessionId, workspaceId: entity.id, path: header.cwd, attached: true }
])
assert.deepEqual(calls,[['stat',binding.sessionId],['create',header.cwd],['attach',binding.sessionId]])
assert.equal((await initializeLegacySourceWorkspaces(deps))[0].attached,false)
assert.equal(calls.filter(row=>row[0]==='attach').length,1,'重复启动不得重复附着')
assert.equal(header.cwd,'/canonical/resources'); assert.equal(header.parentSession,null)
assert.deepEqual(await initializeLegacySourceWorkspaces({bindings:[]}),[])
await assert.rejects(()=>initializeLegacySourceWorkspaces({...deps,bindings:[binding,binding]}),/重复/)
await assert.rejects(()=>initializeLegacySourceWorkspaces({...deps,persistence:{stat:async()=>({header:{id:'session-unrelated',cwd:header.cwd}})}}),/匹配 header/)
await assert.rejects(()=>initializeLegacySourceWorkspaces({...deps,persistence:{stat:async()=>({header:{id:binding.sessionId}})}}),/header\/cwd/)
await assert.rejects(()=>initializeLegacySourceWorkspaces({...deps,registry:{create:async()=>({id:'workspace',path:header.cwd,sessionIds:[],attachSession:async()=>{}})}}),/后置校验/)
assert.equal(calls.some(row=>row.includes(binding.originalSessionId)),false,'绝不读取 rebound 或任何其他源')
console.log('legacy-source-workspace：显式源 stat/create/attach、幂等与失败关闭全部通过')
