import { useEffect, useState } from 'react'
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Spinner,
} from '@fluentui/react-components'
import { Delete20Regular, Info20Regular, Warning20Regular } from '@fluentui/react-icons'
import type { DeleteTenantRegistrationResponse, TenantListItem } from '@tokenusagealert/schemas'
import { ApiError, deletePendingTenant } from '../api'

export function DeletePendingTenantDialog({ tenant, close, deleted, refresh }: {
  tenant: TenantListItem | null
  close: () => void
  deleted: (response: DeleteTenantRegistrationResponse) => void
  refresh: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setError('') }, [tenant])

  const confirm = async () => {
    if (!tenant || busy || error) return
    setBusy(true)
    try {
      deleted(await deletePendingTenant(tenant.tenantId, tenant.etag))
    } catch (reason) {
      setError(reason instanceof ApiError ? `${reason.problem.code}：${reason.problem.detail}` :
        '删除结果未确认，请刷新租户列表核对；不要重复提交。')
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open={tenant !== null} onOpenChange={(_, data) => { if (!data.open && !busy) close() }}>
    <DialogSurface><DialogBody>
      <DialogTitle>删除租户预登记</DialogTitle>
      <DialogContent>
        {tenant && <>
          <div className="scope-notice"><Info20Regular aria-hidden="true" /><div>
            <strong>仅删除平台登记，不解除 Azure 授权</strong>
            <span>确认后直接删除该租户的配置 JSON，不移入“已解除管理”。操作审计及既有费用历史保留。</span>
          </div></div>
          <dl className="offboarding-scope">
            <div><dt>客户租户</dt><dd>{tenant.displayName}<br /><code>{tenant.tenantId}</code></dd></div>
            <div><dt>当前状态</dt><dd>等待客户授权</dd></div>
          </dl>
          <p>需要时可以重新预登记。如果客户已授予 Lighthouse 委派，后续授权同步仍会重新发现该租户，需配置并启用后才采集。</p>
        </>}
        {error && <div className="message error" role="alert"><Warning20Regular aria-hidden="true" />{error}</div>}
      </DialogContent>
      <DialogActions>
        <Button appearance="secondary" disabled={busy} onClick={close}>取消</Button>
        {error ? <Button appearance="primary" onClick={() => { close(); refresh() }}>刷新租户列表</Button> :
          <Button appearance="primary" disabled={busy} className="offboarding-confirm"
            icon={busy ? <Spinner size="tiny" /> : <Delete20Regular />}
            onClick={() => void confirm()}>{busy ? '删除中' : '确认删除登记'}</Button>}
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>
}
