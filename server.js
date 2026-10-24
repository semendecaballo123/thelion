// TheLion webhook proxy: the Discord webhook URLs live only here (env vars), never in the script.
// Render: New Web Service -> Build: (none) -> Start: node server.js
// Env vars: REDEEM_WEBHOOK, EXEC_WEBHOOK (full Discord webhook URLs).
"use strict";

const http = require("http");

const PORT = Number(process.env.PORT) || 3000;
const ROUTES = {
	"/redeem": { url: process.env.REDEEM_WEBHOOK, username: "TheLion Sniper", footer: "TheLion Code Sniper" },
	"/exec": { url: process.env.EXEC_WEBHOOK, username: "TheLion Sniper", footer: "TheLion Code Sniper" },
};
const MAX_BODY = 8 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 12; // requests per IP per minute
const hits = new Map();

function limited(ip) {
	const now = Date.now();
	const list = (hits.get(ip) || []).filter((at) => now - at < RATE_WINDOW_MS);
	list.push(now);
	hits.set(ip, list);
	return list.length > RATE_LIMIT;
}

setInterval(() => {
	const now = Date.now();
	for (const [ip, list] of hits) {
		if (!list.some((at) => now - at < RATE_WINDOW_MS)) hits.delete(ip);
	}
}, RATE_WINDOW_MS).unref();

const text = (value, max) => String(value ?? "").slice(0, max);

// Rebuild the payload from scratch: one embed, no pings, fixed name and footer.
function sanitize(input, route) {
	const embed = Array.isArray(input?.embeds) ? input.embeds[0] : null;
	if (!embed || typeof embed !== "object") return null;

	const fields = (Array.isArray(embed.fields) ? embed.fields : []).slice(0, 12).map((field) => ({
		name: text(field?.name, 64) || "-",
		value: text(field?.value, 1024) || "-",
		inline: field?.inline === true,
	}));

	const color = Number.isInteger(embed.color) && embed.color >= 0 && embed.color <= 0xffffff ? embed.color : 0;
	const time = Date.parse(embed.timestamp);

	return {
		username: route.username,
		allowed_mentions: { parse: [] },
		embeds: [{
			title: text(embed.title, 64) || "-",
			color,
			fields,
			footer: { text: route.footer },
			timestamp: new Date(Number.isNaN(time) ? Date.now() : time).toISOString(),
		}],
	};
}

const reply = (res, status, message) => {
	res.writeHead(status, { "Content-Type": "text/plain" });
	res.end(message);
};

http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/") return reply(res, 200, "ok");

	const route = ROUTES[req.url];
	if (req.method !== "POST" || !route) return reply(res, 404, "not found");
	if (!route.url) return reply(res, 500, "webhook not configured");

	const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
	if (limited(ip)) return reply(res, 429, "slow down");

	let size = 0;
	const chunks = [];

	req.on("data", (chunk) => {
		size += chunk.length;
		if (size > MAX_BODY) {
			reply(res, 413, "too large");
			req.destroy();
		} else {
			chunks.push(chunk);
		}
	});

	req.on("end", async () => {
		if (res.writableEnded) return;

		let payload;
		try {
			payload = sanitize(JSON.parse(Buffer.concat(chunks).toString("utf8")), route);
		} catch {
			payload = null;
		}
		if (!payload) return reply(res, 400, "bad payload");

		try {
			const discord = await fetch(route.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			// Pass Discord's status through so the script's retry logic keeps working.
			reply(res, discord.status, discord.ok ? "sent" : "discord error");
		} catch {
			reply(res, 502, "discord unreachable");
		}
	});
}).listen(PORT, () => console.log(`proxy on ${PORT}`));
