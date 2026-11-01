-- QuickBooks tokens, encrypted with LTL_TOKEN_KEY. One connection, to one sandbox company.
create table oauth_connections (
  provider          text primary key,
  realm_id_enc      text not null,
  access_token_enc  text not null,
  refresh_token_enc text not null,
  access_expires_at timestamptz not null,
  status            text not null check (status in ('connected', 'needs_reconnect')),
  updated_at        timestamptz not null default now()
);

-- The durable row. One job per won deal, enforced by the unique constraint, however
-- many times the poller sees that deal. `digest` is a hash of exactly what will be sent.
create table invoice_jobs (
  id               uuid primary key default gen_random_uuid(),
  deal_id          text not null unique,
  status           text not null check (status in ('awaiting_approval', 'queued', 'running', 'done', 'needs_person')),
  payload          jsonb not null,
  digest           text not null,
  problem          text,
  approval_id      bigint,
  lease_token      uuid,
  lease_expires_at timestamptz,
  not_before       timestamptz,
  attempts         integer not null default 0,
  qb_customer_id   text,
  qb_invoice_id    text,
  written_back_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create index invoice_jobs_ready on invoice_jobs (created_at) where status in ('queued', 'running');

-- A person's yes, tied to one job and one digest. It's spent the first time a worker
-- claims the job, and an edit to the content leaves it unusable.
create table approvals (
  id          bigserial primary key,
  job_id      uuid not null references invoice_jobs (id),
  digest      text not null,
  approved_by text not null,
  approved_at timestamptz not null default now(),
  consumed_at timestamptz
);

alter table invoice_jobs add constraint invoice_jobs_approval_fk foreign key (approval_id) references approvals (id);

-- A journal of each write: what key it uses, whether its outcome is known. A row left
-- at 'intent' means the last attempt's result is unknown, and the next attempt has to
-- find out before it writes again.
create table external_calls (
  job_id           uuid not null references invoice_jobs (id),
  call             text not null,
  idempotency_key  text not null,
  status           text not null check (status in ('intent', 'confirmed')),
  attempts         integer not null default 1,
  last_attempt_at  timestamptz not null default now(),
  response_id      text,
  confirmed_by     text,
  primary key (job_id, call)
);

-- Who did what to a job, in order. Append-only.
create table job_events (
  id     bigserial primary key,
  job_id uuid not null references invoice_jobs (id),
  at     timestamptz not null default now(),
  event  text not null,
  detail jsonb
);

create index job_events_job on job_events (job_id, id);

create table poll_cursors (
  name       text primary key,
  cursor_ms  bigint not null,
  updated_at timestamptz not null default now()
);
