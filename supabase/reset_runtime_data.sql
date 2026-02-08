-- Reset all runtime arena data (agents, queue, games, moves, offer10, idempotency).
-- Use for local testing or controlled maintenance windows only.

begin;

truncate table
  public.move_idempotency,
  public.offer10,
  public.moves,
  public.matchmaking_queue,
  public.games,
  public.agents
restart identity cascade;

commit;

-- Optional quick sanity check
select
  (select count(*) from public.agents) as agents_count,
  (select count(*) from public.matchmaking_queue) as queue_count,
  (select count(*) from public.games) as games_count,
  (select count(*) from public.moves) as moves_count,
  (select count(*) from public.offer10) as offer10_count,
  (select count(*) from public.move_idempotency) as move_idempotency_count;
