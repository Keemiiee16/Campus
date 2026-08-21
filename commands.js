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
        .setDescription('Open the school registration pop-up.')
    ),

  new SlashCommandBuilder()
    .setName('quarter')
    .setDescription('Set up or edit grading quarters.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Open the quarter setup form.')
    ),

  new SlashCommandBuilder()
    .setName('routes')
    .setDescription('Tell Campus where classrooms, locations, clubs, or discipline channels live.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Open the route setup form and choose one or more categories.')
    ),

  new SlashCommandBuilder()
    .setName('teacher')
    .setDescription('Create and manage automated teachers.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('create')
        .setDescription('Open a pop-up form to create a teacher.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Open a pop-up form to edit a saved teacher.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Teacher to edit.').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Change teacher status.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Teacher name.').setRequired(true))
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
        .addStringOption((o) =>
          o.setName('name').setDescription('Teacher name.').setRequired(true))
        .addBooleanOption((o) =>
          o.setName('enabled').setDescription('Master automation on/off.'))
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
        .addBooleanOption((o) =>
          o.setName('react_to_messages').setDescription('React to student messages.'))
        .addBooleanOption((o) =>
          o.setName('spontaneous_messages').setDescription('Say things on its own.'))
        .addBooleanOption((o) =>
          o.setName('conversation_awareness').setDescription('Notice classroom conversations.'))
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
        .addStringOption((o) =>
          o.setName('start_date').setDescription('Optional YYYY-MM-DD start date.'))
        .addStringOption((o) =>
          o.setName('end_date').setDescription('Optional YYYY-MM-DD end date.'))
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
        .addStringOption((o) =>
          o.setName('name').setDescription('Character name.').setRequired(true))
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
        .addStringOption((o) =>
          o.setName('reason').setDescription('Optional reason.'))
        .addChannelOption((o) =>
          o.setName('location').setDescription('Optional detention/ISS channel.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('End a character discipline restriction early.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Character name.').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('check')
        .setDescription('Check current discipline status.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Character name.').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('calendar')
    .setDescription('Manage school calendar awareness.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a school event.')
        .addStringOption((o) =>
          o.setName('name').setDescription('Event name.').setRequired(true))
        .addStringOption((o) =>
          o.setName('type').setDescription('Example: spirit_week, break, field_trip.').setRequired(true))
        .addStringOption((o) =>
          o.setName('start_date').setDescription('YYYY-MM-DD').setRequired(true))
        .addBooleanOption((o) =>
          o.setName('school_closed').setDescription('Is school closed during this event?').setRequired(true))
        .addStringOption((o) =>
          o.setName('end_date').setDescription('Optional YYYY-MM-DD'))
        .addStringOption((o) =>
          o.setName('description').setDescription('Optional details.'))
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
