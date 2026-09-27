/**
 * Haulotte PULSAR DTC - Main Application Controller
 * Handles UI interactions, page navigation, modal forms,
 * CPM re-calculation, purchasing-roadmap sync, snapshot comparisons, and CSV export.
 */

(function () {
  'use strict';

  // ---------------- State Initialization ----------------

  const STORAGE_KEY = 'haulotte_pulsar_data_v1';
  let state = {
    settings: {},
    lanes: [],
    milestones: [],
    activities: [],
    prototypes: [],
    raid: [],
    history: [],
    snapshots: [],
    currentUser: {
      name: "Jean Dupont",
      role: "TPM / Program Manager"
    },
    isSharedServer: false,
    activeTab: "dashboard",
    zoomMode: "week", // 'week' or 'month'
    filters: {
      roadmapLane: "all",
      roadmapStream: "all",
      roadmapOwner: "all",
      roadmapSearch: "",
      roadmapCriticalOnly: false,
      roadmapBlockedOnly: false,
      purchasingStatus: "all",
      purchasingSearch: "",
      raidType: "all",
      raidSearch: ""
    }
  };

  let cpmResult = null;

  // Load persistent state
  function loadState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        state.settings = parsed.settings || INITIAL_PROGRAM_DATA.settings;
        state.lanes = parsed.lanes || INITIAL_PROGRAM_DATA.lanes;
        state.milestones = parsed.milestones || INITIAL_PROGRAM_DATA.milestones;
        state.activities = parsed.activities || INITIAL_PROGRAM_DATA.activities;
        state.prototypes = parsed.prototypes || INITIAL_PROGRAM_DATA.prototypes;
        state.raid = parsed.raid || INITIAL_PROGRAM_DATA.raid;
        state.history = parsed.history || [];
        state.snapshots = parsed.snapshots || [];
        if (parsed.currentUser) state.currentUser = parsed.currentUser;
      } else {
        resetToInitial();
      }
    } catch (e) {
      console.warn("Could not load from localStorage, initializing fresh data:", e);
      resetToInitial();
    }
  }

  function resetToInitial() {
    state.settings = JSON.parse(JSON.stringify(INITIAL_PROGRAM_DATA.settings));
    state.lanes = JSON.parse(JSON.stringify(INITIAL_PROGRAM_DATA.lanes));
    state.milestones = JSON.parse(JSON.stringify(INITIAL_PROGRAM_DATA.milestones));
    state.activities = JSON.parse(JSON.stringify(INITIAL_PROGRAM_DATA.activities));
    state.prototypes = JSON.parse(JSON.stringify(INITIAL_PROGRAM_DATA.prototypes));
    state.raid = JSON.parse(JSON.stringify(INITIAL_PROGRAM_DATA.raid));
    state.history = [];
    state.snapshots = [];
    saveState();
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        settings: state.settings,
        lanes: state.lanes,
        milestones: state.milestones,
        activities: state.activities,
        prototypes: state.prototypes,
        raid: state.raid,
        history: state.history,
        snapshots: state.snapshots,
        currentUser: state.currentUser
      }));

      // Try sending to local PowerShell API if available
      if (state.isSharedServer) {
        fetch('/api/data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state)
        }).catch(err => console.log("Shared server sync pending:", err));
      }
    } catch (e) {
      console.error("Error saving state:", e);
    }
  }

  // Check backend server presence
  async function checkServerConnection() {
    try {
      const resp = await fetch('/api/status', { method: 'GET' });
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === 'ok') {
          state.isSharedServer = true;
          updateEnvironmentBadge(true);
          return;
        }
      }
      updateEnvironmentBadge(false);
    } catch (e) {
      updateEnvironmentBadge(false);
    }
  }

  function updateEnvironmentBadge(isShared) {
    const badge = document.getElementById('env-badge');
    if (!badge) return;
    if (isShared) {
      badge.className = 'meta-badge environment-shared';
      badge.innerHTML = '<span class="dot"></span> Shared Workspace (Internal Server)';
    } else {
      badge.className = 'meta-badge environment-local';
      badge.innerHTML = '<span class="dot"></span> Local Mode (Browser Persistent)';
    }

    const userBadge = document.getElementById('user-profile-badge');
    if (userBadge) {
      userBadge.textContent = `${state.currentUser.name} (${state.currentUser.role})`;
    }
  }

  // ---------------- Audit & History Logging ----------------

  function logChange(category, entityId, entityTitle, field, oldValue, newValue) {
    const entry = {
      timestamp: new Date().toISOString(),
      user: state.currentUser.name,
      category,
      entityId,
      entityTitle,
      field,
      oldValue,
      newValue
    };
    state.history.unshift(entry);
    if (state.history.length > 250) {
      state.history.pop();
    }
  }

  // ---------------- Recalculate CPM Schedule ----------------

  function refreshSchedule() {
    // 1. Sync prototype delivery dates into roadmap milestones and lead time tasks
    state.prototypes.forEach(proto => {
      if (proto.roadmapMilestoneId) {
        const m = state.milestones.find(item => item.id === proto.roadmapMilestoneId);
        if (m && proto.expectedDeliveryDate) {
          m.date = proto.expectedDeliveryDate;
          if (proto.acceptedForAssembly && proto.status === 'Received') {
            m.achieved = true;
            m.actualAchievedDate = proto.receivedDate || proto.expectedDeliveryDate;
          } else {
            m.achieved = false;
            m.actualAchievedDate = null;
          }
        }
      }

      if (proto.roadmapTaskId) {
        const t = state.activities.find(item => item.id === proto.roadmapTaskId);
        if (t && proto.expectedDeliveryDate) {
          t.expectedFinishDate = proto.expectedDeliveryDate;
          if (t.startDate) {
            t.durationWd = Math.max(1, CPMEngine.countWorkingDays(t.startDate, t.expectedFinishDate));
          }
        }
      }
    });

    // 2. Run Critical Path Method calculation
    cpmResult = CPMEngine.calculateSchedule(state.activities, state.milestones, state.prototypes, state.settings);

    // 3. Render Views
    renderCurrentPage();
  }

  // ---------------- Page Navigation ----------------

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.page-section').forEach(sec => {
      sec.classList.toggle('active', sec.id === `page-${tabName}`);
    });
    renderCurrentPage();
  }

  function renderCurrentPage() {
    updateBadgesCounts();
    switch (state.activeTab) {
      case 'dashboard':
        renderDashboard();
        break;
      case 'roadmap':
        renderRoadmap();
        break;
      case 'purchasing':
        renderPurchasing();
        break;
      case 'raid':
        renderRAID();
        break;
    }
  }

  function updateBadgesCounts() {
    const criticalCount = state.activities.filter(a => {
      const node = cpmResult && cpmResult.nodeMap ? cpmResult.nodeMap.get(a.id) : null;
      return node && node.isCritical;
    }).length;

    const overduePurCount = state.prototypes.filter(p => {
      if (!p.expectedDeliveryDate) return true;
      if (p.status !== 'Received' && p.expectedDeliveryDate < state.settings.asOfDate) return true;
      return false;
    }).length;

    const openRaidCount = state.raid.filter(r => r.status === 'Open').length;

    const bRoadmap = document.getElementById('badge-count-roadmap');
    if (bRoadmap) bRoadmap.textContent = criticalCount > 0 ? `${criticalCount} crit` : state.activities.length;

    const bPurchasing = document.getElementById('badge-count-purchasing');
    if (bPurchasing) bPurchasing.textContent = overduePurCount > 0 ? `${overduePurCount} alert` : state.prototypes.length;

    const bRaid = document.getElementById('badge-count-raid');
    if (bRaid) bRaid.textContent = `${openRaidCount} open`;
  }

  // ==========================================================================
  // 1. DASHBOARD RENDERING
  // ==========================================================================

  function renderDashboard() {
    const container = document.getElementById('page-dashboard');
    if (!container || !cpmResult) return;

    // Check for incomplete CPM inputs banner
    const alertBox = document.getElementById('cpm-alert-banner');
    if (alertBox) {
      if (cpmResult.isIncomplete) {
        alertBox.style.display = 'flex';
        alertBox.className = 'alert-banner alert-warning';
        alertBox.innerHTML = `
          <div class="alert-content">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            <div>
              <strong>Critical path incomplete:</strong> Missing inputs found on ${cpmResult.missingInputs.length} item(s).
              <span style="font-size:12px; margin-left:8px;">${cpmResult.missingInputs.map(m => `[${m.id}] ${m.issue}`).slice(0, 3).join(', ')}${cpmResult.missingInputs.length > 3 ? '...' : ''}</span>
            </div>
          </div>
          <button class="btn btn-sm btn-secondary" onclick="app.showMissingInputsModal()">Review Missing Inputs</button>
        `;
      } else {
        alertBox.style.display = 'none';
      }
    }

    // Render Endpoint Delivery Cards
    const epMainstream = cpmResult.endpoints.mainstream;
    const epSteering = cpmResult.endpoints.steering;

    renderEndpointCard('mainstream-endpoint-card', epMainstream, "Mainstream Serial TR", "Routing + Platform + CAN 2 Inverter & System Software");
    renderEndpointCard('steering-endpoint-card', epSteering, "Steering Serial TR", "Narrow & Wide Steering Mechanics + Hydraulic Carry-Over Integration");

    // Compute Dashboard Metrics
    const totalActs = state.activities.length;
    const completedActs = state.activities.filter(a => a.progress === 100).length;
    const blockedActs = state.activities.filter(a => a.blocked).length;
    const lateActs = state.activities.filter(a => a.progress !== 100 && a.expectedFinishDate < state.settings.asOfDate).length;
    const criticalActs = state.activities.filter(a => {
      const node = cpmResult.nodeMap.get(a.id);
      return node && node.isCritical;
    }).length;

    const unconfirmedPurchasing = state.prototypes.filter(p => p.sourcingDecision === 'Unconfirmed' || !p.expectedDeliveryDate).length;
    const overduePurchasing = state.prototypes.filter(p => p.status !== 'Received' && p.expectedDeliveryDate && p.expectedDeliveryDate < state.settings.asOfDate).length;
    const openDecisions = state.raid.filter(r => r.type === 'Decision' && r.status === 'Open').length;

    // KPI Cards
    setKpiValue('kpi-critical-acts', criticalActs, `${criticalActs} tasks control Serial TR dates`, () => {
      state.filters.roadmapCriticalOnly = true;
      state.filters.roadmapBlockedOnly = false;
      switchTab('roadmap');
    });

    setKpiValue('kpi-late-blocked', `${lateActs} late / ${blockedActs} blocked`, "Requires immediate attention", () => {
      state.filters.roadmapBlockedOnly = true;
      state.filters.roadmapCriticalOnly = false;
      switchTab('roadmap');
    });

    setKpiValue('kpi-purchasing-alerts', `${overduePurchasing} overdue / ${unconfirmedPurchasing} unconfirmed`, "Prototypes awaiting order or delivery", () => {
      state.filters.purchasingStatus = "all";
      switchTab('purchasing');
    });

    setKpiValue('kpi-open-decisions', openDecisions, "R&D choices pending freeze", () => {
      state.filters.raidType = "Decision";
      switchTab('raid');
    });

    // Render Progress by Lane
    renderLaneProgressList();

    // Render Next Milestones list
    renderDashboardMilestones();

    // Render Critical Path activities list
    renderDashboardCriticalList();
  }

  function renderEndpointCard(elementId, ep, title, scopeSubtitle) {
    const el = document.getElementById(elementId);
    if (!el || !ep) return;

    const varianceWd = ep.varianceWd || 0;
    let varianceClass = "neutral";
    let varianceText = "On Target";

    if (varianceWd > 0) {
      varianceClass = "positive";
      varianceText = `+${varianceWd} wd delay`;
      el.className = 'delivery-endpoint-card delayed';
    } else if (varianceWd < 0) {
      varianceClass = "negative";
      varianceText = `${varianceWd} wd ahead`;
      el.className = 'delivery-endpoint-card on-track';
    } else {
      el.className = 'delivery-endpoint-card on-track';
    }

    el.innerHTML = `
      <div class="card-header-line">
        <span class="endpoint-stream-tag">${ep.name}</span>
        <span class="badge ${ep.isDelayed ? 'badge-red' : 'badge-green'}">${ep.isDelayed ? 'Variance Alert' : 'Aligned'}</span>
      </div>
      <div class="endpoint-title">${title}</div>
      <div class="dates-comparison-grid">
        <div class="date-box">
          <span class="date-label">Committed Baseline</span>
          <span class="date-val">${ep.targetDate || 'TBD'}</span>
        </div>
        <div class="date-box">
          <span class="date-label">Calculated Forecast</span>
          <span class="date-val" style="color: ${ep.isDelayed ? 'var(--status-red)' : 'var(--charcoal-900)'}">${ep.forecastDate || 'Incomplete'}</span>
        </div>
        <div class="date-box">
          <span class="date-label">Working Days Delta</span>
          <div class="variance-val ${varianceClass}">
            ${varianceWd > 0 ? '▲ ' : (varianceWd < 0 ? '▼ ' : '')}${varianceText}
          </div>
        </div>
      </div>
      <div class="endpoint-footer-note">${scopeSubtitle}</div>
    `;
  }

  function setKpiValue(id, value, metaText, onClick) {
    const card = document.getElementById(id);
    if (!card) return;
    const numEl = card.querySelector('.kpi-number');
    const metaEl = card.querySelector('.kpi-meta');
    if (numEl) numEl.textContent = value;
    if (metaEl) metaEl.textContent = metaText;
    card.onclick = onClick;
  }

  function renderLaneProgressList() {
    const list = document.getElementById('lane-progress-list');
    if (!list) return;

    list.innerHTML = state.lanes.map(lane => {
      const laneActs = state.activities.filter(a => a.lane === lane.id);
      const total = laneActs.length;
      const reported = laneActs.filter(a => a.progress !== null && a.progress !== undefined).length;
      const sumProgress = laneActs.reduce((acc, a) => acc + (a.progress || 0), 0);
      const avgProgress = reported > 0 ? Math.round(sumProgress / reported) : null;
      const coveragePct = total > 0 ? Math.round((reported / total) * 100) : 0;

      return `
        <div class="lane-progress-item" onclick="app.filterByLane('${lane.id}')">
          <div class="lane-row-top">
            <div class="lane-name-wrap">
              <span class="lane-code-pill">${lane.code}</span>
              <span>${lane.name}</span>
              ${lane.annualSavings > 0 ? `<span style="font-size:11px; color:#059669; font-weight:600;">(€${(lane.annualSavings).toLocaleString()}/yr)</span>` : ''}
            </div>
            <div style="font-weight:700;">
              ${avgProgress !== null ? `${avgProgress}%` : '<span style="color:var(--charcoal-400)">No data</span>'}
            </div>
          </div>
          <div class="lane-progress-bar-container">
            <div class="lane-progress-fill ${avgProgress === 100 ? 'complete' : ''}" style="width: ${avgProgress || 0}%"></div>
          </div>
          <div class="lane-reporting-sub">
            <span>Reporting Coverage: ${reported}/${total} activities (${coveragePct}%)</span>
            <span>Owner: ${lane.owner}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDashboardMilestones() {
    const list = document.getElementById('dashboard-next-milestones');
    if (!list) return;

    // Sort upcoming unachieved milestones by forecast/date
    const upcoming = state.milestones
      .filter(m => !m.achieved)
      .sort((a, b) => (a.date > b.date ? 1 : -1))
      .slice(0, 5);

    if (upcoming.length === 0) {
      list.innerHTML = `<div style="font-size:13px; color:var(--charcoal-500); padding:10px;">All program milestones achieved.</div>`;
      return;
    }

    list.innerHTML = upcoming.map(m => {
      const isPastDue = m.date < state.settings.asOfDate;
      return `
        <div class="attention-item" onclick="app.openMilestoneDetail('${m.id}')">
          <div class="attention-info">
            <span class="attention-title">${m.title}</span>
            <span class="attention-desc">${m.stage} · Owner: ${m.owner}</span>
          </div>
          <div style="text-align:right;">
            <div style="font-size:12px; font-weight:700; color: ${isPastDue ? 'var(--status-red)' : 'var(--charcoal-900)'}">
              ${m.date}
            </div>
            <span class="badge ${isPastDue ? 'badge-red' : 'badge-charcoal'}">${isPastDue ? 'Overdue' : 'Pending'}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDashboardCriticalList() {
    const list = document.getElementById('dashboard-critical-activities');
    if (!list) return;

    const criticalItems = state.activities.filter(a => {
      const node = cpmResult.nodeMap.get(a.id);
      return node && node.isCritical;
    }).slice(0, 5);

    if (criticalItems.length === 0) {
      list.innerHTML = `<div style="font-size:13px; color:var(--charcoal-500); padding:10px;">No zero-float critical activities currently identified.</div>`;
      return;
    }

    list.innerHTML = criticalItems.map(a => {
      const node = cpmResult.nodeMap.get(a.id);
      return `
        <div class="attention-item" onclick="app.editActivity('${a.id}')">
          <div class="attention-info">
            <span class="attention-title">[${a.id}] ${a.title}</span>
            <span class="attention-desc" style="color:var(--status-red); font-weight:600;">${node ? node.criticalExplanation : 'Critical item'}</span>
          </div>
          <div style="text-align:right;">
            <span class="badge badge-critical">Float: 0 wd</span>
            <div style="font-size:11px; color:var(--charcoal-500); margin-top:2px;">Due: ${a.expectedFinishDate}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================================================
  // 2. ROADMAP RENDERING (6 LANES, GANTT & CALENDAR)
  // ==========================================================================

  function renderRoadmap() {
    const container = document.getElementById('page-roadmap');
    if (!container || !cpmResult) return;

    // Filter controls sync
    const selLane = document.getElementById('filter-roadmap-lane');
    if (selLane) selLane.value = state.filters.roadmapLane;
    const selStream = document.getElementById('filter-roadmap-stream');
    if (selStream) selStream.value = state.filters.roadmapStream;

    const chkCrit = document.getElementById('chk-critical-only');
    if (chkCrit) chkCrit.checked = state.filters.roadmapCriticalOnly;

    const chkBlock = document.getElementById('chk-blocked-only');
    if (chkBlock) chkBlock.checked = state.filters.roadmapBlockedOnly;

    // Populate owners in filter
    const selOwner = document.getElementById('filter-roadmap-owner');
    if (selOwner) {
      const owners = Array.from(new Set(state.activities.map(a => a.owner).filter(Boolean)));
      selOwner.innerHTML = `<option value="all">All Owners</option>` + owners.map(o => `<option value="${o}">${o}</option>`).join('');
      selOwner.value = state.filters.roadmapOwner;
    }

    renderMilestoneStagesBanner();
    renderGanttBoard();
  }

  function renderMilestoneStagesBanner() {
    const banner = document.getElementById('milestone-stages-banner');
    if (!banner) return;

    const stages = [
      { id: 1, name: "Design reviews aligned", desc: "Routing, Platform, Inverter & Steering design acceptance" },
      { id: 2, name: "Prototype ready to order", desc: "Specifications & drawings released for PO placement" },
      { id: 3, name: "Prototype available", desc: "Electrical set, platform & steering bundle physically received" },
      { id: 4, name: "Validation complete", desc: "Integrated system testing & steering endurance closure" },
      { id: 5, name: "Serial TR delivered", desc: "Independent Mainstream & Steering technical releases" }
    ];

    banner.innerHTML = stages.map(st => {
      const stageMilestones = state.milestones.filter(m => m.stage && m.stage.includes(`Stage ${st.id}`));
      const total = stageMilestones.length;
      const achieved = stageMilestones.filter(m => m.achieved).length;
      const pct = total > 0 ? Math.round((achieved / total) * 100) : 0;

      return `
        <div class="stage-step-card ${pct === 100 ? 'stage-complete' : (pct > 0 ? 'active-stage' : '')}">
          <span class="stage-number">Stage ${st.id}</span>
          <span class="stage-name">${st.name}</span>
          <span class="stage-progress-text">${achieved}/${total} gates achieved (${pct}%)</span>
        </div>
      `;
    }).join('');
  }

  function renderGanttBoard() {
    const wrapper = document.getElementById('gantt-board-wrapper');
    if (!wrapper) return;

    // Determine calendar horizon (2026-09-28 to 2027-02-01)
    const calStart = CPMEngine.parseDate('2026-09-28');
    const calEnd = CPMEngine.parseDate('2027-01-25');
    const totalWorkingDays = CPMEngine.countWorkingDays('2026-09-28', '2027-01-25');
    const colWidthPx = state.zoomMode === 'week' ? 18 : 10;
    const timelineWidthPx = Math.max(900, totalWorkingDays * colWidthPx);

    // Build timeline dates list (Mon-Fri only)
    const workDaysList = [];
    let cur = new Date(calStart);
    while (cur <= calEnd) {
      if (!CPMEngine.isWeekend(cur)) {
        workDaysList.push(new Date(cur));
      }
      cur.setDate(cur.getDate() + 1);
    }

    // Build Month Headers
    const monthsMap = new Map();
    workDaysList.forEach((d, idx) => {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const name = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
      if (!monthsMap.has(key)) {
        monthsMap.set(key, { name, count: 0, startIndex: idx });
      }
      monthsMap.get(key).count++;
    });

    let monthsHtml = '';
    monthsMap.forEach(m => {
      const w = m.count * colWidthPx;
      monthsHtml += `<div class="gantt-month-cell" style="width:${w}px; min-width:${w}px;">${m.name}</div>`;
    });

    // Build Weeks Headers
    let weeksHtml = '';
    for (let i = 0; i < workDaysList.length; i += 5) {
      const daysCount = Math.min(5, workDaysList.length - i);
      const w = daysCount * colWidthPx;
      const d = workDaysList[i];
      const weekNum = getISOWeek(d);
      weeksHtml += `<div class="gantt-week-cell" style="width:${w}px; min-width:${w}px;">W${String(weekNum).padStart(2, '0')}</div>`;
    }

    // Calculate Today marker offset
    const todayStr = state.settings.asOfDate;
    let todayOffsetPx = -1;
    const todayIndex = workDaysList.findIndex(d => CPMEngine.formatDate(d) === todayStr);
    if (todayIndex >= 0) {
      todayOffsetPx = todayIndex * colWidthPx + Math.floor(colWidthPx / 2);
    }

    // Filter Activities
    let filteredActivities = state.activities.filter(act => {
      if (state.filters.roadmapLane !== 'all' && act.lane !== state.filters.roadmapLane) return false;
      if (state.filters.roadmapStream !== 'all' && act.stream !== state.filters.roadmapStream) return false;
      if (state.filters.roadmapOwner !== 'all' && act.owner !== state.filters.roadmapOwner) return false;
      if (state.filters.roadmapBlockedOnly && !act.blocked) return false;
      if (state.filters.roadmapCriticalOnly) {
        const node = cpmResult.nodeMap.get(act.id);
        if (!node || !node.isCritical) return false;
      }
      if (state.filters.roadmapSearch) {
        const q = state.filters.roadmapSearch.toLowerCase();
        return act.title.toLowerCase().includes(q) || act.id.toLowerCase().includes(q) || (act.initiative && act.initiative.toLowerCase().includes(q));
      }
      return true;
    });

    // Build Gantt Lanes and Rows
    let lanesHtml = '';
    state.lanes.forEach(lane => {
      // Check if this lane matches filter
      if (state.filters.roadmapLane !== 'all' && lane.id !== state.filters.roadmapLane) return;

      const laneActs = filteredActivities.filter(a => a.lane === lane.id);
      const laneMilestones = state.milestones.filter(m => m.lane === lane.id);

      if (laneActs.length === 0 && laneMilestones.length === 0) return;

      lanesHtml += `
        <div class="gantt-lane-group">
          <div class="gantt-lane-header">
            <span>${lane.name} &nbsp; <small style="color:var(--charcoal-500)">[${lane.initiative}]</small></span>
            <span style="font-size:12px; font-weight:600; color:var(--charcoal-600);">${lane.owner}</span>
          </div>
      `;

      // Render Activities in this lane
      laneActs.forEach((act, actIdx) => {
        const node = cpmResult.nodeMap.get(act.id) || act;
        const isCritical = node.isCritical;
        const startStr = node.forecastStart || act.startDate;
        const finishStr = node.forecastFinish || act.expectedFinishDate;

        // Calculate horizontal bar positioning
        const sIndex = workDaysList.findIndex(d => CPMEngine.formatDate(d) === startStr);
        const fIndex = workDaysList.findIndex(d => CPMEngine.formatDate(d) === finishStr);

        let leftPx = 0;
        let widthPx = 40;

        if (sIndex >= 0 && fIndex >= sIndex) {
          leftPx = sIndex * colWidthPx;
          widthPx = Math.max(colWidthPx, (fIndex - sIndex + 1) * colWidthPx);
        } else if (sIndex >= 0) {
          leftPx = sIndex * colWidthPx;
          widthPx = (act.durationWd || 1) * colWidthPx;
        }

        const progressVal = act.progress !== null && act.progress !== undefined ? `${act.progress}%` : '';
        const progressFill = act.progress || 0;

        lanesHtml += `
          <div class="gantt-row">
            <div class="gantt-row-info">
              <div class="row-title-wrap">
                <div style="display:flex; flex-direction:column; gap:2px; margin-right:4px;">
                  <button class="btn-sm btn-secondary" style="padding:1px 4px; font-size:9px; line-height:1;" onclick="app.moveActivity('${act.id}', 'up')" title="Move Up">▲</button>
                  <button class="btn-sm btn-secondary" style="padding:1px 4px; font-size:9px; line-height:1;" onclick="app.moveActivity('${act.id}', 'down')" title="Move Down">▼</button>
                </div>
                <span class="row-item-id">${act.id}</span>
                <span class="row-item-title" title="${act.title}" onclick="app.editActivity('${act.id}')">${act.title}</span>
              </div>
              <div class="row-badges">
                ${isCritical ? '<span class="badge badge-critical" title="Zero float: on critical path">Crit</span>' : ''}
                ${act.blocked ? '<span class="badge badge-red" title="Blocked">Blocked</span>' : ''}
                ${act.progress === 100 ? '<span class="badge badge-green">100%</span>' : (act.progress !== null ? `<span class="badge badge-charcoal">${act.progress}%</span>` : '')}
              </div>
            </div>
            <div class="gantt-row-timeline" style="width:${timelineWidthPx}px;">
              ${todayOffsetPx >= 0 ? `<div class="today-line" style="left:${todayOffsetPx}px;"></div>` : ''}
              
              <div class="activity-bar ${isCritical ? 'critical' : ''} ${act.blocked ? 'blocked' : ''}"
                   style="left:${leftPx}px; width:${widthPx}px;"
                   onclick="app.editActivity('${act.id}')"
                   onmouseenter="app.showTooltip(event, '${act.id}', 'activity')"
                   onmouseleave="app.hideTooltip()">
                <div class="activity-bar-fill ${act.progress === 100 ? 'complete' : ''}" style="width:${progressFill}%;"></div>
                <div class="activity-bar-label">${act.title} ${progressVal ? `(${progressVal})` : ''}</div>
              </div>
            </div>
          </div>
        `;
      });

      // Render Milestones in this lane
      laneMilestones.forEach(m => {
        const mDate = m.date;
        const mIndex = workDaysList.findIndex(d => CPMEngine.formatDate(d) === mDate);
        let mOffsetPx = mIndex >= 0 ? mIndex * colWidthPx + Math.floor(colWidthPx / 2) : 0;
        const node = cpmResult.nodeMap.get(m.id);
        const isCritical = node && node.isCritical;

        lanesHtml += `
          <div class="gantt-row">
            <div class="gantt-row-info">
              <div class="row-title-wrap">
                <span class="row-item-id">◆ ${m.id}</span>
                <span class="row-item-title" style="font-weight:700;" onclick="app.openMilestoneDetail('${m.id}')">${m.title}</span>
              </div>
              <div class="row-badges">
                <span class="badge ${m.achieved ? 'badge-green' : (m.date < state.settings.asOfDate ? 'badge-red' : 'badge-charcoal')}">
                  ${m.achieved ? 'Achieved' : (m.date < state.settings.asOfDate ? 'Overdue' : 'Target')}
                </span>
              </div>
            </div>
            <div class="gantt-row-timeline" style="width:${timelineWidthPx}px;">
              ${todayOffsetPx >= 0 ? `<div class="today-line" style="left:${todayOffsetPx}px;"></div>` : ''}
              
              <div class="milestone-marker ${m.achieved ? 'achieved' : ''} ${isCritical ? 'critical' : ''} ${m.isEndpoint ? 'endpoint' : ''}"
                   style="left:${mOffsetPx}px; top:50%;"
                   onclick="app.openMilestoneDetail('${m.id}')"
                   onmouseenter="app.showTooltip(event, '${m.id}', 'milestone')"
                   onmouseleave="app.hideTooltip()">
              </div>
            </div>
          </div>
        `;
      });

      lanesHtml += `</div>`;
    });

    wrapper.innerHTML = `
      <div class="gantt-calendar-header">
        <div class="gantt-sidebar-head">
          <span>Activity / Milestone</span>
          <span>Status</span>
        </div>
        <div class="gantt-timeline-head" style="width:${timelineWidthPx}px;">
          <div class="gantt-months-row">
            ${monthsHtml}
          </div>
          <div class="gantt-weeks-row" style="position:relative;">
            ${weeksHtml}
            ${todayOffsetPx >= 0 ? `
              <div class="today-line" style="left:${todayOffsetPx}px;">
                <div class="today-flag">Today (${todayStr})</div>
              </div>` : ''}
          </div>
        </div>
      </div>
      <div class="gantt-lanes-body">
        ${lanesHtml}
      </div>
    `;
  }

  function getISOWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  // ==========================================================================
  // 3. PURCHASING PAGE RENDERING
  // ==========================================================================

  function renderPurchasing() {
    const tbody = document.getElementById('purchasing-table-body');
    if (!tbody) return;

    let items = state.prototypes.filter(item => {
      if (state.filters.purchasingStatus !== 'all' && item.status !== state.filters.purchasingStatus) return false;
      if (state.filters.purchasingSearch) {
        const q = state.filters.purchasingSearch.toLowerCase();
        return item.partName.toLowerCase().includes(q) || item.supplier.toLowerCase().includes(q) || (item.poReference && item.poReference.toLowerCase().includes(q));
      }
      return true;
    });

    tbody.innerHTML = items.map(p => {
      const isMissingDate = !p.expectedDeliveryDate;
      const isOverdue = p.status !== 'Received' && p.expectedDeliveryDate && p.expectedDeliveryDate < state.settings.asOfDate;
      let rowClass = "";
      if (isOverdue) rowClass = "row-overdue";
      else if (isMissingDate) rowClass = "row-missing-date";

      let statusBadge = "badge-charcoal";
      if (p.status === 'Received') statusBadge = "badge-green";
      else if (p.status === 'Ordered') statusBadge = "badge-blue";
      else if (p.status === 'Ready to order') statusBadge = "badge-amber";
      else if (p.status === 'On hold') statusBadge = "badge-red";

      return `
        <tr class="${rowClass}">
          <td>
            <div class="table-part-name">${p.partName}</div>
            <span class="table-variant-badge">${p.variant}</span>
            <span style="font-size:11px; color:var(--charcoal-500); margin-left:4px;">[${p.initiative}]</span>
          </td>
          <td>
            <div>${p.supplier || '<span style="color:var(--charcoal-400)">TBD</span>'}</div>
            <div style="font-size:11px; color:var(--charcoal-500);">${p.owner}</div>
          </td>
          <td>
            <code>${p.poReference || '—'}</code>
          </td>
          <td>
            <span class="badge ${statusBadge}">${p.status}</span>
            ${p.sourcingDecision === 'Unconfirmed' ? '<span class="badge badge-amber" style="margin-left:4px;">Unconfirmed</span>' : ''}
          </td>
          <td>${p.orderPlacedDate || '—'}</td>
          <td>
            <div style="font-weight:700; color: ${isOverdue ? 'var(--status-red)' : 'var(--charcoal-900)'}">
              ${p.expectedDeliveryDate || '<span class="badge badge-amber">Missing Date</span>'}
            </div>
            <div style="font-size:10px; color:var(--charcoal-500);">
              ${p.dateType ? `(${p.dateType})` : ''}
            </div>
          </td>
          <td>${p.receivedDate || '—'}</td>
          <td style="text-align:center;">
            <input type="checkbox" class="custom-checkbox" ${p.acceptedForAssembly ? 'checked' : ''} onchange="app.togglePrototypeAccepted('${p.id}', this.checked)" title="Accepted for assembly/test">
          </td>
          <td style="max-width:260px; font-size:12px; color:var(--charcoal-600);">
            ${p.issueNote || '—'}
          </td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="app.editPrototype('${p.id}')">Edit</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================================================
  // 4. RAID & DECISIONS RENDERING
  // ==========================================================================

  function renderRAID() {
    const tbody = document.getElementById('raid-table-body');
    if (!tbody) return;

    let items = state.raid.filter(item => {
      if (state.filters.raidType !== 'all' && item.type !== state.filters.raidType) return false;
      if (state.filters.raidSearch) {
        const q = state.filters.raidSearch.toLowerCase();
        return item.id.toLowerCase().includes(q) || item.description.toLowerCase().includes(q) || item.owner.toLowerCase().includes(q);
      }
      return true;
    });

    tbody.innerHTML = items.map(r => {
      let scoreBadge = '';
      if (r.type === 'Risk') {
        const sc = r.score || (r.probability * r.impact);
        let scClass = 'score-low';
        if (sc >= 15) scClass = 'score-high';
        else if (sc >= 10) scClass = 'score-med';
        scoreBadge = `<span class="risk-matrix-score ${scClass}" title="P:${r.probability} × I:${r.impact}">Score: ${sc}</span>`;
      }

      return `
        <tr>
          <td>
            <strong>${r.id}</strong>
            <span class="badge ${r.type === 'Risk' ? 'badge-amber' : 'badge-blue'}" style="margin-left:4px;">${r.type}</span>
          </td>
          <td>
            <span class="badge badge-charcoal">${r.lane}</span>
          </td>
          <td style="max-width:300px;">
            <div style="font-weight:600; color:var(--charcoal-900);">${r.description}</div>
            ${r.consequence ? `<div style="font-size:11px; color:var(--charcoal-500); margin-top:2px;">Impact: ${r.consequence}</div>` : ''}
          </td>
          <td>${r.owner}</td>
          <td style="max-width:280px; font-size:12px;">${r.action}</td>
          <td>${r.dueDate || '—'}</td>
          <td>
            <span class="badge ${r.status === 'Closed' ? 'badge-green' : 'badge-amber'}">${r.status}</span>
          </td>
          <td>
            ${scoreBadge}
            ${r.decisionOutcome ? `<div style="font-size:11px; font-weight:600; color:#047857; margin-top:4px;">${r.decisionOutcome}</div>` : ''}
          </td>
          <td>
            <button class="btn btn-sm btn-secondary" onclick="app.editRaid('${r.id}')">Detail</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ==========================================================================
  // MODALS & FORMS
  // ==========================================================================

  // --- Add Activity Modal ---
  function openAddActivityModal() {
    const modal = document.getElementById('modal-edit-activity');
    if (!modal) return;

    // Generate new unique ID
    const maxIndex = state.activities.length + 1;
    const newId = `ACT-${String(maxIndex).padStart(2, '0')}`;

    document.getElementById('edit-act-id').value = newId;
    document.getElementById('edit-act-title').value = '';
    document.getElementById('edit-act-initiative').value = 'INI-109883';
    document.getElementById('edit-act-lane').value = 'routing';
    document.getElementById('edit-act-owner').value = state.currentUser.name;
    document.getElementById('edit-act-start').value = state.settings.asOfDate;
    document.getElementById('edit-act-finish').value = CPMEngine.formatDate(CPMEngine.addWorkingDays(CPMEngine.parseDate(state.settings.asOfDate), 5));
    document.getElementById('edit-act-duration').value = 5;
    document.getElementById('edit-act-remaining').value = 5;
    document.getElementById('edit-act-progress').value = '';
    document.getElementById('edit-act-completed-date').value = '';
    document.getElementById('edit-act-blocked').checked = false;
    document.getElementById('edit-act-nextaction').value = '';

    renderPredecessorsCheckboxes(newId, []);
    renderModalChecklist({ checklist: [] });
    updateLiveCpmPreview(newId);

    modal.classList.add('show');
  }

  // --- Edit Activity Modal ---
  function editActivity(actId) {
    const act = state.activities.find(a => a.id === actId);
    if (!act) return;

    const modal = document.getElementById('modal-edit-activity');
    if (!modal) return;

    // Prefill form fields
    document.getElementById('edit-act-id').value = act.id;
    document.getElementById('edit-act-title').value = act.title;
    document.getElementById('edit-act-initiative').value = act.initiative || '';
    document.getElementById('edit-act-lane').value = act.lane;
    document.getElementById('edit-act-owner').value = act.owner || '';
    document.getElementById('edit-act-start').value = act.startDate || '';
    document.getElementById('edit-act-finish').value = act.expectedFinishDate || '';
    document.getElementById('edit-act-duration').value = act.durationWd || 1;
    document.getElementById('edit-act-remaining').value = act.remainingWd !== null ? act.remainingWd : '';
    document.getElementById('edit-act-progress').value = act.progress !== null && act.progress !== undefined ? act.progress : '';
    document.getElementById('edit-act-completed-date').value = act.completedDate || '';
    document.getElementById('edit-act-blocked').checked = !!act.blocked;
    document.getElementById('edit-act-nextaction').value = act.nextAction || '';

    // Populate Predecessors ("Must follow" selector with search & cycle prevention)
    renderPredecessorsCheckboxes(act.id, act.predecessors || []);

    // Populate Checklist
    renderModalChecklist(act);

    // Live CPM Preview
    updateLiveCpmPreview(act.id);

    // Show modal
    modal.classList.add('show');
  }

  function renderPredecessorsCheckboxes(currentActId, selectedPreds) {
    const predContainer = document.getElementById('edit-act-predecessors-container');
    if (!predContainer) return;

    const availableNodes = [...state.activities, ...state.milestones].filter(n => n.id !== currentActId);

    let predHtml = `
      <div style="margin-bottom:6px;">
        <input type="text" id="pred-search-input" class="search-input" placeholder="Filter prerequisites..." style="width:100%; padding:4px 8px; font-size:12px;" oninput="app.filterPredList(this.value)">
      </div>
      <div id="pred-checkboxes-list">
    `;

    availableNodes.forEach(node => {
      const isSelected = Array.isArray(selectedPreds) && selectedPreds.includes(node.id);
      // Check if selecting this would create a cycle
      const causesCycle = CPMEngine.checkCircularDependency(state.activities, node.id, currentActId);

      predHtml += `
        <label class="pred-item-label" data-text="${node.id} ${node.title}" style="display:flex; align-items:center; gap:8px; font-size:12px; padding:3px 0; ${causesCycle ? 'opacity:0.4; cursor:not-allowed;' : ''}">
          <input type="checkbox" name="pred-check" value="${node.id}" ${isSelected ? 'checked' : ''} ${causesCycle ? 'disabled' : ''}>
          <span><strong>[${node.id}]</strong> ${node.title} ${causesCycle ? '<span style="color:var(--status-red);">(Circular Link Blocked)</span>' : ''}</span>
        </label>
      `;
    });
    predHtml += `</div>`;
    predContainer.innerHTML = predHtml;
  }

  function filterPredList(query) {
    const list = document.getElementById('pred-checkboxes-list');
    if (!list) return;
    const q = query.toLowerCase();
    list.querySelectorAll('.pred-item-label').forEach(label => {
      const text = label.dataset.text.toLowerCase();
      label.style.display = text.includes(q) ? 'flex' : 'none';
    });
  }

  function renderModalChecklist(act) {
    const list = document.getElementById('edit-act-checklist-items');
    if (!list) return;
    const items = act.checklist || [];

    list.innerHTML = items.map((it, idx) => `
      <div class="checklist-item-row">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" ${it.done ? 'checked' : ''} onchange="app.toggleChecklistItem('${act.id}', ${idx}, this.checked)">
          <span style="${it.done ? 'text-decoration:line-through; color:var(--charcoal-500);' : ''}">${it.text}</span>
        </label>
        <button type="button" class="btn btn-sm btn-secondary" onclick="app.removeChecklistItem('${act.id}', ${idx})">✕</button>
      </div>
    `).join('');
  }

  function updateLiveCpmPreview(actId) {
    const callout = document.getElementById('edit-act-impact-preview');
    if (!callout) return;
    const node = cpmResult && cpmResult.nodeMap ? cpmResult.nodeMap.get(actId) : null;

    if (node && node.isCritical) {
      callout.className = 'impact-preview-callout critical';
      callout.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <div>
          <strong>Critical Path Impact:</strong> ${node.criticalExplanation}
        </div>
      `;
    } else if (node && node.totalFloat !== null) {
      callout.className = 'impact-preview-callout normal';
      callout.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
        <div>
          <strong>Non-critical:</strong> Has <strong>${node.totalFloat} working days</strong> of float before shifting Serial TR.
        </div>
      `;
    } else {
      callout.className = 'impact-preview-callout normal';
      callout.innerHTML = `<div>No critical delivery dependency identified.</div>`;
    }
  }

  function saveActivityModal() {
    const actId = document.getElementById('edit-act-id').value;
    let act = state.activities.find(a => a.id === actId);
    let isNew = false;

    if (!act) {
      isNew = true;
      act = {
        id: actId,
        checklist: []
      };
      state.activities.push(act);
    }

    const oldProgress = act.progress;
    const oldFinish = act.expectedFinishDate;

    act.title = document.getElementById('edit-act-title').value.trim();
    act.initiative = document.getElementById('edit-act-initiative').value.trim();
    act.lane = document.getElementById('edit-act-lane').value;
    act.stream = act.lane === 'steering' ? 'Steering' : 'Mainstream';
    act.owner = document.getElementById('edit-act-owner').value.trim();
    act.startDate = document.getElementById('edit-act-start').value;
    act.expectedFinishDate = document.getElementById('edit-act-finish').value;
    act.durationWd = parseInt(document.getElementById('edit-act-duration').value, 10) || 1;
    
    const remVal = document.getElementById('edit-act-remaining').value;
    act.remainingWd = remVal !== '' ? parseInt(remVal, 10) : null;

    const progInput = document.getElementById('edit-act-progress').value;
    act.progress = progInput !== '' ? Math.min(100, Math.max(0, parseInt(progInput, 10))) : null;

    // Automatic completion date handling per requirements
    if (act.progress === 100 && oldProgress !== 100) {
      const declaredCompleted = document.getElementById('edit-act-completed-date').value;
      act.completedDate = declaredCompleted || state.settings.asOfDate;
    } else if (act.progress !== 100) {
      act.completedDate = null;
    }

    act.blocked = document.getElementById('edit-act-blocked').checked;
    act.nextAction = document.getElementById('edit-act-nextaction').value.trim();

    // Read selected predecessors
    const checkedPreds = [];
    document.querySelectorAll('#edit-act-predecessors-container input[name="pred-check"]:checked').forEach(cb => {
      checkedPreds.push(cb.value);
    });
    act.predecessors = checkedPreds;

    // Log changes to audit history
    if (isNew) {
      logChange("Activity", act.id, act.title, "Created", "N/A", "Active");
    } else {
      if (oldProgress !== act.progress) {
        logChange("Activity", act.id, act.title, "Progress", `${oldProgress !== null ? oldProgress : 'Unknown'}%`, `${act.progress !== null ? act.progress : 'Unknown'}%`);
      }
      if (oldFinish !== act.expectedFinishDate) {
        logChange("Activity", act.id, act.title, "Expected Finish", oldFinish, act.expectedFinishDate);
      }
    }

    saveState();
    closeModal('modal-edit-activity');
    refreshSchedule();
  }

  // --- Move Activity Up / Down within Lane ---
  function moveActivity(actId, direction) {
    const act = state.activities.find(a => a.id === actId);
    if (!act) return;

    const laneActs = state.activities.filter(a => a.lane === act.lane);
    const indexInLane = laneActs.findIndex(a => a.id === actId);

    if (direction === 'up' && indexInLane > 0) {
      const targetAct = laneActs[indexInLane - 1];
      swapActivities(act, targetAct);
    } else if (direction === 'down' && indexInLane < laneActs.length - 1) {
      const targetAct = laneActs[indexInLane + 1];
      swapActivities(act, targetAct);
    }
  }

  function swapActivities(act1, act2) {
    const idx1 = state.activities.indexOf(act1);
    const idx2 = state.activities.indexOf(act2);
    if (idx1 >= 0 && idx2 >= 0) {
      state.activities[idx1] = act2;
      state.activities[idx2] = act1;
      saveState();
      renderRoadmap();
    }
  }

  // --- Edit Prototype Modal ---
  function editPrototype(protoId) {
    const proto = state.prototypes.find(p => p.id === protoId);
    if (!proto) return;

    const modal = document.getElementById('modal-edit-prototype');
    if (!modal) return;

    document.getElementById('edit-proto-id').value = proto.id;
    document.getElementById('edit-proto-partname').value = proto.partName;
    document.getElementById('edit-proto-variant').value = proto.variant;
    document.getElementById('edit-proto-supplier').value = proto.supplier || '';
    document.getElementById('edit-proto-owner').value = proto.owner;
    document.getElementById('edit-proto-poref').value = proto.poReference || '';
    document.getElementById('edit-proto-status').value = proto.status;
    document.getElementById('edit-proto-orderdate').value = proto.orderPlacedDate || '';
    document.getElementById('edit-proto-deliverydate').value = proto.expectedDeliveryDate || '';
    document.getElementById('edit-proto-datetype').value = proto.dateType || 'Estimated';
    document.getElementById('edit-proto-receiveddate').value = proto.receivedDate || '';
    document.getElementById('edit-proto-accepted').checked = !!proto.acceptedForAssembly;
    document.getElementById('edit-proto-issuenote').value = proto.issueNote || '';

    modal.classList.add('show');
  }

  function savePrototypeModal() {
    const protoId = document.getElementById('edit-proto-id').value;
    const proto = state.prototypes.find(p => p.id === protoId);
    if (!proto) return;

    const oldDelivery = proto.expectedDeliveryDate;
    const oldStatus = proto.status;

    proto.supplier = document.getElementById('edit-proto-supplier').value.trim();
    proto.owner = document.getElementById('edit-proto-owner').value.trim();
    proto.poReference = document.getElementById('edit-proto-poref').value.trim();
    proto.status = document.getElementById('edit-proto-status').value;
    proto.orderPlacedDate = document.getElementById('edit-proto-orderdate').value || null;
    proto.expectedDeliveryDate = document.getElementById('edit-proto-deliverydate').value || null;
    proto.dateType = document.getElementById('edit-proto-datetype').value;
    proto.receivedDate = document.getElementById('edit-proto-receiveddate').value || null;
    proto.acceptedForAssembly = document.getElementById('edit-proto-accepted').checked;
    proto.issueNote = document.getElementById('edit-proto-issuenote').value.trim();

    // Log changes
    if (oldDelivery !== proto.expectedDeliveryDate) {
      logChange("Purchasing", proto.id, proto.partName, "Expected Delivery", oldDelivery, proto.expectedDeliveryDate);
    }
    if (oldStatus !== proto.status) {
      logChange("Purchasing", proto.id, proto.partName, "Status", oldStatus, proto.status);
    }

    saveState();
    closeModal('modal-edit-prototype');
    refreshSchedule();
  }

  function togglePrototypeAccepted(protoId, isAccepted) {
    const proto = state.prototypes.find(p => p.id === protoId);
    if (proto) {
      proto.acceptedForAssembly = isAccepted;
      logChange("Purchasing", proto.id, proto.partName, "Accepted for Assembly", !isAccepted, isAccepted);
      saveState();
      refreshSchedule();
    }
  }

  // --- Edit RAID Modal ---
  function editRaid(raidId) {
    const item = state.raid.find(r => r.id === raidId);
    if (!item) return;

    const modal = document.getElementById('modal-edit-raid');
    if (!modal) return;

    document.getElementById('edit-raid-id').value = item.id;
    document.getElementById('edit-raid-type').value = item.type;
    document.getElementById('edit-raid-lane').value = item.lane;
    document.getElementById('edit-raid-owner').value = item.owner;
    document.getElementById('edit-raid-desc').value = item.description;
    document.getElementById('edit-raid-consequence').value = item.consequence || '';
    document.getElementById('edit-raid-action').value = item.action;
    document.getElementById('edit-raid-duedate').value = item.dueDate || '';
    document.getElementById('edit-raid-status').value = item.status;
    document.getElementById('edit-raid-outcome').value = item.decisionOutcome || '';
    
    // Probability / Impact score
    const pGroup = document.getElementById('edit-raid-pi-group');
    if (item.type === 'Risk') {
      pGroup.style.display = 'grid';
      document.getElementById('edit-raid-prob').value = item.probability || 3;
      document.getElementById('edit-raid-impact').value = item.impact || 3;
    } else {
      pGroup.style.display = 'none';
    }

    modal.classList.add('show');
  }

  function saveRaidModal() {
    const raidId = document.getElementById('edit-raid-id').value;
    const item = state.raid.find(r => r.id === raidId);
    if (!item) return;

    const oldStatus = item.status;

    item.owner = document.getElementById('edit-raid-owner').value.trim();
    item.description = document.getElementById('edit-raid-desc').value.trim();
    item.consequence = document.getElementById('edit-raid-consequence').value.trim();
    item.action = document.getElementById('edit-raid-action').value.trim();
    item.dueDate = document.getElementById('edit-raid-duedate').value || null;
    item.status = document.getElementById('edit-raid-status').value;
    item.decisionOutcome = document.getElementById('edit-raid-outcome').value.trim();

    if (item.type === 'Risk') {
      item.probability = parseInt(document.getElementById('edit-raid-prob').value, 10) || 1;
      item.impact = parseInt(document.getElementById('edit-raid-impact').value, 10) || 1;
      item.score = item.probability * item.impact;
    }

    if (oldStatus !== item.status) {
      logChange("RAID", item.id, item.description, "Status", oldStatus, item.status);
    }

    saveState();
    closeModal('modal-edit-raid');
    renderRAID();
    updateBadgesCounts();
  }

  // --- Weekly Snapshot Engine ---

  function saveWeeklySnapshot() {
    const snapId = `SNAP-${CPMEngine.formatDate(new Date())}-${Date.now().toString().slice(-4)}`;
    const snapshot = {
      id: snapId,
      createdDate: CPMEngine.formatDate(new Date()),
      createdBy: state.currentUser.name,
      activities: JSON.parse(JSON.stringify(state.activities)),
      prototypes: JSON.parse(JSON.stringify(state.prototypes)),
      raid: JSON.parse(JSON.stringify(state.raid)),
      endpoints: JSON.parse(JSON.stringify(cpmResult.endpoints))
    };

    state.snapshots.push(snapshot);
    logChange("System", snapId, "Weekly Review Snapshot", "Created", "N/A", "Active");
    saveState();

    // Show Comparison with previous snapshot
    showSnapshotComparison(snapshot);
  }

  function showSnapshotComparison(latestSnap) {
    const modal = document.getElementById('modal-snapshot-comparison');
    if (!modal) return;

    const prevSnap = state.snapshots.length > 1 ? state.snapshots[state.snapshots.length - 2] : null;

    let progressGained = [];
    let completedActs = [];
    let movedDates = [];
    let prototypesReceived = [];
    let decisionsClosed = [];

    if (prevSnap) {
      // 1. Check progress gained & completed activities
      latestSnap.activities.forEach(currA => {
        const prevA = prevSnap.activities.find(a => a.id === currA.id);
        if (prevA) {
          if (currA.progress !== prevA.progress) {
            progressGained.push(`[${currA.id}] ${currA.title}: ${prevA.progress !== null ? prevA.progress : 'blank'}% → ${currA.progress !== null ? currA.progress : 'blank'}%`);
          }
          if (currA.progress === 100 && prevA.progress !== 100) {
            completedActs.push(`[${currA.id}] ${currA.title}`);
          }
          if (currA.expectedFinishDate !== prevA.expectedFinishDate) {
            movedDates.push(`[${currA.id}] ${currA.title}: ${prevA.expectedFinishDate} → ${currA.expectedFinishDate}`);
          }
        }
      });

      // 2. Prototypes received
      latestSnap.prototypes.forEach(currP => {
        const prevP = prevSnap.prototypes.find(p => p.id === currP.id);
        if (prevP && currP.status === 'Received' && prevP.status !== 'Received') {
          prototypesReceived.push(`[${currP.partName} (${currP.variant})] received on ${currP.receivedDate || 'today'}`);
        }
      });

      // 3. Decisions closed
      latestSnap.raid.forEach(currR => {
        const prevR = prevSnap.raid.find(r => r.id === currR.id);
        if (prevR && currR.status === 'Closed' && prevR.status !== 'Closed') {
          decisionsClosed.push(`[${currR.id}] ${currR.description}`);
        }
      });
    }

    const body = document.getElementById('snapshot-comparison-body');
    body.innerHTML = `
      <div style="margin-bottom:16px;">
        <h4>Weekly Snapshot: ${latestSnap.id}</h4>
        <span style="font-size:12px; color:var(--charcoal-500);">Recorded on ${latestSnap.createdDate} by ${latestSnap.createdBy}</span>
      </div>

      ${!prevSnap ? '<div class="alert-banner alert-warning">First weekly snapshot recorded. Subsequent snapshots will compute progress gains and deltas automatically.</div>' : ''}

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <div class="panel-card">
          <h4 style="font-size:14px; margin-bottom:8px; color:var(--status-green);">✔ Activities Completed (${completedActs.length})</h4>
          <ul style="font-size:12px; padding-left:18px;">
            ${completedActs.length > 0 ? completedActs.map(c => `<li>${c}</li>`).join('') : '<li style="color:var(--charcoal-400)">None</li>'}
          </ul>

          <h4 style="font-size:14px; margin:16px 0 8px 0; color:var(--haulotte-yellow-hover);">📈 Progress Gained (${progressGained.length})</h4>
          <ul style="font-size:12px; padding-left:18px;">
            ${progressGained.length > 0 ? progressGained.map(p => `<li>${p}</li>`).join('') : '<li style="color:var(--charcoal-400)">No progress changes</li>'}
          </ul>
        </div>

        <div class="panel-card">
          <h4 style="font-size:14px; margin-bottom:8px; color:var(--status-blue);">📦 Prototypes Received (${prototypesReceived.length})</h4>
          <ul style="font-size:12px; padding-left:18px;">
            ${prototypesReceived.length > 0 ? prototypesReceived.map(p => `<li>${p}</li>`).join('') : '<li style="color:var(--charcoal-400)">None</li>'}
          </ul>

          <h4 style="font-size:14px; margin:16px 0 8px 0; color:var(--charcoal-700);">⚖ Decisions Closed (${decisionsClosed.length})</h4>
          <ul style="font-size:12px; padding-left:18px;">
            ${decisionsClosed.length > 0 ? decisionsClosed.map(d => `<li>${d}</li>`).join('') : '<li style="color:var(--charcoal-400)">None</li>'}
          </ul>

          <h4 style="font-size:14px; margin:16px 0 8px 0; color:var(--status-red);">📅 Dates Moved (${movedDates.length})</h4>
          <ul style="font-size:12px; padding-left:18px;">
            ${movedDates.length > 0 ? movedDates.map(m => `<li>${m}</li>`).join('') : '<li style="color:var(--charcoal-400)">No date shifts</li>'}
          </ul>
        </div>
      </div>
    `;

    modal.classList.add('show');
  }

  // --- Profile / Authentication Modal ---
  function openProfileModal() {
    const modal = document.getElementById('modal-user-profile');
    if (!modal) return;
    document.getElementById('user-name-input').value = state.currentUser.name;
    document.getElementById('user-role-input').value = state.currentUser.role;
    document.getElementById('storage-mode-select').value = state.isSharedServer ? 'shared' : 'local';
    modal.classList.add('show');
  }

  function saveProfileModal() {
    state.currentUser.name = document.getElementById('user-name-input').value.trim() || "User";
    state.currentUser.role = document.getElementById('user-role-input').value;
    const mode = document.getElementById('storage-mode-select').value;
    state.isSharedServer = (mode === 'shared');
    updateEnvironmentBadge(state.isSharedServer);
    saveState();
    closeModal('modal-user-profile');
  }

  // --- CSV / Excel Export ---

  function exportCSV(category) {
    let csvContent = "";
    let filename = `Haulotte_PULSAR_DTC_${category}_${CPMEngine.formatDate(new Date())}.csv`;

    if (category === 'roadmap') {
      csvContent += "ID,Lane,Initiative,Title,Owner,Start Date,Expected Finish,Duration (wd),Remaining (wd),Progress (%),Blocked,Critical Path,Total Float,Must Follow Predecessors,Next Action\n";
      state.activities.forEach(a => {
        const node = cpmResult.nodeMap.get(a.id);
        const isCrit = node && node.isCritical ? "Yes" : "No";
        const floatVal = node && node.totalFloat !== null ? node.totalFloat : "";
        const preds = (a.predecessors || []).join('; ');
        csvContent += `"${a.id}","${a.lane}","${a.initiative}","${escapeCsv(a.title)}","${a.owner}","${a.startDate}","${a.expectedFinishDate}","${a.durationWd || ''}","${a.remainingWd !== null ? a.remainingWd : ''}","${a.progress !== null ? a.progress : ''}","${a.blocked ? 'Yes' : 'No'}","${isCrit}","${floatVal}","${preds}","${escapeCsv(a.nextAction || '')}"\n`;
      });
    } else if (category === 'purchasing') {
      csvContent += "ID,Part Name,Variant,Initiative,Supplier,Owner,PO Reference,Status,Order Date,Expected Delivery,Date Type,Received Date,Accepted for Assembly,Issue / Next Action\n";
      state.prototypes.forEach(p => {
        csvContent += `"${p.id}","${escapeCsv(p.partName)}","${p.variant}","${p.initiative}","${escapeCsv(p.supplier || '')}","${p.owner}","${p.poReference || ''}","${p.status}","${p.orderPlacedDate || ''}","${p.expectedDeliveryDate || ''}","${p.dateType || ''}","${p.receivedDate || ''}","${p.acceptedForAssembly ? 'Yes' : 'No'}","${escapeCsv(p.issueNote || '')}"\n`;
      });
    } else if (category === 'raid') {
      csvContent += "ID,Type,Lane,Description,Consequence,Owner,Action,Due Date,Status,Score,Decision Outcome\n";
      state.raid.forEach(r => {
        csvContent += `"${r.id}","${r.type}","${r.lane}","${escapeCsv(r.description)}","${escapeCsv(r.consequence || '')}","${r.owner}","${escapeCsv(r.action)}","${r.dueDate || ''}","${r.status}","${r.score || ''}","${escapeCsv(r.decisionOutcome || '')}"\n`;
      });
    }

    downloadBlob(csvContent, filename, 'text/csv;charset=utf-8;');
  }

  function exportJSONBackup() {
    const dataStr = JSON.stringify(state, null, 2);
    downloadBlob(dataStr, `Haulotte_PULSAR_DTC_Backup_${CPMEngine.formatDate(new Date())}.json`, 'application/json');
  }

  function escapeCsv(str) {
    return (str || '').replace(/"/g, '""');
  }

  function downloadBlob(content, filename, contentType) {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // --- Tooltip & Modals Utility ---

  function showTooltip(e, itemId, type) {
    const tip = document.getElementById('cpm-tooltip');
    if (!tip) return;

    let content = "";
    if (type === 'activity') {
      const act = state.activities.find(a => a.id === itemId);
      const node = cpmResult.nodeMap.get(itemId);
      if (!act) return;
      content = `
        <strong>[${act.id}] ${act.title}</strong><br/>
        <span>Owner: ${act.owner}</span><br/>
        <span>Duration: ${act.durationWd} wd | Progress: ${act.progress !== null ? `${act.progress}%` : 'Unknown'}</span><br/>
        <div style="margin-top:4px; color:${node && node.isCritical ? '#F87171' : '#FDE68A'};">
          ${node ? node.criticalExplanation : ''}
        </div>
      `;
    } else {
      const m = state.milestones.find(item => item.id === itemId);
      if (!m) return;
      content = `
        <strong>◆ ${m.title}</strong><br/>
        <span>Stage: ${m.stage}</span><br/>
        <span>Date: ${m.date} (${m.achieved ? 'Achieved' : 'Pending'})</span><br/>
        <span style="font-size:10px; color:#CBD5E1;">${m.notes || ''}</span>
      `;
    }

    tip.innerHTML = content;
    tip.style.left = `${e.pageX + 12}px`;
    tip.style.top = `${e.pageY + 12}px`;
    tip.style.display = 'block';
  }

  function hideTooltip() {
    const tip = document.getElementById('cpm-tooltip');
    if (tip) tip.style.display = 'none';
  }

  function closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('show');
  }

  // --- Milestone Detail Modal ---
  function openMilestoneDetail(milestoneId) {
    const m = state.milestones.find(item => item.id === milestoneId);
    if (!m) return;

    const modal = document.getElementById('modal-milestone-detail');
    if (!modal) return;

    document.getElementById('m-detail-id').textContent = m.id;
    document.getElementById('m-detail-title').textContent = m.title;
    document.getElementById('m-detail-stage').textContent = m.stage;
    document.getElementById('m-detail-owner').textContent = m.owner;
    document.getElementById('m-detail-date').textContent = m.date;
    document.getElementById('m-detail-baseline').textContent = m.baselineDate || 'N/A';
    document.getElementById('m-detail-status').textContent = m.achieved ? 'Achieved' : 'Pending';
    document.getElementById('m-detail-notes').textContent = m.notes || 'None';

    const toggleBtn = document.getElementById('m-detail-toggle-achieved');
    if (toggleBtn) {
      toggleBtn.textContent = m.achieved ? 'Mark as Incomplete' : 'Confirm Gate Achieved';
      toggleBtn.className = m.achieved ? 'btn btn-secondary' : 'btn btn-primary';
      toggleBtn.onclick = () => {
        m.achieved = !m.achieved;
        m.actualAchievedDate = m.achieved ? state.settings.asOfDate : null;
        logChange("Milestone", m.id, m.title, "Achieved", !m.achieved, m.achieved);
        saveState();
        closeModal('modal-milestone-detail');
        refreshSchedule();
      };
    }

    modal.classList.add('show');
  }

  // Public Interface for Inline HTML Event Listeners
  window.app = {
    init: function () {
      loadState();
      checkServerConnection();
      refreshSchedule();
      setupEventListeners();
    },
    switchTab,
    openAddActivityModal,
    editActivity,
    moveActivity,
    saveActivityModal,
    filterPredList,
    editPrototype,
    savePrototypeModal,
    togglePrototypeAccepted,
    editRaid,
    saveRaidModal,
    openMilestoneDetail,
    saveWeeklySnapshot,
    openProfileModal,
    saveProfileModal,
    exportCSV,
    exportJSONBackup,
    showTooltip,
    hideTooltip,
    closeModal,
    filterCriticalOnly: function (isCritical) {
      state.filters.roadmapCriticalOnly = isCritical;
      renderRoadmap();
    },
    filterBlockedOnly: function (isBlocked) {
      state.filters.roadmapBlockedOnly = isBlocked;
      renderRoadmap();
    },
    filterByLane: function (laneId) {
      state.filters.roadmapLane = laneId;
      switchTab('roadmap');
    },
    toggleChecklistItem: function (actId, idx, isDone) {
      const act = state.activities.find(a => a.id === actId);
      if (act && act.checklist && act.checklist[idx]) {
        act.checklist[idx].done = isDone;
        saveState();
      }
    },
    removeChecklistItem: function (actId, idx) {
      const act = state.activities.find(a => a.id === actId);
      if (act && act.checklist) {
        act.checklist.splice(idx, 1);
        renderModalChecklist(act);
        saveState();
      }
    },
    addChecklistItem: function () {
      const actId = document.getElementById('edit-act-id').value;
      const act = state.activities.find(a => a.id === actId);
      const textInput = document.getElementById('edit-act-new-check');
      if (act && textInput && textInput.value.trim()) {
        if (!act.checklist) act.checklist = [];
        act.checklist.push({ text: textInput.value.trim(), done: false });
        textInput.value = '';
        renderModalChecklist(act);
        saveState();
      }
    },
    showOperatingGuide: function () {
      const modal = document.getElementById('modal-operating-guide');
      if (modal) modal.classList.add('show');
    },
    showMissingInputsModal: function () {
      const modal = document.getElementById('modal-missing-inputs');
      if (!modal || !cpmResult) return;
      const list = document.getElementById('missing-inputs-list');
      list.innerHTML = cpmResult.missingInputs.map(m => `
        <div class="attention-item" onclick="app.editActivity('${m.id}')">
          <div class="attention-info">
            <strong>[${m.id}] ${m.title}</strong>
            <span style="color:var(--status-red); font-size:12px;">${m.issue}</span>
          </div>
          <button class="btn btn-sm btn-secondary">Fix Input</button>
        </div>
      `).join('');
      modal.classList.add('show');
    },
    resetData: function () {
      if (confirm("Reset application data back to initial PPTX and Excel baseline? Any custom updates will be overwritten.")) {
        resetToInitial();
        refreshSchedule();
      }
    }
  };

  function setupEventListeners() {
    // Nav tab clicks
    document.querySelectorAll('.nav-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Roadmap filters
    const selLane = document.getElementById('filter-roadmap-lane');
    if (selLane) {
      selLane.addEventListener('change', (e) => {
        state.filters.roadmapLane = e.target.value;
        renderRoadmap();
      });
    }

    const selStream = document.getElementById('filter-roadmap-stream');
    if (selStream) {
      selStream.addEventListener('change', (e) => {
        state.filters.roadmapStream = e.target.value;
        renderRoadmap();
      });
    }

    const selOwner = document.getElementById('filter-roadmap-owner');
    if (selOwner) {
      selOwner.addEventListener('change', (e) => {
        state.filters.roadmapOwner = e.target.value;
        renderRoadmap();
      });
    }

    const searchRoadmap = document.getElementById('search-roadmap');
    if (searchRoadmap) {
      searchRoadmap.addEventListener('input', (e) => {
        state.filters.roadmapSearch = e.target.value;
        renderRoadmap();
      });
    }

    // Zoom toggle
    const btnZoomWeek = document.getElementById('btn-zoom-week');
    const btnZoomMonth = document.getElementById('btn-zoom-month');
    if (btnZoomWeek && btnZoomMonth) {
      btnZoomWeek.addEventListener('click', () => {
        state.zoomMode = 'week';
        btnZoomWeek.className = 'btn btn-sm btn-primary';
        btnZoomMonth.className = 'btn btn-sm btn-secondary';
        renderRoadmap();
      });
      btnZoomMonth.addEventListener('click', () => {
        state.zoomMode = 'month';
        btnZoomMonth.className = 'btn btn-sm btn-primary';
        btnZoomWeek.className = 'btn btn-sm btn-secondary';
        renderRoadmap();
      });
    }

    // Purchasing filters
    const selPurStatus = document.getElementById('filter-purchasing-status');
    if (selPurStatus) {
      selPurStatus.addEventListener('change', (e) => {
        state.filters.purchasingStatus = e.target.value;
        renderPurchasing();
      });
    }

    const searchPur = document.getElementById('search-purchasing');
    if (searchPur) {
      searchPur.addEventListener('input', (e) => {
        state.filters.purchasingSearch = e.target.value;
        renderPurchasing();
      });
    }

    // RAID filters
    const searchRaid = document.getElementById('search-raid');
    if (searchRaid) {
      searchRaid.addEventListener('input', (e) => {
        state.filters.raidSearch = e.target.value;
        renderRAID();
      });
    }

    document.querySelectorAll('.raid-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.raid-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.filters.raidType = btn.dataset.type;
        renderRAID();
      });
    });

    // Close modals on clicking backdrop
    document.querySelectorAll('.modal-backdrop').forEach(bd => {
      bd.addEventListener('click', (e) => {
        if (e.target === bd) {
          bd.classList.remove('show');
        }
      });
    });
  }

  // Boot on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.app.init);
  } else {
    window.app.init();
  }
})();
