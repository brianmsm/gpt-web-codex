# GPT Web Codex

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/m4j2rpf766-crypto/gpt-web-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/m4j2rpf766-crypto/gpt-web-codex/actions/workflows/ci.yml)

GPT Web Codex 是一个纯 MCP 启动器。普通 ChatGPT 网页对话负责规划，Luna 通过 `codex exec --json` 在本机执行并验证任务。

> **平台状态：** Windows 与 Ubuntu 26.04 x86_64 已完成真实人工测试，其中 Linux 已验证 AppImage、独立 MCP、终端/目录工具、Luna 执行、会话续接和 ChatGPT 网页端调用。macOS 目前只有自动化 CI 覆盖，尚未进行人工实机测试。

## 主要功能

- 在用户自己的普通浏览器中使用 ChatGPT；启动器不内嵌或自动控制 ChatGPT。
- 将每个稳定的 ChatGPT 网页对话绑定到一个持久化 Luna 会话。
- 通过 MCP 同时提供异步 `codexluna_*` 工具以及直接文件、终端工具。
- 同一网页会话中的 Luna 任务串行执行，不同网页会话可以独立运行。
- 支持 `read-only`、`workspace-write` 和 `danger-full-access` 三种权限模式。
- ChatGPT 停止回答后，长任务仍可继续执行；网页端可以查询状态或主动取消。
- Luna 生成并验证的图片可由 `codexluna_status` 作为原生 MCP 图片内容返回供检查；只有显式调用 `file_image_preview` 才会在网页对话中创建可见预览。
- 大图片会生成压缩预览副本，结构化工具结果不会在文本内容中重复传输。
- ChatGPT 页面刷新后可从本机私有缓存自动恢复图片预览，不会把 Base64 放入模型可见的结构化结果。
- 可将当前 ChatGPT 对话中上传的附件安全导入用户声明的本机工作区，再交给文件工具或 Luna 处理。

## 不会做什么

GPT Web Codex 不会编辑 `~/.codex/config.toml`、安装模型提供方、替换模型目录、代理 Responses API，也不会接管 Codex 路由。ChatGPT 网页负责规划，Luna 在本机负责执行。

## 运行流程

```text
普通 ChatGPT 网页对话
        │ MCP 工具调用
        ▼
OpenAI Tunnel → 本机独立 MCP 运行时
        │
        ├─ codexluna_init/start/status/cancel/session
        ├─ file_import_attachment / file_read / preview / list / search / write
        ├─ file_create_directory / file_delete_directory
        └─ terminal_exec / start / status / write_stdin / cancel
                 │
                 ▼
          codex exec --json（Luna）
```

## 图片预览与页面刷新

- ChatGPT 需要检查本机图片内容时使用 `file_read`，图片会作为原生 MCP 图片内容传输。
- 需要让图片同时显示在网页对话中时使用 `file_image_preview`，它会创建可见图片卡片。
- 图片卡片首次成功显示后，只会通过该卡片自己的 `window.openai.widgetState` 持久化不透明的预览 ID 和少量元数据；不再使用会话级 `localStorage`/`sessionStorage` 预览账本。图片数据仍保存在有数量和时间限制的本机私有缓存中。
- 页面刷新或重新打开同一对话时，组件会用该 ID 调用私有工具 `file_image_preview_restore`，不会重新读取任意源文件路径。
- 在刷新恢复格式加入之前创建的旧卡片无法追溯修复，需要重新调用一次 `file_image_preview` 创建可恢复的新卡片。
- 删除本机预览缓存后，即使卡片状态仍在也无法恢复；恢复还要求 ChatGPT 重新注入该卡片自身的 widget state。

## 导入 ChatGPT 附件

- 当用户把图片、PDF、代码、CSV 或其他文件上传到当前网页对话，并希望本地工具使用时，ChatGPT 可以调用 `file_import_attachment`。
- 工具只接受 ChatGPT 通过 `openai/fileParams` 提供的附件对象，不是任意 URL 下载器。
- 调用时必须填写目标 `workspace_path`、`permission_mode` 和目标相对路径；`read-only` 禁止导入，默认不覆盖已有文件。
- 下载默认限制为 20 MB，最大可调整至 100 MB；返回本机路径、字节数、MIME 检测和 SHA-256，不返回临时下载 URL，也不会自动执行附件。
- 导入后可用 `file_read`、`file_image_preview` 检查文件，或把返回路径交给 `codexluna_start`。
- `file_create_directory` 用于创建空目录，默认同时创建缺失的父目录。`file_delete_directory` 默认只能删除空目录；只有显式填写 `recursive: true` 才会递归删除，并且始终拒绝删除已声明的工作区根目录及符号链接/目录联接目标。
- `file_list` 会返回每一项的类型、文件大小（如适用），以及 ISO 8601 格式的 `modified_at` 修改时间。
- `terminal_exec` 用于执行普通 PowerShell/sh 命令，并等待返回受限长度的 stdout、stderr、状态和退出码。长任务或交互式任务使用 `terminal_start`、`terminal_status`、`terminal_write_stdin` 与 `terminal_cancel`，不会为了读取输出而重复执行命令。

## Linux 实机部署

Linux 的完整安装、已知问题和诊断流程见 [Linux 部署与排错](docs/linux.zh-CN.md)。几个容易忽略的要点：

- 从源码构建需要 Bun 1.3.14，并且 `bun` 必须位于 PATH；npm 11 可能默认阻止 Bun 的安装脚本。
- 直接运行 AppImage 可能需要 Ubuntu 的 `libfuse2t64`；项目安装脚本使用解包运行模式，不依赖 FUSE 挂载。
- 在启动器已经运行时通过 CLI 创建配置，需要重启启动器才能让它读取配置并接管 Tunnel。
- 非交互配置 Runtime Key 时使用 `--runtime-key-file /dev/stdin`，不要把密钥放在命令行参数中。
- OpenAI Platform 与 ChatGPT 的网页登录状态相互独立；最终应从 ChatGPT 网页实际调用一次工具，不能只依赖本机 `doctor`。

## 本地开发

当前支持 Windows 和 Linux x86_64，需要 Codex CLI、支持自定义连接器的 ChatGPT 账户，以及用于 MCP 的 OpenAI Tunnel。安装包已经内置 Bun；从源码构建需要 Bun 1.3.14。macOS 尚未实机验证。

```bash
git clone https://github.com/m4j2rpf766-crypto/gpt-web-codex.git
cd gpt-web-codex
bun install --frozen-lockfile
bun run launcher:dev
```

在启动器中：

1. 填写 Tunnel ID 和具有 Tunnels Read + Use 权限的 API Key。
2. 在 ChatGPT 中创建名为 `WebGPT Luna Standalone` 的连接器，连接方式选择隧道，身份验证选择无。
3. 验证运行时，然后在 Chrome、Edge、Firefox 等普通浏览器的 ChatGPT 对话中启用该连接器。

连接器名称保持稳定，因为 ChatGPT 会缓存工具契约。迁移期间可能继续使用旧的本机数据目录名称，以保留现有隧道凭据和 Luna 会话绑定。

## 验证

```bash
bun x tsc --noEmit
bun test tests
bun run launcher:typecheck
bun run launcher:test
```

## 安全边界

启动器将隧道凭据保存在本机私有目录，并在日志中进行脱敏。它不会保存 ChatGPT Cookie、浏览器配置或网页对话历史。附件导入仅允许经过校验的 ChatGPT/OpenAI 文件来源，实际网络连接固定到已校验的公网地址，每次重定向都会重新验证；临时文件在目标目录创建并在失败后清理。为了在页面刷新后恢复图片卡片，压缩后的预览副本会存放在独立运行时的本机私有目录中，最长保留 90 天且最多保留 128 张；缓存不会记录源文件路径。`codexluna_init` 会在本地执行前返回实际工作区、权限模式、持久化会话 ID 和会话记忆边界。

会话边界属于提示词级约束，无法修改 ChatGPT 账户自身的“记忆”产品设置。本项目是独立、非官方的本地 MCP 连接器；不要公开暴露不受你控制的隧道或工作区。

## 许可证

MIT。参见 [LICENSE](LICENSE) 和 [LICENSES](LICENSES)。

## 致谢

GPT Web Codex 基于原项目 [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) 演进而来。衷心感谢 miuuyy 以及原项目的所有贡献者，是他们的工作让本项目成为可能。
