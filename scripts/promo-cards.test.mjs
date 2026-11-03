import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { promoSlots, promoBackSvg } from '../src/services/promoCards.mjs';
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
  await assert.rejects(()=>promoBackSvg('INVALID','data:image/png;base64,AAAA'));
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

test('database lifecycle, claims, checkout holds, refunds and access controls', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.uid',true),'')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'service_role'::text $$;
      CREATE FUNCTION public.is_dashboard_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('app.admin',true),'true')='true' $$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,created_at timestamptz DEFAULT now());
      CREATE TABLE public.orders(id uuid PRIMARY KEY,user_id uuid,customer_email text,status text DEFAULT 'paid',payment_status text DEFAULT 'paid',pricing_snapshot jsonb,metadata jsonb DEFAULT '{}',card_data jsonb DEFAULT '[]',deck_quantity integer DEFAULT 1);
      CREATE TABLE public.order_pdf_generations(order_id uuid,status text,attempt_count integer,started_at timestamptz,storage_path text,storage_paths jsonb DEFAULT '[]',error_message text);
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit integer,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid,bucket_id text);
    `);
    await db.exec(await readFile(new URL('../database/migration-promo-cards.sql',import.meta.url),'utf8'));
    const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
    const rpc=async(name,args) => (await q(`SELECT ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) AS value`,args))[0].value;
    const owner=randomUUID(), a=randomUUID(), b=randomUUID(), c=randomUUID(), order=randomUUID();
    for(const [id,email] of [[owner,'owner@test.com'],[a,'a@test.com'],[b,'b@test.com'],[c,'c@test.com']]) await q('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',[id,email]);
    await q('INSERT INTO orders(id,user_id,customer_email) VALUES($1,$2,$3)',[order,owner,'owner@test.com']);
    await db.exec("UPDATE promo_settings SET enabled=true,back_file='https://example.test/back.png'; INSERT INTO promo_designs(name,front_file,preview_file,status) VALUES('Design','https://example.test/front.png','preview','active');");
    const run=await rpc('allocate_promo_run',[order,'standard',1,18]);
    assert.equal(run.cards.length,17); assert.equal(new Set(run.cards.map(c=>c.code)).size,17);
    assert.deepEqual(await rpc('allocate_promo_run',[order,'standard',1,18]),run,'retry reuses codes');
    assert.equal((await rpc('claim_promo_code',[run.cards[0].code,a,null])).state,'invalid');
    await rpc('mark_promo_printed',[run.runId]);
    await q("UPDATE orders SET status='shipped' WHERE id=$1",[order]);
    assert.equal((await rpc('claim_promo_code',[run.cards[0].code,owner,null])).state,'own_card');
    assert.equal((await rpc('claim_promo_code',[run.cards[0].code,a,null])).state,'success');
    assert.equal((await rpc('claim_promo_code',[run.cards[0].code,b,null])).state,'redeemed');
    assert.equal((await rpc('claim_promo_code',[run.cards[1].code,a,null])).state,'limit');
    assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[run.cards[1].code]))[0].status,'active');
    const claims=await Promise.all([rpc('claim_promo_code',[run.cards[1].code,b,null]),rpc('claim_promo_code',[run.cards[2].code,b,null])]);
    assert.equal(claims.filter(c=>c.state==='success').length,1);
    const res=randomUUID(); assert.equal(await rpc('reserve_promo_credits',[a,res,10]),1);
    assert.equal(await rpc('reserve_promo_credits',[a,randomUUID(),10]),0);
    const purchase=randomUUID();
    await q("INSERT INTO orders(id,user_id,status,payment_status,metadata) VALUES($1,$2,'pending','pending',$3)",[purchase,a,JSON.stringify({promoReservation:res,promoPrints:1})]);
    await q("UPDATE orders SET status='paid',payment_status='paid' WHERE id=$1",[purchase]);
    assert.equal((await q('SELECT status FROM promo_credits WHERE account_id=$1',[a]))[0].status,'used');
    await q("UPDATE orders SET payment_status='refunded' WHERE id=$1",[purchase]);
    assert.equal((await q('SELECT status FROM promo_credits WHERE account_id=$1',[a]))[0].status,'available');
    await q("UPDATE promo_codes SET expires_at=now()-interval '1 day' WHERE code=$1",[run.cards[3].code]);
    assert.equal((await rpc('claim_promo_code',[run.cards[3].code,c,null])).state,'expired');
    await q('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[c]);
    assert.equal((await rpc('claim_promo_code',[run.cards[4].code,c,null])).state,'verify_email');
    await rpc('replace_promo_run',[order,'standard']);
    assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[run.cards[4].code]))[0].status,'void');
    assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[run.cards[0].code]))[0].status,'redeemed');
    const next=await rpc('allocate_promo_run',[order,'standard',1,18]); assert.notEqual(next.runId,run.runId);
    await rpc('mark_promo_printed',[next.runId]);
    assert.equal((await q('SELECT status FROM promo_codes WHERE code=$1',[next.cards[0].code]))[0].status,'active','shipped replacement activates only after export');
    assert.equal((await q('SELECT promo_reprint_requested FROM orders WHERE id=$1',[order]))[0].promo_reprint_requested,false);
    await q("UPDATE orders SET status='cancelled' WHERE id=$1",[order]);
    assert.equal((await rpc('claim_promo_code',[next.cards[0].code,c,null])).state,'invalid');
    const emptyOrder=randomUUID();
    await q('INSERT INTO orders(id,user_id) VALUES($1,$2)',[emptyOrder,owner]);
    await db.exec("UPDATE promo_designs SET status='retired'");
    const blank=await rpc('allocate_promo_run',[emptyOrder,'standard',5,18]);
    assert.equal(blank.cards.length,0); assert.match(blank.warning,/No active/);
    const released=randomUUID(); assert.equal(await rpc('reserve_promo_credits',[a,released,1]),1);
    await rpc('release_promo_reservation',[released]);
    assert.equal((await q('SELECT status FROM promo_credits WHERE account_id=$1',[a]))[0].status,'available');
    const report=await rpc('promo_report',[]); assert.equal(report.designs[0].claimed,2);
    await db.exec("UPDATE promo_designs SET status='active'");
    const structured=randomUUID();
    await q('INSERT INTO orders(id,user_id,card_data) VALUES($1,$2,$3)',[structured,owner,JSON.stringify([{quantity:19,finish:'standard'}])]);
    await assert.rejects(()=>rpc('allocate_promo_run',[structured,'standard',1,18]),/Export every card/);
    const nineteen=await rpc('allocate_promo_run',[structured,'standard',19,18]);
    assert.equal(nineteen.cards.length,17);
    assert.equal((await q('SELECT DISTINCT sheet_no FROM promo_codes WHERE run_id=$1',[nineteen.runId]))[0].sheet_no,2);
    await rpc('mark_promo_printed',[nineteen.runId]); await q("UPDATE orders SET status='shipped' WHERE id=$1",[structured]);
    await db.exec("UPDATE promo_settings SET claim_limit='monthly'; UPDATE promo_codes SET redeemed_at=now()-interval '2 months' WHERE redeemed_at IS NOT NULL");
    assert.equal((await rpc('claim_promo_code',[nineteen.cards[0].code,a,null])).state,'success');
    assert.equal((await rpc('claim_promo_code',[nineteen.cards[1].code,a,null])).state,'limit');
    await db.exec('SET ROLE anon');
    await assert.rejects(()=>q('SELECT * FROM promo_codes'));
    await assert.rejects(()=>rpc('claim_promo_code',[next.cards[0].code,c,null]));
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});
