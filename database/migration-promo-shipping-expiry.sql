-- Run after migration-promo-cards.sql on the shared TESTING database.
-- Keep the original shipping deadline across exports, retries and replacement runs.
BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS promo_shipped_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS promo_expires_at timestamptz;

-- Preserve known history. Do not invent a shipping date from an order's creation
-- or last update time. Orders without shipment evidence stay unanchored.
WITH history AS (
  SELECT o.id,
    coalesce(o.promo_shipped_at,
      nullif(to_jsonb(o)->>'envelope_shipped_at','')::timestamptz,
      min(c.activated_at)) AS shipped_at,
    coalesce(o.promo_expires_at,min(c.expires_at)) AS expires_at
  FROM public.orders o LEFT JOIN public.promo_codes c ON c.order_id=o.id
  GROUP BY o.id
)
UPDATE public.orders o SET
  promo_shipped_at=h.shipped_at,
  promo_expires_at=coalesce(h.expires_at,h.shipped_at+make_interval(months=>s.expiry_months))
FROM history h CROSS JOIN public.promo_settings s
WHERE o.id=h.id AND s.id AND h.shipped_at IS NOT NULL;

-- Repair already-issued replacement deadlines without reopening claimed/void codes.
UPDATE public.promo_codes c SET expires_at=o.promo_expires_at
FROM public.orders o
WHERE c.order_id=o.id AND c.activated_at IS NOT NULL
  AND o.promo_expires_at IS NOT NULL AND c.expires_at IS DISTINCT FROM o.promo_expires_at;

CREATE OR REPLACE FUNCTION public.mark_promo_printed(p_run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r promo_runs; o orders; order_id uuid;
BEGIN
 IF auth.role()<>'service_role' AND NOT public.is_dashboard_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
 SELECT pr.order_id INTO order_id FROM promo_runs pr WHERE pr.id=p_run;
 -- Match the order-before-run lock order used by allocation and replacement.
 SELECT * INTO o FROM orders WHERE id=order_id FOR UPDATE;
 SELECT * INTO r FROM promo_runs WHERE id=p_run AND current_run FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'Print run was replaced; regenerate this PDF'; END IF;
 IF lower(o.status) IN ('cancelled','canceled','refunded') OR lower(o.payment_status)='refunded' THEN RAISE EXCEPTION 'Order cancelled'; END IF;
 IF lower(o.status) IN ('shipped','completed') AND (o.promo_shipped_at IS NULL OR o.promo_expires_at IS NULL) THEN
   RAISE EXCEPTION 'Original shipping date is missing; restore the shipment record before exporting replacement promos';
 END IF;
 UPDATE promo_runs SET printed_at=coalesce(printed_at,now()) WHERE id=r.id;
 IF lower(o.status) IN ('shipped','completed') THEN
   UPDATE promo_codes SET status='active',activated_at=now(),expires_at=o.promo_expires_at
   WHERE run_id=r.id AND status='issued';
 END IF;
 UPDATE orders SET promo_reprint_requested=false WHERE id=r.order_id
   AND NOT EXISTS(SELECT 1 FROM promo_runs WHERE promo_runs.order_id=r.order_id AND current_run AND printed_at IS NULL);
END $$;

CREATE OR REPLACE FUNCTION public.promo_order_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n integer; expected integer; reservation uuid; months integer; deadline timestamptz;
BEGIN
 expected=coalesce((NEW.metadata->>'promoPrints')::integer,0);
 reservation=nullif(NEW.metadata->>'promoReservation','')::uuid;
 IF lower(NEW.payment_status)='paid' AND expected>0 AND (TG_OP='INSERT' OR lower(OLD.payment_status) IS DISTINCT FROM 'paid') THEN
   PERFORM 1 FROM promo_credits WHERE reservation_id=reservation FOR UPDATE;
   SELECT count(*) INTO n FROM promo_credits WHERE reservation_id=reservation AND account_id=NEW.user_id AND (status='reserved' OR (status='used' AND used_order_id=NEW.id));
   IF n<>expected THEN RAISE EXCEPTION 'Promo reservation does not match paid order'; END IF;
   UPDATE promo_credits SET status='used',used_order_id=NEW.id,used_at=coalesce(used_at,now()) WHERE reservation_id=reservation AND status='reserved';
 END IF;
 IF lower(NEW.status)='shipped' THEN
   SELECT expiry_months INTO months FROM promo_settings WHERE id;
   -- This update touches neither status nor payment_status, so it cannot recurse
   -- into the existing AFTER INSERT/UPDATE OF status,payment_status trigger.
   UPDATE orders SET
     promo_shipped_at=coalesce(promo_shipped_at,nullif(to_jsonb(NEW)->>'envelope_shipped_at','')::timestamptz,now()),
     promo_expires_at=coalesce(promo_expires_at,
       coalesce(promo_shipped_at,nullif(to_jsonb(NEW)->>'envelope_shipped_at','')::timestamptz,now())+make_interval(months=>months))
   WHERE id=NEW.id RETURNING promo_expires_at INTO deadline;
   UPDATE promo_codes SET status='active',activated_at=now(),expires_at=deadline
   WHERE order_id=NEW.id AND status='issued' AND run_id IN (SELECT id FROM promo_runs WHERE current_run AND printed_at IS NOT NULL);
 END IF;
 IF lower(NEW.status) IN ('cancelled','canceled','refunded') OR lower(NEW.payment_status)='refunded' THEN
   UPDATE promo_codes SET status='void' WHERE order_id=NEW.id AND status IN ('issued','active');
   UPDATE promo_credits SET status='available',reservation_id=NULL,used_order_id=NULL,used_at=NULL WHERE used_order_id=NEW.id OR (reservation_id=reservation AND status='reserved');
 END IF;
 RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.mark_promo_printed(uuid),public.promo_order_transition() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mark_promo_printed(uuid) TO authenticated,service_role;
COMMIT;

