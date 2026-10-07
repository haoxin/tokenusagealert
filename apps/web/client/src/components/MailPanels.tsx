import { useEffect, useRef, useState } from 'react'
import {
  Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, Select, Spinner, Textarea,
} from '@fluentui/react-components'
import { ArrowSync20Regular, CheckmarkCircle20Regular, Clock20Regular, ErrorCircle20Regular, Info20Regular, Mail20Regular, Warning20Regular } from '@fluentui/react-icons'
import { Link } from 'react-router-dom'
import type { AlertEvent, AlertKind, MailRun, MailSettingsResponse, OutboxRecord } from '@tokenusagealert/schemas'
import {
  enqueueMailTest, getMailSettings, getMailStatus, getOutbox, getOutboxItem, getTenantAlerts,
  resolveOutbox, saveMailSettings,
} from '../api'
import { usageDate, usageError, usageMoneyRange } from './UsageShared'

const kindNames: Record<AlertKind, string> = {
  'cost-exceeded': '估算费用超限', 'cost-reminder': '持续超限提醒', 'cost-recovered': '估算费用恢复',
  'data-quality': '数据质量异常', 'data-reminder': '数据异常提醒', 'data-recovered': '数据质量恢复', test: '发信测试',
}
const statusNames: Record<OutboxRecord['status'], string> = {
  pending: '待投递', claimed: '正在处理', accepted: 'Graph 已接受', failed: '失败', unknown: '结果不确定',
  suppressed: '未投递', previewed: '预览完成 · 未发信', closed: '人工关闭',
}
function MailBadge({ item }: { item: OutboxRecord }) {
  return <Badge appearance="tint"
    color={item.status === 'accepted' ? 'success' : item.status === 'failed' ? 'danger' : item.status === 'unknown' ? 'warning' : 'informative'}
    icon={item.status === 'accepted' ? <CheckmarkCircle20Regular /> : item.status === 'failed' ? <ErrorCircle20Regular /> : item.status === 'unknown' ? <Warning20Regular /> : <Clock20Regular />}>
    {statusNames[item.status]}
  </Badge>
}

function recipientAddresses(text: string): string[] {
  return [...new Set(text.split(/[\n,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean))]
}
function testAddresses(value: MailSettingsResponse): string[] {
  return [...new Set([value.settings.senderMailbox, ...value.settings.operationsRecipients])]
    .filter((address) => value.allowedRecipientDomains.includes(address.split('@')[1] ?? ''))
}

export function MailSettingsPanel() {
  const [value, setValue] = useState<MailSettingsResponse | null>(null)
  const [senderMailbox, setSenderMailbox] = useState('')
  const [recipients, setRecipients] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [testRecipient, setTestRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [testItem, setTestItem] = useState<OutboxRecord | null>(null)
  const requestId = useRef<string | null>(null)
  const [revision, setRevision] = useState(0)
  const apply = (response: MailSettingsResponse) => {
    setValue(response); setSenderMailbox(response.settings.senderMailbox)
    setRecipients(response.settings.operationsRecipients.join('\n')); setEnabled(response.settings.enabled)
    setTestRecipient(testAddresses(response)[0] ?? '')
  }
  useEffect(() => {
    const controller = new AbortController()
    getMailSettings(controller.signal).then((response) => { apply(response); setError('') })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(usageError(reason)) })
    return () => controller.abort()
  }, [revision])
  const senderChanged = Boolean(value && senderMailbox.trim().toLowerCase() !== value.settings.senderMailbox)
  const dirty = Boolean(value && (senderChanged || enabled !== value.settings.enabled ||
    JSON.stringify(recipientAddresses(recipients)) !== JSON.stringify(value.settings.operationsRecipients)))
  const save = async () => {
    if (!value) return
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await saveMailSettings({
        senderMailbox, enabled, operationsRecipients: recipientAddresses(recipients),
      }, value.etag)
      apply(response); requestId.current = null
      setNotice(response.warning ?? '通知设置已保存。从后续计算窗口生效；不会自动补发关闭期间的旧告警。')
    } catch (reason) { setError(usageError(reason)) } finally { setBusy(false) }
  }
  const test = async () => {
    if (!value || dirty) return
    setBusy(true); setError(''); setNotice('')
    requestId.current ??= crypto.randomUUID()
    try {
      const result = await enqueueMailTest(requestId.current, testRecipient, !value.graphTestAvailable, value.settings.senderMailbox)
      setTestItem(result.event)
      setNotice(result.warning ?? '测试事件已入队。请刷新测试状态；入队不代表邮件已发送或送达。')
      requestId.current = null
    } catch (reason) { setError(usageError(reason)) } finally { setBusy(false) }
  }
  const refreshTest = async () => {
    if (!testItem) return
    setBusy(true); setError('')
    try {
      setTestItem((await getOutboxItem(testItem.event.id)).item)
      if (!dirty) apply(await getMailSettings())
    } catch (reason) { setError(usageError(reason)) } finally { setBusy(false) }
  }
  return <section className="panel mail-settings" aria-label="告警邮件设置">
    <div className="panel-header"><div><h2>告警与邮件</h2><p>首次超限和持续超限每 6 小时提醒；费用恢复仅记录，不发送恢复邮件。数据质量通知保持不变。</p></div><Mail20Regular /></div>
    <div className="mail-panel-body">
      {!value && !error ? <Spinner label="读取通知配置" /> : <>
        <div className="scope-notice"><Info20Regular /><div><strong>输入邮箱不等于授予发信权限</strong>
          <span>更换发件邮箱会自动关闭通知。管理员需授权该邮箱，真实测试通过后检查收件，再手动启用；Graph 接受不等于最终送达。</span>
        </div></div>
        {value && !value.authorizationReady && value.mode === 'graph' && <div className="message warning" role="note">
          <Warning20Regular /><span>{value.graphTestAvailable ?
            '当前已保存的发件邮箱尚未通过发信权限验证。请先完成此邮箱的 Exchange 单邮箱授权，再发送验证测试；自动通知暂不可启用。' :
            '专用邮件身份尚未开通或缺少部署绑定，当前只能做不发邮件的预览。'}</span>
        </div>}
        <div className="mail-settings-grid">
          <div><Field label="发件邮箱" required><Input value={senderMailbox} type="email" maxLength={320}
            disabled={busy || !value} placeholder="alert@your-domain.example" onChange={(_, data) => {
              setSenderMailbox(data.value); requestId.current = null
              if (value && data.value.trim().toLowerCase() !== value.settings.senderMailbox) setEnabled(false)
            }} /></Field>
            {senderChanged ? <p role="note">邮箱尚未保存；保存后关闭自动通知，并重新核对发信权限。</p> :
              value?.authorizationReady && <p><Badge appearance="tint" color="success" icon={<CheckmarkCircle20Regular />}>发信权限已验证</Badge>
                {value.senderVerifiedAtUtc && <small className="usage-secondary">最近验证 {usageDate(value.senderVerifiedAtUtc)}</small>}</p>}
            <p>允许收件域：{value?.allowedRecipientDomains.join('、') ?? '—'}</p>
            <Checkbox checked={enabled} disabled={busy || !value || senderChanged ||
              (!value.authorizationReady && value.mode === 'graph' && !enabled)}
              onChange={(_, data) => setEnabled(data.checked === true)} label={value?.mode === 'preview' ? '启用本地告警预览（不发邮件）' : '启用自动告警邮件'} />
          </div>
          <Field label="统一运维收件人（每行一个）"><Textarea value={recipients} disabled={busy}
            onChange={(_, data) => { setRecipients(data.value); requestId.current = null }} resize="vertical" rows={4}
            placeholder="先保存真实运维地址，不使用原型虚构地址" /></Field>
        </div>
        <div className="page-actions"><Button appearance="primary" disabled={busy || !value} onClick={() => void save()}>保存通知设置</Button>
          <Button disabled={busy} onClick={() => setRevision((n) => n + 1)} icon={<ArrowSync20Regular />}>重新读取配置</Button></div>
        {dirty && <p role="note" className="mail-note">请先保存修改，再执行测试；测试只使用已保存的发件邮箱和收件人。</p>}
        <div className="mail-test">
          <Field label="测试收件人"><Select value={testRecipient} disabled={busy || dirty}
            onChange={(_, data) => { setTestRecipient(data.value); requestId.current = null }}>
            {(value ? testAddresses(value) : []).map((address) => <option key={address}>{address}</option>)}
          </Select></Field>
          <Button disabled={busy || dirty || !testRecipient || !value?.dispatcherConfigured} icon={<Mail20Regular />} onClick={() => void test()}>
            {value?.graphTestAvailable ? value.authorizationReady ? '发送测试邮件' : '验证发件邮箱（发送测试）' : '预览测试（不发送邮件）'}
          </Button>
          {testItem && <><MailBadge item={testItem} /><span className="mail-note">测试发件邮箱：{testItem.sender}</span>
            <Button disabled={busy} onClick={() => void refreshTest()}>刷新测试状态</Button></>}
        </div>
        {value && !testAddresses(value).length && <p className="mail-note" role="note">请先保存允许域内的运维收件人，才能发送测试。</p>}
      </>}
      {notice && <div className="message success" role="status">{notice}</div>}
      {error && <div className="message error" role="alert">{error}</div>}
      <p className="mail-note">邮件是 USD 公开零售价估算告警，不是账单。未启用时仅记录事件。
        投递结果与不确定状态处理：<Link to="/operations">运行状态 / Outbox</Link>。网页不会修改 Exchange 权限。</p>
    </div>
  </section>
}

export function MailOperationsPanel() {
  const [items, setItems] = useState<OutboxRecord[]>([])
  const [run, setRun] = useState<MailRun | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<{ item: OutboxRecord; etag: string } | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    Promise.all([getOutbox(undefined, controller.signal), getMailStatus(controller.signal)]).then(([outbox, status]) => {
      setItems(outbox.items); setCursor(outbox.nextCursor); setRun(status.run)
    }).catch((failure: unknown) => { if (!controller.signal.aborted) setError(usageError(failure)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const resolve = async (action: 'retry' | 'close') => {
    if (!selected) return
    setSaving(true)
    try {
      await resolveOutbox(selected.item.event.id, selected.etag, action, reason)
      setSelected(null); setReason(''); setRevision((n) => n + 1)
    } catch (failure) { setError(usageError(failure)) } finally { setSaving(false) }
  }
  return <section className="panel mail-operations" aria-label="邮件 Outbox">
    <div className="panel-header"><div><h2>邮件 Outbox</h2><p>Graph 已接受 ≠ 已送达；结果不确定时不会自动重发。</p></div>
      <Button icon={<ArrowSync20Regular />} onClick={() => setRevision((n) => n + 1)}>刷新邮件状态</Button></div>
    <div className="mail-panel-body">
      {run ? <p>最近处理：{usageDate(run.finishedAtUtc)} · 已接受 {run.accepted} · 失败 {run.failed} · 不确定 {run.unknown} · 预览 {run.previewed}
        {run.errors.map((issue) => <span className="usage-error" key={issue.code}> {issue.code}：{issue.message}</span>)}</p> : <p>尚无邮件任务完成记录。</p>}
      {error && <div className="message error" role="alert">{error}</div>}
      {loading ? <Spinner label="读取 Outbox" /> : !items.length ? <p>暂无邮件事件。没有记录不表示发信授权已完成。</p> :
        <div className="table-wrap"><table><thead><tr><th>创建时间 / 事件</th><th>租户</th><th>收件人</th><th>投递状态</th><th>尝试</th><th>详情</th></tr></thead><tbody>
          {items.map((item) => <tr key={item.event.id}><td>{usageDate(item.event.createdAtUtc)}<small className="usage-secondary">{kindNames[item.event.kind]} · {item.event.id.slice(0, 10)}</small></td>
            <td>{item.event.tenantName}</td><td>{item.recipients.join(', ') || '未配置'}</td><td><MailBadge item={item} /><small className="usage-secondary">{item.lastError?.code}</small></td>
            <td>{item.attempts}</td><td><Button size="small" onClick={() => {
              setReason('')
              void getOutboxItem(item.event.id).then(setSelected).catch((failure: unknown) => setError(usageError(failure)))
            }}>查看</Button></td></tr>)}
        </tbody></table></div>}
      {cursor && <Button onClick={() => { void getOutbox(cursor).then((next) => { setItems((old) => [...old, ...next.items]); setCursor(next.nextCursor) }).catch((failure: unknown) => setError(usageError(failure))) }}>加载更多</Button>}
    </div>
    <Dialog open={selected !== null} onOpenChange={(_, data) => { if (!data.open) setSelected(null) }}><DialogSurface><DialogBody>
      <DialogTitle>邮件事件详情</DialogTitle><DialogContent>
        {selected && <><MailBadge item={selected.item} /><p>{kindNames[selected.item.event.kind]} · {selected.item.event.tenantName}</p>
          <p className="mail-event-id">{selected.item.event.id}</p><p>{selected.item.lastError?.message ?? '没有错误记录。'}</p>
          <p>发件邮箱：{selected.item.sender}</p>
          <p>Graph request ID：{selected.item.graphRequestId ?? '—'}</p>
          {selected.item.status === 'unknown' && <><div className="message warning"><Warning20Regular />请先核对 Exchange 消息跟踪。重新投递可能产生重复邮件。</div>
            <Field label="人工核对原因（至少 5 字）"><Textarea value={reason} onChange={(_, data) => setReason(data.value)} /></Field></>}
        </>}
      </DialogContent><DialogActions>
        {selected?.item.status === 'unknown' && <>
          <Button disabled={saving || reason.trim().length < 5} onClick={() => void resolve('close')}>关闭，不重发</Button>
          <Button appearance="primary" disabled={saving || reason.trim().length < 5} onClick={() => void resolve('retry')}>确认风险并重新投递</Button>
        </>}
        <Button onClick={() => setSelected(null)}>返回</Button>
      </DialogActions>
    </DialogBody></DialogSurface></Dialog>
  </section>
}

export function TenantAlertTimeline({ tenantId }: { tenantId: string }) {
  const [items, setItems] = useState<AlertEvent[]>([])
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    getTenantAlerts(tenantId, controller.signal).then((data) => { setItems(data.items); setError('') })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(usageError(reason)) })
    return () => controller.abort()
  }, [tenantId, revision])
  return <section className="panel mail-timeline" aria-label="租户告警时间线">
    <div className="panel-header"><div><h2>告警时间线</h2><p>事件已生成不等于邮件已送达；关闭通知期间也会保留事件。</p></div><Button onClick={() => setRevision((n) => n + 1)}>刷新告警</Button></div>
    <div className="mail-panel-body">
      {error && <div className="message error" role="alert">{error}</div>}
      {!items.length ? <p>暂无告警事件。</p> : <ol>{items.map((event) => <li key={event.id}>
        <strong>{kindNames[event.kind]}{event.repricedAtUtc ? ' · 历史小时补算' : ''}</strong> · {usageDate(event.occurredAtUtc)}
        <p>{usageMoneyRange(event.amountUsd, event.amountUpperUsd)} · 数据状态 {event.dataStatus}</p>
        {event.issues.slice(0, 3).map((issue, index) => <small key={`${issue.code}-${index}`}>{issue.code}：{issue.message}<br /></small>)}
      </li>)}</ol>}
      <Link to="/operations">查看实际投递状态</Link>
    </div>
  </section>
}
