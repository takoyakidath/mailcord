import { REST, Routes } from 'discord.js';
import { mailCommand, reportSpamCommand } from './commands/definitions';

export async function registerCommands(applicationId: string, token: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(applicationId), {
    body: [mailCommand.toJSON(), reportSpamCommand.toJSON()],
  });
}
