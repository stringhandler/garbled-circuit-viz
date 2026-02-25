# gc-viz — Claude Code Instructions

## Project

Garbled Circuit Visualizer — a Rust/WASM web app for parsing and stepping through boolean circuits in Bristol Fashion format.

See [problemstatement.md](problemstatement.md) for full requirements and scope.

## Stack

- **Rust** compiled to WASM via `wasm-pack` + `wasm-bindgen`
- **Frontend**: Vanilla HTML/CSS/JS (no heavy framework)
- **Rendering**: SVG for the circuit graph
- **Build**: `wasm-pack build --target web`

## Project Structure (planned)

```
gc-viz/
  src/              # Rust library (lib.rs entry point)
  www/              # Static web frontend (index.html, main.js, style.css)
  Cargo.toml
  CLAUDE.md
  problemstatement.md
```

## Development Guidelines

- Keep the Rust core pure (no direct DOM calls); expose a clean `wasm-bindgen` API
- The JS layer drives the UI and calls into WASM for parsing and evaluation steps
- Prefer SVG over Canvas for the circuit graph
- No server required; everything runs client-side

## Project management

Tasks are stored in `meta/tasks/`. It has `upnext`, `backlog` and `done`. When asked to create a new task, create it either in `backlog` or `upnext` as a `.md` file.
When a task is completed by you and requires manual verification, move to `meta/tasks/to_test`. You should also create a small .md doc with steps for me to test, in the same directory.