import { describe, expect, it } from 'vitest'
import {
  CreateTenantRequestSchema,
  BillingTelemetrySchema,
  DeploymentUsageSchema,
  FoundryEstimatedCostSchema,
  DeleteTenantRegistrationResponseSchema,
  HourlyThresholdUsdSchema,
  TenantConfigSchema,
  TenantIdSchema,
  UpdateTenantSettingsRequestSchema,
} from './index.js'

describe('billing telemetry contracts', () => {
  const cache = { source: 'openai-cache-match-rate', status: 'available', matchRatePercent: '50.5',
    readTokens: null, write5mTokens: null, write1hTokens: null }
  it('distinguishes percent from unknown token counts', () => {
    expect(BillingTelemetrySchema.parse({ tierSource: 'unknown', cache }).cache.readTokens).toBeNull()
  })
  it.each(['-1', '100.1', 'NaN'])('rejects invalid cache percentages %s', (matchRatePercent) => {
    expect(BillingTelemetrySchema.safeParse({ tierSource: 'models', cache: { ...cache, matchRatePercent } }).success).toBe(false)
  })
  it('rejects fractional cache token counts', () => {
    expect(BillingTelemetrySchema.safeParse({ tierSource: 'models', cache: { ...cache, readTokens: '2.5' } }).success).toBe(false)
  })
  it('permits fractional ratio estimates only in the explicitly estimated contract', () => {
    const estimate = { method: 'hourly-match-rate', matchRatePercent: '25',
      estimatedReadTokens: '2.5', estimatedNonCachedInputTokens: '7.5', tierAllocation: 'same-ratio-per-tier' }
    expect(DeploymentUsageSchema.shape.cacheReadEstimate.parse(estimate)).toEqual(estimate)
    expect(DeploymentUsageSchema.shape.cacheReadEstimate.safeParse({ ...estimate, estimatedReadTokens: '-1' }).success).toBe(false)
    expect(DeploymentUsageSchema.shape.cacheReadEstimate.safeParse({ ...estimate, matchRatePercent: '101' }).success).toBe(false)
    expect(DeploymentUsageSchema.shape.cacheReadEstimate.safeParse({ ...estimate, method: 'measured-tokens' }).success).toBe(false)
  })
})

describe('native monetary estimate availability', () => {
  it('rejects success-shaped missing values and zero-shaped unavailable values', () => {
    const estimate = { metricName: 'FoundryModelEstimatedCost', currency: 'USD', status: 'available',
      costUsd: '2.855756600000', retrievedAtUtc: '2026-11-13T03:00:00.000Z', issue: null }
    expect(FoundryEstimatedCostSchema.parse(estimate).costUsd).toBe('2.855756600000')
    expect(FoundryEstimatedCostSchema.safeParse({ ...estimate, costUsd: null }).success).toBe(false)
    expect(FoundryEstimatedCostSchema.safeParse({ ...estimate, status: 'noData', costUsd: '0' }).success).toBe(false)
    expect(FoundryEstimatedCostSchema.safeParse({ ...estimate, status: 'failed', costUsd: null }).success).toBe(false)
  })
})

describe('TenantIdSchema', () => {
  it('normalizes a valid tenant id to lowercase', () => {
    expect(
      TenantIdSchema.parse('11111111-1111-4111-8111-AAAAAAAAAAAA'),
    ).toBe('11111111-1111-4111-8111-aaaaaaaaaaaa')
  })

  it('rejects an invalid tenant id', () => {
    expect(() => TenantIdSchema.parse('not-a-guid')).toThrow()
  })
})

describe('HourlyThresholdUsdSchema', () => {
  it.each([
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['25.5000', '25.50'],
    ['0.000001', '0.000001'],
  ])('normalizes %s as %s', (input, expected) => {
    expect(HourlyThresholdUsdSchema.parse(input)).toBe(expected)
  })

  it.each(['0', '-1', '1.1234567', '1e3', 'NaN'])(
    'rejects %s',
    (input) => {
      expect(() => HourlyThresholdUsdSchema.parse(input)).toThrow()
    },
  )
})

describe('CreateTenantRequestSchema', () => {
  it('applies notes default and rejects unknown fields', () => {
    expect(
      CreateTenantRequestSchema.parse({
        tenantId: '11111111-1111-4111-8111-111111111111',
        displayName: '客户 A',
        hourlyThresholdUsd: '25',
      }),
    ).toEqual({
      tenantId: '11111111-1111-4111-8111-111111111111',
      displayName: '客户 A',
      hourlyThresholdUsd: '25.00',
      notes: '',
    })

    expect(() =>
      CreateTenantRequestSchema.parse({
        tenantId: '11111111-1111-4111-8111-111111111111',
        displayName: '客户 A',
        hourlyThresholdUsd: '25',
        status: 'active',
      }),
    ).toThrow()
  })
})

describe('DeleteTenantRegistrationResponseSchema', () => {
  it('requires an actual deletion confirmation and validates audit warnings', () => {
    const result = { tenantId: '11111111-1111-4111-8111-111111111111', deleted: true }
    expect(DeleteTenantRegistrationResponseSchema.parse(result)).toEqual(result)
    expect(DeleteTenantRegistrationResponseSchema.safeParse({ ...result, deleted: false }).success).toBe(false)
    expect(DeleteTenantRegistrationResponseSchema.safeParse({ ...result, tenant: {} }).success).toBe(false)
    expect(DeleteTenantRegistrationResponseSchema.safeParse({
      ...result, warnings: [{ code: 'AUDIT_COMPLETION_WRITE_FAILED', message: '完成审计待核对' }],
    }).success).toBe(true)
  })
})

describe('TenantConfigSchema', () => {
  it('accepts a valid pending authorization document', () => {
    expect(
      TenantConfigSchema.parse({
        schemaVersion: 1,
        revision: 1,
        tenantId: '11111111-1111-4111-8111-111111111111',
        displayName: '客户 A',
        status: 'pendingAuthorization',
        authorizationSource: 'manual-preregistration',
        hourlyThresholdUsd: '25.00',
        notes: '',
        createdByObjectId: 'operator-1',
        createdByName: 'operator@ms-ext.biz',
        createdAtUtc: '2026-09-29T08:00:00.000Z',
        updatedAtUtc: '2026-09-29T08:00:00.000Z',
        deletedAtUtc: null,
      }).status,
    ).toBe('pendingAuthorization')
  })

  describe('UpdateTenantSettingsRequestSchema', () => {
    it('normalizes editable fields and rejects authorization/status changes', () => {
      expect(UpdateTenantSettingsRequestSchema.parse({ displayName: ' 新名称 ', hourlyThresholdUsd: '15.5000' }))
        .toEqual({ displayName: '新名称', hourlyThresholdUsd: '15.50' })
      expect(UpdateTenantSettingsRequestSchema.safeParse({ displayName: 'New', hourlyThresholdUsd: '0' }).success).toBe(false)
      expect(UpdateTenantSettingsRequestSchema.safeParse({ displayName: 'New', hourlyThresholdUsd: '10', status: 'active' }).success).toBe(false)
    })
  })
})
