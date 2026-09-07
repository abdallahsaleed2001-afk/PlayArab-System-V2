import { handleAntiNuke } from '../services/security/antiNuke.js';

export default {
  name: 'channelUpdate',
  async execute(channel) {
    if (!channel?.guild) return;
    await handleAntiNuke(channel.guild, 'channelUpdate', channel.id);
  },
};
