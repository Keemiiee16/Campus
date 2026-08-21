import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

const admin = PermissionFlagsBits.ManageGuild;

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName('campus')
    .setDescription('Set up Campus for this school server.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Create or update the school settings.')
        .addStringOption((o) =>
          o.setName('school_name').setDescription('The school name.').setRequired(true))
        .addStringOption((o) =>
          o.setName('timezone').setDescription('Example: America/Chicago').setRequired(true))
        .addStringOption((o) =>
          o.setName('school_start').setDescription('24-hour time, example 07:30').setRequired(true))
        .addStringOption((o) =>
          o.setName('school_end').setDescription('24-hour time, example 16:00').setRequired(true))
        .addBooleanOption((o) =>
          o.setName('quiet_hours').setDescription('Stop spontaneous teacher messages outside school hours.').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('quarter')
    .setDescription('Set up or edit grading quarters.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Create or update one quarter.')
        .addIntegerOption((o) =>
          o.setName('quarter').setDescription('Quarter number.').setRequired(true)
            .addChoices(
              { name: 'Quarter 1', value: 1 },
              { name: 'Quarter 2', value: 2 },
              { name: 'Quarter 3', value: 3 },
              { name: 'Quarter 4', value: 4 },
            ))
        .addStringOption((o) =>
          o.setName('start_date').setDescription('YYYY-MM-DD').setRequired(true))
        .addStringOption((o) =>
          o.setName('end_date').setDescription('YYYY-MM-DD').setRequired(true))
        .addIntegerOption((o) =>
          o.setName('required_actions').setDescription('How many qualifying actions are needed.').setRequired(true).setMinValue(1))
    ),

  new SlashCommandBuilder()
    .setName('routes')
    .setDescription('Tell Campus where classrooms, locations, clubs, or discipline channels live.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Scan one Discord category and save its channels.')
        .addStringOption((o) =>
          o.setName('group').setDescription('What kind of category is this?').setRequired(true)
            .addChoices(
              { name: 'Classrooms', value: 'classrooms' },
              { name: 'School Locations', value: 'locations' },
              { name: 'Clubs & Activities', value: 'clubs' },
              { name: 'Discipline', value: 'discipline' },
            ))
        .addChannelOption((o) =>
          o.setName('category').setDescription('Choose the Discord category.').setRequired(true)
            .addChannelTypes(ChannelType.GuildCategory))
    ),

  new SlashCommandBuilder()
    .setName('teacher')
    .setDescription('Create and manage automated teachers.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Create an automated teacher.')
        .addStringOption((o) => o.setName('name').setDescription('Teacher name.').setRequired(true))
        .addStringOption((o) => o.setName('subject').setDescription('Subject.').setRequired(true))
        .addChannelOption((o) =>
          o.setName('classroom').setDescription('Teacher classroom channel.').setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('personality').setDescription('How this teacher acts.').setRequired(true))
        .addStringOption((o) => o.setName('grade').setDescription('Grade level.').setRequired(false))
        .addStringOption((o) => o.setName('teaching_style').setDescription('How this teacher teaches.').setRequired(false))
        .addIntegerOption((o) => o.setName('strictness').setDescription('1-10').setMinValue(1).setMaxValue(10))
        .addIntegerOption((o) => o.setName('talkativeness').setDescription('1-10').setMinValue(1).setMaxValue(10))
        .addIntegerOption((o) => o.setName('humor').setDescription('1-10').setMinValue(1).setMaxValue(10))
        .addIntegerOption((o) => o.setName('patience').setDescription('1-10').setMinValue(1).setMaxValue(10))
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Edit a saved teacher without erasing their history.')
        .addStringOption((o) => o.setName('name').setDescription('Current teacher name.').setRequired(true))
        .addStringOption((o) => o.setName('new_name').setDescription('New teacher name.'))
        .addStringOption((o) => o.setName('subject').setDescription('New subject.'))
        .addStringOption((o) => o.setName('grade').setDescription('New grade level.'))
        .addStringOption((o) => o.setName('personality').setDescription('New personality.'))
        .addStringOption((o) => o.setName('teaching_style').setDescription('New teaching style.'))
        .addChannelOption((o) =>
          o.setName('classroom').setDescription('New classroom channel.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Change teacher status.')
        .addStringOption((o) => o.setName('name').setDescription('Teacher name.').setRequired(true))
        .addStringOption((o) =>
          o.setName('status').setDescription('New status.').setRequired(true)
            .addChoices(
              { name: '🟢 Active', value: 'active' },
              { name: '🔵 Reactive Only', value: 'reactive_only' },
              { name: '🟡 Away', value: 'away' },
              { name: '🟣 Substitute Mode', value: 'substitute_mode' },
              { name: '🔴 Paused', value: 'paused' },
            ))
        .addStringOption((o) =>
          o.setName('substitute_name').setDescription('Existing teacher who is substituting.'))
        .addBooleanOption((o) =>
          o.setName('generic_substitute').setDescription('Use a generic substitute instead.'))
    )
    .addSubcommand((sub) =>
      sub
        .setName('automation')
        .setDescription('Change how often a teacher acts.')
        .addStringOption((o) => o.setName('name').setDescription('Teacher name.').setRequired(true))
        .addBooleanOption((o) => o.setName('enabled').setDescription('Master automation on/off.'))
        .addStringOption((o) =>
          o.setName('frequency').setDescription('Spontaneous activity frequency.')
            .addChoices(
              { name: 'Very Low', value: 'very_low' },
              { name: 'Low', value: 'low' },
              { name: 'Normal', value: 'normal' },
              { name: 'High', value: 'high' },
              { name: 'Very High', value: 'very_high' },
              { name: 'Custom', value: 'custom' },
            ))
        .addIntegerOption((o) =>
          o.setName('cooldown_minutes').setDescription('Minimum minutes between spontaneous messages.').setMinValue(0).setMaxValue(1440))
        .addBooleanOption((o) => o.setName('react_to_messages').setDescription('React to student messages.'))
        .addBooleanOption((o) => o.setName('spontaneous_messages').setDescription('Say things on its own.'))
        .addBooleanOption((o) => o.setName('conversation_awareness').setDescription('Notice classroom conversations.'))
    ),

  new SlashCommandBuilder()
    .setName('finals')
    .setDescription('Manage Finals Mode.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('on')
        .setDescription('Turn Finals Mode on.')
        .addIntegerOption((o) =>
          o.setName('quarter').setDescription('Which quarter do these finals count toward?').setRequired(true)
            .addChoices(
              { name: 'Quarter 1', value: 1 },
              { name: 'Quarter 2', value: 2 },
              { name: 'Quarter 3', value: 3 },
              { name: 'Quarter 4', value: 4 },
            ))
        .addStringOption((o) => o.setName('start_date').setDescription('Optional YYYY-MM-DD start date.'))
        .addStringOption((o) => o.setName('end_date').setDescription('Optional YYYY-MM-DD end date.'))
    )
    .addSubcommand((sub) =>
      sub.setName('off').setDescription('Turn Finals Mode off.'))
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Check Finals Mode.')),

  new SlashCommandBuilder()
    .setName('discipline')
    .setDescription('Detention, ISS, and suspension.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Give a character detention, ISS, or suspension.')
        .addStringOption((o) => o.setName('name').setDescription('Character name.').setRequired(true))
        .addStringOption((o) =>
          o.setName('type').setDescription('Discipline type.').setRequired(true)
            .addChoices(
              { name: 'Detention', value: 'detention' },
              { name: 'ISS', value: 'iss' },
              { name: 'Suspension', value: 'suspension' },
            ))
        .addIntegerOption((o) =>
          o.setName('duration').setDescription('How long?').setRequired(true).setMinValue(1))
        .addStringOption((o) =>
          o.setName('unit').setDescription('Duration unit.').setRequired(true)
            .addChoices(
              { name: 'Minutes', value: 'minutes' },
              { name: 'Hours', value: 'hours' },
              { name: 'Days', value: 'days' },
            ))
        .addStringOption((o) => o.setName('reason').setDescription('Optional reason.'))
        .addChannelOption((o) =>
          o.setName('location').setDescription('Optional detention/ISS channel.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('End a character discipline restriction early.')
        .addStringOption((o) => o.setName('name').setDescription('Character name.').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('check')
        .setDescription('Check current discipline status.')
        .addStringOption((o) => o.setName('name').setDescription('Character name.').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('calendar')
    .setDescription('Manage school calendar awareness.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a school event.')
        .addStringOption((o) => o.setName('name').setDescription('Event name.').setRequired(true))
        .addStringOption((o) => o.setName('type').setDescription('Example: spirit_week, break, field_trip.').setRequired(true))
        .addStringOption((o) => o.setName('start_date').setDescription('YYYY-MM-DD').setRequired(true))
        .addBooleanOption((o) => o.setName('school_closed').setDescription('Is school closed during this event?').setRequired(true))
        .addStringOption((o) => o.setName('end_date').setDescription('Optional YYYY-MM-DD'))
        .addStringOption((o) => o.setName('description').setDescription('Optional details.'))
    )
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show upcoming events.')),

  new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Log what your character is doing at school.'),

  new SlashCommandBuilder()
    .setName('progress')
    .setDescription('Check a character’s four-quarter progress.')
    .addStringOption((o) =>
      o.setName('name').setDescription('Character name.').setRequired(true)),

  new SlashCommandBuilder()
    .setName('grade')
    .setDescription('Check a character’s current quarter grades.')
    .addStringOption((o) =>
      o.setName('name').setDescription('Character name.').setRequired(true)),
];

export const commandJSON = commandBuilders.map((c) => c.toJSON());
