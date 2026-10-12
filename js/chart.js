/** Dependency-free SVG line chart for the power-ranking timeline. */

const NS = 'http://www.w3.org/2000/svg';

// Hand-picked for separability on a dark background; most leagues are <= 14 teams.
const PALETTE = [
  '#f87171', '#fb923c', '#facc15', '#a3e635', '#34d399', '#2dd4bf', '#38bdf8',
  '#818cf8', '#c084fc', '#f472b6', '#fda4af', '#94a3b8', '#eab308', '#4ade80',
];

export function teamColor(index, total) {
  if (total <= PALETTE.length) return PALETTE[index];
  // Golden-angle hues keep adjacent entries distinct in very large leagues.
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue} 70% ${index % 2 === 0 ? 64 : 50}%)`;
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {{weeks:number[], teamCount:number, series:Array<{id:number,label:string,color:string,points:Array<{week:number,rank:number,pct:number}>}>}} data
 */
export function renderRankChart(container, data) {
  container.innerHTML = '';
  const { weeks, teamCount, series } = data;
  if (!weeks.length || !series.length) return;

  const W = 920;
  const H = 440;
  const pad = { top: 24, right: 28, bottom: 44, left: 56 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': 'Power ranking by week',
    preserveAspectRatio: 'xMidYMid meet',
  });

  const x = (week) => {
    if (weeks.length === 1) return pad.left + plotW / 2;
    const i = weeks.indexOf(week);
    return pad.left + (i / (weeks.length - 1)) * plotW;
  };
  const y = (rank) => {
    if (teamCount === 1) return pad.top + plotH / 2;
    return pad.top + ((rank - 1) / (teamCount - 1)) * plotH;
  };

  for (let rank = 1; rank <= teamCount; rank += 1) {
    const yy = y(rank);
    svg.appendChild(el('line', { x1: pad.left, x2: pad.left + plotW, y1: yy, y2: yy, class: 'grid-line' }));
    svg.appendChild(el('text', { x: pad.left - 12, y: yy + 4, 'text-anchor': 'end', class: 'axis-label' }, String(rank)));
  }

  const step = weeks.length > 12 ? 2 : 1;
  weeks.forEach((week, i) => {
    if (i % step !== 0 && i !== weeks.length - 1) return;
    const xx = x(week);
    svg.appendChild(el('line', { x1: xx, x2: xx, y1: pad.top, y2: pad.top + plotH, class: 'grid-line faint' }));
    svg.appendChild(
      el('text', { x: xx, y: pad.top + plotH + 24, 'text-anchor': 'middle', class: 'axis-label' }, `W${week}`)
    );
  });

  svg.appendChild(
    el(
      'text',
      { x: 16, y: pad.top + plotH / 2, 'text-anchor': 'middle', class: 'axis-title', transform: `rotate(-90 16 ${pad.top + plotH / 2})` },
      'Power rank'
    )
  );

  const lines = new Map();
  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.week).toFixed(1)} ${y(p.rank).toFixed(1)}`).join(' ');
    const group = el('g', { class: 'series', 'data-team': s.id });
    group.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const p of s.points) {
      const dot = el('circle', { cx: x(p.week), cy: y(p.rank), r: 3.5, fill: s.color });
      dot.appendChild(el('title', {}, `${s.label} — Week ${p.week}: #${p.rank} (${(p.pct * 100).toFixed(1)}% all-play)`));
      group.appendChild(dot);
    }
    svg.appendChild(group);
    lines.set(String(s.id), group);
  }

  container.appendChild(svg);

  const legend = document.createElement('div');
  legend.className = 'legend';
  for (const s of series) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'legend-item';
    item.dataset.team = String(s.id);
    item.innerHTML = `<span class="swatch" style="background:${s.color}"></span>${s.label}`;
    item.addEventListener('mouseenter', () => {
      svg.classList.add('dimmed');
      lines.get(String(s.id))?.classList.add('active');
    });
    item.addEventListener('mouseleave', () => {
      svg.classList.remove('dimmed');
      lines.get(String(s.id))?.classList.remove('active');
    });
    legend.appendChild(item);
  }
  container.appendChild(legend);
}
