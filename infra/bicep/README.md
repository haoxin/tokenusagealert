# Infrastructure through batch 6

Implementation baseline: **2026-10-06**. The templates describe Web plus four
scheduled Job classes: Authorization Sync, Usage Collector (optionally sharded),
Pricing Sync and Mail Dispatcher. They do not deploy anything automatically.
The batch headings below describe how these resources were introduced, not
separate descriptions of the currently active release.

## New partner installations

Use the [partner installation guide](../../docs/partner-installation.md) and
[public-profile parameter example](./partner-public.parameters.example.json).
The existing instance already uses Consumption; the optional profile simplifies
networking, not the billing model:

| `storageAccessMode` | Environment | Blob network | VNet / Private Endpoint / DNS |
| --- | --- | --- | --- |
| `private` (default) | Existing VNet-integrated Consumption configuration | Public disabled | Deployed |
| `public` | Consumption profile with Azure default networking | Public HTTPS enabled | Not deployed |

Both retain `allowBlobPublicAccess=false`, `allowSharedKeyAccess=false`,
container-private access, managed identities, RBAC and Entra protection.
Use a **fresh installation** for the public profile; never flip the network mode
on the existing instance. Consumption still has the Web's minimum one replica.

Set `mailSenderMailbox` and `mailAllowedRecipientDomains` to the new partner's
values; these are passed consistently to Web, Usage and Mail. Defaults preserve
the original instance only. `mailAuthorizationReady` remains false until scoped
Exchange authorization is verified. No cloud resource was changed by adding
these template options.

Run `pnpm test:infra` with Azure CLI/Bicep installed to compile both entry points
and check network branches, private defaults, identity-only storage, partner mail
wiring, bootstrap parameters and unchanged Job schedules. These are offline
template contracts, not proof that another subscription's policies allow deployment.

## Resources

- Separate user-assigned identities for Web, Collector, Pricing, Mail and
  offboarding; Authorization Sync uses Collector.
- Storage with `configuration`, `audit`, `inventory`, `operations`,
  `pricing-current`, `pricing-history` and `usage` containers.
- Container-scoped data roles: Web writes configuration/inventory/audit/operations
  and reads prices/usage; Collector writes configuration/inventory/audit/operations/
  usage and reads current prices. Customer-side Collector permission is Reader.
- Pricing writes the two price containers and operations. Mail reads configuration/
  current pricing and writes operations; scoped Exchange authorization is separate.
- Scheduled/on-demand Jobs for all four classes. Web Jobs Operator grants are
  scoped to each specific Job, including every configured Usage shard.
- In private mode: VNet-integrated Container Apps environment, dedicated
  infrastructure subnet, Storage Blob private endpoint and private DNS.
- Azure Container Registry with managed-identity pull, Log Analytics,
  workspace-based Application Insights and externally accessible Web.
- Shared lifecycle policy for pricing, usage and terminal mail/run records;
  not a universal retention policy for all configuration/audit/inventory data.
- Offboarding identity attached only to Web, with its own `CanNotDelete` lock.
  The template does not declare a Collector identity lock.

| Job class | UTC schedule | Timeout (seconds) | Platform retry limit |
| --- | --- | --- | --- |
| Authorization Sync | `10 * * * *` | 900 | 2 |
| Usage Collector | `15 * * * *` | 1,500 | 1 |
| Pricing Sync | `0 16 * * *` | 1,800 | 1 |
| Mail Dispatcher | `*/2 * * * *` | 420 | 1 |

Each Job has parallelism/completion count one. Usage has a separate 1,200-second
work deadline. The template uses one `containerImage` parameter for Web and Jobs;
a compatible rolling release may temporarily have different pinned digests.
The latest Models migration updated Web/Usage/Mail without updating Pricing.

For the existing/private profile, Storage public networking is disabled. Web
reaches the standard Blob endpoint through `privatelink.blob.core.windows.net`.
The public profile instead reaches that endpoint over public HTTPS. Anonymous
access and Shared Key remain disabled in **both** profiles.

In private mode, pricing depends on the Blob DNS VNet link and endpoint DNS zone
group; those resources are conditionally absent in public mode. It reuses the storage account, registry and
Container Apps environment without changing network policy or existing roles.
The pricing identity receives no customer subscription, Lighthouse, or Microsoft
Graph access.

## Batch-3 automatic pricing sync

[`pricing.bicep`](./pricing.bicep) creates `${namePrefix}-pricing-sync` when
`deployWebApp=true`, using the same immutable image as Web and Authorization Sync.
The prefix's 18-character limit keeps the Job name within 32 characters.
Bootstrap still creates the pricing identity, containers, data-plane grants,
ACR Pull grant, and lifecycle policy; it skips the Job and its operator grant.

The scheduled Job runs `node /prod/pricing-sync/dist/index.js` at
`0 16 * * *` UTC (daily at 00:00 Beijing time). It uses a 1,800-second timeout,
one retry, parallelism one, one required completion, 0.5 CPU, and 1 GiB memory.
It automatically synchronizes Azure Retail Prices with `NODE_ENV=production`,
`PRICING_SOURCE=azure-retail`, the standard storage Blob endpoint,
`MANAGED_IDENTITY_CLIENT_ID` set to the pricing identity, and
`BLOB_AUTO_CREATE=false`. Public Retail Prices access needs no API credentials;
Blob access remains private and uses managed identity.

Web retains its existing `AUTH_SYNC_*` configuration and receives
`PRICING_SYNC_MODE=job`, `PRICING_SYNC_JOB_SUBSCRIPTION_ID` from the current
deployment subscription, `PRICING_SYNC_JOB_RESOURCE_GROUP` from the current
resource group, and `PRICING_SYNC_JOB_NAME` from the module output. Its new Jobs
Operator grant (`b9a307c4-5aa3-4b52-ba60-2b17c136cd7b`) is limited to this Job;
Web has only Reader, not Contributor, on the price containers.

Both [`main.bicep`](./main.bicep) and
[`test-subscription.bicep`](./test-subscription.bicep) expose `pricingJobName`
(empty during bootstrap), `pricingIdentityClientId`, and
`pricingIdentityPrincipalId`.

### Pricing retention

The sync application must write each immutable backup to a new
`pricing-history/YYYY/MM/DD/aoai-pricing-<fetchedAt>-<uuid>.json` Blob, never
overwriting an existing backup. This unique-name contract makes last-modified
age suitable for history retention; it is not a storage-account WORM policy.
Only terminal run records belong at
`operations/runs/pricing/history/<uuid>.json`.

| Prefix | Current Blob | Previous versions |
| --- | --- | --- |
| `pricing-history/` | Delete after 90 days since last modification | Delete after 90 days since version creation |
| `pricing-current/` | Never lifecycle-delete the active price Blob | Delete after 30 days since version creation |
| `operations/runs/pricing/history/` | Delete after 30 days since last modification | Delete after 30 days since version creation |

The new rules do not match pricing locks/latest records, authorization data, or
other operations history. Existing account-wide versioning and 30-day Blob soft
delete remain enabled. Ninety days is the logical backup retention threshold,
not a guarantee of physical erasure on day 90: lifecycle execution is
asynchronous, and soft delete can retain deleted data for up to 30 additional
days after deletion. Physical retention can therefore exceed 120 days when
lifecycle processing is delayed. The same delay and soft-delete distinction
applies to the 30-day rules.

### Preserve existing lifecycle rules

Azure Storage lifecycle policy updates replace the whole policy, not individual
rules. There was no policy resource in the earlier local template; this does not
prove the deployed account has no cloud-only policy.

Before any deployment, read the target account's current `default` management
policy using an authorized read-only account. Both entry points require
`existingStorageLifecycleRules` explicitly, with no empty default. Supply the
complete current `policy.rules` array, including cloud-only rules. Use `[]` only
for a fresh account or after confirming the policy does not exist; do not treat
an authorization, connectivity, or other lookup failure as an absent policy.
Refresh this input immediately before each deployment and inspect the what-if
for overlapping rules that could delete active pricing, locks/latest, or auth
data.

The shared module preserves all supplied rules except these eight
application-owned names, which it replaces idempotently:

- `mail-archive-retention`
- `mail-events-retention`
- `mail-runs-retention`
- `usage-history-retention`
- `usage-run-history-retention`
- `pricing-history-retention`
- `pricing-current-version-retention`
- `pricing-run-history-retention`

Pass a deployment parameter file containing the checked rules to
`existingStorageLifecycleRules`. Parameter files based on the existing production
example must also add this required parameter. Do not deploy from an incomplete
or stale rules snapshot.

## Deployment approval gate

The existing ms-ext test deployment is in subscription
`7bdb0a57-7e53-4c61-b1f0-11ce66566bd1`, tenant
`493da702-671c-450d-9d72-e51b74816e2d`, resource group
`aoai-cost-alert-test-rg`, with prefix `aoai-cost-test` in `swedencentral`.
These templates do not switch the active Azure account or tenant.

For a new deployment only, bootstrap the infrastructure without the Container
App or sync Jobs. After confirming the new account has no lifecycle policy:

```bash
az deployment sub what-if \
  --name aoai-cost-test-bootstrap \
  --location swedencentral \
  --template-file infra/bicep/test-subscription.bicep \
  --parameters deployWebApp=false existingStorageLifecycleRules='[]'
```

Review and approve the what-if output before any deployment.

After the bootstrap deployment:

1. Read the `registryName` deployment output.
2. Build and push the image with `az acr build`.
3. Read the pushed image digest.
4. Run a second what-if with `deployWebApp=true` and the immutable
   `<registry>.azurecr.io/tokenusagealert-web@sha256:<digest>` image, supplying the
   current lifecycle rules again.
5. Approve and deploy the second stage.

For a new deployment, configure Microsoft Entra Easy Auth with
[`scripts/configure-entra-auth.ps1`](./scripts/configure-entra-auth.ps1).
The script takes an existing application ID and secure secret, storing the
provided credential as a Container App secret. It does not create the Entra app,
generate its client secret, create/use Key Vault, or assign users/groups.
The Enterprise Application must require assignment, and only the approved partner
operations group should be assigned. Existing deployments already have Entra
auth configured externally: preserve that configuration and assignments. This
pricing change does not manage or reset auth configuration.

Customer subscriptions are onboarded with
[`../lighthouse/subscription.bicep`](../lighthouse/subscription.bicep).

## Batch-4 usage collection

[`usage.bicep`](./usage.bicep) adds `${namePrefix}-usage` in the existing private
environment. It reuses the Collector identity and its existing Lighthouse,
inventory, operations and ACR permissions. New grants are limited to Collector
write access on `usage`, Collector read access on `pricing-current`, Web read
access on `usage`, and Web Job-start permission on this Job only.

Schedule: `15 * * * *` UTC. Entrypoint:
`node /prod/usage-collector/dist/index.js`. The Job only reads Azure resource
metadata and Azure Monitor metrics; it never invokes model inference.
Missing models/usage and failed or unpriced data have distinct outcomes.

The shared lifecycle policy in `pricing.bicep` also owns the two
`usage-*-retention` rules so two modules never replace the same policy
concurrently. The application filters/prunes to 240 hours; lifecycle deletes
inactive daily usage Blobs/versions after 11 days and run history after 30 days.
The existing soft-delete recovery period still applies.

## Batch-5 bounded concurrency

`usageShardCount` (default 1, maximum 16) creates the existing base Job plus
`-1`, `-2`, ... shard Jobs. Web receives the shard count and starts the complete
set for a manual collection request. Job-start permissions remain scoped to the
specific Jobs, not the resource group.

`usageTenantConcurrency=8`, `usageSubscriptionConcurrency=8` and
`usageRequestConcurrency=32` are the initial settings. The last value is divided
across shards; it is not an independent 32-request budget for each replica.
Each shard uses 1 CPU and 2 GiB memory, concurrency-limited workers and a
20-minute work deadline within its 25-minute platform timeout.

All shards use the same `15 * * * *` schedule and query exactly one complete
hour. Resource metadata is refreshed at most every two hours under normal
operation; an error invalidates the affected cache for the next run. No
three-hour query or automatic historical backfill is scheduled.

An existing `operations/usage-topology.json` protects the current shard count.
Drain the old executions before deliberately resetting topology and changing
`usageShardCount`; delete surplus Jobs when scaling down. The initial deployment
keeps one shard because the current authorized customer scope is small.

## Batch-6 mail dispatcher

`mail.bicep` adds `${namePrefix}-mail-id` and `${namePrefix}-mail`. The dedicated
identity has configuration/pricing-summary Blob read access, operations Blob
write access and ACR pull. It has no Lighthouse access and is not granted
organization-wide Graph permissions. Web only gets Job-start permission for
this specific dispatcher.

The Job runs every two minutes, processes up to 200 due records with a
two-request sending limit, and uses a Blob lease to prevent overlapping
dispatchers. Unknown delivery records remain active and are not age-deleted.
Terminal archives are retained 30 days; immutable events and settings audit
records 90 days. Existing private networking is unchanged.

`mailAuthorizationReady` defaults to **false**. Do not set it true before
verifying Exchange Application RBAC. If Exchange requires
`Enable-OrganizationCustomization`, that is an organization-level
administrative decision, not something this template or the application performs.

After an administrator approves and completes that prerequisite, run
[`scripts/configure-mailbox-rbac.ps1`](./scripts/configure-mailbox-rbac.ps1)
with the deployed mail identity's client ID and object ID. The script checks
that the custom scope contains exactly the sender mailbox and verifies
`Application Mail.Send`. It does not alter transport rules or grant Graph
`Mail.Send` across the organization.

For the current `ms-ext.biz` test instance, the administrator completed the
prerequisite. On **2026-10-04**, the exact sender scope, Graph acceptance and
Exchange `Delivered` trace were verified. Web and the mail Job now have
`MAIL_AUTHORIZATION_READY=true`. **Preserve `mailAuthorizationReady=true` on
subsequent deployments of this authorized instance**; do not accidentally
restore the new-environment default. Automatic notifications are separately
enabled in Blob settings, with `chx@ms-ext.biz` as the sole operations recipient.

The Web environment also binds `MAIL_IDENTITY_CLIENT_ID` to the **mail** identity,
not its own Blob identity. Sender addresses are editable in
`configuration/alerting.json`; `MAIL_SENDER_MAILBOX` supplies the initial
deployment-verified default only. Changing the saved sender closes automatic
notifications. New senders require mailbox-scoped Exchange permission and an
explicit successful Graph test before re-enabling; the dispatcher writes an
identity-bound proof in `operations/mailbox-authorization/` using its existing
operations data permission. No new Graph or Blob role is required.

Web, Collector and Dispatcher must all use the sender-aware release. The
Collector writes the saved address into events without Graph access; Dispatcher
checks it again before submission and suppresses unsubmitted old-sender mail.
Do not update only the input UI while leaving an older worker image deployed.

`GET /api/v1/pricing/download` defaults to the compact query catalog, including
manual fallback rules; `?format=raw` returns the full raw/normalized audit snapshot.
Both use authenticated Web and private Blob Reader access, exposing no SAS or
public storage endpoint. Collector reads compact v2 (or compatible v1) directly,
never silently falling back to the large raw file.

Model metadata parser **3** and generic pricing rules identify token-priced model
names without a per-model allowlist. The official query remains Azure OpenAI
Consumption/USD only; Models metric support does not add other provider prices.
For a legacy active catalog, a single Pricing Job
execution may set `PRICING_METADATA_ONLY=true`. It reuses stored raw prices,
preserves the original fetch time, writes a backup before conditional active
replacement, and records normalization provenance. Do not persist this flag in
the scheduled Job: normal daily runs must continue fetching Azure Retail Prices.
All pricing-schema consumers (Web, Collector, Mail Dispatcher and Pricing Job)
must accept `parserVersion=3` before publishing it; raw snapshot `schemaVersion`
remains 1, while compact artifacts have their own v1/v2 compatibility contract.

Before production delivery, separately review a dedicated sender/recipient
restriction policy. Do not apply a blanket transport rule to the user's
existing mailbox without approval; it could disrupt normal communication.
The application currently restricts notification recipients to `ms-ext.biz`.

From 2026-10-07, cost recovery remains an internal event but is not emailed.
Roll out the compatible Mail image before Usage so old queued recovery messages
are also suppressed; Web carries the matching notification-policy text.
No new Bicep parameter, price change or mailbox permission is needed.

## Separate offboarding identity

The platform creates `${namePrefix}-offboarding-id` with a `CanNotDelete` lock,
exports its client/principal IDs, and attaches it only to the Web Container App.
The Web data identity remains responsible for Blob operations; the offboarding
identity is explicitly selected only for Lighthouse assignment inspection and
removal. It receives no partner subscription Contributor/Owner, no Graph role,
no Blob role and no Collector Reader role.

Customer consent is separate: the updated Lighthouse template grants this
identity `Managed Services Registration assignment Delete Role`. Existing
customers must redeploy the same offer with its new principal ID before the
partner-side action can succeed. Template deployment does not remove current
delegations.

The API persists a read-only preview, requires the initiating operator to type
the target tenant/subscription ID, and revalidates ownership immediately before
each Azure DELETE. Only the exact application offer containing the expected
Collector Reader plus offboarding-delete principals is accepted. Partial/unknown
results are journaled in `operations/offboarding/operations/<id>.json`; independent
audit records live in `operations/offboarding/audit/`. A consumed preview is not
automatically replayed after interruption.
