import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PricingStatusResponse,
  PricingSyncRun,
} from '@tokenusagealert/schemas'
import { ApiError, getPricingStatus, startPricingSync } from '../api'

const POLL_INTERVAL_MS = 2_000
const POLL_WINDOW_MS = 30_000

type Operation = 'loading' | 'refreshing' | 'starting' | 'polling' | 'idle'

interface WatchedRun {
  baseline: PricingSyncRun | null
  requested: boolean
}

export interface PricingFeedback {
  kind: 'accepted' | 'pending' | 'succeeded' | 'failed'
  message: string
}

export function pricingErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError
    ? `${fallback}（${error.problem.code}）：${error.problem.detail}`
    : `${fallback}。请刷新重试；未使用无法验证的返回数据。`
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Polling cancelled', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, POLL_INTERVAL_MS)
    signal.addEventListener('abort', abort, { once: true })
  })
}

function isCompletedRun(
  run: PricingSyncRun | null,
  watch: WatchedRun,
): run is PricingSyncRun {
  if (!run || run.status === 'running') return false
  if (!watch.baseline) return true
  if (!watch.requested && run.runId === watch.baseline.runId) return true
  return (
    run.runId !== watch.baseline.runId ||
    Date.parse(run.startedAtUtc) > Date.parse(watch.baseline.startedAtUtc)
  )
}

export function usePricingStatus() {
  const [status, setStatus] = useState<PricingStatusResponse | null>(null)
  const [operation, setOperation] = useState<Operation>('loading')
  const [statusError, setStatusError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [feedback, setFeedback] = useState<PricingFeedback | null>(null)
  const [executionName, setExecutionName] = useState('')
  const [readAt, setReadAt] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const watchedRunRef = useRef<WatchedRun | null>(null)

  const beginOperation = useCallback(() => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    return controller
  }, [])

  const applyStatus = useCallback((value: PricingStatusResponse) => {
    setStatus(value)
    setReadAt(new Date().toISOString())
    setStatusError('')
  }, [])

  const observe = useCallback(
    async (
      initial: PricingStatusResponse,
      watch: WatchedRun,
      signal: AbortSignal,
    ) => {
      const finish = (value: PricingStatusResponse): boolean => {
        if (!isCompletedRun(value.latestRun, watch)) return false
        watchedRunRef.current = null
        setHistoryVersion((version) => version + 1)
        setFeedback(
          value.latestRun.status === 'succeeded'
            ? {
                kind: 'succeeded',
                message: '价格同步成功，已读取后台完成记录；这不代表费用可计算。',
              }
            : {
                kind: 'failed',
                message: '价格同步失败，请查看最近运行错误；未将失败当作零价或成功。',
              },
        )
        return true
      }

      if (finish(initial)) return
      setOperation('polling')
      const deadline = Date.now() + POLL_WINDOW_MS
      for (let attempt = 0; attempt < 15 && Date.now() < deadline; attempt += 1) {
        await waitForPoll(signal)
        const next = await getPricingStatus(signal)
        signal.throwIfAborted()
        applyStatus(next)
        if (finish(next)) return
      }

      setFeedback({
        kind: 'pending',
        message:
          '仍在等待后台完成，已暂停自动跟踪。任务可能仍运行或等待启动，请刷新价格状态；尚未确认本次同步成功。',
      })
    },
    [applyStatus],
  )

  const load = useCallback(
    async (manual: boolean) => {
      const { signal } = beginOperation()
      setOperation(manual ? 'refreshing' : 'loading')
      setStatusError('')
      if (manual) {
        setSyncError('')
        if (!watchedRunRef.current) {
          setFeedback(null)
          setExecutionName('')
        }
      }
      try {
        const next = await getPricingStatus(signal)
        signal.throwIfAborted()
        applyStatus(next)
        if (manual) setHistoryVersion((version) => version + 1)
        let watch = watchedRunRef.current
        if (!watch && next.latestRun?.status === 'running') {
          watch = { baseline: next.latestRun, requested: false }
          watchedRunRef.current = watch
        }
        if (watch) await observe(next, watch, signal)
      } catch (error) {
        if (!signal.aborted) {
          setStatusError(pricingErrorMessage(error, '读取价格状态失败'))
          if (watchedRunRef.current) {
            setFeedback({
              kind: 'pending',
              message: '无法确认后台结果，已暂停自动跟踪；请刷新状态，不要将请求已接受视为同步成功。',
            })
          }
        }
      } finally {
        if (!signal.aborted) setOperation('idle')
      }
    },
    [applyStatus, beginOperation, observe],
  )

  const sync = useCallback(async () => {
    const { signal } = beginOperation()
    setOperation('starting')
    setSyncError('')
    setFeedback(null)
    setExecutionName('')
    watchedRunRef.current = null
    try {
      // Read the baseline immediately before POST so an older successful run cannot confirm it.
      const baseline = await getPricingStatus(signal)
      signal.throwIfAborted()
      applyStatus(baseline)
      if (baseline.latestRun?.status === 'running') {
        const watch = { baseline: baseline.latestRun, requested: false }
        watchedRunRef.current = watch
        setFeedback({
          kind: 'pending',
          message: '已有价格同步正在运行，未重复启动；正在跟踪后台状态。',
        })
        await observe(baseline, watch, signal)
        return
      }

      const started = await startPricingSync(signal)
      signal.throwIfAborted()
      const watch = { baseline: baseline.latestRun, requested: true }
      watchedRunRef.current = watch
      setExecutionName(started.executionName)
      setFeedback({
        kind: 'accepted',
        message: '同步请求已接受，正在等待新的后台运行结果；HTTP 202 不代表同步成功。',
      })
      await observe(baseline, watch, signal)
    } catch (error) {
      if (!signal.aborted) {
        if (watchedRunRef.current) {
          setStatusError(pricingErrorMessage(error, '读取同步结果失败'))
          setFeedback({
            kind: 'pending',
            message: '后台结果尚未确认，已暂停自动跟踪。请刷新价格状态查看结果。',
          })
        } else {
          setSyncError(pricingErrorMessage(error, '无法启动价格同步'))
        }
      }
    } finally {
      if (!signal.aborted) setOperation('idle')
    }
  }, [applyStatus, beginOperation, observe])

  useEffect(() => {
    void load(false)
    return () => controllerRef.current?.abort()
  }, [load])

  return {
    status,
    operation,
    statusError,
    syncError,
    feedback,
    executionName,
    readAt,
    historyVersion,
    refresh: () => void load(true),
    sync: () => void sync(),
  }
}

export type PricingController = ReturnType<typeof usePricingStatus>
