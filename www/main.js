import init, { parse_circuit, EvalSession, OtSession } from './pkg/gc_viz.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

await init();

// ── State ─────────────────────────────────────────────────────────────────────

let circuitObj  = null;   // plain JS object from parse_circuit()
let session     = null;   // EvalSession WASM handle
let dagreLayout = null;   // dagre.graphlib.Graph after layout

// Two-party protocol state
let protocolPhase = 0;    // 0=idle 1=garbled 2=gc_sent 3=alice_labels 4=ot 5=evaluate 6=done
let ownershipMap  = {};   // wire_id → 'alice' | 'bob'
let aliceBits     = {};   // wire_id → 0|1
let bobBits       = {};   // wire_id → 0|1
let otSessions    = {};   // wire_id → OtSession (Alice's sender side)
let bobOtStates   = {};   // wire_id → { receiver_pk: hex, k_r: hex, bit: number }
let otResponses   = {};   // wire_id → { e0: hex, e1: hex } (Alice's round-3 response)
let pendingOtWires = [];  // Bob's wire IDs that need OT, in order
let otWireIdx     = 0;    // current index into pendingOtWires
let otSubStep     = 0;    // 0=init 1=round1 2=round2 3=round3 (complete)

// ── DOM refs ──────────────────────────────────────────────────────────────────

const bristolInput      = document.getElementById('bristol-input');
const btnParse          = document.getElementById('btn-parse');
const exampleSelect     = document.getElementById('example-select');
const btnLoadExample    = document.getElementById('btn-load-example');

const ownershipPanel    = document.getElementById('ownership-panel');
const ownershipRows     = document.getElementById('ownership-rows');
const btnNext           = document.getElementById('btn-next');

const phaseBar          = document.getElementById('phase-bar');
const partyPanel        = document.getElementById('party-panel');
const aliceWires        = document.getElementById('alice-wires');
const bobWiresEl        = document.getElementById('bob-wires');

const btnReset          = document.getElementById('btn-reset');
const btnBack           = document.getElementById('btn-back');
const btnFwd            = document.getElementById('btn-fwd');
const btnRun            = document.getElementById('btn-run');

const stepLabel         = document.getElementById('step-label');
const stepHeader        = document.getElementById('step-header');
const gateInfo          = document.getElementById('gate-info');
const wireTbody         = document.getElementById('wire-tbody');
const gtBox             = document.getElementById('garbled-table-box');
const gtThead           = document.querySelector('#gt-table thead tr');
const gtTbody           = document.getElementById('gt-tbody');
const svgRoot           = document.getElementById('svg-root');
const svg               = document.getElementById('circuit-svg');

const otPanel           = document.getElementById('ot-panel');
const otWireLabel       = document.getElementById('ot-wire-label');
const otMsgs            = document.getElementById('ot-msgs');

const protocolLogBox    = document.getElementById('protocol-log-box');
const protocolLog       = document.getElementById('protocol-log');

const gcBox             = document.getElementById('gc-box');
const gcDetails         = document.getElementById('gc-details');
const wkTbody           = document.getElementById('wk-tbody');
const gtAllBox          = document.getElementById('gt-all-box');
const outputInfoBox     = document.getElementById('output-info-box');

// ── Event listeners ───────────────────────────────────────────────────────────

btnParse.addEventListener('click', onParse);
btnLoadExample.addEventListener('click', onLoadExample);
btnNext.addEventListener('click', onNext);
btnReset.addEventListener('click', onReset);
btnBack.addEventListener('click', onStepBack);
btnFwd.addEventListener('click', onStepForward);
btnRun.addEventListener('click', onRunAll);

// ── Example circuits ──────────────────────────────────────────────────────────

const EXAMPLES = {
  'and': `\
# Single AND gate — 2 inputs, 1 output
1 3
2 1 1
1 1
2 1 0 1 2 AND`,

  'half-adder': `\
# Half-adder — inputs: a, b  outputs: sum (a XOR b), carry (a AND b)
2 4
2 1 1
2 1 1
2 1 0 1 2 XOR
2 1 0 1 3 AND`,

  'full-adder': `\
# Full adder — inputs: a, b, cin  outputs: sum, cout
# w3 = a XOR b
# w4 = a AND b
# w5 = (a XOR b) AND cin
# w6 = sum  = (a XOR b) XOR cin
# w7 = cout = (a AND b) OR ((a XOR b) AND cin)
5 8
3 1 1 1
2 1 1
2 1 0 1 3 XOR
2 1 0 1 4 AND
2 1 3 2 5 AND
2 1 3 2 6 XOR
2 1 4 5 7 OR`,

  'mux': `\
# 2-to-1 MUX — inputs: sel, a, b  output: sel ? b : a
# w3 = NOT sel
# w4 = a AND NOT sel
# w5 = b AND sel
# w6 = output
4 7
3 1 1 1
1 1
1 1 0 3 INV
2 1 3 1 4 AND
2 1 0 2 5 AND
2 1 4 5 6 OR`,
};

function onLoadExample() {
  const key = exampleSelect.value;
  if (!key) return;
  bristolInput.value = EXAMPLES[key];
  exampleSelect.value = '';
}

// ── Parse ─────────────────────────────────────────────────────────────────────

function onParse() {
  const text = bristolInput.value.trim();
  if (!text) { alert('Paste a circuit first.'); return; }

  try {
    circuitObj = parse_circuit(text);
  } catch (e) {
    alert('Parse error: ' + e.message);
    return;
  }

  session = null;
  protocolPhase = 0;
  dagreLayout = computeDagreLayout(circuitObj);
  renderSVG(dagreLayout, circuitObj);
  buildOwnershipUI(circuitObj);

  ownershipPanel.style.display = 'block';
  phaseBar.style.display = 'none';
  partyPanel.style.display = 'none';
  otPanel.style.display = 'none';
  if (outputInfoBox) outputInfoBox.style.display = 'none';
  protocolLogBox.style.display = 'none';
  protocolLog.innerHTML = '';
  btnNext.disabled  = false;
  btnNext.textContent = 'Garble & Start Protocol →';
  btnReset.disabled = true;
  btnBack.disabled  = true;
  btnFwd.disabled   = true;
  btnRun.disabled   = true;
  updateStepLabel(0, circuitObj.gates.length);
  wireTbody.innerHTML = '';
  gateInfo.textContent = '—';
  gtBox.style.display = 'none';
}

// ── Ownership UI ──────────────────────────────────────────────────────────────

function buildOwnershipUI(circuit) {
  ownershipRows.innerHTML = '';
  ownershipMap = {};
  aliceBits = {};
  bobBits   = {};

  // Default assignment: use input_wire_counts to split between parties.
  // First party (party 0) → Alice, rest → Bob.  If only one party, all Alice.
  const counts = circuit.input_wire_counts;
  const aliceCount = counts.length > 0 ? counts[0] : circuit.input_wires.length;

  circuit.input_wires.forEach((wid, i) => {
    const defaultOwner = i < aliceCount ? 'alice' : 'bob';
    ownershipMap[wid] = defaultOwner;
    aliceBits[wid] = 0;
    bobBits[wid]   = 0;

    const row = document.createElement('div');
    row.className = 'ownership-row';
    row.dataset.wireId = wid;

    const wireIdSpan = document.createElement('span');
    wireIdSpan.className = 'wire-id';
    wireIdSpan.textContent = `w${wid}`;

    // Owner toggle
    const toggle = document.createElement('div');
    toggle.className = 'owner-toggle';

    const btnAlice = document.createElement('button');
    btnAlice.className = 'owner-btn' + (defaultOwner === 'alice' ? ' active-alice' : '');
    btnAlice.textContent = 'Alice';
    btnAlice.addEventListener('click', () => {
      ownershipMap[wid] = 'alice';
      btnAlice.className = 'owner-btn active-alice';
      btnBob.className   = 'owner-btn';
    });

    const btnBob = document.createElement('button');
    btnBob.className = 'owner-btn' + (defaultOwner === 'bob' ? ' active-bob' : '');
    btnBob.textContent = 'Bob';
    btnBob.addEventListener('click', () => {
      ownershipMap[wid] = 'bob';
      btnBob.className   = 'owner-btn active-bob';
      btnAlice.className = 'owner-btn';
    });

    toggle.appendChild(btnAlice);
    toggle.appendChild(btnBob);

    // Bit selector
    const bitSel = document.createElement('select');
    bitSel.className = 'bit-sel';
    bitSel.innerHTML = '<option value="0">bit 0</option><option value="1">bit 1</option>';
    bitSel.addEventListener('change', () => {
      aliceBits[wid] = parseInt(bitSel.value, 10);
      bobBits[wid]   = parseInt(bitSel.value, 10);
    });

    row.appendChild(wireIdSpan);
    row.appendChild(toggle);
    row.appendChild(bitSel);
    ownershipRows.appendChild(row);
  });
}

// ── Protocol phase machine ────────────────────────────────────────────────────

function onNext() {
  switch (protocolPhase) {
    case 0: runPhaseGarble();      break;
    case 1: runPhaseSendGC();      break;
    case 2: runPhaseAliceLabels(); break;
    case 3: startPhaseOT();        break;
    case 4: advanceOTSubStep();    break;
    // phase 5 (evaluate) uses Back/Fwd/Run buttons
  }
}

// Phase 1 — Alice garbles the circuit
function runPhaseGarble() {
  if (!circuitObj) return;

  // Collect all bits in input_wire order (Alice real + Bob real)
  const bits = new Uint8Array(circuitObj.input_wires.map(wid => {
    return ownershipMap[wid] === 'alice' ? (aliceBits[wid] || 0) : (bobBits[wid] || 0);
  }));

  try {
    session = new EvalSession(JSON.stringify(circuitObj), bits);
  } catch (e) {
    alert('Garble error: ' + e.message);
    return;
  }

  protocolPhase = 1;
  ownershipPanel.style.display = 'none';
  phaseBar.style.display       = 'flex';
  protocolLogBox.style.display = 'block';
  partyPanel.style.display     = 'flex';

  buildPartyColumns();
  buildGCBox();
  updatePhaseBar(1);
  btnNext.textContent = 'Send GC to Bob →';
  btnNext.disabled = false;

  const aliceCount = circuitObj.input_wires.filter(w => ownershipMap[w] === 'alice').length;
  const bobCount   = circuitObj.input_wires.filter(w => ownershipMap[w] === 'bob').length;
  appendLog(1,
    `Alice garbled the circuit (${circuitObj.gates.length} gates, ${circuitObj.num_wires} wires)`,
    `Alice assigned two random 128-bit labels (k₀, k₁) to every wire — one for bit-value 0, one for bit-value 1. ` +
    `Each gate's truth table was replaced by an encrypted garbled table. ` +
    `Alice owns ${aliceCount} input wire(s); Bob owns ${bobCount} input wire(s). ` +
    `Bob will only ever see one label per wire — never both — so he learns nothing about intermediate values.`
  );
  clearHighlights();
  refreshWireTable();
}

// Phase 2 — Alice sends the garbled circuit to Bob
function runPhaseSendGC() {
  protocolPhase = 2;
  updatePhaseBar(2);

  // Flash the graph panel to show "transfer"
  const gp = document.getElementById('graph-panel');
  gp.style.transition = 'outline 0.3s';
  gp.style.outline = '2px solid var(--bob)';
  setTimeout(() => { gp.style.outline = ''; }, 600);

  const gcBytes = circuitObj.gates.length * 4 * 16; // rough estimate
  appendLog(2,
    `Alice → Bob: garbled circuit (~${gcBytes} bytes of encrypted tables)`,
    `Bob receives the garbled tables for all ${circuitObj.gates.length} gate(s). ` +
    `Each entry is a 16-byte AES-encrypted ciphertext — Bob cannot read any gate output ` +
    `until he holds the correct input wire labels for that gate. ` +
    `Alice's wire keys remain secret; only the encrypted tables are transmitted.`
  );

  btnNext.textContent = 'Send Alice\'s Labels →';
  protocolPhase = 2;
}

// Phase 3 — Alice sends her own wire labels directly
function runPhaseAliceLabels() {
  protocolPhase = 3;
  updatePhaseBar(3);

  const aliceWireIds = circuitObj.input_wires.filter(wid => ownershipMap[wid] === 'alice');
  if (aliceWireIds.length === 0) {
    appendLog(3, 'Alice has no input wires — skipping direct label transfer',
      'Alice owns no input wires in this configuration, so this phase is a no-op.');
  } else {
    appendLog(3,
      `Alice sends her ${aliceWireIds.length} input label(s) directly to Bob`,
      `Alice knows her own input bits, so she simply picks the matching label for each of her wires ` +
      `and sends it in the clear. There is no privacy concern here — Alice is only revealing ` +
      `her own inputs, which Bob needs to start evaluation.`
    );
    const labels = getWireLabels();
    for (const wid of aliceWireIds) {
      const ws = labels[wid];
      if (ws) {
        appendLog(3,
          `Alice → Bob: w${wid} label = ${ws.label_hex.slice(0, 16)}…`,
          `This is the label for bit-value ${ws.color_bit} on wire w${wid} (color bit = ${ws.color_bit}). ` +
          `Bob stores this label; he cannot tell which bit it represents from the label alone.`
        );
      }
    }
  }

  updatePartyColumns(/* revealAlice= */ true);

  const bobWireIds = circuitObj.input_wires.filter(wid => ownershipMap[wid] === 'bob');
  if (bobWireIds.length === 0) {
    appendLog(3, 'Bob has no input wires — no OT needed',
      'All input wires belong to Alice, so the Oblivious Transfer phase is skipped entirely. ' +
      'Bob can proceed directly to evaluation with the labels he just received.');
    protocolPhase = 4;
    finishOTPhase();
    return;
  }

  appendLog(3,
    `Bob has ${bobWireIds.length} input wire(s): ${bobWireIds.map(w => 'w' + w).join(', ')}`,
    `Bob cannot receive these labels the same way Alice sent hers — that would require Alice ` +
    `to know Bob's input bits, violating his privacy. Instead, each wire requires one round of ` +
    `1-of-2 Oblivious Transfer (OT) so Bob gets exactly one label per wire without Alice ` +
    `learning which label he chose.`
  );
  btnNext.textContent = `Start OT for ${bobWireIds.length} wire(s) →`;
}

// Phase 4 — OT for Bob's wires
function startPhaseOT() {
  protocolPhase = 4;
  updatePhaseBar(4);

  pendingOtWires = circuitObj.input_wires.filter(wid => ownershipMap[wid] === 'bob');
  otWireIdx  = 0;
  otSubStep  = 0;
  otSessions = {};
  bobOtStates = {};
  otResponses = {};

  otPanel.style.display = 'block';
  btnNext.textContent = 'OT Round 1 →';

  appendLog(4,
    `Starting Oblivious Transfer for ${pendingOtWires.length} wire(s)`,
    `Protocol: Simplest OT (Chou–Orlandi 2015) over the Ristretto255 elliptic curve group. ` +
    `Each wire requires 3 messages. Security: semi-honest — Alice cannot learn Bob's bit; ` +
    `Bob cannot learn the label he didn't choose (under the CDH assumption).`
  );

  advanceOTSubStep();
}

function advanceOTSubStep() {
  if (otWireIdx >= pendingOtWires.length) {
    finishOTPhase();
    return;
  }

  const wid = pendingOtWires[otWireIdx];

  if (otSubStep === 0) {
    // Round 1: Alice sets up OT sender, sends A = a·G
    const kp = session.bob_wire_key_pair(wid);
    otSessions[wid] = new OtSession(kp.m0, kp.m1);
    const senderPk = otSessions[wid].sender_message();

    otWireLabel.textContent = `Wire w${wid} — OT (Bob's bit = ${bobBits[wid] || 0})`;

    // Show Alice's two labels as context before the OT messages
    otMsgs.innerHTML = `
      <div class="ot-context">
        <div class="ot-context-title">Alice's labels for w${wid}</div>
        <div class="ot-context-row">
          <span class="ot-context-key">m₀ =</span>
          <span class="ot-context-val">${kp.m0}</span>
        </div>
        <div class="ot-context-row">
          <span class="ot-context-key">m₁ =</span>
          <span class="ot-context-val">${kp.m1}</span>
        </div>
        <div class="ot-context-row" style="margin-top:3px;font-size:0.62rem;color:var(--text-dim)">
          Bob wants m<sub>${bobBits[wid] || 0}</sub> without revealing his bit to Alice
        </div>
      </div>
    `;
    renderOTMsg(wid, 0, 'Alice → Bob', 'A', senderPk);

    appendLog(4,
      `w${wid} · Round 1 — Alice → Bob: A = ${senderPk.slice(0, 16)}…`,
      `Alice holds two labels: m₀ = ${kp.m0.slice(0,16)}… and m₁ = ${kp.m1.slice(0,16)}… ` +
      `She picks a random scalar a, computes the Ristretto255 point A = a·G, and sends it to Bob. ` +
      `A is Alice's temporary public key for this OT instance. It reveals nothing about m₀ or m₁.`
    );
    otSubStep = 1;
    btnNext.textContent = 'OT Round 2 →';

  } else if (otSubStep === 1) {
    // Round 2: Bob replies with B based on his bit
    const wid0 = pendingOtWires[otWireIdx];
    const senderPk = otSessions[wid0].sender_message();
    const bit = bobBits[wid0] || 0;
    const bobState = OtSession.receiver_reply(senderPk, bit);
    bobOtStates[wid0] = bobState;

    renderOTMsg(wid0, 1, 'Bob → Alice', 'B', bobState.receiver_pk);

    const bFormula = bit === 0
      ? `B = r·G   (bit=0: random point, unrelated to A)`
      : `B = r·G + A   (bit=1: random point shifted by A)`;
    appendLog(4,
      `w${wid0} · Round 2 — Bob → Alice: B = ${bobState.receiver_pk.slice(0, 16)}…`,
      `Bob has bit b=${bit}. He picks a random scalar r and computes ${bFormula}. ` +
      `He also pre-computes his decryption key k_r = H(r·A, b) — this equals H(r·a·G, b). ` +
      `Alice sees only a compressed 32-byte Ristretto point. Since r is random, B looks ` +
      `uniformly distributed to Alice in both cases — she cannot determine b from B.`
    );
    otSubStep = 2;
    btnNext.textContent = 'OT Round 3 →';

  } else if (otSubStep === 2) {
    // Round 3: Alice encrypts both labels and sends (e0, e1)
    const wid0 = pendingOtWires[otWireIdx];
    const bobState = bobOtStates[wid0];
    const resp = otSessions[wid0].sender_respond(bobState.receiver_pk);
    otResponses[wid0] = resp;  // cache for sub-step 3

    renderOTMsg(wid0, 2, 'Alice → Bob', 'e0', resp.e0);
    renderOTMsg(wid0, 3, 'Alice → Bob', 'e1', resp.e1);

    appendLog(4,
      `w${wid0} · Round 3 — Alice → Bob: e₀, e₁`,
      `Alice computes two encryption keys from Bob's point B: ` +
      `k₀ = H(a·B, 0) and k₁ = H(a·(B−A), 1). ` +
      `If b=0: a·B = a·r·G = r·A, so k₀ = k_r and Bob can decrypt e₀. ` +
      `If b=1: a·(B−A) = a·r·G = r·A, so k₁ = k_r and Bob can decrypt e₁. ` +
      `Alice sends e₀ = k₀ XOR m₀ = ${resp.e0.slice(0,16)}… ` +
      `and e₁ = k₁ XOR m₁ = ${resp.e1.slice(0,16)}…  ` +
      `Alice does not know b, so she does not know which ciphertext Bob will use.`
    );
    otSubStep = 3;
    btnNext.textContent = 'OT Complete →';

  } else if (otSubStep === 3) {
    // Bob decrypts and receives his label
    const wid0 = pendingOtWires[otWireIdx];
    const bobState = bobOtStates[wid0];
    const resp = otResponses[wid0];
    const bit  = bobBits[wid0] || 0;

    let label;
    try {
      label = OtSession.receiver_complete(bobState.k_r, resp.e0, resp.e1, bit);
    } catch (e) {
      alert('OT receiver_complete failed: ' + e.message);
      return;
    }

    try {
      session.provide_bob_label(wid0, label);
    } catch (e) {
      alert('provide_bob_label failed: ' + e.message);
      return;
    }

    appendLog(4,
      `w${wid0} · OT complete — Bob decrypted label = ${label.slice(0, 16)}…`,
      `Bob computes m_b = e_b XOR k_r = e${bit} XOR k_r. ` +
      `He now holds the wire label for bit-value ${bit} on w${wid0}. ` +
      `The other label (for bit ${1 - bit}) is encrypted under an independent key ` +
      `H(a·B, 1−b) that Bob cannot compute — he would need Alice's secret scalar a. ` +
      `Alice likewise cannot distinguish which of e₀ or e₁ Bob decrypted.`
    );
    updatePartyColumns(/* revealAlice= */ true, /* revealBobWire= */ wid0);

    otWireIdx++;
    otSubStep = 0;

    if (otWireIdx < pendingOtWires.length) {
      const nextWid = pendingOtWires[otWireIdx];
      otWireLabel.textContent = `Wire w${nextWid} (Bob's bit = ${bobBits[nextWid] || 0})`;
      otMsgs.innerHTML = '';
      btnNext.textContent = 'OT Round 1 →';
    } else {
      finishOTPhase();
    }
  }
}

function finishOTPhase() {
  protocolPhase = 5;
  updatePhaseBar(5);
  otPanel.style.display        = 'none';
  if (outputInfoBox) { outputInfoBox.style.display = 'block'; outputInfoBox.querySelector('details').open = true; }

  btnNext.disabled    = true;
  btnNext.textContent = 'Next →';   // reset label so it's not confusing when disabled
  btnReset.disabled   = false;
  btnBack.disabled    = true;
  btnFwd.disabled     = false;
  btnRun.disabled     = false;

  appendLog(5,
    `All ${circuitObj.input_wires.length} input label(s) ready — Bob begins gate evaluation`,
    `Bob now holds exactly one wire label per input wire. He evaluates each gate in topological ` +
    `order: for each gate he uses the color bits (LSBs) of its input labels to select the correct ` +
    `row in the garbled table, then decrypts the output label using AES. ` +
    `Use Forward / Back / Run All to step through the evaluation.`
  );
  updateStepLabel(0, session.total_gates());
  refreshWireTable();

  // Flash the step header to draw attention to the Forward/Run buttons
  stepHeader.classList.add('phase-ready');
  setTimeout(() => stepHeader.classList.remove('phase-ready'), 1200);
}

// ── OT message rendering ──────────────────────────────────────────────────────

function renderOTMsg(wid, idx, direction, key, value) {
  // Remove any existing entry for this index
  const existing = otMsgs.querySelector(`[data-ot-idx="${idx}"]`);
  if (existing) existing.remove();

  const isAliceToBob = direction.startsWith('Alice');
  const arrowSpan = `<span class="${isAliceToBob ? 'arrow-alice' : 'arrow-bob'}">${direction}</span>`;

  const div = document.createElement('div');
  div.className = 'ot-msg';
  div.dataset.otIdx = idx;
  div.innerHTML = `
    <span class="ot-msg-dir">${arrowSpan}</span>
    <span class="ot-msg-key">${key} =&nbsp;</span>
    <span class="ot-msg-val">${value.slice(0, 32)}${value.length > 32 ? '…' : ''}</span>
  `;
  otMsgs.appendChild(div);
}

// ── Party column rendering ────────────────────────────────────────────────────

function buildPartyColumns() {
  aliceWires.innerHTML = '';
  bobWiresEl.innerHTML = '';

  for (const wid of circuitObj.input_wires) {
    const owner = ownershipMap[wid] || 'alice';
    const bit   = owner === 'alice' ? (aliceBits[wid] || 0) : (bobBits[wid] || 0);

    const row = document.createElement('div');
    row.className = 'party-wire-row';
    row.dataset.wireId = wid;

    const idEl = document.createElement('span');
    idEl.className = 'party-wire-id';
    idEl.textContent = `w${wid}`;

    const bitEl = document.createElement('span');
    bitEl.className = 'party-wire-bit';
    bitEl.textContent = bit;

    row.appendChild(idEl);
    row.appendChild(bitEl);

    if (owner === 'alice') {
      // Show both k0 and k1 labels, highlighting the one that matches Alice's bit
      try {
        const kp = session.bob_wire_key_pair(wid);
        const pairEl = document.createElement('div');
        pairEl.className = 'label-pair';
        for (const [ki, hex] of [['k0', kp.m0], ['k1', kp.m1]]) {
          const selected = (ki === 'k0' && bit === 0) || (ki === 'k1' && bit === 1);
          const rowEl = document.createElement('div');
          rowEl.className = `label-pair-row ${selected ? 'selected' : 'unselected'}`;
          rowEl.innerHTML =
            `<span class="label-k ${ki}">${ki}:</span>` +
            `<span class="label-hex">${hex}</span>`;
          pairEl.appendChild(rowEl);
        }
        row.appendChild(pairEl);
      } catch {
        const labelEl = document.createElement('span');
        labelEl.className = 'label-hidden';
        labelEl.textContent = '(label hidden)';
        row.appendChild(labelEl);
      }
      aliceWires.appendChild(row);
    } else {
      // Bob's wire: show placeholder until OT delivers the label
      const labelEl = document.createElement('span');
      labelEl.className = 'label-hidden';
      labelEl.dataset.bobPending = 'true';
      labelEl.textContent = '(awaiting OT)';
      row.appendChild(labelEl);
      bobWiresEl.appendChild(row);
    }
  }
}

// ── Full garbled circuit dump ─────────────────────────────────────────────────

function buildGCBox() {
  gcBox.style.display = 'block';

  const inputSet  = new Set(circuitObj.input_wires);
  const outputSet = new Set(circuitObj.output_wires);

  // ── Wire keys table ──
  const wkRows = [];
  for (let wid = 0; wid < circuitObj.num_wires; wid++) {
    const kp = session.bob_wire_key_pair(wid);
    const isIn  = inputSet.has(wid);
    const isOut = outputSet.has(wid);
    const rowCls = isIn ? ' class="wk-input-row"' : isOut ? ' class="wk-output-row"' : '';
    const tag = isIn
      ? '<span class="wk-tag wk-tag-in">in</span>'
      : isOut ? '<span class="wk-tag wk-tag-out">out</span>' : '';
    wkRows.push(
      `<tr${rowCls}>` +
      `<td class="wk-wire-id">w${wid}${tag}</td>` +
      `<td class="wk-k0">${kp.m0}</td>` +
      `<td class="wk-k1">${kp.m1}</td>` +
      `</tr>`
    );
  }
  wkTbody.innerHTML = wkRows.join('');

  // ── Garbled tables ──
  gtAllBox.innerHTML = circuitObj.gates.map(gate => {
    const rows = session.garbled_table(gate.id);
    const isBinary = gate.input_wires.length === 2;
    const rowsHtml = rows.map((hex, i) => {
      const ca = isBinary ? (i >> 1) : i;
      const cb = isBinary ? (i & 1) : '—';
      return `<tr><td>${ca}</td><td>${cb}</td><td>${hex}</td></tr>`;
    }).join('');
    const inWires = gate.input_wires.map(w => `w${w}`).join(', ');
    const cbHeader = isBinary ? 'c(b)' : '—';
    return `<div class="gc-gate-block">
      <div class="gc-gate-header">
        Gate ${gate.id} &nbsp;·&nbsp; <span class="gh-type">${gate.gate_type}</span>
        &nbsp; in: [${inWires}] &nbsp;→&nbsp; out: w${gate.output_wire}
      </div>
      <table class="gc-gate-table">
        <thead><tr><th>c(a)</th><th>${cbHeader}</th><th>Ciphertext (AES-DM encrypted output label)</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  }).join('');
}

function updatePartyColumns(revealAlice = false, revealBobWire = null) {
  if (!session) return;
  // Alice's wires already show both labels from buildPartyColumns() — nothing to update there.
  // Only act when a Bob wire has just completed OT.
  if (revealBobWire === null) return;

  const labels = getWireLabels();
  const wid = revealBobWire;
  const row = bobWiresEl.querySelector(`[data-wire-id="${wid}"]`);
  if (!row) return;

  const placeholder = row.querySelector('[data-bob-pending]');
  if (placeholder) placeholder.remove();

  const ws = labels[wid];
  const hex = ws ? ws.label_hex : (otResponses[wid] ? null : null);
  if (!hex && ws) {
    // should always have ws after provide_bob_label
  }
  const receivedHex = ws ? ws.label_hex : '';
  const bit = bobBits[wid] || 0;

  const labelEl = document.createElement('div');
  labelEl.className = 'label-ot-received';
  labelEl.title = `Bob's label for bit ${bit} on w${wid}`;
  labelEl.innerHTML =
    `<span style="font-weight:700;font-size:0.6rem;margin-right:0.3rem;">received:</span>` +
    `${receivedHex}`;
  row.appendChild(labelEl);
}

// ── Phase bar ─────────────────────────────────────────────────────────────────

function updatePhaseBar(activePhase) {
  document.querySelectorAll('.phase-step').forEach(el => {
    const p = parseInt(el.dataset.phase, 10);
    el.className = 'phase-step' +
      (p === activePhase ? ' active' : p < activePhase ? ' done' : '');
  });
}

// ── Protocol log ──────────────────────────────────────────────────────────────

function appendLog(phase, text, detail = '') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const detailHtml = detail
    ? `<span class="log-detail">${detail}</span>`
    : '';
  entry.innerHTML =
    `<span class="log-phase log-phase-${phase}">Phase ${phase}</span>` +
    `<span class="log-text">${text}</span>` +
    detailHtml;
  protocolLog.appendChild(entry);
  protocolLog.scrollTop = protocolLog.scrollHeight;
}

// ── Step forward (phase 5) ────────────────────────────────────────────────────

function onStepForward() {
  if (!session || session.is_complete()) return;
  const snap = session.step_forward();
  applySnapshot(snap);
}

function onStepBack() {
  if (!session || session.current_step() === 0) return;
  session.step_back();
  rebuildHighlightsFromSession();
}

function onRunAll() {
  if (!session) return;
  while (!session.is_complete()) {
    const snap = session.step_forward();
    applySnapshot(snap);
  }
  if (protocolPhase === 5) {
    protocolPhase = 6;
    updatePhaseBar(6);
    showOutputColorBits();
  }
}

// ── Reset ─────────────────────────────────────────────────────────────────────

function onReset() {
  session = null;
  protocolPhase = 0;
  ownershipMap = {};
  aliceBits = {};
  bobBits   = {};
  otSessions = {};
  bobOtStates = {};
  otResponses = {};
  pendingOtWires = [];
  otWireIdx  = 0;
  otSubStep  = 0;

  ownershipPanel.style.display = circuitObj ? 'block' : 'none';
  phaseBar.style.display       = 'none';
  partyPanel.style.display     = 'none';
  otPanel.style.display        = 'none';
  protocolLogBox.style.display = 'none';
  protocolLog.innerHTML        = '';
  btnNext.disabled   = false;
  btnNext.textContent = 'Garble & Start Protocol →';
  btnReset.disabled  = true;
  btnBack.disabled   = true;
  btnFwd.disabled    = true;
  btnRun.disabled    = true;
  clearHighlights();
  updateWireLabelsOnGraph();   // session is null here → resets all labels to w${id}
  wireTbody.innerHTML = '';
  gateInfo.textContent = '—';
  gtBox.style.display = 'none';
  gcBox.style.display        = 'none';
  if (outputInfoBox) outputInfoBox.style.display = 'none';
  wkTbody.innerHTML   = '';
  gtAllBox.innerHTML  = '';
  if (gcDetails) gcDetails.removeAttribute('open');
  updateStepLabel(0, circuitObj ? circuitObj.gates.length : 0);

  if (circuitObj) buildOwnershipUI(circuitObj);
}

// ── Apply a snapshot from step_forward / step_back ────────────────────────────

function applySnapshot(snap) {
  clearHighlights();

  const step  = session.current_step();
  const total = session.total_gates();
  updateStepLabel(step, total);

  if (snap.active_gate_id != null) {
    highlightGate(snap.active_gate_id, 'active');
    showGateInfo(snap.active_gate_id);
    showGarbledTable(snap.active_gate_id);

    if (snap.new_wire != null && protocolPhase >= 5) {
      const gate = circuitObj.gates[snap.active_gate_id];
      const ws   = snap.new_wire;
      appendLog(5,
        `Gate #${snap.active_gate_id} (${gate.gate_type}) → w${ws.wire_id} label = ${ws.label_hex.slice(0,16)}…`,
        `Bob used color bits of input label(s) to select row ${ws.color_bit} in the garbled table, ` +
        `then decrypted: kc = H(ka, gate, row) XOR H(kb, gate, row) XOR table[row]. ` +
        `Output wire w${ws.wire_id} color bit = ${ws.color_bit}.`
      );
    }
  } else {
    gateInfo.textContent = '—';
    gtBox.style.display = 'none';
  }

  if (snap.new_wire != null) {
    highlightWire(snap.new_wire.wire_id, 'resolved');
  }

  refreshWireTable();
  updateWireLabelsOnGraph();

  btnBack.disabled = (step === 0);
  btnFwd.disabled  = session.is_complete();
  btnRun.disabled  = session.is_complete();

  if (session.is_complete() && protocolPhase === 5) {
    protocolPhase = 6;
    updatePhaseBar(6);
    showOutputColorBits();
  }
}

function rebuildHighlightsFromSession() {
  clearHighlights();
  const step = session.current_step();
  updateStepLabel(step, session.total_gates());

  const snap = step > 0
    ? { active_gate_id: circuitObj.gates[step - 1].id, new_wire: null }
    : { active_gate_id: null, new_wire: null };

  if (snap.active_gate_id != null) {
    highlightGate(snap.active_gate_id, 'active');
    showGateInfo(snap.active_gate_id);
    showGarbledTable(snap.active_gate_id);
  } else {
    gateInfo.textContent = '—';
    gtBox.style.display = 'none';
  }

  const labels = getWireLabels();
  for (const wireId of Object.keys(labels)) {
    highlightWire(parseInt(wireId, 10), 'resolved');
  }

  refreshWireTable();
  updateWireLabelsOnGraph();
  btnBack.disabled = (step === 0);
  btnFwd.disabled  = session.is_complete();
  btnRun.disabled  = session.is_complete();
}

// ── Output decoding ───────────────────────────────────────────────────────────

function showOutputColorBits() {
  if (!session || !circuitObj) return;
  const labels = getWireLabels();
  const parts  = circuitObj.output_wires.map(wid => {
    const ws = labels[wid];
    return ws ? `w${wid}=${ws.color_bit}` : `w${wid}=?`;
  });
  appendLog(6,
    `Evaluation complete — output color bits: ${parts.join('  ')}`,
    `The color bit (LSB of each label) encodes the output value. ` +
    `In a real deployment Bob would need an output-decoding table from Alice ` +
    `to confirm which color bit means 0 and which means 1. ` +
    `Here the color convention is: label[0] color bit = 0 means the wire carries value 0.`
  );

  // Show decoded output in party columns
  showOutputInPartyColumns(labels);
}

function showOutputInPartyColumns(labels) {
  const rows = circuitObj.output_wires.map(wid => {
    const ws = labels[wid];
    const bit = ws ? ws.color_bit : '?';
    return { wid, bit };
  });

  // Bob column: he holds the output labels and can read the color bit
  const bobOut = document.createElement('div');
  bobOut.className = 'party-output-result';
  bobOut.innerHTML = `<div class="party-output-title">Output (Bob evaluates &amp; reads color bit)</div>` +
    rows.map(r => `<div class="party-output-row"><span class="party-wire-id">w${r.wid}</span><span class="party-wire-bit">${r.bit}</span></div>`).join('');
  bobWiresEl.appendChild(bobOut);

  // Alice column: she would need Bob to send her the result, or provide a decoding table
  const aliceOut = document.createElement('div');
  aliceOut.className = 'party-output-result party-output-alice-note';
  aliceOut.innerHTML = `<div class="party-output-title">Output (Alice learns only if Bob tells her, or via a decoding table she provided)</div>` +
    rows.map(r => `<div class="party-output-row"><span class="party-wire-id">w${r.wid}</span><span class="party-wire-bit">${r.bit}</span></div>`).join('');
  aliceWires.appendChild(aliceOut);
}

// ── Wire labels helper ────────────────────────────────────────────────────────
// serde-wasm-bindgen 0.6 serialises HashMap as a JS Map, not a plain object.
// All callers use bracket notation / Object.entries / Object.keys, so we
// normalise once here to a plain object keyed by wire id.
function getWireLabels() {
  if (!session) return {};
  const raw = session.wire_labels();
  if (raw instanceof Map) {
    const obj = {};
    raw.forEach((v, k) => { obj[k] = v; });
    return obj;
  }
  return raw ?? {};
}

// ── Wire table ────────────────────────────────────────────────────────────────

function refreshWireTable() {
  if (!session) { wireTbody.innerHTML = ''; return; }
  const labels = getWireLabels();
  const rows = Object.entries(labels)
    .map(([wid, ws]) => ({ wid: parseInt(wid, 10), ws }))
    .sort((a, b) => a.wid - b.wid);

  wireTbody.innerHTML = rows.map(({ wid, ws }) =>
    `<tr>
       <td>${wid}</td>
       <td class="bit-cell">${ws.color_bit}</td>
       <td class="mono" style="word-break:break-all;font-size:0.68rem">${ws.label_hex}</td>
     </tr>`
  ).join('');
}

// ── Gate info + garbled table ─────────────────────────────────────────────────

function showGateInfo(gateId) {
  if (!circuitObj) return;
  const gate = circuitObj.gates[gateId];
  if (!gate) { gateInfo.textContent = '—'; return; }
  gateInfo.textContent =
    `#${gateId} ${gate.gate_type}  in:[${gate.input_wires.join(', ')}]  out:${gate.output_wire}`;
}

function showGarbledTable(gateId) {
  if (!session) return;
  try {
    const rows = session.garbled_table(gateId);
    const gate = circuitObj && circuitObj.gates[gateId];
    const isBinary = gate && gate.input_wires.length === 2;

    gtThead.innerHTML = isBinary
      ? '<th>c(a)</th><th>c(b)</th><th>Ciphertext</th>'
      : '<th>c(a)</th><th>c(b)</th><th>Ciphertext</th>';

    gtTbody.innerHTML = rows.map((hex, i) => {
      const ca = isBinary ? (i >> 1) : i;
      const cb = isBinary ? (i & 1) : '—';
      return `<tr><td>${ca}</td><td>${cb}</td><td class="mono">${hex}</td></tr>`;
    }).join('');
    gtBox.style.display = 'block';
  } catch (_) {
    gtBox.style.display = 'none';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function updateStepLabel(step, total) {
  stepLabel.textContent = `Step ${step} / ${total}`;
}

function clearHighlights() {
  svg.querySelectorAll('.gate-node.active').forEach(el => el.classList.remove('active'));
  svg.querySelectorAll('.wire-path.resolved').forEach(el => el.classList.remove('resolved'));
}

function highlightGate(gateId, cls) {
  const el = svg.querySelector(`[data-gate-id="${gateId}"] .gate-node`);
  if (el) el.classList.add(cls);
}

function highlightWire(wireId, cls) {
  svg.querySelectorAll(`[data-wire="${wireId}"]`).forEach(el => el.classList.add(cls));
}

function updateWireLabelsOnGraph() {
  const labels = session ? getWireLabels() : {};
  svg.querySelectorAll('[data-wire-label]').forEach(el => {
    const wid = el.dataset.wireLabel;
    const ws = labels[wid];
    if (ws) {
      el.textContent = `w${wid} ${ws.label_hex.slice(0, 8)}…`;
      el.classList.add('wire-label-known');
    } else {
      el.textContent = `w${wid}`;
      el.classList.remove('wire-label-known');
    }
  });
}

// ── Dagre layout ──────────────────────────────────────────────────────────────

function computeDagreLayout(circuit) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 100, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const wid of circuit.input_wires) {
    g.setNode(`i${wid}`, { label: `in\nw${wid}`, width: 52, height: 36, kind: 'input', wid });
  }

  for (const gate of circuit.gates) {
    g.setNode(`g${gate.id}`, {
      label: gate.gate_type,
      width: 64,
      height: 40,
      kind: 'gate',
      gateId: gate.id,
    });
  }

  for (const wid of circuit.output_wires) {
    g.setNode(`o${wid}`, { label: `out\nw${wid}`, width: 52, height: 36, kind: 'output', wid });
  }

  const producer = {};
  for (const gate of circuit.gates) {
    producer[gate.output_wire] = `g${gate.id}`;
  }
  for (const wid of circuit.input_wires) {
    producer[wid] = `i${wid}`;
  }

  for (const gate of circuit.gates) {
    for (const inWire of gate.input_wires) {
      const src = producer[inWire];
      if (src !== undefined) {
        g.setEdge(src, `g${gate.id}`, { wire: inWire });
      }
    }
  }

  for (const wid of circuit.output_wires) {
    const src = producer[wid];
    if (src) {
      g.setEdge(src, `o${wid}`, { wire: wid });
    }
  }

  dagre.layout(g);
  return g;
}

// ── SVG rendering ─────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function renderSVG(g, circuit) {
  svgRoot.innerHTML = '';

  const graph = g.graph();
  const W = (graph.width  || 400) + 80;
  const H = (graph.height || 300) + 80;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width',  W);
  svg.setAttribute('height', H);

  // Collect wire-label text elements to append after nodes (so they render on top)
  const wireLabelEls = [];

  for (const e of g.edges()) {
    const edge = g.edge(e);
    const pts  = edge.points || [];
    if (pts.length < 2) continue;

    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
    const path = svgEl('path', {
      d,
      class: 'wire-path',
      'data-wire': edge.wire,
      'marker-end': 'url(#arrowhead)',
    });
    svgRoot.appendChild(path);

    // Build wire label — deferred until after nodes are drawn
    const mid = pts[Math.floor(pts.length / 2)];
    const wlabel = svgEl('text', {
      x: mid.x,
      y: mid.y - 8,
      class: 'wire-label',
      'data-wire-label': edge.wire,
    });
    wlabel.textContent = `w${edge.wire}`;
    wireLabelEls.push(wlabel);
  }

  for (const nid of g.nodes()) {
    const node = g.node(nid);
    const x = node.x - node.width  / 2;
    const y = node.y - node.height / 2;

    const group = svgEl('g', { 'data-node-id': nid });
    if (node.kind === 'gate') group.dataset.gateId = node.gateId;

    let cls = 'gate-node';
    if (node.kind === 'input')  cls = 'input-node';
    if (node.kind === 'output') cls = 'output-node';

    const rect = svgEl('rect', {
      x, y, width: node.width, height: node.height, rx: 4, class: cls,
    });

    const lines = node.label.split('\n');
    const textGroup = svgEl('g');
    lines.forEach((line, li) => {
      const t = svgEl('text', {
        x: node.x,
        y: node.y + (li - (lines.length - 1) / 2) * 14,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        class: 'node-label',
      });
      t.textContent = line;
      textGroup.appendChild(t);
    });

    group.appendChild(rect);
    group.appendChild(textGroup);
    svgRoot.appendChild(group);

    if (node.kind === 'gate') {
      group.style.cursor = 'pointer';
      group.addEventListener('click', () => {
        if (session) showGarbledTable(node.gateId);
        showGateInfo(node.gateId);
      });
    }
  }

  // Append wire labels last so they appear above gate node rectangles
  for (const el of wireLabelEls) svgRoot.appendChild(el);
}
