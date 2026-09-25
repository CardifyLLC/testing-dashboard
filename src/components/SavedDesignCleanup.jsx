import React, { useState } from 'react';
import { getAdminAuthHeaders } from '../services/supabaseClient';

export default function SavedDesignCleanup() {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState('');
  const call = async (action, cutoff) => {
    const headers = await getAdminAuthHeaders();
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cleanup-saved-designs`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, cutoff }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Cleanup failed');
    return result;
  };
  const review = async () => {
    setBusy(true); setMessage('');
    try {
      const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
      const result = await call('preview', cutoff);
      setPreview({ ...result, cutoff });
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); let deleted = 0; let images = 0;
    try {
      let remaining;
      do {
        remaining = await call('delete', preview.cutoff);
        deleted += remaining.deleted; images += remaining.imagesDeleted;
        setMessage(`${deleted} saved designs deleted; ${images} unreferenced image files removed. ${remaining.eligible} designs remaining.`);
      } while (remaining.eligible > 0 || remaining.pending > 0);
      setPreview(null);
      setMessage(`Cleanup finished. ${deleted} saved designs deleted; ${images} unreferenced image files removed.`);
    } catch (error) { setMessage(error.message); setPreview(null); }
    finally { setBusy(false); }
  };
  const button = { padding: '10px 14px', borderRadius: '8px', border: '1px solid #ef4444', background: '#7f1d1d', color: '#fff' };
  return <section style={{ padding: '16px', marginBottom: '20px', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
    <button type="button" style={button} disabled={busy} onClick={review}>{busy ? 'Cleaning / checking…' : 'Delete saved designs inactive for 14+ days'}</button>
    <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Uses the last saved date across all profiles. Designs linked to orders or purchase requests are preserved. Images still referenced elsewhere are kept.</p>
    {preview && <div role="alert">
      <p>Permanently delete {preview.eligible} saved designs last saved on or before {new Date(preview.cutoff).toLocaleString()} and their unused images? {preview.pending > 0 && `${preview.pending} previous image cleanup tasks will also be retried.`}</p>
      <p>This cannot be undone. Keep this page open until cleanup finishes.</p>
      <button type="button" style={button} disabled={busy || (!preview.eligible && !preview.pending)} onClick={remove}>Permanently delete</button>{' '}
      <button type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
