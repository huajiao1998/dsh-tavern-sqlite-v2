// 业务接线结果→局部整语句描述符：仅比较本次真实输入，不读作者原像或保存冻结作者树。
import { parseSeamSource } from './comment-seam-blocks.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
const lineStart = (s, i) => s.lastIndexOf('\n', i - 1) + 1
const lineEnd = (s, i) => { const n = s.indexOf('\n', i); return n < 0 ? s.length : n + 1 }
const stable = value => {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stable)
  return Object.fromEntries(Object.entries(value).filter(([k]) => !['start','end','loc','raw'].includes(k)).map(([k,v]) => [k,stable(v)]))
}
const fingerprint = node => JSON.stringify(stable(node))
export const sameSeamProgram = (left,right,rel) => fingerprint(parseSeamSource(left,{rel}).ast)===fingerprint(parseSeamSource(right,{rel}).ast)
const label = node => {
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') return node.type + ':' + (node.declaration ? label(node.declaration) : fingerprint(node.specifiers))
  if (node.type === 'ImportDeclaration') return node.type + ':' + node.source.value
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return node.type + ':' + (node.id?.name ?? '')
  if (node.type === 'VariableDeclaration') return node.type + ':' + node.declarations.map(d => d.id.name ?? fingerprint(d.id)).join(',')
  if (node.type === 'SwitchCase') return node.type + ':' + fingerprint(node.test)
  return node.type
}
// 只有真实语句数组可作区块边界；对象属性/表达式内部变化提升到其所属完整语句。
function containers(node, path = []) {
  if (!node || typeof node !== 'object') return []
  const out = []
  for (const [key,value] of Object.entries(node)) {
    if (['start','end','loc'].includes(key)) continue
    if (Array.isArray(value)) {
      if ((node.type === 'Program' || node.type === 'BlockStatement') && key === 'body' || node.type === 'SwitchCase' && key === 'consequent' || node.type === 'SwitchStatement' && key === 'cases') out.push({ path:[...path,key], nodes:value })
      else value.forEach((child,i) => out.push(...containers(child,[...path,key,i])))
    } else if (value && typeof value === 'object') out.push(...containers(value,[...path,key]))
  }
  return out
}
function lcs(a,b) {
  const rows = Array.from({length:a.length+1},() => new Uint32Array(b.length+1))
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)rows[i][j]=a[i]===b[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1])
  const pairs=[];let i=0,j=0
  while(i<a.length&&j<b.length){if(a[i]===b[j]){pairs.push([i++,j++])}else if(rows[i+1][j]>=rows[i][j+1])i++;else j++}
  return pairs
}
export function describeSeamChanges(before, after, { rel, owner }) {
  const old = parseSeamSource(before,{rel}), next = parseSeamSource(after,{rel})
  if(old.blocks.some(b=>b.metadata.owner===owner) || next.blocks.some(b=>b.metadata.owner===owner)) throw Error('描述符输入应为本次无自有块源码，不能嵌套接缝')
  const edits=[]
  const comments=[]
  parse(after,{ecmaVersion:'latest',sourceType:'module',allowHashBang:true,onComment:comments})
  const leading = index => {
    let start=lineStart(after,index)
    // 只把工厂新增的真实前导说明/标记归入ACTIVE，不改变作者原文的捕获区间。
    for(const c of [...comments].reverse()){
      if(c.end>start)continue
      if(!/^[ \t\r\n]*$/.test(after.slice(c.end,start)))break
      if(!/^[ \t]*$/.test(after.slice(lineStart(after,c.start),c.start)))break
      if(!c.value.includes('[dsh-tavern-') || c.value.includes('[dsh-tavern-seam:'))break
      start=lineStart(after,c.start)
    }
    return start
  }
  function diffList(left,right,leftPath,leftStart,leftEnd,rightStart,rightEnd) {
    // 同行多语句是一组：不能把新增的 settle() 连同既有语句整行再插一次。
    const group = (source,nodes) => {
      const groups=[]
      nodes.forEach((node,index)=>{
        const start=lineStart(source,node.start),end=lineEnd(source,node.end),last=groups.at(-1)
        if(last && start<last.end){last.nodes.push(node);last.end=Math.max(last.end,end);last.count++}
        else groups.push({nodes:[node],start,end,first:index,count:1})
      })
      return groups
    }
    const a=group(before,left),b=group(after,right)
    const sig=g=>g.nodes.map(label).join('|')
    const paired=lcs(a.map(sig),b.map(sig))
    let li=0,ri=0
    for(const [i,j] of [...paired,[a.length,b.length]]){
      if(i>li||j>ri){
        const start=li<a.length?a[li].start:leftEnd,end=i>li?a[i-1].end:start
        const c=ri<b.length?b[ri].start:rightEnd,d=j>ri?b[j-1].end:c
        const first=li<a.length?a[li].first:left.length,count=i>li?a[i-1].first+a[i-1].count-first:0
        edits.push({start,end,afterStart:c,afterEnd:d,body:after.slice(c,d),path:leftPath,first,count})
      }
      if(i<a.length){
        if(a[i].count===1&&b[j].count===1)diffNode(a[i].nodes[0],b[j].nodes[0],[...leftPath,a[i].first])
        else if(a[i].nodes.map(fingerprint).join('|')!==b[j].nodes.map(fingerprint).join('|'))edits.push({start:a[i].start,end:a[i].end,afterStart:b[j].start,afterEnd:b[j].end,body:after.slice(b[j].start,b[j].end),path:leftPath,first:a[i].first,count:a[i].count})
      }
      li=i+1;ri=j+1
    }
  }
  function diffNode(a,b,nodePath){
    if(fingerprint(a)===fingerprint(b))return
    const ac=containers(a),bc=containers(b)
    if(ac.length===bc.length && ac.length){
      const shell = (node, cs) => {
        const copy=stable(node)
        for(const c of cs){let at=copy;for(const key of c.path.slice(0,-1))at=at[key];at[c.path.at(-1)]=[]}
        return JSON.stringify(copy)
      }
      let ok=ac.every((c,i)=>JSON.stringify(c.path)===JSON.stringify(bc[i].path))
      if(ok && shell(a,ac)===shell(b,bc)){
        for(let k=0;k<ac.length;k++){
          const aa=ac[k],bb=bc[k]
          // 空体无独立行插入点时交回整语句，不凭大括号字符推断语法。
          if(!aa.nodes.length||!bb.nodes.length){ok=false;break}
        }
        if(ok){
          const checkpoint=edits.length
          for(let k=0;k<ac.length;k++)diffList(ac[k].nodes,bc[k].nodes,[...nodePath,...ac[k].path],lineStart(before,ac[k].nodes[0].start),lineEnd(before,ac[k].nodes.at(-1).end),lineStart(after,bc[k].nodes[0].start),lineEnd(after,bc[k].nodes.at(-1).end))
          const independent = edits.slice(checkpoint).every(e=>{
            let list=old.ast;for(const key of e.path)list=list[key]
            const first=list[e.first],last=e.count?list[e.first+e.count-1]:null
            return (!first || /^[ \t\uFEFF]*$/.test(before.slice(e.start,first.start))) && (!last || /^[ \t\r\n]*$/.test(before.slice(last.end,e.end)))
          })
          if(independent)return
          edits.length=checkpoint // 同行case/简写体不能半句落块：提升到最近完整语句，不吞块外字节。
        }
      }
    }
    edits.push({start:lineStart(before,a.start),end:lineEnd(before,a.end),afterStart:lineStart(after,b.start),afterEnd:lineEnd(after,b.end),body:after.slice(lineStart(after,b.start),lineEnd(after,b.end)),path:nodePath.slice(0,-1),first:nodePath.at(-1),count:1})
  }
  diffList(old.ast.body,next.ast.body,['body'],0,before.length,0,after.length)
  // 将相交语句提升到共同的完整语句；不可偷偷包住整文件，冲突明确拒。
  const ordered=edits.filter(e=>before.slice(e.start,e.end)!==e.body).sort((a,b)=>a.start-b.start || a.end-b.end)
  const merged=[]
  for(const e of ordered){
    const last=merged.at(-1)
    if(last && (e.start<last.end || e.start===last.start)){
      if(JSON.stringify(e.path)!==JSON.stringify(last.path))throw Error('跨层结构差分区间冲突：'+rel)
      last.end=Math.max(last.end,e.end);last.afterStart=Math.min(last.afterStart,e.afterStart);last.afterEnd=Math.max(last.afterEnd,e.afterEnd)
      const first=Math.min(last.first,e.first),end=Math.max(last.first+last.count,e.first+e.count)
      last.first=first;last.count=end-first;last.body=after.slice(last.afterStart,last.afterEnd)
    }else merged.push({...e})
  }
  return merged.map((e,i)=>{
    const from=leading(e.afterStart)
    const body=after.slice(from,e.afterEnd)
    return {format:1,revision:1,owner,id:'statement-'+i,mode:e.count?'replace':'insert',purpose:'插件接口接线',anchor:{type:'StatementRange',path:e.path,first:e.first,count:e.count},body}
  })
}
