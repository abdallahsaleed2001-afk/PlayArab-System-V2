import { getPartnerData, savePartnerData } from '../../utils/partner.js';
import { PermissionFlagsBits } from 'discord.js';

export default {
  name: 'partner_settings_modal',
  async execute(interaction, client) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ تحتاج صلاحية إدارة السيرفر.', ephemeral: true });
    }

    const minMembers = Number(interaction.fields.getTextInputValue('min_members').replace(/[^0-9]/g, ''));
    const requireInvite = interaction.fields.getTextInputValue('require_invite').trim().toLowerCase() === 'yes';
    const requireActive = interaction.fields.getTextInputValue('require_active').trim().toLowerCase() === 'yes';
    if (!Number.isFinite(minMembers) || minMembers < 0) return interaction.reply({ content: '❌ Minimum members must be a valid number.', ephemeral: true });
    const data = await getPartnerData(client, interaction.guildId);
    data.requirements.minMembers = minMembers;
    data.requirements.requireInvite = requireInvite;
    data.requirements.requireActive = requireActive;
    await savePartnerData(client, interaction.guildId, data);
    return interaction.reply({ content: `✅ Partnership settings updated. Minimum members: ${minMembers}.`, ephemeral: true });
  },
};
