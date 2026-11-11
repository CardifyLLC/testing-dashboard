import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyFeedbackTestService} from '../supabase/functions/_shared/feedback-test-auth.mjs';
const id='9c49b7c6-d3a4-4718-bf6f-d27848046bac';
const jwt=(claims={})=>'header.'+Buffer.from(JSON.stringify({role:'service_role',ref:'jsxkyzdijoawzaiwfkfc',exp:Math.floor(Date.now()/1000)+600,...claims})).toString('base64url')+'.signature';
const req=token=>new Request('https://example.invalid',{headers:token?{Authorization:'Bearer '+token}:{}});
test('accepts only service token validated by testing Auth admin API',async()=>{
  const token=jwt();let calls=0;
  assert.equal(await verifyFeedbackTestService(req(token),async(url,init)=>{
    calls++;assert.equal(url,`https://jsxkyzdijoawzaiwfkfc.supabase.co/auth/v1/admin/users/${id}`);assert.equal(init.headers.apikey,token);
    return Response.json({id});
  }),token);assert.equal(calls,1);
});
test('missing, malformed, anon, user, expired and foreign-project tokens cannot reach admin API',async()=>{
  for(const token of [null,'bad',jwt({role:'anon'}),jwt({role:'authenticated'}),jwt({exp:1}),jwt({ref:'production'})]){
    assert.equal(await verifyFeedbackTestService(req(token),()=>{throw new Error('Must not fetch');}),null);
  }
});
test('unverified claims, wrong response and network failures never authorize',async()=>{
  for(const fetchImpl of [async()=>new Response(null,{status:401}),async()=>new Response(null,{status:500}),async()=>Response.json({id:'wrong'}),async()=>{throw new Error('offline');}])assert.equal(await verifyFeedbackTestService(req(jwt()),fetchImpl),null);
});
