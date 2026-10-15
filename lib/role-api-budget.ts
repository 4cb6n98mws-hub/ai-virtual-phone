import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const ROLE_API_BUDGET_KEY = "ai_phone_role_api_budget_v1";

type RoleApiBudgetState = {
  dailyRuns: Record<string, string>;
};

registerKvMigration(ROLE_API_BUDGET_KEY);

function localDayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadState(): RoleApiBudgetState {
  try {
    const parsed = JSON.parse(kvGet(ROLE_API_BUDGET_KEY) || "{}") as Partial<RoleApiBudgetState>;
    return {
      dailyRuns: parsed.dailyRuns && typeof parsed.dailyRuns === "object" ? parsed.dailyRuns : {},
    };
  } catch {
    return { dailyRuns: {} };
  }
}

function makeDailyKey(feature: string, subjectId: string): string {
  return `${feature.trim()}:${subjectId.trim()}`;
}

export function hasRoleApiRunToday(feature: string, subjectId: string): boolean {
  if (!feature.trim() || !subjectId.trim()) return false;
  const state = loadState();
  return state.dailyRuns[makeDailyKey(feature, subjectId)] === localDayKey();
}

export function markRoleApiRunToday(feature: string, subjectId: string): void {
  if (!feature.trim() || !subjectId.trim()) return;
  const state = loadState();
  const today = localDayKey();
  const dailyRuns = Object.fromEntries(
    Object.entries(state.dailyRuns).filter(([, day]) => day >= today),
  );
  dailyRuns[makeDailyKey(feature, subjectId)] = today;
  kvSet(ROLE_API_BUDGET_KEY, JSON.stringify({ dailyRuns } satisfies RoleApiBudgetState));
}
