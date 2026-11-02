import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { cardStock, FOIL_CONFIG, sheetDimensions } from '../src/services/batcherStock.mjs';

export const TARGET_DPI = 1200;
export const IMAGE_QUALITY = 50;
// Retain the automatic worker's existing standard-stock layout.
export const ORDER_PDF_CONFIGS = Object.freeze({
  standard: Object.freeze({
    sheetSize: '12x18', orientation: 'landscape', gridCols: 6, gridRows: 3,
    marginTop: 15.5, marginLeft: 9.7, gapHorizontal: 2.6, gapVertical: 6.4,
    cardWidth: 67, cardHeight: 92, targetDPI: TARGET_DPI,
    showRegMarks: true, regMarkWidth: 3.3, regMarkHeight: 60,
    regMarkX: 7, regMarkY: 60.4, printCutLines: true,
  }),
  foil: FOIL_CONFIG,
});

const asArray = value => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
};
const asObject = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
};
const positiveInteger = (value, fallback = 1) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const isBackPath = value => /(?:^|[/_-])back\.(?:png|jpe?g|webp|gif|avif)$/i.test(String(value || '').split('?')[0]);
const isMaskPath = value => /(?:^|[/_-])(?:silver[-_])?mask\.(?:png|jpe?g|webp|gif|avif)$/i.test(String(value || '').split('?')[0]);

export function cardsFromOrder(order, supabaseUrl) {
  const imageCandidates = value => {
    const path = typeof value === 'string' ? value.trim() : '';
    if (!path) return [];
    if (/^(?:data:|https?:\/\/)/i.test(path)) return [path];
    const normalized = path.replace(/^\/+/, '').replace(/^order-images\//i, '')
      .replace(/^storage\/v1\/object\/(?:authenticated\/|public\/)?order-images\//i, '');
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    return [
      `${supabaseUrl}/storage/v1/object/authenticated/order-images/${encoded}`,
      `${supabaseUrl}/storage/v1/object/public/order-images/${encoded}`,
    ];
  };
  const candidates = values => [...new Set(values.flatMap(imageCandidates))];
  const metadata = asObject(order.metadata);
  const proMode = metadata.proMode === true || metadata.pro_mode === true;
  const deckQuantity = positiveInteger(order.deck_quantity ?? metadata.deckQuantity);
  const cards = [];
  const addCopies = (card, quantity = 1) => {
    for (let copy = 0; copy < quantity * deckQuantity; copy += 1) cards.push({ ...card });
  };

  for (const raw of asArray(order.card_data)) {
    const card = asObject(raw);
    const front = candidates(proMode
      ? [card.originalFrontUrl, card.originalFront, card.frontUrl, card.front]
      : [card.frontUrl, card.front, card.originalFrontUrl, card.originalFront]);
    const back = candidates(proMode
      ? [card.originalBackUrl, card.originalBack, card.backUrl, card.back]
      : [card.backUrl, card.back, card.originalBackUrl, card.originalBack]);
    if (!front.length) continue;
    const mask = candidates([card.silverMask, card.spotMask]);
    // Keep the finish and mask through pagination. Different finishes can use
    // identical artwork, so neither image URLs nor image appearance identify stock.
    addCopies({ front, back, finish: card.finish, spotMask: mask[0] || null }, positiveInteger(card.quantity));
  }
  if (cards.length) return cards;

  // Legacy uploads have front/back/mask filenames instead of structured cards.
  // Attach the mask before moving to the next front; never filter it out first.
  const images = asArray(order.card_images).filter(value => typeof value === 'string' && value.trim());
  for (let index = 0; index < images.length;) {
    const front = images[index++];
    if (isBackPath(front) || isMaskPath(front)) continue;
    const back = isBackPath(images[index]) ? images[index++] : null;
    const mask = isMaskPath(images[index]) ? images[index++] : null;
    addCopies({ front: imageCandidates(front), back: imageCandidates(back), spotMask: imageCandidates(mask)[0] || null });
  }
  return cards;
}

// At most 18 duplex sheets per file keeps headroom below the storage limit.
// Split by stock BEFORE applying that limit (324 standard or 162 foil cards).
export function buildOrderPdfParts(cards, maxSheets = 18) {
  if (!Number.isSafeInteger(maxSheets) || maxSheets < 1) throw new Error('Invalid PDF sheet limit.');
  const parts = [];
  let processedBefore = 0;
  for (const stock of ['standard', 'foil']) {
    const config = ORDER_PDF_CONFIGS[stock];
    const selected = cards.filter(card => cardStock(card) === stock);
    const capacity = config.gridCols * config.gridRows * maxSheets;
    const total = Math.ceil(selected.length / capacity);
    for (let index = 0; index < total; index += 1) {
      const partCards = selected.slice(index * capacity, (index + 1) * capacity);
      const suffix = total > 1 ? `-part-${index + 1}-of-${total}` : '';
      parts.push({ stock, cards: partCards, processedBefore, filename: `${stock}${suffix}.pdf` });
      processedBefore += partCards.length;
    }
  }
  return parts;
}

export async function prepareOrderImage(bytes) {
  return sharp(bytes)
    .resize({ width: Math.ceil(67 / 25.4 * TARGET_DPI), height: Math.ceil(92 / 25.4 * TARGET_DPI), fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: IMAGE_QUALITY })
    .toBuffer();
}

const mmToPt = value => value * 72 / 25.4;

// fetchImage is injected so rendering can be tested without storage credentials
// or side effects on the order queue. It returns the prepared 1,200 DPI JPEG.
export async function generateOrderPdf(order, part, fetchImage, onProgress = async () => {}) {
  const { stock, cards } = part;
  const config = ORDER_PDF_CONFIGS[stock];
  if (!config || !cards.length || cards.some(card => cardStock(card) !== stock)) {
    throw new Error('An order PDF must contain cards from exactly one stock.');
  }
  const dimensions = sheetDimensions(config);
  const pageWidth = mmToPt(dimensions.width), pageHeight = mmToPt(dimensions.height);
  const cardWidth = mmToPt(config.cardWidth), cardHeight = mmToPt(config.cardHeight);
  const perSheet = config.gridCols * config.gridRows;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const imageCache = new Map();
  let processed = 0;
  const embed = async urls => {
    const key = JSON.stringify(urls);
    if (!imageCache.has(key)) imageCache.set(key, await pdf.embedJpg(await fetchImage(urls)));
    return imageCache.get(key);
  };
  const drawBar = (page, isBack) => {
    if (!config.showRegMarks) return;
    page.drawRectangle({
      x: mmToPt(config.regMarkX),
      y: isBack ? mmToPt(config.regMarkY) : pageHeight - mmToPt(config.regMarkY + config.regMarkHeight),
      width: mmToPt(config.regMarkWidth), height: mmToPt(config.regMarkHeight), color: rgb(0, 0, 0),
    });
  };
  const position = index => ({
    x: mmToPt(config.marginLeft + (index % config.gridCols) * (config.cardWidth + config.gapHorizontal)),
    y: pageHeight - mmToPt(config.marginTop + config.cardHeight + Math.floor(index / config.gridCols) * (config.cardHeight + config.gapVertical)),
  });
  const drawCutLine = (page, x, y) => {
    if (config.printCutLines) page.drawRectangle({ x, y, width: cardWidth, height: cardHeight, borderWidth: 0.1, borderColor: rgb(.78, .78, .78) });
  };

  for (let offset = 0; offset < cards.length; offset += perSheet) {
    const sheet = cards.slice(offset, offset + perSheet);
    const frontPage = pdf.addPage([pageWidth, pageHeight]);
    drawBar(frontPage, false);
    frontPage.drawText(String(order.customer_name || 'Unknown Customer'), {
      x: mmToPt(config.marginLeft),
      y: pageHeight - mmToPt(Math.max(6, config.marginTop - 2)),
      size: 12, font, color: rgb(0, 0, 0),
    });
    for (let index = 0; index < sheet.length; index += 1) {
      const { x, y } = position(index);
      frontPage.drawImage(await embed(sheet[index].front), { x, y, width: cardWidth, height: cardHeight });
      drawCutLine(frontPage, x, y);
      processed += 1;
      if (processed % 6 === 0) await onProgress(processed);
    }
    if (sheet.some(card => card.back.length)) {
      const backPage = pdf.addPage([pageWidth, pageHeight]);
      drawBar(backPage, true);
      for (let index = 0; index < sheet.length; index += 1) {
        const card = sheet[index];
        if (!card.back.length) continue;
        const { x, y } = position(index);
        // Short-edge duplex: reflect the front slot vertically and rotate its
        // own back 180 degrees, leaving empty back slots in place.
        backPage.drawImage(await embed(card.back), {
          x: x + cardWidth, y: pageHeight - y, width: cardWidth, height: cardHeight, rotate: degrees(180),
        });
        drawCutLine(backPage, x, pageHeight - y - cardHeight);
      }
    }
  }
  await onProgress(cards.length);
  return pdf.save();
}
