import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  RetailPricePageSchema, type RetailPriceItem,
} from '@tokenusagealert/schemas'
import {
  comparePrices, nextPricingSyncUtc, normalizePrices, priceKey, pricingFreshness,
  catalogModelName,
} from './pricing.js'

const pages: unknown[] = JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/retail-prices-pages.json', import.meta.url), 'utf8',
))
const baseline = pages.flatMap((page) => RetailPricePageSchema.parse(page).Items)
const input = baseline[0]!

describe('price catalog normalization', () => {
  it.each([
    ['6-luna ShortCo Inp Std Gl', 'Azure OpenAI GPT6', 'gpt-6-luna'],
    ['6-astra LongCo Cd Wr Std Gl', 'Azure OpenAI GPT6', 'gpt-6-astra'],
    ['6-sol LongCo Opt PP DZ', 'Azure OpenAI GPT6', 'gpt-6-sol'],
    ['5.6 sol ShortCo inp Gl', 'Azure OpenAI GPT6', 'gpt-5.6-sol'],
    ['5.4 pro Batch inp Dz', 'Azure OpenAI GPT5', 'gpt-5.4-pro'],
    ['5.1 codex opt Gl', 'Azure OpenAI GPT5', 'gpt-5.1-codex'],
    ['54 mini pp opt DZ', 'Azure OpenAI GPT5', 'gpt-5.4-mini'],
    ['55 ShortCo Batch opt Gl', 'Azure OpenAI GPT5', 'gpt-5.5'],
    ['56luna ShCo Cd Inp Fl Gl', 'Azure OpenAI GPT5', 'gpt-5.6-luna'],
    ['56terra LoCo Cd Inp Fl Gl', 'Azure OpenAI GPT5', 'gpt-5.6-terra'],
    ['5 mini pp Inp Gl', 'Azure OpenAI GPT5', 'gpt-5-mini'],
    ['gpt-4.1-ft mdl grdr inpt', 'Azure OpenAI', 'gpt-4.1'],
    ['4.1 mini pp cd Inp Gl', 'Azure OpenAI PP FT GPT4s', 'gpt-4.1-mini'],
    ['gpt-4o-mini Outp glbl', 'Azure OpenAI', 'gpt-4o-mini'],
    ['gpt-35-turbo-16K Inp glbl', 'Azure OpenAI', 'gpt-35-turbo-16k'],
    ['o3-deep research 0626-inp-cchd-glbl', 'Azure OpenAI Reasoning', 'o3-deep-research'],
    ['o4-mini 0416 Batch Outp glbl', 'Azure OpenAI Reasoning', 'o4-mini'],
    ['GPT-OSS-20b-IN-FT', 'Azure OpenAI OSS Models', 'gpt-oss-20b'],
    ['OSS 120b Inp FT DZ', 'Azure OpenAI OSS Models', 'gpt-oss-120b'],
    ['20b FT regnl', 'Azure OpenAI OSS Models', 'gpt-oss-20b'],
    ['gpt img 1.5 out img DZ', 'Azure OpenAI Media', 'gpt-image-1.5'],
    ['gpt-realtime-2 Image cd inp Gl', 'Azure OpenAI Media', 'gpt-realtime-2'],
    ['gpt aud 1.5 txt opt Gl', 'Azure OpenAI Media', 'gpt-audio-1.5'],
    ['gpt-audio-0828 Inp glbl', 'Azure OpenAI Media', 'gpt-audio'],
    ['gpt4omini-rt-aud1217 Inp glbl', 'Azure OpenAI', 'gpt-4o-mini-realtime-preview'],
    ['gpt4omini-aud1217-txt Inp DZone', 'Azure OpenAI', 'gpt-4o-mini-audio-preview'],
    ['gpt rt 1.5 txt inp Dz', 'Azure OpenAI Media', 'gpt-realtime-1.5'],
    ['gpt-live-transcribe Gl', 'Azure OpenAI Media', 'gpt-live-transcribe'],
    ['text embedding 3 large DZ', 'Azure OpenAI Embedding', 'text-embedding-3-large'],
    ['embedding-ada-glbl-new', 'Azure OpenAI Embedding', 'text-embedding-ada-002'],
    ['chat-latest 08062026 inp Gl', 'Azure OpenAI GPT5', 'gpt-chat-latest'],
    ['codex mini inp glbl', 'Azure OpenAI Reasoning', 'codex-mini'],
    ['Image 2.5-sunburst img inp Gl', 'Azure OpenAI Media', 'gpt-image-2.5-sunburst'],
    ['Image Dall E 3 1024 images', 'Azure OpenAI Media', 'dall-e-3'],
    ['Live 1 Gl', 'Azure OpenAI Media', 'gpt-live-1'],
    ['Sora 2 pro high res glbl', 'Azure OpenAI Media', 'sora-2-pro'],
    ['Az Davinci 002 base Inp glbl', 'Azure OpenAI', 'davinci-002'],
    ['Az GPT4-Turbo Inp glbl', 'Azure OpenAI', 'gpt-4-turbo'],
    ['Standard', 'Azure OpenAI Free Meter', null],
    ['future-model something', 'Azure OpenAI', null],
    ['GPT 5 outpt Glbl', 'Azure OpenAI GPT5', 'gpt-5'],
    ['gpt 4o mini0718 BatchOutp DataZone', 'Azure OpenAI', 'gpt-4o-mini'],
    ['gpt4o realtimePrvwTxtInp DataZone', 'Azure OpenAI', 'gpt-4o-realtime-preview'],
    ['gpt4o realtimePrvwAudOutp DataZone', 'Azure OpenAI', 'gpt-4o-realtime-preview'],
    ['5 unrelated numeric meter', 'Azure OpenAI', null],
  ])('identifies %s descriptively as %s without price approval', (skuName, productName, expected) => {
    expect(catalogModelName({ skuName, productName })).toBe(expected)
  })

  it('recognizes a structural token rule without any model-name whitelist', () => {
    const luna = { ...input, skuName: '6-luna ShortCo Inp Std Gl', productName: 'Azure OpenAI GPT6',
      meterId: '30000000-0000-4000-8000-000000000003' }
    const result = normalizePrices([...baseline, luna]).entries.find((entry) => entry.raw === luna)
    expect(result).toMatchObject({
      modelName: 'gpt-6-luna', modelIdentityStatus: 'identified',
      supportStatus: 'supported', serviceTier: 'standard', direction: 'input',
    })
    expect(result?.raw).toEqual(luna)
    expect(result?.priceUsd).toBe(input.retailPrice.toString())
  })

  it('preserves raw fields, decimal price, region and effective-time identity with structural eligibility', () => {
    const { entries } = normalizePrices(baseline)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      priceUsd: '0.002', unit: { kind: 'tokens', quantity: '1000' },
      supportStatus: 'supported', supportReason: 'structural-token-rule', raw: input,
    })
    expect(priceKey({ ...input, armRegionName: 'eastus' })).not.toBe(priceKey(input))
    expect(priceKey({ ...input, effectiveStartDate: '2026-02-01T00:00:00Z' })).not.toBe(priceKey(input))
    expect(priceKey({ ...input, tierMinimumUnits: 100 })).not.toBe(priceKey(input))
    expect(priceKey({ ...input, isPrimaryMeterRegion: false })).not.toBe(priceKey(input))
  })

  it.each([
    ['1M', 'tokens', '1000000'], ['1 Hour', 'hours', '1'], ['1/Hour', 'hours', '1'],
    ['1 Second', 'seconds', '1'], ['1/Month', 'months', '1'], ['1/Day', 'days', '1'],
    ['new-unit', 'unknown', null],
  ])('normalizes %s without replacing an unknown unit with zero', (unit, kind, quantity) => {
    const changed = { ...input, meterId: '30000000-0000-4000-8000-000000000001', unitOfMeasure: unit }
    const result = normalizePrices([...baseline, changed]).entries.find((entry) => entry.raw === changed)!
    expect(result.unit).toMatchObject({ kind, quantity })
  })

  it('deduplicates equal records and rejects same-key different-price or different-unit collisions', () => {
    expect(normalizePrices([...baseline, input]).duplicateCount).toBe(1)
    expect(() => normalizePrices([...baseline, { ...input, retailPrice: 0.1 }])).toThrow(/Conflicting/)
    expect(() => normalizePrices([...baseline, { ...input, unitOfMeasure: '1M' }])).toThrow(/Conflicting/)
  })

  it('retains a newly named model as unsupported instead of interpreting it as an approved meter', () => {
    const unknown: RetailPriceItem = {
      ...input, skuId: 'new-sku', skuName: 'future-model something',
      meterId: '40000000-0000-4000-8000-000000000001',
    }
    expect(normalizePrices([...baseline, unknown]).entries.find((entry) => entry.raw === unknown)).toMatchObject({
      modelName: null, direction: 'unknown', supportStatus: 'unsupported', supportReason: 'unrecognized-meter',
    })
  })

  it('rejects empty catalogs, zero unit sizes and invalid currency/negative values without requiring a fixed model baseline', () => {
    expect(() => normalizePrices([])).toThrow(/empty/)
    expect(normalizePrices([input]).entries).toHaveLength(1)
    expect(() => normalizePrices([...baseline, { ...input, skuId: 'zero', unitOfMeasure: '0K' }])).toThrow(/positive/)
    expect(() => RetailPricePageSchema.parse({ BillingCurrency: 'EUR', Items: [], Count: 0, NextPageLink: null })).toThrow()
    expect(() => RetailPricePageSchema.parse({
      BillingCurrency: 'USD', Items: [{ ...input, retailPrice: -1 }], Count: 1, NextPageLink: null,
    })).toThrow()
  })
})

describe('automatic price change summary', () => {
  it('reports >20% prices and removed meters without a review decision', () => {
    const entries = normalizePrices(baseline).entries
    const previous = { snapshotId: '50000000-0000-4000-8000-000000000001', entries }
    const next = entries.map((entry) => ({ ...entry, priceUsd: '0.01' }))
    expect(comparePrices(previous, next)).toMatchObject({ changedPriceCount: 2, largestPriceChangePercent: '400.0000' })
    expect(comparePrices(previous, [])).toMatchObject({ removedMeterCount: 2 })
    expect(comparePrices(null, entries)).toMatchObject({ addedMeterCount: 2, previousSnapshotId: null })
  })

  it('does not divide by zero', () => {
    const entries = normalizePrices(baseline).entries
    const previous = { snapshotId: '50000000-0000-4000-8000-000000000001', entries: entries.map((entry) => ({ ...entry, priceUsd: '0' })) }
    expect(comparePrices(previous, entries)).toMatchObject({ priceFromZeroCount: 2, largestPriceChangePercent: null })
  })
})

describe('price freshness and Beijing midnight schedule', () => {
  const fetched = '2026-10-01T16:00:00.000Z'
  it.each([
    [36, 'fresh'], [36.001, 'stale'], [72, 'stale'], [72.001, 'expired'],
  ])('uses exact %s hour boundary', (hours, expected) => {
    expect(pricingFreshness(fetched, new Date(Date.parse(fetched) + hours * 3_600_000)).freshness).toBe(expected)
  })
  it('labels no snapshot as missing and computes next UTC16:00 even at midnight', () => {
    expect(pricingFreshness(null, new Date())).toEqual({ freshness: 'missing', ageHours: null })
    expect(nextPricingSyncUtc(new Date('2026-10-01T15:59:59Z'))).toBe('2026-10-01T16:00:00.000Z')
    expect(nextPricingSyncUtc(new Date(fetched))).toBe('2026-10-02T16:00:00.000Z')
  })
})
