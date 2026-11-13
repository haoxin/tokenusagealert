import { useState } from 'react'
import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  ArrowSync20Regular, CheckmarkCircle20Regular, Clock20Regular, ErrorCircle20Regular, Info20Regular, Warning20Regular,
} from '@fluentui/react-icons'
import type { FoundryEstimatedCost, HourlyUsage, UsageRun } from '@tokenusagealert/schemas'
import { ApiError, startUsageCollection } from '../api'
import { formatPricingDate } from './PricingShared'

export const usageDate = formatPricingDate
export function usageMoney(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 4,
  }).format(Number(value))
}

export function usageMoneyRange(lower: string | null | undefined, upper: string | null | undefined): string {
  if (lower === null || lower === undefined) return '—'
  if (upper === null) return `${usageMoney(lower)} 起 · 上限未知`
  return upper !== undefined && Number(upper) > Number(lower) ? `${usageMoney(lower)}–${usageMoney(upper)}` : usageMoney(lower)
}

export function sumMoneyRange(values: Array<{ lower: string | null; upper: string | null | undefined }>) {
  const known = values.filter((value) => value.lower !== null)
  return {
    lower: sumUsageMoney(known.map((value) => value.lower)),
    upper: known.some((value) => value.upper === null) ? null
      : sumUsageMoney(known.map((value) => value.upper ?? value.lower)),
  }
}

export function sumUsageRange(hours: HourlyUsage[]) {
  return sumMoneyRange(hours.map((hour) => ({ lower: hour.knownCostUsd, upper: hour.knownCostUpperUsd })))
}

export function usageReferenceMoney(hour: HourlyUsage | null | undefined) {
  if (!hour || hour.status === 'failed') return '—'
  return hour.pricingRuleVersion >= 5 ? usageMoney(hour.knownCostUsd)
    : usageMoneyRange(hour.knownCostUsd, hour.knownCostUpperUsd)
}

export function sumFoundryUsage(hours: HourlyUsage[]) {
  const available = hours.filter((hour) => hour.foundryEstimatedCost?.status === 'available')
  return { costUsd: sumUsageMoney(available.map((hour) => hour.foundryEstimatedCost?.costUsd ?? null)),
    coveredHours: available.length, totalHours: hours.length }
}

export function usageFoundryStatus(estimate: FoundryEstimatedCost | undefined) {
  return estimate ? ({ available: 'Azure 原生估算可用', noData: '原生指标暂无数据',
    unsupported: '当前无适用原生指标', failed: '原生费用读取失败', partial: '原生费用覆盖不完整' })[estimate.status]
    : '未取得原生费用（历史未采集或无适用指标）'
}

export function sumUsageMoney(values: Array<string | null>): string | null {
  const available = values.filter((value): value is string => value !== null)
  if (!available.length) return null
  const scale = 1_000_000_000_000n
  const total = available.reduce((sum, value) => {
    const [integer, fraction = ''] = value.split('.')
    return sum + BigInt(integer!) * scale + BigInt(fraction.padEnd(12, '0'))
  }, 0n)
  return `${total / scale}.${(total % scale).toString().padStart(12, '0')}`
}

export function usageError(error: unknown) {
  return error instanceof ApiError ? `${error.problem.code}：${error.problem.detail}` : '读取失败，请刷新重试。没有把失败数据当作零用量。'
}

export function UsageNotice() {
  return <div className="scope-notice usage-notice" role="note">
    <Info20Regular aria-hidden="true" />
    <div>
      <strong>Models - Usage 采集 · USD 零售价估算</strong>
      <span>浅蓝虚线为本地参考估算：输入/输出按 50% 短上下文、50% 长上下文计价，各实际档位独立匹配单价；按小时比例估算缓存读取并匹配单价，缓存命中率不是精确缓存 token。深蓝实线为 FoundryModelEstimatedCost 原生 USD 估算；缺失不填零、不用参考金额代替。历史口径以小时明细为准，两种估算都不是实际账单。</span>
    </div>
  </div>
}

export function UsageBadges({ hour }: { hour: HourlyUsage | null }) {
  if (!hour) return <Badge appearance="tint" color="subtle" icon={<Clock20Regular />}>尚无该小时记录</Badge>
  return <div className="usage-badges">
    <Badge appearance="tint" color={hour.status === 'complete' ? 'success' : hour.status === 'failed' ? 'danger' : 'warning'}
      icon={hour.status === 'complete' ? <CheckmarkCircle20Regular /> : hour.status === 'failed' ? <ErrorCircle20Regular /> : <Warning20Regular />}>
      {hour.status === 'complete' ? '数据完整' : hour.status === 'failed' ? '采集失败' : '部分数据'}
    </Badge>
    <Badge appearance="tint" color="informative" icon={<Clock20Regular />}>
      {hour.finality === 'provisional' ? '暂定结果' : '已确认'}
    </Badge>
    {hour.activity === 'noUsage' && <Badge appearance="tint" color="subtle" icon={<Info20Regular />}>未观测到用量</Badge>}
    {hour.activity === 'noDeployments' && <Badge appearance="tint" color="subtle" icon={<Info20Regular />}>暂无模型部署</Badge>}
    {hour.source === 'fixture' && <Badge appearance="tint" color="warning" icon={<Info20Regular />}>本地模拟来源</Badge>}
    {hour.metricFamily && <Badge appearance="tint" color="informative" icon={<Info20Regular />}>
      {hour.metricFamily === 'models-usage' ? 'Models - Usage' : 'Azure OpenAI - Usage'}</Badge>}
    {hour.pricingRuleVersion >= 5 && <Badge appearance="tint" color="informative">50/50 上下文参考</Badge>}
    <Badge appearance="tint" color={hour.foundryEstimatedCost?.status === 'available' ? 'informative'
      : hour.foundryEstimatedCost?.status === 'failed' ? 'danger' : 'warning'} icon={<Info20Regular />}>
      {usageFoundryStatus(hour.foundryEstimatedCost)}
    </Badge>
    {hour.knownCostUsd !== null && hour.knownCostUpperUsd !== undefined &&
      (hour.knownCostUpperUsd === null || Number(hour.knownCostUpperUsd) > Number(hour.knownCostUsd)) &&
      <Badge appearance="tint" color="informative" icon={<Info20Regular />}>区间估算</Badge>}
  </div>
}

export function UsageRunSummary({ run }: { run: UsageRun | null }) {
  return <section className="panel usage-run" aria-label="最近用量采集">
    <div>
      <strong>最近用量采集</strong>
      <span>{run ? usageDate(run.finishedAtUtc ?? run.startedAtUtc) : '尚未执行'}</span>
    </div>
    {run ? <>
      <Badge appearance="tint" color={run.status === 'failed' ? 'danger' : run.status === 'succeededWithWarnings' ? 'warning' : 'informative'}
        icon={run.status === 'failed' ? <ErrorCircle20Regular /> : run.status === 'succeededWithWarnings' ? <Warning20Regular /> : <Clock20Regular />}>
        {run.status === 'succeeded' ? '完成' : run.status === 'failed' ? '失败' : run.status === 'running' ? '运行中' : '完成但有缺失'}
      </Badge>
      <span>已处理 {run.processedTenantCount} / {run.tenantCount} 个租户 · 跳过 {run.skippedTenantCount} 个未启用租户 · {run.deploymentCount} 个部署</span>
      {run.execution && <span>
        分片 {run.execution.shardId + 1}/{run.execution.shardCount} ·
        租户并发 {run.execution.tenantConcurrency} · 每租户订阅并发 {run.execution.subscriptionConcurrency} ·
        HTTP 上限 {Math.floor(run.execution.totalRequestConcurrency / run.execution.shardCount)}（本分片）
      </span>}
      {run.telemetry && <span>
        本轮 {run.telemetry.subscriptionCount} 个订阅 · HTTP 峰值 {run.telemetry.httpConcurrencyPeak} ·
        请求 {run.telemetry.httpRequests} 次 · 429 {run.telemetry.throttledRequests} 次 ·
        复用资源清单 {run.telemetry.subscriptionCacheHits} 个订阅 ·
        {(run.telemetry.durationMs / 1000).toFixed(1)} 秒
      </span>}
      {run.capacityWarning && <p className="usage-error">本轮耗时超过容量目标，需要检查限流或增加分片；不能保证新增客户仍在一小时内完成。</p>}
      {run.issues.length > 0 && <details><summary>查看 {run.issues.length} 项问题</summary>
        <ul>{run.issues.map((issue, i) => <li key={`${issue.code}-${i}`}><code>{issue.code}</code> · {issue.message}</li>)}</ul>
      </details>}
    </> : <p>价格与授权就绪后，先在“租户与授权”启用租户，再运行采集。没有记录不等于零费用。</p>}
  </section>
}

export function UsageActions({ refresh }: { refresh: () => void }) {
  const [starting, setStarting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const collect = async () => {
    setStarting(true); setError(''); setMessage('')
    try {
      const result = await startUsageCollection()
      setMessage(`采集已启动：${result.executionName}。后台完成后请刷新；启动成功不代表已获得费用。`)
      refresh()
    } catch (reason) { setError(usageError(reason)) } finally { setStarting(false) }
  }
  return <div className="usage-action-box">
    <div className="page-actions">
      <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={refresh}>刷新费用数据</Button>
      <Button appearance="primary" disabled={starting} icon={starting ? <Spinner size="tiny" /> : <ArrowSync20Regular />} onClick={() => void collect()}>
        {starting ? '启动中' : '采集上一完整小时'}
      </Button>
    </div>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="usage-error">{error}</p>}
  </div>
}

export function UsageSparkline({ hours }: { hours: HourlyUsage[] }) {
  const sorted = [...hours].sort((a, b) => a.windowStartUtc.localeCompare(b.windowStartUtc))
  const sources = [
    { color: '#479ef5', dash: '3 3', values: sorted.map((hour) =>
      hour.knownCostUsd === null || hour.status === 'failed' ? null : Number(hour.knownCostUsd)) },
    { color: '#0f6cbd', dash: undefined, values: sorted.map((hour) =>
      hour.foundryEstimatedCost?.costUsd === undefined || hour.foundryEstimatedCost.costUsd === null
        ? null : Number(hour.foundryEstimatedCost.costUsd)) },
  ]
  const max = Math.max(1, ...sources.flatMap((source) => source.values.filter((value): value is number => value !== null)))
  return <svg width="132" height="36" role="img" aria-label={hours.length
    ? '浅蓝虚线为参考估算，深蓝实线为 Azure 原生估算；缺失数据不补零' : '暂无趋势记录'}>
    {sources.map((source) => {
      const segments: string[] = []
      let points: string[] = []
      for (let i = 0; i < sorted.length; i++) {
        if (i && Date.parse(sorted[i]!.windowStartUtc) - Date.parse(sorted[i - 1]!.windowStartUtc) > 3_600_000) {
          if (points.length) segments.push(points.join(' '))
          points = []
        }
        const value = source.values[i]
        if (value === null || value === undefined) {
          if (points.length) segments.push(points.join(' '))
          points = []
        } else points.push(`${4 + i * 120 / Math.max(sorted.length - 1, 1)},${30 - value / max * 25}`)
      }
      if (points.length) segments.push(points.join(' '))
      return <g key={source.color}>
        {segments.map((line, i) => <polyline key={i} points={line} fill="none" stroke={source.color}
          strokeDasharray={source.dash} strokeWidth={source.dash ? 1.5 : 2} />)}
        {hours.length === 1 && source.values[0] !== null &&
          <circle cx="4" cy={30 - (source.values[0] ?? 0) / max * 25} r="3" fill={source.color} />}
      </g>
    })}
  </svg>
}
