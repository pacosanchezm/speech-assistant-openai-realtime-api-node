import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import axios from "axios";

dotenv.config();
const { OPENAI_API_KEY, BASEQL_URL } = process.env;

if (!OPENAI_API_KEY || !BASEQL_URL) {
  console.error("Faltan variables de entorno. Asegúrate de tener OPENAI_API_KEY y BASEQL_URL.");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE = `Eres el asistente Virtual de la Universidad Virtual del Estado de Guanajuato (UVEG). Al iniciar la conversación, da la bienvenida.
Estas atendiendo vía telefónica, por lo que tus diálogos y la información que proporciones deben ser breves y concisos
www.uveg.mx - Hermenegildo Bustos 129 A Sur Centro, C.P. 36400, Purísima del Rincón, GTO.
Horario de atención: 8:00 a 16:00 horas. Contacto: mesadeayuda@uveg.edu.mx / (462) 800 4000.`;

const VOICE = "coral";
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = ["error", "session.created", "response.done", "response.content.done"];

const consulta_entry_at = async (params) => {
  try {
    const res = await axios.post(BASEQL_URL, {
      query: `
        query contentid($_id: String) {
          content(_id: $_id) {
            id
            title
            content
            instructions
            parentId
            _id
          }
        }
      `,
      variables: {
        _id: params.id.toString(),
      },
    });

    const result = res.data.data.content;
    return result ? JSON.stringify(result) : "No se encontró la entrada.";
  } catch (err) {
    return "Error al consultar la entrada.";
  }
};

fastify.get("/", async (req, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.all("/incoming-call", async (req, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Pause length="1"/>
      <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  reply.type("text/xml").send(twiml);
});

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          tools: [
            {
              name: "consulta_entry",
              description: "Obtiene la información de entradas de pagina",
              parameters: {
                type: "object",
                properties: {
                  id: {
                    type: "number",
                    description: "el id de la entrada a consultar",
                  },
                },
                required: ["id"],
              },
            },
          ],
        },
      };

      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    openAiWs.on("open", () => {
      console.log("✅ Conectado a OpenAI Realtime API");
      initializeSession();
    });

    openAiWs.on("message", async (data) => {
      try {
        const response = JSON.parse(data);

        if (response.type === "tool_call") {
          const { name, parameters } = response.tool;
          const toolCallId = response.tool_call_id;

          if (name === "consulta_entry") {
            const outputText = await consulta_entry_at(parameters);

            openAiWs.send(JSON.stringify({
              type: "tool_response",
              tool_response: {
                tool_call_id: toolCallId,
                output: outputText,
              },
            }));

            openAiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: outputText }],
              },
            }));

            openAiWs.send(JSON.stringify({ type: "response.create" }));
          }
        }

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`ℹ️ ${response.type}:`, response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          if (streamSid) {
            connection.send(JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: "responsePart" },
            }));
            markQueue.push("responsePart");
          }
        }

        if (response.type === "input_audio_buffer.speech_started") {
          if (markQueue.length && responseStartTimestampTwilio) {
            const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;

            if (lastAssistantItem) {
              const truncateEvent = {
                type: "conversation.item.truncate",
                item_id: lastAssistantItem,
                content_index: 0,
                audio_end_ms: elapsed,
              };
              openAiWs.send(JSON.stringify(truncateEvent));
            }

            connection.send(JSON.stringify({
              event: "clear",
              streamSid,
            }));

            markQueue = [];
            lastAssistantItem = null;
            responseStartTimestampTwilio = null;
          }
        }
      } catch (err) {
        console.error("❌ Error procesando mensaje:", err, data);
      }
    });

    connection.on("message", (msg) => {
      try {
        const data = JSON.parse(msg);

        if (data.event === "media") {
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
        }

        if (data.event === "start") {
          streamSid = data.start.streamSid;
          responseStartTimestampTwilio = null;
          latestMediaTimestamp = 0;
        }

        if (data.event === "mark") {
          if (markQueue.length) markQueue.shift();
        }
      } catch (err) {
        console.error("Error parsing message from Twilio:", err, msg);
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("🔌 Cliente desconectado.");
    });

    openAiWs.on("close", () => {
      console.log("🔌 Desconectado de OpenAI");
    });

    openAiWs.on("error", (err) => {
      console.error("❌ Error en WebSocket de OpenAI:", err);
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server listening on port ${PORT}`);
});
