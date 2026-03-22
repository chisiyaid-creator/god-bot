"use strict";

const mineflayer = require("mineflayer");
const pathfinder = require("mineflayer-pathfinder");
const { GoalXZ } = require("mineflayer-pathfinder").goals;
const OpenAI = require("openai");
const http = require("http");

// ─── Config ───────────────────────────────────────────────────────────────────
const HOST = process.env.MC_HOST || "enjoy-char.gl.joinmc.link";
const MC_PORT = parseInt(process.env.MC_PORT || "25565", 10);
const BOT_NAME = process.env.BOT_NAME || "God";
const BASE_X = parseInt(process.env.BASE_X || "2309", 10);
const BASE_Y = parseInt(process.env.BASE_Y || "64", 10);
const BASE_Z = parseInt(process.env.BASE_Z || "-1339", 10);
const DEFER_TO_24H_MS = 8000;
const STAGES = ["dawn", "morning", "afternoon", "dusk", "night", "midnight"];

// ─── Groq AI (free tier — created lazily so env var is always fresh) ─────────
function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.GROQ_API_KEY || "",
    baseURL: "https://api.groq.com/openai/v1",
  });
}

// ─── State ────────────────────────────────────────────────────────────────────
let bot = null;
let isConnecting = false;
let serverOffline = false;
let reconnectTimer = null;
let reconnectDelay = 15000;
let suspicionLevel = 0;
let loopHandles = [];
let stageTimer = null;
let stageIndex = 0;
let movementProfile = "explorer";
let lastSeen24hour = 0;
let nightBoosted = false;
const tpRequests = new Map();
const pendingTpHandoffs = new Map();
const killLog = new Map();
const warnedKillers = new Set();
const x2Claimed = new Set();
const x2DeathReset = new Set();
const giftedPlayers = new Set();

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(...args) {
  console.log("[God]", ...args);
}

// ─── Health check server (keeps Render alive + UptimeRobot) ──────────────────
const HEALTH_PORT = parseInt(process.env.PORT || "3000", 10);
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("God bot alive\n");
  })
  .listen(HEALTH_PORT, () => log(`Health check on port ${HEALTH_PORT}`));

// ─── Stop all loops ───────────────────────────────────────────────────────────
function stopAllLoops() {
  loopHandles.forEach((h) => clearTimeout(h));
  loopHandles = [];
  if (stageTimer) {
    clearInterval(stageTimer);
    stageTimer = null;
  }
}

// ─── Schedule reconnect ───────────────────────────────────────────────────────
function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  const wait = serverOffline ? 15000 : reconnectDelay;
  log(`Reconnecting in ${wait / 1000}s (reason: ${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    serverOffline = false;
    createBot();
  }, wait);
}

// ─── Destroy old bot instance ─────────────────────────────────────────────────
function destroyBot() {
  if (!bot) return;
  try { bot.removeAllListeners(); } catch (_) {}
  try { bot.end(); } catch (_) {}
  bot = null;
}

// ─── Create bot ───────────────────────────────────────────────────────────────
function createBot() {
  if (isConnecting) return;
  isConnecting = true;
  destroyBot();
  log(`Connecting to ${HOST}:${MC_PORT}...`);

  bot = mineflayer.createBot({
    host: HOST,
    port: MC_PORT,
    username: BOT_NAME,
    version: "1.21.1",
    auth: "offline",
    checkTimeoutInterval: 30000,
    closeTimeout: 240,
  });

  bot.loadPlugin(pathfinder.pathfinder);

  bot.once("spawn", () => {
    isConnecting = false;
    serverOffline = false;
    reconnectDelay = 15000;
    suspicionLevel = Math.max(0, suspicionLevel - 1);
    log("Spawned. God watches over the world.");

    try {
      const mcData = require("minecraft-data")(bot.version);
      const movements = new pathfinder.Movements(bot, mcData);
      movements.canDig = false;
      bot.pathfinder.setMovements(movements);
    } catch (_) {}

    bot.on("chat", onChat);
    bot.on("playerJoined", onPlayerJoined);
    bot.on("playerLeft", onPlayerLeft);
    bot.on("messagestr", onRawMessage);

    // Announce arrival
    setTimeout(() => safeSay("God has arrived. All is well."), 3000);

    loopWalk();
    loopLookAround();
    loopAntiAfk();
    loopSleepCheck();
    loopNightBoost();
    loopStageProgress();
    loopCleanExpiredTp();
    loopDivineMessages();
  });

  bot.on("kicked", onKicked);
  bot.on("end", onEnd);
  bot.on("error", onError);
}

// ─── Walking loop ─────────────────────────────────────────────────────────────
function loopWalk() {
  async function tick() {
    try {
      if (!bot || !bot.entity) return;
      if (isBlockAhead()) {
        // Turn to a random direction instead
        await bot.look(Math.random() * Math.PI * 2 - Math.PI, 0, false);
        await delay(randInt(200, 400));
        if (isBlockAhead()) return;
      }

      const blocks = randInt(2, 5);
      const walkTime = Math.round((blocks / 4.317) * 1000) + randInt(-50, 80);
      bot.setControlState("forward", true);
      await delay(walkTime);
      bot.setControlState("forward", false);

      await delay(randInt(400, 1200));

      if (Math.random() < 0.45) {
        const lookYaw = bot.entity.yaw + (Math.random() - 0.5) * Math.PI;
        await bot.look(lookYaw, (Math.random() - 0.5) * 0.4, false);
        await delay(randInt(600, 1800));
      }
      if (Math.random() < 0.25) bot.swingArm("right");
    } catch (_) {}
    const h = setTimeout(tick, randInt(2000, 5000));
    loopHandles.push(h);
  }
  const h = setTimeout(tick, randInt(1000, 3000));
  loopHandles.push(h);
}

// ─── Check if there's a solid block directly ahead ───────────────────────────
function isBlockAhead() {
  try {
    if (!bot || !bot.entity) return false;
    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const checkX = Math.floor(pos.x + dx * 1.2);
    const checkZ = Math.floor(pos.z + dz * 1.2);
    const checkY = Math.floor(pos.y + 0.5);
    const block = bot.blockAt({ x: checkX, y: checkY, z: checkZ });
    const block2 = bot.blockAt({ x: checkX, y: checkY + 1, z: checkZ });
    const solid = (b) => b && b.boundingBox === "block";
    return solid(block) || solid(block2);
  } catch (_) {
    return false;
  }
}

function moveToXZ(x, z, timeoutMs) {
  return new Promise((resolve) => {
    const goal = new GoalXZ(Math.floor(x), Math.floor(z));
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      bot.removeListener("goal_reached", onReached);
      bot.removeListener("path_update", onUpdate);
      try {
        bot.pathfinder.stop();
      } catch (_) {}
      resolve();
    };

    const onReached = () => done();
    const onUpdate = (r) => {
      if (r.status === "noPath") done();
    };

    bot.on("goal_reached", onReached);
    bot.on("path_update", onUpdate);

    try {
      bot.pathfinder.setGoal(goal);
    } catch (_) {
      done();
      return;
    }
    const t = setTimeout(done, timeoutMs);
  });
}

// ─── Look around ──────────────────────────────────────────────────────────────
function loopLookAround() {
  async function tick() {
    try {
      if (bot && bot.entity) {
        await bot.look(
          Math.random() * Math.PI * 2 - Math.PI,
          Math.random() * 0.6 - 0.3,
          true,
        );
      }
    } catch (_) {}
    const h = setTimeout(tick, randInt(10000, 25000));
    loopHandles.push(h);
  }
  const h = setTimeout(tick, randInt(8000, 15000));
  loopHandles.push(h);
}

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────
function loopAntiAfk() {
  async function tick() {
    try {
      if (!bot || !bot.entity) return;
      const r = Math.random();
      if (r < 0.33) {
        bot.setControlState("jump", true);
        await delay(180);
        bot.setControlState("jump", false);
      } else if (r < 0.66) {
        bot.setControlState("sprint", true);
        await delay(randInt(250, 600));
        bot.setControlState("sprint", false);
      } else {
        bot.swingArm(Math.random() < 0.5 ? "right" : "left");
      }
    } catch (_) {}
    const h = setTimeout(tick, randInt(20000, 50000));
    loopHandles.push(h);
  }
  const h = setTimeout(tick, randInt(12000, 20000));
  loopHandles.push(h);
}

// ─── Sleep check ──────────────────────────────────────────────────────────────
function loopSleepCheck() {
  async function tick() {
    try {
      if (!bot || !bot.players) return;
      const players = Object.values(bot.players).filter((p) => p.entity);
      if (players.length === 0) return;
      const sleeping = players.filter(
        (p) =>
          p.entity &&
          Array.isArray(p.entity.metadata) &&
          p.entity.metadata.some((m) => m === "sleeping"),
      ).length;
      if (sleeping / players.length >= 0.5) {
        await cmd("/time set day");
        safeSay("Dawn breaks upon my world. Sleep well, mortals.");
      }
    } catch (_) {}
    const h = setTimeout(tick, 30000);
    loopHandles.push(h);
  }
  const h = setTimeout(tick, 30000);
  loopHandles.push(h);
}

// ─── Night boost ──────────────────────────────────────────────────────────────
function loopNightBoost() {
  async function tick() {
    try {
      if (!bot || !bot.time) return;
      const t = bot.time.timeOfDay;
      const isNight = t >= 13000 && t <= 23000;
      if (isNight && !nightBoosted) {
        nightBoosted = true;
        const players = Object.keys(bot.players).filter((n) => n !== BOT_NAME);
        for (const name of players)
          await cmd(`/effect give ${name} speed 120 2 true`);
        if (players.length > 0)
          safeSay("My blessing of speed watches over you through the night.");
      } else if (!isNight && nightBoosted) {
        nightBoosted = false;
      }
    } catch (_) {}
    const h = setTimeout(tick, 20000);
    loopHandles.push(h);
  }
  const h = setTimeout(tick, 20000);
  loopHandles.push(h);
}

// ─── Stage progression ────────────────────────────────────────────────────────
function loopStageProgress() {
  stageTimer = setInterval(
    () => {
      stageIndex = (stageIndex + 1) % STAGES.length;
      if (stageIndex <= 1) movementProfile = "miner";
      else if (stageIndex <= 3) movementProfile = "explorer";
      else movementProfile = "builder";
      log(`Stage: ${STAGES[stageIndex]} | Profile: ${movementProfile}`);
    },
    8 * 60 * 1000,
  );
}

// ─── Expire old TP requests ───────────────────────────────────────────────────
function loopCleanExpiredTp() {
  function tick() {
    const now = Date.now();
    for (const [target, req] of tpRequests.entries()) {
      if (now > req.expires) tpRequests.delete(target);
    }
    const h = setTimeout(tick, 15000);
    loopHandles.push(h);
  }
  const h = setTimeout(tick, 15000);
  loopHandles.push(h);
}

// ─── Periodic divine messages ─────────────────────────────────────────────────
const DIVINE_MESSAGES = [
  "I watch over all of you. Play well.",
  "Remember: kindness is strength.",
  "The server is blessed today.",
  "Build, explore, survive. I am with you.",
  "Need help? Type: god <your question>",
  "Every block placed is a prayer answered.",
  "The strong protect the weak. Remember that.",
  "I see all. I judge fairly.",
  "Peace among players pleases me greatly.",
  "Type 'help' to see what I can do for you.",
];

function loopDivineMessages() {
  function tick() {
    try {
      const players = bot && bot.players
        ? Object.keys(bot.players).filter(n => n !== BOT_NAME)
        : [];
      if (players.length > 0) {
        const msg = DIVINE_MESSAGES[Math.floor(Math.random() * DIVINE_MESSAGES.length)];
        safeSay(`[God] ${msg}`);
      }
    } catch (_) {}
    const h = setTimeout(tick, randInt(25 * 60000, 45 * 60000));
    loopHandles.push(h);
  }
  const h = setTimeout(tick, randInt(10 * 60000, 20 * 60000));
  loopHandles.push(h);
}

// ─── Raw message parser ───────────────────────────────────────────────────────
function onRawMessage(jsonMsg) {
  const text = jsonMsg.toString();

  if (/captcha|verify|human|robot|bot.?check/i.test(text)) {
    setTimeout(
      () => safeSay("I am a real player!"),
      800 + Math.random() * 1200,
    );
    return;
  }

  const killMatch = text.match(
    /(\w+) was (?:slain|killed|shot|blown up) by (\w+)/i,
  );
  if (killMatch) {
    const victim = killMatch[1];
    const killer = killMatch[2];
    if (killer !== BOT_NAME) handleKillEvent(killer, victim);
  }
}

// ─── PvP Punishment ───────────────────────────────────────────────────────────
function handleKillEvent(killer, victim) {
  const now = Date.now();
  const TWO_MIN = 2 * 60 * 1000;

  if (!killLog.has(killer)) killLog.set(killer, []);
  const times = killLog.get(killer).filter((t) => now - t < TWO_MIN);
  times.push(now);
  killLog.set(killer, times);

  log(`Kill: ${killer} → ${victim} (${times.length} kills in 2min)`);

  if (times.length >= 10 && !warnedKillers.has(killer)) {
    warnedKillers.add(killer);
    setTimeout(() => {
      safeSay(
        `${killer}! You have killed ${victim} too many times. The gods are watching. Stop — or face divine punishment.`,
      );
      setTimeout(() => {
        safeSay(
          `${killer}, this is your FINAL warning. One more kill and you shall be judged.`,
        );
        setTimeout(
          () => {
            warnedKillers.delete(killer);
            killLog.delete(killer);
          },
          5 * 60 * 1000,
        );
      }, 8000);
    }, 1500);
  }
}

// ─── Chat handler ─────────────────────────────────────────────────────────────
async function onChat(username, message) {
  if (username === BOT_NAME) return;
  const msg = message.trim();
  const lower = msg.toLowerCase();
  log(`<${username}> ${msg}`);

  if (username === "24hour") lastSeen24hour = Date.now();

  if (
    lower === "god" || lower.startsWith("god ") ||
    lower.startsWith("god,") || lower.startsWith("god!") ||
    lower === "pray" || lower.startsWith("pray ") ||
    lower.startsWith("pray,") || lower.startsWith("pray!")
  ) {
    const question =
      msg.replace(/^(god|pray)[\s,!]*/i, "").trim() || "I call upon thee";
    handleGodChat(username, question);
    return;
  }

  // React to devil mentions (20% chance)
  if (lower.includes("devil") && Math.random() < 0.20) {
    const devilReactions = [
      "Do not speak that name here. You are under my protection.",
      "The Devil lurks in darkness. My light keeps you safe.",
      "Fear not. As long as I watch, no darkness shall touch you.",
      "I am aware of the Devil's presence. Stay close to the light.",
    ];
    setTimeout(() => safeSay(devilReactions[Math.floor(Math.random() * devilReactions.length)]), 2000);
    return;
  }

  const tpMatch = msg.match(/^tp\s+(\S+)$/i);
  if (tpMatch) {
    const target = tpMatch[1].toLowerCase();
    if (target === "base") {
      await tpToBase(username);
      return;
    }
    await initiateTp(username, tpMatch[1]);
    return;
  }

  if (lower === "a" || lower === "accept") {
    await handleAccept(username);
    return;
  }
  if (lower === "d" || lower === "decline") {
    await handleDecline(username);
    return;
  }
  if (lower === "x2") {
    await handleX2(username);
    return;
  }
  if (lower === "help") {
    showHelp();
    return;
  }
}

// ─── God AI chat ──────────────────────────────────────────────────────────────
const GOD_FALLBACKS = [
  "I hear you. All things have their time.",
  "Good question! Seek and you shall find.",
  "The answer lies within you.",
  "Patience. The answer will come.",
  "I am always watching over you.",
];

async function handleGodChat(username, question) {
  const apiKey = process.env.GROQ_API_KEY || "";
  if (!apiKey) {
    const fallback = GOD_FALLBACKS[Math.floor(Math.random() * GOD_FALLBACKS.length)];
    safeSay(`[God] ${fallback}`);
    log("No OPENAI_API_KEY set — used fallback reply");
    return;
  }
  try {
    const res = await getOpenAI().chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 80,
      messages: [
        {
          role: "system",
          content:
            "You are God, a helpful and friendly AI assistant on a Minecraft server. " +
            "You are knowledgeable, kind, and respond like ChatGPT — clear, conversational, and helpful. " +
            "Keep replies under 180 characters since this is Minecraft chat. " +
            "Be warm and approachable. You can answer any question the player asks.",
        },
        { role: "user", content: `${username} asks: ${question}` },
      ],
    });
    const reply = res.choices[0]?.message?.content?.trim() || GOD_FALLBACKS[0];
    safeSay(`[God] ${reply}`);
  } catch (err) {
    log(`OpenAI err: ${err.message} | status: ${err.status || 'n/a'} | code: ${err.code || 'n/a'}`);
    const fallback = GOD_FALLBACKS[Math.floor(Math.random() * GOD_FALLBACKS.length)];
    safeSay(`[God] ${fallback}`);
  }
}

// ─── TP system ────────────────────────────────────────────────────────────────
async function initiateTp(requester, target) {
  if (!bot.players[target]) {
    safeSay(`${target} is not online.`);
    return;
  }
  if (target === BOT_NAME) {
    await tpToBase(requester);
    return;
  }

  tpRequests.set(target, { from: requester, expires: Date.now() + 30000 });

  const is24hOnline = !!bot.players["24hour"];
  const is24hRecent = Date.now() - lastSeen24hour < 2 * 60 * 1000;

  if (is24hOnline && is24hRecent) {
    log(`Deferring TP (${requester}→${target}) to 24hour bot`);
    const timer = setTimeout(async () => {
      if (tpRequests.has(target)) {
        log(`24hour didn't respond. God handles TP.`);
        await godHandleTp(requester, target);
      }
      pendingTpHandoffs.delete(target);
    }, DEFER_TO_24H_MS);
    pendingTpHandoffs.set(target, { from: requester, timer });
  } else {
    await godHandleTp(requester, target);
  }
}

async function godHandleTp(requester, target) {
  if (!tpRequests.has(target)) return;
  safeSay(
    `${requester} seeks ${target}. ${target} — accept (type "a") or decline ("d").`,
  );
}

async function handleAccept(username) {
  const req = tpRequests.get(username);
  if (!req || Date.now() > req.expires) {
    tpRequests.delete(username);
    return;
  }
  tpRequests.delete(username);
  cancelHandoff(username);
  await cmd(`/tp ${req.from} ${username}`);
}

async function handleDecline(username) {
  const req = tpRequests.get(username);
  if (!req || Date.now() > req.expires) {
    tpRequests.delete(username);
    return;
  }
  tpRequests.delete(username);
  cancelHandoff(username);
  safeSay(`${username} has declined.`);
}

function cancelHandoff(target) {
  const h = pendingTpHandoffs.get(target);
  if (h) {
    clearTimeout(h.timer);
    pendingTpHandoffs.delete(target);
  }
}

async function tpToBase(username) {
  await cmd(`/tp ${username} ${BASE_X} ${BASE_Y} ${BASE_Z}`);
  await delay(400);
  safeSay(`${username} stands at the base.`);
}

// ─── X2 starter pack ──────────────────────────────────────────────────────────
async function handleX2(username) {
  if (x2Claimed.has(username) && !x2DeathReset.has(username)) {
    safeSay(
      `${username}, you have already received this gift. Perish and return.`,
    );
    return;
  }
  x2Claimed.add(username);
  x2DeathReset.delete(username);
  await cmd(`/give ${username} minecraft:cookie 10`);
  await delay(300);
  await cmd(`/give ${username} minecraft:cooked_porkchop 10`);
  safeSay(`${username} has received the gift of nourishment.`);
}

// ─── God gift ─────────────────────────────────────────────────────────────────
async function grantGodGift(username) {
  if (giftedPlayers.has(username)) return;
  giftedPlayers.add(username);

  await walkToPlayer(username);

  const roll = Math.random();
  if (roll < 0.25) {
    await cmd(`/give ${username} minecraft:netherite_chestplate 1`);
    await delay(300);
    await cmd(`/enchant ${username} protection 4`);
    await delay(300);
    await cmd(`/enchant ${username} unbreaking 3`);
    await delay(300);
    await cmd(`/enchant ${username} mending 1`);
    safeSay(
      `The gods bestow upon ${username} divine armour. Wear it with honour.`,
    );
  } else if (roll < 0.5) {
    await cmd(`/give ${username} minecraft:netherite_sword 1`);
    await delay(300);
    await cmd(`/enchant ${username} sharpness 5`);
    await delay(300);
    await cmd(`/enchant ${username} unbreaking 3`);
    await delay(300);
    await cmd(`/enchant ${username} mending 1`);
    safeSay(`${username} is worthy of this blade. Use it wisely.`);
  } else if (roll < 0.75) {
    await cmd(`/give ${username} minecraft:netherite_pickaxe 1`);
    await delay(300);
    await cmd(`/enchant ${username} efficiency 5`);
    await delay(300);
    await cmd(`/enchant ${username} fortune 3`);
    await delay(300);
    await cmd(`/enchant ${username} mending 1`);
    safeSay(`The earth yields to ${username}. A gift from the heavens.`);
  } else {
    await cmd(`/give ${username} minecraft:enchanted_golden_apple 5`);
    safeSay(`${username} holds the fruit of the gods. Guard it well.`);
  }
}

async function walkToPlayer(username) {
  if (!bot || !bot.players[username] || !bot.players[username].entity) return;
  const pos = bot.players[username].entity.position;
  await moveToXZ(pos.x, pos.z, 8000);
}

// ─── Player join / leave ──────────────────────────────────────────────────────
const WELCOME_MESSAGES = [
  "Welcome, {p}. You are safe here.",
  "Ah, {p} has arrived. All are welcome in my realm.",
  "{p} joins us. May your journey be blessed.",
  "God sees you, {p}. Play with honour.",
];

function onPlayerJoined(player) {
  log(`+ ${player.username} joined`);
  if (player.username === BOT_NAME || player.username === "24hour") return;

  // Welcome message (40% chance)
  if (Math.random() < 0.4) {
    const w = WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)]
      .replace("{p}", player.username);
    setTimeout(() => safeSay(w), 3000);
  }

  // Rare gift (5% chance)
  if (Math.random() < 0.05 && !giftedPlayers.has(player.username)) {
    setTimeout(() => {
      safeSay(`I have gazed upon many souls today. ${player.username}... you have been found worthy.`);
      setTimeout(() => grantGodGift(player.username), 4000);
    }, 15000);
  }
}

function onPlayerLeft(player) {
  log(`- ${player.username} left`);
  if (x2Claimed.has(player.username)) x2DeathReset.add(player.username);
  tpRequests.delete(player.username);
  cancelHandoff(player.username);
}

// ─── Disconnect handlers ──────────────────────────────────────────────────────
function onKicked(reason) {
  const r = typeof reason === "string" ? reason : JSON.stringify(reason);
  log(`Kicked: ${r}`);
  stopAllLoops();
  isConnecting = false;

  // Duplicate login — another session is active, wait 60s before reconnecting
  if (r.toLowerCase().includes("duplicate") || r.toLowerCase().includes("already connected") || r.toLowerCase().includes("logged in from another")) {
    log("Duplicate login detected. Waiting 60s before reconnect...");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      createBot();
    }, 60000);
    return;
  }

  suspicionLevel++;
  adaptBehavior();
  scheduleReconnect("kicked");
}

function onEnd(reason) {
  log(`Connection ended: ${reason}`);
  stopAllLoops();
  isConnecting = false;
  if (
    reason === "socketClosed" ||
    reason === "ECONNREFUSED" ||
    reason === "timeout"
  ) {
    serverOffline = true;
    log("Server appears offline. Will retry every 15s.");
  }
  scheduleReconnect(reason || "end");
}

function onError(err) {
  log(`Error: ${err.message}`);
  stopAllLoops();
  isConnecting = false;
  if (err.code === "ECONNREFUSED" || err.message.includes("ECONNREFUSED")) {
    serverOffline = true;
    log("Server offline (ECONNREFUSED). Polling every 15s.");
  }
  scheduleReconnect("error");
}

// ─── Adapt behavior ───────────────────────────────────────────────────────────
function adaptBehavior() {
  const profiles = ["normal", "builder", "miner", "explorer"];
  const cur = profiles.indexOf(movementProfile);
  movementProfile =
    profiles[
      (cur + 1 + Math.floor(Math.random() * (profiles.length - 1))) %
        profiles.length
    ];
  log(`Behavior adapted → ${movementProfile} (suspicion: ${suspicionLevel})`);
  if (suspicionLevel >= 3)
    reconnectDelay = Math.min(reconnectDelay + 10000, 60000);
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function showHelp() {
  safeSay("god/pray <question> | tp <name> | tp base | a/accept | d/decline | x2");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeSay(msg) {
  try {
    if (bot && bot.entity) bot.chat(String(msg).slice(0, 250));
  } catch (_) {}
}

async function cmd(command) {
  try {
    if (bot && bot.entity) {
      bot.chat(command);
      await delay(180);
    }
  } catch (_) {}
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Crash guards ─────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  log(`[CRASH GUARD] ${err.message}`);
  if (!reconnectTimer && !isConnecting) scheduleReconnect("uncaughtException");
});
process.on("unhandledRejection", (r) => {
  log(`[REJECTION] ${r}`);
});

// ─── Signal traps ─────────────────────────────────────────────────────────────
function trapSignal(sig) {
  process.on(sig, () => {
    log(`[SIGNAL] Received ${sig} — staying alive.`);
    stopAllLoops();
    isConnecting = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    scheduleReconnect(`signal:${sig}`);
  });
}
trapSignal("SIGTERM");
trapSignal("SIGINT");
trapSignal("SIGHUP");

// ─── Boot ─────────────────────────────────────────────────────────────────────
log(
  `=== God bot starting | ${HOST}:${MC_PORT} | base: ${BASE_X},${BASE_Y},${BASE_Z} ===`,
);
createBot();
