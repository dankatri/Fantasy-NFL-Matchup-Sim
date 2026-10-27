import { loadLeague, EspnError } from './espn.js';
import { buildAnalysis, formatRecord } from './sim.js';
import { renderRankChart, teamColor } from './chart.js';

const DEFAULT_SEASON = 2026;
const DEMO = { leagueId: '203836968', season: 2024 };

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#league-form'),
  leagueId: $('#leagueId'),
  season: $('#season'),
  submit: $('#submit'),
  demo: $('#demo'),
  status: $('#status'),
  results: $('#results'),
  leagueName: $('#league-name'),
  leagueMeta: $('#league-meta'),
  tabs: $('#tabs'),
  panels: document.querySelectorAll('.panel'),
};

let analysis = null;
let colors = new Map();

/* ---------------------------------------------------------------- helpers */

const num = (v, digits = 1) => Number(v).toFixed(digits);
const pctText = (v) => `${(v * 100).toFixed(1)}%`;

function signed(v, digits = 1) {
  const n = Number(v);
  if (Math.abs(n) < 0.05) return '0.0';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function heatStyle(value) {
  // value in [0,1] -> red (cold) through neutral to green (hot)
  const hue = 8 + value * 132;
  const alpha = 0.18 + Math.abs(value - 0.5) * 0.5;
  return `background: hsl(${hue} 70% 45% / ${alpha.toFixed(2)})`;
}

function cell(tag, content, opts = {}) {
  const node = document.createElement(tag);
  if (opts.html) node.innerHTML = content;
  else node.textContent = content;
  if (opts.className) node.className = opts.className;
  if (opts.style) node.setAttribute('style', opts.style);
  if (opts.title) node.title = opts.title;
  if (opts.scope) node.setAttribute('scope', opts.scope);
  return node;
}

function table(headers, { stickyFirst = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = `table-wrap${stickyFirst ? ' sticky-first' : ''}`;
  const tbl = document.createElement('table');
  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const h of headers) {
    const th = cell('th', typeof h === 'string' ? h : h.label, {
      scope: 'col',
      title: typeof h === 'string' ? '' : h.title || '',
      className: typeof h === 'string' ? '' : h.className || '',
    });
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return { wrap, tbody };
}

function teamCell(row) {
  const td = document.createElement('td');
  td.className = 'team-cell';
  td.title = row.team.owner ? `${row.team.name} — ${row.team.owner}` : row.team.name;

  const inner = document.createElement('div');
  inner.className = 'team-inner';

  const dot = document.createElement('span');
  dot.className = 'team-dot';
  dot.style.background = colors.get(row.id);

  const name = document.createElement('span');
  name.className = 'team-name';
  name.textContent = row.team.name;

  // Shown instead of the full name on narrow screens so the sticky column stays small.
  const abbrev = document.createElement('span');
  abbrev.className = 'team-abbrev';
  abbrev.textContent = row.team.abbrev;

  inner.append(dot, name, abbrev);

  if (row.team.owner) {
    const owner = document.createElement('span');
    owner.className = 'team-owner';
    owner.textContent = row.team.owner;
    inner.appendChild(owner);
  }

  td.appendChild(inner);
  return td;
}

function setStatus(kind, title, detail) {
  if (!kind) {
    els.status.hidden = true;
    els.status.innerHTML = '';
    return;
  }
  els.status.hidden = false;
  els.status.className = `status ${kind}`;
  els.status.innerHTML = `<strong>${title}</strong>${detail ? `<span>${detail}</span>` : ''}`;
}

/* ---------------------------------------------------------------- renders */

function renderStandings() {
  const host = $('#panel-standings');
  host.innerHTML = '';

  host.appendChild(
    cell(
      'p',
      'Every team is re-scored against the <em>entire league</em> each week. "True rank" sorts by that all-play record; "Luck" is actual wins minus the wins an all-play record predicts.',
      { className: 'panel-note', html: true }
    )
  );

  const { wrap, tbody } = table([
    { label: '#', className: 'col-rank', title: 'True rank from all-play record' },
    { label: 'Team', className: 'col-team' },
    { label: 'Actual', title: 'Record against the scheduled opponent' },
    { label: 'All-play', title: 'Record versus every team, every week' },
    { label: 'All-play %', title: 'All-play win percentage' },
    { label: 'Exp. W', title: 'Wins expected from the all-play win rate' },
    { label: 'Luck', title: 'Actual wins minus expected wins' },
    { label: 'Rank Δ', title: 'Places gained (▲) or lost (▼) moving from the actual standings to the true standings' },
    { label: 'PF/wk', title: 'Points for per week' },
    { label: 'PA/g', title: 'Points against per game' },
    { label: 'SOS', title: 'Average all-play strength of opponents faced' },
  ]);

  for (const row of analysis.rows) {
    const tr = document.createElement('tr');
    tr.appendChild(cell('td', String(row.trueRank), { className: 'rank' }));
    tr.appendChild(teamCell(row));
    tr.appendChild(cell('td', formatRecord(row.actual), { className: 'mono' }));
    tr.appendChild(cell('td', formatRecord(row.allPlay), { className: 'mono' }));
    tr.appendChild(cell('td', pctText(row.allPlayPct), { className: 'mono', style: heatStyle(row.allPlayPct) }));
    tr.appendChild(cell('td', num(row.expectedWins), { className: 'mono' }));

    const luckClass = row.luck > 0.5 ? 'good' : row.luck < -0.5 ? 'bad' : 'neutral';
    tr.appendChild(
      cell('td', signed(row.luck), {
        className: `mono ${luckClass}`,
        title: row.luck > 0 ? `${num(row.luck)} more wins than deserved` : `${num(-row.luck)} fewer wins than deserved`,
      })
    );

    const deltaClass = row.rankDelta > 0 ? 'good' : row.rankDelta < 0 ? 'bad' : 'neutral';
    const deltaText = row.rankDelta === 0 ? '—' : `${row.rankDelta > 0 ? '▲' : '▼'} ${Math.abs(row.rankDelta)}`;
    tr.appendChild(
      cell('td', deltaText, {
        className: `mono ${deltaClass}`,
        title: `Actual standings: #${row.actualRank} · True: #${row.trueRank}`,
      })
    );

    tr.appendChild(cell('td', num(row.pfPerWeek), { className: 'mono' }));
    tr.appendChild(cell('td', num(row.paPerGame), { className: 'mono' }));
    tr.appendChild(cell('td', pctText(row.sos), { className: 'mono', style: heatStyle(row.sos) }));
    tbody.appendChild(tr);
  }

  host.appendChild(wrap);
  host.appendChild(renderHighlights());
}

function renderHighlights() {
  const rows = analysis.rows;
  const luckiest = [...rows].sort((a, b) => b.luck - a.luck)[0];
  const unluckiest = [...rows].sort((a, b) => a.luck - b.luck)[0];
  const strongest = rows[0];
  const hardest = [...rows].sort((a, b) => b.sos - a.sos)[0];

  const cards = [
    { label: 'Best team (all-play)', value: strongest.team.name, sub: `${formatRecord(strongest.allPlay)} · ${pctText(strongest.allPlayPct)}` },
    { label: 'Luckiest', value: luckiest.team.name, sub: `${signed(luckiest.luck)} wins vs. expected` },
    { label: 'Unluckiest', value: unluckiest.team.name, sub: `${signed(unluckiest.luck)} wins vs. expected` },
    { label: 'Toughest schedule', value: hardest.team.name, sub: `Opponents averaged ${pctText(hardest.sos)} all-play` },
  ];

  const grid = document.createElement('div');
  grid.className = 'cards';
  for (const c of cards) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<span class="card-label">${c.label}</span><strong class="card-value">${c.value}</strong><span class="card-sub">${c.sub}</span>`;
    grid.appendChild(card);
  }
  return grid;
}

function renderGrid() {
  const host = $('#panel-grid');
  host.innerHTML = '';
  const { weeks, opponentCount } = analysis;

  host.appendChild(
    cell(
      'p',
      'Each cell is that team\'s record <em>against the whole league</em> in that week. Green means they would have beaten almost everyone; red means almost nobody. The border shows whether they actually won (green), lost (red) or tied their real matchup.',
      { className: 'panel-note', html: true }
    )
  );

  const headers = [
    { label: 'Team', className: 'col-team' },
    ...weeks.map((w) => ({ label: `W${w}`, className: 'week-col' })),
    { label: 'Total', className: 'total-col' },
  ];
  const { wrap, tbody } = table(headers, { stickyFirst: true });

  for (const row of analysis.rows) {
    const tr = document.createElement('tr');
    tr.appendChild(teamCell(row));

    for (const week of weeks) {
      const wk = row.byWeek.get(week);
      if (!wk) {
        tr.appendChild(cell('td', '—', { className: 'mono muted' }));
        continue;
      }
      const weekData = analysis.league.weeks.find((x) => x.week === week);
      const oppId = weekData.opponents.get(row.id);
      const oppScore = oppId != null ? weekData.scores.get(oppId) : null;
      const oppRow = oppId != null ? analysis.rowsById.get(oppId) : null;

      let outcome = 'bye';
      if (oppScore != null) outcome = wk.score > oppScore ? 'win' : wk.score < oppScore ? 'loss' : 'tie';

      const title = oppRow
        ? `Week ${week}: ${num(wk.score)} vs ${oppRow.team.name} ${num(oppScore)} — actual ${outcome.toUpperCase()}\nAll-play ${wk.wins}-${wk.losses}${wk.ties ? `-${wk.ties}` : ''} (${pctText(wk.pct)})`
        : `Week ${week}: ${num(wk.score)} — bye\nAll-play ${wk.wins}-${wk.losses} (${pctText(wk.pct)})`;

      tr.appendChild(
        cell('td', `${wk.wins}-${wk.losses}${wk.ties ? `-${wk.ties}` : ''}`, {
          className: `mono grid-cell ${outcome}`,
          style: heatStyle(wk.wins / opponentCount),
          title,
        })
      );
    }

    tr.appendChild(
      cell('td', `${formatRecord(row.allPlay)}`, {
        className: 'mono total-col',
        style: heatStyle(row.allPlayPct),
        title: `${pctText(row.allPlayPct)} all-play win rate`,
      })
    );
    tbody.appendChild(tr);
  }

  host.appendChild(wrap);
  host.appendChild(renderWeekBreakdown());
}

function renderWeekBreakdown() {
  const section = document.createElement('section');
  section.className = 'subsection';

  const header = document.createElement('div');
  header.className = 'subsection-head';
  header.innerHTML = '<h3>Single week detail</h3>';

  const select = document.createElement('select');
  select.className = 'week-select';
  for (const w of analysis.weeks) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = `Week ${w}`;
    select.appendChild(opt);
  }
  select.value = String(analysis.weeks[analysis.weeks.length - 1]);
  header.appendChild(select);
  section.appendChild(header);

  const body = document.createElement('div');
  section.appendChild(body);

  const draw = () => {
    const week = Number(select.value);
    const weekData = analysis.league.weeks.find((x) => x.week === week);
    body.innerHTML = '';

    const ranked = [...weekData.scores.entries()].sort((a, b) => b[1] - a[1]);
    const { wrap, tbody } = table([
      { label: '#', className: 'col-rank' },
      { label: 'Team', className: 'col-team' },
      'Score',
      { label: 'Opponent', className: 'text-left' },
      'Actual',
      'All-play this week',
    ]);

    ranked.forEach(([teamId, score], idx) => {
      const row = analysis.rowsById.get(teamId);
      if (!row) return;
      const oppId = weekData.opponents.get(teamId);
      const oppRow = oppId != null ? analysis.rowsById.get(oppId) : null;
      const oppScore = oppId != null ? weekData.scores.get(oppId) : null;
      const wk = row.byWeek.get(week);
      const outcome = oppScore == null ? 'BYE' : score > oppScore ? 'WIN' : score < oppScore ? 'LOSS' : 'TIE';

      const tr = document.createElement('tr');
      tr.appendChild(cell('td', String(idx + 1), { className: 'rank' }));
      tr.appendChild(teamCell(row));
      tr.appendChild(cell('td', num(score, 2), { className: 'mono' }));
      tr.appendChild(cell('td', oppRow ? `${oppRow.team.name} (${num(oppScore, 2)})` : '—', { className: 'text-left' }));
      tr.appendChild(
        cell('td', outcome, { className: `mono ${outcome === 'WIN' ? 'good' : outcome === 'LOSS' ? 'bad' : 'neutral'}` })
      );
      tr.appendChild(
        cell('td', `${wk.wins}-${wk.losses}${wk.ties ? `-${wk.ties}` : ''}`, {
          className: 'mono',
          style: heatStyle(wk.pct),
        })
      );
      tbody.appendChild(tr);
    });

    body.appendChild(wrap);
  };

  select.addEventListener('change', draw);
  draw();
  return section;
}

function renderSwap() {
  const host = $('#panel-swap');
  host.innerHTML = '';

  host.appendChild(
    cell(
      'p',
      'Read a row to see what that team\'s record would be if it had played <em>every other team\'s schedule</em>. The outlined diagonal is their real schedule. Columns show which schedule was easiest or hardest.',
      { className: 'panel-note', html: true }
    )
  );

  const headers = [
    { label: 'Team', className: 'col-team' },
    ...analysis.rows.map((r) => ({ label: r.team.abbrev, title: `${r.team.name}'s schedule`, className: 'swap-col' })),
    { label: 'Avg W', className: 'total-col' },
    { label: 'Range', className: 'total-col' },
  ];
  const { wrap, tbody } = table(headers, { stickyFirst: true });

  const maxGames = Math.max(1, ...analysis.rows.map((r) => r.actual.games));

  for (const row of analysis.rows) {
    const swap = analysis.swap.get(row.id);
    const tr = document.createElement('tr');
    tr.appendChild(teamCell(row));

    for (const owner of analysis.rows) {
      const rec = swap.cells.get(owner.id);
      const isSelf = owner.id === row.id;
      tr.appendChild(
        cell('td', formatRecord(rec), {
          className: `mono swap-cell${isSelf ? ' self' : ''}`,
          style: heatStyle(rec.pct),
          title: `${row.team.name} playing ${owner.team.name}'s schedule: ${formatRecord(rec)} (${pctText(rec.pct)})${
            isSelf ? '\nThis is their actual schedule.' : ''
          }`,
        })
      );
    }

    tr.appendChild(cell('td', num(swap.avgWins), { className: 'mono total-col', style: heatStyle(swap.avgWins / maxGames) }));
    tr.appendChild(
      cell('td', `${swap.worst.wins}–${swap.best.wins}`, {
        className: 'mono total-col',
        title: `Worst possible: ${formatRecord(swap.worst)} · Best possible: ${formatRecord(swap.best)}`,
      })
    );
    tbody.appendChild(tr);
  }

  host.appendChild(wrap);
  host.appendChild(renderScheduleDifficulty());
}

function renderScheduleDifficulty() {
  const section = document.createElement('section');
  section.className = 'subsection';
  section.innerHTML = '<div class="subsection-head"><h3>Which schedule was easiest?</h3></div>';

  const ranked = analysis.rows
    .map((owner) => {
      const wins = analysis.rows.reduce((sum, team) => sum + analysis.swap.get(team.id).cells.get(owner.id).wins, 0);
      return { owner, avgWins: wins / analysis.rows.length };
    })
    .sort((a, b) => b.avgWins - a.avgWins);

  const maxGames = Math.max(1, ...analysis.rows.map((r) => r.actual.games));
  const lo = Math.min(...ranked.map((r) => r.avgWins));
  const hi = Math.max(...ranked.map((r) => r.avgWins));
  // Schedules cluster tightly, so stretch the heat across the observed spread.
  const spread = (v) => (hi - lo < 0.05 ? 0.5 : (v - lo) / (hi - lo));

  const { wrap, tbody } = table([
    { label: '#', className: 'col-rank' },
    { label: 'Schedule owner', className: 'col-team' },
    { label: 'Avg wins', title: 'Average wins a league-average team would get on this schedule' },
    { label: 'Their actual', title: 'What the schedule owner actually did with it' },
    { label: 'Difficulty', title: 'Easier schedules sit higher' },
  ]);

  ranked.forEach((entry, idx) => {
    const row = entry.owner;
    const tr = document.createElement('tr');
    tr.appendChild(cell('td', String(idx + 1), { className: 'rank' }));
    tr.appendChild(teamCell(row));
    tr.appendChild(
      cell('td', num(entry.avgWins), {
        className: 'mono',
        style: heatStyle(spread(entry.avgWins)),
        title: `A league-average team wins ${num(entry.avgWins)} of ${maxGames} games on this schedule`,
      })
    );
    tr.appendChild(cell('td', formatRecord(row.actual), { className: 'mono' }));
    tr.appendChild(cell('td', idx < ranked.length / 3 ? 'Easiest' : idx >= (2 * ranked.length) / 3 ? 'Hardest' : 'Average'));
    tbody.appendChild(tr);
  });

  section.appendChild(wrap);
  return section;
}

function renderPower() {
  const host = $('#panel-power');
  host.innerHTML = '';

  host.appendChild(
    cell(
      'p',
      'Power rank by week, driven by cumulative all-play win percentage rather than wins and losses. Hover the legend to isolate a team.',
      { className: 'panel-note' }
    )
  );

  const chartBox = document.createElement('div');
  chartBox.className = 'chart-box';
  host.appendChild(chartBox);

  renderRankChart(chartBox, {
    weeks: analysis.weeks,
    teamCount: analysis.rows.length,
    series: analysis.rows.map((row) => ({
      id: row.id,
      label: row.team.name,
      color: colors.get(row.id),
      points: analysis.power.get(row.id) || [],
    })),
  });

  const { wrap, tbody } = table([
    { label: 'Team', className: 'col-team' },
    ...analysis.weeks.map((w) => ({ label: `W${w}`, className: 'week-col' })),
    { label: 'Final', className: 'total-col' },
  ], { stickyFirst: true });

  const n = analysis.rows.length;
  for (const row of analysis.rows) {
    const points = analysis.power.get(row.id) || [];
    const byWeek = new Map(points.map((p) => [p.week, p]));
    const tr = document.createElement('tr');
    tr.appendChild(teamCell(row));
    for (const w of analysis.weeks) {
      const p = byWeek.get(w);
      tr.appendChild(
        p
          ? cell('td', String(p.rank), {
              className: 'mono',
              style: heatStyle(n === 1 ? 1 : 1 - (p.rank - 1) / (n - 1)),
              title: `Week ${w}: #${p.rank} · ${pctText(p.pct)} cumulative all-play`,
            })
          : cell('td', '—', { className: 'mono muted' })
      );
    }
    const last = points[points.length - 1];
    tr.appendChild(cell('td', last ? `#${last.rank}` : '—', { className: 'mono total-col' }));
    tbody.appendChild(tr);
  }

  host.appendChild(wrap);
}

function renderAll() {
  const { league } = analysis;
  els.leagueName.textContent = league.name;

  const bits = [
    `${league.season} season`,
    `${league.size} teams`,
    `${analysis.weeks.length} completed week${analysis.weeks.length === 1 ? '' : 's'}`,
    `League ${league.leagueId}`,
  ];
  els.leagueMeta.textContent = bits.join(' · ');

  renderStandings();
  renderGrid();
  renderSwap();
  renderPower();

  els.results.hidden = false;
}

/* ------------------------------------------------------------------ tabs */

const TABS = ['standings', 'grid', 'swap', 'power'];
let activeTab = 'standings';

function syncHash() {
  if (!analysis) return;
  const { leagueId, season } = analysis.league;
  history.replaceState(null, '', `#league=${leagueId}&season=${season}&tab=${activeTab}`);
}

function activateTab(name, { updateHash = true } = {}) {
  activeTab = TABS.includes(name) ? name : 'standings';
  for (const btn of els.tabs.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === activeTab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  for (const panel of els.panels) {
    panel.hidden = panel.id !== `panel-${activeTab}`;
  }
  if (updateHash) syncHash();
}

els.tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) activateTab(btn.dataset.tab);
});

/* ------------------------------------------------------------------ load */

function setBusy(busy) {
  els.submit.disabled = busy;
  els.demo.disabled = busy;
  els.submit.textContent = busy ? 'Simulating…' : 'Simulate league';
}

async function run(leagueId, season, { updateHash = true, tab = 'standings' } = {}) {
  const id = String(leagueId).trim();
  if (!/^\d+$/.test(id)) {
    setStatus('error', 'Enter a numeric league ID.', 'It is the number after "leagueId=" in your ESPN league URL.');
    return;
  }

  setBusy(true);
  els.results.hidden = true;
  setStatus('loading', `Loading league ${id} (${season})…`, 'Fetching matchups straight from ESPN.');

  try {
    const league = await loadLeague(id, season);
    analysis = buildAnalysis(league);
    colors = new Map(analysis.rows.map((row, i) => [row.id, teamColor(i, analysis.rows.length)]));
    renderAll();
    activateTab(tab, { updateHash });

    const simulated = analysis.weeks.length * analysis.rows.length * analysis.opponentCount;
    const skipped = league.skippedIncomplete
      ? ` ${league.skippedIncomplete} unplayed week${league.skippedIncomplete === 1 ? '' : 's'} excluded.`
      : '';
    setStatus(
      'success',
      `Simulated ${simulated.toLocaleString()} extra matchups.`,
      `Across ${analysis.weeks.length} weeks of ${league.name}.${skipped}`
    );
  } catch (err) {
    console.error(err);
    if (err instanceof EspnError) setStatus('error', err.message, err.hint);
    else setStatus('error', 'Something went wrong parsing that league.', err.message);
  } finally {
    setBusy(false);
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  run(els.leagueId.value, Number(els.season.value));
});

els.demo.addEventListener('click', () => {
  els.leagueId.value = DEMO.leagueId;
  els.season.value = String(DEMO.season);
  run(DEMO.leagueId, DEMO.season);
});

/* ------------------------------------------------------------------ init */

function populateSeasons() {
  const latest = Math.max(DEFAULT_SEASON, new Date().getFullYear());
  for (let year = latest; year >= 2018; year -= 1) {
    const opt = document.createElement('option');
    opt.value = String(year);
    opt.textContent = String(year);
    els.season.appendChild(opt);
  }
  els.season.value = String(DEFAULT_SEASON);
}

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const id = params.get('league');
  const season = params.get('season');
  const tab = params.get('tab');
  if (id) {
    els.leagueId.value = id;
    if (season) els.season.value = season;
    run(id, Number(season || els.season.value), { updateHash: false, tab: tab || 'standings' });
  }
}

populateSeasons();
readHash();
