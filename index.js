/**
 * index.js — Discord voice role bot + rigging + scoreboard + daily leaderboard
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { DateTime } = require("luxon");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

// =====================
// CONFIG
// =====================
const ROLE_NAME = "Gay";
const ANNOUNCE_CHANNEL_NAME = "general";

// Tom rigging
const TOM_ID = process.env.TOM_ID || ""; // recommended: set in Render env vars
const TOM_WIN_PROB = 0.59375; // 59.375% Tom vs 40.625% W

// Timezone for daily leaderboard
const TZ = "Asia/Jerusalem";

// =====================
// ENV CHECKS
// =====================
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var.");

const APP_ID = process.env.DISCORD_APP_ID;
if (!APP_ID) throw new Error("Missing DISCORD_APP_ID env var (Discord Application ID).");

// =====================
// HEALTH SERVER (Render keep-alive)
// =====================
const app = express();

app.get("/", (_req, res) => res.send("Bot is alive."));
app.get("/healthz", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Health server running on port ${PORT}`));

// =====================
// DISCORD CLIENT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // recommended for role ops + fetching members
  ],
});

// =====================
// MESSAGES (easy to extend)
// =====================
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// When someone is chosen
const CHOSEN_MESSAGES = [
  (name) => `🚨 ALERT 🚨 **${name}** has been detected as Gay! 🌈`,
  (name) => `HA!!!!!!! **${name}** Gayyyyyyyyyyyyy 🌈`,
  (name) => `**${name}**, Why. Ar. Yu. Gay?! 🌈`,
  (name) => `**${name}**, Can I call you MISTAH? 🌈`,
  (name) => `**${name}**, You are Gay activist. You are Gay. 🌈`,
  (name) => `📡 The Gaydar is buzzing… it’s pointing at **${name}**!`,
  (name) => `🧪 After careful scientific analysis… **${name}** is Gay.`,
];

// When the current Gay leaves (and we need to pick again)
const LEAVE_MESSAGES = [
  "Ohhhh, the Gay guy left... Very Gay of them... Let me check who's Gay now....",
  "Ha! The Gay person leaves! Must be really afraid of being called Gay... Let's see who the new Gay is:",
  "Goddamnit! Why'd they leave?! Now I have to detect Gays again...",
  "What? The Gay guy left? Not again... Anyway, gotta go detect the next Gay:",
  "What? The Gay guy left? Was that Tom again? Gay-ass nigga.... Anyway, gotta go detect some Gay guy now:",
  "Gay guy left, huh? Let's see if someone here is more Gay than Tom...",
  "Mirror mirror on the wall, who's the new Gayest of you all?",
  "Ido hu homo, and Tom motzetz bulbulim, but who here wants some zragim?",
  "What?!?! No homo?!?! Can't be! Gotta go detecting again...",
  "Huh? No Gay?! Wait a sec, Imma go find one..,",
];

// =====================
// SIMPLE PERSISTENT STATS (JSON)
// =====================
const STATS_PATH = path.join(__dirname, "stats.json");

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  } catch {
    return { counts: {}, names: {} };
  }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), "utf8");
}

const stats = loadStats();

function incrementChosen(member) {
  const id = member.id;
  stats.counts[id] = (stats.counts[id] ?? 0) + 1;
  stats.names[id] = member.displayName;
  saveStats(stats);
}

function formatTop3(statsObj) {
  const entries = Object.entries(statsObj.counts)
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);

  if (entries.length === 0) return "No detections yet.";

  // Group ties by same count
  const groups = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (!last || last.count !== e.count) groups.push({ count: e.count, ids: [e.id] });
    else last.ids.push(e.id);
  }

  const top3 = groups.slice(0, 3);

  return top3
    .map((g, idx) => {
      const mentions = g.ids.map((id) => `<@${id}>`).join(", ");
      return `**#${idx + 1}** — ${mentions} (**${g.count}**)`;
    })
    .join("\n");
}

// =====================
// COMMANDS (/scoreboard)
// =====================
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

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "scoreboard") {
    const body = formatTop3(stats);
    await interaction.reply(`🏆 **Gay Detection Leaderboard (Top 3)**\n${body}`);
  }
});

// =====================
// GUILD LOCK (prevents double picks on rapid joins)
// =====================
const guildLocks = new Map();

async function withGuildLock(guildId, fn) {
  const prev = guildLocks.get(guildId) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  guildLocks.set(guildId, prev.then(() => next));

  try {
    await prev;
    return await fn();
  } finally {
    release();
    // cleanup if nothing pending
    if (guildLocks.get(guildId) === next) guildLocks.delete(guildId);
  }
}

// =====================
// ROLE/CHANNEL HELPERS
// =====================
async function getRoleByName(guild, roleName) {
  // Ensure role cache is populated
  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found in guild ${guild.name}`);
  return role;
}

async function getAnnouncementChannel(guild) {
  return guild.channels.cache.find(
    (c) => c.isTextBased?.() && c.name === ANNOUNCE_CHANNEL_NAME
  ) || null;
}

async function removeRoleIfHas(member, role) {
  if (member?.roles?.cache?.has(role.id)) {
    await member.roles.remove(role, "Auto: role moved/cleared");
  }
}

// single holder tracking (per guild)
const currentHolderByGuild = new Map();

async function setSingleHolder(guild, role, newHolder) {
  const oldId = currentHolderByGuild.get(guild.id);
  if (oldId && oldId !== newHolder.id) {
    const oldMember = await guild.members.fetch(oldId).catch(() => null);
    if (oldMember) await removeRoleIfHas(oldMember, role);
  }

  if (!newHolder.roles.cache.has(role.id)) {
    await newHolder.roles.add(role, "Auto: random pick");
  }

  currentHolderByGuild.set(guild.id, newHolder.id);
}

// =====================
// TOM RIGGING (head-to-head Tom vs W)
// =====================
function getTom(voiceChannel) {
  if (!TOM_ID) return null;
  return voiceChannel.members.get(TOM_ID) ?? null;
}

function pickRandomHumanFrom(voiceChannel) {
  const humans = voiceChannel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) return null;
  return humans.random();
}

function applyTomRig(voiceChannel, initiallyPicked) {
  // Rig only if Tom is present, >=2 humans, and initial pick isn't Tom.
  const tom = getTom(voiceChannel);
  if (!tom) return initiallyPicked;

  const humans = voiceChannel.members.filter((m) => !m.user.bot);
  if (humans.size < 2) return initiallyPicked;

  if (initiallyPicked.id === tom.id) return initiallyPicked;

  return Math.random() < TOM_WIN_PROB ? tom : initiallyPicked;
}

// =====================
// DAILY MIDNIGHT LEADERBOARD
// =====================
function msUntilNextMidnight() {
  const now = DateTime.now().setZone(TZ);
  const next = now.plus({ days: 1 }).startOf("day");
  return Math.max(1000, next.toMillis() - now.toMillis());
}

async function postDailyTop3(guild) {
  const channel = await getAnnouncementChannel(guild);
  if (!channel) return;

  const body = formatTop3(stats);
  await channel.send(`🏆 **Daily Gay Detection Leaderboard (Top 3)**\n${body}`);
}

function scheduleDailyLeaderboard(guild) {
  const firstDelay = msUntilNextMidnight();

  setTimeout(() => {
    postDailyTop3(guild).catch(console.error);

    setInterval(() => {
      postDailyTop3(guild).catch(console.error);
    }, 24 * 60 * 60 * 1000);
  }, firstDelay);
}

// =====================
// MAIN VOICE LOGIC
// =====================
client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const actor = newState.member ?? oldState.member;
  if (!actor || actor.user?.bot) return;

  withGuildLock(guild.id, async () => {
    const role = await getRoleByName(guild, ROLE_NAME);

    const oldChannel = oldState.channel;
    const newChannel = newState.channel;

    const holderId = currentHolderByGuild.get(guild.id);
    const actorIsHolder = holderId === actor.id;

    // A) Holder left a channel (disconnect OR moved away)
    const leftOldChannel = !!oldChannel && oldChannel.id !== (newChannel?.id ?? null);
    if (actorIsHolder && leftOldChannel) {
      // remove role instantly from leaver
      await removeRoleIfHas(actor, role);
      currentHolderByGuild.delete(guild.id);

      // if old channel still has humans -> message + reroll there
      const humansLeft = oldChannel.members.filter((m) => !m.user.bot);
      if (humansLeft.size > 0) {
        const announceChannel = await getAnnouncementChannel(guild);
        if (announceChannel) {
          await announceChannel.send(pickRandom(LEAVE_MESSAGES));
        }

        let winner = pickRandomHumanFrom(oldChannel);
        if (!winner) return;

        winner = applyTomRig(oldChannel, winner);

        await setSingleHolder(guild, role, winner);
        incrementChosen(winner);

        if (announceChannel) {
          const line = pickRandom(CHOSEN_MESSAGES);
          await announceChannel.send(line(winner.displayName));
        }
      }

      return;
    }

    // B) Someone entered a channel (connect OR moved into a different one)
    const enteredNewChannel = !!newChannel && newChannel.id !== (oldChannel?.id ?? null);
    if (enteredNewChannel) {
      let winner = pickRandomHumanFrom(newChannel);
      if (!winner) return;

      winner = applyTomRig(newChannel, winner);

      const oldId = currentHolderByGuild.get(guild.id);
      await setSingleHolder(guild, role, winner);
      incrementChosen(winner);

      // avoid spam if the same person "wins" again
      if (winner.id !== oldId) {
        const announceChannel = await getAnnouncementChannel(guild);
        if (announceChannel) {
          const line = pickRandom(CHOSEN_MESSAGES);
          await announceChannel.send(line(winner.displayName));
        }
      }

      return;
    }

    // Ignore mute/deafen/video/etc changes
  }).catch(console.error);
});

// =====================
// STARTUP
// =====================
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands (global). May take a few minutes to appear sometimes.
  await registerCommands();

  // Schedule daily leaderboard per guild
  for (const guild of client.guilds.cache.values()) {
    scheduleDailyLeaderboard(guild);
  }

  console.log("Listening for voice joins/leaves...");
});

// extra safety logging
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

// Start the bot
client.login(TOKEN);