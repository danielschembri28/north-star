-- NorthStar schema v1

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  logo_file_id uuid,
  timezone text NOT NULL DEFAULT 'Europe/Malta',
  google_review_url text NOT NULL DEFAULT '',
  facebook_review_url text NOT NULL DEFAULT '',

  automation_running boolean NOT NULL DEFAULT false,
  paused_at timestamptz,
  paused_by text,
  trigger_type text NOT NULL DEFAULT 'paid',          -- paid | complete | any
  trigger_source text NOT NULL DEFAULT '',            -- xero | webhook | csv | manual
  delay_minutes integer NOT NULL DEFAULT 1440,
  channel_order text NOT NULL DEFAULT 'whatsapp,sms,email',
  channel_whatsapp boolean NOT NULL DEFAULT true,
  channel_sms boolean NOT NULL DEFAULT true,
  channel_email boolean NOT NULL DEFAULT true,
  followup_enabled boolean NOT NULL DEFAULT true,
  followup_wait_days integer NOT NULL DEFAULT 3,

  daily_limit integer NOT NULL DEFAULT 50,
  quiet_start text NOT NULL DEFAULT '20:00',
  quiet_end text NOT NULL DEFAULT '08:00',
  skip_sundays boolean NOT NULL DEFAULT true,
  repeat_guard_days integer NOT NULL DEFAULT 90,

  onboarding_step integer NOT NULL DEFAULT 1,
  onboarding_done boolean NOT NULL DEFAULT false,
  templates_saved boolean NOT NULL DEFAULT false,
  first_review_celebrated boolean NOT NULL DEFAULT false,

  plan text NOT NULL DEFAULT 'trial',
  plan_status text NOT NULL DEFAULT 'trialing',
  plan_renews_at timestamptz,
  monthly_message_limit integer NOT NULL DEFAULT 500,
  stripe_customer_id text,
  stripe_subscription_id text,

  webhook_key text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  reset_token_hash text,
  reset_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner',                 -- owner | manager | viewer
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, business_id)
);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id text PRIMARY KEY,                                -- sha256 of the cookie token
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  csrf text NOT NULL,
  flash jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  mime text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',              -- manual | csv | xero | webhook
  external_id text,
  opted_out boolean NOT NULL DEFAULT false,
  opted_out_at timestamptz,
  opt_out_reason text,
  last_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_external_uniq ON customers(business_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX customers_business_idx ON customers(business_id, created_at DESC);
CREATE INDEX customers_phone_idx ON customers(phone);
CREATE INDEX customers_email_idx ON customers(business_id, lower(email));

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service text NOT NULL DEFAULT '',
  reference text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',
  external_id text,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_external_uniq ON jobs(business_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX jobs_customer_idx ON jobs(customer_id, completed_at DESC);

CREATE TABLE review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES review_requests(id) ON DELETE CASCADE,
  step text NOT NULL DEFAULT 'first',                 -- first | follow
  status text NOT NULL DEFAULT 'scheduled',           -- held | scheduled | sent | delivered | clicked | reviewed | failed | skipped | cancelled
  channel text,                                       -- whatsapp | sms | email
  manual boolean NOT NULL DEFAULT false,
  send_at timestamptz NOT NULL,
  held_notice_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  clicked_at timestamptz,
  reviewed_at timestamptz,
  failed_reason text,
  provider_id text,
  link_code text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rr_due_idx ON review_requests(send_at) WHERE status = 'scheduled';
CREATE INDEX rr_business_idx ON review_requests(business_id, created_at DESC);
CREATE INDEX rr_customer_idx ON review_requests(customer_id, created_at DESC);
CREATE INDEX rr_provider_idx ON review_requests(provider_id);

CREATE TABLE templates (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel text NOT NULL,                              -- whatsapp | sms | email
  which text NOT NULL,                                -- first | follow
  subject text NOT NULL DEFAULT '',
  body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, channel, which)
);

CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  request_id uuid REFERENCES review_requests(id) ON DELETE SET NULL,
  platform text NOT NULL DEFAULT 'google',            -- google | facebook | other
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text text NOT NULL DEFAULT '',
  reviewer_name text NOT NULL DEFAULT '',
  external_id text,
  reply_text text,
  replied_at timestamptz,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_external_uniq ON reviews(business_id, platform, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX reviews_business_idx ON reviews(business_id, reviewed_at DESC);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  request_id uuid REFERENCES review_requests(id) ON DELETE SET NULL,
  type text NOT NULL,       -- sent | delivered | clicked | reviewed | failed | opted_out | held | skipped | imported | integration | system
  channel text,
  text text NOT NULL,
  meta text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_business_idx ON events(business_id, id DESC);

CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider text NOT NULL,                             -- xero | google
  status text NOT NULL DEFAULT 'connected',           -- connected | syncing | error | disconnected
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  tenant_id text,
  account_name text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  error_message text,
  error_at timestamptz,
  progress_done integer,
  progress_total integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider)
);
CREATE INDEX integrations_tenant_idx ON integrations(provider, tenant_id);

CREATE TABLE oauth_states (
  state text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  return_to text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  headers jsonb NOT NULL,
  rows jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
