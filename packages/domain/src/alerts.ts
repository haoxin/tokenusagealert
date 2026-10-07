import { Decimal } from 'decimal.js'
import type { AlertKind, AlertState, HourlyUsage } from '@tokenusagealert/schemas'

export const REMINDER_MS = 6 * 3_600_000
export function alertEmailSuppression(kind: AlertKind): { code: string; message: string } | null {
  return kind === 'cost-recovered'
    ? { code: 'COST_RECOVERY_EMAIL_DISABLED', message: '费用恢复事件仅保留状态和历史记录，不发送恢复邮件。' }
    : null
}

export function initialAlertState(): AlertState {
  return {
    lastEvaluatedAtUtc: null, costState: 'normal', lastCostEventAtUtc: null,
    qualitySignature: null, lastQualityEventAtUtc: null, notificationsEnabled: false,
  }
}

function reminderDue(last: string | null, current: string): boolean {
  return last === null || Date.parse(current) - Date.parse(last) >= REMINDER_MS
}

export function evaluateAlertHour(
  previous: AlertState,
  hour: Pick<HourlyUsage, 'windowStartUtc' | 'windowEndUtc' | 'status' | 'knownCostUsd' | 'knownCostUpperUsd' | 'thresholdUsd'>,
  qualitySignature: string | null,
  enabled: boolean,
): { next: AlertState; kinds: AlertKind[] } {
  if (previous.lastEvaluatedAtUtc && hour.windowStartUtc <= previous.lastEvaluatedAtUtc) {
    return { next: previous, kinds: [] }
  }
  const next: AlertState = { ...previous, lastEvaluatedAtUtc: hour.windowStartUtc, notificationsEnabled: enabled }
  const kinds: AlertKind[] = []
  const newlyEnabled = enabled && !previous.notificationsEnabled
  const amountKnown = hour.status !== 'failed' && hour.knownCostUsd !== null && hour.thresholdUsd !== null
  if (amountKnown && new Decimal(hour.knownCostUsd!).gt(hour.thresholdUsd!)) {
    if (previous.costState === 'normal' || newlyEnabled || reminderDue(previous.lastCostEventAtUtc, hour.windowEndUtc)) {
      kinds.push(previous.costState === 'normal' || newlyEnabled ? 'cost-exceeded' : 'cost-reminder')
      next.lastCostEventAtUtc = hour.windowEndUtc
    }
    next.costState = 'breaching'
  } else if (amountKnown && hour.status === 'complete' && previous.costState === 'breaching' &&
    hour.knownCostUpperUsd !== null &&
    new Decimal(hour.knownCostUpperUsd ?? hour.knownCostUsd!).lte(hour.thresholdUsd!)) {
    kinds.push('cost-recovered')
    next.costState = 'normal'
    next.lastCostEventAtUtc = hour.windowEndUtc
  }
  if (qualitySignature !== null) {
    if (previous.qualitySignature !== qualitySignature || newlyEnabled || reminderDue(previous.lastQualityEventAtUtc, hour.windowEndUtc)) {
      kinds.push(previous.qualitySignature !== qualitySignature || newlyEnabled ? 'data-quality' : 'data-reminder')
      next.lastQualityEventAtUtc = hour.windowEndUtc
    }
    next.qualitySignature = qualitySignature
  } else if (previous.qualitySignature !== null && hour.status === 'complete') {
    kinds.push('data-recovered')
    next.qualitySignature = null
    next.lastQualityEventAtUtc = hour.windowEndUtc
  }
  return { next, kinds }
}
