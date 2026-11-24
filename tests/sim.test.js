/**
 * Edge-case tests for the normalizer and simulator.
 * Run with: node tests/sim.test.js   (no dependencies)
 */
import {
  normalize,
  normalizeRosters,
  estimateExpectedPPG,
  findReleasedPlayers,
  applyInjuredReleases,
  normalizePlayerGames,
  EspnError,
} from '../js/espn.js';
import { buildAnalysis, formatRecord } from '../js/sim.js';
import { buildInjuryAnalysis, formatWeekRanges } from '../js/injuries.js';

let failures = 0;
let current = '';

const suite = (name) => {
  current = name;
  console.log(`\n${name}`);
};

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) console.log(`        (in ${current})`);
}

/** Build a minimal ESPN-shaped payload. */
function payload(teams, schedule, matchupPeriodCount, { legacyNames = false } = {}) {
  return {
    settings: { name: 'Test League', size: teams.length, scheduleSettings: { matchupPeriodCount } },
    members: [{ id: 'A', firstName: 'Pat', lastName: 'Quinn', displayName: 'patq' }],
    teams: teams.map((t) =>
      legacyNames
        ? { id: t.id, location: t.location, nickname: t.nickname, abbrev: t.abbrev, owners: ['A'] }
        : { id: t.id, name: t.name, abbrev: t.abbrev, owners: ['A'] }
    ),
    schedule,
  };
}

/** One matchup; omit `awayId` to model a bye. */
function game(week, homeId, homePts, awayId, awayPts, tier = 'NONE') {
  const m = { matchupPeriodId: week, playoffTierType: tier, home: { teamId: homeId, totalPoints: homePts } };
  if (awayId != null) m.away = { teamId: awayId, totalPoints: awayPts };
  return m;
}

const named = (ids) => ids.map((i) => ({ id: i, name: `T${i}`, abbrev: `T${i}` }));
const sumBy = (rows, fn) => rows.reduce((s, r) => s + fn(r), 0);

function throwsEspnError(fn) {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof EspnError;
  }
}

/* ------------------------------------------------------------------ */

suite('Odd-sized league with bye weeks');
{
  const schedule = [
    game(1, 1, 100, 2, 90), game(1, 3, 80, 4, 70), game(1, 5, 120),
    game(2, 1, 110, 3, 105), game(2, 2, 60, 5, 95), game(2, 4, 85),
  ];
  const league = normalize(payload(named([1, 2, 3, 4, 5]), schedule, 2), 1, 2024);
  const a = buildAnalysis(league);
  const t5 = a.rowsById.get(5);

  check('every team is all-play scored in every week', a.rows.every((r) => r.byWeek.size === 2));
  check('a bye still produces an all-play result', formatRecord(t5.byWeek.get(1)) === '4-0', formatRecord(t5.byWeek.get(1)));
  check('a bye is excluded from the actual record', t5.actual.games === 1 && t5.actual.byes === 1);
  check('league-wide actual wins equal losses', sumBy(a.rows, (r) => r.actual.wins) === sumBy(a.rows, (r) => r.actual.losses));
  check('swap diagonal reproduces the real record', a.rows.every((r) => formatRecord(a.swap.get(r.id).cells.get(r.id)) === formatRecord(r.actual)));
  check(
    "borrowing a schedule skips that schedule's bye weeks",
    a.swap.get(1).cells.get(5).wins + a.swap.get(1).cells.get(5).losses === 1,
    formatRecord(a.swap.get(1).cells.get(5))
  );
}

suite('Luck is zero-sum when every team plays the same number of games');
{
  const schedule = [
    game(1, 1, 100, 2, 90), game(1, 3, 80, 4, 70), game(1, 5, 120, 6, 60),
    game(2, 1, 110, 3, 105), game(2, 2, 60, 5, 95), game(2, 4, 85, 6, 99),
  ];
  const a = buildAnalysis(normalize(payload(named([1, 2, 3, 4, 5, 6]), schedule, 2), 1, 2024));
  check('all teams played the same number of games', new Set(a.rows.map((r) => r.actual.games)).size === 1);
  check('luck sums to zero', Math.abs(sumBy(a.rows, (r) => r.luck)) < 1e-9, sumBy(a.rows, (r) => r.luck).toExponential(2));
  check(
    'expected wins total equals actual wins total',
    Math.abs(sumBy(a.rows, (r) => r.expectedWins) - sumBy(a.rows, (r) => r.actual.wins)) < 1e-9
  );
}

suite('Incomplete and non-regular-season weeks');
{
  const schedule = [
    game(1, 1, 100, 2, 90), game(1, 3, 80, 4, 70),
    game(2, 1, 95, 3, 99), game(2, 2, 88, 4, 77),
    game(3, 1, 0, 4, 0), game(3, 2, 0, 3, 0),      // nothing played
    game(4, 1, 101, 2, 99), game(4, 3, 0, 4, 0),   // only half played
    game(5, 1, 100, 2, 90, 'WINNERS_BRACKET'),     // playoffs
  ];
  const league = normalize(payload(named([1, 2, 3, 4]), schedule, 4), 1, 2024);
  check('only fully scored weeks are kept', String(league.weeks.map((w) => w.week)) === '1,2', String(league.weeks.map((w) => w.week)));
  check('skipped weeks are reported', league.skippedIncomplete === 2, String(league.skippedIncomplete));
  check('playoff games are excluded', buildAnalysis(league).rows.every((r) => r.actual.games === 2));
}

suite('Ties');
{
  // Three teams tie on 100; the fourth is well behind.
  const a = buildAnalysis(normalize(payload(named([1, 2, 3, 4]), [game(1, 1, 100, 2, 100), game(1, 3, 100, 4, 50)], 1), 1, 2024));
  const t1 = a.rowsById.get(1);
  check('a tied matchup is recorded as a tie', formatRecord(t1.actual) === '0-0-1', formatRecord(t1.actual));
  check('all-play counts both tied rivals', formatRecord(t1.allPlay) === '1-0-2', formatRecord(t1.allPlay));
  check('a tie is worth half a win', Math.abs(t1.allPlayPct - 2 / 3) < 1e-9, t1.allPlayPct.toFixed(4));
  check('the trailing team loses to everyone', formatRecord(a.rowsById.get(4).allPlay) === '0-3');
}

suite('Legacy team naming');
{
  const teams = [
    { id: 1, location: 'Green Bay', nickname: 'Packers', abbrev: 'GB' },
    { id: 2, location: 'Chicago', nickname: 'Bears', abbrev: 'CHI' },
  ];
  const league = normalize(payload(teams, [game(1, 1, 100, 2, 90)], 1, { legacyNames: true }), 1, 2019);
  check('name falls back to location + nickname', league.teams[0].name === 'Green Bay Packers', league.teams[0].name);
  check('owner name is resolved from members', league.teams[0].owner === 'Pat Quinn', league.teams[0].owner);
}

suite('Error handling');
{
  check('a season with no scores raises EspnError', throwsEspnError(() => normalize(payload(named([1, 2]), [game(1, 1, 0, 2, 0)], 1), 1, 2024)));
  check('a league with no teams raises EspnError', throwsEspnError(() => normalize({ settings: {}, teams: [], schedule: [] }, 1, 2024)));
  check('playoff-only data raises EspnError', throwsEspnError(() => normalize(payload(named([1, 2]), [game(1, 1, 10, 2, 9, 'WINNERS_BRACKET')], 1), 1, 2024)));
}

/** Build a minimal ESPN roster entry for injury tests. */
function rosterEntry({
  id,
  name,
  pos = 2,
  slot = 2,
  eligibleSlots = [2, 23, 20, 21],
  week,
  played = true,
  onBye = false,
  proTeamId = 10,
  weekProTeamId = 10,
  seasonAvg = 12,
  seasonGp = 10,
  projAvg = 12,
}) {
  const stats = [];
  if (seasonGp > 0) {
    stats.push({
      scoringPeriodId: 0,
      statSourceId: 0,
      statSplitTypeId: 0,
      appliedAverage: seasonAvg,
      appliedTotal: seasonAvg * seasonGp,
      stats: { '210': seasonGp },
    });
  }
  if (projAvg > 0) {
    stats.push({
      scoringPeriodId: 0,
      statSourceId: 1,
      statSplitTypeId: 0,
      appliedAverage: projAvg,
      appliedTotal: projAvg * 17,
    });
  }
  if (!onBye) {
    stats.push({
      scoringPeriodId: week,
      statSourceId: 0,
      statSplitTypeId: 1,
      proTeamId: weekProTeamId,
      appliedTotal: played ? seasonAvg : 0,
      stats: played ? { '210': 1 } : {},
    });
  }
  return {
    lineupSlotId: slot,
    playerPoolEntry: {
      player: {
        id,
        fullName: name,
        defaultPositionId: pos,
        proTeamId,
        eligibleSlots,
        stats,
      },
    },
  };
}

suite('Injury impact and expected lost points');
{
  const league = normalize(payload(named([1, 2]), [game(1, 1, 110, 2, 95)], 1), 1, 2024);

  // Team 1 loses a top-10 QB (22 PPG) replaced by a backup QB (14 PPG) -> 8.0 lost pts.
  // Also has a healthy player on bye (omitted week stat) who must NOT be counted as injured.
  // Team 2 loses a mid-tier RB (11 PPG) replaced by a 10 PPG RB -> 1.0 lost pt,
  // plus a bench WR (7 PPG) who wouldn't have started over their 12 PPG WR -> 0.0 lost pts.
  const rawW1 = {
    teams: [
      {
        id: 1,
        roster: {
          entries: [
            rosterEntry({ id: 101, name: 'Star QB', pos: 1, slot: 21, eligibleSlots: [0, 20, 21], week: 1, played: false, seasonAvg: 22, projAvg: 22 }),
            rosterEntry({ id: 102, name: 'Backup QB', pos: 1, slot: 0, eligibleSlots: [0, 20, 21], week: 1, played: true, seasonAvg: 14, projAvg: 14 }),
            rosterEntry({ id: 103, name: 'Bye RB', pos: 2, slot: 20, eligibleSlots: [2, 23, 20, 21], week: 1, played: false, onBye: true, seasonAvg: 18, projAvg: 18 }),
          ],
        },
      },
      {
        id: 2,
        roster: {
          entries: [
            rosterEntry({ id: 201, name: 'Mid RB', pos: 2, slot: 20, eligibleSlots: [2, 23, 20, 21], week: 1, played: false, seasonAvg: 11, projAvg: 11 }),
            rosterEntry({ id: 202, name: 'Fill-in RB', pos: 2, slot: 2, eligibleSlots: [2, 23, 20, 21], week: 1, played: true, seasonAvg: 10, projAvg: 10 }),
            rosterEntry({ id: 203, name: 'Bench WR', pos: 3, slot: 20, eligibleSlots: [4, 23, 20, 21], week: 1, played: false, seasonAvg: 7, projAvg: 7 }),
            rosterEntry({ id: 204, name: 'Starter WR', pos: 3, slot: 4, eligibleSlots: [4, 23, 20, 21], week: 1, played: true, seasonAvg: 12, projAvg: 12 }),
          ],
        },
      },
    ],
  };

  const rosters = normalizeRosters(new Map([[1, rawW1]]), [1, 2]);
  const inj = buildInjuryAnalysis(league, rosters);
  const t1 = inj.rowsById.get(1);
  const t2 = inj.rowsById.get(2);

  check('bye-week players are excluded from missed games', t1.missedWeeks === 1, String(t1.missedWeeks));
  check('losing a top-10 QB costs 8.0 expected points above backup', Math.abs(t1.netLostPts - 8) < 1e-9, String(t1.netLostPts));
  check('team with more raw injuries but lower impact ranks below star-QB loss', inj.rows[0].id === 1 && t2.missedWeeks === 2);
  check('bench-depth injury counts as missed but adds 0 lost lineup points', t2.impactWeeks === 1 && Math.abs(t2.netLostPts - 1) < 1e-9, String(t2.netLostPts));
}

suite('Injury edge cases: multiple same-slot injuries, started while out, 0-game projection');
{
  const league = normalize(payload(named([1, 2]), [game(1, 1, 80, 2, 100)], 1), 1, 2024);

  // Team 1 has 2 injured RBs on bench/IR (18 PPG and 15 PPG) and only ONE RB starter slot (10 PPG).
  // Only the 18 PPG RB should claim the 10 PPG replacement (+8.0); the 15 PPG RB cannot reuse that slot.
  // Team 2 leaves an injured 16 PPG WR in a starting slot -> full 16.0 lost points.
  const rawW1 = {
    teams: [
      {
        id: 1,
        roster: {
          entries: [
            rosterEntry({ id: 301, name: 'RB1 Out', pos: 2, slot: 21, eligibleSlots: [2, 20, 21], week: 1, played: false, seasonGp: 0, projAvg: 18 }),
            rosterEntry({ id: 302, name: 'RB2 Out', pos: 2, slot: 20, eligibleSlots: [2, 20, 21], week: 1, played: false, seasonAvg: 15, projAvg: 15 }),
            rosterEntry({ id: 303, name: 'RB3 Starter', pos: 2, slot: 2, eligibleSlots: [2, 20, 21], week: 1, played: true, seasonAvg: 10, projAvg: 10 }),
          ],
        },
      },
      {
        id: 2,
        roster: {
          entries: [
            rosterEntry({ id: 401, name: 'Started Out WR', pos: 3, slot: 4, eligibleSlots: [4, 20, 21], week: 1, played: false, seasonAvg: 16, projAvg: 16 }),
          ],
        },
      },
    ],
  };

  const rosters = normalizeRosters(new Map([[1, rawW1]]), [1, 2]);
  const inj = buildInjuryAnalysis(league, rosters);
  const t1 = inj.rowsById.get(1);
  const t2 = inj.rowsById.get(2);

  check('0-game season-ending injury uses preseason projection', Math.abs(t1.players[0].expectedPPG - 18) < 1e-9);
  check('single starter slot is not double-counted across two injured RBs', Math.abs(t1.netLostPts - 8) < 1e-9, String(t1.netLostPts));
  check('player started while out loses full expected PPG', Math.abs(t2.netLostPts - 16) < 1e-9 && t2.startedWhileOut === 1);
  check('week range formatter groups consecutive weeks', formatWeekRanges([1, 2, 3, 5, 7, 8]) === 'W1–W3, W5, W7–W8');
  check('estimateExpectedPPG uses the season average once a player has played', Math.abs(estimateExpectedPPG({
    stats: [
      { scoringPeriodId: 0, statSourceId: 0, statSplitTypeId: 0, appliedAverage: 12, appliedTotal: 48, stats: { '210': 4 } },
      { scoringPeriodId: 0, statSourceId: 1, statSplitTypeId: 0, appliedAverage: 20, appliedTotal: 340 },
    ],
  }) - 12) < 1e-9);
  check('estimateExpectedPPG ignores the previous season\'s average', Math.abs(estimateExpectedPPG({
    stats: [
      { seasonId: 2025, scoringPeriodId: 0, statSourceId: 0, statSplitTypeId: 0, appliedAverage: 20, appliedTotal: 320, stats: { 210: 16 } },
      { seasonId: 2026, scoringPeriodId: 0, statSourceId: 0, statSplitTypeId: 0, appliedAverage: 16, appliedTotal: 80, stats: { 210: 5 } },
    ],
  }, 2026) - 16) < 1e-9);
}

suite('Players released while injured keep costing the releasing team');
{
  const weeks = [1, 2, 3, 4, 5];
  const league = normalize(
    payload(named([1, 2]), weeks.map((w) => game(w, 1, 100, 2, 90)), weeks.length),
    1,
    2026
  );

  const qb = { pos: 1, eligibleSlots: [0, 20, 21] };
  const wr = { pos: 3, eligibleSlots: [4, 20, 21] };
  // Team 1: star QB (20 PPG) is out week 1 on IR, then released. Backup QB (12 PPG) starts.
  // Team 2: releases a healthy WR after week 1 who keeps playing; that is not an injury.
  const rawFor = (week) => ({
    teams: [
      {
        id: 1,
        roster: {
          entries: [
            ...(week === 1 ? [rosterEntry({ id: 11, name: 'Star QB', ...qb, slot: 21, week, played: false, seasonAvg: 20, projAvg: 0 })] : []),
            rosterEntry({ id: 12, name: 'Backup QB', ...qb, slot: 0, week, played: true, seasonAvg: 12, projAvg: 12 }),
          ],
        },
      },
      {
        id: 2,
        roster: {
          entries: [
            ...(week === 1 ? [rosterEntry({ id: 21, name: 'Healthy WR', ...wr, slot: 20, week, played: true })] : []),
            rosterEntry({ id: 22, name: 'Starter WR', ...wr, slot: 4, week, played: true }),
          ],
        },
      },
    ],
  });

  const rosters = normalizeRosters(new Map(weeks.map((w) => [w, rawFor(w)])), [1, 2]);
  const released = findReleasedPlayers(rosters);
  check('releases are detected for players on no roster the next week', released.length === 2, String(released.length));

  // Star QB: out W2, bye W3, out W4, returns W5. Healthy WR plays W2.
  const games = normalizePlayerGames(
    [
      {
        player: {
          id: 11,
          stats: [
            { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 0 },
            { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 0 },
            { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 5, appliedTotal: 18, stats: { '210': 1 } },
            // Another season's record for the same week must be ignored.
            { seasonId: 2025, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 4, appliedTotal: 30, stats: { '210': 1 } },
          ],
        },
      },
      {
        player: {
          id: 21,
          stats: [{ seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 9, stats: { '210': 1 } }],
        },
      },
    ],
    2026
  );
  applyInjuredReleases(rosters, released, games);

  const inj = buildInjuryAnalysis(league, rosters);
  const t1 = inj.rowsById.get(1);
  const t2 = inj.rowsById.get(2);
  const star = t1.players.find((p) => p.id === 11);

  check('injured release keeps counting non-bye weeks until the player returns', star.weeks.join() === '1,2,4', star.weeks.join());
  check('weeks after release are flagged', star.releasedWeeks === 2, String(star.releasedWeeks));
  check('every week out costs the full season average', Math.abs(t1.lostPts - 60) < 1e-9, String(t1.lostPts));
  check('above-replacement loss subtracts the weakest eligible starter', Math.abs(t1.netLostPts - 24) < 1e-9, String(t1.netLostPts));
  check('post-release loss is reported separately', Math.abs(t1.releasedLostPts - 40) < 1e-9, String(t1.releasedLostPts));
  check('healthy releases are not charged', t2.missedWeeks === 0 && t2.releasedLostPts === 0);
}

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
