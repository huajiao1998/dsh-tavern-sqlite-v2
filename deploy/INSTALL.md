# V2 一键安装 / 卸载

包名与独立仓库：`dsh-tavern-sqlite-v2`。V2 使用服务端 MVU / 卡脚本 VM / ESM 与 SQLite；V1 使用作者浏览器执行。两版不能在同一实例共装。

## 支持范围

- **适配酒馆版本以对应 [Release 下载页面](https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases)更新说明为准。** 0.4.3 的适配目标为上游 `a2008bf932031616fd80ec265cbdba5d0b559312`（简称 `a2008bf`，Tavern2.5.0；runtime `68dff3dd` / sequence582）。已发布0.4.2尚不包含本次适配及标准目录改造。
- **其他未适配版本使用过程中可能出现运行错误。** 安装接入检查通过不代表运行期功能兼容；请更新到对应 Release 标注的适配酒馆版本，或自行适配本插件后使用。版本标注是兼容说明，不新增作者SHA、签名或纯净源码准入。

- macOS、Linux、WSL2 CLI 与 Windows（桌面版 Electron、原生 Windows CLI）。要求 DSH / boot 0.1.5-rc.2、Node.js 22.19+（建议 24，维护核 SQLite / zstd / VM 能力）。未知作者源码布局或未知管理器明确拒绝，不猜测覆盖；作者版本号只作**诊断定位**。
- **接入准入**：必需接缝锚点在本次真实源码上命中、隔离副本完整施缝、语法与接缝就绪检查通过 ⇒ 允许安装。不校验文件与 runtime manifest 或冻结作者树一致性；缺失/过时的清单、删除无关说明文件、用户改块外代码（不破坏锚点）均不影响安装。
- **发布状态**：现场注释区块装卸自 **0.3.8** 起已公开发布，机制说明见 [COMMENT-SEAMS.md](<COMMENT-SEAMS.md>)；旧机制（≤0.3.7）现场需先用旧版插件自带 CLI 完整卸载，再安装本版。
- 本指南描述的是**当前源码**。安装要求当前必需接口可定位、注入语法有效，不认证作者源码。DSH / boot与离线vendor能力要求保持；同名插件换版本由统一维护命令清旧装配再安装，不因包字节不同直接拒绝。
- 运行依赖零 npm 外部依赖：`json5`、`jsonrepair`、`lodash`、`yaml` 与注释块词法器 `acorn`（8.15.0，MIT）均已 vendor 进包内，安装不联网补依赖。
- 当前源码在各平台统一复制程序到酒馆标准数据插件目录，包内 peer 仍链接宿主同一物理实例；不再把本包加为 profile 依赖或 bundle，不调用包管理器装卸本包，不重装其它依赖、不联网补 SDK。
- POSIX 维护路径保留 `--experimental-vm-modules` 启动资格检查；已有 systemd 单元可用 `--prepare-env` 授权备份并补旗标（失败自动回滚），不加则不改启动配置。Windows CLI 通过既有 Worker 取得 VM 能力，拒绝 `--prepare-env` / systemd 接管。

## 标准目录与一次性安装（0.4.3 起）

程序唯一落点为 `<DSH_HOME>/profile-data/tavern/data/plugins/dsh-tavern-sqlite-v2/`。安装维护入口只执行一次：停止对应酒馆，保存程序、具名启动装配与必要注释区块，然后按原方式恢复。**以后正常启动不需要再次执行安装命令，也不在每次启动时施缝。**

- SQLite 持久化、宿主补丁、作者启动包装作为三条持久早期行加载；ID 不使用作者会批量重写的 `tavern-user-plugin-` 前缀。SQLite 会话根保持原位置，不搬迁数据库。
- 作者自身扫描标准目录，加载普通 [插件入口](<../plugin.js>)，由它注册命令和 `tavern.handle`；浏览器通过 `tavernUi.callHost` 通信，不再另设存档 HTTP 路由。嵌套启动清单没有 client 声明，只有普通根入口拥有浏览器来源。
- 正常启动只核验已保存区块；宿主补丁或区块未就绪则响亮拒绝，不能继续启动混合后端。正常退出只释放本进程作者行及插件资源，**不撤回安装区块**。作者升级覆盖区块后，停止酒馆并运行一次安装维护以重接，不是每次开机安装。
- 卸载须用统一维护入口：先按现场完整区块撤自有注入，再移除本包程序、早期行和作者扫描保存的普通行；保留其它插件、用户配置、原档和所有数据库。直接删除目录不等于完整卸载。
- 旧同名 profile 依赖 / bundle / 链接和旧程序目录在受控换代时清理，失败恢复本次原位置与配置字节；双源或不明归属拒绝，不叠装第二份。用户现有 `disabled:true` 覆盖不冒认成安装器资产。

标准目录 / callHost 改造自 0.4.3 起提供。请从对应 Release 获取 0.4.3 或包含此改造的后续版本；已有 0.4.2 不会自动变为标准目录装配，升级须执行一次安装维护。

## 公开一键命令

安装到已有酒馆（默认自动识别目录，无需手填路径）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- install
```

卸载（保留原档和所有数据库）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall
```

只读预检（不改源码、装配或服务状态）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall --check
```

**目录默认自动识别**：检查 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前工作目录与 `~/.dsh-tavern` 下的已有 tavern profile。找到唯一目标就直接继续；未找到或有多个实例时才提示 `--home`，不把手填路径作为正常步骤，也不扫描全盘猜目录。

仓库根 `install.sh` 会完整获取 latest 正式 Release 的 SH 再执行；失败或空文件不执行。正式 SH 固定同代 tgz 地址、版本与 SHA256。

## 注释区块装卸与旧版切换

- 接缝以**注释区块**承载：安装时按锚点在本次真实源码上定位并落块（真实 Acorn 词法判定，字符串/模板/正则里的伪标记不算）；作者原本没有的文件按 `owned-new` 整份新建并单独记录。
- 记录落在目标根 `.tavern-comment-seams.json`（本地记录，不是存储权威），顶层恰 `{ format, owner, files, owned }`：`files` 只存**块 metadata 摘要**（不携带 before/after 历史片段，也不作卸载前提）；`owned` 只是自有文件的 metadata（`{format,owner,rel,mode:'owned-new'}`，不存 body）。新建桥文件用完整insert区块 `id='owned-file'` 自描述归属，限定显式目标，无记录也能撤除。区块外用户追加保留，文件撤空才删；未知同名普通文件不冒认。**不引用、不携带**旧作者原像资产；卸载遇源码缺失不回填，安装仍须命中必需接口。
- 块区间以外的字节在安装/卸载前后**逐字节不变**：你在接缝块之外的手改会被保留，不会因为安装或卸载被回盖。
- **卸载只看现场区块**：定位BEGIN/END及owner/id，删除ACTIVE插件实现与标识，只去掉ORIGINAL每行由安装器添加的最外面一层 `// `。原代码本来已有的注释及用户改过的变量保留，不比较历史before/after，不从记录回填。摘要缺失、损坏或过时不阻完整区块撤除；失败恢复使用本次临时快照，与卸载无关。
- **酒馆升级与插件换版本**：酒馆升级使区块消失时，保留新版酒馆源码，清理可证明的旧插件残留（块、owned 文件、装配 metadata），再重新命中接缝安装。同名插件包换版本时自动清理上版残留。
- **与旧机制切换**：现场存在旧机制记录（`.tavern-standard-seams.json`、`.tavern-seams.json`、`.tavern-legacy-view-seams.json`、`.tavern-save-ui-seam.json`）或旧接缝真实注释标记时，新版**直接拒绝**——不读旧资产、不做自动前像修复、不复活旧记录。首次从旧机制切换，请先用**旧版插件自带的 CLI** 完成卸载，再安装本版。

## Windows 一键装卸

下载 Release 附件 `dsh-tavern-sqlite-v2-<版本>-win.zip`，解压到酒馆目录内任意一层，进入解压出的 `dsh-tavern-sqlite-v2` 文件夹：

- **双击 `run-install.cmd`**（推荐）：菜单、进度直接显示在这个窗口里，结束时停住等你看，不会闪退。
- 或右键 `install.ps1` →「使用 PowerShell 运行」；也可命令行直用：

```powershell
.\install.ps1 install    # 安装（离线，用本包）
.\install.ps1 update     # 更新：联网校验官方 SHA256 后自动清旧残留再装新版
.\install.ps1 uninstall  # 卸载（保留原档与数据库）
.\install.ps1 check      # 只读预检，可开着酒馆运行
```

- 桌面版安装/卸载前请从托盘**完全退出**酒馆；完成后重新启动生效。未装 Node.js 时，安装器可复用桌面版自带运行时（Electron RUN_AS_NODE）。
- `update` 仅下载官方 GitHub Release 资产并用 `SHA256SUMS` 核对，不索取任何凭据。同名插件包换版本时自动清理上版残留。从**旧机制**首次切换到本版时，请先用**当前已安装旧包自带的 CLI** 卸载旧接缝；新版安装器在检测到旧记录/旧标记时会明确拒绝。
- Windows CLI 需 PATH Node.js 22.19+（建议 24；维护会核 SQLite/zstd/Worker 能力），不借 Electron、不改官方启动脚本。CLI 基础适配已随 0.3.1 发布；标准目录改造自 0.4.3 起提供。
- 找不到酒馆时可用 `-TavernHome <目录>` 显式指定；`run-install.cmd` 把日志写到同目录 `install.log`，报错时把 `install.log` 与 `result.json` 发给维护者即可，不必翻酒馆 `maintenance` 目录。
- 同名新块机制插件不同代走统一换代流程，不直接覆盖旧装配；先保留本次恢复依据，再清旧装配并装新代。旧机制首次切换仍需旧CLI先卸。

## Windows CLI

- CLI 基础适配自 0.3.1 起已发布；本轮标准目录装卸仅有本地隔离验证，不冒称实机装卸、页面或玩法验收。入口与桌面版相同（同一菜单、同一 `run-install.cmd`，也可直用 `.\install.ps1 install|uninstall|check`）；CLI 需 PATH 上的 Node.js 22.19+，`-DesktopApp` 只属桌面形态，拿它认领 CLI 会被拒绝。
- 菜单前先做一次**只读**目标识别（与维护侧同一份 `deploy/maintenance/target.mjs`）：识别不过就停住、不进入维护，也不写酒馆目录。
- **装卸前请你自己执行 `dsh-tavern stop` 把后台停稳**（关浏览器或终端不等于停止），完成后自己 `dsh-tavern start`；安装器只提示，**不代停、不代启**，也不替你设 `NODE_OPTIONS` 或改启动环境。`check` 是只读预检，可以开着酒馆跑。
- 运行中、CIM 查询失败、入口相对/身份模糊、跨实例或父目录链接越界都会拒绝维护，不自动结束任何进程。卸载保留存档/数据库，不把 SQLite 分叉转换回原版文件档；页面与卸后玩法仍需用户验收。

## 借助 DSH Desktop 安装的酒馆

如果先装 DSH Desktop、再在其中安装酒馆，home 通常为 `%USERPROFILE%\.dsh`，不需要改装独立酒馆桌面包：

```powershell
# 宿主目录必须是含 DSH Desktop.exe 的那层；按实际路径填写
$desktop = 'D:\应用\DSH Desktop'
.\run-install.cmd check -TavernHome "$env:USERPROFILE\.dsh" -DesktopApp "$desktop"
# 预检通过后，从托盘完全退出共享 DSH Desktop，再由你决定安装
.\run-install.cmd install -TavernHome "$env:USERPROFILE\.dsh" -DesktopApp "$desktop"
```

- `-DesktopApp` / `--desktop-app` 是**宿主程序安装根目录**，不是作者源码树 `--app`，也不是 home；参数在更新卸旧、卸载及前台/后台交接中保持。
- 要求作者 `.dsh-tavern-local.json`、home、`tavern` profile 与作者包实际链接对应；宿主需有解包式 `resources/app/lib/desktop-cli.js`、匹配的 DSH/boot/peer 与可识别 Electron 声明。缺失、错误或多个独立 launcher 时拒绝，不伪造启动器、不猜宿主。
- 装卸前需退出**整个共享 DSH Desktop**（安装器只提示，不自动结束/重启，不改其他 profile）；只读预检可在其运行时执行。纯 `app.asar` 且无解包 `resources/app` 的宿主暂不支持。
- 目前仅源码核对与隔离夹具验证，不等于页面/卡脚本已验收。

## 离线入口

完整解压包中执行：

```sh
sh deploy/install.sh install
sh deploy/install.sh uninstall
```

自动识别仅看 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前目录及 `~/.dsh-tavern`；多个目录或找不到时要求 `--home`，不扫描磁盘。`--port` 核对端口，`--systemd-unit` 指定已有单元。

## 服务、数据与验收

原来运行则按原管理方式恢复，原来停止则保持停止；停前重核 PID / 代次 / cwd / home / argv（前后各核一次停态）。维护不经迁移 launcher，不读取、复制、转换、删除存档或数据库，不代建新 ID 分叉；原档只读、用户手动新ID分叉原则不变。安装期启动保护纳入可撤区块，执行器不再隐性永久改块外源码；卸载仅解除现场原代码，不读取或执行原档迁移。用户之后启动作者程序的行为由作者代码决定；旧CLI已经保留的用户授权保护按现场代码原样保留。

包准备后共享 180 秒成功预算；超时保留失败原因并恢复原状态，不冒报成功。默认终端显示独立作业进度，终端断开后恢复继续；`--background` 返回证据目录。无需用户名、密码或 Cookie。

源码、装配、准确进程及 HTTP 基础健康**不代表**页面/玩法验收；用户须登录刷新确认。401/403/跳转只说明基础可达。

## 独立发行构建

```sh
node scripts/build-release.mjs --out ./dist --repository huajiao1998/dsh-tavern-sqlite-v2
```

输出目录须不存在，生成 tgz、Windows zip（`-win.zip`，内含包体＋根 `install.ps1`，该副本带 UTF-8 BOM 分发例外）、固定版本 install.sh、`SHA256SUMS`（tgz＋zip）、`release.json`。构建门禁只核块机制必需模块的**存在与声明**、退役旧资产路径不得回流、vendor 台账（含 acorn）齐全。不上传、不覆盖旧附件，不包含内部测试或运维资料；只有正式发布新 Release 后，公网 latest 才会取得新代。
