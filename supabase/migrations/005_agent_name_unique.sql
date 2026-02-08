-- Enforce unique active agent names.
-- Keep the newest row active when duplicates already exist.

with ranked as (
  select
    id,
    row_number() over (partition by name order by created_at desc, id desc) as rn
  from public.agents
  where is_active = true
)
update public.agents a
set is_active = false
from ranked r
where a.id = r.id
  and r.rn > 1;

create unique index if not exists idx_agents_unique_active_name
  on public.agents (name)
  where is_active = true;
