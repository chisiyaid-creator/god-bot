const mineflayer = require('mineflayer');
      await bot.look((Math.random() * Math.PI * 2) - Math.PI, 0, false);
      await delay(randInt(200, 400));
      // If still blocked, skip walking this tick
      if (isBlockAhead()) return;
    }

    // Walk 2–5 blocks at walking speed (4.317 b/s) → 464–1158ms
    const blocks   = randInt(2, 5);
    const walkTime = Math.round((blocks / 4.317) * 1000) + randInt(-50, 80);
    bot.setControlState('forward', true);
    await delay(walkTime);
    bot.setControlState('forward', false);

    await delay(randInt(400, 1200));

    // Sometimes look around after stopping (very human)
    if (Math.random() < 0.45) {
      const lookYaw = bot.entity.yaw + ((Math.random() - 0.5) * Math.PI);
      await bot.look(lookYaw, (Math.random() - 0.5) * 0.4, false);
      await delay(randInt(600, 1800));
    }
    if (Math.random() < 0.25) bot.swingArm('right');
  }
}

// ─── Check if there's a solid block directly ahead at head height ─────────────
function isBlockAhead() {
  try {
    if (!bot || !bot.entity) return false;
    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;
    // 1 block ahead in facing direction
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const checkX = Math.floor(pos.x + dx * 1.2);
    const checkZ = Math.floor(pos.z + dz * 1.2);
    const checkY = Math.floor(pos.y + 0.5); // body level
    const block = bot.blockAt({ x: checkX, y: checkY, z: checkZ });
    const block2 = bot.blockAt({ x: checkX, y: checkY + 1, z: checkZ }); // head
    const solid = (b) => b && b.boundingBox === 'block';
    return solid(block) || solid(block2);
  } catch (_) { return false; }
}

function moveToXZ(x, z, timeoutMs) {
  return new Promise((resolve) => {
    const goal = new GoalXZ(Math.floor(x), Math.floor(z));
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      bot.removeListener('goal_reached', onReached);
      bot.removeListener('path_update',  onUpdate);
      try { bot.pathfinder.stop(); } catch (_) {}
      resolve();
    };

    const onReached = () => done();
    const onUpdate  = (r) => { if (r.status === 'noPath') done(); };

    bot.on('goal_reached', onReached);
    bot.on('path_update',  onUpdate);

    try { bot.pathfinder.setGoal(goal); } catch (_) { done(); return; }
    const t = setTimeout(done, timeoutMs);
  });
}

// ─── Look around ─────────────────────────────────────────────────────────────
function loopLookAround() {
  async function tick() {
    try {
      if (bot && bot.entity) {
        await bot.look((Math.random() * Math.PI * 2) - Math.PI, (Math.random() * 0.6) - 0.3, true);
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
        bot.setControlState('jump', true);
        await delay(180);
        bot.setControlState('jump', false);
      } else if (r < 0.66) {
        bot.setControlState('sprint', true);
        await delay(randInt(250, 600));
        bot.setControlState('sprint', false);
      } else {
        bot.swingArm(Math.random() < 0.5 ? 'right' : 'left');
      }
    } catch (_) {}
    const h = setTimeout(tick, randInt(20000, 50000));
    loopHandles.push(h);
  }
  const h = setTimeout(tick, randInt(12000, 20000));
  loopHandles.push(h);
}

// ─── Sleep check → set day ───────────────────────────────────────────────────
function loopSleepCheck() {
  async function tick() {
    try {
      if (!bot || !bot.players) return;
      const players = Object.values(bot.players).filter(p => p.entity);
      if (players.length === 0) return;
      const sleeping = players.filter(p =>
        p.entity && Array.isArray(p.entity.metadata) &&
        p.entity.metadata.some(m => m === 'sleeping')
      ).length;
      if (sleeping / players.length >= 0.5) {
        await cmd('/time set day');
        safeSay('Dawn breaks upon my world. Sleep well, mortals.');
      }
    } catch (_) {}
    const h = setTimeout(tick, 30000);
    loopHandles.push(h);
  }
  const h = setTimeout(tick, 30000);
  loopHandles.push(h);
}

// ─── Night boost ─────────────────────────────────────────────────────────────
let nightBoosted = false;
function loopNightBoost() {
  async function tick() {
    try {
      if (!bot || !bot.time) return;
      const t = bot.time.timeOfDay;
      const isNight = t >= 13000 && t <= 23000;
      if (isNight && !nightBoosted) {
        nightBoosted = true;
        const players = Object.keys(bot.players).filter(n => n !== BOT_NAME);
        for (const name of players) await cmd(`/effect give ${name} speed 120 2 true`);
        if (players.length > 0) safeSay('My blessing of speed watches over you through the night.');
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

// ─── Stage progression (silent — no chat announcements) ──────────────────────
function loopStageProgress() {
  stageTimer = setInterval(() => {
    stageIndex = (stageIndex + 1) % STAGES.length;
    if (stageIndex <= 1)      movementProfile = 'miner';
    else if (stageIndex <= 3) movementProfile = 'explorer';
    else                      movementProfile = 'builder';
    log(`Stage: ${STAGES[stageIndex]} | Profile: ${movementProfile}`);
  }, 8 * 60 * 1000);
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

// ─── Raw message parser — kill events & captcha ───────────────────────────────
function onRawMessage(jsonMsg) {
  const text = jsonMsg.toString();

  // Captcha / bot check
  if (/captcha|verify|human|robot|bot.?check/i.test(text)) {
    setTimeout(() => safeSay('I am a real player!'), 800 + Math.random() * 1200);
    return;
  }

  // Kill detection: "<victim> was slain by <killer>" / "was killed by" / "was shot by"
  const killMatch = text.match(/(\w+) was (?:slain|killed|shot|blown up) by (\w+)/i);
  if (killMatch) {
    const victim = killMatch[1];
    const killer = killMatch[2];
    if (killer !== BOT_NAME) handleKillEvent(killer, victim);
  }
}

// ─── PvP Punishment system ────────────────────────────────────────────────────
function handleKillEvent(killer, victim) {
  const now = Date.now();
  const TWO_MIN = 2 * 60 * 1000;

  if (!killLog.has(killer)) killLog.set(killer, []);
  const times = killLog.get(killer).filter(t => now - t < TWO_MIN);
  times.push(now);
  killLog.set(killer, times);

  log(`Kill: ${killer} → ${victim} (${times.length} kills in 2min)`);

  if (times.length >= 10 && !warnedKillers.has(killer)) {
    warnedKillers.add(killer);
    setTimeout(() => {
      safeSay(`⚠ ${killer}! You have killed ${victim} too many times. The gods are watching. Stop — or face divine punishment.`);
      setTimeout(() => {
        safeSay(`${killer}, this is your FINAL warning. One more kill and you shall be judged.`);
        // Reset warn after 5 min so they can get warned again
        setTimeout(() => { warnedKillers.delete(killer); killLog.delete(killer); }, 5 * 60 * 1000);
      }, 8000);
    }, 1500);
  }
}

// ─── Chat handler ─────────────────────────────────────────────────────────────
async function onChat(username, message) {
  if (username === BOT_NAME) return;
  const msg   = message.trim();
  const lower = msg.toLowerCase();
  log(`<${username}> ${msg}`);

  // Track 24hour activity
  if (username === '24hour') lastSeen24hour = Date.now();

  // Any message starting with "god" → AI reply as god
  if (lower === 'god' || lower.startsWith('god ') || lower.startsWith('god,') || lower.startsWith('god!')) {
    const question = msg.replace(/^god[\s,!]*/i, '').trim() || 'I call upon thee';
    handleGodChat(username, question);
    return;
  }

  // tp <player>
  const tpMatch = msg.match(/^tp\s+(\S+)$/i);
  if (tpMatch) {
    const target = tpMatch[1].toLowerCase();
    if (target === 'base') { await tpToBase(username); return; }
    await initiateTp(username, tpMatch[1]);
    return;
  }

  // a / accept
  if (lower === 'a' || lower === 'accept') { await handleAccept(username); return; }

  // d / decline
  if (lower === 'd' || lower === 'decline') { await handleDecline(username); return; }

  // x2
  if (lower === 'x2') { await handleX2(username); return; }

  // help
  if (lower === 'help') { showHelp(); return; }
}

// ─── God AI chat ──────────────────────────────────────────────────────────────
async function handleGodChat(username, question) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      max_completion_tokens: 60,
      messages: [
        { role: 'system', content:
            'You are "God" — an ancient, all-knowing deity watching over a Minecraft server. ' +
            'Speak in 1 short, powerful sentence. Be mystical, ancient, and slightly ominous. ' +
            'Max 180 characters. Never break character.'
        },
        { role: 'user', content: `${username} asks: ${question}` },
      ],
    });
    const reply = res.choices[0]?.message?.content?.trim() || 'The cosmos is silent.';
    safeSay(`[God] ${reply}`);
  } catch (err) {
    safeSay(`[God] The stars have no answer for you today, ${username}.`);
    log(`OpenAI err: ${err.message}`);
  }
}

// ─── TP system with 24hour deference ─────────────────────────────────────────
async function initiateTp(requester, target) {
  if (!bot.players[target]) {
    safeSay(`${target} is not online.`);
    return;
  }
  if (target === BOT_NAME) { await tpToBase(requester); return; }

  // Store the request
  tpRequests.set(target, { from: requester, expires: Date.now() + 30000 });

  const is24hOnline  = !!bot.players['24hour'];
  const is24hRecent  = (Date.now() - lastSeen24hour) < 2 * 60 * 1000;

  if (is24hOnline && is24hRecent) {
    // Let 24hour handle it — god stays silent, waits DEFER_TO_24H_MS
    log(`Deferring TP (${requester}→${target}) to 24hour bot`);
    const timer = setTimeout(async () => {
      // 24hour didn't act — god takes over
      if (tpRequests.has(target)) {
        log(`24hour didn't respond. God handles TP.`);
        await godHandleTp(requester, target);
      }
      pendingTpHandoffs.delete(target);
    }, DEFER_TO_24H_MS);
    pendingTpHandoffs.set(target, { from: requester, timer });
  } else {
    // 24hour offline or inactive — god handles immediately
    await godHandleTp(requester, target);
  }
}

async function godHandleTp(requester, target) {
  // Re-check request is still valid
  if (!tpRequests.has(target)) return;
  safeSay(`${requester} seeks ${target}. ${target} — accept (type "a") or decline ("d").`);
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
  if (h) { clearTimeout(h.timer); pendingTpHandoffs.delete(target); }
}

async function tpToBase(username) {
  await cmd(`/tp ${username} ${BASE_X} ${BASE_Y} ${BASE_Z}`);
  await delay(400);
  safeSay(`${username} stands at the base.`);
}

// ─── X2 starter pack ─────────────────────────────────────────────────────────
async function handleX2(username) {
  if (x2Claimed.has(username) && !x2DeathReset.has(username)) {
    safeSay(`${username}, you have already received this gift. Perish and return.`);
    return;
  }
  x2Claimed.add(username);
  x2DeathReset.delete(username);
  await cmd(`/give ${username} minecraft:cookie 10`);
  await delay(300);
  await cmd(`/give ${username} minecraft:cooked_porkchop 10`);
  safeSay(`${username} has received the gift of nourishment.`);
}

// ─── God gift (exclusive item, given once per player) ────────────────────────
async function grantGodGift(username) {
  if (giftedPlayers.has(username)) return;
  giftedPlayers.add(username);

  // Try to walk toward the player first
  await walkToPlayer(username);

  // Give only ONE type of exclusive item randomly
  const roll = Math.random();
  if (roll < 0.25) {
    // Netherite chestplate
    await cmd(`/give ${username} minecraft:netherite_chestplate 1`);
    await delay(300);
    await cmd(`/enchant ${username} protection 4`);
    await delay(300);
    await cmd(`/enchant ${username} unbreaking 3`);
    await delay(300);
    await cmd(`/enchant ${username} mending 1`);
    safeSay(`The gods bestow upon ${username} divine armour. Wear it with honour.`);
  } else if (roll < 0.5) {
    // Netherite sword
    await cmd(`/give ${username} minecraft:netherite_sword 1`);
    await delay(300);
    await cmd(`/enchant ${username} sharpness 5`);
    await delay(300);
    await cmd(`/enchant ${username} unbreaking 3`);
    await delay(300);
    await cmd(`/enchant ${username} mending 1`);
    safeSay(`${username} is worthy of this blade. Use it wisely.`);
  } else if (roll < 0.75) {
    // Netherite pickaxe
    await cmd(`/give ${username} minecraft:netherite_pickaxe 1`);
    await delay(300);
    await cmd(`/enchant ${username} efficiency 5`);
    await delay(300);
    await cmd(`/enchant ${username} fortune 3`);
    await delay(300);
    await cmd(`/enchant ${username} mending 1`);
    safeSay(`The earth yields to ${username}. A gift from the heavens.`);
  } else {
    // Golden apples
    await cmd(`/give ${username} minecraft:enchanted_golden_apple 5`);
    safeSay(`${username} holds the fruit of the gods. Guard it well.`);
  }
}

async function walkToPlayer(username) {
  if (!bot || !bot.players[username] || !bot.players[username].entity) return;
  const pos = bot.players[username].entity.position;
  await moveToXZ(pos.x, pos.z, 8000);
}

// ─── Player join / leave ─────────────────────────────────────────────────────
function onPlayerJoined(player) {
  log(`+ ${player.username} joined`);
  // Occasionally grant a gift to a real player on join (not every time, ~20% chance)
  if (player.username !== BOT_NAME && player.username !== '24hour') {
    if (Math.random() < 0.2 && !giftedPlayers.has(player.username)) {
      setTimeout(() => grantGodGift(player.username), 15000);
    }
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
  const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
  log(`Kicked: ${r}`);
  suspicionLevel++;
  adaptBehavior();
  stopAllLoops();
  isConnecting = false;
  scheduleReconnect(`kicked`);
}

function onEnd(reason) {
  log(`Connection ended: ${reason}`);
  stopAllLoops();
  isConnecting = false;
  // Detect server offline (ECONNREFUSED) vs normal disconnect
  if (reason === 'socketClosed' || reason === 'ECONNREFUSED' || reason === 'timeout') {
    serverOffline = true;
    log('Server appears offline. Will retry every 15s until it comes back.');
  }
  scheduleReconnect(reason || 'end');
}

function onError(err) {
  log(`Error: ${err.message}`);
  stopAllLoops();
  isConnecting = false;
  if (err.code === 'ECONNREFUSED' || err.message.includes('ECONNREFUSED')) {
    serverOffline = true;
    log('Server offline (ECONNREFUSED). Polling every 15s.');
  }
  scheduleReconnect(`error`);
}

// ─── Adapt behavior on suspicion ─────────────────────────────────────────────
function adaptBehavior() {
  const profiles = ['normal','builder','miner','explorer'];
  const cur = profiles.indexOf(movementProfile);
  movementProfile = profiles[(cur + 1 + Math.floor(Math.random() * (profiles.length - 1))) % profiles.length];
  log(`Behavior adapted → ${movementProfile} (suspicion: ${suspicionLevel})`);
  if (suspicionLevel >= 3) reconnectDelay = Math.min(reconnectDelay + 10000, 60000);
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function showHelp() {
  safeSay('tp <name> | tp base | a/d (accept/decline) | x2 (starter pack) | god <question>');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function safeSay(msg) {
  try {
    if (bot && bot.entity) bot.chat(String(msg).slice(0, 250));
  } catch (_) {}
}

async function cmd(command) {
  try {
    if (bot && bot.entity) { bot.chat(command); await delay(180); }
  } catch (_) {}
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── Global crash guards ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log(`[CRASH GUARD] ${err.message}`);
  if (!reconnectTimer && !isConnecting) scheduleReconnect('uncaughtException');
});
process.on('unhandledRejection', (r) => {
  log(`[REJECTION] ${r}`);
});

// ─── Signal traps — prevent the process from dying on SIGTERM/SIGINT ─────────
// If Replit or OS sends a kill signal, we intercept it and just reconnect.
// The process will ONLY exit if Replit's workflow runner stops it forcibly.
function trapSignal(sig) {
  process.on(sig, () => {
    log(`[SIGNAL] Received ${sig} — ignoring, staying alive.`);
    stopAllLoops();
    isConnecting = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    scheduleReconnect(`signal:${sig}`);
  });
}
trapSignal('SIGTERM');
trapSignal('SIGINT');
trapSignal('SIGHUP');

// ─── Nuclear failsafe — if process.exit is called anywhere, restart bot ───────
// (Prevents library code from killing the process silently)
const _origExit = process.exit.bind(process);
process.exit = (code) => {
  log(`[FAILSAFE] process.exit(${code}) intercepted — restarting bot instead.`);
  stopAllLoops();
  isConnecting = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Give a short grace then reconnect; if truly broken, exit so workflow restarts
  setTimeout(() => {
    try { createBot(); } catch (_) { _origExit(1); }
  }, 3000);
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
log(`=== god bot v3 starting | ${HOST}:${PORT} | base: ${BASE_X},${BASE_Y},${BASE_Z} ===`);
createBot();
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('God is eternal');
}).listen(process.env.PORT || 3000);
