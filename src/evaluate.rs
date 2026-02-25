use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::garble::{aes_hash, GarbledCircuit, Label, WireKeys};

/// The evaluator's view of a single resolved wire at a given step.
#[derive(Clone, Serialize, Deserialize)]
pub struct WireState {
    pub wire_id: usize,
    pub label: Label,
    /// Full 32-char hex string of the 16-byte label.
    pub label_hex: String,
    /// The color (point-and-permute) bit: 0 or 1.
    pub color_bit: u8,
}

/// A delta snapshot: what changed at this evaluation step.
#[derive(Clone, Serialize, Deserialize)]
pub struct StepSnapshot {
    /// 0 = initial (inputs only); k = after evaluating gate k-1.
    pub step_index: usize,
    /// The gate that was evaluated to produce this snapshot (None for step 0).
    pub active_gate_id: Option<usize>,
    /// The single wire that became known at this step (None only if gate output
    /// wire was already known, which should not happen in a valid circuit).
    pub new_wire: Option<WireState>,
}

pub struct Evaluator {
    pub garbled: GarbledCircuit,
    /// history[0]  = initial inputs snapshot
    /// history[k]  = snapshot after evaluating gate k-1
    history: Vec<StepSnapshot>,
    /// Incrementally maintained: the full set of known labels at current_step.
    current_known: HashMap<usize, Label>,
    pub current_step: usize,
}

impl Evaluator {
    /// Create a new evaluator session.
    ///
    /// `input_bits[i]` must be 0 or 1 and selects the label for input wire i.
    /// There must be exactly `circuit.input_wires.len()` entries.
    pub fn new(garbled: GarbledCircuit, input_bits: &[u8]) -> Self {
        let mut current_known: HashMap<usize, Label> = HashMap::new();
        let mut initial_wire_states: Vec<WireState> = Vec::new();

        for (idx, &wire_id) in garbled.circuit.input_wires.iter().enumerate() {
            let bit = if idx < input_bits.len() { input_bits[idx] as usize & 1 } else { 0 };
            let label = garbled.wire_keys[wire_id].labels[bit];
            current_known.insert(wire_id, label);
            initial_wire_states.push(wire_state(wire_id, label));
        }

        // Step 0: encode all inputs as individual "new_wire" entries.
        // We store one snapshot per input wire so step-back can undo each.
        // For simplicity, pack them all into step 0 by building a single
        // snapshot that carries the first input wire, then include all others
        // via a side-channel Vec.  Instead, we store a single step-0 snapshot
        // and use `all_inputs` below for reconstruction.
        //
        // Simpler approach: step 0 snapshot has no new_wire; we initialise
        // current_known directly and remember the initial set separately.
        let initial_snapshot = StepSnapshot {
            step_index: 0,
            active_gate_id: None,
            new_wire: None,
        };

        Evaluator {
            garbled,
            history: vec![initial_snapshot],
            current_known,
            current_step: 0,
        }
    }

    pub fn current_step(&self) -> usize {
        self.current_step
    }

    pub fn total_gates(&self) -> usize {
        self.garbled.circuit.gates.len()
    }

    pub fn is_complete(&self) -> bool {
        self.current_step >= self.total_gates()
    }

    /// Advance one gate forward.  Returns a reference to the new snapshot.
    /// No-op (returns current snapshot) if already complete.
    pub fn step_forward(&mut self) -> &StepSnapshot {
        if self.is_complete() {
            return self.history.last().unwrap();
        }

        let gate_idx = self.current_step;
        let gate = &self.garbled.circuit.gates[gate_idx];
        let gg = &self.garbled.garbled_gates[gate_idx];

        let result = evaluate_gate_with_known(gate, gg, &self.current_known);

        let new_wire = result.map(|(wire_id, label)| {
            self.current_known.insert(wire_id, label);
            wire_state(wire_id, label)
        });

        self.current_step += 1;

        let snap = StepSnapshot {
            step_index: self.current_step,
            active_gate_id: Some(gate.id),
            new_wire,
        };
        self.history.push(snap);
        self.history.last().unwrap()
    }

    /// Step back one gate.  Returns the now-current snapshot.
    /// No-op at step 0.
    pub fn step_back(&mut self) -> &StepSnapshot {
        if self.current_step == 0 {
            return &self.history[0];
        }

        // Remove the wire that was added at this step from current_known.
        if let Some(ws) = &self.history[self.current_step].new_wire {
            self.current_known.remove(&ws.wire_id);
        }
        self.history.pop();
        self.current_step -= 1;
        &self.history[self.current_step]
    }

    /// Return all known labels at the current step.
    /// This is just a clone of `current_known` plus the initial inputs.
    /// Insert or overwrite a label in `current_known`.
    /// Used by the two-party flow to seed Bob's wire labels after OT completes.
    pub fn insert_input_label(&mut self, wire_id: usize, label: Label) {
        self.current_known.insert(wire_id, label);
    }

    pub fn all_known_labels(&self) -> HashMap<usize, WireState> {
        // Include input wires (stored in wire_keys, resolved at init)
        let mut map: HashMap<usize, WireState> = self
            .current_known
            .iter()
            .map(|(&wire_id, &label)| (wire_id, wire_state(wire_id, label)))
            .collect();
        // Make sure input wires are present even if current_known was built
        // from them directly (they are, since we insert them in ::new).
        for &wire_id in &self.garbled.circuit.input_wires {
            if let Some(&label) = self.current_known.get(&wire_id) {
                map.insert(wire_id, wire_state(wire_id, label));
            }
        }
        map
    }

}

/// Evaluate one gate given the currently-known wire labels.
/// Returns (output_wire_id, output_label) on success, or None if an input
/// wire label is not yet known (which should not happen in a valid circuit).
fn evaluate_gate_with_known(
    gate: &crate::circuit::Gate,
    gg: &crate::garble::GarbledGate,
    known: &HashMap<usize, Label>,
) -> Option<(usize, Label)> {
    use crate::circuit::GateType;

    let ka = known.get(&gate.input_wires[0])?;

    let (row, h_a, h_b) = match gate.gate_type {
        GateType::Inv | GateType::Eqw => {
            let row = WireKeys::color(ka) as usize;
            let h_a = aes_hash(ka, gate.id, row as u8, false);
            (row, h_a, [0u8; 16])
        }
        _ => {
            let kb = known.get(&gate.input_wires[1])?;
            let row = (WireKeys::color(ka) * 2 + WireKeys::color(kb)) as usize;
            let h_a = aes_hash(ka, gate.id, row as u8, false);
            let h_b = aes_hash(kb, gate.id, row as u8, true);
            (row, h_a, h_b)
        }
    };

    let ct = gg.table[row];
    let kc: Label = std::array::from_fn(|i| h_a[i] ^ h_b[i] ^ ct[i]);
    Some((gate.output_wire, kc))
}

fn wire_state(wire_id: usize, label: Label) -> WireState {
    WireState {
        wire_id,
        label,
        label_hex: hex_encode(&label),
        color_bit: WireKeys::color(&label),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::circuit::parse_bristol;
    use crate::garble::garble;

    const HALF_ADDER: &str = "\
2 4
2 1 1
2 1 1
2 1 0 1 2 XOR
2 1 0 1 3 AND
";

    fn make_session(input_bits: &[u8]) -> Evaluator {
        let circuit = parse_bristol(HALF_ADDER).unwrap();
        let gc = garble(&circuit);
        Evaluator::new(gc, input_bits)
    }

    #[test]
    fn step_through_completes() {
        let mut ev = make_session(&[1, 0]);
        assert_eq!(ev.current_step(), 0);
        ev.step_forward();
        assert_eq!(ev.current_step(), 1);
        ev.step_forward();
        assert_eq!(ev.current_step(), 2);
        assert!(ev.is_complete());
    }

    #[test]
    fn step_back_works() {
        let mut ev = make_session(&[1, 1]);
        ev.step_forward();
        ev.step_forward();
        assert_eq!(ev.current_step(), 2);
        ev.step_back();
        assert_eq!(ev.current_step(), 1);
        ev.step_back();
        assert_eq!(ev.current_step(), 0);
        // Step back at 0 is a no-op
        ev.step_back();
        assert_eq!(ev.current_step(), 0);
    }

    #[test]
    fn output_color_bits_match_expected_values() {
        // For a half-adder with inputs a=1, b=0:
        //   XOR output = 1, AND output = 0
        let circuit = parse_bristol(HALF_ADDER).unwrap();
        let gc = garble(&circuit);

        // Retrieve expected color bits from the known truth labels
        let xor_output_wire = circuit.gates[0].output_wire; // wire 2
        let and_output_wire = circuit.gates[1].output_wire; // wire 3
        let expected_xor_bit = 1usize; // 1 XOR 0 = 1
        let expected_and_bit = 0usize; // 1 AND 0 = 0

        let expected_xor_color = WireKeys::color(&gc.wire_keys[xor_output_wire].labels[expected_xor_bit]);
        let expected_and_color = WireKeys::color(&gc.wire_keys[and_output_wire].labels[expected_and_bit]);

        let mut ev = Evaluator::new(gc, &[1, 0]);
        ev.step_forward();
        ev.step_forward();

        let labels = ev.all_known_labels();

        // The evaluator should have decoded output wire labels whose color bits
        // match the garbler's labels for the correct output values.
        assert_eq!(labels[&xor_output_wire].color_bit, expected_xor_color);
        assert_eq!(labels[&and_output_wire].color_bit, expected_and_color);
    }
}
