import { useState } from 'react'
import { Button, Spinner } from '@fluentui/react-components'
import { ArrowDownload20Regular } from '@fluentui/react-icons'
import { downloadPricingSnapshot } from '../api'
import { usageError } from './UsageShared'

export function PricingDownloadButton({ available }: { available: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const download = async (format: 'compact' | 'raw') => {
    setBusy(true); setError(''); setNotice('')
    try {
      const file = await downloadPricingSnapshot(format)
      const url = URL.createObjectURL(file)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = format === 'raw' ? 'aoai-pricing-raw.json' : 'aoai-pricing.json'
      document.body.append(anchor); anchor.click(); anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice(format === 'raw' ? '原始/审计快照已准备，文件较大。' : '精简价格 JSON 已准备；费用查询使用同一精简官方目录，手动价仅作缺价备用。')
    } catch (reason) { setError(usageError(reason)) }
    finally { setBusy(false) }
  }
  return <div className="pricing-download">
    <Button appearance="secondary" disabled={!available || busy} icon={busy ? <Spinner size="tiny" /> : <ArrowDownload20Regular />}
      onClick={() => void download('compact')}>{busy ? '正在准备下载' : '下载精简 SKU 价格 JSON'}</Button>
    <Button appearance="subtle" disabled={!available || busy} onClick={() => void download('raw')}>下载原始/审计快照</Button>
    {!available && <p className="pricing-muted">价格同步成功后可下载精简目录和原始/审计快照。</p>}
    {notice && <p role="status" className="pricing-muted">{notice}</p>}
    {error && <div className="message error" role="alert">{error}</div>}
  </div>
}
