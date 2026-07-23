function plannerWeekKey(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - startOfYear) / 86400000);
  const jan4Day = new Date(Date.UTC(year, 0, 4)).getUTCDay();
  const weekNumber = Math.ceil((dayOfYear + jan4Day + 1) / 7);
  return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

function completedWeekKeys(anchorValue, count) {
  const anchor = anchorValue ? new Date(anchorValue) : new Date();
  if (Number.isNaN(anchor.getTime())) return [];
  const keys = [];
  for (let offset = count; offset >= 1; offset -= 1) {
    const date = new Date(anchor.getTime() - offset * 7 * 86400000);
    keys.push(plannerWeekKey(date));
  }
  return keys;
}

function percentageChange(current, previous) {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function summarizeSalesVolume(salesByWeek, anchorValue, displayWeekCount = 8) {
  const anchor = anchorValue ? new Date(anchorValue) : new Date();
  const validAnchor = Number.isNaN(anchor.getTime()) ? new Date() : anchor;
  const keys = completedWeekKeys(validAnchor, displayWeekCount + 1);
  const series = keys.map((week, index) => {
    const units = Math.round(Number(salesByWeek?.[week] || 0));
    const priorUnits = index > 0 ? Math.round(Number(salesByWeek?.[keys[index - 1]] || 0)) : null;
    return {
      week,
      label: week.replace(/^\d{4}-/, ''),
      units,
      changePct: priorUnits === null ? null : percentageChange(units, priorUnits)
    };
  }).slice(-displayWeekCount);

  const latest = series.at(-1) || null;
  const prior = series.at(-2) || null;
  const baseline = series.slice(-5, -1);
  const average4Weeks = baseline.length
    ? Math.round((baseline.reduce((sum, row) => sum + row.units, 0) / baseline.length) * 10) / 10
    : null;
  const currentWeek = plannerWeekKey(validAnchor);

  return {
    completedWeeks: series,
    latestWeek: latest?.week || null,
    latestWeekUnits: latest?.units || 0,
    priorWeekUnits: prior?.units || 0,
    changePct: latest && prior ? percentageChange(latest.units, prior.units) : null,
    average4Weeks,
    vs4WeekPct: latest && average4Weeks > 0 ? percentageChange(latest.units, average4Weeks) : null,
    currentWeek: {
      week: currentWeek,
      label: currentWeek ? currentWeek.replace(/^\d{4}-/, '') : null,
      units: Math.round(Number(salesByWeek?.[currentWeek] || 0)),
      partial: true
    }
  };
}

module.exports = {
  plannerWeekKey,
  completedWeekKeys,
  percentageChange,
  summarizeSalesVolume
};
