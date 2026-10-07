import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  ArrowSync20Regular,
  CheckmarkCircle20Regular,
  Clock20Regular,
  Database20Regular,
  ErrorCircle20Regular,
  Globe20Regular,
  Info20Regular,
  Pulse20Regular,
  Warning20Regular,
} from '@fluentui/react-icons'
import type {
  PricingSnapshotSummary,
  PricingStatusResponse,
  PricingSyncRun,
} from '@tokenusagealert/schemas'
import type { PricingController } from './usePricingStatus'

const beijingDateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function formatPricingDate(value: string | null | undefined): string {
  return value ? beijingDateTime.format(new Date(value)) : '—'
}

export function formatPricingCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('zh-CN')
}

export function PricingSourceBadge({
  source,
}: {
  source: PricingSnapshotSummary['source']
}) {
  return (
    <Badge
      appearance="tint"
      color={source === 'fixture' ? 'warning' : 'informative'}
      icon={source === 'fixture' ? <Database20Regular /> : <Globe20Regular />}
    >
      {source === 'fixture' ? '本地模拟 · fixture' : '官方 Azure Retail Prices'}
    </Badge>
  )
}

export function PricingFreshnessBadge({
  freshness,
}: {
  freshness: PricingStatusResponse['freshness'] | undefined
}) {
  if (!freshness) {
    return <Badge appearance="tint" color="subtle" icon={<Info20Regular />}>状态未读取</Badge>
  }
  const labels = {
    missing: '暂无快照',
    fresh: '价格新鲜',
    stale: '已陈旧 · 超过 36 小时',
    expired: '已过期 · 超过 72 小时',
  } as const
  return (
    <Badge
      appearance="tint"
      color={
        freshness === 'fresh' ? 'success' :
          freshness === 'stale' ? 'warning' :
            freshness === 'expired' ? 'danger' : 'subtle'
      }
      icon={
        freshness === 'fresh' ? <CheckmarkCircle20Regular /> :
          freshness === 'expired' ? <ErrorCircle20Regular /> :
            freshness === 'stale' ? <Warning20Regular /> : <Clock20Regular />
      }
    >
      {labels[freshness]}
    </Badge>
  )
}

export function PricingRunBadge({ run }: { run: PricingSyncRun | null | undefined }) {
  return (
    <Badge
      appearance="tint"
      color={
        run?.status === 'succeeded' ? 'success' :
          run?.status === 'failed' ? 'danger' :
            run?.status === 'running' ? 'informative' : 'subtle'
      }
      icon={
        run?.status === 'succeeded' ? <CheckmarkCircle20Regular /> :
          run?.status === 'failed' ? <ErrorCircle20Regular /> : <Clock20Regular />
      }
    >
      {run?.status === 'succeeded' ? '成功' :
        run?.status === 'failed' ? '失败' :
          run?.status === 'running' ? '运行中' : '暂无记录'}
    </Badge>
  )
}

export function PricingControls({ pricing }: { pricing: PricingController }) {
  const busy = pricing.operation !== 'idle'
  const running = pricing.status?.latestRun?.status === 'running'
  return (
    <div className="page-actions pricing-actions">
      <Button
        appearance="secondary"
        icon={<ArrowSync20Regular />}
        disabled={['loading', 'refreshing', 'starting'].includes(pricing.operation)}
        onClick={pricing.refresh}
      >
        刷新价格状态
      </Button>
      <Button
        appearance="primary"
        icon={busy ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
        disabled={busy || running || !pricing.status}
        onClick={pricing.sync}
      >
        {pricing.operation === 'starting' ? '正在启动同步' :
          pricing.operation === 'polling' ? '正在跟踪同步' :
            running ? '价格同步运行中' :
              pricing.status?.latestRun?.status === 'failed' ? '重试价格同步' : '立即同步价格'}
      </Button>
    </div>
  )
}

export function PricingMessages({ pricing }: { pricing: PricingController }) {
  return (
    <>
      {pricing.statusError && (
        <div className="message error pricing-message" role="alert">
          <ErrorCircle20Regular aria-hidden="true" />
          <div>
            <strong>{pricing.statusError}</strong>
            {pricing.status && <p>下方保留最近一次读取结果，可能已变化；请刷新确认。</p>}
          </div>
        </div>
      )}
      {pricing.syncError && (
        <div className="message error pricing-message" role="alert">
          <ErrorCircle20Regular aria-hidden="true" />
          <span>{pricing.syncError}</span>
        </div>
      )}
      {pricing.feedback && (
        <div
          className={`message pricing-message ${
            pricing.feedback.kind === 'succeeded' ? 'success' :
              pricing.feedback.kind === 'failed' ? 'error' :
                pricing.feedback.kind === 'pending' ? 'warning' : ''
          }`}
          role={pricing.feedback.kind === 'failed' ? 'alert' : 'status'}
          data-testid="pricing-sync-feedback"
        >
          {pricing.feedback.kind === 'succeeded' ? <CheckmarkCircle20Regular aria-hidden="true" /> :
            pricing.feedback.kind === 'failed' ? <ErrorCircle20Regular aria-hidden="true" /> :
              <Clock20Regular aria-hidden="true" />}
          <div>
            <strong>{pricing.feedback.message}</strong>
            {pricing.executionName && (
              <p>启动请求标识：<code>{pricing.executionName}</code></p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export function PricingScopeNotice() {
  return (
    <div className="scope-notice pricing-message" role="note">
      <Info20Regular aria-hidden="true" />
      <div>
        <strong>价格就绪 ≠ 费用可计算</strong>
        <span>
          价格目录不单独承诺模型计价能力。请在费用详情查看每个部署的匹配结果；
          未匹配价格不按零价补齐，真实正用量的金额仍待核对。这里不提供实际账单。
        </span>
      </div>
    </div>
  )
}

export function PricingSourceNotice({ status }: { status: PricingStatusResponse | null }) {
  if (status?.active?.source !== 'fixture' && status?.latestRun?.source !== 'fixture') {
    return null
  }
  return (
    <div className="message warning pricing-message" role="note" data-testid="pricing-fixture-notice">
      <Database20Regular aria-hidden="true" />
      <div>
        <strong>检测到本地模拟来源（fixture）</strong>
        <p>对应快照或运行使用本地测试数据，并非本次从 Azure 获取的官方价格；不可用于真实费用估算。</p>
      </div>
    </div>
  )
}

export function PricingRunFailure({ status }: { status: PricingStatusResponse | null }) {
  if (status?.latestRun?.status !== 'failed') return null
  return (
    <div className="message error pricing-message pricing-run-error" role="alert">
      <ErrorCircle20Regular aria-hidden="true" />
      <div>
        <strong>
          {status.active
            ? '最近同步失败，继续保留上一份可用快照。'
            : '最近同步失败，尚无可用价格快照。'}
        </strong>
        {status.latestRun.error ? (
          <p><code>{status.latestRun.error.code}</code> · {status.latestRun.error.message}</p>
        ) : (
          <p>后台未提供错误详情，请根据运行 ID 排查。</p>
        )}
        {status.active && <p>当前快照 <code>{status.active.snapshotId}</code>；新鲜度仍按其获取时间判断。</p>}
      </div>
    </div>
  )
}

export function PricingRunDetails({ status }: { status: PricingStatusResponse | null }) {
  const run = status?.latestRun
  return (
    <section className="panel" aria-labelledby="pricing-run-title">
      <div className="panel-header">
        <div>
          <h2 id="pricing-run-title">最近价格同步运行</h2>
          <p>Pricing Sync · 仅显示后台记录的最近一次运行</p>
        </div>
        <Pulse20Regular aria-hidden="true" />
      </div>
      <div className="pricing-panel-body">
        {!status ? (
          <p className="pricing-muted">运行状态尚未读取，不能推断任务是否成功。</p>
        ) : !run ? (
          <div className="pricing-empty">
            <Clock20Regular aria-hidden="true" />
            <strong>暂无价格同步运行</strong>
            <p>尚未取得任何后台运行记录，不代表定时任务已成功执行。</p>
          </div>
        ) : (
          <>
            <div className="pricing-badge-row">
              <PricingRunBadge run={run} />
              <PricingSourceBadge source={run.source} />
            </div>
            <dl className="pricing-facts pricing-facts--grid">
              <div className="pricing-fact-wide"><dt>运行 ID</dt><dd><code>{run.runId}</code></dd></div>
              <div><dt>开始时间（北京时间）</dt><dd>{formatPricingDate(run.startedAtUtc)}</dd></div>
              <div><dt>结束时间（北京时间）</dt><dd>{formatPricingDate(run.finishedAtUtc)}</dd></div>
              <div><dt>已读取页面</dt><dd>{formatPricingCount(run.pageCount)}</dd></div>
              <div><dt>已读取记录</dt><dd>{formatPricingCount(run.recordCount)}</dd></div>
              <div className="pricing-fact-wide"><dt>本次快照 ID</dt><dd><code>{run.snapshotId ?? '—'}</code></dd></div>
            </dl>
            {run.status === 'running' && (
              <div className="scope-notice pricing-message" role="status">
                <Clock20Regular aria-hidden="true" />
                <span>后台仍在运行，页面与记录数量为最近读取的进度；尚未确认成功。</span>
              </div>
            )}
            {run.status === 'succeeded' && (
              <p className="pricing-muted">
                后台已记录成功完成。当前使用哪份快照，以价格状态中的当前快照 ID 为准。
              </p>
            )}
            <PricingRunFailure status={status} />
          </>
        )}
      </div>
    </section>
  )
}
