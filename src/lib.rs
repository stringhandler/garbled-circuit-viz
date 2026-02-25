mod circuit;
mod evaluate;
mod garble;
mod ot;

use evaluate::Evaluator;
use wasm_bindgen::prelude::*;

// ── Panic hook ────────────────────────────────────────────────────────────────

#[wasm_bindgen(start)]
pub fn main() {
    console_error_panic_hook::set_once();
}

// ── parse_circuit ─────────────────────────────────────────────────────────────

/// Parse a Bristol Fashion circuit string.
/// Returns a plain JS object (via serde-wasm-bindgen) describing the circuit,
/// suitable for Dagre layout and for passing to EvalSession.
#[wasm_bindgen]
pub fn parse_circuit(bristol: &str) -> Result<JsValue, JsError> {
    let circuit = circuit::parse_bristol(bristol).map_err(|e| JsError::new(&e))?;
    serde_wasm_bindgen::to_value(&circuit).map_err(|e| JsError::new(&e.to_string()))
}

// ── EvalSession ───────────────────────────────────────────────────────────────

/// Holds a garbled circuit and evaluation state for one session.
/// The circuit is garbled with fresh random keys on construction.
#[wasm_bindgen]
pub struct EvalSession {
    evaluator: Evaluator,
}

#[wasm_bindgen]
impl EvalSession {
    /// Create and garble a new session.
    ///
    /// - `circuit_json`: `JSON.stringify()` of the object returned by `parse_circuit()`.
    /// - `input_bits`: one byte per input wire (0 or 1), length must match
    ///   `sum(circuit.input_wire_counts)`.
    #[wasm_bindgen(constructor)]
    pub fn new(circuit_json: &str, input_bits: &[u8]) -> Result<EvalSession, JsError> {
        let circuit: circuit::Circuit =
            serde_json::from_str(circuit_json).map_err(|e| JsError::new(&e.to_string()))?;
        let gc = garble::garble(&circuit);
        let evaluator = Evaluator::new(gc, input_bits);
        Ok(EvalSession { evaluator })
    }

    /// Evaluate one gate and return its StepSnapshot as a JS object.
    /// No-op (returns current snapshot) if evaluation is already complete.
    pub fn step_forward(&mut self) -> Result<JsValue, JsError> {
        let snap = self.evaluator.step_forward();
        serde_wasm_bindgen::to_value(snap).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Undo the last step and return the now-current StepSnapshot as a JS object.
    /// No-op (returns step-0 snapshot) if already at the beginning.
    pub fn step_back(&mut self) -> Result<JsValue, JsError> {
        let snap = self.evaluator.step_back();
        serde_wasm_bindgen::to_value(snap).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Current step index (0 = inputs only, N = after gate N-1).
    pub fn current_step(&self) -> usize {
        self.evaluator.current_step()
    }

    /// Total number of gates in the circuit.
    pub fn total_gates(&self) -> usize {
        self.evaluator.total_gates()
    }

    /// True when all gates have been evaluated.
    pub fn is_complete(&self) -> bool {
        self.evaluator.is_complete()
    }

    /// Return all currently-known wire labels as a JS object
    /// mapping wire_id (string key) → WireState.
    pub fn wire_labels(&self) -> Result<JsValue, JsError> {
        let labels = self.evaluator.all_known_labels();
        serde_wasm_bindgen::to_value(&labels).map_err(|e| JsError::new(&e.to_string()))
    }

    /// Return the garbled table for a gate as a JS array of 16-byte hex strings.
    pub fn garbled_table(&self, gate_id: usize) -> Result<JsValue, JsError> {
        if gate_id >= self.evaluator.garbled.garbled_gates.len() {
            return Err(JsError::new("gate_id out of range"));
        }
        let gate = &self.evaluator.garbled.garbled_gates[gate_id];
        let hex_rows: Vec<String> = gate
            .table
            .iter()
            .map(|row| row.iter().map(|b| format!("{:02x}", b)).collect())
            .collect();
        serde_wasm_bindgen::to_value(&hex_rows).map_err(|e| JsError::new(&e.to_string()))
    }

    // ── Two-party helpers ─────────────────────────────────────────────────────

    /// Return the two wire labels Alice holds for one of Bob's input wires.
    /// JS receives `{ m0: "<32-char hex>", m1: "<32-char hex>" }`.
    /// Used to initialise `OtSession` on Alice's side.
    pub fn bob_wire_key_pair(&self, wire_id: usize) -> Result<JsValue, JsError> {
        let wk = self.evaluator.garbled.wire_keys
            .get(wire_id)
            .ok_or_else(|| JsError::new("wire_id out of range"))?;
        let m0 = ot::label_to_hex(&wk.labels[0]);
        let m1 = ot::label_to_hex(&wk.labels[1]);
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"m0".into(), &m0.into())
            .map_err(|_| JsError::new("reflect set m0"))?;
        js_sys::Reflect::set(&obj, &"m1".into(), &m1.into())
            .map_err(|_| JsError::new("reflect set m1"))?;
        Ok(obj.into())
    }

    /// Overwrite the label for one of Bob's input wires after OT completes.
    /// `label_hex` must be a 32-char lowercase hex string (16 bytes).
    pub fn provide_bob_label(&mut self, wire_id: usize, label_hex: &str) -> Result<(), JsError> {
        let label = ot::label_from_hex(label_hex)
            .ok_or_else(|| JsError::new("invalid label hex (expected 32 chars)"))?;
        self.evaluator.insert_input_label(wire_id, label);
        Ok(())
    }
}

// ── OtSession ─────────────────────────────────────────────────────────────────

/// WASM handle for one round of 1-of-2 Oblivious Transfer (Alice's sender side).
///
/// Typical JS usage for a single wire:
/// ```js
/// // Alice sets up (she holds m0, m1 from bob_wire_key_pair)
/// const ot = new OtSession(m0_hex, m1_hex);
///
/// // Round 1: Alice → Bob
/// const senderMsg = ot.sender_message();          // hex string
///
/// // Round 2: Bob → Alice  (called statically on Bob's side)
/// const bobState = OtSession.receiver_reply(senderMsg, bobBit);  // {receiver_pk, k_r}
///
/// // Round 3: Alice → Bob
/// const aliceResp = ot.sender_respond(bobState.receiver_pk);     // {e0, e1}
///
/// // Bob decrypts
/// const label = OtSession.receiver_complete(bobState.k_r, aliceResp.e0, aliceResp.e1, bobBit);
/// ```
#[wasm_bindgen]
pub struct OtSession {
    state: ot::OtSenderState,
}

#[wasm_bindgen]
impl OtSession {
    /// Construct a new OT sender session for Alice.
    /// `m0_hex` and `m1_hex` are 32-char hex strings (16-byte wire labels).
    #[wasm_bindgen(constructor)]
    pub fn new(m0_hex: &str, m1_hex: &str) -> Result<OtSession, JsError> {
        let m0 = ot::label_from_hex(m0_hex)
            .ok_or_else(|| JsError::new("invalid m0 hex"))?;
        let m1 = ot::label_from_hex(m1_hex)
            .ok_or_else(|| JsError::new("invalid m1 hex"))?;
        Ok(OtSession { state: ot::ot_sender_setup(m0, m1) })
    }

    /// Round 1 — Alice's public key A = a·G, encoded as a 64-char hex string.
    pub fn sender_message(&self) -> String {
        self.state.sender_pk.iter().map(|b| format!("{:02x}", b)).collect()
    }

    /// Round 2 — Bob's side (static).
    /// `sender_pk_hex`: 64-char hex from `sender_message()`.
    /// `bit`: Bob's selection bit (0 or 1).
    /// Returns a JS object `{ receiver_pk: "<64-char hex>", k_r: "<32-char hex>" }`.
    /// Bob must keep this object private; it must be passed to `receiver_complete` later.
    pub fn receiver_reply(sender_pk_hex: &str, bit: u8) -> Result<JsValue, JsError> {
        let bytes = hex_to_32(sender_pk_hex)
            .ok_or_else(|| JsError::new("invalid sender_pk hex (expected 64 chars)"))?;
        let recv_state = ot::ot_receiver_setup(&bytes, bit)
            .ok_or_else(|| JsError::new("sender_pk is not a valid Ristretto point"))?;

        let recv_pk_hex: String = recv_state.receiver_pk.iter()
            .map(|b| format!("{:02x}", b)).collect();
        let k_r_hex = ot::label_to_hex(&recv_state.k_r);

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"receiver_pk".into(), &recv_pk_hex.into())
            .map_err(|_| JsError::new("reflect set receiver_pk"))?;
        js_sys::Reflect::set(&obj, &"k_r".into(), &k_r_hex.into())
            .map_err(|_| JsError::new("reflect set k_r"))?;
        Ok(obj.into())
    }

    /// Round 3 — Alice's response.
    /// `receiver_pk_hex`: 64-char hex of Bob's `receiver_pk` from `receiver_reply`.
    /// Returns a JS object `{ e0: "<32-char hex>", e1: "<32-char hex>" }`.
    pub fn sender_respond(&self, receiver_pk_hex: &str) -> Result<JsValue, JsError> {
        let bytes = hex_to_32(receiver_pk_hex)
            .ok_or_else(|| JsError::new("invalid receiver_pk hex (expected 64 chars)"))?;
        let resp = ot::ot_sender_respond(&self.state, &bytes)
            .ok_or_else(|| JsError::new("receiver_pk is not a valid Ristretto point"))?;

        let e0_hex = ot::label_to_hex(&resp.e0);
        let e1_hex = ot::label_to_hex(&resp.e1);

        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &"e0".into(), &e0_hex.into())
            .map_err(|_| JsError::new("reflect set e0"))?;
        js_sys::Reflect::set(&obj, &"e1".into(), &e1_hex.into())
            .map_err(|_| JsError::new("reflect set e1"))?;
        Ok(obj.into())
    }

    /// Bob decrypts his selected label (static).
    /// Returns the selected wire label as a 32-char hex string.
    pub fn receiver_complete(k_r_hex: &str, e0_hex: &str, e1_hex: &str, bit: u8) -> Result<String, JsError> {
        let k_r = ot::label_from_hex(k_r_hex)
            .ok_or_else(|| JsError::new("invalid k_r hex"))?;
        let e0 = ot::label_from_hex(e0_hex)
            .ok_or_else(|| JsError::new("invalid e0 hex"))?;
        let e1 = ot::label_from_hex(e1_hex)
            .ok_or_else(|| JsError::new("invalid e1 hex"))?;

        let state = ot::OtReceiverState { receiver_pk: [0u8; 32], k_r, bit };
        let resp  = ot::OtSenderResponse { e0, e1 };
        Ok(ot::label_to_hex(&ot::ot_receiver_complete(&resp, &state)))
    }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Decode a 64-char hex string to exactly 32 bytes.
fn hex_to_32(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 { return None; }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = char::from(chunk[0]).to_digit(16)?;
        let lo = char::from(chunk[1]).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}
