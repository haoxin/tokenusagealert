import type { CompactPriceRate, RetailPriceItem } from '@tokenusagealert/schemas'

export const normalizedPriceLabel = (value: string) =>
  value.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\bbatch(outpt|outp|inp)\b/g, 'batch $1').replace(/\bmini(\d{4})\b/g, 'mini $1')
    .replace(/\boutpt\b/g, 'outp').replace(/\b(?:ccchd|cched)\b/g, 'cached')
    .replace(/\bmn\b/g, 'mini').replace(/\b(?:trscb|tcrb)\b/g, 'transcribe')
    .replace(/\bturbo(4k|8k|128k)\b/g, 'turbo $1')
    .replace(/\brealtimeprvw(aud|txt)(inp|outp)\b/g, 'rt $1 $2').replace(/\brealtimeprvw\b/g, 'rt')
    .replace(/\btranscribe d\b/g, 'transcribe diarize')

export function tokenPriceTerms(item: Pick<RetailPriceItem, 'skuName'>, model: string) {
  const label = normalizedPriceLabel(item.skuName)
  if (/\b(?:ft|rft|training|trng|grdr|grader|hosting|provisioned)\b/.test(label)) return null
  const sku: CompactPriceRate['sku'] | null = /\b(?:gl|glb|glbl|global)\b/.test(label) ? 'GlobalStandard'
    : /\b(?:dz|dzn|dzone|datazone|data zone)\b/.test(label) ? 'DataZoneStandard'
      : /\b(?:reg|regn|regnl|rgnl|regional)\b/.test(label) ? 'Standard' : null
  if (!sku) return null
  const input = /\b(?:in|inp|inpt|input)\b/.test(label)
  const output = /\b(?:opt|out|outp|output)\b/.test(label)
  const write = /\b(?:cd wr|cache write|cached write)\b/.test(label)
  if (input && output) return null
  const direction: CompactPriceRate['direction'] | null = write ? 'cacheWrite'
    : input ? /\b(?:cd|cached|cchd|cache)\b/.test(label) ? 'cachedInput' : 'input'
      : output ? 'output' : model.startsWith('text-embedding-') ? 'input' : null
  if (!direction) return null
  const tier: CompactPriceRate['tier'] = /\bbatch\b/.test(label) ? 'batch'
    : /\b(?:pp|priority)\b/.test(label) ? 'priority' : /\b(?:fl|flex)\b/.test(label) ? 'flex' : 'standard'
  const context: CompactPriceRate['context'] = /\b(?:longco|loco)\b/.test(label) ? 'long'
    : /\b(?:shortco|shco)\b/.test(label) ? 'short' : 'uniform'
  const modality: CompactPriceRate['modality'] = /\b(?:txt|text)\b/.test(label) ? 'text'
    : /\b(?:aud(?:\d{4})?|audio)\b/.test(label) ? 'audio'
      : /\b(?:img|image)\b/.test(label) ? 'image' : /\bvideo\b/.test(label) ? 'video' : 'unspecified'
  const iso = /\b\d{4}-\d{2}-\d{2}\b/.exec(item.skuName)?.[0]
  const compact = /\b(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/.exec(label)?.[0]
  return { sku, tier, context, direction, modality, modelVersion: iso ?? compact ?? null }
}

export function priceVersionMatches(priceVersion: string | null, deploymentVersion: string | null): boolean {
  if (priceVersion === null) return true
  if (deploymentVersion === null) return false
  if (priceVersion === deploymentVersion) return true
  return /^\d{4}$/.test(priceVersion) && /^\d{4}-\d{2}-\d{2}$/.test(deploymentVersion) &&
    deploymentVersion.slice(5).replace('-', '') === priceVersion
}
