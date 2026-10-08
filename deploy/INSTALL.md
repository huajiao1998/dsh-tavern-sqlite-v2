# V2 一键安装 / 卸载

包名与独立仓库：`dsh-tavern-sqlite-v2`。V2 使用服务端 MVU / 卡脚本 VM / ESM 与 SQLite；V1 使用作者浏览器执行。两版不能在同一实例共装。

## 支持范围

- macOS、Linux、WSL2 CLI；已有作者 2.5.0（接缝与有限恢复基线复核至 `3100d223`）、DSH / boot 0.1.5-rc.2、Node.js 22.19+、pnpm。未知作者源码布局或未知管理器明确拒绝，不猜测覆盖。作者版本号只作**诊断定位**；已有代可按“全目标共用同一份 baseline 契约结构”验证；0.3.5 起，未收录代也可按本地 `dsh-tavern-runtime.json` 验证受管文件摘要/大小、包身份与路径，经隔离完整施缝、语法与现场身份复检后接纳。清单一致性不等于官方签名认证或未来全部语义兼容，必要锚点变化仍拒绝；清单缺失/不匹配时保留冻结契约判断。安装保存本次精确前像，卸载不自动联网猜原件。同包重装按受控刷新处理而不是盲目覆盖。本指南不对其它接口/数据 ABI 变化作自动承诺；DSH / boot rc2、同 generation 不同插件包、vendor 台账仍按各自门禁守住。
- Windows 10 1803+：公开 0.3.0 支持桌面版（Electron）；本地源码新增原生 Windows CLI 停态装卸，尚未发布，见下节。卡脚本按 VM 能力分叉：主进程具备 VM 时原进程执行，否则用已有带实验旗标的 Worker，不按系统名称硬判。
- 四个解析器 json5、jsonrepair、lodash、yaml 已vendor到包内，零运行时npm依赖。POSIX 官方包管理固定 `--offline --ignore-scripts --config.auto-install-peers=false`；Windows 复用本包复制、profile link/junction 与宿主 peer 同实例链接，不重装其它依赖、不联网补 SDK。兜底卸载不依赖旧包解析器/包管理。
- POSIX 维护路径保留 `--experimental-vm-modules` 启动资格检查。已有 systemd 单元可加 `--prepare-env` 授权备份并补旗标、失败恢复；不加不改启动配置。新 Windows CLI 路径通过既有 Worker 取得 VM 能力，不要求修改后台启动旗标，拒绝 `--prepare-env`/systemd 接管。

## 公开一键命令

安装到已有酒馆（默认自动识别目录，无需手填路径）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- install
```

卸载（保留原档和所有数据库）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall
```

检查恢复材料，但不改源码、装配或服务状态：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall --check
```

**目录默认自动识别**：检查 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前工作目录和 `~/.dsh-tavern` 下的已有 tavern profile。找到唯一目标就直接继续；只有未找到或多个实例时才提示用 `--home` 指定目标，不把手填路径作为正常安装步骤，也不扫描全盘猜目录。自定义位置若不在这些候选中，需从酒馆 home 工作目录执行或按提示选择。

仓库根 `install.sh` 也会完整获取 latest 正式 Release SH 再执行；失败或空文件不执行。正式 SH 固定同代 tgz 地址、版本与 SHA256。

## Windows 一键装卸（0.2.3 起）

下载 Release 附件 `dsh-tavern-sqlite-v2-<版本>-win.zip`，解压到酒馆目录内任意一层（例如 `D:\Program Files (x86)\DSH-Tavern\`），进入解压出的 `dsh-tavern-sqlite-v2` 文件夹：

- **双击 `run-install.cmd`**（推荐）：菜单、进度直接显示在这个窗口里，选序号回车即可；结束时停住等你看，不会闪退。
- 或右键 `install.ps1` →「使用 PowerShell 运行」；也可命令行直用（自动化/排错）：

```powershell
.\install.ps1 install    # 安装（离线，用本包）
.\install.ps1 update     # 更新：联网校验官方 SHA256 后先卸旧再装新
.\install.ps1 uninstall  # 卸载（保留原档与数据库）
.\install.ps1 check      # 只读预检，可开着酒馆运行
```

- 桌面版安装/卸载前请从托盘**完全退出**酒馆；完成后重新启动生效。未装 Node.js 时，安装器可复用桌面版自带运行时（Electron RUN_AS_NODE）。
- `update` 仅下载官方 GitHub Release 资产并用 SHA256SUMS 核对，不索取任何凭据。
- 本地 Windows CLI 适配需 PATH Node.js 22.19+（建议 24；维护会核 SQLite/zstd/Worker 能力），不借 Electron、不改官方启动脚本。正式 Release 尚不包含此适配。
- 找不到酒馆时可用 `-TavernHome <目录>` 显式指定。
- **Windows 推荐双击 `run-install.cmd`**（0.2.7 起随包提供）：它绕过执行策略、把菜单与进度实时显示在窗口里（不会把输出藏进日志让你盲输序号），结束时总是暂停，双击不会闪退。日志由 `install.ps1` 自己写到同目录 `install.log`；万一 PowerShell 在执行脚本前就失败（无 BOM 被按 ANSI 解码、执行策略拦截），`run-install.cmd` 会捕获并显示启动错误，尝试追加到同一日志；独立的临时错误日志路径也会显示。**脚本始终只执行一次**，不会因日志转到临时目录而重跑安装。也可继续右键 `install.ps1` 运行。
- 0.2.7起，安装器日志**进入脚本就立即打开**（不再等跑到维护步骤）：没找到酒馆/Node、参数不合法这类早期失败同样会留下日志。日志固定为脚本同目录 `install.log`（每次覆盖），不是酒馆维护证据，不读取存档；脚本目录不可写时改放 `%TEMP%\dsh-tavern-install.log` 并在窗口里告知。等待条件不再依赖宿主类型：只要还连着控制台，除 `-Yes` 外一律停住等你看（点窗口叉或输入0才是正常退出）。
- **安装阶段产物只落插件包目录**：`install.log` 与 `result.json`（维护入口通过 `--report-dir` 写的用户可见结果）都在 `install.ps1` 同目录；报错时把这两个文件发给维护者即可，不必去翻酒馆 `maintenance` 目录。酒馆维护目录只保留安装期内部证据材料（预演副本、单元备份等）。
- “现装不同代”指插件包差异，不是酒馆版本不匹配；安装仍不盲目覆盖不同代。新卸载实现会处理可证明的升级覆盖/半装残留，0.2.9新增兜底能力见下节。

升级已有旧版：先卸旧，再安装新包。获取器只在本地完整包与发行版同代时复用，否则下载固定新发行附件。坏现装包不可当执行器，但不再据此拒绝残留卸载；使用完整新包。没有装配且源码已确认卸净才是幂等，不以“没看到包”早退。不跨V1/V2认领。

## Windows CLI（本地适配，未随正式 Release 发布）

- **未发布**：Windows CLI 形态的适配只在本地源码与隔离夹具核对过，**不在正式 Release 支持范围内**，也不冒称实机装卸、页面或玩法验收；正式包仍按上节只支持桌面版。
- 入口与桌面版完全相同：同一个菜单、同一个 `run-install.cmd`，也可直用 `.\install.ps1 install|uninstall|check`。CLI 需要 PATH 上的 Node.js 22+；**不借 Electron 宿主进程当 Node**（`-DesktopApp` 只属于桌面形态，拿它认领 CLI 会被拒绝）。
- 菜单前先做一次**只读**目标识别（跑维护侧同一份 `deploy/maintenance/target.mjs` 的 `options`/`runtimeFor`，只认 CLI 形态）：识别不过就停住、不进入维护，也不写酒馆目录。
- **装卸前请你自己执行 `dsh-tavern stop` 把后台停稳**（关浏览器或关终端都不等于停止）；装/卸完成后由你自己 `dsh-tavern start`。安装器只提示，**不代停、不代启**，也不替你设 `NODE_OPTIONS` 或改启动环境。
- `check` 是只读预检（不改装配、不碰存档），**可以开着酒馆跑，不要求先 stop**。
- 本地 WinCLI 请用 `install` / `uninstall` / `check`；`update` 拉的是官方最新 Release 包，在适配正式发布前不保证含本形态。
- 官方 CLI 默认后台主进程无实验 VM 旗标时，已有能力选择会走带旗标的 Worker；隔离验证已跑真实 ESM 和宿主读写，不因此新增主旗标或改作者启动器。作者程序在 `home/apps/dsh-tavern`、profile 在 `home/profiles/tavern`，私有 SDK 在 `home/runtime/node_modules`；这里只认该实例的真实 JS bin，不借全局 DSH，也不把 CMD 包装器当 JS。

自选目录可显式指定（本地适配包，非当前正式下载包）：

```powershell
# 先由你自己停止官方后台服务；关闭浏览器/终端不算停止
& "$env:USERPROFILE\.dsh-tavern\bin\dsh-tavern.cmd" stop
.\run-install.cmd install -TavernHome "$env:USERPROFILE\.dsh-tavern"
# 卸载用同一入口的 uninstall；只读预检用 check，check无需先stop
& "$env:USERPROFILE\.dsh-tavern\bin\dsh-tavern.cmd" start
```

运行中、CIM查询失败、入口相对/身份模糊、跨实例或父目录链接越界会拒绝维护，不自动结束任何进程。卸载保留存档/数据库，不把SQLite分叉转换回原版文件档；页面与卸后玩法仍需用户验收。

## 借助 DSH Desktop 安装的酒馆（0.3.0，待实机验收）

如果是先安装 DSH Desktop，再在其中安装酒馆，home 通常为 `%USERPROFILE%\.dsh`，不需要改装独立酒馆桌面包。使用含此适配的新包，在解压目录执行：

```powershell
# 宿主目录必须是含 DSH Desktop.exe 的那层；按你的实际安装路径填写
$desktop = 'D:\应用\DSH Desktop'
.\run-install.cmd check -TavernHome "$env:USERPROFILE\.dsh" -DesktopApp "$desktop"
# 预检通过后，从托盘完全退出共享 DSH Desktop，再由你决定安装
.\run-install.cmd install -TavernHome "$env:USERPROFILE\.dsh" -DesktopApp "$desktop"
# update / uninstall 同样带上这两个参数；不带动作时打开菜单
```

- `-DesktopApp` / 维护入口 `--desktop-app` 是**宿主程序安装根目录**，不是作者源码树 `--app`，也不是 home；参数在更新卸旧、卸载及维护前台/后台交接中保持。
- 要求作者的 `.dsh-tavern-local.json`、home、`tavern` profile 和作者包实际链接对应。宿主需有解包式 `resources/app/lib/desktop-cli.js`、匹配的 DSH/boot/peer 和可识别 Electron 声明；缺失、错误或多个独立 launcher 运行时仍拒绝，不伪造启动器、不猜宿主。
- 本形态的维护进程需 PATH 或既有工具缓存中的 Node（须具备 `node:sqlite` 与 zstd；建议 Node.js 24）。首版不把共享 Desktop.exe 当维护 Node，避免宿主运行检测把维护进程误判为酒馆；不绕过在运行保护。原独立桌面包的运行时复用不变。
- 实际装卸前需退出**整个共享 DSH Desktop**；安装器只提示，不自动结束/重启它，不修改其他 profile。只读预检可在它运行时执行，但会写安装器日志/维护证据。
- 目前仅源码核对及隔离夹具验证，不等于 issue 报告环境已安装、页面/卡脚本已验收；0.3.0 提供此代码级适配，0.2.9 及更早安装器不接受新宿主参数。纯 `app.asar` 且无解包 `resources/app` 的宿主暂不支持。

## 双平台兜底卸载（0.2.9）

Windows 的 `install.ps1 uninstall` / 菜单 3 和 Linux 一键命令的 `uninstall` 使用同一个维护实现，不需要额外“强制”参数；0.2.9 起生效。请下载新包，不要继续用旧安装器卸载。

- 安装中断、依赖/bundle/链接不齐、旧插件包损坏或版本不同，都不再以“必须先有完整安装”为卸载前提；不调用损坏旧包、不要求旧包 vendor/peer/VM 能力、不依赖 pnpm remove。
- 作者升级已覆盖的文件，只有与随包可信官方源码逐字节匹配才原样保留；不能仅凭无标记放行。
- 仍有本插件接缝或中断写入的文件，以准确作者发布提交对应的可信有限官方源码恢复。污染 before、旧备份不当恢复权威，不改 after 哈希冒充一致。
- 本插件新建模块、四份接缝记录及确切自有源码备份保留恢复前像后清理；装配只摘本包依赖/bundle与本包链接/安装目录，包代码归档，不递归删除共享 node_modules。
- 修改前逐字节复核并保存本次源码/装配前像；失败尝试恢复两者，不以部分撤除冒报卸净。`uninstall --check` 只读列计划。
- 没有对应可信官方原像、文件归属无法确认、另一产品线或路径/符号链接越界时，保留现场并明确报缺什么材料，**不靠删除酒馆目录或存档解决**。
- 原件独立启动保护仍保留，卸载不触发原档自动迁移，不把 SQLite 分叉转换回作者文件式存档。数据保留不等于卸载后 SQLite 分叉可直接由原版游玩。

恢复资产随包覆盖**已审查的有限作者树**（数量随包更新，不在此写死）；这是卸载恢复材料，不是安装 SHA 白名单。新作者发布需更新可信材料后验证，不能声称已支持任意未来布局/外部篡改。

## 作者兼容三例（0.3.2 新增）

- 以下三项为 0.3.2 新增，已通过受影响的具名断言验证；0.3.1 不包含。验证使用有限官方源码与受控宿主/维护假件，不代替桌面实机或页面验收。安装新版插件不会自动升级酒馆或自动迁移存档。
- ① 作者版本号不同、契约未变：仍可安装——判据是"全目标共用同一份 baseline 契约结构"（批准槽位与静态文案可保留，其余数据/代码逐字节一致），版本号仅作诊断；作者 semver 实际施缝成功时，strict 检查/卸载须按 schema=1 的**实际记录**工作，而不是"任何新版本一律拒绝"。
- ② 只更新文案/提示词：批准槽位的文字保留并自动重接——目前覆盖导入按钮标签及后台任务提示的明确静态文本位置。其余代码、调用/拼接结构与插值表达式必须一致；不把所有字符串当成可随意修改的文案。
- ③ 同包重装覆盖缝：在完整有限投影符合相同作者契约时受控刷新，只重接源码，不重复装包。新前像与子接缝备份取当前作者原件；副本预演后再核现场，成功才接入。卸载/撤缝仍必须核当前文件与记录 `after` 一致，不能用旧 `before` 覆盖尚未接入的作者更新；不新增 force 参数。
- 不承诺：其它接口/数据 ABI 变化不自动兼容；DSH / boot rc2、同 generation 不同插件包、vendor 台账仍按原门禁拒绝或保留现场。

## 前像保护与旧记录自动恢复（0.2.1，历史正常路径说明）

- 不再删除含接缝内容的备份后从当前缝合态重建；保留备份并明确报告。
- 标准记录缺失但核心接缝仍在时，不把当前入口捕获成新的“作者原文”。
- 旧版卸载恢复链失效时，自动查本包 `maintenance/dsh-tavern-sqlite-v2/` 下已有的安装前像，不扫描存档、Git 或其他实例。
- 候选必须是洁净安装前像，作者包身份匹配；在有限源码副本中重新施缝，**全部活动目标 JS 必须与当前源码逐字节相等**，并真实预演卸载成功，才可使用。不同候选产生不同卸载后像时拒绝猜测。
- 修复只更新可验证的 `before`，**不修改 `after` 校验哈希**；真实源码漂移仍拒绝。执行前保存当前材料与证明结果，同版 install 也可修复这类元数据，不停止或重启服务。
- `--check` 只写本次维护诊断副本，目标不改；结果会报告 `repairAvailable`。缺少或删除历史安装证据、候选不匹配、未知代际时仍安全拒绝，明确报“前像不可恢复”，不承诺修复任意外部篡改。

## 离线入口

完整解压包中执行：

```sh
sh deploy/install.sh install
sh deploy/install.sh uninstall
```

也可给正式 SH 指定本地包：`--package ./dsh-tavern-sqlite-v2-0.2.3.tgz`。源码 SH 不含发行摘要，不能单独用于联网下载；正式 SH 由构建器生成。

自动识别仅看 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前目录及 `~/.dsh-tavern`；多个目录或找不到时要求 `--home`，不扫描磁盘。`--port` 核对端口，`--systemd-unit` 指定已有单元。

## 服务、数据与验收

原来运行则按原管理方式恢复；原来停止则保持停止。停前重核 PID / 代次 / cwd / home / argv。维护不经迁移 launcher，不读取、复制、转换、删除存档或数据库，不代建新 ID 分叉。原档只读、用户手动新 ID 分叉原则不变。

包准备后共享 60 秒成功预算；超时保留失败原因并恢复原状态，不冒报成功。默认终端显示独立作业进度，终端断开后恢复继续；`--background` 返回证据目录。无需用户名、密码或 Cookie。

源码、装配、准确进程及 HTTP 基础健康不代表页面/玩法验收；用户须登录刷新确认。401/403/跳转只说明基础可达，性能和跨平台真实停启须另行实测。

## 独立发行构建

```sh
node scripts/build-release.mjs --out ./dist --repository huajiao1998/dsh-tavern-sqlite-v2
```

输出目录须不存在，生成 tgz、Windows zip（`-win.zip`，内含包体＋根 `install.ps1`，该副本带 UTF-8 BOM 分发例外）、固定版本 install.sh、SHA256SUMS（tgz＋zip）、release.json。不上传、不覆盖旧附件，不包含内部测试或运维资料。只有正式发布新 Release 后，公网 latest 才会取得新代。
