import { useEffect, useRef, useState } from 'react';
import { FileUp, Layers, Download, CheckCircle2 } from 'lucide-react';
import { preparePdfPair, combineUploadedPdfs, MAX_FILE_BYTES } from '../services/iridessePdfTool.mjs';
import './IridessePdfCombiner.css';

function PdfUpload({ kind, title, description, file, disabled, onChange }) {
  return <label className="iridesse-upload" htmlFor={`iridesse-${kind}`}>
    <span className="iridesse-upload-title"><FileUp size={22}/>{title}</span>
    <span>{description}</span>
    <input id={`iridesse-${kind}`} type="file" accept="application/pdf,.pdf" disabled={disabled}
      onChange={event => onChange(event.target.files?.[0] || null)}/>
    <strong>{file ? file.name : 'Choose a PDF'}</strong>
    <small>{file ? (file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`) : 'Up to 150 MB'}</small>
  </label>;
}

export default function IridessePdfCombiner() {
  const [art, setArt] = useState(null), [mask, setMask] = useState(null);
  const [dpi, setDpi] = useState(1200), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [result, setResult] = useState(null);
  const controller = useRef(null), urls = useRef([]);
  const clearResult = () => { urls.current.forEach(URL.revokeObjectURL); urls.current = []; setResult(null); };
  useEffect(() => () => { controller.current?.abort(); urls.current.forEach(URL.revokeObjectURL); }, []);

  const choose = (setter, file) => {
    clearResult(); setError(''); setMessage(''); setter(null);
    if (file && (!/\.pdf$/i.test(file.name) || file.size > MAX_FILE_BYTES || !file.size)) {
      setError('Choose a non-empty PDF no larger than 150 MB.'); return;
    }
    setter(file);
  };
  const combine = async event => {
    event.preventDefault();
    if (!art || !mask || busy) return;
    clearResult(); setError(''); setBusy(true); setMessage('Checking page counts and sizes…');
    const job = new AbortController(); controller.current = job;
    try {
      const artBytes = await art.arrayBuffer(), maskBytes = await mask.arrayBuffer();
      if (job.signal.aborted) return;
      const pair = await preparePdfPair(artBytes, maskBytes, dpi);
      if (job.signal.aborted) return;
      setMessage(pair.existingWhite ? 'Preserving the existing White plate…' : 'Loading mask renderer…');
      const renderMaskTiles = pair.existingWhite ? null : (await import('../services/iridesseMaskRenderer.js')).renderMaskTiles;
      const output = await combineUploadedPdfs(pair, { renderMask: renderMaskTiles, signal: job.signal, onProgress: setMessage });
      if (job.signal.aborted) return;
      const stem = art.name.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '_') || 'artwork';
      const combinedUrl = URL.createObjectURL(new Blob([output.combinedPdf], { type: 'application/pdf' }));
      const maskUrl = URL.createObjectURL(new Blob([output.whiteMaskPdf], { type: 'application/pdf' }));
      urls.current = [combinedUrl, maskUrl];
      setResult({ combinedUrl, maskUrl, stem, pages: pair.pages });
      setMessage(`${output.pages} ${output.pages === 1 ? 'page' : 'pages'} combined. Original page sizes preserved.${output.existingWhite ? ' Existing White mask preserved without conversion.' : ''}`);
    } catch (err) {
      if (!job.signal.aborted) { setError(err.message || 'Unable to combine these PDFs.'); setMessage(''); }
    } finally {
      if (!job.signal.aborted) setBusy(false);
      if (controller.current === job) controller.current = null;
    }
  };
  const cancel = () => { controller.current?.abort(); setBusy(false); setMessage('Cancelled. Your original files are unchanged.'); };

  return <section className="iridesse-tool" aria-labelledby="iridesse-title">
    <header><p className="iridesse-eyebrow">PRINT TOOLS</p><h1 id="iridesse-title"><Layers/>Iridesse PDF Combiner</h1>
      <p>Combine your artwork and White-ink mask for posters and custom-size prints.</p></header>
    <form onSubmit={combine}>
      <div className="iridesse-upload-grid">
        <PdfUpload kind="art" title="1. Artwork PDF" description="The original colour artwork, at its final print size." file={art} disabled={busy} onChange={file => choose(setArt, file)}/>
        <PdfUpload kind="mask" title="2. Mask PDF" description="Black prints White ink. White leaves the stock exposed." file={mask} disabled={busy} onChange={file => choose(setMask, file)}/>
      </div>
      <div className="iridesse-guidance"><strong>Matching pages, aligned exactly</strong>
        <p>Both PDFs need the same page count, page sizes, rotation and crop/trim/bleed settings. Include blank mask pages for unmasked backs. Upload a black-and-white mask or an existing White spot PDF.</p></div>
      <div className="iridesse-actions"><label htmlFor="iridesse-dpi">Mask resolution
        <select id="iridesse-dpi" value={dpi} disabled={busy} onChange={event => { clearResult(); setError(''); setMessage(''); setDpi(Number(event.target.value)); }}>
          <option value={1200}>1200 DPI</option><option value={600}>600 DPI</option><option value={300}>300 DPI</option>
        </select></label>
        <button type="submit" className="iridesse-primary" disabled={busy || !art || !mask}><Layers size={18}/>{busy ? 'Combining…' : 'Combine PDFs'}</button>
        {busy && <button type="button" onClick={cancel}>Cancel</button>}
      </div>
      <p className="iridesse-note">Files stay in this browser. Artwork quality and page size are preserved. Mask DPI applies to black-and-white PDFs; existing White spot masks keep their original resolution.</p>
    </form>
    {error && <p role="alert" className="iridesse-error">{error}</p>}
    {message && <p role="status" className="iridesse-status">{message}</p>}
    {result && <div className="iridesse-result"><h2><CheckCircle2 size={22}/>Your print files are ready</h2>
      <p>The combined PDF places the White plate underneath the artwork, with artwork overprint enabled. Review the White separation in your press RIP before printing.</p>
      <div className="iridesse-downloads">
        <a href={result.combinedUrl} download={`${result.stem}-Iridesse-White.pdf`} className="iridesse-primary"><Download size={18}/>Download combined PDF</a>
        <a href={result.maskUrl} download={`${result.stem}-White-mask.pdf`}><Download size={18}/>Download White mask</a>
      </div>
      <details><summary>Page sizes</summary><ul>{result.pages.map((page, index) => <li key={index}>Page {index + 1}: {page.widthMm.toFixed(2)} × {page.heightMm.toFixed(2)} mm{page.rotation ? ` · ${page.rotation}° rotation` : ''}</li>)}</ul></details>
    </div>}
  </section>;
}
