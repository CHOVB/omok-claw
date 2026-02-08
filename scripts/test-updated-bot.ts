import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const loadDotenv = (path: string) => {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
};

loadDotenv("apps/api/.env");
process.env.API_PORT = "4019";
process.env.API_HOST = "127.0.0.1";

const base = `http://${process.env.API_HOST}:${process.env.API_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(250);
  }
  throw new Error("active game not found");
};

const pyChooseMove = (game: any) => {
  const pyCode = `
import json
import sys
import importlib.util
import os

os.environ.setdefault("AGENT_DETERMINISTIC", "1")
os.environ.setdefault("AGENT_DIVERSITY", "0")

spec = importlib.util.spec_from_file_location("daemon_agent", "agents/daemon_agent.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

game = json.load(sys.stdin)
move = mod.choose_move(game)
print(json.dumps(move if move else {}))
`;

  const r = spawnSync("python", ["-c", pyCode], {
    input: JSON.stringify(game),
    encoding: "utf8",
    cwd: process.cwd()
  });

  if (r.status !== 0) {
    throw new Error(`python choose_move failed: ${r.stderr || r.stdout}`);
  }

  const out = (r.stdout ?? "").trim();
  if (!out) return null;

  const parsed = JSON.parse(out);
  if (
    parsed &&
    typeof parsed.x === "number" &&
    typeof parsed.y === "number"
  ) {
    return parsed as { x: number; y: number };
  }
  return null;
};

const pyDecideSwap = (game: any, agentId: string) => {
  const pyCode = `
import json
import sys
import importlib.util
import os

os.environ.setdefault("AGENT_DETERMINISTIC", "1")
os.environ.setdefault("AGENT_DIVERSITY", "0")

spec = importlib.util.spec_from_file_location("daemon_agent", "agents/daemon_agent.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

payload = json.load(sys.stdin)
do_swap, detail = mod.decide_swap(payload["game"], payload["agent_id"])
print(json.dumps({"swap": bool(do_swap), "detail": detail}))
`;

  const r = spawnSync("python", ["-c", pyCode], {
    input: JSON.stringify({ game, agent_id: agentId }),
    encoding: "utf8",
    cwd: process.cwd()
  });
  if (r.status !== 0) {
    throw new Error(`python decide_swap failed: ${r.stderr || r.stdout}`);
  }
  const out = (r.stdout ?? "").trim();
  if (!out) return false;
  const parsed = JSON.parse(out);
  return Boolean(parsed?.swap);
};

const pyChooseOffer10 = (game: any, agentId: string) => {
  const pyCode = `
import json
import sys
import importlib.util
import os

os.environ.setdefault("AGENT_DETERMINISTIC", "1")
os.environ.setdefault("AGENT_DIVERSITY", "0")

spec = importlib.util.spec_from_file_location("daemon_agent", "agents/daemon_agent.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

payload = json.load(sys.stdin)
cand = mod.choose_offer10_candidate(payload["game"], payload["agent_id"])
print(json.dumps(cand if cand else {}))
`;

  const r = spawnSync("python", ["-c", pyCode], {
    input: JSON.stringify({ game, agent_id: agentId }),
    encoding: "utf8",
    cwd: process.cwd()
  });
  if (r.status !== 0) {
    throw new Error(`python choose_offer10 failed: ${r.stderr || r.stdout}`);
  }
  const out = (r.stdout ?? "").trim();
  if (!out) return null;
  const parsed = JSON.parse(out);
  if (
    parsed &&
    typeof parsed.x === "number" &&
    typeof parsed.y === "number"
  ) {
    return parsed as { x: number; y: number };
  }
  return null;
};

const randomName = (prefix: string) =>
  `${prefix}${Math.random().toString(36).slice(2, 8)}`.slice(0, 10);

const run = async () => {
  await import("../apps/api/src/index");
  await sleep(1200);

  const h = await req("GET", "/health");
  assert.equal(h.status, 200);

  const a = await req("POST", "/agents/register", undefined, { name: randomName("p") });
  const b = await req("POST", "/agents/register", undefined, { name: randomName("q") });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const byAgent = new Map<string, string>([
    [a.json.id as string, a.json.api_key as string],
    [b.json.id as string, b.json.api_key as string]
  ]);

  assert.equal((await req("POST", "/queue/join", a.json.api_key, {})).status, 200);
  assert.equal((await req("POST", "/queue/join", b.json.api_key, {})).status, 200);

  const active = await waitActive(a.json.api_key);
  const gameId = active.id as string;

  let movesPlayed = 0;
  let ticks = 0;
  const maxTicks = 1600;

  while (ticks < maxTicks) {
    ticks += 1;
    const g = await req("GET", `/games/${gameId}`);
    assert.equal(g.status, 200);
    const game = g.json;

    if (game.status === "finished") {
      console.log(
        JSON.stringify({
          ok: true,
          game_id: gameId,
          status: game.status,
          phase: game.phase,
          move_number: game.move_number,
          winner_color: game.winner_color,
          result_reason: game.result_reason,
          moves_played: movesPlayed
        })
      );
      process.exit(0);
    }

    const opening = game.opening_state ?? {};

    if (opening.awaiting_offer10_selection) {
      const selectorId = opening.tentative_white_agent_id as string | undefined;
      const token = selectorId ? byAgent.get(selectorId) : undefined;
      const candidates = (game.offer10_candidates ?? []) as Array<{ x: number; y: number }>;
      if (token && candidates.length > 0) {
        const selected = selectorId ? pyChooseOffer10(game, selectorId) : null;
        const move =
          selected && candidates.some((m) => m.x === selected.x && m.y === selected.y)
            ? selected
            : candidates[0];
        await req("POST", `/games/${gameId}/offer10/select`, token, move);
      } else {
        await sleep(100);
      }
      continue;
    }

    if (opening.awaiting_swap) {
      const lastMove = Number(game.move_number ?? 0);
      const decider =
        lastMove % 2 === 1
          ? (game.white_agent_id as string | undefined)
          : (game.black_agent_id as string | undefined);
      const token = decider ? byAgent.get(decider) : undefined;
      if (token) {
        const doSwap = decider ? pyDecideSwap(game, decider) : false;
        await req("POST", `/games/${gameId}/swap`, token, { swap: doSwap });
      } else {
        await sleep(100);
      }
      continue;
    }

    const legal = (game.legal_moves ?? []) as Array<{ x: number; y: number }>;
    if (legal.length === 0) {
      await sleep(120);
      continue;
    }

    const moverId =
      game.turn_color === "black" ? (game.black_agent_id as string) : (game.white_agent_id as string);
    const token = byAgent.get(moverId);
    if (!token) {
      await sleep(120);
      continue;
    }

    const chosen = pyChooseMove(game);
    const move =
      chosen && legal.some((m) => m.x === chosen.x && m.y === chosen.y)
        ? chosen
        : legal[0];

    const turnNumber = Number(game.move_number ?? 0) + 1;
    const mv = await req("POST", `/games/${gameId}/move`, token, {
      x: move.x,
      y: move.y,
      turn_number: turnNumber,
      idempotency_key: `${gameId}:${turnNumber}:${move.x}:${move.y}`
    });

    if (mv.status === 200) {
      movesPlayed += 1;
    } else if (mv.status !== 403 && mv.status !== 409) {
      throw new Error(`unexpected move response: ${mv.status} ${JSON.stringify(mv.json)}`);
    }
  }

  throw new Error("game did not finish within tick limit");
};

run().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
