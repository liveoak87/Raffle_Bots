const { SlashCommandBuilder } = require('discord.js');

const randomizerCommand = new SlashCommandBuilder()
  .setName('randomizer')
  .setDescription('Manage number board randomizers')
  .addSubcommand(sub =>
    sub.setName('create')
      .setDescription('Create a new randomizer board (opens setup wizard)'))
  .addSubcommand(sub =>
    sub.setName('draw')
      .setDescription('Draw a random winner from the active board'))
  .addSubcommand(sub =>
    sub.setName('cancel')
      .setDescription('Cancel the active randomizer'))
  .addSubcommand(sub =>
    sub.setName('settings')
      .setDescription('View current randomizer settings'))
  .addSubcommand(sub =>
    sub.setName('mark-donated')
      .setDescription('Mark numbers as donated')
      .addStringOption(opt =>
        opt.setName('numbers')
          .setDescription('Number(s) to mark donated — e.g. "5" or "3,7,12"')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('View all servers and active raffles (owner only)'));

const pickCommand = new SlashCommandBuilder()
  .setName('pick')
  .setDescription('Pick number(s) on the active board')
  .addStringOption(opt =>
    opt.setName('numbers')
      .setDescription('Number(s) to pick — e.g. "5" or "3,7,12"')
      .setRequired(true));

const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Learn how to use Ultimate Randomizer');

module.exports = { randomizerCommand, pickCommand, helpCommand };
