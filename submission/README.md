# 上架到 dshmarket / awesome-dsh-plugin

这个目录不是插件运行所需的一部分，只是提交材料。`dshmarket` 的市场目录来自
`github.com/awesome-dsh-plugin/awesome-dsh-plugin`；它只允许安装该目录里的来源。

## 1. 先建公开仓库

把本仓库推到 `https://github.com/visualcjy/nyaterm-bridge`，然后：

- 给仓库加 topic **`dsh-plugin`**（CI 检查）；
- 确认 `package.json` 里有 `dsh.bundle.patch`（已有）；
- 仓库创建**满 1 天**后再提交（CI 自动检查，不够就等几小时）。

## 2. 提 PR

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，把条目文件复制过去：

```sh
cp submission/awesome-dsh-plugin/visualcjy__nyaterm-bridge.yml \
   <fork>/data/plugins/visualcjy__nyaterm-bridge.yml
```

只加这一个文件，不要手工改 README（它们由 `data/plugins/*.yml` 生成）。
提交 PR，等 CI + 维护者评审；合并后站点和 `dshmarket` 通常一天内收录。

## 3. 可选：发布预构建 tarball（安装更快）

不需要 npm 账号，`npm pack` 只在本地打包：

```sh
npm pack --cache /tmp/npm-cache
# 得到 nyaterm-bridge-0.1.0.tgz
```

把这个 `.tgz` 传到 GitHub Release（例如 tag `v0.1.0`），资产名建议用不带版本号的
`nyaterm-bridge.tgz`，然后取消条目里 `tarball:` 那行注释：

```yaml
tarball: https://github.com/visualcjy/nyaterm-bridge/releases/latest/download/nyaterm-bridge.tgz
```

## 本地验证

在普通 `dsh web` profile 上试装（桌面端请在插件页安装）：

```sh
dsh plugin --profile web add github:visualcjy/nyaterm-bridge
```

然后打开 NyaTerm 的 External MCP，重启 DSH，确认 `nt_status` 正常。

## 如果改了 owner / 仓库名

同步改三处：`package.json` 的 `repository`/`homepage`/`bugs`、`README.md` 的安装命令、
`submission/awesome-dsh-plugin/*.yml` 的 `url`/`name`/`icon`。
