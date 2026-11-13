const key=process.env.FEEDBACK_JOB_SECRET;
if(!key||key.length<32)throw new Error('Configure FEEDBACK_JOB_SECRET in testing Supabase and GitHub');
const response=await fetch('https://jsxkyzdijoawzaiwfkfc.supabase.co/functions/v1/feedback-scheduler',{
 method:'POST',redirect:'error',signal:AbortSignal.timeout(240000),headers:{Authorization:'Bearer '+key},
});
if(!response.ok)throw new Error('Testing feedback scan failed HTTP '+response.status+'; inspect delivery state before retrying');
const result=await response.json();
console.log(JSON.stringify({environment:result.environment,status:result.status,attempts:result.outcomes?.length}));
