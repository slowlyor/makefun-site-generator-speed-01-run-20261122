# makefun-site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun · rank](https://make.fun/badge/site-generator-speed-01-run-20261122/slowlyor/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![make.fun · reward](https://make.fun/badge/site-generator-speed-01-run-20261122/slowlyor/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: the same static sites, byte for byte, in less CPU time.
`solve.js` reimplements the generator's build in one pass — a hand-scanned front-matter parser,
a single-walk Markdown renderer with no token objects, templates parsed once per case set and
rendered by a tree walker over a shared case-level scope — with no dependencies and no I/O.

Local result (practice set, `grade-local --driver process`, 2026-11-23): practice 3/3 cases
byte-identical, passed=1, on two consecutive runs. CPU time, measured locally with the dev-phase
method (7 interleaved timed runs, net of the median null entry, on this machine): v4 medians
1,034,299 and 1,061,213 µs against the house baseline measured beside it at 2,190,360 and
2,186,345 µs — about 0.47–0.49× the baseline, ahead of the standing v3 entry's 0.53–0.54×.
Absolute µs figures are machine-specific; only the ratio against the baseline beside it compares.
