# gc-viz Project Memory

## Project
Garbled Circuit Visualizer — Rust/WASM web app for step-by-step garbled circuit evaluation.
See [problemstatement.md](../../problemstatement.md) for full scope.

## Status
Initial implementation complete and building. All 7 tests pass.

## Key Files
- `Cargo.toml` — dependencies pinned: `aes="0.8"`, `cipher="0.4"`, `getrandom={features=["js"]}`, `rand="0.8"`, `serde-wasm-bindgen="0.6"`, `wasm-bindgen="0.2"`
- `src/circuit.rs` — Bristol parser + `Circuit`/`Gate`/`GateType` types
- `src/garble.rs` — AES-128 garbling engine (point-and-permute, Davies-Meyer PRF)
- `src/evaluate.rs` — Delta-history evaluator (`Evaluator` struct, `step_forward`/`step_back`)
- `src/lib.rs` — WASM bindings: `parse_circuit()` + `EvalSession` struct
- `www/index.html` — Frontend shell; loads Dagre UMD from jsDelivr CDN
- `www/main.js` — ES module; Dagre layout, SVG rendering, step controls
- `www/style.css` — Dark theme
- `www/pkg/` — wasm-pack output (gitignored)

## Build & Serve
```bash
wasm-pack build --target web --out-dir www/pkg
python -m http.server 8080 --directory www
```

## Key Design Decisions
- `EvalSession::new` takes `circuit_json: &str` (JSON.stringify of circuitObj) — wasm-bindgen can't pass Rust structs by value across the boundary
- Garbling: color bit = LSB of label[0]; k0 has color 0, k1 has color 1
- AES PRF tweak: bytes 0-7 = gate_id as u64 BE, byte 8 = row, byte 9 = is_b_input flag
- Step-back: delta-history — each snapshot stores only `new_wire: Option<WireState>`; `current_known` HashMap maintained incrementally (O(1) per step)
- Dagre: `dagre@0.8.5` UMD from jsDelivr (exposes `window.dagre`); use `dagre.graphlib.Graph`

## Bristol Format Notes
Gate lines: `nin nout w_in_0 [w_in_1] w_out GATE_TYPE`
Input wires = first `sum(input_wire_counts)` wire indices.
Output wires = last `sum(output_wire_counts)` wire indices.
Gates are in topological order by spec — no sort needed.
