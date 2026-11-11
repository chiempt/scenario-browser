# Heal benchmark

**Not measured yet: ANTHROPIC_API_KEY was not set when this report was generated (2026-11-11).** The fixtures were validated without the model (below); the heal column is empty on purpose. Run `ANTHROPIC_API_KEY=... npm run bench:heal` to fill it in.

Each case is a local HTML page. The scenario is written against the "before" page; the site then ships the "after" page where the selector changed in a common way. `--heal` must make the unchanged scenario pass on "after" (the final `expect` is the success check). Cases: 10. Fixture validation (scenario passes on "before", fails on "after" without heal, passes on "after" with a known-good selector): 10/10.

| Case | What changed | Fixture valid | Heal pass rate |
|---|---|---|---|
| id-renamed | button id renamed | yes | not measured |
| input-id-renamed | input id renamed, label kept | yes | not measured |
| class-renamed | CSS class renamed | yes | not measured |
| text-changed | button text changed | yes | not measured |
| wrapped-div | extra wrapper divs, structural selector | yes | not measured |
| select-renamed | select id renamed | yes | not measured |
| checkbox-moved | checkbox id renamed and moved into a label | yes | not measured |
| data-attr | data-testid renamed | yes | not measured |
| waitfor-heading | heading id renamed (waitFor + extract) | yes | not measured |
| ambiguous-twins | two similar buttons, ids renamed (harder: pick the right one) | yes | not measured |

Limits: 10 small synthetic pages, one model, tiny DOMs. This measures the repair loop on easy-to-medium breakage, not real-world sites. Re-generate with `npm run bench:heal` (set `BENCH_RUNS=3` for a pass rate per case).
