-- What the admin screens read besides responses, and two corrections to
-- 001 found while porting them.

-- A failed issuance records its reason in the status itself, "ERROR: …", as
-- the Responses sheet always has; the certificate list splits it back out.
alter table csm.responses drop constraint responses_coa_status_check;
alter table csm.responses add constraint responses_coa_status_check check (
  coa_status in ('NONE', 'REQUESTED', 'PROCESSING', 'ISSUED', 'DECLINED')
  or coa_status like 'ERROR%'
);

-- The order rows arrived in. Every list the sheets gave was in row order, or
-- its reverse for "newest first"; the import loads rows in sheet order, so
-- this keeps those lists, ties and all, as they were.
alter table csm.responses add column seq bigint generated always as identity;
create unique index responses_seq on csm.responses (seq);

-- The ServiceStats sheet: the counts entered for the report, per period and
-- programme. Blank means not entered.
create table csm.service_stats (
  period_key text not null,
  service_id text not null references csm.services (service_id),
  clients integer check (clients >= 0),
  transactions integer check (transactions >= 0),
  remarks text not null default '',
  updated_at timestamptz not null default now(),
  primary key (period_key, service_id)
);

-- The Reports sheet: one row per workbook generated. The workbooks stay in
-- Google Drive; file_id and url point at them there.
create table csm.reports (
  seq bigint generated always as identity unique,
  report_id text primary key,
  name text not null,
  period_key text not null,
  period_label text not null,
  file_id text not null default '',
  url text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default ''
);

alter table csm.service_stats enable row level security;
alter table csm.reports enable row level security;
