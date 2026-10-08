-- The records the public pages read and write: settings, the programme list
-- and the survey responses. One table per sheet; the admin tables follow in
-- later files.
--
-- Everything lives in its own schema. Supabase publishes the public schema
-- through its REST API to anyone holding the project's anon key; csm is not
-- published, and only the portal's own connection reaches it.

create schema if not exists csm;

-- Key and value, as on the Settings sheet.
create table csm.settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

-- The Services sheet. Programmes are withdrawn (active = false), never
-- deleted: responses keep pointing at the one they were given under.
create table csm.services (
  service_id text primary key,
  code text not null unique,
  name_en text not null,
  name_tl text not null default '',
  category text not null default 'main' check (category in ('main', 'other')),
  active boolean not null default true,
  has_fees boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The Responses sheet. Month and Year are not stored: both come from the
-- transaction date, and storing them as well is how the two came to disagree
-- on hand-edited rows.
--
-- The answer checks list every value the portal has ever accepted, so older
-- responses import as they are. What a new submission may hold is narrower,
-- and is enforced where it is submitted.
create table csm.responses (
  reference_id text primary key,
  -- The browser's id for one filled-in form, kept across its retries. Unique,
  -- so a retry that arrives twice is stored once. Null on imported rows that
  -- predate it.
  submission_id text unique,
  submitted_at timestamptz not null default now(),
  transaction_date date not null,
  client_type text not null check (client_type in ('CITIZEN', 'BUSINESS', 'GOVERNMENT')),
  sex text not null default '' check (sex in ('', 'MALE', 'FEMALE')),
  -- Null when not given; shown as N/A.
  age smallint check (age between 1 and 120),
  region text not null,
  region_code text not null,
  service_id text not null references csm.services (service_id),
  service_code text not null,
  service_name text not null,
  other_service text not null default '',
  cc1 text not null check (cc1 in ('1', '2', '3', '4', '5', 'N/A')),
  cc2 text not null check (cc2 in ('1', '2', '3', '4', '5', 'N/A')),
  cc3 text not null check (cc3 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd0 text not null check (sqd0 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd1 text not null check (sqd1 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd2 text not null check (sqd2 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd3 text not null check (sqd3 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd4 text not null check (sqd4 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd5 text not null check (sqd5 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd6 text not null check (sqd6 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd7 text not null check (sqd7 in ('1', '2', '3', '4', '5', 'N/A')),
  sqd8 text not null check (sqd8 in ('1', '2', '3', '4', '5', 'N/A')),
  suggestions text not null default '',
  email text not null,
  language text not null default 'en' check (language in ('en', 'tl')),
  coa_requested boolean not null default false,
  coa_title text not null default '',
  coa_name text not null default '',
  coa_agency text not null default '',
  coa_purpose text not null default '',
  coa_date_from date,
  coa_date_to date,
  coa_status text not null default 'NONE'
    check (coa_status in ('NONE', 'REQUESTED', 'PROCESSING', 'ISSUED', 'DECLINED')),
  coa_link text not null default '',
  coa_issued_at timestamptz,
  coa_issue_key text not null default '',
  -- What the certificate in circulation printed, recorded when it was issued.
  coa_issued_details jsonb,
  coa_decline_reason text not null default '',
  verification_code text unique,
  verification_url text not null default '',
  privacy_notice_version text,
  privacy_notice_presented_at timestamptz
);

create index responses_transaction_date on csm.responses (transaction_date);
create index responses_service on csm.responses (service_id);
create index responses_submitted_at on csm.responses (submitted_at);
create index responses_certificates on csm.responses (coa_status) where coa_status <> 'NONE';

-- Defence in depth. Nothing outside the portal's connection is granted this
-- schema; should it ever be published, no policy lets a row out.
alter table csm.settings enable row level security;
alter table csm.services enable row level security;
alter table csm.responses enable row level security;
