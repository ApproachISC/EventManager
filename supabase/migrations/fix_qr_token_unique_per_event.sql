-- Migration: scope qr_token uniqueness to event instead of globally
-- Run this once against the live Supabase database.

-- 1. Drop the global unique constraint
ALTER TABLE public.event_attendees
  DROP CONSTRAINT event_attendees_qr_token_key;

-- 2. Add per-event unique constraint (same code can appear in different events)
ALTER TABLE public.event_attendees
  ADD CONSTRAINT event_attendees_event_qr_unique UNIQUE (event_id, qr_token);

-- 3. Update lookup function to accept optional event filter
CREATE OR REPLACE FUNCTION public.lookup_attendee_by_qr(p_token text, p_event_id uuid DEFAULT NULL)
RETURNS TABLE (
  attendee_id   uuid,
  name          text,
  email         text,
  event_id      uuid
) LANGUAGE SQL STABLE SECURITY DEFINER AS $$
  SELECT
    p.id          AS attendee_id,
    p.name,
    p.email,
    ea.event_id
  FROM public.event_attendees ea
  JOIN public.profiles p ON p.id = ea.user_id
  WHERE ea.qr_token = p_token
    AND (p_event_id IS NULL OR ea.event_id = p_event_id);
$$;
