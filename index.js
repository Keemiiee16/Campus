import express from 'express';
import {
  ActionRowBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { commandJSON } from './commands.js';
import {
  findTeacher,
  getQuarterForDate,
  getRoutes,
  getSchool,
  getTeacherWithSettingsByChannel,
  normalizeName,
  requireSchool,
  supabase,
} from './db.js';
import {
  aiEnabled,
  rememberTeacherEvent,
  teacherActivityReply,
  teacherConversationDecision,
} from './ai.js';
import {
  activityConfig,
  addDuration,
  getLocalParts,
  letterGrade,
  schoolIsQuiet,
  validDate,
  validTime,
} from './utils.js';

if (!process.env.DISCORD_TOKEN) {
  throw new Error('Missing DISCORD_TOKEN.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const app = express();
app.get('/', (_req, res) => res.status(200).send('Campus is awake.'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, bot: client.user?.tag ?? null }));
app.listen(process.env.PORT || 3000, () => {
  console.log(`Health server listening on ${process.env.PORT || 3000}`);
});

const lastTeacherAction = new Map();
const spontaneousHistory = new Map();

function ephemeral(content) {
  return { content, ephemeral: true };
}

async function registerCommands() {
  if (String(process.env.REGISTER_COMMANDS ?? 'true').toLowerCase() === 'false') return;
  await client.application.commands.set(commandJSON);
  console.log(`Registered ${commandJSON.length} global Campus commands.`);
}

async function sendAsTeacher(channel, teacher, content) {
  if (!content) return;

  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((w) => w.owner?.id === client.user.id && w.name.startsWith('Campus Teacher'));

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: `Campus Teacher - ${teacher.teacher_name}`.slice(0, 80),
        avatar: teacher.avatar_url || undefined,
        reason: 'Campus automated teacher messages',
      });
    }

    await webhook.send({
      content,
      username: teacher.teacher_name,
      avatarURL: teacher.avatar_url || undefined,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.warn('Webhook teacher send failed; using Campus fallback:', error.message);
    await channel.send({
      content: `**${teacher.teacher_name}:** ${content}`,
      allowedMentions: { parse: [] },
    });
  }
}

async function resolveActiveTeacher(schoolId, channelId) {
  const found = await getTeacherWithSettingsByChannel(schoolId, channelId);
  if (!found) return null;

  let { teacher, settings } = found;

  if (teacher.status === 'paused' || teacher.status === 'away') return null;

  if (teacher.status === 'substitute_mode') {
    if (teacher.substitute_teacher_id) {
      const { data: substitute, error } = await supabase
        .from('teachers')
        .select('*')
        .eq('id', teacher.substitute_teacher_id)
        .maybeSingle();
      if (error) throw error;
      if (substitute) {
        const { data: substituteSettings, error: se } = await supabase
          .from('teacher_settings')
          .select('*')
          .eq('teacher_id', substitute.id)
          .maybeSingle();
        if (se) throw se;
        return { teacher: substitute, settings: substituteSettings };
      }
    }

    if (teacher.use_generic_substitute) {
      teacher = {
        ...teacher,
        id: teacher.id,
        teacher_name: 'Substitute Teacher',
        personality: 'Calm, respectful, practical, and focused on keeping class on track.',
        teaching_style: 'Keeps directions simple and follows the regular teacher’s plan.',
        strictness: 6,
        talkativeness: 4,
        humor: 3,
        patience: 7,
      };
    }
  }

  return { teacher, settings };
}

async function handleCampus(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'setup') return;

  const schoolName = interaction.options.getString('school_name', true);
  const timezone = interaction.options.getString('timezone', true);
  const start = interaction.options.getString('school_start', true);
  const end = interaction.options.getString('school_end', true);
  const quiet = interaction.options.getBoolean('quiet_hours', true);

  if (!validTime(start) || !validTime(end)) {
    return interaction.reply(ephemeral('Use 24-hour times like `07:30` and `16:00`.'));
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    return interaction.reply(ephemeral('That timezone selection is not valid. Re-run `/campus setup` and choose EST, CST, or PST.'));
  }

  const { error } = await supabase.from('schools').upsert({
    discord_guild_id: interaction.guildId,
    school_name: schoolName,
    timezone,
    school_day_start: start,
    school_day_end: end,
    quiet_hours_enabled: quiet,
  }, { onConflict: 'discord_guild_id' });

  if (error) throw error;

  const timezoneLabels = {
    'America/New_York': 'EST — Eastern',
    'America/Chicago': 'CST — Central',
    'America/Los_Angeles': 'PST — Pacific',
  };

  await interaction.reply(ephemeral(
    `✅ Campus is set up for **${schoolName}**.\nTimezone: **${timezoneLabels[timezone] ?? timezone}**\nSchool hours: **${start}–${end}**\nQuiet hours: **${quiet ? 'ON' : 'OFF'}**`
  ));
}

async function handleQuarter(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const q = interaction.options.getInteger('quarter', true);
  const start = interaction.options.getString('start_date', true);
  const end = interaction.options.getString('end_date', true);
  const required = interaction.options.getInteger('required_actions', true);

  if (!validDate(start) || !validDate(end) || end < start) {
    return interaction.reply(ephemeral('Use valid dates like `2026-08-24`, and make sure the end date is after the start date.'));
  }

  const { error } = await supabase.from('quarters').upsert({
    school_id: school.id,
    quarter_number: q,
    quarter_name: `Quarter ${q}`,
    start_date: start,
    end_date: end,
    required_actions: required,
  }, { onConflict: 'school_id,quarter_number' });

  if (error) throw error;

  await interaction.reply(ephemeral(
    `✅ **Quarter ${q}** saved: ${start} → ${end}, with **${required} qualifying actions** required.`
  ));
}

async function handleRoutes(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const group = interaction.options.getString('group', true);
  const category = interaction.options.getChannel('category', true);

  const { error: groupError } = await supabase.from('channel_groups').upsert({
    school_id: school.id,
    discord_category_id: category.id,
    category_name: category.name,
    group_type: group,
    enabled: true,
  }, { onConflict: 'school_id,discord_category_id' });
  if (groupError) throw groupError;

  const children = category.children.cache.filter((ch) =>
    [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)
  );

  let count = 0;
  for (const channel of children.values()) {
    let routeType = group === 'classrooms'
      ? 'classroom'
      : group === 'locations'
        ? 'location'
        : group === 'clubs'
          ? 'club'
          : 'other';

    if (group === 'discipline') {
      const n = channel.name.toLowerCase();
      if (n.includes('iss') || n.includes('in-school-suspension')) routeType = 'iss';
      else if (n.includes('detention')) routeType = 'detention';
    }

    const { error } = await supabase.from('channel_routes').upsert({
      school_id: school.id,
      discord_channel_id: channel.id,
      discord_category_id: category.id,
      channel_name: channel.name,
      route_type: routeType,
      enabled: true,
    }, { onConflict: 'school_id,discord_channel_id' });

    if (error) throw error;
    count += 1;
  }

  await interaction.reply(ephemeral(
    `✅ Saved **${category.name}** as **${group}** and found **${count}** usable channels.`
  ));
}


function teacherModal(customId, title, teacher = null) {
  const subjectGradeValue = teacher
    ? [teacher.subject, teacher.grade_level].filter(Boolean).join(' | ')
    : '';

  const nameInput = new TextInputBuilder()
    .setCustomId('teacher_name')
    .setLabel('Teacher Name')
    .setPlaceholder('Mr. Chicken')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);

  const subjectGradeInput = new TextInputBuilder()
    .setCustomId('teacher_subject_grade')
    .setLabel('Subject + Grade')
    .setPlaceholder('Science | 5th Grade')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const classroomInput = new TextInputBuilder()
    .setCustomId('teacher_classroom')
    .setLabel('Classroom Channel')
    .setPlaceholder('5th-grade-science or #channel')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const personalityInput = new TextInputBuilder()
    .setCustomId('teacher_personality')
    .setLabel('Personality')
    .setPlaceholder('Goofy, upbeat, friendly, patient, gets serious when needed...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  const detailsInput = new TextInputBuilder()
    .setCustomId('teacher_details')
    .setLabel('Favorites, Quirks + Personal Details')
    .setPlaceholder('Favorite color: green\\nHobby: basketball\\nPet peeve: pencil tapping...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  if (teacher) {
    nameInput.setValue(String(teacher.teacher_name ?? '').slice(0, 80));
    if (subjectGradeValue) subjectGradeInput.setValue(subjectGradeValue.slice(0, 100));
    if (teacher.classroom_channel_id) classroomInput.setValue(`<#${teacher.classroom_channel_id}>`);
    if (teacher.personality) personalityInput.setValue(String(teacher.personality).slice(0, 1000));
    if (teacher.lore) detailsInput.setValue(String(teacher.lore).slice(0, 1000));
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(subjectGradeInput),
      new ActionRowBuilder().addComponents(classroomInput),
      new ActionRowBuilder().addComponents(personalityInput),
      new ActionRowBuilder().addComponents(detailsInput),
    );
}

function parseSubjectAndGrade(rawValue) {
  const value = String(rawValue || '').trim();

  if (value.includes('|')) {
    const [subjectPart, ...gradeParts] = value.split('|');
    return {
      subject: subjectPart.trim() || 'General',
      gradeLevel: gradeParts.join('|').trim() || null,
    };
  }

  const gradePattern = /(?:pre-?k|kindergarten|k(?:indergarten)?|(?:[1-9]|1[0-2])(?:st|nd|rd|th)?\s*grade|middle school|high school)/i;
  const match = value.match(gradePattern);

  if (match) {
    const gradeLevel = match[0].trim();
    const subject = value.replace(match[0], '').replace(/^[-–—,: ]+|[-–—,: ]+$/g, '').trim();
    return { subject: subject || 'General', gradeLevel };
  }

  return { subject: value || 'General', gradeLevel: null };
}

async function resolveTeacherClassroom(interaction, rawValue) {
  const value = String(rawValue || '').trim();

  const mention = value.match(/^<#(\d+)>$/);
  const rawId = /^\d+$/.test(value) ? value : null;
  const candidateId = mention?.[1] || rawId;

  if (candidateId) {
    const channel = await interaction.guild.channels.fetch(candidateId).catch(() => null);
    if (channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      return channel;
    }
  }

  const wanted = value
    .replace(/^#/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');

  return interaction.guild.channels.cache.find((channel) =>
    [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    && channel.name.toLowerCase() === wanted
  ) || null;
}

async function handleTeacherModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const teacherName = interaction.fields.getTextInputValue('teacher_name').trim();
  const subjectGrade = interaction.fields.getTextInputValue('teacher_subject_grade').trim();
  const classroomRaw = interaction.fields.getTextInputValue('teacher_classroom').trim();
  const personality = interaction.fields.getTextInputValue('teacher_personality').trim();
  const lore = interaction.fields.getTextInputValue('teacher_details').trim() || null;

  const { subject, gradeLevel } = parseSubjectAndGrade(subjectGrade);
  const classroom = await resolveTeacherClassroom(interaction, classroomRaw);

  if (!classroom) {
    return interaction.reply(ephemeral(
      `I couldn't find the classroom **${classroomRaw}**. Type the exact channel name, like \`5th-grade-science\`, paste the channel mention, or paste the channel ID.`
    ));
  }

  if (interaction.customId === 'campus_teacher_create') {
    const existing = await findTeacher(school.id, teacherName);
    if (existing) {
      return interaction.reply(ephemeral(
        `A teacher named **${existing.teacher_name}** already exists. Use \`/teacher edit\` to change them.`
      ));
    }

    const { data, error } = await supabase.from('teachers').insert({
      school_id: school.id,
      teacher_name: teacherName,
      subject,
      grade_level: gradeLevel,
      classroom_channel_id: classroom.id,
      personality,
      teaching_style: 'Adapts naturally to the class while staying consistent with the teacher personality.',
      lore,
      strictness: 5,
      talkativeness: 5,
      humor: 5,
      patience: 5,
      status: 'active',
    }).select().single();

    if (error) throw error;

    return interaction.reply(ephemeral(
      `✅ **${data.teacher_name}** was created.\\n`
      + `📚 **${data.subject}**${data.grade_level ? ` • ${data.grade_level}` : ''}\\n`
      + `🏫 Classroom: <#${data.classroom_channel_id}>\\n`
      + `🧠 Personality and favorites saved.\\n\\n`
      + `Defaults: Strictness 5/10 • Talkativeness 5/10 • Humor 5/10 • Patience 5/10`
    ));
  }

  const editMatch = interaction.customId.match(/^campus_teacher_edit:(.+)$/);
  if (!editMatch) return;

  const teacherId = editMatch[1];
  const { data: oldTeacher, error: oldError } = await supabase
    .from('teachers')
    .select('*')
    .eq('id', teacherId)
    .eq('school_id', school.id)
    .maybeSingle();

  if (oldError) throw oldError;
  if (!oldTeacher) {
    return interaction.reply(ephemeral('I could not find that teacher anymore.'));
  }

  const changes = {
    teacher_name: teacherName,
    subject,
    grade_level: gradeLevel,
    classroom_channel_id: classroom.id,
    personality,
    lore,
  };

  const { error } = await supabase.from('teachers').update(changes).eq('id', oldTeacher.id);
  if (error) throw error;

  await supabase.from('change_history').insert({
    school_id: school.id,
    entity_type: 'teacher',
    entity_id: String(oldTeacher.id),
    action: 'edit',
    new_value: changes,
    changed_by_discord_user_id: interaction.user.id,
  });

  return interaction.reply(ephemeral(
    `✅ **${teacherName}** was updated without erasing their history or teacher memory.\\n`
    + `🏫 Classroom: <#${classroom.id}>`
  ));
}

async function handleTeacher(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    return interaction.showModal(teacherModal('campus_teacher_create', 'Create Teacher'));
  }

  const school = await requireSchool(interaction);
  if (!school) return;

  const name = interaction.options.getString('name', true);
  const teacher = await findTeacher(school.id, name);
  if (!teacher) return interaction.reply(ephemeral(`I couldn't find a teacher named **${name}**.`));

  if (sub === 'edit') {
    return interaction.showModal(
      teacherModal(`campus_teacher_edit:${teacher.id}`, `Edit ${teacher.teacher_name}`.slice(0, 45), teacher)
    );
  }

  if (sub === 'status') {
    const status = interaction.options.getString('status', true);
    const substituteName = interaction.options.getString('substitute_name');
    const generic = interaction.options.getBoolean('generic_substitute') ?? false;

    const changes = {
      status,
      substitute_teacher_id: null,
      use_generic_substitute: false,
    };

    if (status === 'substitute_mode' && substituteName) {
      const substitute = await findTeacher(school.id, substituteName);
      if (!substitute) {
        return interaction.reply(ephemeral(`I couldn't find the substitute teacher **${substituteName}**.`));
      }
      changes.substitute_teacher_id = substitute.id;
    } else if (status === 'substitute_mode' && generic) {
      changes.use_generic_substitute = true;
    }

    const { error } = await supabase.from('teachers').update(changes).eq('id', teacher.id);
    if (error) throw error;

    return interaction.reply(ephemeral(`✅ **${teacher.teacher_name}** is now **${status.replaceAll('_', ' ')}**.`));
  }

  if (sub === 'automation') {
    const changes = {};
    const boolOptions = [
      ['enabled', 'automation_enabled'],
      ['react_to_messages', 'react_to_messages'],
      ['spontaneous_messages', 'spontaneous_messages'],
      ['conversation_awareness', 'conversation_awareness'],
    ];
    for (const [option, column] of boolOptions) {
      const value = interaction.options.getBoolean(option);
      if (value !== null) changes[column] = value;
    }
    const frequency = interaction.options.getString('frequency');
    const cooldown = interaction.options.getInteger('cooldown_minutes');
    if (frequency !== null) changes.activity_frequency = frequency;
    if (cooldown !== null) changes.minimum_cooldown_minutes = cooldown;

    if (!Object.keys(changes).length) {
      return interaction.reply(ephemeral('Nothing was changed.'));
    }

    const { error } = await supabase.from('teacher_settings').update(changes).eq('teacher_id', teacher.id);
    if (error) throw error;

    return interaction.reply(ephemeral(`✅ Automation settings updated for **${teacher.teacher_name}**.`));
  }
}

async function handleFinals(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'on') {
    const qNum = interaction.options.getInteger('quarter', true);
    const start = interaction.options.getString('start_date');
    const end = interaction.options.getString('end_date');

    if ((start && !validDate(start)) || (end && !validDate(end))) {
      return interaction.reply(ephemeral('Finals dates must use `YYYY-MM-DD`.'));
    }

    const { data: q, error: qe } = await supabase
      .from('quarters')
      .select('*')
      .eq('school_id', school.id)
      .eq('quarter_number', qNum)
      .maybeSingle();
    if (qe) throw qe;
    if (!q) return interaction.reply(ephemeral(`Set up Quarter ${qNum} first with \`/quarter setup\`.`));

    const { error } = await supabase.from('finals_settings').upsert({
      school_id: school.id,
      finals_enabled: true,
      active_quarter_id: q.id,
      start_date: start || null,
      end_date: end || null,
      one_final_per_school_day: true,
      counts_toward_grade: true,
    }, { onConflict: 'school_id' });
    if (error) throw error;

    return interaction.reply(ephemeral(`🎓 Finals Mode is **ON** for Quarter ${qNum}. One final can count each school day.`));
  }

  if (sub === 'off') {
    const { error } = await supabase.from('finals_settings')
      .upsert({ school_id: school.id, finals_enabled: false }, { onConflict: 'school_id' });
    if (error) throw error;
    return interaction.reply(ephemeral('✅ Finals Mode is **OFF**. Previously completed finals stay saved.'));
  }

  const { data, error } = await supabase.from('finals_settings')
    .select('*, quarters(quarter_number)')
    .eq('school_id', school.id)
    .maybeSingle();
  if (error) throw error;

  return interaction.reply(ephemeral(
    data?.finals_enabled
      ? `🎓 Finals Mode: **ON**${data.quarters?.quarter_number ? ` • Quarter ${data.quarters.quarter_number}` : ''}`
      : '🎓 Finals Mode: **OFF**'
  ));
}

async function handleDiscipline(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const name = interaction.options.getString('name', true);
    const type = interaction.options.getString('type', true);
    const duration = interaction.options.getInteger('duration', true);
    const unit = interaction.options.getString('unit', true);
    const reason = interaction.options.getString('reason');
    const location = interaction.options.getChannel('location');

    const starts = new Date();
    const ends = addDuration(starts, duration, unit);

    const { error } = await supabase.from('discipline').insert({
      school_id: school.id,
      student_name: name,
      student_name_normalized: normalizeName(name),
      discipline_type: type,
      reason,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      status: 'active',
      discord_location_channel_id: location?.id ?? null,
      allow_schoolwork: type !== 'suspension',
      activities_can_count_toward_grade: type !== 'suspension',
      created_by_discord_user_id: interaction.user.id,
    });
    if (error) throw error;

    return interaction.reply(ephemeral(
      `✅ **${name}** received **${type.toUpperCase()}** for **${duration} ${unit}**.\nEnds: <t:${Math.floor(ends.getTime() / 1000)}:F>`
    ));
  }

  const name = interaction.options.getString('name', true);
  const normalized = normalizeName(name);

  if (sub === 'remove') {
    const { error } = await supabase.from('discipline')
      .update({ status: 'cancelled' })
      .eq('school_id', school.id)
      .eq('student_name_normalized', normalized)
      .eq('status', 'active');
    if (error) throw error;
    return interaction.reply(ephemeral(`✅ Active discipline restrictions for **${name}** were ended.`));
  }

  const { data, error } = await supabase.from('active_discipline')
    .select('*')
    .eq('school_id', school.id)
    .eq('student_name_normalized', normalized)
    .order('ends_at', { ascending: false });
  if (error) throw error;

  if (!data?.length) return interaction.reply(ephemeral(`✅ **${name}** has no active discipline restriction.`));

  const lines = data.map((d) =>
    `• **${d.discipline_type.toUpperCase()}**${d.reason ? ` — ${d.reason}` : ''}${d.ends_at ? ` — ends <t:${Math.floor(new Date(d.ends_at).getTime() / 1000)}:R>` : ''}`
  );

  return interaction.reply(ephemeral(`**${name} — Discipline Status**\n${lines.join('\n')}`));
}

async function handleCalendar(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    const name = interaction.options.getString('name', true);
    const type = interaction.options.getString('type', true);
    const start = interaction.options.getString('start_date', true);
    const end = interaction.options.getString('end_date');
    const closed = interaction.options.getBoolean('school_closed', true);
    const description = interaction.options.getString('description');

    if (!validDate(start) || (end && !validDate(end)) || (end && end < start)) {
      return interaction.reply(ephemeral('Use valid `YYYY-MM-DD` dates.'));
    }

    const { error } = await supabase.from('school_calendar').insert({
      school_id: school.id,
      event_name: name,
      event_type: type,
      start_date: start,
      end_date: end || null,
      school_closed: closed,
      description,
    });
    if (error) throw error;

    return interaction.reply(ephemeral(`✅ Added **${name}** to the school calendar.`));
  }

  const today = getLocalParts(school.timezone).date;
  const { data, error } = await supabase.from('school_calendar')
    .select('*')
    .eq('school_id', school.id)
    .gte('start_date', today)
    .order('start_date')
    .limit(15);
  if (error) throw error;

  const lines = data?.length
    ? data.map((e) => `• **${e.start_date}** — ${e.event_name}${e.school_closed ? ' *(school closed)*' : ''}`)
    : ['No upcoming events saved.'];

  return interaction.reply(ephemeral(`📅 **Upcoming School Events**\n${lines.join('\n')}`));
}

async function buildActivityMenu(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const options = Object.entries(activityConfig)
    .filter(([key]) => key !== 'final')
    .map(([value, cfg]) =>
      new StringSelectMenuOptionBuilder().setLabel(cfg.label).setValue(value)
    );

  const { data: finals } = await supabase.from('finals_settings')
    .select('finals_enabled')
    .eq('school_id', school.id)
    .maybeSingle();

  if (finals?.finals_enabled) {
    options.push(new StringSelectMenuOptionBuilder().setLabel(activityConfig.final.label).setValue('final'));
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('campus_activity')
    .setPlaceholder('What is your character doing?')
    .addOptions(options.slice(0, 25));

  return interaction.reply({
    content: '🏫 **School Activity**\nChoose what your character is doing.',
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true,
  });
}

async function handleActivityChoice(interaction) {
  const school = await getSchool(interaction.guildId);
  if (!school) return interaction.update({ content: 'Campus is not set up yet.', components: [] });

  const activity = interaction.values[0];
  const cfg = activityConfig[activity];
  if (!cfg) return interaction.update({ content: 'That activity is not recognized.', components: [] });

  const routes = await getRoutes(school.id, cfg.routes);
  if (!routes.length) {
    return interaction.update({
      content: `I don't have any matching channels saved for **${cfg.label}** yet. An admin should run \`/routes setup\`.`,
      components: [],
    });
  }

  const options = routes.slice(0, 25).map((route) =>
    new StringSelectMenuOptionBuilder()
      .setLabel((route.channel_name || 'Channel').slice(0, 100))
      .setValue(String(route.id))
      .setDescription(route.route_type)
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`campus_destination:${activity}`)
    .setPlaceholder('Where is your character going?')
    .addOptions(options);

  return interaction.update({
    content: `**${cfg.label}**\nNow choose the class/location.`,
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

async function handleDestinationChoice(interaction) {
  const activity = interaction.customId.split(':')[1];
  const routeId = interaction.values[0];
  const school = await getSchool(interaction.guildId);
  const defaultDate = school ? getLocalParts(school.timezone).date : new Date().toISOString().slice(0, 10);

  const modal = new ModalBuilder()
    .setCustomId(`campus_activity_modal:${activity}:${routeId}`)
    .setTitle('School Activity');

  const name = new TextInputBuilder()
    .setCustomId('student_name')
    .setLabel('Character name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);

  const date = new TextInputBuilder()
    .setCustomId('activity_date')
    .setLabel('Date (YYYY-MM-DD)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(defaultDate)
    .setMaxLength(10);

  const assignment = new TextInputBuilder()
    .setCustomId('assignment_name')
    .setLabel('Assignment/book/activity name (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(150);

  const details = new TextInputBuilder()
    .setCustomId('details')
    .setLabel('Extra details (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(
    new ActionRowBuilder().addComponents(name),
    new ActionRowBuilder().addComponents(date),
    new ActionRowBuilder().addComponents(assignment),
    new ActionRowBuilder().addComponents(details),
  );

  return interaction.showModal(modal);
}

async function getActiveDiscipline(schoolId, normalized) {
  const { data, error } = await supabase.from('active_discipline')
    .select('*')
    .eq('school_id', schoolId)
    .eq('student_name_normalized', normalized)
    .order('ends_at', { ascending: false });
  if (error) throw error;

  const priority = { suspension: 3, iss: 2, detention: 1 };
  return (data ?? []).sort((a, b) => priority[b.discipline_type] - priority[a.discipline_type])[0] ?? null;
}

async function findDisciplineRoute(schoolId, type) {
  const routes = await getRoutes(schoolId, type);
  return routes[0] ?? null;
}

async function handleActivityModal(interaction) {
  const [, activity, routeId] = interaction.customId.split(':');
  const cfg = activityConfig[activity];
  const school = await getSchool(interaction.guildId);
  if (!school) return interaction.reply(ephemeral('Campus is not set up yet.'));

  const studentName = interaction.fields.getTextInputValue('student_name').trim();
  const normalized = normalizeName(studentName);
  const activityDate = interaction.fields.getTextInputValue('activity_date').trim();
  const assignmentName = interaction.fields.getTextInputValue('assignment_name').trim() || null;
  const details = interaction.fields.getTextInputValue('details').trim() || null;

  if (!studentName || !validDate(activityDate)) {
    return interaction.reply(ephemeral('Please enter a character name and a valid date like `2026-08-20`.'));
  }

  const { data: selectedRoute, error: routeError } = await supabase
    .from('channel_routes')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', Number(routeId))
    .maybeSingle();
  if (routeError) throw routeError;
  if (!selectedRoute) return interaction.reply(ephemeral('That saved channel route no longer exists.'));

  let route = selectedRoute;
  let discipline = await getActiveDiscipline(school.id, normalized);

  if (discipline?.discipline_type === 'suspension') {
    return interaction.reply(ephemeral(
      `🚫 **${studentName}** is currently suspended and cannot use school activities${discipline.ends_at ? ` until <t:${Math.floor(new Date(discipline.ends_at).getTime()/1000)}:F>` : ''}.`
    ));
  }

  const academic = ['assignment', 'study', 'reading', 'homework', 'tutoring', 'attend_class', 'library', 'study_hall', 'final'];

  if (discipline?.discipline_type === 'iss') {
    if (!academic.includes(activity)) {
      return interaction.reply(ephemeral(`⚠️ **${studentName}** is in ISS. Only approved schoolwork/study activities are available.`));
    }
    const issRoute = discipline.discord_location_channel_id
      ? { discord_channel_id: discipline.discord_location_channel_id, channel_name: 'ISS', route_type: 'iss' }
      : await findDisciplineRoute(school.id, 'iss');
    if (!issRoute) return interaction.reply(ephemeral('ISS is active, but Campus has no ISS channel saved. An admin should run `/routes setup`.'));
    route = issRoute;
  }

  if (discipline?.discipline_type === 'detention') {
    if (!academic.includes(activity) && activity !== 'detention') {
      return interaction.reply(ephemeral(`🚪 **${studentName}** is currently serving detention. Schoolwork is available, but this activity is restricted until detention ends.`));
    }
    if (discipline.discord_location_channel_id) {
      route = { discord_channel_id: discipline.discord_location_channel_id, channel_name: 'Detention', route_type: 'detention' };
    }
  }

  const quarter = await getQuarterForDate(school.id, activityDate);
  let countsTowardGrade = Boolean(cfg?.graded && quarter && !quarter.closed);

  if (discipline && discipline.activities_can_count_toward_grade === false) {
    countsTowardGrade = false;
  }

  if (activity === 'final') {
    const { data: finals, error } = await supabase.from('finals_settings')
      .select('*')
      .eq('school_id', school.id)
      .maybeSingle();
    if (error) throw error;
    if (!finals?.finals_enabled) {
      return interaction.reply(ephemeral('🎓 Finals Mode is currently OFF.'));
    }
    if (finals.start_date && activityDate < finals.start_date) {
      return interaction.reply(ephemeral('That date is before the current finals period.'));
    }
    if (finals.end_date && activityDate > finals.end_date) {
      return interaction.reply(ephemeral('That date is after the current finals period.'));
    }

    const weekday = new Date(`${activityDate}T12:00:00Z`).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    if (isWeekend && !finals.include_weekends) {
      return interaction.reply(ephemeral('🎓 Finals are not required on weekends.'));
    }

    const { data: holiday } = await supabase.from('school_calendar')
      .select('id')
      .eq('school_id', school.id)
      .eq('school_closed', true)
      .lte('start_date', activityDate)
      .or(`end_date.gte.${activityDate},end_date.is.null`)
      .limit(1);
    if (holiday?.length && !finals.include_school_holidays) {
      return interaction.reply(ephemeral('🎓 Finals are not required on school-closed calendar days.'));
    }

    const { error: finalError } = await supabase.from('final_completions').insert({
      school_id: school.id,
      student_name: studentName,
      student_name_normalized: normalized,
      final_date: activityDate,
      final_name: assignmentName || 'Daily Final',
      class_name: route.channel_name,
      discord_channel_id: route.discord_channel_id,
      quarter_id: quarter?.id ?? finals.active_quarter_id ?? null,
      counts_toward_grade: Boolean(finals.counts_toward_grade && quarter && !quarter.closed),
      discord_user_id: interaction.user.id,
    });

    if (finalError) {
      if (finalError.code === '23505') {
        return interaction.reply(ephemeral(`✅ **${studentName}** already completed a final for **${activityDate}**.`));
      }
      throw finalError;
    }
  } else {
    // Prevent an exact accidental duplicate while still allowing multiple different assignments.
    let duplicateQuery = supabase.from('student_activities')
      .select('id')
      .eq('school_id', school.id)
      .eq('student_name_normalized', normalized)
      .eq('activity_date', activityDate)
      .eq('activity_type', activity)
      .eq('discord_channel_id', route.discord_channel_id)
      .limit(1);

    if (assignmentName) duplicateQuery = duplicateQuery.eq('assignment_name', assignmentName);
    else duplicateQuery = duplicateQuery.is('assignment_name', null);

    const { data: duplicate } = await duplicateQuery;
    if (duplicate?.length) {
      return interaction.reply(ephemeral('That exact activity is already logged for this character on that date.'));
    }

    const { error } = await supabase.from('student_activities').insert({
      school_id: school.id,
      student_name: studentName,
      student_name_normalized: normalized,
      activity_date: activityDate,
      activity_type: activity,
      assignment_name: assignmentName,
      destination_name: route.channel_name,
      discord_channel_id: route.discord_channel_id,
      counts_toward_grade: countsTowardGrade,
      quarter_id: quarter?.id ?? null,
      discord_user_id: interaction.user.id,
      extra_data: details ? { details } : {},
    });
    if (error) throw error;
  }

  const channel = await interaction.guild.channels.fetch(route.discord_channel_id).catch(() => null);
  if (!channel?.isTextBased()) {
    return interaction.reply(ephemeral('The activity was saved, but I could not post in the destination channel.'));
  }

  const title = activity === 'final'
    ? `🎓 ${studentName} is completing today’s final.`
    : assignmentName
      ? `${cfg.label.split(' ')[0]} ${studentName} is working on **${assignmentName}**.`
      : `${cfg.label.split(' ')[0]} ${studentName} — ${cfg.label.replace(/^[^\s]+\s/, '')}`;

  let displayedCredit = countsTowardGrade;
  if (activity === 'final') {
    const { data: savedFinal } = await supabase
      .from('final_completions')
      .select('counts_toward_grade')
      .eq('school_id', school.id)
      .eq('student_name_normalized', normalized)
      .eq('final_date', activityDate)
      .maybeSingle();
    displayedCredit = Boolean(savedFinal?.counts_toward_grade);
  }

  const embed = new EmbedBuilder()
    .setTitle('Campus School Activity')
    .setDescription(title)
    .addFields(
      { name: 'Date', value: activityDate, inline: true },
      { name: 'Location/Class', value: route.channel_name || 'School', inline: true },
      { name: 'Quarter Credit', value: displayedCredit ? '✅ Counts' : '— Does not count', inline: true },
    );

  if (details) embed.addFields({ name: 'Details', value: details.slice(0, 1024) });

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

  const teacherFound = route.route_type === 'classroom'
    ? await resolveActiveTeacher(school.id, route.discord_channel_id)
    : null;

  if (teacherFound?.settings?.assignment_acknowledgement && teacherFound.settings.automation_enabled) {
    const reply = await teacherActivityReply({
      teacher: teacherFound.teacher,
      studentName,
      activityType: activity,
      assignmentName,
      destination: route.channel_name,
    }).catch((e) => {
      console.error('Teacher activity AI error:', e.message);
      return null;
    });

    if (reply) {
      await sendAsTeacher(channel, teacherFound.teacher, reply);
      await rememberTeacherEvent({
        schoolId: school.id,
        teacherId: teacherFound.teacher.id,
        studentName,
        type: 'student',
        text: `${studentName} logged ${activity}${assignmentName ? ` (${assignmentName})` : ''} on ${activityDate}.`,
      });
    }
  }

  const creditText = activity === 'final'
    ? 'Final saved.'
    : countsTowardGrade
      ? 'This added **+1 qualifying action** to the matching quarter.'
      : quarter
        ? 'This activity was saved but does not count toward the grade.'
        : 'This was saved, but no quarter contains that date, so it did not count toward a grade.';

  return interaction.reply(ephemeral(`✅ **${studentName}** was posted in <#${route.discord_channel_id}>.\n${creditText}`));
}

async function getProgressData(school, name) {
  const normalized = normalizeName(name);
  const { data: quarters, error: qe } = await supabase.from('quarters')
    .select('*')
    .eq('school_id', school.id)
    .order('quarter_number');
  if (qe) throw qe;

  const { data: progress, error: pe } = await supabase.from('student_quarter_progress')
    .select('*')
    .eq('school_id', school.id)
    .eq('student_name_normalized', normalized);
  if (pe) throw pe;

  const map = new Map((progress ?? []).map((p) => [p.quarter_id, p]));
  return quarters.map((q) => {
    const p = map.get(q.id);
    const completed = p?.completed_actions ?? 0;
    const percent = Math.min(100, Math.round((completed / q.required_actions) * 100));
    return { ...q, completed, percent, letter: letterGrade(percent, school.grading_scale) };
  });
}

async function handleProgress(interaction, gradeMode = false) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const name = interaction.options.getString('name', true);
  const rows = await getProgressData(school, name);

  if (!rows.length) return interaction.reply(ephemeral('No quarters are configured yet. An admin needs to run `/quarter setup`.'));

  const lines = rows.map((q) => {
    if (gradeMode) {
      return `**Q${q.quarter_number}: ${q.letter}** — ${q.completed}/${q.required_actions} actions (${q.percent}%)${q.closed ? ' • Final' : ' • Current'}`;
    }
    const remaining = Math.max(0, q.required_actions - q.completed);
    return `**Q${q.quarter_number}:** ${q.completed}/${q.required_actions} • ${q.percent}% • ${remaining} remaining`;
  });

  return interaction.reply(ephemeral(
    `${gradeMode ? '🎓' : '📚'} **${name} — ${gradeMode ? 'Grades' : 'Progress'}**\n${lines.join('\n')}`
  ));
}

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'campus': return handleCampus(interaction);
    case 'quarter': return handleQuarter(interaction);
    case 'routes': return handleRoutes(interaction);
    case 'teacher': return handleTeacher(interaction);
    case 'finals': return handleFinals(interaction);
    case 'discipline': return handleDiscipline(interaction);
    case 'calendar': return handleCalendar(interaction);
    case 'activity': return buildActivityMenu(interaction);
    case 'progress': return handleProgress(interaction, false);
    case 'grade': return handleProgress(interaction, true);
    default: return interaction.reply(ephemeral('Unknown Campus command.'));
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Campus logged in as ${readyClient.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Command registration failed:', error);
  }
  console.log(aiEnabled()
    ? `AI teachers enabled with ${process.env.OPENAI_MODEL || 'gpt-5.6-luna'}.`
    : 'AI teachers are currently OFF because OPENAI_API_KEY is not set.');
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      return await handleCommand(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'campus_activity') return await handleActivityChoice(interaction);
      if (interaction.customId.startsWith('campus_destination:')) return await handleDestinationChoice(interaction);
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'campus_teacher_create' || interaction.customId.startsWith('campus_teacher_edit:')) {
        return await handleTeacherModal(interaction);
      }

      if (interaction.customId.startsWith('campus_activity_modal:')) {
        return await handleActivityModal(interaction);
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    const payload = ephemeral(`Campus hit an error: \`${String(error.message || error).slice(0, 150)}\``);
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!aiEnabled() || message.author.bot || !message.guild || !message.content) return;

  try {
    const school = await getSchool(message.guild.id);
    if (!school) return;

    const found = await resolveActiveTeacher(school.id, message.channel.id);
    if (!found) return;

    const { teacher, settings } = found;
    if (!settings?.automation_enabled || !settings.conversation_awareness || !settings.respond_to_students) return;

    const quiet = settings.obey_school_quiet_hours ? await schoolIsQuiet(school) : false;
    if (quiet) {
      const allowDirect = school.quiet_hours_settings?.allow_direct_teacher_responses !== false;
      const first = teacher.teacher_name.split(/\s+/).at(-1)?.toLowerCase();
      const directlyAddressed =
        message.mentions.has(client.user) ||
        message.content.toLowerCase().includes(teacher.teacher_name.toLowerCase()) ||
        (first && message.content.toLowerCase().includes(first));
      if (!allowDirect || !directlyAddressed) return;
    }

    const last = lastTeacherAction.get(teacher.id) || 0;
    const cooldown = (settings.minimum_cooldown_minutes ?? 30) * 60_000;
    if (Date.now() - last < cooldown) return;

    const directlyAddressed =
      message.content.includes('?') ||
      message.content.toLowerCase().includes(teacher.teacher_name.toLowerCase()) ||
      message.mentions.has(client.user);

    if (!directlyAddressed) {
      const chance = (settings.reaction_chance_percent ?? 25) / 100;
      if (Math.random() > chance) return;
    }

    const fetched = await message.channel.messages.fetch({ limit: 12 });
    const recent = [...fetched.values()]
      .reverse()
      .filter((m) => !m.author.bot)
      .map((m) => `${m.member?.displayName || m.author.username}: ${m.content}`)
      .filter(Boolean);

    const decision = await teacherConversationDecision({
      teacher,
      recentMessages: recent,
      triggeringMessage: message.content,
      spontaneous: false,
    });

    if (decision.type === 'react' && settings.react_to_messages) {
      await message.react(decision.emoji).catch(() => {});
      lastTeacherAction.set(teacher.id, Date.now());
    } else if (decision.type === 'reply') {
      await sendAsTeacher(message.channel, teacher, decision.content);
      lastTeacherAction.set(teacher.id, Date.now());
      await rememberTeacherEvent({
        schoolId: school.id,
        teacherId: teacher.id,
        type: 'classroom',
        text: `Recent classroom exchange: ${message.content.slice(0, 220)} / Teacher replied: ${decision.content.slice(0, 220)}`,
        days: 14,
      });
    }
  } catch (error) {
    console.error('Conversation awareness error:', error.message);
  }
});

const frequencyChance = {
  very_low: 0.03,
  low: 0.07,
  normal: 0.15,
  high: 0.30,
  very_high: 0.50,
};

async function spontaneousTeacherTick() {
  if (!aiEnabled() || !client.isReady()) return;

  const { data: teachers, error } = await supabase
    .from('teachers')
    .select('*, teacher_settings(*)')
    .eq('status', 'active');

  if (error) {
    console.error('Teacher tick DB error:', error.message);
    return;
  }

  for (const teacher of teachers ?? []) {
    try {
      const settings = Array.isArray(teacher.teacher_settings)
        ? teacher.teacher_settings[0]
        : teacher.teacher_settings;

      if (!settings?.automation_enabled || !settings.spontaneous_messages || !settings.start_conversations) continue;

      const { data: school, error: se } = await supabase.from('schools')
        .select('*')
        .eq('id', teacher.school_id)
        .maybeSingle();
      if (se || !school) continue;

      if (settings.obey_school_quiet_hours && await schoolIsQuiet(school)) continue;

      const cooldown = (settings.minimum_cooldown_minutes ?? 30) * 60_000;
      if (Date.now() - (lastTeacherAction.get(teacher.id) || 0) < cooldown) continue;

      const history = (spontaneousHistory.get(teacher.id) || []).filter((t) => Date.now() - t < 3_600_000);
      if (history.length >= (settings.max_spontaneous_messages_per_hour ?? 2)) continue;

      const chance = settings.activity_frequency === 'custom'
        ? (settings.conversation_start_chance_percent ?? 10) / 100
        : frequencyChance[settings.activity_frequency] ?? 0.15;

      if (Math.random() > chance) continue;

      const guild = client.guilds.cache.find((g) => g.id === school.discord_guild_id);
      if (!guild) continue;
      const channel = await guild.channels.fetch(teacher.classroom_channel_id).catch(() => null);
      if (!channel?.isTextBased()) continue;

      const fetched = await channel.messages.fetch({ limit: 15 });
      const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const newest = messages.at(-1);
      if (!newest || Date.now() - newest.createdTimestamp > 2 * 3_600_000) continue;

      const recent = messages
        .filter((m) => !m.author.bot)
        .map((m) => `${m.member?.displayName || m.author.username}: ${m.content}`)
        .filter(Boolean);

      const decision = await teacherConversationDecision({
        teacher,
        recentMessages: recent,
        triggeringMessage: '',
        spontaneous: true,
      });

      if (decision.type === 'reply') {
        await sendAsTeacher(channel, teacher, decision.content);
        const now = Date.now();
        lastTeacherAction.set(teacher.id, now);
        spontaneousHistory.set(teacher.id, [...history, now]);
      }
    } catch (error) {
      console.error(`Spontaneous teacher ${teacher.id} error:`, error.message);
    }
  }
}

const tickMinutes = Math.max(1, Number(process.env.TEACHER_TICK_MINUTES || 10));
setInterval(spontaneousTeacherTick, tickMinutes * 60_000);

client.login(process.env.DISCORD_TOKEN);
