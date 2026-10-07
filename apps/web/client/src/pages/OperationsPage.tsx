import { Spinner } from '@fluentui/react-components'
import {
  Calendar20Regular,
  DataUsage20Regular,
  Info20Regular,
  Mail20Regular,
  Pulse20Regular,
  ShieldLock20Regular,
} from '@fluentui/react-icons'
import { Link } from 'react-router-dom'
import {
  formatPricingCount,
  formatPricingDate,
  PricingControls,
  PricingFreshnessBadge,
  PricingMessages,
  PricingRunBadge,
  PricingRunDetails,
  PricingScopeNotice,
  PricingSourceNotice,
} from '../components/PricingShared'
import { usePricingStatus } from '../components/usePricingStatus'
import { UsageStatusPanel } from '../components/UsageStatusPanel'
import { MailOperationsPanel } from '../components/MailPanels'

export function OperationsPage() {
  const pricing = usePricingStatus()
  const { status } = pricing

  return (
    <div className="page pricing-page operations-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">平台健康度 / Pricing Sync</span>
          <h1>运行状态</h1>
          <p>查看价格同步与小时用量采集的真实后台摘要。</p>
        </div>
        <PricingControls pricing={pricing} />
      </header>

      <PricingScopeNotice />
      <PricingSourceNotice status={status} />
      <PricingMessages pricing={pricing} />
      <UsageStatusPanel />
      <MailOperationsPanel />

      {!status && pricing.operation !== 'idle' ? (
        <div className="panel pricing-empty"><Spinner label="正在读取价格运行状态" /></div>
      ) : (
        <>
          <section className="pricing-operation-metrics" aria-label="价格同步摘要">
            <article className="panel">
              <Pulse20Regular aria-hidden="true" />
              <span>最近 Pricing Sync</span>
              {status ? <PricingRunBadge run={status.latestRun} /> : <strong>—</strong>}
              <small>{formatPricingDate(status?.latestRun?.startedAtUtc)}</small>
            </article>
            <article className="panel">
              <DataUsage20Regular aria-hidden="true" />
              <span>当前价格快照</span>
              <strong>{formatPricingCount(status?.active?.meterCount)} <small>个 meter</small></strong>
              <PricingFreshnessBadge freshness={status?.freshness} />
            </article>
            <article className="panel">
              <Calendar20Regular aria-hidden="true" />
              <span>下次计划 · 北京时间</span>
              <strong className="pricing-operation-schedule">{formatPricingDate(status?.nextScheduledAtUtc)}</strong>
              <small>每日 00:00 · 校验通过自动更新</small>
            </article>
          </section>
          <PricingRunDetails status={status} />
        </>
      )}

      <section className="panel pricing-operation-scope" aria-labelledby="pricing-operations-scope-title">
        <div className="panel-header">
          <div>
            <h2 id="pricing-operations-scope-title">当前运行状态的范围</h2>
            <p>已接入价格、用量与邮件任务，不使用模拟成功记录填充未实现功能。</p>
          </div>
          <Info20Regular aria-hidden="true" />
        </div>
        <div className="pricing-scope-grid">
          <article>
            <ShieldLock20Regular aria-hidden="true" />
            <div><strong>授权同步</strong><p>继续使用现有租户页面的 Lighthouse 同步及授权状态。</p><Link to="/">前往租户与授权</Link></div>
          </article>
          <article>
            <DataUsage20Regular aria-hidden="true" />
            <div><strong>用量与费用计算</strong><p>已接通资源发现、小时指标、费用存储和展示；当前无用量，真实金额对照留待后续。</p><Link to="/overview">查看费用概览</Link></div>
          </article>
          <article>
            <Mail20Regular aria-hidden="true" />
            <div><strong>告警与邮件 Outbox</strong><p>已接入告警事件、邮件投递、预览和不确定状态人工处理。发信授权与自动通知状态以设置页为准。</p><Link to="/settings">查看告警与邮件设置</Link></div>
          </article>
        </div>
      </section>
      <p className="pricing-read-time">最近读取状态（北京时间）：{formatPricingDate(pricing.readAt)} · <Link to="/settings">查看快照与 90 天备份</Link></p>
    </div>
  )
}
