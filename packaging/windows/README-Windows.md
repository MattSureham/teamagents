# Agent Meetings Windows Portable

此版本适用于 Windows 10/11 x64。Node.js、应用依赖和 Playwright Chromium
均已包含在压缩包内，不需要安装 Node.js，也不需要运行 `npm install`。

## 首次使用

1. 将整个 ZIP 解压到可写目录，例如 `D:\Tools\Agent Meetings`。不要直接在 ZIP
   预览窗口内运行。
2. 双击 `browser-login.cmd`，在打开的浏览器窗口中登录需要使用的聊天网站，
   然后回到控制台按 Enter 保存并关闭浏览器。
3. 双击 `start-agent-meetings.cmd`。控制台会显示服务日志，服务就绪后默认浏览器
   会打开 <http://127.0.0.1:4200>。
4. 停止服务时，在控制台按 `Ctrl+C`。

默认配置启用 ChatGPT、Claude、Gemini 和 DeepSeek 的网页代理。网页代理及云端
LLM API 仍需要网络连接；“离线包”仅表示程序运行时无需另行下载安装组件。

## 配置与 API 密钥

- 主配置：`config\meetings.config.yml`
- API 密钥：`config\settings.env`
- 会议记录：`data\meetings\`
- 浏览器登录资料：`data\browser\`
- 完整配置示例：`config\meetings.config.example.yml`

如需 API 模型或外部 CLI 代理，请编辑主配置并在 `settings.env` 中填写对应密钥。
Codex、Claude Code、OpenCode、Git 和其他外部命令不包含在 portable 包中，启用
相应代理前仍需单独安装并加入 `PATH`。

## 命令行

在命令提示符或 PowerShell 中进入解压目录，然后使用：

```cmd
.\agent-meetings.cmd --help
.\agent-meetings.cmd config validate
.\agent-meetings.cmd run -t "讨论主题" --preset browser
.\agent-meetings.cmd list meetings
```

启动器会自动将配置、密钥、会议数据及浏览器资料指向当前解压目录，因此包含空格
的安装路径也受支持。

## 升级与迁移

升级前停止服务，并备份 `config` 和 `data` 目录。解压新版后，将这两个目录复制到
新版目录即可。目录中含有 API 密钥、会议内容和登录 Cookie，请勿公开分享。

浏览器 Cookie 在 Windows 上可能受 DPAPI 保护。将 portable 目录移动到另一台
电脑或另一 Windows 用户后，如登录失效，请重新运行 `browser-login.cmd`。
