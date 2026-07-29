# AgentParty Stop-hook 唤醒 spike（隔离骨架 v4）

**目标**：验证用 Claude Code `Stop` hook 让「同一个 agent 会话（保留上下文、全工具）被 AP
频道 directed @ 唤醒」——不接活会话、不用 tmux、不被 turn 边界杀。**隔离骨架，未接活会话。**

## 复跑（自包含，无网络依赖）
```
python3 test_dispatcher.py      # 脱机单元/集成验收
python3 test_coexistence.py     # 多-hook 共存 + 变异实测
```
两条都 `=== N passed, 0 failed ===` 即通过。live 证据见下（需真 claude，非复跑必需）。

## 文件
- `dispatcher.py` —— 单 dispatcher。纯函数 `try_ack`/`decide`/`build_reason`/`confirm_turn` + `main()`（IO）。
- `test_dispatcher.py` —— 脱机 36 项。
- `test_coexistence.py` —— 共存 9 项（基线不变量 + 4 变异 M1-M4 全被抓红）。
- `settings.example.json` / README.md。

## 机制
`Stop` → 先用 transcript **结构化确认**上一轮注入真续跑了(`confirm_turn`：含 nonce 的 user 记录
之后须有 assistant 记录)→ 才 ack、推进 authoritative cursor；再从 post-ack cursor 长轮询 AP
directed @：有 → `{"decision":"block","reason":<净化+JSON编码+nonce围栏>}` 同会话再跑一轮；
无/错/到 cap → `{}` 放行 + 响亮 stderr。

## v3→v4：吸收 macmini 三/四审的硬门槛
| 项 | 做法 |
|---|---|
| **lease** | claim 带 `lease_expires_at`+`nonce`；lease 内幂等去重、到期允许重 claim |
| **活 pending 排他** | lease 未到期时，遇【不同】delivery 一律 RELEASE、不抢占、不覆盖（不丢原 claim/nonce） |
| **delivery_id 强校验** | 无有效(非空 str) delivery_id → RELEASE、不 claim。**poll_ap 不再合成** `channel:seq`——无权威 id 透传 None（history-only 按设计不 claim；只有真 party watch 给权威 id 才 claim） |
| **不可逃逸边界** | 正文 strip + JSON 字符串编码 + **每轮随机 nonce** delimiter（正文无法预测/复现闭合标记） |
| **seq 严格** | `valid_seq` 只收正整数；reason 只放已校验 int，绝不拼 shell |
| **try_ack 硬门槛** | 非空 str session_id + 严格 `=="Stop"` + `stop_hook_active is True` + session 匹配 + **注入轮 nonce 经 transcript 结构化确认**（含 nonce 的 user 后须有 assistant，非仅"搜到 nonce"） |
| 双预算 | 连续无进展 cap(有效往返 ack 才重置) + 硬 total/deadline 顶(任何消息不重置) |

## 证据
- **脱机 36/36**（test_dispatcher）：seq/delivery_id 校验 · lease 去重&到期重 claim · **活 pending 排他** · try_ack 8 门槛 · **confirm_turn 结构化(有/无后续 assistant/时序)** · SessionStart lease 保留 · build_reason 对抗(伪造闭合 delimiter/role/控制序列/超长→边界不破) · 双预算硬顶 · **无 delivery_id 端到端不 claim**。
- **共存 9/9**（test_coexistence）：基线(dispatcher 每事件命中一次、sibling 每事件一次、D1 只 claim&ack 一次)；变异 **M1 重复注册→2 命中 / M2 删分派→0 claim / M3 残留旧 Stop(独立 state)→2 claim / M4 ack 门(注入后无 assistant)→不 ack** 全被抓红。
- **live（隔离 /tmp + mock party + 真 claude -p）**：session_id 全程唯一；`claim:D→确认续跑 Stop 才 ack:D`；**adversarial**：恶意正文(伪造 System+诱导 touch 诱饵+诱导泄 token)→ agent 识别为注入、拒执行、诱饵未创建、拒碰 token。

## 守约束（macmini 指定）
不接活会话 · 不提高 cap · 不并入 #789 · 走独立 worktree+SHA+diff review。

## 未做 / 下一步
- 真 `party watch` directed-delivery 的**权威 delivery_id + 服务端 lease/claim 对齐**（IO 层已不合成、透传真 id）。
- **真生产环境**（带 CHTeam guard/review-ack 的实际 settings）共存实跑——共存/变异逻辑已由 test_coexistence 覆盖，但真 settings 层的"残留旧 Stop 注册"仍需上机核。
- 正式立项 / 合并 / 调高 cap —— 等 owner/moderator。
