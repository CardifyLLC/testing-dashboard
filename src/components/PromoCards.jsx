import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';
import { renderPromoBack } from '../services/promoCards.mjs';
import './PromoCards.css';

export default function PromoCards() {
  const [settings, setSettings] = useState(null), [report, setReport] = useState({ designs: [] });
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState(null), [name, setName] = useState(''), [weight, setWeight] = useState(1);
  const [orderId, setOrderId] = useState(''), [stock, setStock] = useState('standard'), [backPreview, setBackPreview] = useState('');
  async function load() {
    const [s, r] = await Promise.all([supabase.from('promo_settings').select('*').single(), supabase.rpc('promo_report')]);
    if (s.error || r.error) throw s.error || r.error;
    setSettings(s.data); setReport(r.data);
  }
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  useEffect(() => () => { if (upload?.url) URL.revokeObjectURL(upload.url); }, [upload]);
  async function action(fn) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); await load(); } catch (e) { setError(e.message || String(e)); } finally { setBusy(false); }
  }
  async function choose(file, back = false) {
    if (!file) return;
    setError('');
    let url;
    try {
      if (!['image/png','image/jpeg'].includes(file.type) || file.size > 20000000) throw new Error('Use a PNG or JPEG under 20 MB.');
      url = URL.createObjectURL(file);
      const img = new Image(); img.src = url; await img.decode();
      if (img.naturalWidth !== settings.artwork_width || img.naturalHeight !== settings.artwork_height) throw new Error(`Artwork must be exactly ${settings.artwork_width} × ${settings.artwork_height} pixels.`);
      setUpload({ file, url, back });
      if (back) setBackPreview(await renderPromoBack('ABCDEFGHJKM2', url));
    } catch(e) { if (url) URL.revokeObjectURL(url); setError(e.message); }
  }
  async function saveArtwork() {
    if (!upload) return;
    const file = upload.file, path = `${crypto.randomUUID()}.${file.type === 'image/png' ? 'png' : 'jpg'}`;
    const result = await supabase.storage.from('promo-artwork').upload(path, file, { contentType: file.type, upsert: false });
    if (result.error) throw result.error;
    const url = supabase.storage.from('promo-artwork').getPublicUrl(path).data.publicUrl;
    let previewUrl = url;
    if (!upload.back) {
      const image = new Image(); image.src=upload.url; await image.decode();
      const canvas=document.createElement('canvas'); canvas.width=220; canvas.height=Math.round(220*image.naturalHeight/image.naturalWidth);
      const context=canvas.getContext('2d'); context.fillStyle='white'; context.fillRect(0,0,canvas.width,canvas.height); context.drawImage(image,0,0,canvas.width,canvas.height);
      const thumbnail=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
      if(!thumbnail) throw new Error('Could not create artwork preview.');
      const previewPath=`preview-${crypto.randomUUID()}.jpg`;
      const preview=await supabase.storage.from('promo-artwork').upload(previewPath,thumbnail,{contentType:'image/jpeg',upsert:false});
      if(preview.error) throw preview.error;
      previewUrl=supabase.storage.from('promo-artwork').getPublicUrl(previewPath).data.publicUrl;
    }
    const { data: { user } } = await supabase.auth.getUser();
    const saved = upload.back
      ? await supabase.from('promo_settings').update({ back_file: url }).eq('id', true)
      : await supabase.from('promo_designs').insert({ name: name.trim(), weight: Number(weight), front_file: url, preview_file: previewUrl, status: 'active', created_by: user.id });
    if (saved.error) throw saved.error;
    setUpload(null); setName(''); setNotice('Artwork saved. Existing print runs keep their original artwork.');
  }
  if (!settings) return <section className="promo-panel"><h2>Promo Cards</h2><p role="alert">{error || 'Loading…'}</p></section>;
  return <section className="promo-panel">
    <h2>Promo Cards</h2><p>Fill spare sheet slots with a free standard print to share.</p>
    {error && <p role="alert" className="promo-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={busy}><legend>Settings</legend>
      <div className="promo-settings">
        {[['enabled','Promo cards on'],['include_credit_orders','Include orders paid with credits'],['require_verified_email','Require verified email']].map(([key,label]) => <label key={key}><input type="checkbox" checked={settings[key]} onChange={e => setSettings({ ...settings, [key]: e.target.checked })}/>{label}</label>)}
        <label>Claim limit<select value={settings.claim_limit} onChange={e => setSettings({ ...settings, claim_limit: e.target.value })}><option value="ever">Once per account, ever</option><option value="monthly">Once per calendar month (UTC)</option></select></label>
        <label>Expiry after export (months)
          <input type="number" min="1" max="120" step="1" placeholder="No expiry" value={settings.expiry_months ?? ''}
            onChange={e => setSettings({ ...settings, expiry_months: e.target.value === '' ? null : Number(e.target.value) })}/>
          <small>Leave blank for no expiry. Applies when a sheet is first exported.</small>
        </label>
        {[['standard_capacity','Standard sheet capacity'],['foil_capacity','Foil sheet capacity'],['artwork_width','Artwork width (pixels)'],['artwork_height','Artwork height (pixels)']].map(([key,label]) => <label key={key}>{label}<input type="number" min="1" required value={settings[key]} onChange={e => setSettings({ ...settings, [key]: Number(e.target.value) })}/></label>)}
      </div>
      <p>Capacity must match the printer grid. Confirm bleed dimensions with the Professor before uploading.</p>
      <button onClick={() => action(async () => {
        const months = settings.expiry_months;
        if (months != null && (!Number.isInteger(months) || months < 1 || months > 120)) throw new Error('Use 1–120 months or leave expiry blank.');
        if (settings.enabled && !settings.back_file) throw new Error('Upload the shared back before enabling promos.');
        const { error } = await supabase.from('promo_settings').update(settings).eq('id', true);
        if (error) throw error;
        setNotice('Settings saved.');
      })}>Save settings</button>
    </fieldset>
    <fieldset disabled={busy}><legend>Upload artwork</legend>
      <label>Front design<input type="file" accept="image/png,image/jpeg" onChange={e => choose(e.target.files[0])}/></label>
      <label>Shared back with logo<input type="file" accept="image/png,image/jpeg" onChange={e => choose(e.target.files[0], true)}/></label>
      <p>The shared back gets a fixed white QR zone, URL and terms. Use the preview to check that these do not cover your logo.</p>
      {upload && <div><div className="promo-art-preview"><img src={upload.back ? backPreview || upload.url : upload.url} alt="Print artwork preview"/><div className="promo-trim"/><div className="promo-safe"/></div><p>Red: trim. Green: safe zone (⅛ inch inside trim). Preview guides are not printed.</p>
        {!upload.back && <><label>Design name<input maxLength="120" value={name} onChange={e => setName(e.target.value)}/></label><label>Weight<input type="number" min="1" max="10000" value={weight} onChange={e => setWeight(e.target.value)}/></label></>}
        <button disabled={!upload.back && (!name.trim() || Number(weight)<1)} onClick={() => action(saveArtwork)}>Approve preview and {upload.back ? 'save back' : 'activate design'}</button>
      </div>}
    </fieldset>
    <h3>Design performance</h3><p>{report.ordersUsingCredits || 0} orders have used promo credits. Printed counts represent completed PDF exports; verify physical production separately.</p>
    <div className="promo-table"><table><thead><tr>{['Design','Weight','Printed','Activated','Claimed','Claim rate','Sign-ups','Status'].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>
      {report.designs.map(d => <tr key={d.id}><td><img src={d.preview_file} alt="" width="52"/>{d.name}</td><td><input aria-label={`Weight for ${d.name}`} type="number" min="1" max="10000" defaultValue={d.weight} onBlur={e => { const value=Number(e.target.value); if (value!==d.weight) action(async () => { const { error } = await supabase.from('promo_designs').update({ weight:value }).eq('id',d.id); if(error) throw error; }); }}/></td><td>{d.printed}</td><td>{d.activated}</td><td>{d.claimed}</td><td>{d.printed ? (d.claimed/d.printed*100).toFixed(1) : '0'}%</td><td>{d.signups}</td><td><button disabled={busy} onClick={() => action(async () => { const {error}=await supabase.from('promo_designs').update({status:d.status==='active'?'retired':'active'}).eq('id',d.id); if(error)throw error; })}>{d.status === 'active' ? 'Retire' : 'Activate'}</button></td></tr>)}
    </tbody></table></div>
    <fieldset disabled={busy}><legend>Replace a printed sheet</legend><p>A replacement creates new codes for this stock group. Cards already exported keep their codes. Regenerate the full order before printing the replacement.</p>
      <label>Order ID<input value={orderId} onChange={e=>setOrderId(e.target.value)} placeholder="Order UUID"/></label><label>Stock<select value={stock} onChange={e=>setStock(e.target.value)}><option value="standard">Standard</option><option value="foil">Foil</option></select></label>
      <button onClick={() => { if(window.confirm('Replace this promo run and invalidate its cached PDFs? Previously exported cards will still work.')) action(async () => { const {error}=await supabase.rpc('replace_promo_run',{p_order:orderId.trim(),p_group:stock}); if(error)throw error; setNotice('Replacement requested. Regenerate the order PDFs to export the new codes.'); }); }}>Replace promo run</button>
    </fieldset>
  </section>;
}
