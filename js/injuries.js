/** Season-long injury impact & expected lost points analytics. */

const EPS = 1e-9;

/** Format a sorted list of week numbers like [1, 2, 3, 5, 7, 8] -> "W1–W3, W5, W7–W8". */
export function formatWeekRanges(weeks) {
  if (!weeks?.length) return '—';
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    if (w === prev + 1) {
      prev = w;
    } else {
      ranges.push(start === prev ? `W${start}` : `W${start}–W${prev}`);
      start = w;
      prev = w;
    }
  }
  ranges.push(start === prev ? `W${start}` : `W${start}–W${prev}`);
  return ranges.join(', ');
}

/**
 * Compute per-team and league-wide injury impact across all completed weeks.
 *
 * For each missed player-week (non-bye DNP on a team's roster, or a released
 * player the team dropped while injured and who is still out):
 * - Lost points (the headline figure) is the player's season scoring average:
 *   the team is assumed to lose what he would have averaged that week.
 * - Lost above replacement is the secondary figure. If left in a starting slot,
 *   the full average is lost. If moved to bench or IR, it is the gap between the
 *   injured player's average and the weakest eligible starter the team had to
 *   play in his place (floored at 0). Each starter slot is matched at most once
 *   per week.
 */
export function buildInjuryAnalysis(league, rostersByWeek) {
  const weeks = league.weeks.map((w) => w.week).filter((w) => rostersByWeek.has(w));
  const teamsById = new Map(league.teams.map((t) => [t.id, t]));

  const aggByTeam = new Map(
    league.teams.map((team) => [
      team.id,
      {
        id: team.id,
        team,
        missedWeeks: 0,
        impactWeeks: 0,
        startedWhileOut: 0,
        lostPts: 0,
        netLostPts: 0,
        releasedLostPts: 0,
        byWeek: new Map(),
        playersById: new Map(),
      },
    ])
  );

  for (const week of weeks) {
    const teamRosters = rostersByWeek.get(week);
    if (!teamRosters) continue;

    for (const team of league.teams) {
      const agg = aggByTeam.get(team.id);
      const entries = teamRosters.get(team.id) || [];

      const starters = [];
      const missed = [];

      for (const entry of entries) {
        if (entry.isStarter) {
          starters.push({
            playerId: entry.playerId,
            name: entry.name,
            slot: entry.lineupSlotId,
            expectedPPG: entry.expectedPPG,
            // An injured starter already counts as a full loss; don't also use them as a replacement.
            used: entry.missed,
          });
        }
        if (entry.missed) {
          missed.push(entry);
        }
      }

      // Highest-impact injuries claim the weakest eligible starter replacement first.
      missed.sort((a, b) => b.expectedPPG - a.expectedPPG);

      const weekEvents = [];
      let weekNetLost = 0;
      let weekLost = 0;

      for (const m of missed) {
        let netLost = 0;
        let replacement = null;

        if (m.isStarter) {
          netLost = m.expectedPPG;
          agg.startedWhileOut += 1;
        } else {
          const eligible = starters
            .filter((s) => !s.used && m.eligibleSlots.includes(s.slot))
            .sort((a, b) => a.expectedPPG - b.expectedPPG);

          if (eligible.length) {
            const rep = eligible[0];
            if (m.expectedPPG > rep.expectedPPG + EPS) {
              netLost = m.expectedPPG - rep.expectedPPG;
              replacement = { name: rep.name, expectedPPG: rep.expectedPPG };
              rep.used = true;
            }
          }
        }

        const lost = m.expectedPPG;
        agg.missedWeeks += 1;
        if (netLost > EPS) agg.impactWeeks += 1;
        agg.lostPts += lost;
        agg.netLostPts += netLost;
        weekNetLost += netLost;
        weekLost += lost;
        if (m.released) agg.releasedLostPts += lost;

        weekEvents.push({
          playerId: m.playerId,
          name: m.name,
          position: m.position,
          expectedPPG: m.expectedPPG,
          lost,
          netLost,
          isStarter: m.isStarter,
          isIR: m.isIR,
          released: Boolean(m.released),
          replacement,
        });

        let pAgg = agg.playersById.get(m.playerId);
        if (!pAgg) {
          pAgg = {
            id: m.playerId,
            name: m.name,
            position: m.position,
            expectedPPG: m.expectedPPG,
            weeksMissed: 0,
            releasedWeeks: 0,
            impactWeeks: 0,
            lostPts: 0,
            netLostPts: 0,
            weeks: [],
          };
          agg.playersById.set(m.playerId, pAgg);
        }
        pAgg.weeksMissed += 1;
        if (m.released) pAgg.releasedWeeks += 1;
        if (netLost > EPS) pAgg.impactWeeks += 1;
        pAgg.lostPts += lost;
        pAgg.netLostPts += netLost;
        pAgg.weeks.push(week);
      }

      agg.byWeek.set(week, {
        week,
        missedCount: weekEvents.length,
        impactCount: weekEvents.filter((e) => e.netLost > EPS).length,
        lost: weekLost,
        netLost: weekNetLost,
        players: weekEvents,
      });
    }
  }

  const weekCount = weeks.length;
  const rows = [...aggByTeam.values()].map((agg) => {
    const players = [...agg.playersById.values()].sort(
      (a, b) => b.lostPts - a.lostPts || b.weeksMissed - a.weeksMissed || b.expectedPPG - a.expectedPPG
    );
    return {
      id: agg.id,
      team: agg.team,
      missedWeeks: agg.missedWeeks,
      impactWeeks: agg.impactWeeks,
      startedWhileOut: agg.startedWhileOut,
      uniquePlayers: players.length,
      lostPts: agg.lostPts,
      lostPerWeek: weekCount ? agg.lostPts / weekCount : 0,
      netLostPts: agg.netLostPts,
      releasedLostPts: agg.releasedLostPts,
      byWeek: agg.byWeek,
      players,
      biggestLoss: players[0] || null,
    };
  });

  // Rank by lost points (1 = most impacted).
  rows.sort((a, b) => b.lostPts - a.lostPts || b.missedWeeks - a.missedWeeks);
  rows.forEach((row, idx) => {
    row.impactRank = idx + 1;
  });

  const byMissed = [...rows].sort((a, b) => b.missedWeeks - a.missedWeeks || b.lostPts - a.lostPts);
  byMissed.forEach((row, idx) => {
    row.missedRank = idx + 1;
  });

  // League-wide costliest individual player-team injuries.
  const costliestInjuries = [];
  for (const row of rows) {
    for (const p of row.players) {
      if (p.lostPts > EPS) {
        costliestInjuries.push({
          ...p,
          teamId: row.id,
          team: teamsById.get(row.id),
        });
      }
    }
  }
  costliestInjuries.sort((a, b) => b.lostPts - a.lostPts || b.weeksMissed - a.weeksMissed);

  const maxWeekLost = Math.max(1, ...rows.flatMap((r) => [...r.byWeek.values()].map((w) => w.lost)));

  return {
    weeks,
    rows,
    rowsById: new Map(rows.map((r) => [r.id, r])),
    costliestInjuries,
    maxLostPts: Math.max(1, ...rows.map((r) => r.lostPts)),
    maxWeekLost,
  };
}
