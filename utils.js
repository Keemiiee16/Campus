import { PermissionFlagsBits } from 'discord.js';
import { supabase } from './db.js';

export const activityConfig = {
  assignment: { label: '📝 Do an Assignment', routes: ['classroom'], graded: true },
  study: { label: '📚 Study', routes: ['classroom', 'location'], graded: true },
  reading: { label: '📖 Read a Book', routes: ['location', 'classroom'], graded: true },
  homework: { label: '✏️ Do Homework', routes: ['classroom'], graded: true },
  tutoring: { label: '🧑‍🏫 Tutoring', routes: ['classroom', 'location'], graded: true },
  attend_class: { label: '🏫 Attend Class', routes: ['classroom'], graded: true },
  library: { label: '📚 Library', routes: ['location'], graded: true },
  study_hall: { label: '📓 Study Hall', routes: ['location'], graded: true },
  lunch: { label: '🍎 Lunch', routes: ['location'], graded: false },
  recess: { label: '🛝 Recess / Free Period', routes: ['location'], graded: false },
  nurse: { label: '🏥 Nurse', routes: ['location'], graded: false },
  counselor: { label: '🗣️ Counselor', routes: ['location'], graded: false },
  gym: { label: '🏋️ Gym', routes: ['location'], graded: false },
  club: { label: '🎭 Club Meeting', routes: ['club'], graded: false },
  assembly: { label: '🎤 Assembly', routes: ['location'], graded: false },
  field_trip: { label: '🚌 Field Trip', routes: ['location', 'other'], graded: false },
  detention: { label: '🚪 Serve Detention', routes: ['detention'], graded: false },
  iss: { label: '⚠️ ISS', routes: ['iss'], graded: false },
  final: { label: '🎓 Take Today’s Final', routes: ['classroom'], graded: true },
  other: { label: '➕ Other', routes: ['classroom', 'location', 'club', 'other'], graded: false },
};

export function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

export function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function addDuration(date, amount, unit) {
  const ms = unit === 'minutes'
    ? amount * 60_000
    : unit === 'hours'
      ? amount * 3_600_000
      : amount * 86_400_000;
  return new Date(date.getTime() + ms);
}

export function getLocalParts(timezone, when = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(fmt.formatToParts(when).map((p) => [p.type, p.value]));
  const weekdays = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: weekdays[parts.weekday],
  };
}

export async function schoolIsQuiet(school, when = new Date()) {
  if (!school.quiet_hours_enabled) return false;

  const local = getLocalParts(school.timezone, when);
  if (!school.school_days?.includes(local.weekday)) return true;

  const start = String(school.school_day_start).slice(0, 5);
  const end = String(school.school_day_end).slice(0, 5);
  if (local.time < start || local.time > end) return true;

  const { data, error } = await supabase
    .from('school_calendar')
    .select('id')
    .eq('school_id', school.id)
    .eq('school_closed', true)
    .lte('start_date', local.date)
    .or(`end_date.gte.${local.date},end_date.is.null`)
    .limit(1);

  if (error) throw error;
  return Boolean(data?.length);
}

export function letterGrade(percent, scale) {
  const entries = Object.entries(scale || { A: 90, B: 80, C: 70, D: 60, F: 0 })
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries.find(([, threshold]) => percent >= Number(threshold))?.[0] || 'F';
}

export function safeChannelName(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
