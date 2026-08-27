import { loadEnv } from '../env';
import { registerCommands } from './registerCommands';

const env = loadEnv();

registerCommands(env.DISCORD_APPLICATION_ID, env.DISCORD_BOT_TOKEN)
  .then(() => {
    console.log('Slash commands registered.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
