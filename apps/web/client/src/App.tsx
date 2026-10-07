import { useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import {
  Avatar,
  Badge,
  Button,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  OverlayDrawer,
  Spinner,
  Tab,
  TabList,
} from '@fluentui/react-components'
import {
  Add20Regular,
  ArrowSync20Regular,
  Building20Regular,
  CheckmarkCircle20Regular,
  ChevronRight20Regular,
  Database20Regular,
  Delete20Regular,
  Edit20Regular,
  Dismiss20Regular,
  Home20Regular,
  Info20Regular,
  Key20Regular,
  Pulse20Regular,
  PlugDisconnected20Regular,
  Search20Regular,
  Settings20Regular,
  ShieldLock20Regular,
  SignOut20Regular,
  Warning20Regular,
} from '@fluentui/react-icons'
import type {
  AuthorizationSyncRun,
  CreateTenantRequest,
  Session,
  SubscriptionInventoryDocument,
  TenantListItem,
} from '@tokenusagealert/schemas'
import {
  ApiError,
  createTenant,
  enableTenant,
  getLatestAuthorizationSyncRun,
  getSession,
  getTenantSubscriptions,
  listTenants,
  startAuthorizationSync,
} from './api'
import { OperationsPage } from './pages/OperationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { UsageOverviewPage } from './pages/UsageOverviewPage'
import { TenantUsagePage } from './pages/TenantUsagePage'
import { OffboardingGuide, type OffboardingTarget } from './components/OffboardingGuide'
import { DeletePendingTenantDialog } from './components/DeletePendingTenantDialog'
import { TenantSettingsEditor } from './components/TenantSettingsEditor'

function formatUsd(value: string | null): string {
  if (value === null) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(Number(value))
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function initials(name: string): string {
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

const statusLabels: Record<TenantListItem['status'], string> = {
  pendingAuthorization: '等待客户授权',
  discovered: '已发现待启用',
  active: '活动',
  degraded: '授权范围变化',
  disconnected: '授权断开',
  disabled: '已停用',
  deleted: '已解除管理',
}

function statusColor(
  status: TenantListItem['status'],
): 'success' | 'warning' | 'danger' | 'informative' | 'subtle' {
  if (status === 'active') return 'success'
  if (status === 'degraded') return 'warning'
  if (status === 'disconnected') return 'danger'
  if (status === 'pendingAuthorization' || status === 'discovered') {
    return 'informative'
  }
  return 'subtle'
}

interface ShellProps {
  session: Session
  children: React.ReactNode
}

function AppShell({ session, children }: ShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳至主内容</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>
            <strong>AOAI Cost</strong>
            <small>费用告警平台</small>
          </span>
        </div>
        <nav aria-label="主导航">
          <NavLink to="/overview" className={({ isActive }) => isActive ? 'selected' : ''} aria-label="费用概览" title="费用概览">
            <Home20Regular aria-hidden="true" />
            <span>费用概览</span>
          </NavLink>
          <NavLink
            to="/"
            end
            className={({ isActive }) => isActive ? 'selected' : ''}
            aria-label="租户与授权"
            title="租户与授权"
          >
            <Building20Regular aria-hidden="true" />
            <span>租户与授权</span>
          </NavLink>
          <NavLink
            to="/operations"
            className={({ isActive }) => isActive ? 'selected' : ''}
            aria-label="运行状态"
            title="运行状态"
          >
            <Pulse20Regular aria-hidden="true" />
            <span>运行状态</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => isActive ? 'selected' : ''}
            aria-label="设置"
            title="设置"
          >
            <Settings20Regular aria-hidden="true" />
            <span>设置</span>
          </NavLink>
        </nav>
        <div className="identity">
          <Avatar initials={initials(session.name)} size={32} />
          <span>
            <strong>{session.name}</strong>
            <small>{session.objectId}</small>
          </span>
          <Button
            as="a"
            href="/.auth/logout?post_logout_redirect_uri=/"
            appearance="subtle"
            icon={<SignOut20Regular />}
            aria-label="退出登录"
          />
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        {session.authMode === 'development' && (
          <div className="development-banner">
            本地开发身份 · 不代表生产 Entra 登录
          </div>
        )}
        {children}
      </main>
    </div>
  )
}

function LoginRequired() {
  return (
    <div className="centered-page">
      <section className="login-card">
        <span className="login-card__icon">
          <ShieldLock20Regular />
        </span>
        <h1>需要合作伙伴 Entra ID 登录</h1>
        <p>
          只有被分配到本应用 Enterprise Application
          的合作伙伴运维用户可以访问。
        </p>
        <Button
          as="a"
          href="/.auth/login/aad?post_login_redirect_uri=/"
          appearance="primary"
        >
          使用 Microsoft Entra ID 登录
        </Button>
      </section>
    </div>
  )
}

function TenantPage() {
  const [tenants, setTenants] = useState<TenantListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [tenantId, setTenantId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [threshold, setThreshold] = useState('10.00')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [success, setSuccess] = useState('')
  const [warning, setWarning] = useState('')
  const [latestRun, setLatestRun] =
    useState<AuthorizationSyncRun | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [selectedTenant, setSelectedTenant] =
    useState<TenantListItem | null>(null)
  const [inventory, setInventory] =
    useState<SubscriptionInventoryDocument | null>(null)
  const [enableName, setEnableName] = useState('')
  const [enableThreshold, setEnableThreshold] = useState('10.00')
  const [enabling, setEnabling] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [managementView, setManagementView] = useState<'current' | 'removed'>('current')
  const [offboardingTarget, setOffboardingTarget] = useState<OffboardingTarget | null>(null)
  const [deletionTarget, setDeletionTarget] = useState<TenantListItem | null>(null)
  const [editingTenant, setEditingTenant] = useState<TenantListItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [tenantResponse, runResponse] = await Promise.all([
        listTenants(true),
        getLatestAuthorizationSyncRun(),
      ])
      setTenants(tenantResponse.items)
      setLatestRun(runResponse.run)
      setSelectedTenant((current) => current ? tenantResponse.items.find((tenant) => tenant.tenantId === current.tenantId) ?? null : null)
    } catch (error) {
      setLoadError(
        error instanceof ApiError
          ? `${error.problem.code}: ${error.problem.detail}`
          : '无法加载租户列表。',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const syncAuthorizations = async () => {
    setSyncing(true)
    setSuccess('')
    setWarning('')
    try {
      const previousRunId = latestRun?.runId
      const started = await startAuthorizationSync()
      setSuccess(`授权同步已启动：${started.executionName}`)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const response = await getLatestAuthorizationSyncRun()
        if (
          response.run &&
          response.run.runId !== previousRunId &&
          response.run.status !== 'running'
        ) {
          setLatestRun(response.run)
          await load()
          setDetailsOpen(false)
          if (response.run.status === 'failed') {
            setSuccess('')
            setWarning(`授权同步失败，未确认移除：${response.run.errors.map((error) => error.message).join(' ')}`)
          } else {
            setSuccess(`授权同步完成：发现 ${response.run.discoveredTenantCount} 个客户租户、${response.run.visibleSubscriptionCount} 个订阅。`)
            if (response.run.errors.length) setWarning(`部分授权未能确认，相关原记录保留：${response.run.errors.map((error) => error.message).join(' ')}`)
          }
          return
        }
      }
      setWarning('同步任务仍在运行，请稍后刷新页面查看结果。')
    } catch (error) {
      setWarning(
        error instanceof ApiError
          ? `${error.problem.code}: ${error.problem.detail}`
          : '无法启动授权同步。',
      )
    } finally {
      setSyncing(false)
    }
  }

  const openTenantDetails = async (tenant: TenantListItem) => {
    setSelectedTenant(tenant)
    setEnableName(tenant.displayName)
    setEnableThreshold(tenant.hourlyThresholdUsd ?? '10.00')
    setInventory(null)
    setDetailsError('')
    setDetailsOpen(true)
    setDetailsLoading(true)
    try {
      const response = await getTenantSubscriptions(tenant.tenantId)
      setInventory(response.inventory)
    } catch (error) {
      setDetailsError(
        error instanceof ApiError
          ? `${error.problem.code}: ${error.problem.detail}`
          : '无法读取授权订阅。',
      )
    } finally {
      setDetailsLoading(false)
    }
  }

  const activateTenant = async () => {
    if (!selectedTenant) return
    setEnabling(true)
    setDetailsError('')
    try {
      const response = await enableTenant(selectedTenant.tenantId, {
        displayName: enableName,
        hourlyThresholdUsd: enableThreshold,
        etag: selectedTenant.etag,
      })
      setTenants((current) =>
        current.map((tenant) =>
          tenant.tenantId === response.tenant.tenantId
            ? response.tenant
            : tenant,
        ),
      )
      setSelectedTenant(response.tenant)
      setSuccess(`${response.tenant.displayName} 已启用。`)
      setDetailsOpen(false)
    } catch (error) {
      setDetailsError(
        error instanceof ApiError
          ? `${error.problem.code}: ${error.problem.detail}`
          : '无法启用租户。',
      )
    } finally {
      setEnabling(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    setSaving(true)
    setFormError('')
    setSuccess('')
    setWarning('')
    const input: CreateTenantRequest = {
      tenantId,
      displayName,
      hourlyThresholdUsd: threshold,
      notes,
    }
    try {
      const response = await createTenant(input)
      setTenants((current) => [response.tenant, ...current.filter((tenant) => tenant.tenantId !== response.tenant.tenantId)])
      setManagementView('current')
      setSuccess(
        `${response.tenant.displayName} 已保存到 Blob，状态为等待客户授权。`,
      )
      if (response.warnings?.length) {
        setWarning(response.warnings.map((item) => item.message).join(' '))
      }
      setDrawerOpen(false)
      setTenantId('')
      setDisplayName('')
      setThreshold('10.00')
      setNotes('')
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldErrors = error.problem.errors
          ? Object.values(error.problem.errors).flat().join(' ')
          : ''
        setFormError(
          `${error.problem.code}: ${error.problem.detail} ${fieldErrors}`.trim(),
        )
      } else {
        setFormError('保存租户时发生未知错误。')
      }
    } finally {
      setSaving(false)
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
  const currentTenants = tenants.filter((tenant) => tenant.status !== 'deleted')
  const removedTenants = tenants.filter((tenant) => tenant.status === 'deleted')
  const filtered = (managementView === 'current' ? currentTenants : removedTenants).filter((tenant) =>
    `${tenant.displayName} ${tenant.tenantId}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery),
  )

  return (
    <>
      <div className="page">
        <header className="page-header">
          <div>
            <span className="eyebrow">客户接入</span>
            <h1>租户与授权</h1>
            <p>
              预登记客户、同步 Azure Lighthouse 委派并启用已发现租户。
            </p>
          </div>
          <div className="page-actions">
            <Button
              appearance="secondary"
              icon={
                syncing ? <Spinner size="tiny" /> : <ArrowSync20Regular />
              }
              disabled={syncing}
              onClick={() => void syncAuthorizations()}
            >
              {syncing ? '同步中' : '同步 Lighthouse'}
            </Button>
            <Button
              appearance="primary"
              icon={<Add20Regular />}
              onClick={() => {
                setFormError('')
                setDrawerOpen(true)
              }}
            >
              预登记租户
            </Button>
          </div>
        </header>

        <div className="scope-notice">
          <Info20Regular />
          <div>
            <strong>所有运维用户共享平台租户清单</strong>
            <span>
              授权以 Lighthouse 为准。客户授予专用解除身份权限后，可在这里预览并确认解除；未更新授权的客户仍可在 Azure 自行撤销。
            </span>
          </div>
        </div>

        {latestRun && (
          <div className={`sync-summary sync-summary--${latestRun.status}`}>
            <ArrowSync20Regular />
            <span>
              <strong>
                最近同步：
                {latestRun.status === 'succeeded'
                  ? '成功'
                  : latestRun.status === 'succeededWithWarnings'
                    ? '有警告'
                    : latestRun.status === 'failed'
                      ? '失败'
                      : '运行中'}
              </strong>
              <small>
                {latestRun.visibleSubscriptionCount} 个订阅 ·{' '}
                {latestRun.discoveredTenantCount} 个客户租户 ·{' '}
                {formatDateTime(latestRun.startedAtUtc)}
              </small>
            </span>
          </div>
        )}

        {success && (
          <div className="message success" role="status">
            <CheckmarkCircle20Regular />
            {success}
          </div>
        )}
        {warning && (
          <div className="message warning" role="alert">
            <Warning20Regular />
            {warning}
          </div>
        )}
        {loadError && (
          <div className="message error" role="alert">
            <Warning20Regular />
            {loadError}
          </div>
        )}

        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>客户租户</h2>
              <p>{currentTenants.length} 个管理中租户 · {removedTenants.length} 个已解除管理，历史按原保留期保存</p>
            </div>
            <Input
              contentBefore={<Search20Regular />}
              placeholder="搜索租户或 tenant ID"
              value={query}
              onChange={(_, data) => setQuery(data.value)}
              aria-label="搜索租户"
            />
          </div>
          <TabList selectedValue={managementView} className="management-tabs" onTabSelect={(_, data) => {
            if (data.value === 'current' || data.value === 'removed') setManagementView(data.value)
          }}>
            <Tab value="current">管理中 ({currentTenants.length})</Tab>
            <Tab value="removed">已解除管理 ({removedTenants.length})</Tab>
          </TabList>

          {loading ? (
            <div className="loading-state">
              <Spinner label="正在读取 Blob 租户配置" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <Key20Regular />
              <strong>
                {managementView === 'removed' ? '暂无已解除管理的租户' : currentTenants.length === 0
                  ? '尚未预登记客户租户'
                  : '没有匹配的租户'}
              </strong>
              <span>
                {managementView === 'removed' ? '客户撤销全部订阅委派后，成功同步并核验的租户会显示在这里。' : currentTenants.length === 0
                  ? '点击“预登记租户”创建第一条配置。'
                  : '请调整搜索条件。'}
              </span>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>客户租户</th>
                    <th>状态</th>
                    <th>小时阈值</th>
                    <th>授权来源</th>
                    <th>创建人</th>
                    <th>更新时间</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((tenant) => (
                    <tr key={tenant.tenantId}>
                      <td>
                        <div className="tenant-name">
                          <Avatar
                            initials={initials(tenant.displayName)}
                            color="colorful"
                            size={36}
                          />
                          <span>
                            <strong>{tenant.displayName}</strong>
                            <small>{tenant.tenantId}</small>
                          </span>
                        </div>
                      </td>
                      <td>
                        <Badge
                          appearance="tint"
                          color={statusColor(tenant.status)}
                          icon={
                            tenant.status === 'active' ? (
                              <CheckmarkCircle20Regular />
                            ) : tenant.status === 'degraded' ||
                              tenant.status === 'disconnected' ? (
                              <Warning20Regular />
                            ) : (
                              <Key20Regular />
                            )
                          }
                        >
                          {statusLabels[tenant.status]}
                        </Badge>
                      </td>
                      <td>{formatUsd(tenant.hourlyThresholdUsd)}</td>
                      <td>
                        {tenant.authorizationSource ===
                        'manual-preregistration'
                          ? '手工预登记'
                          : tenant.authorizationSource ===
                              'lighthouse-template'
                            ? 'Lighthouse 模板'
                            : 'Marketplace'}
                      </td>
                      <td>{tenant.createdByName}</td>
                      <td>{formatDateTime(tenant.updatedAtUtc)}
                        {tenant.deletedAtUtc && <small className="usage-secondary">移出 {formatDateTime(tenant.deletedAtUtc)}</small>}
                      </td>
                      <td>
                        {tenant.status !== 'deleted' && <Button appearance="subtle" icon={<Edit20Regular />}
                          aria-label={`编辑 ${tenant.displayName} 名称与限额`}
                          onClick={() => { setSuccess(''); setWarning(''); setEditingTenant(tenant) }}>编辑</Button>}
                        {tenant.status === 'pendingAuthorization' && <Button
                          appearance="subtle" icon={<Delete20Regular />}
                          aria-label={`删除 ${tenant.displayName} 登记`}
                          onClick={() => { setSuccess(''); setWarning(''); setDeletionTarget(tenant) }}
                        >删除登记</Button>}
                        {tenant.status !== 'deleted' && tenant.status !== 'pendingAuthorization' && <Button
                          appearance="subtle" icon={<PlugDisconnected20Regular />}
                          aria-label={`解除 ${tenant.displayName} 管理`}
                          onClick={() => setOffboardingTarget({ tenant })}
                        >解除管理</Button>}
                        {tenant.status === 'deleted' && <Button appearance="subtle" onClick={() => {
                          setTenantId(tenant.tenantId); setDisplayName(tenant.displayName)
                          setThreshold(tenant.hourlyThresholdUsd ?? '10.00'); setNotes(tenant.notes)
                          setFormError(''); setDrawerOpen(true)
                        }}>重新登记</Button>}
                        <Button
                          appearance="subtle"
                          icon={<ChevronRight20Regular />}
                          aria-label={`查看 ${tenant.displayName} 授权订阅`}
                          onClick={() => void openTenantDetails(tenant)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <TenantSettingsEditor tenant={editingTenant} close={() => setEditingTenant(null)} refresh={() => void load()}
        saved={(tenant) => {
          setTenants((current) => current.map((item) => item.tenantId === tenant.tenantId ? tenant : item))
          if (selectedTenant?.tenantId === tenant.tenantId) setSelectedTenant(tenant)
          setEditingTenant(null); setSuccess(`${tenant.displayName} 的名称与小时费用限额已保存；历史小时阈值不变。`)
        }}
      />
      <DeletePendingTenantDialog
        tenant={deletionTarget}
        close={() => setDeletionTarget(null)}
        refresh={() => void load()}
        deleted={(response) => {
          setTenants((current) => current.filter((tenant) => tenant.tenantId !== response.tenantId))
          if (selectedTenant?.tenantId === response.tenantId) {
            setSelectedTenant(null); setDetailsOpen(false)
          }
          setSuccess(`${deletionTarget?.displayName ?? '租户'} 的预登记已删除。`)
          setWarning(response.warnings?.map((item) => item.message).join(' ') ?? '')
          setDeletionTarget(null)
        }}
      />

      <OverlayDrawer
        open={drawerOpen}
        position="end"
        size="small"
        onOpenChange={(_, data) => setDrawerOpen(data.open)}
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                onClick={() => setDrawerOpen(false)}
                aria-label="关闭"
              />
            }
          >
            预登记客户租户
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <div className="drawer-notice">
            <Info20Regular />
            <p>
              保存后状态固定为“等待客户授权”，不能通过本表单伪造为活动租户。
            </p>
          </div>
          <div className="form-stack">
            <Field label="客户租户名称" required>
              <Input
                value={displayName}
                maxLength={120}
                onChange={(_, data) => setDisplayName(data.value)}
                placeholder="例如：Contoso 零售集团"
              />
            </Field>
            <Field label="Tenant ID" required>
              <Input
                value={tenantId}
                onChange={(_, data) => setTenantId(data.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </Field>
            <Field label="小时预警金额（USD）" required>
              <Input
                value={threshold}
                onChange={(_, data) => setThreshold(data.value)}
                contentBefore="$"
                inputMode="decimal"
              />
            </Field>
            <Field label="备注">
              <Input
                value={notes}
                maxLength={1000}
                onChange={(_, data) => setNotes(data.value)}
                placeholder="可选"
              />
            </Field>
          </div>
          {formError && (
            <div className="message error compact" role="alert">
              <Warning20Regular />
              {formError}
            </div>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button
            appearance="primary"
            disabled={saving}
            icon={saving ? <Spinner size="tiny" /> : <Add20Regular />}
            onClick={() => void submit()}
          >
            {saving ? '保存中' : '保存到 Blob'}
          </Button>
          <Button
            appearance="secondary"
            onClick={() => setDrawerOpen(false)}
          >
            取消
          </Button>
        </DrawerFooter>
      </OverlayDrawer>

      <OverlayDrawer
        open={detailsOpen}
        position="end"
        size="medium"
        onOpenChange={(_, data) => setDetailsOpen(data.open)}
      >
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                onClick={() => setDetailsOpen(false)}
                aria-label="关闭授权详情"
              />
            }
          >
            {selectedTenant?.displayName ?? '授权详情'}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          {selectedTenant && (
            <>
              <div className="tenant-detail-summary">
                <span>
                  <small>Tenant ID</small>
                  <strong>{selectedTenant.tenantId}</strong>
                </span>
                <Badge
                  appearance="tint"
                  color={statusColor(selectedTenant.status)}
                >
                  {statusLabels[selectedTenant.status]}
                </Badge>
              </div>

              <h3 className="drawer-section-title">已委派订阅</h3>
              {selectedTenant.status === 'deleted' && <div className="message warning" role="note">
                <Info20Regular />该租户已移出监控，不再采集。客户重新授权后会进入待启用流程；已有费用历史保留。
              </div>}
              {detailsLoading ? (
                <div className="drawer-loading">
                  <Spinner label="正在读取 inventory" />
                </div>
              ) : inventory?.subscriptions.length ? (
                <div className="subscription-list">
                  {inventory.subscriptions.map((subscription) => (
                    <article key={subscription.subscriptionId}>
                      <Database20Regular />
                      <span>
                        <strong>{subscription.displayName}</strong>
                        <small>{subscription.subscriptionId}</small>
                        <small>
                          最近验证{' '}
                          {formatDateTime(
                            subscription.lastValidatedAtUtc,
                          )}
                        </small>
                      </span>
                      <div className="subscription-actions"><Badge
                        appearance="tint"
                        color={
                          subscription.state.toLowerCase() === 'enabled'
                            ? 'success'
                            : 'warning'
                        }
                      >
                        {subscription.state}
                      </Badge>
                        <Button appearance="subtle" icon={<PlugDisconnected20Regular />}
                          aria-label={`解除订阅 ${subscription.displayName} 管理`}
                          onClick={() => setOffboardingTarget({ tenant: selectedTenant, subscription })}>解除管理</Button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="drawer-empty">
                  <Key20Regular />
                  尚未发现 Lighthouse 委派订阅。
                </div>
              )}

              {(inventory?.removedSubscriptions?.length ?? 0) > 0 && <section className="removed-subscriptions">
                <h3 className="drawer-section-title">已移出订阅</h3>
                <p>下列订阅已核验失去 Collector 访问权，不再采集，也不再计入预期订阅总数。</p>
                {inventory!.removedSubscriptions!.map((subscription) => <article key={subscription.subscriptionId}>
                  <strong>{subscription.displayName}</strong><code>{subscription.subscriptionId}</code>
                  <small>移出时间 {formatDateTime(subscription.removedAtUtc)}</small>
                  <Badge appearance="tint" color="subtle" icon={<PlugDisconnected20Regular />}>已解除管理</Badge>
                </article>)}
              </section>}

              <p><Link to={`/tenants/${selectedTenant.tenantId}/usage`}>查看该租户保留的费用历史</Link></p>

              {(selectedTenant.status === 'discovered' ||
                selectedTenant.status === 'disabled') && (
                <div className="enable-panel">
                  <h3>启用租户</h3>
                  <p>
                    确认显示名和小时阈值后，才允许进入费用采集。
                  </p>
                  <Field label="客户租户名称" required>
                    <Input
                      value={enableName}
                      onChange={(_, data) => setEnableName(data.value)}
                    />
                  </Field>
                  <Field label="小时预警金额（USD）" required>
                    <Input
                      value={enableThreshold}
                      onChange={(_, data) =>
                        setEnableThreshold(data.value)
                      }
                      contentBefore="$"
                    />
                  </Field>
                </div>
              )}

              {detailsError && (
                <div className="message error compact" role="alert">
                  <Warning20Regular />
                  {detailsError}
                </div>
              )}
            </>
          )}
        </DrawerBody>
        <DrawerFooter>
          {selectedTenant &&
            (selectedTenant.status === 'discovered' ||
              selectedTenant.status === 'disabled') && (
              <Button
                appearance="primary"
                disabled={
                  enabling || !inventory?.subscriptions.some((subscription) => subscription.state.toLowerCase() === 'enabled')
                }
                icon={
                  enabling ? (
                    <Spinner size="tiny" />
                  ) : (
                    <CheckmarkCircle20Regular />
                  )
                }
                onClick={() => void activateTenant()}
              >
                {enabling ? '启用中' : '启用租户'}
              </Button>
            )}
          <Button
            appearance="secondary"
            onClick={() => setDetailsOpen(false)}
          >
            关闭
          </Button>
        </DrawerFooter>
      </OverlayDrawer>
      <OffboardingGuide target={offboardingTarget} close={() => setOffboardingTarget(null)} syncing={syncing}
        synchronize={() => { setOffboardingTarget(null); void syncAuthorizations() }} />
    </>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [unauthorized, setUnauthorized] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getSession()
      .then(setSession)
      .catch((sessionError: unknown) => {
        if (
          sessionError instanceof ApiError &&
          sessionError.problem.status === 401
        ) {
          setUnauthorized(true)
          return
        }
        setError('无法验证当前登录会话。')
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="centered-page">
        <Spinner label="正在验证登录会话" />
      </div>
    )
  }
  if (unauthorized) return <LoginRequired />
  if (error || !session) {
    return (
      <div className="centered-page">
        <section className="login-card">
          <Warning20Regular />
          <h1>无法打开应用</h1>
          <p>{error || '登录会话不可用。'}</p>
        </section>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <AppShell session={session}>
        <Routes>
          <Route path="/" element={<TenantPage />} />
          <Route path="/overview" element={<UsageOverviewPage />} />
          <Route path="/tenants/:tenantId/usage" element={<TenantUsagePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="*" element={
            <div className="page">
              <h1>页面不存在</h1>
              <p>请从主导航选择已开放的功能。</p>
              <Link to="/">返回租户与授权</Link>
            </div>
          } />
        </Routes>
      </AppShell>
    </BrowserRouter>
  )
}
