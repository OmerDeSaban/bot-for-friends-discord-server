require("dotenv").config();

const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Bot is alive.");
});

app.get("/healthz", (req, res) => {
  res.send("OK");
});

app.listen(PORT, () => {
  console.log(`Health server running on port ${PORT}`);
});

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
// Prevent concurrent handling per guild
const guildLocks = new Map(); // guildId -> Promise

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const LEAVE_MESSAGES = [
  "Ohhhh, Gay guy left... Very Gay of them... Let me check who's Gay now....",
  "Ha! Gay person leaves! Must be really afraid of being called Gay... Let's see who the new Gay is:",
  "Goddamnit! Why'd they leave?! Now I have to detect Gays again...",
  "What? The Gay guy left? Not again... Anyway, gotta go detect the next Gay:"
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function removeRoleFromEveryone(guild, role) {
  await guild.members.fetch();
  const membersWithRole = guild.members.cache.filter(m => m.roles.cache.has(role.id));
  for (const m of membersWithRole.values()) {
    await m.roles.remove(role, "Auto: clear role from everyone");
  }
}

function withGuildLock(guildId, fn) {
  const prev = guildLocks.get(guildId) ?? Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error("Locked task error:", e));
  guildLocks.set(guildId, next.finally(() => {
    if (guildLocks.get(guildId) === next) guildLocks.delete(guildId);
  }));
  return next;
}

async function removeRoleFromEveryoneExcept(guild, role, keepMemberId) {
  await guild.members.fetch(); // ensure cache is populated
  const membersWithRole = guild.members.cache.filter(m => m.roles.cache.has(role.id));

  for (const m of membersWithRole.values()) {
    if (m.id !== keepMemberId) {
      await m.roles.remove(role, "Auto: ensure single holder");
    }
  }
}

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

/*
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
*/

async function chooseRandomFromVoiceChannel(voiceChannel) {
  // Humans only, currently in this voice channel
  const eligible = voiceChannel.members.filter((m) => !m.user.bot);
  if (eligible.size === 0) return null;
  return eligible.random();
}

/*
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
*/

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log("Listening for voice joins/leaves...");

  // Optional: on startup, clear any incorrect state (good after restarts)
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch();
      const role = await getGayRole(guild);

      // If someone currently has the role, track them as holder (pick first)
      const withRole = guild.members.cache.filter(m => m.roles.cache.has(role.id));

      const inVoice = withRole.filter(m => isInAnyVoice(m));
      if (inVoice.size >= 1) {
      // Keep exactly one (pick first) and remove from others
      const keep = inVoice.first();
      currentHolderByGuild.set(guild.id, keep.id);
      for (const m of inVoice.values()) {
          if (m.id !== keep.id) await removeRoleIfHas(m, role);
      }
      } else {
      // Nobody with role is in voice -> remove from everyone who has it
      for (const m of withRole.values()) {
          await removeRoleIfHas(m, role);
      }
      currentHolderByGuild.delete(guild.id);
      }
    } catch (e) {
      console.warn(`Startup sync skipped for guild ${guild.id}:`, e?.message ?? e);
    }
  }
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const member = newState.member || oldState.member;
  if (!member || member.user?.bot) return;

  withGuildLock(guild.id, async () => {
    const role = await getGayRole(guild);

    const oldChannel = oldState.channel; // channel they were in
    const newChannel = newState.channel; // channel they are in now

    const holderId = currentHolderByGuild.get(guild.id);
    const isHolder = holderId === member.id;

    // Helpers
    const rerollInChannel = async (voiceChannel, reason) => {
      if (!voiceChannel) return;

      const winner = await chooseRandomFromVoiceChannel(voiceChannel);
      if (!winner) return;

      // Make absolutely sure only one person keeps the role
      await removeRoleFromEveryoneExcept(guild, role, winner.id);

      if (!winner.roles.cache.has(role.id)) {
        await winner.roles.add(role, reason);
      }
      currentHolderByGuild.set(guild.id, winner.id);

      const announceChannel = await getAnnouncementChannel(guild);
      if (announceChannel) {
        await announceChannel.send(`🚨 ALERT 🚨 **${winner.displayName}** has been detected as Gay! 🌈`);
      }
    };

    /*
    const removeHolderRole = async () => {
      await removeRoleIfHas(member, role);
      currentHolderByGuild.delete(guild.id);
    };
    */

    // CASE A: Holder LEFT a channel (disconnect OR moved away)
    const leftOldChannel = !!oldChannel && oldChannel.id !== (newChannel?.id ?? null);
    if (isHolder && leftOldChannel) {
    // remove instantly (from the leaver)
    await removeRoleIfHas(member, role);

    // safety: clear role from *everyone* (in case state was ever corrupted)
    await removeRoleFromEveryone(guild, role);
    currentHolderByGuild.delete(guild.id);

    const announceChannel = await getAnnouncementChannel(guild);

    // If the old channel still has humans, announce + reroll
    const humansLeft = oldChannel.members.filter(m => !m.user.bot);
    if (humansLeft.size > 0) {
        if (announceChannel) {
        await announceChannel.send(pickRandom(LEAVE_MESSAGES));
        }
        await rerollInChannel(oldChannel, "Auto: holder left, reroll in remaining channel");
    }

    return;
    }

    // CASE B: Someone ENTERED a channel (connect OR moved into a new one)
    const enteredNewChannel = !!newChannel && newChannel.id !== (oldChannel?.id ?? null);
    if (enteredNewChannel) {
      await rerollInChannel(newChannel, "Auto: someone entered voice channel");
      return;
    }

    // Otherwise: mute/deafen/streaming state changes etc. -> ignore
  });
});

client.login(TOKEN);