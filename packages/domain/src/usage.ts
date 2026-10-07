import { Decimal } from 'decimal.js'
import type {
  DeploymentInventory, DeploymentUsage, NormalizedPrice, PricingSnapshot,
  TokenObservation, UsagePriceReference, UsagePriceBook, TokenBillingSlice, CompactPriceRate,
} from '@tokenusagealert/schemas'
import { catalogModelName } from './pricing.js'
import { normalizedPriceLabel, priceVersionMatches, tokenPriceTerms } from './price-terms.js'

export const HOUR_MS = 3_600_000
export const USAGE_RETENTION_MS = 240 * HOUR_MS

export function collectionWindow(now: Date) {
  const end = Math.floor((now.getTime() - 15 * 60_000) / HOUR_MS) * HOUR_MS
  return {
    windowStartUtc: new Date(end - HOUR_MS).toISOString(),
    windowEndUtc: new Date(end).toISOString(),
  }
}

export function businessDate(value: string): string {
  return new Date(Date.parse(value) + 8 * HOUR_MS).toISOString().slice(0, 10)
}

function deploymentPriceType(sku: string | null): NormalizedPrice['deploymentType'] | null {
  return sku === 'GlobalStandard' || sku === 'GlobalBatch' ? 'global'
    : sku === 'DataZoneStandard' || sku === 'DataZoneBatch' ? 'dataZone'
      : sku === 'Standard' || sku === 'Batch' ? 'regional' : null
}

export function supportsTokenDeployment(deployment: DeploymentInventory) {
  return ['OpenAI', 'AIServices'].includes(deployment.accountKind) && !!deployment.modelFormat?.trim() &&
    deploymentPriceType(deployment.sku) !== null
}

export type UsagePricingInput = PricingSnapshot | UsagePriceBook
interface UsageRate {
  model: string
  deploymentType: NormalizedPrice['deploymentType']
  direction: 'input' | 'output' | 'cachedInput' | 'cacheWrite' | 'unknown'
  region: string
  meterId: string
  quantity: string
  usd: string
  effectiveFromUtc: string
  tier: CompactPriceRate['tier']
  context: CompactPriceRate['context']
  modality: CompactPriceRate['modality']
  modelVersion: string | null
  skuName: string
}
const isBook = (value: UsagePricingInput): value is UsagePriceBook => 'kind' in value && value.kind === 'usage-price-book'
const officialSnapshotId = (value: UsagePricingInput | null) => value ? isBook(value) ? value.official?.snapshotId ?? null : value.snapshotId : null

export function indexUsagePrices(snapshot: UsagePricingInput | null): Map<string, UsageRate[]> {
  const index = new Map<string, UsageRate[]>()
  const add = (rate: UsageRate) => {
    const key = `${rate.model}|${rate.deploymentType}|${rate.region}|${rate.tier}|${rate.direction}`
    const entries = index.get(key) ?? []; entries.push(rate); index.set(key, entries)
  }
  if (!snapshot) return index
  if (isBook(snapshot)) {
    for (const rate of [...snapshot.official?.rates ?? [], ...snapshot.official?.scheduledRates ?? []]) {
      const terms = tokenPriceTerms({ skuName: rate.skuName }, rate.model)
      for (const region of rate.regions) add({
        model: rate.model, deploymentType: deploymentPriceType(rate.sku) ?? 'unknown', direction: rate.direction,
        region: region.name, meterId: region.meterId, quantity: '1000000', usd: rate.usd,
        effectiveFromUtc: rate.effectiveFromUtc, tier: rate.tier, context: rate.context,
        modality: snapshot.official?.schemaVersion === 2 ? rate.modality : terms?.modality ?? 'unspecified',
        modelVersion: snapshot.official?.schemaVersion === 2 ? rate.modelVersion : terms?.modelVersion ?? null,
        skuName: rate.skuName,
      })
    }
  } else {
    for (const entry of snapshot.entries) {
      const model = catalogModelName(entry.raw)
      const terms = model ? tokenPriceTerms(entry.raw, model) : null
      if (!model || !terms || entry.unit.kind !== 'tokens' ||
        entry.unit.quantity === null || entry.raw.tierMinimumUnits !== 0 || !entry.raw.isPrimaryMeterRegion) continue
      add({ model, deploymentType: deploymentPriceType(terms.sku)!, direction: terms.direction,
        region: entry.raw.armRegionName.toLowerCase(), meterId: entry.raw.meterId, quantity: entry.unit.quantity,
        usd: entry.priceUsd, effectiveFromUtc: entry.raw.effectiveStartDate, tier: terms.tier,
        context: terms.context, modality: terms.modality, modelVersion: terms.modelVersion, skuName: entry.raw.skuName })
    }
  }
  return index
}

export function calculateDeploymentCost(
  observation: TokenObservation,
  snapshot: UsagePricingInput | null,
  windowStartUtc: string,
  priceIndex?: ReturnType<typeof indexUsagePrices>,
): DeploymentUsage {
  const result: DeploymentUsage = {
    ...observation, issues: [...observation.issues], costUsd: null, costUpperUsd: null,
    pricingStatus: 'missing', prices: [], pricingUncertainty: [],
  }
  const deployment = observation.deployment
  const issue = (code: string, message: string) =>
    result.issues.push({ code, message, resourceId: deployment.id })
  if (!supportsTokenDeployment(deployment)) {
    result.pricingStatus = 'unsupported'
    issue('UNSUPPORTED_BILLING_UNIT', '该部署不是可用 Monitor 输入/输出 token 计量的按量 SKU；不能把容量/其他计量单位当作零费用。')
    return result
  }
  if (!snapshot) {
    issue('PRICE_SNAPSHOT_MISSING', '尚无有效价格快照。')
    return result
  }
  const index = priceIndex ?? indexUsagePrices(snapshot)
  const defaultTier: CompactPriceRate['tier'] = deployment.sku?.includes('Batch') ? 'batch' : 'standard'
  const possibleTiers = (tier: CompactPriceRate['tier'] | null): CompactPriceRate['tier'][] =>
    tier !== null ? [tier] : defaultTier === 'batch' ? ['batch']
      : observation.metricFamily === 'models-usage' ? ['standard', 'priority', 'flex'] : [defaultTier]
  const candidatesFor = (direction: string, tier: CompactPriceRate['tier']) => {
    const rates = (index.get(
      `${deployment.modelName?.toLowerCase()}|${deploymentPriceType(deployment.sku)}|${deployment.region.toLowerCase()}|${tier}|${direction}`,
    ) ?? []).filter((rate) => Date.parse(rate.effectiveFromUtc) <= Date.parse(windowStartUtc) &&
      priceVersionMatches(rate.modelVersion, deployment.modelVersion))
    const latest = new Map<string, number>()
    for (const rate of rates) {
      const key = normalizedPriceLabel(rate.skuName)
      latest.set(key, Math.max(latest.get(key) ?? -Infinity, Date.parse(rate.effectiveFromUtc)))
    }
    return rates.filter((rate) => Date.parse(rate.effectiveFromUtc) === latest.get(normalizedPriceLabel(rate.skuName)))
  }
  const tiers = new Set<CompactPriceRate['tier']>(observation.billingSlices?.length
    ? observation.billingSlices.flatMap((slice) => possibleTiers(slice.tier)) : [defaultTier])
  const hasOfficial = [...tiers].some((tier) =>
    ['input', 'output', 'cachedInput', 'cacheWrite'].some((direction) => candidatesFor(direction, tier).length > 0))
  const unsupportedUnits = isBook(snapshot) ? snapshot.official?.unpricedUnits?.filter((item) =>
    item.model === deployment.modelName?.toLowerCase() &&
    (item.effectiveFromUtc === undefined || Date.parse(item.effectiveFromUtc) <= Date.parse(windowStartUtc)) &&
    (item.regions === undefined || item.regions.includes(deployment.region.toLowerCase())))
    .flatMap((item) => item.units) ?? [] : []
  if (unsupportedUnits.length) issue('ADDITIONAL_BILLING_UNITS_MISSING',
    `该模型还包含 ${unsupportedUnits.join('、')} 计费单位；当前 token 指标不能确认这些费用，已知 token 小计不代表模型完整总额。`)
  const manualDocument = isBook(snapshot) ? snapshot.manual : null
  if (!hasOfficial && !unsupportedUnits.length && manualDocument?.snapshotId && tiers.has('standard') &&
    !observation.billingSlices?.some((slice) => slice.tier !== null && slice.tier !== 'standard')) {
    const manual = manualDocument.versions.filter((rate) => rate.enabled && rate.modelName === deployment.modelName?.toLowerCase() &&
      (rate.modelVersion === null || rate.modelVersion === deployment.modelVersion) && rate.deploymentSku === deployment.sku &&
      (rate.regionScope === 'all' || rate.regions.includes(deployment.region.toLowerCase())) &&
      rate.effectiveFromUtc <= windowStartUtc && (rate.effectiveToUtc === null || windowStartUtc < rate.effectiveToUtc))
    if (manual.length > 1) {
      result.pricingStatus = 'ambiguous'; issue('MANUAL_PRICE_AMBIGUOUS', '存在多个适用的手动价格，不猜测选择。'); return result
    }
    const price = manual[0]
    if (price) {
      result.prices = (['input', 'output'] as const).map((direction) => ({
        direction, meterId: null, source: 'manual', manualPriceId: price.ruleId, manualPriceRevision: price.revision,
        unitQuantity: '1000000', unitPriceUsd: direction === 'input' ? price.inputUsdPerMillion : price.outputUsdPerMillion,
        effectiveStartUtc: price.effectiveFromUtc, snapshotId: manualDocument.snapshotId!,
      }))
    }
  }
  if (observation.inputTokens === null || observation.outputTokens === null || observation.metricsStatus === 'failed') {
    return result
  }
  const hasUsage = new Decimal(observation.inputTokens).plus(observation.outputTokens).gt(0)
  if (hasUsage && !observation.metadataVerified) {
    issue('HISTORICAL_DEPLOYMENT_UNVERIFIED', '尚未确认该小时的模型版本和部署元数据，不能把当前价格套到历史用量。')
    return result
  }
  if (result.prices.length) {
    const total = result.prices.reduce((sum, price) =>
      sum.plus(new Decimal(price.direction === 'input' ? observation.inputTokens! : observation.outputTokens!)
        .div(price.unitQuantity).times(price.unitPriceUsd)), new Decimal(0))
    result.costUsd = total.toFixed(12, Decimal.ROUND_HALF_EVEN)
    result.costUpperUsd = result.costUsd
    result.pricingStatus = 'matched'
    return result
  }
  if (!hasOfficial) {
    result.pricingStatus = unsupportedUnits.length ? 'unsupported' : 'missing'
    issue(unsupportedUnits.length ? 'UNSUPPORTED_BILLING_UNIT' : 'PRICE_MODEL_NOT_FOUND',
      '没有适用于该模型/版本/SKU/区域/服务档位的 token 单价；官方优先，缺价不按零价处理。')
    return result
  }
  const slices: TokenBillingSlice[] = observation.billingSlices?.length ? observation.billingSlices : (['input', 'output'] as const).map((direction) => ({
    direction, tokens: direction === 'input' ? observation.inputTokens! : observation.outputTokens!,
    context: null, modality: null, tier: defaultTier,
  }))
  for (const direction of ['input', 'output'] as const) {
    const total = slices.filter((slice) => slice.direction === direction)
      .reduce((sum, slice) => sum.plus(slice.tokens), new Decimal(0))
    if (!total.eq(direction === 'input' ? observation.inputTokens : observation.outputTokens)) {
      issue('TOKEN_SLICE_MISMATCH', '计费分组与该小时 token 总数不一致，不重复计算或猜测缺口。')
      return result
    }
  }
  let lower = new Decimal(0)
  let upper = new Decimal(0)
  let matched = 0
  let incomplete = unsupportedUnits.length > 0
  const uncertainty = new Set<NonNullable<DeploymentUsage['pricingUncertainty']>[number]>()
  const references = new Map<string, UsagePriceReference>()
  const addReference = (rate: UsageRate, direction: UsagePriceReference['direction'], bound: 'lower' | 'upper' | 'both') => {
    const key = `${direction}|${rate.meterId}|${rate.effectiveFromUtc}`
    const previous = references.get(key)
    references.set(key, {
      direction, meterId: rate.meterId, source: 'official', unitQuantity: rate.quantity, unitPriceUsd: rate.usd,
      effectiveStartUtc: rate.effectiveFromUtc, snapshotId: officialSnapshotId(snapshot)!,
      context: rate.context, modality: rate.modality, tier: rate.tier, modelVersion: rate.modelVersion,
      skuName: rate.skuName, bound: previous && previous.bound !== bound ? 'both' : bound,
    })
  }
  const ratePerToken = (rate: UsageRate) => new Decimal(rate.usd).div(rate.quantity)
  const extrema = (rates: UsageRate[]) => {
    const sorted = [...rates].sort((a, b) => ratePerToken(a).comparedTo(ratePerToken(b)) || a.meterId.localeCompare(b.meterId))
    return [sorted[0]!, sorted[sorted.length - 1]!] as const
  }
  for (const slice of slices) {
    const candidates = possibleTiers(slice.tier).flatMap((tier) => candidatesFor(slice.direction, tier)).filter((rate) =>
      (slice.context === null || rate.context === 'uniform' || rate.context === slice.context) &&
      (slice.modality === null || rate.modality === 'unspecified' || rate.modality === slice.modality))
    if (!candidates.length) {
      if (new Decimal(slice.tokens).gt(0)) {
        incomplete = true
        issue('PRICE_MATCH_FAILED', `${slice.direction} 计费分组缺少对应单价；已知方向保留为小计，缺失方向不补零。`)
      }
      continue
    }
    matched += 1
    const [minimum, maximum] = extrema(candidates)
    lower = lower.plus(new Decimal(slice.tokens).times(ratePerToken(minimum)))
    upper = upper.plus(new Decimal(slice.tokens).times(ratePerToken(maximum)))
    const varies = !ratePerToken(minimum).eq(ratePerToken(maximum))
    addReference(minimum, slice.direction, varies ? 'lower' : 'both')
    if (varies) {
      addReference(maximum, slice.direction, 'upper')
      if (new Decimal(slice.tokens).gt(0)) {
        const tierVaries = new Set(candidates.map((rate) => rate.tier)).size > 1
        const contextVaries = new Set(candidates.map((rate) => rate.context)).size > 1
        const modalityVaries = new Set(candidates.map((rate) => rate.modality)).size > 1
        const versionVaries = new Set(candidates.map((rate) => rate.modelVersion)).size > 1
        if (tierVaries) uncertainty.add('tier')
        if (contextVaries) uncertainty.add('context')
        if (modalityVaries) uncertainty.add('modality')
        if (versionVaries) uncertainty.add('version')
        if (!tierVaries && !contextVaries && !modalityVaries && !versionVaries) uncertainty.add('variant')
      }
    }
  }
  const writes = [...tiers].flatMap((tier) => candidatesFor('cacheWrite', tier))
  if (writes.length && new Decimal(observation.inputTokens).gt(0)) {
    const [minimum, maximum] = extrema(writes)
    const count = observation.cacheWriteTokens
    if (count !== undefined && count !== null && new Decimal(count).gt(observation.inputTokens)) {
      issue('CACHE_WRITE_COUNT_INVALID', '缓存写入 token 数超出输入总数，不能确认计价。')
      return result
    }
    if (count !== undefined && count !== null) {
      const inputs = slices.filter((slice) => slice.direction === 'input').map((slice) => {
        const rates = possibleTiers(slice.tier).flatMap((tier) => candidatesFor('input', tier)).filter((rate) =>
          (slice.context === null || rate.context === 'uniform' || rate.context === slice.context) &&
          (slice.modality === null || rate.modality === 'unspecified' || rate.modality === slice.modality))
        const bounds = rates.length ? extrema(rates) : null
        return { tokens: new Decimal(slice.tokens), minimum: bounds ? ratePerToken(bounds[0]) : new Decimal(0),
          maximum: bounds ? ratePerToken(bounds[1]) : new Decimal(0) }
      })
      const replacedInput = (mode: 'minimum' | 'maximum') => {
        let remaining = new Decimal(count)
        let amount = new Decimal(0)
        const sorted = [...inputs].sort((a, b) => mode === 'maximum'
          ? b.maximum.comparedTo(a.maximum) : a.minimum.comparedTo(b.minimum))
        for (const input of sorted) {
          const replaced = Decimal.min(input.tokens, remaining)
          amount = amount.plus(replaced.times(input[mode])); remaining = remaining.minus(replaced)
        }
        return amount
      }
      lower = lower.minus(replacedInput('maximum')).plus(new Decimal(count).times(ratePerToken(minimum)))
      upper = upper.minus(replacedInput('minimum')).plus(new Decimal(count).times(ratePerToken(maximum)))
      lower = Decimal.max(0, lower)
      if (new Decimal(count).gt(0)) {
        addReference(minimum, 'cacheWrite', 'lower'); addReference(maximum, 'cacheWrite', 'upper')
      }
    } else {
      upper = upper.plus(new Decimal(observation.inputTokens).times(ratePerToken(maximum)))
      uncertainty.add('cacheWrite'); addReference(maximum, 'cacheWrite', 'upper')
    }
  }
  if (matched === 0) return result
  result.costUsd = lower.toFixed(12, Decimal.ROUND_HALF_EVEN)
  result.costUpperUsd = incomplete ? null : upper.toFixed(12, Decimal.ROUND_HALF_EVEN)
  result.pricingStatus = incomplete ? 'missing' : upper.gt(lower) ? 'range' : 'matched'
  result.pricingUncertainty = [...uncertainty]
  result.prices = [...references.values()]
  return result
}
