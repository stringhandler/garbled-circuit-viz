use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GateType {
    And,
    Xor,
    Inv,
    Or,
    Eqw,
}

impl GateType {
    /// Evaluate the gate's boolean function.
    pub fn eval(&self, a: bool, b: bool) -> bool {
        match self {
            GateType::And => a & b,
            GateType::Xor => a ^ b,
            GateType::Or  => a | b,
            GateType::Inv => !a,
            GateType::Eqw => a,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gate {
    pub id: usize,
    pub gate_type: GateType,
    /// 1 element for Inv/Eqw, 2 for And/Xor/Or
    pub input_wires: Vec<usize>,
    pub output_wire: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Circuit {
    pub num_gates: usize,
    pub num_wires: usize,
    pub input_wire_counts: Vec<usize>,
    pub output_wire_counts: Vec<usize>,
    /// Gates already in topological order (guaranteed by Bristol spec)
    pub gates: Vec<Gate>,
    /// Flat list of input wire indices (first sum(input_wire_counts) wires)
    pub input_wires: Vec<usize>,
    /// Flat list of output wire indices (last sum(output_wire_counts) wires)
    pub output_wires: Vec<usize>,
}

/// Parse a Bristol Fashion circuit string into a Circuit.
pub fn parse_bristol(src: &str) -> Result<Circuit, String> {
    let mut lines = src
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'));

    // Line 1: num_gates num_wires
    let line1 = lines.next().ok_or("Missing header line")?;
    let (num_gates, num_wires) = parse_pair(line1)?;

    // Line 2: niv count_0 [count_1 ...]
    let line2 = lines.next().ok_or("Missing input count line")?;
    let input_wire_counts = parse_count_line(line2)?;

    // Line 3: nov count_0 [count_1 ...]
    let line3 = lines.next().ok_or("Missing output count line")?;
    let output_wire_counts = parse_count_line(line3)?;

    // Derive input wire indices: wires 0 .. sum(input_wire_counts)
    let total_inputs: usize = input_wire_counts.iter().sum();
    let input_wires: Vec<usize> = (0..total_inputs).collect();

    // Derive output wire indices: last sum(output_wire_counts) wires
    let total_outputs: usize = output_wire_counts.iter().sum();
    let output_wires: Vec<usize> = (num_wires - total_outputs..num_wires).collect();

    // Gate lines
    let mut gates = Vec::with_capacity(num_gates);
    for (id, line) in lines.enumerate() {
        gates.push(parse_gate_line(line, id)?);
    }

    if gates.len() != num_gates {
        return Err(format!(
            "Expected {} gates, found {}",
            num_gates,
            gates.len()
        ));
    }

    Ok(Circuit {
        num_gates,
        num_wires,
        input_wire_counts,
        output_wire_counts,
        gates,
        input_wires,
        output_wires,
    })
}

fn parse_pair(line: &str) -> Result<(usize, usize), String> {
    let mut parts = line.split_whitespace();
    let a = parts
        .next()
        .ok_or("Missing first value")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    let b = parts
        .next()
        .ok_or("Missing second value")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    Ok((a, b))
}

/// Parse `n v0 v1 ... v_{n-1}` → vec of counts
fn parse_count_line(line: &str) -> Result<Vec<usize>, String> {
    let mut parts = line.split_whitespace();
    let n = parts
        .next()
        .ok_or("Missing count")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    let mut counts = Vec::with_capacity(n);
    for _ in 0..n {
        let v = parts
            .next()
            .ok_or("Not enough values in count line")?
            .parse::<usize>()
            .map_err(|e| e.to_string())?;
        counts.push(v);
    }
    Ok(counts)
}

/// Parse a gate line: `nin nout w_in0 [w_in1] w_out GATE_TYPE`
fn parse_gate_line(line: &str, id: usize) -> Result<Gate, String> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 4 {
        return Err(format!("Gate line too short: {}", line));
    }

    let nin = parts[0].parse::<usize>().map_err(|e| e.to_string())?;
    let _nout = parts[1].parse::<usize>().map_err(|e| e.to_string())?;

    // After nin and nout, we have `nin` input wire indices, then 1 output wire, then gate type
    let expected_len = 2 + nin + 1 + 1;
    if parts.len() < expected_len {
        return Err(format!(
            "Gate line has {} tokens, expected at least {}: {}",
            parts.len(),
            expected_len,
            line
        ));
    }

    let mut input_wires = Vec::with_capacity(nin);
    for i in 0..nin {
        let w = parts[2 + i].parse::<usize>().map_err(|e| e.to_string())?;
        input_wires.push(w);
    }
    let output_wire = parts[2 + nin].parse::<usize>().map_err(|e| e.to_string())?;
    let gate_type_str = parts[2 + nin + 1];
    let gate_type = parse_gate_type(gate_type_str)?;

    Ok(Gate {
        id,
        gate_type,
        input_wires,
        output_wire,
    })
}

fn parse_gate_type(s: &str) -> Result<GateType, String> {
    match s.to_uppercase().as_str() {
        "AND"  => Ok(GateType::And),
        "XOR"  => Ok(GateType::Xor),
        "INV"  => Ok(GateType::Inv),
        "NOT"  => Ok(GateType::Inv),
        "OR"   => Ok(GateType::Or),
        "EQW"  => Ok(GateType::Eqw),
        other  => Err(format!("Unknown gate type: {}", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2-gate half-adder: XOR = sum, AND = carry
    // 4 wires: inputs 0,1 — outputs 2,3
    const HALF_ADDER: &str = "\
2 4
2 1 1
2 1 1
2 1 0 1 2 XOR
2 1 0 1 3 AND
";

    #[test]
    fn parse_half_adder() {
        let c = parse_bristol(HALF_ADDER).unwrap();
        assert_eq!(c.num_gates, 2);
        assert_eq!(c.num_wires, 4);
        assert_eq!(c.input_wires, vec![0, 1]);
        assert_eq!(c.output_wires, vec![2, 3]);
        assert_eq!(c.gates[0].gate_type, GateType::Xor);
        assert_eq!(c.gates[1].gate_type, GateType::And);
        assert_eq!(c.gates[0].output_wire, 2);
        assert_eq!(c.gates[1].output_wire, 3);
    }

    #[test]
    fn eval_gate_types() {
        assert!(GateType::And.eval(true, true));
        assert!(!GateType::And.eval(true, false));
        assert!(GateType::Xor.eval(true, false));
        assert!(!GateType::Xor.eval(true, true));
        assert!(GateType::Inv.eval(false, false));
        assert!(!GateType::Inv.eval(true, false));
    }
}
