-- Administrators, their sessions, the sign-in throttle and the audit log.

-- The Users and Whitelist sheets, which described the same people twice.
create table csm.admin_users (
  user_id text primary key,
  email text not null unique check (email = lower(email)),
  name text not null,
  role text not null check (role in ('admin', 'superadmin')),
  active boolean not null default true,
  -- "scheme$…": sha256x12000$salt$hash for passwords carried over from Apps
  -- Script, scrypt$N$r$p$salt$key once the account has signed in here.
  password_hash text not null,
  -- Replaced whenever the password is set, never when it is only re-hashed.
  -- A session belongs to the version it was opened under, so setting a new
  -- password ends every session opened with the old one.
  credential_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only a hash of each token is kept: a copy of this table opens no sessions.
create table csm.admin_sessions (
  token_hash text primary key,
  user_id text not null references csm.admin_users (user_id) on delete cascade,
  credential_version text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index admin_sessions_expiry on csm.admin_sessions (expires_at);

-- Failed-sign-in counters, keyed by a hash of the email (and of email and
-- device), never by the address itself.
create table csm.login_attempts (
  key text primary key,
  attempts integer not null,
  expires_at timestamptz not null
);

-- The Audit sheet. Each entry's HMAC covers the one before it, keyed by
-- AUDIT_HASH_SECRET, so the chain carried over from Apps Script continues.
-- logged_at is the exact text that was hashed.
create table csm.audit_log (
  seq bigint generated always as identity primary key,
  logged_at text not null,
  audit_id text not null unique,
  actor_email text not null default '',
  actor_role text not null default '',
  action text not null,
  target_type text not null default '',
  target_id text not null default '',
  outcome text not null check (outcome in ('SUCCESS', 'FAILURE')),
  details text not null default '{}',
  request_id text not null default '',
  previous_hash text not null default '',
  entry_hash text not null
);

-- What Apps Script kept in script properties: the hash the chain must end on,
-- and the count of entries that could not be written. Its one row is also the
-- lock that puts appends in a single line.
create table csm.audit_state (
  id boolean primary key default true check (id),
  head_hash text not null default '',
  dropped_count integer not null default 0,
  dropped_last text not null default ''
);
insert into csm.audit_state default values;

-- Append-only, whoever is connected: an entry cannot be edited or removed
-- without first dropping these triggers, which is itself a schema change.
create function csm.audit_log_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'The audit log is append-only.';
end
$$;
create trigger audit_log_no_change before update or delete on csm.audit_log
  for each row execute function csm.audit_log_append_only();
create trigger audit_log_no_truncate before truncate on csm.audit_log
  for each statement execute function csm.audit_log_append_only();

alter table csm.admin_users enable row level security;
alter table csm.admin_sessions enable row level security;
alter table csm.login_attempts enable row level security;
alter table csm.audit_log enable row level security;
alter table csm.audit_state enable row level security;
