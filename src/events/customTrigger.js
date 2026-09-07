import { Events, PermissionFlagsBits } from 'discord.js';
import { handleCustomTrigger, getCustomTriggers } from '../services/customTriggerService.js';

const SEND_MESSAGE_ACTION = 'send_message';
const SEND_MESSAGE_PREFIX = '__send_message__:';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild || message.author.bot) return;
      const triggers = await getCustomTriggers(client, message.guild.id);
      const content = String(message.content || '').trim().toLocaleLowerCase();
      const trigger = triggers.find(item => item.action === SEND_MESSAGE_ACTION && String(item.trigger || '').trim().toLocaleLowerCase() === content);
      if (trigger && String(trigger.roleId || '').startsWith(SEND_MESSAGE_PREFIX)) {
        const [, channelId, encodedMessage] = String(trigger.roleId).split(':');
        const channel = message.guild.channels.cache.get(channelId) || await message.guild.channels.fetch(channelId).catch(() => null);
        if (channel?.isTextBased() && channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
          const text = Buffer.from(encodedMessage || '', 'base64').toString('utf8');
          if (text) await channel.send({ content: text });
        }
        return;
      }
      await handleCustomTrigger(message, client);
    } catch {
      // The trigger service handles and logs its own execution errors.
    }
  },
};
