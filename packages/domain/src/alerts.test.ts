import { describe, expect, it } from 'vitest'
import { alertEmailSuppression, evaluateAlertHour, initialAlertState } from './alerts.js'

const hour = (offset: number, amount = '20', status: 'complete' | 'partial' | 'failed' = 'complete') => ({
  windowStartUtc: new Date(Date.UTC(2026, 9, 4, offset)).toISOString(),
  windowEndUtc: new Date(Date.UTC(2026, 9, 4, offset + 1)).toISOString(),
  status, knownCostUsd: status === 'failed' ? null : amount, thresholdUsd: '10',
})
describe('hourly alert decisions', () => {
  it('emits the first breach once and reminds exactly at six hours', () => {
    const first = evaluateAlertHour(initialAlertState(), hour(0), null, true)
    expect(first.kinds).toEqual(['cost-exceeded'])
    expect(evaluateAlertHour(first.next, hour(0), null, true).kinds).toEqual([])
    const later = evaluateAlertHour(first.next, hour(5), null, true)
    expect(later.kinds).toEqual([])
    expect(evaluateAlertHour(later.next, hour(6), null, true).kinds).toEqual(['cost-reminder'])
  })
  it('recovers only on a new complete non-breaching estimated hour', () => {
    const first = evaluateAlertHour(initialAlertState(), hour(0), null, true)
    const partial = evaluateAlertHour(first.next, hour(1, '1', 'partial'), 'missing-subscription', true)
    expect(partial.next.costState).toBe('breaching')
    expect(partial.kinds).toEqual(['data-quality'])
    const failed = evaluateAlertHour(partial.next, hour(2, '0', 'failed'), 'missing-subscription', true)
    expect(failed.next.costState).toBe('breaching')
    const recovered = evaluateAlertHour(failed.next, hour(3, '10'), null, true)
    expect(recovered.kinds).toEqual(['cost-recovered', 'data-recovered'])
    expect(recovered.next.costState).toBe('normal')
  })
  it('allows partial known subtotal to alert but never to recover', () => {
    const partial = evaluateAlertHour(initialAlertState(), hour(0, '11', 'partial'), 'unmapped', true)
    expect(partial.kinds).toEqual(['cost-exceeded', 'data-quality'])
    expect(evaluateAlertHour(partial.next, hour(1, '0', 'partial'), 'unmapped', true).kinds).toEqual([])
  })
  it('does not process old windows or create repeated recovery', () => {
    const first = evaluateAlertHour(initialAlertState(), hour(5), null, true)
    expect(evaluateAlertHour(first.next, hour(4, '0'), null, true).kinds).toEqual([])
    const recovered = evaluateAlertHour(first.next, hour(6, '0'), null, true)
    expect(evaluateAlertHour(recovered.next, hour(7, '0'), null, true).kinds).toEqual([])
  })
  it('notifies an ongoing breach on the next window after enabling notifications', () => {
    const disabled = evaluateAlertHour(initialAlertState(), hour(0), null, false)
    expect(evaluateAlertHour(disabled.next, hour(1), null, true).kinds).toEqual(['cost-exceeded'])
  })
  it('records recovery without email and treats a subsequent breach as a new first alert', () => {
    const first = evaluateAlertHour(initialAlertState(), hour(0), null, true)
    const recovered = evaluateAlertHour(first.next, hour(1, '1'), null, true)
    expect(recovered.next.costState).toBe('normal')
    expect(recovered.kinds).toEqual(['cost-recovered'])
    expect(alertEmailSuppression('cost-recovered')).toMatchObject({ code: 'COST_RECOVERY_EMAIL_DISABLED' })
    const subsequent = evaluateAlertHour(recovered.next, hour(2), null, true)
    expect(subsequent.kinds).toEqual(['cost-exceeded'])
    expect(alertEmailSuppression('cost-exceeded')).toBeNull()
  })
  it.each(['cost-reminder', 'data-quality', 'data-reminder', 'data-recovered', 'test'] as const)(
    'preserves the existing email policy for %s', (kind) => {
      expect(alertEmailSuppression(kind)).toBeNull()
    },
  )
})
