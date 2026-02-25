use aes::Aes128;
use aes::cipher::{BlockEncrypt, KeyInit};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::circuit::{Circuit, Gate, GateType};

/// A 128-bit wire label. The LSB of byte 0 is the color (point-and-permute) bit.
pub type Label = [u8; 16];

/// Two labels for a single wire: index 0 for bit-value 0, index 1 for bit-value 1.
#[derive(Clone, Serialize, Deserialize)]
pub struct WireKeys {
    pub labels: [Label; 2],
}

impl WireKeys {
    /// Color bit = LSB of label byte 0.
    pub fn color(label: &Label) -> u8 {
        label[0] & 1
    }
}

/// Garbled table for one gate.
/// Binary gates (AND/XOR/OR): 4 rows indexed by color(ka)*2 + color(kb).
/// Unary gates (INV/EQW): 2 rows indexed by color(ka).
#[derive(Clone, Serialize, Deserialize)]
pub struct GarbledGate {
    pub gate_id: usize,
    pub table: Vec<Label>,
}

/// Complete garbled circuit, ready for evaluation.
pub struct GarbledCircuit {
    pub wire_keys: Vec<WireKeys>,
    pub garbled_gates: Vec<GarbledGate>,
    pub circuit: Circuit,
}

/// Garble a parsed circuit. Generates fresh random keys for every wire.
pub fn garble(circuit: &Circuit) -> GarbledCircuit {
    let mut rng = OsRng;

    // Generate two labels per wire with opposite color bits.
    let wire_keys: Vec<WireKeys> = (0..circuit.num_wires)
        .map(|_| random_key_pair(&mut rng))
        .collect();

    let garbled_gates: Vec<GarbledGate> = circuit
        .gates
        .iter()
        .map(|gate| garble_gate(gate, &wire_keys))
        .collect();

    GarbledCircuit {
        wire_keys,
        garbled_gates,
        circuit: circuit.clone(),
    }
}

/// Generate a pair of labels with color(k0)=0, color(k1)=1.
fn random_key_pair(rng: &mut OsRng) -> WireKeys {
    let mut k0 = [0u8; 16];
    let mut k1 = [0u8; 16];
    rng.fill_bytes(&mut k0);
    rng.fill_bytes(&mut k1);
    k0[0] &= 0xFE; // clear LSB → color 0
    k1[0] |= 0x01; // set  LSB → color 1
    WireKeys { labels: [k0, k1] }
}

/// Garble a single gate into its encrypted table.
fn garble_gate(gate: &Gate, wire_keys: &[WireKeys]) -> GarbledGate {
    match gate.gate_type {
        GateType::Inv | GateType::Eqw => garble_unary(gate, wire_keys),
        _ => garble_binary(gate, wire_keys),
    }
}

fn garble_binary(gate: &Gate, wire_keys: &[WireKeys]) -> GarbledGate {
    let wk_a = &wire_keys[gate.input_wires[0]];
    let wk_b = &wire_keys[gate.input_wires[1]];
    let wk_c = &wire_keys[gate.output_wire];

    let mut table = vec![[0u8; 16]; 4];

    for a_bit in 0usize..2 {
        for b_bit in 0usize..2 {
            let ka = &wk_a.labels[a_bit];
            let kb = &wk_b.labels[b_bit];
            let row = (WireKeys::color(ka) * 2 + WireKeys::color(kb)) as usize;
            let v_bool = gate.gate_type.eval(a_bit != 0, b_bit != 0);
            let v = v_bool as usize;
            let kc = &wk_c.labels[v];

            let h_a = aes_hash(ka, gate.id, row as u8, false);
            let h_b = aes_hash(kb, gate.id, row as u8, true);

            for i in 0..16 {
                table[row][i] = h_a[i] ^ h_b[i] ^ kc[i];
            }
        }
    }

    GarbledGate {
        gate_id: gate.id,
        table,
    }
}

fn garble_unary(gate: &Gate, wire_keys: &[WireKeys]) -> GarbledGate {
    let wk_a = &wire_keys[gate.input_wires[0]];
    let wk_c = &wire_keys[gate.output_wire];

    let mut table = vec![[0u8; 16]; 2];

    for a_bit in 0usize..2 {
        let ka = &wk_a.labels[a_bit];
        let row = WireKeys::color(ka) as usize;
        let v_bool = gate.gate_type.eval(a_bit != 0, false);
        let v = v_bool as usize;
        let kc = &wk_c.labels[v];

        let h_a = aes_hash(ka, gate.id, row as u8, false);

        for i in 0..16 {
            table[row][i] = h_a[i] ^ kc[i];
        }
    }

    GarbledGate {
        gate_id: gate.id,
        table,
    }
}

/// AES-Davies-Meyer PRF:  H(key, gate_id, row, is_b_input) → 16 bytes.
///
/// Tweak plaintext layout:
///   bytes 0–7  : gate_id as u64 big-endian
///   byte  8    : row (0–3)
///   byte  9    : 1 if this is the B-input hash, 0 for A-input
///   bytes 10–15: zero
///
/// Encrypt the tweak block under `key`, then XOR the plaintext back
/// (Davies-Meyer compression) to prevent length-extension attacks.
pub fn aes_hash(key: &Label, gate_id: usize, row: u8, is_b: bool) -> Label {
    use aes::cipher::generic_array::GenericArray;

    let cipher = Aes128::new(GenericArray::from_slice(key));

    let mut block = [0u8; 16];
    block[..8].copy_from_slice(&(gate_id as u64).to_be_bytes());
    block[8] = row;
    block[9] = is_b as u8;

    let mut ga = GenericArray::from(block);
    cipher.encrypt_block(&mut ga);

    let enc: Label = ga.into();
    std::array::from_fn(|i| enc[i] ^ block[i])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::circuit::parse_bristol;

    const HALF_ADDER: &str = "\
2 4
2 1 1
2 1 1
2 1 0 1 2 XOR
2 1 0 1 3 AND
";

    #[test]
    fn garble_produces_tables() {
        let circuit = parse_bristol(HALF_ADDER).unwrap();
        let gc = garble(&circuit);
        assert_eq!(gc.garbled_gates.len(), 2);
        // Binary gates have 4 rows
        assert_eq!(gc.garbled_gates[0].table.len(), 4);
        assert_eq!(gc.garbled_gates[1].table.len(), 4);
    }

    #[test]
    fn color_bits_are_opposite() {
        let mut rng = OsRng;
        let wk = random_key_pair(&mut rng);
        assert_eq!(WireKeys::color(&wk.labels[0]), 0);
        assert_eq!(WireKeys::color(&wk.labels[1]), 1);
    }
}
