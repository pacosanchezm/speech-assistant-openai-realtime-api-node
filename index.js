import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE =
  "Eres el asistente Virtual de la Universidad Virtual del Estado de Guanajuato (UVEG). Al iniciar la conversación, da la bienvenida.\nEstas atendiendo vía telefónica, por lo que tus diálogos y la información que proporciones deben ser breves y concisos\n\nDatos de la universidad:\n- www.uveg.mx\n- Hermenegildo Bustos 129 A Sur Centro, C.P. 36400, Purísima del Rincón, GTO.\nHorario de atención de oficina: 8:00 a 16:00 horas\n\n## Atención ciudadana (Mesa de ayuda)\nmesadeayuda@uveg.edu.mx\n(462) 800 4000\n\n## Carreras Disponibles\nLicenciatura en Marketing Digital\nLicenciatura en Contaduría Pública\nIngeniería en Desarrollo de Software\nLicenciatura en Ciencias del Comportamiento Humano\nLicenciatura en Derecho\nLicenciatura en Pedagogía\nLicenciatura en Administración del Capital Humano\nLicenciatura en Administración de las Finanzas\nLicenciatura en Gestión y Desarrollo Empresarial\nIngeniería en Sistemas Computacionales\nIngeniería en Gestión de Proyectos\nIngeniería Industrial\nIngeniería en Gestión de Tecnologías de Información\n\n# Requisitos\n- Acta de Nacimiento\n- CURP\n- Certificado de término de estudios de Bachillerato\n\n## Detalle de Costos vigentes para 2025 en Carreras Profesionales (todos los precios son en mxn) \n\n- Examen de Ubicación (EXU)*\n(Incluye curso de inducción y una credencial de alumno cuando se complete su inscripción) $489.00\n- Aportación de recuperación por materia (módulo) mensual: $335.00\n- Recursamiento de módulo (materia): $392.00\n- Examen de Recuperación de módulo (materia): $335.00\n- Aportación por estadía profesional: $335.00\n- Examen global: $335.00\n\nNota: Para alumnos extranjeros, las cuotas señaladas en esta tabla son al doble.";
const VOICE = "coral";
const PORT = process.env.PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get("/", async (request, reply) => {
  console.log("✅ Recibí una solicitud GET /");

  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all("/incoming-call", async (request, reply) => {
  console.log("✅ Twilio llamó a /incoming-call");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say></Say>
                              <Pause length="1"/>
                              <Say></Say>
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected");

    // Connection-specific state
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

    // Control initial session with OpenAI
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
          temperature: 0.8,
          tools: [
            {
              name: "consulta_entry",
              description: "Obtiene la información de entradas de pagina",
              strict: false, // ← IMPORTANTE para permitir llamadas más flexibles
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

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Uncomment the following line to have AI speak first:
      sendInitialConversationItem();
    };

    // Send initial conversation item if AI talks first
    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: 'Saluda al usuario con un "Hola! soy el asistente virtual de la Universidad Virtual del Estado de Guanajuato, en que puedo ayudarte?"',
            },
          ],
        },
      };

      if (SHOW_TIMING_MATH)
        console.log(
          "Sending initial conversation item:",
          JSON.stringify(initialConversationItem)
        );
      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    // Handle interruption when the caller's speech starts
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH)
          console.log(
            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
          );

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          if (SHOW_TIMING_MATH)
            console.log(
              "Sending truncation event:",
              JSON.stringify(truncateEvent)
            );
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid: streamSid,
          })
        );

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // Send mark messages to Media Streams so we know if and when AI response playback is finished
    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: "mark",
          streamSid: streamSid,
          mark: { name: "responsePart" },
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    };

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API");
      setTimeout(initializeSession, 100);
    });

    // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
    // openAiWs.on("message", async (data) => {
    openAiWs.on("message", async (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));

          // First delta from a new response starts the elapsed time counter
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
              );
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          sendMark(connection, streamSid);
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }

        // // Manejar llamadas a tools
        // if (response.type === "tool_call") {
        //   const toolName = response.tool.name;
        //   const args = response.tool.parameters;
        //   const toolCallId = response.tool_call_id;

        //   console.log("🔧 Tool request:", toolName, args);

        //   if (toolName === "consulta_entry") {
        //     try {
        //       const resultado = await consulta_entry_at(args);

        //       const toolResponse = {
        //         type: "tool_response",
        //         tool_response: {
        //           tool_call_id: toolCallId,
        //           output: resultado,
        //         },
        //       };

        //       openAiWs.send(JSON.stringify(toolResponse));
        //       console.log("✅ Tool response enviada:", resultado);
        //     } catch (err) {
        //       console.error("❌ Error ejecutando consulta_entry:", err);
        //       openAiWs.send(
        //         JSON.stringify({
        //           type: "tool_response",
        //           tool_response: {
        //             tool_call_id: toolCallId,
        //             output: { error: "Error al consultar la entrada" },
        //           },
        //         })
        //       );
        //     }
        //   }
        // }
      } catch (error) {
        console.error(
          "Error processing OpenAI message:",
          error,
          "Raw message:",
          data
        );
      }
    });

    // Handle incoming messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH)
              console.log(
                `Received media message with timestamp: ${latestMediaTimestamp}ms`
              );
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream has started", streamSid);

            // Reset start and media timestamp on a new stream
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;
          case "mark":
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;
          default:
            console.log("Received non-media event:", data.event);
            break;
        }
      } catch (error) {
        console.error("Error parsing message:", error, "Message:", message);
      }
    });

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Client disconnected.");
    });

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error);
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});
