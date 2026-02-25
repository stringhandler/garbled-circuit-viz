# gc-viz Project Memory

## Stack
- Rust/WASM via wasm-pack + wasm-bindgen
- Frontend: vanilla HTML/CSS/JS, SVG rendering via dagre layout
- Build: `wasm-pack build --target web` from repo root

## Key Files
- `src/lib.rs` — WASM bindings: `parse_circuit`, `EvalSession`, `OtSession`
- `src/garble.rs` — garbling logic, `Label=[u8;16]`, `aes_hash` PRF
- `src/evaluate.rs` — `Evaluator` with step_forward/back/insert_input_label
- `src/ot.rs` — Simplest OT (Chou-Orlandi 2015) over Ristretto255
- `www/main.js` — protocol phase machine (phases 0-6)
- `www/index.html` — UI: ownership panel, phase bar, party columns, protocol log
- `www/style.css` — dark theme; Alice=blue (#4a7eff), Bob=amber (#e8a844)

## Architecture
- Alice (garbler) and Bob (evaluator) split input wires via ownership UI
- Protocol phases: 0=idle → 1=garble → 2=sendGC → 3=aliceLabels → 4=OT → 5=evaluate → 6=done
- OT: 3 sub-steps per Bob wire (round1/round2/round3), each click of "Next" advances one sub-step
- `EvalSession::bob_wire_key_pair(wire_id)` → {m0,m1} for Alice's OT sender
- `EvalSession::provide_bob_label(wire_id, hex)` → inserts Bob's OT-derived label into evaluator

## Dependencies
- `curve25519-dalek = { version="4", default-features=false, features=["alloc"] }` — OT crypto
- `js-sys = "0.3"` — for JS Object/Reflect in WASM bindings

## Known Patterns
- Labels are 16-byte arrays; hex-encoded as 32-char strings for WASM boundary
- Ristretto points are 32 bytes → 64-char hex at WASM boundary
- Non-snake-case math vars (A, B, G) suppressed with `#[allow(non_snake_case)]` per function
