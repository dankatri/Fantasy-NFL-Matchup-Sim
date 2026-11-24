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
 * - If left in a starting slot, the full expected PPG is lost.
 * - If moved to bench or IR, expected lost points is the gap between the injured
 *   player's healthy expected PPG and the weakest eligible starter the team had
 *   to play in their place (floored at 0, so bench-depth injuries don't inflate
 *   starting-lineup impact). Each starter slot is matched at most once per week.
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
        grossLostPts: 0,
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
      let weekGrossLost = 0;

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

        const gross = m.expectedPPG;
        agg.missedWeeks += 1;
        if (netLost > EPS) agg.impactWeeks += 1;
        agg.grossLostPts += gross;
        agg.netLostPts += netLost;
        weekNetLost += netLost;
        weekGrossLost += gross;
        if (m.released) agg.releasedLostPts += netLost;

        weekEvents.push({
          playerId: m.playerId,
          name: m.name,
          position: m.position,
          expectedPPG: m.expectedPPG,
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
            netLostPts: 0,
            grossLostPts: 0,
            weeks: [],
          };
          agg.playersById.set(m.playerId, pAgg);
        }
        pAgg.weeksMissed += 1;
        if (m.released) pAgg.releasedWeeks += 1;
        if (netLost > EPS) pAgg.impactWeeks += 1;
        pAgg.netLostPts += netLost;
        pAgg.grossLostPts += gross;
        pAgg.weeks.push(week);
      }

      agg.byWeek.set(week, {
        week,
        missedCount: weekEvents.length,
        impactCount: weekEvents.filter((e) => e.netLost > EPS).length,
        netLost: weekNetLost,
        grossLost: weekGrossLost,
        players: weekEvents,
      });
    }
  }

  const weekCount = weeks.length;
  const rows = [...aggByTeam.values()].map((agg) => {
    const players = [...agg.playersById.values()].sort(
      (a, b) => b.netLostPts - a.netLostPts || b.weeksMissed - a.weeksMissed || b.expectedPPG - a.expectedPPG
    );
    return {
      id: agg.id,
      team: agg.team,
      missedWeeks: agg.missedWeeks,
      impactWeeks: agg.impactWeeks,
      startedWhileOut: agg.startedWhileOut,
      uniquePlayers: players.length,
      netLostPts: agg.netLostPts,
      netLostPerWeek: weekCount ? agg.netLostPts / weekCount : 0,
      grossLostPts: agg.grossLostPts,
      releasedLostPts: agg.releasedLostPts,
      byWeek: agg.byWeek,
      players,
      biggestLoss: players[0] || null,
    };
  });

  // Rank by net expected lost points (1 = most impacted).
  rows.sort((a, b) => b.netLostPts - a.netLostPts || b.missedWeeks - a.missedWeeks);
  rows.forEach((row, idx) => {
    row.impactRank = idx + 1;
  });

  const byMissed = [...rows].sort((a, b) => b.missedWeeks - a.missedWeeks || b.netLostPts - a.netLostPts);
  byMissed.forEach((row, idx) => {
    row.missedRank = idx + 1;
  });

  // League-wide costliest individual player-team injuries.
  const costliestInjuries = [];
  for (const row of rows) {
    for (const p of row.players) {
      if (p.netLostPts > EPS) {
        costliestInjuries.push({
          ...p,
          teamId: row.id,
          team: teamsById.get(row.id),
        });
      }
    }
  }
  costliestInjuries.sort((a, b) => b.netLostPts - a.netLostPts || b.weeksMissed - a.weeksMissed);

  const maxWeekNetLost = Math.max(
    1,
    ...rows.flatMap((r) => [...r.byWeek.values()].map((w) => w.netLost))
  );

  return {
    weeks,
    rows,
    rowsById: new Map(rows.map((r) => [r.id, r])),
    costliestInjuries,
    maxNetLostPts: Math.max(1, ...rows.map((r) => r.netLostPts)),
    maxWeekNetLost,
  };
}
