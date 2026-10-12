# 🏈 Fantasy Matchup Simulator

Your fantasy football record only tells you who you *happened* to play. This tool replays every
week of an ESPN fantasy league against **every team in the league**, not just the scheduled
opponent — so you can finally settle whether you were good or just lucky.

Paste an ESPN league ID, pick a season, and it computes the whole alternate universe in your
browser. No server, no accounts, no data leaves the page.

## What it shows

| View | What you get |
| --- | --- |
| **Standings & luck** | All-play record (every team vs. every team, every week), "true" rank, expected wins, and a luck rating — actual wins minus the wins your scoring pace deserved. Plus points for/against and strength of schedule. |
| **Week-by-week grid** | A heat-mapped team × week matrix. Each cell is that team's record against the entire league that week, with a colored edge showing whether they actually won or lost. Includes a per-week drill-down. |
| **Schedule swap** | A full round-robin: what every team's record would be playing every *other* team's schedule. The diagonal is their real season. Also ranks which schedule was easiest. |
| **Power rankings** | Cumulative all-play win percentage converted to a weekly power rank, drawn as a line chart plus a rank table. |

Results are shareable — the URL updates with the league, season, and active tab, e.g.
`#league=203836968&season=2024&tab=swap`.

## How the numbers work

- **All-play record** — for each week, a team's score is compared against every other team's score
  that week. In a 10-team league that turns 13 real games into 117 simulated ones per team.
- **Expected wins** — all-play win percentage × games actually played.
- **Luck** — actual wins minus expected wins. Positive means you won more than your scoring earned.
  Across a league, luck always sums to zero.
- **Rank Δ** — places gained (▲) or lost (▼) when you sort by all-play record instead of real record.
- **Strength of schedule** — the average all-play strength of the opponents you actually faced.
- **Schedule swap** — a team's weekly scores are replayed against another team's opponents. When the
  borrowed schedule would have a team face itself, it faces the schedule's owner instead.

Only **completed regular-season weeks** are counted. Playoff and consolation games are excluded, and
any week that has not been fully scored is skipped so every view uses the same sample.

## Leagues it can read

The site is fully static, so it can only read leagues that ESPN serves publicly. If you see a
privacy error, a league manager can set **League Settings → Basic Settings → Visibility** to
**Public**.

Your league ID is the number in your ESPN league URL:

```
https://fantasy.espn.com/football/league?leagueId=203836968&seasonId=2024
                                                  ^^^^^^^^^
```

## Running locally

ES modules need to be served over HTTP, so open it through a local server rather than `file://`:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

There is no build step and there are no dependencies.

## Deploying

Any static host works. For GitHub Pages, push to `main` and set
**Settings → Pages → Source** to *Deploy from a branch* → `main` / `/ (root)`.
The included `.nojekyll` file stops Jekyll from interfering with the `js/` directory.

## Project layout

```
index.html      markup and the four tab panels
styles.css      all styling
js/espn.js      fetches the ESPN API and normalizes a season into teams + weekly scores
js/sim.js       all the math: all-play, luck, schedule swaps, power rankings
js/chart.js     dependency-free SVG line chart
js/app.js       rendering, tabs, URL state
```

---

Not affiliated with ESPN or the NFL. Data is fetched live from ESPN's public fantasy API.
