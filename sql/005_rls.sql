-- All access to this project is server-side via the service role. Enable RLS
-- with no policies on every public table so anon/authenticated see nothing.
-- (Also fixes the advisor warning on the trigger function's search_path.)

alter table hs_series enable row level security;
alter table hs_episodes enable row level security;
alter table hs_render_jobs enable row level security;
alter table hs_destinations enable row level security;

alter function public.hs_touch_updated_at() set search_path = '';
