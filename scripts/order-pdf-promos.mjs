import sharp from 'sharp';
import { cardStock } from '../src/services/batcherStock.mjs';
import { ORDER_PDF_CONFIGS } from './order-pdf-document.mjs';
import { allocatePromos, promoBackSvg } from '../src/services/promoCards.mjs';
export async function addOrderPromos(client, order, cards) {
  const output = [...cards], runIds = [];
  for (const stock of ['standard', 'foil']) {
    const count = cards.filter(card => cardStock(card) === stock).length;
    if (!count) continue;
    const config = ORDER_PDF_CONFIGS[stock];
    const allocation = await allocatePromos(client, order.id, stock, count, config.gridCols * config.gridRows);
    if (!allocation.cards?.length) continue;
    const response = await fetch(allocation.backFile);
    if (!response.ok) throw new Error('Could not load promo back template');
    const bytes = await sharp(Buffer.from(await response.arrayBuffer())).png().toBuffer();
    const backData = `data:image/png;base64,${bytes.toString('base64')}`;
    for (const promo of allocation.cards) {
      const svg = await promoBackSvg(promo.code, backData);
      const back = await sharp(Buffer.from(svg)).png().toBuffer();
      output.push({ front: [promo.frontFile], back: [`data:image/png;base64,${back.toString('base64')}`], finish: stock === 'foil' ? 'foil' : 'standard', isPromo: true });
    }
    runIds.push(allocation.runId);
  }
  return { cards: output, runIds };
}
