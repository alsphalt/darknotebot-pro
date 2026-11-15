-- ============================================================================
-- DARKNOTE CONTROL CENTER — Neon PostgreSQL schema
-- Production files stay on Pterodactyl. This database stores administration,
-- metadata, history, indexes and synchronization state only.
-- Compatible with Neon PostgreSQL and the embedded PGlite dev database.
-- ============================================================================

create table if not exists schema_migrations (
  version      integer primary key,
  applied_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 19. Administration
-- ---------------------------------------------------------------------------
create table if not exists admin_users (
  id              text primary key,
  email           text not null,
  name            text not null,
  password_hash   text not null,
  role            text not null default 'admin',          -- owner | admin | operator | viewer
  permissions     jsonb not null default '[]'::jsonb,     -- extra grants on top of the role
  is_active       boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists admin_users_email_key on admin_users (lower(email));

create table if not exists sessions (
  id          text primary key,
  user_id     text not null references admin_users(id) on delete cascade,
  token_hash  text not null,
  csrf_token  text not null,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);
create unique index if not exists sessions_token_hash_key on sessions (token_hash);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists login_attempts (
  id         bigserial primary key,
  email      text,
  ip         text,
  success    boolean not null,
  reason     text,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_created_idx on login_attempts (created_at);

-- ---------------------------------------------------------------------------
-- 2. Connected Pterodactyl servers (credentials encrypted at rest)
-- ---------------------------------------------------------------------------
create table if not exists connected_servers (
  id                    text primary key,
  name                  text not null,
  panel_url             text not null,
  server_identifier     text not null,
  api_key_encrypted     text not null,
  api_key_hint          text not null,
  project_root          text not null default '/',
  allowed_extensions    jsonb not null default '[]'::jsonb,
  excluded_paths        jsonb not null default '[]'::jsonb,
  auto_restart          boolean not null default true,
  atomic_writes         boolean not null default true,
  startup_timeout_s     integer not null default 90,
  max_file_bytes        integer not null default 524288,
  sync_mode             text not null default 'polling',  -- polling | events
  sync_interval_s       integer not null default 300,
  is_active             boolean not null default true,
  created_by            text references admin_users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_connected_at     timestamptz,
  last_scan_at          timestamptz,
  last_sync_at          timestamptz,
  connection_state      text not null default 'unconfigured',
  last_error            text
);
create index if not exists connected_servers_active_idx on connected_servers (is_active);

create table if not exists server_permissions (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  user_id     text not null references admin_users(id) on delete cascade,
  permissions jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);
create unique index if not exists server_permissions_key on server_permissions (server_id, user_id);

-- ---------------------------------------------------------------------------
-- 3. File index / content cache / versions / backups
-- ---------------------------------------------------------------------------
create table if not exists file_indexes (
  id             text primary key,
  server_id      text not null references connected_servers(id) on delete cascade,
  path           text not null,
  name           text not null,
  parent_path    text not null default '/',
  extension      text,
  is_directory   boolean not null default false,
  is_symlink     boolean not null default false,
  size_bytes     bigint not null default 0,
  remote_modified_at timestamptz,
  sha256         text,
  content_cached boolean not null default false,
  is_secret      boolean not null default false,
  access_error   text,
  first_seen_at  timestamptz not null default now(),
  indexed_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists file_indexes_path_key on file_indexes (server_id, path);
create index if not exists file_indexes_parent_idx on file_indexes (server_id, parent_path);
create index if not exists file_indexes_ext_idx on file_indexes (server_id, extension);

create table if not exists file_contents (
  server_id  text not null references connected_servers(id) on delete cascade,
  path       text not null,
  sha256     text not null,
  content    text not null,
  bytes      integer not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (server_id, path)
);

create table if not exists file_versions (
  id             text primary key,
  server_id      text not null references connected_servers(id) on delete cascade,
  path           text not null,
  version        integer not null,
  sha256         text not null,
  size_bytes     bigint not null default 0,
  content_ref    text,                       -- backup storage key holding this exact content
  backup_id      text,
  deployment_id  text,
  change_note    text,
  created_by     text,
  remote_modified_at timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists file_versions_path_idx on file_versions (server_id, path, version desc);

create table if not exists file_backups (
  id            text primary key,
  server_id     text not null references connected_servers(id) on delete cascade,
  path          text not null,
  sha256        text not null,
  size_bytes    bigint not null default 0,
  storage_kind  text not null default 'local',
  storage_key   text not null,
  reason        text not null default 'manual',
  deployment_id text,
  created_by    text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);
create index if not exists file_backups_path_idx on file_backups (server_id, path, created_at desc);

-- ---------------------------------------------------------------------------
-- 14/15. Deployments
-- ---------------------------------------------------------------------------
create table if not exists deployments (
  id                text primary key,
  server_id         text not null references connected_servers(id) on delete cascade,
  status            text not null default 'pending',   -- pending|running|succeeded|failed|rolled_back|rolled_forward
  trigger           text not null default 'manual',
  file_count        integer not null default 0,
  files             jsonb not null default '[]'::jsonb,
  pre_hashes        jsonb not null default '{}'::jsonb,
  post_hashes       jsonb not null default '{}'::jsonb,
  validation        jsonb not null default '{}'::jsonb,
  restart_requested boolean not null default false,
  restart_performed boolean not null default false,
  health            jsonb not null default '{}'::jsonb,
  error             text,
  notes             text,
  created_by        text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index if not exists deployments_server_idx on deployments (server_id, started_at desc);

create table if not exists deployment_logs (
  id            bigserial primary key,
  deployment_id text not null references deployments(id) on delete cascade,
  level         text not null default 'info',
  step          text,
  message       text not null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists deployment_logs_dep_idx on deployment_logs (deployment_id, id);

create table if not exists deployment_locks (
  server_id     text primary key references connected_servers(id) on delete cascade,
  deployment_id text not null,
  owner         text not null,
  acquired_at   timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- ---------------------------------------------------------------------------
-- 6/9. Command + case metadata (AST derived)
-- ---------------------------------------------------------------------------
create table if not exists command_metadata (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text not null,
  kind        text not null,                 -- case | function | variable | import | handler
  name        text not null,
  aliases     jsonb not null default '[]'::jsonb,
  line_start  integer not null default 0,
  line_end    integer not null default 0,
  char_start  integer not null default 0,
  char_end    integer not null default 0,
  signature   text,
  sha256      text,
  updated_at  timestamptz not null default now()
);
create unique index if not exists command_metadata_key on command_metadata (server_id, path, kind, name, char_start);
create index if not exists command_metadata_name_idx on command_metadata (server_id, name);

-- ---------------------------------------------------------------------------
-- 15/16. Bot status, update events, configuration history
-- ---------------------------------------------------------------------------
create table if not exists bot_status (
  id             text primary key,
  server_id      text not null references connected_servers(id) on delete cascade,
  container_state text not null default 'unknown',     -- running|starting|stopping|offline|crashed|unknown
  whatsapp_state text not null default 'unknown',      -- connected|disconnected|qr_pending|logged_out|unknown
  whatsapp_signal text,
  cpu_percent    numeric,
  memory_bytes   bigint,
  memory_limit_bytes bigint,
  disk_bytes     bigint,
  uptime_ms      bigint,
  restart_count  integer not null default 0,
  last_start_at  timestamptz,
  last_error     text,
  checked_at     timestamptz not null default now()
);
create unique index if not exists bot_status_server_key on bot_status (server_id);

create table if not exists update_events (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text,
  kind        text not null,                 -- added|changed|deleted|remote_changed|conflict
  source      text not null default 'scan',
  detail      jsonb,
  acknowledged boolean not null default false,
  detected_at timestamptz not null default now()
);
create index if not exists update_events_server_idx on update_events (server_id, detected_at desc);

create table if not exists configuration_versions (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text not null,
  sha256      text not null,
  snapshot    jsonb,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists configuration_versions_server_idx on configuration_versions (server_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4/5. Drafts, sync history, conflicts
-- ---------------------------------------------------------------------------
create table if not exists editor_drafts (
  id          text primary key,
  server_id   text not null references connected_servers(id) on delete cascade,
  path        text not null,
  user_id     text,
  content     text not null,
  base_sha256 text,
  status      text not null default 'draft',   -- draft | deployed | discarded | conflict
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists editor_drafts_key on editor_drafts (server_id, path, user_id);

create table if not exists sync_history (
  id            text primary key,
  server_id     text not null references connected_servers(id) on delete cascade,
  mode          text not null default 'scan',  -- scan | poll | manual | write
  status        text not null default 'running',
  files_scanned integer not null default 0,
  files_indexed integer not null default 0,
  files_added   integer not null default 0,
  files_changed integer not null default 0,
  files_deleted integer not null default 0,
  files_failed  integer not null default 0,
  message       text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists sync_history_server_idx on sync_history (server_id, started_at desc);

create table if not exists sync_conflicts (
  id            text primary key,
  server_id     text not null references connected_servers(id) on delete cascade,
  path          text not null,
  draft_id      text,
  base_sha256   text,
  remote_sha256 text,
  local_content text,
  remote_content text,
  detected_at   timestamptz not null default now(),
  resolution    text,                        -- keep_remote | keep_local | merged | dismissed
  resolved_by   text,
  resolved_at   timestamptz
);
create index if not exists sync_conflicts_server_idx on sync_conflicts (server_id, detected_at desc);

-- ---------------------------------------------------------------------------
-- 19/23. Activity + download history
-- ---------------------------------------------------------------------------
create table if not exists activity_logs (
  id         bigserial primary key,
  user_id    text,
  user_email text,
  server_id  text,
  action     text not null,
  target     text,
  severity   text not null default 'info',   -- info | warning | critical
  ip         text,
  user_agent text,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_logs_created_idx on activity_logs (created_at desc);
create index if not exists activity_logs_server_idx on activity_logs (server_id, created_at desc);

create table if not exists download_history (
  id             text primary key,
  server_id      text references connected_servers(id) on delete set null,
  user_id        text,
  kind           text not null,              -- file | files | folder | project | version | backup
  target         text,
  sha256         text,
  size_bytes     bigint not null default 0,
  included_secrets boolean not null default false,
  ip             text,
  created_at     timestamptz not null default now()
);
create index if not exists download_history_created_idx on download_history (created_at desc);

-- ---------------------------------------------------------------------------
-- Settings / remote event cursor (per server key-value)
-- ---------------------------------------------------------------------------
create table if not exists server_settings (
  server_id  text not null references connected_servers(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (server_id, key)
);
