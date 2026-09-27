# Haulotte PULSAR DTC — Program Management Cockpit & Roadmap

A clean, responsive internal web application built for the **Haulotte PULSAR DTC program** (Serial Life: *A Higher Standard, Less Diversity, More Value*), based on the program presentation and Excel planning model.

---

## 🚀 Quick Start

The application runs in two flexible modes:

### Mode A: Instant Standalone (Local Demonstration)
1. Double-click or open **`index.html`** in any modern web browser (Edge, Chrome, Brave, Firefox).
2. All progress updates, purchasing statuses, checklists, and snapshots are automatically persisted in your browser's `localStorage`.
3. Export full CSV reports or JSON backups at any time using the **Export ▼** menu.

### Mode B: Shared Team Workspace (Internal Network Server)
To share a single persistent database (`pulsar_data.json`) across your engineering, purchasing, and project teams:
1. Open PowerShell in this folder and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File server.ps1
   ```
2. The server starts on port `8080` (or `http://<machine-ip>:8080/`) and automatically launches your browser.
3. Any changes made by team members are saved directly to `pulsar_data.json` and synchronized in real time.

### 🌙 Dark Mode / Light Mode
- Click the **🌙 Dark Mode / ☀️ Light Mode** button in the header toolbar at any time.
- Preserves the authentic Haulotte brand identity (deep charcoal surfaces, luminous golden yellow `#FFC20E` accents, and crisp contrast).
- Automatically remembers your preference across browser sessions.

---

## 🧭 Application Structure & Pages

### 1. Dashboard
- **Where are we today?**
  - Independent **Mainstream Serial TR** and **Steering Serial TR** delivery cards with target vs. calculated forecast dates and working-day variance.
  - Overall progress by lane with reporting coverage (number of activities with confirmed progress vs. unassigned).
  - Target annual savings overview (€608,380 / year total across Routing, Steering, Inverter, Platform).
- **What changed since the previous review?**
  - **Save Weekly Snapshot** captures a formal milestone review and compares against the previous snapshot (progress gained, activities completed, dates moved, prototypes received, decisions closed).
- **What needs attention?**
  - Overdue or blocked activities highlighted in red/amber.
  - Purchasing alerts: prototypes awaiting delivery, unconfirmed sourcing decisions, or missing POs.
- **What controls delivery?**
  - Zero-float critical activities table showing the specific handoffs that govern Serial TR.

### 2. Integrated Roadmap (6 Lanes & 5 Milestone Stages)
- **6 Core Lanes (PPTX structure):**
  1. `Routing` (INI-110093)
  2. `Platform` (INI-108827)
  3. `Steering` (INI-109505) — *Integrated Narrow and Wide planning scope, preserving the physical sequence: chassis → pivots → cylinder & steering mechanism → hoses*
  4. `CAN 2 Inverter / P2 XS UCB` (INI-109883)
  5. `Test & Validation`
  6. `TPM / Purchasing`
- **5 Milestone Stages:**
  - Stage 1: Design reviews aligned
  - Stage 2: Prototype ready to order
  - Stage 3: Prototype available
  - Stage 4: Validation complete
  - Stage 5: Serial TR delivered (Independent endpoints: `MS-END` and `ST-END`)
- **Calendar & Gantt Controls:**
  - Mon–Fri working calendar view with week/month zoom.
  - Proportional activity fill bars (0–100%) and diamond milestone markers.
  - Interactive "Must follow" dependency editing with automatic cycle prevention.
  - Move Up / Move Down buttons for activity reordering.

### 3. Purchasing & Prototype Readiness
- Tracks all 16 prototype sets (including variant-specific parts for Narrow and Wide chassis, pivots, cylinders, and hoses).
- Statuses: **To confirm · Ready to order · Ordered · Part received · Received · On hold**.
- **Roadmap Synchronization:**
  - Updating expected delivery dates in Purchasing immediately updates linked Roadmap prototype gates (`PLT-M3`, `INV-M1`, `UCB-M1`, `SYS-M3`, `SYS-M5`, `SP-M1`, `ST-CH-AV`, `ST-PV-AV`, `ST-SM-AV`, `ST-CY-AV`, `ST-HO-AV`).
- **Accepted for Assembly/Test Checkbox:**
  - A partial delivery does not clear the milestone gate. Physical receipt and technical acceptance are tracked independently.

### 4. RAID & Decisions
- Single editable table preserving all 6 PPTX R&D risks (`R1`–`R6`) and 7 key technical decisions (`D1-N`, `D1-W`, `D2-N`, `D2-W`, `D3`, `D4`, `D5`, `D6`).
- Detail panel maintains the 5×5 Probability and Impact matrix scores without crowding the main view.

---

## ⚙️ Critical Path Method (CPM) Rules & Implementation

1. **Monday–Friday Calendar:** Automatically skips weekends. All durations and float values are measured in working days (wd).
2. **Finish-to-Start (FS) Dependencies:** Predecessors must finish before successors begin.
3. **Zero-Float Identification:** Activities with `Total Float ≤ 0` are highlighted as critical. Parallel critical paths are automatically detected.
4. **Contextual Impact Explanations:**
   - *"A delay here moves Mainstream Serial TR delivery."*
   - *"A delay here moves Steering Serial TR delivery."*
   - *"A delay here moves BOTH Mainstream and Steering Serial TR delivery."*
5. **Incomplete Inputs Guard:** If dates or durations are missing, the system displays **"Critical path incomplete"** and highlights the exact missing inputs, rather than mislabeling late tasks as critical.
6. **No Automated Guessing:** Remaining working days are prefilled from current expected finish and editable; effort is never artificially derived from progress percentage.

---

## 📊 File Architecture

```
PULSAR DTC/
├── index.html       # Single-Page Web Application UI (Haulotte branded)
├── styles.css       # Haulotte visual design (charcoal, yellow #FFC20E, green/amber/red)
├── app.js           # UI Controller, filter logic, snapshot engine, audit logging
├── cpm.js           # Mathematical Critical Path engine (Mon-Fri calendar, cycle detection)
├── data.js          # Initial program baseline data from PPTX & Excel
├── server.ps1       # Lightweight PowerShell HTTP server with persistent JSON API
└── README.md        # Documentation and operating guide
```

---

## 🔒 Shared Security & Audit Trail

- Every modification logs the user name, role, timestamp, field, old value, and new value.
- Click the **Environment Badge** in the top navigation to switch user identities or toggle between Local Mode and Shared Server Mode.
- No third-party runtime or npm dependencies required — runs completely on standard browser technologies and built-in Windows PowerShell.
