// 历史维护测试夹具：保留旧回归接口，不是生产装卸入口，不进入发行tgz。
import {existsSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,lstatSync,openSync,closeSync,realpathSync} from 'node:fs'
import {spawn,spawnSync} from 'node:child_process'
import {redactStartupLine} from '../../deploy/maintenance/startup-log.mjs'
import {maintenanceCredentials,withoutMaintenanceSecrets,authenticatedRuntime} from '../../deploy/maintenance/auth.mjs'
import {parseSystemdProperties,assertSystemdTarget,assertSystemdUnchanged,systemdOwner} from '../../deploy/maintenance/systemd.mjs'
import {waitSystemdExecIdentity} from '../../deploy/maintenance/start-identity.mjs'
import {waitCompleteInventory} from '../../deploy/maintenance/readiness.mjs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {sourceAccess,assertPackageSource,assertSourceUninstalled,rehearseSource,finishSourceUninstall,STANDARD_RECORD} from '../../deploy/maintenance/source.mjs'
const family=['dsh-tavern-storage-sqlite','dsh-tavern-storage-sqlite-v1','dsh-tavern-storage-sqlite-v2','dsh-tavern-sqlite-v1','dsh-tavern-sqlite-v2']
const hash=b=>createHash('sha256').update(b).digest('hex')
const json=file=>JSON.parse(readFileSync(file,'utf8'))
export async function executeMaintenance({action,adapter,driver,source,evidenceDir,progress=()=>{}}){
 const step=async(name,fn)=>{progress(name);return await fn()}
 let stopped=false,newProcess,baseline,rehearsal,result
 try{
  // 初版自动安装只支持未装→安装或同代幂等；不在一次动作中猜跨代升级/跨线转换。
  const state=await step('预检实例/版本/装配/恢复材料',()=>driver.preflight(action,adapter))
  assertPackageSource(source,adapter)
  if(state.noop){if(action==='install'&&!adapter.checkStandardSeams({appDir:source.root}).ready)throw new Error('现装接缝未ready');if(action==='uninstall')assertSourceUninstalled(source);await driver.verify(action,adapter,{existing:true});return {changed:false,action,line:adapter.line,data:'保留',verified:false,verification:'源码/装配/HTTP可达，无变更不重启索取登录凭据；认证库存验收未重做'}}
  rehearsal=await step('有限源码副本完整预演（零业务数据）',()=>rehearseSource(action,source,adapter,evidenceDir))
  baseline=rehearsal.before
  writeFileSync(path.join(evidenceDir,'source-before.json'),JSON.stringify(baseline)+'\n','utf8')
  await step('重新核身份/源码并精确停止',async()=>{source.assertImage(baseline);await driver.assertIdentity();await driver.stop();stopped=true})
  if(action==='install'){
   await step('官方装包/回读装配',()=>driver.manage('install',adapter))
   await step('作者未加载时接入本版本接缝',()=>{source.protect();adapter.applyStandardSeams({appDir:source.root});if(!adapter.checkStandardSeams({appDir:source.root}).ready)throw new Error('接缝未ready')})
  }else{
   const raw=baseline[STANDARD_RECORD],record=raw?JSON.parse(Buffer.from(raw,'base64').toString('utf8')):null
   await step('核disposer/全历史卸缝/确切备份归档',()=>{result=finishSourceUninstall(source,adapter,record,path.join(evidenceDir,'source-archives'))})
   source.assertImage(rehearsal.expected)
   await step('官方卸包/回读装配',()=>driver.manage('uninstall',adapter))
  }
  await step('既有启动方式恢复新进程',async()=>{newProcess=await driver.start()})
  await step('新进程源码/库存/客户端/认证健康验收',async()=>{source.assertImage(rehearsal.expected,{installation:action==='install'});if(action==='install'&&!adapter.checkStandardSeams({appDir:source.root}).ready)throw new Error('启动后接缝未ready');await driver.verify(action,adapter,{process:newProcess})})
  // verified只覆盖运行装配/源码/认证健康，不能代证原档页面可看或卸后可玩。
  return {changed:true,action,line:adapter.line,execution:adapter.execution,verified:true,
   verificationScope:'runtime-source-health',originalPlayabilityVerified:false,
   data:'保留，未转换/删除',...(result||{})}
 }catch(error){
  error.message=redactStartupLine(error.message)
  // SIGTERM已发但等待报错：明确核退出边界，不能假设未停而丢弃恢复责任。
  if(!stopped&&await driver.stoppedAfterError?.())stopped=true
  if(stopped){
   try{
    progress('失败恢复：停止本次新代→官方恢复装配→恢复源码→既有启动方式及健康')
    if(newProcess)await driver.stopIfAlive(newProcess)
    else await driver.stopFailedStart?.()
    await driver.restorePackage()
    source.restore(baseline)
    // 原基线为裸作者时，安全护栏是最低恢复边界，不能重新起自动迁移的原版。
    if(!baseline[STANDARD_RECORD])source.protect()
    source.syntax()
    const restored=await driver.start({recovery:true});await driver.verifyRecovery(restored)
    throw new Error('维护失败，已恢复原可用装配并验证健康：'+error.message,{cause:error})
   }catch(recovery){if(recovery.cause===error)throw recovery;throw new AggregateError([error,recovery],'维护失败且恢复未完成；初因：'+redactStartupLine(error.message)+'；恢复原因：'+redactStartupLine(recovery.message)+'；不盲目重试')}
  }
  throw error
 }
}
export function options(argv){
 const out={action:argv.shift()}
 for(let i=0;i<argv.length;i++){const key=argv[i];if(['--check','--apply','--internal','--online'].includes(key))out[key.slice(2)]=true;else if(['--home','--app','--profile','--port','--evidence','--systemd-unit'].includes(key)){if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('参数缺值：'+key);out[key.slice(2)]=argv[++i]}else throw new Error('未知参数：'+key)}
 if(!['install','uninstall'].includes(out.action))throw new Error('动作须为install或uninstall')
 if(!out.home||!out.app||!out.profile||!/^\d+$/.test(out.port||'')||Number(out.port)<1||Number(out.port)>65535)throw new Error('必须显式指定--home --app --profile --port')
 if(out.apply===out.check)throw new Error('必须且只能选择--check（预检）或--apply（执行）')
 if(!/^[\w-]+$/.test(out.profile))throw new Error('profile不合法')
 if(out['systemd-unit']&&!/^[A-Za-z0-9_.@-]+\.service$/.test(out['systemd-unit']))throw Error('systemd单元名不合法')
 out.home=path.resolve(out.home);out.app=path.resolve(out.app);return out
}
// 网络只在操作员明确--online时启用；全链不运行生命周期脚本。
export function packagePolicyArgs(op){return [...(op.online?[]:['--offline']),'--ignore-scripts']}
export function networkWorkerArgs(op){return op.online?['--online']:[]}
function packageFiles(root){
 const pkg=json(path.join(root,'package.json')),allowed=new Set(['package.json',...(existsSync(path.join(root,'INSTALL.zh-CN.md'))?['INSTALL.zh-CN.md']:[]),...pkg.files.map(s=>s.replace(/\/\*.*$/,''))]),out=[]
 function walk(rel){
  const src=path.resolve(root,rel);if(!src.startsWith(path.resolve(root)+path.sep)||rel.includes('..')||rel.split(path.sep).includes('node_modules'))throw new Error('包声明路径越界或依赖目录')
  if(!existsSync(src))throw new Error('包声明文件缺失：'+rel)
  const st=lstatSync(src);if(st.isSymbolicLink())throw new Error('打包文件不接受外部链接：'+rel)
  if(st.isDirectory()){for(const e of readdirSync(src))walk(path.join(rel,e))}else if(st.isFile())out.push(rel)
 }
 for(const rel of allowed){if(rel.includes('*'))throw new Error('未支持的包files声明：'+rel);walk(rel)}
 return [...new Set(out)].sort()
}
export function copyPackage(from,to){
 for(const rel of packageFiles(from)){const dst=path.resolve(to,rel);if(!dst.startsWith(path.resolve(to)+path.sep))throw new Error('包复制目的越界');mkdirSync(path.dirname(dst),{recursive:true});copyFileSync(path.resolve(from,rel),dst)}
 return json(path.join(from,'package.json'))
}
function command(exe,args,{cwd,env,timeout=30000,capture=false}={}){
 const result=spawnSync(exe,args,{cwd,env,timeout,encoding:'utf8',stdio:capture?'pipe':'inherit'})
 if(result.error)throw result.error;if(result.status!==0)throw new Error('命令失败/超时：'+path.basename(exe)+' '+args.slice(0,3).join(' '))
 return capture?result.stdout:undefined
}
async function packageCommand(exe,args,{cwd,env,timeout=30000}){
 const child=spawn(exe,args,{cwd,env,detached:true,stdio:'inherit'});let timedOut=false,timer,force
 await new Promise((resolve,reject)=>{
  child.once('spawn',()=>{timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM')}catch{};force=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},1000)},timeout)})
  child.once('error',error=>{clearTimeout(timer);clearTimeout(force);reject(error)})
  child.once('exit',code=>{clearTimeout(timer);clearTimeout(force);if(timedOut){try{process.kill(-child.pid,'SIGKILL')}catch{};reject(new Error('包管理30秒边界超时；已终止本次自建进程组，防后台继续改装配'))}else if(code!==0)reject(new Error('官方包管理失败：'+String(code)));else resolve()})
 })
}
export function loopbackListenerPid(text,port){
 const rows=text.split('\n').filter(line=>line.trim().split(/\s+/)[3]===`127.0.0.1:${port}`)
 const pids=[...new Set(rows.flatMap(line=>[...line.matchAll(/pid=(\d+)/g)].map(m=>Number(m[1]))))]
 if(!rows.length||rows.some(line=>!line.includes('pid='))||pids.length!==1||!Number.isSafeInteger(pids[0])||pids[0]<=0)throw new Error('指定loopback端口没有唯一目标进程')
 return pids[0]
}
function identity(port,home,app,profile){
 if(process.platform!=='linux')throw new Error('首版只适配已核准Linux直接CLI，其他进程管理器写前拒绝')
 // 同端口可能有Docker转发；只认与完整argv --host一致的精确loopback监听。
 const ss=command('ss',['-H','-ltnp',`sport = :${port}`],{capture:true,timeout:5000})
 return readIdentity(loopbackListenerPid(ss,port),home,app,profile,port)
}
function readIdentity(pid,home,app,profile,port){
 const proc='/proc/'+pid,argv=readFileSync(proc+'/cmdline').toString('utf8').split('\0').filter(Boolean)
 const env=withoutMaintenanceSecrets(Object.fromEntries(readFileSync(proc+'/environ').toString('utf8').split('\0').filter(s=>s.includes('=')).map(s=>[s.slice(0,s.indexOf('=')),s.slice(s.indexOf('=')+1)])))
 const cwd=realpathSync(proc+'/cwd'),cli=path.join(home,'runtime/bin/dsh'),expected=['--profile',profile,'--host','127.0.0.1','--port',String(port),'--no-open']
 const index=argv.indexOf(cli)
 if(index<1||JSON.stringify(argv.slice(index+1))!==JSON.stringify(expected)||cwd!==app||env.DSH_HOME!==home||realpathSync(proc+'/exe')!==realpathSync(argv[0]))throw new Error('PID/CLI/完整argv/cwd/home不匹配，拒绝停服')
 if(argv.slice(1,index).some(s=>s!=='--experimental-vm-modules'))throw new Error('未知Node启动参数，拒绝自动维护')
 const stat=readFileSync(proc+'/stat','utf8'),start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]
 return {pid,argv,env,cwd,start}
}
function sameIdentity(a,b){if(a.pid!==b.pid||a.start!==b.start||JSON.stringify(a.argv)!==JSON.stringify(b.argv))throw new Error('进程代已变化，拒绝操作旧PID')}
export function assertLaunchMode(action,adapter,argv){if(action==='install'&&adapter.requiresVmModules&&!argv.includes('--experimental-vm-modules'))throw new Error('V2需要既有Node --experimental-vm-modules；不静默改启动命令')}
export function assertLiveInventory(action,adapter,html,entries){
 const selected=entries.filter(r=>(r.moduleName||'').startsWith(adapter.packageName)||r.entryId===adapter.ownedId)
 if(action==='install'){
  if(entries.some(r=>r.moduleName===adapter.packageName&&(!r.enabled||r.fiberPhase!=='active')))throw new Error('后端未激活')
  if(selected.length!==5||selected.some(r=>!r.enabled||r.fiberPhase!=='active')||!html.includes(adapter.packageName))throw new Error('本版本插件/ownedHost/client未完整激活')
  if(entries.find(r=>r.entryId==='include:dsh-tavern')?.enabled!==false)throw new Error('原作者未禁用，双加载拒绝')
  for(const other of family.filter(p=>p!==adapter.packageName))if(entries.some(r=>r.moduleName===other||r.moduleName?.startsWith(other+'/'))||html.includes('"'+other+'"'))throw new Error('另一版本线同时激活')
 }else{
  if(entries.some(r=>family.some(p=>(r.moduleName||'')===p||(r.moduleName||'').startsWith(p+'/'))||r.entryId.includes('tavern-storage'))||family.some(p=>html.includes(p)))throw new Error('插件Host/Client运行残留')
  for(const id of ['include:dsh-tavern','include:session-persistence-jsonl']){const row=entries.find(r=>r.entryId===id);if(!row?.enabled||row.fiberPhase!=='active')throw new Error('原服务未恢复：'+id)}
 }
}
function waitExit(pid,ms=8000){return new Promise((resolve,reject)=>{
 const child=spawn('tail',[`--pid=${pid}`,'-f','/dev/null'],{stdio:'ignore'}),timer=setTimeout(()=>{child.kill();reject(new Error('目标进程8秒内未退出；不强杀'))},ms)
 child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('等待进程退出失败'))})
})}
async function request(url,{cookie,body,head=false}={}){
 const response=await fetch(url,{signal:AbortSignal.timeout(8000),method:body?'POST':head?'HEAD':'GET',redirect:'manual',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin:new URL(url).origin}:{})},...(body?{body:JSON.stringify(body)}:{})});return response
}
async function authenticated(op,authenticatedUrl,credentials){return authenticatedRuntime(op,authenticatedUrl,{credentials,request})}
function systemdProperties(unit){return parseSystemdProperties(command('systemctl',['show',unit,'-p','MainPID','-p','Type','-p','KillMode','-p','ExecStart','-p','WorkingDirectory','-p','FragmentPath','-p','Restart','-p','ActiveState'],{capture:true,timeout:5000}))}
async function waitAuthenticated(op,credentials,assertAlive){
 const deadline=Date.now()+45000
 while(true){
  assertAlive()
  const response=await request(`http://127.0.0.1:${op.port}/`,{cookie:credentials.cookie,head:true}).catch(()=>null)
  if(response&&[200,302,303,401].includes(response.status))return authenticated(op,null,credentials)
  if(Date.now()>=deadline)throw Error('新代45秒内未就绪；单次请求仍限8秒')
  await new Promise(resolve=>setTimeout(resolve,150))
 }
}
export async function startRedactedProcess({executable,argv,cwd,env,log,port,startupTimeoutMs=45000}){
 const sink=spawn(process.execPath,[fileURLToPath(new URL('../../deploy/maintenance/startup-log.mjs',import.meta.url)),log,String(port)],{cwd,detached:true,stdio:['pipe','pipe','ignore']})
 let received='',resolveAuth,rejectAuth
 const authReady=new Promise((resolve,reject)=>{resolveAuth=resolve;rejectAuth=reject});authReady.catch(()=>{})
 // 首次现场宿主补丁冷加载约17秒；只放宽进程就绪预算，HTTP每次仍限8秒。
 const authTimer=setTimeout(()=>rejectAuth(new Error('新代'+startupTimeoutMs+'毫秒内未发布认证就绪URL')),startupTimeoutMs)
 sink.stdout.setEncoding('utf8');sink.stdout.on('data',data=>{received+=data;const end=received.indexOf('\n');if(end>=0){try{const value=JSON.parse(received.slice(0,end));clearTimeout(authTimer);resolveAuth(value.url)}catch{clearTimeout(authTimer);rejectAuth(new Error('脱敏启动URL通道无效'))}}})
 sink.once('error',()=>{clearTimeout(authTimer);rejectAuth(new Error('启动脱敏器失败'))});sink.once('exit',()=>{clearTimeout(authTimer);rejectAuth(new Error('新代在就绪前退出'))})
 await new Promise((resolve,reject)=>{sink.once('spawn',resolve);sink.once('error',()=>reject(new Error('启动脱敏器创建失败')))})
 const child=spawn(executable,argv,{cwd,env,detached:true,stdio:['ignore',sink.stdin,sink.stdin]})
 try{await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})}catch(error){sink.stdin.destroy();sink.kill();clearTimeout(authTimer);throw error}
 child.unref();sink.stdin.destroy();sink.unref()
 return {child,authReady,sink}
}
// 只复制配置显式引用的本地.patch；不扫描profile、数据或凭据目录。
export function copyPatchMaterials(profileDir,material,manifest){
 const references=Object.values(manifest.pnpm?.patchedDependencies||{})
 const workspace=path.join(profileDir,'pnpm-workspace.yaml')
 if(existsSync(workspace)){
  const lines=readFileSync(workspace,'utf8').split(/\r?\n/);let inside=false
  for(const line of lines){
   if(/^patchedDependencies:\s*(?:#.*)?$/.test(line)){inside=true;continue}
   if(!inside)continue
   if(!line.trim()||/^\s*#/.test(line))continue
   if(/^\S/.test(line)){inside=false;continue}
   const match=/^\s+[^:]+:\s+(.+?)\s*$/.exec(line)
   if(!match)throw new Error('patchedDependencies布局未适配，停前拒绝')
   let ref=match[1];if((ref.startsWith("'")&&ref.endsWith("'"))||(ref.startsWith('"')&&ref.endsWith('"')))ref=ref.slice(1,-1)
   references.push(ref)
  }
 }
 for(const ref of new Set(references)){
  if(typeof ref!=='string'||!/^patches\/[\w@.+-]+\.patch$/.test(ref))throw new Error('补丁须为profile内patches/*.patch明确文件，停前拒绝')
  const src=path.join(profileDir,ref),dst=path.join(material,ref)
  if(!existsSync(src)||lstatSync(path.dirname(src)).isSymbolicLink()||lstatSync(src).isSymbolicLink()||!lstatSync(src).isFile()||!realpathSync(src).startsWith(realpathSync(profileDir)+path.sep))throw new Error('引用补丁缺失/链接/越界，停前拒绝：'+ref)
  mkdirSync(path.dirname(dst),{recursive:true});copyFileSync(src,dst)
 }
 return [...new Set(references)]
}
// 锁文件被移动到隔离副本时，pnpm的目录resolution/包ID/version仍相对原profile。
// 同时改引用及resolution，保留registry版本/integrity，不重新解算依赖、不改真实锁文件。
export function rebaseRehearsalLock(text,profileDir){
 const absolute=ref=>path.resolve(profileDir,ref).split(path.sep).join('/')
 return text.replace(/\b(file:|link:)(\.{1,2}\/[^\s'"),}]+)/g,(_,kind,ref)=>kind+absolute(ref))
  .replace(/(\bdirectory:\s*)(\.{1,2}\/[^\s'"),}]+)/g,(_,key,ref)=>key+absolute(ref))
}
function profileState(profileDir){const data=json(path.join(profileDir,'package.json'));return {data,deps:data.dependencies||{},bundles:data.dsh?.profile?.bundles||[]}}
export function createLinuxDriver(op,adapter,packageRoot,evidenceDir){
 const profileDir=path.join(op.home,'profiles',op.profile),installed=path.join(profileDir,'node_modules',adapter.packageName),env={...withoutMaintenanceSecrets(process.env),DSH_HOME:op.home,DSH_TAVERN_CLI_HOME:op.home},pkg=json(path.join(packageRoot,'package.json'))
 let original,prior,backupPackage,latest,launchNumber=0,stopSignalled=false,managedUnit
 let credentials=maintenanceCredentials()
 const inspectUnit=()=>systemdProperties(op['systemd-unit'])
 async function manage(action,root=packageRoot){
  const args=action==='install'?['add','file:'+root]:['remove',adapter.packageName]
  await packageCommand(original.argv[0],[path.join(op.home,'runtime/bin/dsh'),'plugin','--profile',op.profile,...args,...packagePolicyArgs(op)],{cwd:op.app,env,timeout:30000})
  const state=profileState(profileDir),present=!!state.deps[adapter.packageName]&&state.bundles.includes(adapter.packageName)&&existsSync(installed)
  const otherDeps=value=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==adapter.packageName).sort(([a],[b])=>a.localeCompare(b)))
  if(JSON.stringify(otherDeps(state.deps))!==JSON.stringify(otherDeps(prior.deps))||JSON.stringify(state.bundles.filter(name=>name!==adapter.packageName))!==JSON.stringify(prior.bundles.filter(name=>name!==adapter.packageName)))throw new Error('官方操作改变了非目标依赖/bundle，拒绝冒认单包维护成功')
  if((action==='install')!==present)throw new Error('官方包操作后依赖/bundle/链接回读未匹配')
  if(action==='uninstall'&&(state.deps[adapter.packageName]||state.bundles.includes(adapter.packageName)||existsSync(installed)))throw new Error('卸包装配残留')
 }
 const driver={
  async preflight(action){
   if(pkg.name!==adapter.packageName||pkg.version!=='0.1.0')throw new Error('维护入口与本地包身份/受支持版本不一致')
   if(op.home==='/root/.dsh'||Number(op.port)===3080)throw new Error('禁碰实例写前拒绝')
   if(op.app!==path.join(op.home,'apps/dsh-tavern'))throw new Error('首版只支持该home的既有作者应用树')
   for(const p of [op.home,op.app,profileDir])if(!existsSync(p)||realpathSync(p)!==path.resolve(p))throw new Error('home/app/profile路径需存在且无符号链接，避免越界目标')
   original=identity(op.port,op.home,op.app,op.profile);prior=profileState(profileDir)
   const cgroup=readFileSync('/proc/'+original.pid+'/cgroup','utf8'),owner=systemdOwner(cgroup)
   if(op['systemd-unit'])managedUnit=assertSystemdTarget({unit:op['systemd-unit'],properties:inspectUnit(),cgroup,identity:original})
   else if(owner)throw Error('目标由systemd管理，必须显式--systemd-unit；禁止PID停服后旁路启动')
   if(!original.env.PATH)throw new Error('原服务PATH不可用，不猜启动依赖环境')
   env.PATH=original.env.PATH
   await packageCommand('pnpm',['--version'],{cwd:op.app,env,timeout:5000});command('tail',['--version'],{capture:true,timeout:5000})
   for(const key of family)if(key!==adapter.packageName&&(prior.deps[key]||prior.bundles.includes(key)))throw new Error('另一版本线已安装，先单独卸载：'+key)
   for(const name of ['dsh','dsh-app-boot'])if(json(path.join(op.home,'runtime/lib/node_modules/@deepseek-ai',name,'package.json')).version!=='0.1.5-rc.2')throw new Error('只适配已核rc.2运行时')
   const author=json(path.join(op.app,'tavern-plugin/package.json'));if(author.name!=='dsh-tavern-plugin'||author.version!=='2.4.0')throw new Error('作者版本不匹配')
   const linked=path.join(profileDir,'node_modules/dsh-tavern-plugin');if(!existsSync(linked)||realpathSync(linked)!==path.join(op.app,'tavern-plugin'))throw new Error('profile作者包不指向指定应用树，拒绝改错源码')
   assertLaunchMode(action,adapter,original.argv)
   const patch=readFileSync(path.join(profileDir,'cordis.patch.yml'),'utf8').replace(/^\s*#.*$/gm,'').trim();if(patch!=='[]'&&patch!=='')throw new Error('用户patch非空，须先核override不能自动猜')
   const present=!!prior.deps[adapter.packageName]
   if(present!==prior.bundles.includes(adapter.packageName)||present!==existsSync(installed))throw new Error('依赖/bundle/包链接状态不一致')
   if(present){
    if(json(path.join(installed,'package.json')).name!==adapter.packageName)throw new Error('已安装包身份不符')
    const files=packageFiles(packageRoot),actual=packageFiles(installed);if(JSON.stringify(files)!==JSON.stringify(actual))throw new Error('已安装包声明内容与本入口不同代')
    for(const rel of files)if(!existsSync(path.join(installed,rel))||hash(readFileSync(path.join(installed,rel)))!==hash(readFileSync(path.join(packageRoot,rel))))throw new Error('现装代码不是本入口同代，禁止猜旧代卸载/升级：'+rel)
    // 同代已核executor-package就是完整恢复源，不再复制另一整套包。
    backupPackage=packageRoot
   }
   const record=existsSync(path.join(op.app,STANDARD_RECORD))
   if(present&&!record)throw new Error('装配仍在但缺标准记录，不猜已卸')
   if(!present&&record)throw new Error('源码标准代仍在但包不在，不自动认领')
   if(action==='uninstall'&&!present){
    for(const name of ['.tavern-seams.json','.tavern-legacy-view-seams.json','.tavern-save-ui-seam.json'])if(existsSync(path.join(op.app,name)))throw new Error('已卸包装配但历史记录仍在，需核源码归属')
    const code=readFileSync(path.join(op.app,'tavern-plugin/lib/index.js'),'utf8');protectAuthorStartupForCheck(code);return {noop:true}
   }
   if(!(action==='install'&&present)){
    // 仅隔离的依赖副本验证离线安装/恢复；不装Loader、不写真实profile、不运行脚本。
    // 复用同home现行manifest/锁文件与pnpm缓存，不创建或枚举任何用户业务目录。
    const material=path.join(evidenceDir,'dependency-rehearsal');mkdirSync(material,{recursive:true})
    const anchored=Object.fromEntries(Object.entries(prior.deps).map(([name,spec])=>{const hit=/^(file:|link:)(.+)$/.exec(spec);return [name,hit?hit[1]+path.resolve(profileDir,hit[2]):spec]}))
    const mirror={...prior.data,dependencies:{...anchored,[adapter.packageName]:'file:'+packageRoot}}
    writeFileSync(path.join(material,'package.json'),JSON.stringify(mirror,null,2)+'\n','utf8')
    // 不读取/复制npmrc凭据；离线依赖只靠本机缓存或显式本地路径。
    for(const name of ['pnpm-lock.yaml','pnpm-workspace.yaml'])if(existsSync(path.join(profileDir,name))){
      const raw=readFileSync(path.join(profileDir,name),'utf8')
      writeFileSync(path.join(material,name),name==='pnpm-lock.yaml'?rebaseRehearsalLock(raw,profileDir):raw,'utf8')
     }
    copyPatchMaterials(profileDir,material,prior.data)
    await packageCommand('pnpm',['install',...packagePolicyArgs(op),'--no-frozen-lockfile'],{cwd:material,env,timeout:30000})
    if(!existsSync(path.join(material,'node_modules',adapter.packageName,'package.json')))throw new Error('离线依赖材料不完整，停前拒绝')
   }
   // 在第一次停服前真实验证操作员认证，不能改完后才发现密码门禁挡住恢复验收。
   if(op.apply&&!(action==='install'&&present)){
    const auth=await authenticated(op,null,credentials);credentials={cookie:auth.cookie,username:'',password:''}
   }
   if(managedUnit&&!credentials.cookie&&!(action==='install'&&present)&&op.apply)throw Error('systemd维护需要停服前确认可恢复的合法认证Cookie')
   return {noop:action==='install'&&present}
  },
  async assertIdentity(){sameIdentity(original,identity(op.port,op.home,op.app,op.profile));if(managedUnit)assertSystemdUnchanged(managedUnit,inspectUnit())},
  async stop(target=original){
   sameIdentity(target,readIdentity(target.pid,op.home,op.app,op.profile,op.port))
   if(managedUnit){const properties=inspectUnit();assertSystemdUnchanged(managedUnit,properties);if(Number(properties.MainPID)!==target.pid)throw Error('systemd主进程已变化，拒绝停旧代');if(target===original)stopSignalled=true;command('systemctl',['stop',managedUnit.unit],{timeout:10000});if(existsSync('/proc/'+target.pid)||Number(inspectUnit().MainPID)!==0)throw Error('systemd停止后仍有主进程，未执行源码/包写入')}
   else{process.kill(target.pid,'SIGTERM');if(target===original)stopSignalled=true;await waitExit(target.pid)}
  },
  async stoppedAfterError(){
   if(!stopSignalled)return false
   if(!existsSync('/proc/'+original.pid))return true
   sameIdentity(original,readIdentity(original.pid,op.home,op.app,op.profile,op.port))
   // 不在仍运行的原代旁启动第二进程；超时报告而非强杀或写回源码。
   throw new Error('已发送SIGTERM但原进程仍在，拒绝自动并起/强杀；无包或源码写入')
  },
  async stopIfAlive(target){
   if(managedUnit){const properties=inspectUnit();assertSystemdUnchanged(managedUnit,properties)
    const pid=Number(properties.MainPID)
    if(pid)await driver.stop(readIdentity(pid,op.home,op.app,op.profile,op.port))
    else command('systemctl',['stop',managedUnit.unit],{timeout:10000}) // 同一单元取消待执行自动重启。
   }else if(existsSync('/proc/'+target.pid))await driver.stop(target)
  },
  async stopFailedStart(){if(managedUnit)return driver.stopIfAlive(latest||original);if(latest&&existsSync('/proc/'+latest.pid)){const current=readIdentity(latest.pid,op.home,op.app,op.profile,op.port);if(latest.start)sameIdentity(latest,current);await driver.stop(current)}},
  async manage(action){await manage(action)},
  async restorePackage(){const now=profileState(profileDir);if(prior.deps[adapter.packageName])await manage('install',backupPackage);else if(now.deps[adapter.packageName])await manage('uninstall')},
  async start(){
   const readyDeadline=Date.now()+45000
   if(managedUnit){
    const properties=inspectUnit();assertSystemdUnchanged(managedUnit,properties);if(Number(properties.MainPID)!==0)throw Error('systemd已有进程，拒绝并起')
    command('systemctl',['start',managedUnit.unit],{timeout:10000})
    const pid=Number(inspectUnit().MainPID);if(!pid)throw Error('systemd启动未取得唯一主进程')
    const started=await waitSystemdExecIdentity({pid,currentPid:()=>{const value=inspectUnit();assertSystemdUnchanged(managedUnit,value);return value.MainPID},probe:target=>{
     const cmd='/proc/'+target+'/cmdline';if(!existsSync(cmd))return null
     const argv=readFileSync(cmd).toString('utf8').split('\0').filter(Boolean)
     if(JSON.stringify(argv)!==JSON.stringify(original.argv))return null
     return readIdentity(target,op.home,op.app,op.profile,op.port)
    }})
    latest={...started,managed:true,readyDeadline}
    latest.authReady=waitAuthenticated(op,credentials,()=>sameIdentity(latest,readIdentity(pid,op.home,op.app,op.profile,op.port)));latest.authReady.catch(()=>{})
    return latest
   }
   launchNumber++;const log=path.join(evidenceDir,'startup-'+launchNumber+'.log')
   const {child,authReady}=await startRedactedProcess({executable:original.argv[0],argv:original.argv.slice(1),cwd:original.cwd,env:withoutMaintenanceSecrets(original.env),log,port:op.port})
   // sink独立持有日志，即使维护结束也继续消费服务stdout；URL仅当前执行器内存。
   latest={pid:child.pid,argv:original.argv,env:original.env,cwd:original.cwd,log,authReady,readyDeadline}
   try{latest.start=readIdentity(child.pid,op.home,op.app,op.profile,op.port).start}catch(error){if(existsSync('/proc/'+child.pid))throw error;latest.exited=true}
   return latest
  },
  async verify(action,_adapter,{process:target,existing=false}={}){
   const item=target||original
   if(existing){
    // 无变更也验证现行源码，HTTP401只说明门禁，不能冒称认证首页通过。
    if(action==='install'&&!adapter.checkStandardSeams({appDir:op.app}).ready)throw new Error('现装接缝未ready')
    sameIdentity(item,identity(op.port,op.home,op.app,op.profile))
    const response=await request(`http://127.0.0.1:${op.port}/`,{head:true});if(![200,401,302,303].includes(response.status))throw new Error('现行HTTP不可达')
    console.log('幂等无变更：只验证源码/装配/进程/HTTP可达，不把401称作认证健康');return
   }
   const authenticatedUrl=await item.authReady
   if(!item.managed&&/(?:Error:|failed to load|failed startup|旧档迁移完成|后台恢复历史对话失败)/.test(readFileSync(item.log,'utf8')))throw new Error('新代启动错误/自动历史恢复，拒绝成功')
   sameIdentity(item,identity(op.port,op.home,op.app,op.profile))
   if(managedUnit)assertSystemdUnchanged(managedUnit,inspectUnit())
   const initial=item.managed?authenticatedUrl:await authenticated(op,authenticatedUrl,credentials)
   await waitCompleteInventory({initial,deadline:item.readyDeadline,assertIdentity:()=>sameIdentity(item,identity(op.port,op.home,op.app,op.profile)),read:cookie=>authenticated(op,null,{cookie}),assertComplete:({html,entries})=>assertLiveInventory(action,adapter,html,entries),snapshot:({html,entries})=>writeFileSync(path.join(evidenceDir,'runtime-inventory-'+item.pid+'.json'),JSON.stringify({pid:item.pid,at:new Date().toISOString(),clientRegistered:html.includes(adapter.packageName),entries:entries.map(({entryId,moduleName,enabled,fiberPhase})=>({entryId,moduleName,enabled,fiberPhase}))},null,2)+'\n','utf8')})
   if(action==='install'){
    if(!adapter.checkStandardSeams({appDir:op.app}).ready)throw new Error('本版本接缝未ready')
   }else{
    for(const e of readdirSync('/proc/'+item.pid+'/fd')){let link;try{link=realpathSync('/proc/'+item.pid+'/fd/'+e)}catch{continue}if(/\/tavern\/chats\/.*\.db|\/sessions\.db|\/variables\.db|\/script-dispatch\.db/.test(link))throw new Error('卸载仍持有插件DB句柄')}
    const lock=path.join(profileDir,'pnpm-lock.yaml');if(existsSync(lock)&&readFileSync(lock,'utf8').includes(adapter.packageName))throw new Error('锁文件仍含目标包')
   }
  },
  async verifyRecovery(target){await driver.verify(prior.deps[adapter.packageName]?'install':'uninstall',adapter,{process:target})},
 }
 return driver
}
import {assertProtectedAuthor} from '../../deploy/maintenance/author-safety.mjs'
function protectAuthorStartupForCheck(code){assertProtectedAuthor(code)}
export function runCli(url,adapter){
 if(!process.argv[1]||path.resolve(process.argv[1])!==fileURLToPath(url))return
 const main=async()=>{
  if(process.argv.includes('--help')){console.log(`${adapter.packageName} 标准${adapter.line}装卸（Linux/作者2.4.0/DSH rc.2）\nnode deploy/maintenance.mjs install|uninstall --home <home> --app <应用树> --profile tavern --port <端口> [--systemd-unit <既有单元.service>] [--online] --check|--apply\n--online显式允许包管理联网，默认offline；所有模式均ignore-scripts，不关闭供应链策略。\n--check仅有限源码/依赖预演；--apply脱离终端，停前合法认证，失败恢复，不删除用户数据。\n密码门禁：环境变量DSH_TAVERN_MAINTENANCE_COOKIE或DSH_TAVERN_MAINTENANCE_USERNAME＋DSH_TAVERN_MAINTENANCE_PASSWORD；不写凭据文件。\nsystemd实例须显式既有单元；不改unit、不起旁路进程。\n${adapter.requiresVmModules?'V2需既有--experimental-vm-modules，缺失停前拒绝':'V1浏览器需在线/就绪，不要求卡VM旗标'}。`);return}
  const op=options(process.argv.slice(2)),root=path.dirname(path.dirname(fileURLToPath(url)))
  if(process.platform!=='linux'||op.home==='/root/.dsh'||Number(op.port)===3080)throw new Error('仅适配Linux既有CLI；禁碰实例/未适配系统在任何落盘前拒绝')
  if(op.internal&&(!op.evidence||!op.apply))throw new Error('内部作业须有证据路径且只执行apply')
  const evidence=op.evidence?path.resolve(op.evidence):path.join(op.home,'maintenance',adapter.packageName,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID())
  if(!evidence.startsWith(path.join(op.home,'maintenance')+path.sep))throw new Error('证据必须位于该home独立maintenance目录，不接受业务路径')
  for(let p=evidence;p!==path.dirname(op.home);p=path.dirname(p))if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('维护证据路径不接受符号链接')
  mkdirSync(evidence,{recursive:true,mode:0o700})
  if(op.apply&&!op.internal){
   if(process.platform!=='linux'||op.home==='/root/.dsh'||Number(op.port)===3080)throw new Error('仅已核Linux实例，禁碰实例/未适配系统在后台启动前拒绝')
   const staged=path.join(evidence,'executor-package');copyPackage(root,staged)
   const worker=[process.execPath,path.join(staged,'deploy/maintenance.mjs'),op.action,'--home',op.home,'--app',op.app,'--profile',op.profile,'--port',op.port,'--apply','--internal','--evidence',evidence,...networkWorkerArgs(op),...(op['systemd-unit']?['--systemd-unit',op['systemd-unit']]:[])]
   // OS flock只保护同一实例的维护进程，不是数据库/存档锁；异常退出由内核自动释放。
   const quote=s=>"'"+s.replaceAll("'","'\\''")+"'",lock=path.join(op.home,'maintenance',op.profile+'-'+op.port+'.lock'),script=path.join(evidence,'job.sh')
   command('flock',['--version'],{capture:true,timeout:5000})
   writeFileSync(script,'#!/bin/sh\nflock --close --nonblock --conflict-exit-code 75 '+[lock,...worker].map(quote).join(' ')+'\nrc=$?\nif [ "$rc" -eq 75 ]; then printf \'{"ok":false,"message":"该实例已有维护作业，未执行第二次装卸"}\\n\' > '+quote(path.join(evidence,'result.json'))+'; fi\nprintf "维护作业退出码=%s\\n" "$rc"\nexit "$rc"\n',{encoding:'utf8',mode:0o600})
   const fd=openSync(path.join(evidence,'job.log'),'wx'),child=spawn('/bin/sh',[script],{cwd:op.app,env:{...process.env},detached:true,stdio:['ignore',fd,fd]});closeSync(fd)
   await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();console.log('维护已后台启动；作业PID='+child.pid+'；日志='+path.join(evidence,'job.log')+'；结果='+path.join(evidence,'result.json'));return
  }
  const source=sourceAccess(op.app,adapter.targets),driver=createLinuxDriver(op,adapter,root,evidence)
  const progress=stage=>console.log(new Date().toISOString()+' '+stage)
  try{
   let result
   if(op.check){const state=await driver.preflight(op.action);if(process.env.DSH_TAVERN_MAINTENANCE_COOKIE||process.env.DSH_TAVERN_MAINTENANCE_USERNAME)await authenticated(op,null,maintenanceCredentials());assertPackageSource(source,adapter);if(state.noop&&op.action==='uninstall')assertSourceUninstalled(source);if(state.noop&&op.action==='install'&&!adapter.checkStandardSeams({appDir:op.app}).ready)throw new Error('现装接缝未ready');result={check:true,...(state.noop?{changed:false,already:true}:rehearseSource(op.action,source,adapter,evidence).result)};result.network=op.online?'online-explicit':'offline';progress('有限源码预检通过；未停服/未装卸包/未访问用户数据')}
   else result=await executeMaintenance({action:op.action,adapter,driver,source,evidenceDir:evidence,progress})
   writeFileSync(path.join(evidence,'result.json'),JSON.stringify({ok:true,...result},null,2)+'\n','utf8');console.log(JSON.stringify({ok:true,...result}))
  }catch(error){writeFileSync(path.join(evidence,'result.json'),JSON.stringify({ok:false,message:redactStartupLine(error.message)},null,2)+'\n','utf8');throw error}
 }
 main().catch(error=>{console.error('标准维护失败：'+redactStartupLine(error.message));process.exitCode=1})
}
