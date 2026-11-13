import {createHmac,createHash} from 'node:crypto';
import {prepareFeedback,deliverFeedback,feedbackToken} from './feedback-delivery.mjs';
import {createEnvelopeMailer} from './envelope-mailer.mjs';
import {validateCampaign} from './feedback-campaign.mjs';
export function deliveryBlockers(env){
  const reasons=[];
  if(env.SUPABASE_URL!=='https://jsxkyzdijoawzaiwfkfc.supabase.co')reasons.push('Feedback sending requires the testing database');
  if(env.FEEDBACK_DELIVERY_READY!=='true')reasons.push('FEEDBACK_DELIVERY_READY must be true');
  if(env.CUSTOMER_APP_URL!=='https://testing123-prof.vercel.app')reasons.push('CUSTOMER_APP_URL must be https://testing123-prof.vercel.app');
  try{feedbackToken('check',env.FEEDBACK_SIGNING_SECRET);}catch{reasons.push('FEEDBACK_SIGNING_SECRET must contain at least 32 characters');}
  if(!(env.MARKETING_UNSUBSCRIBE_SECRET||env.MARKETING_SYNC_SECRET))reasons.push('Missing unsubscribe signing secret');
  try{const account=JSON.parse(env.GMAIL_SERVICE_ACCOUNT_JSON);if(!account.client_email||!account.private_key)throw new Error();}catch{reasons.push('Missing or invalid Gmail service account configuration');}
  return reasons;
}
export async function sendTargetedFeedback({db,env,campaignId,orderId,expectedEmail,prepareMailer=()=>createEnvelopeMailer({env:name=>env[name]}).prepare()}){
  const blockers=deliveryBlockers(env);if(blockers.length)throw new Error(blockers.join('; '));
  const c=await db.from('feedback_campaigns').select('*').eq('id',campaignId).single();
  if(c.error||!c.data?.enabled||c.data.paused)throw new Error('Campaign must be approved and enabled first.');
  validateCampaign(c.data);
  const o=await db.from('orders').select('id,user_id').eq('id',orderId).single();
  if(o.error||!o.data?.user_id)throw new Error('Order has no linked account.');
  const p=await db.from('profiles').select('email').eq('id',o.data.user_id).single();
  if(p.error||!p.data?.email||p.data.email.toLowerCase()!==expectedEmail.toLowerCase())throw new Error('Recipient changed. Refresh eligibility before sending.');
  const existing=await db.from('feedback_invitations').select('id,status,user_id,token_hash,expires_at,send_attempts').eq('campaign_id',campaignId).eq('order_id',orderId).maybeSingle();
  if(existing.error)throw new Error('Cannot check previous delivery.');
  if(existing.data&&!['pending','failed'].includes(existing.data.status))return {sent:false,status:existing.data.status,already_exists:true};
  if(existing.data?.send_attempts>=3)return {sent:false,status:'retry_limit',already_exists:true};
  if(existing.data){
    if(existing.data.user_id!==o.data.user_id||!Number.isFinite(Date.parse(existing.data.expires_at))||Date.parse(existing.data.expires_at)<=Date.now())throw new Error('Pending invitation expired or account changed.');
    const hash=createHash('sha256').update(feedbackToken(existing.data.id,env.FEEDBACK_SIGNING_SECRET)).digest('hex');
    if(hash!==existing.data.token_hash)throw new Error('Use the original FEEDBACK_SIGNING_SECRET in Edge secrets. Invitation left pending; nothing sent.');
  }
  const mailer=await prepareMailer();
  const invitation=existing.data||await prepareFeedback({db,campaignId,orderId,secret:env.FEEDBACK_SIGNING_SECRET});
  // A concurrent request may have prepared the same order after the check above.
  if(invitation.already_prepared)return {sent:false,status:'already_prepared',already_exists:true};
  return deliverFeedback({db,invitationId:invitation.id,secret:env.FEEDBACK_SIGNING_SECRET,origin:env.CUSTOMER_APP_URL,expectedEmail,
    sendEmail:async email=>{try{return await mailer.send(email,'feedback-'+invitation.id+'-attempt-'+((existing.data?.send_attempts||0)+1));}catch(error){error.retrySafe=error.definitelyRejected===true;throw error;}},
    unsubscribeUrl:email=>{const normalized=email.trim().toLowerCase();const token=createHmac('sha256',env.MARKETING_UNSUBSCRIBE_SECRET||env.MARKETING_SYNC_SECRET).update(normalized).digest('hex');return env.CUSTOMER_APP_URL+'/unsubscribe?'+new URLSearchParams({email:normalized,token});},
  });
}
