import { useEffect, useRef, useState } from 'react'
import { LineChart, type LineChartPoints } from '@fluentui/react-charts'
import type { HourlyUsage } from '@tokenusagealert/schemas'
import { usageDate, usageMoney } from './UsageShared'

export function UsageChart({ hours, threshold, select }: {
  hours: HourlyUsage[]; threshold: string | null; select: (hour: HourlyUsage) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    if (!host.current) return
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(240, Math.floor(entry.contentRect.width))) })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  const series: LineChartPoints[] = []
  let segment: LineChartPoints['data'] = []
  let previous: HourlyUsage | null = null
  const nativeSeries: LineChartPoints[] = []
  let nativeSegment: LineChartPoints['data'] = []
  const flush = () => {
    if (segment.length) series.push({ legend: '本地参考估算', color: '#479ef5', data: segment,
      lineOptions: { strokeWidth: 1.5, strokeDasharray: '3 3', mode: 'lines+markers' } })
    segment = []
  }
  const flushNative = () => {
    if (nativeSegment.length) nativeSeries.push({
      legend: 'Azure 原生估算', color: '#0f6cbd', data: nativeSegment,
      lineOptions: { strokeWidth: 2, mode: 'lines+markers' },
    })
    nativeSegment = []
  }
  for (const hour of hours) {
    if (previous && Date.parse(hour.windowStartUtc) - Date.parse(previous.windowStartUtc) !== 3_600_000) { flush(); flushNative() }
    if (hour.knownCostUsd === null || hour.status === 'failed') flush()
    else {
      segment.push({
        x: new Date(hour.windowStartUtc), y: Number(hour.knownCostUsd),
        xAxisCalloutData: usageDate(hour.windowStartUtc),
        yAxisCalloutData: `${hour.pricingRuleVersion >= 5 ? '50/50 参考估算' : '历史参考估算'} ${usageMoney(hour.knownCostUsd)}`,
        markerColor: hour.status === 'partial' ? '#bc6600' : '#479ef5',
        onDataPointClick: () => select(hour),
      })
    }
    const native = hour.foundryEstimatedCost?.costUsd
    if (native === undefined || native === null) flushNative()
    else nativeSegment.push({
      x: new Date(hour.windowStartUtc), y: Number(native),
      xAxisCalloutData: usageDate(hour.windowStartUtc), yAxisCalloutData: `Azure 原生估算 ${usageMoney(native)}`,
      onDataPointClick: () => select(hour),
    })
    previous = hour
  }
  flush()
  flushNative()
  series.push(...nativeSeries)
  const first = hours[0]
  const last = hours[hours.length - 1]
  if (threshold !== null && first && last) series.push({
    legend: '阈值', color: '#c50f1f',
    data: [{ x: new Date(first.windowStartUtc), y: Number(threshold) }, { x: new Date(last.windowEndUtc), y: Number(threshold) }],
    lineOptions: { strokeDasharray: '5 5', mode: 'lines', strokeWidth: 1.5 },
  })
  return <div ref={host} className="usage-chart">
    {hours.length === 0 ? <div className="empty-state"><strong>暂无小时趋势记录</strong><span>不会填充模拟曲线或将缺失数据补为零。</span></div> :
      <LineChart data={{ lineChartData: series }} width={width} height={280} hideTooltip={false}
        yMinValue={0} yMaxValue={Math.max(1, ...hours.flatMap((hour) =>
          [Number(hour.knownCostUsd ?? 0), Number(hour.foundryEstimatedCost?.costUsd ?? 0)]), Number(threshold ?? 0)) * 1.2}
        xAxisTickCount={width < 500 ? 3 : 6} yAxisTickCount={4}
        tickFormat={(value) => usageDate(new Date(value).toISOString()).slice(5, 16)}
        yAxisTickFormat={(value: number) => `$${value.toFixed(2)}`}
        margins={{ left: 52, right: 15, top: 16, bottom: 40 }}
        svgProps={{ 'aria-label': '小时费用趋势，浅蓝虚线为50/50参考估算，深蓝实线为Azure原生估算，红虚线为阈值；缺失记录不补零。' }} />}
  </div>
}
