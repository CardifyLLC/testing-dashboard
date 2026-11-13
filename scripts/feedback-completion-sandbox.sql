\set ON_ERROR_STOP on
BEGIN;
INSERT INTO profiles VALUES('00000000-0000-0000-0000-000000000002','sandbox@example.invalid');
INSERT INTO marketing_subscribers VALUES('sandbox@example.invalid','subscribed',now(),'Explicit isolated test consent');
INSERT INTO orders(id,user_id,status,payment_status,created_at) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','completed','paid',now()-interval '8 days');
UPDATE feedback_campaigns SET enabled=true,paused=false,timing_trigger='created_at',delay_days=7,qualifying_statuses=ARRAY['completed'],invitation_frequency_days=30,reward_limit_per_customer=1,expires_after_days=14,audience='all_consented_customers',email_subject='sandbox',email_text='sandbox',questionnaire='[{"id":"quality","label":"How was it?"}]',max_invitations=1,budget_prints=5,budget_email_minor=3,email_unit_cost_minor=1,currency='USD',approved_by='00000000-0000-0000-0000-000000000003',approved_at=now();
SET LOCAL ROLE service_role;
SELECT prepare_feedback_invitation((SELECT id FROM feedback_campaigns LIMIT 1),'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004',repeat('a',64));
RESET ROLE;
CREATE FUNCTION pg_temp.expect_claim_blocked() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF claim_feedback_send('00000000-0000-0000-0000-000000000004') IS NOT NULL THEN RAISE EXCEPTION 'Unsafe send accepted'; END IF;
END $$;
UPDATE feedback_campaigns SET paused=true;
SELECT pg_temp.expect_claim_blocked();
UPDATE feedback_campaigns SET paused=false;
UPDATE feedback_invitations SET status='uncertain';
SELECT pg_temp.expect_claim_blocked();
UPDATE feedback_invitations SET status='failed',send_attempts=1,updated_at=now();
SELECT pg_temp.expect_claim_blocked();
UPDATE feedback_invitations SET send_attempts=3,updated_at=now()-interval '1 hour';
SELECT pg_temp.expect_claim_blocked();
UPDATE feedback_invitations SET status='pending',send_attempts=0;
UPDATE orders SET user_id='00000000-0000-0000-0000-000000000003';
SELECT pg_temp.expect_claim_blocked();
DO $$ BEGIN IF (SELECT status FROM feedback_invitations LIMIT 1)<>'suppressed' THEN RAISE EXCEPTION 'Account reassignment not suppressed'; END IF; END $$;
UPDATE orders SET user_id='00000000-0000-0000-0000-000000000002';
UPDATE feedback_invitations SET status='pending';
UPDATE marketing_subscribers SET status='unsubscribed';
SELECT pg_temp.expect_claim_blocked();
UPDATE marketing_subscribers SET status='subscribed';
UPDATE feedback_invitations SET status='failed',send_attempts=1,updated_at=now()-interval '1 hour';
SET LOCAL ROLE service_role;
DO $$ BEGIN
 IF (SELECT count(*) FROM feedback_due_orders((SELECT id FROM feedback_campaigns LIMIT 1),ARRAY['other@example.invalid'],5))<>0 THEN RAISE EXCEPTION 'Allowlist bypass'; END IF;
 IF (SELECT count(*) FROM feedback_due_orders((SELECT id FROM feedback_campaigns LIMIT 1),ARRAY['sandbox@example.invalid'],5))<>1 THEN RAISE EXCEPTION 'Failed retry not selected'; END IF;
 IF claim_feedback_send('00000000-0000-0000-0000-000000000004') IS NULL THEN RAISE EXCEPTION 'Eligible retry denied'; END IF;
 IF claim_feedback_send('00000000-0000-0000-0000-000000000004') IS NOT NULL THEN RAISE EXCEPTION 'Duplicate send claimed'; END IF;
 IF (SELECT send_attempts FROM feedback_invitations LIMIT 1)<>2 THEN RAISE EXCEPTION 'Wrong attempt count'; END IF;
END $$;
RESET ROLE;
UPDATE feedback_invitations SET status='uncertain';
INSERT INTO dashboard_admins VALUES('00000000-0000-0000-0000-000000000003',true);
SET LOCAL ROLE service_role;
SELECT review_feedback_delivery('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','not_accepted','synthetic-provider-investigation','Provider test confirmed rejection.');
DO $$ BEGIN
 IF (SELECT count(*) FROM feedback_delivery_reviews)<>1 OR (SELECT status FROM feedback_invitations LIMIT 1)<>'failed' THEN RAISE EXCEPTION 'Delivery review was not recorded'; END IF;
 IF claim_feedback_send('00000000-0000-0000-0000-000000000004') IS NOT NULL THEN RAISE EXCEPTION 'Review bypassed retry backoff'; END IF;
 BEGIN
  PERFORM review_feedback_delivery('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003','not_accepted','same','Duplicate review must fail.');
  RAISE EXCEPTION 'TEST FAILED duplicate review';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
ROLLBACK;
