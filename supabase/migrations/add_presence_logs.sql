-- ============================================================
-- Migration: IN / OUT register (presence_logs)
-- Records when an attendee leaves the room (OUT) and comes back (IN).
-- Run this once in the Supabase SQL Editor.
-- ============================================================

-- 1. Direction enum
create type public.presence_direction as enum ('in', 'out');


-- 2. Table — many rows per attendee per event (no uniqueness)
create table public.presence_logs (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id) on delete cascade,
  attendee_id  uuid not null references public.profiles(id) on delete cascade,
  direction    public.presence_direction not null,
  method       public.scan_method not null default 'qr',
  recorded_by  uuid references public.profiles(id) on delete set null,
  logged_at    timestamptz not null default now()
);

comment on table public.presence_logs is
  'IN/OUT register: one row each time an attendee leaves or returns to the room.';

create index idx_presence_event_time on public.presence_logs(event_id, logged_at);
create index idx_presence_attendee   on public.presence_logs(event_id, attendee_id, logged_at desc);


-- 3. Helper: is the caller an active taker for the event?
--    (IN/OUT is event-level, so it does not depend on an open period.)
create or replace function public.i_take_event(p_event_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.event_takers
    where event_id  = p_event_id
      and user_id   = auth.uid()
      and is_active = true
  );
$$;


-- 4. Latest IN/OUT record for an attendee (shown in the taker's modal)
create or replace function public.presence_state(
  p_event_id    uuid,
  p_attendee_id uuid
)
returns table (
  direction  public.presence_direction,
  logged_at  timestamptz
) language sql stable security definer as $$
  select pl.direction, pl.logged_at
  from public.presence_logs pl
  where pl.event_id    = p_event_id
    and pl.attendee_id = p_attendee_id
    and (public.i_take_event(p_event_id) or public.i_manage_event(p_event_id))
  order by pl.logged_at desc
  limit 1;
$$;


-- 5. Record an IN or OUT
--    Any active taker (or the event's manager) can record at any time
--    while the event is active. The same direction recorded again within
--    5 seconds is treated as an accidental double tap and ignored.
create or replace function public.record_presence(
  p_event_id    uuid,
  p_attendee_id uuid,
  p_direction   public.presence_direction,
  p_method      public.scan_method default 'qr'
)
returns json language plpgsql security definer as $$
declare
  v_last   public.presence_logs%rowtype;
  v_log_id uuid;
begin
  if not (public.i_take_event(p_event_id) or public.i_manage_event(p_event_id)) then
    return json_build_object(
      'success', false,
      'message', 'Not authorized to record IN/OUT for this event.'
    );
  end if;

  if not exists (
    select 1 from public.events where id = p_event_id and status = 'active'
  ) then
    return json_build_object(
      'success', false,
      'message', 'This event is not active.'
    );
  end if;

  if not exists (
    select 1 from public.event_attendees
    where event_id = p_event_id and user_id = p_attendee_id
  ) then
    return json_build_object(
      'success', false,
      'message', 'This attendee is not enrolled in this event.'
    );
  end if;

  select * into v_last
  from public.presence_logs
  where event_id = p_event_id and attendee_id = p_attendee_id
  order by logged_at desc
  limit 1;

  if v_last.id is not null
     and v_last.direction = p_direction
     and v_last.logged_at > now() - interval '5 seconds' then
    return json_build_object(
      'success',   false,
      'duplicate', true,
      'message',   'This was already recorded a moment ago.'
    );
  end if;

  insert into public.presence_logs (
    event_id, attendee_id, direction, method, recorded_by
  ) values (
    p_event_id, p_attendee_id, p_direction, p_method, auth.uid()
  )
  returning id into v_log_id;

  return json_build_object(
    'success',   true,
    'duplicate', false,
    'log_id',    v_log_id
  );
end;
$$;


-- 6. Row level security
--    Managers read logs for their events (IN/OUT report).
--    No insert/update/delete policies: writes only go through record_presence().
alter table public.presence_logs enable row level security;

create policy "presence_logs: managers read"
  on public.presence_logs for select
  using (public.i_manage_event(event_id));
