import QRCode from 'qrcode/lib/browser.js';

export function promoSlots(count, capacity) {
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid promo sheet size');
  return (capacity - count % capacity) % capacity;
}
export async function allocatePromos(client, orderId, stock, count, capacity) {
  promoSlots(count, capacity); // Validate before requesting a persistent allocation.
  const { data, error } = await client.rpc('allocate_promo_run', { p_order: orderId, p_group: stock, p_count: count, p_capacity: capacity });
  if (error) throw error;
  if (data.warning) console.warn(data.warning);
  return data;
}
export async function markPromosPrinted(client, runId) {
  if (!runId) return;
  const { error } = await client.rpc('mark_promo_printed', { p_run: runId });
  if (error) throw error;
}
export async function promoBackSvg(code, backDataUrl) {
  if (!/^[A-HJKMNP-Z2-9]{12}$/.test(code)) throw new Error('Invalid promo code');
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(backDataUrl)) throw new Error('Invalid back template');
  const qr = await QRCode.toString(`HTTPS://TCGPLAYTEST.COM/R/${code}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  const positioned = qr.replace('<svg ', '<svg x="242" y="440" width="340" height="340" ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="825" height="1125" viewBox="0 0 825 1125"><image href="${backDataUrl}" width="825" height="1125"/><rect x="190" y="410" width="445" height="550" rx="20" fill="white"/>${positioned}<g fill="black" font-family="Arial,sans-serif" text-anchor="middle"><text x="412" y="823" font-size="30" font-weight="bold">TCGPLAYTEST.COM</text><text x="412" y="870" font-size="23">Must have an account to redeem.</text><text x="412" y="905" font-size="23">S&amp;H still applies.</text><text x="412" y="938" font-size="21">One free standard card.</text></g></svg>`;
}
export async function renderPromoBack(code, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load promo back');
  const dataUrl = await new Promise((resolve, reject) => { response.blob().then(blob => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); }).catch(reject); });
  const svg = await promoBackSvg(code, dataUrl);
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image(); img.src = objectUrl; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1650; canvas.height = 2250;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(objectUrl); }
}
// Share rendered QR backs between the preview and export, without caching allocations.
// Allocations are always rechecked so replacement runs and eligibility stay current.
export function createPromoBackRenderer(renderBack = renderPromoBack, limit = 64) {
  const cache = new Map();
  return (code, url) => {
    const key = JSON.stringify([code, url]);
    if (cache.has(key)) return cache.get(key);
    const pending = Promise.resolve().then(() => renderBack(code, url));
    cache.set(key, pending);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    return pending;
  };
}

export async function addPromosToPages(client, pages, { renderBack = renderPromoBack, onWarning, signal } = {}) {
  signal?.throwIfAborted();
  const mask = document.createElement('canvas'); mask.width=16; mask.height=16;
  const maskContext=mask.getContext('2d'); maskContext.fillStyle='black'; maskContext.fillRect(0,0,16,16);
  const opaqueMask=mask.toDataURL('image/png');
  const result = pages.map(page => ({ ...page, promoRunId: undefined, entries: page.entries.filter(e => !e.card.isPromo) }));
  const groups = new Map();
  for (const page of result) {
    const ids = [...new Set(page.entries.map(e => e.card.orderId).filter(Boolean))];
    if (ids.length !== 1 || page.entries.some(e => !e.card.orderId || e.card.partnerOrderId)) continue;
    const key = `${ids[0]}:${page.stock}`;
    if (!groups.has(key)) groups.set(key, { orderId: ids[0], stock: page.stock, count: 0, pages: [] });
    const group = groups.get(key); group.count += page.entries.length; group.pages.push(page);
  }
  for (const group of groups.values()) {
    signal?.throwIfAborted();
    const last = group.pages.at(-1), capacity = last.config.gridCols * last.config.gridRows;
    const allocation = await allocatePromos(client, group.orderId, group.stock, group.count, capacity);
    signal?.throwIfAborted();
    if (allocation.warning) onWarning?.(allocation.warning);
    if (!allocation.cards?.length) continue;
    if (last.entries.length + allocation.cards.length !== capacity) throw new Error('Promo layout mismatch. Export the complete order.');
    last.promoRunId = allocation.runId;
    for (const promo of allocation.cards) {
      signal?.throwIfAborted();
      const customBack = await renderBack(promo.code, allocation.backFile);
      signal?.throwIfAborted();
      last.entries.push({ index: -1, customerName: last.customerName, card: {
      id: promo.id, isPromo: true, url: promo.frontFile, customBack,
      orderId: group.orderId, customerName: last.customerName, finish: group.stock === 'foil' ? 'foil' : 'standard',
      ...(group.stock === 'foil' ? {spotMask:opaqueMask} : {}),
      } });
    }
  }
  return result;
}
