import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { getSecurityConfig, isWhitelisted, sendSecurityLog, addNukeEvent, getRecentNukeEvents, clearNukeEvents } from './securityService.js';
import { logger } from '../../utils/logger.js';

const lockdowns = new Map();
const EVENT_MAP = {
  channelDelete: AuditLogEvent.ChannelDelete,
  channelCreate: AuditLogEvent.ChannelCreate,
  roleDelete: AuditLogEvent.RoleDelete,
  roleCreate: AuditLogEvent.RoleCreate,
  roleUpdate: AuditLogEvent.RoleUpdate,
  webhookUpdate: [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookUpdate, AuditLogEvent.WebhookDelete],
  webhookDelete: AuditLogEvent.WebhookDelete,
  ban: AuditLogEvent.MemberBanAdd,
  kick: AuditLogEvent.MemberKick,
  botAdd: AuditLogEvent.BotAdd,
};

async function findAuditEntry(guild, auditType, targetId = null) {
  const types = Array.isArray(auditType) ? auditType : [auditType];
  const entries = [];
  for (const type of types) {
    const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
    if (!logs?.entries) continue;
    for (const entry of logs.entries.values()) {
      if (Date.now() - entry.createdTimestamp > 15000) continue;
      if (targetId && entry.target?.id !== targetId && entry.targetId !== targetId) continue;
      entries.push(entry);
    }
  }
  entries.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  return entries[0] || null;
}

async function stripDangerousRoles(member, reason) {
  if (!member.manageable) return false;
  const removable = member.roles.cache.filter(role => role.id !== member.guild.id && role.editable && role.permissions.any([
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles, PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageWebhooks,
  ]));
  if (!removable.size) return false;
  await member.roles.remove(removable, `Anti-Nuke: ${reason}`).catch(() => {});
  return true;
}

async function startLockdown(guild, config) {
  if (lockdowns.has(guild.id)) return;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return;
  const lockdownMs = Math.max(1000, config.antiNuke.lockdownMs || 10 * 60 * 1000);
  const channels = new Map();
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites?.edit || channel.isThread?.()) continue;
    const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    channels.set(channel.id, overwrite?.deny?.has(PermissionFlagsBits.SendMessages) ? false : overwrite?.allow?.has(PermissionFlagsBits.SendMessages) ? true : null);
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: 'Anti-Nuke emergency lockdown' }).catch(() => {});
  }
  const state = { channels, expiresAt: Date.now() + lockdownMs };
  lockdowns.set(guild.id, state);
  const timer = setTimeout(async () => {
    if (lockdowns.get(guild.id) !== state) return;
    lockdowns.delete(guild.id);
    for (const [channelId, previous] of state.channels) {
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.permissionOverwrites?.edit) continue;
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: previous }, { reason: 'Anti-Nuke emergency lockdown ended' }).catch(() => {});
    }
    await sendSecurityLog(guild.client, guild, { title: 'Anti-Nuke Lockdown Ended', description: 'The temporary nuke lockdown has ended and previous channel permissions were restored.', color: 0x57F287 });
  }, lockdownMs);
  timer.unref?.();
}

async function punishExecutor(guild, executor, config, type, reason, targetId) {
  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (!member || member.id === guild.ownerId || isWhitelisted(member, config)) return false;
  const action = config.antiNuke.punishments?.[type] || config.antiNuke.action || 'strip';
  let actionTaken = action;
  if (action === 'ban' && member.bannable) await member.ban({ reason: `Anti-Nuke: ${reason}` }).catch(() => {});
  else if (action === 'kick' && member.kickable) await member.kick(`Anti-Nuke: ${reason}`).catch(() => {});
  else if (action === 'timeout' && member.moderatable) await member.timeout(10 * 60 * 1000, `Anti-Nuke: ${reason}`).catch(() => {});
  else if (action === 'strip') { const stripped = await stripDangerousRoles(member, reason); actionTaken = stripped ? 'strip' : 'none'; }
  if (type === 'botAdd' && targetId) {
    const bot = await guild.members.fetch(targetId).catch(() => null);
    if (bot?.user?.bot && bot.kickable && bot.id !== guild.client.user?.id) await bot.kick('Anti-Nuke: unauthorized bot addition').catch(() => {});
  }
  if (config.antiNuke.lockdown) await startLockdown(guild, config);
  await sendSecurityLog(guild.client, guild, { title: 'Anti-Nuke Triggered', description: `**${executor.tag || executor.username}** triggered Anti-Nuke protection.`, fields: [
    { name: 'Operation', value: type, inline: true }, { name: 'Reason', value: reason.slice(0, 1024), inline: true },
    { name: 'Action', value: actionTaken, inline: true }, { name: 'Executor', value: executor.id, inline: true },
  ] });
  return true;
}

export async function handleAntiNuke(guild, type, targetId = null) {
  const config = await getSecurityConfig(guild.client, guild.id);
  if (!config.enabled || !config.antiNuke.enabled) return;
  const auditType = EVENT_MAP[type];
  const threshold = Number(config.antiNuke.thresholds?.[type] || 0);
  if (!auditType || threshold <= 0) return;
  const entry = await findAuditEntry(guild, auditType, type.startsWith('webhook') ? null : targetId);
  if (!entry || entry.executor?.id === guild.client.user?.id) return;
  const executor = entry.executor;
  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (!member || member.id === guild.ownerId || isWhitelisted(member, config)) return;

  let actualType = type;
  if (type === 'webhookUpdate') actualType = entry.action === AuditLogEvent.WebhookDelete ? 'webhookDelete' : 'webhookUpdate';
  const actualThreshold = Number(config.antiNuke.thresholds?.[actualType] || threshold);
  const now = Date.now();

  // DB-backed counters
  await addNukeEvent(guild.id, executor.id, actualType, now);
  const recent = await getRecentNukeEvents(guild.id, executor.id, actualType, config.antiNuke.windowMs);

  if (recent.length >= actualThreshold) {
    await punishExecutor(guild, executor, config, actualType, `${actualType} threshold exceeded (${recent.length}/${actualThreshold})`, targetId);
    await clearNukeEvents(guild.id, executor.id, actualType);
  }
}

export function registerAntiNukeEvent(eventName, type) {
  return { name: eventName, async execute(eventTarget) {
    const guild = eventTarget?.guild || eventTarget;
    const targetId = eventTarget?.id || null;
    if (!guild?.id) return;
    try { await handleAntiNuke(guild, type, targetId); }
    catch (error) { logger.error(`Anti-Nuke ${type} failed`, { error: error.message, guildId: guild.id }); }
  } };
}
