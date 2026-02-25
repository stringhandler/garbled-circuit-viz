/// Simplest 1-of-2 Oblivious Transfer — Chou & Orlandi 2015
///
/// Protocol (semi-honest security under CDH in Ristretto255):
///
///   Alice (sender)  has: m0, m1  (two 128-bit wire labels)
///   Bob  (receiver) has: bit b   (0 or 1)
///
///   Round 1  Alice → Bob :  A = a·G   (sender public key)
///   Round 2  Bob   → Alice:  B = r·G   if b = 0
///                             B = r·G + A  if b = 1
///            Bob stores k_r = H(r·A, b)
///   Round 3  Alice → Bob :  e0 = H(a·B, 0) XOR m0
///                            e1 = H(a·(B−A), 1) XOR m1
///   Bob decrypts: m_b = e_b XOR k_r
///
/// H(point, tweak) folds the 32-byte compressed Ristretto point through two
/// calls of the existing AES-Davies-Meyer PRF already used for garbling.

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::scalar::Scalar;
use rand::RngCore;
use rand::rngs::OsRng;

use crate::garble::{aes_hash, Label};

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Fold a 32-byte Ristretto point down to a 16-byte label using the existing AES PRF.
/// H(point, tweak) = aes_hash(bytes[0..16], tweak, 0, false)
///                 XOR aes_hash(bytes[16..32], tweak, 1, false)
fn hash_point(point: &RistrettoPoint, tweak: u8) -> Label {
    let bytes = point.compress().to_bytes();
    let k0: Label = bytes[..16].try_into().unwrap();
    let k1: Label = bytes[16..].try_into().unwrap();
    let h0 = aes_hash(&k0, tweak as usize, 0, false);
    let h1 = aes_hash(&k1, tweak as usize, 1, false);
    std::array::from_fn(|i| h0[i] ^ h1[i])
}

/// Decode a 32-char hex string into a 16-byte Label.
pub fn label_from_hex(hex: &str) -> Option<Label> {
    if hex.len() != 32 { return None; }
    let mut out = [0u8; 16];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = char::from(chunk[0]).to_digit(16)?;
        let lo = char::from(chunk[1]).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

/// Encode a Label as a 32-char lowercase hex string.
pub fn label_to_hex(label: &Label) -> String {
    label.iter().map(|b| format!("{:02x}", b)).collect()
}

// ── Public protocol types ─────────────────────────────────────────────────────

/// Alice's sender state — kept private between Round 1 and Round 3.
pub struct OtSenderState {
    /// The 64-byte wide scalar bytes used to derive secret scalar `a`.
    secret_wide: [u8; 64],
    /// Alice's public key A = a·G (32 bytes, compressed Ristretto point).
    pub sender_pk: [u8; 32],
    /// The two plaintext labels Alice is sending.
    m0: Label,
    m1: Label,
}

/// Bob's receiver state — kept private between Round 2 and decryption.
pub struct OtReceiverState {
    /// Bob's public value B (32 bytes, compressed Ristretto point).
    pub receiver_pk: [u8; 32],
    /// Bob's pre-computed decryption key k_r = H(r·A, b).
    pub k_r: Label,
    /// Bob's selection bit.
    pub bit: u8,
}

/// Alice's Round-3 response — the two encrypted labels.
pub struct OtSenderResponse {
    pub e0: Label,
    pub e1: Label,
}

// ── Protocol functions ────────────────────────────────────────────────────────

/// Round 1 (Alice): Generate sender keypair and record m0, m1.
#[allow(non_snake_case)]
/// Returns `OtSenderState`; call `.sender_pk` to get the 32-byte value to send Bob.
pub fn ot_sender_setup(m0: Label, m1: Label) -> OtSenderState {
    let mut wide = [0u8; 64];
    OsRng.fill_bytes(&mut wide);
    let a = Scalar::from_bytes_mod_order_wide(&wide);
    let sender_pk = (a * RISTRETTO_BASEPOINT_POINT).compress().to_bytes();
    OtSenderState { secret_wide: wide, sender_pk, m0, m1 }
}

/// Round 2 (Bob): Given Alice's public key and Bob's selection bit,
#[allow(non_snake_case)]
/// compute Bob's reply `B` and pre-compute his decryption key.
/// Returns `None` if `sender_pk` is not a valid Ristretto point.
pub fn ot_receiver_setup(sender_pk: &[u8; 32], bit: u8) -> Option<OtReceiverState> {
    let A = CompressedRistretto::from_slice(sender_pk).ok()?.decompress()?;

    let mut wide = [0u8; 64];
    OsRng.fill_bytes(&mut wide);
    let r = Scalar::from_bytes_mod_order_wide(&wide);

    let G = RISTRETTO_BASEPOINT_POINT;
    let B = if bit == 0 { r * G } else { r * G + A };

    // Pre-compute decryption key: k_r = H(r·A, bit)
    let k_r = hash_point(&(r * A), bit);

    Some(OtReceiverState {
        receiver_pk: B.compress().to_bytes(),
        k_r,
        bit,
    })
}

/// Round 3 (Alice): Given Bob's reply B, encrypt both labels.
#[allow(non_snake_case)]
/// Returns `None` if `receiver_pk` is not a valid Ristretto point.
pub fn ot_sender_respond(
    state: &OtSenderState,
    recv_pk: &[u8; 32],
) -> Option<OtSenderResponse> {
    // Re-derive Alice's scalar from the stored wide bytes.
    let a = Scalar::from_bytes_mod_order_wide(&state.secret_wide);
    let A = CompressedRistretto::from_slice(&state.sender_pk).ok()?.decompress()?;
    let B = CompressedRistretto::from_slice(recv_pk).ok()?.decompress()?;

    // k0 = H(a·B, 0)  — matches k_r when b = 0 (since a·B = a·r·G)
    let k0 = hash_point(&(a * B), 0);
    // k1 = H(a·(B−A), 1) — matches k_r when b = 1 (since B−A = r·G, a·(B−A) = a·r·G)
    let k1 = hash_point(&(a * (B - A)), 1);

    let e0: Label = std::array::from_fn(|i| k0[i] ^ state.m0[i]);
    let e1: Label = std::array::from_fn(|i| k1[i] ^ state.m1[i]);
    Some(OtSenderResponse { e0, e1 })
}

/// Bob decrypts his selected label using his pre-computed key.
pub fn ot_receiver_complete(resp: &OtSenderResponse, state: &OtReceiverState) -> Label {
    let e = if state.bit == 0 { &resp.e0 } else { &resp.e1 };
    std::array::from_fn(|i| e[i] ^ state.k_r[i])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn random_label() -> Label {
        let mut l = [0u8; 16];
        OsRng.fill_bytes(&mut l);
        l
    }

    #[test]
    fn ot_bit0_gives_m0() {
        let m0 = random_label();
        let m1 = random_label();

        let sender = ot_sender_setup(m0, m1);
        let receiver = ot_receiver_setup(&sender.sender_pk, 0).expect("valid pk");
        let response = ot_sender_respond(&sender, &receiver.receiver_pk).expect("valid pk");
        let got = ot_receiver_complete(&response, &receiver);

        assert_eq!(got, m0, "bit=0 should give m0");
    }

    #[test]
    fn ot_bit1_gives_m1() {
        let m0 = random_label();
        let m1 = random_label();

        let sender = ot_sender_setup(m0, m1);
        let receiver = ot_receiver_setup(&sender.sender_pk, 1).expect("valid pk");
        let response = ot_sender_respond(&sender, &receiver.receiver_pk).expect("valid pk");
        let got = ot_receiver_complete(&response, &receiver);

        assert_eq!(got, m1, "bit=1 should give m1");
    }

    #[test]
    fn wrong_bit_gives_garbage() {
        // Simulate a cheating receiver who tries to decrypt the "other" label
        // by flipping the bit after receiving the response.  The decrypted
        // value should not equal the plaintext label.
        let m0 = random_label();
        let m1 = random_label();

        let sender = ot_sender_setup(m0, m1);
        // Bob claims bit=0 but actually wants m1.
        let receiver = ot_receiver_setup(&sender.sender_pk, 0).expect("valid pk");
        let response = ot_sender_respond(&sender, &receiver.receiver_pk).expect("valid pk");

        // Attempt to decrypt e1 using k_r computed for b=0.
        let fake_state = OtReceiverState { bit: 1, ..receiver };
        let got = ot_receiver_complete(&response, &fake_state);

        assert_ne!(got, m1, "cheating receiver should not recover m1");
    }
}
