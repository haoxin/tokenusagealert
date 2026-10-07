# tokenusagealert

Token usage monitoring and alerting.

## Documentation

- **[Partner installation and handover guide (Chinese)](docs/partner-installation.md)** — fresh partner Consumption/public-Blob or private installation, own Entra/Exchange authorization and acceptance checks.
- [Administrator and customer end-to-end handbook (Chinese)](docs/operations-handbook.md)
- [Customer Lighthouse onboarding through Azure Portal (Chinese)](infra/lighthouse/README.md)
- [Technical design (Chinese)](docs/technical-design.md)
- [RPI implementation plan (Chinese)](docs/rpi-implementation-plan.md)
- [Infrastructure and deployment reference](infra/bicep/README.md)

## Current implementation baseline (2026-10-07)

- Container Apps Web plus Authorization, Usage, Pricing and Mail Jobs, private
  Blob JSON, and Lighthouse delegation for multiple customers/subscriptions.
- New partner templates also offer explicit public HTTPS Blob access with managed
  identity/RBAC and Consumption without a customer VNet. Private remains the default;
  the existing test instance is unchanged. See the installation guide above.
- Models - Usage `InputTokens/OutputTokens`, one completed hour per collection,
  a two-hour discovery cache, and no default historical backfill or automatic finality.
- Compact v2 is the actual pricing lookup source. Official prices remain
  Azure OpenAI-only; manual text-token rules fill genuine gaps, never override
  applicable official rates. Generic token rules support new names with the same
  billing contract; missing conditions produce estimate ranges, not assumed bills.
- Lower-bound breaches, six-hour reminders and upper-bound-safe internal recovery.
  From 2026-10-07, cost recovery is recorded but never emailed; both new and queued
  unsubmitted recovery mail are suppressed. Breach/reminder subjects and body
  summaries include the USD estimate/range. Data-quality notifications are unchanged.
  A durable Outbox preserves outcomes; Graph acceptance is not proof of delivery.
- Current documented release is Web revision `0000020`; see the mail-policy release
  record below. Production hardening (batch 7) is not fully delivered.

The slice/release sections below preserve historical rollout and test evidence.
Their old revision numbers, model restrictions and preview states do not override
this baseline or the [current implementation matrix](docs/rpi-implementation-plan.md#61-当前实现基线).
The design, implementation plan and operational/deployment guidance were aligned
to source schemas, routes and templates on the baseline date.

## First vertical slice

The first production slice implements:

```text
development / Easy Auth session
→ preregister customer tenant and hourly threshold
→ persist JSON to Azure Blob / Azurite
→ reload the tenant list
```

### Prerequisites

- Node.js 24
- pnpm 12.6

### Local development

```bash
pnpm install
pnpm dev
```

Services:

- Formal Web UI: http://localhost:5173
- Fastify API: http://localhost:3100
- Azurite Blob: http://localhost:10000

Local development uses an explicit fixed development identity and Azurite.
Production refuses to start with development authentication or a shared-key
Storage connection string.

### Validation

```bash
pnpm check
pnpm test:infra
pnpm test:integration
pnpm test:e2e
az bicep build --file infra/bicep/main.bicep
```

### Azure deployment gate

Future deployments using the Bicep and Easy Auth script under
[infra/bicep](infra/bicep) still require review of the appropriate subscription/
resource-group `what-if` output and manual approval of Entra changes. Existing
test deployments described below do not remove this approval gate.

The `ms-ext` test deployment requires a VNet-integrated Container Apps
environment and a Storage Blob private endpoint. Storage public network access
and shared-key authorization remain disabled.

### ms-ext test deployment

- Subscription: `ms-ext`
- Resource group: `aoai-cost-alert-test-rg`
- Region: `Sweden Central`
- Web:
  https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/
- Authentication: Microsoft Entra Easy Auth, assignment required
- Storage: private endpoint only
- Authorization Sync Job: `aoai-cost-test-auth-sync`
- Collector identity: `aoai-cost-test-collector-id`
- Pricing Sync Job: `aoai-cost-test-pricing-sync`
- Lighthouse smoke-test subscription:
  `fte` (`9654aa88-011f-490e-be5d-6ad3305703b4`)

Start an authorization synchronization manually:

```bash
az containerapp job start \
  --resource-group aoai-cost-alert-test-rg \
  --name aoai-cost-test-auth-sync
```

The same Job runs automatically at minute 10 of every UTC hour.

## Third slice: daily retail pricing

The price catalog is fetched in full at **00:00 Asia/Shanghai** (`0 16 * * *`
UTC). Validated data is backed up, then conditionally replaces
`pricing-current/aoai-pricing.json`. Failed/incomplete fetches never publish an
empty catalog. A renewable Blob lease serializes scheduled/manual executions.

- **Settings** (`/settings`): current snapshot, daily schedule, change summary,
  freshness, and paginated 90-day price backups.
- **Operations** (`/operations`): latest pricing run and explicit failure details.
- `POST /api/v1/pricing/sync`: starts a retry; HTTP 202 is not completion.
- `GET /api/v1/pricing/status` and `GET /api/v1/pricing/history?limit=10`.
- Prices are public USD retail rates, not customer bills. Model-to-deployment
  billing support is intentionally not enabled in this batch.

`pnpm dev` uses an explicitly labeled two-page local fixture and Azurite.
The Azure Job never accepts fixture prices or shared-key credentials. To run
the local fixture Job while Azurite is running:

```bash
pnpm build
pnpm sync:pricing:fixture
```

Azure synchronization uses a separate identity with access only to pricing
containers, operations data, and ACR pull. It has no Lighthouse or Graph access.
Storage continues to use Private Endpoint and has no public network access.

Price history is logically limited to 90 days. Storage lifecycle cleanup is
asynchronous, and the account's 30-day soft-delete window can retain recoverable
copies after logical expiry. The active price Blob is never age-deleted.

### Batch-3 deployment and verification

The third slice is deployed at:

- [Price settings](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/settings)
- [Pricing operations](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/operations)

Entra authentication remains required. Web revision
`aoai-cost-test-web--0000002` is healthy; the prior revision is inactive.
The image is pinned to
`sha256:98a260710d60d1fac4b972f1472585f4c18a4f7354ae899c4f8a30077ce18282`.

The verified Azure execution `aoai-cost-test-pricing-sync-et2a3cu` succeeded:

- 24 pages; 23,870 price records.
- Snapshot `57ff242c-44e1-494e-9460-6a45748875c4`.
- Active snapshot and history backup read back from the Web identity over
  the Storage private endpoint.
- No unrecognized units; deployment billing mappings remain unsupported
  until batch 4.
- Duration approximately 22 minutes. The Job has a 30-minute limit and the
  downloader a 25-minute deadline; monitor future execution durations.

Local end-to-end checks: **17 passed**. Azurite integration checks: **8 passed**.
Cloud browser automation was not performed; anonymous settings requests redirect
to Entra (302), and unauthenticated pricing API requests are rejected (401).
The 90-day lifecycle configuration was checked, not elapsed for 90 days.

To run a manual pricing sync without changing the daily schedule:

```bash
az containerapp job start \
  --subscription 7bdb0a57-7e53-4c61-b1f0-11ce66566bd1 \
  --resource-group aoai-cost-alert-test-rg \
  --name aoai-cost-test-pricing-sync
```

Batch-6 email delivery is not part of this release.

## Fourth slice: hourly collection with no-usage handling

The fourth slice is deployed:

- [Cost overview](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/overview)
- [MCT tenant usage](https://aoai-cost-test-web.mangoriver-4d3b2904.swedencentral.azurecontainerapps.io/tenants/92078590-b3a5-4c46-aaea-74360df451d0/usage)
- Collector Job: `aoai-cost-test-usage`, schedule `15 * * * *` UTC.
- Web revision: `aoai-cost-test-web--0000003`, healthy.
- Image digest:
  `sha256:80deb43778afd5642ad815424210d3c59eb67a996df836b8b435aadb052930ad`.

The Job discovers Cognitive Services accounts/deployments and reads Monitor
metrics using the existing Lighthouse Collector identity. It reads the active
retail price snapshot, runs the versioned decimal pricing rules, and stores
tenant/day JSON in the private `usage` container. The UI supports 24-hour/10-day
history, selecting a recorded hour, and subscription/resource/deployment details.
No inference requests or email are generated by collection.

The observed no-usage execution `aoai-cost-test-usage-qos5j7v` succeeded:
one enabled tenant processed, one pending tenant skipped, two accounts and two
model deployments discovered. The private Web identity read back a persisted
hour with `activity=noUsage`. It is **partial**, not a full zero-cost result:
only one of two expected subscriptions is currently visible, and the deployed
`gpt-6.1-sol` / `gpt-6-luna` pricing rules are not yet uniquely established.
Their input/output observations are retained; unknown charges are never
filled with zero.

Only the established GPT-4.1/mini/nano `2025-04-14` token-PAYG label contract is
currently price-matchable. Other models remain explicit `unsupported` results.
All amounts are retail estimates and marked
`awaiting-positive-usage-verification`. Positive-use amount comparisons are
deferred until traffic exists, as requested.

```bash
az containerapp job start \
  --subscription 7bdb0a57-7e53-4c61-b1f0-11ce66566bd1 \
  --resource-group aoai-cost-alert-test-rg \
  --name aoai-cost-test-usage
```

Local development remains `pnpm install && pnpm dev`; usage uses an explicitly
labeled empty fixture, not Azure traffic. Phase four received build/container/
Bicep and read-only empty-flow verification, not positive-usage acceptance tests.
Phase-six email remains out of scope.

## Fifth slice: tenant/subscription concurrency

The collection contract is **one completed natural hour per Metrics request
(`PT1H`)**. It does not combine three hours and does not automatically backfill
older hours. Resource/deployment/metric-definition discovery is cached per
subscription for two hours; cached resources still receive a fresh single-hour
Metrics query each run. Discovery timestamps are separate from hourly observation
timestamps. Read/metadata-change errors cause an early refresh on the next run.

Default controls:

| Setting | Default | Scope |
| --- | --- | --- |
| `USAGE_TENANT_CONCURRENCY` | 8 | Tenant workers per usage shard |
| `USAGE_SUBSCRIPTION_CONCURRENCY` | 8 | Subscription workers per tenant |
| `USAGE_ACCOUNT_CONCURRENCY` | 2 | Account workers per subscription |
| `USAGE_REQUEST_CONCURRENCY` | 32 | Combined Usage HTTP budget across all shards |
| `USAGE_SHARD_COUNT` | 1 | 1–16 independent tenant-hash shards |
| `USAGE_SHARD_ID` | 0 | Worker ownership |
| `USAGE_TIMEOUT_SECONDS` | 1200 | Stop starting work after this deadline |

Each shard limits HTTP concurrency to `floor(total budget / shard count)`.
Tenant, subscription and account pools do not multiply into uncontrolled Azure
requests. A failure stays attached to the affected tenant/subscription; other
work continues, and incomplete totals are never reported as complete zero cost.
Prices are indexed once per run. Per-tenant/hour writes are idempotent and retain
the original hour's threshold.

The Job produces lightweight overview views at
`usage/views/dashboard-24h/shards/<id>.json`. The API merges these views and
reports current/missing shard coverage rather than rereading every deployment
breakdown for every dashboard request. The UI shows configured concurrency,
observed peaks, request/retry counts, cache hits and duration. Hours remain
`provisional` unless a future explicit single-hour confirmation mechanism is
introduced; time passing alone does not promote them to `final`.

Bicep parameters `usageTenantConcurrency`, `usageSubscriptionConcurrency`,
`usageRequestConcurrency` and `usageShardCount` control the deployment. Increasing
shards distributes CPU/memory; increasing HTTP throughput still requires an
appropriate Azure request budget and quota.

Before changing the shard count, stop/drain all old executions and explicitly
reset `operations/usage-topology.json` from an authorized private-network
administrative environment. Runtime refuses a mixed shard topology. When reducing
shards, remove obsolete shard Jobs explicitly because ARM incremental deployment
does not delete them. No automatic resharding is performed.

Synthetic checks cover 300 tenants × 200 subscriptions, a 32-request cap,
two-hour cache reuse, one-hour-only queries, isolated failures and separate tenant
amounts. These are scheduling/correctness checks with local simulated latency,
**not** proof that every real Azure workload will complete within one hour.
Actual account/deployment counts, Azure latency and 429s must be monitored.
Runs exceeding 12 minutes emit a capacity warning before onboarding more tenants.

### Batch-5 deployed result

- Web revision: `aoai-cost-test-web--0000004` (healthy; prior revision inactive).
- Image:
  `sha256:0a1e3f5a97a7411f845e35c7ba74a155ce412e2bb89d1b0175d910021956639d`.
- Current deployment: one shard, tenant workers 8, subscription workers 8,
  account workers 2, combined management/Monitor HTTP budget 32.
- Execution `aoai-cost-test-usage-fy1hdjb`: one hour only, 6 management/Monitor
  requests, one discovery refresh, approximately 8.3 seconds of collection work.
- Execution `aoai-cost-test-usage-deieayt`: the same single hour, one cache hit,
  zero discovery refreshes, one new Metrics request, approximately 2.7 seconds
  of collection work. These timings exclude container startup.
- Both executions persisted results. Existing incomplete delegation/unsupported
  pricing rules still correctly produce `succeededWithWarnings` and partial
  tenant amounts; no false complete/zero result is manufactured.
- Synthetic pool/source tests: 9 passed, including 300 × 200 subscriptions.
  Azurite compatibility/idempotence/shard tests: 10 passed.

No real model traffic was generated and no large-scale Azure throughput SLA was
claimed. Hourly billing correctness for currently unsupported deployed models
still requires their pricing rules and real usage validation.

## Sixth slice: alerts, Outbox and guarded email

The application implements first-breach alerts, six-hour reminders, estimated
recovery on a **new complete non-breaching hour**, and grouped data-quality
events. Partial/failed/old hours never produce recovery. This policy does not
promote an hour to `final` or claim invoice accuracy.

- Notification settings: `/settings` → **告警与邮件**.
- Delivery states and manual unknown handling: `/operations` → **邮件 Outbox**.
- Tenant pages include the immutable alert-event timeline.
- Notifications default off with no recipients; prototype addresses are not
  copied into production.
- `pending` decision journals are completed before alert state advances.
- `accepted` means Graph returned 202, not that the recipient received mail.
- Submission timeouts become `unknown`; no automatic resend.
- `previewed` means no Graph send request was made.
- Collector has no Graph mail permission. The separate dispatcher
  `aoai-cost-test-mail` runs every two minutes with at most two sends in flight.

### Current real-send status

Mailbox authorization and real delivery were verified on **2026-10-04**.
The administrator completed the Exchange prerequisite; `IsDehydrated=false`.
The dedicated mail identity has `Application Mail.Send` in the
`aoai-cost-test-sender` scope, which contains only `chx@ms-ext.biz`.

Both Web and the mail Job now have `mailAuthorizationReady=true`. Preserve this
parameter when redeploying the authorized instance; the Bicep default remains
false to protect new environments. No organization-wide Graph `Mail.Send`,
mail-reading permission or blanket transport rule was added.

Mail identity:

```text
Client ID:    75e85cd3-0e53-49b0-8aab-5f54b24893e0
Principal ID: 66c68b46-0d51-49b5-8175-5bcf2dd4f199
```

For a new instance, after an Exchange administrator approves the organization prerequisite, use
[`configure-mailbox-rbac.ps1`](infra/bicep/scripts/configure-mailbox-rbac.ps1)
to grant `Application Mail.Send` to the exact sender mailbox, review the
dedicated-sender/recipient-restriction policy, then redeploy with
`mailAuthorizationReady=true`. Save real operations recipients and enable
notifications only after a real test has been verified.

Automatic notifications in the current test instance are **enabled**, with
`chx@ms-ext.biz` as the sole operations recipient, as confirmed by the user.
The persisted configuration was read back successfully (revision 2).
Disabled-period events are not replayed; subsequent evaluations use the enabled
configuration.

The application currently permits recipients in `ms-ext.biz` only. Existing
normal mailbox transport behavior is unchanged. A dedicated-sender/Exchange
recipient-restriction review remains a production rollout prerequisite, not a
completed production security acceptance item.

### Local verification

`pnpm dev` uses `MAIL_MODE=preview`. Preview tests exercise the persistent
Outbox without sending mail. The verification includes:

- Five alert decision tests.
- Eighteen API/auth/configuration tests.
- Fifteen Azurite integration tests, including decision-journal crash recovery,
  duplicate suppression, expired claims, preview and uncertain Graph outcomes.
- Eighteen local browser end-to-end tests, including saved notification
  configuration and preview persistence.

Actual email acceptance and delivery are now verified as recorded below.
Positive-usage billing validation remains deferred until model usage exists;
the currently deployed models' pricing rules remain unsupported.

### Batch-6 initial preview checkpoint

- Healthy Web revision: `aoai-cost-test-web--0000006`.
- Image:
  `sha256:d071238ee6676e98e4364d8fc3307c73664b16f08b25c24d51afaabd785fecd2`.
- Cloud preview execution: `aoai-cost-test-mail-vvvswer`, `Succeeded`.
- Preview event:
  `95e7a0c0e072600199a3b4fbadfab653b9660710e68f693f71d5f451f9dac30b`.
- Result: one previewed event, zero Graph-accepted emails, zero sending errors.
- At this checkpoint, real sending was disabled and the recipient list was empty.
- The mail identity has no organization-wide Graph app-role grants.

### Batch-6 real-mail verification

- Web revision at this verification checkpoint: `aoai-cost-test-web--0000010`;
  the subsequent registration-deletion release below supersedes it.
- Mail execution: `aoai-cost-test-mail-s7qfq4n`, `Succeeded`.
- Sender and test recipient: `chx@ms-ext.biz`.
- Test subject: `[AOAI][发信授权测试][ee35e8addd] 发信验证`.
- Event: `ee35e8addd7ff30df640c10978ce253a17a7fc64875874efc31ebd4ab3650f17`.
- Persisted result: `accepted`, one submission attempt; Graph request ID
  `9d60244d-baeb-4a70-a3fe-29d978c2009c`.
- Exchange message trace: **Delivered**, received at
  `2026-10-04T15:39:22.883Z`; trace ID
  `4587e4e5-1b0b-4012-89bf-08df222da9e0`. The user also confirmed mail works.
- The application Outbox remains `accepted`: external trace confirmation does
  not change the meaning of Graph 202 or automatically mark other mail delivered.
- Automatic notifications are enabled; the mail Job checks the queue every two
  minutes. No duplicate test or real model traffic was generated during closure.

Batch-6 application functionality and controlled real-mail delivery are verified.
Production hardening and positive-usage cost validation are separate remaining
work; batch 7 has not started.

## Deleting a waiting-authorization registration

In **租户与授权**, a tenant in **等待客户授权** has a **删除登记** action.
After confirmation, the server deletes its current
`configuration/tenants/<tenantId>.json` Blob directly; it does not create an
archived `deleted` tenant. The same ID can be registered again.

Only pending tenants with no current or expected delegated subscriptions can
use this action. Authentication, same-origin JSON, a single current `If-Match`
and the authorization-sync tenant lease protect the operation. State changes
and stale views are explicitly rejected. Audit records and historical costs
remain subject to their existing retention, including Storage soft deletion.

This is not Lighthouse revocation. An existing delegation can still be
rediscovered by authorization sync as a tenant requiring configuration and
enablement; authorized tenants must continue to use **解除管理**.

### Verified release (2026-10-05)

- Web revision at this registration-deletion checkpoint:
  `aoai-cost-test-web--0000011`; the shared-definition fix below supersedes it.
- Immutable Web/Authorization Sync/Usage Collector image:
  `sha256:2114ba02bdce911912b37cb326639d68740363b4d234ea411558ce3aa208ad3f`.
  Job schedules and concurrency configuration were not changed.
- The operations capability card no longer shows **第六批** or the outdated
  mailbox-authorization blocker; it links to the actual notification settings.
- Full workspace build passed; 91 focused API/schema/lifecycle/Blob checks and
  all 15 selected browser scenarios passed. The confirmation fits 1440px desktop
  and 1024px tablet layouts.
- Private-cloud validation created and deleted only synthetic pending tenant
  `8176e7fa-f403-4d22-ad5f-63b93b07a6e1`: its current configuration Blob no
  longer exists, lookup returns not found, and requested/completed audit is
  recorded. No existing customer registration or delegation was deleted.
- Notification settings remain enabled, sole recipient `chx@ms-ext.biz`,
  revision 2; real-mail readiness remains true. No test mail or model call was
  generated by this release.

## Delegation-driven offboarding and re-onboarding

The **租户与授权** page now has **解除管理** actions for a tenant and its individual
subscriptions. These actions explain how the **customer's subscription Owner**
can revoke this application's Lighthouse assignment in Azure. The subsequent
separate-identity release also supports partner-initiated removal after the
customer explicitly grants the additional assignment-delete role. Collector
remains Reader; the customer-side flow remains available for legacy grants.

- A complete successful subscription enumeration plus a separate access check
  must confirm that the Collector no longer has access before a subscription is
  removed from both the current scope and its expected-subscription set.
- Generic authentication failures, timeouts, throttling, failed pagination,
  policy errors, and unrecognized responses preserve the previous state and
  produce an explicit synchronization warning.
- Disabled-but-visible subscriptions are retained but are not collected.
- Removing the last delegated subscription archives its tenant under
  **已解除管理**. Configuration and historical hourly costs are preserved.
- Reauthorizing an archived tenant returns it to **已发现待启用**, not directly
  to active. **重新登记** is also available but only creates a pending
  authorization state. A restored subscription within a still-active tenant
  is automatically included after verified rediscovery.
- Cache reuse and in-flight commits are fenced by the current authorization
  scope. Removed tenants are filtered out of stale dashboard views, and
  unsubmitted pending notifications for removed tenants are suppressed.

Current subscription JSON remains backward-readable; removal records are stored
in `inventory/tenants/<tenantId>/removed-subscriptions.json`. This is application
history, not deletion of the customer's Azure subscription or model deployments.
Existing hourly cost records are not retroactively reduced when scope changes.

### Verified release

- Healthy Web revision: `aoai-cost-test-web--0000008`.
- Image: `sha256:e27b55e6f032ed9bfc24277d24b79e6fb2dff7b47312f462bd1f02f30901b193`.
- Local browser tests: 21 passed; API tests: 19 passed; lifecycle state tests:
  13 passed; Azure authorization/source and collector tests: 20 passed;
  Azurite integration tests: 17 passed.
- Real read-only synchronization
  `aoai-cost-test-auth-sync-5znoedk` succeeded with zero errors. It removed the
  **previously revoked** `Pay-As-You-Go-TEMP` subscription from the expected set,
  retained `fte`, and restored the MCT tenant's authorization status to active.
- The actual revoked subscription returned `InvalidAuthenticationTokenTenant`.
  This special 401 is recognized only for a customer subscription absent from
  a completed discovery using the same managing identity. Ordinary 401 failures
  do not count as proof of access removal.
- No customer delegation was revoked or customer permission expanded during
  this release. The real-mail authorization switch remains false.

See the updated [administrator/customer handbook](docs/operations-handbook.md)
for the click-by-click offboarding and re-entry steps.

## Separate identity for partner-initiated offboarding

```text
Name:         aoai-cost-test-offboarding-id
Client ID:    bc8b791b-d940-4288-b43e-12c9c024e1a0
Object ID:    b6d610ba-5411-45d0-ac84-295f43265881
Customer role: Managed Services Registration assignment Delete Role
Role ID:      91c1777a-f3dc-4fae-b103-61d183457e46
```

This identity is attached only to Web and protected by a CanNotDelete lock.
It has no partner Owner/Contributor, Storage data or Graph grants. The
existing Collector still has Reader. Creating the identity does **not** change
existing customer permissions.

Customers must redeploy
[`infra/lighthouse/subscription.bicep`](infra/lighthouse/subscription.bicep)
with the new `offboardingPrincipalId`, keeping the original managing tenant,
Collector and offer name. The template preserves the registration IDs; its
authorization list retains Collector Reader and adds the new deletion identity.
At the initial separate-identity release, `fte` was still Reader-only and a
read-only preview returned `CUSTOMER_REAUTHORIZATION_REQUIRED`. On 2026-10-05,
read-only verification confirmed that the customer had added the offboarding
identity to both `fte` and `Pay-As-You-Go-TEMP`. TEMP reuses the subscription-level
definition in `fte`; this does not require deleting or redeploying that definition.

After customer authorization, choose **解除管理 → 检查解除权限并预览**, review
the target subscriptions, type the tenant/subscription ID, then confirm.
The backend accepts only the exact application offer and principal/role pair,
revalidates it before deletion, and records per-subscription results. It never
deletes the Azure subscription or model deployments. A deleted delegation
cannot be recreated by the offboarding identity; customer reauthorization is
required.

An assignment must be in the requested subscription. Its definition may be in
another subscription in the **same verified customer tenant**; the managing
tenant, customer tenant, exact offer and two principal/role pairs must still
match. Only the assignment is deleted. Shared definitions, other subscriptions,
overbroad grants and changed previews are not deletion targets.

Previews expire after ten minutes and belong to the initiating operator.
Confirming one operation invalidates older previews for that tenant; retries
of a consumed operation do not replay DELETE. Failures, timeouts and partial
results remain explicit. After a submission, synchronize authorization to
confirm access loss before treating the object as removed.

Verified locally: 16 deletion-scope tests, 20 API tests, 22 Azurite integration
tests, and 23 browser E2E tests. Real customer delegation deletion was
intentionally not performed.

Initial separate-identity Web revision: `aoai-cost-test-web--0000009` (Healthy; prior revision
inactive). Image:
`sha256:079f5636787b50ccfce7e0c144ea13415da99265c9d02f52579a64f9ae55ef8e`.
Existing jobs, Collector identity and real-mail protection were not changed by
this Web-only rollout.

### Shared-definition fix and price verification (2026-10-05)

The TEMP assignment references the definition in `fte`, in the same customer
tenant. An overly strict same-subscription definition check incorrectly
reported `DELEGATION_NOT_UNIQUE` with zero matches. The fix permits this valid
subscription-level reference while retaining exact assignment scope, tenant,
offer, principal/role, uniqueness and fingerprint checks. It never deletes the
shared definition.

- Web revision at this shared-definition checkpoint:
  `aoai-cost-test-web--0000012`; the editable-settings release below supersedes it.
- Image: `sha256:e937df0aa9e5ca4216675d5b5fe074a7378f487afe5f96c02470c097775b743a`.
- Azure package/API build and 56 focused scope, journal and API checks passed.
- Actual Azure previews for TEMP and `fte` both returned `ready` after deployment.
  Verification used exactly two ARM GETs, zero DELETEs; customer delegation was
  not revoked. Scheduled jobs were not changed.
- Mail remains enabled to `chx@ms-ext.biz`, revision 2, authorization readiness
  true; private Blob readiness returned HTTP 200.

The public Retail Prices API was also re-read completely: **24 pages / 23,870
records**. Exact `6-luna` SKU labels exist (312 records; 16 in Sweden Central);
the current Blob price snapshot already contains them. Standard Global ordinary
input/output rates per million tokens are USD **0.10/0.50** for `ShortCo` and
**0.20/0.75** for `LongCo`, with additional cached-input/cache-write meters.
These records use service name `Foundry Models`; filtering only
`Cognitive Services` would miss them.

No exact `6.1-sol` price label was found. `6-sol` is present, but is **not** a
verified alias for the deployed `gpt-6.1-sol`. The application still reports
unsupported rules: it currently validates only GPT-4.1 mappings, and Luna's
context/cache-write split has not been implemented. Catalog presence is not
billing readiness; no guessed price or zero-cost fallback was enabled.

## Editable settings and SKU JSON download (2026-10-05)

- **设置 → 告警与邮件 → 发件邮箱** is now editable and stored in
  `configuration/alerting.json`. Changing it closes automatic notifications;
  mailbox-scoped Exchange authorization and a real accepted test are required
  for a new sender before explicit re-enable. Verification is bound to the mail
  managed identity. Web never grants mailbox permissions.
- **设置 → 当前价格快照 → 下载精简 SKU 价格 JSON** exports `aoai-pricing.json`,
  the compact official query catalog plus manual fallback heads. A separate
  **下载原始/审计快照** exports the complete `aoai-pricing-raw.json`, including
  every raw SKU/meter/unit/region/public price and unsupported service records.
  Both require authentication and private Blob access; no public access or SAS is added.
- **租户与授权 → 管理中 → 编辑** and tenant details allow changing the name and
  hourly USD limit. JSON writes require authentication, same-origin JSON,
  current ETag and the tenant authorization lease. Authorization/status/history
  are not rewritten; new calculation windows use the new limit, while existing
  hours keep their recorded threshold even on retries.

Editable-settings checkpoint: `aoai-cost-test-web--0000013`, Healthy, 100% traffic; revision
`0000012` is inactive. Web, Usage Collector and Mail Dispatcher use immutable image
`sha256:60e38c644aad93a37ced7b8779e36ecec5dabee95d94b6e3e8bb319d2991d75e`.
Web binds `MAIL_IDENTITY_CLIENT_ID` to the existing dedicated mail identity.
Other jobs and schedules were not changed.

Validation: workspace/Bicep builds, 62 sender/download checks, 58 tenant-edit/
history/API checks, and 20 + 14 focused browser scenarios passed. Settings layout
fits 1440px, 1024px and 320px. Live private export was validated as a complete
**24,883,951-byte / 23,870-entry** snapshot; anonymous download returns HTTP 401.

As requested, the existing sender remains `chx@ms-ext.biz`, notifications remain
enabled to the same recipient, and mail settings stay revision 2. No historical
mail migration/cleanup or new real test email was performed. Live MCT configuration
was read back with its current **USD 1.00/hour** limit and was not modified.

## Corrected model names in pricing JSON (2026-10-05)

The first export reused parser-v1 metadata, which recognized only a narrow
GPT-4.1 grammar: **23,197 of 23,870** entries had no model name. Parser v2 now
describes explicit SKU models independently of the deployment billing whitelist.
It resolves current GPT5/6 labels and confirmed compact/media/reasoning/OSS/
embedding aliases, and does not invent `gpt-6.1-sol` pricing from `6-sol`.

These descriptive-model corrections remain available in
**设置 → 当前价格快照 → 下载原始/审计快照**:

- Root `models`: **89** identifiable catalog model names.
- `entries[].modelName`: **23,527** model-specific price rows now have names.
- `entries[].modelIdentityStatus`: `identified` or `shared-service`; the remaining
  **343** rows are generic capacity, tool or free-service meters, not missing
  model descriptions. There are zero unexplained unnamed model-specific rows.
- Raw SKU, meter, prices, units and region fields remain present.
- Model identification does not approve previously unsupported billing rules.

Model-index checkpoint: `aoai-cost-test-web--0000014`, Healthy, 100% traffic;
revision `0000013` is inactive. Web, Pricing, Mail and Usage share image
`sha256:a197bd421bb32bff2a1b100fa92363748c0650a41fa78ff4bfd343aef3a937c3`.
Build, 120 targeted checks and three download browser cases passed.

## Compact query catalog and manual missing-price fallback (2026-10-05)

The collector now reads the compact official file, not the 25.9 MB raw snapshot.
Default **下载精简 SKU 价格 JSON** exports that catalog as `aoai-pricing.json`;
**下载原始/审计快照** preserves the complete source as `aoai-pricing-raw.json`.
The original active and historical raw Blobs remain private and unchanged.

- Live compact export: **1,928,511 bytes**, down **92.56%** from 25,931,946 bytes.
  It contains 2,219 token-rate groups covering 72 model names and 19,566 exact
  region/meter references. Non-token/training/shared-service records remain in
  the full audit export, which still describes 89 catalog model names.
- USD prices are normalized to **1M tokens**. Regions merge only when price and
  billing conditions match. Latest already-effective SKU dates are used; future
  prices are never applied early. Only a just-effective rate's necessary
  predecessor is retained for the pending completed-hour calculation, so a
  midnight refresh cannot erase the previous hour's valid price.
  Snapshot and fetch-time provenance stay intact.
- **设置 → 手动价格 · 缺价备用** supports create/edit/disable for text token models:
  exact model name, optional version, deployment SKU, selected regions by default
  or explicit all-region scope, input/output USD/1M, and source notes.
- **Official-first:** an applicable official token price prevents manual override,
  even if that official model's context/version mapping is still unsupported.
  Manual uniform input/output estimates are used only when official prices are
  missing; cached input uses ordinary input price. Special audio/image/Realtime/
  embedding billing is not treated as uniform text tokens.
- All mutations are authenticated, same-origin, ETag/lease guarded and
  audited to versioned JSON. Changes start at the next full hour. Existing hours
  retain their costs and source references; details and alert emails disclose
  manual estimates. No invented manual price was entered in production.

Exact-source verification checked all **19,566** retained prices and **171**
existing GPT-4.1 model/SKU/region cost cases with **zero differences**.
Local median parse + schema validation improved **231.2 → 24.9 ms**; this is a
local benchmark, not a claim about Azure throughput. Workspace build/typecheck,
**203** focused domain/Blob/API cases, **25** browser scenarios and desktop/tablet
visual checks passed.

Compact/manual checkpoint: `aoai-cost-test-web--0000016`, Healthy, 100% traffic; revisions 14/15 inactive.
Web, Pricing, Usage and Mail share immutable image
`sha256:6e754628a94a17f1d60c07d3a8cb7d89352b51aa74e3fa323bd06e3e74c1bf94`.
One-time metadata-only bootstrap `aoai-cost-test-pricing-sync-y41qm7w` succeeded
without changing the original price fetch time; its flag was not persisted.
Real single-hour collection `aoai-cost-test-usage-jkauci4` persisted rule version 2
without a pricing-read error. Remaining warnings are the pre-existing unsupported
official model mappings, not missing compact data.

Sender/recipient `chx@ms-ext.biz`, enabled mail settings revision 2, the customer's
USD 1/hour limit, schedules and identities remain unchanged. Paid model tests
remain paused; this release made no inference calls and sent no test email.

Live file verified: snapshot `cd43d7bd-1999-4926-87f1-20ba706c57f0`, parser 2,
**25,931,946 bytes**, fetched from Retail Prices at
`2026-10-05T04:53:17.375Z`. A full-template metadata-only execution also verified
idempotence; the scheduled Job still fetches retail prices at its original cron.
Current mailbox/configuration remains unchanged, and paid model tests remain
paused as requested.

## Model-independent pricing adapters (2026-10-06)

Pricing rule version **3** removes the GPT-4.1-only model/version allowlist.
The official catalog, not source-code model names, drives cost calculation.
An unseen model with the same recognized billing contract is picked up after
pricing sync and resource discovery without adding a per-model implementation.

- Match the real model/version, PAYG SKU, region, response tier, effective hour,
  direction and token unit. Confirmed SKU spelling aliases are decoded separately
  from eligibility; unknown identifiers are not guessed. Input-only embeddings,
  token-priced text/audio/image variants, priority/flex and explicit Batch SKUs
  use the corresponding conditions, not the cheapest unrelated offer.
- Compact **v2** lives at `pricing-current/compact/v2/<snapshotId>.json`.
  Consumers can read existing v1 compact artifacts during rollout; neither path
  silently falls back to downloading the full raw file. Scheduled official rates
  already present in a snapshot activate at their effective usage hour, not early
  and not one daily refresh late.
- Where hourly Monitor totals lack request context/modality/cache-write details,
  store `costUsd/costUpperUsd`, real source meter references and uncertainty reasons.
  The UI, chart, timeline and email show the same **retail-estimate range**.
  Hourly accumulated input is never treated as one request's context length.
  Cached reads retain the declared ordinary-input conservative policy; known
  writes replace ordinary input, while unknown writes are included in the upper estimate.
- Breach only when the known estimate lower bound exceeds the captured limit;
  recover only on a new complete hour whose upper estimate is also within it.
  All values are USD retail estimates, not a confirmed Azure invoice.
- Official prices always win over manual fallback. Missing directions/units are
  explicit partial subtotals, never zero-priced complete amounts. Non-token
  images/seconds/capacity hours, training/hosting and wholly new billing protocols
  require corresponding measurable usage; no system can safely derive those
  charges from input/output token totals alone.

### Audited missing-hour repair

Only a retained, completed, real provisional hour with a previously missing amount
can be repriced. Its original price snapshot, token counts, collection timestamp
and captured threshold are preserved; already known or finalized amounts are not
overwritten. Before/after JSON audit is stored at
`operations/usage-repricing/<auditId>/`, and retries resume idempotently.

For an operator-controlled one-time execution, use the complete current Usage Job
template with `USAGE_OPERATION=reprice`, `USAGE_REPRICE_TENANT_ID=<tenant UUID>` and
`USAGE_REPRICE_WINDOW_START_UTC=<exact original hour>`. Do **not** persist these on
the scheduled template. It performs no inference, multi-hour query or default backfill.
A new historical breach event is labelled **历史小时补算**, does not rewind the
current alert state, and is only deliverable if the current mailbox/recipient
configuration was already enabled before that hour; otherwise it is recorded as
suppressed. Existing event IDs prevent duplicate delivery.

Validation: **85** queryable token-pricing model names, **20,765** exact regional
source rates verified with zero price/unit differences; unseen model names and
versions, media/context ranges, cache charging, original-snapshot repair and
safe breach/recovery are covered by tests. **130** domain, **39** Blob integration,
**55** API, **16** concurrency/history cases and **28** browser scenarios passed,
with workspace build/typecheck and desktop/tablet rendering checks.

The existing 09:00–10:00 Beijing test still contains exactly **2,835 input /
37,785 output tokens**. Its generic Monitor-only range is
**USD 1.739502–2.680713**, already above the captured USD 1 limit at the lower end.
Independent request evidence (short context, zero cache reads/writes) gives the
same **USD 1.739502** point estimate. This range does not mean new test spending:
no additional paid model requests were made for this implementation.

Final release: **`aoai-cost-test-web--0000018`**, Healthy, 100% traffic; revisions
16/17 retired. Web, Pricing, Usage and Mail use immutable image
`sha256:4c6842be448fa920fb07b309bd48d078ca20f6566df92d630f6d5ea3176c6a22`
(ACR run `dtm`). The no-data/empty-billing-slice boundary was additionally tested;
ordinary execution `aoai-cost-test-usage-tviuluv` completed **succeeded**, one exact
PT1H window, zero issues and the unchanged two-hour discovery cache.

Private migration `aoai-cost-test-pricing-sync-ix5plgx` preserved actual pricing
fetch time `2026-10-05T16:00:35.922Z`; parser-3 active snapshot is
`9dd99753-7b2a-4f0b-a82f-28453bf6cc7b`. The original
`18fcf1ae-dcc6-43c0-ad5e-29fd7ea4ee73` compact snapshot remains available for the
existing test hour. Audited repair `aoai-cost-test-usage-qm3wi3c` preserved all
observed usage and the USD 1 threshold, with before/after audit
`02d84eb7-5a8d-40ca-ba6c-091b60e84030`.

The legitimate historical breach event
`f63c2a575fd47a511587fbc826e469159a658b66db770e283fb3f3f9998284a3`
was **Graph accepted**, exactly **one** attempt, from/to `chx@ms-ext.biz`.
This confirms actual submission, not independent mailbox delivery. Tenant/mail/
manual-pricing JSON hashes were read back unchanged; mail remains enabled at
revision 2 and both user-entered manual rules remain revision 2. One-time
metadata/repair flags were not persisted on any scheduled Job; anonymous pricing
download remains HTTP 401. No new inference or synthetic test email was used.

## Models - Usage primary counters (2026-10-06)

New collection uses **`InputTokens` / `OutputTokens`** from **Models - Usage**,
with strict `ModelDeploymentName`, `ModelName` and `ModelVersion` dimensions.
`ProcessedPromptTokens/GeneratedTokens` remain historical provenance only;
there is no silent fallback, addition of both counter sets or double-counting.
Each request is still exactly one completed natural hour, `PT1H`, `Total`.

OpenAI and Foundry `AIServices` accounts, including non-OpenAI model formats,
can now retain their token observations. **The official Retail Prices filter
and stored catalog remain Azure OpenAI-only; no other provider price was added.**
An unpriced model keeps its usage with a null amount, and an applicable
user-entered manual rule can estimate it later.

The new `modelsMetricDimensions` cache is stored separately from legacy
`metricDimensions`; baseline inventory stays rollback-readable and the two-hour
resource-discovery cache is preserved. New records carry
`metricFamily=models-usage`, shown in the UI. Old hours are not rewritten.
Missing actual service-tier information is represented by the range of existing
applicable offers, not assumed Standard; the existing lower-bound breach and
upper-bound recovery policy remains unchanged. The preview
`FoundryModelEstimatedCost` metric is not used as the authoritative cost source.

Models migration release: **`aoai-cost-test-web--0000019`**, Healthy, 100% traffic,
with Web/Usage/Mail immutable image
`sha256:4cb8cb7816f81075b4abf0004e4a2b31eabe5b86279b3f525fa6b5cb507ed168`
(ACR `dtn`). The Pricing Job remains on its existing image and its
`contains(productName, 'Azure OpenAI')` filter was not changed.

Validation: **68** focused domain, **13** source/concurrency, **28** Blob cache/
history/mail, **55** API and **14** browser scenarios passed, with workspace
build/typecheck. A read-only one-hour probe under the actual Collector identity
(`aoai-cost-test-usage-4pzr4if`) asserted exact existing-test parity for all three
models, model versions, and **2,835 input / 37,785 output tokens** without writes.
Ordinary collection `aoai-cost-test-usage-him0fw0` succeeded, one PT1H window,
zero issues, and the persisted hour/observations now carry `models-usage`.
The existing discovery cache was reused; only the independent Models dimension
cache needed its initial refresh.

Production price Blob ETag, manual/mail/tenant JSON hashes and the original
09:00 test-hour hash were read back **unchanged**. No Grok or other provider price
was inserted, no historical hour was replayed/repriced, and no inference or test
email was generated by this migration.

## Clear breach amounts and no cost-recovery email (2026-10-07)

Cost recovery still resets the internal state and remains in the event timeline,
but its Outbox is **suppressed**, not sent. Dispatcher also blocks legacy queued,
unsubmitted recovery mail. A later breach still produces a new first alert;
data-quality recovery notifications are unchanged.

Breach/reminder subjects and body summaries now contain the **USD estimate/range**,
hourly limit, Beijing window and readable data status. The existing final-test
event previews as `USD 1.13912–1.856737`; partial amounts remain known subtotals,
unknown upper bounds are explicit, and the estimate is never presented as a bill.

Release: **`aoai-cost-test-web--0000020`**, Healthy, 100% traffic, with Web/Usage/Mail
image `sha256:926e14b262e18bb546739ad8b8bec0cd1b303c11ba793e714cf301c40edef4e4`
(ACR `dtq`). Focused unit, Blob/API integration, browser and build/typecheck checks
passed. Private readback confirmed the deployed template/policy, unchanged prices,
tenant/mail/manual settings, and the original test hour/event. Normal Mail execution
succeeded without errors. No inference or synthetic email was used for this change.
