# Azure OpenAI 用量费用告警平台 RPI 实施计划

> 2026-10-06 按代码/部署模板校准，2026-10-07 更新邮件策略。第 1–6 批及第 7–17 节补充为交付历史，
> 后续用户批准的需求已经覆盖部分最初范围；当前能力以第 6.1 节为准。
> 第七批生产加固/Marketplace 等仍为计划，不从一个健康测试 revision 推断已经完成。
> 2026-10-07 邮件策略：费用恢复只记录，不投递；超限/持续提醒的标题和正文均包含 USD 估算金额。

## 1. 执行模式

采用 RPI（Research → Plan → Implement）手动确认模式。

每个批次：

1. 复用已有研究，只补充当前批次证据不足的问题。
2. 明确 API、数据、UI、基础设施、验收条件和测试方式。
3. 获得批准后只实现当前批次。
4. 完成后提供运行方法、实际结果、未解决问题和下一批建议。
5. 需求或设计需要重大调整时停止实现，等待决策。

## 2. 代码组织

```text
apps/
  web/
    client/              # React + Fluent UI
    server/              # Fastify API 与生产静态文件托管
  jobs/
    authorization-sync/
    usage-collector/
    pricing-sync/
    mail-dispatch/

packages/
  domain/                # 领域状态机与费用逻辑
  schemas/               # Zod API/Blob schema
  azure/                 # Blob、ARM、Monitor、Graph 适配器
  ui/                    # 正式 UI 主题和共享组件

tests/
  fixtures/              # 固定脱敏/虚构响应
  e2e/                   # Playwright 场景；无 packages/testing 包

infra/
  bicep/
  lighthouse/

```

2026-10-07 移交整理已移除早期 mock 原型；正式 UI 位于 `apps/web/client`，不依赖原型。
新合作伙伴安装步骤见 [安装与移交指南](partner-installation.md)。

## 3. 第一批：登录与租户预登记闭环

### 3.1 演示路径

```text
运维用户登录
→ 打开“租户与授权”
→ 预登记客户 tenant ID、名称和小时阈值
→ Fastify 校验请求
→ 保存 configuration/tenants/<tenantId>.json
→ 刷新页面
→ 从 Blob 重新加载并显示该租户
```

### 3.2 范围

- Container Apps Easy Auth / 本地显式开发身份。
- 所有第一版运维用户共享平台租户清单。
- `GET /api/v1/session`。
- `GET /api/v1/tenants`。
- `GET /api/v1/tenants/:tenantId`。
- `POST /api/v1/tenants`。
- `/health/live` 和 `/health/ready`。
- `application/problem+json` 和 correlation ID。
- Blob `If-None-Match: *` 条件创建。
- `configuration/tenants/<tenantId>.json`。
- append-only 配置审计事件。
- 正式 Fluent UI 租户与授权页面。
- 最小 Bicep：VNet、Container Apps infrastructure subnet、Storage Blob Private
  Endpoint、Private DNS、Storage、containers、Web identity、RBAC、ACR、
  Container Apps、Log Analytics/Application Insights。
- Storage 公网访问与 Shared Key 均关闭；Azure 环境不提供公网例外。

### 3.3 认证约束

- 生产环境使用 Container Apps Easy Auth。
- 应用读取 `X-MS-CLIENT-PRINCIPAL-ID`、
  `X-MS-CLIENT-PRINCIPAL-NAME` 和 `X-MS-CLIENT-PRINCIPAL`。
- 外部请求不能直接设置由 Container Apps 注入的受保护身份头。
- 本地仅在显式 `AUTH_MODE=development` 时使用固定开发身份。
- `NODE_ENV=production` 与 development auth 同时出现时拒绝启动。

### 3.4 租户创建规则

- tenant ID 必须是 GUID 并规范化为小写。
- display name 必填并限制长度。
- `hourlyThresholdUsd` 必须大于 0，以十进制字符串保存。
- 状态由服务端固定为 `pendingAuthorization`。
- 授权来源由服务端固定为 `manual-preregistration`。
- 未发现真实 Lighthouse 委派前不能变为 `active`。
- 重复 tenant ID 返回 `409`，不得覆盖旧文档。

### 3.5 验收条件

1. 未认证 API 返回 `401`。
2. 本地开发身份可打开租户与授权页。
3. 有效租户可提交并写入 Blob。
4. Blob 文档符合 schema，状态为 `pendingAuthorization`。
5. 页面刷新后租户仍存在。
6. 重复 tenant ID 返回 `409` 且原文件未变化。
7. 非法 GUID、空名称、零或负阈值返回 `400`。
8. 审计事件包含操作者 object ID 和变更摘要。
9. 生产配置不允许 development auth。
10. Easy Auth 中已分配用户可访问，未分配用户被拒绝。

### 3.6 测试

- Zod schema、金额、GUID、状态和身份解析单元测试。
- Fastify `inject()` API 测试。
- Azurite Blob 条件创建和 round-trip 集成测试。
- append-only audit 集成测试。
- Playwright：登录状态 → 提交 → 列表出现 → 刷新后仍存在。
- Azure smoke test：Easy Auth 和 Managed Identity 写 Blob。

### 3.7 手动门禁

第一批分两个确认点：

1. 本地闭环完成后报告实际结果并停止。
2. 展示 Bicep what-if 和 Entra 配置变化，批准后才部署生产。

## 4. 原批次定义与验收边界

以下保留当时的约定；第 1–6 批已完成，模型限制、指标来源和价格管理等已被后续批准
补充升级。不把“该批次当时不做”的说明解释为当前功能仍不存在。

### 第二批：Lighthouse 授权同步

- 预登记 → 委派 → 同步 → `discovered` → 启用。
- 多客户租户、每租户多订阅。
- `degraded` / `disconnected` 状态。
- 独立 Authorization Sync Container Apps Job，每小时第 10 分钟执行并支持 Web
  手工触发。
- Web identity 只在该 Job 范围获得 Container Apps Jobs Operator。

### 第三批：每日价格自动同步

- 分页获取 Retail Prices。
- 校验通过后自动替换 active。
- 失败保留 last-known-good。
- 90 天历史和 GUI 同步摘要。
- 独立价格 Managed Identity 和私网 Container Apps Job，UTC `0 16 * * *`
  对应北京时间每天 00:00。
- Web 对价格容器只读，手动重试仅能启动固定 Pricing Job，不能覆盖执行模板或价格源。
- 验收：完整分页/单位/币种/基准校验；价格大幅变化自动更新；失败保持 active ETag
  和内容不变；Blob lease 互斥；90 天历史稳定游标分页；无快照与过期状态不伪装为成功。
- 测试：价格规范化和分页单元测试、API 认证/来源/错误测试、Azurite 原子更新与
  并发/失败保护、价格 UI E2E，以及测试环境真实公开价格同步。
- 第三批不执行 deployment 计价、费用采集或邮件；新 meter 原样保留并标记未支持。

### 第四批：单租户费用计算

- AOAI account/deployment 发现。
- input/output metrics。
- 价格匹配与小时费用。
- 费用概览、租户详情和 deployment breakdown。
- 本轮按“无用量链路”验收：不调用模型制造 token，不做正用量金额对照测试；真实用量
  出现后再补计价准确性验证。
- 每小时第 15 分钟读取上一已结束且留出 15 分钟迟到缓冲的小时；第四批仅输出
  `provisional`；按第五批的最新要求，不增加默认历史回补。
- 复用 Collector identity 的 Lighthouse Reader、私网 Blob 和已有价格快照，不发送邮件。
- 仅 `active/degraded` 租户采集；未启用/断开授权保留历史且不伪造新费用。
- 无模型部署、指标请求成功但无用量、采集失败和价格不唯一分开显示。无可信费用为
  `null/—`；可确认的覆盖小计可为零，但 `partial` 不冒充完整租户总额。
- 第四批当时先固定 GPT-4.1/mini/nano、2025-04-14 规则；第 15 节已移除模型/版本
  白名单，第 16 节已改 Models 采集。当前不再因 Luna/Astra/Sol 名称拒绝计价，
  但缺单价/计量/元数据仍明确未知，不宣称已能计算所有未来协议或真实账单。

### 第五批：多租户、多订阅并发与单小时采集

- 租户池默认 8、每租户订阅池默认 8、每订阅 account 池默认 2；HTTP 总预算默认 32。
- 每轮 Metrics 只读上一完整自然小时（PT1H），禁止一次合并 3 小时，不默认回补。
- 资源、模型部署和指标定义缓存两小时；记录独立发现时间，缓存命中仍读取新小时指标。
- 失败隔离、429/Retry-After、有限重试、截止时间和并发峰值监控。
- 支持 1–16 个 tenant-hash 分片，HTTP 总预算分摊，不随分片数无界相乘。
- 分片视图合并为概览；同一 tenant/hour 幂等更新，历史阈值不追溯更改。
- 不凭时间自动把未重读的小时升级为 final；金额准确性仍待真实用量出现后核对。
- 10 天保留。
- 验证包括模拟 300 租户 × 200 订阅、并发上下界、单小时范围、缓存周期、金额归属和失败隔离。

### 第六批：费用告警与邮件

- 首次超限、6 小时提醒和恢复。
- outbox-first saga。
- Graph / Exchange Application RBAC。
- `chx@ms-ext.biz` 发件。
- 单小时、不回补模式下，本轮实现采用新的完整未超限小时触发“估算恢复”，不升级 final；
  partial/failed 不触发恢复。
- 设置默认关闭，收件人为空；不能把原型虚构收件人用于实际发信。
- pending 决策日志先持久化，再建立不可变事件和 Outbox，最后推进告警状态；可重放恢复。
- Graph 202 仅记 accepted；提交超时记 unknown 并禁止自动重发。支持人工核对后重试或关闭。
- 管理员已完成 Exchange 组织前置配置和单邮箱 App RBAC；2026-10-04 已验证真实
  Graph 投递、Exchange `Delivered` 和实际收件，此前授权阻塞已解除。
- 经用户确认，当前测试实例已启用自动告警，统一收件人为 `chx@ms-ext.biz`；
  Blob 配置 revision 2 已读回验证，不补发关闭期间的旧事件。

### 第七批：生产加固

- 生命周期、扩展可观测性和其余 Azure 依赖的私网化。
- CI/CD、OIDC、what-if、回滚和 runbook。
- 7 天邮件 dry-run。
- 生产推广前复核专用发件邮箱及 Exchange 收件限制；当前只有应用端允许域限制，
  未修改现有邮箱的正常邮件规则，不能视为完整生产安全验收通过。

## 5. 计划外内容

- Marketplace offer 正式发布。
- EA/CSP/MCA 实际账单价格。
- Batch、PTU、Realtime、Audio、Image/Video、Fine-tuning。
- 客户直接登录。
- 用户级租户所有权。
- 独立 Action Group/短信/Teams 通知。

## 6. 当前状态

### 6.1 当前实现基线

| 能力 | 当前代码/模板 | 未完成或限制 | 依据 |
| --- | --- | --- | --- |
| 基础设施 | Consumption Web + 四类 Job、Blob JSON、ACR MI pull；private 默认，新增明确选择的 public/MI 新安装模板 | public 为模板级验证，未替合作伙伴真实部署；生产加固/完整恢复验收未完成，无 AKS/数据库/Key Vault 模块 | [main](../infra/bicep/main.bicep)、[安装指南](partner-installation.md) |
| 登录 | Easy Auth + 显式开发身份；已获准用户同等业务权限 | app 创建、secret 保管和用户/组分配须管理员；无 Admin/Viewer 应用权限分层 | [身份解析](../apps/web/server/src/auth.ts)、[配置脚本](../infra/bicep/scripts/configure-entra-auth.ps1) |
| 授权/租户 | Lighthouse、多客户多订阅、预登记可选、发现后显式启用、独立解除、归档/重新授权 | pending 无委派登记可硬删除；没有通用停用/任意软删除 API | [租户 API](../apps/web/server/src/app.ts)、[仓储](../packages/azure/src/index.ts) |
| 指标/缓存 | Models InputTokens/OutputTokens，按部署/模型/版本，精确一小时 PT1H；资源发现 2 小时，分开新旧维度缓存 | 无默认历史回补、自动 final、请求级内容/用户审计；inventory 无版本时间线 | [Source](../packages/azure/src/usage-source.ts)、[存储](../packages/azure/src/usage-store.ts) |
| 价格/计价 | 官方仅 Azure OpenAI/USD，parser 3、compact v2、手动文本 token 缺价；通用无模型白名单、区间估算 | 非 OpenAI 官方价格未自动接入；图片数/秒数/容量/训练等缺计量不盲算 | [price filter](../packages/azure/src/pricing-source.ts)、[schemas](../packages/schemas/src/price-book.ts)、[计价](../packages/domain/src/usage.ts) |
| 历史/补算 | 查询 1–240 小时、原阈值保留；受控单小时只补原缺失真实暂定金额，原 snapshot/before-after 审计 | 不自动重算已知金额、不因新价批量改历史；无 maintenance/migration 通用 CLI | [汇总/补算](../packages/domain/src/usage-summary.ts)、[Job](../apps/jobs/usage-collector/src/index.ts) |
| 邮件 | 下限超限、6 小时提醒；费用恢复仅更新状态/事件，不发邮件；标题/正文含估算金额；Outbox、sender 验证及历史补算标注 | accepted 非 Delivered；unknown 不自动重发；旧待发恢复项也抑制，数据质量通知不变 | [事件](../packages/azure/src/alert-producer.ts)、[投递](../packages/azure/src/mail-dispatch.ts) |
| API/GUI | 四个正式页面、价格/邮件/授权/采集独立状态查询、精简/raw 下载、阈值/名称/手动价侧栏 | 无 operations/issues/runs 通用 API、Marketplace 入口、时区/币种 GUI 修改 | [routes](../apps/web/server/src/app.ts)、[GUI](../apps/web/client/src/App.tsx) |
| 验证工具 | 根 scripts、Vitest、Azurite、Playwright、Bicep/ACR CLI 交付证据 | 无 .github/workflows 或独立 property-based 测试工具；模拟规模不是云 SLA | [命令](../package.json)、[tests](../tests/) |

最新已记录部署为 Web revision `0000020`（第 17 节），Web/Usage/Mail 使用 Models/邮件策略兼容
digest，Pricing Job 可继续使用原兼容版本；不要求四类 Job 在每次滚动发布阶段必为同一
digest。实例中的正式运行限制不代表第七批生产加固已自动完成。

### 6.2 第 1–6 批历史部署与验收

以下按交付先后保留旧 revision、当时租户状态、测试范围和 mail 开关，不能同时当作
“当前 active revision”或当前功能边界。后续补充见第 7–16 节及上面的源码基线。

- 计划已批准。
- 第一批本地闭环已完成。
- 第一批已部署到 `ms-ext` 订阅的 `aoai-cost-alert-test-rg` 测试资源组。
- Azure 部署使用 VNet-integrated Container Apps Environment、Storage Blob Private
  Endpoint 和 Private DNS；Storage 公网访问与 Shared Key 均关闭。
- Entra Easy Auth 已启用，Enterprise Application 要求用户分配，当前仅分配
  `chx@ms-ext.biz`。
- 第二批已部署到 `ms-ext` 测试环境。
- `fte` 订阅 `9654aa88-011f-490e-be5d-6ad3305703b4` 已通过 Lighthouse Reader
  委派给 Collector identity。
- 真实 Authorization Sync Job 已成功发现 1 个客户租户和 1 个订阅，0 错误。
- 第二批本地 E2E 已验证同步、inventory 展开和租户启用；云端租户保持
  `discovered`，等待运维人员确认名称与阈值后手工启用。
- 第三批已完成并部署到同一 `ms-ext` 测试环境，仅价格同步，不进入第四批。
- Pricing Job：`aoai-cost-test-pricing-sync`，UTC `0 16 * * *`，对应北京时间每日 00:00。
- 真实执行 `aoai-cost-test-pricing-sync-et2a3cu` 为 `Succeeded`；读取 24 页、
  23,870 条价格记录，已写入 active 和历史备份，并从 Web 容器的私网连接读回验证。
- 本次真实全量执行约 22 分钟；下载截止为 25 分钟，Job 上限 30 分钟。需要持续观察
  Retail Prices 的耗时，不能将本地下载速度视为云端 SLA。
- 第三批本地端到端测试 17/17 通过，Azurite 集成测试 8/8 通过；云端共享浏览器未由
  自动化操作，登录保护和 Blob 结果通过 CLI/私网只读检查验证。
- 活动 Web revision 为 `aoai-cost-test-web--0000002`，旧 revision 已停用。
- 价格目录不单独承诺 deployment 计价能力；具体匹配结果由费用详情展示。
- 第四批已按无用量场景完成并部署：`aoai-cost-test-usage` 每小时第 15 分钟执行，
  Web revision 为 `aoai-cost-test-web--0000003`。
- 只读执行 `aoai-cost-test-usage-qos5j7v` 成功结束：2 个租户中处理 1 个、跳过 1 个
  未启用租户，发现 2 个资源和 2 个模型部署；输入、输出指标成功返回空用量。
- 已通过 Web identity 私网读回小时 JSON：`activity=noUsage`、`status=partial`、
  已知估算小计为 0、完整总额为 null。原因是现有授权范围缺失，以及两个 GPT-6
  模型的价格规则尚未确认；没有把未计价部分填成零费用。
- 按要求只完成构建和空数据链路验证；正用量计价准确性、实量端到端和回归测试留待
  模型实际产生用量后进行。没有主动调用模型或发送邮件。
- 第五批已部署：租户/订阅/account worker pool 默认为 8/8/2，Usage 管理面 HTTP
  总预算为 32；当前测试环境保留一个分片，支持按配置扩展到 16 个。
- 按最新需求每轮仅查询一个完整小时 PT1H，不读合并三小时，不默认历史回补；资源缓存
  两小时，异常使对应缓存下一轮提前刷新。
- 云端首轮刷新清单耗时约 8.3 秒（6 个管理面/Monitor 请求）；第二次缓存命中后约
  2.7 秒（1 个 Metrics 请求、0 次资源发现），均不含容器启动时间。
- 模拟 300 租户 × 200 订阅、HTTP 上限、金额归属、单小时约束、缓存周期与隔离检查
  通过；Azurite 分片隔离与兼容性检查通过。未生成真实模型用量。
- 运行统计、分片覆盖与轻量概览已接通；当前 Web revision 为
  `aoai-cost-test-web--0000004`。大规模真实 Azure 吞吐仍取决于资源密度、延迟与配额。
- 第六批应用功能、预览及受控真实发信链路已完成测试环境验收。
- 已实现首次超限、6 小时提醒、新完整小时估算恢复、数据质量事件、Outbox 状态、
  settings/收件人管理与人工 unknown 处理。
- 云端 `aoai-cost-test-mail-vvvswer` 成功处理 1 条预览事件，`previewed=1`、
  `accepted=0`；这是最初的预览验收，当时未发送真实邮件。
- 第六批发信验收时 Web revision 为 `aoai-cost-test-web--0000010`，Healthy；
  后续登记删除功能版本见第 9 节。邮件 Job 为 `aoai-cost-test-mail`，每两分钟处理队列。
- 管理员已解决此前 Exchange 组织前置条件；实际核对 `IsDehydrated=false`，
  `Application Mail.Send` 的 scope 只包含 `chx@ms-ext.biz`，`InScope=True`。
- Web 与邮件 Job 的 `MAIL_AUTHORIZATION_READY=true`；后续 Bicep 重部署此实例
  必须保留 `mailAuthorizationReady=true`，不能误用新环境的安全默认值关闭能力。
- 真实执行 `aoai-cost-test-mail-s7qfq4n` 成功，测试事件
  `ee35e8addd7ff30df640c10978ce253a17a7fc64875874efc31ebd4ab3650f17`
  为 `accepted`、`attempts=1`；Exchange trace
  `4587e4e5-1b0b-4012-89bf-08df222da9e0` 为 `Delivered`，接收时间
  `2026-10-04T15:39:22.883Z`，用户也已确认发信正常。
- 已核对持久化配置 `enabled=true`、唯一运维收件人 `chx@ms-ext.biz`、revision 2；
  保持 6 小时提醒与新的完整未超限小时恢复规则，未重发测试或生成模型用量。
- 未授予组织级 Graph Mail.Send/Mail.Read，也未修改邮箱正常邮件的 transport rules。
  完整生产安全验收和有真实用量后的计价准确性仍是独立待验证项。
- 第七批尚未开始。

## 7. 授权撤销与重新接入补充（该次历史记录）

本节最初仅处理客户侧撤销；独立伙伴解除权限由第 8 节后续批准加入，当前已实现，
不再将下面“不新增删除权限”的原验收边界当作当前架构。

- 客户在 Azure Lighthouse 撤销委派，平台经完整授权同步和独立读取核验后自动移出；
  不新增合作伙伴删除委派权限，也不在本轮撤销现有客户授权。
- 移除单订阅仅影响该订阅；全部移出后租户归档到“已解除管理”，原费用历史保留。
- 超时、429、未知权限错误不触发自动移除；可见但 Disabled 的订阅保留状态并停止采集。
- 整个归档租户重新授权后进入待启用；可先重新登记为等待授权，不能手工伪造 active。
- 防止资源缓存、旧概览视图、正在运行的采集和待投递旧邮件把移出对象重新带回。
- 验证使用模拟撤销/重新授权、Azurite 和本地浏览器；实际 Azure 仅做同步与只读验证。
- 已部署，Web revision `aoai-cost-test-web--0000008` Healthy，旧 revision 已停用。
- 云端成功同步 `aoai-cost-test-auth-sync-5znoedk`：已撤销的临时订阅自动移出，`fte`
  继续监控，MCT 的 expected set 为 1 个订阅，授权状态恢复 active；无同步错误。
- 页面 E2E 21 项、API 19 项、领域生命周期 13 项、授权/采集 20 项及持久化集成
  17 项通过。该次授权撤销功能发布未撤销真实客户委派，当时真实邮件仍关闭；
  后续邮件开通状态见第 6 节。

## 8. 独立解除管理身份补充

- 根据后续批准，新增独立 `aoai-cost-test-offboarding-id`，Collector Reader 保持不变。
- Client ID：`bc8b791b-d940-4288-b43e-12c9c024e1a0`；
  Object ID：`b6d610ba-5411-45d0-ac84-295f43265881`，设有 CanNotDelete 保护。
- 新版客户模板保留原 Reader，增加独立身份的 registration-assignment delete role；
  不新增 Owner/Contributor，不授予模型删除、Graph 或 Blob 权限。
- 网页支持范围预览、输入 tenant/subscription ID 确认、逐订阅结果与审计；
  不匹配本应用或包含其他主体/共用授权时拒绝，旧预览不能重放。
- 老客户包括 `fte` 必须由客户管理员重新部署同一套餐的新版模板。云端只读预览已确认
  当前 `fte` 对新身份尚未授权，返回 `CUSTOMER_REAUTHORIZATION_REQUIRED`。
- 此次没有更新或撤销客户实际委派；真实 DELETE 仅通过本地模拟验证。
- 已部署 Web revision `aoai-cost-test-web--0000009`，Healthy。旧版已停用；
  16 项解除边界测试、20 项 API 测试、22 项持久化集成测试和 23 项页面 E2E 通过。

## 9. 等待授权登记删除与运行状态说明修正

- “告警与邮件 Outbox”能力卡去掉“第六批”标签和旧授权阻塞文案，链接设置页查看实际
  发信能力与通知状态，避免开发批次混入业务界面。
- “等待客户授权”租户增加 **删除登记**，确认后直接删除当前
  `configuration/tenants/<tenantId>.json`，不写归档状态；保留审计和既有历史。
- 仅 pending 且无当前/待核验订阅可删除；登录、同源空 JSON、强 If-Match 和租户 lease
  均已接通。授权同步/其他用户改变状态时，拒绝旧版本删除并要求刷新。
- 并发列表读取允许跳过刚被删除的 JSON，不吞掉其他存储错误。同步快照中的已删登记
  若无真实委派就跳过；存在真实委派时重新发现为待配置、待启用，不直接采集。
- 全工作区构建通过，91 项定向领域/API/授权/持久化检查和 15 项浏览器场景通过；
  桌面 1440px、平板 1024px 确认弹窗可见且不溢出。
- 登记删除验收时 Web revision `aoai-cost-test-web--0000011`，Healthy、100% 流量；
  `0000010` 已停用；后续 Web 修复版本见第 10 节。授权同步及用量 Job 使用不可变镜像
  `sha256:2114ba02bdce911912b37cb326639d68740363b4d234ea411558ce3aa208ad3f`，
  没有改变采集计划、并发参数或邮件配置。
- 私网 Blob 真实验证仅创建并删除虚构 pending ID
  `8176e7fa-f403-4d22-ad5f-63b93b07a6e1`；确认当前 JSON 不存在、读回 not found、
  删除审计成功，未删除已有客户登记或 Lighthouse 委派。
- 自动通知保持启用、唯一收件人 `chx@ms-ext.biz`、配置 revision 2；
  真实发信能力保持 true。本次未发送测试邮件、未制造模型用量，未开始第七批。

## 10. 共享 Lighthouse definition 修复与价格目录复核

- 实际 Azure GET 发现 `Pay-As-You-Go-TEMP` 的 assignment 位于 TEMP，引用 `fte`
  的订阅级 definition；两者属于同一客户 tenant，管理 tenant、套餐和两个精确
  principal/role 均正确。旧代码要求 definition 也在 TEMP，导致错误的 0 条匹配。
- 已允许同一已验证客户 tenant 内的订阅级 definition 复用；assignment 仍必须在目标
  订阅，所有身份、套餐、唯一性和确认前 fingerprint 校验保留。只删 assignment，
  不删共享 definition，也不影响 `fte` 的管理关系。
- Azure 包/API 构建及 56 项定向作用域、持久化确认日志和 API 检查通过。
  发布后真实只读预览 TEMP 与 `fte` 均为 `ready`，2 次 GET、0 次 DELETE。
- 共享定义修复验收时 Web revision `aoai-cost-test-web--0000012`，Healthy、100% 流量，
  `0000011` 已停用；镜像
  `sha256:e937df0aa9e5ca4216675d5b5fe074a7378f487afe5f96c02470c097775b743a`。
  没有改动客户委派、后台采集任务、单小时规则或邮件配置；自动通知仍启用到
  `chx@ms-ext.biz`，revision 2，发信能力 true。
- 2026-10-05T02:04:25Z 完成新的 Retail Prices 全量读取：24 页、23,870 条。
  精确 `6-luna` SKU 有 312 条，其中 Sweden Central 有 16 条；对应 GlobalStandard
  的 Standard Global 普通输入/输出每百万 token 为 ShortCo USD 0.10/0.50、
  LongCo USD 0.20/0.75，另有缓存读取/写入 meter。现有活动快照已包含这些价格。
- 未找到精确 `6.1-sol` SKU，不能未经证实套用 `6-sol` 价格。新记录的 serviceName
  是 `Foundry Models`，手工查询限定 `Cognitive Services` 会漏掉这些 meter。
- 本轮价格工作是目录核实，不启用猜测计价；当前代码只有已验证的 GPT-4.1 规则，
  Luna 的上下文/缓存写入档位仍待适配，6.1-Sol 的价格/别名仍待证实。

## 11. 邮箱输入、SKU 下载与管理中租户编辑

- 发件邮箱从只读部署显示改为可编辑，保存到 `configuration/alerting.json`；
  初始部署邮箱兼容既有授权，更换地址自动关闭通知。新地址需 Exchange 单邮箱授权，
  真实 Graph 接受测试后才能明确启用，验证记录绑定专用 Mail identity。
- 收件允许域及邮箱权限不在 GUI 扩大；Web、Collector、Dispatcher 全部使用保存后的
  发件地址。当前 `chx@ms-ext.biz`、收件人、自动通知开关和历史邮件不迁移、不清理。
- 当前价格完整 JSON 可在设置页下载，文件名 `aoai-pricing.json`；包括所有 SKU/meter
  原始与规范化条目及快照元数据。登录保护、ETag 固定版本、私网流式读取，缺失/
  存储失败有明确错误，不返回空文件、不暴露 SAS。
- 管理中非归档租户可在列表或详情修改名称、USD/小时限额；强 If-Match、租户 lease
  与审计保护并发更新，不能从该 API 改授权/状态。当前概览叠加新配置，历史小时
  阈值保留，新计算窗口才使用新值，同小时重算也不追溯更改。
- 全工作区及 Bicep 编译通过；62 项邮箱/下载检查、58 项租户编辑/历史/API 检查、
  20 + 14 项浏览器场景通过，1440/1024/320px 设置页无横向溢出。
- 当前 Web revision `aoai-cost-test-web--0000013`，Healthy、100% 流量；
  `0000012` 已停用。Web/用量/Mail Job 镜像：
  `sha256:60e38c644aad93a37ced7b8779e36ecec5dabee95d94b6e3e8bb319d2991d75e`。
  Web 新增与既有专用 Mail identity 的 client ID 绑定；没有新增角色或修改定时计划。
- 云端验证价格文件 24,883,951 字节、23,870 条，匿名下载 HTTP 401；
  当前邮件配置仍 revision 2、发件/收件 `chx@ms-ext.biz`、自动通知 true。
  MCT 名称和当前 USD 1.00/hour 限额仅做读回/no-op 检查，没有替用户改值。
- 按追加请求，功能完成后再独立确认 `fte` 四个部署授权与价格，受 USD 1–2 预算控制
  生成真实用量并核对对应完整小时告警；这不是用模拟邮件代替费用超限验收。

## 12. USD 1–2 真实告警测试的前置核查（当时暂停记录）

本节保留 2026-10-05 暂停时的事实；2026-10-06 用户重新批准剩余三个模型请求，
实际预算测试及金额补算/邮件结果见第 15 节。不能据本节推断当前还没有真实用量。

- 已按请求通过 `az account list` 确认客户 `fte` 订阅的 CLI 授权；只读访问
  `aoai-fte-chx` 成功，当前四个 GlobalStandard 部署为 `gpt-6.1-sol`、
  `gpt-6-luna`、`gpt-6-astra`、`gpt-5.6-sol`，均为 Succeeded，额度分别为
  150 RPM / 150,000 TPM。
- 当前平台只有已验证的 GPT-4.1 计价适配，上述四个模型均尚未进入支持规则。
  仅制造 token 用量不会自动形成可验证的费用超限，不能把数据质量邮件当作费用告警。
- 2026-10-05T04:04:34Z 又在所有公开服务/产品组中查询 `6.1` 标签，完整一页返回
  0 条，仍不能证实 `gpt-6.1-sol` 的美元单价或与 `6-sol` 的映射。
  客户侧 model/SKU API 的 `cost` 为 null，`costs` 只提供 offering ID 与 token 单位，
  没有可直接用于预算的单价；不能把 null 当成免费。
- 在用户追加的 USD 2 上限下，尚无可靠的全模型预算核算与应用计价规则，因此没有
  发出付费推理请求、没有制造虚构费用或告警。GUI 功能已交付，真实费用测试受此前置
  条件阻塞；须先确认价格映射和上下文/缓存规则，或明确改用已有支持规则的部署测试。
- 用户随后明确暂停发送测试数据；所有付费模型调用保持暂停，未经新请求不恢复。

## 13. 下载价格 JSON 的模型名称修正

- 已复现 v1 目录只有 673 条能识别模型，23,197 条 `modelName=null`；根因是把目录
  描述解析限制在已验证 GPT-4.1 计价语法，不能因此声称未知模型没有价格。
- v2 分离 descriptive canonical model names 与计价支持，覆盖实际 SKU 中 GPT5/6、
  compact aliases、媒体、推理、OSS、embedding 标签；顶层 `models` 为名称索引。
  共有 1,475 个 SKU/product 标签，1,458 个明确属于模型，其余 17 个通用服务标签不猜名。
- `modelIdentityStatus` 明确 identified/shared-service/unidentified。保留原始 SKU、单价、
  区域、单位；新增名称不升级 supportStatus，不新增未经验证的计价规则。
- v1/v2 快照读取兼容；存储目录可只重做描述元数据，备份先于 ETag 条件发布，并保留
  原真实下载时间、记录来源及归一化时间。普通每日同步仍使用 Retail Prices。
- 全工作区构建、120 项定向检查、3 项下载浏览器场景通过。当前 Web revision
  `aoai-cost-test-web--0000014` Healthy、100% 流量，`0000013` 已停用；
  Web/Pricing/Mail/Usage 镜像
  `sha256:a197bd421bb32bff2a1b100fa92363748c0650a41fa78ff4bfd343aef3a937c3`。
- 实际活动文件 parser 2，89 个模型索引、23,527 条 modelName、343 条通用服务、
  0 条无法解释的模型缺名；完整 JSON 25,931,946 字节。示例 `gpt-6-luna` 对应
  `6-luna ShortCo Inp Std Gl`，USD 0.10/1M token，原始价格保留。
- 活动 snapshot `cd43d7bd-1999-4926-87f1-20ba706c57f0` 由真实 Retail Prices
  同步发布，fetchedAt `2026-10-05T04:53:17.375Z`；完整 execution template 的
  metadata-only 检查 `aoai-cost-test-pricing-sync-k6lu9e2` Succeeded、changed=false。
  一次性 metadata flag 没有写入计划任务，原 cron 未改变。
- 发件 `chx@ms-ext.biz`、邮件启用和 revision 2 未改；没有恢复模型测试或新增推理费用。

## 14. 精简查询价格与手动缺价备用

- 小时计价切换到私有 `pricing-current/compact/<snapshotId>.json`；原始 active 和
  90 天审计备份保留。默认下载 `aoai-pricing.json` 精简目录，另有
  `aoai-pricing-raw.json` 完整原始/审计下载，两个入口均登录保护。
- 真实快照 25,931,946 字节缩减到导出 1,928,511 字节，减少 92.56%；2,219 个
  token 价格组、72 个模型、19,566 个区域/meter 源引用。非 token、训练和通用服务
  仍在原始 89 模型目录，不伪装成可用于普通 token 估算的价格。
- 单价统一 USD/百万 token；只合并同价同条件区域，按模型/SKU/区域选择最新已生效
  日期。不提前用未来价；价格刚生效时仅保留尚待计算完整小时所需的前一价，午夜
  切换前后小时分别使用各自最新有效单价，不保留全部历史日期在常用查询目录。
- 手动文本模型统一输入/输出估算，默认指定区域，可明确全部区域、可选版本和来源
  备注。新增/编辑/停用均强 ETag + lease + 版本化 JSON 审计，下一完整小时生效。
  官方相同范围存在时始终优先，未验证官方规则继续 unsupported，不能手动绕过。
  费用详情和邮件保留/披露手动规则 ID、版本、快照；不修改旧小时金额。
- 已执行 203 项定向 domain/Blob/API 检查、25 个浏览器场景、1440/1024px 界面
  核验及工作区构建/typecheck。逐条核对全部保留源价格，171 组已支持
  GPT-4.1 模型/SKU/区域费用与 raw 路径零差异。独立本地解析+校验中位数
  231.2 → 24.9ms；不是 Azure 并发吞吐承诺。
- metadata-only bootstrap `aoai-cost-test-pricing-sync-y41qm7w` Succeeded，
  不改变 `cd43d7bd-1999-4926-87f1-20ba706c57f0` 或真实下载时间
  `2026-10-05T04:53:17.375Z`；一次性 flag 不在定时模板中。
- 最终镜像正常采集 `aoai-cost-test-usage-jkauci4` Succeeded，成功完成
  13:00–14:00 UTC 单完整小时，持久化 rule version 2；没有 PRICE_READ_FAILED，
  警告仅为原有未验证模型映射。没有推理调用、没有发测试邮件。
- 云端手动配置 revision 0、0 条规则，未录入任何示例或未经用户确认单价。
  `chx@ms-ext.biz` 发件/收件、启用 revision 2、个人租户 USD 1/小时限额、
  计划和专用身份均已读回核对未改；付费模型测试保持暂停。
- 最终 Web `aoai-cost-test-web--0000016` Healthy、100% 流量，14/15 已停用。
  Web/Pricing/Usage/Mail 共享不可变镜像
  `sha256:6e754628a94a17f1d60c07d3a8cb7d89352b51aa74e3fa323bd06e3e74c1bf94`；
  ACR build `dtj` 通过。匿名精简下载及手动设置均 HTTP 401，没有开放 Blob 公网。

## 15. 通用模型计价适配与真实用量补算

- 移除 GPT-4.1/固定版本白名单，parser 3 从实际 SKU 格式生成 token 单位、方向、
  上下文、模态、版本提示、区域和服务档位。符合相同协议的新模型自动接入，不逐个
  编写模型名分支；未知单位/新协议缺少对应用量时明确异常、不盲猜。
- 实际 23,870 行目录覆盖 85 个可查询 token 计价模型，20,765 条区域源价格逐条核验
  无差异；精简 schema 2 约 2.16 MB，原始审计及真 `fetchedAtUtc` 保留。
  已下载的未来生效价按目标小时自动启用，不提前也不晚一轮每日刷新。
- 小时聚合无法分辨的上下文/模态/缓存写入保存为可解释区间，不把小时 token 总量
  当作一条请求。UI/曲线/邮件一致；下限超限才费用告警，新完整小时上限也未超限才恢复。
- 新增受控单小时缺价补算，原 snapshot、token、采集时间、阈值不变，已有可信/已确认
  金额不覆盖。before/after 审计和 event ID 幂等；历史补算事件不回退当前告警状态。
  若当前邮件设置是在该小时之后才启用，则记录抑制，不补发关闭期间历史邮件。
- 130 项 domain、39 项 Blob、55 项 API、16 项并发/历史及 28 个浏览器场景通过；
  构建/typecheck 和 1440/1024px 区间界面验证通过。生产普通无数据小时空分组默认档位
  已修正并补测试；最终普通采集 `aoai-cost-test-usage-tviuluv` succeeded、零问题。
- Web `aoai-cost-test-web--0000018` Healthy、100% 流量，16/17 停用；
  Web/Pricing/Usage/Mail 镜像
  `sha256:4c6842be448fa920fb07b309bd48d078ca20f6566df92d630f6d5ea3176c6a22`，
  ACR `dtm` 成功。身份、原 cron、sender/recipients、启用 revision 2、阈值 USD 1、
  手动价 revision 2 均读回核对未改；一次性 flags 不在计划模板中。
- 测试09:00–10:00小时已按原快照补算 USD 1.739502–2.680713，token仍为2,835/37,785。
  audit `02d84eb7-5a8d-40ca-ba6c-091b60e84030`；真实历史超限 Outbox
  `f63c2a575fd47a511587fbc826e469159a658b66db770e283fb3f3f9998284a3`
  Graph accepted、1次提交，发件/收件 chx@ms-ext.biz，未独立声称 Delivered。
  不再调用模型；单次请求证据仍为无缓存、短上下文 USD 1.739502，区间上限不是额外费用。

## 16. Models - Usage 指标迁移（不扩展价格目录）

- 正式采集从 `ProcessedPromptTokens/GeneratedTokens` 切换到
  `InputTokens/OutputTokens`，要求部署、模型名、模型版本维度；不根据 deployment
  自定义名称猜模型、不静默回退旧指标、不重复累加两组 token。
- `OpenAI/AIServices` 和非空 provider format 可保留 Models 用量；非 OpenAI 模型
  缺价显示“—”，后续可填手动价。官方 API 过滤仍仅 Azure OpenAI，未增加其他模型单价。
- `modelsMetricDimensions` 与旧维度缓存独立，baseline inventory JSON 保持旧版可读；
  资源发现仍两小时，新小时标注 `metricFamily=models-usage`，旧历史不重写。
- Models token 指标未给出实际档位时不假定 Standard，使用既有适用价位范围并说明原因。
  不改变既有价格、阈值、邮件/手动设置或超限/恢复策略。
- 68项 domain、13项 Source/并发、28项 Blob缓存/历史/邮件、55项 API、14项浏览器
  场景及工作区 build/typecheck 通过。xAI/AIServices 缺价与之后手动价回退有 mock 契约测试。
- Collector 身份只读探测 `aoai-cost-test-usage-4pzr4if` succeeded，断言09:00测试小时
  Models计数与已有请求账本逐模型/版本完全一致（2,835 / 37,785），未写用量或价格。
  普通 `aoai-cost-test-usage-him0fw0` succeeded、零问题，当前小时确已保存新口径。
- Web `aoai-cost-test-web--0000019` Healthy、100%流量；Web/Usage/Mail镜像
  `sha256:4cb8cb7816f81075b4abf0004e4a2b31eabe5b86279b3f525fa6b5cb507ed168`，
  ACR `dtn`。Pricing Job及价格Blob ETag未改，manual/mail/tenant与旧测试小时哈希未改。
  原cron/身份保留；无新推理、无测试邮件、无其他provider价格插入。

## 17. 费用恢复邮件关闭与超限金额摘要（2026-10-07）

- 费用恢复仍按新完整小时及已知估算上限判断，并保存 normal 状态和历史事件；新
  `cost-recovered` Outbox 直接归档为 suppressed，原因 `COST_RECOVERY_EMAIL_DISABLED`。
  不再发送费用恢复邮件，下一次超限仍立即生成首次告警，数据质量异常/恢复通知不变。
- Dispatcher 提交前使用同一策略阻止旧 pending/未开始提交的过期 claim；已经提交的
  unknown 仍保留人工核验流程，不能冒充未发送或撤回 accepted 邮件。
- 超限与持续提醒的标题及正文摘要包含 USD 估算金额/区间、小时阈值、北京时间窗口和
  中文数据状态。去掉长尾零和恢复规则说明；partial、缺金额及未知上限不伪装为完整费用。
  历史手动快照只说明引用及官方优先策略，不仅凭旧引用声称已使用手动单价。
- 45 项状态/区间/模板单元测试、21 项 Blob 邮件集成、55 项 API、1 项浏览器
  设置/预览场景通过；最终邮件文案与集成共 30 项复验通过，相关 typecheck/工作区 build 通过。
- Web `aoai-cost-test-web--0000020` Healthy、100% 流量，Web/Usage/Mail 使用
  `sha256:926e14b262e18bb546739ad8b8bec0cd1b303c11ba793e714cf301c40edef4e4`
  （ACR `dtq`）。先更新 Mail 再更新 Usage；cron、身份、环境参数和资源配置指纹未改，
  Pricing/Authorization Job 保持原镜像。
- 私网只读验证部署后的模板和恢复抑制策略；原 00:00–01:00 超限事件预览显示
  `USD 1.13912–1.856737`，金额在标题及正文摘要中。邮件 Job 正常计划执行 succeeded，
  0 失败/unknown；配置、价格 ETag、原测试小时及已接受事件保持不变。
  本次调整未发送测试邮件，也未产生新模型调用。
