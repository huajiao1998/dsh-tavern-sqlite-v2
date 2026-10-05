// Type=simple的start返回不保证exec已完成；只等同一个MainPID，不追替代代际。
export async function waitSystemdExecIdentity({pid,currentPid,probe,budgetMs=3000,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('systemd起机主PID不合法')
 const deadline=now()+budgetMs
 while(true){
  if(Number(currentPid())!==pid)throw Error('systemd起机主PID已变化；拒绝追新代')
  const identity=probe(pid)
  if(identity){if(identity.pid!==pid)throw Error('exec身份返回了其它PID');return identity}
  if(now()>=deadline)throw Error('systemd主PID在3秒exec就绪边界内未完成启动；未猜身份')
  await pause(25)
 }
}
