-- =====================================================================
-- OddZone — fix: "column reference \"opponent_score\" is ambiguous"
--
-- Reported from the 8-Ball Pool win screen:
--
--   Result Pending — WIN
--   The final result could not be confirmed: column reference
--   "opponent_score" is ambiguous. Retry when you are back online.
--
-- Cause
-- -----
-- public.save_pool_turn() declares a PL/pgSQL variable named
-- `opponent_score` (the rival's 0/1 score for a finished rack) and then
-- writes it on the rival's challenge row:
--
--   declare
--     opponent_score bigint;                 -- PL/pgSQL variable
--   ...
--   update public.stake_challenges
--      set score = opponent_score, ...       -- AMBIGUOUS
--    where id = opponent_challenge;
--
-- stake_challenges has a column of its own called `opponent_score` (the
-- snapshot of the rival's score written by settle_duel), so inside that
-- UPDATE there are two equally valid candidates for the bare name: the
-- PL/pgSQL variable and the target-table column. Postgres does not guess —
-- it raises SQLSTATE 42702, "column reference \"opponent_score\" is
-- ambiguous", for the whole statement.
--
-- That exception aborts the final turn: save_pool_turn() throws, the pool
-- client lands in its catch and shows "Result Pending", and settle_duel()
-- is never reached — so a winning player is never shown the win board and
-- the stake never settles.
--
-- Fix
-- ---
-- Rename the variable so it cannot collide (`rival_score`) and reference it
-- through the function's block label (`save_pool_turn.rival_score`), which
-- names the variable and nothing else. The rival is still written to
-- score_submitted_at/status exactly as before, and settle_duel() still
-- receives the same own_score — behaviour is identical, only the name
-- resolution changes.
--
-- Everything else in this function is reproduced verbatim from
-- 20261022000000_pool_turn_based_duels.sql so the TURN SAVED / settle flow
-- is untouched.
-- =====================================================================
begin;

-- ── Guard: the function this migration replaces must exist ───────────────
-- If an environment never applied 20261022000000_pool_turn_based_duels.sql,
-- say so loudly instead of silently leaving the ambiguous version in place.
do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'save_pool_turn'
  ) then
    raise exception
      'public.save_pool_turn() is missing. Apply 20261022000000_pool_turn_based_duels.sql first.';
  end if;
end;
$$;

create or replace function public.save_pool_turn(
  p_challenge_id text,
  p_expected_turn smallint,
  p_state jsonb,
  p_is_final boolean,
  p_winner_seat smallint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
<<save_pool_turn>>
declare
  me uuid := auth.uid();
  room public.pool_matches%rowtype;
  own_challenge uuid;
  opponent_challenge uuid;
  own_score bigint;
  -- Named rival_score, NOT opponent_score: stake_challenges has a column of
  -- its own called opponent_score, and a PL/pgSQL variable of the same name
  -- makes every unqualified reference to it ambiguous (SQLSTATE 42702).
  rival_score bigint;
  winner uuid;
  saved_state jsonb;
  next_player uuid;
  next_challenge uuid;
  settlement jsonb;
begin
  if me is null then raise exception 'Sign in to save this pool turn.'; end if;
  if p_challenge_id is null or p_expected_turn is null or p_expected_turn not in (0, 1)
     or p_is_final is null or p_state is null
     or coalesce(jsonb_typeof(p_state->'balls') <> 'array', true)
     or coalesce(jsonb_typeof(p_state->'pre_turn_balls') <> 'array', true)
     or coalesce(jsonb_typeof(p_state->'shots_replay') <> 'array', true)
     or coalesce(jsonb_typeof(p_state->'post_turn_balls') <> 'array', true) then
    raise exception 'Invalid pool turn payload.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pool-turn:' || p_challenge_id, 0));

  select * into room from public.pool_matches
   where challenge_id = p_challenge_id limit 1 for update;
  if not found then raise exception 'This pool duel was not found.'; end if;
  if room.status = 'completed' then
    if p_is_final
       and ((p_expected_turn = 0 and room.player_a_id = me)
         or (p_expected_turn = 1 and room.player_b_id = me))
       and room.winner_id = (case when p_winner_seat = 0 then room.player_a_id else room.player_b_id end) then
      own_challenge := case when p_expected_turn = 0 then room.player_a_challenge_id else room.player_b_challenge_id end;
      own_score := case when room.winner_id = me then 1 else 0 end;
      select public.settle_duel(own_challenge::text, own_score) into settlement;
      if settlement is null or coalesce(settlement->>'matched', 'false') <> 'true' then
        raise exception 'The final pool result could not be confirmed for settlement.';
      end if;
      return jsonb_build_object(
        'current_turn', room.current_turn, 'turn_number', room.turn_number,
        'player_challenge_id', own_challenge::text, 'winner_id', room.winner_id,
        'settlement', settlement
      );
    end if;
    raise exception 'This pool duel is already finished.';
  end if;
  if room.current_turn <> p_expected_turn
     or (p_expected_turn = 0 and room.player_a_id <> me)
     or (p_expected_turn = 1 and room.player_b_id <> me) then
    raise exception 'It is not this player''s saved pool turn.';
  end if;
  if p_is_final and (p_winner_seat is null or p_winner_seat not in (0, 1)
     or (room.player_b_id is null and p_expected_turn <> 0)) then
    raise exception 'A final result requires the host turn and a valid winner.';
  end if;

  saved_state := p_state || jsonb_build_object(
    'currentTurn', case when p_is_final then p_expected_turn else 1 - p_expected_turn end,
    'turnNumber', room.turn_number + 1,
    'finalReason', case when p_is_final then coalesce(p_reason, '') else null end,
    'over', case when p_is_final then jsonb_build_array(p_winner_seat, coalesce(p_reason, '')) else null end
  );

  if p_is_final then
    if room.player_b_id is null then
      own_challenge := room.player_a_challenge_id;
      update public.pool_matches
         set state = saved_state, status = 'waiting', pending_winner_seat = p_winner_seat,
             turn = room.turn_number + 1, turn_number = room.turn_number + 1,
             score = coalesce((p_state->>'score')::bigint, 0),
               shots = coalesce((p_state->>'shots')::integer, 0),
               pre_turn_balls = p_state->'pre_turn_balls',
               shots_replay = p_state->'shots_replay',
               post_turn_balls = p_state->'post_turn_balls',
               turn_history = coalesce(room.turn_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                 'turn_number', room.turn_number + 1,
                 'seat', p_expected_turn,
                 'pre_turn_balls', p_state->'pre_turn_balls',
                 'shots_replay', p_state->'shots_replay',
                 'post_turn_balls', p_state->'post_turn_balls',
                 'reason', coalesce(p_reason, '')
               ))
       where challenge_id = p_challenge_id;
      update public.stake_challenges
         set status = 'queued'
       where id = own_challenge and user_id = me and opponent_id is null;
      return jsonb_build_object(
        'current_turn', p_expected_turn, 'turn_number', room.turn_number + 1,
        'player_challenge_id', own_challenge::text,
        'pending_opponent', true, 'winner_seat', p_winner_seat
      );
    end if;
    winner := case when p_winner_seat = 0 then room.player_a_id else room.player_b_id end;
    own_challenge := case when p_expected_turn = 0 then room.player_a_challenge_id else room.player_b_challenge_id end;
    opponent_challenge := case when p_expected_turn = 0 then room.player_b_challenge_id else room.player_a_challenge_id end;
    own_score := case when p_winner_seat = p_expected_turn then 1 else 0 end;
    rival_score := 1 - own_score;

    update public.pool_matches
       set state = saved_state, status = 'completed', winner_id = winner,
           turn = room.turn_number + 1, turn_number = room.turn_number + 1,
         score = own_score, shots = coalesce((p_state->>'shots')::integer, 0),
         pre_turn_balls = p_state->'pre_turn_balls',
         shots_replay = p_state->'shots_replay',
         post_turn_balls = p_state->'post_turn_balls',
         turn_history = coalesce(room.turn_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
           'turn_number', room.turn_number + 1,
           'seat', p_expected_turn,
           'pre_turn_balls', p_state->'pre_turn_balls',
           'shots_replay', p_state->'shots_replay',
           'post_turn_balls', p_state->'post_turn_balls',
           'reason', coalesce(p_reason, '')
         ))
     where challenge_id = p_challenge_id;

    update public.stake_challenges
       set score = own_score, score_submitted_at = coalesce(score_submitted_at, now()), status = 'queued'
     where id = own_challenge and user_id = me;
    -- The rival's row. The variable is renamed AND qualified with the block
    -- label, so this statement resolves to the variable and can never be read
    -- as the stake_challenges column `opponent_score` (which is what made the
    -- original SQLSTATE 42702).
    update public.stake_challenges
       set score = save_pool_turn.rival_score,
           score_submitted_at = coalesce(score_submitted_at, now()),
           status = 'queued'
     where id = opponent_challenge;
    select public.settle_duel(own_challenge::text, own_score) into settlement;
    if settlement is null or coalesce(settlement->>'matched', 'false') <> 'true' then
      raise exception 'The final pool result could not be matched for settlement.';
    end if;
  else
    update public.pool_matches
       set state = saved_state, status = case when room.player_b_id is null then 'searching' else 'active' end,
           current_turn = 1 - p_expected_turn,
           turn = room.turn_number + 1, turn_number = room.turn_number + 1,
           score = greatest(coalesce((p_state->'playerScores'->>0)::bigint, 0),
                            coalesce((p_state->'playerScores'->>1)::bigint, 0)),
           shots = coalesce((p_state->>'shots')::integer, 0),
           pre_turn_balls = p_state->'pre_turn_balls',
           shots_replay = p_state->'shots_replay',
           post_turn_balls = p_state->'post_turn_balls',
           turn_history = coalesce(room.turn_history, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'turn_number', room.turn_number + 1,
             'seat', p_expected_turn,
             'pre_turn_balls', p_state->'pre_turn_balls',
             'shots_replay', p_state->'shots_replay',
             'post_turn_balls', p_state->'post_turn_balls',
             'reason', coalesce(p_reason, '')
           ))
     where challenge_id = p_challenge_id;
    if p_expected_turn = 0 and room.player_b_id is null then
      update public.stake_challenges set status = 'queued'
       where id = room.player_a_challenge_id and user_id = me and opponent_id is null;
    end if;
    own_challenge := case when p_expected_turn = 0 then room.player_a_challenge_id else room.player_b_challenge_id end;
    next_player := case when p_expected_turn = 0 then room.player_b_id else room.player_a_id end;
    next_challenge := case when p_expected_turn = 0 then room.player_b_challenge_id else room.player_a_challenge_id end;
    if next_player is not null and next_challenge is not null then
      insert into public.player_notifications
        (user_id, challenge_id, source_challenge_id, kind, title, body)
      values
        (next_player, next_challenge, own_challenge, 'pool_turn_ready',
         'Your turn in 8-Ball Pool', 'Your rival saved the table. Open 8-Ball Pool to continue the match.')
      on conflict (user_id, source_challenge_id, kind) do update
        set challenge_id = excluded.challenge_id,
            title = excluded.title,
            body = excluded.body,
            created_at = now(),
            read_at = null;
    end if;
  end if;

  return jsonb_build_object(
    'current_turn', case when p_is_final then p_expected_turn else 1 - p_expected_turn end,
    'turn_number', room.turn_number + 1,
    'player_challenge_id', own_challenge::text,
    'opponent_joined', room.player_b_id is not null,
    'opponent_name', coalesce(
      (select username from public.public_profiles
        where user_id = case when p_expected_turn = 0 then room.player_b_id else room.player_a_id end),
      'Opponent'
    ),
    'status', case when p_is_final then 'completed'
                   when room.player_b_id is null then 'searching' else 'active' end,
    'winner_id', winner,
    'settlement', settlement
  );
end;
$$;

revoke all on function public.save_pool_turn(text, smallint, jsonb, boolean, smallint, text) from public;
revoke all on function public.save_pool_turn(text, smallint, jsonb, boolean, smallint, text) from anon;
grant execute on function public.save_pool_turn(text, smallint, jsonb, boolean, smallint, text) to authenticated;

notify pgrst, 'reload schema';

commit;
