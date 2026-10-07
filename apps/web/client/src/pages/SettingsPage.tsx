import { Badge, Spinner } from '@fluentui/react-components'
import {
  Calendar20Regular,
  Clock20Regular,
  Database20Regular,
  DataUsage20Regular,
  History20Regular,
  Info20Regular,
  Mail20Regular,
} from '@fluentui/react-icons'
import { Link } from 'react-router-dom'
import { PricingHistory } from '../components/PricingHistory'
import {
  formatPricingCount,
  formatPricingDate,
  PricingControls,
  PricingFreshnessBadge,
  PricingMessages,
  PricingRunBadge,
  PricingRunFailure,
  PricingScopeNotice,
  PricingSourceBadge,
  PricingSourceNotice,
} from '../components/PricingShared'
import { usePricingStatus } from '../components/usePricingStatus'
import { MailSettingsPanel } from '../components/MailPanels'
import { PricingDownloadButton } from '../components/PricingDownloadButton'
import { ManualPricingPanel } from '../components/ManualPricingPanel'

export function SettingsPage() {
  const pricing = usePricingStatus()
  const { status } = pricing
  const snapshot = status?.active
  const changes = snapshot?.changes

  return (
    <div className="page pricing-page settings-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">平台配置 / Pricing</span>
          <h1>设置</h1>
          <p>配置运维通知，查看发信授权状态和每日自动维护的公开零售价。</p>
        </div>
        <PricingControls pricing={pricing} />
      </header>

      <PricingScopeNotice />
      <PricingSourceNotice status={status} />
      <PricingMessages pricing={pricing} />
      <PricingRunFailure status={status} />
      <MailSettingsPanel />
      <ManualPricingPanel />

      <div className="pricing-settings-layout">
        <div className="pricing-settings-main">
          <section className="panel pricing-current" aria-labelledby="pricing-current-title">
            <div className="panel-header">
              <div>
                <h2 id="pricing-current-title">当前价格快照</h2>
                <p>仅显示后台当前指针指向的快照</p>
              </div>
              <Database20Regular aria-hidden="true" />
            </div>
            <div className="pricing-panel-body">
              {!status && pricing.operation !== 'idle' ? (
                <div className="pricing-empty"><Spinner label="正在读取价格状态" /></div>
              ) : (
                <>
                  <div className="pricing-badge-row">
                    <PricingFreshnessBadge freshness={status?.freshness} />
                    {snapshot && <PricingSourceBadge source={snapshot.source} />}
                  </div>
                  <PricingDownloadButton available={Boolean(snapshot)} />
                  {!snapshot && (
                    <div className="pricing-empty pricing-empty--compact">
                      <Database20Regular aria-hidden="true" />
                      <strong>{status ? '尚无可用价格快照' : '尚未取得价格状态'}</strong>
                      <p>{status ? '首次同步成功后才会显示真实快照；缺失值使用 —，不会补成 0。' : '无法读取时不展示虚构数据，请刷新重试。'}</p>
                    </div>
                  )}
                  <div className="pricing-metrics">
                    <div><span>Meter 条目</span><strong data-testid="pricing-meter-count">{formatPricingCount(snapshot?.meterCount)}</strong></div>
                    <div><span>已读取页面</span><strong>{formatPricingCount(snapshot?.pageCount)}</strong></div>
                    <div><span>原始记录</span><strong>{formatPricingCount(snapshot?.sourceRecordCount)}</strong></div>
                  </div>
                  <dl className="pricing-facts">
                    <div><dt>当前快照 ID</dt><dd><code>{snapshot?.snapshotId ?? '—'}</code></dd></div>
                    <div><dt>获取时间（北京时间）</dt><dd>{formatPricingDate(snapshot?.fetchedAtUtc)}</dd></div>
                    <div><dt>距获取时间</dt><dd>{status?.ageHours === null || status?.ageHours === undefined ? '—' : `${status.ageHours.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时`}</dd></div>
                    <div><dt>币种 / 云环境</dt><dd>{snapshot ? `${snapshot.currency} / ${snapshot.cloud}` : '—'}</dd></div>
                    <div><dt>最近同步</dt><dd><PricingRunBadge run={status?.latestRun} /> <Link to="/operations">查看运行详情</Link></dd></div>
                  </dl>
                  {status?.freshness === 'stale' || status?.freshness === 'expired' ? (
                    <div className={`message pricing-message ${status.freshness === 'expired' ? 'error' : 'warning'}`} role="alert">
                      <Clock20Regular aria-hidden="true" />
                      <span>{status.freshness === 'expired' ? '快照已超过 72 小时，处于过期状态。' : '快照已超过 36 小时，请关注自动同步是否正常。'}旧快照不会伪装成新价格，刷新不会重置获取时间。</span>
                    </div>
                  ) : null}
                  {snapshot && (
                    <details className="pricing-metadata">
                      <summary>查看只读快照元数据</summary>
                      <dl className="pricing-facts">
                        <div><dt>API / 解析器版本</dt><dd>{snapshot.apiVersion} / v{snapshot.parserVersion}</dd></div>
                        <div><dt>重复条目</dt><dd>{formatPricingCount(snapshot.duplicateCount)}</dd></div>
                        <div><dt>内容 SHA-256</dt><dd><code>{snapshot.contentHash}</code></dd></div>
                      </dl>
                    </details>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="panel" aria-labelledby="pricing-changes-title">
            <div className="panel-header">
              <div>
                <h2 id="pricing-changes-title">与前一快照对比</h2>
                <p>价格条目变化摘要，不是租户费用变化</p>
              </div>
              <DataUsage20Regular aria-hidden="true" />
            </div>
            <div className="pricing-panel-body">
              <p className="pricing-comparison">
                {changes?.previousSnapshotId ? <>比较基准 <code>{changes.previousSnapshotId}</code></> :
                  snapshot ? '首份快照，没有前一版本可供比较。' : '尚无可比较的价格快照。'}
              </p>
              <div className="pricing-change-grid">
                <div><span>新增 meter</span><strong>{formatPricingCount(changes?.addedMeterCount)}</strong></div>
                <div><span>移除 meter</span><strong>{formatPricingCount(changes?.removedMeterCount)}</strong></div>
                <div><span>价格变化</span><strong>{formatPricingCount(changes?.changedPriceCount)}</strong></div>
                <div><span>价格未变</span><strong>{formatPricingCount(changes?.unchangedMeterCount)}</strong></div>
              </div>
              <dl className="pricing-facts">
                <div><dt>最大价格变化</dt><dd>{changes?.largestPriceChangePercent == null ? '—' : `${changes.largestPriceChangePercent}%`}</dd></div>
                <div><dt>原价为零的变化</dt><dd>{formatPricingCount(changes?.priceFromZeroCount)}</dd></div>
              </dl>
              <p className="pricing-muted">原价为零时单独计数，不计算百分比；没有可比较值时显示 —。</p>
            </div>
          </section>
        </div>

        <aside className="pricing-settings-aside" aria-label="价格同步规则和支持范围">
          <section className="panel pricing-schedule" aria-labelledby="pricing-schedule-title">
            <div className="panel-header">
              <div><h2 id="pricing-schedule-title">自动同步规则</h2><p>只读配置 · 无需人工审核</p></div>
              <Calendar20Regular aria-hidden="true" />
            </div>
            <div className="pricing-panel-body">
              <div className="pricing-schedule-time">
                <Clock20Regular aria-hidden="true" />
                <div><strong>每日 00:00</strong><span>北京时间 · Asia/Shanghai</span></div>
              </div>
              <dl className="pricing-facts">
                <div><dt>下次计划（北京时间）</dt><dd>{formatPricingDate(status?.nextScheduledAtUtc)}</dd></div>
                <div><dt>UTC Cron</dt><dd><code>{status?.scheduleCronUtc ?? '—'}</code></dd></div>
                <div><dt>自动更新</dt><dd>{status?.automaticUpdates ? '已配置 · 校验通过后自动更新' : '—'}</dd></div>
                <div><dt>备份保留</dt><dd>{status ? `${status.retentionDays} 天` : '—'}</dd></div>
              </dl>
              <p className="pricing-muted">
                每日 UTC 16:00 拉取完整分页，校验通过后直接更新当前快照。失败保留上一份可用快照；
                36 小时未更新标为陈旧，72 小时标为过期。手动同步仅用于重试。
              </p>
            </div>
          </section>

          <section className="panel" aria-labelledby="pricing-support-title">
            <div className="panel-header">
              <div><h2 id="pricing-support-title">单位与适用范围</h2><p>只读说明 · 映射尚未支持</p></div>
              <Info20Regular aria-hidden="true" />
            </div>
            <div className="pricing-panel-body">
              <dl className="pricing-facts">
                <div><dt>未支持 meter</dt><dd>{formatPricingCount(snapshot?.unsupportedMeterCount)}</dd></div>
                <div><dt>未知单位 meter</dt><dd>{formatPricingCount(snapshot?.unrecognizedUnitCount)}</dd></div>
              </dl>
              <p className="pricing-muted">保留原始单位，无法识别时维持未知，不强行按 1 折算。即使单位已识别，也不代表已验证模型与部署映射。</p>
              <div className="pricing-later-note"><Info20Regular aria-hidden="true" /><span>模型匹配与费用情况见费用详情；本页不支持单价覆盖或人工批准。</span></div>
            </div>
          </section>

          <section className="panel" aria-labelledby="pricing-later-settings-title">
            <div className="panel-header">
              <div><h2 id="pricing-later-settings-title">其他平台设置</h2><p>高级权限与部署参数</p></div>
              <Mail20Regular aria-hidden="true" />
            </div>
            <div className="pricing-panel-body">
              <Badge appearance="tint" color="subtle" icon={<History20Regular />}>仅部署管理员管理</Badge>
              <p className="pricing-muted">允许收件域、邮件身份和 Exchange 授权由管理员管理，不通过网页扩大权限。发件邮箱、运维收件人和发信测试在上方“告警与邮件”中设置；输入地址不会自动授予邮箱权限。</p>
            </div>
          </section>
        </aside>
      </div>

      <PricingHistory
        activeSnapshotId={snapshot?.snapshotId ?? null}
        refreshVersion={pricing.historyVersion}
      />
      <p className="pricing-read-time">最近读取状态（北京时间）：{formatPricingDate(pricing.readAt)} · 获取时间与计划时间均来自后台</p>
    </div>
  )
}
