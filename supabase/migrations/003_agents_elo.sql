-- Add Elo rating and match stats to agents
alter table if exists public.agents
  add column if not exists elo int not null default 1500,
  add column if not exists games_played int not null default 0,
  add column if not exists wins int not null default 0,
  add column if not exists losses int not null default 0,
  add column if not exists draws int not null default 0;

create index if not exists idx_agents_elo on public.agents(elo);