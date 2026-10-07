import { useEffect, useState } from 'react'
import {
  Button, DrawerBody, DrawerFooter, DrawerHeader, DrawerHeaderTitle, Field, Input, OverlayDrawer, Spinner,
} from '@fluentui/react-components'
import { Dismiss20Regular, Edit20Regular, Info20Regular, Warning20Regular } from '@fluentui/react-icons'
import type { TenantListItem } from '@tokenusagealert/schemas'
import { updateTenantSettings } from '../api'
import { usageError } from './UsageShared'

export function TenantSettingsEditor({ tenant, close, saved, refresh }: {
  tenant: TenantListItem | null
  close: () => void
  saved: (tenant: TenantListItem) => void
  refresh: () => void
}) {
  const [name, setName] = useState('')
  const [threshold, setThreshold] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setName(tenant?.displayName ?? ''); setThreshold(tenant?.hourlyThresholdUsd ?? ''); setError('')
  }, [tenant])
  const save = async () => {
    if (!tenant) return
    setBusy(true); setError('')
    try {
      saved((await updateTenantSettings(tenant.tenantId, { displayName: name, hourlyThresholdUsd: threshold }, tenant.etag)).tenant)
    } catch (reason) { setError(usageError(reason)) }
    finally { setBusy(false) }
  }
  return <OverlayDrawer open={tenant !== null} position="end" size="small"
    onOpenChange={(_, data) => { if (!data.open && !busy) close() }}>
    <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />}
      disabled={busy} onClick={close} aria-label="关闭租户编辑" />}>编辑租户名称与限额</DrawerHeaderTitle></DrawerHeader>
    <DrawerBody>
      <div className="drawer-notice"><Info20Regular /><p>名称用于当前清单与概览。费用限额应用于后续采集/计算，不改写历史小时阈值；本操作不改变租户授权或启用状态。</p></div>
      <p className="usage-secondary">Tenant ID：{tenant?.tenantId}</p>
      <div className="form-stack">
        <Field label="租户名称" required><Input value={name} maxLength={120} disabled={busy}
          onChange={(_, data) => { setName(data.value); setError('') }} /></Field>
        <Field label="小时费用限额（USD）" required><Input value={threshold} inputMode="decimal"
          contentBefore="$" placeholder="例如：10.00" disabled={busy} onChange={(_, data) => { setThreshold(data.value); setError('') }} /></Field>
      </div>
      {error && <div className="message error" role="alert"><Warning20Regular />{error}</div>}
    </DrawerBody>
    <DrawerFooter>
      <Button appearance="primary" disabled={busy || Boolean(error)} icon={busy ? <Spinner size="tiny" /> : <Edit20Regular />}
        onClick={() => void save()}>{busy ? '保存中' : '保存修改'}</Button>
      {error && <Button disabled={busy} onClick={() => { close(); refresh() }}>刷新核对配置</Button>}
      <Button disabled={busy} onClick={close}>取消</Button>
    </DrawerFooter>
  </OverlayDrawer>
}
