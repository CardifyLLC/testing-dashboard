// Foil stock is 9 x 12 inches; keep its settings separate from standard stock.
export const FOIL_CONFIG = Object.freeze({
  sheetSize: 'custom', orientation: 'portrait',
  customSheetWidth: 228.6, customSheetHeight: 304.8,
  gridCols: 3, gridRows: 3,
  marginTop: 7.9, marginLeft: 10.6, gapHorizontal: 2.6, gapVertical: 6.4,
  cardWidth: 67, cardHeight: 92, targetDPI: 1200,
  showRegMarks: true, regMarkWidth: 3.3, regMarkHeight: 60,
  regMarkX: 7, regMarkY: 60.4,
  flipBackPage: true, backShiftX: 0, backShiftY: 0,
  bleedAmount: 0, safetyCrop: 0, overlayOpacity: 0.5, printCutLines: false,
});

export function cardStock(card) {
  const finish = String(card?.finish || '').toLowerCase();
  // Older orders/projects did not retain the finish, but did retain the mask.
  return card?.spotMask || finish.includes('silver') || finish.includes('foil') || finish.includes('rainbow')
    ? 'foil' : 'standard';
}

export function sheetDimensions(config) {
  const sizes = { '12x18': [304.8, 457.2], '11x17': [279.4, 431.8], letter: [215.9, 279.4], a4: [210, 297], a3: [297, 420] };
  const [width, height] = config.sheetSize === 'custom'
    ? [Number(config.customSheetWidth), Number(config.customSheetHeight)]
    : sizes[config.sheetSize] || sizes['12x18'];
  const short = Math.min(width, height), long = Math.max(width, height);
  return config.orientation === 'landscape' ? { width: long, height: short } : { width: short, height: long };
}

// Input cards already represent individual copies. Never expand their quantity again.
export function buildStockPages(cards, configs, allCards = cards) {
  const indices = new Map(allCards.map((card, index) => [card, index]));
  const customers = new Map();
  for (const card of cards) {
    const name = card.customerName?.trim() || null;
    if (!customers.has(name)) customers.set(name, []);
    customers.get(name).push({ card, index: indices.get(card), customerName: name });
  }
  const ordered = [...customers.keys()].filter(Boolean);
  if (customers.has(null)) ordered.push(null);
  const entries = ordered.flatMap(name => customers.get(name));
  const pages = [];
  for (const stock of ['standard', 'foil']) {
    const config = configs[stock];
    const perPage = Math.floor(Number(config.gridCols)) * Math.floor(Number(config.gridRows));
    if (!Number.isSafeInteger(perPage) || perPage < 1) continue;
    const stockEntries = entries.filter(entry => cardStock(entry.card) === stock);
    for (let i = 0; i < stockEntries.length; i += perPage) {
      const pageEntries = stockEntries.slice(i, i + perPage);
      pages.push({ stock, config, customerName: pageEntries[0].customerName, entries: pageEntries });
    }
  }
  return pages;
}

// Each download contains at most 20 sheets per stock. Process the art/mask pair
// sequentially so full-resolution canvases are never accumulated across stocks.
export function stockExportParts(pages, mode, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid export chunk size.');
  const groups = ['standard', 'foil'].map(stock => ({
    stock, pages: pages.filter(page => page.stock === stock),
  })).filter(group => group.pages.length && (mode !== 'mask' || group.stock === 'foil'));
  const count = Math.max(0, ...groups.map(group => Math.ceil(group.pages.length / limit)));
  return Array.from({ length: count }, (_, index) => groups.map(group => ({
    stock: group.stock, pages: group.pages.slice(index * limit, (index + 1) * limit),
  })).filter(group => group.pages.length));
}
