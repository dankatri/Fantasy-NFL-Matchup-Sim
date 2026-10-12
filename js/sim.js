/** Simulation + analytics over the normalized league shape from espn.js. */

const EPS = 1e-9;

function pct(w, l, t) {
  const games = w + l + t;
  return games ? (w + t / 2) / games : 0;
}

export function formatRecord(r) {
  return r.ties ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`;
}

/**
 * Head-to-head record actually produced by the ESPN schedule, restricted to
 * completed regular-season weeks so every view uses the same sample.
 */
export function actualRecords(league) {
  const out = new Map(league.teams.map((t) => [t.id, { wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, games: 0, byes: 0 }]));

  for (const { scores, opponents } of league.weeks) {
    for (const [teamId, score] of scores) {
      const rec = out.get(teamId);
      if (!rec) continue;
      rec.pf += score;

      const oppId = opponents.get(teamId);
      if (oppId == null) {
        rec.byes += 1;
        continue;
      }
      const oppScore = scores.get(oppId) ?? 0;
      rec.pa += oppScore;
      rec.games += 1;
      if (score > oppScore + EPS) rec.wins += 1;
      else if (score < oppScore - EPS) rec.losses += 1;
      else rec.ties += 1;
    }
  }
  return out;
}

/**
 * For every week, score each team against the entire league instead of just
 * its scheduled opponent. This is the backbone of every "what-if" view.
 */
export function allPlay(league) {
  const out = new Map(
    league.teams.map((t) => [t.id, { wins: 0, losses: 0, ties: 0, byWeek: new Map(), cumulative: new Map() }])
  );

  for (const { week, scores } of league.weeks) {
    const entries = [...scores.entries()];
    for (const [teamId, score] of entries) {
      const agg = out.get(teamId);
      if (!agg) continue;

      let wins = 0;
      let losses = 0;
      let ties = 0;
      for (const [otherId, otherScore] of entries) {
        if (otherId === teamId) continue;
        if (score > otherScore + EPS) wins += 1;
        else if (score < otherScore - EPS) losses += 1;
        else ties += 1;
      }

      agg.wins += wins;
      agg.losses += losses;
      agg.ties += ties;
      agg.byWeek.set(week, { wins, losses, ties, score, pct: pct(wins, losses, ties) });
      agg.cumulative.set(week, {
        wins: agg.wins,
        losses: agg.losses,
        ties: agg.ties,
        pct: pct(agg.wins, agg.losses, agg.ties),
      });
    }
  }
  return out;
}

/**
 * Replay a team's season using another team's schedule. When the borrowed
 * schedule would have the team face itself, it instead faces the team whose
 * schedule is being borrowed.
 */
export function recordWithSchedule(league, teamId, scheduleOwnerId) {
  const rec = { wins: 0, losses: 0, ties: 0, pa: 0 };

  for (const { scores, opponents } of league.weeks) {
    const score = scores.get(teamId);
    if (score == null) continue;

    let oppId = opponents.get(scheduleOwnerId);
    if (oppId == null) continue;
    if (oppId === teamId) oppId = scheduleOwnerId;
    if (oppId === teamId) continue;

    const oppScore = scores.get(oppId);
    if (oppScore == null) continue;

    rec.pa += oppScore;
    if (score > oppScore + EPS) rec.wins += 1;
    else if (score < oppScore - EPS) rec.losses += 1;
    else rec.ties += 1;
  }

  rec.pct = pct(rec.wins, rec.losses, rec.ties);
  return rec;
}

export function scheduleSwapMatrix(league) {
  const rows = new Map();
  for (const team of league.teams) {
    const cells = new Map();
    for (const owner of league.teams) {
      cells.set(owner.id, recordWithSchedule(league, team.id, owner.id));
    }
    const values = [...cells.values()];
    const best = values.reduce((a, b) => (b.pct > a.pct ? b : a));
    const worst = values.reduce((a, b) => (b.pct < a.pct ? b : a));
    const avgWins = values.reduce((sum, r) => sum + r.wins, 0) / values.length;
    rows.set(team.id, { cells, best, worst, avgWins });
  }
  return rows;
}

/** Cumulative all-play win% converted to a 1..N ranking after each week. */
export function powerSeries(league, ap) {
  const series = new Map(league.teams.map((t) => [t.id, []]));

  for (const { week } of league.weeks) {
    const snapshot = league.teams
      .map((t) => ({ id: t.id, agg: ap.get(t.id)?.cumulative.get(week) }))
      .filter((x) => x.agg)
      .sort((a, b) => b.agg.pct - a.agg.pct);

    snapshot.forEach((entry, idx) => {
      series.get(entry.id).push({ week, rank: idx + 1, pct: entry.agg.pct });
    });
  }
  return series;
}

function rankBy(rows, key, descending = true) {
  const sorted = [...rows].sort((a, b) => (descending ? b[key] - a[key] : a[key] - b[key]));
  const ranks = new Map();
  sorted.forEach((row, idx) => ranks.set(row.id, idx + 1));
  return ranks;
}

/** Everything the UI needs: actual standings, all-play standings, and luck. */
export function buildAnalysis(league) {
  const actual = actualRecords(league);
  const ap = allPlay(league);
  const opponentCount = Math.max(1, league.teams.length - 1);

  const rows = league.teams.map((team) => {
    const a = actual.get(team.id);
    const p = ap.get(team.id);
    const weeksPlayed = p.byWeek.size;
    const apPct = pct(p.wins, p.losses, p.ties);
    const actualPct = pct(a.wins, a.losses, a.ties);
    const expectedWins = apPct * a.games;

    return {
      id: team.id,
      team,
      actual: a,
      actualPct,
      allPlay: { wins: p.wins, losses: p.losses, ties: p.ties },
      allPlayPct: apPct,
      byWeek: p.byWeek,
      weeksPlayed,
      expectedWins,
      luck: a.wins - expectedWins,
      pfPerWeek: weeksPlayed ? a.pf / weeksPlayed : 0,
      paPerGame: a.games ? a.pa / a.games : 0,
      // Average all-play win% of the opponents actually faced.
      sos: averageOpponentStrength(league, ap, team.id, opponentCount),
    };
  });

  const actualRank = rankBy(
    rows.map((r) => ({ id: r.id, v: r.actualPct * 1000 + r.actual.pf / 1e6 })),
    'v'
  );
  const trueRank = rankBy(
    rows.map((r) => ({ id: r.id, v: r.allPlayPct * 1000 + r.actual.pf / 1e6 })),
    'v'
  );

  for (const row of rows) {
    row.actualRank = actualRank.get(row.id);
    row.trueRank = trueRank.get(row.id);
    row.rankDelta = row.actualRank - row.trueRank;
  }

  rows.sort((a, b) => a.trueRank - b.trueRank);

  return {
    league,
    rows,
    rowsById: new Map(rows.map((r) => [r.id, r])),
    ap,
    power: powerSeries(league, ap),
    swap: scheduleSwapMatrix(league),
    weeks: league.weeks.map((w) => w.week),
    opponentCount,
  };
}

function averageOpponentStrength(league, ap, teamId, opponentCount) {
  let total = 0;
  let count = 0;
  for (const { week, opponents } of league.weeks) {
    const oppId = opponents.get(teamId);
    if (oppId == null) continue;
    const oppWeek = ap.get(oppId)?.byWeek.get(week);
    if (!oppWeek) continue;
    total += oppWeek.wins / opponentCount;
    count += 1;
  }
  return count ? total / count : 0;
}
