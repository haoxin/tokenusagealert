# 合作伙伴安装与移交指南

适用版本：2026-10-07 的正式产品代码。目标是让合作伙伴在**自己的 Entra 租户、Azure
订阅和 Microsoft 365 邮件组织**安装一个独立实例，而不是接管原测试实例。

本文命令不会自行执行。Azure 部署、客户授权和邮箱授权必须由对应管理员审批。
请在含有 `package.json` 的项目根目录操作；Bash 和 PowerShell 示例分开执行。

## 1. 部署方案与改动评估

当前测试实例已经使用 **Container Apps Consumption workload profile**，并非 Dedicated。
原方案额外配置了 VNet、Blob Private Endpoint 和 Private DNS。

新增简化方案不需要改采集、计价、Blob JSON、GUI 或告警业务逻辑。主要改动是 Bicep
网络条件和合作伙伴邮箱参数，属于小范围基础设施适配。

| 项目 | 简化方案：`storageAccessMode=public` | 原方案：`storageAccessMode=private` |
| --- | --- | --- |
| 推荐用途 | 合作伙伴首个独立实例，政策允许公网数据端点 | 有私网/网络隔离要求 |
| Container Apps | Consumption，Azure 默认网络 | Consumption，客户 VNet 集成 |
| Blob 网络 | 公网 HTTPS 端点，允许网络连接 | 公网关闭，Private Endpoint + Private DNS |
| Blob 数据授权 | 托管身份 + container-scope RBAC | 相同 |
| 匿名访问 / 存储密钥 | **均关闭** | **均关闭** |
| Web 登录 | 单租户 Entra Easy Auth、运维用户分配 | 相同 |
| 持久化 | Blob JSON；无需数据库、AKS 或持久磁盘 | 相同 |

**公网端点不等于公开数据。**所有 Blob container 仍为 `publicAccess=None`；没有数据角色
的用户不能读写。Storage `allowBlobPublicAccess=false`、`allowSharedKeyAccess=false`，
不使用存储密钥、connection string 或 SAS。公网方案减少网络组件，但不能代替私网的网络隔离。

模板默认仍是 `private`，因此旧实例不会因默认值而开放公网。简化方案必须显式选择，
使用新资源组/新前缀安装。**不要在已有实例上直接切换该参数**：Container Apps 网络类型
不能原地更换，且同名 Storage 的网络策略可能被修改。迁移旧实例需要单独方案。

### 成本边界

- Consumption 是按使用计费，不是免费；Web 当前最少 1、最多 3 个副本，保留常驻副本。
- 四类 Job 按计划启动；Storage ZRS、版本/软删除、ACR Basic、日志等另有费用。
- public 方案不创建本项目的 VNet/Private Endpoint/Private DNS，不部署 Dedicated profile。
- 平台显示的模型费用是 USD 零售价估算，不是平台基础设施费用，也不是客户实际账单。
- 本次模板已编译并做配置契约检查；新合作伙伴环境仍需执行自己的 what-if、部署和验收。

## 2. 安装前准备

### 2.1 管理员与权限

| 工作 | 需要的身份/权限 |
| --- | --- |
| 创建平台资源和 RBAC | 合作伙伴订阅 Owner，或 Contributor 加足够的角色分配权限 |
| 注册 Web 登录应用、分配用户/组 | 合作伙伴 Entra 应用管理员及相应企业应用管理权限 |
| 配置单邮箱发信 | 合作伙伴 Exchange 管理员及相应 Organization Management 权限 |
| 委派客户订阅 | **客户**订阅 Owner 或等效 Lighthouse 部署/授权权限 |

Azure 订阅 Owner 不自动等于 Entra 或 Exchange 管理员。Web 用户、客户读取身份、邮箱
身份是不同的授权边界。不要使用原实例的 tenant ID、client ID、identity object ID 或邮箱。

准备以下信息：

- 合作伙伴 Entra tenant ID 和平台 Azure subscription ID；
- 新资源组名称、区域、3–18 字符的小写资源前缀；
- 一个属于该合作伙伴 Microsoft 365 组织的 Exchange Online 发件邮箱；
- 运维收件人及允许收件域；
- 允许登录后台的运维用户/组；
- public/private 方案选择，以及 Azure Policy 是否允许所选网络配置。

一个实例支持多个客户租户，每个租户支持多个**明确委派的订阅**。第一版运维用户共享
全部租户清单，没有按运维用户隔离客户或客户自助门户。

### 2.2 工具

- Azure CLI，包含 `containerapp` 扩展和可用的 Bicep CLI；
- Bash（Linux、macOS 或 Windows WSL）用于部署示例；
- PowerShell 7 和 `ExchangeOnlineManagement` 用于登录/邮箱脚本；
- 源代码交付包或已获准访问的 Git 仓库。

检查/准备工具：

```bash
az version
az extension add --name containerapp --upgrade
az bicep version
```

生产镜像可由 `az acr build` 远程构建，安装机不必运行 Docker、Node.js 或 pnpm。
本地开发/测试才需要 Node.js 24、pnpm 12.6。

### 2.3 登录并确认作用域

以下值全部替换为本合作伙伴的信息；变量只在当前终端有效。

```bash
set -euo pipefail
PARTNER_TENANT_ID="替换为合作伙伴租户GUID"
SUB="替换为合作伙伴平台订阅GUID"
RG="aoai-partner-rg"
LOCATION="swedencentral"
DEPLOYMENT="aoai-partner-platform"
PARAMS="infra/bicep/partner.parameters.local.json"

az login --tenant "$PARTNER_TENANT_ID"
az account set --subscription "$SUB"
az account show --query '{tenantId:tenantId,subscriptionId:id,name:name}' -o json
```

确认输出与预期完全一致。示例 `swedencentral` 与 Storage ZRS 配置兼容；更换区域前确认
Container Apps、Jobs、ACR、Log Analytics 和 ZRS 可用性及订阅配额。

管理员可检查/注册需要的 resource providers：

```bash
for PROVIDER in Microsoft.App Microsoft.Storage Microsoft.ContainerRegistry \
  Microsoft.ManagedIdentity Microsoft.Network Microsoft.OperationalInsights Microsoft.Insights
do
  az provider register --subscription "$SUB" --namespace "$PROVIDER" --wait
done
```

## 3. 参数与两阶段部署

### 3.1 复制并填写参数

```bash
cp infra/bicep/partner-public.parameters.example.json "$PARAMS"
```

编辑复制的 JSON，而不是修改公共示例：

| 参数 | 应填写的值 |
| --- | --- |
| `location` | 与安装区域一致 |
| `namePrefix` | 新实例前缀，例如 `aoai-partner`；不要复用原测试前缀 |
| `storageAccessMode` | `public`；需要原配置时改为 `private` |
| `mailSenderMailbox` | 自己的实际邮箱，例如 `aoai-alerts@your-company.com` |
| `mailAllowedRecipientDomains` | 自己的允许域数组，例如 `["your-company.com"]` |
| `mailAuthorizationReady` | 安装初期必须为 `false` |
| `deployWebApp` / `containerImage` | 第一阶段 `false` / 空字符串 |
| `existingStorageLifecycleRules` | **全新 Storage** 为 `[]`；已有账号必须先读出现有完整规则 |
| `tags` | 自己的环境、负责人等信息 |

`partner.example` 不是可发送邮件的真实组织地址，必须替换。邮箱域参数同时传给 Web、
Collector 和 Mail Dispatcher，不能只改 GUI 或其中一个 Job。
`usageShardCount=1`、并发 8/8/32 可用于初始安装；规模增大前再做真实容量评估。

私网参数另有 [prod.bicepparam.example](../infra/bicep/prod.bicepparam.example)作为参考。
本文两种模式均使用相同的 JSON 参数文件和部署命令，只有网络参数不同。

### 3.2 第一阶段：建立身份、Storage、ACR 和环境

此流程只适用于**新实例**。如果资源组/账号已经属于一个运行实例，停止并先看第 9 节。

```bash
az group create --subscription "$SUB" --name "$RG" --location "$LOCATION"

az deployment group what-if --subscription "$SUB" --resource-group "$RG" \
  --name "$DEPLOYMENT" --template-file infra/bicep/main.bicep \
  --parameters "@$PARAMS" deployWebApp=false

# 审核 what-if 后，才执行：
az deployment group create --subscription "$SUB" --resource-group "$RG" \
  --name "$DEPLOYMENT" --template-file infra/bicep/main.bicep \
  --parameters "@$PARAMS" deployWebApp=false
```

what-if 审核点：

- public 模式没有本项目 VNet、Private Endpoint 或 Private DNS；
- Storage 公网配置与选择一致，但匿名访问和 Shared Key 始终关闭；
- ACR admin user 关闭；五个分离的托管身份和 container-scope RBAC；
- 不创建客户模型资源，也不把 Contributor/Owner 给客户读取身份；
- 第一阶段没有 Web 或四类执行 Job，未开启邮件。

读取部署输出：

```bash
az deployment group show --subscription "$SUB" --resource-group "$RG" \
  --name "$DEPLOYMENT" --query properties.outputs -o json

ACR=$(az deployment group show --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --query properties.outputs.registryName.value -o tsv)
STORAGE=$(az deployment group show --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --query properties.outputs.storageAccountName.value -o tsv)
```

保存非敏感输出供后续使用。Collector/offboarding 的 **principal/object ID** 是客户委派
使用的身份；client ID 用于程序选择托管身份。不要混用，也不要把 Web 登录 App ID 当成 Collector。

### 3.3 构建本合作伙伴的镜像

```bash
TAG="partner-install-$(date -u +%Y%m%d-%H%M%S)"
az acr build --subscription "$SUB" --registry "$ACR" \
  --image "tokenusagealert-web:$TAG" --file apps/web/Dockerfile .

DIGEST=$(az acr repository show --subscription "$SUB" --name "$ACR" \
  --image "tokenusagealert-web:$TAG" --query digest -o tsv)
LOGIN_SERVER=$(az acr show --subscription "$SUB" --name "$ACR" \
  --query loginServer -o tsv)
IMAGE="$LOGIN_SERVER/tokenusagealert-web@$DIGEST"
printf '%s\n' "$IMAGE"
```

只有构建成功且 digest 为实际 `sha256:...` 时继续。部署使用不可变 digest，不用 `latest`，
也不引用原合作伙伴 ACR。镜像内包含 Web 及四类 Job，不需要分别打包。

### 3.4 第二阶段：启用 Web 与 Jobs

```bash
az deployment group what-if --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --template-file infra/bicep/main.bicep \
  --parameters "@$PARAMS" deployWebApp=true containerImage="$IMAGE"

# 审核后：
az deployment group create --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --template-file infra/bicep/main.bicep \
  --parameters "@$PARAMS" deployWebApp=true containerImage="$IMAGE"

WEB=$(az deployment group show --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --query properties.outputs.containerAppName.value -o tsv)
FQDN=$(az deployment group show --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --query properties.outputs.containerAppFqdn.value -o tsv)
PUBLIC_URL="https://$FQDN"
printf '%s\n' "$PUBLIC_URL"
```

将 `deployWebApp=true` 和该 `containerImage` 保存回本地参数文件，避免下次操作误用 bootstrap
参数。此时**还不能接入客户或把后台交给用户**：立即完成下一节登录保护，并确认拒绝匿名访问。
邮件保护仍为 false。

## 4. 配置后台 Entra 登录

### 4.1 注册应用

在合作伙伴 Entra 管理中心：

1. **应用注册 → 新注册**，选择本组织目录用户（单租户）。
2. 添加 **Web** 重定向 URI：`https://<实际FQDN>/.auth/login/aad/callback`。
3. 保存 application/client ID、tenant ID。
4. 创建 client secret，安全保管其**值**及到期时间，不是 secret ID。
5. 在对应**企业应用**开启“需要分配用户”，分配获准运维用户/组。

按组分配可能需要 Entra 许可；首次可使用明确的个人用户分配。不要把客户用户分配为
后台用户来替代 Lighthouse 授权。

### 4.2 使用已有脚本

在 PowerShell 7 终端重新确认 Azure CLI 上下文；不要假设另一个 Bash/Cloud Shell 的登录
和变量在这里存在。用本合作伙伴值替换下方占位符：

```powershell
az login --tenant "<合作伙伴tenant-ID>"
az account set --subscription "<平台subscription-ID>"

$secret = Read-Host "输入 Web 登录应用的 client secret 值" -AsSecureString
./infra/bicep/scripts/configure-entra-auth.ps1 `
  -ResourceGroup "aoai-partner-rg" `
  -ContainerAppName "aoai-partner-web" `
  -TenantId "<合作伙伴tenant-ID>" `
  -ClientId "<Web应用client-ID>" `
  -ClientSecret $secret
$secret = $null
```

脚本接收已有 app/secret，不创建 Entra app、用户分配或 Key Vault。CLI 失败会报错，
不能把“脚本已运行”当作登录已受保护。不要开 debug 日志、保存 secret 到 Git/参数文件/
聊天，或把含 secret 的命令输出交付给客户。

### 4.3 验证登录保护

- 未登录浏览器访问网站应进入 Entra 登录或被拒绝；
- 已分配运维用户可登录；未分配用户不能访问；
- 无凭据请求 `/api/v1/tenants` 必须为 401 或登录跳转，不能返回客户 JSON；
- `/.auth/logout` 可退出；使用无痕窗口验证匿名和未获准用户。

在 Bash 中可检查匿名 API：

```bash
curl --silent --show-error --output /dev/null --write-out 'HTTP %{http_code}\n' \
  "$PUBLIC_URL/api/v1/tenants"
```

**如果返回 200，停止接入，先修复 Easy Auth。**外部 health URL 也可能被 Easy Auth 拦截；
检查健康状态应看 Container Apps revision/probes，不要因此关闭认证。

## 5. 生成客户 Lighthouse 接入材料

每个客户订阅各部署一次。Collector 只读资源/Monitor；独立 offboarding 身份仅获
`Managed Services Registration assignment Delete Role`，不会删除客户模型或业务资源。

从本合作伙伴部署输出取值：

| 输出 | 用途 |
| --- | --- |
| `collectorIdentityPrincipalId` | 客户 Reader 委派的 object ID |
| `offboardingIdentityPrincipalId` | 客户解除管理委派的 object ID |
| 合作伙伴 Entra tenant ID | `managedByTenantId` |

参数模板 [subscription.parameters.json](../infra/lighthouse/subscription.parameters.json)故意保留
占位符，不包含原实例身份。填入三个实际值后保存为
`infra/lighthouse/subscription.parameters.local.json`，不要分发未填写的模板。

把以下两个文件交给客户：

1. [subscription.json](../infra/lighthouse/subscription.json)：订阅级 ARM 模板；
2. 填写后的本合作伙伴参数文件。

客户通过 **Azure Lighthouse → 服务提供商 → 服务提供商套餐 → 通过模板添加**
上传模板和参数，在选定客户订阅审阅并创建。完整步骤见
[Lighthouse 接入说明](../infra/lighthouse/README.md)。

客户也可在自己的 Azure CLI 上下文中部署：

```bash
az login --tenant "<客户tenant-ID>"
az deployment sub what-if --subscription "<客户subscription-ID>" \
  --location swedencentral --name aoai-cost-lighthouse \
  --template-file infra/lighthouse/subscription.bicep \
  --parameters managedByTenantId="<合作伙伴tenant-ID>" \
    collectorPrincipalId="<Collector object-ID>" \
    offboardingPrincipalId="<Offboarding object-ID>"
```

客户批准后将 `what-if` 换为 `create`。多个订阅逐个重复；不要在合作伙伴订阅部署一次后
以为取得客户全租户权限。已有客户更新委派时保留原 offer/Collector/definition，不创建重叠套餐。

**稳定性要求：**客户委派引用身份 object ID。删除再创建同名托管身份会得到不同 ID，需要
客户重新授权；资源组/身份不可随意重建。模板保护 offboarding 身份；Collector 的删除保护
需要管理员另行落实，并记录恢复与重新授权方案。

## 6. 授权邮件与启用通知

平台采集与邮箱授权互不依赖；未授权邮件时仍可查看费用。这里只适用同一合作伙伴
Microsoft 365 组织的 Exchange Online 邮箱，不使用个人 SMTP/邮箱密码。

### 6.1 Exchange 组织前提

在 PowerShell 7 管理员终端：

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser -Repository PSGallery
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -UserPrincipalName "<本组织Exchange管理员邮箱>" -ShowBanner:$false
Get-OrganizationConfig | Format-List IsDehydrated
Disconnect-ExchangeOnline -Confirm:$false
```

如果 `IsDehydrated=True` 或创建 scope 时要求组织自定义，先取得组织管理员批准，再执行
`Enable-OrganizationCustomization`；这是组织级变更，不是普通网页设置。

### 6.2 单邮箱 App RBAC

使用部署输出中的 `mailIdentityClientId` 和 `mailIdentityPrincipalId`：

```powershell
./infra/bicep/scripts/configure-mailbox-rbac.ps1 `
  -ApplicationId "<mailIdentityClientId>" `
  -ServicePrincipalObjectId "<mailIdentityPrincipalId>" `
  -SenderMailbox "aoai-alerts@your-company.com" `
  -AdminUser "<本组织Exchange管理员邮箱>" `
  -ScopeName "aoai-partner-sender"
```

脚本只配置 `Application Mail.Send`，并确认 scope 只含指定发件邮箱。成功必须看到
`ScopedMailSend: true`；否则保持真实发信关闭，排查授权/传播延迟。

**不要添加全组织 Graph `Mail.Send` 或 `Mail.Read` 代替单邮箱授权。**
App RBAC 限制发件邮箱，不限制收件人；应用的允许域校验不是 Exchange transport rule。
生产推广前另行审核专用邮箱和收件限制，不自动给已有个人业务邮箱套全局规则。

### 6.3 开启部署保护开关

把本地参数文件 `mailAuthorizationReady` 改为 true。重部署前读取当前完整生命周期规则：

```bash
RULES=$(az storage account management-policy show --subscription "$SUB" -g "$RG" \
  --account-name "$STORAGE" --query policy.rules -o json)

az deployment group what-if --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --template-file infra/bicep/main.bicep \
  --parameters "@$PARAMS" existingStorageLifecycleRules="$RULES"

# 审核后使用相同参数：
az deployment group create --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --template-file infra/bicep/main.bicep \
  --parameters "@$PARAMS" existingStorageLifecycleRules="$RULES"
```

此时参数文件应已经保存真实 image、`deployWebApp=true`、正确邮箱/域和固定网络模式。
读取现有规则失败必须停止，不能用 `[]` 猜测继续，也不能重置旧已授权实例的邮件开关。
重部署后重新确认 Easy Auth 和用户分配仍有效。

### 6.4 网页测试后才启用自动通知

1. 在**设置 → 告警与邮件**核对发件邮箱，填本组织实际运维收件人并保存，先不启用通知。
2. 显式发送一封授权测试邮件，刷新状态，核对收件箱/垃圾邮件或 Exchange 跟踪。
3. `Graph 已接受`只表示请求被接受，不表示最终送达。确认真实收件后先保持自动通知关闭，
   完成第 7 节价格/授权/采集初始化，再启用自动告警，避免初始缺数据产生噪声通知。
4. 费用首次超限和持续超限每 6 小时提醒；标题/正文包含 USD 估算金额。
   **费用恢复只记录，不发送恢复邮件**；数据质量异常/恢复通知保持不变。

更换发件邮箱会关闭自动通知，新邮箱需要重新授权及测试。不要复制原实例的
`configuration/alerting.json` 或邮箱授权验证记录。

## 7. 初始化与无付费用量验收

### 7.1 首次同步

- 在**设置**手动启动一次价格同步，等运行状态成功且出现有效快照；不必等到午夜。
- 在**租户与授权**同步 Lighthouse，核对客户、订阅和授权状态。
- 预登记可选，发现不自动启用。设置租户名称及 USD/小时阈值，显式启用。
- 在**费用概览**启动“采集上一完整小时”，完成后刷新，进入租户详情核对覆盖率和来源。

手动启动固定 Job 也可以使用 Azure CLI，Job 名称以部署输出为准：

```bash
PRICING_JOB=$(az deployment group show --subscription "$SUB" -g "$RG" -n "$DEPLOYMENT" \
  --query properties.outputs.pricingJobName.value -o tsv)
az containerapp job start --subscription "$SUB" -g "$RG" --name "$PRICING_JOB"
az containerapp job execution list --subscription "$SUB" -g "$RG" --name "$PRICING_JOB" -o table
```

启动返回成功/HTTP 202 不等于采集或同步成功，必须核对运行摘要及持久化结果。

### 7.2 验收清单

- [ ] 最新 Web revision Healthy，有明确的 100% 流量目标；匿名/未分配用户不能读业务 API。
- [ ] 五类托管身份、container-scope 数据角色和 ACR pull 正确；Collector 客户侧仍为 Reader。
- [ ] 网络模式与安装选择一致；Blob 匿名、Shared Key 和 ACR admin user 仍关闭。
- [ ] 价格快照成功保存；失败不会用空文件覆盖旧价。
- [ ] 每个客户的目标订阅独立委派，未委派订阅不会混入，客户之间不串数据。
- [ ] 启用后小时记录可读回；来源为 Models - Usage `InputTokens/OutputTokens`。
- [ ] 无用量和采集失败分开；partial 是小计，无可信金额显示“—”，不补零。
- [ ] 真实邮件授权/收件验收通过后才启用；恢复邮件不投递，超限邮件包含估算金额。
- [ ] 保存参数、image digest、身份 object ID、授权管理员、secret 到期及撤销/恢复方法。

**安装验收不需要主动调用模型。**没有用量也可验证授权、采集和存储；价格匹配/超限
实量测试须另行批准模型、次数和预算，不能从原演示配置自动生成付费 prompts。

## 8. 运行节奏与业务限制

| 功能 | 当前行为 |
| --- | --- |
| 授权同步 | UTC `10 * * * *` |
| 用量采集 | UTC `15 * * * *`，精确读取上一完整小时 PT1H |
| 资源发现 | 每订阅缓存 2 小时；不默认回补历史 |
| 价格同步 | UTC `0 16 * * *`，即北京时间每日 00:00 |
| 邮件投递 | UTC `*/2 * * * *`，处理持久化 Outbox |
| 展示时区 / 币种 | 固定北京时间 / USD，不提供任意时区或币种设置 |
| 费用历史 / 价格备份 | 查询 240 小时 / 逻辑 90 天；物理生命周期、版本/软删除另计 |

官方价格仍仅 Azure OpenAI；其他 Foundry 模型可采集 token，缺价可后续录入手动文本
token 备用规则。官方价格优先，手动价不覆盖适用官方价。未知计费条件显示区间；
下限超过阈值才超限，上限也已知且不超限才内部恢复。新小时为暂定，不自动 final。
图片数、秒数、容量小时等缺少计量时不从 token 总数猜完整实际费用。

更多规则和保留边界见 [技术设计](technical-design.md)。

## 9. 升级、回滚与移交边界

### 升级

1. 保存当前 image digest、网络模式、分片/并发、邮箱保护状态和身份输出。
2. 从 Storage 读出完整 `policy.rules`，不能只传本应用规则或旧的空示例。
3. 构建新 digest，更新自己的参数文件；保持网络、身份、邮箱、已有规则和分片设置。
4. what-if 审阅后部署。核对新 revision Healthy/流量、Jobs 和登录保护。
5. 兼容滚动发布时先更新 Mail 再更新 Usage/Web；通过后定向停用旧的零流量 Web revision。
6. 需要回滚时使用兼容旧 reader 的已记录 digest；不回滚客户授权、邮箱证明或历史金额。

主模板一次更新所有组件；特别的分阶段更新可用 Azure CLI 仅改现有容器 image，但须对
每个 Job 和 Web 验证原环境参数/身份/cron 未变。不要通过重新创建资源组实现普通升级。
分片变更涉及 topology/排空旧执行，不能把 `usageShardCount` 当作随意热改参数。

### 移交包

保留正式 `apps/`、`packages/`、`tests/`、`infra/`、`docs/` 和根依赖/构建配置。
原型已移除，不是正式运行依赖。`node_modules`、`dist`、本地 Azurite、测试结果、日志和
本地参数/secret 不应交付；不要把原平台 Blob 数据或 Exchange 模块缓存复制给合作伙伴。

在 Linux/WSL 的仓库根目录可打包源码（即使当前修改尚未提交）：

```bash
tar -cf ../tokenusagealert-partner.tar \
  --exclude=node_modules --exclude=dist --exclude=coverage \
  --exclude=playwright-report --exclude=test-results --exclude='*.tsbuildinfo' \
  --exclude='.env' --exclude='.env.*' --exclude='*.log' \
  --exclude='*.parameters.local.json' --exclude='*.local.bicepparam' \
  README.md .gitignore .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml \
  tsconfig.base.json playwright.config.ts apps packages tests infra docs
tar -rf ../tokenusagealert-partner.tar .env.example
gzip ../tokenusagealert-partner.tar
```

检查包内不含 credentials、实际本地参数或客户数据后，通过双方批准的渠道交付。
不使用未经检查的 `git archive HEAD`：尚未跟踪/提交的正式代码会被漏掉。

新安装不继承原测试 tenant、收件人、阈值、手动价、费用历史或 Outbox。如需数据迁移，
先批准数据范围和访问权限，再单独设计；本指南没有自动数据迁移步骤。
已有测试实例的验收记录见 [RPI 历史记录](rpi-implementation-plan.md)，不是可照抄的安装参数。

## 10. 快速排障

| 现象 | 检查与处理 |
| --- | --- |
| 部署被 Policy/配额拒绝 | 核对区域、providers、角色和 public/private 选择；不要偷偷放开安全限制 |
| 镜像拉取失败 | ACR host/digest、MI `AcrPull`、传播延迟；不要启用 ACR admin 密码 |
| Blob 403 | MI client ID、container 数据角色、传播；人类 Owner 不自动有 Blob 数据角色，勿开 Shared Key |
| Blob 超时/DNS 错误 | public 检查 PNA/firewall；private 检查 VNet、PE/DNS；不要混用两个 profile |
| 一直等客户授权 | 客户订阅范围、合作伙伴 tenant ID、Collector **object ID**、同步及传播延迟 |
| 邮件仅预览/被阻止 | 邮箱组织、Mail identity、App RBAC、部署保护开关及允许收件域 |
| Retail Prices HTTP 429 | 价格源限流；有限重试后保留旧价，避免反复点击手动同步 |
| 有 token 没金额 | 看小时价格/覆盖问题；缺价不等于没采到用量，不复制其他型号价格猜测 |
| Mail unknown | 先核对 Exchange 消息跟踪，再人工关闭或确认重复风险后重投 |

## 11. 官方依据

- [Container Apps workload profiles](https://learn.microsoft.com/azure/container-apps/workload-profiles-overview)
- [Container Apps 网络与不可原地切换的网络类型](https://learn.microsoft.com/azure/container-apps/networking)
- [禁止 Blob 匿名访问](https://learn.microsoft.com/azure/storage/blobs/anonymous-read-access-prevent)
- [阻止 Shared Key 授权](https://learn.microsoft.com/azure/storage/common/shared-key-authorization-prevent)
- [Container Apps Entra 登录](https://learn.microsoft.com/azure/container-apps/authentication-entra)
- [Lighthouse 客户接入](https://learn.microsoft.com/azure/lighthouse/how-to/onboard-customer)
- [Exchange Application RBAC](https://learn.microsoft.com/exchange/permissions-exo/application-rbac)
