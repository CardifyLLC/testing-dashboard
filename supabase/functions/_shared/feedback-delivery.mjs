import {createHmac,createHash,randomUUID} from 'node:crypto';
import { createEnvelopeMailer } from './envelope-mailer.mjs';
export function feedbackToken(id,secret){if(typeof secret!=='string'||secret.length<32)throw new Error('Feedback signing secret is not configured.');return createHmac('sha256',secret).update('feedback:'+id).digest('hex');}
export async function prepareFeedback({db,campaignId,orderId,secret}){
  const id=randomUUID();const token=feedbackToken(id,secret);
  const result=await db.rpc('prepare_feedback_invitation',{p_campaign:campaignId,p_order:orderId,p_invitation:id,p_token_hash:createHash('sha256').update(token).digest('hex')});
  if(result.error)throw new Error('Invitation not eligible or unavailable.');return result.data;
}
export async function deliverFeedback({db,invitationId,secret,origin,sendEmail,unsubscribeUrl,expectedEmail}){
  const token=feedbackToken(invitationId,secret);
  if(new URL(origin).protocol!=='https:')throw new Error('HTTPS customer origin required.');
  const claimed=await db.rpc('claim_feedback_send',{p_invitation:invitationId});
  if(claimed.error)throw new Error('Could not verify invitation eligibility.');
  if(!claimed.data)return{sent:false,reason:'paused_suppressed_expired_or_already_claimed'};
  const invitation=claimed.data;
  if(expectedEmail&&invitation.email.toLowerCase()!==expectedEmail.toLowerCase())throw new Error('Recipient changed; invitation retained for review without sending.');
  if(createHash('sha256').update(token).digest('hex')!==invitation.token_hash)throw new Error('Signing key mismatch; invitation retained for review.');
  let status='sent',receipt=null;
  try{
    receipt=await sendEmail({to:invitation.email,subject:invitation.subject,text:`${invitation.text}\n\n${origin.replace(/\/$/,'')}/feedback#token=${token}\n\nUnsubscribe: ${unsubscribeUrl(invitation.email)}\n\nCompleting feedback does not subscribe you to marketing.`});
  }catch(error){status=error?.retrySafe===true?'failed':'uncertain';}
  console.info(JSON.stringify({event:'feedback_edge_delivery',invitation_id:invitationId,status,receipt}));
  const saved=await db.from('feedback_invitations').update({status,provider_reference:receipt,updated_at:new Date().toISOString(),...(status==='sent'?{sent_at:new Date().toISOString()}:{})}).eq('id',invitationId).eq('status','sending').select('id').maybeSingle();
  if(saved.error||!saved.data)throw new Error('Delivery outcome uncertain; inspect mail provider before retrying.');
  return{sent:status==='sent',status,receipt};
}

