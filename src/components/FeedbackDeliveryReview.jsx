import { useEffect, useState } from 'react';

export default function FeedbackDeliveryReview({items,canApprove,busy,onReview}){
 const [drafts,setDrafts]=useState({});
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60000);return()=>clearInterval(timer);},[]);
 const edit=(id,key,value)=>setDrafts(current=>({...current,[id]:{...current[id],[key]:value}}));
 if(!items?.length)return null;
 return <section aria-label="Feedback delivery review"><h2>Feedback delivery review</h2>
  <p>Check the provider’s logs before recording an outcome. This records evidence and sends no email. Confirmed rejection permits a bounded retry after 15 minutes.</p>
  {items.map(item=>{const draft=drafts[item.id]||{};const reviewable=item.status==='uncertain'||(item.status==='sending'&&now-Date.parse(item.updated_at)>30*60000);
   return <article key={item.id}><h3>Order {item.order_id}</h3><p>{item.status} · {item.send_attempts} attempts · Updated {new Date(item.updated_at).toLocaleString()}</p>
    {canApprove&&reviewable&&<form onSubmit={event=>{event.preventDefault();onReview({action:'review_feedback_delivery',id:item.id,outcome:draft.outcome||'accepted',reference:draft.reference,note:draft.note});}}>
     <label>Verified provider outcome<select value={draft.outcome||'accepted'} onChange={e=>edit(item.id,'outcome',e.target.value)}><option value="accepted">Accepted by provider</option><option value="not_accepted">Confirmed not accepted</option></select></label>
     <label>Provider message or investigation reference<input required maxLength={500} value={draft.reference||''} onChange={e=>edit(item.id,'reference',e.target.value)}/></label>
     <label>Evidence checked<textarea required minLength={10} maxLength={2000} value={draft.note||''} onChange={e=>edit(item.id,'note',e.target.value)}/></label>
     <button disabled={busy}>Record reviewed outcome</button></form>}
   </article>;
  })}
 </section>;
}
