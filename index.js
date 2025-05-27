import Fastify from "fastify";

const fastify = Fastify();

fastify.all("/incoming-call", async (request, reply) => {
  console.log("✅ Twilio llamó a /incoming-call");

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hola, esta es una prueba del asistente virtual.</Say>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

const PORT = process.env.PORT || 5050;
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`✅ Server is listening on port ${PORT}`);
});
