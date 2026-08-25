import express from 'express';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  LabelBuilder,
  MessageFlags,
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
  return { content, flags: MessageFlags.Ephemeral };
}

async function respondInteraction(interaction, payload) {
  if (interaction.deferred) return interaction.editReply(payload);
  if (interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
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
      if (substitute && !['away', 'paused'].includes(substitute.status)) {
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
      return { teacher, settings };
    }

    // The regular teacher is absent and no substitute has been assigned.
    return null;
  }

  return { teacher, settings };
}

function timezoneCodeFromIana(timezone) {
  const map = {
    'America/New_York': 'EST',
    'America/Chicago': 'CST',
    'America/Los_Angeles': 'PST',
  };
  return map[timezone] || 'PST';
}

function timezoneFromCode(value) {
  const cleaned = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  const map = {
    EST: 'America/New_York',
    ET: 'America/New_York',
    EASTERN: 'America/New_York',
    CST: 'America/Chicago',
    CT: 'America/Chicago',
    CENTRAL: 'America/Chicago',
    PST: 'America/Los_Angeles',
    PT: 'America/Los_Angeles',
    PACIFIC: 'America/Los_Angeles',
  };
  return map[cleaned] || null;
}

function parseSchoolTime(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/\./g, '');

  // Already in 24-hour HH:MM format.
  if (validTime(raw)) return raw;

  // Friendly 12-hour entries such as 8 AM, 8:00 AM, 3:30 PM.
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '00');
  const period = match[3];

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (period === 'AM' && hour === 12) hour = 0;
  if (period === 'PM' && hour !== 12) hour += 12;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function displaySchoolTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return value || '';
  let hour = Number(match[1]);
  const minute = match[2];
  const period = hour >= 12 ? 'PM' : 'AM';
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

function parseYesNo(value) {
  const cleaned = String(value || '').trim().toLowerCase();
  if (['yes', 'y', 'on', 'true', '1'].includes(cleaned)) return true;
  if (['no', 'n', 'off', 'false', '0'].includes(cleaned)) return false;
  return null;
}

function campusSetupModal(school = null) {
  const schoolName = new TextInputBuilder()
    .setCustomId('school_name')
    .setLabel('School Name')
    .setPlaceholder('Beverly Academy')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const timezone = new TextInputBuilder()
    .setCustomId('school_timezone')
    .setLabel('Timezone — EST, CST, or PST')
    .setPlaceholder('PST')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);

  const startTime = new TextInputBuilder()
    .setCustomId('school_start')
    .setLabel('School Start Time')
    .setPlaceholder('8:00 AM')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);

  const endTime = new TextInputBuilder()
    .setCustomId('school_end')
    .setLabel('School End Time')
    .setPlaceholder('3:00 PM')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20);

  const quietHours = new TextInputBuilder()
    .setCustomId('quiet_hours')
    .setLabel('Quiet Hours Outside School? Yes or No')
    .setPlaceholder('Yes')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(10);

  if (school) {
    if (school.school_name) schoolName.setValue(String(school.school_name).slice(0, 100));
    timezone.setValue(timezoneCodeFromIana(school.timezone));
    if (school.school_day_start) startTime.setValue(displaySchoolTime(school.school_day_start));
    if (school.school_day_end) endTime.setValue(displaySchoolTime(school.school_day_end));
    quietHours.setValue(school.quiet_hours_enabled === false ? 'No' : 'Yes');
  }

  return new ModalBuilder()
    .setCustomId('campus_school_setup')
    .setTitle(school ? 'Edit School Registration' : 'School Registration')
    .addComponents(
      new ActionRowBuilder().addComponents(schoolName),
      new ActionRowBuilder().addComponents(timezone),
      new ActionRowBuilder().addComponents(startTime),
      new ActionRowBuilder().addComponents(endTime),
      new ActionRowBuilder().addComponents(quietHours),
    );
}

async function handleCampus(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub !== 'setup') return;

  const existing = await getSchool(interaction.guildId);
  return interaction.showModal(campusSetupModal(existing));
}

async function handleCampusSetupModal(interaction) {
  const schoolName = interaction.fields.getTextInputValue('school_name').trim();
  const timezoneInput = interaction.fields.getTextInputValue('school_timezone').trim();
  const startInput = interaction.fields.getTextInputValue('school_start').trim();
  const endInput = interaction.fields.getTextInputValue('school_end').trim();
  const quietInput = interaction.fields.getTextInputValue('quiet_hours').trim();

  const timezone = timezoneFromCode(timezoneInput);
  if (!timezone) {
    return respondInteraction(interaction, ephemeral('For timezone, type **EST**, **CST**, or **PST**.'));
  }

  const start = parseSchoolTime(startInput);
  const end = parseSchoolTime(endInput);
  if (!start || !end) {
    return respondInteraction(interaction, ephemeral(
      'For school times, type something like **8:00 AM** and **3:00 PM**. You can also use 24-hour times like `08:00` and `15:00`.'
    ));
  }

  const quiet = parseYesNo(quietInput);
  if (quiet === null) {
    return respondInteraction(interaction, ephemeral('For Quiet Hours, type **Yes** or **No**.'));
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

  await respondInteraction(interaction, ephemeral(
    `✅ **${schoolName}** is registered with Campus!\n`
    + `🕒 Timezone: **${timezoneCodeFromIana(timezone)}**\n`
    + `🏫 School hours: **${displaySchoolTime(start)} – ${displaySchoolTime(end)}**\n`
    + `🌙 Quiet hours: **${quiet ? 'ON' : 'OFF'}**\n\n`
    + 'Run `/campus setup` again anytime to edit these settings.'
  ));
}

function quarterSetupModal() {
  const quarterSelect = new StringSelectMenuBuilder()
    .setCustomId('quarter_number')
    .setPlaceholder('Choose Quarter 1, 2, 3, or 4')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Quarter 1').setValue('1'),
      new StringSelectMenuOptionBuilder().setLabel('Quarter 2').setValue('2'),
      new StringSelectMenuOptionBuilder().setLabel('Quarter 3').setValue('3'),
      new StringSelectMenuOptionBuilder().setLabel('Quarter 4').setValue('4'),
    );

  const startDate = new TextInputBuilder()
    .setCustomId('quarter_start_date')
    .setPlaceholder('2026-08-24')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(10);

  const endDate = new TextInputBuilder()
    .setCustomId('quarter_end_date')
    .setPlaceholder('2026-10-16')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(10);

  const requiredActions = new TextInputBuilder()
    .setCustomId('quarter_required_actions')
    .setPlaceholder('15')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3);

  return new ModalBuilder()
    .setCustomId('campus_quarter_setup')
    .setTitle('Quarter Setup')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Which Quarter?')
        .setStringSelectMenuComponent(quarterSelect),
      new LabelBuilder()
        .setLabel('Start Date')
        .setDescription('Use YYYY-MM-DD, for example 2026-08-24.')
        .setTextInputComponent(startDate),
      new LabelBuilder()
        .setLabel('End Date')
        .setDescription('Use YYYY-MM-DD, for example 2026-10-16.')
        .setTextInputComponent(endDate),
      new LabelBuilder()
        .setLabel('Required Qualifying Actions')
        .setDescription('How many graded actions are needed for this quarter?')
        .setTextInputComponent(requiredActions),
    );
}

async function handleQuarter(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  return interaction.showModal(quarterSetupModal());
}

async function handleQuarterSetupModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const quarterValues = interaction.fields.getStringSelectValues('quarter_number');
  const q = Number(quarterValues?.[0]);
  const start = interaction.fields.getTextInputValue('quarter_start_date').trim();
  const end = interaction.fields.getTextInputValue('quarter_end_date').trim();
  const requiredRaw = interaction.fields.getTextInputValue('quarter_required_actions').trim();
  const required = Number(requiredRaw);

  if (![1, 2, 3, 4].includes(q)) {
    return respondInteraction(interaction, ephemeral('Choose **Quarter 1, 2, 3, or 4**.'));
  }

  if (!validDate(start) || !validDate(end) || end < start) {
    return respondInteraction(interaction, ephemeral(
      'Use valid dates like `2026-08-24`, and make sure the end date is after the start date.'
    ));
  }

  if (!Number.isInteger(required) || required < 1 || required > 999) {
    return respondInteraction(interaction, ephemeral('Required Actions needs to be a whole number of at least **1**.'));
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

  await respondInteraction(interaction, ephemeral(
    `✅ **Quarter ${q}** saved: ${start} → ${end}, with **${required} qualifying actions** required.`
  ));
}

function routesSetupModal() {
  const groupSelect = new StringSelectMenuBuilder()
    .setCustomId('route_group')
    .setPlaceholder('Choose what these categories contain')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Classrooms').setValue('classrooms'),
      new StringSelectMenuOptionBuilder().setLabel('School Locations').setValue('locations'),
      new StringSelectMenuOptionBuilder().setLabel('Clubs & Activities').setValue('clubs'),
      new StringSelectMenuOptionBuilder().setLabel('Discipline').setValue('discipline'),
    );

  const categorySelect = new ChannelSelectMenuBuilder()
    .setCustomId('route_categories')
    .setPlaceholder('Choose one or more Discord categories')
    .setChannelTypes(ChannelType.GuildCategory)
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(25);

  return new ModalBuilder()
    .setCustomId('campus_routes_setup')
    .setTitle('Route Setup')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('What Type of Channels Are These?')
        .setStringSelectMenuComponent(groupSelect),
      new LabelBuilder()
        .setLabel('Discord Categories')
        .setDescription('Pick ALL categories that belong to this route type. You can select multiple.')
        .setChannelSelectMenuComponent(categorySelect),
    );
}

async function handleRoutes(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  return interaction.showModal(routesSetupModal());
}

async function saveRouteCategory(school, group, category) {
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

  return count;
}

async function handleRoutesSetupModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const groupValues = interaction.fields.getStringSelectValues('route_group');
  const group = groupValues?.[0];
  const validGroups = ['classrooms', 'locations', 'clubs', 'discipline'];

  if (!validGroups.includes(group)) {
    return respondInteraction(interaction, ephemeral('Choose a valid route type.'));
  }

  const selectedCategories = interaction.fields.getSelectedChannels(
    'route_categories',
    true,
    [ChannelType.GuildCategory],
  );

  const categories = [...selectedCategories.values()];
  if (!categories.length) {
    return respondInteraction(interaction, ephemeral('Choose at least one Discord category.'));
  }

  let totalChannels = 0;
  const savedNames = [];

  for (const category of categories) {
    if (category.type !== ChannelType.GuildCategory) continue;
    totalChannels += await saveRouteCategory(school, group, category);
    savedNames.push(category.name);
  }

  if (!savedNames.length) {
    return respondInteraction(interaction, ephemeral('I could not use any of the selected categories.'));
  }

  const groupLabel = {
    classrooms: 'Classrooms',
    locations: 'School Locations',
    clubs: 'Clubs & Activities',
    discipline: 'Discipline',
  }[group];

  await respondInteraction(interaction, ephemeral(
    `✅ Added **${savedNames.length} categor${savedNames.length === 1 ? 'y' : 'ies'}** to **${groupLabel}**.\n`
    + `📁 ${savedNames.map((name) => `**${name}**`).join(', ')}\n`
    + `🔗 Campus found **${totalChannels} usable channels** across them.\n\n`
    + 'You can run `/routes setup` again anytime to add even more categories. Existing categories stay saved.'
  ));
}


async function teacherModal(school, customId, title, teacher = null) {
  const subjectGradeValue = teacher
    ? [teacher.subject, teacher.grade_level].filter(Boolean).join(' | ')
    : '';

  const nameInput = new TextInputBuilder()
    .setCustomId('teacher_name')
    .setPlaceholder('Mr. Chicken')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);

  const subjectGradeInput = new TextInputBuilder()
    .setCustomId('teacher_subject_grade')
    .setPlaceholder('Science | 5th Grade')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const classroomSelect = new ChannelSelectMenuBuilder()
    .setCustomId('teacher_classroom')
    .setPlaceholder('Choose a channel')
    .setChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread
    )
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1);

  if (teacher?.classroom_channel_id) {
    classroomSelect.setDefaultChannels(String(teacher.classroom_channel_id));
  }

  const personalityInput = new TextInputBuilder()
    .setCustomId('teacher_personality')
    .setPlaceholder('Goofy, upbeat, friendly, patient, gets serious when needed...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  const teachingStyleInput = new TextInputBuilder()
    .setCustomId('teacher_teaching_style')
    .setPlaceholder('Hands-on lessons, simple explanations, lots of encouragement...')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  if (teacher) {
    nameInput.setValue(String(teacher.teacher_name ?? '').slice(0, 80));
    if (subjectGradeValue) subjectGradeInput.setValue(subjectGradeValue.slice(0, 100));
    if (teacher.personality) personalityInput.setValue(String(teacher.personality).slice(0, 1000));
    if (teacher.teaching_style) teachingStyleInput.setValue(String(teacher.teaching_style).slice(0, 1000));
  }

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder().setLabel('Teacher Name').setTextInputComponent(nameInput),
      new LabelBuilder().setLabel('Subject + Grade').setTextInputComponent(subjectGradeInput),
      new LabelBuilder()
        .setLabel('Assigned Channel')
        .setDescription('Choose any text channel in this Discord server.')
        .setChannelSelectMenuComponent(classroomSelect),
      new LabelBuilder().setLabel('Personality').setTextInputComponent(personalityInput),
      new LabelBuilder().setLabel('Teaching Style').setTextInputComponent(teachingStyleInput),
    );
}

function parseTeacherPersonalDetails(lore) {
  const result = { favorites: '', quirks: '', petPeeves: '', likes: '', dislikes: '' };
  const raw = String(lore ?? '').trim();
  if (!raw) return result;

  let matched = false;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(Favorites?|Quirks?|Pet\s*Peeves?|Likes?|Dislikes?)\s*:\s*(.*)$/i);
    if (!m) continue;
    matched = true;
    const key = m[1].toLowerCase().replace(/\s+/g, ' ');
    const value = m[2].trim();
    if (key.startsWith('favorite')) result.favorites = value;
    else if (key.startsWith('quirk')) result.quirks = value;
    else if (key.startsWith('pet')) result.petPeeves = value;
    else if (key.startsWith('like')) result.likes = value;
    else if (key.startsWith('dislike')) result.dislikes = value;
  }

  // Preserve older generalized teacher details instead of silently losing them.
  if (!matched) result.likes = raw;
  return result;
}

function formatTeacherPersonalDetails({ favorites, quirks, petPeeves, likes, dislikes }) {
  return [
    `Favorites: ${favorites || 'None specified'}`,
    `Quirks: ${quirks || 'None specified'}`,
    `Pet Peeves: ${petPeeves || 'None specified'}`,
    `Likes: ${likes || 'None specified'}`,
    `Dislikes: ${dislikes || 'None specified'}`,
  ].join('\n');
}

function teacherPersonalDetailsModal(teacher) {
  const current = parseTeacherPersonalDetails(teacher?.lore);

  const makeInput = (id, placeholder, value = '') => {
    const input = new TextInputBuilder()
      .setCustomId(id)
      .setPlaceholder(placeholder)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(750);
    if (value) input.setValue(String(value).slice(0, 750));
    return input;
  };

  return new ModalBuilder()
    .setCustomId(`campus_teacher_personal:${teacher.id}`)
    .setTitle('Teacher Personal Details')
    .addLabelComponents(
      new LabelBuilder().setLabel('Favorites').setTextInputComponent(
        makeInput('teacher_favorites', 'Favorite foods, colors, drinks, music, sports...', current.favorites)
      ),
      new LabelBuilder().setLabel('Quirks').setTextInputComponent(
        makeInput('teacher_quirks', 'Little habits, funny behaviors, signature mannerisms...', current.quirks)
      ),
      new LabelBuilder().setLabel('Pet Peeves').setTextInputComponent(
        makeInput('teacher_pet_peeves', 'Things that annoy or bother this teacher...', current.petPeeves)
      ),
      new LabelBuilder().setLabel('Likes').setTextInputComponent(
        makeInput('teacher_likes', 'Things this teacher especially enjoys...', current.likes)
      ),
      new LabelBuilder().setLabel('Dislikes').setTextInputComponent(
        makeInput('teacher_dislikes', 'Things this teacher does not like...', current.dislikes)
      ),
    );
}

function personalDetailsButton(teacherId, label = 'Add Personal Details') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`campus_teacher_personal_open:${teacherId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Primary)
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


function isTeacherAssignableChannel(channel) {
  return Boolean(channel && [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type));
}

async function handleTeacherModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const teacherName = interaction.fields.getTextInputValue('teacher_name').trim();
  const subjectGrade = interaction.fields.getTextInputValue('teacher_subject_grade').trim();
  const selectedChannels = interaction.fields.getSelectedChannels(
    'teacher_classroom',
    true,
  );
  const classroom = selectedChannels?.first() ?? null;
  const personality = interaction.fields.getTextInputValue('teacher_personality').trim();
  const teachingStyle = interaction.fields.getTextInputValue('teacher_teaching_style').trim();

  const { subject, gradeLevel } = parseSubjectAndGrade(subjectGrade);

  if (!isTeacherAssignableChannel(classroom)) {
    return respondInteraction(interaction, ephemeral(
      'That channel/thread no longer exists or Campus cannot use it.'
    ));
  }

  if (interaction.customId === 'campus_teacher_create') {
    const existing = await findTeacher(school.id, teacherName);
    if (existing) {
      return respondInteraction(interaction, ephemeral(
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
      teaching_style: teachingStyle,
      lore: null,
      strictness: 5,
      talkativeness: 5,
      humor: 5,
      patience: 5,
      status: 'active',
    }).select().single();

    if (error) throw error;

    return respondInteraction(interaction, {
      content:
        `✅ **${data.teacher_name}** was created.\n`
        + `📚 **${data.subject}**${data.grade_level ? ` • ${data.grade_level}` : ''}\n`
        + `🏫 Assigned channel: <#${data.classroom_channel_id}>\n\n`
        + 'Now add their **Favorites, Quirks, Pet Peeves, Likes, and Dislikes**.',
      components: [personalDetailsButton(data.id)],
      flags: MessageFlags.Ephemeral,
    });
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
    return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));
  }

  const changes = {
    teacher_name: teacherName,
    subject,
    grade_level: gradeLevel,
    classroom_channel_id: classroom.id,
    personality,
    teaching_style: teachingStyle,
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

  return respondInteraction(interaction, {
    content:
      `✅ **${teacherName}** was updated without erasing their history or teacher memory.\n`
      + `🏫 Assigned channel: <#${classroom.id}>`,
    components: [personalDetailsButton(oldTeacher.id, 'Edit Personal Details')],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTeacherPersonalDetailsModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_personal:(.+)$/);
  if (!match) return;
  const teacherId = match[1];

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('id, teacher_name')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  const details = {
    favorites: interaction.fields.getTextInputValue('teacher_favorites').trim(),
    quirks: interaction.fields.getTextInputValue('teacher_quirks').trim(),
    petPeeves: interaction.fields.getTextInputValue('teacher_pet_peeves').trim(),
    likes: interaction.fields.getTextInputValue('teacher_likes').trim(),
    dislikes: interaction.fields.getTextInputValue('teacher_dislikes').trim(),
  };
  const lore = formatTeacherPersonalDetails(details);

  const { error: updateError } = await supabase.from('teachers').update({ lore }).eq('id', teacher.id);
  if (updateError) throw updateError;

  await supabase.from('change_history').insert({
    school_id: school.id,
    entity_type: 'teacher',
    entity_id: String(teacher.id),
    action: 'edit_personal_details',
    new_value: details,
    changed_by_discord_user_id: interaction.user.id,
  });

  return respondInteraction(interaction, ephemeral(
    `✅ Personal details saved for **${teacher.teacher_name}**.\n`
    + 'Favorites • Quirks • Pet Peeves • Likes • Dislikes are now stored separately in their profile.'
  ));
}

async function openTeacherPersonalDetails(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_personal_open:(.+)$/);
  if (!match) return;
  const teacherId = match[1];

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  return interaction.showModal(teacherPersonalDetailsModal(teacher));
}

async function getTeacherChoices(schoolId) {
  const { data, error } = await supabase
    .from('teachers')
    .select('id, teacher_name, subject, grade_level, status')
    .eq('school_id', schoolId)
    .order('teacher_name')
    .limit(25);

  if (error) throw error;
  return data ?? [];
}

function teacherChoiceOptions(teachers) {
  return teachers.map((teacher) => {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(String(teacher.teacher_name).slice(0, 100))
      .setValue(String(teacher.id));

    const details = [teacher.subject, teacher.grade_level]
      .filter(Boolean)
      .join(' • ')
      .slice(0, 100);
    if (details) option.setDescription(details);
    return option;
  });
}

function teacherEditModal(teachers) {
  const teacherSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_edit_target')
    .setPlaceholder('Choose the teacher to edit')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(teacherChoiceOptions(teachers));

  const identity = new TextInputBuilder()
    .setCustomId('teacher_edit_identity')
    .setPlaceholder('Mr. Chicken | Science | 5th Grade')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(180);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('teacher_edit_channel')
    .setPlaceholder('Choose a new channel, or leave blank')
    .setChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread
    )
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1);

  const personality = new TextInputBuilder()
    .setCustomId('teacher_edit_personality')
    .setPlaceholder('Leave blank to keep the current personality.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  const teachingStyle = new TextInputBuilder()
    .setCustomId('teacher_edit_teaching_style')
    .setPlaceholder('Leave blank to keep the current teaching style.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  return new ModalBuilder()
    .setCustomId('campus_teacher_edit_picker')
    .setTitle('Edit Teacher')
    .addLabelComponents(
      new LabelBuilder().setLabel('Which Teacher?').setStringSelectMenuComponent(teacherSelect),
      new LabelBuilder()
        .setLabel('Name | Subject | Grade')
        .setDescription('Optional. Leave blank to keep their current identity.')
        .setTextInputComponent(identity),
      new LabelBuilder()
        .setLabel('Assigned Channel')
        .setDescription('Optional. Choose any server text channel.')
        .setChannelSelectMenuComponent(channelSelect),
      new LabelBuilder().setLabel('Personality').setTextInputComponent(personality),
      new LabelBuilder().setLabel('Teaching Style').setTextInputComponent(teachingStyle),
    );
}

function parseTeacherIdentityEdit(raw, teacher) {
  const value = String(raw || '').trim();
  if (!value) {
    return {
      teacher_name: teacher.teacher_name,
      subject: teacher.subject,
      grade_level: teacher.grade_level,
    };
  }

  const parts = value.split('|').map((part) => part.trim());
  if (parts.length >= 2) {
    return {
      teacher_name: parts[0] || teacher.teacher_name,
      subject: parts[1] || teacher.subject,
      grade_level: parts.slice(2).join(' | ').trim() || teacher.grade_level,
    };
  }

  return {
    teacher_name: value,
    subject: teacher.subject,
    grade_level: teacher.grade_level,
  };
}

function teacherStatusModal(teachers) {
  const teacherSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_status_target')
    .setPlaceholder('Choose a teacher')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(teacherChoiceOptions(teachers));

  const statusSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_status_value')
    .setPlaceholder('Choose a status')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('🟢 Active').setValue('active'),
      new StringSelectMenuOptionBuilder().setLabel('🔵 Reactive Only').setValue('reactive_only'),
      new StringSelectMenuOptionBuilder().setLabel('🟡 Away').setValue('away'),
      new StringSelectMenuOptionBuilder().setLabel('🟣 Substitute Mode').setValue('substitute_mode'),
      new StringSelectMenuOptionBuilder().setLabel('🔴 Paused').setValue('paused'),
    );

  const substituteMode = new StringSelectMenuBuilder()
    .setCustomId('teacher_substitute_mode')
    .setPlaceholder('Only matters for Substitute Mode')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('No substitute selected').setValue('none'),
      new StringSelectMenuOptionBuilder().setLabel('Use generic substitute').setValue('generic'),
      new StringSelectMenuOptionBuilder().setLabel('Use a saved teacher').setValue('saved'),
    );

  const substituteTeacher = new StringSelectMenuBuilder()
    .setCustomId('teacher_substitute_teacher')
    .setPlaceholder('Choose the saved substitute teacher')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1)
    .addOptions(teacherChoiceOptions(teachers));

  return new ModalBuilder()
    .setCustomId('campus_teacher_status')
    .setTitle('Teacher Status')
    .addLabelComponents(
      new LabelBuilder().setLabel('Which Teacher?').setStringSelectMenuComponent(teacherSelect),
      new LabelBuilder().setLabel('New Status').setStringSelectMenuComponent(statusSelect),
      new LabelBuilder()
        .setLabel('Substitute Setup')
        .setDescription('Pick No Substitute unless you are using Substitute Mode.')
        .setStringSelectMenuComponent(substituteMode),
      new LabelBuilder()
        .setLabel('Saved Substitute Teacher')
        .setDescription('Only choose one when Substitute Setup is “Use a saved teacher.”')
        .setStringSelectMenuComponent(substituteTeacher),
    );
}


function schoolAutomationModal(school) {
  const currentlyOn = school?.teacher_automation_enabled !== false;

  const switchSelect = new StringSelectMenuBuilder()
    .setCustomId('school_automation_enabled')
    .setPlaceholder('Turn all teacher automation on or off')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('ON — Allow Teacher Automation')
        .setDescription('Teachers use their individual automation settings.')
        .setValue('on')
        .setDefault(currentlyOn),
      new StringSelectMenuOptionBuilder()
        .setLabel('OFF — Pause All Teacher Automation')
        .setDescription('Master pause. Individual teacher settings are preserved.')
        .setValue('off')
        .setDefault(!currentlyOn),
    );

  return new ModalBuilder()
    .setCustomId('campus_school_automation')
    .setTitle('Teacher Automation — School')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Teacher Automation')
        .setDescription('This is the master switch for the entire school.')
        .setStringSelectMenuComponent(switchSelect)
    );
}

function teacherAutomationResetModal(teachers) {
  const targetSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_reset_target')
    .setPlaceholder('Choose a teacher or ALL TEACHERS')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('ALL TEACHERS')
        .setDescription('Apply this automation reset to every saved teacher.')
        .setValue('__all_teachers__'),
      ...teacherChoiceOptions(teachers.slice(0, 24)),
    );

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_reset_action')
    .setPlaceholder('How do you want to reset automation?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Redo Settings')
        .setDescription('Open the automation choices again and set them yourself.')
        .setValue('redo'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Restore Campus Defaults')
        .setDescription('Put automation back to the standard Campus settings.')
        .setValue('defaults'),
    );

  return new ModalBuilder()
    .setCustomId('campus_teacher_automation_reset')
    .setTitle('Reset Teacher Automation')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Teacher')
        .setDescription('Choose one teacher or everybody.')
        .setStringSelectMenuComponent(targetSelect),
      new LabelBuilder()
        .setLabel('Reset Option')
        .setDescription('Redo the settings yourself or restore Campus defaults.')
        .setStringSelectMenuComponent(actionSelect),
    );
}

function teacherAutomationRedoModal(scope) {
  const enabledSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_redo_enabled')
    .setPlaceholder('Turn automation on or off')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('On').setValue('on'),
      new StringSelectMenuOptionBuilder().setLabel('Off').setValue('off'),
    );

  const frequencySelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_redo_frequency')
    .setPlaceholder('Choose activity frequency')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Very Low').setValue('very_low'),
      new StringSelectMenuOptionBuilder().setLabel('Low').setValue('low'),
      new StringSelectMenuOptionBuilder().setLabel('Normal').setValue('normal'),
      new StringSelectMenuOptionBuilder().setLabel('High').setValue('high'),
      new StringSelectMenuOptionBuilder().setLabel('Very High').setValue('very_high'),
    );

  const featuresSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_redo_features')
    .setPlaceholder('Choose which behaviors are ON')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(3)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('React to messages').setValue('react'),
      new StringSelectMenuOptionBuilder().setLabel('Spontaneous messages').setValue('spontaneous'),
      new StringSelectMenuOptionBuilder().setLabel('Conversation awareness').setValue('conversation'),
    );

  const cooldownSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_redo_cooldown')
    .setPlaceholder('Minimum cooldown')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('No cooldown').setValue('0'),
      new StringSelectMenuOptionBuilder().setLabel('5 minutes').setValue('5'),
      new StringSelectMenuOptionBuilder().setLabel('10 minutes').setValue('10'),
      new StringSelectMenuOptionBuilder().setLabel('15 minutes').setValue('15'),
      new StringSelectMenuOptionBuilder().setLabel('30 minutes').setValue('30'),
      new StringSelectMenuOptionBuilder().setLabel('45 minutes').setValue('45'),
      new StringSelectMenuOptionBuilder().setLabel('1 hour').setValue('60'),
      new StringSelectMenuOptionBuilder().setLabel('2 hours').setValue('120'),
    );

  return new ModalBuilder()
    .setCustomId(`campus_teacher_automation_redo:${scope}`)
    .setTitle(scope === '__all_teachers__' ? 'Redo Automation — All Teachers' : 'Redo Teacher Automation')
    .addLabelComponents(
      new LabelBuilder().setLabel('Automation').setStringSelectMenuComponent(enabledSelect),
      new LabelBuilder().setLabel('Activity Frequency').setStringSelectMenuComponent(frequencySelect),
      new LabelBuilder()
        .setLabel('Teacher Behaviors')
        .setDescription('Select every behavior you want ON. Unselected behaviors will be OFF.')
        .setStringSelectMenuComponent(featuresSelect),
      new LabelBuilder().setLabel('Minimum Cooldown').setStringSelectMenuComponent(cooldownSelect),
    );
}

function teacherAutomationRedoButton(scope) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`campus_teacher_automation_redo_open:${scope}`)
      .setLabel(scope === '__all_teachers__' ? 'Redo Settings for All Teachers' : 'Redo Automation Settings')
      .setStyle(ButtonStyle.Primary)
  );
}

function teacherAutomationModal(teachers) {
  const teacherSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_target')
    .setPlaceholder('Choose a teacher')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(teacherChoiceOptions(teachers));

  const enabledSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_enabled')
    .setPlaceholder('Turn automation on or off')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('On').setValue('on'),
      new StringSelectMenuOptionBuilder().setLabel('Off').setValue('off'),
    );

  const frequencySelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_frequency')
    .setPlaceholder('Choose activity frequency')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Very Low').setValue('very_low'),
      new StringSelectMenuOptionBuilder().setLabel('Low').setValue('low'),
      new StringSelectMenuOptionBuilder().setLabel('Normal').setValue('normal'),
      new StringSelectMenuOptionBuilder().setLabel('High').setValue('high'),
      new StringSelectMenuOptionBuilder().setLabel('Very High').setValue('very_high'),
    );

  const featuresSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_features')
    .setPlaceholder('Choose which behaviors are ON')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(3)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('React to messages').setValue('react'),
      new StringSelectMenuOptionBuilder().setLabel('Spontaneous messages').setValue('spontaneous'),
      new StringSelectMenuOptionBuilder().setLabel('Conversation awareness').setValue('conversation'),
    );

  const cooldownSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_automation_cooldown')
    .setPlaceholder('Minimum cooldown')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('No cooldown').setValue('0'),
      new StringSelectMenuOptionBuilder().setLabel('5 minutes').setValue('5'),
      new StringSelectMenuOptionBuilder().setLabel('10 minutes').setValue('10'),
      new StringSelectMenuOptionBuilder().setLabel('15 minutes').setValue('15'),
      new StringSelectMenuOptionBuilder().setLabel('30 minutes').setValue('30'),
      new StringSelectMenuOptionBuilder().setLabel('45 minutes').setValue('45'),
      new StringSelectMenuOptionBuilder().setLabel('1 hour').setValue('60'),
      new StringSelectMenuOptionBuilder().setLabel('2 hours').setValue('120'),
    );

  return new ModalBuilder()
    .setCustomId('campus_teacher_automation')
    .setTitle('Teacher Automation')
    .addLabelComponents(
      new LabelBuilder().setLabel('Which Teacher?').setStringSelectMenuComponent(teacherSelect),
      new LabelBuilder().setLabel('Automation').setStringSelectMenuComponent(enabledSelect),
      new LabelBuilder().setLabel('Activity Frequency').setStringSelectMenuComponent(frequencySelect),
      new LabelBuilder()
        .setLabel('Teacher Behaviors')
        .setDescription('Select every behavior you want ON. Unselected behaviors will be OFF.')
        .setStringSelectMenuComponent(featuresSelect),
      new LabelBuilder().setLabel('Minimum Cooldown').setStringSelectMenuComponent(cooldownSelect),
    );
}


function teacherAbsenceSettingsButton(teacherId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`campus_teacher_absence_open:${teacherId}`)
      .setLabel('Absence & Substitute Settings')
      .setStyle(ButtonStyle.Secondary)
  );
}


function teacherRoamingSettingsButton(teacherId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`campus_teacher_roaming_open:${teacherId}`)
      .setLabel('Roaming & Common Areas')
      .setStyle(ButtonStyle.Primary)
  );
}

function teacherRoamingModal(teacher, settings) {
  const enabled = new StringSelectMenuBuilder()
    .setCustomId('teacher_roaming_enabled')
    .setPlaceholder('Turn roaming on or off')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('On').setValue('on').setDefault(Boolean(settings?.roaming_enabled)),
      new StringSelectMenuOptionBuilder().setLabel('Off').setValue('off').setDefault(!settings?.roaming_enabled),
    );

  const channels = new ChannelSelectMenuBuilder()
    .setCustomId('teacher_roaming_channels')
    .setPlaceholder('Choose every common-area channel this teacher can visit')
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(25)
    .setChannelTypes(
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread
    );

  const studentChat = new StringSelectMenuBuilder()
    .setCustomId('teacher_roaming_students')
    .setPlaceholder('Can this teacher talk with students there?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Yes — talk to students').setValue('on').setDefault(settings?.roaming_student_chat !== false),
      new StringSelectMenuOptionBuilder().setLabel('No — do not talk to students').setValue('off').setDefault(settings?.roaming_student_chat === false),
    );

  const teacherChat = new StringSelectMenuBuilder()
    .setCustomId('teacher_roaming_teachers')
    .setPlaceholder('Can this teacher chat with other Campus teachers?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Yes — teacher-to-teacher chatter').setValue('on').setDefault(settings?.roaming_teacher_chat !== false),
      new StringSelectMenuOptionBuilder().setLabel('No — no teacher-to-teacher chatter').setValue('off').setDefault(settings?.roaming_teacher_chat === false),
    );

  const currentFrequency = settings?.roaming_frequency || 'normal';
  const frequency = new StringSelectMenuBuilder()
    .setCustomId('teacher_roaming_frequency')
    .setPlaceholder('How often should this teacher show up in common areas?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Rare').setValue('rare').setDefault(currentFrequency === 'rare'),
      new StringSelectMenuOptionBuilder().setLabel('Normal').setValue('normal').setDefault(currentFrequency === 'normal'),
      new StringSelectMenuOptionBuilder().setLabel('Frequent').setValue('frequent').setDefault(currentFrequency === 'frequent'),
    );

  return new ModalBuilder()
    .setCustomId(`campus_teacher_roaming:${teacher.id}`)
    .setTitle('Roaming & Common Areas')
    .addLabelComponents(
      new LabelBuilder().setLabel('Common-Area Roaming').setStringSelectMenuComponent(enabled),
      new LabelBuilder()
        .setLabel('Allowed Common-Area Channels')
        .setDescription('Pick cafeteria, halls, library, courtyard, lounge, or any other text channels you want.')
        .setChannelSelectMenuComponent(channels),
      new LabelBuilder().setLabel('Talk With Students').setStringSelectMenuComponent(studentChat),
      new LabelBuilder().setLabel('Talk With Other Teachers').setStringSelectMenuComponent(teacherChat),
      new LabelBuilder().setLabel('Roaming Frequency').setStringSelectMenuComponent(frequency),
    );
}

async function openTeacherRoamingSettings(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_roaming_open:(.+)$/);
  if (!match) return;
  const teacherId = match[1];

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  const { data: settings, error: settingsError } = await supabase
    .from('teacher_settings')
    .select('*')
    .eq('teacher_id', teacher.id)
    .maybeSingle();
  if (settingsError) throw settingsError;

  return interaction.showModal(teacherRoamingModal(teacher, settings));
}

async function handleTeacherRoamingModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_roaming:(.+)$/);
  if (!match) return;
  const teacherId = match[1];

  const enabled = interaction.fields.getStringSelectValues('teacher_roaming_enabled')?.[0] === 'on';
  const studentChat = interaction.fields.getStringSelectValues('teacher_roaming_students')?.[0] === 'on';
  const teacherChat = interaction.fields.getStringSelectValues('teacher_roaming_teachers')?.[0] === 'on';
  const frequency = interaction.fields.getStringSelectValues('teacher_roaming_frequency')?.[0] || 'normal';
  const selectedChannels = interaction.fields.getSelectedChannels(
    'teacher_roaming_channels',
    false,
  );
  const channelIds = [...(selectedChannels?.values() ?? [])]
    .filter(isTeacherAssignableChannel)
    .map((channel) => String(channel.id));

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('id, teacher_name')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  if (enabled && channelIds.length === 0) {
    return respondInteraction(interaction, ephemeral('Choose at least one common-area channel before turning roaming ON.'));
  }

  const { error: updateError } = await supabase
    .from('teacher_settings')
    .update({
      roaming_enabled: enabled,
      roaming_channel_ids: channelIds,
      roaming_student_chat: studentChat,
      roaming_teacher_chat: teacherChat,
      roaming_frequency: frequency,
    })
    .eq('teacher_id', teacher.id);
  if (updateError) throw updateError;

  const channelText = channelIds.length
    ? channelIds.map((id) => `<#${id}>`).join(', ')
    : 'None selected';

  return respondInteraction(interaction, ephemeral(
    `✅ Roaming updated for **${teacher.teacher_name}**.\n`
    + `Common areas: ${enabled ? '**ON**' : '**OFF**'} • Frequency: **${frequency}**\n`
    + `Talk to students: **${studentChat ? 'Yes' : 'No'}** • Talk to teachers: **${teacherChat ? 'Yes' : 'No'}**\n`
    + `Channels: ${channelText}`
  ));
}

function teacherAbsenceModal(teacher, settings, teachers) {
  const enabled = new StringSelectMenuBuilder()
    .setCustomId('teacher_absence_enabled')
    .setPlaceholder('Turn random absences on or off')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('On').setValue('on').setDefault(Boolean(settings?.random_absences_enabled)),
      new StringSelectMenuOptionBuilder().setLabel('Off').setValue('off').setDefault(!settings?.random_absences_enabled),
    );

  const currentFrequency = settings?.absence_frequency || 'rare';
  const frequency = new StringSelectMenuBuilder()
    .setCustomId('teacher_absence_frequency')
    .setPlaceholder('How often can this teacher randomly be absent?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Rare').setDescription('About a 3% chance per school day').setValue('rare').setDefault(currentFrequency === 'rare'),
      new StringSelectMenuOptionBuilder().setLabel('Occasional').setDescription('About an 8% chance per school day').setValue('occasional').setDefault(currentFrequency === 'occasional'),
      new StringSelectMenuOptionBuilder().setLabel('Frequent').setDescription('About a 15% chance per school day').setValue('frequent').setDefault(currentFrequency === 'frequent'),
    );

  const currentCoverage = teacher.substitute_teacher_id
    ? 'saved'
    : teacher.use_generic_substitute
      ? 'generic'
      : 'notify';

  const coverage = new StringSelectMenuBuilder()
    .setCustomId('teacher_absence_coverage')
    .setPlaceholder('What should Campus do when they are absent?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Use a generic substitute').setValue('generic').setDefault(currentCoverage === 'generic'),
      new StringSelectMenuOptionBuilder().setLabel('Use a saved teacher').setValue('saved').setDefault(currentCoverage === 'saved'),
      new StringSelectMenuOptionBuilder().setLabel('Leave class waiting for admin coverage').setValue('notify').setDefault(currentCoverage === 'notify'),
    );

  const durationValue = String(Math.max(1, Math.min(3, Number(settings?.auto_absence_duration_school_days || 1))));
  const duration = new StringSelectMenuBuilder()
    .setCustomId('teacher_absence_duration')
    .setPlaceholder('How long should a random absence last?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('1 school day').setValue('1').setDefault(durationValue === '1'),
      new StringSelectMenuOptionBuilder().setLabel('2 school days').setValue('2').setDefault(durationValue === '2'),
      new StringSelectMenuOptionBuilder().setLabel('3 school days').setValue('3').setDefault(durationValue === '3'),
    );

  const modal = new ModalBuilder()
    .setCustomId(`campus_teacher_absence:${teacher.id}`)
    .setTitle('Absence & Substitute Settings')
    .addLabelComponents(
      new LabelBuilder().setLabel('Random Absences').setStringSelectMenuComponent(enabled),
      new LabelBuilder().setLabel('Absence Frequency').setStringSelectMenuComponent(frequency),
      new LabelBuilder().setLabel('When This Teacher Is Absent').setStringSelectMenuComponent(coverage),
      new LabelBuilder().setLabel('Random Absence Length').setStringSelectMenuComponent(duration),
    );

  const otherTeachers = teachers.filter((candidate) => String(candidate.id) !== String(teacher.id));
  if (otherTeachers.length) {
    const savedSub = new StringSelectMenuBuilder()
      .setCustomId('teacher_absence_saved_sub')
      .setPlaceholder('Choose the preferred saved substitute')
      .setRequired(false)
      .setMinValues(0)
      .setMaxValues(1)
      .addOptions(otherTeachers.map((candidate) => {
        const option = new StringSelectMenuOptionBuilder()
          .setLabel(String(candidate.teacher_name).slice(0, 100))
          .setValue(String(candidate.id));
        const detail = [candidate.subject, candidate.grade_level].filter(Boolean).join(' • ').slice(0, 100);
        if (detail) option.setDescription(detail);
        if (String(teacher.substitute_teacher_id || '') === String(candidate.id)) option.setDefault(true);
        return option;
      }));

    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Preferred Saved Substitute')
        .setDescription('Only choose this when “Use a saved teacher” is selected above.')
        .setStringSelectMenuComponent(savedSub)
    );
  }

  return modal;
}

async function openTeacherAbsenceSettings(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_absence_open:(.+)$/);
  if (!match) return;
  const teacherId = match[1];

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  const { data: settings, error: settingsError } = await supabase
    .from('teacher_settings')
    .select('*')
    .eq('teacher_id', teacher.id)
    .maybeSingle();
  if (settingsError) throw settingsError;

  const teachers = await getTeacherChoices(school.id);
  return interaction.showModal(teacherAbsenceModal(teacher, settings, teachers));
}

async function handleTeacherAbsenceModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_absence:(.+)$/);
  if (!match) return;
  const teacherId = match[1];

  const enabled = interaction.fields.getStringSelectValues('teacher_absence_enabled')?.[0] === 'on';
  const frequency = interaction.fields.getStringSelectValues('teacher_absence_frequency')?.[0] || 'rare';
  const coverage = interaction.fields.getStringSelectValues('teacher_absence_coverage')?.[0] || 'generic';
  const duration = Math.max(1, Math.min(3, Number(interaction.fields.getStringSelectValues('teacher_absence_duration')?.[0] || 1)));
  const savedSubValues = interaction.fields.fields.has('teacher_absence_saved_sub')
    ? interaction.fields.getStringSelectValues('teacher_absence_saved_sub')
    : [];
  const savedSubId = savedSubValues?.[0] || null;

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  if (coverage === 'saved' && !savedSubId) {
    return respondInteraction(interaction, ephemeral('Choose a teacher under **Preferred Saved Substitute**, or pick Generic Substitute instead.'));
  }
  if (savedSubId && String(savedSubId) === String(teacher.id)) {
    return respondInteraction(interaction, ephemeral('A teacher cannot substitute for themselves.'));
  }

  const settingsChanges = {
    random_absences_enabled: enabled,
    absence_frequency: frequency,
    auto_absence_duration_school_days: duration,
  };
  const { error: settingsError } = await supabase
    .from('teacher_settings')
    .update(settingsChanges)
    .eq('teacher_id', teacher.id);
  if (settingsError) throw settingsError;

  const teacherChanges = coverage === 'generic'
    ? { substitute_teacher_id: null, use_generic_substitute: true }
    : coverage === 'saved'
      ? { substitute_teacher_id: savedSubId, use_generic_substitute: false }
      : { substitute_teacher_id: null, use_generic_substitute: false };

  const { error: teacherError } = await supabase
    .from('teachers')
    .update(teacherChanges)
    .eq('id', teacher.id);
  if (teacherError) throw teacherError;

  const coverageLabel = coverage === 'generic'
    ? 'Generic substitute'
    : coverage === 'saved'
      ? 'Saved teacher substitute'
      : 'Wait for admin coverage';

  return respondInteraction(interaction, ephemeral(
    `✅ Random absence settings updated for **${teacher.teacher_name}**.\n`
    + `Random absences: **${enabled ? 'ON' : 'OFF'}** • Frequency: **${frequency}** • Length: **${duration} school day${duration === 1 ? '' : 's'}**\n`
    + `Coverage: **${coverageLabel}**`
  ));
}

async function handleTeacherEditPickerModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const teacherId = interaction.fields.getStringSelectValues('teacher_edit_target')?.[0];
  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  const identity = parseTeacherIdentityEdit(
    interaction.fields.getTextInputValue('teacher_edit_identity'),
    teacher,
  );
  const personalityRaw = interaction.fields.getTextInputValue('teacher_edit_personality').trim();
  const teachingStyleRaw = interaction.fields.getTextInputValue('teacher_edit_teaching_style').trim();
  const selectedChannels = interaction.fields.getSelectedChannels(
    'teacher_edit_channel',
    false,
  );
  const channel = selectedChannels?.first() ?? null;

  const changes = {
    ...identity,
    classroom_channel_id: isTeacherAssignableChannel(channel)
      ? channel.id
      : teacher.classroom_channel_id,
    personality: personalityRaw || teacher.personality,
    teaching_style: teachingStyleRaw || teacher.teaching_style,
  };

  const { error: updateError } = await supabase.from('teachers').update(changes).eq('id', teacher.id);
  if (updateError) throw updateError;

  await supabase.from('change_history').insert({
    school_id: school.id,
    entity_type: 'teacher',
    entity_id: String(teacher.id),
    action: 'edit',
    new_value: changes,
    changed_by_discord_user_id: interaction.user.id,
  });

  return respondInteraction(interaction, {
    content:
      `✅ **${changes.teacher_name}** was updated without erasing teacher memory.\n`
      + `🏫 Assigned channel: <#${changes.classroom_channel_id}>`,
    components: [personalDetailsButton(teacher.id, 'Edit Personal Details')],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTeacherStatusModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const teacherId = interaction.fields.getStringSelectValues('teacher_status_target')?.[0];
  const status = interaction.fields.getStringSelectValues('teacher_status_value')?.[0];
  const substituteMode = interaction.fields.getStringSelectValues('teacher_substitute_mode')?.[0] || 'none';
  const substituteId = interaction.fields.getStringSelectValues('teacher_substitute_teacher')?.[0] || null;

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  const changes = { status };

  if (status === 'substitute_mode') {
    changes.substitute_teacher_id = null;
    changes.use_generic_substitute = false;

    if (substituteMode === 'generic') {
      changes.use_generic_substitute = true;
    } else if (substituteMode === 'saved') {
      if (!substituteId) {
        return respondInteraction(interaction, ephemeral('Choose a saved substitute teacher in the last dropdown.'));
      }
      if (String(substituteId) === String(teacher.id)) {
        return respondInteraction(interaction, ephemeral('A teacher cannot substitute for themselves.'));
      }
      changes.substitute_teacher_id = substituteId;
    }
  }

  const { error: updateError } = await supabase.from('teachers').update(changes).eq('id', teacher.id);
  if (updateError) throw updateError;

  return respondInteraction(interaction, ephemeral(
    `✅ **${teacher.teacher_name}** is now **${status.replaceAll('_', ' ')}**.`
  ));
}


async function handleSchoolAutomation(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;
  return interaction.showModal(schoolAutomationModal(school));
}

async function handleSchoolAutomationModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const enabled = interaction.fields.getStringSelectValues('school_automation_enabled')?.[0] === 'on';

  const { error } = await supabase
    .from('schools')
    .update({ teacher_automation_enabled: enabled })
    .eq('id', school.id);
  if (error) throw error;

  return respondInteraction(interaction, ephemeral(
    enabled
      ? '🤖 **Teacher Automation is ON for the whole school.** Individual teacher settings are active again.'
      : '⏸️ **Teacher Automation is OFF for the whole school.** Teacher settings were preserved and will work again when you turn the master switch back on.'
  ));
}

async function getTeacherIdsForAutomationScope(schoolId, scope) {
  if (scope !== '__all_teachers__') return [scope];

  const { data, error } = await supabase
    .from('teachers')
    .select('id')
    .eq('school_id', schoolId);
  if (error) throw error;
  return (data ?? []).map((row) => String(row.id));
}

async function applyAutomationDefaults(teacherIds) {
  if (!teacherIds.length) return;

  const coreDefaults = {
    automation_enabled: true,
    respond_to_students: true,
    react_to_messages: true,
    spontaneous_messages: true,
    conversation_awareness: true,
    assignment_acknowledgement: true,
    start_conversations: true,
    activity_frequency: 'normal',
    minimum_cooldown_minutes: 30,
    max_spontaneous_messages_per_hour: 2,
    reaction_chance_percent: 25,
    conversation_start_chance_percent: 10,
    obey_school_quiet_hours: true,
  };

  const { error: coreError } = await supabase
    .from('teacher_settings')
    .update(coreDefaults)
    .in('teacher_id', teacherIds);
  if (coreError) throw coreError;

  // These are the newer roaming / absence settings. If an older database
  // does not have them yet, the core reset above still succeeds.
  const extrasDefaults = {
    random_absences_enabled: false,
    absence_frequency: 'rare',
    auto_absence_duration_school_days: 1,
    last_absence_check_date: null,
    roaming_enabled: false,
    roaming_channel_ids: [],
    roaming_student_chat: true,
    roaming_teacher_chat: true,
    roaming_frequency: 'normal',
  };

  const { error: extrasError } = await supabase
    .from('teacher_settings')
    .update(extrasDefaults)
    .in('teacher_id', teacherIds);

  if (extrasError) {
    console.warn('Teacher automation extras were not reset:', extrasError.message);
  }
}

async function handleTeacherAutomationResetModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const scope = interaction.fields.getStringSelectValues('teacher_automation_reset_target')?.[0];
  const action = interaction.fields.getStringSelectValues('teacher_automation_reset_action')?.[0];
  if (!scope || !action) {
    return respondInteraction(interaction, ephemeral('Choose a teacher and a reset option.'));
  }

  const teacherIds = await getTeacherIdsForAutomationScope(school.id, scope);
  if (!teacherIds.length) {
    return respondInteraction(interaction, ephemeral('I could not find any teachers for that reset.'));
  }

  if (action === 'redo') {
    return respondInteraction(interaction, {
      content:
        scope === '__all_teachers__'
          ? '✏️ **Redo Automation Settings — ALL TEACHERS**\nClick below and the settings you choose will be applied to every teacher.'
          : '✏️ **Redo Automation Settings**\nClick below to choose the automation settings again.',
      components: [teacherAutomationRedoButton(scope)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'defaults') {
    await applyAutomationDefaults(teacherIds);

    const label = scope === '__all_teachers__'
      ? `**ALL TEACHERS (${teacherIds.length})**`
      : '**the selected teacher**';

    return respondInteraction(interaction, ephemeral(
      `♻️ Automation for ${label} was restored to **Campus defaults**.\n`
      + 'Normal frequency • 30-minute cooldown • student responses/reactions/conversation enabled • roaming OFF • random absences OFF.'
    ));
  }

  return respondInteraction(interaction, ephemeral('Unknown automation reset option.'));
}

async function openTeacherAutomationRedo(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_automation_redo_open:(.+)$/);
  if (!match) return;

  const scope = match[1];
  const teacherIds = await getTeacherIdsForAutomationScope(school.id, scope);
  if (!teacherIds.length) {
    return respondInteraction(interaction, ephemeral('I could not find any teachers for that automation setup.'));
  }

  return interaction.showModal(teacherAutomationRedoModal(scope));
}

async function handleTeacherAutomationRedoModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const match = interaction.customId.match(/^campus_teacher_automation_redo:(.+)$/);
  if (!match) return;
  const scope = match[1];

  const teacherIds = await getTeacherIdsForAutomationScope(school.id, scope);
  if (!teacherIds.length) {
    return respondInteraction(interaction, ephemeral('I could not find any teachers for that automation setup.'));
  }

  const enabled = interaction.fields.getStringSelectValues('teacher_automation_redo_enabled')?.[0] === 'on';
  const frequency = interaction.fields.getStringSelectValues('teacher_automation_redo_frequency')?.[0];
  const features = new Set(interaction.fields.getStringSelectValues('teacher_automation_redo_features') ?? []);
  const cooldown = Number(interaction.fields.getStringSelectValues('teacher_automation_redo_cooldown')?.[0]);

  const changes = {
    automation_enabled: enabled,
    activity_frequency: frequency,
    minimum_cooldown_minutes: cooldown,
    react_to_messages: features.has('react'),
    spontaneous_messages: features.has('spontaneous'),
    conversation_awareness: features.has('conversation'),
  };

  const { error } = await supabase
    .from('teacher_settings')
    .update(changes)
    .in('teacher_id', teacherIds);
  if (error) throw error;

  if (scope === '__all_teachers__') {
    return respondInteraction(interaction, ephemeral(
      `✅ Automation was redone for **ALL TEACHERS (${teacherIds.length})**.\n`
      + `Automation: **${enabled ? 'ON' : 'OFF'}** • Frequency: **${frequency.replaceAll('_', ' ')}** • Cooldown: **${cooldown} min**`
    ));
  }

  return respondInteraction(interaction, {
    content:
      `✅ Automation was redone for the selected teacher.\n`
      + `Automation: **${enabled ? 'ON' : 'OFF'}** • Frequency: **${frequency.replaceAll('_', ' ')}** • Cooldown: **${cooldown} min**\n\n`
      + 'You can still customize their roaming/common areas and automatic absence settings below.',
    components: [teacherRoamingSettingsButton(scope), teacherAbsenceSettingsButton(scope)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTeacherAutomationModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const teacherId = interaction.fields.getStringSelectValues('teacher_automation_target')?.[0];
  const enabled = interaction.fields.getStringSelectValues('teacher_automation_enabled')?.[0] === 'on';
  const frequency = interaction.fields.getStringSelectValues('teacher_automation_frequency')?.[0];
  const features = new Set(interaction.fields.getStringSelectValues('teacher_automation_features') ?? []);
  const cooldown = Number(interaction.fields.getStringSelectValues('teacher_automation_cooldown')?.[0]);

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('id, teacher_name')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  const changes = {
    automation_enabled: enabled,
    activity_frequency: frequency,
    minimum_cooldown_minutes: cooldown,
    react_to_messages: features.has('react'),
    spontaneous_messages: features.has('spontaneous'),
    conversation_awareness: features.has('conversation'),
  };

  const { error: updateError } = await supabase.from('teacher_settings').update(changes).eq('teacher_id', teacher.id);
  if (updateError) throw updateError;

  return respondInteraction(interaction, {
    content:
      `✅ Automation updated for **${teacher.teacher_name}**.\n`
      + `Automation: **${enabled ? 'ON' : 'OFF'}** • Frequency: **${frequency.replaceAll('_', ' ')}** • Cooldown: **${cooldown} min**\n\n`
      + 'Use **Roaming & Common Areas** to choose cafeteria/hall/library channels, or **Absence & Substitute Settings** for automatic call-outs.',
    components: [teacherRoamingSettingsButton(teacher.id), teacherAbsenceSettingsButton(teacher.id)],
    flags: MessageFlags.Ephemeral,
  });
}

function teacherRemoveModal(teachers) {
  const teacherSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_remove_target')
    .setPlaceholder('Choose a teacher')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(teacherChoiceOptions(teachers));

  const actionSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_remove_action')
    .setPlaceholder('Choose what remove means')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Archive / deactivate')
        .setDescription('Keeps the profile and memory. You can reactivate them later.')
        .setValue('archive'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Permanently delete')
        .setDescription('Deletes the teacher profile. This cannot be undone.')
        .setValue('delete'),
    );

  const confirmSelect = new StringSelectMenuBuilder()
    .setCustomId('teacher_remove_confirm')
    .setPlaceholder('Confirm your choice')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Yes, continue').setValue('yes'),
      new StringSelectMenuOptionBuilder().setLabel('No, cancel').setValue('no'),
    );

  return new ModalBuilder()
    .setCustomId('campus_teacher_remove')
    .setTitle('Remove Teacher')
    .addLabelComponents(
      new LabelBuilder().setLabel('Which Teacher?').setStringSelectMenuComponent(teacherSelect),
      new LabelBuilder().setLabel('Remove Option').setStringSelectMenuComponent(actionSelect),
      new LabelBuilder().setLabel('Are You Sure?').setStringSelectMenuComponent(confirmSelect),
    );
}

async function handleTeacherRemoveModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const teacherId = interaction.fields.getStringSelectValues('teacher_remove_target')?.[0];
  const action = interaction.fields.getStringSelectValues('teacher_remove_action')?.[0];
  const confirmed = interaction.fields.getStringSelectValues('teacher_remove_confirm')?.[0] === 'yes';

  if (!confirmed) return respondInteraction(interaction, ephemeral('Teacher removal canceled.'));

  const { data: teacher, error } = await supabase
    .from('teachers')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', teacherId)
    .maybeSingle();
  if (error) throw error;
  if (!teacher) return respondInteraction(interaction, ephemeral('I could not find that teacher anymore.'));

  if (action === 'archive') {
    const { error: teacherError } = await supabase.from('teachers')
      .update({ status: 'paused' })
      .eq('id', teacher.id);
    if (teacherError) throw teacherError;

    const { error: settingsError } = await supabase.from('teacher_settings')
      .update({ automation_enabled: false })
      .eq('teacher_id', teacher.id);
    if (settingsError) throw settingsError;

    await supabase.from('change_history').insert({
      school_id: school.id,
      entity_type: 'teacher',
      entity_id: String(teacher.id),
      action: 'archive',
      new_value: { status: 'paused', automation_enabled: false },
      changed_by_discord_user_id: interaction.user.id,
    });

    return respondInteraction(interaction, ephemeral(
      `📦 **${teacher.teacher_name}** was archived. Their profile and memory are still saved.\n`
      + 'Use `/teacher status` and set them back to **Active** if you want to restore them.'
    ));
  }

  // Clean up references first so a permanent delete is less likely to hit a foreign-key conflict.
  await supabase.from('teachers')
    .update({ substitute_teacher_id: null, use_generic_substitute: false })
    .eq('school_id', school.id)
    .eq('substitute_teacher_id', teacher.id);
  await supabase.from('teacher_memory').delete().eq('teacher_id', teacher.id);
  await supabase.from('teacher_settings').delete().eq('teacher_id', teacher.id);

  const { error: deleteError } = await supabase.from('teachers')
    .delete()
    .eq('school_id', school.id)
    .eq('id', teacher.id);
  if (deleteError) throw deleteError;

  await supabase.from('change_history').insert({
    school_id: school.id,
    entity_type: 'teacher',
    entity_id: String(teacher.id),
    action: 'delete',
    old_value: { teacher_name: teacher.teacher_name, subject: teacher.subject, grade_level: teacher.grade_level },
    changed_by_discord_user_id: interaction.user.id,
  });

  return respondInteraction(interaction, ephemeral(`🗑️ **${teacher.teacher_name}** was permanently removed from Campus.`));
}

function finalsOnModal(quarters) {
  const quarterSelect = new StringSelectMenuBuilder()
    .setCustomId('finals_quarter')
    .setPlaceholder('Choose the quarter')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(quarters.map((q) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`Quarter ${q.quarter_number}`)
        .setDescription(`${q.start_date} through ${q.end_date}`.slice(0, 100))
        .setValue(String(q.id))
    ));

  const startDate = new TextInputBuilder()
    .setCustomId('finals_start_date')
    .setPlaceholder('Optional: 2026-12-14')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(10);

  const endDate = new TextInputBuilder()
    .setCustomId('finals_end_date')
    .setPlaceholder('Optional: 2026-12-18')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(10);

  return new ModalBuilder()
    .setCustomId('campus_finals_on')
    .setTitle('Turn Finals Mode On')
    .addLabelComponents(
      new LabelBuilder().setLabel('Which Quarter?').setStringSelectMenuComponent(quarterSelect),
      new LabelBuilder()
        .setLabel('Finals Start Date')
        .setDescription('Optional. Leave blank if you do not want a date limit.')
        .setTextInputComponent(startDate),
      new LabelBuilder()
        .setLabel('Finals End Date')
        .setDescription('Optional. Leave blank if you do not want a date limit.')
        .setTextInputComponent(endDate),
    );
}

async function handleFinalsOnModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const quarterId = interaction.fields.getStringSelectValues('finals_quarter')?.[0];
  const start = interaction.fields.getTextInputValue('finals_start_date').trim() || null;
  const end = interaction.fields.getTextInputValue('finals_end_date').trim() || null;

  if ((start && !validDate(start)) || (end && !validDate(end)) || (start && end && end < start)) {
    return respondInteraction(interaction, ephemeral('Finals dates must use `YYYY-MM-DD`, and the end date cannot be before the start date.'));
  }

  const { data: q, error } = await supabase
    .from('quarters')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', quarterId)
    .maybeSingle();
  if (error) throw error;
  if (!q) return respondInteraction(interaction, ephemeral('That quarter is not configured anymore.'));

  const { error: upsertError } = await supabase.from('finals_settings').upsert({
    school_id: school.id,
    finals_enabled: true,
    active_quarter_id: q.id,
    start_date: start,
    end_date: end,
    one_final_per_school_day: true,
    counts_toward_grade: true,
  }, { onConflict: 'school_id' });
  if (upsertError) throw upsertError;

  return respondInteraction(interaction, ephemeral(
    `🎓 Finals Mode is **ON** for **Quarter ${q.quarter_number}**. One final can count each school day.`
  ));
}

function disciplineAddModal() {
  const name = new TextInputBuilder()
    .setCustomId('discipline_name')
    .setPlaceholder('Maya Bennett')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const type = new StringSelectMenuBuilder()
    .setCustomId('discipline_type')
    .setPlaceholder('Choose discipline type')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('Detention').setValue('detention'),
      new StringSelectMenuOptionBuilder().setLabel('ISS').setValue('iss'),
      new StringSelectMenuOptionBuilder().setLabel('Suspension').setValue('suspension'),
    );

  const duration = new StringSelectMenuBuilder()
    .setCustomId('discipline_duration')
    .setPlaceholder('Choose duration')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('15 minutes').setValue('15|minutes'),
      new StringSelectMenuOptionBuilder().setLabel('30 minutes').setValue('30|minutes'),
      new StringSelectMenuOptionBuilder().setLabel('45 minutes').setValue('45|minutes'),
      new StringSelectMenuOptionBuilder().setLabel('1 hour').setValue('1|hours'),
      new StringSelectMenuOptionBuilder().setLabel('2 hours').setValue('2|hours'),
      new StringSelectMenuOptionBuilder().setLabel('3 hours').setValue('3|hours'),
      new StringSelectMenuOptionBuilder().setLabel('1 day').setValue('1|days'),
      new StringSelectMenuOptionBuilder().setLabel('2 days').setValue('2|days'),
      new StringSelectMenuOptionBuilder().setLabel('3 days').setValue('3|days'),
      new StringSelectMenuOptionBuilder().setLabel('5 days').setValue('5|days'),
      new StringSelectMenuOptionBuilder().setLabel('7 days').setValue('7|days'),
    );

  const reason = new TextInputBuilder()
    .setCustomId('discipline_reason')
    .setPlaceholder('Optional reason for the discipline action')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500);

  const location = new ChannelSelectMenuBuilder()
    .setCustomId('discipline_location')
    .setPlaceholder('Optional: choose any text channel')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setRequired(false)
    .setMinValues(0)
    .setMaxValues(1);

  return new ModalBuilder()
    .setCustomId('campus_discipline_add')
    .setTitle('Add Discipline')
    .addLabelComponents(
      new LabelBuilder().setLabel('Character Name').setTextInputComponent(name),
      new LabelBuilder().setLabel('Discipline Type').setStringSelectMenuComponent(type),
      new LabelBuilder().setLabel('How Long?').setStringSelectMenuComponent(duration),
      new LabelBuilder().setLabel('Reason').setTextInputComponent(reason),
      new LabelBuilder().setLabel('Discipline Channel').setChannelSelectMenuComponent(location),
    );
}

async function handleDisciplineAddModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const name = interaction.fields.getTextInputValue('discipline_name').trim();
  const type = interaction.fields.getStringSelectValues('discipline_type')?.[0];
  const durationValue = interaction.fields.getStringSelectValues('discipline_duration')?.[0] || '';
  const [durationRaw, unit] = durationValue.split('|');
  const duration = Number(durationRaw);
  const reason = interaction.fields.getTextInputValue('discipline_reason').trim() || null;
  const selectedChannels = interaction.fields.getSelectedChannels(
    'discipline_location',
    false,
    [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  );
  const location = selectedChannels.first();

  if (!['detention', 'iss', 'suspension'].includes(type) || !Number.isInteger(duration) || duration < 1 || !['minutes', 'hours', 'days'].includes(unit)) {
    return respondInteraction(interaction, ephemeral('Choose a valid discipline type and duration.'));
  }

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

  return respondInteraction(interaction, ephemeral(
    `✅ **${name}** received **${type.toUpperCase()}** for **${duration} ${unit}**.\n`
    + `${location ? `📍 <#${location.id}>\n` : ''}`
    + `Ends: <t:${Math.floor(ends.getTime() / 1000)}:F>`
  ));
}

function calendarAddModal() {
  const name = new TextInputBuilder()
    .setCustomId('calendar_name')
    .setPlaceholder('Fall Spirit Week')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(120);

  const type = new StringSelectMenuBuilder()
    .setCustomId('calendar_type')
    .setPlaceholder('Choose event type')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('First Day of School').setValue('first_day'),
      new StringSelectMenuOptionBuilder().setLabel('Picture Day').setValue('picture_day'),
      new StringSelectMenuOptionBuilder().setLabel('Spirit Week').setValue('spirit_week'),
      new StringSelectMenuOptionBuilder().setLabel('Holiday / Break').setValue('break'),
      new StringSelectMenuOptionBuilder().setLabel('Exam / Testing').setValue('exam'),
      new StringSelectMenuOptionBuilder().setLabel('Field Trip').setValue('field_trip'),
      new StringSelectMenuOptionBuilder().setLabel('Assembly / School Event').setValue('assembly'),
      new StringSelectMenuOptionBuilder().setLabel('Last Day of School').setValue('last_day'),
      new StringSelectMenuOptionBuilder().setLabel('Other').setValue('other'),
    );

  const dates = new TextInputBuilder()
    .setCustomId('calendar_dates')
    .setPlaceholder('2026-10-12  OR  2026-10-12 to 2026-10-16')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(35);

  const closed = new StringSelectMenuBuilder()
    .setCustomId('calendar_closed')
    .setPlaceholder('Is school closed?')
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('No — School is open').setValue('no'),
      new StringSelectMenuOptionBuilder().setLabel('Yes — School is closed').setValue('yes'),
    );

  const description = new TextInputBuilder()
    .setCustomId('calendar_description')
    .setPlaceholder('Optional details about the event')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  return new ModalBuilder()
    .setCustomId('campus_calendar_add')
    .setTitle('Add School Calendar Event')
    .addLabelComponents(
      new LabelBuilder().setLabel('Event Name').setTextInputComponent(name),
      new LabelBuilder().setLabel('Event Type').setStringSelectMenuComponent(type),
      new LabelBuilder()
        .setLabel('Date or Date Range')
        .setDescription('Use YYYY-MM-DD, or two dates for a multi-day event.')
        .setTextInputComponent(dates),
      new LabelBuilder().setLabel('Is School Closed?').setStringSelectMenuComponent(closed),
      new LabelBuilder().setLabel('Description').setTextInputComponent(description),
    );
}

async function handleCalendarAddModal(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const name = interaction.fields.getTextInputValue('calendar_name').trim();
  const type = interaction.fields.getStringSelectValues('calendar_type')?.[0];
  const rawDates = interaction.fields.getTextInputValue('calendar_dates').trim();
  const closed = interaction.fields.getStringSelectValues('calendar_closed')?.[0] === 'yes';
  const description = interaction.fields.getTextInputValue('calendar_description').trim() || null;

  const dateMatches = rawDates.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const start = dateMatches[0] || null;
  const end = dateMatches[1] || null;

  if (!start || !validDate(start) || (end && !validDate(end)) || (end && end < start)) {
    return respondInteraction(interaction, ephemeral(
      'Use a valid date like `2026-10-12`, or a range like `2026-10-12 to 2026-10-16`.'
    ));
  }

  const { error } = await supabase.from('school_calendar').insert({
    school_id: school.id,
    event_name: name,
    event_type: type,
    start_date: start,
    end_date: end,
    school_closed: closed,
    description,
  });
  if (error) throw error;

  return respondInteraction(interaction, ephemeral(
    `✅ Added **${name}** to the school calendar${end ? ` from **${start}** through **${end}**` : ` on **${start}**`}.`
  ));
}


async function handleTeacherList(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const { data: teachers, error } = await supabase
    .from('teachers')
    .select('id, teacher_name, subject, grade_level, classroom_channel_id, status')
    .eq('school_id', school.id)
    .order('teacher_name');

  if (error) throw error;

  if (!teachers?.length) {
    return respondInteraction(interaction, ephemeral('No teachers are saved for this Discord yet. Use `/teacher create` first.'));
  }

  const statusLabel = (status) => ({
    active: 'Active',
    reactive_only: 'Reactive Only',
    away: 'Away',
    substitute_mode: 'Substitute Mode',
    paused: 'Paused / Archived',
  }[status] ?? String(status ?? 'Unknown').replaceAll('_', ' '));

  const lines = teachers.map((teacher, index) => {
    const course = [teacher.grade_level, teacher.subject].filter(Boolean).join(' ') || 'No subject/grade listed';
    const classChannel = teacher.classroom_channel_id
      ? `<#${teacher.classroom_channel_id}>`
      : '**No channel assigned**';

    return `**${index + 1}. ${teacher.teacher_name}** — ${course}\n`
      + `↳ Class/Channel: ${classChannel} • Status: **${statusLabel(teacher.status)}**`;
  });

  // Keep each Discord message comfortably under the 2,000 character limit.
  const chunks = [];
  let current = `👩‍🏫 **${school.school_name ?? 'Campus'} — Teacher List**\n`
    + `**${teachers.length} teacher${teachers.length === 1 ? '' : 's'} saved**\n\n`;

  for (const line of lines) {
    if ((current + line + '\n\n').length > 1850) {
      chunks.push(current.trimEnd());
      current = `👩‍🏫 **Teacher List — Continued**\n\n${line}\n\n`;
    } else {
      current += `${line}\n\n`;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());

  await respondInteraction(interaction, ephemeral(chunks[0]));
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp(ephemeral(chunk));
  }
}

async function handleTeacher(interaction) {
  const sub = interaction.options.getSubcommand();
  const school = await requireSchool(interaction);
  if (!school) return;

  if (sub === 'create') {
    const modal = await teacherModal(school, 'campus_teacher_create', 'Create Teacher');
    return interaction.showModal(modal);
  }

  if (sub === 'list') {
    return handleTeacherList(interaction);
  }

  const teachers = await getTeacherChoices(school.id);
  if (!teachers.length) {
    return respondInteraction(interaction, ephemeral('No teachers are saved yet. Use `/teacher create` first.'));
  }

  if (sub === 'edit') {
    return interaction.showModal(teacherEditModal(teachers));
  }

  if (sub === 'status') {
    return interaction.showModal(teacherStatusModal(teachers));
  }

  if (sub === 'automation') {
    return interaction.showModal(teacherAutomationModal(teachers));
  }

  if (sub === 'automation-reset') {
    return interaction.showModal(teacherAutomationResetModal(teachers));
  }

  if (sub === 'remove') {
    return interaction.showModal(teacherRemoveModal(teachers));
  }
}

async function handleFinals(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'on') {
    const { data: quarters, error } = await supabase
      .from('quarters')
      .select('id, quarter_number, start_date, end_date')
      .eq('school_id', school.id)
      .order('quarter_number');
    if (error) throw error;

    if (!quarters?.length) {
      return respondInteraction(interaction, ephemeral('Set up at least one quarter first with `/quarter setup`.'));
    }

    return interaction.showModal(finalsOnModal(quarters));
  }

  if (sub === 'off') {
    const { error } = await supabase.from('finals_settings')
      .upsert({ school_id: school.id, finals_enabled: false }, { onConflict: 'school_id' });
    if (error) throw error;
    return respondInteraction(interaction, ephemeral('✅ Finals Mode is **OFF**. Previously completed finals stay saved.'));
  }

  const { data, error } = await supabase.from('finals_settings')
    .select('*, quarters(quarter_number)')
    .eq('school_id', school.id)
    .maybeSingle();
  if (error) throw error;

  return respondInteraction(interaction, ephemeral(
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
    return interaction.showModal(disciplineAddModal());
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
    return respondInteraction(interaction, ephemeral(`✅ Active discipline restrictions for **${name}** were ended.`));
  }

  const { data, error } = await supabase.from('active_discipline')
    .select('*')
    .eq('school_id', school.id)
    .eq('student_name_normalized', normalized)
    .order('ends_at', { ascending: false });
  if (error) throw error;

  if (!data?.length) return respondInteraction(interaction, ephemeral(`✅ **${name}** has no active discipline restriction.`));

  const lines = data.map((d) =>
    `• **${d.discipline_type.toUpperCase()}**${d.reason ? ` — ${d.reason}` : ''}${d.ends_at ? ` — ends <t:${Math.floor(new Date(d.ends_at).getTime() / 1000)}:R>` : ''}`
  );

  return respondInteraction(interaction, ephemeral(`**${name} — Discipline Status**\n${lines.join('\n')}`));
}

async function handleCalendar(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'add') {
    return interaction.showModal(calendarAddModal());
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

  return respondInteraction(interaction, ephemeral(`📅 **Upcoming School Events**\n${lines.join('\n')}`));
}

function campusCommandCenterPayload() {
  const select = new StringSelectMenuBuilder()
    .setCustomId('campus_command_center')
    .setPlaceholder('Choose what you want to manage')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel('🏫 School Setup').setValue('school_setup'),
      new StringSelectMenuOptionBuilder().setLabel('📚 Quarter Setup').setValue('quarter_setup'),
      new StringSelectMenuOptionBuilder().setLabel('🗂️ Route Setup').setValue('routes_setup'),
      new StringSelectMenuOptionBuilder().setLabel('👩‍🏫 Create Teacher').setValue('teacher_create'),
      new StringSelectMenuOptionBuilder().setLabel('📋 View Teacher List').setValue('teacher_list'),
      new StringSelectMenuOptionBuilder().setLabel('✏️ Edit Teacher').setValue('teacher_edit'),
      new StringSelectMenuOptionBuilder().setLabel('🟢 Teacher Status').setValue('teacher_status'),
      new StringSelectMenuOptionBuilder().setLabel('🤖 Teacher Automation').setValue('teacher_automation'),
      new StringSelectMenuOptionBuilder().setLabel('⏯️ Automation On / Off').setValue('automation_master'),
      new StringSelectMenuOptionBuilder().setLabel('♻️ Reset Teacher Automation').setValue('teacher_automation_reset'),
      new StringSelectMenuOptionBuilder().setLabel('🗑️ Remove Teacher').setValue('teacher_remove'),
      new StringSelectMenuOptionBuilder().setLabel('🎓 Turn Finals On').setValue('finals_on'),
      new StringSelectMenuOptionBuilder().setLabel('🚨 Add Discipline').setValue('discipline_add'),
      new StringSelectMenuOptionBuilder().setLabel('📅 Add Calendar Event').setValue('calendar_add'),
      new StringSelectMenuOptionBuilder().setLabel('📝 Activity Menu').setValue('activity_menu'),
      new StringSelectMenuOptionBuilder().setLabel('📊 View All Grades').setValue('grade_all'),
      new StringSelectMenuOptionBuilder().setLabel('♻️ Reset Grades').setValue('grade_reset'),
      new StringSelectMenuOptionBuilder().setLabel('❓ Command Guide').setValue('guide'),
    );

  return {
    content: '🏫 **Campus Command Center**\nChoose what you want to open.',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  };
}

async function handleMenu(interaction) {
  return respondInteraction(interaction, campusCommandCenterPayload());
}

async function handleCampusCommandCenter(interaction) {
  const choice = interaction.values[0];

  if (choice === 'school_setup') {
    const school = await getSchool(interaction.guildId);
    return interaction.showModal(campusSetupModal(school));
  }

  if (choice === 'guide') {
    return respondInteraction(interaction, ephemeral(
      '**Campus Command Guide**\n'
      + '`/campus setup` — school registration\n'
      + '`/quarter setup` — quarter dates and action requirement\n'
      + '`/routes setup` — add one or more Discord categories\n'
      + '`/teacher create` — create teacher + personal profile\n'
      + '`/teacher list` — view all teachers, classes/channels, and statuses\n'
      + '`/teacher edit` — edit teacher\n'
      + '`/teacher status` — active, away, substitute, paused\n'
      + '`/automation` — master ON/OFF switch for all teacher automation\n'
      + '`/teacher automation` — AI behavior + roaming/common areas + random absence/substitute settings\n'
      + '`/teacher automation-reset` — redo settings or restore Campus defaults\n'
      + '`/teacher remove` — archive or delete a teacher\n'
      + '`/finals on|off|status` — Finals Mode\n'
      + '`/discipline add|remove|check` — discipline\n'
      + '`/calendar add|list` — school calendar\n'
      + '`/activity` — log student activity\n'
      + '`/progress name:` — one student’s progress\n'
      + '`/grade student name:` — one student’s grades\n'
      + '`/grade all` — the full Campus gradebook\n'
      + '`/grade reset` — reset one student or all students'
    ));
  }

  if (choice === 'activity_menu') {
    return buildActivityMenu(interaction);
  }

  if (choice === 'grade_all') {
    return handleGradeAll(interaction);
  }

  if (choice === 'grade_reset') {
    return openGradeResetModal(interaction);
  }

  const school = await requireSchool(interaction);
  if (!school) return;

  if (choice === 'automation_master') return interaction.showModal(schoolAutomationModal(school));
  if (choice === 'quarter_setup') return interaction.showModal(quarterSetupModal());
  if (choice === 'routes_setup') return interaction.showModal(routesSetupModal());
  if (choice === 'discipline_add') return interaction.showModal(disciplineAddModal());
  if (choice === 'calendar_add') return interaction.showModal(calendarAddModal());

  if (choice === 'finals_on') {
    const { data: quarters, error } = await supabase
      .from('quarters')
      .select('id, quarter_number, start_date, end_date')
      .eq('school_id', school.id)
      .order('quarter_number');
    if (error) throw error;
    if (!quarters?.length) {
      return respondInteraction(interaction, ephemeral('Set up at least one quarter first with `/quarter setup`.'));
    }
    return interaction.showModal(finalsOnModal(quarters));
  }

  if (choice === 'teacher_create') {
    return interaction.showModal(await teacherModal(school, 'campus_teacher_create', 'Create Teacher'));
  }

  if (choice === 'teacher_list') {
    return handleTeacherList(interaction);
  }

  const teachers = await getTeacherChoices(school.id);
  if (!teachers.length) {
    return respondInteraction(interaction, ephemeral('No teachers are saved yet. Use `/teacher create` first.'));
  }

  if (choice === 'teacher_edit') return interaction.showModal(teacherEditModal(teachers));
  if (choice === 'teacher_status') return interaction.showModal(teacherStatusModal(teachers));
  if (choice === 'teacher_automation') return interaction.showModal(teacherAutomationModal(teachers));
  if (choice === 'teacher_automation_reset') return interaction.showModal(teacherAutomationResetModal(teachers));
  if (choice === 'teacher_remove') return interaction.showModal(teacherRemoveModal(teachers));

  return respondInteraction(interaction, ephemeral('That Campus menu option is not available yet.'));
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

  return respondInteraction(interaction, {
    content: '🏫 **School Activity**\nChoose what your character is doing.',
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
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
  if (!school) return respondInteraction(interaction, ephemeral('Campus is not set up yet.'));

  const studentName = interaction.fields.getTextInputValue('student_name').trim();
  const normalized = normalizeName(studentName);
  const activityDate = interaction.fields.getTextInputValue('activity_date').trim();
  const assignmentName = interaction.fields.getTextInputValue('assignment_name').trim() || null;
  const details = interaction.fields.getTextInputValue('details').trim() || null;

  if (!studentName || !validDate(activityDate)) {
    return respondInteraction(interaction, ephemeral('Please enter a character name and a valid date like `2026-08-20`.'));
  }

  const { data: selectedRoute, error: routeError } = await supabase
    .from('channel_routes')
    .select('*')
    .eq('school_id', school.id)
    .eq('id', Number(routeId))
    .maybeSingle();
  if (routeError) throw routeError;
  if (!selectedRoute) return respondInteraction(interaction, ephemeral('That saved channel route no longer exists.'));

  let route = selectedRoute;
  let discipline = await getActiveDiscipline(school.id, normalized);

  if (discipline?.discipline_type === 'suspension') {
    return respondInteraction(interaction, ephemeral(
      `🚫 **${studentName}** is currently suspended and cannot use school activities${discipline.ends_at ? ` until <t:${Math.floor(new Date(discipline.ends_at).getTime()/1000)}:F>` : ''}.`
    ));
  }

  const academic = ['assignment', 'study', 'reading', 'homework', 'tutoring', 'attend_class', 'library', 'study_hall', 'final'];

  if (discipline?.discipline_type === 'iss') {
    if (!academic.includes(activity)) {
      return respondInteraction(interaction, ephemeral(`⚠️ **${studentName}** is in ISS. Only approved schoolwork/study activities are available.`));
    }
    const issRoute = discipline.discord_location_channel_id
      ? { discord_channel_id: discipline.discord_location_channel_id, channel_name: 'ISS', route_type: 'iss' }
      : await findDisciplineRoute(school.id, 'iss');
    if (!issRoute) return respondInteraction(interaction, ephemeral('ISS is active, but Campus has no ISS channel saved. An admin should run `/routes setup`.'));
    route = issRoute;
  }

  if (discipline?.discipline_type === 'detention') {
    if (!academic.includes(activity) && activity !== 'detention') {
      return respondInteraction(interaction, ephemeral(`🚪 **${studentName}** is currently serving detention. Schoolwork is available, but this activity is restricted until detention ends.`));
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
      return respondInteraction(interaction, ephemeral('🎓 Finals Mode is currently OFF.'));
    }
    if (finals.start_date && activityDate < finals.start_date) {
      return respondInteraction(interaction, ephemeral('That date is before the current finals period.'));
    }
    if (finals.end_date && activityDate > finals.end_date) {
      return respondInteraction(interaction, ephemeral('That date is after the current finals period.'));
    }

    const weekday = new Date(`${activityDate}T12:00:00Z`).getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    if (isWeekend && !finals.include_weekends) {
      return respondInteraction(interaction, ephemeral('🎓 Finals are not required on weekends.'));
    }

    const { data: holiday } = await supabase.from('school_calendar')
      .select('id')
      .eq('school_id', school.id)
      .eq('school_closed', true)
      .lte('start_date', activityDate)
      .or(`end_date.gte.${activityDate},end_date.is.null`)
      .limit(1);
    if (holiday?.length && !finals.include_school_holidays) {
      return respondInteraction(interaction, ephemeral('🎓 Finals are not required on school-closed calendar days.'));
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
        return respondInteraction(interaction, ephemeral(`✅ **${studentName}** already completed a final for **${activityDate}**.`));
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
      return respondInteraction(interaction, ephemeral('That exact activity is already logged for this character on that date.'));
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
    return respondInteraction(interaction, ephemeral('The activity was saved, but I could not post in the destination channel.'));
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

  if (
    school.teacher_automation_enabled !== false
    && teacherFound?.settings?.assignment_acknowledgement
    && teacherFound.settings.automation_enabled
  ) {
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

  return respondInteraction(interaction, ephemeral(`✅ **${studentName}** was posted in <#${route.discord_channel_id}>.\n${creditText}`));
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
  const today = getLocalParts(school.timezone).date;

  return quarters.map((q) => {
    const p = map.get(q.id);
    const completed = p?.completed_actions ?? 0;
    const percent = Math.min(100, Math.round((completed / q.required_actions) * 100));
    const notStarted = today < q.start_date;
    const ended = today > q.end_date || q.closed;

    return {
      ...q,
      completed,
      percent,
      notStarted,
      ended,
      letter: notStarted ? null : letterGrade(percent, school.grading_scale),
    };
  });
}

async function handleProgress(interaction, gradeMode = false, explicitName = null) {
  const school = await requireSchool(interaction);
  if (!school) return;
  const name = explicitName ?? interaction.options.getString('name', true);
  const rows = await getProgressData(school, name);

  if (!rows.length) return respondInteraction(interaction, ephemeral('No quarters are configured yet. An admin needs to run `/quarter setup`.'));

  const lines = rows.map((q) => {
    if (gradeMode) {
      if (q.notStarted) {
        return `**Q${q.quarter_number}: Not Started** — begins ${q.start_date}`;
      }
      return `**Q${q.quarter_number}: ${q.letter}** — ${q.completed}/${q.required_actions} actions (${q.percent}%)${q.ended ? ' • Final' : ' • Current'}`;
    }
    if (q.notStarted) {
      return `**Q${q.quarter_number}:** Not Started • begins ${q.start_date}`;
    }
    const remaining = Math.max(0, q.required_actions - q.completed);
    return `**Q${q.quarter_number}:** ${q.completed}/${q.required_actions} • ${q.percent}% • ${remaining} remaining`;
  });

  return respondInteraction(interaction, ephemeral(
    `${gradeMode ? '🎓' : '📚'} **${name} — ${gradeMode ? 'Grades' : 'Progress'}**\n${lines.join('\n')}`
  ));
}

async function getTrackedStudentNames(schoolId) {
  const [activityResult, finalsResult] = await Promise.all([
    supabase
      .from('student_activities')
      .select('student_name, student_name_normalized')
      .eq('school_id', schoolId)
      .order('student_name')
      .limit(5000),
    supabase
      .from('final_completions')
      .select('student_name, student_name_normalized')
      .eq('school_id', schoolId)
      .order('student_name')
      .limit(5000),
  ]);

  if (activityResult.error) throw activityResult.error;
  if (finalsResult.error) throw finalsResult.error;

  const names = new Map();
  for (const row of [...(activityResult.data ?? []), ...(finalsResult.data ?? [])]) {
    const display = String(row.student_name || '').trim();
    if (!display) continue;
    const normalized = row.student_name_normalized || normalizeName(display);
    if (!names.has(normalized)) names.set(normalized, display);
  }

  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function gradebookQuarterText(q) {
  if (q.notStarted) return `Q${q.quarter_number}: Not Started`;
  return `Q${q.quarter_number}: ${q.letter} (${q.percent}%)`;
}

async function handleGradeAll(interaction) {
  const school = await requireSchool(interaction);
  if (!school) return;

  const names = await getTrackedStudentNames(school.id);
  if (!names.length) {
    return respondInteraction(interaction, ephemeral('📊 No students have logged Campus activities yet.'));
  }

  const lines = [];
  for (const name of names) {
    const rows = await getProgressData(school, name);
    if (!rows.length) {
      return respondInteraction(interaction, ephemeral('No quarters are configured yet. An admin needs to run `/quarter setup`.'));
    }
    lines.push(`**${name}** — ${rows.map(gradebookQuarterText).join(' • ')}`);
  }

  const pages = [];
  let current = '📊 **Campus Gradebook — All Students**\n';
  for (const line of lines) {
    const addition = `${line}\n`;
    if ((current + addition).length > 1850) {
      pages.push(current.trimEnd());
      current = `📊 **Campus Gradebook — All Students (continued)**\n${addition}`;
    } else {
      current += addition;
    }
  }
  if (current.trim()) pages.push(current.trimEnd());

  await respondInteraction(interaction, ephemeral(pages[0]));
  for (const page of pages.slice(1)) {
    await interaction.followUp(ephemeral(page));
  }
}


function gradeResetModal(students, quarters) {
  const studentSelect = new StringSelectMenuBuilder()
    .setCustomId('grade_reset_student')
    .setPlaceholder('Choose a student or All Students')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('ALL STUDENTS')
        .setDescription('Reset grades for every tracked student')
        .setValue('__all_students__'),
      ...students.slice(0, 24).map((name) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(String(name).slice(0, 100))
          .setValue(`student:${normalizeName(name)}`.slice(0, 100))
      )
    );

  const quarterSelect = new StringSelectMenuBuilder()
    .setCustomId('grade_reset_quarter')
    .setPlaceholder('Choose a quarter')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('All Quarters')
        .setValue('__all_quarters__'),
      ...quarters.map((q) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`Quarter ${q.quarter_number}`)
          .setDescription(`${q.start_date} to ${q.end_date}`)
          .setValue(String(q.id))
      )
    );

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId('grade_reset_mode')
    .setPlaceholder('Choose what reset means')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Reset Grade Progress Only')
        .setDescription('Keep activity history, but remove grade credit')
        .setValue('progress_only'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Reset Grade + Activity Records')
        .setDescription('Delete matching graded activity/final records')
        .setValue('delete_records')
    );

  const confirmSelect = new StringSelectMenuBuilder()
    .setCustomId('grade_reset_confirm')
    .setPlaceholder('Confirm reset')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Yes — Reset Grades')
        .setValue('yes'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Cancel')
        .setValue('cancel')
    );

  return new ModalBuilder()
    .setCustomId('campus_grade_reset')
    .setTitle('Reset Grades')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Student')
        .setDescription('Choose one student or ALL STUDENTS.')
        .setStringSelectMenuComponent(studentSelect),
      new LabelBuilder()
        .setLabel('Quarter')
        .setStringSelectMenuComponent(quarterSelect),
      new LabelBuilder()
        .setLabel('Reset Type')
        .setStringSelectMenuComponent(modeSelect),
      new LabelBuilder()
        .setLabel('Confirm')
        .setStringSelectMenuComponent(confirmSelect)
    );
}

async function openGradeResetModal(interaction) {
  if (!interaction.memberPermissions?.has('ManageGuild')) {
    return respondInteraction(interaction, ephemeral('Only school admins can reset grades.'));
  }

  const school = await requireSchool(interaction);
  if (!school) return;

  const [students, quarterResult] = await Promise.all([
    getTrackedStudentNames(school.id),
    supabase
      .from('quarters')
      .select('id, quarter_number, start_date, end_date')
      .eq('school_id', school.id)
      .order('quarter_number')
  ]);

  if (quarterResult.error) throw quarterResult.error;

  if (!quarterResult.data?.length) {
    return respondInteraction(interaction, ephemeral('No quarters are configured yet. Run `/quarter setup` first.'));
  }

  if (!students.length) {
    return respondInteraction(interaction, ephemeral('There are no tracked students to reset yet.'));
  }

  return interaction.showModal(gradeResetModal(students, quarterResult.data));
}

async function handleGradeResetModal(interaction) {
  if (!interaction.memberPermissions?.has('ManageGuild')) {
    return respondInteraction(interaction, ephemeral('Only school admins can reset grades.'));
  }

  const school = await requireSchool(interaction);
  if (!school) return;

  const studentValue = interaction.fields.getStringSelectValues('grade_reset_student')[0];
  const quarterValue = interaction.fields.getStringSelectValues('grade_reset_quarter')[0];
  const mode = interaction.fields.getStringSelectValues('grade_reset_mode')[0];
  const confirm = interaction.fields.getStringSelectValues('grade_reset_confirm')[0];

  if (confirm !== 'yes') {
    return respondInteraction(interaction, ephemeral('Grade reset cancelled.'));
  }

  const { data: quarters, error: quarterError } = await supabase
    .from('quarters')
    .select('id, quarter_number')
    .eq('school_id', school.id)
    .order('quarter_number');

  if (quarterError) throw quarterError;

  const quarterIds = quarterValue === '__all_quarters__'
    ? (quarters ?? []).map((q) => q.id)
    : [quarterValue];

  if (!quarterIds.length) {
    return respondInteraction(interaction, ephemeral('No matching quarter was found.'));
  }

  const allStudents = studentValue === '__all_students__';
  const normalizedStudent = allStudents
    ? null
    : studentValue.replace(/^student:/, '');

  const scopeQuery = (query) => {
    let scoped = query
      .eq('school_id', school.id)
      .in('quarter_id', quarterIds);

    if (!allStudents) {
      scoped = scoped.eq('student_name_normalized', normalizedStudent);
    }
    return scoped;
  };

  let activityRows = [];
  let finalRows = [];

  if (mode === 'progress_only') {
    const [activityResult, finalResult] = await Promise.all([
      scopeQuery(
        supabase
          .from('student_activities')
          .update({ counts_toward_grade: false })
      ).select('id'),
      scopeQuery(
        supabase
          .from('final_completions')
          .update({ counts_toward_grade: false })
      ).select('id')
    ]);

    if (activityResult.error) throw activityResult.error;
    if (finalResult.error) throw finalResult.error;
    activityRows = activityResult.data ?? [];
    finalRows = finalResult.data ?? [];
  } else if (mode === 'delete_records') {
    const [activityResult, finalResult] = await Promise.all([
      scopeQuery(
        supabase
          .from('student_activities')
          .delete()
      ).select('id'),
      scopeQuery(
        supabase
          .from('final_completions')
          .delete()
      ).select('id')
    ]);

    if (activityResult.error) throw activityResult.error;
    if (finalResult.error) throw finalResult.error;
    activityRows = activityResult.data ?? [];
    finalRows = finalResult.data ?? [];
  } else {
    return respondInteraction(interaction, ephemeral('Unknown grade reset type.'));
  }

  const quarterLabel = quarterValue === '__all_quarters__'
    ? 'all quarters'
    : `Q${(quarters ?? []).find((q) => String(q.id) === String(quarterValue))?.quarter_number ?? '?'}`;

  const studentLabel = allStudents
    ? 'ALL STUDENTS'
    : (await getTrackedStudentNames(school.id)).find((name) => normalizeName(name) === normalizedStudent)
      ?? normalizedStudent;

  const totalChanged = activityRows.length + finalRows.length;
  const actionText = mode === 'progress_only'
    ? 'grade credit was reset while activity history was kept'
    : 'matching grade/activity records were permanently deleted';

  return respondInteraction(interaction, ephemeral(
    `♻️ **Grade Reset Complete**\n`
    + `**Students:** ${studentLabel}\n`
    + `**Quarter:** ${quarterLabel}\n`
    + `**Records affected:** ${totalChanged}\n`
    + `**Result:** ${actionText}.`
  ));
}

async function handleGradeCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'all') return handleGradeAll(interaction);
  if (sub === 'reset') return openGradeResetModal(interaction);
  if (sub === 'student') {
    const name = interaction.options.getString('name', true);
    return handleProgress(interaction, true, name);
  }
  return respondInteraction(interaction, ephemeral('Choose `/grade student`, `/grade all`, or `/grade reset`.'));
}

async function handleCommand(interaction) {
  switch (interaction.commandName) {
    case 'campus': return handleCampus(interaction);
    case 'quarter': return handleQuarter(interaction);
    case 'routes': return handleRoutes(interaction);
    case 'automation': return handleSchoolAutomation(interaction);
    case 'teacher': return handleTeacher(interaction);
    case 'finals': return handleFinals(interaction);
    case 'discipline': return handleDiscipline(interaction);
    case 'calendar': return handleCalendar(interaction);
    case 'menu': return handleMenu(interaction);
    case 'activity': return buildActivityMenu(interaction);
    case 'progress': return handleProgress(interaction, false);
    case 'grade': return handleGradeCommand(interaction);
    default: return respondInteraction(interaction, ephemeral('Unknown Campus command.'));
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
      if (interaction.customId === 'campus_command_center') return await handleCampusCommandCenter(interaction);
      if (interaction.customId === 'campus_activity') return await handleActivityChoice(interaction);
      if (interaction.customId.startsWith('campus_destination:')) return await handleDestinationChoice(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('campus_teacher_personal_open:')) {
        return await openTeacherPersonalDetails(interaction);
      }
      if (interaction.customId.startsWith('campus_teacher_absence_open:')) {
        return await openTeacherAbsenceSettings(interaction);
      }
      if (interaction.customId.startsWith('campus_teacher_roaming_open:')) {
        return await openTeacherRoamingSettings(interaction);
      }
      if (interaction.customId.startsWith('campus_teacher_automation_redo_open:')) {
        return await openTeacherAutomationRedo(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      // Discord interactions expire quickly. Acknowledge the modal immediately,
      // then the handler can safely do Supabase/database work and use editReply().
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }

      if (interaction.customId === 'campus_school_setup') {
        return await handleCampusSetupModal(interaction);
      }

      if (interaction.customId === 'campus_quarter_setup') {
        return await handleQuarterSetupModal(interaction);
      }

      if (interaction.customId === 'campus_routes_setup') {
        return await handleRoutesSetupModal(interaction);
      }

      if (interaction.customId === 'campus_teacher_create' || interaction.customId.startsWith('campus_teacher_edit:')) {
        return await handleTeacherModal(interaction);
      }

      if (interaction.customId === 'campus_teacher_edit_picker') {
        return await handleTeacherEditPickerModal(interaction);
      }

      if (interaction.customId === 'campus_teacher_status') {
        return await handleTeacherStatusModal(interaction);
      }

      if (interaction.customId === 'campus_teacher_automation') {
        return await handleTeacherAutomationModal(interaction);
      }

      if (interaction.customId === 'campus_school_automation') {
        return await handleSchoolAutomationModal(interaction);
      }

      if (interaction.customId === 'campus_teacher_automation_reset') {
        return await handleTeacherAutomationResetModal(interaction);
      }

      if (interaction.customId.startsWith('campus_teacher_automation_redo:')) {
        return await handleTeacherAutomationRedoModal(interaction);
      }

      if (interaction.customId.startsWith('campus_teacher_absence:')) {
        return await handleTeacherAbsenceModal(interaction);
      }

      if (interaction.customId.startsWith('campus_teacher_roaming:')) {
        return await handleTeacherRoamingModal(interaction);
      }

      if (interaction.customId === 'campus_teacher_remove') {
        return await handleTeacherRemoveModal(interaction);
      }

      if (interaction.customId.startsWith('campus_teacher_personal:')) {
        return await handleTeacherPersonalDetailsModal(interaction);
      }

      if (interaction.customId === 'campus_finals_on') {
        return await handleFinalsOnModal(interaction);
      }

      if (interaction.customId === 'campus_discipline_add') {
        return await handleDisciplineAddModal(interaction);
      }

      if (interaction.customId === 'campus_calendar_add') {
        return await handleCalendarAddModal(interaction);
      }

      if (interaction.customId === 'campus_grade_reset') {
        return await handleGradeResetModal(interaction);
      }

      if (interaction.customId.startsWith('campus_activity_modal:')) {
        return await handleActivityModal(interaction);
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);

    // 10062 = Discord already expired the interaction token.
    // 40060 = the interaction was already acknowledged.
    // Do not create a second Discord error while reporting the first one.
    if (error?.code === 10062 || error?.code === 40060) return;

    const payload = ephemeral(
      `Campus hit an error: \`${String(error.message || error).slice(0, 150)}\``
    );

    await respondInteraction(interaction, payload).catch(() => {});
  }
});


const roamingResponseChance = {
  rare: 0.08,
  normal: 0.20,
  frequent: 0.40,
};

function teacherNameMentioned(content, teacher) {
  const lower = String(content || '').toLowerCase();
  const full = String(teacher.teacher_name || '').toLowerCase();
  const last = full.split(/\s+/).at(-1);
  return Boolean(full && lower.includes(full)) || Boolean(last && last.length >= 3 && lower.includes(last));
}

async function getRoamingTeachersForChannel(schoolId, channelId) {
  const { data, error } = await supabase
    .from('teachers')
    .select('*, teacher_settings(*)')
    .eq('school_id', schoolId)
    .in('status', ['active', 'reactive_only']);
  if (error) throw error;

  return (data ?? []).map((teacher) => {
    const settings = Array.isArray(teacher.teacher_settings)
      ? teacher.teacher_settings[0]
      : teacher.teacher_settings;
    return { teacher, settings };
  }).filter(({ settings }) =>
    Boolean(settings?.automation_enabled)
    && Boolean(settings?.roaming_enabled)
    && Array.isArray(settings?.roaming_channel_ids)
    && settings.roaming_channel_ids.map(String).includes(String(channelId))
  );
}

async function chooseRoamingTeacherForStudentMessage(school, message) {
  const candidates = await getRoamingTeachersForChannel(school.id, message.channel.id);
  const usable = [];

  for (const candidate of candidates) {
    const { teacher, settings } = candidate;
    if (!settings?.conversation_awareness || !settings?.respond_to_students || !settings?.roaming_student_chat) continue;
    if (settings.obey_school_quiet_hours && await schoolIsQuiet(school)) continue;

    const cooldown = (settings.minimum_cooldown_minutes ?? 30) * 60_000;
    if (Date.now() - (lastTeacherAction.get(teacher.id) || 0) < cooldown) continue;
    usable.push(candidate);
  }

  if (!usable.length) return null;

  const named = usable.find(({ teacher }) => teacherNameMentioned(message.content, teacher));
  if (named) return named;

  // For a general question, give one roaming teacher a better chance to answer.
  const askingQuestion = message.content.includes('?');
  const shuffled = [...usable].sort(() => Math.random() - 0.5);
  for (const candidate of shuffled) {
    const base = roamingResponseChance[candidate.settings?.roaming_frequency] ?? roamingResponseChance.normal;
    const chance = askingQuestion ? Math.min(0.85, base * 2.2) : base;
    if (Math.random() <= chance) return candidate;
  }

  return null;
}


function isWebhookCharacterMessage(message) {
  // Tupperbox and similar proxy-character systems post through Discord webhooks.
  return Boolean(message?.webhookId);
}

function isOwnTeacherWebhookMessage(message, teacher) {
  if (!message?.webhookId || !teacher) return false;
  return String(message.author?.username || '').trim().toLowerCase()
    === String(teacher.teacher_name || '').trim().toLowerCase();
}

function isStudentConversationMessage(message, currentTeacher = null, knownTeacherNames = null) {
  if (!message?.content) return false;

  // Normal human Discord message.
  if (!message.author?.bot) return true;

  // Bot-authored messages are ignored unless they came from a webhook
  // (Tupperbox / proxy-character style messages).
  if (!isWebhookCharacterMessage(message)) return false;

  // Never feed the current teacher's own webhook output back to themselves.
  if (currentTeacher && isOwnTeacherWebhookMessage(message, currentTeacher)) return false;

  // If a complete teacher-name set is supplied, known Campus teacher webhook
  // messages can be separated from Tupperbox/student webhook messages.
  if (knownTeacherNames) {
    const username = String(message.author?.username || '').trim().toLowerCase();
    if (knownTeacherNames.has(username)) return false;
  }

  return { teacher, settings };
}

client.on(Events.MessageCreate, async (message) => {
  if (!aiEnabled() || !message.guild || !message.content) return;

  // Ignore ordinary bots, but allow webhook-based character messages
  // such as Tupperbox.
  if (message.author.bot && !message.webhookId) return;

  try {
    const school = await getSchool(message.guild.id);
    if (!school) return;
    if (school.teacher_automation_enabled === false) return;

    let found = await resolveActiveTeacher(school.id, message.channel.id);
    let isCommonArea = false;

    if (!found) {
      found = await chooseRoamingTeacherForStudentMessage(school, message);
      isCommonArea = Boolean(found);
    }
    if (!found) return;

    const { teacher, settings } = found;

    // Campus teachers speak through webhooks. Do not let a teacher hear their
    // own webhook message as if it were a student/Tupperbox character.
    if (isOwnTeacherWebhookMessage(message, teacher)) return;

    if (!settings?.automation_enabled || !settings.conversation_awareness || !settings.respond_to_students) return;
    if (isCommonArea && !settings.roaming_student_chat) return;

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
      teacherNameMentioned(message.content, teacher) ||
      message.mentions.has(client.user);

    if (!directlyAddressed) {
      const chance = isCommonArea
        ? (roamingResponseChance[settings.roaming_frequency] ?? roamingResponseChance.normal)
        : (settings.reaction_chance_percent ?? 25) / 100;
      if (Math.random() > chance) return;
    }

    const fetched = await message.channel.messages.fetch({ limit: 12 });
    const recent = [...fetched.values()]
      .reverse()
      .filter((m) => isStudentConversationMessage(m, teacher))
      .map((m) => `${m.member?.displayName || m.author.username}: ${m.content}`)
      .filter(Boolean);

    const decision = await teacherConversationDecision({
      teacher,
      recentMessages: recent,
      triggeringMessage: message.content,
      spontaneous: false,
      setting: isCommonArea ? `common area #${message.channel.name}` : `assigned classroom #${message.channel.name}`,
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
        type: isCommonArea ? 'common_area' : 'classroom',
        text: `${isCommonArea ? 'Recent common-area exchange' : 'Recent classroom exchange'}: ${message.content.slice(0, 220)} / Teacher replied: ${decision.content.slice(0, 220)}`,
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


const randomAbsenceChance = {
  rare: 0.03,
  occasional: 0.08,
  frequent: 0.15,
};

function weekdayFromDateString(dateString) {
  const day = new Date(`${dateString}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function addCalendarDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

async function isOpenSchoolDate(school, dateString) {
  const weekday = weekdayFromDateString(dateString);
  if (!school.school_days?.includes(weekday)) return false;

  const { data, error } = await supabase
    .from('school_calendar')
    .select('id')
    .eq('school_id', school.id)
    .eq('school_closed', true)
    .lte('start_date', dateString)
    .or(`end_date.gte.${dateString},end_date.is.null`)
    .limit(1);
  if (error) throw error;
  return !data?.length;
}

async function returnDateAfterSchoolDays(school, fromDate, absenceLength) {
  let candidate = fromDate;
  let openDaysSeen = 0;

  for (let i = 0; i < 30; i += 1) {
    candidate = addCalendarDays(candidate, 1);
    if (!(await isOpenSchoolDate(school, candidate))) continue;
    openDaysSeen += 1;
    if (openDaysSeen >= absenceLength) return candidate;
  }

  // Safety fallback. A normal school calendar should never need this.
  return addCalendarDays(fromDate, Math.max(1, absenceLength));
}

async function automaticAbsenceTick() {
  if (!client.isReady()) return;

  const { data: teachers, error } = await supabase
    .from('teachers')
    .select('*, teacher_settings(*)');

  if (error) {
    console.error('Random absence DB error:', error.message);
    return;
  }

  const schoolCache = new Map();

  for (const teacher of teachers ?? []) {
    try {
      const settings = Array.isArray(teacher.teacher_settings)
        ? teacher.teacher_settings[0]
        : teacher.teacher_settings;
      if (!settings) continue;

      let school = schoolCache.get(teacher.school_id);
      if (!school) {
        const { data, error: schoolError } = await supabase
          .from('schools')
          .select('*')
          .eq('id', teacher.school_id)
          .maybeSingle();
        if (schoolError || !data) continue;
        school = data;
        schoolCache.set(teacher.school_id, school);
      }

      const local = getLocalParts(school.timezone);

      // Bring an automatically absent teacher back on the configured school day.
      if (teacher.auto_absence_active) {
        if (teacher.auto_absence_until && local.date >= teacher.auto_absence_until) {
          const { error: restoreError } = await supabase
            .from('teachers')
            .update({
              status: 'active',
              auto_absence_active: false,
              auto_absence_started_on: null,
              auto_absence_until: null,
            })
            .eq('id', teacher.id);
          if (restoreError) throw restoreError;

          await supabase
            .from('teacher_settings')
            .update({ last_absence_check_date: local.date })
            .eq('teacher_id', teacher.id);

          const guild = client.guilds.cache.get(school.discord_guild_id);
          const channel = guild
            ? await guild.channels.fetch(teacher.classroom_channel_id).catch(() => null)
            : null;
          if (channel?.isTextBased()) {
            await channel.send({
              content: `🍎 **Teacher Update:** ${teacher.teacher_name} is back today and has returned to class.`,
              allowedMentions: { parse: [] },
            });
          }
        }
        continue;
      }

      // The school-wide master switch stops NEW automated absences,
      // but the return logic above still runs so nobody gets stuck absent.
      if (school.teacher_automation_enabled === false) continue;

      if (!settings.random_absences_enabled || teacher.status !== 'active') continue;
      if (settings.last_absence_check_date === local.date) continue;
      if (!(await isOpenSchoolDate(school, local.date))) continue;

      const start = String(school.school_day_start || '08:00').slice(0, 5);
      const end = String(school.school_day_end || '15:00').slice(0, 5);
      if (local.time < start || local.time > end) continue;

      // Mark today checked before rolling, so repeated bot ticks cannot roll twice.
      const { error: checkError } = await supabase
        .from('teacher_settings')
        .update({ last_absence_check_date: local.date })
        .eq('teacher_id', teacher.id);
      if (checkError) throw checkError;

      const chance = randomAbsenceChance[settings.absence_frequency] ?? randomAbsenceChance.rare;
      if (Math.random() > chance) continue;

      const absenceLength = Math.max(1, Math.min(3, Number(settings.auto_absence_duration_school_days || 1)));
      const returnDate = await returnDateAfterSchoolDays(school, local.date, absenceLength);

      let coverageText = 'No substitute was assigned automatically. An admin can use `/teacher status` to assign coverage.';
      if (teacher.substitute_teacher_id) {
        const { data: substitute } = await supabase
          .from('teachers')
          .select('id, teacher_name, status')
          .eq('id', teacher.substitute_teacher_id)
          .maybeSingle();
        if (substitute && !['away', 'paused'].includes(substitute.status)) {
          coverageText = `**${substitute.teacher_name}** will cover the class.`;
        } else if (teacher.use_generic_substitute) {
          coverageText = 'A **generic substitute teacher** will cover the class.';
        } else {
          coverageText = 'The preferred saved substitute is unavailable, so an admin needs to assign coverage.';
        }
      } else if (teacher.use_generic_substitute) {
        coverageText = 'A **generic substitute teacher** will cover the class.';
      }

      const { error: absenceError } = await supabase
        .from('teachers')
        .update({
          status: 'substitute_mode',
          auto_absence_active: true,
          auto_absence_started_on: local.date,
          auto_absence_until: returnDate,
        })
        .eq('id', teacher.id);
      if (absenceError) throw absenceError;

      await supabase.from('change_history').insert({
        school_id: school.id,
        entity_type: 'teacher',
        entity_id: String(teacher.id),
        action: 'automatic_absence',
        new_value: {
          absent_on: local.date,
          return_date: returnDate,
          absence_length_school_days: absenceLength,
        },
      });

      const guild = client.guilds.cache.get(school.discord_guild_id);
      const channel = guild
        ? await guild.channels.fetch(teacher.classroom_channel_id).catch(() => null)
        : null;
      if (channel?.isTextBased()) {
        await channel.send({
          content:
            `🍎 **Teacher Update:** ${teacher.teacher_name} is out today. ${coverageText}\n`
            + `Expected return: **${returnDate}**.`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (error) {
      console.error(`Automatic absence teacher ${teacher.id} error:`, error.message);
    }
  }
}

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

  const knownTeacherNames = new Set((teachers ?? []).map((t) => String(t.teacher_name || '').toLowerCase()));

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
      if (school.teacher_automation_enabled === false) continue;

      if (settings.obey_school_quiet_hours && await schoolIsQuiet(school)) continue;

      const cooldown = (settings.minimum_cooldown_minutes ?? 30) * 60_000;
      if (Date.now() - (lastTeacherAction.get(teacher.id) || 0) < cooldown) continue;

      const history = (spontaneousHistory.get(teacher.id) || []).filter((t) => Date.now() - t < 3_600_000);
      if (history.length >= (settings.max_spontaneous_messages_per_hour ?? 2)) continue;

      let chance = settings.activity_frequency === 'custom'
        ? (settings.conversation_start_chance_percent ?? 10) / 100
        : frequencyChance[settings.activity_frequency] ?? 0.15;

      const roamingIds = settings.roaming_enabled && Array.isArray(settings.roaming_channel_ids)
        ? settings.roaming_channel_ids.map(String)
        : [];
      const canUseCommonAreas = roamingIds.length > 0 && (settings.roaming_student_chat || settings.roaming_teacher_chat);
      const chooseCommonArea = canUseCommonAreas && Math.random() < 0.60;

      if (chooseCommonArea) {
        const roamFactor = roamingResponseChance[settings.roaming_frequency] ?? roamingResponseChance.normal;
        chance = Math.max(chance, roamFactor);
      }

      if (Math.random() > chance) continue;

      const guild = client.guilds.cache.find((g) => g.id === school.discord_guild_id);
      if (!guild) continue;

      let channel = null;
      let isCommonArea = false;

      if (chooseCommonArea) {
        const shuffledIds = [...roamingIds].sort(() => Math.random() - 0.5);
        for (const id of shuffledIds) {
          const candidate = await guild.channels.fetch(id).catch(() => null);
          if (candidate?.isTextBased()) {
            channel = candidate;
            isCommonArea = true;
            break;
          }
        }
      }

      if (!channel) {
        channel = await guild.channels.fetch(teacher.classroom_channel_id).catch(() => null);
      }
      if (!channel?.isTextBased()) continue;

      const fetched = await channel.messages.fetch({ limit: 20 });
      const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const twoHoursAgo = Date.now() - 2 * 3_600_000;

      let recent = [];
      if (isCommonArea) {
        recent = messages
          .filter((m) => m.createdTimestamp >= twoHoursAgo)
          .filter((m) => {
            if (!m.author.bot) return Boolean(settings.roaming_student_chat);

            if (!m.webhookId) return false;

            const username = String(m.author.username || '').trim().toLowerCase();
            const currentTeacherName = String(teacher.teacher_name || '').trim().toLowerCase();

            // Campus teacher webhook message.
            if (knownTeacherNames.has(username)) {
              const isOtherCampusTeacher = username !== currentTeacherName;
              return Boolean(settings.roaming_teacher_chat) && isOtherCampusTeacher;
            }

            // Webhook character message that is NOT one of Campus's teachers:
            // treat it as a student/Tupperbox character.
            return Boolean(settings.roaming_student_chat);
          })
          .map((m) => `${m.member?.displayName || m.author.username}: ${m.content}`)
          .filter(Boolean);
      } else {
        const newest = messages.at(-1);
        if (!newest || Date.now() - newest.createdTimestamp > 2 * 3_600_000) continue;
        recent = messages
          .filter((m) => {
            if (!m.author.bot) return true;
            if (!m.webhookId) return false;

            const username = String(m.author.username || '').trim().toLowerCase();
            const currentTeacherName = String(teacher.teacher_name || '').trim().toLowerCase();

            // Ignore this teacher's own Campus webhook output, but allow
            // Tupperbox/proxy-character webhook messages into classroom context.
            return username !== currentTeacherName;
          })
          .map((m) => `${m.member?.displayName || m.author.username}: ${m.content}`)
          .filter(Boolean);
      }

      const decision = await teacherConversationDecision({
        teacher,
        recentMessages: recent,
        triggeringMessage: '',
        spontaneous: true,
        setting: isCommonArea ? `common area #${channel.name}` : `assigned classroom #${channel.name}`,
      });

      if (decision.type === 'reply') {
        await sendAsTeacher(channel, teacher, decision.content);
        const now = Date.now();
        lastTeacherAction.set(teacher.id, now);
        spontaneousHistory.set(teacher.id, [...history, now]);
        if (isCommonArea) {
          await rememberTeacherEvent({
            schoolId: school.id,
            teacherId: teacher.id,
            type: 'common_area',
            text: `Teacher spoke in #${channel.name}: ${decision.content.slice(0, 260)}`,
            days: 7,
          });
        }
      }
    } catch (error) {
      console.error(`Spontaneous teacher ${teacher.id} error:`, error.message);
    }
  }
}

const tickMinutes = Math.max(1, Number(process.env.TEACHER_TICK_MINUTES || 10));
setInterval(async () => {
  await automaticAbsenceTick();
  await spontaneousTeacherTick();
}, tickMinutes * 60_000);

client.login(process.env.DISCORD_TOKEN);
