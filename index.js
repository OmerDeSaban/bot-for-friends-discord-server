require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("Missing DISCORD_TOKEN");
const ROLE_NAME = "Gay";
const ANNOUNCE_CHANNEL_NAME = "general";

// In-memory “current holder” per guild
// guildId -> userId
const currentHolderByGuild = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

async function getAnnouncementChannel(guild) {
  const channel =
    guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === ANNOUNCE_CHANNEL_NAME
    ) ?? guild.channels.cache.find((c) => c.type === ChannelType.GuildText);

  if (!channel) return null;

  const me = guild.members.me ?? (await guild.members.fetchMe());
  const perms = channel.permissionsFor(me);
  if (
    !perms?.has(PermissionsBitField.Flags.ViewChannel) ||
    !perms?.has(PermissionsBitField.Flags.SendMessages)
  ) {
    return null;
  }
  return channel;
}

function isInAnyVoice(member) {
  return !!member.voice?.channelId;
}

async function getGayRole(guild) {
  const role = guild.roles.cache.find((r) => r.name === ROLE_NAME);
  if (!role) throw new Error(`Role "${ROLE_NAME}" not found`);
  return role;
}

async function removeRoleIfHas(member, role) {
  if (member.roles.cache.has(role.id)) {
    await member.roles.remove(role, "Auto: role holder changed/left voice");
  }
}

async function setCurrentHolder(guild, newHolderMember, role) {
  // Remove from old holder (if we know them)
  const oldHolderId = currentHolderByGuild.get(guild.id);
  if (oldHolderId && oldHolderId !== newHolderMember.id) {
    const oldMember = await guild.members.fetch(oldHolderId).catch(() => null);
    if (oldMember) {
      await removeRoleIfHas(oldMember, role);
    }
  }

  // Give to new holder
  await newHolderMember.roles.add(role, "Auto: random pick on voice join");
  currentHolderByGuild.set(guild.id, newHolderMember.id);
}

async function chooseRandomFromVoiceChannel(voiceChannel) {
  // Humans only, currently in this voice channel
  const eligible = voiceChannel.members.filter((m) => !m.user.bot);
  if (eligible.size === 0) return null;
  return eligible.random();
}

async function syncHolderIfLeftVoice(guild, role) {
  const holderId = currentHolderByGuild.get(guild.id);
  if (!holderId) return;

  const holder = await guild.members.fetch(holderId).catch(() => null);
  if (!holder) {
    currentHolderByGuild.delete(guild.id);
    return;
  }

  // If they are no longer in ANY voice channel, remove the role
  if (!isInAnyVoice(holder)) {
    await removeRoleIfHas(holder, role);
    currentHolderByGuild.delete(guild.id);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("Listening for voice joins/leaves...");

  // Optional: on startup, clear any incorrect state (good after restarts)
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch();
      const role = await getGayRole(guild);

      // If someone currently has the role, track them as holder (pick first)
      const existing = guild.members.cache.find((m) => m.roles.cache.has(role.id));
      if (existing && isInAnyVoice(existing)) {
        currentHolderByGuild.set(guild.id, existing.id);
      } else if (existing && !isInAnyVoice(existing)) {
        await removeRoleIfHas(existing, role);
      }
    } catch (e) {
      console.warn(`Startup sync skipped for guild ${guild.id}:`, e?.message ?? e);
    }
  }
});

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild;
    if (!guild) return;

    // Ignore bot users entirely
    if (newState.member?.user?.bot) return;

    const role = await getGayRole(guild);

    // 1) If the *current holder* left voice (or moved to no channel), remove role
    // This catches ANY voice event, not just the holder’s own event.
    await syncHolderIfLeftVoice(guild, role);

    // 2) If someone JOINED a voice channel (from no channel -> some channel), reroll
    const joined = !oldState.channelId && !!newState.channelId;
    if (!joined) return;

    const joinedChannel = newState.channel;
    if (!joinedChannel) return;

    const winner = await chooseRandomFromVoiceChannel(joinedChannel);
    if (!winner) return;

    // If winner is not in voice anymore by the time we act, skip
    if (!isInAnyVoice(winner)) return;

    // 3) Assign role to winner and remove from previous holder
    await setCurrentHolder(guild, winner, role);

    // 4) Announce
    const announceChannel = await getAnnouncementChannel(guild);
    if (announceChannel) {
      await announceChannel.send(`**${winner.displayName}** has been detected as Gay!`);
    } else {
      console.warn(`[${guild.name}] Can't announce (no #general or no perms).`);
    }
  } catch (err) {
    console.error("voiceStateUpdate error:", err);
  }
});

client.login(TOKEN);