# MONAD RUG ARENA 验收记录

日期：2026-10-17（Asia/Shanghai）。挑战费用 **10 测试 MON**，链上参数已读取核验；80% 加入公共奖池，获胜奖励为当前奖池的 50%。

| 检查 | 实测结果 |
| --- | --- |
| Solidity 编译 | solc 0.8.37 / Cancun 通过，公开 RugArena ABI 已生成 |
| 合约测试 | 54 / 54，通过；其中 RugArena 14 项，保留的旧模块 40 项 |
| 后端与 Pi Agent | 20 / 20，通过；实际订阅工具执行事件并观察到全部五个工具，另含两项 100 块分页回归 |
| 类型检查 | 前端及 server + Pi 模块严格 TypeScript 检查通过 |
| 生产构建 | Next.js 16.4.2 构建通过，5 个游戏路由均已生成 |
| 生产运行 | `npm run start:cloud` 单启动器运行 standalone 前端 3150、Fastify 后端 4000 与同域网关 4100；公网支持真实 WebSocket |
| 桌面与手机浏览器 | Edge 隔离实例，五路由 1600px / 390px 无横向溢出，无页面运行时错误 |
| 钱包 UI | 连接测试提供者后自动进入 /play，错误网络提示切换至 10143，无逐条聊天交易 |
| 无钱包体验 | 可恢复提示，按钮可重试 |
| 真正的链上核心链路 | 独享本地 Hardhat 节点：两钱包交错对话、10 MON 结算、10/100 积分、8 MON 奖金实转、新回合 |
| 多人同步 | 真实 HTTP + 两个 Socket 同步奖池、排行榜与真实确认事件 |
| Pi 与隐私 | 每挑战独立 Agent；token 错误不能订阅；A 的流式文本不进入 B 的房间或公共大屏 |
| 工具与输出错误 | 工具错误仍有合理回复；模型故障可重试；JSON 最多修复一次；失败恢复原上下文 |
| 后端授权与重放 | EIP-712 真实验签；重复结算拒绝；客户端伪造 hash 不能产生链上确认 |
| Monad RPC | 官方配置核对，实际 eth_chainId 返回 0x279f；从真实部署区块补扫成功，每批最多 100 块 |
| 测试网部署 | 已部署 RugArena，区块 71762027，部署回执 success；实际运行时代码与编译产物完全一致 |
| 测试网游戏结算 | 真实 10 MON 失败挑战结算成功，区块 71764191，pool 8 MON / 合约余额 10 MON / 玩家 10 分；Pi 本地规则模式，尚无真实领奖 |
| 真实远程模型 | APIPod `https://api.apipod.ai/v1` / `deepseek-flash` 已配置并实际调用 Pi SDK；Alice 两轮 / Bob 一轮上下文隔离，五个游戏工具均实际执行，结构化结果与生产默认流式配置通过 |
| 公网真实 AI 与签名 | HTTPS 两轮聊天产生 26 个私有 `text_delta`，文本先于 HTTP 完成到达；公域观察者未收到私有流；`finish` EIP-712 恢复地址匹配链上 signer，固定积分和挑战/玩家/回合/域绑定检查通过 |
| 临时公网 | 五个路由返回 200、健康检查 ready / aiMode live、真实部署交易 API、WebSocket-only 快照验证通过；依赖本机与隧道持续运行 |
| 固定托管与 Docker | Render 单服务 Blueprint、APIPod 公开模型配置与同域网关已准备，账户验证尚未完成，未完成固定云托管；未宣称实测容器 |

浏览器验证脚本包含 7 组检查。测试提供者只模拟连接和网络切换，不制造交易或链上确认。链上交易与余额另由真实本地 EVM 实测，明确不当作 Monad Testnet 交易。

可重复证据：

- [公开部署清单](../deployments/monad-testnet.json)：合约地址、部署交易、区块、参数与 runtimeCodeHash，无私钥。
- [真实测试网结算](../deployments/monad-testnet-smoke.json)：10 MON 结算、真实事件、奖池、积分、双 Socket 确认与重复拒绝。
- `.local/evidence/arena-testnet-deployment.json`：真实 Monad Testnet 回执、运行时代码匹配与合约参数读回。
- `.local/evidence/arena-testnet-settlement.json`：实际结算回执与后端验签、链上统计和实时确认检查。
- `.local/evidence/arena-public-deployment.json`：临时 HTTPS 五页面、真实交易详情及 WebSocket 检查。
- `.local/evidence/ai-live-check.safe.json`：脱敏的 APIPod 真实调用、Pi 五工具、Alice 两轮 / Bob 一轮隔离、结构化结果与生产默认流式验收；不包含 API Key 或私聊文本。
- `.local/evidence/arena-live-production-http.json`：公网生产 HTTP 与私有 Socket.IO 文本流、两轮上下文、26 个文本增量及 EIP-712 签名验证；公域没有泄露私有流或 token。
- `.local/evidence/arena-e2e.json`：合约、两钱包、实际回执与奖励余额。
- `.local/evidence/arena-browser.json`：浏览器检查和运行时错误列表。
- `.local/evidence/arena-*-desktop.png` / `arena-*-mobile.png`：五页面真实截图。
- `artifacts/ui/`：补充视觉验收截图。

测试网合约为 [`0xc998eb98453f4c26Aba98D369E8C3895b8061085`](https://testnet.monadscan.com/address/0xc998eb98453f4c26Aba98D369E8C3895b8061085)，部署交易为 [`0xf1f09c73ec05a8b5d64df2256cdb4c9cd3698503c2543fa75df26dd8d610d69c`](https://testnet.monadscan.com/tx/0xf1f09c73ec05a8b5d64df2256cdb4c9cd3698503c2543fa75df26dd8d610d69c)。Gas 使用 1,757,703，实际费用 0.179285706 测试 MON。该交易只证明合约已部署，不代表玩家已经完成收费挑战。

2026-10-17 15:33（Asia/Shanghai）读回公共回合 1 仍为 active，预计 17:30:16 到期；这是一份检查时快照，当前状态应从链上读取。到期或产生赢家后，玩家可通过游戏页面开启新公共回合。

2026-10-17 15:47–15:51（Asia/Shanghai）完成 APIPod 真实模型与公网生产 Agent 验收。公网回复通过真正的 Pi Agent Runtime 工具执行和私有事件流返回，后端签名恢复地址为 `0x5C821ed0eE711B1644Bf27b36B90b4514ef50F8a`，与合约 `resultSigner` 一致。此次验收提交链上交易数为 0，没有支付或领奖；前后奖池均为 8 MON，累计已结算挑战均为 1。前述区块 71764191 的收费结算仍是 Pi 本地规则模式的独立证据，不能将其改写为远程模型结果结算。

执行命令与 `render.yaml` 单服务部署、`npm run start:cloud` 同域网关及临时 HTTPS 隧道说明参见根 README。Render 服务端秘密变量为 `AI_API_KEY` 与 `ARENA_RESULT_SIGNER_PRIVATE_KEY`，公开模型配置为 `AI_BASE_URL=https://api.apipod.ai/v1`、`AI_MODEL=deepseek-flash`。模型 Key 与托管变量仅注入服务端，私钥不进入文档、浏览器构建或 Git 仓库。固定 Render 服务尚未部署完成，已验收公网入口仍为依赖本机运行的临时 HTTPS 隧道。
