// Follow the supplied Acrobat workflow: White spot mask underneath the
// original artwork, with the artwork on a CMYK-named layer set to overprint.
// The CMYK layer name does not convert or re-encode the artwork's images.
import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFRef, PDFArray, PDFString, StandardFonts, rgb } from 'pdf-lib';
import pako from 'pako';
import { profileGray } from './maskColorProfile.mjs';

export const SPOT_NAME = 'White';

export async function browserDecodePixels(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const { width, height } = bitmap;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas unavailable while preparing print colors.');
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
      data[j++] = rgba[i]; data[j++] = rgba[i + 1]; data[j++] = rgba[i + 2];
    }
    return { data, width, height, components: 3 };
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

function filters(dict) {
  const value = dict.lookup(PDFName.of('Filter'));
  return value instanceof PDFArray ? value.asArray().map(n => n.toString()) : value ? [value.toString()] : [];
}

async function imagePixels(stream, decodePixels) {
  const d = stream.dict;
  const width = d.lookup(PDFName.of('Width')).asNumber();
  const height = d.lookup(PDFName.of('Height')).asNumber();
  const color = d.lookup(PDFName.of('ColorSpace'))?.toString();
  const components = color === '/DeviceRGB' ? 3 : color === '/DeviceGray' ? 1 : 0;
  if (!components || d.lookup(PDFName.of('BitsPerComponent'))?.asNumber() !== 8) {
    throw new Error(`Unsupported print image color space: ${color}`);
  }
  if (d.has(PDFName.of('SMask')) || d.has(PDFName.of('Mask')) || d.has(PDFName.of('Decode'))) {
    throw new Error('Print images must be flattened before combining.');
  }
  const names = filters(d);
  let result;
  if (names.length === 1 && names[0] === '/DCTDecode') {
    result = await decodePixels(stream.contents);
  } else {
    const parms = d.lookup(PDFName.of('DecodeParms'));
    if (parms && (!(parms instanceof PDFDict) || (parms.lookup(PDFName.of('Predictor'))?.asNumber() || 1) !== 1)) {
      throw new Error('Unsupported print image predictor.');
    }
    if (names.length > 1 || (names.length && names[0] !== '/FlateDecode')) {
      throw new Error(`Unsupported print image filter: ${names.join(', ')}`);
    }
    result = { data: names.length ? pako.inflate(stream.contents) : stream.contents, width, height, components };
  }
  if (result.width !== width || result.height !== height || ![1, 3].includes(result.components)
    || result.data.length !== width * height * result.components) throw new Error('Invalid print image dimensions.');
  // Browser JPEG decoders expand a DeviceGray image to RGB. Preserve its
  // original profile semantics instead of treating it as Adobe RGB.
  if (components === 1 && result.components === 3) {
    result = { ...result, components: 1, data: Uint8Array.from({ length: width * height }, (_, i) => result.data[i * 3]) };
  }
  return result;
}

export function pixelsToGray({ data, components }, gamma) {
  if (![1, 3].includes(components) || data.length % components) throw new Error('Invalid mask pixels.');
  if (gamma !== undefined && (!Number.isFinite(gamma) || gamma <= 0)) throw new Error('Mask gamma must be a positive number.');
  const gray = new Uint8Array(data.length / components);
  // Explicit gamma remains available for old callers, but production defaults
  // to the supplied Adobe RGB -> Dot Gain 15% preflight profile conversion.
  const legacy = gamma === undefined ? null
    : Uint8Array.from({ length: 256 }, (_, value) => Math.round(255 * (value / 255) ** gamma));
  for (let i = 0, j = 0; j < gray.length; i += components, j++) {
    if (legacy) {
      const value = components === 1 ? data[i]
        : Math.round((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
      gray[j] = legacy[value];
    } else {
      // Untagged DeviceGray is assigned the destination Dot Gain profile by
      // the fixup; it must not receive a second RGB tone conversion.
      gray[j] = components === 1 ? data[i] : profileGray(data[i], data[i + 1], data[i + 2]);
    }
  }
  return gray;
}

function sameBox(left, right) {
  // Acrobat and jsPDF can serialize the same box with different rounding.
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) < 0.000001);
}

function imageJobs(document) {
  const jobs = [];
  for (const page of document.getPages()) {
    const xobjs = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjs) continue;
    for (const [name, ref] of xobjs.entries()) {
      const stream = document.context.lookup(ref);
      if (ref instanceof PDFRef && stream instanceof PDFRawStream
        && stream.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') jobs.push({ xobjs, name, ref, stream });
    }
  }
  return jobs;
}

async function buildIridesseDocuments(artBytes, maskBytes, opts = {}) {
  const { gamma, decodePixels = browserDecodePixels, onProgress } = opts;
  if (gamma !== undefined && (!Number.isFinite(gamma) || gamma <= 0)) throw new Error('Mask gamma must be a positive number.');
  const art = await PDFDocument.load(artBytes);
  const mask = await PDFDocument.load(maskBytes);
  const artPages = art.getPages(), maskPages = mask.getPages();
  if (!artPages.length || artPages.length !== maskPages.length) throw new Error('Art and mask page counts do not match.');
  artPages.forEach((page, i) => {
    const other = maskPages[i];
    if (!sameBox(page.getMediaBox(), other.getMediaBox())
      || !sameBox(page.getCropBox(), other.getCropBox())
      || page.getRotation().angle !== other.getRotation().angle) {
      throw new Error(`Art and mask page ${i + 1} have different sizes or rotation.`);
    }
  });

  const mctx = mask.context, actx = art.context;
  const tint = mctx.register(mctx.obj({
    FunctionType: 2, Domain: [0, 1], N: 1,
    C0: [0, 0, 0, 0], C1: [1, 0, 0, 0], Range: [0, 1, 0, 1, 0, 1, 0, 1],
  }));
  const separation = mctx.register(mctx.obj(['Separation', SPOT_NAME, 'DeviceCMYK', tint]));
  const maskJobs = imageJobs(mask);
  const converted = new Map();
  let done = 0;
  for (const { xobjs, name, ref, stream } of maskJobs) {
    let replacement = converted.get(ref.toString());
    if (!replacement) {
      const pixels = await imagePixels(stream, decodePixels);
      replacement = mctx.register(mctx.flateStream(pixelsToGray(pixels, gamma), {
        Type: 'XObject', Subtype: 'Image', Width: pixels.width, Height: pixels.height,
        BitsPerComponent: 8, ColorSpace: separation, Decode: [1, 0],
      }));
      converted.set(ref.toString(), replacement);
    }
    xobjs.set(name, replacement);
    onProgress?.(++done, maskJobs.length);
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  const embedded = await art.embedPages(maskPages);
  const layer = name => actx.register(actx.obj({ Type: 'OCG', Name: PDFString.of(name), Intent: ['View', 'Design'] }));
  const cmykLayer = layer('CMYK'), spotLayer = layer(SPOT_NAME);
  const overprint = actx.register(actx.obj({ Type: 'ExtGState', op: true, OP: true, OPM: 1 }));
  artPages.forEach((page, i) => {
    page.node.normalize();
    // jsPDF shares one resource dictionary across all pages. Each page needs
    // its own mask form reference, or the last (often blank) back replaces it.
    const resources = page.node.Resources().clone(actx);
    page.node.set(PDFName.of('Resources'), resources);
    const sub = name => {
      const previous = resources.lookupMaybe(PDFName.of(name), PDFDict);
      const dict = previous ? previous.clone(actx) : actx.obj({});
      resources.set(PDFName.of(name), dict);
      return dict;
    };
    sub('XObject').set(PDFName.of('FoilMask'), embedded[i].ref);
    sub('Properties').set(PDFName.of('FoilSpot'), spotLayer);
    sub('Properties').set(PDFName.of('FoilArt'), cmykLayer);
    sub('ExtGState').set(PDFName.of('FoilOP'), overprint);
    page.node.wrapContentStreams(
      actx.register(actx.stream('q /OC /FoilSpot BDC /FoilMask Do EMC Q\nq /OC /FoilArt BDC /FoilOP gs\n')),
      actx.register(actx.stream('\nEMC Q\n')),
    );
  });
  art.catalog.set(PDFName.of('OCProperties'), actx.obj({
    OCGs: [cmykLayer, spotLayer], D: { Order: [spotLayer, cmykLayer], ON: [cmykLayer, spotLayer], OFF: [] },
  }));
  return { art, mask };
}

export async function combineIridesse(artBytes, maskBytes, opts = {}) {
  const { art } = await buildIridesseDocuments(artBytes, maskBytes, opts);
  return art.save({ useObjectStreams: false });
}

export async function buildIridesseFiles(artBytes, maskBytes, opts = {}) {
  const { art, mask } = await buildIridesseDocuments(artBytes, maskBytes, opts);
  // Save the exact converted mask used in the combined file, preserving blank
  // backs and page geometry. No second conversion or artwork is added to it.
  const whiteMaskPdf = await mask.save({ useObjectStreams: false });
  const combinedPdf = await art.save({ useObjectStreams: false });
  const previewPdf = await buildIridessePreview(artBytes, whiteMaskPdf);
  return { combinedPdf, whiteMaskPdf, previewPdf };
}

// A screen proof only: show the actual mask over the original card artwork.
// Work on new documents so neither manufacturing PDF can be changed by this.
export async function buildIridessePreview(artBytes, whiteMaskBytes) {
  const proof = await PDFDocument.load(artBytes);
  const mask = await PDFDocument.load(whiteMaskBytes);
  const pages = proof.getPages(), masks = mask.getPages();
  if (!pages.length || pages.length !== masks.length) throw new Error('Preview art and mask page counts do not match.');
  pages.forEach((page, i) => {
    if (!sameBox(page.getMediaBox(), masks[i].getMediaBox())
      || !sameBox(page.getCropBox(), masks[i].getCropBox())
      || page.getRotation().angle !== masks[i].getRotation().angle) {
      throw new Error(`Preview art and mask page ${i + 1} have different sizes or rotation.`);
    }
  });
  const mctx = mask.context, pctx = proof.context;
  // A constant cyan palette plus the original mask as alpha keeps the pixels
  // aligned, leaves unmasked areas untouched, and avoids an RGB-sized buffer.
  const palette = Uint8Array.from({ length: 768 }, (_, i) => [0, 180, 255][i % 3]);
  const colors = mctx.obj(['Indexed', 'DeviceRGB', 255, mctx.register(mctx.stream(palette))]);
  const seen = new Set();
  for (const { ref, stream } of imageJobs(mask)) {
    if (seen.has(ref.toString())) continue;
    seen.add(ref.toString());
    const cs = stream.dict.lookup(PDFName.of('ColorSpace'));
    if (!(cs instanceof PDFArray) || cs.get(0).toString() !== '/Separation'
      || cs.get(1).toString() !== `/${SPOT_NAME}`) throw new Error('Preview requires a converted White mask.');
    const alpha = stream.dict.clone(mctx);
    alpha.set(PDFName.of('ColorSpace'), PDFName.of('DeviceGray'));
    // Black source pixels mean full ink, so invert them to full alpha.
    alpha.set(PDFName.of('Decode'), mctx.obj([1, 0]));
    stream.dict.set(PDFName.of('SMask'), mctx.register(PDFRawStream.of(alpha, stream.contents)));
    stream.dict.set(PDFName.of('ColorSpace'), colors);
    stream.dict.delete(PDFName.of('Decode'));
  }
  const embedded = await proof.embedPages(masks);
  const overlay = pctx.register(pctx.obj({ Type: 'ExtGState', ca: 0.45, CA: 0.45, BM: 'Normal', op: false, OP: false }));
  const font = await proof.embedFont(StandardFonts.Helvetica);
  pages.forEach((page, i) => {
    page.node.normalize();
    const resources = page.node.Resources().clone(pctx);
    page.node.set(PDFName.of('Resources'), resources);
    for (const [group, name, value] of [['XObject', 'MaskPreview', embedded[i].ref], ['ExtGState', 'MaskPreview', overlay]]) {
      const previous = resources.lookupMaybe(PDFName.of(group), PDFDict);
      const dict = previous ? previous.clone(pctx) : pctx.obj({});
      dict.set(PDFName.of(name), value);
      resources.set(PDFName.of(group), dict);
    }
    page.node.addContentStream(pctx.register(pctx.stream('q /MaskPreview gs /MaskPreview Do Q\n')));
    // Add a proof banner above the original sheet, without covering any cards.
    const box = page.getMediaBox(), crop = page.getCropBox();
    page.setMediaBox(box.x, box.y, box.width, box.height + 28);
    page.setCropBox(crop.x, crop.y, crop.width, crop.height + 28);
    page.drawRectangle({ x: box.x, y: box.y + box.height, width: box.width, height: 28, color: rgb(0.92, 0.97, 1) });
    const label = 'PREVIEW ONLY - NOT FOR PRINTING | Cyan overlay shows White-mask coverage';
    const size = Math.min(10, Math.max(1, (box.width - 20) / font.widthOfTextAtSize(label, 1)));
    page.drawText(label, { x: box.x + 10, y: box.y + box.height + 10, size, font, color: rgb(0.05, 0.16, 0.23) });
  });
  proof.setTitle('PREVIEW ONLY - Artwork with White-mask overlay');
  proof.setSubject('Visual mask placement proof. Use the combined and White-mask PDFs for printing.');
  return proof.save({ useObjectStreams: false });
}
