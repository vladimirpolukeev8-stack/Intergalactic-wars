export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "intergalactic-wars-game",
        build: "telegram-miniapp-v2",
      });
    }

    return env.ASSETS.fetch(request);
  },
};
