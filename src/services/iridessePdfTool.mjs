import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFString, PDFObjectCopier, decodePDFRawStream, degrees } from 'pdf-lib';

const name = value => PDFName.of(value);
const BOXES = ['MediaBox', 'CropBox', 'TrimBox', 'BleedBox', 'ArtBox'];
export const MASK_DPI = [300, 600, 1200];
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_PAGE_PIXELS = 800_000_000;
const MAX_JOB_PIXELS = 2_000_000_000;

export function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
}

function geometry(page) {
  const unit = page.node.lookup(name('UserUnit'))?.asNumber() || 1;
  const boxes = Object.fromEntries(BOXES.map(box => [box, page[`get${box}`]() ]));
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (!Number.isFinite(unit) || unit <= 0 || ![0, 90, 180, 270].includes(rotation)
      || Object.values(boxes).some(box => !Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0)) {
    throw new Error('This PDF has invalid page dimensions or rotation. Export it again before combining.');
  }
  return { boxes, unit, rotation };
}

async function readPdf(bytes, label) {
  if (!bytes?.byteLength || bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${label} PDF must be between 1 byte and 150 MB.`);
  try { return await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch { throw new Error(`${label} PDF could not be opened. Use an unlocked, valid PDF.`); }
}

function spotNames(doc) {
  const spots = new Set();
  const seen = new Set();
  const visit = value => {
    value = doc.context.lookup(value);
    if (!value || seen.has(value)) return;
    seen.add(value);
    if (value instanceof PDFArray) {
      if (value.get(0)?.toString() === '/Separation') spots.add(value.get(1)?.decodeText());
      if (value.get(0)?.toString() === '/DeviceN') {
        const channels = value.lookup(1);
        if (channels instanceof PDFArray) channels.asArray().forEach(channel => spots.add(channel.decodeText()));
      }
      value.asArray().forEach(visit);
    } else if (value instanceof PDFDict) value.values().forEach(visit);
    else if (value instanceof PDFRawStream) visit(value.dict);
  };
  doc.getPages().forEach(page => visit(page.node.Resources()));
  return [...spots].filter(channel => !['None', 'All', 'Cyan', 'Magenta', 'Yellow', 'Black'].includes(channel));
}

function pageContent(doc, page) {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const chunks = refs.map(ref => {
    const stream = doc.context.lookup(ref);
    return stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getUnencodedContents();
  });
  const data = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length + 1, 0));
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; data[offset++] = 10; }
  return data;
}

// Look at painting operations, not just a channel declared in unused resources.
function usesWhitePlate(doc) {
  const seen = new Set();
  const isWhite = (cs, resources) => {
    cs = doc.context.lookup(cs);
    if (cs instanceof PDFName) cs = resources.lookupMaybe(name('ColorSpace'), PDFDict)?.lookup(cs);
    return cs instanceof PDFArray && cs.get(0)?.toString() === '/Separation' && cs.get(1)?.decodeText() === 'White';
  };
  const inspect = (bytes, resources) => {
    if (!resources) return false;
    let text = '';
    for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
    const tokens = []; let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i])) { i++; continue; }
      if (text[i] === '%') { while (i < text.length && !/[\r\n]/.test(text[i])) i++; continue; }
      if (text[i] === '(') {
        let depth = 1; i++;
        while (i < text.length && depth) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === '(') depth++; if (text[i] === ')') depth--; i++; }
        tokens.push('string'); continue;
      }
      if (text[i] === '<' && text[i + 1] !== '<') { while (i < text.length && text[i] !== '>') i++; i++; tokens.push('string'); continue; }
      const start = i;
      if ('[]<>{}'.includes(text[i])) i++;
      else { if (text[i] === '/') i++; while (i < text.length && !/[\s()[\]<>{}/%]/.test(text[i])) i++; if (i === start) i++; }
      tokens.push(text.slice(start, i));
    }
    let fill = false, stroke = false; const stack = [];
    for (let j = 0; j < tokens.length; j++) {
      const token = tokens[j], previous = tokens[j - 1];
      const resourceName = previous?.startsWith('/') ? name(previous.slice(1).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))) : null;
      if (token === 'q') stack.push([fill, stroke]);
      if (token === 'Q') [fill, stroke] = stack.pop() || [false, false];
      if (['g', 'rg', 'k'].includes(token)) fill = false;
      if (['G', 'RG', 'K'].includes(token)) stroke = false;
      if (token === 'cs') fill = resourceName ? isWhite(resourceName, resources) : false;
      if (token === 'CS') stroke = resourceName ? isWhite(resourceName, resources) : false;
      if (fill && ['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'Tj', 'TJ', "'", '"'].includes(token)) return true;
      if (stroke && ['S', 's', 'B', 'B*', 'b', 'b*'].includes(token)) return true;
      if (token === 'Do' && resourceName) {
        const stream = resources.lookupMaybe(name('XObject'), PDFDict)?.lookup(resourceName);
        if (!(stream instanceof PDFRawStream)) continue;
        if (stream.dict.lookup(name('Subtype'))?.toString() === '/Image'
          && (isWhite(stream.dict.lookup(name('ColorSpace')), resources) || (fill && stream.dict.lookup(name('ImageMask'))?.asBoolean()))) return true;
        if (stream.dict.lookup(name('Subtype'))?.toString() === '/Form' && !seen.has(stream)) {
          seen.add(stream);
          if (inspect(decodePDFRawStream(stream).decode(), stream.dict.lookupMaybe(name('Resources'), PDFDict) || resources)) return true;
        }
      }
      if (token === 'sh' && resourceName) {
        const shading = resources.lookupMaybe(name('Shading'), PDFDict)?.lookup(resourceName);
        const dict = shading instanceof PDFRawStream ? shading.dict : shading;
        if (dict instanceof PDFDict && isWhite(dict.lookup(name('ColorSpace')), resources)) return true;
      }
    }
    return false;
  };
  return doc.getPages().some(page => inspect(pageContent(doc, page), page.node.Resources()));
}

export async function preparePdfPair(artBytes, maskBytes, dpi = 1200) {
  if (!MASK_DPI.includes(dpi)) throw new Error('Choose 300, 600 or 1200 DPI.');
  const art = await readPdf(artBytes, 'Artwork');
  const mask = await readPdf(maskBytes, 'Mask');
  const arts = art.getPages(), masks = mask.getPages();
  if (!arts.length || arts.length !== masks.length) {
    throw new Error(`Page counts must match: artwork has ${arts.length}, mask has ${masks.length}. Include blank mask pages where no White ink is needed.`);
  }
  if (spotNames(art).includes('White')) throw new Error('The artwork already contains a White channel. Upload the original artwork without its White plate to avoid doubling it.');
  const maskSpots = spotNames(mask);
  const existingWhite = maskSpots.length === 1 && maskSpots[0] === 'White';
  if (maskSpots.length && !existingWhite) throw new Error(`The mask contains unsupported spot colours (${maskSpots.join(', ')}). Use a black-and-white mask or a PDF with only a White spot channel.`);
  if (existingWhite && !usesWhitePlate(mask)) throw new Error('The mask declares White but no supported drawing operation uses it. Export a mask with active White artwork, or upload the original black-and-white mask.');
  let pixels = 0;
  const pages = arts.map((page, index) => {
    const a = geometry(page), b = geometry(masks[index]);
    if (a.rotation !== b.rotation || a.unit !== b.unit || BOXES.some(box =>
      Object.keys(a.boxes[box]).some(key => Math.abs(a.boxes[box][key] - b.boxes[box][key]) > 0.001))) {
      throw new Error(`Page ${index + 1}: artwork and mask page sizes, crop/trim/bleed boxes or rotations differ. Export both PDFs with identical page settings; nothing is resized automatically.`);
    }
    // Interactive annotations are not reliable print artwork. Require flattened input.
    for (const input of [page, masks[index]]) {
      if ((input.node.lookup(name('Annots'))?.size() || 0) > 0) throw new Error(`Page ${index + 1} contains annotations or form fields. Flatten them in your PDF exporter, then upload again.`);
    }
    const box = a.boxes.CropBox;
    const width = Math.ceil(box.width * a.unit * dpi / 72), height = Math.ceil(box.height * a.unit * dpi / 72);
    const pagePixels = width * height;
    pixels += pagePixels;
    if (!existingWhite && (!Number.isSafeInteger(pagePixels) || pagePixels > MAX_PAGE_PIXELS || pixels > MAX_JOB_PIXELS)) {
      throw new Error('This PDF is too large at the selected mask resolution. Choose a lower DPI or split it into smaller PDF pairs.');
    }
    return { ...a, width, height, widthMm: box.width * a.unit * 25.4 / 72, heightMm: box.height * a.unit * 25.4 / 72 };
  });
  return { art, mask, maskBytes, pages, dpi, existingWhite, artworkSpots: spotNames(art) };
}

function copyGeometry(page, info) {
  for (const key of BOXES) {
    const b = info.boxes[key];
    page[`set${key}`](b.x, b.y, b.width, b.height);
  }
  page.setRotation(degrees(info.rotation));
  page.node.set(name('UserUnit'), page.doc.context.obj(info.unit));
}

// Set both fill and stroke overprint for arbitrary poster artwork, including
// nested forms/patterns whose existing gs operators would override the wrapper.
function overprintArtwork(doc) {
  const visited = new Set();
  const visit = resource => {
    const resources = doc.context.lookup(resource);
    if (!(resources instanceof PDFDict) || visited.has(resources)) return;
    visited.add(resources);
    const states = resources.lookupMaybe(name('ExtGState'), PDFDict);
    for (const [, ref] of states?.entries() || []) {
      const state = doc.context.lookup(ref);
      if (!(state instanceof PDFDict)) continue;
      state.set(name('op'), doc.context.obj(true));
      state.set(name('OP'), doc.context.obj(true));
      state.set(name('OPM'), doc.context.obj(1));
    }
    for (const group of ['XObject', 'Pattern']) {
      const entries = resources.lookupMaybe(name(group), PDFDict);
      for (const [, ref] of entries?.entries() || []) {
        const object = doc.context.lookup(ref);
        const dict = object instanceof PDFRawStream ? object.dict : object;
        if (dict instanceof PDFDict) visit(dict.lookup(name('Resources')));
      }
    }
  };
  doc.getPages().forEach(page => visit(page.node.Resources()));
}

function subResources(page, key) {
  const resources = page.node.Resources();
  const current = resources.lookupMaybe(name(key), PDFDict);
  const next = current ? current.clone(page.doc.context) : page.doc.context.obj({});
  resources.set(name(key), next);
  return next;
}

function addLayers(doc) {
  const ctx = doc.context;
  const layer = label => ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(label), Intent: ['View', 'Design'] }));
  const white = layer('White'), artwork = layer('Artwork');
  // Retain the uploaded artwork's original optional-content configuration.
  let oc = doc.catalog.lookupMaybe(name('OCProperties'), PDFDict);
  if (!oc) { oc = ctx.obj({}); doc.catalog.set(name('OCProperties'), oc); }
  let groups = oc.lookupMaybe(name('OCGs'), PDFArray);
  if (!groups) { groups = ctx.obj([]); oc.set(name('OCGs'), groups); }
  groups.push(white); groups.push(artwork);
  let defaults = oc.lookupMaybe(name('D'), PDFDict);
  if (!defaults) { defaults = ctx.obj({}); oc.set(name('D'), defaults); }
  for (const key of ['ON', 'Order']) {
    let list = defaults.lookupMaybe(name(key), PDFArray);
    if (!list) { list = ctx.obj([]); defaults.set(name(key), list); }
    list.push(white); list.push(artwork);
  }
  return { white, artwork };
}

function embedWhitePages(art, mask, pages) {
  const ctx = art.context, copier = PDFObjectCopier.for(mask.context, ctx);
  const forms = mask.getPages().map((page, index) => {
    const b = pages[index].boxes.CropBox;
    const form = ctx.flateStream(pageContent(mask, page), { Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [b.x, b.y, b.x + b.width, b.y + b.height], Matrix: [1, 0, 0, 1, 0, 0],
      Resources: copier.copy(page.node.Resources() || mask.context.obj({})) });
    const group = page.node.lookup(name('Group'));
    if (group) form.dict.set(name('Group'), copier.copy(group));
    return { ref: ctx.register(form) };
  });
  // The same copier must map layer references in page resources and catalog.
  const source = mask.catalog.lookupMaybe(name('OCProperties'), PDFDict);
  const groups = source?.lookupMaybe(name('OCGs'), PDFArray);
  if (groups) {
    const target = art.catalog.lookup(name('OCProperties'), PDFDict), defaults = target.lookup(name('D'), PDFDict);
    const original = source.lookupMaybe(name('D'), PDFDict);
    const off = new Set(original?.lookupMaybe(name('OFF'), PDFArray)?.asArray().map(String) || []);
    const on = new Set(original?.lookupMaybe(name('ON'), PDFArray)?.asArray().map(String) || []);
    const baseOn = original?.lookup(name('BaseState'))?.toString() !== '/OFF';
    let targetOff = defaults.lookupMaybe(name('OFF'), PDFArray);
    if (!targetOff) { targetOff = ctx.obj([]); defaults.set(name('OFF'), targetOff); }
    for (const ref of groups.asArray()) {
      const copied = copier.copy(ref);
      target.lookup(name('OCGs'), PDFArray).push(copied);
      defaults.lookup(name('Order'), PDFArray).push(copied);
      const enabled = on.has(String(ref)) || (baseOn && !off.has(String(ref)));
      (enabled ? defaults.lookup(name('ON'), PDFArray) : targetOff).push(copied);
    }
    const usage = original?.lookupMaybe(name('AS'), PDFArray);
    if (usage) {
      let targetUsage = defaults.lookupMaybe(name('AS'), PDFArray);
      if (!targetUsage) { targetUsage = ctx.obj([]); defaults.set(name('AS'), targetUsage); }
      usage.asArray().forEach(item => targetUsage.push(copier.copy(item)));
    }
  }
  return forms;
}

// renderMask is an async iterator of bounded grayscale tiles. The artwork is
// never rendered, resized, recoloured or JPEG-recompressed.
export async function combineUploadedPdfs(pair, { renderMask, signal, onProgress } = {}) {
  const { art, pages, dpi, maskBytes, existingWhite } = pair;
  checkCancelled(signal);
  const white = existingWhite ? pair.mask : await PDFDocument.create();
  const ctx = white.context;
  const tint = ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], N: 1, C0: [0, 0, 0, 0], C1: [1, 0, 0, 0] }));
  const separation = ctx.register(ctx.obj(['Separation', 'White', 'DeviceCMYK', tint]));
  const whitePages = existingWhite ? white.getPages() : pages.map(info => {
    const page = white.addPage();
    copyGeometry(page, info);
    page.node.normalize();
    page.node.addContentStream(ctx.register(ctx.stream('')));
    return page;
  });
  let inkPixels = 0, compressedBytes = 0;
  for await (const tile of existingWhite ? [] : renderMask(maskBytes, pages, dpi, signal, onProgress)) {
    checkCancelled(signal);
    const { pageIndex, x, y, width, height, gray } = tile;
    const info = pages[pageIndex];
    if (!info || ![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0
        || x + width > info.width || y + height > info.height || gray.length !== width * height) throw new Error('Invalid rendered mask tile.');
    let marked = 0;
    for (const value of gray) if (value < 255) marked++;
    inkPixels += marked;
    if (!marked) continue;
    const page = whitePages[pageIndex], box = info.boxes.CropBox;
    const image = ctx.flateStream(gray, { Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
      BitsPerComponent: 8, ColorSpace: separation, Decode: [1, 0], Interpolate: false });
    compressedBytes += image.getContentsSize();
    if (compressedBytes > 250 * 1024 * 1024) throw new Error('The converted mask is too large for one browser export. Split the PDF or lower its mask DPI.');
    const objects = subResources(page, 'XObject');
    const key = objects.uniqueKey('WhiteTile');
    objects.set(key, ctx.register(image));
    const sx = box.width / info.width, sy = box.height / info.height;
    page.node.addContentStream(ctx.register(ctx.stream(`q ${width * sx} 0 0 ${height * sy} ${box.x + x * sx} ${box.y + box.height - (y + height) * sy} cm ${key} Do Q\n`)));
  }
  checkCancelled(signal);
  if (!existingWhite && !inkPixels) throw new Error('The mask is completely white: it would print no White ink. Use black where White ink should print.');
  onProgress?.('Combining artwork and White plate…');
  overprintArtwork(art);
  const layers = addLayers(art), actx = art.context;
  const op = actx.register(actx.obj({ Type: 'ExtGState', op: true, OP: true, OPM: 1 }));
  const embedded = existingWhite ? embedWhitePages(art, white, pages) : await art.embedPages(whitePages, pages.map(({ boxes: { CropBox: b } }) =>
    ({ left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height })), pages.map(() => [1, 0, 0, 1, 0, 0]));
  art.getPages().forEach((page, i) => {
    page.node.normalize();
    page.node.set(name('Resources'), page.node.Resources().clone(actx));
    const objects = subResources(page, 'XObject'), props = subResources(page, 'Properties'), states = subResources(page, 'ExtGState');
    const plate = objects.uniqueKey('IridesseMask'), whiteLayer = props.uniqueKey('IridesseWhite'), artLayer = props.uniqueKey('IridesseArt'), state = states.uniqueKey('IridesseOP');
    objects.set(plate, embedded[i].ref); props.set(whiteLayer, layers.white); props.set(artLayer, layers.artwork); states.set(state, op);
    page.node.wrapContentStreams(
      actx.register(actx.stream(`q /OC ${whiteLayer} BDC ${plate} Do EMC Q\nq /OC ${artLayer} BDC ${state} gs\n`)),
      actx.register(actx.stream('\nEMC Q\n')),
    );
  });
  white.setTitle('Iridesse White mask');
  checkCancelled(signal);
  const whiteMaskPdf = existingWhite ? new Uint8Array(maskBytes).slice() : await white.save({ useObjectStreams: false });
  const combinedPdf = await art.save({ useObjectStreams: false });
  checkCancelled(signal);
  return { whiteMaskPdf, combinedPdf, pages: pages.length, dpi, existingWhite };
}
