-- Matchmaking transaction and move idempotency

create table if not exists public.move_idempotency (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  idempotency_key text not null,
  turn_number int not null,
  x int not null,
  y int not null,
  status_code int,
  response jsonb,
  created_at timestamptz not null default now(),
  unique (game_id, agent_id, idempotency_key)
);

create index if not exists idx_move_idem_game_agent
  on public.move_idempotency(game_id, agent_id);

alter table public.move_idempotency enable row level security;

create or replace function public.matchmake_once()
returns table (game_id uuid, black_agent_id uuid, white_agent_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  agent1 uuid;
  agent2 uuid;
  black_id uuid;
  white_id uuid;
  created_game uuid;
begin
  select mq.agent_id
    into agent1
  from public.matchmaking_queue mq
  where not exists (
    select 1
    from public.games g
    where g.status = 'active'
      and (g.black_agent_id = mq.agent_id or g.white_agent_id = mq.agent_id)
  )
  order by mq.joined_at asc
  for update skip locked
  limit 1;

  if agent1 is null then
    return;
  end if;

  select mq.agent_id
    into agent2
  from public.matchmaking_queue mq
  where mq.agent_id <> agent1
    and not exists (
      select 1
      from public.games g
      where g.status = 'active'
        and (g.black_agent_id = mq.agent_id or g.white_agent_id = mq.agent_id)
    )
  order by mq.joined_at asc
  for update skip locked
  limit 1;

  if agent2 is null then
    return;
  end if;

  if random() < 0.5 then
    black_id := agent1;
    white_id := agent2;
  else
    black_id := agent2;
    white_id := agent1;
  end if;

  insert into public.games (
    status,
    phase,
    black_agent_id,
    white_agent_id,
    turn_color,
    move_number,
    opening_state,
    updated_at
  ) values (
    'active',
    'opening_1',
    black_id,
    white_id,
    'black',
    0,
    jsonb_build_object(
      'tentative_black_agent_id', black_id,
      'tentative_white_agent_id', white_id,
      'awaiting_swap', false,
      'swap_after_move', null,
      'awaiting_offer10', false,
      'awaiting_offer10_selection', false,
      'offer10_id', null,
      'swap_history', jsonb_build_array()
    ),
    now()
  )
  returning id into created_game;

  delete from public.matchmaking_queue where agent_id in (agent1, agent2);

  return query
  select created_game, black_id, white_id;
end;
$$;