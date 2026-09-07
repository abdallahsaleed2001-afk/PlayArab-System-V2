import { PermissionFlagsBits } from 'discord.js';
import { deletePartner } from '../../utils/partner.js';

export default {
  name: 'partner_delete_modal',
  async execute(interaction, client) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: '❌ تحتاج صلاحية إدارة السيرفر.', ephemeral: true });
    const partnerId = interaction.fields.getTextInputValue('partner_id').trim();
    const deleted = await deletePartner(client, interaction.guildId, partnerId);
    return interaction.reply({ content: deleted ? `✅ تم حذف الشراكة #${partnerId}.` : `❌ لم يتم العثور على شريك نشط بالرقم #${partnerId}.`, ephemeral: true });
  },
};
