# Azure OpenAI 费用告警平台：管理员与客户操作手册

适用于当前仓库和 `ms-ext` 测试实例，校准日期为 2026-10-07。第 1–6 批及后续通用
计价、手动缺价和 Models 指标迁移已纳入本文；生产加固仍未全部完成。
本文说明操作步骤，不会自动执行授权或部署。
新合作伙伴的独立安装使用 [合作伙伴安装与移交指南](partner-installation.md)；
本文下面的实例 ID、邮箱和私网配置是原测试实例记录，不是通用默认参数。

> **最近已核验状态**：采集主源为 Models `InputTokens/OutputTokens`，官方价格仍仅
> Azure OpenAI。测试实例自动告警已启用，统一收件人为 `chx@ms-ext.biz`。
> 2026-10-04 的单封授权测试邮件已独立确认 Exchange `Delivered`，这不是其他邮件
> 送达的证明。第 4 节保留新实例授权与故障恢复步骤，已有实例无需重复执行组织级配置；
> 生产推广前仍需单独审核专用发件邮箱及 Exchange 收件限制。

## 一、先看整个流程

| 顺序 | 谁操作 | 做什么 | 完成标志 |
| --- | --- | --- | --- |
| 1 | 合作伙伴 Entra 管理员 | 允许运维人员登录后台 | 指定用户可以登录 |
| 2 | 合作伙伴运维 | 可选：预登记客户租户、名称和阈值 | 显示“等待客户授权”；也可跳过，授权后自动发现 |
| 3 | 客户订阅管理员 | 对选定订阅部署 Lighthouse 模板 | 客户门户能看到委派 |
| 4 | 合作伙伴运维 | 同步授权、核对订阅、启用租户 | 租户已启用，可采集 |
| 5 | 合作伙伴 Exchange/部署管理员 | 授权发件邮箱、开启应用发信能力 | 页面允许发送真实测试邮件 |
| 6 | 合作伙伴运维 | 保存收件人、验证测试邮件、启用通知 | 测试邮件收到，自动通知开启 |

一个合作伙伴可以管理多个客户租户；每个客户租户可以包含多个订阅。
**客户每个需要监控的订阅都要单独授权，预登记一个 tenant ID 不会自动取得其全部订阅权限。**

### 当前实例信息

| 项目 | 当前值 |
| --- | --- |
| 后台入口 | [租户与授权](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/) |
| 费用与通知 | [费用概览](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/overview) · [设置](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/settings) · [运行状态](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/operations) |
| 合作伙伴 Entra tenant ID | `493da702-671c-450d-9d72-e51b74816e2d`（`ms-ext.biz`） |
| 平台所在 Azure subscription ID | `7bdb0a57-7e53-4c61-b1f0-11ce66566bd1`（`ms-ext`） |
| 平台资源组 / 区域 | `aoai-cost-alert-test-rg` / `swedencentral` |
| 后台登录应用 | `AOAI Cost Alert Test`，App ID `1993e1c7-4a98-48d4-ad69-c967f0d5800d` |
| 客户授权用 Collector **object ID** | `37983c0c-88ac-442c-a536-534c5ee910ab` |
| 客户授权用独立解除身份 **object ID** | `b6d610ba-5411-45d0-ac84-295f43265881` |
| 发件邮箱 | `chx@ms-ext.biz` |

这些值只适用于本实例，其他环境不能直接照抄。不要删除并重建 Collector identity：
即使名称相同，object ID 也会改变，客户需要重新授权。

### 权限分工

- **后台用户分配**：合作伙伴的 Entra 应用管理员等有权管理该企业应用的人员。
- **客户订阅委派**：客户订阅 `Owner`，或具备 Lighthouse 部署及所需授权管理权限的管理员。
- **邮箱授权**：合作伙伴 Exchange 管理员，具备相应 Organization Management 权限。
- **应用部署参数**：平台 Azure 部署管理员。

Azure subscription 的 Owner 不自动等于 Entra 应用管理员或 Exchange 管理员。
客户不需要把密码、access token、Azure OpenAI API key 或邮箱凭据交给合作伙伴。

## 二、合作伙伴管理员：允许运维人员登录

当前登录应用已配置，不必重复注册。

1. 登录 [Microsoft Entra 管理中心](https://entra.microsoft.com/)，切换到 `ms-ext.biz` 目录。
2. 进入 **企业应用程序 → 所有应用程序**，按上表 App ID 找到 `AOAI Cost Alert Test`。
3. 在 **属性** 中确认“需要分配用户？”为“是”。
4. 在 **用户和组 → 添加用户/组**中，分配获准使用平台的运维人员。
5. 用该用户打开后台并完成登录/MFA；新增用户可用无痕窗口验证。

测试时可以先直接分配个人用户；按组分配需要相应 Entra 许可。
第一版所有获准运维用户共享同一份客户清单，没有“每人只能看自己的客户”的隔离。
**不要为了采集客户数据给客户用户分配后台权限；第一版没有客户自助后台。**

## 三、客户接入：租户与订阅授权

### 3.1 合作伙伴运维预登记（可选）

1. 打开 **租户与授权 → 预登记租户**。
2. 填写客户名称、客户 Entra tenant ID、**USD/小时**预警金额。
3. 保存后应显示 **等待客户授权**。
4. 将以下信息交给客户管理员：
   - Portal 用户：[ARM 模板 subscription.json](../infra/lighthouse/subscription.json)
     和[参数模板 subscription.parameters.json](../infra/lighthouse/subscription.parameters.json)；
     参数模板已中性化，先用下方本实例三个 ID 填写后再交给客户，不能上传占位符；
   - CLI 用户可继续使用 [Lighthouse Bicep 模板](../infra/lighthouse/subscription.bicep)；
   - 合作伙伴 tenant ID：`493da702-671c-450d-9d72-e51b74816e2d`；
   - Collector object ID：`37983c0c-88ac-442c-a536-534c5ee910ab`；
   - 独立解除身份 object ID：`b6d610ba-5411-45d0-ac84-295f43265881`；
   - 需要纳入监控的订阅清单。

预登记不是授权，也不是自动发现的前提。客户可以先部署模板，再由合作伙伴同步发现、
设置名称和阈值；自动发现不会自动启用采集。

**删除未授权的预登记**：在“等待客户授权”的租户行点击 **删除登记**，核对名称和
tenant ID 后点击 **确认删除登记**。这会直接删除
`configuration/tenants/<tenantId>.json` 的当前配置，不是改成“已解除管理”；刷新页面
后该登记不再列出，需要时可以重新登记。操作审计、既有费用历史及 Storage 自身的
软删除/版本保留策略不变。

此操作不调用 Azure Lighthouse 解除权限，也不删除客户资源。已经同步发现授权的
租户不能这样删除，必须使用“解除管理”。如果客户已经完成委派但平台尚未同步，
删除登记后仍会在下次授权同步中重新发现，进入待配置、待启用状态，不会直接采集。
若同步或其他用户已改变状态，平台会阻止旧页面的删除并提示刷新。

### 3.2 客户管理员授权每个订阅

**方式 A：Azure Portal 图形界面（不需要 CLI）**

1. 客户订阅 Owner 登录 [Azure Portal](https://portal.azure.com/)，切换到客户目录。
2. 下载上方 **subscription.json** 和 **subscription.parameters.json** 两个文件。
3. 进入 **Azure Lighthouse → 服务提供商 → 服务提供商套餐**。
4. 在 **添加套餐（Add offer）**下拉菜单选择 **通过模板添加（Add via template）**。
5. 上传 **subscription.json**；勾选 **我有单独的参数文件**，再上传
   **subscription.parameters.json**，点击 **Upload / 上传**。
6. 选择要授权的**客户订阅**和部署位置。核对参数中的合作伙伴 tenant ID 和两个
   identity object ID；`Managed By Tenant Id` 不要改成客户 tenant ID。
7. 审核 Reader 与独立解除身份的角色后，点击 **查看 + 创建 → 创建**，等待成功。
8. 有多个订阅时逐个重复；随后由合作伙伴执行 3.3 的同步和启用。

这是**订阅级 Lighthouse 部署**，不需要客户新建资源组，也不创建/修改模型工作负载。
不要把 `.bicep` 直接上传，或在资源组范围部署此模板。详细的
[Portal 上传说明](../infra/lighthouse/README.md)列出了每个文件的用途和授权清单。

**方式 B：Azure CLI（与 Portal 方式二选一）**

**执行位置：客户自己的 Azure CLI/Bash 终端。**将模板放在当前目录，使用客户管理员账号登录。
本机、远程开发机和 Cloud Shell 的登录上下文不一定相同，操作前必须核对。

客户 tenant ID 可在 **Microsoft Entra ID → 概述 → 租户 ID**取得；subscription ID
可在 **Azure Portal → 订阅 → 目标订阅 → 概述**取得。终端需要 Azure CLI 及可用的
Bicep 工具；客户不需要安装本应用、Node.js 或配置合作伙伴的 Storage。

```bash
CUSTOMER_TENANT_ID="替换为客户的tenant-ID"
CUSTOMER_SUBSCRIPTION_ID="替换为客户要授权的subscription-ID"

az login --tenant "$CUSTOMER_TENANT_ID"
az account show --subscription "$CUSTOMER_SUBSCRIPTION_ID" \
  --query "{subscription:id,name:name,tenant:tenantId,user:user.name}" -o json

# 如果 Microsoft.ManagedServices 尚未注册，由客户管理员执行：
az provider register --subscription "$CUSTOMER_SUBSCRIPTION_ID" \
  --namespace Microsoft.ManagedServices --wait

az deployment sub what-if \
  --subscription "$CUSTOMER_SUBSCRIPTION_ID" \
  --location swedencentral --name aoai-cost-lighthouse \
  --template-file ./subscription.bicep \
  --parameters \
    managedByTenantId=493da702-671c-450d-9d72-e51b74816e2d \
    collectorPrincipalId=37983c0c-88ac-442c-a536-534c5ee910ab \
    offboardingPrincipalId=b6d610ba-5411-45d0-ac84-295f43265881
```

核对 what-if：本模板创建 Lighthouse registration definition/assignment，
把 **订阅级 Reader** 委派给指定 Collector，并给另一个独立身份授予
**Managed Services Registration assignment Delete Role**。后者只能读取/删除 Lighthouse
registration assignment，不授予删除模型、资源组或 Azure 订阅的权限。
Reader 能读取订阅内管理面元数据，**并不只限于 AOAI**；不需要提供模型 API key。

客户同意后执行：

```bash
az deployment sub create \
  --subscription "$CUSTOMER_SUBSCRIPTION_ID" \
  --location swedencentral --name aoai-cost-lighthouse \
  --template-file ./subscription.bicep \
  --parameters \
    managedByTenantId=493da702-671c-450d-9d72-e51b74816e2d \
    collectorPrincipalId=37983c0c-88ac-442c-a536-534c5ee910ab \
    offboardingPrincipalId=b6d610ba-5411-45d0-ac84-295f43265881
```

- `--location` 是订阅级部署记录的位置，不会迁移客户已有资源。
- 有多个订阅时，替换 `CUSTOMER_SUBSCRIPTION_ID`，对每个选定订阅重复执行。
- 有多个客户租户时，分别登录对应客户目录，不能只在合作伙伴订阅部署一次。
- **分别使用 Collector 和解除身份的 object ID，两者不能相同；不是后台 App ID 或邮件身份 ID。**
- 客户在 Azure Portal 的 **Azure Lighthouse / 服务提供商（Service providers）**
  中核对 `AOAI Cost Usage Monitoring` 及委派范围，并把成功结果告知合作伙伴。

### 3.3 合作伙伴同步并启用

1. 返回 **租户与授权**，点击 **同步 Lighthouse**。
2. 等待运行完成并刷新；授权刚创建时可能存在权限传播延迟。
3. 找到该客户租户，打开右侧授权详情，核对实际出现的订阅。
4. 状态为 **已发现待启用**时，确认名称、小时阈值，点击 **启用租户**。
5. 在 **费用概览**点击 **采集上一完整小时**，完成后刷新，再进入租户详情。

预登记流程：`等待客户授权 → 已发现待启用 → 活动`；跳过预登记时从
`已发现待启用`开始，仍须显式启用。如果预期订阅只出现一部分，会显示
“授权范围变化/部分数据”，不能当作完整租户费用。

**修改名称或费用限额**：在 **租户与授权 → 管理中**找到租户，点击行内 **编辑**，
修改名称和 **USD/小时费用限额**后点击 **保存修改**；租户费用详情也提供相同入口。
名称和当前限额保存到租户配置 JSON，清单和概览读取新配置；不会更改授权或启用状态。
已采集小时保留当时阈值，后续采集/计算才使用新限额；重采同一小时也不追溯改阈值。
如果其他人员或授权同步已改变版本，会要求刷新核对，不会覆盖他们的修改。
“已解除管理”的归档租户没有编辑入口，需先重新登记或接入。

当前 `fte` 订阅 `9654aa88-011f-490e-be5d-6ad3305703b4` 已做过委派验证，
属于客户 tenant `92078590-b3a5-4c46-aaea-74360df451d0`；不要误用平台的 `ms-ext`
订阅来代替客户订阅。

### 3.4 已接入客户如何补充“合作伙伴可解除管理”授权

原来的客户委派只有 Collector Reader，不会因为平台新增托管身份就自动扩大权限。
由客户 Owner 获取新版模板，保留原 `mspOfferName`、管理租户和 Collector ID，按 3.2
通过 Portal 上传 JSON 或通过 CLI 重新部署，增加 `offboardingPrincipalId`。
无需先撤销原委派；不要更换套餐名制造重复授权。
新模板只改变 authorizations，保留原 registration definition/assignment ID。

更新后等待权限传播，合作伙伴即可在应用中预览并确认解除。不更新的客户仍可由客户
管理员自行撤销，但合作伙伴网页会明确提示“需要客户重新授权”。

客户通过 Portal 复用现有 offer 时，目标订阅的 assignment 可以引用同一客户 tenant
下另一订阅的 definition；这是共享授权定义，不是重复委派。解除只删除目标订阅的
assignment，保留共享 definition 和其他订阅的管理关系。2026-10-05 已读回确认
`Pay-As-You-Go-TEMP` 引用 `fte` 的 definition，两个订阅均已包含独立解除身份。

## 四、合作伙伴管理员：授权并开通邮件

费用采集与邮箱授权是两条独立流程；邮件未开通时，仍可查看费用和告警事件。

### 4.1 批准 Exchange 组织前置配置

**执行位置：安装了 PowerShell 7 的管理员终端；使用 Exchange 管理员身份。**

```powershell
# 首次使用时安装；已安装可直接 Import-Module。
Install-Module ExchangeOnlineManagement -Scope CurrentUser -Repository PSGallery
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -UserPrincipalName chx@ms-ext.biz -ShowBanner:$false

Get-OrganizationConfig | Format-List IsDehydrated
```

如果 `IsDehydrated=True`，或创建 scope 时明确提示需要组织自定义：
**先取得组织管理员批准，再执行下面命令。未批准则停止此步骤，继续使用预览。**

```powershell
Enable-OrganizationCustomization
Get-OrganizationConfig | Format-List IsDehydrated
Disconnect-ExchangeOnline -Confirm:$false
```

这是组织级配置，不是普通网页开关；可能需要等待生效。当前实例已由管理员完成前置
配置，2026-10-04 核对为 `IsDehydrated=False`，此前阻塞已解除，无需重复执行。

### 4.2 只授权指定发件邮箱

在**项目根目录**用 PowerShell 执行已有[单邮箱授权脚本](../infra/bicep/scripts/configure-mailbox-rbac.ps1)：

当前远程开发机项目目录为 `/home/chx/chxgithub/tokenusagealert`；也可以在管理员自己的
电脑取得相同项目文件后操作。无需把管理员密码或 access token 写入文件。

```powershell
./infra/bicep/scripts/configure-mailbox-rbac.ps1 `
  -ApplicationId 75e85cd3-0e53-49b0-8aab-5f54b24893e0 `
  -ServicePrincipalObjectId 66c68b46-0d51-49b5-8175-5bcf2dd4f199 `
  -SenderMailbox chx@ms-ext.biz `
  -AdminUser chx@ms-ext.biz
```

这里的 `ApplicationId` 是 **Mail identity 的 client ID**，`ServicePrincipalObjectId`
是它的 **object/principal ID**，不要替换成 Collector 或后台登录应用。
脚本会再次登录 Exchange、确认 scope 只包含指定邮箱、配置 `Application Mail.Send`
并验证权限。成功应输出 `ScopedMailSend: true`；失败时不要继续开启应用开关。

**禁止用组织范围的 Graph `Mail.Send` 代替单邮箱 App RBAC。**App RBAC 限制发件邮箱，
不限制收件人。当前应用只接受 `ms-ext.biz` 域的运维地址；如需其他域，须由部署管理员
审核并更新允许域。不要对 `chx@ms-ext.biz` 套用未经批准的全局收件限制，影响其正常邮件。
生产推广前，应由邮件管理员确认专用发件邮箱/Exchange 收件限制方案；当前受控
测试实例的应用允许域校验不等于这一生产安全要求已经完成。

### 4.3 部署管理员开启应用发信能力

只有 **4.1、4.2 及邮件策略审核完成**后，才设置 `mailAuthorizationReady=true`。
这个参数不是网页里的“启用通知”；它负责解除应用的真实发信保护。

当前测试实例的 Web 和邮件 Job 已为 `true`，并已验证真实送达。**后续重部署此实例
必须继续传入 `mailAuthorizationReady=true`**；模板默认 false 是新环境的保护值，
不能因此意外关闭已授权实例的发信能力。

下面是**当前单分片测试实例**的 Bash 示例，在项目根目录执行。
若实例的分片或并发参数已改变，保留实际值，不要重置为下面的默认值。

```bash
set -euo pipefail
SUB="7bdb0a57-7e53-4c61-b1f0-11ce66566bd1"
RG="aoai-cost-alert-test-rg"
APP="aoai-cost-test-web"
STORAGE="aoaicosttestw6ehcu3axgbw"

az login --tenant 493da702-671c-450d-9d72-e51b74816e2d
IMAGE=$(az containerapp show --subscription "$SUB" -g "$RG" -n "$APP" \
  --query "properties.template.containers[0].image" -o tsv)
RULES=$(az storage account management-policy show --subscription "$SUB" \
  -g "$RG" --account-name "$STORAGE" --query policy.rules -o json)

PARAMS=(deployWebApp=true mailAuthorizationReady=true
  "containerImage=$IMAGE" "existingStorageLifecycleRules=$RULES"
  usageShardCount=1 usageTenantConcurrency=8
  usageSubscriptionConcurrency=8 usageRequestConcurrency=32)

az deployment sub what-if --subscription "$SUB" \
  --name aoai-cost-mail-enable --location swedencentral \
  --template-file infra/bicep/test-subscription.bicep \
  --parameters "${PARAMS[@]}"

# 检查预览后再部署；不要删除或放开 Storage 私网限制。
az deployment sub create --subscription "$SUB" \
  --name aoai-cost-mail-enable --location swedencentral \
  --template-file infra/bicep/test-subscription.bicep \
  --parameters "${PARAMS[@]}"
```

读取镜像或生命周期规则失败时先解决问题，**不要用空数组或猜测值继续部署**。
权限变更可能需要传播；若仍返回 403，检查 scope/角色与传播状态，不要扩大为全组织权限。

### 4.4 运维配置收件人，先测试再启用

1. 打开 **设置 → 告警与邮件**，核对可编辑的“发件邮箱”；当前已验证地址是 `chx@ms-ext.biz`。
2. 填写真实“统一运维收件人”，每行一个，点击 **保存通知设置**；先保持通知关闭。
3. 在“测试收件人”中选择发件邮箱本身或已保存的运维地址。
4. 邮件身份尚未开通时只能点击 **预览测试（不发送邮件）**；已开通身份的新邮箱可点击
   **验证发件邮箱（发送测试）**，已验证邮箱显示 **发送测试邮件**。先保存修改，再测试。
5. 点击测试后，使用 **刷新测试状态**或进入 **运行状态 → 邮件 Outbox**查看结果。
6. 真实测试必须检查收件箱/垃圾邮件，并由管理员按需查看 Exchange 消息跟踪。
7. 确认真实测试正常后，勾选 **启用自动告警邮件**，再次 **保存通知设置**。

“测试事件已入队”不等于邮件已发送；`Graph 已接受`也不等于最终送达。
开启通知从后续计算窗口生效，不会自动补发关闭期间的旧告警。

### 4.5 当前实例邮件验收记录

| 项目 | 已验证结果 |
| --- | --- |
| 发件邮箱 / 唯一运维收件人 | `chx@ms-ext.biz` |
| 单邮箱权限 | 专用 Mail identity 的 `Application Mail.Send`；scope 仅包含该邮箱 |
| 真实测试主题 | `[AOAI][发信授权测试][ee35e8addd] 发信验证` |
| 邮件任务 | `aoai-cost-test-mail-s7qfq4n`，Succeeded |
| 应用 Outbox | accepted，1 次提交；没有重复发送本次测试 |
| Exchange 消息跟踪 | Delivered；接收时间 `2026-10-04T15:39:22.883Z`（北京时间 23:39:22） |
| 自动通知 | 已启用；Blob 配置 revision 2 已读回核验 |
| 当前通知规则 | 估算下限超限、持续超限每 6 小时提醒；费用恢复仅记录、不发邮件；数据质量通知保持不变 |

本次 Exchange trace ID 为 `4587e4e5-1b0b-4012-89bf-08df222da9e0`。
这是对这封测试邮件的独立送达确认，应用 Outbox 仍按 Graph 返回值显示 `accepted`，
不能由此推断其他邮件也已送达。该次邮箱验收没有制造模型用量；后续已验证真实 token、
原快照补算及历史超限事件的 Graph 提交，见 [RPI 实施记录](rpi-implementation-plan.md)第 15 节。
这些验证仍不是 Azure 实际账单核对。

### 4.6 更换发件邮箱

1. 在 **设置 → 告警与邮件 → 发件邮箱**输入真实 Microsoft 365 邮箱主地址/UPN，
   点击 **保存通知设置**。地址保存到 `configuration/alerting.json`，更换后自动关闭通知。
2. 由 Exchange 管理员为**同一个专用 Mail identity**授权新邮箱。已有 scope 不应改成
   全组织或通配范围；保留旧邮箱授权时，为新邮箱使用一个独立 scope 名称。例如：

   ```powershell
   ./infra/bicep/scripts/configure-mailbox-rbac.ps1 `
     -ApplicationId 75e85cd3-0e53-49b0-8aab-5f54b24893e0 `
     -ServicePrincipalObjectId 66c68b46-0d51-49b5-8175-5bcf2dd4f199 `
     -SenderMailbox alerts@ms-ext.biz `
     -ScopeName aoai-cost-alerts-sender `
     -AdminUser chx@ms-ext.biz
   ```

   `alerts@ms-ext.biz` 只是操作示例，需替换为实际存在、已获批准的邮箱。网页不会执行
   这项授权，也不会扩大发信权限。Graph 无法识别的别名需改用该邮箱可识别的主地址/UPN。
3. 回到网页点击 **验证发件邮箱（发送测试）**，再点击 **刷新测试状态**。
   实际 Graph 202 成功会保存绑定“发件邮箱 + Mail identity”的权限验证记录；
   预览、失败或结果不确定不能验证新邮箱。403/404 等权限/邮箱拒绝会更新未通过状态。
4. 核对收件箱或 Exchange 跟踪后，手动勾选 **启用自动告警邮件**并保存。
   未验证的新地址不能启用真实自动通知；收件人仍受允许域限制。

未提交的旧发件邮箱邮件会被阻止，提交前再次核对配置；已经开始提交或已获 Graph
接受的邮件不能撤回。改邮箱不补发关闭期间的旧告警。`MAIL_SENDER_MAILBOX` 是初始/
已验证部署邮箱的默认值，保存后的 JSON 发件地址优先；切换邮箱本身无需重部署。

## 五、日常查看、告警处理与撤销

### 采集节奏与费用含义

| 功能 | 当前行为 |
| --- | --- |
| 授权同步 | 每小时第 10 分钟；可手动同步 |
| 用量采集 | 每小时第 15 分钟，只查上一完整小时；如 13:15 查 12:00–13:00 |
| 指标口径 | Models - Usage：`InputTokens` / `OutputTokens`；按部署、模型、版本拆分 |
| 资源发现 | 每 2 小时刷新清单；新增资源可能需等待，旧小时不默认补采 |
| 结果确认 | 新小时为“暂定” `provisional`；不随时间自动变成“已确认” `final` |
| 价格同步 | 北京时间每日 00:00，校验后自动更新，无人工复核 |
| 邮件处理 | 每 2 分钟检查 Outbox；不是同步即时送达 |
| SKU 价格下载 | 设置 → 当前价格快照 → 下载精简 SKU 价格 JSON / 下载原始/审计快照 |
| 手动缺价规则 | 设置 → 手动价格 · 缺价备用 → 新增 / 编辑 / 停用 |
| 查询历史 | 费用最多 10 天，价格备份逻辑保留 90 天 |

- **没有模型用量也能验证接入和采集链路，不要为了验收主动制造 token。**
- 新小时的详情“指标来源”显示 Models - Usage；旧小时保持 Azure OpenAI - Usage 历史
  口径。两组同类 token 不能相加；切换不重写已保存历史、不增加查询小时。
- 当前官方价格目录仍仅 Azure OpenAI，未增加 Grok 等 provider 的价格。其他 Foundry
  模型可保存用量，缺价明确显示“—”；之后按实际模型/版本/SKU 加手动价格。
- Models token 指标没有实际服务档位时可能出现更宽估算区间；不能无证据认为所有调用
  都用 Standard。单独的 Estimated Cost Preview 不用作正式费用主源。
- 金额是 USD 公开零售价估算，不是实际账单；缓存输入按普通输入价保守估算。
- **默认精简价格下载**：`aoai-pricing.json` 是内部计算实际使用的官方精简目录，加上
  已登记的手动备用规则。统一 USD／100 万 token，包含模型、SKU、区域、上下文、
  服务档位、输入/输出/缓存方向、最新已生效日期和真实 meter ID；不提前用未来价。
  同价同条件区域合并，但价格不同的区域不合并。文件包含可查询 token 价格，并非
  所有服务 meter。相同 token 计费格式的新模型进入官方目录后自动匹配，不需修改模型
  白名单；完全新的计费单位必须有对应用量。
- **原始/审计下载**：`aoai-pricing-raw.json`，包含当前完整快照的时间、币种、
  snapshot ID、规范化 entries 和每条 `raw` 中的 SKU、meter、区域、单位及原始零售价。
  `models` 是可识别模型名称索引；每条 `entries[].modelName` 显示该 SKU 的模型，
  例如 `gpt-6-luna`、`gpt-6-astra`、`gpt-5.6-sol`，不用从 SKU 缩写中自行猜测。
  `modelIdentityStatus=shared-service` 表示 Provisioned capacity、工具调用或免费通用
  meter，不属于单个模型，名称为 null 是明确的通用服务状态；`unidentified` 表示
  未能唯一解析的新标签。输入/输出、SKU、区域、版本与计量单位仍须匹配。
  不只导出已支持的模型，也不表示所有部署都可计价；没有快照时不提供空文件。
  下载需登录，由应用通过私网读取并流式返回，不开放 Blob 公网、SAS 或存储密钥。
  元数据解析器版本 3 可修复已有快照的模型/计费信息；此类修复保留原 `fetchedAtUtc`，
  并记录 `normalizedAtUtc` 和 `sourceSnapshotId`，不伪装成重新下载了价格。
- **增加手动缺价**：在设置点击“新增手动价格”，输入准确模型名称、输入/输出
  USD/百万 token 单价；部署方式必须与资源一致。模型版本可留空表示全部版本。
  默认选择一个或多个区域，也可填 Azure 区域代码；只有明确勾选才适用所有区域。
  备注建议记录官网或已确认报价依据。保存后从下一完整小时生效，采集要等待该
  窗口结束及正常 15 分钟缓冲。支持编辑、停用，均保留历史版本和审计，不改过去费用。
- **官方优先**：官方有相同适用范围记录时，手动价只是备用，不覆盖官方报价。多个
  官方上下文/模态价位无法从小时指标区分时显示区间，不再因模型不在名单中拒绝计价。真正缺价的
  文本 token 模型才使用唯一有效手动规则，不区分 short/long，缓存按普通输入估算。
  所有金额仍为 USD 估算，不是实际账单。详情与相关告警会标注手动价格来源。
  不要把示例单价、其他模型别名或未经确认的价格录入真实环境；没有价格显示“—”。
- “未观测到用量”不等于采集失败；“—”表示没有可信金额，不能当作 0 美元。
- `partial` 是已知估算小计，可能缺订阅、指标或价格，不能代表完整总额。
- 数据完整性和确认状态独立：`complete` 也可能是暂定区间估算，不是已确认账单；
  无可信金额的 `failed` 不显示 0。旧的已确认历史保留，但当前没有自动确认或默认回补。
- **区间不是额外消费**：如 `US$1.7395–US$2.6807` 表示小时指标缺少上下文/缓存写入
  等维度，界面给出既定零售价估算范围，不表示账单已经收费上限。下限超阈值告警，
  只有上限也已知且不超限时才内部恢复；费用恢复不发送邮件。
- `UNSUPPORTED_PRICING_RULE` 是旧版名单限制，规则版本 3 已移除。原金额缺失的
  暂定真实小时可由受控一次性 Job 按原 snapshot 补算，保留 token、采集时间和阈值，
  已有可信金额不覆盖。补算邮件明确标注历史窗口，不改变当前超限状态。
  2026-10-05 完整重查 24 页、23,870 条价格：`gpt-6-luna` 的 `6-luna` SKU 已存在，
  当前部署的 Sweden Central / GlobalStandard 对应 Standard Global meter。普通输入/
  输出每百万 token：ShortCo 为 USD 0.10/0.50，LongCo 为 USD 0.20/0.75；另有缓存
  读取/写入 meter，不能用单一价位猜测全部小时用量。
- 尚未找到 `gpt-6.1-sol` 对应的精确 `6.1-sol` SKU；目录中的 `6-sol` 不是已验证别名。
  当前价格已下载，不是手动同步遗漏；缺少精确官方价时才使用已生效的手动估算。
  相关新 meter 的 `serviceName` 为 `Foundry Models`，手工查询不要只限定
  `Cognitive Services`。

### 邮件状态怎么处理

| 状态 | 含义 / 操作 |
| --- | --- |
| 待投递 / 正在处理 | 等待 Dispatcher，稍后刷新，不要连续提交同一个测试 |
| Graph 已接受 | Graph 返回 202；仍需核对真实收件情况 |
| 预览完成 · 未发信 | 没有发送真实邮件 |
| 未投递 | 通知关闭、配置变化或费用恢复仅记录策略；查看详情中的原因 |
| 失败 | 查看错误，检查邮箱授权、账号状态、收件限制和任务日志 |
| 结果不确定 | **先查 Exchange 消息跟踪**；再在详情里填写原因，选择关闭或确认风险后重投 |

估算下限首次超限生成通知；持续超限最多每 6 小时提醒一次。**不再发送“估算费用已恢复”
邮件**：新的完整小时且已知估算上限不超限时，只更新内部状态和事件，确保以后再次超限
仍会告警。partial/failed、上限未知或仍可能超限不触发内部恢复。数据质量异常/恢复通知不变。

超限及持续提醒邮件的标题和正文摘要都有 **USD 估算金额/区间**，同时列出小时阈值、
北京时间窗口和中文数据状态；部分数据明确写“已知估算小计”，未知上限不补零。
最多显示 6 位小数，不改变已保存金额。区间来自指标中未区分的计费条件，不是额外消费或实际账单。
旧的待投递费用恢复邮件也会被阻止；已获 Graph 接受的旧邮件无法撤回。
Graph 本身故障只在 GUI/日志显示，当前没有独立短信或 Teams 兜底通道。

### 客户新增或撤销订阅

- **新增订阅**：客户对新订阅重复 3.2，合作伙伴再同步；仅在客户租户中创建订阅不等于授权。
- **合作伙伴解除一个订阅**：在订阅旁点击 **解除管理 → 检查解除权限并预览**。
  已完成 3.4 授权的客户会显示准确的订阅范围；输入该订阅 ID 后点击 **确认解除管理**。
- **合作伙伴解除整个租户**：在租户行点击 **解除管理**，预览该租户当前同步可见的订阅，
  输入客户 tenant ID 再确认。新授权尚未同步时，应先同步再预览，不要把旧范围当作全部。
- 预览只读，10 分钟内有效，必须由同一登录用户确认。执行前再次核对管理租户、客户
  租户、套餐名称及两个身份；若包含其他主体、重复/共用 Collector 的委派或范围变化，
  会拒绝执行。只请求删除 registration assignment，不删除业务资源。
- **客户尚未授权专用解除身份**：预览将提示需要更新授权，不会自动给自己提升权限。
  也可展开弹窗中的 **客户侧撤销指引**，由客户 Owner 在 Azure Portal 撤销。
- **部分成功/结果未知**：保留操作 ID，先点击 **刷新操作状态**及 **同步确认授权**
  核对。网络断开不会自动重发删除请求；不要把“已提交解除”当作权限传播已经完成。
- 客户完成后点击 **同步确认授权**或 **同步 Lighthouse**。系统必须完整取得可见订阅
  列表，再对消失订阅做独立读取核验；只有明确失去 Collector 访问权，才从监控范围及
  预期订阅数中移除。超时、429、未知 403/404、服务端错误保留原记录并显示同步问题。
  普通 401 也不会移除；仅在完整同身份枚举已确认缺失时，识别 Lighthouse 撤销后的
  特定跨租户错误 `InvalidAuthenticationTokenTenant`。
- 移除单订阅不影响同租户其他授权订阅；全部移除后，租户进入 **已解除管理**标签，
  不再采集且从当前费用概览移出。配置和历史仍保存，费用按原 10 天窗口到期，不追溯
  抹掉已发生费用。已移出的订阅可在租户详情的 **已移出订阅**查看。
- **重新接入**：客户重新部署授权模板；如果整个租户已解除管理，同步后回到
  **已发现待启用**，需确认名称/阈值再启用。也可先在 **已解除管理 → 重新登记**；
  该操作只进入等待授权，不会伪造授权。若租户仍活动，仅被移出的某个订阅重新获得授权，
  同步后重新纳入该租户范围。
- 订阅 `Disabled` 等状态不是撤销委派，系统保留记录但不采集它。同一订阅仍有其他
  允许 Collector 访问的授权时，不会移出。多条相同主体/角色的委派撤销可能相互影响，
  客户应核对实际范围及其余委派。
- 停止邮件通知：在设置里取消 **启用自动告警邮件**并保存；这不撤销客户资源读取权限。
  整个租户已移出时，尚未提交的旧通知会被阻止。已经提交给 Graph 的邮件无法撤回。

移出以权限传播和成功同步为界，不是实时推送。已经开始的管理面请求可能结束，但如果
同步已改变授权范围，该在途任务不会再提交旧范围的费用、资源清单或告警。
两小时资源缓存不会把已移出的订阅重新加入。

## 六、快速排障与交付检查

| 现象 | 优先检查 |
| --- | --- |
| 后台不能登录 | 是否切到合作伙伴目录、企业应用是否分配用户、MFA/条件访问是否通过 |
| 一直等待客户授权 | 模板是否部署在客户订阅；是否用了正确 Collector object ID；同步是否完成 |
| 只有部分订阅 | 每个订阅是否分别授权；授权范围/历史预期是否有变化 |
| 撤销后还在列表 | 权限传播是否完成；是否同步成功；其他委派是否仍授予 Collector 访问权限 |
| 已解除管理后要恢复 | 客户重新授权，再同步；整个租户重新接入必须显式启用 |
| 同步成功但没有费用 | 租户是否已启用；是否已有资源清单及完整小时；是否无用量或价格未匹配 |
| `PRICE_HTTP_ERROR` / HTTP 429 | Retail Prices 限流，不是模型调用或邮箱权限错误；有限重试后保留上次有效价格，避免连续手动重试 |
| 只能预览、不能发信 | Exchange 前置配置、单邮箱 RBAC、应用 `mailAuthorizationReady` 三步是否都完成 |
| Storage 数据浏览失败 | 当前终端是否能到 Private Endpoint，是否有 Blob 数据权限；**不要开启公网或使用密钥绕过** |

交付前逐项确认：

- [ ] 获准运维人员可以登录；未获准用户不能访问。
- [ ] 每个客户的目标订阅都完成委派，并在正确 tenant 下显示。
- [ ] 客户已启用，小时记录/无用量状态能保存并刷新读回。
- [ ] 真实邮件授权完成前始终关闭；预览没有被误认为真实发送。
- [ ] 开通邮件后，先验证真实收件，再开启自动通知。
- [ ] 记录发件身份、客户委派范围、管理员及撤销方法；不记录密码、token 或密钥。

进一步参考：[部署说明](../infra/bicep/README.md) · [Lighthouse 模板说明](../infra/lighthouse/README.md)
· [技术设计](technical-design.md)

官方依据：[Azure Lighthouse 客户接入](https://learn.microsoft.com/azure/lighthouse/how-to/onboard-customer)
· [撤销 Lighthouse 委派](https://learn.microsoft.com/azure/lighthouse/how-to/remove-delegation)
· [Exchange Application RBAC](https://learn.microsoft.com/exchange/permissions-exo/application-rbac)
· [Enable-OrganizationCustomization](https://learn.microsoft.com/powershell/module/exchangepowershell/enable-organizationcustomization)
