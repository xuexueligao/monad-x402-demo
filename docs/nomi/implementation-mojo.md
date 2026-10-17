# 糯米开放任务实现与 Mojo 参赛落地方案

> 产品方向已改为 [骗龙夺宝](F:/出海项目/monad-x402-demo/docs/dragonbait/plan.md)。本文件的 Mojo 接口与现有脚本说明仍可参考，开放任务产品范围不再执行。

版本 3，2026 年 10 月 17 日。工作目录：F:\出海项目\monad-x402-demo。

本方案把开放任务小猫落到具体技术与交付路径：用户给目标，模型选择工具，持久执行器落实操作，产物系统验证结果，角色界面呈现真实进度，支付模块承担实际结算。最后由独立的 Mojo 提交流程把可运行作品交给 Monad Blitz 的 eventId 17。

任务不预设职业或业务类别。研发按底层能力递进接入，用户始终从同一个自然语言入口提出目标。

本次为实现规划及资料整合，尚未安装新依赖、运行真实模型、注册 Mojo Agent、上传截图或提交项目。

## 1 先明确 Mojo 文档在实现中的位置

已于本次通过 HTTP 读取用户给定的 [Mojo Agent Skill](https://mojo.devnads.com/api/agent/instructions/17/skill.md)，返回 200。文档描述 Agent 注册、真人认领、项目查询、截图上传确认、创建与更新作品。

它不提供小猫的规划模型、搜索工具、图像工具、记忆系统、自由职业任务广场或后台执行环境。这些由本产品实现或接入。不能把 Mojo 项目列表当成给小猫接活的任务列表。

区分两个身份：

| 身份 | 做什么 | 凭据放在哪里 |
| --- | --- | --- |
| 产品里的糯米 | 为应用用户执行目标，使用工具和任务预算 | 应用后端，模型与付款各自隔离 |
| Mojo 参赛 Agent | 在认领用户有资格的比赛里提交或更新参赛作品 | 运营脚本的秘密存储，现有 Windows DPAPI |

普通用户使用小猫无需注册 Mojo。参赛凭据不发给模型，也不进入宠物页面或工具注册表。

这份文档还规定至少一张由当前 Agent 上传并确认的图片、团队赛队长身份校验，以及创建或更新后进入 pending 审核。文档没有给出当届截止时间、详细评分标准或必须部署哪类合约；这些不能从提交流程推导。

## 2 技术选型直接确定

| 模块 | 采用方案 | 原因与边界 |
| --- | --- | --- |
| 产品页面与 API | 沿用 Next 16.4.2、React 19.3.1、TypeScript | 当前项目已具备，不重建 |
| 模型协议与工具结构 | AI SDK 7、Zod 4、兼容供应商适配器 | 统一模型调用及工具输入结构，供应商可替换 |
| 任务执行 | 一个常驻 worker＋持久队列＋逐轮工具执行 | 浏览器关闭后继续，重启可恢复 |
| 数据 | 单实例阶段使用 node:sqlite | 当前 Node 22.17.0 可用；依赖固定运行环境 |
| 成果文件 | 持久磁盘，按用户和任务隔离 | 支持预览、下载、版本和校验 |
| 搜索 | 首个实现选择 Brave Web Search 适配器 | 独立 API key；真实抓取正文另做读取工具 |
| 图片 | AI SDK 兼容图像服务适配器 | 必须核验实际服务、模型和图像接口支持 |
| 网页成果 | 先支持独立 HTML/CSS/JS 文件及隔离预览 | 能做邀请页、小工具、展示页等多种任务 |
| 完整代码运行 | 独立 Docker 执行环境 | 不把持有秘密的应用进程作为生成代码沙箱 |
| 链上付款 | 沿用 viem 2.57.7、x402 2.28.0 | 复用现有网络和回执验证 |
| Mojo | 复用现有三个 PowerShell 脚本并改造材料参数 | 不把参赛接口混入产品任务引擎 |

本次从 npm registry 只读核验到的候选版本为 ai 7.0.143、@ai-sdk/openai-compatible 3.0.71、zod 4.6.7。前两者要求 Node >=22；Zod 版本满足其 peerDependencies。这是候选兼容依据，安装、类型检查与模型工具调用仍需实际验证。

拟执行的依赖安装命令，不代表已经运行：

~~~powershell
npm.cmd install --save-exact ai@7.0.143 @ai-sdk/openai-compatible@3.0.71 zod@4.6.7
~~~

AI SDK 官方工具结构支持描述、输入 schema 和可选执行函数。本方案选择由应用持久执行工具，避免把整个任务只放在一次 HTTP 请求里的自动循环中。[工具调用文档](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)、[供应商适配文档](https://ai-sdk.dev/providers/openai-compatible-providers)。

Docker 本次只确认命令存在，尚未核验 daemon、镜像或容器隔离。首阶段先检查运行条件；完整后端代码执行未就绪时，前端静态成果仍可先运行，界面明确真实能力。

## 3 总体架构

~~~mermaid
flowchart TD
  U["用户目标与材料"] --> UI["糯米房间与任务工作台"]
  UI --> API["任务 API"]
  API --> DB["SQLite 任务、消息、事件、记忆"]
  DB --> W["持久 worker"]
  W --> LLM["模型：提出下一步工具调用"]
  LLM --> Q["保存调用后再执行"]
  Q --> TR["工具注册表与执行器"]
  TR --> S["搜索与网页读取"]
  TR --> I["图像服务"]
  TR --> F["文件与网页成果"]
  TR --> C["独立代码环境"]
  TR --> P["按需采购与 x402"]
  TR --> DB
  F --> A["成果与校验"]
  I --> A
  C --> A
  A --> UI
  DB --> UI
  A --> PKG["运行截图、Demo、说明"]
  PKG --> MOJO["独立 Mojo 提交脚本"]
~~~

产品后端写入事实；前端展示事实。模型负责提出行动和生成内容，工具的实际返回与验证记录决定该行动是否完成。

## 4 一个目标怎样实际执行

以“帮我把这个想法做成能演示的小网站”为例。该例只用于解释流程，任务结构不写死网站类型。

1. 浏览器 POST /api/tasks，提交 goal、附件 ID、项目上下文和预算引用，立即获得 taskId。
2. API 将用户消息、任务要求和待执行 job 一次落库，返回 202，不等待整个生成完成。
3. worker 领取 job，加载已确认偏好、当前项目资料、历史产物以及本次可用工具清单。
4. 模型提出下一轮行动，例如读取材料、搜索某个问题、生成图片或写入页面文件。
5. 应用先保存模型产生的 assistant 消息与工具调用 ID，再把待执行调用写入队列。没有持久化成功就不执行有费用的动作。
6. 执行器校验参数、文件归属、预算和已有授权后调用工具；记录状态、返回值、费用和成果引用。
7. 应用保存 tool 结果消息。下一轮模型接收实际结果，再决定继续、修改计划、询问信息或交付。
8. 生成的文件进入对应验证器：页面用隔离浏览器打开，图片检查文件，研究内容保留来源。
9. 成果要求满足后进入 completed，用户看到可打开的成果和工作小票。若缺关键能力，则进入 blocked 或 waiting_input，指出具体缺口。
10. 小猫根据事件抱书、画图、敲键盘或递交成果；动画不会提前宣布成功。

消息与工具结果需要持久保存。不能只保存一个 plan.json，再让模型下次凭空猜测前一次执行到了哪里。

建议的调度伪代码如下，仅解释事务边界，不作为未经检查的可编译实现：

~~~text
claim a job using a database lease
load durable messages and unfinished tool calls

if an unfinished call exists:
    reconcile uncertain side effects
    execute or recover the same call
    save output and tool-result message
else:
    ask model for one next turn using tool descriptions
    persist assistant turn and tool calls before execution
    queue pending calls, or validate a proposed final delivery

checkpoint task state
continue while the current run has quota and is not waiting
~~~

AI SDK 的工具描述可以不附自动 execute，由应用自己调度。模型客户端使用该供应商真实支持的工具调用协议；只支持普通文本的模型不应静默假装具备工具调用能力。

## 5 工具接口怎么做

所有工具实现统一接口，先接具体适配器，再开放给规划器：

~~~ts
type ToolContext = {
  userId: string;
  taskId: string;
  runId: string;
  invocationId: string;
  signal: AbortSignal;
};

type ToolOutput = {
  summary: string;
  data?: unknown;
  artifacts?: Array<{ artifactId: string }>;
  sources?: Array<{ url: string; accessedAt: string }>;
  usage?: { unit: string; quantity: number };
};

type ToolDefinition = {
  id: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  availability: "ready" | "unconfigured" | "unavailable";
  billingKind: "local" | "provider" | "x402";
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolOutput>;
};
~~~

真实代码把 unknown schema 换成已安装 Zod/SDK 对应类型。任务目标没有业务枚举；工具 ID 只是实际可执行能力。

首批适配器及完成要求：

| 工具 | 具体实现 | 返回什么 |
| --- | --- | --- |
| search_web | Brave 搜索 API，保留标题与链接 | 来源列表与获取时间 |
| read_url | 服务端读取公开 HTTP 页面并提取正文 | 正文、URL、获取结果；片段和全文分开 |
| read_file | 根据所属用户的附件 ID 读取材料 | 已支持格式的内容和来源引用 |
| generate_image | 对接实际可调用的图像模型 API | 存入成果目录的真实图片 |
| write_artifact | 写入任务目录并保存 metadata | artifactId、版本、类型和可访问预览 |
| build_web_artifact | 生成独立网页文件集与依赖说明 | 网页成果及入口文件 |
| inspect_web_artifact | 隔离 Playwright 打开页面，检查交互 | 截图、控制台错误和验证结果 |
| read_memory / propose_memory | 读取已确认记忆，提出新偏好 | 有来源的上下文与可编辑建议 |
| discover_services | 返回已验证服务目录 | 能力、报价、网络、可用性 |
| buy_service | 按服务 ID 获取报价并进行 x402 调用 | 实际结果、付款凭证或待核实状态 |

Brave Web Search 可先用官方 Web API 接入，并由 read_url 补充原文；不能拿搜索摘要当成完整阅读。[官方接入说明](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)。

只读文件工具接收 attachmentId，不接收模型任意指定的主机文件路径。网页读取需要阻止访问本机秘密接口与内网地址，并检查重定向目标；这是公开网页读取引入的实际边界。

图像工具与 Codex 当前会话的 imagegen 是两件事：新应用必须有自己的、实际可用的图像后端。不能把会话工具当成部署后自动存在的免费 API。

PDF、DOCX、表格等文件适配器逐个接入并声明可用格式。不能将不支持的文件静默当成空文本，也不能声称模型读过实际未提取的附件。

## 6 文件、代码、记忆与小猫状态

### 成果

文件保存到持久目录，数据库记录所属用户、任务、版本、MIME、大小、SHA256、来源和验证状态。下载通过鉴权接口进行，不能用猜得到的 taskId 公开全部用户材料。

静态网页在独立 origin 或限制严格的 sandbox iframe 中预览，不携带登录 cookie、模型 key 或钱包权限。生成代码要运行后端或构建工具时，交给独立容器；不向该容器挂载应用的秘密配置和测试钱包。

每种成果的验收不同：

- 报告：来源可打开，内容覆盖任务提出的问题，推断与事实有区别。
- 图片：真实图像可打开，尺寸、用途与用户要求相符。
- 网页：入口可访问，主要交互实际可用，没有阻断性控制台错误。
- 文件：格式可打开；要求可编辑时不能只给一张截图。
- 客户委托：交付记录与验收反馈单独保存，不能由模型代替顾客确认满意。

### 记忆

首版用结构化记忆，不急于接向量数据库。每条记忆包含 userId、projectId、内容、来源任务或用户消息、确认状态、更新时间和删除状态。

构建上下文时注入该用户确认的偏好、当前项目目标及少量相关成果摘要。大文件通过附件读取工具按需获取。模型推测的偏好先作为建议，用户可改正；删除记忆后后续任务不再检索它。

### 角色事件

| 后端事实事件 | 画面反馈 |
| --- | --- |
| task.queued | 收好委托信 |
| tool.started，读取或搜索 | 抱书或看资料 |
| tool.started，图像或设计 | 拿画笔 |
| tool.started，文件或页面 | 面对小电脑 |
| payment.submitted | 查看小票，显示正在核实 |
| payment.confirmed | 账本出现真实记录 |
| task.waiting_input | 举一个简短问题牌 |
| task.completed | 递交成果，播放一次庆祝 |
| task.failed / blocked | 说明原因，展示恢复或替代步骤 |

事件文字是可核验的工作摘要，不暴露模型的隐藏推理。使用递增 eventId，浏览器每两秒读取增量事件，刷新后可恢复；P1 再考虑 SSE。宠物动效可以先用现有静态素材和道具反馈，完整动作图随后制作。

## 7 数据表和 API

先用 SQLite 与磁盘完成单实例闭环；部署时需要持久卷。迁移到多实例再采用共享数据库与对象存储。

关键表：

| 表 | 最少字段与约束 |
| --- | --- |
| users / sessions | 用户、会话摘要、到期时间 |
| pets | 所属用户、名称、外观配置 |
| tasks | goal、context、成果要求、预算引用、state、version |
| messages | taskId、role、内容、turnId、sequence |
| tool_invocations | invocationId、toolCallId、toolId、输入摘要、state、outputRef |
| jobs | taskId、kind、state、leaseOwner、leaseUntil、attempt |
| task_events | eventId、taskId、type、payload、createdAt |
| artifacts | 所属用户、任务、路径、类型、版本、SHA256、validation |
| memories | 内容、来源、作用域、确认状态、updatedAt |
| payment_attempts | 目的、调用 ID、nonce、报价快照、state、txHash |
| budget_reservations | 调用 ID、金额、有效状态、消费与释放事件 |
| opportunities / bids | 外部委托、发布者、报价、接单和交付状态 |

付款尝试和预算预留都绑定稳定 invocationId；同一调用重放时先检查旧结果。没有有效租约的 worker 不得继续提交新的副作用。

拟新增应用接口：

| 接口 | 用途 |
| --- | --- |
| POST /api/tasks | 创建开放目标与 job，返回 202 |
| GET /api/tasks/{id} | 读取所属任务、计划摘要与成果 |
| GET /api/tasks/{id}/events?after={eventId} | 获取增量工作事件 |
| POST /api/tasks/{id}/messages | 追加用户要求、补充信息或修改目标 |
| POST /api/tasks/{id}/cancel | 请求停止后续操作，不假装撤销已发生付款 |
| POST /api/attachments | 上传用户材料 |
| GET /api/artifacts/{id} | 鉴权预览或下载 |
| GET/PATCH/DELETE /api/memories/{id} | 查看、纠正和删除记忆 |
| GET /api/capabilities | 只返回真实可用能力与配置状态 |
| POST /api/internal/worker/tick | 受服务端凭据保护的单轮执行入口 |
| POST /api/orders/{id}/pay | 外部委托收款 |
| GET/POST /api/opportunities | 本产品或已接入来源的真实委托 |

Mojo API 不列入普通用户调用的产品接口。

任务状态建议 queued、running、waiting_input、waiting_authorization、reconciling、completed、failed、cancelled。取消请求停止新增工作；已经提交的付款必须继续查证，不能立即释放未知金额。

## 8 支付如何接到工具执行

免费或开发者账户付费的能力直接由对应适配器执行，并记录调用用量。只有提供 x402 报价的服务，才通过 x402 工具购买。不能为了参赛把每个内部步骤都造一笔交易。

模型只选择 serviceId、服务输入和期望成果。付款模块从可信服务配置取 URL、收款人、代币、网络和报价，检查用户已授权预算后签名；不提供任意地址转账工具。

执行顺序：

1. 保存 invocationId，获取并冻结报价。
2. 数据库原子预留预算，持久化付款尝试。
3. 发起原始 x402 授权与请求。
4. 保存返回凭证，解析并核验链上成功回执与对应 Transfer。
5. 确认后保存工具结果和实际消费；HTTP 丢失则先恢复原付款与原结果。
6. 将真实工具结果交回模型，继续任务。

现有 /api/premium 采用 withX402；默认 authorization 路径会先运行 handler 再结算。顾客付款 handler 只接受委托，确认入账后才启动需要花钱的工作。结算后回调不应承担唯一的持久化保障，链上与数据库之间需要对账恢复。

工作预算同时计算已消费和仍有效预留，未知支付不立即释放。真实模型费用、测试币采购、主人拨款和外部营业收入分别记账。

首轮网络沿用当前 network.ts 的 Monad Testnet。主网资金和新合约不属于这次既定实现范围。官方接入依据：[Monad x402](https://docs.monad.xyz/guides/x402)。

## 9 小猫去哪里接活

Mojo 在该文档中是参赛项目平台。第一版任务来源选择本应用里的“发布委托”入口，邀请真实体验者发布开放描述的任务。后续再接外部平台和智能体服务网络。

委托包含自然语言目标、附件、交付要求、期限与报酬。猫读取后估计能力、工具成本和时间，形成报价；需求方接受后才算接单。主人启用接活模式，并提供已授权的接单与费用条件。

工具目录解决“去哪买能力”，任务广场解决“谁有工作愿意付钱”，二者分开实现。没有真实委托时显示暂无合适机会；演示数据必须有标记。

产品先证明主人委托能够跨场景完成，再接经营循环，避免在执行能力未成立时建设一个空市场。

## 10 Mojo 的提交流程怎样落实到现有代码

以下来自用户给定的 Mojo Skill，实施时复用现有脚本并核验实际响应。读取规则本身不等于已经报名、签到、认领或获得队长资格。

### 现有实现与需要修改的地方

| 当前文件 | 已有能力 | 本项目实施要点 |
| --- | --- | --- |
| [mojo-agent.ps1](F:/出海项目/monad-x402-demo/scripts/mojo-agent.ps1:1) | register、me、projects，秘密使用 DPAPI 保存 | 优先复用既有身份，核验 claimed 与认领用户；不因改产品名重复注册 |
| [mojo-upload.ps1](F:/出海项目/monad-x402-demo/scripts/mojo-upload.ps1:1) | 申请、PUT、confirm，直传不带 Mojo Authorization | 当前固定旧截图且会复用旧记录；改为按文件参数、SHA256 与本次材料版本复用 |
| [mojo-submit.ps1](F:/出海项目/monad-x402-demo/scripts/mojo-submit.ps1:1) | 身份与项目查询、POST/PATCH、读回验证 | 用本次小猫材料；补足 409 后查询、字段错误和 pending 状态处理 |
| [package-submission-source.py](F:/出海项目/monad-x402-demo/scripts/package-submission-source.py:10) | 显式源码清单与排除秘密 | 目前清单只覆盖旧示例；新增任务模块、资源和新依赖后更新清单 |
| [source route](F:/出海项目/monad-x402-demo/src/app/api/source/route.ts:7) | 提供本地准备好的源码 ZIP | 源码包必须与本次已运行构建一致；不要提供过期支付示例包 |

这些是已读代码的结论，不代表本次运行或验证了脚本的远程结果。已有登记、认领和项目状态尚未查询；不要靠本地文件推断远端状态。

### 顺序与门槛

1. 复用或注册参赛 Agent。注册返回的秘密只出现一次，立即安全保存；当前 Windows DPAPI 方案可延用。
2. 需要认领时，把 claimUrl 交给用户在登录 Mojo 的浏览器中完成。该步不能由脚本代替用户确认。
3. 调用 me，确认 claimed 和真实认领用户；团队赛还受队长身份限制。
4. 查询 eventId 17 下既有项目，决定准备创建还是更新；项目归属与本次作品内容要核对。
5. 准备真实运行截图。至少一张，单张不超过文档规定的 10MB，格式使用允许的 PNG/JPEG/GIF/WebP。建议三张分别展示角色任务、真实成果和支付凭证。
6. 每张图片执行申请上传地址、直传对象存储、向 Mojo 确认上传；只有确认后的 uuid/path 才进入参赛材料。S3 PUT 不携带 Mojo Authorization。
7. 使用实际项目名、简介、可访问 Demo、真实仓库与确认截图构造提交材料。
8. 创建返回 201 后读取项目确认状态；已有项目则按正确 projectId 更新。409 后重新查询，不能盲目创建或覆盖不相符的作品。
9. 400 按 fieldErrors 纠正；403 处理认领、资格或比赛阶段；404 核对项目归属。每次调用仍可能重新检查资格。
10. 将最终结果标为“已提交，等待审核”，只有主办方后续结果才能决定入选情况。

### 本地先生成可审阅的材料

拟新增 submission prepare 阶段，先写入本地材料文件而不执行远端写入。内容包括：

- name：暂用“糯米 Nomi”，最终以用户确认的产品名为准。
- description：用实际完成的功能描述开放目标、工具组合、角色记忆与可核验采购；未完成的功能另列，不写成已实现。
- url：本次真实可访问的 Demo。不能把 localhost 当作评委可访问网址。
- eventId：17。
- meta.github：实际仓库链接。文档示例包含该字段，具体必填及校验以服务端为准；不能把源码 ZIP 下载地址伪装成 GitHub 仓库。
- meta.screenshots：本 Agent 已上传确认的 uuid/path，按当前截图内容核对。

小猫立绘可作为项目视觉材料，但不能替代展示实际功能的运行截图。新截图不能因为旧 upload record 的 confirmed=true 就跳过上传；缓存命中还需相同文件摘要与材料版本。

现有 /api/premium 新增了 PUBLIC_DEMO_URL 对应的 resource 配置，实施时保留这一改动。Demo 部署路径、实际资源地址与客户端请求保持一致，避免支付验证时主机不匹配。

在用户已授权参赛提交的范围内才执行远端写接口；已有明确授权覆盖时不重复索取确认。本次工作为方案整合，未执行这些动作。

## 11 文件安排和配置

建议新增：

~~~text
src/server/nomi/
  db.ts, migrations/             任务与秘密分离的持久数据
  model.ts                       AI SDK 供应商客户端
  coordinator.ts                 每轮模型建议与消息 checkpoint
  executor.ts                    持久工具执行与恢复
  registry.ts                    工具 schema、可用性、价格类型
  tools/search.ts                首个搜索服务
  tools/read-url.ts
  tools/read-file.ts
  tools/image.ts
  tools/artifacts.ts
  tools/browser.ts
  memory.ts
  budget.ts
  payments.ts
  opportunities.ts
src/components/nomi/
  PetStage.tsx, GoalComposer.tsx, TaskTimeline.tsx
  ArtifactViewer.tsx, Receipt.tsx, MemoryPanel.tsx
src/app/
  tasks/[id]/page.tsx
  api/tasks/..., api/artifacts/..., api/internal/worker/...
scripts/
  nomi-worker.mjs                 常驻 worker 启动器
  verify-nomi.mjs                 新目标与恢复验证
  verify-nomi-browser.mjs         新产品浏览器检查
  prepare-nomi-submission.mjs     只生成本地材料
~~~

现有 Mojo 脚本做增量修改，不写一套重复注册、上传和提交逻辑。

拟需的服务端配置：

~~~dotenv
LLM_BASE_URL=实际供应商兼容接口
LLM_API_KEY=服务端密钥
LLM_MODEL=已通过工具调用预检的模型
SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=搜索服务密钥
IMAGE_BASE_URL=实际图像服务
IMAGE_API_KEY=图像服务密钥
IMAGE_MODEL=已通过图像预检的模型
NOMI_DATA_DIR=.local/nomi
APP_BASE_URL=http://127.0.0.1:3143
WORKER_TOKEN=服务端随机凭据
~~~

猫的付款 signer 通过服务端秘密配置或当前专用测试钱包适配器加载，不把密钥传入工具执行容器。Mojo 的 agentSecret 沿用已有 DPAPI 文件，不复制进上述模型配置。

.env.example 只放字段说明；.local 与真实环境配置继续被忽略。当前 Codex 会话的工具和账户不会自动变成新应用的后端配置。

## 12 实施顺序与可检查交付

估算针对一名熟悉 TypeScript/Agent API 的开发者，外部账户、模型与环境可用为前提；属于工作量预算，不是完成承诺。

| 阶段 | 交付 | 验收门槛 | 估算 |
| --- | --- | --- | --- |
| A 服务预检 | 模型工具调用、搜索、图片、文件存储与 Docker 可用性报告 | 真输出样本，明确缺项 | 2–4 人时 |
| B 开放任务骨架 | Task、消息、worker、工具调用持久化、基础成果 | 同一入口完成两类目标，刷新与重启恢复 | 6–10 人时 |
| C 多种成果 | 图片、页面、文件及对应检查 | 第三类目标与一个未预设目标可交付 | 6–10 人时 |
| D 角色与记忆 | 小猫房间、进度、偏好与历史 | 记忆可用可改，动作与事件一致 | 4–6 人时 |
| E 实际采购 | 服务报价、预算、x402、回执与故障恢复 | 一次真实采购，重试无双付 | 4–8 人时 |
| F 参赛准备 | Demo、截图、源码清单、Mojo 材料适配 | 本地材料可审阅，上传与提交结果可读回 | 2–4 人时，加外部等待 |

参赛版本约 24–42 人时。单人可按 3–6 个开发日估算；认领、发布、比赛阶段和审核时间另算。真实外部任务市场、自动协作和长期调度属于在此基础上的下一轮，不伪装成首轮已完成。

今天最值得完成 A/B 的最小可运行部分：用户给开放目标，猫调用至少两种工具，交出实际文件，并且刷新后仍能找到。保留一段真实 x402 采购的演示目标，在 E 阶段完成；不再做只支持起名的业务闭环。

### 验证矩阵

| 场景 | 实际动作 | 必须拿到的证据 |
| --- | --- | --- |
| 任务开放 | 同一个入口输入研究、视觉、页面与清单目标 | 动态工具序列、不同真实成果 |
| 跨任务记忆 | 确认偏好后创建不同任务，再删除偏好 | 正确继承与后续不再检索 |
| 进程恢复 | 在调用准备、结果保存、支付响应阶段中断 | 恢复原调用；无重复收费 |
| 文件隔离 | 第二会话访问第一会话材料 | 拒绝访问 |
| 预算变动 | 工具报价高于预留金额 | 不签名，给出具体变更 |
| 真实交付 | 打开文件、网页、图片和来源 | 文件可用，交互可执行，来源支持结论 |
| Mojo 身份 | 用已授权身份读取 me 与项目 | 认领与归属的实际响应 |
| Mojo 上传 | 申请、PUT、confirm，再改一张截图 | 旧摘要不误命中，新图片有新确认记录 |
| Mojo 错误 | 本地夹具覆盖 400、403、404、409 和成功 | 正确分支，无秘密泄露，无盲目覆盖 |
| Mojo 交付 | 获得授权后提交并读回 | 正确 eventId、项目、截图及 pending 状态 |
| 移动端 | 390px、键盘、减少动态效果 | 无溢出、操作完整、状态清楚 |

保留已有 check/build/smoke 验证；旧脚本页面定位随入口迁移调整，不删付款断言。构建前停止 dev，避免共享 .next。新增 npm 任务时同步 run.ps1 的 ValidateSet。

未实现的 verify-nomi 等命令必须在实施时创建，不能把本文中的拟新增文件写成现成验收结果。外部写接口用本地夹具先验证错误分支，远端提交验收只在实际授权后执行，不通过反复正式投稿测试接口。

## 13 当前事实和未决项

已核实：Mojo Skill 内容；现有项目依赖；三个 Mojo 脚本及源码打包逻辑；旧支付路由；候选 AI SDK 包版本与运行要求；Docker 命令存在。只读检查不能代替功能运行。

尚未核实：模型、搜索和图像账户是否可用；Docker daemon；Mojo 的认领、比赛资格、报名签到和队长状态；当前远端作品；实际 Demo 链接与仓库；当届截止与评分要求。

这些未知不阻止完成本方案，但会阻塞对应实施或提交步骤。外部条件缺失时，继续可独立完成的数据、界面与适配器工作，准确报告具体缺项。

参考：
[Mojo Agent Skill](https://mojo.devnads.com/api/agent/instructions/17/skill.md)、
[AI SDK 工具调用](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)、
[供应商适配](https://ai-sdk.dev/providers/openai-compatible-providers)、
[Brave Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)、
[Monad x402](https://docs.monad.xyz/guides/x402)。
