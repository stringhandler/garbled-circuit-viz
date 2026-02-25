# Task: Two-Party Interaction with Oblivious Transfer

## Background

The current app garbles a circuit and lets a single "combined party" step through
evaluation. In real 2PC:

- **Alice** is the *garbler*: she creates the garbled circuit and knows her own
  input bits.
- **Bob** is the *evaluator*: he holds his own input bits but must receive the
  corresponding wire labels from Alice **without Alice learning Bob's bits**.

The mechanism that lets Bob get his labels privately is **1-of-2 Oblivious Transfer
(OT)**: Alice holds a pair `(m0, m1)` for each of Bob's input wires; Bob holds a
selection bit `b`; the protocol delivers `m_b` to Bob while Alice learns nothing
about `b`.

This task adds:

1. Input-wire ownership (Alice vs. Bob)
2. A simulated two-party protocol timeline (garble → send GC → send Alice labels →
   OT rounds → evaluate)
3. A concrete OT implementation in the Rust/WASM core (Naor-Pinkas style, simplified
   to toy DH for visualization)
4. A split two-column UI showing Alice's view and Bob's view

---

## Protocol Steps to Visualize

```
Step 0  Alice: Garble circuit → GC, wire_keys
Step 1  Alice → Bob: send GC (garbled tables)
Step 2  Alice → Bob: send labels for Alice's input wires (she knows her bits)
Step 3  For each of Bob's input wires w:
          OT sender  = Alice, holds (wire_keys[w][0], wire_keys[w][1])
          OT receiver = Bob, holds bit b_w
          Run 1-of-2 OT → Bob gets wire_keys[w][b_w], Alice learns nothing
Step 4  Bob evaluates GC gate by gate (existing step-through)
Step 5  Bob (optionally Alice) decodes output labels
```

---

## Rust Core Changes

### New file: `src/ot.rs`

Implement a **simplified 1-of-2 OT** using toy Diffie-Hellman (no external
crypto crate needed beyond what already exists). Use a fixed 128-bit safe prime
for the group. The protocol is the classic Naor-Pinkas OT:

```
Sender setup:
  Generate random a; compute A = g^a mod p; send A to receiver.

Receiver setup (bit b):
  Generate random r; compute:
    if b == 0: B = g^r mod p
    if b == 1: B = A * g^r mod p
  Compute k_r = A^r mod p (shared key for decryption)
  Send B to sender.

Sender respond (A, B, m0, m1):
  Compute k0 = B^a mod p,  k1 = (B / A)^a mod p
  Send e0 = m0 XOR H(k0), e1 = m1 XOR H(k1)

Receiver complete:
  Decrypt m_b = e_b XOR H(k_r)
```

Where `H` is a simple hash (SHA-256 truncated to 128 bits, or the existing AES
hash already in `garble.rs`).

Expose these types/functions:

```rust
// src/ot.rs
pub struct OtSenderSetup { pub sender_pk: BigUint }
pub struct OtReceiverSetup { pub receiver_pk: BigUint }
pub struct OtSenderResponse { pub e0: Label, pub e1: Label }

pub fn ot_sender_setup() -> (BigUint /*secret a*/, OtSenderSetup)
pub fn ot_receiver_setup(sender_setup: &OtSenderSetup, bit: u8)
    -> (BigUint /*secret r*/, OtReceiverSetup, Label /*k_r*/)
pub fn ot_sender_respond(
    secret_a: &BigUint,
    sender_setup: &OtSenderSetup,
    receiver_setup: &OtReceiverSetup,
    m0: Label, m1: Label,
) -> OtSenderResponse
pub fn ot_receiver_complete(
    response: &OtSenderResponse,
    k_r: Label,
    bit: u8,
) -> Label
```

Keep all arithmetic in `src/ot.rs`; use the `num-bigint` crate (add to
`Cargo.toml`) for modular exponentiation.

### New WASM bindings: `OtWire` in `src/lib.rs`

```rust
#[wasm_bindgen]
pub struct OtWire { /* opaque */ }

#[wasm_bindgen]
impl OtWire {
    /// Alice creates an OT session for one wire.
    /// m0 and m1 are the two wire labels as 16-byte Uint8Arrays.
    #[wasm_bindgen(constructor)]
    pub fn new(m0: &[u8], m1: &[u8]) -> OtWire;

    /// Alice's first message → send to Bob (JSON-serialised BigUint hex).
    pub fn sender_message(&self) -> String;

    /// Bob calls this with Alice's message and his selection bit.
    /// Returns Bob's reply message (JSON-serialised).
    pub fn receiver_reply(sender_msg: &str, bit: u8) -> String;

    /// Alice calls this with Bob's reply. Returns her response (two encrypted labels).
    pub fn sender_respond(&mut self, receiver_msg: &str) -> String;

    /// Bob calls this with Alice's response. Returns the selected label as hex.
    pub fn receiver_complete(receiver_state: &str, sender_response: &str) -> String;
}
```

The receiver's intermediate state (k_r, bit) must be serialised and passed back
from JS — this keeps the Rust side stateless per-message and mirrors the
asynchronous real-world exchange.

### Changes to `EvalSession` / `Evaluator`

Add a constructor variant (or a builder step) that accepts *only Alice's labels*
for the input wires already resolved, and leaves Bob's input wires empty. Bob's
labels are inserted after OT completes.

```rust
// New method on EvalSession
pub fn provide_bob_label(&mut self, wire_id: usize, label_hex: &str) -> Result<(), JsError>;
```

Add a method to export Alice's wire key pairs for Bob's wires (so JS can hand
them to `OtWire`):

```rust
pub fn bob_wire_key_pair(&self, wire_id: usize) -> Result<JsValue, JsError>;
// Returns { m0: hex, m1: hex }
```

---

## Frontend Changes

### Input-ownership UI (`www/index.html`, `www/style.css`)

After parsing the circuit, show each input wire with an ownership toggle:
`Alice ◉  Bob ○` (radio per wire). Default: first half → Alice, second half →
Bob (or let the user set it arbitrarily).

### Two-column protocol panel (`www/index.html`)

```
┌──────────────────────┬──────────────────────┐
│  ALICE               │  BOB                 │
│  Inputs: w0=1, w1=0  │  Inputs: w2=?, w3=?  │
│  [hidden from Bob]   │  [hidden from Alice] │
└──────────────────────┴──────────────────────┘
```

Bob's bit values are kept in a separate JS object; Alice's session never sees
them directly (enforced by the JS simulation, not real isolation).

### Protocol phase stepper (`www/main.js`)

Replace the current flat "garble → step" flow with a **phase-aware** sequence:

| Phase | Label                         | Action                                    |
|-------|-------------------------------|-------------------------------------------|
| 0     | Idle                          | Parse + assign ownership                 |
| 1     | Garble                        | Alice calls `new EvalSession(…, aliceBits)` |
| 2     | Send GC                       | Animate "packet" from Alice panel to Bob  |
| 3     | Send Alice's labels           | Animate per-wire label transfer           |
| 4 (n) | OT: wire Wₙ (rounds 1→2→3)   | Three-sub-step OT per Bob wire            |
| 5     | Evaluate                      | Existing gate-by-gate stepper             |
| 6     | Decode output                 | Highlight output wires, show decoded bits |

Use a `protocolPhase` state variable. "Next" button advances through phases;
within phase 4 each click advances one OT sub-step for the current wire.

### OT visualization

For each OT round (one per Bob input wire), show a small animated diagram:

```
Alice                       Bob
[m0=••••] [m1=••••]         [b=1]
     |── sender_msg ──►|
     |◄── receiver_msg ─|
     |── e0, e1 ────►|
                            → label = m1
```

Each message is displayed in a `<code>` block with the hex value. Colour-code:
Alice's private data in red (never shown on Bob's side); Bob's selected label
in green when revealed.

### Message log

Add a scrollable `<div id="protocol-log">` that records every simulated message
in order:

```
[Phase 1]  Alice garbled circuit (12 gates, 20 wires)
[Phase 2]  Alice → Bob: garbled circuit (480 bytes)
[Phase 3]  Alice → Bob: label for w0 = 3a9f…
[Phase 3]  Alice → Bob: label for w1 = c841…
[Phase 4]  OT w2 round 1 — Alice → Bob: A = 7f2a…
[Phase 4]  OT w2 round 2 — Bob → Alice: B = 2b9e…
[Phase 4]  OT w2 round 3 — Alice → Bob: e0=…, e1=…
[Phase 4]  OT w2 complete — Bob received label for w2
…
```

---

## Dependency Changes (`Cargo.toml`)

```toml
num-bigint = { version = "0.4", features = ["rand"] }
num-traits = "0.2"
sha2 = "0.10"
```

The `rand` and `aes` crates are already present.

---

## Testing

### Rust unit tests (`src/ot.rs`)

- `ot_round_trip_bit0`: OT with bit=0 returns m0.
- `ot_round_trip_bit1`: OT with bit=1 returns m1.
- `ot_sender_learns_nothing`: Verify that altering the receiver's bit after the
  fact changes the decrypted label (sanity check).

### Integration test

- Full half-adder run with Alice owning w0, Bob owning w1:
  - Garble → provide Alice label → OT for Bob's wire → evaluate → check output
    color bit matches expected truth.

---

## Out of Scope

- Real network transport (everything stays client-side/simulated)
- Extension to more than 1-of-2 OT
- OT extension (IKNP) for large circuits
- Authenticated / maliciously secure variants

---

## Acceptance Criteria

1. Parsing a Bristol circuit shows per-wire ownership toggles (Alice/Bob).
2. Clicking through the protocol phases advances through all 6 phases in order.
3. Each OT wire shows the three-message exchange with actual hex values derived
   from the real `OtWire` WASM calls.
4. After all OT rounds complete, the existing gate-by-gate evaluator runs
   correctly and produces the right output color bits.
5. The protocol log captures every phase/message in sequence.
6. All new Rust unit tests pass (`cargo test`).
