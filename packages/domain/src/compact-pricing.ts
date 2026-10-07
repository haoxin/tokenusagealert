import { Decimal } from 'decimal.js'
import {
  CompactPriceCatalogSchema, type CompactPriceCatalog, type CompactPriceRate, type NormalizedPrice, type PricingSnapshot,
} from '@tokenusagealert/schemas'
import { catalogModelName } from './pricing.js'
import { normalizedPriceLabel, tokenPriceTerms } from './price-terms.js'

export function compactOfficialPrices(snapshot: PricingSnapshot, now = new Date()): CompactPriceCatalog {
  type Candidate = { entry: NormalizedPrice; model: string; terms: NonNullable<ReturnType<typeof tokenPriceTerms>> }
  const latest = new Map<string, Candidate>()
  const pendingWindow = new Map<string, Candidate>()
  const selectedAt = Math.min(now.getTime(), Date.parse(snapshot.fetchedAtUtc))
  const pendingStart = Math.floor((selectedAt - 15 * 60_000) / 3_600_000) * 3_600_000 - 3_600_000
  const scheduled = new Map<string, Candidate>()
  const select = (target: Map<string, Candidate>, key: string, candidate: Candidate) => {
    const previous = target.get(key)
    const date = Date.parse(candidate.entry.raw.effectiveStartDate)
    const previousDate = previous ? Date.parse(previous.entry.raw.effectiveStartDate) : -Infinity
    if (previousDate < date) target.set(key, candidate)
    else if (previous && previousDate === date &&
      (previous.entry.priceUsd !== candidate.entry.priceUsd || previous.entry.raw.meterId !== candidate.entry.raw.meterId)) {
      throw new Error('Equal-date official SKU rates have ambiguous prices or meter identities.')
    }
  }
  const unpricedUnits = new Map<string, { model: string; units: Set<string>; effectiveFromUtc: string; regions: Set<string> }>()
  for (const entry of snapshot.entries) {
    const model = catalogModelName(entry.raw)
    if (!model || !entry.raw.isPrimaryMeterRegion || entry.raw.tierMinimumUnits !== 0 || !entry.raw.armRegionName) continue
    if (entry.unit.kind !== 'tokens' || entry.unit.quantity === null) {
      if (!/\b(?:ft|rft|training|trng|grdr|grader|hosting|provisioned)\b/.test(normalizedPriceLabel(entry.raw.skuName))) {
        const key = `${model}|${entry.raw.effectiveStartDate}`
        const profile = unpricedUnits.get(key) ?? { model, units: new Set<string>(), effectiveFromUtc: entry.raw.effectiveStartDate, regions: new Set<string>() }
        profile.units.add(entry.unit.sourceLabel); profile.regions.add(entry.raw.armRegionName.toLowerCase()); unpricedUnits.set(key, profile)
      }
      continue
    }
    const terms = tokenPriceTerms(entry.raw, model)
    if (!terms) continue
    const skuLabel = normalizedPriceLabel(entry.raw.skuName)
    const key = JSON.stringify([model, skuLabel, entry.raw.armRegionName.toLowerCase()])
    const candidate = { entry, model, terms }
    if (Date.parse(entry.raw.effectiveStartDate) > selectedAt) select(scheduled, `${key}|${Date.parse(entry.raw.effectiveStartDate)}`, candidate)
    else select(latest, key, candidate)
    if (Date.parse(entry.raw.effectiveStartDate) <= pendingStart) select(pendingWindow, key, candidate)
  }
  // A just-effective price must not erase the rate for the still-pending completed hour.
  for (const [key, candidate] of pendingWindow) {
    if (Date.parse(latest.get(key)!.entry.raw.effectiveStartDate) > pendingStart) latest.set(`${key}|pending-hour`, candidate)
  }
  const grouped = new Map<string, CompactPriceRate>()
  for (const { entry, model, terms } of [...latest.values(), ...scheduled.values()]) {
    const usd = new Decimal(entry.priceUsd).times(1_000_000).div(entry.unit.quantity!).toFixed()
    const skuLabel = normalizedPriceLabel(entry.raw.skuName)
    const key = JSON.stringify([model, skuLabel, terms, usd, entry.raw.effectiveStartDate])
    const current = grouped.get(key)
    const region = { name: entry.raw.armRegionName.toLowerCase(), meterId: entry.raw.meterId }
    if (current) current.regions.push(region)
    else grouped.set(key, { model, skuName: entry.raw.skuName, ...terms, usd, effectiveFromUtc: entry.raw.effectiveStartDate,
      regions: [region], approvedMapping: true })
  }
  const rates = [...grouped.values()].map((rate) => ({
    ...rate, regions: rate.regions.sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => JSON.stringify([a.model, a.sku, a.tier, a.context, a.direction, a.usd])
    .localeCompare(JSON.stringify([b.model, b.sku, b.tier, b.context, b.direction, b.usd])))
  return CompactPriceCatalogSchema.parse({
    schemaVersion: 2, billingParserVersion: 3, kind: 'compact-official', snapshotId: snapshot.snapshotId,
    fetchedAtUtc: snapshot.fetchedAtUtc, generatedAtUtc: now.toISOString(), currency: 'USD', unitTokens: '1000000',
    models: [...new Set(rates.map((rate) => rate.model))].sort(),
    regions: [...new Set(rates.flatMap((rate) => rate.regions.map((region) => region.name)))].sort(),
    rates: rates.filter((rate) => Date.parse(rate.effectiveFromUtc) <= selectedAt),
    scheduledRates: rates.filter((rate) => Date.parse(rate.effectiveFromUtc) > selectedAt),
    rawEntryCount: snapshot.entries.length,
    unpricedUnits: [...unpricedUnits.values()].map((profile) => ({
      model: profile.model, units: [...profile.units].sort(), effectiveFromUtc: profile.effectiveFromUtc, regions: [...profile.regions].sort(),
    })).sort((a, b) => a.model.localeCompare(b.model)),
  })
}
