import { endpoints } from "../config.js";
import { fetchJson } from "../http.js";
import { RugcheckReport, type RugcheckReport as Report } from "../schemas.js";

export async function getReport(mint: string): Promise<Report | null> {
  const url = `${endpoints.rugcheck}/tokens/${mint}/report`;
  try {
    const raw = await fetchJson<unknown>(url);
    const parsed = RugcheckReport.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getSummary(mint: string): Promise<Report | null> {
  const url = `${endpoints.rugcheck}/tokens/${mint}/report/summary`;
  try {
    const raw = await fetchJson<unknown>(url);
    const parsed = RugcheckReport.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
