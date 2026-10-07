# Azure Lighthouse subscription onboarding

## Azure Portal GUI upload (no customer CLI required)

客户可通过 Azure Portal 完成授权，无需安装 Azure CLI 或 Bicep。
请把下面两个文件交给客户，下载到客户电脑：

1. **[subscription.json](./subscription.json)**：ARM 部署模板，由
   [subscription.bicep](./subscription.bicep) 编译生成，范围是 **subscription**。
2. **[subscription.parameters.json](./subscription.parameters.json)**：中性参数模板，
   必须将三个 `REPLACE_WITH_...` 替换为本合作伙伴 tenant ID、Collector object ID 和独立
   解除身份 object ID；保存为自己的 `subscription.parameters.local.json` 后再分发。
   身份 ID 来自本合作伙伴部署输出，不是原测试实例的值。详见
   [合作伙伴安装指南](../../docs/partner-installation.md)第 5 节。

客户操作步骤：

1. 使用客户订阅 **Owner**（或具备等效授权管理权限的账号）登录
   [Azure Portal](https://portal.azure.com/)，切换到**客户的 Entra 目录**。
2. 搜索 **Azure Lighthouse**，进入 **服务提供商（Service providers）→
   服务提供商套餐（Service provider offers）**。
3. 打开 **添加套餐（Add offer）**旁的下拉箭头，选择
   **通过模板添加（Add via template）**。
4. 上传 **subscription.json**。不要上传 `.bicep` 或把参数文件当作模板。
5. 勾选 **我有单独的参数文件（I have a separate parameter file）**，
   上传**本合作伙伴填写后的参数文件**，点击 **Upload / 上传**。
6. 在 **Custom deployment / 自定义部署**界面选择需要被监控的**客户订阅**和部署位置，
   核对参数。`Managed By Tenant Id` 是合作伙伴的 tenant ID，**不要改成客户 tenant ID**。
   部署位置只用于记录部署元数据，不会迁移客户资源。
7. 核对下面的两项授权，点击 **Review + create / 查看 + 创建 → Create / 创建**。
8. 等待部署成功，在服务提供商套餐中确认 `AOAI Cost Usage Monitoring`；
   合作伙伴返回本应用点击 **同步 Lighthouse**，新客户再设置阈值并启用。

| 身份 | Object ID 来源 | 客户授权角色 |
| --- | --- | --- |
| Collector | 本平台部署输出 `collectorIdentityPrincipalId` | Reader |
| 独立解除管理身份 | 本平台部署输出 `offboardingIdentityPrincipalId` | Managed Services Registration assignment Delete Role |

**每个要监控的订阅各部署一次**；不会自动授权该 tenant 的其他订阅。
该模板不需要创建客户资源组，只创建/更新订阅级 Lighthouse 委派，不删除模型或业务资源。
若门户要求选择一个资源组作为部署范围，请退出并使用上述 Lighthouse 上传入口，
不要把模板改成 resource-group scope。

给已接入的客户补充解除权限时，仍可使用上述 Portal 流程：保持原套餐名称、管理租户和
Collector ID。模板沿用原 registration definition/assignment 名称计算，不另建重复套餐。
若客户以前使用了自定义参数，必须沿用原值，不要直接覆盖为本示例。

官方入口说明：
[Deploy the Azure Resource Manager template — Azure portal](https://learn.microsoft.com/azure/lighthouse/how-to/onboard-customer#deploy-the-azure-resource-manager-template)。

## Azure CLI alternative

Deploy this template in each customer subscription that should be monitored.
It grants two separate managing-tenant identities:

- Collector: built-in `Reader` for resource discovery and Monitor metrics.
- Offboarding identity: `Managed Services Registration assignment Delete Role`
  (`91c1777a-f3dc-4fae-b103-61d183457e46`) to read/delete Lighthouse registration
  assignments. It cannot delete customer workloads or recreate a removed
  delegation. Use a different principal from the Collector.

The template does not create or modify customer workloads.

```bash
az deployment sub what-if \
  --subscription <customer-subscription-id> \
  --location <deployment-location> \
  --name aoai-cost-lighthouse \
  --template-file infra/lighthouse/subscription.bicep \
  --parameters \
      managedByTenantId=<managing-tenant-id> \
      collectorPrincipalId=<collector-object-id> \
      offboardingPrincipalId=<offboarding-object-id>
```

After customer approval, replace `what-if` with `create`.

The customer can remove the delegation from **Service providers** in the
Azure portal or by deleting the registration assignment.

## Update existing customers

Keep the same `mspOfferName`, managing tenant, Collector ID, and template-derived
registration definition/assignment IDs. Deploy this updated template with the
additional `offboardingPrincipalId` in **each customer subscription**. The new
authorization replaces the template's authorization list, which retains Reader
for the Collector and adds only the dedicated deletion principal.

This is a customer-approved authorization update, not an automatic action
performed when creating the partner's managed identity. Existing delegations
do not acquire the new role until the customer redeploys the template.
Do not create a separate offer with the same Collector just to add the role:
overlapping Lighthouse delegations can affect each other's access.

See [Microsoft's delegation update guidance](https://learn.microsoft.com/azure/lighthouse/how-to/update-delegation).

## Maintain the Portal template

Keep the Bicep file as the source of truth. After changing it, regenerate the ARM
JSON instead of maintaining two independent implementations:

```bash
az bicep build \
  --file infra/lighthouse/subscription.bicep \
  --outfile infra/lighthouse/subscription.json
```

The checked-in parameter file contains placeholders, not a live partner's IDs.
Fill and check all three identity values before distributing it to customers. Neither downloading nor
uploading these files authorizes anything until the customer reviews and creates
the Azure deployment.
