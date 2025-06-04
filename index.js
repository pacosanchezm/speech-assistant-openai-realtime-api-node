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
  "Eres el asistente Virtual de la Universidad Virtual del Estado de Guanajuato (UVEG). Al iniciar la conversacion, debes llamar la tool consulta_entry con el id 5 y menciona el tema que te devuelve la tool";

// const SYSTEM_MESSAGE =
//   "Si te preguntan por información de una entrada, llama la tool consulta_entry.";

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
      // "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
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
          // tools: [
          //   {
          //     name: "consulta_entry",
          //     description: "Obtiene la información de entradas de pagina",
          //     strict: false, // ← IMPORTANTE para permitir llamadas más flexibles
          //     parameters: {
          //       type: "object",
          //       properties: {
          //         id: {
          //           type: "string",
          //           description: "el id de la entrada a consultar"
          //         },
          //       },
          //       required: ["id"],
          //     },
          //   },
          // ]

          // tools: [
          //   {
          //     "name": "get_weather",
          //     // "type": "function", // opcional
          //     "parameters": {
          //       "type": "object",
          //       "properties": {
          //         "location": { "type": "string" },
          //         "unit": { "type": "string", "enum": ["c", "f"] }
          //       },
          //       "required": ["location", "unit"],
          //       "additionalProperties": false
          //     }
          //   }
          // ]

        tools: [
          {
            name: "consulta_entry",
            type: "function",
            description: "Obtiene la información de entradas",
            //   strict: false,
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
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // Uncomment the following line to have AI speak first:
     // sendInitialConversationItem();
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

      // setTimeout(() => {
      //   openAiWs.send(JSON.stringify({
      //     type: "conversation.item.create",
      //     item: {
      //       type: "message",
      //       role: "user",
      //       content: [
      //         { type: "input_text", text: "Llama a la función consulta_entry con id 123." }
      //       ]
      //     }
      //   }));
      //   openAiWs.send(JSON.stringify({ type: "response.create" }));
      // }, 300);
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

        if (response.type === "tool_call") {
          console.log("🟢 tool_call recibida:", response);

          const { name, parameters } = response.tool;
          const toolCallId = response.tool_call_id;
          if (name === "consulta_entry") {
            try {
              // Simulación: puedes poner await consulta_entry_at(parameters);
              const result = `La entrada ${parameters.id} es referente a las becas deportivas`;

              openAiWs.send(
                JSON.stringify({
                  type: "tool_response",
                  tool_response: {
                    tool_call_id: toolCallId,
                    output: result,
                  },
                })
              );

              openAiWs.send(JSON.stringify({ type: "response.create" }));
              console.log(
                "✅ tool_response enviado, esperando respuesta hablada..."
              );
            } catch (err) {
              openAiWs.send(
                JSON.stringify({
                  type: "tool_response",
                  tool_response: {
                    tool_call_id: toolCallId,
                    output: { error: "Error en consulta_entry" },
                  },
                })
              );
              openAiWs.send(JSON.stringify({ type: "response.create" }));
              console.error("❌ Error en consulta_entry:", err);
            }
          }
        }
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
