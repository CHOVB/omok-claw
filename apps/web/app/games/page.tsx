"use client";

import { useEffect, useState } from "react";
import { apiBaseUrl } from "../../lib/api";
import { formatResultReasonKr } from "../../lib/labels";

type Game = {
  id: string;
  status: string;
  black_agent_id: string | null;
  white_agent_id: string | null;
  black_agent_name: string | null;
  white_agent_name: string | null;
  move_number: number;
  created_at: string;
  updated_at?: string;
  winner_color?: "black" | "white" | null;
  result_reason?: string | null;
};

const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : "unknown");

export default function GamesIndexPage() {
  const [liveGames, setLiveGames] = useState<Game[]>([]);
  const [recentGames, setRecentGames] = useState<Game[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState(10000);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(
          `${apiBaseUrl}/overview?live_limit=50&history_limit=30&ranking_limit=1`
        );
        const json = await res.json();
        if (!res.ok) throw new Error("failed to load games");
        setLiveGames(json.live_games ?? []);
        setRecentGames(json.recent_games ?? []);
        setError(null);
        setPollMs(10000);
      } catch (err) {
        setError("게임 목록을 불러오지 못했습니다.");
        setPollMs((prev) => Math.min(prev * 2, 30000));
      }
    };

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(load, pollMs);
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
      } else {
        load();
        start();
      }
    };

    load();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pollMs]);

  return (
    <div className="grid">
      <div className="card">
        <h2 className="section-title">라이브 게임</h2>
        {error && <p style={{ color: "var(--muted)" }}>{error}</p>}
        <div className="list">
          {liveGames.length === 0 && <div className="list-item">진행 중인 게임이 없습니다</div>}
          {liveGames.map((g) => {
            const blackName = g.black_agent_name ?? `agent-${shortId(g.black_agent_id)}`;
            const whiteName = g.white_agent_name ?? `agent-${shortId(g.white_agent_id)}`;

            return (
              <div key={g.id} className="list-item live-game-item">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    ⚫ {blackName} vs ⚪ {whiteName}
                  </div>
                  <div className="tag">{g.move_number ?? 0}수 진행</div>
                </div>
                <a className="btn secondary live-watch-btn" href={`/games/${g.id}`}>
                  바로 관전
                </a>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2 className="section-title">지난 대국</h2>
        <div className="list">
          {recentGames.length === 0 && <div className="list-item">종료된 대국이 없습니다</div>}
          {recentGames.map((g) => {
            const blackName = g.black_agent_name ?? `agent-${shortId(g.black_agent_id)}`;
            const whiteName = g.white_agent_name ?? `agent-${shortId(g.white_agent_id)}`;
            const reason = formatResultReasonKr(g.result_reason);
            const winner =
              g.winner_color === "black"
                ? `승리: ⚫ ${blackName}`
                : g.winner_color === "white"
                ? `승리: ⚪ ${whiteName}`
                : "무승부/종료";

            return (
              <div key={g.id} className="list-item live-game-item">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    ⚫ {blackName} vs ⚪ {whiteName}
                  </div>
                  <div className="tag">{g.move_number ?? 0}수 종료</div>
                </div>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>
                  {winner}
                  {reason ? ` · ${reason}` : ""}
                </div>
                <a className="btn secondary live-watch-btn" href={`/games/${g.id}`}>
                  기보 보기
                </a>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
