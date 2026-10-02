import { useEffect, useState } from 'react';
import { Building2, RefreshCw, ExternalLink } from 'lucide-react';
import { partnershipRequest } from '../services/partnerships';
import './PartnershipRequests.css';

const statuses = ['pending', 'approved', 'declined', 'all'];
const displayDate = value => value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) : '—';
function websiteHref(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}

function PartnershipCard({ request, onSaved }) {
  const [percentage, setPercentage] = useState(String(request.approved_percentage ?? request.proposed_percentage ?? 0));
  const [notes, setNotes] = useState(request.admin_notes || '');
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const site = websiteHref(request.website_url);

  async function decide(status) {
    if (saving) return;
    if (status === 'approved' && (percentage.trim() === '' || !Number.isFinite(Number(percentage)) || Number(percentage) < 0 || Number(percentage) > 30 || Math.abs(Number(percentage) * 100 - Math.round(Number(percentage) * 100)) > 0.000001)) {
      setError('Enter a percentage from 0 to 30 with at most two decimal places.');
      return;
    }
    setSaving(status); setError('');
    try {
      const result = await partnershipRequest({ action: 'review', id: request.id, status, approvedPercentage: Number(percentage), adminNotes: notes, expectedUpdatedAt: request.updated_at });
      onSaved(result);
    } catch (caught) { setError(caught.message); }
    finally { setSaving(''); }
  }

  return <article className="partnership-card">
    <div className="partnership-applicant">
      <div className="partnership-card-heading"><h2>{request.business_name}</h2><span className={`partnership-badge ${request.status}`}>{request.status}</span></div>
      <p>{request.full_name || 'Applicant'} · <a href={`mailto:${request.email}`}>{request.email}</a></p>
      {site ? <a className="partnership-website" href={site} target="_blank" rel="noopener noreferrer">{request.website_url} <ExternalLink size={14} /></a> : <span>{request.website_url}</span>}
      <dl className="partnership-details">
        <div><dt>Submitted (Pacific)</dt><dd>{displayDate(request.created_at)}</dd></div>
        <div><dt>Requested widget share</dt><dd>{request.proposed_percentage}%</dd></div>
        {request.status !== 'pending' && <>
          <div><dt>Reviewed (Pacific)</dt><dd>{displayDate(request.reviewed_at)}</dd></div>
          <div><dt>Reviewed by</dt><dd>{request.reviewed_by || '—'}</dd></div>
        </>}
      </dl>
      {request.audience && <div className="partnership-text"><strong>Audience / application details</strong><p>{request.audience}</p></div>}
      {request.api_blocked_at && <p className="partnership-warning">This partner is blocked. Resolve the enforcement hold in partner operations before approving.</p>}
    </div>
    <div className="partnership-review">
      {request.status === 'pending' ? <>
        <h3>Review application</h3>
        <label htmlFor={`percentage-${request.id}`}>Approved resale-widget share (%)</label>
        <input id={`percentage-${request.id}`} type="number" min="0" max="30" step="0.01" value={percentage} onChange={event => setPercentage(event.target.value)} disabled={Boolean(saving)} />
        <p className="partnership-hint">This percentage applies to the resale widget. REST API orders currently use standard checkout and customer affiliate rewards.</p>
        <label htmlFor={`notes-${request.id}`}>Review notes (included in a decline email)</label>
        <textarea id={`notes-${request.id}`} maxLength={2000} rows={3} value={notes} onChange={event => setNotes(event.target.value)} disabled={Boolean(saving)} placeholder="Optional notes about your decision" />
        <div className="partnership-actions">
          <button type="button" className="partnership-decline" disabled={Boolean(saving)} onClick={() => decide('declined')}>{saving === 'declined' ? 'Declining…' : 'Decline'}</button>
          <button type="button" className="partnership-approve" disabled={Boolean(saving) || Boolean(request.api_blocked_at)} onClick={() => decide('approved')}>{saving === 'approved' ? 'Approving…' : 'Approve'}</button>
        </div>
        {error && <p role="alert" className="partnership-error">{error}</p>}
      </> : <>
        <h3>{request.status === 'approved' ? `Approved widget share: ${request.approved_percentage ?? request.proposed_percentage}%` : 'Application declined'}</h3>
        <p className="partnership-hint">{request.status === 'approved' ? 'Approved partners can accept the manufacturing API terms and create their API keys in the partner app.' : 'The partner has not been granted API access.'}</p>
        {request.admin_notes && <div className="partnership-text"><strong>Review notes</strong><p>{request.admin_notes}</p></div>}
      </>}
    </div>
  </article>;
}

export default function PartnershipRequests() {
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState({ key: null, data: { requests: [], total: 0, pageSize: 25 }, error: '' });
  const [notice, setNotice] = useState(null);
  const key = `${status}:${page}:${revision}`;
  const loading = loaded.key !== key;
  const data = loaded.data;
  const error = loading ? '' : loaded.error;

  useEffect(() => {
    const controller = new AbortController();
    partnershipRequest({ action: 'list', status, page }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (page > lastPage) { setPage(lastPage); return; }
      setLoaded({ key, data: result, error: '' });
    }).catch(caught => { if (!controller.signal.aborted) setLoaded(previous => ({ ...previous, key, error: caught.message })); });
    return () => controller.abort();
  }, [status, page, key]);

  function saved(result) {
    setNotice({ sent: Boolean(result.email?.sent), text: `${result.request.business_name}: ${result.request.status}. ${result.email?.sent ? 'Decision email sent.' : 'Decision saved, but the email was not sent. Check Gmail configuration in the partner app.'}` });
    setRevision(value => value + 1);
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <section className="partnership-page">
    <header className="partnership-heading">
      <div><h1 className="page-title"><Building2 size={30} /> Partnership Requests</h1><p>Review partner applications and manage access to the manufacturing API.</p></div>
      <button type="button" className="partnership-refresh" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} /> Refresh</button>
    </header>
    <nav className="partnership-filters" aria-label="Application status">
      {statuses.map(value => <button type="button" key={value} aria-pressed={status === value} className={status === value ? 'active' : ''} onClick={() => { setStatus(value); setPage(1); }}>{value}</button>)}
    </nav>
    {notice && <div role="status" className={notice.sent ? 'partnership-success' : 'partnership-warning'}>{notice.text}</div>}
    {error ? <div role="alert" className="partnership-error">{error}</div> : loading ? <p role="status" className="partnership-empty">Loading partnership requests…</p> : <>
      <p className="partnership-count">{data.total} {status === 'all' ? '' : `${status} `}application{data.total === 1 ? '' : 's'}</p>
      {data.requests.length ? <div className="partnership-list">{data.requests.map(request => <PartnershipCard key={`${request.id}:${request.updated_at}`} request={request} onSaved={saved} />)}</div>
        : <div className="partnership-empty">No {status === 'all' ? '' : `${status} `}partnership requests.</div>}
      {pages > 1 && <div className="partnership-pagination"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Next</button></div>}
    </>}
  </section>;
}
