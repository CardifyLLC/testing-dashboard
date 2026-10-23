import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, degrees } from 'pdf-lib';
import { jsPDF } from 'jspdf';
import sharp from 'sharp';
import pako from 'pako';
import { buildIridesseFiles, buildIridessePreview, combineIridesse, pixelsToGray, SPOT_NAME } from '../src/services/iridesseCombine.mjs';

const decodePixels = async bytes => {
  const { data, info } = await sharp(bytes).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, components: info.channels };
};
async function fixtures() {
  const artwork = await sharp({ create: { width: 120, height: 160, channels: 3, background: '#ff3020' } }).jpeg().toBuffer();
  const maskData = Buffer.alloc(120 * 160 * 3, 255);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 60; x++) maskData.fill(0, (y * 120 + x) * 3, (y * 120 + x) * 3 + 3);
  const mask = await sharp(maskData, { raw: { width: 120, height: 160, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  const artPdf = new jsPDF({ unit: 'mm', format: [210, 297] });
  const maskPdf = new jsPDF({ unit: 'mm', format: [210, 297] });
  // Duplex sheet then a front-only sheet. Both blank masks must retain position.
  for (let i = 0; i < 3; i++) {
    if (i) { artPdf.addPage(); maskPdf.addPage(); }
    artPdf.text(`Sheet face ${i + 1} /I0 Do`, 10, 12);
    artPdf.addImage(artwork, 'JPEG', 20, 20, 63, 88);
    if (!i) maskPdf.addImage(mask, 'JPEG', 20, 20, 63, 88);
  }
  return { art: artPdf.output('arraybuffer'), mask: maskPdf.output('arraybuffer') };
}
const input = await fixtures();

test('profile conversion agrees with independently evaluated ICC neutral ramp and colors', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/mask-profile.json', import.meta.url)));
  const converted = pixelsToGray({ components: 3, data: Uint8Array.from(fixture.rgb.flat()) });
  fixture.gray.forEach((expected, i) => {
    assert.ok(Math.abs(converted[i] - expected) <= (i < 256 ? 0 : 1), `ICC sample ${i}: ${converted[i]} vs ${expected}`);
  });
});

function reachableImages(doc, resources, result = [], seen = new Set()) {
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() || []) {
    if (seen.has(ref.toString())) continue;
    seen.add(ref.toString());
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    if (stream.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') result.push(stream);
    else reachableImages(doc, stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), result, seen);
  }
  return result;
}

test('mask midtones use the reference ICC curve and preserve already-gray masks', () => {
  const pixels = { components: 3, data: Uint8Array.from([0,0,0, 128,128,128, 255,255,255]) };
  assert.deepEqual([...pixelsToGray(pixels)], [0, 94, 255]);
  assert.deepEqual([...pixelsToGray(pixels, 1)], [0, 128, 255]);
  assert.deepEqual([...pixelsToGray({ components: 1, data: Uint8Array.from([0,128,255]) })], [0,128,255]);
  assert.throws(() => pixelsToGray(pixels, 0), /gamma/);
});

test('combined PDF has White separation, unchanged artwork, overprint, and aligned blank backs', async () => {
  const bytes = await combineIridesse(input.art, input.mask, { decodePixels });
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(SPOT_NAME, 'White');
  const groups = doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict).lookup(PDFName.of('OCGs'), PDFArray);
  assert.deepEqual(groups.asArray().map(ref => doc.context.lookup(ref).lookup(PDFName.of('Name')).decodeText()), ['CMYK', 'White']);
  const page = doc.getPages()[0];
  const resources = page.node.Resources();
  const states = resources.lookup(PDFName.of('ExtGState'), PDFDict);
  const opName = states.keys().find(name => name.toString().startsWith('/FoilImageOP'));
  const op = states.lookup(opName, PDFDict);
  assert.equal(op.lookup(PDFName.of('OP')).asBoolean(), false);
  assert.equal(op.lookup(PDFName.of('op')).asBoolean(), true);
  assert.equal(op.lookup(PDFName.of('OPM')).asNumber(), 1);
  const artContent = page.node.Contents().asArray().map(ref => {
    const stream = doc.context.lookup(ref);
    return new TextDecoder().decode(stream.dict.lookup(PDFName.of('Filter'))?.toString() === '/FlateDecode'
      ? pako.inflate(stream.contents) : stream.contents);
  }).join('\n');
  assert.match(artContent, /\(Sheet face 1 \/I0 Do\)/, 'image-like text must remain untouched');
  assert.match(artContent, /q \/FoilImageOP[^\s]* gs \/I0 Do Q/, 'only the actual image draw receives scoped overprint');
  assert.doesNotMatch(artContent, /FoilArt BDC\s+\/\S+ gs/, 'no page-wide overprint on text and cut marks');
  const images = reachableImages(doc, resources);
  const original = await PDFDocument.load(input.art);
  for (const originalImage of reachableImages(original, original.getPages()[0].node.Resources())) {
    assert.ok(images.some(image =>
      image.dict.lookup(PDFName.of('ColorSpace')).toString() === originalImage.dict.lookup(PDFName.of('ColorSpace')).toString()
      && image.dict.lookup(PDFName.of('Filter')).toString() === originalImage.dict.lookup(PDFName.of('Filter')).toString()
      && Buffer.from(image.contents).equals(Buffer.from(originalImage.contents))), 'art JPEG bytes and color space must be preserved');
  }
  const spot = images.find(image => image.dict.lookup(PDFName.of('ColorSpace')) instanceof PDFArray);
  const cs = spot.dict.lookup(PDFName.of('ColorSpace'), PDFArray);
  assert.equal(cs.get(0).toString(), '/Separation');
  assert.equal(cs.get(1).toString(), '/White');
  assert.equal(cs.get(2).toString(), '/DeviceCMYK');
  const tint = doc.context.lookup(cs.get(3), PDFDict);
  assert.deepEqual(tint.lookup(PDFName.of('C1'), PDFArray).asArray().map(n => n.asNumber()), [1, 0, 0, 0], 'spot preview must be cyan');
  assert.deepEqual(spot.dict.lookup(PDFName.of('Decode'), PDFArray).asArray().map(n => n.asNumber()), [1, 0]);
  const gray = pako.inflate(spot.contents);
  assert.equal(gray[30], 0, 'black means full spot ink');
  assert.equal(gray[90], 255, 'white means no spot ink');
  const firstForm = resources.lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('FoilMask'));
  assert.match(new TextDecoder().decode(pako.inflate(firstForm.contents)), /\/I\d+\s+Do/,
    'later blank mask pages must never overwrite the first sheet mask');
  // jsPDF shares XObject resources across pages. Check blank mask forms have
  // no image draw operations, rather than assuming empty resource dictionaries.
  for (const blank of doc.getPages().slice(1)) {
    const form = blank.node.Resources().lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('FoilMask'));
    const content = new TextDecoder().decode(pako.inflate(form.contents));
    assert.doesNotMatch(content, /\/I\d+\s+Do/);
  }
  if (process.env.IRIDESSE_PROOF_DIR) {
    const dir = process.env.IRIDESSE_PROOF_DIR;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/combined.pdf`, bytes);
    // Toggle the optional art layer off for a separate visual inspection.
    const oc = doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict).lookup(PDFName.of('D'), PDFDict);
    oc.set(PDFName.of('ON'), doc.context.obj([groups.get(1)]));
    oc.set(PDFName.of('OFF'), doc.context.obj([groups.get(0)]));
    await fs.writeFile(`${dir}/white-only.pdf`, await doc.save());
  }
});

test('companion White mask matches the embedded plate, with identical page order and no artwork', async () => {
  const { combinedPdf, whiteMaskPdf } = await buildIridesseFiles(input.art, input.mask, { decodePixels });
  const combined = await PDFDocument.load(combinedPdf);
  const white = await PDFDocument.load(whiteMaskPdf);
  const source = await PDFDocument.load(input.mask);
  assert.equal(white.getPageCount(), combined.getPageCount());
  const text = stream => new TextDecoder().decode(
    stream.dict.lookup(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? pako.inflate(stream.contents) : stream.contents);
  const content = (doc, page) => {
    const raw = page.node.Contents();
    return raw instanceof PDFArray ? raw.asArray().map(ref => text(doc.context.lookup(ref))).join('\n') : text(raw);
  };
  const commands = value => [...value.matchAll(/[-\d.\s]+cm\s+\/I\d+\s+Do/g)].map(m => m[0].trim().replace(/\s+/g, ' '));
  for (const [index, page] of white.getPages().entries()) {
    assert.deepEqual(page.getMediaBox(), source.getPages()[index].getMediaBox());
    assert.deepEqual(page.getCropBox(), source.getPages()[index].getCropBox());
    assert.equal(page.getRotation().angle, source.getPages()[index].getRotation().angle);
    const embedded = combined.getPages()[index].node.Resources()
      .lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('FoilMask'));
    assert.deepEqual(commands(content(white, page)), commands(text(embedded)), 'all mask placements must match the combined plate');
    assert.equal(commands(content(white, page)).length, index === 0 ? 1 : 0, 'blank back/front masks must remain blank');
    const standaloneImages = reachableImages(white, page.node.Resources());
    const embeddedImages = reachableImages(combined, embedded.dict.lookup(PDFName.of('Resources'), PDFDict));
    assert.ok(standaloneImages.length > 0);
    for (const image of standaloneImages) {
      const cs = image.dict.lookup(PDFName.of('ColorSpace'), PDFArray);
      assert.equal(cs.get(0).toString(), '/Separation');
      assert.equal(cs.get(1).toString(), '/White', 'no RGB artwork is drawn in the companion mask');
      assert.ok(embeddedImages.some(other => Buffer.from(other.contents).equals(Buffer.from(image.contents))), 'same converted mask pixels must be used in both PDFs');
    }
  }
  if (process.env.IRIDESSE_PAIR_PROOF_DIR) {
    await fs.mkdir(process.env.IRIDESSE_PAIR_PROOF_DIR, { recursive: true });
    await fs.writeFile(`${process.env.IRIDESSE_PAIR_PROOF_DIR}/combined.pdf`, combinedPdf);
    await fs.writeFile(`${process.env.IRIDESSE_PAIR_PROOF_DIR}/white-mask.pdf`, whiteMaskPdf);
  }
});

test('preview overlays cyan with mask alpha, preserves artwork and leaves printing PDFs unchanged', async () => {
  const { combinedPdf, whiteMaskPdf, previewPdf } = await buildIridesseFiles(input.art, input.mask, { decodePixels });
  const preview = await PDFDocument.load(previewPdf);
  const original = await PDFDocument.load(input.art);
  const white = await PDFDocument.load(whiteMaskPdf);
  assert.equal(preview.getPageCount(), 3);
  assert.match(preview.getTitle(), /PREVIEW ONLY/);
  assert.equal(preview.catalog.has(PDFName.of('OCProperties')), false);
  const text = stream => new TextDecoder().decode(
    stream.dict.lookup(PDFName.of('Filter'))?.toString() === '/FlateDecode' ? pako.inflate(stream.contents) : stream.contents);
  for (const [index, page] of preview.getPages().entries()) {
    assert.equal(page.getWidth(), original.getPages()[index].getWidth());
    assert.equal(page.getHeight(), original.getPages()[index].getHeight() + 28, 'proof banner must not cover artwork');
    const resources = page.node.Resources();
    const overlay = resources.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('MaskPreview'), PDFDict);
    assert.equal(overlay.lookup(PDFName.of('ca')).asNumber(), 0.45);
    const form = resources.lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('MaskPreview'));
    if (index) assert.doesNotMatch(text(form), /\/I\d+\s+Do/, 'unmasked pages have no overlay');
    const images = reachableImages(preview, resources);
    for (const artImage of reachableImages(original, original.getPages()[index].node.Resources())) {
      assert.ok(images.some(image => Buffer.from(image.contents).equals(Buffer.from(artImage.contents))), 'art image bytes must be preserved');
    }
    for (const image of reachableImages(preview, form.dict.lookup(PDFName.of('Resources'), PDFDict))) {
      const cs = image.dict.lookup(PDFName.of('ColorSpace'), PDFArray);
      assert.equal(cs.get(0).toString(), '/Indexed');
      assert.equal(cs.get(1).toString(), '/DeviceRGB', 'preview must not add a White printing plate');
      const alpha = image.dict.lookup(PDFName.of('SMask'));
      assert.equal(alpha.dict.lookup(PDFName.of('ColorSpace')).toString(), '/DeviceGray');
      assert.deepEqual(alpha.dict.lookup(PDFName.of('Decode'), PDFArray).asArray().map(n => n.asNumber()), [1, 0]);
      assert.ok(reachableImages(white, white.getPages()[index].node.Resources()).some(mask => Buffer.from(mask.contents).equals(Buffer.from(alpha.contents))), 'coverage must use the exact printing mask pixels');
    }
    const contents = page.node.Contents().asArray().map(ref => text(preview.context.lookup(ref))).join('\n');
    assert.ok(contents.indexOf('/MaskPreview Do') > contents.indexOf('/I0 Do'), 'overlay must paint over the art');
  }
  for (const pdf of [combinedPdf, whiteMaskPdf]) {
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPages()[0].getHeight(), original.getPages()[0].getHeight());
    const spots = reachableImages(doc, doc.getPages()[0].node.Resources()).filter(image => image.dict.lookup(PDFName.of('ColorSpace')) instanceof PDFArray);
    for (const spot of spots) {
      assert.equal(spot.dict.lookup(PDFName.of('ColorSpace'), PDFArray).get(1).toString(), '/White');
      assert.equal(spot.dict.has(PDFName.of('SMask')), false, 'printing masks must not gain preview transparency');
    }
  }
  if (process.env.IRIDESSE_PAIR_PROOF_DIR) await fs.writeFile(`${process.env.IRIDESSE_PAIR_PROOF_DIR}/overlay-preview.pdf`, previewPdf);
});

test('preview rejects incompatible or unconverted masks', async () => {
  await assert.rejects(buildIridessePreview(input.art, input.mask), /converted White/);
  const { whiteMaskPdf } = await buildIridesseFiles(input.art, input.mask, { decodePixels });
  const bad = await PDFDocument.load(whiteMaskPdf);
  bad.removePage(2);
  await assert.rejects(buildIridessePreview(input.art, await bad.save()), /page counts/);
});

test('empty masks produce a valid blank companion without adding any artwork', async () => {
  const mask = new jsPDF({ unit: 'mm', format: [210, 297] });
  mask.addPage(); mask.addPage();
  const { combinedPdf, whiteMaskPdf } = await buildIridesseFiles(input.art, mask.output('arraybuffer'), { decodePixels });
  const white = await PDFDocument.load(whiteMaskPdf);
  assert.equal((await PDFDocument.load(combinedPdf)).getPageCount(), 3);
  assert.equal(white.getPageCount(), 3);
  for (const page of white.getPages()) assert.equal(reachableImages(white, page.node.Resources()).length, 0);
});

test('mismatched page count, size or rotation stops export', async () => {
  for (const change of [
    doc => doc.removePage(2),
    doc => doc.getPages()[0].setSize(250, 400),
    doc => doc.getPages()[0].setRotation(degrees(90)),
  ]) {
    const mask = await PDFDocument.load(input.mask);
    change(mask);
    await assert.rejects(combineIridesse(input.art, await mask.save(), { decodePixels }), /match|different/);
    await assert.rejects(buildIridesseFiles(input.art, await mask.save(), { decodePixels }), /match|different/);
  }
});

test('equivalent page boxes with PDF floating-point rounding are accepted', async () => {
  const mask = await PDFDocument.load(input.mask);
  const page = mask.getPages()[0], box = page.getMediaBox();
  page.setMediaBox(box.x, box.y, box.width, box.height + 1e-10);
  const bytes = await combineIridesse(input.art, await mask.save(), { decodePixels });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
});

test('mask decode errors fail the whole export rather than producing a blank plate', async () => {
  await assert.rejects(combineIridesse(input.art, input.mask, {
    decodePixels: async () => { throw new Error('Artwork unavailable'); },
  }), /Artwork unavailable/);
  await assert.rejects(buildIridesseFiles(input.art, input.mask, {
    decodePixels: async () => { throw new Error('Artwork unavailable'); },
  }), /Artwork unavailable/);
});
