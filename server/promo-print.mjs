import { createDashboardAuthorization } from './dashboard-access.mjs';
export function createPromoPrintHandler({ createClient, env = process.env, fetchImpl = fetch }) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control','private, no-store');
    const send = (status, data) => { res.statusCode=status; res.end(JSON.stringify(data)); };
    if (req.method !== 'POST') return send(405, { error:'Use POST' });
    try {
      const access = createDashboardAuthorization({ createClient, env, fetchImpl });
      const identity = await access.authenticate(req);
      const grant = await access.permissions(identity, true);
      if (!grant.permissions.includes('batcher')) return send(403,{error:'Batcher access required'});
      let body = req.body;
      if (body === undefined) { const chunks=[]; let length=0; for await(const chunk of req) { length+=chunk.length; if(length>2048) return send(413,{error:'Request too large'}); chunks.push(Buffer.from(chunk)); } body=Buffer.concat(chunks).toString(); }
      if (typeof body === 'string') body=JSON.parse(body);
      const { action, orderId, stock, count, capacity, runId } = body || {};
      const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
      const db=access.db();
      await access.recheck(identity,'batcher');
      let result;
      if(action==='allocate' && uuid.test(orderId) && ['standard','foil'].includes(stock) && Number.isSafeInteger(count) && count>0 && Number.isSafeInteger(capacity) && capacity>0 && capacity<=100) {
        result=await db.rpc('allocate_promo_run',{p_order:orderId,p_group:stock,p_count:count,p_capacity:capacity});
      } else if(action==='printed' && uuid.test(runId)) result=await db.rpc('mark_promo_printed',{p_run:runId});
      else return send(400,{error:'Invalid promo print request'});
      if(result.error) throw result.error;
      await access.recheck(identity,'batcher');
      return send(200,{data:result.data});
    } catch(e) { return send(e.status || 503,{error:e.message || 'Promo print service unavailable'}); }
  };
}
