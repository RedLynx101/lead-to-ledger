-- The form's durable row. A lead is on disk before anything else is attempted, so a
-- dead n8n can delay it but not lose it.
create table lead_submissions (
  key                text primary key,
  form               jsonb not null,
  synthetic          boolean not null default false,
  received_at        timestamptz not null default now(),
  resubmit_count     integer not null default 0,
  handed_off_at      timestamptz,
  handoff_attempts   integer not null default 0,
  last_handoff_error text
);

create index lead_submissions_pending on lead_submissions (received_at) where handed_off_at is null;

-- One row per unique submission. The primary key is the idempotency key: a replayed
-- webhook finds this row and gets the first answer back, with no model call and no
-- second write. In shadow mode, `fields` is the log of what would have been written.
create table triage_runs (
  key              text primary key,
  status           text not null check (status in ('claimed', 'done', 'write_failed')),
  lease_expires_at timestamptz,
  attempts         integer not null default 1,
  route            text check (route in ('rule', 'model')),
  rule_id          text,
  outcome          text,
  category         text,
  priority         text,
  summary          text,
  confidence       numeric,
  needs_review     boolean,
  skip_crm         boolean not null default false,
  fields           jsonb,
  mode             text check (mode in ('shadow', 'live')),
  wrote_to_crm     boolean not null default false,
  written_at       timestamptz,
  model            text,
  prompt_version   text,
  latency_ms       integer,
  detail           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index triage_runs_recent on triage_runs (created_at desc);

create table settings (
  name       text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Who moved between shadow and live, on what evidence. Append-only.
create table mode_changes (
  id             bigserial primary key,
  at             timestamptz not null default now(),
  mode           text not null check (mode in ('shadow', 'live')),
  signed_off_by  text,
  report_file    text,
  report_sha256  text,
  below_bar_note text
);

create table alerts (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  kind            text not null,
  key             text,
  detail          text,
  acknowledged_at timestamptz
);

create index alerts_open on alerts (at desc) where acknowledged_at is null;
