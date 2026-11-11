import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryBlockers,sendTargetedFeedback} from '../server/feedback-targeted.mjs';
import {createHash} from 'node:crypto';
import {feedbackToken} from '../server/feedback-delivery.mjs';
const env={VITE_SUPABASE_URL:'https://jsxkyzdijoawzaiwfkfc.supabase.co',CUSTOMER_APP_URL:'https://testing123-prof.vercel.app',FEEDBACK_DELIVERY_READY:'true',FEEDBACK_SIGNING_SECRET:'a'.repeat(32),MARKETING_UNSUBSCRIBE_SECRET:'test-secret',GMAIL_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'mailer@example.com',private_key:'test-only'})};
function fixture({existing=null,recipient='mirachannan@gmail.com',claimRecipient=recipient,fail=false}={}){
 let sends=0,status=null,selectedOrder=null;
 const campaign={enabled:true,paused:false,timing_trigger:'created_at',delay_days:1,invitation_frequency_days:30,reward_limit_per_customer:1,expires_after_days:7,max_invitations:1,budget_prints:5,budget_email_minor:1,email_unit_cost_minor:1,audience:'all_consented_customers',email_subject:'Test',email_text:'Test',currency:'USD',qualifying_statuses:['paid'],questionnaire:[{id:'q',label:'Question'}]};
 const db={from(table){return {select(){return this;},eq(){return this;},update(v){status=v.status;return this;},async single(){return {data:table==='feedback_campaigns'?campaign:table==='orders'?{id:'order',user_id:'user'}:{email:recipient}};},async maybeSingle(){return {data:status?{id:'invitation'}:existing};}};},async rpc(name,args){if(name==='prepare_feedback_invitation'){selectedOrder=args.p_order;return {data:{id:'invitation'}};}return {data:{email:claimRecipient,subject:'Test',text:'Test',token_hash:createHash('sha256').update(feedbackToken('invitation',env.FEEDBACK_SIGNING_SECRET)).digest('hex')}};}};
 return {args:{db,env,campaignId:'campaign',orderId:'order',expectedEmail:'mirachannan@gmail.com',prepareMailer:async()=>({send:async()=>{sends++;if(fail)throw new Error('timeout');return 'receipt';}})},get sends(){return sends;},get status(){return status;},get selectedOrder(){return selectedOrder;}};
}
test('configuration rejects production and wrong storefront',()=>{assert.deepEqual(deliveryBlockers(env),[]);assert.ok(deliveryBlockers({...env,VITE_SUPABASE_URL:'https://dunoesykjvdnpeavojsi.supabase.co'}).length);assert.ok(deliveryBlockers({...env,CUSTOMER_APP_URL:'https://www.tcgplaytest.com'}).length);});
test('sends only the selected order',async()=>{const f=fixture();assert.equal((await sendTargetedFeedback(f.args)).sent,true);assert.equal(f.sends,1);assert.equal(f.selectedOrder,'order');assert.equal(f.status,'sent');});
test('existing invitation is never resent, including uncertain delivery',async()=>{for(const status of ['sent','sending','uncertain','failed','completed']){const f=fixture({existing:{id:'invitation',status}});assert.equal((await sendTargetedFeedback(f.args)).already_exists,true);assert.equal(f.sends,0);}});
test('recipient changes fail closed before sending',async()=>{for(const options of [{recipient:'other@example.com'},{claimRecipient:'other@example.com'}]){const f=fixture(options);await assert.rejects(sendTargetedFeedback(f.args),/Recipient changed/);assert.equal(f.sends,0);}});
test('ambiguous provider outcome stays uncertain',async()=>{const f=fixture({fail:true});assert.equal((await sendTargetedFeedback(f.args)).status,'uncertain');assert.equal(f.sends,1);});
