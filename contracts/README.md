# 骗龙夺宝：合约与 Agent 付款底座

已实现两套独立保管原生 MON 的金库、统一付款请求、Agent 工具适配、链上事件回读、自动测试和可重复的本地演示。游戏门票、奖池分配、玩家胜负、排行榜计分与前端仍待讨论，这一层没有预设它们。

这是测试网原型。当前验证发生在本机 EVM，没有将本模块部署到 Monad 测试网，也没有接入真实模型；原 x402 示例之前的付款记录不能证明新合约已上线。

## 运行

需要 Node.js 22.13+。Windows 下从项目根目录执行：

```powershell
.\contracts\run.ps1 install
.\contracts\run.ps1 test
.\contracts\run.ps1 demo
```

其他系统或已配置好临时目录的终端：

```sh
npm --prefix contracts ci
npm --prefix contracts test
npm --prefix contracts run demo
```

测试和演示会编译 Solidity、启动专属的 loopback 本地链、执行交易并退出本次启动的节点。不会复用或重置其他链节点。依赖已安装后不需要外网、模型 API、浏览器钱包或测试币。

`run.ps1` 把 TEMP/TMP 指向模块自己的 `.local/tmp`，避开这台电脑失效的默认临时目录。模块有独立的 package-lock，不改变现有 Next.js 应用依赖。

## 两种模式的真实差别

| 能力 | UnrestrictedVault：普通钱袋 | PolicyVault：防火墙金库 |
| --- | --- | --- |
| 资金实际保管位置 | 独立合约地址 | 另一独立合约地址 |
| Agent 可以做什么 | 把余额转给任意有效收款地址 | 提交请求，由合约检查白名单、单笔及周期总额度 |
| 白名单、限额检查 | 无业务授权限制 | 必须同时满足 |
| 主人审批 | 不需要 | 主人独立签署交易，可批准一条原本被拒绝的请求 |
| 基础保护 | Agent 身份检查、暂停、请求去重、重入保护 | 相同基础保护，加链上支出规则 |

普通钱袋是**故意放宽支出权限的合约基线**。它不是“把 EOA 私钥给模型”的实现，演示时应如实表述。模型只提出付款请求，私钥保留在签名服务中。

主人和 Agent 必须是不同地址，Agent 不能改策略、轮换角色、解除暂停或调用主人审批。金库只提供原生币付款入口，没有任意 calldata、ERC-20 approve、delegatecall 或升级入口。主人是可信管理者，能够修改策略和明确批准支出；本设计不防主人自身恶意放款。

## 付款请求和状态

```solidity
struct PaymentRequest {
    bytes32 requestId;      // 服务端创建；每个金库内只能提交一次
    address payable recipient;
    uint256 amount;         // 原生 MON 最小单位，18 位小数
    bytes32 contextHash;    // 服务端上下文摘要；不把完整聊天写链上
    uint64 deadline;        // Unix 秒；包含到期这一秒
}
```

两个金库都通过 `submit(request)` 接收请求，因此同一组请求可以对照执行。`hashRequest` 绑定 chainId、金库地址和全部字段，两个金库的请求摘要会不同；相同的是请求内容与 requestId。

`contextHash` 只用于关联后端证据，不证明模型确实被诱导或某段文字确实由模型生成。后端需要保存真实工具调用、模型及提示词版本。

| 接口 | 调用者 | 效果 |
| --- | --- | --- |
| `submit(request)` | Agent | 转账，或记录策略拒绝并返回 false |
| `preview(request)` | 任意人，仅 PolicyVault | 预估当前拒绝原因；不预留余额或额度 |
| `approveAndExecute(request, expectedPolicyVersion)` | 主人，仅 PolicyVault | 对精确匹配、未过期的已拒绝请求批准并立即付款一次 |
| `setRecipient(address, allowed)` | 主人 | 修改白名单，策略版本递增 |
| `setLimits(singleLimit, windowBudget)` | 主人 | 修改限额，保留已花额度，策略版本递增 |
| `setAgent(address)` | 主人 | 轮换 Agent，保护版策略版本递增 |
| `transferOwnership` / `acceptOwnership` | 当前主人 / 新主人 | 两步交接；保护版接收交接后策略版本递增 |
| `pause` / `unpause` | 主人 | 暂停 / 恢复付款及审批；仍可入金 |
| 直接发送原生币 | 任意地址 | 向对应合约入金，两个资金池互不混用 |

`Unseen → Paid` 或 `Unseen → Blocked`。被拒绝的 requestId 也已经消耗，不能修改参数重试；需要新 requestId。主人可以对 `Blocked → Paid` 做一次明确批准。

主人审批绑定原请求的全部字段、截止时间和当时策略版本。策略或权限变化后，旧拒绝请求不能再审批；应以新 ID 重新提交。审批不是永久白名单，也不是向 Agent 发放额外权限。批准金额会计入当前周期已花额度，即使主人明确批准的金额超出普通限额，后续 Agent 也不会额外获得预算。

当前预算使用 `floor(block.timestamp / windowSeconds)` 对齐的**固定窗口**，不是滚动窗口。窗口长度部署后固定，窗口交界前后可能各花一份预算。后续游戏回合如何对应窗口尚未确定。

## 链上拒绝与交易失败

| reason 值 | 含义 |
| --- | --- |
| 0 | NONE，允许执行 |
| 1 | RECIPIENT_NOT_ALLOWED，收款人不在白名单 |
| 2 | SINGLE_LIMIT_EXCEEDED，超出单笔额度 |
| 3 | WINDOW_BUDGET_EXCEEDED，超出周期总额度 |
| 4 | INSUFFICIENT_BALANCE，余额不足 |

检查顺序为白名单、单笔、周期预算、余额。一个请求有多处违规时记录最先命中的原因。

策略拒绝是一笔 **status=success、无付款、包含 PaymentBlocked 的交易**。不要把它在 UI 上写成 revert，也不能仅凭 receipt.status 判断攻击是否转出了钱。

无效角色、重复 ID、非法参数、过期、暂停或收款合约拒收会 revert。revert 会回滚本次事件与计数。后端应分别记录模拟失败、已广播交易、reverted receipt 和链上业务拒绝；不能编造一条链上不存在的拦截事件。

## Agent 与后端接法

- `abi/*.json`：可供后端或未来前端直接使用的 ABI，由编译脚本生成。
- `lib/payments.mjs`：金额和请求校验、工具定义、付款队列、回执解析、固定区块快照统计。
- `lib/events.mjs`：按区块分段回读事件、去重、检查回读期间的区块锚点、生成原始付款指标。
- `lib/deployment.mjs`：部署配置校验和部署结果只读核验。

模型工具名为 `request_payment`，参数只有 `recipient` 和十进制字符串 `amountMon`。服务端选择模式、生成 requestId/contextHash/deadline。模型不能选择弱版通道、替换请求标识或调用主人审批。入口费用和参与者收款地址是否绑定留给后面的游戏规则决定。

```js
import { createPaymentExecutor, executePaymentTool } from "./lib/payments.mjs";

const executor = createPaymentExecutor({
  publicClient, walletClient: agentWalletClient, chainId: 10143,
  vaults: { baseline: baselineAddress, firewall: firewallAddress },
});
const result = await executePaymentTool({
  executor,
  mode: "firewall",                 // 服务端活动配置；不是模型参数
  trusted: { requestId, contextHash, deadline },
  arguments: actualToolCall.arguments,
});
// result.outcome: paid | blocked | reverted
// result.transactionHash、reason、ownerApproved 用于证据与后续界面。
```

同一签名钱包的两个模式共用一个 executor。它在单进程内串行发送付款，防止多人同时调用时 nonce 冲突。多进程/多实例部署需要共享持久队列；重启后需要用固定 requestId 和链上记录对账。当前不包含 HTTP 服务、持久任务队列或 SSE 推送，不应把它们说成已完成。

真实模型接入点只需把实际工具调用交给适配器。普通聊天留在后端，没有强制每句聊天都上链。`PAYMENT_TOOL` 是通用工具定义，还需按所选模型 SDK 的格式包装。

`readVaultState` 读取：requestCount、blockedCount、executedCount、ownerApprovedCount、totalPaid，以及余额与策略。`scanPaymentEvents` 可以为大屏恢复链上事件流。当前提供原始指标，不预设排行榜分数。

这些是付款意图和执行统计，**不是总聊天次数、真人参与人数或模型诱导成功率**。一条被拒绝后又经主人批准的请求，会同时贡献一次历史拒绝和一次已批准付款；不能把主人付款计作防火墙被突破。`agentPaidAmount` 与 `ownerApprovedAmount` 分开计算。链上获准的正常付款也不能自动称为攻击成功。

回读结果带区块高度和哈希。后端应从部署区块开始保存检查点，重连后重读重叠区间并处理重组；最新区块快照本身不等于最终确认。

## 稳定复现的演示

`run.ps1 demo` 每次启动全新本地链，种子资金每个金库 0.1 本地 MON，单笔 0.01、周期总额 0.02。脚本依次执行并断言余额变化：

1. 对攻击者转 0.03：普通钱袋实际付款。
2. 对相同请求：策略金库因非白名单拒绝，余额不变。
3. 对白名单地址转 0.011：超单笔额度拒绝。
4. 两笔合法的 0.01：各自付款，预算耗尽。
5. 再请求 1 wei：被周期总额度拒绝。
6. 主人明确批准第 2 步原请求：付款一次，并检查再次审批失败。

共 7 笔有回执的付款/拒绝操作，额外检查一次审批重放失败。它明确标注“固定付款意图重放”，不冒充现场 AI 被说服。所有转账、拦截、余额变化和回执都由真实本地 EVM 执行，未使用写死的成功提示。

证据位于 `contracts/.local/demo/evidence.json`，包含角色、策略、每一步请求、交易哈希、完整 receipt、前后余额和最终统计。命令退出后本地链关闭，哈希不能拿去 Monadscan 查询。本地耗时也不是 Monad 网络性能数据。现场可以把这一段作为公开标注的复现实验，与真实模型挑战分开演示。

## Monad 测试网部署

`scripts/deploy-testnet.mjs` 仅接受 chainId 10143。复制本模块 `.env.example` 为 `.env.local`，设置专用部署/主人密钥、独立 Agent 地址及策略；部署签名者必须等于初始主人，便于完成白名单初始化。部署脚本不需要 Agent 私钥。

```powershell
.\contracts\run.ps1 deploy:testnet
.\contracts\run.ps1 verify:deployment .local/deployments/实际清单文件名.json
```

参数路径相对 `contracts` 目录。默认不入金；`DRAGONBAIT_SEED_EACH_MON` 大于零时才给两个金库分别注入该数量的测试 MON。普通钱袋允许 Agent 花掉全部入金，使用隔离的测试资金。

部署清单位于 `.local/deployments/`。每笔交易广播后先保存哈希，再等待回执；部分失败时留下 `needs-attention` 清单。遇到超时应先检查已有哈希，避免盲目重跑重复部署。

只读核验会比对 chainId、两种合约的编译运行时代码、不可变参数对应的读取值、运行时代码哈希、主人、Agent、策略版本、限额和预期白名单。配置变化后旧清单会报告漂移。`artifacts/standard-input.json` 和清单中的编码构造参数可供浏览器源码验证使用；当前没有自动执行浏览器源码认证。

依赖精确锁定为 Solidity 0.8.37、OpenZeppelin 5.6.1、Hardhat 3.20.0、viem 2.57.7；编译目标为 Cancun。`tmp` 用已修复的 0.2.7 覆盖上游编译工具的旧补丁依赖。编译产物、依赖、临时节点日志和本机证据已加入忽略规则，公开 ABI 保留。

当前没有 Face ID/P256、ERC-20 资产模块、正式安全审计或真实模型稳定越狱保证。以上是实现范围，不代表这些能力不能以后加入。

## 参考与参赛衔接

- [用户给出的共享讨论](https://chatgpt.com/share/6ad30aa2-a438-83ee-8a81-ff6138740c0c)：两套授权对照、版本 B 的可靠性、普通聊天不必上链，以及拒绝交易事件的处理。
- [Monad 官方测试网配置](https://docs.monad.xyz/developer-essentials/testnet) 与 [EVM 差异](https://docs.monad.xyz/developer-essentials/differences)：链配置及目标网络注意事项。
- [Hardhat Node.js 支持](https://hardhat.org/docs/reference/nodejs-support)：本地执行环境最低版本。
- [Mojo event 17 文档](https://mojo.devnads.com/api/agent/instructions/17/skill.md)：后续上传和项目提交使用。该文档不是游戏 Agent 的执行 SDK。本次只写实现和验证材料，尚未提交或修改参赛项目。

奶龙素材继续使用 [普通钱袋](../docs/dragonbait/assets/nailong-pouch-v1.png) 和 [策略金库](../docs/dragonbait/assets/nailong-vault-v1.png)。模型、游戏入口、扫码、大屏与排行榜可在此底座上继续讨论和接入。
