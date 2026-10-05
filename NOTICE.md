# 来源与许可证

本项目为DSH Tavern的独立修改版插件，不是上游官方发行。2026-10-05公开整理。

上游：[flizzywine/dsh-tavern](https://github.com/flizzywine/dsh-tavern)，适配基准2.5.0（d5b2e6c4b9ffa611d6281d122113f4265a441d1a），采用GNU AGPL v3。本仓库以AGPL-3.0-only发布，许可证全文见[LICENSE](<LICENSE>)。上游来源文件的原有声明保留。

主要派生模块：conversation-fork-point、chat-history-rescue、read-variables、domain/host-session-patch及卡脚本MVU执行族（mvu/、server-execution）；其余SQLite后端、接缝转换与维护执行器为本项目修改/新增。DSH运行时与上游应用需由使用者另行获取，本仓库不分发私有宿主运行时。

公开版不携带私有环境存档身份；可用DSH_TAVERN_EXCLUDED_CHAT_ID显式指定不进入目录的chatId。该变量是可选的维护排除输入，不是授权系统。

部署者应按AGPL要求向远程用户提供所运行修改版的对应源码链接。本程序不提供任何担保。
