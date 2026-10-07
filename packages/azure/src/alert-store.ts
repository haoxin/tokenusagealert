import { createHash, randomUUID } from 'node:crypto'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import {
  AlertEventSchema, AlertSubjectDocumentSchema, AlertSubjectSchema,
  MailRunSchema, MailSettingsSchema, OutboxRecordSchema, UpdateMailSettingsSchema,
  SenderAuthorizationProofSchema,
  TenantConfigSchema, TenantIdSchema,
  type AlertEvent, type AlertSubjectDocument, type MailSettings, type OutboxRecord,
  type MailRun, type UpdateMailSettings, type OutboxListResponse,
} from '@tokenusagealert/schemas'
import { initialAlertState, mapConcurrent } from '@tokenusagealert/domain'
import { storageErrorCode, withBlobLease } from './blob-lease.js'

export interface MailPolicy {
  senderMailbox: string
  allowedRecipientDomains: string[]
  mode: 'graph' | 'preview'
  authorizationReady: boolean
  authorizationIdentityId?: string
}
export class AlertConflictError extends Error {
  constructor(message = 'The document changed; refresh before retrying.') { super(message); this.name = 'AlertConflictError' }
}
export class MailPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'MailPolicyError' }
}
export function alertId(key: string): string { return createHash('sha256').update(key).digest('hex') }
export const terminalOutboxStatuses = new Set<OutboxRecord['status']>(['accepted', 'failed', 'suppressed', 'previewed', 'closed'])
const idSchema = AlertEventSchema.shape.id

interface Stored<T> { value: T; etag: string }

export class BlobAlertStore {
  private readonly config: ContainerClient
  private readonly operations: ContainerClient
  constructor(service: BlobServiceClient, readonly policy: MailPolicy, names: { configuration?: string; operations?: string } = {}) {
    this.config = service.getContainerClient(names.configuration ?? 'configuration')
    this.operations = service.getContainerClient(names.operations ?? 'operations')
  }
  async initialize(autoCreate: boolean) {
    for (const container of [this.config, this.operations]) {
      if (autoCreate) await container.createIfNotExists()
      await container.getProperties()
    }
  }
  private async read(container: ContainerClient, name: string): Promise<Stored<unknown> | null> {
    try {
      const blob = container.getBlobClient(name)
      const properties = await blob.getProperties()
      if (!properties.etag) throw new Error('Storage response has no ETag.')
      const body = await blob.downloadToBuffer(0, undefined, { conditions: { ifMatch: properties.etag } })
      const value: unknown = JSON.parse(body.toString('utf8'))
      return { value, etag: properties.etag }
    } catch (error) {
      if (storageErrorCode(error) === 'BlobNotFound') return null
      throw error
    }
  }
  private async put(container: ContainerClient, name: string, value: unknown, etag: string | null, metadata: Record<string, string> = {}) {
    const body = JSON.stringify(value)
    try {
      const result = await container.getBlockBlobClient(name).upload(body, Buffer.byteLength(body), {
        conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
        metadata, blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
      })
      if (!result.etag) throw new Error('Storage write did not return an ETag.')
      return result.etag
    } catch (error) {
      if (['ConditionNotMet', 'BlobAlreadyExists'].includes(String(storageErrorCode(error)))) throw new AlertConflictError()
      throw error
    }
  }
  async settings(): Promise<{ settings: MailSettings; etag: string | null }> {
    const stored = await this.read(this.config, 'alerting.json')
    return stored ? { settings: MailSettingsSchema.parse(stored.value), etag: stored.etag } : {
      settings: {
        schemaVersion: 1, revision: 0, enabled: false, senderMailbox: this.policy.senderMailbox,
        operationsRecipients: [], reminderIntervalHours: 6, recoveryPolicy: 'new-complete-hour',
        updatedAtUtc: null, updatedByObjectId: null,
      }, etag: null,
    }

  }

  async tenantIsRemoved(tenantId: string): Promise<boolean> {
    const id = TenantIdSchema.parse(tenantId)
    const stored = await this.read(this.config, `tenants/${id}.json`)
    return !stored || TenantConfigSchema.parse(stored.value).status === 'deleted'
  }

  validateRecipients(recipients: string[]) {
    for (const address of recipients) {
      const domain = address.split('@')[1]?.toLowerCase()
      if (!domain || !this.policy.allowedRecipientDomains.includes(domain)) {
        throw new MailPolicyError(`Recipient domain is not allowed: ${domain ?? '(missing)'}`)
      }
    }
  }
  get graphTestAvailable(): boolean {
    return this.policy.mode === 'graph' && this.policy.authorizationReady && Boolean(this.policy.authorizationIdentityId)
  }

  private senderProofPath(senderMailbox: string): string {
    if (!this.policy.authorizationIdentityId) throw new MailPolicyError('部署未配置专用邮件身份，不能验证新的发件邮箱。')
    return `mailbox-authorization/${alertId(`${this.policy.authorizationIdentityId.toLowerCase()}:${senderMailbox}`)}.json`
  }

  async senderAuthorization(settings: MailSettings): Promise<{
    ready: boolean
    source: 'deployment' | 'graph-test' | 'unverified' | 'preview'
    checkedAtUtc: string | null
  }> {
    if (this.policy.mode === 'preview') return { ready: false, source: 'preview', checkedAtUtc: null }
    if (!this.policy.authorizationReady) return { ready: false, source: 'unverified', checkedAtUtc: null }
    if (this.policy.authorizationIdentityId) {
      const stored = await this.read(this.operations, this.senderProofPath(settings.senderMailbox))
      if (stored) {
        const proof = SenderAuthorizationProofSchema.parse(stored.value)
        if (proof.senderMailbox !== settings.senderMailbox ||
          proof.authorizationIdentityId.toLowerCase() !== this.policy.authorizationIdentityId.toLowerCase()) {
          throw new Error('Sender authorization proof does not match the configured mailbox and identity.')
        }
        return { ready: proof.status === 'accepted', source: 'graph-test', checkedAtUtc: proof.checkedAtUtc }
      }
    }
    const deployed = settings.senderMailbox === this.policy.senderMailbox.toLowerCase()
    return { ready: deployed, source: deployed ? 'deployment' : 'unverified', checkedAtUtc: null }
  }

  async recordSenderAuthorization(record: OutboxRecord, status: 'accepted' | 'denied', requestId: string | null) {
    if (record.mode !== 'graph' || !this.graphTestAvailable ||
      (status === 'accepted' && record.event.kind !== 'test')) {
      throw new MailPolicyError('只有专用邮件身份的真实测试成功才能验证新发件邮箱。')
    }
    const path = this.senderProofPath(record.sender)
    const proof = SenderAuthorizationProofSchema.parse({
      schemaVersion: 1, senderMailbox: record.sender, authorizationIdentityId: this.policy.authorizationIdentityId,
      status, checkedAtUtc: new Date().toISOString(), eventId: record.event.id, graphRequestId: requestId,
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.read(this.operations, path)
      if (current) {
        const previous = SenderAuthorizationProofSchema.parse(current.value)
        if (previous.checkedAtUtc > proof.checkedAtUtc ||
          (previous.checkedAtUtc === proof.checkedAtUtc && previous.status === 'denied' && proof.status === 'accepted')) return
      }
      try { await this.put(this.operations, path, proof, current?.etag ?? null); return }
      catch (error) { if (!(error instanceof AlertConflictError)) throw error }
    }
    throw new AlertConflictError('Sender authorization proof changed concurrently; verification could not be recorded.')
  }

  async saveSettings(input: UpdateMailSettings, expected: string | null, actorObjectId: string) {
    const value = UpdateMailSettingsSchema.parse(input)
    this.validateRecipients(value.operationsRecipients)
    const current = await this.settings()
    if (current.etag !== expected) throw new AlertConflictError()
    const senderMailbox = value.senderMailbox ?? current.settings.senderMailbox
    const senderChanged = senderMailbox !== current.settings.senderMailbox
    const enabled = senderChanged ? false : value.enabled
    if (enabled && this.policy.mode === 'graph' &&
      !(await this.senderAuthorization({ ...current.settings, senderMailbox })).ready) {
      throw new MailPolicyError('当前发件邮箱尚未通过真实发信权限验证，请先授权并发送测试邮件。')
    }
    const settings = MailSettingsSchema.parse({
      ...current.settings, ...value, senderMailbox, enabled,
      revision: current.settings.revision + 1, updatedAtUtc: new Date().toISOString(), updatedByObjectId: actorObjectId,
    })
    await this.put(this.operations, `alerting-audit/${randomUUID()}.json`, {
      action: 'settings-update.requested', actorObjectId, occurredAtUtc: settings.updatedAtUtc,
      enabled: settings.enabled, recipientCount: settings.operationsRecipients.length, expectedRevision: current.settings.revision,
      senderMailbox, previousSenderMailbox: current.settings.senderMailbox,
    }, null)
    const etag = await this.put(this.config, 'alerting.json', settings, expected)
    return { settings, etag, senderChanged }
  }
  subjectLease<T>(subject: string, operation: () => Promise<T>) {
    const safe = AlertSubjectSchema.parse(subject)
    return withBlobLease(this.operations, `locks/alerts/${safe}`, operation, AbortSignal.timeout(120_000))
  }
  async subject(subject: string): Promise<Stored<AlertSubjectDocument>> {
    const safe = AlertSubjectSchema.parse(subject)
    const stored = await this.read(this.operations, `alert-state/${safe}.json`)
    if (stored) return { value: AlertSubjectDocumentSchema.parse(stored.value), etag: stored.etag }
    return { value: { schemaVersion: 1, subject: safe, current: initialAlertState(), pending: null }, etag: '' }
  }
  async writeSubject(document: AlertSubjectDocument, etag: string): Promise<Stored<AlertSubjectDocument>> {
    const value = AlertSubjectDocumentSchema.parse(document)
    const next = await this.put(this.operations, `alert-state/${value.subject}.json`, value, etag || null, { pending: String(value.pending !== null) })
    return { value, etag: next }
  }
  async ensureEvent(record: OutboxRecord) {
    const event = record.event
    try {
      await this.put(this.operations, `alert-events/${event.subject}/${event.id}.json`, event, null, {
        occurred: event.occurredAtUtc, kind: event.kind,
      })
    } catch (error) {
      if (!(error instanceof AlertConflictError)) throw error
      const previous = await this.read(this.operations, `alert-events/${event.subject}/${event.id}.json`)
      if (!previous || AlertEventSchema.parse(previous.value).key !== event.key) throw new AlertConflictError('Event identity collision.')
    }
    if (await this.outbox(event.id)) return
    const path = terminalOutboxStatuses.has(record.status) ? 'archive' : 'active'
    try { await this.put(this.operations, `outbox/${path}/${event.id}.json`, record, null, this.outboxMetadata(record)) }
    catch (error) { if (!(error instanceof AlertConflictError)) throw error }
  }
  async completePending(stored: Stored<AlertSubjectDocument>): Promise<Stored<AlertSubjectDocument>> {
    const decision = stored.value.pending
    if (!decision) return stored
    for (const event of decision.events) await this.ensureEvent(event)
    return this.writeSubject({ ...stored.value, current: decision.next, pending: null }, stored.etag)
  }
  async reconcilePending() {
    const subjects: string[] = []
    for await (const blob of this.operations.listBlobsFlat({ prefix: 'alert-state/', includeMetadata: true })) {
      if (blob.metadata?.pending === 'true') subjects.push(blob.name.slice('alert-state/'.length, -5))
    }
    const results = await mapConcurrent(subjects, 4, (subject) =>
      this.subjectLease(subject, async () => this.completePending(await this.subject(subject))))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  private outboxMetadata(record: OutboxRecord) {
    return {
      status: record.status, created: record.event.createdAtUtc, subject: record.event.subject,
      nextattempt: record.nextAttemptAtUtc ?? '', claimexpires: record.claimExpiresAtUtc ?? '',
    }
  }
  async outbox(id: string): Promise<(Stored<OutboxRecord> & { path: string }) | null> {
    const safe = idSchema.parse(id)
    for (const folder of ['active', 'archive']) {
      const path = `outbox/${folder}/${safe}.json`
      const stored = await this.read(this.operations, path)
      if (stored) return { value: OutboxRecordSchema.parse(stored.value), etag: stored.etag, path }
    }
    return null
  }
  async updateOutbox(record: OutboxRecord, etag: string) {
    const value = OutboxRecordSchema.parse(record)
    return this.put(this.operations, `outbox/active/${value.event.id}.json`, value, etag, this.outboxMetadata(value))
  }
  async archive(record: OutboxRecord, etag: string) {
    const value = OutboxRecordSchema.parse(record)
    if (!terminalOutboxStatuses.has(value.status)) throw new Error('Nonterminal outbox records cannot be archived.')
    const path = `outbox/archive/${value.event.id}.json`
    const existing = await this.read(this.operations, path)
    await this.put(this.operations, path, value, existing?.etag ?? null, this.outboxMetadata(value))
    await this.operations.getBlobClient(`outbox/active/${value.event.id}.json`).delete({ conditions: { ifMatch: etag } })
  }
  async active(limit = 200): Promise<string[]> {
    const candidates: Array<{ id: string; created: string }> = []
    for await (const blob of this.operations.listBlobsFlat({ prefix: 'outbox/active/', includeMetadata: true })) {
      if (blob.metadata?.status === 'unknown') continue
      if (blob.metadata?.status === 'pending' && blob.metadata.nextattempt && Date.parse(blob.metadata.nextattempt) > Date.now()) continue
      if (blob.metadata?.status === 'claimed' && blob.metadata.claimexpires && Date.parse(blob.metadata.claimexpires) > Date.now()) continue
      candidates.push({ id: blob.name.slice('outbox/active/'.length, -5), created: blob.metadata?.created ?? '' })
    }
    return candidates.sort((a, b) => a.created.localeCompare(b.created)).slice(0, limit).map((item) => item.id)
  }
  async listOutbox(limit: number, cursor?: string): Promise<OutboxListResponse> {
    const names: Array<{ path: string; order: string }> = []
    for (const folder of ['active', 'archive']) {
      for await (const blob of this.operations.listBlobsFlat({ prefix: `outbox/${folder}/`, includeMetadata: true })) {
        const order = `${blob.metadata?.created ?? ''}|${blob.name.split('/').pop()}`
        if (!cursor || order < cursor) names.push({ path: blob.name, order })
      }
    }
    names.sort((a, b) => b.order.localeCompare(a.order))
    const seen = new Set<string>()
    const items: OutboxRecord[] = []
    let last: string | null = null
    let index = 0
    for (; index < names.length && items.length < limit; index++) {
      const entry = names[index]!
      const stored = await this.read(this.operations, entry.path)
      if (!stored) continue
      const record = OutboxRecordSchema.parse(stored.value)
      if (!seen.has(record.event.id)) { seen.add(record.event.id); items.push(record); last = entry.order }
    }
    return { items, nextCursor: index < names.length ? last : null }
  }
  async timeline(subject: string, limit = 30): Promise<AlertEvent[]> {
    const safe = AlertSubjectSchema.parse(subject)
    const names: Array<{ name: string; occurred: string }> = []
    for await (const blob of this.operations.listBlobsFlat({ prefix: `alert-events/${safe}/`, includeMetadata: true })) {
      names.push({ name: blob.name, occurred: blob.metadata?.occurred ?? '' })
    }
    const items: AlertEvent[] = []
    for (const item of names.sort((a, b) => b.occurred.localeCompare(a.occurred)).slice(0, limit)) {
      const event = await this.read(this.operations, item.name)
      if (event) items.push(AlertEventSchema.parse(event.value))
    }
    return items
  }
  async resolve(id: string, expected: string, action: 'retry' | 'close', reason: string, actorObjectId: string) {
    const record = await this.outbox(id)
    if (!record || record.etag !== expected || record.value.status !== 'unknown') throw new AlertConflictError('Only an unchanged unknown event can be resolved.')
    const current = record.value
    const next: OutboxRecord = {
      ...current, status: action === 'retry' ? 'pending' : 'closed', updatedAtUtc: new Date().toISOString(),
      claimOwner: null, claimExpiresAtUtc: null, submissionStartedAtUtc: null, nextAttemptAtUtc: null,
      resolution: { actorObjectId, reason, atUtc: new Date().toISOString() },
    }
    const etag = await this.updateOutbox(next, record.etag)
    if (action === 'close') await this.archive(next, etag)
    return next
  }
  dispatchLease<T>(operation: (signal: AbortSignal) => Promise<T>) {
    return withBlobLease(this.operations, 'locks/mail-dispatch', operation, AbortSignal.timeout(5 * 60_000))
  }
  async writeRun(run: MailRun) {
    const data = MailRunSchema.parse(run)
    for (const path of [`runs/mail/history/${run.runId}.json`, 'runs/mail/latest.json']) {
      const previous = await this.read(this.operations, path)
      await this.put(this.operations, path, data, previous?.etag ?? null)
    }
  }
  async latestRun(): Promise<MailRun | null> {
    const result = await this.read(this.operations, 'runs/mail/latest.json')
    return result ? MailRunSchema.parse(result.value) : null
  }
  async operationalDocument(path: 'runs/pricing/latest.json' | 'runs/authorization/latest.json'): Promise<unknown | null> {
    return (await this.read(this.operations, path))?.value ?? null
  }
}
