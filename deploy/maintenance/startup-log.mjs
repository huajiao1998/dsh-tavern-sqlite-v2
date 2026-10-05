// 新代日志脱敏器；登录URL只通过父进程管道一次性传内存，不写任何凭据文件。
import {writeFileSync,appendFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
export function redactStartupLine(line){return line.replace(/([?&#](?:token|password|secret|access_token)=)[^\s&)]+/gi,'$1<redacted>').replace(/(Bearer\s+)[\w.\-]+/gi,'$1<redacted>')}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const log=process.argv[2],port=process.argv[3]
 if(!log||!/^\d+$/.test(port||''))throw new Error('启动脱敏器参数不完整')
 writeFileSync(log,'',{encoding:'utf8',mode:0o600,flag:'wx'})
 process.stdout.on('error',()=>{})
 let buffer='',sent=false
 function line(text){
  const match=text.match(new RegExp(`https?://127\\.0\\.0\\.1:${port}[^\\s\\x1b]*token=[^\\s\\x1b]+`))
  appendFileSync(log,redactStartupLine(text)+'\n','utf8')
  if(match&&!sent){sent=true;process.stdout.end(JSON.stringify({url:match[0].replace(/\)$/,'')})+'\n')}
 }
 process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{buffer+=text;let end;while((end=buffer.indexOf('\n'))>=0){line(buffer.slice(0,end));buffer=buffer.slice(end+1)}})
 process.stdin.on('end',()=>{if(buffer)line(buffer)})
}
