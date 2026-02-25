# Problem Statement: Garbled Circuit Visualizer

## Overview

Build a web-based interactive visualizer for garbled circuits, implemented in Rust compiled to WebAssembly (WASM), that allows users to step through the evaluation of a garbled circuit gate by gate.

## Goals

- Accept a circuit description in **Bristol Fashion** format as input
- Parse the circuit and render it as an interactive visual graph in the browser
- Allow users to **step through evaluation** of the circuit one gate at a time
- Display wire labels/values and gate states at each step
- Run entirely client-side via Rust + WASM (no backend required)

## Bristol Format

Bristol Fashion is a text format for describing boolean circuits. The format is:

```
<num_gates> <num_wires>
<num_inputs> <input_wire_count_1> [<input_wire_count_2> ...]
<num_outputs> <output_wire_count_1> [<output_wire_count_2> ...]
<gate_type> <num_inputs> <num_outputs> <input_wires...> <output_wires...>
...
```

Gate types include: `AND`, `XOR`, `INV` (NOT), `OR`, etc.

Example (1-bit adder):
```
3 6
2 1 1
1 1
2 1 3 0 1 XOR
2 1 3 1 2 AND
2 1 0 2 5 XOR
```

## Deliverables

1. **Rust/WASM core** — Bristol parser, circuit data model, step evaluator
2. **Web frontend** — HTML/CSS/JS shell that hosts the WASM module
3. **Graph renderer** — Visual layout of gates and wires (SVG or Canvas)
4. **Step controls** — UI to advance/rewind evaluation step by step
5. **Wire inspector** — Show current wire values (0/1 or garbled labels) per step

## Tech Stack

- **Rust** → compiled to WASM via `wasm-pack` / `wasm-bindgen`
- **Frontend** — Vanilla HTML/CSS/JS or a lightweight framework (no heavy build toolchain)
- **Rendering** — SVG preferred for the circuit graph (scalable, inspectable)
- **Hosting** — Static site; no server required

## Non-Goals (for now)

- Actual cryptographic garbling (labels will be plaintext 0/1 values for visualization)
- Multi-party computation simulation
- Circuit synthesis or optimization
- Mobile-first design
