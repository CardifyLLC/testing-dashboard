import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

test('automatic worker uploads separate stock PDFs and completes only after both files', async t => {
  const image = async (label, color) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="670" height="920"><rect width="670" height="920" fill="${color}"/><rect x="20" y="20" width="630" height="880" fill="none" stroke="white" stroke-width="4"/><text x="335" y="100" text-anchor="middle" font-size="42" fill="white">TOP</text><text x="335" y="450" text-anchor="middle" font-size="42" fill="white">${label}</text><text x="335" y="840" text-anchor="middle" font-size="32" fill="white">LAYOUT TEST ONLY</text></svg>`;
    return `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`;
  };
  const order = {
    id: 'mixed-layout-test', status: 'paid', customer_name: 'LAYOUT TEST - NOT A CUSTOMER ORDER', metadata: {},
    card_data: [
      { frontUrl: await image('STANDARD FRONT', '#165c88'), backUrl: await image('STANDARD BACK', '#31506a'), finish: 'standard', quantity: 18 },
      { frontUrl: await image('FOIL FRONT', '#9b5415'), backUrl: await image('FOIL BACK', '#6d451d'), finish: 'silver', quantity: 9, silverMask: 'fixture/mask.png' },
    ],
  };
  const fixture = globalThis.orderPdfWorkerFixture = {
    order, job: { order_id: order.id, status: 'processing', attempt_count: 0, processed_cards: 0 },
    updates: [], uploads: [],
  };
  const temp = await mkdtemp(join(tmpdir(), 'order-pdf-worker-test-'));
  const envNames = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_WORKFLOW_TOKEN', 'GITHUB_REPOSITORY_NAME', 'ORDER_PDF_WEBHOOK_SECRET'];
  const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
  for (const name of envNames.slice(2)) delete process.env[name];
  t.after(async () => {
    for (const name of envNames) {
      if (originalEnv[name] === undefined) delete process.env[name]; else process.env[name] = originalEnv[name];
    }
    delete globalThis.orderPdfWorkerFixture;
    await rm(join(temp, 'worker.mjs'), { force: true });
    await rmdir(temp);
  });
  // Any unmocked network access fails this test immediately.
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request in worker test'); });
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('./generate-order-pdfs.mjs', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'isolated-worker', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'database', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export function createClient() {
          const f = globalThis.orderPdfWorkerFixture;
          return {
            from(table) {
              let changes, excludeCompleted = false;
              const q = {};
              for (const name of ['select','ilike','order','limit','in','eq','lt']) q[name] = () => q;
              q.neq = (name, value) => { excludeCompleted = name === 'status' && value === 'completed'; return q; };
              q.update = value => { changes = value; return q; };
              q.maybeSingle = async () => ({ data: { ...f.job }, error: null });
              q.single = async () => ({ data: f.order, error: null });
              q.then = (resolve, reject) => {
                if (changes) { f.updates.push(structuredClone(changes)); Object.assign(f.job, changes); }
                const data = table === 'orders' ? [f.order] : excludeCompleted && f.job.status === 'completed' ? [] : [f.job];
                return Promise.resolve({ data, error: null }).then(resolve, reject);
              };
              return q;
            },
            storage: { from(bucket) {
              if (bucket !== 'order-pdfs') throw new Error('Wrong storage bucket');
              return { async upload(path, bytes) { f.uploads.push({ path, bytes }); return { error: null }; } };
            } },
          };
        }
      `, loader: 'js' }));
      builder.onResolve({ filter: /^(pdf-lib|sharp)$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  const entry = join(temp, 'worker.mjs');
  await writeFile(entry, compiled.outputFiles[0].text);
  await import(pathToFileURL(entry).href);
  assert.deepEqual(fixture.uploads.map(item => item.path), ['mixed-layout-test/standard.pdf', 'mixed-layout-test/foil.pdf']);
  for (const [index, upload] of fixture.uploads.entries()) {
    const pdf = await PDFDocument.load(upload.bytes);
    assert.equal(pdf.getPageCount(), 2);
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - (index ? 648 : 1296)) < 0.00001);
    assert.ok(Math.abs(pdf.getPage(0).getHeight() - 864) < 0.00001);
    if (process.env.ORDER_PDF_TEST_OUTPUT_DIR) {
      await mkdir(process.env.ORDER_PDF_TEST_OUTPUT_DIR, { recursive: true });
      await writeFile(join(process.env.ORDER_PDF_TEST_OUTPUT_DIR, `${index ? 'foil' : 'standard'}-layout-test.pdf`), upload.bytes);
    }
  }
  assert.equal(fixture.job.status, 'completed');
  assert.equal(fixture.job.processed_cards, 27);
  assert.equal(fixture.job.total_cards, 27);
  assert.equal(fixture.job.total_parts, 2);
  assert.equal(fixture.job.completed_parts, 2);
  assert.deepEqual(fixture.job.storage_paths, fixture.uploads.map(item => item.path));
  const progress = fixture.updates.filter(item => item.processed_cards !== undefined).map(item => item.processed_cards);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
});
