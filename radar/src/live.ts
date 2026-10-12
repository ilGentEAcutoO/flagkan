// LIVE-001: one global Durable Object that fans cron ticks out to viewers
// over hibernatable WebSockets. Viewers are read-only. Cost guardrails:
// - clients send no keepalive; the cron pushes a heartbeat every minute,
// - EVERY client frame is counted (1/20 request) before handling: "ping"
//   gets "pong" (legacy), anything else closes the socket (1008). There is
//   deliberately NO auto-response, so no frame can bypass the counter,
// - caps: LIVE_MAX_SOCKETS total, LIVE_MAX_PER_IP per client IP (tagged),
// - monthly budget kill-switch in DO storage (upgrades + broadcasts + client
//   frames); past the line: refuse upgrades, close sockets, skip broadcasts.
// broadcast() is an RPC method only — there is no HTTP path to it.
import { DurableObject } from "cloudflare:workers";
import {
	LIVE_MAX_SOCKETS, LIVE_MAX_PER_IP, LIVE_MAX_IN_BYTES, LIVE_PING, LIVE_PONG, LIVE_CLOSE_REFUSED, LIVE_COST, LIVE_REPLAY_MAX_AGE_MS,
	budgetAdd, budgetOver, LIVE_MONTH_BUDGET_UNITS, LIVE_UNITS_PER_REQUEST, TICK_MAX_BYTES,
} from "./live-core";
import type { LiveBudget } from "./live-core";

export interface LiveState {
	month: string;
	requests: number; // billed-request equivalents counted this month
	budget: number; // kill-switch line in requests
	over: boolean;
	sockets: number;
	sent?: number;
}

const K_LAST = "last";
const K_LAST_AT = "last_at";
const K_BUDGET = "budget";

async function ipTag(ip: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("flagkan-live:" + ip));
	const b = new Uint8Array(d);
	let h = "";
	for (let i = 0; i < 6; i++) h += b[i].toString(16).padStart(2, "0");
	return "ip:" + h;
}

export class LiveFeed extends DurableObject<unknown> {
	private budget: LiveBudget | null = null;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		// No setWebSocketAutoResponse on purpose: an auto-answered frame would
		// never reach webSocketMessage and so could not be counted.
		ctx.setWebSocketAutoResponse();
	}

	private async spend(units: number): Promise<LiveBudget> {
		if (!this.budget) this.budget = (await this.ctx.storage.get<LiveBudget>(K_BUDGET)) ?? null;
		const wasOver = budgetOver(this.budget, Date.now());
		this.budget = budgetAdd(this.budget, Date.now(), units);
		// Once over the line the state cannot change until next month: stop
		// writing (keeps storage row writes bounded too).
		if (!wasOver) await this.ctx.storage.put(K_BUDGET, this.budget);
		return this.budget;
	}

	private state(b: LiveBudget, sent?: number): LiveState {
		const s: LiveState = {
			month: b.month,
			requests: Math.round(b.units / LIVE_UNITS_PER_REQUEST),
			budget: LIVE_MONTH_BUDGET_UNITS / LIVE_UNITS_PER_REQUEST,
			over: budgetOver(b, Date.now()),
			sockets: this.ctx.getWebSockets().length,
		};
		if (sent !== undefined) s.sent = sent;
		return s;
	}

	private closeAll(code: number, reason: string): void {
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.close(code, reason); } catch { /* already gone */ }
		}
	}

	private refuse(reason: string): Response {
		// Accept-then-close so the browser sees code 4429 and falls back to polling.
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.accept(); // transient, NOT hibernation-tracked, never counted as a viewer
		server.close(LIVE_CLOSE_REFUSED, reason);
		return new Response(null, { status: 101, webSocket: client });
	}

	async fetch(request: Request): Promise<Response> {
		if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}
		const b = await this.spend(LIVE_COST.upgrade);
		if (budgetOver(b, Date.now())) {
			this.closeAll(LIVE_CLOSE_REFUSED, "budget");
			return new Response("live budget reached", { status: 503, headers: { "X-Live-State": "budget" } });
		}
		const ip = request.headers.get("CF-Connecting-IP") ?? "";
		if (!ip) return new Response("missing client ip", { status: 400 });
		if (this.ctx.getWebSockets().length >= LIVE_MAX_SOCKETS) return this.refuse("busy");
		const tag = await ipTag(ip);
		if (this.ctx.getWebSockets(tag).length >= LIVE_MAX_PER_IP) return this.refuse("ip");
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server, [tag]); // Hibernation API
		const last = await this.ctx.storage.get<string>(K_LAST);
		const lastAt = Number(await this.ctx.storage.get<number>(K_LAST_AT)) || 0;
		if (typeof last === "string" && last.length > 0 && Date.now() - lastAt <= LIVE_REPLAY_MAX_AGE_MS) {
			try { server.send(last); } catch { /* client vanished */ }
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	/** RPC only. Sends one pre-serialized frame to every viewer; a tick (not a
	 *  heartbeat) is also persisted for replay to fresh connects. */
	async broadcast(msg: string): Promise<LiveState> {
		const b = await this.spend(LIVE_COST.broadcast);
		if (budgetOver(b, Date.now())) {
			this.closeAll(LIVE_CLOSE_REFUSED, "budget");
			return this.state(b, 0);
		}
		if (typeof msg !== "string" || msg.length === 0 || msg.length > TICK_MAX_BYTES * 2) return this.state(b, 0);
		if (!msg.startsWith('{"type":"hb"')) await this.ctx.storage.put({ [K_LAST]: msg, [K_LAST_AT]: Date.now() });
		let sent = 0;
		for (const ws of this.ctx.getWebSockets()) {
			try { ws.send(msg); sent++; } catch { /* dead socket: runtime will fire close */ }
		}
		return this.state(b, sent);
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// Count FIRST (every frame, ping included), then decide.
		const b = await this.spend(LIVE_COST.clientMsg);
		if (budgetOver(b, Date.now())) { this.closeAll(LIVE_CLOSE_REFUSED, "budget"); return; }
		if (message === LIVE_PING) { try { ws.send(LIVE_PONG); } catch { /* gone */ } return; }
		const tooBig = typeof message === "string" ? message.length > LIVE_MAX_IN_BYTES : message.byteLength > LIVE_MAX_IN_BYTES;
		try { ws.close(1008, tooBig ? "too big" : "read-only"); } catch { /* already closed */ }
	}

	// close/error events are pre-paid by LIVE_COST.upgrade (no storage write here).
	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		try { ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, String(reason ?? "").slice(0, 60)); } catch { /* already closed */ }
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		try { ws.close(1011, "error"); } catch { /* already closed */ }
	}
}
