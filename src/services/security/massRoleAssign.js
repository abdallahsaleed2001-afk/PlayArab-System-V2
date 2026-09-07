import { PermissionFlagsBits, AuditLogEvent } from 'discord.js';
import { getSecurityConfig, isWhitelisted, sendSecurityLog, addMassRoleEvent, getRecentMassRoleEvents, clearMassRoleEvents } from './securityService.js';
import { logger } from '../../utils/logger.js';

const DANGEROUS_PERMISSIONS = new Set([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
]);

const lockdowns = new Map();

function hasDangerousPermission(role) {
  return role.permissions.any([...DANGEROUS_PERMISSIONS]);
}

async function stripDangerousRoles(member, reason) {
  if (!member.manageable) return false;
  const removable = member.roles.cache.filter(role =>
    role.id !== member.guild.id && role.editable && hasDangerousPermission(role)
  );
  if (!removable.size) return false;
  await member.roles.remove(removable, `Mass-Role: ${reason}`).catch(() => {});
  return true;
}

async function startLockdown(guild, config) {
  if (lockdowns.has(guild.id)) return;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return;
  const lockdownMs = Math.max(1000, config.massRoleAssign.lockdownMs || 10 * 60 * 1000);
  const state = { expiresAt: Date.now() + lockdownMs, channels: new Map() };
  for (const channel of guild.channels.cache.values()) {
    if (!channel.permissionOverwrites?.edit || channel.isThread?.()) continue;
    const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
    state.channels.set(channel.id, {
      sendMessages: overwrite?.deny?.has(PermissionFlagsBits.SendMessages) ? false
        : overwrite?.allow?.has(PermissionFlagsBits.SendMessages) ? true : null
    });
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason: 'Mass-Role emergency lockdown' }).catch(() => {});
  }
  lockdowns.set(guild.id, state);
  const timer = setTimeout(async () => {
    const current = lockdowns.get(guild.id);
    if (current !== state) return;
    lockdowns.delete(guild.id);
    for (const [channelId, previous] of state.channels) {
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.permissionOverwrites?.edit) continue;
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: previous }, { reason: 'Mass-Role lockdown ended' }).catch(() => {});
    }
    await sendSecurityLog(guild.client, guild, { title: 'Mass-Role Lockdown Ended', description: 'The mass-role assign lockdown has ended.', color: 0x57F287 });
  }, lockdownMs);
  timer.unref?.();
}

export async function handleMassRoleAssign(oldMember, newMember) {
  if (!newMember.guild) return;
  const guild = newMember.guild;
  const client = guild.client;
  const config = await getSecurityConfig(client, guild.id);
  if (!config.enabled || !config.massRoleAssign?.enabled) return;

  // Detect which roles were added
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const addedRoles = newMember.roles.cache.filter(r => !oldRoles.has(r.id));
  if (!addedRoles.size) return;

  // Check if any added role has dangerous permissions
  const dangerousAdded = addedRoles.filter(r => hasDangerousPermission(r));
  if (!dangerousAdded.size) return;

  // Find who assigned the role via audit log
  let executor = null;
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 }).catch(() => null);
    if (logs?.entries) {
      for (const entry of logs.entries.values()) {
        if (Date.now() - entry.createdTimestamp > 15000) continue;
        if (entry.target?.id === newMember.id) { executor = entry.executor; break; }
      }
    }
  } catch {}

  if (!executor || executor.id === client.user.id) return;
  if (executor.id === guild.ownerId) return;
  const executorMember = await guild.members.fetch(executor.id).catch(() => null);
  if (!executorMember || isWhitelisted(executorMember, config)) return;

  // Track via DB
  const now = Date.now();
  await addMassRoleEvent(guild.id, executor.id, now);
  const recent = await getRecentMassRoleEvents(guild.id, executor.id, config.massRoleAssign.windowMs);

  if (recent.length >= config.massRoleAssign.threshold) {
    const action = config.massRoleAssign.action || 'strip';
    let actionTaken = action;

    if (action === 'ban' && executorMember.bannable) {
      await executorMember.ban({ reason: `Mass-Role: assigned dangerous roles to ${recent.length} members` }).catch(() => {});
    } else if (action === 'kick' && executorMember.kickable) {
      await executorMember.kick(`Mass-Role: assigned dangerous roles to ${recent.length} members`).catch(() => {});
    } else if (action === 'timeout' && executorMember.moderatable) {
      await executorMember.timeout(10 * 60 * 1000, `Mass-Role: assigned dangerous roles to ${recent.length} members`).catch(() => {});
    } else if (action === 'strip') {
      const stripped = await stripDangerousRoles(executorMember, 'mass dangerous role assignment');
      actionTaken = stripped ? 'strip' : 'none';
    }

    await sendSecurityLog(client, guild, {
      title: 'Mass Role Assign Detected',
      description: `**${executor.tag || executor.username}** assigned dangerous roles to **${recent.length}** members.`,
      fields: [
        { name: 'Members Affected', value: String(recent.length), inline: true },
        { name: 'Threshold', value: String(config.massRoleAssign.threshold), inline: true },
        { name: 'Action', value: actionTaken, inline: true },
        { name: 'Executor', value: executor.id, inline: true },
      ],
    });

    await clearMassRoleEvents(guild.id, executor.id);

    if (config.massRoleAssign.lockdown) await startLockdown(guild, config);
  }
}

export async function clearMassRoleLockdown(guild) {
  const state = lockdowns.get(guild.id);
  if (!state) return false;
  lockdowns.delete(guild.id);
  for (const [channelId, previous] of state.channels) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.permissionOverwrites?.edit) continue;
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: previous }, { reason: 'Mass-Role lockdown ended' }).catch(() => {});
  }
  return true;
}

export function isMassRoleLockdownActive(guildId) {
  const state = lockdowns.get(guildId);
  return Boolean(state && state.expiresAt > Date.now());
}
