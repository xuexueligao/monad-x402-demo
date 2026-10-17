# MONAD RUG ARENA 验收记录

日期：2026-10-17（Asia/Shanghai）。挑战费用默认 **10 测试 MON**。

| 检查 | 实测结果 |
| --- | --- |
| Solidity 编译 | solc 0.8.37 / Cancun 通过，公开 RugArena ABI 已生成 |
| 合约测试 | 54 / 54，通过；其中 RugArena 14 项，保留的旧模块 40 项 |
| 后端与 Pi Agent | 18 / 18，通过；实际订阅工具执行事件并观察到全部五个工具 |
| 类型检查 | 前端及 server + Pi 模块严格 TypeScript 检查通过 |
| 生产构建 | Next.js 16.4.2 构建通过，5 个游戏路由均已生成 |
| 生产运行 | standalone 前端 3150 + Fastify 后端 4000 可启动 |
| 桌面与手机浏览器 | Edge 隔离实例，五路由 1600px / 390px 无横向溢出，无页面运行时错误 |
| 钱包 UI | 连接测试提供者后自动进入 /play，错误网络提示切换至 10143，无逐条聊天交易 |
| 无钱包体验 | 可恢复提示，按钮可重试 |
| 真正的链上核心链路 | 独享本地 Hardhat 节点：两钱包交错对话、10 MON 结算、10/100 积分、8 MON 奖金实转、新回合 |
| 多人同步 | 真实 HTTP + 两个 Socket 同步奖池、排行榜与真实确认事件 |
| Pi 与隐私 | 每挑战独立 Agent；token 错误不能订阅；A 的流式文本不进入 B 的房间或公共大屏 |
| 工具与输出错误 | 工具错误仍有合理回复；模型故障可重试；JSON 最多修复一次；失败恢复原上下文 |
| 后端授权与重放 | EIP-712 真实验签；重复结算拒绝；客户端伪造 hash 不能产生链上确认 |
| Monad RPC | 官方配置核对，实际 eth_chainId 返回 0x279f |
| 测试网部署 | 未部署；部署预检查明确报告缺少 ARENA_DEPLOYER_PRIVATE_KEY，未广播交易 |
| 真实远程模型 | 未验证；当前未配置 AI_API_KEY，清楚标注 local-rules，仍经过实际 Pi Runtime 工具执行 |
| 公网与 Docker 运行 | 已有部署配置与说明，尚无公网托管凭据；本机没有 Docker CLI，未宣称实测容器 |

浏览器验证脚本包含 7 组检查。测试提供者只模拟连接和网络切换，不制造交易或链上确认。链上交易与余额另由真实本地 EVM 实测，明确不当作 Monad Testnet 交易。

可重复证据：

- `.local/evidence/arena-e2e.json`：合约、两钱包、实际回执与奖励余额。
- `.local/evidence/arena-browser.json`：浏览器检查和运行时错误列表。
- `.local/evidence/arena-*-desktop.png` / `arena-*-mobile.png`：五页面真实截图。
- `artifacts/ui/`：补充视觉验收截图。

执行命令参见根 README。当前上线还需填写专用测试网部署钱包、真实模型 Key 与公网域名/主机；部署成功后 `deployments/monad-testnet.json` 才会包含实际地址和交易浏览器链接。
