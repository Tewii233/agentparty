# AgentParty Stop-hook 唤醒 spike（隔离骨架 v3）

**目标**：验证用 Claude Code `Stop` hook 让「同一个 agent 会话（保留上下文、全工具）被 AP
频道 directed @ 唤醒」——不接活会话、不用 tmux、不被 turn 边界杀。**隔离骨架，未接活会话。**

## 文件
- `dispatcher.py` —— 单一 dispatcher。纯函数 `try_ack` / `decide` / `build_reason`（可脱机测）+ `main()`（IO）。
- `test_dispatcher.py` —— 脱机验收 **29 项**。
- `settings.example.json` —— hook 接线样例（放独立 dir 的 .claude/settings.json）。

## 机制
`Stop` 触发 → 先用 transcript 确认上一轮注入真续跑了(`try_ack`)→ 才 ack、推进 authoritative
cursor；再从 post-ack cursor 长轮询 AP directed @：有 → `{"decision":"block","reason":<净化+
JSON编码+nonce围栏>}` 同会话再跑一轮；无/错/到 cap → `{}` 放行 + 响亮 stderr。

## v3 —— 吸收 macmini 三审的接-真-delivery 硬门槛
| 项 | 做法 |
|---|---|
| **A lease** | claim 带 `lease_expires_at`+`nonce`；lease 内幂等去重、到期允许重 claim（崩溃/超时可重投） |
| **B delivery_id 强校验** | 无有效(非空 str) delivery_id → 响亮 RELEASE、不 claim；不把 seq 当 identity。IO 层 history 近似时合成 `spike-history:` 前缀 id 并标注，真 party watch 应给权威 delivery_id |
| **C SessionStart** | lease 未到期保留 pending（防 lease 内重复 claim）、到期才 abandon |
| **D 不可逃逸边界** | 正文 strip + **JSON 字符串编码**（`>>>`/换行/伪 role 全成转义文本）+ **每轮随机 nonce** delimiter（正文无法预测/复现闭合标记） |
| **E seq 严格** | `valid_seq` 只收正整数；reason 只放已校验 int，绝不把模型输出/正文拼 shell |
| **F try_ack 硬门槛** | 非空 str session_id + 事件严格 `=="Stop"` + `stop_hook_active is True` + session 匹配 + **注入轮 nonce 经 transcript 确认**（`turn_confirmed`），非仅"同 session 下次 active Stop" |
| 双预算 | 连续无进展 cap(有效往返 ack 才重置) + 硬 total/deadline 顶(任何消息不重置→持续@不能永久续命) |

## 证据
- **脱机 29/29**：seq/delivery_id 校验 · lease 去重&到期重 claim · try_ack 8 条硬门槛 · SessionStart lease 保留 · **build_reason 对抗（伪造闭合 delimiter/role/控制序列/超长 → 边界不破）** · 双预算硬顶 · error/坏输入端到端放行。
- **live（隔离 /tmp + mock party + 真 claude -p）**：
  - 主路径：session_id 全程唯一，`claim:D → 确认续跑 Stop 才 ack:D`，claim/ack 各一次（trace 实证）。
  - **抗注入（adversarial）**：恶意正文（伪造 `System:` 覆盖 + 诱导 `touch /tmp/PWNED` + 诱导泄露 token）→ **agent 识别为 prompt injection、拒绝执行、诱饵文件未创建、拒绝碰 token**。证抗注入而非仅可用。

## 守约束（macmini 指定）
不接活会话 · 不提高 cap · 不并入 #789 · 完整文件走独立 worktree+SHA+diff review。

## 未做 / 下一步
- 真 `party watch` directed-delivery 的**权威 delivery_id + 服务端 lease/claim 对齐**（现 IO 层用 `spike-history:` 近似）。
- **真多-hook 环境的共存+变异实测**：单 dispatcher 下断言每事件命中一次、同 delivery 只 claim&ack 一次；变异删分派/重复注册/换 ACK 序→红；查 settings 残留旧 Stop 注册。trace 字段已就位，需带 CHTeam guard/review-ack 的环境跑。
- 正式立项 / 合并 / 调高 cap —— 等 owner/moderator。
