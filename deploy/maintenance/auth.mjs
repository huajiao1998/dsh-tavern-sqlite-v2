// 合法维护认证：操作员Cookie/密码仅驻内存；不读账号文件、不造会话、不关闭门禁。
export function maintenanceCredentials(env=process.env){
 const cookie=env.DSH_TAVERN_MAINTENANCE_COOKIE||'',username=env.DSH_TAVERN_MAINTENANCE_USERNAME||'',password=env.DSH_TAVERN_MAINTENANCE_PASSWORD||''
 if(/[\r\n]/.test(cookie)||Boolean(username)!==Boolean(password))throw Error('维护认证环境参数不完整或Cookie格式不合法')
 return {cookie,username,password}
}
export function withoutMaintenanceSecrets(env){return Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('DSH_TAVERN_MAINTENANCE_')))}
export async function authenticatedRuntime(op,launchUrl,{credentials=maintenanceCredentials(),request}={}){
 const root=`http://127.0.0.1:${op.port}`,cookies=new Map()
 function merge(value){for(const part of value.split(/;\s*/)){const at=part.indexOf('=');if(at>0)cookies.set(part.slice(0,at),part.slice(at+1))}}
 function absorb(response){for(const value of response.headers.getSetCookie())merge(value.split(';')[0])}
 function sameOrigin(value){const url=new URL(value,root);if(url.origin!==root||url.username||url.password)throw Error('认证重定向越界，未发送凭据');return url.href}
 const cookie=()=>[...cookies].map(([key,value])=>key+'='+value).join('; ')
 if(credentials.cookie)merge(credentials.cookie)
 let next=root+'/'
 if(!credentials.cookie&&credentials.username){
  const response=await request(root+'/dsh-webui-auth/login',{body:{username:credentials.username,password:credentials.password}})
  const value=await response.json().catch(()=>null)
  if(response.status!==200||value?.ok!==true)throw Error('操作员密码认证失败；停服前拒绝，不重试或输出凭据')
  absorb(response);if(!cookies.has('dsh_wua_session'))throw Error('密码认证未返回有效会话Cookie')
  next=value.redirect?sameOrigin(value.redirect):next
 }else if(launchUrl)next=sameOrigin(launchUrl) // 核心Cookie可能随新进程换代；携合法门禁Cookie重做核心交换。
 let home
 for(let step=0;step<4;step++){
  home=await request(next,{cookie:cookie()});absorb(home)
  if(home.status===200)break
  const location=home.headers.get('location')
  if(![302,303].includes(home.status)||!location)throw Error('认证首页未200；不以未认证响应冒认健康')
  next=sameOrigin(location)
  if(new URL(next).pathname==='/dsh-webui-auth/login')throw Error('密码门禁需要操作员维护Cookie或用户名/密码环境变量；停服前拒绝')
 }
 if(home?.status!==200)throw Error('认证跳转超过有限边界，未通过健康验收')
 const html=await home.text();if(!html.includes('__DSH_BOOT__'))throw Error('认证响应不是酒馆页面，不以登录页200冒认健康')
 const rpc=await request(root+'/api/pluginInventory/list',{cookie:cookie(),body:{type:'client-request',rpcId:'maintenance-inventory',method:'pluginInventory/list',payload:{args:{}}}})
 const reply=await rpc.json().catch(()=>null)
 if(rpc.status!==200||!reply?.result?.ok||!Array.isArray(reply.result.value?.entries))throw Error('认证只读插件库存RPC失败')
 return {html,entries:reply.result.value.entries,cookie:cookie()}
}
