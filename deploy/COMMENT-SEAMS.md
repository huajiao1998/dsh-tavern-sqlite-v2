# COMMENT-SEAMS —— 注释接缝块（format=1）

> 核心原则：**接缝命中即可安装；区块自描述即可卸载**。不校验酒馆源文件与官方原文件/冻结作者树/清单一致；用户在块外的变量、注释与代码修改不影响装卸。
> **不做源码历史**：不记录、不比较、不依赖任何"原件历史字节"（旧 before/after、旧 marker、旧恢复资产均已退役，不读不迁不复活）。
> 状态：**本轮施工中**——`blocks/plan` 精简与文档同步进行，尚未跑任何验证；在 gate 通过前不得宣称已实现/已绿。

## 1. 三层 API

### 1.1 解析层 `parseSeamSource(source, { rel }) → { ast, blocks }`
- 真实 **Acorn 8.15.0** 词法（`lib/vendor/acorn/acorn.mjs`，随包离线、无外部依赖；已入 `VENDOR_ENTRIES`）。
- 只有**独占整行的 Line 注释**才算标记；字符串/模板/正则里的伪前缀不是注释。块注释或非独占行里出现真实前缀即拒。
- `blocks[i] = { metadata, start, end, text, regions }`；`metadata` = `{format, revision, owner, id, mode, purpose}`，replace 块可带 `tail:'none'`；`regions.original/active` 内容 = `source.slice(region.beginEnd, region.endStart)`。
- 拒：缺 END、嵌套、同 owner+id 重复、子区域不对称/重复/错序、前缀不匹配格式、语法错、非 string。
- 新增导出 `seamBlockOriginal(source, block)`：replace 取现场 ORIGINAL 区**逐行只剥一层 `// `**（行内原有注释/变量/EOL 原样、不解码不格式化）；insert 返回 `''`；非空行缺前缀即拒（半截块）；`tail:'none'` 只去掉渲染期补的那 1 个 padding LF。

### 1.2 计划层 `planSeamInstall` / `planSeamUninstall`（`deploy/comment-seam-plan.mjs`）
- 纯字符串、无 fs、无代码生成器：只做区间 splice，块外字节逐字节不动。
- **安装**：先按现场自有块撤到作者投影 `base`（无记录也撤）→ 在 `base` 上按当前 descriptors 重新命中 anchor（`StatementRange`，含空语句列表=整文件 insert）→ splice；`changed = next !== source`（同源同实现 ⇒ false；ACTIVE 旧实现不同 ⇒ 撤旧重装）。
- **卸载**：现场 own 块 → `seamBlockOriginal` 还原（insert 整块删）→ splice；**块完全消失即 `changed:false` 零写**，绝不回写旧 before；无记录也能卸。
- `record` 参数仅为调用方兼容保留，**不参与任何校验**。返回/保存的 record 只含纯块 metadata：`{format:1, rel, owner, blocks:[…]}`（无 before/after/anchor）。
- 保留的拒绝：锚点必须命中且唯一、注入后语法有效、区间重叠冲突；foreign 只按**区间重叠**拒（不同 owner 同 id 不再视为冲突）。

### 1.3 写入层 `applyCommentSeams`（`deploy/comment-seam-files.mjs`）
- 调用方注入 `assertStopped()`（严格 `true`）与 `checkReady({files, record})`（严格 `true`）才写；本次快照写前比对 + 写后回读，不宣称原子CAS。失败仅恢复本次可证明的有限写集，第三方/部分写冲突保留现场。
- 可选摘要落 `.tavern-comment-seams.json`：`{format:1,owner,files,owned}`；`files[rel]={format,rel,owner,blocks:[metadata]}`，`owned[rel]={format,rel,owner,mode:'owned-new'}`。没有源码before/after、桥body或历史anchor。摘要缺失、损坏或过时，不控制现场区块装卸；操作后的摘要由现场重新生成，卸载清掉摘要。

## 2. 块形态
- `replace`：`ORIGINAL_BEGIN/END` 内逐行 `// ` 保留**现场**作者代码（含用户改动）；`ACTIVE_BEGIN/END` 内是本插件实现。
- `insert`：只含 ACTIVE；插件新建桥以 `id='owned-file'` 区块承载实现，已有普通文件不得冒认。卸载按现场区块撤除，若剩余文件为空才删文件；用户块外追加原样保留，无须外部记录。
- `tail='none'`：仅当原片段非空且原本不以 LF 结尾时渲染，标识"渲染期补的 1 个结构换行"，不是 before 内容。
- 编码：按现场串处理；BOM 不重写、CRLF/LF 原样保留；**裸 CR / U+2028 / U+2029 出现在原片段即拒**（会成为行终止符）。

## 3. 维护执行器与升级
- 接线工厂读取当前源码的撤缝投影，命中必需接口后注入；不比官方原文件，不以作者版本不同拒绝。区块完全消失时保留现有代码，清理剩余自有块/摘要，重新接入；半截或归属不明的边界不猜删。
- 同名新块机制插件换代：停止态下在单条维护命令内卸旧装配、装新包、按当前接口施缝；失败恢复本次操作前装配/源码状态。首次从旧marker/旧记录机制切换，仍由旧CLI先卸；两条命令不冒称一个事务。
- 原档只读与禁止自动迁移的业务不变；接管期启动保护纳入可撤区块，不在块外永久改作者入口。卸载解除现场原代码后恢复作者自身行为，不转换SQLite档、不访问真实用户数据。

## 4. 明确不做与验证边界
- 不做：源码历史与历史一致性校验、按旧记录回写before、内容哈希/邻接摘要身份、作者版本认证、第二套恢复框架、对既有酒馆文件整文件包装。新建插件桥区块不属于既有文件包装。
- `tail` 缺失是正常有末尾换行的原片段，不作拒绝理由。安装需要接口可定位、注入有效；卸载不重新命中原接口，只依据现场区块。
- 本轮本地验证进行中，未发布/未部署；最终具名证据与剩余边界以施工回执为准，不把语法/隔离装卸当作页面或真实玩法验收。
