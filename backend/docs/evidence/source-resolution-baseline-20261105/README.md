This is the unchanged offline counterexample captured before the source-obligation resolution repair. `receipt.json`, `observations.json`, `run-8.log`, and `original-diagnostic.ts.txt` retain their original bytes. The receipt includes hashes of the earlier fixture failures; those failures were setup mistakes, not production regressions. The tested runtime at `9501068cf630f0dd1b76537a6995627840c0fb4e` is unchanged from canceled release candidate `bc7afab` (GitHub Actions run `41944374857`).

Five controls passed. They show the correct 14-terminal/3-cabinet answer is rejected when a retired 9-terminal obligation returns as pending. Deliberately false all-pass verifier records then demonstrate contradictory content reaching SQL publication and a verified local DOCX package. The artifact remains a review draft with yellow pending-review gaps; final approval is blocked. No provider inference, production access, or provider semantic success is claimed. See `FINDING.md` for the full boundary.

The separate portable harness is `backend/scripts/diagnostics/sourceResolutionBaseline.test.ts`. It is outside the normal `tests/backend` pass suite because it intentionally asserts the old defective behavior. To reproduce, point it at an isolated checkout of `9501068` or `bc7afab` with installed backend/frontend dependencies:

```sh
BASELINE_SOURCE_ROOT=/absolute/path/to/baseline-checkout BASELINE_OUTPUT_DIR=/tmp/source-resolution-baseline node backend/node_modules/vitest/vitest.mjs run backend/scripts/diagnostics/sourceResolutionBaseline.test.ts
```

Run from the fix checkout root. The harness uses baseline source and full baseline migrations; all writes are to a disposable local PGlite database and the chosen output directory. Do not point it at production. The retained original source is a separate artifact; making the harness portable did not rewrite the original receipt.
