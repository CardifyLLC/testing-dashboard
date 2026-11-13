import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulerReady,runFeedbackScheduler,createFeedbackSchedulerHandler} from '../supabase/functions/_shared/feedback-scheduler.mjs';
const env={SUPABASE_URL:'https://jsxkyzdijoawzaiwfkfc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server',FEEDBACK_JOB_SECRET:'x'.repeat(32),FEEDBACK_AUTOMATION_ENABLED:'true',FEEDBACK_DELIVERY_READY:'true',CUSTOMER_APP_URL:'https://testing123-prof.vercel.app',FEEDBACK_SIGNING_SECRET:'s'.repeat(32),MARKETING_UNSUBSCRIBE_SECRET:'u'.repeat(32),GMAIL_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'sender@example.invalid',private_key:'fake'}),FEEDBACK_TEST_RECIPIENTS:'owned@example.invalid'};
test('automatic feedback requires explicit testing scope and recipient allowlist',()=>{
 assert.deepEqual(schedulerReady(env).blockers,[]);
 assert.ok(schedulerReady({...env,SUPABASE_URL:'https://dunoesykjvdnpeavojsi.supabase.co'}).blockers.length);
 assert.ok(schedulerReady({...env,FEEDBACK_TEST_RECIPIENTS:''}).blockers.length);
 assert.ok(schedulerReady({...env,FEEDBACK_AUTOMATION_ENABLED:'false'}).blockers.length);
});
test('scheduler uses database candidates, reuses atomic sender and records a heartbeat',async()=>{
 let sent=0,heartbeat;
 const db={from(table){return{select(){return this;},eq(){return this;},async not(){return{data:[{id:'campaign'}]};},async upsert(row){heartbeat=row;return{};}};},async rpc(name,args){assert.equal(name,'feedback_due_orders');assert.deepEqual(args.p_allowed_emails,['owned@example.invalid']);return{data:[{order_id:'order',email:'owned@example.invalid'}]};}};
 const result=await runFeedbackScheduler({db,env,send:async args=>{assert.equal(args.expectedEmail,'owned@example.invalid');sent++;return{status:'sent',sent:true};}});
 assert.equal(sent,1);assert.equal(result.outcomes.length,1);assert.equal(heartbeat.status,'ok');
 db.rpc=async()=>({data:[{order_id:'order',email:'stranger@example.invalid'}]});
 await assert.rejects(runFeedbackScheduler({db,env,send:()=>assert.fail()}),/allowlist/);
});
test('unauthenticated requests and production projects cannot run the scheduled sender',async()=>{
 for(const [configuration,authorization,status] of [[env,'',401],[{...env,SUPABASE_URL:'https://dunoesykjvdnpeavojsi.supabase.co'},'Bearer '+env.FEEDBACK_JOB_SECRET,403]]){
  const handler=createFeedbackSchedulerHandler({env:configuration,createClient:()=>assert.fail(),run:()=>assert.fail()});
  assert.equal((await handler(new Request('https://example.invalid',{method:'POST',headers:{authorization}}))).status,status);
 }
});

test('scan exceptions replace a previous healthy heartbeat with a failed status',async()=>{
 let heartbeat;
 const handler=createFeedbackSchedulerHandler({env,createClient:()=>({from:()=>({upsert:async row=>{heartbeat=row;return{};}})}),run:async()=>{throw new Error('Provider unavailable');}});
 const response=await handler(new Request('https://example.invalid',{method:'POST',headers:{authorization:'Bearer '+env.FEEDBACK_JOB_SECRET},body:'{}'}));
 assert.equal(response.status,503);assert.equal(heartbeat.status,'failed');assert.equal(heartbeat.id,'feedback-scheduler');
 assert.equal((await response.text()).includes('Provider unavailable'),false);
});
