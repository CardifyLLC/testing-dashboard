import { isPartnerOrder } from '../src/services/partnerArtwork.mjs';
import { createClient } from '@supabase/supabase-js';
import { buildOrderPdfParts, cardsFromOrder, generateOrderPdf, prepareOrderImage, TARGET_DPI, IMAGE_QUALITY } from './order-pdf-document.mjs';
import { downloadOrderImage } from './download-order-image.mjs';
import { addOrderPromos } from './order-pdf-promos.mjs';
import { markPromosPrinted } from '../src/services/promoCards.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_WORKFLOW_TOKEN = process.env.GITHUB_WORKFLOW_TOKEN;
const GITHUB_REPOSITORY_NAME = process.env.GITHUB_REPOSITORY_NAME;
const CUSTOMER_APP_URL = (process.env.CUSTOMER_APP_URL || 'https://tcgplaytest.com').replace(/\/$/, '');
const ORDER_PDF_WEBHOOK_SECRET = process.env.ORDER_PDF_WEBHOOK_SECRET;
const MAX_ORDERS = Math.max(1, Number.parseInt(process.env.MAX_ORDERS || '3', 10) || 3);
const MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.MAX_ATTEMPTS || '5', 10) || 5);
const STALE_MS = 30 * 60 * 1000;
class MissingImageCandidateError extends Error {}
class MissingOrderImageError extends Error {}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const fetchImage = async urls => {
  let lastError;
  let lastMissingError;
  let sawTemporaryFailure = false;
  for (const url of urls) {
    try {
      let bytes;
      if (url.startsWith('data:')) {
        const match = url.match(/^data:[^;,]+;base64,(.+)$/s);
        if (!match) throw new MissingImageCandidateError('invalid inline image data');
        bytes = Buffer.from(match[1], 'base64');
      } else {
        const response = await downloadOrderImage(url, {
          apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        });
        if (response.status === 404 || response.status === 410) {
          throw new MissingImageCandidateError(`missing object (HTTP ${response.status}) from ${url}`);
        }
        if (!response.ok) throw new Error(`temporary download failure (HTTP ${response.status}) from ${url}`);
        bytes = response.bytes;
      }
      if (!bytes.length) throw new MissingImageCandidateError(`empty image object from ${url}`);
      try {
        return await prepareOrderImage(bytes);
      } catch (error) {
        throw new MissingImageCandidateError(`invalid or corrupted image from ${url}: ${error.message}`);
      }
    } catch (error) {
      lastError = error;
      if (error instanceof MissingImageCandidateError) lastMissingError = error;
      else sawTemporaryFailure = true;
    }
  }
  if (!sawTemporaryFailure && lastMissingError) {
    throw new MissingOrderImageError(`Order card image is missing or invalid after checking ${urls.length} source(s): ${lastMissingError.message}`);
  }
  throw new Error(`Could not prepare an order image because of a temporary download or processing failure after trying ${urls.length} source(s): ${lastError?.message || 'no usable URL'}`);
};

const updateJob = async (orderId, changes) => {
  const { error } = await supabase.from('order_pdf_generations').update({
    ...changes,
    updated_at: new Date().toISOString(),
  }).eq('order_id', orderId);
  if (error) throw error;
};

const notifyCustomerRepairRequired = async orderId => {
  if (!ORDER_PDF_WEBHOOK_SECRET) {
    console.warn('Customer repair email skipped: ORDER_PDF_WEBHOOK_SECRET is not configured.');
    return;
  }
  const response = await fetch(`${CUSTOMER_APP_URL}/api/internal/order-image-failure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': ORDER_PDF_WEBHOOK_SECRET },
    body: JSON.stringify({ orderId }),
  });
  if (!response.ok) throw new Error(`Customer repair notification returned HTTP ${response.status}.`);
};

const backfillMissingJobs = async () => {
  const { data: paidOrders, error: ordersError } = await supabase
    .from('orders').select('id,metadata').ilike('status', 'paid').order('created_at', { ascending: true }).limit(1000);
  if (ordersError) throw ordersError;
  if (!paidOrders?.length) return;
  const ids = paidOrders.filter(order=>!isPartnerOrder(order)).map(order => order.id);
  if (!ids.length) return;
  const { data: existing, error: jobsError } = await supabase
    .from('order_pdf_generations').select('order_id').in('order_id', ids);
  if (jobsError) throw jobsError;
  const existingIds = new Set((existing || []).map(job => job.order_id));
  const missing = ids.filter(id => !existingIds.has(id)).map(order_id => ({ order_id, status: 'processing' }));
  if (missing.length) {
    const { error } = await supabase.from('order_pdf_generations').insert(missing);
    if (error) throw error;
    console.log(`Queued ${missing.length} previously unqueued paid order(s).`);
  }
};

const findJobs = async () => {
  // Follow order creation time, not job update time. Backfilled generation rows
  // can share nearly identical timestamps, so ordering the jobs themselves does
  // not reliably prioritize the newest customer orders.
  const { data: recentOrders, error: ordersError } = await supabase.from('orders')
    .select('id, created_at, metadata').or('status.ilike.paid,promo_reprint_requested.eq.true')
    .order('created_at', { ascending: false }).limit(1000);
  if (ordersError) throw ordersError;
  if (!recentOrders?.length) return [];
  const recentIds = recentOrders.filter(order=>!isPartnerOrder(order)).map(order => order.id);
  if (!recentIds.length) return [];
  const { data, error } = await supabase.from('order_pdf_generations')
    .select('*').in('order_id', recentIds)
    .neq('status', 'completed').lt('attempt_count', MAX_ATTEMPTS);
  if (error) throw error;
  const jobsByOrderId = new Map((data || []).map(job => [job.order_id, job]));
  const cutoff = Date.now() - STALE_MS;
  return recentIds
    .map(orderId => jobsByOrderId.get(orderId))
    .filter(job => job && (
      job.status === 'failed' || !job.started_at || new Date(job.started_at).getTime() < cutoff || Number(job.processed_cards || 0) === 0
    ))
    .slice(0, MAX_ORDERS);
};

const processJob = async job => {
  // A job may have completed after findJobs() read the queue (for example, if
  // another worker finished it). Re-check immediately before doing any work so
  // an existing completed PDF is never regenerated or overwritten.
  const { data: currentJob, error: currentJobError } = await supabase
    .from('order_pdf_generations')
    .select('status')
    .eq('order_id', job.order_id)
    .maybeSingle();
  if (currentJobError) throw currentJobError;
  if (!currentJob || currentJob.status === 'completed') {
    console.log(`Skipping ${job.order_id}: PDF is already completed.`);
    return;
  }

  const startedAt = new Date().toISOString();
  await updateJob(job.order_id, {
    status: 'processing', error_message: null, started_at: startedAt,
    attempt_count: Number(job.attempt_count || 0) + 1,
  });
  try {
    const { data: order, error } = await supabase.from('orders').select('*').eq('id', job.order_id).single();
    if (error) throw error;
    if (String(order.status || '').toLowerCase() !== 'paid' && !(order.promo_reprint_requested && ['shipped','processing','completed'].includes(String(order.status).toLowerCase()))) throw new Error('Order is no longer printable.');
    const customerCards = cardsFromOrder(order, SUPABASE_URL);
    if (!customerCards.length) throw new Error('Order has no printable cards.');
    const { cards, runIds } = await addOrderPromos(supabase, order, customerCards);
    const parts = buildOrderPdfParts(cards);
    const totalParts = parts.length;
    const storagePaths = [];
    await updateJob(order.id, {
      total_cards: cards.length, processed_cards: 0, total_parts: totalParts,
      completed_parts: 0, storage_path: null, storage_paths: [],
    });
    console.log(`Generating ${order.id}: ${cards.length} card(s) in ${totalParts} file part(s).`);
    for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
      const part = parts[partIndex];
      const partStart = part.processedBefore;
      const partCards = part.cards;
      const updateProgress = async partProcessed => updateJob(order.id, {
        processed_cards: Math.min(cards.length, partStart + partProcessed),
      });
      const bytes = await generateOrderPdf(order, part, fetchImage, updateProgress);
      console.log(`Generated ${part.stock} part ${partIndex + 1}/${totalParts}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB at ${TARGET_DPI} DPI/q${IMAGE_QUALITY}.`);
      const storagePath = `${order.id}/${part.filename}`;
      const { error: uploadError } = await supabase.storage.from('order-pdfs')
        .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
      if (uploadError) throw uploadError;
      storagePaths.push(storagePath);
      await updateJob(order.id, {
        storage_path: storagePaths[0], storage_paths: storagePaths,
        processed_cards: Math.min(cards.length, partStart + partCards.length),
        completed_parts: partIndex + 1,
      });
    }
    for (const runId of runIds) await markPromosPrinted(supabase, runId);
    await updateJob(order.id, {
      status: 'completed', storage_path: storagePaths[0], storage_paths: storagePaths,
      processed_cards: cards.length, total_cards: cards.length, total_parts: totalParts, completed_parts: totalParts,
      completed_at: new Date().toISOString(), error_message: null, repair_required: false,
    });
    if (order.promo_reprint_requested) {
      const { error: resetError } = await supabase.from('orders').update({promo_reprint_requested:false}).eq('id',order.id);
      if (resetError) throw resetError;
    }
    console.log(`Completed ${order.id}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const repairRequired = error instanceof MissingOrderImageError;
    const nextAttemptCount = Number(job.attempt_count || 0) + 1;
    const finalAttemptFailed = nextAttemptCount >= MAX_ATTEMPTS;
    await updateJob(job.order_id, {
      status: 'failed', error_message: message.slice(0, 1000),
      repair_required: repairRequired && finalAttemptFailed,
    });
    if (repairRequired && finalAttemptFailed) {
      try {
        await notifyCustomerRepairRequired(job.order_id);
      } catch (notificationError) {
        console.error(`Could not notify customer for ${job.order_id}: ${notificationError.message}`);
      }
    }
    console.error(`Failed ${job.order_id}: ${message}`);
  }
};

const dispatchContinuation = async () => {
  if (!GITHUB_WORKFLOW_TOKEN || !GITHUB_REPOSITORY_NAME) {
    console.log('Continuation dispatch is unavailable outside GitHub Actions.');
    return;
  }
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY_NAME}/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_WORKFLOW_TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: 'order_pdf_continue' }),
  });
  if (!response.ok) throw new Error(`Could not dispatch the next PDF batch (HTTP ${response.status}).`);
  console.log('Queued the next GitHub Actions batch.');
};

await backfillMissingJobs();
const jobs = await findJobs();
console.log(`Found ${jobs.length} PDF job(s) for this run.`);
for (const job of jobs) await processJob(job);
const remainingJobs = await findJobs();
if (remainingJobs.length) await dispatchContinuation();
