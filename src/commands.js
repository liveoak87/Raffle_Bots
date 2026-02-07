const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const raffleCommand = new SlashCommandBuilder()
  .setName('raffle')
  .setDescription('Manage raffles')
  .addSubcommand(sub =>
    sub.setName('create')
      .setDescription('Create a new raffle board')
      .addStringOption(opt =>
        opt.setName('prize')
          .setDescription('Prize description')
          .setRequired(true))
      .addIntegerOption(opt =>
        opt.setName('slots')
          .setDescription('Number of slots on the board (2-25)')
          .setRequired(true)
          .setMinValue(2)
          .setMaxValue(25))
      .addStringOption(opt =>
        opt.setName('price')
          .setDescription('Price per line (e.g. "$12")')
          .setRequired(false))
  )
  .addSubcommand(sub =>
    sub.setName('draw')
      .setDescription('Randomly draw a winning number'))
  .addSubcommand(sub =>
    sub.setName('cancel')
      .setDescription('Cancel the active raffle'))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const pickCommand = new SlashCommandBuilder()
  .setName('pick')
  .setDescription('Pick number(s) on the active raffle')
  .addStringOption(opt =>
    opt.setName('numbers')
      .setDescription('Number(s) to pick — e.g. "5" or "3,7,12"')
      .setRequired(true));

module.exports = { raffleCommand, pickCommand };
