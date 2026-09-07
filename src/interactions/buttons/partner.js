import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { getPartnerData, savePartnerData, applicationEmbed, applicationButtons } from '../../utils/partner.js';

async function renderApplications(interaction, filter) {
  const data = await getPartnerData(interaction.client, interaction.guildId);
  const items = filter === 'active' ? data.partners.filter(p => p.status === 'active') : data.applications.filter(a => a.status === 'pending');
  const title = filter === 'active' ? '🤝 الشراكات الحالية' : '🟡 طلبات الشراكة المعلقة';
  if (!items.length) return interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription('لا توجد بيانات لعرضها حاليًا.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('partner_back_dashboard').setLabel('رجوع').setStyle(ButtonStyle.Secondary))] });
  const description = items.slice(0, 15).map((x, i) => filter === 'active' ? `**${i + 1}. #${x.id} — ${x.serverName}** • ${x.members} عضو • <t:${Math.floor(new Date(x.acceptedAt || x.createdAt).getTime()/1000)}:R>` : `**#${x.id} — ${x.serverName}** • ${x.members} عضو • <@${x.applicantId}>`).join('\n');
  return interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(description)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('partner_back_dashboard').setLabel('رجوع').setStyle(ButtonStyle.Secondary))] });
}

export default [
  { name: 'partner_apply', async execute(interaction) {
    const modal = new ModalBuilder().setCustomId('partner_apply_modal').setTitle('طلب شراكة').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('server_name').setLabel('اسم السيرفر').setPlaceholder('اكتب اسم سيرفرك').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('invite').setLabel('رابط الدعوة').setPlaceholder('https://discord.gg/...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('members').setLabel('عدد الأعضاء').setPlaceholder('مثال: 150').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('وصف السيرفر').setPlaceholder('عرفنا بسيرفرك ومحتواه').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)),
    );
    return interaction.showModal(modal);
  }},
  { name: 'partner_pending', async execute(interaction) { return renderApplications(interaction, 'pending'); } },
  { name: 'partner_active', async execute(interaction) { return renderApplications(interaction, 'active'); } },
  { name: 'partner_delete', async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: '❌ تحتاج صلاحية إدارة السيرفر.', ephemeral: true });
    const modal = new ModalBuilder().setCustomId('partner_delete_modal').setTitle('حذف شريك').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('partner_id').setLabel('رقم الشراكة').setPlaceholder('مثال: 12').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
    );
    return interaction.showModal(modal);
  }},
  { name: 'partner_stats', async execute(interaction) {
    const data = await getPartnerData(interaction.client, interaction.guildId);
    const accepted = data.applications.filter(a => a.status === 'accepted').length, rejected = data.applications.filter(a => a.status === 'rejected').length, pending = data.applications.filter(a => a.status === 'pending').length;
    return interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📊 إحصائيات الشراكات').addFields({ name: 'الشراكات الحالية', value: String(data.partners.filter(p => p.status === 'active').length), inline: true }, { name: 'المقبولة', value: String(accepted), inline: true }, { name: 'المرفوضة', value: String(rejected), inline: true }, { name: 'المعلقة', value: String(pending), inline: true }, { name: 'إجمالي الطلبات', value: String(data.applications.length), inline: true })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('partner_back_dashboard').setLabel('رجوع').setStyle(ButtonStyle.Secondary))] });
  }},
  { name: 'partner_settings', async execute(interaction) {
    const data = await getPartnerData(interaction.client, interaction.guildId);
    const modal = new ModalBuilder().setCustomId('partner_settings_modal').setTitle('إعدادات الشراكات').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('min_members').setLabel('الحد الأدنى للأعضاء').setStyle(TextInputStyle.Short).setValue(String(data.requirements.minMembers)).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('require_invite').setLabel('هل رابط الدعوة مطلوب؟ نعم/لا').setStyle(TextInputStyle.Short).setValue(data.requirements.requireInvite ? 'نعم' : 'لا').setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('require_active').setLabel('هل يشترط سيرفر نشط؟ نعم/لا').setStyle(TextInputStyle.Short).setValue(data.requirements.requireActive ? 'نعم' : 'لا').setRequired(true)),
    );
    return interaction.showModal(modal);
  }},
  { name: 'partner_back_dashboard', async execute(interaction) {
    const data = await getPartnerData(interaction.client, interaction.guildId);
    const pending = data.applications.filter(a => a.status === 'pending').length, active = data.partners.filter(p => p.status === 'active').length;
    return interaction.update({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🤝 إدارة الشراكات').setDescription('إدارة طلبات الشراكة والشراكات الحالية من هنا.').addFields({ name: 'الشراكات الحالية', value: String(active), inline: true }, { name: 'الطلبات المعلقة', value: String(pending), inline: true }, { name: 'إجمالي الطلبات', value: String(data.applications.length), inline: true })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('partner_pending').setLabel('الطلبات').setEmoji('🟡').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('partner_active').setLabel('الشركاء').setEmoji('🤝').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('partner_delete').setLabel('حذف شريك').setEmoji('🗑️').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId('partner_stats').setLabel('الإحصائيات').setEmoji('📊').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId('partner_settings').setLabel('الإعدادات').setEmoji('⚙️').setStyle(ButtonStyle.Secondary))] });
  }},
  { name: 'partner_accept', async execute(interaction, client, args) { return review(interaction, client, args[0], 'accepted'); } },
  { name: 'partner_reject', async execute(interaction, client, args) { return review(interaction, client, args[0], 'rejected'); } },
];

async function review(interaction, client, id, status) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.reply({ content: '❌ تحتاج صلاحية إدارة السيرفر.', ephemeral: true });
  await interaction.deferUpdate();
  const data = await getPartnerData(client, interaction.guildId);
  const app = data.applications.find(a => String(a.id) === String(id));
  if (!app || app.status !== 'pending') return interaction.followUp({ content: '❌ طلب الشراكة غير موجود أو تمت مراجعته مسبقًا.', ephemeral: true });
  app.status = status; app.reviewedBy = interaction.user.id; app.reviewedAt = new Date().toISOString();
  if (status === 'accepted') data.partners.push({ ...app, status: 'active', acceptedAt: app.reviewedAt });
  await savePartnerData(client, interaction.guildId, data);
  const channel = interaction.guild.channels.cache.get(data.requestChannelId);
  const message = channel ? await channel.messages.fetch(app.messageId).catch(() => null) : null;
  if (message) await message.edit({ embeds: [applicationEmbed(app)], components: applicationButtons(app) });
  if (status === 'accepted') {
    if (data.announcementChannelId) {
      const announcementChannel = interaction.guild.channels.cache.get(data.announcementChannelId);
      if (announcementChannel?.isTextBased()) {
        const text = `🤝 **شراكة جديدة**\n\n**${app.serverName}**\n\n${app.description}\n\n${app.invite}\n\n@everyone @here`;
        await announcementChannel.send({ content: text, allowedMentions: { parse: ['everyone'] } });
      }
    }
  }
  return interaction.followUp({ content: status === 'accepted' ? `✅ تم قبول طلب الشراكة #${app.id}.` : `✅ تم رفض طلب الشراكة #${app.id}.`, ephemeral: true });
}
