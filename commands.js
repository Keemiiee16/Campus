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
        .setDescription('Open the teacher creation form.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Open the teacher edit form.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Open the teacher status form.')
    )
    .addSubcommand((sub) =>
      sub
        .setName('automation')
        .setDescription('Open the teacher automation form.')
    ),

  new SlashCommandBuilder()
    .setName('finals')
    .setDescription('Manage Finals Mode.')
    .setDefaultMemberPermissions(admin)
    .addSubcommand((sub) =>
      sub.setName('on').setDescription('Open the Finals Mode setup form.'))
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
        .setDescription('Open the discipline form.')
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
        .setDescription('Open the school calendar event form.')
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
