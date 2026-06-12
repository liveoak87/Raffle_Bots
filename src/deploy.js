require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { randomizerCommand, pickCommand, helpCommand } = require('./commands');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: [randomizerCommand.toJSON(), pickCommand.toJSON(), helpCommand.toJSON()] }
    );
    console.log('Commands registered successfully.');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();
