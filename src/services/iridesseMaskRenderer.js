import { getDocument, GlobalWorkerOptions, AnnotationMode } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { checkCancelled } from './iridessePdfTool.mjs';

GlobalWorkerOptions.workerSrc = workerUrl;
// Vite emits these as local assets. Nothing is fetched from a public CDN and
// this module (including the renderer) loads only when the tool is opened.
const assetUrls = import.meta.glob('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', { eager: true, query: '?url', import: 'default' });
const folders = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };

export async function* renderMaskTiles(bytes, pages, dpi, signal, onProgress) {
  let assetError;
  class LocalPdfAssets {
    async fetch({ kind, filename }) {
      try {
        const url = assetUrls[`/node_modules/pdfjs-dist/${folders[kind]}/${filename}`];
        if (!url) throw new Error(`Missing PDF renderer asset: ${filename}`);
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Unable to load PDF renderer asset: ${filename}`);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) { assetError = error; throw error; }
    }
  }
  checkCancelled(signal);
  const task = getDocument({ data: new Uint8Array(bytes).slice(), useWorkerFetch: false, BinaryDataFactory: LocalPdfAssets,
    useSystemFonts: false, stopAtErrors: true, isEvalSupported: false });
  const canvas = document.createElement('canvas');
  let activeRender;
  const cancel = () => { activeRender?.cancel(); void task.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const doc = await task.promise;
    const tileSize = 2048, gutter = 2;
    for (let index = 0; index < pages.length; index++) {
      checkCancelled(signal);
      const page = await doc.getPage(index + 1), info = pages[index];
      const viewport = page.getViewport({ scale: dpi / 72, rotation: 0 });
      if (Math.abs(Math.ceil(viewport.width) - info.width) > 1 || Math.abs(Math.ceil(viewport.height) - info.height) > 1) {
        throw new Error(`Mask page ${index + 1} has a crop box outside its media box. Export both PDFs with standard page boxes.`);
      }
      const total = Math.ceil(info.width / tileSize) * Math.ceil(info.height / tileSize);
      let completed = 0;
      for (let y = 0; y < info.height; y += tileSize) for (let x = 0; x < info.width; x += tileSize) {
        checkCancelled(signal);
        const width = Math.min(tileSize, info.width - x), height = Math.min(tileSize, info.height - y);
        canvas.width = width + gutter * 2; canvas.height = height + gutter * 2;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('The browser could not allocate a mask canvas. Close other tabs and try again.');
        activeRender = page.render({ canvas, canvasContext: context, viewport, intent: 'print', annotationMode: AnnotationMode.DISABLE,
          background: 'rgb(255,255,255)', transform: [info.width / viewport.width, 0, 0, info.height / viewport.height, -x + gutter, -y + gutter] });
        await activeRender.promise;
        activeRender = null;
        if (assetError) throw assetError;
        checkCancelled(signal);
        const rgba = context.getImageData(gutter, gutter, width, height).data;
        const gray = new Uint8Array(width * height);
        // Gray values are coverage: black = full White ink, white = no ink.
        // No thresholding and no lossy JPEG step are introduced.
        for (let i = 0, p = 0; p < gray.length; i += 4, p++) gray[p] = Math.round((rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000);
        onProgress?.(`Preparing mask page ${index + 1} of ${pages.length} · section ${++completed} of ${total}`);
        yield { pageIndex: index, x, y, width, height, gray };
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      page.cleanup();
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    canvas.width = canvas.height = 1;
    await task.destroy();
  }
}
