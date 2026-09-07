import { MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { TitanBotError, ErrorTypes, handleInteractionError } from '../utils/errorHandler.js';
import { getGuildGiveaways } from '../utils/giveaways.js';

export const giveawayParticipantsHandler = {
    customId: 'giveaway_participants',
    async execute(interaction, client) {
        try {
            if (!interaction.inGuild()) {
                throw new TitanBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
            const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

            if (!giveaway) {
                throw new TitanBotError(
                    'Giveaway not found in database',
                    ErrorTypes.VALIDATION,
                    'This giveaway could not be found.',
                    { messageId: interaction.message.id, guildId: interaction.guildId }
                );
            }

            const participants = Array.isArray(giveaway.participants) ? giveaway.participants : [];
            const participantDisplay = participants.length > 0
                ? participants.map((id, index) => `${index + 1}. <@${id}>`).join('\n')
                : 'لا يوجد مشاركين حتى الآن.';

            const chunks = [];
            for (let i = 0; i < participantDisplay.length; i += 4000) {
                chunks.push(participantDisplay.slice(i, i + 4000));
            }

            const embeds = chunks.length > 0
                ? chunks.map((chunk, index) => successEmbed(
                    index === 0 ? `Participants — ${giveaway.prize || 'Giveaway'} 👥` : `Participants — Page ${index + 1}`,
                    chunk
                ))
                : [successEmbed(`Participants — ${giveaway.prize || 'Giveaway'} 👥`, participantDisplay)];

            await interaction.reply({
                embeds,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error('Error in giveaway participants handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_participants',
                handler: 'giveawayParticipants'
            });
        }
    }
};