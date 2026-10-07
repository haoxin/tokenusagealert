import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { RetailPricePageSchema, type RetailPricePage } from '@tokenusagealert/schemas'
import { FixturePricingSource, RetailPricesClient, RETAIL_PRICES_FILTER } from './pricing-source.js'

const pages = (JSON.parse(readFileSync(
  new URL('../../../tests/fixtures/retail-prices-pages.json', import.meta.url), 'utf8',
)) as unknown[]).map((page) => RetailPricePageSchema.parse(page))
const first = pages[0]!
const last = pages[1]!
const signal = () => AbortSignal.timeout(5000)
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })

describe('RetailPricesClient', () => {
  it('reads all pages with a fixed query and sends no Azure credential', async () => {
    const requests: URL[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new URL(String(input)))
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return json(requests.length === 1 ? first : last)
    })
    const result = await new RetailPricesClient({ fetch: fetcher }).fetchAll(signal())
    expect(result).toEqual({ items: [...first.Items, ...last.Items], pageCount: 2 })
    expect(requests[1]?.searchParams.get('$filter')).toBe(RETAIL_PRICES_FILTER)
    expect(requests[1]?.searchParams.get('currencyCode')).toBe("'USD'")
  })

  it('honors Retry-After and limits 5xx/network retries', async () => {
    const wait = vi.fn(async () => {})
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(json({ ...first, NextPageLink: null }))
    await new RetailPricesClient({ fetch: fetcher, wait }).fetchAll(signal())
    expect(wait).toHaveBeenCalledWith(3000, expect.any(AbortSignal))
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    await expect(new RetailPricesClient({ fetch: unavailable, wait }).fetchAll(signal())).rejects.toThrow(/503/)
    expect(unavailable).toHaveBeenCalledTimes(4)
  })

  it('does not retry a permission error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }))
    await expect(new RetailPricesClient({ fetch: fetcher }).fetchAll(signal())).rejects.toThrow(/403/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://untrusted.example/api/retail/prices?$skip=1',
    'http://prices.azure.com/api/retail/prices?$skip=1',
    'https://prices.azure.com/api/retail/prices?$skip=0',
    'https://prices.azure.com/api/retail/prices?$skip=2',
    "https://prices.azure.com/api/retail/prices?$skip=1&currencyCode='EUR'",
  ])('rejects unsafe, repeated or skipping NextPageLink: %s', async (next) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...first, NextPageLink: next }))
    await expect(new RetailPricesClient({ fetch: fetcher }).fetchAll(signal())).rejects.toThrow(/page|pagination/i)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fails on malformed page count and truncated JSON rather than accepting a partial list', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ ...first, Count: 2 }))
    await expect(new RetailPricesClient({ fetch: fetcher }).fetchAll(signal())).rejects.toThrow(/schema/)
    const broken = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"Items":['))
    await expect(new RetailPricesClient({ fetch: broken }).fetchAll(signal())).rejects.toThrow(/complete JSON/)
  })

  it('treats an empty intermediate page as failure and allows the empty terminal page', async () => {
    const empty: RetailPricePage = { BillingCurrency: 'USD', Items: [], Count: 0, NextPageLink: null }
    await expect(new FixturePricingSource([{ ...empty, NextPageLink: first.NextPageLink }, last]).fetchAll(signal())).rejects.toThrow(/empty/)
    expect(await new FixturePricingSource([empty]).fetchAll(signal())).toEqual({ items: [], pageCount: 1 })
  })

  it('aborts an expired run before making a network request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(new RetailPricesClient({ fetch: fetcher }).fetchAll(AbortSignal.abort())).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
