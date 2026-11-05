import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { promoSlots, promoBackSvg, addPromosToPages, createPromoBackRenderer } from '../src/services/promoCards.mjs';
import { buildStockPages, FOIL_CONFIG } from '../src/services/batcherStock.mjs';
import { addOrderPromos } from './order-pdf-promos.mjs';
import { buildOrderPdfParts, generateOrderPdf } from './order-pdf-document.mjs';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

test('slot counts follow the physical sheet and never add extra sheets', () => {
  for (const [n,c,expected] of [[1,18,17],[18,18,0],[19,18,17],[5,18,13],[1,9,8]]) assert.equal(promoSlots(n,c),expected);
  assert.throws(()=>promoSlots(1,0));
  const pages=buildStockPages([{orderId:'a',customerName:'Same'},{orderId:'b',customerName:'Same'}],{standard:{gridCols:6,gridRows:3},foil:FOIL_CONFIG});
  assert.equal(pages.length,2);
});
test('QR back contains uppercase URL QR and fixed quiet-zone layout', async () => {
  const svg=await promoBackSvg('ABCDEFGHJKM2','data:image/png;base64,AAAA');
  assert.match(svg,/width="340"/); assert.match(svg,/S&amp;H still applies/);
  assert.match(svg, /5 free standard prints\./);
  await assert.rejects(()=>promoBackSvg('INVALID','data:image/png;base64,AAAA'));
});

function stubPromoCanvas(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ getContext: () => ({ fillRect() {} }), toDataURL: () => 'data:image/png;base64,opaque-mask' }),
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
}

test('Batcher preview and export share final-sheet promos without editing customer cards or marking printed', async t => {
  stubPromoCanvas(t);
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: `card-${i}`, orderId: 'qa', customerName: 'QA', finish: i < 26 ? 'standard' : 'foil' }));
  const pages = buildStockPages(cards, { standard: { gridCols: 6, gridRows: 3 }, foil: FOIL_CONFIG });
  const calls = [], rendered = [];
  const client = { rpc: async (name, args) => {
    calls.push([name, args]);
    assert.equal(name, 'allocate_promo_run');
    assert.equal(args.p_count, args.p_group === 'standard' ? 26 : 4);
    return { data: { runId: args.p_group, backFile: 'back.png', cards: Array.from({ length: promoSlots(args.p_count, args.p_capacity) }, (_, i) => ({
      id: `${args.p_group}-${i}`, code: `${args.p_group}-${i}`, frontFile: 'front.png',
    })) } };
  } };
  const renderBack = createPromoBackRenderer(async code => { rendered.push(code); return `qr:${code}`; });
  const preview = await addPromosToPages(client, pages, { renderBack });
  assert.deepEqual(preview.map(page => page.entries.length), [18, 18, 9]);
  assert.deepEqual(pages.map(page => page.entries.length), [18, 8, 4], 'preview leaves editable source pages unchanged');
  assert.deepEqual(preview.map(page => page.entries.filter(e => e.card.isPromo).length), [0, 10, 5]);
  assert.equal(preview[1].entries[0].card, cards[18], 'customer card references and indices stay intact');
  assert.equal(preview[1].entries[0].index, 18);
  const exported = await addPromosToPages(client, pages, { renderBack });
  assert.deepEqual(exported, preview, 'export uses the same identities and QR backs');
  assert.deepEqual(await addPromosToPages(client, preview, { renderBack }), preview, 'reusing prepared pages never duplicates promos');
  assert.equal(rendered.length, 15, 'QR artwork is reused between preview and export');
  assert.equal(new Set(preview.flatMap(p => p.entries.filter(e => e.card.isPromo).map(e => e.card.customBack))).size, 15);
  assert.ok(preview[2].entries.filter(e => e.card.isPromo).every(e => e.card.spotMask));
  assert.equal(calls.length, 6);
});

test('Batcher leaves unavailable and non-order slots blank, and reports missing artwork', async t => {
  stubPromoCanvas(t);
  const configs = { standard: { gridCols: 6, gridRows: 3 }, foil: FOIL_CONFIG };
  const pages = buildStockPages([{ orderId: 'qa' }, { orderId: 'partner', partnerOrderId: 'partner' }, { id: 'upload' }], configs);
  const calls = [], warnings = [];
  const client = { rpc: async (name, args) => { calls.push(args.p_order); return { data: { cards: [], warning: 'No active promo artwork or shared back; slots left blank.' } }; } };
  const result = await addPromosToPages(client, pages, { onWarning: value => warnings.push(value) });
  assert.deepEqual(calls, ['qa'], 'partner and manual uploads do not issue customer promo codes');
  assert.deepEqual(result.map(page => page.entries.length), [1, 1, 1]);
  assert.match(warnings[0], /No active promo/);
});

test('obsolete preview requests stop before rendering more QR backs', async t => {
  stubPromoCanvas(t);
  const controller = new AbortController();
  const pages = buildStockPages([{ orderId: 'qa' }], { standard: { gridCols: 2, gridRows: 1 }, foil: FOIL_CONFIG });
  let renders = 0;
  const client = { rpc: async () => {
    controller.abort();
    return { data: { cards: [{ id: 'promo', code: 'code', frontFile: 'front' }], backFile: 'back' } };
  } };
  await assert.rejects(addPromosToPages(client, pages, { signal: controller.signal, renderBack: async () => { renders++; } }), { name: 'AbortError' });
  assert.equal(renders, 0);
  assert.equal(pages[0].entries.length, 1);
});

test('QR preview cache retries failed artwork and refreshes changed templates', async () => {
  let calls = 0;
  const renderBack = createPromoBackRenderer(async (code, url) => {
    if (++calls === 1) throw new Error('Artwork unavailable');
    return `${code}:${url}`;
  });
  await assert.rejects(renderBack('code', 'back'), /Artwork unavailable/);
  const [a, b] = await Promise.all([renderBack('code', 'back'), renderBack('code', 'back')]);
  assert.equal(a, b);
  assert.equal(calls, 2);
  assert.equal(await renderBack('code', 'replacement'), 'code:replacement');
  assert.equal(calls, 3);
});

test('worker renders mixed customer/promo fronts and QR backs without adding sheets', async () => {
  const png=await sharp({create:{width:825,height:1125,channels:3,background:'#ffffff'}}).png().toBuffer();
  const art=`data:image/png;base64,${png.toString('base64')}`;
  const client={rpc:async(_name,args)=>({data:{runId:args.p_group,backFile:art,cards:Array.from({length:args.p_capacity-1},(_,i)=>({id:String(i),code:'ABCDEFGHJK'+String.fromCharCode(65+Math.floor(i/8))+'23456789'[i%8],frontFile:art}))},error:null})};
  const result=await addOrderPromos(client,{id:'test'},[{front:[art],back:[],finish:'standard'},{front:[art],back:[],finish:'foil'}]);
  const parts=buildOrderPdfParts(result.cards);
  assert.deepEqual(parts.map(p=>p.cards.length),[18,9]);
  assert.equal(new Set(result.cards.filter(c=>c.isPromo).map(c=>c.back[0])).size,17);
  for(const part of parts) {
    const bytes=await generateOrderPdf({customer_name:'Promo layout test'},part,async urls=>sharp(Buffer.from(urls[0].split(',')[1],'base64')).resize(165,225).jpeg().toBuffer());
    const pdf=await PDFDocument.load(bytes); assert.equal(pdf.getPageCount(),2);
  }
});

const stackMigration = await readFile(new URL('../database/migration-promo-stack-distribution.sql', import.meta.url), 'utf8');
const fivePrintsMigration = await readFile(new URL('../database/migration-promo-five-prints.sql', import.meta.url), 'utf8');

test('missing stack artwork cannot trigger a customer artwork repair email', async () => {
  class MissingOrderImageError extends Error {}
  const missing = new MissingOrderImageError('missing image');
  const loadMissing = async () => { throw missing; };
  const card = { front: ['front'], back: [], finish: 'standard' };
  const part = { stock: 'standard', cards: [card] };
  await assert.rejects(generateOrderPdf({}, part, loadMissing), error => error === missing);
  const promoPart = { ...part, cards: [{ ...card, isPromo: true }] };
  await assert.rejects(generateOrderPdf({}, promoPart, loadMissing), error =>
    !(error instanceof MissingOrderImageError) && error.cause === missing);
});

async function legacyPromoDatabase(t) {
  const db = new PGlite({ extensions: { pgcrypto } });
  t.after(() => db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.uid',true),'')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
    CREATE FUNCTION public.is_dashboard_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('app.admin',true),'true')='true' $$;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,created_at timestamptz DEFAULT now());
    CREATE TABLE public.orders(id uuid PRIMARY KEY,user_id uuid,customer_email text,status text DEFAULT 'paid',payment_status text DEFAULT 'paid',pricing_snapshot jsonb,metadata jsonb DEFAULT '{}',card_data jsonb DEFAULT '[]',deck_quantity integer DEFAULT 1);
    CREATE TABLE public.order_pdf_generations(order_id uuid,status text,attempt_count integer,started_at timestamptz NOT NULL DEFAULT now(),storage_path text,storage_paths jsonb DEFAULT '[]',error_message text);
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid,bucket_id text);
  `);
  await db.exec(await readFile(new URL('../database/migration-promo-cards.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/migration-promo-shipping-expiry.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/migration-promo-reprint-timestamp.sql',import.meta.url),'utf8'));
  const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
  const rpc=async(name,args) => (await q(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args))[0].value;
  return { db, q, rpc };
}

test('database lifecycle, stack claims, checkout holds, refunds and access controls', async t => {
  const { db, q, rpc } = await legacyPromoDatabase(t);
  await db.exec(stackMigration);
  await db.exec(fivePrintsMigration);
  const owner=randomUUID(), a=randomUUID(), b=randomUUID(), c=randomUUID(), order=randomUUID();
  for(const [id,email] of [[owner,'owner@test.com'],[a,'a@test.com'],[b,'b@test.com'],[c,'c@test.com']]) await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',[id,email]);
  await q('INSERT INTO orders(id,user_id,customer_email) VALUES($1,$2,$3)',[order,owner,'owner@test.com']);
  await db.exec("UPDATE promo_settings SET enabled=true,back_file='https://example.test/back.png'; INSERT INTO promo_designs(name,front_file,preview_file,status) VALUES('Design','https://example.test/front.png','preview','active');");
  const run=await rpc('allocate_promo_run',[order,'standard',1,18]);
  assert.equal(run.cards.length,17); assert.equal(new Set(run.cards.map(c=>c.code)).size,17);
  assert.deepEqual(await rpc('allocate_promo_run',[order,'standard',1,18]),run,'retry reuses codes');
  assert.equal((await q('SELECT printed_at FROM promo_runs WHERE id=$1',[run.runId]))[0].printed_at,null,'preview allocation does not mark the run printed');
  const previewReport=await rpc('promo_report',[]);
  assert.equal(previewReport.designs[0].printed,0);
  assert.equal(previewReport.designs[0].activated,0);
  assert.equal((await rpc('claim_promo_code',[run.cards[0].code,a,null])).state,'invalid');
  await rpc('mark_promo_printed',[run.runId]);
  const original = (await q('SELECT status, expires_at FROM promo_codes WHERE code=$1',[run.cards[0].code]))[0];
  assert.deepEqual(original, { status: 'active', expires_at: null }, 'first export activates before shipping, with no default expiry');
  assert.equal((await rpc('claim_promo_code',[run.cards[5].code,owner,null])).state,'success','the issuing customer can make a first claim');
  assert.equal((await rpc('claim_promo_code',[run.cards[6].code,owner,null])).state,'limit');
  assert.equal((await rpc('claim_promo_code',[run.cards[0].code,a,null])).state,'success');
  assert.equal((await rpc('claim_promo_code',[run.cards[0].code,b,null])).state,'redeemed');
  assert.equal((await rpc('claim_promo_code',[run.cards[1].code,a,null])).state,'limit');
  assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[run.cards[1].code]))[0].status,'active');
  const claims=await Promise.all([rpc('claim_promo_code',[run.cards[1].code,b,null]),rpc('claim_promo_code',[run.cards[2].code,b,null])]);
  assert.equal(claims.filter(c=>c.state==='success').length,1);
  assert.equal((await q('SELECT count(*) AS count FROM promo_credits WHERE account_id=$1',[b]))[0].count,5);
  const res=randomUUID(); assert.equal(await rpc('reserve_promo_credits',[a,res,10]),5);
  assert.equal(await rpc('reserve_promo_credits',[a,randomUUID(),10]),0);
  const purchase=randomUUID();
  await q("INSERT INTO orders(id,user_id,status,payment_status,metadata) VALUES($1,$2,'pending','pending',$3)",[purchase,a,JSON.stringify({promoReservation:res,promoPrints:5})]);
  await q("UPDATE orders SET status='paid',payment_status='paid' WHERE id=$1",[purchase]);
  assert.deepEqual(await q('SELECT status FROM promo_credits WHERE account_id=$1',[a]), Array(5).fill({status:'used'}));
  await q("UPDATE orders SET payment_status='refunded' WHERE id=$1",[purchase]);
  assert.deepEqual(await q('SELECT status FROM promo_credits WHERE account_id=$1',[a]), Array(5).fill({status:'available'}));
  await q("UPDATE promo_codes SET expires_at=now()-interval '1 day' WHERE code=$1",[run.cards[3].code]);
  assert.equal((await rpc('claim_promo_code',[run.cards[3].code,c,null])).state,'expired');
  await q('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[c]);
  assert.equal((await rpc('claim_promo_code',[run.cards[4].code,c,null])).state,'verify_email');
  const priorPdf=(await q("INSERT INTO order_pdf_generations(order_id,status,attempt_count,storage_path,storage_paths) VALUES($1,'completed',2,'old.pdf','[\"old.pdf\"]') RETURNING started_at",[order]))[0];
  await rpc('replace_promo_run',[order,'standard']);
  const invalidatedPdf=(await q('SELECT * FROM order_pdf_generations WHERE order_id=$1',[order]))[0];
  assert.equal(invalidatedPdf.status,'failed');
  assert.equal(invalidatedPdf.attempt_count,0);
  assert.equal(invalidatedPdf.storage_path,null);
  assert.deepEqual(invalidatedPdf.storage_paths,[]);
  assert.deepEqual(invalidatedPdf.started_at,priorPdf.started_at,'replacement preserves the required generation timestamp');
  await q('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1',[c]);
  assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[run.cards[0].code]))[0].status,'redeemed');
  const next=await rpc('allocate_promo_run',[order,'standard',1,18]); assert.notEqual(next.runId,run.runId);
  await db.exec('UPDATE promo_settings SET expiry_months=24');
  await rpc('mark_promo_printed',[next.runId]);
  const oldCodes = new Set(run.cards.map(card => card.code));
  assert.ok(next.cards.every(card => !oldCodes.has(card.code)), 'every replacement code is new');
  assert.equal((await rpc('claim_promo_code',[run.cards[4].code,c,null])).state,'success','an old card redeems after replacement export');
  const deadlineQuery = "SELECT expires_at, expires_at = activated_at + interval '24 months' AS correct FROM promo_codes WHERE code=$1";
  const deadline = (await q(deadlineQuery,[next.cards[0].code]))[0];
  assert.equal(deadline.correct,true,'new run uses its own first export time');
  await db.exec('UPDATE promo_settings SET expiry_months=12');
  assert.deepEqual(await rpc('allocate_promo_run',[order,'standard',1,18]),next,'ordinary re-export keeps codes');
  await rpc('mark_promo_printed',[next.runId]);
  assert.deepEqual((await q(deadlineQuery,[next.cards[0].code]))[0],deadline,'re-export keeps the deadline');
  assert.equal((await q('SELECT expires_at FROM promo_codes WHERE code=$1',[run.cards[6].code]))[0].expires_at,null);
  assert.equal((await q('SELECT promo_reprint_requested FROM orders WHERE id=$1',[order]))[0].promo_reprint_requested,false);
  await q("UPDATE orders SET status='cancelled' WHERE id=$1",[order]);
  const recipient = randomUUID();
  await q("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'recipient@test.com',now())",[recipient]);
  assert.equal((await rpc('claim_promo_code',[next.cards[0].code,recipient,null])).state,'success','a replacement card redeems after its issuing order is cancelled');
  await q("UPDATE orders SET payment_status='refunded' WHERE id=$1",[order]);
  assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[run.cards[6].code]))[0].status,'active');
  assert.equal((await q('SELECT status FROM promo_credits WHERE account_id=$1',[recipient]))[0].status,'available');
  const emptyOrder=randomUUID();
  await q('INSERT INTO orders(id,user_id) VALUES($1,$2)',[emptyOrder,owner]);
  await db.exec("UPDATE promo_designs SET status='retired'");
  const blank=await rpc('allocate_promo_run',[emptyOrder,'standard',5,18]);
  assert.equal(blank.cards.length,0); assert.match(blank.warning,/No active/);
  const released=randomUUID(); assert.equal(await rpc('reserve_promo_credits',[a,released,1]),1);
  await rpc('release_promo_reservation',[released]);
  assert.equal((await q('SELECT status FROM promo_credits WHERE account_id=$1',[a]))[0].status,'available');
  const report=await rpc('promo_report',[]); assert.equal(report.designs[0].claimed,5);
  assert.equal(report.designs[0].printed,34); assert.equal(report.designs[0].activated,34);
  await db.exec("UPDATE promo_designs SET status='active'");
  const structured=randomUUID();
  await q('INSERT INTO orders(id,user_id,card_data) VALUES($1,$2,$3)',[structured,owner,JSON.stringify([{quantity:19,finish:'standard'}])]);
  await assert.rejects(()=>rpc('allocate_promo_run',[structured,'standard',1,18]),/Export every card/);
  const nineteen=await rpc('allocate_promo_run',[structured,'standard',19,18]);
  assert.equal(nineteen.cards.length,17);
  assert.equal((await q('SELECT DISTINCT sheet_no FROM promo_codes WHERE run_id=$1',[nineteen.runId]))[0].sheet_no,2);
  await rpc('mark_promo_printed',[nineteen.runId]); await q("UPDATE orders SET status='shipped' WHERE id=$1",[structured]);
  const signupUser=randomUUID(), existingUser=randomUUID();
  const signupScan=new Date(Date.now()-5000).toISOString();
  await q("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'signup@test.com',now())",[signupUser]);
  await q("INSERT INTO auth.users(id,email,email_confirmed_at,created_at) VALUES($1,'existing@test.com',now(),now()-interval '1 day')",[existingUser]);
  assert.equal((await rpc('claim_promo_code',[nineteen.cards[2].code,signupUser,signupScan])).state,'success');
  assert.equal((await rpc('claim_promo_code',[nineteen.cards[3].code,existingUser,signupScan])).state,'success');
  assert.equal((await q('SELECT attributed_signup FROM promo_codes WHERE code=$1',[nineteen.cards[2].code]))[0].attributed_signup,true);
  assert.equal((await q('SELECT attributed_signup FROM promo_codes WHERE code=$1',[nineteen.cards[3].code]))[0].attributed_signup,false);
  assert.equal((await rpc('promo_report',[])).designs[0].signups,1,'only an account created after its verified scan counts as a signup');
  await db.exec("UPDATE promo_settings SET claim_limit='monthly'; UPDATE promo_codes SET redeemed_at=now()-interval '2 months' WHERE redeemed_at IS NOT NULL");
  assert.equal((await rpc('claim_promo_code',[nineteen.cards[0].code,a,null])).state,'success');
  assert.equal((await rpc('claim_promo_code',[nineteen.cards[1].code,a,null])).state,'limit');
  await db.exec('SET ROLE anon');
  await assert.rejects(()=>q('SELECT * FROM promo_codes'));
  await assert.rejects(()=>rpc('claim_promo_code',[next.cards[0].code,c,null]));
  await db.exec('RESET ROLE');

  // Old completed orders can export even when no shipping record exists.
  const legacyOrder=randomUUID();
  await q("INSERT INTO orders(id,user_id,status) VALUES($1,$2,'completed')",[legacyOrder,owner]);
  const legacyRun=await rpc('allocate_promo_run',[legacyOrder,'standard',1,18]);
  await rpc('mark_promo_printed',[legacyRun.runId]);
  await q("UPDATE orders SET status='shipped' WHERE id=$1",[legacyOrder]);
  await db.exec(stackMigration);
  assert.equal((await q('SELECT expiry_months FROM promo_settings'))[0].expiry_months,12,'rerunning preserves a chosen 12-month setting');
  assert.deepEqual((await q(deadlineQuery,[next.cards[0].code]))[0],deadline);
});
test('upgrade restores exported stack inventory and preserves preview-only and redeemed codes', async t => {
  const { db, q, rpc } = await legacyPromoDatabase(t);
  const source = randomUUID(), recipient = randomUUID(), unshipped = randomUUID();
  await q("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'recipient@qa.test',now())",[recipient]);
  await q('INSERT INTO orders(id) VALUES($1),($2)',[source,unshipped]);
  await db.exec("UPDATE promo_settings SET enabled=true,back_file='back'; INSERT INTO promo_designs(name,front_file,preview_file,status) VALUES('Stack','front','preview','active')");
  const old = await rpc('allocate_promo_run',[source,'standard',1,18]);
  await rpc('mark_promo_printed',[old.runId]);
  await q("UPDATE orders SET status='shipped' WHERE id=$1",[source]);
  await rpc('claim_promo_code',[old.cards[0].code,recipient,null]);
  await rpc('replace_promo_run',[source,'standard']);
  const replacement = await rpc('allocate_promo_run',[source,'standard',1,18]);
  await rpc('mark_promo_printed',[replacement.runId]);
  await q("UPDATE orders SET payment_status='refunded' WHERE id=$1",[source]);
  const waiting = await rpc('allocate_promo_run',[unshipped,'standard',1,18]);
  await rpc('mark_promo_printed',[waiting.runId]);
  const preview = await rpc('allocate_promo_run',[unshipped,'foil',1,9]);
  const codeState = async code => (await q('SELECT status, expires_at FROM promo_codes WHERE code=$1',[code]))[0];
  assert.equal((await codeState(old.cards[1].code)).status,'void');
  assert.equal((await codeState(replacement.cards[0].code)).status,'void');
  assert.equal((await codeState(waiting.cards[0].code)).status,'issued');

  await db.exec(stackMigration);
  for (const card of [old.cards[1], replacement.cards[0], waiting.cards[0]]) {
    assert.deepEqual(await codeState(card.code),{ status: 'active', expires_at: null });
  }
  assert.equal((await codeState(preview.cards[0].code)).status,'issued');
  assert.equal((await codeState(old.cards[0].code)).status,'redeemed');
  assert.deepEqual(await q('SELECT status, account_id FROM promo_credits'),[{status:'available',account_id:recipient}]);
});

test('five-print upgrade preserves earlier claims and supports partial use, cancellation and refunds', async t => {
  const { db, q, rpc } = await legacyPromoDatabase(t);
  await db.exec(stackMigration);
  const sourceOrder = randomUUID();
  const oldRecipients = [randomUUID(), randomUUID(), randomUUID()];
  const recipient = randomUUID();
  for (const account of [...oldRecipients, recipient]) {
    await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())', [account, `${account}@test.com`]);
  }
  await q('INSERT INTO orders(id) VALUES($1)', [sourceOrder]);
  await db.exec("UPDATE promo_settings SET enabled=true,back_file='back'; INSERT INTO promo_designs(name,front_file,preview_file,status) VALUES('Five prints','front','preview','active')");
  const run = await rpc('allocate_promo_run', [sourceOrder, 'standard', 1, 18]);
  await rpc('mark_promo_printed', [run.runId]);
  for (const [index, account] of oldRecipients.entries()) {
    assert.equal((await rpc('claim_promo_code', [run.cards[index].code, account, null])).state, 'success');
  }
  await rpc('reserve_promo_credits', [oldRecipients[1], randomUUID(), 1]);
  const oldReservation = randomUUID();
  await rpc('reserve_promo_credits', [oldRecipients[2], oldReservation, 1]);
  await q('INSERT INTO orders(id,user_id,metadata) VALUES($1,$2,$3)', [randomUUID(), oldRecipients[2], JSON.stringify({promoReservation:oldReservation,promoPrints:1})]);
  const legacyQuery = 'SELECT id,account_id,source_code_id,status,reservation_id,used_order_id,used_at,created_at FROM promo_credits ORDER BY id';
  const legacyCredits = await q(legacyQuery);
  assert.deepEqual(legacyCredits.map(credit => credit.status).sort(), ['available', 'reserved', 'used']);

  await db.exec(fivePrintsMigration);
  await db.exec(fivePrintsMigration);
  assert.deepEqual(await q(legacyQuery), legacyCredits, 'repeatable upgrade preserves earlier balances and payment links');
  assert.equal((await rpc('claim_promo_code', [run.cards[0].code, oldRecipients[0], null])).state, 'claimed_by_you');
  assert.equal((await rpc('claim_promo_code', [run.cards[3].code, oldRecipients[0], null])).state, 'limit');

  const code = run.cards[3];
  assert.equal((await rpc('claim_promo_code', [code.code, recipient, null])).state, 'success', 'an existing unclaimed card grants the new reward');
  assert.deepEqual(await q('SELECT credit_number FROM promo_credits WHERE account_id=$1 ORDER BY credit_number', [recipient]), [1,2,3,4,5].map(credit_number => ({credit_number})));
  assert.equal((await rpc('claim_promo_code', [code.code, recipient, null])).state, 'claimed_by_you');
  assert.equal((await rpc('claim_promo_code', [run.cards[4].code, recipient, null])).state, 'limit');
  assert.equal((await q('SELECT status FROM promo_codes WHERE id=$1', [run.cards[4].id]))[0].status, 'active');
  await assert.rejects(() => q('INSERT INTO promo_credits(account_id,source_code_id,credit_number) VALUES($1,$2,1)', [recipient, code.id]), /unique/);
  await assert.rejects(() => q('INSERT INTO promo_credits(account_id,source_code_id,credit_number) VALUES($1,$2,6)', [recipient, code.id]), /check constraint/);

  const balance = async () => (await q(`SELECT count(*) FILTER (WHERE status='available') AS available,
    count(*) FILTER (WHERE status='reserved') AS reserved, count(*) FILTER (WHERE status='used') AS used
    FROM promo_credits WHERE account_id=$1`, [recipient]))[0];
  assert.deepEqual(await balance(), {available:5,reserved:0,used:0});
  const firstReservation = randomUUID();
  assert.equal(await rpc('reserve_promo_credits', [recipient, firstReservation, 2]), 2);
  assert.equal(await rpc('reserve_promo_credits', [recipient, firstReservation, 2]), 2, 'checkout retries reuse their reservation');
  assert.deepEqual(await balance(), {available:3,reserved:2,used:0});
  const firstPurchase = randomUUID();
  await q("INSERT INTO orders(id,user_id,status,payment_status,metadata) VALUES($1,$2,'pending','pending',$3)", [firstPurchase, recipient, JSON.stringify({promoReservation:firstReservation,promoPrints:2})]);
  await q("UPDATE orders SET status='paid',payment_status='paid' WHERE id=$1", [firstPurchase]);
  assert.deepEqual(await balance(), {available:3,reserved:0,used:2});

  const secondReservation = randomUUID();
  assert.equal(await rpc('reserve_promo_credits', [recipient, secondReservation, 10]), 3, 'another checkout can use only the remainder');
  assert.equal(await rpc('reserve_promo_credits', [recipient, randomUUID(), 1]), 0);
  const secondPurchase = randomUUID();
  await q('INSERT INTO orders(id,user_id,metadata) VALUES($1,$2,$3)', [secondPurchase, recipient, JSON.stringify({promoReservation:secondReservation,promoPrints:3})]);
  assert.deepEqual(await balance(), {available:0,reserved:0,used:5});
  await q("UPDATE orders SET payment_status='refunded' WHERE id=$1", [firstPurchase]);
  assert.deepEqual(await balance(), {available:2,reserved:0,used:3}, 'a refund restores only the prints used on that order');
  await q("UPDATE orders SET status='cancelled' WHERE id=$1", [secondPurchase]);
  await q("UPDATE orders SET payment_status='refunded' WHERE id=$1", [firstPurchase]);
  assert.deepEqual(await balance(), {available:5,reserved:0,used:0}, 'repeated refund events do not duplicate credits');

  const pendingReservation = randomUUID();
  assert.equal(await rpc('reserve_promo_credits', [recipient, pendingReservation, 2]), 2);
  const pendingPurchase = randomUUID();
  await q("INSERT INTO orders(id,user_id,status,payment_status,metadata) VALUES($1,$2,'pending','pending',$3)", [pendingPurchase, recipient, JSON.stringify({promoReservation:pendingReservation,promoPrints:2})]);
  await q("UPDATE orders SET status='cancelled' WHERE id=$1", [pendingPurchase]);
  assert.deepEqual(await balance(), {available:5,reserved:0,used:0});
  const expiredReservation = randomUUID();
  await rpc('reserve_promo_credits', [recipient, expiredReservation, 5]);
  await rpc('release_promo_reservation', [expiredReservation]);
  assert.deepEqual(await balance(), {available:5,reserved:0,used:0});
  assert.equal((await q('SELECT status FROM promo_codes WHERE id=$1', [code.id]))[0].status, 'redeemed');
  assert.equal((await rpc('promo_report', [])).designs[0].claimed, 4, 'claim statistics count cards, not individual credits');
  await db.exec(fivePrintsMigration);
  assert.deepEqual(await balance(), {available:5,reserved:0,used:0});
});
