// 只验有限恢复资产：pin字节可读、旧代目标集完整且新bridge为空、新代字节身份可核（不依赖tmp夹具、不联网）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { loadAuthorCleanImages, AUTHOR_IMAGES_SHA256 } from '../deploy/maintenance/residual-uninstall.mjs'
import { maintenanceTargets } from '../deploy/standard-seams.mjs'
const BRIDGE = 'tavern-plugin/lib/domain/storage-db-save.js'
const OLD = ['5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60', '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544', '5c69907994df9f432b8898168ce5dff371929c2a', '8480f7deb9b645d396bfbd75092810a8b8ad70b2']
const B741 = 'b74135535ec0b37b11ed77f252dd034c3ce5e285', DD875 = 'dd8757c8b32c5f92152339bed2599c949752a5ce'
const ALLOWED = [...maintenanceTargets.filter(rel => rel.endsWith('.js')), 'tavern-plugin/package.json']
const ASSET_SHA256 = '8ad4f84f5066b73b3c0cbc91ddb48e20c8357b7ed91aa4764cf30fb779293f72'
const NEW_APP = '04bda78eaad25adfe6979cb211a17fd85d852393', NEW_MAIN = '68215e47516637e00c75d2b4bba3192679559425'
// 04bda78 官方 manifest(dsh-tavern-runtime.json @68215e47) 声明的变动 target 字节
const CHANGED_04 = {
  'tavern-plugin/lib/index.js': '933fb276598d57b75da37067f3bdc178f98c208f2d66d2ee8358662d3456d287',
  'tavern-plugin/lib/client.js': '574eac928f00a50eb6874f626b91197bf0d8e2b6f1169ea4ecedee57efb96b9c',
  'tavern-plugin/lib/background-agent-task.js': '6db9f4c90f4748495f277f9b29a92e5458ee643b0ee5614e1cdf18f6d778c86e'
}
// 旧树冻结指纹（compact JSON；本轮新增新代树不得改动它们）
const FROZEN = {
  '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60': 'b90166ce5ca352139a15dae9feb464e6783063c8c88441734d25168611324976',
  '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544': '30c03f6916ecb5bfc6fc5898f89a51e0b6cf3d580fb88111ce44da9fe6f48c16',
  '5c69907994df9f432b8898168ce5dff371929c2a': '029ad200bf5dae3db37570eedd6fe2169e9437f3dcf568b0edba1f05f10b118d',
  '8480f7deb9b645d396bfbd75092810a8b8ad70b2': 'ccb9811c617c5b44a17f3491c98b6ad8f135dd062b29f67081d3356dfc7ac0f8',
  'b74135535ec0b37b11ed77f252dd034c3ce5e285': '2110c28515225a0f938b5a474976bedcacbd68bc7d26a3fde8d518d7ed873e37',
  'dd8757c8b32c5f92152339bed2599c949752a5ce': '2110c28515225a0f938b5a474976bedcacbd68bc7d26a3fde8d518d7ed873e37'
}
// 公开官方字节固定哈希（raw flizzywine/dsh-tavern b7413553 canonical，不依赖本地下载物）
const EXPECTED = {
  'tavern-plugin/lib/index.js': '4673eba20ffc362a75125b08cc42164792408f4ab631e0f510853643a6d100a7',
  'tavern-plugin/src/client/main.js': 'ef2123ad1454a52ba858e2cfd830966e65dcb1c18888a98b6ca693e18dfb9942',
  'tavern-plugin/lib/http/routes.js': '598ff75c391a5a72cfad27e6122348850c5215f69bfef0bf5b2242bba3dfdaff',
  'tavern-plugin/package.json': '5e6dc5961d202cfb165f16e824749f7650fea1b5615dd04654bcd0cc646884ea'
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
test('DB新桥接恢复资产各旧代完整且为空', () => {
  const catalog = loadAuthorCleanImages()
  assert.equal(catalog.version, 1); assert.equal(catalog.package, 'dsh-tavern-sqlite-v2')
  for (const commit of OLD) {
    const tree = catalog.trees.find(item => item.commit === commit)
    assert.ok(tree, '缺旧代 tree：' + commit)
    const keys = new Set(Object.keys(tree.files))
    for (const rel of ALLOWED) assert.ok(keys.has(rel), commit + ' 缺维护目标：' + rel)
    assert.equal(keys.size, ALLOWED.length, commit + ' 键数不等于当前维护目标集')
    assert.equal(tree.files[BRIDGE], null, '旧代不存在的新bridge必须为空：' + commit)
    for (const rel of ['tavern-plugin/lib/domain/chat-sqlite-store.js', 'tavern-plugin/lib/domain/storage-package.js', 'tavern-plugin/lib/domain/legacy-view-seams.js']) assert.equal(tree.files[rel], null, '旧代官方不存在的shim必须为空：' + rel)
  }
})
test('DB最新b741恢复资产字节身份与来源完整', () => {
  assert.equal(AUTHOR_IMAGES_SHA256, ASSET_SHA256)
  const catalog = loadAuthorCleanImages()
  for (const commit of [B741, DD875]) {
    const tree = catalog.trees.find(item => item.commit === commit)
    assert.ok(tree, '缺新代 tree：' + commit)
    assert.equal(tree.authorVersion, '2.5.0')
    assert.equal(Object.keys(tree.files).length, ALLOWED.length)
    for (const rel of ALLOWED) assert.ok(Object.hasOwn(tree.files, rel), commit + ' 缺维护目标：' + rel)
    for (const [rel, item] of Object.entries(tree.files)) {
      if (item === null) continue
      assert.equal(sha(Buffer.from(item.body, 'base64')), item.sha256, commit + ' 字节与摘要不符：' + rel)
    }
  }
  const b741 = catalog.trees.find(item => item.commit === B741), dd875 = catalog.trees.find(item => item.commit === DD875)
  for (const [rel, expected] of Object.entries(EXPECTED)) {
    assert.equal(b741.files[rel]?.sha256, expected, 'canonical 官方字节哈希不符：' + rel)
    assert.deepEqual(dd875.files[rel], b741.files[rel], 'dd875 与 b741 同字节身份不符：' + rel)
  }
  assert.equal(b741.files[BRIDGE], null, '本包新bridge在官方b741不存在，必须为空')
})
test('DB新代04bda78恢复资产字节身份与旧树冻结', () => {
  const catalog = loadAuthorCleanImages()
  const app = catalog.trees.find(item => item.commit === NEW_APP), main = catalog.trees.find(item => item.commit === NEW_MAIN)
  assert.ok(app && main, '缺新代 tree：' + NEW_APP + '/' + NEW_MAIN)
  for (const tree of [app, main]) {
    assert.equal(tree.authorVersion, '2.5.0')
    assert.equal(Object.keys(tree.files).length, ALLOWED.length)
    assert.equal(Object.values(tree.files).filter(item => item === null).length, 12)
  }
  const b741 = catalog.trees.find(item => item.commit === B741)
  assert.deepEqual(Object.keys(app.files).filter(rel => app.files[rel] === null), Object.keys(b741.files).filter(rel => b741.files[rel] === null), '新代 null 模式与 b741 不同')
  assert.deepEqual(app.files, main.files, '两新树 target 字节应相同（仅 pin 不同）')
  for (const [rel, item] of Object.entries(app.files)) {
    if (item === null) continue
    assert.equal(sha(Buffer.from(item.body, 'base64')), item.sha256, '新代字节与摘要不符：' + rel)
    if (CHANGED_04[rel]) assert.equal(item.sha256, CHANGED_04[rel], '变动 target 非官方新字节：' + rel)
    else assert.deepEqual(item, b741.files[rel], '未变 target 未复用 b741 已验证字节：' + rel)
  }
  for (const [commit, digest] of Object.entries(FROZEN)) {
    const tree = catalog.trees.find(item => item.commit === commit)
    assert.ok(tree, '缺旧树：' + commit)
    assert.equal(sha(Buffer.from(JSON.stringify(tree.files), 'utf8')), digest, '旧树指纹被改动：' + commit)
  }
})
