-- ============================================================
--  EVENT MANAGER — Supabase Schema
--  Run this in the Supabase SQL Editor (Dashboard → SQL Editor)
--  Order matters: extensions → tables → indexes → functions →
--  triggers → RLS policies
-- ============================================================


-- ============================================================
-- 0. EXTENSIONS
-- ============================================================
create extension if not exists "pgcrypto";   -- gen_random_uuid(), crypt()
create extension if not exists "pg_net";      -- optional: outbound HTTP from DB


-- ============================================================
-- 1. ENUMS
-- ============================================================
create type user_role     as enum ('manager', 'taker', 'attendee');
create type event_status  as enum ('draft', 'active', 'closed');
create type invite_status as enum ('pending', 'accepted', 'revoked');
create type scan_method   as enum ('qr', 'manual');


-- ============================================================
-- 2. TABLES
-- ============================================================

-- ── 2.1 profiles ─────────────────────────────────────────────
-- Extends Supabase auth.users. One row per authenticated user.
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  name          text,                          -- set on first login (setup page)
  role          user_role not null,
  setup_done    boolean not null default false, -- false = show setup page
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'One row per user; extends auth.users with app-specific fields.';


-- ── 2.2 events ───────────────────────────────────────────────
create table public.events (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  start_date    date not null,
  end_date      date not null,
  status        event_status not null default 'draft',
  created_by    uuid not null references public.profiles(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint end_after_start check (end_date >= start_date)
);

comment on table public.events is
  'Top-level events created by managers.';


-- ── 2.3 periods ──────────────────────────────────────────────
-- Named sessions within an event (e.g. "Day 1 Morning").
create table public.periods (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  name          text not null,
  period_date   date not null,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);

comment on table public.periods is
  'Named time slots (periods) within an event.';


-- ── 2.4 invites ──────────────────────────────────────────────
-- Tracks every outbound invitation before/after the user accepts.
create table public.invites (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  role          user_role not null,
  temp_password text not null,               -- plaintext for email; hash stored in auth
  event_id      uuid references public.events(id) on delete cascade,
  period_id     uuid references public.periods(id) on delete set null,
  status        invite_status not null default 'pending',
  invited_by    uuid not null references public.profiles(id) on delete restrict,
  last_sent_at  timestamptz not null default now(),
  accepted_at   timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.invites is
  'All outbound invites; supports resend and revoke.';


-- ── 2.5 event_takers ─────────────────────────────────────────
-- Links a taker (profile) to an event.
create table public.event_takers (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  period_id     uuid references public.periods(id) on delete set null,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),

  unique (event_id, user_id)                -- one assignment per taker per event
);

comment on table public.event_takers is
  'Assigns takers to events; is_active controls access.';


-- ── 2.6 event_attendees ──────────────────────────────────────
-- Links a reusable attendee profile to an event.
create table public.event_attendees (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  qr_token      text not null unique default encode(gen_random_bytes(16), 'hex'),
  assigned_at   timestamptz not null default now(),

  unique (event_id, user_id)                -- attendee appears once per event
);

comment on table public.event_attendees is
  'Attendees assigned to events; qr_token is what the QR code encodes.';


-- ── 2.7 attendance_logs ──────────────────────────────────────
create table public.attendance_logs (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events(id) on delete cascade,
  period_id       uuid not null references public.periods(id) on delete cascade,
  attendee_id     uuid not null references public.profiles(id) on delete cascade,
  scanned_by      uuid references public.profiles(id) on delete set null,
  method          scan_method not null default 'qr',
  present         boolean not null default true,
  overridden_by   uuid references public.profiles(id) on delete set null,
  overridden_at   timestamptz,
  logged_at       timestamptz not null default now(),

  -- One log entry per attendee per period
  unique (period_id, attendee_id)
);

comment on table public.attendance_logs is
  'One row per attendee per period; present can be toggled by managers.';


-- ============================================================
-- 3. INDEXES
-- ============================================================
create index idx_events_created_by    on public.events(created_by);
create index idx_events_status        on public.events(status);
create index idx_periods_event_id     on public.periods(event_id);
create index idx_invites_email        on public.invites(email);
create index idx_invites_event_id     on public.invites(event_id);
create index idx_event_takers_user    on public.event_takers(user_id);
create index idx_event_takers_period  on public.event_takers(period_id);
create index idx_event_attendees_user on public.event_attendees(user_id);
create index idx_event_attendees_qr   on public.event_attendees(qr_token);
create index idx_attendance_period    on public.attendance_logs(period_id);
create index idx_attendance_attendee  on public.attendance_logs(attendee_id);
create index idx_attendance_event     on public.attendance_logs(event_id);


-- ============================================================
-- 4. HELPER FUNCTIONS
-- ============================================================

-- ── 4.1 updated_at auto-stamp ────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ── 4.2 Get current user's role ──────────────────────────────
-- Used inside RLS policies to avoid repeated subqueries.
create or replace function public.my_role()
returns user_role language sql stable security definer as $$
  select role from public.profiles where id = auth.uid();
$$;


-- ── 4.3 Check if current user manages an event ───────────────
create or replace function public.i_manage_event(p_event_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.events
    where id = p_event_id
      and created_by = auth.uid()
  );
$$;


-- ── 4.4 Check if current user is an active taker for the event that owns a period ─
create or replace function public.i_take_period(p_period_id uuid)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.event_takers et
    join public.periods p on p.id = p_period_id
    where et.event_id  = p.event_id
      and et.user_id   = auth.uid()
      and et.is_active = true
  );
$$;


-- ── 4.5 Lookup attendee by qr_token ─────────────────────────
-- Called by the taker page when a QR code is scanned.
-- Returns attendee info without exposing the full table.
create or replace function public.lookup_attendee_by_qr(p_token text)
returns table (
  attendee_id   uuid,
  name          text,
  email         text,
  event_id      uuid
) language sql stable security definer as $$
  select
    p.id          as attendee_id,
    p.name,
    p.email,
    ea.event_id
  from public.event_attendees ea
  join public.profiles p on p.id = ea.user_id
  where ea.qr_token = p_token;
$$;


-- ── 4.6 Check for duplicate scan ─────────────────────────────
create or replace function public.is_already_scanned(
  p_period_id   uuid,
  p_attendee_id uuid
)
returns boolean language sql stable security definer as $$
  select exists (
    select 1 from public.attendance_logs
    where period_id   = p_period_id
      and attendee_id = p_attendee_id
  );
$$;


-- ── 4.7 Record attendance (insert or no-op if duplicate) ─────
create or replace function public.record_attendance(
  p_event_id    uuid,
  p_period_id   uuid,
  p_attendee_id uuid,
  p_method      scan_method default 'qr'
)
returns json language plpgsql security definer as $$
declare
  v_already boolean;
  v_log_id  uuid;
begin
  -- Duplicate check
  select public.is_already_scanned(p_period_id, p_attendee_id) into v_already;

  if v_already then
    return json_build_object(
      'success',   false,
      'duplicate', true,
      'message',   'Attendee already checked in for this period.'
    );
  end if;

  -- Verify caller is an active taker for this period
  if not public.i_take_period(p_period_id) then
    return json_build_object(
      'success', false,
      'message', 'Not authorized to record attendance for this period.'
    );
  end if;

  insert into public.attendance_logs (
    event_id, period_id, attendee_id, scanned_by, method, present
  ) values (
    p_event_id, p_period_id, p_attendee_id, auth.uid(), p_method, true
  )
  returning id into v_log_id;

  return json_build_object(
    'success',  true,
    'duplicate', false,
    'log_id',   v_log_id
  );
end;
$$;


-- ── 4.8 Toggle attendance override (manager only) ────────────
create or replace function public.toggle_attendance(
  p_log_id uuid,
  p_present boolean
)
returns void language plpgsql security definer as $$
begin
  if public.my_role() <> 'manager' then
    raise exception 'Only managers can override attendance.';
  end if;

  update public.attendance_logs
  set
    present        = p_present,
    overridden_by  = auth.uid(),
    overridden_at  = now()
  where id = p_log_id
    -- Must manage the event this log belongs to
    and public.i_manage_event(event_id);
end;
$$;


-- ── 4.9 Generate temp password (6-char alphanumeric, no 0/O/1/l) ──
create or replace function public.generate_temp_password()
returns text language plpgsql as $$
declare
  chars  text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  result text := '';
  i      int;
begin
  for i in 1..6 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;
  return result;
end;
$$;


-- ── 4.10 Full attendance report for an event (manager view) ──
-- Returns rows ready to pivot into the name + periods table.
create or replace function public.attendance_report(p_event_id uuid)
returns table (
  attendee_id   uuid,
  attendee_name text,
  attendee_email text,
  period_id     uuid,
  period_name   text,
  period_date   date,
  present       boolean,
  log_id        uuid,
  method        scan_method,
  overridden    boolean
) language sql stable security definer as $$
  select
    pr.id                       as attendee_id,
    pr.name                     as attendee_name,
    pr.email                    as attendee_email,
    pe.id                       as period_id,
    pe.name                     as period_name,
    pe.period_date,
    al.present,
    al.id                       as log_id,
    al.method,
    (al.overridden_by is not null) as overridden
  from public.event_attendees ea
  join public.profiles pr  on pr.id = ea.user_id
  cross join public.periods pe
  left join public.attendance_logs al
         on al.attendee_id = ea.user_id
        and al.period_id   = pe.id
  where ea.event_id = p_event_id
    and pe.event_id = p_event_id
    and public.i_manage_event(p_event_id)
  order by pr.name, pe.sort_order;
$$;


-- ============================================================
-- 5. TRIGGERS
-- ============================================================

-- Auto-update updated_at on profiles
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-update updated_at on events
create trigger trg_events_updated_at
  before update on public.events
  for each row execute function public.set_updated_at();

-- Auto-create profile row when a new auth user signs up
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer as $$
declare
  v_invite public.invites%rowtype;
begin
  -- Find the matching pending invite by email
  select * into v_invite
  from public.invites
  where email  = new.email
    and status = 'pending'
  order by created_at desc
  limit 1;

  if v_invite.id is null then
    -- No invite found — block sign-up (all users must be invited)
    raise exception 'No pending invite found for %.', new.email;
  end if;

  -- Create profile
  insert into public.profiles (id, email, role, setup_done)
  values (new.id, new.email, v_invite.role, false);

  -- Mark invite accepted
  update public.invites
  set status      = 'accepted',
      accepted_at = now()
  where id = v_invite.id;

  return new;
end;
$$;

create trigger trg_new_auth_user
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();


-- ============================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================
-- Rule of thumb:
--   Managers  → full access to their own events and related rows
--   Takers    → read their assignment; insert attendance logs
--   Attendees → read their own profile and event_attendees row

alter table public.profiles         enable row level security;
alter table public.events           enable row level security;
alter table public.periods          enable row level security;
alter table public.invites          enable row level security;
alter table public.event_takers     enable row level security;
alter table public.event_attendees  enable row level security;
alter table public.attendance_logs  enable row level security;


-- ── profiles ─────────────────────────────────────────────────

-- Everyone can read their own profile
create policy "profiles: read own"
  on public.profiles for select
  using (id = auth.uid());

-- Managers can read all profiles (needed to display names in tables)
create policy "profiles: managers read all"
  on public.profiles for select
  using (public.my_role() = 'manager');

-- Users can update their own profile (name, setup_done)
create policy "profiles: update own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Only the DB trigger (security definer) inserts profiles — no direct insert policy needed


-- ── events ───────────────────────────────────────────────────

-- Managers see only their own events
create policy "events: managers read own"
  on public.events for select
  using (
    public.my_role() = 'manager'
    and created_by = auth.uid()
  );

-- Takers see events they are assigned to (any active period)
create policy "events: takers read assigned"
  on public.events for select
  using (
    public.my_role() = 'taker'
    and exists (
      select 1 from public.event_takers et
      where et.event_id  = events.id
        and et.user_id   = auth.uid()
        and et.is_active = true
    )
  );

-- Attendees see events they are enrolled in
create policy "events: attendees read enrolled"
  on public.events for select
  using (
    public.my_role() = 'attendee'
    and exists (
      select 1 from public.event_attendees ea
      where ea.event_id = events.id
        and ea.user_id  = auth.uid()
    )
  );

-- Only managers can create events
create policy "events: managers insert"
  on public.events for insert
  with check (
    public.my_role() = 'manager'
    and created_by = auth.uid()
  );

-- Only the event's manager can update it
create policy "events: managers update own"
  on public.events for update
  using (
    public.my_role() = 'manager'
    and created_by = auth.uid()
  );

-- Only the event's manager can delete it
create policy "events: managers delete own"
  on public.events for delete
  using (
    public.my_role() = 'manager'
    and created_by = auth.uid()
  );


-- ── periods ──────────────────────────────────────────────────

-- Managers read periods for their events
create policy "periods: managers read"
  on public.periods for select
  using (public.i_manage_event(event_id));

-- Takers read the period they are assigned to
create policy "periods: takers read assigned"
  on public.periods for select
  using (public.i_take_period(id));

-- Attendees read periods of events they're enrolled in
create policy "periods: attendees read"
  on public.periods for select
  using (
    public.my_role() = 'attendee'
    and exists (
      select 1 from public.event_attendees ea
      where ea.event_id = periods.event_id
        and ea.user_id  = auth.uid()
    )
  );

create policy "periods: managers insert"
  on public.periods for insert
  with check (public.i_manage_event(event_id));

create policy "periods: managers update"
  on public.periods for update
  using (public.i_manage_event(event_id));

create policy "periods: managers delete"
  on public.periods for delete
  using (public.i_manage_event(event_id));


-- ── invites ──────────────────────────────────────────────────

-- Managers read invites they sent, for events they own
create policy "invites: managers read own"
  on public.invites for select
  using (
    public.my_role() = 'manager'
    and invited_by = auth.uid()
  );

-- Managers create invites
create policy "invites: managers insert"
  on public.invites for insert
  with check (
    public.my_role() = 'manager'
    and invited_by = auth.uid()
  );

-- Managers can update (resend, revoke) their own invites
create policy "invites: managers update"
  on public.invites for update
  using (
    public.my_role() = 'manager'
    and invited_by = auth.uid()
  );


-- ── event_takers ─────────────────────────────────────────────

-- Managers read takers for their events
create policy "event_takers: managers read"
  on public.event_takers for select
  using (public.i_manage_event(event_id));

-- Takers read their own assignment
create policy "event_takers: takers read own"
  on public.event_takers for select
  using (user_id = auth.uid());

create policy "event_takers: managers insert"
  on public.event_takers for insert
  with check (public.i_manage_event(event_id));

create policy "event_takers: managers update"
  on public.event_takers for update
  using (public.i_manage_event(event_id));

create policy "event_takers: managers delete"
  on public.event_takers for delete
  using (public.i_manage_event(event_id));


-- ── event_attendees ──────────────────────────────────────────

-- Managers read attendees for their events
create policy "event_attendees: managers read"
  on public.event_attendees for select
  using (public.i_manage_event(event_id));

-- Takers read attendees for events they are assigned to
create policy "event_attendees: takers read"
  on public.event_attendees for select
  using (
    exists (
      select 1 from public.event_takers et
      where et.event_id  = event_attendees.event_id
        and et.user_id   = auth.uid()
        and et.is_active = true
    )
  );

-- Attendees read their own enrollment
create policy "event_attendees: attendees read own"
  on public.event_attendees for select
  using (user_id = auth.uid());

create policy "event_attendees: managers insert"
  on public.event_attendees for insert
  with check (public.i_manage_event(event_id));

create policy "event_attendees: managers delete"
  on public.event_attendees for delete
  using (public.i_manage_event(event_id));


-- ── attendance_logs ──────────────────────────────────────────

-- Managers read logs for their events
create policy "attendance_logs: managers read"
  on public.attendance_logs for select
  using (public.i_manage_event(event_id));

-- Takers read logs for their assigned period
create policy "attendance_logs: takers read"
  on public.attendance_logs for select
  using (public.i_take_period(period_id));

-- Takers insert logs — but only via the record_attendance() function
-- (which does its own auth check). We allow insert if they take the period.
create policy "attendance_logs: takers insert"
  on public.attendance_logs for insert
  with check (
    public.i_take_period(period_id)
    and scanned_by = auth.uid()
  );

-- Only managers can update (override) via toggle_attendance()
create policy "attendance_logs: managers update"
  on public.attendance_logs for update
  using (public.i_manage_event(event_id));


-- ============================================================
-- 7. STORAGE BUCKET (QR code images, if you choose to store them)
-- ============================================================
-- Run this only if you want to persist QR PNGs in Supabase Storage.
-- Otherwise QR codes are generated client-side on demand.
--
-- insert into storage.buckets (id, name, public)
-- values ('qr-codes', 'qr-codes', false);
--
-- create policy "qr-codes: managers upload"
--   on storage.objects for insert
--   with check (
--     bucket_id = 'qr-codes'
--     and public.my_role() = 'manager'
--   );
--
-- create policy "qr-codes: attendees read own"
--   on storage.objects for select
--   using (
--     bucket_id = 'qr-codes'
--     and (storage.foldername(name))[1] = auth.uid()::text
--   );


-- ============================================================
-- 8. SEED: first manager account
-- ============================================================
-- After running this schema, create the first manager manually
-- via the Supabase Dashboard (Authentication → Users → Add user),
-- then run the snippet below to set their role.
--
-- update public.profiles
-- set role = 'manager', setup_done = true, name = 'Your Name'
-- where email = 'your@email.com';


-- ============================================================
-- DONE
-- ============================================================
-- Tables created:
--   profiles, events, periods, invites,
--   event_takers, event_attendees, attendance_logs
--
-- Key functions:
--   my_role()                     → current user role
--   i_manage_event(event_id)      → true if caller owns event
--   i_take_period(period_id)      → true if caller is active taker
--   lookup_attendee_by_qr(token)  → resolve QR scan to attendee
--   is_already_scanned(...)       → duplicate check
--   record_attendance(...)        → safe insert with dupe guard
--   toggle_attendance(...)        → manager override
--   generate_temp_password()      → 6-char alphanumeric
--   attendance_report(event_id)   → pivot-ready report data
-- ============================================================
