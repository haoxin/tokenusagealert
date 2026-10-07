import { setTimeout as sleep } from 'node:timers/promises'
import { PricingValidationError } from '@tokenusagealert/domain'
import {
  RetailPricePageSchema,
  type RetailPriceItem,
  type RetailPricePage,
} from '@tokenusagealert/schemas'

export const RETAIL_PRICES_API_VERSION = '2023-01-01-preview'
export const RETAIL_PRICES_FILTER =
  "contains(productName, 'Azure OpenAI') and priceType eq 'Consumption'"

export interface PricingSource {
  readonly name: 'azure-retail' | 'fixture'
  fetchAll(signal: AbortSignal): Promise<{ items: RetailPriceItem[]; pageCount: number }>
}

function catalogUrl(): URL {
  const url = new URL('https://prices.azure.com/api/retail/prices')
  url.searchParams.set('api-version', RETAIL_PRICES_API_VERSION)
  url.searchParams.set('currencyCode', "'USD'")
  url.searchParams.set('$filter', RETAIL_PRICES_FILTER)
  return url
}

function checkedPageUrl(link: string, expectedOffset: number): URL {
  const url = new URL(link)
  if (
    url.origin !== 'https://prices.azure.com' ||
    url.pathname !== '/api/retail/prices' ||
    url.username || url.password || url.hash ||
    !/^\d+$/.test(url.searchParams.get('$skip') ?? '0') ||
    Number(url.searchParams.get('$skip') ?? '0') !== expectedOffset
  ) {
    throw new PricingValidationError('INVALID_PRICE_PAGINATION', 'Retail Prices returned an unexpected page URL or offset.')
  }
  // Preserve the query across API-provided pagination links, including older links that omit it.
  for (const [key, value] of catalogUrl().searchParams) {
    const existing = url.searchParams.get(key)
    if (existing !== null && existing !== value) {
      throw new PricingValidationError('INVALID_PRICE_PAGINATION', 'Retail Prices changed the catalog query during pagination.')
    }
    url.searchParams.set(key, value)
  }
  return url
}

function parsePage(body: unknown): RetailPricePage {
  const result = RetailPricePageSchema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new PricingValidationError(
      'INVALID_PRICE_RESPONSE',
      `Retail Prices failed schema validation at ${issue?.path.join('.') || 'page'}.`,
    )
  }
  if (result.data.Items.length === 0 && result.data.NextPageLink !== null) {
    throw new PricingValidationError('INVALID_PRICE_PAGINATION', 'An empty intermediate price page was returned.')
  }
  return result.data
}

interface RetailPricesClientOptions {
  fetch?: typeof fetch
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

export class RetailPricesClient implements PricingSource {
  readonly name = 'azure-retail' as const
  private readonly fetcher: typeof fetch
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>

  constructor(options: RetailPricesClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch
    this.wait = options.wait ?? (async (milliseconds, signal) => {
      await sleep(milliseconds, undefined, { signal })
    })
  }

  async fetchAll(signal: AbortSignal) {
    const items: RetailPriceItem[] = []
    let pageCount = 0
    let nextLink: string | null = catalogUrl().href
    const visited = new Set<string>()
    while (nextLink !== null) {
      signal.throwIfAborted()
      if (pageCount >= 1000) {
        throw new PricingValidationError('PRICE_PAGE_LIMIT', 'Retail Prices exceeded the 1,000-page safety limit.')
      }
      const url = checkedPageUrl(nextLink, items.length)
      if (visited.has(url.href)) {
        throw new PricingValidationError('INVALID_PRICE_PAGINATION', 'Retail Prices repeated a page.')
      }
      visited.add(url.href)
      const page = await this.fetchPage(url, signal)
      items.push(...page.Items)
      pageCount += 1
      nextLink = page.NextPageLink
    }
    return { items, pageCount }
  }

  private async fetchPage(url: URL, signal: AbortSignal): Promise<RetailPricePage> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal.throwIfAborted()
      let response: Response
      try {
        response = await this.fetcher(url, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        })
      } catch (error) {
        signal.throwIfAborted()
        if (attempt === 3) {
          throw new PricingValidationError('PRICE_FETCH_FAILED', `Retail Prices was unreachable after ${attempt + 1} attempts (${error instanceof Error ? error.name : 'network error'}).`)
        }
        await this.wait(1000 * 2 ** attempt, signal)
        continue
      }

      if (response.ok) {
        let body: unknown
        try {
          body = await response.json()
        } catch {
          throw new PricingValidationError('INVALID_PRICE_RESPONSE', 'Retail Prices did not return a complete JSON page.')
        }
        return parsePage(body)
      }

      await response.body?.cancel()
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status)
      if (!retryable || attempt === 3) {
        throw new PricingValidationError('PRICE_HTTP_ERROR', `Retail Prices returned HTTP ${response.status}.`)
      }
      const retryAfter = response.headers.get('retry-after')
      const seconds = retryAfter !== null && /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter)
        : retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : NaN
      const milliseconds = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : 1000 * 2 ** attempt + Math.floor(Math.random() * 250)
      await this.wait(milliseconds, signal)
    }
    throw new PricingValidationError('PRICE_FETCH_FAILED', 'Retail Prices retry limit was reached.')
  }
}

export class FixturePricingSource implements PricingSource {
  readonly name = 'fixture' as const
  constructor(private readonly pages: unknown[]) {}

  async fetchAll(signal: AbortSignal) {
    const items: RetailPriceItem[] = []
    for (const [index, body] of this.pages.entries()) {
      signal.throwIfAborted()
      const page = parsePage(body)
      if ((page.NextPageLink === null) !== (index === this.pages.length - 1)) {
        throw new PricingValidationError('INVALID_PRICE_PAGINATION', 'Fixture pagination is incomplete.')
      }
      if (page.NextPageLink !== null) checkedPageUrl(page.NextPageLink, items.length + page.Items.length)
      items.push(...page.Items)
    }
    return { items, pageCount: this.pages.length }
  }
}
