import { describe, expect, it } from 'vitest'
import { MailTestRequestSchema, UpdateMailSettingsSchema } from './alerts.js'

describe('editable mail sender contracts', () => {
  it('normalizes valid mailbox input while retaining legacy recipient-only update compatibility', () => {
    expect(UpdateMailSettingsSchema.parse({
      enabled: false, senderMailbox: ' ALERTS@MS-EXT.BIZ ', operationsRecipients: [],
    }).senderMailbox).toBe('alerts@ms-ext.biz')
    expect(UpdateMailSettingsSchema.safeParse({ enabled: false, operationsRecipients: [] }).success).toBe(true)
  })
  it('rejects invalid sender addresses and attempts to grant authorization through settings', () => {
    expect(UpdateMailSettingsSchema.safeParse({
      enabled: false, senderMailbox: 'invalid', operationsRecipients: [],
    }).success).toBe(false)
    expect(UpdateMailSettingsSchema.safeParse({
      enabled: false, senderMailbox: 'alerts@ms-ext.biz', operationsRecipients: [], authorizationReady: true,
    }).success).toBe(false)
  })
  it('validates the expected saved sender on test submissions', () => {
    expect(MailTestRequestSchema.parse({
      requestId: '11111111-1111-4111-8111-111111111111', recipient: 'operator@ms-ext.biz',
      senderMailbox: 'ALERTS@MS-EXT.BIZ',
    }).senderMailbox).toBe('alerts@ms-ext.biz')
  })
})
