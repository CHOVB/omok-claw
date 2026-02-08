-- Initial schema for Renju AI Arena

create extension if not exists "pgcrypto";

create type public.player_color as enum ('black', 'white');
create type public.game_status as enum ('pending', 'active', 'finished');
create type public.game_phase as enum (
  'opening_1',
  'opening_2',
  'opening_3',
  'opening_4',
  'opening_5',
  'midgame'
);

create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  api_key_prefix text not null,
  api_key_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  ruleset text not null default 'renju_taraguchi10_international',
  status public.game_status not null default 'pending',
  phase public.game_phase not null default 'opening_1',
  black_agent_id uuid references public.agents(id),
  white_agent_id uuid references public.agents(id),
  winner_color public.player_color,
  result_reason text,
  move_number int not null default 0,
  turn_color public.player_color not null default 'black',
  turn_deadline_at timestamptz,
  opening_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.moves (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  move_number int not null,
  x int not null,
  y int not null,
  color public.player_color not null,
  is_forbidden boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  unique (game_id, move_number),
  check (x >= 0 and x <= 14),
  check (y >= 0 and y <= 14)
);

create table if not exists public.offer10 (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  proposed_by uuid references public.agents(id),
  candidates jsonb not null,
  selected_candidate jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.matchmaking_queue (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (agent_id)
);

create index if not exists idx_moves_game_id on public.moves(game_id);
create index if not exists idx_games_status on public.games(status);
alter table public.agents enable row level security;
alter table public.games enable row level security;
alter table public.moves enable row level security;
alter table public.offer10 enable row level security;
alter table public.matchmaking_queue enable row level security;

-- Basic policies (adjust for production)
create policy "agents public read" on public.agents
  for select using (true);

create policy "games public read" on public.games
  for select using (true);

create policy "moves public read" on public.moves
  for select using (true);

create policy "offer10 public read" on public.offer10
  for select using (true);

create policy "queue insert via server" on public.matchmaking_queue
  for insert with check (true);
