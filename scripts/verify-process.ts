import assert from "node:assert/strict";
import fs from "node:fs";

const loadDotenv = (path: string) => {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
};

loadDotenv("apps/api/.env");
process.env.API_PORT = "4011";
process.env.API_HOST = "127.0.0.1";

const base = `http://${process.env.API_HOST}:${process.env.API_PORT}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const randomName = (prefix: string) =>
  `${prefix}${Math.random().toString(36).slice(2, 9)}`.slice(0, 10);

const req = async (
  method: string,
  path: string,
  token?: string,
  payload?: Record<string, unknown>
) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const waitActive = async (token: string, ms = 15000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const r = await req("GET", "/agents/active-game", token);
    if (r.status === 200 && r.json?.game?.id) return r.json.game;
    await sleep(300);
  }
  throw new Error("active game not found");
};

const pickLegal = (gameJson: any, fallback: { x: number; y: number }) => {
  const legal = (gameJson?.legal_moves ?? []) as Array<{ x: number; y: number }>;
  if (legal.length > 0) return legal[0];
  return fallback;
};

const verifyAgentWaitMatchStart = async () => {
  const a = await req("POST", "/agents/register", undefined, { name: randomName("w") });
  const b = await req("POST", "/agents/register", undefined, { name: randomName("x") });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const tA = a.json.api_key as string;
  const tB = b.json.api_key as string;
  const meA = await req("GET", "/agents/me", tA);
  assert.equal(meA.status, 200);
  assert.equal(meA.json.id, a.json.id);

  const base = await req("GET", "/agents/wait?timeout_sec=5", tA);
  assert.equal(base.status, 200);
  assert.equal(base.json.in_queue, false);
  assert.equal(base.json.game, null);
  const rev0 = encodeURIComponent(String(base.json.revision ?? ""));

  const joinA = await req("POST", "/queue/join", tA, {});
  assert.equal(joinA.status, 200);

  const queued = await req("GET", `/agents/wait?since_revision=${rev0}&timeout_sec=5`, tA);
  assert.equal(queued.status, 200);
  assert.equal(queued.json.in_queue, true);
  assert.equal(queued.json.game, null);
  const rev1 = encodeURIComponent(String(queued.json.revision ?? ""));

  const waitMatched = req("GET", `/agents/wait?since_revision=${rev1}&timeout_sec=15`, tA);
  await sleep(300);
  const joinB = await req("POST", "/queue/join", tB, {});
  assert.equal(joinB.status, 200);

  const matched = await waitMatched;
  assert.equal(matched.status, 200);
  assert.equal(Boolean(matched.json?.game?.id), true);
  assert.equal(matched.json.in_queue, false);
  assert.equal(typeof matched.json?.game?.is_my_turn, "boolean");
  assert.equal(
    ["none", "move", "swap", "offer10_select"].includes(String(matched.json?.game?.required_action)),
    true
  );
  if (matched.json?.game?.required_action === "none") {
    assert.equal(matched.json?.game?.is_my_turn, false);
  }
  return matched.json.game.id as string;
};

const verifySwapTurnOrder = async () => {
  const a = await req("POST", "/agents/register", undefined, { name: randomName("s") });
  const b = await req("POST", "/agents/register", undefined, { name: randomName("t") });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const tA = a.json.api_key as string;
  const tB = b.json.api_key as string;
  const byId = new Map<string, string>([
    [a.json.id, tA],
    [b.json.id, tB]
  ]);

  await req("POST", "/queue/join", tA, {});
  await req("POST", "/queue/join", tB, {});

  const active = await waitActive(tA);
  const gameId = active.id as string;

  const g0 = await req("GET", `/games/${gameId}`);
  assert.equal(g0.status, 200);
  const startBlack = g0.json.black_agent_id as string;
  const startWhite = g0.json.white_agent_id as string;
  const tBlack = byId.get(startBlack)!;
  const tWhite = byId.get(startWhite)!;

  const m1 = await req("POST", `/games/${gameId}/move`, tBlack, {
    x: 7,
    y: 7,
    turn_number: 1,
    idempotency_key: `${gameId}:1:7:7`
  });
  assert.equal(m1.status, 200);

  const s1 = await req("POST", `/games/${gameId}/swap`, tWhite, { swap: true });
  assert.equal(s1.status, 200);

  const g1 = await req("GET", `/games/${gameId}`);
  assert.equal(g1.status, 200);
  assert.equal(g1.json.turn_color, "white");

  const currentBlackAfterSwap = g1.json.black_agent_id as string;
  const currentWhiteAfterSwap = g1.json.white_agent_id as string;
  const tCurrentBlack = byId.get(currentBlackAfterSwap)!;
  const tCurrentWhite = byId.get(currentWhiteAfterSwap)!;
  const move2 = pickLegal(g1.json, { x: 7, y: 8 });

  const m2Wrong = await req("POST", `/games/${gameId}/move`, tCurrentBlack, {
    x: move2.x,
    y: move2.y,
    turn_number: 2,
    idempotency_key: `${gameId}:2:${move2.x}:${move2.y}:wrong`
  });
  assert.equal(m2Wrong.status, 403);

  const m2 = await req("POST", `/games/${gameId}/move`, tCurrentWhite, {
    x: move2.x,
    y: move2.y,
    turn_number: 2,
    idempotency_key: `${gameId}:2:${move2.x}:${move2.y}`
  });
  assert.equal(m2.status, 200);

  const g2 = await req("GET", `/games/${gameId}`);
  assert.equal(g2.status, 200);
  assert.equal(g2.json.opening_state.awaiting_swap, true);

  const s2 = await req("POST", `/games/${gameId}/swap`, tCurrentBlack, { swap: false });
  assert.equal(s2.status, 200);

  const g3 = await req("GET", `/games/${gameId}`);
  assert.equal(g3.status, 200);
  assert.equal(g3.json.turn_color, "black");
  const move3 = pickLegal(g3.json, { x: 8, y: 7 });

  const m3 = await req("POST", `/games/${gameId}/move`, tCurrentBlack, {
    x: move3.x,
    y: move3.y,
    turn_number: 3,
    idempotency_key: `${gameId}:3:${move3.x}:${move3.y}`
  });
  assert.equal(m3.status, 200);

  return gameId;
};

const verifyOptionA = async () => {
  const a = await req("POST", "/agents/register", undefined, {
    name: randomName("a")
  });
  const b = await req("POST", "/agents/register", undefined, {
    name: randomName("b")
  });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const dup = await req("POST", "/agents/register", undefined, { name: a.json.name });
  assert.equal(dup.status, 409);

  const tA = a.json.api_key as string;
  const tB = b.json.api_key as string;

  await req("POST", "/queue/join", tA, {});
  await req("POST", "/queue/join", tB, {});

  const active = await waitActive(tA);
  const gameId = active.id as string;
  const game = await req("GET", `/games/${gameId}`);
  assert.equal(game.status, 200);

  const tb = game.json.opening_state.tentative_black_agent_id;
  const tw = game.json.opening_state.tentative_white_agent_id;
  const byId = new Map<string, string>([
    [a.json.id, tA],
    [b.json.id, tB]
  ]);
  const tBlack = byId.get(tb)!;
  const tWhite = byId.get(tw)!;

  const m1 = await req("POST", `/games/${gameId}/move`, tBlack, {
    x: 7,
    y: 7,
    turn_number: 1,
    idempotency_key: `${gameId}:1:7:7`
  });
  assert.equal(m1.status, 200);

  const m1dup = await req("POST", `/games/${gameId}/move`, tBlack, {
    x: 7,
    y: 7,
    turn_number: 1,
    idempotency_key: `${gameId}:1:7:7`
  });
  assert.equal(m1dup.status, 200);
  assert.equal(m1dup.json.duplicate, true);

  const m1conflict = await req("POST", `/games/${gameId}/move`, tBlack, {
    x: 7,
    y: 8,
    turn_number: 1,
    idempotency_key: `${gameId}:1:7:7`
  });
  assert.equal(m1conflict.status, 409);

  assert.equal((await req("POST", `/games/${gameId}/swap`, tWhite, { swap: false })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/move`, tWhite, { x: 7, y: 8, turn_number: 2, idempotency_key: `${gameId}:2:7:8` })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/swap`, tBlack, { swap: false })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/move`, tBlack, { x: 8, y: 7, turn_number: 3, idempotency_key: `${gameId}:3:8:7` })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/swap`, tWhite, { swap: false })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/move`, tWhite, { x: 8, y: 8, turn_number: 4, idempotency_key: `${gameId}:4:8:8` })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/swap`, tBlack, { swap: false })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/move`, tBlack, { x: 6, y: 7, turn_number: 5, idempotency_key: `${gameId}:5:6:7` })).status, 200);
  assert.equal((await req("POST", `/games/${gameId}/swap`, tWhite, { swap: false })).status, 200);

  const g2 = await req("GET", `/games/${gameId}`);
  assert.equal(g2.status, 200);
  assert.equal(g2.json.phase, "midgame");
  assert.equal(g2.json.move_number, 5);

  const blocked = await req("POST", "/queue/join", tBlack, {});
  assert.equal(blocked.status, 409);

  const wait = await req("GET", `/games/${gameId}/wait?since_move=5&timeout_sec=5`);
  assert.equal(wait.status, 200);
  assert.equal(wait.json.changed, false);

  return gameId;
};

const verifyOptionB = async () => {
  const a = await req("POST", "/agents/register", undefined, {
    name: randomName("c")
  });
  const b = await req("POST", "/agents/register", undefined, {
    name: randomName("d")
  });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const tA = a.json.api_key as string;
  const tB = b.json.api_key as string;

  await req("POST", "/queue/join", tA, {});
  await req("POST", "/queue/join", tB, {});

  const active = await waitActive(tA);
  const gameId = active.id as string;
  const game = await req("GET", `/games/${gameId}`);

  const tb = game.json.opening_state.tentative_black_agent_id;
  const tw = game.json.opening_state.tentative_white_agent_id;
  const byId = new Map<string, string>([
    [a.json.id, tA],
    [b.json.id, tB]
  ]);
  const tBlack = byId.get(tb)!;
  const tWhite = byId.get(tw)!;

  await req("POST", `/games/${gameId}/move`, tBlack, { x: 7, y: 7, turn_number: 1, idempotency_key: `${gameId}:1:7:7` });
  await req("POST", `/games/${gameId}/swap`, tWhite, { swap: false });
  await req("POST", `/games/${gameId}/move`, tWhite, { x: 7, y: 8, turn_number: 2, idempotency_key: `${gameId}:2:7:8` });
  await req("POST", `/games/${gameId}/swap`, tBlack, { swap: false });
  await req("POST", `/games/${gameId}/move`, tBlack, { x: 8, y: 7, turn_number: 3, idempotency_key: `${gameId}:3:8:7` });
  await req("POST", `/games/${gameId}/swap`, tWhite, { swap: false });
  await req("POST", `/games/${gameId}/move`, tWhite, { x: 8, y: 8, turn_number: 4, idempotency_key: `${gameId}:4:8:8` });
  await req("POST", `/games/${gameId}/swap`, tBlack, { swap: false });

  const candidates = [
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 0, y: 3 },
    { x: 0, y: 4 },
    { x: 0, y: 5 },
    { x: 1, y: 2 },
    { x: 1, y: 3 },
    { x: 1, y: 4 },
    { x: 2, y: 3 },
    { x: 2, y: 4 }
  ];

  const offer = await req("POST", `/games/${gameId}/offer10`, tBlack, { candidates });
  assert.equal(offer.status, 200);

  const sel = await req("POST", `/games/${gameId}/offer10/select`, tWhite, {
    x: 0,
    y: 1
  });
  assert.equal(sel.status, 200);

  const g2 = await req("GET", `/games/${gameId}`);
  assert.equal(g2.status, 200);
  assert.equal(g2.json.move_number, 5);
  assert.equal(g2.json.phase, "midgame");

  return gameId;
};

const main = async () => {
  await import("../apps/api/src/index");
  await sleep(1500);

  const h = await req("GET", "/health");
  assert.equal(h.status, 200);
  const ov = await req("GET", "/overview?live_limit=2&history_limit=2&ranking_limit=2");
  assert.equal(ov.status, 200);
  assert.equal(typeof ov.json?.stats?.games, "number");

  const agentWait = await verifyAgentWaitMatchStart();
  const swapFlow = await verifySwapTurnOrder();
  const optionA = await verifyOptionA();
  const optionB = await verifyOptionB();

  const liveList = await req("GET", "/games?status=active&limit=5");
  assert.equal(liveList.status, 200);
  assert.equal(Array.isArray(liveList.json?.games), true);

  const historyList = await req("GET", "/games?status=finished&limit=5");
  assert.equal(historyList.status, 200);
  assert.equal(Array.isArray(historyList.json?.games), true);

  console.log(JSON.stringify({ ok: true, agentWait, swapFlow, optionA, optionB }));
  process.exit(0);
};

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
