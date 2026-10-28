# 配置与示例

## 当前实现

0.1.0 在 Electron userData 目录保存 projects.json，格式为 schemaVersion=1、projects 数组。macOS 默认位于 ~/Library/Application Support/TraceLogDock/projects.json。

配置通过 Zod 在持久化边界校验；同一主进程串行写入并原子替换文件。项目 revision 防止旧窗口覆盖较新内容，已有文件损坏时报告错误而不覆盖。

[示例 JSON](../examples/workspace.example.json)展示当前模型，但暂未实现配置导入/导出。初次使用从界面创建项目，无需手改文件。

## 配置组织

| 字段                  | 意义                                         |
| --------------------- | -------------------------------------------- |
| schemaVersion         | 文件格式版本，当前为 1                       |
| projects              | 所有本地项目                                 |
| project.id / revision | 项目标识与并发更新版本                       |
| environments          | 项目环境及其服务器、服务                     |
| servers               | 服务器连接信息，kind 为 ssh 或 jumpserver    |
| services              | 服务及手动实例映射                           |
| instances             | serverId 与容器名称，尚未自动发现真实容器 ID |

同项目可以混用两种连接。示例仅使用虚构域名和用户，不包含凭据。

## 凭据

当前不接收或保存密码、私钥、OTP；额外未知字段不会写入已定义模型。后续凭据管理独立使用系统支持的加密机制，项目配置只存引用，safeStorage 不可用时不能降级明文。

## 测试隔离

开发验证可设置 TRACELOGDOCK_USER_DATA 指向专门测试目录，不接触日常配置。桌面冒烟自动使用临时目录并在结束后清理，不连接任何远程服务器。
