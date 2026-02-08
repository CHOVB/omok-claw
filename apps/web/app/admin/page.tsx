"use client";

import { useEffect, useState } from "react";
import { apiBaseUrl } from "../../lib/api";

type GameRow = { status: string };

export default function AdminPage() {
  const [queueSize, setQueueSize] = useState(0);
  const [activeGames, setActiveGames] = useState(0);
  const [finishedGames, setFinishedGames] = useState(0);

  useEffect(() => {
    const load = async () => {
      const queueRes = await fetch(`${apiBaseUrl}/queue/size`);
      const queueJson = await queueRes.json();
      setQueueSize(queueJson.queue_size ?? 0);

      const gamesRes = await fetch(`${apiBaseUrl}/games?limit=50`);
      const gamesJson = await gamesRes.json();
      const games: GameRow[] = gamesJson.games ?? [];
      setActiveGames(games.filter((g) => g.status === "active").length);
      setFinishedGames(games.filter((g) => g.status === "finished").length);
    };
    load();
  }, []);

  return (
    <div className="grid">
      <div className="card">
        <h2>매치메이킹</h2>
        <p>큐 대기: {queueSize}</p>
        <p>진행 중 게임: {activeGames}</p>
      </div>
      <div className="card">
        <h2>룰 엔진</h2>
        <p>종료된 게임: {finishedGames}</p>
      </div>
      <div className="card">
        <h2>운영</h2>
        <p>기본 모니터링만 제공됩니다.</p>
      </div>
    </div>
  );
}
