# 配置与示例

## 当前实现

0.2.0 在 Electron userData 目录保存 projects.json，格式为 schemaVersion=1、projects 数组。macOS 默认位于 ~/Library/Application Support/TraceLogDock/projects.json；Windows默认位于`%APPDATA%\TraceLogDock\projects.json`。安装与升级见[安装指南](installation.md)。

配置通过 Zod 在持久化边界校验；同一主进程串行写入并原子替换文件。项目 revision 防止旧窗口覆盖较新内容，已有文件损坏时报告错误而不覆盖。

[示例 JSON](../examples/workspace.example.json)展示当前模型，但暂未实现配置导入/导出。初次使用从界面创建项目，无需手改文件。

## 配置组织

| 字段                  | 意义                                                |
| --------------------- | --------------------------------------------------- |
| schemaVersion         | 文件格式版本，当前为 1                              |
| projects              | 所有本地项目                                        |
| project.id / revision | 项目标识与并发更新版本                              |
| environments          | 项目环境及其服务器、服务                            |
| servers               | 服务器连接信息，kind 为 ssh 或 jumpserver           |
| services              | 服务及手动实例映射                                  |
| instances             | serverId 与容器名称映射，运行时核对真实 ID/启动时间 |

同项目可以混用两种连接。示例仅使用虚构域名和用户，不包含凭据。

## 凭据

0.3.3在用户勾选“记住密码”后，仅在SSH认证成功时把safeStorage加密的登录密码保存到独立passwords.json，文件权限为600。projects.json不包含密码或密文，主进程根据项目、环境、连接方式、host/port和username派生凭据引用；目标assetName不同可共用同一堡垒机账号密码，项目/环境/账号不同则隔离。修改端点/账号或删除服务器/项目时清理失效记录。

renderer只查询是否已记住，不取得明文；连接时使用savedPassword认证引用，解密和SSH认证都在主进程。存储不可用或无法解密时不降级明文保存。私钥通过原生选择返回临时引用，口令和OTP只用于当前认证，不持久化。

## 测试隔离

开发验证可设置 TRACELOGDOCK_USER_DATA 指向专门测试目录，不接触日常配置。基础桌面冒烟不连接服务器；远程桌面冒烟只连接本机临时 SSH 服务，使用生成的密钥和虚构数据，不访问生产。所有测试使用临时目录并清理。

主机信任文件 known-hosts.json 存于同一 userData 目录，仅保存主机/端口和指纹。项目配置格式保持 schemaVersion=1；0.1 配置可直接继续使用，未向服务器模型增加秘密字段。

最近打开的项目以配置根字段`lastOpenedProjectId`保存，不影响项目revision，也不包含登录凭据。旧配置没有该字段时显示首页；删除对应项目时清理标记，无有效项目记录时回到首页。记录只决定窗口恢复，不会自动发起SSH认证或重放远程任务。
