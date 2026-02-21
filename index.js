if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

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
const TOM_WIN_PROB = 0.59375; // 59.375% Tom, 40.625% W
const TOM_ID = "217976928475283458"

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
  "What? The Gay guy left? Not again... Anyway, gotta go detect the next Gay:",
  "What? The Gay guy left? Was that Tom again? Gay-ass nigga.... Anyway, gotta go detect some Gay guy now:",
  "Gay guy left, huh? Let's see if someone here is more Gay than Tom...",
  "Mirror mirror on the wall, who's the new Gayest of you all?",
  "Ido hu homo, and Tom motzetz bulbulim, but who here wants some zragim?"
];

const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const STATS_PATH = path.join(__dirname, "stats.json");
const TZ = "Asia/Jerusalem";

const { SlashCommandBuilder, REST, Routes } = require("discord.js");

const APP_ID = process.env.DISCORD_APP_ID;
if (!APP_ID) {
  throw new Error("Missing DISCORD_APP_ID env var (Application ID).");
}

const commands = [
  new SlashCommandBuilder()
    .setName("scoreboard")
    .setDescription("Show the top 3 detection leaderboard (ties share slots).")
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
  console.log("Slash commands registered.");
}

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  } catch {
    return { counts: {}, names: {} }; // counts[userId]=number, names[userId]=last displayName
  }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), "utf8");
}

const stats = loadStats();

function incrementChosen(member) {
  const id = member.id;
  stats.counts[id] = (stats.counts[id] ?? 0) + 1;
  stats.names[id] = member.displayName; // store latest display name
  saveStats(stats);
}

function formatTop3(statsObj) {
  const entries = Object.entries(statsObj.counts)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);

  if (entries.length === 0) return "No detections yet.";

  // Group by count (ties share a slot)
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (!last || last.count !== e.count) groups.push({ count: e.count, ids: [e.id] });
    else last.ids.push(e.id);
  }

  const top3 = groups.slice(0, 3);

  const lines = top3.map((g, idx) => {
    const names = g.ids
      .map((id) => `<@${id}>`) // mention users
      .join(", ");
    return `**#${idx + 1}** — ${names} (**${g.count}**)`;
  });

  return lines.join("\n");
}

function msUntilNextMidnight() {
  const now = DateTime.now().setZone(TZ);
  const next = now.plus({ days: 1 }).startOf("day"); // next midnight
  return Math.max(1000, next.toMillis() - now.toMillis());
}

async function postDailyTop3(guild) {
  const announceChannel = await getAnnouncementChannel(guild);
  if (!announceChannel) return;

  const body = formatTop3(stats);
  await announceChannel.send(`🏆 **Daily Gay Detection Leaderboard (Top 3)**\n${body}`);
}

function scheduleDailyLeaderboard(guild) {
  const firstDelay = msUntilNextMidnight();
  setTimeout(() => {
    postDailyTop3(guild).catch(console.error);

    // After first run, run every 24h
    setInterval(() => {
      postDailyTop3(guild).catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }, firstDelay);
}

function getTom(voiceChannel) {
  return voiceChannel.members.get(TOM_ID) ?? null;
}

async function getRoleByName(guild, roleName) {
  const role = guild.roles.cache.find(r => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found`);
  return role;
}

async function setSingleHolder(guild, role, newHolder) {
  // Remove from previous holder only (fast + avoids rate limits)
  const oldId = currentHolderByGuild.get(guild.id);
  if (oldId && oldId !== newHolder.id) {
    const oldMember = await guild.members.fetch(oldId).catch(() => null);
    if (oldMember) await removeRoleIfHas(oldMember, role);
  }

  // Add to new holder
  if (!newHolder.roles.cache.has(role.id)) {
    await newHolder.roles.add(role, "Auto: random pick");
  }

  currentHolderByGuild.set(guild.id, newHolder.id);
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function withGuildLock(guildId, fn) {
  const prev = guildLocks.get(guildId) ?? Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error("Locked task error:", e));
  guildLocks.set(guildId, next.finally(() => {
    if (guildLocks.get(guildId) === next) guildLocks.delete(guildId);
  }));
  return next;
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

async function removeRoleIfHas(member, role) {
  if (member?.roles?.cache?.has(role.id)) {
    await member.roles.remove(role, "Auto: role moved/cleared");
  }
}

client.once("clientReady", async () => {
  for (const guild of client.guilds.cache.values()) {
    scheduleDailyLeaderboard(guild);
  }
  await registerCommands();

  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetch().catch(() => {});
    const role = await getRoleByName(guild, ROLE_NAME).catch(() => null);
    if (!role) continue;

    // If multiple people somehow have it, keep at most one who is in voice
    const holders = guild.members.cache.filter(m => m.roles.cache.has(role.id));
    const inVoice = holders.filter(m => !!m.voice?.channelId);
    const keep = inVoice.first() ?? holders.first();

    if (!keep) {
      currentHolderByGuild.delete(guild.id);
      continue;
    }

    currentHolderByGuild.set(guild.id, keep.id);

    for (const m of holders.values()) {
      if (m.id !== keep.id) await removeRoleIfHas(m, role);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "scoreboard") return;

  const body = formatTop3(stats);
  await interaction.reply(`🏆 **Gay Detection Leaderboard (Top 3)**\n${body}`);
});

client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const actor = newState.member ?? oldState.member;
  if (!actor || actor.user?.bot) return;

  withGuildLock(guild.id, async () => {
    const role = await getRoleByName(guild, ROLE_NAME);

    const oldChannel = oldState.channel; // where they were
    const newChannel = newState.channel; // where they are now

    const holderId = currentHolderByGuild.get(guild.id);
    const actorIsHolder = holderId === actor.id;

    const pickRandomHumanFrom = (voiceChannel) => {
      const humans = voiceChannel.members.filter(m => !m.user.bot);
      if (humans.size === 0) return null;
      return humans.random();
    };

    // A) Holder left (disconnect OR moved away)
    const leftOldChannel = !!oldChannel && oldChannel.id !== (newChannel?.id ?? null);
    if (actorIsHolder && leftOldChannel) {
      // Remove role instantly from the leaver
      await removeRoleIfHas(actor, role);
      currentHolderByGuild.delete(guild.id);

      // If old channel still has humans, announce + reroll in that same channel
      const humansLeft = oldChannel.members.filter(m => !m.user.bot);
      if (humansLeft.size > 0) {
        const announceChannel = await getAnnouncementChannel(guild);
        if (announceChannel) {
          await announceChannel.send(pickRandom(LEAVE_MESSAGES));
        }

        const winner = pickRandomHumanFrom(oldChannel);
        if (winner) {
          const tom = getTom(newChannel);
          const humans = newChannel.members.filter(m => !m.user.bot);

          if (tom && humans.size >= 2 && winner.id !== tom.id) {
            winner = (Math.random() < TOM_WIN_PROB) ? tom : winner; // 59.375% Tom, else W
          }

          incrementChosen(winner);

          const oldId = currentHolderByGuild.get(guild.id);
          await setSingleHolder(guild, role, winner);
          if (winner.id !== oldId) {
            const announceChannel2 = announceChannel ?? (await getAnnouncementChannel(guild));
            if (announceChannel2) {
              await announceChannel2.send(`🚨 ALERT 🚨 **${winner.displayName}** has been detected as Gay! 🌈`);
            }
          }
        }
      }
      return;
    }

    // B) Someone entered a channel (connect OR moved into a different one)
    const enteredNewChannel = !!newChannel && newChannel.id !== (oldChannel?.id ?? null);
    if (enteredNewChannel) {
      const winner = pickRandomHumanFrom(newChannel);
      if (!winner) return;

      const tom = getTom(newChannel);
      const humans = newChannel.members.filter(m => !m.user.bot);

      if (tom && humans.size >= 2 && winner.id !== tom.id) {
        winner = (Math.random() < TOM_WIN_PROB) ? tom : winner; // 59.375% Tom, else W
      }

      incrementChosen(winner);

      const oldId = currentHolderByGuild.get(guild.id);
      await setSingleHolder(guild, role, winner);

      if (winner.id !== oldId) {
        const announceChannel = await getAnnouncementChannel(guild);
        if (announceChannel) {
          await announceChannel.send(
            `🚨 ALERT 🚨 **${winner.displayName}** has been detected as Gay! 🌈`
          );
        }
      }
      return;
    }

    // Otherwise ignore mute/deafen/stream changes
  });
});

client.login(TOKEN);

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});