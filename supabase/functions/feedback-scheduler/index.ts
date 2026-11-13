import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {createFeedbackSchedulerHandler} from '../_shared/feedback-scheduler.mjs';
Deno.serve(createFeedbackSchedulerHandler({createClient,env:Deno.env.toObject()}));
