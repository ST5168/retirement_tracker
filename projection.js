// Runway projection engine v2 -- simplified income-period model.
// Pure functions, no DOM/Supabase dependency, fully unit tested against projection_test.js.

function addMonths(startDateStr, n) {
  var d = new Date(startDateStr + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function monthKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
function ageAt(dobStr, date) {
  var dob = new Date(dobStr + "T00:00:00");
  var age = date.getFullYear() - dob.getFullYear();
  if (date.getMonth() < dob.getMonth() || (date.getMonth() === dob.getMonth() && date.getDate() < dob.getDate())) age--;
  return age;
}
function monthsFromStartToAge(dobStr, startDateStr, targetAge) {
  var dob = new Date(dobStr + "T00:00:00");
  var start = new Date(startDateStr + "T00:00:00");
  var target = new Date(dob.getFullYear() + targetAge, dob.getMonth(), dob.getDate());
  return (target.getFullYear() - start.getFullYear()) * 12 + (target.getMonth() - start.getMonth());
}
function monthsFromStartToDate(startDateStr, dateStr) {
  var start = new Date(startDateStr + "T00:00:00");
  var d = new Date(dateStr + "T00:00:00");
  return (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
}

// ---------- CPF contribution rates (2026 bands, verified) ----------
var OW_CEILING = 8000;
function cpfRatesForAge(age) {
  if (age <= 55) return { employee: 0.20, employer: 0.17 };
  if (age <= 60) return { employee: 0.18, employer: 0.16 };
  if (age <= 65) return { employee: 0.125, employer: 0.125 };
  if (age <= 70) return { employee: 0.075, employer: 0.09 };
  return { employee: 0.05, employer: 0.075 };
}
function estimateCpf(grossMonthly, age) {
  var rates = cpfRatesForAge(age);
  var base = Math.min(grossMonthly, OW_CEILING);
  return { employee: base * rates.employee, employer: base * rates.employer };
}

// ---------- Income tax (IRAS 2026 resident brackets, verified) ----------
var TAX_BRACKETS = [
  [20000, 0], [30000, 0.02], [40000, 0.035], [80000, 0.07], [120000, 0.115],
  [160000, 0.15], [200000, 0.18], [240000, 0.19], [280000, 0.195], [320000, 0.20], [Infinity, 0.22]
];
function estimateMonthlyTax(grossMonthly, cpfEmployeeMonthly) {
  var annualGross = grossMonthly * 12;
  var chargeable = Math.max(0, annualGross - cpfEmployeeMonthly * 12);
  var tax = 0, prev = 0;
  for (var i = 0; i < TAX_BRACKETS.length; i++) {
    var upper = TAX_BRACKETS[i][0], rate = TAX_BRACKETS[i][1];
    if (chargeable <= prev) break;
    tax += (Math.min(chargeable, upper) - prev) * rate;
    prev = upper;
  }
  return tax / 12;
}

// ---------- CPF LIFE annuitization at 65 (2026 reference figures, verified) ----------
var CPF_BRS_2026 = 110200, CPF_FRS_2026 = 220400, CPF_ERS_2026 = 2 * CPF_FRS_2026;
var CPF_PAYOUT_AT_BRS_2026 = 950, CPF_PAYOUT_AT_FRS_2026 = 1780, CPF_PAYOUT_AT_ERS_2026 = 3440;
var CPF_SUM_GROWTH_RATE = 0.035;
function projectedRetirementSums(yearsFromNow) {
  var scale = Math.pow(1 + CPF_SUM_GROWTH_RATE, yearsFromNow);
  return {
    brs: CPF_BRS_2026 * scale, frs: CPF_FRS_2026 * scale, ers: CPF_ERS_2026 * scale,
    payoutAtBrs: CPF_PAYOUT_AT_BRS_2026 * scale, payoutAtFrs: CPF_PAYOUT_AT_FRS_2026 * scale, payoutAtErs: CPF_PAYOUT_AT_ERS_2026 * scale
  };
}
function estimateCpfLifePayout(raBalance, sums) {
  if (raBalance <= sums.brs) return sums.payoutAtBrs * (sums.brs > 0 ? raBalance / sums.brs : 0);
  if (raBalance <= sums.frs) return sums.payoutAtBrs + (raBalance - sums.brs) / (sums.frs - sums.brs) * (sums.payoutAtFrs - sums.payoutAtBrs);
  if (raBalance <= sums.ers) return sums.payoutAtFrs + (raBalance - sums.frs) / (sums.ers - sums.frs) * (sums.payoutAtErs - sums.payoutAtFrs);
  return sums.payoutAtErs;
}

// ---------- Income period lookup ----------
// periods: [{ start_date: "YYYY-MM-DD", amount: number }, ...] -- any order, at least one required.
function incomeForMonth(periods, date) {
  var sorted = periods.slice().sort(function (a, b) { return a.start_date < b.start_date ? -1 : 1; });
  var applicable = sorted[0].amount;
  for (var i = 0; i < sorted.length; i++) {
    var pStart = new Date(sorted[i].start_date + "T00:00:00");
    if (pStart <= date) applicable = sorted[i].amount; else break;
  }
  return applicable;
}

// ---------- Main simulation ----------
// a: { dob, start_date, periods[], fixed_budget, variable_budget, cash_on_hand, investment_value_sgd,
//      cpf_oa, cpf_sa, windfall_amount, windfall_date, investment_return_annual, cpf_return_annual }
function simulateMonths(a, months, actualsByMonth) {
  actualsByMonth = actualsByMonth || {};
  var retM = Math.pow(1 + a.investment_return_annual, 1 / 12) - 1;
  var cpfRetM = Math.pow(1 + a.cpf_return_annual, 1 / 12) - 1;
  var N = a.cash_on_hand + a.investment_value_sgd;
  var O = a.cpf_oa + a.cpf_sa;
  var age65Month = a.dob ? monthsFromStartToAge(a.dob, a.start_date, 65) : null;
  var annuitized = false, cpfLifeMonthly = 0;
  var startYear = new Date(a.start_date + "T00:00:00").getFullYear();
  var windfallMonth = a.windfall_date ? monthsFromStartToDate(a.start_date, a.windfall_date) + 1 : null;
  var rows = [];

  for (var m = 1; m <= months; m++) {
    var d = addMonths(a.start_date, m - 1);
    var key = monthKey(d);
    var age = a.dob ? ageAt(a.dob, d) : null;

    var gross = incomeForMonth(a.periods, d);
    var cpfContrib = estimateCpf(gross, age != null ? age : 30);
    var tax = estimateMonthlyTax(gross, cpfContrib.employee);
    var takeHome = gross - cpfContrib.employee - tax;

    var actual = actualsByMonth[key];
    var fixedExp = actual && actual.fixed != null ? actual.fixed : a.fixed_budget;
    var varExp = actual && actual.variable != null ? actual.variable : a.variable_budget;
    var totalExp = fixedExp + varExp;
    var surplus = takeHome - totalExp;

    var oneoff = (windfallMonth != null && m === windfallMonth) ? a.windfall_amount : 0;
    N = N * (1 + retM) + surplus + oneoff;
    O = O * (1 + cpfRetM) + cpfContrib.employee + cpfContrib.employer;

    if (age65Month != null && m === age65Month && !annuitized) {
      var sums = projectedRetirementSums(d.getFullYear() - startYear);
      var toAnnuitize = Math.min(O, sums.ers);
      cpfLifeMonthly = estimateCpfLifePayout(toAnnuitize, sums);
      O = Math.max(0, O - toAnnuitize);
      annuitized = true;
    }

    rows.push({
      month: m, date: d, monthKey: key, age: age,
      gross: gross, takeHome: takeHome, fixedExp: fixedExp, varExp: varExp,
      surplus: surplus, oneoff: oneoff, liquid: N, cpf: O,
      cpfLifeMonthly: cpfLifeMonthly, annuitized: annuitized
    });
  }
  return rows;
}

// ---------- Out-of-money detection ----------
function findDepletion(rows) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].liquid < 0) return rows[i];
  }
  return null;
}

// ---------- Recommendation: latest feasible delay to a given period's start date (years) ----------
function findFeasibleDelay(a, months, periodIndex, maxYears) {
  maxYears = maxYears || 20;
  var basePeriods = a.periods;
  function feasibleAtDelay(years) {
    var newPeriods = basePeriods.map(function (p, i) {
      if (i !== periodIndex) return p;
      var orig = new Date(p.start_date + "T00:00:00");
      var shifted = new Date(orig.getFullYear() + Math.floor(years), orig.getMonth() + Math.round((years % 1) * 12), orig.getDate());
      return { start_date: shifted.toISOString().slice(0, 10), amount: p.amount };
    });
    var rows = simulateMonths(Object.assign({}, a, { periods: newPeriods }), months, {});
    return findDepletion(rows) === null;
  }
  if (feasibleAtDelay(0)) return 0;
  var lo = 0, hi = maxYears;
  if (!feasibleAtDelay(hi)) return null;
  for (var i = 0; i < 30; i++) {
    var mid = (lo + hi) / 2;
    if (feasibleAtDelay(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

// ---------- Recommendation: minimum income for a given period to avoid depletion ----------
function findMinimumIncome(a, months, periodIndex, maxIncome) {
  maxIncome = maxIncome || 20000;
  function feasibleAtIncome(amount) {
    var newPeriods = a.periods.map(function (p, i) { return i === periodIndex ? { start_date: p.start_date, amount: amount } : p; });
    var rows = simulateMonths(Object.assign({}, a, { periods: newPeriods }), months, {});
    return findDepletion(rows) === null;
  }
  if (!feasibleAtIncome(maxIncome)) return null;
  var lo = 0, hi = maxIncome;
  for (var i = 0; i < 30; i++) {
    var mid = (lo + hi) / 2;
    if (feasibleAtIncome(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

if (typeof module !== "undefined") {
  module.exports = {
    addMonths, monthKey, ageAt, monthsFromStartToAge, monthsFromStartToDate,
    cpfRatesForAge, estimateCpf, estimateMonthlyTax,
    projectedRetirementSums, estimateCpfLifePayout,
    incomeForMonth, simulateMonths, findDepletion, findFeasibleDelay, findMinimumIncome
  };
}
