import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  ArrowSync20Regular,
  CheckmarkCircle20Regular,
  ErrorCircle20Regular,
  History20Regular,
} from '@fluentui/react-icons'
import type { PricingHistoryResponse } from '@tokenusagealert/schemas'
import { getPricingHistory } from '../api'
import { formatPricingCount, formatPricingDate, PricingSourceBadge } from './PricingShared'
import { pricingErrorMessage } from './usePricingStatus'

export function PricingHistory({
  activeSnapshotId,
  refreshVersion,
}: {
  activeSnapshotId: string | null
  refreshVersion: number
}) {
  const [history, setHistory] = useState<PricingHistoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [failedCursor, setFailedCursor] = useState<string | undefined>()
  const controllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async (cursor?: string) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    setFailedCursor(cursor)
    try {
      const next = await getPricingHistory(cursor, controller.signal)
      controller.signal.throwIfAborted()
      setHistory((previous) => {
        if (!cursor || !previous) return next
        const seen = new Set(previous.items.map((item) => item.snapshotId))
        return {
          items: [...previous.items, ...next.items.filter((item) => !seen.has(item.snapshotId))],
          nextCursor: next.nextCursor,
        }
      })
    } catch (loadError) {
      if (!controller.signal.aborted) {
        setError(pricingErrorMessage(
          loadError,
          cursor ? '读取更早价格备份失败' : '读取价格备份失败',
        ))
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => controllerRef.current?.abort()
  }, [load, refreshVersion])

  return (
    <section className="panel pricing-history" aria-labelledby="pricing-history-title">
      <div className="panel-header">
        <div>
          <h2 id="pricing-history-title">近 90 天价格备份</h2>
          <p>按获取时间倒序；校验通过的备份不一定曾被使用，不是价格生效记录。</p>
        </div>
        <History20Regular aria-hidden="true" />
      </div>
      {error && (
        <div className="pricing-history-error">
          <div className="message error pricing-message" role="alert">
            <ErrorCircle20Regular aria-hidden="true" />
            <div>
              <strong>{error}</strong>
              {history && <p>已保留先前读取的备份，当前列表可能不完整或已过时。</p>}
            </div>
          </div>
          <Button
            appearance="secondary"
            icon={<ArrowSync20Regular />}
            disabled={loading}
            onClick={() => void load(failedCursor)}
          >
            重试加载备份
          </Button>
        </div>
      )}
      {history && history.items.length > 0 && (
        <div className="pricing-history-scroll" tabIndex={0} role="region" aria-label="价格备份表格，可横向滚动">
          <table className="pricing-history-table">
            <caption className="visually-hidden">近 90 天已校验价格备份；仅当前快照标记为当前使用。</caption>
            <thead>
              <tr>
                <th scope="col">快照 / 获取时间（北京时间）</th>
                <th scope="col">Meter / 页数</th>
                <th scope="col">新增 / 移除 / 改价</th>
                <th scope="col">来源</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((snapshot) => {
                const active = snapshot.snapshotId === activeSnapshotId
                return (
                  <tr key={snapshot.snapshotId} data-snapshot-id={snapshot.snapshotId}>
                    <th scope="row">
                      <code>{snapshot.snapshotId}</code>
                      <span>{formatPricingDate(snapshot.fetchedAtUtc)}</span>
                    </th>
                    <td>
                      {formatPricingCount(snapshot.meterCount)} / {formatPricingCount(snapshot.pageCount)}
                    </td>
                    <td>
                      +{formatPricingCount(snapshot.changes.addedMeterCount)} / −{formatPricingCount(snapshot.changes.removedMeterCount)} / {formatPricingCount(snapshot.changes.changedPriceCount)}
                    </td>
                    <td><PricingSourceBadge source={snapshot.source} /></td>
                    <td>
                      <Badge
                        appearance="tint"
                        color={active ? 'success' : 'subtle'}
                        icon={active ? <CheckmarkCircle20Regular /> : <History20Regular />}
                      >
                        {active ? '当前使用' : '已备份'}
                      </Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {history?.items.length === 0 && !loading && !error && (
        <div className="pricing-empty">
          <History20Regular aria-hidden="true" />
          <strong>暂无价格备份</strong>
          <p>近 90 天没有返回已校验的快照；这不是零价或同步成功的信号。</p>
        </div>
      )}
      <div className="pricing-history-footer">
        {loading ? (
          <Spinner size="tiny" label="正在读取价格备份" />
        ) : history && !error ? (
          <span>
            已显示 {history.items.length} 份备份
            {!history.nextCursor && ' · 本次查询已全部加载'}
          </span>
        ) : null}
        {history?.nextCursor && !error && (
          <Button
            appearance="secondary"
            disabled={loading}
            onClick={() => void load(history.nextCursor ?? undefined)}
          >
            加载更早备份
          </Button>
        )}
      </div>
    </section>
  )
}
