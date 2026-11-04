import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { buildOrderPdfParts, cardsFromOrder, generateOrderPdf, prepareOrderImage } from './order-pdf-document.mjs';

const card = (finish = 'standard', id = finish) => ({ frontUrl: `https://images.example/${id}/front.png`, backUrl: `https://images.example/${id}/back.png`, finish });
const normalize = order => cardsFromOrder(order, 'https://storage.example');
const pt = mm => mm * 72 / 25.4;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} should equal ${expected}`);
const contents = page => {
  const streams = page.node.Contents();
  return Array.from({ length: streams.size() }, (_, i) => Buffer.from(decodePDFRawStream(streams.lookup(i)).decode()).toString()).join('\n');
};
const blocks = page => [...contents(page).matchAll(/(?:^|\n)q\n([\s\S]*?)\nQ/g)].map(match => match[1]);
const imageBlocks = page => blocks(page).filter(block => /\sDo\n?$/.test(block));
const transforms = block => [...block.matchAll(/^(.+) cm$/gm)].map(match => match[1].split(' ').map(Number));

test('mixed order retains finish even for identical art, and expands quantities once', () => {
  const cards = normalize({ deck_quantity: 2, card_data: [
    { ...card('standard', 'same'), quantity: 2 },
    { ...card('silver', 'same'), quantity: 3, silverMask: 'order-images/test/mask.png' },
  ] });
  const parts = buildOrderPdfParts(cards);
  assert.equal(cards.length, 10);
  assert.deepEqual(parts.map(part => [part.stock, part.cards.length, part.processedBefore, part.filename]), [
    ['standard', 4, 0, 'standard.pdf'], ['foil', 6, 4, 'foil.pdf'],
  ]);
  assert.ok(parts[1].cards.every(item => item.spotMask.endsWith('/test/mask.png')));
});

test('all supported finishes use the same stock classification as BatcherPRO', () => {
  const cards = normalize({ card_data: ['standard', 'gloss', 'rainbow', 'silver', 'silver-gloss', 'silver-rainbow'].map(finish => card(finish)) });
  const parts = buildOrderPdfParts(cards);
  assert.deepEqual(parts[0].cards.map(item => item.finish), ['standard', 'gloss']);
  assert.deepEqual(parts[1].cards.map(item => item.finish), ['rainbow', 'silver', 'silver-gloss', 'silver-rainbow']);
  // Foil stock is retained even when an old order is missing its mask.
  assert.equal(parts[1].cards[1].spotMask, null);
});

test('JSON data and Pro Mode preserve original front/back preference and legacy masks', () => {
  const cards = normalize({ metadata: JSON.stringify({ pro_mode: true, deckQuantity: 2 }), card_data: JSON.stringify([
    { ...card(undefined), finish: undefined, originalFront: 'original/front.png', originalBackUrl: 'https://original.example/back.png', spotMask: 'legacy/mask.png' },
  ]) });
  assert.equal(cards.length, 2);
  assert.match(cards[0].front[0], /authenticated\/order-images\/original\/front.png$/);
  assert.equal(cards[0].back[0], 'https://original.example/back.png');
  assert.equal(buildOrderPdfParts(cards)[0].stock, 'foil');
});

test('legacy uploads keep masks attached to their own card, including a missing back', () => {
  const cards = normalize({ card_images: [
    'a/front.png', 'a/back.png', '',
    'b/front.png', 'b/back.png', 'b/mask.png',
    'c/front.png', '', 'c/mask.png',
    'd/front.png', '', '',
  ] });
  assert.equal(cards.length, 4);
  const parts = buildOrderPdfParts(cards);
  assert.deepEqual(parts.map(part => part.cards.map(item => item.front[0].split('/').at(-2))), [['a', 'd'], ['b', 'c']]);
  assert.equal(parts[1].cards[1].back.length, 0);
});

test('large mixed orders split within each stock with accurate progress offsets', () => {
  const cards = normalize({ card_data: [{ ...card(), quantity: 325 }, { ...card('silver'), quantity: 163 }] });
  assert.deepEqual(buildOrderPdfParts(cards).map(part => [part.filename, part.cards.length, part.processedBefore]), [
    ['standard-part-1-of-2.pdf', 324, 0], ['standard-part-2-of-2.pdf', 1, 324],
    ['foil-part-1-of-2.pdf', 162, 325], ['foil-part-2-of-2.pdf', 1, 487],
  ]);
  assert.deepEqual(buildOrderPdfParts([]), []);
  assert.throws(() => buildOrderPdfParts(cards, 0), /sheet limit/);
});

const jpeg = await prepareOrderImage(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#4080c0' } }).png().toBuffer());

test('card rasters retain 1200 DPI at the physical card size', async () => {
  const info = await sharp(jpeg).metadata();
  assert.equal(info.format, 'jpeg');
  assert.equal(info.width, Math.ceil(67 / 25.4 * 1200));
  assert.equal(info.height, Math.ceil(92 / 25.4 * 1200));
});

for (const [stock, finish, width, cols, left, top] of [
  ['standard', 'standard', 457.2, 6, 9.7, 15.5],
  ['foil', 'silver', 228.6, 3, 10.6, 7.9],
]) {
  test(`${stock} PDF has exact dimensions, 3 rows, paired backs, and registration marks`, async () => {
    const count = cols * 3;
    const normalized = normalize({ card_data: Array.from({ length: count }, (_, i) => card(finish, `${stock}-${i}`)) });
    const fetched = [], progress = [];
    const bytes = await generateOrderPdf({ customer_name: 'Layout Test' }, buildOrderPdfParts(normalized)[0], async urls => { fetched.push(urls[0]); return jpeg; }, value => progress.push(value));
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), 2);
    for (const [side, page] of pdf.getPages().entries()) {
      close(page.getWidth(), pt(width)); close(page.getHeight(), pt(304.8));
      const placements = imageBlocks(page);
      assert.equal(placements.length, count);
      placements.forEach((block, i) => {
        const [translate, rotate, scale] = transforms(block);
        const x = left + (i % cols) * (67 + 2.45);
        const yTop = top + Math.floor(i / cols) * 98.4;
        close(translate[4], pt(x + (side ? 67 : 0)));
        close(translate[5], pt(side ? yTop + 92 : 304.8 - yTop - 92));
        close(rotate[0], side ? -1 : 1); close(rotate[3], side ? -1 : 1);
        close(scale[0], pt(67)); close(scale[3], pt(92));
      });
      const rectangles = blocks(page).filter(block => !block.includes(' Do') && !block.includes('BT'));
      assert.equal(rectangles.length, stock === 'foil' ? 1 : count + 1, 'foil has only the bar, with no cut outlines');
      const bar = rectangles[0], [translate] = transforms(bar);
      close(translate[4], pt(7)); close(translate[5], pt(side ? 60.4 : 184.4));
      const lines = [...bar.matchAll(/^([^\n]+) l$/gm)].map(match => match[1].split(' ').map(Number));
      assert.ok(lines.some(([x, y]) => Math.abs(x - pt(3.3)) < 1e-5 && Math.abs(y - pt(60)) < 1e-5));
    }
    assert.deepEqual(fetched.slice(0, count), normalized.map(item => item.front[0]));
    assert.deepEqual(fetched.slice(count), normalized.map(item => item.back[0]));
    assert.equal(progress.at(-1), count);
    const image = pdf.getPage(0).node.Resources().lookup(PDFName.of('XObject')).values()[0];
    const embedded = pdf.context.lookup(image);
    assert.equal(embedded.dict.lookup(PDFName.of('Width')).asNumber(), 3166);
    assert.equal(embedded.dict.lookup(PDFName.of('Height')).asNumber(), 4347);
  });
}

test('foil pagination starts a new sheet after 9 cards; missing backs keep their positions', async () => {
  const cards = normalize({ card_data: Array.from({ length: 10 }, (_, i) => ({ ...card('silver', `${i}`), backUrl: i === 0 || i === 9 ? '' : card('silver', `${i}`).backUrl })) });
  const pdf = await PDFDocument.load(await generateOrderPdf({}, buildOrderPdfParts(cards)[0], async () => jpeg));
  assert.equal(pdf.getPageCount(), 3);
  assert.deepEqual(pdf.getPages().map(page => imageBlocks(page).length), [9, 8, 1]);
  const back = transforms(imageBlocks(pdf.getPage(1))[0])[0];
  close(back[4], pt(10.6 + 67 + 2.45 + 67));
  close(back[5], pt(7.9 + 92));
});

test('renderer refuses mixed stocks instead of silently using one layout', async () => {
  await assert.rejects(generateOrderPdf({}, { stock: 'standard', cards: normalize({ card_data: [card(), card('silver')] }) }, async () => jpeg), /exactly one stock/);
});
