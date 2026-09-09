import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling/leveling.js';
import { addXp } from '../services/leveling/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { processAutoMod } from '../services/security/securityService.js';
import { getStaffData, incrementStaffActivity, recordTicketLog } from '../services/staffService.js';
import { handleGameMessage } from '../services/games/gameService.js';
import { getCountingGameConfig, saveCountingGameConfig, isValidCountingMessage, recordCorrectCount } from '../services/countingGameService.js';
import { getColorByNumber, isColorSelection, parseColorNumber } from '../services/colorService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;
const STAFF_CACHE_TTL_MS = 60 * 1000;
const staffCache = new Map();
const GAME_SYSTEM_COMMANDS = new Set(['العاب', 'احصائياتي', 'ايقاف', 'كت']);

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (!message.guild) return;
      if (message.author.bot) {
        await handleTicketClosedLog(message);
        return;
      }
      const gameHandled = await handleGameMessage(message, client);
      if (gameHandled) return;
      await trackStaffMessage(message);
      const autoReplied = await handleAutoReply(message, client);
      if (autoReplied) return;
      await handleAutoReaction(message, client);
      const colorHandled = await handleColorSelection(message, client);
      if (colorHandled) return;
      const autoModTriggered = await processAutoMod(message, client);
      if (autoModTriggered) return;
      logger.debug(`Message received from ${message.author.tag}: ${message.content}`);
      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) return;
      await handlePrefixCommand(message, client);
      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

async function handleAutoReply(message, client) {
  try {
    const content = String(message.content ?? '');
    if (!content) return false;
    const config = await getGuildConfig(client, message.guild.id);
    const rules = Array.isArray(config?.autoReplies) ? config.autoReplies : [];
    if (!rules.length) return false;
    const rule = rules.find((item) => String(item?.trigger ?? '') === content);
    if (!rule || !String(rule.response ?? '').trim()) return false;
    await message.channel.send({ content: String(rule.response).slice(0, 2000) });
    return true;
  } catch (error) {
    logger.error('Error handling auto reply:', error);
    return false;
  }
}

async function handleAutoReaction(message, client) {
  try {
    const config = await getGuildConfig(client, message.guild.id);
    const rawRooms = config?.autoReaction;
    const rooms = Array.isArray(rawRooms)
      ? rawRooms
      : (rawRooms?.enabled && rawRooms?.channelId && rawRooms?.reaction
        ? [{ slot: 1, enabled: true, channelId: rawRooms.channelId, reaction: rawRooms.reaction }]
        : []);

    const room = rooms.find((item) => item?.enabled === true && item?.channelId && item?.reaction && item.channelId === message.channel.id);
    if (!room) return false;
    await message.react(String(room.reaction));
    return true;
  } catch (error) {
    logger.error('Error handling auto reaction:', { error: error.message, guildId: message.guild?.id, channelId: message.channel?.id, messageId: message.id });
    return false;
  }
}

async function handleColorSelection(message, client) {
  try {
    if (!isColorSelection(message.content)) return false;
    const number = parseColorNumber(message.content);
    if (!number || number < 1 || number > 100) return false;
    const color = await getColorByNumber(client, message.guild.id, number);
    if (!color) return false;
    const config = await client.db.get(`colors:${message.guild.id}`, null);
    if (message.channel.id !== config?.channelId) return false;
    const roleId = config?.roleIds?.[number - 1];
    if (!roleId) return false;
    const member = message.member || await message.guild.members.fetch(message.author.id);
    const role = message.guild.roles.cache.get(roleId) || await message.guild.roles.fetch(roleId).catch(() => null);
    if (!role) return false;
    const colorRoleIds = new Set(config.roleIds || []);
    const oldRoles = member.roles.cache.filter((item) => colorRoleIds.has(item.id));
    if (oldRoles.size) await member.roles.remove([...oldRoles.values()], 'Color selection').catch(() => {});
    await member.roles.add(role, 'Color selection');
    const reply = await message.channel.send(`🎨 ${message.author} تم تغيير لونك إلى **${color.hex}** — اللون رقم **${number}**.`);
    setTimeout(() => reply.delete().catch(() => {}), 7000);
    await message.delete().catch(() => {});
    return true;
  } catch (error) {
    logger.error('Error handling color selection:', error);
    return false;
  }
}

async function trackStaffMessage(message) {
  try {
    const now = Date.now();
    let cached = staffCache.get(message.guild.id);
    if (!cached || now - cached.updatedAt >= STAFF_CACHE_TTL_MS) {
      const data = await getStaffData(message.guild.id);
      cached = { updatedAt: now, staffIds: new Set(Object.keys(data.members || {})) };
      staffCache.set(message.guild.id, cached);
    }
    if (!cached.staffIds.has(message.author.id)) return;
    await incrementStaffActivity(message.guild.id, message.author.id, 'messages');
  } catch (error) {
    logger.error('Error tracking staff message activity:', error);
  }
}

async function handleTicketClosedLog(message) {
  try {
    if (!message.embeds?.length) return;
    const embed = message.embeds.find((item) => item.title?.trim() === 'تم إغلاق تذكرة');
    if (!embed) return;
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    const getField = (...names) => fields.find((item) => names.includes(String(item.name || '').trim()))?.value?.trim() || null;
    const channelName = getField('اسم القناة');
    const claimedBy = getField('مستلم التذكرة');
    const closedBy = getField('تم الإغلاق بواسطة');
    if (!channelName || !claimedBy || /لم\s*يتم\s*استلامها/i.test(claimedBy)) return;
    const mentionMatch = claimedBy.match(/<@!?([0-9]{15,25})>/);
    const idMatch = claimedBy.match(/\b([0-9]{15,25})\b/);
    const staffId = mentionMatch?.[1] || idMatch?.[1];
    if (!staffId) return;
    const ticketType = channelName.split('-')[0] || null;
    const result = await recordTicketLog(message.guild.id, { messageId: message.id, staffId, ticketId: channelName, ticketType, closedBy, closedAt: embed.timestamp || message.createdAt?.toISOString() || null });
    if (result.recorded) logger.info(`Ticket handled recorded for staff ${staffId}: ${channelName}`);
  } catch (error) {
    logger.error('Error processing ticket closed log:', error);
  }
}

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const configuredPrefix = guildConfig?.prefix || getCommandPrefix();
    const gameParsed = parsePrefixCommand(message.content, '-');
    const normalParsed = parsePrefixCommand(message.content, configuredPrefix);
    const gameCommandName = gameParsed?.commandName?.trim();
    const normalCommandName = normalParsed?.commandName?.trim();
    const isGameSystemMessage = Boolean(gameParsed && GAME_SYSTEM_COMMANDS.has(gameCommandName));
    if (!isGameSystemMessage && normalParsed && GAME_SYSTEM_COMMANDS.has(normalCommandName)) return;
    const parsed = isGameSystemMessage ? gameParsed : normalParsed;
    if (!parsed) return;
    let { commandName, args } = parsed;
    const prefix = isGameSystemMessage ? '-' : configuredPrefix;
    const musicPrefixShortcut = commandName.toLowerCase();
    const MUSIC_PREFIX_SHORTCUTS = new Set(['leave', 'pause', 'resume', 'skip', 'stop', 'volume']);
    if (MUSIC_PREFIX_SHORTCUTS.has(musicPrefixShortcut)) { commandName = 'music'; args = [musicPrefixShortcut, ...args]; }
    logger.info(`Prefix command detected: ${commandName}, args: ${args.join(', ')}`);
    const resolvedCommandName = resolveCommandAlias(commandName);
    const command = client.commands.get(resolvedCommandName);
    if (!command) return;
    if (isMaintenanceMode() && !isBotOwner(message.author.id)) { await message.channel.send({ embeds: [createEmbed({ title: 'Maintenance Mode', description: getBotMessage('maintenanceMode'), color: 'warning' })] }).catch(() => {}); return; }
    if (!isCommandCategoryEnabled(command.category)) { await message.channel.send({ embeds: [createEmbed({ title: 'Feature Disabled', description: getBotMessage('commandDisabled'), color: 'error' })] }).catch(() => {}); return; }
    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) { if (restriction.blocked && restriction.reason) await message.channel.send({ embeds: [createEmbed({ title: 'Slash Command Only', description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`, color: 'info' })] }).catch(() => {}); return; }
    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) { await message.channel.send({ embeds: [createEmbed({ title: 'Command Disabled', description: 'This command has been disabled for this server.', color: 'error' })] }).catch(() => {}); return; }
    const abuseProtection = await enforceAbuseProtection({ guildId: message.guild.id, user: message.author }, command, resolvedCommandName);
    if (!abuseProtection.allowed) { const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs); await message.channel.send({ embeds: [createEmbed({ title: 'Command Cooldown', description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`, color: 'error' })] }).catch(() => {}); return; }
    await executePrefixCommand(command, message, args, client, prefix, guildConfig);
  } catch (error) { logger.error('Error handling prefix command:', error); }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) return false;
    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;
    if (invalidAttempt) { await message.delete().catch(() => {}); await saveCountingGameConfig(client, message.guild.id, { ...config, nextNumber: 1, lastUserId: null, currentStreak: 0 }); const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`); setTimeout(() => failureMessage.delete().catch(() => {}), 10000); return true; }
    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) { logger.error('Error handling counting game:', error); return false; }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) return;
    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    if (!levelingConfig?.enabled || levelingConfig.ignoredChannels?.includes(message.channel.id)) return;
    if (levelingConfig.ignoredRoles?.length > 0) { const member = await message.guild.members.fetch(message.author.id).catch(() => null); if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) return; }
    if (levelingConfig.blacklistedUsers?.includes(message.author.id) || !message.content?.trim()) return;
    const userData = await getUserLevelData(client, message.guild.id, message.author.id);
    const cooldownTime = levelingConfig.xpCooldown || 60;
    if (Date.now() - (userData.lastMessage || 0) < cooldownTime * 1000) return;
    const minXP = Math.max(1, levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15);
    const maxXP = Math.max(minXP, levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25);
    const xpToGive = Math.floor(Math.random() * (maxXP - minXP + 1)) + minXP;
    const finalXP = levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1 ? Math.floor(xpToGive * levelingConfig.xpMultiplier) : xpToGive;
    const result = await addXp(client, message.guild, message.member, finalXP);
    if (result?.leveledUp) logger.info(`${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`);
  } catch (error) { logger.error('Error handling leveling for message:', error); }
}
