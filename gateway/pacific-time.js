const PACIFIC_TZ = 'America/Los_Angeles';

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function pacificDayKey(ts = Date.now()) {
  return dayFormat.format(new Date(Number(ts)));
}

function addCalendarDays(dayKey, days) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
  const pad = (n) => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

function firstInstantOfPacificDay(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  let lo = Date.UTC(year, month - 1, day) - 14 * 60 * 60 * 1000;
  let hi = Date.UTC(year, month - 1, day) + 14 * 60 * 60 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pacificDayKey(mid) >= dayKey) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function nextPacificMidnightMs(ts = Date.now()) {
  const today = pacificDayKey(ts);
  return firstInstantOfPacificDay(addCalendarDays(today, 1));
}

module.exports = {
  PACIFIC_TZ,
  pacificDayKey,
  nextPacificMidnightMs,
  firstInstantOfPacificDay
};
