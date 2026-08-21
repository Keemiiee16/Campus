import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

export function normalizeName(value = '') {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export async function getSchool(guildId) {
  const { data, error } = await supabase
    .from('schools')
    .select('*')
    .eq('discord_guild_id', guildId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function requireSchool(interaction) {
  const school = await getSchool(interaction.guildId);
  if (!school) {
    await interaction.reply({
      content: 'Campus is not set up in this server yet. An admin needs to run `/campus setup` first.',
      ephemeral: true,
    });
    return null;
  }
  return school;
}

export async function findTeacher(schoolId, name) {
  const { data, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', schoolId)
    .ilike('teacher_name', name.trim())
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getTeacherWithSettingsByChannel(schoolId, channelId) {
  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', schoolId)
    .eq('classroom_channel_id', channelId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!teacher) return null;

  const { data: settings, error: settingsError } = await supabase
    .from('teacher_settings')
    .select('*')
    .eq('teacher_id', teacher.id)
    .maybeSingle();

  if (settingsError) throw settingsError;

  return { teacher, settings };
}

export async function getQuarterForDate(schoolId, date) {
  const { data, error } = await supabase
    .from('quarters')
    .select('*')
    .eq('school_id', schoolId)
    .lte('start_date', date)
    .gte('end_date', date)
    .order('quarter_number')
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function getRoutes(schoolId, routeTypes) {
  const types = Array.isArray(routeTypes) ? routeTypes : [routeTypes];
  const { data, error } = await supabase
    .from('channel_routes')
    .select('*')
    .eq('school_id', schoolId)
    .eq('enabled', true)
    .in('route_type', types)
    .order('channel_name');

  if (error) throw error;
  return data ?? [];
}
