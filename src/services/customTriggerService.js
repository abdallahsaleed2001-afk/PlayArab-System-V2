import { PermissionFlagsBits } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';
import { WarningService, applyWarningEscalation } from './moderation/warningService.js';
import { logModerationAction } from '../utils/moderation.js';
import { sendPunishmentDM } from './moderation/punishmentDM.js';

const MAX_TRIGGERS = 100;
const MAX_TRIGGER_LENGTH = 100;
const cooldowns = new Map();
const TARGET_ROLE_ID = '1531659519761973472';
const MUTE_ROLE_ID = '1544023085051543714';
const STAFF_ROLE_ID = '1531745937280602282';
const JAIL_ROLE_ID = '1543728134027874305';
const JAIL_STAFF_ROLE_ID = '1544001368065581178';

export const TRIGGER_ACTIONS = Object.freeze({
  LOCK: 'lock', UNLOCK: 'unlock', HIDE: 'hide', UNHIDE: 'unhide',
  ADD_ROLE: 'add_role', REMOVE_ROLE: 'remove_role', DYNAMIC_ROLE: 'dynamic_role',
  REMOVE_DYNAMIC_ROLE: 'remove_dynamic_role', ADD_MEMBER: 'add_member', CLEAR_MESSAGES: 'clear_messages',
  BAN: 'ban', KICK: 'kick', WARN: 'warn', MUTE: 'mute', UNMUTE: 'unmute',
  TIMEOUT: 'timeout', UNTIMEOUT: 'untimeout', JAIL: 'jail', UNJAIL: 'unjail',
  CHANGE_NICKNAME: 'change_nickname', CHANGE_CHANNEL_NAME: 'change_channel_name'
});

export async function getCustomTriggers(client, guildId) {
  const config = await getGuildConfig(client, guildId);
  return Array.isArray(config.customTriggers) ? config.customTriggers : [];
}

export async function addCustomTrigger(client, guildId, trigger, action, roleId = null) {
  const normalizedTrigger = normalizeTrigger(trigger);
  if (!normalizedTrigger) throw new Error('Trigger cannot be empty.');
  if (normalizedTrigger.length > MAX_TRIGGER_LENGTH) throw new Error(`Trigger cannot exceed ${MAX_TRIGGER_LENGTH} characters.`);
  if (!Object.values(TRIGGER_ACTIONS).includes(action)) throw new Error('Invalid trigger action.');
  if ([TRIGGER_ACTIONS.ADD_ROLE, TRIGGER_ACTIONS.REMOVE_ROLE].includes(action) && !roleId) throw new Error('A role is required for this action.');

  const triggers = await getCustomTriggers(client, guildId);
  const existing = triggers.findIndex(item => normalizeTrigger(item.trigger) === normalizedTrigger);
  const normalizedRoleId = normalizeRoleId(roleId);
  const entry = { trigger: normalizedTrigger, action, roleId: [TRIGGER_ACTIONS.JAIL, TRIGGER_ACTIONS.UNJAIL].includes(action) ? JAIL_STAFF_ROLE_ID : (normalizedRoleId || null) };
  if (existing >= 0) triggers[existing] = entry;
  else {
    if (triggers.length >= MAX_TRIGGERS) throw new Error(`A server can have up to ${MAX_TRIGGERS} custom triggers.`);
    triggers.push(entry);
  }
  await updateGuildConfig(client, guildId, { customTriggers: triggers });
  return entry;
}

export async function removeCustomTrigger(client, guildId, trigger) {
  const normalizedTrigger = normalizeTrigger(trigger);
  const triggers = await getCustomTriggers(client, guildId);
  const next = triggers.filter(item => normalizeTrigger(item.trigger) !== normalizedTrigger);
  if (next.length === triggers.length) return false;
  await updateGuildConfig(client, guildId, { customTriggers: next });
  return true;
}

async function reactSuccess(message) {
  for (const delay of [0, 250, 750]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await message.react('✅');
      return true;
    } catch (error) {
      if (delay === 750) logger.warn('Custom trigger succeeded but success reaction failed:', { error: error.message, guildId: message.guild?.id, messageId: message.id });
    }
  }
  return false;
}

export async function handleCustomTrigger(message, client) {
  if (!message.guild || message.author.bot) return false;
  const content = normalizeTrigger(message.content);
  if (!content) return false;

  const triggers = await getCustomTriggers(client, message.guild.id);
  const prefixActions = [
    TRIGGER_ACTIONS.ADD_MEMBER, TRIGGER_ACTIONS.CLEAR_MESSAGES, TRIGGER_ACTIONS.BAN, TRIGGER_ACTIONS.KICK,
    TRIGGER_ACTIONS.WARN, TRIGGER_ACTIONS.MUTE, TRIGGER_ACTIONS.UNMUTE, TRIGGER_ACTIONS.TIMEOUT,
    TRIGGER_ACTIONS.UNTIMEOUT, TRIGGER_ACTIONS.JAIL, TRIGGER_ACTIONS.UNJAIL, TRIGGER_ACTIONS.DYNAMIC_ROLE,
    TRIGGER_ACTIONS.REMOVE_DYNAMIC_ROLE, TRIGGER_ACTIONS.CHANGE_NICKNAME, TRIGGER_ACTIONS.CHANGE_CHANNEL_NAME,
    TRIGGER_ACTIONS.ADD_ROLE, TRIGGER_ACTIONS.REMOVE_ROLE
  ];
  const trigger = triggers.find(item => prefixActions.includes(item.action)
    ? (content === normalizeTrigger(item.trigger) || content.startsWith(`${normalizeTrigger(item.trigger)} `))
    : normalizeTrigger(item.trigger) === content);
  if (!trigger) return false;

  const cooldownKey = `${message.guild.id}:${message.author.id}:${trigger.trigger}`;
  if ((cooldowns.get(cooldownKey) || 0) > Date.now()) return true;
  cooldowns.set(cooldownKey, Date.now() + 1500);

  try {
    const channelActions = [TRIGGER_ACTIONS.LOCK, TRIGGER_ACTIONS.UNLOCK, TRIGGER_ACTIONS.HIDE, TRIGGER_ACTIONS.UNHIDE];
    if (channelActions.includes(trigger.action) && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return false;
    if (trigger.action === TRIGGER_ACTIONS.CHANGE_CHANNEL_NAME && !message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return false;
    if (trigger.action === TRIGGER_ACTIONS.CHANGE_NICKNAME && !message.member.permissions.has(PermissionFlagsBits.ManageNicknames)) return false;
    if (trigger.action === TRIGGER_ACTIONS.CLEAR_MESSAGES && !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;
    if ([TRIGGER_ACTIONS.ADD_ROLE, TRIGGER_ACTIONS.REMOVE_ROLE, TRIGGER_ACTIONS.DYNAMIC_ROLE, TRIGGER_ACTIONS.REMOVE_DYNAMIC_ROLE].includes(trigger.action) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return false;
    if ([TRIGGER_ACTIONS.WARN, TRIGGER_ACTIONS.MUTE, TRIGGER_ACTIONS.UNMUTE, TRIGGER_ACTIONS.TIMEOUT, TRIGGER_ACTIONS.UNTIMEOUT].includes(trigger.action) && !message.member.roles.cache.has(STAFF_ROLE_ID)) return false;
    if ([TRIGGER_ACTIONS.JAIL, TRIGGER_ACTIONS.UNJAIL].includes(trigger.action) && !message.member.roles.cache.has(JAIL_STAFF_ROLE_ID)) return false;

    if (trigger.action === TRIGGER_ACTIONS.ADD_MEMBER) {
      if (!await addMemberToCurrentChannel(message, trigger)) return false;
    } else if (trigger.action === TRIGGER_ACTIONS.CLEAR_MESSAGES) {
      if (!await clearMessages(message, trigger)) return false;
    } else if (trigger.action === TRIGGER_ACTIONS.CHANGE_NICKNAME) {
      if (!await changeNickname(message, trigger)) return false;
    } else if (trigger.action === TRIGGER_ACTIONS.CHANGE_CHANNEL_NAME) {
      if (!await changeChannelName(message, trigger)) return false;
    } else if (channelActions.includes(trigger.action)) {
      const targetRole = message.guild.roles.cache.get(TARGET_ROLE_ID) || await message.guild.roles.fetch(TARGET_ROLE_ID).catch(() => null);
      if (!targetRole) return false;
      const reason = `Custom trigger \"${trigger.trigger}\" used by ${message.author.tag}`;
      if (trigger.action === TRIGGER_ACTIONS.LOCK) await message.channel.permissionOverwrites.edit(targetRole, { SendMessages: false }, { reason });
      else if (trigger.action === TRIGGER_ACTIONS.UNLOCK) await message.channel.permissionOverwrites.edit(targetRole, { SendMessages: true }, { reason });
      else if (trigger.action === TRIGGER_ACTIONS.HIDE) await message.channel.permissionOverwrites.edit(targetRole, { ViewChannel: false }, { reason });
      else await message.channel.permissionOverwrites.edit(targetRole, { ViewChannel: true }, { reason });
    } else if ([TRIGGER_ACTIONS.ADD_ROLE, TRIGGER_ACTIONS.REMOVE_ROLE].includes(trigger.action)) {
      if (!await changeFixedRole(message, trigger, trigger.action === TRIGGER_ACTIONS.REMOVE_ROLE)) return false;
    } else if ([TRIGGER_ACTIONS.DYNAMIC_ROLE, TRIGGER_ACTIONS.REMOVE_DYNAMIC_ROLE].includes(trigger.action)) {
      if (!await changeMentionedRole(message, trigger, trigger.action === TRIGGER_ACTIONS.REMOVE_DYNAMIC_ROLE)) return false;
    } else if (!await executeModerationTrigger(message, trigger.action, trigger)) return false;

    await reactSuccess(message);
    return true;
  } catch (error) {
    logger.error('Custom trigger execution failed', {
      event: 'custom_trigger.execution_failed',
      guildId: message.guild?.id,
      userId: message.author?.id,
      trigger: trigger.trigger,
      action: trigger.action,
      error: error?.message || String(error),
    });
    return false;
  }
}

async function changeNickname(message, trigger) {
  const targetMember = await resolveTargetMember(message);
  const rawContent = String(message.content).trim();
  const triggerText = normalizeTrigger(trigger.trigger);
  const remainder = rawContent.slice(triggerText.length).trim();
  const targetMatch = remainder.match(/^<@!?(\d{17,20})>|^(\d{17,20})/);
  const nickname = remainder.replace(/^<@!?\d{17,20}>\s*/, '').replace(/^\d{17,20}\s*/, '').trim();
  if (!targetMember || !nickname || nickname.length > 32) return false;
  const botMember = message.guild.members.me;
  if (!botMember || targetMember.id === message.guild.ownerId || targetMember.id === botMember.id || targetMember.roles.highest.position >= botMember.roles.highest.position || !targetMember.manageable) return false;
  if (!targetMatch && !message.mentions.users.first() && !message.reference?.messageId) return false;
  await targetMember.setNickname(nickname, `Custom trigger \"${trigger.trigger}\" used by ${message.author.tag}`);
  return true;
}

async function changeChannelName(message, trigger) {
  const rawContent = String(message.content).trim();
  const triggerText = normalizeTrigger(trigger.trigger);
  const remainder = rawContent.slice(triggerText.length).trim();
  const channelMention = remainder.match(/^<#(\d{17,20})>/);
  const channelId = channelMention?.[1] || remainder.match(/^(\d{17,20})/)?.[1];
  const name = remainder.replace(/^<#\d{17,20}>\s*/, '').replace(/^\d{17,20}\s*/, '').trim();
  const channel = channelId ? message.guild.channels.cache.get(channelId) || await message.guild.channels.fetch(channelId).catch(() => null) : message.channel;
  if (!channel || !name || name.length > 100 || !channel.manageable) return false;
  await channel.setName(name, `Custom trigger \"${trigger.trigger}\" used by ${message.author.tag}`);
  return true;
}

async function clearMessages(message, trigger) {
  const raw = String(message.content).trim();
  const prefix = normalizeTrigger(trigger.trigger);
  const match = raw.slice(prefix.length).trim().match(/^(\d{1,3})$/);
  if (!match) return false;
  const count = Number(match[1]);
  if (count < 1 || count > 100) return false;
  const botMember = message.guild.members.me;
  if (!botMember || !message.channel.permissionsFor(botMember).has(PermissionFlagsBits.ManageMessages)) return false;
  const deleted = await message.channel.bulkDelete(count, true).catch(() => null);
  if (!deleted) return false;
  await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Messages Cleared', target: `${deleted.size} messages`, executor: `${message.author.tag} (${message.author.id})`, reason: `Trigger: ${trigger.trigger}`, metadata: { moderatorId: message.author.id, requestedCount: count, deletedCount: deleted.size, channelId: message.channel.id } } });
  return true;
}

async function changeFixedRole(message, trigger, remove = false) {
  const roleId = normalizeRoleId(trigger.roleId);
  const role = message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null);
  const botMember = message.guild.members.me;
  const targetMember = await resolveTargetMember(message, trigger);
  if (!role || !botMember || !targetMember || role.managed || role.position >= botMember.roles.highest.position) return false;
  if (targetMember.id === message.guild.ownerId || targetMember.id === botMember.id || targetMember.roles.highest.position >= botMember.roles.highest.position) return false;
  if (remove) {
    if (!targetMember.roles.cache.has(role.id)) return false;
    await targetMember.roles.remove(role, `Custom trigger \"${trigger.trigger}\"`);
  } else {
    if (targetMember.roles.cache.has(role.id)) return false;
    await targetMember.roles.add(role, `Custom trigger \"${trigger.trigger}\"`);
  }
  await logModerationAction({ client: message.client, guild: message.guild, event: { action: remove ? 'Role Removed' : 'Role Added', target: `${targetMember.user.tag} (${targetMember.id})`, executor: `${message.author.tag} (${message.author.id})`, reason: `Trigger: ${trigger.trigger}`, metadata: { userId: targetMember.id, moderatorId: message.author.id, roleId: role.id } } });
  return true;
}

async function changeMentionedRole(message, trigger, remove = false) {
  const targetMember = await resolveTargetMember(message, trigger);
  const roleMention = message.mentions.roles.first();
  const rawContent = String(message.content).trim();
  const triggerText = normalizeTrigger(trigger.trigger);
  const remainder = rawContent.slice(triggerText.length).trim();
  const roleId = roleMention?.id || remainder.match(/(?:^|\s)(\d{17,20})(?:\s|$)/)?.[1];
  const role = roleMention || message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null);
  const botMember = message.guild.members.me;
  if (!targetMember || !role || !botMember || role.managed || role.position >= botMember.roles.highest.position) return false;
  if (targetMember.id === message.guild.ownerId || targetMember.id === botMember.id || targetMember.roles.highest.position >= botMember.roles.highest.position) return false;
  if (remove) {
    if (!targetMember.roles.cache.has(role.id)) return false;
    await targetMember.roles.remove(role, `Custom trigger \"${trigger.trigger}\"`);
  } else {
    if (targetMember.roles.cache.has(role.id)) return false;
    await targetMember.roles.add(role, `Custom trigger \"${trigger.trigger}\"`);
  }
  await logModerationAction({ client: message.client, guild: message.guild, event: { action: remove ? 'Role Removed' : 'Role Added', target: `${targetMember.user.tag} (${targetMember.id})`, executor: `${message.author.tag} (${message.author.id})`, reason: `Trigger: ${trigger.trigger}`, metadata: { userId: targetMember.id, moderatorId: message.author.id, roleId: role.id } } });
  return true;
}

async function addMemberToCurrentChannel(message, trigger) {
  if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return false;
  const member = await resolveTargetMember(message, trigger);
  const botMember = message.guild.members.me;
  if (!member || member.user.bot || !botMember || !message.channel.permissionsFor(botMember).has(PermissionFlagsBits.ManageChannels)) return false;
  await message.channel.permissionOverwrites.edit(member, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, { reason: `Custom trigger \"${trigger.trigger}\" used by ${message.author.tag}` });
  await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Added To Channel', target: `${member.user.tag} (${member.id})`, executor: `${message.author.tag} (${message.author.id})`, reason: `Trigger: ${trigger.trigger}`, metadata: { userId: member.id, moderatorId: message.author.id, channelId: message.channel.id } } });
  return true;
}

async function resolveTargetMember(message, trigger = null) {
  const reference = message.reference?.messageId ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null) : null;
  const mentionedId = message.mentions.users.first()?.id;
  const rawContent = String(message.content).trim();
  const mentionTargetId = rawContent.match(/<@!?(\d{17,20})>/)?.[1];
  const triggerText = trigger ? normalizeTrigger(trigger.trigger) : '';
  const remainder = triggerText && rawContent.toLowerCase().startsWith(triggerText)
    ? rawContent.slice(triggerText.length).trim()
    : rawContent;
  const targetMatch = remainder.match(/^(?:<@!?(\d{17,20})>|(\d{17,20}))(?:\s|$)/);
  const rawTargetId = targetMatch?.[1] || targetMatch?.[2] || rawContent.match(/(?:^|\s)(\d{17,20})(?:\s|$)/)?.[1];
  const targetId = mentionedId || mentionTargetId || rawTargetId || reference?.author?.id;
  if (!targetId || targetId === message.author.id || targetId === message.client.user.id) return null;
  return message.guild.members.cache.get(targetId) || await message.guild.members.fetch(targetId).catch(() => null);
}

async function executeModerationTrigger(message, action, trigger) {
  const member = await resolveTargetMember(message, trigger);
  if (!member) return false;
  const botMember = message.guild.members.me;
  if (!botMember || member.id === message.guild.ownerId || member.roles.highest.position >= botMember.roles.highest.position) return false;
  const reason = getTriggerReason(message, trigger);
  const executor = `${message.author.tag} (${message.author.id})`;
  const target = `${member.user.tag} (${member.id})`;

  if (action === TRIGGER_ACTIONS.JAIL || action === TRIGGER_ACTIONS.UNJAIL) {
    const jailRole = message.guild.roles.cache.get(JAIL_ROLE_ID) || await message.guild.roles.fetch(JAIL_ROLE_ID).catch(() => null);
    if (!jailRole || jailRole.managed || jailRole.position >= botMember.roles.highest.position) return false;
    if (action === TRIGGER_ACTIONS.JAIL) {
      if (member.roles.cache.has(jailRole.id)) return false;
      await member.roles.add(jailRole, reason);
      const caseId = await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Jailed', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id, roleId: jailRole.id } } });
      await sendPunishmentDM({ user: member.user, guild: message.guild, type: 'jail', reason, caseId });
    } else {
      if (!member.roles.cache.has(jailRole.id)) return false;
      await member.roles.remove(jailRole, reason);
      await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Unjailed', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id, roleId: jailRole.id } } });
    }
    return true;
  }

  if (action === TRIGGER_ACTIONS.BAN) {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers) || !member.bannable) return false;
    await member.ban({ reason });
    await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Banned', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id } } });
    return true;
  }

  if (action === TRIGGER_ACTIONS.KICK) {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers) || !member.kickable) return false;
    await member.kick(reason);
    await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Kicked', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id } } });
    return true;
  }

  if (action === TRIGGER_ACTIONS.WARN) {
    const { id, totalCount } = await WarningService.addWarning({ guildId: message.guild.id, userId: member.id, moderatorId: message.author.id, reason, timestamp: Date.now() });
    const caseId = await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'User Warned', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id, totalWarns: totalCount, warningNumber: totalCount, warningId: id } } });
    await WarningService.attachCaseId(message.guild.id, member.id, id, caseId);
    await sendPunishmentDM({ user: member.user, guild: message.guild, type: 'warn', reason, caseId });
    const escalation = await applyWarningEscalation({ guild: message.guild, member, moderator: message.member, warningCount: totalCount, reason, client });
    if (escalation.action === 'timeout') await sendPunishmentDM({ user: member.user, guild: message.guild, type: 'timeout', duration: '1 day', reason: `Warning #${totalCount} escalation: ${reason}`, caseId });
    return true;
  }

  if (action === TRIGGER_ACTIONS.TIMEOUT || action === TRIGGER_ACTIONS.UNTIMEOUT) {
    if (!member.moderatable) return false;
    if (action === TRIGGER_ACTIONS.TIMEOUT) {
      const durationMs = 10 * 60 * 1000;
      await member.timeout(durationMs, reason);
      const caseId = await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Timed Out', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id, durationMs } } });
      await sendPunishmentDM({ user: member.user, guild: message.guild, type: 'timeout', duration: '10 minutes', reason, caseId });
    } else {
      await member.timeout(null, reason);
      await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Untimed Out', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id } } });
    }
    return true;
  }

  if (action === TRIGGER_ACTIONS.MUTE || action === TRIGGER_ACTIONS.UNMUTE) {
    const muteRole = message.guild.roles.cache.get(MUTE_ROLE_ID) || await message.guild.roles.fetch(MUTE_ROLE_ID).catch(() => null);
    if (!muteRole || muteRole.managed || muteRole.position >= botMember.roles.highest.position) return false;
    if (action === TRIGGER_ACTIONS.MUTE) {
      if (member.roles.cache.has(muteRole.id)) return false;
      await member.roles.add(muteRole, reason);
      const caseId = await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Muted', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id, roleId: muteRole.id } } });
      await sendPunishmentDM({ user: member.user, guild: message.guild, type: 'mute', reason, duration: 'Permanent', caseId });
    } else {
      if (!member.roles.cache.has(muteRole.id)) return false;
      await member.roles.remove(muteRole, reason);
      await logModerationAction({ client: message.client, guild: message.guild, event: { action: 'Member Unmuted', target, executor, reason, metadata: { userId: member.id, moderatorId: message.author.id, roleId: muteRole.id } } });
    }
    return true;
  }
  return false;
}

function getTriggerReason(message, trigger) {
  return `Custom trigger \"${trigger.trigger}\" used by ${message.author.tag}`;
}

function normalizeTrigger(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function normalizeRoleId(value) {
  const raw = String(value ?? '').trim();
  return raw.match(/^<@&(\d{17,20})>$/)?.[1] || raw.match(/^(\d{17,20})$/)?.[1] || null;
}
