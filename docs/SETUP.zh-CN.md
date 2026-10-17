# Claude2GrokBot 配置指南

## 推荐方式：让 Claude 配置

**前提**：Grok Bot（含桌面端）、Cloudflare 账号（免费，可在配置时注册）、Claude 桌面端或 Claude Code（macOS / Linux / WSL；Node.js 会自动装好）。

把这句话发给你的 Claude（Claude 桌面端 / Claude Code）：`运行 curl -fsSL https://raw.githubusercontent.com/Parsiffall1/Claude2GrokBot/main/install.sh | bash ，然后配置 Claude2GrokBot`。
Claude 会按 [`skills/claude2grokbot`](../skills/claude2grokbot/SKILL.md) 完成全部步骤，你只需要做下面三件事。

## 你要做的三件事

| # | 在哪里 | 做什么 | 为什么必须你来做 |
|---|---|---|---|
| 1 | Cloudflare | 在弹出的页面点 **Allow**（没有账号先免费注册） | 授权你的 Cloudflare 账号 |
| 2 | claude.ai | 在「Connect Claude to Claude2GrokBot」页面（需要的话先登录）粘贴 Claude 给你的口令，点 **Allow** | 登录授权只能由账号本人完成 |
| 3 | Grok Bot | 把 Claude 给的消息发给 Grok Bot；它做完后，在 Grok Bot 桌面端 **例程 → Claude2GrokBot wake** 复制 webhook 的网址和 key，发给 Claude | 这两个值只显示在 Grok Bot 桌面端，Grok Bot 和 Claude 都读不到 |

命令行版 Claude Code 没有浏览器，第 2 步会由 Claude 给你 3 行手动操作说明。

## Claude 会做的

- 没有 Node.js 20+ 时自动安装（不需要管理员权限）
- 打开 Cloudflare 登录页，生成密钥，部署服务，上传密钥
- 在 claude.ai 添加连接器
- 生成发给 Grok Bot 的消息：一行命令装好客户端和配置，再安装 skill、创建例程
- 写入 webhook 网址和 key，让 Grok Bot 打开浏览器并回传一张截图，确认整条链路

## 手动配置（不用 Claude 时）

```bash
curl -fsSL https://raw.githubusercontent.com/Parsiffall1/Claude2GrokBot/main/install.sh | bash
cd ~/.claude/skills/claude2grokbot
SKILL_LANG=zh-CN scripts/setup.sh deploy     # 会打开 Cloudflare 登录页
```

1. claude.ai → **Customize → Connectors → Add custom connector**：Name `Claude2GrokBot`，URL 用 `deploy` 输出的 `MCP_URL`，
   其余保持默认 → Add → Connect → 输入 `~/.config/claude2grokbot/secrets.env` 里的 `OWNER_PASSWORD` → Allow。
2. 把 `~/.config/claude2grokbot/grok-setup.txt` 的内容发给 Grok Bot。
3. 从 Grok Bot 桌面端复制例程的 webhook 网址和 key，然后运行（会自动做截图测试）：

```bash
scripts/setup.sh set-wake '<网址>' '<key>'
```

只用 Claude Code、不用 claude.ai 时，第 1 步换成下面这条，然后重启 Claude Code：

```bash
claude mcp add-json --scope user claude2grokbot '{"type":"http","url":"<MCP_URL>","headers":{"Authorization":"Bearer <MCP_TOKENS>"}}'
```

## 日常使用

在 claude.ai（电脑或手机）或 Claude Code 里直接说「让 Grok Bot 在云电脑上做 XX」。

- Claude 负责所有思考和决策；Grok Bot 只负责在云电脑上操作（看屏幕、鼠标、键盘），并把原始信息（文字、截图、文件）完整交回 Claude。
- Claude 和 Grok Bot 按任务需要来回多轮，没有次数限制。Claude 会自己等结果，不需要你催。每一步通常几十秒到几分钟，每一轮用掉一次 Grok Bot 例程运行。
- 服务端不做任何审核，任务按原样交给 Grok Bot。

## 出问题时

| 现象 | 原因 | 处理 |
|---|---|---|
| `Wake request: rejected (401)` / `(404)` | webhook 的 key / 网址不对 | 重新复制，`scripts/setup.sh set-wake` |
| `Wake request: rejected` + `rate limit` | Grok Bot 限流 | 自动按 1 / 5 / 15 / 60 分钟重试 |
| 多次唤醒失败后一直是 `submitted` | webhook 有问题 | 修好 webhook 后让 Claude 调用 `wake_executor` |
| 一直是 `dispatched` | 例程运行了但没领任务 | 让 Grok Bot 运行 `python3 ~/claude2grokbot/relay.py ping`，确认 skill 已安装 |
| 一直是 `working` | Grok Bot 卡住 | 30 分钟后自动重新排队；Grok Bot 可能会再执行一次 |
| 换了电脑，`deploy` 提示 "already exists but … has no keys" | 新电脑上没有密钥文件 | 从原来的电脑复制 `~/.config/claude2grokbot/secrets.env` |
| 其他 | | `scripts/setup.sh status`；实时日志 `npx wrangler tail <WORKER_NAME>` |

## 维护

| 操作 | 命令 |
|---|---|
| 更新 | 重新运行 install.sh，再 `scripts/setup.sh deploy` 和 `scripts/setup.sh update-grokbot`（Grok Bot 自己更新，无需手动） |
| 暂停唤醒 | `npx wrangler secret put WAKE_URL --name <WORKER_NAME>`，值填 `none` |
| 删除服务 | `npx wrangler delete --name <WORKER_NAME>`，再删除 claude.ai 连接器和 Grok Bot 例程 |

`WORKER_NAME` 和所有密钥都在 `~/.config/claude2grokbot/secrets.env`。
