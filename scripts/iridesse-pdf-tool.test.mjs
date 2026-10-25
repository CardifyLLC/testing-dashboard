import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFString, decodePDFRawStream, rgb, degrees } from 'pdf-lib';
import { preparePdfPair, combineUploadedPdfs } from '../src/services/iridessePdfTool.mjs';

const n = PDFName.of;
async function fixture({ widths = [120, 280, 360], offset = 0, rotation = 0, unit = 1 } = {}) {
  const doc = await PDFDocument.create();
  for (const width of widths) {
    const page = doc.addPage([width, 180]);
    page.setMediaBox(offset, offset, width, 180);
    page.setCropBox(offset + 5, offset + 5, width - 10, 170);
    page.setTrimBox(offset + 10, offset + 10, width - 20, 160);
    page.setRotation(degrees(rotation));
    page.node.set(n('UserUnit'), doc.context.obj(unit));
    page.drawText('Vector artwork remains selectable', { x: offset + 15, y: offset + 40, size: 5, color: rgb(0.8, 0.2, 0.1) });
  }
  return doc;
}
async function* tiles(_bytes, pages) {
  for (let i = 0; i < pages.length; i++) {
    // First page marks are precisely identifiable; other pages are blank.
    yield { pageIndex: i, x: 0, y: 0, width: 2, height: 2, gray: Uint8Array.from(i === 0 ? [0, 128, 255, 64] : [255, 255, 255, 255]) };
  }
}
const content = (doc, page) => page.node.Contents().asArray().map(ref => {
  const stream = doc.context.lookup(ref);
  return new TextDecoder().decode(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getUnencodedContents());
}).join('\n');

test('custom sizes, rotated pages, shifted origins and UserUnit stay aligned; mask bytes and blank backs survive', async () => {
  for (const rotation of [0, 90, 180, 270]) {
    const input = await fixture({ offset: -25, rotation, unit: 2 });
    const bytes = await input.save();
    const pair = await preparePdfPair(bytes, bytes, 600);
    const output = await combineUploadedPdfs(pair, { renderMask: tiles });
    const combined = await PDFDocument.load(output.combinedPdf), mask = await PDFDocument.load(output.whiteMaskPdf);
    assert.equal(combined.getPageCount(), 3);
    for (let i = 0; i < 3; i++) {
      for (const box of ['MediaBox', 'CropBox', 'TrimBox', 'BleedBox', 'ArtBox']) {
        assert.deepEqual(combined.getPage(i)[`get${box}`](), input.getPage(i)[`get${box}`]());
        assert.deepEqual(mask.getPage(i)[`get${box}`](), input.getPage(i)[`get${box}`]());
      }
      assert.equal(combined.getPage(i).getRotation().angle, rotation);
      assert.equal(mask.getPage(i).node.lookup(n('UserUnit')).asNumber(), 2);
      const objects = combined.getPage(i).node.Resources().lookup(n('XObject'), PDFDict);
      const plate = objects.lookup(objects.keys().find(key => key.toString().startsWith('/IridesseMask')));
      assert.deepEqual(plate.dict.lookup(n('Matrix'), PDFArray).asArray().map(v => v.asNumber()), [1, 0, 0, 1, 0, 0]);
      assert.ok(content(combined, combined.getPage(i)).includes(content(input, input.getPage(i)).trim()), 'Original vector content is preserved');
      assert.match(content(combined, combined.getPage(i)), /IridesseMask.*Do EMC Q\s+q \/OC .*BDC \/IridesseOP.*gs/s);
      if (i) assert.doesNotMatch(content(mask, mask.getPage(i)), /WhiteTile/, 'blank backs stay blank');
    }
    const objects = mask.getPage(0).node.Resources().lookup(n('XObject'), PDFDict);
    const image = objects.lookup(objects.keys()[0]);
    assert.deepEqual([...decodePDFRawStream(image).decode()], [0, 128, 255, 64]);
    const cs = image.dict.lookup(n('ColorSpace'), PDFArray);
    assert.equal(cs.get(1).decodeText(), 'White');
    assert.deepEqual(image.dict.lookup(n('Decode'), PDFArray).asArray().map(v => v.asNumber()), [1, 0]);
  }
});

test('keeps original layers and output intent, applies overprint inside nested artwork resources', async () => {
  const art = await fixture({ widths: [120] }), mask = await fixture({ widths: [120] }), ctx = art.context;
  const oldLayer = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Original layer') }));
  art.catalog.set(n('OCProperties'), ctx.obj({ OCGs: [oldLayer], D: { BaseState: 'ON', OFF: [oldLayer], Order: [oldLayer] } }));
  art.catalog.set(n('OutputIntents'), ctx.obj([ctx.register(ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFX', OutputConditionIdentifier: PDFString.of('Test CMYK profile') }))]));
  const nestedState = ctx.register(ctx.obj({ Type: 'ExtGState', op: false, OP: false, OPM: 0, ca: 0.5 }));
  const nested = ctx.register(ctx.flateStream('/GS0 gs 0 0 10 10 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { ExtGState: { GS0: nestedState } } }));
  art.getPage(0).node.Resources().set(n('XObject'), ctx.obj({ Nested: nested }));
  art.getPage(0).node.addContentStream(ctx.register(ctx.stream('/Nested Do')));
  const pair = await preparePdfPair(await art.save(), await mask.save(), 300);
  const result = await PDFDocument.load((await combineUploadedPdfs(pair, { renderMask: tiles })).combinedPdf);
  const resources = result.getPage(0).node.Resources();
  const form = resources.lookup(n('XObject'), PDFDict).lookup(n('Nested'));
  const state = form.dict.lookup(n('Resources'), PDFDict).lookup(n('ExtGState'), PDFDict).lookup(n('GS0'), PDFDict);
  assert.equal(state.lookup(n('op')).asBoolean(), true); assert.equal(state.lookup(n('OP')).asBoolean(), true);
  assert.equal(state.lookup(n('OPM')).asNumber(), 1); assert.equal(state.lookup(n('ca')).asNumber(), 0.5);
  const oc = result.catalog.lookup(n('OCProperties'), PDFDict);
  assert.equal(oc.lookup(n('OCGs'), PDFArray).size(), 3);
  assert.equal(oc.lookup(n('D'), PDFDict).lookup(n('OFF'), PDFArray).size(), 1);
  assert.equal(result.catalog.lookup(n('OutputIntents'), PDFArray).size(), 1);
});

test('rejects incompatible counts, size, crop, trim, bleed, rotation, units, annotations and invalid PDFs', async () => {
  const good = await (await fixture()).save();
  for (const change of [doc => doc.removePage(1), doc => doc.getPage(0).setSize(200, 200),
    doc => doc.getPage(0).setCropBox(0, 0, 30, 40), doc => doc.getPage(0).setTrimBox(0, 0, 30, 40),
    doc => doc.getPage(0).setBleedBox(0, 0, 40, 50), doc => doc.getPage(0).setRotation(degrees(90)),
    doc => doc.getPage(0).node.set(n('UserUnit'), doc.context.obj(2)),
    doc => doc.getPage(0).node.set(n('Annots'), doc.context.obj([doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Text' }))])),
  ]) {
    const bad = await fixture(); change(bad);
    await assert.rejects(preparePdfPair(good, await bad.save()), /match|differ|annotations/);
  }
  await assert.rejects(preparePdfPair(new Uint8Array([1, 2]), good), /could not be opened/);
  await assert.rejects(preparePdfPair(good, good, 100), /DPI/);
});

test('existing White masks are byte-identical, used in the combined file, and never rasterized or doubled', async () => {
  const plain = await (await fixture({ widths: [120] })).save();
  const output = await combineUploadedPdfs(await preparePdfPair(plain, plain, 300), { renderMask: tiles });
  await assert.rejects(preparePdfPair(output.combinedPdf, plain), /already contains a White/);
  const pair = await preparePdfPair(plain, output.whiteMaskPdf);
  assert.equal(pair.existingWhite, true);
  const second = await combineUploadedPdfs(pair, { renderMask: () => { throw new Error('Must not rasterize White'); } });
  assert.deepEqual(second.whiteMaskPdf, output.whiteMaskPdf);
  const combined = await PDFDocument.load(second.combinedPdf);
  const objects = combined.getPage(0).node.Resources().lookup(n('XObject'), PDFDict);
  const form = objects.lookup(objects.keys()[0]);
  const nested = form.dict.lookup(n('Resources'), PDFDict).lookup(n('XObject'), PDFDict);
  const image = nested.lookup(nested.keys()[0]);
  assert.deepEqual([...decodePDFRawStream(image).decode()], [0, 128, 255, 64]);
  assert.equal(image.dict.lookup(n('ColorSpace'), PDFArray).get(1).decodeText(), 'White');
});

test('declared-but-unused White is rejected, vector White and original mask layer states are preserved', async () => {
  const art = await fixture({ widths: [120] }), mask = await fixture({ widths: [120] }), ctx = mask.context;
  const cs = ctx.obj(['Separation', 'White', 'DeviceCMYK', ctx.register(ctx.obj({ FunctionType: 2, Domain: [0,1], C0:[0,0,0,0], C1:[1,0,0,0], N:1 }))]);
  mask.getPage(0).node.Resources().set(n('ColorSpace'), ctx.obj({ Spot: cs }));
  await assert.rejects(preparePdfPair(await art.save(), await mask.save()), /declares White/);
  const layer = ctx.register(ctx.obj({ Type:'OCG',Name:PDFString.of('Mask original') }));
  mask.catalog.set(n('OCProperties'),ctx.obj({OCGs:[layer],D:{BaseState:'OFF',ON:[layer],Order:[layer]}}));
  mask.getPage(0).node.Resources().set(n('Properties'),ctx.obj({MaskLayer:layer}));
  mask.getPage(0).node.addContentStream(ctx.register(ctx.stream('q /OC /MaskLayer BDC /Spot cs 1 scn 10 10 20 20 re f EMC Q')));
  const bytes=await mask.save();
  const output=await combineUploadedPdfs(await preparePdfPair(await art.save(),bytes));
  assert.deepEqual(output.whiteMaskPdf,bytes);
  const result=await PDFDocument.load(output.combinedPdf), objects=result.getPage(0).node.Resources().lookup(n('XObject'),PDFDict);
  const form=objects.lookup(objects.keys()[0]);
  const copiedLayer=form.dict.lookup(n('Resources'),PDFDict).lookup(n('Properties'),PDFDict).get(n('MaskLayer'));
  const oc=result.catalog.lookup(n('OCProperties'),PDFDict);
  assert.ok(oc.lookup(n('OCGs'),PDFArray).asArray().some(ref=>String(ref)===String(copiedLayer)));
  assert.ok(oc.lookup(n('D'),PDFDict).lookup(n('ON'),PDFArray).asArray().some(ref=>String(ref)===String(copiedLayer)));
});

test('fails closed for blank masks, renderer failure, oversized jobs and cancellation', async () => {
  const bytes = await (await fixture({ widths: [120] })).save();
  await assert.rejects(combineUploadedPdfs(await preparePdfPair(bytes, bytes), { renderMask: async function* () { yield { pageIndex: 0, x: 0, y: 0, width: 1, height: 1, gray: Uint8Array.of(255) }; } }), /completely white/);
  await assert.rejects(combineUploadedPdfs(await preparePdfPair(bytes, bytes), { renderMask: async function* () { throw new Error('Decode failed'); } }), /Decode failed/);
  const huge = await fixture({ widths: [100000] });
  await assert.rejects(preparePdfPair(await huge.save(), await huge.save()), /too large/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(combineUploadedPdfs(await preparePdfPair(bytes, bytes), { renderMask: tiles, signal: controller.signal }), { name: 'AbortError' });
});
