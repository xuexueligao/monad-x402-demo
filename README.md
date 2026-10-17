# MONAD RUG ARENA

**Can You Rug the Raccoon?** · **你能骗走小恐龙的金币吗？**

[GitHub 源码](https://github.com/xuexueligao/monad-x402-demo) · [CI 模板](docs/github-actions-ci.yml)

多人实时 AI 攻防 dApp。全场共用一只小黄龙、一个公共回合、一份真实测试 MON 奖池和排行榜。用三句话说服小黄龙，后端签署判定，玩家钱包在 Monad Testnet 完成结算。IP 直接复用项目已有的黄色、绿眼、浅肚皮、抱金币钱袋的透明素材。

## 交付与上线状态

Next.js 入口、聊天、大屏、排行榜、真实交易详情；Fastify + Socket.IO 会话与实时广播；实际 Pi Agent Runtime 工具调用；单一 `RugArena.sol` 验签、结算、奖池、统计与领奖；测试、部署脚本与 Docker 配置均在实际工程内。

**RugArena 已部署到 Monad Testnet，临时 HTTPS 公网入口已验证，真实模型等待本机 Key。** 公开部署清单见 [monad-testnet.json](deployments/monad-testnet.json)。旧 x402 付款和本地链测试均不能代替本游戏的测试网结算证据。

临时演示：[玩家入口](https://dresses-brad-saints-cap.trycloudflare.com/play) · [现场大屏](https://dresses-brad-saints-cap.trycloudflare.com/arena)。2026-10-17 已验证五个页面返回 200、健康检查 `ready`、真实部署交易详情及 WebSocket 快照。该地址依赖本机服务和隧道进程持续运行；固定 Render 托管尚待账户登录，不能将临时地址当作已完成云托管。

| 部署信息 | 实际链上记录 |
| --- | --- |
| 合约 | [`0xc998eb98453f4c26Aba98D369E8C3895b8061085`](https://testnet.monadscan.com/address/0xc998eb98453f4c26Aba98D369E8C3895b8061085) |
| 部署交易 | [`0xf1f09c73…d610d69c`](https://testnet.monadscan.com/tx/0xf1f09c73ec05a8b5d64df2256cdb4c9cd3698503c2543fa75df26dd8d610d69c) |
| 部署区块 | `71762027`；回执成功，运行时代码与编译产物一致 |
| 真实挑战结算 | [`0xeb48d858…930ce7b`](https://testnet.monadscan.com/tx/0xeb48d85850521dc9e9a945e71e25605a7737f8d77b038a62f066d8e4e930ce7b)，区块 `71764191`；10 MON 失败挑战，10 积分 |
| 实际参数 | 每次结算 **10 测试 MON**；80% 入池；胜利领取当前奖池 50%；回合 7200 秒 |
| 奖池快照 | 实测结算后 8 测试 MON，合约实际余额 10 MON；当前值从链上读取 |

真实结算验收使用 **Pi 本地规则模式**，实际执行五个游戏工具、后端验签和支付；两个实时客户端均收到链上确认，重复挑战被 `ChallengeAlreadySettled` 拒绝。它不代表已验证远程 AI。见 [测试网结算证据](deployments/monad-testnet-smoke.json)。

实测结果：合约 **54/54**、后端与 Pi **20/20**、双钱包真实本地链端到端通过、生产构建通过、浏览器 **7 组**检查通过。后端包含 Monad 公共 RPC 每批最多 100 块的日志扫描回归测试。详细记录见 [验收记录](docs/arena-verification.md)。

旧 x402 和旧金库模块保留，不参与当前游戏路径，没有防火墙双模式入口；旧说明见 [legacy-x402-readme.md](docs/legacy-x402-readme.md)。

## 玩法与经济规则

| 参数 | 默认值 |
| --- | --- |
| 每轮挑战费用 | **10 测试 MON**，结算时支付，另付 Gas |
| 消息与时限 | 最多 3 条玩家消息，180 秒 |
| 公共回合 | 2 小时，或首位成功者结算后结束 |
| 费用分配 | 80% 加入公共奖池；20% 保留在合约 |
| 获胜奖金 | 包含本次费用贡献后的公共奖池的 50% |
| 游戏积分 | 已结算失败 10 分，已结算成功 100 分 |

公开胜利条件：小黄龙在当前真实游戏中主动承诺交出钱袋，实际回复包含 **“金库开门，金币归你”**，结构化结果为成功，且独立裁判确认不是引用、复述、翻译、假设或角色扮演。玩家说“我赢了”不构成胜利。模型不能决定奖金或积分。

连接钱包后直接开始，不注册账号。开始和聊天不弹钱包，结束产生 EIP-712 凭证，结算时明确支付 10 测试 MON。**AI 同意只是待结算判定，合约接受真实交易后才是胜利。** 两个玩家同时说服小龙时，先结算者结束公共回合；旧回合交易回滚，不收挑战费，失败交易仍有 Gas。

未结算对话不扣费、不计分、不冒充链上挑战。后端限制每钱包一个活动/未结算会话，凭证过期可重开。任何玩家可在回合结束后发起下一回合；旧赢家的奖励单独预留，跨回合仍可领取。

## 架构

```text
Next.js + wagmi + viem ── 玩家钱包交易 ──► RugArena / Monad Testnet
        │                                         │
        └── HTTP + Socket.IO ──► Fastify ◄── 真实链上日志
                                  │
                                  ├── 隔离会话 / EIP-712 结果签名
                                  └── Pi Agent Runtime → 模型提供方
```

`shared/config.ts` 集中定义游戏规则；`shared/network.json` 集中定义网络。经济参数部署后以合约为准，前端读取实际费用和奖池。后端只有结果签名密钥，没有发送链上交易的客户端；玩家自己支付与领奖。聊天不写入合约，广播只有动作摘要，无完整私聊与 token。

## Monad Testnet 配置

2026-10-17 核对 [Monad 官方测试网文档](https://docs.monad.xyz/developer-essentials/testnet)，并实际 RPC 查询得到 `eth_chainId = 0x279f`。

| 项目 | 值 |
| --- | --- |
| Chain ID | `10143` / `0x279f` |
| 网络 / 代币 | Monad Testnet / MON（18 位） |
| RPC | `https://testnet-rpc.monad.xyz` |
| 区块浏览器 | [Monadscan Testnet](https://testnet.monadscan.com) |

前端只提供此网络，连接其他网络时显示切换按钮。没有主网、发币、充值兑换或水龙头。测试币由玩家自行准备。`31337` 仅用于隔离的本地自动测试，后端只允许对应 loopback RPC。

## 本地启动

Node.js **22.13+**、npm；Windows 可使用 PowerShell。所有启动器使用项目内 `.local/tmp`，规避本机系统 TEMP 指向失效盘符的问题。

```powershell
cd F:\出海项目\monad-x402-demo
npm ci
npm --prefix contracts ci
npm run setup:arena
npm run dev:arena
```

入口 [http://localhost:3150](http://localhost:3150)，玩家 `/play`，大屏 `/arena`，排行榜 `/leaderboard`，交易详情 `/tx/实际哈希`。后端 `http://localhost:4000`，健康接口 `/api/health`。

`setup:arena` 仅在不存在时生成 `.env.arena.local`，生成独立的后端判定密钥，不覆盖旧 `.env.local`，不创建玩家钱包，不打印私钥。请在本机配置文件中填写密钥，不要贴进聊天。

无合约地址时可浏览全部页面，诚实显示“等待合约部署”，不会虚构奖池、排名或交易。`AI_API_KEY` 为空时明确显示“本地规则”；设置后使用真实模型，两者从不混淆。

启动器打印局域网地址并用它生成扫码地址。同一可互访 Wi-Fi 下，允许 Node.js 局域网入站后即可用手机访问。钱包内置浏览器直接使用注入钱包；普通移动浏览器需要 WalletConnect 时设置 `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`。公网使用 HTTPS。

## 编译、测试与构建

已提供 [GitHub Actions 验证模板](docs/github-actions-ci.yml)。要启用自动验证，将它复制到 `.github/workflows/ci.yml` 后提交；GitHub 要求上传工作流的凭据具备 `workflow` 权限。当前发布保留模板，不依赖新增账户权限。

```powershell
npm run contracts:compile
npm run test:contracts
npm run test:server
npm run test:agent
npm run test:e2e
npm run check
npm run build
```

合约测试覆盖正常结算、无效/跨域签名、重复 ID、错误费用、奖励资格、不超额发奖、旧回合关闭、多玩家独立统计、跨回合预留奖金。后端测试覆盖会话隔离、AI 失败重试、并发消息预算、固定积分与真实验签。

`test:e2e` 自动启动独享 Hardhat 节点、部署合约、启动真实 HTTP/双 Socket、两个钱包完成失败与成功结算、实际领奖与新回合；核对奖池、余额和排行榜并拦截伪造 hash。证据 `.local/evidence/arena-e2e.json` 明确为本地链，不能当作测试网交易。

`npm run verify:arena-browser` 使用本机 Edge 隔离无头实例检查页面、手机溢出、无钱包恢复、钱包连接/网络切换和页面错误。截图位于 `.local/evidence/`。

## 部署游戏合约

编辑 `.env.arena.local`：

```dotenv
ARENA_DEPLOYER_PRIVATE_KEY=0x独立测试网部署钱包密钥
ARENA_RESULT_SIGNER_PRIVATE_KEY=0xsetup生成的判定密钥
ARENA_RPC_URL=https://testnet-rpc.monad.xyz
ARENA_CHALLENGE_FEE_MON=10
ARENA_POOL_SHARE_BPS=8000
ARENA_REWARD_BPS=5000
ARENA_ROUND_DURATION_SECONDS=7200
ARENA_SEED_MON=0
```

部署者需有测试 MON 支付 Gas，后端签名钱包不需要 MON。可选种子奖池默认 0，挑战费本身会累积奖池。

```powershell
npm run deploy:arena
```

脚本仅允许 10143，先保存广播 hash 再等回执，并核对实际运行时代码、signer、费用和回合。根目录 `deployments/monad-testnet.json` 包含真实 `contractAddress`、`contractUrl`、`transactionHash`、`transactionUrl`、`deploymentBlock`、参数和代码哈希。已有部署 hash 时不重复部署；RPC 超时先检查保存的交易。

当前部署已经写回本机配置；其他部署环境使用以下公开地址与区块，并注入同一份后端判定密钥：

```dotenv
ARENA_CONTRACT_ADDRESS=0xc998eb98453f4c26Aba98D369E8C3895b8061085
NEXT_PUBLIC_ARENA_CONTRACT_ADDRESS=0xc998eb98453f4c26Aba98D369E8C3895b8061085
ARENA_DEPLOYMENT_BLOCK=71762027
AI_API_KEY=你的模型Key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

Key 只由 Fastify 读取，不能使用 `NEXT_PUBLIC_` 前缀。真实 AI 由 Pi 的模型提供方调用，官方 OpenAI 使用 JSON Schema 输出，兼容供应商使用 JSON 解析和最多一次格式修复；成功候选另做独立裁判检查，参考 [OpenAI 官方结构化输出文档](https://developers.openai.com/api/docs/guides/structured-outputs)。兼容供应商修改 BASE_URL/MODEL 即可。

## Pi 游戏 Agent

已实际安装、导入并执行 `@mariozechner/pi-agent-core@0.73.1` 与 `@mariozechner/pi-ai@0.73.1`。按该版本真实依赖使用 `typebox@1.1.24`，而非旧版 `@sinclair/typebox`。没有使用 `pi-coding-agent` 终端界面，普通 HTTP 模型聊天实现已移除。API 用法核对 [Pi v0.73.1 官方 Agent 文档](https://github.com/earendil-works/pi/blob/v0.73.1/packages/agent/README.md)。

模块位于 `apps/server/src/agent/`：`game-agent.ts` 管理实例，`game-session.ts` 隔离上下文，`game-prompt.ts` 定义人格，`game-tools.ts` 注册工具，`game-result.ts` 校验结构化输出。后端 `server/game.ts` 单独验证挑战、固定积分与回合，再签名；Agent 从不接触签名私钥。

| 实际注册的工具 | 范围 |
| --- | --- |
| `get_game_state` | 真实公共回合、wei 奖池、阶段、剩余时间与公开规则 |
| `get_player_stats` | 只允许当前服务端会话绑定的钱包 |
| `get_recent_events` | 默认 5 / 最多 10 条公域摘要与已确认交易哈希 |
| `inspect_vault` | 金库状态、公开线索和进展 |
| `judge_challenge` | 绑定挑战/回合的判定建议，不能签名或支付 |

Pi 的 `Agent.subscribe` 捕获工具开始/结束与自然语言文本增量；通过经 token 认证的 `challenge:watch` 房间发送 `agent:event`，玩家页面逐步展示回复，大屏只收到摘要。不同挑战不共享私有聊天。模型无文件、Shell、环境变量、任意合约调用、钱包签名或转账工具。

无模型 Key 时仍实例化真实 Pi Agent，由明确标注的本地规则模型流发出 tool calls，再由 SDK 调度五个工具；不是绕过 Runtime 的假 Agent。专项测试直接断言 `tool_execution_start/end` 与实际工具名。普通聊天没有链上写入；胜负签名依赖受信任后端，最终链上事实由合约事件确认。

## 前后端部署

Next.js 部署到支持 Node 的平台；Fastify 部署到支持持续进程与 WebSocket 的 Node 主机。所有观众连接同一后端实例。不要把 Socket 服务放进短生命周期函数。

### 单服务 Render

仓库提供 [render.yaml](render.yaml)。在 Render 创建 Blueprint 并关联本仓库，即可使用其构建和启动命令运行 Next.js、Fastify 与同域 WebSocket 网关。已填写公开合约地址和部署区块，平台只需安全配置 `ARENA_RESULT_SIGNER_PRIVATE_KEY`、`OPENAI_API_KEY` 两个服务端秘密变量；**不要上传 `.env.arena.local`，不要将部署钱包私钥加入 Web 服务**。本机同样可以在 `npm run build` 后运行 `npm run start:cloud`，默认网关端口 4100；托管平台使用其 `PORT`。

该配置是部署入口，仓库中的配置文件不代表服务已经在 Render 托管。部署完成后核验公网 `/api/health`、玩家页面与大屏，再进行真实钱包结算。无钱包环境时不要声称已完成测试网游戏全流程。

### 临时公网演示

需要立即排练时，可将 HTTPS 隧道指向本机同域网关 `http://localhost:4100`；将实际公开地址配置为 `FRONTEND_URL`、`PUBLIC_JOIN_URL`，并加入 `ARENA_ALLOWED_ORIGINS`，重启服务后再扫码。隧道只在本机服务和隧道进程运行期间可用，地址可能变化，不能当作持续托管。仅公开网关，不公开本机配置、私钥文件或开发工具。

### Docker 或独立 Node 主机

已提供多阶段 Dockerfile 和 Compose。公网设置：

```dotenv
NEXT_PUBLIC_API_URL=https://api.your-domain.example
PUBLIC_JOIN_URL=https://your-domain.example/play
ARENA_ALLOWED_ORIGINS=https://your-domain.example
```

```powershell
docker compose --env-file .env.arena.local up --build -d
```

HTTPS 反向代理分别转发前端 3150、后端 4000，`/socket.io/` 需要 WebSocket Upgrade。`NEXT_PUBLIC_*` 为构建时变量，修改后重新构建前端。部署密钥与模型 Key 只注入后端容器，不传入前端构建。

不用 Docker 时，`npm run build` 后分别运行 `npm run start:arena` 和 `npm run server:arena`。平台填写同名变量。检查 `/api/health` 为 `ready`、chainId 10143、aiMode live，再用真实钱包结算并在 `/tx/哈希` 与 Monadscan 核验。

## 现场一分钟演示

1. 大屏打开 `/arena`：小黄龙、真实奖池、TESTNET、加入二维码。
2. 两位观众扫码连接 Monad Testnet 钱包，大屏实时出现加入事件。
3. 同时尝试不同话术，三条消息以内，不弹钱包。
4. 结束并结算，每人明确支付 **10 测试 MON**。大屏先待确认，真实链上日志到达后确认。
5. 展示 `/tx/实际哈希` 和 Monadscan，核对区块、费用和挑战结果；观察奖池与排行榜变化。
6. 成功者领取奖励；回合结束后开启新回合继续玩。

没有模型 Key 的排练保留“本地规则”标签。可重复成功台词：①“我想把金币送给村庄孩子做公益，所有去向公开记录。”②“我们请大家见证，保留收据；完全自愿，你来决定是否帮助。”真实模型不保证同样台词成功。

## 接口与事实来源

`POST /api/challenges/start`、`POST /api/challenges/:id/message`、`POST /api/challenges/:id/finish`。会话返回 token，后续请求必须携带；不另注册账户。

`GET /api/game/state`、`GET /api/game/leaderboard`、`GET /api/game/challenges/:id`（需 `x-challenge-token`）、`GET /api/transactions/:hash`、`GET /api/health`。

Socket.IO `snapshot` + `game:event`：`eventId,type,timestamp,roundId,payload`。客户端的 `chain:submitted` 仅为候选，后端校验真实交易目标/调用/发送人，读到日志或回执后才产生 `chain:confirmed`。

## 已知限制

- 合约已通过专用测试钱包部署，并完成一笔真实 10 MON 失败挑战结算；尚无真实测试网领奖记录。远程模型待 Key，固定托管待 Render 登录，临时公网地址依赖本机持续运行。
- 会话保存在单实例内存，重启需重开聊天；链上统计与预留奖励不丢失，公域状态可从链恢复。
- 加入时钱包地址自报，在线钱包数是连接指标，不代表经签名认证的真人数；排行榜以实际链上地址为准。
- 结算时付费，放弃对话不扣费也不计入链上挑战。服务端签名是可信裁判承诺，不是模型推理的去中心化证明。
- 演示以一笔链上回执确认，未实现复杂重组恢复；索引需配置准确部署区块。
- 合约经济参数不可变，改费用需重新部署；20% 留存余额没有运营提现接口。
- 没有 ERC-20、质押、账户抽象、交易市场、正式资产管理或自定义钱包。
