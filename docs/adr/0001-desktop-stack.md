# ADR 0001：本地桌面技术栈

## 状态

已采纳为实现方向；Electron/Vue/TypeScript 运行时与本地工作区源码已加入，ssh2/xterm.js 已加入，实际部署兼容仍待验证。

## 背景

需要本地 Mac APP、多窗口、SSH 交互和终端体验，后续支持 Windows。连接与任务希望运行在本机。

## 决定

使用 Electron、Vue 3、TypeScript，连接方向采用 ssh2，内嵌终端采用 xterm.js。Electron 主进程管理连接和秘密，渲染进程经 preload 调用明确业务 API。

## 代价与验证

Electron 增加运行时体积及内存需求；需验证日志高吞吐和多窗口表现。ssh2 是否适合具体 JumpServer MFA/PTY 必须先验证，不因技术选型忽略实际协议限制。Windows 的系统凭据和打包单独验收。
