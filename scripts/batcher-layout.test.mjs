import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { REFERENCE_LAYOUT, gridPosition } from '../src/services/batcherLayout.mjs';

test('production grid matches all 54 card placements extracted from the reference PDFs', async () => {
  const samples = JSON.parse(await fs.readFile(new URL('./fixtures/reference-layout.json', import.meta.url)));
  const c = REFERENCE_LAYOUT, pt = 72 / 25.4;
  for (const sample of samples) {
    assert.equal(sample.placements.length, 18);
    for (let i = 0; i < 18; i++) {
      const { x, y } = gridPosition(i % 6, Math.floor(i / 6), 67, 92, c.marginLeft, c.marginTop, c.gapHorizontal, c.gapVertical);
      const matrix = [67 * pt, 0, 0, 92 * pt, x * pt, (304.8 - y - 92) * pt];
      assert.ok(sample.placements.some(ref => matrix.every((v, j) => Math.abs(v - ref[j]) < 0.001)), `sample ${sample.sample}, card ${i}`);
    }
  }
});
