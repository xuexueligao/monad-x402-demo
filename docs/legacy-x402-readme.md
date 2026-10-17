# Monad x402 最小付款示例

新增的“骗龙夺宝”合约底座位于 [`contracts/`](contracts/README.md)：包含普通钱袋、防火墙金库、Agent 付款适配、测试和固定请求演示。游戏规则和前端待讨论。下文仍是已有 x402 付款示例的说明。

用 **0.001 测试 USDC** 购买一次服务端内容。网络固定为 **Monad Testnet / Chain ID 10143**，使用 x402 v2 `exact` 付款方式。

这是支付技术示例，返回的是明确标注的固定示例内容，尚未接入 AI 模型。

## 启动

在此目录打开 PowerShell：

```powershell
.\run.ps1 -Task dev
```

浏览器打开 **http://127.0.0.1:3143**。

若使用已构建的版本：

```powershell
.\run.ps1 -Task start
```

`run.ps1` 会为当前进程指定项目内的临时目录，并关闭 Node 编译缓存。这样可避开本机默认临时目录指向失效盘符的问题，不修改系统设置。

## 从头安装

需要 Node.js 22.9+、npm。浏览器端实际付款需要安装 MetaMask 或 Rabby 等以太坊钱包。

```powershell
.\run.ps1 -Task install
.\run.ps1 -Task wallet:create
.\run.ps1 -Task dev
```

`wallet:create` 创建两个专用测试钱包，只打印公开地址。已有钱包文件时不会覆盖。私钥位于 `.local/test-wallets.json`，`.local/` 和 `.env.local` 均被 Git 忽略。

服务器 `.env.local` 仅需要一个公开收款地址：

```dotenv
PAY_TO_ADDRESS=你的测试网收款地址
```

浏览器页面连接的是当前浏览器的钱包。命令行验证脚本使用项目生成的专用测试钱包，二者可以是不同地址。

## 领取测试币

1. 打开 [Circle Faucet](https://faucet.circle.com/)。
2. Token 选择 **USDC**。
3. Network 必须选择 **Monad Testnet**。网站默认的 Arc Testnet 是另一条链。
4. 给付款钱包地址领取测试币。

本例通过 EIP-3009 授权和 facilitator 结算，专用测试付款钱包无需自行发起链上交易。本次真实验证仅领取了测试 USDC 即完成付款。

## 验证命令

保持服务运行，在另一个 PowerShell 终端执行：

```powershell
.\run.ps1 -Task check
.\run.ps1 -Task smoke
.\run.ps1 -Task pay:testnet
```

- `check`：TypeScript 检查。
- `smoke`：检查页面、网络配置、未付款 402、无效付款凭证及错误请求方法。
- `pay:testnet`：使用专用测试钱包真实支付 0.001 测试 USDC，检查接口响应、链上成功回执、正确的 USDC Transfer 事件，以及双方余额变化。
- 已有成功付款证据时，付款脚本默认不重复扣款。

浏览器验证使用已安装的 Microsoft Edge 的隔离无头实例，不读取你现有的 Edge 登录会话。测试提供者在 Node 中用专用测试钱包签名，私钥不会注入浏览器：

```powershell
.\run.ps1 -Task verify:browser
```

浏览器脚本检查无钱包提示、拒绝连接后的恢复、手机宽度，以及一次真实签名、链上付款和内容解锁。第一次执行会再支付 **0.001 测试 USDC**；有浏览器付款记录时默认跳过重复付款。

构建生产版本前先停止开发服务器，避免共用 `.next` 目录：

```powershell
.\run.ps1 -Task build
.\run.ps1 -Task start
```

## 主要文件

- `src/app/page.tsx`：钱包连接、切换测试网、付款和内容展示。
- `src/app/api/premium/route.ts`：x402 服务端保护与结算。
- `src/app/api/config/route.ts`：公开配置，不包含私钥。
- `src/lib/network.ts`：测试网、代币、价格和 facilitator 配置。
- `scripts/pay-testnet.mjs`：真实链上付款核验。
- `.local/evidence/`：本机验证结果和页面截图，不进入 Git。

## 本次已核验的首笔付款

- 测试钱包：`0xb49a5CbB09A8875cd789DDDFfC32fbAE3442Fe48`
- 收款钱包：`0x632C733D243c38fEb60675C20bC8a242d77724D0`
- 金额：`0.001` 测试 USDC。
- 付款钱包余额：`20 → 19.999`。
- 收款钱包余额：`0 → 0.001`。
- 区块：`71725775`。
- [在 Monadscan 核验交易](https://testnet.monadscan.com/tx/0xce497ebc3220952f60ece090fc6870d0a02153462f040f4b47f510fb1afea43b)。

浏览器测试如另行付款，会产生另一笔交易；最终余额和各次交易分别记录在 `.local/evidence/`，上述数值仅对应首笔付款。

本次浏览器验证也已完成真实付款：[浏览器操作产生的交易](https://testnet.monadscan.com/tx/0x57a112a93f884252cc572ad2abbca1dc64a9d885894dd6db7f97e30c435f98ed)。这两次本地验证后，付款钱包余额为 **19.998 测试 USDC**。

为参赛补充公网入口验证时，又通过公开链接完成了 [第三笔真实测试付款](https://testnet.monadscan.com/tx/0x93a245337a1e8ce6158fd3ea2e593354845032ca3f47d0901d3f74aafea6f4f7)。三次验证共使用 **0.003 测试 USDC**，付款钱包余额为 **19.997**，收款钱包余额为 **0.003**。

已通过：生产构建、TypeScript、接口付款保护、无钱包提示、取消连接后重试、390px 手机布局，以及浏览器真实付款解锁。浏览器检查使用上述隔离测试提供者，没有操作用户现有的钱包扩展弹窗。

## 参赛演示与源码

项目新增 `/api/source` 源码下载入口。使用明确的文件清单生成压缩包，不包含 `.local/`、钱包密钥、MOJO Agent 密钥或 `.env.local`：

```powershell
python scripts/package-submission-source.py
```

公开演示可通过本机 Cloudflare 临时隧道访问；链接仅在本机服务和隧道持续运行期间有效。正式项目 URL 和上传截图由 MOJO 提交记录确认。

## 参考资料

- [Monad 官方 x402 教程](https://docs.monad.xyz/guides/x402)
- [Monad 测试网配置](https://docs.monad.xyz/developer-essentials/testnet)
- [x402 官方 Next.js 示例](https://github.com/coinbase/x402/tree/main/examples/typescript/fullstack/next)

本例补全了官方教程片段中缺少的钱包连接、状态处理和内容展示，使用已安装 SDK 的接口，并显式指定测试 USDC 的代币地址、金额和 EIP-712 域。
