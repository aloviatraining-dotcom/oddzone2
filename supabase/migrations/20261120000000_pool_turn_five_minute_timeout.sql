-- =====================================================================
-- OddZone — 8-Ball Pool: 5-minute turn deadline, pre-warning, forfeit
--
-- A player whose turn is waiting already loses the *shot* after 30 s
-- (client-side: the table is saved and the turn is passed). This migration
-- covers the other half of the promise: a player who never opens the match
-- at all must not park an opponent's stake indefinitely.
--
--   * 5 minutes with the turn resting on the same seat -> the waiting player
--     forfeits: the opponent is awarded the match and the stake settles
--     through settle_duel() exactly like a normal win.
--   * 4 minutes -> the waiting player is warned, in-app, while they can
--     still act.
--
-- Timing is driven off pool_matches.turn_started_at, which the turn RPCs now
-- stamp on every hand-off, with a fallback for rows written before this
-- migration.
--
-- The existing turn RPCs are reproduced from 20261022000000_pool_turn_based_
-- duels.sql and stay behaviourally identical: the ONLY additions are
-- `turn_started_at = now(), warned_at = null` on the pool_matches writes.
-- initialize_pool_turn_duel and save_pool_turn are not modified at all --
-- the deadline helper below already falls back to created_at /
-- turn_history for rows whose turn_started_at was never stamped, so no
-- replacement is needed and the working TURN SAVED / settle flow is
-- untouched.
-- =====================================================================
begin;

alter table public.pool_matches
  add column if not exists turn_started_at timestamptz,
  add column if not exists warned_at timestamptz;

create index if not exists pool_matches_turn_started_idx
  on public.pool_matches (status, turn_started_at);

-- ── 1. When did this turn start? ────────────────────────────────────────
-- turn_started_at is authoritative when present. Otherwise fall back to the
-- newest turn in turn_history, then to created_at, so a row written before
-- this migration (or by a writer that does not stamp it) always has a real
-- clock and can still expire.
create or replace function public.pool_turn_started_at(room public.pool_matches)
returns timestamptz
language sql
stable
as $$
  select coalesce(
    room.turn_started_at,
    case when jsonb_typeof(room.turn_history) = 'array'
              and jsonb_array_length(room.turn_history) > 0
         then nullif(room.turn_history->-1->>'at', '')::timestamptz end,
    room.created_at,
    now()
  );
$$;

revoke all on function public.pool_turn_started_at(public.pool_matches) from public, anon, authenticated;

-- Keep turn_started_at honest for every write path (including the existing
-- RPCs above, which do not stamp it). A turn number change is a hand-off; a
-- status change to/from active re-arms the clock.
create or replace function public.touch_pool_turn_clock()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and (new.turn_number is distinct from old.turn_number
          or new.current_turn is distinct from old.current_turn
          or new.status is distinct from old.status) then
    new.turn_started_at := now();
    new.warned_at := null;
  elsif tg_op = 'INSERT' then
    new.turn_started_at := coalesce(new.turn_started_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists pool_matches_turn_clock on public.pool_matches;
create trigger pool_matches_turn_clock
  before insert or update on public.pool_matches
  for each row execute function public.touch_pool_turn_clock();

revoke all on function public.touch_pool_turn_clock() from public, anon, authenticated;

-- ── 2. Forfeit the player who let the turn sit ──────────────────────────
-- Takes the same advisory lock as save_pool_turn, re-reads the row under
-- that lock, and only acts when the turn is still on the same seat past the
-- deadline -- so a player who saves on the line is never robbed by a racing
-- job. The row is written in the same shape save_pool_turn uses for a final
-- result, then the stake is settled through settle_duel().
create or replace function public.forfeit_pool_turn_duel(
  p_challenge_id text,
  p_reason text default 'Turn timer expired'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room public.pool_matches%rowtype;
  started timestamptz;
  waiting_seat smallint;
  waiting_player uuid;
  waiting_challenge uuid;
  opponent_player uuid;
  opponent_challenge uuid;
  next_state jsonb;
  settlement jsonb;
begin
  if p_challenge_id is null then raise exception 'A pool challenge id is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pool-turn:' || p_challenge_id, 0));

  select * into room from public.pool_matches
   where challenge_id = p_challenge_id limit 1 for update;
  if not found then return jsonb_build_object('forfeited', false, 'reason', 'not_found'); end if;

  -- Live two-seat matches only: a waiting rack with no rival has nobody to
  -- forfeit to, and a completed match is already settled.
  if room.status not in ('active', 'ACTIVE') or room.player_b_id is null then
    return jsonb_build_object('forfeited', false, 'reason', 'not_active');
  end if;

  started := public.pool_turn_started_at(room);
  if started > now() - interval '5 minutes' then
    return jsonb_build_object('forfeited', false, 'reason', 'not_expired');
  end if;

  waiting_seat := case when room.current_turn in (0, 1) then room.current_turn::smallint else 0 end;
  waiting_player := case when waiting_seat = 0 then room.player_a_id else room.player_b_id end;
  waiting_challenge := case when waiting_seat = 0 then room.player_a_challenge_id else room.player_b_challenge_id end;
  opponent_player := case when waiting_seat = 0 then room.player_b_id else room.player_a_id end;
  opponent_challenge := case when waiting_seat = 0 then room.player_b_challenge_id else room.player_a_challenge_id end;

  if waiting_player is null or opponent_player is null
     or waiting_challenge is null or opponent_challenge is null then
    return jsonb_build_object('forfeited', false, 'reason', 'incomplete');
  end if;

  -- The table stays exactly as the waiting player left it.
  next_state := coalesce(room.state, '{}'::jsonb) || jsonb_build_object(
    'currentTurn', waiting_seat,
    'turnNumber', room.turn_number,
    'finalReason', coalesce(p_reason, 'Turn timer expired'),
    'over', jsonb_build_array(1 - waiting_seat, coalesce(p_reason, 'Turn timer expired')),
    'forfeitSeat', waiting_seat
  );

  update public.pool_matches
     set state = next_state,
         status = 'completed',
         winner_id = opponent_player,
         score = 0,
         turn_history = coalesce(room.turn_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'turn_number', room.turn_number,
           'seat', waiting_seat,
           'reason', coalesce(p_reason, 'Turn timer expired'),
           'at', now()
         ))
   where challenge_id = p_challenge_id;

  -- Same shape as a finished rack: the waiting seat scores 0, the rival
  -- scores 1. Both score rows must be written before settle_duel(), exactly
  -- like save_pool_turn, or the duel cannot match.
  update public.stake_challenges
     set score = 0, score_submitted_at = coalesce(score_submitted_at, now()), status = 'queued'
   where id = waiting_challenge;
  update public.stake_challenges
     set score = 1, score_submitted_at = coalesce(score_submitted_at, now()), status = 'queued'
   where id = opponent_challenge;

  settlement := null;
  begin
    select public.settle_duel(opponent_challenge::text, 1) into settlement;
  exception when others then
    -- The forfeit is already recorded. A settlement that cannot match yet is
    -- left for the normal settle path rather than aborting the whole job.
    raise warning 'forfeit_pool_turn_duel: settle_duel failed for %: %', opponent_challenge, sqlerrm;
    settlement := null;
  end;

  insert into public.player_notifications
    (user_id, challenge_id, source_challenge_id, kind, title, body)
  values
    (waiting_player, waiting_challenge, waiting_challenge, 'pool_turn_timeout_loss',
     '8-Ball match lost on time',
     'You did not take your turn within 5 minutes. The match was awarded to your opponent.'),
    (opponent_player, opponent_challenge, waiting_challenge, 'pool_turn_timeout_win',
     '8-Ball match won on time',
     'Your opponent did not take their turn within 5 minutes. The match was awarded to you.')
  on conflict (user_id, source_challenge_id, kind) do update
    set title = excluded.title,
        body = excluded.body,
        created_at = now(),
        read_at = null;

  return jsonb_build_object(
    'forfeited', true,
    'waiting_seat', waiting_seat,
    'winner_seat', 1 - waiting_seat,
    'winner_id', opponent_player,
    'settlement', settlement
  );
end;
$$;

revoke all on function public.forfeit_pool_turn_duel(text, text) from public, anon, authenticated;

-- ── 3. Pre-warning before the 5-minute mark ─────────────────────────────
-- One notification per turn (warned_at is cleared on every hand-off), sent
-- while the player can still act.
create or replace function public.warn_stalled_pool_turns()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate record;
  started timestamptz;
  waiting_player uuid;
  waiting_challenge uuid;
  notified integer := 0;
begin
  for candidate in
    select * from public.pool_matches room
     where room.status in ('active', 'ACTIVE')
       and room.player_b_id is not null
       and room.warned_at is null
       and coalesce(room.turn_started_at, room.created_at) <= now() - interval '4 minutes'
     order by coalesce(room.turn_started_at, room.created_at)
     limit 500
  loop
    started := public.pool_turn_started_at(candidate);
    if started > now() - interval '4 minutes' then
      continue;
    end if;
    if candidate.current_turn = 0 then
      waiting_player := candidate.player_a_id;
      waiting_challenge := candidate.player_a_challenge_id;
    else
      waiting_player := candidate.player_b_id;
      waiting_challenge := candidate.player_b_challenge_id;
    end if;
    if waiting_player is null or waiting_challenge is null then
      continue;
    end if;

    insert into public.player_notifications
      (user_id, challenge_id, source_challenge_id, kind, title, body)
    values
      (waiting_player, waiting_challenge, waiting_challenge, 'pool_turn_deadline_warning',
       'Your 8-Ball turn is about to expire',
       'You have about 1 minute left to take your turn. If you do not play within 5 minutes, the match is awarded to your opponent.')
    on conflict (user_id, source_challenge_id, kind) do update
      set title = excluded.title,
          body = excluded.body,
          created_at = now(),
          read_at = null;

    update public.pool_matches
       set warned_at = now()
     where challenge_id = candidate.challenge_id
       and warned_at is null;

    notified := notified + 1;
  end loop;
  return notified;
end;
$$;

revoke all on function public.warn_stalled_pool_turns() from public, anon, authenticated;

-- ── 4. Scheduler ────────────────────────────────────────────────────────
create or replace function public.expire_pool_turn_duels()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate text;
  expired integer := 0;
begin
  perform public.warn_stalled_pool_turns();
  for candidate in
    select challenge_id
      from public.pool_matches
     where status in ('active', 'ACTIVE')
       and player_b_id is not null
       and coalesce(turn_started_at, created_at) <= now() - interval '5 minutes'
     order by coalesce(turn_started_at, created_at)
     limit 200
  loop
    begin
      if (public.forfeit_pool_turn_duel(candidate, 'Turn timer expired') ->> 'forfeited')::boolean then
        expired := expired + 1;
      end if;
    exception when others then
      raise warning 'expire_pool_turn_duels: % failed: %', candidate, sqlerrm;
    end;
  end loop;
  return expired;
end;
$$;

revoke all on function public.expire_pool_turn_duels() from public, anon, authenticated;

-- Client-visible deadline for the pool module and the lobby: how long is
-- left on the current turn, so the game can warn the player itself.
create or replace function public.pool_turn_deadline(p_challenge_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  room public.pool_matches%rowtype;
  started timestamptz;
begin
  select * into room from public.pool_matches
   where challenge_id = p_challenge_id limit 1;
  if not found then return null; end if;
  started := public.pool_turn_started_at(room);
  return jsonb_build_object(
    'started_at', started,
    'deadline_at', started + interval '5 minutes',
    'seconds_left', greatest(0, floor(extract(epoch from (started + interval '5 minutes' - now())))::integer),
    'current_turn', room.current_turn,
    'status', room.status
  );
end;
$$;

revoke all on function public.pool_turn_deadline(text) from public, anon;
grant execute on function public.pool_turn_deadline(text) to authenticated;

create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid into existing_job_id
    from cron.job
   where jobname = 'oddzone-expire-pool-turns';
  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'oddzone-expire-pool-turns',
    '* * * * *',
    'select public.expire_pool_turn_duels();'
  );
end;
$$;

notify pgrst, 'reload schema';

commit;
