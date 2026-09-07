import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const key = guildId => `partners:${guildId}`;
async function load(client, guildId) { const data = await client.db.get(key(guildId), {}); return data && typeof data === 'object' ? data : {}; }
async function save(client, guildId, data) { await client.db.set(key(guildId), data); }

export async function getPartnerData(client, guildId) {
  const data = await load(client, guildId);
  data.counter = Number(data.counter || 0);
  data.applications = Array.isArray(data.applications) ? data.applications : [];
  data.partners = Array.isArray(data.partners) ? data.partners : [];
  const storedMin = Number(data.requirements?.minMembers);
  const minMembers = !Number.isFinite(storedMin) || storedMin === 500 ? 100 : Math.max(100, storedMin);
  data.requirements = { minMembers, requireInvite: data.requirements?.requireInvite !== false, requireActive: data.requirements?.requireActive !== false };
  if (storedMin === 500 || !Number.isFinite(storedMin) || storedMin < 100) await save(client, guildId, data);
  return data;
}
export async function savePartnerData(client, guildId, data) { return save(client, guildId, data); }
export async function deletePartner(client, guildId, partnerId) {
  const data = await getPartnerData(client, guildId);
  const index = data.partners.findIndex(p => String(p.id) === String(partnerId) && p.status === 'active');
  if (index === -1) return false;
  data.partners.splice(index, 1);
  await save(client, guildId, data);
  return true;
}

export async function setupPartnerPanel(interaction, announcementChannel) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'هذا الأمر يعمل داخل السيرفر فقط.', ephemeral: true });
  if (!announcementChannel || announcementChannel.type !== ChannelType.GuildText) return interaction.reply({ content: 'اختر روم نصي صالح للإعلانات.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const data = await getPartnerData(interaction.client, guild.id);
  let panelChannel = data.panelChannelId ? guild.channels.cache.get(data.panelChannelId) : null;
  if (!panelChannel) panelChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'partnerships');
  if (!panelChannel) panelChannel = await guild.channels.create({ name: 'partnerships', type: ChannelType.GuildText, reason: 'Partner system setup', permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] });
  let requestChannel = data.requestChannelId ? guild.channels.cache.get(data.requestChannelId) : null;
  if (!requestChannel) requestChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === 'partnership-requests');
  if (!requestChannel) requestChannel = await guild.channels.create({ name: 'partnership-requests', type: ChannelType.GuildText, reason: 'Partner system request channel', permissionOverwrites: [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] });

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🤝 شراكات السيرفر')
    .setDescription('حاب تسوي شراكة مع سيرفرنا؟ اضغط **تقديم طلب شراكة** وأرسل بيانات سيرفرك.\n\n**__شروط الشراكة__**\n\n• 100+ عضو\n• سيرفر نشط وتفاعل حقيقي\n• بدون مخالفات أو محتوى مخالف\n• إعلان متبادل بين السيرفرين\n• احترام الطرف الآخر\n• مخالفة الشروط = إنهاء الشراكة')
    .setFooter({ text: `${guild.name} • نظام الشراكات` });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('partner_apply').setLabel('تقديم طلب شراكة').setEmoji('🤝').setStyle(ButtonStyle.Primary));
  let panelMessage = data.panelMessageId ? await panelChannel.messages.fetch(data.panelMessageId).catch(() => null) : null;
  if (panelMessage) await panelMessage.edit({ embeds: [embed], components: [row] });
  else panelMessage = await panelChannel.send({ embeds: [embed], components: [row] });
  data.panelChannelId = panelChannel.id;
  data.panelMessageId = panelMessage.id;
  data.requestChannelId = requestChannel.id;
  data.announcementChannelId = announcementChannel.id;
  await savePartnerData(interaction.client, guild.id, data);
  return interaction.editReply({ content: `✅ تم تجهيز نظام الشراكات.\nلوحة الطلبات: ${panelChannel}\nروم الطلبات: ${requestChannel}\nروم إعلانات الشراكات: ${announcementChannel}` });
}

export async function partnerDashboard(interaction) {
  const data = await getPartnerData(interaction.client, interaction.guildId);
  const pending = data.applications.filter(a => a.status === 'pending').length;
  const active = data.partners.filter(p => p.status === 'active').length;
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🤝 إدارة الشراكات').setDescription('إدارة طلبات الشراكة والشراكات الحالية من هنا.').addFields(
    { name: 'الشراكات الحالية', value: String(active), inline: true },
    { name: 'الطلبات المعلقة', value: String(pending), inline: true },
    { name: 'إجمالي الطلبات', value: String(data.applications.length), inline: true },
    { name: 'الحد الأدنى', value: `${data.requirements.minMembers} عضوًا`, inline: true },
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('partner_pending').setLabel('الطلبات').setEmoji('🟡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('partner_active').setLabel('الشركاء').setEmoji('🤝').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('partner_delete').setLabel('حذف شريك').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('partner_stats').setLabel('الإحصائيات').setEmoji('📊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('partner_settings').setLabel('الإعدادات').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

export function applicationEmbed(app) {
  const status = app.status === 'accepted' ? '🟢 مقبول' : app.status === 'rejected' ? '🔴 مرفوض' : '🟡 قيد المراجعة';
  return new EmbedBuilder().setColor(app.status === 'accepted' ? 0x57f287 : app.status === 'rejected' ? 0xed4245 : 0x5865f2).setTitle(`🤝 طلب شراكة #${app.id}`).addFields(
    { name: 'السيرفر', value: app.serverName, inline: true },
    { name: 'عدد الأعضاء', value: String(app.members), inline: true },
    { name: 'الحالة', value: status, inline: true },
    { name: 'رابط الدعوة', value: app.invite },
    { name: 'مقدم الطلب', value: `<@${app.applicantId}>`, inline: true },
    { name: 'وصف السيرفر', value: app.description || 'لا يوجد وصف.' },
    { name: 'تاريخ الطلب', value: `<t:${Math.floor(new Date(app.createdAt).getTime() / 1000)}:R>` },
    ...(app.reviewedBy ? [{ name: 'تمت المراجعة بواسطة', value: `<@${app.reviewedBy}>`, inline: true }] : []),
  );
}

export function applicationButtons(app) {
  if (app.status !== 'pending') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`partner_accept:${app.id}`).setLabel('قبول').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`partner_reject:${app.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger),
  )];
}
