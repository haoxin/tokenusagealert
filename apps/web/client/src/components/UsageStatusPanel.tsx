import { useEffect, useState } from 'react'
import type { UsageRun } from '@tokenusagealert/schemas'
import { getUsageStatus } from '../api'
import { UsageActions, usageError, UsageRunSummary } from './UsageShared'

export function UsageStatusPanel() {
  const [run, setRun] = useState<UsageRun | null>(null)
  const [runs, setRuns] = useState<UsageRun[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    getUsageStatus(controller.signal).then((value) => { setRun(value.run); setRuns(value.runs ?? []) }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(usageError(reason))
    })
    return () => controller.abort()
  }, [revision])
  return <section className="usage-operation-panel" aria-label="用量采集状态">
    <div className="panel-header"><div><h2>Usage Collector</h2><p>租户与订阅有界并发；每轮只采集上一完整小时，资源发现每 2 小时刷新。</p></div>
      <UsageActions refresh={() => setRevision((value) => value + 1)} /></div>
    {error && <div className="message error" role="alert">{error}</div>}
    {runs.length > 1 ? runs.map((item) => <UsageRunSummary key={item.runId} run={item} />) : <UsageRunSummary run={run} />}
  </section>
}
