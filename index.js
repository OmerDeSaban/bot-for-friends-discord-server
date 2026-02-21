require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { DateTime } = require("luxon");

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require("discord.js");

/* =========================
   ENV + CONSTANTS
   ========================= */
const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const OWNER_ID = process.env.OWNER_ID; // your Discord user id
const TOM_ID = process.env.TOM_ID || null; // optional
const GUILD_ID = process.env.DISCORD_GUILD_ID || null; // recommended for instant command updates
const TIMEZONE = process.env.TIMEZONE || "Asia/Jerusalem";

if (!TOKEN) throw new Error("Missing DISCORD_TOKEN env var.");
if (!APP_ID) throw new Error("Missing DISCORD_APP_ID env var.");
if (!OWNER_ID) throw new Error("Missing OWNER_ID env var.");

const ROLE_NAME = "Gay";
const ANNOUNCE_CHANNEL_NAME = "general";

// Tom rig: when Tom is present + someone else was picked, final decision is:
// Tom: 20%, Other: 80%
const TOM_PROB = 0.2;

/* =========================
   HEALTH SERVER (Render)
   ========================= */
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_req, res) => res.send("Bot is alive."));
app.get("/healthz", (_req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`Health server running on port ${PORT}`));

/* =========================
   SCOREBOARD (JSON)
   ========================= */
const SCORE_FILE = path.join(__dirname, "scoreboard.json");

function loadScoreboard() {
  try {
    if (!fs.existsSync(SCORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(SCORE_FILE, "utf8"));
  } catch (e) {
    console.error("Failed to load scoreboard.json:", e);
    return {};
  }
}

function saveScoreboard(board) {
  try {
    fs.writeFileSync(SCORE_FILE, JSON.stringify(board, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save scoreboard.json:", e);
  }
}

let scoreboard = loadScoreboard();

function incScore(userId) {
  scoreboard[userId] = (scoreboard[userId] || 0) + 1;
  saveScoreboard(scoreboard);
}

function resetScoreboard() {
  scoreboard = {};
  saveScoreboard(scoreboard);
}

/* =========================
   DISCORD CLIENT
   ========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// One holder per guild
const currentHolderByGuild = new Map();

// Serialize per guild to avoid race conditions
const guildLocks = new Map();
function withGuildLock(guildId, fn) {
  const prev = guildLocks.get(guildId) ?? Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error("Locked task error:", e));
  guildLocks.set(
    guildId,
    next.finally(() => {
      if (guildLocks.get(guildId) === next) guildLocks.delete(guildId);
    })
  );
  return next;
}

/* =========================
   MESSAGE POOLS (edit freely)
   ========================= */

// When someone joins a voice channel (reroll triggered)
const JOIN_SEARCH_MESSAGES = [
  "⚠️ Someone joined. Initiating full-spectrum Gay scan...",
  "🧪 New sample detected. Running Gay detection again...",
  "📡 A new subject has entered. Recalibrating the Gaydar...",
  "🔎 Scanning voice channel... one of you must be Gay. Stand by for identification.",
  "📡 Gay detection systems online. Detecting the Gayest person here...",
  "🧪 Someone joined huh? Running advanced Gay-detection algorithms...",
  "🛰️ Satellite imagery confirms: someone here is Gay. Pinpointing the source of the Gayness...",
  "⚠️ Alert: a new person joined. Recalculating Gayness...",
];

// When a winner is selected
const CHOSEN_MESSAGES = [
  (name) => `🚨 ALERT 🚨 **${name}** has been detected as Gay! 🌈`,
  (name) => `HA!!!!!!! **${name}** Gayyyyyyyyyyyyy 🌈`,
  (name) => `Hey, **${name}**, WHY. ARE. YOU. GAY?! 🌈`,
  (name) => `Mistah **${name}**, Can I call you MISTAH? 🌈`,
  (name) => `You are Gay activist, **${name}**. You are Gay. 🌈`,
  (name) => `📡 The Gaydar is buzzing… it’s pointing at **${name}**!`,
  (name) => `🧪 After careful scientific analysis… **${name}** is Gay.`,
];

// When the current Gay leaves AND old channel still has humans
const LEAVE_REROLL_MESSAGES = [
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

/* =========================
   HELPERS
   ========================= */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getRoleByName(guild, roleName) {
  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found`);
  return role;
}

async function removeRoleIfHas(member, role) {
  if (member?.roles?.cache?.has(role.id)) {
    await member.roles.remove(role, "Auto: role moved/cleared");
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

function pickRandomHumanFrom(voiceChannel) {
  const humans = voiceChannel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) return null;
  return humans.random();
}

/**
 * Tom rig:
 * If Tom is present, and the randomly selected winner isn't Tom,
 * choose between {Tom, winner} with Tom probability TOM_PROB.
 */
function applyTomRigIfNeeded(randomWinner, voiceChannel) {
  if (!TOM_ID) return randomWinner;

  const tomMember = voiceChannel.members.get(TOM_ID);
  const tomPresent = !!tomMember && !tomMember.user.bot;

  if (!tomPresent) return randomWinner;
  if (randomWinner.id === TOM_ID) return randomWinner;

  return Math.random() < TOM_PROB ? tomMember : randomWinner;
}

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

/* =========================
   SLASH COMMANDS
   ========================= */
const commandDefs = [
  new SlashCommandBuilder()
    .setName("scoreboard")
    .setDescription("Show the Gay Detection Leaderboard (Top 3)."),
  new SlashCommandBuilder()
    .setName("reset_scoreboard")
    .setDescription("Reset the scoreboard (owner only)."),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commandDefs });
    console.log("Slash commands registered (guild).");
  } else {
    await rest.put(Routes.applicationCommands(APP_ID), { body: commandDefs });
    console.log("Slash commands registered (global).");
  }
}

/* =========================
   SCOREBOARD RENDERING (Top 3 with ties + medals)
   ========================= */
function top3Groups(board) {
  const entries = Object.entries(board); // [userId, count]
  if (entries.length === 0) return [];

  entries.sort((a, b) => b[1] - a[1]);

  const groups = [];
  for (const [userId, count] of entries) {
    const last = groups[groups.length - 1];
    if (!last || last.count !== count) {
      groups.push({ count, userIds: [userId] });
    } else {
      last.userIds.push(userId);
    }
  }
  return groups.slice(0, 3);
}

function medalForRank(rank1Based) {
  if (rank1Based === 1) return "🥇";
  if (rank1Based === 2) return "🥈";
  if (rank1Based === 3) return "🥉";
  return "🏅";
}

async function buildScoreboardEmbed() {
  const groups = top3Groups(scoreboard);

  const embed = new EmbedBuilder().setTitle("🏆 Gay Detection Leaderboard (Top 3)");

  if (!groups.length) {
    embed.setDescription("No data yet. Join voice and get detected 😈");
    return embed;
  }

  for (let i = 0; i < groups.length; i++) {
    const rank = i + 1;
    const g = groups[i];
    const medal = medalForRank(rank);
    const mentions = g.userIds.map((id) => `<@${id}>`).join(", ");

    embed.addFields({
      name: `${medal} #${rank} — (${g.count})`,
      value: mentions,
      inline: false,
    });
  }

  return embed;
}

/* =========================
   DAILY MIDNIGHT POST
   ========================= */
async function postDailyScoreboard() {
  for (const guild of client.guilds.cache.values()) {
    const channel = await getAnnouncementChannel(guild);
    if (!channel) continue;

    const embed = await buildScoreboardEmbed();
    await channel.send({ embeds: [embed] }).catch(() => {});
  }
}

function scheduleMidnightJob() {
  const now = DateTime.now().setZone(TIMEZONE);
  const nextMidnight = now.plus({ days: 1 }).startOf("day");
  const ms = Math.max(1000, nextMidnight.toMillis() - now.toMillis());

  setTimeout(async () => {
    await postDailyScoreboard().catch((e) => console.error("Midnight post failed:", e));

    setInterval(() => {
      postDailyScoreboard().catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }, ms);
}

/* =========================
   READY
   ========================= */
let started = false;
async function onReady() {
  if (started) return;
  started = true;

  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  scheduleMidnightJob();
  console.log("Listening for voice joins/leaves...");
}

client.once("ready", onReady);
client.once("clientReady", onReady); // supports newer discord.js naming

/* =========================
   VOICE LOGIC
   ========================= */
client.on("voiceStateUpdate", (oldState, newState) => {
  const guild = newState.guild ?? oldState.guild;
  if (!guild) return;

  const actor = newState.member ?? oldState.member;
  if (!actor || actor.user?.bot) return;

  withGuildLock(guild.id, async () => {
    const role = await getRoleByName(guild, ROLE_NAME);
    const announceChannel = await getAnnouncementChannel(guild);

    const oldChannel = oldState.channel;
    const newChannel = newState.channel;

    const holderId = currentHolderByGuild.get(guild.id);
    const actorIsHolder = holderId === actor.id;

    const movedOrDisconnected = !!oldChannel && oldChannel.id !== (newChannel?.id ?? null);
    const joinedOrMovedIn = !!newChannel && newChannel.id !== (oldChannel?.id ?? null);

    // A) Holder left their channel -> remove instantly; if old channel still has humans, reroll there
    if (actorIsHolder && movedOrDisconnected) {
      await removeRoleIfHas(actor, role);
      currentHolderByGuild.delete(guild.id);

      const humansLeft = oldChannel.members.filter((m) => !m.user.bot);
      if (humansLeft.size > 0) {
        if (announceChannel) {
          await announceChannel.send(pickRandom(LEAVE_REROLL_MESSAGES)).catch(() => {});
        }

        let winner = pickRandomHumanFrom(oldChannel);
        if (!winner) return;

        winner = applyTomRigIfNeeded(winner, oldChannel);

        await setSingleHolder(guild, role, winner);
        incScore(winner.id);

        if (announceChannel) {
          const chosenLine = pickRandom(CHOSEN_MESSAGES);
          await announceChannel.send(chosenLine(winner.displayName)).catch(() => {});
        }
      }
      return;
    }

    // B) Someone joined/moved into a channel -> ALWAYS reroll on every join/move-in
    if (joinedOrMovedIn) {
      if (announceChannel) {
        await announceChannel.send(pickRandom(JOIN_SEARCH_MESSAGES)).catch(() => {});
      }

      let winner = pickRandomHumanFrom(newChannel);
      if (!winner) return;

      winner = applyTomRigIfNeeded(winner, newChannel);

      await setSingleHolder(guild, role, winner);
      incScore(winner.id);

      if (announceChannel) {
        const chosenLine = pickRandom(CHOSEN_MESSAGES);
        await announceChannel.send(chosenLine(winner.displayName)).catch(() => {});
      }
      return;
    }

    // ignore mute/deafen/video/etc changes
  });
});

/* =========================
   SLASH COMMAND HANDLER
   ========================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // Respond quickly to avoid "Unknown interaction" (10062)
    await interaction.deferReply({ ephemeral: false });

    if (interaction.commandName === "scoreboard") {
      const embed = await buildScoreboardEmbed();
      return await interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === "reset_scoreboard") {
      if (interaction.user.id !== OWNER_ID) {
        return await interaction.editReply("❌ You are not allowed to reset the scoreboard.");
      }
      resetScoreboard();
      return await interaction.editReply("✅ Scoreboard reset.");
    }

    return await interaction.editReply("Unknown command.");
  } catch (e) {
    console.error("interactionCreate error:", e);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("⚠️ Something went wrong handling that command.");
      }
    } catch {}
  }
});

process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));

client.login(TOKEN);