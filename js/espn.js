const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const VIEWS = ['mTeam', 'mSettings', 'mMatchupScore'];
const BENCH_SLOT = 20;
const IR_SLOT = 21;
const PRIOR_GAMES = 4;

const POSITION_NAMES = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'D/ST',
};

export class EspnError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'EspnError';
    this.hint = hint || '';
  }
}

function query() {
  return VIEWS.map((v) => `view=${encodeURIComponent(v)}`).join('&');
}

async function readJson(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'omit' });
  } catch (err) {
    throw new EspnError(
      'Could not reach the ESPN API.',
      'This is usually a network issue or a browser extension blocking the request. Check your connection and try again.'
    );
  }

  if (res.status === 401) {
    throw new EspnError(
      'That league is private.',
      'This tool only supports leagues set to "Public" in ESPN (League Settings → Basic Settings → Visibility). Ask your commissioner to make it public, or pick a season when it was.'
    );
  }
  if (res.status === 404) {
    const err = new EspnError('League not found for that ID and season.', '');
    err.notFound = true;
    throw err;
  }
  if (!res.ok) {
    throw new EspnError(`ESPN returned HTTP ${res.status}.`, 'Try again in a moment.');
  }

  const body = await res.json();
  // The leagueHistory endpoint returns an array with one entry per season.
  return Array.isArray(body) ? body[0] : body;
}

/** Fetch a league, falling back to the historical endpoint for past seasons. */
export async function fetchLeague(leagueId, season) {
  const qs = query();
  const currentUrl = `${BASE}/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`;
  const historyUrl = `${BASE}/leagueHistory/${leagueId}?seasonId=${season}&${qs}`;

  try {
    const data = await readJson(currentUrl);
    if (data) return data;
  } catch (err) {
    if (!err.notFound) throw err;
  }

  try {
    const data = await readJson(historyUrl);
    if (data) return data;
  } catch (err) {
    if (!err.notFound) throw err;
  }

  throw new EspnError(
    `No league ${leagueId} found for the ${season} season.`,
    'Double-check the league ID (it is the number after "leagueId=" in your ESPN league URL) and make sure the league actually played that season.'
  );
}

function teamName(team) {
  const direct = (team.name || '').trim();
  if (direct) return direct;
  const composed = `${team.location || ''} ${team.nickname || ''}`.trim();
  return composed || `Team ${team.id}`;
}

function ownerName(team, membersById) {
  const ids = team.owners || [];
  const names = ids
    .map((id) => membersById.get(id))
    .filter(Boolean)
    .map((m) => `${m.firstName || ''} ${m.lastName || ''}`.trim() || m.displayName)
    .filter(Boolean);
  return names.join(', ');
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/**
 * Convert the raw ESPN payload into a compact, season-agnostic shape:
 * a team list plus one entry per completed regular-season week holding
 * every team's score and scheduled opponent.
 */
export function normalize(raw, leagueId, season) {
  const settings = raw.settings || {};
  const schedule = raw.schedule || [];
  const rawTeams = raw.teams || [];

  if (!rawTeams.length) {
    throw new EspnError('That league has no teams.', 'It may not have been set up for this season yet.');
  }

  const membersById = new Map((raw.members || []).map((m) => [m.id, m]));
  const teams = rawTeams.map((t) => {
    const name = teamName(t);
    return {
      id: t.id,
      name,
      abbrev: (t.abbrev || initials(name) || `T${t.id}`).toUpperCase(),
      owner: ownerName(t, membersById),
      logo: t.logo || '',
    };
  });
  const teamIds = new Set(teams.map((t) => t.id));

  const regularSeasonLength =
    settings.scheduleSettings?.matchupPeriodCount || Math.max(1, ...schedule.map((m) => m.matchupPeriodId || 1));

  // Regular-season games only: playoff and consolation games carry a tier type.
  const regular = schedule.filter((m) => {
    const tier = m.playoffTierType || 'NONE';
    return tier === 'NONE' && m.matchupPeriodId && m.matchupPeriodId <= regularSeasonLength;
  });

  if (!regular.length) {
    throw new EspnError('No regular-season matchups found.', 'The schedule for this season may not be published yet.');
  }

  const byWeek = new Map();
  for (const m of regular) {
    if (!byWeek.has(m.matchupPeriodId)) byWeek.set(m.matchupPeriodId, []);
    byWeek.get(m.matchupPeriodId).push(m);
  }

  const weeks = [];
  let skippedIncomplete = 0;

  for (const week of [...byWeek.keys()].sort((a, b) => a - b)) {
    const matchups = byWeek.get(week);
    const scores = new Map();
    const opponents = new Map();
    let complete = true;

    for (const m of matchups) {
      const sides = [m.home, m.away].filter((s) => s && teamIds.has(s.teamId));
      if (!sides.length) continue;

      // A matchup where nobody scored has not been played yet.
      if (!sides.some((s) => Number(s.totalPoints) > 0)) {
        complete = false;
        break;
      }

      for (const side of sides) {
        const other = sides.find((s) => s !== side);
        scores.set(side.teamId, Number(side.totalPoints) || 0);
        opponents.set(side.teamId, other ? other.teamId : null);
      }
    }

    if (!complete || scores.size === 0) {
      skippedIncomplete += 1;
      continue;
    }
    weeks.push({ week, scores, opponents });
  }

  if (!weeks.length) {
    throw new EspnError(
      'No completed weeks yet for this season.',
      'Come back once at least one week of games has been scored, or try an earlier season.'
    );
  }

  return {
    leagueId: String(leagueId),
    season: Number(season),
    name: settings.name || `League ${leagueId}`,
    size: teams.length,
    regularSeasonLength,
    skippedIncomplete,
    teams,
    weeks,
  };
}

export async function loadLeague(leagueId, season) {
  const raw = await fetchLeague(leagueId, season);
  return normalize(raw, leagueId, season);
}

async function fetchRosterWeek(leagueId, season, week) {
  const qs = `view=mRoster&scoringPeriodId=${encodeURIComponent(week)}`;
  const currentUrl = `${BASE}/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`;
  const historyUrl = `${BASE}/leagueHistory/${leagueId}?seasonId=${season}&${qs}`;

  try {
    const data = await readJson(currentUrl);
    if (data) return data;
  } catch (err) {
    if (!err.notFound) throw err;
  }

  try {
    const data = await readJson(historyUrl);
    if (data) return data;
  } catch (err) {
    if (!err.notFound) throw err;
  }

  return null;
}

/**
 * Blend a player's actual healthy PPG with ESPN's season projected PPG so
 * players who suffered early/season-ending injuries still carry their true
 * expected weekly value.
 */
export function estimateExpectedPPG(player) {
  const stats = player?.stats || [];
  const sAct = stats.find((s) => s.scoringPeriodId === 0 && s.statSourceId === 0 && s.statSplitTypeId === 0);
  const sProj = stats.find((s) => s.scoringPeriodId === 0 && s.statSourceId === 1 && s.statSplitTypeId === 0);

  const actAvg = Number(sAct?.appliedAverage) || 0;
  const projAvg = Number(sProj?.appliedAverage) || 0;
  const rawGp = Number(sAct?.stats?.['210']) || 0;
  const gp = rawGp > 0 ? rawGp : actAvg > 0 ? Math.round((Number(sAct?.appliedTotal) || 0) / actAvg) : 0;

  if (gp > 0 && projAvg > 0) return (gp * actAvg + PRIOR_GAMES * projAvg) / (gp + PRIOR_GAMES);
  if (gp > 0) return actAvg;
  return projAvg;
}

/**
 * Normalize per-week raw mRoster payloads into a compact Map<week, Map<teamId, entries[]>>.
 *
 * ESPN only attaches a week's actual stat record (scoringPeriodId === week, statSourceId === 0)
 * when the player's NFL team actually had a game that week — bye weeks omit it, which avoids
 * false positives even when a player changed NFL teams in a later season.
 */
export function normalizeRosters(rawByWeek, teamIds) {
  const allowed = teamIds ? new Set(teamIds) : null;
  const byWeek = new Map();

  for (const [week, raw] of rawByWeek) {
    const teamMap = new Map();
    for (const team of raw?.teams || []) {
      if (allowed && !allowed.has(team.id)) continue;
      const entries = [];
      for (const entry of team.roster?.entries || []) {
        const player = entry.playerPoolEntry?.player;
        if (!player) continue;

        const slot = Number(entry.lineupSlotId);
        const isIR = slot === IR_SLOT;
        const isStarter = slot !== BENCH_SLOT && !isIR;

        const wAct = (player.stats || []).find((s) => s.scoringPeriodId === week && s.statSourceId === 0);
        const played = (Number(wAct?.stats?.['210']) || 0) >= 1 || (Number(wAct?.appliedTotal) || 0) !== 0;
        const weekProTeamId = wAct?.proTeamId ?? player.proTeamId ?? 0;
        const missed = Boolean(wAct) && !played && (weekProTeamId > 0 || isIR);

        entries.push({
          playerId: player.id,
          name: player.fullName || `Player ${player.id}`,
          position: POSITION_NAMES[player.defaultPositionId] || 'FLEX',
          lineupSlotId: slot,
          eligibleSlots: Array.isArray(player.eligibleSlots) ? player.eligibleSlots : [],
          isStarter,
          isIR,
          played,
          missed,
          expectedPPG: Math.max(0, estimateExpectedPPG(player)),
        });
      }
      teamMap.set(team.id, entries);
    }
    byWeek.set(week, teamMap);
  }

  return byWeek;
}

/** Fetch and normalize weekly rosters for all completed regular-season weeks. */
export async function loadLeagueRosters(leagueId, season, weeks, teamIds) {
  const pairs = await Promise.all(
    weeks.map(async (week) => [week, await fetchRosterWeek(leagueId, season, week)])
  );
  const rawByWeek = new Map(pairs.filter(([, data]) => Boolean(data)));
  if (!rawByWeek.size) {
    throw new EspnError(
      'Weekly roster data is unavailable for this season.',
      'ESPN may not have archived weekly rosters for older seasons.'
    );
  }
  return normalizeRosters(rawByWeek, teamIds);
}
