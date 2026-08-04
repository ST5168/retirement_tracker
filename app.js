(function () {
  "use strict";

  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, storageKey: "runway-auth" }
  });

  var VARIABLE_CATEGORIES = ["Breakfast", "Lunch", "Dinner", "Coffee", "Dining (Others)", "Shopping", "Transportation", "Petrol", "Others", "Vacation"];

  var DEFAULT_BILLS = [
    { name: "Apartment Rental", amount: 2600, due_day: 1 },
    { name: "Car Installment", amount: 1693, due_day: 5 },
    { name: "Parents Monthly Allowance", amount: 1000, due_day: 1 },
    { name: "Contribution to Family's Savings", amount: 200, due_day: 1 },
    { name: "Car Petrol", amount: 250, due_day: 5 },
    { name: "Apartment Cleaning", amount: 200, due_day: 1 },
    { name: "Car Cash Card & Misc", amount: 100, due_day: 5 },
    { name: "Term Life Insurance (Aviva)", amount: 101.30, due_day: 1 },
    { name: "Student Loan Repayment", amount: 102, due_day: 1 },
    { name: "Telecommunication Bills", amount: 80, due_day: 1 },
    { name: "ViewQwest Billing", amount: 50.74, due_day: 1 },
    { name: "Netflix", amount: 29.98, due_day: 1 },
    { name: "Youtube Music Premium", amount: 13.98, due_day: 1 },
    { name: "Youtube Scribblesflow Workspace", amount: 12.21, due_day: 1 },
    { name: "Apple iCloud 2TB", amount: 14.12, due_day: 1 }
  ];

  var DEFAULT_ASSUMPTIONS = {
    dob: "1990-01-01",
    cash_on_hand: 0, investment_value_usd: 0, usd_sgd_rate: 1.29,
    cpf_oa: 0, cpf_sa: 0, variable_budget: 0,
    semi_retire_date: null, windfall_amount: 0, windfall_date: null
  };

  var INVESTMENT_RETURN_ANNUAL = 0.07;
  var CPF_RETURN_ANNUAL = 0.033;
  var PROJECTION_MONTHS = 470; // comfortably past age 75 for most users

  var state = {
    session: null, bills: [], expenses: [], assumptions: null, incomePeriods: [],
    viewMonthIdx: 0, selectedCategory: null, activeTab: "analysis",
    editingBillId: null, deleteConfirmId: null, assumptionsOpen: false, editingExpenseId: null,
    editingBillDefId: null, deleteBillConfirmId: null, analysisChartView: "daily",
    editingPeriodId: null, deletePeriodConfirmId: null
  };

  function fmtMoney(n) {
    n = Math.round(n || 0);
    var sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(n).toLocaleString("en-SG");
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function toDateStr(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function monthNameYear(d) {
    var names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return names[d.getMonth()] + " " + d.getFullYear();
  }
  function monthKeyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }

  // ---------------- Auth ----------------
  var authMode = "login";
  function initAuthScreen() {
    document.getElementById("auth-toggle-link").addEventListener("click", function (e) {
      e.preventDefault();
      authMode = authMode === "login" ? "signup" : "login";
      document.getElementById("auth-title").textContent = authMode === "login" ? "Log in" : "Sign up";
      document.getElementById("auth-submit").textContent = authMode === "login" ? "Log in" : "Sign up";
      document.getElementById("auth-toggle").innerHTML = authMode === "login"
        ? 'Need an account? <a href="#" id="auth-toggle-link">Sign up</a>'
        : 'Already have an account? <a href="#" id="auth-toggle-link">Log in</a>';
      document.getElementById("auth-toggle-link").addEventListener("click", arguments.callee);
    });
    document.getElementById("auth-submit").addEventListener("click", async function () {
      var email = document.getElementById("auth-email").value.trim();
      var password = document.getElementById("auth-password").value;
      var errEl = document.getElementById("auth-error");
      errEl.textContent = "";
      if (!email || !password) { errEl.textContent = "Enter an email and password."; return; }
      var result = authMode === "login"
        ? await supabase.auth.signInWithPassword({ email: email, password: password })
        : await supabase.auth.signUp({ email: email, password: password });
      if (result.error) { errEl.textContent = result.error.message; return; }
      if (authMode === "signup" && result.data && !result.data.session) {
        errEl.style.color = "var(--good)";
        errEl.textContent = "Check your email to confirm your account, then log in.";
      }
    });
  }

  async function handleSession(session) {
    state.session = session;
    if (session) {
      document.getElementById("auth-screen").style.display = "none";
      document.getElementById("app").style.display = "block";
      await ensureDefaultsSeeded();
      await loadAllData();
      renderAll();
    } else {
      document.getElementById("auth-screen").style.display = "flex";
      document.getElementById("app").style.display = "none";
    }
  }

  async function ensureDefaultsSeeded() {
    var userId = state.session.user.id;
    var { data: existingAssumptions } = await supabase.from("assumptions").select("user_id").eq("user_id", userId).maybeSingle();
    if (!existingAssumptions) {
      var seedData = Object.assign({ user_id: userId, start_date: toDateStr(new Date()) }, DEFAULT_ASSUMPTIONS);
      await supabase.from("assumptions").insert(seedData);
    }
    var { data: existingBills } = await supabase.from("recurring_bills").select("id").eq("user_id", userId).limit(1);
    if (!existingBills || existingBills.length === 0) {
      var rows = DEFAULT_BILLS.map(function (b) { return Object.assign({ user_id: userId }, b); });
      await supabase.from("recurring_bills").insert(rows);
    }
    var { data: existingPeriods } = await supabase.from("income_periods").select("id").eq("user_id", userId).limit(1);
    if (!existingPeriods || existingPeriods.length === 0) {
      await supabase.from("income_periods").insert({ user_id: userId, start_date: toDateStr(new Date()), amount: 0 });
    }
  }

  async function loadAllData() {
    var userId = state.session.user.id;
    var [billsRes, expensesRes, assumptionsRes, periodsRes] = await Promise.all([
      supabase.from("recurring_bills").select("*").eq("user_id", userId).eq("archived", false).order("created_at"),
      supabase.from("expenses").select("*").eq("user_id", userId).order("date", { ascending: false }),
      supabase.from("assumptions").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("income_periods").select("*").eq("user_id", userId).order("start_date")
    ]);
    state.bills = billsRes.data || [];
    state.expenses = expensesRes.data || [];
    state.assumptions = assumptionsRes.data || Object.assign({ user_id: userId, start_date: toDateStr(new Date()) }, DEFAULT_ASSUMPTIONS);
    state.incomePeriods = periodsRes.data && periodsRes.data.length ? periodsRes.data : [{ id: null, start_date: state.assumptions.start_date, amount: 0 }];
  }

  // ---------------- Derived data ----------------
  function fixedBudgetTotal() {
    return state.bills.reduce(function (s, b) { return s + parseFloat(b.amount); }, 0);
  }

  function actualsByMonth() {
    var map = {};
    state.expenses.forEach(function (e) {
      var key = e.date.slice(0, 7);
      if (!map[key]) map[key] = { fixed: 0, variable: 0, hasFixed: false, hasVariable: false };
      if (e.type === "Fixed") { map[key].fixed += parseFloat(e.amount); map[key].hasFixed = true; }
      else { map[key].variable += parseFloat(e.amount); map[key].hasVariable = true; }
    });
    var result = {};
    Object.keys(map).forEach(function (k) {
      result[k] = { fixed: map[k].hasFixed ? map[k].fixed : null, variable: map[k].hasVariable ? map[k].variable : null };
    });
    return result;
  }

  function engineAssumptions() {
    var a = state.assumptions;
    return {
      dob: a.dob, start_date: a.start_date,
      periods: state.incomePeriods.map(function (p) { return { start_date: p.start_date, amount: parseFloat(p.amount) }; }),
      fixed_budget: fixedBudgetTotal(), variable_budget: parseFloat(a.variable_budget),
      cash_on_hand: parseFloat(a.cash_on_hand), investment_value_sgd: parseFloat(a.investment_value_usd) * parseFloat(a.usd_sgd_rate),
      cpf_oa: parseFloat(a.cpf_oa), cpf_sa: parseFloat(a.cpf_sa),
      windfall_amount: parseFloat(a.windfall_amount || 0), windfall_date: a.windfall_date,
      investment_return_annual: INVESTMENT_RETURN_ANNUAL, cpf_return_annual: CPF_RETURN_ANNUAL
    };
  }

  function runProjection() {
    var a = engineAssumptions();
    var actuals = actualsByMonth();
    return simulateMonths(a, PROJECTION_MONTHS, actuals);
  }

  function currentAgeYears() {
    if (!state.assumptions.dob) return null;
    var dob = new Date(state.assumptions.dob + "T00:00:00");
    var now = new Date();
    var age = now.getFullYear() - dob.getFullYear();
    var m = now.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
    return age;
  }

  function billsStatusForMonth(dateObj) {
    var key = monthKeyOf(dateObj);
    var monthEntries = state.expenses.filter(function (e) { return e.date.slice(0, 7) === key && e.type === "Fixed"; });
    return state.bills.map(function (b) {
      var paid = monthEntries.find(function (e) { return e.bill_id === b.id; });
      return paid
        ? { id: b.id, name: b.name, amount: b.amount, paid: true, paidAmount: paid.amount, paidDate: paid.date, entryId: paid.id }
        : { id: b.id, name: b.name, amount: b.amount, paid: false };
    });
  }

  function viewDate() {
    var start = new Date(state.assumptions.start_date + "T00:00:00");
    return new Date(start.getFullYear(), start.getMonth() + state.viewMonthIdx, 1);
  }

  function categoryBreakdownForMonth(dateObj) {
    var key = monthKeyOf(dateObj);
    var inMonth = state.expenses.filter(function (e) { return e.date.slice(0, 7) === key && e.type === "Variable"; });
    var map = {};
    inMonth.forEach(function (e) { map[e.category] = (map[e.category] || 0) + parseFloat(e.amount); });
    return VARIABLE_CATEGORIES.map(function (c) { return { category: c, amount: map[c] || 0 }; })
      .filter(function (x) { return x.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }

  function dailyVariableSeries(viewedDate, realNow) {
    var year = viewedDate.getFullYear(), month = viewedDate.getMonth();
    var dim = new Date(year, month + 1, 0).getDate();
    var isRealCurrentMonth = year === realNow.getFullYear() && month === realNow.getMonth();
    var isFutureMonth = viewedDate > new Date(realNow.getFullYear(), realNow.getMonth(), 1);
    var todayDay = isRealCurrentMonth ? realNow.getDate() : (isFutureMonth ? 0 : dim);
    var monthPrefix = year + "-" + pad(month + 1) + "-";
    var dayTotals = {};
    state.expenses.forEach(function (e) {
      if (e.type === "Variable" && e.date.indexOf(monthPrefix) === 0) {
        var dayNum = parseInt(e.date.slice(8, 10), 10);
        dayTotals[dayNum] = (dayTotals[dayNum] || 0) + parseFloat(e.amount);
      }
    });
    var labels = [], cumulative = [];
    var acc = 0;
    for (var d = 1; d <= dim; d++) {
      labels.push(String(d));
      if (d <= todayDay) { acc += dayTotals[d] || 0; cumulative.push(acc); }
      else cumulative.push(null);
    }
    return { labels: labels, cumulative: cumulative };
  }

  function monthlyTotalsSeries(now, monthsBack) {
    var labels = [], totals = [];
    var actuals = actualsByMonth();
    var names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (var i = monthsBack - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var key = monthKeyOf(d);
      var a = actuals[key] || {};
      var fixed = a.fixed != null ? a.fixed : (i === 0 ? fixedBudgetTotal() : 0);
      var variable = a.variable != null ? a.variable : 0;
      labels.push(names[d.getMonth()]);
      totals.push(fixed + variable);
    }
    return { labels: labels, totals: totals };
  }

  // ---------------- Sort helper: chronological, latest first, stable tie-break ----------------
  function sortEntriesLatestFirst(entries) {
    return entries.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      // Same day: fall back to created_at (most recently logged first), then id as a final tiebreaker
      var at = a.created_at || "", bt = b.created_at || "";
      if (at !== bt) return at < bt ? 1 : -1;
      return String(a.id) < String(b.id) ? 1 : -1;
    });
  }

  // ---------------- Render dispatch ----------------
  function renderAll() {
    renderAnalysis();
    renderLog();
    renderBills();
    renderPlan();
  }

  // ================= ANALYSIS TAB (merged former Home + Analysis) =================
  var analysisChart = null;

  function renderAnalysis() {
    var el = document.getElementById("screen-analysis");
    var cash = parseFloat(state.assumptions.cash_on_hand) || 0;
    var investments = (parseFloat(state.assumptions.investment_value_usd) || 0) * (parseFloat(state.assumptions.usd_sgd_rate) || 0);
    var totalAssets = cash + investments;

    var startDate = new Date(state.assumptions.start_date + "T00:00:00");
    var realNow = new Date();
    if (realNow < startDate) realNow = startDate;

    var vd = viewDate();
    var atStart = state.viewMonthIdx === 0;
    var isRealCurrentMonth = vd.getFullYear() === realNow.getFullYear() && vd.getMonth() === realNow.getMonth();
    var isPastMonth = vd < new Date(realNow.getFullYear(), realNow.getMonth(), 1);

    var dim = new Date(vd.getFullYear(), vd.getMonth() + 1, 0).getDate();
    var day = isRealCurrentMonth ? realNow.getDate() : dim;
    var fixedBudget = fixedBudgetTotal();
    var variableBudget = parseFloat(state.assumptions.variable_budget) || 0;
    var totalBudget = fixedBudget + variableBudget;
    var thisKey = monthKeyOf(vd);
    var actual = actualsByMonth()[thisKey] || {};
    var spentSoFar = (actual.fixed != null ? actual.fixed : 0) + (actual.variable != null ? actual.variable : 0);
    var pctSpent = totalBudget > 0 ? Math.round((spentSoFar / totalBudget) * 100) : 0;
    var pctDays = Math.round((day / dim) * 100);

    var monthLabel = isRealCurrentMonth ? "This month" : monthNameYear(vd);
    var captionHtml;
    if (isRealCurrentMonth) {
      captionHtml = 'Day ' + day + ' of ' + dim + ' &middot; ' + monthNameYear(vd) + ', ' + (pctSpent > pctDays ? "ahead of pace" : "on pace");
    } else if (isPastMonth) {
      captionHtml = 'Ended the month at ' + pctSpent + '% of budget';
    } else {
      captionHtml = 'This month hasn&rsquo;t started yet';
    }
    var barColor = isRealCurrentMonth ? (pctSpent > pctDays ? "var(--warn)" : "var(--good)") : (pctSpent > 100 ? "var(--warn)" : "var(--good)");

    var cats = categoryBreakdownForMonth(vd);
    var maxCat = cats.length ? cats[0].amount : 1;
    var catRows = cats.length ? cats.map(function (c) {
      var pct = Math.max(4, Math.round((c.amount / maxCat) * 100));
      return '<div class="cat-row"><div class="cat-name">' + c.category + '</div>' +
        '<div class="cat-bar-track"><div class="cat-bar-fill" style="width:' + pct + '%;"></div></div>' +
        '<div class="cat-amount">' + fmtMoney(c.amount) + '</div></div>';
    }).join("") : '<div class="empty-note">No variable spending logged yet this month.</div>';

    var prevKey = monthKeyOf(new Date(vd.getFullYear(), vd.getMonth() - 1, 1));
    var thisTotal = cats.reduce(function (s, c) { return s + c.amount; }, 0);
    var prevEntries = state.expenses.filter(function (e) { return e.date.slice(0, 7) === prevKey && e.type === "Variable"; });
    var prevTotal = prevEntries.reduce(function (s, e) { return s + parseFloat(e.amount); }, 0);
    var vsPrevText = atStart ? "No earlier month yet"
      : prevTotal === 0 ? "No data last month"
      : (thisTotal >= prevTotal ? "+" : "-") + Math.round(Math.abs(thisTotal - prevTotal) / prevTotal * 100) + "% vs last month";

    el.innerHTML =
      '<div class="stat-grid3">' +
        '<div class="stat-box"><div class="stat-label">Cash on hand</div><div class="stat-value">' + fmtMoney(cash) + '</div></div>' +
        '<div class="stat-box"><div class="stat-label">Investments</div><div class="stat-value">' + fmtMoney(investments) + '</div></div>' +
        '<div class="stat-box"><div class="stat-label">Total assets</div><div class="stat-value">' + fmtMoney(totalAssets) + '</div></div>' +
      '</div>' +
      '<div class="rw-monthnav">' +
        '<button class="rw-monthbtn" id="an-prev" ' + (atStart ? "disabled" : "") + '><i class="ti ti-chevron-left"></i></button>' +
        '<span style="font-size:15px;font-weight:600;">' + monthNameYear(vd) + '</span>' +
        '<button class="rw-monthbtn" id="an-next"><i class="ti ti-chevron-right"></i></button>' +
      '</div>' +
      '<div class="rw-card">' +
        '<div style="display:flex;justify-content:space-between;font-size:15px;margin-bottom:8px;"><span style="color:var(--muted);">' + monthLabel + ', incl. recurring</span><span style="font-weight:600;">' + fmtMoney(spentSoFar) + ' of ' + fmtMoney(totalBudget) + '</span></div>' +
        '<div class="pace-bar-track"><div class="pace-bar-fill" style="width:' + Math.min(100, pctSpent) + '%;background:' + barColor + ';"></div></div>' +
        '<div style="font-size:13px;color:var(--muted);margin-top:6px;">' + captionHtml + '</div>' +
      '</div>' +
      '<div class="rw-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<div style="font-size:15px;font-weight:500;">Spend</div>' +
          '<div class="seg" style="width:150px;">' +
            '<button id="an-btn-daily" class="' + (state.analysisChartView !== "monthly" ? "active" : "") + '">Daily</button>' +
            '<button id="an-btn-monthly" class="' + (state.analysisChartView === "monthly" ? "active" : "") + '">Monthly</button>' +
          '</div>' +
        '</div>' +
        '<div id="an-chart-legend" style="display:' + (state.analysisChartView === "monthly" ? "none" : "flex") + ';flex-wrap:wrap;gap:14px;margin-bottom:10px;font-size:13px;color:var(--muted);">' +
          '<span style="display:flex;align-items:center;gap:5px;"><span class="swatch" style="border-top:2px solid #2a78d6;"></span>Variable spend</span>' +
          '<span style="display:flex;align-items:center;gap:5px;"><span class="swatch" style="border-top:2px dashed var(--warn);"></span>Variable budget</span>' +
        '</div>' +
        (state.analysisChartView !== "monthly" ? '<div style="font-size:11.5px;color:var(--muted-2);margin-bottom:8px;">Monthly always shows the most recent 6 months, independent of the navigator above</div>' : "") +
        '<div style="position:relative;width:100%;height:200px;"><canvas id="analysisChart"></canvas></div>' +
      '</div>' +
      '<div class="rw-card"><div style="font-size:13px;color:var(--muted);margin-bottom:10px;">By category</div>' + catRows + '</div>' +
      '<div class="rw-card" style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:14px;color:var(--muted);">Vs previous month</span><span style="font-size:14px;font-weight:600;">' + vsPrevText + '</span></div>';

    renderAnalysisChart(vd, realNow);
    document.getElementById("an-btn-daily").addEventListener("click", function () { state.analysisChartView = "daily"; renderAnalysis(); });
    document.getElementById("an-btn-monthly").addEventListener("click", function () { state.analysisChartView = "monthly"; renderAnalysis(); });
    document.getElementById("an-prev").addEventListener("click", function () { shiftAnalysisMonth(-1); });
    document.getElementById("an-next").addEventListener("click", function () { shiftAnalysisMonth(1); });
  }

  function shiftAnalysisMonth(delta) {
    state.viewMonthIdx = Math.max(0, state.viewMonthIdx + delta);
    renderAnalysis();
  }

  function renderAnalysisChart(vd, realNow) {
    var canvas = document.getElementById("analysisChart");
    if (!canvas || typeof Chart === "undefined") return;
    if (analysisChart) { analysisChart.destroy(); analysisChart = null; }

    if (state.analysisChartView === "monthly") {
      var m = monthlyTotalsSeries(realNow, 6);
      analysisChart = new Chart(canvas, {
        type: "bar",
        data: { labels: m.labels, datasets: [{ data: m.totals, backgroundColor: "#2a78d6", borderRadius: 4, maxBarThickness: 28 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false }, ticks: { color: "#898781", font: { size: 11 } } },
            y: { grid: { color: "#e1e0d9" }, ticks: { color: "#898781", font: { size: 11 }, callback: function (v) { return "$" + (v / 1000) + "k"; } } } } }
      });
    } else {
      var s = dailyVariableSeries(vd, realNow);
      var budgetVal = parseFloat(state.assumptions.variable_budget) || 0;
      var budgetLine = s.labels.map(function () { return budgetVal; });
      analysisChart = new Chart(canvas, {
        type: "line",
        data: { labels: s.labels, datasets: [
          { label: "Variable spend", data: s.cumulative, borderColor: "#2a78d6", borderWidth: 2.5, pointRadius: 0, tension: 0, fill: false, spanGaps: false },
          { label: "Variable budget", data: budgetLine, borderColor: "#B5502E", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, fill: false }
        ] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false }, ticks: { color: "#898781", maxTicksLimit: 8, font: { size: 11 } } },
            y: { grid: { color: "#e1e0d9" }, ticks: { color: "#898781", font: { size: 11 }, callback: function (v) { return "$" + v; } } } } }
      });
    }
  }

  // ================= LOG TAB =================
  function renderLog() {
    var el = document.getElementById("screen-log");
    var d = viewDate();
    var key = monthKeyOf(d);
    var monthEntries = sortEntriesLatestFirst(state.expenses.filter(function (e) { return e.date.slice(0, 7) === key; }));
    var atStart = state.viewMonthIdx === 0;
    var todayStr = toDateStr(new Date());
    var minDateStr = state.assumptions.start_date;
    var defaultDateStr = todayStr < minDateStr ? minDateStr : todayStr;

    var chips = VARIABLE_CATEGORIES.map(function (c) {
      var sel = state.selectedCategory === c ? " sel" : "";
      return '<span class="rw-chip' + sel + '" data-cat="' + c + '">' + c + '</span>';
    }).join("");

    var rows = monthEntries.length ? monthEntries.map(function (e) {
      if (state.editingExpenseId === e.id) {
        var optsHtml = VARIABLE_CATEGORIES.map(function (c) { return '<option value="' + c + '"' + (c === e.category ? " selected" : "") + '>' + c + '</option>'; }).join("");
        return '<div class="edit-row" data-edit-expense-row="' + e.id + '">' +
          '<div class="field-block"><label class="field-label">Description</label><input type="text" id="ee-desc-' + e.id + '" value="' + (e.description || "").replace(/"/g, "&quot;") + '" /></div>' +
          '<div class="edit-row-fields"><div class="field-block"><label class="field-label">Category</label><select id="ee-cat-' + e.id + '">' + optsHtml + '</select></div>' +
          '<div class="field-block"><label class="field-label">Amount (S$)</label><input type="number" id="ee-amount-' + e.id + '" value="' + e.amount + '" /></div></div>' +
          '<div class="field-block"><label class="field-label">Date</label><input type="date" id="ee-date-' + e.id + '" value="' + e.date + '" min="' + state.assumptions.start_date + '" /></div>' +
          '<div class="edit-actions"><button aria-label="Save" data-save-expense="' + e.id + '"><i class="ti ti-check"></i></button>' +
          '<button aria-label="Cancel" data-cancel-expense="' + e.id + '"><i class="ti ti-x"></i></button></div></div>';
      }
      var confirming = state.deleteConfirmId === e.id;
      var canEdit = e.type === "Variable";
      return '<div class="rw-row" style="min-height:auto;">' +
        '<div><div style="font-size:15px;font-weight:500;">' + (e.description || e.category) + '</div>' +
        '<div style="font-size:13px;color:var(--muted);">' + e.date.slice(5) + ', ' + e.category + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:15px;">' + fmtMoney(e.amount) + '</span>' +
        (canEdit ? '<button class="icon-sm" data-edit-expense="' + e.id + '" aria-label="Edit"><i class="ti ti-pencil"></i></button>' : "") +
        (confirming
          ? '<button class="icon-sm" data-confirm-del="' + e.id + '" style="color:var(--warn);font-weight:600;font-size:11px;">Delete?</button>'
          : '<button class="icon-sm" data-del="' + e.id + '"><i class="ti ti-trash"></i></button>') +
        '</div></div>';
    }).join("") : '<div class="empty-note">No transactions logged for this month yet.</div>';

    el.innerHTML =
      '<input id="qa-amount" type="text" inputmode="decimal" placeholder="0.00" style="width:100%;font-size:22px;padding:10px 12px;margin-bottom:12px;" />' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' + chips + '</div>' +
      '<input id="qa-desc" type="text" placeholder="Description (optional)" style="width:100%;margin-bottom:12px;" />' +
      '<div style="display:flex;gap:10px;margin-bottom:18px;">' +
        '<input id="qa-date" type="date" value="' + defaultDateStr + '" min="' + minDateStr + '" style="flex:1;" />' +
        '<button id="qa-submit" class="btn btn-primary">Add</button>' +
      '</div>' +
      '<div class="rw-monthnav">' +
        '<button class="rw-monthbtn" id="log-prev" ' + (atStart ? "disabled" : "") + '><i class="ti ti-chevron-left"></i></button>' +
        '<span style="font-size:15px;font-weight:600;">' + monthNameYear(d) + '</span>' +
        '<button class="rw-monthbtn" id="log-next"><i class="ti ti-chevron-right"></i></button>' +
      '</div>' +
      '<div style="font-size:13px;color:var(--muted);margin-bottom:8px;">Transactions &middot; latest first</div>' +
      '<div class="rw-card">' + rows + '</div>';

    document.querySelectorAll('#screen-log .rw-chip').forEach(function (chip) {
      chip.addEventListener("click", function () {
        var newCat = state.selectedCategory === chip.dataset.cat ? null : chip.dataset.cat;
        state.selectedCategory = newCat;
        document.querySelectorAll('#screen-log .rw-chip').forEach(function (c) { c.classList.toggle("sel", c.dataset.cat === newCat); });
      });
    });
    document.getElementById("qa-submit").addEventListener("click", submitVariableExpense);
    document.getElementById("log-prev").addEventListener("click", function () { shiftLogMonth(-1); });
    document.getElementById("log-next").addEventListener("click", function () { shiftLogMonth(1); });
    document.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.deleteConfirmId = btn.dataset.del;
        renderLog();
        setTimeout(function () { if (state.deleteConfirmId === btn.dataset.del) { state.deleteConfirmId = null; renderLog(); } }, 3000);
      });
    });
    document.querySelectorAll('[data-confirm-del]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await supabase.from("expenses").delete().eq("id", btn.dataset.confirmDel);
        state.expenses = state.expenses.filter(function (e) { return e.id !== btn.dataset.confirmDel; });
        state.deleteConfirmId = null;
        renderLog(); renderAnalysis();
      });
    });
    document.querySelectorAll('[data-edit-expense]').forEach(function (btn) {
      btn.addEventListener("click", function () { state.editingExpenseId = btn.dataset.editExpense; renderLog(); });
    });
    document.querySelectorAll('[data-cancel-expense]').forEach(function (btn) {
      btn.addEventListener("click", function () { state.editingExpenseId = null; renderLog(); });
    });
    document.querySelectorAll('[data-save-expense]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.dataset.saveExpense;
        var description = document.getElementById("ee-desc-" + id).value.trim();
        var category = document.getElementById("ee-cat-" + id).value;
        var amount = parseFloat(document.getElementById("ee-amount-" + id).value);
        var date = document.getElementById("ee-date-" + id).value;
        if (!amount || amount <= 0 || !date) return;
        var updates = { description: description || category, category: category, amount: Math.round(amount * 100) / 100, date: date };
        var { error } = await supabase.from("expenses").update(updates).eq("id", id);
        if (error) { alert("Couldn't save: " + error.message); return; }
        var expense = state.expenses.find(function (e) { return e.id === id; });
        if (expense) Object.assign(expense, updates);
        state.editingExpenseId = null;
        renderLog(); renderAnalysis();
      });
    });
  }

  function shiftLogMonth(delta) {
    state.viewMonthIdx = Math.max(0, state.viewMonthIdx + delta);
    renderLog(); renderBills(); renderAnalysis();
  }

  async function submitVariableExpense() {
    var amount = parseFloat(document.getElementById("qa-amount").value);
    if (!amount || amount <= 0 || !state.selectedCategory) return;
    var entry = {
      user_id: state.session.user.id,
      date: document.getElementById("qa-date").value,
      type: "Variable",
      category: state.selectedCategory,
      description: document.getElementById("qa-desc").value || state.selectedCategory,
      amount: Math.round(amount * 100) / 100
    };
    var { data, error } = await supabase.from("expenses").insert(entry).select().single();
    if (error) { alert("Couldn't save: " + error.message); return; }
    state.expenses.unshift(data);
    state.selectedCategory = null;
    renderLog(); renderAnalysis();
  }

  // ================= BILLS TAB =================
  function renderBills() {
    var el = document.getElementById("screen-bills");
    var d = viewDate();
    var statuses = billsStatusForMonth(d);
    var rows = statuses.map(function (b) {
      if (state.editingBillDefId === b.id) {
        var confirming = state.deleteBillConfirmId === b.id;
        return '<div class="rw-edit-row active" style="flex-wrap:wrap;">' +
          '<input type="text" id="billdef-name-' + b.id + '" value="' + b.name.replace(/"/g, "&quot;") + '" placeholder="Bill name" style="flex:1.6;min-width:120px;" />' +
          '<input type="number" id="billdef-amount-' + b.id + '" value="' + b.amount + '" placeholder="0.00" style="flex:1;min-width:80px;" />' +
          '<button class="icon-sm" data-save-billdef="' + b.id + '"><i class="ti ti-check"></i></button>' +
          '<button class="icon-sm" data-cancel-billdef="' + b.id + '"><i class="ti ti-x"></i></button>' +
          (confirming
            ? '<button class="icon-sm" data-confirm-delete-bill="' + b.id + '" style="color:var(--warn);font-weight:600;font-size:12px;">Delete bill?</button>'
            : '<button class="icon-sm" data-delete-bill="' + b.id + '" style="color:var(--warn);"><i class="ti ti-trash"></i></button>') +
        '</div>';
      }
      if (state.editingBillId === b.id) {
        return '<div class="rw-edit-row active">' +
          '<input type="number" id="bill-input-' + b.id + '" value="' + b.amount + '" style="flex:1;" />' +
          '<button class="icon-sm" data-save-bill="' + b.id + '" data-name="' + b.name.replace(/"/g, "&quot;") + '"><i class="ti ti-check"></i></button>' +
          '<button class="icon-sm" data-cancel-bill="' + b.id + '"><i class="ti ti-x"></i></button>' +
        '</div>';
      }
      var editBtn = '<button class="icon-sm" data-edit-bill-def="' + b.id + '" aria-label="Edit bill"><i class="ti ti-pencil"></i></button>';
      if (b.paid) {
        return '<div class="rw-row">' +
          '<div class="bill-name-wrap"><div style="font-size:15px;font-weight:500;">' + b.name + '</div><div style="font-size:13px;color:var(--muted);">Expected ' + fmtMoney(b.amount) + '</div></div>' +
          '<div class="bill-actions"><span style="font-size:15px;color:var(--good);">' + fmtMoney(b.paidAmount) + '</span>' +
          '<button class="icon-sm" data-undo-bill="' + b.entryId + '"><i class="ti ti-rotate-2"></i></button>' + editBtn + '</div></div>';
      }
      return '<div class="rw-row">' +
        '<div class="bill-name-wrap"><div style="font-size:15px;font-weight:500;">' + b.name + '</div><div style="font-size:13px;color:var(--muted);">Expected ' + fmtMoney(b.amount) + '</div></div>' +
        '<div class="bill-actions"><button class="mark-paid-btn" data-mark-paid="' + b.id + '">Mark paid</button>' + editBtn + '</div></div>';
    }).join("");

    el.innerHTML =
      '<div class="rw-monthnav"><span style="font-size:15px;font-weight:600;">' + monthNameYear(d) + '</span></div>' +
      '<div class="rw-card">' + (rows || '<div class="empty-note">No recurring bills yet.</div>') + '</div>' +
      '<button class="btn btn-secondary btn-full" id="add-bill-btn">+ Add recurring bill</button>' +
      '<div id="new-bill-row"></div>';

    document.querySelectorAll('[data-mark-paid]').forEach(function (btn) {
      btn.addEventListener("click", function () { state.editingBillId = btn.dataset.markPaid; renderBills(); });
    });
    document.querySelectorAll('[data-cancel-bill]').forEach(function (btn) {
      btn.addEventListener("click", function () { state.editingBillId = null; renderBills(); });
    });
    document.querySelectorAll('[data-edit-bill-def]').forEach(function (btn) {
      btn.addEventListener("click", function () { state.editingBillDefId = btn.dataset.editBillDef; renderBills(); });
    });
    document.querySelectorAll('[data-cancel-billdef]').forEach(function (btn) {
      btn.addEventListener("click", function () { state.editingBillDefId = null; state.deleteBillConfirmId = null; renderBills(); });
    });
    document.querySelectorAll('[data-save-billdef]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var billId = btn.dataset.saveBilldef;
        var name = document.getElementById("billdef-name-" + billId).value.trim();
        var amount = parseFloat(document.getElementById("billdef-amount-" + billId).value);
        if (!name || !amount || amount <= 0) return;
        var { error } = await supabase.from("recurring_bills").update({ name: name, amount: amount }).eq("id", billId);
        if (error) { alert("Couldn't save: " + error.message); return; }
        var bill = state.bills.find(function (b) { return b.id === billId; });
        if (bill) { bill.name = name; bill.amount = amount; }
        state.editingBillDefId = null;
        renderBills(); renderAnalysis();
      });
    });
    document.querySelectorAll('[data-delete-bill]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.deleteBillConfirmId = btn.dataset.deleteBill;
        renderBills();
        setTimeout(function () { if (state.deleteBillConfirmId === btn.dataset.deleteBill) { state.deleteBillConfirmId = null; renderBills(); } }, 3000);
      });
    });
    document.querySelectorAll('[data-confirm-delete-bill]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var billId = btn.dataset.confirmDeleteBill;
        var { error } = await supabase.from("recurring_bills").update({ archived: true }).eq("id", billId);
        if (error) { alert("Couldn't delete: " + error.message); return; }
        state.bills = state.bills.filter(function (b) { return b.id !== billId; });
        state.editingBillDefId = null; state.deleteBillConfirmId = null;
        renderBills(); renderAnalysis();
      });
    });
    document.querySelectorAll('[data-save-bill]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var billId = btn.dataset.saveBill;
        var amount = parseFloat(document.getElementById("bill-input-" + billId).value);
        if (!amount || amount <= 0) return;
        var bill = state.bills.find(function (b) { return b.id === billId; });
        var vd = viewDate();
        var dueDay = (bill && bill.due_day) ? bill.due_day : 1;
        var lastDay = new Date(vd.getFullYear(), vd.getMonth() + 1, 0).getDate();
        var payDate = new Date(vd.getFullYear(), vd.getMonth(), Math.min(dueDay, lastDay));
        var entry = { user_id: state.session.user.id, date: toDateStr(payDate), type: "Fixed", category: btn.dataset.name, description: btn.dataset.name, amount: amount, bill_id: billId };
        var { data, error } = await supabase.from("expenses").insert(entry).select().single();
        if (error) { alert("Couldn't save: " + error.message); return; }
        state.expenses.unshift(data);
        state.editingBillId = null;
        renderBills(); renderAnalysis(); renderLog();
      });
    });
    document.querySelectorAll('[data-undo-bill]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await supabase.from("expenses").delete().eq("id", btn.dataset.undoBill);
        state.expenses = state.expenses.filter(function (e) { return e.id !== btn.dataset.undoBill; });
        renderBills(); renderAnalysis(); renderLog();
      });
    });
    document.getElementById("add-bill-btn").addEventListener("click", function () {
      document.getElementById("new-bill-row").innerHTML =
        '<div class="rw-edit-row active" style="margin-top:10px;">' +
        '<input type="text" id="new-bill-name" placeholder="Bill name" style="flex:1.2;" />' +
        '<input type="number" id="new-bill-amount" placeholder="0.00" style="flex:1;" />' +
        '<button class="icon-sm" id="new-bill-save"><i class="ti ti-check"></i></button></div>';
      document.getElementById("new-bill-save").addEventListener("click", async function () {
        var name = document.getElementById("new-bill-name").value.trim();
        var amount = parseFloat(document.getElementById("new-bill-amount").value);
        if (!name || !amount) return;
        var { data, error } = await supabase.from("recurring_bills").insert({ user_id: state.session.user.id, name: name, amount: amount }).select().single();
        if (error) { alert("Couldn't save: " + error.message); return; }
        state.bills.push(data);
        renderBills(); renderAnalysis();
      });
    });
  }

  // ================= PLAN TAB =================
  function renderPlan() {
    var el = document.getElementById("screen-plan");
    var a = state.assumptions;
    var rows = runProjection();
    var depletion = findDepletion(rows);

    var cash = parseFloat(a.cash_on_hand) || 0;
    var investments = (parseFloat(a.investment_value_usd) || 0) * (parseFloat(a.usd_sgd_rate) || 0);
    var totalAssets = cash + investments;

    el.innerHTML =
      '<div class="rw-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;" id="toggle-assumptions">' +
          '<span style="font-size:15px;font-weight:500;">Edit assumptions</span>' +
          '<i class="ti ti-chevron-down" id="assumptions-chev" style="font-size:16px;color:var(--muted);"></i>' +
        '</div>' +
        '<div id="assumptions-body" style="display:' + (state.assumptionsOpen ? "block" : "none") + ';">' + assumptionsFormHtml(a, totalAssets) + '</div>' +
      '</div>' +
      (depletion ? renderDepletionWarning(depletion) : renderNoDepletionCard()) +
      (depletion ? renderRecommendations(rows) : "") +
      renderRoadmap(rows, a);

    document.getElementById("toggle-assumptions").addEventListener("click", function () {
      state.assumptionsOpen = !state.assumptionsOpen;
      renderPlan();
    });
    if (state.assumptionsOpen) wirePlanForm();
  }

  function assumptionsFormHtml(a, totalAssets) {
    var dobParts = (a.dob || "1990-01-01").split("-");
    var dobYear = dobParts[0], dobMonth = parseInt(dobParts[1], 10), dobDay = parseInt(dobParts[2], 10);
    var monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var monthOptions = monthNames.map(function (name, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === dobMonth ? " selected" : "") + '>' + name + '</option>'; }).join("");
    var dayOptions = ""; for (var dd = 1; dd <= 31; dd++) dayOptions += '<option value="' + dd + '"' + (dd === dobDay ? " selected" : "") + '>' + dd + '</option>';
    var yearOptions = ""; var thisYear = new Date().getFullYear();
    for (var yy = thisYear - 18; yy >= thisYear - 90; yy--) yearOptions += '<option value="' + yy + '"' + (String(yy) === dobYear ? " selected" : "") + '>' + yy + '</option>';

    var html = '<div style="margin-top:16px;padding-top:14px;border-top:0.5px solid var(--border);">' +
      '<div class="card-title">1. What you have today</div>' +
      '<div class="rw-field"><label>Cash on hand (S$)</label><input type="number" id="a-cash" value="' + a.cash_on_hand + '" /></div>' +
      '<div class="rw-field"><label>Investments (US$)</label><input type="number" id="a-invest-usd" value="' + a.investment_value_usd + '" /></div>' +
      '<div class="rw-field"><label>USD/SGD exchange rate</label><input type="number" step="0.01" id="a-fx" value="' + a.usd_sgd_rate + '" /></div>' +
      '<div class="rw-field"><label>CPF Ordinary Account (S$)</label><input type="number" id="a-cpf-oa" value="' + a.cpf_oa + '" /></div>' +
      '<div class="rw-field"><label>CPF Special Account (S$)</label><input type="number" id="a-cpf-sa" value="' + a.cpf_sa + '" /></div>' +
      '<div class="rw-field" style="margin-bottom:0;"><label>Monthly discretionary budget (S$)</label><input type="number" id="a-variable-budget" value="' + a.variable_budget + '" /></div>' +
      '<div class="total-row"><span style="color:var(--muted);font-weight:400;">Total assets</span><span>' + fmtMoney(totalAssets) + '</span></div>' +
    '</div>' +
    '<div style="margin-top:16px;padding-top:14px;border-top:0.5px solid var(--border);">' +
      '<div class="card-title">2. Your date of birth</div>' +
      '<div class="dob-row"><select id="a-dob-day">' + dayOptions + '</select><select id="a-dob-month">' + monthOptions + '</select><select id="a-dob-year">' + yearOptions + '</select></div>' +
    '</div>' +
    '<div style="margin-top:16px;padding-top:14px;border-top:0.5px solid var(--border);">' +
      '<div class="card-title">3. Income and semi-retirement</div>' +
      '<div class="subsection">When is semi-retirement?</div>' +
      semiRetireFieldsHtml(a) +
      '<div class="subsection" style="margin-top:16px;">What you\'ll earn, and when</div>' +
      '<div class="card-sub">Add a period each time your income changes &mdash; during semi-retirement this could be $0, or a lower ongoing amount.</div>' +
      periodRowsHtml() +
      '<button class="btn btn-secondary btn-full" id="add-period-btn" style="border-style:dashed;">+ Add another period</button>' +
    '</div>' +
    '<div style="margin-top:16px;padding-top:14px;border-top:0.5px solid var(--border);">' +
      '<div class="card-title">4. Any one-time windfall?</div>' +
      '<div class="card-sub">Leave amount at $0 if this doesn\'t apply to you</div>' +
      '<div class="rw-field"><label>Windfall amount (S$)</label><input type="number" id="a-windfall-amount" value="' + (a.windfall_amount || 0) + '" /></div>' +
      windfallDateFieldsHtml(a) +
    '</div>' +
    '<button class="btn btn-primary btn-full" id="save-assumptions" style="margin-top:16px;">Save &amp; recalculate</button>' +
    '<div id="recalc-status" style="font-size:13px;color:var(--good);margin-top:8px;text-align:center;min-height:14px;"></div>';
    return html;
  }

  function monthYearSelectHtml(idPrefix, dateVal) {
    var monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    var d = dateVal ? new Date(dateVal + "T00:00:00") : new Date();
    var monthOptions = monthNames.map(function (name, i) { return '<option value="' + (i + 1) + '"' + (i === d.getMonth() ? " selected" : "") + '>' + name + '</option>'; }).join("");
    var yearOptions = ""; var thisYear = new Date().getFullYear();
    for (var yy = thisYear; yy <= thisYear + 40; yy++) yearOptions += '<option value="' + yy + '"' + (yy === d.getFullYear() ? " selected" : "") + '>' + yy + '</option>';
    return '<div class="dob-row"><select id="' + idPrefix + '-month">' + monthOptions + '</select><select id="' + idPrefix + '-year">' + yearOptions + '</select></div>';
  }

  function semiRetireFieldsHtml(a) {
    return '<div class="rw-field"><div class="napp-row">' +
      '<input type="checkbox" id="a-semiretire-na" ' + (!a.semi_retire_date ? "checked" : "") + ' /><label for="a-semiretire-na">Not set yet</label></div>' +
      '<div id="semiretire-date-wrap" style="display:' + (a.semi_retire_date ? "block" : "none") + ';">' + monthYearSelectHtml("a-semiretire", a.semi_retire_date) + '</div></div>';
  }

  function windfallDateFieldsHtml(a) {
    return '<div class="rw-field" style="margin-bottom:0;"><label>Estimated period</label>' + monthYearSelectHtml("a-windfall", a.windfall_date) + '</div>';
  }

  function periodRowHtmlForIndex(idx) {
    var p = state.incomePeriods[idx];
    var d = new Date(p.start_date + "T00:00:00");
    var names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var label = idx === 0 ? "Now" : names[d.getMonth()] + " " + d.getFullYear();
    var isFirst = idx === 0;
    var pid = p.id || ("new" + idx);
    return '<div class="period-row" data-period-row="' + pid + '">' +
      (isFirst
        ? '<input class="period-when" type="text" value="Now" disabled />'
        : '<input class="period-when period-when-edit" type="text" value="' + label + '" data-period-id="' + pid + '" readonly style="cursor:pointer;" />') +
      '<input class="period-amt" type="number" id="period-amt-' + pid + '" value="' + p.amount + '" placeholder="$/month" />' +
      (isFirst ? "" : '<i class="ti ti-trash" data-delete-period="' + pid + '" style="font-size:16px;color:var(--warn);flex-shrink:0;cursor:pointer;" aria-hidden="true"></i>') +
    '</div>' +
    (isFirst ? "" : '<div class="period-date-editor" id="period-date-editor-' + pid + '" style="display:none;margin:-4px 0 10px;">' + monthYearSelectHtml("period-date-" + pid, p.start_date) + '</div>');
  }

  function periodRowsHtml() {
    return state.incomePeriods.map(function (p, idx) { return periodRowHtmlForIndex(idx); }).join("");
  }

  function renderDepletionWarning(depletion) {
    return '<div class="rw-card" style="border-color:#F0997B;background:var(--warn-bg);">' +
      '<div style="display:flex;align-items:flex-start;gap:10px;">' +
        '<i class="ti ti-alert-triangle" style="font-size:20px;color:var(--warn);margin-top:1px;"></i>' +
        '<div><div style="font-size:15px;font-weight:500;">This plan runs out of money</div>' +
        '<div style="font-size:13px;color:var(--muted);margin-top:2px;">Liquid assets hit $0 around <strong>age ' + depletion.age + '</strong>, ' + monthNameYear(depletion.date) + '.</div></div>' +
      '</div></div>';
  }

  function renderNoDepletionCard() {
    return '<div class="rw-card" style="border-color:#9fd6b8;background:var(--good-bg);">' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<i class="ti ti-check" style="font-size:20px;color:var(--good);"></i>' +
        '<div style="font-size:15px;font-weight:500;">This plan does not run out of money through 65</div>' +
      '</div></div>';
  }

  function renderRecommendations(rows) {
    var a = engineAssumptions();
    var semiRetireIdx = -1;
    if (state.assumptions.semi_retire_date) {
      for (var i = 0; i < state.incomePeriods.length; i++) {
        if (state.incomePeriods[i].start_date === state.assumptions.semi_retire_date) { semiRetireIdx = i; break; }
      }
    }
    if (semiRetireIdx === -1 && state.incomePeriods.length > 1) semiRetireIdx = state.incomePeriods.length - 1;
    if (semiRetireIdx === -1) return "";

    var delay = findFeasibleDelay(a, PROJECTION_MONTHS, semiRetireIdx, 20);
    var minIncome = findMinimumIncome(a, PROJECTION_MONTHS, semiRetireIdx, 20000);

    var cards = "";
    if (delay != null) {
      cards += '<div class="rec-card">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><i class="ti ti-calendar-time" style="font-size:16px;color:var(--gold);"></i><span style="font-size:14px;font-weight:500;">Delay that period</span></div>' +
        '<div style="font-size:13px;color:var(--muted);">Push it back about <strong>' + delay.toFixed(1) + ' years</strong> to avoid running out of money.</div></div>';
    }
    if (minIncome != null) {
      cards += '<div class="rec-card" style="margin-bottom:0;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><i class="ti ti-briefcase" style="font-size:16px;color:var(--good);"></i><span style="font-size:14px;font-weight:500;">Earn more during that period</span></div>' +
        '<div style="font-size:13px;color:var(--muted);">Raise that period\'s income to at least <strong>' + fmtMoney(minIncome) + '/month</strong>, keeping the same date.</div></div>';
    }
    if (!cards) return "";
    return '<div class="rw-card"><div style="font-size:15px;font-weight:500;margin-bottom:12px;">Ways to fix it</div>' + cards + '</div>';
  }

  function renderRoadmap(rows, a) {
    var startLiquid = (parseFloat(a.cash_on_hand) || 0) + (parseFloat(a.investment_value_usd) || 0) * (parseFloat(a.usd_sgd_rate) || 0);
    var startCpf = (parseFloat(a.cpf_oa) || 0) + (parseFloat(a.cpf_sa) || 0);
    var age = currentAgeYears();

    var stops = [{ label: "Now" + (age != null ? " &middot; age " + age : ""), liquid: startLiquid, cpf: startCpf }];

    if (a.semi_retire_date) {
      var idx = monthsFromStartToDateSafe(a.start_date, a.semi_retire_date) - 1;
      var r = idx >= 0 && rows[idx] ? rows[idx] : null;
      stops.push({ label: "Semi-retirement &middot; " + monthNameYear(new Date(a.semi_retire_date + "T00:00:00")), liquid: r ? r.liquid : startLiquid, cpf: r ? r.cpf : startCpf });
    }

    if (a.dob) {
      var idx55 = monthsFromStartToAge(a.dob, a.start_date, 55) - 1;
      var r55 = rows[idx55];
      if (r55) stops.push({ label: "Age 55", liquid: r55.liquid, cpf: r55.cpf });

      var idx65 = monthsFromStartToAge(a.dob, a.start_date, 65) - 1;
      var r65 = rows[idx65];
      if (r65) stops.push({ label: "Age 65", liquid: r65.liquid, cpf: r65.cpf, cpfLifeMonthly: r65.cpfLifeMonthly });
    }

    var dotColors = ["var(--good)", "var(--gold)", "var(--muted)", "var(--muted)"];
    var html = '<div class="rw-card"><div style="font-size:15px;font-weight:500;margin-bottom:14px;">Roadmap to 65</div>';
    stops.forEach(function (s, i) {
      var isLast = i === stops.length - 1;
      html += '<div style="display:flex;">' +
        '<div style="display:flex;flex-direction:column;align-items:center;width:20px;flex-shrink:0;">' +
        '<div style="width:10px;height:10px;border-radius:50%;background:' + dotColors[i % dotColors.length] + ';"></div>' +
        (isLast ? "" : '<div style="width:1.5px;flex:1;background:var(--border-strong);min-height:52px;"></div>') +
        '</div><div style="padding-bottom:' + (isLast ? "0" : "20px") + ';">' +
        '<div style="font-size:15px;font-weight:500;">' + s.label + '</div>' +
        '<div style="font-size:13px;color:var(--muted);margin:4px 0 2px;">Liquid assets</div>' +
        '<div style="font-size:17px;font-weight:500;' + (s.liquid < 0 ? "color:var(--warn);" : "") + '">' + fmtMoney(s.liquid) + '</div>' +
        '<div style="font-size:13px;color:var(--muted);margin:6px 0 2px;">CPF (OA + SA)' + (s.cpfLifeMonthly ? ", post-payout" : "") + '</div>' +
        '<div style="font-size:17px;font-weight:500;">' + fmtMoney(s.cpf) + '</div>' +
        (s.cpfLifeMonthly ? '<div style="background:var(--surface-2);border-radius:8px;padding:8px 10px;margin-top:8px;"><div style="font-size:13px;color:var(--muted);">CPF LIFE payout, fixed for life</div><div style="font-size:15px;font-weight:500;">' + fmtMoney(s.cpfLifeMonthly) + '/mo</div><div style="font-size:12px;color:var(--muted-2);margin-top:2px;">Not yet reflected in the liquid figure above</div></div>' : "") +
        '</div></div>';
    });
    html += "</div>";
    return html;
  }

  function monthsFromStartToDateSafe(startDate, dateStr) {
    var start = new Date(startDate + "T00:00:00");
    var d = new Date(dateStr + "T00:00:00");
    return (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
  }

  function wirePeriodRowEvents(pid) {
    var toggle = document.querySelector('.period-when-edit[data-period-id="' + pid + '"]');
    if (toggle) {
      toggle.addEventListener("click", function () {
        var editor = document.getElementById("period-date-editor-" + pid);
        if (editor) editor.style.display = editor.style.display === "none" ? "block" : "none";
      });
    }
    var delBtn = document.querySelector('[data-delete-period="' + pid + '"]');
    if (delBtn) {
      delBtn.addEventListener("click", function () {
        var row = document.querySelector('[data-period-row="' + pid + '"]');
        var editor = document.getElementById("period-date-editor-" + pid);
        if (row) row.remove();
        if (editor) editor.remove();
        state.incomePeriods = state.incomePeriods.filter(function (p, i) { return (p.id || ("new" + i)) !== pid; });
      });
    }
  }

  function wirePlanForm() {
    document.getElementById("a-semiretire-na").addEventListener("change", function () {
      document.getElementById("semiretire-date-wrap").style.display = this.checked ? "none" : "block";
    });
    document.getElementById("add-period-btn").addEventListener("click", function () {
      var newDate = new Date();
      var newPeriod = { id: null, start_date: toDateStr(newDate), amount: 0, _isNew: true };
      state.incomePeriods.push(newPeriod);
      var idx = state.incomePeriods.length - 1;
      var pid = "new" + idx;
      var wrapper = document.createElement("div");
      wrapper.innerHTML = periodRowHtmlForIndex(idx);
      var addBtn = document.getElementById("add-period-btn");
      while (wrapper.firstChild) addBtn.parentNode.insertBefore(wrapper.firstChild, addBtn);
      wirePeriodRowEvents(pid);
    });
    state.incomePeriods.forEach(function (p, i) { wirePeriodRowEvents(p.id || ("new" + i)); });
    document.getElementById("save-assumptions").addEventListener("click", saveAssumptionsAndPeriods);
  }

  async function saveAssumptionsAndPeriods() {
    var userId = state.session.user.id;
    var dobDay = document.getElementById("a-dob-day").value.padStart(2, "0");
    var dobMonth = document.getElementById("a-dob-month").value.padStart(2, "0");
    var dobYear = document.getElementById("a-dob-year").value;
    var dob = dobYear + "-" + dobMonth + "-" + dobDay;

    var semiRetireNA = document.getElementById("a-semiretire-na").checked;
    var semiRetireDate = null;
    if (!semiRetireNA) {
      var srMonth = document.getElementById("a-semiretire-month").value.padStart(2, "0");
      var srYear = document.getElementById("a-semiretire-year").value;
      semiRetireDate = srYear + "-" + srMonth + "-01";
    }

    var windfallMonth = document.getElementById("a-windfall-month").value.padStart(2, "0");
    var windfallYear = document.getElementById("a-windfall-year").value;
    var windfallAmount = parseFloat(document.getElementById("a-windfall-amount").value) || 0;

    var updates = {
      dob: dob,
      cash_on_hand: parseFloat(document.getElementById("a-cash").value) || 0,
      investment_value_usd: parseFloat(document.getElementById("a-invest-usd").value) || 0,
      usd_sgd_rate: parseFloat(document.getElementById("a-fx").value) || 1,
      cpf_oa: parseFloat(document.getElementById("a-cpf-oa").value) || 0,
      cpf_sa: parseFloat(document.getElementById("a-cpf-sa").value) || 0,
      variable_budget: parseFloat(document.getElementById("a-variable-budget").value) || 0,
      semi_retire_date: semiRetireDate,
      windfall_amount: windfallAmount,
      windfall_date: windfallAmount > 0 ? (windfallYear + "-" + windfallMonth + "-01") : null
    };
    var { error } = await supabase.from("assumptions").update(updates).eq("user_id", userId);
    if (error) { alert("Couldn't save: " + error.message); return; }
    Object.assign(state.assumptions, updates);

    // Sync income periods: read current amounts/dates from the form, upsert/delete as needed
    var newPeriodsList = [];
    for (var i = 0; i < state.incomePeriods.length; i++) {
      var p = state.incomePeriods[i];
      var pid = p.id || ("new" + i);
      var amountInput = document.getElementById("period-amt-" + pid);
      if (!amountInput) continue;
      var amount = parseFloat(amountInput.value) || 0;
      var startDate = p.start_date;
      if (i > 0) {
        var dateMonthEl = document.getElementById("period-date-" + pid + "-month");
        var dateYearEl = document.getElementById("period-date-" + pid + "-year");
        if (dateMonthEl && dateYearEl) startDate = dateYearEl.value + "-" + dateMonthEl.value.padStart(2, "0") + "-01";
      }
      newPeriodsList.push({ id: p.id, start_date: startDate, amount: amount });
    }

    var existingIds = newPeriodsList.filter(function (p) { return p.id; }).map(function (p) { return p.id; });
    var { data: currentDbPeriods } = await supabase.from("income_periods").select("id").eq("user_id", userId);
    var toDelete = (currentDbPeriods || []).filter(function (row) { return existingIds.indexOf(row.id) === -1; });
    for (var d = 0; d < toDelete.length; d++) await supabase.from("income_periods").delete().eq("id", toDelete[d].id);

    for (var j = 0; j < newPeriodsList.length; j++) {
      var np = newPeriodsList[j];
      if (np.id) {
        await supabase.from("income_periods").update({ start_date: np.start_date, amount: np.amount }).eq("id", np.id);
      } else {
        var { data: inserted } = await supabase.from("income_periods").insert({ user_id: userId, start_date: np.start_date, amount: np.amount }).select().single();
        if (inserted) np.id = inserted.id;
      }
    }
    state.incomePeriods = newPeriodsList;

    renderPlan(); renderAnalysis();
    document.getElementById("recalc-status").textContent = "Recalculated from your updated assumptions.";
  }

  // ---------------- Tabs ----------------
  function initTabs() {
    var titles = { analysis: "Analysis", log: "Log expense", bills: "Recurring bills", plan: "Plan to 65" };
    document.querySelectorAll(".rw-tabbtn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tab = btn.dataset.tab;
        state.activeTab = tab;
        document.querySelectorAll(".rw-tabbtn").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        document.querySelectorAll(".rw-screen").forEach(function (s) { s.classList.remove("active"); });
        document.querySelector('.rw-screen[data-screen="' + tab + '"]').classList.add("active");
        document.getElementById("rw-title").textContent = titles[tab];
      });
    });
  }

  // ---------------- Bootstrap ----------------
  function init() {
    initAuthScreen();
    initTabs();
    document.getElementById("signout-btn").addEventListener("click", async function () {
      await supabase.auth.signOut();
    });
    supabase.auth.onAuthStateChange(function (event, session) { handleSession(session); });
    supabase.auth.getSession().then(function (res) { handleSession(res.data.session); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.__runwayTestHooks = { state: state, engineAssumptions: engineAssumptions, runProjection: runProjection };
})();
