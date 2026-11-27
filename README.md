# PNG Squeezer — lossless screenshot compressor

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/bisnanjp01-spec/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/bisnanjp01-spec/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

`main.ts` re-encodes each 1280×720 RGBA screenshot as the smallest lossless
PNG it can, in one run over a set of eight instances. Node 22, built-ins only,
no network, no clock reads — the same input always produces byte-identical
output.

## How it squeezes

1. **Colour-type reduction.** The pixels are analysed first: at most 256
   distinct colours becomes a palette image (colour type 3, with `tRNS`
   when any alpha is below 255); all-grey pixels become grey (type 0) or
   grey+alpha (type 4); opaque colour becomes RGB (type 2); the rest stays
   RGBA (type 6). Every pixel decodes exactly, including the colour under
   fully transparent pixels.
2. **Filter choice per band.** Two filtered streams are built: fixed filter 0
   (which preserves long repeated runs for the LZ77 matcher), and a
   per-band choice — bands of 60 rows, each band taking the filter whose
   zlib-level-6 size is smallest when tried on its own. The two streams are
   ranked by plain zlib level 6 and the smaller one wins.
3. **Chunked DEFLATE.** The winning stream is compressed as a single zlib
   stream at level 9, with a `Z_SYNC_FLUSH` block boundary every 90 rows so
   each block gets Huffman tables fitted to its own mixed content (flat
   bars, text, gradients, photo-like patches).
4. **Minimal PNG.** Only `IHDR`, `PLTE`/`tRNS` when needed, one `IDAT`, and
   `IEND` — exactly the chunks the contest's decoder accepts.

## Local result (practice set)

| instance | theme | bytes | vs scale |
| --- | --- | --- | --- |
| i001 | flat | 12,385 | 0.91 |
| i002 | rich | 48,725 | 0.88 |
| i003 | alpha | 102,808 | 0.95 |
| i004 | grey | 108,560 | 0.98 |
| i005 | flat | 16,422 | 0.88 |
| i006 | rich | 181,174 | 0.98 |
| i007 | alpha | 60,384 | 0.94 |
| i008 | grey | 24,505 | 0.91 |

Practice score **712,902** (mean 712.9 of 1,000 points per instance), all 8
instances answered exactly, verified with the kit's own local grader
(`grade-local`, two executions, reproduced byte for byte).

## Run it

```sh
node main.ts /input /output
```

The harness runs it as `node /bot/main.ts` with the mounts passed as
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` (or literally at `/input` and
`/output` in the docker sandbox). It writes `/output/<id>/image.png` for
`i001`–`i008`, each at most 4 MiB. A fixed, bounded amount of work per
instance — no wall-clock budgeting, so the 60-second budget is met by
construction.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mellow-harbor-70&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
