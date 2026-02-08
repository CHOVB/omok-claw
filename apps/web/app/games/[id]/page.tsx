"use client";

import { useEffect, useMemo, useState } from "react";
import { apiBaseUrl } from "../../../lib/api";
import { formatResultReasonKr } from "../../../lib/labels";

type SwapHistory = {
  move_number: number;
  decider_agent_id: string;
  swapped: boolean;
  at: string;
};

type LastMove = {
  x: number;
  y: number;
  color: "black" | "white";
  move_number: number;
};

type Move = {
  x: number;
  y: number;
  color: "black" | "white";
  move_number: number;
};

type GameState = {
  id: string;
  status: "active" | "finished";
  board: Array<Array<"black" | "white" | null>>;
  moves?: Move[];
  updated_at?: string;
  phase: string;
  turn_color: "black" | "white";
  move_number: number;
  winner_color: "black" | "white" | null;
  result_reason: string | null;
  turn_deadline_at: string | null;
  black_agent_id: string | null;
  white_agent_id: string | null;
  black_agent_name: string | null;
  white_agent_name: string | null;
  last_move: LastMove | null;
  opening_state?: {
    tentative_black_agent_id?: string | null;
    tentative_white_agent_id?: string | null;
    awaiting_swap?: boolean;
    awaiting_offer10_selection?: boolean;
    swap_after_move?: number | null;
    swap_history?: SwapHistory[];
  };
};

const letters = "ABCDEFGHIJKLMNO".split("");
const starPoints = new Set(["3,3", "3,11", "11,3", "11,11", "7,7"]);
const GRID = 28;
const OFFSET = 14;

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "unknown");

const pointLabel = (x: number, y: number) => `${letters[x] ?? "?"}${15 - y}`;
const formatClock = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
};

export default function GamePage({ params }: { params: { id: string } }) {
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fetchState = async (): Promise<{ game: GameState | null; terminal: boolean }> => {
    try {
      const res = await fetch(`${apiBaseUrl}/games/${params.id}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "게임 정보를 불러오지 못했습니다.");
        return { game: null, terminal: res.status === 404 || res.status === 410 };
      }
      setState(json);
      setError(null);
      return { game: json as GameState, terminal: false };
    } catch (err) {
      setError("네트워크 오류");
      return { game: null, terminal: false };
    }
  };

  useEffect(() => {
    let cancelled = false;
    let waitAbort: AbortController | null = null;

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const pollLoop = async () => {
      let sinceMove = -1;
      let sinceUpdatedAt = "";
      let sinceRevision = "";

      const initial = await fetchState();
      if (initial.terminal) {
        setError("게임을 찾을 수 없어 실시간 동기화를 중단했습니다.");
        return;
      }
      if (initial.game) {
        sinceMove = initial.game.move_number;
        sinceUpdatedAt = String(initial.game.updated_at ?? "");
      }

      while (!cancelled) {
        if (document.hidden) {
          await sleep(1500);
          continue;
        }

        try {
          const qs = new URLSearchParams({
            since_move: String(sinceMove),
            timeout_sec: "25"
          });
          if (sinceUpdatedAt) qs.set("since_updated_at", sinceUpdatedAt);
          if (sinceRevision) qs.set("since_revision", sinceRevision);

          waitAbort = new AbortController();
          const waitRes = await fetch(`${apiBaseUrl}/games/${params.id}/wait?${qs.toString()}`, {
            signal: waitAbort.signal
          });
          let waitJson: any = null;
          try {
            waitJson = await waitRes.json();
          } catch {
            waitJson = null;
          }
          if (!waitRes.ok) {
            if (waitRes.status === 404 || waitRes.status === 410) {
              setError("게임이 종료되었거나 삭제되어 실시간 동기화를 중단했습니다.");
              return;
            }
            throw new Error(waitJson?.error ?? "wait failed");
          }

          if (waitJson?.changed) {
            const latest = await fetchState();
            if (latest.terminal) {
              setError("게임을 찾을 수 없어 실시간 동기화를 중단했습니다.");
              return;
            }
            if (latest.game) {
              sinceMove = latest.game.move_number;
              sinceUpdatedAt = String(latest.game.updated_at ?? "");
            }
          } else if (waitJson?.game) {
            sinceMove = Number(waitJson.game.move_number ?? sinceMove);
            sinceUpdatedAt = String(waitJson.game.updated_at ?? sinceUpdatedAt);
          }
          if (waitJson?.revision) {
            sinceRevision = String(waitJson.revision);
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof DOMException && err.name === "AbortError") {
            continue;
          }
          setError("실시간 동기화가 지연되고 있습니다. 자동 재연결 중...");
          await sleep(2500);
        } finally {
          waitAbort = null;
        }
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (waitAbort) waitAbort.abort();
        return;
      }
      fetchState();
    };

    pollLoop();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (waitAbort) waitAbort.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [params.id]);

  useEffect(() => {
    if (!state?.turn_deadline_at || state.status !== "active") return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state?.turn_deadline_at, state?.status]);

  const stones = useMemo(() => {
    if (state?.moves && state.moves.length > 0) {
      return state.moves.map((move) => ({
        x: move.x,
        y: move.y,
        value: move.color,
        moveNumber: move.move_number
      }));
    }
    if (!state?.board) return [];
    const items: Array<{ x: number; y: number; value: "black" | "white"; moveNumber?: number }> = [];
    for (let y = 0; y < 15; y += 1) {
      for (let x = 0; x < 15; x += 1) {
        const v = state.board[y]?.[x];
        if (v) items.push({ x, y, value: v });
      }
    }
    return items;
  }, [state]);

  const blackName = state?.black_agent_name ?? `agent-${shortId(state?.black_agent_id)}`;
  const whiteName = state?.white_agent_name ?? `agent-${shortId(state?.white_agent_id)}`;
  const reasonLabel = formatResultReasonKr(state?.result_reason);

  const agentNameForId = (agentId: string | null | undefined) => {
    if (!agentId) return "unknown";
    if (agentId === state?.black_agent_id) return blackName;
    if (agentId === state?.white_agent_id) return whiteName;
    if (agentId.startsWith("system:")) return "시스템";
    return `agent-${shortId(agentId)}`;
  };

  const turnText =
    state?.status === "finished"
      ? state.winner_color
        ? `대국 종료 · 승자: ${state.winner_color === "black" ? `⚫ ${blackName}` : `⚪ ${whiteName}`}`
        : "대국 종료"
      : state?.turn_color === "black"
      ? `현재 차례: ⚫ ${blackName}`
      : `현재 차례: ⚪ ${whiteName}`;

  const swapHistory = state?.opening_state?.swap_history ?? [];
  const swapTimeline = useMemo(() => {
    const opening = state?.opening_state;
    const history = (opening?.swap_history ?? [])
      .slice()
      .sort(
        (a, b) =>
          (a.move_number ?? 0) - (b.move_number ?? 0) || String(a.at).localeCompare(String(b.at))
      );

    const finalBlackId = state?.black_agent_id ?? null;
    const finalWhiteId = state?.white_agent_id ?? null;
    const tentativeBlackId = opening?.tentative_black_agent_id ?? null;
    const tentativeWhiteId = opening?.tentative_white_agent_id ?? null;

    let initialBlackId: string | null = tentativeBlackId;
    let initialWhiteId: string | null = tentativeWhiteId;

    if (!initialBlackId || !initialWhiteId) {
      const swapCount = history.reduce((acc, h) => acc + (h.swapped ? 1 : 0), 0);
      if (finalBlackId && finalWhiteId) {
        if (swapCount % 2 === 0) {
          initialBlackId = finalBlackId;
          initialWhiteId = finalWhiteId;
        } else {
          initialBlackId = finalWhiteId;
          initialWhiteId = finalBlackId;
        }
      } else {
        initialBlackId = finalBlackId;
        initialWhiteId = finalWhiteId;
      }
    }

    let blackId = initialBlackId;
    let whiteId = initialWhiteId;
    const events = history.map((h) => {
      const before_black_id = blackId;
      const before_white_id = whiteId;
      let after_black_id = blackId;
      let after_white_id = whiteId;
      if (h.swapped) {
        after_black_id = before_white_id;
        after_white_id = before_black_id;
      }
      blackId = after_black_id;
      whiteId = after_white_id;
      return { ...h, before_black_id, before_white_id, after_black_id, after_white_id };
    });

    return { initialBlackId, initialWhiteId, events };
  }, [state?.black_agent_id, state?.white_agent_id, state?.opening_state]);
  const deadlineMs = state?.turn_deadline_at ? Date.parse(state.turn_deadline_at) : Number.NaN;
  const timeLeftMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - nowMs) : null;
  const timerText = timeLeftMs === null ? "--:--" : formatClock(timeLeftMs);
  const timerClass =
    timeLeftMs !== null && timeLeftMs <= 30_000
      ? "timer-panel timer-urgent"
      : timeLeftMs !== null && timeLeftMs <= 60_000
      ? "timer-panel timer-warning"
      : "timer-panel";
  const activeColor = state?.status === "active" ? state.turn_color : null;
  const activeLabel =
    activeColor === "black"
      ? `⚫ ${blackName}`
      : activeColor === "white"
      ? `⚪ ${whiteName}`
      : "대국 종료";
  const winnerLabel =
    state?.winner_color === "black"
      ? `⚫ ${blackName}`
      : state?.winner_color === "white"
      ? `⚪ ${whiteName}`
      : null;
  const resultBannerClass =
    state?.winner_color === "black"
      ? "result-banner result-banner-black"
      : state?.winner_color === "white"
      ? "result-banner result-banner-white"
      : "result-banner";

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="game-head-grid">
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 10 }}>
              ⚫ {blackName} vs ⚪ {whiteName}
            </h2>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span className="tag">게임 ID: {params.id.slice(0, 8)}</span>
              <span className="turn-pill">단계 {state?.phase ?? "-"}</span>
              <span className="turn-pill">{state?.move_number ?? 0}수</span>
              {reasonLabel && <span className="tag">사유: {reasonLabel}</span>}
              {state?.last_move && (
                <span className="tag">최근 착수: {pointLabel(state.last_move.x, state.last_move.y)}</span>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <span className={`turn-pill ${state?.turn_color === "black" ? "turn-black" : "turn-white"}`}>
                {turnText ?? "-"}
              </span>
            </div>
          </div>

          <div className={timerClass}>
            <div className="timer-label">남은 시간</div>
            <div className="timer-value">{timerText}</div>
            <div className="timer-meta">현재 행동 대상: {activeLabel}</div>
          </div>
        </div>

        <div className="player-panels">
          <div className={`player-panel player-panel-black ${activeColor === "black" ? "player-panel-active" : ""}`}>
            <div className="player-panel-head">
              <span>⚫ 흑</span>
              {activeColor === "black" ? <span className="player-turn-badge">현재 턴</span> : null}
            </div>
            <div className="player-panel-name">{blackName}</div>
          </div>
          <div className={`player-panel player-panel-white ${activeColor === "white" ? "player-panel-active" : ""}`}>
            <div className="player-panel-head">
              <span>⚪ 백</span>
              {activeColor === "white" ? <span className="player-turn-badge">현재 턴</span> : null}
            </div>
            <div className="player-panel-name">{whiteName}</div>
          </div>
        </div>

        {state?.status === "finished" && (
          <div className={resultBannerClass}>
            <div className="result-banner-title">
              {winnerLabel ? `🏆 승자: ${winnerLabel}` : "대국 종료"}
            </div>
            <div className="result-banner-sub">
              {reasonLabel ? `종료 사유: ${reasonLabel}` : "승자 없음"}
            </div>
          </div>
        )}

        {error && <p style={{ color: "var(--muted)", marginTop: 10 }}>{error}</p>}
      </div>

      {state?.opening_state && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>오프닝 상태</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span className="turn-pill">스왑 대기: {state.opening_state.awaiting_swap ? "예" : "아니오"}</span>
            <span className="turn-pill">
              오퍼10 선택 대기: {state.opening_state.awaiting_offer10_selection ? "예" : "아니오"}
            </span>
            {state.opening_state.swap_after_move !== null &&
              state.opening_state.swap_after_move !== undefined && (
                <span className="turn-pill">스왑 결정 대상 수: {state.opening_state.swap_after_move}</span>
              )}
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="tag" style={{ marginBottom: 8 }}>
              스왑 기록
            </div>
            {swapTimeline.initialBlackId && swapTimeline.initialWhiteId && (
              <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 10 }}>
                초기 배정: ⚫ {agentNameForId(swapTimeline.initialBlackId)} · ⚪{" "}
                {agentNameForId(swapTimeline.initialWhiteId)}
              </div>
            )}
            {swapHistory.length === 0 ? (
              <div style={{ color: "var(--muted)" }}>기록 없음</div>
            ) : (
              <div className="swap-chips">
                {(swapTimeline.events.length ? swapTimeline.events : swapHistory).map((h: any, idx) => {
                  const deciderName = agentNameForId(h.decider_agent_id);
                  const beforeBlack = agentNameForId(h.before_black_id ?? null);
                  const beforeWhite = agentNameForId(h.before_white_id ?? null);
                  const detail = h.swapped
                    ? `${beforeBlack} ⚫→⚪ · ${beforeWhite} ⚪→⚫`
                    : `유지: ⚫ ${beforeBlack} · ⚪ ${beforeWhite}`;
                  return (
                    <span key={`${h.at}-${idx}`} className="swap-chip">
                      {h.move_number}수 · {h.swapped ? "SWAP" : "NO-SWAP"} · 결정 {deciderName} · {detail}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="board-shell board-shell-glow">
        <div className="board-grid">
          {Array.from({ length: 15 }).map((_, y) =>
            Array.from({ length: 15 }).map((__, x) => {
              const key = `${x},${y}`;
              if (!starPoints.has(key)) return null;
              return (
                <div
                  key={key}
                  className="star"
                  style={{ left: OFFSET + x * GRID, top: OFFSET + y * GRID }}
                />
              );
            })
          )}
          {stones.map((s) => {
            const isLast = state?.last_move?.x === s.x && state?.last_move?.y === s.y;
            return (
              <div
                key={`${s.x}-${s.y}`}
                className={`stone ${s.value === "black" ? "stone-black" : "stone-white"} ${
                  isLast ? "stone-last" : ""
                }`}
                style={{ left: OFFSET + s.x * GRID, top: OFFSET + s.y * GRID }}
              >
                {s.moveNumber ? <span className="stone-number">{s.moveNumber}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="board-x">
          {letters.map((l) => (
            <div key={l} className="axis-label">
              {l}
            </div>
          ))}
        </div>
        <div className="board-y">
          {Array.from({ length: 15 }, (_, i) => 15 - i).map((n) => (
            <div key={n} className="axis-label">
              {n}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
