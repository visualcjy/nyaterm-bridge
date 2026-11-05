# nyaterm-bridge

> English: run AI commands in real NyaTerm terminal sessions, reusing the connections, groups and jump hosts already configured there, gated by a per-workspace allowlist.

让 AI 在 **NyaTerm 的真实终端会话**里执行命令（你能实时看到整个过程），并按**工作区**限制它可以用哪些 NyaTerm 分组和主机。

这是 dsh-remote 的互补件，不是替代品：

- **dsh-remote**：文件读写 / workspace 镜像 / SFTP 同步 → 继续用它。
- **nyaterm-bridge**：命令执行 → 走 NyaTerm。

## 为什么走 NyaTerm

命令不是丢进一个临时 shell，而是落在你已经在用的 NyaTerm 里，因此能直接复用它的资产、审批和留痕能力：

- **复用现成连接**：分组、跳板机、SSH / 串口 / SFTP、本地终端都是 NyaTerm 里已经配好的。AI 不用另维护一套连接配置，也不会绕开你现有的跳板链路。
- **真实终端、可观察可批准**：命令在 NyaTerm 标签页里执行，过程和输出实时可见；NyaTerm 的 External MCP 权限模式（`confirm` / `auto` / `full_access`）决定是否需要人工批准。
- **审计与回看**：MCP 调用会进入 NyaTerm 的审计日志；在 NyaTerm 里开启会话录制/保留后，AI 执行的每条命令和输出都留在会话记录里，事后可以查，适合复盘和审计。
- **白名单叠加**：工作区 allowlist 决定 AI 只能碰哪些分组、主机和连接，和 NyaTerm 自己的权限模型是两层独立的闸。

## 安装

需要 **NyaTerm（正式版）**，并在 NyaTerm 里打开 **设置 → External MCP**；DSH 侧建议 0.2.1 及以上。

- **插件市场**（`dshmarket`）：在 DSH 的 **插件 → 插件市场** 里搜索 `nyaterm-bridge`，一键安装。
- **从 GitHub 源码**：DSH 插件页 → **添加插件** → **安装第三方插件**，填 `github:visualcjy/nyaterm-bridge`；或

  ```sh
  dsh plugin --profile web add github:visualcjy/nyaterm-bridge
  ```

  普通 `dsh web` 把 `web` 换成自己的 profile；桌面端的 profile 由应用管理，请在界面里安装。
- 装好后打开 设置 → **NyaTerm 白名单**，确认「MCP 程序位置」指向本机的 `nyaterm-mcp`（通常自动检测即可）。

## 为什么不让 DSH 直接挂 NyaTerm 的 MCP

NyaTerm 自带 `nyaterm-mcp` 桥接。若用通用的 `@deepseek-ai/dsh-mcp-client` 挂它，它的原始工具会以 `mcp__nyaterm__*` 注册到 `ctx.tools`，**模型可以直接调用，绕过任何工作区校验**。

本插件因此**自己持有 MCP 连接**，只注册下面这套 `nt_*` 工具。原始工具永远不进工具表，**没有绕过面**。

## 工具

| 工具 | 作用 | 读/写 |
|---|---|---|
| `nt_connections` | 列出 NyaTerm 已保存连接与**分组路径** | 只读 |
| `nt_workspace` | 解释当前工作区的 allowlist 判定结果 | 只读 |
| `nt_sessions` | 列出当前作用域内的 NyaTerm 会话与默认会话 | 只读 |
| `nt_status` | 诊断桥接/发现文件/权限模式/工具清单 | 只读 |
| `nt_open` | 从已保存连接**打开一个真实 NyaTerm 标签页** | 写入 |
| `nt_exec` | 在指定会话里执行命令 | 写入 |
| `nt_output` | 读取该会话最近的、已去 ANSI 的输出 | 只读 |

典型流程：`nt_connections` → `nt_open` → `nt_exec` → `nt_output`。

## 前置条件

1. **NyaTerm → 设置 → 打开 External MCP**。插件靠 NyaTerm 写出的发现文档连接：
   - `~/.nyaterm-preview/mcp/discovery.json`（NyaTerm Preview）
   - `~/.nyaterm/mcp/discovery.json`（NyaTerm 正式版）
   - 也接受环境变量 `NYATERM_MCP_DISCOVERY` 或配置项 `discoveryFile`。
2. NyaTerm 里至少有一个 SSH 连接。
3. **NyaTerm 不能被锁屏/最小化**：批准提示落在 NyaTerm 窗口里，窗口不可用时命令会卡住或失败。

## 权限模型（三层）

1. **NyaTerm 侧**：External MCP 的 `permission_mode`（`confirm` 弹窗逐条批准 / `auto` 直接执行）与 `session_scope`。这是最后一道闸。
2. **allowlist**：本文件与插件配置里的「工作区 → 分组/主机」映射。**未列出的工作区默认拒绝**。
3. **守卫 `ctx.tools.guard()`**：对所有 `nt_*` 调用做**单调**同步复核，返回的拒绝无法被后续监听器翻盘。`observe: true` 的工作区还会顺带拦掉无关工具。

allowlist 的读写操作一律走**工具体内已 await 的校验**做主判，守卫只作兜底（守卫是同步的，拿不到连接列表）。

## 配置 allowlist

**首选在图形界面里改**：DSH 设置 → **NyaTerm 白名单**（客户端插件，页面左右栏与「远程工作区」同一位置）。它从 NyaTerm 实时拉取分组/连接，工作区从 DSH 的工作区列表里选，保存后立即生效。同一个页面里的「MCP 程序位置」用来指定 `nyaterm-mcp`（见下节）。

底层是一个 JSON 文件，位置由 `storeDir` 决定；为空时默认 **`<home>/.dsh/nyaterm-bridge/`**（全局、与任何工作区和进程 cwd 无关；每个用户落在自己的 home 下，Windows 同理。注意配置里的 `~` 不会被展开）。**不要在共享配置里写死某个用户的路径**：

```
~/.dsh/nyaterm-bridge/allowlist.json
```

**每次工具调用都重新读**，所以改完直接重试即可，无需重启。写入走 tmp + rename 原子替换。

```json
{
  "workspaces": {
    "/Users/you/project": {
      "connections": ["2bf46e9f-…"],          // 可读写
      "observeConnections": ["c4bb63a6-…"],   // 只读
      "groups": [], "hosts": [],
      "observeGroups": [], "observeHosts": [],
      "observe": false
    },
    "C:/work/lab-*": { "observe": true }
  }
}
```

- `groups` / `hosts` / `connections`：授予**可读写**；平行的 `observeGroups` / `observeHosts` / `observeConnections`：授予**只读**。
- **可写** = 能 `nt_open` 开会话、能 `nt_exec` 执行命令；**只读** = 能开会话、能 `nt_output` 读输出，但**不能执行命令**（想完全禁止就连这条规则都别给）。
- `observe: true`：整个工作区只读，覆盖上面所有授予。
- 优先级：**连接 id > 主机名 > 分组**；同一层级里「只读」赢。所以"汉腾整组只读、只给管理服务器37开读写"写一条规则即可。
- 匹配规则：`*` = 单层路径，`**` = 任意深度；**多个模式命中时长者优先**。反斜杠与 `/` 等价（Windows 路径可直接写），Windows 盘符大小写不敏感（统一大写）。
- 未列出 → **拒绝**（除非插件配置 `defaultObserveOnly: true`，那时降级为只读：可开会话/读输出，不能执行）。

## 设置 MCP 程序位置

`nyaterm-mcp` 和 NyaTerm 一起安装，路径随**安装方式**和**用户**变化：

- Windows 普通用户装载在各用户的 `%LOCALAPPDATA%\Programs\NyaTerm\nyaterm-mcp.exe`，管理员安装才在 `Program Files`；
- macOS 可能是 `/Applications/NyaTerm.app/…`，也可能是 `~/Applications/…`；
- Linux 走 PATH，AppImage 的挂载点每次运行都不同。

所以插件**不写死路径**，按下面的顺序解析：

1. **已保存设置** —— `allowlist.json` 里的 `bridgeExecutable`（最高优先级，每个用户各自保存）；
2. 插件配置里的 `bridgeExecutable`（部署级默认值）；
3. **自动检测** —— 平台候选路径（macOS `/Applications` + `~/Applications`；Windows `%LOCALAPPDATA%\Programs` + `%PROGRAMFILES%`；Linux `/usr/bin`、`/usr/local/bin`）→ PATH。

图形界面：DSH 设置 → **NyaTerm 白名单** → **MCP 程序位置**。

- 直接填完整路径（支持贴带引号的路径、`~`、`%LOCALAPPDATA%` 这类变量）；
- 「自动检测」扫描本机已安装的 `nyaterm-mcp`，点一下就能选用；
- 「恢复自动」清空覆盖，回到自动检测。

**保存后立即生效**：下一次 `nt_*` 调用会按新路径重新拉起 bridge，不需要重启 DSH。保存时会校验文件确实存在、是普通文件、可执行（Windows 只查存在），并且文件名必须是 `nyaterm-mcp` / `nyaterm-mcp.exe` —— 设置页因此不会变成“随便启动任意程序”的入口。

底层就是 allowlist 存储文件里的一个键（留空或删除 = 自动）：

```json
{
  "bridgeExecutable": "C:\\Users\\me\\AppData\\Local\\Programs\\NyaTerm\\nyaterm-mcp.exe",
  "workspaces": { "...": {} }
}
```

`nt_status` 会显示最终选中的路径、来源（saved setting / plugin config / auto-detect）以及路径校验结果。

## 插件配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: nyaterm-bridge
      name: 'nyaterm-bridge'
      config:
        enabled: true
        enforceAllowlist: true
        defaultObserveOnly: false
        # 一般不用写：默认 <home>/.dsh/nyaterm-bridge（每个用户各自一份）。
        # 只有要挪位置时才填绝对路径；`~` 不会被展开。
        # storeDir: /home/you/.dsh/nyaterm-bridge
        # bridgeExecutable: 部署级默认路径；留空 = 自动检测（用户可在设置页覆盖）
        # discoveryFile: /home/you/.nyaterm/mcp/discovery.json
        # allowOtherTools: true
        # observeTools: []
        # workspaces: {}   # 内联 allowlist，优先级高于 allowlist.json
```

## 跨平台（macOS / Windows / Linux）

插件本身**不含原生模块**，宿主逻辑全部用 node 内置模块，客户端半是纯 DOM。平台差异集中在「找 bridge」和「路径匹配」两处，已做处理：

| 事项 | 做法 |
|---|---|
| bridge 定位 | 设置页的 `bridgeExecutable` → 插件配置的 `bridgeExecutable` → 平台候选表 → **PATH 查找**（`nyaterm-mcp[.exe]`）。候选表：macOS `/Applications` 与 `~/Applications` 两个 `.app`；Windows `%LOCALAPPDATA%\Programs\NyaTerm( Preview)\nyaterm-mcp.exe` 与 `%PROGRAMFILES%\…`；Linux `/usr/bin`、`/usr/local/bin`、`/opt/NyaTerm`、`~/.local/bin` |
| discovery 目录 | 用 `os.homedir()`（Windows GUI 进程通常没有 `HOME`），`~/.nyaterm` 与 `~/.nyaterm-preview`；bridge 路径里含 "Preview" 时优先 `~/.nyaterm-preview`，否则优先 `~/.nyaterm`（正式版） |
| PATH 上的 `.cmd/.bat` | Windows 上通过 `cmd.exe /d /s /c "…"` 启动；`.exe` 直连不经 shell（避免含空格路径被拆） |
| 工作区 glob | pattern 与 cwd 都归一化为 `/`、去掉尾部分隔符、Windows 盘符统一大写；`*` 不跨分隔符、`**` 跨任意层 |
| 大小写 | 匹配保持**大小写敏感**（文件系统不敏感时，大小写不符会变成拒绝而不是放行，是安全方向） |

**Windows / Linux 上不必提前知道安装路径**：默认按平台候选位置和 PATH 自动找；如果某个用户装在自定义目录（`D:\tools\NyaTerm\…`），让他打开 设置 → NyaTerm 白名单 → MCP 程序位置 填一次即可，该值只存在他自己的 `allowlist.json` 里。`nt_status` 会显示实际解析到的路径、来源与 discovery 位置。

```yaml
# 一般不用写：留空即自动检测；个别用户装在别处时，在 设置 → NyaTerm 白名单 → MCP 程序位置 里指定。
# macOS（示例）
# bridgeExecutable: /Applications/NyaTerm.app/Contents/MacOS/nyaterm-mcp
# Windows（每个用户不同，建议在设置页填）
# bridgeExecutable: C:\Users\<you>\AppData\Local\Programs\NyaTerm\nyaterm-mcp.exe
# Linux（AppImage 每次挂载点不同，留空走 PATH）
# bridgeExecutable: /usr/bin/nyaterm-mcp
```

## 已知限制

- **NyaTerm 的 MCP 不返回主机明细**（host/port/username 被刻意隐藏）。所以 allowlist 只能按分组路径、连接 id、连接名称来写。
- **NyaTerm 的 MCP 没有关闭会话的工具**，`nt_open` 开出来的标签页需要你手动关闭。
- **`nt_exec` 必须带 `sessionId`**（allowlist 生效时）。不带 sessionId 就无法判断目标连接，插件会拒绝——这是刻意的。
- **NyaTerm 的 MCP 命令是带外执行的**：命令不会出现在终端标签页里（其审计日志记为 `insertedToTerminal: false`），且**每次 `nt_exec` 都是新 shell**（cwd/变量不延续）。想看命令在终端里跑，只能用 NyaTerm 自带的 AI 命令卡片。
- **组规则只能由工具主体校验**，守卫只认显式 connectionId。也就是说 `nt_open` 的越权拦截以主体为准。
- NyaTerm 重启后端口和 token 会变，插件会重新读发现文档并重连（同一路径下自动完成）。
- `sftp_*` 工具**没有暴露**：文件操作继续交给 dsh-remote 的 `rw_*`，避免两套文件通道打架。
