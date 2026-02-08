"use client";

import { useEffect, useState } from "react";
import { apiBaseUrl } from "../../lib/api";
import { formatResultReasonKr } from "../../lib/labels";

type Agent = {
  id: string;
  name: string;
  api_key_prefix: string;
  is_active: boolean;
  created_at: string;
};

type Game = {
  id: string;
  status: string;
  black_agent_id: string | null;
  white_agent_id: string | null;
  winner_color: string | null;
  result_reason: string | null;
  created_at: string;
};

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  const loadAgents = async () => {
    const res = await fetch(`${apiBaseUrl}/agents`);
    const json = await res.json();
    setAgents(json.agents ?? []);
  };

  const loadGames = async (agentIds: string[]) => {
    const res = await fetch(`${apiBaseUrl}/games?limit=10`);
    const json = await res.json();
    const all = json.games ?? [];
    if (agentIds.length === 0) {
      setGames([]);
      return;
    }
    const filtered = all.filter(
      (g: Game) => agentIds.includes(g.black_agent_id ?? "") || agentIds.includes(g.white_agent_id ?? "")
    );
    setGames(filtered);
  };

  const refresh = async () => {
    await loadAgents();
  };

  useEffect(() => {
    const init = async () => {
      await refresh();
    };
    init();
  }, []);

  useEffect(() => {
    const ids = agents.map((a) => a.id);
    loadGames(ids);
  }, [agents]);

  const createAgent = async () => {
    setStatus(null);
    setNewKey(null);
    if (!agentName.trim()) {
      setStatus("Agent name required");
      return;
    }
    const res = await fetch(`${apiBaseUrl}/agents/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: agentName.trim() })
    });
    const json = await res.json();
    if (!res.ok) {
      setStatus(json.error ?? "Failed to create agent");
      return;
    }
    setNewKey(json.api_key);
    setAgentName("");
    await refresh();
  };

  return (
    <div className="grid">
      <div className="card">
        <h2>에이전트</h2>
        <div className="form">
          <label className="label">새 에이전트</label>
          <input
            className="input"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder="에이전트 이름"
          />
          <button className="btn" onClick={createAgent}>에이전트 생성</button>
          {status && <p style={{ color: "var(--muted)" }}>{status}</p>}
          {newKey && (
            <div className="card" style={{ marginTop: 12 }}>
              <p style={{ marginTop: 0 }}>API 키 (안전하게 보관):</p>
              <code>{newKey}</code>
            </div>
          )}
        </div>
        <div style={{ marginTop: 16 }}>
          {agents.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>등록된 에이전트가 없습니다.</p>
          ) : (
            agents.map((agent) => (
              <div key={agent.id} style={{ marginBottom: 8 }}>
                <strong>{agent.name}</strong> · {agent.api_key_prefix} ·{" "}
                {agent.is_active ? "활성" : "비활성"}
              </div>
            ))
          )}
        </div>
      </div>
      <div className="card">
        <h2>최근 게임</h2>
        {games.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>아직 게임이 없습니다.</p>
        ) : (
          games.map((game) => (
            <div key={game.id} style={{ marginBottom: 10 }}>
              <div>
                <a href={`/games/${game.id}`}>{game.id}</a>
              </div>
              <div style={{ color: "var(--muted)" }}>
                {game.status} · {game.winner_color ?? "진행 중"} ·{" "}
                {formatResultReasonKr(game.result_reason) ?? "-"}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="card">
        <h2>API 키</h2>
        <p>에이전트에서 Authorization: Bearer &lt;key&gt; 로 사용하세요.</p>
      </div>
    </div>
  );
}
