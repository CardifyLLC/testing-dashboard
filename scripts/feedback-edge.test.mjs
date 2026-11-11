import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedbackInvitationHandler} from '../supabase/functions/_shared/feedback-invitation-handler.mjs';
import {feedbackEdge} from '../server/feedback-edge.mjs';
import {createGrowthOperationsHandler} from '../server/growth-operations.mjs';
const env={SUPABASE_URL:'https://jsxkyzdijoawzaiwfkfc.supabase.co',VITE_SUPABASE_URL:'https://jsxkyzdijoawzaiwfkfc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-secret'};
const user={id:'589de454-3be7-45f7-8f87-352bd2a7da1f',email:'kainatkhankhosa@gmail.com',email_confirmed_at:'2026-11-11'};
const body={action:'send',id:'00000000-0000-0000-0000-000000000001',order_id:'90abdf37-65d4-4f91-b095-07fe64dc931f',expected_email:'kainatkhankhosa@gmail.com'};
const request=(token='user-token',value=body)=>new Request('https://example.invalid',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(value)});
const database=(who=user,admin=true)=>({auth:{getUser:async()=>({data:{user:who}})},from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:admin?{user_id:who?.id}:null})})});
function fixture({who=user,admin=true,environment=env}={}){
  let calls=0;
  return {handler:createFeedbackInvitationHandler({env:environment,createClient:()=>database(who,admin),send:async args=>{calls++;assert.equal(args.orderId,body.order_id);return {sent:true,status:'sent'};}}),get calls(){return calls;}};
}
test('verified allowlisted testing admins can send; other or disabled users cannot',async()=>{
  for(const email of ['superiorvideo@gmail.com','placeparks@gmail.com','hannanshoukat@gmail.com','kainatkhankhosa@gmail.com']){const f=fixture({who:{...user,email}});const r=await f.handler(request());assert.equal(r.status,200);assert.equal((await r.json()).transport,'supabase-edge');assert.equal(f.calls,1);}
  for(const input of [{who:{...user,email:'other@example.com'}},{who:{...user,email_confirmed_at:null}},{admin:false}]){const f=fixture(input);assert.equal((await f.handler(request())).status,403);assert.equal(f.calls,0);}
});
test('server key, expired session and production project cannot send',async()=>{
  const f=fixture();assert.equal((await f.handler(request('server-secret'))).status,401);assert.equal(f.calls,0);
  assert.equal((await fixture({who:null}).handler(request())).status,401);
  assert.equal((await fixture({environment:{...env,SUPABASE_URL:'https://dunoesykjvdnpeavojsi.supabase.co'}}).handler(request())).status,503);
});
test('readiness and invalid requests do not send',async()=>{
  const f=fixture();const r=await f.handler(request('user-token',{action:'readiness'}));assert.equal(r.status,200);assert.ok((await r.json()).blockers.length);assert.equal((await f.handler(request('user-token',{...body,order_id:'bad'}))).status,400);assert.equal(f.calls,0);
});
test('proxy sends user session to testing Edge only',async()=>{
  await feedbackEdge({env,token:'session',body,fetchImpl:async(url,init)=>{assert.equal(url,env.SUPABASE_URL+'/functions/v1/send-feedback-invitation');assert.equal(init.headers.Authorization,'Bearer session');assert.equal(init.redirect,'error');return Response.json({sent:true});}});
  await assert.rejects(feedbackEdge({env:{VITE_SUPABASE_URL:'https://dunoesykjvdnpeavojsi.supabase.co'},token:'session',body}),/testing database/);
});
test('actual dashboard send action uses Edge proxy, not the Vercel mailer',async()=>{
  let forwarded=null,result=null;
  const handler=createGrowthOperationsHandler({env,createClient:()=>database(),edge:async args=>{forwarded=args;return {sent:true,transport:'supabase-edge'};}});
  const res={setHeader(){},end(value){result=JSON.parse(value);}};
  await handler({method:'POST',headers:{authorization:'Bearer session'},body:{...body,action:'send_feedback_invitation'}},res);
  assert.equal(res.statusCode,200);assert.equal(forwarded.token,'session');assert.equal(forwarded.body.action,'send');assert.equal(forwarded.body.order_id,body.order_id);assert.equal(result.transport,'supabase-edge');
});
test('legacy batch action cannot bypass the Edge sender',async()=>{
 let calls=0,result=null;
 const handler=createGrowthOperationsHandler({env:{...env,FEEDBACK_DELIVERY_READY:'true'},createClient:()=>database(),edge:async()=>{calls++;}});
 const res={setHeader(){},end(value){result=JSON.parse(value);}};
 await handler({method:'POST',headers:{authorization:'Bearer session'},body:{id:body.id,action:'run_feedback_batch'}},res);
 assert.equal(res.statusCode,409);assert.match(result.error,/legacy Vercel batch sender is disabled/);assert.equal(calls,0);
});
