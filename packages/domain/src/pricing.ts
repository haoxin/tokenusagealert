import { Decimal } from 'decimal.js'
import type {
  NormalizedPrice,
  PricingChanges,
  PricingSnapshot,
  PricingStatusResponse,
  RetailPriceItem,
} from '@tokenusagealert/schemas'
import { normalizedPriceLabel, tokenPriceTerms } from './price-terms.js'

export class PricingValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PricingValidationError'
  }
}

export const PRICING_PARSER_VERSION = 3

function modelPrefix(label: string): string | null {
  const boundary = /\b(?:shortco|longco|shco|loco|in|inp|inpt|input|opt|out|outp|output|cd|cached|cchd|batch|pp|priority|fl|flex|gl|glb|glbl|global|dz|dzn|dzone|datazone|data zone|reg|regnl|rgnl|regional|ft|rft|training|trng|grdr|grader|hosting)\b/.exec(label)
  if (!boundary || boundary.index === 0) return null
  let prefix = label.slice(0, boundary.index).trim()
  const media = /^((?:gpt\s*)?(?:audio|aud|realtime|rt|image|img))\s+(.*)$/.exec(prefix)
  if (media?.[1] && media[2]) prefix = `${media[1]} ${media[2].replace(/\b(?:txt|text|aud|audio|img|image)\b/g, '').replace(/\s+/g, ' ').trim()}`
  for (let pass = 0; pass < 2; pass += 1) {
    prefix = prefix.replace(/\s+\d{4}\s+\d{2}\s+\d{2}$/, '')
      .replace(/\s+(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, '')
      .replace(/\s+\d{8}$/, '')
    if (!/^gpt\s*(?:aud|audio|img|image|rt|realtime)$/.test(prefix)) {
      prefix = prefix.replace(/\s+(?:txt|text|aud(?:\d{4})?|audio|img|image|4k|8k|128k)$/, '')
    }
  }
  if (/\b(?:ft|rft|grdr|grader|training)\b/.test(label)) prefix = prefix.replace(/\s+(?:dev|model)$/, '')
  return prefix
}

export function catalogModelName(item: Pick<RetailPriceItem, 'skuName' | 'productName'>): string | null {
  const label = normalizedPriceLabel(item.skuName).replace(/^az\s+/, '')
  if (/Free Meter/i.test(item.productName) ||
    /^(?:code interpreter|file search|assistants file search|provisioned managed|provisioned throughput)/.test(label)) return null
  const prefix = modelPrefix(label)
  const compact56 = /^56\s*(sol|luna|terra)(?:\s|$)/.exec(label)
  if (compact56?.[1] && /Azure OpenAI GPT[56]/i.test(item.productName)) return `gpt-5.6-${compact56[1]}`
  const legacyAudio = /^gpt\s*4o\s*(mini)?\s*(rt|aud)(?:\s*\d{4})?(?:\s|$)/.exec(label)
  if (legacyAudio?.[2]) return `gpt-4o${legacyAudio[1] ? '-mini' : ''}-${legacyAudio[2] === 'rt' ? 'realtime' : 'audio'}-preview`
  if (/^gpt\s*4o\s*mini(?:\s|$)/.test(label) && prefix) {
    return prefix.replace(/^gpt\s*4o\s*mini/, 'gpt 4o mini').replaceAll(' ', '-')
  }
  if (/^chat\s+latest(?:\s|$)/.test(label)) return 'gpt-chat-latest'
  if (/^codex\s+mini(?:\s|$)/.test(label)) return 'codex-mini'
  if (/^live\s+1(?:\s|$)/.test(label)) return 'gpt-live-1'
  const image = /^image\s+(\d+(?:\.\d+)?)(?:\s+(sunburst|flare))?(?:\s|$)/.exec(label)
  if (image?.[1]) return prefix ? `gpt-${prefix.replaceAll(' ', '-')}` : `gpt-image-${image[1]}${image[2] ? `-${image[2]}` : ''}`
  const dalle = /^image\s+dall\s*e\s*(\d+)(?:\s|$)/.exec(label)
  if (dalle?.[1]) return `dall-e-${dalle[1]}`
  const sora = /^sora(?:\s+(2)(?:\s+(pro))?)?(?:\s|$)/.exec(label)
  if (sora) return `sora${sora[1] ? '-2' : ''}${sora[2] ? '-pro' : ''}`
  const legacyText = /^(babbage|davinci)(?:\s+(002))?(?:\s|$)/.exec(label)
  if (legacyText?.[1]) return `${legacyText[1]}${legacyText[2] ? '-002' : ''}`
  if (/^computer\s+use(?:\s|$)/.test(label)) return 'computer-use-preview'
  if (/^speech\s+(?:text\s+to\s+speech|to\s+text)(?:\s|$)/.test(label)) {
    return /^speech\s+to\s+text/.test(label) ? 'whisper' : /\bhd\b/.test(label) ? 'tts-hd' : 'tts'
  }
  const embedding = /^(?:text )?embeddings?\s+(3\s+(?:small|large)|ada(?:\s+002)?)(?:\s|$)/.exec(label)
  if (embedding?.[1]) return embedding[1].startsWith('ada') ? 'text-embedding-ada-002' : `text-embedding-${embedding[1].replaceAll(' ', '-')}`
  const oss = /^(?:gpt\s*)?oss\s*(\d+)\s*b(?:\s|$)/.exec(label)
  if (oss?.[1]) return `gpt-oss-${oss[1]}b`
  const shortOss = /^(\d+)b(?:\s|$)/.exec(label)
  if (shortOss?.[1] && /OSS Models/i.test(item.productName)) return `gpt-oss-${shortOss[1]}b`
  const media = /^gpt\s*(img|image|aud|audio|rt|realtime)\s*(\d+(?:\.\d+)?)?(?:\s+(mini))?(?:\s|$)/.exec(label)
  if (media?.[1]) {
    if (prefix) return prefix.replace(/^gpt\s*(?:image|img)(?=\s|$)/, 'gpt image')
      .replace(/^gpt\s*(?:audio|aud)(?=\s|$)/, 'gpt audio')
      .replace(/^gpt\s*(?:realtime|rt)(?=\s|$)/, 'gpt realtime').replaceAll(' ', '-')
    const family = media[1] === 'img' ? 'image' : media[1] === 'aud' ? 'audio' : media[1] === 'rt' ? 'realtime' : media[1]
    const version = media[2] && !/^\d{4}$/.test(media[2]) ? media[2] : null
    return `gpt-${family}${version ? `-${version}` : ''}${media[3] ? '-mini' : ''}`
  }
  const transcribe = /^gpt\s+(live\s+transcribe|transcribe|live\s+translate|translate)(?:\s+(mini))?(?:\s|$)/.exec(label)
  if (transcribe?.[1]) return `gpt-${transcribe[1].replaceAll(' ', '-')}${transcribe[2] ? '-mini' : ''}`
  if (/^o\d+(?:\s|$)/.test(label) && prefix) return prefix.replaceAll(' ', '-')
  if (!prefix) return null
  const gpt = /^(gpt\s*)?(\d+(?:\.\d+)?o?)(.*)$/.exec(prefix)
  if (!gpt?.[2]) return /^[a-z][a-z0-9 .]*$/.test(prefix) ? prefix.replaceAll(' ', '-') : null
  if (!gpt[1] && !/Azure OpenAI (?:GPT\d|PP FT GPT4s)/i.test(item.productName)) return null
  const versions: Record<string, string> = { '3.5': '35', '54': '5.4', '55': '5.5' }
  const version = versions[gpt[2]] ?? gpt[2]
  return `gpt-${version}${gpt[3] ? gpt[3].trim().split(/\s+/).map((part) => `-${part}`).join('') : ''}`
}

export function priceKey(item: RetailPriceItem): string {
  return JSON.stringify([
    item.meterId, item.productId, item.skuId, item.armRegionName,
    item.currencyCode, item.type, item.tierMinimumUnits,
    item.isPrimaryMeterRegion, new Date(item.effectiveStartDate).toISOString(),
  ])
}

function normalizeUnit(item: RetailPriceItem): NormalizedPrice['unit'] {
  const label = item.unitOfMeasure.trim()
  const match = /^(\d+(?:\.\d+)?)\s*(K|M)?(?:\s*\/?\s*(Tokens?|Hours?|Seconds?|Days?|Months?))?$/i.exec(label)
  if (!match?.[1]) return { kind: 'unknown', quantity: null, sourceLabel: label }
  const multiplier = match[2]?.toLowerCase() === 'k'
    ? 1000
    : match[2]?.toLowerCase() === 'm' ? 1_000_000 : 1
  const quantity = new Decimal(match[1]).times(multiplier)
  if (quantity.lte(0)) {
    throw new PricingValidationError('INVALID_PRICE_UNIT', 'A price unit must have a positive quantity.')
  }
  const suffix = match[3]?.toLowerCase()
  const kind = suffix?.startsWith('hour') ? 'hours'
    : suffix?.startsWith('second') ? 'seconds'
      : suffix?.startsWith('day') ? 'days'
      : suffix?.startsWith('month') ? 'months'
        : suffix?.startsWith('token') || /\btokens?\b/i.test(item.meterName) ? 'tokens'
          : 'units'
  return { kind, quantity: quantity.toFixed(), sourceLabel: label }
}

function normalizeItem(raw: RetailPriceItem): NormalizedPrice {
  const modelName = catalogModelName(raw)
  const terms = modelName ? tokenPriceTerms(raw, modelName) : null
  const unit = normalizeUnit(raw)
  const supported = terms !== null && unit.kind === 'tokens' && unit.quantity !== null &&
    raw.isPrimaryMeterRegion && raw.tierMinimumUnits === 0 && raw.armRegionName !== ''
  return {
    key: priceKey(raw),
    priceUsd: new Decimal(raw.retailPrice).toFixed(),
    unit,
    modelName,
    modelIdentityStatus: modelName ? 'identified'
      : /Free Meter/i.test(raw.productName) || /^(?:Az[- ]+)?(?:Code[- ]Interpreter|File[- ]Search|Assistants[- ]File[- ]Search|Provisioned[- ](?:Throughput|Managed))/i.test(raw.skuName)
        ? 'shared-service' : 'unidentified',
    modelVersion: terms?.modelVersion ?? null,
    direction: terms?.direction ?? 'unknown',
    deploymentType: terms?.sku === 'GlobalStandard' ? 'global' : terms?.sku === 'DataZoneStandard' ? 'dataZone'
      : terms?.sku === 'Standard' ? 'regional' : 'unknown',
    serviceTier: terms?.tier ?? 'unknown',
    supportStatus: supported ? 'supported' : 'unsupported',
    supportReason: supported ? 'structural-token-rule' : unit.kind !== 'tokens' ? 'unsupported-billing-unit' : 'unrecognized-meter',
    raw,
  }
}

export function normalizePrices(items: RetailPriceItem[]): {
  entries: NormalizedPrice[]
  duplicateCount: number
} {
  if (items.length === 0) {
    throw new PricingValidationError('EMPTY_PRICE_CATALOG', 'The complete price response must not be empty.')
  }
  const entriesByKey = new Map<string, NormalizedPrice>()
  let duplicateCount = 0
  for (const item of items) {
    const entry = normalizeItem(item)
    const previous = entriesByKey.get(entry.key)
    if (previous) {
      if (
        previous.priceUsd !== entry.priceUsd ||
        previous.raw.unitOfMeasure !== entry.raw.unitOfMeasure ||
        previous.raw.meterName !== entry.raw.meterName ||
        previous.raw.skuName !== entry.raw.skuName
      ) {
        throw new PricingValidationError('CONFLICTING_PRICE', `Conflicting prices for meter ${item.meterId}.`)
      }
      duplicateCount += 1
    } else {
      entriesByKey.set(entry.key, entry)
    }
  }
  const entries = [...entriesByKey.values()].sort((a, b) => a.key.localeCompare(b.key))
  if (!entries.some((entry) => entry.supportStatus === 'supported' ||
    (entry.modelName !== null && entry.unit.kind !== 'unknown' && entry.raw.isPrimaryMeterRegion))) {
    throw new PricingValidationError('BASELINE_PRICE_MISSING', 'The catalog contains no identifiable billable model meters.')
  }
  return { entries, duplicateCount }
}

export function comparePrices(
  previous: Pick<PricingSnapshot, 'snapshotId' | 'entries'> | null,
  entries: NormalizedPrice[],
): PricingChanges {
  const old = new Map(previous?.entries.map((entry) => [entry.key, entry]) ?? [])
  const changes: PricingChanges = {
    previousSnapshotId: previous?.snapshotId ?? null,
    addedMeterCount: 0, removedMeterCount: 0, changedPriceCount: 0,
    unchangedMeterCount: 0, priceFromZeroCount: 0,
    largestPriceChangePercent: null,
  }
  let largest: Decimal | null = null
  for (const entry of entries) {
    const before = old.get(entry.key)
    if (!before) {
      changes.addedMeterCount += 1
      continue
    }
    old.delete(entry.key)
    const price = new Decimal(entry.priceUsd)
    const priorPrice = new Decimal(before.priceUsd)
    if (price.eq(priorPrice)) {
      changes.unchangedMeterCount += 1
    } else {
      changes.changedPriceCount += 1
      if (priorPrice.isZero()) {
        changes.priceFromZeroCount += 1
      } else {
        const delta = price.minus(priorPrice).div(priorPrice).times(100)
        if (largest === null || delta.abs().gt(largest.abs())) largest = delta
      }
    }
  }
  changes.removedMeterCount = old.size
  changes.largestPriceChangePercent = largest?.toFixed(4) ?? null
  return changes
}

export function pricingFreshness(
  fetchedAtUtc: string | null,
  now: Date,
): Pick<PricingStatusResponse, 'freshness' | 'ageHours'> {
  if (fetchedAtUtc === null) return { freshness: 'missing', ageHours: null }
  const ageHours = Math.max(0, (now.getTime() - Date.parse(fetchedAtUtc)) / 3_600_000)
  return {
    freshness: ageHours > 72 ? 'expired' : ageHours > 36 ? 'stale' : 'fresh',
    ageHours,
  }
}

export function nextPricingSyncUtc(now: Date): string {
  const next = new Date(now)
  next.setUTCHours(16, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString()
}
