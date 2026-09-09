import { Events } from 'discord.js';
import { getCustomTriggers, handleCustomTrigger, TRIGGER_ACTIONS } from '../services/customTriggerService.js';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot) return;
    const content = String(message.content || '').trim().toLowerCase();
    if (!content) return;
    const triggers = await getCustomTriggers(client, message.guild.id);
    const match = triggers.find((item) => [TRIGGER_ACTIONS.JAIL, TRIGGER_ACTIONS.UNJAIL].includes(item?.action) && (() => { const trigger = String(item?.trigger || '').trim().toLowerCase(); return trigger && (content === trigger || content.startsWith(`${trigger} `)); })());
    if (match) await handleCustomTrigger(message, client);
  }
};
