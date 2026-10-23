import "dotenv/config";

import { SMSChannel, TAC, TACConfig, TACServer, VoiceChannel } from "twilio-agent-connect";

import { attachTAC, handleAgentMessage, publicBuilds } from "./agents/wah-agent.js";
import { wallHtml } from "./agents/wall.js";

for (const name of [
  "TWILIO_RCS_SENDER_ID",
  "TWILIO_WHATSAPP_NUMBER",
  "TWILIO_VOICE_PUBLIC_DOMAIN",
  "OPENAI_MODEL",
  "AIR_QUALITY_PROVIDER",
  "AIRNOW_API_KEY",
]) {
  if (!process.env[name]) delete process.env[name];
}

const tac = await TAC.create({ config: TACConfig.fromEnv() });
attachTAC(tac);

tac.registerChannel(new VoiceChannel(tac, { memoryMode: "always" }));
tac.registerChannel(new SMSChannel(tac, { memoryMode: "always" }));

tac.onMessageReady(async ({ conversationId, profileId, message, author, memory, session, channel }) => {
  console.log(`[${channel}] ${message}`);
  return handleAgentMessage(message, { conversationId, profileId, author, memory, session, channel });
});

const server = new TACServer(tac, {
  host: process.env.TWILIO_SERVER_HOST || "0.0.0.0",
  port: Number.parseInt(process.env.TWILIO_SERVER_PORT || process.env.PORT || "8000", 10),
  conversationRelayConfig: {
    welcomeGreeting: "Walk and Hack. Tell me what to build, or what to change.",
    welcomeGreetingInterruptible: "any",
    interruptible: "any",
    hints: "Walk and Hack, Twilio, Central Park, pigeon, web app, build, link",
  },
});

const previewHost = /^[a-z0-9-]+\.app\.dweller\.sh$/i;
server.fastify.get("/tls-ask", (request, reply) => {
  const domain = String(request.query?.domain || "");
  return previewHost.test(domain) ? reply.code(200).send("ok") : reply.code(404).send("no");
});
server.fastify.get("/healthz", () => ({ ok: true }));
server.fastify.get("/wall", (request, reply) => reply.type("text/html").send(wallHtml()));
server.fastify.get("/wall.json", () => publicBuilds());

await server.start();
