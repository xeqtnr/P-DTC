/**
 * Haulotte PULSAR DTC - Critical Path Method (CPM) Engine
 * Implements standard forward/backward pass on Mon-Fri calendar.
 * Calculates Earliest Start (ES), Earliest Finish (EF), Latest Start (LS),
 * Latest Finish (LF), Total Float (TF), Free Float (FF), and identifies Critical Paths.
 */

const CPMEngine = (function () {
  'use strict';

  // ---------------- Calendar Utilities (Mon-Fri) ----------------

  function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6; // Sunday = 0, Saturday = 6
  }

  function parseDate(str) {
    if (!str) return null;
    const parts = str.split('-');
    if (parts.length !== 3) return null;
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(d) {
    if (!d || isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Adjusts date to next working day if it falls on a weekend
   */
  function toNextWorkingDay(d) {
    const cur = new Date(d);
    while (isWeekend(cur)) {
      cur.setDate(cur.getDate() + 1);
    }
    return cur;
  }

  /**
   * Adjusts date to previous working day if it falls on a weekend
   */
  function toPrevWorkingDay(d) {
    const cur = new Date(d);
    while (isWeekend(cur)) {
      cur.setDate(cur.getDate() - 1);
    }
    return cur;
  }

  /**
   * Adds working days to a start date.
   * If days === 0 (milestone), returns start date adjusted to working day.
   * If days === 1, finish date = start date.
   * If days > 1, advances working days.
   */
  function addWorkingDays(startDate, workingDays) {
    if (!startDate) return null;
    let cur = toNextWorkingDay(new Date(startDate));
    if (workingDays <= 0) return cur;
    
    let daysAdded = 1; // start date counts as 1st working day
    while (daysAdded < workingDays) {
      cur.setDate(cur.getDate() + 1);
      if (!isWeekend(cur)) {
        daysAdded++;
      }
    }
    return cur;
  }

  /**
   * Subtracts working days from a finish date (for backward pass)
   */
  function subtractWorkingDays(finishDate, workingDays) {
    if (!finishDate) return null;
    let cur = toPrevWorkingDay(new Date(finishDate));
    if (workingDays <= 0) return cur;

    let daysSub = 1;
    while (daysSub < workingDays) {
      cur.setDate(cur.getDate() - 1);
      if (!isWeekend(cur)) {
        daysSub++;
      }
    }
    return cur;
  }

  /**
   * Calculates working days count between start and finish inclusive.
   */
  function countWorkingDays(startDate, finishDate) {
    if (!startDate || !finishDate) return 0;
    const start = parseDate(startDate);
    const finish = parseDate(finishDate);
    if (!start || !finish) return 0;
    if (start > finish) return -countWorkingDays(finishDate, startDate);

    let count = 0;
    let cur = new Date(start);
    while (cur <= finish) {
      if (!isWeekend(cur)) {
        count++;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  /**
   * Finds the immediate next working day after a given date
   */
  function getNextWorkingDay(date) {
    const cur = new Date(date);
    cur.setDate(cur.getDate() + 1);
    while (isWeekend(cur)) {
      cur.setDate(cur.getDate() + 1);
    }
    return cur;
  }

  /**
   * Finds the immediate previous working day before a given date
   */
  function getPrevWorkingDay(date) {
    const cur = new Date(date);
    cur.setDate(cur.getDate() - 1);
    while (isWeekend(cur)) {
      cur.setDate(cur.getDate() - 1);
    }
    return cur;
  }

  // ---------------- Cycle Detection & Dependency Graph ----------------

  function checkCircularDependency(nodes, fromId, toId) {
    // Check if adding an edge from toId -> fromId would create a cycle
    // (i.e., is toId already reachable from fromId?)
    const visited = new Set();
    const stack = [fromId];

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === toId) return true; // Cycle detected
      visited.add(current);

      const node = nodes.find(n => n.id === current);
      if (node && Array.isArray(node.predecessors)) {
        for (const pred of node.predecessors) {
          if (!visited.has(pred)) {
            stack.push(pred);
          }
        }
      }
    }
    return false;
  }

  // ---------------- Core CPM Calculation ----------------

  /**
   * Calculates the full schedule, critical paths, and floats.
   * @param {Array} activities - List of activity objects
   * @param {Array} milestones - List of milestone objects
   * @param {Array} prototypes - List of prototype procurement items
   * @param {Object} settings - Program settings (baseline dates, asOfDate, etc.)
   */
  function calculateSchedule(activities, milestones, prototypes, settings) {
    const asOfDateStr = settings.asOfDate || '2026-09-28';
    const asOfDate = parseDate(asOfDateStr);

    // Build unified map of nodes (activities + milestones)
    const nodeMap = new Map();
    const missingInputs = [];

    // Combine all schedulable items
    const allItems = [];

    // Add activities
    activities.forEach(act => {
      const item = {
        id: act.id,
        type: 'activity',
        title: act.title,
        lane: act.lane,
        stream: act.stream || (act.lane === 'steering' ? 'Steering' : 'Mainstream'),
        owner: act.owner || '',
        startDate: act.startDate || '',
        expectedFinishDate: act.expectedFinishDate || '',
        durationWd: Number(act.durationWd) || (act.startDate && act.expectedFinishDate ? countWorkingDays(act.startDate, act.expectedFinishDate) : 0),
        remainingWd: act.remainingWd !== undefined && act.remainingWd !== null ? Number(act.remainingWd) : null,
        progress: act.progress,
        blocked: !!act.blocked,
        predecessors: Array.isArray(act.predecessors) ? [...act.predecessors] : [],
        prototypeId: act.prototypeId || null,
        original: act
      };

      // Check missing inputs required for CPM
      if (!item.startDate) missingInputs.push({ id: item.id, title: item.title, issue: "Missing start date" });
      if (!item.expectedFinishDate) missingInputs.push({ id: item.id, title: item.title, issue: "Missing expected finish date" });
      if (item.durationWd <= 0 && item.type === 'activity') missingInputs.push({ id: item.id, title: item.title, issue: "Duration is 0 or negative" });

      // If linked to a prototype in purchasing, sync expected date
      if (item.prototypeId) {
        const proto = prototypes.find(p => p.id === item.prototypeId);
        if (proto && proto.expectedDeliveryDate) {
          item.expectedFinishDate = proto.expectedDeliveryDate;
          // Re-derive duration if needed
          if (item.startDate) {
            item.durationWd = Math.max(1, countWorkingDays(item.startDate, item.expectedFinishDate));
          }
        }
      }

      allItems.push(item);
      nodeMap.set(item.id, item);
    });

    // Add milestones
    milestones.forEach(m => {
      const item = {
        id: m.id,
        type: 'milestone',
        title: m.title,
        lane: m.lane,
        stream: m.stream,
        stage: m.stage,
        owner: m.owner || '',
        startDate: m.date || '',
        expectedFinishDate: m.date || '',
        durationWd: 0,
        remainingWd: 0,
        progress: m.achieved ? 100 : 0,
        blocked: false,
        predecessors: Array.isArray(m.predecessors) ? [...m.predecessors] : [],
        isEndpoint: !!m.isEndpoint,
        achieved: !!m.achieved,
        actualAchievedDate: m.actualAchievedDate || null,
        prototypeId: m.prototypeId || null,
        original: m
      };

      // If milestone is prototype availability linked to purchasing
      if (item.prototypeId) {
        const proto = prototypes.find(p => p.id === item.prototypeId);
        if (proto && proto.expectedDeliveryDate) {
          item.startDate = proto.expectedDeliveryDate;
          item.expectedFinishDate = proto.expectedDeliveryDate;
          if (proto.acceptedForAssembly && proto.status === 'Received') {
            item.achieved = true;
            item.actualAchievedDate = proto.receivedDate || proto.expectedDeliveryDate;
          }
        }
      }

      allItems.push(item);
      nodeMap.set(item.id, item);
    });

    // Check for missing predecessors in graph
    allItems.forEach(item => {
      item.predecessors = item.predecessors.filter(pid => {
        if (!nodeMap.has(pid)) {
          // If predecessor is not in our node map
          return false;
        }
        return true;
      });
    });

    // Build adjacency and in-degree maps for Topological Sort
    const adj = new Map(); // pred -> [successors]
    const inDegree = new Map();

    allItems.forEach(item => {
      adj.set(item.id, []);
      inDegree.set(item.id, 0);
    });

    allItems.forEach(item => {
      item.predecessors.forEach(predId => {
        if (adj.has(predId)) {
          adj.get(predId).push(item.id);
          inDegree.set(item.id, (inDegree.get(item.id) || 0) + 1);
        }
      });
    });

    // Topological Sort (Kahn's Algorithm)
    const queue = [];
    inDegree.forEach((deg, id) => {
      if (deg === 0) queue.push(id);
    });

    const topoOrder = [];
    while (queue.length > 0) {
      const u = queue.shift();
      topoOrder.push(u);

      const successors = adj.get(u) || [];
      successors.forEach(v => {
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) {
          queue.push(v);
        }
      });
    }

    const hasCycle = topoOrder.length !== allItems.length;
    if (hasCycle) {
      return {
        isIncomplete: true,
        error: "Circular dependency detected in schedule network",
        missingInputs: [{ id: "GRAPH", title: "Schedule Network", issue: "Circular link exists among activities" }],
        items: allItems,
        endpoints: {}
      };
    }

    // ---------------- Forward Pass (Earliest Start / Earliest Finish) ----------------
    topoOrder.forEach(id => {
      const node = nodeMap.get(id);
      
      if (node.predecessors.length === 0) {
        // No predecessors: use its declared start date, or project planning start
        const declaredStart = parseDate(node.startDate) || asOfDate;
        node.ES = toNextWorkingDay(declaredStart);
      } else {
        // Predecessors exist: FS link -> successor starts day after max predecessor EF
        let maxPredEF = null;
        node.predecessors.forEach(pid => {
          const pred = nodeMap.get(pid);
          if (pred && pred.EF) {
            if (!maxPredEF || pred.EF > maxPredEF) {
              maxPredEF = pred.EF;
            }
          }
        });

        if (maxPredEF) {
          // FS link: starts next working day (or same day if predecessor duration was 0)
          node.ES = getNextWorkingDay(maxPredEF);
        } else {
          node.ES = toNextWorkingDay(parseDate(node.startDate) || asOfDate);
        }
      }

      // If task is completed (100%), EF is set to completion date or expected finish
      if (node.progress === 100 && node.original && node.original.completedDate) {
        node.EF = parseDate(node.original.completedDate);
      } else {
        const dur = node.durationWd || 0;
        node.EF = addWorkingDays(node.ES, dur);
      }

      // Convert back to string for display
      node.forecastStart = formatDate(node.ES);
      node.forecastFinish = formatDate(node.EF);
    });

    // ---------------- Backward Pass & Floats ----------------
    // We run two backward passes:
    // 1) From Mainstream endpoint: MS-END
    // 2) From Steering endpoint: ST-END

    const msEndpoint = nodeMap.get('MS-END');
    const stEndpoint = nodeMap.get('ST-END');

    // Run Backward Pass helper
    function runBackwardPass(endpointId, streamKey) {
      const endpoint = nodeMap.get(endpointId);
      if (!endpoint || !endpoint.EF) return;

      // Endpoint Latest Finish is its own Forecast Finish
      endpoint[`LF_${streamKey}`] = new Date(endpoint.EF);
      endpoint[`LS_${streamKey}`] = subtractWorkingDays(endpoint[`LF_${streamKey}`], endpoint.durationWd || 0);

      // Reverse topological traversal
      for (let i = topoOrder.length - 1; i >= 0; i--) {
        const id = topoOrder[i];
        const node = nodeMap.get(id);
        const successors = (adj.get(id) || []).filter(succId => {
          const succ = nodeMap.get(succId);
          return succ && succ[`LS_${streamKey}`] !== undefined;
        });

        if (id === endpointId) continue;

        if (successors.length > 0) {
          let minSuccLS = null;
          successors.forEach(succId => {
            const succ = nodeMap.get(succId);
            if (succ && succ[`LS_${streamKey}`]) {
              const prevWorkDay = getPrevWorkingDay(succ[`LS_${streamKey}`]);
              if (!minSuccLS || prevWorkDay < minSuccLS) {
                minSuccLS = prevWorkDay;
              }
            }
          });

          if (minSuccLS) {
            node[`LF_${streamKey}`] = minSuccLS;
            node[`LS_${streamKey}`] = subtractWorkingDays(node[`LF_${streamKey}`], node.durationWd || 0);
          }
        }
      }

      // Compute Total Float for this stream
      allItems.forEach(item => {
        if (item[`LF_${streamKey}`] && item.EF) {
          const floatWd = countWorkingDays(formatDate(item.EF), formatDate(item[`LF_${streamKey}`])) - 1;
          item[`TF_${streamKey}`] = floatWd;
        } else {
          item[`TF_${streamKey}`] = null;
        }
      });
    }

    runBackwardPass('MS-END', 'mainstream');
    runBackwardPass('ST-END', 'steering');

    // Determine Critical Status & Explanations
    allItems.forEach(item => {
      const isCriticalMs = item.TF_mainstream !== null && item.TF_mainstream <= 0;
      const isCriticalSt = item.TF_steering !== null && item.TF_steering <= 0;

      item.isCritical = isCriticalMs || isCriticalSt;
      item.isCriticalMainstream = isCriticalMs;
      item.isCriticalSteering = isCriticalSt;

      // Available float is min float across applicable streams
      const validFloats = [];
      if (item.TF_mainstream !== null) validFloats.push(item.TF_mainstream);
      if (item.TF_steering !== null) validFloats.push(item.TF_steering);
      item.totalFloat = validFloats.length > 0 ? Math.min(...validFloats) : null;

      // Explanation message
      if (isCriticalMs && isCriticalSt) {
        item.criticalExplanation = "Critical: A delay here moves BOTH Mainstream and Steering Serial TR delivery.";
      } else if (isCriticalMs) {
        item.criticalExplanation = "Critical: A delay here moves Mainstream Serial TR delivery.";
      } else if (isCriticalSt) {
        item.criticalExplanation = "Critical: A delay here moves Steering Serial TR delivery.";
      } else if (item.totalFloat !== null) {
        item.criticalExplanation = `Near-critical/Float available: ${item.totalFloat} working days of float before affecting Serial TR.`;
      } else {
        item.criticalExplanation = "Independent or unlinked activity.";
      }
    });

    // Calculate Variance against Committed Baseline Targets
    const mainstreamForecast = msEndpoint ? msEndpoint.forecastFinish : null;
    const steeringForecast = stEndpoint ? stEndpoint.forecastFinish : null;

    const mainstreamTarget = settings.baselineTargetMainstream || "2026-12-23";
    const steeringTarget = settings.baselineTargetSteering || "2027-01-12";

    const mainstreamVarianceWd = mainstreamForecast && mainstreamTarget 
      ? countWorkingDays(mainstreamTarget, mainstreamForecast) - 1 
      : 0;

    const steeringVarianceWd = steeringForecast && steeringTarget 
      ? countWorkingDays(steeringTarget, steeringForecast) - 1 
      : 0;

    return {
      isIncomplete: missingInputs.length > 0,
      missingInputs: missingInputs,
      endpoints: {
        mainstream: {
          id: 'MS-END',
          name: 'Mainstream Serial TR delivered',
          targetDate: mainstreamTarget,
          forecastDate: mainstreamForecast,
          varianceWd: mainstreamVarianceWd,
          isDelayed: mainstreamVarianceWd > 0
        },
        steering: {
          id: 'ST-END',
          name: 'Steering Serial TR delivered',
          targetDate: steeringTarget,
          forecastDate: steeringForecast,
          varianceWd: steeringVarianceWd,
          isDelayed: steeringVarianceWd > 0
        }
      },
      nodeMap: nodeMap,
      items: allItems
    };
  }

  // Public API
  return {
    isWeekend,
    parseDate,
    formatDate,
    addWorkingDays,
    subtractWorkingDays,
    countWorkingDays,
    getNextWorkingDay,
    getPrevWorkingDay,
    checkCircularDependency,
    calculateSchedule
  };
})();

// Export for node or browser environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CPMEngine;
}
