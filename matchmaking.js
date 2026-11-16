// matchmaking.js – handles pending bet UI and realtime matchmaking
import { supabase } from "./supabaseClient.js";

// ------------------------------------------------------------------
// Helper to get client
// ------------------------------------------------------------------
const getClient = () => supabase || window.supabaseClientInstance || (window.getSupabaseAuthClient ? window.getSupabaseAuthClient() : null);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);
let pendingBetsLoadSequence = 0;
const isUnavailableChallengeError = (error) =>
  /challenge.*(?:no longer available|just accepted|already accepted|not available|inactive)|(?:no longer available|just accepted).*challenge/i
    .test(String(error?.message || error || ''));

// ------------------------------------------------------------------
// Load pending bets / challenges available for other players to join
// ------------------------------------------------------------------
export const loadPendingBets = async (notice = '') => {
  const container = document.getElementById("pending-bets-panel");
  if (!container) return;
  const loadSequence = ++pendingBetsLoadSequence;

  const client = getClient();
  if (!client) {
    container.innerHTML = `<p class="rounded-xl border border-white/10 bg-cardBg px-4 py-3 text-xs text-slate-400">Log in to view available player challenges.</p>`;
    return;
  }

  let currentUserId = null;
  try {
    const { data: sessionData } = await client.auth.getSession();
    currentUserId = sessionData?.session?.user?.id || (window.activeUser && window.activeUser.id) || null;
  } catch (error) {
    console.warn('Could not read the signed-in user for open challenges:', error);
    currentUserId = window.activeUser?.id || null;
  }
  if (loadSequence !== pendingBetsLoadSequence) return;
  if (!currentUserId || window.activeUser?.isGuest) {
    container.innerHTML = `<p class="rounded-xl border border-white/10 bg-cardBg px-4 py-3 text-xs text-slate-400">Log in to view real open challenges from other players.</p>`;
    return;
  }

  try {
    if (!notice) {
      container.innerHTML = `<p class="rounded-xl border border-white/10 bg-cardBg px-4 py-3 text-xs text-slate-400">Loading live open challenges…</p>`;
    }
    const { data, error } = await client
      .from("stake_challenges")
      .select("id, game_id, stake, payout, status, created_at, user_id")
      .eq("status", "queued")
      .is("opponent_id", null)
      .is("settled_at", null)
      .is("refund_amount", null)
      .neq("user_id", currentUserId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    if (loadSequence !== pendingBetsLoadSequence) return;

    let profiles = [];
    if (data?.length) {
      const ownerIds = [...new Set(data.map(row => row.user_id).filter(Boolean))];
      const { data: profileRows, error: profilesError } = await client
        .from('public_profiles')
        .select('user_id, username')
        .in('user_id', ownerIds);
      if (profilesError) throw profilesError;
      profiles = profileRows || [];
    }
    if (loadSequence !== pendingBetsLoadSequence) return;
    const ownerNames = new Map((profiles || []).map(profile => [
      String(profile.user_id),
      profile.username || 'Player'
    ]));

    const noticeMarkup = notice
      ? `<p class="rounded-xl border border-amber-400/20 bg-amber-400/5 px-4 py-3 text-xs text-amber-200">${escapeHtml(notice)}</p>`
      : '';
    const challengesMarkup = !data?.length
      ? `<p class="rounded-xl border border-white/10 bg-cardBg px-4 py-3 text-xs text-slate-400">No open challenges waiting right now. Start a 1v1 match above!</p>`
      : data
      .map((bet) => {
        const gameCatalog = window.GAME_CATALOG || [];
        const gameTitle = gameCatalog.find((g) => g.id === bet.game_id)?.title || bet.game_id || "1v1 Battle";
        const createdAt = bet.created_at ? new Date(bet.created_at) : null;
        const dateStr = createdAt && !Number.isNaN(createdAt.getTime())
          ? createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : "Live";
        const ownerName = ownerNames.get(String(bet.user_id)) || 'Player';
        return `
        <div class="flex items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-gradient-to-r from-[#171226] to-[#120d20] p-3.5 shadow-md">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span>
              <p class="truncate text-xs font-bold text-white">${escapeHtml(gameTitle)}</p>
            </div>
            <p class="mt-1 truncate text-[10px] text-slate-300">${escapeHtml(ownerName)} · Stake: <span class="font-bold text-amber-200">₦${Number(bet.stake).toLocaleString()}</span> · <span class="text-slate-400">${dateStr}</span></p>
          </div>
          <button class="join-challenge-btn shrink-0 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 px-3.5 py-2 text-xs font-extrabold text-[#1a0e00] shadow-sm transition hover:brightness-110 active:scale-95" data-id="${escapeHtml(bet.id)}" data-game="${escapeHtml(bet.game_id)}" data-stake="${Number(bet.stake)}">
            Accept Duel
          </button>
        </div>`;
      })
      .join("");
    container.innerHTML = noticeMarkup + challengesMarkup;

    container.querySelectorAll(".join-challenge-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const betId = btn.dataset.id;
        const gameId = btn.dataset.game;
        const stake = Number(btn.dataset.stake || 1000);
        btn.disabled = true;
        btn.textContent = "Accepting…";
        try {
          await acceptChallengeDuel(betId, gameId, stake);
        } finally {
          if (btn.isConnected) {
            btn.disabled = false;
            btn.textContent = "Accept Duel";
          }
        }
      });
    });
  } catch (err) {
    console.warn("loadPendingBets error:", err);
    if (loadSequence !== pendingBetsLoadSequence) return;
    container.innerHTML = `<p class="rounded-xl border border-white/10 bg-cardBg px-4 py-3 text-xs text-rose-300">Could not load open challenges. Check your connection and try again.</p>`;
  }
};

// ------------------------------------------------------------------
// Accept a challenge duel
// ------------------------------------------------------------------
export const acceptChallengeDuel = async (betId, gameId, stake) => {
  if (window.activeUser && window.activeUser.isGuest) {
    alert("Please log in to accept real money 1v1 challenges.");
    return;
  }
  if (typeof window.acceptStakeChallenge !== "function") {
    alert("Challenge acceptance is not available yet. Reload the app and try again.");
    return;
  }

  try {
    await window.acceptStakeChallenge(betId, gameId, Number(stake));
    await loadPendingBets();
  } catch (err) {
    console.warn("accept_duel_challenge failed:", err);
    const message = err?.message || "Could not confirm acceptance. Retry this same challenge to safely check its status.";
    if (isUnavailableChallengeError(err)) {
      await loadPendingBets('That challenge was already taken or closed. The list is up to date.');
      return;
    }
    alert(message);
    if (/insufficient balance/i.test(message) && typeof window.switchTab === "function") {
      window.switchTab("wallet");
    }
  }
};

// ------------------------------------------------------------------
// Listen for match updates in realtime
// ------------------------------------------------------------------
// This used to subscribe to a `matches` table that has never existed, so the
// channel delivered nothing. The real table is stake_challenges: an opponent
// arriving shows up as a new queued row, and a duel settling shows up as that
// row flipping to 'matched'.
// Realtime for the duel flow lives in index.html now: subscribeDuelRealtime()
// owns the single 'oddzone:duel' channel and handles every state change
// (QUEUED -> MATCHED -> PLAYING -> WON/LOST/TIE), including the 5-10 second
// search window and the solo fallback.
//
// The subscription used to live here, but it only listened for status='matched'
// and simply closed the modal. That meant a player who was mid-search never
// learned an opponent had arrived, and a player whose solo score settled later
// was never shown the result. Keeping two channels on the same table also
// delivered each UPDATE twice.
//
// Delegating instead of duplicating also means one channel, not two.
export const subscribeMatchUpdates = () => {
  if (typeof window.subscribeDuelRealtime === 'function') {
    window.subscribeDuelRealtime();
    return;
  }

  const client = getClient();
  if (!client || typeof client.channel !== 'function') return;

  try {
    client
      .channel('public:stake_challenges')
      .on(
        'postgres_changes',
        { event: "*", schema: "public", table: "stake_challenges" },
        async (payload) => {
          const row = payload.new || {};
          let uid = window.activeUser?.id;
          if (!uid) {
            const { data } = await client.auth.getSession();
            uid = data?.session?.user?.id;
          }
          if (!uid) return;
          // Only react to the player's own duels, never someone else's.
          if (row.user_id && row.user_id !== uid && row.opponent_id !== uid) return;

          if (row.status === "matched") {
            // Settled: pull the authoritative balance and refresh the views.
            if (typeof window.refreshWalletFromServer === "function") {
              window.refreshWalletFromServer();
            }
            hideMatchmakingModal();
          }
          if (typeof window.loadPendingBets === "function") window.loadPendingBets();
          if (typeof window.renderActiveChallenges === "function") window.renderActiveChallenges();
        }
      )
      .subscribe();
  } catch (err) {
    console.warn("Realtime stake_challenges subscription:", err);
  }
};

// Settling is now driven by settle_duel() in index.html, which owns the
// whole result UI. Nothing to do but make sure the waiting screen is closed.
const startMatch = () => {
  hideMatchmakingModal();
};

const showMatchmakingModal = () => {
  const modal = document.getElementById("matchmaking-modal");
  if (modal) modal.classList.remove("hidden");
};

const hideMatchmakingModal = () => {
  const modal = document.getElementById("matchmaking-modal");
  if (modal) modal.classList.add("hidden");
};

// Expose globally for legacy & window event listeners
window.loadPendingBets = loadPendingBets;
window.acceptChallengeDuel = acceptChallengeDuel;
window.subscribeMatchUpdates = subscribeMatchUpdates;

// Initialise on load
window.addEventListener("load", () => {
  loadPendingBets();
  subscribeMatchUpdates();
});
