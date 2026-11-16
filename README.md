# LumenMark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/sherrypubg128-blip/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/sherrypubg128-blip/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

LumenMark is a hand-written, dependency-free Markdown renderer. Its
`parse(markdown)` returns exactly the HTML that marked 18.1.3 renders with
its default options (GFM on), only faster: a line-oriented block pass plus
a hand-rolled inline scanner, with no regular expressions on the hot path.

## Run it

```sh
node main.ts
```

`main.ts` reads `cases.json` from `$MAKEFUN_INPUT_DIR` (default `/input`) and
writes `html.json` to `$MAKEFUN_OUTPUT_DIR` (default `/output`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=p04vaw3r&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
