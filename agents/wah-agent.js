import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import twilio from "twilio";

const SANDBOXD_URL = process.env.SANDBOXD_URL || "http://127.0.0.1:9090";
const SANDBOXD_API_KEY = process.env.SANDBOXD_API_KEY || "";
const AGENT = process.env.WAH_AGENT || "opencode";
const MODEL = process.env.WAH_MODEL || undefined;
const PROVIDER = process.env.WAH_PROVIDER || undefined;
const PRESET = process.env.WAH_PRESET || "react-vite";
const MAX_TASKS = Number.parseInt(process.env.WAH_MAX_TASKS || "40", 10);
const TASK_TIMEOUT_S = Number.parseInt(process.env.WAH_TASK_TIMEOUT_S || "900", 10);
const STATE_FILE = process.env.WAH_STATE_FILE || path.resolve("data/users.json");
const TALKER_MODEL = process.env.WAH_TALKER_MODEL || "anthropic/claude-haiku-5.5";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const PUBLIC_HOST = process.env.WAH_PUBLIC_HOST || process.env.TWILIO_VOICE_PUBLIC_DOMAIN || "walk.dweller.sh";
const WALL_URL = `https://${PUBLIC_HOST}/wall`;
const PROMPT_TURNS = 30;

const state = loadState();
const locks = new Map();
let tacRef = null;
let twilioClient = null;

export function attachTAC(tac) {
  tacRef = tac;
}

export const MASTHEAD = [
  "WALK & HACK — AI Tinkerers NYC x Twilio",
  "You're texting a coding agent. Tell it what to build (text or call this number) and it builds a real web app and texts you the link. Then just say what to change.",
  "Under the hood: Twilio Agent Connect handles the phone + memory, each caller gets a private sandbox, and Claude does the building. Builds are on us today.",
  `Everything built shows up at ${WALL_URL}. Tell me your name if you want it on there.`,
  'Try: "make a page that counts pigeons". Reply STOP to opt out.',
].join("\n\n");

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const u of Object.values(s.users || {})) {
      u.turns ||= [];
      u.running = null;
      u.pending = null;
    }
    return s;
  } catch {
    return { users: {} };
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function now() {
  return new Date().toISOString();
}

function userKey(context) {
  const phone = String(context.session?.authorInfo?.address || context.author || "").replace(/^(sms|voice|whatsapp|rcs):/i, "");
  const key = context.profileId || phone.replace(/[^0-9+]/g, "") || "anon";
  if (!state.users[key]) {
    state.users[key] = {
      phone, appId: null, sandboxId: null, link: null, title: null, name: null,
      tasks: 0, running: null, pending: null, turns: [], optedOut: false, createdAt: now(),
    };
    saveState();
  }
  const user = state.users[key];
  if (phone && !user.phone) user.phone = phone;
  return key;
}

function addTurn(user, turn) {
  user.turns.push({ t: now(), ...turn });
  user.updatedAt = now();
  saveState();
}

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// ---------- sandboxd ----------

async function sb(method, route, body) {
  const res = await fetch(`${SANDBOXD_URL}${route}`, {
    method,
    headers: { Authorization: `Bearer ${SANDBOXD_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`sandboxd ${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

function publicUrl(url) {
  if (!url) return url;
  return url.replace(/^http:\/\//, "https://").replace(/:\d+(\/|$)/, "$1");
}

async function ensureApp(key) {
  const user = state.users[key];
  if (user.appId && user.sandboxId) return user;
  const list = await sb("GET", `/v1/apps?external_user_id=${encodeURIComponent(key)}`);
  let app = (list.apps || []).find((a) => a.current_sandbox_id) || (list.apps || [])[0];
  if (!app) {
    const last4 = (user.phone || key).slice(-4);
    app = await sb("POST", "/v1/apps", {
      name: `wah-${last4}-${Date.now().toString(36)}`,
      external_user_id: key,
      runtime_preset: PRESET,
      tags: ["walk-and-hack"],
    });
  }
  user.appId = app.id;
  user.sandboxId = app.current_sandbox_id || null;
  if (!user.sandboxId) {
    try {
      const created = await sb("POST", `/v1/apps/${app.id}/sandbox`, {});
      user.sandboxId = created.id || created.sandbox_id || created.current_sandbox_id || null;
    } catch (error) {
      if (!/409/.test(error.message)) throw error;
      const fresh = await sb("GET", `/v1/apps/${app.id}`);
      user.sandboxId = fresh.current_sandbox_id || null;
    }
  }
  if (!user.sandboxId) throw new Error("could not create a sandbox for app " + app.id);
  saveState();
  return user;
}

async function waitSandboxRunning(sandboxId) {
  let woke = false;
  for (let i = 0; i < 80; i += 1) {
    const s = await sb("GET", `/v1/sandboxes/${sandboxId}`);
    if (s.status === "running") return s;
    if (s.status === "error") throw new Error("sandbox is in error state");
    if (s.status === "stopped" && !woke) {
      woke = true;
      console.log(`[wah] sandbox ${sandboxId} is stopped (idle reaper); waking`);
      try {
        const started = await sb("POST", `/v1/sandboxes/${sandboxId}/start`);
        if (started?.status === "running") return started;
      } catch (e) {
        console.log(`[wah] wake failed for ${sandboxId}: ${e.message}`);
      }
    }
    await sleep(3000);
  }
  throw new Error("sandbox did not reach running state");
}

async function previewUrl(sandboxId) {
  const s = await sb("GET", `/v1/sandboxes/${sandboxId}`);
  return { url: publicUrl(s.preview?.url), status: s.preview?.status };
}

// ---------- builds ----------

function startBuild(key, instructions, title, channel, conversationId) {
  const user = state.users[key];
  if (user.running) {
    user.pending = { instructions: user.pending ? `${user.pending.instructions}\n\nAlso: ${instructions}` : instructions, channel, conversationId };
    if (title && !user.title) user.title = title;
    saveState();
    return { status: "queued", note: "A build is already running. This will be folded into the next build automatically when it finishes." };
  }
  if (user.tasks >= MAX_TASKS) return { status: "budget", note: `Build budget for today is used up (${MAX_TASKS} builds). Find Jon on the walk.` };
  if (title) user.title = title;
  user.running = { taskId: null, startedAt: now(), instructions, channel, conversationId };
  saveState();
  runBuild(key, instructions).catch((e) => console.error("[wah] runBuild crashed", e));
  return { status: "started", note: user.sandboxId ? "Build started. Takes about a minute." : "Workshop is being set up and the first build started. Takes a few minutes." };
}

async function runBuild(key, instructions) {
  const user = state.users[key];
  const { channel, conversationId } = user.running;
  let event;
  try {
    await ensureApp(key);
    await waitSandboxRunning(user.sandboxId);
    const task = await sb("POST", `/v1/sandboxes/${user.sandboxId}/tasks`, {
      prompt: instructions,
      agent: AGENT,
      ...(MODEL ? { model: MODEL } : {}),
      ...(PROVIDER ? { provider: PROVIDER } : {}),
      continue: true,
      timeout_s: TASK_TIMEOUT_S,
    });
    user.running.taskId = task.id;
    user.tasks += 1;
    saveState();
    console.log(`[wah] ${key} task ${task.id} started`);

    let result;
    const deadline = Date.now() + (TASK_TIMEOUT_S + 120) * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      result = await sb("GET", `/v1/sandboxes/${user.sandboxId}/tasks/${task.id}`);
      if (result.status && result.status !== "running") break;
    }
    const { url } = await previewUrl(user.sandboxId);
    user.link = url;
    if (result?.status === "succeeded") {
      const summary = String(result.agent_message || "").trim().slice(0, 400);
      const broken = result.build_status === "failed";
      event = { ok: true, link: url, summary, broken };
    } else if (result?.status === "running" || !result) {
      event = { ok: false, link: url, summary: `Still building after ${Math.round(TASK_TIMEOUT_S / 60)} minutes; it may land on its own.` };
    } else {
      event = { ok: false, link: url, summary: `Build failed: ${String(result.error_message || result.failure_reason || result.status).slice(0, 200)}` };
    }
    console.log(`[wah] ${key} task ${task.id} ${result?.status}`);
  } catch (error) {
    console.error(`[wah] ${key} build failed:`, error.message);
    event = { ok: false, link: user.link, summary: `Something broke on our side: ${error.message.slice(0, 160)}` };
  }

  await withLock(key, async () => {
    user.running = null;
    addTurn(user, { role: "event", text: buildEventText(event) });
    const pending = user.pending;
    user.pending = null;
    saveState();

    const sms = event.ok
      ? `Done: ${event.link}${event.summary ? `\n\n${event.summary}` : ""}${event.broken ? "\n\n(The build step reported an error, so the page may not have updated. Text me what you see.)" : ""}${pending ? "\n\nStarting on the next thing you asked for now." : "\n\nText or call me with what to change."}`
      : `${event.summary}${event.link ? `\nYour app: ${event.link}` : ""}\n\nText me again with what you want and I'll retry.`;
    await notifyDone(user, channel, conversationId, sms, event, Boolean(pending));

    if (pending) {
      addTurn(user, { role: "event", text: "Queued changes are now being built." });
      startBuild(key, pending.instructions, null, pending.channel || channel, pending.conversationId || conversationId);
    }
  });
}

function buildEventText(e) {
  if (e.ok) return `Build finished. Link: ${e.link}. Agent summary: ${e.summary || "(none)"}${e.broken ? " WARNING: the dev build reported an error; the page may not reflect the change." : ""}`;
  return `Build did not succeed. ${e.summary}${e.link ? ` Link: ${e.link}` : ""}`;
}

async function notifyDone(user, channel, conversationId, sms, event, hasPending) {
  try { await sendText(user, channel === "sms" ? conversationId : null, sms); } catch (e) { console.error("[wah] done text failed:", e.message); }
  if (channel !== "voice") return;
  const voice = tacRef?.getChannel?.("voice");
  const spoken = event.ok
    ? `Your build just finished${user.title ? `: ${user.title}` : ""}. The link is in your texts.${hasPending ? " I'm starting on the next change now." : " Want to change anything?"}`
    : `Heads up, that build didn't land. ${event.summary.slice(0, 120)}. Tell me again what you want and I'll retry.`;
  if (voice && conversationId && voice.isConversationActive?.(conversationId)) {
    try { await voice.sendResponse(conversationId, spoken); return; } catch (e) { console.warn("[wah] voice sendResponse failed:", e.message); }
  }
  if (!voice || !user.phone || hasPending) return;
  try {
    await voice.initiateOutboundConversation({
      to: user.phone,
      conversationRelayConfig: { url: `wss://${PUBLIC_HOST}/ws`, welcomeGreeting: `Hey, it's Walk and Hack. ${spoken}`, welcomeGreetingInterruptible: "any" },
    });
    addTurn(user, { role: "event", text: "Called the caller back to say the build finished." });
  } catch (e) {
    console.warn("[wah] callback call failed:", e.message);
  }
}

async function sendText(user, conversationId, text) {
  const channel = tacRef?.getChannel?.("sms");
  if (channel && conversationId && channel.isConversationActive?.(conversationId)) {
    try { await channel.sendResponse(conversationId, text); return; } catch (error) {
      console.warn("[wah] TAC sendResponse failed, falling back to REST:", error.message);
    }
  }
  if (!user.phone) { console.error("[wah] no phone for user; cannot send:", text); return; }
  if (!twilioClient) {
    twilioClient = twilio(process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { accountSid: process.env.TWILIO_ACCOUNT_SID });
  }
  await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: user.phone, body: text });
}

// ---------- the talker ----------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "build",
      description: "Hand instructions to the caller's coding agent to create or change their web app. Call this whenever the caller has described something to make or change. When in doubt, call it.",
      parameters: {
        type: "object",
        properties: {
          instructions: { type: "string", description: "A complete, specific spec for a coding agent, written from the whole conversation: what to build or change, look, behavior. Fold in anything the caller asked for that has not been built yet. Do not repeat things already built unless they are changing." },
          title: { type: "string", description: "A short title for the caller's project, 2-5 words, e.g. 'Pigeon Counter'. Keep the existing title unless the project changed." },
        },
        required: ["instructions", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_name",
      description: "Record the caller's name for the live wall, only when they tell you their name or ask to be credited.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  },
];

function systemPrompt(user, channel, memory) {
  const voice = channel === "voice";
  const lines = [
    "You are the Walk & Hack build line: AI Tinkerers NYC x Twilio, a Saturday walk through Central Park where people build web apps by text or by phone call. The caller is an attendee. You talk, and you have one hand: the build tool.",
    "",
    voice
      ? "CHANNEL: VOICE. The caller is on a phone call outdoors. Reply in one or two short spoken sentences. No lists, no URLs, no markdown. If they need the link, say it's in their texts (it is texted automatically after every build)."
      : "CHANNEL: SMS. Keep replies short, plain text, no markdown. You may include the app link if it is in the transcript.",
    "",
    "HOW TO BEHAVE",
    "- When the caller describes something to make or change, call build. Write the instructions as a full spec for a coding agent, drawing on the whole conversation. If unsure whether they want a build or a chat, build; a wasted minute is cheaper than ignoring them.",
    "- Read it back: in the same reply as a build, say in one line what you're building, e.g. 'Orange pigeon counter with a big button, building now.' That is how park-noise mistakes get caught.",
    "- If build returns 'queued', tell them you'll fold it in right after the current build. If it returns 'budget', say so and point them to Jon.",
    "- Never say a link exists or that something is done unless a build-finished event in the transcript says so. Never invent a URL.",
    "- A build takes about a minute, the first one a few minutes. The link is always texted when it lands. If they are on a call when it finishes, you'll hear about it in the transcript; if they hung up, they get a call back.",
    "- Greet returning callers like you remember them (you do: the transcript and Twilio memory are below). Don't re-explain the product to someone who has already built something.",
    "- Small talk is fine; keep it brief and steer back to building.",
    "- If they ask what this is or how it works: Twilio Agent Connect handles the phone and memory, each caller gets a private sandbox, Claude does the building, Jon from AI Tinkerers built the bridge. Honest and short.",
    "- If they give their name, call set_name. Builds appear on the live wall (" + WALL_URL + ") with the project title, and their name only if they gave it. Never mention phone numbers.",
    "- Say 'reply STOP to opt out' only if asked how to stop.",
    "",
    `CALLER STATE: ${user.title ? `project "${user.title}"` : "no project yet"}; ${user.link ? `current link ${user.link}` : "no link yet"}; ${user.running ? "a build is running right now" : "no build running"}; ${user.pending ? "changes are queued for the next build" : ""}; ${user.name ? `name ${user.name}` : "name not given"}; builds so far ${user.tasks}.`,
  ];
  const mem = memoryText(memory);
  if (mem) lines.push("", "TWILIO MEMORY (from past conversations):", mem);
  return lines.join("\n");
}

function memoryText(memory) {
  if (!memory) return "";
  const out = [];
  try {
    for (const s of memory.summaries || []) out.push(`summary: ${s.summary || s.text || JSON.stringify(s)}`.slice(0, 400));
    for (const o of memory.observations || []) out.push(`note: ${o.observation || o.text || JSON.stringify(o)}`.slice(0, 200));
  } catch { /* ignore */ }
  return out.slice(0, 12).join("\n");
}

function toMessages(user, channel, memory) {
  const msgs = [{ role: "system", content: systemPrompt(user, channel, memory) }];
  const turns = user.turns.slice(-PROMPT_TURNS);
  for (const t of turns) {
    if (t.role === "user") msgs.push({ role: "user", content: `[${t.ch || "sms"}] ${t.text}` });
    else if (t.role === "assistant") msgs.push({ role: "assistant", content: t.text || "" });
    else if (t.role === "event") msgs.push({ role: "user", content: `[event, not from the caller] ${t.text}` });
  }
  if (msgs.length > 1 && msgs[1].role !== "user") msgs.splice(1, 0, { role: "user", content: "[event] conversation start" });
  return msgs;
}

async function openrouter(messages, tools) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": `https://${PUBLIC_HOST}`, "X-Title": "Walk & Hack" },
      body: JSON.stringify({ model: TALKER_MODEL, messages, tools, tool_choice: "auto", max_tokens: 1500, temperature: 0.4 }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(`openrouter ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
    return data.choices[0].message;
  } finally {
    clearTimeout(timer);
  }
}

async function talk(key, channel, conversationId, memory) {
  const user = state.users[key];
  const messages = toMessages(user, channel, memory);
  let reply = "";
  for (let i = 0; i < 3; i += 1) {
    const msg = await openrouter(messages, TOOLS);
    if (msg.content) reply = String(msg.content).trim();
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { console.warn("[wah] tool args unparsable:", String(call.function.arguments).slice(0, 200)); }
      let result;
      if (call.function.name === "build") {
        const lastUser = [...user.turns].reverse().find((t) => t.role === "user")?.text || "";
        const instructions = String(args.instructions || "").trim() || `Apply this change to the existing app: ${lastUser}`;
        result = startBuild(key, instructions, String(args.title || "").slice(0, 60) || null, channel, conversationId);
        addTurn(user, { role: "event", text: `build tool called (${result.status}) with title "${user.title || args.title}" and instructions: ${instructions.slice(0, 300)}` });
      } else if (call.function.name === "set_name") {
        user.name = String(args.name || "").slice(0, 40) || null;
        saveState();
        result = { status: "ok", note: `Name recorded: ${user.name}` };
      } else {
        result = { status: "error", note: "unknown tool" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return reply;
}

function fallbackReply(key, text, channel, conversationId) {
  const r = startBuild(key, text, null, channel, conversationId);
  if (r.status === "started") return channel === "voice" ? "Got it, building that now. I'll text you the link." : "On it. Building now; I'll text you the link in a minute.";
  if (r.status === "queued") return channel === "voice" ? "Got it, I'll add that right after the current build." : "Got it. I'll fold that in right after the current build finishes.";
  return r.note;
}

export async function handleAgentMessage(userMessage, context = {}) {
  const key = userKey(context);
  const user = state.users[key];
  const text = String(userMessage || "").trim();
  const channel = context.channel === "voice" ? "voice" : "sms";
  const word = text.toLowerCase().replace(/[^a-z]/g, "");

  if (word === "stop" || word === "unsubscribe" || word === "cancel") {
    user.optedOut = true;
    saveState();
    return channel === "voice" ? "Okay, I won't text you again. Bye." : null;
  }
  if (word === "start" || word === "unstop") { user.optedOut = false; saveState(); }
  if (!text) return channel === "voice" ? "I didn't catch that. Tell me what you'd like to build." : MASTHEAD;

  return withLock(key, async () => {
    const firstContact = user.turns.length === 0;
    addTurn(user, { role: "user", ch: channel, text });
    let reply;
    try {
      reply = OPENROUTER_API_KEY ? await talk(key, channel, context.conversationId, context.memory) : "";
    } catch (e) {
      console.error("[wah] talker failed:", e.message);
      reply = "";
    }
    if (!reply) reply = fallbackReply(key, text, channel, context.conversationId);
    addTurn(user, { role: "assistant", ch: channel, text: reply });

    if (firstContact) {
      if (channel === "sms") return `${MASTHEAD}\n\n${reply}`;
      sendText(user, null, MASTHEAD).catch((e) => console.warn("[wah] masthead text failed:", e.message));
    }
    return reply;
  });
}

// ---------- the wall ----------

export async function publicBuilds() {
  for (const u of Object.values(state.users)) {
    if (u.sandboxId && !u.link && u.tasks > 0) {
      try { u.link = (await previewUrl(u.sandboxId)).url; saveState(); } catch { /* next time */ }
    }
  }
  return Object.values(state.users)
    .filter((u) => u.link && u.tasks > 0)
    .map((u) => ({ title: u.title || "Untitled build", name: u.name || null, link: u.link, builds: u.tasks, updatedAt: u.updatedAt || u.createdAt, building: Boolean(u.running) }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
