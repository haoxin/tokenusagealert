import { useEffect, useState } from 'react'
import { Button, Select, Spinner, Tab, TabList } from '@fluentui/react-components'
import { ArrowLeft20Regular, Database20Regular, Edit20Regular, Info20Regular, Warning20Regular } from '@fluentui/react-icons'
import { Link, useParams } from 'react-router-dom'
import type { HourlyUsage, TenantListItem, TenantUsageResponse } from '@tokenusagealert/schemas'
import { getTenantConfig, getTenantUsage } from '../api'
import { UsageChart } from '../components/UsageChart'
import { TenantAlertTimeline } from '../components/MailPanels'
import { TenantSettingsEditor } from '../components/TenantSettingsEditor'
import { sumMoneyRange, sumUsageRange, UsageActions, UsageBadges, usageDate, usageError, usageMoney, usageMoneyRange, UsageNotice } from '../components/UsageShared'

function Breakdown({ hour }: { hour: HourlyUsage }) {
  const subscriptions = [...new Set(hour.breakdown.map((row) => row.deployment.subscriptionId))]
  return <div className="usage-tree">
    {subscriptions.map((id) => {
      const rows = hour.breakdown.filter((row) => row.deployment.subscriptionId === id)
      const accounts = [...new Set(rows.map((row) => row.deployment.accountId))]
      const amount = sumMoneyRange(rows.map((row) => ({ lower: row.costUsd, upper: row.costUpperUsd })))
      return <details key={id} open><summary><Database20Regular aria-hidden="true" />订阅 {id}<strong>{usageMoneyRange(amount.lower, amount.upper)}</strong></summary>
        {accounts.map((accountId) => <details key={accountId} open><summary>资源 {rows.find((row) => row.deployment.accountId === accountId)?.deployment.accountName}</summary>
          {rows.filter((row) => row.deployment.accountId === accountId).map((row) => <article key={row.deployment.id}>
            <div><strong>{row.deployment.name}</strong><small>{row.deployment.modelName} · {row.deployment.modelVersion} · {row.deployment.sku} · {row.deployment.region}</small></div>
            <strong>{usageMoneyRange(row.costUsd, row.costUpperUsd)}</strong>
            <dl><div><dt>输入 token</dt><dd>{row.inputTokens === null ? '—' : Number(row.inputTokens).toLocaleString('zh-CN')}</dd></div>
              <div><dt>输出 token</dt><dd>{row.outputTokens === null ? '—' : Number(row.outputTokens).toLocaleString('zh-CN')}</dd></div>
              <div><dt>指标读取</dt><dd>{row.metricsStatus === 'noData' ? '请求成功，未返回用量' : row.metricsStatus === 'failed' ? '读取失败' : '已读取'}</dd></div>
              <div><dt>价格匹配</dt><dd>{({ matched: '已匹配', range: '已匹配 · 区间估算', missing: '缺少价格/计费维度', ambiguous: '价格不唯一', unsupported: '缺少对应计费单位用量' })[row.pricingStatus]}</dd></div></dl>
            {row.pricingUncertainty?.length ? <p className="pricing-muted">区间依据：{row.pricingUncertainty.map((value) =>
              ({ context: '短/长上下文', modality: '文本/图像/音频模态', version: '价格版本', variant: 'SKU 计费变体',
                cacheWrite: '缓存写入未单独计量', tier: '实际服务档位未单独计量' })[value]).join('、')}。</p> : null}
            {row.prices.map((price) => <p key={`${price.direction}-${price.meterId ?? price.manualPriceId}-${price.effectiveStartUtc}-${price.bound}`}>
              {price.direction === 'input' ? '输入' : price.direction === 'output' ? '输出' : '缓存写入'}：{usageMoney(price.unitPriceUsd)} / {price.unitQuantity} token ·
              {price.source === 'manual' ? `手动简化估算 ${price.manualPriceId} v${price.manualPriceRevision}` : `官方 meter ${price.meterId}`}</p>)}
            {row.issues.map((issue, index) => <p className="usage-error" key={`${issue.code}-${index}`}>{issue.code}：{issue.message}</p>)}
          </article>)}
        </details>)}
      </details>
    })}
    {subscriptions.length === 0 && <p>该小时尚无 deployment 明细。{hour.activity === 'noDeployments' ? '资源发现成功，但没有部署模型。' : '请查看采集问题，不能将缺失明细视为零费用。'}</p>}
  </div>
}

export function TenantUsagePage() {
  const { tenantId } = useParams()
  const [tenant, setTenant] = useState<TenantListItem | null>(null)
  const [data, setData] = useState<TenantUsageResponse | null>(null)
  const [hours, setHours] = useState(24)
  const [selection, setSelection] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!tenantId) return
    const controller = new AbortController()
    setLoading(true); setError('')
    Promise.all([getTenantConfig(tenantId, controller.signal), getTenantUsage(tenantId, hours, controller.signal)])
      .then(([config, usage]) => { setTenant(config.tenant); setData(usage) })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(usageError(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [tenantId, hours, revision])
  const selected = data?.hours.find((hour) => hour.windowStartUtc === selection) ?? data?.hours[data.hours.length - 1] ?? null
  const total = sumUsageRange(data?.hours ?? [])
  return <div className="page usage-page">
    <Link to="/overview" className="usage-back"><ArrowLeft20Regular aria-hidden="true" />返回费用概览</Link>
    <header className="page-header"><div><span className="eyebrow">客户费用详情</span><h1>{tenant?.displayName ?? '租户详情'}</h1><p>{tenantId}</p></div>
      <div className="page-actions">
        {tenant && tenant.status !== 'deleted' && <Button icon={<Edit20Regular />} onClick={() => setEditing(true)}>编辑名称与限额</Button>}
        <UsageActions refresh={() => setRevision((value) => value + 1)} />
      </div>
    </header>
    <UsageNotice />
    {error && <div className="message error" role="alert">{error}</div>}
    {notice && <div className="message success" role="status">{notice}</div>}
    <TenantSettingsEditor tenant={editing ? tenant : null} close={() => setEditing(false)}
      refresh={() => setRevision((value) => value + 1)} saved={(updated) => {
        setTenant(updated); setEditing(false); setNotice('名称与当前费用限额已保存；已采集小时的历史阈值保持不变。')
      }} />
    {loading && !data ? <div className="loading-state"><Spinner label="读取租户费用记录" /></div> :
      <>
        {tenant && !['active', 'degraded'].includes(tenant.status) && <div className="message warning" role="note"><Info20Regular /><span>该租户当前未启用采集或授权已断开。历史仍保留；没有新记录不等于零费用。 <Link to="/">查看租户与授权</Link></span></div>}
        <div className="usage-summary-grid">
          {[
            ['所选小时已知估算小计', usageMoneyRange(selected?.status === 'failed' ? null : selected?.knownCostUsd, selected?.knownCostUpperUsd)],
            ['当前窗口已知小计', usageMoneyRange(total.lower, total.upper)],
            ['当前配置限额（USD/小时）', usageMoney(tenant?.hourlyThresholdUsd)],
            ['指标覆盖', selected ? `${selected.coverage.successfulDeployments} / ${selected.coverage.expectedDeployments} 个部署` : '—'],
          ].map(([label, value]) => <article className="panel" key={label}><small>{label}</small><strong>{value}</strong></article>)}
        </div>
        <section className="panel" aria-label="租户小时趋势">
          <div className="panel-header"><div><h2>小时费用趋势</h2><p>蓝线为已知估算下限，浅蓝虚线为有限上限，红虚线为当前限额；维度不足不伪装成唯一费用，断数保持空缺。</p></div>
            <TabList selectedValue={hours} onTabSelect={(_, item) => { if (item.value === 24 || item.value === 240) { setHours(item.value); setSelection('') } }}><Tab value={24}>24 小时</Tab><Tab value={240}>10 天</Tab></TabList>
          </div>
          <UsageChart hours={data?.hours ?? []} threshold={tenant?.hourlyThresholdUsd ?? null} select={(hour) => setSelection(hour.windowStartUtc)} />
        </section>
        <section className="panel usage-hour" aria-label="所选小时费用">
          <div className="panel-header"><div><h2>所选小时</h2><p>仅显示已采集的小时，刷新后从持久化存储读取。</p></div>
            <Select value={selected?.windowStartUtc ?? ''} onChange={(_, item) => setSelection(item.value)} aria-label="选择费用小时" disabled={!data?.hours.length}>
              {!data?.hours.length && <option value="">尚无小时记录</option>}
              {[...(data?.hours ?? [])].reverse().map((hour) => <option key={hour.windowStartUtc} value={hour.windowStartUtc}>{usageDate(hour.windowStartUtc)}</option>)}
            </Select>
          </div>
          {selected ? <div className="usage-hour-body">
            <UsageBadges hour={selected} />
            <p>北京时间 {usageDate(selected.windowStartUtc)} 至 {usageDate(selected.windowEndUtc)} · 采集时间 {usageDate(selected.collectedAtUtc)}</p>
            {selected.activity === 'noUsage' && <div className="scope-notice"><Info20Regular />Monitor 请求已成功返回，但没有观测到该小时 token 用量。真实正用量的金额准确性尚待验证。</div>}
            {selected.status !== 'complete' && <div className="message warning"><Warning20Regular />当前不是完整租户总费用；未匹配或不可见部分不按零价补齐。</div>}
            <dl className="usage-basis"><div><dt>官方价格快照</dt><dd>{selected.priceSnapshotId ?? '尚无官方快照'}</dd></div>
              <div><dt>指标来源</dt><dd>{selected.metricFamily === 'models-usage'
                ? 'Models - Usage · InputTokens / OutputTokens'
                : 'Azure OpenAI - Usage · ProcessedPromptTokens / GeneratedTokens（历史口径）'}</dd></div>
              {selected.manualPriceSnapshotId && <div><dt>手动价格快照</dt><dd>{selected.manualPriceSnapshotId}</dd></div>}
              {selected.repricedAtUtc && <div><dt>缺价补算时间</dt><dd>{usageDate(selected.repricedAtUtc)} · 原采集时间和阈值未改</dd></div>}
              <div><dt>该小时采集阈值</dt><dd>{usageMoney(selected.thresholdUsd)}</dd></div>
              <div><dt>估算策略</dt><dd>{selected.manualPriceSnapshotId && '官方优先；手动补充采用统一输入/输出价。'}
                {selected.estimatePolicy === 'model-independent-retail-range'
                  ? '通用官方计价；上下文/模态/服务档位不明确时显示区间，缓存输入沿用普通输入估算，未知写入纳入上限。'
                  : 'cached input 按普通 input 价格保守估算'}</dd></div>
              <div><dt>授权订阅覆盖</dt><dd>{selected.coverage.successfulSubscriptions} / {selected.coverage.expectedSubscriptions}</dd></div>
              <div><dt>价格匹配覆盖</dt><dd>{selected.coverage.pricedDeployments} / {selected.coverage.expectedDeployments}</dd></div></dl>
            {selected.issues.length > 0 && <details open className="usage-issues"><summary>数据与价格问题（{selected.issues.length}）</summary><ul>{selected.issues.map((issue, i) => <li key={`${issue.code}-${i}`}><code>{issue.code}</code>：{issue.message}</li>)}</ul></details>}
            <h3>订阅 → 资源 → deployment 明细</h3><Breakdown hour={selected} />
          </div> : <div className="empty-state"><strong>尚无小时费用记录</strong><span>已启用租户可点击采集；没有记录时金额显示“—”。</span></div>}
        </section>
        {tenantId && <TenantAlertTimeline tenantId={tenantId} />}
      </>}
  </div>
}
