(function () {
  "use strict";

  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage, storageKey: "runway-auth" }
  });

  var VARIABLE_CATEGORIES = ["Vacation/Travel", "Dining & Groceries", "Shopping", "Transport (non-car)",
    "Entertainment/Subscriptions", "Health/Wellness", "Gifts", "Other"];

  var DEFAULT_BILLS = [];

  var DEFAULT_ASSUMPTIONS = {
    dob: "1990-01-01", target_age: 45,
    monthly_income: 0, cpf_employee: 0, cpf_employer: 0, income_tax_monthly: 0,
    bonus_pct: 0, bonus_month: 3, switch_month: 999, post_switch_income: 0, post_switch_tax_pct: 0.10,
    tax_lag_months: 12, settle_month: 999, settle_cash: 0, cpf_refund: 0,
    cash_on_hand: 0, investment_value_usd: 0, usd_sgd_rate: 1.29, cpf_oa: 0, cpf_sa: 0,
    investment_return_annual: 0.07, cpf_return_annual: 0.033, bridge_target: 1000000, variable_budget: 0
  };

  var state = {
    session: null, bills: [], expenses: [], assumptions: null,
    viewMonthIdx: 0, selectedCategory: null, activeTab: "home",
    editingBillId: null, deleteConfirmId: null, assumptionsOpen: false,
    editingBillDefId: null, deleteBillConfirmId: null, homeChartView: "daily"
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
      if (result.error) {
        errEl.textContent = result.error.message;
        return;
      }
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
  }

  async function loadAllData() {
    var userId = state.session.user.id;
    var [billsRes, expensesRes, assumptionsRes] = await Promise.all([
      supabase.from("recurring_bills").select("*").eq("user_id", userId).eq("archived", false).order("created_at"),
      supabase.from("expenses").select("*").eq("user_id", userId).order("date", { ascending: false }),
      supabase.from("assumptions").select("*").eq("user_id", userId).maybeSingle()
    ]);
    state.bills = billsRes.data || [];
    state.expenses = expensesRes.data || [];
    state.assumptions = assumptionsRes.data || Object.assign({ user_id: userId }, DEFAULT_ASSUMPTIONS);
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
      result[k] = {
        fixed: map[k].hasFixed ? map[k].fixed : null,
        variable: map[k].hasVariable ? map[k].variable : null
      };
    });
    return result;
  }

  function engineAssumptions() {
    var a = state.assumptions;
    return {
      monthly_income: +a.monthly_income, cpf_employee: +a.cpf_employee, cpf_employer: +a.cpf_employer,
      income_tax_monthly: +a.income_tax_monthly, bonus_pct: +a.bonus_pct, bonus_month: +a.bonus_month,
      switch_month: +a.switch_month, post_switch_income: +a.post_switch_income, post_switch_tax_pct: +a.post_switch_tax_pct,
      tax_lag_months: +a.tax_lag_months, settle_month: +a.settle_month, settle_cash: +a.settle_cash,
      cpf_refund: +a.cpf_refund, cash_on_hand: +a.cash_on_hand, investment_value_sgd: +a.investment_value_usd * +a.usd_sgd_rate,
      cpf_oa: +a.cpf_oa, cpf_sa: +a.cpf_sa, investment_return_annual: +a.investment_return_annual,
      cpf_return_annual: +a.cpf_return_annual, fixed_budget: fixedBudgetTotal(), variable_budget: +a.variable_budget,
      start_date: a.start_date
    };
  }

  function monthsFromStartToAge(targetAge) {
    var dob = new Date(state.assumptions.dob + "T00:00:00");
    var start = new Date(state.assumptions.start_date + "T00:00:00");
    var targetDate = new Date(dob.getFullYear() + targetAge, dob.getMonth(), dob.getDate());
    var months = (targetDate.getFullYear() - start.getFullYear()) * 12 + (targetDate.getMonth() - start.getMonth());
    return Math.max(1, months);
  }

  function runProjection() {
    var a = engineAssumptions();
    var months = monthsFromStartToAge(state.assumptions.target_age) + 1;
    var actuals = actualsByMonth();
    return simulateMonths(a, Math.max(months, 1), actuals);
  }

  function currentAgeYears() {
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

  function monthKeyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1); }

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

  // ---------------- Rendering ----------------
  function renderAll() {
    renderHome();
    renderLog();
    renderBills();
    renderAnalysis();
    renderPlan();
  }

  function dailyVariableSeries(now) {
    var year = now.getFullYear(), month = now.getMonth();
    var dim = new Date(year, month + 1, 0).getDate();
    var todayDay = now.getDate();
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
      if (d <= todayDay) {
        acc += dayTotals[d] || 0;
        cumulative.push(acc);
      } else {
        cumulative.push(null);
      }
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

  var homeChart = null;

  function renderHome() {
    var el = document.getElementById("screen-home");
    var rows = runProjection();
    var cash = state.assumptions.cash_on_hand;
    var investments = state.assumptions.investment_value_usd * state.assumptions.usd_sgd_rate;
    var totalAssets = cash + investments;
    var bridgeIdx = monthsFromStartToAge(state.assumptions.target_age) - 1;
    var atTarget = rows[Math.min(bridgeIdx, rows.length - 1)];
    var projected = atTarget ? atTarget.liquid : 0;
    var gap = state.assumptions.bridge_target - projected;

    var startDate = new Date(state.assumptions.start_date + "T00:00:00");
    var now = new Date();
    if (now < startDate) now = startDate;
    var dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var day = now.getDate();
    var fixedBudget = fixedBudgetTotal();
    var variableBudget = parseFloat(state.assumptions.variable_budget);
    var totalBudget = fixedBudget + variableBudget;
    var thisKey = monthKeyOf(now);
    var actual = actualsByMonth()[thisKey] || {};
    var variableSoFar = actual.variable != null ? actual.variable : 0;
    var fixedForTotal = actual.fixed != null ? actual.fixed : fixedBudget;
    var fullMonthTotal = variableSoFar + fixedForTotal;
    var spentSoFar = (actual.fixed != null ? actual.fixed : 0) + variableSoFar;
    var pctSpent = totalBudget > 0 ? Math.round((spentSoFar / totalBudget) * 100) : 0;
    var pctDays = Math.round((day / dim) * 100);

    el.innerHTML =
      '<div class="stat-grid3">' +
        '<div class="stat-box"><div class="stat-label">Cash on hand</div><div class="stat-value">' + fmtMoney(cash) + '</div></div>' +
        '<div class="stat-box"><div class="stat-label">Investments</div><div class="stat-value">' + fmtMoney(investments) + '</div></div>' +
        '<div class="stat-box"><div class="stat-label">Total assets</div><div class="stat-value">' + fmtMoney(totalAssets) + '</div></div>' +
      '</div>' +
      '<div class="stat-grid">' +
        '<div class="stat-box"><div class="stat-label">Projected at ' + state.assumptions.target_age + '</div><div class="stat-value">' + fmtMoney(projected) + '</div></div>' +
        (gap > 0
          ? '<div class="stat-box" style="border-color:#F0997B;"><div class="stat-label" style="display:flex;align-items:center;gap:5px;"><i class="ti ti-trending-down" style="font-size:14px;color:var(--warn);"></i>Short of target</div><div class="stat-value" style="color:var(--warn);">' + fmtMoney(gap) + '</div></div>'
          : '<div class="stat-box" style="border-color:#9fd6b8;"><div class="stat-label" style="display:flex;align-items:center;gap:5px;"><i class="ti ti-trending-up" style="font-size:14px;color:var(--good);"></i>Ahead of target</div><div class="stat-value" style="color:var(--good);">' + fmtMoney(-gap) + '</div></div>') +
      '</div>' +
      '<div class="rw-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<div style="font-size:15px;font-weight:500;">Spend</div>' +
          '<div class="seg" style="width:150px;">' +
            '<button id="home-btn-daily" class="' + (state.homeChartView !== "monthly" ? "active" : "") + '">Daily</button>' +
            '<button id="home-btn-monthly" class="' + (state.homeChartView === "monthly" ? "active" : "") + '">Monthly</button>' +
          '</div>' +
        '</div>' +
        '<div style="background:var(--surface-2);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">' +
          '<div><div style="font-size:12px;color:var(--muted);">Full month total, incl. recurring bills</div>' +
          '<div style="font-size:20px;font-weight:500;">' + fmtMoney(fullMonthTotal) + ' <span style="font-size:14px;font-weight:400;color:var(--muted);">of ' + fmtMoney(totalBudget) + '</span></div></div>' +
          '<i class="ti ti-receipt-2" style="font-size:23px;color:var(--muted-2);"></i>' +
        '</div>' +
        '<div id="home-chart-legend" style="display:' + (state.homeChartView === "monthly" ? "none" : "flex") + ';flex-wrap:wrap;gap:14px;margin-bottom:10px;font-size:13px;color:var(--muted);">' +
          '<span style="display:flex;align-items:center;gap:5px;"><span class="swatch" style="border-top:2px solid #2a78d6;"></span>Variable spend</span>' +
          '<span style="display:flex;align-items:center;gap:5px;"><span class="swatch" style="border-top:2px dashed var(--warn);"></span>Variable budget</span>' +
        '</div>' +
        '<div style="position:relative;width:100%;height:220px;">' +
          '<canvas id="homeChart"></canvas>' +
        '</div>' +
      '</div>' +
      '<div class="rw-card">' +
        '<div style="display:flex;justify-content:space-between;font-size:15px;margin-bottom:8px;"><span style="color:var(--muted);">This month</span><span style="font-weight:600;">' + fmtMoney(spentSoFar) + ' of ' + fmtMoney(totalBudget) + '</span></div>' +
        '<div class="pace-bar-track"><div class="pace-bar-fill" style="width:' + Math.min(100, pctSpent) + '%;background:' + (pctSpent > pctDays ? "var(--warn)" : "var(--good)") + ';"></div></div>' +
        '<div style="font-size:13px;color:var(--muted);margin-top:6px;">Day ' + day + ' of ' + dim + ' &middot; ' + monthNameYear(now) + ', ' + (pctSpent > pctDays ? "ahead of pace" : "on pace") + '</div>' +
      '</div>';

    renderHomeChart(now);
    document.getElementById("home-btn-daily").addEventListener("click", function () {
      state.homeChartView = "daily";
      renderHome();
    });
    document.getElementById("home-btn-monthly").addEventListener("click", function () {
      state.homeChartView = "monthly";
      renderHome();
    });
  }

  function renderHomeChart(now) {
    var canvas = document.getElementById("homeChart");
    if (!canvas || typeof Chart === "undefined") return;
    if (homeChart) { homeChart.destroy(); homeChart = null; }

    if (state.homeChartView === "monthly") {
      var m = monthlyTotalsSeries(now, 6);
      homeChart = new Chart(canvas, {
        type: "bar",
        data: { labels: m.labels, datasets: [{ data: m.totals, backgroundColor: "#2a78d6", borderRadius: 4, maxBarThickness: 28 }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#898781", font: { size: 11 } } },
            y: { grid: { color: "#e1e0d9" }, ticks: { color: "#898781", font: { size: 11 }, callback: function (v) { return "$" + (v / 1000) + "k"; } } }
          }
        }
      });
    } else {
      var s = dailyVariableSeries(now);
      var budgetVal = parseFloat(state.assumptions.variable_budget);
      var budgetLine = s.labels.map(function () { return budgetVal; });
      homeChart = new Chart(canvas, {
        type: "line",
        data: {
          labels: s.labels,
          datasets: [
            { label: "Variable spend", data: s.cumulative, borderColor: "#2a78d6", borderWidth: 2.5, pointRadius: 0, tension: 0, fill: false, spanGaps: false },
            { label: "Variable budget", data: budgetLine, borderColor: "#B5502E", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, fill: false }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: "#898781", maxTicksLimit: 8, font: { size: 11 } } },
            y: { grid: { color: "#e1e0d9" }, ticks: { color: "#898781", font: { size: 11 }, callback: function (v) { return "$" + v; } } }
          }
        }
      });
    }
  }

  function renderLog() {
    var el = document.getElementById("screen-log");
    var d = viewDate();
    var key = monthKeyOf(d);
    var monthEntries = state.expenses.filter(function (e) { return e.date.slice(0, 7) === key; })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    var atStart = state.viewMonthIdx === 0;
    var todayStr = toDateStr(new Date());
    var minDateStr = state.assumptions.start_date;
    var defaultDateStr = todayStr < minDateStr ? minDateStr : todayStr;

    var chips = VARIABLE_CATEGORIES.map(function (c) {
      var sel = state.selectedCategory === c ? " sel" : "";
      return '<span class="rw-chip' + sel + '" data-cat="' + c + '">' + c + '</span>';
    }).join("");

    var rows = monthEntries.length ? monthEntries.map(function (e) {
      var confirming = state.deleteConfirmId === e.id;
      return '<div class="rw-row">' +
        '<div><div style="font-size:15px;font-weight:500;">' + (e.description || e.category) + '</div>' +
        '<div style="font-size:13px;color:var(--muted);">' + e.date.slice(5) + ', ' + e.category + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:15px;">' + fmtMoney(e.amount) + '</span>' +
        (confirming
          ? '<button class="icon-sm" data-confirm-del="' + e.id + '" style="color:var(--warn);font-weight:600;font-size:13px;">Delete?</button>'
          : '<button class="icon-sm" data-del="' + e.id + '"><i class="ti ti-trash"></i></button>') +
        '</div></div>';
    }).join("") : '<div class="empty-note">No transactions logged for this month yet.</div>';

    el.innerHTML =
      '<input id="qa-amount" type="text" inputmode="decimal" placeholder="0.00" style="width:100%;font-size:25px;padding:10px 12px;margin-bottom:12px;" />' +
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
      '<div style="font-size:14px;color:var(--muted);margin-bottom:8px;">Transactions</div>' +
      '<div class="rw-card">' + rows + '</div>';

    document.querySelectorAll('#screen-log .rw-chip').forEach(function (chip) {
      chip.addEventListener("click", function () {
        var newCat = state.selectedCategory === chip.dataset.cat ? null : chip.dataset.cat;
        state.selectedCategory = newCat;
        document.querySelectorAll('#screen-log .rw-chip').forEach(function (c) {
          c.classList.toggle("sel", c.dataset.cat === newCat);
        });
      });
    });
    document.getElementById("qa-submit").addEventListener("click", submitVariableExpense);
    document.getElementById("log-prev").addEventListener("click", function () { shiftMonth(-1); });
    document.getElementById("log-next").addEventListener("click", function () { shiftMonth(1); });
    document.querySelectorAll('[data-del]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.deleteConfirmId = btn.dataset.del;
        renderLog();
        setTimeout(function () {
          if (state.deleteConfirmId === btn.dataset.del) { state.deleteConfirmId = null; renderLog(); }
        }, 3000);
      });
    });
    document.querySelectorAll('[data-confirm-del]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await supabase.from("expenses").delete().eq("id", btn.dataset.confirmDel);
        state.expenses = state.expenses.filter(function (e) { return e.id !== btn.dataset.confirmDel; });
        state.deleteConfirmId = null;
        renderLog(); renderHome(); renderAnalysis();
      });
    });
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
    renderLog(); renderHome(); renderAnalysis();
  }

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
          '<div><div style="font-size:15px;font-weight:500;">' + b.name + '</div><div style="font-size:13px;color:var(--muted);">Expected ' + fmtMoney(b.amount) + '</div></div>' +
          '<div style="display:flex;align-items:center;gap:10px;"><span style="font-size:15px;color:var(--good);">' + fmtMoney(b.paidAmount) + '</span>' +
          '<button class="icon-sm" data-undo-bill="' + b.entryId + '"><i class="ti ti-rotate-2"></i></button>' + editBtn + '</div></div>';
      }
      return '<div class="rw-row">' +
        '<div><div style="font-size:15px;font-weight:500;">' + b.name + '</div><div style="font-size:13px;color:var(--muted);">Expected ' + fmtMoney(b.amount) + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:10px;"><button class="btn btn-secondary" style="padding:7px 12px;font-size:14px;" data-mark-paid="' + b.id + '">Mark paid</button>' + editBtn + '</div></div>';
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
        renderBills(); renderHome();
      });
    });
    document.querySelectorAll('[data-delete-bill]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.deleteBillConfirmId = btn.dataset.deleteBill;
        renderBills();
        setTimeout(function () {
          if (state.deleteBillConfirmId === btn.dataset.deleteBill) { state.deleteBillConfirmId = null; renderBills(); }
        }, 3000);
      });
    });
    document.querySelectorAll('[data-confirm-delete-bill]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var billId = btn.dataset.confirmDeleteBill;
        var { error } = await supabase.from("recurring_bills").update({ archived: true }).eq("id", billId);
        if (error) { alert("Couldn't delete: " + error.message); return; }
        state.bills = state.bills.filter(function (b) { return b.id !== billId; });
        state.editingBillDefId = null;
        state.deleteBillConfirmId = null;
        renderBills(); renderHome();
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
        var entry = {
          user_id: state.session.user.id, date: toDateStr(payDate), type: "Fixed",
          category: btn.dataset.name, description: btn.dataset.name, amount: amount, bill_id: billId
        };
        var { data, error } = await supabase.from("expenses").insert(entry).select().single();
        if (error) { alert("Couldn't save: " + error.message); return; }
        state.expenses.unshift(data);
        state.editingBillId = null;
        renderBills(); renderHome(); renderLog();
      });
    });
    document.querySelectorAll('[data-undo-bill]').forEach(function (btn) {
      btn.addEventListener("click", async function () {
        await supabase.from("expenses").delete().eq("id", btn.dataset.undoBill);
        state.expenses = state.expenses.filter(function (e) { return e.id !== btn.dataset.undoBill; });
        renderBills(); renderHome(); renderLog();
      });
    });
    document.getElementById("add-bill-btn").addEventListener("click", function () {
      document.getElementById("new-bill-row").innerHTML =
        '<div class="rw-edit-row active" style="margin-top:10px;">' +
        '<input type="text" id="new-bill-name" placeholder="Bill name" style="flex:1.4;" />' +
        '<input type="number" id="new-bill-amount" placeholder="0.00" style="flex:1;" />' +
        '<button class="icon-sm" id="new-bill-save"><i class="ti ti-check"></i></button></div>';
      document.getElementById("new-bill-save").addEventListener("click", async function () {
        var name = document.getElementById("new-bill-name").value.trim();
        var amount = parseFloat(document.getElementById("new-bill-amount").value);
        if (!name || !amount) return;
        var { data, error } = await supabase.from("recurring_bills")
          .insert({ user_id: state.session.user.id, name: name, amount: amount }).select().single();
        if (error) { alert("Couldn't save: " + error.message); return; }
        state.bills.push(data);
        renderBills(); renderHome();
      });
    });
  }

  function renderAnalysis() {
    var el = document.getElementById("screen-analysis");
    var d = viewDate();
    var atStart = state.viewMonthIdx === 0;
    var cats = categoryBreakdownForMonth(d);
    var maxCat = cats.length ? cats[0].amount : 1;
    var catRows = cats.length ? cats.map(function (c) {
      var pct = Math.max(4, Math.round((c.amount / maxCat) * 100));
      return '<div class="cat-row"><div class="cat-name">' + c.category + '</div>' +
        '<div class="cat-bar-track"><div class="cat-bar-fill" style="width:' + pct + '%;"></div></div>' +
        '<div class="cat-amount">' + fmtMoney(c.amount) + '</div></div>';
    }).join("") : '<div class="empty-note">No variable spending logged yet this month.</div>';

    var prevKey = monthKeyOf(new Date(d.getFullYear(), d.getMonth() - 1, 1));
    var thisTotal = cats.reduce(function (s, c) { return s + c.amount; }, 0);
    var prevEntries = state.expenses.filter(function (e) { return e.date.slice(0, 7) === prevKey && e.type === "Variable"; });
    var prevTotal = prevEntries.reduce(function (s, e) { return s + parseFloat(e.amount); }, 0);
    var vsPrevText = atStart ? "No earlier month yet"
      : prevTotal === 0 ? "No data last month"
      : (thisTotal >= prevTotal ? "+" : "-") + Math.round(Math.abs(thisTotal - prevTotal) / prevTotal * 100) + "% vs last month";

    el.innerHTML =
      '<div class="rw-monthnav">' +
        '<button class="rw-monthbtn" id="an-prev" ' + (atStart ? "disabled" : "") + '><i class="ti ti-chevron-left"></i></button>' +
        '<span style="font-size:15px;font-weight:600;">' + monthNameYear(d) + '</span>' +
        '<button class="rw-monthbtn" id="an-next"><i class="ti ti-chevron-right"></i></button>' +
      '</div>' +
      '<div class="rw-card"><div style="font-size:14px;color:var(--muted);margin-bottom:10px;">By category</div>' + catRows + '</div>' +
      '<div class="rw-card" style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:15px;color:var(--muted);">Vs previous month</span>' +
        '<span style="font-size:15px;font-weight:600;">' + vsPrevText + '</span></div>';

    document.getElementById("an-prev").addEventListener("click", function () { shiftMonth(-1); });
    document.getElementById("an-next").addEventListener("click", function () { shiftMonth(1); });
  }

  function renderPlan() {
    var el = document.getElementById("screen-plan");
    var a = state.assumptions;
    var rows = runProjection();
    var bridgeIdx = Math.min(monthsFromStartToAge(a.target_age) - 1, rows.length - 1);
    var atTarget = rows[bridgeIdx];
    var gap = a.bridge_target - atTarget.liquid;
    var age55Idx = Math.min(monthsFromStartToAge(55) - 1, rows.length - 1);
    var age65Idx = Math.min(monthsFromStartToAge(65) - 1, rows.length - 1);

    el.innerHTML =
      '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">' +
        '<button class="btn btn-secondary" id="toggle-assumptions" style="font-size:14px;padding:7px 12px;display:flex;align-items:center;gap:6px;">' +
        '<i class="ti ti-adjustments"></i> Edit assumptions</button></div>' +
      '<div class="rw-card" id="assumptions-panel" style="display:' + (state.assumptionsOpen ? "block" : "none") + ';">' +
        assumptionsFormHtml(a) +
      '</div>' +
      '<div class="rw-card">' +
        '<div class="rw-row"><div><div style="font-size:15px;font-weight:500;">Now, age ' + currentAgeYears() + '</div>' +
          '<div style="font-size:13px;color:var(--muted);">' + fmtMoney(a.cash_on_hand) + ' cash on hand</div></div>' +
          '<i class="ti ti-check" style="color:var(--good);"></i></div>' +
        '<div class="rw-row"><div><div style="font-size:15px;font-weight:500;">Semi-retire, age ' + a.target_age + '</div>' +
          '<div style="font-size:13px;color:var(--muted);">Target ' + fmtMoney(a.bridge_target) + '</div></div>' +
          '<span style="font-size:13px;color:' + (gap > 0 ? "var(--warn)" : "var(--good)") + ';">' + (gap > 0 ? "Short " + fmtMoney(gap) : "Ahead " + fmtMoney(-gap)) + '</span></div>' +
        '<div class="rw-row"><div><div style="font-size:15px;font-weight:500;">CPF unlocks, age 55</div><div style="font-size:13px;color:var(--muted);">Partial withdrawal above your Full Retirement Sum</div></div><i class="ti ti-lock" style="color:var(--muted);"></i></div>' +
        '<div class="rw-row"><div><div style="font-size:15px;font-weight:500;">CPF LIFE begins, age 65</div><div style="font-size:13px;color:var(--muted);">Lifetime monthly payout starts</div></div><i class="ti ti-lock" style="color:var(--muted);"></i></div>' +
      '</div>';

    document.getElementById("toggle-assumptions").addEventListener("click", function () {
      state.assumptionsOpen = !state.assumptionsOpen;
      renderPlan();
    });
    if (state.assumptionsOpen) wireAssumptionsForm();
  }

  function assumptionsFormHtml(a) {
    var fields = [
      ["target_age", "Target semi-retire age", a.target_age],
      ["bridge_target", "Amount needed at retirement age (S$)", a.bridge_target],
      ["monthly_income", "Monthly gross income (S$)", a.monthly_income],
      ["investment_return_annual", "Annual investment return (as 0.07 = 7%)", a.investment_return_annual],
      ["switch_month", "Career switch in (months from now)", a.switch_month],
      ["post_switch_income", "Post-switch monthly income (S$)", a.post_switch_income],
      ["variable_budget", "Monthly discretionary budget (S$)", a.variable_budget],
      ["cash_on_hand", "Cash on hand (S$)", a.cash_on_hand],
      ["investment_value_usd", "Investment portfolio value (US$)", a.investment_value_usd],
      ["usd_sgd_rate", "USD/SGD exchange rate", a.usd_sgd_rate]
    ];
    var dobParts = a.dob.split("-");
    var dobYear = dobParts[0], dobMonth = parseInt(dobParts[1], 10), dobDay = parseInt(dobParts[2], 10);
    var monthOptions = ["January","February","March","April","May","June","July","August","September","October","November","December"]
      .map(function (name, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === dobMonth ? " selected" : "") + '>' + name + '</option>'; }).join("");
    var dayOptions = "";
    for (var dd = 1; dd <= 31; dd++) { dayOptions += '<option value="' + dd + '"' + (dd === dobDay ? " selected" : "") + '>' + dd + '</option>'; }
    var yearOptions = "";
    var thisYear = new Date().getFullYear();
    for (var yy = thisYear - 18; yy >= thisYear - 90; yy--) { yearOptions += '<option value="' + yy + '"' + (String(yy) === dobYear ? " selected" : "") + '>' + yy + '</option>'; }
    var dobField = '<div class="rw-field"><label>Date of birth</label>' +
      '<div class="dob-row">' +
        '<select id="a-dob-day">' + dayOptions + '</select>' +
        '<select id="a-dob-month">' + monthOptions + '</select>' +
        '<select id="a-dob-year">' + yearOptions + '</select>' +
      '</div></div>';
    return dobField + fields.map(function (f) {
      return '<div class="rw-field"><label>' + f[1] + '</label><input type="number" step="any" id="a-' + f[0] + '" value="' + f[2] + '" /></div>';
    }).join("") +
      '<button class="btn btn-primary btn-full" id="save-assumptions">Save &amp; recalculate</button>' +
      '<div id="recalc-status" style="font-size:13px;color:var(--good);margin-top:8px;text-align:center;min-height:14px;"></div>';
  }

  function wireAssumptionsForm() {
    document.getElementById("save-assumptions").addEventListener("click", async function () {
      var numericFields = ["target_age", "bridge_target", "monthly_income", "investment_return_annual", "switch_month", "post_switch_income", "variable_budget", "cash_on_hand", "investment_value_usd", "usd_sgd_rate"];
      var updates = {};
      numericFields.forEach(function (f) { updates[f] = parseFloat(document.getElementById("a-" + f).value); });
      var dobDay = document.getElementById("a-dob-day").value.padStart(2, "0");
      var dobMonth = document.getElementById("a-dob-month").value.padStart(2, "0");
      var dobYear = document.getElementById("a-dob-year").value;
      updates.dob = dobYear + "-" + dobMonth + "-" + dobDay;
      var { error } = await supabase.from("assumptions").update(updates).eq("user_id", state.session.user.id);
      if (error) { alert("Couldn't save: " + error.message); return; }
      Object.assign(state.assumptions, updates);
      renderPlan(); renderHome();
      document.getElementById("recalc-status").textContent = "Recalculated from your updated assumptions.";
    });
  }

  function shiftMonth(delta) {
    state.viewMonthIdx = Math.max(0, state.viewMonthIdx + delta);
    renderLog(); renderBills(); renderAnalysis();
  }

  // ---------------- Tabs ----------------
  function initTabs() {
    var titles = { home: "Dashboard", log: "Log expense", bills: "Recurring bills", analysis: "Analysis", plan: "Plan to 65" };
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
