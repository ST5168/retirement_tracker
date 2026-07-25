// Runway projection engine — ported from the validated Excel model.
// Pure functions, no DOM/Supabase dependency, so it can be unit tested standalone
// and then reused as-is inside app.js.

function addMonths(startDateStr, n) {
  var d = new Date(startDateStr + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function monthKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

// Computes bonus economics (Additional Wage CPF ceiling logic) from assumptions.
function computeBonus(a) {
  var grossAnnualBonus = a.monthly_income * 12 * a.bonus_pct;
  var owAnnualSubjectToCpf = (a.cpf_employee / 0.2) * 12;
  var awCeiling = Math.max(102000 - owAnnualSubjectToCpf, 0);
  var cpfEeOnBonus = Math.min(grossAnnualBonus, awCeiling) * 0.20;
  var cpfErOnBonus = Math.min(grossAnnualBonus, awCeiling) * 0.17;
  var netBonusCash = grossAnnualBonus - cpfEeOnBonus;
  return { grossAnnualBonus: grossAnnualBonus, netBonusCash: netBonusCash, totalCpfOnBonus: cpfEeOnBonus + cpfErOnBonus };
}

// actualsByMonth: { "2026-08": { fixed: 4293, variable: 1650 }, ... } — real logged totals.
// Falls back to budgeted fixed/variable for any month not present.
function simulateMonths(a, months, actualsByMonth) {
  actualsByMonth = actualsByMonth || {};
  var retM = Math.pow(1 + a.investment_return_annual, 1 / 12) - 1;
  var cpfRetM = Math.pow(1 + a.cpf_return_annual, 1 / 12) - 1;
  var bonus = computeBonus(a);
  var N = a.cash_on_hand + a.investment_value_sgd;
  var O = a.cpf_oa + a.cpf_sa;
  var rows = [];

  for (var m = 1; m <= months; m++) {
    var d = addMonths(a.start_date, m - 1);
    var key = monthKey(d);
    var employed = m < a.switch_month;

    var gross = employed ? a.monthly_income : a.post_switch_income;
    var cpfEe = employed ? a.cpf_employee : 0;
    var tax = m < (a.switch_month + a.tax_lag_months) ? a.income_tax_monthly : a.post_switch_income * a.post_switch_tax_pct;
    var takeHome = gross - cpfEe - tax;

    var actual = actualsByMonth[key];
    var fixedExp = actual && actual.fixed != null ? actual.fixed : a.fixed_budget;
    var varExp = actual && actual.variable != null ? actual.variable : a.variable_budget;
    var totalExp = fixedExp + varExp;
    var surplus = takeHome - totalExp;

    var oneoff = (m === a.settle_month) ? a.settle_cash : 0;
    var isBonusMonth = employed && (d.getMonth() + 1) === a.bonus_month;
    if (isBonusMonth) oneoff += bonus.netBonusCash;

    N = N * (1 + retM) + surplus + oneoff;

    var cpfAdd = employed ? (a.cpf_employee + a.cpf_employer) : 0;
    if (m === a.settle_month) cpfAdd += a.cpf_refund;
    if (isBonusMonth) cpfAdd += bonus.totalCpfOnBonus;
    O = O * (1 + cpfRetM) + cpfAdd;

    rows.push({
      month: m, date: d, monthKey: key, employed: employed,
      gross: gross, takeHome: takeHome, fixedExp: fixedExp, varExp: varExp,
      surplus: surplus, oneoff: oneoff, liquid: N, cpf: O
    });
  }
  return rows;
}

// Binary search: what post-switch gross monthly income closes the gap to bridgeTarget by `months`?
function requiredPostSwitchIncome(a, months, bridgeTarget) {
  var lo = 0, hi = 200000;
  for (var i = 0; i < 60; i++) {
    var mid = (lo + hi) / 2;
    var testA = Object.assign({}, a, { post_switch_income: mid });
    var rows = simulateMonths(testA, months, {});
    var liquidAtEnd = rows[rows.length - 1].liquid;
    if (liquidAtEnd < bridgeTarget) lo = mid; else hi = mid;
  }
  return hi;
}

if (typeof module !== "undefined") {
  module.exports = { addMonths, monthKey, computeBonus, simulateMonths, requiredPostSwitchIncome };
}
