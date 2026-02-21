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
const TZ = "Asia/Jerusalem";

// Rigging:
// If TOM is in the channel and someone else is randomly chosen,
// do a head-to-head between TOM and that person.
const TOM_ID = process.env.TOM_ID || "";
const TOM_WIN_PROB = 0.15; // 15% Tom, 85% the originally chosen person

// Owner-only admin commands
const OWNER_ID = process.env.OWNER_ID || "";

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
    GatewayIntentBits.GuildMembers,
  ],
});

// =====================
// MESSAGES
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
// STATS (stats.json)
// =====================
const STATS_PATH = path.join(__dirname, "stats.json");

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
  } catch {
    return { counts: {}, names: {} };
  }
}

function saveStats(statsObj) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(statsObj, null, 2), "utf8");
}

let stats = loadStats();

function incrementChosen(member) {
  const id = member.id;
  stats.counts[id] = (stats.counts[id] ?? 0) + 1;
  stats.names[id] = member.displayName;
  saveStats(stats);
}

function resetStats() {
  stats = { counts: {}, names: {} };
  saveStats(stats);
}

function formatTop3WithMedals(statsObj) {
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
  const medals = ["🥇", "🥈", "🥉"];

  return top3
    .map((g, idx) => {
      const medal = medals[idx] ?? "🏅";
      const slotNumber = idx + 1;
      const mentions = g.ids.map((id) => `<@${id}>`).join(", ");
      return `${medal} **#${slotNumber}** — ${mentions} (**${g.count}**)`;
    })
    .join("\n");
}

// =====================
// SLASH COMMANDS
// =====================
const commands = [
  new SlashCommandBuilder()
    .setName("scoreboard")
    .setDescription("Show the top 3 detection leaderboard (ties share slots).")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("reset_scoreboard")
    .setDescription("Owner-only: reset the detection leaderboard.")
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
    const body = formatTop3WithMedals(stats);
    await interaction.reply(`🏆 **Gay Detection Leaderboard (Top 3)**\n${body}`);
    return;
  }

  if (interaction.commandName === "reset_scoreboard") {
    if (!OWNER_ID || interaction.user.id !== OWNER_ID) {
      await interaction.reply({ content: "⛔ You are not allowed to do that.", ephemeral: true });
      return;
    }
    resetStats();
    await interaction.reply({ content: "✅ Scoreboard reset.", ephemeral: true });
    return;
  }
});

// =====================
// GUILD LOCK (avoid double rerolls)
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
    if (guildLocks.get(guildId) === next) guildLocks.delete(guildId);
  }
}

// =====================
// HELPERS (roles/channels)
// =====================
async function getRoleByName(guild, roleName) {
  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found in guild ${guild.name}`);
  return role;
}

async function getAnnouncementChannel(guild) {
  return (
    guild.channels.cache.find((c) => c.isTextBased?.() && c.name === ANNOUNCE_CHANNEL_NAME) ||
    null
  );
}

async function removeRoleIfHas(member, role) {
  if (member?.roles?.cache?.has(role.id)) {
    await member.roles.remove(role, "Auto: role moved/cleared");
  }
}

// One holder per guild
const currentHolderByGuild = new Map();

async function setSingleHolder(guild, role, newHolder) {
  const oldId = currentHolderByGuild.get(guild.id);

  // remove from old holder if different
  if (oldId && oldId !== newHolder.id) {
    const oldMember = await guild.members.fetch(oldId).catch(() => null);
    if (oldMember) await removeRoleIfHas(oldMember, role);
  }

  // add to new holder
  if (!newHolder.roles.cache.has(role.id)) {
    await newHolder.roles.add(role, "Auto: random pick");
  }

  currentHolderByGuild.set(guild.id, newHolder.id);
}

// =====================
// RIGGING HELPERS (kept style)
// =====================
function pickRandomHumanFrom(voiceChannel) {
  const humans = voiceChannel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) return null;
  return humans.random();
}

function getTom(voiceChannel) {
  if (!TOM_ID) return null;
  return voiceChannel.members.get(TOM_ID) ?? null;
}

// If Tom exists + at least 2 humans + initial pick isn't Tom,
// then do a biased decision between Tom and initial pick.
function applyTomRig(voiceChannel, initiallyPicked) {
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

  const body = formatTop3WithMedals(stats);
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
// VOICE LOGIC
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

    // CASE A: Holder LEFT/moved out of a channel
    const leftOldChannel = !!oldChannel && oldChannel.id !== (newChannel?.id ?? null);
    if (actorIsHolder && leftOldChannel) {
      // remove instantly
      await removeRoleIfHas(actor, role);
      currentHolderByGuild.delete(guild.id);

      // if old channel still has humans -> leave msg + reroll there
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

    // CASE B: Someone ENTERED/moved into a new channel
    const enteredNewChannel = !!newChannel && newChannel.id !== (oldChannel?.id ?? null);
    if (enteredNewChannel) {
      let winner = pickRandomHumanFrom(newChannel);
      if (!winner) return;

      winner = applyTomRig(newChannel, winner);

      const oldId = currentHolderByGuild.get(guild.id);
      await setSingleHolder(guild, role, winner);
      incrementChosen(winner);

      // avoid spam if same person "wins" again
      if (winner.id !== oldId) {
        const announceChannel = await getAnnouncementChannel(guild);
        if (announceChannel) {
          const line = pickRandom(CHOSEN_MESSAGES);
          await announceChannel.send(line(winner.displayName));
        }
      }
      return;
    }

    // Otherwise ignore (mute/deafen/etc)
  }).catch(console.error);
});

// =====================
// STARTUP
// =====================
let started = false;
async function onReady() {
  if (started) return;
  started = true;

  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();

  for (const g of client.guilds.cache.values()) {
    scheduleDailyLeaderboard(g);
  }

  console.log("Listening for voice joins/leaves...");
}

// Support both event names (v14 vs v15)
client.once("ready", onReady);
client.once("clientReady", onReady);

process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

client.login(TOKEN);