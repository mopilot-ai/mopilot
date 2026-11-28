# SquillaRouter runtime (Auto routing)

`electron/autoRoute/squilla/` runs OpenSquilla's default `lightgbm_model` router in Electron main. Given one turn, it
returns an intent (new task, continue, redo), a tier from C0 to C3, and a thinking mode from T0 to T3. The MoPilot
integration maps the tier and thinking mode onto a harness's models and efforts. This runtime only classifies.

## Pipeline

Each step is a port of OpenSquilla commit `96ad3e4` (`src/opensquilla/squilla_router/lightgbm_model`,
`engine/routing/model_policy.py` and `controller.py`).

- **Tier head.** It reads the current request only.
  - BGE CLS embedding, then PCA64.
  - char_wb TF-IDF, then SVD100.
  - The numeric features `rules48`, `route_history16`, `previous_signals19` and `context5`.
  - Together these form a 380-wide float32 vector. The LightGBM text model scores it, and a temperature of
    1.0909 calibrates the result.
- **Intent head.** BERT-60M INT8 reads three segments, each padded to 128 tokens: the current request (128 tokens),
  the last four user turns (80) and the previous answer (48). It also reads numeric88, after a float32 StandardScaler
  and a clip to ±5. Its temperature is 1.3493.
- **Policy.**
  - With no active task, the turn is a new task.
  - A redo starts when p_redo ≥ 0.25 and p_redo > p_new.
  - Otherwise a new task starts when p_new ≥ 0.01; below that the turn continues the active task.
  - A continue keeps the active tier. A redo raises it by one, up to C3. A new task takes the tier head's choice.
  - The thinking mode follows `controller.py`:
    - C3 always gets T3.
    - C2 with any of the debug, high-risk or long-context flags also gets T3.
    - Otherwise T0 needs C0 with a margin of at least 0.5, and T1 needs C1 or lower with a margin of at least 0.4.
    - Everything else is T2.
    - A trivial acknowledgement on C0 is T0.
  - Prompt policies (P0–P2) are not ported, because each harness owns its system prompt.

`router.cjs` is the entry point:

- It loads lazily on the first turn and unloads after 10 idle minutes.
- A call rejects on any failure, or after 200 ms. On a reject the caller keeps its own model and effort. A slow first
  load keeps running in the background and serves the next turn.
- `available()` is false when the weights are missing. It is also false on macOS x64, where `onnxruntime-node` has no
  build.

## Assets

Large weights are never committed.

- **Pinned weights.** `upstream.json` pins about 96 MB of files with their sizes and SHA-256: the BGE model, the
  tokenizer, the intent model, the gzipped tier model and the license.
- **Fetching.** `scripts/fetch-auto-route-assets.mjs` downloads and verifies them into
  `build/vendor/auto-route/squilla`. `scripts/package.mjs` calls `scripts/auto-route/packaging.mjs`, which does the
  same and ships the folder as `Resources/auto-route`. Packaging keeps only the build's own `onnxruntime-node`
  binary and unpacks it from the asar.
- **Where the runtime looks.** An explicit `assetsDir`, then `resourcesPath/auto-route/squilla`, then the checkout's
  `build/vendor/auto-route/squilla`, then `userData/auto-route/squilla`. A folder counts only when every file has its
  pinned size.
- **Converted parameters.** The fitted sklearn parameters (TF-IDF vocabulary and idf, SVD100, PCA64, scaler88) are
  committed as plain little-endian arrays in `params/`.
  - `scripts/auto-route/convert-squilla-transformers.py` produced them, reading the joblib files through a restricted
    unpickler that executes no pickled code.
  - ONNX Runtime is pinned to 1.24.3. OpenSquilla validated its own runtime on 1.24.x and measured feature drift on
    1.30.

## Parity

The CI unit tests use only checked-in data:

- OpenSquilla's numeric features for its parity inputs.
- `numeric_reference.json`, which `scripts/auto-route/numeric-reference.py` generated from the upstream Python on
  inputs chosen to probe Python regex and string semantics.
- The character TF-IDF/SVD block, compared exactly.
- The LightGBM calibration goldens.

`npm run auto-route:parity` checks the real weights. It fetches them if needed, then compares:

- tokenizer ids with Hugging Face `tokenizers` (`tokenizer_reference.json`);
- the eight fixed-feature tier goldens, within 1e-6;
- the source parity cases' features and tier probabilities, within OpenSquilla's measured ONNX Runtime bounds;
- the prepared intent inputs, which must hash identically;
- the intent probabilities, which must match one of OpenSquilla's measured CPU profiles.

ONNX quantization rounding differs between CPUs, as OpenSquilla's `PROVENANCE.md` records. These checks bound fixed
cases; they do not guarantee identical decisions on every input.
