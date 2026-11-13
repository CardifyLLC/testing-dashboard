import {timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {deliveryBlockers,sendTargetedFeedback} from './feedback-targeted.mjs';

const testingUrl='https://jsxkyzdijoawzaiwfkfc.supabase.co';
export function schedulerReady(env){
 const blockers=deliveryBlockers(env);
 if(env.SUPABASE_URL!==testingUrl)blockers.push('Automatic feedback is testing-only');
 if(env.FEEDBACK_AUTOMATION_ENABLED!=='true')blockers.push('Automatic feedback is disabled');
 const recipients=(env.FEEDBACK_TEST_RECIPIENTS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
 if(!recipients.length||recipients.some(v=>!/^\S+@\S+\.\S+$/.test(v)||/[\r\n]/.test(v)))blockers.push('Explicit testing recipient allowlist required');
 return{blockers,recipients:[...new Set(recipients)]};
}
export async function runFeedbackScheduler({db,env,send=sendTargetedFeedback,now=new Date()}){
 const {blockers,recipients}=schedulerReady(env);
 if(blockers.length)throw new Error(blockers.join('; '));
 const campaigns=await db.from('feedback_campaigns').select('id').eq('enabled',true).eq('paused',false).not('approved_by','is',null);
 if(campaigns.error)throw new Error('Campaign source unavailable');
 const outcomes=[];
 let attempted=0;
 for(const campaign of campaigns.data){
  const candidates=await db.rpc('feedback_due_orders',{p_campaign:campaign.id,p_allowed_emails:recipients,p_limit:5-attempted});
  if(candidates.error)throw new Error('Candidate selection unavailable');
  for(const candidate of candidates.data){
   if(!recipients.includes(candidate.email?.toLowerCase()))throw new Error('Candidate outside testing allowlist');
   const result=await send({db,env,campaignId:campaign.id,orderId:candidate.order_id,expectedEmail:candidate.email});
   outcomes.push({campaign_id:campaign.id,order_id:candidate.order_id,...result});
   attempted++;
   if(attempted>=5)break;
  }
  if(attempted>=5)break;
 }
 const incomplete=outcomes.some(o=>['uncertain','failed'].includes(o.status));
 const heartbeat=await db.from('operation_health').upsert({id:'feedback-scheduler',status:incomplete?'failed':'ok',checked_at:now.toISOString(),max_age_minutes:45,owner:env.OPERATIONS_OWNER||'superiorvideo@gmail.com',detail:incomplete?'Failed or uncertain email outcome requires review':`Testing scan completed; ${attempted} attempts`});
 if(heartbeat.error)throw new Error('Scheduler heartbeat unavailable');
 return{environment:'testing',status:incomplete?'incomplete':'completed',outcomes};
}
export function createFeedbackSchedulerHandler({createClient,env,run=runFeedbackScheduler}){
 return async request=>{
  if(request.method!=='POST')return Response.json({error:'POST required'},{status:405});
  const actual=request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1]||'',expected=env.FEEDBACK_JOB_SECRET||'';
  if(expected.length<32||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return Response.json({error:'Job authentication required'},{status:401});
  if(env.SUPABASE_URL!==testingUrl)return Response.json({error:'Testing project required'},{status:403});
  let db;
  try{
   const body=await request.text();
   if(body.length>200)return Response.json({error:'Request too large'},{status:413});
   if(body&&JSON.parse(body).action==='readiness')return Response.json(schedulerReady(env),{headers:{'Cache-Control':'no-store'}});
   db=createClient(env.SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
   const result=await run({db,env});
   return Response.json(result,{status:result.status==='incomplete'?503:200,headers:{'Cache-Control':'no-store'}});
  }catch{
   if(db)try{await db.from('operation_health').upsert({id:'feedback-scheduler',status:'failed',checked_at:new Date().toISOString(),max_age_minutes:45,owner:env.OPERATIONS_OWNER||'superiorvideo@gmail.com',detail:'Testing scan failed; inspect workflow, readiness and delivery records before retry'});}catch{ /* The workflow fallback also reports storage failures. */ }
   return Response.json({error:'Feedback scan incomplete; check readiness, campaign rules and delivery records'},{status:503});
  }
 };
}
