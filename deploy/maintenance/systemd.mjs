// 显式systemd维护；先核既有单元与精确进程，不改unit/VM旗标，不另起旁路进程。
export function parseSystemdProperties(text){return Object.fromEntries(text.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)]}))}
export function assertSystemdTarget({unit,properties,cgroup,identity}){
 if(!/^[A-Za-z0-9_.@-]+\.service$/.test(unit))throw Error('systemd单元名不合法')
 const expected='/'+unit
 if(!cgroup.split('\n').some(line=>line.trim().endsWith(expected)))throw Error('systemd单元不是该目标进程的拥有者')
 if(properties.Type!=='simple'||properties.KillMode!=='control-group'||Number(properties.MainPID)!==identity.pid||properties.WorkingDirectory!==identity.cwd)throw Error('systemd类型/进程/cwd/停止范围不匹配')
 const argv=/argv\[\]=([^;]+) ;/.exec(properties.ExecStart||'')?.[1]?.trim()
 if(argv!==identity.argv.join(' ')||!properties.FragmentPath?.endsWith('/'+unit))throw Error('systemd启动命令/单元文件不匹配；不猜或改写')
 return Object.freeze({unit,argv,cwd:properties.WorkingDirectory,fragment:properties.FragmentPath,type:properties.Type,killMode:properties.KillMode,restart:properties.Restart})
}
export function assertSystemdUnchanged(expected,properties){
 const argv=/argv\[\]=([^;]+) ;/.exec(properties.ExecStart||'')?.[1]?.trim()
 if(argv!==expected.argv||properties.WorkingDirectory!==expected.cwd||properties.FragmentPath!==expected.fragment||properties.Type!==expected.type||properties.KillMode!==expected.killMode||properties.Restart!==expected.restart)throw Error('systemd单元在维护期间发生漂移，拒绝启动/停止新配置')
}
export function systemdOwner(cgroup){return cgroup.split('\n').map(line=>line.trim().split('/').at(-1)).find(name=>name?.endsWith('.service'))}
