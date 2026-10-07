import { useEffect, useState } from 'react'
import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Spinner,
} from '@fluentui/react-components'
import { ArrowSync20Regular, Delete20Regular, Info20Regular, Open20Regular, Warning20Regular } from '@fluentui/react-icons'
import type {
  OffboardingOperation, OffboardingPreviewResponse, SubscriptionInventoryItem, TenantListItem,
} from '@tokenusagealert/schemas'
import { ApiError, executeOffboarding, getOffboardingOperation, previewOffboarding } from '../api'

export interface OffboardingTarget {
  tenant: TenantListItem
  subscription?: SubscriptionInventoryItem
}

const statusLabels: Record<OffboardingOperation['status'], string> = {
  prepared: '待确认', executing: '正在处理 · 请刷新操作状态', submitted: '已提交解除 · 待同步确认',
  partial: '部分请求已提交', failed: '解除未完成', unknown: '结果需核对',
}
function operationError(reason: unknown) {
  return reason instanceof ApiError ? `${reason.problem.code}：${reason.problem.detail}` : '解除管理操作未能完成或结果尚未确认，请刷新状态核对。'
}

export function OffboardingGuide({ target, close, synchronize, syncing }: {
  target: OffboardingTarget | null
  close: () => void
  synchronize: () => void
  syncing: boolean
}) {
  const [preview, setPreview] = useState<OffboardingPreviewResponse | null>(null)
  const [operation, setOperation] = useState<OffboardingOperation | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setPreview(null); setOperation(null); setConfirmation(''); setError('')
  }, [target])
  const tenantId = target?.tenant.tenantId
  const subscription = target?.subscription
  const expectedConfirmation = subscription?.subscriptionId ?? tenantId
  const portalUrl = `https://portal.azure.com/#@${tenantId}${subscription ? `/resource/subscriptions/${subscription.subscriptionId}/overview` : ''}`
  const inspect = async () => {
    if (!tenantId) return
    setBusy(true); setError(''); setOperation(null); setConfirmation('')
    try {
      const result = await previewOffboarding(tenantId, subscription?.subscriptionId)
      setPreview(result); setOperation(result.operation)
    } catch (reason) { setError(operationError(reason)) } finally { setBusy(false) }
  }
  const execute = async () => {
    if (!operation) return
    setBusy(true); setError('')
    try {
      const result = await executeOffboarding(operation.id, confirmation)
      setOperation(result.operation)
    } catch (reason) {
      setError(`${operationError(reason)} 如已提交，请先刷新操作状态或同步授权核对，不要重复点击解除。`)
    } finally { setBusy(false) }
  }
  return <Dialog open={target !== null} onOpenChange={(_, data) => { if (!data.open && !busy) close() }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{subscription ? '解除订阅管理' : '解除租户管理'}</DialogTitle>
      <DialogContent>
        {target && <>
          <div className="scope-notice"><Info20Regular aria-hidden="true" /><div>
            <strong>使用独立身份解除 Lighthouse 委派</strong>
            <span>Collector 保持 Reader。专用解除身份必须先由客户授权；本操作只解除本应用的管理关系，不删除 Azure 订阅、模型或费用历史。</span>
          </div></div>
          <dl className="offboarding-scope">
            <div><dt>客户租户</dt><dd>{target.tenant.displayName}<br /><code>{tenantId}</code></dd></div>
            {subscription && <div><dt>目标订阅</dt><dd>{subscription.displayName}<br /><code>{subscription.subscriptionId}</code></dd></div>}
          </dl>
          {!operation && <Button appearance="primary" disabled={busy} onClick={() => void inspect()}
            icon={busy ? <Spinner size="tiny" /> : <Info20Regular />}>
            {busy ? '正在核对委派' : '检查解除权限并预览'}
          </Button>}
          {preview?.blockers.map((blocker, index) => <div className="message warning" role="alert" key={`${blocker.code}-${index}`}>
            <Warning20Regular aria-hidden="true" /><div><strong>{blocker.code}</strong>
              <p>{blocker.subscriptionId}</p><p>{blocker.message}</p></div>
          </div>)}
          {preview?.identity && <details className="offboarding-scope">
            <summary>客户更新授权所需身份</summary>
            <p>Reader 身份 object ID：<code>{preview.identity.collectorPrincipalId}</code></p>
            <p>解除管理身份 object ID：<code>{preview.identity.principalId}</code></p>
            <p>将后者作为新版 Lighthouse 模板的 <code>offboardingPrincipalId</code>，保持原套餐名称后重新部署。不需要重复创建订阅。</p>
          </details>}
          {operation && <section className="offboarding-preview" aria-label="解除管理预览">
            <Badge appearance="tint" color={operation.status === 'failed' ? 'danger' : 'warning'} icon={<Info20Regular />}>
              {statusLabels[operation.status]}
            </Badge>
            <p>操作 ID：<code>{operation.id}</code></p>
            <p>涉及 {operation.targets.length} 个订阅；只允许本应用套餐内的“Collector Reader + 独立解除身份”组合。</p>
            <ul>{operation.targets.map((item) => <li key={item.subscriptionId}>
              <strong>{item.displayName}</strong><br /><code>{item.subscriptionId}</code>
              <small className="usage-secondary">
                {item.state === 'ready' ? '范围已核验' : item.state === 'submitted' ? 'Azure 已接受解除请求' :
                  item.state === 'failed' ? '未完成' : item.state === 'notAttempted' ? '尚未尝试' : '结果未知'}
              </small>
              {item.message && <p>{item.message}</p>}
            </li>)}</ul>
            {operation.status === 'prepared' ? <>
              <div className="message warning"><Warning20Regular aria-hidden="true" />
                <span>确认后合作伙伴将失去这些订阅的访问权限。无法自行恢复，必须由客户重新授权。预览 10 分钟后失效。</span>
              </div>
              <Field label={subscription ? '输入订阅 ID 确认解除' : '输入租户 ID 确认解除'} required>
                <Input value={confirmation} onChange={(_, value) => setConfirmation(value.value)} placeholder={expectedConfirmation} disabled={busy} />
              </Field>
              <Button appearance="primary" className="offboarding-confirm" icon={busy ? <Spinner size="tiny" /> : <Delete20Regular />}
                disabled={busy || confirmation.trim().toLowerCase() !== expectedConfirmation}
                onClick={() => void execute()}>确认解除管理</Button>
            </> : <>
              <p>请求状态不等于已完成权限传播。请点击下方“同步确认授权”；平台核验 Collector 失去访问权后才移出监控。</p>
              {operation.synchronizationRequested && <p role="status">已请求一次授权同步，完成后刷新租户列表。</p>}
              {operation.synchronizationError && <p role="alert" className="usage-error">{operation.synchronizationError}</p>}
            </>}
            <Button appearance="subtle" disabled={busy} onClick={() => {
              setBusy(true); setError('')
              void getOffboardingOperation(operation.id).then((result) => setOperation(result.operation))
                .catch((reason: unknown) => setError(operationError(reason))).finally(() => setBusy(false))
            }}>刷新操作状态</Button>
          </section>}
          {error && <div className="message error" role="alert">{error}</div>}
          <details className="offboarding-fallback">
            <summary>客户尚未授予解除权限：使用客户侧撤销指引</summary>
            <ol className="offboarding-steps">
              <li>客户订阅 Owner 登录 Azure Portal，切换到上面的客户目录。</li>
              <li>进入 <strong>Azure Lighthouse → 服务提供商 → 服务提供商套餐</strong>，找到本应用的 <strong>AOAI Cost Usage Monitoring</strong> 委派。</li>
              <li>{subscription ? '核对目标订阅，只撤销这个订阅的本应用委派，不操作其他服务商。' : '逐一核对该租户下的订阅，撤销全部对应委派。仍有授权时，租户继续管理其余订阅。'}</li>
              <li>回到这里点击“同步确认授权”，等待权限传播和核验。</li>
            </ol>
            <Button as="a" href={portalUrl} target="_blank" rel="noopener noreferrer" icon={<Open20Regular />}>
              打开客户 Azure Portal（需客户管理员）
            </Button>
          </details>
          <p>同步失败不会伪造移除。历史按原保留期保存；整个租户重新授权后进入待启用流程。</p>
        </>}
      </DialogContent>
      <DialogActions>
        <Button appearance="secondary" disabled={busy} onClick={close}>关闭</Button>
        <Button appearance="secondary" icon={<ArrowSync20Regular />} disabled={syncing || busy} onClick={synchronize}>
          同步确认授权
        </Button>
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>
}
