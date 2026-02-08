#!/usr/bin/env python3
"""Simple daemon agent for Renju AI Arena.

Usage:
  set ARENA_BASE_URL=http://localhost:4000
  set AGENT_NAME=daemon-bot
  set AGENT_API_KEY=<optional existing key>
  python agents/daemon_agent.py
"""

import json
import math
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.getenv("ARENA_BASE_URL", "http://localhost:4000").rstrip("/")
AGENT_NAME = os.getenv("AGENT_NAME", "python-daemon")
AGENT_API_KEY = os.getenv("AGENT_API_KEY", "").strip()
CREDENTIAL_PATH = os.path.expanduser(
    os.getenv("AGENT_CREDENTIAL_PATH", "~/.renju-agent/credentials.json")
)
WAIT_TIMEOUT = int(os.getenv("WAIT_TIMEOUT", "25"))
IDLE_SLEEP = float(os.getenv("IDLE_SLEEP", "2"))
EXIT_AFTER_GAME = os.getenv("EXIT_AFTER_GAME", "0").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
BOARD_SIZE = 15
CENTER = 7
DIRECTIONS = ((1, 0), (0, 1), (1, 1), (1, -1))
LOOKAHEAD_DEPTH = max(1, min(3, int(os.getenv("LOOKAHEAD_DEPTH", "2"))))
ROOT_CANDIDATES = max(8, int(os.getenv("ROOT_CANDIDATES", "14")))
REPLY_CANDIDATES = max(6, int(os.getenv("REPLY_CANDIDATES", "10")))
EARLY_LOCALITY_UNTIL = max(8, int(os.getenv("EARLY_LOCALITY_UNTIL", "14")))
SWAP_MARGIN = int(os.getenv("SWAP_MARGIN", "450"))
DIVERSITY_TOP_N = max(1, min(6, int(os.getenv("DIVERSITY_TOP_N", "3"))))
DIVERSITY_SCORE_GAP = max(0, int(os.getenv("DIVERSITY_SCORE_GAP", "900")))
DIVERSITY_ENABLED = os.getenv("AGENT_DIVERSITY", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
OFFER10_ENABLED = os.getenv("OFFER10_ENABLED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
OFFER10_MIN_IMPROVEMENT = float(os.getenv("OFFER10_MIN_IMPROVEMENT", "0.0"))
OFFER10_LOGIT_SCALE = float(os.getenv("OFFER10_LOGIT_SCALE", "26000"))
DETERMINISTIC_MODE = os.getenv("AGENT_DETERMINISTIC", "0").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)
RNG_SEED_RAW = os.getenv("AGENT_RNG_SEED", "").strip()
if RNG_SEED_RAW:
    try:
        RNG = random.Random(int(RNG_SEED_RAW))
    except ValueError:
        RNG = random.Random(RNG_SEED_RAW)
elif DETERMINISTIC_MODE:
    RNG = random.Random(0)
else:
    RNG = random.Random()


def http_json(method, path, token=None, payload=None, timeout=30):
    url = f"{BASE_URL}{path}"
    body = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8")
            return res.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return e.code, {"error": raw}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}


def register_agent(name):
    status, data = http_json("POST", "/agents/register", payload={"name": name})
    if status != 200:
        raise RuntimeError(f"register failed: {status} {data}")
    return data["api_key"], data["id"]


def join_queue(token):
    status, data = http_json("POST", "/queue/join", token=token, payload={})
    return status, data


def get_active_game(token):
    status, data = http_json("GET", "/agents/active-game", token=token)
    return status, data.get("game"), data


def get_me(token):
    status, data = http_json("GET", "/agents/me", token=token)
    return status, data


def wait_agent_state(token, since_revision=""):
    qs = urllib.parse.urlencode(
        {
            "since_revision": since_revision or "",
            "timeout_sec": WAIT_TIMEOUT,
        }
    )
    status, data = http_json("GET", f"/agents/wait?{qs}", token=token, timeout=WAIT_TIMEOUT + 10)
    return status, data


def get_game(game_id):
    status, data = http_json("GET", f"/games/{game_id}")
    return status, data


def wait_game(game_id, since_move, since_updated_at, since_revision=""):
    qs = urllib.parse.urlencode(
        {
            "since_move": since_move,
            "since_updated_at": since_updated_at or "",
            "since_revision": since_revision or "",
            "timeout_sec": WAIT_TIMEOUT,
        }
    )
    status, data = http_json("GET", f"/games/{game_id}/wait?{qs}", timeout=WAIT_TIMEOUT + 10)
    return status, data


def post_swap(token, game_id, do_swap=False):
    return http_json("POST", f"/games/{game_id}/swap", token=token, payload={"swap": do_swap})


def post_offer10(token, game_id, candidates):
    return http_json(
        "POST",
        f"/games/{game_id}/offer10",
        token=token,
        payload={"candidates": candidates},
    )


def post_offer10_select(token, game_id, x, y):
    return http_json(
        "POST",
        f"/games/{game_id}/offer10/select",
        token=token,
        payload={"x": x, "y": y},
    )


def post_move(token, game_id, x, y, turn_number, idempotency_key):
    return http_json(
        "POST",
        f"/games/{game_id}/move",
        token=token,
        payload={
            "x": x,
            "y": y,
            "turn_number": turn_number,
            "idempotency_key": idempotency_key,
        },
    )


def load_saved_credentials():
    path = CREDENTIAL_PATH
    if not path:
        return "", ""
    if not os.path.isfile(path):
        return "", ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if str(data.get("base_url", "")).rstrip("/") != BASE_URL:
            return "", ""
        if str(data.get("agent_name", "")).strip() != AGENT_NAME:
            return "", ""
        token = str(data.get("api_key", "")).strip()
        agent_id = str(data.get("agent_id", "")).strip()
        return token, agent_id
    except Exception:  # noqa: BLE001
        return "", ""


def save_token(token, agent_id):
    path = CREDENTIAL_PATH
    if not path:
        return
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        payload = {
            "base_url": BASE_URL,
            "agent_name": AGENT_NAME,
            "agent_id": agent_id,
            "api_key": token,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        print(f"credential save failed: {e}")


def in_bounds(x, y):
    return 0 <= x < BOARD_SIZE and 0 <= y < BOARD_SIZE


def opposite(color):
    return "white" if color == "black" else "black"


def symmetry_key(x, y):
    n = BOARD_SIZE - 1
    transforms = (
        (x, y),
        (y, n - x),
        (n - x, n - y),
        (n - y, x),
        (n - x, y),
        (n - y, n - x),
        (x, n - y),
        (y, x),
    )
    keys = [f"{tx},{ty}" for (tx, ty) in transforms]
    keys.sort()
    return keys[0]


def score_to_win_prob(score):
    scale = OFFER10_LOGIT_SCALE if OFFER10_LOGIT_SCALE > 1 else 26000.0
    x = max(-60.0, min(60.0, float(score) / float(scale)))
    return 1.0 / (1.0 + math.exp(-x))


def count_one_side(board, x, y, dx, dy, color):
    length = 0
    cx = x + dx
    cy = y + dy
    while in_bounds(cx, cy) and board[cy][cx] == color:
        length += 1
        cx += dx
        cy += dy
    open_end = in_bounds(cx, cy) and board[cy][cx] is None
    return length, open_end


def line_stats(board, x, y, dx, dy, color):
    left, left_open = count_one_side(board, x, y, -dx, -dy, color)
    right, right_open = count_one_side(board, x, y, dx, dy, color)
    return left + 1 + right, int(left_open) + int(right_open)


def is_winning_move(board, x, y, color):
    if not in_bounds(x, y) or board[y][x] is not None:
        return False

    board[y][x] = color
    lengths = [line_stats(board, x, y, dx, dy, color)[0] for dx, dy in DIRECTIONS]
    board[y][x] = None

    if color == "black":
        # Server rule is exact five for black; overline is never a black win.
        if any(length >= 6 for length in lengths):
            return False
        return any(length == 5 for length in lengths)
    return any(length >= 5 for length in lengths)


def is_win_after_placing(board, x, y, color):
    lengths = [line_stats(board, x, y, dx, dy, color)[0] for dx, dy in DIRECTIONS]
    if color == "black":
        if any(length >= 6 for length in lengths):
            return False
        return any(length == 5 for length in lengths)
    return any(length >= 5 for length in lengths)


def find_immediate_wins(board, color, limit=None):
    wins = []
    for y in range(BOARD_SIZE):
        for x in range(BOARD_SIZE):
            if board[y][x] is not None:
                continue
            if is_winning_move(board, x, y, color):
                wins.append((x, y))
                if limit is not None and len(wins) >= limit:
                    return wins
    return wins


def center_score(x, y):
    return (14 - (abs(x - CENTER) + abs(y - CENTER))) * 3


def stable_move_key(move):
    x = move["x"]
    y = move["y"]
    # Prefer center-proximate and then stable coordinate order.
    return (-center_score(x, y), y, x)


def pick_stable_move(moves):
    if not moves:
        return None
    return sorted(moves, key=stable_move_key)[0]


def get_color_for_agent(game, agent_id):
    if not agent_id:
        return None
    if game.get("black_agent_id") == agent_id:
        return "black"
    if game.get("white_agent_id") == agent_id:
        return "white"
    return None


def get_tentative_mover_agent_id(opening_state, move_number):
    if move_number % 2 == 1:
        return opening_state.get("tentative_black_agent_id")
    return opening_state.get("tentative_white_agent_id")


def get_swap_decider_agent_id(game):
    last_move = int(game.get("move_number", 0))
    if last_move < 1 or last_move > 5:
        return None
    last_mover_color = "black" if (last_move % 2 == 1) else "white"
    if last_mover_color == "black":
        return game.get("white_agent_id")
    return game.get("black_agent_id")


def get_expected_mover_agent_id(game):
    next_move = int(game.get("move_number", 0)) + 1
    if next_move <= 5:
        expected_color = "black" if (next_move % 2 == 1) else "white"
    else:
        expected_color = game.get("turn_color")

    if expected_color == "black":
        return game.get("black_agent_id")
    if expected_color == "white":
        return game.get("white_agent_id")
    return None


def projected_turn_color_after_swap(game, do_swap):
    last_move = int(game.get("move_number", 0))
    next_move = last_move + 1

    if next_move <= 5:
        return "black" if (next_move % 2 == 1) else "white"
    return "white"


def rank_scored_moves(scored_moves):
    return sorted(scored_moves, key=lambda item: (-item[0], stable_move_key(item[1])))


def pick_ranked_move(scored_moves):
    if not scored_moves:
        return None

    ranked = rank_scored_moves(scored_moves)
    best_score = ranked[0][0]

    if DETERMINISTIC_MODE or not DIVERSITY_ENABLED:
        top = [move for score, move in ranked if score == best_score]
        return pick_stable_move(top)

    pool = [item for item in ranked if item[0] >= best_score - DIVERSITY_SCORE_GAP]
    pool = pool[: max(DIVERSITY_TOP_N, 1)]
    if len(pool) == 1:
        return pool[0][1]

    low = min(score for score, _ in pool)
    weights = [max(1, score - low + 1) for score, _ in pool]
    ticket = RNG.uniform(0, float(sum(weights)))
    cumulative = 0.0
    for idx, (_, move) in enumerate(pool):
        cumulative += float(weights[idx])
        if ticket <= cumulative:
            return move
    return pool[-1][1]


def neighborhood_stones(board, x, y, radius=2):
    stones = 0
    for ny in range(max(0, y - radius), min(BOARD_SIZE, y + radius + 1)):
        for nx in range(max(0, x - radius), min(BOARD_SIZE, x + radius + 1)):
            if nx == x and ny == y:
                continue
            if board[ny][nx] is not None:
                stones += 1
    return stones


def blocking_threat_score(board, x, y, opponent_color):
    score = 0
    for dx, dy in DIRECTIONS:
        left, left_open = count_one_side(board, x, y, -dx, -dy, opponent_color)
        right, right_open = count_one_side(board, x, y, dx, dy, opponent_color)
        span = left + right
        open_ends = int(left_open) + int(right_open)
        if span >= 4:
            score += 12000
        elif span == 3:
            score += 2500 if open_ends >= 1 else 500
        elif span == 2 and open_ends == 2:
            score += 300
    return score


def own_shape_score(board, x, y, color):
    score = 0
    for dx, dy in DIRECTIONS:
        length, open_ends = line_stats(board, x, y, dx, dy, color)
        if length >= 5:
            score += 50000
        elif length == 4:
            score += 6000 if open_ends == 2 else 1200
        elif length == 3:
            score += 700 if open_ends == 2 else 130
        elif length == 2 and open_ends == 2:
            score += 50
    return score


def shortlist_moves(board, legal, opponent_color, limit=48):
    if len(legal) <= limit:
        return legal

    scored = []
    for move in legal:
        x = move["x"]
        y = move["y"]
        score = (
            blocking_threat_score(board, x, y, opponent_color)
            + neighborhood_stones(board, x, y, radius=2) * 16
            + center_score(x, y)
        )
        scored.append((score, neighborhood_stones(board, x, y, radius=1), -y, -x, move))
    scored.sort(key=lambda item: (item[0], item[1], item[2], item[3]), reverse=True)
    return [item[4] for item in scored[:limit]]


def score_move(board, move, color):
    x = move["x"]
    y = move["y"]
    opponent_color = opposite(color)

    block_score = blocking_threat_score(board, x, y, opponent_color)

    board[y][x] = color
    own_score = own_shape_score(board, x, y, color)
    own_next_wins = len(find_immediate_wins(board, color, limit=3))
    opp_next_wins = len(find_immediate_wins(board, opponent_color, limit=3))
    board[y][x] = None

    return (
        own_score
        + own_next_wins * 4200
        - opp_next_wins * 7800
        + block_score
        + neighborhood_stones(board, x, y, radius=2) * 18
        + center_score(x, y)
    )


def best_scored_move(board, moves, color):
    scored = []
    for move in moves:
        score = score_move(board, move, color)
        scored.append((score, move))
    return pick_ranked_move(scored)


def collect_frontier_moves(board, radius=2):
    seen = set()
    has_stone = False
    for y in range(BOARD_SIZE):
        for x in range(BOARD_SIZE):
            if board[y][x] is None:
                continue
            has_stone = True
            for ny in range(max(0, y - radius), min(BOARD_SIZE, y + radius + 1)):
                for nx in range(max(0, x - radius), min(BOARD_SIZE, x + radius + 1)):
                    if board[ny][nx] is not None:
                        continue
                    seen.add((nx, ny))
    if not has_stone:
        return [{"x": CENTER, "y": CENTER}]
    return [{"x": x, "y": y} for (x, y) in seen]


def quick_position_score(board, perspective_color):
    opponent_color = opposite(perspective_color)
    my_now = len(find_immediate_wins(board, perspective_color, limit=2))
    opp_now = len(find_immediate_wins(board, opponent_color, limit=2))
    score = my_now * 12000 - opp_now * 14500

    frontier = collect_frontier_moves(board, radius=2)
    frontier = shortlist_moves(board, frontier, opponent_color, limit=16)
    for m in frontier:
        x = m["x"]
        y = m["y"]
        score += blocking_threat_score(board, x, y, opponent_color) // 6

        board[y][x] = perspective_color
        score += own_shape_score(board, x, y, perspective_color) // 6
        board[y][x] = None

        board[y][x] = opponent_color
        score -= own_shape_score(board, x, y, opponent_color) // 7
        board[y][x] = None
    return score


def eval_candidate_with_lookahead(board, move, my_color, depth):
    x = move["x"]
    y = move["y"]
    opponent_color = opposite(my_color)

    board[y][x] = my_color
    if is_win_after_placing(board, x, y, my_color):
        board[y][x] = None
        return 1_000_000

    base = quick_position_score(board, my_color)

    if depth <= 1:
        board[y][x] = None
        return base

    opponent_moves = collect_frontier_moves(board, radius=2)
    opponent_moves = shortlist_moves(
        board,
        opponent_moves,
        my_color,
        limit=REPLY_CANDIDATES,
    )

    if not opponent_moves:
        board[y][x] = None
        return base

    worst_case = None
    for reply in opponent_moves:
        rx = reply["x"]
        ry = reply["y"]
        if board[ry][rx] is not None:
            continue

        board[ry][rx] = opponent_color
        if is_win_after_placing(board, rx, ry, opponent_color):
            val = -900_000
        else:
            tactical = (
                len(find_immediate_wins(board, my_color, limit=2)) * 9000
                - len(find_immediate_wins(board, opponent_color, limit=2)) * 12000
            )
            val = tactical + quick_position_score(board, my_color)
        board[ry][rx] = None

        if worst_case is None or val < worst_case:
            worst_case = val

    board[y][x] = None
    if worst_case is None:
        return base
    return int(base * 0.35 + worst_case * 0.65)


def best_move_with_lookahead(board, moves, color, depth):
    scored = []
    for move in moves:
        score = eval_candidate_with_lookahead(board, move, color, depth)
        scored.append((score, move))
    return pick_ranked_move(scored)


def find_forcing_threats(board, color, probe_moves, max_found=40):
    threats = set()
    for move in probe_moves:
        x = move["x"]
        y = move["y"]
        if board[y][x] is not None:
            continue

        board[y][x] = color
        if is_win_after_placing(board, x, y, color):
            threats.add((x, y))
        else:
            # Fork threats: opponent creates two immediate wins next turn.
            wins_next = find_immediate_wins(board, color, limit=3)
            if len(wins_next) >= 2:
                threats.add((x, y))
        board[y][x] = None

        if len(threats) >= max_found:
            break

    return threats


def evaluate_opening_position(board, my_color, next_turn_color):
    opponent_color = opposite(my_color)
    score = quick_position_score(board, my_color)

    my_wins = len(find_immediate_wins(board, my_color, limit=4))
    opp_wins = len(find_immediate_wins(board, opponent_color, limit=4))
    score += my_wins * 8000 - opp_wins * 9000

    if next_turn_color == my_color:
        score += my_wins * 5000
        score -= opp_wins * 1500
    elif next_turn_color == opponent_color:
        score -= opp_wins * 12000
        score += my_wins * 1200

    probe = shortlist_moves(
        board,
        collect_frontier_moves(board, radius=2),
        opponent_color,
        limit=40,
    )
    opp_forcing = len(find_forcing_threats(board, opponent_color, probe, max_found=20))
    my_forcing = len(find_forcing_threats(board, my_color, probe, max_found=20))
    score += my_forcing * 1000 - opp_forcing * 1600

    return score


def decide_swap(game, agent_id):
    board = game.get("board")
    if not isinstance(board, list) or len(board) != BOARD_SIZE:
        return False, {"keep": 0, "swap": 0, "diff": 0}

    my_color = get_color_for_agent(game, agent_id)
    if my_color not in ("black", "white"):
        return False, {"keep": 0, "swap": 0, "diff": 0}

    keep_turn = projected_turn_color_after_swap(game, do_swap=False)
    swap_turn = projected_turn_color_after_swap(game, do_swap=True)

    keep_score = evaluate_opening_position(board, my_color, keep_turn)
    swap_score = evaluate_opening_position(board, opposite(my_color), swap_turn)
    diff = swap_score - keep_score

    if DETERMINISTIC_MODE:
        return diff > SWAP_MARGIN, {"keep": keep_score, "swap": swap_score, "diff": diff}

    # In near-tie states, allow small stochasticity so mirror games diverge over time.
    tie_band = max(180, SWAP_MARGIN // 2)
    if abs(diff) <= tie_band:
        probability = 0.5 + (diff / float(2 * tie_band))
        probability = max(0.12, min(0.88, probability))
        return RNG.random() < probability, {"keep": keep_score, "swap": swap_score, "diff": diff}

    return diff > SWAP_MARGIN, {"keep": keep_score, "swap": swap_score, "diff": diff}


def decide_offer10_proposal(game, agent_id):
    if not OFFER10_ENABLED:
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0}

    opening_state = game.get("opening_state") or {}
    if not opening_state.get("awaiting_offer10"):
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0}

    tentative_black = opening_state.get("tentative_black_agent_id")
    if not tentative_black or tentative_black != agent_id:
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0}

    board = game.get("board")
    legal = game.get("legal_moves") or []
    if not isinstance(board, list) or len(board) != BOARD_SIZE or not legal:
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0}

    my_color = get_color_for_agent(game, agent_id)
    if my_color not in ("black", "white"):
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0}

    # The server transitions to midgame with "white" to move after offer10 selection.
    # This only stays consistent if the selected move 5 is black, which implies the
    # tentative black agent is currently black when proposing offer10.
    if my_color != "black":
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0, "note": "not_current_black"}

    next_turn_color = "white"

    normal_scored = []
    offer_scored = []
    for m in legal:
        x = m.get("x")
        y = m.get("y")
        if not isinstance(x, int) or not isinstance(y, int):
            continue
        if not in_bounds(x, y):
            continue
        if board[y][x] is not None:
            continue

        simulated = [row[:] for row in board]
        simulated[y][x] = my_color

        keep_score = evaluate_opening_position(simulated, my_color, next_turn_color)
        keep_p = score_to_win_prob(keep_score)

        swap_score = evaluate_opening_position(simulated, opposite(my_color), next_turn_color)
        swap_p = score_to_win_prob(swap_score)

        # After a normal move 5, the opponent gets a final swap decision.
        normal_val = min(keep_p, swap_p)
        normal_scored.append((normal_val, m))
        offer_scored.append((keep_p, m))

    if not normal_scored:
        return False, [], {"normal": 0.0, "offer": 0.0, "diff": 0.0}

    normal_scored.sort(key=lambda it: (-it[0], stable_move_key(it[1])))
    best_normal_val = float(normal_scored[0][0])

    # Build 10 candidates from distinct symmetry classes to maximize the worst-case.
    best_by_sym = {}
    for p, m in offer_scored:
        x = int(m["x"])
        y = int(m["y"])
        key = symmetry_key(x, y)
        prev = best_by_sym.get(key)
        if prev is None or p > prev[0] or (p == prev[0] and stable_move_key(m) < stable_move_key(prev[1])):
            best_by_sym[key] = (p, m)

    unique = list(best_by_sym.values())
    unique.sort(key=lambda it: (-it[0], stable_move_key(it[1])))
    chosen = unique[:10]
    if len(chosen) < 10:
        return False, [], {"normal": best_normal_val, "offer": 0.0, "diff": -1.0, "note": "insufficient_symmetry"}

    offer_floor = float(min(p for p, _ in chosen))
    diff = offer_floor - best_normal_val
    min_improvement = max(0.0, float(OFFER10_MIN_IMPROVEMENT))
    do_offer = offer_floor >= best_normal_val + min_improvement

    candidates = [{"x": int(m["x"]), "y": int(m["y"])} for _, m in chosen]
    detail = {
        "normal": round(best_normal_val, 4),
        "offer": round(offer_floor, 4),
        "diff": round(diff, 4),
        "min_improvement": round(min_improvement, 4),
    }
    return do_offer, candidates, detail


def choose_offer10_candidate(game, agent_id):
    candidates = game.get("offer10_candidates") or []
    if not candidates:
        return None

    board = game.get("board")
    if not isinstance(board, list) or len(board) != BOARD_SIZE:
        return pick_stable_move(candidates)

    opening_state = game.get("opening_state") or {}
    tentative_black = opening_state.get("tentative_black_agent_id")
    move_color = get_color_for_agent(game, tentative_black)
    if move_color not in ("black", "white"):
        return pick_stable_move(candidates)

    my_color = get_color_for_agent(game, agent_id)
    if my_color not in ("black", "white"):
        return pick_stable_move(candidates)
    opponent_color = opposite(my_color)
    next_turn_color = "white"

    scored = []
    for candidate in candidates:
        x = candidate["x"]
        y = candidate["y"]
        if not in_bounds(x, y):
            continue
        if board[y][x] is not None:
            continue

        simulated = [row[:] for row in board]
        simulated[y][x] = move_color

        score = evaluate_opening_position(simulated, my_color, next_turn_color)
        my_wins = len(find_immediate_wins(simulated, my_color, limit=4))
        opp_wins = len(find_immediate_wins(simulated, opponent_color, limit=4))
        score += my_wins * 7000 - opp_wins * 11000

        if next_turn_color == opponent_color and opp_wins > 0:
            score -= 32000 + opp_wins * 7000
        if next_turn_color == my_color and my_wins > 0:
            score += 28000 + my_wins * 6000

        scored.append((score, candidate))

    return pick_ranked_move(scored) or pick_stable_move(candidates)


def choose_move(game):
    legal = game.get("legal_moves") or []
    if not legal:
        return None

    board = game.get("board")
    color = game.get("turn_color")
    if (
        color not in ("black", "white")
        or not isinstance(board, list)
        or len(board) != BOARD_SIZE
    ):
        return pick_stable_move(legal)

    opponent_color = opposite(color)

    # 1) Win immediately when possible.
    immediate_wins = [m for m in legal if is_winning_move(board, m["x"], m["y"], color)]
    if immediate_wins:
        return best_scored_move(board, immediate_wins, color)

    # 2) Block opponent's immediate wins if they exist.
    opponent_wins_now = set(find_immediate_wins(board, opponent_color, limit=40))
    if opponent_wins_now:
        blockers = [m for m in legal if (m["x"], m["y"]) in opponent_wins_now]
        if blockers:
            return best_scored_move(board, blockers, color)

    # 3) Block opponent forcing forks (two immediate wins next).
    probe = collect_frontier_moves(board, radius=2)
    probe = shortlist_moves(board, probe, opponent_color, limit=90)
    forcing = find_forcing_threats(board, opponent_color, probe, max_found=50)
    if forcing:
        blockers = [m for m in legal if (m["x"], m["y"]) in forcing]
        if blockers:
            return best_scored_move(board, blockers, color)

    # 4) Look ahead and pick robust moves (attack + defense).
    move_number = int(game.get("move_number", 0))
    pool = legal
    if move_number <= EARLY_LOCALITY_UNTIL:
        local_set = {(m["x"], m["y"]) for m in collect_frontier_moves(board, radius=2)}
        local_pool = [m for m in legal if (m["x"], m["y"]) in local_set]
        if local_pool:
            pool = local_pool

    dynamic_root = ROOT_CANDIDATES
    if move_number <= EARLY_LOCALITY_UNTIL:
        dynamic_root += 4

    candidates = shortlist_moves(board, pool, opponent_color, limit=dynamic_root)
    best = best_move_with_lookahead(board, candidates, color, LOOKAHEAD_DEPTH)
    if best:
        return best

    # 5) Fallback to one-ply tactical score.
    best = best_scored_move(board, candidates, color)
    if best:
        return best
    return pick_stable_move(legal)


def run_game_loop(token, game, agent_id):
    game_id = game["id"]
    color_hint = game.get("color")
    since_move = -1
    since_updated_at = ""
    since_revision = ""

    while True:
        wait_status, waited = wait_game(game_id, since_move, since_updated_at, since_revision)
        if wait_status == 404:
            print(f"[game:{game_id}] no longer exists; leaving game loop")
            return
        if wait_status in (401, 403):
            print(f"[game:{game_id}] wait unauthorized ({wait_status}); leaving game loop")
            return
        if wait_status != 200 or not waited:
            time.sleep(1)
            continue

        partial = waited.get("game") or {}
        since_move = int(partial.get("move_number", since_move))
        since_updated_at = str(partial.get("updated_at", since_updated_at))
        since_revision = str(waited.get("revision", since_revision))

        game_status, full = get_game(game_id)
        if game_status == 404:
            print(f"[game:{game_id}] state unavailable (404); leaving game loop")
            return
        if game_status in (401, 403):
            print(f"[game:{game_id}] game fetch unauthorized ({game_status}); leaving game loop")
            return
        if game_status != 200 or not full:
            time.sleep(1)
            continue

        if not agent_id and color_hint in ("black", "white"):
            if color_hint == "black":
                inferred = full.get("black_agent_id")
            else:
                inferred = full.get("white_agent_id")
            if inferred:
                agent_id = inferred
                print(f"[game:{game_id}] inferred agent_id={agent_id}")

        if full.get("status") == "finished":
            print(f"[game:{game_id}] finished winner={full.get('winner_color')} reason={full.get('result_reason')}")
            return

        opening_state = full.get("opening_state") or {}
        if opening_state.get("awaiting_swap"):
            decider_id = get_swap_decider_agent_id(full)
            if decider_id and agent_id and decider_id != agent_id:
                continue

            do_swap, detail = decide_swap(full, agent_id)
            code, resp = post_swap(token, game_id, do_swap=do_swap)
            if code == 200:
                action = "swap" if do_swap else "no-swap"
                print(
                    f"[game:{game_id}] swap decision: {action}"
                    f" keep={detail['keep']} swap={detail['swap']} diff={detail['diff']}"
                )
            elif code in (403, 409):
                # Refresh immediately on stale/not-your-turn responses.
                since_move = -1
                since_updated_at = ""
                since_revision = ""
            elif code != 0:
                print(f"[game:{game_id}] swap failed: {code} {resp}")
            continue

        if opening_state.get("awaiting_offer10_selection"):
            selector_id = opening_state.get("tentative_white_agent_id")
            if selector_id and agent_id and selector_id != agent_id:
                continue

            chosen = choose_offer10_candidate(full, agent_id)
            if chosen:
                code, resp = post_offer10_select(token, game_id, chosen["x"], chosen["y"])
                if code == 200:
                    print(f"[game:{game_id}] offer10 selected ({chosen['x']},{chosen['y']})")
                elif code in (403, 409):
                    since_move = -1
                    since_updated_at = ""
                    since_revision = ""
                elif code != 0:
                    print(f"[game:{game_id}] offer10 select failed: {code} {resp}")
            continue

        if full.get("legal_moves"):
            expected_mover_id = get_expected_mover_agent_id(full)
            if expected_mover_id and agent_id and expected_mover_id != agent_id:
                continue
            if not agent_id:
                # Avoid blind submissions when agent identity cannot be resolved.
                time.sleep(0.1)
                continue

            if opening_state.get("awaiting_offer10"):
                proposer_id = opening_state.get("tentative_black_agent_id")
                if proposer_id and proposer_id == agent_id:
                    do_offer10, candidates, detail = decide_offer10_proposal(full, agent_id)
                    if do_offer10 and candidates:
                        code, resp = post_offer10(token, game_id, candidates)
                        if code == 200:
                            print(
                                f"[game:{game_id}] offer10 proposed"
                                f" normal={detail.get('normal')} offer={detail.get('offer')}"
                                f" diff={detail.get('diff')}"
                            )
                        elif code in (400, 403, 409):
                            since_move = -1
                            since_updated_at = ""
                            since_revision = ""
                        elif code != 0:
                            print(f"[game:{game_id}] offer10 propose failed: {code} {resp}")
                        continue

            move = choose_move(full)
            if move:
                turn_number = int(full.get("move_number", 0)) + 1
                idem = f"{game_id}:{turn_number}:{move['x']}:{move['y']}"
                code, resp = post_move(
                    token,
                    game_id,
                    move["x"],
                    move["y"],
                    turn_number,
                    idem,
                )
                if code == 200:
                    print(f"[game:{game_id}] move {turn_number}: ({move['x']},{move['y']})")
                elif code in (400, 403, 409):
                    since_move = -1
                    since_updated_at = ""
                    since_revision = ""
                    time.sleep(0.05)
                elif code != 0:
                    print(f"[game:{game_id}] move failed: {code} {resp}")
            continue


def main():
    saved_token, saved_agent_id = load_saved_credentials()
    token = AGENT_API_KEY or saved_token
    agent_id = str(os.getenv("AGENT_ID", "")).strip() or saved_agent_id
    if not token:
        try:
            token, agent_id = register_agent(AGENT_NAME)
        except RuntimeError as e:
            print(f"{e}")
            print("name may already exist. choose another AGENT_NAME.")
            return
        save_token(token, agent_id)
        print(f"registered agent={agent_id} api_key={token}")
    elif not agent_id:
        me_status, me_data = get_me(token)
        if me_status == 200 and me_data.get("id"):
            agent_id = str(me_data.get("id"))
            save_token(token, agent_id)

    agent_revision = ""
    while True:
        wait_status, wait_data = wait_agent_state(token, agent_revision)

        if wait_status == 401:
            try:
                token, agent_id = register_agent(AGENT_NAME)
            except RuntimeError as e:
                print(f"{e}")
                print("stored key invalid and name is not reusable. set another AGENT_NAME.")
                return
            save_token(token, agent_id)
            print(f"token refreshed via re-register agent={agent_id}")
            agent_revision = ""
            time.sleep(0.5)
            continue

        # Backward compatibility: older servers may not provide /agents/wait yet.
        if wait_status == 404:
            status, active, raw = get_active_game(token)
            if status == 401:
                try:
                    token, agent_id = register_agent(AGENT_NAME)
                except RuntimeError as e:
                    print(f"{e}")
                    print("stored key invalid and name is not reusable. set another AGENT_NAME.")
                    return
                save_token(token, agent_id)
                print(f"token refreshed via re-register agent={agent_id}")
                agent_revision = ""
                continue
            if status != 200:
                print(f"active-game failed: {status} {raw}")
                time.sleep(IDLE_SLEEP)
                continue
            if not active:
                status, data = join_queue(token)
                if status not in (200, 409):
                    print(f"queue join failed: {status} {data}")
                time.sleep(IDLE_SLEEP)
                continue
            print(f"active game={active['id']} color={active.get('color')} phase={active.get('phase')}")
            run_game_loop(token, active, agent_id)
            if EXIT_AFTER_GAME:
                return
            continue

        if wait_status != 200:
            print(f"agents-wait failed: {wait_status} {wait_data}")
            time.sleep(IDLE_SLEEP)
            continue

        agent_revision = str(wait_data.get("revision", agent_revision))
        active = wait_data.get("game")
        in_queue = bool(wait_data.get("in_queue"))

        if not active:
            if not in_queue:
                status, data = join_queue(token)
                if status not in (200, 409):
                    print(f"queue join failed: {status} {data}")
                elif status == 200 and data.get("game_id"):
                    print(f"matched quickly game={data.get('game_id')}")
                # queue state will be picked up by /agents/wait revision on next loop
                time.sleep(0.2)
            continue

        print(f"active game={active['id']} color={active.get('color')} phase={active.get('phase')}")
        run_game_loop(token, active, agent_id)
        if EXIT_AFTER_GAME:
            return
        agent_revision = ""


if __name__ == "__main__":
    main()
