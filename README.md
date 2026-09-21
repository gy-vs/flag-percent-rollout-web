# Feature Evaluation Lab

Local workbench for evaluation rules.

Run `npm install`, then `npm run dev`.

## Variant slot allocation

Flag content may be a JSON config of the form
`{"flag": "name", "variants": [{"key": "control", "weight": 50}, ...]}`.
Weights are percents and must total 100 ± 0.01.

- Weights are quantized to integer micro-percents (0.0001%) and converted into
  a fixed space of **10,000 integer slots**; each variant owns a half-open
  interval `[start, end)`. Every slot belongs to exactly one variant, so no
  hash can fall between intervals or past the 99.999…% boundary.
- Rounding remainders are distributed by largest fraction, ties broken by
  variant key. Variants are allocated in sorted-key order, so **list order
  never affects assignment** — reordering variants cannot reshuffle users.
- Users are hashed with murmur3-32 (seeded by the flag id) and mapped to a
  slot via multiply-shift, which is uniform over the 32-bit hash space;
  the maximum hash maps to slot 9999, never out of range.
- The editor preview shows the actual slot ranges and effective weights, not
  raw float cumulative sums.

Endpoints: `GET/PUT /api/flags/:id` (PUT validates configs, 422 on invalid),
`POST /api/flags/:id/analyze`, `POST /api/flags/:id/assign` (`{userId}`),
`POST /api/flags/:id/simulate` (`{samples}`).
