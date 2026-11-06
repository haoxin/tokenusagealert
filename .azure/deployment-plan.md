# Cached / Priority Telemetry Release

## 1. Status

Deployed — azure-validate completed before the guarded reader-first rollout; application and real Collector readback verified.

## 2. Scope and Authorization

- User authorization: 2026-11-06, push the current feature/documentation updates and deploy the feature if not live.
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
6. Update actual release documentation, commit and push the verified changes.

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

- Web revision `aoai-cost-test-web--0000021` Healthy, 100% traffic.
- Web/Usage/Mail use the validated `e2e89796...` image; all non-image component fingerprints preserved.
- Pricing and Authorization components are unchanged. No infrastructure apply/new resources, role/network/schedule/settings changes.
- Normal Usage execution `aoai-cost-test-usage-ekh7iua` Succeeded at `2026-11-06T03:52:03Z`.
- Real Collector identity read the supported metric contracts; new billingTelemetry/capabilities persisted for the 10:00–11:00 Beijing hour.
- The window had zero observed tokens; cache stays noData/null and tier unknown. This is not a new positive-use or precise cache-discount test.
- Latest normal Mail execution succeeded with 0 accepted/failed/unknown; no synthetic mail or inference.
- Private configuration/pricing/retained-history hashes match before rollout. Internal readiness 200 and anonymous business API 401.
- User attachments and generated validation JSON remain outside the source publication boundary.
