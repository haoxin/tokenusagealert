import { useEffect, useState } from 'react'
import { Badge, Input, Select, Spinner } from '@fluentui/react-components'
import { CheckmarkCircle20Regular, Search20Regular, Warning20Regular } from '@fluentui/react-icons'
import { Link } from 'react-router-dom'
import type { UsageOverview } from '@tokenusagealert/schemas'
import { getUsageDashboard } from '../api'
import { sumUsageRange, UsageActions, UsageBadges, usageDate, usageError, usageMoney, usageMoneyRange, UsageNotice, UsageRunSummary, UsageSparkline } from '../components/UsageShared'

export function UsageOverviewPage() {
  const [data, setData] = useState<UsageOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('amount')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    getUsageDashboard(controller.signal).then(setData).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(usageError(reason))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const rows = (data?.tenants ?? []).filter((tenant) =>
    `${tenant.displayName} ${tenant.tenantId}`.toLowerCase().includes(search.toLowerCase()) &&
    (filter === 'all' || (filter === 'empty' ? !tenant.latest || ['noUsage', 'noDeployments'].includes(tenant.latest.activity)
      : filter === 'issue' ? tenant.latest?.status !== 'complete' : tenant.latest?.status === 'complete')),
  ).sort((a, b) => sort === 'name' ? a.displayName.localeCompare(b.displayName, 'zh-CN')
    : Number(b.latest?.knownCostUsd ?? -1) - Number(a.latest?.knownCostUsd ?? -1))
  const tenants = data?.tenants ?? []
  const known = sumUsageRange(tenants.flatMap((tenant) => tenant.latest ? [tenant.latest] : []))
  const day = sumUsageRange(tenants.flatMap((tenant) => tenant.hours))
  const breaches = tenants.filter((tenant) => tenant.latest?.knownCostUsd !== null && tenant.latest?.knownCostUsd !== undefined &&
    tenant.latest.thresholdUsd !== null && Number(tenant.latest.knownCostUsd) > Number(tenant.latest.thresholdUsd)).length
  const anomalies = tenants.filter((tenant) => tenant.latest && tenant.latest.status !== 'complete').length
  return <div className="page usage-page">
    <header className="page-header">
      <div><span className="eyebrow">费用监控</span><h1>费用概览</h1><p>已授权租户的小时用量与零售价估算；无记录、无用量和采集失败分别展示。</p></div>
      <UsageActions refresh={() => setRevision((value) => value + 1)} />
    </header>
    <UsageNotice />
    {data?.shardCoverage && <div className="scope-notice">
      <span>单小时指标 · 资源清单每 2 小时刷新 · 本窗口分片 {data.shardCoverage.current}/{data.shardCoverage.expected} 已生成概览
        {data.shardCoverage.current < data.shardCoverage.expected ? '；当前汇总可能不完整，尚未完成的分片不按零金额计算。' : '。'}
      </span>
    </div>}
    {error && <div className="message error" role="alert">{error}</div>}
    <div className="usage-summary-grid">
      {[
        ['最近小时已知估算小计', usageMoneyRange(known.lower, known.upper), '缺失订阅/未匹配价格不计入完整总额'],
        ['24 小时已知估算小计', usageMoneyRange(day.lower, day.upper), '仅累加已记录小时，缺口不补零'],
        ['已知金额超阈值', data ? String(breaches) : '—', '估算下限超限时触发；通知需已启用'],
        ['数据不完整租户', data ? String(anomalies) : '—', '无历史记录的未启用租户不视为正常零费用'],
      ].map(([label, value, note]) => <article className="panel" key={label}><small>{label}</small><strong>{value}</strong><p>{note}</p></article>)}
    </div>
    {data && <p className="usage-window">本次窗口：{usageDate(data.windowStartUtc)} 至 {usageDate(data.windowEndUtc)}（北京时间） · 每小时第 15 分钟采集</p>}
    <UsageRunSummary run={data?.latestRun ?? null} />
    <section className="panel" aria-label="租户费用列表">
      <div className="panel-header">
        <div><h2>客户租户</h2><p>点击租户查看小时趋势、价格依据和模型部署明细。</p></div>
        <div className="usage-filters">
          <Input contentBefore={<Search20Regular />} value={search} onChange={(_, item) => setSearch(item.value)} placeholder="搜索租户" aria-label="搜索费用租户" />
          <Select value={filter} onChange={(_, item) => setFilter(item.value)} aria-label="费用状态筛选">
            <option value="all">全部状态</option><option value="empty">无用量 / 无记录</option><option value="issue">数据待确认</option><option value="complete">数据完整</option>
          </Select>
          <Select value={sort} onChange={(_, item) => setSort(item.value)} aria-label="费用排序"><option value="amount">已知金额降序</option><option value="name">租户名称</option></Select>
        </div>
      </div>
      {loading && !data ? <div className="loading-state"><Spinner label="读取费用记录" /></div> :
        rows.length === 0 ? <div className="empty-state"><strong>尚无匹配的租户</strong><span>先完成租户授权并启用，再运行采集。</span><Link to="/">租户与授权</Link></div> :
          <div className="table-wrap"><table className="usage-overview-table"><thead><tr><th>客户租户</th><th>授权状态</th><th>最近小时</th><th>24 小时趋势</th><th>数据 / 阶段</th></tr></thead><tbody>
            {rows.map((tenant) => <tr key={tenant.tenantId}>
              <td><Link className="usage-tenant-link" to={`/tenants/${tenant.tenantId}/usage`}>{tenant.displayName}</Link><small className="usage-secondary">{tenant.tenantId}</small></td>
              <td><Badge appearance="tint" color={tenant.status === 'active' ? 'success' : 'warning'} icon={tenant.status === 'active' ? <CheckmarkCircle20Regular /> : <Warning20Regular />}>
                {({ active: '授权正常', degraded: '授权范围变化', disconnected: '授权断开', discovered: '待启用', pendingAuthorization: '待授权', disabled: '已停用' } as Record<string, string>)[tenant.status] ?? tenant.status}
              </Badge></td>
              <td><strong>{usageMoneyRange(tenant.latest?.status === 'failed' ? null : tenant.latest?.knownCostUsd, tenant.latest?.knownCostUpperUsd)}</strong>
                <small className="usage-secondary">{tenant.latest?.status === 'partial' ? '已知估算小计 · 非完整总额' : tenant.latest ? '零售价估算' : '尚无该小时记录'}</small>
                <small className="usage-secondary">阈值 {usageMoney(tenant.thresholdUsd)} / 小时</small></td>
              <td><UsageSparkline hours={tenant.hours} /></td>
              <td><UsageBadges hour={tenant.latest} /></td>
            </tr>)}
          </tbody></table></div>}
    </section>
  </div>
}
