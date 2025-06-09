import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import fastifyFormBody from "@fastify/formbody";

import dotenv from "dotenv";
import WebSocket from "ws";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-xxx"; // Pon tu key
const VOICE = "coral";
const PORT = process.env.PORT || 5050;

const SYSTEM_MESSAGE = "Eres el asistente Virtual de la Universidad Virtual del Estado de Guanajuato (UVEG). Al iniciar la conversacion, debes llamar la tool consulta_entry con el id 5 y menciona el tema que te devuelve la tool.";

// --- Fastify init
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.get("/", async (req, rep) => {
  rep.send({ ok: true });
});

// --- Twilio entrypoint: devuelve el XML para conectar el stream
fastify.all("/incoming-call", async (req, rep) => {
  const host = req.headers.host;
  rep.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${host}/media-stream" />
      </Connect>
    </Response>
  `.trim());
});

// --- WebSocket de media stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected (Twilio media stream)");
    let streamSid = null;

    // Abre conexión con OpenAI
    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2025-06-03",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // 1. Session.update al abrir OpenAI
    openAiWs.on("open", () => {
      console.log("Connected to OpenAI");

      // Session.update con tool
      openAiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
          tools: [
            {
              name: "consulta_entry",
              type: "function",
              description: "Obtiene la información de entradas",
              parameters: {
                type: "object",
                properties: {
                  id: {
                    type: "integer",
                    description: "el id de la entrada a consultar",
                  },
                },
                required: ["id"],
              },
            },
          ],
          tool_choice: "auto",
        }
      }));

      // Manda el primer mensaje del usuario tras breve delay
      setTimeout(() => {
        openAiWs.send(JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Hola" }
            ]
          }
        }));
        openAiWs.send(JSON.stringify({ type: "response.create" }));
      }, 800); // Suficiente para evitar race conditions
    });

    // Procesa los mensajes de OpenAI
    openAiWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === "tool_call") {
          console.log("Tool call recibida:", msg);
          // Simulación: responde con un string, podrías llamar a tu base o lo que gustes
          openAiWs.send(JSON.stringify({
            type: "tool_response",
            tool_response: {
              tool_call_id: msg.tool_call_id,
              output: "La entrada 5 es sobre becas deportivas."
            }
          }));
          // Fuerza el siguiente turno de respuesta
          openAiWs.send(JSON.stringify({ type: "response.create" }));
        }

        // Manda audio a Twilio si hay delta de audio
        if (msg.type === "response.audio.delta" && msg.delta) {
          if (streamSid) {
            connection.send(JSON.stringify({
              event: "media",
              streamSid: streamSid,
              media: { payload: msg.delta }
            }));
          }
        }

        // Guarda el streamSid cuando inicie el stream
        if (msg.type === "response.done") {
          // Log opcional
        }
      } catch (e) {
        console.error("Error en WS:", e);
      }
    });

    // Procesa los mensajes de Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        if (data.event === "start") {
          streamSid = data.start.streamSid;
          console.log("Twilio stream started", streamSid);
        }
        // Recibe audio del usuario y mándalo al buffer de OpenAI si lo deseas (omito por minimal)
      } catch (e) {
        console.error("Error en mensaje Twilio:", e);
      }
    });

    // Limpia todo al cerrar
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Twilio client disconnected.");
    });

    openAiWs.on("close", () => {
      console.log("Disconnected from OpenAI Realtime API");
    });

    openAiWs.on("error", (err) => {
      console.error("Error en OpenAI WS:", err);
    });
  });
});

// --- Arranca el server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
