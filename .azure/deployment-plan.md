---
title: Dual Context and Native Cost Estimation Release
description: Guarded image-only update and scoped MCT historical estimate supplementation
---

## 1. Status

Validated, deployed and scoped MCT supplementation verified for the 2026-11-13 update. Web revision 0000023 is Healthy/Running with 100% traffic; Web/Usage/Mail share the immutable dtt image. The two requested MCT hours now contain version 5 fixed 50/50 reference and independent native estimates; raw facts and historical notifications are unchanged.

Current authorization: update only the existing ms-ext / Sweden Central Web/Usage/Mail images and supplement exactly the two MCT 2026-11-12 UTC 08:00/09:00 test hours and matching MCT dashboard projections. Preserve original facts, price snapshots, all non-image configuration and the USD 3/hour threshold. No new inference, historical alert/email replay, Git commit or push is requested.

Correct paid-test target: mct subscription `6ce33da7-9e41-4e48-8a95-c48f1bde120a`, account `aoai-mct-chx`, resource group `aoai-mct-validation-rg`, deployment `gpt-5.6-sol-validation`, GlobalStandard in swedencentral. Live ARM, actual monitored inventory, native Priority capability, existing credential and applicable prices are verified. No paid request was sent to fte, and no FTE billing restoration is required.

Current release boundaries:

- Use the current dual-estimate source and fresh release-specific checks; the November 12 validation is historical, not reused.
- Use the existing partner Web/Usage/Mail resources and the existing MCT PAYG deployment; create no infrastructure and change no identities, networking, schedules or unrelated settings.
- The completed 29-request ledger remains closed at USD 3.4625486; no additional inference or budget reset.
- Native test values are USD 2.8557566 and 0.606792. Calculate the new reference from stored original facts and the recorded original price snapshot, not from a lower/upper midpoint.
- Back up original day bytes/ETag and MCT cache rows before conditional derived updates. Preserve raw tokens/tiers/cache observations, source times, finality, thresholds, watermark, non-target records and existing notification history.
- Keep existing missing-only repricing guards intact. A separately named controlled context-estimate backfill does not evaluate alerts.
- Do not claim either estimate is an exact cache counter or invoice. No Git push is requested.

The following sections retain the already-completed November 6 release as historical evidence. They are not proof for this new release; clearly dated current validation and rollout entries are appended after execution.

## 2. Scope and Authorization

- User authorization: 2026-11-13, fixed context/native dual estimates and yesterday's MCT test supplementation/redisplay; no Git push.
- Mode: MODIFY an existing application, Azure CLI image-only recipe; no azd initialization or new infrastructure.
- Target: existing `aoai-cost-alert-test-rg` / Sweden Central deployment in `ms-ext`.
- Confirmed existing context: subscription `7bdb0a57-7e53-4c61-b1f0-11ce66566bd1`, tenant `493da702-671c-450d-9d72-e51b74816e2d`, location `swedencentral`; user requests updating this running application, not selecting another subscription/region.
- Preserve existing private Blob networking, managed identities, roles, settings, prices, thresholds and schedules.
- Exclude unrelated HTB/media attachments from Git and build context.
- No paid inference or synthetic test email.

## 3. Application and Resources

Existing React/Fluent UI + Fastify Web, Usage Collector, Mail Dispatcher, Pricing and Authorization Jobs.
Only Web/Usage/Mail need the new compatible image. Pricing/Authorization remain untouched unless direct evidence requires otherwise.
Private Consumption environment, Storage and ACR are already Succeeded/Healthy. Existing Web and four Jobs remain in place with their current resources and schedules.

| Resource inventory | Existing | New infrastructure requested | Quota effect |
|---|---:|---:|---|
| Container Apps environment | 1 | 0 | Existing Consumption profile unchanged |
| Web Container App | 1 | 0 | Existing max replicas 3; one healthy active replica, ordinary revision rollout |
| Jobs | 4 | 0 | Existing CPU/memory, retry limits and cron unchanged |
| Storage / ACR | 1 / 1 | 0 | No provisioning, network or SKU change |

No region selection, azd environment creation, infrastructure provisioning, new role assignment or quota increase is needed for this recipe. Existing ACR pull assignments were read back for every bound component identity. This is not an azd provisioning operation.

## 4. Release Sequence

1. Validate source and capture guarded live configuration.
2. Build an immutable image from only the required application source/manifests.
3. Update Web/API first and verify healthy traffic/readiness.
4. Update Usage and Mail while preserving non-image fingerprints.
5. Verify Collector-identity metrics and normal persisted telemetry without inference.
6. Supplement only the two authorized historical MCT hours, reconcile cache projections and verify the interface.
7. Update actual release documentation; do not commit or push.

### All validation checks pass

- [x] Core Azure CLI validation: CLI/auth, Bicep compilation, ARM validate and what-if preview.
- [x] Docker build: frozen-lockfile application build in the existing ACR from the minimal source context.
- [x] Policy/safety: existing target, no infrastructure apply/new resources, no RBAC/network/settings changes; inspect preview without applying unrelated template drift.
- [x] Role review: existing container-scoped data roles and ACR pull identities satisfy unchanged access contracts.
- [x] Validation proof contains actual results before status becomes Validated.

## 5. Risk and Rollback

Old strict readers may reject new optional hour fields. Never publish new Collector records before compatible Web readers.
If rollback is needed after new records exist, retain compatible Web readers and roll back Collector only; do not rewrite history or settings.

## 6. Preparation Evidence

Current Web revision `aoai-cost-test-web--0000020` still uses the prior mail-policy image, so this feature is not live.
The existing target subscription and deployment match the user-approved application; no subscription, region or network migration is selected.
The user explicitly authorizes this non-destructive release; routine decisions are agent-owned under autopilot.
Before/after hashes of non-image component configuration, templates and identities are retained in session evidence, not committed runtime configuration.
Git origin/main matches local baseline `1fb942e`; GitHub repository is now public. Unrelated attachments are excluded from commit/build input.

## 7. Validation Proof

### Current release: 2026-11-13

- Fresh workflow restarted from None; existing ms-ext subscription is Enabled and the existing resource group is Sweden Central.
- Workspace lint/typecheck/build passed; 247 dependent functional/stress cases, 29 storage/mail integrations, 8 browser checks and 8 infrastructure contracts passed.
- Minimal context contains 99 tracked application/manifests, 938,278 uncompressed bytes; source boundary SHA-256 `07da27881bdbc20b5cda164648bfd6ef68edb1fcb78c446dc06ab2416a02f64b`. The prior 230 KiB figure was compressed upload size, not source bytes.
- Existing eight lifecycle rules were retained exactly in validation parameters. Target policy assignments read back as empty.
- Official fresh Azure validation passed CLI installed, authentication, Bicep compilation, target ARM validation and what-if. Preview shows 8 Create / 180 Modify / 64 Delete unrelated template drift; no infrastructure apply is authorized or performed.
- Static roles retain Web usage-read and Collector usage/operations-write bindings. Scoped backfill will run under the existing Collector Job identity with a transient execution command, not a role change.
- Remote frozen-lockfile ACR build `dtt` Succeeded at `2026-11-13T04:31:50.873427Z`; immutable digest `sha256:11deedaeed4570a0491ea9c93f5e9fad4aa20beec1a94926274b41cee3cad62b`, tag `dual-estimates-20261113-0427`, linux/amd64. Uploaded archive was 234.972 KiB.
- Executed core command: installed `azure-validate` recipe `validate-deployment.sh --scope group --resource-group aoai-cost-alert-test-rg --subscription 7bdb0a57-7e53-4c61-b1f0-11ce66566bd1 --template infra/bicep/main.bicep --parameters <current exact lifecycle parameters>`; all five checks PASS.
- Executed build command: `az acr build --registry aoaicosttestw6ehcu3axgbwm --image tokenusagealert-web:dual-estimates-20261113-0427 --file apps/web/Dockerfile --no-logs <allowlisted context>` with the explicit ms-ext subscription; actual run `dtt` Succeeded.
- Static verification reviewed unchanged container-scoped Blob reader/contributor bindings and ACR pull bindings in `main.bicep`, `usage.bicep`, `pricing.bicep` and `mail.bicep`. Native ARM reads use the Collector's existing delegation; no identity/role change is required.
- Errors resolved: no remaining validation/build failures. The earlier isolated synthetic timeout passed unchanged when rerun; existing Vite bundle/Bicep-upgrade notices are warnings, not new dependency or infrastructure changes.
- azure-validate completed recipe, core, actual build, static-role, proof and error-resolution steps before authorizing this Validated status. No old source proof or infrastructure apply was substituted.

### Historical release: 2026-11-12

- Status: Validated for the existing ms-ext image-only release after actual current checks and proof. November 6 proof below is not reused. The subsequently corrected MCT test proceeds separately without redeployment.

#### All validation checks pass (current release)

- [x] Core Azure CLI validation (CLI/auth/Bicep compile/ARM validate/what-if), preview only.
- [x] Immutable container build from the curated tracked production source boundary.
- [x] Current Azure policy review, existing-role sufficiency and non-image configuration baseline.

#### Current evidence

- Current local source checks passed: 270 relevant Vitest tests, six production-browser tests, workspace typecheck/build.
- 2026-11-12T06:05Z: `pnpm test:infra` passed all eight contracts.
- Private live baseline: readiness 200; threshold USD 3.00; Graph mail enabled/authorized with one existing recipient; current retail snapshot fetched 2026-11-11T16:00:44.020Z. No recipient address or credential was recorded.
- Historical wrong-target preflight checked fte while Disabled and sent no inference there. The user corrected the target to mct; actual monitored inventory expects MCT, so the former FTE blocker is superseded, not worked around.
- Curated build input: 99 tracked production/manifests, source-boundary SHA-256 `336967a5a4c5c2601863d3564ddf21bb47a9e8218b1c8cd76a883ee2de6b1fcd`; no tests, documentation, attachments, secrets/local settings, generated output or session artifacts.
- Existing lifecycle policy has eight rules; exact current rules were read and supplied to validation without applying any template.
- All five component non-image fingerprints and authentication fingerprint captured before rollout. Applicable policy assignment query returned no assignments at the target scope. Existing ACR pull assignments were read back without changes.
- 2026-11-12 current run: the official `validate-deployment.sh --scope group --resource-group aoai-cost-alert-test-rg --subscription 7bdb0a57-7e53-4c61-b1f0-11ce66566bd1 --template infra/bicep/main.bicep --parameters <current exact lifecycle parameters>` passed all five checks.
- What-if again reported 8 Create / 180 Modify / 64 Delete from unrelated blueprint drift. It is preview evidence only and **will not be applied**; only selected service image fields are authorized.
- ACR build `dts` Succeeded, finished `2026-11-12T06:12:20.968521Z`; the frozen-lockfile application production build completed from the 99-file, 230.431 KiB allowlisted context.
- Registry tag `cache-priority-20261112-0609` was separately read back and resolves to immutable image `aoaicosttestw6ehcu3axgbwm.azurecr.io/tokenusagealert-web@sha256:cdd3261f7708aa876efb11f08d5eafb8de14a7fcde82ef6ff547a178191f7eb5`.
- Static role review of main/pricing/usage/mail Bicep confirms existing container-scoped Blob reader/contributor operations, managed-identity ACR pull and fixed Job operator scopes remain sufficient. No role, Graph mailbox boundary, registry binding, identity or network change is required.
- A source-boundary audit verified all 99 uploaded files still exactly match the current tested working source and copied bytes. Before-release anonymous business API response remains HTTP 401.

### Historical release: 2026-11-06

azure-validate workflow completed recipe, build, static-role, proof and error-resolution checks; status is set by that skill after all checks passed.
Validation date: 2026-11-06, approximately 03:39–03:49 UTC.

- 2026-11-06: `pnpm check` passed lint, typecheck, 342 unit/API tests and workspace production build.
- Live target readback: Web revision20 Healthy/100%, private Consumption environment Succeeded.
- All four existing Job triggers/crons/timeouts/resources verified.
- Storage public/anonymous/shared-key access remain disabled; ACR admin remains disabled.
- Existing Web/Collector/Mail/Pricing ACR pull roles verified without RBAC changes.
- Source implementation Review was Complete/Conformant; prior integration/browser evidence is retained in session state.
- `pnpm test:infra`: eight typed/compiled deployment contracts passed.
- Official `validate-deployment.sh --scope group ... --template infra/bicep/main.bicep`: all five checks PASS, including ARM validate and what-if.
- The full-template preview reported unrelated blueprint drift (8 Create / 180 Modify / 64 Delete). **It will not be applied.** The selected release uses only image updates guarded by existing non-image fingerprints; no resource create/delete, RBAC or network mutation is authorized.
- Static role review: existing customer Reader supports metricDefinitions/metrics reads; existing Blob container data roles and Graph mailbox boundary are unchanged.
- ACR build `dtr` Succeeded, completed `2026-11-06T03:45:32Z`, from 127 formal source/manifests with source-boundary hash `9d57b03f003bcc9f76c26acb3b306505af8b92aac5e1974eba790ed010994bfb`.
- Built immutable image: `aoaicosttestw6ehcu3axgbwm.azurecr.io/tokenusagealert-web@sha256:e2e89796ecde48f2afe3a8c3151688a2866d4af62461a43a5a47f41a88bdebda`.
- Private Web identity readback succeeded: current configuration/pricing/history hashes captured, readiness 200, active tenant has three deployments and zero observed usage in the latest completed hour. No synthetic traffic was generated.
- Entra platform authentication remains enabled; unauthenticated action RedirectToLoginPage.

## 8. Deployment and Verification

### Current release: 2026-11-13

- Web revision `aoai-cost-test-web--0000023` is Healthy/Running, active and 100% traffic.
- Before writer rollout, live private probe at `2026-11-13T04:42:19.278Z` reported pricing version 5, accepted version-5/native/capability-v2 records and private readiness HTTP 200.
- Web, Usage and Mail use `aoaicosttestw6ehcu3axgbwm.azurecr.io/tokenusagealert-web@sha256:11deedaeed4570a0491ea9c93f5e9fad4aa20beec1a94926274b41cee3cad62b`.
- Fresh before/after auth and non-image hashes match for Web and all four Jobs. Pricing and Authorization images are unchanged.
- Existing Collector roles read back: Usage and Operations container Blob Data Contributor, Pricing-current Blob Data Reader, plus registry AcrPull. No roles were added.
- Anonymous dashboard and public-health routes return HTTP 401 under the unchanged authentication policy; private readiness passed. Integrated browser redirects to Entra login, so an authenticated online screenshot has not been claimed.
- Scoped historical dry-run/backfill runs only as a transient command on the existing Collector Job. No model inference or notification replay is authorized.
- Corrected read-only execution `aoai-cost-test-usage-qfa0pcn` and apply execution `aoai-cost-test-usage-i0dejmy` Succeeded. The first preflight stopped before writes due absent optional mail env values; the read-only policy was corrected to the existing Collector defaults.
- Audit `b0b1358b-3029-4baf-baac-f5b392f09242` retains original day bytes/source ETag. Only UTC 08:00/09:00 MCT derived estimates and one matching MCT dashboard row were updated. Original day SHA-256 `4422e0f396a31487ec7f72505f7a1e9ae579566c01f64edb743fbdf4d4a2d312`; raw tokens/tiers/cache facts, price snapshot and non-target hours preserved.
- New reference amounts are USD `3.632515740180` and `0.759258000000`, total `4.391773740180`; native amounts `2.855756600000` and `0.606792000000`, total `3.462548600000`. This changes the hypothetical reference, not inference charges.
- Live Web independently reread both records, cache and byte backup. Real-data production-built browser verified both methods, 1104ms initial load, 63ms selection and no overflow/errors. Its local authentication/API fixtures are only a rendering verification path; online auth remains intact.
- Closed request ledger remains 29 settled MCT requests at USD 3.4625486; this release/backfill sent zero model inference requests and replayed no historical emails.

### Historical release: 2026-11-12

- Current azure-validate completed before any resource image update; ACR `dts` Succeeded from the 99-file curated source boundary.
- Image: `aoaicosttestw6ehcu3axgbwm.azurecr.io/tokenusagealert-web@sha256:cdd3261f7708aa876efb11f08d5eafb8de14a7fcde82ef6ff547a178191f7eb5`.
- Web revision `aoai-cost-test-web--0000022` is Healthy/Running, 100% traffic. Before updating Jobs, its exact live container reported rule version 4, accepted version 4 records and private readiness 200 at `2026-11-12T06:17:00.996Z`.
- Mail was updated before Usage, after Web admission. Both Job templates are Succeeded and use the same immutable image; Pricing and Authorization retain their prior images.
- All five non-image configuration fingerprints and the authentication fingerprint exactly match before/after. Identities, registry bindings, resource limits, probes, schedules, networking, auth and ingress were preserved.
- Post-release anonymous business API remains HTTP 401. Private threshold remains USD 3.00; configured mail hash/recipient count and active price snapshot/ETag are unchanged. Twenty-four existing version 3 hours remain readable; no historical repair or rewrite operation was executed.
- Read-only in-memory runtime checks against the actual deployed modules and active retail book passed: mixed Standard/Priority/cache sample USD 0.008160–0.009360, expected per-tier cached-price references, and a tiny derived cache quantity `0.000007034`. These are **non-billed fixtures**, not real model requests or saved usage.
- Normal Mail executions at 06:20, 06:22 and 06:24 UTC used the new image and Succeeded. This is execution health, not a claim that a test email was delivered.
- Before target correction, the `2026-11-12T06:24:37Z` fte check was Disabled and no inference had been sent. This was the wrong test subscription. Current MCT verification and real requests are described below; the historical check does not require restoring fte.
- MCT live preflight: Enabled; the actual customer's expected subscription is exactly MCT; existing model gpt-5.6-sol 2026-07-09 advertises Priority, with 50,000 TPM / 50 RPM. Existing account-key access succeeds without role changes; credentials remain only in process memory.
- The same USD 3.50 ledger was retargeted while still at zero requests/spend/reservations, without resetting budget. Every real POST now has an atomic worst-case reservation and explicit prompt/output bounds; ambiguous results retain reservations and are not blindly retried.
- The first real Standard warm-up returned input 2,214, output 64, writes 2,137, reads 0; retail estimate USD 0.012273. The next repeated-prefix Standard request returned reads 2,137, writes 0, output 1,024; USD 0.0216428. These are real MCT responses, unlike earlier in-memory runtime fixtures.
- The real batch is complete: 29 settled HTTP 200 responses, served Standard 2 / Priority 27, input 11,972, output 86,449, measured cache reads 8,548 and writes 2,137. Returned-usage retail estimate is USD 3.4625486; maximum pre-send exposure was USD 3.4999966, with zero outstanding reservation and no ambiguous result.
- Requests ran 08:35:14.397-09:10:55.565 UTC and touched two natural hours. Reconciliation waited for the final 09:00-10:00 UTC window to close and its normal 10:15 UTC collection. No additional inference, fixture usage, historical rewrite or premature collection was performed.
- Final normal readback at `2026-11-12T10:17:20.639Z` contains both complete version 4 hours. Stored and native input/output totals are exactly 11,972 / 86,449, with Standard 4,428 / 1,088 and Priority 7,544 / 85,361 matching all real responses.
- UTC 08:00-09:00 stored estimate is USD 2.893757160120-4.401150964751; UTC 09:00-10:00 is USD 0.606792000000-0.913260000000. Both lower estimates are below the unchanged USD 3/hour threshold, so no cost-exceeded/reminder event or test mail is expected or observed. A cross-hour USD 3.46 batch is not one USD 3.46 hourly breach.
- The application's declared estimate arithmetic was independently reproduced. Its mean-percentage policy derived 2,354.733609 estimated cache-read tokens versus 8,548 actually returned by the API; this and common per-tier ratio allocation explain the USD 0.038000560120 lower-estimate difference. The displayed USD 3.500549160120-5.314410964751 range is assumption-dependent, not a guaranteed invoice interval.
- Native Azure Monitor hour attribution differs from client timestamp grouping by one 37-input/802-output boundary item. Both collected hours match their native buckets and the combined full batch exactly; no request was silently reassigned or history rewritten.
- No full-template apply, infrastructure creation/deletion, billing/provider/RBAC change, new customer substitution, Git commit/push or unrelated attachment upload occurred.

#### Current live role verification

- ACR pull assignments were read back for Web, Collector, Pricing and Mail bound identities.
- Actual configuration/usage/current-price/operations container assignments match unchanged data operations: Web configuration contributor and usage/price reader; Collector usage contributor and price reader; Mail configuration/price reader and operations contributor.
- No role was granted or changed. Current private data access and successful normal Mail execution complement the assignment readback.

### Historical release: 2026-11-06

- Web revision `aoai-cost-test-web--0000021` Healthy, 100% traffic.
- Web/Usage/Mail use the validated `e2e89796...` image; all non-image component fingerprints preserved.
- Pricing and Authorization components are unchanged. No infrastructure apply/new resources, role/network/schedule/settings changes.
- Normal Usage execution `aoai-cost-test-usage-ekh7iua` Succeeded at `2026-11-06T03:52:03Z`.
- Real Collector identity read the supported metric contracts; new billingTelemetry/capabilities persisted for the 10:00–11:00 Beijing hour.
- The window had zero observed tokens; cache stays noData/null and tier unknown. This is not a new positive-use or precise cache-discount test.
- Latest normal Mail execution succeeded with 0 accepted/failed/unknown; no synthetic mail or inference.
- Private configuration/pricing/retained-history hashes match before rollout. Internal readiness 200 and anonymous business API 401.
- User attachments and generated validation JSON remain outside the source publication boundary.
