import { useEffect, useState } from 'react'
import {
  Badge, Button, Checkbox, DrawerBody, DrawerFooter, DrawerHeader, DrawerHeaderTitle, Field, Input,
  OverlayDrawer, Select, Spinner, Textarea,
} from '@fluentui/react-components'
import { Add20Regular, ArrowSync20Regular, Dismiss20Regular, Edit20Regular, Info20Regular, Money20Regular, Warning20Regular } from '@fluentui/react-icons'
import type { ManualPriceListResponse, ManualPriceVersion } from '@tokenusagealert/schemas'
import { disableManualPrice, getManualPricing, saveManualPrice } from '../manual-pricing-api'
import { usageDate, usageError } from './UsageShared'

export function ManualPricingPanel() {
  const [data, setData] = useState<ManualPriceListResponse | null>(null)
  const [revision, setRevision] = useState(0)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ManualPriceVersion | null>(null)
  const [modelName, setModelName] = useState('')
  const [version, setVersion] = useState('')
  const [sku, setSku] = useState<'GlobalStandard' | 'DataZoneStandard' | 'Standard'>('GlobalStandard')
  const [allRegions, setAllRegions] = useState(false)
  const [regions, setRegions] = useState<string[]>([])
  const [customRegion, setCustomRegion] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [formError, setFormError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    getManualPricing(controller.signal).then((value) => { setData(value); setError('') })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(usageError(reason)) })
    return () => controller.abort()
  }, [revision])
  const edit = (item: ManualPriceVersion | null) => {
    setEditing(item); setModelName(item?.modelName ?? ''); setVersion(item?.modelVersion ?? '')
    setSku(item?.deploymentSku ?? 'GlobalStandard'); setAllRegions(item?.regionScope === 'all')
    setRegions(item?.regions ?? []); setCustomRegion(''); setInput(item?.inputUsdPerMillion ?? '')
    setOutput(item?.outputUsdPerMillion ?? ''); setNote(item?.note ?? ''); setFormError(''); setOpen(true)
  }
  const save = async () => {
    if (!data) return
    setBusy(true); setFormError('')
    try {
      const result = await saveManualPrice({
        modelName, modelVersion: version || null, deploymentSku: sku, regionScope: allRegions ? 'all' : 'selected',
        regions: allRegions ? [] : [...new Set([...regions, ...customRegion.split(/[,;\s]+/).filter(Boolean)])],
        inputUsdPerMillion: input, outputUsdPerMillion: output, note,
      }, data.etag, editing?.ruleId ?? null)
      setOpen(false); setNotice(`手动简化估算价已保存，${usageDate(result.item.effectiveFromUtc)} 起生效。${result.warning ?? ''}`)
      setRevision((value) => value + 1)
    } catch (reason) { setFormError(usageError(reason)) } finally { setBusy(false) }
  }
  return <section className="panel" aria-label="手动价格管理">
    <div className="panel-header"><div><h2>手动价格 · 缺价备用</h2><p>官方优先，手动只补缺价，不覆盖官方价格。</p></div>
      <div className="page-actions"><Button icon={<ArrowSync20Regular />} disabled={busy} onClick={() => setRevision((value) => value + 1)}>刷新手动价格</Button>
        <Button appearance="primary" icon={<Add20Regular />} disabled={!data || busy} onClick={() => edit(null)}>新增手动价格</Button></div>
    </div>
    <div className="pricing-panel-body">
      <div className="scope-notice"><Info20Regular /><div><strong>手动简化估算，不是官方报价或实际账单</strong>
        <span>统一 USD／100 万 token 输入、输出价；缓存输入按普通输入估算，不区分上下文档位。保存或停用从下一个完整小时生效，不改历史费用。区域定义适用范围，不表示该模型在该区域可部署。</span></div></div>
      {!data && !error && <Spinner label="读取手动价格配置" />}
      {data && !data.items.length && <p className="pricing-muted">尚无手动价格。不要使用虚构价格替代未确认的模型费用。</p>}
      {notice && <div className="message success" role="status">{notice}</div>}
      {error && <div className="message error" role="alert">{error}</div>}
      {data && data.items.length > 0 && <div className="table-wrap"><table><thead><tr>
        <th>模型 / 版本</th><th>部署方式 / 区域</th><th>输入 / 输出（USD/百万）</th><th>状态 / 生效时间</th><th>操作</th>
      </tr></thead><tbody>{data.items.map((item) => <tr key={item.ruleId}>
        <td><strong>{item.modelName}</strong><small className="usage-secondary">{item.modelVersion ?? '所有版本'}</small></td>
        <td>{item.deploymentSku}<small className="usage-secondary">{item.regionScope === 'all' ? '所有区域 · 用户明确指定' : item.regions.join('、')}</small></td>
        <td>${item.inputUsdPerMillion} / ${item.outputUsdPerMillion}<small className="usage-secondary">手动简化估算 · 官方优先</small></td>
        <td><Badge appearance="tint" color={item.enabled ? 'informative' : 'subtle'} icon={item.enabled ? <Money20Regular /> : <Info20Regular />}>
          {Date.parse(item.effectiveFromUtc) > Date.now() ? item.enabled ? '待生效' : '待停用' : item.enabled ? '备用' : '已停用'}</Badge>
          <small className="usage-secondary">{usageDate(item.effectiveFromUtc)}</small></td>
        <td><Button appearance="subtle" disabled={busy} icon={<Edit20Regular />} onClick={() => edit(item)} aria-label={`编辑 ${item.modelName} 手动价格`}>编辑</Button>
          {item.enabled && <Button appearance="subtle" disabled={busy} onClick={() => {
            if (!data.etag) { setError('价格配置缺少版本标识，请刷新后再停用。'); return }
            setBusy(true); setError('')
            void disableManualPrice(item.ruleId, data.etag).then((result) => {
              setNotice(`手动价格将从 ${usageDate(result.item.effectiveFromUtc)} 停用，历史版本保留。`)
              setRevision((value) => value + 1)
            }).catch((reason: unknown) => setError(usageError(reason))).finally(() => setBusy(false))
          }} aria-label={`停用 ${item.modelName} 手动价格`}>停用</Button>}</td>
      </tr>)}</tbody></table></div>}
    </div>
    <OverlayDrawer open={open} position="end" size="medium" aria-label={editing ? '编辑手动价格' : '新增手动价格'}
      onOpenChange={(_, value) => { if (!busy) setOpen(value.open) }}>
      <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} disabled={busy} onClick={() => setOpen(false)} aria-label="关闭手动价格编辑" />}>
        {editing ? '编辑手动价格' : '新增手动价格'}</DrawerHeaderTitle></DrawerHeader>
      <DrawerBody><div className="drawer-notice"><Info20Regular /><p>模型名和输入/输出单价必填。官方存在相同范围价格时以官方为准；当前只支持普通文本 token 的统一估算。</p></div>
        <div className="form-stack">
          <Field label="模型名称" required><Input value={modelName} disabled={busy} placeholder="例如：gpt-6.1-sol" onChange={(_, value) => setModelName(value.value)} /></Field>
          <Field label="模型版本（可选）"><Input value={version} disabled={busy} placeholder="留空适用该模型所有版本" onChange={(_, value) => setVersion(value.value)} /></Field>
          <Field label="部署方式" required><Select value={sku} disabled={busy} onChange={(_, value) => {
            if (value.value === 'GlobalStandard' || value.value === 'DataZoneStandard' || value.value === 'Standard') setSku(value.value)
          }}><option value="GlobalStandard">GlobalStandard · 全球按量</option><option value="DataZoneStandard">DataZoneStandard · 数据区按量</option><option value="Standard">Standard · 区域按量</option></Select></Field>
          <Field label="输入单价（USD／100 万 token）" required><Input value={input} disabled={busy} inputMode="decimal" onChange={(_, value) => setInput(value.value)} /></Field>
          <Field label="输出单价（USD／100 万 token）" required><Input value={output} disabled={busy} inputMode="decimal" onChange={(_, value) => setOutput(value.value)} /></Field>
          <Field label="适用区域" required><Checkbox checked={allRegions} disabled={busy} required={false}
            aria-label="明确适用所有区域" label="明确适用所有区域" onChange={(_, value) => setAllRegions(value.checked === true)} />
            {!allRegions && <><Select value="" disabled={busy} aria-label="添加适用区域" onChange={(_, value) => {
              if (value.value) setRegions((current) => [...new Set([...current, value.value])])
            }}><option value="">请选择区域</option>{data?.regionOptions.map((region) => <option key={region}>{region}</option>)}</Select>
              <Input value={customRegion} disabled={busy} aria-label="其他适用区域代码" placeholder="其他 Azure 区域代码，多项用逗号分隔" onChange={(_, value) => setCustomRegion(value.value)} />
              <p>{regions.join('、') || '尚未选择区域'}</p>{regions.length > 0 && <Button size="small" disabled={busy} onClick={() => setRegions([])}>清除已选区域</Button>}</>}
          </Field>
          <Field label="价格来源 / 备注"><Textarea value={note} disabled={busy} rows={3} maxLength={500} onChange={(_, value) => setNote(value.value)} placeholder="记录官网页面、报价说明或其他已确认依据" /></Field>
        </div>
        {formError && <div className="message error" role="alert"><Warning20Regular />{formError}</div>}
      </DrawerBody><DrawerFooter><Button appearance="primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中' : '保存手动价格'}</Button>
        <Button disabled={busy} onClick={() => setOpen(false)}>取消</Button></DrawerFooter>
    </OverlayDrawer>
  </section>
}
