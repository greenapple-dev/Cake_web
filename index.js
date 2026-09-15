require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
  REST,
  Routes,
  AttachmentBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // optional, for faster command registration

// Load or create config
const configPath = path.join(__dirname, 'config.json');
let config = { ip: 'play.trialsmp.org', port: '25546' };
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ====================== COMMANDS ======================
const commands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by ID')
    .addStringOption(o => o.setName('userid').setDescription('User ID').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a member')
    .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Send an announcement')
    .addChannelOption(o => o.setName('channel').setDescription('Channel to send to').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Announcement text').setRequired(true))
    .addStringOption(o => o.setName('ping').setDescription('Who to ping').addChoices(
      { name: 'None', value: 'none' },
      { name: '@here', value: 'here' },
      { name: '@everyone', value: 'everyone' }
    ).setRequired(false))
    .addAttachmentOption(o => o.setName('image').setDescription('Optional image').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Start a giveaway')
    .addChannelOption(o => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Duration (e.g. 1h, 30m, 2d)').setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Custom image (optional)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('ip')
    .setDescription('Set Minecraft IP & Port and post it')
    .addStringOption(o => o.setName('ip').setDescription('Server IP').setRequired(true))
    .addStringOption(o => o.setName('port').setDescription('Server Port').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post the IP embed').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

// Register commands
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  try {
    console.log('Registering slash commands...');
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Guild commands registered.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Global commands registered (can take up to 1 hour).');
    }
  } catch (e) {
    console.error(e);
  }
})();

// ====================== EVENTS ======================
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton()) return;

  // ---------- BUTTON: Enter Giveaway ----------
  if (interaction.isButton() && interaction.customId.startsWith('giveaway_enter_')) {
    const giveawayId = interaction.customId.split('_')[2];
    // Simple in-memory storage (for production use a database)
    if (!client.giveaways) client.giveaways = {};
    if (!client.giveaways[giveawayId]) {
      return interaction.reply({ content: 'This giveaway has ended or does not exist.', ephemeral: true });
    }

    const g = client.giveaways[giveawayId];
    if (g.ended) return interaction.reply({ content: 'This giveaway has already ended.', ephemeral: true });

    if (g.entries.has(interaction.user.id)) {
      return interaction.reply({ content: 'You already entered this giveaway!', ephemeral: true });
    }

    g.entries.add(interaction.user.id);
    return interaction.reply({ content: 'You have entered the giveaway! Good luck 🎉', ephemeral: true });
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ---------- BAN ----------
  if (commandName === 'ban') {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (!member) return interaction.reply({ content: 'User not found in this server.', ephemeral: true });
    if (!member.bannable) return interaction.reply({ content: 'I cannot ban this user.', ephemeral: true });

    await member.ban({ reason });
    return interaction.reply(`Banned **${user.tag}** | Reason: ${reason}`);
  }

  // ---------- UNBAN ----------
  if (commandName === 'unban') {
    const userId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      await interaction.guild.members.unban(userId, reason);
      return interaction.reply(`Unbanned \`${userId}\` | Reason: ${reason}`);
    } catch {
      return interaction.reply({ content: 'Could not unban that user (wrong ID or not banned).', ephemeral: true });
    }
  }

  // ---------- KICK ----------
  if (commandName === 'kick') {
    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (!member) return interaction.reply({ content: 'User not found.', ephemeral: true });
    if (!member.kickable) return interaction.reply({ content: 'I cannot kick this user.', ephemeral: true });

    await member.kick(reason);
    return interaction.reply(`Kicked **${user.tag}** | Reason: ${reason}`);
  }

  // ---------- TIMEOUT ----------
  if (commandName === 'timeout') {
    const user = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (!member) return interaction.reply({ content: 'User not found.', ephemeral: true });
    if (!member.moderatable) return interaction.reply({ content: 'I cannot timeout this user.', ephemeral: true });

    await member.timeout(minutes * 60 * 1000, reason);
    return interaction.reply(`Timed out **${user.tag}** for ${minutes} minutes | Reason: ${reason}`);
  }

  // ---------- ANNOUNCEMENT ----------
  if (commandName === 'announcement') {
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    const ping = interaction.options.getString('ping') || 'none';
    const image = interaction.options.getAttachment('image');

    let content = '';
    if (ping === 'here') content = '@here';
    if (ping === 'everyone') content = '@everyone';

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription(message)
      .setTimestamp()
      .setFooter({ text: `Announcement by ${interaction.user.tag}` });

    if (image) embed.setImage(image.url);

    await channel.send({ content, embeds: [embed] });
    return interaction.reply({ content: `Announcement sent to ${channel}`, ephemeral: true });
  }

  // ---------- GIVEAWAY ----------
  if (commandName === 'giveaway') {
    const channel = interaction.options.getChannel('channel');
    const prize = interaction.options.getString('prize');
    const winners = interaction.options.getInteger('winners');
    const durationStr = interaction.options.getString('duration');
    const customImage = interaction.options.getAttachment('image');

    // Parse duration (simple: 30m, 1h, 2d)
    const match = durationStr.match(/^(\d+)([mhd])$/i);
    if (!match) return interaction.reply({ content: 'Invalid duration. Use e.g. `30m`, `1h`, `2d`', ephemeral: true });

    const amount = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    let ms = 0;
    if (unit === 'm') ms = amount * 60 * 1000;
    if (unit === 'h') ms = amount * 60 * 60 * 1000;
    if (unit === 'd') ms = amount * 24 * 60 * 60 * 1000;

    const endsAt = Date.now() + ms;
    const giveawayId = Date.now().toString();

    if (!client.giveaways) client.giveaways = {};
    client.giveaways[giveawayId] = {
      prize,
      winners,
      endsAt,
      entries: new Set(),
      ended: false,
      channelId: channel.id
    };

    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle('🎉 GIVEAWAY 🎉')
      .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R>`)
      .setFooter({ text: `Giveaway ID: ${giveawayId}` })
      .setTimestamp();

    // Use your cake image by default
    const cakePath = path.join(__dirname, 'giveaway.png');
    let files = [];
    if (customImage) {
      embed.setImage(customImage.url);
    } else if (fs.existsSync(cakePath)) {
      const attachment = new AttachmentBuilder(cakePath, { name: 'giveaway.png' });
      embed.setImage('attachment://giveaway.png');
      files = [attachment];
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway_enter_${giveawayId}`)
        .setLabel('Enter Giveaway')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎉')
    );

    const msg = await channel.send({ embeds: [embed], components: [row], files });

    // End the giveaway later
    setTimeout(async () => {
      const g = client.giveaways[giveawayId];
      if (!g || g.ended) return;
      g.ended = true;

      const entries = [...g.entries];
      let winnerList = 'No one entered 😢';

      if (entries.length > 0) {
        const selected = [];
        for (let i = 0; i < Math.min(g.winners, entries.length); i++) {
          const idx = Math.floor(Math.random() * entries.length);
          selected.push(`<@${entries[idx]}>`);
          entries.splice(idx, 1);
        }
        winnerList = selected.join(', ');
      }

      const endEmbed = EmbedBuilder.from(embed)
        .setColor(0xE74C3C)
        .setDescription(`**Prize:** ${g.prize}\n**Winners:** ${winnerList}\n**Ended**`);

      await msg.edit({ embeds: [endEmbed], components: [] });
      await channel.send(`🎉 Giveaway ended! Winners: ${winnerList}`);
    }, ms);

    return interaction.reply({ content: `Giveaway started in ${channel}`, ephemeral: true });
  }

  // ---------- IP COMMAND ----------
  if (commandName === 'ip') {
    const ip = interaction.options.getString('ip');
    const port = interaction.options.getString('port');
    const channel = interaction.options.getChannel('channel');

    config.ip = ip;
    config.port = port;
    saveConfig();

    const embed = new EmbedBuilder()
      .setColor(0x2B2D31)
      .setTitle('IP & PORT')
      .addFields(
        { name: 'IP', value: `\`${ip}\``, inline: true },
        { name: 'PORT', value: `\`${port}\``, inline: true }
      )
      .setFooter({ text: 'Trials SMP' })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    return interaction.reply({ content: `IP & Port updated and posted in ${channel}`, ephemeral: true });
  }
});

client.login(TOKEN);
