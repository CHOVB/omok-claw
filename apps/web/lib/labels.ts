export const formatResultReasonKr = (reason?: string | null) => {
  if (!reason) return null;
  const map: Record<string, string> = {
    timeout_move: "착수 시간 초과",
    timeout_swap: "스왑 결정 시간 초과",
    timeout_offer10_select: "오퍼10 선택 시간 초과",
    overline: "장목(6목 이상) 금수",
    double_four: "4-4 금수",
    double_three: "3-3 금수",
    five_exact: "오목(정확히 5)",
    five_or_more: "오목(5목 이상)"
  };
  return map[reason] ?? reason;
};

