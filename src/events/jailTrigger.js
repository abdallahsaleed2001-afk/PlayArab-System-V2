import { Events } from 'discord.js';
import { getCustomTriggers, handleCustomTrigger, TRIGGER_ACTIONS } from '../services/customTriggerService.js';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (!message.guild || message.author.bot) return;
    const content = String(message.content || '').trim().toLowerCase();
    if (!content) return;

    const triggers = await getCustomTriggers(client, message.guild.id);
    const memberTargetActions = [
      TRIGGER_ACTIONS.ADD_MEMBER,
      TRIGGER_ACTIONS.ADD_ROLE,
      TRIGGER_ACTIONS.REMOVE_ROLE,
      TRIGGER_ACTIONS.DYNAMIC_ROLE,
      TRIGGER_ACTIONS.REMOVE_DYNAMIC_ROLE,
      TRIGGER_ACTIONS.BAN,
      TRIGGER_ACTIONS.KICK,
      TRIGGER_ACTIONS.WARN,
      TRIGGER_ACTIONS.MUTE,
      TRIGGER_ACTIONS.UNMUTE,
      TRIGGER_ACTIONS.TIMEOUT,
      TRIGGER_ACTIONS.UNTIMEOUT,
      TRIGGER_ACTIONS.JAIL,
      TRIGGER_ACTIONS.UNJAIL,
      TRIGGER_ACTIONS.CHANGE_NICKNAME
    ];

    const match = triggers.find((item) => {
      const trigger = String(item?.trigger || '').trim().toLowerCase();
      if (!trigger) return false;
      const isPrefixTrigger = [
        TRIGGER_ACTIONS.ADD_MEMBER,
        TRIGGER_ACTIONS.ADD_ROLE,
        TRIGGER_ACTIONS.REMOVE_ROLE,
        TRIGGER_ACTIONS.BAN,
        TRIGGER_ACTIONS.KICK,
        TRIGGER_ACTIONS.WARN,
        TRIGGER_ACTIONS.MUTE,
        TRIGGER_ACTIONS.UNMUTE,
        TRIGGER_ACTIONS.TIMEOUT,
        TRIGGER_ACTIONS.UNTIMEOUT,
        TRIGGER_ACTIONS.JAIL,
        TRIGGER_ACTIONS.UNJAIL,
        TRIGGER_ACTIONS.DYNAMIC_ROLE,
        TRIGGER_ACTIONS.REMOVE_DYNAMIC_ROLE,
        TRIGGER_ACTIONS.CHANGE_NICKNAME,
        TRIGGER_ACTIONS.CHANGE_CHANNEL_NAME
      ].includes(item?.action);
      return isPrefixTrigger
        ? (content === trigger || content.startsWith(`${trigger} `))
        : content === trigger;
    });

    if (match) await handleCustomTrigger(message, client);
  }
};
