# MONAD RUG ARENA 验收记录

日期：2026-10-17（Asia/Shanghai）。当前流程为**预付费 → 最多三条玩家消息 → 后台结算 → 奖金直接转入付款钱包**。每场 10 测试 MON，80% 入公共奖池，成功领取结算时公共奖池的 50%。

## 当前合约

| 项目 | 已核验记录 |
| --- | --- |
| 网络 | Monad Testnet，Chain ID 10143 |
| 合约 | [`0x27D86752d07FFbdd2BBDE9d2cF91Ef2B69b04552`](https://testnet.monadscan.com/address/0x27D86752d07FFbdd2BBDE9d2cF91Ef2B69b04552) |
| 部署交易 | [`0xe121c859…c395c4b7`](https://testnet.monadscan.com/tx/0xe121c859e924d88c21863c9ba36f3053c333ddf7471432677e5ddf36c395c4b7) |
| 部署区块 | `71772830`；receipt success，运行时代码匹配编译产物 |
| 公开清单 | [monad-testnet.json](../deployments/monad-testnet.json)，`formatVersion: 2`、`gameFlow: prepaid-auto-payout` |
| 合约参数 | 入场 10 MON、入池 8000 bps、奖励 5000 bps、公共周期 7200 秒、个人挑战 180 秒、初始种子 0 |
| 后台结算 Gas | 裁判/relayer 地址已补充 1 测试 MON；与公共奖池分开 |

新流程重新部署了不可变合约。旧版地址 `0xc998eb98453f4c26Aba98D369E8C3895b8061085`、旧结算和 8 MON 奖池已[归档](../deployments/legacy-pay-on-settlement/monad-testnet-smoke.json)，没有迁移到当前合约，不能充作当前预付费或自动发奖证据。

**新版真实测试网完整流程已通过一场实测。** 2026-10-17 16:31（Asia/Shanghai），使用真实远程 Pi Agent：先付 10 MON，8 MON 入池，第 2 条玩家消息后提前成功，后台自动结算，合约直接转 4 MON 给原付款钱包；本次验收后奖池为 4 MON，当前余额以链上读取为准。

| 本场记录 | 真实链上证据 |
| --- | --- |
| 入场付款 | [`0x152657d1…dbe5f96`](https://testnet.monadscan.com/tx/0x152657d143d227d5985c35b03ad3658f16b6db8bd48b5cdda4a458604dbe5f96)，区块 `71773888`，支付 10 MON |
| 自动结算与发奖 | [`0xb41bd836…f65c64d`](https://testnet.monadscan.com/tx/0xb41bd8364c7716cba3b6fbe69fbb61b77a855001d76de250d88182e5af65c64d)，区块 `71774193` |
| 原付款人与收款人 | 同为 `0xb49a5CbB09A8875cd789DDDFfC32fbAE3442Fe48`，付款后钱包余额真实增加 4 MON |
| 结算 Gas | 后台 `0x5C821ed0eE711B1644Bf27b36B90b4514ef50F8a` 发起，附带金额为 0；玩家 nonce 在聊天和发奖阶段不变 |
| 判定与重试 | 2 条玩家消息、成功、100 分；重复 finish 不产生第二笔交易，没有 claim 交易 |
| 公开证据 | [monad-testnet-smoke.json](../deployments/monad-testnet-smoke.json)，`mode: live`、`runtime: pi-agent-core` |

该场实际观察到 `get_game_state`、`inspect_vault`、`get_player_stats`、`judge_challenge` 与私有流式文本。未付费不能聊天，结束后继续发消息被拒绝，公开事件不含私有 token；`ChallengeSettled`、`RewardPaid` 和付款钱包余额共同证明自动到账。

## 自动验证

| 检查 | 实测结果 |
| --- | --- |
| Solidity 编译 | solc 0.8.37 / Cancun 通过，当前公开 ABI 已生成 |
| 合约测试 | **55/55**，其中 RugArena 15 项、保留旧模块 40 项 |
| 后端测试 | **17/17**，包括付款前禁聊、真实核验接口、独立会话、失败恢复、自动结算与 100 块日志分页 |
| Pi Agent 测试 | **9/9**，实际 Runtime 工具执行、连续上下文、隔离、错误提示及结构化结果 |
| 类型检查 | 前端及 server + Pi 严格 TypeScript 检查通过 |
| 生产构建 | Next.js 16.4.2 构建通过，五个游戏路由生成成功 |
| 双钱包本地全流程 | 真实 Hardhat EVM、真实 HTTP 和两个 Socket，详见下方 |
| 真实测试网全流程 | 真实 live Pi 模型，先付 10 MON，第 2 条提前成功，后台 Gas 结算，4 MON 直达付款钱包，无独立领奖 |
| 付款及发奖 UI | 付款前不开放输入；钱包/合约隔离缓存；真实 `ChallengeEntered` 解锁；真实 `ChallengeSettled`、`RewardPaid` 才确认到账；无玩家结算或领奖写调用 |

本地 `test:e2e` 的实际检查：

1. 未付款调用聊天被拒绝；伪造或不匹配的付款 hash 无法解锁。
2. 两钱包各调用 `enterChallenge` 先付 **10 MON**，聊天前公共奖池为 **16 MON**。
3. 两玩家并行交错聊天，私有 token 与文本不进入公开事件，普通聊天不新增交易。
4. 一人第三条消息失败，后台自动结算；另一人第二条成功，提前结束并由后台结算。
5. 成功者钱包真实增加 **8 MON**，`RewardPaid` 收款人为本次付款钱包；玩家没有再次支付费用或结算 Gas，没有 claim 交易。
6. 重试 finish/结算不会重复收款、记分或发奖；成功后公共回合仍 active，其他人可继续挑战。
7. 两个 Socket 收到真实奖池、统计与确认事件；排行榜为 10/100 分。

证据 `.local/evidence/arena-e2e.json` 标明 `chainId: 31337`、`Owned local Hardhat EVM, not Monad Testnet`。这是真实本地交易，不是测试网交易。

## 远程模型与隐私

本机已配置并验证 APIPod `https://api.apipod.ai/v1` / `deepseek-flash`，通过真正的 `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai` 调用。此前独立 AI 验收中，Alice 两轮、Bob 一轮上下文隔离，全部五个游戏工具实际执行，生产默认流式配置和结构化输出通过。

此前 HTTPS 流式验收产生 26 个私有 `text_delta`，文本先于 HTTP 完成到达；公域观察者没有收到私有 Agent 流，公开事件不含 token。EIP-712 恢复地址与裁判地址 `0x5C821ed0eE711B1644Bf27b36B90b4514ef50F8a` 一致。这些独立模型测试没有提交链上交易；其后新版真实测试网挑战另行完成上述 10 MON 预付费与 4 MON 自动发奖，不能混用两组测试的交易数据。

Agent 只注册 `get_game_state`、`get_player_stats`、`get_recent_events`、`inspect_vault`、`judge_challenge`，不持有钱包私钥或任意写工具。后台持裁判/relayer 密钥，验证已付款挑战后签名并支付结算 Gas。可信判定仍是明确的原型信任边界。

## 钱包、公网与部署

此前浏览器回归包含五路由桌面/390px 手机、无钱包提示、自动进入 `/play` 和切换到 10143，7 组检查通过；测试提供者只模拟连接，不制造付款或确认。新版公网 `/play` 已通过 CUA DOM 核验：先付 10 MON、付款后计时、未付费时不显示聊天输入框，以及后台结算直达付款钱包、无独立领奖入口。旧页面截图不作为新版全流程凭证。

临时入口：[玩家](https://dresses-brad-saints-cap.trycloudflare.com/play) · [大屏](https://dresses-brad-saints-cap.trycloudflare.com/arena)。新版页面已更新并完成上述 DOM、截图和控制台错误核验（未发现控制台错误）；此前五页面 200、健康检查 ready / aiMode live、真实交易 API 与 WebSocket 快照也有独立记录。地址依赖本机与隧道持续运行；Render 固定站点 https://monad-rug-arena.onrender.com 已上线旧版，实读 `/api/health` 仍指向旧合约，预付费新版待另一会话更新云端代码和公开合约配置；Docker 配置已准备但未宣称实测容器。

网页读取连接玩家自己的地址和测试网余额。注入钱包无需 Reown 项目；普通移动浏览器的 WalletConnect 仍待配置 `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` 和真实域名白名单。公共变量由启动器转交构建，修改后须重新构建、重启网页。

私有会话现已写入 `.local/arena-sessions.json`，同文件可跨进程重启恢复并继续后台结算。单实例 Render 免费临时磁盘不能保证重建后保留会话，持续公开演示需要持久化目录；链上付款、奖池与战绩始终由链记录。所有观众应连接同一实例。

## 可复核证据与命令

- [当前公开部署清单](../deployments/monad-testnet.json)：新地址、部署交易、区块、参数与代码哈希，无私钥。
- [当前真实测试网挑战](../deployments/monad-testnet-smoke.json)：真实 live Pi、10 MON 预付费、2 条消息提前成功、4 MON 自动转账与幂等重试。
- [旧版清单与结算归档](../deployments/legacy-pay-on-settlement/monad-testnet-smoke.json)：仅保留历史，不计入当前奖池。
- `.local/evidence/arena-testnet-deployment.json`：实际 Monad Testnet 部署与代码读回。
- `.local/evidence/arena-relayer-funding.json`：裁判/relayer 真实测试网 Gas 预算补充。
- `.local/evidence/arena-e2e.json`：新版两钱包先付款、私聊、后台结算、8 MON 自动转账与重试证据。
- `.local/evidence/ai-live-check.safe.json`、`arena-live-production-http.json`：脱敏的独立远程 Pi 工具、隔离、流式与签名测试。
- `.local/evidence/arena-browser.json`、`arena-*-desktop.png`、`arena-*-mobile.png`：浏览器与视觉回归记录，需核对实际生成时间和对应版本。

```powershell
npm run contracts:compile
npm run test:contracts
npm run test:server
npm run test:agent
npm run test:e2e
npm run check
npm run check:server
npm run build
```

启动、Reown 配置、Render 单服务、Docker 持久化路径和一分钟演示流程见根 [README](../README.md)。服务端秘密只使用 `AI_API_KEY`、`ARENA_RESULT_SIGNER_PRIVATE_KEY` 等后台变量；私钥与模型 Key 不写入文档、前端或 Git。
