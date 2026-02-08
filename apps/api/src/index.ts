import Fastify from "fastify";
import cors from "@fastify/cors";
import env from "@fastify/env";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { EventEmitter } from "events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateMove, type Board } from "@renju/shared";

const loadDotEnvEarly = () => {
  // Load `apps/api/.env` (or any `.env` in current working dir) before Fastify is created,
  // so options like request logging can be configured at startup time.
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
};

loadDotEnvEarly();

const requestLoggingEnabled = (process.env.REQUEST_LOGGING ?? "") === "1";
const logLevel = process.env.LOG_LEVEL ?? "info";

const app = Fastify({
  logger: {
    level: logLevel,
    redact: ["req.headers.authorization"]
  },
  // Default: no per-request logs (important for high-frequency polling).
  disableRequestLogging: !requestLoggingEnabled
});

await app.register(env, {
  schema: {
    type: "object",
    required: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    properties: {
      SUPABASE_URL: { type: "string" },
      SUPABASE_SERVICE_ROLE_KEY: { type: "string" },
      API_PORT: { type: "string", default: "4000" },
      API_HOST: { type: "string", default: "0.0.0.0" },
      CORS_ORIGIN: { type: "string", default: "http://localhost:3000" },
      LOG_LEVEL: { type: "string", default: "info" },
      REQUEST_LOGGING: { type: "string", default: "0" },
      LAST_SEEN_UPDATE_SEC: { type: "string", default: "600" },
      AUTO_NO_SWAP_AFTER_SEC: { type: "string", default: "240" },
      TURN_MOVE_TIMEOUT_SEC: { type: "string", default: "300" },
      TURN_DECISION_TIMEOUT_SEC: { type: "string", default: "300" },
      TIMEOUT_SWEEP_INTERVAL_MS: { type: "string", default: "5000" }
    }
  },
  dotenv: true
});

// Ensure `LOG_LEVEL` from `.env` (loaded by @fastify/env) is applied even if the process started
// without env vars pre-set.
app.log.level = (app as any).config.LOG_LEVEL ?? app.log.level;

await app.register(cors, {
  origin: (origin, cb) => {
    const allowed = (app as any).config.CORS_ORIGIN.split(",").map((s: string) => s.trim());
    if (!origin || allowed.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"), false);
  }
});

const supabase = createClient(
  (app as any).config.SUPABASE_URL,
  (app as any).config.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const BOARD_SIZE = 15;
const CENTER = 7;
const AGENT_NAME_DEFAULT = "돌쇠";
const AGENT_NAME_MAX_LENGTH = 10;
const AGENT_NAME_RECOMMENDED = [
  "돌쇠",
  "마당쇠",
  "억쇠",
  "강쇠",
  "무쇠",
  "뚝이",
  "삼월이",
  "사월이",
  "곱단이",
  "꽃분이"
];

const normalizeAgentName = (name?: string) => {
  const raw = (name ?? "").trim();
  const base = raw.length > 0 ? raw : AGENT_NAME_DEFAULT;
  const clipped = Array.from(base).slice(0, AGENT_NAME_MAX_LENGTH).join("");
  return clipped.trim().length > 0 ? clipped : AGENT_NAME_DEFAULT;
};

const gameEvents = new EventEmitter();
gameEvents.setMaxListeners(0);
const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(0);
const moveIdempotencyFallback = new Map<
  string,
  {
    turn_number: number;
    x: number;
    y: number;
    status_code?: number;
    response?: Record<string, any>;
  }
>();

const isMissingTableError = (error: any, tableName: string) =>
  String(error?.message ?? "").toLowerCase().includes(tableName.toLowerCase());

const isMissingColumnError = (error: any, columnName: string) =>
  String(error?.message ?? "").toLowerCase().includes(columnName.toLowerCase());

const isWithinBox = (x: number, y: number, radius: number) => {
  return (
    x >= CENTER - radius &&
    x <= CENTER + radius &&
    y >= CENTER - radius &&
    y <= CENTER + radius
  );
};

const validateOpeningMove = (
  moveNumber: number,
  x: number,
  y: number
): string | null => {
  if (moveNumber === 1) {
    return x === CENTER && y === CENTER ? null : "Move 1 must be at H8";
  }
  if (moveNumber === 2) {
    return isWithinBox(x, y, 1) ? null : "Move 2 must be within 3x3";
  }
  if (moveNumber === 3) {
    return isWithinBox(x, y, 2) ? null : "Move 3 must be within 5x5";
  }
  if (moveNumber === 4) {
    return isWithinBox(x, y, 3) ? null : "Move 4 must be within 7x7";
  }
  if (moveNumber === 5) {
    return isWithinBox(x, y, 4) ? null : "Move 5 must be within 9x9";
  }
  return null;
};

type OpeningState = {
  tentative_black_agent_id?: string;
  tentative_white_agent_id?: string;
  awaiting_swap?: boolean;
  swap_after_move?: number | null;
  swap_history?: Array<{
    move_number: number;
    decider_agent_id: string;
    swapped: boolean;
    at: string;
  }>;
  awaiting_offer10?: boolean;
  awaiting_offer10_selection?: boolean;
  offer10_id?: string | null;
};

const getOpeningState = (game: any): OpeningState => {
  const state = (game.opening_state ?? {}) as OpeningState;
  if (!state.tentative_black_agent_id) {
    state.tentative_black_agent_id = game.black_agent_id ?? undefined;
  }
  if (!state.tentative_white_agent_id) {
    state.tentative_white_agent_id = game.white_agent_id ?? undefined;
  }
  if (!state.swap_history) state.swap_history = [];
  return state;
};

const getColorForAgent = (game: any, agentId: string | null) => {
  if (!agentId) return null;
  if (game.black_agent_id === agentId) return "black";
  if (game.white_agent_id === agentId) return "white";
  return null;
};

const openingTurnColorForMove = (moveNumber: number): "black" | "white" =>
  moveNumber % 2 === 1 ? "black" : "white";

type AgentRequiredAction = "none" | "move" | "swap" | "offer10_select";

type AgentGameState = {
  id: string;
  status: string;
  phase: string;
  move_number: number;
  turn_color: string;
  updated_at: string;
  color: "black" | "white" | null;
  is_my_turn: boolean;
  required_action: AgentRequiredAction;
  next_turn_number: number;
  turn_deadline_at: string | null;
  time_left_ms: number | null;
};

type RequiredActionContext = {
  requiredAction: AgentRequiredAction;
  actingAgentId: string | null;
  nextTurnNumber: number;
};

const turnMoveTimeoutSec = Math.max(
  Number((app as any).config.TURN_MOVE_TIMEOUT_SEC ?? "300") || 300,
  1
);
const turnDecisionTimeoutSec = Math.max(
  Number((app as any).config.TURN_DECISION_TIMEOUT_SEC ?? "300") || 300,
  1
);
const timeoutSweepIntervalMs = Math.max(
  Number((app as any).config.TIMEOUT_SWEEP_INTERVAL_MS ?? "5000") || 5000,
  1000
);
const lastSeenUpdateSec = Math.max(
  Number((app as any).config.LAST_SEEN_UPDATE_SEC ?? "600") || 600,
  0
);

const nextTurnDeadlineIso = (requiredAction: AgentRequiredAction) => {
  const sec =
    requiredAction === "swap" || requiredAction === "offer10_select"
      ? turnDecisionTimeoutSec
      : turnMoveTimeoutSec;
  return new Date(Date.now() + sec * 1000).toISOString();
};

const getRequiredActionContext = (game: any): RequiredActionContext => {
  const nextTurnNumber = Number(game.move_number ?? 0) + 1;
  if (game.status !== "active") {
    return { requiredAction: "none", actingAgentId: null, nextTurnNumber };
  }

  const openingState = getOpeningState(game);
  if (openingState.awaiting_offer10_selection) {
    return {
      requiredAction: "offer10_select",
      actingAgentId: openingState.tentative_white_agent_id ?? null,
      nextTurnNumber
    };
  }

  if (openingState.awaiting_swap) {
    const lastMove = Number(game.move_number ?? 0);
    if (lastMove >= 1 && lastMove <= 5) {
      const lastMoverColor = openingTurnColorForMove(lastMove);
      return {
        requiredAction: "swap",
        actingAgentId:
          lastMoverColor === "black" ? game.white_agent_id ?? null : game.black_agent_id ?? null,
        nextTurnNumber
      };
    }
    return { requiredAction: "none", actingAgentId: null, nextTurnNumber };
  }

  const expectedTurnColor =
    nextTurnNumber <= 5 ? openingTurnColorForMove(nextTurnNumber) : game.turn_color;
  return {
    requiredAction: "move",
    actingAgentId:
      expectedTurnColor === "black" ? game.black_agent_id ?? null : game.white_agent_id ?? null,
    nextTurnNumber
  };
};

const resolveAgentTurnState = (game: any, agentId: string) => {
  const ctx = getRequiredActionContext(game);
  const isMyTurn = Boolean(ctx.actingAgentId && ctx.actingAgentId === agentId);
  return {
    isMyTurn,
    requiredAction: isMyTurn ? ctx.requiredAction : "none",
    nextTurnNumber: ctx.nextTurnNumber
  };
};

const waitRevisionForGame = (game: any) => {
  const openingState = getOpeningState(game);
  const swapHistoryLen = Array.isArray(openingState.swap_history)
    ? openingState.swap_history.length
    : 0;
  return [
    String(game.status ?? ""),
    String(game.phase ?? ""),
    String(game.move_number ?? ""),
    String(game.turn_color ?? ""),
    String(game.turn_deadline_at ?? ""),
    String(game.updated_at ?? ""),
    String(game.black_agent_id ?? ""),
    String(game.white_agent_id ?? ""),
    openingState.awaiting_swap ? "1" : "0",
    String(openingState.swap_after_move ?? ""),
    openingState.awaiting_offer10_selection ? "1" : "0",
    String(openingState.offer10_id ?? ""),
    String(swapHistoryLen)
  ].join("|");
};

const waitRevisionForAgentState = (state: {
  in_queue: boolean;
  game: AgentGameState | null;
}) =>
  [
    state.in_queue ? "1" : "0",
    String(state.game?.id ?? ""),
    String(state.game?.status ?? ""),
    String(state.game?.phase ?? ""),
    String(state.game?.move_number ?? ""),
    String(state.game?.turn_color ?? ""),
    String(state.game?.updated_at ?? ""),
    String(state.game?.color ?? ""),
    state.game?.is_my_turn ? "1" : "0",
    String(state.game?.required_action ?? "none"),
    String(state.game?.next_turn_number ?? ""),
    String(state.game?.turn_deadline_at ?? "")
  ].join("|");

const hashKey = (key: string) =>
  crypto.createHash("sha256").update(key).digest("hex");

const generateApiKey = () => {
  const raw = crypto.randomBytes(32).toString("base64url");
  return `ra_${raw}`;
};

const getBearerToken = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim();
};

const buildBoard = (
  moves: Array<{ x: number; y: number; color: "black" | "white" }>
) => {
  const board: Board = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null as "black" | "white" | null)
  );
  for (const move of moves) {
    if (
      move.x >= 0 &&
      move.x < BOARD_SIZE &&
      move.y >= 0 &&
      move.y < BOARD_SIZE
    ) {
      board[move.y][move.x] = move.color;
    }
  }
  return board;
};

const collectEmptyPoints = (board: Board) => {
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] === null) points.push({ x, y });
    }
  }
  return points;
};

const legalMovesOpening = (board: Board, nextMove: number) => {
  const radius =
    nextMove === 1
      ? 0
      : nextMove === 2
      ? 1
      : nextMove === 3
      ? 2
      : nextMove === 4
      ? 3
      : nextMove === 5
      ? 4
      : null;
  if (radius === null) return null;
  const moves: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] !== null) continue;
      if (isWithinBox(x, y, radius)) moves.push({ x, y });
    }
  }
  return moves;
};

const legalMovesMidgame = (board: Board, color: "black" | "white") => {
  const empties = collectEmptyPoints(board);
  if (color === "white") return empties;
  const legal: Array<{ x: number; y: number }> = [];
  for (const pt of empties) {
    board[pt.y][pt.x] = color;
    const evalResult = evaluateMove(board, { x: pt.x, y: pt.y, color });
    board[pt.y][pt.x] = null;
    if (!evalResult.forbidden) legal.push(pt);
  }
  return legal;
};

const updateElo = async (game: any, winnerColor: "black" | "white") => {
  if (!game.black_agent_id || !game.white_agent_id) return;
  const { data: agents } = await supabase
    .from("agents")
    .select("id,elo,wins,losses,draws,games_played")
    .in("id", [game.black_agent_id, game.white_agent_id]);
  if (!agents || agents.length !== 2) return;

  const black = agents.find((a) => a.id === game.black_agent_id);
  const white = agents.find((a) => a.id === game.white_agent_id);
  if (!black || !white) return;

  const k = 32;
  const expectedBlack =
    1 / (1 + Math.pow(10, (white.elo - black.elo) / 400));
  const scoreBlack = winnerColor === "black" ? 1 : 0;
  const scoreWhite = 1 - scoreBlack;

  const newBlack = Math.round(black.elo + k * (scoreBlack - expectedBlack));
  const newWhite = Math.round(white.elo + k * (scoreWhite - (1 - expectedBlack)));

  await supabase
    .from("agents")
    .update({
      elo: newBlack,
      wins: black.wins + (winnerColor === "black" ? 1 : 0),
      losses: black.losses + (winnerColor === "white" ? 1 : 0),
      games_played: black.games_played + 1
    })
    .eq("id", black.id);

  await supabase
    .from("agents")
    .update({
      elo: newWhite,
      wins: white.wins + (winnerColor === "white" ? 1 : 0),
      losses: white.losses + (winnerColor === "black" ? 1 : 0),
      games_played: white.games_played + 1
    })
    .eq("id", white.id);
};

const getAgentFromAuth = async (req: any, reply: any) => {
  const token = getBearerToken(req);
  if (!token) {
    reply.code(401);
    return { error: "Missing Bearer token" };
  }
  const apiKeyHash = hashKey(token);
  const { data, error } = await supabase
    .from("agents")
    .select("id, name, is_active, last_seen_at")
    .eq("api_key_hash", apiKeyHash)
    .maybeSingle();
  if (error || !data) {
    reply.code(401);
    return { error: "Invalid agent key" };
  }
  if (!data.is_active) {
    reply.code(403);
    return { error: "Agent inactive" };
  }
  if (lastSeenUpdateSec > 0) {
    const lastSeenMs = Date.parse(String((data as any).last_seen_at ?? ""));
    const ageMs = Number.isFinite(lastSeenMs) ? Date.now() - lastSeenMs : Infinity;
    if (ageMs >= lastSeenUpdateSec * 1000) {
      await supabase
        .from("agents")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", data.id);
    }
  }
  return { agent: data };
};

const getActiveGameForAgent = async (agentId: string) => {
  const { data } = await supabase
    .from("games")
    .select(
      "id,status,phase,move_number,turn_color,turn_deadline_at,updated_at,black_agent_id,white_agent_id,opening_state"
    )
    .or(`black_agent_id.eq.${agentId},white_agent_id.eq.${agentId}`)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
};

const isAgentInQueue = async (agentId: string) => {
  const { data } = await supabase
    .from("matchmaking_queue")
    .select("id")
    .eq("agent_id", agentId)
    .maybeSingle();
  return Boolean(data?.id);
};

const withAgentNames = async <
  T extends { black_agent_id: string | null; white_agent_id: string | null }
>(
  games: T[]
) => {
  const playerIds = Array.from(
    new Set(
      games
        .flatMap((g) => [g.black_agent_id, g.white_agent_id])
        .filter((id): id is string => Boolean(id))
    )
  );
  let playerNameMap: Record<string, string> = {};
  if (playerIds.length > 0) {
    const { data: players } = await supabase
      .from("agents")
      .select("id,name")
      .in("id", playerIds);
    playerNameMap = Object.fromEntries((players ?? []).map((p) => [p.id, p.name]));
  }

  return games.map((g) => ({
    ...g,
    black_agent_name: g.black_agent_id ? playerNameMap[g.black_agent_id] ?? null : null,
    white_agent_name: g.white_agent_id ? playerNameMap[g.white_agent_id] ?? null : null
  }));
};

const legacyMatchmakeOnce = async () => {
  const { data: queueRows } = await supabase
    .from("matchmaking_queue")
    .select("agent_id,joined_at")
    .order("joined_at", { ascending: true })
    .limit(2);
  if (!queueRows || queueRows.length < 2) return null;

  const [first, second] = queueRows;
  const swap = Math.random() < 0.5;
  const blackId = swap ? second.agent_id : first.agent_id;
  const whiteId = swap ? first.agent_id : second.agent_id;

  const { data: game, error } = await supabase
    .from("games")
    .insert({
      status: "active",
      black_agent_id: blackId,
      white_agent_id: whiteId,
      phase: "opening_1",
      turn_color: "black",
      move_number: 0,
      turn_deadline_at: nextTurnDeadlineIso("move"),
      opening_state: {
        tentative_black_agent_id: blackId,
        tentative_white_agent_id: whiteId,
        awaiting_swap: false,
        swap_after_move: null,
        awaiting_offer10: false,
        awaiting_offer10_selection: false,
        offer10_id: null,
        swap_history: []
      }
    })
    .select("id")
    .single();
  if (error || !game) return null;

  await supabase
    .from("matchmaking_queue")
    .delete()
    .in("agent_id", [first.agent_id, second.agent_id]);
  return game.id as string;
};

const notifyAgentChanged = (agentId: string | null | undefined) => {
  if (!agentId) return;
  agentEvents.emit(agentId);
};

const notifyGameChanged = (
  gameId: string,
  participants?: Array<string | null | undefined>
) => {
  gameEvents.emit(gameId);
  if (participants) {
    for (const agentId of participants) {
      notifyAgentChanged(agentId);
    }
  }
};

const waitForGameEvent = (gameId: string, timeoutMs: number) => {
  return new Promise<void>((resolve) => {
    const onChange = () => {
      clearTimeout(timer);
      gameEvents.removeListener(gameId, onChange);
      resolve();
    };
    const timer = setTimeout(() => {
      gameEvents.removeListener(gameId, onChange);
      resolve();
    }, timeoutMs);
    gameEvents.on(gameId, onChange);
  });
};

const waitForAgentEvent = (agentId: string, timeoutMs: number) => {
  return new Promise<void>((resolve) => {
    const onChange = () => {
      clearTimeout(timer);
      agentEvents.removeListener(agentId, onChange);
      resolve();
    };
    const timer = setTimeout(() => {
      agentEvents.removeListener(agentId, onChange);
      resolve();
    }, timeoutMs);
    agentEvents.on(agentId, onChange);
  });
};

const autoNoSwapAfterSec = Math.max(
  Number((app as any).config.AUTO_NO_SWAP_AFTER_SEC ?? "240") || 0,
  0
);

const maybeAutoResolveMove5Swap = async (game: any) => {
  if (!game || game.status !== "active" || autoNoSwapAfterSec <= 0) {
    return game;
  }

  const openingState = getOpeningState(game);
  if (
    !openingState.awaiting_swap ||
    openingState.awaiting_offer10_selection ||
    game.move_number !== 5
  ) {
    return game;
  }

  const updatedAtTs = Date.parse(String(game.updated_at ?? ""));
  if (!Number.isFinite(updatedAtTs)) {
    return game;
  }

  const ageMs = Date.now() - updatedAtTs;
  if (ageMs < autoNoSwapAfterSec * 1000) {
    return game;
  }

  const nowIso = new Date().toISOString();
  openingState.awaiting_swap = false;
  openingState.swap_after_move = null;
  openingState.swap_history = [
    ...(openingState.swap_history ?? []),
    {
      move_number: 5,
      decider_agent_id: "system:auto-no-swap",
      swapped: false,
      at: nowIso
    }
  ];

  const { data: updated, error: updateError } = await supabase
    .from("games")
    .update({
      turn_color: "white",
      phase: "midgame",
      opening_state: openingState,
      turn_deadline_at: nextTurnDeadlineIso("move"),
      updated_at: nowIso
    })
    .eq("id", game.id)
    .eq("updated_at", game.updated_at)
    .select("*")
    .maybeSingle();

  if (!updateError && updated) {
    notifyGameChanged(game.id, [updated.black_agent_id, updated.white_agent_id]);
    return updated;
  }

  const { data: latest } = await supabase
    .from("games")
    .select("*")
    .eq("id", game.id)
    .maybeSingle();

  return latest ?? game;
};

const maybeAutoResolveTurnTimeout = async (game: any) => {
  if (!game || game.status !== "active") return game;
  if (!game.turn_deadline_at) return game;

  const deadlineMs = Date.parse(String(game.turn_deadline_at));
  if (!Number.isFinite(deadlineMs) || Date.now() < deadlineMs) {
    return game;
  }

  const ctx = getRequiredActionContext(game);
  if (!ctx.actingAgentId || ctx.requiredAction === "none") {
    return game;
  }

  const loserColor =
    game.black_agent_id === ctx.actingAgentId
      ? "black"
      : game.white_agent_id === ctx.actingAgentId
      ? "white"
      : null;
  const winnerColor: "black" | "white" | null =
    loserColor === "black" ? "white" : loserColor === "white" ? "black" : null;
  if (!winnerColor) return game;

  const reason =
    ctx.requiredAction === "move"
      ? "timeout_move"
      : ctx.requiredAction === "swap"
      ? "timeout_swap"
      : "timeout_offer10_select";

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("games")
    .update({
      status: "finished",
      winner_color: winnerColor,
      result_reason: reason,
      turn_deadline_at: null,
      updated_at: nowIso
    })
    .eq("id", game.id)
    .eq("status", "active")
    .eq("turn_deadline_at", game.turn_deadline_at)
    .select("*")
    .maybeSingle();

  if (!updateError && updated) {
    notifyGameChanged(game.id, [game.black_agent_id, game.white_agent_id]);
    await updateElo(game, winnerColor);
    return updated;
  }

  const { data: latest } = await supabase
    .from("games")
    .select("*")
    .eq("id", game.id)
    .maybeSingle();

  return latest ?? game;
};

const resolveGameWithAutomations = async (game: any) => {
  const timed = await maybeAutoResolveTurnTimeout(game);
  if (!timed || timed.status !== "active") return timed;
  return maybeAutoResolveMove5Swap(timed);
};

let timeoutSweepRunning = false;
const runTimeoutSweep = async () => {
  if (timeoutSweepRunning) return;
  timeoutSweepRunning = true;
  try {
    const nowIso = new Date().toISOString();
    const { data: dueGames } = await supabase
      .from("games")
      .select("*")
      .eq("status", "active")
      .not("turn_deadline_at", "is", null)
      .lt("turn_deadline_at", nowIso)
      .limit(100);

    for (const game of dueGames ?? []) {
      await maybeAutoResolveTurnTimeout(game);
    }
  } catch (err) {
    app.log.error({ err }, "timeout sweep failed");
  } finally {
    timeoutSweepRunning = false;
  }
};

const timeoutSweepTimer = setInterval(() => {
  void runTimeoutSweep();
}, timeoutSweepIntervalMs);
if (typeof (timeoutSweepTimer as any).unref === "function") {
  (timeoutSweepTimer as any).unref();
}
void runTimeoutSweep();

const buildAgentWaitState = async (agentId: string) => {
  const activeGame = await getActiveGameForAgent(agentId);
  const game = activeGame ? await resolveGameWithAutomations(activeGame) : null;
  const inQueue = await isAgentInQueue(agentId);

  const color: "black" | "white" | null =
    game && game.black_agent_id === agentId
      ? "black"
      : game && game.white_agent_id === agentId
      ? "white"
      : null;

  const turnState = game ? resolveAgentTurnState(game, agentId) : null;
  const gameState: AgentGameState | null = game
    ? {
        id: game.id,
        status: game.status,
        phase: game.phase,
        move_number: game.move_number,
        turn_color: game.turn_color,
        updated_at: game.updated_at,
        color,
        is_my_turn: turnState?.isMyTurn ?? false,
        required_action: turnState?.requiredAction ?? "none",
        next_turn_number: turnState?.nextTurnNumber ?? Number(game.move_number ?? 0) + 1,
        turn_deadline_at: game.turn_deadline_at ?? null,
        time_left_ms: game.turn_deadline_at
          ? Math.max(0, Date.parse(String(game.turn_deadline_at)) - Date.now())
          : null
      }
    : null;

  const state = {
    in_queue: inQueue,
    game: gameState
  };
  return {
    ...state,
    revision: waitRevisionForAgentState(state)
  };
};

app.get("/health", async () => ({ ok: true }));

app.get("/agents", async () => {
  const { data } = await supabase
    .from("agents")
    .select("id,name,api_key_prefix,is_active,created_at,elo,games_played,wins,losses,draws")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  return { agents: data ?? [] };
});

app.get("/agents/name-rules", async () => {
  return {
    default_name: AGENT_NAME_DEFAULT,
    max_length: AGENT_NAME_MAX_LENGTH,
    recommended: AGENT_NAME_RECOMMENDED
  };
});

app.post("/agents/register", async (req, reply) => {
  const body = req.body as { name?: string } | undefined;
  const normalizedName = normalizeAgentName(body?.name);

  const { data: existingByName, error: existingError } = await supabase
    .from("agents")
    .select("id")
    .eq("name", normalizedName)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (existingError) {
    reply.code(500);
    return { error: existingError.message };
  }
  if (existingByName?.id) {
    reply.code(409);
    return {
      error: "Agent name already exists",
      hint: "다른 닉네임으로 등록하세요"
    };
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashKey(apiKey);
  const apiKeyPrefix = apiKey.slice(0, 8);

  const { data, error } = await supabase
    .from("agents")
    .insert({
      name: normalizedName,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      is_active: true,
      last_seen_at: new Date().toISOString()
    })
    .select("id, name, api_key_prefix")
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      reply.code(409);
      return {
        error: "Agent name already exists",
        hint: "다른 닉네임으로 등록하세요"
      };
    }
    reply.code(500);
    return { error: error?.message ?? "Failed to create agent" };
  }

  return {
    id: data.id,
    name: data.name,
    api_key_prefix: data.api_key_prefix,
    api_key: apiKey
  };
});

app.post("/queue/join", async (req, reply) => {
  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  const activeGame = await getActiveGameForAgent(authResult.agent.id);

  if (activeGame) {
    reply.code(409);
    return { error: "Agent already in active game", game_id: activeGame.id };
  }

  const { error } = await supabase
    .from("matchmaking_queue")
    .upsert({ agent_id: authResult.agent.id }, { onConflict: "agent_id" });

  if (error) {
    reply.code(500);
    return { error: error.message };
  }
  notifyAgentChanged(authResult.agent.id);

  let matchGameId: string | null = null;
  let matchBlackId: string | null = null;
  let matchWhiteId: string | null = null;
  const { data: matched, error: matchError } = await supabase.rpc("matchmake_once");
  if (matchError) {
    const missingRpc = String(matchError.message ?? "").includes("matchmake_once");
    if (!missingRpc) {
      reply.code(500);
      return { error: matchError.message };
    }
    matchGameId = await legacyMatchmakeOnce();
  } else if (Array.isArray(matched) && matched.length > 0 && matched[0]?.game_id) {
    const row = matched[0] as {
      game_id: string;
      black_agent_id?: string | null;
      white_agent_id?: string | null;
    };
    matchGameId = row.game_id;
    matchBlackId = row.black_agent_id ?? null;
    matchWhiteId = row.white_agent_id ?? null;
  }
  if (matchGameId && (!matchBlackId || !matchWhiteId)) {
    const { data: matchedGame } = await supabase
      .from("games")
      .select("black_agent_id,white_agent_id")
      .eq("id", matchGameId)
      .maybeSingle();
    if (matchedGame) {
      matchBlackId = matchedGame.black_agent_id ?? null;
      matchWhiteId = matchedGame.white_agent_id ?? null;
    }
  }
  if (matchGameId) {
    await supabase
      .from("games")
      .update({
        turn_deadline_at: nextTurnDeadlineIso("move"),
        updated_at: new Date().toISOString()
      })
      .eq("id", matchGameId)
      .eq("status", "active");
    notifyGameChanged(matchGameId, [matchBlackId, matchWhiteId]);
  }

  const { count } = await supabase
    .from("matchmaking_queue")
    .select("id", { count: "exact", head: true });

  return { ok: true, queue_size: count ?? 0, game_id: matchGameId };
});

app.post("/queue/leave", async (req, reply) => {
  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  const { error } = await supabase
    .from("matchmaking_queue")
    .delete()
    .eq("agent_id", authResult.agent.id);

  if (error) {
    reply.code(500);
    return { error: error.message };
  }
  notifyAgentChanged(authResult.agent.id);
  return { ok: true };
});

app.get("/queue/size", async () => {
  const { count } = await supabase
    .from("matchmaking_queue")
    .select("id", { count: "exact", head: true });
  return { queue_size: count ?? 0 };
});

app.get("/agents/active-game", async (req, reply) => {
  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;
  const state = await buildAgentWaitState(authResult.agent.id);
  return {
    in_queue: state.in_queue,
    game: state.game
  };
});

app.get("/agents/me", async (req, reply) => {
  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  const state = await buildAgentWaitState(authResult.agent.id);
  return {
    id: authResult.agent.id,
    name: authResult.agent.name,
    in_queue: state.in_queue,
    game: state.game
  };
});

app.get("/agents/wait", async (req, reply) => {
  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  const query = req.query as {
    since_revision?: string;
    timeout_sec?: string;
  };
  const sinceRevision = query.since_revision ?? null;
  const timeoutSec = Math.min(Math.max(Number(query.timeout_sec ?? 20), 5), 55);
  const deadline = Date.now() + timeoutSec * 1000;
  const pollWindowMs = 10000;

  while (true) {
    const state = await buildAgentWaitState(authResult.agent.id);
    const changed = sinceRevision ? state.revision !== sinceRevision : true;

    if (changed) {
      return {
        changed: true,
        in_queue: state.in_queue,
        game: state.game,
        revision: state.revision
      };
    }

    if (Date.now() >= deadline) {
      return {
        changed: false,
        in_queue: state.in_queue,
        game: state.game,
        revision: state.revision
      };
    }

    const remaining = deadline - Date.now();
    await waitForAgentEvent(authResult.agent.id, Math.min(remaining, pollWindowMs));
  }
});

app.get("/games/:id/wait", async (req, reply) => {
  const params = req.params as { id: string };
  const query = req.query as {
    since_move?: string;
    since_updated_at?: string;
    since_revision?: string;
    timeout_sec?: string;
  };
  const sinceMove = Number(query.since_move ?? -1);
  const sinceUpdatedAt = query.since_updated_at ?? null;
  const sinceRevision = query.since_revision ?? null;
  const timeoutSec = Math.min(Math.max(Number(query.timeout_sec ?? 20), 5), 55);
  const deadline = Date.now() + timeoutSec * 1000;
  const pollWindowMs = 10000;

  while (true) {
    const { data: fetchedGame, error } = await supabase
      .from("games")
      .select("id,status,phase,move_number,turn_color,turn_deadline_at,updated_at,opening_state")
      .eq("id", params.id)
      .maybeSingle();
    if (error || !fetchedGame) {
      reply.code(404);
      return { error: "Game not found" };
    }
    const game = await resolveGameWithAutomations(fetchedGame);
    const revision = waitRevisionForGame(game);

    const changedByMove = game.move_number !== sinceMove;
    const changedByUpdate = sinceUpdatedAt
      ? String(game.updated_at) !== String(sinceUpdatedAt)
      : changedByMove;
    const changedByRevision = sinceRevision
      ? String(revision) !== String(sinceRevision)
      : false;
    const changed =
      changedByMove || changedByUpdate || changedByRevision || game.status !== "active";
    if (changed) {
      return { changed: true, revision, game };
    }
    if (Date.now() >= deadline) {
      return { changed: false, revision, game };
    }
    const remaining = deadline - Date.now();
    await waitForGameEvent(params.id, Math.min(remaining, pollWindowMs));
  }
});

app.get("/games/:id", async (req, reply) => {
  const params = req.params as { id: string };
  const { data: fetchedGame, error: gameError } = await supabase
    .from("games")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (gameError || !fetchedGame) {
    reply.code(404);
    return { error: "Game not found" };
  }
  const game = await resolveGameWithAutomations(fetchedGame);

  const { data: moves } = await supabase
    .from("moves")
    .select("x,y,color,move_number")
    .eq("game_id", params.id)
    .order("move_number", { ascending: true });

  const { data: offer10 } = await supabase
    .from("offer10")
    .select("candidates,selected_candidate")
    .eq("game_id", params.id)
    .maybeSingle();

  const playerIds = [game.black_agent_id, game.white_agent_id].filter(
    (id): id is string => Boolean(id)
  );
  let playerNameMap: Record<string, string> = {};
  if (playerIds.length > 0) {
    const { data: players } = await supabase
      .from("agents")
      .select("id,name")
      .in("id", playerIds);
    playerNameMap = Object.fromEntries((players ?? []).map((p) => [p.id, p.name]));
  }

  const openingState = getOpeningState(game);
  const openingInfo = {
    tentative_black_agent_id: openingState.tentative_black_agent_id ?? null,
    tentative_white_agent_id: openingState.tentative_white_agent_id ?? null,
    awaiting_swap: openingState.awaiting_swap ?? false,
    swap_after_move: openingState.swap_after_move ?? null,
    swap_history: openingState.swap_history ?? [],
    awaiting_offer10:
      game.move_number === 4 &&
      !(openingState.awaiting_swap ?? false) &&
      !(openingState.awaiting_offer10_selection ?? false),
    awaiting_offer10_selection: openingState.awaiting_offer10_selection ?? false,
    offer10_id: openingState.offer10_id ?? null
  };

  const board = buildBoard(moves ?? []);
  const lastMove =
    moves && moves.length > 0
      ? {
          x: moves[moves.length - 1].x,
          y: moves[moves.length - 1].y,
          color: moves[moves.length - 1].color,
          move_number: moves[moves.length - 1].move_number
        }
      : null;
  const pendingDecision =
    openingInfo.awaiting_swap || openingInfo.awaiting_offer10_selection;
  const nextMove = game.move_number + 1;
  let legal_moves: Array<{ x: number; y: number }> | null = null;
  if (!pendingDecision) {
    if (nextMove <= 5) {
      legal_moves = legalMovesOpening(board, nextMove);
    } else {
      legal_moves = legalMovesMidgame(board, game.turn_color);
    }
  }

  return {
    id: game.id,
    status: game.status,
    winner_color: game.winner_color,
    result_reason: game.result_reason,
    black_agent_id: game.black_agent_id,
    white_agent_id: game.white_agent_id,
    black_agent_name: game.black_agent_id ? playerNameMap[game.black_agent_id] ?? null : null,
    white_agent_name: game.white_agent_id ? playerNameMap[game.white_agent_id] ?? null : null,
    updated_at: game.updated_at,
    board,
    phase: game.phase,
    turn_color: game.turn_color,
    move_number: game.move_number,
    opening_state: openingInfo,
    moves: moves ?? [],
    legal_moves,
    last_move: lastMove,
    offer10_candidates: offer10?.selected_candidate ? null : offer10?.candidates ?? null,
    turn_deadline_at: game.turn_deadline_at,
    turn_time_left_ms: game.turn_deadline_at
      ? Math.max(0, Date.parse(String(game.turn_deadline_at)) - Date.now())
      : null
  };
});

app.get("/games", async (req) => {
  const query = req.query as { limit?: string; status?: string } | undefined;
  const limit = Math.min(Number(query?.limit ?? 10) || 10, 50);
  const status =
    query?.status === "active" || query?.status === "finished" ? query.status : null;

  let gamesQuery = supabase
    .from("games")
    .select(
      "id,status,black_agent_id,white_agent_id,winner_color,result_reason,created_at,updated_at,move_number"
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) {
    gamesQuery = gamesQuery.eq("status", status);
  }

  const { data } = await gamesQuery;
  const games = await withAgentNames(data ?? []);

  return { games };
});

app.get("/overview", async (req) => {
  const query = req.query as
    | { live_limit?: string; history_limit?: string; ranking_limit?: string }
    | undefined;
  const liveLimit = Math.min(Number(query?.live_limit ?? 6) || 6, 20);
  const historyLimit = Math.min(Number(query?.history_limit ?? 8) || 8, 20);
  const rankingLimit = Math.min(Number(query?.ranking_limit ?? 8) || 8, 20);

  const [agents, games, active, rankingsRes, liveRes, historyRes] = await Promise.all([
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase.from("games").select("id", { count: "exact", head: true }),
    supabase
      .from("games")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("agents")
      .select("id,name,elo,games_played,wins,losses,draws,created_at")
      .eq("is_active", true)
      .order("elo", { ascending: false })
      .limit(rankingLimit),
    supabase
      .from("games")
      .select(
        "id,status,black_agent_id,white_agent_id,winner_color,result_reason,created_at,updated_at,move_number"
      )
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(liveLimit),
    supabase
      .from("games")
      .select(
        "id,status,black_agent_id,white_agent_id,winner_color,result_reason,created_at,updated_at,move_number"
      )
      .eq("status", "finished")
      .order("updated_at", { ascending: false })
      .limit(historyLimit)
  ]);

  const namedLive = await withAgentNames(liveRes.data ?? []);
  const namedHistory = await withAgentNames(historyRes.data ?? []);

  return {
    stats: {
      agents: agents.count ?? 0,
      games: games.count ?? 0,
      live_games: active.count ?? 0
    },
    rankings: rankingsRes.data ?? [],
    live_games: namedLive,
    recent_games: namedHistory
  };
});

app.get("/stats/overview", async () => {
  const [agents, games, active] = await Promise.all([
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase.from("games").select("id", { count: "exact", head: true }),
    supabase
      .from("games")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
  ]);
  return {
    agents: agents.count ?? 0,
    games: games.count ?? 0,
    live_games: active.count ?? 0
  };
});

app.get("/agents/rankings", async (req) => {
  const query = req.query as { limit?: string } | undefined;
  const limit = Math.min(Number(query?.limit ?? 10) || 10, 50);
  const { data } = await supabase
    .from("agents")
    .select("id,name,elo,games_played,wins,losses,draws,created_at")
    .eq("is_active", true)
    .order("elo", { ascending: false })
    .limit(limit);
  return { agents: data ?? [] };
});

const symmetryKey = (x: number, y: number) => {
  const n = BOARD_SIZE - 1;
  const transforms: Array<[number, number]> = [
    [x, y],
    [y, n - x],
    [n - x, n - y],
    [n - y, x],
    [n - x, y],
    [n - y, n - x],
    [x, n - y],
    [y, x]
  ];
  const keys = transforms.map(([tx, ty]) => `${tx},${ty}`);
  keys.sort();
  return keys[0];
};

app.post("/games/:id/swap", async (req, reply) => {
  const params = req.params as { id: string };
  const body = req.body as { swap?: boolean } | undefined;
  if (typeof body?.swap !== "boolean") {
    reply.code(400);
    return { error: "Missing swap boolean" };
  }

  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  let { data: game, error: gameError } = await supabase
    .from("games")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (gameError || !game) {
    reply.code(404);
    return { error: "Game not found" };
  }
  game = await maybeAutoResolveTurnTimeout(game);
  if (!game || game.status !== "active") {
    reply.code(409);
    return { error: "Game not active" };
  }

  const openingState = getOpeningState(game);
  if (!openingState.awaiting_swap) {
    reply.code(409);
    return { error: "No swap decision pending" };
  }
  if (openingState.awaiting_offer10_selection) {
    reply.code(409);
    return { error: "Offer10 selection pending" };
  }

  const lastMove = game.move_number;
  if (lastMove < 1 || lastMove > 5) {
    reply.code(409);
    return { error: "Swap only allowed after moves 1-5" };
  }
  const lastMoverColor = openingTurnColorForMove(lastMove);
  const swapDecider =
    lastMoverColor === "black" ? game.white_agent_id : game.black_agent_id;

  if (!swapDecider || swapDecider !== authResult.agent.id) {
    reply.code(403);
    return { error: "Not allowed to swap" };
  }

  let blackId = game.black_agent_id;
  let whiteId = game.white_agent_id;
  if (body.swap) {
    const temp = blackId;
    blackId = whiteId;
    whiteId = temp;
  }

  const nextMove = lastMove + 1;
  let nextPhase = game.phase;
  if (nextMove === 2) nextPhase = "opening_2";
  else if (nextMove === 3) nextPhase = "opening_3";
  else if (nextMove === 4) nextPhase = "opening_4";
  else if (nextMove === 5) nextPhase = "opening_5";
  else if (nextMove >= 6) nextPhase = "midgame";

  const nextTurnColor = nextMove <= 5 ? openingTurnColorForMove(nextMove) : "white";

  openingState.awaiting_swap = false;
  openingState.swap_after_move = null;
  openingState.swap_history = [
    ...(openingState.swap_history ?? []),
    {
      move_number: lastMove,
      decider_agent_id: authResult.agent.id,
      swapped: body.swap,
      at: new Date().toISOString()
    }
  ];

  await supabase
    .from("games")
    .update({
      black_agent_id: blackId,
      white_agent_id: whiteId,
      turn_color: nextTurnColor,
      phase: nextPhase,
      opening_state: openingState,
      turn_deadline_at: nextTurnDeadlineIso("move"),
      updated_at: new Date().toISOString()
    })
    .eq("id", params.id);

  notifyGameChanged(params.id, [blackId, whiteId]);
  return { ok: true, swapped: body.swap };
});

app.post("/games/:id/offer10", async (req, reply) => {
  const params = req.params as { id: string };
  const body = req.body as { candidates?: Array<{ x: number; y: number }> } | undefined;
  if (!body?.candidates || body.candidates.length !== 10) {
    reply.code(400);
    return { error: "Offer10 requires 10 candidates" };
  }

  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  let { data: game, error: gameError } = await supabase
    .from("games")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (gameError || !game) {
    reply.code(404);
    return { error: "Game not found" };
  }
  game = await maybeAutoResolveTurnTimeout(game);
  if (!game || game.status !== "active") {
    reply.code(409);
    return { error: "Game not active" };
  }

  const openingState = getOpeningState(game);
  if (game.move_number !== 4 || openingState.awaiting_swap) {
    reply.code(409);
    return { error: "Offer10 only allowed after move 4 with no pending swap" };
  }
  if (openingState.awaiting_offer10_selection) {
    reply.code(409);
    return { error: "Offer10 already pending" };
  }

  if (authResult.agent.id !== openingState.tentative_black_agent_id) {
    reply.code(403);
    return { error: "Only tentative black can offer 10" };
  }

  const seen = new Set<string>();
  const sym = new Set<string>();
  for (const c of body.candidates) {
    if (
      typeof c.x !== "number" ||
      typeof c.y !== "number" ||
      c.x < 0 ||
      c.x >= BOARD_SIZE ||
      c.y < 0 ||
      c.y >= BOARD_SIZE
    ) {
      reply.code(400);
      return { error: "Candidate out of bounds" };
    }
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) {
      reply.code(400);
      return { error: "Duplicate candidate" };
    }
    seen.add(key);
    sym.add(symmetryKey(c.x, c.y));
  }
  if (sym.size !== 10) {
    reply.code(400);
    return { error: "Candidates must be from distinct symmetry classes" };
  }

  const { data: offer, error: offerError } = await supabase
    .from("offer10")
    .insert({
      game_id: params.id,
      proposed_by: authResult.agent.id,
      candidates: body.candidates
    })
    .select("id")
    .single();

  if (offerError || !offer) {
    reply.code(500);
    return { error: offerError?.message ?? "Failed to create offer10" };
  }

  openingState.awaiting_offer10_selection = true;
  openingState.offer10_id = offer.id;

  await supabase
    .from("games")
    .update({
      opening_state: openingState,
      turn_deadline_at: nextTurnDeadlineIso("offer10_select"),
      updated_at: new Date().toISOString()
    })
    .eq("id", params.id);

  notifyGameChanged(params.id, [game.black_agent_id, game.white_agent_id]);
  return { ok: true, offer10_id: offer.id };
});

app.post("/games/:id/offer10/select", async (req, reply) => {
  const params = req.params as { id: string };
  const body = req.body as { x?: number; y?: number } | undefined;
  if (typeof body?.x !== "number" || typeof body?.y !== "number") {
    reply.code(400);
    return { error: "Missing x,y" };
  }

  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;

  let { data: game, error: gameError } = await supabase
    .from("games")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (gameError || !game) {
    reply.code(404);
    return { error: "Game not found" };
  }
  game = await maybeAutoResolveTurnTimeout(game);
  if (!game || game.status !== "active") {
    reply.code(409);
    return { error: "Game not active" };
  }

  const openingState = getOpeningState(game);
  if (game.move_number !== 4) {
    reply.code(409);
    return { error: "Offer10 selection only allowed after move 4" };
  }
  if (!openingState.awaiting_offer10_selection || !openingState.offer10_id) {
    reply.code(409);
    return { error: "No offer10 selection pending" };
  }
  if (authResult.agent.id !== openingState.tentative_white_agent_id) {
    reply.code(403);
    return { error: "Only tentative white can select offer10" };
  }

  const { data: offer } = await supabase
    .from("offer10")
    .select("id,candidates")
    .eq("id", openingState.offer10_id)
    .maybeSingle();
  if (!offer) {
    reply.code(404);
    return { error: "Offer10 not found" };
  }

  const candidates = (offer.candidates ?? []) as Array<{ x: number; y: number }>;
  const match = candidates.find((c) => c.x === body.x && c.y === body.y);
  if (!match) {
    reply.code(400);
    return { error: "Selected point not in candidates" };
  }

  const { data: occupied } = await supabase
    .from("moves")
    .select("id")
    .eq("game_id", params.id)
    .eq("x", body.x)
    .eq("y", body.y)
    .maybeSingle();
  if (occupied) {
    reply.code(409);
    return { error: "Cell already occupied" };
  }

  const moveColor = getColorForAgent(game, openingState.tentative_black_agent_id ?? null);
  if (!moveColor) {
    reply.code(409);
    return { error: "Invalid color assignment" };
  }

  const { error: insertError } = await supabase
    .from("moves")
    .insert({
      game_id: params.id,
      move_number: 5,
      x: body.x,
      y: body.y,
      color: moveColor
    });

  if (insertError) {
    reply.code(500);
    return { error: insertError.message };
  }

  openingState.awaiting_offer10_selection = false;
  openingState.awaiting_swap = false;
  openingState.swap_after_move = null;

  await supabase
    .from("offer10")
    .update({ selected_candidate: { x: body.x, y: body.y } })
    .eq("id", offer.id);

  await supabase
    .from("games")
    .update({
      move_number: 5,
      phase: "midgame",
      turn_color: "white",
      opening_state: openingState,
      turn_deadline_at: nextTurnDeadlineIso("move"),
      updated_at: new Date().toISOString()
    })
    .eq("id", params.id);

  notifyGameChanged(params.id, [game.black_agent_id, game.white_agent_id]);
  return { ok: true };
});

app.post("/games/:id/move", async (req, reply) => {
  const params = req.params as { id: string };
  const body = req.body as
    | { x?: number; y?: number; turn_number?: number; idempotency_key?: string }
    | undefined;

  if (
    typeof body?.x !== "number" ||
    typeof body?.y !== "number" ||
    typeof body?.turn_number !== "number" ||
    typeof body?.idempotency_key !== "string" ||
    body.idempotency_key.trim().length === 0
  ) {
    reply.code(400);
    return { error: "Missing x, y, turn_number, or idempotency_key" };
  }

  if (body.x < 0 || body.x >= BOARD_SIZE || body.y < 0 || body.y >= BOARD_SIZE) {
    reply.code(400);
    return { error: "Move out of bounds" };
  }

  const authResult = await getAgentFromAuth(req, reply);
  if ("error" in authResult) return authResult;
  const idempotencyKey = body.idempotency_key.trim();

  const idemMapKey = `${params.id}:${authResult.agent.id}:${idempotencyKey}`;
  let useFallback = false;

  const existingFallback = moveIdempotencyFallback.get(idemMapKey);
  if (existingFallback) {
    if (
      existingFallback.turn_number !== body.turn_number ||
      existingFallback.x !== body.x ||
      existingFallback.y !== body.y
    ) {
      reply.code(409);
      return { error: "Idempotency key reused with different payload" };
    }
    if (typeof existingFallback.status_code === "number" && existingFallback.response) {
      reply.code(existingFallback.status_code);
      return { ...existingFallback.response, duplicate: true };
    }
    reply.code(409);
    return { error: "Request in progress, retry with same idempotency_key" };
  }

  moveIdempotencyFallback.set(idemMapKey, {
    turn_number: body.turn_number,
    x: body.x,
    y: body.y
  });

  const idemWhere = (q: any) =>
    q
      .eq("game_id", params.id)
      .eq("agent_id", authResult.agent.id)
      .eq("idempotency_key", idempotencyKey);

  const finalize = async (statusCode: number, payload: Record<string, any>) => {
    const item = moveIdempotencyFallback.get(idemMapKey);
    if (item) {
      item.status_code = statusCode;
      item.response = payload;
      moveIdempotencyFallback.set(idemMapKey, item);
    }
    if (!useFallback) {
      const { error: updateError } = await idemWhere(
        supabase.from("move_idempotency").update({
          status_code: statusCode,
          response: payload
        })
      );
      if (updateError) {
        const missingResponseColumns =
          isMissingColumnError(updateError, "status_code") ||
          isMissingColumnError(updateError, "response");
        if (isMissingTableError(updateError, "move_idempotency") || missingResponseColumns) {
          useFallback = true;
        } else {
          app.log.warn({ err: updateError }, "failed to persist idempotency response");
        }
      }
    }
    reply.code(statusCode);
    return payload;
  };

  const { error: idemInsertError } = await supabase.from("move_idempotency").insert({
    game_id: params.id,
    agent_id: authResult.agent.id,
    idempotency_key: idempotencyKey,
    turn_number: body.turn_number,
    x: body.x,
    y: body.y
  });
  if (idemInsertError) {
    const missingTable = isMissingTableError(idemInsertError, "move_idempotency");
    if (missingTable) {
      useFallback = true;
    } else if (idemInsertError.code !== "23505") {
      moveIdempotencyFallback.delete(idemMapKey);
      reply.code(500);
      return { error: idemInsertError.message };
    } else {
      const fallback = moveIdempotencyFallback.get(idemMapKey);
      if (fallback && typeof fallback.status_code === "number" && fallback.response) {
        reply.code(fallback.status_code);
        return { ...fallback.response, duplicate: true };
      }

      const { data: existing, error: existingError } = await idemWhere(
        supabase
          .from("move_idempotency")
          .select("turn_number,x,y,status_code,response")
          .maybeSingle()
      );
      if (existingError) {
        const missingResponseColumns =
          isMissingColumnError(existingError, "status_code") ||
          isMissingColumnError(existingError, "response");
        if (missingResponseColumns || isMissingTableError(existingError, "move_idempotency")) {
          useFallback = true;
          reply.code(409);
          return { error: "Request in progress, retry with same idempotency_key" };
        }
        moveIdempotencyFallback.delete(idemMapKey);
        reply.code(500);
        return { error: existingError.message };
      }
      if (!existing) {
        moveIdempotencyFallback.delete(idemMapKey);
        reply.code(409);
        return { error: "Duplicate idempotency request" };
      }
      if (
        existing.turn_number !== body.turn_number ||
        existing.x !== body.x ||
        existing.y !== body.y
      ) {
        moveIdempotencyFallback.delete(idemMapKey);
        reply.code(409);
        return { error: "Idempotency key reused with different payload" };
      }
      if (typeof existing.status_code === "number" && existing.response) {
        moveIdempotencyFallback.set(idemMapKey, {
          turn_number: body.turn_number,
          x: body.x,
          y: body.y,
          status_code: existing.status_code,
          response: existing.response as Record<string, any>
        });
        reply.code(existing.status_code);
        return { ...(existing.response as Record<string, any>), duplicate: true };
      }
      reply.code(409);
      return { error: "Request in progress, retry with same idempotency_key" };
    }
  }

  let { data: game, error: gameError } = await supabase
    .from("games")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (gameError || !game) {
    return finalize(404, { error: "Game not found" });
  }
  game = await maybeAutoResolveTurnTimeout(game);
  if (!game || game.status !== "active") {
    return finalize(409, { error: "Game not active" });
  }
  if (game.status === "finished") {
    return finalize(409, { error: "Game already finished" });
  }

  const openingState = getOpeningState(game);
  if (openingState.awaiting_swap) {
    return finalize(409, { error: "Swap decision required" });
  }
  if (openingState.awaiting_offer10_selection) {
    return finalize(409, { error: "Offer10 selection required" });
  }

  let expectedAgentId: string | null = null;
  if (body.turn_number <= 5) {
    const expectedTurnColor = openingTurnColorForMove(body.turn_number);
    expectedAgentId =
      expectedTurnColor === "black" ? game.black_agent_id : game.white_agent_id;
  } else {
    expectedAgentId =
      game.turn_color === "black" ? game.black_agent_id : game.white_agent_id;
  }
  if (!expectedAgentId || expectedAgentId !== authResult.agent.id) {
    return finalize(403, { error: "Not your turn" });
  }

  if (body.turn_number !== game.move_number + 1) {
    return finalize(409, { error: "turn_number mismatch" });
  }

  if (game.phase.startsWith("opening_") && body.turn_number <= 5) {
    const err = validateOpeningMove(body.turn_number, body.x, body.y);
    if (err) {
      return finalize(409, { error: err });
    }
  }

  const { data: occupied } = await supabase
    .from("moves")
    .select("id")
    .eq("game_id", params.id)
    .eq("x", body.x)
    .eq("y", body.y)
    .maybeSingle();
  if (occupied) {
    return finalize(409, { error: "Cell already occupied" });
  }

  const moveColor =
    expectedAgentId === game.black_agent_id
      ? "black"
      : expectedAgentId === game.white_agent_id
      ? "white"
      : null;
  if (!moveColor) {
    return finalize(409, { error: "Invalid color assignment" });
  }

  const { error: insertError } = await supabase
    .from("moves")
    .insert({
      game_id: params.id,
      move_number: body.turn_number,
      x: body.x,
      y: body.y,
      color: moveColor
    });

  if (insertError) {
    if (insertError.code === "23505") {
      return finalize(409, { error: "Move already submitted for this turn" });
    }
    return finalize(500, { error: insertError.message });
  }

  if (body.turn_number >= 6) {
    const { data: allMoves } = await supabase
      .from("moves")
      .select("x,y,color")
      .eq("game_id", params.id);

    const board = buildBoard(allMoves ?? []);
    const evalResult = evaluateMove(board, {
      x: body.x,
      y: body.y,
      color: moveColor
    });

    if (evalResult.forbidden) {
      await supabase
        .from("moves")
        .update({ is_forbidden: true })
        .eq("game_id", params.id)
        .eq("move_number", body.turn_number);

      await supabase
        .from("games")
        .update({
          status: "finished",
          winner_color: "white",
          result_reason: evalResult.reason,
          turn_deadline_at: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", params.id);

      notifyGameChanged(params.id, [game.black_agent_id, game.white_agent_id]);
      await updateElo(game, "white");
      return finalize(200, {
        ok: true,
        forbidden: true,
        winner: "white",
        reason: evalResult.reason
      });
    }

    if (evalResult.win) {
      await supabase
        .from("games")
        .update({
          status: "finished",
          winner_color: evalResult.winColor,
          result_reason: evalResult.reason,
          turn_deadline_at: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", params.id);

      notifyGameChanged(params.id, [game.black_agent_id, game.white_agent_id]);
      if (evalResult.winColor) {
        await updateElo(game, evalResult.winColor);
      }
      return finalize(200, {
        ok: true,
        winner: evalResult.winColor,
        reason: evalResult.reason
      });
    }
  }

  let nextPhase = game.phase;
  if (body.turn_number === 1) nextPhase = "opening_2";
  else if (body.turn_number === 2) nextPhase = "opening_3";
  else if (body.turn_number === 3) nextPhase = "opening_4";
  else if (body.turn_number === 4) nextPhase = "opening_5";
  else if (body.turn_number >= 6) nextPhase = "midgame";

  if (body.turn_number <= 4) {
    openingState.awaiting_swap = true;
    openingState.swap_after_move = body.turn_number;
  } else if (body.turn_number === 5) {
    openingState.awaiting_swap = true;
    openingState.swap_after_move = 5;
  }

  const nextTurnColor =
    body.turn_number < 5
      ? openingTurnColorForMove(body.turn_number + 1)
      : moveColor === "black"
      ? "white"
      : "black";
  const nextRequiredAction: AgentRequiredAction = openingState.awaiting_swap ? "swap" : "move";

  await supabase
    .from("games")
    .update({
      move_number: body.turn_number,
      turn_color: nextTurnColor,
      phase: nextPhase,
      opening_state: openingState,
      turn_deadline_at: nextTurnDeadlineIso(nextRequiredAction),
      updated_at: new Date().toISOString()
    })
    .eq("id", params.id);

  notifyGameChanged(params.id, [game.black_agent_id, game.white_agent_id]);
  return finalize(200, { ok: true });
});

const port = Number((app as any).config.API_PORT);
const host = (app as any).config.API_HOST;

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
