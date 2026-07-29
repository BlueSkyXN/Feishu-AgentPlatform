# WorkspaceGuard

本项目的 Sandbox 只解决会话文件隔离和受控读写，不执行不可信代码。

## 模式

| 模式 | 能力 |
|---|---|
| `none` | 不创建 Workspace tools |
| `read-only` | list/read/search |
| `read-write` | list/read/search/write |

## 路径规则

- 只接受相对路径；
- Agent 配置的 `workspace.root/sessionRoot` 必须等于或位于 resolved `DATA_ROOT` 内；
- 拒绝绝对路径、`..` 和 NUL；
- 逐级检查真实路径；
- 不跟随指向根目录外的 symlink；
- 拒绝 symlink 写入目标；
- 单次读写字节数和搜索结果数有上限，Workspace 持久总量默认还受 `maxTotalBytes=268435456` 与 `maxFiles=10000` 限制；
- 写入使用私有临时文件和原子替换。

目录按 `appKey/agentId/storageId` 隔离。附件的 `maxItems/maxBytesPerItem/maxTotalBytes` 是每 Turn 下载边界，不等于 Workspace 持久总量。WorkspaceGuard 没有 `exec`、Shell、PTY、网络、包安装或后台进程能力。

`maxTotalBytes/maxFiles` 是 Host 在 `workspace.write` 和附件落盘前执行的应用层配额：同一 canonical Workspace 的写入在进程内串行，并在每次写入前重新统计 regular files。它不是 filesystem quota；若另一个 Host 进程或可信运行库绕过这两个入口直接写同一目录，只能在下一次受控写入时被发现，不能保证磁盘任意时刻都不越界。

升级后若已有 Workspace 已经超额，Session 仍可启动和读取；新的文件或扩容覆盖会被拒绝，只允许把现有 regular file 覆盖为不更大的内容，以便逐步恢复到配额内。配额失败不会预先创建请求路径中的新父目录。

## 明确边界

WorkspaceGuard 不是 OS Sandbox、容器或 VM。不要把它用于运行不可信 Python、JavaScript、原生程序或仓库构建。需要完整 Coding Agent 时，应在自建环境增加独立容器执行服务，而不是扩大当前 Workspace API。

Host 受控执行 `lark-cli@1.0.79` 不改变这一结论：Pi 只能选择预注册 operation 和结构化 flags，不能借此获得 Shell、任意 argv 或 Workspace 之外的文件访问。
