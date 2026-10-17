# 糯米开放任务与 Mojo 参赛开发任务书

> 历史任务书，不执行下列开放任务范围。当前请使用 [骗龙夺宝任务书](F:/出海项目/monad-x402-demo/docs/dragonbait/implementation-prompt.md)。

版本 3，2026 年 10 月 17 日。实施依据为当前 plan.md 与 implementation-mojo.md，不执行已归档的起名版任务书。

~~~text
在 F:\出海项目\monad-x402-demo 中实现「糯米 Nomi」的开放任务参赛版本，并准备符合 Mojo eventId 17 的真实作品材料。

先阅读：
- AGENTS.md 和已安装 Next 版本的 node_modules/next/dist/docs。
- docs/nomi/plan.md：产品目标。
- docs/nomi/implementation-mojo.md：具体架构、工具、数据、接口、阶段与验收。
- 当前 package.json、run.ps1、src/app/page.tsx、src/app/api/premium/route.ts、src/lib/network.ts、scripts 中的验证与 Mojo 脚本。
- https://mojo.devnads.com/api/agent/instructions/17/skill.md：参赛规范。它规定提交流程，不提供小猫运行时或接活市场。

目标：
用户从同一个自然语言入口输入目标和材料，小猫组合真实工具执行，交付可以打开、检查和继续修改的成果。任务没有固定职业或业务分类。角色有可编辑记忆、真实工作记录和按需采购工具的账单。

基线：
Next 16.4.2、React 19.3.1、viem 2.57.7、x402 2.28.0，旧例是固定内容付费接口，未实现新任务引擎。
保留旧 /api/premium 的 0.001 测试 USDC 诊断及 PUBLIC_DEMO_URL resource 配置，保留现有钱包和其他修改。
当前已有 mojo-agent.ps1、mojo-upload.ps1、mojo-submit.ps1、package-submission-source.py 和 /api/source。
不要覆盖其他任务的改动，不读取或打印不需要的秘密。

具体实现选择：
- 沿用 Next App Router 和 TypeScript。
- 候选新增依赖 ai 7.0.143、@ai-sdk/openai-compatible 3.0.71、zod 4.6.7，安装后按实际类型与官方 v7 文档验证。不要混用旧版 onStepFinish 等接口。
- AI SDK 负责模型消息和工具 schema，应用自己做持久调度。
- 单实例使用 node:sqlite 与持久磁盘，一个常驻 worker。不要把任务生命周期绑定到浏览器或一个长 HTTP 请求。
- 搜索首个适配器选择 Brave，图片接实际兼容图像服务；模型、图像、搜索分别预检。
- 当前 Codex 会话里的工具不会自动成为部署后端；应用必须有自己的 API 配置。
- 静态网页成果可以先用隔离预览，完整代码运行用独立 Docker 环境；确认 daemon 和镜像真实可用，不只判断命令存在。

核心执行循环：
1. 创建任务和用户消息，API 返回 taskId。
2. worker 领取持久 job，加载记忆、材料、消息与可用工具描述。
3. 模型生成一轮建议与工具调用；先保存 assistant 消息及调用 ID，再执行。
4. 将调用入持久队列，执行器校验参数、权限和费用。
5. 保存真实结果、产物与 tool 消息，再进入下一轮。
6. 按成果要求验证完成、继续修订、等待补充或报告具体缺口。
每个工具调用有稳定 invocationId；响应丢失和重启先恢复旧调用，不重新产生付费副作用。
SDK 日志回调不能作为唯一的关键持久化保障。

最小对象：
Task、Message、ToolInvocation、Job、Event、Artifact、Memory、PaymentAttempt、BudgetReservation。
外部接活阶段再加 Opportunity、Bid 和交付记录。
Task 以 goal、context、attachments、deliverables、acceptance 和 budget 表达，不使用 name_job、poster_job 等封闭类型路由全部业务。

首批工具：
search_web、read_url、read_file、generate_image、write_artifact、build_web_artifact、inspect_web_artifact、read_memory/propose_memory。
支付阶段接 discover_services、buy_service。
工具注册表保存实际 schema、可用性、计费类型与适配器。配置缺失就关闭对应能力，继续独立可完成的工作，不生成假结果。
文件操作以所属用户的附件/成果 ID 为入口，网页读取检查内网与重定向目标。
成果保存版本、MIME、SHA256、来源和验证记录。网页实际打开检查，研究保留来源，图片必须有真实文件。

界面：
使用 docs/nomi/assets/nomi-mascot-v1.png 的奶白圆脸、短腿、淡紫围巾小猫。
首页是房间和开放目标输入框；任务页显示计划、真实步骤、成果与账单；记忆可查看、修改和删除。
小猫的读书、画画、电脑、交付等画面对应真实后端事件。
静态角色图不是逐帧动画；不要用动画计时器驱动 completed。
支持 390px、键盘和减少动态效果。展示工作摘要，不展示模型隐藏推理。

付款：
沿用 Monad Testnet，金额随真实服务报价变化，不强制每单同价或固定两笔交易。
免费与供应商账户计费的能力不伪造链上付款。
模型选择 serviceId，受控模块取可信报价并执行预算检查与签名；私钥不进入模型或代码容器。
预算原子预留，付款尝试先落库；链上回执和 Transfer 核验后确认。
未知状态先对账，不自动重签重付。
当前 withX402 的默认 handler 可能在结算前运行，顾客预付款 handler 只接受委托，确认入账后再启动采购。
技术失败按订单实际规则处理退款；付款不等于质量验收，不把 x402 直接付款称作托管。
主人拨款、外部营业收入、工具支出、真实模型费用分别记录。

Mojo 结合方式：
普通小猫用户不需要 Mojo 账号；参赛 Agent 与产品 Agent 是两种身份。
复用现有 DPAPI 凭据方案，优先查询已有身份与项目，不为改产品名称重新注册。
认领必须由用户在登录 Mojo 的浏览器里完成。之后查询 claimed、认领用户与 eventId 17 的项目；报名、签到、比赛阶段和队长资格以服务端实时结果为准。
至少一张本 Agent 上传并确认的运行截图，格式与大小符合 Skill。
改造 mojo-upload.ps1，使其接受当前截图参数，并按文件 SHA256 和材料版本缓存；现有固定 browser-paid.png 与旧 confirmed 记录不能当作新作品截图。
上传顺序为申请 → PUT 对象存储 → confirm；PUT 不携带 Mojo Authorization。
本地先生成实际 name、description、Demo URL、真实仓库与确认图片的材料。猫立绘不能替代真实功能截图，localhost 不能充当远程 Demo。
更新源码打包清单，使其覆盖新模块与资源，继续排除秘密；不要发布旧源码包冒充本次构建。
已有项目使用正确 ID 更新；409 后重新查询并核对，400 按 fieldErrors 修正，403/404 处理身份或归属。
创建/更新后读回确认，状态 pending 表示等待审核，不表示入选。
只有既有用户授权覆盖参赛写入时才执行远端注册、上传或提交；此任务的本地实现和材料准备可先完成，不因未来提交而提前停工。已有明确授权不重复确认。

开发阶段：
A 实际模型、搜索、图片、存储与代码环境预检。
B 消息、任务、持久 worker、工具调用、基础成果，两类不同目标闭环。
C 图片、页面和文件验证，第三类目标与一个开发前未预设目标。
D 小猫房间、记忆和作品历史。
E 真实工具采购、费用、回执、失败恢复。
F Demo 与材料准备，Mojo 脚本适配和提交读回。
外部任务市场、长期主动工作在此基础上扩展，不把假数据写成已完成经营。
工作量按 implementation-mojo.md 的 24–42 人时作为初始估算，随实际接口预检调整。

验收：
同入口测试研究、视觉、网页和现场未预设清单任务。
检查真实产物、来源、主要交互、跨任务记忆及删除、追加需求后的计划版本、
重启恢复、重复付费、预算变化、访问隔离、失败提示和移动端。
保留当前 check/build/smoke；新增 npm 任务时更新 run.ps1 ValidateSet。
构建前停止 dev，避免共享 .next。
Mojo 错误分支先用本地夹具，不反复投稿测试；远端写入只在授权内进行。
证据保存到忽略的 .local 目录，公开版本不含秘密和用户私密材料。

交付：
可运行的完成阶段、配置与启动说明、任务与成果证据、角色截图、已验证的付款凭证、
本地 Mojo 材料及接口适配情况、未运行或受外部条件限制的项目。
不得把计划中的调用、模型自述、静态截图或未提交材料写成实际完成。
~~~
