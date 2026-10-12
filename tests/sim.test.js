/**
 * Edge-case tests for the normalizer and simulator.
 * Run with: node tests/sim.test.js   (no dependencies)
 */
import { normalize, EspnError } from '../js/espn.js';
import { buildAnalysis, formatRecord } from '../js/sim.js';

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

console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
