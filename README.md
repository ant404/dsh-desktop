# DSH Desktop

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包为 Windows 桌面应用：一个
Electron 壳，启动本机 `dsh web` 服务，并在原生窗口中承载 Harness 网页界面。

- 自带运行时：把 `@deepseek-ai/dsh`（CLI + 全部依赖 + 构建好的前端）**和一份标准 `node.exe`** 原样打包进应用，
  服务进程完全不依赖系统 Node / npm / 网络。
- 复用现有数据：会话、设置、插件全部沿用 `%USERPROFILE%\.dsh`（DSH_HOME），与命令行/浏览器版本完全互通。
- 单实例 + 端口复用：默认端口 3080；如果已有后台 `dsh web` 在运行，直接挂接它，不会重复启动。
- 崩溃自愈：服务进程意外退出时弹出提示，可一键重启。
- 界面：应用图标为 DeepSeek 白色小鲸鱼（透明底，与网页端 favicon 一致，exe/窗口/任务栏同款）；无顶部菜单栏；
  版本信息与「检查更新」在网页界面的 **设置** 页（「DSH Desktop」卡片，由随应用注入的 `dsh-desktop` 插件提供）。

## 目录结构

```
dsh-desktop/
├── main.js                  # Electron 主进程（窗口、数据目录、overlay 注入、崩溃恢复）
├── server.cjs               # dsh web 服务管理（启动/健康检查/停止，纯 Node 可测）
├── resources/
│   ├── bundle/              # 打包进应用的运行时（由 prepare:runtime 生成）
│   │   ├── dsh-runtime/     #   @deepseek-ai/dsh 完整安装（含 node_modules 与前端、dsh-desktop 插件）
│   │   └── node-runtime/    #   node.exe + node-addon-require-builtin 的原生缓存
│   └── plugin-src/          # dsh-desktop 插件源码（host：版本/更新路由；client：设置卡片）
├── scripts/
│   ├── prepare-runtime.cjs  # 复制全局 dsh + node.exe + 原生缓存 + 插件到 resources/bundle
│   ├── render-icon.cjs      # 用项目自带的 Electron 离屏渲染 build/icon-src.html，生成保留透明通道的 build/icon.png
│   ├── rollback-runtime.ps1 # 「检查更新」装上新运行时失败时，把 data/runtime/dsh-runtime.previous 换回为活动运行时（需先完全关闭 DSH Desktop）
│   ├── test-server.cjs      # 离线冒烟测试（不起 Electron；DSH_TEST_HOME 可指向真实 ~/.dsh）
│   ├── test-plugin.cjs      # 插件注入链测试（overlay → 路由 → client bundle）
│   └── zip-dist.cjs         # 把 win-unpacked 打成 zip 分发包
├── build/icon.png           # 应用图标（DeepSeek 黑色小鲸鱼）
└── dist/                    # electron-builder 输出（文件夹版应用 + zip 压缩包）
```

> 为什么自带 `node.exe` 而不是用 Electron 内置的 Node：dsh 通过 `node-addon-require-builtin` 原生插件访问
> Node 内部模块加载器来解析 profile 里的第三方插件（dshmarket、modlens 等），该插件在 Electron 定制的 Node
> 下会崩溃，只有标准 Node 可用。服务以独立子进程运行，进程崩溃不会拖垮窗口。

## 准备工作（一次性）

```powershell
# 1. 确保本机已全局安装 dsh CLI（运行时源码来自它）
npm i -g @deepseek-ai/dsh

# 2. 安装构建依赖（electron / electron-builder）
npm install

# 3. 把全局 dsh、当前 node.exe、原生缓存复制进项目（可用 DSH_SOURCE 指定 dsh 来源）
npm run prepare:runtime
```

> 下载依赖与 Electron 二进制时，把 npm / electron / electron-builder 的缓存指到项目外的任意目录即可
> （本机沙箱下建议放在工作区内）：
> ```powershell
> $env:npm_config_cache='D:\...\.npm-cache'
> $env:electron_config_cache='D:\...\.electron-cache'
> $env:ELECTRON_BUILDER_CACHE='D:\...\.electron-builder-cache'
> ```

## 开发运行

```powershell
npm start                 # 等价 electron .：启动服务并弹出窗口
npm run test:server       # 离线冒烟：临时 DSH_HOME 启动服务 → 探测 / → 停止
$env:DSH_TEST_HOME="$env:USERPROFILE\.dsh"; node scripts/test-server.cjs   # 用真实 profile 验证
```

可加参数覆盖配置：`npm start -- --port 3199 --workspace D:\path\to\ws`

## 打包

```powershell
npm run build        # 生成文件夹版便携应用 + zip 压缩包（dist/ 下）
npm run build:dir    # 只生成文件夹版（dist/win-unpacked/）
```

产物：

- `dist/win-unpacked/` —— **文件夹版便携应用**：把整个文件夹复制到任意位置（U 盘、其他电脑），
  双击里面的 `DSH Desktop.exe` 即可运行，无需安装、无需解压等待。
- `dist/DSH Desktop-<version>-portable-win32-x64.zip` —— 上述文件夹的压缩包，便于拷贝/分发。

应用数据（`config.json`、日志、更新后的运行时、窗口状态）自动创建在 **exe 同级的 `data/` 目录**，
跟着文件夹走；Harness 数据（会话、设置、插件）仍在 `~/.dsh`，与 web 端共用。

## 数据目录

应用自己产生的数据**默认放在 exe 同级目录的 `data/` 文件夹**（文件夹版便携应用直接以 exe 所在目录为准；
该目录不可写时自动回退到 `%APPDATA%\dsh-desktop`）。设置卡片中显示的「应用数据目录」为**相对 exe 的路径**
（默认就是 `data`），回退到 %APPDATA% 时则显示绝对路径：

```
<exe 所在目录>/data/
├── config.json      # 应用配置（端口、工作区）
├── logs/            # main.log、dsh-server.log
├── runtime/         # 「检查更新」下载的新版 dsh 引擎（优先于内置运行时）
└── chromium/        # 窗口状态：缓存、localStorage、单实例锁
```

**Harness 自身的数据不受影响**，仍在 `~/.dsh`（DSH_HOME）：会话记录、模型配置与凭证、插件、附件等，
与浏览器版 web 端完全共用。

可用环境变量强制指定数据目录：`DSH_DESKTOP_DATA_DIR=D:\path\to\data`（旧名 `DSH_DESKTOP_USER_DATA` 仍有效）。

## 配置

首次运行时自动创建 `data/config.json`，可手动编辑：

```json
{
  "port": 3080,
  "workspace": "D:\\path\\to\\workspace"
}
```

- `port`：dsh web 监听端口（默认 3080；被占用且非 dsh 时自动换空闲端口）。
- `workspace`：会话工作目录（默认 `%USERPROFILE%\Documents\DSH-Workspace`）。
  想与 web 端看到同一份会话历史，就把它设成与 web 端相同的目录，例如
  `"workspace": "D:\\sysdir\\Documents\\deepseek-harness-workspace"`。

## 检查更新

版本信息与更新入口在 **网页界面的「设置」页**：展开「DSH Desktop」卡片即可看到应用版本、dsh 运行时版本、
内置 Node、数据目录，并点击按钮检查/安装更新：

- 与 npm 上 `@deepseek-ai/dsh` 的最新版本比较（只比较 dsh 引擎本身，不重下整个应用外壳）。
- 发现新版本时点「立即更新」：插件在服务端用 `npm install --prefix` 把新引擎及其依赖装到
  `data/runtime/dsh-runtime`，原子替换后提示**重启应用生效**（下次启动自动使用新运行时）。
- 更新后的运行时优先于内置运行时使用；应用外壳（Electron 窗口）保持不变。
- 更新需要网络与 npm（本机已具备）；离线时卡片会提示网络错误，不影响正常使用。

> 该卡片由随应用注入的 `dsh-desktop` 插件提供：应用启动时通过 `--patch` overlay（`data/dsh-desktop.patch.yml`）
> 挂载到 web profile，并临时把插件 junction 进 profile 的 node_modules（退出时移除）。
> 浏览器版 web 端没有这个 overlay 行，因此不受影响。

## 说明与限制

- 服务端作为独立子进程运行，使用随应用打包的 `node.exe`；不要求目标机安装 Node。
- 关闭窗口 = 关闭自己启动的服务；挂接外部已在运行的 `dsh web` 时不会去杀它。
- 安全：窗口始终只加载 `127.0.0.1` 本地服务；外部链接交给默认浏览器；渲染进程 `nodeIntegration:false` + `sandbox:true`。
- 目前仅面向 Windows x64（本机打包目标）；macOS/Linux 可按同样结构扩展 electron-builder 的 `mac` / `linux` 目标。
